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
    imageUrl?: string;
    imageUrls?: string[]; // DODANE
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

    const [activeTab, setActiveTab] = useState<"AKTYWNE" | "ARCHIWUM">("AKTYWNE");

    const [messageText, setMessageText] = useState("");
    const [visibleToWarehouse, setVisibleToWarehouse] = useState(false);
    const [isSending, setIsSending] = useState(false);

    // DORADCA AI
    const [aiGenerating, setAiGenerating] = useState(false);
    const [aiAdvice, setAiAdvice] = useState<string | null>(null);
    const [showAiDrawer, setShowAiDrawer] = useState(false);

    // MODAL WYROKU
    const [isVerdictModalOpen, setIsVerdictModalOpen] = useState(false);
    const [verdictData, setVerdictData] = useState({ internal: "", warehouse: "" });

    const canManageClaims = user ? hasPermission("manageClaims", user.rolePermissions, user.permissionOverrides) : false;
    const canViewAllClaims = user ? hasPermission("viewAllClaims", user.rolePermissions, user.permissionOverrides) : false;

    const chatRoleName = canManageClaims ? "DYREKCJA" : user?.roleId === "magazynier" ? "MAGAZYN" : "KIEROWNIK";

    const chatEndRef = useRef<HTMLDivElement>(null);

    const fetchData = async () => {
        setLoading(true);
        try {
            const q = query(collection(db, "claims"), orderBy("createdAt", "desc"));
            const snap = await getDocs(q);

            // ZABEZPIECZENIE: Wymuszamy tablice dla starszych dokumentów z bazy!
            let allClaims = snap.docs.map(d => {
                const data = d.data();
                return {
                    id: d.id,
                    ...data,
                    assignedManagers: data.assignedManagers || [],
                    messages: data.messages || []
                } as Claim;
            });

            if (!canViewAllClaims) {
                // Bezpieczne sprawdzanie (tablica na pewno istnieje)
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

    const assignManagerAndStartInvestigation = async (managerUid: string) => {
        if (!selectedClaim || !managerUid) return;
        setAiGenerating(true);

        try {
            const evidencePhotos = (selectedClaim.messages || [])
                .flatMap(msg => {
                    if (msg.imageUrls && msg.imageUrls.length > 0) return msg.imageUrls;
                    if (msg.imageUrl) return [msg.imageUrl]; // Kompatybilność dla starszych spraw
                    return [];
                });

            const response = await fetch('/api/claims-ai', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    inventoryName: selectedClaim.inventoryName,
                    inventoryNumber: selectedClaim.inventoryNumber,
                    siteName: selectedClaim.siteName,
                    warehouseSummary: selectedClaim.description,
                    evidencePhotos: evidencePhotos,
                    isInitial: true
                })
            });

            const data = await response.json();

            // 1. Zapisujemy sprawę jako W_TOKU i przypisujemy managera (BEZ DODAWANIA WIADOMOŚCI AI)
            const claimRef = doc(db, "claims", selectedClaim.id);
            await updateDoc(claimRef, {
                assignedManagers: arrayUnion(managerUid),
                status: "W_TOKU"
            });

            // 2. Aktualizujemy UI
            setSelectedClaim(prev => prev ? {
                ...prev,
                assignedManagers: [...(prev.assignedManagers || []), managerUid],
                status: "W_TOKU"
            } : null);

            // 3. Wrzucamy odpowiedź do Drawera i go otwieramy
            setAiAdvice(data.reply);
            setShowAiDrawer(true);

        } catch (e: any) {
            alert(`Błąd AI: ${e.message}`);
        } finally {
            setAiGenerating(false);
        }
    };

    const askAiForHelp = async () => {
        if (!selectedClaim) return;
        setAiGenerating(true);
        try {
            const response = await fetch('/api/claims-ai', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    inventoryName: selectedClaim.inventoryName,
                    messages: selectedClaim.messages,
                    warehouseSummary: selectedClaim.description
                })
            });
            const data = await response.json();
            if (response.ok) { setAiAdvice(data.reply); setShowAiDrawer(true); }
        } catch (error) { console.error(error); }
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
            setMessageText(""); setVisibleToWarehouse(false);
        } catch (e) { console.error(e); } finally { setIsSending(false); }
    };

    const handleVerdictSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!selectedClaim) return;

        try {
            await updateDoc(doc(db, "claims", selectedClaim.id), {
                decisionInternal: verdictData.internal,
                decisionWarehouse: verdictData.warehouse,
                status: "ZAMKNIETA"
            });
            alert("Wyrok został wydany. Sprawa została zamknięta.");
            setIsVerdictModalOpen(false);
            fetchData();
            setSelectedClaim(null); // Zamknięcie widoku po wydaniu wyroku
        } catch (e) { alert("Błąd zapisu wyroku."); }
    };

    if (loading) return <div className="p-10 text-center animate-pulse text-slate-500 italic">Wczytywanie wokandy...</div>;

    // Filtrowanie spraw na aktywne i zamknięte
    const activeClaims = claims.filter(c => c.status !== "ZAMKNIETA");
    const archivedClaims = claims.filter(c => c.status === "ZAMKNIETA");
    const displayedClaims = activeTab === "AKTYWNE" ? activeClaims : archivedClaims;

    return (
        <div className="p-6 md:p-10 max-w-7xl mx-auto h-[90vh] flex flex-col animate-fade-in relative">
            <div className="flex items-center gap-4 mb-6">
                <div className="text-4xl shadow-lg bg-white w-14 h-14 flex items-center justify-center rounded-full">⚖️</div>
                <div>
                    <h1 className="text-3xl font-black text-slate-800 tracking-tighter">Wewnętrzny Sąd PESAM</h1>
                    <p className="text-slate-500 text-sm font-medium italic">Centrum Likwidacji Szkód</p>
                </div>
            </div>

            <div className="flex-1 flex gap-6 overflow-hidden relative">
                {/* LISTA SPRAW */}
                <div className="w-1/3 bg-white rounded-3xl shadow-sm border border-slate-200 flex flex-col overflow-hidden font-sans">

                    {/* ZAKŁADKI */}
                    <div className="flex bg-slate-100 p-2 m-4 rounded-xl shadow-inner">
                        <button
                            onClick={() => { setActiveTab("AKTYWNE"); setSelectedClaim(null); }}
                            className={`flex-1 py-2 text-xs font-black uppercase tracking-widest rounded-lg transition ${activeTab === 'AKTYWNE' ? 'bg-white text-blue-600 shadow' : 'text-slate-500 hover:text-slate-700'}`}
                        >
                            Wokanda ({activeClaims.length})
                        </button>
                        <button
                            onClick={() => { setActiveTab("ARCHIWUM"); setSelectedClaim(null); }}
                            className={`flex-1 py-2 text-xs font-black uppercase tracking-widest rounded-lg transition ${activeTab === 'ARCHIWUM' ? 'bg-white text-slate-800 shadow' : 'text-slate-500 hover:text-slate-700'}`}
                        >
                            Archiwum ({archivedClaims.length})
                        </button>
                    </div>

                    <div className="flex-1 overflow-y-auto p-4 space-y-3 pt-0">
                        {displayedClaims.length === 0 && (
                            <p className="text-center text-slate-400 mt-10 text-sm italic">
                                {activeTab === "AKTYWNE" ? "Brak aktywnych spraw." : "Brak zamkniętych spraw."}
                            </p>
                        )}
                        {displayedClaims.map(claim => (
                            <div key={claim.id} onClick={() => { setSelectedClaim(claim); setShowAiDrawer(false); }} className={`p-4 border rounded-2xl cursor-pointer transition ${selectedClaim?.id === claim.id ? 'bg-blue-50 border-blue-400 shadow-md scale-[1.02]' : 'bg-white hover:border-slate-300 shadow-sm'}`}>
                                <div className="flex justify-between items-start mb-2">
                                    <span className="font-black text-slate-800 text-sm truncate">{claim.inventoryName}</span>
                                    <span className={`text-[10px] px-2 py-0.5 rounded font-black uppercase ${claim.status === 'NOWA' ? 'bg-red-100 text-red-700' : claim.status === 'W_TOKU' ? 'bg-orange-100 text-orange-700' : 'bg-slate-200 text-slate-600'}`}>{claim.status === "ZAMKNIETA" ? "ZAMKNIĘTA" : claim.status}</span>
                                </div>
                                <p className="text-[10px] text-slate-500 font-mono italic">ID: {claim.claimId} • {claim.siteName}</p>
                            </div>
                        ))}
                    </div>
                </div>

                {/* OBSZAR ROZPRAWY */}
                <div className="w-2/3 bg-white rounded-3xl shadow-sm border border-slate-200 flex flex-col overflow-hidden relative">
                    {!selectedClaim ? (
                        <div className="flex-1 flex flex-col items-center justify-center text-slate-400">
                            <div className="text-6xl mb-4 opacity-20">🔨</div>
                            <p>Wybierz sprawę z listy po lewej stronie.</p>
                        </div>
                    ) : (
                        <>
                            {/* BOCZNY PANEL AI (DRAWER) - ZAKTUALIZOWANY WIDOK LISTY PYTAŃ */}
                            <div className={`absolute top-0 right-0 h-full w-80 bg-slate-900 text-white z-30 shadow-2xl transition-transform duration-300 transform ${showAiDrawer ? 'translate-x-0' : 'translate-x-full'}`}>
                                <div className="p-6 h-full flex flex-col">
                                    <div className="flex justify-between items-center mb-6">
                                        <h3 className="text-purple-400 font-black uppercase text-xs tracking-widest">✨ Podpowiedź AI</h3>
                                        <button onClick={() => setShowAiDrawer(false)} className="text-slate-400 hover:text-white">✕</button>
                                    </div>

                                    <div className="flex-1 overflow-y-auto text-sm leading-relaxed text-slate-300">
                                        {aiAdvice ? (
                                            <div className="space-y-2">
                                                {aiAdvice.split('\n').filter(q => q.trim() !== "").map((question, i) => (
                                                    <button
                                                        key={i}
                                                        onClick={() => {
                                                            const cleanQuestion = question.replace(/^\d+\.\s*/, '').replace(/^-\s*/, '');

                                                            // Używamy funkcji callback w setMessageText, aby DOKLEIĆ tekst, a nie go nadpisać
                                                            setMessageText(prev => {
                                                                const currentText = prev.trim();
                                                                // Jeśli pole jest puste, wstawiamy samo pytanie. 
                                                                // Jeśli coś tam już jest, dodajemy nową linię, myślnik i kolejne pytanie.
                                                                return currentText ? `${currentText}\n- ${cleanQuestion}` : `- ${cleanQuestion}`;
                                                            });

                                                            // USUNĘLIŚMY setShowAiDrawer(false); - dzięki temu panel zostaje otwarty!
                                                        }}
                                                        className="w-full text-left p-3 bg-slate-800 hover:bg-purple-900 rounded-xl border border-slate-700 hover:border-purple-500 text-sm text-slate-200 transition shadow-sm group"
                                                    >
                                                        <span className="text-purple-400 font-bold mr-2 opacity-50 group-hover:opacity-100 transition">✦</span>
                                                        {question}
                                                    </button>
                                                ))}
                                                <p className="text-[10px] text-slate-500 mt-4 text-center italic">Kliknij wybrane pytanie, aby użyć go w czacie.</p>
                                            </div>
                                        ) : (
                                            <div className="flex flex-col items-center justify-center h-full text-slate-500 opacity-50">
                                                <div className="w-8 h-8 border-4 border-purple-500 border-t-transparent rounded-full animate-spin mb-4"></div>
                                                Analizuję akta sprawy...
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>

                            <div className="p-6 border-b bg-slate-50 shadow-sm z-10 flex justify-between items-center">
                                <div>
                                    <h2 className="text-xl font-black text-slate-800 uppercase">{selectedClaim.inventoryName} (Nr: {selectedClaim.inventoryNumber})</h2>
                                    <p className="text-sm font-bold text-red-600 mt-1">Zarzut: {selectedClaim.description}</p>
                                </div>
                                {canManageClaims && selectedClaim.status !== "ZAMKNIETA" && (
                                    <button onClick={() => { setVerdictData({ internal: "", warehouse: "" }); setIsVerdictModalOpen(true); }} className="bg-red-600 hover:bg-red-700 text-white font-black px-5 py-2.5 rounded-xl shadow-lg transition">Wydaj Wyrok</button>
                                )}
                            </div>

                            {/* 1. SEKCJA PRZYPISYWANIA KIEROWNIKA ZE WSKAŹNIKIEM PRACY AI */}
                            {canManageClaims && (selectedClaim.assignedManagers || []).length === 0 && selectedClaim.status !== "ZAMKNIETA" && (
                                <div className="bg-orange-50 border-b border-orange-200 p-4">
                                    <p className="text-xs font-black text-orange-800 mb-2 uppercase tracking-widest">🚨 Sprawa wymaga przypisania kierownika:</p>
                                    <div className="flex items-center gap-4">
                                        <select
                                            disabled={aiGenerating}
                                            onChange={(e) => assignManagerAndStartInvestigation(e.target.value)}
                                            className="p-2.5 text-sm border border-orange-300 rounded-xl font-bold bg-white outline-none focus:ring-2 focus:ring-orange-500 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
                                        >
                                            <option value="">-- Wybierz kierownika do przesłuchania --</option>
                                            {managers.map(m => <option key={m.uid} value={m.uid}>{m.name}</option>)}
                                        </select>

                                        {/* Wizualny feedback, że system "myśli" */}
                                        {aiGenerating && (
                                            <div className="flex items-center gap-3 text-orange-700 animate-pulse">
                                                <div className="w-5 h-5 border-3 border-orange-600 border-t-transparent rounded-full animate-spin"></div>
                                                <span className="text-[11px] font-black uppercase tracking-tighter">Asystent analizuje dowody i przygotowuje pytania...</span>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            )}

                            {/* 2. OBSZAR ROZPRAWY (CZAT) Z OBSŁUGĄ DOWODÓW FOTOGRAFICZNYCH */}
                            <div className="flex-1 p-6 overflow-y-auto bg-slate-50/50 space-y-4">
                                {(selectedClaim.messages || []).map((msg) => {
                                    // 1. Filtr widoczności dla magazyniera
                                    if (user?.roleId === "magazynier" && !msg.visibleToWarehouse) return null;

                                    const isMe = msg.senderId === user?.uid;

                                    // 2. Obsługa technicznych odpowiedzi JSON od AI (żeby nie straszyły użytkownika)
                                    const isJson = msg.text?.trim().startsWith('{') && msg.text?.trim().endsWith('}');
                                    const displayText = isJson ? "Asystent przetworzył dane techniczne i wygenerował raport." : msg.text;

                                    return (
                                        <div key={msg.id} className={`flex flex-col ${isMe ? 'items-end' : 'items-start'}`}>
                                            <div className={`p-4 rounded-2xl shadow-sm max-w-[85%] ${isMe
                                                ? 'bg-blue-600 text-white rounded-br-sm'
                                                : msg.senderRole === 'AI'
                                                    ? 'bg-purple-100 border border-purple-200 text-purple-900 rounded-bl-sm'
                                                    : 'bg-white border border-slate-200 text-slate-800 rounded-bl-sm'
                                                }`}>

                                                {/* Nagłówek: Nazwa nadawcy i Rola */}
                                                <div className="flex justify-between gap-4 mb-2 opacity-60 font-black text-[9px] uppercase tracking-wider border-b border-black/5 pb-1">
                                                    <span>{msg.senderName}</span>
                                                    <span>{msg.senderRole}</span>
                                                </div>

                                                {/* WYŚWIETLANIE DOWODÓW (ZDJĘĆ) - Obsługa wielu zdjęć */}
                                                {(msg.imageUrls?.length ? msg.imageUrls : (msg.imageUrl ? [msg.imageUrl] : [])).map((url, idx) => (
                                                    <div key={idx} className="mb-3 mt-1 rounded-xl overflow-hidden border border-black/10 shadow-lg bg-black/5 group cursor-zoom-in relative">
                                                        <img
                                                            src={url}
                                                            alt={`Zabezpieczony dowód w sprawie ${idx + 1}`}
                                                            className="max-h-80 w-full object-contain hover:scale-105 transition-transform duration-300"
                                                            onClick={() => window.open(url, '_blank')}
                                                        />
                                                        <div className="absolute top-2 right-2 bg-black/50 text-white text-[8px] px-2 py-1 rounded-full opacity-0 group-hover:opacity-100 transition-opacity">
                                                            Powiększ dowód nr {idx + 1}
                                                        </div>
                                                    </div>
                                                ))}

                                                {/* Treść wiadomości */}
                                                <p className="text-sm whitespace-pre-wrap leading-relaxed">
                                                    {displayText}
                                                </p>

                                                {/* Data/Godzina (Opcjonalnie dla profesjonalnego wyglądu akt) */}
                                                <p className={`text-[8px] mt-2 opacity-40 ${isMe ? 'text-right' : 'text-left'}`}>
                                                    {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                                </p>
                                            </div>
                                        </div>
                                    );
                                })}

                                {/* Punkt kotwiczenia dla automatycznego przewijania w dół */}
                                <div ref={chatEndRef} />
                            </div>

                            {/* WYNIK SPRAWY - WIDOK FINALNY */}
                            {selectedClaim.status === "ZAMKNIETA" && (
                                <div className="p-8 bg-slate-900 text-white border-t-4 border-slate-600">
                                    <h3 className="font-black text-slate-400 text-xl mb-4 tracking-tighter uppercase">📁 ZARCHIWIZOWANE ORZECZENIE SĄDU</h3>
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                                        <div className="bg-slate-800 p-6 rounded-2xl border border-slate-700 shadow-inner">
                                            <h4 className="text-xs font-black text-slate-400 uppercase tracking-widest mb-3 italic">Decyzja Wewnętrzna / Kadrowa</h4>
                                            <p className="text-sm text-slate-200 leading-relaxed">{selectedClaim.decisionInternal || "Brak danych."}</p>
                                        </div>
                                        <div className="bg-slate-800 p-6 rounded-2xl border border-slate-700 shadow-inner">
                                            <h4 className="text-xs font-black text-slate-400 uppercase tracking-widest mb-3 italic">Wytyczne dla Magazynu</h4>
                                            <p className="text-sm text-slate-200 leading-relaxed">{selectedClaim.decisionWarehouse || "Brak danych."}</p>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {/* ZABEZPIECZENIE: Operator || [] dla pewności */}
                            {selectedClaim.status !== "ZAMKNIETA" && (selectedClaim.assignedManagers || []).length > 0 && (
                                <div className="p-5 bg-white border-t border-slate-200">
                                    {canManageClaims && (
                                        <div className="flex justify-between items-center mb-3">
                                            <label className="flex items-center gap-2 cursor-pointer bg-slate-50 px-3 py-1.5 rounded-lg border">
                                                <input type="checkbox" checked={visibleToWarehouse} onChange={e => setVisibleToWarehouse(e.target.checked)} className="w-4 h-4 text-blue-600 rounded" />
                                                <span className="text-[10px] font-black text-slate-600 uppercase">Widoczne dla Magazynu</span>
                                            </label>
                                            <button onClick={askAiForHelp} disabled={aiGenerating} className={`text-xs font-black px-4 py-2 rounded-xl flex items-center gap-2 transition ${showAiDrawer ? 'bg-purple-600 text-white shadow-inner' : 'text-purple-700 bg-purple-100 hover:bg-purple-200'}`}>
                                                {aiGenerating ? <div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin"></div> : '✨ Analiza AI'}
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

            {/* MODAL WYDAWANIA WYROKU */}
            {isVerdictModalOpen && selectedClaim && (
                <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
                    <div className="bg-white rounded-3xl shadow-2xl w-full max-w-2xl overflow-hidden animate-fade-in border-4 border-red-600">
                        <div className="p-6 bg-red-600 text-white flex justify-between items-center">
                            <h2 className="text-2xl font-black uppercase tracking-tighter">Wydawanie Wyroku: {selectedClaim.inventoryName}</h2>
                            <button onClick={() => setIsVerdictModalOpen(false)} className="text-white opacity-60 hover:opacity-100">✕</button>
                        </div>

                        <form onSubmit={handleVerdictSubmit} className="p-8 space-y-6">
                            <div>
                                <label className="block text-xs font-black text-slate-400 uppercase tracking-widest mb-3 italic">1. Decyzja Kadrowo-Finansowa (Widzi tylko Zarząd i Kierownik)</label>
                                <textarea
                                    required
                                    rows={4}
                                    placeholder="Np. Obciążyć kosztami naprawy w 50% pracownika Jana Kowalskiego. Naganę wpisać do akt."
                                    value={verdictData.internal}
                                    onChange={e => setVerdictData({ ...verdictData, internal: e.target.value })}
                                    className="w-full p-4 border-2 border-slate-200 rounded-2xl outline-none focus:border-red-500 text-sm transition-all"
                                />
                            </div>

                            <div>
                                <label className="block text-xs font-black text-slate-400 uppercase tracking-widest mb-3 italic">2. Wytyczne dla Magazynu (Widoczne dla magazynierów)</label>
                                <textarea
                                    required
                                    rows={4}
                                    placeholder="Np. Sprzęt nie nadaje się do naprawy. Złomować natychmiast. Zamówić nowy egzemplarz modelu Hilti."
                                    value={verdictData.warehouse}
                                    onChange={e => setVerdictData({ ...verdictData, warehouse: e.target.value })}
                                    className="w-full p-4 border-2 border-slate-200 rounded-2xl outline-none focus:border-blue-500 text-sm transition-all"
                                />
                            </div>

                            <div className="flex gap-4 pt-4">
                                <button type="button" onClick={() => setIsVerdictModalOpen(false)} className="flex-1 py-4 bg-slate-100 text-slate-600 font-bold rounded-2xl hover:bg-slate-200 transition">Anuluj</button>
                                <button type="submit" className="flex-1 py-4 bg-red-600 text-white font-black rounded-2xl shadow-xl hover:bg-red-700 transition uppercase tracking-widest">Podpisz i ogłoś wyrok</button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
}