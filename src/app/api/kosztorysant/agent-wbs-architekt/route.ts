// ============================================================
// PESAM 2.0 – Agent "Architekt Struktury (WBS)"
// POST /api/kosztorysant/agent-wbs-architekt
//
// ROLA W DAG: Faza 0 – zawsze pierwszy, równolegle z document-based agentami
// WEJŚCIE:   objectTypeHint, objectAreaHint_m2, docLevel, fileNamesContext
// WYJŚCIE:   Szkielet ScopeManifest w Firestore (wszystko MISSING)
//
// NAPRAWKA v2.2:
//   Google Search i responseSchema NIE mogą być w jednym wywołaniu (Vertex AI).
//   Rozwiązanie: dwa wywołania:
//     Krok 1 – Google Search → zbiera fakty z przepisów (bez schema)
//     Krok 2 – Structured output → buduje DNA na podstawie faktów (bez Search)
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase/admin';
import { GoogleGenAI, Type } from '@google/genai';
import { Agent, setGlobalDispatcher } from "undici";

// Zwiększamy domyślny limit oczekiwania fetch() w Node.js z 30s do 5 minut.
// Dzięki temu zapytania Google Search Grounding mogą spokojnie ukończyć analizę sieciową.
setGlobalDispatcher(new Agent({
    headersTimeout: 300000, // 5 minut
    bodyTimeout: 300000,    // 5 minut
}));
import { buildMandatoryMinimum } from '../_shared/heurystyki';
import type {
    ScopeManifest,
    ScopeDivision,
    ScopeElement,
    CoverageEntry,
    ObjectType,
    DocLevel,
    WbsArchitectOutput,
    AgentPhase,
} from '../_shared/scopeManifest.types';

export const dynamic = "force-dynamic";

const MODEL_FLASH = "gemini-2.5-flash";

// ================================================================
// Response Schema – DNA budynku (używane TYLKO w Kroku 2, bez Search)
// ================================================================

const WBS_RESPONSE_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        objectType: {
            type: Type.STRING,
            description: "Typ obiektu: dokładnie jeden z: przedszkole, szkola, biurowiec, hala_sportowa, hala_produkcyjna, budynek_mieszkalny, szpital, inne",
        },
        objectArea_m2: { type: Type.NUMBER },
        confidenceScore: { type: Type.INTEGER },
        requiredDivisions: {
            type: Type.ARRAY,
            items: {
                type: Type.OBJECT,
                properties: {
                    divisionId: { type: Type.STRING },
                    divisionName: { type: Type.STRING },
                    displayOrder: { type: Type.INTEGER },
                    elements: {
                        type: Type.ARRAY,
                        items: {
                            type: Type.OBJECT,
                            properties: {
                                elementId: { type: Type.STRING },
                                name: { type: Type.STRING },
                                unit: { type: Type.STRING },
                                source: {
                                    type: Type.STRING,
                                    description: "Zapisz dokładnie: AI_WBS_HEURISTIC",
                                },
                                gapFillerStrategy: {
                                    type: Type.STRING,
                                    description: "Dokładnie jeden z: SEKOCENBUD_M2, EUROKOD_NORM, GUS_PERCENT, ASK_USER",
                                },
                                gapFillerHint: { type: Type.STRING },
                            },
                            required: ['elementId', 'name', 'unit', 'source', 'gapFillerStrategy'],
                        },
                    },
                },
                required: ['divisionId', 'divisionName', 'displayOrder', 'elements'],
            },
        },
        initialRisks: {
            type: Type.ARRAY,
            items: {
                type: Type.OBJECT,
                properties: {
                    riskId: { type: Type.STRING },
                    description: { type: Type.STRING },
                    costImpactPercent: { type: Type.NUMBER },
                    affectedDivisionIds: { type: Type.ARRAY, items: { type: Type.STRING } },
                    severity: {
                        type: Type.STRING,
                        description: "Dokładnie jeden z: LOW, MEDIUM, HIGH, CRITICAL",
                    },
                },
                required: ['riskId', 'description', 'costImpactPercent', 'affectedDivisionIds', 'severity'],
            },
        },
        areaEstimateNote: {
            type: Type.STRING,
            description: "Krótka notatka skąd pochodzi szacunek powierzchni jeśli objectAreaHint_m2 był null",
        },
    },
    required: ['objectType', 'confidenceScore', 'requiredDivisions', 'initialRisks'],
};

// ================================================================
// Pomocnicze funkcje mapowania (bez zmian)
// ================================================================

function getDivisionName(id: string): string {
    const names: Record<string, string> = {
        D1: 'Stan Zerowy', D2: 'Stan Surowy', D3: 'Stan Wykończeniowy Wewnętrzny',
        D4: 'Elewacja i zagospodarowanie terenu', D5: 'Instalacje Sanitarne',
        D6: 'Instalacje Elektryczne', D7: 'Instalacje Specjalne i Wyposażenie',
        D8: 'Wyposażenie Technologiczne',
    };
    return names[id] ?? `Dział ${id}`;
}

function getDivisionOrder(id: string): number {
    return parseInt(id.replace('D', ''), 10) || 99;
}

function isSimilarElement(name1: string, name2: string): boolean {
    const normalize = (s: string) => s.toLowerCase().replace(/[^a-ząćęłńóśźż\s]/g, ' ').trim();
    const n1 = normalize(name1);
    const n2 = normalize(name2);
    const keywords = n2.split(' ').filter((w) => w.length > 4);
    return keywords.filter((kw) => n1.includes(kw)).length >= 2;
}

function resolveDivisionForElement(elementId: string): string {
    if (elementId.startsWith('UNIV-E1') || elementId.startsWith('UNIV-E2') || elementId.startsWith('UNIV-E3')) return 'D1';
    if (elementId.startsWith('UNIV-E4') || elementId.startsWith('UNIV-E5') || elementId.startsWith('UNIV-E6')) return 'D2';
    if (elementId.startsWith('UNIV-E7') || elementId.startsWith('UNIV-E8') || elementId.startsWith('UNIV-E9')) return 'D3';
    if (elementId.startsWith('UNIV-E10') || elementId.startsWith('UNIV-E13')) return 'D6';
    if (elementId.startsWith('UNIV-E11') || elementId.startsWith('UNIV-E12')) return 'D5';
    if (elementId.startsWith('UNIV-E14')) return 'D4';
    return 'D7';
}

async function mergeWithMandatoryMinimum(
    aiOutput: WbsArchitectOutput,
    docLevel: DocLevel
): Promise<ScopeDivision[]> {
    const mandatory = await buildMandatoryMinimum(aiOutput.objectType, docLevel);
    const divisionMap = new Map<string, ScopeDivision>();

    for (const div of aiOutput.requiredDivisions) {
        divisionMap.set(div.divisionId, {
            ...div,
            elements: div.elements.map((el) => ({
                ...el,
                isMandatoryByLaw: false,
                applicableObjectTypes: 'ALL' as const,
                minDocLevel: docLevel,
                mappedFileId: null,
                quantity: null,
                quantitySource: null,
                techAuditNote: null,
            })),
        });
    }

    for (const mandatoryEl of mandatory) {
        const targetDivisionId = resolveDivisionForElement(mandatoryEl.elementId);
        let alreadyCovered = false;

        for (const [, div] of divisionMap) {
            if (div.elements.some((el) => isSimilarElement(el.name, mandatoryEl.name))) {
                alreadyCovered = true;
                break;
            }
        }

        if (!alreadyCovered) {
            if (!divisionMap.has(targetDivisionId)) {
                divisionMap.set(targetDivisionId, {
                    divisionId: targetDivisionId,
                    divisionName: getDivisionName(targetDivisionId),
                    displayOrder: getDivisionOrder(targetDivisionId),
                    elements: [],
                });
            }

            divisionMap.get(targetDivisionId)!.elements.push({
                ...mandatoryEl,
                mappedFileId: null,
                quantity: null,
                quantitySource: null,
                techAuditNote: null,
            });
        }
    }

    return Array.from(divisionMap.values()).sort((a, b) => a.displayOrder - b.displayOrder);
}

// ================================================================
// KROK 1: Google Search – zbieranie faktów z przepisów
// Osobne wywołanie BEZ responseSchema (Vertex AI tego wymaga)
// ================================================================

async function fetchGroundedFacts(
    ai: GoogleGenAI,
    objectTypeHint: string,
    areaContext: string,
    fileNamesContext: string[]
): Promise<string> {
    console.log("[WBS Architekt] [Krok 1] Szukam przepisów w Google Search...");

    const filesInfo = fileNamesContext.length > 0
        ? `Dostępne dokumenty projektu: ${fileNamesContext.join(', ')}`
        : 'Brak wrzuconych dokumentów – działam w trybie heurystycznym.';

    const searchPrompt = `
Przeszukaj polskie przepisy budowlane i znajdź wymagania dla budynku typu: "${objectTypeHint}".
${areaContext}
${filesInfo}

Znajdź i podaj konkretne wymagania:
1. Wymagania WT 2021 (Warunki Techniczne) – jakie instalacje są obowiązkowe?
2. Wymagania ppoż – czy wymagany system oddymiania, hydranty wewnętrzne, SUG?
3. Wymagania sanitarne – wentylacja mechaniczna, klimatyzacja, technologia kuchni (jeśli dotyczy)?
4. Wymagania dostępności (art. 100 Pzp) – windy, podjazdy, łazienki przystosowane?
5. Typowa powierzchnia użytkowa i kubatura dla tego typu obiektu w Polsce?
6. Typowe wskaźniki kosztów budowy (zł/m²) według Sekocenbud dla tego typu?

Odpowiedz jako zwykły tekst z konkretnymi faktami. Będę używał tej wiedzy do zbudowania kosztorysu.
`.trim();

    try {
        const searchResult = await ai.models.generateContent({
            model: MODEL_FLASH,
            contents: [{ role: "user", parts: [{ text: searchPrompt }] }],
            config: {
                tools: [{ googleSearch: {} }],
                temperature: 0.1,
            },
        });

        const facts = searchResult.text ?? "";
        console.log(`[WBS Architekt] [Krok 1] Zebrano ${facts.length} znaków faktów z Google Search.`);
        return facts;
    } catch (searchError: any) {
        // Google Search może nie być dostępne w każdym regionie/projekcie
        // Fallback: kontynuuj bez groundingu
        console.warn(`[WBS Architekt] [Krok 1] Google Search niedostępny: ${searchError.message}. Kontynuuję bez groundingu.`);
        return `Brak danych z Google Search. Używam wiedzy wbudowanej dla typu: "${objectTypeHint}".`;
    }
}

// ================================================================
// KROK 2: Structured Output – budowanie DNA na podstawie faktów
// Osobne wywołanie BEZ tools (Vertex AI tego wymaga)
// ================================================================

async function buildDnaFromFacts(
    ai: GoogleGenAI,
    objectTypeHint: string,
    objectAreaHint_m2: number | null,
    docLevel: DocLevel,
    groundedFacts: string
): Promise<WbsArchitectOutput> {
    console.log("[WBS Architekt] [Krok 2] Buduję strukturę DNA na podstawie zebranych faktów...");

    const areaInstruction = objectAreaHint_m2
        ? `Powierzchnia użytkowa z dokumentów: ${objectAreaHint_m2} m². Użyj tej wartości.`
        : `Powierzchnia nieznana – oszacuj typową dla "${objectTypeHint}" na podstawie zebranych faktów i podaj w polu objectArea_m2.`;

    const dnaPrompt = `
Na podstawie poniższych faktów z przepisów prawa budowlanego, zbuduj kompletne DNA kosztorysowe budynku.

TYP OBIEKTU: ${objectTypeHint}
${areaInstruction}
POZIOM DOKUMENTACJI: ${docLevel}/4 (0=brak doc, 4=pełny projekt)

FAKTY Z PRZEPISÓW I NORM:
${groundedFacts}

ZADANIE:
Wygeneruj listę wszystkich działów kosztorysowych i elementów scalonych które muszą być wycenione,
żeby budynek uzyskał pozwolenie na użytkowanie. Dla każdego elementu podaj:
- jednostkę miary (m², m³, szt., kpl., t)
- strategię szacowania gdy brak danych (SEKOCENBUD_M2, EUROKOD_NORM, GUS_PERCENT, ASK_USER)
- krótką wskazówkę jak szacować (gapFillerHint)

Pamiętaj o elementach specyficznych dla "${objectTypeHint}" wykrytych w przepisach
(np. technologia kuchni dla przedszkola, oddymianie klatek dla budynku >2 kondygnacji, itp.).

Odpowiedz WYŁĄCZNIE czystym JSON bez komentarzy.
`.trim();

    const dnaResult = await ai.models.generateContent({
        model: MODEL_FLASH,
        contents: [{ role: "user", parts: [{ text: dnaPrompt }] }],
        config: {
            systemInstruction: "Jesteś Architektem Kosztorysowym PESAM. Budujesz DNA budynku jako strukturę JSON. Odpowiadasz WYŁĄCZNIE poprawnym JSON-em bez markdown.",
            temperature: 0.1,
            responseMimeType: "application/json",
            responseSchema: WBS_RESPONSE_SCHEMA as any,
            // Celowo BEZ tools: [] – Vertex AI nie pozwala łączyć Search z responseSchema
        },
    });

    const rawText = dnaResult.text ?? "{}";
    console.log(`[WBS Architekt] [Krok 2] Odebrano DNA: ${rawText.length} znaków.`);

    const parsed: WbsArchitectOutput = JSON.parse(rawText);

    // Jeśli AI nie wypełniło powierzchni a mieliśmy hint – przywróć
    if (!parsed.objectArea_m2 && objectAreaHint_m2) {
        parsed.objectArea_m2 = objectAreaHint_m2;
    }

    return parsed;
}

// ================================================================
// GŁÓWNY HANDLER POST
// ================================================================

export async function POST(req: NextRequest) {
    const startTime = Date.now();
    console.log("==================================================");
    console.log("[WBS Architekt] === FAZA 0: BUDOWANIE DNA BUDYNKU (v2.2) ===");
    console.log("==================================================");

    try {
        const body = await req.json() as {
            tenderId: string;
            objectTypeHint: string;
            objectAreaHint_m2: number | null;
            docLevel: DocLevel;
            estimationMethod: string;
            fileNamesContext: string[];
        };

        const { tenderId, objectTypeHint, objectAreaHint_m2, docLevel, estimationMethod, fileNamesContext } = body;

        if (!tenderId) return NextResponse.json({ error: 'Brak tenderId' }, { status: 400 });

        console.log(`[WBS Architekt] Projekt: "${tenderId}" | Typ: "${objectTypeHint}" | Powierzchnia: ${objectAreaHint_m2 ?? 'nieznana'} m²`);

        const ai = new GoogleGenAI({
            vertexai: true,
            project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
            location: "europe-west4",
        });

        const areaContext = objectAreaHint_m2
            ? `Szacowana powierzchnia użytkowa z dokumentów: ${objectAreaHint_m2} m².`
            : `Powierzchnia nieznana – przyjmij typową dla "${objectTypeHint}".`;

        // ── KROK 1: Google Search (bez responseSchema) ──────────────────
        const groundedFacts = await fetchGroundedFacts(ai, objectTypeHint, areaContext, fileNamesContext);

        // ── KROK 2: Structured Output (bez Search) ────────────────────────
        const aiOutput = await buildDnaFromFacts(ai, objectTypeHint, objectAreaHint_m2, docLevel, groundedFacts);

        const duration1 = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`[WBS Architekt] Oba kroki ukończone w ${duration1}s. Mergowanie z minimum obowiązkowym...`);

        // ── Merge z hardcoded minimum ─────────────────────────────────────
        const mergedDivisions = await mergeWithMandatoryMinimum(aiOutput, docLevel);

        const initialCoverage: CoverageEntry[] = mergedDivisions.flatMap((div) =>
            div.elements.map((el) => ({
                elementId: el.elementId,
                divisionId: div.divisionId,
                status: 'MISSING' as const,
                dataSource: 'AI_WBS_HEURISTIC' as const,  // ← kluczowe: oznaczamy że to szacunek WBS
                coveredBySectionId: null,
                dataQuality: 'MISSING' as const,
                gapFillerNote: null,
                gapFillerValue: null,
                lastUpdatedBy: 'agent-wbs-architekt',
                lastUpdatedAt: new Date().toISOString(),
                mappedFileId: null,
                quantityEstimated: null,
                quantitySource: null,
            }))
        );

        const now = new Date().toISOString();
        const manifest: ScopeManifest = {
            meta: {
                tenderId,
                generatedAt: now,
                updatedAt: now,
                docLevel,
                objectType: aiOutput.objectType,
                objectArea_m2: aiOutput.objectArea_m2 || objectAreaHint_m2 || null,
                areaIsEstimated: !objectAreaHint_m2,  // ← oznaczamy czy powierzchnia jest szacunkowa
                estimationMethod: estimationMethod as any,
                confidenceScore: aiOutput.confidenceScore,
                sourceDocuments: fileNamesContext,
                isLocked: false,
                completedPhases: ['WBS_ARCHITECT'],
            },
            hardRequirements: [],
            requiredDivisions: mergedDivisions,
            missingDataRisks: aiOutput.initialRisks.map((r) => ({ ...r, addedBy: 'AI' as const })),
            coverageStatus: initialCoverage,
        };

        // ── Zapis do Firestore ─────────────────────────────────────────────
        const manifestPath = `tenders/${tenderId}/scopeManifest/main`;
        console.log(`[WBS Architekt] Zapisuję manifest do Firestore: "${manifestPath}"...`);
        await adminDb.doc(manifestPath).set(manifest);

        await adminDb.doc(`tenders/${tenderId}/tasks/${tenderId}-WBS_ARCHITECT`).update({
            status: 'DONE',
            result: {
                objectType: aiOutput.objectType,
                objectArea_m2: manifest.meta.objectArea_m2,
                areaIsEstimated: manifest.meta.areaIsEstimated,
                elementsCount: initialCoverage.length,
                divisionsCount: mergedDivisions.length,
                groundedFactsLength: groundedFacts.length,
            },
            updatedAt: now,
        });

        const totalDuration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`[WBS Architekt] ✅ Faza 0 zakończona sukcesem w ${totalDuration}s. ${initialCoverage.length} elementów w ${mergedDivisions.length} działach.`);
        console.log("==================================================");

        return NextResponse.json({
            success: true,
            phase: 'WBS_ARCHITECT' as AgentPhase,
            summary: {
                objectType: manifest.meta.objectType,
                objectArea_m2: manifest.meta.objectArea_m2,
                areaIsEstimated: manifest.meta.areaIsEstimated,
                confidenceScore: manifest.meta.confidenceScore,
                divisionsCount: mergedDivisions.length,
                elementsCount: initialCoverage.length,
            },
        });

    } catch (error: any) {
        console.error('[WBS Architekt] ❌ KRYTYCZNY BŁĄD AGENTA:', JSON.stringify(error?.message ?? error));

        // Próba oznaczenia taska jako ERROR w Firestore
        try {
            const body = await req.json().catch(() => ({})) as { tenderId?: string };
            if (body?.tenderId) {
                await adminDb.doc(`tenders/${body.tenderId}/tasks/${body.tenderId}-WBS_ARCHITECT`).update({
                    status: 'ERROR',
                    error: error.message,
                    updatedAt: new Date().toISOString(),
                });
            }
        } catch (_) { /* ignoruj błąd zapisu statusu */ }

        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}