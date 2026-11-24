// src/lib/biuro/ingestion/workers/ksef.agent.ts
//
// Agent KSeF (Strukturalny)
// Parsuje oficjalne pliki XML faktur KSeF (FA_VAT / FA(1) / FA(2)).
// Deterministyczny, bez halucynacji AI, koszt: 0 zł, czas: ~5 ms.

import { XMLParser } from 'fast-xml-parser';
import { CanonicalIngestPayload } from '@/types/biuro/canonicalDocument';

export class KsefWorkerAgent {
  static async process(buffer: Buffer, fileName: string): Promise<CanonicalIngestPayload> {
    const startTime = performance.now();
    const xmlContent = buffer.toString('utf-8');

    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      trimValues: true,
      parseTagValue: true
    });

    const parsed = parser.parse(xmlContent);

    // KSeF korzeń: Faktura lub ns2:Faktura
    const root = parsed.Faktura || parsed['ns2:Faktura'] || parsed['crd:Faktura'] || parsed;
    const naglowek = root.Naglowek || {};
    const podmiot1 = root.Podmiot1?.DaneIdentyfikacyjne || {};
    const podmiot2 = root.Podmiot2?.DaneIdentyfikacyjne || {};
    const fa = root.Fa || {};

    // Pozycje faktury KSeF znajdują się w Fa.FaWiersz
    const rawWiersze = fa.FaWiersz;
    const wierszeArray: any[] = Array.isArray(rawWiersze)
      ? rawWiersze
      : rawWiersze ? [rawWiersze] : [];

    const items = wierszeArray.map((w, index) => {
      const quantity = typeof w.P_8B === 'number' ? w.P_8B : parseFloat(String(w.P_8B || '1').replace(',', '.'));
      const unitPrice = typeof w.P_9A === 'number' ? w.P_9A : parseFloat(String(w.P_9A || '0').replace(',', '.'));
      const totalNet = typeof w.P_11 === 'number' ? w.P_11 : parseFloat(String(w.P_11 || '0').replace(',', '.'));
      const vatRateStr = String(w.P_12 || '23').replace('%', '').trim();
      const vatRate = isNaN(parseInt(vatRateStr)) ? 23 : parseInt(vatRateStr);

      return {
        lp: w.NrWierszaFa || index + 1,
        raw_name: String(w.P_7 || `Pozycja ${index + 1}`),
        quantity: isNaN(quantity) ? 1 : quantity,
        raw_unit: String(w.P_8A || 'szt'),
        unit_price_net: isNaN(unitPrice) ? null : unitPrice,
        total_net: isNaN(totalNet) ? null : totalNet,
        vat_rate: vatRate
      };
    });

    const totalNet = typeof fa.P_13_1 === 'number' ? fa.P_13_1 : parseFloat(String(fa.P_13_1 || '0').replace(',', '.'));
    const totalVat = typeof fa.P_14_1 === 'number' ? fa.P_14_1 : parseFloat(String(fa.P_14_1 || '0').replace(',', '.'));
    const totalGross = typeof fa.P_15 === 'number' ? fa.P_15 : parseFloat(String(fa.P_15 || '0').replace(',', '.'));

    const executionTimeMs = Math.round((performance.now() - startTime) * 100) / 100;

    return {
      meta: {
        ingest_id: `ING-KSEF-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        timestamp: new Date().toISOString(),
        source_type: 'KSEF_XML',
        processed_by_agent: 'Agent-KSeF',
        fallback_occurred: false,
        cost_usd: 0.0,
        confidence_score: 1.0,
        execution_time_ms: executionTimeMs
      },
      document: {
        type: 'FAKTURA',
        number: fa.P_2 ? String(fa.P_2) : fileName,
        issue_date: fa.P_1 ? String(fa.P_1).slice(0, 10) : null,
        seller: {
          name: podmiot1.PelnaNazwa || podmiot1.NazwaHandlowa || null,
          nip: podmiot1.NIP ? String(podmiot1.NIP).replace(/\D/g, '') : null
        },
        buyer: {
          name: podmiot2.PelnaNazwa || podmiot2.NazwaHandlowa || null,
          nip: podmiot2.NIP ? String(podmiot2.NIP).replace(/\D/g, '') : null
        },
        target_site_hint: fa.P_19 ? String(fa.P_19) : null
      },
      items,
      totals: {
        total_net: isNaN(totalNet) ? null : totalNet,
        total_vat: isNaN(totalVat) ? null : totalVat,
        total_gross: isNaN(totalGross) ? null : totalGross,
        currency: (fa.KodWaluty || 'PLN') as 'PLN' | 'EUR'
      }
    };
  }
}
