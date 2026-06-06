/**
 * PESAM – Agent 2: KNR Lookup (Normatywny) - WERSJA DWUETAPOWA (Fix #6)
 *
 * Ścieżka: src/app/api/kosztorysant/knr-lookup/route.ts
 *
 * Odpowiedzialność:
 *  - ETAP 1: Używa Gemini 2.5 Pro z Code Execution (Python) do precyzyjnego obliczenia ilości geometrycznych.
 *  - ETAP 2: Używa Gemini 2.5 Pro (bez Pythona, z wymuszonym JSON) do wygenerowania czystej struktury kosztorysu.
 */

import { GoogleGenAI } from "@google/genai";
import { NextRequest, NextResponse } from "next/server";
import {
  EstimateSection,
  KnrLookupRequest,
  KnrLookupResponse,
  extractAllJSONObjects,
} from "../_shared/types";

export const dynamic = "force-dynamic";

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
   - Do materiałów dolicz straty technologiczne: beton +3%, stal +5%, płytki +10%, tynki +8%.
5. Zachowaj logiczny podział na działy (sekcje) zgodny z branżami lub etapami budowy.

FORMAT ODPOWIEDZI (Dla Etapu 2):
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
  "narrativeHints": "2-3 zdania: kluczowe informacje techniczne dla Kosztorysanta."
}
`.trim();

// ── Handler ───────────────────────────────────────────────────────────────────

export async function POST(
  req: NextRequest
): Promise<NextResponse<KnrLookupResponse>> {
  console.log("==================================================");
  console.log("[KNR Lookup] === ROZPOCZĘTO WYSZUKIWANIE NORM (DWUETAPOWE) ===");
  console.log("==================================================");

  try {
    const ai = new GoogleGenAI({
      vertexai: true,
      project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
      location: "global",
    });

    const body: KnrLookupRequest = await req.json();
    const { request, currentTrends, mode, currentSections } = body;

    if (!request?.trim()) {
      console.warn("[KNR Lookup] Brak polecenia w żądaniu.");
      return NextResponse.json(
        {
          sections: currentSections ?? [],
          narrativeHints: "Brak polecenia – proszę podać zakres robót.",
        },
        { status: 400 }
      );
    }

    console.log(`[KNR Lookup] Tryb: ${mode} | Polecenie: "${request.substring(0, 50)}..."`);

    // Kontekst bieżącego kosztorysu
    const contextBlock = currentSections?.length
      ? `\n\nBIEŻĄCA STRUKTURA KOSZTORYSU DO MODYFIKACJI:\n${JSON.stringify(currentSections, null, 2)}`
      : "";

    const trendsBlock = `
PARAMETRY WYCENY (TYLKO DO INFORMACJI – nie stosuj ich w cenach bazowych):
- Korekta robocizny: ${currentTrends.laborAdjustment}%
- Korekta materiałów: ${currentTrends.materialAdjustment}%
- Korekta sprzętu: ${currentTrends.equipmentAdjustment}%
Podaj WYŁĄCZNIE ceny bazowe 2025 bez powyższych korekt.`.trim();

    const userPrompt = `
TRYB PRACY: ${mode}
POLECENIE KOSZTORYSANTA: "${request.trim()}"

${trendsBlock}
${contextBlock}
`.trim();

    // ════════════════════════════════════════════════════════════════════════
    // ETAP 1: OBLICZENIA PYTHON (CODE EXECUTION)
    // ════════════════════════════════════════════════════════════════════════
    console.log("[KNR Lookup] ETAP 1: Uruchamiam Code Execution (Python) do obliczeń geometrycznych...");

    const calcPrompt = `
${userPrompt}

ZADANIE: Oblicz TYLKO ilości geometryczne dla pozycji kosztorysowych.
Użyj Pythona do obliczeń (np. objętości, powierzchni, ciężaru zbrojenia).
Na końcu wypisz TYLKO jedną linię w formacie:
WYNIKI: {"wykop_m3": 450, "beton_fundamenty_m3": 85, "stal_kg": 12500}
Nie generuj JSON kosztorysu – tylko liczby.
    `.trim();

    const calcResponse = await ai.models.generateContent({
      model: MODEL_PRO,
      contents: [{ role: "user", parts: [{ text: calcPrompt }] }],
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        temperature: 0.1,
        tools: [{ codeExecution: {} }], // Włączamy Pythona
        // Brak responseMimeType, aby Python mógł swobodnie działać
      },
    });

    const calcText = calcResponse.text ?? "";
    console.log(`[KNR Lookup] Odpowiedź z Pythona odebrana (${calcText.length} znaków). Szukam bloku WYNIKI...`);

    const wynikiMatch = calcText.match(/WYNIKI:\s*(\{[^}]+\})/);
    let obliczone = {};

    if (wynikiMatch) {
      try {
        obliczone = JSON.parse(wynikiMatch[1]);
        console.log(`[KNR Lookup] Sukces! Wyekstrahowane obliczenia z Pythona:`, obliczone);
      } catch (e) {
        console.warn(`[KNR Lookup] Błąd parsowania wyników z Pythona: ${wynikiMatch[1]}`);
      }
    } else {
      console.warn(`[KNR Lookup] Ostrzeżenie: Model nie zwrócił bloku WYNIKI. Przechodzę do Etapu 2 bez precyzyjnych obliczeń.`);
    }

    // ════════════════════════════════════════════════════════════════════════
    // ETAP 2: GENEROWANIE CZYSTEGO JSON KOSZTORYSU
    // ════════════════════════════════════════════════════════════════════════
    console.log("[KNR Lookup] ETAP 2: Generowanie czystego JSON kosztorysu na bazie obliczeń...");

    const jsonPrompt = `
${userPrompt}

OBLICZONE ILOŚCI (zweryfikowane przez Python w poprzednim kroku):
${JSON.stringify(obliczone, null, 2)}

Użyj tych dokładnych ilości. Wygeneruj pełny kosztorys w formacie JSON.
Pamiętaj o zachowaniu struktury: sections -> items.
    `.trim();

    const jsonResponse = await ai.models.generateContent({
      model: MODEL_PRO,
      contents: [{ role: "user", parts: [{ text: jsonPrompt }] }],
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        temperature: 0.1,
        responseMimeType: "application/json", // Wymuszamy czysty JSON (bez Pythona)
      },
    });

    const rawText = jsonResponse.text ?? "";
    console.log(`[KNR Lookup] Odebrano finalny JSON (${rawText.length} znaków). Parsowanie...`);

    const extracted = extractAllJSONObjects(rawText) as Array<{
      sections?: EstimateSection[];
      narrativeHints?: string;
    }>;

    if (extracted.length > 0) {
      const parsed = extracted[extracted.length - 1];
      const sections = parsed.sections ?? [];
      const narrativeHints = parsed.narrativeHints ?? "Struktura kosztorysu zaktualizowana. Proszę zweryfikować ilości.";

      console.log(`[KNR Lookup] Sukces. Wygenerowano ${sections.length} sekcji.`);
      console.log("==================================================");
      return NextResponse.json({ sections, narrativeHints });
    }

    // Fallback gdy AI nie zwróciło parsowanego JSON
    console.warn("[KNR Lookup] Nie udało się sparsować JSON z odpowiedzi AI w Etapie 2.");
    return NextResponse.json({
      sections: currentSections ?? [],
      narrativeHints: "Nie udało się przetworzyć odpowiedzi AI. Proszę spróbować ponownie z bardziej precyzyjnym poleceniem.",
    });

  } catch (error) {
    console.error("[KNR Lookup] Krytyczny błąd agenta normatywnego:", error);
    const msg = error instanceof Error ? error.message : "Nieznany błąd agenta KNR.";

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
    service: "PESAM KNR Lookup (Normatywny - Dwuetapowy)",
    model: MODEL_PRO,
    tools: ["codeExecution (Python) - Stage 1", "JSON Schema - Stage 2"],
    responsibility: "KNR/KNNR code matching, quantity calculation, RMS decomposition",
  });
}