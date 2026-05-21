// src/app/(dashboard)/dashboard/claims/page.tsx
"use client";

import { useState, useEffect, useRef } from "react";
import { collection, getDocs, doc, updateDoc, arrayUnion, query, orderBy, where, limit } from "firebase/firestore";
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
    imageUrls?: string[];
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
    evidencePhotos?: string[]; // Wszystkie zdjęcia dowodowe z całej sprawy
    aiReport?: string; // Oficjalny raport z przesłuchania Kierownika
    decisionInternal?: string;
    decisionWarehouse?: string;
}

// Sztywne pytania awaryjne dla Kierownika (Fail-safe)
const BACKUP_QUESTIONS = [
    "W jakich dokładnie okolicznościach doszło do uszkodzenia tego sprzętu na budowie i kto na nim wtedy pracował?",
    "Czy sprzęt był używany zgodnie z przeznaczeniem i instrukcją obsługi?",
    "Czy na budowie były podejmowane jakiekolwiek próby samodzielnej naprawy lub rozkręcania urządzenia?",
    "Czy przed wystąpieniem usterki były jakieś sygnały ostrzegawcze (np. przegrzewanie się, spadek mocy)?"
];

// ─── POMOCNICZA FUNKCJA FETCH Z LIMITU CZASOWEGO 60 SEKUND (DLA SĄDU) ───
const fetchWithTimeout = async (resource: string, options: RequestInit & { timeout?: number } = {}) => {
    const { timeout = 60000 } = options;
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(resource, {
            ...options,
            signal: controller.signal
        });
        clearTimeout(id);
        return response;
    } catch (error) {
        clearTimeout(id);
        throw error;
    }
};

export default function ClaimsCenter() {
    const { user } = useAuth();
    const [claims, setClaims] = useState<Claim[]>([]);
    const [selectedClaim, setSelectedClaim] = useState<Claim | null>(null);
    const [loading, setLoading] = useState(true);

    const [activeTab, setActiveTab] = useState<"AKTYWNE" | "ARCHIWUM">("AKTYWNE");
    const [messageText, setMessageText] = useState("");
    const [isSending, setIsSending] = useState(false);

    // KIEROWNIK CHAT Z AI
    const [aiMessages, setAiMessages] = useState<any[]>([]);
    const [aiLoading, setAiLoading] = useState(false);
    const [daysOnSite, setDaysOnSite] = useState<number | null>(null);

    // TRYB AWARYJNY (FAIL-SAFE)
    const [backupStep, setBackupStep] = useState<number | null>(null);
    const [backupAnswers, setBackupAnswers] = useState<string[]>([]);

    // MODALE (SZEF)
    const [isVerdictModalOpen, setIsVerdictModalOpen] = useState(false);
    const [isHistoryModalOpen, setIsHistoryModalOpen] = useState(false); // MODAL PEŁNYCH AKT ŚLEDZTWA
    const [verdictData, setVerdictData] = useState({ internal: "", warehouse: "" });

    const chatEndRef = useRef<HTMLDivElement>(null);

    const fetchData = async () => {
        if (!user) return;
        setLoading(true);
        try {
            const q = query(collection(db, "claims"), orderBy("createdAt", "desc"));
            const snap = await getDocs(q);

            let allClaims = snap.docs.map(d => {
                const data = d.data();
                return {
                    id: d.id,
                    ...data,
                    assignedManagers: data.assignedManagers || [],
                    messages: data.messages || []
                } as Claim;
            });

            // Zabezpieczenie widoczności: Kierownik widzi tylko swoje sprawy
            if (!canViewAllClaims) {
                allClaims = allClaims.filter(c => c.assignedManagers.includes(user.uid) || c.reportedBy === user.uid);
            }
            setClaims(allClaims);
        } catch (error) { console.error("Błąd pobierania:", error); } finally { setLoading(false); }
    };

    useEffect(() => { if (user) fetchData(); }, [user]);
    useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [selectedClaim?.messages, aiMessages]);

    // --- ZABEZPIECZENIE I WALIDACJA REAC-HOOKS (EARLY RETURN) ---
    if (!user) return <div className="p-10 text-center animate-pulse text-slate-500 italic">Ładowanie profilu użytkownika...</div>;

    const canManageClaims = hasPermission("manageClaims", user.rolePermissions, user.permissionOverrides);
    const canViewAllClaims = hasPermission("viewAllClaims", user.rolePermissions, user.permissionOverrides);

    const chatRoleName = canManageClaims ? "DYREKCJA" : user.roleId === "magazynier" ? "MAGAZYN" : "KIEROWNIK";

    // OBLICZANIE ILE DNI SPRZĘT BYŁ NA BUDOWIE
    const calculateDaysOnSite = async (claim: Claim) => {
        try {
            const q = query(collection(db, "protocols"), where("type", "==", "WYDANIE"), orderBy("createdAt", "desc"), limit(30));
            const snap = await getDocs(q);
            for (const d of snap.docs) {
                const p = d.data();
                const hasItem = p.items?.some((i: any) => i.inventoryId === claim.inventoryId);
                if (hasItem && p.destinationName === claim.siteName) {
                    const issueDate = new Date(p.createdAt);
                    const currentDate = new Date(claim.createdAt);
                    const diffTime = Math.abs(currentDate.getTime() - issueDate.getTime());
                    return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
                }
            }
        } catch (e) { console.error("Błąd obliczania dni:", e); }
        return null;
    };

    const handleSelectClaim = async (claim: Claim) => {
        setSelectedClaim(claim);
        setAiMessages([]);
        setBackupStep(null);
        setBackupAnswers([]);

        const isMyInvestigation = claim.status === "NOWA" && claim.assignedManagers.includes(user.uid);

        if (isMyInvestigation) {
            setAiLoading(true);
            const days = await calculateDaysOnSite(claim);
            setDaysOnSite(days);

            try {
                const res = await fetchWithTimeout("/api/claims-ai-investigate", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        inventoryName: claim.inventoryName,
                        inventoryNumber: claim.inventoryNumber,
                        siteName: claim.siteName,
                        warehouseNotes: claim.description,
                        declaredStatus: "uszkodzone",
                        daysOnSite: days,
                        isInitial: true,
                        role: "KIEROWNIK"
                    }),
                    timeout: 60000
                });

                if (res.ok) {
                    const data = await res.json();
                    setAiMessages([{ role: "assistant", content: data.reply }]);
                } else {
                    throw new Error("AI Offline");
                }
            } catch (err) {
                setBackupStep(0);
                setAiMessages([{ role: "assistant", content: `[TRYB AWARYJNY SĘDZIEGO] Witaj Kierowniku. Serwer AI jest chwilowo przeciążony. Przeprowadzę z Tobą uproszczone przesłuchanie techniczne.\n\nPytanie 1: ${BACKUP_QUESTIONS[0]}` }]);
            } finally {
                setAiLoading(false);
            }
        }
    };

    // WYSYŁANIE WIADOMOŚCI W WYWIADZIE KIEROWNIK ➔ AI
    const handleSendToAi = async () => {
        if (!messageText.trim() || !selectedClaim) return;
        setAiLoading(true);

        const updatedMessages = [...aiMessages, { role: "user", content: messageText }];
        setAiMessages(updatedMessages);
        const userAnsw = messageText;
        setMessageText("");

        if (backupStep !== null) {
            // TRYB AWARYJNY (FAIL-SAFE)
            const currentAnswers = [...backupAnswers, userAnsw];
            setBackupAnswers(currentAnswers);

            const nextStep = backupStep + 1;
            if (nextStep < BACKUP_QUESTIONS.length) {
                setBackupStep(nextStep);
                setAiMessages([...updatedMessages, { role: "assistant", content: `Pytanie ${nextStep + 1}: ${BACKUP_QUESTIONS[nextStep]}` }]);
                setAiLoading(false);
            } else {
                const manualReport = `RAPORT KOŃCOWY SĘDZIEGO (TRYB AWARYJNY):\nUrządzenie: ${selectedClaim.inventoryName}\nBudowa: ${selectedClaim.siteName}\nUstalenia z Kierownikiem:\n- Okoliczności awarii: ${currentAnswers[0]}\n- Zgodność z instrukcją: ${currentAnswers[1]}\n- Próby naprawy: ${currentAnswers[2]}\n- Sygnały przed usterką: ${currentAnswers[3]}`;
                await finalizeInvestigation(manualReport, updatedMessages);
            }
        } else {
            // STANDARDOWY PROCES GEMINI AI
            try {
                const res = await fetchWithTimeout("/api/claims-ai-investigate", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        inventoryName: selectedClaim.inventoryName,
                        inventoryNumber: selectedClaim.inventoryNumber,
                        siteName: selectedClaim.siteName,
                        warehouseNotes: selectedClaim.description,
                        daysOnSite,
                        messages: updatedMessages,
                        isInitial: false,
                        role: "KIEROWNIK"
                    }),
                    timeout: 60000
                });

                if (res.ok) {
                    const data = await res.json();
                    const newAiMsg = { role: "assistant", content: data.reply };
                    setAiMessages([...updatedMessages, newAiMsg]);

                    if (data.isComplete) {
                        await finalizeInvestigation(data.caseContext, [...updatedMessages, newAiMsg]);
                    }
                } else {
                    throw new Error("AI Offline");
                }
            } catch (err) {
                let startingStep = 0;
                if (updatedMessages.length >= 5) {
                    startingStep = 3;
                } else if (updatedMessages.length >= 3) {
                    startingStep = 2;
                } else if (updatedMessages.length >= 1) {
                    startingStep = 1;
                }

                setBackupStep(startingStep);
                const fallbackQ = BACKUP_QUESTIONS[startingStep];

                setAiMessages([...updatedMessages, { role: "assistant", content: `⚠️ Serwer AI przestał odpowiadać. Przełączam na tryb awaryjny.\n\nPytanie: ${fallbackQ}` }]);
            } finally {
                setAiLoading(false);
            }
        }
    };

    // ZAKOŃCZENIE WYWIADU, POŁĄCZENIE OBU HISTORII (MERGE) I PRZEKAZANIE DO SZEFA (W_TOKU)
    const finalizeInvestigation = async (reportText: string, chatHistory: any[]) => {
        if (!selectedClaim) return;
        try {
            // Pobieramy dotychczasowe wiadomości w sprawie (czyli rozmowę Magazyniera + Zdjęcia!)
            const existingMessages = selectedClaim.messages || [];

            // Konwertujemy nową historię chatu z Kierownikiem na format czatu
            const formattedKierownikMessages: ChatMessage[] = chatHistory.map((m, idx) => ({
                id: `${Date.now()}-kierownik-${idx}`,
                senderId: m.role === "user" ? user.uid : "AI_SYSTEM",
                senderName: m.role === "user" ? `${user.firstName} ${user.lastName}` : "Sędzia AI CLS",
                senderRole: m.role === "user" ? "KIEROWNIK" : "AI",
                text: m.content,
                timestamp: new Date().toISOString(),
                visibleToWarehouse: true
            }));

            // --- NAJWAŻNIEJSZE: Łączymy obie rozmowy chronologicznie w jedną całość! ---
            const finalMergedMessages = [...existingMessages, ...formattedKierownikMessages];

            await updateDoc(doc(db, "claims", selectedClaim.id), {
                status: "W_TOKU",
                aiReport: reportText,
                messages: finalMergedMessages // Zapisujemy połączoną historię!
            });

            alert("🎉 Przesłuchanie zakończone! Raport oraz pełne zeznania zostały połączone i wysłane do Zarządu.");
            setSelectedClaim(null);
            fetchData();
        } catch (e) {
            alert("Błąd podczas kończenia przesłuchania i łączenia akt.");
        }
    };

    // TRADYCYJNY CZAT DYREKCJA ➔ KIEROWNIK (DLA SPRAW W_TOKU)
    const sendRegularMessage = async () => {
        if (!messageText.trim() || !selectedClaim) return;
        setIsSending(true);
        const newMsg: ChatMessage = {
            id: Date.now().toString(),
            senderId: user.uid,
            senderName: `${user.firstName} ${user.lastName}`,
            senderRole: canManageClaims ? "DYREKCJA" : "KIEROWNIK",
            text: messageText,
            timestamp: new Date().toISOString(),
            visibleToWarehouse: true
        };
        try {
            await updateDoc(doc(db, "claims", selectedClaim.id), { messages: arrayUnion(newMsg) });
            setSelectedClaim({ ...selectedClaim, messages: [...(selectedClaim.messages || []), newMsg] });
            setMessageText("");
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
            alert("Wyrok został ogłoszony. Sprawa zamknięta i zarchiwizowana.");
            setIsVerdictModalOpen(false);
            fetchData();
            setSelectedClaim(null);
        } catch (e) { alert("Błąd zapisu wyroku."); }
    };

    if (loading) return <div className="p-10 text-center animate-pulse text-slate-500 italic">Otwieranie drzwi sali rozpraw...</div>;

    const activeClaims = claims.filter(c => c.status !== "ZAMKNIETA");
    const archivedClaims = claims.filter(c => c.status === "ZAMKNIETA");
    const displayedClaims = activeTab === "AKTYWNE" ? activeClaims : archivedClaims;

    return (
        <div className="p-6 md:p-10 max-w-7xl mx-auto h-[90vh] flex flex-col animate-fade-in relative">
            <div className="flex items-center gap-4 mb-6">
                <div className="text-4xl shadow-lg bg-white w-14 h-14 flex items-center justify-center rounded-full">⚖️</div>
                <div>
                    <h1 className="text-3xl font-black text-slate-800 tracking-tighter">Sąd PESAM (CLS)</h1>
                    <p className="text-slate-500 text-sm font-medium italic">Wydział orzekania o szkodach sprzętowych</p>
                </div>
            </div>

            <div className="flex-1 flex gap-6 overflow-hidden relative">
                {/* 1. LISTA SPRAW */}
                <div className="w-1/3 bg-white rounded-3xl shadow-sm border border-slate-200 flex flex-col overflow-hidden font-sans">
                    <div className="flex bg-slate-100 p-2 m-4 rounded-xl shadow-inner">
                        <button onClick={() => { setActiveTab("AKTYWNE"); setSelectedClaim(null); }} className={`flex-1 py-2 text-xs font-black uppercase tracking-widest rounded-lg transition ${activeTab === 'AKTYWNE' ? 'bg-white text-blue-600 shadow' : 'text-slate-500'}`}>Wokanda ({activeClaims.length})</button>
                        <button onClick={() => { setActiveTab("ARCHIWUM"); setSelectedClaim(null); }} className={`flex-1 py-2 text-xs font-black uppercase tracking-widest rounded-lg transition ${activeTab === 'ARCHIWUM' ? 'bg-white text-slate-800 shadow' : 'text-slate-500'}`}>Archiwum ({archivedClaims.length})</button>
                    </div>

                    <div className="flex-1 overflow-y-auto p-4 space-y-3 pt-0">
                        {displayedClaims.length === 0 && <p className="text-center text-slate-400 mt-10 text-sm italic">Brak spraw.</p>}
                        {displayedClaims.map(claim => (
                            <div key={claim.id} onClick={() => handleSelectClaim(claim)} className={`p-4 border rounded-2xl cursor-pointer transition ${selectedClaim?.id === claim.id ? 'bg-blue-50 border-blue-400 shadow-md scale-[1.02]' : 'bg-white hover:border-slate-300 shadow-sm'}`}>
                                <div className="flex justify-between items-start mb-2">
                                    <span className="font-black text-slate-800 text-sm truncate">{claim.inventoryName}</span>
                                    <span className={`text-[10px] px-2 py-0.5 rounded font-black uppercase ${claim.status === 'NOWA' ? 'bg-red-500 text-white animate-pulse' : claim.status === 'W_TOKU' ? 'bg-orange-100 text-orange-700' : 'bg-slate-200 text-slate-600'}`}>{claim.status === "ZAMKNIETA" ? "ZAMKNIĘTA" : claim.status === "NOWA" ? "WYJAŚNIANIE" : claim.status}</span>
                                </div>
                                <p className="text-[10px] text-slate-500 font-mono italic">ID: {claim.claimId} • {claim.siteName}</p>
                            </div>
                        ))}
                    </div>
                </div>

                {/* 2. OBSZAR ROZPRAWY */}
                <div className="w-2/3 bg-white rounded-3xl shadow-sm border border-slate-200 flex flex-col overflow-hidden relative">
                    {!selectedClaim ? (
                        <div className="flex-1 flex flex-col items-center justify-center text-slate-400">
                            <div className="text-6xl mb-4 opacity-20">🔨</div>
                            <p>Wybierz sprawę, aby otworzyć akta.</p>
                        </div>
                    ) : (
                        <>
                            <div className="p-6 border-b bg-slate-50 shadow-sm z-10 flex justify-between items-center">
                                <div>
                                    <h2 className="text-xl font-black text-slate-800 uppercase">{selectedClaim.inventoryName} (Nr: {selectedClaim.inventoryNumber})</h2>
                                    <p className="text-xs font-bold text-red-600 mt-1">Zgłoszenie usterki: {selectedClaim.description}</p>
                                </div>

                                {/* NAGŁÓWEK AKCJI SZEFA: WYDAJ WYROK + ZOBACZ PRZEBIEG ŚLEDZTWA */}
                                {selectedClaim.status === "W_TOKU" && (
                                    <div className="flex gap-2">
                                        <button
                                            onClick={() => setIsHistoryModalOpen(true)}
                                            className="bg-purple-100 hover:bg-purple-200 text-purple-800 font-black px-4 py-2.5 rounded-xl border border-purple-200 text-xs shadow-sm transition"
                                        >
                                            📄 Zobacz Przebieg Śledztwa
                                        </button>
                                        {canManageClaims && (
                                            <button
                                                onClick={() => { setVerdictData({ internal: "", warehouse: "" }); setIsVerdictModalOpen(true); }}
                                                className="bg-red-600 hover:bg-red-700 text-white font-black px-5 py-2.5 rounded-xl shadow-lg transition text-xs"
                                            >
                                                Wydaj Wyrok
                                            </button>
                                        )}
                                    </div>
                                )}
                            </div>

                            {/* SCENARIUSZ A: PRZESŁUCHANIE KIEROWNIKA PRZEZ AI (STATUS NOWA) */}
                            {selectedClaim.status === "NOWA" && selectedClaim.assignedManagers.includes(user.uid) && (
                                <div className="flex-1 flex flex-col overflow-hidden bg-slate-900 text-slate-100">
                                    <div className="p-4 bg-slate-950 border-b border-slate-800 flex justify-between items-center">
                                        <span className="text-[10px] font-black text-purple-400 uppercase tracking-widest animate-pulse">✨ Wstępne przesłuchanie techniczne prowadzone przez AI</span>
                                        {daysOnSite && <span className="text-[10px] font-bold text-slate-400 font-mono">Sprzęt był na budowie: {daysOnSite} dni</span>}
                                    </div>

                                    {/* Czat z AI */}
                                    <div className="flex-1 p-6 overflow-y-auto space-y-4">
                                        {aiMessages.map((msg, i) => (
                                            <div key={i} className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
                                                <div className={`p-4 rounded-2xl max-w-[85%] text-sm leading-relaxed ${msg.role === 'user' ? 'bg-purple-600 text-white' : 'bg-slate-800 text-slate-100 border border-slate-700'}`}>
                                                    <p className="text-[9px] uppercase tracking-widest font-black opacity-40 mb-1">{msg.role === 'user' ? 'Kierownik' : 'Sędzia AI PESAM'}</p>
                                                    <p className="whitespace-pre-wrap">{msg.content}</p>
                                                </div>
                                            </div>
                                        ))}
                                        <div ref={chatEndRef} />
                                    </div>

                                    {/* Stopka wpisywania dla AI */}
                                    <div className="p-4 bg-slate-950 border-t border-slate-800 flex gap-3 items-center">
                                        <input
                                            type="text"
                                            disabled={aiLoading}
                                            value={messageText}
                                            onChange={e => setMessageText(e.target.value)}
                                            onKeyDown={e => e.key === "Enter" && handleSendToAi()}
                                            placeholder={aiLoading ? "System analizuje Twoją odpowiedź..." : "Wpisz swoje wyjaśnienia i kliknij Enter..."}
                                            className="flex-1 p-3.5 bg-slate-900 border border-slate-800 rounded-xl text-sm outline-none focus:border-purple-500 text-white placeholder-slate-500 font-medium"
                                        />
                                        <button
                                            onClick={handleSendToAi}
                                            disabled={aiLoading || !messageText.trim()}
                                            className="bg-purple-600 hover:bg-purple-700 text-white font-black px-6 py-3.5 rounded-xl transition disabled:opacity-50"
                                        >
                                            {aiLoading ? "..." : "Wyślij"}
                                        </button>
                                    </div>
                                </div>
                            )}

                            {/* SCENARIUSZ B: SZEF / INNY UŻYTKOWNIK OTWIERA SPRAWĘ O STATUSIE "NOWA" (OCZEKIWANIĘ NA KIEROWNIKA) */}
                            {selectedClaim.status === "NOWA" && !selectedClaim.assignedManagers.includes(user.uid) && (
                                <div className="flex-1 flex flex-col items-center justify-center p-8 text-center bg-slate-50 text-slate-500">
                                    <span className="text-5xl mb-4">⏳</span>
                                    <h4 className="text-lg font-black text-slate-700 uppercase">Oczekiwanie na wyjaśnienia</h4>
                                    <p className="text-sm max-w-md mt-2">
                                        Asystent AI CLS prowadzi obecnie wstępne przesłuchanie techniczne z Kierownikiem Budowy.
                                        Sprawa pojawi się na wokandzie i zostanie przekazana do Dyrekcji natychmiast po zakończeniu wywiadu.
                                    </p>
                                </div>
                            )}

                            {/* SCENARIUSZ C: SPRAWA W TOKU / ZAKOŃCZONA (WIDOK PRZEBIEGU CZATU + PODSUMOWANIA) */}
                            {selectedClaim.status !== "NOWA" && (
                                <div className="flex-1 flex flex-col overflow-hidden bg-slate-50/50">

                                    {/* Czat tradycyjny */}
                                    <div className="flex-1 p-6 overflow-y-auto space-y-4">

                                        {/* RAPORT GENEROWANY PRZEZ AI - Przeniesiony DO ŚRODKA kontenera scrollowanego na samą górę! */}
                                        {selectedClaim.aiReport && (
                                            <div className="bg-purple-50 border border-purple-200 p-5 rounded-2xl shadow-sm mb-4">
                                                <h4 className="text-xs font-black text-purple-900 uppercase tracking-widest mb-2 flex items-center gap-1"><span>✨</span> Protokół ustaleń Asystenta AI:</h4>
                                                <p className="text-xs text-purple-950 whitespace-pre-wrap leading-relaxed font-semibold bg-white p-4 rounded-xl border border-purple-200">{selectedClaim.aiReport}</p>
                                            </div>
                                        )}

                                        {selectedClaim.messages.map((msg) => (
                                            <div key={msg.id} className={`flex flex-col ${msg.senderId === user.uid ? 'items-end' : 'items-start'}`}>
                                                <div className={`p-4 rounded-2xl shadow-sm max-w-[80%] ${msg.senderId === user.uid ? 'bg-blue-600 text-white' : 'bg-white border border-slate-200 text-slate-800'}`}>
                                                    <div className="flex justify-between gap-4 mb-2 opacity-50 font-black text-[9px] uppercase tracking-wider">
                                                        <span>{msg.senderName}</span>
                                                        <span>{msg.senderRole}</span>
                                                    </div>
                                                    <p className="text-sm whitespace-pre-wrap">{msg.text}</p>
                                                </div>
                                            </div>
                                        ))}
                                        <div ref={chatEndRef} />
                                    </div>

                                    {/* WYROK SĄDU (Gdy sprawa jest zamknięta) */}
                                    {selectedClaim.status === "ZAMKNIETA" && (
                                        <div className="p-6 bg-slate-900 text-white border-t border-slate-800">
                                            <h3 className="font-black text-xs text-slate-400 uppercase tracking-widest mb-4">🔨 ORZECZENIE DYREKCJI (ZAMKNIĘTE)</h3>
                                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                                <div className="bg-slate-850 p-4 rounded-xl border border-slate-800">
                                                    <h4 className="text-[10px] font-bold text-slate-500 uppercase tracking-wide mb-1">Decyzja Kadrowa:</h4>
                                                    <p className="text-sm">{selectedClaim.decisionInternal || "Brak decyzji."}</p>
                                                </div>
                                                <div className="bg-slate-850 p-4 rounded-xl border border-slate-800">
                                                    <h4 className="text-[10px] font-bold text-slate-500 uppercase tracking-wide mb-1">Decyzja Magazynowa:</h4>
                                                    <p className="text-sm">{selectedClaim.decisionWarehouse || "Brak wytycznych."}</p>
                                                </div>
                                            </div>
                                        </div>
                                    )}

                                    {/* Panel wysyłania wiadomości (Dla spraw w toku) */}
                                    {selectedClaim.status === "W_TOKU" && (
                                        <div className="p-4 bg-white border-t border-slate-200 flex gap-3">
                                            <input
                                                type="text"
                                                disabled={isSending}
                                                value={messageText}
                                                onChange={e => setMessageText(e.target.value)}
                                                onKeyDown={e => e.key === "Enter" && sendRegularMessage()}
                                                placeholder="Zadaj pytanie / odpowiedz Dyrekcji..."
                                                className="flex-1 p-3 border rounded-xl text-sm outline-none focus:border-blue-500"
                                            />
                                            <button
                                                onClick={sendRegularMessage}
                                                disabled={isSending || !messageText.trim()}
                                                className="bg-blue-600 hover:bg-blue-700 text-white font-black px-6 py-3 rounded-xl transition"
                                            >
                                                Wyślij
                                            </button>
                                        </div>
                                    )}
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

            {/* MODAL: AKTA ŚLEDZTWA (TRANSKRYPT OBU PRZESŁUCHAŃ DLA SZEFA) */}
            {isHistoryModalOpen && selectedClaim && (
                <div className="fixed inset-0 bg-black/80 z-[100] flex items-center justify-center p-4 backdrop-blur-sm">
                    <div className="bg-white rounded-3xl shadow-2xl w-full max-w-4xl h-[85vh] flex flex-col overflow-hidden border-4 border-purple-600 animate-fade-in">
                        <div className="p-6 bg-slate-900 text-white flex justify-between items-center">
                            <div>
                                <h2 className="text-xl font-black uppercase tracking-tighter">📄 PEŁNE AKTA ŚLEDZTWA: {selectedClaim.inventoryName}</h2>
                                <p className="text-xs text-slate-400 mt-1">Pełny, szczegółowy zapis rozmów technicznych oraz ustaleń asystenta</p>
                            </div>
                            <button onClick={() => setIsHistoryModalOpen(false)} className="text-slate-400 hover:text-white text-3xl leading-none">&times;</button>
                        </div>

                        <div className="flex-1 p-6 overflow-y-auto bg-slate-50 space-y-6">

                            {/* BOKS 1: ZGŁOSZENIE I DIAGNOZA MAGAZYNU + KARUZELA ZDJĘĆ */}
                            <div className="bg-slate-100 border border-slate-200 p-5 rounded-2xl shadow-sm">
                                <h4 className="text-xs font-black text-slate-500 uppercase tracking-widest mb-3 pl-1">📋 1. Pierwotne Zgłoszenie i Diagnoza Magazynu:</h4>
                                <div className="bg-white p-4 rounded-xl border border-slate-200">
                                    <p className="text-sm font-bold text-slate-800">{selectedClaim.description.split(" | ")[0]}</p>
                                </div>

                                {/* Wyświetlanie dowodów fotograficznych jako pozioma karuzela */}
                                {selectedClaim.evidencePhotos && selectedClaim.evidencePhotos.length > 0 && (
                                    <div className="mt-4 border-t border-slate-200/50 pt-4">
                                        <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider mb-2">📸 Zabezpieczone zdjęcia dowodowe ({selectedClaim.evidencePhotos.length}):</p>
                                        <div className="flex gap-3 overflow-x-auto pb-2">
                                            {selectedClaim.evidencePhotos.map((url, i) => (
                                                <a key={i} href={url} target="_blank" rel="noreferrer" className="shrink-0 group relative">
                                                    <img src={url} alt={`Dowód ${i + 1}`} className="w-24 h-24 rounded-xl object-cover border border-slate-200 hover:scale-105 transition-transform shadow-sm" />
                                                </a>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>

                            {/* BOKS 2: PODSUMOWANIE WYJAŚNIEŃ KIEROWNIKA (RAPORT CLS) */}
                            {selectedClaim.aiReport && (
                                <div className="bg-purple-50 border border-purple-200 p-5 rounded-2xl shadow-sm">
                                    <h4 className="text-xs font-black text-purple-900 uppercase tracking-widest mb-2 flex items-center gap-1"><span>✨</span> 2. Protokół ustaleń Asystenta AI (Wyjaśnienia Kierownika):</h4>
                                    <p className="text-xs text-purple-950 whitespace-pre-wrap leading-relaxed font-semibold bg-white p-4 rounded-xl border border-purple-200">{selectedClaim.aiReport}</p>
                                </div>
                            )}

                            {/* BOKS 3: PEŁNY CZAT CHRONOLOGICZNY (Magazynier z AI, potem Kierownik z AI, potem Dyrekcja) */}
                            <div className="bg-white border border-slate-200 p-5 rounded-2xl shadow-sm space-y-4">
                                <h4 className="text-xs font-black text-slate-400 uppercase tracking-widest border-b pb-2 mb-2">💬 3. Pełny zapis przebiegu przesłuchania (Czat chronologiczny):</h4>
                                <div className="space-y-4">
                                    {selectedClaim.messages.map((msg, i) => (
                                        <div key={i} className={`flex flex-col ${msg.senderRole === "KIEROWNIK" || msg.senderRole === "DYREKCJA" ? "items-end" : "items-start"}`}>
                                            <div className={`p-4 rounded-2xl max-w-[85%] text-sm ${msg.senderRole === "KIEROWNIK" ? "bg-blue-600 text-white" : msg.senderRole === "DYREKCJA" ? "bg-slate-900 text-white" : msg.senderRole === "AI" ? "bg-purple-100 text-purple-900 border border-purple-200" : "bg-white border text-slate-800"}`}>
                                                <p className="text-[9px] uppercase tracking-widest font-black opacity-40 mb-1">{msg.senderName} ({msg.senderRole})</p>
                                                <p className="whitespace-pre-wrap">{msg.text}</p>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </div>

                        <div className="p-4 border-t bg-white flex justify-end">
                            <button onClick={() => setIsHistoryModalOpen(false)} className="px-6 py-3 bg-slate-900 text-white font-bold rounded-xl hover:bg-slate-800 transition">Zamknij Akta</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}