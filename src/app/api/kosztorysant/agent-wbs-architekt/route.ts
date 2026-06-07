// ============================================================
// PESAM 2.0 – Agent "Architekt Struktury (WBS)" z Google Search Grounding
// POST /api/kosztorysant/agent-wbs-architekt
//
// ROLA W DAG: Faza 0 – zawsze pierwszy
// WEJŚCIE:   objectTypeHint, objectAreaHint_m2, docLevel
// WYJŚCIE:   Szkielet ScopeManifest w Firestore (wszystko MISSING)
//
// FILOZOFIA PESAM 2.0:
//   Ten agent nie zgaduje na ślepo ani nie korzysta ze sztywnego kodu.
//   Jeśli otrzyma nietypowy typ obiektu (np. "szpital" lub "hala"),
//   wykorzystuje narzędzie Google Search Grounding do przeszukania polskiego
//   prawa budowlanego (WT 2021) w locie i buduje DNA na żywych faktach.
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase/admin';
import { GoogleGenAI, Type } from '@google/genai';
import { buildMandatoryMinimum } from '../_shared/heurystyki';
import type {
    ScopeManifest,
    ScopeManifestMeta,
    ScopeDivision,
    ScopeElement,
    MissingDataRisk,
    CoverageEntry,
    ObjectType,
    DocLevel,
    WbsArchitectOutput,
    AgentPhase,
} from '../_shared/scopeManifest.types';

export const dynamic = "force-dynamic";

const MODEL_FLASH = "gemini-2.5-flash";

// ================================================================
// Response Schema – DNA budynku dla Gemini (bez problematycznych enums)
// ================================================================

const WBS_RESPONSE_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        objectType: {
            type: Type.STRING,
            description: "Typ obiektu: Musi być dokładnie jednym ze słów: przedszkole, szkola, biurowiec, hala_sportowa, hala_produkcyjna, budynek_mieszkalny, szpital, inne",
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
                                    description: "Musi być dokładnie jednym ze słów: SEKOCENBUD_M2, EUROKOD_NORM, GUS_PERCENT, ASK_USER",
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
                        description: "Musi być dokładnie jednym ze słów: LOW, MEDIUM, HIGH, CRITICAL",
                    },
                },
                required: ['riskId', 'description', 'costImpactPercent', 'affectedDivisionIds', 'severity'],
            },
        },
    },
    required: ['objectType', 'confidenceScore', 'requiredDivisions', 'initialRisks'],
};

// ================================================================
// System Prompt – Architekt Struktury WBS
// ================================================================

const WBS_SYSTEM_INSTRUCTION = `
Jesteś Architektem Struktury w systemie PESAM – AI kosztorysanta budowlanego.
Twoje zadanie to wygenerowanie kompletnego "DNA technologicznego" budynku
na podstawie jego typu i norm prawnych. 

WYKORZYSTAJ narzędzie wyszukiwania Google Search, aby sprawdzić i zweryfikować:
- Polskie przepisy prawa budowlanego (WT 2021) dla wybranego typu obiektu.
- Wymagania ppoż i ewakuacyjne (np. czy wymagany jest system oddymiania lub hydranty wewnętrzne).
- Standardy instalacji sanitarnych, klimatyzacyjnych, IT i technologicznych.

Pamiętaj: Pytasz siebie "Co musi BYĆ, żeby budynek działał?" – nie "Co jest w dostarczonych dokumentach?".
ODPOWIADAJ WYŁĄCZNIE CZYSTYM, POPRAWNYM JSON. Bez komentarzy, bez markdown.
`.trim();

// ================================================================
// Pomocnicze funkcje mapowania
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
// GŁÓWNY HANDLER POST
// ================================================================

export async function POST(req: NextRequest) {
    const startTime = Date.now();
    console.log("==================================================");
    console.log("[WBS Architekt] === FAZA 0: BUDOWANIE DNA BUDYNKU (v2.1) ===");
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

        // 1. Inicjalizacja AI z wbudowanym Google Search Grounding
        console.log("[WBS Architekt] Inicjalizuję klienta GoogleGenAI (Vertex AI Grounding)...");
        const ai = new GoogleGenAI({
            vertexai: true,
            project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
            location: "global",
        });

        const areaContext = objectAreaHint_m2
            ? `Szacowana powierzchnia użytkowa: ${objectAreaHint_m2} m².`
            : 'Powierzchnia nieznana – przyjmij typową dla tego typu.';

        const prompt = `
Wygeneruj kompletne DNA technologiczne (szkielet kosztorysu) dla obiektu o parametrach:
TYP BUDYNKU: ${objectTypeHint}
${areaContext}
POZIOM DOKUMENTACJI: Level ${docLevel}/4

ZADANIE:
1. Użyj wyszukiwarki Google Search, aby odnaleźć i zweryfikować polskie przepisy prawa budowlanego (WT 2021), standardy ppoż, oraz wymogi wentylacji mechanicznej i instalacji dla typu budynku: "${objectTypeHint}".
2. Na podstawie zebranych danych z internetu stwórz kompletną listę działów i elementów scalonych, które musimy wycenić w kosztorysie, by budynek bez przeszkód przeszedł odbiory techniczne.
        `.trim();

        console.log("[WBS Architekt] Wysyłam zapytanie do Gemini z włączonym uziemieniem Google Search...");

        const result = await ai.models.generateContent({
            model: MODEL_FLASH,
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            config: {
                systemInstruction: WBS_SYSTEM_INSTRUCTION,
                temperature: 0.1,
                responseMimeType: "application/json",
                responseSchema: WBS_RESPONSE_SCHEMA as any,
                tools: [
                    { googleSearch: {} } // 👈 WŁĄCZENIE GROUNDINGU W LOCIE!
                ]
            },
        });

        const rawText = result.text ?? "{}";
        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`[WBS Architekt] Odebrano DNA budynku z chmury i zsyntetyzowano z wynikami Google Search w ${duration}s.`);

        const aiOutput: WbsArchitectOutput = JSON.parse(rawText);
        const mergedDivisions = await mergeWithMandatoryMinimum(aiOutput, docLevel);

        const initialCoverage = mergedDivisions.flatMap((div) =>
            div.elements.map((el) => ({
                elementId: el.elementId,
                divisionId: div.divisionId,
                status: 'MISSING' as const,
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
                tenderId, generatedAt: now, updatedAt: now, docLevel,
                objectType: aiOutput.objectType,
                objectArea_m2: aiOutput.objectArea_m2 || objectAreaHint_m2 || null,
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

        const manifestPath = `tenders/${tenderId}/scopeManifest/main`;
        console.log(`[WBS Architekt] Zapisuję dynamiczny manifest do Firestore: "${manifestPath}"...`);
        await adminDb.doc(manifestPath).set(manifest);

        await adminDb.doc(`tenders/${tenderId}/tasks/${tenderId}-WBS_ARCHITECT`).update({
            status: 'DONE',
            result: { objectType: aiOutput.objectType, elementsCount: initialCoverage.length },
            updatedAt: now,
        });

        console.log(`[WBS Architekt] ✅ Faza 0 zakończona sukcesem. Spis treści gotowy.`);
        console.log("==================================================");

        return NextResponse.json({
            success: true,
            phase: 'WBS_ARCHITECT' as AgentPhase,
            summary: {
                objectType: manifest.meta.objectType,
                objectArea_m2: manifest.meta.objectArea_m2,
                confidenceScore: manifest.meta.confidenceScore,
                divisionsCount: mergedDivisions.length,
                elementsCount: initialCoverage.length,
            },
        });

    } catch (error: any) {
        console.error('[WBS Architekt] ❌ KRYTYCZNY BŁĄD AGENTA:', error.message);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}