// src/app/dashboard/voice-order/page.tsx
"use client";

import React, { useState, useEffect, useRef } from "react";
import { useAuth } from "@/lib/auth/AuthContext";
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

export default function VoiceOrderPage() {
    const { user } = useAuth();
    const canUse = user ? hasPermission("voiceOrdering", user.rolePermissions, user.permissionOverrides) : false;

    const [sites, setSites] = useState<Site[]>([]);
    const [selectedSiteId, setSelectedSiteId] = useState("");
    const [isRecording, setIsRecording] = useState(false);
    const [offlineList, setOfflineList] = useState<OfflineRecording[]>([]);
    const [isSyncing, setIsSyncing] = useState(false);
    const [syncProgress, setSyncProgress] = useState("");

    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const audioChunksRef = useRef<Blob[]>([]);

    // ─── 1. Inicjalizacja budów i wczytywanie pamięci offline ─────────────────
    useEffect(() => {
        if (!user) return;

        const loadData = async () => {
            try {
                // Pobierz przypisane budowy
                const sitesSnap = await getDocs(query(collection(db, "sites"), orderBy("name", "asc")));
                const allSites = sitesSnap.docs.map(d => ({ id: d.id, ...d.data() })) as Site[];
                const userAssigned = user?.assignedSites || [];

                const filtered = allSites.filter(s =>
                    (userAssigned.includes("ALL") || userAssigned.includes(s.id)) &&
                    s.location !== "Wpis ręczny" && s.status !== "ZAKOŃCZONA"
                );

                setSites(filtered);
                // Zapisz budowy w localStorage na wypadek braku sieci przy kolejnym wejściu
                localStorage.setItem(`pesam_sites_${user.uid}`, JSON.stringify(filtered));

                if (filtered.length === 1) setSelectedSiteId(filtered[0].id);
            } catch (err) {
                // Gdy brak sieci, wczytaj budowy z pamięci podręcznej przeglądarki!
                const cached = localStorage.getItem(`pesam_sites_${user.uid}`);
                if (cached) {
                    const parsed = JSON.parse(cached);
                    setSites(parsed);
                    if (parsed.length === 1) setSelectedSiteId(parsed[0].id);
                }
            }

            // Wczytaj nagrania oczekujące w IndexedDB
            refreshOfflineList();
        };

        loadData();
    }, [user]);

    const refreshOfflineList = async () => {
        const list = await getOfflineRecordings();
        setOfflineList(list);
    };

    // ─── 2. Logika nagrywania dźwięku ─────────────────────────────────────────
    const startRecording = async () => {
        if (!selectedSiteId) return alert("Najpierw wybierz budowę, dla której składasz zamówienie!");
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

                // Wyłącz mikrofon
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

    // ─── 3. Synchronizacja plików do Firebase po powrocie do sieci ─────────────
    const handleSyncRecordings = async () => {
        if (offlineList.length === 0) return;
        setIsSyncing(true);
        const storage = getStorage();

        try {
            for (let i = 0; i < offlineList.length; i++) {
                const rec = offlineList[i];
                setSyncProgress(`Wysyłanie: ${i + 1} z ${offlineList.length}...`);

                // 1. Wgraj plik audio do Firebase Storage
                const fileRef = ref(storage, `voice_orders/${user?.uid}/${rec.id}.mp3`);
                await uploadBytes(fileRef, rec.audioBlob);
                const fileUrl = await getDownloadURL(fileRef);

                // 2. Utwórz dokument zlecenia głosowego w Firestore
                const voiceDocRef = doc(db, "voiceOrders", rec.id);
                await setDoc(voiceDocRef, {
                    id: rec.id,
                    siteId: rec.siteId,
                    siteName: rec.siteName,
                    userId: user?.uid,
                    userName: `${user?.firstName} ${user?.lastName}`,
                    audioUrl: fileUrl,
                    status: "PENDING", // Oczekuje na przetworzenie/wczytanie w sklepie
                    createdAt: rec.createdAt
                });

                // 3. Usuń z lokalnej bazy IndexedDB
                await deleteOfflineRecording(rec.id);
            }

            alert("✅ Wszystkie nagrania zostały przesłane do systemu!");
            refreshOfflineList();
        } catch (err: any) {
            alert("Błąd synchronizacji: " + err.message);
        } finally {
            setIsSyncing(false);
            setSyncProgress("");
        }
    };

    if (!canUse) {
        return <div className="p-10 text-center text-red-500 font-bold">Brak uprawnień do rejestratora głosowego.</div>;
    }

    return (
        <div className="p-4 md:p-8 max-w-md mx-auto min-h-[calc(100vh-64px)] flex flex-col justify-between bg-slate-50">

            {/* Góra: wybór budowy */}
            <div className="space-y-4">
                <div className="text-center">
                    <span className="text-3xl">🎙️</span>
                    <h1 className="text-xl font-black text-slate-800 uppercase tracking-tight mt-2">Dyktafon Zamówień</h1>
                    <p className="text-xs text-slate-500 mt-1">Nagraj zapotrzebowanie bezpośrednio na budowie — nawet bez internetu.</p>
                </div>

                <div className="bg-white p-4 rounded-2xl border shadow-sm">
                    <label className="block text-[10px] font-black text-slate-500 uppercase mb-1.5">Wybierz budowę docelową</label>
                    {sites.length === 0 ? (
                        <p className="text-xs text-red-500 font-bold">Brak przypisanych budów.</p>
                    ) : sites.length === 1 ? (
                        <div className="p-3 bg-blue-50 border border-blue-200 rounded-xl font-bold text-sm text-blue-800 text-center">
                            🏢 {sites[0].name}
                        </div>
                    ) : (
                        <select
                            value={selectedSiteId}
                            onChange={e => setSelectedSiteId(e.target.value)}
                            className="w-full p-3 border-2 border-slate-200 rounded-xl bg-white text-sm font-bold outline-none focus:border-blue-500"
                        >
                            <option value="">-- Wybierz budowę --</option>
                            {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </select>
                    )}
                </div>
            </div>

            {/* Środek: Okrągły przycisk nagrywania */}
            <div className="flex flex-col items-center justify-center py-10">
                {isRecording ? (
                    <button
                        onClick={stopRecording}
                        className="w-36 h-36 rounded-full bg-red-600 text-white font-black text-xs shadow-2xl flex flex-col items-center justify-center gap-2 border-8 border-red-200 animate-pulse transition"
                    >
                        <span className="text-3xl">⏹️</span>
                        <span>ZAKOŃCZ</span>
                    </button>
                ) : (
                    <button
                        onClick={startRecording}
                        className="w-36 h-36 rounded-full bg-blue-600 text-white font-black text-xs shadow-2xl flex flex-col items-center justify-center gap-2 border-8 border-blue-100 hover:bg-blue-700 transition"
                    >
                        <span className="text-4xl">🎙️</span>
                        <span>NAGRAJ POZYCJĘ</span>
                    </button>
                )}
                <p className="text-xs font-bold text-slate-500 mt-4 h-4">
                    {isRecording ? "🔴 Trwa nagrywanie... Mów wyraźnie." : "Dotknij, aby rozpocząć nagrywanie"}
                </p>
            </div>

            {/* Dół: Lista oczekujących nagrań i synchronizacja */}
            <div className="space-y-4">
                <div className="bg-white p-4 rounded-2xl border shadow-sm">
                    <div className="flex justify-between items-center mb-3">
                        <span className="text-xs font-black text-slate-500 uppercase tracking-wider">Oczekujące w telefonie ({offlineList.length})</span>
                        {offlineList.length > 0 && !isSyncing && (
                            <button
                                onClick={handleSyncRecordings}
                                className="bg-green-600 hover:bg-green-700 text-white font-black text-[10px] uppercase px-3 py-1.5 rounded-lg shadow-sm transition"
                            >
                                🔄 Wyślij do bazy
                            </button>
                        )}
                    </div>

                    {isSyncing && (
                        <div className="bg-blue-600 text-white font-bold p-3 rounded-xl text-center text-xs animate-pulse">
                            {syncProgress}
                        </div>
                    )}

                    <div className="space-y-2 max-h-40 overflow-y-auto">
                        {offlineList.length === 0 ? (
                            <p className="text-xs text-center text-slate-400 py-4 italic">Brak zapisanych notatek offline.</p>
                        ) : (
                            offlineList.map(rec => (
                                <div key={rec.id} className="flex justify-between items-center bg-slate-50 p-2.5 rounded-xl border text-xs">
                                    <div className="min-w-0 flex-1 pr-3">
                                        <p className="font-bold text-slate-800 truncate">🏢 {rec.siteName}</p>
                                        <p className="text-[10px] text-slate-400 mt-0.5">{new Date(rec.createdAt).toLocaleTimeString()}</p>
                                    </div>
                                    <button
                                        onClick={async () => {
                                            if (confirm("Usunąć to nagranie?")) {
                                                await deleteOfflineRecording(rec.id);
                                                refreshOfflineList();
                                            }
                                        }}
                                        className="text-red-500 hover:text-red-700 font-bold px-2 text-base"
                                    >&times;</button>
                                </div>
                            ))
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}