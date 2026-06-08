/**
 * PESAM – Helper: uploadTenderDocument
 * Jednolity system uploadu obsługujący zarówno pojedyncze pliki PDF/XLSX, jak i paczki ZIP.
 * Przekierowuje cały ruch do Agenta Magazyniera, który inicjuje zsynchronizowany Rój PESAM.
 */

import { MarketTrends, EstimateSection } from "@/app/api/kosztorysant/_shared/types";

// ── Typy ─────────────────────────────────────────────────────────────────────

export interface UploadParserResult {
  reply?: string;
  generatedSections?: EstimateSection[];
  riskAlerts?: string[];
  tenderId?: string;
  projectName?: string;
  filesCount?: number;
}

export interface UploadProgress {
  stage: "uploading" | "analyzing" | "done" | "error";
  /** Wartość 0–100 dla etapu "uploading", undefined dla pozostałych */
  percent?: number;
  message: string;
}

type ProgressCallback = (progress: UploadProgress) => void;

// ── Stałe ────────────────────────────────────────────────────────────────────

// JEDEN ENDPOINT DLA WSZYSTKIEGO! Magazynier radzi sobie z ZIP-ami i pojedynczymi plikami.
const ENDPOINT_UNIFIED = "/api/kosztorysant/magazynier-zip";

/** Limit po stronie klienta: duże pliki na projekty rozbijamy wg wagi */
export const MAX_UPLOAD_SIZE_BYTES = 250 * 1024 * 1024; // 250 MB dla archiwów

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

  // Osobny limit: 250 MB dla ZIP, 25 MB dla reszty (np. pojedynczych PDF)
  const isZip = file.name.toLowerCase().endsWith(".zip");
  const limitBytes = isZip ? MAX_UPLOAD_SIZE_BYTES : 25 * 1024 * 1024;

  if (file.size > limitBytes) {
    const sizeMB = (file.size / 1024 / 1024).toFixed(1);
    const limitMB = (limitBytes / 1024 / 1024).toFixed(1);
    return `Plik jest za duży (${sizeMB} MB). Maksimum dla tego formatu to ${limitMB} MB.`;
  }

  if (!ACCEPTED_MIME_TYPES[file.type] && !isZip) {
    return `Nieobsługiwany format pliku "${file.name}". Prześlij ZIP, PDF, Excel, Word lub obraz.`;
  }

  return null; // Wszystko OK
}

// ── Główna funkcja wysyłająca ─────────────────────────────────────────────────

export async function uploadTenderDocument(
  files: FileList | File[] | File,
  trends: MarketTrends,
  onProgress?: ProgressCallback
): Promise<UploadParserResult> {

  // Normalizacja wejścia do stabilnej tablicy plików
  const fileList = files instanceof FileList
    ? Array.from(files)
    : Array.isArray(files)
      ? files
      : [files];

  if (fileList.length === 0) {
    const err = "Brak plików do przesłania.";
    onProgress?.({ stage: "error", message: err });
    throw new Error(err);
  }

  // Walidacja wszystkich plików przed uderzeniem do serwera
  for (const file of fileList) {
    const clientError = validateFileClient(file);
    if (clientError) {
      const formattedError = `${file.name}: ${clientError}`;
      onProgress?.({ stage: "error", message: formattedError });
      throw new Error(formattedError);
    }
  }

  const formData = new FormData();
  // Dodanie każdego pliku pod klucz "file"
  fileList.forEach(file => {
    formData.append("file", file);
  });
  formData.append("trends", JSON.stringify(trends));

  const fileNames = fileList.map(f => f.name).join(", ");
  onProgress?.({
    stage: "uploading",
    percent: 0,
    message: `Przesyłanie plików [${fileNames}]…`,
  });

  let response: Response;
  try {
    response = await uploadWithProgress(ENDPOINT_UNIFIED, formData, onProgress);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Błąd sieci podczas przesyłania.";
    onProgress?.({ stage: "error", message });
    throw new Error(message);
  }

  const hasZip = fileList.some(f => f.name.toLowerCase().endsWith(".zip"));
  onProgress?.({
    stage: "analyzing",
    message: "Rejestracja w bazie i inicjalizacja Roju PESAM... (oczekuj na statusy w panelu bocznym)",
  });

  if (!response.ok) {
    let errorMsg = `Błąd serwera: HTTP ${response.status}`;
    try {
      const errBody = await response.json();
      if (errBody.error) errorMsg = errBody.error;
    } catch {
      // Jeśli serwer zwrócił HTML, zostaw domyślny status
    }
    onProgress?.({ stage: "error", message: errorMsg });
    throw new Error(errorMsg);
  }

  let result: UploadParserResult;
  try {
    result = await response.json();
  } catch {
    const msg = "Nie udało się odczytać odpowiedzi serwera (nieprawidłowy JSON).";
    onProgress?.({ stage: "error", message: msg });
    throw new Error(msg);
  }

  if (!result.tenderId) {
    const msg = "Serwer przetworzył plik, ale nie zwrócił identyfikatora przetargu.";
    onProgress?.({ stage: "error", message: msg });
    throw new Error(msg);
  }

  result.reply = `Pliki [${fileNames}] zostały pomyślnie zmagazynowane w bazie. Rój PESAM rozpoczął przetwarzanie zadań równoległych w tle. Statusy aktualizują się w panelu po lewej stronie.`;

  onProgress?.({
    stage: "done",
    message: hasZip ? "Archiwum ZIP przetworzone. Rój aktywny!" : "Dokumenty pomyślnie zainicjowane. Rój aktywny!"
  });

  return result;
}

// ── XMLHttpRequest z progress bar'em dla dużych plików ────────────────────────

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
          message: `Przesyłanie do chmury: ${percent}%`,
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

    xhr.addEventListener("error", () => {
      reject(new Error("Połączenie z serwerem zostało przerwane (Błąd Sieciowy)."));
    });

    xhr.addEventListener("timeout", () => {
      reject(new Error("Przekroczono limit czasu połączenia (30 minut). Spróbuj ponownie."));
    });

    xhr.open("POST", endpoint);
    xhr.timeout = 1800_000; // 30 minut (dla wielkich projektów)
    xhr.send(formData);
  });
}