// src/types/biuro/matchingPolicy.types.ts
//
// Konfiguracja Polityki Zgodności w Firestore (settings/biuro_matching_policy)
// Zgodny ze specyfikacją biuro-ai.md §Część 3/3

export interface BiuroMatchingPolicy {
  // Progi dla Weryfikacji Głosu Kierowcy
  voice_rules: {
    require_checksum_match: boolean;      // Czy liczba wierszy musi się zgadzać w 100% (domyślnie: true)
    require_anchor_match: boolean;        // Czy towar kotwiczący musi wystąpić na WZ (domyślnie: true)
    allow_partial_item_coverage: boolean; // Czy zezwalać na brak wymienienia drobnicy montażowej
    low_value_item_threshold_pln: number; // np. 30.00 PLN (pozycje poniżej tej kwoty traktowane jako drobnica)
  };

  // Progi dla Parowania z Fakturą KSeF
  ksef_reconciliation_rules: {
    max_price_variance_pct: number;       // np. 5.0 (odchyłka ceny do +5% przechodzi, powyżej -> blokada)
    auto_approve_discounts: boolean;      // Jeśli hurtownia dała niższą cenę niż na WZ -> zawsze auto-akceptacja
    date_window_tolerance_days: number;   // np. 35 dni (maksymalny rozstęp między datą WZ a fakturą KSeF)
  };

  // Uprawnienia do zatwierdzania HITL
  approvals: {
    require_director_above_pln: number;   // np. 5000.00 PLN (odchyłki powyżej tej kwoty wymagają akceptacji Zarządu)
  };
}

export const DEFAULT_BIURO_MATCHING_POLICY: BiuroMatchingPolicy = {
  voice_rules: {
    require_checksum_match: true,
    require_anchor_match: true,
    allow_partial_item_coverage: true,
    low_value_item_threshold_pln: 30.0,
  },
  ksef_reconciliation_rules: {
    max_price_variance_pct: 5.0,
    auto_approve_discounts: true,
    date_window_tolerance_days: 35,
  },
  approvals: {
    require_director_above_pln: 5000.0,
  },
};
