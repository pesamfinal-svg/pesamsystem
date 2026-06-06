/**
 * PESAM – Agent Wycena Wskaźnikowa (Parametryczna / Analogiczna)
 * 
 * Ścieżka: src/app/api/kosztorysant/agent-wycena-wskaznikowa/route.ts
 * 
 * Odpowiedzialność:
 *  - Służy do wyceny na Poziomie 0 i 1 (brak projektów, samo PFU/opis).
 *  - Stosuje wskaźniki cenowe obiektów budowlanych (PLN / m² powierzchni użytkowej).
 *  - Nakłada współczynniki regionalne i standardu wykonania.
 *  - Generuje scalone pozycje RMS z flagą "PARAMETRIC".
 */

import { GoogleGenAI } from "@google/genai";
import { NextRequest, NextResponse } from "next/server";
import { EstimateSection } from "../_shared/types";

export const dynamic = "force-dynamic";

const MODEL_PRO = "gemini-2.5-pro";

// ── Baza Wiedzy Cen Parametrycznych PL 2025/2026 ──────────────────────────────

const SYSTEM_INSTRUCTION = `
Jesteś Ekspertem ds. Wycen Wskaźnikowych i Analiz Kosztowych (Sekocenbud / GUS). 
Wyceniasz inwestycje budowlane na podstawie wskaźników cenowych za m² powierzchni użytkowej (PUM) dla rynku polskiego.

WSKAŹNIKI BAZOWE KUBATUROWE (PLN netto / m² powierzchni użytkowej):
- Przedszkola / Żłobki standard:    5 800 - 8 200 PLN/m²
- Szkoły podstawowe:                5 200 - 7 500 PLN/m²
- Budynki mieszkalne wielorodzinne: 4 800 - 6 800 PLN/m²
- Budynki biurowe (klasa B/C):      5 500 - 8 000 PLN/m²
- Hale magazynowe (nieogrzewane):   1 800 - 2 800 PLN/m²
- Hale produkcyjne ze spawaniem:    2 800 - 4 200 PLN/m²

MNOŻNIKI REGIONALNE (WOJEWÓDZTWA):
- Mazowieckie (Warszawa):   × 1.15
- Dolnośląskie, Pomorskie:  × 1.05
- Małopolskie, Wielkopolskie: × 1.02
- Podkarpackie, Lubelskie:  × 0.90  (korekta -10%)
- Warmińsko-Mazurskie:      × 0.88

PROCENTOWY PODZIAŁ ELEMENTÓW SCALONYCH (standardowy rozkład kosztów):
1. Stan zero (fundamenty, ziemne):               8% - 12% łącznego kosztu
2. Stan surowy (konstrukcja, dach):               30% - 40% łącznego kosztu
3. Roboty wykończeniowe (tynki, posadzki, elewacja): 20% - 25% łącznego kosztu
4. Instalacje wewnętrzne (sanitarne, elektryka):  20% - 30% łącznego kosztu
5. Zagospodarowanie terenu i przyłącza:           5% - 10% łącznego kosztu

ZASADA DZIAŁANIA:
1. Przeanalizuj opis i wyodrębnij: typ budynku, szacowaną powierzchnię (m²) oraz lokalizację.
2. Wybierz odpowiedni wskaźnik bazowy PLN/m².
3. Zastosuj mnożnik regionalny.
4. Oblicz szacunkową wartość całkowitą netto.
5. Rozbij tę kwotę na 5 elementów scalonych (sekcji) zgodnie z procentowym podziałem.
6. Dla każdego elementu utwórz pozycję w kosztorysie o jednostce "m2" i cenie jednostkowej równej wskaźnikowi cząstkowemu.
7. Przypisz wskaźnik jakości danych (dataQuality):
   - Method: "PARAMETRIC"
   - Confidence: "LOW" (bo wyceniamy bez rysunków)
   - RiskBuffer: 25 (zalecana 25% rezerwa na nieprzewidziane koszty w trybie "Zaprojektuj i Wybuduj")

Zwróć wyłącznie poprawny obiekt JSON:
{
  "sections": [
    {
      "id": "sec-stan-zero",
      "name": "Dział 1. Stan Zero (Oszacowanie parametryczne)",
      "items": [
        {
          "id": "par-1",
          "code": "WSK-01",
          "name": "Wykonanie stanu zero (ziemia, fundamenty, hydroizolacje) - Wskaźnik powierzchniowy",
          "type": "M", // Dla uproszczenia jako Materiał scalony
          "quantity": 2000, // powierzchnia [m2]
          "unit": "m2",
          "basePrice": 650.00, // cząstkowy koszt m2 stanu zero
          "unitPrice": 650.00,
          "dataQuality": {
            "method": "PARAMETRIC",
            "confidence": "LOW",
            "riskBuffer": 25,
            "notes": ["Wycena na podstawie średnich stawek krajowych dla województwa podkarpackiego (mnożnik 0.90).", "Przyjęto udział stanu zero na poziomie 10% łącznych kosztów."]
          }
        }
      ]
    }
  ],
  "parametricComment": "Wycena wskaźnikowa dla przedszkola 2000m2 w Rzeszowie oszacowana na łączną kwotę netto 13.0 mln PLN (średnio 6500 PLN/m2). Uwzględnia 10% korektę na region podkarpacki. Ryzyko wyceny wysokie (rezerwa 25%)."
}
`.trim();

// ── Główny Handler ────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
    console.log("==================================================");
    console.log("[Agent Parametryczny] === ROZPOCZĘTO WYCENĘ PARAMETRYCZNĄ ===");
    console.log("==================================================");

    try {
        const ai = new GoogleGenAI({
            vertexai: true,
            project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
            location: "global",
        });

        const body = await req.json();
        const { request, region = "Polska", projectContext = "" } = body;

        console.log(`[Agent Parametryczny] Region docelowy: "${region}"`);
        console.log(`[Agent Parametryczny] Dane wejściowe: "${request || projectContext}"`);

        const userPrompt = `
Wykonaj pełną wycenę parametryczną na podstawie poniższych danych:
Opis inwestycji: ${request || projectContext}
Lokalizacja (Województwo): ${region}

Wygeneruj 5 głównych sekcji kosztorysu ze scalonymi pozycjami w m2 powierzchni użytkowej.
        `.trim();

        console.log("[Agent Parametryczny] Wysyłam zapytanie do Gemini Pro...");
        const startTime = Date.now();

        const response = await ai.models.generateContent({
            model: MODEL_PRO,
            contents: [{ role: "user", parts: [{ text: userPrompt }] }],
            config: {
                systemInstruction: SYSTEM_INSTRUCTION,
                temperature: 0.1,
                maxOutputTokens: 4096,
                responseMimeType: "application/json",
            },
        });

        const rawText = response.text ?? "{}";
        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`[Agent Parametryczny] Odebrano wycenę w czasie ${duration}s. Parsowanie JSON...`);

        const parsed = JSON.parse(rawText);
        console.log(`[Agent Parametryczny] Wycena zakończona pomyślnie.`);
        console.log(`[Agent Parametryczny] Raport: ${parsed.parametricComment}`);

        console.log("==================================================");
        return NextResponse.json(parsed, { status: 200 });

    } catch (error: any) {
        console.error("[Agent Parametryczny] Krytyczny błąd podczas wyceny parametrycznej:", error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}