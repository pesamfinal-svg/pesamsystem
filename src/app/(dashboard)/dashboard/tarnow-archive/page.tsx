// src/app/(dashboard)/dashboard/tarnow-archive/page.tsx
'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { db } from '@/lib/firebase/config';
import { collection, onSnapshot, deleteDoc, doc, updateDoc, addDoc, query, orderBy } from 'firebase/firestore';
import { useAuth } from '@/lib/auth/AuthContext';

interface DokumentRow {
    nazwa: string;
    ilosc: number;
    uwagi: string;
}

interface TeczkaArchiveItem {
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

interface AnalysisData {
    teczkaOpis: string;
    pracownik: string;
    dataOd: string;
    dataDo: string;
    dokumenty: DokumentRow[];
    uwagi: string;
}

export default function TarnowArchivePage() {
    const { user } = useAuth();
    const [activeTab, setActiveTab] = useState<'list' | 'new'>('list');

    // Lista teczek z Firestore
    const [teczki, setTeczki] = useState<TeczkaArchiveItem[]>([]);
    const [loadingTeczki, setLoadingTeczki] = useState(true);
    const [searchQuery, setSearchQuery] = useState('');
    const [downloadingId, setDownloadingId] = useState<string | null>(null);

    // Modal podglądu / edycji
    const [editingTeczka, setEditingTeczka] = useState<TeczkaArchiveItem | null>(null);
    const [savingEdit, setSavingEdit] = useState(false);

    // Stan do wgrywania z komputera (Zakładka 'new')
    const [videoFile, setVideoFile] = useState<File | null>(null);
    const [videoPreviewUrl, setVideoPreviewUrl] = useState<string | null>(null);
    const [analyzing, setAnalyzing] = useState(false);
    const [uploadError, setUploadError] = useState<string | null>(null);
    const [formData, setFormData] = useState<AnalysisData | null>(null);
    const [dataWypelnienia, setDataWypelnienia] = useState(() => new Date().toISOString().split('T')[0]);
    const [savingNew, setSavingNew] = useState(false);

    const captureInputRef = useRef<HTMLInputElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // Pobieranie teczek z Firestore na żywo
    useEffect(() => {
        const q = query(collection(db, 'tarnow_archive'), orderBy('createdAt', 'desc'));
        const unsubscribe = onSnapshot(q, (snapshot) => {
            const items: TeczkaArchiveItem[] = [];
            snapshot.forEach((docSnap) => {
                const data = docSnap.data();
                items.push({
                    id: docSnap.id,
                    pracownik: data.pracownik || 'Bez nazwiska',
                    teczkaOpis: data.teczkaOpis || 'Teczka akt osobowych',
                    dataOd: data.dataOd || '',
                    dataDo: data.dataDo || '',
                    dokumenty: data.dokumenty || [],
                    uwagi: data.uwagi || '',
                    dataWypelnienia: data.dataWypelnienia || new Date().toISOString().split('T')[0],
                    createdBy: data.createdBy || '',
                    createdAt: data.createdAt || '',
                });
            });
            setTeczki(items);
            setLoadingTeczki(false);
        }, (error) => {
            console.error('Błąd pobierania teczek:', error);
            setLoadingTeczki(false);
        });

        return () => unsubscribe();
    }, []);

    // Pobieranie pliku DOCX na komputer
    const downloadDocxForTeczka = async (item: TeczkaArchiveItem) => {
        setDownloadingId(item.id);
        try {
            const response = await fetch('/api/tarnow-generate-docx', {
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

            if (!response.ok) {
                const err = await response.json();
                throw new Error(err.error || 'Błąd generowania dokumentu');
            }

            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            const safeName = item.pracownik
                ? `archiwum-${item.pracownik.replace(/\s+/g, '-').toLowerCase()}.docx`
                : 'archiwum-tarnow.docx';
            a.href = url;
            a.download = safeName;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } catch (err) {
            alert(err instanceof Error ? err.message : 'Błąd pobierania pliku');
        } finally {
            setDownloadingId(null);
        }
    };

    // Usuwanie teczki
    const handleDeleteTeczka = async (id: string, nazwisko: string) => {
        if (!confirm(`Czy na pewno chcesz usunąć z archiwum teczkę: "${nazwisko}"?`)) {
            return;
        }
        try {
            await deleteDoc(doc(db, 'tarnow_archive', id));
        } catch (err) {
            alert('Błąd podczas usuwania: ' + (err instanceof Error ? err.message : String(err)));
        }
    };

    // Zapis edycji teczki
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
            alert('Błąd zapisu zmian: ' + (err instanceof Error ? err.message : String(err)));
        } finally {
            setSavingEdit(false);
        }
    };

    // Logika wgrywania wideo na PC
    const handleVideoSelected = useCallback((file: File) => {
        setVideoFile(file);
        setUploadError(null);
        const url = URL.createObjectURL(file);
        setVideoPreviewUrl(url);
        setFormData(null);
    }, []);

    const analyzeVideo = async () => {
        if (!videoFile) return;
        setAnalyzing(true);
        setUploadError(null);

        try {
            const base64 = await new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => {
                    const result = reader.result as string;
                    resolve(result.split(',')[1]);
                };
                reader.onerror = reject;
                reader.readAsDataURL(videoFile);
            });

            const response = await fetch('/api/tarnow-analyze-video', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    videoBase64: base64,
                    mimeType: videoFile.type || 'video/mp4',
                }),
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

    // Zapis nowej teczki z poziomu PC
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

            setFormData(null);
            setVideoFile(null);
            setVideoPreviewUrl(null);
            setActiveTab('list');
        } catch (err) {
            alert('Błąd zapisu: ' + (err instanceof Error ? err.message : String(err)));
        } finally {
            setSavingNew(false);
        }
    };

    // Filtrowanie teczek
    const filteredTeczki = teczki.filter((t) => {
        const query = searchQuery.toLowerCase();
        return (
            t.pracownik.toLowerCase().includes(query) ||
            t.teczkaOpis.toLowerCase().includes(query) ||
            t.dataOd.includes(query) ||
            t.dataDo.includes(query) ||
            (t.createdBy && t.createdBy.toLowerCase().includes(query))
        );
    });

    return (
        <div className="p-8 max-w-7xl mx-auto font-sans">
            {/* Header */}
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
                <div className="flex items-center gap-2 bg-slate-200/80 p-1.5 rounded-2xl">
                    <button
                        onClick={() => setActiveTab('list')}
                        className={`px-5 py-2.5 rounded-xl text-xs font-black transition flex items-center gap-2 ${
                            activeTab === 'list'
                                ? 'bg-white text-slate-900 shadow-sm'
                                : 'text-slate-600 hover:text-slate-900'
                        }`}
                    >
                        <span>📁</span>
                        <span>Zapisane teczki ({teczki.length})</span>
                    </button>
                    <button
                        onClick={() => setActiveTab('new')}
                        className={`px-5 py-2.5 rounded-xl text-xs font-black transition flex items-center gap-2 ${
                            activeTab === 'new'
                                ? 'bg-white text-slate-900 shadow-sm'
                                : 'text-slate-600 hover:text-slate-900'
                        }`}
                    >
                        <span>➕</span>
                        <span>Dodaj / Wgraj wideo z PC</span>
                    </button>
                </div>
            </div>

            {/* ══════════════ ZAKŁADKA 1: LISTA TECZEK ══════════════ */}
            {activeTab === 'list' && (
                <div className="space-y-6">
                    {/* Belka wyszukiwania i statystyk */}
                    <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm flex flex-col sm:flex-row items-center justify-between gap-4">
                        <div className="relative w-full sm:w-96">
                            <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400">🔍</span>
                            <input
                                type="text"
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                placeholder="Szukaj po nazwisku pracownika, dacie..."
                                className="w-full pl-10 pr-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                            />
                        </div>
                        <div className="text-xs text-slate-500">
                            Telefon służy do nagrywania — każda teczka nagrana na placu pojawia się tutaj automatycznie.
                        </div>
                    </div>

                    {/* Stan ładowania */}
                    {loadingTeczki && (
                        <div className="text-center py-20 text-slate-400">
                            <div className="inline-block animate-spin text-3xl mb-2">⏳</div>
                            <p className="text-sm">Ładowanie bazy teczek archiwalnych...</p>
                        </div>
                    )}

                    {/* Brak teczek */}
                    {!loadingTeczki && filteredTeczki.length === 0 && (
                        <div className="bg-white rounded-3xl border border-dashed border-slate-300 p-16 text-center">
                            <div className="text-5xl mb-3">📂</div>
                            <h3 className="text-lg font-bold text-slate-700">Brak zapisanych teczek</h3>
                            <p className="text-sm text-slate-400 mt-1 max-w-md mx-auto">
                                Nagraj teczkę telefonem w aplikacji mobilnej <b>PESAM PLAC → Nagraj Teczkę</b>.
                                Wykaz od razu pojawi się na tej liście z możliwością pobrania w pliku Word.
                            </p>
                        </div>
                    )}

                    {/* Kafelki / Tabela teczek */}
                    <div className="grid grid-cols-1 gap-4">
                        {filteredTeczki.map((item) => (
                            <div
                                key={item.id}
                                className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm hover:border-blue-400/80 transition flex flex-col lg:flex-row lg:items-center justify-between gap-6"
                            >
                                <div className="space-y-2 flex-1">
                                    <div className="flex items-center gap-3 flex-wrap">
                                        <h3 className="text-xl font-black text-slate-900 tracking-tight">
                                            {item.pracownik}
                                        </h3>
                                        {(item.dataOd || item.dataDo) && (
                                            <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-blue-50 text-blue-700 border border-blue-200">
                                                Lata: {item.dataOd || '?'} – {item.dataDo || '?'}
                                            </span>
                                        )}
                                        <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-slate-100 text-slate-700">
                                            {item.dokumenty.length} pozycji dokumentów
                                        </span>
                                    </div>

                                    <p className="text-xs text-slate-500 font-medium">
                                        📁 {item.teczkaOpis}
                                    </p>

                                    {/* Lista dokumentów w pigułkach */}
                                    <div className="flex flex-wrap gap-1.5 pt-1">
                                        {item.dokumenty.slice(0, 6).map((dok, idx) => (
                                            <span
                                                key={idx}
                                                className="text-[11px] bg-slate-50 border border-slate-200 rounded-lg px-2 py-0.5 text-slate-600"
                                            >
                                                {dok.nazwa} {dok.ilosc > 1 ? `(${dok.ilosc} szt.)` : ''}
                                            </span>
                                        ))}
                                        {item.dokumenty.length > 6 && (
                                            <span className="text-[11px] text-slate-400 self-center">
                                                +{item.dokumenty.length - 6} więcej...
                                            </span>
                                        )}
                                    </div>

                                    <div className="text-[11px] text-slate-400 pt-1">
                                        Dodano: {item.createdAt ? new Date(item.createdAt).toLocaleString('pl-PL') : '—'}
                                        {item.createdBy && ` przez: ${item.createdBy}`}
                                    </div>
                                </div>

                                {/* Przyciski akcji */}
                                <div className="flex items-center gap-3 shrink-0">
                                    <button
                                        onClick={() => setEditingTeczka(item)}
                                        className="px-4 py-3 rounded-xl border border-slate-300 hover:bg-slate-50 text-xs font-bold text-slate-700 transition"
                                    >
                                        ✏️ Podgląd / Edytuj
                                    </button>

                                    <button
                                        onClick={() => downloadDocxForTeczka(item)}
                                        disabled={downloadingId === item.id}
                                        className={`px-5 py-3 rounded-xl text-xs font-black transition shadow-md flex items-center gap-2 ${
                                            downloadingId === item.id
                                                ? 'bg-slate-300 text-slate-500 cursor-not-allowed'
                                                : 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-emerald-200'
                                        }`}
                                    >
                                        {downloadingId === item.id ? (
                                            <span>Generowanie...</span>
                                        ) : (
                                            <>
                                                <span>📥</span>
                                                <span>Pobierz Word (.docx)</span>
                                            </>
                                        )}
                                    </button>

                                    <button
                                        onClick={() => handleDeleteTeczka(item.id, item.pracownik)}
                                        className="p-3 rounded-xl text-slate-400 hover:text-red-600 hover:bg-red-50 transition"
                                        title="Usuń teczkę"
                                    >
                                        🗑️
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* ══════════════ ZAKŁADKA 2: NOWE NAGRANIE Z PC ══════════════ */}
            {activeTab === 'new' && (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    {/* LEWY PANEL: Wideo */}
                    <div className="bg-white rounded-3xl border border-slate-200 p-6 shadow-sm space-y-4">
                        <h2 className="text-lg font-bold text-slate-800 flex items-center gap-2">
                            📹 Wgraj filmik z komputera
                        </h2>

                        <input
                            ref={captureInputRef}
                            type="file"
                            accept="video/*"
                            capture="environment"
                            className="hidden"
                            onChange={(e) => {
                                const f = e.target.files?.[0];
                                if (f) handleVideoSelected(f);
                            }}
                        />
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept="video/*"
                            className="hidden"
                            onChange={(e) => {
                                const f = e.target.files?.[0];
                                if (f) handleVideoSelected(f);
                            }}
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
                                <span className="text-xs font-bold text-slate-700">Wybierz plik z dysku</span>
                            </button>
                        </div>

                        {videoPreviewUrl && (
                            <div className="rounded-2xl overflow-hidden bg-black aspect-video">
                                <video src={videoPreviewUrl} controls className="w-full h-full object-contain" />
                            </div>
                        )}

                        {uploadError && (
                            <div className="p-3 bg-red-50 text-red-700 rounded-xl text-xs">
                                ⚠️ {uploadError}
                            </div>
                        )}

                        <button
                            onClick={analyzeVideo}
                            disabled={!videoFile || analyzing}
                            className={`w-full py-4 rounded-2xl font-black text-sm transition flex items-center justify-center gap-2 ${
                                !videoFile || analyzing
                                    ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
                                    : 'bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-200'
                            }`}
                        >
                            {analyzing ? 'AI analizuje nagranie...' : '🤖 Analizuj z AI'}
                        </button>
                    </div>

                    {/* PRAWY PANEL: Wynik analizy i zapis */}
                    <div className="bg-white rounded-3xl border border-slate-200 p-6 shadow-sm">
                        <h2 className="text-lg font-bold text-slate-800 mb-4">
                            📋 Dane teczki do zapisania
                        </h2>

                        {!formData ? (
                            <div className="flex flex-col items-center justify-center h-64 text-slate-400 text-center">
                                <span className="text-5xl mb-2">📋</span>
                                <p className="text-sm">Wgraj wideo z teczką, aby AI rozpoznało dokumenty</p>
                            </div>
                        ) : (
                            <div className="space-y-4">
                                <div>
                                    <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Pracownik</label>
                                    <input
                                        type="text"
                                        value={formData.pracownik}
                                        onChange={(e) => setFormData({ ...formData, pracownik: e.target.value })}
                                        className="w-full border border-slate-300 rounded-xl px-3 py-2 text-sm font-bold"
                                    />
                                </div>

                                <div>
                                    <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Opis teczki</label>
                                    <input
                                        type="text"
                                        value={formData.teczkaOpis}
                                        onChange={(e) => setFormData({ ...formData, teczkaOpis: e.target.value })}
                                        className="w-full border border-slate-300 rounded-xl px-3 py-2 text-sm"
                                    />
                                </div>

                                <div className="grid grid-cols-2 gap-3">
                                    <div>
                                        <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Data od</label>
                                        <input
                                            type="text"
                                            value={formData.dataOd}
                                            onChange={(e) => setFormData({ ...formData, dataOd: e.target.value })}
                                            className="w-full border border-slate-300 rounded-xl px-3 py-2 text-sm"
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Data do</label>
                                        <input
                                            type="text"
                                            value={formData.dataDo}
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
                                                    type="text"
                                                    value={dok.nazwa}
                                                    onChange={(e) => {
                                                        const d = [...formData.dokumenty];
                                                        d[idx].nazwa = e.target.value;
                                                        setFormData({ ...formData, dokumenty: d });
                                                    }}
                                                    className="flex-1 border border-slate-200 rounded-lg px-2 py-1 text-xs"
                                                />
                                                <input
                                                    type="number"
                                                    min="1"
                                                    value={dok.ilosc}
                                                    onChange={(e) => {
                                                        const d = [...formData.dokumenty];
                                                        d[idx].ilosc = parseInt(e.target.value) || 1;
                                                        setFormData({ ...formData, dokumenty: d });
                                                    }}
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
                                    {savingNew ? 'Zapisywanie...' : '💾 Zapisz teczkę w Archiwum Tarnów'}
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* ══════════════ MODAL EDYCJI / PODGLĄDU ══════════════ */}
            {editingTeczka && (
                <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
                    <div className="bg-white rounded-3xl max-w-2xl w-full p-6 shadow-2xl max-h-[90vh] overflow-y-auto space-y-4">
                        <div className="flex items-center justify-between pb-3 border-b border-slate-100">
                            <h3 className="text-lg font-black text-slate-800">
                                ✏️ Podgląd i Edycja Teczki
                            </h3>
                            <button
                                onClick={() => setEditingTeczka(null)}
                                className="text-slate-400 hover:text-slate-600 font-bold text-lg"
                            >
                                ✕
                            </button>
                        </div>

                        <div>
                            <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Pracownik</label>
                            <input
                                type="text"
                                value={editingTeczka.pracownik}
                                onChange={(e) => setEditingTeczka({ ...editingTeczka, pracownik: e.target.value })}
                                className="w-full border border-slate-300 rounded-xl px-3 py-2 text-sm font-bold"
                            />
                        </div>

                        <div>
                            <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Opis teczki</label>
                            <input
                                type="text"
                                value={editingTeczka.teczkaOpis}
                                onChange={(e) => setEditingTeczka({ ...editingTeczka, teczkaOpis: e.target.value })}
                                className="w-full border border-slate-300 rounded-xl px-3 py-2 text-sm"
                            />
                        </div>

                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Data od</label>
                                <input
                                    type="text"
                                    value={editingTeczka.dataOd}
                                    onChange={(e) => setEditingTeczka({ ...editingTeczka, dataOd: e.target.value })}
                                    className="w-full border border-slate-300 rounded-xl px-3 py-2 text-sm"
                                />
                            </div>
                            <div>
                                <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Data do</label>
                                <input
                                    type="text"
                                    value={editingTeczka.dataDo}
                                    onChange={(e) => setEditingTeczka({ ...editingTeczka, dataDo: e.target.value })}
                                    className="w-full border border-slate-300 rounded-xl px-3 py-2 text-sm"
                                />
                            </div>
                        </div>

                        {/* Dokumenty */}
                        <div>
                            <label className="block text-xs font-bold text-slate-500 uppercase mb-1">
                                Dokumenty w wykazie ({editingTeczka.dokumenty.length})
                            </label>
                            <div className="space-y-2 max-h-56 overflow-y-auto border border-slate-200 rounded-2xl p-3">
                                {editingTeczka.dokumenty.map((dok, idx) => (
                                    <div key={idx} className="flex gap-2 items-center">
                                        <span className="text-xs text-slate-400 w-5">{idx + 1}.</span>
                                        <input
                                            type="text"
                                            value={dok.nazwa}
                                            onChange={(e) => {
                                                const d = [...editingTeczka.dokumenty];
                                                d[idx].nazwa = e.target.value;
                                                setEditingTeczka({ ...editingTeczka, dokumenty: d });
                                            }}
                                            className="flex-1 border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs font-medium"
                                        />
                                        <input
                                            type="number"
                                            min="1"
                                            value={dok.ilosc}
                                            onChange={(e) => {
                                                const d = [...editingTeczka.dokumenty];
                                                d[idx].ilosc = parseInt(e.target.value) || 1;
                                                setEditingTeczka({ ...editingTeczka, dokumenty: d });
                                            }}
                                            className="w-16 border border-slate-200 rounded-lg px-2 py-1.5 text-xs text-center"
                                        />
                                        <button
                                            onClick={() => {
                                                const d = editingTeczka.dokumenty.filter((_, i) => i !== idx);
                                                setEditingTeczka({ ...editingTeczka, dokumenty: d });
                                            }}
                                            className="text-red-400 hover:text-red-600 px-1 text-sm font-bold"
                                        >
                                            ✕
                                        </button>
                                    </div>
                                ))}
                                <button
                                    onClick={() => {
                                        setEditingTeczka({
                                            ...editingTeczka,
                                            dokumenty: [...editingTeczka.dokumenty, { nazwa: '', ilosc: 1, uwagi: '' }],
                                        });
                                    }}
                                    className="w-full py-1.5 border border-dashed border-slate-300 text-xs text-slate-500 rounded-lg hover:border-slate-400"
                                >
                                    + Dodaj pozycję
                                </button>
                            </div>
                        </div>

                        <div>
                            <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Uwagi</label>
                            <textarea
                                value={editingTeczka.uwagi}
                                onChange={(e) => setEditingTeczka({ ...editingTeczka, uwagi: e.target.value })}
                                rows={2}
                                className="w-full border border-slate-300 rounded-xl px-3 py-2 text-xs"
                            />
                        </div>

                        <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-100">
                            <button
                                onClick={() => setEditingTeczka(null)}
                                className="px-4 py-2.5 rounded-xl border border-slate-300 text-xs font-bold text-slate-600 hover:bg-slate-50"
                            >
                                Anuluj
                            </button>
                            <button
                                onClick={handleSaveEdit}
                                disabled={savingEdit}
                                className="px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-black shadow-md"
                            >
                                {savingEdit ? 'Zapisywanie...' : 'Zapisz zmiany'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
