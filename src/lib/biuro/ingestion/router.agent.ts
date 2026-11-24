// src/lib/biuro/ingestion/router.agent.ts
//
// Agent Dyspozytor (Ingestion Router Agent)
// Lekki, w 100% deterministyczny agent (0 zł kosztu, 2-10 ms).
// Bada nagłówki pliku, sygnatury binarne i warstwę tekstową,
// po czym wybiera dedykowanego agenta roboczego.

import { detectDocumentTextLayer, DetectionResult } from '@/lib/pdf/text-layer-detector';
import { DocumentSourceType } from '@/types/biuro/canonicalDocument';

export type WorkerAgentType = 'Agent-KSeF' | 'Agent-FastPath' | 'Agent-Vision' | 'Agent-Audio';

export interface RouteDecision {
  targetAgent: WorkerAgentType;
  sourceType: DocumentSourceType;
  reason: string;
  detectionDetails?: DetectionResult;
}

export class IngestionRouterAgent {
  /**
   * Analizuje surowy bufor pliku oraz metadane wejściowe.
   */
  static inspect(buffer: Buffer, fileName: string, mimeType?: string): RouteDecision {
    const lowerName = fileName.toLowerCase();

    // 1. Sprawdzenie JSON (KSeF API / Canonical Payload)
    const isJson = (
      mimeType === 'application/json' ||
      lowerName.endsWith('.json') ||
      buffer.subarray(0, 50).toString('utf-8').trim().startsWith('{')
    );

    if (isJson) {
      return {
        targetAgent: 'Agent-KSeF',
        sourceType: 'KSEF_JSON',
        reason: 'Wykryto ustrukturyzowany strumień JSON (format KSeF API / Canonical Ingest). Kierowany do bezpośredniego parsera danych (0 zł).'
      };
    }

    // 2. Sprawdzenie XML / KSeF
    const isXml = (
      mimeType === 'text/xml' ||
      mimeType === 'application/xml' ||
      lowerName.endsWith('.xml')
    );

    if (isXml) {
      const headerSnippet = buffer.subarray(0, 1500).toString('utf-8');
      const isKsef = (
        headerSnippet.includes('<Faktura') ||
        headerSnippet.includes('crd:KSeF') ||
        headerSnippet.includes('schemat.ksef') ||
        headerSnippet.includes('FA_VAT')
      );

      if (isKsef) {
        return {
          targetAgent: 'Agent-KSeF',
          sourceType: 'KSEF_XML',
          reason: 'Wykryto ustrukturyzowany plik XML faktury KSeF (FA_VAT). Kierowany do deterministycznego parsera XML (0 zł).'
        };
      }
    }

    // 2. Sprawdzenie Audio (dyktafon kierowcy)
    const isAudio = (
      mimeType?.startsWith('audio/') ||
      lowerName.endsWith('.mp3') ||
      lowerName.endsWith('.m4a') ||
      lowerName.endsWith('.wav') ||
      lowerName.endsWith('.ogg') ||
      lowerName.endsWith('.aac')
    );

    if (isAudio) {
      return {
        targetAgent: 'Agent-Audio',
        sourceType: 'DRIVER_AUDIO',
        reason: 'Plik dźwiękowy z nagraniem kierowcy. Kierowany do agenta transkrypcji i intencji STT.'
      };
    }

    // 3. Sprawdzenie Obrazu (zdjęcia ze smartfona, skany JPG/PNG)
    const isImage = (
      mimeType?.startsWith('image/') ||
      lowerName.endsWith('.jpg') ||
      lowerName.endsWith('.jpeg') ||
      lowerName.endsWith('.png') ||
      lowerName.endsWith('.webp') ||
      lowerName.endsWith('.bmp') ||
      lowerName.endsWith('.tiff')
    );

    if (isImage) {
      return {
        targetAgent: 'Agent-Vision',
        sourceType: 'SCAN_VISION',
        reason: 'Plik graficzny (zdjęcie z kabiny auta lub skan). Wymagana analiza wizyjna OCR.'
      };
    }

    // 4. Sprawdzenie PDF (deterministyczna detekcja warstwy tekstowej)
    const isPdf = (
      mimeType === 'application/pdf' ||
      lowerName.endsWith('.pdf') ||
      buffer.subarray(0, 5).toString('ascii').startsWith('%PDF')
    );

    if (isPdf) {
      const detection = detectDocumentTextLayer(buffer, fileName, mimeType);

      if (detection.hasTextLayer) {
        return {
          targetAgent: 'Agent-FastPath',
          sourceType: 'PDF_DIGITAL',
          reason: `Wykryto cyfrową warstwę tekstową w PDF (${detection.extractedCharactersCount} znaków, ${detection.detectedMetadata?.hasFonts ? 'czcionki' : 'strumienie'}). Kierowany do szybkiej ścieżki (Fast Path, 0 zł).`,
          detectionDetails: detection
        };
      } else {
        return {
          targetAgent: 'Agent-Vision',
          sourceType: 'SCAN_VISION',
          reason: 'Plik PDF nie posiada cyfrowej warstwy tekstowej (jest to skan lub zdjęcie osadzone w PDF). Kierowany do agenta wizyjnego.',
          detectionDetails: detection
        };
      }
    }

    // Domyślny fallback: próba odczytu wizyjnego
    return {
      targetAgent: 'Agent-Vision',
      sourceType: 'SCAN_VISION',
      reason: 'Nierozpoznany format pliku – domyślne skierowanie do uniwersalnego agenta wizyjnego.'
    };
  }
}
