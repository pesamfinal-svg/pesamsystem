// src/types/biuro/matchingPolicy.types.ts
//
// Konfiguracja Polityki Zgodności w Firestore (settings/biuro_matching_policy)
// Zgodny ze specyfikacją biuro-ai.md oraz zaawansowanymi tolerancjami PESAM 3.0

export interface BiuroMatchingPolicy {
  // Progi i tolerancje dla Weryfikacji Głosu Kierowcy
  voice_rules: {
    require_checksum_match: boolean;             // Czy włączać test sumy wierszy
    max_row_count_discrepancy: number;          // Dopuszczalna różnica wierszy (np. 0 = ścisła, 1, 2, 3 pozycje)
    allow_missing_row_count_declaration: boolean; // Czy zezwalać na brak podania liczby pozycji, jeśli kotwica się zgadza
    require_anchor_match: boolean;               // Czy towar kotwiczący musi wystąpić na WZ
    anchor_quantity_tolerance_pct: number;       // Dopuszczalna odchyłka ilości kotwicy (np. 0.0 do 10.0%)
    auto_approve_without_driver_note_below_pln: number; // Próg kwotowy WZ auto-zatwierdzanej bez nagrania (np. 300.00 PLN)
    allow_partial_item_coverage: boolean;        // Czy zezwalać na brak wymienienia drobnicy montażowej
    low_value_item_threshold_pln: number;        // np. 40.00 PLN (pozycje poniżej tej kwoty traktowane jako drobnica)
  };

  // Progi dla Parowania z Fakturą KSeF
  ksef_reconciliation_rules: {
    max_price_variance_pct: number;              // np. 5.0% (odchyłka ceny do +5% przechodzi, powyżej -> blokada)
    auto_approve_discounts: boolean;             // Jeśli hurtownia dała niższą cenę niż na WZ -> auto-akceptacja
    date_window_tolerance_days: number;          // np. 35 dni (maksymalny rozstęp między datą WZ a fakturą KSeF)
  };

  // Uprawnienia do zatwierdzania HITL
  approvals: {
    require_director_above_pln: number;          // np. 5000.00 PLN (odchyłki powyżej tej kwoty wymagają akceptacji Zarządu)
  };

  // Pętla Samouczenia Katalogu Dostawców
  auto_learning: {
    confidence_threshold: number;                // np. 0.95 (od jakiej pewności automatycznie zapisać w profilu NIP)
  };
}

export const DEFAULT_BIURO_MATCHING_POLICY: BiuroMatchingPolicy = {
  voice_rules: {
    require_checksum_match: true,
    max_row_count_discrepancy: 1, // Domyślnie dopuszczamy +/- 1 pozycję drobnicy
    allow_missing_row_count_declaration: true, // Jeśli kierowca podał tylko kotwicę (np. 6 płyt OSB), nie blokujemy
    require_anchor_match: true,
    anchor_quantity_tolerance_pct: 5.0, // Tolerancja +/- 5% na ilości kotwicy
    auto_approve_without_driver_note_below_pln: 300.0, // WZ do 300 zł netto przechodzi z automatu bez głosu
    allow_partial_item_coverage: true,
    low_value_item_threshold_pln: 40.0,
  },
  ksef_reconciliation_rules: {
    max_price_variance_pct: 5.0,
    auto_approve_discounts: true,
    date_window_tolerance_days: 35,
  },
  approvals: {
    require_director_above_pln: 5000.0,
  },
  auto_learning: {
    confidence_threshold: 0.95,
  },
};
