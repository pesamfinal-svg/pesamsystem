// src/lib/biuro/ingestion/gatekeeper.agent.ts
//
// Agent Walidacji Syntaktycznej (Gatekeeper)
// Bada poprawność danych wygenerowanych przez agentów roboczych.
// Sprawdza matematyczną zgodność sum oraz decyduje, czy konieczny jest
// A2A Handshake (przekazanie zlecenia do fallbacku Vision).

import { CanonicalIngestPayload } from '@/types/biuro/canonicalDocument';

export interface GatekeeperVerdict {
  isValid: boolean;
  requiresFallback: boolean;
  reason?: string;
  mathDiscrepancyPct?: number;
}

export class GatekeeperAgent {
  /**
   * Waliduje zunifikowany payload pod kątem spójności matematycznej i kompletności.
   */
  static validate(payload: CanonicalIngestPayload): GatekeeperVerdict {
    // 1. Sprawdzenie obecności pozycji
    if (!payload.items || payload.items.length === 0) {
      return {
        isValid: false,
        requiresFallback: true,
        reason: 'Dokument nie zawiera żadnych odczytanych pozycji.'
      };
    }

    // 2. W przypadku KSeF i Audio walidacja kwotowa ma inny charakter
    if (payload.meta.source_type === 'KSEF_XML') {
      return { isValid: true, requiresFallback: false };
    }
    if (payload.meta.source_type === 'DRIVER_AUDIO') {
      return { isValid: true, requiresFallback: false };
    }

    // 3. Walidacja matematyczna: suma pozycji netto vs suma w nagłówku
    const declaredNet = payload.totals?.total_net;
    const items = payload.items;

    // Jeśli brak zadeklarowanej sumy lub pozycje nie mają cen (np. prosta WZ ilościowa bez cen) -> akceptujemy
    const hasItemPrices = items.some(it => it.total_net !== null && it.total_net !== undefined && it.total_net > 0);
    if (!declaredNet || !hasItemPrices) {
      return { isValid: true, requiresFallback: false };
    }

    const calculatedNet = items.reduce((sum, it) => sum + (it.total_net || 0), 0);
    const difference = Math.abs(calculatedNet - declaredNet);
    const discrepancyPct = declaredNet > 0 ? (difference / declaredNet) * 100 : 0;

    // Tolerancja do 1.5% na zaokrąglenia groszowe
    if (discrepancyPct > 1.5) {
      return {
        isValid: false,
        requiresFallback: true,
        mathDiscrepancyPct: Math.round(discrepancyPct * 10) / 10,
        reason: `Niezgodność matematyczna: suma pozycji (${calculatedNet.toFixed(2)} zł) różni się o ${discrepancyPct.toFixed(1)}% od sumy nagłówka (${declaredNet.toFixed(2)} zł).`
      };
    }

    return { isValid: true, requiresFallback: false };
  }
}
