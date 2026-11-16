'use client';
// src/app/plac/tarnow/page.tsx
// Mobilny moduł Archiwum Tarnów — nagrywanie telefonem i natychmiastowy zapis do bazy dla komputera

import { useState, useRef, useCallback, useEffect } from 'react';
import Link from 'next/link';
import { useAuth } from '@/lib/auth/AuthContext';
import { db } from '@/lib/firebase/config';
import { collection, addDoc } from 'firebase/firestore';

type Step = 'idle' | 'recording' | 'preview' | 'analyzing' | 'form' | 'saving' | 'downloading' | 'done';

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
    const { user } = useAuth();
    const [step, setStep] = useState<Step>('idle');
    const [error, setError] = useState<string | null>(null);
    const [recordingTime, setRecordingTime] = useState(0);
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);
    const [fileSizeMb, setFileSizeMb] = useState<string>('0');
    const [formData, setFormData] = useState<FormData>({
        teczkaOpis: '',
        pracownik: '',
        dataOd: '',
        dataDo: '',
        dokumenty: [{ nazwa: '', ilosc: 1, uwagi: '' }],
        uwagi: '',
        dataWypelnienia: new Date().toISOString().split('T')[0],
    });

    const videoRef = useRef<HTMLVideoElement | null>(null);
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const chunksRef = useRef<Blob[]>([]);
    const recordedBlobRef = useRef<Blob | null>(null);
    const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

    const cameraInputRef = useRef<HTMLInputElement>(null);
    const galleryInputRef = useRef<HTMLInputElement>(null);

    // Czyszczenie zasobów przy odmontowaniu
    useEffect(() => {
        return () => {
            if (timerRef.current) clearInterval(timerRef.current);
            if (streamRef.current) {
                streamRef.current.getTracks().forEach(t => t.stop());
            }
            if (previewUrl) {
                URL.revokeObjectURL(previewUrl);
            }
        };
    }, [previewUrl]);

    // Uruchomienie kamery WebRTC na żywo w przeglądarce
    const startLiveCamera = useCallback(async () => {
        setError(null);
        try {
            if (streamRef.current) {
                streamRef.current.getTracks().forEach(t => t.stop());
            }

            const stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    facingMode: { ideal: 'environment' },
                    width: { ideal: 640, max: 854 },
                    height: { ideal: 480, max: 480 },
                    frameRate: { ideal: 15, max: 20 },
                },
                audio: false,
            });

            streamRef.current = stream;
            setStep('recording');

            chunksRef.current = [];
            setRecordingTime(0);

            const mimeTypes = [
                'video/mp4',
                'video/webm;codecs=vp8',
                'video/webm',
            ];
            const supportedMime = mimeTypes.find(m => MediaRecorder.isTypeSupported(m)) || '';

            const recorder = new MediaRecorder(stream, {
                mimeType: supportedMime || undefined,
                videoBitsPerSecond: 350_000,
            });

            recorder.ondataavailable = (e) => {
                if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
            };

            recorder.onstop = () => {
                const blob = new Blob(chunksRef.current, { type: supportedMime || 'video/mp4' });
                recordedBlobRef.current = blob;
                setFileSizeMb((blob.size / (1024 * 1024)).toFixed(1));
                const url = URL.createObjectURL(blob);
                setPreviewUrl(url);
                setStep('preview');
            };

            recorder.start(500);
            mediaRecorderRef.current = recorder;

            timerRef.current = setInterval(() => {
                setRecordingTime(t => {
                    if (t >= 90) {
                        stopLiveRecording();
                        return t;
                    }
                    return t + 1;
                });
            }, 1000);

        } catch (err: unknown) {
            console.error('Błąd kamery:', err);
            const msg = err instanceof Error ? err.message : String(err);
            setError(`Brak dostępu do kamery (${msg}). Użyj przycisku "Nagraj aparatem telefonu".`);
            setStep('idle');
        }
    }, []);

    // Podpięcie streamu do wideo, gdy komponent przechodzi w stan 'recording'
    useEffect(() => {
        if (step === 'recording' && videoRef.current && streamRef.current) {
            videoRef.current.srcObject = streamRef.current;
            videoRef.current.play().catch(e => {
                console.warn('Błąd auto-play podglądu:', e);
            });
        }
    }, [step]);

    const stopLiveRecording = useCallback(() => {
        if (timerRef.current) {
            clearInterval(timerRef.current);
            timerRef.current = null;
        }
        if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
            mediaRecorderRef.current.stop();
        }
        if (streamRef.current) {
            streamRef.current.getTracks().forEach(t => t.stop());
            streamRef.current = null;
        }
    }, []);

    // Obsługa wideo wybranego z aparatu systemowego lub galerii
    const handleFileSelected = (file: File) => {
        setError(null);
        recordedBlobRef.current = file;
        setFileSizeMb((file.size / (1024 * 1024)).toFixed(1));
        const url = URL.createObjectURL(file);
        setPreviewUrl(url);
        setStep('preview');
    };

    // Wysłanie do AI i analiza
    const analyzeVideo = useCallback(async () => {
        if (!recordedBlobRef.current) return;
        setStep('analyzing');
        setError(null);

        try {
            const blob = recordedBlobRef.current;

            const base64 = await new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => {
                    const result = reader.result as string;
                    resolve(result.split(',')[1]);
                };
                reader.onerror = reject;
                reader.readAsDataURL(blob);
            });

            const response = await fetch('/api/tarnow-analyze-video', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    videoBase64: base64,
                    mimeType: blob.type || 'video/mp4',
                }),
            });

            const result = await response.json();
            if (!response.ok || result.error) {
                throw new Error(result.error || 'Błąd analizy nagrania');
            }

            const data = result.data || {};
            setFormData({
                teczkaOpis: data.teczkaOpis || 'Teczka akt osobowych',
                pracownik: data.pracownik || '',
                dataOd: data.dataOd || '',
                dataDo: data.dataDo || '',
                dokumenty: Array.isArray(data.dokumenty) && data.dokumenty.length > 0
                    ? data.dokumenty
                    : [{ nazwa: 'Dokumentacja osobowa', ilosc: 1, uwagi: '' }],
                uwagi: data.uwagi || '',
                dataWypelnienia: new Date().toISOString().split('T')[0],
            });
            setStep('form');
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Nieznany błąd podczas analizy');
            setStep('preview');
        }
    }, []);

    // ZAPIS DO FIRESTORE (dla komputera w biurze)
    const saveToArchive = async () => {
        setStep('saving');
        setError(null);
        try {
            const userFullName = user
                ? `${user.firstName || ''} ${user.lastName || ''}`.trim()
                : 'Pracownik';

            await addDoc(collection(db, 'tarnow_archive'), {
                pracownik: formData.pracownik.trim() || 'Bez nazwiska',
                teczkaOpis: formData.teczkaOpis.trim() || 'Teczka akt osobowych',
                dataOd: formData.dataOd || '',
                dataDo: formData.dataDo || '',
                dokumenty: formData.dokumenty.filter(d => d.nazwa.trim().length > 0),
                uwagi: formData.uwagi || '',
                dataWypelnienia: formData.dataWypelnienia,
                createdBy: userFullName,
                createdAt: new Date().toISOString(),
                status: 'GOTOWE',
            });

            setStep('done');
        } catch (err) {
            console.error('Błąd zapisu w archiwum:', err);
            setError(err instanceof Error ? err.message : 'Błąd zapisu teczki w systemie');
            setStep('form');
        }
    };

    // Opcjonalne pobranie pliku DOCX bezpośrednio na telefon
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
            const safeName = formData.pracownik
                ? `archiwum-${formData.pracownik.replace(/\s+/g, '-').toLowerCase()}.docx`
                : 'archiwum-tarnow.docx';
            a.href = url;
            a.download = safeName;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            setStep('done');
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Błąd pobierania pliku');
            setStep('form');
        }
    };

    const reset = () => {
        if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
        if (timerRef.current) clearInterval(timerRef.current);
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        recordedBlobRef.current = null;
        chunksRef.current = [];
        setRecordingTime(0);
        setPreviewUrl(null);
        setError(null);
        setStep('idle');
    };

    const updateDok = (i: number, field: keyof DokumentRow, value: string | number) => {
        const d = [...formData.dokumenty];
        d[i] = { ...d[i], [field]: value };
        setFormData(f => ({ ...f, dokumenty: d }));
    };

    const formatTime = (s: number) =>
        `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

    return (
        <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans select-none pb-12">
            {/* Header */}
            <header className="sticky top-0 z-30 border-b border-slate-800 bg-slate-900/95 backdrop-blur shadow-xl">
                <div className="max-w-xl mx-auto w-full px-4 py-3 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                        <Link
                            href="/plac"
                            className="flex items-center justify-center w-10 h-10 rounded-2xl bg-slate-800 hover:bg-slate-700 text-slate-300 transition active:scale-95"
                        >
                            ←
                        </Link>
                        <div>
                            <h1 className="text-base font-black text-rose-400 uppercase tracking-wider leading-tight">
                                🗂️ Archiwum Tarnów
                            </h1>
                            <p className="text-[10px] text-slate-400 font-bold">Nagrywanie teczek · Zapis do komputera</p>
                        </div>
                    </div>
                    {step !== 'idle' && (
                        <button
                            onClick={reset}
                            className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-bold text-slate-300"
                        >
                            Od nowa
                        </button>
                    )}
                </div>
            </header>

            <main className="max-w-xl mx-auto w-full p-4 flex-1 space-y-4">
                {/* Komunikat błędu */}
                {error && (
                    <div className="rounded-2xl border border-red-500/40 bg-red-500/10 p-4 text-xs text-red-300 flex items-start gap-2">
                        <span className="text-base">⚠️</span>
                        <div>{error}</div>
                    </div>
                )}

                {/* Ukryte inputy do systemowego aparatu i galerii */}
                <input
                    ref={cameraInputRef}
                    type="file"
                    accept="video/*"
                    capture="environment"
                    className="hidden"
                    onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) handleFileSelected(file);
                        e.target.value = '';
                    }}
                />
                <input
                    ref={galleryInputRef}
                    type="file"
                    accept="video/*"
                    className="hidden"
                    onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) handleFileSelected(file);
                        e.target.value = '';
                    }}
                />

                {/* ══════════ KROK 1: WYBÓR SPOSOBU NAGRANIA ══════════ */}
                {step === 'idle' && (
                    <div className="space-y-4">
                        <div className="rounded-3xl border border-rose-500/30 bg-gradient-to-br from-rose-500/15 via-slate-900 to-slate-950 p-6 text-center">
                            <div className="text-5xl mb-3">📁</div>
                            <h2 className="text-xl font-black text-white">Nagraj Teczkę Personalną</h2>
                            <p className="mt-2 text-xs text-slate-300 leading-relaxed">
                                Nagraj filmik telefonem. AI uzupełni wykaz i <b>od razu wyśle go na komputer</b> do pobrania w Wordzie!
                            </p>
                        </div>

                        {/* Główny przycisk: aparat telefonu */}
                        <button
                            onClick={() => cameraInputRef.current?.click()}
                            className="w-full py-5 rounded-3xl bg-rose-600 hover:bg-rose-500 active:scale-[0.98] transition text-white font-black text-lg shadow-xl shadow-rose-950/60 flex items-center justify-center gap-3 border border-rose-400/40"
                        >
                            <span className="text-2xl">📱</span>
                            <span>Nagraj aparatem telefonu</span>
                        </button>
                        <p className="text-center text-[11px] text-slate-400 -mt-2">
                            Zalecane na telefonie — automatyczny autofokus i płynne wideo
                        </p>

                        <div className="grid grid-cols-2 gap-3 pt-2">
                            <button
                                onClick={startLiveCamera}
                                className="p-4 rounded-2xl border border-slate-700 bg-slate-900 hover:bg-slate-800 active:scale-95 transition text-left flex flex-col justify-between min-h-[95px]"
                            >
                                <span className="text-2xl">🔴</span>
                                <div>
                                    <div className="text-xs font-black text-white">Kamera w aplikacji</div>
                                    <div className="text-[10px] text-slate-400">Podgląd na żywo</div>
                                </div>
                            </button>

                            <button
                                onClick={() => galleryInputRef.current?.click()}
                                className="p-4 rounded-2xl border border-slate-700 bg-slate-900 hover:bg-slate-800 active:scale-95 transition text-left flex flex-col justify-between min-h-[95px]"
                            >
                                <span className="text-2xl">📂</span>
                                <div>
                                    <div className="text-xs font-black text-white">Wybierz z galerii</div>
                                    <div className="text-[10px] text-slate-400">Wcześniejsze nagranie</div>
                                </div>
                            </button>
                        </div>

                        <div className="rounded-2xl border border-slate-800/80 bg-slate-900/60 p-4 text-xs text-slate-400 space-y-1.5">
                            <p className="font-bold text-slate-300">💡 Jak to działa:</p>
                            <p>1. Nagrywasz teczkę telefonem.</p>
                            <p>2. AI rozpoznaje dokumenty (życiorys, świadectwa, ZUS...).</p>
                            <p>3. Zapisujesz jednym kliknięciem — <b>plik Word czeka na Ciebie w biurze na komputerze</b>.</p>
                        </div>
                    </div>
                )}

                {/* ══════════ KROK 2: NAGRYWANIE LIVE ══════════ */}
                {step === 'recording' && (
                    <div className="space-y-4">
                        <div className="relative rounded-3xl overflow-hidden bg-black border-2 border-rose-500 shadow-2xl aspect-video flex items-center justify-center">
                            <video
                                ref={(el) => {
                                    videoRef.current = el;
                                    if (el && streamRef.current && el.srcObject !== streamRef.current) {
                                        el.srcObject = streamRef.current;
                                        el.play().catch(() => {});
                                    }
                                }}
                                autoPlay
                                playsInline
                                muted
                                className="w-full h-full object-cover"
                            />

                            <div className="absolute top-3 left-3 flex items-center gap-2 bg-black/80 backdrop-blur-md rounded-full px-3 py-1.5 border border-red-500/40">
                                <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-ping" />
                                <span className="text-xs font-black text-white">REC {formatTime(recordingTime)}</span>
                            </div>

                            <div className="absolute top-3 right-3 bg-black/70 backdrop-blur-md rounded-xl px-2.5 py-1 text-[10px] text-slate-300">
                                max 1:30
                            </div>
                        </div>

                        <button
                            onClick={stopLiveRecording}
                            className="w-full py-5 rounded-3xl bg-red-600 hover:bg-red-500 text-white font-black text-xl active:scale-95 transition shadow-xl shadow-red-950/60 flex items-center justify-center gap-3"
                        >
                            <span className="w-4 h-4 bg-white rounded-sm inline-block" />
                            <span>Zatrzymaj i analizuj</span>
                        </button>

                        <p className="text-center text-xs text-slate-400">
                            Przewracaj strony w teczce — wystarczy pokazać nagłówek każdego pisma
                        </p>
                    </div>
                )}

                {/* ══════════ KROK 3: PODGLĄD NAGRANIA ══════════ */}
                {step === 'preview' && (
                    <div className="space-y-4">
                        <div className="rounded-3xl overflow-hidden bg-black border border-slate-700 shadow-xl aspect-video">
                            {previewUrl && (
                                <video
                                    src={previewUrl}
                                    controls
                                    playsInline
                                    className="w-full h-full object-contain"
                                />
                            )}
                        </div>

                        <div className="rounded-2xl border border-slate-800 bg-slate-900 p-3.5 flex items-center justify-between text-xs text-slate-300">
                            <span>Rozmiar nagrania: <strong className="text-white">{fileSizeMb} MB</strong></span>
                            <span className="text-emerald-400 font-bold">✓ Gotowe do analizy</span>
                        </div>

                        <button
                            onClick={analyzeVideo}
                            className="w-full py-5 rounded-3xl bg-blue-600 hover:bg-blue-500 text-white font-black text-xl active:scale-95 transition shadow-xl shadow-blue-950/60 flex items-center justify-center gap-3"
                        >
                            <span>🤖</span>
                            <span>Analizuj teczkę z AI</span>
                        </button>

                        <button
                            onClick={reset}
                            className="w-full py-3 rounded-2xl border border-slate-700 text-slate-400 text-xs font-bold hover:bg-slate-900 active:scale-95 transition"
                        >
                            🔄 Nagraj ponownie
                        </button>
                    </div>
                )}

                {/* ══════════ KROK 4: ANALIZA AI ══════════ */}
                {step === 'analyzing' && (
                    <div className="flex flex-col items-center justify-center py-16 space-y-5 text-center">
                        <div className="relative">
                            <div className="w-20 h-20 rounded-full border-4 border-rose-500/20 border-t-rose-500 animate-spin" />
                            <span className="absolute inset-0 flex items-center justify-center text-3xl">🗂️</span>
                        </div>
                        <div>
                            <p className="font-black text-white text-lg">AI kategoryzuje dokumenty...</p>
                            <p className="text-xs text-slate-400 mt-1 max-w-xs mx-auto">
                                Rozpoznajemy typy pism bez przepisywania zbędnej treści.
                            </p>
                        </div>
                    </div>
                )}

                {/* ══════════ KROK 5: EDYCJA I ZAPIS NA KOMPUTER ══════════ */}
                {(step === 'form' || step === 'saving' || step === 'downloading') && (
                    <div className="space-y-4">
                        <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-3.5 text-xs text-emerald-300 flex items-start gap-2">
                            <span className="text-base">✅</span>
                            <div>
                                <p className="font-bold">AI rozpoznało dokumenty!</p>
                                <p className="text-[11px] text-emerald-400/90 mt-0.5">
                                    Sprawdź nazwisko i kliknij poniżej, aby <b>wysłać teczkę do komputera</b>.
                                </p>
                            </div>
                        </div>

                        {/* Pracownik */}
                        <div>
                            <label className="block text-xs font-bold text-slate-400 uppercase tracking-wide mb-1.5">
                                Pracownik (Imię i Nazwisko)
                            </label>
                            <input
                                type="text"
                                value={formData.pracownik}
                                onChange={e => setFormData(f => ({ ...f, pracownik: e.target.value }))}
                                placeholder="Imię i nazwisko pracownika..."
                                className="w-full bg-slate-900 border border-slate-700 rounded-2xl px-4 py-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-rose-500/50"
                            />
                        </div>

                        {/* Opis teczki */}
                        <div>
                            <label className="block text-xs font-bold text-slate-400 uppercase tracking-wide mb-1.5">
                                Opis teczki
                            </label>
                            <input
                                type="text"
                                value={formData.teczkaOpis}
                                onChange={e => setFormData(f => ({ ...f, teczkaOpis: e.target.value }))}
                                placeholder="Teczka akt osobowych..."
                                className="w-full bg-slate-900 border border-slate-700 rounded-2xl px-4 py-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-rose-500/50"
                            />
                        </div>

                        {/* Daty */}
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <label className="block text-xs font-bold text-slate-400 uppercase tracking-wide mb-1.5">Data od</label>
                                <input
                                    type="text"
                                    value={formData.dataOd}
                                    onChange={e => setFormData(f => ({ ...f, dataOd: e.target.value }))}
                                    placeholder="np. 1980"
                                    className="w-full bg-slate-900 border border-slate-700 rounded-2xl px-3 py-2.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-rose-500/50"
                                />
                            </div>
                            <div>
                                <label className="block text-xs font-bold text-slate-400 uppercase tracking-wide mb-1.5">Data do</label>
                                <input
                                    type="text"
                                    value={formData.dataDo}
                                    onChange={e => setFormData(f => ({ ...f, dataDo: e.target.value }))}
                                    placeholder="np. 1995"
                                    className="w-full bg-slate-900 border border-slate-700 rounded-2xl px-3 py-2.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-rose-500/50"
                                />
                            </div>
                        </div>

                        {/* Lista dokumentów */}
                        <div>
                            <div className="flex items-center justify-between mb-2">
                                <label className="text-xs font-bold text-slate-400 uppercase tracking-wide">
                                    Dokumenty w wykazie ({formData.dokumenty.length})
                                </label>
                                <span className="text-[10px] text-slate-500">Nazwa · Ilość · Uwagi</span>
                            </div>

                            <div className="space-y-2">
                                {formData.dokumenty.map((dok, i) => (
                                    <div key={i} className="rounded-2xl border border-slate-800 bg-slate-900 p-3 space-y-2">
                                        <div className="flex items-center gap-2">
                                            <span className="text-xs font-black text-slate-500 w-5">{i + 1}.</span>
                                            <input
                                                type="text"
                                                value={dok.nazwa}
                                                onChange={e => updateDok(i, 'nazwa', e.target.value)}
                                                placeholder="np. Życiorys, Świadectwo pracy..."
                                                className="flex-1 bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-rose-500/50 font-bold"
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
                                                className="text-slate-500 hover:text-red-400 text-base font-bold w-7 text-center"
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
                                                    className="w-full bg-slate-800 border border-slate-700 rounded-xl px-2 py-1.5 text-xs text-white text-center font-bold focus:outline-none focus:ring-1 focus:ring-rose-500/50"
                                                />
                                            </div>
                                            <input
                                                type="text"
                                                value={dok.uwagi}
                                                onChange={e => updateDok(i, 'uwagi', e.target.value)}
                                                placeholder="Uwagi (np. oryginał, lata 1982-1988)"
                                                className="flex-1 bg-slate-800 border border-slate-700 rounded-xl px-3 py-1.5 text-xs text-slate-300 focus:outline-none focus:ring-1 focus:ring-rose-500/50"
                                            />
                                        </div>
                                    </div>
                                ))}
                            </div>

                            <button
                                onClick={() => setFormData(f => ({ ...f, dokumenty: [...f.dokumenty, { nazwa: '', ilosc: 1, uwagi: '' }] }))}
                                className="w-full mt-2.5 py-3 rounded-2xl border border-dashed border-slate-700 text-xs font-bold text-slate-300 hover:border-slate-500 transition"
                            >
                                + Dodaj kolejny dokument
                            </button>
                        </div>

                        {/* GŁÓWNY PRZYCISK: ZAPISZ W ARCHIWUM DLA KOMPUTERA */}
                        <button
                            onClick={saveToArchive}
                            disabled={step === 'saving'}
                            className={`w-full py-5 rounded-3xl font-black text-xl active:scale-95 transition shadow-xl flex items-center justify-center gap-3 border border-emerald-400/40 ${
                                step === 'saving'
                                    ? 'bg-slate-700 text-slate-400 cursor-not-allowed'
                                    : 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-emerald-950/60'
                            }`}
                        >
                            {step === 'saving' ? (
                                <>
                                    <svg className="animate-spin h-6 w-6" viewBox="0 0 24 24" fill="none">
                                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                                    </svg>
                                    <span>Zapisywanie w systemie...</span>
                                </>
                            ) : (
                                <>
                                    <span>💾</span>
                                    <span>Zapisz w Archiwum Tarnów</span>
                                </>
                            )}
                        </button>
                        <p className="text-center text-[11px] text-slate-400 -mt-1">
                            Teczka od razu pojawi się na Twoim komputerze w biurze
                        </p>

                        {/* Opcjonalny przycisk pobrania na telefon */}
                        <div className="pt-2 text-center">
                            <button
                                onClick={downloadDocx}
                                disabled={step === 'downloading'}
                                className="text-xs text-slate-400 hover:text-slate-200 underline underline-offset-4"
                            >
                                {step === 'downloading' ? 'Generowanie...' : 'Pobierz kopię Word (.docx) na ten telefon'}
                            </button>
                        </div>
                    </div>
                )}

                {/* ══════════ KROK 6: SUKCES ══════════ */}
                {step === 'done' && (
                    <div className="flex flex-col items-center justify-center py-12 space-y-6 text-center">
                        <div className="text-6xl animate-bounce">☁️✅</div>
                        <div>
                            <h2 className="text-2xl font-black text-white">Teczka zapisana w systemie!</h2>
                            <p className="mt-2 text-xs text-slate-300 max-w-xs mx-auto leading-relaxed">
                                Wykaz dokumentów dla pracownika <b className="text-rose-400">{formData.pracownik || 'pracownika'}</b> został zapisany w chmurze.
                            </p>
                        </div>

                        <div className="rounded-2xl border border-emerald-500/40 bg-emerald-500/10 p-4 text-xs text-emerald-300 max-w-xs w-full text-left space-y-1">
                            <p className="font-bold text-white flex items-center gap-1.5">
                                <span>🖥️</span> Jak pobrać na komputerze:
                            </p>
                            <p className="text-slate-300">
                                Wejdź w panelu PESAM na komputerze w <b>Archiwum Tarnów</b> — teczka już tam jest i możesz ją jednym kliknięciem pobrać w Wordzie!
                            </p>
                        </div>

                        <button
                            onClick={reset}
                            className="w-full max-w-xs py-4 rounded-3xl bg-rose-600 hover:bg-rose-500 text-white font-black text-lg active:scale-95 transition shadow-lg"
                        >
                            🗂️ Nagraj kolejną teczkę
                        </button>

                        <Link
                            href="/plac"
                            className="text-xs text-slate-500 hover:text-slate-300 underline underline-offset-4"
                        >
                            ← Wróć do menu głównego
                        </Link>
                    </div>
                )}
            </main>
        </div>
    );
}
