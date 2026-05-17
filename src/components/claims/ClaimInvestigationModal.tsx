// src/components/claims/ClaimInvestigationModal.tsx
"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { collection, addDoc } from "firebase/firestore";
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
    // NOWE: Dane od magazyniera
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

// Kompresja/resize zdjęcia przed uploadem (opcjonalnie)
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
    isOpen,
    onClose,
    onClaimCreated,
    inventoryId,
    inventoryName,
    inventoryNumber,
    siteName,
    reportedByUid,
    reportedByName,
    warehouseNotes, // Odbieramy notatkę
    declaredStatus  // Odbieramy status
}: ClaimInvestigationModalProps) {
    // Chat state
    const [displayMessages, setDisplayMessages] = useState<DisplayMessage[]>([]);
    const [apiMessages, setApiMessages] = useState<ConversationMessage[]>([]); // mirrors displayMessages but for API
    const [userInput, setUserInput] = useState("");
    const [isAiTyping, setIsAiTyping] = useState(false);
    const [isInitialized, setIsInitialized] = useState(false);

    // Investigation state
    const [isComplete, setIsComplete] = useState(false);
    const [caseContext, setCaseContext] = useState<string | null>(null);

    // Photo state
    const [pendingFiles, setPendingFiles] = useState<File[]>([]); // files queued to send with next message
    const [allUploadedPhotoUrls, setAllUploadedPhotoUrls] = useState<string[]>([]); // all uploaded URLs
    const [isUploading, setIsUploading] = useState(false);
    const [claimTempId] = useState(() => `tmp_${Date.now()}`); // stable ID for storage path

    // Submission
    const [isSubmitting, setIsSubmitting] = useState(false);

    const chatEndRef = useRef<HTMLDivElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    // Scroll to bottom on new messages
    useEffect(() => {
        chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [displayMessages, isAiTyping]);

    // Initialize investigation when modal opens
    useEffect(() => {
        if (isOpen && !isInitialized) {
            initializeInvestigation();
        }
        if (!isOpen) {
            resetState();
        }
    }, [isOpen]);

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
    };

    const initializeInvestigation = async () => {
        setIsInitialized(true);
        setIsAiTyping(true);
        try {
            const res = await fetch("/api/claims-ai-investigate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    inventoryName,
                    inventoryNumber,
                    siteName,
                    isInitial: true,
                    // ZMIANA: Wysyłamy notatkę do AI
                    warehouseNotes,
                    declaredStatus
                }),
            });
            const data = await res.json();
            const aiReply = data.reply || "Błąd inicjalizacji.";

            setDisplayMessages([{ role: "assistant", content: aiReply }]);
            setApiMessages([{ role: "assistant", content: aiReply }]);

            if (data.isComplete) {
                setIsComplete(true);
                setCaseContext(data.caseContext);
            }
        } catch (err) {
            console.error("Init error:", err);
            setDisplayMessages([
                {
                    role: "assistant",
                    content: "Błąd połączenia z systemem AI. Odśwież stronę i spróbuj ponownie.",
                },
            ]);
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

        // Build user message text for API (include photo info)
        const photoNote =
            newPhotoUrls.length > 0
                ? `\n[Dołączono ${newPhotoUrls.length} zdjęcie(a) jako dowód fotograficzny]`
                : "";
        const apiText = text + photoNote;

        // Update display
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

        // Call AI
        try {
            const res = await fetch("/api/claims-ai-investigate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    inventoryName,
                    inventoryNumber,
                    siteName,
                    messages: updatedApi,
                    // ZMIANA: Wysyłamy notatkę do AI dla pewności na każdym etapie
                    warehouseNotes,
                    declaredStatus
                }),
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
            console.error("Send error:", err);
            setDisplayMessages((prev) => [
                ...prev,
                { role: "assistant", content: "Błąd połączenia. Spróbuj ponownie." },
            ]);
        } finally {
            setIsAiTyping(false);
        }
    }, [userInput, pendingFiles, displayMessages, apiMessages, isAiTyping, isUploading, inventoryName, inventoryNumber, siteName, claimTempId, warehouseNotes, declaredStatus]);

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
            e.target.value = ""; // reset input so same files can be re-selected
        }
    };

    const removePendingFile = (index: number) => {
        setPendingFiles((prev) => prev.filter((_, i) => i !== index));
    };

    const submitToCourt = async () => {
        if (!caseContext || isSubmitting) return;
        setIsSubmitting(true);

        const claimId = generateClaimId();

        // Build claim messages from investigation (visible to all)
        // Build claim messages from investigation (visible to all)
        const investigationMessages = displayMessages.map((msg, i) => {
            return {
                id: `inv_${i}_${Date.now()}`,
                senderId: msg.role === "assistant" ? "system_ai" : reportedByUid,
                senderName: msg.role === "assistant" ? "Asystent Śledczy AI 🤖" : reportedByName,
                senderRole: msg.role === "assistant" ? "AI" : "MAGAZYN",
                text: msg.content,
                timestamp: new Date().toISOString(),
                visibleToWarehouse: true,
                imageUrl: msg.photos && msg.photos.length > 0 ? msg.photos[0] : null, // Zostawiamy dla kompatybilności wstecznej
                imageUrls: msg.photos || [], // NOWE: Przekazujemy całą tablicę zdjęć!
            };
        });

        // Dodajemy zdjęcia, które ew. były w drugiej iteracji msg.photos do głównej puli, ale rzadko się to zdarza

        // Add final AI summary message (internal, not visible to warehouse)
        const summaryMessage = {
            id: `summary_${Date.now()}`,
            senderId: "system_ai",
            senderName: "Asystent Śledczy AI 🤖",
            senderRole: "AI",
            text: `📋 PROTOKÓŁ WSTĘPNY – PRZEKAZANIE DO ZARZĄDU\n\nUwagi magazyniera: ${warehouseNotes || "Brak"}\nStatus: ${declaredStatus}\n\nAnaliza AI:\n${caseContext}\n\n📸 Łącznie zebranych zdjęć dowodowych: ${allUploadedPhotoUrls.length}`,
            timestamp: new Date().toISOString(),
            visibleToWarehouse: false,
            imageUrl: null, // Podsumowanie nie potrzebuje własnego zdjęcia
        };

        // Extract short description
        const shortDescription = `Zgłoszenie: ${declaredStatus}. ${warehouseNotes} | Wnioski AI: ${caseContext?.slice(0, 100).replace(/\n/g, " ") || "Brak"}`;

        try {
            const docRef = await addDoc(collection(db, "claims"), {
                claimId,
                inventoryId,
                inventoryName,
                inventoryNumber,
                siteName,
                reportedBy: reportedByUid,
                reportedByName,
                description: shortDescription,
                status: "NOWA",
                createdAt: new Date().toISOString(),
                assignedManagers: [],
                messages: [...investigationMessages, summaryMessage],
                evidencePhotos: allUploadedPhotoUrls, // all photo URLs for easy access
                investigationComplete: true,
                caseContext, // full AI summary
            });

            onClaimCreated(claimId, docRef.id);
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

    // Progress steps
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
                                        {isUser ? reportedByName : "Asystent Śledczy AI 🤖"}
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

                {/* ── COMPLETION BANNER ── */}
                {isComplete && (
                    <div className="flex-shrink-0 bg-green-50 border-t-2 border-green-300 px-5 py-4">
                        <div className="flex items-center gap-4">
                            <div className="text-2xl">✅</div>
                            <div className="flex-1 min-w-0">
                                <p className="text-sm font-black text-green-800 uppercase tracking-tight">
                                    Protokół zamknięty
                                </p>
                                <p className="text-xs text-green-700 mt-0.5 truncate">
                                    Zebrano komplet informacji.
                                    {allUploadedPhotoUrls.length > 0
                                        ? ` 📸 ${allUploadedPhotoUrls.length} zdjęcie(a) w aktach.`
                                        : " ⚠️ Brak zdjęć w aktach."}
                                </p>
                            </div>
                            <button
                                onClick={submitToCourt}
                                disabled={isSubmitting}
                                className="flex-shrink-0 bg-red-600 hover:bg-red-700 text-white font-black px-5 py-3 rounded-xl shadow-xl transition disabled:opacity-50 text-sm uppercase tracking-wide"
                            >
                                {isSubmitting ? (
                                    <span className="flex items-center gap-2">
                                        <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                                        Wysyłam...
                                    </span>
                                ) : (
                                    "⚖️ Wyślij do Sądu PESAM"
                                )}
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
                                capture="environment" // mobile: prefer camera
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