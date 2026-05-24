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
    status: "NOWA" | "W_TOKU" | "DO_AKCEPTACJI" | "ZAMKNIETA";
    createdAt: string;
    assignedManagers: string[];
    messages: ChatMessage[];
    evidencePhotos?: string[];
    aiReport?: string;
    caseContext?: string;
    decisionInternalDyrektor?: string;
    decisionWarehouseDyrektor?: string;
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
    const [isHistoryModalOpen, setIsHistoryModalOpen] = useState(false);
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
    const canManageClaimsFinal = hasPermission("manageClaimsFinal", user.rolePermissions, user.permissionOverrides);
    const canViewAllClaims = hasPermission("viewAllClaims", user.rolePermissions, user.permissionOverrides);

    // ZABEZPIECZENIE: Znak zapytania przy user?.roleId
    const chatRoleName = canManageClaims ? "DYREKCJA" : user?.roleId === "magazynier" ? "MAGAZYN" : "KIEROWNIK";

    // OBLICZANIE ILE DNI SPRZĘT BYŁ NA BUDOWIE (Odczyt z indywidualnej historii urządzenia)
    const calculateDaysOnSite = async (claim: Claim) => {
        try {
            const historySnap = await getDocs(query(collection(db, `inventory/${claim.inventoryId}/history`), orderBy("date", "desc")));
            const history = historySnap.docs.map(d => d.data());

            // Szukamy OSTATNIEGO momentu, gdy sprzęt trafił na budowę
            let issueDateStr = null;
            for (const entry of history) {
                if (entry.type === "WYDANIE" || entry.type === "DOSTAWA_BEZP" || entry.type === "ZAKUP") {
                    issueDateStr = entry.documentDate || entry.date;
                    break; // Znaleźliśmy najświeższe wydanie w teren, przerywamy!
                }
            }

            if (issueDateStr) {
                const issueDate = new Date(issueDateStr);
                const currentDate = new Date(claim.createdAt); // Data wszczęcia sprawy w CLS
                const diffTime = Math.abs(currentDate.getTime() - issueDate.getTime());
                return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
            }
        } catch (e) { console.error("Błąd obliczania dni:", e); }
        return null;
    };

    const handleSelectClaim = async (claim: Claim) => {
        setSelectedClaim(claim);
        setAiMessages([]);
        setBackupStep(null);
        setBackupAnswers([]);
        // PANCERNE ZABEZPIECZENIE: Zawsze odblokowujemy pole wpisywania przy wejściu w sprawę
        setAiLoading(false);

        const isMyInvestigation = claim.status === "NOWA" && claim.assignedManagers.includes(user.uid);

        if (isMyInvestigation) {
            const days = await calculateDaysOnSite(claim);
            setDaysOnSite(days);

            const existingMessages = claim.messages || [];
            // Znajdźmy pierwsze wygenerowane pytanie dla kierownika (będzie to ostatnia wiadomość przed wejściem)
            const lastAiMsg = existingMessages[existingMessages.length - 1];

            if (lastAiMsg && lastAiMsg.senderRole === "AI") {
                setAiMessages([{ role: "assistant", content: lastAiMsg.text }]);
            } else {
                setBackupStep(0);
                setAiMessages([{ role: "assistant", content: `[TRYB AWARYJNY SĘDZIEGO] Witaj Kierowniku. Rozpoczynamy procedurę wyjaśniającą.\n\nPytanie 1: ${BACKUP_QUESTIONS[0]}` }]);
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
                const activeInterrogationMessages = updatedMessages.map(m => ({
                    role: m.role,
                    content: m.content
                }));

                const res = await fetchWithTimeout("/api/claims-ai-investigate", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        inventoryName: selectedClaim.inventoryName,
                        inventoryNumber: selectedClaim.inventoryNumber,
                        siteName: selectedClaim.siteName,
                        warehouseNotes: selectedClaim.description,
                        daysOnSite,
                        messages: activeInterrogationMessages,
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

    const finalizeInvestigation = async (reportText: string, chatHistory: any[]) => {
        if (!selectedClaim) return;
        try {
            const existingMessages = selectedClaim.messages || [];

            const formattedKierownikMessages: ChatMessage[] = chatHistory.map((m, idx) => ({
                id: `${Date.now()}-kierownik-${idx}`,
                senderId: m.role === "user" ? user.uid : "AI_SYSTEM",
                senderName: m.role === "user" ? `${user.firstName} ${user.lastName}` : "Sędzia AI CLS 🤖",
                senderRole: m.role === "user" ? "KIEROWNIK" : "AI",
                text: m.content,
                timestamp: new Date().toISOString(),
                visibleToWarehouse: true
            }));

            const finalMergedMessages = [...existingMessages, ...formattedKierownikMessages];

            await updateDoc(doc(db, "claims", selectedClaim.id), {
                status: "W_TOKU",
                aiReport: reportText,
                messages: finalMergedMessages
            });

            // POWIADOMIENIE ZARZĄDU O GOTOWYM RAPORCIE KIEROWNIKA
            try {
                await fetch("/api/claims-email", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        type: "CLAIM_FINISHED",
                        claimId: selectedClaim.claimId,
                        inventoryName: selectedClaim.inventoryName,
                        inventoryNumber: selectedClaim.inventoryNumber,
                        siteName: selectedClaim.siteName,
                        managerName: `${user.firstName} ${user.lastName}`,
                        reportText: reportText
                    })
                });
            } catch (emailErr) {
                console.error("Błąd wysyłki e-mail o końcu wywiadu:", emailErr);
            }

            alert("🎉 Przesłuchanie zakończone! Raport oraz pełne zeznania zostały połączone i wysłane do Zarządu.");
            setSelectedClaim(null);
            fetchData();
        } catch (e) {
            alert("Błąd podczas kończenia przesłuchania i łączenia akt.");
        }
    };

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
            if (canManageClaimsFinal) {
                await updateDoc(doc(db, "claims", selectedClaim.id), {
                    decisionInternal: verdictData.internal,
                    decisionWarehouse: verdictData.warehouse,
                    status: "ZAMKNIETA"
                });

                // MAIL O OSTATECZNYM WYROKU SZEFA
                try {
                    await fetch("/api/claims-email", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            type: "VERDICT_FINAL",
                            claimId: selectedClaim.claimId,
                            inventoryName: selectedClaim.inventoryName,
                            inventoryNumber: selectedClaim.inventoryNumber,
                            siteName: selectedClaim.siteName,
                            managerUid: selectedClaim.assignedManagers[0]
                        })
                    });
                } catch (emailErr) {
                    console.error("Błąd wysyłki e-mail o wyroku ostatecznym:", emailErr);
                }

                alert("Wyrok ostateczny Szefa został ogłoszony. Sprawa zamknięta i zarchiwizowana.");
            } else {
                await updateDoc(doc(db, "claims", selectedClaim.id), {
                    decisionInternalDyrektor: verdictData.internal,
                    decisionWarehouseDyrektor: verdictData.warehouse,
                    status: "DO_AKCEPTACJI",
                    verdictDyrektorAt: new Date().toISOString()
                });

                // MAIL O WYROKU I INSTANCJI DYREKTORA
                try {
                    await fetch("/api/claims-email", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            type: "VERDICT_DYREKTOR",
                            claimId: selectedClaim.claimId,
                            inventoryName: selectedClaim.inventoryName,
                            inventoryNumber: selectedClaim.inventoryNumber,
                            siteName: selectedClaim.siteName,
                            managerUid: selectedClaim.assignedManagers[0]
                        })
                    });
                } catch (emailErr) {
                    console.error("Błąd wysyłki e-mail o wyroku Dyrektora:", emailErr);
                }

                alert("Wyrok I instancji Dyrektora został zapisany. Sprawa oczekuje na ostateczną decyzję Szefa.");
            }
            setIsVerdictModalOpen(false);
            fetchData();
            setSelectedClaim(null);
        } catch (e) { alert("Błąd zapisu wyroku."); }
    };

    const openVerdictModal = () => {
        if (!selectedClaim) return;
        if (canManageClaimsFinal && selectedClaim.status === "DO_AKCEPTACJI") {
            setVerdictData({
                internal: selectedClaim.decisionInternalDyrektor || "",
                warehouse: selectedClaim.decisionWarehouseDyrektor || ""
            });
        } else {
            setVerdictData({ internal: "", warehouse: "" });
        }
        setIsVerdictModalOpen(true);
    };

    const activeClaims = claims.filter(c => c.status !== "ZAMKNIETA");
    const archivedClaims = claims.filter(c => c.status === "ZAMKNIETA");
    const displayedClaims = activeTab === "AKTYWNE" ? activeClaims : archivedClaims;

    // INTELIGENTNE I BEZBŁĘDNE FILTROWANIE CZATU ROBOCZEGO (LIVE)
    const messages = selectedClaim?.messages || [];
    const lastAiSystemMsgIndex = messages.map(m => m.senderRole).lastIndexOf("AI");
    const liveMessages = lastAiSystemMsgIndex !== -1 ? messages.slice(lastAiSystemMsgIndex + 1) : messages;

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
                <div className="w-1/3 bg-white rounded-3xl shadow-sm border border-slate-200 flex flex-col overflow-hidden font-sans font-medium">
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
                                    <span className={`text-[10px] px-2 py-0.5 rounded font-black uppercase ${claim.status === 'NOWA' ? 'bg-red-500 text-white animate-pulse' :
                                        claim.status === 'DO_AKCEPTACJI' ? 'bg-yellow-500 text-white animate-pulse' :
                                            claim.status === 'W_TOKU' ? 'bg-orange-100 text-orange-700' : 'bg-slate-200 text-slate-600'
                                        }`}>
                                        {claim.status === "ZAMKNIETA" ? "ZAMKNIĘTA" : claim.status === "NOWA" ? "WYJAŚNIANIE" : claim.status === "DO_AKCEPTACJI" ? "U SZEFA" : claim.status}
                                    </span>
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

                                {/* PRZYCISKI AKCJI ZALEŻNE OD STATUSU I ROLI */}
                                <div className="flex gap-2">
                                    {selectedClaim.status !== "NOWA" && (
                                        <button
                                            onClick={() => setIsHistoryModalOpen(true)}
                                            className="bg-purple-100 hover:bg-purple-200 text-purple-800 font-black px-4 py-2.5 rounded-xl border border-purple-200 text-xs shadow-sm transition"
                                        >
                                            📄 Zobacz Przebieg Śledztwa
                                        </button>
                                    )}

                                    {/* Dyrektor może wydać wyrok I instancji, gdy sprawa jest W_TOKU */}
                                    {canManageClaims && !canManageClaimsFinal && selectedClaim.status === "W_TOKU" && (
                                        <button onClick={openVerdictModal} className="bg-red-600 hover:bg-red-700 text-white font-black px-5 py-2.5 rounded-xl shadow-lg transition text-xs">
                                            Wydaj Wyrok (I Instancja)
                                        </button>
                                    )}

                                    {/* Szef widzi przycisk orzekania ostatecznego zawsze, gdy sprawa jest W_TOKU lub DO_AKCEPTACJI */}
                                    {canManageClaimsFinal && (selectedClaim.status === "W_TOKU" || selectedClaim.status === "DO_AKCEPTACJI") && (
                                        <button onClick={openVerdictModal} className="bg-red-600 hover:bg-red-700 text-white font-black px-5 py-2.5 rounded-xl shadow-lg transition text-xs animate-pulse">
                                            {selectedClaim.status === "DO_AKCEPTACJI" ? "Zatwierdź / Zmień Wyrok" : "Wydaj Wyrok (Ostateczny)"}
                                        </button>
                                    )}
                                </div>
                            </div>

                            {/* SCENARIUSZ A: PRZESŁUCHANIE KIEROWNIKA PRZEZ AI */}
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
                                        <button onClick={handleSendToAi} disabled={aiLoading || !messageText.trim()} className="bg-purple-600 hover:bg-purple-700 text-white font-black px-6 py-3.5 rounded-xl transition">
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

                                    <div className="flex-1 p-6 overflow-y-auto space-y-4">

                                        {/* BOKS 1: DEDYKOWANE PODSUMOWANIE MAGAZYNU + ZDJĘCIA (NA GŁÓWNYM EKRANIE) */}
                                        {selectedClaim.caseContext && (
                                            <div className="bg-slate-100 border border-slate-200 p-5 rounded-2xl shadow-sm mb-4 animate-fade-in">
                                                <h4 className="text-xs font-black text-slate-500 uppercase tracking-widest mb-2 flex items-center gap-1"><span>📋</span> 1. Ustalenia z Magazynierem (AI):</h4>
                                                <p className="text-xs text-slate-800 whitespace-pre-wrap leading-relaxed font-semibold bg-white p-4 rounded-xl border border-slate-200">{selectedClaim.caseContext}</p>

                                                {/* Zdjęcia dowodowe na głównym ekranie */}
                                                {selectedClaim.evidencePhotos && selectedClaim.evidencePhotos.length > 0 && (
                                                    <div className="mt-4 border-t border-slate-200/50 pt-4">
                                                        <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider mb-2">📸 Załączone dowody fotograficzne ({selectedClaim.evidencePhotos.length}):</p>
                                                        <div className="flex gap-2 overflow-x-auto pb-1">
                                                            {selectedClaim.evidencePhotos.map((url, i) => (
                                                                <a key={i} href={url} target="_blank" rel="noreferrer" className="shrink-0">
                                                                    <img src={url} alt={`Dowód ${i + 1}`} className="w-20 h-20 rounded-xl object-cover border border-slate-200 shadow-sm hover:scale-105 transition-transform" />
                                                                </a>
                                                            ))}
                                                        </div>
                                                    </div>
                                                )}
                                            </div>
                                        )}

                                        {/* BOKS 2: DEDYKOWANE PODSUMOWANIE KIEROWNIKA (NA GŁÓWNYM EKRANIE) */}
                                        {selectedClaim.aiReport && (
                                            <div className="bg-purple-50 border border-purple-200 p-5 rounded-2xl shadow-sm animate-fade-in">
                                                <h4 className="text-xs font-black text-purple-900 uppercase tracking-widest mb-2 flex items-center gap-1"><span>✨</span> 2. Ustalenia z Kierownikiem Budowy (AI):</h4>
                                                <p className="text-xs text-purple-950 whitespace-pre-wrap leading-relaxed font-semibold bg-white p-4 rounded-xl border border-purple-200">{selectedClaim.aiReport}</p>
                                            </div>
                                        )}

                                        {/* PROPOZYCJA WYROKU DYREKTORA (Widoczna, gdy status to DO_AKCEPTACJI) */}
                                        {selectedClaim.status === "DO_AKCEPTACJI" && (
                                            <div className="bg-yellow-50 border border-yellow-200 p-5 rounded-2xl shadow-sm animate-fade-in">
                                                <h4 className="text-xs font-black text-yellow-900 uppercase tracking-widest mb-2">⏳ 3. Propozycja Wyroku Dyrekcji (I Instancja):</h4>
                                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-3">
                                                    <div className="bg-white p-4 rounded-xl border text-xs">
                                                        <span className="font-bold text-slate-500 uppercase">Decyzja Kadrowa:</span>
                                                        <p className="mt-1 font-semibold text-slate-800">{selectedClaim.decisionInternalDyrektor || "Brak danych."}</p>
                                                    </div>
                                                    <div className="bg-white p-4 rounded-xl border text-xs">
                                                        <span className="font-bold text-slate-500 uppercase">Decyzja Magazynowa:</span>
                                                        <p className="mt-1 font-semibold text-slate-800">{selectedClaim.decisionWarehouseDyrektor || "Brak danych."}</p>
                                                    </div>
                                                </div>
                                            </div>
                                        )}

                                        {/* RENDERING TRADYCYJNEGO CZATU ROBOCZEGO (PO PRZESŁUCHANIACH) */}
                                        {liveMessages.map((msg) => {
                                            if (msg.senderRole === "AI") return null;
                                            const isMe = msg.senderId === user.uid;

                                            return (
                                                <div key={msg.id} className={`flex flex-col ${isMe ? 'items-end' : 'items-start'}`}>
                                                    <div className={`p-4 rounded-2xl shadow-sm max-w-[80%] ${isMe ? 'bg-blue-600 text-white' : 'bg-white border border-slate-200 text-slate-800'}`}>
                                                        <div className="flex justify-between gap-4 mb-2 opacity-50 font-black text-[9px] uppercase tracking-wider">
                                                            <span>{msg.senderName}</span>
                                                            <span>{msg.senderRole}</span>
                                                        </div>
                                                        <p className="text-sm whitespace-pre-wrap">{msg.text}</p>
                                                    </div>
                                                </div>
                                            );
                                        })}
                                        <div ref={chatEndRef} />
                                    </div>

                                    {/* WYROK SZEFA (Gdy sprawa jest całkowicie zamknięta) */}
                                    {selectedClaim.status === "ZAMKNIETA" && (
                                        <div className="p-6 bg-slate-900 text-white border-t border-slate-800">
                                            <h3 className="font-black text-xs text-slate-400 uppercase tracking-widest mb-4 font-mono">🔨 OSTATECZNE ORZECZENIE SZEFA (ZAMKNIĘTE)</h3>
                                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                                <div className="bg-slate-850 p-4 rounded-xl border border-slate-850">
                                                    <h4 className="text-[10px] font-bold text-slate-500 uppercase tracking-wide mb-1">Ostateczna Decyzja Kadrowa:</h4>
                                                    <p className="text-sm">{selectedClaim.decisionInternal || "Brak decyzji."}</p>
                                                </div>
                                                <div className="bg-slate-850 p-4 rounded-xl border border-slate-850">
                                                    <h4 className="text-[10px] font-bold text-slate-500 uppercase tracking-wide mb-1">Ostateczna Decyzja Magazynowa:</h4>
                                                    <p className="text-sm">{selectedClaim.decisionWarehouse || "Brak wytycznych."}</p>
                                                </div>
                                            </div>
                                        </div>
                                    )}

                                    {/* Panel wysyłania wiadomości (Dla spraw w toku i do akceptacji) */}
                                    {(selectedClaim.status === "W_TOKU" || selectedClaim.status === "DO_AKCEPTACJI") && (
                                        <div className="p-4 bg-white border-t border-slate-200 flex gap-3">
                                            <input
                                                type="text"
                                                disabled={isSending}
                                                value={messageText}
                                                onChange={e => setMessageText(e.target.value)}
                                                onKeyDown={e => e.key === "Enter" && sendRegularMessage()}
                                                placeholder="Zadaj pytanie / odpowiedz na wątki rozprawy..."
                                                className="flex-1 p-3 border rounded-xl text-sm outline-none focus:border-blue-500"
                                            />
                                            <button onClick={sendRegularMessage} disabled={isSending || !messageText.trim()} className="bg-blue-600 hover:bg-blue-700 text-white font-black px-6 py-3 rounded-xl transition">Wyślij</button>
                                        </div>
                                    )}
                                </div>
                            )}
                        </>
                    )}
                </div>
            </div>

            {/* MODAL WYDAWANIA I AKCEPTACJI WYROKU */}
            {isVerdictModalOpen && selectedClaim && (
                <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
                    <div className="bg-white rounded-3xl shadow-2xl w-full max-w-2xl overflow-hidden animate-fade-in border-4 border-red-600">
                        <div className="p-6 bg-red-600 text-white flex justify-between items-center">
                            <h2 className="text-2xl font-black uppercase tracking-tighter">
                                {canManageClaimsFinal && selectedClaim.status === "DO_AKCEPTACJI" ? "Orzekanie Ostateczne (Szef)" : "Wydawanie Wyroku (I Instancja)"}
                            </h2>
                            <button onClick={() => setIsVerdictModalOpen(false)} className="text-white opacity-60 hover:opacity-100">✕</button>
                        </div>

                        <form onSubmit={handleVerdictSubmit} className="p-8 space-y-6">
                            <div>
                                <label className="block text-xs font-black text-slate-400 uppercase tracking-widest mb-3 italic">
                                    {canManageClaimsFinal ? "Ostateczna Decyzja Kadrowo-Finansowa (Zarząd/Szef)" : "1. Proponowana Decyzja Kadrowo-Finansowa (Dyrektor)"}
                                </label>
                                <textarea
                                    required
                                    rows={4}
                                    placeholder="Np. Obciążyć kosztami naprawy w 50% pracownika Jana Kowalskiego. Naganę wpisać do akt."
                                    value={verdictData.internal}
                                    onChange={e => setVerdictData({ ...verdictData, internal: e.target.value })}
                                    className="w-full p-4 border-2 border-slate-200 rounded-2xl outline-none focus:border-red-500 text-sm transition-all font-semibold"
                                />
                            </div>

                            <div>
                                <label className="block text-xs font-black text-slate-400 uppercase tracking-widest mb-3 italic">
                                    {canManageClaimsFinal ? "Ostateczne Wytyczne dla Magazynu (Zarząd/Szef)" : "2. Proponowane Wytyczne dla Magazynu (Dyrektor)"}
                                </label>
                                <textarea
                                    required
                                    rows={4}
                                    placeholder="Np. Sprzęt nie nadaje się do naprawy. Złomować natychmiast."
                                    value={verdictData.warehouse}
                                    onChange={e => setVerdictData({ ...verdictData, warehouse: e.target.value })}
                                    className="w-full p-4 border-2 border-slate-200 rounded-2xl outline-none focus:border-blue-500 text-sm transition-all font-semibold"
                                />
                            </div>

                            <div className="flex gap-4 pt-4">
                                <button type="button" onClick={() => setIsVerdictModalOpen(false)} className="flex-1 py-4 bg-slate-100 text-slate-600 font-bold rounded-2xl hover:bg-slate-200 transition">Anuluj</button>
                                <button type="submit" className="flex-1 py-4 bg-red-600 text-white font-black rounded-2xl shadow-xl hover:bg-red-700 transition uppercase tracking-widest">
                                    {canManageClaimsFinal ? "Zatwierdź i Ogłoś Wyrok Ostateczny" : "Podpisz i Przekaż do Szefa"}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* MODAL: PEŁNE AKTA ŚLEDZTWA (TRANSKRYPT BEZ PODSUMOWAŃ) */}
            {isHistoryModalOpen && selectedClaim && (
                <div className="fixed inset-0 bg-black/80 z-[100] flex items-center justify-center p-4 backdrop-blur-sm">
                    <div className="bg-white rounded-3xl shadow-2xl w-full max-w-4xl h-[85vh] flex flex-col overflow-hidden border-4 border-purple-600 animate-fade-in">
                        <div className="p-6 bg-slate-900 text-white flex justify-between items-center">
                            <div>
                                <h2 className="text-xl font-black uppercase tracking-tighter">📄 PEŁNE AKTA ŚLEDZTWA: {selectedClaim.inventoryName}</h2>
                                <p className="text-xs text-slate-400 mt-1">Pełny, szczegółowy zapis rozmów technicznych oraz zeznań bez streszczeń</p>
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
                                    {selectedClaim.messages.map((msg, i) => {
                                        const isKierownik = msg.senderRole === "KIEROWNIK";
                                        const isAI = msg.senderRole === "AI";
                                        const isMagazyn = msg.senderRole === "MAGAZYN";

                                        return (
                                            <div key={i} className={`flex flex-col ${isKierownik || msg.senderRole === "DYREKCJA" ? "items-end" : "items-start"}`}>
                                                <div className={`p-4 rounded-2xl max-w-[85%] text-sm ${isKierownik
                                                    ? "bg-blue-600 text-white"
                                                    : msg.senderRole === "DYREKCJA"
                                                        ? "bg-slate-900 text-white"
                                                        : isAI
                                                            ? "bg-purple-100 text-purple-900 border border-purple-200"
                                                            : "bg-white border text-slate-800"
                                                    }`}>
                                                    <p className="text-[9px] uppercase tracking-widest font-black opacity-40 mb-1">{msg.senderName} ({msg.senderRole})</p>

                                                    {isMagazyn && msg.imageUrls && msg.imageUrls.length > 0 && (
                                                        <div className="mb-3 mt-1 rounded-xl overflow-hidden border border-black/10 shadow-md bg-black/5 flex gap-2 p-2">
                                                            {msg.imageUrls.map((url, imgIdx) => (
                                                                <a key={imgIdx} href={url} target="_blank" rel="noreferrer" className="block">
                                                                    <img src={url} alt={`Dowód`} className="w-16 h-16 rounded-lg object-cover hover:scale-105 transition-transform" />
                                                                </a>
                                                            ))}
                                                        </div>
                                                    )}

                                                    <p className="whitespace-pre-wrap">{msg.text}</p>
                                                </div>
                                            </div>
                                        );
                                    })}
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