/**
 * PESAM – Agent 2: KNR Lookup (Normatywny)
 *
 * Ścieżka: src/app/api/kosztorysant/knr-lookup/route.ts
 *
 * Odpowiedzialność:
 *  - Przyjmuje polecenie, tryb pracy i opcjonalnie bieżącą strukturę kosztorysu.
 *  - Używa Gemini 2.5 Pro z włączonym Code Execution (Python) do:
 *      a) dopasowania kodów KNR/KNNR do pozycji robót,
 *      b) obliczenia ilości geometrycznych (kubatury, powierzchnie, m.b.),
 *      c) rozbicia nakładów na R (robocizna), M (materiały), S (sprzęt),
 *      d) wyceny bazowej wg cen 2025 (bez trendów – te nakłada Orkiestrator).
 *  - Zwraca { sections, narrativeHints } – nie liczy narzutów ani trendów.
 *
 * Ceny bazowe są CENAMI WYJŚCIOWYMI przed korektą rynkową.
 * Korekty (kp, zysk, trendy) celowo NIE są tu stosowane – to domena agentFinansowy
 * w Orkiestratorze, co gwarantuje deterministyczność obliczeń finansowych.
 */

import { GoogleGenAI } from "@google/genai";
import { NextRequest, NextResponse } from "next/server";
import {
  EstimateSection,
  KnrLookupRequest,
  KnrLookupResponse,
  extractAllJSONObjects,
} from "../_shared/types";

const ai = new GoogleGenAI({
  vertexai: true,
  project: process.env.GCP_PROJECT_ID!,
  location: "global",
});

const MODEL_PRO = "gemini-2.5-pro";

// ── Prompt systemowy – wiedza normatywna ──────────────────────────────────────

const SYSTEM_INSTRUCTION = `
Jesteś Agentem Normatywnym systemu PESAM – ekspertem od polskich norm kosztorysowych KNR i KNNR.

TWOJA BAZA WIEDZY KATALOGÓW (kluczowe dla wycen):
- KNR 2-01: Roboty ziemne (kopanie, transport urobku, umocnienia)
- KNR 2-02: Konstrukcje betonowe i żelbetowe (szalunki, zbrojenie, betonowanie)
- KNR 2-10: Roboty murowe (mury, bloczki, cegła, nadproża)
- KNR 2-17: Izolacje (przeciwwilgociowe, termiczne, akustyczne)
- KNR 2-18: Pokrycia dachowe (papa, membrana EPDM, dachówka, blacha)
- KNR 2-22: Tynki i okładziny (tynki maszynowe, gładzie, płytki)
- KNR 2-28: Stolarka budowlana (okna, drzwi, bramy)
- KNR 4-01: Instalacje elektryczne (WLZ, tablice, gniazda, oświetlenie)
- KNR 4-02: Instalacje sanitarne c.o., wod-kan (rury, grzejniki, armatura)
- KNR 5-01: Drogownictwo (podbudowy, nawierzchnie, krawężniki)
- KNNR 1:  Roboty rozbiórkowe (wyburzenia, demontaże)
- KNNR 6:  Roboty ziemne mechaniczne

ZASADY TWORZENIA POZYCJI:
1. Każda pozycja MUSI mieć realny kod KNR/KNNR w formacie "KNR X-XX XXXX-XX".
2. Typ pozycji:
   - "R" = Robocizna → jednostka r-g (roboczogodziny), cena = stawka r-g (PLN/r-g)
   - "M" = Materiał  → jednostka właściwa (m³, m², kg, szt., mb), cena = cena hurtowa netto 2025
   - "S" = Sprzęt    → jednostka m-g lub kurs, cena = koszt pracy sprzętu/jednostkę
3. Ceny bazowe to CENY NETTO 2025 BEZ TRENDÓW, korekt ani narzutów:
   - Robocizna budowlana: 38–52 PLN/r-g (śr. 44 PLN)
   - Beton C25/30: 380–420 PLN/m³
   - Stal B500SP: 3,90–4,50 PLN/kg
   - Bloczek silikatowy 18 cm: 8–11 PLN/szt.
   - Gazobeton 24 cm (Ytong): 12–16 PLN/szt.
   - Membrana EPDM: 28–38 PLN/m²
   - Papa termozgrzewalna: 18–26 PLN/m²
   - Płytki ceramiczne (śr.): 55–90 PLN/m²
   - Koparka kołowa (m-g): 180–260 PLN/m-g
   - Transport wywrotką (kurs 10 km): 120–180 PLN/kurs
4. Ilości muszą być REALISTYCZNE i spójne z zakresem projektu:
   - Przelicz kubatury geometryczne dokładnie (użyj Code Execution dla złożonych geometrii).
   - Do materiałów dolictz straty technologiczne: beton +3%, stal +5%, płytki +10%, tynki +8%.
5. Zachowaj logiczny podział na działy (sekcje) zgodny z branżami lub etapami budowy.

UŻYCIE CODE EXECUTION:
- Użyj Pythona do weryfikacji i obliczenia ilości geometrycznych (kubatura wykopu,
  powierzchnia dachu, ciężar zbrojenia, itp.) zanim zwrócisz wynik JSON.
- Przykład: dla stropu żelbetowego 200m² × 0,20m = 40m³ betonu, zbrojenie ≈ 100kg/m³ = 4000kg.
- Nie ujawniaj kodu Pythona w finalnym JSON – tylko używaj go do obliczeń.

FORMAT ODPOWIEDZI:
Odpowiedz WYŁĄCZNIE poprawnym obiektem JSON (bez markdown, bez komentarzy):
{
  "sections": [
    {
      "id": "sec-1",
      "name": "Dział 1. Nazwa działu robót",
      "items": [
        {
          "id": "item-1-1",
          "code": "KNR 2-01 0210-02",
          "name": "Pełna opisowa nazwa pozycji kosztorysowej zgodna z KNR",
          "type": "R",
          "quantity": 120.5,
          "unit": "r-g",
          "basePrice": 44.00,
          "unitPrice": 44.00
        }
      ]
    }
  ],
  "narrativeHints": "2-3 zdania: kluczowe informacje techniczne dla Kosztorysanta (ryzyka techniczne, alternatywy materiałowe, uwagi do norm)."
}
`.trim();

// ── Handler ───────────────────────────────────────────────────────────────────

export async function POST(
  req: NextRequest
): Promise<NextResponse<KnrLookupResponse>> {
  try {
    const body: KnrLookupRequest = await req.json();
    const { request, currentTrends, mode, currentSections } = body;

    if (!request?.trim()) {
      return NextResponse.json(
        {
          sections: currentSections ?? [],
          narrativeHints: "Brak polecenia – proszę podać zakres robót.",
        },
        { status: 400 }
      );
    }

    // Kontekst bieżącego kosztorysu (jeśli modyfikujemy istniejący)
    const contextBlock = currentSections?.length
      ? `\n\nBIEŻĄCA STRUKTURA KOSZTORYSU DO MODYFIKACJI:\n${JSON.stringify(
          currentSections,
          null,
          2
        )}`
      : "";

    // Kontekst parametrów wyceny (informacyjnie – nie stosuj ich tutaj)
    const trendsBlock = `
PARAMETRY WYCENY (TYLKO DO INFORMACJI – nie stosuj ich w cenach bazowych):
- Korekta robocizny: ${currentTrends.laborAdjustment}%
- Korekta materiałów: ${currentTrends.materialAdjustment}%
- Korekta sprzętu: ${currentTrends.equipmentAdjustment}%
- Koszty pośrednie Kp: ${currentTrends.kp}%
- Zysk Z: ${currentTrends.zysk}%
Podaj WYŁĄCZNIE ceny bazowe 2025 bez powyższych korekt.`.trim();

    const userPrompt = `
TRYB PRACY: ${mode}
POLECENIE KOSZTORYSANTA: "${request.trim()}"

${trendsBlock}
${contextBlock}
`.trim();

    const response = await ai.models.generateContent({
      model: MODEL_PRO,
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        temperature: 0.1,
        tools: [{ codeExecution: {} }], // Python do obliczeń geometrycznych
      },
    });

    // Wyciągamy ostatni (najdokładniejszy) obiekt JSON z odpowiedzi
    const rawText = response.text ?? "";
    const extracted = extractAllJSONObjects(rawText) as Array<{
      sections?: EstimateSection[];
      narrativeHints?: string;
    }>;

    if (extracted.length > 0) {
      const parsed = extracted[extracted.length - 1];
      const sections = parsed.sections ?? [];
      const narrativeHints =
        parsed.narrativeHints ??
        "Struktura kosztorysu zaktualizowana. Proszę zweryfikować ilości.";

      return NextResponse.json({ sections, narrativeHints });
    }

    // Fallback gdy AI nie zwróciło parsowanego JSON
    console.warn("[KNR Lookup] Nie udało się sparsować JSON z odpowiedzi AI.");
    return NextResponse.json({
      sections: currentSections ?? [],
      narrativeHints:
        "Nie udało się przetworzyć odpowiedzi AI. Proszę spróbować ponownie z bardziej precyzyjnym poleceniem.",
    });
  } catch (error) {
    console.error("[KNR Lookup] Błąd agenta normatywnego:", error);
    const msg =
      error instanceof Error ? error.message : "Nieznany błąd agenta KNR.";

    return NextResponse.json(
      {
        sections: [],
        narrativeHints: `⚠️ Błąd Agenta Normatywnego: ${msg}`,
      },
      { status: 500 }
    );
  }
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({
    service: "PESAM KNR Lookup (Normatywny)",
    model: MODEL_PRO,
    tools: ["codeExecution (Python)"],
    responsibility:
      "KNR/KNNR code matching, quantity calculation, RMS decomposition",
    catalogs: [
      "KNR 2-01",
      "KNR 2-02",
      "KNR 2-10",
      "KNR 2-17",
      "KNR 2-18",
      "KNR 2-22",
      "KNR 2-28",
      "KNR 4-01",
      "KNR 4-02",
      "KNR 5-01",
      "KNNR 1",
      "KNNR 6",
    ],
  });
}