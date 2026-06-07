// ============================================================
// PESAM 2.0 – Agent "Detektyw Mapowania"
// POST /api/kosztorysant/agent-detektyw-mapowania
//
// ROLA W DAG: Faza 1 – po WBS_ARCHITECT, przed QUANTITY_SURVEYOR
// WEJŚCIE:   fileList (metadane plików), gotowy szkielet ScopeManifest
// WYJŚCIE:   Zaktualizowane coverageStatus (NEEDS_QUANTITY / MISSING)
//            + mappedFileId na każdym elemencie + extractionHints dla Ilościowca
//
// FILOZOFIA:
//   Ten agent jest "bibliotekarzem" – nie czyta treści plików, tylko ich
//   NAZWY i KATEGORIE. Jego zadaniem jest odpowiedź na pytanie:
//   "Który plik z ZIP-a pokrywa który element z WBS?"
//
//   Działa jak doświadczony kierownik budowy, który patrząc na stos
//   papierów na biurku potrafi powiedzieć:
//   "Ten rysunek K-01 to fundamenty. Ten PDF z 'Instalacje' to D5.
//    Na ściany i dach nie mamy nic – zostają MISSING."
//
//   Kluczowa zasada: NEEDS_QUANTITY = "mamy plik, ale nie mamy liczb".
//   Ilościowiec dostanie od nas wskazówkę co konkretnie wyciągnąć.
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase/admin';
import { GoogleGenAI, Type } from '@google/genai';
import type {
    ScopeManifest,
    ScopeDivision,
    ScopeElement,
    CoverageEntry,
    MappingResult,
    AgentPhase,
} from '../_shared/scopeManifest.types';

export const dynamic = "force-dynamic";

const MODEL_FLASH = "gemini-2.5-flash";

// ================================================================
// Typy wewnętrzne
// ================================================================

interface FileMetadata {
    fileId: string;
    fileName: string;
    category: string;
    storagePath: string;
}

// Pełny output Gemini dla mapowania
interface GeminiMappingOutput {
    mappings: Array<{
        elementId: string;
        mappedFileId: string | null;
        mappedFileName: string | null;
        newStatus: 'NEEDS_QUANTITY' | 'MISSING';
        // Hint dla Ilościowca – co konkretnie wyciągnąć z pliku
        extractionHint: string;
        // Pewność dopasowania (0-100) – przy niskiej Rewident zostanie ostrzeżony
        confidenceScore: number;
    }>;
    // Pliki które Detektyw uznał za nieistotne / nieprzypisane do żadnego elementu
    unmappedFileIds: string[];
    // Ogólna ocena kompletności dokumentacji
    coverageSummary: {
        totalElements: number;
        mappedCount: number;
        missingCount: number;
        overallCoveragePercent: number;
        criticalGaps: string[];
    };
}

// ================================================================
// Response Schema – Gemini musi dopasować pliki do elementów WBS
// ================================================================

const MAPPING_RESPONSE_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        mappings: {
            type: Type.ARRAY,
            items: {
                type: Type.OBJECT,
                properties: {
                    elementId: { type: Type.STRING },
                    mappedFileId: { type: Type.STRING },
                    mappedFileName: { type: Type.STRING },
                    newStatus: {
                        type: Type.STRING,
                        enum: ['NEEDS_QUANTITY', 'MISSING'],
                    },
                    extractionHint: { type: Type.STRING },
                    confidenceScore: { type: Type.INTEGER },
                },
                required: ['elementId', 'newStatus', 'extractionHint', 'confidenceScore'],
            },
        },
        unmappedFileIds: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
        },
        coverageSummary: {
            type: Type.OBJECT,
            properties: {
                totalElements: { type: Type.INTEGER },
                mappedCount: { type: Type.INTEGER },
                missingCount: { type: Type.INTEGER },
                overallCoveragePercent: { type: Type.NUMBER },
                criticalGaps: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                },
            },
            required: [
                'totalElements', 'mappedCount', 'missingCount',
                'overallCoveragePercent', 'criticalGaps',
            ],
        },
    },
    required: ['mappings', 'unmappedFileIds', 'coverageSummary'],
};

// ================================================================
// System Prompt – Detektyw Mapowania
// ================================================================

const DETECTIVE_SYSTEM_INSTRUCTION = `
Jesteś Detektywem Mapowania w systemie PESAM – AI kosztorysanta budowlanego.
Twoje zadanie to dopasowanie plików dokumentacji do listy wymaganych elementów kosztorysu.

ZASADY DZIAŁANIA:
1. Dostajesz LISTĘ ELEMENTÓW (szkielet WBS) i LISTĘ PLIKÓW (nazwy + kategorie).
2. Dla każdego elementu WBS decydujesz: który plik go pokrywa?
3. NIE czytasz treści plików – decydujesz WYŁĄCZNIE na podstawie nazwy i kategorii pliku.
4. Każdy element dostaje jeden z dwóch statusów:
   - NEEDS_QUANTITY: znalazłeś plik który PRAWDOPODOBNIE zawiera dane dla tego elementu
   - MISSING: brak dokumentacji dla tego elementu

LOGIKA DOPASOWANIA (stosuj w kolejności):

KROK 1 – Dopasowanie po kategorii:
  - Kategoria RYSUNEK + słowo "K", "konstrukcja", "fund" → D1 (fundamenty, stan zerowy)
  - Kategoria RYSUNEK + słowo "A", "architektura", "rzut" → D2, D3 (stan surowy, wykończenia)
  - Kategoria RYSUNEK + słowo "S", "sanit", "wod", "inst" → D5 (instalacje sanitarne)
  - Kategoria RYSUNEK + słowo "E", "elek", "WLZ" → D6 (instalacje elektryczne)
  - Kategoria SWZ / OPZ / PFU → powiązane ze wszystkimi działami (niski priorytet, użyj tylko gdy brak rysunków)
  - Kategoria UMOWA → tylko LEGAL, nie mapuj do technicznych elementów WBS

KROK 2 – Dopasowanie po nazwie pliku:
  - "fundamenty", "fund", "K01", "ław" → D1-FUND-*
  - "ścian", "mur", "bloczki", "ściany" → D2-SCIA-*
  - "dach", "stropodach", "pokrycie" → D2-DACH-*
  - "tynk", "gips", "posadz" → D3-*
  - "elewacj", "fasad", "ocieplen" → D4-ELEW-*
  - "wod-kan", "kanalizacj", "wod.", "hydraul" → D5-WKAN-*
  - "went", "wentylacj", "klimat" → D5-WENT-*
  - "co", "ogrzewan", "ciepło" → D5-OGCZ-*
  - "elek", "instalacj elektr", "WLZ", "tablica" → D6-*
  - "ppoż", "alarm", "SAP", "ROP" → D7-PPOZ-*
  - "kuchni", "technolog", "wyposażen" → D8-*

KROK 3 – Priorytetyzacja (gdy wiele plików pasuje do jednego elementu):
  - Preferuj rysunki (RYSUNEK) nad opisami (SWZ, PFU)
  - Preferuj pliki z niższym numerem (np. K-01 przed K-03)
  - Jeden plik może pokrywać WIELE elementów (np. "Rzut parteru" → wszystkie elementy D2 i D3)

EXTRACTION HINTS (wskazówki dla Ilościowca):
Dla każdego zmapowanego elementu podaj PRECYZYJNĄ wskazówkę co Ilościowiec ma wyliczyć:
- "Zmierz powierzchnię wszystkich fundamentów na rzucie [m²]"
- "Oblicz kubaturę bryły budynku z rzutu i przekroju [m³]"
- "Zlicz okna z legendy stolarki, każde w osobnej pozycji [szt.]"
- "Odczytaj grubość izolacji ze szczegółu ściany zewnętrznej [cm → przelicz na m²]"
- "Zsumuj długość rynien i rur spustowych z rzutu dachu [mb]"
Gdy brak pliku (MISSING): "Brak dokumentacji – Ilościowiec użyje wskaźnika Brain dla [typ obiektu]"

PEWNOŚĆ DOPASOWANIA (confidenceScore 0-100):
- 90-100: nazwa pliku jednoznacznie wskazuje element (np. "Projekt_fundamentow.pdf" → fundamenty)
- 70-89: kategoria pasuje, nazwa sugeruje powiązanie
- 50-69: plik ogólny (np. "PFU.pdf") pokrywa wiele elementów
- <50: dopasowanie niepewne – Rewident zostanie ostrzeżony
- 0 (mappedFileId: null): brak dopasowania → MISSING

ODPOWIADAJ WYŁĄCZNIE CZYSTYM, POPRAWNYM JSON.
`.trim();

// ================================================================
// Odczyt szkieletu WBS z Firestore
// ================================================================

async function loadScopeManifest(tenderId: string): Promise<ScopeManifest> {
    const manifestPath = `tenders/${tenderId}/scopeManifest/main`;
    const snap = await adminDb.doc(manifestPath).get();

    if (!snap.exists) {
        throw new Error(
            `[Detektyw] Manifest nie istnieje pod ścieżką: ${manifestPath}. ` +
            `Upewnij się, że WBS_ARCHITECT zakończył pracę przed uruchomieniem Detektywa.`
        );
    }

    return snap.data() as ScopeManifest;
}

// ================================================================
// Odczyt metadanych plików z Firestore (bez treści)
// ================================================================

async function loadFileMetadata(
    tenderId: string,
    fileListFromPayload: FileMetadata[]
): Promise<FileMetadata[]> {
    if (fileListFromPayload.length > 0) {
        console.log(`[Detektyw] Używam fileList z payload (${fileListFromPayload.length} plików).`);
        return fileListFromPayload;
    }

    console.log("[Detektyw] Wczytuję metadane plików z Firestore (fallback)...");
    const filesSnap = await adminDb.collection(`tenders/${tenderId}/files`).get();

    if (filesSnap.empty) {
        console.warn("[Detektyw] ⚠️ Brak plików w projekcie. Wszystkie elementy pozostaną MISSING.");
        return [];
    }

    return filesSnap.docs.map((doc) => {
        const data = doc.data();
        return {
            fileId: doc.id,
            fileName: data.fileName ?? doc.id,
            category: data.category ?? 'INNE',
            storagePath: data.storagePath ?? '',
        };
    });
}

// ================================================================
// Aplikowanie wyników mapowania na ScopeManifest
// ================================================================

function applyMappingResults(
    manifest: ScopeManifest,
    mappingResults: MappingResult[]
): { updatedDivisions: ScopeDivision[]; updatedCoverage: CoverageEntry[] } {
    const now = new Date().toISOString();

    const resultByElementId = new Map<string, MappingResult>(
        mappingResults.map((r) => [r.elementId, r])
    );

    // --- Aktualizacja requiredDivisions (mappedFileId na elementach) ---
    const updatedDivisions: ScopeDivision[] = manifest.requiredDivisions.map((div) => ({
        ...div,
        elements: div.elements.map((el): ScopeElement => {
            const result = resultByElementId.get(el.elementId);
            if (!result) return el;
            return {
                ...el,
                mappedFileId: result.mappedFileId ?? null,
            };
        }),
    }));

    // --- Aktualizacja coverageStatus ---
    const updatedCoverage: CoverageEntry[] = manifest.coverageStatus.map((entry) => {
        const result = resultByElementId.get(entry.elementId);
        if (!result) return entry;

        return {
            ...entry,
            status: result.newStatus,
            mappedFileId: result.mappedFileId ?? null,
            lastUpdatedBy: 'agent-detektyw-mapowania',
            lastUpdatedAt: now,
            gapFillerNote: result.extractionHint ?? null,
        };
    });

    return { updatedDivisions, updatedCoverage };
}

// ================================================================
// GŁÓWNY HANDLER POST
// ================================================================

export async function POST(req: NextRequest) {
    const startTime = Date.now();
    console.log("==================================================");
    console.log("[Detektyw Mapowania] === FAZA 1: SKANOWANIE I DOPASOWANIE PLIKÓW ===");
    console.log("==================================================");

    try {
        const body = await req.json() as {
            tenderId: string;
            fileList: FileMetadata[];
        };

        const { tenderId, fileList: fileListFromPayload } = body;

        if (!tenderId) {
            console.error("[Detektyw] ❌ Błąd: Brak parametru tenderId.");
            return NextResponse.json({ error: 'Brak parametru tenderId' }, { status: 400 });
        }

        console.log(`[Detektyw] Przetarg: "${tenderId}"`);

        // 1. Wczytaj szkielet z WBS_ARCHITECT
        console.log("[Detektyw] Wczytuję szkielet WBS z Firestore...");
        const manifest = await loadScopeManifest(tenderId);

        const allElements = manifest.requiredDivisions.flatMap((div) =>
            div.elements.map((el) => ({ ...el, divisionId: div.divisionId }))
        );

        console.log(`[Detektyw] Szkielet załadowany: ${allElements.length} elementów do zmapowania.`);

        // 2. Wczytaj metadane plików
        const files = await loadFileMetadata(tenderId, fileListFromPayload ?? []);
        console.log(`[Detektyw] Pliki do przeskanowania: ${files.length}`);

        // 3. Brak plików -> fallback
        if (files.length === 0) {
            console.warn("[Detektyw] ⚠️ Brak plików – tryb Brain-only.");
            const now = new Date().toISOString();
            const completedPhases: AgentPhase[] = [...(manifest.meta.completedPhases ?? []), 'MAPPING_DETECTIVE'];

            await adminDb.doc(`tenders/${tenderId}/scopeManifest/main`).update({
                'meta.updatedAt': now,
                'meta.completedPhases': completedPhases,
            });

            await adminDb.doc(`tenders/${tenderId}/tasks/${tenderId}-MAPPING_DETECTIVE`).update({
                status: 'DONE',
                result: { mappedCount: 0, missingCount: allElements.length, overallCoveragePercent: 0 },
                updatedAt: now,
            });

            return NextResponse.json({
                success: true,
                phase: 'MAPPING_DETECTIVE' as AgentPhase,
                summary: { totalElements: allElements.length, mappedCount: 0, missingCount: allElements.length, overallCoveragePercent: 0, noFilesMode: true },
            });
        }

        // 4. Przygotuj kontekst do Gemini
        const elementsContext = allElements.map((el) => ({
            elementId: el.elementId,
            divisionId: el.divisionId,
            name: el.name,
            unit: el.unit,
            gapFillerStrategy: el.gapFillerStrategy,
        }));

        const filesContext = files.map((f) => ({
            fileId: f.fileId,
            fileName: f.fileName,
            category: f.category,
        }));

        const prompt = `
Przeprowadź mapowanie dokumentacji budowlanej dla przetargu.
TYP OBIEKTU: ${manifest.meta.objectType}
POZIOM DOKUMENTACJI: ${manifest.meta.docLevel}/4

ELEMENTY DO ZMAPOWANIA (${allElements.length} pozycji):
${JSON.stringify(elementsContext, null, 2)}

DOSTĘPNE PLIKI (${files.length} pozycji):
${JSON.stringify(filesContext, null, 2)}
        `.trim();

        // 5. Wywołaj Gemini
        console.log("[Detektyw] Inicjalizuję klienta GoogleGenAI...");
        const ai = new GoogleGenAI({
            vertexai: true,
            project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
            location: "global",
        });

        const result = await ai.models.generateContent({
            model: MODEL_FLASH,
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            config: {
                systemInstruction: DETECTIVE_SYSTEM_INSTRUCTION,
                temperature: 0.0,
                responseMimeType: "application/json",
                responseSchema: MAPPING_RESPONSE_SCHEMA as any,
            },
        });

        const rawText = result.text ?? "{}";
        const geminiOutput: GeminiMappingOutput = JSON.parse(rawText);

        if (!geminiOutput.mappings?.length) {
            throw new Error(`Wadliwa odpowiedź Gemini – brak tablicy mappings.`);
        }

        // POPRAWKA OBRONNA: Filtrujemy nieistniejące ID elementów (odrzucamy halucynacje LLM)
        const mappingResults: MappingResult[] = geminiOutput.mappings
            .filter(m => allElements.some(el => el.elementId === m.elementId)) // 👈 TUTAJ ZABEZPIECZENIE
            .map((m) => {
                const element = allElements.find((el) => el.elementId === m.elementId)!;
                return {
                    elementId: m.elementId,
                    divisionId: element.divisionId,
                    mappedFileId: m.mappedFileId ?? null,
                    mappedFileName: m.mappedFileName ?? null,
                    newStatus: m.mappedFileId ? 'NEEDS_QUANTITY' : 'MISSING',
                    extractionHint: m.extractionHint,
                };
            });

        // 6. Zapisz wyniki
        const { updatedDivisions, updatedCoverage } = applyMappingResults(manifest, mappingResults);
        const now = new Date().toISOString();
        const completedPhases: AgentPhase[] = [...(manifest.meta.completedPhases ?? []), 'MAPPING_DETECTIVE'];

        await adminDb.doc(`tenders/${tenderId}/scopeManifest/main`).update({
            requiredDivisions: updatedDivisions,
            coverageStatus: updatedCoverage,
            'meta.updatedAt': now,
            'meta.completedPhases': completedPhases,
        });

        await adminDb.doc(`tenders/${tenderId}/agentResults/MAPPING_DETECTIVE`).set({
            phase: 'MAPPING_DETECTIVE',
            createdAt: now,
            mappingResults,
            unmappedFileIds: geminiOutput.unmappedFileIds,
            coverageSummary: geminiOutput.coverageSummary,
        });

        await adminDb.doc(`tenders/${tenderId}/tasks/${tenderId}-MAPPING_DETECTIVE`).update({
            status: 'DONE',
            result: {
                mappedCount: mappingResults.filter(r => r.newStatus === 'NEEDS_QUANTITY').length,
                missingCount: mappingResults.filter(r => r.newStatus === 'MISSING').length,
                overallCoveragePercent: geminiOutput.coverageSummary.overallCoveragePercent,
            },
            updatedAt: now,
        });

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`[Detektyw] ✅ Faza 1 zakończona w ${duration} sek.`);

        return NextResponse.json({
            success: true,
            phase: 'MAPPING_DETECTIVE' as AgentPhase,
            summary: {
                totalElements: allElements.length,
                mappedCount: mappingResults.filter(r => r.newStatus === 'NEEDS_QUANTITY').length,
                missingCount: mappingResults.filter(r => r.newStatus === 'MISSING').length,
                overallCoveragePercent: geminiOutput.coverageSummary.overallCoveragePercent,
            },
        });

    } catch (error: any) {
        console.error('[Detektyw] ❌ KRYTYCZNY BŁĄD AGENTA:', error.message);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}