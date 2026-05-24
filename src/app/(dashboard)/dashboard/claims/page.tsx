// src/components/claims/ClaimInvestigationModal.tsx
"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { collection, addDoc, doc, getDoc, getDocs, query, where, orderBy, limit } from "firebase/firestore";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { db, storage } from "@/lib/firebase/config";

interface ConversationMessage {
    role: "user" | "assistant";
    content: string;
}

interface DisplayMessage {
    role: "user" | "assistant";
    content: string;
    photos?: string[]; // uploaded photo URLs for display
    pendingFiles?: File[]; // local files before upload (for preview)
}

interface ClaimInvestigationModalProps {
    isOpen: boolean;
    onClose: () => void;
    onClaimCreated: (claimId: string, claimDocId: string) => void;
    // Dane sprzętu
    inventoryId: string;
    inventoryName: string;
    inventoryNumber: string;
    siteName: string;
    // Dane zgłaszającego
    reportedByUid: string;
    reportedByName: string;
    // Dane od magazyniera
    warehouseNotes: string;
    declaredStatus: string;
}

const generateClaimId = (): string => {
    const d = new Date();
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yy = String(d.getFullYear()).slice(-2);
    const rand = Math.floor(Math.random() * 900) + 100;
    return `SZK-${dd}${mm}${yy}-${rand}`;
};

// ─── SZTYWNE PYTANIA AWARYJNE DLA MAGAZYNIERA (FAIL-SAFE) ───
const BACKUP_QUESTIONS = [
    "Czy urządzenie nadaje się do naprawy, czy to całkowity złom?",
    "Z którego roku jest sprzęt i czy jest na niego gwarancja?",
    "Czy urządzenie było już w zewnętrznym serwisie na wycenie? Jeśli tak, co uznał serwis i na ile wyceniono naprawę?",
    "Jaka jest orientacyjna cena rynkowa nowego takiego urządzenia?"
];

// Sztywne pytania awaryjne dla Kierownika (Używane przy starcie awaryjnym)
const KIEROWNIK_BACKUP_QUESTIONS = [
    "W jakich dokładnie okolicznościach doszło do uszkodzenia tego sprzętu na budowie i kto na nim wtedy pracował?",
    "Czy sprzęt był używany zgodnie z przeznaczeniem i instrukcją obsługi?",
    "Czy na budowie były podejmowane jakiekolwiek próby samodzielnej naprawy lub rozkręcania urządzenia?",
    "Czy przed wystąpieniem usterki były jakieś sygnały ostrzegawcze (np. przegrzewanie się, spadek mocy)?"
];

// ─── POMOCNICZA FUNKCJA FETCH Z BEZPIECZNYM TIMEOUTEM 60 SEKUND ───
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

// Kompresja/resize zdjęcia przed uploadem
const resizeImage = (file: File, maxWidth = 1200): Promise<File> => {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement("canvas");
                const ratio = Math.min(maxWidth / img.width, 1);
                canvas.width = img.width * ratio;
                canvas.height = img.height * ratio;
                const ctx = canvas.getContext("2d")!;
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                canvas.toBlob(
                    (blob) => {
                        if (blob) {
                            resolve(new File([blob], file.name, { type: "image/jpeg" }));
                        } else {
                            resolve(file);
                        }
                    },
                    "image/jpeg",
                    0.85
                );
            };
            img.src = e.target?.result as string;
        };
        reader.readAsDataURL(file);
    });
};

const uploadPhoto = async (file: File, claimTempId: string): Promise<string> => {
    const resized = await resizeImage(file);
    const storageRef = ref(
        storage,
        `claims-evidence/${claimTempId}/${Date.now()}_${file.name.replace(/\s/g, "_")}`
    );
    await uploadBytes(storageRef, resized);
    return getDownloadURL(storageRef);
};

export default function ClaimInvestigationModal({
    isOpen, onClose, onClaimCreated, inventoryId, inventoryName, inventoryNumber, siteName, reportedByUid, reportedByName, warehouseNotes, declaredStatus
}: ClaimInvestigationModalProps) {
    // Chat state
    const [displayMessages, setDisplayMessages] = useState<DisplayMessage[]>([]);
    const [apiMessages, setApiMessages] = useState<ConversationMessage[]>([]);
    const [userInput, setUserInput] = useState("");
    const [isAiTyping, setIsAiTyping] = useState(false);
    const [isInitialized, setIsInitialized] = useState(false);

    // Investigation state
    const [isComplete, setIsComplete] = useState(false);
    const [caseContext, setCaseContext] = useState<string | null>(null);

    // DANE URZĄDZENIA POBRANE Z BAZY DO WYWIADU
    const [purchasePrice, setPurchasePrice] = useState<number>(0);
    const [purchaseDate, setPurchaseDate] = useState<string>("");

    // LISTA KIEROWNIKÓW DO PRZYPISANIA NA KOŃCU
    const [kierownicy, setKierownicy] = useState<any[]>([]);
    const [selectedKierownikId, setSelectedKierownikId] = useState("");

    // TRYB AWARYJNY (FAIL-SAFE) DLA MAGAZYNIERA
    const [backupStep, setBackupStep] = useState<number | null>(null);
    const [backupAnswers, setBackupAnswers] = useState<string[]>([]);

    // Photo state
    const [pendingFiles, setPendingFiles] = useState<File[]>([]);
    const [allUploadedPhotoUrls, setAllUploadedPhotoUrls] = useState<string[]>([]);
    const [isUploading, setIsUploading] = useState(false);
    const [claimTempId] = useState(() => `tmp_${Date.now()}`);

    // Submission
    const [isSubmitting, setIsSubmitting] = useState(false);

    const chatEndRef = useRef<HTMLDivElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    // Scroll to bottom on new messages
    useEffect(() => {
        chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [displayMessages, isAiTyping]);

    // Initialize data and chat once when opened
    useEffect(() => {
        if (isOpen && !isInitialized) {
            initializeInvestigation();
        }
        if (!isOpen) {
            resetState();
        }
    }, [isOpen, isInitialized]);

    const resetState = () => {
        setDisplayMessages([]);
        setApiMessages([]);
        setUserInput("");
        setIsAiTyping(false);
        setIsInitialized(false);
        setIsComplete(false);
        setCaseContext(null);
        setPendingFiles([]);
        setAllUploadedPhotoUrls([]);
        setIsSubmitting(false);
        setBackupStep(null);
        setBackupAnswers([]);
        setSelectedKierownikId("");
    };

    const initializeInvestigation = async () => {
        setIsInitialized(true);
        setIsAiTyping(true);
        try {
            // 1. Pobierz dane finansowe sprzętu z bazy
            const itemSnap = await getDoc(doc(db, "inventory", inventoryId));
            let pDate = "";
            let pPrice = 0;
            if (itemSnap.exists()) {
                pDate = itemSnap.data().purchaseDate || "";
                pPrice = itemSnap.data().purchasePrice || 0;
                setPurchaseDate(pDate);
                setPurchasePrice(pPrice);
            }

            // 2. POBIERZ WSZYSTKIE ROLE (by znać domyślne uprawnienie 'viewClaims' dla roli)
            const rolesSnap = await getDocs(collection(db, "roles"));
            const rolesMap: Record<string, Record<string, boolean>> = {};
            rolesSnap.docs.forEach(d => {
                rolesMap[d.id] = d.data().permissions || {};
            });

            // 3. POBIERZ UŻYTKOWNIKÓW I ROZSTRZYGNIJ UPRAWNIENIA (Czysta logika uprawnień)
            const usersSnap = await getDocs(collection(db, "users"));
            const validKierownicy = usersSnap.docs.map(docSnap => {
                const userData = docSnap.data();
                const uid = docSnap.id;
                const name = `${userData.firstName || ""} ${userData.lastName || ""}`.trim();
                const roleId = userData.roleId || "";
                const overrides = userData.permissionOverrides || {};

                // Rozstrzygamy "viewClaims" (Sąd: Dostęp do panelu) identycznie jak funkcja hasPermission
                let hasViewClaims = false;

                // A. Najpierw sprawdzamy indywidualne wyjątki
                if ("viewClaims" in overrides) {
                    hasViewClaims = overrides.viewClaims;
                }
                // B. Jeśli brak wyjątków, sprawdzamy domyślne uprawnienia Roli
                else if (roleId && rolesMap[roleId]) {
                    hasViewClaims = !!rolesMap[roleId].viewClaims;
                }

                return { uid, name, hasViewClaims };
            }).filter(u => u.hasViewClaims); // Zostawiamy TYLKO osoby z aktywnym uprawnieniem do sądu!

            // --- KOŁO RATUNKOWE: JEŚLI BRAK KIEROWNIKÓW, POKAŻ WSZYSTKICH ---
            if (validKierownicy.length === 0) {
                const allUsers = usersSnap.docs.map(d => ({
                    uid: d.id,
                    name: `${d.data().firstName || ""} ${d.data().lastName || ""}`.trim()
                }));
                setKierownicy(allUsers);
            } else {
                setKierownicy(validKierownicy);
            }

            // 4. Wywołaj asystenta AI z limitem czasowym 60s
            const res = await fetchWithTimeout("/api/claims-ai-investigate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    inventoryName,
                    inventoryNumber,
                    siteName,
                    isInitial: true,
                    warehouseNotes,
                    declaredStatus,
                    purchaseDate: pDate,
                    purchasePrice: pPrice,
                    role: "MAGAZYN"
                }),
                timeout: 60000
            });

            if (res.ok) {
                const data = await res.json();
                const aiReply = data.reply || "Analizuję usterkę...";
                setDisplayMessages([{ role: "assistant", content: aiReply }]);
                setApiMessages([{ role: "assistant", content: aiReply }]);

                if (data.isComplete) {
                    setIsComplete(true);
                    setCaseContext(data.caseContext);
                }
            } else {
                throw new Error("AI Offline");
            }
        } catch (err) {
            console.error("Init error (Uruchomienie trybu awaryjnego):", err);
            setBackupStep(0);
            const firstBackupQ = "Czy urządzenie nadaje się do naprawy, czy to całkowity złom?";
            setDisplayMessages([
                {
                    role: "assistant",
                    content: `[TRYB AWARYJNY ASYSTENTA] Serwer AI jest przeciążony. Przeprowadzę uproszczony wywiad techniczny.\n\nPytanie 1: ${firstBackupQ}`,
                },
            ]);
            setApiMessages([{ role: "assistant", content: firstBackupQ }]);
        } finally {
            setIsAiTyping(false);
        }
    };

    const sendMessage = useCallback(async () => {
        const text = userInput.trim();
        const filesToSend = [...pendingFiles];

        if (!text && filesToSend.length === 0) return;
        if (isAiTyping || isUploading) return;

        setUserInput("");
        setPendingFiles([]);
        setIsUploading(filesToSend.length > 0);
        setIsAiTyping(true);

        // Upload photos
        let newPhotoUrls: string[] = [];
        if (filesToSend.length > 0) {
            try {
                newPhotoUrls = await Promise.all(
                    filesToSend.map((f) => uploadPhoto(f, claimTempId))
                );
                setAllUploadedPhotoUrls((prev) => [...prev, ...newPhotoUrls]);
            } catch (uploadErr) {
                console.error("Upload error:", uploadErr);
            }
        }
        setIsUploading(false);

        const photoNote =
            newPhotoUrls.length > 0
                ? `\n[Dołączono ${newPhotoUrls.length} zdjęcie(a) jako dowód fotograficzny]`
                : "";
        const apiText = text + photoNote;

        const newDisplayMsg: DisplayMessage = {
            role: "user",
            content: text || `[Zdjęcia: ${newPhotoUrls.length} szt.]`,
            photos: newPhotoUrls,
        };
        const newApiMsg: ConversationMessage = { role: "user", content: apiText };

        const updatedDisplay = [...displayMessages, newDisplayMsg];
        const updatedApi = [...apiMessages, newApiMsg];

        setDisplayMessages(updatedDisplay);
        setApiMessages(updatedApi);

        // --- OBSŁUGA CZATU ---
        if (backupStep !== null) {
            // --- CZĘŚĆ AWARYJNA (FAIL-SAFE) ---
            const currentAnswers = [...backupAnswers, text || "[Zdjęcia]"];
            setBackupAnswers(currentAnswers);

            const nextStep = backupStep + 1;
            if (nextStep === 1) {
                let warrantyQ = "Z którego roku jest sprzęt i czy jest na niego gwarancja?";
                if (purchaseDate) {
                    const age = (new Date().getTime() - new Date(purchaseDate).getTime()) / (1000 * 60 * 60 * 24 * 365);
                    warrantyQ = `Urządzenie zakupiono: ${purchaseDate} (ma ${Math.round(age)} lat). Czy na pewno jest już po gwarancji producenta?`;
                }
                const nextContent = `Pytanie 2: ${warrantyQ}`;
                setDisplayMessages([...updatedDisplay, { role: "assistant", content: nextContent }]);
                setApiMessages([...updatedApi, { role: "assistant", content: nextContent }]);
                setBackupStep(1);
                setIsAiTyping(false);
            } else if (nextStep === 2) {
                const nextContent = "Pytanie 3: Czy sprzęt był już w zewnętrznym serwisie na wycenie? Jeśli tak, co uznał serwis i na ile wyceniono naprawę?";
                setDisplayMessages([...updatedDisplay, { role: "assistant", content: nextContent }]);
                setApiMessages([...updatedApi, { role: "assistant", content: nextContent }]);
                setBackupStep(2);
                setIsAiTyping(false);
            } else if (nextStep === 3) {
                let priceQ = "Jaka jest orientacyjna cena rynkowa nowego takiego urządzenia?";
                if (purchasePrice > 0) priceQ = `Cena tego modelu w bazie to ${purchasePrice} zł. Czy rynkowa cena nowego urządzenia uległa zmianie?`;
                const nextContent = `Pytanie 4: ${priceQ}`;
                setDisplayMessages([...updatedDisplay, { role: "assistant", content: nextContent }]);
                setApiMessages([...updatedApi, { role: "assistant", content: nextContent }]);
                setBackupStep(3);
                setIsAiTyping(false);
            } else {
                const manualReport = `RAPORT MAGAZYNU (ZABEZPIECZONY AWARYJNIE):\nSprzęt: ${inventoryName}\nStan: ${warehouseNotes || declaredStatus}\nDiagnoza serwisu: ${currentAnswers[0]}\nGwarancja: ${currentAnswers[1]}\nPróby naprawy: ${currentAnswers[2]}\nUstalona cena rynkowa: ${currentAnswers[3]}\nZdjęcia: Tak (w bazie)`;
                setCaseContext(manualReport);
                setIsComplete(true);
                const endContent = "Dziękuję. Protokół został zabezpieczony w trybie awaryjnym. Wybierz kierownika odpowiedzialnego za budowę i prześlij sprawę.";
                setDisplayMessages([...updatedDisplay, { role: "assistant", content: endContent }]);
                setApiMessages([...updatedApi, { role: "assistant", content: endContent }]);
                setIsAiTyping(false);
            }
        } else {
            // --- STANDARDOWY PROCES AI Z TIMEOUTEM 60s ---
            try {
                const res = await fetchWithTimeout("/api/claims-ai-investigate", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        inventoryName,
                        inventoryNumber,
                        siteName,
                        messages: updatedApi,
                        warehouseNotes,
                        declaredStatus,
                        purchaseDate,
                        purchasePrice,
                        role: "MAGAZYN"
                    }),
                    timeout: 60000
                });
                const data = await res.json();
                const aiReply = data.reply || "Analizuję...";

                const aiDisplayMsg: DisplayMessage = { role: "assistant", content: aiReply };
                const aiApiMsg: ConversationMessage = { role: "assistant", content: aiReply };

                setDisplayMessages((prev) => [...prev, aiDisplayMsg]);
                setApiMessages((prev) => [...prev, aiApiMsg]);

                if (data.isComplete) {
                    setIsComplete(true);
                    setCaseContext(data.caseContext);
                }
            } catch (err) {
                console.error("Błąd zapytania, uruchamiam awaryjny tryb pytań:", err);

                // ─── INTELIGENTNA ANALIZA ETAPU ROZMOWY (FAIL-SAFE) ───
                let startingStep = 0;
                if (updatedApi.length >= 5) {
                    startingStep = 3;
                } else if (updatedApi.length >= 3) {
                    startingStep = 2;
                } else if (updatedApi.length >= 1) {
                    startingStep = 1;
                }

                setBackupStep(startingStep);
                const fallbackQ = BACKUP_QUESTIONS[startingStep];

                setDisplayMessages((prev) => [
                    ...prev,
                    { role: "assistant", content: `⚠️ Serwer AI przestał odpowiadać. Przełączam na tryb awaryjny.\n\nPytanie: ${fallbackQ}` },
                ]);
                setApiMessages((prev) => [
                    ...prev,
                    { role: "assistant", content: fallbackQ }
                ]);
            } finally {
                setIsAiTyping(false);
            }
        }
    }, [userInput, pendingFiles, displayMessages, apiMessages, isAiTyping, isUploading, inventoryName, inventoryNumber, siteName, claimTempId, warehouseNotes, declaredStatus, backupStep, backupAnswers, purchaseDate, purchasePrice]);

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    };

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files) {
            const files = Array.from(e.target.files);
            setPendingFiles((prev) => [...prev, ...files]);
            e.target.value = "";
        }
    };

    const removePendingFile = (index: number) => {
        setPendingFiles((prev) => prev.filter((_, i) => i !== index));
    };

    // --- NOWOŚĆ: OBLICZANIE CZASU PRACY PRZED WYBOREM SĄDU ---
    const calculateDaysOnSiteForModal = async () => {
        try {
            const q = query(collection(db, "protocols"), where("type", "==", "WYDANIE"), orderBy("createdAt", "desc"), limit(30));
            const snap = await getDocs(q);
            for (const d of snap.docs) {
                const p = d.data();
                const hasItem = p.items?.some((i: any) => i.inventoryId === inventoryId);
                if (hasItem && p.destinationName === siteName) {
                    const issueDate = new Date(p.createdAt);
                    const currentDate = new Date();
                    const diffTime = Math.abs(currentDate.getTime() - issueDate.getTime());
                    return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
                }
            }
        } catch (e) { console.error(e); }
        return null;
    };

    const submitToCourt = async () => {
        if (!caseContext || isSubmitting) return;
        if (!selectedKierownikId) return alert("Musisz przypisać kierownika budowy odpowiedzialnego za ten sprzęt!");
        setIsSubmitting(true);

        const claimId = generateClaimId();
        const days = await calculateDaysOnSiteForModal();

        // ─── TWORZENIE PIERWSZYCH PYTAŃ DLA KIEROWNIKA W TLE PRZEZ AI ───
        let firstQuestionForKierownik = `Witaj Kierowniku Budowy. Zgłoszono uszkodzenie urządzenia ${inventoryName} z budowy ${siteName}.\n\nProszę o wyjaśnienie okoliczności powstania tej usterki.`;

        try {
            const res = await fetchWithTimeout("/api/claims-ai-investigate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    inventoryName,
                    inventoryNumber,
                    siteName,
                    warehouseNotes: caseContext, // Przekazujemy gotowy raport Magazyniera!
                    role: "KIEROWNIK",
                    isInitial: true,
                    daysOnSite: days
                }),
                timeout: 30000 // cichy limit 30 sekund w tle
            });
            if (res.ok) {
                const data = await res.json();
                firstQuestionForKierownik = data.reply;
            } else {
                throw new Error();
            }
        } catch (e) {
            // Cichy fallback dla Kierownika (gdyby Vertex AI nie odpowiedział na czas)
            firstQuestionForKierownik = `Witaj Kierowniku Budowy. Sąd PESAM rozpoczyna procedurę wyjaśniającą.\n\nPytanie 1: ${KIEROWNIK_BACKUP_QUESTIONS[0]}`;
        }

        // Zapisujemy pierwszą rozmowę Magazyniera ze zdjęciami
        const investigationMessages = displayMessages.map((msg, i) => {
            return {
                id: `inv_${i}_${Date.now()}`,
                senderId: msg.role === "assistant" ? "system_ai" : reportedByUid,
                senderName: msg.role === "assistant" ? "Sędzia AI CLS 🤖" : reportedByName,
                senderRole: msg.role === "assistant" ? "AI" : "MAGAZYN",
                text: msg.content,
                timestamp: new Date().toISOString(),
                visibleToWarehouse: true,
                imageUrls: msg.photos || [],
            };
        });

        // Wewnętrzne podsumowanie techniczne Magazyniera
        const summaryMessage = {
            id: `summary_${Date.now()}`,
            senderId: "system_ai",
            senderName: "Sędzia AI CLS 🤖",
            senderRole: "AI",
            text: `📋 PROTOKÓŁ WSTĘPNY – PRZEKAZANIE DO ZARZĄDU\n\nUwagi magazyniera: ${warehouseNotes || "Brak"}\nStatus: ${declaredStatus}\n\nAnaliza AI:\n${caseContext}\n\n📸 Łącznie zebranych zdjęć dowodowych: ${allUploadedPhotoUrls.length}`,
            timestamp: new Date().toISOString(),
            visibleToWarehouse: false,
            imageUrl: null,
        };

        // ─── NOWOŚĆ: Dodajemy pierwsze wygenerowane pytanie dla Kierownika do bazy ───
        const initialKierownikMessage = {
            id: `kierownik_init_${Date.now()}`,
            senderId: "system_ai",
            senderName: "Sędzia AI CLS 🤖",
            senderRole: "AI",
            text: firstQuestionForKierownik,
            timestamp: new Date().toISOString(),
            visibleToWarehouse: true
        };

        const shortDescription = `Zgłoszenie: ${declaredStatus}. ${warehouseNotes} | Wnioski AI: ${caseContext?.slice(0, 100).replace(/\n/g, " ") || "Brak"}`;

        try {
            await addDoc(collection(db, "claims"), {
                claimId,
                inventoryId,
                inventoryName,
                inventoryNumber,
                siteName,
                reportedBy: reportedByUid,
                reportedByName,
                description: shortDescription,
                status: "NOWA", // Kierownik widzi go jako NOWA (Wyjaśnianie)
                createdAt: new Date().toISOString(),
                assignedManagers: [selectedKierownikId],
                messages: [...investigationMessages, summaryMessage, initialKierownikMessage], // Dodany startowy post AI dla Kierownika!
                evidencePhotos: allUploadedPhotoUrls,
                investigationComplete: true,
                caseContext,
            });

            onClaimCreated(claimId, "temp-doc-id");
        } catch (err) {
            console.error("Create claim error:", err);
            alert("Błąd tworzenia sprawy w bazie. Spróbuj ponownie.");
        } finally {
            setIsSubmitting(false);
        }
    };

    if (!isOpen) return null;

    const canSend =
        (userInput.trim() || pendingFiles.length > 0) && !isAiTyping && !isUploading;

    const steps = [
        { label: "Identyfikacja", done: displayMessages.length >= 1 },
        { label: "Okoliczności", done: displayMessages.length >= 5 },
        { label: "Dokumentacja", done: allUploadedPhotoUrls.length > 0 },
        { label: "Komplet danych", done: isComplete },
    ];

    return (
        <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
            <div
                className="bg-white rounded-3xl shadow-2xl w-full max-w-2xl flex flex-col overflow-hidden border-4 border-purple-700 animate-fade-in"
                style={{ maxHeight: "92vh" }}
            >
                {/* ── HEADER ── */}
                <div className="flex-shrink-0 bg-slate-900 text-white px-6 py-4">
                    <div className="flex items-start justify-between gap-4">
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 bg-purple-600 rounded-2xl flex items-center justify-center text-xl shadow-lg flex-shrink-0">
                                🕵️
                            </div>
                            <div>
                                <h2 className="font-black uppercase tracking-tighter text-base leading-tight">
                                    Protokół Przesłuchania Wstępnego
                                </h2>
                                <p className="text-slate-400 text-[10px] font-mono mt-0.5 truncate max-w-xs">
                                    {inventoryName} · Nr {inventoryNumber} · {siteName}
                                </p>
                            </div>
                        </div>
                        <button
                            onClick={onClose}
                            className="text-slate-500 hover:text-white transition text-xl mt-0.5 flex-shrink-0"
                        >
                            ✕
                        </button>
                    </div>

                    {/* Progress bar */}
                    <div className="mt-4 flex items-center gap-1">
                        {steps.map((step, i) => (
                            <div key={i} className="flex items-center gap-1 flex-1">
                                <div
                                    className={`flex-1 h-1 rounded-full transition-all duration-500 ${step.done ? "bg-purple-400" : "bg-slate-700"}`}
                                />
                                <div
                                    className={`text-[9px] font-black uppercase whitespace-nowrap transition-colors ${step.done ? "text-purple-400" : "text-slate-600"}`}
                                >
                                    {step.done ? "✓ " : ""}{step.label}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>

                {/* ── CHAT AREA ── */}
                <div className="flex-1 overflow-y-auto p-5 space-y-4 bg-slate-50 min-h-0">
                    {displayMessages.map((msg, i) => {
                        const isUser = msg.role === "user";
                        return (
                            <div key={i} className={`flex flex-col ${isUser ? "items-end" : "items-start"}`}>
                                <div
                                    className={`max-w-[88%] rounded-2xl px-4 py-3 shadow-sm ${isUser
                                        ? "bg-blue-600 text-white rounded-br-sm"
                                        : "bg-purple-100 border border-purple-200 text-purple-900 rounded-bl-sm"
                                        }`}
                                >
                                    <div
                                        className={`text-[9px] uppercase font-black mb-1.5 tracking-wider ${isUser ? "text-blue-300" : "text-purple-500"}`}
                                    >
                                        {isUser ? reportedByName : "Sędzia AI CLS 🤖"}
                                    </div>
                                    <p className="text-sm whitespace-pre-wrap leading-relaxed">{msg.content}</p>

                                    {/* Photo thumbnails */}
                                    {msg.photos && msg.photos.length > 0 && (
                                        <div className="mt-3 flex flex-wrap gap-2">
                                            {msg.photos.map((url, pi) => (
                                                <a
                                                    key={pi}
                                                    href={url}
                                                    target="_blank"
                                                    rel="noreferrer"
                                                    className="block"
                                                >
                                                    <img
                                                        src={url}
                                                        alt={`Dowód ${pi + 1}`}
                                                        className="w-16 h-16 rounded-xl object-cover border-2 border-white/30 shadow hover:scale-105 transition-transform"
                                                    />
                                                </a>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            </div>
                        );
                    })}

                    {/* AI typing indicator */}
                    {(isAiTyping || isUploading) && (
                        <div className="flex items-start">
                            <div className="bg-purple-100 border border-purple-200 rounded-2xl rounded-bl-sm px-5 py-3 shadow-sm">
                                <div className="flex gap-1.5 items-center">
                                    {isUploading ? (
                                        <span className="text-[10px] text-purple-600 font-bold uppercase">
                                            ⬆ Przesyłam zdjęcia...
                                        </span>
                                    ) : (
                                        <>
                                            <div
                                                className="w-2 h-2 bg-purple-400 rounded-full animate-bounce"
                                                style={{ animationDelay: "0ms" }}
                                            />
                                            <div
                                                className="w-2 h-2 bg-purple-400 rounded-full animate-bounce"
                                                style={{ animationDelay: "150ms" }}
                                            />
                                            <div
                                                className="w-2 h-2 bg-purple-400 rounded-full animate-bounce"
                                                style={{ animationDelay: "300ms" }}
                                            />
                                        </>
                                    )}
                                </div>
                            </div>
                        </div>
                    )}

                    <div ref={chatEndRef} />
                </div>

                {/* ── COMPLETION & ASSIGNMENT PANEL ── */}
                {isComplete && (
                    <div className="flex-shrink-0 bg-green-50 border-t-2 border-green-300 p-5 flex flex-col gap-4">
                        {/* WYBÓR KIEROWNIKA BUDOWY */}
                        <div className="bg-white p-4 rounded-2xl border border-green-200 shadow-sm">
                            <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Kto odpowiada za budowę: {siteName}?</label>
                            <select
                                required
                                value={selectedKierownikId}
                                onChange={e => setSelectedKierownikId(e.target.value)}
                                className="w-full p-3 bg-slate-50 border-2 border-slate-200 rounded-xl font-bold text-slate-800 text-sm outline-none focus:border-purple-500 cursor-pointer"
                            >
                                <option value="" disabled>-- Wybierz kierownika z listy --</option>
                                {kierownicy.map(k => <option key={k.uid} value={k.uid}>{k.name}</option>)}
                            </select>
                        </div>

                        <div className="flex items-center gap-4">
                            <div className="text-2xl">✅</div>
                            <div className="flex-1 min-w-0">
                                <p className="text-sm font-black text-green-800 uppercase tracking-tight">
                                    Protokół Magazyniera Zamknięty
                                </p>
                                <p className="text-xs text-green-700 mt-0.5 truncate">
                                    Wywiad techniczny zakończony. Przypisz kierownika i wyślij akta.
                                </p>
                            </div>
                            <button
                                onClick={submitToCourt}
                                disabled={isSubmitting || !selectedKierownikId}
                                className="flex-shrink-0 bg-purple-600 hover:bg-purple-700 text-white font-black px-5 py-3 rounded-xl shadow-xl transition disabled:opacity-50 disabled:bg-slate-400 text-sm uppercase tracking-wide"
                            >
                                {isSubmitting ? "Wysyłam..." : "⚖️ Wyślij do Sądu PESAM"}
                            </button>
                        </div>
                    </div>
                )}

                {/* ── INPUT AREA ── */}
                {!isComplete && (
                    <div className="flex-shrink-0 bg-white border-t border-slate-200 p-4">
                        {/* Pending photo previews */}
                        {pendingFiles.length > 0 && (
                            <div className="flex gap-2 mb-3 flex-wrap">
                                {pendingFiles.map((file, i) => (
                                    <div key={i} className="relative group">
                                        <img
                                            src={URL.createObjectURL(file)}
                                            alt=""
                                            className="w-14 h-14 rounded-xl object-cover border-2 border-blue-300 shadow"
                                        />
                                        <button
                                            onClick={() => removePendingFile(i)}
                                            className="absolute -top-1.5 -right-1.5 bg-red-500 text-white rounded-full w-5 h-5 text-[10px] flex items-center justify-center shadow opacity-0 group-hover:opacity-100 transition-opacity"
                                        >
                                            ✕
                                        </button>
                                    </div>
                                ))}
                                <div className="text-[10px] text-slate-500 self-center font-bold">
                                    {pendingFiles.length} zdjęcie(a) do wysłania
                                </div>
                            </div>
                        )}

                        <div className="flex gap-2 items-end">
                            {/* Photo upload button */}
                            <button
                                onClick={() => fileInputRef.current?.click()}
                                className="flex-shrink-0 w-11 h-11 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-xl transition flex items-center justify-center text-xl"
                                title="Dołącz zdjęcia dowodowe"
                            >
                                📷
                            </button>
                            <input
                                ref={fileInputRef}
                                type="file"
                                multiple
                                accept="image/*,image/heic"
                                onChange={handleFileChange}
                                className="hidden"
                                capture="environment"
                            />

                            {/* Text input */}
                            <textarea
                                ref={textareaRef}
                                value={userInput}
                                onChange={(e) => setUserInput(e.target.value)}
                                onKeyDown={handleKeyDown}
                                placeholder={
                                    pendingFiles.length > 0
                                        ? "Dodaj komentarz do zdjęć (opcjonalnie)..."
                                        : "Odpowiedz na pytanie agenta..."
                                }
                                className="flex-1 border border-slate-300 rounded-xl px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-purple-500 resize-none shadow-inner h-12"
                                disabled={isAiTyping || isUploading}
                                rows={1}
                            />

                            {/* Send button */}
                            <button
                                onClick={sendMessage}
                                disabled={!canSend}
                                className="flex-shrink-0 bg-purple-600 hover:bg-purple-700 text-white font-black w-11 h-11 rounded-xl shadow transition disabled:opacity-40 flex items-center justify-center text-lg"
                            >
                                ▶
                            </button>
                        </div>

                        <p className="text-[10px] text-slate-400 mt-2 text-center">
                            Enter = wyślij · Shift+Enter = nowa linia · 📷 = dołącz zdjęcia dowodowe
                        </p>
                    </div>
                )}
            </div>
        </div>
    );
}