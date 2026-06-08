'use client';

import React, { useState } from 'react';
import { useScopeManifest, type HeatMapEntry, type HeatMapColor } from '@/hooks/useScopeManifest';

// Jawny interfejs dla grup działów - rozwiązuje błędy typowania 'unknown'
interface DivisionGroup {
    name: string;
    entries: HeatMapEntry[];
}

const COLOR_STYLES: Record<HeatMapColor, { bg: string; border: string; dot: string; label: string }> = {
    green: { bg: 'bg-emerald-50/50', border: 'border-emerald-200', dot: 'bg-emerald-500', label: 'Rynkowe' },
    yellow: { bg: 'bg-amber-50/50', border: 'border-amber-200', dot: 'bg-amber-400', label: 'Normowe' },
    blue: { bg: 'bg-blue-50/50', border: 'border-blue-200', dot: 'bg-blue-500', label: 'Czytanie z rysunków' },
    purple: { bg: 'bg-purple-50/50', border: 'border-purple-200', dot: 'bg-purple-500', label: 'Wymóg Technologiczny' },
    red: { bg: 'bg-red-50/50', border: 'border-red-200', dot: 'bg-red-500', label: 'Brak danych' },
    gray: { bg: 'bg-gray-50', border: 'border-gray-200', dot: 'bg-gray-300', label: 'Nieznane' },
};

function CoverageBar({ percent, color }: { percent: number; color: string }) {
    return (
        <div className="w-full bg-slate-100 rounded-full h-1.5 overflow-hidden">
            <div className={`h-1.5 rounded-full transition-all duration-500 ${color}`} style={{ width: `${Math.min(100, percent)}%` }} />
        </div>
    );
}

function StatPill({ label, value, color }: { label: string; value: number; color: string }) {
    if (value === 0) return null;
    return (
        <div className="flex items-center gap-1.5 text-[10px]">
            <span className={`w-1.5 h-1.5 rounded-full ${color}`} />
            <span className="text-slate-500 font-semibold">{label}:</span>
            <span className="font-bold text-slate-700 ml-auto">{value}</span>
        </div>
    );
}

function HeatMapCell({ entry, onMarkReview }: { entry: HeatMapEntry; onMarkReview: (id: string) => void }) {
    const [showTooltip, setShowTooltip] = useState(false);
    const style = COLOR_STYLES[entry.color];

    return (
        <div
            className={`relative flex items-start gap-1.5 p-1.5 rounded-xl border ${style.bg} ${style.border} cursor-default transition-all hover:shadow-xs group`}
            onMouseEnter={() => setShowTooltip(true)}
            onMouseLeave={() => setShowTooltip(false)}
        >
            <span className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${style.dot} ${entry.isMandatoryByLaw ? 'ring-2 ring-offset-1 ring-red-400' : ''}`} />

            <div className="flex-1 min-w-0">
                <p className="text-[10px] font-bold text-slate-700 truncate leading-tight uppercase">
                    {entry.elementName}
                    {entry.isMandatoryByLaw && <span className="ml-1 text-red-500 text-[9px]" title="Wymagane przez Prawo Budowlane">⚖️</span>}
                    {entry.color === 'purple' && <span className="ml-1 text-purple-600 text-[9px]" title="Dodano ze względów technologicznych">🛡️</span>}
                </p>
                {entry.quantityEstimated !== null && entry.quantityEstimated !== undefined && (
                    <p className="text-[9px] text-slate-500 font-bold mt-0.5">Wyliczono: <span className="text-blue-600 font-black">{entry.quantityEstimated.toFixed(2)}</span></p>
                )}
                {entry.gapFillerValue !== null && (
                    <p className="text-[9px] text-amber-600 font-black font-mono">~{entry.gapFillerValue.toLocaleString('pl-PL')} PLN</p>
                )}
            </div>

            {showTooltip && (
                <div className="absolute z-50 bottom-full left-0 mb-1 w-64 bg-slate-900 text-white text-[9px] rounded-lg p-2 shadow-xl leading-normal pointer-events-none font-semibold">
                    {entry.tooltipText}
                    <div className="absolute top-full left-3 w-0 h-0 border-l-4 border-r-4 border-t-4 border-l-transparent border-r-transparent border-t-slate-900" />
                </div>
            )}
        </div>
    );
}

function PendingQuestionCard({ elementId, elementName, question, onAnswer }: any) {
    const [inputValue, setInputValue] = useState('');
    const [unit, setUnit] = useState('PLN');

    return (
        <div className="border border-red-200 bg-red-50/50 rounded-2xl p-2.5 mb-1.5">
            <p className="text-[10px] font-black text-red-700 mb-0.5 uppercase">⏸️ {elementName}</p>
            <p className="text-[9px] text-slate-600 mb-2 leading-tight whitespace-pre-line font-bold">{question}</p>
            <div className="flex gap-1">
                <input type="number" value={inputValue} onChange={(e) => setInputValue(e.target.value)} placeholder="Wartość..." className="flex-1 text-[10px] border border-slate-200 rounded-lg px-2 py-1 focus:outline-none focus:border-blue-400 bg-white font-black text-center" />
                <select value={unit} onChange={(e) => setUnit(e.target.value)} className="text-[9px] font-bold border border-slate-200 rounded-lg px-1 py-1 bg-white outline-none">
                    <option>PLN</option><option>m²</option><option>m³</option><option>kpl.</option><option>szt.</option><option>mb</option><option>t</option>
                </select>
                <button onClick={() => { const v = parseFloat(inputValue); if (!isNaN(v)) onAnswer(elementId, v, unit); }} className="text-[10px] bg-red-600 text-white px-2.5 py-1 rounded-lg hover:bg-red-700 transition-colors font-black">✓</button>
            </div>
        </div>
    );
}

export function ScopeHeatMap({ tenderId, className = '' }: { tenderId: string | null; className?: string }) {
    const { manifest, isLoading, error, heatMap, pendingQuestions, coverageStats, markAsNeedsReview, answerQuestion } = useScopeManifest(tenderId);
    const [activeDiv, setActiveDiv] = useState<string | null>(null);
    const [showOnlyProblems, setShowOnlyProblems] = useState(false);

    if (!tenderId) return <div className={`p-4 text-center text-slate-400 text-xs font-semibold ${className}`}>Wgraj paczkę przetargową, aby zobaczyć mapę zakresu</div>;
    if (isLoading) return <div className={`p-4 ${className}`}><div className="animate-pulse space-y-2">{[...Array(5)].map((_, i) => (<div key={i} className="h-6 bg-slate-100 rounded-xl" />))}</div></div>;
    if (error) return <div className={`p-4 text-red-500 text-[10px] font-bold ${className}`}>Błąd: {error}</div>;
    if (!manifest) return <div className={`p-4 text-slate-400 text-xs text-center font-semibold ${className}`}>Czekam na zbudowanie DNA budynku...</div>;

    // Grupowanie ze ścisłym typowaniem DivisionGroup
    const byDivision = new Map<string, DivisionGroup>();
    for (const entry of heatMap) {
        if (!byDivision.has(entry.divisionId)) {
            byDivision.set(entry.divisionId, { name: entry.divisionName, entries: [] });
        }
        byDivision.get(entry.divisionId)!.entries.push(entry);
    }

    // Bezpieczne i wydajne filtrowanie bez rzutowania na "any"
    const filteredMap = new Map<string, DivisionGroup>();
    if (showOnlyProblems) {
        for (const [id, div] of byDivision.entries()) {
            const problematic = div.entries.filter(e => e.color !== 'green');
            if (problematic.length > 0) {
                filteredMap.set(id, { name: div.name, entries: problematic });
            }
        }
    } else {
        for (const [id, div] of byDivision.entries()) {
            filteredMap.set(id, div);
        }
    }

    const barColor = coverageStats.coveragePercent >= 80 ? 'bg-emerald-500' : coverageStats.coveragePercent >= 50 ? 'bg-amber-400' : 'bg-red-500';

    return (
        <div className={`flex flex-col h-full overflow-hidden ${className}`}>
            <div className="p-3 border-b border-slate-100 bg-white flex-shrink-0">
                <div className="flex items-center justify-between mb-1.5">
                    <h3 className="text-xs font-black text-slate-800 uppercase tracking-tight">Szczelność Zakresu (PESAM 3.0)</h3>
                    <span className="text-[10px] font-black text-slate-700 bg-slate-100 px-1.5 py-0.5 rounded-full">{coverageStats.confidenceScore}%</span>
                </div>
                <div className="mb-1.5"><CoverageBar percent={coverageStats.coveragePercent} color={barColor} /></div>
                <p className="text-[9px] text-slate-400 font-bold mb-2">
                    Pokrycie: <span className="font-extrabold text-slate-700">{coverageStats.coveragePercent}%</span>
                    {coverageStats.objectType && <span className="ml-1 capitalize text-blue-600 font-black">• {coverageStats.objectType.replace('_', ' ')}</span>}
                </p>
                <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 mb-1.5 border-t pt-2 border-slate-50">
                    <StatPill label="Precyzyjne" value={coverageStats.covered} color="bg-emerald-500" />
                    <StatPill label="Zlokalizowane" value={coverageStats.needsQuantity} color="bg-blue-500" />
                    <StatPill label="Szacowane" value={coverageStats.gapFilled} color="bg-amber-400" />
                    <StatPill label="Pułapki Tech" value={coverageStats.techRequired} color="bg-purple-500" />
                    <StatPill label="Brak" value={coverageStats.missing} color="bg-red-500" />
                </div>
            </div>

            {pendingQuestions.length > 0 && (
                <div className="p-2.5 border-b border-red-100 bg-red-50/20 flex-shrink-0">
                    <p className="text-[9px] font-black text-red-700 mb-1.5 uppercase tracking-wide">⏸️ Pytania od Roju ({pendingQuestions.length})</p>
                    {/* POPRAWKA TS7006: Parametr q ma teraz jawny, bezpieczny typ strukturalny */}
                    {pendingQuestions.map((q: { elementId: string; elementName: string; question: string }) => (
                        <PendingQuestionCard key={q.elementId} {...q} onAnswer={answerQuestion} />
                    ))}
                </div>
            )}

            <div className="px-3 py-1.5 border-b border-slate-100 bg-slate-50 flex-shrink-0">
                <label className="flex items-center gap-1.5 cursor-pointer">
                    <input type="checkbox" checked={showOnlyProblems} onChange={(e) => setShowOnlyProblems(e.target.checked)} className="rounded text-blue-600 outline-none" />
                    <span className="text-[10px] text-slate-500 font-black uppercase">Ukryj pozycje "OK"</span>
                </label>
            </div>

            <div className="flex-1 overflow-y-auto p-2.5 space-y-3">
                {[...filteredMap.entries()].map(([divId, div]) => {
                    const isExpanded = activeDiv === null || activeDiv === divId;
                    const problemCount = div.entries.filter((e: HeatMapEntry) => e.color !== 'green').length;

                    return (
                        <div key={divId} className="border border-slate-100 p-1.5 rounded-2xl bg-white shadow-xs">
                            <button onClick={() => setActiveDiv(activeDiv === divId ? null : divId)} className="w-full flex items-center justify-between mb-1.5 group text-left outline-none">
                                <span className="text-[9px] font-black text-slate-400 uppercase tracking-tight truncate max-w-[170px]">{divId} · {div.name}</span>
                                <div className="flex items-center gap-1 flex-shrink-0">
                                    {problemCount > 0 && <span className="text-[8px] font-black bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full">{problemCount}</span>}
                                </div>
                            </button>
                            {isExpanded && (
                                <div className="space-y-1">
                                    {div.entries.map((entry: HeatMapEntry) => (
                                        <HeatMapCell key={entry.elementId} entry={entry} onMarkReview={markAsNeedsReview} />
                                    ))}
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}