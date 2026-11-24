// src/components/biuro/Module2ReconcilerPanel.tsx
'use client';

import React, { useState, useEffect } from 'react';
import type { CanonicalIngestPayload } from '@/types/biuro/canonicalDocument';
import type { ReconciledDelivery, ReconciledItem, KSeFMatchResult } from '@/types/biuro/reconciledDelivery.types';
import type { VendorCatalogItem } from '@/types/biuro/vendorCatalog.types';
import type { BiuroMatchingPolicy } from '@/types/biuro/matchingPolicy.types';

interface Module2ReconcilerPanelProps {
  initialPayload?: CanonicalIngestPayload | null;
  onPayloadChange?: (payload: CanonicalIngestPayload) => void;
}

type SubTab = 'dual_unit' | 'voice_anchor' | 'ksef_matcher' | 'vendor_catalog';

export default function Module2ReconcilerPanel({
  initialPayload,
  onPayloadChange,
}: Module2ReconcilerPanelProps) {
  const [activeSubTab, setActiveSubTab] = useState<SubTab>('dual_unit');

  // Stan Modułu 2
  const [reconciledData, setReconciledData] = useState<ReconciledDelivery | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Stan testu głosu (Voice Anchor)
  const [driverText, setDriverText] = useState(
    'CMB na Kielce, 7 pozycji na kwicie, w tym 6 płyt OSB.'
  );
  const [voiceTestResult, setVoiceTestResult] = useState<any>(null);

  // Stan testu KSeF
  const [ksefTestVariant, setKsefTestVariant] = useState<'A_PIECES' | 'B_M2' | 'C_PRICE_HIKE'>('C_PRICE_HIKE');
  const [ksefMatchResult, setKsefMatchResult] = useState<KSeFMatchResult | null>(null);
  const [isMatchingKsef, setIsMatchingKsef] = useState(false);
  const [hitlActionTaken, setHitlActionTaken] = useState<string | null>(null);

  // Stan katalogu dostawców
  const [vendorRules, setVendorRules] = useState<VendorCatalogItem[]>([]);
  const [selectedNipFilter, setSelectedNipFilter] = useState<string>('8722410651');

  // Domyślna próbka WZT-963
  const sampleWzt963: CanonicalIngestPayload = {
    meta: {
      ingest_id: 'ING-20261124-WZT963',
      timestamp: new Date().toISOString(),
      source_type: 'KSEF_JSON',
      processed_by_agent: 'Agent-FastPath',
      fallback_occurred: false,
      cost_usd: 0.0,
      confidence_score: 1.0,
      execution_time_ms: 14,
    },
    document: {
      type: 'WZ',
      number: 'WZT/963/11/2026/DE',
      issue_date: '2026-11-18',
      seller: {
        name: 'PRZEDSIĘBIORSTWO HANDLOWO USŁUGOWE CMB DĘBICA SP. Z O.O.',
        nip: '8722410651',
      },
      buyer: {
        name: 'PESAM SPÓŁKA Z O.O. SP. K.',
        nip: '8720004013',
      },
      target_site_hint: 'KIELCE PRZYCHODNIA',
    },
    items: [
      { lp: 1, raw_name: 'PROFIL C-50/3 MB MFO /10/200/', quantity: 27.0, raw_unit: 'szt', unit_price_net: 9.87, vat_rate: 23, total_net: 266.49 },
      { lp: 2, raw_name: 'PROFIL U- 50/3MB MFO /10/200/ W.', quantity: 14.0, raw_unit: 'szt', unit_price_net: 7.06, vat_rate: 23, total_net: 98.84 },
      { lp: 3, raw_name: 'KLIMAS WKRĘTY SAMOW.FOSF.AT TYP TEX A 200 BTEX-35095', quantity: 2.0, raw_unit: 'opak', unit_price_net: 9.61, vat_rate: 23, total_net: 19.22 },
      { lp: 4, raw_name: 'BORAMAX TAŚMA WZMACNIANA DWUSTRONNA 25M', quantity: 1.0, raw_unit: 'szt', unit_price_net: 11.19, vat_rate: 23, total_net: 11.19 },
      { lp: 5, raw_name: 'PŁYTA OSB-3 10/1250/2500', quantity: 6.0, raw_unit: 'szt', unit_price_net: 62.82, vat_rate: 23, total_net: 376.92 },
      { lp: 6, raw_name: 'SCHMITH WIERTŁO SDS MESSERSCHMITH/ T5X160', quantity: 1.0, raw_unit: 'szt', unit_price_net: 7.48, vat_rate: 23, total_net: 7.48 },
      { lp: 7, raw_name: 'KLIMAS KOŁKI DO WBIJANIA W-SM 6X40 OPAK.50SZT', quantity: 2.0, raw_unit: 'opak', unit_price_net: 5.22, vat_rate: 23, total_net: 10.44 },
    ],
    totals: {
      total_net: 790.58,
      total_vat: 181.83,
      total_gross: 972.41,
      currency: 'PLN',
    },
  };

  const activePayload = initialPayload || sampleWzt963;

  // Uruchomienie normalizacji dwutorowej Modułu 2
  const runModule2Reconciliation = async (payloadToUse = activePayload, noteText = driverText) => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const res = await fetch('/api/biuro/reconcile-module2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          canonicalPayload: payloadToUse,
          driverAudioNote: noteText ? {
            text: noteText,
            audioRef: 'audio/kielce_dawid_0939.mp3',
            driverName: 'Dawid (Kierowca)',
          } : undefined,
        }),
      });

      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error || 'Nie udało się przetworzyć dokumentu w Module 2.');
      }

      setReconciledData(json.data as ReconciledDelivery);
      setVoiceTestResult(json.data.driver_audit);
    } catch (err: any) {
      setErrorMessage(err.message || 'Błąd podczas uruchamiania Modułu 2');
    } finally {
      setIsLoading(false);
    }
  };

  // Ładowanie reguł dostawców
  const fetchVendorRules = async (nip?: string) => {
    try {
      const url = nip ? `/api/biuro/vendor-catalog?nip=${nip}` : '/api/biuro/vendor-catalog';
      const res = await fetch(url);
      const json = await res.json();
      if (json.success) {
        setVendorRules(json.data || []);
      }
    } catch (err) {
      console.warn('Nie udało się pobrać reguł dostawców:', err);
    }
  };

  // Uruchomienie testu KSeF
  const runKsefMatch = async (variant: 'A_PIECES' | 'B_M2' | 'C_PRICE_HIKE') => {
    setKsefTestVariant(variant);
    setIsMatchingKsef(true);
    setHitlActionTaken(null);

    let ksefItems: any[] = [];
    if (variant === 'A_PIECES') {
      // Wariant A: Hurtownia fakturuje w sztukach po cenie z WZ
      ksefItems = [
        { name: 'PŁYTA OSB-3 10/1250/2500', quantity: 6.0, unit: 'szt', unit_price_net: 62.82, total_net: 376.92 },
        { name: 'PROFIL C-50/3 MB MFO /10/200/', quantity: 27.0, unit: 'szt', unit_price_net: 9.87, total_net: 266.49 },
      ];
    } else if (variant === 'B_M2') {
      // Wariant B: Hurtownia fakturuje w m2 po przeliczonej stawce
      ksefItems = [
        { name: 'Płyta OSB 10mm', quantity: 18.75, unit: 'm2', unit_price_net: 20.10, total_net: 376.92 },
        { name: 'Profil stalowy ścienny C-50', quantity: 81.0, unit: 'mb', unit_price_net: 3.29, total_net: 266.49 },
      ];
    } else {
      // Wariant C: Wykryta cicha podwyżka cen o +8.46% (62.82 zł -> 68.13 zł lub 20.10 zł -> 21.80 zł/m2)
      ksefItems = [
        { name: 'PŁYTA OSB-3 10/1250/2500', quantity: 18.75, unit: 'm2', unit_price_net: 21.80, total_net: 408.75 },
        { name: 'PROFIL C-50/3 MB MFO /10/200/', quantity: 27.0, unit: 'szt', unit_price_net: 9.87, total_net: 266.49 },
      ];
    }

    try {
      const res = await fetch('/api/biuro/ksef-reconcile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ksefInvoice: {
            invoice_number: 'FA/2026/11/8832',
            invoice_date: '2026-11-24',
            vendor_nip: '8722410651',
            vendor_name: 'CMB DĘBICA SP. Z O.O.',
            items: ksefItems,
            total_net: ksefItems.reduce((acc, it) => acc + it.total_net, 0),
          },
          deliveries: reconciledData ? [reconciledData] : undefined,
        }),
      });

      const json = await res.json();
      if (json.success) {
        setKsefMatchResult(json.data);
      }
    } catch (err: any) {
      console.error('Błąd testu KSeF:', err);
    } finally {
      setIsMatchingKsef(false);
    }
  };

  useEffect(() => {
    runModule2Reconciliation();
    fetchVendorRules();
  }, []);

  return (
    <div className="space-y-6">
      {/* Nagłówek Modułu 2 */}
      <div className="bg-gradient-to-r from-emerald-950 via-slate-900 to-indigo-950 border border-emerald-500/30 rounded-2xl p-6 shadow-xl relative overflow-hidden">
        <div className="absolute top-0 right-0 w-96 h-96 bg-emerald-500/5 rounded-full blur-3xl pointer-events-none" />
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 relative z-10">
          <div>
            <div className="flex items-center gap-3">
              <span className="px-3 py-1 bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 rounded-full text-xs font-mono font-semibold uppercase tracking-wider">
                Moduł 2 • A2A Multi-Agent Engine
              </span>
              <span className="px-2.5 py-0.5 bg-blue-500/20 text-blue-300 border border-blue-500/30 rounded-full text-xs font-mono">
                Decimal.js Bank Precision
              </span>
            </div>
            <h2 className="text-2xl font-bold text-white mt-2">
              Mózg Logistyczno-Finansowy & Normalizacja Dwutorowa
            </h2>
            <p className="text-sm text-slate-300 mt-1 max-w-3xl">
              Eliminuje rozbieżności między głosem kierowcy z budowy, kwitem WZ a fakturą zbiorczą KSeF.
              Równolegle utrzymuje tor surowy (<span className="text-amber-400 font-mono">Tor RAW</span>) oraz tor kosztorysowy (<span className="text-emerald-400 font-mono">Tor NORMALIZED</span>).
            </p>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => runModule2Reconciliation()}
              disabled={isLoading}
              className="px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl font-medium text-sm flex items-center gap-2 shadow-lg shadow-emerald-950/40 transition disabled:opacity-50 cursor-pointer"
            >
              {isLoading ? (
                <>
                  <div className="w-4 h-4 border-2 border-white/20 border-t-white rounded-full animate-spin" />
                  Orkiestracja w toku...
                </>
              ) : (
                <>
                  <span>⚡</span> Przelicz Modułem 2
                </>
              )}
            </button>
          </div>
        </div>

        {/* Menu podzakładek Modułu 2 */}
        <div className="flex flex-wrap gap-2 mt-6 pt-5 border-t border-slate-800">
          <button
            onClick={() => setActiveSubTab('dual_unit')}
            className={`px-4 py-2 rounded-xl text-sm font-medium transition cursor-pointer flex items-center gap-2 ${
              activeSubTab === 'dual_unit'
                ? 'bg-emerald-600 text-white shadow-md'
                : 'bg-slate-800/80 text-slate-300 hover:bg-slate-800 hover:text-white'
            }`}
          >
            <span>⚖️</span>
            <span>Reprezentacja Dwutorowa (Dual-Unit)</span>
            {reconciledData && (
              <span className="ml-1.5 px-2 py-0.5 text-xs bg-black/30 rounded-full font-mono">
                {reconciledData.items.length} poz.
              </span>
            )}
          </button>

          <button
            onClick={() => setActiveSubTab('voice_anchor')}
            className={`px-4 py-2 rounded-xl text-sm font-medium transition cursor-pointer flex items-center gap-2 ${
              activeSubTab === 'voice_anchor'
                ? 'bg-emerald-600 text-white shadow-md'
                : 'bg-slate-800/80 text-slate-300 hover:bg-slate-800 hover:text-white'
            }`}
          >
            <span>🎙️</span>
            <span>Weryfikacja Głosu (Kotwica + Suma)</span>
            {voiceTestResult?.is_physically_confirmed && (
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            )}
          </button>

          <button
            onClick={() => {
              setActiveSubTab('ksef_matcher');
              if (!ksefMatchResult) runKsefMatch('C_PRICE_HIKE');
            }}
            className={`px-4 py-2 rounded-xl text-sm font-medium transition cursor-pointer flex items-center gap-2 ${
              activeSubTab === 'ksef_matcher'
                ? 'bg-emerald-600 text-white shadow-md'
                : 'bg-slate-800/80 text-slate-300 hover:bg-slate-800 hover:text-white'
            }`}
          >
            <span>🔍</span>
            <span>Uzgadnianie KSeF (Parowanie + HITL)</span>
          </button>

          <button
            onClick={() => {
              setActiveSubTab('vendor_catalog');
              fetchVendorRules();
            }}
            className={`px-4 py-2 rounded-xl text-sm font-medium transition cursor-pointer flex items-center gap-2 ${
              activeSubTab === 'vendor_catalog'
                ? 'bg-emerald-600 text-white shadow-md'
                : 'bg-slate-800/80 text-slate-300 hover:bg-slate-800 hover:text-white'
            }`}
          >
            <span>🗄️</span>
            <span>Pamięć Dostawców (per NIP)</span>
          </button>
        </div>
      </div>

      {errorMessage && (
        <div className="p-4 bg-red-950/60 border border-red-500/50 rounded-xl text-red-200 text-sm flex items-center gap-3">
          <span className="text-xl">⚠️</span>
          <span>{errorMessage}</span>
        </div>
      )}

      {/* ── SUBTAB 1: REPREZENTACJA DWUTOROWA (DUAL-UNIT) ── */}
      {activeSubTab === 'dual_unit' && (
        <div className="space-y-6">
          {/* Informacja o tarczy ochronnej */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4">
              <div className="text-xs font-mono uppercase text-amber-400 font-semibold flex items-center gap-2">
                <span>📄</span> TOR 1: Stan Surowy (RAW)
              </div>
              <div className="text-sm text-slate-300 mt-2">
                Zabezpiecza faktury KSeF wystawiane w jednostkach hurtowni (np. sztuki płyt, opakowania wkrętów).
              </div>
            </div>

            <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4">
              <div className="text-xs font-mono uppercase text-emerald-400 font-semibold flex items-center gap-2">
                <span>📐</span> TOR 2: Stan Kosztorysowy (NORMALIZED)
              </div>
              <div className="text-sm text-slate-300 mt-2">
                Zasila budżety budowy i inżynierów w twarde jednostki fizyczne (<span className="text-emerald-400 font-mono">m²</span>, <span className="text-emerald-400 font-mono">mb</span>).
              </div>
            </div>

            <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4">
              <div className="text-xs font-mono uppercase text-blue-400 font-semibold flex items-center gap-2">
                <span>🧮</span> Niezmiennik Finansowy (0 zł błędu)
              </div>
              <div className="text-sm text-slate-300 mt-2">
                Suma pozycji netto w obu torach jest <span className="text-white font-bold">co do grosza identyczna</span>.
              </div>
            </div>
          </div>

          {/* Tabela dwutorowa pozycji */}
          <div className="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
            <div className="p-4 bg-slate-800/60 border-b border-slate-700/60 flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <span className="font-semibold text-white">
                  Tabela Porównawcza Pozycji Dostawy: {reconciledData?.metadata.source_wz_id || 'WZT/963'}
                </span>
                <span className="text-xs bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 px-2.5 py-0.5 rounded-full font-mono">
                  {reconciledData?.items.length || 0} wierszy
                </span>
              </div>
              <div className="text-xs text-slate-400 font-mono">
                Dostawca: <span className="text-white font-medium">{reconciledData?.parties.vendor.name || 'CMB DĘBICA'}</span> (NIP: {reconciledData?.parties.vendor.nip || '8722410651'})
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-slate-800/40 text-slate-400 border-b border-slate-700/60 font-mono uppercase">
                    <th className="py-3 px-3 w-12 text-center">Lp</th>
                    <th className="py-3 px-4 w-1/3 bg-amber-950/20 text-amber-300 border-r border-slate-800">
                      TOR 1: Dane Surowe z Papieru (RAW)
                    </th>
                    <th className="py-3 px-4 w-1/4 text-blue-300 border-r border-slate-800">
                      Reguła Przeliczenia z Pamięci NIP
                    </th>
                    <th className="py-3 px-4 w-1/3 bg-emerald-950/20 text-emerald-300">
                      TOR 2: Znormalizowane PESAM (NORMALIZED)
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {reconciledData?.items.map((item) => (
                    <tr key={item.lp} className="hover:bg-slate-800/30 transition">
                      <td className="py-3 px-3 text-center font-mono text-slate-400">
                        {item.lp}
                      </td>

                      {/* Tor RAW */}
                      <td className="py-3 px-4 bg-amber-950/10 border-r border-slate-800">
                        <div className="font-semibold text-slate-200">
                          {item.raw.name}
                        </div>
                        <div className="flex items-center gap-3 mt-1 font-mono text-amber-300">
                          <span>
                            {item.raw.quantity.toFixed(2)} {item.raw.unit}
                          </span>
                          <span className="text-slate-500">×</span>
                          <span>{item.raw.unit_price_net.toFixed(2)} zł</span>
                          <span className="text-slate-500">=</span>
                          <span className="font-bold text-white">{item.raw.total_net.toFixed(2)} zł</span>
                        </div>
                      </td>

                      {/* Przelicznik */}
                      <td className="py-3 px-4 border-r border-slate-800 font-mono">
                        <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-blue-950/40 border border-blue-500/30 text-blue-300 text-[11px]">
                          <span>⚡</span> {item.conversion.formula}
                        </div>
                        <div className="text-[10px] text-slate-400 mt-1 flex items-center gap-1">
                          <span>Źródło:</span>
                          <span className={item.conversion.source === 'VENDOR_PROFILE_CACHE' ? 'text-emerald-400' : 'text-purple-400'}>
                            {item.conversion.source}
                          </span>
                        </div>
                      </td>

                      {/* Tor NORMALIZED */}
                      <td className="py-3 px-4 bg-emerald-950/10">
                        <div className="font-semibold text-emerald-200 flex items-center gap-2">
                          <span>{item.normalized.standard_name}</span>
                          <span className="text-[10px] font-mono text-slate-400 px-1.5 py-0.2 bg-slate-800 rounded">
                            {item.canonical_id}
                          </span>
                        </div>
                        <div className="flex items-center gap-3 mt-1 font-mono text-emerald-300">
                          <span className="font-bold">
                            {item.normalized.quantity.toFixed(2)} {item.normalized.unit}
                          </span>
                          <span className="text-slate-500">×</span>
                          <span>{item.normalized.unit_price_net.toFixed(2)} zł/{item.normalized.unit}</span>
                          <span className="text-slate-500">=</span>
                          <span className="font-bold text-white">{item.normalized.total_net.toFixed(2)} zł</span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Podsumowanie finansowe w stopce */}
            <div className="p-4 bg-slate-950 border-t border-slate-800 flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <span className="text-xs uppercase tracking-wider font-mono text-slate-400">
                  Podsumowanie Finansowe Modułu 2:
                </span>
                <span className="px-2.5 py-1 bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 rounded-lg text-xs font-mono font-semibold">
                  STATUS: {reconciledData?.metadata.status || 'AUTO_RECONCILED'}
                </span>
              </div>

              <div className="flex items-center gap-6 font-mono text-sm">
                <div>
                  <span className="text-slate-400 text-xs mr-2">Netto WZ:</span>
                  <span className="text-white font-bold">{reconciledData?.financial_summary.total_net_wz.toFixed(2)} zł</span>
                </div>
                <div>
                  <span className="text-slate-400 text-xs mr-2">VAT (23%):</span>
                  <span className="text-slate-300">{reconciledData?.financial_summary.total_vat_wz.toFixed(2)} zł</span>
                </div>
                <div className="px-3 py-1 bg-emerald-950/60 border border-emerald-500/40 rounded-xl">
                  <span className="text-emerald-400 text-xs mr-2 font-sans font-semibold">Brutto:</span>
                  <span className="text-emerald-300 font-bold text-base">{reconciledData?.financial_summary.total_gross_wz.toFixed(2)} zł</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── SUBTAB 2: WERYFIKACJA GŁOSU (CHECKSUM & ANCHOR) ── */}
      {activeSubTab === 'voice_anchor' && (
        <div className="space-y-6">
          <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-xl">
            <h3 className="text-lg font-bold text-white flex items-center gap-2">
              <span>🎙️</span> 4-Sekundowy Meldunek Kierowcy (SOP Plac Budowy)
            </h3>
            <p className="text-sm text-slate-300 mt-1">
              Kierowca podaje w 4 sekundy kluczowe dane: <code className="text-emerald-400 font-mono">[Dostawca] → [Budowa] → [Liczba pozycji] → [Jeden główny towar + ilość]</code>.
              System przeprowadza dwuetapową weryfikację matematyczną: sumę kontrolną wierszy oraz test towaru kotwiczącego.
            </p>

            {/* Formularz meldunku */}
            <div className="mt-5 space-y-4">
              <div>
                <label className="block text-xs font-mono uppercase text-slate-400 mb-1.5">
                  Treść meldunku dyspozytorskiego kierowcy:
                </label>
                <input
                  type="text"
                  value={driverText}
                  onChange={(e) => setDriverText(e.target.value)}
                  className="w-full px-4 py-3 bg-slate-950 border border-slate-700 rounded-xl text-white font-mono text-sm focus:outline-none focus:border-emerald-500"
                  placeholder="np. CMB na Kielce, 7 pozycji na kwicie, w tym 6 płyt OSB."
                />
              </div>

              {/* Przyciski szybkich scenariuszy testowych */}
              <div className="flex flex-wrap gap-2 pt-2">
                <span className="text-xs text-slate-400 self-center mr-2">Szybkie scenariusze testowe:</span>
                <button
                  type="button"
                  onClick={() => {
                    const txt = 'CMB na Kielce, 7 pozycji na kwicie, w tym 6 płyt OSB.';
                    setDriverText(txt);
                    runModule2Reconciliation(activePayload, txt);
                  }}
                  className="px-3 py-1.5 bg-emerald-950/60 hover:bg-emerald-900/60 border border-emerald-500/40 text-emerald-300 rounded-lg text-xs font-mono transition cursor-pointer"
                >
                  ✅ 1. Zgodny (7 pozycji, 6 płyt OSB)
                </button>

                <button
                  type="button"
                  onClick={() => {
                    const txt = 'CMB na Kielce, 8 pozycji na kwicie, w tym 6 płyt OSB.';
                    setDriverText(txt);
                    runModule2Reconciliation(activePayload, txt);
                  }}
                  className="px-3 py-1.5 bg-amber-950/60 hover:bg-amber-900/60 border border-amber-500/40 text-amber-300 rounded-lg text-xs font-mono transition cursor-pointer"
                >
                  ⚠️ 2. Błąd Sumy Wierszy (8 pozycji vs 7 na WZ)
                </button>

                <button
                  type="button"
                  onClick={() => {
                    const txt = 'CMB na Kielce, 7 pozycji na kwicie, w tym 12 płyt OSB.';
                    setDriverText(txt);
                    runModule2Reconciliation(activePayload, txt);
                  }}
                  className="px-3 py-1.5 bg-red-950/60 hover:bg-red-900/60 border border-red-500/40 text-red-300 rounded-lg text-xs font-mono transition cursor-pointer"
                >
                  🚨 3. Błąd Kotwicy (12 płyt vs 6 na WZ)
                </button>
              </div>
            </div>

            {/* Wynik audytu głosu */}
            {voiceTestResult && (
              <div className="mt-6 pt-6 border-t border-slate-800">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* Krok 1: Test Sumy Kontrolnej */}
                  <div className={`p-4 rounded-xl border ${
                    voiceTestResult.actual_line_count === voiceTestResult.declared_line_count
                      ? 'bg-emerald-950/30 border-emerald-500/40'
                      : 'bg-amber-950/30 border-amber-500/40'
                  }`}>
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-mono uppercase text-slate-300 font-semibold">
                        KROK 1: Suma Kontrolna Wierszy (Checksum)
                      </span>
                      <span className={`text-xs font-mono font-bold px-2 py-0.5 rounded ${
                        voiceTestResult.actual_line_count === voiceTestResult.declared_line_count
                          ? 'bg-emerald-500/20 text-emerald-300'
                          : 'bg-amber-500/20 text-amber-300'
                      }`}>
                        {voiceTestResult.actual_line_count === voiceTestResult.declared_line_count ? 'ZGODNE' : 'ROZBIEŻNOŚĆ'}
                      </span>
                    </div>
                    <div className="mt-2 text-sm text-slate-200">
                      Deklaracja kierowcy: <span className="font-mono font-bold text-white">{voiceTestResult.declared_line_count || 'Brak'}</span> wierszy | 
                      Faktycznie na kwicie WZ: <span className="font-mono font-bold text-white">{voiceTestResult.actual_line_count}</span> wierszy
                    </div>
                  </div>

                  {/* Krok 2: Test Towaru Kotwiczącego */}
                  <div className={`p-4 rounded-xl border ${
                    voiceTestResult.anchor_quantity_matched
                      ? 'bg-emerald-950/30 border-emerald-500/40'
                      : 'bg-red-950/30 border-red-500/40'
                  }`}>
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-mono uppercase text-slate-300 font-semibold">
                        KROK 2: Towar Kotwiczący (Anchor Item)
                      </span>
                      <span className={`text-xs font-mono font-bold px-2 py-0.5 rounded ${
                        voiceTestResult.anchor_quantity_matched
                          ? 'bg-emerald-500/20 text-emerald-300'
                          : 'bg-red-500/20 text-red-300'
                      }`}>
                        {voiceTestResult.anchor_quantity_matched ? 'ZGODNE' : 'ROZBIEŻNOŚĆ'}
                      </span>
                    </div>
                    <div className="mt-2 text-sm text-slate-200">
                      Kotwica: <span className="font-mono font-bold text-white">{voiceTestResult.anchor_item || 'Brak'}</span> | 
                      Status ilości: <span className="font-bold">{voiceTestResult.anchor_quantity_matched ? 'Zgodna z WZ' : 'Brak zgodności'}</span>
                    </div>
                  </div>
                </div>

                {/* Werdykt ostateczny */}
                <div className={`mt-4 p-4 rounded-xl border flex items-center gap-3 ${
                  voiceTestResult.is_physically_confirmed
                    ? 'bg-emerald-950/50 border-emerald-500/60 text-emerald-200'
                    : 'bg-red-950/50 border-red-500/60 text-red-200'
                }`}>
                  <span className="text-2xl">
                    {voiceTestResult.is_physically_confirmed ? '🛡️' : '🚨'}
                  </span>
                  <div>
                    <div className="font-bold text-sm font-mono">
                      {voiceTestResult.is_physically_confirmed ? 'AUTO_VERIFIED: ODBIÓR POTWIERDZONY' : 'WYMAGANA WERYFIKACJA CZŁOWIEKA (HITL)'}
                    </div>
                    <div className="text-xs opacity-90 mt-0.5">
                      {voiceTestResult.verdict_reason}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── SUBTAB 3: UZGADNIANIE KSEF & HITL ── */}
      {activeSubTab === 'ksef_matcher' && (
        <div className="space-y-6">
          <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-xl">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div>
                <h3 className="text-lg font-bold text-white flex items-center gap-2">
                  <span>🔍</span> Silnik Uzgadniania Faktur Zbiorczych KSeF (KSeFReconciler)
                </h3>
                <p className="text-sm text-slate-300 mt-1">
                  Testuje alternatywę dwutorową: <code className="text-emerald-400 font-mono">Match(Tor_RAW) OR Match(Tor_NORMALIZED)</code>.
                  Wychwytuje ciche podwyżki cen powyżej progu tolerancji (np. &gt; 5%).
                </p>
              </div>

              {/* Przełącznik scenariuszy KSeF */}
              <div className="flex items-center gap-2 bg-slate-950 p-1.5 rounded-xl border border-slate-800">
                <button
                  type="button"
                  onClick={() => runKsefMatch('A_PIECES')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-mono transition cursor-pointer ${
                    ksefTestVariant === 'A_PIECES' ? 'bg-amber-600 text-white' : 'text-slate-400 hover:text-white'
                  }`}
                >
                  Wariant A (Sztuki)
                </button>
                <button
                  type="button"
                  onClick={() => runKsefMatch('B_M2')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-mono transition cursor-pointer ${
                    ksefTestVariant === 'B_M2' ? 'bg-emerald-600 text-white' : 'text-slate-400 hover:text-white'
                  }`}
                >
                  Wariant B (m²)
                </button>
                <button
                  type="button"
                  onClick={() => runKsefMatch('C_PRICE_HIKE')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-mono transition cursor-pointer ${
                    ksefTestVariant === 'C_PRICE_HIKE' ? 'bg-red-600 text-white' : 'text-slate-400 hover:text-white'
                  }`}
                >
                  Wariant C (+8.46% Podwyżka)
                </button>
              </div>
            </div>

            {/* Wynik parowania KSeF */}
            {isMatchingKsef ? (
              <div className="py-12 text-center text-slate-400">
                <div className="w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
                Uzgadnianie faktury KSeF dwoma torami...
              </div>
            ) : ksefMatchResult ? (
              <div className="mt-6 space-y-4">
                {/* Tabela weryfikacji KSeF */}
                <div className="overflow-x-auto rounded-xl border border-slate-800">
                  <table className="w-full text-left text-xs border-collapse">
                    <thead>
                      <tr className="bg-slate-800/60 text-slate-400 border-b border-slate-700/60 font-mono uppercase">
                        <th className="py-3 px-4">Pozycja na Fakturze KSeF</th>
                        <th className="py-3 px-3 text-center">Sparowany Tor</th>
                        <th className="py-3 px-3 text-right">Cena WZ</th>
                        <th className="py-3 px-3 text-right">Cena KSeF</th>
                        <th className="py-3 px-3 text-center">Odchyłka (Variance)</th>
                        <th className="py-3 px-4">Status & Weryfikacja</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800 bg-slate-950/40">
                      {ksefMatchResult.item_matches.map((m, idx) => (
                        <tr key={idx} className="hover:bg-slate-800/20">
                          <td className="py-3 px-4">
                            <div className="font-semibold text-white">{m.ksef_item_name}</div>
                            <div className="text-slate-400 font-mono text-[11px]">
                              {m.ksef_quantity} {m.ksef_unit} × {m.ksef_price_net.toFixed(2)} zł = <span className="text-white font-bold">{m.ksef_total_net.toFixed(2)} zł</span>
                            </div>
                          </td>

                          <td className="py-3 px-3 text-center">
                            <span className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold ${
                              m.match_track === 'RAW'
                                ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                                : m.match_track === 'NORMALIZED'
                                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                                : 'bg-red-500/20 text-red-300 border border-red-500/30'
                            }`}>
                              {m.match_track === 'RAW' ? 'TOR 1 (RAW)' : m.match_track === 'NORMALIZED' ? 'TOR 2 (NORMALIZED)' : 'BRAK'}
                            </span>
                          </td>

                          <td className="py-3 px-3 text-right font-mono text-slate-300">
                            {m.wz_price_net !== null ? `${m.wz_price_net.toFixed(2)} zł` : '—'}
                          </td>

                          <td className="py-3 px-3 text-right font-mono text-white font-bold">
                            {m.ksef_price_net.toFixed(2)} zł
                          </td>

                          <td className="py-3 px-3 text-center font-mono">
                            {m.variance_pct !== null ? (
                              <span className={`font-bold px-1.5 py-0.5 rounded text-xs ${
                                m.variance_pct > 5.0
                                  ? 'bg-red-500/20 text-red-400'
                                  : m.variance_pct < 0
                                  ? 'bg-emerald-500/20 text-emerald-400'
                                  : 'text-slate-300'
                              }`}>
                                {m.variance_pct > 0 ? `+${m.variance_pct}%` : `${m.variance_pct}%`}
                              </span>
                            ) : '—'}
                          </td>

                          <td className="py-3 px-4">
                            <span className={`inline-block px-2 py-0.5 rounded text-[11px] font-semibold ${
                              m.status === 'AUTO_APPROVED'
                                ? 'bg-emerald-500/20 text-emerald-300'
                                : 'bg-red-500/20 text-red-300'
                            }`}>
                              {m.status === 'AUTO_APPROVED' ? '✅ ZATWIERDZENIE AUTOMATYCZNE' : '🚨 ALERT CENOWY'}
                            </span>
                            <div className="text-[11px] text-slate-400 mt-1">
                              {m.alert_reason}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* HITL Panel Decyzyjny (z biuro-ai.md §4) */}
                {ksefMatchResult.overall_status === 'PRICE_DISCREPANCY' && (
                  <div className="bg-red-950/40 border-2 border-red-500/60 rounded-2xl p-6 shadow-2xl">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <div className="flex items-center gap-2 text-red-400 font-mono font-bold text-sm">
                          <span>⚠️</span> WYKRYTO ROZBIEŻNOŚĆ W KSEF: Hurtownia CMB Dębica | Budowa: KIELCE PRZYCHODNIA
                        </div>
                        <div className="text-white font-semibold text-base mt-2">
                          Pozycja: PŁYTA OSB-3 10/1250/2500
                        </div>
                      </div>
                      <span className="px-3 py-1 bg-red-500/20 text-red-300 border border-red-500/40 rounded-full text-xs font-mono font-bold">
                        Odchyłka: +8.46% (Limit: 5.0%)
                      </span>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4 font-mono text-xs">
                      <div className="p-3 bg-slate-900/80 rounded-xl border border-slate-800">
                        <span className="text-amber-400 font-bold block mb-1">WZ Papierowa (kierowca):</span>
                        6.00 szt. @ 62.82 zł/szt. (18.75 m² @ 20.10 zł/m²)
                        <span className="block text-white font-bold mt-1">Łącznie: 376.92 zł</span>
                      </div>
                      <div className="p-3 bg-slate-900/80 rounded-xl border border-slate-800">
                        <span className="text-red-400 font-bold block mb-1">Faktura KSeF (zbiorcza):</span>
                        18.75 m² @ 21.80 zł/m²
                        <span className="block text-white font-bold mt-1">Łącznie: 408.75 zł (+31.83 zł)</span>
                      </div>
                    </div>

                    <div className="text-xs text-red-200 mt-3">
                      <strong>WYNIK AUDYTU:</strong> Wykryto podwyżkę ceny o +8.46% (+31.83 zł netto). Przekroczono zdefiniowany próg tolerancji (5.0%).
                    </div>

                    {hitlActionTaken ? (
                      <div className="mt-4 p-3 bg-emerald-950/80 border border-emerald-500/50 rounded-xl text-emerald-300 text-xs font-mono flex items-center gap-2">
                        <span>✅</span> Wykonano decyzję HITL: <strong>{hitlActionTaken}</strong>
                      </div>
                    ) : (
                      <div className="flex flex-wrap gap-3 mt-5 pt-4 border-t border-red-900/60">
                        <button
                          type="button"
                          onClick={() => setHitlActionTaken('Zatwierdzono podwyżkę i zaktualizowano budżet budowy Kielce')}
                          className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-xl text-xs font-medium transition cursor-pointer border border-slate-700"
                        >
                          AKCEPTUJ PODWYŻKĘ (Zmień budżet)
                        </button>
                        <button
                          type="button"
                          onClick={() => setHitlActionTaken('Wygenerowano wezwanie do korekty faktury dla CMB Dębica')}
                          className="px-4 py-2 bg-amber-600 hover:bg-amber-500 text-white rounded-xl text-xs font-medium transition cursor-pointer shadow-lg"
                        >
                          WYSTĄP O KOREKTĘ DO CMB
                        </button>
                        <button
                          type="button"
                          onClick={() => setHitlActionTaken('Przesłano notatkę reklamacyjną do Zarządu')}
                          className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded-xl text-xs font-medium transition cursor-pointer shadow-lg"
                        >
                          REKLAMACJA: PRZEŚLIJ DO SZEFA
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ) : null}
          </div>
        </div>
      )}

      {/* ── SUBTAB 4: PAMIĘĆ DIALEKTÓW DOSTAWCÓW PER NIP ── */}
      {activeSubTab === 'vendor_catalog' && (
        <div className="space-y-6">
          <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-xl">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div>
                <h3 className="text-lg font-bold text-white flex items-center gap-2">
                  <span>🗄️</span> Pamięć Dialektów Dostawców (Firestore: vendor_catalogs/&#123;nip&#125;)
                </h3>
                <p className="text-sm text-slate-300 mt-1">
                  Każda hurtownia w Polsce inaczej nazywa produkty w swoim ERP. Ta pamięć zamienia lokalne nazwy na standard PESAM w 2 ms za 0 zł kosztu API.
                </p>
              </div>

              {/* Filtry NIP */}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => { setSelectedNipFilter('8722410651'); fetchVendorRules('8722410651'); }}
                  className={`px-3 py-1.5 rounded-xl text-xs font-mono transition cursor-pointer ${
                    selectedNipFilter === '8722410651' ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-300'
                  }`}
                >
                  CMB Dębica (8722410651)
                </button>
                <button
                  type="button"
                  onClick={() => { setSelectedNipFilter('7790000844'); fetchVendorRules('7790000844'); }}
                  className={`px-3 py-1.5 rounded-xl text-xs font-mono transition cursor-pointer ${
                    selectedNipFilter === '7790000844' ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-300'
                  }`}
                >
                  SIG Polska (7790000844)
                </button>
                <button
                  type="button"
                  onClick={() => { setSelectedNipFilter('5261040828'); fetchVendorRules('5261040828'); }}
                  className={`px-3 py-1.5 rounded-xl text-xs font-mono transition cursor-pointer ${
                    selectedNipFilter === '5261040828' ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-300'
                  }`}
                >
                  Castorama (5261040828)
                </button>
              </div>
            </div>

            {/* Tabela reguł dialektów */}
            <div className="mt-6 overflow-x-auto rounded-xl border border-slate-800">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-slate-800/60 text-slate-400 border-b border-slate-700/60 font-mono uppercase">
                    <th className="py-3 px-4">Lokalna Nazwa w Hurtowni</th>
                    <th className="py-3 px-3">Jedn. Fakturowa</th>
                    <th className="py-3 px-4">Standard Kosztorysowy PESAM</th>
                    <th className="py-3 px-3">Reguła Przeliczenia</th>
                    <th className="py-3 px-3 text-center">Użycia</th>
                    <th className="py-3 px-3 text-center">Pewność</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800 bg-slate-950/40">
                  {vendorRules.map((rule, idx) => (
                    <tr key={idx} className="hover:bg-slate-800/20">
                      <td className="py-3 px-4">
                        <div className="font-semibold text-white">{rule.vendor_raw_name}</div>
                        <div className="text-[10px] text-slate-400 font-mono mt-0.5">
                          Klucz: {rule.clean_lookup_key}
                        </div>
                      </td>
                      <td className="py-3 px-3 font-mono text-amber-300 font-bold">
                        {rule.vendor_invoiced_unit}
                      </td>
                      <td className="py-3 px-4">
                        <div className="font-semibold text-emerald-300">{rule.canonical_name}</div>
                        <div className="text-[10px] text-slate-400 font-mono mt-0.5">
                          Indeks: {rule.canonical_product_id} ({rule.pesam_accounting_unit})
                        </div>
                      </td>
                      <td className="py-3 px-3 font-mono text-blue-300">
                        {rule.conversion_rule.formula}
                      </td>
                      <td className="py-3 px-3 text-center font-mono text-white font-bold">
                        {rule.usage_count}x
                      </td>
                      <td className="py-3 px-3 text-center font-mono">
                        <span className="px-2 py-0.5 bg-emerald-500/20 text-emerald-300 rounded font-bold">
                          {(rule.confidence_score * 100).toFixed(0)}%
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
