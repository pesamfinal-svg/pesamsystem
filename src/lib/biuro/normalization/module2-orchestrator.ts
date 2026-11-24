// src/lib/biuro/normalization/module2-orchestrator.ts
//
// Główny Mózg Orkiestrujący Modułu 2 (Module 2 Orchestrator)
// Zarządza sekwencją wywołań zespołów podagentów:
// 1. VoiceAnchorMatcher (Suma kontrolna + Kotwica meldunku kierowcy)
// 2. VendorMemoryAgent (Lokalny słownik dialektów per NIP w Firestore)
// 3. DimensionalDiscoveryAgent (Odkrywanie geometrii i samouczenie)
// 4. DeterministicMathEngine (Deterministyczne bankowe przeliczenia bez LLM)
// 5. DualUnitEngine (Generowanie nienaruszalnego stanu Tor RAW + Tor NORMALIZED)
// 6. Zapis w kolekcji Firestore `reconciled_deliveries`
// Zgodny ze specyfikacją biuro-ai.md §Część 1/3 i §5

import { db } from '@/lib/firebase/config';
import { doc, setDoc } from 'firebase/firestore';
import { CanonicalIngestPayload } from '@/types/biuro/canonicalDocument';
import { ReconciledDelivery, ReconciledItem, ReconciledStatus, FinancialSummary } from '@/types/biuro/reconciledDelivery.types';
import { BiuroMatchingPolicy, DEFAULT_BIURO_MATCHING_POLICY } from '@/types/biuro/matchingPolicy.types';
import { VendorMemoryAgent } from './vendor-memory.agent';
import { DimensionalDiscoveryAgent } from './dimensional-discovery.agent';
import { VoiceAnchorMatcher } from './voice-anchor.matcher';
import { DualUnitEngine } from './dual-unit.engine';
import { DeterministicMathEngine } from './deterministic-math.engine';

export interface Module2ExecutionParams {
  canonicalPayload: CanonicalIngestPayload;
  driverAudioNote?: {
    text: string;
    audioRef?: string;
    driverName?: string;
  };
  policy?: BiuroMatchingPolicy;
  persistToFirestore?: boolean;
}

export class Module2Orchestrator {
  /**
   * Główny potok wykonawczy Modułu 2
   */
  static async process(params: Module2ExecutionParams): Promise<ReconciledDelivery> {
    const startTime = performance.now();
    const { canonicalPayload, driverAudioNote, policy = DEFAULT_BIURO_MATCHING_POLICY, persistToFirestore = true } = params;

    const vendorNip = (canonicalPayload.document.seller.nip || '').replace(/\D/g, '');
    const vendorName = canonicalPayload.document.seller.name || 'NIEZNANY DOSTAWCA';
    const buyerNip = (canonicalPayload.document.buyer.nip || '8720004013').replace(/\D/g, '');
    const buyerName = canonicalPayload.document.buyer.name || 'PESAM SPÓŁKA Z O.O. SP. K.';
    const targetSite = canonicalPayload.document.target_site_hint || 'PLAC CENTRALNY';

    // ── 1. PODAGENT WERYFIKACJI KOTWICY (VoiceAnchorMatcher) ──
    const driverAudit = VoiceAnchorMatcher.verify({
      driverText: driverAudioNote?.text || '',
      driverAudioRef: driverAudioNote?.audioRef,
      driverName: driverAudioNote?.driverName,
      wzItems: canonicalPayload.items.map(it => ({
        lp: it.lp,
        name: it.raw_name,
        quantity: it.quantity,
        unit: it.raw_unit
      })),
      wzVendorName: vendorName,
      wzVendorNip: vendorNip,
      wzTargetSite: targetSite,
      policy,
    });

    // ── 2. PODAGENCI POZYCJI: VENDOR MEMORY + DIMENSIONAL DISCOVERY + DUAL UNIT ──
    const reconciledItems: ReconciledItem[] = [];
    let requiresHitlLearning = false;

    for (const rawItem of canonicalPayload.items) {
      // Krok 2a: Próba trafienia w pamięć profilu dostawcy (Fast Cache: 0 ms, 0 zł)
      let vendorRule = await VendorMemoryAgent.lookupItem(vendorNip, rawItem.raw_name);
      let discoveredGeometry = null;

      // Krok 2b: Jeśli brak wpisu -> Odkrywanie Geometrii
      if (!vendorRule) {
        discoveredGeometry = await DimensionalDiscoveryAgent.discover({
          rawName: rawItem.raw_name,
          rawUnit: rawItem.raw_unit,
          vendorNip,
        });

        // Autonomiczna Pętla Samouczenia: jeśli pewność >= 0.95, zapisz na stałe
        if (discoveredGeometry.is_high_confidence && vendorNip) {
          await VendorMemoryAgent.saveLearnedRule({
            vendor_nip: vendorNip,
            vendor_raw_name: rawItem.raw_name,
            clean_lookup_key: VendorMemoryAgent.cleanKey(rawItem.raw_name),
            vendor_invoiced_unit: rawItem.raw_unit,
            canonical_product_id: discoveredGeometry.canonical_product_id,
            canonical_name: discoveredGeometry.canonical_name,
            pesam_accounting_unit: discoveredGeometry.pesam_accounting_unit,
            conversion_rule: discoveredGeometry.conversion_rule,
            confidence_score: discoveredGeometry.confidence_score,
            learned_source: 'AUTO_GEOMETRY_DISCOVERY',
            usage_count: 1,
            last_used_at: new Date().toISOString(),
          });
        } else if (!discoveredGeometry.is_high_confidence) {
          requiresHitlLearning = true;
        }
      }

      // Krok 2c: Podagent Reprezentacji Dwutorowej + Agent Matematyk
      const itemRecord = DualUnitEngine.processItem({
        raw: rawItem,
        vendorRule,
        discoveredGeometry,
      });

      reconciledItems.push(itemRecord);
    }

    // ── 3. PODSUMOWANIE FINANSOWE (Agent Matematyk) ──
    const mathTotals = DeterministicMathEngine.calculateTotals(
      reconciledItems.map(it => ({ total_net: it.raw.total_net, vat_rate: it.raw.vat_rate }))
    );

    const docNumber = canonicalPayload.document.number || `WZ-${Date.now()}`;
    const cleanDocRef = docNumber.replace(/[^A-Za-z0-9]/g, '').substring(0, 15);
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const reconciliationId = `REC-${dateStr}-${cleanDocRef || 'DOC'}-001`;

    // ── 4. STATUS KOŃCOWY (Reconciliation Verdict) ──
    let status: ReconciledStatus = 'AUTO_RECONCILED';
    if (driverAudioNote?.text && !driverAudit.is_physically_confirmed) {
      status = 'PENDING_HITL_VOICE';
    } else if (requiresHitlLearning) {
      status = 'PENDING_HITL_LEARNING';
    }

    const financialSummary: FinancialSummary = {
      total_net_wz: mathTotals.totalNet,
      total_vat_wz: mathTotals.totalVat,
      total_gross_wz: mathTotals.totalGross,
      ksef_matched_invoice_no: null,
      ksef_price_variance_pct: null,
      budget_status: 'CHARGED_TO_SITE',
    };

    const executionTimeMs = Math.round(performance.now() - startTime);

    const result: ReconciledDelivery = {
      reconciliation_id: reconciliationId,
      metadata: {
        created_at: new Date().toISOString(),
        status,
        confidence_score: status === 'AUTO_RECONCILED' ? 1.0 : 0.85,
        source_wz_id: canonicalPayload.meta.ingest_id || `ING-${cleanDocRef}`,
        source_type: canonicalPayload.meta.source_type,
        processing_time_ms: executionTimeMs,
      },
      parties: {
        vendor: {
          nip: vendorNip,
          name: vendorName,
        },
        buyer: {
          nip: buyerNip,
          name: buyerName,
        },
        target_site: targetSite,
      },
      driver_audit: driverAudit,
      items: reconciledItems,
      financial_summary: financialSummary,
    };

    // ── 5. ZAPIS W FIRESTORE (reconciled_deliveries) ──
    if (persistToFirestore) {
      try {
        const deliveryDocRef = doc(db, 'reconciled_deliveries', reconciliationId);
        await setDoc(deliveryDocRef, result, { merge: true });
      } catch (err) {
        console.warn('[Module2Orchestrator] Firestore delivery persistence warning:', err);
      }
    }

    return result;
  }
}
