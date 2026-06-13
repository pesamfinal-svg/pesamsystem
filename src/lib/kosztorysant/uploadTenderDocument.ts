/**
 * PESAM – Helper: uploadTenderDocument
 * Nowoczesny, bezserwerowy system przesyłania bezpośrednio do Google Cloud Storage (Signed URLs).
 * Eliminuje błędy pamięci serwera Next.js i limity wielkości plików.
 */

import { MarketTrends, EstimateSection } from "@/app/api/kosztorysant/_shared/types";
import { db } from "@/lib/firebase/config";
import { collection, doc, setDoc } from "firebase/firestore";

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

export const MAX_UPLOAD_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB na pojedynczy plik bezpośrednio do GCS

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

// ── Walidacja po stronie klienta (przed GCS Signed URL) ──────────────────────

export function validateFileClient(file: File): string | null {
  if (file.size === 0) {
    return "Plik jest pusty.";
  }

  const isZip = file.name.toLowerCase().endsWith(".zip");
  if (isZip) {
    return "Przesyłanie plików ZIP zostało wyłączone na rzecz stabilności serwera. Proszę zaznaczyć i przesłać pliki PDF/XLSX bezpośrednio w oknie wyboru plików.";
  }

  if (file.size > MAX_UPLOAD_SIZE_BYTES) {
    const sizeMB = (file.size / 1024 / 1024).toFixed(1);
    const limitMB = (MAX_UPLOAD_SIZE_BYTES / 1024 / 1024).toFixed(1);
    return `Plik jest za duży (${sizeMB} MB). Maksimum dla bezpośredniego przesyłu to ${limitMB} MB.`;
  }

  if (!ACCEPTED_MIME_TYPES[file.type]) {
    return `Nieobsługiwany format pliku "${file.name}". Prześlij bezpośrednio pliki PDF, Excel, Word lub obrazy.`;
  }

  return null; // Wszystko OK
}

// ── Główna funkcja wysyłająca bezpośrednio do Google Cloud Storage ────────────

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

  onProgress?.({
    stage: "uploading",
    percent: 1,
    message: "Inicjalizacja rejestru bazy danych dla przetargu...",
  });

  let tenderId = "";
  try {
    // 1. Rejestracja unikalnego ID przetargu w Firestore na kliencie
    const tendersRef = collection(db, "tenders");
    const newTenderDocRef = doc(tendersRef);
    tenderId = newTenderDocRef.id;

    // 2. Utworzenie głównego dokumentu przetargu
    await setDoc(newTenderDocRef, {
      status: "CLASSIFYING",
      createdAt: new Date(),
      updatedAt: new Date(),
      marketTrends: trends,
      budgetGuard: {
        maxBudgetUSD: 5.0,
        currentCostUSD: 0,
        limitReached: false,
        iterationCount: 0,
        maxIterations: 50
      }
    });

    const fileNames = fileList.map(f => f.name).join(", ");
    const totalFiles = fileList.length;

    // 3. Seryjne przesyłanie plików bezpośrednio do Google Cloud Storage (Signed URLs)
    for (let i = 0; i < totalFiles; i++) {
      const file = fileList[i];
      const fileIndex = i;

      // KROK A: Pobranie jednorazowego klucza zapisu Signed URL z serwera
      const urlRes = await fetch("/api/kosztorysant/generuj-url-gcs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenderId,
          fileName: file.name,
          mimeType: file.type
        })
      });

      if (!urlRes.ok) {
        const errData = await urlRes.json();
        throw new Error(`Nie udało się wygenerować bezpiecznego linku dla ${file.name}: ${errData.error}`);
      }

      const { url, storagePath } = await urlRes.json();

      // KROK B: Przesłanie pliku bezpośrednio do GCS przez XMLHttpRequest z progress barem
      await uploadFileToSignedUrlWithProgress(url, file, (filePercent) => {
        // Obliczanie globalnego procentu dla wszystkich przesyłanych plików
        const globalPercent = Math.round(((fileIndex * 100) + filePercent) / totalFiles);
        onProgress?.({
          stage: "uploading",
          percent: globalPercent,
          message: `Przesyłanie bezpośrednie GCS: ${file.name} (${filePercent}%)`,
        });
      });

      // KROK C: Rejestracja dokumentu w podkolekcji Firestore
      const docRef = doc(collection(db, `tenders/${tenderId}/documents`));
      await setDoc(docRef, {
        fileName: file.name,
        storagePath,
        mimeType: file.type || "application/octet-stream",
        sizeBytes: file.size,
        status: "UPLOADED",
        createdAt: new Date()
      });
    }

    onProgress?.({
      stage: "analyzing",
      message: "Dokumenty pomyślnie zapisane w chmurze. Wybudzanie Klasyfikatora (Faza 0)...",
    });

    // 4. Asynchroniczne wybudzenie Klasyfikatora (Fazy 0)
    const initRes = await fetch("/api/kosztorysant/glowny-kosztorysant/inicjalizuj", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenderId })
    });

    if (!initRes.ok) {
      console.warn("[UPLOAD CLIENT] Klasyfikator nie odpowiedział synchronicznie, proces ruszy asynchronicznie w tle.");
    }

    onProgress?.({
      stage: "done",
      message: "Wszystkie dokumenty zainicjowane pomyślnie. Rój PESAM 3.0 aktywny!",
    });

    return {
      tenderId,
      projectName: `Przetarg ${tenderId.slice(0, 6)}`,
      filesCount: totalFiles,
      reply: `Dokumenty [${fileNames}] zostały pomyślnie przetransferowane bezpośrednio do chmury Google Cloud Storage. Rój rozpoczął pracę.`
    };

  } catch (err: any) {
    const message = err instanceof Error ? err.message : "Błąd sieci podczas bezpośredniego przesyłania.";
    onProgress?.({ stage: "error", message });
    throw new Error(message);
  }
}

// ── XMLHttpRequest dla PUT bezpośrednio do GCS ──────────────────────────────

function uploadFileToSignedUrlWithProgress(
  url: string,
  file: File,
  onFileProgress: (percent: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) {
        const percent = Math.round((event.loaded / event.total) * 100);
        onFileProgress(percent);
      }
    });

    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new Error(`Błąd przesyłania bezpośredniego do GCS: Status HTTP ${xhr.status}`));
      }
    });

    xhr.addEventListener("error", () => {
      reject(new Error("Połączenie z serwerem Google Cloud Storage zostało przerwane."));
    });

    xhr.addEventListener("timeout", () => {
      reject(new Error("Przekroczono limit czasu połączenia z Google Cloud Storage (30 minut)."));
    });

    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.timeout = 1800_000; // 30 minut
    xhr.send(file);
  });
}