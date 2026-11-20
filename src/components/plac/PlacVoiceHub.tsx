"use client";

import React, { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";

interface AgentResult {
    intent: string;
    agentId: string | null;
    agentName: string | null;
    speechReply: string;
    state: "COMPLETED" | "INPUT_REQUIRED" | "FAILED";
    data?: any;
    missingFields?: string[];
    quickReplies?: string[];
    navigateTo?: string | null;
}

interface PlacVoiceHubProps {
    userName: string;
    userId?: string;
    userEmail?: string;
}

export default function PlacVoiceHub({ userName, userId, userEmail }: PlacVoiceHubProps) {
    const router = useRouter();

    const [inputText, setInputText] = useState("");
    const [isListening, setIsListening] = useState(false);
    const [isThinking, setIsThinking] = useState(false);
    const [isSpeaking, setIsSpeaking] = useState(false);
    const [isAudioEnabled, setIsAudioEnabled] = useState(true);
    const [lastResult, setLastResult] = useState<AgentResult | null>(null);
    const [lastQuery, setLastQuery] = useState<string>("");
    const [isExpanded, setIsExpanded] = useState(false);

    const recognitionRef = useRef<any>(null);
    const isAudioEnabledRef = useRef<boolean>(isAudioEnabled);
    isAudioEnabledRef.current = isAudioEnabled;

    useEffect(() => {
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

    // Synteza mowy (TTS)
    const speakText = (text: string) => {
        if (!isAudioEnabledRef.current || typeof window === "undefined" || !("speechSynthesis" in window)) {
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

            const voices = window.speechSynthesis.getVoices();
            const plVoice = voices.find(v => v.lang.startsWith("pl") || v.lang.includes("PL"));
            if (plVoice) utterance.voice = plVoice;

            utterance.onstart = () => setIsSpeaking(true);
            utterance.onend = () => setIsSpeaking(false);
            utterance.onerror = () => setIsSpeaking(false);

            window.speechSynthesis.speak(utterance);
        } catch (e) {
            console.warn("Błąd SpeechSynthesis:", e);
            setIsSpeaking(false);
        }
    };

    // Rozpoznawanie mowy (STT)
    const startListening = () => {
        if (typeof window === "undefined") return;

        const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
        if (!SpeechRecognition) {
            alert("Twoja przeglądarka nie obsługuje rozpoznawania mowy. Możesz wpisać polecenie w polu tekstowym.");
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

            recognition.onstart = () => {
                setIsListening(true);
            };

            recognition.onresult = (event: any) => {
                const transcript = event.results[0][0].transcript;
                if (transcript && transcript.trim()) {
                    handleSend(transcript.trim());
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

    // Wysłanie zapytania do Orchestratora A2A
    const handleSend = async (text: string) => {
        if (!text.trim() || isThinking) return;

        stopListening();
        if (typeof window !== "undefined" && "speechSynthesis" in window) {
            window.speechSynthesis.cancel();
            setIsSpeaking(false);
        }

        setLastQuery(text.trim());
        setInputText("");
        setIsThinking(true);
        setIsExpanded(true);

        try {
            const res = await fetch("/api/plac/ai-orchestrator", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    userMessage: text.trim(),
                    userContext: {
                        userId,
                        userName,
                        userEmail
                    }
                })
            });

            const result: AgentResult = await res.json();
            setLastResult(result);

            if (result.speechReply) {
                speakText(result.speechReply);
            }

            // Jeśli intencja to bezpośrednia nawigacja z automatycznym przekierowaniem
            if (result.navigateTo && result.intent === "RETURN_NO_PROTOCOL") {
                setTimeout(() => {
                    router.push(result.navigateTo!);
                }, 1200);
            }
        } catch (err: any) {
            console.error("Błąd Orchestratora AI:", err);
            setLastResult({
                intent: "ERROR",
                agentId: null,
                agentName: null,
                state: "FAILED",
                speechReply: "Nie udało się połączyć z zespołem agentów. Spróbuj ponownie."
            });
        } finally {
            setIsThinking(false);
        }
    };

    return (
        <section className="relative overflow-hidden rounded-3xl border-2 border-indigo-500/40 bg-gradient-to-br from-indigo-950/60 via-slate-900 to-slate-950 p-4 sm:p-5 shadow-2xl space-y-4">
            {/* Nagłówek Huba AI */}
            <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                    <span className="text-xl">🎙️</span>
                    <div>
                        <div className="flex items-center gap-2">
                            <h2 className="text-base sm:text-lg font-black text-white leading-tight">
                                Cześć, {userName}!
                            </h2>
                            <span className="text-[10px] font-black uppercase tracking-wider bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 px-2 py-0.5 rounded-full">
                                A2A Multi-Agent
                            </span>
                        </div>
                        <p className="text-[11px] font-semibold text-slate-400">
                            Powiedz lub wpisz polecenie dla placu
                        </p>
                    </div>
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                    {/* Wycisz / Włącz mowę */}
                    <button
                        type="button"
                        onClick={() => {
                            const next = !isAudioEnabled;
                            setIsAudioEnabled(next);
                            if (!next && typeof window !== "undefined" && "speechSynthesis" in window) {
                                window.speechSynthesis.cancel();
                                setIsSpeaking(false);
                            }
                        }}
                        className={`p-2 rounded-xl border text-xs transition ${
                            isAudioEnabled
                                ? "border-indigo-500/40 bg-indigo-950/80 text-indigo-300"
                                : "border-slate-800 bg-slate-900 text-slate-500"
                        }`}
                        title={isAudioEnabled ? "Głos włączony" : "Głos wyłączony"}
                    >
                        {isAudioEnabled ? "🔊" : "🔇"}
                    </button>

                    {/* Pulsujący wskaźnik aktywności */}
                    <div className="flex items-center gap-1 bg-emerald-500/10 border border-emerald-500/30 px-2.5 py-1 rounded-xl">
                        <span className={`w-2 h-2 rounded-full ${isThinking ? "bg-amber-400 animate-spin" : isListening ? "bg-red-500 animate-ping" : "bg-emerald-400 animate-pulse"}`} />
                        <span className="text-[10px] font-black text-emerald-300 uppercase tracking-wider hidden sm:inline">
                            {isThinking ? "Przetwarzam" : isListening ? "Słucham" : "Gotowy"}
                        </span>
                    </div>
                </div>
            </div>

            {/* Pasek wejścia mowy i tekstu */}
            <form
                onSubmit={(e) => {
                    e.preventDefault();
                    handleSend(inputText);
                }}
                className="flex items-center gap-2"
            >
                <div className="relative flex-1">
                    <input
                        type="text"
                        value={inputText}
                        onChange={(e) => setInputText(e.target.value)}
                        placeholder={isListening ? "Mów teraz do mikrofonu..." : "Wpisz lub kliknij mikrofon..."}
                        disabled={isThinking}
                        className="w-full bg-slate-950/90 border border-slate-700/80 focus:border-indigo-500 rounded-2xl py-3 pl-4 pr-10 text-xs sm:text-sm text-slate-100 placeholder-slate-500 outline-none transition shadow-inner font-medium"
                    />
                    {inputText && (
                        <button
                            type="button"
                            onClick={() => setInputText("")}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 text-xs font-bold"
                        >
                            ✕
                        </button>
                    )}
                </div>

                {/* Przycisk Mikrofonu (1-tap talk) */}
                <button
                    type="button"
                    onClick={isListening ? stopListening : startListening}
                    disabled={isThinking}
                    className={`h-11 px-4 rounded-2xl font-black text-sm flex items-center justify-center gap-1.5 transition active:scale-95 shrink-0 shadow-lg ${
                        isListening
                            ? "bg-red-600 hover:bg-red-500 text-white animate-pulse shadow-red-900/50"
                            : "bg-gradient-to-r from-indigo-600 to-blue-600 hover:from-indigo-500 hover:to-blue-500 text-white shadow-indigo-900/40"
                    }`}
                    title={isListening ? "Zatrzymaj nasłuch" : "Kliknij i mów"}
                >
                    <span className="text-base">{isListening ? "⏹️" : "🎙️"}</span>
                    <span className="hidden sm:inline">{isListening ? "Słucham..." : "Mów"}</span>
                </button>

                {/* Przycisk Wyślij tekst */}
                {inputText.trim() && (
                    <button
                        type="submit"
                        disabled={isThinking}
                        className="h-11 px-3.5 rounded-2xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-indigo-300 font-black text-xs transition active:scale-95 shrink-0"
                    >
                        Wyślij
                    </button>
                )}
            </form>

            {/* Szybkie polecenia (Quick Chips) */}
            <div className="flex gap-1.5 overflow-x-auto pb-1 no-scrollbar text-[11px]">
                <button
                    type="button"
                    onClick={() => handleSend("Dopisz 20 zł na Tuchów")}
                    className="whitespace-nowrap px-3 py-1.5 rounded-xl bg-slate-900/90 border border-slate-700/80 text-slate-300 hover:text-white hover:border-indigo-400 active:scale-95 transition"
                >
                    💰 "Dopisz 20 zł na Tuchów"
                </button>
                <button
                    type="button"
                    onClick={() => handleSend("Gdzie jest młotowiertarka 61?")}
                    className="whitespace-nowrap px-3 py-1.5 rounded-xl bg-slate-900/90 border border-slate-700/80 text-slate-300 hover:text-white hover:border-indigo-400 active:scale-95 transition"
                >
                    🔧 "Gdzie jest młotowiertarka 61?"
                </button>
                <button
                    type="button"
                    onClick={() => handleSend("Co dzisiaj jedzie na wyjazd?")}
                    className="whitespace-nowrap px-3 py-1.5 rounded-xl bg-slate-900/90 border border-slate-700/80 text-slate-300 hover:text-white hover:border-indigo-400 active:scale-95 transition"
                >
                    📦 "Co dzisiaj na wyjazd?"
                </button>
                <button
                    type="button"
                    onClick={() => handleSend("Chcę zgłosić zwrot bez protokołu")}
                    className="whitespace-nowrap px-3 py-1.5 rounded-xl bg-slate-900/90 border border-slate-700/80 text-slate-300 hover:text-white hover:border-indigo-400 active:scale-95 transition"
                >
                    📋 "Zgłoś zwrot"
                </button>
            </div>

            {/* Interaktywny Panel Odpowiedzi i Kart Wynikowych */}
            {isExpanded && (lastQuery || lastResult || isThinking) && (
                <div className="bg-slate-950/80 rounded-2xl border border-slate-800 p-3.5 space-y-3 animate-in fade-in slide-in-from-top-2 duration-200">
                    {/* Zapytanie użytkownika */}
                    {lastQuery && (
                        <div className="flex items-start gap-2">
                            <span className="text-xs bg-slate-800 text-slate-400 px-2 py-0.5 rounded-lg font-bold">Ty:</span>
                            <p className="text-xs font-semibold text-slate-200">{lastQuery}</p>
                        </div>
                    )}

                    {/* Odpowiedź AI / Status myślenia */}
                    {isThinking ? (
                        <div className="flex items-center gap-2 text-xs text-indigo-300 font-bold animate-pulse">
                            <span className="w-2 h-2 rounded-full bg-indigo-400 animate-ping" />
                            <span>Mózg A2A deleguje zadanie do agenta...</span>
                        </div>
                    ) : lastResult ? (
                        <div className="space-y-2.5 pt-1 border-t border-slate-800/80">
                            {/* Odpowiedź słowna + Badge agenta */}
                            <div className="flex items-start justify-between gap-2">
                                <div className="space-y-1">
                                    {lastResult.agentName && (
                                        <span className="inline-block text-[10px] font-black uppercase tracking-wider text-indigo-400 bg-indigo-500/10 border border-indigo-500/30 px-2 py-0.5 rounded-md">
                                            🤖 {lastResult.agentName}
                                        </span>
                                    )}
                                    <p className="text-xs sm:text-sm font-bold text-white leading-relaxed">
                                        {lastResult.speechReply}
                                    </p>
                                </div>
                            </div>

                            {/* KARTA WYNIKOWA: Wydatki (Expense) */}
                            {lastResult.intent === "EXPENSE" && lastResult.data && (
                                <div className="bg-emerald-950/30 border border-emerald-500/40 rounded-xl p-3 text-xs space-y-1.5">
                                    <div className="flex items-center justify-between">
                                        <span className="font-bold text-emerald-400">✓ Wydatek Zarejestrowany</span>
                                        <span className="font-black text-sm text-white">{lastResult.data.amount} PLN</span>
                                    </div>
                                    <div className="text-slate-300">
                                        Budowa: <strong className="text-white">{lastResult.data.siteName}</strong>
                                    </div>
                                    <div className="text-slate-300">
                                        Tytuł: <span className="text-slate-200">{lastResult.data.title}</span>
                                    </div>
                                    <div className="text-[10px] text-emerald-400/80 font-mono">
                                        Kategoria: {lastResult.data.category} · Status: Zapisano w bazie
                                    </div>
                                </div>
                            )}

                            {/* KARTA WYNIKOWA: Sprzęt (Equipment) */}
                            {lastResult.intent === "EQUIPMENT" && lastResult.data?.items && (
                                <div className="space-y-2">
                                    <span className="text-[10px] font-black uppercase text-slate-400 tracking-wider">
                                        Dopasowany sprzęt w bazie ({lastResult.data.items.length}):
                                    </span>
                                    <div className="grid grid-cols-1 gap-1.5 max-h-52 overflow-y-auto pr-1">
                                        {lastResult.data.items.map((it: any) => (
                                            <div key={it.id} className="bg-slate-900 border border-slate-800 rounded-xl p-2 text-xs flex items-center justify-between gap-2">
                                                <div>
                                                    <div className="font-black text-white">{it.name}</div>
                                                    <div className="text-[10px] text-slate-400">
                                                        {it.inventoryNumber ? `Nr mag: ${it.inventoryNumber}` : it.category}
                                                    </div>
                                                </div>
                                                <div className="text-right">
                                                    <div className="text-[11px] font-bold text-indigo-300">
                                                        {it.locations?.[0]?.siteName || "Brak alokacji"}
                                                    </div>
                                                    <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${it.status === "SPRAWNY" ? "bg-emerald-500/20 text-emerald-300" : "bg-amber-500/20 text-amber-300"}`}>
                                                        {it.status}
                                                    </span>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {/* KARTA WYNIKOWA: Zamówienia (Orders) */}
                            {lastResult.intent === "ORDERS" && lastResult.data?.orders && (
                                <div className="space-y-1.5">
                                    <span className="text-[10px] font-black uppercase text-slate-400 tracking-wider">
                                        Dzisiejsze zlecenia:
                                    </span>
                                    <div className="grid grid-cols-1 gap-1.5 max-h-48 overflow-y-auto pr-1">
                                        {lastResult.data.orders.map((ord: any) => (
                                            <div key={ord.id} className="bg-slate-900 border border-slate-800 rounded-xl p-2 text-xs flex items-center justify-between">
                                                <div>
                                                    <div className="font-bold text-white">{ord.siteName}</div>
                                                    <div className="text-[10px] text-slate-400">Zamówienie #{ord.orderId}</div>
                                                </div>
                                                <div className="text-right">
                                                    <span className="text-indigo-300 font-bold">{ord.itemsCount} poz.</span>
                                                    <div className="text-[9px] text-slate-500 uppercase">{ord.status}</div>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {/* Przycisk Nawigacji jeśli intencja wskazała podstronę */}
                            {lastResult.navigateTo && (
                                <button
                                    type="button"
                                    onClick={() => router.push(lastResult.navigateTo!)}
                                    className="w-full py-2.5 px-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-black text-xs flex items-center justify-center gap-1.5 shadow transition active:scale-95"
                                >
                                    <span>Przejdź do modułu</span>
                                    <span>→</span>
                                </button>
                            )}

                            {/* Dynamiczne podpowiedzi (quick replies) */}
                            {lastResult.quickReplies && lastResult.quickReplies.length > 0 && (
                                <div className="flex flex-wrap gap-1.5 pt-1">
                                    {lastResult.quickReplies.map((qr, idx) => (
                                        <button
                                            key={idx}
                                            type="button"
                                            onClick={() => handleSend(qr)}
                                            className="text-[10px] font-bold px-2.5 py-1 rounded-lg bg-slate-800/90 hover:bg-slate-700 text-indigo-300 hover:text-white border border-slate-700 transition"
                                        >
                                            {qr}
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                    ) : null}
                </div>
            )}
        </section>
    );
}
