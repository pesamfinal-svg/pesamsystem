"use client";

import { useState, useEffect, useRef } from "react";
import { useAuth } from "@/lib/auth/AuthContext";
import { hasPermission } from "@/lib/auth/permissions";
import { useRouter } from "next/navigation";
import { uploadTenderDocument, UploadProgress } from "@/lib/kosztorysant/uploadTenderDocument";
import { db } from "@/lib/firebase/config";
import { collection, onSnapshot, doc, updateDoc, runTransaction, getDocs, query, where } from "firebase/firestore";
import { ScopeHeatMap } from '@/components/ScopeHeatMap';

// ─── TYPY DANYCH ─────────────────────────────────────────────────────────────

interface EstimateItem {
    id: string;
    code?: string;
    name: string;
    type: "R" | "M" | "S";
    quantity: number;
    unit: string;
    basePrice: number;
    unitPrice: number;
    complexity?: string;
    priceConfidence?: string;
    priceRange?: { min: number; optimal: number; max: number; unit: string };
    dataQuality?: {
        method: "FROM_DRAWING" | "NORMATIVE" | "PARAMETRIC" | "ASSUMED" | "GAP_FILLED" | "USER_INPUT";
        confidence: "HIGH" | "MEDIUM" | "LOW";
        riskBuffer: number;
        notes: string[];
    };
}

interface EstimateSection {
    id: string;
    name: string;
    items: EstimateItem[];
}

interface ProjectInfo {
    name: string;
    length: string;
    width: string;
    depthHeight: string;
    soilType: string;
    additionalNotes: string;
}

interface MarketTrends {
    laborAdjustment: number;
    materialAdjustment: number;
    equipmentAdjustment: number;
    kp: number;
    zysk: number;
}

interface SwarmTask {
    id: string;
    agentType: "ANALITYK_ZAKRESU" | "LEGAL" | "QUANTITY" | "CONSTRUCTION" | "PRICING" | "VISION" | "AUDIT" | "NORMATIVE_STEEL" | "PARAMETRIC_ESTIMATE" | "GAP_FILLER";
    description: string;
    status: "PENDING" | "IN_PROGRESS" | "DONE" | "ERROR";
    inputFiles: string[];
    result: any;
    taskKeywords?: string[];
    payload?: any; // 👈 DODANA WŁAŚCIWOŚĆ DLA TS
}

interface TenderMetadata {
    docLevel?: string;
    estimationMethod?: string;
    uncertaintyPercent?: number;
    missingDataReport?: { item: string; impact: string; assumption: string; riskAddPercent: number }[];
}

// ============================================================
// POMOCNIK: Ekstrakcja treści dokumentów tekstowych dla AI
// ============================================================
async function fetchTextFileContents(tenderId: string) {
    console.log(`%c[Pobieranie Plików] 📄 Rozpoczynam wyciąganie tekstów dla projektu: ${tenderId}`, "color: #3b82f6; font-weight: bold;");

    const filesSnapshot = await getDocs(
        collection(db, `tenders/${tenderId}/files`)
    );

    const textCategories = ['SWZ', 'PFU', 'OPZ', 'UMOWA', 'OPIS'];
    const results = [];

    for (const fileDoc of filesSnapshot.docs) {
        const fileData = fileDoc.data();
        if (!textCategories.includes(fileData.category?.toUpperCase())) continue;

        console.log(`%c[Pobieranie Plików] -> Pobrano treść z pliku: "${fileData.fileName}" (${fileData.category})`, "color: #10b981;");
        results.push({
            fileName: fileData.fileName,
            category: fileData.category,
            content: fileData.extractedText ?? 'Pusty dokument lub brak przetworzonego OCR. Wykorzystaj heurystykę branżową.',
        });
    }

    console.log(`%c[Pobieranie Plików] ✅ Łącznie załadowano: ${results.length} plików tekstowych dla AI.`, "color: #3b82f6; font-weight: bold;");
    return results;
}

// ============================================================
// KOMPONENT GŁÓWNY PANELU KOSZTORYSOWEGO
// ============================================================

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

    // Główne stany
    const [project, setProject] = useState<ProjectInfo>({
        name: "Budowa Przedszkola Samorządowego",
        length: "40.0",
        width: "25.0",
        depthHeight: "1.20",
        soilType: "Grunt średni (kat. III)",
        additionalNotes: "Zbrojenie dołem i górą siatką fi 12, podbudowa z chudego betonu 10cm"
    });

    const [trends, setTrends] = useState<MarketTrends>({
        laborAdjustment: -5,
        materialAdjustment: 12,
        equipmentAdjustment: 3,
        kp: 65,
        zysk: 12
    });

    const [sections, setSections] = useState<EstimateSection[]>([]);
    const [riskAlerts, setRiskAlerts] = useState<string[]>([]);
    const [messages, setMessages] = useState<{ role: 'user' | 'ai'; content: string }[]>([
        {
            role: 'ai',
            content: "Cześć! Jestem Twoim Agentem Wyceny i Sprawdzania Ryzyka. Przeciągnij i upuść paczkę ZIP z dokumentacją przetargową lub ślepy kosztorys do pola po lewej stronie, aby automatycznie zbudować strukturę i wycenę."
        }
    ]);

    const [inputText, setInputText] = useState("");
    const [isLoading, setIsLoading] = useState(false);

    // Stany Drag & Drop
    const [isDragging, setIsDragging] = useState(false);
    const [uploadedFile, setUploadedFile] = useState<File | null>(null);
    const [isUploading, setIsUploading] = useState(false);
    const [uploadPercent, setUploadPercent] = useState<number | undefined>(undefined);
    const [uploadMsg, setUploadMsg] = useState<string>("");

    // Stany Roju i Przetargu
    const [activeTenderId, setActiveTenderId] = useState<string | null>(null);
    const [tasks, setTasks] = useState<SwarmTask[]>([]);
    const [tenderStats, setTenderStats] = useState<TenderMetadata>({});

    const [activeTab, setActiveTab] = useState<"R" | "M" | "S" | "ALL">("ALL");
    const chatEndRef = useRef<HTMLDivElement | null>(null);

    // Stany zapisu/odczytu kosztorysu
    const [savedTendersList, setSavedTendersList] = useState<{ id: string, name: string, date: string }[]>([]);
    const [isSaving, setIsSaving] = useState(false);

    useEffect(() => {
        if (chatEndRef.current) chatEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }, [messages, isLoading]);

    // Pobieranie listy dostępnych wycen z bazy na starcie
    useEffect(() => {
        const fetchTenders = async () => {
            console.log("%c[Firestore] Pobieram listę wszystkich dotychczasowych wycen...", "color: #8b5cf6;");
            try {
                const snap = await getDocs(query(collection(db, "tenders")));
                const list = snap.docs.map(d => ({
                    id: d.id,
                    name: d.data().name || d.id,
                    date: d.data().createdAt || new Date().toISOString()
                })).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
                setSavedTendersList(list);
                console.log(`%c[Firestore] Załadowano ${list.length} wycen budowlanych.`, "color: #8b5cf6; font-weight: bold;");
            } catch (e) {
                console.error("[Firestore] Błąd pobierania listy wycen:", e);
            }
        };
        fetchTenders();
    }, []);

    // Zapisywanie stanu wyceny do bazy Firestore
    const handleSaveEstimate = async () => {
        if (!activeTenderId) {
            alert("Najpierw wgraj paczkę lub wczytaj projekt.");
            return;
        }
        console.log(`%c[Zapis] Inicjuję ręczny zapis kosztorysu dla projektu: ${activeTenderId}...`, "color: #ec4899; font-weight: bold;");
        setIsSaving(true);
        try {
            await updateDoc(doc(db, "tenders", activeTenderId), {
                sections,
                riskAlerts,
                project,
                trends,
                lastSavedAt: new Date().toISOString()
            });
            console.log(`%c[Zapis] Pomyślnie zsynchronizowano kosztorys i parametry z bazą Firestore.`, "color: #10b981; font-weight: bold;");
            setMessages(prev => [...prev, { role: "ai", content: `💾 Projekt "${project.name}" został pomyślnie zapisany w bazie.` }]);
        } catch (err) {
            console.error("[Zapis] Błąd zapisu kosztorysu:", err);
            alert("Błąd zapisu: " + err);
        } finally {
            setIsSaving(false);
        }
    };

    // Wczytywanie starego kosztorysu z bazy Firestore
    const handleLoadEstimate = async (e: React.ChangeEvent<HTMLSelectElement>) => {
        const tId = e.target.value;
        if (!tId) return;

        console.log(`%c[Odczyt] Inicjuję wczytywanie projektu z bazy Firestore: ${tId}`, "color: #3b82f6; font-weight: bold;");
        setIsLoading(true);
        try {
            const docRef = doc(db, "tenders", tId);
            const unsubscribeSingle = onSnapshot(docRef, (docSnap) => {
                if (docSnap.exists()) {
                    const data = docSnap.data();
                    setActiveTenderId(tId);
                    setProject(data.project || { name: data.name || "Wczytany Projekt", length: "", width: "", depthHeight: "", soilType: "", additionalNotes: "" });
                    setTrends(data.trends || { laborAdjustment: -5, materialAdjustment: 12, equipmentAdjustment: 3, kp: 65, zysk: 12 });
                    setSections(data.sections || []);
                    setRiskAlerts(data.riskAlerts || []);

                    console.log(`%c[Odczyt] Kosztorys dla ID: ${tId} wczytany poprawnie. Liczba sekcji: ${data.sections?.length || 0}`, "color: #10b981; font-weight: bold;");
                    setMessages([{ role: "ai", content: `📂 Wczytano projekt: ${data.name || tId}. Pliki źródłowe i mapa zakresu są przypięte. Możesz kontynuować analizę, zadać mi pytanie lub zmodyfikować kosztorys.` }]);
                }
                unsubscribeSingle();
            });
        } catch (err) {
            console.error("[Odczyt] Błąd wczytywania projektu:", err);
            alert("Błąd wczytywania: " + err);
        } finally {
            setIsLoading(false);
            e.target.value = "";
        }
    };

    // ── KROK 1: SŁUCHANIE METADANYCH PRZETARGU (REAL-TIME METADATA) ──────────
    useEffect(() => {
        if (!activeTenderId) return;

        console.log(`[Firestore] Podpinam nasłuch metadanych w czasie rzeczywistym dla: tenders/${activeTenderId}`);
        const tenderDocRef = doc(db, "tenders", activeTenderId);

        const unsubscribe = onSnapshot(tenderDocRef, (docSnap) => {
            if (docSnap.exists()) {
                const data = docSnap.data();
                setTenderStats({
                    docLevel: data.docLevel,
                    estimationMethod: data.estimationMethod,
                    uncertaintyPercent: data.uncertaintyPercent,
                    missingDataReport: data.missingDataReport
                });
                console.log(`[Firestore] Zaktualizowano metadane wyceny: Poziom = ${data.docLevel} | Niepewność = ${data.uncertaintyPercent}%`);
            }
        });

        return () => unsubscribe();
    }, [activeTenderId]);

    // ── KROK 2: SUBSKRYPCJA ZADAŃ W FIRESTORE (REAL-TIME LISTENER) ───────────
    const previousTasksRef = useRef<SwarmTask[]>([]);

    useEffect(() => {
        if (!activeTenderId) return;

        console.log(`[Firestore] Podpinam nasłuch zadań Roju w czasie rzeczywistym dla: tenders/${activeTenderId}/tasks`);

        const tasksRef = collection(db, "tenders", activeTenderId, "tasks");
        const unsubscribe = onSnapshot(tasksRef, (snapshot) => {
            const updatedTasks: SwarmTask[] = [];
            snapshot.forEach((doc) => {
                updatedTasks.push(doc.data() as SwarmTask);
            });

            // Generowanie komunikatów na czacie w momencie, gdy jakiś Agent rozpoczyna pracę lub wywali błąd
            const prevTasks = previousTasksRef.current;
            updatedTasks.forEach(newTask => {
                const oldTask = prevTasks.find(t => t.id === newTask.id);
                if ((!oldTask || oldTask.status === "PENDING") && newTask.status === "IN_PROGRESS") {
                    console.log(`%c[Rój PESAM] Agent ${newTask.agentType} zablokował i rozpoczął zadanie: "${newTask.description}"`, "color: #f59e0b;");
                    setMessages(prev => [...prev, {
                        role: "ai",
                        content: `🤖 [Rój] Agent **${newTask.agentType}** przystępuje do pracy: "${newTask.description}"...`
                    }]);
                }
                if (oldTask && oldTask.status === "IN_PROGRESS" && newTask.status === "ERROR") {
                    console.error(`[Rój PESAM] Awaria Agenta ${newTask.agentType} podczas wykonywania zadania.`);
                    setMessages(prev => [...prev, {
                        role: "ai",
                        content: `⚠️ [Błąd Roju] Agent **${newTask.agentType}** napotkał krytyczny błąd podczas przetwarzania zadania.`
                    }]);
                }
            });

            previousTasksRef.current = updatedTasks;
            setTasks(updatedTasks);
        });

        return () => unsubscribe();
    }, [activeTenderId]);

    // ── KROK 3: AUTOMATYCZNY SILNIK WYKONYWANIA ZADAŃ ROJU (WSPÓŁBIEŻNY - PROMISE.ALL) ──

    const runningTasksRef = useRef<Set<string>>(new Set());

    const isTaskReady = (task: SwarmTask, allTasks: SwarmTask[]): boolean => {
        if (task.status !== "PENDING") return false;
        if (runningTasksRef.current.has(task.id)) return false;

        const getTaskStatus = (type: string) => allTasks.find(t => t.agentType === type)?.status;

        switch (task.agentType) {
            case "ANALITYK_ZAKRESU":
                return true;

            case "LEGAL":
            case "VISION":
            case "PARAMETRIC_ESTIMATE": {
                const analitykStatus = getTaskStatus("ANALITYK_ZAKRESU");
                return analitykStatus === "DONE" || !analitykStatus;
            }

            case "QUANTITY":
            case "NORMATIVE_STEEL": {
                const visionStatus = getTaskStatus("VISION");
                return visionStatus === "DONE";
            }

            case "PRICING": {
                const knrStatus = getTaskStatus("QUANTITY");
                const parametricStatus = getTaskStatus("PARAMETRIC_ESTIMATE");
                const knrReady = knrStatus ? knrStatus === "DONE" : true;
                const parametricReady = parametricStatus ? parametricStatus === "DONE" : true;
                return knrReady && parametricReady;
            }

            case "GAP_FILLER": {
                const pricingStatus = getTaskStatus("PRICING");
                return pricingStatus === "DONE";
            }

            case "AUDIT": {
                const gapFillerStatus = getTaskStatus("GAP_FILLER");
                const legalStatus = getTaskStatus("LEGAL");

                const gapReady = gapFillerStatus ? gapFillerStatus === "DONE" : true;
                const legalReady = legalStatus ? legalStatus === "DONE" : true;
                return gapReady && legalReady;
            }

            default:
                return false;
        }
    };

    useEffect(() => {
        if (!activeTenderId || tasks.length === 0) return;

        const readyTasks = tasks.filter(t => isTaskReady(t, tasks));

        if (readyTasks.length > 0) {
            console.log(`%c[Rój PESAM] [Współbieżność] Wykryto ${readyTasks.length} zadań gotowych do równoległego uruchomienia: [${readyTasks.map(t => t.agentType).join(", ")}]`, "color: #10b981; font-weight: bold;");
            Promise.all(readyTasks.map(t => executeSwarmTask(t)));
        }
    }, [tasks, activeTenderId]);

    const resetStaleTasks = async (tenderId: string) => {
        console.log(`[Watchdog] Skanuję zadania o statusie IN_PROGRESS pod kątem zawieszenia...`);
        const staleThreshold = new Date(Date.now() - 5 * 60 * 1000).toISOString();
        const tasksRef = collection(db, "tenders", tenderId, "tasks");

        const staleSnap = await getDocs(
            query(tasksRef,
                where("status", "==", "IN_PROGRESS"),
                where("updatedAt", "<", staleThreshold)
            )
        );

        const resets = staleSnap.docs.map(docSnap => {
            console.warn(`[Watchdog] Resetuję zawieszone zadanie: ${docSnap.id}`);
            return updateDoc(docSnap.ref, { status: "PENDING", claimedAt: null, updatedAt: new Date().toISOString() });
        });

        await Promise.all(resets);
        if (resets.length > 0) {
            console.log(`[Watchdog] Odblokowano ${resets.length} zawieszonych procesów.`);
        }
    };

    useEffect(() => {
        if (activeTenderId) {
            resetStaleTasks(activeTenderId);
        }
    }, [activeTenderId]);

    // ── STRATEGICZNY WYKONAWCA ZADAŃ ROJU ──
    const executeSwarmTask = async (task: SwarmTask) => {
        runningTasksRef.current.add(task.id);
        setIsLoading(true);

        const taskDocRef = doc(db, "tenders", activeTenderId!, "tasks", task.id);

        try {
            const claimed = await runTransaction(db, async (tx) => {
                const snap = await tx.get(taskDocRef);
                if (snap.data()?.status !== "PENDING") return false;
                tx.update(taskDocRef, {
                    status: "IN_PROGRESS",
                    claimedAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString()
                });
                return true;
            });

            if (!claimed) {
                setIsLoading(false);
                return;
            }
        } catch (err) {
            console.error("[Rój] Błąd blokady zadania w Firestore:", err);
            setIsLoading(false);
            return;
        }

        try {
            let endpoint = "";
            let payload: any = {};

            if (task.agentType === "ANALITYK_ZAKRESU") {
                const fileContents = await fetchTextFileContents(activeTenderId!);
                endpoint = "/api/kosztorysant/agent-analityk-zakresu";
                payload = {
                    tenderId: activeTenderId,
                    fileContents,
                    docLevel: task.payload.docLevel,
                    estimationMethod: task.payload.estimationMethod,
                    sourceDocuments: task.payload.sourceDocuments,
                };
            }
            else if (task.agentType === "GAP_FILLER") {
                endpoint = "/api/kosztorysant/agent-gap-filler";
                payload = { tenderId: activeTenderId };
            }
            else if (task.agentType === "LEGAL") {
                endpoint = "/api/kosztorysant/czytacz-dokumentow";
                payload = { fileUrl: task.inputFiles[0], trends, taskKeywords: task.taskKeywords || [] };
            } else if (task.agentType === "QUANTITY") {
                endpoint = "/api/kosztorysant/agent-knr";
                payload = { request: task.description, currentTrends: trends, mode: "GENERATE_FROM_SCRATCH" };
            } else if (task.agentType === "VISION") {
                endpoint = "/api/kosztorysant/agent-vision-konstruktor";
                payload = { fileUrl: task.inputFiles[0], drawingHints: task.description };
            } else if (task.agentType === "NORMATIVE_STEEL") {
                const visionResult = tasks.find(t => t.agentType === "VISION" && t.status === "DONE")?.result;
                endpoint = "/api/kosztorysant/agent-normatywne-zbrojenie";
                payload = {
                    concreteElements: visionResult?.elements || [],
                    projectContext: project.name
                };
            } else if (task.agentType === "PARAMETRIC_ESTIMATE") {
                endpoint = "/api/kosztorysant/agent-wycena-wskaznikowa";
                payload = { request: task.description, region: project.soilType.includes("Rzeszów") ? "Podkarpackie" : "Polska" };
            } else if (task.agentType === "PRICING") {
                const quantityDone = tasks.find(t => t.agentType === "QUANTITY" && t.status === "DONE");
                const parametricDone = tasks.find(t => t.agentType === "PARAMETRIC_ESTIMATE" && t.status === "DONE");

                if (!quantityDone && !parametricDone) {
                    await updateDoc(taskDocRef, { status: "PENDING", claimedAt: null });
                    setIsLoading(false);
                    return;
                }
                const visionTask = tasks.find(t => t.agentType === "VISION" && t.status === "DONE");
                endpoint = "/api/kosztorysant/agent-broker-cenowy";
                payload = {
                    sections: sections,
                    region: "Polska",
                    projectContext: project.name,
                    visionSignals: visionTask?.result?.complexitySignals ?? null
                };
            } else if (task.agentType === "AUDIT") {
                const pendingTasks = tasks.filter(t => t.agentType !== "AUDIT" && t.status !== "DONE" && t.status !== "ERROR");
                if (pendingTasks.length > 0) {
                    await updateDoc(taskDocRef, { status: "PENDING", claimedAt: null });
                    setIsLoading(false);
                    return;
                }
                endpoint = "/api/kosztorysant/agent-rewident";
                payload = { tenderId: activeTenderId };
            }

            if (!endpoint) throw new Error(`Nieobsługiwany typ agenta: ${task.agentType}`);

            const res = await fetch(endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });

            if (!res.ok) throw new Error(`Błąd sieci HTTP ${res.status}`);
            const data = await res.json();

            await updateDoc(taskDocRef, {
                status: "DONE",
                result: data,
                updatedAt: new Date().toISOString()
            });

            // ── STRATEGICZNA AKTUALIZACJA CZATU I KOSZTORYSU NA FRONTENDZIE ──
            if (task.agentType === "ANALITYK_ZAKRESU" && data.success) {
                setMessages(prev => [...prev, {
                    role: "ai",
                    content: `🗺️ **Analityk Zakresu** pomyślnie wygenerował ScopeManifest:\n` +
                        `• Typ obiektu: **${data.summary.objectType.toUpperCase()}**\n` +
                        `• Branże kosztorysu: **${data.summary.divisionsCount}**\n` +
                        `• Wszystkich wymaganych elementów: **${data.summary.elementsCount}**\n` +
                        `• Warunków technicznych z SWZ: **${data.summary.hardRequirementsCount}**\n` +
                        `• Blokad decyzyjnych (ASK_USER): **${data.summary.askUserCount}**`
                }]);

                // 🧠 ODPYTANIE PESAM BRAIN O WIEDZĘ DLA TEGO TYPU OBIEKTU 🧠
                const objectType = data.summary.objectType;
                if (objectType && objectType !== 'inne') {
                    fetch(`/api/kosztorysant/brain/context?objectType=${objectType}`)
                        .then(res => res.json())
                        .then(brainContext => {
                            if (brainContext.hasLearned) {
                                setMessages(prev => [...prev, {
                                    role: "ai",
                                    content: `🧠 **PESAM Brain Zintegrowany z Projektem!**\nZnalazłem w bazie wskaźniki na podstawie **${brainContext.sampleCount} historycznych kosztorysów** dla typu "${objectType}". Zamiast ogólnych norm z Eurokodu, mój Gap Filler użyje Twoich własnych, wyuczonych standardów zużycia i proporcji!`
                                }]);
                            } else {
                                setMessages(prev => [...prev, {
                                    role: "ai",
                                    content: `⚠️ **PESAM Brain (Moduł Uczenia)**\nBrak wgranych przez Ciebie starych kosztorysów dla typu "${objectType}". Agenty (w tym Gap Filler) będą polegać na ogólnych, bezpiecznych normach inżynieryjnych (Eurokod/Sekocenbud).`
                                }]);
                            }
                        })
                        .catch(err => console.error("[PESAM Brain] Błąd połączenia z mózgiem:", err));
                }

            } else if (task.agentType === "GAP_FILLER" && data.success) {
                // Info o użyciu mózgu przez Gap Fillera
                if (data.usedBrain) {
                    setMessages(prev => [...prev, { role: "ai", content: `🧠 *W szacunkach luk użyłem spersonalizowanej wiedzy z historycznych projektów PESAM Brain.*` }]);
                }

                for (const msg of data.chatMessages ?? []) {
                    setMessages(prev => [...prev, { role: "ai", content: msg }]);
                }
                const freshTender = await getDocs(query(collection(db, "tenders"), where("id", "==", activeTenderId)));
                if (!freshTender.empty) {
                    setSections(freshTender.docs[0].data().sections || []);
                }
            } else if (task.agentType === "LEGAL" && data.riskAlerts) {
                setMessages(prev => [...prev, { role: "ai", content: `⚖️ [Dział Prawny] Zakończono analizę SWZ. Wykryto klauzule ryzyka. Sprawdź panel alertów po lewej stronie.` }]);
                setRiskAlerts(prev => Array.from(new Set([...prev, ...data.riskAlerts])));
            } else if (task.agentType === "NORMATIVE_STEEL" && data.sections) {
                setSections(prev => [...prev, ...data.sections]);
                setMessages(prev => [...prev, { role: "ai", content: `🏗️ [Konstruktor Zbrojenia] Obliczono wymaganą ilość stali: ${data.sections[0]?.items?.reduce((sum: number, item: any) => sum + item.quantity, 0).toFixed(2)} ton. Dodano pozycje kosztorysowe.` }]);
            } else if (task.agentType === "VISION" && data.elements) {
                setMessages(prev => [...prev, { role: "ai", content: `👁️ [Analityk Rysunków] Odczytano rysunki (${data.drawingType}). Wykryto ${data.elements.length} elementów nośnych i określono złożoność techniczną projektu jako ${data.complexitySignals?.overall}.` }]);
            } else if (task.agentType === "QUANTITY" && data.sections) {
                setSections(data.sections);
                setMessages(prev => [...prev, { role: "ai", content: `📐 [Przedmiarowanie] Zbudowano strukturę kosztorysu z poprawnymi kodami KNR. Wczytano ${data.sections.length} działów.` }]);
            } else if (task.agentType === "PARAMETRIC_ESTIMATE" && data.sections) {
                setSections(data.sections);
                setMessages(prev => [...prev, { role: "ai", content: `📊 [Wycena Parametryczna] ${data.parametricComment}` }]);
            } else if (task.agentType === "PRICING" && data.pricedItems) {
                setSections(prev => prev.map(sec => ({
                    ...sec,
                    items: sec.items.map(item => {
                        const priced = data.pricedItems.find((p: any) => p.itemId === item.id);
                        if (!priced) return item;
                        return {
                            ...item,
                            unitPrice: priced.recommendedPrice,
                            complexity: priced.complexity.level,
                            priceConfidence: priced.confidence,
                            priceRange: priced.priceRange
                        };
                    })
                })));
                setMessages(prev => [...prev, { role: "ai", content: `💰 [Broker Cenowy] ${data.marketSummary} Korekta cen dla ${data.pricedItems.length} pozycji powiodła się.` }]);
            } else if (task.agentType === "AUDIT" && data.report) {
                setMessages(prev => [...prev, { role: "ai", content: data.report.chatSummary }]);
                setRiskAlerts(prev => {
                    const newAlerts = [
                        ...data.report.deterministicAlerts.map((a: any) => a.message),
                        ...data.report.coverageAlerts.map((a: any) => a.message)
                    ];
                    return Array.from(new Set([...prev, ...newAlerts]));
                });
            } else {
                if (data.reply) setMessages(prev => [...prev, { role: "ai", content: data.reply }]);
                if (data.generatedSections) setSections(prev => [...prev, ...data.generatedSections]);
            }

        } catch (err: any) {
            console.error(`[Rój PESAM] Krytyczny błąd agenta ${task.agentType}:`, err);
            await updateDoc(taskDocRef, { status: "ERROR", error: err.message, updatedAt: new Date().toISOString() });
        } finally {
            runningTasksRef.current.delete(task.id);
            if (runningTasksRef.current.size === 0) {
                setIsLoading(false);
            }
        }
    };

    // ── OBSŁUGA PLIKÓW PRZETARGOWYCH (UPLOAD) ────────────────────────────────

    const handleFileUpload = async (file: File) => {
        setUploadedFile(file);
        setIsUploading(true);
        setIsLoading(true);

        setMessages(prev => [...prev, {
            role: 'user',
            content: `Wgrałem dokumentację przetargową: ${file.name}. Rozpocznij pełną analizę i wycenę.`
        }]);

        try {
            const result = await uploadTenderDocument(file, trends, (p: UploadProgress) => {
                setUploadMsg(p.message);
                if (p.stage === "uploading" && p.percent !== undefined) {
                    setUploadPercent(p.percent);
                } else {
                    setUploadPercent(undefined);
                }
            });

            if (result.reply) {
                setMessages(prev => [...prev, { role: "ai", content: result.reply }]);
            }

            if (result.generatedSections && result.generatedSections.length > 0) {
                setSections(prev => {
                    const merged = [...prev];
                    result.generatedSections!.forEach(newSec => {
                        const existingSecIdx = merged.findIndex(s => s.id === newSec.id || s.name === newSec.name);
                        if (existingSecIdx > -1) {
                            merged[existingSecIdx] = {
                                ...merged[existingSecIdx],
                                items: [...merged[existingSecIdx].items, ...newSec.items]
                            };
                        } else {
                            merged.push(newSec);
                        }
                    });
                    return merged;
                });
            }

            if (result.riskAlerts && result.riskAlerts.length > 0) {
                setRiskAlerts(prev => {
                    const mergedAlerts = Array.from(new Set([...prev, ...result.riskAlerts!]));
                    return mergedAlerts.filter(a => !a.startsWith("ℹ️ INFO:"));
                });
            }

            if (result.tenderId) {
                setActiveTenderId(result.tenderId);
                const pName = result.projectName || project.name;
                setProject(prev => ({ ...prev, name: pName }));

                setSavedTendersList(prev => [{
                    id: result.tenderId!,
                    name: pName,
                    date: new Date().toISOString()
                }, ...prev]);
            }

        } catch (err) {
            alert(err instanceof Error ? err.message : "Błąd połączenia z parserem dokumentacji.");
        } finally {
            setIsUploading(false);
            setIsLoading(false);
            setUploadPercent(undefined);
            setUploadMsg("");
        }
    };

    // ── METODY OBLICZANIA KOSZTORYSU (TRENDY I NARZUTY) ──────────────────────

    const calculateRowValue = (item: EstimateItem) => {
        let price = item.unitPrice || item.basePrice;

        if (item.type === "R") {
            price = price * (1 + trends.laborAdjustment / 100);
        } else if (item.type === "M") {
            price = price * (1 + trends.materialAdjustment / 100);
        } else if (item.type === "S") {
            price = price * (1 + trends.equipmentAdjustment / 100);
        }

        const directCost = (item.quantity ?? 1) * price;

        if (item.type === "R" || item.type === "S") {
            const kpVal = directCost * (trends.kp / 100);
            const zVal = (directCost + kpVal) * (trends.zysk / 100);
            return directCost + kpVal + zVal;
        }

        return directCost;
    };

    const getEstimateTotals = () => {
        let totalBase = 0;
        let totalMarket = 0;
        let totalRiskBufferPln = 0;

        sections.forEach(sec => {
            sec.items.forEach(item => {
                const qty = item.quantity ?? 1;
                const itemBase = qty * (item.unitPrice || item.basePrice);
                const itemMarket = calculateRowValue(item);

                totalBase += itemBase;
                totalMarket += itemMarket;

                if (item.dataQuality?.riskBuffer) {
                    totalRiskBufferPln += itemMarket * (item.dataQuality.riskBuffer / 100);
                }
            });
        });

        return { totalBase, totalMarket, totalRiskBufferPln };
    };

    const { totalBase, totalMarket, totalRiskBufferPln } = getEstimateTotals();

    const updateItemValue = (sectionId: string, itemId: string, field: "quantity" | "basePrice", value: number) => {
        setSections(prev => prev.map(sec => {
            const sId = sec.id || (sec as any).sectionId;
            if (sId !== sectionId) return sec;
            return {
                ...sec,
                items: sec.items.map(item => {
                    const iId = item.id || (item as any).itemId;
                    return iId === itemId ? { ...item, [field]: value } : item;
                })
            };
        }));
    };

    const removeItem = (sectionId: string, itemId: string) => {
        setSections(prev => prev.map(sec => {
            const sId = sec.id || (sec as any).sectionId;
            if (sId !== sectionId) return sec;
            return {
                ...sec,
                items: sec.items.filter(item => {
                    const iId = item.id || (item as any).itemId;
                    return iId !== itemId;
                })
            };
        }));
    };

    const handleAskEstimator = async () => {
        if (!inputText.trim()) return;

        const userMsg = inputText;
        setMessages(prev => [...prev, { role: 'user', content: userMsg }]);
        setInputText("");
        setIsLoading(true);

        try {
            const res = await fetch("/api/kosztorysant/glowny-kosztorysant", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    request: userMsg,
                    currentTrends: trends,
                    currentSections: sections,
                    tenderId: activeTenderId
                })
            });

            if (!res.ok) throw new Error("Błąd silnika RMS");
            const data = await res.json();

            setMessages(prev => [...prev, { role: 'ai', content: data.reply }]);

            if (data.generatedSections && data.generatedSections.length > 0) {
                setSections(data.generatedSections);
            }

        } catch (err) {
            alert("Błąd połączenia z silnikiem kosztorysowym.");
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div className="p-4 md:p-6 max-w-[1800px] mx-auto h-[90vh] flex flex-col relative animate-fade-in overflow-hidden text-slate-800 bg-slate-50">

            {/* ── Nagłówek ── */}
            <div className="flex justify-between items-center mb-4 border-b pb-4 bg-white p-4 rounded-3xl shadow-sm">
                <div>
                    <div className="flex items-center gap-2">
                        <span className="text-2xl">📊</span>
                        <h1 className="text-2xl font-black text-slate-800 tracking-tighter uppercase italic leading-none">Panel Kosztorysowania AI</h1>
                    </div>
                    <p className="text-xs text-slate-500 mt-1.5 font-semibold">
                        Projekt: <span className="font-bold text-slate-700">{project.name}</span> · ID: <span className="text-blue-600 font-bold">{activeTenderId || "Brak"}</span>
                    </p>
                </div>

                <div className="flex gap-4 items-center">

                    {/* ── Narzędzia zapisu i odczytu ── */}
                    <div className="flex items-center gap-2 border-r pr-4 mr-2 border-slate-200">
                        <select
                            onChange={handleLoadEstimate}
                            className="text-xs font-bold border border-slate-300 rounded-xl bg-slate-50 text-slate-700 px-3 py-2 outline-none cursor-pointer max-w-[180px] truncate hover:border-blue-500 transition-colors"
                        >
                            <option value="">📂 Wczytaj projekt z bazy...</option>
                            {savedTendersList.map(t => (
                                <option key={t.id} value={t.id}>{t.name}</option>
                            ))}
                        </select>

                        <button
                            onClick={handleSaveEstimate}
                            disabled={isSaving || !activeTenderId}
                            className="bg-slate-800 text-white text-[10px] font-black uppercase px-4 py-2.5 rounded-xl hover:bg-blue-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
                        >
                            {isSaving ? "⏳ Trwa Zapis..." : "💾 Zapisz Stan"}
                        </button>
                    </div>

                    <div className="text-right">
                        <span className="text-[9px] font-black text-slate-400 uppercase block">Cena Bazowa (Direct)</span>
                        <span className="text-sm font-bold text-slate-500 line-through">{totalBase.toLocaleString()} PLN</span>
                    </div>
                    {totalRiskBufferPln > 0 && (
                        <div className="text-right text-orange-600 font-bold px-3 py-1 bg-orange-50 border border-orange-200 rounded-2xl">
                            <span className="text-[9px] font-black uppercase block">Bufor Ryzyka PZP</span>
                            <span className="text-sm">+{Math.round(totalRiskBufferPln).toLocaleString()} PLN</span>
                        </div>
                    )}
                    <div className="text-right bg-blue-600 text-white px-5 py-2.5 rounded-2xl shadow-md">
                        <span className="text-[9px] font-black text-blue-200 uppercase block">Budżet Ofertowy (z Narzutami & Trendem)</span>
                        <span className="text-xl font-black tracking-tight">{Math.round(totalMarket).toLocaleString()} PLN</span>
                    </div>
                </div>
            </div>

            {/* ── Trzykolumnowy Layout ── */}
            <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-5 overflow-hidden min-h-0">

                {/* ── LEWA KOLUMNA: Mapa Ciepła Zakresu + Suwaki + Dropzone + Alerty (3/12) ── */}
                <div className="lg:col-span-3 bg-white border border-slate-200 rounded-3xl p-4 flex flex-col justify-between shadow-sm overflow-y-auto">
                    <div className="space-y-4">

                        {/* MAPA CIEPŁA SZCZELNOŚCI ZAKRESU (ScopeHeatMap) */}
                        <div className="border border-slate-100 rounded-2xl overflow-hidden shadow-xs">
                            <ScopeHeatMap tenderId={activeTenderId} />
                        </div>

                        {/* Dropzone Przetargowy */}
                        <div className="space-y-2 pt-2 border-t">
                            <label className="text-[10px] font-black uppercase text-slate-400">Paczka Przetargowa (ZIP/PDF/Excel):</label>
                            <div
                                onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
                                onDragLeave={() => setIsDragging(false)}
                                onDrop={async e => {
                                    e.preventDefault();
                                    setIsDragging(false);
                                    const file = e.dataTransfer.files[0];
                                    if (file) handleFileUpload(file);
                                }}
                                onClick={() => document.getElementById("tender-file-input")?.click()}
                                className={`border-2 border-dashed rounded-3xl p-4 text-center transition-all cursor-pointer flex flex-col items-center justify-center min-h-[115px] relative ${isDragging ? "border-blue-500 bg-blue-50/50" : "border-slate-200 hover:border-slate-300 bg-slate-50/50"}`}
                            >
                                {isUploading ? (
                                    <div className="flex flex-col items-center gap-2 w-full px-2">
                                        <span className="animate-spin text-lg text-blue-600">⏳</span>
                                        <span className="text-[9px] font-black uppercase text-blue-600 animate-pulse truncate max-w-full">{uploadMsg}</span>
                                        {uploadPercent !== undefined && (
                                            <div className="w-full bg-slate-200 h-1 rounded-full overflow-hidden mt-1">
                                                <div className="bg-blue-600 h-full transition-all duration-300" style={{ width: `${uploadPercent}%` }} />
                                            </div>
                                        )}
                                    </div>
                                ) : uploadedFile ? (
                                    <div className="flex flex-col items-center gap-1.5">
                                        <span className="text-xl">📄</span>
                                        <span className="text-[10px] font-bold text-slate-700 truncate max-w-[180px]" title={uploadedFile.name}>
                                            {uploadedFile.name}
                                        </span>
                                        <button
                                            onClick={e => { e.stopPropagation(); setUploadedFile(null); }}
                                            className="text-[9px] font-black text-red-500 hover:underline uppercase z-10"
                                        >Usuń plik</button>
                                    </div>
                                ) : (
                                    <div className="flex flex-col items-center gap-1.5">
                                        <span className="text-xl">📥</span>
                                        <p className="text-[10px] font-bold text-slate-500">Przeciągnij plik ZIP lub kliknij</p>
                                        <p className="text-[8px] text-slate-400 font-semibold">SWZ, OPZ, ślepy kosztorys, rysunki</p>
                                    </div>
                                )}
                                <input
                                    type="file"
                                    onChange={e => {
                                        const file = e.target.files?.[0];
                                        if (file) handleFileUpload(file);
                                    }}
                                    className="hidden"
                                    id="tender-file-input"
                                    accept=".zip,.pdf,.xlsx,.xls"
                                />
                            </div>
                        </div>

                        {/* PANEL ROJU AGENTÓW (REAL-TIME STATUS) */}
                        {tasks.length > 0 && (
                            <div className="space-y-2 pt-2 border-t">
                                <label className="text-[9px] font-black uppercase text-slate-400 block">Status pracy Roju PESAM:</label>
                                <div className="space-y-1.5 bg-slate-900 text-white p-3 rounded-2xl border border-slate-800">
                                    {tasks.map((task) => (
                                        <div key={task.id} className="flex items-center justify-between gap-2 text-[10px]">
                                            <span className="font-semibold text-slate-300 truncate max-w-[150px]">{task.agentType}: {task.description.slice(0, 25)}...</span>
                                            <span className={`px-2 py-0.5 rounded-full font-black text-[8px] uppercase tracking-wider ${task.status === "DONE" ? "bg-green-500/20 text-green-400" :
                                                task.status === "IN_PROGRESS" ? "bg-blue-500/20 text-blue-400 animate-pulse" :
                                                    task.status === "ERROR" ? "bg-red-500/20 text-red-400" :
                                                        "bg-slate-700 text-slate-400"
                                                }`}>
                                                {task.status === "IN_PROGRESS" ? "⏳ TRWA" : task.status === "DONE" ? "✓ OK" : task.status}
                                            </span>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* Alerty ryzyka kontraktowego (PZP / SWZ) */}
                        {riskAlerts.length > 0 && (
                            <div className="space-y-2 pt-2 border-t">
                                <label className="text-[9px] font-black uppercase text-slate-400 block">Alerty Ryzyka PZP / Kontraktowe:</label>
                                <div className="space-y-1.5 max-h-40 overflow-y-auto pr-1">
                                    {riskAlerts.map((alert, index) => {
                                        const isHighRisk = alert.startsWith("❗");
                                        const isWarning = alert.startsWith("⚠️");
                                        const isOk = alert.startsWith("✅");

                                        return (
                                            <div
                                                key={index}
                                                className={`p-2.5 rounded-xl border text-[10px] font-bold leading-normal ${isHighRisk ? "bg-red-500/10 border-red-500/30 text-red-700" :
                                                    isWarning ? "bg-amber-500/10 border-amber-500/30 text-amber-700" :
                                                        isOk ? "bg-green-500/10 border-green-500/30 text-green-700" :
                                                            "bg-slate-50 border-slate-200 text-slate-600"
                                                    }`}
                                            >
                                                {alert}
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        )}

                        {/* Suwaki Trendów i Wyceny */}
                        <div className="space-y-4 pt-2 border-t">
                            <div>
                                <div className="flex justify-between text-[10px] font-black uppercase text-amber-600 mb-1">
                                    <span>Korekta Robocizny (R):</span>
                                    <span>{trends.laborAdjustment}%</span>
                                </div>
                                <input
                                    type="range" min="-20" max="20" step="1"
                                    value={trends.laborAdjustment}
                                    onChange={e => setTrends({ ...trends, laborAdjustment: Number(e.target.value) })}
                                    className="w-full accent-amber-500 cursor-pointer h-1 bg-slate-100 rounded-lg appearance-none"
                                />
                            </div>

                            <div>
                                <div className="flex justify-between text-[10px] font-black uppercase text-green-600 mb-1">
                                    <span>Korekta Materiałów (M):</span>
                                    <span>+{trends.materialAdjustment}%</span>
                                </div>
                                <input
                                    type="range" min="-10" max="30" step="1"
                                    value={trends.materialAdjustment}
                                    onChange={e => setTrends({ ...trends, materialAdjustment: Number(e.target.value) })}
                                    className="w-full accent-green-500 cursor-pointer h-1 bg-slate-100 rounded-lg appearance-none"
                                />
                            </div>

                            <div className="border-t pt-3 space-y-3">
                                <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest block">Narzuty kosztorysowe (KNR)</span>
                                <div className="grid grid-cols-2 gap-3">
                                    <div>
                                        <label className="text-[8px] font-black text-slate-500 uppercase">Koszty Pośrednie (Kp %):</label>
                                        <input
                                            type="number"
                                            value={trends.kp}
                                            onChange={e => setTrends({ ...trends, kp: Number(e.target.value) })}
                                            className="w-full mt-1 p-2 border rounded-xl text-xs bg-slate-50 font-black text-center outline-none"
                                        />
                                    </div>
                                    <div>
                                        <label className="text-[8px] font-black text-slate-500 uppercase">Zysk (Z %):</label>
                                        <input
                                            type="number"
                                            value={trends.zysk}
                                            onChange={e => setTrends({ ...trends, zysk: Number(e.target.value) })}
                                            className="w-full mt-1 p-2 border rounded-xl text-xs bg-slate-50 font-black text-center outline-none"
                                        />
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                {/* ── ŚRODKOWA KOLUMNA: Konsola Czatu z AI (4/12) ── */}
                <div className="lg:col-span-4 bg-slate-900 rounded-3xl flex flex-col overflow-hidden shadow-sm">
                    <div className="p-4 bg-slate-950 border-b border-slate-800 flex items-center gap-3">
                        <div className="w-9 h-9 bg-blue-600 rounded-full flex items-center justify-center text-lg shadow-inner">👷</div>
                        <div>
                            <h3 className="font-black text-white text-xs uppercase tracking-wider leading-none">Konsola Głównego Kosztorysanta</h3>
                            <p className="text-[9px] text-blue-400 mt-1 font-bold">Wsparcie KNR, KNNR oraz Python Code Execution</p>
                        </div>
                    </div>

                    <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-slate-950/40">
                        {messages.map((msg, idx) => (
                            <div key={idx} className={`flex flex-col max-w-[90%] ${msg.role === 'user' ? 'ml-auto items-end' : 'mr-auto items-start'}`}>
                                <div className={`p-3 rounded-2xl text-xs leading-relaxed ${msg.role === 'user' ? 'bg-blue-600 text-white rounded-br-none font-semibold' : 'bg-slate-800 text-slate-200 border border-slate-700/80 rounded-bl-none'}`}>
                                    {msg.content}
                                </div>
                            </div>
                        ))}
                        {isLoading && (
                            <div className="flex items-center gap-2 text-slate-400 bg-slate-800 p-3 rounded-2xl w-fit rounded-bl-none">
                                <span className="animate-spin text-sm">⏳</span> <span className="text-[10px] font-black uppercase tracking-wider">Rój przetwarza dane w tle...</span>
                            </div>
                        )}
                        <div ref={chatEndRef} />
                    </div>

                    <div className="p-3 bg-slate-950 border-t border-slate-800 flex gap-2">
                        <input
                            type="text"
                            value={inputText}
                            onChange={e => setInputText(e.target.value)}
                            onKeyDown={e => e.key === 'Enter' && handleAskEstimator()}
                            placeholder="Wprowadź instrukcję lub zapytanie o pozycję..."
                            className="flex-1 bg-slate-800 text-white border border-slate-700 rounded-xl px-3 py-2.5 text-xs outline-none focus:border-blue-500 font-semibold"
                        />
                        <button
                            onClick={handleAskEstimator}
                            disabled={!inputText.trim() || isLoading}
                            className="bg-blue-600 hover:bg-blue-500 text-white font-black text-xs px-4 rounded-xl transition-all"
                        >
                            OBLICZ
                        </button>
                    </div>
                </div>

                {/* ── PRAWA KOLUMNA: Tabela Kosztorysu Przedmiarowego (5/12) ── */}
                <div className="lg:col-span-5 bg-white border border-slate-200 rounded-3xl p-5 flex flex-col justify-between shadow-sm overflow-hidden">
                    <div className="flex flex-col h-full overflow-hidden">

                        <div className="border-b pb-3 mb-4">
                            <h3 className="font-black text-xs text-slate-500 uppercase tracking-wider">📝 Podgląd Kosztorysu / Przedmiaru</h3>
                            <p className="text-[10px] text-slate-400 mt-0.5">Działy kosztorysu oparte o tabele KNR/KNNR i pozycje scalone</p>
                        </div>

                        {/* Filtrowanie zakładkami RMS */}
                        <div className="flex bg-slate-100 p-1 rounded-xl border mb-3 flex-shrink-0">
                            <button
                                onClick={() => setActiveTab("ALL")}
                                className={`flex-1 py-1 rounded-lg text-[8px] font-black uppercase transition-all ${activeTab === "ALL" ? "bg-white text-blue-600 shadow-sm" : "text-slate-500"}`}
                            >WSZYSTKO</button>
                            <button
                                onClick={() => setActiveTab("R")}
                                className={`flex-1 py-1 rounded-lg text-[8px] font-black uppercase transition-all ${activeTab === "R" ? "bg-white text-amber-600 shadow-sm" : "text-slate-500"}`}
                            >👷 Robocizna</button>
                            <button
                                onClick={() => setActiveTab("M")}
                                className={`flex-1 py-1 rounded-lg text-[8px] font-black uppercase transition-all ${activeTab === "M" ? "bg-white text-green-600 shadow-sm" : "text-slate-500"}`}
                            >🧱 Materiały</button>
                            <button
                                onClick={() => setActiveTab("S")}
                                className={`flex-1 py-1 rounded-lg text-[8px] font-black uppercase transition-all ${activeTab === "S" ? "bg-white text-purple-600 shadow-sm" : "text-slate-500"}`}
                            >🚜 Sprzęt</button>
                        </div>

                        {/* Lista działów i pozycji */}
                        <div className="flex-1 overflow-y-auto min-h-0 space-y-4 pr-1">
                            {sections.map(sec => {
                                const filteredItems = sec.items.filter(item => activeTab === "ALL" || item.type === activeTab);
                                if (filteredItems.length === 0) return null;

                                const sId = sec.id || (sec as any).sectionId;

                                return (
                                    <div key={sId} className="space-y-2">
                                        <div className="bg-slate-100 px-3 py-1.5 rounded-xl flex justify-between items-center border border-slate-200">
                                            <span className="text-[9px] font-black uppercase text-slate-600 tracking-tight">{sec.name || (sec as any).divisionName}</span>
                                            <span className="text-[9px] font-black text-blue-600">
                                                {Math.round(filteredItems.reduce((sum, item) => sum + calculateRowValue(item), 0)).toLocaleString()} zł
                                            </span>
                                        </div>

                                        <div className="space-y-2 pl-2">
                                            {filteredItems.map(item => {
                                                const adjustedValue = calculateRowValue(item);
                                                const qty = item.quantity ?? 1;
                                                const baseValue = qty * (item.unitPrice || item.basePrice);
                                                const iId = item.id || (item as any).itemId;

                                                const isGapFilled = item.dataQuality?.method === 'GAP_FILLED' || (item as any).source === 'GAP_FILLED';

                                                return (
                                                    <div key={iId} className={`border p-3 rounded-2xl bg-white shadow-sm flex items-center justify-between gap-3 hover:border-slate-200 transition-colors ${isGapFilled ? 'border-amber-100 bg-amber-50/10' : 'border-slate-100'}`}>
                                                        <div className="flex-1 min-w-0">
                                                            <div className="flex items-center gap-1.5 flex-wrap">
                                                                <span className={`text-[7px] font-black px-1.5 py-0.5 rounded ${item.type === "R" ? "bg-amber-100 text-amber-700" :
                                                                    item.type === "M" || !item.type ? "bg-green-100 text-green-700" :
                                                                        "bg-purple-100 text-purple-700"
                                                                    }`}>
                                                                    {item.type || 'M'}
                                                                </span>
                                                                {item.code && <span className="text-[8px] text-slate-400 font-mono font-bold">{item.code}</span>}

                                                                {/* Wyświetlanie Złożoności od Brokera */}
                                                                {item.complexity && (
                                                                    <span className={`text-[7px] font-black px-1.5 py-0.5 rounded ${item.complexity === 'SIMPLE' ? 'bg-green-50 text-green-700' :
                                                                        item.complexity === 'VERY_COMPLEX' ? 'bg-red-100 text-red-700 font-extrabold' :
                                                                            item.complexity === 'COMPLEX' ? 'bg-amber-100 text-amber-700 font-bold' :
                                                                                'bg-slate-200 text-slate-700'
                                                                        }`}>
                                                                        {item.complexity}
                                                                    </span>
                                                                )}
                                                                {(item.priceConfidence === 'MARKET_VERIFIED' || item.priceConfidence === 'MARKET_VERIFIED') && (
                                                                    <span title="Cena zweryfikowana w hurtowniach online przez AI" className="text-[10px] cursor-help">🌐</span>
                                                                )}

                                                                {/* ── NOWE: PASEK JAKOŚCI DANYCH I REZERWY ── */}
                                                                {item.dataQuality && (
                                                                    <div className="flex items-center gap-1 bg-slate-50 px-1.5 py-0.5 rounded border text-[7px] font-bold text-slate-500">
                                                                        <span className={`w-1.5 h-1.5 rounded-full ${item.dataQuality.confidence === 'HIGH' ? 'bg-green-500' :
                                                                            item.dataQuality.confidence === 'MEDIUM' ? 'bg-amber-500' : 'bg-red-500'
                                                                            }`} />
                                                                        <span>{item.dataQuality.method}</span>
                                                                        {item.dataQuality.riskBuffer > 0 && (
                                                                            <span className="text-orange-600 font-black">+{item.dataQuality.riskBuffer}% rezerwy</span>
                                                                        )}
                                                                    </div>
                                                                )}
                                                            </div>
                                                            <p className="text-[11px] font-bold text-slate-800 truncate mt-1 leading-tight uppercase" title={item.name}>{item.name}</p>

                                                            {/* Notatki techniczne o brakach / założeniach */}
                                                            {item.dataQuality?.notes && item.dataQuality.notes.length > 0 && (
                                                                <div className="text-[8px] italic text-slate-400 mt-0.5 leading-normal max-w-md">
                                                                    {item.dataQuality.notes.join("; ")}
                                                                </div>
                                                            )}

                                                            <div className="text-[9px] font-semibold text-slate-400 mt-1 flex gap-2">
                                                                <span>Baza: {Math.round(baseValue).toLocaleString()} zł</span>
                                                                <span className="text-blue-500 font-bold">Po korekcie: {Math.round(adjustedValue).toLocaleString()} zł</span>
                                                            </div>
                                                        </div>

                                                        {/* Panel edycji na żywo */}
                                                        <div className="flex items-center gap-1.5 flex-shrink-0">
                                                            <div className="flex flex-col items-center">
                                                                <span className="text-[7px] font-black text-slate-400 uppercase leading-none mb-0.5">Ilość</span>
                                                                <div className="flex items-center gap-0.5 bg-slate-50 px-1.5 py-1 rounded-lg border">
                                                                    <input
                                                                        type="number" step="1"
                                                                        value={item.quantity ?? 1}
                                                                        onChange={e => updateItemValue(sId, iId, "quantity", Number(e.target.value))}
                                                                        className="w-10 bg-transparent text-center font-black text-[10px] outline-none"
                                                                    />
                                                                    <span className="text-[7px] text-slate-400 font-bold">{item.unit || 'szt.'}</span>
                                                                </div>
                                                            </div>

                                                            <div className="flex flex-col items-center">
                                                                <span className="text-[7px] font-black text-slate-400 uppercase leading-none mb-0.5">Cena b.</span>
                                                                <div className="flex items-center gap-0.5 bg-slate-50 px-1.5 py-1 rounded-lg border">
                                                                    <input
                                                                        type="number"
                                                                        value={item.unitPrice || item.basePrice}
                                                                        onChange={e => updateItemValue(sId, iId, "basePrice", Number(e.target.value))}
                                                                        className="w-10 bg-transparent text-center font-black text-[10px] outline-none"
                                                                    />
                                                                    <span className="text-[7px] text-slate-400 font-bold">zł</span>
                                                                </div>
                                                            </div>

                                                            <button
                                                                onClick={() => removeItem(sId, iId)}
                                                                className="text-red-400 hover:text-red-600 hover:bg-red-50 w-6 h-6 mt-2 rounded flex items-center justify-center text-sm font-bold transition-colors"
                                                            >
                                                                &times;
                                                            </button>
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </div>

            </div>

        </div>
    );
}