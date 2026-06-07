// ============================================================
// PESAM Brain – Główna strona zarządzania wiedzą (UI)
// /app/dashboard/brain/page.tsx
// ============================================================

'use client';

import { useState } from 'react';
import { BrainStatsPanel } from '@/components/BrainStatsPanel';
import { BrainFileUploader } from '@/components/BrainFileUploader';
import { BrainUploadCard } from '@/components/BrainUploadCard';
import { useBrainUploads } from '@/hooks/useBrainUploads';

type FilterStatus = 'ALL' | 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED';

export default function BrainPage() {
    const { uploads, stats, loading, actionLoading, error, approve, reject, updateNotes } = useBrainUploads();
    const [filter, setFilter] = useState<FilterStatus>('ALL');
    const [refreshKey, setRefreshKey] = useState(0);

    const filtered = filter === 'ALL' ? uploads : uploads.filter((u) => u.status === filter);

    const handleUploadComplete = () => {
        console.log('[UI Page] 🔄 Wymuszam odświeżenie komponentów uploada.');
        setRefreshKey((k) => k + 1);
    };

    return (
        <div className="min-h-screen bg-slate-900 text-white p-6">

            <div className="mb-6 flex items-center gap-3">
                <span className="text-3xl">🧠</span>
                <div>
                    <h1 className="text-2xl font-bold">PESAM Brain</h1>
                    <p className="text-sm text-slate-400">Centrum fine-tuningu i nauki systemu z historycznych kosztorysów.</p>
                </div>
            </div>

            {error && <div className="mb-4 px-4 py-3 bg-red-500/10 border border-red-500/20 text-red-400 rounded-lg">❌ Błąd: {error}</div>}

            <div className="grid grid-cols-1 lg:grid-cols-[400px_1fr] gap-6">

                {/* LEWA KOLUMNA: Statystyki i Wiedza */}
                <div className="space-y-6">
                    <BrainStatsPanel />
                    <div className="bg-slate-800/30 border border-slate-700 p-4 rounded-xl text-xs text-slate-400">
                        <p className="font-bold text-slate-300 mb-2">💡 Jak to działa?</p>
                        <ul className="space-y-1 list-disc pl-4">
                            <li>Wgraj archiwalny projekt (PDF/Excel).</li>
                            <li>Agent wyciągnie proporcje i ceny.</li>
                            <li>Zatwierdź go, aby zaktualizować średnią kroczącą Mózgu.</li>
                            <li>Przy nowej wycenie Rój użyje tej wiedzy (np. Gap Filler załata luki opierając się na Twoich wskaźnikach z tego typu obiektów!).</li>
                        </ul>
                    </div>
                </div>

                {/* PRAWA KOLUMNA: Uploader i Lista */}
                <div className="space-y-6">
                    <BrainFileUploader key={refreshKey} onUploadComplete={handleUploadComplete} />

                    {/* Filtry */}
                    <div className="flex gap-2">
                        {(['ALL', 'PENDING_REVIEW', 'APPROVED', 'REJECTED'] as FilterStatus[]).map((f) => (
                            <button
                                key={f}
                                onClick={() => {
                                    console.log(`[UI Page] Zmieniono filtr na: ${f}`);
                                    setFilter(f);
                                }}
                                className={`px-3 py-1.5 rounded-lg text-xs font-semibold ${filter === f ? 'bg-blue-600 text-white' : 'bg-slate-700 text-slate-400 hover:bg-slate-600'}`}
                            >
                                {f} {f === 'PENDING_REVIEW' && stats?.pending ? `(${stats.pending})` : ''}
                            </button>
                        ))}
                    </div>

                    {/* Lista kart */}
                    {loading ? (
                        <p className="text-slate-500">⏳ Ładowanie historii z Firestore...</p>
                    ) : filtered.length === 0 ? (
                        <p className="text-slate-500">Brak rekordów dla tego filtra.</p>
                    ) : (
                        <div className="space-y-4">
                            {filtered.map((upload) => (
                                <BrainUploadCard
                                    key={upload.id}
                                    upload={upload}
                                    isActionLoading={actionLoading === upload.id}
                                    onApprove={approve}
                                    onReject={reject}
                                    onUpdateNotes={updateNotes}
                                />
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}