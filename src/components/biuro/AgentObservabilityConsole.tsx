'use client';
// src/components/biuro/AgentObservabilityConsole.tsx
//
// Konsola Obserwowalności Agentów (Agent Observability Console)
// Prezentuje ślad audytowy A2A w czasie rzeczywistym:
// 1. Decyzja Dyspozytora (IngestionRouterAgent)
// 2. Wynik Agenta Roboczego (Worker Agent) + czas i koszt
// 3. Ocena Gatekeepera (weryfikacja matematyczna sum)
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
    };
    initial_agent?: string;
    handshake_delegated_to?: string;
    reason?: string;
  };
}

export default function AgentObservabilityConsole({ payload, a2aMeta }: Props) {
  const [activeView, setActiveView] = useState<'table' | 'json'>('table');
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

        {/* ── KROKI PROCESU A2A (ŚLAD AUDYTOWY) ── */}
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
              Walidacja matematyczna sum:
            </p>
            <p className="text-[11px] text-slate-400">
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

        {/* ── WIDOK TABELI POZYCJI ── */}
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

        {/* ── WIDOK SUROWEGO JSON A2A ── */}
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
