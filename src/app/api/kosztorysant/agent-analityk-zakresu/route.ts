import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenAI, Type } from '@google/genai';
import { adminDb } from '@/lib/firebase/admin';
import { buildMandatoryMinimum } from '../_shared/heurystyki';
import type {
    ScopeManifest,
    HardRequirement,
    ScopeDivision,
    ScopeElement,
    MissingDataRisk,
    CoverageEntry,
    ObjectType,
    DocLevel,
    AnalitykZakresuGeminiOutput,
} from '../_shared/scopeManifest.types';

export const dynamic = "force-dynamic";

const MODEL_FLASH = "gemini-2.5-flash";

// ============================================================
// Response Schema – Gemini musi dopasować się do tej struktury
// ============================================================

const GEMINI_RESPONSE_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        objectType: {
            type: Type.STRING,
            enum: ['przedszkole', 'szkola', 'biurowiec', 'hala_sportowa', 'hala_produkcyjna', 'budynek_mieszkalny', 'szpital', 'inne'],
        },
        objectArea_m2: { type: Type.NUMBER },
        confidenceScore: { type: Type.INTEGER },
        hardRequirements: {
            type: Type.ARRAY,
            items: {
                type: Type.OBJECT,
                properties: {
                    id: { type: Type.STRING },
                    description: { type: Type.STRING },
                    sourceRef: { type: Type.STRING },
                    affectedDivisionIds: { type: Type.ARRAY, items: { type: Type.STRING } },
                    isMandatory: { type: Type.BOOLEAN },
                },
                required: ['id', 'description', 'sourceRef', 'affectedDivisionIds', 'isMandatory'],
            },
        },
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
                                    enum: ['AI_FROM_PFU', 'AI_FROM_SWZ', 'AI_HEURISTIC', 'HARDCODED_NORM'],
                                },
                                gapFillerStrategy: {
                                    type: Type.STRING,
                                    enum: ['SEKOCENBUD_M2', 'EUROKOD_NORM', 'GUS_PERCENT', 'ASK_USER'],
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
        missingDataRisks: {
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
                        enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
                    },
                },
                required: ['riskId', 'description', 'costImpactPercent', 'affectedDivisionIds', 'severity'],
            },
        },
    },
    required: ['objectType', 'confidenceScore', 'hardRequirements', 'requiredDivisions', 'missingDataRisks'],
};

// ============================================================
// System Prompt dla Analityka Zakresu
// ============================================================

const SYSTEM_INSTRUCTION = `
Jesteś Analitykiem Zakresu w systemie PESAM – AI kosztorysanta budowlanego.
Twoim zadaniem jest zbudowanie "Wzorca Zakresu" (ScopeManifest) – dokumentu określającego, co MUSI znaleźć się w kosztorysie ofertowym.

ZASADY DZIAŁANIA:
1. Czytasz dostarczone dokumenty (SWZ, PFU, OPZ) i wyciągasz WSZYSTKIE wymagania techniczne.
2. Na podstawie typu obiektu i jego funkcji budujesz listę wymaganych działów kosztorysu.
3. ZAKRES ma być wg "Tabeli Elementów Scalonych" – 20–40 pozycji, nie pełny KNR.
4. Dla każdej pozycji określasz jednostkę (m², m³, kpl., mb, szt.) i odpowiednią marżę ryzyka.
5. Wykrywasz RYZYKA – czego brakuje w dokumentacji i jaki to ma wpływ na koszt.

STRUKTURA DZIAŁÓW (stosuj konsekwentnie):
D1: Stan Zerowy (roboty ziemne, fundamenty, izolacje)
D2: Stan Surowy (ściany, stropy, dach)
D3: Stan Wykończeniowy Wewnętrzny (tynki, posadzki, stolarka)
D4: Elewacja i zagospodarowanie terenu
D5: Instalacje Sanitarne (wod-kan, CO, wentylacja)
D6: Instalacje Elektryczne (WLZ, tablice, oświetlenie, odgrom)
D7: Instalacje Specjalne (ppoż, windy, AV, BMS) – jeśli dotyczy
D8: Wyposażenie technologiczne – jeśli dotyczy

STRATEGIE GAP FILLERA:
- EUROKOD_NORM: gdy można użyć mnożnika normowego (kg/m³, m² itp.)
- SEKOCENBUD_M2: gdy istnieje cena scalona na m² lub m³ (elewacje, wykończenia)
- GUS_PERCENT: gdy pozycja to procent od kosztu całości (np. instalacje odgromowe)
- ASK_USER: gdy brakuje kluczowych danych i AI nie może zgadnąć (geologia, technologia specjalistyczna)

CONFIDENCE SCORE (0–100):
- 90–100: pełny PFU + SWZ + rysunki
- 70–89: SWZ + częściowy PFU
- 50–69: tylko SWZ lub tylko PFU
- 30–49: krótki opis słowny
- <30: prawie brak dokumentacji

ODPOWIADAJ WYŁĄCZNIE CZYSTYM, POPRAWNYM JSON.
`.trim();

// ============================================================
// Merge: AI output + dynamiczne, modyfikowalne minimum z bazy
// ============================================================

async function mergeWithMandatoryMinimum(
    aiOutput: AnalitykZakresuGeminiOutput,
    docLevel: DocLevel
): Promise<ScopeDivision[]> {
    console.log(`[Analityk Zakresu] [Merge] Pobieram obowiązkowe minimum z bazy Firestore dla typu: "${aiOutput.objectType}"...`);

    // Pobieramy heurystyki zapisane w Firestore (krok 2)
    const mandatory = await buildMandatoryMinimum(aiOutput.objectType, docLevel);

    const divisionMap = new Map<string, ScopeDivision>();

    // Krok 1: Wpisujemy działy wykryte przez AI
    for (const div of aiOutput.requiredDivisions) {
        divisionMap.set(div.divisionId, {
            ...div,
            elements: div.elements.map((el) => ({
                ...el,
                isMandatoryByLaw: false,
                applicableObjectTypes: 'ALL',
                minDocLevel: docLevel,
            })),
        });
    }

    // Krok 2: Weryfikujemy i uzupełniamy o obowiązkowe pozycje z bazy (których AI nie ma prawa pominąć)
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
            console.log(`[Analityk Zakresu] [Merge] 🛡️ Wykryto brak ważnej pozycji! Dodaję automatycznie: "${mandatoryEl.name}" (${mandatoryEl.elementId})`);
            if (!divisionMap.has(targetDivisionId)) {
                divisionMap.set(targetDivisionId, {
                    divisionId: targetDivisionId,
                    divisionName: getDivisionName(targetDivisionId),
                    displayOrder: getDivisionOrder(targetDivisionId),
                    elements: [],
                });
            }
            divisionMap.get(targetDivisionId)!.elements.push(mandatoryEl);
        }
    }

    return Array.from(divisionMap.values()).sort(
        (a, b) => a.displayOrder - b.displayOrder
    );
}

function isSimilarElement(name1: string, name2: string): boolean {
    const normalize = (s: string) => s.toLowerCase().replace(/[^a-ząćęłńóśźż]/g, ' ').trim();
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

function getDivisionName(id: string): string {
    const names: Record<string, string> = {
        D1: 'Stan Zerowy',
        D2: 'Stan Surowy',
        D3: 'Stan Wykończeniowy Wewnętrzny',
        D4: 'Elewacja i zagospodarowanie terenu',
        D5: 'Instalacje Sanitarne',
        D6: 'Instalacje Elektryczne',
        D7: 'Instalacje Specjalne i Wyposażenie',
        D8: 'Wyposażenie Technologiczne',
    };
    return names[id] ?? `Dział ${id}`;
}

function getDivisionOrder(id: string): number {
    return parseInt(id.replace('D', ''), 10) || 99;
}

function initCoverageStatus(divisions: ScopeDivision[]): CoverageEntry[] {
    const now = new Date().toISOString();
    return divisions.flatMap((div) =>
        div.elements.map((el) => ({
            elementId: el.elementId,
            divisionId: div.divisionId,
            status: 'MISSING' as const,
            coveredBySectionId: null,
            dataQuality: 'MISSING' as const,
            gapFillerNote: null,
            gapFillerValue: null,
            lastUpdatedBy: 'system-init',
            lastUpdatedAt: now,
        }))
    );
}

// ============================================================
// GŁÓWNY HANDLER POST
// ============================================================

export async function POST(req: NextRequest) {
    const startTime = Date.now();
    console.log("==================================================");
    console.log("[Analityk Zakresu] === INICJACJA ANALIZY TEKSTOWEJ ===");
    console.log("==================================================");

    try {
        const body = await req.json() as {
            tenderId: string;
            fileContents: Array<{ fileName: string; content: string; category: string }>;
            docLevel: DocLevel;
            estimationMethod: string;
            sourceDocuments: string[];
        };

        const { tenderId, fileContents, docLevel, estimationMethod, sourceDocuments } = body;

        if (!tenderId) {
            console.error("[Analityk Zakresu] ❌ Błąd: Brak tenderId w żądaniu.");
            return NextResponse.json({ error: 'Brak parametru tenderId' }, { status: 400 });
        }

        console.log(`[Analityk Zakresu] Projekt: "${tenderId}" | Poziom z klasyfikatora: ${docLevel} (${estimationMethod})`);

        const relevantFiles = fileContents.filter((f) =>
            ['SWZ', 'PFU', 'OPZ', 'UMOWA', 'OPIS'].includes(f.category.toUpperCase())
        );

        console.log(`[Analityk Zakresu] Wykryto ${relevantFiles.length} dokumentów tekstowych o dużym znaczeniu.`);

        const filesContext = relevantFiles.length > 0
            ? relevantFiles.map((f) => `=== NAZWA PLIKU: ${f.fileName} (KATEGORIA: ${f.category}) ===\n${f.content.slice(0, 10000)}`).join('\n\n')
            : 'BRAK DOKUMENTÓW TEKSTOWYCH. Bazuj na ogólnej wiedzy inżynierskiej i wzorcu z bazy.';

        console.log(`[Analityk Zakresu] Inicjalizuję klienta GoogleGenAI na serwerze GCP...`);
        const ai = new GoogleGenAI({
            vertexai: true,
            project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
            location: "global",
        });

        const prompt = `
Przeanalizuj poniższe dokumenty przetargowe i wygeneruj ScopeManifest.

PARAMETRY WEJŚCIOWE:
- ID projektu: ${tenderId}
- Poziom dokumentów: ${docLevel}
- Sugerowana Metoda: ${estimationMethod}
- Dokumenty źródłowe: ${sourceDocuments.join(', ')}

DANE DOKUMENTÓW PRZETARGOWYCH:
${filesContext}

Wygeneruj kompletny ScopeManifest JSON zgodnie z Response Schema.
Pamiętaj: Skup się na 20-45 pozycjach elementów scalonych.
    `.trim();

        console.log(`[Analityk Zakresu] Wysyłam dane do Gemini 1.5 Flash w celu zbudowania manifestu...`);

        const result = await ai.models.generateContent({
            model: MODEL_FLASH,
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            config: {
                systemInstruction: SYSTEM_INSTRUCTION,
                temperature: 0.1,
                responseMimeType: "application/json",
                responseSchema: GEMINI_RESPONSE_SCHEMA as any,
            },
        });

        const rawText = result.text ?? "{}";
        console.log(`[Analityk Zakresu] Odebrano JSON od Gemini (${rawText.length} znaków). Rozpoczynam parsowanie...`);

        const aiOutput: AnalitykZakresuGeminiOutput = JSON.parse(rawText);

        if (!aiOutput.objectType || !aiOutput.requiredDivisions?.length) {
            throw new Error('Wadliwa odpowiedź z chmury Gemini – brak wymaganych pól objectType lub requiredDivisions');
        }

        console.log(`[Analityk Zakresu] AI sklasyfikowało obiekt jako: "${aiOutput.objectType}" | Pewność: ${aiOutput.confidenceScore}/100`);

        // Mergowanie z bazą dynamicznych heurystyk z bazy Firestore
        const mergedDivisions = await mergeWithMandatoryMinimum(aiOutput, docLevel);

        // Budowanie statusów początkowych – wszystko na starcie dostaje status "MISSING"
        console.log(`[Analityk Zakresu] Generuję mapę pokrycia (coverageStatus) dla ${mergedDivisions.length} dziaów...`);
        const initialCoverage = initCoverageStatus(mergedDivisions);

        const now = new Date().toISOString();
        const manifest: ScopeManifest = {
            meta: {
                tenderId,
                generatedAt: now,
                updatedAt: now,
                docLevel,
                objectType: aiOutput.objectType,
                objectArea_m2: aiOutput.objectArea_m2 ?? null,
                estimationMethod: estimationMethod as any,
                confidenceScore: aiOutput.confidenceScore,
                sourceDocuments,
                isLocked: false,
            },
            hardRequirements: aiOutput.hardRequirements.map((hr) => ({
                ...hr,
                addedBy: 'AI' as const,
            })),
            requiredDivisions: mergedDivisions,
            missingDataRisks: aiOutput.missingDataRisks.map((r) => ({
                ...r,
                addedBy: 'AI' as const,
            })),
            coverageStatus: initialCoverage,
        };

        // Zapis do bazy
        const manifestPath = `tenders/${tenderId}/scopeManifest/main`;
        console.log(`[Analityk Zakresu] Zapisuję gotowy manifest pod ścieżką w Firestore: "${manifestPath}"...`);
        await adminDb.doc(manifestPath).set(manifest, { merge: false });

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`[Analityk Zakresu] ✅ Sukces: Manifest stworzony w czasie ${duration} sek.`);
        console.log("==================================================");

        return NextResponse.json({
            success: true,
            summary: {
                objectType: manifest.meta.objectType,
                objectArea_m2: manifest.meta.objectArea_m2,
                confidenceScore: manifest.meta.confidenceScore,
                divisionsCount: mergedDivisions.length,
                elementsCount: initialCoverage.length,
                hardRequirementsCount: manifest.hardRequirements.length,
                risksCount: manifest.missingDataRisks.length,
                askUserCount: initialCoverage.filter((c) =>
                    mergedDivisions.flatMap((d) => d.elements)
                        .find((el) => el.elementId === c.elementId)?.gapFillerStrategy === 'ASK_USER'
                ).length,
            },
        });

    } catch (error: any) {
        console.error('[Analityk Zakresu] ❌ KRYTYCZNY BŁĄD AGENTA:', error);
        return NextResponse.json(
            { error: 'Błąd generowania ScopeManifest', details: String(error) },
            { status: 500 }
        );
    }
}