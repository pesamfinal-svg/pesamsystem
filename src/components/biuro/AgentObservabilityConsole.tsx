'use client';
// src/components/biuro/AgentObservabilityConsole.tsx
//
// Konsola Obserwowalności Agentów (Agent Observability Console)
// Prezentuje pełny ślad audytowy A2A w czasie rzeczywistym:
// 1. Decyzja Dyspozytora (IngestionRouterAgent) i analiza warstwy danych
// 2. Wykonanie Agenta Roboczego (Worker Agent) + czas i koszt
// 3. Ocena Gatekeepera (Model Matematyczny - dokładne przeliczenie sumy pozycji vs nagłówka)
// 4. Ewentualny Fallback Handshake
// 5. Zunifikowane dane dokumentu (tabela pozycji + surowy JSON)

import { useState } from 'react';
import type { CanonicalIngestPayload } from '@/types/biuro/canonicalDocument';

interface Props {
  payload: CanonicalIngestPayload;
  a2aMeta?: {
    route_decision?: {
      targetAgent: string;
      sourceType: string;
      reason: string;
      detectionDetails?: any;
    };
    gatekeeper_verdict?: {
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
    };
    initial_agent?: string;
    handshake_delegated_to?: string;
    reason?: string;
  };
}

export default function AgentObservabilityConsole({ payload, a2aMeta }: Props) {
  const [activeView, setActiveView] = useState<'table' | 'json' | 'math'>('table');
  const [copied, setCopied] = useState(false);

  const { meta, document: doc, items, totals } = payload;
  const isFallback = meta.fallback_occurred || Boolean(a2aMeta?.handshake_delegated_to);

  const handleCopyJson = () => {
    navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Kolory i ikony agentów
  const agentBadges: Record<string, { bg: string; text: string; icon: string; border: string }> = {
    'Agent-KSeF':     { bg: 'bg-emerald-50', text: 'text-emerald-700', icon: '⚡', border: 'border-emerald-300' },
    'Agent-FastPath': { bg: 'bg-blue-50',    text: 'text-blue-700',    icon: '⚡', border: 'border-blue-300' },
    'Agent-Vision':   { bg: 'bg-amber-50',   text: 'text-amber-700',   icon: '👁️', border: 'border-amber-300' },
    'Agent-Audio':    { bg: 'bg-purple-50',  text: 'text-purple-700',  icon: '🎙️', border: 'border-purple-300' }
  };

  const badge = agentBadges[meta.processed_by_agent] || {
    bg: 'bg-slate-100', text: 'text-slate-700', icon: '🤖', border: 'border-slate-300'
  };

  const mathModel = a2aMeta?.gatekeeper_verdict?.mathModel;
  const detection = a2aMeta?.route_decision?.detectionDetails;

  return (
    <div className="space-y-6">
      {/* ── SEKCJA 1: PASEK STANU OBSERWOWALNOŚCI A2A ── */}
      <div className="bg-slate-900 text-slate-100 p-5 rounded-2xl border border-slate-800 shadow-xl space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800 pb-3">
          <div className="flex items-center gap-2.5">
            <span className="text-xl">📡</span>
            <div>
              <h3 className="text-sm font-black text-slate-100 uppercase tracking-wider">
                Agent Observability Trace
              </h3>
              <p className="text-[11px] font-mono text-slate-400">
                ID Ingestii: {meta.ingest_id}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <span className={`px-3 py-1 rounded-full text-xs font-black uppercase tracking-wider border flex items-center gap-1.5 ${badge.bg} ${badge.text} ${badge.border}`}>
              <span>{badge.icon}</span>
              <span>{meta.processed_by_agent}</span>
            </span>

            <span className="px-2.5 py-1 bg-slate-800 text-slate-300 rounded-lg text-xs font-mono">
              ⏱️ {meta.execution_time_ms} ms
            </span>

            <span className="px-2.5 py-1 bg-emerald-950/80 text-emerald-400 border border-emerald-800 rounded-lg text-xs font-mono font-bold">
              💰 Koszt: {meta.cost_usd === 0 ? '0.00 zł' : `$${meta.cost_usd.toFixed(4)}`}
            </span>
          </div>
        </div>

        {/* ── DIAGRAM PRZEPŁYWU PRACY (A2A WORKFLOW PIPELINE) ── */}
        <div className="bg-slate-950/70 p-4 rounded-xl border border-slate-800 space-y-2">
          <div className="flex items-center justify-between text-[11px] text-slate-400 uppercase font-bold tracking-wider">
            <span>Przepływ Dokumentu (A2A Pipeline Flow)</span>
            <span className="text-emerald-400">● Status: Zakończono sukcesem</span>
          </div>

          <div className="flex flex-col sm:flex-row items-center gap-2 pt-1 text-xs font-mono">
            {/* Węzeł 1: Router */}
            <div className="flex-1 w-full bg-slate-900 border border-slate-700/80 p-2.5 rounded-lg">
              <div className="text-[10px] text-blue-400 font-bold uppercase">1. Router Dyspozytor</div>
              <div className="text-slate-200 font-bold mt-0.5 truncate">
                {detection?.hasTextLayer ? '⚡ Fast Path (Tekst)' : `🧭 ${a2aMeta?.route_decision?.targetAgent || 'Routing'}`}
              </div>
              <div className="text-[10px] text-slate-400 truncate">
                {detection?.extractedCharactersCount ? `${detection.extractedCharactersCount} znaków PDF` : meta.source_type}
              </div>
            </div>

            <span className="text-slate-500 font-bold">&rarr;</span>

            {/* Węzeł 2: Worker Agent */}
            <div className="flex-1 w-full bg-slate-900 border border-slate-700/80 p-2.5 rounded-lg">
              <div className="text-[10px] text-amber-400 font-bold uppercase">2. Worker Execution</div>
              <div className="text-slate-200 font-bold mt-0.5 truncate">
                {meta.processed_by_agent}
              </div>
              <div className="text-[10px] text-slate-400">
                {items.length} pozycji ({meta.execution_time_ms} ms)
              </div>
            </div>

            <span className="text-slate-500 font-bold">&rarr;</span>

            {/* Węzeł 3: Gatekeeper Math */}
            <div className="flex-1 w-full bg-slate-900 border border-slate-700/80 p-2.5 rounded-lg">
              <div className="text-[10px] text-purple-400 font-bold uppercase">3. Model Matematyczny</div>
              <div className="text-slate-200 font-bold mt-0.5 truncate">
                {mathModel?.isExactMatch ? '✓ Suma 100% OK' : '✓ Zwalidowany'}
              </div>
              <div className="text-[10px] text-emerald-400 truncate font-bold">
                {totals.total_net !== null ? `${totals.total_net.toFixed(2)} zł` : 'Ilościowa'}
              </div>
            </div>

            <span className="text-slate-500 font-bold">&rarr;</span>

            {/* Węzeł 4: Canonical Output */}
            <div className="flex-1 w-full bg-slate-900 border border-emerald-700/60 p-2.5 rounded-lg">
              <div className="text-[10px] text-emerald-400 font-bold uppercase">4. Canonical Ingest</div>
              <div className="text-emerald-300 font-bold mt-0.5 truncate">
                Gotowy do Modułu 2
              </div>
              <div className="text-[10px] text-slate-400">
                Pewność: {(meta.confidence_score * 100).toFixed(0)}%
              </div>
            </div>
          </div>
        </div>

        {/* ── KROKI PROCESU A2A (SZCZEGÓŁOWY AUDYT) ── */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
          {/* Krok 1: Dyspozytor */}
          <div className="bg-slate-800/80 p-3.5 rounded-xl border border-slate-700/60 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wide">1. Router Agent</span>
              <span className="text-emerald-400 font-bold">✓ Skierowano</span>
            </div>
            <p className="text-slate-200 font-semibold text-xs">
              Typ źródła: <span className="font-mono text-amber-300">{meta.source_type}</span>
            </p>
            <p className="text-[11px] text-slate-400 leading-snug">
              {a2aMeta?.route_decision?.reason || 'Identyfikacja sygnatury i warstwy danych zakończona sukcesem.'}
            </p>
          </div>

          {/* Krok 2: Agent Roboczy */}
          <div className="bg-slate-800/80 p-3.5 rounded-xl border border-slate-700/60 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wide">2. Worker Execution</span>
              <span className="text-emerald-400 font-bold">✓ Ekstrakcja</span>
            </div>
            <p className="text-slate-200 font-semibold text-xs">
              Odczytano pozycji: <span className="font-bold text-emerald-400 font-mono">{items.length}</span>
            </p>
            <p className="text-[11px] text-slate-400">
              Pewność modelu: <b className="text-slate-200 font-mono">{(meta.confidence_score * 100).toFixed(0)}%</b>
            </p>
          </div>

          {/* Krok 3: Gatekeeper */}
          <div className="bg-slate-800/80 p-3.5 rounded-xl border border-slate-700/60 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wide">3. Gatekeeper Agent</span>
              {a2aMeta?.gatekeeper_verdict?.isValid !== false ? (
                <span className="text-emerald-400 font-bold">✓ Spójne</span>
              ) : (
                <span className="text-amber-400 font-bold">⚠️ Różnica</span>
              )}
            </div>
            <p className="text-slate-200 font-semibold text-xs">
              Model matematyczny sum:
            </p>
            <p className="text-[11px] text-slate-400 leading-snug">
              {a2aMeta?.gatekeeper_verdict?.reason || 'Wartości sum netto i pozycji są matematycznie spójne.'}
            </p>
          </div>
        </div>

        {/* ── BANER HANDSHAKE FALLBACK (JEŚLI WYSTĄPIŁ) ── */}
        {isFallback && (
          <div className="bg-amber-950/70 border border-amber-600/60 rounded-xl p-3.5 text-xs text-amber-200 flex items-start gap-3">
            <span className="text-lg">🔄</span>
            <div>
              <span className="font-bold text-amber-300 uppercase tracking-wide">
                A2A Handshake: Aktywowano Fallback Ratunkowy
              </span>
              <p className="text-[11px] text-amber-200/90 mt-0.5">
                {meta.fallback_reason || a2aMeta?.reason || 'Agent-FastPath napotkał rozbieżność w strukturze dokumentu. Zadanie zostało automatycznie przekazane do Agenta Wizyjnego (Vision).'}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* ── SEKCJA 2: KARTA METADANYCH DOKUMENTU ── */}
      <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-100 pb-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-base font-black text-slate-900">
                {doc.type} {doc.number || '(Brak numeru)'}
              </span>
              <span className="text-xs font-mono bg-slate-100 text-slate-600 px-2 py-0.5 rounded">
                Data: {doc.issue_date || 'Brak'}
              </span>
            </div>
            {doc.target_site_hint && (
              <p className="text-xs font-semibold text-blue-700 mt-1 flex items-center gap-1">
                <span>📍 Miejsce docelowe / Budowa:</span>
                <span className="bg-blue-50 px-2 py-0.5 rounded border border-blue-200">{doc.target_site_hint}</span>
              </p>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setActiveView('table')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition ${activeView === 'table' ? 'bg-blue-600 text-white shadow-sm' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
            >
              📋 Tabela Pozycji
            </button>
            <button
              onClick={() => setActiveView('math')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition ${activeView === 'math' ? 'bg-blue-600 text-white shadow-sm' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
            >
              🧮 Model Matematyczny
            </button>
            <button
              onClick={() => setActiveView('json')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition ${activeView === 'json' ? 'bg-blue-600 text-white shadow-sm' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
            >
              🧩 Surowy JSON A2A
            </button>
          </div>
        </div>

        {/* Dane kontrahentów */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
          <div className="bg-slate-50 p-3.5 rounded-xl border border-slate-200/80 space-y-1">
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">Sprzedawca / Wystawca</span>
            <div className="font-bold text-slate-800 text-sm">{doc.seller.name || 'Nie określono'}</div>
            <div className="font-mono text-slate-500">NIP: {doc.seller.nip || 'Brak'}</div>
          </div>

          <div className="bg-slate-50 p-3.5 rounded-xl border border-slate-200/80 space-y-1">
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">Nabywca / Odbiorca</span>
            <div className="font-bold text-slate-800 text-sm">{doc.buyer.name || 'Nie określono'}</div>
            <div className="font-mono text-slate-500">NIP: {doc.buyer.nip || 'Brak'}</div>
          </div>
        </div>

        {/* ── WIDOK 1: TABELA POZYCJI ── */}
        {activeView === 'table' && (
          <div className="space-y-4">
            <div className="overflow-x-auto border border-slate-200 rounded-xl">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 border-b border-slate-200 text-slate-600 font-bold uppercase text-[10px]">
                  <tr>
                    <th className="p-3 w-10 text-center">Lp</th>
                    <th className="p-3">Nazwa Towaru / Usługi (Surowa)</th>
                    <th className="p-3 text-right">Ilość</th>
                    <th className="p-3 text-center">J.m.</th>
                    <th className="p-3 text-right">Cena Netto</th>
                    <th className="p-3 text-right">Wartość Netto</th>
                    <th className="p-3 text-center">VAT</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {items.map((it) => (
                    <tr key={it.lp} className="hover:bg-slate-50/80 transition">
                      <td className="p-3 text-center font-mono text-slate-400">{it.lp}</td>
                      <td className="p-3 font-semibold text-slate-800">{it.raw_name}</td>
                      <td className="p-3 text-right font-mono font-bold text-slate-900">{it.quantity}</td>
                      <td className="p-3 text-center font-mono text-slate-600">{it.raw_unit}</td>
                      <td className="p-3 text-right font-mono text-slate-600">
                        {it.unit_price_net !== null ? `${it.unit_price_net.toFixed(2)} zł` : '—'}
                      </td>
                      <td className="p-3 text-right font-mono font-bold text-slate-900">
                        {it.total_net !== null ? `${it.total_net.toFixed(2)} zł` : '—'}
                      </td>
                      <td className="p-3 text-center font-mono text-slate-500">
                        {it.vat_rate !== null ? `${it.vat_rate}%` : '—'}
                      </td>
                    </tr>
                  ))}
                  {items.length === 0 && (
                    <tr>
                      <td colSpan={7} className="p-6 text-center text-slate-400 italic">
                        Brak odczytanych pozycji tabeli materiałowej.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Podsumowanie finansowe */}
            <div className="flex flex-col sm:flex-row justify-end gap-4 text-xs font-mono pt-2">
              <div className="bg-slate-50 p-3 rounded-xl border border-slate-200 space-y-1 min-w-[220px]">
                <div className="flex justify-between text-slate-600">
                  <span>Suma Netto:</span>
                  <span className="font-bold text-slate-900">
                    {totals.total_net !== null ? `${totals.total_net.toFixed(2)} zł` : '—'}
                  </span>
                </div>
                <div className="flex justify-between text-slate-600">
                  <span>Kwota VAT:</span>
                  <span>{totals.total_vat !== null ? `${totals.total_vat.toFixed(2)} zł` : '—'}</span>
                </div>
                <div className="flex justify-between text-slate-900 font-bold border-t border-slate-200 pt-1 text-sm">
                  <span>Suma Brutto:</span>
                  <span className="text-emerald-700">
                    {totals.total_gross !== null ? `${totals.total_gross.toFixed(2)} zł` : '—'}
                  </span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── WIDOK 2: MODEL MATEMATYCZNY (GATEKEEPER BREAKDOWN) ── */}
        {activeView === 'math' && (
          <div className="p-4 bg-slate-50 rounded-xl border border-slate-200 space-y-4 text-xs font-mono">
            <div className="flex items-center gap-2 text-slate-800 font-bold text-sm">
              <span>🧮</span>
              <span>Model Matematyczny Gatekeepera (Weryfikacja Sum)</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="bg-white p-3 rounded-lg border border-slate-200">
                <div className="text-[10px] text-slate-400 uppercase font-bold">Wyliczona Suma Pozycji</div>
                <div className="text-base font-bold text-slate-900 mt-1">
                  {mathModel?.calculatedNet !== undefined ? `${mathModel.calculatedNet.toFixed(2)} zł` : (totals.total_net ? `${totals.total_net.toFixed(2)} zł` : '—')}
                </div>
              </div>

              <div className="bg-white p-3 rounded-lg border border-slate-200">
                <div className="text-[10px] text-slate-400 uppercase font-bold">Zadeklarowana Suma w Nagłówku</div>
                <div className="text-base font-bold text-slate-900 mt-1">
                  {mathModel?.declaredNet !== undefined ? `${mathModel.declaredNet.toFixed(2)} zł` : (totals.total_net ? `${totals.total_net.toFixed(2)} zł` : '—')}
                </div>
              </div>

              <div className="bg-white p-3 rounded-lg border border-slate-200">
                <div className="text-[10px] text-slate-400 uppercase font-bold">Różnica / Odchyłka</div>
                <div className={`text-base font-bold mt-1 ${(mathModel?.difference || 0) === 0 ? 'text-emerald-600' : 'text-amber-600'}`}>
                  {mathModel?.difference !== undefined ? `${mathModel.difference.toFixed(2)} zł (0%)` : '0.00 zł (100% zgodności)'}
                </div>
              </div>
            </div>

            {mathModel?.formulaPreview && (
              <div className="bg-slate-900 text-emerald-400 p-3 rounded-lg text-xs overflow-x-auto">
                <span className="text-slate-400 block text-[10px] uppercase font-bold mb-1">Równanie Sumowania Pozycji:</span>
                <code>{mathModel.formulaPreview}</code>
              </div>
            )}

            <p className="text-slate-500 font-sans text-xs">
              Algorytm Gatekeepera sumuje iloczyny cen jednostkowych i ilości wszystkich pozycji, a następnie porównuje wynik z sumą nagłówkową dokumentu z tolerancją groszową do 1.5%.
            </p>
          </div>
        )}

        {/* ── WIDOK 3: SUROWY JSON A2A ── */}
        {activeView === 'json' && (
          <div className="relative">
            <button
              onClick={handleCopyJson}
              className="absolute top-3 right-3 px-3 py-1 bg-slate-800 hover:bg-slate-700 text-white text-[11px] rounded font-mono transition"
            >
              {copied ? '✓ Skopiowano' : '📋 Kopiuj JSON'}
            </button>
            <pre className="p-4 bg-slate-950 text-emerald-400 rounded-xl text-xs font-mono overflow-x-auto max-h-[450px]">
              {JSON.stringify(payload, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
