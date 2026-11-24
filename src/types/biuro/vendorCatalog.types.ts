// src/types/biuro/vendorCatalog.types.ts
//
// Schemat Dokumentu Pozycji Dostawcy w Firestore (vendor_catalogs/{nip}/items/{item_hash})
// Zgodny ze specyfikacją biuro-ai.md §Część 2/3

export type PesamAccountingUnit = 'm2' | 'mb' | 'szt' | 'kg' | 'kpl' | 'l' | 'm3';

export interface VendorConversionRule {
  multiplier: number;               // np. 3.0 (dla 3 metrów bieżących z 1 sztuki)
  formula: string;                  // np. "1 szt = 3.0 mb" lub "1.25m * 2.50m = 3.125 m2"
  operation: 'MULTIPLY' | 'DIVIDE' | 'STATIC';
}

export interface VendorCatalogItem {
  vendor_nip: string;                 // np. "8722410651"
  vendor_raw_name: string;            // np. "PROFIL C-50/3 MB MFO /10/200/"
  clean_lookup_key: string;           // np. "PROFIL_C_50_3_MB_MFO" (oczyszczone ze znaków specjalnych)
  vendor_invoiced_unit: string;       // np. "szt" (jednostka, w której ta hurtownia zwykła fakturować)

  // Powiązanie z Kanonem PESAM
  canonical_product_id: string;       // np. "MAT-STAL-C50"
  canonical_name: string;             // np. "Profil stalowy ścienny C-50"
  pesam_accounting_unit: PesamAccountingUnit; // Standard kosztorysowy PESAM

  // Twarda reguła konwersji jednostek
  conversion_rule: VendorConversionRule;

  // Metadane zaufania i pętli samouczenia
  confidence_score: number;           // 0.0 do 1.0 (1.0 = zatwierdzony przez człowieka)
  learned_source: 'AUTO_GEOMETRY_DISCOVERY' | 'HUMAN_VERIFIED' | 'HISTORICAL_IMPORT' | 'PRESEEDED';
  usage_count: number;                // Ile razy z powodzeniem użyto tej reguły
  last_used_at: string;               // ISO Timestamp
}
