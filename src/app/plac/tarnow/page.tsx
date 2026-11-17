'use client';
// src/app/plac/tarnow/page.tsx
// TELEFON: Nagrywa i kompresuje teczke, wysyla na serwer (bez AI - to robi komputer)

import { useState, useRef, useCallback, useEffect } from 'react';
import Link from 'next/link';
import { useAuth } from '@/lib/auth/AuthContext';
import { db, storage } from '@/lib/firebase/config';
import { collection, addDoc } from 'firebase/firestore';
import { ref as storageRef, uploadBytesResumable, getDownloadURL } from 'firebase/storage';

type Step = 'idle' | 'recording' | 'preview' | 'uploading' | 'done' | 'error';

export default function TarnowMobilePage() {
    const { user } = useAuth();
    const [step, setStep] = useState<Step>('idle');
    const [error, setError] = useState<string | null>(null);
    const [recordingTime, setRecordingTime] = useState(0);
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);
    const [fileSizeMb, setFileSizeMb] = useState<string>('0');
    const [uploadProgress, setUploadProgress] = useState(0);
    const [pracownikLabel, setPracownikLabel] = useState('');

    const videoRef = useRef<HTMLVideoElement | null>(null);
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const chunksRef = useRef<Blob[]>([]);
    const recordedBlobRef = useRef<Blob | null>(null);
    const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const cameraInputRef = useRef<HTMLInputElement>(null);
    const galleryInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        return () => {
            if (timerRef.current) clearInterval(timerRef.current);
            if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
            if (previewUrl) URL.revokeObjectURL(previewUrl);
        };
    }, [previewUrl]);

    // Kamera live w przeglądarce
    const startLiveCamera = useCallback(async () => {
        setError(null);
        try {
            if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());

            const stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    facingMode: { ideal: 'environment' },
                    width: { ideal: 480, max: 640 },
                    height: { ideal: 360, max: 480 },
                    frameRate: { ideal: 10, max: 12 }, // bardzo niska klatka = mały plik
                },
                audio: false,
            });

            streamRef.current = stream;
            chunksRef.current = [];
            setRecordingTime(0);
            setStep('recording');

            const mimeTypes = ['video/mp4', 'video/webm;codecs=vp8', 'video/webm'];
            const supportedMime = mimeTypes.find(m => MediaRecorder.isTypeSupported(m)) || '';

            const recorder = new MediaRecorder(stream, {
                mimeType: supportedMime || undefined,
                videoBitsPerSecond: 200_000, // 200kbps — bardzo mały plik
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
                    if (t >= 300) { // max 5 minut
                        stopLiveRecording();
                        return t;
                    }
                    return t + 1;
                });
            }, 1000);

        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            setError(`Brak dostępu do kamery: ${msg}. Użyj przycisku "Nagraj aparatem telefonu".`);
        }
    }, []);

    useEffect(() => {
        if (step === 'recording' && videoRef.current && streamRef.current) {
            videoRef.current.srcObject = streamRef.current;
            videoRef.current.play().catch(() => {});
        }
    }, [step]);

    const stopLiveRecording = useCallback(() => {
        if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
        if (mediaRecorderRef.current?.state === 'recording') mediaRecorderRef.current.stop();
        if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null; }
    }, []);

    const handleFileSelected = (file: File) => {
        setError(null);
        recordedBlobRef.current = file;
        setFileSizeMb((file.size / (1024 * 1024)).toFixed(1));
        const url = URL.createObjectURL(file);
        setPreviewUrl(url);
        setStep('preview');
    };

    // Upload do Firebase Storage + zapis do Firestore
    const uploadVideo = async () => {
        if (!recordedBlobRef.current) return;
        setStep('uploading');
        setUploadProgress(0);
        setError(null);

        try {
            const blob = recordedBlobRef.current;
            const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
            const timestamp = Date.now();
            const uid = user?.uid || 'anon';
            const userFullName = user ? `${user.firstName || ''} ${user.lastName || ''}`.trim() : 'Pracownik';

            const path = `tarnow_archive/${uid}_${timestamp}.${ext}`;
            const fileRef = storageRef(storage, path);

            await new Promise<void>((resolve, reject) => {
                const uploadTask = uploadBytesResumable(fileRef, blob, {
                    contentType: blob.type || 'video/mp4',
                });

                uploadTask.on(
                    'state_changed',
                    (snapshot) => {
                        const pct = Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 100);
                        setUploadProgress(pct);
                    },
                    (err) => reject(err),
                    async () => {
                        try {
                            const downloadUrl = await getDownloadURL(uploadTask.snapshot.ref);

                            // Zapis do Firestore ze statusem DO_PRZETWORZENIA
                            await addDoc(collection(db, 'tarnow_archive'), {
                                pracownik: pracownikLabel.trim() || '',
                                teczkaOpis: 'Teczka akt osobowych',
                                dataOd: '',
                                dataDo: '',
                                dokumenty: [],
                                uwagi: '',
                                dataWypelnienia: new Date().toISOString().split('T')[0],
                                videoUrl: downloadUrl,
                                videoPath: path,
                                videoSizeMb: parseFloat((blob.size / (1024 * 1024)).toFixed(1)),
                                createdBy: userFullName,
                                createdAt: new Date().toISOString(),
                                status: 'DO_PRZETWORZENIA',
                            });

                            resolve();
                        } catch (e) {
                            reject(e);
                        }
                    }
                );
            });

            setStep('done');

        } catch (err) {
            console.error('Błąd uploadu:', err);
            setError(err instanceof Error ? err.message : 'Błąd wysyłania nagrania');
            setStep('error');
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
        setUploadProgress(0);
        setPracownikLabel('');
        setError(null);
        setStep('idle');
    };

    const fmtTime = (s: number) =>
        `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

    return (
        <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans select-none pb-12">
            {/* Header */}
            <header className="sticky top-0 z-30 border-b border-slate-800 bg-slate-900/95 backdrop-blur shadow-xl">
                <div className="max-w-xl mx-auto w-full px-4 py-3 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                        <Link href="/plac" className="flex items-center justify-center w-10 h-10 rounded-2xl bg-slate-800 hover:bg-slate-700 text-slate-300 transition active:scale-95">←</Link>
                        <div>
                            <h1 className="text-base font-black text-rose-400 uppercase tracking-wider leading-tight">🗂️ Archiwum Tarnów</h1>
                            <p className="text-[10px] text-slate-400 font-bold">Nagraj teczkę → Analiza w biurze na komputerze</p>
                        </div>
                    </div>
                    {step !== 'idle' && step !== 'done' && (
                        <button onClick={reset} className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-bold text-slate-300">Od nowa</button>
                    )}
                </div>
            </header>

            <main className="max-w-xl mx-auto w-full p-4 flex-1 space-y-4">
                {error && (
                    <div className="rounded-2xl border border-red-500/40 bg-red-500/10 p-4 text-xs text-red-300 flex gap-2">
                        <span>⚠️</span><div>{error}</div>
                    </div>
                )}

                {/* Ukryte inputy */}
                <input ref={cameraInputRef} type="file" accept="video/*" capture="environment" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFileSelected(f); e.target.value = ''; }} />
                <input ref={galleryInputRef} type="file" accept="video/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFileSelected(f); e.target.value = ''; }} />

                {/* ════ KROK 1: START ════ */}
                {step === 'idle' && (
                    <div className="space-y-4">
                        <div className="rounded-3xl border border-rose-500/30 bg-gradient-to-br from-rose-500/15 via-slate-900 to-slate-950 p-6 text-center">
                            <div className="text-5xl mb-3">📱</div>
                            <h2 className="text-xl font-black text-white">Nagraj Teczkę</h2>
                            <p className="mt-2 text-xs text-slate-300 leading-relaxed">
                                Nagraj filmik z teczką — zostanie wysłany do systemu. <b>AI przetworzy go automatycznie w biurze</b> na komputerze — nie musisz czekać.
                            </p>
                        </div>

                        {/* Opcjonalne oznaczenie pracownika */}
                        <div>
                            <label className="block text-xs font-bold text-slate-400 uppercase tracking-wide mb-2">Opcjonalnie: Nazwisko pracownika (do oznaczenia)</label>
                            <input
                                type="text"
                                value={pracownikLabel}
                                onChange={e => setPracownikLabel(e.target.value)}
                                placeholder="np. Jan Kowalski (możesz dodać później w biurze)"
                                className="w-full bg-slate-900 border border-slate-700 rounded-2xl px-4 py-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-rose-500/50"
                            />
                        </div>

                        {/* Główny przycisk */}
                        <button onClick={() => cameraInputRef.current?.click()}
                            className="w-full py-6 rounded-3xl bg-rose-600 hover:bg-rose-500 active:scale-[0.98] transition text-white font-black text-xl shadow-xl shadow-rose-950/60 flex items-center justify-center gap-3">
                            <span className="text-2xl">📱</span>
                            <span>Nagraj aparatem telefonu</span>
                        </button>
                        <p className="text-center text-[11px] text-slate-400 -mt-2">Zalecane — najlepsza jakość obrazu z autofokusem</p>

                        <div className="grid grid-cols-2 gap-3">
                            <button onClick={startLiveCamera} className="p-4 rounded-2xl border border-slate-700 bg-slate-900 hover:bg-slate-800 active:scale-95 transition text-left">
                                <span className="text-2xl block mb-1.5">🔴</span>
                                <div className="text-xs font-black text-white">Kamera na żywo</div>
                                <div className="text-[10px] text-slate-400">Podgląd w aplikacji</div>
                            </button>
                            <button onClick={() => galleryInputRef.current?.click()} className="p-4 rounded-2xl border border-slate-700 bg-slate-900 hover:bg-slate-800 active:scale-95 transition text-left">
                                <span className="text-2xl block mb-1.5">📂</span>
                                <div className="text-xs font-black text-white">Z galerii</div>
                                <div className="text-[10px] text-slate-400">Gotowe nagranie</div>
                            </button>
                        </div>

                        <div className="rounded-2xl border border-slate-800/80 bg-slate-900/60 p-4 text-xs text-slate-400 space-y-1">
                            <p className="font-bold text-slate-300">💡 Wskazówki nagrywania:</p>
                            <p>• Przekładaj kartki powoli (2–3 sek. na dokument)</p>
                            <p>• Pokaż okładkę z nazwiskiem na początku</p>
                            <p>• Nagranie może trwać 2–3 minuty — zajmie ok. <b>3–5 MB</b></p>
                            <p>• AI przeanalizuje je w biurze, nie musisz czekać</p>
                        </div>
                    </div>
                )}

                {/* ════ KROK 2: NAGRYWANIE LIVE ════ */}
                {step === 'recording' && (
                    <div className="space-y-4">
                        <div className="relative rounded-3xl overflow-hidden bg-black border-2 border-rose-500 shadow-2xl aspect-video">
                            <video ref={(el) => { videoRef.current = el; if (el && streamRef.current && el.srcObject !== streamRef.current) { el.srcObject = streamRef.current; el.play().catch(() => {}); } }} autoPlay playsInline muted className="w-full h-full object-cover" />
                            <div className="absolute top-3 left-3 flex items-center gap-2 bg-black/80 rounded-full px-3 py-1.5 border border-red-500/40">
                                <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-ping" />
                                <span className="text-xs font-black text-white">REC {fmtTime(recordingTime)}</span>
                            </div>
                            <div className="absolute top-3 right-3 bg-black/70 rounded-xl px-2.5 py-1 text-[10px] text-slate-300">max 5:00</div>
                        </div>

                        <button onClick={stopLiveRecording} className="w-full py-5 rounded-3xl bg-red-600 hover:bg-red-500 text-white font-black text-xl active:scale-95 transition shadow-xl flex items-center justify-center gap-3">
                            <span className="w-4 h-4 bg-white rounded-sm inline-block" /><span>Zatrzymaj nagranie</span>
                        </button>
                        <p className="text-center text-xs text-slate-400">Powoli przekładaj strony — wystarczy pokazać nagłówek każdego pisma</p>
                    </div>
                )}

                {/* ════ KROK 3: PODGLĄD I WYŚLIJ ════ */}
                {step === 'preview' && (
                    <div className="space-y-4">
                        <div className="rounded-3xl overflow-hidden bg-black border border-slate-700 shadow-xl aspect-video">
                            {previewUrl && <video src={previewUrl} controls playsInline className="w-full h-full object-contain" />}
                        </div>

                        <div className="rounded-2xl border border-slate-800 bg-slate-900 p-4 space-y-2">
                            <div className="flex items-center justify-between text-xs">
                                <span className="text-slate-400">Rozmiar nagrania:</span>
                                <span className="font-black text-white text-sm">{fileSizeMb} MB</span>
                            </div>
                            {parseFloat(fileSizeMb) > 20 && (
                                <div className="text-[11px] text-amber-400 bg-amber-400/10 border border-amber-400/30 rounded-xl px-3 py-2">
                                    ⚠️ Duży plik ({fileSizeMb} MB) — wysyłanie może chwilę potrwać przez Wi-Fi
                                </div>
                            )}
                        </div>

                        {/* Opcjonalne oznaczenie */}
                        <div>
                            <label className="block text-xs font-bold text-slate-400 uppercase tracking-wide mb-1.5">Oznaczenie pracownika (opcjonalne)</label>
                            <input
                                type="text"
                                value={pracownikLabel}
                                onChange={e => setPracownikLabel(e.target.value)}
                                placeholder="np. Jan Kowalski"
                                className="w-full bg-slate-900 border border-slate-700 rounded-2xl px-4 py-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-rose-500/50"
                            />
                        </div>

                        <button onClick={uploadVideo} className="w-full py-5 rounded-3xl bg-rose-600 hover:bg-rose-500 text-white font-black text-xl active:scale-95 transition shadow-xl flex items-center justify-center gap-3">
                            <span>☁️</span><span>Wyślij do systemu</span>
                        </button>
                        <p className="text-center text-[11px] text-slate-400 -mt-2">AI przeanalizuje teczkę w biurze — nie musisz czekać na telefonie</p>

                        <button onClick={reset} className="w-full py-3 rounded-2xl border border-slate-700 text-slate-400 text-xs font-bold hover:bg-slate-900 active:scale-95 transition">
                            🔄 Nagraj ponownie
                        </button>
                    </div>
                )}

                {/* ════ KROK 4: WYSYŁANIE ════ */}
                {step === 'uploading' && (
                    <div className="flex flex-col items-center justify-center py-16 space-y-6 text-center">
                        <div className="relative w-24 h-24">
                            <svg className="w-24 h-24 -rotate-90" viewBox="0 0 96 96">
                                <circle cx="48" cy="48" r="40" fill="none" stroke="#1e293b" strokeWidth="8" />
                                <circle cx="48" cy="48" r="40" fill="none" stroke="#f43f5e" strokeWidth="8"
                                    strokeDasharray={`${2 * Math.PI * 40}`}
                                    strokeDashoffset={`${2 * Math.PI * 40 * (1 - uploadProgress / 100)}`}
                                    strokeLinecap="round" className="transition-all duration-300" />
                            </svg>
                            <span className="absolute inset-0 flex items-center justify-center font-black text-white text-lg">{uploadProgress}%</span>
                        </div>
                        <div>
                            <p className="font-black text-white text-lg">Wysyłanie nagrania...</p>
                            <p className="text-xs text-slate-400 mt-1">{fileSizeMb} MB — przez Wi-Fi może potrwać chwilę</p>
                        </div>
                        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 px-6 py-3 text-[11px] text-slate-400 max-w-xs">
                            Nagranie trafia do chmury. Możesz założyć telefon do kieszeni — nie przerywaj połączenia.
                        </div>
                    </div>
                )}

                {/* ════ KROK 5: GOTOWE ════ */}
                {step === 'done' && (
                    <div className="flex flex-col items-center justify-center py-12 space-y-6 text-center">
                        <div className="text-7xl">✅</div>
                        <div>
                            <h2 className="text-2xl font-black text-white">Teczka wysłana!</h2>
                            <p className="mt-2 text-xs text-slate-300 max-w-xs mx-auto leading-relaxed">
                                Nagranie trafiło do systemu. W biurze na komputerze kliknij <b>"Analizuj z AI"</b> — AI rozpozna dokumenty i przygotuje wykaz do pobrania w Wordzie.
                            </p>
                        </div>

                        <div className="rounded-2xl border border-emerald-500/40 bg-emerald-500/10 p-4 text-xs text-emerald-300 max-w-xs w-full text-left space-y-1">
                            <p className="font-bold text-white flex items-center gap-1.5">🖥️ Jak odebrać na komputerze:</p>
                            <p>Panel PESAM → <b>Archiwum Tarnów</b> → zakładka <b>"Do przetworzenia"</b></p>
                            <p>Kliknij <b>"🤖 Analizuj z AI"</b> → sprawdź → pobierz Word</p>
                        </div>

                        <button onClick={reset} className="w-full max-w-xs py-4 rounded-3xl bg-rose-600 hover:bg-rose-500 text-white font-black text-lg active:scale-95 transition shadow-lg">
                            🗂️ Nagraj kolejną teczkę
                        </button>
                        <Link href="/plac" className="text-xs text-slate-500 hover:text-slate-300 underline underline-offset-4">← Menu główne</Link>
                    </div>
                )}

                {/* ════ BŁĄD UPLOADU ════ */}
                {step === 'error' && (
                    <div className="flex flex-col items-center justify-center py-12 space-y-5 text-center">
                        <div className="text-5xl">❌</div>
                        <div>
                            <h2 className="text-xl font-black text-white">Nie udało się wysłać</h2>
                            <p className="text-xs text-slate-400 mt-2 max-w-xs mx-auto">Sprawdź połączenie internetowe i spróbuj ponownie. Nagranie jest wciąż dostępne.</p>
                        </div>
                        <button onClick={() => setStep('preview')} className="w-full max-w-xs py-4 rounded-3xl bg-rose-600 hover:bg-rose-500 text-white font-black text-base active:scale-95 transition">
                            🔄 Spróbuj wysłać ponownie
                        </button>
                        <button onClick={reset} className="text-xs text-slate-500 underline">Zacznij od nowa</button>
                    </div>
                )}
            </main>
        </div>
    );
}
