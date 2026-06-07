// ============================================================
// PESAM 2.0 – Agent "Ilościowiec (Quantity Surveyor)"
// POST /api/kosztorysant/agent-ilosciowiec
//
// ROLA W DAG: Faza 2 – po MAPPING_DETECTIVE, przed SILENT_AUDITOR
// WEJŚCIE:   ScopeManifest z wypełnionymi mappedFileId (wynik Detektywa)
// WYJŚCIE:   quantity + dataQuality na każdym elemencie,
//            statusy COVERED / GAP_FILLED w coverageStatus
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import { adminDb, adminStorage } from '@/lib/firebase/admin';
import { GoogleGenAI, Type } from '@google/genai';
import type {
    ScopeManifest,
    ScopeDivision,
    ScopeElement,
    CoverageEntry,
    CoverageStatus,
    DataQuality,
    QuantityResult,
    AgentPhase,
    ObjectType,
} from '../_shared/scopeManifest.types';

export const dynamic = "force-dynamic";

const MODEL_FLASH = "gemini-2.5-flash";

const VISION_BATCH_SIZE = 5;
const BRAIN_BATCH_SIZE = 15;

// ================================================================
// Typy wewnętrzne
// ================================================================

interface ElementWithContext {
    elementId: string;
    divisionId: string;
    name: string;
    unit: string;
    gapFillerStrategy: string;
    gapFillerHint?: string;
    mappedFileId: string | null;
    mappedStoragePath: string | null;
    extractionHint: string | null;
}

interface BrainContextResponse {
    indicators: Array<{
        elementName: string;
        valuePerM2: number | null;
        valuePerM3: number | null;
        unit: string;
        sampleSize: number;
        confidence: 'HIGH' | 'MEDIUM' | 'LOW';
    }>;
    objectType: ObjectType;
    dataPoints: number;
}

// ================================================================
// Response Schemas dla Gemini
// ================================================================

const VISION_QUANTITY_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        results: {
            type: Type.ARRAY,
            items: {
                type: Type.OBJECT,
                properties: {
                    elementId: { type: Type.STRING },
                    quantity: { type: Type.NUMBER },
                    unit: { type: Type.STRING },
                    method: { type: Type.STRING },
                    confidenceScore: { type: Type.INTEGER },
                    note: { type: Type.STRING },
                    extractionSuccess: { type: Type.BOOLEAN },
                },
                required: ['elementId', 'quantity', 'unit', 'confidenceScore', 'note', 'extractionSuccess'],
            },
        },
    },
    required: ['results'],
};

const BRAIN_QUANTITY_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        results: {
            type: Type.ARRAY,
            items: {
                type: Type.OBJECT,
                properties: {
                    elementId: { type: Type.STRING },
                    quantity: { type: Type.NUMBER },
                    unit: { type: Type.STRING },
                    indicatorUsed: { type: Type.STRING },
                    calculationNote: { type: Type.STRING },
                    confidenceScore: { type: Type.INTEGER },
                },
                required: ['elementId', 'quantity', 'unit', 'indicatorUsed', 'calculationNote', 'confidenceScore'],
            },
        },
    },
    required: ['results'],
};

// ================================================================
// System Prompts
// ================================================================

const VISION_SYSTEM_INSTRUCTION = `
Jesteś Ilościowcem w systemie PESAM – doświadczonym kosztorysantem.
Twoje zadanie to precyzyjne odczytanie ilości geometrycznych z załączonych rysunków/dokumentów na podstawie wskazań "extractionHint".

ZASADY:
1. Dla każdego elementu z listy odczytaj ilość zgodnie z podanym "extractionHint".
2. Jeśli nie możesz odczytać liczby – ustaw extractionSuccess: false i quantity: 0.
3. Podaj wynik w jednostce zgodnej z kosztorysem (m², m³, mb, szt., kpl., kg).

ODPOWIADAJ WYŁĄCZNIE CZYSTYM JSON.
`.trim();

const BRAIN_SYSTEM_INSTRUCTION = `
Jesteś Ilościowcem w systemie PESAM. Szacujesz ilości parametrycznie na podstawie wskaźników historycznych i powierzchni budynku.

ZASADY:
1. Dla każdego elementu zastosuj wskaźnik z dostarczonego kontekstu Brain lub własnej wiedzy inżynierskiej.
2. Podstawa obliczeń to powierzchnia budynku podana w kontekście.
3. Pokazuj obliczenie krok po kroku w "calculationNote".

ODPOWIADAJ WYŁĄCZNIE CZYSTYM JSON.
`.trim();

// ================================================================
// Pobieranie plików i wskaźników z Mózgu (Loopback)
// ================================================================

async function fetchFileAsBase64(storagePath: string): Promise<{ base64: string; mimeType: string } | null> {
    try {
        const bucket = adminStorage.bucket(process.env.STORAGE_BUCKET || "pesam-system-81165.firebasestorage.app");
        const file = bucket.file(storagePath);
        const [exists] = await file.exists();
        if (!exists) return null;
        const [buffer] = await file.download();
        const ext = storagePath.split('.').pop()?.toLowerCase() ?? '';
        const mimeMap: Record<string, string> = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' };
        return { base64: buffer.toString('base64'), mimeType: mimeMap[ext] || 'application/octet-stream' };
    } catch { return null; }
}

async function fetchBrainIndicators(
    req: NextRequest,
    objectType: ObjectType
): Promise<BrainContextResponse | null> {
    try {
        const port = process.env.PORT || "8080";
        const url = `http://127.0.0.1:${port}/api/kosztorysant/brain/context?objectType=${objectType}`;
        console.log(`[Ilościowiec] 🧠 Pobieram kontekst Mózgu lokalnie przez GET: ${url}`);

        const response = await fetch(url, {
            method: 'GET',
            headers: {
                ...(req.headers.get("cookie") ? { "Cookie": req.headers.get("cookie") || "" } : {}),
                ...(req.headers.get("authorization") ? { "Authorization": req.headers.get("authorization") || "" } : {})
            }
        });

        if (!response.ok) return null;
        return await response.json();
    } catch (err) {
        console.warn(`[Ilościowiec] Błąd pobierania Mózgu:`, err);
        return null;
    }
}

// ================================================================
// Wywołania Gemini (Vision oraz Brain)
// ================================================================

async function processVisionBatch(
    ai: any,
    elements: ElementWithContext[],
    fileBase64: string,
    mimeType: string,
    fileName: string
): Promise<QuantityResult[]> {
    const prompt = `
Analizujesz plik: "${fileName}"
Dla każdego elementu z poniższej listy odczytaj DOKŁADNĄ ILOŚĆ z rysunku:
${JSON.stringify(elements.map(el => ({ elementId: el.elementId, name: el.name, unit: el.unit, hint: el.extractionHint })), null, 2)}
    `.trim();

    const result = await ai.models.generateContent({
        model: MODEL_FLASH,
        contents: [{
            role: "user",
            parts: [
                { inlineData: { mimeType, data: fileBase64 } },
                { text: prompt }
            ]
        }],
        config: {
            systemInstruction: VISION_SYSTEM_INSTRUCTION,
            temperature: 0.0,
            responseMimeType: "application/json",
            responseSchema: VISION_QUANTITY_SCHEMA as any,
        },
    });

    const rawText = result.text ?? "{}";
    const parsed = JSON.parse(rawText) as { results: any[] };

    return parsed.results.map((r): QuantityResult => ({
        elementId: r.elementId,
        divisionId: elements.find(el => el.elementId === r.elementId)?.divisionId ?? 'D1',
        quantity: r.quantity,
        unit: r.unit,
        source: 'VISION',
        newStatus: r.extractionSuccess && r.quantity > 0 ? 'COVERED' : 'GAP_FILLED',
        dataQuality: r.confidenceScore >= 70 ? 'NORMATIVE' : 'ESTIMATED',
        note: `[VISION | ${r.method || 'odczyt'}] ${r.note}`,
    }));
}

async function processBrainBatch(
    ai: any,
    elements: ElementWithContext[],
    brainContext: BrainContextResponse | null,
    objectType: ObjectType,
    objectArea_m2: number | null
): Promise<QuantityResult[]> {
    const areaContext = objectArea_m2 ? `Powierzchnia budynku: ${objectArea_m2} m²` : 'Powierzchnia nieznana.';
    const prompt = `
Typ obiektu: ${objectType}
${areaContext}
WSKAŹNIKI MÓZGU: ${JSON.stringify(brainContext?.indicators || [], null, 2)}
ELEMENTY DO OSZACOWANIA: ${JSON.stringify(elements.map(el => ({ elementId: el.elementId, name: el.name, unit: el.unit })), null, 2)}
    `.trim();

    const result = await ai.models.generateContent({
        model: MODEL_FLASH,
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: {
            systemInstruction: BRAIN_SYSTEM_INSTRUCTION,
            temperature: 0.1,
            responseMimeType: "application/json",
            responseSchema: BRAIN_QUANTITY_SCHEMA as any,
        },
    });

    const rawText = result.text ?? "{}";
    const parsed = JSON.parse(rawText) as { results: any[] };

    return parsed.results.map((r): QuantityResult => ({
        elementId: r.elementId,
        divisionId: elements.find(el => el.elementId === r.elementId)?.divisionId ?? 'D1',
        quantity: r.quantity,
        unit: r.unit,
        source: 'BRAIN_INDICATOR',
        newStatus: 'GAP_FILLED',
        dataQuality: 'ESTIMATED',
        note: `[BRAIN | ${r.indicatorUsed}] ${r.calculationNote}`,
    }));
}

// ================================================================
// GŁÓWNY HANDLER POST
// ================================================================

export async function POST(req: NextRequest) {
    const startTime = Date.now();
    console.log("==================================================");
    console.log("[Ilościowiec] === FAZA 2: ZAMIANA NAZW W LICZBY ===");
    console.log("==================================================");

    try {
        const body = await req.json() as { tenderId: string; useBrainFallback: boolean };
        const { tenderId } = body;

        if (!tenderId) return NextResponse.json({ error: 'Brak tenderId' }, { status: 400 });

        const manifestPath = `tenders/${tenderId}/scopeManifest/main`;
        const manifestSnap = await adminDb.doc(manifestPath).get();
        if (!manifestSnap.exists) throw new Error("Manifest nie istnieje.");

        const manifest = manifestSnap.data() as ScopeManifest;
        const { objectType, objectArea_m2 } = manifest.meta;

        const filesSnap = await adminDb.collection(`tenders/${tenderId}/files`).get();
        const fileStorageMap = new Map<string, string>();
        filesSnap.docs.forEach(doc => fileStorageMap.set(doc.id, doc.data().storagePath ?? ''));

        const allElements: ElementWithContext[] = manifest.requiredDivisions.flatMap(div =>
            div.elements.map(el => ({
                elementId: el.elementId,
                divisionId: div.divisionId,
                name: el.name,
                unit: el.unit,
                gapFillerStrategy: el.gapFillerStrategy,
                gapFillerHint: el.gapFillerHint,
                mappedFileId: el.mappedFileId ?? null,
                mappedStoragePath: el.mappedFileId ? (fileStorageMap.get(el.mappedFileId) ?? null) : null,
                extractionHint: manifest.coverageStatus.find(c => c.elementId === el.elementId)?.gapFillerNote ?? null,
            }))
        );

        // Rozdział na ścieżki
        const visionElements = allElements.filter(el => el.mappedFileId !== null && el.mappedStoragePath !== null);
        const brainElements = allElements.filter(el => el.mappedFileId === null);

        const ai = new GoogleGenAI({
            vertexai: true,
            project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
            location: "global",
        });

        const allResults: QuantityResult[] = [];

        // 1. Ścieżka VISION
        if (visionElements.length > 0) {
            const byFile = new Map<string, ElementWithContext[]>();
            for (const el of visionElements) {
                const key = el.mappedFileId!;
                if (!byFile.has(key)) byFile.set(key, []);
                byFile.get(key)!.push(el);
            }

            for (const [fileId, fileElements] of byFile) {
                const storagePath = fileElements[0].mappedStoragePath!;
                const fileName = storagePath.split('/').pop() ?? fileId;
                const fileData = await fetchFileAsBase64(storagePath);

                if (!fileData) {
                    brainElements.push(...fileElements);
                    continue;
                }

                for (let i = 0; i < fileElements.length; i += VISION_BATCH_SIZE) {
                    const batch = fileElements.slice(i, i + VISION_BATCH_SIZE);
                    try {
                        const batchResults = await processVisionBatch(ai, batch, fileData.base64, fileData.mimeType, fileName);
                        allResults.push(...batchResults);

                        // Elementy, których nie udało się odczytać z wizji -> przekieruj do Mózgu
                        const failed = batchResults
                            .filter(r => r.newStatus === 'GAP_FILLED')
                            .map(r => fileElements.find(el => el.elementId === r.elementId)!)
                            .filter(Boolean);

                        brainElements.push(...failed);
                    } catch {
                        brainElements.push(...batch);
                    }
                }
            }
        }

        // 2. Ścieżka BRAIN
        if (brainElements.length > 0) {
            const brainContext = await fetchBrainIndicators(req, objectType);

            for (let i = 0; i < brainElements.length; i += BRAIN_BATCH_SIZE) {
                const batch = brainElements.slice(i, i + BRAIN_BATCH_SIZE);
                try {
                    const batchResults = await processBrainBatch(ai, batch, brainContext, objectType, objectArea_m2);
                    allResults.push(...batchResults);
                } catch {
                    for (const el of batch) {
                        allResults.push({
                            elementId: el.elementId,
                            divisionId: el.divisionId,
                            quantity: 0,
                            unit: el.unit,
                            source: 'BRAIN_INDICATOR',
                            newStatus: 'GAP_FILLED',
                            dataQuality: 'ESTIMATED',
                            note: `[BRAIN] Awaryjny brak danych – wymagana weryfikacja.`,
                        });
                    }
                }
            }
        }

        // POPRAWKA OBRONNA: Filtrujemy nieistniejące ID (odrzucamy halucynacje z Gemini)
        const validResults = allResults.filter(r => allElements.some(el => el.elementId === r.elementId));

        // Aplikowanie wyników
        const updatedDivisions = manifest.requiredDivisions.map(div => ({
            ...div,
            elements: div.elements.map(el => {
                const r = validResults.find(res => res.elementId === el.elementId);
                return r ? { ...el, quantity: r.quantity, quantitySource: r.source } : el;
            })
        }));

        const updatedCoverage = manifest.coverageStatus.map(entry => {
            const r = validResults.find(res => res.elementId === entry.elementId);
            if (!r) return entry;
            return {
                ...entry,
                status: r.newStatus,
                dataQuality: r.dataQuality,
                quantityEstimated: r.quantity,
                quantitySource: r.source,
                gapFillerNote: r.note,
                lastUpdatedBy: 'agent-ilosciowiec',
                lastUpdatedAt: new Date().toISOString()
            };
        });

        const now = new Date().toISOString();
        await adminDb.doc(manifestPath).update({
            requiredDivisions: updatedDivisions,
            coverageStatus: updatedCoverage,
            'meta.updatedAt': now,
            'meta.completedPhases': [...(manifest.meta.completedPhases ?? []), 'QUANTITY_SURVEYOR'],
        });

        await adminDb.doc(`tenders/${tenderId}/tasks/${tenderId}-QUANTITY_SURVEYOR`).update({
            status: 'DONE',
            result: { processed: validResults.length },
            updatedAt: now,
        });

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`[Ilościowiec] ✅ Faza 2 zakończona w ${duration} sek.`);

        return NextResponse.json({ success: true, phase: 'QUANTITY_SURVEYOR', summary: { processed: validResults.length } });

    } catch (error: any) {
        console.error('[Ilościowiec] ❌ BŁĄD AGENTA:', error.message);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}