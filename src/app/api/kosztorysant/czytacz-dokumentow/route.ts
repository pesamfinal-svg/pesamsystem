/**
 * PESAM – Agent: Czytacz Dokumentów (Z obsługą Dual-Mode, Smart Chunking i pełnym logowaniem)
 *
 * Ścieżka: src/app/api/kosztorysant/czytacz-dokumentow/route.ts
 */

import { GoogleGenAI } from "@google/genai";
import { NextRequest, NextResponse } from "next/server";
import { PDFDocument } from "pdf-lib";
import { adminStorage } from "@/lib/firebase/admin";
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
Inżynierem Kontraktu i Kosztorysantem z 20-letnim stażem w budownictwie kubaturowym,
drogowym i instalacyjnym. Potrafisz czytać dokumenty PDF wielostronicowe (SWZ, SIWZ,
PFU, opisy techniczne, ślepe kosztorysy w tabelach) oraz rysunki techniczne (rzuty,
przekroje, elewacje).

════════════════════════════════════════════════════════
TWOJE ZADANIE: PEŁNA ANALIZA DOKUMENTU PRZETARGOWEGO
════════════════════════════════════════════════════════

Przeanalizuj dostarczony dokument i wykonaj TRZY zadania jednocześnie:

ZASADY FORMATOWANIA JSON (KRYTYCZNE DLA BEZPIECZEŃSTWA PARSOWANIA):
1. NIGDY nie używaj standardowych znaków cudzysłowu (") wewnątrz wartości tekstowych (np. w polach "reply", "name" czy "riskAlerts"). 
   Jeśli musisz coś zacytować lub wyróżnić, używaj WYŁĄCZNIE pojedynczego apostrofu (') lub polskich cudzysłowów drukarskich („ oraz ”).
   Błędny przykład: "reply": "Inwestycja "zaprojektuj i wybuduj""
   Poprawny przykład: "reply": "Inwestycja 'zaprojektuj i wybuduj'" lub "reply": "Inwestycja „zaprojektuj i wybuduj”"
2. Odpowiedź musi być w 100% poprawnym i czystym obiektem JSON.

────────────────────────────────────────────────────────
ZADANIE A – PRZEDMIAR ROBÓT (GENERUJ SECTIONS)
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

function validateFile(file: { size: number; type: string; name: string }): ValidationResult {
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

// ── Pomocnik: buduje blok kontekstu trendów dla promptu ──────────────────────

function buildTrendsContext(trends: MarketTrends): string {
  const laborSign = trends.laborAdjustment >= 0 ? "+" : "";
  const materialSign = trends.materialAdjustment >= 0 ? "+" : "";
  const equipSign = trends.equipmentAdjustment >= 0 ? "+" : "";

  return `
PARAMETRY RYNKOWE USTAWIONE PRZEZ KOSZTORYSANTA (informacyjnie – nie doliczaj do cen bazowych):
- Korekta robocizny (R):    ${laborSign}${trends.laborAdjustment}%
- Korekta materiałów (M):   ${materialSign}${trends.materialAdjustment}%
- Korekta sprzętu (S):      ${equipSign}${trends.equipmentAdjustment}%
- Koszty pośrednie (Kp):    ${trends.kp}%
- Zysk kosztorysowy (Z):    ${trends.zysk}%
`.trim();
}

// ── FIX #5: SMART CHUNKING (INTELIGENTNE CIĘCIE PDF) ─────────────────────────

async function smartSlicePdf(
  arrayBuffer: ArrayBuffer,
  taskKeywords: string[] = []
): Promise<{ buffer: Buffer; sliced: boolean; foundPages: number[] }> {
  console.log(`[SmartSlicer] Uruchamiam inteligentne cięcie PDF. Słowa kluczowe zadania: [${taskKeywords.join(", ")}]`);

  const srcDoc = await PDFDocument.load(arrayBuffer);
  const pageCount = srcDoc.getPageCount();

  if (pageCount <= 12) {
    console.log(`[SmartSlicer] Plik ma tylko ${pageCount} stron. Przesyłam w całości bez cięcia.`);
    return { buffer: Buffer.from(arrayBuffer), sliced: false, foundPages: [] };
  }

  console.log(`[SmartSlicer] Plik jest duży (${pageCount} stron). KROK 1: Wyciągam spis treści (pierwsze 4 strony)...`);
  const tocDoc = await PDFDocument.create();
  const tocPages = await tocDoc.copyPages(srcDoc, [0, 1, 2, 3].filter(i => i < pageCount));
  tocPages.forEach(p => tocDoc.addPage(p));
  const tocBuffer = Buffer.from(await tocDoc.save());

  const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
    location: "global",
  });

  let targetPages: number[] = [];

  try {
    console.log(`[SmartSlicer] Pytam Gemini Flash o numery stron na podstawie spisu treści...`);
    const tocResponse = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{
        role: "user",
        parts: [
          { inlineData: { data: tocBuffer.toString("base64"), mimeType: "application/pdf" } },
          { text: `Przeanalizuj spis treści tego dokumentu. Znajdź numery stron dla tematów pasujących do słów kluczowych: [${taskKeywords.join(", ")}]. Zwróć TYLKO JSON (bez markdown): { "pages": [12, 13, 25] }. Jeśli nie ma spisu treści, zwróć: { "pages": [] }` }
        ]
      }],
      config: {
        temperature: 0.0,
        maxOutputTokens: 256,
        responseMimeType: "application/json",
      }
    });

    const parsed = JSON.parse(tocResponse.text ?? "{}");
    // Gemini zwraca numery stron (1-based), konwertujemy na indeksy (0-based)
    targetPages = (parsed.pages ?? [])
      .map((p: number) => p - 1)
      .filter((i: number) => i >= 0 && i < pageCount);

    console.log(`[SmartSlicer] AI wskazało strony (0-based): ${targetPages.join(", ")}`);
  } catch (e) {
    console.warn("[SmartSlicer] Nie udało się odczytać spisu treści przez AI. Fallback do metody 5+5.");
  }

  // KROK 2: Fallback jeśli AI nic nie znalazło
  if (targetPages.length === 0) {
    console.log(`[SmartSlicer] Fallback: Biorę 5 pierwszych i 5 ostatnich stron.`);
    const first = Array.from({ length: Math.min(5, pageCount) }, (_, i) => i);
    const last = Array.from({ length: Math.min(5, pageCount) }, (_, i) => pageCount - 1 - i).reverse();
    targetPages = Array.from(new Set([...first, ...last]));
  }

  // KROK 3: Wycinanie docelowych stron
  console.log(`[SmartSlicer] KROK 3: Wycinam i łączę wybrane strony...`);
  const dstDoc = await PDFDocument.create();
  const copiedPages = await dstDoc.copyPages(srcDoc, targetPages);
  copiedPages.forEach(p => dstDoc.addPage(p));

  return {
    buffer: Buffer.from(await dstDoc.save()),
    sliced: true,
    foundPages: targetPages.map(i => i + 1) // Zwracamy 1-based do logów
  };
}

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

  const contentType = req.headers.get("content-type") || "";
  let base64Data = "";
  let fileName = "";
  let fileType = "";
  let fileSize = 0;
  let trends: MarketTrends;
  let taskKeywords: string[] = [];

  // ── TRYB A: Obsługa żądania JSON wywołanego przez asynchroniczny Rój ──
  if (contentType.includes("application/json")) {
    console.log("[Czytacz Dokumentów] Wykryto żądanie typu JSON (Zadanie asynchroniczne Roju)...");

    try {
      const body = await req.json();
      const { fileUrl, trends: trendsRaw } = body;
      taskKeywords = body.taskKeywords || []; // Odbieramy słowa kluczowe z zadania

      trends = trendsRaw || { laborAdjustment: 0, materialAdjustment: 0, equipmentAdjustment: 0, kp: 65, zysk: 12 };

      if (!fileUrl) {
        return NextResponse.json({ error: "Brak parametru fileUrl w zadaniu." }, { status: 400 });
      }

      let arrayBuffer: ArrayBuffer;

      if (fileUrl.startsWith("http")) {
        console.log(`[Czytacz Dokumentów] Pobieram plik za pomocą linku HTTP: ${fileUrl}...`);
        const fileRes = await fetch(fileUrl);
        if (!fileRes.ok) throw new Error(`Błąd sieci HTTP ${fileRes.status}`);
        arrayBuffer = await fileRes.arrayBuffer();
        fileName = fileUrl.split("/").pop()?.split("?")[0] || "dokument.pdf";
        fileType = fileRes.headers.get("content-type") || "application/pdf";
      } else {
        console.log(`[Czytacz Dokumentów] Pobieram plik bezpośrednio z Firebase Storage: ${fileUrl}...`);
        const bucket = adminStorage.bucket();
        const fileObj = bucket.file(fileUrl);
        const [downloadedBuffer] = await fileObj.download();
        arrayBuffer = downloadedBuffer.buffer.slice(downloadedBuffer.byteOffset, downloadedBuffer.byteOffset + downloadedBuffer.byteLength);
        fileName = fileUrl.split("/").pop() || "dokument.pdf";
        fileType = fileName.toLowerCase().endsWith(".pdf") ? "application/pdf" : "application/octet-stream";
      }

      fileSize = arrayBuffer.byteLength;

      const validation = validateFile({ size: fileSize, type: fileType, name: fileName });
      if (!validation.valid) {
        return NextResponse.json({ error: validation.error }, { status: 422 });
      }

      if (fileType === "application/pdf") {
        const { buffer, sliced, foundPages } = await smartSlicePdf(arrayBuffer, taskKeywords);
        console.log(`[Czytacz Dokumentów] Wycięto strony: ${foundPages.join(", ")}`);
        base64Data = buffer.toString("base64");
      } else {
        base64Data = Buffer.from(arrayBuffer).toString("base64");
      }

    } catch (err: any) {
      console.error("[Czytacz Dokumentów] Błąd pobierania pliku ze Storage:", err);
      return NextResponse.json({ error: `Nie udało się pobrać pliku: ${err.message}` }, { status: 422 });
    }

    // ── TRYB B: Obsługa bezpośredniego uploadu z Dropzone (multipart/form-data) ──
  } else {
    console.log("[Czytacz Dokumentów] Wykryto żądanie typu multipart/form-data (Upload bezpośredni)...");

    let formData: FormData;
    try {
      formData = await req.formData();
    } catch (err) {
      console.error("[Czytacz Dokumentów] Błąd parsowania formData:", err);
      return NextResponse.json({ error: "Błąd odczytu danych formularza." }, { status: 400 });
    }

    const file = formData.get("file") as File | null;
    const trendsRaw = formData.get("trends") as string | null;

    if (!file) {
      return NextResponse.json({ error: 'Brak pliku "file" w żądaniu.' }, { status: 400 });
    }

    fileName = file.name;
    fileType = file.type;
    fileSize = file.size;

    const validation = validateFile(file);
    if (!validation.valid) {
      return NextResponse.json({ error: validation.error }, { status: 422 });
    }

    trends = parseTrends(trendsRaw);

    try {
      const arrayBuffer = await file.arrayBuffer();
      if (file.type === "application/pdf") {
        const { buffer, sliced, foundPages } = await smartSlicePdf(arrayBuffer, []); // Brak słów kluczowych przy ręcznym uploadzie
        console.log(`[Czytacz Dokumentów] Wycięto strony (fallback 5+5): ${foundPages.join(", ")}`);
        base64Data = buffer.toString("base64");
      } else {
        base64Data = Buffer.from(arrayBuffer).toString("base64");
      }
    } catch (err) {
      return NextResponse.json({ error: "Nie udało się odczytać zawartości pliku." }, { status: 422 });
    }
  }

  const trendsContext = buildTrendsContext(trends);

  const userPrompt = `
    Przeanalizuj plik: "${fileName}" (${SUPPORTED_MIME_TYPES[fileType] || "Nieznany"}, ${(fileSize / 1024).toFixed(0)} KB).
    Odpowiedz jako poprawny obiekt JSON. Pamiętaj: NIGDY nie używaj znaku " wewnątrz wartości tekstowych.
    
    ${trendsContext}
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
                mimeType: fileType,
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
      reply: `⚠️ Przeanalizowano dokument "${fileName}", ale struktura odpowiedzi nie mogła zostać odczytana jako JSON.`
    });
  }

  const responsePayload: RmsEngineResponse & { riskAlerts?: string[] } = {
    reply: parsed.reply ?? `Dokument "${fileName}" został pomyślnie przeanalizowany.`,
    ...(parsed.generatedSections?.length ? { generatedSections: parsed.generatedSections } : {}),
    ...(parsed.riskAlerts?.length ? { riskAlerts: parsed.riskAlerts } : {}),
  };

  console.log("[Czytacz Dokumentów] Zakończono sukcesem. Zwracam payload do klienta.");
  return NextResponse.json(responsePayload);
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({
    service: "PESAM Czytacz Dokumentów (Smart Slicer)",
    model: MODEL_PRO,
    supportedFormats: SUPPORTED_MIME_TYPES,
  });
}