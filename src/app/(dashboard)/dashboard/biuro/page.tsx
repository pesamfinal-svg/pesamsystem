// src/app/(dashboard)/dashboard/biuro/page.tsx
'use client';

import { useState, useRef } from 'react';
import AgentObservabilityConsole from '@/components/biuro/AgentObservabilityConsole';
import WzDriverVerifier from '@/components/biuro/WzDriverVerifier';
import type { CanonicalIngestPayload } from '@/types/biuro/canonicalDocument';

type TabType = 'ingest_lab' | 'verify_wz' | 'architecture';

export default function BiuroPage() {
    const [activeTab, setActiveTab] = useState<TabType>('ingest_lab');

    // Stan przetwarzania dokumentu w Ingestion Gateway A2A
    const [isProcessing, setIsProcessing] = useState(false);
    const [uploadError, setUploadError] = useState<string | null>(null);
    const [currentPayload, setCurrentPayload] = useState<CanonicalIngestPayload | null>(null);
    const [a2aMeta, setA2aMeta] = useState<any>(null);
    const [selectedFileName, setSelectedFileName] = useState<string | null>(null);

    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        setIsProcessing(true);
        setUploadError(null);
        setCurrentPayload(null);
        setA2aMeta(null);
        setSelectedFileName(file.name);

        try {
            const formData = new FormData();
            formData.append('file', file);

            const res = await fetch('/api/biuro/process-document', {
                method: 'POST',
                body: formData
            });

            const json = await res.json();
            if (!res.ok || !json.success) {
                throw new Error(json.error || json.details || 'Błąd podczas przetwarzania dokumentu przez agentów A2A.');
            }

            setCurrentPayload(json.data as CanonicalIngestPayload);
            setA2aMeta(json.a2a_meta);
        } catch (err: any) {
            setUploadError(err.message || 'Wystąpił błąd podczas analizy pliku.');
        } finally {
            setIsProcessing(false);
            if (fileInputRef.current) {
                fileInputRef.current.value = '';
            }
        }
    };

    return (
        <div className="space-y-6 pb-12 font-sans max-w-7xl mx-auto">
            {/* ── NAGŁÓWEK MODUŁU BIURO AI ── */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-200 pb-4">
                <div>
                    <div className="flex items-center gap-2">
                        <span className="text-2xl">🏢</span>
                        <h1 className="text-2xl font-black text-slate-900 tracking-tight">
                            Biuro AI & Automatyzacja Dokumentów
                        </h1>
                        <span className="px-2.5 py-0.5 rounded-full text-xs font-black bg-blue-100 text-blue-800 uppercase tracking-wider">
                            Moduł 1 (A2A)
                        </span>
                    </div>
                    <p className="text-xs text-slate-500 mt-1">
                        Autonomiczna brama ingestii dokumentów: faktury KSeF XML, cyfrowe PDF-y z ERP, skany pogniecionych kartek oraz notatki foniczne kierowców.
                    </p>
                </div>
            </div>

            {/* ── NAWIGACJA ZAKŁADEK (TYLKO 3 KONKRETNE) ── */}
            <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 pb-2">
                <button
                    onClick={() => setActiveTab('ingest_lab')}
                    className={`px-4 py-2.5 rounded-xl font-bold text-xs transition flex items-center gap-2 ${
                        activeTab === 'ingest_lab'
                            ? 'bg-blue-600 text-white shadow-sm'
                            : 'bg-white text-slate-600 hover:bg-slate-100 border border-slate-200'
                    }`}
                >
                    <span>🔬</span>
                    <span>Laboratorium Ingestii & Observability</span>
                </button>

                <button
                    onClick={() => setActiveTab('verify_wz')}
                    className={`px-4 py-2.5 rounded-xl font-bold text-xs transition flex items-center gap-2 ${
                        activeTab === 'verify_wz'
                            ? 'bg-blue-600 text-white shadow-sm'
                            : 'bg-white text-slate-600 hover:bg-slate-100 border border-slate-200'
                    }`}
                >
                    <span>🧪</span>
                    <span>Weryfikacja WZ (Głos Kierowcy)</span>
                </button>

                <button
                    onClick={() => setActiveTab('architecture')}
                    className={`px-4 py-2.5 rounded-xl font-bold text-xs transition flex items-center gap-2 ${
                        activeTab === 'architecture'
                            ? 'bg-blue-600 text-white shadow-sm'
                            : 'bg-white text-slate-600 hover:bg-slate-100 border border-slate-200'
                    }`}
                >
                    <span>📐</span>
                    <span>Architektura Modułu A2A</span>
                </button>
            </div>

            {/* ── TAB 1: LABORATORIUM INGESTII & AGENT OBSERVABILITY ── */}
            {activeTab === 'ingest_lab' && (
                <div className="space-y-6">
                    {/* OBSZAR UPLOADU DOKUMENTÓW */}
                    <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm space-y-4">
                        <div>
                            <h2 className="text-base font-extrabold text-slate-900">
                                Przetestuj odczyt dowolnego dokumentu
                            </h2>
                            <p className="text-xs text-slate-500 mt-0.5">
                                Przeciągnij plik faktury, WZ lub nagranie audio. Agent Dyspozytor automatycznie rozpozna sygnaturę i dobierze optymalnego agenta roboczego.
                            </p>
                        </div>

                        <div className="border-2 border-dashed border-blue-200 hover:border-blue-400 bg-blue-50/20 rounded-2xl p-8 transition text-center space-y-4">
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept=".pdf,.jpg,.jpeg,.png,.webp,.xml,.mp3,.m4a,.wav"
                                onChange={handleFileUpload}
                                className="hidden"
                                id="biuro-file-input"
                            />

                            <div className="space-y-2">
                                <span className="text-4xl block">📤</span>
                                <h3 className="font-extrabold text-slate-800 text-sm">
                                    Upuść dokument tutaj lub wybierz z dysku
                                </h3>
                                <p className="text-[11px] text-slate-500 max-w-md mx-auto">
                                    Obsługiwane formaty: <b>PDF</b> (cyfrowe i skany), <b>XML KSeF</b> (FA_VAT), <b>Obrazy</b> (JPG, PNG), <b>Audio</b> (MP3, M4A, WAV).
                                </p>
                            </div>

                            <div className="flex items-center justify-center gap-3">
                                <label
                                    htmlFor="biuro-file-input"
                                    className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs rounded-xl shadow cursor-pointer transition flex items-center gap-2 active:scale-95"
                                >
                                    <span>📁</span>
                                    <span>Wybierz plik z dysku</span>
                                </label>
                            </div>

                            {uploadError && (
                                <div className="p-3 bg-rose-50 border border-rose-200 text-rose-700 text-xs font-semibold rounded-xl max-w-lg mx-auto">
                                    ⚠️ {uploadError}
                                </div>
                            )}

                            {isProcessing && (
                                <div className="p-5 bg-white border border-blue-200 rounded-2xl max-w-lg mx-auto shadow-sm space-y-2.5 animate-pulse text-center">
                                    <div className="flex items-center justify-center gap-2 text-xs font-bold text-blue-700">
                                        <span className="animate-spin text-base">⏳</span>
                                        <span>Orkiestracja A2A w toku...</span>
                                    </div>
                                    <p className="text-[11px] text-slate-500">
                                        Plik: <b className="text-slate-800 font-mono">{selectedFileName}</b>
                                    </p>
                                    <p className="text-[10px] text-slate-400">
                                        Router identyfikuje sygnaturę &rarr; Worker parsuje dane &rarr; Gatekeeper weryfikuje sumy
                                    </p>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* KONSOLA AGENT OBSERVABILITY (PO ODCZYCIE) */}
                    {currentPayload && (
                        <AgentObservabilityConsole
                            payload={currentPayload}
                            a2aMeta={a2aMeta}
                        />
                    )}
                </div>
            )}

            {/* ── TAB 2: WERYFIKACJA WZ Z GŁOSEM KIEROWCY ── */}
            {activeTab === 'verify_wz' && (
                <WzDriverVerifier />
            )}

            {/* ── TAB 3: DOKUMENTACJA ARCHITEKTURY A2A ── */}
            {activeTab === 'architecture' && (
                <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm space-y-6">
                    <div>
                        <div className="flex items-center gap-2">
                            <span className="text-xl">📐</span>
                            <h2 className="text-base font-black text-slate-900">
                                Architektura Modułu 1: Brama Wejściowa A2A
                            </h2>
                            <span className="px-2.5 py-0.5 rounded-full text-[10px] font-black bg-emerald-100 text-emerald-800 uppercase">
                                Multi-Agent System
                            </span>
                        </div>
                        <p className="text-xs text-slate-500 mt-1">
                            Zamiast monolitycznego skryptu system wykorzystuje zespół wyspecjalizowanych agentów i deterministyczny routing.
                        </p>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                        <div className="border border-slate-200 rounded-xl p-4 bg-slate-50/60 space-y-2">
                            <div className="font-bold text-slate-900 text-sm flex items-center gap-2">
                                <span>🧭</span>
                                <span>IngestionRouterAgent (Dyspozytor)</span>
                            </div>
                            <p className="text-slate-600">
                                Deterministyczna analiza nagłówków i struktury binarnej bez użycia LLM (0 zł kosztu, 2-10 ms). Sprawdza obecność warstwy tekstowej, XML KSeF lub plików audio.
                            </p>
                        </div>

                        <div className="border border-slate-200 rounded-xl p-4 bg-slate-50/60 space-y-2">
                            <div className="font-bold text-slate-900 text-sm flex items-center gap-2">
                                <span>⚡</span>
                                <span>Agent-FastPath (Cyfrowy PDF)</span>
                            </div>
                            <p className="text-slate-600">
                                Dekompresja FlateDecode i ekstrakcja tabel w ułamku sekundy. Koszt 0 zł dla cyfrowych faktur ERP (Comarch Optima).
                            </p>
                        </div>

                        <div className="border border-slate-200 rounded-xl p-4 bg-slate-50/60 space-y-2">
                            <div className="font-bold text-slate-900 text-sm flex items-center gap-2">
                                <span>👁️</span>
                                <span>Agent-Vision (Skany i Obrazy)</span>
                            </div>
                            <p className="text-slate-600">
                                Uruchamiany wyłącznie dla pogniecionych kartek z kabiny busa, zdjęć smartfonem i skanów rastrowych.
                            </p>
                        </div>

                        <div className="border border-slate-200 rounded-xl p-4 bg-slate-50/60 space-y-2">
                            <div className="font-bold text-slate-900 text-sm flex items-center gap-2">
                                <span>🛡️</span>
                                <span>GatekeeperAgent & A2A Handshake</span>
                            </div>
                            <p className="text-slate-600">
                                Waliduje zgodność sumy pozycji z nagłówkiem. W razie błędu tabeli FastPath automatycznie deleguje plik do Agenta Wizyjnego (Fallback).
                            </p>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
