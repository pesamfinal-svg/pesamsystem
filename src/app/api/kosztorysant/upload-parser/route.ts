/**
 * PESAM – Upload Parser: Analiza Dokumentacji Przetargowej
 *
 * Ścieżka: src/app/api/kosztorysant/upload-parser/route.ts
 *
 * Odpowiedzialność:
 *  - Odbiera plik (PDF, XLSX, DOCX) z Dropzone na frontendzie via multipart/form-data.
 *  - Konwertuje plik do Base64 i przekazuje natywnie do Gemini 2.5 Pro (multimodalność).
 *  - Model analizuje dokument jako doświadczony Inżynier Kontraktu:
 *      A. Identyfikuje działy robót i pozycje przedmiarowe (tabele, listy, tekst).
 *      B. Dopasowuje kody KNR/KNNR, jednostki, ilości i ceny bazowe RMS 2025.
 *      C. Wyciąga ryzyka kontraktowe (kary, gwarancje, wymogi formalne z SWZ).
 *  - Zwraca ustrukturyzowany JSON: { reply, generatedSections, riskAlerts }.
 *
 * Obsługiwane typy MIME:
 *  - application/pdf           (SWZ, PFU, opisy techniczne, ślepe kosztorysy)
 *  - application/vnd.ms-excel / application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
 *  - application/msword / application/vnd.openxmlformats-officedocument.wordprocessingml.document
 *  - image/jpeg, image/png     (skany rysunków technicznych, rzutów)
 *
 * Limit rozmiaru pliku: 19 MB (ograniczenie inlineData Gemini API).
 */

import { GoogleGenAI } from "@google/genai";
import { NextRequest, NextResponse } from "next/server";
import {
  MarketTrends,
  EstimateSection,
  RmsEngineResponse,
  extractAllJSONObjects,
} from "../_shared/types";

export const dynamic = "force-dynamic"; // <--- WYMUSZENIE TRYBU DYNAMICZNEGO DLA KOMPILATORA

// ── Stałe ─────────────────────────────────────────────────────────────────────

const MODEL_PRO = "gemini-2.5-pro";
const MAX_FILE_SIZE_BYTES = 19 * 1024 * 1024; // 19 MB

const SUPPORTED_MIME_TYPES: Record<string, string> = {
  "application/pdf": "PDF",
  "application/vnd.ms-excel": "Excel (XLS)",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "Excel (XLSX)",
  "application/msword": "Word (DOC)",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word (DOCX)",
  "image/jpeg": "Obraz JPEG",
  "image/png": "Obraz PNG",
  "image/webp": "Obraz WebP",
};

// ── Prompt systemowy – wielomodalny Inżynier Kontraktu ────────────────────────

const SYSTEM_INSTRUCTION = `
Jesteś Wielomodalnym Agentem Analizy Przetargowej systemu PESAM – doświadczonym
Inżynierem Kontraktu i Kosztorysantem z 20-letnim stażem.
Potrafisz czytać dokumenty PDF i wyciągać z nich kluczowe dane.

TWOJE ZADANIE: SZYBKA ANALIZA DOKUMENTU I WYEKSTRAHOWANIE GŁÓWNYCH POZYCJI

Przeanalizuj dostarczony dokument i wykonaj TRZY zadania jednocześnie:

ZASADY FORMATOWANIA JSON (KRYTYCZNE DLA BEZPIECZEŃSTWA PARSOWANIA):
1. NIGDY nie używaj standardowych znaków cudzysłowu (") wewnątrz wartości tekstowych (np. w polach "reply", "name" czy "riskAlerts"). 
   Jeśli musisz coś zacytować lub wyróżnić, używaj WYŁĄCZNIE pojedynczego apostrofu (').
2. Odpowiedź musi być w 100% poprawnym i czystym obiektem JSON.

────────────────────────────────────────────────────────
ZADANIE A – GŁÓWNE POZYCJE PRZEDMIARU (MAX 10 POZYCJI SCALONYCH)
────────────────────────────────────────────────────────
Nie rozpisuj szczegółowo każdego gwoździa ani r-g. Wybierz z dokumentu maksymalnie 5-10 GŁÓWNYCH,
najważniejszych pozycji scalonych (np. Wykop mechaniczny, Ławy żelbetowe, Ściany nośne, Strop żelbetowy, Pokrycie dachu).
Zasady:
- Każda pozycja musi mieć realny kod KNR/KNNR w formacie "KNR X-XX XXXX-XX".
- Typ pozycji: "M" lub "S" (dla uproszczenia podaj pozycje jako materiał/sprzęt scalony).
- Podaj szacunkową cenę bazową netto (bez narzutów).

────────────────────────────────────────────────────────
ZADANIE B – ANALIZA RYZYK KONTRAKTOWYCH (GENERUJ RISKALERTS)
────────────────────────────────────────────────────────
Przeszukaj dokument pod kątem klauzul ryzyka (kary, gwarancje, brak zaliczek).
Format każdego alertu (jedno konkretne zdanie bez użycia znaku "):
"⚠️ UWAGA: [opis ryzyka]"
"❗ RYZYKO: [opis ryzyka wysokiego]"
"✅ OK: [klauzula zgodna ze standardem]"

────────────────────────────────────────────────────────
ZADANIE C – KOMENTARZ INŻYNIERSKI (GENERUJ REPLY)
────────────────────────────────────────────────────────
Napisz profesjonalne podsumowanie w 4-5 zdaniach. Oceń kompletność dokumentacji i wskaż najważniejsze ryzyko finansowe.

{
  "reply": "string – krótki komentarz inżynierski (Zadanie C)",
  "generatedSections": [
    {
      "id": "sec-1",
      "name": "Dział 1. Główne roboty konstrukcyjne (Podsumowanie)",
      "items": [
        {
          "id": "item-1-1",
          "code": "KNR 2-01 0210-02",
          "name": "Wykop mechaniczny pod budynek z wywozem",
          "type": "S",
          "quantity": 1200.0,
          "unit": "m³",
          "basePrice": 28.00,
          "unitPrice": 28.00
        }
      ]
    }
  ],
  "riskAlerts": [
    "⚠️ UWAGA: Kara umowna wynosi 0.2% wartości kontraktu netto za każdy dzień opóźnienia.",
    "✅ OK: Termin realizacji 14 miesięcy jest realny."
  ]
}
`.trim();

// ── Walidacja pliku ───────────────────────────────────────────────────────────

interface ValidationResult {
  valid: boolean;
  error?: string;
  mimeLabel?: string;
}

function validateFile(file: File): ValidationResult {
  if (!file || file.size === 0) {
    return { valid: false, error: "Plik jest pusty lub nie został przesłany." };
  }

  if (file.size > MAX_FILE_SIZE_BYTES) {
    const sizeMB = (file.size / 1024 / 1024).toFixed(1);
    return {
      valid: false,
      error: `Plik jest zbyt duży (${sizeMB} MB). Maksymalny rozmiar to 19 MB. Rozważ podział dokumentacji na mniejsze pliki.`,
    };
  }

  const mimeLabel = SUPPORTED_MIME_TYPES[file.type];
  if (!mimeLabel) {
    const supportedList = Object.values(SUPPORTED_MIME_TYPES).join(", ");
    return {
      valid: false,
      error: `Nieobsługiwany format pliku: "${file.type}". Obsługiwane formaty: ${supportedList}.`,
    };
  }

  return { valid: true, mimeLabel };
}

// ── Pomocnik: bezpieczne parsowanie trendów z formData ────────────────────────

function parseTrends(raw: string | null): MarketTrends {
  const defaults: MarketTrends = {
    laborAdjustment: 0,
    materialAdjustment: 0,
    equipmentAdjustment: 0,
    kp: 65,
    zysk: 12,
  };

  if (!raw) return defaults;

  try {
    const parsed = JSON.parse(raw);
    return {
      laborAdjustment:    typeof parsed.laborAdjustment    === "number" ? parsed.laborAdjustment    : defaults.laborAdjustment,
      materialAdjustment: typeof parsed.materialAdjustment === "number" ? parsed.materialAdjustment : defaults.materialAdjustment,
      equipmentAdjustment:typeof parsed.equipmentAdjustment=== "number" ? parsed.equipmentAdjustment: defaults.equipmentAdjustment,
      kp:                 typeof parsed.kp                 === "number" ? parsed.kp                 : defaults.kp,
      zysk:               typeof parsed.zysk               === "number" ? parsed.zysk               : defaults.zysk,
    };
  } catch {
    return defaults;
  }
}

// ── Pomocnik: buduje blok kontekstu trendów dla promptu ──────────────────────

function buildTrendsContext(trends: MarketTrends): string {
  const laborSign    = trends.laborAdjustment    >= 0 ? "+" : "";
  const materialSign = trends.materialAdjustment >= 0 ? "+" : "";
  const equipSign    = trends.equipmentAdjustment>= 0 ? "+" : "";

  return `
PARAMETRY RYNKOWE USTAWIONE PRZEZ KOSZTORYSANTA (informacyjnie – nie doliczaj do cen bazowych):
- Korekta robocizny (R):    ${laborSign}${trends.laborAdjustment}%
- Korekta materiałów (M):   ${materialSign}${trends.materialAdjustment}%
- Korekta sprzętu (S):      ${equipSign}${trends.equipmentAdjustment}%
- Koszty pośrednie (Kp):    ${trends.kp}%
- Zysk kosztorysowy (Z):    ${trends.zysk}%

Uwzględnij te nastawienia w komentarzu inżynierskim (pole "reply") – oceń czy
są adekwatne do warunków rynkowych wynikających z dokumentacji i lokalizacji
inwestycji. Ceny w "basePrice" pozostają cenami bazowymi 2025 bez tych korekt.
`.trim();
}

// ── Pomocnik oczyszczający surowy JSON przed parsowaniem ─────────────────────

function cleanAndSanitizeJson(raw: string): string {
  let cleaned = raw.trim();
  
  // Usuń ewentualne znaczniki markdown ```json ... ```
  if (cleaned.startsWith("```json")) cleaned = cleaned.substring(7);
  if (cleaned.endsWith("```")) cleaned = cleaned.substring(0, cleaned.length - 3);
  cleaned = cleaned.trim();

  // Zamień surowe znaki nowej linii wewnątrz cudzysłowów na bezpieczne spacje
  cleaned = cleaned.replace(/[\r\n]+/g, " ");

  return cleaned;
}

// ── Główny Handler ────────────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  console.log("==================================================");
  console.log("[Upload Parser] === ODEBRANO NOWE ZAPYTANIE ===");
  console.log("==================================================");

  const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
    location: "global",
  });

  // ── 1. Odbiór i walidacja formData ────────────────────────────────────────

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch (err) {
    console.error("[Upload Parser] Błąd parsowania formData:", err);
    return NextResponse.json(
      { error: "Nie udało się odczytać przesłanych danych. Upewnij się że żądanie ma typ multipart/form-data." },
      { status: 400 }
    );
  }

  const file = formData.get("file") as File | null;
  const trendsRaw = formData.get("trends") as string | null;

  if (!file) {
    console.error("[Upload Parser] Błąd: Brak pliku w żądaniu.");
    return NextResponse.json(
      { error: 'Brak pliku w żądaniu. Upewnij się że pole formData nosi nazwę "file".' },
      { status: 400 }
    );
  }

  console.log(`[Upload Parser] Nazwa pliku: "${file.name}"`);
  console.log(`[Upload Parser] Rozmiar pliku: ${file.size} bajtów`);
  console.log(`[Upload Parser] Typ MIME pliku: "${file.type}"`);

  // ── 2. Walidacja pliku ────────────────────────────────────────────────────

  const validation = validateFile(file);
  if (!validation.valid) {
    console.error(`[Upload Parser] Błąd walidacji pliku: ${validation.error}`);
    return NextResponse.json(
      { error: validation.error },
      { status: 422 }
    );
  }

  // ── 3. Parsowanie parametrów ──────────────────────────────────────────────

  const trends = parseTrends(trendsRaw);
  const trendsContext = buildTrendsContext(trends);
  console.log("[Upload Parser] Odebrane parametry wyceny:", JSON.stringify(trends));

  // ── 4. Konwersja pliku do Base64 ──────────────────────────────────────────

  let base64Data: string;
  try {
    const arrayBuffer = await file.arrayBuffer();
    base64Data = Buffer.from(arrayBuffer).toString("base64");
    console.log("[Upload Parser] Pomyślnie przekonwertowano bufor pliku do Base64.");
  } catch (err) {
    console.error("[Upload Parser] Błąd konwersji pliku do Base64:", err);
    return NextResponse.json(
      { error: "Nie udało się odczytać zawartości pliku. Plik może być uszkodzony." },
      { status: 422 }
    );
  }

  // ── 5. Wywołanie Gemini 2.5 Pro (multimodalnie) ───────────────────────────

  const userPrompt = `
Przeanalizuj załączony dokument przetargowy: "${file.name}" (${validation.mimeLabel}, ${(file.size / 1024).toFixed(0)} KB).

${trendsContext}

Pamiętaj: odpowiedź WYŁĄCZNIE jako obiekt JSON zgodny z instrukcją systemową.
`.trim();

  let rawAiText: string;
  console.log("[Upload Parser] Wysyłam zapytanie do Gemini Pro...");
  const startTime = Date.now();

  try {
    const response = await ai.models.generateContent({
      model: MODEL_PRO,
      contents: [
        {
          role: "user",
          parts: [
            // Part 1: Plik jako inlineData (multimodalność Gemini)
            {
              inlineData: {
                data: base64Data,
                mimeType: file.type,
              },
            },
            // Part 2: Instrukcja tekstowa z kontekstem trendów
            { text: userPrompt },
          ],
        },
      ],
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        temperature: 0.1,    // Niska temperatura = spójny, deterministyczny JSON
        maxOutputTokens: 8192,
        responseMimeType: "application/json", // <--- WYMUSZENIE CZYSZTEGO I BEZPIECZNEGO FORMATU JSON
      },
    });
    rawAiText = response.text ?? "";

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`[Upload Parser] Odebrano odpowiedź od Gemini w czasie: ${duration} sek.`);
    console.log(`[Upload Parser] Długość surowej odpowiedzi AI: ${rawAiText.length} znaków`);

    if (!rawAiText.trim()) {
      throw new Error("Model zwrócił pustą odpowiedź.");
    }

    // DIAGNOSTYKA: LOGUJEMY PIERWSZE I OSTATNIE LINIE ODPOWIEDZI AI
    console.log("--------------------------------------------------");
    console.log("[Upload Parser] PIERWSZE 1000 ZNAKÓW ODPOWIEDZI AI:");
    console.log(rawAiText.substring(0, 1000));
    console.log("--------------------------------------------------");
    console.log("[Upload Parser] OSTATNIE 1000 ZNAKÓW ODPOWIEDZI AI:");
    console.log(rawAiText.substring(Math.max(0, rawAiText.length - 1000)));
    console.log("--------------------------------------------------");

  } catch (err) {
    console.error("[Upload Parser] Błąd wywołania Gemini API:", err);
    const msg = err instanceof Error ? err.message : "Nieznany błąd modelu AI.";
    return NextResponse.json(
      {
        error: `Błąd analizy AI: ${msg}. Sprawdź konfigurację Vertex AI (GCP_PROJECT_ID, uprawnienia).`,
      },
      { status: 502 }
    );
  }

  // Oczyszczamy tekst przed parsowaniem
  const sanitizedText = cleanAndSanitizeJson(rawAiText);
  console.log(`[Upload Parser] Rozmiar tekstu po sanitacji: ${sanitizedText.length} znaków.`);

  // ── 6. Parsowanie JSON z odpowiedzi AI ───────────────────────────────────

  let parsed: any = null;

  try {
    // Po włączeniu responseMimeType, odpowiedź to w 100% czysty JSON
    parsed = JSON.parse(sanitizedText);
    console.log("[Upload Parser] Sukces! Standardowy JSON.parse() przetworzył dane bez błędów.");
  } catch (parseErr: any) {
    console.warn(`[Upload Parser] Standardowy JSON.parse zawiódł. Błąd: "${parseErr.message}". Uruchamiam ekstraktor awaryjny...`);
    const extracted = extractAllJSONObjects(rawAiText) as Array<{
      reply?: string;
      generatedSections?: EstimateSection[];
      riskAlerts?: string[];
    }>;
    
    console.log(`[Upload Parser] Ekstraktor awaryjny znalazł ${extracted.length} obiektów JSON.`);
    if (extracted.length > 0) {
      parsed = extracted[extracted.length - 1];
      console.log("[Upload Parser] Pomyślnie odzyskano obiekt JSON z ekstraktora awaryjnego.");
    }
  }

  if (!parsed) {
    console.error("[Upload Parser] KATASTROFA: Nie udało się odczytać żadnego JSON-a z odpowiedzi modelu.");
    const fallbackResponse: RmsEngineResponse = {
      reply:
        `⚠️ System przeanalizował dokument "${file.name}", ale struktura odpowiedzi nie mogła zostać automatycznie odczytana. ` +
        `Spróbuj ponownie lub prześlij dokument w postaci PDF tekstowego (wygenerowanego cyfrowo).`,
    };
    return NextResponse.json(fallbackResponse);
  }

  console.log("[Upload Parser] Dane skompletowane pomyślnie. Wysyłam odpowiedź na frontend.");
  console.log("==================================================");

  // ── 7. Kompletowanie i zwrot odpowiedzi ──────────────────────────────────

  const responsePayload: RmsEngineResponse & { riskAlerts?: string[] } = {
    reply: parsed.reply ?? `Dokument "${file.name}" został przeanalizowany. Tabela RMS jest gotowa do przeglądu.`,
    ...(parsed.generatedSections?.length ? { generatedSections: parsed.generatedSections } : {}),
    ...(parsed.riskAlerts?.length        ? { riskAlerts: parsed.riskAlerts }               : {}),
  };

  return NextResponse.json(responsePayload);
}

// ── Endpoint statusowy ────────────────────────────────────────────────────────

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({
    service: "PESAM Upload Parser",
    model: MODEL_PRO,
    method: "POST multipart/form-data",
    fields: {
      file: "Plik dokumentacji przetargowej (wymagany)",
      trends: "JSON z parametrami MarketTrends (opcjonalny)",
    },
    supportedFormats: SUPPORTED_MIME_TYPES,
    maxFileSizeMB: MAX_FILE_SIZE_BYTES / 1024 / 1024,
    output: "{ reply, generatedSections?, riskAlerts? }",
  });
}