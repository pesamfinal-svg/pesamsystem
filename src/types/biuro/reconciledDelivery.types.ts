// src/types/biuro/reconciledDelivery.types.ts
//
// Zunifikowany Kontrakt Wyjściowy Modułu 2 (Reconciled Delivery Contract)
// Zapisywany w kolekcji Firestore `reconciled_deliveries/{reconciliation_id}`
// Zgodny ze specyfikacją biuro-ai.md §5

import { PesamAccountingUnit } from './vendorCatalog.types';

export type ReconciledStatus = 
  | 'AUTO_RECONCILED'
  | 'PENDING_HITL_VOICE'
  | 'PENDING_HITL_PRICE'
  | 'PENDING_HITL_LEARNING'
  | 'MANUALLY_APPROVED'
  | 'REJECTED';

export interface DriverAuditInfo {
  verification_method: 'CHECKSUM_AND_ANCHOR' | 'DIRECT_ITEM_MATCH' | 'NONE';
  is_physically_confirmed: boolean;
  declared_line_count?: number;
  actual_line_count?: number;
  line_count_matched?: boolean;
  anchor_item?: string;
  anchor_quantity_matched?: boolean;
  driver_audio_ref?: string;
  driver_audio_text?: string;
  verdict_reason?: string;
  driver_name?: string;
}

export interface TorRawItem {
  name: string;
  quantity: number;
  unit: string;
  unit_price_net: number;
  total_net: number;
  vat_rate?: number;
}

export interface TorNormalizedItem {
  standard_name: string;
  quantity: number;
  unit: PesamAccountingUnit;
  unit_price_net: number;
  total_net: number;
}

export interface ItemConversionMetadata {
  multiplier: number;
  formula: string;
  source: 'VENDOR_PROFILE_CACHE' | 'AUTO_GEOMETRY_DISCOVERY' | 'MANUAL' | 'DEFAULT_1TO1';
  confidence?: number;
}

export interface ReconciledItem {
  lp: number;
  canonical_id: string;
  raw: TorRawItem;
  normalized: TorNormalizedItem;
  conversion: ItemConversionMetadata;
  requires_hitl_approval?: boolean;
  hitl_note?: string;
}

export interface FinancialSummary {
  total_net_wz: number;
  total_vat_wz: number;
  total_gross_wz: number;
  ksef_matched_invoice_no?: string | null;
  ksef_price_variance_pct?: number | null;
  budget_status: 'CHARGED_TO_SITE' | 'PENDING_MATCH' | 'DISCREPANCY_FLAGGED' | 'MANUALLY_OVERRIDDEN';
  ksef_match_track?: 'TOR_RAW' | 'TOR_NORMALIZED' | 'NONE';
}

export interface ReconciledDelivery {
  reconciliation_id: string; // np. "REC-20261124-WZT963-001"
  metadata: {
    created_at: string; // ISO-8601
    status: ReconciledStatus;
    confidence_score: number;
    source_wz_id: string;
    source_type?: string;
    processing_time_ms?: number;
  };
  parties: {
    vendor: {
      nip: string;
      name: string;
    };
    buyer: {
      nip: string;
      name: string;
    };
    target_site: string;
  };
  driver_audit: DriverAuditInfo;
  items: ReconciledItem[];
  financial_summary: FinancialSummary;
}

export interface KSeFMatchResult {
  invoice_number: string;
  invoice_date: string;
  vendor_nip: string;
  item_matches: Array<{
    ksef_item_name: string;
    ksef_quantity: number;
    ksef_unit: string;
    ksef_price_net: number;
    ksef_total_net: number;
    matched_reconciled_id?: string;
    matched_lp?: number;
    match_track: 'RAW' | 'NORMALIZED' | 'UNMATCHED';
    wz_price_net: number | null;
    variance_pct: number | null;
    variance_amount: number | null;
    status: 'AUTO_APPROVED' | 'HITL_PRICE_ALERT' | 'UNMATCHED';
    alert_reason?: string;
  }>;
  total_net_ksef: number;
  total_net_wz_matched: number;
  overall_status: 'FULLY_MATCHED' | 'PRICE_DISCREPANCY' | 'MISSING_WZ_ITEMS';
}
