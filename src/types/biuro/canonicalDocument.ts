// src/types/biuro/canonicalDocument.ts
//
// Zunifikowany Kontrakt Wyjściowy Modułu 1 (Canonical Ingest Contract)
// Każdy agent roboczy (KSeF, FastPath, Vision, Audio) zwraca dane w tym samym standardzie.

export type DocumentSourceType = 'KSEF_XML' | 'PDF_DIGITAL' | 'SCAN_VISION' | 'DRIVER_AUDIO';

export interface CanonicalIngestPayload {
  // Metadane Ingestii (ślad audytowy A2A)
  meta: {
    ingest_id: string;             // Unikalny identyfikator procesu (np. ING-20261124-xxxx)
    timestamp: string;             // ISO-8601
    source_type: DocumentSourceType;
    processed_by_agent: string;    // np. "Agent-KSeF" | "Agent-FastPath" | "Agent-Vision" | "Agent-Audio"
    fallback_occurred: boolean;    // Czy zadziałał mechanizm ratunkowy A2A
    fallback_reason?: string;      // Uzasadnienie fallbacku (jeśli wystąpił)
    cost_usd: number;              // Dokładny szacowany koszt operacji (0.00 dla KSeF i FastPath)
    confidence_score: number;      // Poziom pewności (1.0 dla KSeF, ~0.95 dla FastPath, ~0.85 dla Vision/Audio)
    execution_time_ms: number;     // Czas wykonania całego procesu w ms
  };

  // Dane nagłówkowe
  document: {
    type: 'WZ' | 'FAKTURA' | 'NOTATKA_KIEROWCY' | 'NIEZNANY';
    number: string | null;         // np. "WZT/963/11/2026/DE"
    issue_date: string | null;     // format "YYYY-MM-DD"
    seller: {
      name: string | null;
      nip: string | null;
    };
    buyer: {
      name: string | null;
      nip: string | null;
    };
    target_site_hint: string | null; // np. "Kielce Przychodnia" (z nagłówka lub głosu)
  };

  // Surowe pozycje (przed normalizacją w Module 2)
  items: Array<{
    lp: number;
    raw_name: string;             // np. "regipsy" lub "PROFIL C-50/3 MB"
    quantity: number;
    raw_unit: string;             // np. "szt", "m2", "op"
    unit_price_net: number | null;
    total_net: number | null;
    vat_rate: number | null;
  }>;

  // Podsumowanie finansowe
  totals: {
    total_net: number | null;
    total_vat: number | null;
    total_gross: number | null;
    currency: 'PLN' | 'EUR';
  };
}
