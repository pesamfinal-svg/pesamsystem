/**
 * PESAM – Główny Kosztorysant (Orkiestrator Roju z pełnym logowaniem)
 *
 * Ścieżka: src/app/api/kosztorysant/glowny-kosztorysant/route.ts
 *
 * Odpowiedzialność:
 *  - Jedyny punkt wejścia wywoływany przez czat na frontendzie.
 *  - Ściąga spis plików (Manifest) z Firestore w czasie rzeczywistym.
 *  - Wywołuje Agenta Klasyfikacji (Dyspozytora).
 *  - Przekazuje zadania KNR i wyceny do Agenta KNR.
 *  - Uruchamia deterministycznego Agenta Finansowego w TS.
 *  - Generuje finalną syntezę rynkową u Agenta Redaktora.
 */

import { GoogleGenAI } from "@google/genai";
import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin"; // Inicjalizacja Firestore Admin
import {
  AgentMode,
  EstimateSection,
  MarketTrends,
  RmsEngineRequest,
  RmsEngineResponse,
  extractAllJSONObjects,
} from "../_shared/types";

export const dynamic = "force-dynamic";

// Najnowsze modele Gemini (seria 2.5 i 3.5)
const MODEL_PRO = "gemini-2.5-pro";
const MODEL_FLASH = "gemini-3.5-flash";

// Budowanie bezpiecznego URL dla wewnętrznych wywołań API w Next.js
function internalUrl(req: NextRequest, path: string): string {
  const origin = new URL(req.url).origin;
  return `${origin}${path}`;
}

// ── AGENT RYZYKA (Wbudowany - Gemini 3.5 Flash) ───────────────────────────────

async function agentRyzyka(request: string): Promise<string[]> {
  console.log("[Główny Kosztorysant / Agent Ryzyka] Rozpoczynam analizę ryzyka kontraktowego...");

  const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
    location: "global",
  });

  const systemInstruction = `
    Jesteś Prawnikiem Kontraktowym specjalizującym się w polskim Prawie Zamówień Publicznych (PZP).
    Wygeneruj listę 3-5 konkretnych, krótkich alertów prawno-ryzykownych dotyczących opisanego przetargu.
    Format każdego alertu (jedno zdanie, bez użycia znaku "):
    - "⚠️ UWAGA: [opis]"
    - "❗ RYZYKO: [opis]"
    - "✅ OK: [potwierdzenie]"
    Zwróć wyłącznie tablicę JSON stringów: ["alert1", "alert2"]
  `;

  try {
    const response = await ai.models.generateContent({
      model: MODEL_FLASH,
      contents: [{ role: "user", parts: [{ text: request }] }],
      config: { systemInstruction, temperature: 0.2, maxOutputTokens: 512 }
    });

    const raw = response.text ?? "";
    console.log(`[Główny Kosztorysant / Agent Ryzyka] Surowa odpowiedź o ryzykach (${raw.length} znaków).`);

    const arrayMatch = raw.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      const parsed = JSON.parse(arrayMatch[0]);
      if (Array.isArray(parsed)) {
        console.log(`[Główny Kosztorysant / Agent Ryzyka] Pomyślnie wyekstrahowano ${parsed.length} alertów ryzyka.`);
        return parsed;
      }
    }
  } catch (err) {
    console.error("[Główny Kosztorysant / Agent Ryzyka] Błąd wywołania lub parsowania:", err);
  }
  return ["⚠️ UWAGA: Szczegółowa analiza ryzyka PZP chwilowo niedostępna ze względu na błąd techniczny bota."];
}

// ── AGENT FINANSOWY (Deterministyczny - Pure TypeScript) ─────────────────────

interface FinancialSummary {
  totalBase: number;
  totalAfterTrends: number;
  totalWithMarkups: number;
  byType: { R: number; M: number; S: number };
}

function agentFinansowy(sections: EstimateSection[], trends: MarketTrends): FinancialSummary {
  console.log("[Główny Kosztorysant / Agent Finansowy] Uruchamiam deterministyczne liczenie narzutów (TS)...");

  let totalBase = 0;
  let totalAfterTrends = 0;
  let totalWithMarkups = 0;
  const byType = { R: 0, M: 0, S: 0 };

  const kpFactor = trends.kp / 100;
  const zFactor = trends.zysk / 100;

  for (const sec of sections) {
    for (const item of sec.items) {
      const base = item.quantity * item.basePrice;
      totalBase += base;
      byType[item.type] += base;

      let adjustedPrice = item.basePrice;
      if (item.type === "R") adjustedPrice *= 1 + trends.laborAdjustment / 100;
      else if (item.type === "M") adjustedPrice *= 1 + trends.materialAdjustment / 100;
      else if (item.type === "S") adjustedPrice *= 1 + trends.equipmentAdjustment / 100;

      const directCost = item.quantity * adjustedPrice;
      totalAfterTrends += directCost;

      if (item.type === "R" || item.type === "S") {
        const kpVal = directCost * kpFactor;
        const zVal = (directCost + kpVal) * zFactor;
        totalWithMarkups += directCost + kpVal + zVal;
      } else {
        totalWithMarkups += directCost;
      }
    }
  }

  console.log(`[Główny Kosztorysant / Agent Finansowy] Podsumowanie matematyczne: Base=${totalBase} zł | AfterTrends=${totalAfterTrends} zł | FinalWithMarkups=${totalWithMarkups} zł`);
  return { totalBase, totalAfterTrends, totalWithMarkups, byType };
}

// ── AGENT REDAKTOR (Wbudowany - Gemini 2.5 Pro) ───────────────────────────────

async function agentRedaktor(
  request: string,
  mode: AgentMode,
  financial: FinancialSummary,
  narrativeHints: string,
  riskAlerts: string[],
  trends: MarketTrends
): Promise<string> {
  console.log("[Główny Kosztorysant / Agent Redaktor] Generuję finalne podsumowanie merytoryczne...");

  const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
    location: "global",
  });

  const systemInstruction = `
    Jesteś Głównym Inżynierem Kontraktu w systemie PESAM. Przemawiasz do Głównego Kosztorysanta.
    Odpowiadaj bardzo zwięźle (4-6 zdań). Podaj konkretne, zsumowane liczby i wskaż najważniejsze kwestie ryzyka.
    Nie używaj cudzysłowu (") wewnątrz tekstu (używaj pojedynczych apostrofów ').
  `;

  const userPrompt = `
    OPERACJA: ${mode}
    POLECENIE: "${request}"

    Kalkulacja finansowa:
    - Koszt bezpośredni (baza): ${Math.round(financial.totalBase).toLocaleString("pl-PL")} PLN
    - Wycena rynkowa: ${Math.round(financial.totalAfterTrends).toLocaleString("pl-PL")} PLN
    - Cena ofertowa (Kp ${trends.kp}%, Z ${trends.zysk}%): ${Math.round(financial.totalWithMarkups).toLocaleString("pl-PL")} PLN
    - Struktura: R=${Math.round(financial.byType.R).toLocaleString("pl-PL")} zł | M=${Math.round(financial.byType.M).toLocaleString("pl-PL")} zł | S=${Math.round(financial.byType.S).toLocaleString("pl-PL")} zł

    Wskazówki od bazy KNR: "${narrativeHints}"
    Alerty ryzyka: ${riskAlerts.length > 0 ? riskAlerts.join(" | ") : "brak"}
  `;

  try {
    const response = await ai.models.generateContent({
      model: MODEL_PRO,
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      config: { systemInstruction, temperature: 0.3, maxOutputTokens: 512 }
    });

    const text = response.text?.trim() ?? "Wycena została pomyślnie zaktualizowana.";
    console.log(`[Główny Kosztorysant / Agent Redaktor] Pomyślnie wygenerowano odpowiedź (${text.length} znaków).`);
    return text;
  } catch (err) {
    console.error("[Główny Kosztorysant / Agent Redaktor] Błąd wygenerowania opinii:", err);
    return `Kosztorys zaktualizowany. Cena ofertowa z narzutami wynosi: ${Math.round(financial.totalWithMarkups).toLocaleString("pl-PL")} PLN.`;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// ORKIESTRATOR (GŁÓWNY HANDLER)
// ══════════════════════════════════════════════════════════════════════════════

export async function POST(req: NextRequest) {
  console.log("==================================================");
  console.log("[Główny Kosztorysant] === ROZPOCZĘTO NOWĄ ORKIESTRACJĘ ===");
  console.log("==================================================");

  try {
    const body = await req.json();
    const { request, currentTrends, currentSections, tenderId } = body;

    if (!request?.trim()) {
      console.error("[Główny Kosztorysant] Błąd: Brak tekstu zlecenia.");
      return NextResponse.json({ reply: "Proszę podać polecenie." }, { status: 400 });
    }

    console.log(`[Główny Kosztorysant] Tekst zlecenia: "${request}"`);
    console.log(`[Główny Kosztorysant] TenderID: "${tenderId || "brak"}"`);
    console.log(`[Główny Kosztorysant] Ilość sekcji na wejściu: ${currentSections?.length || 0}`);

    // ── KROK 1: Pobranie "Spisu Treści" z bazy (Firestore), jeśli pracujemy na konkretnym tenderId!
    let filesContext = "";
    if (tenderId) {
      console.log(`[Główny Kosztorysant] Odpytuję Firestore o pliki dla projektu: ${tenderId}...`);
      try {
        const filesSnap = await adminDb.collection("tenders").doc(tenderId).collection("files").get();
        const filesList = filesSnap.docs.map(doc => doc.data());
        console.log(`[Główny Kosztorysant] Pomyślnie pobrano ${filesList.length} plików z bazy.`);

        filesContext = `SPIS DOKUMENTÓW PRZETARGOWYCH (tenderId: ${tenderId}):\n` +
          filesList.map(f => `- Plik: "${f.fileName}" (Typ: ${f.category}, Opis: ${f.summary}, Link: ${f.storageUrl})`).join("\n");
      } catch (dbErr) {
        console.error("[Główny Kosztorysant] Błąd odczytu spisu treści z bazy Firestore:", dbErr);
      }
    }

    const enrichedRequest = filesContext ? `${request}\n\n${filesContext}` : request;

    // ── KROK 2: DYSPOZYTOR: Klasyfikacja intencji (Gemini Flash) ────────────────────
    let mode: AgentMode = "GENERAL_QUERY";
    const dispatcherUrl = internalUrl(req, "/api/kosztorysant/dyspozytor");
    console.log(`[Główny Kosztorysant] Wywołuję Agenta Dyspozytora: ${dispatcherUrl}...`);

    try {
      const dispRes = await fetch(dispatcherUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request: enrichedRequest }),
      });
      if (dispRes.ok) {
        const dispData = await dispRes.json();
        mode = dispData.intent;
        console.log(`[Główny Kosztorysant] Dyspozytor zaklasyfikował intencję do trybu: "${mode}"`);
      } else {
        console.warn(`[Główny Kosztorysant] Dyspozytor zwrócił błąd HTTP: ${dispRes.status}`);
      }
    } catch (err) {
      console.error("[Główny Kosztorysant] Błąd wywołania Dyspozytora:", err);
    }

    // ── KROK 3: DELEGACJA DO AGENTÓW WYKONAWCZYCH ─────────────────────────────
    let sections: EstimateSection[] = currentSections ?? [];
    let narrativeHints = "";
    let riskAlerts: string[] = [];

    const isCalculationMode =
      mode === "GENERATE_FROM_SCRATCH" ||
      mode === "MODIFY_TECHNOLOGY" ||
      mode === "RECALCULATE_DIVISION";

    if (mode === "RISK_ANALYSIS") {
      // Wywołanie wbudowanego Agenta Prawnego (Flash)
      riskAlerts = await agentRyzyka(enrichedRequest);
    } else if (isCalculationMode) {
      // Wywołanie odseparowanego Agenta KNR (Pro + Python)
      const knrUrl = internalUrl(req, "/api/kosztorysant/agent-knr");
      console.log(`[Główny Kosztorysant] Wywołuję Agenta KNR (agent-knr): ${knrUrl}...`);

      try {
        const knrRes = await fetch(knrUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            request: enrichedRequest,
            currentTrends,
            mode,
            currentSections: sections,
          }),
        });

        if (knrRes.ok) {
          const knrData = await knrRes.json();
          sections = knrData.sections || [];
          narrativeHints = knrData.narrativeHints || "";
          console.log(`[Główny Kosztorysant] Agent KNR pomyślnie zaktualizował strukturę. Ilość sekcji: ${sections.length}`);
        } else {
          console.error(`[Główny Kosztorysant] Agent KNR zwrócił błąd HTTP: ${knrRes.status}`);
        }
      } catch (err) {
        console.error("[Główny Kosztorysant] Błąd wywołania Agenta KNR:", err);
        narrativeHints = "Połączenie z bazą KNR utracone – zachowano poprzednie wartości.";
      }
    } else {
      console.log(`[Główny Kosztorysant] Tryb ${mode} nie modyfikuje bazy KNR. Pomijam krok wyliczeń.`);
    }

    // ── KROK 4: DETERMINISTYCZNY AGENT FINANSOWY (TypeScript) ─────────────────
    const financial = agentFinansowy(sections, currentTrends);

    // ── KROK 5: REDAKTOR (Gemini Pro) ─────────────────────────────────────────
    const reply = await agentRedaktor(
      request,
      mode,
      financial,
      narrativeHints,
      riskAlerts,
      currentTrends
    );

    // Kompletowanie paczki wyjściowej
    const responsePayload: RmsEngineResponse & { riskAlerts?: string[] } = { reply };

    if (isCalculationMode && sections.length > 0) {
      responsePayload.generatedSections = sections;
    }
    if (riskAlerts.length > 0) {
      responsePayload.riskAlerts = riskAlerts;
    }

    console.log("[Główny Kosztorysant] Orkiestracja zakończona sukcesem. Wysyłam paczkę na frontend.");
    console.log("==================================================");

    return NextResponse.json(responsePayload, { status: 200 });

  } catch (error: any) {
    console.error("[Główny Kosztorysant] Krytyczny błąd orkiestratora:", error);
    return NextResponse.json({ reply: `⚠️ Krytyczny błąd kosztorysanta: ${error.message}` }, { status: 500 });
  }
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({
    service: "PESAM Główny Kosztorysant (Orkiestrator z diagnostyką)",
    status: "operational",
    logsEnabled: true,
  });
}