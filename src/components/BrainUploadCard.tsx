// ============================================================
// PESAM Brain – BrainUploadCard
// Karta podglądu i zatwierdzania pojedynczego wgranego kosztorysu.
// ============================================================

'use client';

import { useState } from 'react';
import type { BrainUploadWithId } from '@/hooks/useBrainUploads';

interface Props {
    upload: BrainUploadWithId;
    isActionLoading: boolean;
    onApprove: (id: string, notes?: string) => void;
    onReject: (id: string, notes?: string) => void;
    onUpdateNotes: (id: string, notes: string) => void;
}

const FRESHNESS_CONFIG = {
    FRESH: { label: 'ŚWIEŻE', color: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30' },
    STALE: { label: 'ARCHIWALNE', color: 'bg-amber-500/20 text-amber-300 border-amber-500/30' },
    EXPIRED: { label: 'WYGASŁE', color: 'bg-red-500/20 text-red-400 border-red-500/30' },
} as const;

const STATUS_CONFIG = {
    PENDING_REVIEW: { label: 'Oczekuje', color: 'text-yellow-400' },
    APPROVED: { label: 'Zatwierdzone', color: 'text-emerald-400' },
    REJECTED: { label: 'Odrzucone', color: 'text-red-400' },
    PARTIAL: { label: 'Częściowe', color: 'text-blue-400' },
} as const;

export function BrainUploadCard({ upload, isActionLoading, onApprove, onReject, onUpdateNotes }: Props) {
    const [notes, setNotes] = useState(upload.userNotes ?? '');
    const [showDetails, setShowDetails] = useState(false);

    const freshness = FRESHNESS_CONFIG[upload.freshnessLevel] ?? FRESHNESS_CONFIG.EXPIRED;
    const statusCfg = STATUS_CONFIG[upload.status] ?? STATUS_CONFIG.PENDING_REVIEW;
    const isPending = upload.status === 'PENDING_REVIEW';

    const uploadDate = new Date(upload.uploadedAt).toLocaleDateString('pl-PL');
    const docDate = upload.documentDate ? new Date(upload.documentDate).toLocaleDateString('pl-PL') : '—';

    return (
        <div className={`rounded-xl border transition-all ${isPending ? 'bg-slate-800/60 border-yellow-500/30 hover:border-yellow-400/50' : 'bg-slate-800/30 border-slate-700/50'}`}>

            {/* Nagłówek karty */}
            <div className="p-4 flex items-start gap-3">
                <div className="mt-0.5 w-9 h-9 rounded-lg bg-slate-700 flex items-center justify-center shrink-0 text-lg">
                    {upload.source === 'PESAM_EXPORT' ? '🧠' : upload.source === 'EXTERNAL_PDF' ? '📄' : '📊'}
                </div>

                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-semibold text-white truncate max-w-[240px]">{upload.fileName}</p>
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${freshness.color}`}>{freshness.label}</span>
                    </div>
                    <div className="mt-1 flex items-center gap-3 text-xs text-slate-400 flex-wrap">
                        <span>Typ: <span className="text-slate-300">{upload.objectType}</span></span>
                        <span>Projekt z: <span className="text-slate-300">{docDate}</span></span>
                    </div>
                </div>

                <span className={`text-xs font-semibold shrink-0 ${statusCfg.color}`}>{statusCfg.label}</span>
            </div>

            {/* Metryki główne */}
            <div className="px-4 pb-3 grid grid-cols-2 sm:grid-cols-4 gap-2">
                <Metric label="Wartość (netto)" value={upload.totalCost_PLN ? `${(upload.totalCost_PLN / 1_000_000).toFixed(2)} mln PLN` : '—'} />
                <Metric label="Powierzchnia" value={upload.totalArea_m2 ? `${upload.totalArea_m2} m²` : '—'} />
                <Metric label="Pozycje cenowe" value={String(upload.extractedPriceCount)} sub={upload.pricesUsedForLearning ? 'uwzględnione w nauce' : 'pominięte (zbyt stare)'} subColor={upload.pricesUsedForLearning ? 'text-emerald-400' : 'text-red-400'} />
                <Metric label="Wskaźniki" value={countExtractedIndicators(upload)} sub="wyciągnięto" subColor="text-blue-400" />
            </div>

            {upload.freshnessWarning && (
                <div className="mx-4 mb-3 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs text-amber-300">
                    ⚠️ {upload.freshnessWarning}
                </div>
            )}

            {/* Akcje dla PENDING */}
            {isPending && (
                <div className="px-4 pb-4 flex gap-2">
                    <button onClick={() => { console.log('[UI] Kliknięto ZATWIERDŹ'); onApprove(upload.id, notes); }} disabled={isActionLoading} className="flex-1 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-sm font-semibold text-white transition-colors">
                        {isActionLoading ? '⏳ Przetwarzanie (zapis w transakcji)...' : '✓ Zatwierdź i naucz mózg'}
                    </button>
                    <button onClick={() => { console.log('[UI] Kliknięto ODRZUĆ'); onReject(upload.id, notes); }} disabled={isActionLoading} className="px-4 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-sm text-slate-300 transition-colors">
                        Odrzuć
                    </button>
                </div>
            )}
        </div>
    );
}

function Metric({ label, value, sub, subColor = 'text-slate-500' }: { label: string; value: string; sub?: string; subColor?: string }) {
    return (
        <div className="bg-slate-700/30 rounded-lg px-3 py-2">
            <p className="text-[10px] text-slate-500 uppercase tracking-wide">{label}</p>
            <p className="text-sm font-semibold text-white mt-0.5">{value}</p>
            {sub && <p className={`text-[10px] ${subColor}`}>{sub}</p>}
        </div>
    );
}

function countExtractedIndicators(upload: BrainUploadWithId): string {
    if (!upload.extractedIndicators) return '0';
    const count = Object.values(upload.extractedIndicators).filter((v) => v != null && typeof v === 'object' && 'avg' in (v as any)).length;
    return String(count);
}