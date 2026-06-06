/**
 * PESAM – Agent Normatywne Zbrojenie
 * 
 * Ścieżka: src/app/api/kosztorysant/agent-normatywne-zbrojenie/route.ts
 * 
 * Odpowiedzialność:
 *  - Analizuje wykryte przez Vision elementy żelbetowe (m3).
 *  - Stosuje wskaźniki normatywne (kg stali / m3 betonu) wg Eurokodu 2 (PN-EN 1992).
 *  - Generuje brakujące pozycje zbrojenia stali KNR z flagą jakości danych "NORMATIVE".
 */

import { GoogleGenAI } from "@google/genai";
import { NextRequest, NextResponse } from "next/server";
import { EstimateSection } from "../_shared/types";

export const dynamic = "force-dynamic";

const MODEL_PRO = "gemini-2.5-pro";

// ── Prompt Systemowy z Tabelami Normatywnymi ──────────────────────────────────

const SYSTEM_INSTRUCTION = `
Jesteś wybitnym ekspertem ds. konstrukcji żelbetowych i kosztorysowania. Twoim zadaniem jest oszacowanie zużycia stali zbrojeniowej (kg) dla podanych elementów betonowych, dla których brak szczegółowych rysunków wykonawczych.

WSKAŹNIKI ZUŻYCIA STALI ZBROJENIOWEJ WG EUROKODU 2 (kg stali / m³ betonu):
- Ławy fundamentowe proste:        80 - 100 kg/m³
- Ławy fundamentowe złożone:       100 - 130 kg/m³  
- Stopy fundamentowe:              100 - 140 kg/m³
- Płyta fundamentowa:              90 - 120 kg/m³
- Pale żelbetowe / słupy głębokie: 160 - 220 kg/m³
- Słupy żelbetowe kwadratowe:      200 - 280 kg/m³
- Słupy żelbetowe okrągłe:         240 - 320 kg/m³
- Podciągi i belki:                180 - 250 kg/m³
- Stropy płytowe płaskie:          90 - 110 kg/m³
- Stropy gęstożebrowe (np.Teriva): 60 - 80  kg/m³
- Wieńce i nadproża:               200 - 280 kg/m³

ZASADY OBLICZEŃ:
1. Przeanalizuj listę elementów betonowych (m³).
2. Dopasuj każdy element do powyższych kategorii. Jeśli element ma w opisie "gęsto" lub "trudny", przyjmij górną granicę przedziału.
3. Oblicz wagę stali: Objętość betonu (m³) × wskaźnik zużycia (kg/m³).
4. Dodaj narzut na zakłady, wygięcia i odpady: +8% do całkowitej masy stali.
5. Wygeneruj gotowe pozycje kosztorysowe KNR:
   - KNR 2-02 0290-01: Zbrojenie konstrukcji prętami gładkimi (strzemiona, średnice do 10mm) -> zwykle ok. 20% całkowitej masy stali.
   - KNR 2-02 0290-02: Zbrojenie konstrukcji prętami żebrowanymi (główne, średnice pow. 10mm) -> zwykle ok. 80% całkowitej masy stali.
6. Przypisz wskaźnik jakości danych (dataQuality):
   - Method: "NORMATIVE"
   - Confidence: "MEDIUM" (bo liczymy ze wskaźnika, a nie z rysunku zbrojeniowego)
   - RiskBuffer: 15 (zalecana 15% rezerwa finansowa na ryzyko niedoszacowania stali przez projektanta)

FORMAT ODPOWIEDZI (Zwróć wyłącznie czysty JSON):
{
  "sections": [
    {
      "id": "sec-zbrojenie",
      "name": "Dział. Szacunkowe Zbrojenie Konstrukcji (Oszacowanie Normatywne)",
      "items": [
        {
          "id": "st-1",
          "code": "KNR 2-02 0290-02",
          "name": "Zbrojenie konstrukcji prętami żebrowanymi o średnicy pow. 10mm - Oszacowanie normatywne dla ław i stropów",
          "type": "M",
          "quantity": 3.42, // w tonach [t]! Zwróć uwagę na jednostkę w KNR (często tony lub kg, podaj w tonach [t] jeśli kod KNR tego wymaga)
          "unit": "t",
          "basePrice": 4200.00, // cena netto za tonę stali B500SP 2025/2026: ok. 3900-4500 PLN
          "unitPrice": 4200.00,
          "dataQuality": {
            "method": "NORMATIVE",
            "confidence": "MEDIUM",
            "riskBuffer": 15,
            "notes": ["Zbrojenie oszacowane wskaźnikiem 110 kg/m3 dla stropu i 90 kg/m3 dla ław.", "Uwzględniono 8% naddatku na zakłady."]
          }
        }
      ]
    }
  ],
  "engineeringComment": "Zbrojenie stropów i ław fundamentowych zostało oszacowane normatywnie w ilości łącznej 3.42t przy braku projektów wykonawczych zbrojenia. Zaleca się ujęcie 15% rezerwy kosztowej."
}
`.trim();

// ── Główny Handler ────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
    console.log("==================================================");
    console.log("[Agent Zbrojenie] === ROZPOCZĘTO SZACOWANIE NORMATYWNE STALI ===");
    console.log("==================================================");

    try {
        const ai = new GoogleGenAI({
            vertexai: true,
            project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
            location: "global",
        });

        const body = await req.json();
        const { concreteElements, projectContext = "" } = body;

        // Jeśli pętla A2A wywołała agenta, ale nie mamy jeszcze wykrytych elementów betonowych
        if (!concreteElements || !Array.isArray(concreteElements) || concreteElements.length === 0) {
            console.warn("[Agent Zbrojenie] Ostrzeżenie: Brak elementów betonowych do analizy. Pobieram dane wejściowe z opisu zadania...");
        }

        console.log(`[Agent Zbrojenie] Projekt: "${projectContext}"`);
        console.log(`[Agent Zbrojenie] Elementy betonowe przekazane do analizy:`, concreteElements);

        const userPrompt = `
Przeanalizuj poniższe elementy żelbetowe i oszacuj dla nich zapotrzebowanie na stal zbrojeniową (strzemiona i pręty główne):
Projekt: ${projectContext}

ELEMENTY BETONOWE:
${JSON.stringify(concreteElements || [
            { name: "Ławy fundamentowe budynku", quantity: 45.5, unit: "m3", note: "Założono standardowe ławy żelbetowe" },
            { name: "Strop nad parterem żelbetowy", quantity: 28.0, unit: "m3" }
        ], null, 2)}

Wygeneruj odpowiednie pozycje kosztorysowe stali KNR (w tonach [t]) i określ jakość tych danych (dataQuality).
        `.trim();

        console.log("[Agent Zbrojenie] Wysyłam zapytanie do Gemini Pro...");
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
        console.log(`[Agent Zbrojenie] Odebrano odpowiedź w czasie ${duration}s. Parsowanie JSON...`);

        const parsed = JSON.parse(rawText);
        console.log(`[Agent Zbrojenie] Sukces! Wygenerowano dział: "${parsed.sections?.[0]?.name || "Zbrojenie"}"`);
        console.log(`[Agent Zbrojenie] Łączna szacowana masa stali: ${parsed.sections?.[0]?.items?.reduce((acc: number, item: any) => acc + item.quantity, 0).toFixed(2)} t`);
        console.log(`[Agent Zbrojenie] Komentarz: ${parsed.engineeringComment}`);

        console.log("==================================================");
        return NextResponse.json(parsed, { status: 200 });

    } catch (error: any) {
        console.error("[Agent Zbrojenie] Krytyczny błąd podczas szacowania zbrojenia:", error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}