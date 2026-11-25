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
import { doc, getDoc, setDoc, collection, getDocs } from 'firebase/firestore';
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
    const { canonicalPayload, driverAudioNote, persistToFirestore = true } = params;

    // Pobierz aktualną politykę z Firestore jeśli nie przekazano jawnie
    let policy = params.policy;
    if (!policy) {
      try {
        const policySnap = await getDoc(doc(db, 'settings', 'biuro_matching_policy'));
        if (policySnap.exists()) {
          policy = policySnap.data() as BiuroMatchingPolicy;
        }
      } catch {
        // ignore
      }
      if (!policy) policy = DEFAULT_BIURO_MATCHING_POLICY;
    }

    const vendorNip = (canonicalPayload.document.seller.nip || '').replace(/\D/g, '');
    const vendorName = canonicalPayload.document.seller.name || 'NIEZNANY DOSTAWCA';
    const buyerNip = (canonicalPayload.document.buyer.nip || '8720004013').replace(/\D/g, '');
    const buyerName = canonicalPayload.document.buyer.name || 'PESAM SPÓŁKA Z O.O. SP. K.';
    const rawSiteHint = canonicalPayload.document.target_site_hint || '';

    // ── 0. DOPASOWANIE DO LISTY BUDÓW Z FIRESTORE (sites) ──
    let matchedSiteId: string | null = null;
    let matchedSiteName: string = rawSiteHint || 'Nie przypisano';

    try {
      const sitesSnap = await getDocs(collection(db, 'sites'));
      const activeSites = sitesSnap.docs.map(d => ({ id: d.id, ...(d.data() as any) }));
      const hintTokens = rawSiteHint.toUpperCase().split(/[\s,/-]+/).filter(t => t.length > 2);

      if (hintTokens.length > 0 && activeSites.length > 0) {
        let bestScore = 0;
        for (const site of activeSites) {
          const siteText = `${site.name || ''} ${site.location || ''}`.toUpperCase();
          const score = hintTokens.filter(t => siteText.includes(t)).length;
          if (score > bestScore) {
            bestScore = score;
            matchedSiteId = site.id;
            matchedSiteName = site.name || site.location;
          }
        }
      }
    } catch (err) {
      console.warn('[Module2Orchestrator] Sites lookup warning:', err);
    }

    const targetSite = matchedSiteName;

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

    // ── 2. PODAGENCI POZYCJI (RÓWNOLEGLE DLA MAKSYMALNEJ SZYBKOŚCI) ──
    let requiresHitlLearning = false;

    const reconciledItems: ReconciledItem[] = await Promise.all(
      canonicalPayload.items.map(async (rawItem) => {
        let vendorRule = await VendorMemoryAgent.lookupItem(vendorNip, rawItem.raw_name);
        let discoveredGeometry = null;

        if (!vendorRule) {
          discoveredGeometry = await DimensionalDiscoveryAgent.discover({
            rawName: rawItem.raw_name,
            rawUnit: rawItem.raw_unit,
            vendorNip,
          });

          const minConf = policy?.auto_learning?.confidence_threshold ?? 0.95;
          if (discoveredGeometry.confidence_score >= minConf && vendorNip) {
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
            }, vendorName);
          } else if (discoveredGeometry.confidence_score < minConf) {
            requiresHitlLearning = true;
          }
        }

        return DualUnitEngine.processItem({
          raw: rawItem,
          vendorRule,
          discoveredGeometry,
        });
      })
    );

    // ── 3. PODSUMOWANIE FINANSOWE (Agent Matematyk) ──
    const mathTotals = DeterministicMathEngine.calculateTotals(
      reconciledItems.map(it => ({ total_net: it.raw.total_net, vat_rate: it.raw.vat_rate }))
    );

    const docNumber = canonicalPayload.document.number || `WZ-${Date.now()}`;
    const cleanDocRef = docNumber.replace(/[^A-Za-z0-9]/g, '').substring(0, 15);
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const reconciliationId = `REC-${dateStr}-${cleanDocRef || 'DOC'}-001`;

    // ── 4. STATUS KOŃCOWY (Reconciliation Verdict & Granular Policy) ──
    let status: ReconciledStatus = 'AUTO_RECONCILED';
    const requireDriverNote = policy.voice_rules.require_driver_note_for_auto_approve ?? true;
    const lowValueThreshold = policy.voice_rules.auto_approve_without_driver_note_below_pln ?? 300.0;
    const isUnderThreshold = mathTotals.totalNet <= lowValueThreshold;
    const hasAudioText = Boolean(driverAudioNote?.text && driverAudioNote.text.trim().length > 0);

    if (!driverAudit.is_physically_confirmed) {
      if (!hasAudioText && !requireDriverNote) {
        status = 'AUTO_RECONCILED';
        driverAudit.verdict_reason = '✅ AUTO_RECONCILED: W ustawieniach wyłączono wymóg notatki głosowej kierowcy.';
      } else if (isUnderThreshold) {
        status = 'AUTO_RECONCILED';
        driverAudit.verdict_reason = `✅ AUTO_RECONCILED (Polityka progowa): Kwota WZ (${mathTotals.totalNet.toFixed(2)} zł) mieści się w limicie ${lowValueThreshold.toFixed(2)} zł. Przyjęto z automatu bez głosu kierowcy.`;
      } else {
        status = 'PENDING_HITL_VOICE';
        driverAudit.verdict_reason = `⚠️ PENDING_HITL_VOICE: Wartość WZ (${mathTotals.totalNet.toFixed(2)} zł) przekracza limit ${lowValueThreshold.toFixed(2)} zł przy braku potwierdzonego meldunku. Wymagane zatwierdzenie.`;
      }
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
        target_site_id: matchedSiteId,
      },
      manager_signature: {
        is_signed: false,
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
