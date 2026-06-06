/**
 * PESAM – Agent: Czytacz Dokumentów (Z systemem wirtualnych nożyczek PDF-LIB)
 *
 * Ścieżka: src/app/api/kosztorysant/czytacz-dokumentow/route.ts
 */

import { GoogleGenAI } from "@google/genai";
import { NextRequest, NextResponse } from "next/server";
import { PDFDocument } from "pdf-lib"; // <--- NOWY IMPORT DLA WIRTUALNYCH NOŻYCZEK
import {
  MarketTrends,
  EstimateSection,
  RmsEngineResponse,
  extractAllJSONObjects,
} from "../_shared/types";

export const dynamic = "force-dynamic";

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
Inżynierem Kontraktu i Kosztorysantem z 20-letnim stażem. Potrafisz czytać wycięte fragmenty SWZ i przedmiarów.

TWOJE ZADANIE: SZYBKA ANALIZA WYCIĘTEGO FRAGMENTU DOKUMENTU I WYEKSTRAHOWANIE GŁÓWNYCH POZYCJI

ZASADY FORMATOWANIA JSON (KRYTYCZNE DLA BEZPIECZEŃSTWA PARSOWANIA):
1. NIGDY nie używaj standardowych znaków cudzysłowu (") wewnątrz wartości tekstowych (np. w polach "reply", "name" czy "riskAlerts"). 
   Jeśli musisz coś zacytować lub wyróżnić, używaj WYŁĄCZNIE pojedynczego apostrofu (').
2. Odpowiedź musi być w 100% poprawnym i czystym obiektem JSON.

────────────────────────────────────────────────────────
ZADANIE A – GŁÓWNE POZYCJE PRZEDMIARU (MAX 10 POZYCJI SCALONYCH)
────────────────────────────────────────────────────────
Wybierz z dokumentu maksymalnie 5-10 GŁÓWNYCH, najważniejszych pozycji scalonych (np. Wykop mechaniczny, Ławy żelbetowe, Ściany nośne, Strop żelbetowy, Pokrycie dachu).
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
    return { valid: false, error: "Plik jest pusty." };
  }

  if (file.size > MAX_FILE_SIZE_BYTES) {
    const sizeMB = (file.size / 1024 / 1024).toFixed(1);
    return {
      valid: false,
      error: `Plik jest za duży (${sizeMB} MB). Maksymalny rozmiar to 19 MB.`,
    };
  }

  const mimeLabel = SUPPORTED_MIME_TYPES[file.type];
  if (!mimeLabel) {
    const supportedList = Object.values(SUPPORTED_MIME_TYPES).join(", ");
    return {
      valid: false,
      error: `Nieobsługiwany format: "${file.type}". Dozwolone: ${supportedList}.`,
    };
  }

  return { valid: true, mimeLabel };
}

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
      laborAdjustment: typeof parsed.laborAdjustment === "number" ? parsed.laborAdjustment : defaults.laborAdjustment,
      materialAdjustment: typeof parsed.materialAdjustment === "number" ? parsed.materialAdjustment : defaults.materialAdjustment,
      equipmentAdjustment: typeof parsed.equipmentAdjustment === "number" ? parsed.equipmentAdjustment : defaults.equipmentAdjustment,
      kp: typeof parsed.kp === "number" ? parsed.kp : defaults.kp,
      zysk: typeof parsed.zysk === "number" ? parsed.zysk : defaults.zysk,
    };
  } catch {
    return defaults;
  }
}

// ── METODA "WIRTUALNYCH NOŻYCZEK" DLA PDF ────────────────────────────────────

async function slicePdf(arrayBuffer: ArrayBuffer): Promise<{ buffer: Buffer; sliced: boolean }> {
  try {
    const srcDoc = await PDFDocument.load(arrayBuffer);
    const pageCount = srcDoc.getPageCount();

    console.log(`[Czytacz Dokumentów] Wykryto dokument PDF o długości: ${pageCount} stron.`);

    // Jeśli plik ma mniej niż 12 stron, przesyłamy go w całości (nie ma ryzyka timeoutu)
    if (pageCount <= 12) {
      console.log("[Czytacz Dokumentów] Plik ma 12 lub mniej stron. Przesyłam w całości.");
      return { buffer: Buffer.from(arrayBuffer), sliced: false };
    }

    console.log("[Czytacz Dokumentów] Plik jest duży (> 12 stron). Uruchamiam procedurę 'Nożyczek' (pdf-lib)...");
    const dstDoc = await PDFDocument.create();

    // Wycinamy pierwsze 5 stron (metadane, cel, NIP, terminy)
    const firstPagesIndices = Array.from({ length: Math.min(5, pageCount) }, (_, i) => i);
    // Wycinamy ostatnie 5 stron (podsumowania, działy, podpisy)
    const lastPagesIndices = Array.from({ length: Math.min(5, pageCount) }, (_, i) => pageCount - 1 - i).reverse();

    // Łączymy indeksy stron (upewniamy się, że są unikalne)
    const pagesToKeep = Array.from(new Set([...firstPagesIndices, ...lastPagesIndices]));
    console.log(`[Czytacz Dokumentów] Wycinam i łączę strony: ${pagesToKeep.map(p => p + 1).join(", ")}`);

    const copiedPages = await dstDoc.copyPages(srcDoc, pagesToKeep);
    copiedPages.forEach((page) => dstDoc.addPage(page));

    const pdfBytes = await dstDoc.save();
    return { buffer: Buffer.from(pdfBytes), sliced: true };
  } catch (err) {
    console.error("[Czytacz Dokumentów] Krytyczny błąd podczas pracy nożyczek pdf-lib:", err);
    // Fallback: w razie błędu biblioteki zwracamy oryginalny bufor, aby nie wyłożyć systemu
    return { buffer: Buffer.from(arrayBuffer), sliced: false };
  }
}

// ── Pomocnik oczyszczający surowy JSON przed parsowaniem ─────────────────────

function cleanAndSanitizeJson(raw: string): string {
  let cleaned = raw.trim();
  if (cleaned.startsWith("```json")) cleaned = cleaned.substring(7);
  if (cleaned.endsWith("```")) cleaned = cleaned.substring(0, cleaned.length - 3);
  cleaned = cleaned.trim();
  cleaned = cleaned.replace(/[\r\n]+/g, " ");
  return cleaned;
}

// ── Główny Handler ────────────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  console.log("==================================================");
  console.log("[Czytacz Dokumentów] === ROZPOCZĘTO ANALIZĘ DOKUMENTU ===");
  console.log("==================================================");

  const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
    location: "global",
  });

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch (err) {
    console.error("[Czytacz Dokumentów] Błąd parsowania formData:", err);
    return NextResponse.json({ error: "Nieprawidłowy typ żądania." }, { status: 400 });
  }

  const file = formData.get("file") as File | null;
  const trendsRaw = formData.get("trends") as string | null;

  if (!file) {
    console.error("[Czytacz Dokumentów] Błąd: Brak pliku w żądaniu.");
    return NextResponse.json({ error: 'Brak pliku "file" w żądaniu.' }, { status: 400 });
  }

  const validation = validateFile(file);
  if (!validation.valid) {
    console.error(`[Czytacz Dokumentów] Błąd walidacji: ${validation.error}`);
    return NextResponse.json({ error: validation.error }, { status: 422 });
  }

  const trends = parseTrends(trendsRaw);

  // ── 4. Wycinanie stron i konwersja do Base64 ──────────────────────────────
  let base64Data: string;
  let wasSliced = false;

  try {
    const arrayBuffer = await file.arrayBuffer();

    // Jeśli to plik PDF, odpalamy nasze "Wirtualne Nożyczki"
    if (file.type === "application/pdf") {
      const { buffer, sliced } = await slicePdf(arrayBuffer);
      base64Data = buffer.toString("base64");
      wasSliced = sliced;
    } else {
      // Dla pozostałych formatów (Excel/Obrazy) przesyłamy bufor w całości
      base64Data = Buffer.from(arrayBuffer).toString("base64");
    }

    console.log(`[Czytacz Dokumentów] Pomyślnie przygotowano dane Base64 do wysyłki. Rozmiar: ${base64Data.length} znaków.`);
  } catch (err) {
    console.error("[Czytacz Dokumentów] Błąd przygotowania danych Base64:", err);
    return NextResponse.json({ error: "Nie udało się odczytać zawartości pliku." }, { status: 422 });
  }

  const userPrompt = `
    Przeanalizuj plik: "${file.name}" (${validation.mimeLabel}, ${(file.size / 1024).toFixed(0)} KB).
    ${wasSliced ? "UWAGA: Do analizy przesłano wycięte pierwsze i ostatnie strony tego dużego dokumentu (Triage)." : ""}
    Odpowiedz jako poprawny obiekt JSON. Pamiętaj: NIGDY nie używaj znaku " wewnątrz wartości tekstowych.
  `.trim();

  let rawAiText: string;
  console.log("[Czytacz Dokumentów] Wysyłam zapytanie do Gemini Pro...");
  const startTime = Date.now();

  try {
    const response = await ai.models.generateContent({
      model: MODEL_PRO,
      contents: [
        {
          role: "user",
          parts: [
            {
              inlineData: {
                data: base64Data,
                mimeType: file.type,
              },
            },
            { text: userPrompt },
          ],
        },
      ],
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        temperature: 0.1,
        maxOutputTokens: 8192,
        responseMimeType: "application/json",
      },
    });

    rawAiText = response.text ?? "";
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`[Czytacz Dokumentów] Odebrano odpowiedź od Gemini w czasie: ${duration} sek.`);

    if (!rawAiText.trim()) {
      throw new Error("Pusta odpowiedź z modelu Gemini.");
    }
  } catch (err) {
    console.error("[Czytacz Dokumentów] Błąd wywołania Gemini API:", err);
    const msg = err instanceof Error ? err.message : "Nieznany błąd chmury.";
    return NextResponse.json({ error: `Błąd analizy AI: ${msg}` }, { status: 502 });
  }

  const sanitizedText = cleanAndSanitizeJson(rawAiText);
  let parsed: any = null;

  try {
    parsed = JSON.parse(sanitizedText);
    console.log("[Czytacz Dokumentów] Sukces! Standardowy JSON.parse() przetworzył dane bez błędów.");
  } catch (parseErr: any) {
    console.warn(`[Czytacz Dokumentów] Standardowy JSON.parse zawiódł. Błąd: "${parseErr.message}". Uruchamiam ekstraktor awaryjny...`);
    const extracted = extractAllJSONObjects(rawAiText) as Array<{
      reply?: string;
      generatedSections?: EstimateSection[];
      riskAlerts?: string[];
    }>;
    if (extracted.length > 0) {
      parsed = extracted[extracted.length - 1];
    }
  }

  if (!parsed) {
    console.error("[Czytacz Dokumentów] KATASTROFA: Nie udało się odczytać żadnego JSON-a.");
    return NextResponse.json({
      reply: `⚠️ Przeanalizowano dokument "${file.name}", ale struktura odpowiedzi nie mogła zostać odczytana jako JSON.`
    });
  }

  const responsePayload: RmsEngineResponse & { riskAlerts?: string[] } = {
    reply: parsed.reply ?? `Dokument "${file.name}" został pomyślnie przeanalizowany.`,
    ...(parsed.generatedSections?.length ? { generatedSections: parsed.generatedSections } : {}),
    ...(parsed.riskAlerts?.length ? { riskAlerts: parsed.riskAlerts } : {}),
  };

  return NextResponse.json(responsePayload);
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({
    service: "PESAM Czytacz Dokumentów (Slicer)",
    model: MODEL_PRO,
    supportedFormats: SUPPORTED_MIME_TYPES,
  });
}