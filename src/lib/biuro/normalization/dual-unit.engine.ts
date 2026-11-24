// src/lib/biuro/normalization/dual-unit.engine.ts
//
// Podagent Reprezentacji Dwutorowej (Dual-Unit State Engine)
// Tworzy nienaruszalny stan dwutorowy:
// Tor 1 (RAW) - nienaruszony obraz dokumentu źródłowego z papieru WZ
// Tor 2 (NORMALIZED) - ujednolicony format kosztorysowy PESAM (m2, mb, szt, kg)
// Zgodny ze specyfikacją biuro-ai.md §Część 2/3

import { ReconciledItem, TorRawItem, TorNormalizedItem, ItemConversionMetadata } from '@/types/biuro/reconciledDelivery.types';
import { VendorCatalogItem } from '@/types/biuro/vendorCatalog.types';
import { DeterministicMathEngine } from './deterministic-math.engine';
import { DiscoveredGeometryResult } from './dimensional-discovery.agent';

export interface RawInputItem {
  lp: number;
  raw_name: string;
  quantity: number;
  raw_unit: string;
  unit_price_net?: number | null;
  total_net?: number | null;
  vat_rate?: number | null;
}

export class DualUnitEngine {
  /**
   * Generuje dwutorowy rekord pozycji z zachowaniem żelaznej reguły niezmienności sumy netto
   */
  static processItem(params: {
    raw: RawInputItem;
    vendorRule?: VendorCatalogItem | null;
    discoveredGeometry?: DiscoveredGeometryResult | null;
  }): ReconciledItem {
    const { raw, vendorRule, discoveredGeometry } = params;

    const rawUnitPrice = raw.unit_price_net || (raw.total_net && raw.quantity > 0 ? DeterministicMathEngine.roundCurrency(raw.total_net / raw.quantity) : 0);
    const rawTotalNet = raw.total_net || DeterministicMathEngine.roundCurrency(raw.quantity * rawUnitPrice);

    // ── Tor 1: Dane Surowe z Papieru (RAW) ──
    const torRaw: TorRawItem = {
      name: raw.raw_name,
      quantity: raw.quantity,
      unit: raw.raw_unit || 'szt',
      unit_price_net: rawUnitPrice,
      total_net: rawTotalNet,
      vat_rate: raw.vat_rate !== null && raw.vat_rate !== undefined ? raw.vat_rate : 23,
    };

    // ── Dobór reguły konwersji (Pamięć dostawcy -> Odkrycie geometrii -> 1:1) ──
    let multiplier = 1.0;
    let formula = '1:1';
    let source: ItemConversionMetadata['source'] = 'DEFAULT_1TO1';
    let canonicalId = 'MAT-UNKNOWN';
    let canonicalName = raw.raw_name;
    let accountingUnit = (raw.raw_unit === 'm2' || raw.raw_unit === 'mb' || raw.raw_unit === 'kg') ? raw.raw_unit : 'szt';
    let confidence = 0.5;
    let requiresHitl = false;
    let hitlNote: string | undefined;

    if (vendorRule) {
      multiplier = vendorRule.conversion_rule.multiplier;
      formula = vendorRule.conversion_rule.formula;
      source = 'VENDOR_PROFILE_CACHE';
      canonicalId = vendorRule.canonical_product_id;
      canonicalName = vendorRule.canonical_name;
      accountingUnit = vendorRule.pesam_accounting_unit;
      confidence = vendorRule.confidence_score;
    } else if (discoveredGeometry) {
      multiplier = discoveredGeometry.conversion_rule.multiplier;
      formula = discoveredGeometry.conversion_rule.formula;
      source = 'AUTO_GEOMETRY_DISCOVERY';
      canonicalId = discoveredGeometry.canonical_product_id;
      canonicalName = discoveredGeometry.canonical_name;
      accountingUnit = discoveredGeometry.pesam_accounting_unit;
      confidence = discoveredGeometry.confidence_score;
      if (!discoveredGeometry.is_high_confidence) {
        requiresHitl = true;
        hitlNote = discoveredGeometry.hitl_reason || 'Niska pewność przelicznika geometrii';
      }
    }

    // ── Deterministyczne Przeliczenie Matematyczne ──
    const mathResult = DeterministicMathEngine.convertDualUnit({
      rawQuantity: torRaw.quantity,
      rawUnitPriceNet: torRaw.unit_price_net,
      multiplier,
      operation: 'MULTIPLY',
    });

    // ── Tor 2: Dane Znormalizowane PESAM (NORMALIZED) ──
    const torNormalized: TorNormalizedItem = {
      standard_name: canonicalName,
      quantity: mathResult.normalizedQuantity,
      unit: accountingUnit as any,
      unit_price_net: mathResult.normalizedUnitPriceNet,
      total_net: mathResult.normalizedTotalNet,
    };

    const conversion: ItemConversionMetadata = {
      multiplier,
      formula,
      source,
      confidence,
    };

    return {
      lp: raw.lp,
      canonical_id: canonicalId,
      raw: torRaw,
      normalized: torNormalized,
      conversion,
      requires_hitl_approval: requiresHitl,
      hitl_note: hitlNote,
    };
  }
}
