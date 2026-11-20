"use client";

import React, { useState, useEffect, useRef } from "react";
import { useAuth } from "@/lib/auth/AuthContext";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { collection, addDoc, doc, setDoc, getDocs, getDoc, query, limit } from "firebase/firestore";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { db, storage } from "@/lib/firebase/config";

interface ReturnItem {
    name: string;
    quantity: number;
    unit: string;
    category: string;
    type?: "UNIQUE" | "BULK" | "MATERIAL";
    inventoryNumber?: string;
    condition?: "SPRAWNY" | "USZKODZONY" | "";
    isSecured?: boolean | null;
    isRuleCompliant?: boolean | null;
    ruleNotes?: string;
    isSuspectedTransfer?: boolean;
    requiresPhoto?: boolean;
}

interface ReturnDraft {
    siteName: string;
    siteId?: string;
    driver: string;
    reasonForNoProtocol?: string;
    items: ReturnItem[];
    missingFields: string[];
    isReadyToSave: boolean;
    shouldPromptPhoto?: boolean;
    bypassCode?: string;
    bypassAttempts?: number;
    suggestedNewRule?: string;
}

interface ChatMessage {
    id: string;
    role: "user" | "assistant";
    content: string;
    timestamp: string;
}

export default function ZwrotBezProtokoluPage() {
    const { user } = useAuth();
    const router = useRouter();

    // Stany asystenta i czatu
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [draft, setDraft] = useState<ReturnDraft>({
        siteName: "",
        siteId: "",
        driver: "",
        reasonForNoProtocol: "",
        items: [],
        missingFields: ["budowa", "kierowca"],
        isReadyToSave: false,
        shouldPromptPhoto: false,
        bypassAttempts: 0
    });
    const [quickReplies, setQuickReplies] = useState<string[]>([
        "Budowa Tuchów",
        "Budowa Wielicka",
        "Budowa CZP",
        "Budowa Tarnów"
    ]);

    // Stany wejścia i mowy
    const [inputText, setInputText] = useState("");
    const [bypassCode, setBypassCode] = useState("");
    const [isBypassModalOpen, setIsBypassModalOpen] = useState(false);
    const [modalBypassInput, setModalBypassInput] = useState("");
    const [pendingSaveDraft, setPendingSaveDraft] = useState<ReturnDraft | null>(null);
    const [isListening, setIsListening] = useState(false);
    const [isThinking, setIsThinking] = useState(false);
    const [isSpeaking, setIsSpeaking] = useState(false);
    const [handsFree, setHandsFree] = useState(true); // Tryb ciągłego dialogu
    const [isAudioEnabled, setIsAudioEnabled] = useState(true); // Odczyt na głos
    const [isSpeechSupported, setIsSpeechSupported] = useState(true);

    // Zdjęcia
    const [photos, setPhotos] = useState<File[]>([]);
    const [photoPreviews, setPhotoPreviews] = useState<string[]>([]);
    const [isUploading, setIsUploading] = useState(false);
    const [isSavedSuccess, setIsSavedSuccess] = useState(false);
    const [savedDocId, setSavedDocId] = useState<string | null>(null);

    // Referencje
    const recognitionRef = useRef<any>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const handsFreeRef = useRef<boolean>(handsFree);
    handsFreeRef.current = handsFree;
    const isAudioEnabledRef = useRef<boolean>(isAudioEnabled);
    isAudioEnabledRef.current = isAudioEnabled;
    const draftRef = useRef<ReturnDraft>(draft);
    draftRef.current = draft;
    const messagesRef = useRef<ChatMessage[]>(messages);
    messagesRef.current = messages;

    // Inicjalizacja asystenta po wejściu
    useEffect(() => {
        // Sprawdź wsparcie mowy w przeglądarce
        if (typeof window !== "undefined") {
            const hasSynthesis = "speechSynthesis" in window;
            const hasRecognition = "SpeechRecognition" in window || "webkitSpeechRecognition" in window;
            setIsSpeechSupported(hasSynthesis || hasRecognition);

            // Pierwsze konkretne pytanie zamiast powitania
            const openingText = "Podaj nazwę budowy, z której przyjechał zwrot.";
            setMessages([
                {
                    id: "opening",
                    role: "assistant",
                    content: openingText,
                    timestamp: new Date().toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" })
                }
            ]);

            // Odczytaj pierwsze pytanie na głos
            if (isAudioEnabled) {
                speakText(openingText);
            }
        }

        return () => {
            if (typeof window !== "undefined" && "speechSynthesis" in window) {
                window.speechSynthesis.cancel();
            }
            if (recognitionRef.current) {
                try {
                    recognitionRef.current.abort();
                } catch {}
            }
        };
    }, []);

    // Autoprzewijanie widoku rozmowy
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages, isThinking]);

    // Funkcja syntezy mowy (Aplikacja mówi do magazyniera)
    const speakText = (text: string, onEndCallback?: () => void) => {
        if (!isAudioEnabledRef.current || typeof window === "undefined" || !("speechSynthesis" in window)) {
            if (onEndCallback) onEndCallback();
            return;
        }

        try {
            window.speechSynthesis.cancel();

            const cleanText = text
                .replace(/[*#_~`]/g, "")
                .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, "")
                .trim();

            const utterance = new SpeechSynthesisUtterance(cleanText);
            utterance.lang = "pl-PL";
            utterance.rate = 1.05;
            utterance.pitch = 1.0;

            const voices = window.speechSynthesis.getVoices();
            const plVoice = voices.find(v => v.lang.startsWith("pl") || v.lang.includes("PL"));
            if (plVoice) {
                utterance.voice = plVoice;
            }

            utterance.onstart = () => setIsSpeaking(true);
            utterance.onend = () => {
                setIsSpeaking(false);
                if (onEndCallback) {
                    onEndCallback();
                } else if (handsFreeRef.current) {
                    // W trybie Hands-Free po zakończeniu mowy wznów nasłuch
                    setTimeout(() => startListening(), 400);
                }
            };
            utterance.onerror = () => {
                setIsSpeaking(false);
                if (onEndCallback) onEndCallback();
            };

            window.speechSynthesis.speak(utterance);
        } catch (e) {
            console.warn("Błąd SpeechSynthesis:", e);
            setIsSpeaking(false);
            if (onEndCallback) onEndCallback();
        }
    };

    // Rozpoczęcie nasłuchu mikrofonu (STT)
    const startListening = () => {
        if (typeof window === "undefined") return;

        const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
        if (!SpeechRecognition) {
            alert("Twoja przeglądarka nie obsługuje rozpoznawania mowy. Możesz wpisywać wiadomości w polu poniżej.");
            return;
        }

        if (isSpeaking) {
            window.speechSynthesis.cancel();
            setIsSpeaking(false);
        }

        try {
            if (recognitionRef.current) {
                recognitionRef.current.abort();
            }

            const recognition = new SpeechRecognition();
            recognition.lang = "pl-PL";
            recognition.interimResults = false;
            recognition.maxAlternatives = 1;
            recognition.continuous = false;

            recognition.onstart = () => {
                setIsListening(true);
            };

            recognition.onresult = (event: any) => {
                const transcript = event.results[0][0].transcript;
                if (transcript && transcript.trim()) {
                    const clean = transcript.trim().toLowerCase();
                    if (clean.includes("aparat") || clean.includes("zrób zdjęcie") || clean.includes("fotka") || clean.includes("zdjęcie")) {
                        try {
                            fileInputRef.current?.click();
                        } catch {}
                    }
                    handleSendMessage(transcript.trim());
                }
            };

            recognition.onerror = (event: any) => {
                console.warn("SpeechRecognition error:", event.error);
                setIsListening(false);
            };

            recognition.onend = () => {
                setIsListening(false);
            };

            recognitionRef.current = recognition;
            recognition.start();
        } catch (e) {
            console.error("Błąd startu mikrofonu:", e);
            setIsListening(false);
        }
    };

    const stopListening = () => {
        if (recognitionRef.current) {
            try {
                recognitionRef.current.stop();
            } catch {}
        }
        setIsListening(false);
    };

    // Wysłanie wiadomości do API asystenta AI
    const handleSendMessage = async (userText: string) => {
        if (!userText.trim() || isThinking) return;

        stopListening();
        if (typeof window !== "undefined" && "speechSynthesis" in window) {
            window.speechSynthesis.cancel();
            setIsSpeaking(false);
        }

        const userMsg: ChatMessage = {
            id: `user_${Date.now()}`,
            role: "user",
            content: userText,
            timestamp: new Date().toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" })
        };

        const updatedMessages = [...messagesRef.current, userMsg];
        messagesRef.current = updatedMessages;
        setMessages(updatedMessages);
        setInputText("");
        setIsThinking(true);

        try {
            const res = await fetch("/api/plac/zwrot-bez-protokolu/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    userMessage: userText,
                    history: updatedMessages.slice(-10).map(m => ({ role: m.role, content: m.content })),
                    currentDraft: draftRef.current,
                    photosCount: photos.length
                })
            });

            const data = await res.json();

            if (data.speechReply) {
                const assistantMsg: ChatMessage = {
                    id: `ai_${Date.now()}`,
                    role: "assistant",
                    content: data.speechReply,
                    timestamp: new Date().toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" })
                };
                const newMsgList = [...messagesRef.current, assistantMsg];
                messagesRef.current = newMsgList;
                setMessages(newMsgList);

                if (data.draft) {
                    setDraft(prev => {
                        const merged: ReturnDraft = {
                            siteName: data.draft.siteName?.trim() || prev.siteName || "",
                            siteId: data.draft.siteId || prev.siteId || "",
                            driver: data.draft.driver?.trim() || prev.driver || "",
                            reasonForNoProtocol: data.draft.reasonForNoProtocol?.trim() || prev.reasonForNoProtocol || "",
                            items: (Array.isArray(data.draft.items) && data.draft.items.length > 0)
                                ? data.draft.items
                                : prev.items,
                            missingFields: data.draft.missingFields || [],
                            isReadyToSave: Boolean(data.draft.isReadyToSave),
                            shouldPromptPhoto: Boolean(data.draft.shouldPromptPhoto),
                            bypassCode: data.draft.bypassCode || prev.bypassCode || "",
                            // Przekaż licznik błędnych prób kodu z serwera
                            bypassAttempts: typeof data.draft.bypassAttempts === 'number'
                                ? data.draft.bypassAttempts
                                : (prev.bypassAttempts || 0),
                            suggestedNewRule: data.draft.suggestedNewRule || prev.suggestedNewRule || ""
                        };
                        draftRef.current = merged;
                        if (data.draft.bypassCode) {
                            setBypassCode(data.draft.bypassCode);
                        }
                        return merged;
                    });
                }

                if (Array.isArray(data.quickReplies) && data.quickReplies.length > 0) {
                    setQuickReplies(data.quickReplies);
                }

                // Aplikacja mówi do magazyniera
                speakText(data.speechReply);

                // Jeśli AI nakazuje zrobienie zdjęcia (np. złamana reguła lub uszkodzenie):
                if (data.draft?.shouldPromptPhoto && photos.length === 0) {
                    setTimeout(() => {
                        try {
                            fileInputRef.current?.click();
                        } catch (e) {
                            console.warn("Autostart aparatu zablokowany przez przeglądarkę (wymaga dotknięcia):", e);
                        }
                    }, 600);
                }

                // Jeśli AI ustaliło, że zwrot jest gotowy do zapisu i decyzja o kodzie zapadła
                if (data.draft?.isReadyToSave) {
                    const draftToSave: ReturnDraft = {
                        siteName: data.draft.siteName?.trim() || draftRef.current?.siteName || "",
                        siteId: data.draft.siteId || draftRef.current?.siteId || "",
                        driver: data.draft.driver?.trim() || draftRef.current?.driver || "",
                        reasonForNoProtocol: data.draft.reasonForNoProtocol?.trim() || draftRef.current?.reasonForNoProtocol || "",
                        items: (Array.isArray(data.draft.items) && data.draft.items.length > 0)
                            ? data.draft.items
                            : (draftRef.current?.items || []),
                        missingFields: [],
                        isReadyToSave: true,
                        shouldPromptPhoto: false,
                        bypassCode: data.draft.bypassCode || "",
                        bypassAttempts: typeof data.draft.bypassAttempts === 'number' ? data.draft.bypassAttempts : 0,
                        suggestedNewRule: data.draft.suggestedNewRule || draftRef.current?.suggestedNewRule || ""
                    };
                    executeActualSave(draftToSave, draftToSave.bypassCode || "");
                }
            }
        } catch (err: any) {
            console.error("Błąd połączenia z asystentem:", err);
            const errorMsg: ChatMessage = {
                id: `err_${Date.now()}`,
                role: "assistant",
                content: "Przepraszam, miałem chwilowy problem z siecią. Spróbuj powtórzyć lub potwierdzić klikając przycisk.",
                timestamp: new Date().toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" })
            };
            setMessages(prev => [...prev, errorMsg]);
        } finally {
            setIsThinking(false);
        }
    };

    // Obsługa dodawania zdjęć telefonem
    const handlePhotoSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (!e.target.files) return;
        const filesArray = Array.from(e.target.files);
        setPhotos(prev => [...prev, ...filesArray]);

        const newPreviews = filesArray.map(f => URL.createObjectURL(f));
        setPhotoPreviews(prev => [...prev, ...newPreviews]);
    };

    const removePhoto = (index: number) => {
        setPhotos(prev => prev.filter((_, i) => i !== index));
        setPhotoPreviews(prev => {
            URL.revokeObjectURL(prev[index]);
            return prev.filter((_, i) => i !== index);
        });
    };

    // Zgłoszenie chęci zapisu zwrotu:
    // 1. Sprawdzenie blokady braku zdjęć przy naruszeniu reguł
    // 2. Wymuszone zapytanie i wyświetlenie okna kodu zabezpieczającego (bypass e-mail)
    const handleSaveReturn = (overrideDraft?: ReturnDraft) => {
        const finalDraft = overrideDraft || draftRef.current || draft;

        // BEZWZGLĘDNA BLOKADA ZAPISU BEZ ZDJĘCIA GDY ZŁAMANO REGUŁY
        const needsPhoto = Boolean(
            finalDraft.shouldPromptPhoto ||
            (finalDraft.items || []).some(i => i.requiresPhoto || i.isSecured === false || i.condition === "USZKODZONY" || i.isSuspectedTransfer)
        );

        if (needsPhoto && photos.length === 0) {
            speakText("Zatrzymano zapis. Zgodnie z regułami PESAM, przed zatwierdzeniem musisz wykonać zdjęcie niepospinanych materiałów lub uszkodzeń.");
            setTimeout(() => {
                try {
                    fileInputRef.current?.click();
                } catch {}
            }, 600);
            return;
        }

        // Jeśli kod bypass jest już podany lub ustalony w drafcie
        if (finalDraft.bypassCode) {
            executeActualSave(finalDraft, finalDraft.bypassCode);
            return;
        }

        // Zapytaj o kod w modalu przy ręcznym kliknięciu przycisku zapisu
        setPendingSaveDraft(finalDraft);
        setModalBypassInput(bypassCode || finalDraft.bypassCode || "");
        setIsBypassModalOpen(true);
    };

    // Właściwy zapis do bazy Firestore z wybranym kodem bypass
    const executeActualSave = async (targetDraft: ReturnDraft, effectiveBypassCode: string) => {
        setIsBypassModalOpen(false);
        setIsUploading(true);

        try {
            // 1. Upload zdjęć jeśli dodano
            const uploadedUrls: string[] = [];
            for (const photo of photos) {
                try {
                    const photoRef = ref(storage, `returns_no_protocol/${Date.now()}_${photo.name}`);
                    await uploadBytes(photoRef, photo);
                    const url = await getDownloadURL(photoRef);
                    uploadedUrls.push(url);
                } catch (e) {
                    console.warn("Błąd uploadu zdjęcia:", e);
                }
            }

            const now = new Date();
            const timestampIso = now.toISOString();
            const dateStr = now.toLocaleDateString("pl-PL");
            const timeStr = now.toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" });

            const creatorName = user?.firstName && user?.lastName
                ? `${user.firstName} ${user.lastName}`
                : (user?.email || "Magazynier");

            // Formatowanie pozycji
            const protocolItems = (targetDraft.items || []).map((it, idx) => {
                const rawQty = it.quantity !== undefined && it.quantity !== null ? Number(it.quantity) : Number((it as any).returnQty);
                const validQty = (!isNaN(rawQty) && rawQty > 0) ? rawQty : 1;
                return {
                    dbId: `item_${Date.now()}_${idx}`,
                    name: it.name,
                    quantity: validQty,
                    returnQty: validQty,
                    unit: it.unit || "szt.",
                    category: it.category || "Inne Materiały, Drewno i Odpady",
                    type: it.type || (it.inventoryNumber ? "UNIQUE" : "BULK"),
                    inventoryNumber: it.inventoryNumber || "",
                    condition: it.condition || (it.isSecured === false ? "USZKODZONY / NIEPOSPINANY" : "SPRAWNY"),
                    declaredStatus: it.condition || (it.isSecured === false ? "USZKODZONY / NIEPOSPINANY" : "SPRAWNY / POSEGREGOWANY"),
                    rulesCompliant: it.isRuleCompliant !== false && !it.isSuspectedTransfer,
                    ruleNotes: it.ruleNotes || (it.isSecured ? "Zgodne: pospinane i posegregowane" : "Zwrot bez protokołu"),
                    isSuspectedTransfer: Boolean(it.isSuspectedTransfer),
                    requiresPhoto: Boolean(it.requiresPhoto),
                    isResidual: true
                };
            });

            const hasSuspectedTransfer = protocolItems.some(it => it.isSuspectedTransfer);

            // Dokument dla kolekcji protocols (zgodność z całym systemem PESAM)
            const protocolPayload = {
                protocolId: `ZBP/${now.getFullYear()}/${(now.getMonth() + 1).toString().padStart(2, "0")}/${Math.floor(1000 + Math.random() * 9000)}`,
                type: "RETURN",
                isWithoutProtocol: true,
                status: "SZKIC_KIEROWCY", // Gotowy do ostatecznego zatwierdzenia w protokołach
                siteName: targetDraft.siteName || "Budowa nieokreślona (do weryfikacji)",
                siteId: targetDraft.siteId || "",
                driverName: targetDraft.driver || "Kierowca nieokreślony",
                reasonForNoProtocol: targetDraft.reasonForNoProtocol || "Brak informacji",
                isSuspectedTransfer: hasSuspectedTransfer,
                createdByName: creatorName,
                createdByEmail: user?.email || "",
                createdAt: timestampIso,
                date: dateStr,
                time: timeStr,
                items: protocolItems,
                photoUrls: uploadedUrls,
                audioNotes: "Zgłoszono głosowo przez asystenta placu (zwrot bez protokołu)",
                aiConversationTranscript: messages.map(m => `${m.role === "user" ? "Magazynier" : "AI"}: ${m.content}`).join("\n"),
                notes: `Zwrot bez protokołu z budowy: ${targetDraft.siteName || "Brak"}. Kierowca: ${targetDraft.driver || "Brak"}. Powód braku protokołu: ${targetDraft.reasonForNoProtocol || "Nie określono"}.${hasSuspectedTransfer ? " ⚠️ WYKRYTO PODEJRZENIE PRZERZUTU MIĘDZY BUDOWAMI (brak na stanie budowy)." : ""}`
            };

            const docRef = await addDoc(collection(db, "protocols"), protocolPayload);

            // Zapisz także w kolekcji returns_without_protocol
            await setDoc(doc(db, "returns_without_protocol", docRef.id), {
                ...protocolPayload,
                id: docRef.id
            });

            setSavedDocId(protocolPayload.protocolId);
            setIsSavedSuccess(true);
            setBypassCode(effectiveBypassCode.trim());

            if (effectiveBypassCode.trim()) {
                speakText(`Zwrot bez protokołu numer ${protocolPayload.protocolId} został zapisany. Użyto kodu zabezpieczającego, alert e-mail został wyłączony.`);
            } else {
                speakText(`Zwrot bez protokołu numer ${protocolPayload.protocolId} został pomyślnie zapisany w systemie i wysłano alert.`);
            }

            // 3. Wysłanie alertu e-mail jeśli zdefiniowano odbiorców w ustawieniach
            try {
                fetch("/api/plac/zwrot-bez-protokolu/alert-email", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        protocolId: protocolPayload.protocolId,
                        siteName: targetDraft.siteName || "Nieokreślona",
                        driverName: targetDraft.driver || "Nieokreślony",
                        reasonForNoProtocol: targetDraft.reasonForNoProtocol || "Brak informacji",
                        items: protocolItems,
                        photoUrls: uploadedUrls,
                        aiConversationTranscript: protocolPayload.aiConversationTranscript,
                        bypassCode: effectiveBypassCode.trim(),
                        suggestedNewRule: targetDraft.suggestedNewRule || ""
                    })
                }).catch(e => console.warn("Błąd wysyłania alertu e-mail:", e));
            } catch (errEmail) {
                console.warn("Błąd triggera maila:", errEmail);
            }
        } catch (err: any) {
            console.error("Błąd zapisu zwrotu:", err);
            alert("Błąd zapisu w bazie danych: " + (err?.message || err));
        } finally {
            setIsUploading(false);
        }
    };

    // Nowy zwrot (reset formularza)
    const handleResetAll = () => {
        photoPreviews.forEach(p => URL.revokeObjectURL(p));
        setPhotos([]);
        setPhotoPreviews([]);
        const initialDraft: ReturnDraft = {
            siteName: "",
            siteId: "",
            driver: "",
            reasonForNoProtocol: "",
            items: [],
            missingFields: ["budowa", "kierowca"],
            isReadyToSave: false,
            shouldPromptPhoto: false,
            bypassAttempts: 0
        };
        draftRef.current = initialDraft;
        setDraft(initialDraft);
        setSavedDocId(null);
        setIsSavedSuccess(false);

        const restartText = "Podaj nazwę budowy, z której przyjechał zwrot.";
        const restartMsg: ChatMessage = {
            id: `restart_${Date.now()}`,
            role: "assistant",
            content: restartText,
            timestamp: new Date().toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" })
        };
        messagesRef.current = [restartMsg];
        setMessages([restartMsg]);
        speakText(restartText);
    };

    return (
        <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans select-none pb-20">
            {/* Sticky Header */}
            <header className="sticky top-0 z-30 border-b border-slate-800 bg-slate-900/95 backdrop-blur shadow-xl">
                <div className="max-w-xl mx-auto w-full px-4 py-3 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                        <Link
                            href="/plac"
                            className="w-10 h-10 rounded-2xl bg-slate-800 hover:bg-slate-700 text-slate-300 flex items-center justify-center font-black text-lg transition active:scale-95 shrink-0"
                            title="Wróć do menu placu"
                        >
                            ←
                        </Link>
                        <div className="min-w-0">
                            <h1 className="text-base font-black tracking-wider text-indigo-400 leading-tight uppercase flex items-center gap-1.5 truncate">
                                <span>🎙️</span>
                                <span className="truncate">Zwrot Bez Protokołu</span>
                            </h1>
                            <p className="text-[11px] font-bold text-slate-400 tracking-wide leading-tight truncate">
                                Głosowy Asystent Magazyniera AI
                            </p>
                        </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                        {/* Wyciszenie głosu AI */}
                        <button
                            type="button"
                            onClick={() => {
                                const nextVal = !isAudioEnabled;
                                setIsAudioEnabled(nextVal);
                                if (!nextVal && typeof window !== "undefined" && "speechSynthesis" in window) {
                                    window.speechSynthesis.cancel();
                                    setIsSpeaking(false);
                                }
                            }}
                            className={`px-2.5 py-1.5 rounded-xl border text-xs font-bold transition flex items-center gap-1.5 ${
                                isAudioEnabled
                                    ? "border-indigo-500/40 bg-indigo-950/80 text-indigo-300"
                                    : "border-slate-700 bg-slate-800 text-slate-400"
                            }`}
                            title={isAudioEnabled ? "Głos AI włączony" : "Głos AI wyciszony"}
                        >
                            <span>{isAudioEnabled ? "🔊" : "🔇"}</span>
                            <span className="hidden sm:inline">{isAudioEnabled ? "Głos WŁ" : "Głos WYŁ"}</span>
                        </button>

                        {/* Tryb Hands-free */}
                        <button
                            type="button"
                            onClick={() => setHandsFree(!handsFree)}
                            className={`px-2.5 py-1.5 rounded-xl border text-xs font-bold transition flex items-center gap-1.5 ${
                                handsFree
                                    ? "border-emerald-500/40 bg-emerald-950/80 text-emerald-300"
                                    : "border-slate-700 bg-slate-800 text-slate-400"
                            }`}
                            title="Automatyczny dialog bez dotykania ekranu"
                        >
                            <span>🤝</span>
                            <span className="hidden sm:inline">Hands-Free</span>
                        </button>
                    </div>
                </div>
            </header>

            {/* Sukces - ekran zatwierdzenia */}
            {isSavedSuccess ? (
                <main className="max-w-xl mx-auto w-full p-4 flex-1 space-y-4 animate-fade-in">
                    <section className="rounded-3xl border border-emerald-500/40 bg-gradient-to-br from-emerald-950/40 via-slate-900 to-slate-950 p-6 text-center space-y-4 shadow-2xl">
                        <div className="w-16 h-16 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 text-3xl flex items-center justify-center mx-auto animate-bounce">
                            ✓
                        </div>
                        <div>
                            <h2 className="text-xl font-black text-white">
                                Zwrot Bez Protokołu Zapisany!
                            </h2>
                            <p className="text-xs text-emerald-300 font-mono mt-1 font-bold">
                                Numer ewidencyjny: {savedDocId}
                            </p>
                        </div>

                        <div className="bg-slate-950/80 rounded-2xl border border-slate-800 p-4 text-left text-xs space-y-2">
                            <div className="flex justify-between">
                                <span className="text-slate-400">Budowa:</span>
                                <span className="font-bold text-white">{draft.siteName || "Nieokreślona"}</span>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-slate-400">Kierowca / Zdający:</span>
                                <span className="font-bold text-white">{draft.driver || "Nieokreślony"}</span>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-slate-400">Ilość pozycji:</span>
                                <span className="font-bold text-indigo-300">{draft.items.length} pozycji</span>
                            </div>
                            {photos.length > 0 && (
                                <div className="flex justify-between">
                                    <span className="text-slate-400">Dołączone zdjęcia:</span>
                                    <span className="font-bold text-white">{photos.length} szt.</span>
                                </div>
                            )}
                        </div>

                        <div className="flex flex-col gap-2.5 pt-2">
                            <button
                                type="button"
                                onClick={handleResetAll}
                                className="w-full py-3.5 rounded-2xl bg-indigo-600 hover:bg-indigo-500 text-white font-black text-sm shadow-lg transition active:scale-95"
                            >
                                🎙️ Zgłoś kolejny zwrot
                            </button>
                            <Link
                                href="/plac"
                                className="w-full py-3 rounded-2xl border border-slate-700 bg-slate-900 hover:bg-slate-800 text-slate-300 font-bold text-xs text-center transition"
                            >
                                Wróć do menu placu
                            </Link>
                        </div>
                    </section>
                </main>
            ) : (
                <main className="max-w-xl mx-auto w-full p-4 flex-1 space-y-4">
                    {/* Live Return Card (Bieżący stan rozpoznany przez AI) */}
                    <section className="rounded-3xl border border-indigo-500/30 bg-gradient-to-br from-indigo-950/30 via-slate-900 to-slate-950 p-4 sm:p-5 shadow-xl space-y-3">
                        <div className="flex items-center justify-between">
                            <span className="text-[10px] font-black uppercase tracking-wider text-indigo-300 flex items-center gap-1.5">
                                <span className="w-2 h-2 rounded-full bg-indigo-400 animate-pulse" />
                                Podgląd zgłoszenia w toku
                            </span>
                            {draft.items.length > 0 && (
                                <span className="text-[10px] bg-indigo-500/20 text-indigo-300 border border-indigo-400/30 px-2 py-0.5 rounded-full font-bold">
                                    {draft.items.length} {draft.items.length === 1 ? "pozycja" : "pozycje"}
                                </span>
                            )}
                        </div>

                        {/* Pasek budowy i kierowcy */}
                        <div className="grid grid-cols-2 gap-2 text-xs">
                            <div className="bg-slate-950/70 border border-slate-800 rounded-2xl p-2.5">
                                <div className="text-[10px] font-bold text-slate-400 flex items-center gap-1">
                                    <span>🏗️</span> Budowa:
                                </div>
                                <div className="font-black text-white truncate mt-0.5">
                                    {draft.siteName ? (
                                        <span className="text-emerald-400">{draft.siteName}</span>
                                    ) : (
                                        <span className="text-amber-400/90 text-[11px] font-normal italic">⚠️ Czeka na wskazanie</span>
                                    )}
                                </div>
                            </div>

                            <div className="bg-slate-950/70 border border-slate-800 rounded-2xl p-2.5">
                                <div className="text-[10px] font-bold text-slate-400 flex items-center gap-1">
                                    <span>🚚</span> Kierowca:
                                </div>
                                <div className="font-black text-white truncate mt-0.5">
                                    {draft.driver ? (
                                        <span className="text-emerald-400">{draft.driver}</span>
                                    ) : (
                                        <span className="text-amber-400/90 text-[11px] font-normal italic">⚠️ Czeka na nazwisko</span>
                                    )}
                                </div>
                            </div>
                        </div>

                        {/* Pasek powodu braku protokołu */}
                        <div className="bg-slate-950/70 border border-slate-800 rounded-2xl p-2.5 text-xs flex items-center justify-between gap-2">
                            <div className="text-[10px] font-bold text-slate-400 flex items-center gap-1 shrink-0">
                                <span>📄</span> Powód braku protokołu:
                            </div>
                            <div className="font-medium text-right text-xs truncate">
                                {draft.reasonForNoProtocol ? (
                                    <span className="text-indigo-300 font-bold">{draft.reasonForNoProtocol}</span>
                                ) : (
                                    <span className="text-amber-400/80 text-[11px] italic">⚠️ Do ustalenia z kierowcą</span>
                                )}
                            </div>
                        </div>

                        {/* Wymóg wykonania zdjęcia przy złamaniu reguł - Wielki przycisk 1-tap */}
                        {(draft.shouldPromptPhoto || draft.items.some(i => i.requiresPhoto || i.isSecured === false || i.condition === "USZKODZONY" || i.isSuspectedTransfer)) && photos.length === 0 && (
                            <div
                                onClick={() => fileInputRef.current?.click()}
                                className="cursor-pointer bg-gradient-to-r from-amber-600 via-amber-500 to-yellow-500 text-slate-950 p-4 rounded-3xl shadow-xl shadow-amber-950/40 flex items-center justify-between gap-3 animate-pulse active:scale-95 transition border-2 border-yellow-300"
                            >
                                <div className="flex items-center gap-3 min-w-0">
                                    <span className="text-3xl animate-bounce shrink-0">📸</span>
                                    <div className="min-w-0">
                                        <h4 className="font-black text-sm uppercase tracking-wide text-slate-950 leading-tight">
                                            Dotknij, aby zrobić zdjęcie
                                        </h4>
                                        <p className="text-[11px] font-bold text-amber-950 leading-tight mt-0.5 truncate">
                                            Wykryto naruszenie reguł lub uszkodzenie – aparat gotowy
                                        </p>
                                    </div>
                                </div>
                                <button
                                    type="button"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        fileInputRef.current?.click();
                                    }}
                                    className="px-3.5 py-2 rounded-2xl bg-slate-950 hover:bg-slate-900 text-amber-300 font-black text-xs shrink-0 flex items-center gap-1.5 shadow-md active:scale-90 transition"
                                >
                                    <span>📷</span> Aparat
                                </button>
                            </div>
                        )}

                        {/* Lista rozpoznanych pozycji z weryfikacją reguł */}
                        {draft.items.length > 0 ? (
                            <div className="space-y-2 pt-1">
                                <span className="text-[10px] font-black uppercase tracking-wider text-slate-400 block">
                                    Rozpoznane materiały i zgodność z regułami:
                                </span>
                                {draft.items.map((it, idx) => (
                                    <div
                                        key={idx}
                                        className={`bg-slate-950/90 border rounded-2xl p-3 flex flex-col gap-1.5 ${
                                            it.isSuspectedTransfer
                                                ? "border-amber-500/50 shadow-lg shadow-amber-950/20"
                                                : "border-slate-800"
                                        }`}
                                    >
                                        <div className="flex items-center justify-between">
                                            <span className="font-black text-sm text-white flex items-center gap-1.5 flex-wrap">
                                                <span>•</span> {it.name}
                                                {it.inventoryNumber && (
                                                    <span className="text-[11px] font-mono text-cyan-400 bg-cyan-950/80 px-2 py-0.5 rounded-md border border-cyan-700/60 font-bold">
                                                        Nr mag: {it.inventoryNumber}
                                                    </span>
                                                )}
                                            </span>
                                            <span className="text-xs font-mono font-bold text-amber-400 bg-amber-400/10 px-2 py-0.5 rounded-lg border border-amber-400/20">
                                                {it.quantity} {it.unit}
                                            </span>
                                        </div>

                                        <div className="flex items-center justify-between text-[11px] text-slate-400 flex-wrap gap-1.5 pt-0.5">
                                            <span className="text-slate-400">Kategoria: {it.category}</span>
                                            <div className="flex items-center gap-1 flex-wrap">
                                                {it.condition === "SPRAWNY" && (
                                                    <span className="text-[10px] bg-emerald-950 text-emerald-400 border border-emerald-700/60 px-2 py-0.5 rounded-full font-bold">
                                                        ✓ Sprawny
                                                    </span>
                                                )}
                                                {it.condition === "USZKODZONY" && (
                                                    <span className="text-[10px] bg-red-950 text-red-400 border border-red-700/60 px-2 py-0.5 rounded-full font-bold">
                                                        ⚠️ Uszkodzony
                                                    </span>
                                                )}
                                                {it.isSecured === true && (
                                                    <span className="text-[10px] bg-emerald-950 text-emerald-400 border border-emerald-700/60 px-2 py-0.5 rounded-full font-bold flex items-center gap-1">
                                                        ✓ Pospinane i posegregowane
                                                    </span>
                                                )}
                                                {it.isSecured === false && (
                                                    <span className="text-[10px] bg-red-950 text-red-400 border border-red-700/60 px-2 py-0.5 rounded-full font-bold flex items-center gap-1">
                                                        ⚠️ Niepospinane / Naruszenie reguły
                                                    </span>
                                                )}
                                                {it.isSecured === null && !it.condition && (
                                                    <span className="text-[10px] bg-amber-950 text-amber-300 border border-amber-700/60 px-2 py-0.5 rounded-full font-bold flex items-center gap-1">
                                                        ❓ Wymaga dopytania
                                                    </span>
                                                )}
                                                {it.isSuspectedTransfer && (
                                                    <span className="text-[10px] bg-amber-950 text-amber-300 border border-amber-600/70 px-2 py-0.5 rounded-full font-black flex items-center gap-1">
                                                        ⚠️ Podejrzenie przerzutu
                                                    </span>
                                                )}
                                            </div>
                                        </div>

                                        {it.ruleNotes && (
                                            <p className="text-[11px] text-slate-300 bg-slate-900/60 rounded-xl px-2.5 py-1 border border-slate-800/80 italic">
                                                {it.ruleNotes}
                                            </p>
                                        )}
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <p className="text-xs text-slate-400 italic text-center py-2">
                                Wciśnij mikrofon i powiedz co przyjechało (np. &quot;Zapisz zwrot, kubik desek&quot;)
                            </p>
                        )}

                        {/* Zdjęcia zwrotu */}
                        <div className="pt-1">
                            <div className="flex items-center justify-between mb-2">
                                <span className="text-[10px] font-black uppercase tracking-wider text-slate-400">
                                    Zdjęcia zwrotu ({photos.length}):
                                </span>
                                <button
                                    type="button"
                                    onClick={() => fileInputRef.current?.click()}
                                    className="text-xs text-indigo-300 hover:text-indigo-200 bg-indigo-950/60 border border-indigo-700/50 px-2.5 py-1 rounded-xl font-bold flex items-center gap-1 active:scale-95 transition"
                                >
                                    <span>📸</span> Zrób zdjęcie telefonem
                                </button>
                                <input
                                    ref={fileInputRef}
                                    type="file"
                                    accept="image/*"
                                    capture="environment"
                                    multiple
                                    className="hidden"
                                    onChange={handlePhotoSelect}
                                />
                            </div>

                            {photoPreviews.length > 0 && (
                                <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-thin">
                                    {photoPreviews.map((url, i) => (
                                        <div key={i} className="relative w-16 h-16 rounded-xl overflow-hidden shrink-0 border border-slate-700">
                                            <img src={url} alt={`Podgląd ${i}`} className="w-full h-full object-cover" />
                                            <button
                                                type="button"
                                                onClick={() => removePhoto(i)}
                                                className="absolute top-0.5 right-0.5 w-5 h-5 bg-black/80 text-white rounded-full text-xs font-black flex items-center justify-center"
                                            >
                                                ✕
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>

                        {/* Opcja kodu bypass dla powiadomień e-mail */}
                        <div className="bg-slate-950/60 rounded-xl p-2.5 border border-slate-800 text-[11px] flex items-center justify-between gap-2">
                            <span className="text-slate-400 flex items-center gap-1 shrink-0 font-medium">
                                <span>🔑</span> Kod bypass alertu:
                            </span>
                            {bypassCode ? (
                                <div className="flex items-center gap-1.5">
                                    <span className="bg-indigo-500/20 border border-indigo-500/40 text-indigo-300 font-mono font-bold px-2 py-0.5 rounded text-[10px]">
                                        🛡️ {bypassCode} (pomiń e-mail)
                                    </span>
                                    <button
                                        type="button"
                                        onClick={() => setBypassCode("")}
                                        className="text-slate-500 hover:text-red-400 text-xs px-1"
                                        title="Usuń kod bypass"
                                    >
                                        ✕
                                    </button>
                                </div>
                            ) : (
                                <div className="flex items-center gap-2">
                                    <span className="text-[10px] text-slate-500">Powiadomienie do dyrekcji aktywne</span>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setModalBypassInput("");
                                            setIsBypassModalOpen(true);
                                        }}
                                        className="bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-indigo-300 border border-slate-700 rounded-lg px-2.5 py-1 text-[11px] font-mono transition"
                                    >
                                        🔐 Podaj kod
                                    </button>
                                </div>
                            )}
                        </div>

                        {/* Przycisk natychmiastowego zapisu jeśli magazynier woli kliknąć */}
                        {draft.items.length > 0 && (
                            <button
                                type="button"
                                onClick={() => handleSaveReturn()}
                                disabled={isUploading}
                                className="w-full py-3 rounded-2xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-black text-xs uppercase tracking-wider shadow-lg active:scale-95 transition flex items-center justify-center gap-2 disabled:opacity-50"
                            >
                                <span>{isUploading ? "⏳ Zapisywanie..." : "💾 Zatwierdź i Zapisz Zwrot"}</span>
                            </button>
                        )}
                    </section>

                    {/* Chat Log (Dymki dialogu Magazynier vs Asystent) */}
                    <section className="rounded-3xl border border-slate-800 bg-slate-900/60 p-4 space-y-3 min-h-[160px] max-h-[300px] overflow-y-auto scrollbar-thin">
                        {messages.map(msg => (
                            <div
                                key={msg.id}
                                className={`flex flex-col ${msg.role === "user" ? "items-end" : "items-start"}`}
                            >
                                <div
                                    className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-xs sm:text-sm leading-relaxed shadow-sm ${
                                        msg.role === "user"
                                            ? "bg-indigo-600 text-white rounded-br-xs"
                                            : "bg-slate-800 text-slate-100 border border-slate-700 rounded-bl-xs"
                                    }`}
                                >
                                    {msg.role === "assistant" && (
                                        <div className="flex items-center gap-1.5 mb-1 text-[10px] font-black text-indigo-400 uppercase tracking-wider">
                                            <span>🤖 Asystent Magazynu</span>
                                        </div>
                                    )}
                                    <p>{msg.content}</p>
                                </div>
                                <span className="text-[9px] text-slate-500 px-1 mt-0.5 font-mono">
                                    {msg.timestamp}
                                </span>
                            </div>
                        ))}

                        {isThinking && (
                            <div className="flex items-center gap-2 text-xs text-indigo-300 animate-pulse bg-indigo-950/40 p-2.5 rounded-2xl border border-indigo-500/20 w-fit">
                                <span className="text-base animate-spin">🌀</span>
                                <span>AI analizuje zgłoszenie i reguły...</span>
                            </div>
                        )}

                        <div ref={messagesEndRef} />
                    </section>

                    {/* Szybkie odpowiedzi (Quick Replies) */}
                    {quickReplies.length > 0 && (
                        <div className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-thin">
                            {quickReplies.map((reply, idx) => (
                                <button
                                    key={idx}
                                    type="button"
                                    onClick={() => handleSendMessage(reply)}
                                    className="px-3 py-1.5 rounded-xl border border-indigo-500/30 bg-indigo-950/50 hover:bg-indigo-900 text-indigo-200 text-xs font-bold whitespace-nowrap active:scale-95 transition shrink-0"
                                >
                                    {reply}
                                </button>
                            ))}
                        </div>
                    )}

                    {/* Centralny Duży Przycisk Mówienia (Voice Interaction Center) */}
                    <div className="pt-2 flex flex-col items-center justify-center space-y-3">
                        <div className="relative">
                            {/* Efekt fal dźwiękowych podczas nasłuchu */}
                            {isListening && (
                                <span className="absolute -inset-4 rounded-full bg-red-500/30 animate-ping pointer-events-none" />
                            )}
                            {isSpeaking && (
                                <span className="absolute -inset-4 rounded-full bg-indigo-500/30 animate-pulse pointer-events-none" />
                            )}

                            <button
                                type="button"
                                onClick={() => {
                                    if (isListening) {
                                        stopListening();
                                    } else {
                                        startListening();
                                    }
                                }}
                                className={`relative w-20 h-20 rounded-full flex items-center justify-center text-3xl shadow-2xl transition active:scale-90 ${
                                    isListening
                                        ? "bg-red-600 hover:bg-red-500 text-white shadow-red-500/50 ring-4 ring-red-400"
                                        : isSpeaking
                                            ? "bg-indigo-600 hover:bg-indigo-500 text-white shadow-indigo-500/50 ring-4 ring-indigo-400"
                                            : "bg-gradient-to-tr from-indigo-600 via-blue-600 to-amber-500 hover:opacity-90 text-white shadow-indigo-500/40"
                                }`}
                                title={isListening ? "Kliknij, aby zatrzymać nasłuch" : "Kliknij i mów do asystenta"}
                            >
                                {isListening ? "🔴" : isSpeaking ? "🔊" : "🎙️"}
                            </button>
                        </div>

                        <div className="text-center">
                            <p className="text-xs font-black tracking-wide text-white">
                                {isListening
                                    ? "Słucham Cię... Mów śmiało!"
                                    : isSpeaking
                                        ? "Aplikacja mówi do Ciebie..."
                                        : "Wciśnij i powiedz co chcesz zgłosić"}
                            </p>
                            <p className="text-[11px] text-slate-400 mt-0.5">
                                {handsFree
                                    ? "Tryb Hands-Free: AI samo wznawia nasłuch po zakończeniu wypowiedzi"
                                    : "Możesz też pisać w polu tekstowym poniżej"}
                            </p>
                        </div>

                        {/* Pole wpisywania ręcznego jako alternatywa */}
                        <form
                            onSubmit={(e) => {
                                e.preventDefault();
                                handleSendMessage(inputText);
                            }}
                            className="w-full flex items-center gap-2 pt-1"
                        >
                            <input
                                type="text"
                                value={inputText}
                                onChange={(e) => setInputText(e.target.value)}
                                placeholder="Wpisz lub popraw np. 'Budowa Wielicka, kubik desek'..."
                                className="flex-1 bg-slate-900 border border-slate-700 rounded-2xl px-4 py-2.5 text-xs text-white placeholder-slate-500 outline-none focus:border-indigo-500"
                            />
                            <button
                                type="submit"
                                disabled={!inputText.trim() || isThinking}
                                className="px-4 py-2.5 rounded-2xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white font-bold text-xs shrink-0 transition"
                            >
                                Wyślij
                            </button>
                        </form>
                    </div>

                    {/* PŁYWAJĄCY PRZYCISK APARATU - ZAWSZE WIDOCZNY GDY WYMAGANE JEST ZDJĘCIE */}
                    {(draft.shouldPromptPhoto || draft.items.some(i => i.requiresPhoto || i.isSecured === false || i.condition === "USZKODZONY" || i.isSuspectedTransfer)) && photos.length === 0 && (
                        <div className="fixed bottom-3 left-3 right-3 z-50 max-w-xl mx-auto animate-bounce">
                            <div
                                onClick={() => fileInputRef.current?.click()}
                                className="cursor-pointer bg-gradient-to-r from-red-600 via-amber-600 to-yellow-500 text-white p-3.5 rounded-2xl shadow-2xl shadow-red-950/80 border-2 border-yellow-300 flex items-center justify-between gap-3 active:scale-95 transition"
                            >
                                <div className="flex items-center gap-2.5 min-w-0">
                                    <span className="text-3xl shrink-0">📸</span>
                                    <div className="min-w-0">
                                        <h4 className="font-black text-xs uppercase tracking-wide text-white leading-tight">
                                            WYMAGANE ZDJĘCIE JAKO DOWÓD!
                                        </h4>
                                        <p className="text-[10px] font-bold text-yellow-200 leading-tight mt-0.5 truncate">
                                            Dotknij tutaj, aby natychmiast otworzyć aparat
                                        </p>
                                    </div>
                                </div>
                                <span className="px-3 py-1.5 rounded-xl bg-slate-950 text-yellow-300 font-black text-xs shrink-0 shadow flex items-center gap-1">
                                    📷 Aparat
                                </span>
                            </div>
                        </div>
                    )}
                    {/* MODAL WYMOGU DECYZJI O KODZIE ZABEZPIECZAJĄCYM PRZED ZAPISEM */}
                    {isBypassModalOpen && (
                        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/85 backdrop-blur-md animate-in fade-in duration-200">
                            <div className="w-full max-w-md bg-slate-900 border-2 border-indigo-500/50 rounded-3xl p-5 shadow-2xl space-y-4">
                                <div className="flex items-center gap-3">
                                    <div className="w-12 h-12 rounded-2xl bg-indigo-500/20 border border-indigo-500/40 flex items-center justify-center text-2xl shrink-0">
                                        🔐
                                    </div>
                                    <div>
                                        <h3 className="text-base font-black text-white">
                                            Kod Zabezpieczający (Alert E-mail)
                                        </h3>
                                        <p className="text-xs text-indigo-300 font-semibold">
                                            Potwierdzenie zapisu zwrotu bez protokołu
                                        </p>
                                    </div>
                                </div>

                                <div className="bg-slate-950/70 rounded-2xl p-3.5 border border-slate-800 text-xs text-slate-300 leading-relaxed space-y-2">
                                    <p>
                                        Zgodnie z regułami PESAM, zwrot bez protokołu zostanie zarejestrowany w systemie oraz domyślnie wyśle alert e-mail do kierownictwa.
                                    </p>
                                    <p className="font-bold text-amber-300">
                                        Jeśli posiadasz kod autoryzacyjny, podaj go poniżej, aby zablokować powiadomienie do dyrekcji.
                                    </p>
                                </div>

                                {/* Pole wpisania kodu */}
                                <div className="space-y-1.5">
                                    <label className="text-[11px] font-black uppercase tracking-wider text-slate-400">
                                        Kod zabezpieczający:
                                    </label>
                                    <div className="flex gap-2">
                                        <input
                                            type="password"
                                            value={modalBypassInput}
                                            onChange={(e) => setModalBypassInput(e.target.value)}
                                            placeholder="Wpisz kod zabezpieczający..."
                                            className="flex-1 bg-slate-950 border border-slate-700 focus:border-indigo-500 rounded-xl px-3.5 py-2.5 text-sm font-mono font-bold text-indigo-300 outline-none"
                                        />
                                    </div>
                                </div>

                                {/* Przyciski decyzyjne */}
                                <div className="space-y-2 pt-2">
                                    <button
                                        type="button"
                                        onClick={() => {
                                            const codeToUse = modalBypassInput.trim();
                                            executeActualSave(pendingSaveDraft || draft, codeToUse);
                                        }}
                                        disabled={isUploading}
                                        className="w-full py-3 px-4 rounded-2xl bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white font-black text-xs uppercase tracking-wider shadow-lg active:scale-95 transition flex items-center justify-center gap-2"
                                    >
                                        <span>🛡️ Zatwierdź z kodem</span>
                                    </button>

                                    <button
                                        type="button"
                                        onClick={() => {
                                            executeActualSave(pendingSaveDraft || draft, "");
                                        }}
                                        disabled={isUploading}
                                        className="w-full py-2.5 px-4 rounded-2xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 font-black text-xs uppercase tracking-wider active:scale-95 transition flex items-center justify-center gap-2"
                                    >
                                        <span>✉️ Zatwierdź bez kodu (Wyślij alert do dyrekcji)</span>
                                    </button>

                                    <button
                                        type="button"
                                        onClick={() => setIsBypassModalOpen(false)}
                                        className="w-full py-2 text-center text-xs font-bold text-slate-400 hover:text-white transition"
                                    >
                                        ✕ Anuluj i wróć do edycji
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}
                </main>
            )}
        </div>
    );
}
