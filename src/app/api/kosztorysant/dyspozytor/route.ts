/**
 * PESAM – Agent 1: Dispatcher (Router intencji)
 *
 * Ścieżka: src/app/api/kosztorysant/dispatcher/route.ts
 *
 * Odpowiedzialność:
 *  - Przyjmuje polecenie tekstowe od Orkiestratora.
 *  - Używa szybkiego Gemini Flash do jednoznacznej klasyfikacji intencji.
 *  - Zwraca { intent: AgentMode } – zero logiki biznesowej, zero stanu.
 *
 * Celowo NIE importuje nic z sąsiednich endpointów – jest izolowaną jednostką.
 */

import { GoogleGenAI } from "@google/genai";
import { NextRequest, NextResponse } from "next/server";
import {
  AgentMode,
  VALID_MODES,
  DispatcherRequest,
  DispatcherResponse,
} from "../_shared/types";

export const dynamic = "force-dynamic"; // <--- WYMUSZA DYNAMICZNE BUDOWANIE

const MODEL_FLASH = "gemini-3.5-flash";

const SYSTEM_INSTRUCTION = `
Jesteś Dyspozytorem Systemu Kosztorysowego PESAM. Twoją jedyną rolą jest
jednoznaczna klasyfikacja polecenia Głównego Kosztorysanta do jednego z trybów
pracy systemu.

Tryby i ich znaczenie:
- GENERATE_FROM_SCRATCH  – prośba o stworzenie nowego kosztorysu od podstaw dla
                           nieznanej inwestycji lub zakresu robót
- MODIFY_TECHNOLOGY      – podmiana jednej technologii na inną w całym kosztorysie
                           lub w jego dziale (np. "zmień bloczki na gazobeton",
                           "użyj membrany EPDM zamiast papy")
- RECALCULATE_DIVISION   – modyfikacja sposobu wykonania wybranego działu
                           (np. "w dziale 3 zrezygnuj z koparki, weźmiemy podwykonawcę",
                           "zwiększ ilość koparek o 2")
- RISK_ANALYSIS          – pytanie o ryzyka prawne, kary umowne, wymagania
                           przetargowe, warunki SWZ, gwarancje
- EXPLAIN_POSITION       – prośba o wyjaśnienie normy KNR, technologii budowlanej,
                           jednostki miary lub składników pozycji
- GENERAL_QUERY          – każde inne pytanie nienależące do powyższych kategorii

ZASADY:
1. Odpowiedz WYŁĄCZNIE jednym identyfikatorem trybu – bez żadnego dodatkowego
   tekstu, znaków interpunkcyjnych ani markdown.
2. W razie wątpliwości wybierz GENERAL_QUERY.
3. Nigdy nie klasyfikuj jako RISK_ANALYSIS zapytań dotyczących obliczeń,
   nawet jeśli zawierają słowo "ryzyko" w kontekście finansowym.
`.trim();

export async function POST(
  req: NextRequest
): Promise<NextResponse<DispatcherResponse>> {
  try {
    const ai = new GoogleGenAI({
      vertexai: true,
      project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
      location: "global",
    });

    const body: DispatcherRequest = await req.json();
    const { request } = body;

    if (!request?.trim()) {
      return NextResponse.json({ intent: "GENERAL_QUERY" }, { status: 400 });
    }

    const response = await ai.models.generateContent({
      model: MODEL_FLASH,
      contents: [{ role: "user", parts: [{ text: `"${request.trim()}"` }] }],
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        temperature: 0.0, // Klasyfikacja – deterministyczna
        maxOutputTokens: 32,
      },
    });

    const raw = response.text?.trim().toUpperCase() ?? "";

    // Ochrona przed odpowiedziami z markdown lub spacjami
    const intent = VALID_MODES.find((m) => raw.includes(m)) ?? "GENERAL_QUERY";

    return NextResponse.json({ intent });
  } catch (error) {
    console.error("[Dispatcher] Błąd klasyfikacji:", error);
    // Fallback: nie blokujemy Orkiestratora – zwracamy tryb ogólny
    return NextResponse.json({ intent: "GENERAL_QUERY" });
  }
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({
    service: "PESAM Dispatcher",
    model: MODEL_FLASH,
    responsibility: "Intent classification only",
    validModes: VALID_MODES,
  });
}