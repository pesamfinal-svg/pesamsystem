// ============================================================
// PESAM 2.2 – Agent "Detektyw Mapowania (Mapping Detective)"
// POST /api/kosztorysant/agent-detektyw-mapowania
//
// ROLA W DAG: Faza 1 – Most między WBS a dokumentami.
// WEJŚCIE: ScopeManifest (DNA z WBS) + Lista wgranych plików
// WYJŚCIE: Zaktualizowany ScopeManifest. Elementy pokryte plikami 
//          dostają status NEEDS_QUANTITY. Reszta zostaje MISSING.
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase/admin';
import { GoogleGenAI, Type } from '@google/genai';
import type {
    ScopeManifest,
    AgentPhase,
    CoverageEntry,
    ScopeDivision,
    ScopeElement
} from '../_shared/scopeManifest.types';

export const dynamic = "force-dynamic";

const MODEL_FLASH = "gemini-2.5-flash";

const MAPPING_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        mappings: {
            type: Type.ARRAY,
            items: {
                type: Type.OBJECT,
                properties: {
                    elementId: { type: Type.STRING },
                    mappedFileId: { type: Type.STRING, description: "ID przypisanego pliku. Jeśli żaden plik nie pasuje, zwróć słowo 'null'" },
                    extractionHint: { type: Type.STRING, description: "Wskazówka dla Ilościowca, np. 'Szukaj w tabeli zestawienia stali na str. 3' lub 'null'" }
                },
                required: ["elementId", "mappedFileId", "extractionHint"]
            }
        }
    },
    required: ["mappings"]
};

const SYSTEM_INSTRUCTION = `
Jesteś Detektywem Mapowania w systemie PESAM. Twoim zadaniem jest połączenie wymagań kosztorysowych (DNA budynku) z wgranymi przez użytkownika plikami.

Otrzymasz:
1. Listę elementów do wyceny (wygenerowaną przez WBS).
2. Listę plików wgranych do systemu (z ich nazwami i kategoriami).

Dla każdego elementu zadecyduj, czy można go wyliczyć na podstawie któregoś z podanych plików.
- Jeśli tak: przypisz ID tego pliku do 'mappedFileId' i napisz krótką 'extractionHint' (jak to odczytać).
- Jeśli nie ma odpowiedniego pliku (np. mamy tylko SWZ, a wyceniamy mury): ustaw 'mappedFileId' na "null". Element ten zostanie wyceniony później algorytmem wskaźnikowym przez Gap Fillera.

ODPOWIADAJ WYŁĄCZNIE CZYSTYM JSON.
`.trim();

export async function POST(req: NextRequest) {
    const startTime = Date.now();
    console.log("==================================================");
    console.log("[Detektyw Mapowania] === FAZA 1: DOPASOWANIE PLIKÓW DO DNA ===");
    console.log("==================================================");

    try {
        const body = await req.json();
        const { tenderId, fileList } = body as {
            tenderId: string;
            fileList: Array<{ fileId: string; fileName: string; category: string; storagePath: string }>;
        };

        if (!tenderId) return NextResponse.json({ error: 'Brak tenderId' }, { status: 400 });

        console.log(`[Detektyw Mapowania] Analizuję projekt: ${tenderId}. Liczba dostępnych plików: ${fileList?.length || 0}`);

        // 1. Pobranie ScopeManifest z bazy (wygenerowanego przez WBS)
        const manifestPath = `tenders/${tenderId}/scopeManifest/main`;
        const manifestSnap = await adminDb.doc(manifestPath).get();

        if (!manifestSnap.exists) {
            throw new Error("ScopeManifest nie istnieje. WBS_ARCHITECT nie zakończył pracy poprawnie.");
        }

        const manifest = manifestSnap.data() as ScopeManifest;
        
        // Ekstrakcja elementów do zmapowania
        const elementsToMap = manifest.requiredDivisions.flatMap(div => 
            div.elements.map(el => ({ id: el.elementId, name: el.name, unit: el.unit }))
        );

        console.log(`[Detektyw Mapowania] Liczba elementów do zmapowania: ${elementsToMap.length}`);

        // Jeśli nie ma plików (np. ktoś wgrał pusty projekt / tylko SWZ bez PDFów z rysunkami)
        const usableFiles = fileList?.filter(f => f.category !== 'SWZ' && f.category !== 'UMOWA') || [];
        
        let mappings: any[] = [];

        if (usableFiles.length === 0) {
            console.log(`[Detektyw Mapowania] Brak plików projektowych (rysunków/przedmiarów). Wszystko przechodzi do Gap Fillera.`);
            // Zwracamy pustą tablicę mapowań, wszystko zostanie MISSING
            mappings = elementsToMap.map(el => ({ elementId: el.id, mappedFileId: "null", extractionHint: "null" }));
        } else {
            // Pytamy AI o dopasowanie
            const ai = new GoogleGenAI({
                vertexai: true,
                project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
                location: "global",
            });

            const prompt = `
Zmapuj te elementy do odpowiednich plików.

LISTA DOSTĘPNYCH PLIKÓW:
${JSON.stringify(usableFiles.map(f => ({ id: f.fileId, name: f.fileName, category: f.category })), null, 2)}

LISTA ELEMENTÓW KOSZTORYSU:
${JSON.stringify(elementsToMap, null, 2)}
            `.trim();

            const response = await ai.models.generateContent({
                model: MODEL_FLASH,
                contents: [{ role: "user", parts: [{ text: prompt }] }],
                config: {
                    systemInstruction: SYSTEM_INSTRUCTION,
                    temperature: 0.1,
                    responseMimeType: "application/json",
                    responseSchema: MAPPING_SCHEMA as any,
                },
            });

            const parsed = JSON.parse(response.text ?? "{}");
            mappings = parsed.mappings || [];
        }

        // 2. Aktualizacja ScopeManifest (requiredDivisions i coverageStatus)
        let mappedCount = 0;
        const now = new Date().toISOString();

        const updatedDivisions: ScopeDivision[] = manifest.requiredDivisions.map(div => ({
            ...div,
            elements: div.elements.map(el => {
                const mapData = mappings.find(m => m.elementId === el.elementId);
                const fileId = mapData && mapData.mappedFileId !== "null" ? mapData.mappedFileId : null;
                return { ...el, mappedFileId: fileId };
            })
        }));

        const updatedCoverage: CoverageEntry[] = manifest.coverageStatus.map(entry => {
            const mapData = mappings.find(m => m.elementId === entry.elementId);
            const isMapped = mapData && mapData.mappedFileId !== "null";
            
            if (isMapped) mappedCount++;

            // Jeśli AI znalazło rysunek dla elementu, ustawiamy status na NEEDS_QUANTITY dla Ilościowca.
            // Jeśli nie znalazło, zostawiamy MISSING. Jeśli element wymaga odpytania usera, dajemy WAITING_USER.
            let newStatus = entry.status;
            
            if (isMapped) {
                newStatus = 'NEEDS_QUANTITY';
            } else {
                const elDef = updatedDivisions.flatMap(d => d.elements).find(e => e.elementId === entry.elementId);
                if (elDef?.gapFillerStrategy === 'ASK_USER') {
                    newStatus = 'WAITING_USER';
                }
            }

            return {
                ...entry,
                status: newStatus,
                mappedFileId: isMapped ? mapData.mappedFileId : null,
                gapFillerNote: isMapped ? mapData.extractionHint : entry.gapFillerNote,
                lastUpdatedBy: 'agent-detektyw-mapowania',
                lastUpdatedAt: now
            };
        });

        // 3. Zapis do Firestore
        await adminDb.doc(manifestPath).update({
            requiredDivisions: updatedDivisions,
            coverageStatus: updatedCoverage,
            'meta.updatedAt': now,
            'meta.completedPhases': [...(manifest.meta.completedPhases ?? []), 'MAPPING_DETECTIVE'],
        });

        await adminDb.doc(`tenders/${tenderId}/tasks/${tenderId}-MAPPING_DETECTIVE`).update({
            status: 'DONE',
            result: { mappedCount, totalElements: elementsToMap.length },
            updatedAt: now,
        });

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`[Detektyw Mapowania] ✅ Faza 1 zakończona w ${duration}s. Zmapowano ${mappedCount}/${elementsToMap.length} elementów.`);
        console.log("==================================================");

        return NextResponse.json({
            success: true,
            phase: 'MAPPING_DETECTIVE',
            summary: { mappedCount, totalElements: elementsToMap.length }
        });

    } catch (error: any) {
        console.error('[Detektyw Mapowania] ❌ BŁĄD AGENTA:', error.message);
        
        // Próba zapisania błędu w tasku
        try {
            const body = await req.json().catch(() => ({})) as { tenderId?: string };
            if (body?.tenderId) {
                await adminDb.doc(`tenders/${body.tenderId}/tasks/${body.tenderId}-MAPPING_DETECTIVE`).update({
                    status: 'ERROR',
                    error: error.message,
                    updatedAt: new Date().toISOString(),
                });
            }
        } catch (_) {}

        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}