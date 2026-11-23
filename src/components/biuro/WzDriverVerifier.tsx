'use client';
// src/components/biuro/WzDriverVerifier.tsx
// Panel testowy: wpisz ręcznie co "kierowca nagral" i uruchom weryfikację WZ.
// Docelowo zastąpiony prawdziwym modułem audio z /plac.

import { useState } from 'react';
import type { VerifyWzResponse, VerificationVerdict } from '@/app/api/biuro/verify-wz/route';

interface Props {
    // Opcjonalnie: wstępnie wypełnij numer WZ (np. po wgraniu dokumentu)
    prefillWzNumber?: string;
    prefillItems?: { lp: number; name: string; quantity: number; unit: string }[];
}

const VERDICT_STYLES: Record<VerificationVerdict, { bg: string; border: string; icon: string; label: string }> = {
    AUTO_VERIFIED:  { bg: 'bg-emerald-50', border: 'border-emerald-400', icon: '✅', label: 'AUTO-ZWALIDOWANY' },
    PARTIAL_MATCH:  { bg: 'bg-amber-50',   border: 'border-amber-400',   icon: '⚠️', label: 'CZĘŚCIOWE TRAFIENIE' },
    HITL_MISMATCH:  { bg: 'bg-red-50',     border: 'border-red-400',     icon: '🚨', label: 'HITL — ROZBIEŻNOŚĆ' },
    HITL_NO_NOTE:   { bg: 'bg-slate-50',   border: 'border-slate-400',   icon: '🔍', label: 'HITL — BRAK NOTATKI' },
};

export default function WzDriverVerifier({ prefillWzNumber = '', prefillItems = [] }: Props) {
    // ── Krok 1: Zapisz notatkę kierowcy ──────────────────────────────────────
    const [wzRef, setWzRef] = useState(prefillWzNumber);
    const [driverText, setDriverText] = useState('');
    const [driverName, setDriverName] = useState('');
    const [savingNote, setSavingNote] = useState(false);
    const [savedNote, setSavedNote] = useState<{ id: string; items: { name: string; quantity: number; unit: string }[] } | null>(null);
    const [saveError, setSaveError] = useState<string | null>(null);

    // ── Krok 2: Weryfikacja WZ ────────────────────────────────────────────────
    const [verifyWzNumber, setVerifyWzNumber] = useState(prefillWzNumber);
    const [verifyItems, setVerifyItems] = useState(prefillItems);
    const [verifyItemsJson, setVerifyItemsJson] = useState(
        prefillItems.length > 0
            ? JSON.stringify(prefillItems, null, 2)
            : `[\n  { "lp": 1, "name": "PROFIL C 50/3 MB PRO", "quantity": 27, "unit": "szt" },\n  { "lp": 2, "name": "TAŚMA DYLATACYJNA 50mm", "quantity": 2, "unit": "rolka" }\n]`
    );
    const [verifying, setVerifying] = useState(false);
    const [verifyResult, setVerifyResult] = useState<VerifyWzResponse | null>(null);
    const [verifyError, setVerifyError] = useState<string | null>(null);

    // ─── Zapis notatki ────────────────────────────────────────────────────────
    const handleSaveNote = async () => {
        if (!wzRef.trim() || !driverText.trim()) return;
        setSavingNote(true);
        setSaveError(null);
        setSavedNote(null);

        try {
            const res = await fetch('/api/biuro/driver-note', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    wz_ref: wzRef.trim(),
                    raw_text: driverText.trim(),
                    driver_name: driverName.trim() || 'Tester',
                    site_id: null
                })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Błąd zapisu');
            setSavedNote({ id: data.note_id, items: data.extracted_items || [] });
            // automatycznie uzupełnij numer WZ do weryfikacji
            setVerifyWzNumber(wzRef.trim());
        } catch (err: any) {
            setSaveError(err.message);
        } finally {
            setSavingNote(false);
        }
    };

    // ─── Weryfikacja ──────────────────────────────────────────────────────────
    const handleVerify = async () => {
        setVerifying(true);
        setVerifyError(null);
        setVerifyResult(null);

        let items = verifyItems;
        if (verifyItemsJson.trim()) {
            try {
                items = JSON.parse(verifyItemsJson);
            } catch {
                setVerifyError('Nieprawidłowy JSON pozycji WZ.');
                setVerifying(false);
                return;
            }
        }

        try {
            const res = await fetch('/api/biuro/verify-wz', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    document_number: verifyWzNumber.trim(),
                    items
                })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Błąd weryfikacji');
            setVerifyResult(data.data as VerifyWzResponse);
        } catch (err: any) {
            setVerifyError(err.message);
        } finally {
            setVerifying(false);
        }
    };

    // ─── Render ───────────────────────────────────────────────────────────────
    return (
        <div className="space-y-6">
            <div className="flex items-center gap-2 mb-1">
                <span className="text-xl">🧪</span>
                <h2 className="text-base font-bold text-slate-800">Weryfikacja WZ przez Notatkę Kierowcy</h2>
                <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full font-medium">TRYB TESTOWY</span>
            </div>
            <p className="text-xs text-slate-500">
                Symuluj notatkę kierowcy (w produkcji: nagranie audio z /plac). Następnie uruchom weryfikację semantyczną.
            </p>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* ── KROK 1: Notatka kierowcy ── */}
                <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
                    <div className="flex items-center gap-2">
                        <span className="w-6 h-6 bg-blue-600 text-white text-xs font-bold rounded-full flex items-center justify-center">1</span>
                        <h3 className="font-semibold text-slate-700 text-sm">Notatka kierowcy (ręczna / testowa)</h3>
                    </div>

                    <div>
                        <label className="block text-xs font-medium text-slate-600 mb-1">Numer WZ z dokumentu</label>
                        <input
                            type="text"
                            value={wzRef}
                            onChange={e => setWzRef(e.target.value)}
                            placeholder="np. WZT/963/11/2026/DE"
                            className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-400"
                        />
                    </div>

                    <div>
                        <label className="block text-xs font-medium text-slate-600 mb-1">Imię kierowcy (opcjonalne)</label>
                        <input
                            type="text"
                            value={driverName}
                            onChange={e => setDriverName(e.target.value)}
                            placeholder="np. Jan Kowalski"
                            className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                        />
                    </div>

                    <div>
                        <label className="block text-xs font-medium text-slate-600 mb-1">Co kierowca powiedział / napisał</label>
                        <textarea
                            value={driverText}
                            onChange={e => setDriverText(e.target.value)}
                            rows={4}
                            placeholder={'np. "Wziąłem 27 profili, 2 rolki taśmy i jedno wiertło, WZ numer 963"'}
                            className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 resize-none"
                        />
                    </div>

                    <button
                        onClick={handleSaveNote}
                        disabled={savingNote || !wzRef.trim() || !driverText.trim()}
                        className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-semibold rounded-lg px-4 py-2.5 transition-colors flex items-center justify-center gap-2"
                    >
                        {savingNote ? (
                            <><span className="animate-spin">⏳</span> Przetwarzam i zapisuję...</>
                        ) : (
                            <><span>💾</span> Zapisz notatkę do Firestore</>
                        )}
                    </button>

                    {saveError && (
                        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-xs text-red-700">
                            ❌ {saveError}
                        </div>
                    )}

                    {savedNote && (
                        <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 space-y-2">
                            <p className="text-xs font-semibold text-emerald-800">✅ Zapisano! ID: <code className="font-mono">{savedNote.id}</code></p>
                            <p className="text-xs text-emerald-700">Gemini wyciągnął <strong>{savedNote.items.length}</strong> pozycji:</p>
                            <ul className="text-xs text-emerald-800 space-y-0.5">
                                {savedNote.items.map((it, i) => (
                                    <li key={i} className="font-mono">
                                        → {it.name} × {it.quantity} {it.unit}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                </div>

                {/* ── KROK 2: Weryfikacja WZ ── */}
                <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
                    <div className="flex items-center gap-2">
                        <span className="w-6 h-6 bg-purple-600 text-white text-xs font-bold rounded-full flex items-center justify-center">2</span>
                        <h3 className="font-semibold text-slate-700 text-sm">Weryfikacja semantyczna</h3>
                    </div>

                    <div>
                        <label className="block text-xs font-medium text-slate-600 mb-1">Numer dokumentu WZ (do weryfikacji)</label>
                        <input
                            type="text"
                            value={verifyWzNumber}
                            onChange={e => setVerifyWzNumber(e.target.value)}
                            placeholder="np. WZT/963/11/2026/DE"
                            className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-purple-400"
                        />
                    </div>

                    <div>
                        <label className="block text-xs font-medium text-slate-600 mb-1">Pozycje z WZ (JSON)</label>
                        <textarea
                            value={verifyItemsJson}
                            onChange={e => setVerifyItemsJson(e.target.value)}
                            rows={6}
                            className="w-full border border-slate-300 rounded-lg px-3 py-2 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-purple-400 resize-none bg-slate-50"
                        />
                    </div>

                    <button
                        onClick={handleVerify}
                        disabled={verifying || !verifyWzNumber.trim()}
                        className="w-full bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white text-sm font-semibold rounded-lg px-4 py-2.5 transition-colors flex items-center justify-center gap-2"
                    >
                        {verifying ? (
                            <><span className="animate-spin">⏳</span> Analizuję semantycznie...</>
                        ) : (
                            <><span>🔍</span> Uruchom weryfikację WZ</>
                        )}
                    </button>

                    {verifyError && (
                        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-xs text-red-700">
                            ❌ {verifyError}
                        </div>
                    )}
                </div>
            </div>

            {/* ── Wynik weryfikacji ── */}
            {verifyResult && (() => {
                const style = VERDICT_STYLES[verifyResult.verdict];
                return (
                    <div className={`${style.bg} border-2 ${style.border} rounded-xl p-5 space-y-4`}>
                        <div className="flex items-start justify-between">
                            <div>
                                <div className="flex items-center gap-2 mb-1">
                                    <span className="text-2xl">{style.icon}</span>
                                    <span className="font-bold text-slate-800 text-base">{style.label}</span>
                                    <span className="text-xs bg-white/80 border border-slate-200 px-2 py-0.5 rounded-full font-mono">
                                        confidence: {(verifyResult.confidence * 100).toFixed(0)}%
                                    </span>
                                </div>
                                <p className="text-sm text-slate-700">{verifyResult.summary}</p>
                            </div>
                            <span className="text-xs text-slate-400 whitespace-nowrap">{verifyResult.execution_time_ms} ms</span>
                        </div>

                        {verifyResult.note_found && verifyResult.driver_raw_text && (
                            <div className="bg-white/70 rounded-lg p-3 border border-slate-200">
                                <p className="text-xs font-semibold text-slate-600 mb-1">
                                    🎙️ Co powiedział {verifyResult.driver_name || 'kierowca'}:
                                </p>
                                <p className="text-sm text-slate-800 italic">„{verifyResult.driver_raw_text}"</p>
                            </div>
                        )}

                        {verifyResult.matched_pairs.length > 0 && (
                            <div>
                                <p className="text-xs font-semibold text-slate-600 mb-2">Wynik dopasowania pozycji:</p>
                                <div className="space-y-2">
                                    {verifyResult.matched_pairs.map((pair, i) => {
                                        const verdictColors = {
                                            MATCH:          'bg-emerald-100 border-emerald-300 text-emerald-800',
                                            NAME_OK_QTY_DIFF: 'bg-amber-100 border-amber-300 text-amber-800',
                                            NO_MATCH:       'bg-red-100 border-red-300 text-red-800',
                                        };
                                        const verdictLabels = {
                                            MATCH:          '✅ ZGODNY',
                                            NAME_OK_QTY_DIFF: '⚠️ NAZWA OK / ILOŚĆ RÓŻNA',
                                            NO_MATCH:       '❌ BRAK DOPASOWANIA',
                                        };
                                        return (
                                            <div key={i} className={`border rounded-lg p-3 ${verdictColors[pair.verdict]}`}>
                                                <div className="flex items-start justify-between gap-2 flex-wrap">
                                                    <div className="text-xs space-y-0.5">
                                                        <div>
                                                            <span className="font-semibold">Kierowca: </span>
                                                            {pair.driver_item.name}
                                                            {pair.driver_item.quantity > 0 && (
                                                                <span className="font-mono ml-1">× {pair.driver_item.quantity} {pair.driver_item.unit}</span>
                                                            )}
                                                        </div>
                                                        {pair.wz_item.lp !== -1 && (
                                                            <div>
                                                                <span className="font-semibold">WZ (poz. {pair.wz_item.lp}): </span>
                                                                {pair.wz_item.name}
                                                                <span className="font-mono ml-1">× {pair.wz_item.quantity} {pair.wz_item.unit}</span>
                                                            </div>
                                                        )}
                                                        <div className="text-[11px] opacity-75 mt-1 italic">{pair.explanation}</div>
                                                    </div>
                                                    <div className="text-right flex flex-col items-end gap-1">
                                                        <span className="text-[10px] font-bold">{verdictLabels[pair.verdict]}</span>
                                                        <span className="text-[10px] font-mono opacity-70">
                                                            sem: {(pair.name_match_score * 100).toFixed(0)}%
                                                            {' · '}
                                                            qty: {pair.quantity_match ? '✓' : '✗'}
                                                        </span>
                                                    </div>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        )}
                    </div>
                );
            })()}
        </div>
    );
}
