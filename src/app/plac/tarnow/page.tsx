'use client';
// src/app/plac/tarnow/page.tsx
// Mobilny moduł Archiwum Tarnów — nagrywanie teczki bezpośrednio w przeglądarce

import { useState, useRef, useCallback, useEffect } from 'react';
import Link from 'next/link';

type Step = 'idle' | 'recording' | 'preview' | 'analyzing' | 'form' | 'downloading' | 'done';

interface DokumentRow {
    nazwa: string;
    ilosc: number;
    uwagi: string;
}

interface FormData {
    teczkaOpis: string;
    pracownik: string;
    dataOd: string;
    dataDo: string;
    dokumenty: DokumentRow[];
    uwagi: string;
    dataWypelnienia: string;
}

export default function TarnowMobilePage() {
    const [step, setStep] = useState<Step>('idle');
    const [error, setError] = useState<string | null>(null);
    const [recordingTime, setRecordingTime] = useState(0);
    const [formData, setFormData] = useState<FormData>({
        teczkaOpis: '',
        pracownik: '',
        dataOd: '',
        dataDo: '',
        dokumenty: [{ nazwa: '', ilosc: 1, uwagi: '' }],
        uwagi: '',
        dataWypelnienia: new Date().toISOString().split('T')[0],
    });

    const videoRef = useRef<HTMLVideoElement>(null);
    const previewRef = useRef<HTMLVideoElement>(null);
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const chunksRef = useRef<Blob[]>([]);
    const recordedBlobRef = useRef<Blob | null>(null);
    const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

    // Wyczyść zasoby przy odmontowaniu
    useEffect(() => {
        return () => {
            if (timerRef.current) clearInterval(timerRef.current);
            if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
        };
    }, []);

    // Uruchom kamerę
    const startCamera = useCallback(async () => {
        setError(null);
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    facingMode: 'environment', // kamera tylna
                    width: { ideal: 640, max: 854 },
                    height: { ideal: 480, max: 480 },
                    frameRate: { ideal: 15, max: 20 }, // niska liczba klatek = mały plik
                },
                audio: false, // bez audio = jeszcze mniejszy plik
            });
            streamRef.current = stream;
            if (videoRef.current) {
                videoRef.current.srcObject = stream;
                videoRef.current.play();
            }
            setStep('recording');
            startRecording(stream);
        } catch (err) {
            setError('Brak dostępu do kamery. Zezwól przeglądarce na korzystanie z kamery.');
            console.error(err);
        }
    }, []);

    const startRecording = (stream: MediaStream) => {
        chunksRef.current = [];
        setRecordingTime(0);

        // Wybierz najlepszy dostępny kodek (niski bitrate)
        const mimeTypes = [
            'video/webm;codecs=vp8',
            'video/webm',
            'video/mp4',
        ];
        const mimeType = mimeTypes.find(m => MediaRecorder.isTypeSupported(m)) || '';

        const recorder = new MediaRecorder(stream, {
            mimeType: mimeType || undefined,
            videoBitsPerSecond: 300_000, // 300kbps — niska jakość, mały plik
        });

        recorder.ondataavailable = (e) => {
            if (e.data.size > 0) chunksRef.current.push(e.data);
        };

        recorder.onstop = () => {
            const blob = new Blob(chunksRef.current, { type: mimeType || 'video/webm' });
            recordedBlobRef.current = blob;

            // Pokaż podgląd
            if (previewRef.current) {
                previewRef.current.src = URL.createObjectURL(blob);
            }
            setStep('preview');
        };

        recorder.start(500); // chunk co 500ms
        mediaRecorderRef.current = recorder;

        // Licznik czasu
        timerRef.current = setInterval(() => {
            setRecordingTime(t => {
                if (t >= 120) { // max 2 minuty
                    stopRecording();
                    return t;
                }
                return t + 1;
            });
        }, 1000);
    };

    const stopRecording = useCallback(() => {
        if (timerRef.current) clearInterval(timerRef.current);
        if (mediaRecorderRef.current?.state === 'recording') {
            mediaRecorderRef.current.stop();
        }
        if (streamRef.current) {
            streamRef.current.getTracks().forEach(t => t.stop());
            streamRef.current = null;
        }
    }, []);

    const analyzeVideo = useCallback(async () => {
        if (!recordedBlobRef.current) return;
        setStep('analyzing');
        setError(null);

        try {
            const blob = recordedBlobRef.current;

            // Konwertuj blob do base64
            const base64 = await new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => {
                    const result = reader.result as string;
                    resolve(result.split(',')[1]); // usuń prefix data:...;base64,
                };
                reader.onerror = reject;
                reader.readAsDataURL(blob);
            });

            const response = await fetch('/api/tarnow-analyze-video', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    videoBase64: base64,
                    mimeType: blob.type || 'video/webm',
                }),
            });

            const result = await response.json();
            if (!response.ok || result.error) throw new Error(result.error || 'Błąd analizy');

            const data = result.data;
            setFormData({
                teczkaOpis: data.teczkaOpis || '',
                pracownik: data.pracownik || '',
                dataOd: data.dataOd || '',
                dataDo: data.dataDo || '',
                dokumenty: data.dokumenty?.length > 0
                    ? data.dokumenty
                    : [{ nazwa: '', ilosc: 1, uwagi: '' }],
                uwagi: data.uwagi || '',
                dataWypelnienia: new Date().toISOString().split('T')[0],
            });
            setStep('form');
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Nieznany błąd');
            setStep('preview');
        }
    }, []);

    const downloadDocx = async () => {
        setStep('downloading');
        setError(null);
        try {
            const response = await fetch('/api/tarnow-generate-docx', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(formData),
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
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            setStep('done');
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Błąd pobierania');
            setStep('form');
        }
    };

    const reset = () => {
        if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
        if (timerRef.current) clearInterval(timerRef.current);
        recordedBlobRef.current = null;
        chunksRef.current = [];
        setRecordingTime(0);
        setError(null);
        setStep('idle');
    };

    const updateDok = (i: number, field: keyof DokumentRow, value: string | number) => {
        const d = [...formData.dokumenty];
        d[i] = { ...d[i], [field]: value };
        setFormData(f => ({ ...f, dokumenty: d }));
    };

    const formatTime = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

    return (
        <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans select-none pb-10">
            {/* Header */}
            <header className="sticky top-0 z-30 border-b border-slate-800 bg-slate-900/95 backdrop-blur shadow-xl">
                <div className="max-w-xl mx-auto w-full px-4 py-3 flex items-center gap-3">
                    <Link
                        href="/plac"
                        className="flex items-center justify-center w-9 h-9 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 transition active:scale-95"
                    >
                        ←
                    </Link>
                    <div className="min-w-0">
                        <h1 className="text-base font-black text-rose-400 uppercase tracking-wider leading-tight">
                            🗂️ Archiwum Tarnów
                        </h1>
                        <p className="text-[10px] text-slate-400 font-bold">Nagrywanie teczek · PSS SPOŁEM</p>
                    </div>
                </div>
            </header>

            <main className="max-w-xl mx-auto w-full p-4 flex-1 space-y-4">

                {/* Błąd */}
                {error && (
                    <div className="rounded-2xl border border-red-500/30 bg-red-500/10 p-4 text-xs text-red-300">
                        ⚠️ {error}
                    </div>
                )}

                {/* ══════════ KROK 1: IDLE ══════════ */}
                {step === 'idle' && (
                    <div className="space-y-4">
                        <div className="rounded-3xl border border-slate-800 bg-gradient-to-br from-slate-900 to-slate-950 p-5">
                            <div className="text-5xl text-center mb-3">🎥</div>
                            <h2 className="text-center text-lg font-black text-white">Nagraj Teczkę</h2>
                            <p className="mt-2 text-center text-xs text-slate-400 leading-relaxed">
                                Nagraj filmik pokazujący dokumenty w teczce. AI automatycznie rozpozna zawartość
                                i wypełni wykaz. Nagranie jest w niskiej jakości — zajmuje mało miejsca.
                            </p>
                        </div>

                        <div className="rounded-2xl border border-slate-800 bg-slate-900 p-4 space-y-2">
                            <p className="text-xs font-bold text-slate-400 uppercase tracking-wide">Wskazówki:</p>
                            <ul className="text-xs text-slate-300 space-y-1.5">
                                <li>📌 Filmuj powoli, zatrzymując się na każdym dokumencie</li>
                                <li>💡 Zadbaj o dobre oświetlenie (unikaj cienia)</li>
                                <li>⏱️ Wystarczy 20–60 sekund nagrania</li>
                                <li>📂 Pokaż opis na grzbiecie teczki na początku</li>
                            </ul>
                        </div>

                        <button
                            onClick={startCamera}
                            className="w-full py-5 rounded-3xl bg-rose-600 hover:bg-rose-500 text-white font-black text-xl active:scale-95 transition shadow-lg shadow-rose-900/50 flex items-center justify-center gap-3"
                        >
                            <span>🎥</span> Uruchom kamerę
                        </button>
                    </div>
                )}

                {/* ══════════ KROK 2: NAGRYWANIE ══════════ */}
                {step === 'recording' && (
                    <div className="space-y-4">
                        <div className="relative rounded-3xl overflow-hidden bg-black border border-rose-500/40">
                            {/* Podgląd kamery */}
                            <video
                                ref={videoRef}
                                autoPlay
                                playsInline
                                muted
                                className="w-full aspect-video object-cover"
                            />
                            {/* REC badge */}
                            <div className="absolute top-3 left-3 flex items-center gap-2 bg-black/70 rounded-xl px-3 py-1.5">
                                <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse" />
                                <span className="text-xs font-black text-white">REC {formatTime(recordingTime)}</span>
                            </div>
                            {/* Max time info */}
                            <div className="absolute top-3 right-3 bg-black/70 rounded-xl px-2 py-1">
                                <span className="text-[10px] text-slate-300">max 2:00</span>
                            </div>
                        </div>

                        <button
                            onClick={stopRecording}
                            className="w-full py-5 rounded-3xl bg-red-600 hover:bg-red-500 text-white font-black text-xl active:scale-95 transition shadow-lg flex items-center justify-center gap-3"
                        >
                            <span className="w-5 h-5 bg-white rounded-sm inline-block" />
                            Zatrzymaj nagranie
                        </button>

                        <p className="text-center text-xs text-slate-500">
                            Nagrywaj powoli — pokaż wszystkie dokumenty w teczce
                        </p>
                    </div>
                )}

                {/* ══════════ KROK 3: PODGLĄD ══════════ */}
                {step === 'preview' && (
                    <div className="space-y-4">
                        <div className="rounded-3xl overflow-hidden bg-black border border-slate-700">
                            <video
                                ref={previewRef}
                                controls
                                playsInline
                                className="w-full aspect-video object-contain"
                            />
                        </div>

                        <div className="rounded-2xl border border-slate-800 bg-slate-900 p-3 text-center">
                            <p className="text-xs text-slate-400">
                                Rozmiar: <span className="text-white font-bold">
                                    {recordedBlobRef.current
                                        ? `${(recordedBlobRef.current.size / (1024 * 1024)).toFixed(1)} MB`
                                        : '—'
                                    }
                                </span>
                                {' '}·{' '}
                                Długość: <span className="text-white font-bold">{formatTime(recordingTime)}</span>
                            </p>
                        </div>

                        <button
                            onClick={analyzeVideo}
                            className="w-full py-5 rounded-3xl bg-blue-600 hover:bg-blue-500 text-white font-black text-xl active:scale-95 transition shadow-lg shadow-blue-900/50 flex items-center justify-center gap-3"
                        >
                            🤖 Analizuj z AI
                        </button>

                        <button
                            onClick={reset}
                            className="w-full py-3 rounded-2xl border border-slate-700 text-slate-400 text-sm font-bold hover:bg-slate-900 active:scale-95 transition"
                        >
                            🔄 Nagraj ponownie
                        </button>
                    </div>
                )}

                {/* ══════════ KROK 4: ANALIZA ══════════ */}
                {step === 'analyzing' && (
                    <div className="flex flex-col items-center justify-center py-20 space-y-6">
                        <div className="relative">
                            <div className="w-20 h-20 rounded-full border-4 border-blue-500/20 border-t-blue-500 animate-spin" />
                            <span className="absolute inset-0 flex items-center justify-center text-2xl">🤖</span>
                        </div>
                        <div className="text-center">
                            <p className="font-black text-white text-lg">AI analizuje nagranie...</p>
                            <p className="text-xs text-slate-400 mt-2">Może potrwać 20–60 sekund</p>
                        </div>
                        <div className="rounded-2xl border border-blue-500/20 bg-blue-500/5 p-4 text-xs text-blue-300 text-center max-w-xs">
                            Gemini przegląda każdą klatkę i rozpoznaje dokumenty w teczce
                        </div>
                    </div>
                )}

                {/* ══════════ KROK 5: FORMULARZ ══════════ */}
                {(step === 'form' || step === 'downloading') && (
                    <div className="space-y-4">
                        {/* Info */}
                        <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-300 flex items-start gap-2">
                            <span>✅</span>
                            <span>AI rozpoznało zawartość teczki. Sprawdź i uzupełnij dane poniżej, a następnie pobierz gotowy dokument Word.</span>
                        </div>

                        {/* Pracownik */}
                        <div>
                            <label className="block text-xs font-bold text-slate-400 uppercase tracking-wide mb-1.5">Pracownik</label>
                            <input
                                type="text"
                                value={formData.pracownik}
                                onChange={e => setFormData(f => ({ ...f, pracownik: e.target.value }))}
                                placeholder="Imię i nazwisko..."
                                className="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-rose-500/50 placeholder:text-slate-600"
                            />
                        </div>

                        {/* Opis teczki */}
                        <div>
                            <label className="block text-xs font-bold text-slate-400 uppercase tracking-wide mb-1.5">Opis teczki</label>
                            <textarea
                                value={formData.teczkaOpis}
                                onChange={e => setFormData(f => ({ ...f, teczkaOpis: e.target.value }))}
                                rows={2}
                                placeholder="Kolor, oznaczenia, napisy na grzbiecie..."
                                className="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-rose-500/50 placeholder:text-slate-600"
                            />
                        </div>

                        {/* Daty */}
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <label className="block text-xs font-bold text-slate-400 uppercase tracking-wide mb-1.5">Data od</label>
                                <input
                                    type="date"
                                    value={formData.dataOd}
                                    onChange={e => setFormData(f => ({ ...f, dataOd: e.target.value }))}
                                    className="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-rose-500/50"
                                />
                            </div>
                            <div>
                                <label className="block text-xs font-bold text-slate-400 uppercase tracking-wide mb-1.5">Data do</label>
                                <input
                                    type="date"
                                    value={formData.dataDo}
                                    onChange={e => setFormData(f => ({ ...f, dataDo: e.target.value }))}
                                    className="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-rose-500/50"
                                />
                            </div>
                        </div>

                        {/* Dokumenty */}
                        <div>
                            <label className="block text-xs font-bold text-slate-400 uppercase tracking-wide mb-1.5">
                                Dokumenty ({formData.dokumenty.length})
                            </label>
                            <div className="space-y-2">
                                {formData.dokumenty.map((dok, i) => (
                                    <div key={i} className="rounded-xl border border-slate-800 bg-slate-900 p-3 space-y-2">
                                        <div className="flex items-center gap-2">
                                            <span className="text-xs font-bold text-slate-500 w-5">{i + 1}.</span>
                                            <input
                                                type="text"
                                                value={dok.nazwa}
                                                onChange={e => updateDok(i, 'nazwa', e.target.value)}
                                                placeholder="Nazwa dokumentu..."
                                                className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-rose-500/50 placeholder:text-slate-600"
                                            />
                                            <button
                                                onClick={() => {
                                                    if (formData.dokumenty.length > 1) {
                                                        setFormData(f => ({
                                                            ...f,
                                                            dokumenty: f.dokumenty.filter((_, idx) => idx !== i)
                                                        }));
                                                    }
                                                }}
                                                className="text-slate-600 hover:text-red-400 text-lg font-bold w-7 shrink-0 text-center"
                                            >
                                                ✕
                                            </button>
                                        </div>
                                        <div className="flex gap-2 pl-7">
                                            <div className="w-20 shrink-0">
                                                <input
                                                    type="number"
                                                    min="1"
                                                    value={dok.ilosc}
                                                    onChange={e => updateDok(i, 'ilosc', parseInt(e.target.value) || 1)}
                                                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-2 py-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-rose-500/50 text-center"
                                                />
                                            </div>
                                            <input
                                                type="text"
                                                value={dok.uwagi}
                                                onChange={e => updateDok(i, 'uwagi', e.target.value)}
                                                placeholder="Uwagi..."
                                                className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-rose-500/50 placeholder:text-slate-600"
                                            />
                                        </div>
                                    </div>
                                ))}
                            </div>
                            <button
                                onClick={() => setFormData(f => ({ ...f, dokumenty: [...f.dokumenty, { nazwa: '', ilosc: 1, uwagi: '' }] }))}
                                className="w-full mt-2 py-2.5 rounded-xl border border-dashed border-slate-700 text-xs text-slate-400 hover:border-slate-500 hover:text-slate-300 transition"
                            >
                                + Dodaj dokument
                            </button>
                        </div>

                        {/* Uwagi */}
                        <div>
                            <label className="block text-xs font-bold text-slate-400 uppercase tracking-wide mb-1.5">Uwagi archiwisty</label>
                            <textarea
                                value={formData.uwagi}
                                onChange={e => setFormData(f => ({ ...f, uwagi: e.target.value }))}
                                rows={2}
                                placeholder="Stan dokumentów, uszkodzenia..."
                                className="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-rose-500/50 placeholder:text-slate-600"
                            />
                        </div>

                        {/* Data wypełnienia */}
                        <div>
                            <label className="block text-xs font-bold text-slate-400 uppercase tracking-wide mb-1.5">Data wypełnienia</label>
                            <input
                                type="date"
                                value={formData.dataWypelnienia}
                                onChange={e => setFormData(f => ({ ...f, dataWypelnienia: e.target.value }))}
                                className="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-rose-500/50"
                            />
                        </div>

                        {/* Przycisk pobierania */}
                        <button
                            onClick={downloadDocx}
                            disabled={step === 'downloading'}
                            className={`w-full py-5 rounded-3xl font-black text-xl active:scale-95 transition shadow-lg flex items-center justify-center gap-3 ${
                                step === 'downloading'
                                    ? 'bg-slate-700 text-slate-400 cursor-not-allowed'
                                    : 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-emerald-900/50'
                            }`}
                        >
                            {step === 'downloading' ? (
                                <>
                                    <svg className="animate-spin h-6 w-6" viewBox="0 0 24 24" fill="none">
                                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                                    </svg>
                                    Generowanie...
                                </>
                            ) : (
                                <>📥 Pobierz dokument Word</>
                            )}
                        </button>

                        <button
                            onClick={reset}
                            className="w-full py-3 rounded-2xl border border-slate-700 text-slate-400 text-sm font-bold hover:bg-slate-900 active:scale-95 transition"
                        >
                            🔄 Nagraj nową teczkę
                        </button>
                    </div>
                )}

                {/* ══════════ KROK 6: GOTOWE ══════════ */}
                {step === 'done' && (
                    <div className="flex flex-col items-center justify-center py-16 space-y-6 text-center">
                        <div className="text-6xl">✅</div>
                        <div>
                            <h2 className="text-2xl font-black text-white">Dokument gotowy!</h2>
                            <p className="mt-2 text-sm text-slate-400">
                                Plik Word został pobrany na Twój telefon.
                                <br />Znajdziesz go w folderze Pobrane.
                            </p>
                        </div>

                        <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-xs text-emerald-300 max-w-xs">
                            Wykaz dokumentów dla: <br />
                            <strong className="text-white text-sm">{formData.pracownik || 'pracownika'}</strong>
                        </div>

                        <button
                            onClick={reset}
                            className="w-full max-w-xs py-4 rounded-3xl bg-rose-600 hover:bg-rose-500 text-white font-black text-lg active:scale-95 transition shadow-lg"
                        >
                            🗂️ Nagraj kolejną teczkę
                        </button>

                        <Link
                            href="/plac"
                            className="text-sm text-slate-500 hover:text-slate-300 underline underline-offset-4"
                        >
                            ← Wróć do menu
                        </Link>
                    </div>
                )}
            </main>
        </div>
    );
}
