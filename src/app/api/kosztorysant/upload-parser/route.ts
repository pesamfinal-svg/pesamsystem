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
Zidentyfikuj wszystkie działy robót i pozycje przedmiarowe w dokumencie.
Jeśli dokument zawiera "ślepy kosztorys" (tabela z pozycjami bez cen) – odczytaj
go bezpośrednio. Jeśli dokument to SWZ/PFU/opis techniczny – wyinterpretuj zakres
robót z treści i stwórz kompletny przedmiar.

Zasady tworzenia pozycji RMS:
- Każda pozycja musi mieć realny kod KNR/KNNR w formacie "KNR X-XX XXXX-XX"
- Typ pozycji:
  "R" = Robocizna → jednostka r-g, cena = stawka godzinowa netto 2025
  "M" = Materiał  → jednostka branżowa (m³, m², kg, szt., mb), cena hurtowa netto 2025
  "S" = Sprzęt    → jednostka m-g lub kurs, koszt pracy sprzętu
- Ceny bazowe NETTO 2025 (bez trendów rynkowych, bez Kp, bez Zysku):
  Robocizna budowlana:    38–52 PLN/r-g (śr. 44 PLN)
  Betoniarz/zbrojarz:     44–58 PLN/r-g
  Beton C20/25:           360–390 PLN/m³
  Beton C25/30:           380–420 PLN/m³
  Beton C30/37:           410–460 PLN/m³
  Stal B500SP (pręty):    3,90–4,50 PLN/kg
  Stal S235 (profile):    4,20–5,10 PLN/kg
  Bloczek silikatowy 18: 8–11 PLN/szt.
  Gazobeton 24cm (Ytong): 12–16 PLN/szt.
  Cegła klinkierowa:      2,80–4,50 PLN/szt.
  Membrana EPDM:          28–38 PLN/m²
  Papa termozgrzewalna:   18–26 PLN/m²
  Dachówka ceramiczna:    65–95 PLN/m²
  Blacha trapezowa:       32–52 PLN/m²
  Płytki ceramiczne (śr): 55–90 PLN/m²
  Tynk maszynowy:         22–34 PLN/m²
  Styropian EPS 15cm:     28–42 PLN/m²
  Wełna mineralna 15cm:   38–56 PLN/m²
  Rura PE dn110:          32–52 PLN/mb
  Koparka kołowa (m-g):   180–260 PLN/m-g
  Transport wywrotką 10km: 120–180 PLN/kurs
- Ilości: pobierz z dokumentu lub oszacuj na podstawie wymiarów/kubatur.
  Uwzględnij straty technologiczne: beton+3%, stal+5%, tynki+8%, płytki+10%.
- Zachowaj logiczny podział na działy branżowe (roboty ziemne, stan zero,
  stan surowy, dach, instalacje, wykończenia, zagospodarowanie terenu itp.)

────────────────────────────────────────────────────────
ZADANIE B – ANALIZA RYZYK KONTRAKTOWYCH (GENERUJ RISKALERTS)
────────────────────────────────────────────────────────
Przeszukaj dokument pod kątem klauzul ryzyka:
- Kary umowne (za opóźnienie, za wady, za odstąpienie od umowy)
- Gwarancje jakości i rękojmie (standardem jest 36 mies.; >60 mies. = ryzyko)
- Wymogi certyfikacyjne materiałów (BREEAM, CE, krajowe aprobaty techniczne)
- Termin realizacji (ocen realność względem zakresu)
- Warunki płatności (prefinansowanie, zaliczki, harmonogram fakturowania)
- Wymagania doświadczenia wykonawcy (lata, wartości referencji, kadra)
- Kody CPV (określają branżę i możliwe podwykonawstwo)
- Zabezpieczenie należytego wykonania (% wartości, czas utrzymania)

Format każdego alertu (jedno konkretne zdanie bez użycia znaku "):
"⚠️ UWAGA: [opis ryzyka i jego wartość/parametr z dokumentu]"
"❗ RYZYKO: [opis ryzyka wysokiego / blokera ofertowego]"
"✅ OK: [klauzula zgodna ze standardem rynkowym]"
"ℹ️ INFO: [neutralna informacja przydatna Kosztorysantowi]"

────────────────────────────────────────────────────────
ZADANIE C – KOMENTARZ INŻYNIERSKI (GENERUJ REPLY)
────────────────────────────────────────────────────────
Napisz profesjonalne podsumowanie w 5-8 zdaniach.
Używaj profesjonalnego stylu. Nie stosuj znaku " wewnątrz tekstu (używaj pojedynczego apostrofu ').
Podawaj konkretne liczby i nazwy (nie 'duże kary' tylko 'kara 10 000 zł/dzień').

════════════════════════════════════════════════════════
FORMAT ODPOWIEDZI: WYŁĄCZNIE JSON (bez markdown, bez komentarzy, bez tekstu poza JSON)
════════════════════════════════════════════════════════

{
  "reply": "string – komentarz inżynierski (Zadanie C)",
  "generatedSections": [
    {
      "id": "sec-1",
      "name": "Dział 1. Nazwa działu robót",
      "items": [
        {
          "id": "item-1-1",
          "code": "KNR 2-01 0210-02",
          "name": "Pełna opisowa nazwa pozycji kosztorysowej",
          "type": "R",
          "quantity": 150.0,
          "unit": "r-g",
          "basePrice": 44.00,
          "unitPrice": 44.00
        }
      ]
    }
  ],
  "riskAlerts": [
    "⚠️ UWAGA: Kara umowna 0,1% wartości/dzień = 15 000 zł/dzień przy budżecie 15 mln PLN.",
    "✅ OK: Termin realizacji 18 miesięcy jest realny dla podanego zakresu kubaturowego."
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
    return NextResponse.json(
      { error: 'Brak pliku w żądaniu. Upewnij się że pole formData nosi nazwę "file".' },
      { status: 400 }
    );
  }

  // ── 2. Walidacja pliku ────────────────────────────────────────────────────

  const validation = validateFile(file);
  if (!validation.valid) {
    return NextResponse.json(
      { error: validation.error },
      { status: 422 }
    );
  }

  // ── 3. Parsowanie parametrów ──────────────────────────────────────────────

  const trends = parseTrends(trendsRaw);
  const trendsContext = buildTrendsContext(trends);

  // ── 4. Konwersja pliku do Base64 ──────────────────────────────────────────

  let base64Data: string;
  try {
    const arrayBuffer = await file.arrayBuffer();
    base64Data = Buffer.from(arrayBuffer).toString("base64");
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

    if (!rawAiText.trim()) {
      throw new Error("Model zwrócił pustą odpowiedź.");
    }
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

  // ── 6. Parsowanie JSON z odpowiedzi AI ───────────────────────────────────

  let parsed: any = null;

  try {
    // Po włączeniu responseMimeType, odpowiedź to w 100% czysty JSON
    parsed = JSON.parse(sanitizedText);
  } catch (parseErr) {
    console.warn("[Upload Parser] Standardowy JSON.parse zawiódł, używam ekstraktora awaryjnego...");
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
    console.warn("[Upload Parser] Nie udało się sparsować JSON. Surowa odpowiedź:", rawAiText.slice(0, 500));
    const fallbackResponse: RmsEngineResponse = {
      reply:
        `⚠️ System przeanalizował dokument "${file.name}", ale struktura odpowiedzi nie mogła zostać automatycznie odczytana. ` +
        `Spróbuj ponownie lub prześlij dokument w postaci PDF tekstowego (wygenerowanego cyfrowo).`,
    };
    return NextResponse.json(fallbackResponse);
  }

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