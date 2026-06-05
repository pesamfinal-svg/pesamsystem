/**
 * PESAM – Orkiestrator: RMS Engine
 *
 * Ścieżka: src/app/api/kosztorysant/rms-engine/route.ts
 *
 * Ten plik jest JEDYNYM punktem wejścia wywoływanym przez frontend.
 *
 * Pipeline orkiestracji:
 *  A. Dispatcher  → GET /api/kosztorysant/dispatcher      (Gemini Flash)
 *     Klasyfikuje intencję (AgentMode).
 *
 *  B. KNR Lookup  → GET /api/kosztorysant/knr-lookup      (Gemini Pro + Python)
 *     Uruchamiany TYLKO dla trybów kalkulacyjnych.
 *     Zwraca strukturę EstimateSection[] z cenami bazowymi.
 *
 *  C. agentRyzyka (wbudowany, Gemini Flash)
 *     Uruchamiany TYLKO dla RISK_ANALYSIS.
 *     Zwraca tablicę alertów prawno-przetargowych.
 *
 *  D. agentFinansowy (wbudowany, Pure TypeScript – DETERMINISTYCZNY)
 *     Zawsze uruchamiany na wynikach z B.
 *     Nakłada trendy rynkowe (suwaki) oraz narzuty Kp i Z.
 *     Zero AI – zero ryzyka błędu matematycznego na kwotach wielomilionowych.
 *
 *  E. agentRedaktor (wbudowany, Gemini Pro)
 *     Zawsze uruchamiany jako ostatni.
 *     Syntetyzuje wyniki w 4-6 zdań dla Kosztorysanta.
 *
 * Zwraca: { reply, generatedSections?, riskAlerts? }
 */

import { GoogleGenAI } from "@google/genai";
import { NextRequest, NextResponse } from "next/server";
import {
  AgentMode,
  EstimateSection,
  MarketTrends,
  RmsEngineRequest,
  RmsEngineResponse,
  DispatcherResponse,
  KnrLookupRequest,
  KnrLookupResponse,
  extractAllJSONObjects,
} from "../_shared/types";

// ── Klient AI (używany przez agentów wbudowanych w Orkiestratora) ─────────────

export const dynamic = "force-dynamic";

const MODEL_PRO   = "gemini-2.5-pro";
const MODEL_FLASH = "gemini-3.5-flash";

// ── Helper: wywołania wewnętrzne ──────────────────────────────────────────────

/**
 * Buduje bezwzględny URL do endpointu wewnętrznego na podstawie bieżącego żądania.
 * Działa zarówno na localhost jak i na produkcji (Vercel, Cloud Run, itp.).
 */
function internalUrl(req: NextRequest, path: string): string {
  const origin = new URL(req.url).origin;
  return `${origin}${path}`;
}

// ── Agent C: Ryzyka (wbudowany w Orkiestratora) ───────────────────────────────

async function agentRyzyka(request: string): Promise<string[]> {
  const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
    location: "global",
  });
  const systemInstruction = `
Jesteś Prawnikiem Kontraktowym specjalizującym się w polskim Prawie Zamówień
Publicznych (PZP, Dz.U. 2019 poz. 2019 ze zm.) oraz w budownictwie kubaturowym
i infrastrukturalnym.

Wygeneruj listę 3-5 konkretnych, krótkich alertów ryzykownych dotyczących
podanego polecenia lub kontekstu przetargu.

Format każdego alertu (jedno zdanie):
- "⚠️ UWAGA: [opis ryzyka]"   – ryzyko wymagające uwagi
- "❗ RYZYKO: [opis ryzyka]"   – ryzyko wysokie / bloker
- "✅ OK: [potwierdzenie]"     – kwestia zgodna z PZP / standardem

Odpowiedz WYŁĄCZNIE jako tablica JSON stringów. Brak markdown, brak komentarzy.
Przykład: ["⚠️ UWAGA: Kara umowna 10 000 zł/dzień przekracza standard rynkowy.", "✅ OK: Termin 18 miesięcy jest wykonalny dla tego zakresu."]
`.trim();

  try {
    const response = await ai.models.generateContent({
      model: MODEL_FLASH,
      contents: [{ role: "user", parts: [{ text: request.trim() }] }],
      config: {
        systemInstruction,
        temperature: 0.2,
        maxOutputTokens: 512,
      },
    });

    const raw = response.text ?? "";

    // Szukamy tablicy JSON (nie obiektu)
    const arrayMatch = raw.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      try {
        const parsed = JSON.parse(arrayMatch[0]);
        if (Array.isArray(parsed)) return parsed as string[];
      } catch {
        // Przejdź do fallback
      }
    }

    // Fallback: extractAllJSONObjects szuka obiektów; tablice wymagają osobnego patcha
    const objects = extractAllJSONObjects(raw);
    if (objects.length > 0 && Array.isArray(objects[objects.length - 1])) {
      return objects[objects.length - 1] as string[];
    }
  } catch (error) {
    console.error("[RMS Engine / agentRyzyka] Błąd:", error);
  }

  return [
    "⚠️ UWAGA: Analiza ryzyk niedostępna – proszę zweryfikować dokumenty przetargowe ręcznie.",
  ];
}

// ── Agent D: Finansowy (wbudowany, Pure TypeScript) ───────────────────────────

interface FinancialSummary {
  totalBase: number;
  totalAfterTrends: number;
  totalWithMarkups: number;
  byType: { R: number; M: number; S: number };
}

/**
 * Deterministyczny silnik finansowy – zero AI, zero ryzyka błędu zaokrągleń.
 *
 * Algorytm zgodny z metodologią KNR:
 *   1. Cena bazowa × korekta trendu rynkowego = cena po korekcie
 *   2. Koszt bezpośredni = ilość × cena po korekcie
 *   3. Dla R i S: dolicz Kp (% od kosztu bezpośredniego) i Z (% od kosztu + Kp)
 *   4. Dla M: brak Kp i Z (materiały wchodzą do ceny ofertowej bez narzutów)
 */
function agentFinansowy(
  sections: EstimateSection[],
  trends: MarketTrends
): FinancialSummary {
  let totalBase = 0;
  let totalAfterTrends = 0;
  let totalWithMarkups = 0;
  const byType = { R: 0, M: 0, S: 0 };

  const kpFactor = trends.kp / 100;
  const zFactor  = trends.zysk / 100;

  for (const sec of sections) {
    for (const item of sec.items) {
      // Koszt bazowy (przed jakimkolwiek dostosowaniem)
      const base = item.quantity * item.basePrice;
      totalBase += base;
      byType[item.type] += base;

      // Korekta trendu rynkowego z suwaka
      let adjustedPrice = item.basePrice;
      switch (item.type) {
        case "R":
          adjustedPrice *= 1 + trends.laborAdjustment    / 100;
          break;
        case "M":
          adjustedPrice *= 1 + trends.materialAdjustment / 100;
          break;
        case "S":
          adjustedPrice *= 1 + trends.equipmentAdjustment / 100;
          break;
      }

      const directCost = item.quantity * adjustedPrice;
      totalAfterTrends += directCost;

      // Narzuty kosztorysowe KNR: Kp i Z tylko na R i S
      if (item.type === "R" || item.type === "S") {
        const kpVal = directCost * kpFactor;
        const zVal  = (directCost + kpVal) * zFactor;
        totalWithMarkups += directCost + kpVal + zVal;
      } else {
        // Materiały: brak narzutów – cena po korekcie trendu to cena ofertowa
        totalWithMarkups += directCost;
      }
    }
  }

  return { totalBase, totalAfterTrends, totalWithMarkups, byType };
}

// ── Agent E: Redaktor (wbudowany, Gemini Pro) ─────────────────────────────────

async function agentRedaktor(
  request: string,
  mode: AgentMode,
  financial: FinancialSummary,
  narrativeHints: string,
  riskAlerts: string[],
  trends: MarketTrends
): Promise<string> {
  const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
    location: "global",
  });
  const systemInstruction = `
Jesteś Głównym Inżynierem Kontraktu w systemie PESAM. Przemawiasz bezpośrednio
do Głównego Kosztorysanta – doświadczonego eksperta budowlanego znającego branżę.

ZASADY:
- Używaj profesjonalnej terminologii budowlanej i kosztorysowej.
- Odpowiadaj zwięźle: 4-6 zdań maksimum.
- Podawaj konkretne liczby z podsumowania finansowego.
- Wskaż 1-2 najważniejsze kwestie wymagające uwagi Kosztorysanta.
- NIE opisuj szczegółowo zawartości tabeli RMS – Kosztorysant ją widzi.
- NIE tłumacz co to jest Kp ani zysk – to ekspert.
- Jeśli są alerty ryzyk, wymień najważniejszy jednym zdaniem.
`.trim();

  const userPrompt = `
OPERACJA: ${mode}
POLECENIE: "${request.trim()}"

PODSUMOWANIE FINANSOWE:
- Koszt bazowy (bez korekt):          ${Math.round(financial.totalBase).toLocaleString("pl-PL")} PLN
- Po korekcie trendów rynkowych:      ${Math.round(financial.totalAfterTrends).toLocaleString("pl-PL")} PLN
- Cena ofertowa (Kp ${trends.kp}%, Z ${trends.zysk}%): ${Math.round(financial.totalWithMarkups).toLocaleString("pl-PL")} PLN
- Struktura kosztów: R=${Math.round(financial.byType.R).toLocaleString("pl-PL")} PLN | M=${Math.round(financial.byType.M).toLocaleString("pl-PL")} PLN | S=${Math.round(financial.byType.S).toLocaleString("pl-PL")} PLN

WSKAZÓWKI AGENTA NORMATYWNEGO: "${narrativeHints}"
ALERTY RYZYK: ${riskAlerts.length > 0 ? riskAlerts.join(" | ") : "brak alertów"}
`.trim();

  try {
    const response = await ai.models.generateContent({
      model: MODEL_PRO,
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      config: {
        systemInstruction,
        temperature: 0.3,
        maxOutputTokens: 512,
      },
    });

    return response.text?.trim() ?? "Kosztorys został zaktualizowany pomyślnie.";
  } catch (error) {
    console.error("[RMS Engine / agentRedaktor] Błąd:", error);
    return `Kosztorys zaktualizowany. Cena ofertowa: ${Math.round(financial.totalWithMarkups).toLocaleString("pl-PL")} PLN.`;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// GŁÓWNY HANDLER – Orkiestracja pipeline'u
// ══════════════════════════════════════════════════════════════════════════════

export async function POST(
  req: NextRequest
): Promise<NextResponse<RmsEngineResponse>> {
  try {
    const ai = new GoogleGenAI({
      vertexai: true,
      project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
      location: "global",
    });

    const body: RmsEngineRequest = await req.json();
    const { request, currentTrends, currentSections } = body;

    if (!request?.trim()) {
      return NextResponse.json(
        { reply: "Proszę podać polecenie dla Agenta Wyceny." },
        { status: 400 }
      );
    }

    // ── A. DISPATCHER: klasyfikacja intencji ──────────────────────────────────

    let mode: AgentMode = "GENERAL_QUERY";

    try {
      const dispatcherRes = await fetch(
        internalUrl(req, "/api/kosztorysant/dispatcher"),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ request }),
        }
      );

      if (dispatcherRes.ok) {
        const dispatcherData: DispatcherResponse = await dispatcherRes.json();
        mode = dispatcherData.intent;
      } else {
        console.warn("[RMS Engine] Dispatcher zwrócił błąd HTTP, fallback: GENERAL_QUERY");
      }
    } catch (err) {
      console.error("[RMS Engine] Błąd wywołania Dispatchera:", err);
      // Kontynuuj z GENERAL_QUERY – nie przerywamy pipeline'u
    }

    // ── B/C. ROUTING na podstawie intencji ────────────────────────────────────

    let sections: EstimateSection[] = currentSections ?? [];
    let narrativeHints = "";
    let riskAlerts: string[] = [];

    const isCalculationMode =
      mode === "GENERATE_FROM_SCRATCH" ||
      mode === "MODIFY_TECHNOLOGY"     ||
      mode === "RECALCULATE_DIVISION";

    if (mode === "RISK_ANALYSIS") {
      // ── C. Tryb RISK: wywołaj wbudowanego agenta ryzyk ──────────────────────
      riskAlerts = await agentRyzyka(request);

    } else if (isCalculationMode) {
      // ── B. Tryb kalkulacyjny: wywołaj KNR Lookup ───────────────────────────
      try {
        const knrPayload: KnrLookupRequest = {
          request,
          currentTrends,
          mode,
          currentSections,
        };

        const knrRes = await fetch(
          internalUrl(req, "/api/kosztorysant/knr-lookup"),
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(knrPayload),
          }
        );

        if (knrRes.ok) {
          const knrData: KnrLookupResponse = await knrRes.json();
          sections      = knrData.sections;
          narrativeHints = knrData.narrativeHints;
        } else {
          const errText = await knrRes.text();
          console.error("[RMS Engine] KNR Lookup błąd HTTP:", knrRes.status, errText);
          narrativeHints = "Błąd agenta KNR – weryfikacja ręczna wymagana.";
          // Zachowujemy currentSections bez zmian
        }
      } catch (err) {
        console.error("[RMS Engine] Błąd wywołania KNR Lookup:", err);
        narrativeHints = "Połączenie z agentem KNR niedostępne – spróbuj ponownie.";
      }

    } else {
      // EXPLAIN_POSITION lub GENERAL_QUERY: nie modyfikujemy sekcji
      sections = currentSections ?? [];
    }

    // ── D. FINANSOWY: deterministyczna matematyka kosztorysowa ────────────────

    const financial = agentFinansowy(sections, currentTrends);

    // ── E. REDAKTOR: synteza wyników w odpowiedź dla Kosztorysanta ───────────

    const reply = await agentRedaktor(
      request,
      mode,
      financial,
      narrativeHints,
      riskAlerts,
      currentTrends
    );

    // ── Kompletowanie odpowiedzi ───────────────────────────────────────────────

    const responsePayload: RmsEngineResponse = { reply };

    // Dołączamy zaktualizowane sekcje tylko gdy były faktycznie przeliczone
    if (isCalculationMode && sections.length > 0) {
      responsePayload.generatedSections = sections;
    }

    // Dołączamy alerty ryzyk jeśli wygenerowane
    if (riskAlerts.length > 0) {
      responsePayload.riskAlerts = riskAlerts;
    }

    return NextResponse.json(responsePayload);

  } catch (error) {
    console.error("[RMS Engine] Krytyczny błąd Orkiestratora:", error);
    const msg = error instanceof Error ? error.message : "Nieznany błąd.";

    return NextResponse.json(
      {
        reply: `⚠️ Błąd Systemu PESAM: ${msg}. Sprawdź konfigurację Vertex AI i zmienne środowiskowe.`,
      },
      { status: 500 }
    );
  }
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({
    service: "PESAM RMS Engine (Orkiestrator)",
    pipeline: [
      "A. Dispatcher  → /api/kosztorysant/dispatcher (Gemini Flash)",
      "B. KNR Lookup  → /api/kosztorysant/knr-lookup (Gemini Pro + Python) [tryby kalkulacyjne]",
      "C. agentRyzyka → wbudowany (Gemini Flash) [RISK_ANALYSIS]",
      "D. agentFinansowy → wbudowany (Pure TypeScript, deterministyczny)",
      "E. agentRedaktor → wbudowany (Gemini Pro)",
    ],
    entryPoint: "Ten endpoint jest jedynym wywoływanym przez frontend.",
  });
}