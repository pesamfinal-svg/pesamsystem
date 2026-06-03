// src/app/(dashboard)/vehicles/reports/page.tsx
"use client";

import React, { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/auth/AuthContext";
import { hasPermission } from "@/lib/auth/permissions";
import { collection, getDocs } from "firebase/firestore";
import { db } from "@/lib/firebase/config";

// Komponenty Chart.js (zostaną użyte, gdy AI wywoła wykres)
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
    data: any; // Tu wpadnie JSON wygenerowany przez AI
}

export default function FleetReportsHub() {
    const { user } = useAuth();
    const [loadingData, setLoadingData] = useState(true);
    const [fleetData, setFleetData] = useState<any>(null); // Zanonimizowana paczka dla AI

    // Stany komunikacji z AI
    const [prompt, setPrompt] = useState("");
    const [isThinking, setIsThinking] = useState(false);
    const [chatHistory, setChatHistory] = useState<ChatMessage[]>([
        { role: "ai", text: "Cześć! Jestem Twoim Asystentem Analitycznym. Pobieram właśnie najświeższe dane o flocie... O co chcesz mnie zapytać?" }
    ]);

    // Stan strefy Canvas (prawa strona)
    const [activeWidget, setActiveWidget] = useState<CanvasWidget>({ type: "none", data: null });
    const [dbCache, setDbCache] = useState<any>(null); // DODANO: Pamięć podręczna pobranych danych
    const chatEndRef = useRef<HTMLDivElement>(null);

    const canView = user ? hasPermission("viewVehicles", user.rolePermissions, user.permissionOverrides) : false;

    // Pobieranie danych do kontekstu AI (w tle)
    useEffect(() => {
        const fetchFleetData = async () => {
            try {
                const vehiclesSnap = await getDocs(collection(db, "vehicles"));
                const repairsSnap = await getDocs(collection(db, "repairs"));

                const vehicles = vehiclesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
                const repairs = repairsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

                // Minimalizujemy wielkość danych (odrzucamy długie nulle, niepotrzebne obiekty)
                setFleetData({
                    vehiclesCount: vehicles.length,
                    repairsCount: repairs.length,
                    vehicles: vehicles,
                    repairs: repairs
                });

                setChatHistory([{ role: "ai", text: `Dane załadowane! Widzę w systemie ${vehicles.length} pojazdów i ${repairs.length} wpisów serwisowych. W czym mogę pomóc? (np. "Narysuj mi wykres słupkowy z kosztami napraw według marki")` }]);
            } catch (error) {
                console.error("Błąd pobierania danych floty:", error);
            } finally {
                setLoadingData(false);
            }
        };

        if (canView) fetchFleetData();
    }, [canView]);

    // Automatyczne scrollowanie czatu
    useEffect(() => {
        chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [chatHistory, isThinking]);

    if (!canView) return <div className="p-10 text-center text-red-500 font-bold">Brak uprawnień do raportów.</div>;

    const handleAskAI = async () => {
        if (!prompt.trim() || !fleetData) return;

        const userMsg = prompt.trim();
        setPrompt("");
        setChatHistory(prev => [...prev, { role: "user", text: userMsg }]);
        setIsThinking(true);

        try {
            const res = await fetch("/api/ai-analyst", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    question: userMsg,
                    // fleetData zniknęło, nie wysyłamy całej bazy!
                    currentHistory: chatHistory,
                    cachedData: dbCache // DODANO: Wysyłamy pamięć z poprzedniego kroku
                })
            });

            const data = await res.json();

            if (data.error) throw new Error(data.error);

            // Odpowiedź tekstowa na czacie
            setChatHistory(prev => [...prev, { role: "ai", text: data.message || "Oto wynik mojej analizy na ekranie obok." }]);

            // DODANO: Zapisujemy nową pamięć z backendu (jeśli AI coś pobrało)
            if (data.newCache && Object.keys(data.newCache).length > 0) {
                setDbCache(data.newCache);
            }

            // Jeśli AI zdecydowało się wygenerować akcję UI
            if (data.uiAction) {
                setActiveWidget({ type: data.uiAction.type, data: data.uiAction.payload });
            }

        } catch (error: any) {
            console.error(error);
            setChatHistory(prev => [...prev, { role: "ai", text: "Przepraszam, napotkałem techniczny problem podczas analizy danych: " + error.message }]);
        } finally {
            setIsThinking(false);
        }
    };

    // --- FUNKCJA RENDERUJĄCA CANVAS (Krok 3 i 4 z planu) ---
    const renderCanvas = () => {
        if (activeWidget.type === "none") {
            return (
                <div className="h-full flex flex-col items-center justify-center text-slate-300 space-y-4">
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
                <div className="h-full flex flex-col items-center justify-center bg-white rounded-3xl p-6 shadow-sm border border-slate-100 relative">
                    <div className="absolute top-4 right-4 text-xs bg-blue-50 text-blue-600 font-black px-3 py-1 rounded-full border border-blue-100">Zasilane przez AI</div>
                    <div className="w-full h-[80%] flex items-center justify-center">
                        {activeWidget.data.chartType === 'bar' && <Bar data={chartData} options={options} />}
                        {activeWidget.data.chartType === 'pie' && <Pie data={chartData} options={options} />}
                        {activeWidget.data.chartType === 'line' && <Line data={chartData} options={options} />}
                    </div>
                </div>
            );
        }

        // --- NOWE: RENDEROWANIE TABELI ---
        if (activeWidget.type === "table" && activeWidget.data) {
            return (
                <div className="h-full flex flex-col bg-white rounded-3xl p-6 shadow-sm border border-slate-100 relative overflow-hidden">
                    <div className="absolute top-4 right-4 text-xs bg-green-50 text-green-600 font-black px-3 py-1 rounded-full border border-green-100">Tabela Danych AI</div>
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

        // --- NOWE: RENDEROWANIE KART STATYSTYK (KPI) ---
        if (activeWidget.type === "kpi" && activeWidget.data) {
            return (
                <div className="h-full flex flex-col bg-white rounded-3xl p-6 shadow-sm border border-slate-100 relative overflow-y-auto">
                    <div className="absolute top-4 right-4 text-xs bg-purple-50 text-purple-600 font-black px-3 py-1 rounded-full border border-purple-100">Podsumowanie AI</div>
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
                                <div className="bg-slate-100 text-slate-500 p-3 rounded-2xl rounded-bl-none border border-slate-200 text-sm flex gap-2 items-center">
                                    <span className="animate-bounce">●</span><span className="animate-bounce delay-75">●</span><span className="animate-bounce delay-150">●</span> Pisze kod i analizuje dane...
                                </div>
                            </div>
                        )}
                        <div ref={chatEndRef} />
                    </div>

                    {/* Input czatu */}
                    <div className="p-4 bg-white border-t border-slate-100">
                        <div className="relative">
                            <input
                                type="text"
                                value={prompt}
                                onChange={e => setPrompt(e.target.value)}
                                onKeyDown={e => e.key === 'Enter' && handleAskAI()}
                                placeholder={loadingData ? "Pobieram dane floty..." : "np. Zrób wykres kosztów wg aut..."}
                                disabled={loadingData || isThinking}
                                className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-3 pl-4 pr-12 text-sm outline-none focus:border-blue-500 focus:bg-white transition"
                            />
                            <button
                                onClick={handleAskAI}
                                disabled={loadingData || isThinking || !prompt.trim()}
                                className="absolute right-2 top-2 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 text-white p-1.5 rounded-xl transition-colors"
                            >
                                ⬆️
                            </button>
                        </div>
                    </div>
                </div>

                {/* PRAWA STRONA: DYNAMIC CANVAS */}
                <div className="w-full lg:w-2/3 bg-slate-50 border border-slate-200 border-dashed rounded-3xl p-2 relative overflow-hidden flex flex-col">
                    <div className="absolute top-4 left-6 text-xs font-black text-slate-400 uppercase tracking-widest z-10">Strefa Wizualizacji (Canvas)</div>
                    <div className="flex-1 w-full mt-6">
                        {renderCanvas()}
                    </div>
                </div>

            </div>
        </div>
    );
}