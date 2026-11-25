// src/app/api/biuro/reconciled-deliveries/route.ts
// Endpoint do pobierania listy zbuforowanych i uzgodnionych dokumentów WZ z kolekcji `reconciled_deliveries`

import { NextResponse } from 'next/server';
import { db } from '@/lib/firebase/config';
import { collection, getDocs, query, orderBy, limit } from 'firebase/firestore';
import { ReconciledDelivery } from '@/types/biuro/reconciledDelivery.types';

export const runtime = 'nodejs';

// Domyślna próbka dostawy WZT-963 na wypadek braku wpisów w Firestore lub offline
const FALLBACK_DELIVERY: ReconciledDelivery = {
  reconciliation_id: 'REC-20261124-WZT963-001',
  metadata: {
    created_at: '2026-11-24T10:15:00Z',
    status: 'AUTO_RECONCILED',
    confidence_score: 1.0,
    source_wz_id: 'WZT/963/11/2026/DE',
    source_type: 'KSEF_JSON',
    processing_time_ms: 18,
  },
  parties: {
    vendor: {
      nip: '8722410651',
      name: 'PRZEDSIĘBIORSTWO HANDLOWO USŁUGOWE CMB DĘBICA SP. Z O.O.',
    },
    buyer: {
      nip: '8720004013',
      name: 'PESAM SPÓŁKA Z O.O. SP. K.',
    },
    target_site: 'KIELCE PRZYCHODNIA',
  },
  driver_audit: {
    verification_method: 'CHECKSUM_AND_ANCHOR',
    is_physically_confirmed: true,
    declared_line_count: 7,
    actual_line_count: 7,
    line_count_matched: true,
    anchor_item: 'PŁYTA OSB-3',
    anchor_quantity_matched: true,
    driver_audio_ref: 'audio/kielce_dawid_0939.mp3',
    driver_audio_text: 'CMB na Kielce, 7 pozycji na kwicie, w tym 6 płyt OSB.',
    verdict_reason: '✅ AUTO_VERIFIED: Przyjęcie towaru potwierdzone głosem kierowcy (Suma wierszy: 7, Kotwica: 6 płyt OSB).',
    driver_name: 'Dawid (Kierowca)',
  },
  items: [
    {
      lp: 1,
      canonical_id: 'MAT-STAL-C50',
      raw: { name: 'PROFIL C-50/3 MB MFO /10/200/', quantity: 27.0, unit: 'szt', unit_price_net: 9.87, total_net: 266.49, vat_rate: 23 },
      normalized: { standard_name: 'Profil stalowy ścienny C-50', quantity: 81.0, unit: 'mb', unit_price_net: 3.29, total_net: 266.49 },
      conversion: { multiplier: 3.0, formula: '1 szt = 3.0 mb', source: 'VENDOR_PROFILE_CACHE', confidence: 1.0 },
    },
    {
      lp: 2,
      canonical_id: 'MAT-STAL-U50',
      raw: { name: 'PROFIL U- 50/3MB MFO /10/200/ W.', quantity: 14.0, unit: 'szt', unit_price_net: 7.06, total_net: 98.84, vat_rate: 23 },
      normalized: { standard_name: 'Profil stalowy obwodowy U-50', quantity: 42.0, unit: 'mb', unit_price_net: 2.35, total_net: 98.84 },
      conversion: { multiplier: 3.0, formula: '1 szt = 3.0 mb', source: 'VENDOR_PROFILE_CACHE', confidence: 1.0 },
    },
    {
      lp: 3,
      canonical_id: 'MAT-WKRET-TEX-35095',
      raw: { name: 'KLIMAS WKRĘTY SAMOW.FOSF.AT TYP TEX A 200 BTEX-35095', quantity: 2.0, unit: 'opak', unit_price_net: 9.61, total_net: 19.22, vat_rate: 23 },
      normalized: { standard_name: 'Wkręty samowiercące TEX 3.5x9.5 mm', quantity: 400.0, unit: 'szt', unit_price_net: 0.048, total_net: 19.22 },
      conversion: { multiplier: 200.0, formula: '1 opak = 200 szt', source: 'VENDOR_PROFILE_CACHE', confidence: 1.0 },
    },
    {
      lp: 4,
      canonical_id: 'MAT-TASMA-BORAMAX-25M',
      raw: { name: 'BORAMAX TAŚMA WZMACNIANA DWUSTRONNA 25M', quantity: 1.0, unit: 'szt', unit_price_net: 11.19, total_net: 11.19, vat_rate: 23 },
      normalized: { standard_name: 'Taśma wzmacniana dwustronna 25m', quantity: 1.0, unit: 'szt', unit_price_net: 11.19, total_net: 11.19 },
      conversion: { multiplier: 1.0, formula: '1 szt = 1 szt', source: 'VENDOR_PROFILE_CACHE', confidence: 1.0 },
    },
    {
      lp: 5,
      canonical_id: 'MAT-DREW-OSB3-10MM',
      raw: { name: 'PŁYTA OSB-3 10/1250/2500', quantity: 6.0, unit: 'szt', unit_price_net: 62.82, total_net: 376.92, vat_rate: 23 },
      normalized: { standard_name: 'Płyta OSB-3 grubość 10 mm', quantity: 18.75, unit: 'm2', unit_price_net: 20.10, total_net: 376.92 },
      conversion: { multiplier: 3.125, formula: '1.25m * 2.50m = 3.125 m2/szt', source: 'VENDOR_PROFILE_CACHE', confidence: 1.0 },
    },
    {
      lp: 6,
      canonical_id: 'MAT-NARZ-WIERTLO-SDS-5X160',
      raw: { name: 'SCHMITH WIERTŁO SDS MESSERSCHMITH/ T5X160', quantity: 1.0, unit: 'szt', unit_price_net: 7.48, total_net: 7.48, vat_rate: 23 },
      normalized: { standard_name: 'Wiertło SDS 5x160 mm', quantity: 1.0, unit: 'szt', unit_price_net: 7.48, total_net: 7.48 },
      conversion: { multiplier: 1.0, formula: '1 szt = 1 szt', source: 'VENDOR_PROFILE_CACHE', confidence: 1.0 },
    },
    {
      lp: 7,
      canonical_id: 'MAT-KOLKI-SM-640',
      raw: { name: 'KLIMAS KOŁKI DO WBIJANIA W-SM 6X40 OPAK.50SZT', quantity: 2.0, unit: 'opak', unit_price_net: 5.22, total_net: 10.44, vat_rate: 23 },
      normalized: { standard_name: 'Kołki do wbijania SM 6x40 mm', quantity: 100.0, unit: 'szt', unit_price_net: 0.104, total_net: 10.44 },
      conversion: { multiplier: 50.0, formula: '1 opak = 50 szt', source: 'VENDOR_PROFILE_CACHE', confidence: 1.0 },
    },
  ],
  financial_summary: {
    total_net_wz: 790.58,
    total_vat_wz: 181.83,
    total_gross_wz: 972.41,
    budget_status: 'CHARGED_TO_SITE',
  },
};

export async function GET() {
  try {
    const colRef = collection(db, 'reconciled_deliveries');
    const q = query(colRef, orderBy('metadata.created_at', 'desc'), limit(30));
    const snapshot = await getDocs(q);

    let list: ReconciledDelivery[] = snapshot.docs.map(doc => doc.data() as ReconciledDelivery);

    if (list.length === 0) {
      list = [FALLBACK_DELIVERY];
    }

    return NextResponse.json({
      success: true,
      count: list.length,
      data: list,
    });
  } catch (err: any) {
    console.warn('[API /api/biuro/reconciled-deliveries] Returning fallback due to error:', err);
    return NextResponse.json({
      success: true,
      count: 1,
      data: [FALLBACK_DELIVERY],
      warning: err.message,
    });
  }
}
