// src/app/(dashboard)/dashboard/tarnow-archive/page.tsx
'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { db } from '@/lib/firebase/config';
import {
    collection, onSnapshot, deleteDoc, doc,
    updateDoc, addDoc, query, orderBy, where
} from 'firebase/firestore';
import { useAuth } from '@/lib/auth/AuthContext';

/* ─── Typy ─────────────────────────────────────────────── */

interface DokumentRow {
    nazwa: string;
    ilosc: number;
    uwagi: string;
}

interface TeczkaGotowe {
    id: string;
    pracownik: string;
    teczkaOpis: string;
    dataOd: string;
    dataDo: string;
    dokumenty: DokumentRow[];
    uwagi: string;
    dataWypelnienia: string;
    createdBy?: string;
    createdAt?: string;
}

interface TeczkaPending {
    id: string;
    pracownik: string;
    videoUrl: string;
    videoPath?: string;
    videoSizeMb?: number;
    createdBy?: string;
    createdAt?: string;
    status: 'DO_PRZETWORZENIA';
}

interface AnalysisData {
    teczkaOpis: string;
    pracownik: string;
    dataOd: string;
    dataDo: string;
    dokumenty: DokumentRow[];
    uwagi: string;
}

type ActiveTab = 'list' | 'pending' | 'new';

/* ─── Pomocnicze: ekstrakcja klatek z wideo ─────────────── */

async function extractFrames(videoUrl: string, maxFrames = 40): Promise<string[]> {
    return new Promise((resolve, reject) => {
        const video = document.createElement('video');
        video.crossOrigin = 'anonymous';
        video.preload = 'metadata';
        video.muted = true;
        video.playsInline = true;
        video.style.position = 'fixed';
        video.style.opacity = '0';
        video.style.pointerEvents = 'none';
        document.body.appendChild(video);

        const canvas = document.createElement('canvas');
        canvas.width = 480;
        canvas.height = 360;
        const ctx = canvas.getContext('2d')!;

        const frames: string[] = [];
        let frameIndex = 0;
        let intervals: number[] = [];

        const cleanup = () => {
            document.body.removeChild(video);
        };

        video.onloadedmetadata = () => {
            const duration = video.duration;
            if (!duration || duration === Infinity) {
                cleanup();
                resolve([]);
                return;
            }

            // Zbieramy klatki co X sekund
            const count = Math.min(maxFrames, Math.max(5, Math.floor(duration / 3)));
            intervals = Array.from({ length: count }, (_, i) =>
                (i / (count - 1)) * Math.max(duration - 0.5, 0.1)
            );

            const captureNext = () => {
                if (frameIndex >= intervals.length) {
                    cleanup();
                    resolve(frames);
                    return;
                }
                video.currentTime = intervals[frameIndex];
            };

            video.onseeked = () => {
                try {
                    ctx.drawImage(video, 0, 0, 480, 360);
                    const dataUrl = canvas.toDataURL('image/jpeg', 0.6);
                    // Oddaj tylko sam base64 (bez prefixu)
                    frames.push(dataUrl.split(',')[1]);
                } catch {
                    // Pomiń klatkę jeśli CORS blokuje
                }
                frameIndex++;
                captureNext();
            };

            captureNext();
        };

        video.onerror = () => {
            cleanup();
            reject(new Error('Nie można załadować wideo do ekstrakcji klatek'));
        };

        video.src = videoUrl;
        video.load();
    });
}

/* ─── Główny komponent ──────────────────────────────────── */

export default function TarnowArchivePage() {
    const { user } = useAuth();
    const [activeTab, setActiveTab] = useState<ActiveTab>('list');

    /* ── Gotowe teczki ── */
    const [teczki, setTeczki] = useState<TeczkaGotowe[]>([]);
    const [loadingTeczki, setLoadingTeczki] = useState(true);
    const [searchQuery, setSearchQuery] = useState('');
    const [downloadingId, setDownloadingId] = useState<string | null>(null);
    const [editingTeczka, setEditingTeczka] = useState<TeczkaGotowe | null>(null);
    const [savingEdit, setSavingEdit] = useState(false);

    /* ── Oczekujące teczki (DO_PRZETWORZENIA) ── */
    const [pendingTeczki, setPendingTeczki] = useState<TeczkaPending[]>([]);
    const [loadingPending, setLoadingPending] = useState(true);
    // Stan analizy per teczka: id -> { analyzing, error, formData }
    const [pendingAnalysis, setPendingAnalysis] = useState<
        Record<string, { analyzing: boolean; error: string | null; formData: AnalysisData | null }>
    >({});
    const [savingPendingId, setSavingPendingId] = useState<string | null>(null);

    /* ── Zakładka 'new': wgraj z PC ── */
    const [videoFile, setVideoFile] = useState<File | null>(null);
    const [videoPreviewUrl, setVideoPreviewUrl] = useState<string | null>(null);
    const [analyzing, setAnalyzing] = useState(false);
    const [uploadError, setUploadError] = useState<string | null>(null);
    const [formData, setFormData] = useState<AnalysisData | null>(null);
    const [dataWypelnienia] = useState(() => new Date().toISOString().split('T')[0]);
    const [savingNew, setSavingNew] = useState(false);

    const captureInputRef = useRef<HTMLInputElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    /* ══ Firestore: Gotowe ══ */
    useEffect(() => {
        const q = query(
            collection(db, 'tarnow_archive'),
            where('status', '==', 'GOTOWE'),
            orderBy('createdAt', 'desc')
        );
        const unsub = onSnapshot(q, (snap) => {
            const items: TeczkaGotowe[] = snap.docs.map((d) => {
                const data = d.data();
                return {
                    id: d.id,
                    pracownik: data.pracownik || 'Bez nazwiska',
                    teczkaOpis: data.teczkaOpis || 'Teczka akt osobowych',
                    dataOd: data.dataOd || '',
                    dataDo: data.dataDo || '',
                    dokumenty: data.dokumenty || [],
                    uwagi: data.uwagi || '',
                    dataWypelnienia: data.dataWypelnienia || new Date().toISOString().split('T')[0],
                    createdBy: data.createdBy || '',
                    createdAt: data.createdAt || '',
                };
            });
            setTeczki(items);
            setLoadingTeczki(false);
        }, () => setLoadingTeczki(false));
        return () => unsub();
    }, []);

    /* ══ Firestore: Oczekujące ══ */
    useEffect(() => {
        const q = query(
            collection(db, 'tarnow_archive'),
            where('status', '==', 'DO_PRZETWORZENIA'),
            orderBy('createdAt', 'desc')
        );
        const unsub = onSnapshot(q, (snap) => {
            const items: TeczkaPending[] = snap.docs.map((d) => {
                const data = d.data();
                return {
                    id: d.id,
                    pracownik: data.pracownik || '',
                    videoUrl: data.videoUrl || '',
                    videoPath: data.videoPath,
                    videoSizeMb: data.videoSizeMb,
                    createdBy: data.createdBy || '',
                    createdAt: data.createdAt || '',
                    status: 'DO_PRZETWORZENIA',
                };
            });
            setPendingTeczki(items);
            setLoadingPending(false);
        }, () => setLoadingPending(false));
        return () => unsub();
    }, []);

    /* ── Pobierz DOCX ── */
    const downloadDocxForTeczka = async (item: TeczkaGotowe) => {
        setDownloadingId(item.id);
        try {
            const res = await fetch('/api/tarnow-generate-docx', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    pracownik: item.pracownik,
                    teczkaOpis: item.teczkaOpis,
                    dataOd: item.dataOd,
                    dataDo: item.dataDo,
                    dokumenty: item.dokumenty,
                    uwagi: item.uwagi,
                    dataWypelnienia: item.dataWypelnienia,
                }),
            });
            if (!res.ok) { const e = await res.json(); throw new Error(e.error || 'Błąd generowania'); }
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            const name = item.pracownik
                ? `archiwum-${item.pracownik.replace(/\s+/g, '-').toLowerCase()}.docx`
                : 'archiwum-tarnow.docx';
            a.href = url; a.download = name;
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } catch (err) {
            alert(err instanceof Error ? err.message : 'Błąd pobierania pliku');
        } finally {
            setDownloadingId(null);
        }
    };

    /* ── Usuń teczkę ── */
    const handleDeleteTeczka = async (id: string, name: string) => {
        if (!confirm(`Usunąć teczkę "${name}"?`)) return;
        try { await deleteDoc(doc(db, 'tarnow_archive', id)); }
        catch (err) { alert('Błąd: ' + (err instanceof Error ? err.message : String(err))); }
    };

    /* ── Edycja gotowej teczki ── */
    const handleSaveEdit = async () => {
        if (!editingTeczka) return;
        setSavingEdit(true);
        try {
            await updateDoc(doc(db, 'tarnow_archive', editingTeczka.id), {
                pracownik: editingTeczka.pracownik,
                teczkaOpis: editingTeczka.teczkaOpis,
                dataOd: editingTeczka.dataOd,
                dataDo: editingTeczka.dataDo,
                dokumenty: editingTeczka.dokumenty,
                uwagi: editingTeczka.uwagi,
                dataWypelnienia: editingTeczka.dataWypelnienia,
            });
            setEditingTeczka(null);
        } catch (err) {
            alert('Błąd zapisu: ' + (err instanceof Error ? err.message : String(err)));
        } finally {
            setSavingEdit(false);
        }
    };

    /* ══════════════════════════════════════════
       LOGIKA: Analizuj oczekującą teczkę z AI
    ══════════════════════════════════════════ */

    const analyzePending = async (item: TeczkaPending) => {
        setPendingAnalysis(prev => ({
            ...prev,
            [item.id]: { analyzing: true, error: null, formData: null },
        }));

        try {
            // 1. Wyciągnij klatki z wideo
            let frames: string[] = [];
            try {
                frames = await extractFrames(item.videoUrl, 40);
            } catch {
                // Jeśli CORS blokuje ekstrakcję klatek, spróbujemy bez klatek
                frames = [];
            }

            if (frames.length === 0) {
                throw new Error(
                    'Nie udało się załadować wideo do analizy. ' +
                    'Upewnij się że reguły Firebase Storage pozwalają na odczyt, ' +
                    'lub użyj zakładki "Dodaj / Wgraj wideo z PC" i wgraj plik lokalnie.'
                );
            }

            // 2. Wyślij klatki do API
            const res = await fetch('/api/tarnow-analyze-video', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ frames }),
            });

            const result = await res.json();
            if (!res.ok || result.error) throw new Error(result.error || 'Błąd analizy AI');

            const data = result.data;
            setPendingAnalysis(prev => ({
                ...prev,
                [item.id]: {
                    analyzing: false,
                    error: null,
                    formData: {
                        teczkaOpis: data.teczkaOpis || 'Teczka akt osobowych',
                        pracownik: data.pracownik || item.pracownik || '',
                        dataOd: data.dataOd || '',
                        dataDo: data.dataDo || '',
                        dokumenty: data.dokumenty?.length > 0
                            ? data.dokumenty
                            : [{ nazwa: 'Dokumentacja osobowa', ilosc: 1, uwagi: '' }],
                        uwagi: data.uwagi || '',
                    },
                },
            }));
        } catch (err) {
            setPendingAnalysis(prev => ({
                ...prev,
                [item.id]: {
                    analyzing: false,
                    error: err instanceof Error ? err.message : 'Nieznany błąd',
                    formData: null,
                },
            }));
        }
    };

    const updatePendingFormData = (id: string, updater: (prev: AnalysisData) => AnalysisData) => {
        setPendingAnalysis(prev => {
            const cur = prev[id];
            if (!cur?.formData) return prev;
            return { ...prev, [id]: { ...cur, formData: updater(cur.formData) } };
        });
    };

    const savePendingAsGotowe = async (item: TeczkaPending) => {
        const state = pendingAnalysis[item.id];
        if (!state?.formData) return;
        setSavingPendingId(item.id);
        try {
            const userFullName = user ? `${user.firstName || ''} ${user.lastName || ''}`.trim() : 'Biuro';
            await updateDoc(doc(db, 'tarnow_archive', item.id), {
                pracownik: state.formData.pracownik.trim() || 'Bez nazwiska',
                teczkaOpis: state.formData.teczkaOpis.trim() || 'Teczka akt osobowych',
                dataOd: state.formData.dataOd || '',
                dataDo: state.formData.dataDo || '',
                dokumenty: state.formData.dokumenty.filter(d => d.nazwa.trim().length > 0),
                uwagi: state.formData.uwagi || '',
                dataWypelnienia: new Date().toISOString().split('T')[0],
                analyzedBy: userFullName,
                analyzedAt: new Date().toISOString(),
                status: 'GOTOWE',
            });
            // Wyczyść stan analizy
            setPendingAnalysis(prev => {
                const next = { ...prev };
                delete next[item.id];
                return next;
            });
        } catch (err) {
            alert('Błąd zapisu: ' + (err instanceof Error ? err.message : String(err)));
        } finally {
            setSavingPendingId(null);
        }
    };

    /* ══ Zakładka 'new': wgraj z PC ══ */
    const handleVideoSelected = useCallback((file: File) => {
        setVideoFile(file);
        setUploadError(null);
        setVideoPreviewUrl(URL.createObjectURL(file));
        setFormData(null);
    }, []);

    const analyzeVideo = async () => {
        if (!videoFile) return;
        setAnalyzing(true);
        setUploadError(null);
        try {
            // Wyciągnij klatki z lokalnego pliku
            const localUrl = videoPreviewUrl!;
            const frames = await extractFrames(localUrl, 40).catch(() => [] as string[]);

            const body = frames.length > 0
                ? { frames }
                : {
                    videoBase64: await new Promise<string>((res, rej) => {
                        const r = new FileReader();
                        r.onload = () => res((r.result as string).split(',')[1]);
                        r.onerror = rej;
                        r.readAsDataURL(videoFile);
                    }),
                    mimeType: videoFile.type || 'video/mp4',
                };

            const response = await fetch('/api/tarnow-analyze-video', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });

            const result = await response.json();
            if (!response.ok || result.error) throw new Error(result.error || 'Błąd analizy');

            setFormData({
                teczkaOpis: result.data.teczkaOpis || 'Teczka akt osobowych',
                pracownik: result.data.pracownik || '',
                dataOd: result.data.dataOd || '',
                dataDo: result.data.dataDo || '',
                dokumenty: result.data.dokumenty?.length > 0
                    ? result.data.dokumenty
                    : [{ nazwa: 'Dokumentacja osobowa', ilosc: 1, uwagi: '' }],
                uwagi: result.data.uwagi || '',
            });
        } catch (err) {
            setUploadError(err instanceof Error ? err.message : 'Nieznany błąd');
        } finally {
            setAnalyzing(false);
        }
    };

    const handleSaveNewFromPc = async () => {
        if (!formData) return;
        setSavingNew(true);
        try {
            const userFullName = user ? `${user.firstName || ''} ${user.lastName || ''}`.trim() : 'Biuro';
            await addDoc(collection(db, 'tarnow_archive'), {
                pracownik: formData.pracownik.trim() || 'Bez nazwiska',
                teczkaOpis: formData.teczkaOpis.trim() || 'Teczka akt osobowych',
                dataOd: formData.dataOd || '',
                dataDo: formData.dataDo || '',
                dokumenty: formData.dokumenty.filter(d => d.nazwa.trim().length > 0),
                uwagi: formData.uwagi || '',
                dataWypelnienia,
                createdBy: userFullName,
                createdAt: new Date().toISOString(),
                status: 'GOTOWE',
            });
            setFormData(null); setVideoFile(null); setVideoPreviewUrl(null);
            setActiveTab('list');
        } catch (err) {
            alert('Błąd zapisu: ' + (err instanceof Error ? err.message : String(err)));
        } finally {
            setSavingNew(false);
        }
    };

    /* ── Filtrowanie ── */
    const filteredTeczki = teczki.filter((t) => {
        const q = searchQuery.toLowerCase();
        return (
            t.pracownik.toLowerCase().includes(q) ||
            t.teczkaOpis.toLowerCase().includes(q) ||
            t.dataOd.includes(q) ||
            t.dataDo.includes(q) ||
            (t.createdBy && t.createdBy.toLowerCase().includes(q))
        );
    });

    /* ════════════════════════════════════════
       RENDER
    ════════════════════════════════════════ */

    return (
        <div className="p-8 max-w-7xl mx-auto font-sans">

            {/* ── Header ── */}
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-8">
                <div>
                    <h1 className="text-3xl font-black text-slate-900 tracking-tight flex items-center gap-3">
                        <span>🗂️</span> Archiwum Tarnów
                    </h1>
                    <p className="text-slate-500 text-sm mt-1">
                        PSS SPOŁEM Tarnów — cyfryzacja i generowanie wykazów dokumentów akt osobowych
                    </p>
                </div>

                {/* Zakładki */}
                <div className="flex items-center gap-2 bg-slate-200/80 p-1.5 rounded-2xl flex-wrap">
                    <button
                        onClick={() => setActiveTab('list')}
                        className={`px-4 py-2.5 rounded-xl text-xs font-black transition flex items-center gap-2 ${activeTab === 'list'
                            ? 'bg-white text-slate-900 shadow-sm'
                            : 'text-slate-600 hover:text-slate-900'
                            }`}
                    >
                        <span>📁</span>
                        <span>Zapisane teczki ({teczki.length})</span>
                    </button>

                    <button
                        onClick={() => setActiveTab('pending')}
                        className={`px-4 py-2.5 rounded-xl text-xs font-black transition flex items-center gap-2 ${activeTab === 'pending'
                            ? 'bg-white text-slate-900 shadow-sm'
                            : 'text-slate-600 hover:text-slate-900'
                            }`}
                    >
                        <span>⏳</span>
                        <span>Do przetworzenia</span>
                        {pendingTeczki.length > 0 && (
                            <span className="bg-orange-500 text-white text-[10px] font-black rounded-full px-1.5 py-0.5 leading-none">
                                {pendingTeczki.length}
                            </span>
                        )}
                    </button>

                    <button
                        onClick={() => setActiveTab('new')}
                        className={`px-4 py-2.5 rounded-xl text-xs font-black transition flex items-center gap-2 ${activeTab === 'new'
                            ? 'bg-white text-slate-900 shadow-sm'
                            : 'text-slate-600 hover:text-slate-900'
                            }`}
                    >
                        <span>➕</span>
                        <span>Wgraj z PC</span>
                    </button>
                </div>
            </div>

            {/* ══════════════════════════════════════
                ZAKŁADKA 1: ZAPISANE TECZKI (GOTOWE)
            ══════════════════════════════════════ */}
            {activeTab === 'list' && (
                <div className="space-y-6">
                    <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm flex flex-col sm:flex-row items-center justify-between gap-4">
                        <div className="relative w-full sm:w-96">
                            <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400">🔍</span>
                            <input
                                type="text"
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                placeholder="Szukaj po nazwisku, dacie..."
                                className="w-full pl-10 pr-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                            />
                        </div>
                        <div className="text-xs text-slate-500">
                            Teczki nagrane telefonem pojawiają się w zakładce <b>Do przetworzenia</b>.
                        </div>
                    </div>

                    {loadingTeczki && (
                        <div className="text-center py-20 text-slate-400">
                            <div className="inline-block animate-spin text-3xl mb-2">⏳</div>
                            <p className="text-sm">Ładowanie archiwum...</p>
                        </div>
                    )}

                    {!loadingTeczki && filteredTeczki.length === 0 && (
                        <div className="bg-white rounded-3xl border border-dashed border-slate-300 p-16 text-center">
                            <div className="text-5xl mb-3">📂</div>
                            <h3 className="text-lg font-bold text-slate-700">Brak zapisanych teczek</h3>
                            <p className="text-sm text-slate-400 mt-1 max-w-md mx-auto">
                                Nagraj teczkę telefonem (<b>PESAM PLAC → Nagraj Teczkę</b>), a następnie przejdź do zakładki
                                {' '}<b>Do przetworzenia</b> i kliknij &ldquo;Analizuj z AI&rdquo;.
                            </p>
                        </div>
                    )}

                    <div className="grid grid-cols-1 gap-4">
                        {filteredTeczki.map((item) => (
                            <div
                                key={item.id}
                                className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm hover:border-blue-400/80 transition flex flex-col lg:flex-row lg:items-center justify-between gap-6"
                            >
                                <div className="space-y-2 flex-1">
                                    <div className="flex items-center gap-3 flex-wrap">
                                        <h3 className="text-xl font-black text-slate-900 tracking-tight">{item.pracownik}</h3>
                                        {(item.dataOd || item.dataDo) && (
                                            <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-blue-50 text-blue-700 border border-blue-200">
                                                Lata: {item.dataOd || '?'} – {item.dataDo || '?'}
                                            </span>
                                        )}
                                        <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">
                                            ✓ GOTOWE
                                        </span>
                                        <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-slate-100 text-slate-700">
                                            {item.dokumenty.length} poz.
                                        </span>
                                    </div>
                                    <p className="text-xs text-slate-500 font-medium">📁 {item.teczkaOpis}</p>
                                    <div className="flex flex-wrap gap-1.5 pt-1">
                                        {item.dokumenty.slice(0, 6).map((dok, idx) => (
                                            <span key={idx} className="text-[11px] bg-slate-50 border border-slate-200 rounded-lg px-2 py-0.5 text-slate-600">
                                                {dok.nazwa} {dok.ilosc > 1 ? `(${dok.ilosc} szt.)` : ''}
                                            </span>
                                        ))}
                                        {item.dokumenty.length > 6 && (
                                            <span className="text-[11px] text-slate-400 self-center">+{item.dokumenty.length - 6} więcej</span>
                                        )}
                                    </div>
                                    <div className="text-[11px] text-slate-400 pt-1">
                                        Dodano: {item.createdAt ? new Date(item.createdAt).toLocaleString('pl-PL') : '—'}
                                        {item.createdBy && ` przez: ${item.createdBy}`}
                                    </div>
                                </div>
                                <div className="flex items-center gap-3 shrink-0">
                                    <button
                                        onClick={() => setEditingTeczka(item)}
                                        className="px-4 py-3 rounded-xl border border-slate-300 hover:bg-slate-50 text-xs font-bold text-slate-700 transition"
                                    >
                                        ✏️ Edytuj
                                    </button>
                                    <button
                                        onClick={() => downloadDocxForTeczka(item)}
                                        disabled={downloadingId === item.id}
                                        className={`px-5 py-3 rounded-xl text-xs font-black transition shadow-md flex items-center gap-2 ${downloadingId === item.id
                                            ? 'bg-slate-300 text-slate-500 cursor-not-allowed'
                                            : 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-emerald-200'
                                            }`}
                                    >
                                        {downloadingId === item.id ? 'Generowanie...' : <><span>📥</span><span>Pobierz Word</span></>}
                                    </button>
                                    <button
                                        onClick={() => handleDeleteTeczka(item.id, item.pracownik)}
                                        className="p-3 rounded-xl text-slate-400 hover:text-red-600 hover:bg-red-50 transition"
                                        title="Usuń"
                                    >
                                        🗑️
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* ══════════════════════════════════════
                ZAKŁADKA 2: DO PRZETWORZENIA
            ══════════════════════════════════════ */}
            {activeTab === 'pending' && (
                <div className="space-y-6">
                    <div className="bg-orange-50 border border-orange-200 rounded-2xl p-4 flex items-start gap-3">
                        <span className="text-2xl">📱</span>
                        <div>
                            <p className="text-sm font-bold text-orange-800">Teczki nagrane telefonem</p>
                            <p className="text-xs text-orange-700 mt-0.5">
                                Poniżej znajdują się nagrania wideo przesłane z telefonu. Kliknij <b>Analizuj z AI</b> —
                                system wyciągnie klatki z wideo, rozpozna typy dokumentów i wypełni wykaz. Sprawdź wynik i zapisz.
                            </p>
                        </div>
                    </div>

                    {loadingPending && (
                        <div className="text-center py-20 text-slate-400">
                            <div className="inline-block animate-spin text-3xl mb-2">⏳</div>
                            <p className="text-sm">Ładowanie nagrań...</p>
                        </div>
                    )}

                    {!loadingPending && pendingTeczki.length === 0 && (
                        <div className="bg-white rounded-3xl border border-dashed border-slate-300 p-16 text-center">
                            <div className="text-5xl mb-3">✅</div>
                            <h3 className="text-lg font-bold text-slate-700">Brak nagrań do przetworzenia</h3>
                            <p className="text-sm text-slate-400 mt-1">
                                Nagraj teczkę telefonem w <b>PESAM PLAC → Nagraj Teczkę</b>, a pojawi się tutaj.
                            </p>
                        </div>
                    )}

                    <div className="space-y-6">
                        {pendingTeczki.map((item) => {
                            const state = pendingAnalysis[item.id];
                            const isAnalyzing = state?.analyzing === true;
                            const analysisError = state?.error ?? null;
                            const analysisForm = state?.formData ?? null;

                            return (
                                <div key={item.id} className="bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden">
                                    {/* Nagłówek karty */}
                                    <div className="p-5 border-b border-slate-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                                        <div>
                                            <div className="flex items-center gap-2 flex-wrap">
                                                <span className="text-orange-500 font-black text-sm">⏳ DO PRZETWORZENIA</span>
                                                {item.pracownik && (
                                                    <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-slate-100 text-slate-700">
                                                        {item.pracownik}
                                                    </span>
                                                )}
                                                {item.videoSizeMb && (
                                                    <span className="text-xs text-slate-400">{item.videoSizeMb} MB</span>
                                                )}
                                            </div>
                                            <div className="text-[11px] text-slate-400 mt-1">
                                                Nagrano: {item.createdAt ? new Date(item.createdAt).toLocaleString('pl-PL') : '—'}
                                                {item.createdBy && ` przez: ${item.createdBy}`}
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-2 shrink-0">
                                            {!analysisForm && (
                                                <button
                                                    onClick={() => analyzePending(item)}
                                                    disabled={isAnalyzing}
                                                    className={`px-5 py-3 rounded-2xl text-sm font-black transition flex items-center gap-2 ${isAnalyzing
                                                        ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
                                                        : 'bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-200'
                                                        }`}
                                                >
                                                    {isAnalyzing ? (
                                                        <><span className="animate-spin">⏳</span><span>Analizuję...</span></>
                                                    ) : (
                                                        <><span>🤖</span><span>Analizuj z AI</span></>
                                                    )}
                                                </button>
                                            )}
                                            <button
                                                onClick={() => handleDeleteTeczka(item.id, item.pracownik || 'tę teczkę')}
                                                className="p-2.5 rounded-xl text-slate-400 hover:text-red-600 hover:bg-red-50 transition text-sm"
                                                title="Usuń"
                                            >
                                                🗑️
                                            </button>
                                        </div>
                                    </div>

                                    {/* Podgląd wideo */}
                                    {item.videoUrl && !analysisForm && (
                                        <div className="px-5 py-4">
                                            <p className="text-xs font-bold text-slate-500 uppercase mb-2">Podgląd nagrania</p>
                                            <video
                                                src={item.videoUrl}
                                                controls
                                                className="w-full max-w-lg rounded-2xl bg-black"
                                                style={{ maxHeight: '240px' }}
                                            />
                                            {isAnalyzing && (
                                                <div className="mt-3 p-3 bg-blue-50 border border-blue-200 rounded-xl text-xs text-blue-700">
                                                    <span className="animate-spin inline-block mr-2">⏳</span>
                                                    Wyciągam klatki z wideo i analizuję dokumenty... To może potrwać 15–60 sekund.
                                                </div>
                                            )}
                                        </div>
                                    )}

                                    {/* Błąd analizy */}
                                    {analysisError && (
                                        <div className="mx-5 mb-4 p-4 bg-red-50 border border-red-200 rounded-2xl">
                                            <p className="text-sm font-bold text-red-700 mb-1">⚠️ Błąd analizy</p>
                                            <p className="text-xs text-red-600">{analysisError}</p>
                                            <button
                                                onClick={() => analyzePending(item)}
                                                className="mt-2 px-4 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-bold"
                                            >
                                                Spróbuj ponownie
                                            </button>
                                        </div>
                                    )}

                                    {/* Formularz po analizie */}
                                    {analysisForm && (
                                        <div className="p-5 space-y-5">
                                            <div className="flex items-center gap-2">
                                                <span className="text-emerald-600 font-black">✅ AI rozpoznało dokumenty</span>
                                                <span className="text-xs text-slate-400">— sprawdź i popraw jeśli trzeba</span>
                                            </div>

                                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                                <div>
                                                    <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Pracownik</label>
                                                    <input
                                                        type="text"
                                                        value={analysisForm.pracownik}
                                                        onChange={(e) => updatePendingFormData(item.id, f => ({ ...f, pracownik: e.target.value }))}
                                                        className="w-full border border-slate-300 rounded-xl px-3 py-2 text-sm font-bold focus:outline-none focus:ring-2 focus:ring-blue-500"
                                                        placeholder="Nazwisko pracownika"
                                                    />
                                                </div>
                                                <div>
                                                    <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Opis teczki</label>
                                                    <input
                                                        type="text"
                                                        value={analysisForm.teczkaOpis}
                                                        onChange={(e) => updatePendingFormData(item.id, f => ({ ...f, teczkaOpis: e.target.value }))}
                                                        className="w-full border border-slate-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                                                    />
                                                </div>
                                                <div>
                                                    <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Data od</label>
                                                    <input
                                                        type="text"
                                                        value={analysisForm.dataOd}
                                                        onChange={(e) => updatePendingFormData(item.id, f => ({ ...f, dataOd: e.target.value }))}
                                                        className="w-full border border-slate-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                                                        placeholder="np. 1985"
                                                    />
                                                </div>
                                                <div>
                                                    <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Data do</label>
                                                    <input
                                                        type="text"
                                                        value={analysisForm.dataDo}
                                                        onChange={(e) => updatePendingFormData(item.id, f => ({ ...f, dataDo: e.target.value }))}
                                                        className="w-full border border-slate-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                                                        placeholder="np. 2010"
                                                    />
                                                </div>
                                            </div>

                                            {/* Lista dokumentów */}
                                            <div>
                                                <label className="block text-xs font-bold text-slate-500 uppercase mb-2">
                                                    Dokumenty w teczce ({analysisForm.dokumenty.length} poz.)
                                                </label>
                                                <div className="border border-slate-200 rounded-2xl overflow-hidden">
                                                    <table className="w-full text-xs">
                                                        <thead className="bg-slate-50 border-b border-slate-200">
                                                            <tr>
                                                                <th className="text-left px-3 py-2 text-slate-500 font-bold w-8">Lp.</th>
                                                                <th className="text-left px-3 py-2 text-slate-500 font-bold">Nazwa dokumentu</th>
                                                                <th className="text-left px-3 py-2 text-slate-500 font-bold w-16">Ilość</th>
                                                                <th className="w-8"></th>
                                                            </tr>
                                                        </thead>
                                                        <tbody className="divide-y divide-slate-100">
                                                            {analysisForm.dokumenty.map((dok, idx) => (
                                                                <tr key={idx} className="hover:bg-slate-50">
                                                                    <td className="px-3 py-2 text-slate-400">{idx + 1}.</td>
                                                                    <td className="px-3 py-2">
                                                                        <input
                                                                            type="text"
                                                                            value={dok.nazwa}
                                                                            onChange={(e) => updatePendingFormData(item.id, f => {
                                                                                const d = [...f.dokumenty];
                                                                                d[idx] = { ...d[idx], nazwa: e.target.value };
                                                                                return { ...f, dokumenty: d };
                                                                            })}
                                                                            className="w-full border-0 bg-transparent focus:outline-none font-medium"
                                                                        />
                                                                    </td>
                                                                    <td className="px-3 py-2">
                                                                        <input
                                                                            type="number"
                                                                            min="1"
                                                                            value={dok.ilosc}
                                                                            onChange={(e) => updatePendingFormData(item.id, f => {
                                                                                const d = [...f.dokumenty];
                                                                                d[idx] = { ...d[idx], ilosc: parseInt(e.target.value) || 1 };
                                                                                return { ...f, dokumenty: d };
                                                                            })}
                                                                            className="w-14 border border-slate-200 rounded-lg px-2 py-1 text-center focus:outline-none"
                                                                        />
                                                                    </td>
                                                                    <td className="px-2 py-2">
                                                                        <button
                                                                            onClick={() => updatePendingFormData(item.id, f => ({
                                                                                ...f,
                                                                                dokumenty: f.dokumenty.filter((_, i) => i !== idx)
                                                                            }))}
                                                                            className="text-slate-300 hover:text-red-500 font-bold"
                                                                        >✕</button>
                                                                    </td>
                                                                </tr>
                                                            ))}
                                                        </tbody>
                                                    </table>
                                                    <div className="p-2 border-t border-slate-100">
                                                        <button
                                                            onClick={() => updatePendingFormData(item.id, f => ({
                                                                ...f,
                                                                dokumenty: [...f.dokumenty, { nazwa: '', ilosc: 1, uwagi: '' }]
                                                            }))}
                                                            className="w-full py-2 text-xs text-slate-500 hover:text-slate-700 border border-dashed border-slate-300 rounded-xl hover:border-slate-400 transition"
                                                        >
                                                            + Dodaj pozycję
                                                        </button>
                                                    </div>
                                                </div>
                                            </div>

                                            <div>
                                                <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Uwagi</label>
                                                <textarea
                                                    value={analysisForm.uwagi}
                                                    onChange={(e) => updatePendingFormData(item.id, f => ({ ...f, uwagi: e.target.value }))}
                                                    rows={2}
                                                    className="w-full border border-slate-300 rounded-xl px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"
                                                />
                                            </div>

                                            <div className="flex items-center gap-3 pt-2">
                                                <button
                                                    onClick={() => savePendingAsGotowe(item)}
                                                    disabled={savingPendingId === item.id}
                                                    className={`flex-1 py-4 rounded-2xl font-black text-sm transition shadow-lg flex items-center justify-center gap-2 ${savingPendingId === item.id
                                                        ? 'bg-slate-300 text-slate-500 cursor-not-allowed'
                                                        : 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-emerald-200'
                                                        }`}
                                                >
                                                    {savingPendingId === item.id
                                                        ? '⏳ Zapisywanie...'
                                                        : '💾 Zapisz i przenieś do Archiwum'}
                                                </button>
                                                <button
                                                    onClick={() => analyzePending(item)}
                                                    className="px-4 py-4 rounded-2xl border border-slate-300 hover:bg-slate-50 text-xs font-bold text-slate-600 transition"
                                                    title="Analizuj ponownie"
                                                >
                                                    🔄 Analizuj ponownie
                                                </button>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* ══════════════════════════════════════
                ZAKŁADKA 3: WGRAJ Z PC
            ══════════════════════════════════════ */}
            {activeTab === 'new' && (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    <div className="bg-white rounded-3xl border border-slate-200 p-6 shadow-sm space-y-4">
                        <h2 className="text-lg font-bold text-slate-800">📹 Wgraj wideo z komputera</h2>

                        <input
                            ref={captureInputRef}
                            type="file" accept="video/*" capture="environment"
                            className="hidden"
                            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleVideoSelected(f); }}
                        />
                        <input
                            ref={fileInputRef}
                            type="file" accept="video/*"
                            className="hidden"
                            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleVideoSelected(f); }}
                        />

                        <div className="grid grid-cols-2 gap-3">
                            <button
                                onClick={() => captureInputRef.current?.click()}
                                className="p-4 border-2 border-dashed border-blue-300 rounded-2xl hover:bg-blue-50 transition text-center"
                            >
                                <span className="text-2xl block mb-1">📹</span>
                                <span className="text-xs font-bold text-blue-700">Kamera laptopa</span>
                            </button>
                            <button
                                onClick={() => fileInputRef.current?.click()}
                                className="p-4 border-2 border-dashed border-slate-300 rounded-2xl hover:bg-slate-50 transition text-center"
                            >
                                <span className="text-2xl block mb-1">📂</span>
                                <span className="text-xs font-bold text-slate-700">Wybierz plik</span>
                            </button>
                        </div>

                        {videoPreviewUrl && (
                            <div className="rounded-2xl overflow-hidden bg-black aspect-video">
                                <video src={videoPreviewUrl} controls className="w-full h-full object-contain" />
                            </div>
                        )}

                        {uploadError && (
                            <div className="p-3 bg-red-50 text-red-700 rounded-xl text-xs">⚠️ {uploadError}</div>
                        )}

                        <button
                            onClick={analyzeVideo}
                            disabled={!videoFile || analyzing}
                            className={`w-full py-4 rounded-2xl font-black text-sm transition flex items-center justify-center gap-2 ${!videoFile || analyzing
                                ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
                                : 'bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-200'
                                }`}
                        >
                            {analyzing ? <><span className="animate-spin">⏳</span><span>AI analizuje...</span></> : '🤖 Analizuj z AI'}
                        </button>
                    </div>

                    <div className="bg-white rounded-3xl border border-slate-200 p-6 shadow-sm">
                        <h2 className="text-lg font-bold text-slate-800 mb-4">📋 Dane teczki</h2>
                        {!formData ? (
                            <div className="flex flex-col items-center justify-center h-64 text-slate-400 text-center">
                                <span className="text-5xl mb-2">📋</span>
                                <p className="text-sm">Wgraj wideo i kliknij &ldquo;Analizuj z AI&rdquo;</p>
                            </div>
                        ) : (
                            <div className="space-y-4">
                                <div>
                                    <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Pracownik</label>
                                    <input
                                        type="text" value={formData.pracownik}
                                        onChange={(e) => setFormData({ ...formData, pracownik: e.target.value })}
                                        className="w-full border border-slate-300 rounded-xl px-3 py-2 text-sm font-bold"
                                    />
                                </div>
                                <div>
                                    <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Opis teczki</label>
                                    <input
                                        type="text" value={formData.teczkaOpis}
                                        onChange={(e) => setFormData({ ...formData, teczkaOpis: e.target.value })}
                                        className="w-full border border-slate-300 rounded-xl px-3 py-2 text-sm"
                                    />
                                </div>
                                <div className="grid grid-cols-2 gap-3">
                                    <div>
                                        <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Data od</label>
                                        <input
                                            type="text" value={formData.dataOd}
                                            onChange={(e) => setFormData({ ...formData, dataOd: e.target.value })}
                                            className="w-full border border-slate-300 rounded-xl px-3 py-2 text-sm"
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Data do</label>
                                        <input
                                            type="text" value={formData.dataDo}
                                            onChange={(e) => setFormData({ ...formData, dataDo: e.target.value })}
                                            className="w-full border border-slate-300 rounded-xl px-3 py-2 text-sm"
                                        />
                                    </div>
                                </div>
                                <div>
                                    <label className="block text-xs font-bold text-slate-500 uppercase mb-1">
                                        Dokumenty ({formData.dokumenty.length})
                                    </label>
                                    <div className="max-h-48 overflow-y-auto space-y-2 border border-slate-200 rounded-xl p-2">
                                        {formData.dokumenty.map((dok, idx) => (
                                            <div key={idx} className="flex gap-2 items-center">
                                                <span className="text-xs text-slate-400 w-5">{idx + 1}.</span>
                                                <input
                                                    type="text" value={dok.nazwa}
                                                    onChange={(e) => { const d = [...formData.dokumenty]; d[idx].nazwa = e.target.value; setFormData({ ...formData, dokumenty: d }); }}
                                                    className="flex-1 border border-slate-200 rounded-lg px-2 py-1 text-xs"
                                                />
                                                <input
                                                    type="number" min="1" value={dok.ilosc}
                                                    onChange={(e) => { const d = [...formData.dokumenty]; d[idx].ilosc = parseInt(e.target.value) || 1; setFormData({ ...formData, dokumenty: d }); }}
                                                    className="w-14 border border-slate-200 rounded-lg px-2 py-1 text-xs text-center"
                                                />
                                            </div>
                                        ))}
                                    </div>
                                </div>
                                <button
                                    onClick={handleSaveNewFromPc}
                                    disabled={savingNew}
                                    className="w-full py-4 rounded-2xl bg-emerald-600 hover:bg-emerald-500 text-white font-black text-sm transition shadow-lg shadow-emerald-200"
                                >
                                    {savingNew ? '⏳ Zapisywanie...' : '💾 Zapisz teczkę w Archiwum'}
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* ══ MODAL EDYCJI ══ */}
            {editingTeczka && (
                <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
                    <div className="bg-white rounded-3xl max-w-2xl w-full p-6 shadow-2xl max-h-[90vh] overflow-y-auto space-y-4">
                        <div className="flex items-center justify-between pb-3 border-b border-slate-100">
                            <h3 className="text-lg font-black text-slate-800">✏️ Edycja Teczki</h3>
                            <button onClick={() => setEditingTeczka(null)} className="text-slate-400 hover:text-slate-600 font-bold text-lg">✕</button>
                        </div>

                        <div>
                            <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Pracownik</label>
                            <input type="text" value={editingTeczka.pracownik}
                                onChange={(e) => setEditingTeczka({ ...editingTeczka, pracownik: e.target.value })}
                                className="w-full border border-slate-300 rounded-xl px-3 py-2 text-sm font-bold" />
                        </div>
                        <div>
                            <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Opis teczki</label>
                            <input type="text" value={editingTeczka.teczkaOpis}
                                onChange={(e) => setEditingTeczka({ ...editingTeczka, teczkaOpis: e.target.value })}
                                className="w-full border border-slate-300 rounded-xl px-3 py-2 text-sm" />
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Data od</label>
                                <input type="text" value={editingTeczka.dataOd}
                                    onChange={(e) => setEditingTeczka({ ...editingTeczka, dataOd: e.target.value })}
                                    className="w-full border border-slate-300 rounded-xl px-3 py-2 text-sm" />
                            </div>
                            <div>
                                <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Data do</label>
                                <input type="text" value={editingTeczka.dataDo}
                                    onChange={(e) => setEditingTeczka({ ...editingTeczka, dataDo: e.target.value })}
                                    className="w-full border border-slate-300 rounded-xl px-3 py-2 text-sm" />
                            </div>
                        </div>

                        <div>
                            <label className="block text-xs font-bold text-slate-500 uppercase mb-1">
                                Dokumenty ({editingTeczka.dokumenty.length})
                            </label>
                            <div className="space-y-2 max-h-56 overflow-y-auto border border-slate-200 rounded-2xl p-3">
                                {editingTeczka.dokumenty.map((dok, idx) => (
                                    <div key={idx} className="flex gap-2 items-center">
                                        <span className="text-xs text-slate-400 w-5">{idx + 1}.</span>
                                        <input type="text" value={dok.nazwa}
                                            onChange={(e) => { const d = [...editingTeczka.dokumenty]; d[idx].nazwa = e.target.value; setEditingTeczka({ ...editingTeczka, dokumenty: d }); }}
                                            className="flex-1 border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs font-medium" />
                                        <input type="number" min="1" value={dok.ilosc}
                                            onChange={(e) => { const d = [...editingTeczka.dokumenty]; d[idx].ilosc = parseInt(e.target.value) || 1; setEditingTeczka({ ...editingTeczka, dokumenty: d }); }}
                                            className="w-16 border border-slate-200 rounded-lg px-2 py-1.5 text-xs text-center" />
                                        <button onClick={() => { const d = editingTeczka.dokumenty.filter((_, i) => i !== idx); setEditingTeczka({ ...editingTeczka, dokumenty: d }); }}
                                            className="text-red-400 hover:text-red-600 px-1 text-sm font-bold">✕</button>
                                    </div>
                                ))}
                                <button
                                    onClick={() => setEditingTeczka({ ...editingTeczka, dokumenty: [...editingTeczka.dokumenty, { nazwa: '', ilosc: 1, uwagi: '' }] })}
                                    className="w-full py-1.5 border border-dashed border-slate-300 text-xs text-slate-500 rounded-lg hover:border-slate-400"
                                >
                                    + Dodaj pozycję
                                </button>
                            </div>
                        </div>

                        <div>
                            <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Uwagi</label>
                            <textarea value={editingTeczka.uwagi}
                                onChange={(e) => setEditingTeczka({ ...editingTeczka, uwagi: e.target.value })}
                                rows={2} className="w-full border border-slate-300 rounded-xl px-3 py-2 text-xs" />
                        </div>

                        <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-100">
                            <button onClick={() => setEditingTeczka(null)}
                                className="px-4 py-2.5 rounded-xl border border-slate-300 text-xs font-bold text-slate-600 hover:bg-slate-50">
                                Anuluj
                            </button>
                            <button onClick={handleSaveEdit} disabled={savingEdit}
                                className="px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-black shadow-md">
                                {savingEdit ? 'Zapisywanie...' : 'Zapisz zmiany'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
