// src/app/voice-order/page.tsx
"use client";

import React, { useState, useEffect, useRef } from "react";
import { useAuth } from "@/lib/auth/AuthContext";
import { useRouter } from "next/navigation";
import { hasPermission } from "@/lib/auth/permissions";
import { collection, getDocs, query, orderBy, doc, setDoc } from "firebase/firestore";
import { getStorage, ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { db } from "@/lib/firebase/config";
import {
    saveRecordingOffline,
    getOfflineRecordings,
    deleteOfflineRecording,
    OfflineRecording
} from "@/lib/db/offline-audio";

interface Site {
    id: string;
    name: string;
    location?: string;
    status?: string;
}

export default function MobileVoiceOrderPage() {
    const { user, loading, signOut } = useAuth();
    const router = useRouter();

    const [sites, setSites] = useState<Site[]>([]);
    const [selectedSiteId, setSelectedSiteId] = useState("");
    const [isRecording, setIsRecording] = useState(false);
    const [offlineList, setOfflineList] = useState<OfflineRecording[]>([]);
    const [isSyncing, setIsSyncing] = useState(false);
    const [syncProgress, setSyncProgress] = useState("");

    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const audioChunksRef = useRef<Blob[]>([]);

    // Zapisz trwałą flagę zalogowania w telefonie, gdy użytkownik jest aktywny
    useEffect(() => {
        if (user) {
            localStorage.setItem("pesam_logged_in", "true");
        }
    }, [user]);

    // Zabezpieczenie autoryzacji z ominięciem błędu offline
    useEffect(() => {
        // Czytamy flagę z pamięci telefonu (działa natychmiast i bez internetu!)
        const isLocalLoggedIn = localStorage.getItem("pesam_logged_in") === "true";

        if (!loading && !user && !isLocalLoggedIn) {
            router.push("/login?redirect=/voice-order"); // <-- Przekazujemy cel powrotny!
        }
    }, [user, loading, router]);

    // Wczytywanie danych budów (z obsługą offline)
    useEffect(() => {
        if (!user) return;

        const loadData = async () => {
            try {
                const sitesSnap = await getDocs(query(collection(db, "sites"), orderBy("name", "asc")));
                const allSites = sitesSnap.docs.map(d => ({ id: d.id, ...d.data() })) as Site[];
                const userAssigned = user?.assignedSites || [];

                const filtered = allSites.filter(s =>
                    (userAssigned.includes("ALL") || userAssigned.includes(s.id)) &&
                    s.location !== "Wpis ręczny" && s.status !== "ZAKOŃCZONA"
                );

                setSites(filtered);
                localStorage.setItem(`pesam_sites_${user.uid}`, JSON.stringify(filtered));
                if (filtered.length === 1) setSelectedSiteId(filtered[0].id);
            } catch (err) {
                // Tryb Offline: wczytaj budowy z pamięci podręcznej telefonu
                const cached = localStorage.getItem(`pesam_sites_${user.uid}`);
                if (cached) {
                    const parsed = JSON.parse(cached);
                    setSites(parsed);
                    if (parsed.length === 1) setSelectedSiteId(parsed[0].id);
                }
            }
            refreshOfflineList();
        };

        loadData();
    }, [user]);

    const refreshOfflineList = async () => {
        const list = await getOfflineRecordings();
        setOfflineList(list);
    };

    // Bezpieczne pobieranie offline
    const handleDownloadOffline = async () => {
        try {
            alert("Rozpoczynam zapisywanie plików dyktafonu w pamięci telefonu. Za chwilę ekran mrugnie.");
            // Zwykłe przeładowanie. Nasz nowy silnik sw.js (v3) przejmie kontrolę
            // i natychmiast zaciągnie wszystko do pamięci offline w bezpieczny sposób.
            window.location.reload();
        } catch (err: any) {
            alert("Błąd: " + err.message);
        }
    };

    const startRecording = async () => {
        if (!selectedSiteId) return alert("Najpierw wybierz budowę!");
        audioChunksRef.current = [];

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const mediaRecorder = new MediaRecorder(stream);
            mediaRecorderRef.current = mediaRecorder;

            mediaRecorder.ondataavailable = (event) => {
                if (event.data.size > 0) audioChunksRef.current.push(event.data);
            };

            mediaRecorder.onstop = async () => {
                const audioBlob = new Blob(audioChunksRef.current, { type: "audio/mp3" });
                const selectedSite = sites.find(s => s.id === selectedSiteId);

                const newRecording: OfflineRecording = {
                    id: `REC-${Date.now()}`,
                    siteId: selectedSiteId,
                    siteName: selectedSite?.name || "Nieznana",
                    audioBlob,
                    createdAt: new Date().toISOString()
                };

                await saveRecordingOffline(newRecording);
                refreshOfflineList();
                stream.getTracks().forEach(track => track.stop());
            };

            mediaRecorder.start();
            setIsRecording(true);
        } catch (err: any) {
            alert("Błąd mikrofonu: " + err.message);
        }
    };

    const stopRecording = () => {
        if (mediaRecorderRef.current && isRecording) {
            mediaRecorderRef.current.stop();
            setIsRecording(false);
        }
    };

    const handleSyncRecordings = async () => {
        if (offlineList.length === 0) return;
        setIsSyncing(true);
        const storage = getStorage();

        try {
            for (let i = 0; i < offlineList.length; i++) {
                const rec = offlineList[i];
                setSyncProgress(`Wysyłanie: ${i + 1} z ${offlineList.length}...`);

                const fileRef = ref(storage, `voice_orders/${user?.uid}/${rec.id}.mp3`);
                await uploadBytes(fileRef, rec.audioBlob);
                const fileUrl = await getDownloadURL(fileRef);

                const voiceDocRef = doc(db, "voiceOrders", rec.id);
                await setDoc(voiceDocRef, {
                    id: rec.id,
                    siteId: rec.siteId,
                    siteName: rec.siteName,
                    userId: user?.uid,
                    userName: `${user?.firstName} ${user?.lastName}`,
                    audioUrl: fileUrl,
                    status: "PENDING",
                    createdAt: rec.createdAt
                });

                await deleteOfflineRecording(rec.id);
            }

            alert("✅ Wszystkie notatki zostały przesłane do systemu!");
            refreshOfflineList();
        } catch (err: any) {
            alert("Błąd synchronizacji: " + err.message);
        } finally {
            setIsSyncing(false);
            setSyncProgress("");
        }
    };

    if (loading) return <div className="min-h-screen flex items-center justify-center bg-slate-900 text-white font-bold">Ładowanie...</div>;
    if (!user) return null;

    const canUse = hasPermission("voiceOrdering", user.rolePermissions, user.permissionOverrides);
    if (!canUse) {
        return (
            <div className="min-h-screen bg-slate-900 text-white flex flex-col items-center justify-center p-6 text-center">
                <span className="text-5xl">⚠️</span>
                <p className="font-bold mt-4">Brak uprawnień do dyktafonu.</p>
                <p className="text-xs text-slate-400 mt-1">Skontaktuj się z administratorem PESAM.</p>
                <button onClick={() => signOut()} className="mt-6 px-6 py-2.5 bg-red-600 rounded-xl text-xs font-bold uppercase">Wyloguj</button>
            </div>
        );
    }

    return (
        <div className="min-h-[100dvh] bg-slate-900 text-white flex flex-col justify-between p-5 select-none overflow-hidden">

            {/* Top Bar - Minimalistyczny nagłówek natywny */}
            <div className="flex justify-between items-center pb-4 border-b border-slate-800">
                <div className="flex items-center gap-2">
                    <span className="text-xl">🎙️</span>
                    <span className="font-black text-sm tracking-widest text-blue-400 uppercase">PESAM VOICE</span>
                </div>
                <div className="flex gap-2">
                    <button
                        onClick={handleDownloadOffline}
                        className="text-[10px] font-black text-green-400 border border-green-500/20 px-3 py-1.5 rounded-lg bg-green-500/5 hover:bg-green-500/10 shadow-sm"
                        title="Zapisz do pracy bez internetu"
                    >
                        ⬇️ POBIERZ OFFLINE
                    </button>
                    <button
                        onClick={() => {
                            if (confirm("Czy chcesz się wylogować?")) {
                                localStorage.removeItem("pesam_logged_in");
                                signOut();
                            }
                        }}
                        className="text-[10px] font-black text-red-400 border border-red-500/20 px-3 py-1.5 rounded-lg bg-red-500/5 hover:bg-red-500/10"
                    >
                        WYLOGUJ
                    </button>
                </div>
            </div>

            {/* Wybór budowy */}
            <div className="my-4 bg-slate-800/60 p-4 rounded-2xl border border-slate-800/80">
                <label className="block text-[9px] font-black text-slate-400 uppercase tracking-wider mb-2">Budowa docelowa:</label>
                {sites.length === 0 ? (
                    <p className="text-xs text-red-400 font-bold">Brak przypisanych budów.</p>
                ) : sites.length === 1 ? (
                    <p className="text-sm font-black text-blue-400">🏢 {sites[0].name}</p>
                ) : (
                    <select
                        value={selectedSiteId}
                        onChange={e => setSelectedSiteId(e.target.value)}
                        className="w-full p-3 bg-slate-800 border-2 border-slate-700 rounded-xl text-xs font-black text-white outline-none focus:border-blue-500 cursor-pointer"
                    >
                        <option value="">-- Wybierz budowę --</option>
                        {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                )}
            </div>

            {/* Centralny przycisk dyktafonu */}
            <div className="flex-1 flex flex-col items-center justify-center my-6">
                {isRecording ? (
                    <button
                        onClick={stopRecording}
                        className="w-40 h-40 rounded-full bg-red-600 text-white font-black text-xs shadow-2xl flex flex-col items-center justify-center gap-2 border-8 border-red-900/50 animate-pulse active:scale-95 transition"
                    >
                        <span className="text-3xl">⏹️</span>
                        <span>ZAKOŃCZ</span>
                    </button>
                ) : (
                    <button
                        onClick={startRecording}
                        className="w-40 h-40 rounded-full bg-blue-600 text-white font-black text-xs shadow-2xl flex flex-col items-center justify-center gap-2 border-8 border-blue-900/50 active:scale-95 transition-all"
                    >
                        <span className="text-4xl">🎙️</span>
                        <span>NAGRAJ</span>
                    </button>
                )}
                <p className="text-xs font-bold text-slate-500 mt-5 h-4">
                    {isRecording ? "🔴 Nagrywanie... Mów do telefonu" : "Dotknij okręgu, aby nagrać zamówienie"}
                </p>
            </div>

            {/* Dolna lista offline */}
            <div className="bg-slate-850 border border-slate-800/80 p-4 rounded-2xl">
                <div className="flex justify-between items-center mb-3">
                    <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Oczekujące w telefonie ({offlineList.length})</span>
                    {offlineList.length > 0 && !isSyncing && (
                        <button
                            onClick={handleSyncRecordings}
                            className="bg-green-600 hover:bg-green-700 text-white font-black text-[10px] uppercase px-3 py-1.5 rounded-lg shadow-md transition"
                        >
                            🔄 Synchronizuj
                        </button>
                    )}
                </div>

                {isSyncing && (
                    <div className="bg-blue-600 text-white font-bold p-3 rounded-xl text-center text-xs animate-pulse mb-2">
                        {syncProgress}
                    </div>
                )}

                <div className="space-y-2 max-h-36 overflow-y-auto pr-1">
                    {offlineList.length === 0 ? (
                        <p className="text-[11px] text-center text-slate-500 py-3 italic">Wszystkie notatki wysłane. Brak nagrań offline.</p>
                    ) : (
                        offlineList.map(rec => (
                            <div key={rec.id} className="flex justify-between items-center bg-slate-800/50 p-2.5 rounded-xl border border-slate-800 text-xs">
                                <div className="min-w-0 flex-1 pr-3">
                                    <p className="font-bold text-slate-300 truncate">🏢 {rec.siteName}</p>
                                    <p className="text-[10px] text-slate-500 mt-0.5">{new Date(rec.createdAt).toLocaleTimeString()}</p>
                                </div>
                                <button
                                    onClick={async () => {
                                        if (confirm("Usunąć to nagranie?")) {
                                            await deleteOfflineRecording(rec.id);
                                            refreshOfflineList();
                                        }
                                    }}
                                    className="text-red-400 hover:text-red-500 font-bold px-2 text-base"
                                >&times;</button>
                            </div>
                        ))
                    )}
                </div>
            </div>
        </div>
    );
}