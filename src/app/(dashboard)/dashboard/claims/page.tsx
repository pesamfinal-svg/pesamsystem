// src/app/(dashboard)/dashboard/claims/page.tsx
"use client";

import { useState, useEffect, useRef } from "react";
import { collection, getDocs, doc, updateDoc, arrayUnion, query, orderBy } from "firebase/firestore";
import { db } from "@/lib/firebase/config";
import { useAuth } from "@/lib/auth/AuthContext";
import { hasPermission } from "@/lib/auth/permissions";

// --- INTERFEJSY ---
interface ChatMessage {
    id: string;
    senderId: string;
    senderName: string;
    senderRole: "AI" | "DYREKCJA" | "KIEROWNIK" | "MAGAZYN";
    text: string;
    timestamp: string;
    visibleToWarehouse: boolean;
}

interface Claim {
    id: string;
    claimId: string;
    inventoryId: string;
    inventoryName: string;
    inventoryNumber: string;
    siteName: string;
    reportedBy: string;
    reportedByName: string;
    description: string;
    status: "NOWA" | "W_TOKU" | "ZAMKNIETA";
    createdAt: string;
    assignedManagers: string[];
    messages: ChatMessage[];
    decisionInternal?: string;
    decisionWarehouse?: string;
}

interface UserBasic { uid: string; name: string; roleId: string; }

export default function ClaimsCenter() {
    const { user } = useAuth();
    const [claims, setClaims] = useState<Claim[]>([]);
    const [managers, setManagers] = useState<UserBasic[]>([]);
    const [selectedClaim, setSelectedClaim] = useState<Claim | null>(null);
    const [loading, setLoading] = useState(true);

    const [messageText, setMessageText] = useState("");
    const [visibleToWarehouse, setVisibleToWarehouse] = useState(false);
    const [isSending, setIsSending] = useState(false);
    const [aiGenerating, setAiGenerating] = useState(false);

    const canManageClaims = user ? hasPermission("manageClaims", user.rolePermissions, user.permissionOverrides) : false;
    const canViewAllClaims = user ? hasPermission("viewAllClaims", user.rolePermissions, user.permissionOverrides) : false;

    const chatRoleName = canManageClaims ? "DYREKCJA" : user?.roleId === "magazynier" ? "MAGAZYN" : "KIEROWNIK";

    const chatEndRef = useRef<HTMLDivElement>(null);

    const fetchData = async () => {
        setLoading(true);
        try {
            const q = query(collection(db, "claims"), orderBy("createdAt", "desc"));
            const snap = await getDocs(q);
            let allClaims = snap.docs.map(d => ({ id: d.id, ...d.data() } as Claim));

            if (!canViewAllClaims) {
                allClaims = allClaims.filter(c => c.assignedManagers.includes(user?.uid || "") || c.reportedBy === user?.uid);
            }
            setClaims(allClaims);

            if (canManageClaims) {
                const uSnap = await getDocs(collection(db, "users"));
                setManagers(uSnap.docs.map(d => ({ uid: d.id, name: `${d.data().firstName} ${d.data().lastName}`, roleId: d.data().roleId })));
            }
        } catch (error) { console.error("Błąd pobierania:", error); } finally { setLoading(false); }
    };

    useEffect(() => { if (user) fetchData(); }, [user]);
    useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [selectedClaim?.messages]);

    // =========================================================================
    // START ŚLEDZTWA: Dyrektor przypisuje osobę -> Prawdziwe AI generuje atak
    // =========================================================================
    const assignManagerAndStartInvestigation = async (managerUid: string) => {
        if (!selectedClaim || !managerUid) return;
        setAiGenerating(true);

        try {
            const response = await fetch('/api/claims-ai', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ inventoryName: selectedClaim.inventoryName, isInitial: true })
            });
            const data = await response.json();

            const aiInitialMessage: ChatMessage = {
                id: Date.now().toString(),
                senderId: "system_ai",
                senderName: "Asystent Śledczy AI 🤖",
                senderRole: "AI",
                text: data.reply,
                timestamp: new Date().toISOString(),
                visibleToWarehouse: false
            };

            const claimRef = doc(db, "claims", selectedClaim.id);
            await updateDoc(claimRef, {
                assignedManagers: arrayUnion(managerUid),
                status: "W_TOKU",
                messages: arrayUnion(aiInitialMessage)
            });

            alert("Kierownik przypisany! AI rozpoczęło przesłuchanie.");
            fetchData();
            setSelectedClaim({ ...selectedClaim, assignedManagers: [managerUid], status: "W_TOKU", messages: [...(selectedClaim.messages || []), aiInitialMessage] });
        } catch (e) { alert("Błąd AI: " + e); } finally { setAiGenerating(false); }
    };

    // =========================================================================
    // ANALIZA AI: Gemini analizuje tłumaczenia kierownika
    // =========================================================================
    const askAiForHelp = async () => {
        if (!selectedClaim) return;
        setAiGenerating(true);
        try {
            const response = await fetch('/api/claims-ai', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    inventoryName: selectedClaim.inventoryName,
                    messages: selectedClaim.messages
                })
            });
            const data = await response.json();
            if (response.ok) setMessageText(data.reply);
            else alert("Błąd serwera AI.");
        } catch (error) { alert("Brak połączenia z AI."); }
        finally { setAiGenerating(false); }
    };

    const sendMessage = async () => {
        if (!messageText.trim() || !selectedClaim) return;
        setIsSending(true);
        const newMsg: ChatMessage = {
            id: Date.now().toString(),
            senderId: user?.uid || "",
            senderName: `${user?.firstName} ${user?.lastName}`,
            senderRole: chatRoleName,
            text: messageText,
            timestamp: new Date().toISOString(),
            visibleToWarehouse: canManageClaims ? visibleToWarehouse : true
        };
        try {
            await updateDoc(doc(db, "claims", selectedClaim.id), { messages: arrayUnion(newMsg) });
            setSelectedClaim({ ...selectedClaim, messages: [...(selectedClaim.messages || []), newMsg] });
            setMessageText("");
            setVisibleToWarehouse(false);
        } catch (e) { alert("Błąd: " + e); } finally { setIsSending(false); }
    };

    const handleFinalDecision = async () => {
        const intDec = prompt("DECYZJA WEWNĘTRZNA (Kary finansowe):", selectedClaim?.decisionInternal || "");
        if (intDec === null) return;
        const warDec = prompt("DECYZJA DLA MAGAZYNU (Np. Złomuj):", selectedClaim?.decisionWarehouse || "");
        if (warDec === null) return;
        try {
            await updateDoc(doc(db, "claims", selectedClaim!.id), { decisionInternal: intDec, decisionWarehouse: warDec, status: "ZAMKNIETA" });
            alert("Sprawa zakończona!"); fetchData(); setSelectedClaim(null);
        } catch (e) { alert("Błąd zapisu: " + e); }
    };

    if (loading) return <div className="p-10 text-center animate-pulse text-slate-500 italic">Wczytywanie wokandy Sądu PESAM...</div>;

    return (
        <div className="p-6 md:p-10 max-w-7xl mx-auto h-[90vh] flex flex-col animate-fade-in">
            <div className="flex items-center gap-4 mb-6">
                <div className="text-4xl shadow-lg bg-white w-14 h-14 flex items-center justify-center rounded-full">⚖️</div>
                <div>
                    <h1 className="text-3xl font-black text-slate-800 tracking-tighter">Wewnętrzny Sąd PESAM</h1>
                    <p className="text-slate-500 text-sm font-medium italic">Sprawiedliwość i ewidencja szkód</p>
                </div>
            </div>

            <div className="flex-1 flex gap-6 overflow-hidden">
                {/* LISTA SPRAW */}
                <div className="w-1/3 bg-white rounded-3xl shadow-sm border border-slate-200 flex flex-col overflow-hidden">
                    <div className="p-5 border-b bg-slate-50 font-black text-slate-400 uppercase text-[10px] tracking-widest">Wokanda</div>
                    <div className="flex-1 overflow-y-auto p-4 space-y-3">
                        {claims.length === 0 && <p className="text-center text-slate-400 mt-10">Brak otwartych spraw.</p>}
                        {claims.map(claim => (
                            <div key={claim.id} onClick={() => setSelectedClaim(claim)} className={`p-4 border rounded-2xl cursor-pointer transition ${selectedClaim?.id === claim.id ? 'bg-blue-50 border-blue-400 shadow-md scale-[1.02]' : 'bg-white hover:border-slate-300 shadow-sm'}`}>
                                <div className="flex justify-between items-start mb-2"><span className="font-black text-slate-800 text-sm truncate">{claim.inventoryName}</span><span className={`text-[10px] px-2 py-0.5 rounded font-black uppercase ${claim.status === 'NOWA' ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'}`}>{claim.status}</span></div>
                                <p className="text-[10px] text-slate-500 font-mono">ID: {claim.claimId} • Budowa: {claim.siteName}</p>
                            </div>
                        ))}
                    </div>
                </div>

                {/* OBSZAR ROZPRAWY */}
                <div className="w-2/3 bg-white rounded-3xl shadow-sm border border-slate-200 flex flex-col overflow-hidden relative">
                    {!selectedClaim ? (
                        <div className="flex-1 flex flex-col items-center justify-center text-slate-400"><div className="text-6xl mb-4 opacity-20">🔨</div><p>Wybierz sprawę z wokandy.</p></div>
                    ) : (
                        <>
                            <div className="p-6 border-b bg-slate-50 shadow-sm z-10 flex justify-between items-center">
                                <div><h2 className="text-xl font-black text-slate-800 uppercase">{selectedClaim.inventoryName} (Nr: {selectedClaim.inventoryNumber})</h2><p className="text-sm font-bold text-red-600 mt-1">Zarzut: {selectedClaim.description}</p></div>
                                {canManageClaims && selectedClaim.status !== "ZAMKNIETA" && <button onClick={handleFinalDecision} className="bg-red-600 hover:bg-red-700 text-white font-black px-5 py-2.5 rounded-xl shadow-lg transition">Wydaj Wyrok</button>}
                            </div>

                            {/* PRZYPISANIE OSÓB */}
                            {canManageClaims && selectedClaim.assignedManagers.length === 0 && (
                                <div className="bg-orange-50 border-b border-orange-200 p-4 animate-pulse">
                                    <p className="text-xs font-black text-orange-800 mb-2 uppercase">🚨 Sprawa wymaga przypisania oskarżonego kierownika:</p>
                                    <select onChange={(e) => assignManagerAndStartInvestigation(e.target.value)} className="p-2.5 text-sm border border-orange-300 rounded-xl font-bold bg-white outline-none">
                                        <option value="">-- Wybierz kierownika do przesłuchania --</option>
                                        {managers.map(m => <option key={m.uid} value={m.uid}>{m.name}</option>)}
                                    </select>
                                </div>
                            )}

                            {/* KOMUNIKATOR */}
                            <div className="flex-1 p-6 overflow-y-auto bg-slate-50/50 space-y-4">
                                {selectedClaim.messages?.map(msg => {
                                    if (user?.roleId === "magazynier" && !msg.visibleToWarehouse) return null;
                                    const isMe = msg.senderId === user?.uid;
                                    return (
                                        <div key={msg.id} className={`flex flex-col ${isMe ? 'items-end' : 'items-start'}`}>
                                            <div className={`p-4 rounded-2xl shadow-sm max-w-[85%] ${isMe ? 'bg-blue-600 text-white rounded-br-sm' : msg.senderRole === 'AI' ? 'bg-purple-100 border border-purple-200 text-purple-900 rounded-bl-sm' : 'bg-white border border-slate-200 text-slate-800 rounded-bl-sm'}`}>
                                                <div className="flex justify-between gap-4 mb-1 opacity-60 font-black text-[9px] uppercase tracking-wider"><span>{msg.senderName}</span><span>{msg.senderRole}</span></div>
                                                <p className="text-sm whitespace-pre-wrap leading-relaxed">{msg.text}</p>
                                            </div>
                                        </div>
                                    );
                                })}
                                <div ref={chatEndRef} />
                            </div>

                            {/* WYROK (Dla zamkniętych spraw) */}
                            {selectedClaim.status === "ZAMKNIETA" && (
                                <div className="p-6 bg-slate-900 text-white">
                                    <h3 className="font-black text-red-500 text-lg mb-2">⚖️ ORZECZENIE SĄDU</h3>
                                    {canManageClaims && <p className="text-sm mb-2 text-slate-300 font-bold border-l-2 border-red-500 pl-4">Kary/Wnioski: {selectedClaim.decisionInternal}</p>}
                                    <p className="text-sm text-green-400 font-bold border-l-2 border-green-500 pl-4">Instrukcja dla Magazynu: {selectedClaim.decisionWarehouse}</p>
                                </div>
                            )}

                            {/* PANEL WPISYWANIA */}
                            {selectedClaim.status !== "ZAMKNIETA" && selectedClaim.assignedManagers.length > 0 && (
                                <div className="p-5 bg-white border-t border-slate-200">
                                    {canManageClaims && (
                                        <div className="flex justify-between items-center mb-3">
                                            <label className="flex items-center gap-2 cursor-pointer bg-slate-50 px-3 py-1.5 rounded-lg border"><input type="checkbox" checked={visibleToWarehouse} onChange={e => setVisibleToWarehouse(e.target.checked)} className="w-4 h-4 text-blue-600 rounded" /><span className="text-[10px] font-black text-slate-600 uppercase">Widoczne dla Magazynu</span></label>
                                            <button onClick={askAiForHelp} disabled={aiGenerating} className="text-xs font-black text-purple-700 bg-purple-100 hover:bg-purple-200 px-4 py-2 rounded-xl flex items-center gap-2 transition">
                                                {aiGenerating ? <div className="w-3 h-3 border-2 border-purple-700 border-t-transparent rounded-full animate-spin"></div> : '✨ Analiza AI'}
                                            </button>
                                        </div>
                                    )}
                                    <div className="flex gap-3">
                                        <textarea value={messageText} onChange={e => setMessageText(e.target.value)} placeholder={canManageClaims ? "Zadaj pytanie kierownikowi..." : "Złóż wyjaśnienia..."} className="flex-1 border border-slate-300 rounded-2xl p-4 text-sm outline-none focus:ring-2 focus:ring-blue-500 resize-none h-20 shadow-inner" />
                                        <button onClick={sendMessage} disabled={!messageText.trim() || isSending} className="bg-blue-600 hover:bg-blue-700 text-white font-black px-8 rounded-2xl shadow-lg transition disabled:opacity-50">{isSending ? '...' : 'Wyślij'}</button>
                                    </div>
                                </div>
                            )}
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}