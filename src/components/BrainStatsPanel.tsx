// ============================================================
// PESAM Brain – BrainStatsPanel
// Wyświetla na żywo wyuczone proporcje dla wybranego typu obiektu.
// ============================================================

'use client';

import { useEffect, useState } from 'react';
import { doc, onSnapshot, getFirestore } from 'firebase/firestore';
import { app } from '@/lib/firebase/config';
import type { QuantityIndicators, BranchProportions } from '@/app/api/kosztorysant/_shared/brainKnowledge.types';

const db = getFirestore(app);

const OBJECT_TYPES = [
    { value: 'przedszkole', label: '🏫 Przedszkole' },
    { value: 'hala_produkcyjna', label: '🏭 Hala produkcyjna' },
    { value: 'budynek_mieszkalny', label: '🏠 Mieszkaniówka' },
    { value: 'inne', label: '🏗️ Inne' },
];

export function BrainStatsPanel() {
    const [selectedType, setSelectedType] = useState('przedszkole');
    const [indicators, setIndicators] = useState<QuantityIndicators | null>(null);
    const [proportions, setProportions] = useState<BranchProportions | null>(null);

    useEffect(() => {
        console.log(`[UI Stats] 🎧 Nasłuchuję wyuczonej wiedzy dla: ${selectedType}`);
        const base = `settings/brainKnowledge/${selectedType}`;

        const unsubI = onSnapshot(doc(db, `${base}/indicators`), (snap) => {
            console.log(`[UI Stats] 📊 Otrzymano nowe wskaźniki:`, snap.exists() ? snap.data() : 'Brak danych');
            setIndicators(snap.exists() ? (snap.data() as QuantityIndicators) : null);
        });
        const unsubP = onSnapshot(doc(db, `${base}/proportions`), (snap) => {
            console.log(`[UI Stats] 🥧 Otrzymano nowe proporcje:`, snap.exists() ? snap.data() : 'Brak danych');
            setProportions(snap.exists() ? (snap.data() as BranchProportions) : null);
        });

        return () => { unsubI(); unsubP(); };
    }, [selectedType]);

    const noData = !indicators && !proportions;

    return (
        <div className="bg-slate-800/50 rounded-2xl border border-slate-700 p-5 space-y-5">
            <div className="flex items-center justify-between flex-wrap gap-3">
                <div>
                    <h2 className="text-base font-bold text-white">Wiedza Mózgu</h2>
                    <p className="text-xs text-slate-400">
                        {indicators?.sampleCount ? `Na podstawie ${indicators.sampleCount} wgranych kosztorysów` : 'Brak danych'}
                    </p>
                </div>
                <select
                    value={selectedType}
                    onChange={(e) => {
                        console.log(`[UI Stats] Przełączono widok na: ${e.target.value}`);
                        setSelectedType(e.target.value);
                    }}
                    className="px-3 py-1.5 rounded-lg bg-slate-700 border border-slate-600 text-sm text-white focus:outline-none focus:border-slate-500"
                >
                    {OBJECT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
            </div>

            {noData ? (
                <div className="py-8 text-center text-sm text-slate-500">
                    Mózg nie ma jeszcze danych dla tego typu obiektu.<br />Wgraj kosztorys poniżej, aby rozpocząć uczenie.
                </div>
            ) : (
                <div>
                    <p className="text-xs text-slate-500 uppercase tracking-wide mb-2 font-semibold">Wyuczone Proporcje branż (% budżetu)</p>
                    <div className="space-y-1.5">
                        {/* Tutaj mapujemy twarde dane z bazy */}
                        <ProgressBar label="D1 Stan zerowy" value={proportions?.D1_zeroPercent?.avg} color="bg-slate-400" />
                        <ProgressBar label="D2 Stan surowy" value={proportions?.D2_roughPercent?.avg} color="bg-blue-500" />
                        <ProgressBar label="D3 Wykończenie" value={proportions?.D3_finishPercent?.avg} color="bg-indigo-500" />
                        <ProgressBar label="D5 Sanitarne" value={proportions?.D5_sanitaryPercent?.avg} color="bg-cyan-500" />
                        <ProgressBar label="D6 Elektryczne" value={proportions?.D6_electricPercent?.avg} color="bg-yellow-500" />
                    </div>
                </div>
            )}
        </div>
    );
}

function ProgressBar({ label, value, color }: { label: string, value?: number, color: string }) {
    if (value == null) return null;
    return (
        <div className="flex items-center gap-2">
            <span className="text-xs text-slate-400 w-28 shrink-0">{label}</span>
            <div className="flex-1 h-3 bg-slate-700 rounded-full overflow-hidden">
                <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(value, 100)}%` }} />
            </div>
            <span className="text-xs font-semibold text-white w-12 text-right">{value.toFixed(1)}%</span>
        </div>
    );
}