/**
 * PESAM – Agent Klasyfikator Dokumentacji
 * 
 * Ścieżka: src/app/api/kosztorysant/agent-klasyfikator/route.ts
 * 
 * Odpowiedzialność:
 *  - Uruchamiany jako pierwszy, przed stworzeniem zadań dla Roju.
 *  - Na podstawie metadanych plików (nazwy, rozszerzenia, podsumowania) ocenia kompletność.
 *  - Zwraca docLevel (0-4) oraz rekomendowaną estimationMethod.
 *  - Generuje raport o brakach i ryzyku z nich wynikającym.
 */

import { GoogleGenAI } from "@google/genai";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const MODEL_FLASH = "gemini-3.5-flash";

// ── Interfejsy ────────────────────────────────────────────────────────────────

export type DocLevel =
    | "LEVEL_0_DESCRIPTION_ONLY"
    | "LEVEL_1_PFU"
    | "LEVEL_2_CONCEPT"
    | "LEVEL_3_BUILDING_PERMIT"
    | "LEVEL_4_EXECUTIVE";

export type EstimationMethod =
    | "PARAMETRIC"      // Dla poziomów 0-1 (wskaźniki PLN/m2)
    | "ANALOGICAL"      // Dla poziomu 1-2 (rozbicie na stany wg analogii)
    | "ELEMENT_BASED"   // Dla poziomu 2-3 (KNR + normatywne zgadywanie braków)
    | "DETAILED_KNR";   // Dla poziomu 4 (pełny szczegółowy KNR)

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

Zwróć DOKŁADNIE jeden obiekt JSON (bez znaczników markdown):
{
  "docLevel": "LEVEL_3_BUILDING_PERMIT",
  "estimationMethod": "ELEMENT_BASED",
  "availableData": {
    "hasFloorPlans": true,
    "hasStructuralDrawings": true,
    "hasReinforcementDetails": false,
    "hasInstallationSchemas": false,
    "hasBillOfQuantities": true,
    "hasGeotechnicalReport": false,
    "hasPFU": false
  },
  "missingData": [
    {
      "item": "Rysunki zbrojenia (schematy)",
      "impact": "HIGH",
      "assumption": "Zbrojenie zostanie oszacowane normatywnie (kg stali / m3 betonu).",
      "riskAddPercent": 15
    },
    {
      "item": "Badania geotechniczne gruntów",
      "impact": "MEDIUM",
      "assumption": "Założono standardowe warunki wodno-gruntowe (kategoria III).",
      "riskAddPercent": 5
    }
  ],
  "uncertaintyPercent": 20,
  "executiveSummary": "Dokumentacja na poziomie Projektu Budowlanego. Brak detali zbrojenia wymusza zastosowanie normatywnych wskaźników zużycia stali, co generuje ok. 20% niepewności kosztowej."
}
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

        // Tworzymy uproszczoną listę dla AI (żeby oszczędzać tokeny)
        const fileManifest = filesList.map(f => `- Plik: ${f.fileName} | Typ AI: ${f.category} | Opis: ${f.summary}`).join("\n");
        console.log(`[Klasyfikator Dokumentacji] Zbudowano manifest plików:\n${fileManifest}`);

        const userPrompt = `
Ocenić kompletność dokumentacji dla projektu: "${projectName}".
Oto lista załączonych plików wraz z ich wstępną analizą:
${fileManifest}

Zwróć ocenę w formacie JSON zgodnie z instrukcjami.
        `.trim();

        console.log("[Klasyfikator Dokumentacji] Wysyłam zapytanie do Gemini Flash...");

        const response = await ai.models.generateContent({
            model: MODEL_FLASH,
            contents: [{ role: "user", parts: [{ text: userPrompt }] }],
            config: {
                systemInstruction: SYSTEM_INSTRUCTION,
                temperature: 0.1,
                maxOutputTokens: 2048,
                responseMimeType: "application/json",
            },
        });

        const rawText = response.text ?? "{}";
        console.log(`[Klasyfikator Dokumentacji] Otrzymano odpowiedź (${rawText.length} znaków). Parsowanie...`);

        let assessment: DocumentationAssessment;
        try {
            assessment = JSON.parse(rawText);
            console.log(`[Klasyfikator Dokumentacji] Wynik klasyfikacji: Poziom = ${assessment.docLevel}, Metoda = ${assessment.estimationMethod}`);
            console.log(`[Klasyfikator Dokumentacji] Szacowana niepewność projektu: ${assessment.uncertaintyPercent}%`);

            if (assessment.missingData.length > 0) {
                console.log(`[Klasyfikator Dokumentacji] Zidentyfikowano ${assessment.missingData.length} kluczowych braków w dokumentacji.`);
            }
        } catch (e) {
            console.error("[Klasyfikator Dokumentacji] Błąd parsowania odpowiedzi AI:", e);
            throw new Error("AI nie zwróciło poprawnego formatu JSON.");
        }

        console.log("==================================================");
        return NextResponse.json(assessment, { status: 200 });

    } catch (error: any) {
        console.error("[Klasyfikator Dokumentacji] Krytyczny błąd:", error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}