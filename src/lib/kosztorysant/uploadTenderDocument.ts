/**
 * PESAM – Helper: uploadTenderDocument (Z AUTOMATYCZNYM WYBOREM ENDPOINTU PDF/ZIP)
 *
 * Ścieżka: src/lib/kosztorysant/uploadTenderDocument.ts
 */

import { MarketTrends, EstimateSection } from "@/app/api/kosztorysant/_shared/types";

// ── Typy ─────────────────────────────────────────────────────────────────────

export interface UploadParserResult {
  reply: string;
  generatedSections?: EstimateSection[];
  riskAlerts?: string[];
  tenderId?: string;    // <--- DODANE OPCJONALNE POLE DLA IMPORTU ZIP
  projectName?: string; // <--- DODANE OPCJONALNE POLE DLA IMPORTU ZIP
  filesCount?: number;  // <--- DODANE OPCJONALNE POLE DLA IMPORTU ZIP
}

export interface UploadProgress {
  stage: "uploading" | "analyzing" | "done" | "error";
  /** Wartość 0–100 dla etapu "uploading", undefined dla pozostałych */
  percent?: number;
  message: string;
}

type ProgressCallback = (progress: UploadProgress) => void;

// ── Stałe ────────────────────────────────────────────────────────────────────

const ENDPOINT_PDF = "/api/kosztorysant/upload-parser";
const ENDPOINT_ZIP = "/api/kosztorysant/magazynier-zip";

/** Limit po stronie klienta – Gemini przyjmuje do 19 MB, ale odrzucamy wcześniej */
export const MAX_UPLOAD_SIZE_BYTES = 250 * 1024 * 1024; // 250 MB

export const ACCEPTED_MIME_TYPES: Record<string, string> = {
  "application/pdf": ".pdf",
  "application/zip": ".zip",
  "application/x-zip-compressed": ".zip",
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

  // Osobny limit: 250 MB dla ZIP, 19 MB dla reszty (np. pojedynczych PDF)
  const isZip = file.name.endsWith(".zip");
  const limitBytes = isZip ? MAX_UPLOAD_SIZE_BYTES : 19 * 1024 * 1024;

  if (file.size > limitBytes) {
    const sizeMB = (file.size / 1024 / 1024).toFixed(1);
    const limitMB = (limitBytes / 1024 / 1024).toFixed(1);
    return `Plik jest za duży (${sizeMB} MB). Maksimum dla tego formatu to ${limitMB} MB.`;
  }
  if (!ACCEPTED_MIME_TYPES[file.type] && !isZip) {
    return `Nieobsługiwany format pliku "${file.name}". Prześlij ZIP, PDF, Excel, Word lub obraz.`;
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
    // Wybór odpowiedniego endpointu na podstawie rozszerzenia pliku
    const endpoint = file.name.endsWith(".zip") ? ENDPOINT_ZIP : ENDPOINT_PDF;

    // XMLHttpRequest daje nam rzeczywisty progress – fetch tego nie oferuje
    response = await uploadWithProgress(endpoint, formData, onProgress);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Błąd sieci podczas przesyłania.";
    onProgress?.({ stage: "error", message });
    throw new Error(message);
  }

  // Faza 2: Analiza AI (czekamy na odpowiedź modelu)
  const isZip = file.name.endsWith(".zip");
  onProgress?.({
    stage: "analyzing",
    message: isZip
      ? "Rozpakowywanie archiwum ZIP i rejestracja plików w bazie PESAM..."
      : "Gemini analizuje dokumentację przetargową… (może potrwać 20–60 sekund)",
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

  // Dla ZIP-a nie sprawdzamy "reply" na wejściu, bo Magazynier zwraca meta-dane rozpakowania
  if (!isZip && !result.reply) {
    const msg = "Serwer zwrócił niekompletną odpowiedź (brak pola reply).";
    onProgress?.({ stage: "error", message: msg });
    throw new Error(msg);
  }

  onProgress?.({ stage: "done", message: isZip ? "ZIP pomyślnie rozpakowany – Rój rozpoczął pracę!" : "Analiza zakończona – tabela RMS gotowa." });

  return result;
}

// ── XMLHttpRequest z progress dla dużych plików ───────────────────────────────

function uploadWithProgress(
  endpoint: string,
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
      const syntheticResponse = new Response(xhr.responseText, {
        status: xhr.status,
        statusText: xhr.statusText,
        headers: { "Content-Type": "application/json" },
      });
      resolve(syntheticResponse);
    });

    // ZNAJDŹ TEN FRAGMENT I PODMIEŃ:

    xhr.addEventListener("error", () => {
      reject(new Error("Połączenie z serwerem zostało przerwane."));
    });

    xhr.addEventListener("timeout", () => {
      reject(new Error("Przekroczono limit czasu połączenia (30 minut). Proces może być zbyt duży."));
    });

    xhr.open("POST", endpoint); // <--- DYNAMICZNY ENDPOINT
    xhr.timeout = 1800_000; // ZMIANA: 1 800 000 ms = 30 minut (zamiast 90 000)
    xhr.send(formData);
  });
}