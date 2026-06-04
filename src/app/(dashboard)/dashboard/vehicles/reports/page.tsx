"use client";

import React, { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/auth/AuthContext";
import { hasPermission } from "@/lib/auth/permissions";

// --- IMPORTY BAZY DANYCH I SYNCHRONIZACJI ---
import { localGetAllVehicles, localGetAllRepairs } from "@/lib/db/pesam-db";
import { usePesamSync } from "@/lib/db/use-pesam-sync";
import { collection, getDocs, writeBatch } from "firebase/firestore";
import { db } from "@/lib/firebase/config";

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

    // --- HOOK SYNCHRONIZACJI (Pobiera nowe dane w tle) ---
    const { isSyncing, syncStatus } = usePesamSync();

    // Stany komunikacji z AI
    const [prompt, setPrompt] = useState("");
    const [isThinking, setIsThinking] = useState(false);
    const [chatHistory, setChatHistory] = useState<ChatMessage[]>([
        { role: "ai", text: "Cześć! Jestem Twoim Asystentem Analitycznym. Dane flotowe są zsynchronizowane lokalnie. O co chcesz zapytać?" }
    ]);

    const [thinkingStep, setThinkingStep] = useState(0);
    const thinkingMessages = [
        "Inicjalizacja rundy analitycznej...",
        "Analiza struktury zapytań i intencji...",
        "Przycinanie i optymalizacja paczki danych...",
        "Uruchamianie piaskownicy Pythona (Code Execution)...",
        "Wykonywanie obliczeń matematycznych...",
        "Generowanie parametrów do wizualizacji na Canvasie..."
    ];

    useEffect(() => {
        let interval: any;
        if (isThinking) {
            setThinkingStep(0);
            interval = setInterval(() => {
                setThinkingStep(prev => {
                    if (prev < thinkingMessages.length - 1) return prev + 1;
                    return prev;
                });
            }, 2500);
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
    const [tokenUsage, setTokenUsage] = useState({ input: 0, output: 0 }); // 🪙 DODANO: Licznik tokenów
    const chatEndRef = useRef<HTMLDivElement>(null);

    const canView = user ? hasPermission("viewVehicles", user.rolePermissions, user.permissionOverrides) : false;

    useEffect(() => {
        chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [chatHistory, isThinking]);


    // =========================================================================
    // JEDNORAZOWY SKRYPT MIGRACYJNY (DO USUNIĘCIA PO UŻYCIU)
    // =========================================================================
    const handleMigrateUpdatedAt = async () => {
        if (!confirm("⚠️ Migracja: Doda pole updatedAt do wszystkich starych napraw i pojazdów w Firestore. Kontynuować?")) return;

        try {
            // 1. Migracja Napraw
            let snap = await getDocs(collection(db, "repairs"));
            let batch = writeBatch(db);
            let count = 0, batchCount = 0;

            for (const docSnap of snap.docs) {
                const data = docSnap.data();
                if (data.updatedAt) continue;

                const updatedAt = data.date ? `${data.date}T00:00:00.000Z` : "2020-01-01T00:00:00.000Z";
                batch.update(docSnap.ref, { updatedAt });
                count++; batchCount++;

                if (batchCount === 499) { await batch.commit(); batchCount = 0; batch = writeBatch(db); }
            }
            if (batchCount > 0) await batch.commit();

            // 2. Migracja Pojazdów
            snap = await getDocs(collection(db, "vehicles"));
            batch = writeBatch(db);
            let vCount = 0; batchCount = 0;

            for (const docSnap of snap.docs) {
                const data = docSnap.data();
                if (data.updatedAt) continue;

                const updatedAt = data.dateAdded ? `${data.dateAdded}T00:00:00.000Z` : "2020-01-01T00:00:00.000Z";
                batch.update(docSnap.ref, { updatedAt });
                vCount++; batchCount++;

                if (batchCount === 499) { await batch.commit(); batchCount = 0; batch = writeBatch(db); }
            }
            if (batchCount > 0) await batch.commit();

            alert(`✅ Migracja zakończona! Zaktualizowano ${count} napraw i ${vCount} pojazdów.`);
        } catch (err: any) {
            alert("Błąd migracji: " + err.message);
        }
    };


    // =========================================================================
    // GŁÓWNA FUNKCJA WYSYŁAJĄCA ZAPYTANIE DO AI
    // =========================================================================
    const handleAskAI = async () => {
        if (!prompt.trim()) return;

        const userMsg = prompt.trim();
        setPrompt("");
        setChatHistory(prev => [...prev, { role: "user", text: userMsg }]);
        setIsThinking(true);

        setExecutionLogs([
            "Inicjalizacja kolejnej rundy pytań...",
            "Pobieranie aktualnych danych z lokalnej bazy IndexedDB..."
        ]);

        try {
            // 1. ZAMIAST FIRESTORE: Szybki odczyt z lokalnego dysku przeglądarki (IndexedDB)
            const vehicles = await localGetAllVehicles();
            const repairs = await localGetAllRepairs();

            // 2. Wysłanie danych do serwera analitycznego (API)
            const res = await fetch("/api/ai-analyst", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    question: userMsg,
                    currentHistory: chatHistory,
                    vehicles: vehicles, // 🚀 Wrzucamy dane lokalne do API
                    repairs: repairs    // 🚀 Wrzucamy dane lokalne do API
                })
            });

            const data = await res.json();
            if (data.error) throw new Error(data.error);

            // 🪙 DODANO: Aktualizacja stanu tokenów z odpowiedzi serwera
            if (data.usage) {
                setTokenUsage(prev => ({
                    input: prev.input + data.usage.input,
                    output: prev.output + data.usage.output
                }));
            }

            setChatHistory(prev => [...prev, { role: "ai", text: data.message || "Oto wynik analizy na panelu." }]);

            if (data.logs && Array.isArray(data.logs)) {
                setExecutionLogs(data.logs);
            }

            if (data.uiAction) {
                const newWidget: CanvasWidget = { type: data.uiAction.type, data: data.uiAction.payload };
                setWidgetHistory(prev => {
                    const updated = [...prev, newWidget];
                    setCurrentWidgetIndex(updated.length - 1);
                    return updated;
                });
                setActiveWidget(newWidget);
            }

        } catch (error: any) {
            console.error(error);
            setChatHistory(prev => [...prev, { role: "ai", text: "Napotkałem problem podczas analizy: " + error.message }]);
        } finally {
            setIsThinking(false);
        }
    };

    const navigateHistory = (index: number) => {
        if (index >= 0 && index < widgetHistory.length) {
            setCurrentWidgetIndex(index);
            setActiveWidget(widgetHistory[index]);
        }
    };

    if (!canView) return <div className="p-10 text-center text-red-500 font-bold">Brak uprawnień do raportów.</div>;

    const renderCanvas = () => {
        if (isThinking) {
            return (
                <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-50/90 backdrop-blur-sm rounded-3xl space-y-5 animate-fade-in z-20">
                    <div className="relative flex items-center justify-center">
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
                        {/* WSKAŹNIK SYNCHRONIZACJI DEXIE */}
                        <div className={`px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider ${isSyncing ? 'bg-blue-100 text-blue-700 animate-pulse' : 'bg-green-100 text-green-700'}`}>
                            {isSyncing ? `🔄 ${syncStatus}` : '✅ Baza Zsynchronizowana'}
                        </div>
                    </div>
                    <h1 className="text-3xl font-black text-slate-800 tracking-tight mt-2 flex items-center gap-3">
                        🤖 AI Data Analyst <span className="bg-purple-100 text-purple-700 text-[10px] uppercase px-2 py-1 rounded-lg">Architektura Local-First</span>
                    </h1>
                </div>

                {/* PRZYCISK JEDNORAZOWEJ MIGRACJI - DO USUNIĘCIA */}
                <button onClick={handleMigrateUpdatedAt} className="bg-red-100 hover:bg-red-200 text-red-700 border border-red-300 font-bold px-4 py-2 rounded-xl text-xs transition shadow-sm">
                    ⚠️ Uruchom Migrację Bazy (Zrób to tylko raz!)
                </button>
            </div>

            {/* GŁÓWNY WIDOK: 50/50 CZAT vs CANVAS */}
            <div className="flex-1 flex flex-col lg:flex-row gap-6 min-h-0">

                {/* LEWA STRONA: CZAT */}
                <div className="w-full lg:w-1/3 bg-white border border-slate-200 rounded-3xl shadow-sm flex flex-col overflow-hidden">
                    <div className="bg-slate-50 border-b border-slate-200 p-4 font-bold text-slate-700 text-sm flex justify-between items-center">
                        <div className="flex items-center gap-2">
                            <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></span>
                            Konsola poleceń AI
                        </div>
                        {/* 🪙 DODANO: LICZNIK TOKENÓW W NAGŁÓWKU */}
                        {(tokenUsage.input > 0 || tokenUsage.output > 0) && (
                            <div className="text-[10px] text-slate-500 font-mono font-medium bg-slate-200/50 px-2 py-1 rounded-md flex gap-3 border border-slate-200">
                                <span title="Tokeny Wejściowe">In: <span className="font-bold text-blue-600">{(tokenUsage.input / 1000).toFixed(1)}k</span></span>
                                <span title="Tokeny Wyjściowe">Out: <span className="font-bold text-emerald-600">{tokenUsage.output}</span></span>
                            </div>
                        )}
                    </div>

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

                    {executionLogs.length > 0 && (
                        <div className="border-t border-slate-200 bg-slate-50 p-4 max-h-[220px] overflow-y-auto">
                            <div className="flex justify-between items-center mb-3">
                                <span className="text-xs font-black text-slate-500 uppercase tracking-wider flex items-center gap-1.5">
                                    🧠 Przebieg analizy
                                </span>
                                <button
                                    onClick={() => setShowLogs(!showLogs)}
                                    className="text-[10px] font-bold text-blue-600 hover:text-blue-800 uppercase"
                                >
                                    {showLogs ? "Zwiń" : "Rozwiń"}
                                </button>
                            </div>
                            {showLogs && (
                                <div className="space-y-2.5 text-xs text-slate-600">
                                    {executionLogs.map((log, i) => {
                                        return (
                                            <div key={i} className="p-2.5 rounded-xl border bg-white border-slate-100">
                                                <div className="flex gap-2">
                                                    <span className="text-emerald-600">⚙</span>
                                                    <span className="leading-relaxed">{log}</span>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    )}

                    <div className="p-4 bg-white border-t border-slate-100">
                        <div className="relative">
                            <input
                                type="text"
                                value={prompt}
                                onChange={e => setPrompt(e.target.value)}
                                onKeyDown={e => e.key === 'Enter' && handleAskAI()}
                                placeholder="np. Zrób wykres kosztów na auta..."
                                disabled={isThinking || isSyncing}
                                className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-3 pl-4 pr-12 text-sm outline-none focus:border-blue-500 focus:bg-white transition"
                            />
                            <button
                                onClick={handleAskAI}
                                disabled={isThinking || isSyncing || !prompt.trim()}
                                className="absolute right-2 top-2 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 text-white p-1.5 rounded-xl transition-colors"
                            >
                                ⬆️
                            </button>
                        </div>
                        {isSyncing && <p className="text-[10px] text-blue-500 mt-2 text-center">Poczekaj na zakończenie synchronizacji...</p>}
                    </div>
                </div>

                {/* PRAWA STRONA: DYNAMIC CANVAS */}
                <div className="w-full lg:w-2/3 bg-slate-50 border border-slate-200 border-dashed rounded-3xl p-4 relative overflow-hidden flex flex-col">
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