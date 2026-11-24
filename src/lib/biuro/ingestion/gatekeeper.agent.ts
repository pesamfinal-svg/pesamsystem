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
  mathModel?: {
    calculatedNet: number;
    declaredNet: number;
    difference: number;
    discrepancyPct: number;
    isExactMatch: boolean;
    formulaPreview: string;
  };
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
    if (payload.meta.source_type === 'KSEF_XML' || payload.meta.source_type === 'KSEF_JSON') {
      return { isValid: true, requiresFallback: false, reason: 'Walidacja KSeF: dane pochodzą z zaufanego strumienia cyfrowego.' };
    }
    if (payload.meta.source_type === 'DRIVER_AUDIO') {
      return { isValid: true, requiresFallback: false, reason: 'Walidacja Audio: deklaracja słowna kierowcy (ilościowa).' };
    }

    // 3. Walidacja matematyczna: suma pozycji netto vs suma w nagłówku
    const declaredNet = payload.totals?.total_net;
    const items = payload.items;

    // Jeśli brak zadeklarowanej sumy lub pozycje nie mają cen (np. prosta WZ ilościowa bez cen) -> akceptujemy
    const hasItemPrices = items.some(it => it.total_net !== null && it.total_net !== undefined && it.total_net > 0);
    if (!declaredNet || !hasItemPrices) {
      return { isValid: true, requiresFallback: false, reason: 'WZ ilościowa (brak cen jednostkowych netto w nagłówku).' };
    }

    const calculatedNet = Math.round(items.reduce((sum, it) => sum + (it.total_net || 0), 0) * 100) / 100;
    const difference = Math.round(Math.abs(calculatedNet - declaredNet) * 100) / 100;
    const discrepancyPct = declaredNet > 0 ? (difference / declaredNet) * 100 : 0;
    const isExactMatch = difference === 0;

    // Podgląd wzoru matematycznego: np. "266.49 + 98.84 + ... = 790.58 zł"
    const formulaParts = items.slice(0, 5).map(it => (it.total_net || 0).toFixed(2));
    const formulaSuffix = items.length > 5 ? ` + ... (${items.length - 5} poz.)` : '';
    const formulaPreview = `${formulaParts.join(' + ')}${formulaSuffix} = ${calculatedNet.toFixed(2)} zł`;

    const mathModel = {
      calculatedNet,
      declaredNet,
      difference,
      discrepancyPct: Math.round(discrepancyPct * 10) / 10,
      isExactMatch,
      formulaPreview
    };

    // Tolerancja do 1.5% na zaokrąglenia groszowe
    if (discrepancyPct > 1.5) {
      return {
        isValid: false,
        requiresFallback: true,
        mathDiscrepancyPct: Math.round(discrepancyPct * 10) / 10,
        mathModel,
        reason: `Niezgodność matematyczna: suma pozycji (${calculatedNet.toFixed(2)} zł) różni się o ${discrepancyPct.toFixed(1)}% od sumy nagłówka (${declaredNet.toFixed(2)} zł).`
      };
    }

    return {
      isValid: true,
      requiresFallback: false,
      mathModel,
      reason: isExactMatch
        ? `100% zgodności matematycznej: suma pozycji (${calculatedNet.toFixed(2)} zł) idealnie pokrywa się z nagłówkiem.`
        : `Zgodność w granicach tolerancji groszowej (różnica ${difference.toFixed(2)} zł).`
    };
  }
}
