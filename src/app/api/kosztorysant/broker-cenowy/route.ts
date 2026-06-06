// src/app/api/kosztorysant/market-pricing/route.ts
import { GoogleGenAI } from "@google/genai";
import { NextRequest, NextResponse } from "next/server";
import {
  EstimateSection,
  extractAllJSONObjects,
} from "../_shared/types";

export const dynamic = "force-dynamic";

// Używamy Gemini 3.5 Flash - jest niesamowicie szybki i wybitnie obsługuje narzędzie wyszukiwarki Google
const MODEL_FLASH = "gemini-3.5-flash"; 

const SYSTEM_INSTRUCTION = `
  Jesteś Ekspertem ds. Wyceny Rynkowej i Analizy Cenowej (Agent Rynku) w systemie PESAM.
  Twoim zadaniem jest zweryfikowanie szacunkowych cen bazowych w kosztorysie i nadpisanie ich rzeczywistymi, aktualnymi cenami rynkowymi netto dla podanej lokalizacji.

  ZASADY WYCENY:
  1. UŻYJ NARZĘDZIA GOOGLE SEARCH (Wyszukiwarka Google), aby znaleźć aktualne (na rok 2026) ceny hurtowe netto materiałów budowlanych oraz stawki roboczogodzin w podanym regionie Polski.
  2. Dla każdej pozycji w kosztorysie zidentyfikuj realną stawkę rynkową netto.
  3. Nadpisz pola 'basePrice' i 'unitPrice' nowo wyszukanymi, rzeczywistymi cenami rynkowymi netto.
  4. Nie zmieniaj ilości ('quantity'), jednostek ('unit'), kodów ani struktur działów. Zmieniasz TYLKO ceny na rzeczywiste rynkowe.

  Zwróć DOKŁADNIE JEDEN obiekt JSON (bez markdown, bez komentarzy, bez tekstu poza JSON):
  {
    "sections": [
      {
        "id": "sec-X",
        "name": "Dział X...",
        "items": [
          {
            "id": "item-X-Y",
            "code": "KNR...",
            "name": "...",
            "type": "M",
            "quantity": 100,
            "unit": "m³",
            "basePrice": rzeczywista_cena_netto_pobrana_z_google_search,
            "unitPrice": rzeczywista_cena_netto_pobrana_z_google_search
          }
        ]
      }
    ],
    "marketInsights": "Krótkie podsumowanie (2-3 zdania) o tym, jakie ceny rynkowe i u jakich dystrybutorów/hurtowni w tym regionie zweryfikowałeś za pomocą wyszukiwarki Google."
  }
`.trim();

export async function POST(req: NextRequest) {
  try {
    const ai = new GoogleGenAI({
      vertexai: true,
      project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
      location: "global",
    });

    const { sections, location } = await req.json();

    if (!sections || !Array.isArray(sections)) {
      return NextResponse.json({ error: "Brak struktury kosztorysu w żądaniu." }, { status: 400 });
    }

    const userPrompt = `
      Lokalizacja inwestycji: ${location || "Polska, województwo podlaskie"}.
      Zweryfikuj i zaktualizuj ceny dla poniższego kosztorysu przedmiarowego:
      ${JSON.stringify(sections, null, 2)}
    `;

    const response = await ai.models.generateContent({
      model: MODEL_FLASH,
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        temperature: 0.1,
        // WŁĄCZENIE GOOGLE SEARCH GROUNDING - Model będzie aktywnie przeszukiwał polski internet!
        tools: [{ googleSearch: {} }],
        responseMimeType: "application/json",
      },
    });

    const rawText = response.text ?? "";
    const extracted = extractAllJSONObjects(rawText) as Array<{
      sections?: EstimateSection[];
      marketInsights?: string;
    }>;

    if (extracted.length > 0) {
      const parsed = extracted[extracted.length - 1];
      return NextResponse.json({
        sections: parsed.sections || sections,
        marketInsights: parsed.marketInsights || "Ceny zostały zaktualizowane na podstawie standardowych stawek rynkowych."
      }, { status: 200 });
    }

    return NextResponse.json({ sections, marketInsights: "Wycena rynkowa niedostępna – zachowano ceny szacunkowe." });
  } catch (err: any) {
    console.error("[Market Pricing Agent] Błąd:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}