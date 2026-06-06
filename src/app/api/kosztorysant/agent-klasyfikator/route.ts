/**
 * PESAM – Agent Klasyfikator Dokumentacji
 * 
 * Ścieżka: src/app/api/kosztorysant/agent-klasyfikator/route.ts
 * 
 * Odpowiedzialność:
 *  - Uruchamiany jako pierwszy, przed stworzeniem zadań dla Roju.
 *  - Na podstawie metadanych plików ocenia kompletność.
 *  - Zwraca docLevel (0-4) oraz rekomendowaną estimationMethod.
 *  - Wymusza dokładną strukturę JSON przez Google GenAI Schema.
 */

import { GoogleGenAI, Type } from "@google/genai";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const MODEL_FLASH = "gemini-3.5-flash"; // Wymagany najnowszy Flash do obsługi pełnych schematów

// ── Interfejsy ────────────────────────────────────────────────────────────────

export type DocLevel =
    | "LEVEL_0_DESCRIPTION_ONLY"
    | "LEVEL_1_PFU"
    | "LEVEL_2_CONCEPT"
    | "LEVEL_3_BUILDING_PERMIT"
    | "LEVEL_4_EXECUTIVE";

export type EstimationMethod =
    | "PARAMETRIC"      // Dla poziomów 0-1
    | "ANALOGICAL"      // Dla poziomu 1-2
    | "ELEMENT_BASED"   // Dla poziomu 2-3
    | "DETAILED_KNR";   // Dla poziomu 4

export interface DocumentationAssessment {
    docLevel: DocLevel;
    estimationMethod: EstimationMethod;
    availableData: {
        hasFloorPlans: boolean;
        hasStructuralDrawings: boolean;
        hasReinforcementDetails: boolean;
        hasInstallationSchemas: boolean;
        hasBillOfQuantities: boolean;
        hasGeotechnicalReport: boolean;
        hasPFU: boolean;
    };
    missingData: {
        item: string;
        impact: "CRITICAL" | "HIGH" | "MEDIUM";
        assumption: string;
        riskAddPercent: number;
    }[];
    uncertaintyPercent: number;
    executiveSummary: string;
}

// ── Schemat wymuszający (Response Schema) ─────────────────────────────────────
// To gwarantuje, że model NIGDY nie zwróci pustego {} ani nie pominie missingData

const classificationSchema = {
    type: Type.OBJECT,
    properties: {
        docLevel: {
            type: Type.STRING,
            enum: [
                "LEVEL_0_DESCRIPTION_ONLY",
                "LEVEL_1_PFU",
                "LEVEL_2_CONCEPT",
                "LEVEL_3_BUILDING_PERMIT",
                "LEVEL_4_EXECUTIVE"
            ]
        },
        estimationMethod: {
            type: Type.STRING,
            enum: ["PARAMETRIC", "ANALOGICAL", "ELEMENT_BASED", "DETAILED_KNR"]
        },
        availableData: {
            type: Type.OBJECT,
            properties: {
                hasFloorPlans: { type: Type.BOOLEAN },
                hasStructuralDrawings: { type: Type.BOOLEAN },
                hasReinforcementDetails: { type: Type.BOOLEAN },
                hasInstallationSchemas: { type: Type.BOOLEAN },
                hasBillOfQuantities: { type: Type.BOOLEAN },
                hasGeotechnicalReport: { type: Type.BOOLEAN },
                hasPFU: { type: Type.BOOLEAN }
            },
            required: ["hasFloorPlans", "hasStructuralDrawings", "hasReinforcementDetails", "hasInstallationSchemas", "hasBillOfQuantities", "hasGeotechnicalReport", "hasPFU"]
        },
        missingData: {
            type: Type.ARRAY,
            description: "Lista braków w dokumentacji. Zwróć pustą tablicę, jeśli braków nie ma.",
            items: {
                type: Type.OBJECT,
                properties: {
                    item: { type: Type.STRING },
                    impact: { type: Type.STRING, enum: ["CRITICAL", "HIGH", "MEDIUM"] },
                    assumption: { type: Type.STRING },
                    riskAddPercent: { type: Type.NUMBER }
                },
                required: ["item", "impact", "assumption", "riskAddPercent"]
            }
        },
        uncertaintyPercent: { type: Type.NUMBER },
        executiveSummary: { type: Type.STRING }
    },
    required: ["docLevel", "estimationMethod", "availableData", "missingData", "uncertaintyPercent", "executiveSummary"]
};

// ── Prompt Systemowy ──────────────────────────────────────────────────────────

const SYSTEM_INSTRUCTION = `
Jesteś Głównym Analitykiem Przetargowym w Polsce.
Otrzymujesz listę plików załączonych do przetargu. Twoim zadaniem jest ocenić KOMPLETNOŚĆ DOKUMENTACJI w skali 0-4.

POZIOMY DOKUMENTACJI:
- LEVEL_0_DESCRIPTION_ONLY: Tylko SIWZ, SWZ, ogłoszenie. Brak rysunków i PFU.
- LEVEL_1_PFU: Jest Program Funkcjonalno-Użytkowy (PFU), ale brak projektów budowlanych.
- LEVEL_2_CONCEPT: Są rzuty architektoniczne, ale brak dokładnej konstrukcji. Może być przedmiar ślepy bez ilości.
- LEVEL_3_BUILDING_PERMIT: Projekt Budowlany. Są rzuty, przekroje, architektura i konstrukcja, ale BRAK rysunków wykonawczych zbrojenia i detali węzłów.
- LEVEL_4_EXECUTIVE: Projekt Wykonawczy. Pełne zestawienia stali, rysunki zbrojeniowe, detale instalacyjne.

METODY WYCENY (przypisz odpowiednią):
- LEVEL 0 -> PARAMETRIC
- LEVEL 1 -> ANALOGICAL
- LEVEL 2 i 3 -> ELEMENT_BASED
- LEVEL 4 -> DETAILED_KNR
`.trim();

// ── Główny Handler ────────────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
    console.log("==================================================");
    console.log("[Klasyfikator Dokumentacji] === ROZPOCZĘTO ANALIZĘ ===");
    console.log("==================================================");

    try {
        const ai = new GoogleGenAI({
            vertexai: true,
            project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
            location: "global",
        });

        const body = await req.json();
        const { filesList, projectName = "Nieznany Projekt" } = body;

        if (!filesList || !Array.isArray(filesList) || filesList.length === 0) {
            console.error("[Klasyfikator Dokumentacji] Błąd: Pusta lista plików.");
            return NextResponse.json({ error: "Brak plików do analizy." }, { status: 400 });
        }

        console.log(`[Klasyfikator Dokumentacji] Projekt: "${projectName}". Liczba plików do oceny: ${filesList.length}`);

        const fileManifest = filesList.map(f => `- Plik: ${f.fileName} | Typ: ${f.category} | Opis: ${f.summary}`).join("\n");

        const userPrompt = `
Dokonaj klasyfikacji poziomu dokumentacji dla projektu: "${projectName}".
Oto lista załączonych plików wraz z ich wstępną analizą z poprzedniego etapu:
${fileManifest}
        `.trim();

        console.log("[Klasyfikator Dokumentacji] Wysyłam zapytanie do Gemini Flash z wymuszonym Response Schema...");

        const response = await ai.models.generateContent({
            model: MODEL_FLASH,
            contents: [{ role: "user", parts: [{ text: userPrompt }] }],
            config: {
                systemInstruction: SYSTEM_INSTRUCTION,
                temperature: 0.0, // Ustalone na 0.0, aby klasyfikacja była maksymalnie analityczna i deterministyczna
                maxOutputTokens: 2048,
                responseMimeType: "application/json",
                responseSchema: classificationSchema, // 🔴 TO JEST KLUCZOWE - wymuszamy strukturę na API
            },
        });

        const rawText = response.text ?? "{}";
        console.log(`[Klasyfikator Dokumentacji] Otrzymano odpowiedź (${rawText.length} znaków).`);

        let assessment: DocumentationAssessment;
        try {
            assessment = JSON.parse(rawText);

            // Zabezpieczenie przed uszkodzoną tablicą (choć przy responseSchema nie powinno to wystąpić)
            if (!Array.isArray(assessment.missingData)) {
                assessment.missingData = [];
            }

            console.log(`[Klasyfikator Dokumentacji] Wynik klasyfikacji: Poziom = ${assessment.docLevel}, Metoda = ${assessment.estimationMethod}`);
            console.log(`[Klasyfikator Dokumentacji] Szacowana niepewność: ${assessment.uncertaintyPercent}%`);
            console.log(`[Klasyfikator Dokumentacji] Wykryto braków: ${assessment.missingData.length}`);

        } catch (e) {
            // Jeśli parsowanie zawiedzie POMIMO Response Schema (bardzo rzadkie), przerywamy proces
            console.error("[Klasyfikator Dokumentacji] Błąd parsowania odpowiedzi. Odpowiedź z modelu była wadliwa:", rawText);
            throw new Error("Model sztucznej inteligencji zwrócił nieprawidłową strukturę danych. Proszę spróbować ponownie.");
        }

        console.log("==================================================");
        return NextResponse.json(assessment, { status: 200 });

    } catch (error: any) {
        console.error("[Klasyfikator Dokumentacji] Krytyczny błąd:", error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}