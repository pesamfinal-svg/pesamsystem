// src/lib/biuro/normalization/ksef-reconciler.ts
//
// Silnik Uzgadniania Faktur Zbiorczych KSeF (KSeFReconciler)
// Wykorzystuje reprezentację dwutorową:
// Match = Match(KSeF, Tor_RAW) OR Match(KSeF, Tor_NORMALIZED)
// Oblicza odchyłkę cenową i egzekwuje progi tolerancji (np. max +5%)
// Zgodny ze specyfikacją biuro-ai.md §Część 3/3

import { ReconciledDelivery, KSeFMatchResult, ReconciledItem } from '@/types/biuro/reconciledDelivery.types';
import { BiuroMatchingPolicy, DEFAULT_BIURO_MATCHING_POLICY } from '@/types/biuro/matchingPolicy.types';
import { DeterministicMathEngine } from './deterministic-math.engine';

export interface KSeFInvoiceInputItem {
  name: string;
  quantity: number;
  unit: string;
  unit_price_net: number;
  total_net: number;
  vat_rate?: number;
}

export interface KSeFInvoiceInput {
  invoice_number: string;
  invoice_date: string;
  vendor_nip: string;
  vendor_name?: string;
  items: KSeFInvoiceInputItem[];
  total_net: number;
}

export class KSeFReconciler {
  /**
   * Uzgadnia wiersze faktury KSeF ze zbuforowanymi dostawami w reconciled_deliveries
   */
  static reconcileInvoice(params: {
    ksefInvoice: KSeFInvoiceInput;
    deliveries: ReconciledDelivery[];
    policy?: BiuroMatchingPolicy;
  }): KSeFMatchResult {
    const { ksefInvoice, deliveries, policy = DEFAULT_BIURO_MATCHING_POLICY } = params;
    const maxVariance = policy.ksef_reconciliation_rules.max_price_variance_pct;
    const autoDiscounts = policy.ksef_reconciliation_rules.auto_approve_discounts;

    // Zbierz wszystkie pozycje z powiązanych dostaw danego dostawcy
    const sanitizedVendorNip = (ksefInvoice.vendor_nip || '').replace(/\D/g, '');
    const candidateDeliveries = deliveries.filter(d => 
      (d.parties.vendor.nip || '').replace(/\D/g, '') === sanitizedVendorNip
    );

    const flattenedWzItems: Array<{ deliveryId: string; item: ReconciledItem }> = [];
    for (const d of candidateDeliveries) {
      for (const item of d.items) {
        flattenedWzItems.push({ deliveryId: d.reconciliation_id, item });
      }
    }

    const matchedResults: KSeFMatchResult['item_matches'] = [];
    let matchedTotalNet = 0;
    let hasPriceAlert = false;
    let hasUnmatched = false;

    // Przetwarzaj każdy wiersz z KSeF
    for (const kItem of ksefInvoice.items) {
      const matchOutcome = this.matchSingleItem(kItem, flattenedWzItems);

      if (matchOutcome.match_track === 'UNMATCHED') {
        hasUnmatched = true;
        matchedResults.push({
          ksef_item_name: kItem.name,
          ksef_quantity: kItem.quantity,
          ksef_unit: kItem.unit,
          ksef_price_net: kItem.unit_price_net,
          ksef_total_net: kItem.total_net,
          match_track: 'UNMATCHED',
          wz_price_net: null,
          variance_pct: null,
          variance_amount: null,
          status: 'UNMATCHED',
          alert_reason: 'Pozycja nie występuje na żadnym zbuforowanym kwicie WZ dla tego dostawcy.',
        });
        continue;
      }

      // Wylicz odchyłkę cenową
      const wzPrice = matchOutcome.wzPrice;
      const varianceResult = DeterministicMathEngine.calculatePriceVariance({
        priceWz: wzPrice,
        priceKsef: kItem.unit_price_net,
      });

      // Sprawdź politykę progową tolerancji
      let status: 'AUTO_APPROVED' | 'HITL_PRICE_ALERT' = 'AUTO_APPROVED';
      let alertReason: string | undefined;

      if (varianceResult.variancePct > maxVariance) {
        status = 'HITL_PRICE_ALERT';
        hasPriceAlert = true;
        alertReason = `🚨 Przekroczono limit tolerancji (+${varianceResult.variancePct}% > ${maxVariance}%). Wykryto podwyżkę o +${varianceResult.varianceAmount.toFixed(2)} zł/jedn.`;
      } else if (varianceResult.isPriceDecrease && autoDiscounts) {
        status = 'AUTO_APPROVED';
        alertReason = `Cena niższa niż na WZ (rabat -${Math.abs(varianceResult.variancePct)}%). Automatycznie zaakceptowano.`;
      } else {
        status = 'AUTO_APPROVED';
        alertReason = varianceResult.isIdentical
          ? '100% zgodności cenowej z WZ.'
          : `Odchyłka w granicach tolerancji (${varianceResult.variancePct > 0 ? '+' : ''}${varianceResult.variancePct}%).`;
      }

      matchedTotalNet = DeterministicMathEngine.roundCurrency(matchedTotalNet + kItem.total_net);

      matchedResults.push({
        ksef_item_name: kItem.name,
        ksef_quantity: kItem.quantity,
        ksef_unit: kItem.unit,
        ksef_price_net: kItem.unit_price_net,
        ksef_total_net: kItem.total_net,
        matched_reconciled_id: matchOutcome.matchedDeliveryId,
        matched_lp: matchOutcome.matchedLp,
        match_track: matchOutcome.match_track,
        wz_price_net: wzPrice,
        variance_pct: varianceResult.variancePct,
        variance_amount: varianceResult.varianceAmount,
        status,
        alert_reason: alertReason,
      });
    }

    let overallStatus: KSeFMatchResult['overall_status'] = 'FULLY_MATCHED';
    if (hasUnmatched) overallStatus = 'MISSING_WZ_ITEMS';
    else if (hasPriceAlert) overallStatus = 'PRICE_DISCREPANCY';

    return {
      invoice_number: ksefInvoice.invoice_number,
      invoice_date: ksefInvoice.invoice_date,
      vendor_nip: ksefInvoice.vendor_nip,
      item_matches: matchedResults,
      total_net_ksef: ksefInvoice.total_net,
      total_net_wz_matched: matchedTotalNet,
      overall_status: overallStatus,
    };
  }

  /**
   * Pojedynczy test dopasowania z alternatywą logiczną: Tor RAW || Tor NORMALIZED
   */
  private static matchSingleItem(
    kItem: KSeFInvoiceInputItem,
    candidates: Array<{ deliveryId: string; item: ReconciledItem }>
  ): {
    match_track: 'RAW' | 'NORMALIZED' | 'UNMATCHED';
    wzPrice: number;
    matchedDeliveryId?: string;
    matchedLp?: number;
  } {
    const kName = kItem.name.toUpperCase();
    const kTokens = kName.split(/[\s,/-]+/).filter(t => t.length > 2);

    // ── Wariant 1: Sprawdź zgodność z Torem RAW (dokładna jednostka ze sztuk) ──
    for (const cand of candidates) {
      const raw = cand.item.raw;
      const rawName = raw.name.toUpperCase();
      const rawTokens = rawName.split(/[\s,/-]+/).filter(t => t.length > 2);
      const tokenOverlap = kTokens.filter(t => rawTokens.includes(t)).length;

      const isNameClose = tokenOverlap >= 2 || kName.includes(rawName) || rawName.includes(kName);
      if (isNameClose) {
        // Sprawdź ilość w torze RAW
        const isQtyClose = DeterministicMathEngine.verifyQuantityMatch(kItem.quantity, raw.quantity, 5.0);
        if (isQtyClose) {
          return {
            match_track: 'RAW',
            wzPrice: raw.unit_price_net,
            matchedDeliveryId: cand.deliveryId,
            matchedLp: cand.item.lp,
          };
        }
      }
    }

    // ── Wariant 2: Sprawdź zgodność z Torem NORMALIZED (np. metry kwadratowe / bieżące) ──
    for (const cand of candidates) {
      const norm = cand.item.normalized;
      const normName = norm.standard_name.toUpperCase();
      const normTokens = normName.split(/[\s,/-]+/).filter(t => t.length > 2);
      const tokenOverlap = kTokens.filter(t => normTokens.includes(t)).length;

      const isNameClose = tokenOverlap >= 2 || kName.includes(normName) || normName.includes(kName);
      if (isNameClose) {
        // Sprawdź ilość w torze NORMALIZED
        const isQtyClose = DeterministicMathEngine.verifyQuantityMatch(kItem.quantity, norm.quantity, 5.0);
        if (isQtyClose) {
          return {
            match_track: 'NORMALIZED',
            wzPrice: norm.unit_price_net,
            matchedDeliveryId: cand.deliveryId,
            matchedLp: cand.item.lp,
          };
        }
      }
    }

    // ── Wariant 3: Dopasowanie po łącznej wartości netto pozycji (jeśli nazwa pasuje) ──
    for (const cand of candidates) {
      const raw = cand.item.raw;
      const rawName = raw.name.toUpperCase();
      const isNameClose = kTokens.some(t => rawName.includes(t));
      if (isNameClose && Math.abs(kItem.total_net - raw.total_net) <= 0.05) {
        return {
          match_track: 'RAW',
          wzPrice: raw.unit_price_net,
          matchedDeliveryId: cand.deliveryId,
          matchedLp: cand.item.lp,
        };
      }
    }

    return {
      match_track: 'UNMATCHED',
      wzPrice: 0,
    };
  }
}
