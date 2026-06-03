// src/app/(dashboard)/vehicles/reports/page.tsx
"use client";

import React, { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/auth/AuthContext";
import { hasPermission } from "@/lib/auth/permissions";

import {
    Chart as ChartJS, CategoryScale, LinearScale, BarElement, Title, Tooltip, Legend, ArcElement, PointElement, LineElement
} from 'chart.js';
import { Bar, Pie, Line } from 'react-chartjs-2';

ChartJS.register(CategoryScale, LinearScale, BarElement, Title, Tooltip, Legend, ArcElement, PointElement, LineElement);

interface ChatMessage {
    role: "user" | "ai";
    text: string;
}

interface CanvasWidget {
    type: "none" | "chart" | "table" | "kpi";
    data: any;
}

export default function FleetReportsHub() {
    const { user } = useAuth();
    const [loadingData, setLoadingData] = useState(false);

    // Stany komunikacji z AI
    const [prompt, setPrompt] = useState("");
    const [isThinking, setIsThinking] = useState(false);
    const [chatHistory, setChatHistory] = useState<ChatMessage[]>([
        { role: "ai", text: "Cześć! Jestem Twoim Asystentem Analitycznym. Aby rozpocząć analizę floty, wpisz swoje pytanie poniżej (np. 'podaj naprawy forda transita')." }
    ]);

    // Dynamiczne statusy na czas oczekiwania na analizę
    const [thinkingStep, setThinkingStep] = useState(0);
    const thinkingMessages = [
        "Inicjalizacja rundy analitycznej...",
        "Sprawdzanie dostępności pojazdów w bazie danych...",
        "Filtrowanie rekordów dla wybranej grupy aut...",
        "Pobieranie kosztów i wpisów serwisowych z Firestore...",
        "Uruchamianie piaskownicy Pythona i przetwarzanie matematyczne...",
        "Generowanie parametrów do wizualizacji danych..."
    ];

    useEffect(() => {
        let interval: any;
        if (isThinking) {
            setThinkingStep(0);
            interval = setInterval(() => {
                setThinkingStep(prev => {
                    // Zatrzymanie rotacji na ostatnim, głównym statusie (nie wraca do 'Inicjalizacji')
                    if (prev < thinkingMessages.length - 1) {
                        return prev + 1;
                    }
                    return prev;
                });
            }, 3000); // Zmiana komunikatu co 3 sekundy
        } else {
            clearInterval(interval);
        }
        return () => clearInterval(interval);
    }, [isThinking]);

    // --- FUNKCJONALNOŚĆ HISTORII WIDGETÓW ---
    const [widgetHistory, setWidgetHistory] = useState<CanvasWidget[]>([]);
    const [currentWidgetIndex, setCurrentWidgetIndex] = useState<number>(-1);
    const [activeWidget, setActiveWidget] = useState<CanvasWidget>({ type: "none", data: null });

    // --- FUNKCJONALNOŚĆ LOGÓW AI ---
    const [executionLogs, setExecutionLogs] = useState<string[]>([]);
    const [showLogs, setShowLogs] = useState(true);

    const [dbCache, setDbCache] = useState<any>(null);
    const chatEndRef = useRef<HTMLDivElement>(null);

    const canView = user ? hasPermission("viewVehicles", user.rolePermissions, user.permissionOverrides) : false;

    useEffect(() => {
        chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [chatHistory, isThinking]);

    if (!canView) return <div className="p-10 text-center text-red-500 font-bold">Brak uprawnień do raportów.</div>;

    const handleAskAI = async () => {
        if (!prompt.trim()) return;

        const userMsg = prompt.trim();
        setPrompt("");
        setChatHistory(prev => [...prev, { role: "user", text: userMsg }]);
        setIsThinking(true);

        // Zamiast ukrywać czarny panel, od razu pokazujemy statusy startowe na czas myślenia AI
        setExecutionLogs([
            "Inicjalizacja kolejnej rundy pytań...",
            "Przesyłanie historii rozmowy do modeli Gemini...",
            "Wywoływanie procesów analitycznych na serwerze..."
        ]);

        try {
            const res = await fetch("/api/ai-analyst", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    question: userMsg,
                    currentHistory: chatHistory,
                    cachedData: dbCache
                })
            });

            const data = await res.json();

            if (data.error) throw new Error(data.error);

            // Aktualizacja czatu
            setChatHistory(prev => [...prev, { role: "ai", text: data.message || "Oto wynik analizy na panelu." }]);

            // Odebranie i zapisanie logów zdarzeń z serwera
            if (data.logs && Array.isArray(data.logs)) {
                setExecutionLogs(data.logs);
            }

            if (data.newCache && Object.keys(data.newCache).length > 0) {
                setDbCache(data.newCache);
            }

            // Obsługa generowania i historii widgetu
            if (data.uiAction) {
                const newWidget: CanvasWidget = { type: data.uiAction.type, data: data.uiAction.payload };

                // Dodajemy nowy widget do historii i ustawiamy go jako aktywny
                setWidgetHistory(prev => {
                    const updated = [...prev, newWidget];
                    setCurrentWidgetIndex(updated.length - 1);
                    return updated;
                });
                setActiveWidget(newWidget);
            }

        } catch (error: any) {
            console.error(error);
            setChatHistory(prev => [...prev, { role: "ai", text: "Napotkałem problem podczas analizy danych: " + error.message }]);
        } finally {
            setIsThinking(false);
        }
    };

    // Obsługa cofania/przechodzenia w historii widgetów
    const navigateHistory = (index: number) => {
        if (index >= 0 && index < widgetHistory.length) {
            setCurrentWidgetIndex(index);
            setActiveWidget(widgetHistory[index]);
        }
    };

    const renderCanvas = () => {
        // --- NOWOŚĆ: PEŁNOEKRANOWY EKRAN ŁADOWANIA PRACY AI NA CANVASIE ---
        if (isThinking) {
            return (
                <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-50/90 backdrop-blur-sm rounded-3xl space-y-5 animate-fade-in z-20">
                    <div className="relative flex items-center justify-center">
                        {/* Kręcący się pierścień z robotem */}
                        <div className="w-20 h-20 border-4 border-blue-100 rounded-full"></div>
                        <div className="absolute w-20 h-20 border-4 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
                        <span className="absolute text-3xl">🤖</span>
                    </div>
                    <div className="text-center space-y-2 px-6">
                        <p className="font-black text-slate-700 text-base">Trwa analiza danych floty PESAM...</p>
                        <p className="text-xs text-blue-600 font-bold animate-pulse tracking-wide uppercase">
                            {thinkingMessages[thinkingStep]}
                        </p>
                    </div>
                </div>
            );
        }

        if (activeWidget.type === "none") {
            return (
                <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-300 space-y-4">
                    <span className="text-6xl">📊</span>
                    <p className="font-bold text-slate-400">Dynamiczny Canvas oczekuje na instrukcje</p>
                    <p className="text-xs text-center px-10">Zadaj pytanie Asystentowi obok, a wykresy i tabele wygenerują się w tym miejscu automatycznie.</p>
                </div>
            );
        }

        if (activeWidget.type === "chart" && activeWidget.data) {
            const chartData = {
                labels: activeWidget.data.labels,
                datasets: [{
                    label: activeWidget.data.datasetLabel || 'Wartość',
                    data: activeWidget.data.values,
                    backgroundColor: activeWidget.data.colors || ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6'],
                    borderWidth: 1,
                }]
            };

            const options = { responsive: true, maintainAspectRatio: false, plugins: { title: { display: true, text: activeWidget.data.title } } };

            return (
                <div className="absolute inset-0 flex flex-col items-center justify-center bg-white rounded-3xl p-6 shadow-sm border border-slate-100">
                    <div className="w-full h-[90%] flex items-center justify-center">
                        {activeWidget.data.chartType === 'bar' && <Bar data={chartData} options={options} />}
                        {activeWidget.data.chartType === 'pie' && <Pie data={chartData} options={options} />}
                        {activeWidget.data.chartType === 'line' && <Line data={chartData} options={options} />}
                    </div>
                </div>
            );
        }

        if (activeWidget.type === "table" && activeWidget.data) {
            return (
                <div className="absolute inset-0 flex flex-col bg-white rounded-3xl p-6 shadow-sm border border-slate-100 overflow-hidden">
                    <h3 className="font-black text-slate-700 text-lg mb-4">{activeWidget.data.title}</h3>
                    <div className="flex-1 overflow-auto rounded-xl border border-slate-200">
                        <table className="w-full text-left text-sm">
                            <thead className="bg-slate-50 sticky top-0">
                                <tr>
                                    {activeWidget.data.columns.map((col: string, i: number) => (
                                        <th key={i} className="p-3 font-bold text-slate-600 border-b">{col}</th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {activeWidget.data.rows.map((row: any[], i: number) => (
                                    <tr key={i} className="border-b hover:bg-slate-50 transition">
                                        {row.map((cell: any, j: number) => (
                                            <td key={j} className="p-3 text-slate-600">{cell}</td>
                                        ))}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            );
        }

        if (activeWidget.type === "kpi" && activeWidget.data) {
            return (
                <div className="absolute inset-0 flex flex-col bg-white rounded-3xl p-6 shadow-sm border border-slate-100 overflow-y-auto">
                    <h3 className="font-black text-slate-700 text-lg mb-6">{activeWidget.data.title}</h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {activeWidget.data.metrics.map((metric: any, i: number) => (
                            <div key={i} className="bg-slate-50 border border-slate-100 p-5 rounded-2xl flex flex-col justify-center">
                                <span className="text-sm font-bold text-slate-400 uppercase tracking-wider">{metric.label}</span>
                                <span className="text-3xl font-black text-slate-800 mt-1">{metric.value}</span>
                            </div>
                        ))}
                    </div>
                </div>
            );
        }

        return null;
    };

    return (
        <div className="p-6 md:p-10 max-w-[1600px] mx-auto h-[calc(100vh-60px)] flex flex-col animate-fade-in space-y-4">
            {/* Nagłówek */}
            <div className="flex justify-between items-center pb-2">
                <div>
                    <div className="flex items-center gap-3">
                        <Link href="/dashboard/vehicles" className="text-slate-400 hover:text-slate-800 text-sm font-bold transition flex items-center gap-1">
                            ⬅ Powrót do Floty
                        </Link>
                    </div>
                    <h1 className="text-3xl font-black text-slate-800 tracking-tight mt-2 flex items-center gap-3">
                        🤖 AI Data Analyst <span className="bg-purple-100 text-purple-700 text-[10px] uppercase px-2 py-1 rounded-lg">Wersja Eksperymentalna</span>
                    </h1>
                </div>
            </div>

            {/* GŁÓWNY WIDOK: 50/50 CZAT vs CANVAS */}
            <div className="flex-1 flex flex-col lg:flex-row gap-6 min-h-0">

                {/* LEWA STRONA: CZAT */}
                <div className="w-full lg:w-1/3 bg-white border border-slate-200 rounded-3xl shadow-sm flex flex-col overflow-hidden">
                    <div className="bg-slate-50 border-b border-slate-200 p-4 font-bold text-slate-700 text-sm flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></span>
                        Konsola poleceń AI
                    </div>

                    {/* Lista wiadomości */}
                    <div className="flex-1 overflow-y-auto p-4 space-y-4">
                        {chatHistory.map((msg, i) => (
                            <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                                <div className={`max-w-[85%] p-3 rounded-2xl text-sm ${msg.role === 'user' ? 'bg-blue-600 text-white rounded-br-none' : 'bg-slate-100 text-slate-700 rounded-bl-none border border-slate-200'}`}>
                                    {msg.text}
                                </div>
                            </div>
                        ))}
                        {isThinking && (
                            <div className="flex justify-start">
                                <div className="bg-slate-100 text-slate-500 p-3 rounded-2xl rounded-bl-none border border-slate-200 text-xs flex gap-2 items-center">
                                    <span className="animate-spin text-blue-600 font-bold">⚙</span>
                                    <span>{thinkingMessages[thinkingStep]}</span>
                                </div>
                            </div>
                        )}
                        <div ref={chatEndRef} />
                    </div>

                    {/* DZIENNIK ZDARZEŃ AI (LOGS PANEL) */}
                    {executionLogs.length > 0 && (
                        <div className="border-t border-slate-150 bg-slate-900 text-slate-300 p-3 text-[11px] font-mono max-h-[150px] overflow-y-auto">
                            <div className="flex justify-between items-center text-[10px] text-slate-500 font-bold uppercase tracking-wider mb-2 border-b border-slate-800 pb-1">
                                <span>⚙️ Dziennik Pracy Agentów AI</span>
                                <button onClick={() => setShowLogs(!showLogs)} className="hover:text-white">
                                    {showLogs ? "[Ukryj]" : "[Pokaż]"}
                                </button>
                            </div>
                            {showLogs && (
                                <div className="space-y-1">
                                    {executionLogs.map((log, i) => (
                                        <div key={i} className="flex gap-1.5">
                                            <span className="text-green-500">✔</span>
                                            <span>{log}</span>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}

                    {/* Input czatu */}
                    <div className="p-4 bg-white border-t border-slate-100">
                        <div className="relative">
                            <input
                                type="text"
                                value={prompt}
                                onChange={e => setPrompt(e.target.value)}
                                onKeyDown={e => e.key === 'Enter' && handleAskAI()}
                                placeholder="np. Zrób wykres kosztów..."
                                disabled={isThinking}
                                className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-3 pl-4 pr-12 text-sm outline-none focus:border-blue-500 focus:bg-white transition"
                            />
                            <button
                                onClick={handleAskAI}
                                disabled={isThinking || !prompt.trim()}
                                className="absolute right-2 top-2 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 text-white p-1.5 rounded-xl transition-colors"
                            >
                                ⬆️
                            </button>
                        </div>
                    </div>
                </div>

                {/* PRAWA STRONA: DYNAMIC CANVAS Z HISTORIĄ NAWIGACJI */}
                <div className="w-full lg:w-2/3 bg-slate-50 border border-slate-200 border-dashed rounded-3xl p-4 relative overflow-hidden flex flex-col">

                    {/* PASEK NAWIGACJI WSTECZ/W PRZÓD DLA WIDGETÓW */}
                    <div className="flex justify-between items-center mb-4 z-10">
                        <div className="text-xs font-black text-slate-400 uppercase tracking-widest">Strefa Wizualizacji (Canvas)</div>

                        {widgetHistory.length > 1 && (
                            <div className="flex items-center gap-3 bg-white px-3 py-1.5 rounded-2xl border shadow-sm">
                                <button
                                    onClick={() => navigateHistory(currentWidgetIndex - 1)}
                                    disabled={currentWidgetIndex <= 0}
                                    className="text-xs font-bold text-blue-600 disabled:text-slate-300 hover:text-blue-800 transition"
                                >
                                    ◀ Wstecz
                                </button>
                                <span className="text-[11px] font-bold text-slate-500">
                                    Widok {currentWidgetIndex + 1} z {widgetHistory.length}
                                </span>
                                <button
                                    onClick={() => navigateHistory(currentWidgetIndex + 1)}
                                    disabled={currentWidgetIndex >= widgetHistory.length - 1}
                                    className="text-xs font-bold text-blue-600 disabled:text-slate-300 hover:text-blue-800 transition"
                                >
                                    Dalej ▶
                                </button>
                            </div>
                        )}
                    </div>

                    <div className="flex-1 w-full relative">
                        {renderCanvas()}
                    </div>
                </div>

            </div>
        </div>
    );
}