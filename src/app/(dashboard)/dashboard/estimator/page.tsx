"use client";

import { useState, useEffect, useRef } from "react";
import { useAuth } from "@/lib/auth/AuthContext";
import { hasPermission } from "@/lib/auth/permissions";
import { useRouter } from "next/navigation";
import { uploadTenderDocument, UploadProgress } from "@/lib/kosztorysant/uploadTenderDocument";
import { db } from "@/lib/firebase/config";
import { collection, onSnapshot, doc, getDocs, query, orderBy, addDoc, serverTimestamp } from "firebase/firestore";

// --- INTERFEJSY ZGODNE ZE SCHEMATEM PESAM 3.0 ---

interface SwarmTask {
    id: string;
    agentType: string;
    description?: string;
    instruction?: string;
    rawResult?: any;
    status: "PENDING" | "IN_PROGRESS" | "DONE" | "ERROR";
    dependsOn?: string[];
    parentTaskId?: string;
    costUSD?: number;
}

interface EstimateItem {
    id: string;
    pozycja: string;
    opis: string;
    ilosc: number;
    jednostka?: string;   // <--- DODANA LINIJKA
    cenaJed: number;
    KNR_ref?: string;
    confidence?: string;
    sourceTrack?: string;
}

interface EstimateSection {
    id: string;
    section: string;
    status: string;
    totalValue: number;
    items: EstimateItem[];
}

interface Conflict {
    id: string;
    topic: string;
    status: "OPEN" | "INVESTIGATING" | "RESOLVED" | "ESCALATED_TO_USER";
    parties: Array<{ agent: string; claim: string; sourceDoc: string }>;
    resolution?: { decision: string; justification: string };
}

interface BudgetGuard {
    maxBudgetUSD: number;
    currentCostUSD: number;
    limitReached: boolean;
    iterationCount: number;
    maxIterations: number;
}

interface ChatMessage {
    id: string;
    role: "user" | "brain";
    content: string;
    timestamp: any;
}

interface TenderDocument {
    id: string;
    fileName: string;
    status: string;
    tags: string[];
    summary?: string;
    detailedElement?: string;
    storagePath?: string;
}

interface BrainState {
    phase: string;
    currentGoal: string;
    totalCostUSD: number;
    assumptionMode?: boolean;
    assumptionDisclaimer?: string;
}

interface TechnologistFinding {
    id: string;
    category: string;
    facts: Record<string, any>;
    confidence: number;
    normBasis?: string;
    source?: string;
}

export default function EstimatorPage() {
    const { user } = useAuth();
    const router = useRouter();

    const canUseEstimator = hasPermission("useEstimatingPanel", user?.rolePermissions, user?.permissionOverrides);

    useEffect(() => {
        if (canUseEstimator === false) {
            alert("Brak uprawnień do profesjonalnego panelu kosztorysowania.");
            router.push("/dashboard/shop");
        }
    }, [canUseEstimator, router]);

    // --- STANY APLIKACJI ---
    const [activeTenderId, setActiveTenderId] = useState<string | null>(null);
    const [tenderName, setTenderName] = useState("Nowy Przetarg");
    const [tenderStatus, setTenderStatus] = useState("UPLOADING");

    const [budgetGuard, setBudgetGuard] = useState<BudgetGuard>({ maxBudgetUSD: 5.0, currentCostUSD: 0, limitReached: false, iterationCount: 0, maxIterations: 50 });
    const [brainState, setBrainState] = useState<BrainState | null>(null);

    const [sections, setSections] = useState<EstimateSection[]>([]);
    const [tasks, setTasks] = useState<SwarmTask[]>([]);
    const [conflicts, setConflicts] = useState<Conflict[]>([]);
    const [documents, setDocuments] = useState<TenderDocument[]>([]);
    const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
    const [technologistFindings, setTechnologistFindings] = useState<TechnologistFinding[]>([]);

    const [inputText, setInputText] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const [isUploading, setIsUploading] = useState(false);
    const [uploadMsg, setUploadMsg] = useState("");
    const [savedTendersList, setSavedTendersList] = useState<Array<{ id: string; name: string }>>([]);
    const [assumptionsAccepted, setAssumptionsAccepted] = useState(false);

    // Stany dla Podglądu PDF
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);
    const [isLoadingPreview, setIsLoadingPreview] = useState(false);

    const chatEndRef = useRef<HTMLDivElement | null>(null);

    // Automatyczne przewijanie czatu
    useEffect(() => {
        chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [chatMessages]);

    // Resetowanie stanu akceptacji przy zmianie przetargu
    useEffect(() => {
        setAssumptionsAccepted(false);
    }, [activeTenderId]);

    // 1. Pobieranie listy dostępnych przetargów na starcie
    useEffect(() => {
        const fetchTenders = async () => {
            try {
                const snap = await getDocs(query(collection(db, "tenders")));
                const list = snap.docs.map(d => ({
                    id: d.id,
                    name: d.data().objectType || `Przetarg ${d.id.slice(0, 6)}`
                }));
                setSavedTendersList(list);
            } catch (e) {
                console.error("Błąd pobierania przetargów:", e);
            }
        };
        fetchTenders();
    }, []);

    // 2. Real-Time nasłuchiwanie stanu Roju (Event-Driven State Machine)
    useEffect(() => {
        if (!activeTenderId) return;
        console.log(`[PESAM 3.0] Inicjalizacja nasłuchu dla przetargu: ${activeTenderId}`);

        // A. Nasłuch głównego dokumentu przetargu (Budżet i Status)
        const unsubTender = onSnapshot(doc(db, "tenders", activeTenderId), (snap) => {
            if (snap.exists()) {
                const data = snap.data();
                setTenderName(data.objectType || "Nieznany Obiekt");
                setTenderStatus(data.status || "UNKNOWN");
                if (data.budgetGuard) setBudgetGuard(data.budgetGuard);
            }
        });

        // B. Nasłuch Zadań (Szyna Komunikacyjna)
        const unsubTasks = onSnapshot(collection(db, `tenders/${activeTenderId}/tasks`), (snap) => {
            const updatedTasks = snap.docs.map(d => ({ id: d.id, ...d.data() } as SwarmTask));
            setTasks(updatedTasks);
        });

        // C. Nasłuch Konfliktów (Sąd Roju)
        const unsubConflicts = onSnapshot(collection(db, `tenders/${activeTenderId}/conflicts`), (snap) => {
            const list = snap.docs.map(d => ({ id: d.id, ...d.data() } as Conflict));
            setConflicts(list);
        });

        // D. Nasłuch Kosztorysu (Żywy Kosztorys)
        const unsubEstimate = onSnapshot(collection(db, `tenders/${activeTenderId}/estimate`), (snap) => {
            const initialSections: EstimateSection[] = snap.docs.map(d => {
                const data = d.data();
                return {
                    id: d.id,
                    section: data.section || "Brak nazwy",
                    status: data.status || "UNKNOWN",
                    totalValue: data.totalValue || 0,
                    items: [] // Inicjalizacja pustej tablicy na start
                };
            });

            // Ustawiamy główny szkielet sekcji w interfejsie
            setSections(initialSections);

            // Reaktywny nasłuch podkolekcji 'items' dla KAŻDEJ z sekcji
            initialSections.forEach(section => {
                onSnapshot(collection(db, `tenders/${activeTenderId}/estimate/${section.id}/items`), (itemsSnap) => {
                    const fetchedItems: EstimateItem[] = itemsSnap.docs.map(itemDoc => {
                        const itemData = itemDoc.data();
                        return {
                            id: itemDoc.id,
                            pozycja: itemData.pozycja || "",
                            opis: itemData.opis || "",
                            ilosc: itemData.ilosc || 0,
                            jednostka: itemData.jednostka || "j.m.",
                            cenaJed: itemData.cenaJed || 0,
                            KNR_ref: itemData.KNR_ref || "",
                            confidence: itemData.confidence || "",
                            sourceTrack: itemData.sourceTrack || ""
                        };
                    });

                    // Podmieniamy tylko pozycje wewnątrz konkretnej sekcji
                    setSections(prevSections => prevSections.map(s =>
                        s.id === section.id ? { ...s, items: fetchedItems } : s
                    ));
                });
            });
        });

        // E. Nasłuch Czatu (Interfejs z Użytkownikiem)
        const qChat = query(collection(db, `tenders/${activeTenderId}/chat`), orderBy("timestamp", "asc"));
        const unsubChat = onSnapshot(qChat, (snap) => {
            const msgs = snap.docs.map(d => ({ id: d.id, ...d.data() } as ChatMessage));
            setChatMessages(msgs);
        });

        // F. Nasłuch Dokumentów (Klasyfikacja)
        const unsubDocs = onSnapshot(collection(db, `tenders/${activeTenderId}/documents`), (snap) => {
            const docs = snap.docs.map(d => ({ id: d.id, ...d.data() } as TenderDocument));
            setDocuments(docs);
        });

        // G. Nasłuch Stanu Umysłu (Mózg)
        const unsubBrain = onSnapshot(collection(db, `tenders/${activeTenderId}/brain`), (snap) => {
            if (!snap.empty) {
                setBrainState(snap.docs[0].data() as BrainState);
            }
        });

        // H. Nasłuch Ustaleń Technologa (Nowość!)
        const unsubFindings = onSnapshot(collection(db, `tenders/${activeTenderId}/technologistFindings`), (snap) => {
            const list = snap.docs.map(d => ({ id: d.id, ...d.data() } as TechnologistFinding));
            setTechnologistFindings(list);
        });

        return () => {
            unsubTender(); unsubTasks(); unsubConflicts(); unsubEstimate(); unsubChat(); unsubDocs(); unsubBrain(); unsubFindings();
        };
    }, [activeTenderId]);

    // --- AKCJE ---

    const handleFileUpload = async (files: FileList) => {
        if (files.length === 0) return;
        setIsUploading(true);
        try {
            const result = await uploadTenderDocument(files, { laborAdjustment: 0, materialAdjustment: 0, equipmentAdjustment: 0, kp: 65, zysk: 12 }, (p: UploadProgress) => {
                setUploadMsg(p.message);
            });
            if (result.tenderId) {
                setActiveTenderId(result.tenderId);
            }
        } catch (err: any) {
            alert("Błąd przesyłania: " + err.message);
        } finally {
            setIsUploading(false);
            setUploadMsg("");
        }
    };

    const handleSendMessage = async () => {
        if (!inputText.trim() || !activeTenderId) return;

        const text = inputText;
        setInputText("");

        await addDoc(collection(db, `tenders/${activeTenderId}/chat`), {
            role: "user",
            content: text,
            timestamp: serverTimestamp(),
            intent: "GENERAL"
        });

        try {
            await fetch('/api/kosztorysant/glowny-kosztorysant', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tenderId: activeTenderId, trigger: "USER_MESSAGE" })
            });
        } catch (e) {
            console.error("Błąd komunikacji z Mózgiem:", e);
        }
    };

    const handleAcceptAssumptions = async () => {
        if (!activeTenderId) return;
        setAssumptionsAccepted(true); // Natychmiastowe ukrycie na UI przed wywołaniem API

        await addDoc(collection(db, `tenders/${activeTenderId}/chat`), {
            role: "user",
            content: "AKCEPTUJĘ TRYB ZAŁOŻEŃ RYNKOWYCH. Proszę o kontynuację wyceny koncepcyjnej na podstawie norm rynkowych.",
            timestamp: serverTimestamp(),
            intent: "ACCEPT_ASSUMPTIONS"
        });

        fetch('/api/kosztorysant/glowny-kosztorysant', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tenderId: activeTenderId, trigger: "USER_MESSAGE" })
        }).catch(console.error);
    };

    const handleRejectAssumptions = async () => {
        if (!activeTenderId) return;

        await addDoc(collection(db, `tenders/${activeTenderId}/chat`), {
            role: "user",
            content: "NIE AKCEPTUJĘ TRYBU ZAŁOŻEŃ. Proszę wstrzymać prace do czasu dostarczenia rzetelnej dokumentacji.",
            timestamp: serverTimestamp(),
            intent: "REJECT_ASSUMPTIONS"
        });

        fetch('/api/kosztorysant/glowny-kosztorysant', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tenderId: activeTenderId, trigger: "USER_MESSAGE" })
        }).catch(console.error);
    };

    const handleStopTender = async () => {
        if (!activeTenderId) return;
        if (!confirm("Czy na pewno chcesz zatrzymać ten przetarg i anulować aktywne zadania agentów?")) return;
        try {
            const res = await fetch("/api/kosztorysant/zatrzymaj", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ tenderId: activeTenderId })
            });
            if (res.ok) alert("Przetarg zatrzymany pomyślnie. Status: HALTED.");
        } catch (e) {
            alert("Błąd podczas awaryjnego zatrzymywania.");
        }
    };

    const handleDeleteTender = async () => {
        if (!activeTenderId) return;
        if (!confirm("Czy na pewno chcesz bezpowrotnie usunąć ten przetarg wraz ze wszystkimi plikami, pamięcią i kosztorysem? Tej operacji NIE DA SIĘ COFNĄĆ!")) return;
        try {
            const res = await fetch("/api/kosztorysant/usun-przetarg", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ tenderId: activeTenderId })
            });
            if (res.ok) {
                alert("Przetarg i jego subkolekcje zostały całkowicie usunięte z bazy danych.");
                setActiveTenderId(null);
                setSavedTendersList(prev => prev.filter(t => t.id !== activeTenderId));
            }
        } catch (e) {
            alert("Błąd podczas usuwania dokumentacji z bazy.");
        }
    };

    const resolveConflict = async (conflictId: string, decision: string, justification: string) => {
        try {
            await fetch(`/api/kosztorysant/scope-manifest/resolve-conflict`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ tenderId: activeTenderId, conflictId, decision, justification })
            });
        } catch (e) {
            console.error("Błąd zapisu konsensusu:", e);
        }
    };

    const totals = sections.reduce((acc, sec) => acc + (sec.totalValue || 0), 0);

    return (
        <div className="p-4 md:p-6 max-w-[1800px] mx-auto h-[90vh] flex flex-col relative bg-slate-950 text-slate-200 overflow-hidden font-sans">

            {/* NAGŁÓWEK SYSTEMOWY PESAM 3.0 */}
            <div className="flex justify-between items-center mb-4 border-b border-slate-800 pb-4 bg-slate-900/50 p-4 rounded-3xl shadow-sm flex-shrink-0">
                <div>
                    <div className="flex items-center gap-3">
                        <span className="text-3xl animate-pulse">🧠</span>
                        <div>
                            <h1 className="text-xl font-black tracking-tighter uppercase italic leading-none text-white">PESAM 3.0 – Rój Kosztorysowy</h1>
                            <div className="flex items-center gap-2 mt-1">
                                <span className={`w-2 h-2 rounded-full ${tenderStatus === 'DONE' ? 'bg-green-500' : tenderStatus === 'HALTED' ? 'bg-red-500' : 'bg-blue-500 animate-ping'}`}></span>
                                <p className="text-xs text-slate-400 font-semibold uppercase tracking-wider">
                                    Status: <span className="text-slate-200">{tenderStatus}</span>
                                </p>
                            </div>
                        </div>
                    </div>
                </div>

                <div className="flex gap-4 items-center">
                    {/* BEZPIECZNIK BUDŻETOWY (BudgetGuard) */}
                    {activeTenderId && (
                        <div className={`text-right px-4 py-2 rounded-2xl border ${budgetGuard.limitReached ? "bg-red-500/10 border-red-500/50 text-red-400" : "bg-slate-900 border-slate-800"}`}>
                            <span className="text-[9px] font-black uppercase text-slate-500 block mb-0.5">Koszt API (Budget Guard)</span>
                            <div className="flex items-center gap-2">
                                <div className="w-24 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                                    <div
                                        className={`h-full ${budgetGuard.limitReached ? 'bg-red-500' : 'bg-blue-500'}`}
                                        style={{ width: `${Math.min((budgetGuard.currentCostUSD / budgetGuard.maxBudgetUSD) * 100, 100)}%` }}
                                    />
                                </div>
                                <span className="text-xs font-bold font-mono">{budgetGuard.currentCostUSD.toFixed(3)} / {budgetGuard.maxBudgetUSD.toFixed(2)} $</span>
                            </div>
                        </div>
                    )}

                    <select
                        onChange={(e) => setActiveTenderId(e.target.value)}
                        value={activeTenderId || ""}
                        className="text-xs font-bold border border-slate-800 rounded-xl bg-slate-900 text-slate-300 px-3 py-2.5 outline-none cursor-pointer max-w-[200px] truncate"
                    >
                        <option value="">📂 Wczytaj przetarg...</option>
                        {savedTendersList.map(t => (
                            <option key={t.id} value={t.id}>{t.name}</option>
                        ))}
                    </select>

                    {activeTenderId && (
                        <div className="flex gap-2">
                            <button
                                onClick={handleStopTender}
                                className="bg-red-600 hover:bg-red-700 text-white font-black text-xs px-4 py-2.5 rounded-xl shadow-md transition-all uppercase tracking-wider"
                            >
                                🛑 STOP
                            </button>
                            <button
                                onClick={handleDeleteTender}
                                className="bg-slate-900 hover:bg-red-950/40 hover:text-red-400 border border-slate-800 hover:border-red-900 text-slate-400 font-bold text-xs px-4 py-2.5 rounded-xl shadow-md transition-all"
                            >
                                🗑️ USUŃ
                            </button>
                        </div>
                    )}

                    <div className="text-right bg-blue-600 text-white px-5 py-2.5 rounded-2xl shadow-md">
                        <span className="text-[9px] font-black text-blue-200 uppercase block">Wartość Kosztorysu</span>
                        <span className="text-lg font-black tracking-tight">{Math.round(totals).toLocaleString()} PLN</span>
                    </div>
                </div>
            </div>

            {/* TRZYKOLUMNOWY UKŁAD ROBOCZY */}
            <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-5 overflow-hidden min-h-0">

                {/* LEWA KOLUMNA: Pliki, Zadania i Konflikty */}
                <div className="lg:col-span-3 bg-slate-900/50 border border-slate-800/80 rounded-3xl p-4 flex flex-col gap-4 overflow-y-auto custom-scrollbar">

                    {/* Upload */}
                    <div>
                        <span className="text-[9px] font-black uppercase text-slate-500 block mb-1">Baza Wiedzy Projektu</span>
                        <div
                            onClick={() => document.getElementById("file-upload-input")?.click()}
                            className="border-2 border-dashed border-slate-800 hover:border-blue-500/40 rounded-2xl p-4 text-center cursor-pointer transition-all bg-slate-950/40 min-h-[80px] flex flex-col items-center justify-center"
                        >
                            {isUploading ? (
                                <span className="text-[10px] text-blue-400 animate-pulse font-bold">{uploadMsg}</span>
                            ) : (
                                <>
                                    <span className="text-lg mb-1">📥</span>
                                    <span className="text-[10px] font-bold text-slate-400">Przeciągnij ZIP (SWZ + Rysunki)</span>
                                </>
                            )}
                            <input type="file" id="file-upload-input" onChange={e => e.target.files && handleFileUpload(e.target.files)} className="hidden" accept=".zip,.pdf" multiple />
                        </div>
                    </div>

                    {/* Lista Dokumentów */}
                    {documents.length > 0 && (
                        <div className="space-y-1.5">
                            {documents.map(doc => (
                                <div
                                    key={doc.id}
                                    onClick={async () => {
                                        if (doc.tags.includes("INNY")) return; // Zabezpieczenie przed dziwnymi plikami
                                        setIsLoadingPreview(true);
                                        setPreviewUrl(null); // Reset
                                        try {
                                            const res = await fetch("/api/kosztorysant/dokumenty/podglad", {
                                                method: "POST", headers: { "Content-Type": "application/json" },
                                                body: JSON.stringify({ storagePath: doc.storagePath })
                                            });
                                            const data = await res.json();
                                            if (data.url) setPreviewUrl(data.url);
                                        } catch (e) { alert("Nie udało się pobrać podglądu."); }
                                        setIsLoadingPreview(false);
                                    }}
                                    className="bg-slate-950 p-2 rounded-xl border border-slate-800/50 flex flex-col gap-1 cursor-pointer hover:border-blue-500/50 transition-colors group"
                                >
                                    <div className="flex justify-between items-center">
                                        <div className="flex items-center gap-1.5 truncate">
                                            <span className="text-[10px] group-hover:text-blue-400 transition-colors">📄</span>
                                            <span className="text-[10px] text-slate-300 font-semibold truncate max-w-[150px] group-hover:text-blue-300">{doc.fileName}</span>
                                        </div>
                                        <span className="text-[10px] text-slate-300 font-semibold truncate max-w-[180px]">{doc.fileName}</span>
                                        <span className="text-[8px] text-slate-500 uppercase">{doc.status}</span>
                                    </div>
                                    <div className="flex gap-1 flex-wrap items-center">
                                        {doc.tags?.map(tag => (
                                            <span key={tag} className="text-[8px] bg-slate-800 text-slate-400 px-1.5 py-0.5 rounded">{tag}</span>
                                        ))}
                                        {doc.detailedElement && doc.detailedElement !== "NIE_DOTYCZY" && (
                                            <span className="text-[8px] bg-blue-950/60 text-blue-300 border border-blue-900/40 px-1.5 py-0.5 rounded font-bold uppercase tracking-tight flex items-center gap-1">
                                                🔍 {doc.detailedElement}
                                            </span>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}

                    {/* Szyna Zadań (Tasks) */}
                    {tasks.length > 0 && (
                        <div className="space-y-2 border-t border-slate-800/60 pt-3">
                            <span className="text-[9px] font-black uppercase text-slate-500 block">Aktywność Agentów</span>
                            <div className="space-y-1.5 bg-slate-950 p-3 rounded-2xl border border-slate-800/40 max-h-48 overflow-y-auto custom-scrollbar">
                                {tasks.map(t => (
                                    <div key={t.id} className="flex flex-col gap-1 border-b border-slate-800/50 pb-1.5 last:border-0 last:pb-0">
                                        <div className="flex justify-between items-center text-[10px] mb-0.5">
                                            <span className="text-blue-400 font-black tracking-tight">{t.agentType}</span>
                                            <span className={`px-1.5 py-0.5 rounded text-[8px] font-black uppercase ${t.status === "DONE" ? "bg-green-500/20 text-green-400" : t.status === "IN_PROGRESS" ? "bg-blue-500/20 text-blue-400 animate-pulse" : t.status === "ERROR" ? "bg-red-500/20 text-red-400" : "bg-slate-800 text-slate-500"}`}>{t.status}</span>
                                        </div>

                                        <div className="flex flex-col gap-1 text-[9px] leading-tight">
                                            <span className="text-slate-400 font-mono italic">
                                                💬 Polecenie: "{t.instruction || t.description || "Planowanie..."}"
                                            </span>

                                            {t.status === "DONE" && t.rawResult?.summary && (
                                                <span className="text-green-400 font-bold bg-green-950/20 px-1.5 py-1 rounded border border-green-900/30 text-[8px] mt-0.5">
                                                    ✓ Wynik: {t.rawResult.summary}
                                                </span>
                                            )}

                                            {t.status === "ERROR" && t.rawResult?.error && (
                                                <span className="text-red-400 font-bold bg-red-950/20 px-1.5 py-1 rounded border border-red-900/30 text-[8px] mt-0.5">
                                                    ❌ Błąd: {t.rawResult.error}
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Kognitywna Checklista Technologa */}
                    {technologistFindings.length > 0 && (
                        <div className="space-y-2 border-t border-slate-800/60 pt-3">
                            <span className="text-[9px] font-black uppercase text-blue-400 block flex items-center gap-1">
                                🏗️ Checklista Technologa (Wymogi Projektu)
                            </span>
                            <div className="space-y-2 max-h-60 overflow-y-auto custom-scrollbar">
                                {technologistFindings.map(finding => (
                                    <div key={finding.id} className="p-3 bg-slate-950/80 border border-slate-800/80 rounded-2xl text-[10px] flex flex-col gap-1.5 hover:border-blue-500/30 transition-colors">
                                        <div className="flex justify-between items-center">
                                            <span className="font-black text-blue-400 uppercase text-[8px] tracking-wider px-1.5 py-0.5 bg-blue-950/40 rounded border border-blue-900/30">
                                                {finding.category}
                                            </span>
                                            <span className="text-[8px] text-slate-500 font-bold font-mono">
                                                Pewność: {finding.confidence}%
                                            </span>
                                        </div>

                                        <div className="space-y-1 text-slate-300">
                                            {Object.entries(finding.facts || {}).map(([key, val]) => (
                                                <div key={key} className="flex justify-between border-b border-slate-900/50 py-0.5 last:border-0 last:pb-0">
                                                    <span className="text-slate-500 font-mono text-[8px]">{key}:</span>
                                                    <span className="text-slate-200 font-medium font-sans truncate max-w-[120px]">{String(val)}</span>
                                                </div>
                                            ))}
                                        </div>

                                        {finding.normBasis && (
                                            <div className="text-[8px] text-slate-500 italic mt-1 border-t border-slate-900/50 pt-1 flex items-center gap-1">
                                                ⚖️ Podstawa: {finding.normBasis}
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Sąd Roju (Konflikty) */}
                    {conflicts.length > 0 && (
                        <div className="space-y-2 border-t border-slate-800/60 pt-3">
                            <span className="text-[9px] font-black uppercase text-red-500 block flex items-center gap-1">
                                <span className="animate-ping w-1.5 h-1.5 bg-red-500 rounded-full inline-block"></span>
                                Sąd Roju (Wymagana Decyzja)
                            </span>
                            <div className="space-y-2">
                                {conflicts.map(c => (
                                    <div key={c.id} className="p-3 bg-red-950/20 border border-red-500/20 rounded-2xl text-[10px]">
                                        <p className="font-bold text-red-400 mb-1.5">{c.topic}</p>
                                        <div className="space-y-1.5 text-slate-400 mb-2">
                                            {c.parties.map((p, idx) => (
                                                <div key={idx} className="bg-slate-950/50 p-1.5 rounded border border-slate-800/50">
                                                    <span className="font-bold text-slate-300">{p.agent}:</span> <span className="text-white">"{p.claim}"</span>
                                                    <div className="text-[8px] text-slate-500 mt-0.5">Źródło: {p.sourceDoc}</div>
                                                </div>
                                            ))}
                                        </div>
                                        {c.status !== "RESOLVED" ? (
                                            <div className="flex flex-col gap-1.5">
                                                {c.parties.map((p, idx) => (
                                                    <button
                                                        key={idx}
                                                        onClick={() => resolveConflict(c.id, p.claim, `Decyzja: ${p.claim}`)}
                                                        className="bg-red-900/30 hover:bg-red-900/60 border border-red-900/50 text-red-200 px-2 py-1.5 rounded-lg text-[9px] font-bold transition-colors text-left"
                                                    >
                                                        Zatwierdź: {p.claim}
                                                    </button>
                                                ))}
                                            </div>
                                        ) : (
                                            <p className="mt-2 text-green-400 font-bold bg-green-900/20 p-1.5 rounded border border-green-900/30">✓ Wybrano: {c.resolution?.decision}</p>
                                        )}
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>

                {/* ŚRODKOWA KOLUMNA: Konsola Mózgu (Orkiestrator) */}
                <div className="lg:col-span-4 bg-slate-900 rounded-3xl flex flex-col overflow-hidden border border-slate-800 shadow-lg">
                    <div className="p-4 bg-slate-950 border-b border-slate-800 flex items-center justify-between">
                        <div className="flex items-center gap-3">
                            <div className="w-8 h-8 bg-blue-600 rounded-full flex items-center justify-center text-base shadow-[0_0_15px_rgba(37,99,235,0.5)]">🧠</div>
                            <div>
                                <h3 className="font-black text-white text-xs uppercase tracking-wider">Orkiestrator (Gemini Pro)</h3>
                                <p className="text-[9px] text-blue-400 font-bold">
                                    Faza: <span className="text-white">{brainState?.phase || "OCZEKIWANIE"}</span>
                                </p>
                            </div>
                        </div>
                        {brainState?.currentGoal && (
                            <div className="text-right max-w-[150px]">
                                <span className="text-[8px] text-slate-500 uppercase block">Aktualny Cel</span>
                                <span className="text-[9px] text-slate-300 truncate block">{brainState.currentGoal}</span>
                            </div>
                        )}
                    </div>

                    <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-slate-950/40 custom-scrollbar">
                        {/* BANER DLA TRYBU WYCENY KONCEPCYJNEJ */}
                        {brainState?.assumptionMode && !assumptionsAccepted && (
                            <div className="bg-amber-950/95 border-2 border-amber-500/50 p-5 rounded-3xl text-amber-200 text-xs mb-6 shadow-[0_0_20px_rgba(245,158,11,0.2)] animate-in fade-in zoom-in duration-300 flex-shrink-0">
                                <div className="font-black mb-3 uppercase flex items-center gap-2 text-amber-400">
                                    <span className="text-lg">⚠️</span> TRYB WYCENY KONCEPCYJNEJ AKTYWNY
                                </div>
                                <p className="leading-relaxed mb-4 font-medium italic opacity-90 border-l-2 border-amber-500/30 pl-3">
                                    "{brainState.assumptionDisclaimer}"
                                </p>

                                <div className="flex gap-2">
                                    <button
                                        onClick={handleAcceptAssumptions}
                                        className="flex-1 bg-amber-600 hover:bg-amber-500 text-white px-4 py-3 rounded-2xl text-[10px] font-black uppercase transition-all shadow-md active:scale-95"
                                    >
                                        ✅ Akceptuję założenia
                                    </button>
                                    <button
                                        onClick={handleRejectAssumptions}
                                        className="bg-slate-900 hover:bg-red-950 border border-slate-700 hover:border-red-500/50 px-4 py-3 rounded-2xl text-[10px] font-black uppercase text-slate-400 hover:text-red-400 transition-all active:scale-95"
                                    >
                                        🛑 Wstrzymaj
                                    </button>
                                </div>
                            </div>
                        )}

                        {chatMessages.length === 0 && (
                            <div className="text-center text-slate-500 text-xs mt-10">
                                Wgraj dokumentację lub zadaj pytanie, aby wybudzić Mózg.
                            </div>
                        )}
                        {chatMessages.map((msg) => (
                            <div key={msg.id} className={`flex flex-col max-w-[90%] ${msg.role === "user" ? "ml-auto items-end" : "mr-auto items-start"}`}>
                                <span className="text-[8px] text-slate-500 mb-1 px-1 uppercase font-bold">{msg.role === "user" ? "Ty" : "Mózg"}</span>
                                <div className={`p-3 rounded-2xl text-xs leading-relaxed shadow-sm ${msg.role === "user" ? "bg-blue-600 text-white rounded-br-none" : "bg-slate-800 text-slate-200 rounded-bl-none border border-slate-700/50"}`}>
                                    {msg.content}
                                </div>
                            </div>
                        ))}
                        <div ref={chatEndRef} />
                    </div>

                    <div className="p-3 bg-slate-950 border-t border-slate-800 flex gap-2">
                        <input
                            type="text"
                            value={inputText}
                            onChange={e => setInputText(e.target.value)}
                            onKeyDown={e => e.key === 'Enter' && handleSendMessage()}
                            placeholder="Wydaj polecenie Mózgowi..."
                            className="flex-1 bg-slate-900 text-white border border-slate-700 rounded-xl px-3 py-2.5 text-xs outline-none focus:border-blue-500 transition-colors"
                        />
                        <button onClick={handleSendMessage} className="bg-blue-600 hover:bg-blue-500 text-white font-black text-xs px-5 rounded-xl transition-all shadow-md">WYŚLIJ</button>
                    </div>
                </div>

                {/* PRAWA KOLUMNA: Żywy Kosztorys (Estimate) */}
                <div className="lg:col-span-5 bg-slate-900/20 border border-slate-800/80 rounded-3xl p-5 flex flex-col overflow-hidden">
                    <div className="border-b border-slate-800 pb-3 mb-4 flex justify-between items-center">
                        <h3 className="font-black text-xs text-slate-400 uppercase tracking-wider flex items-center gap-2">
                            📋 Żywy Kosztorys (Broker Cenowy)
                        </h3>
                    </div>

                    <div className="flex-1 overflow-y-auto min-h-0 space-y-4 pr-1 custom-scrollbar">
                        {sections.length === 0 && (
                            <div className="text-center text-slate-500 text-xs mt-10 border border-dashed border-slate-800 p-6 rounded-2xl">
                                Brak wycenionych pozycji. Mózg analizuje dokumentację i zleca zadania agentom.
                            </div>
                        )}
                        {sections.map(sec => (
                            <div key={sec.id} className="space-y-2">
                                <div className="bg-slate-900/80 px-3 py-2.5 rounded-xl flex justify-between items-center border border-slate-800 shadow-sm">
                                    <span className="text-[10px] font-black uppercase text-slate-300">{sec.section}</span>
                                    <span className="text-xs font-black text-blue-400">{Math.round(sec.totalValue).toLocaleString()} zł</span>
                                </div>
                                <div className="space-y-1.5 pl-2">
                                    {sec.items?.map(item => (
                                        <div key={item.id} className="border border-slate-800/60 p-3 rounded-2xl bg-slate-950/60 flex justify-between items-center gap-3 hover:border-slate-700 transition-colors">
                                            <div className="min-w-0 flex-1">
                                                <div className="flex items-center gap-2 flex-wrap mb-1">
                                                    <span className="text-[9px] font-black px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700">{item.pozycja}</span>
                                                    {item.KNR_ref && <span className="text-[8px] text-blue-400 font-mono bg-blue-900/20 px-1 rounded">{item.KNR_ref}</span>}
                                                </div>
                                                <p className="text-[10px] text-slate-300 font-medium leading-tight">{item.opis}</p>
                                                {item.sourceTrack && (
                                                    <p className="text-[8px] text-slate-500 mt-1.5 font-mono truncate">Źródło: {item.sourceTrack}</p>
                                                )}
                                            </div>
                                            <div className="text-right flex-shrink-0 bg-slate-900 p-2 rounded-xl border border-slate-800/50 min-w-[80px]">
                                                <span className="text-xs font-bold text-white block">
                                                    {item.ilosc} <span className="text-[10px] text-slate-400 font-normal">{item.jednostka || 'j.m.'}</span>
                                                </span>
                                                <span className="text-[9px] text-slate-400 font-medium block mt-0.5">x {item.cenaJed} zł</span>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </div>

            {/* BOCZNY DRAWER PODGLĄDU PDF */}
            <div className={`absolute top-0 right-0 h-full bg-slate-900 border-l border-slate-700 shadow-2xl transition-all duration-300 ease-in-out z-50 flex flex-col ${previewUrl || isLoadingPreview ? 'w-1/2 translate-x-0' : 'w-0 translate-x-full'}`}>
                <div className="flex justify-between items-center p-3 border-b border-slate-800 bg-slate-950 flex-shrink-0">
                    <h3 className="text-xs font-black uppercase text-blue-400 flex items-center gap-2">
                        👁️ Podgląd Dokumentu
                    </h3>
                    <button
                        onClick={() => setPreviewUrl(null)}
                        className="bg-slate-800 hover:bg-red-500/20 text-slate-400 hover:text-red-400 px-3 py-1 rounded text-[10px] font-bold uppercase transition-colors"
                    >
                        Zamknij ✕
                    </button>
                </div>
                <div className="flex-1 bg-slate-950/50 flex items-center justify-center relative">
                    {isLoadingPreview && (
                        <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-400">
                            <span className="text-3xl animate-spin mb-3">⚙️</span>
                            <span className="text-xs font-bold uppercase">Pobieranie pliku z chmury...</span>
                        </div>
                    )}
                    {previewUrl && (
                        <iframe
                            src={previewUrl}
                            className="w-full h-full border-none"
                            title="PDF Preview"
                        />
                    )}
                </div>
            </div>

            {/* Style dla customowego scrollbara */}
            <style dangerouslySetInnerHTML={{
                __html: `
                .custom-scrollbar::-webkit-scrollbar { width: 4px; }
                .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
                .custom-scrollbar::-webkit-scrollbar-thumb { background: #334155; border-radius: 4px; }
                .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #475569; }
            `}} />
        </div>
    );
}