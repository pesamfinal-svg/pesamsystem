/**
 * PESAM – Helper: uploadTenderDocument
 *
 * Ścieżka: src/lib/kosztorysant/uploadTenderDocument.ts
 *
 * Wysyła plik przetargowy z Dropzone do endpointu /api/kosztorysant/upload-parser
 * i zwraca sparsowany wynik gotowy do wstrzyknięcia w stan strony EstimatorPage.
 *
 * Użycie w komponencie:
 *   const result = await uploadTenderDocument(file, currentTrends, onProgress);
 *   if (result.generatedSections) setSections(result.generatedSections);
 *   if (result.riskAlerts)        setRiskAlerts(result.riskAlerts);
 *   setMessages(prev => [...prev, { role: "ai", content: result.reply }]);
 */

import { MarketTrends, EstimateSection } from "@/app/api/kosztorysant/_shared/types";

// ── Typy ─────────────────────────────────────────────────────────────────────

export interface UploadParserResult {
  reply: string;
  generatedSections?: EstimateSection[];
  riskAlerts?: string[];
}

export interface UploadProgress {
  stage: "uploading" | "analyzing" | "done" | "error";
  /** Wartość 0–100 dla etapu "uploading", undefined dla pozostałych */
  percent?: number;
  message: string;
}

type ProgressCallback = (progress: UploadProgress) => void;

// ── Stałe ────────────────────────────────────────────────────────────────────

const ENDPOINT = "/api/kosztorysant/upload-parser";

/** Limit po stronie klienta – Gemini przyjmuje do 19 MB, ale odrzucamy wcześniej */
export const MAX_UPLOAD_SIZE_BYTES = 19 * 1024 * 1024;

export const ACCEPTED_MIME_TYPES: Record<string, string> = {
  "application/pdf": ".pdf",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

// ── Walidacja po stronie klienta (przed fetch) ────────────────────────────────

export function validateFileClient(file: File): string | null {
  if (file.size === 0) {
    return "Plik jest pusty.";
  }
  if (file.size > MAX_UPLOAD_SIZE_BYTES) {
    const sizeMB = (file.size / 1024 / 1024).toFixed(1);
    return `Plik jest za duży (${sizeMB} MB). Maksimum to 19 MB.`;
  }
  if (!ACCEPTED_MIME_TYPES[file.type]) {
    return `Nieobsługiwany format pliku "${file.name}". Prześlij PDF, Excel, Word lub obraz.`;
  }
  return null; // OK
}

// ── Główna funkcja wysyłająca ─────────────────────────────────────────────────

export async function uploadTenderDocument(
  file: File,
  trends: MarketTrends,
  onProgress?: ProgressCallback
): Promise<UploadParserResult> {

  // Walidacja klienta
  const clientError = validateFileClient(file);
  if (clientError) {
    onProgress?.({ stage: "error", message: clientError });
    throw new Error(clientError);
  }

  // Budowanie FormData
  const formData = new FormData();
  formData.append("file", file);
  formData.append("trends", JSON.stringify(trends));

  // Faza 1: Upload
  onProgress?.({
    stage: "uploading",
    percent: 0,
    message: `Przesyłanie dokumentu "${file.name}"…`,
  });

  let response: Response;
  try {
    // XMLHttpRequest daje nam rzeczywisty progress – fetch tego nie oferuje
    response = await uploadWithProgress(formData, onProgress);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Błąd sieci podczas przesyłania.";
    onProgress?.({ stage: "error", message });
    throw new Error(message);
  }

  // Faza 2: Analiza AI (czekamy na odpowiedź modelu)
  onProgress?.({
    stage: "analyzing",
    message: "Gemini analizuje dokumentację przetargową… (może potrwać 20–60 sekund)",
  });

  if (!response.ok) {
    let errorMsg = `Błąd serwera: HTTP ${response.status}`;
    try {
      const errBody = await response.json();
      if (errBody.error) errorMsg = errBody.error;
    } catch {
      // Ignoruj błąd parsowania treści błędu
    }
    onProgress?.({ stage: "error", message: errorMsg });
    throw new Error(errorMsg);
  }

  // Parsowanie odpowiedzi
  let result: UploadParserResult;
  try {
    result = await response.json();
  } catch {
    const msg = "Nie udało się odczytać odpowiedzi serwera (nieprawidłowy JSON).";
    onProgress?.({ stage: "error", message: msg });
    throw new Error(msg);
  }

  if (!result.reply) {
    const msg = "Serwer zwrócił niekompletną odpowiedź (brak pola reply).";
    onProgress?.({ stage: "error", message: msg });
    throw new Error(msg);
  }

  onProgress?.({ stage: "done", message: "Analiza zakończona – tabela RMS gotowa." });

  return result;
}

// ── XMLHttpRequest z progress dla dużych plików ───────────────────────────────

function uploadWithProgress(
  formData: FormData,
  onProgress?: ProgressCallback
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) {
        const percent = Math.round((event.loaded / event.total) * 100);
        onProgress?.({
          stage: "uploading",
          percent,
          message: `Przesyłanie: ${percent}%`,
        });
      }
    });

    xhr.addEventListener("load", () => {
      // Tworzymy syntetyczny obiekt Response kompatybilny z fetch API
      const syntheticResponse = new Response(xhr.responseText, {
        status: xhr.status,
        statusText: xhr.statusText,
        headers: { "Content-Type": "application/json" },
      });
      resolve(syntheticResponse);
    });

    xhr.addEventListener("error", () => {
      reject(new Error("Połączenie z serwerem zostało przerwane."));
    });

    xhr.addEventListener("timeout", () => {
      reject(new Error("Przekroczono limit czasu połączenia (90 sekund)."));
    });

    xhr.open("POST", ENDPOINT);
    xhr.timeout = 90_000; // 90 sekund – Gemini Pro na dużym PDF może potrzebować czasu
    xhr.send(formData);
  });
}