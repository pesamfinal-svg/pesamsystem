// src/app/(dashboard)/dashboard/tarnow-archive/page.tsx
'use client';

import { useState, useRef, useCallback } from 'react';

interface DokumentRow {
    nazwa: string;
    ilosc: number;
    uwagi: string;
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
    const [videoFile, setVideoFile] = useState<File | null>(null);
    const [videoPreviewUrl, setVideoPreviewUrl] = useState<string | null>(null);
    const [analyzing, setAnalyzing] = useState(false);
    const [downloading, setDownloading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [formData, setFormData] = useState<AnalysisData | null>(null);
    const [dataWypelnienia, setDataWypelnienia] = useState(() => new Date().toISOString().split('T')[0]);

    const captureInputRef = useRef<HTMLInputElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleVideoSelected = useCallback((file: File) => {
        setVideoFile(file);
        setError(null);
        const url = URL.createObjectURL(file);
        setVideoPreviewUrl(url);
        setFormData(null);
    }, []);

    const handleCaptureChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) handleVideoSelected(file);
    };

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) handleVideoSelected(file);
    };

    const analyzeVideo = async () => {
        if (!videoFile) return;
        setAnalyzing(true);
        setError(null);

        try {
            // Konwertuj plik wideo do base64
            const base64 = await new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => {
                    const result = reader.result as string;
                    // Usuń prefix "data:video/mp4;base64,"
                    const base64Data = result.split(',')[1];
                    resolve(base64Data);
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

            if (!response.ok || result.error) {
                throw new Error(result.error || 'Błąd analizy wideo');
            }

            setFormData({
                teczkaOpis: result.data.teczkaOpis || '',
                pracownik: result.data.pracownik || '',
                dataOd: result.data.dataOd || '',
                dataDo: result.data.dataDo || '',
                dokumenty: result.data.dokumenty?.length > 0
                    ? result.data.dokumenty
                    : [{ nazwa: '', ilosc: 1, uwagi: '' }],
                uwagi: result.data.uwagi || '',
            });
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Nieznany błąd');
        } finally {
            setAnalyzing(false);
        }
    };

    const downloadDocx = async () => {
        if (!formData) return;
        setDownloading(true);
        setError(null);

        try {
            const response = await fetch('/api/tarnow-generate-docx', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...formData, dataWypelnienia }),
            });

            if (!response.ok) {
                const errData = await response.json();
                throw new Error(errData.error || 'Błąd generowania dokumentu');
            }

            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            const fileName = formData.pracownik
                ? `archiwum-${formData.pracownik.replace(/\s+/g, '-').toLowerCase()}.docx`
                : 'archiwum-tarnow.docx';
            a.href = url;
            a.download = fileName;
            a.click();
            URL.revokeObjectURL(url);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Błąd pobierania');
        } finally {
            setDownloading(false);
        }
    };

    const updateDokument = (index: number, field: keyof DokumentRow, value: string | number) => {
        if (!formData) return;
        const newDokumenty = [...formData.dokumenty];
        newDokumenty[index] = { ...newDokumenty[index], [field]: value };
        setFormData({ ...formData, dokumenty: newDokumenty });
    };

    const addDokumentRow = () => {
        if (!formData) return;
        setFormData({
            ...formData,
            dokumenty: [...formData.dokumenty, { nazwa: '', ilosc: 1, uwagi: '' }],
        });
    };

    const removeDokumentRow = (index: number) => {
        if (!formData || formData.dokumenty.length <= 1) return;
        const newDokumenty = formData.dokumenty.filter((_, i) => i !== index);
        setFormData({ ...formData, dokumenty: newDokumenty });
    };

    return (
        <div className="p-6 max-w-7xl mx-auto">
            {/* Nagłówek */}
            <div className="mb-6">
                <h1 className="text-3xl font-extrabold text-slate-800 flex items-center gap-3">
                    🗂️ Archiwum Tarnów
                </h1>
                <p className="text-slate-500 mt-1">
                    Cyfryzacja dokumentacji archiwalnej PSS SPOŁEM Tarnów — nagraj teczkę telefonem, AI wypełni wykaz automatycznie
                </p>
            </div>

            {/* Komunikat błędu */}
            {error && (
                <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-xl text-red-700 flex items-start gap-2">
                    <span className="text-xl">⚠️</span>
                    <div>
                        <p className="font-bold">Wystąpił błąd</p>
                        <p className="text-sm">{error}</p>
                    </div>
                </div>
            )}

            {/* Dwa panele */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

                {/* LEWY PANEL: Upload wideo */}
                <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
                    <h2 className="text-lg font-bold text-slate-700 mb-4 flex items-center gap-2">
                        📹 Krok 1: Nagraj lub wybierz wideo teczki
                    </h2>

                    {/* Ukryte inputy */}
                    <input
                        ref={captureInputRef}
                        type="file"
                        accept="video/*"
                        capture="environment"
                        className="hidden"
                        onChange={handleCaptureChange}
                    />
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept="video/*"
                        className="hidden"
                        onChange={handleFileChange}
                    />

                    {/* Przyciski wyboru */}
                    <div className="grid grid-cols-2 gap-3 mb-4">
                        <button
                            onClick={() => captureInputRef.current?.click()}
                            className="flex flex-col items-center justify-center gap-2 p-4 border-2 border-dashed border-blue-300 rounded-xl hover:bg-blue-50 hover:border-blue-500 transition text-blue-600"
                        >
                            <span className="text-3xl">📱</span>
                            <span className="font-semibold text-sm">Nagraj telefonem</span>
                            <span className="text-xs text-slate-400">Użyj kamery tylnej</span>
                        </button>
                        <button
                            onClick={() => fileInputRef.current?.click()}
                            className="flex flex-col items-center justify-center gap-2 p-4 border-2 border-dashed border-slate-300 rounded-xl hover:bg-slate-50 hover:border-slate-500 transition text-slate-600"
                        >
                            <span className="text-3xl">📂</span>
                            <span className="font-semibold text-sm">Wybierz z dysku</span>
                            <span className="text-xs text-slate-400">MP4, MOV, AVI...</span>
                        </button>
                    </div>

                    {/* Podgląd wideo */}
                    {videoPreviewUrl && videoFile && (
                        <div className="mb-4">
                            <video
                                src={videoPreviewUrl}
                                controls
                                className="w-full rounded-xl bg-black max-h-64 object-contain"
                            />
                            <div className="mt-2 flex items-center justify-between text-sm text-slate-500">
                                <span className="font-medium truncate max-w-[70%]">📎 {videoFile.name}</span>
                                <span>{(videoFile.size / (1024 * 1024)).toFixed(1)} MB</span>
                            </div>
                        </div>
                    )}

                    {!videoPreviewUrl && (
                        <div className="flex items-center justify-center h-32 border border-slate-200 rounded-xl bg-slate-50 mb-4">
                            <p className="text-slate-400 text-sm">Brak wybranego wideo</p>
                        </div>
                    )}

                    {/* Przycisk analizy */}
                    <button
                        onClick={analyzeVideo}
                        disabled={!videoFile || analyzing}
                        className={`w-full py-4 rounded-xl font-bold text-lg transition flex items-center justify-center gap-3 ${
                            !videoFile || analyzing
                                ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
                                : 'bg-blue-600 hover:bg-blue-700 text-white shadow-lg shadow-blue-200'
                        }`}
                    >
                        {analyzing ? (
                            <>
                                <svg className="animate-spin h-6 w-6" viewBox="0 0 24 24" fill="none">
                                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                                </svg>
                                AI analizuje nagranie...
                            </>
                        ) : (
                            <>🤖 Analizuj z AI</>
                        )}
                    </button>

                    {analyzing && (
                        <p className="text-center text-xs text-slate-400 mt-2">
                            Może to potrwać 20–60 sekund w zależności od długości nagrania
                        </p>
                    )}
                </div>

                {/* PRAWY PANEL: Formularz / wynik */}
                <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
                    <h2 className="text-lg font-bold text-slate-700 mb-4 flex items-center gap-2">
                        📋 Krok 2: Sprawdź i uzupełnij dane
                    </h2>

                    {!formData ? (
                        <div className="flex flex-col items-center justify-center h-64 text-slate-400">
                            <span className="text-5xl mb-3">📋</span>
                            <p className="font-medium">Tu pojawią się dane z nagrania</p>
                            <p className="text-sm mt-1">Nagraj lub wybierz wideo i kliknij „Analizuj z AI"</p>
                        </div>
                    ) : (
                        <div className="space-y-4 overflow-y-auto max-h-[calc(100vh-280px)] pr-1">

                            {/* Pracownik */}
                            <div>
                                <label className="block text-xs font-bold text-slate-500 uppercase tracking-wide mb-1">
                                    Pracownik
                                </label>
                                <input
                                    type="text"
                                    value={formData.pracownik}
                                    onChange={e => setFormData({ ...formData, pracownik: e.target.value })}
                                    placeholder="Imię i nazwisko..."
                                    className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                                />
                            </div>

                            {/* Opis teczki */}
                            <div>
                                <label className="block text-xs font-bold text-slate-500 uppercase tracking-wide mb-1">
                                    Opis teczki / segregatora
                                </label>
                                <textarea
                                    value={formData.teczkaOpis}
                                    onChange={e => setFormData({ ...formData, teczkaOpis: e.target.value })}
                                    rows={2}
                                    placeholder="Kolor, oznaczenia, napisy na grzbiecie..."
                                    className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                                />
                            </div>

                            {/* Daty */}
                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <label className="block text-xs font-bold text-slate-500 uppercase tracking-wide mb-1">
                                        Data od
                                    </label>
                                    <input
                                        type="date"
                                        value={formData.dataOd}
                                        onChange={e => setFormData({ ...formData, dataOd: e.target.value })}
                                        className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                                    />
                                </div>
                                <div>
                                    <label className="block text-xs font-bold text-slate-500 uppercase tracking-wide mb-1">
                                        Data do
                                    </label>
                                    <input
                                        type="date"
                                        value={formData.dataDo}
                                        onChange={e => setFormData({ ...formData, dataDo: e.target.value })}
                                        className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                                    />
                                </div>
                            </div>

                            {/* Tabela dokumentów */}
                            <div>
                                <label className="block text-xs font-bold text-slate-500 uppercase tracking-wide mb-2">
                                    Dokumenty w teczce
                                </label>
                                <div className="border border-slate-200 rounded-xl overflow-hidden">
                                    <table className="w-full text-sm">
                                        <thead className="bg-slate-50">
                                            <tr>
                                                <th className="text-left px-2 py-2 text-xs text-slate-500 font-bold w-8">Lp.</th>
                                                <th className="text-left px-2 py-2 text-xs text-slate-500 font-bold">Nazwa dokumentu</th>
                                                <th className="text-left px-2 py-2 text-xs text-slate-500 font-bold w-14">Ilość</th>
                                                <th className="text-left px-2 py-2 text-xs text-slate-500 font-bold">Uwagi</th>
                                                <th className="w-8"></th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {formData.dokumenty.map((dok, index) => (
                                                <tr key={index} className="border-t border-slate-100">
                                                    <td className="px-2 py-1 text-slate-400 text-xs">{index + 1}.</td>
                                                    <td className="px-1 py-1">
                                                        <input
                                                            type="text"
                                                            value={dok.nazwa}
                                                            onChange={e => updateDokument(index, 'nazwa', e.target.value)}
                                                            className="w-full border border-slate-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400"
                                                            placeholder="Nazwa..."
                                                        />
                                                    </td>
                                                    <td className="px-1 py-1">
                                                        <input
                                                            type="number"
                                                            min="1"
                                                            value={dok.ilosc}
                                                            onChange={e => updateDokument(index, 'ilosc', parseInt(e.target.value) || 1)}
                                                            className="w-full border border-slate-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400 text-center"
                                                        />
                                                    </td>
                                                    <td className="px-1 py-1">
                                                        <input
                                                            type="text"
                                                            value={dok.uwagi}
                                                            onChange={e => updateDokument(index, 'uwagi', e.target.value)}
                                                            className="w-full border border-slate-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400"
                                                            placeholder="Uwagi..."
                                                        />
                                                    </td>
                                                    <td className="px-1 py-1">
                                                        <button
                                                            onClick={() => removeDokumentRow(index)}
                                                            className="text-red-400 hover:text-red-600 text-xs font-bold"
                                                            disabled={formData.dokumenty.length <= 1}
                                                        >
                                                            ✕
                                                        </button>
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                    <div className="p-2 border-t border-slate-100">
                                        <button
                                            onClick={addDokumentRow}
                                            className="w-full py-1.5 text-xs text-blue-600 hover:bg-blue-50 rounded-lg font-medium transition"
                                        >
                                            + Dodaj wiersz
                                        </button>
                                    </div>
                                </div>
                            </div>

                            {/* Uwagi */}
                            <div>
                                <label className="block text-xs font-bold text-slate-500 uppercase tracking-wide mb-1">
                                    Uwagi archiwisty
                                </label>
                                <textarea
                                    value={formData.uwagi}
                                    onChange={e => setFormData({ ...formData, uwagi: e.target.value })}
                                    rows={2}
                                    placeholder="Stan dokumentów, uszkodzenia, notatki..."
                                    className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                                />
                            </div>

                            {/* Data wypełnienia */}
                            <div>
                                <label className="block text-xs font-bold text-slate-500 uppercase tracking-wide mb-1">
                                    Data wypełnienia
                                </label>
                                <input
                                    type="date"
                                    value={dataWypelnienia}
                                    onChange={e => setDataWypelnienia(e.target.value)}
                                    className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                                />
                            </div>

                            {/* Przycisk pobierania */}
                            <button
                                onClick={downloadDocx}
                                disabled={downloading}
                                className={`w-full py-4 rounded-xl font-bold text-lg transition flex items-center justify-center gap-3 ${
                                    downloading
                                        ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
                                        : 'bg-green-600 hover:bg-green-700 text-white shadow-lg shadow-green-200'
                                }`}
                            >
                                {downloading ? (
                                    <>
                                        <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24" fill="none">
                                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                                        </svg>
                                        Generowanie dokumentu...
                                    </>
                                ) : (
                                    <>📥 Pobierz dokument Word</>
                                )}
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
