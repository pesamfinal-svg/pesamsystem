// src/components/ai/WarehouseChatWidget.tsx
// =============================================================================
// PESAM — Inteligentny Czat Asystenta Magazynowego (Multi-Agent UI)
// Obsługuje: Wykresy (Bar, Pie, Line), Tabele danych, Kafelki KPI, Odpowiedzi AI
// =============================================================================
'use client';

import React, { useState, useRef, useEffect, KeyboardEvent } from 'react';
import { useAuth } from '@/lib/auth/AuthContext';
import { getAuth } from 'firebase/auth';

import {
    Chart as ChartJS,
    CategoryScale,
    LinearScale,
    BarElement,
    Title,
    Tooltip,
    Legend,
    ArcElement,
    PointElement,
    LineElement,
} from 'chart.js';
import { Bar, Pie, Line } from 'react-chartjs-2';

ChartJS.register(
    CategoryScale,
    LinearScale,
    BarElement,
    Title,
    Tooltip,
    Legend,
    ArcElement,
    PointElement,
    LineElement
);

const PALETTE = [
    '#3b82f6', '#10b981', '#f59e0b', '#ef4444',
    '#8b5cf6', '#ec4899', '#14b8a6', '#f97316',
    '#06b6d4', '#6366f1'
];

export interface ChatWidgetData {
    type: 'chart' | 'table' | 'kpi';
    chartType?: 'bar' | 'pie' | 'line';
    title: string;
    datasetLabel?: string;
    labels?: string[];
    values?: number[];
    columns?: string[];
    rows?: (string | number)[][];
    metrics?: { label: string; value: string }[];
}

interface ChatMessage {
    role: 'user' | 'assistant';
    content: string;
    widget?: ChatWidgetData | null;
    toolUsed?: {
        id: string;
        name: string;
        isNew?: boolean;
    } | null;
    pythonExecuted?: boolean;
    dataUsed?: string[];
}

interface Props {
    isOpen: boolean;
    onClose: () => void;
}

function formatText(text: string): string {
    return text
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/\n/g, '<br/>');
}

// ─── RENDEROWANIE WIDGETÓW (WYKRESY, TABELE, KPI) ───────────────────────────
function MessageWidget({ widget }: { widget: ChatWidgetData }) {
    if (widget.type === 'chart' && widget.labels && widget.values) {
        const chartData = {
            labels: widget.labels,
            datasets: [
                {
                    label: widget.datasetLabel || 'Wartość',
                    data: widget.values,
                    backgroundColor: widget.chartType === 'pie'
                        ? PALETTE.slice(0, widget.labels.length)
                        : 'rgba(99, 102, 241, 0.85)',
                    borderColor: widget.chartType === 'pie'
                        ? '#ffffff'
                        : '#4f46e5',
                    borderWidth: 1.5,
                    borderRadius: widget.chartType === 'bar' ? 6 : 0,
                }
            ]
        };

        const chartOptions = {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: widget.chartType === 'pie',
                    position: 'bottom' as const,
                    labels: { boxWidth: 12, font: { size: 10 } }
                },
                tooltip: {
                    backgroundColor: '#1e293b',
                    padding: 8,
                    cornerRadius: 6
                }
            },
            scales: widget.chartType !== 'pie' ? {
                x: {
                    grid: { display: false },
                    ticks: { font: { size: 10 }, maxRotation: 45, minRotation: 0 }
                },
                y: {
                    beginAtZero: true,
                    ticks: { font: { size: 10 } },
                    grid: { color: '#f1f5f9' }
                }
            } : undefined
        };

        return (
            <div className="mt-3 bg-white border border-slate-200 rounded-xl p-3 shadow-sm">
                <div className="flex items-center justify-between mb-2 pb-1 border-b border-slate-100">
                    <span className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
                        <span>📊</span>
                        <span>{widget.title}</span>
                    </span>
                    <span className="text-[10px] uppercase font-bold text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded">
                        {widget.chartType}
                    </span>
                </div>
                <div className="w-full h-56">
                    {widget.chartType === 'bar' && <Bar data={chartData} options={chartOptions} />}
                    {widget.chartType === 'pie' && <Pie data={chartData} options={chartOptions} />}
                    {widget.chartType === 'line' && <Line data={chartData} options={chartOptions} />}
                </div>
            </div>
        );
    }

    if (widget.type === 'table' && widget.columns && widget.rows) {
        return (
            <div className="mt-3 bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
                <div className="px-3 py-2 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
                    <span className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
                        <span>📋</span>
                        <span>{widget.title}</span>
                    </span>
                    <span className="text-[10px] text-slate-500 font-medium">
                        {widget.rows.length} wierszy
                    </span>
                </div>
                <div className="overflow-x-auto max-h-60 overflow-y-auto">
                    <table className="w-full text-left text-xs">
                        <thead className="bg-slate-100/70 sticky top-0 border-b border-slate-200">
                            <tr>
                                {widget.columns.map((col, idx) => (
                                    <th key={idx} className="px-2.5 py-1.5 font-bold text-slate-700 whitespace-nowrap">
                                        {col}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                            {widget.rows.map((row, rIdx) => (
                                <tr key={rIdx} className={rIdx % 2 === 0 ? 'bg-white hover:bg-slate-50' : 'bg-slate-50/50 hover:bg-slate-50'}>
                                    {row.map((cell, cIdx) => (
                                        <td key={cIdx} className="px-2.5 py-1 text-slate-700 whitespace-nowrap">
                                            {String(cell)}
                                        </td>
                                    ))}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>
        );
    }

    if (widget.type === 'kpi' && widget.metrics) {
        return (
            <div className="mt-3 grid grid-cols-2 gap-2">
                {widget.metrics.map((m, idx) => (
                    <div key={idx} className="bg-white border border-slate-200 rounded-xl p-3 shadow-sm">
                        <div className="text-[11px] text-slate-500 font-medium truncate">{m.label}</div>
                        <div className="text-base font-black text-slate-900 mt-0.5">{m.value}</div>
                    </div>
                ))}
            </div>
        );
    }

    return null;
}

const STARTER_CHIPS = [
    { label: '📊 Słupki: Co mamy za dużo?', question: 'Pokaż na wykresie słupkowym podsumowanie ilości resztek w magazynie wg kategorii — co mamy w nadmiarze?' },
    { label: '⚠️ Resztki bez ruchu >30 dni', question: 'Wyszukaj pozycje resztek, które nie miały żadnego ruchu od ponad 30 dni. Przygotuj tabelę z ilościami i strefami.' },
    { label: '🚗 Koszty napraw floty', question: 'Przedstaw zestawienie kosztów napraw samochodów w tym roku na wykresie kołowym lub słupkowym z podziałem na pojazdy.' },
    { label: '🧪 Chemia, pianki i kleje', question: 'Ile mamy obecnie na magazynie pianek montażowych, silikonów i klejów? Pokaż porównanie na wykresie.' },
];

export function WarehouseChatWidget({ isOpen, onClose }: Props) {
    const { user } = useAuth();
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [input, setInput] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const messagesEndRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (isOpen) {
            setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
        }
    }, [messages, isOpen]);

    const sendMessage = async (content: string) => {
        if (!content.trim() || isLoading) return;

        const userMessage: ChatMessage = { role: 'user', content: content.trim() };
        const newHistory = [...messages, userMessage];
        setMessages(newHistory);
        setInput('');
        setIsLoading(true);

        try {
            const firebaseAuth = getAuth();
            const token = await firebaseAuth.currentUser?.getIdToken();
            if (!token) throw new Error('Brak tokenu sesji użytkownika');

            const res = await fetch('/api/ai-warehouse-agent', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({
                    messages: newHistory.map(m => ({ role: m.role, content: m.content })),
                    userId: user?.uid
                })
            });

            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error || err.detail || 'Błąd serwera');
            }

            const data = await res.json();
            setMessages(prev => [
                ...prev,
                {
                    role: 'assistant',
                    content: data.reply,
                    widget: data.widget,
                    toolUsed: data.toolUsed,
                    pythonExecuted: data.pythonExecuted,
                    dataUsed: data.dataUsed
                }
            ]);
        } catch (err: any) {
            setMessages(prev => [
                ...prev,
                {
                    role: 'assistant',
                    content: `❌ Wystąpił błąd: ${err?.message || 'Nieznany błąd zapytania.'}`
                }
            ]);
        } finally {
            setIsLoading(false);
        }
    };

    const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage(input);
        }
    };

    return (
        <>
            {isOpen && (
                <div
                    className="fixed inset-0 bg-black/30 z-40 transition-opacity backdrop-blur-xs"
                    onClick={onClose}
                />
            )}

            <div className={`fixed top-0 right-0 h-screen w-full sm:w-[520px] bg-slate-50 shadow-2xl z-50 flex flex-col transition-transform duration-300 ease-in-out border-l border-slate-200 ${isOpen ? 'translate-x-0' : 'translate-x-full'}`}>

                {/* Nagłówek panelu */}
                <div className="bg-slate-900 text-white px-5 py-3.5 flex items-center justify-between flex-shrink-0 shadow-md">
                    <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-violet-600 to-indigo-500 flex items-center justify-center text-lg shadow-inner">
                            🤖
                        </div>
                        <div>
                            <div className="font-bold text-sm tracking-wide flex items-center gap-2">
                                Asystent Magazynowy PESAM
                                <span className="bg-emerald-500/20 text-emerald-400 text-[10px] px-1.5 py-0.5 rounded font-mono font-bold">
                                    v6.0 AI
                                </span>
                            </div>
                            <div className="text-[11px] text-slate-400 flex items-center gap-1.5 mt-0.5">
                                <span>Multi-Agent Orchestrator</span>
                                <span>•</span>
                                <span className="text-indigo-300">Python Sandbox</span>
                            </div>
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        className="text-slate-400 hover:text-white transition w-8 h-8 rounded-lg hover:bg-slate-800 flex items-center justify-center text-lg"
                        title="Zamknij asystenta"
                    >
                        ✕
                    </button>
                </div>

                {/* Lista wiadomości */}
                <div className="flex-1 overflow-y-auto p-4 space-y-4">
                    {messages.length === 0 && (
                        <div className="space-y-4 pt-4">
                            <div className="text-center bg-white border border-slate-200 rounded-2xl p-5 shadow-xs">
                                <div className="text-3xl mb-2">📊</div>
                                <h3 className="font-bold text-slate-800 text-sm">Witaj w inteligentnym czacie PESAM</h3>
                                <p className="text-xs text-slate-500 mt-1 max-w-sm mx-auto">
                                    Zadawaj pytania w języku naturalnym. Zespół agentów przeszuka bazę Firestore, uruchomi obliczenia w Pythonie i wygeneruje wykresy w czasie rzeczywistym.
                                </p>
                            </div>

                            <div>
                                <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-2 px-1">
                                    Przykładowe zapytania analityczne:
                                </div>
                                <div className="grid grid-cols-1 gap-2">
                                    {STARTER_CHIPS.map((chip) => (
                                        <button
                                            key={chip.label}
                                            onClick={() => sendMessage(chip.question)}
                                            className="text-left px-3.5 py-2.5 bg-white border border-slate-200 rounded-xl text-xs text-slate-700 hover:bg-violet-50 hover:border-violet-300 transition shadow-xs flex items-center justify-between group"
                                        >
                                            <span className="font-semibold text-slate-800 group-hover:text-violet-700">{chip.label}</span>
                                            <span className="text-slate-300 group-hover:text-violet-500 text-sm">→</span>
                                        </button>
                                    ))}
                                </div>
                            </div>
                        </div>
                    )}

                    {messages.map((msg, idx) => (
                        <div
                            key={idx}
                            className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                        >
                            <div className={`max-w-[92%] rounded-2xl px-4 py-3 text-sm shadow-xs ${msg.role === 'user'
                                ? 'bg-indigo-600 text-white rounded-br-xs'
                                : 'bg-white text-slate-800 border border-slate-200 rounded-bl-xs'
                                }`}>

                                {/* Treść tekstowa */}
                                <div
                                    className="leading-relaxed"
                                    dangerouslySetInnerHTML={{ __html: formatText(msg.content) }}
                                />

                                {/* Widget graficzny jeśli dostępny */}
                                {msg.widget && <MessageWidget widget={msg.widget} />}

                                {/* Odznaka weryfikacji i źródła danych */}
                                {msg.role === 'assistant' && (msg.toolUsed || msg.pythonExecuted || msg.dataUsed?.length) && (
                                    <div className="mt-2.5 pt-2 border-t border-slate-100 flex flex-wrap items-center gap-2 text-[10px] text-slate-400">
                                        {msg.toolUsed && (
                                            <span className={`inline-flex items-center gap-1 font-semibold px-2 py-0.5 rounded border ${
                                                msg.toolUsed.isNew
                                                    ? 'text-amber-700 bg-amber-50 border-amber-200'
                                                    : 'text-indigo-700 bg-indigo-50 border-indigo-200'
                                            }`}>
                                                <span>{msg.toolUsed.isNew ? '🎓 Nowy tool:' : '⚡ Gotowy tool:'}</span>
                                                <span className="font-bold">{msg.toolUsed.name}</span>
                                            </span>
                                        )}
                                        {msg.pythonExecuted && (
                                            <span className="inline-flex items-center gap-1 font-semibold text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded">
                                                <span>🐍</span>
                                                <span>Python Sandbox</span>
                                            </span>
                                        )}
                                        {msg.dataUsed && msg.dataUsed.length > 0 && (
                                            <span className="text-slate-400">
                                                Źródło: {msg.dataUsed.join(', ')}
                                            </span>
                                        )}
                                    </div>
                                )}
                            </div>
                        </div>
                    ))}

                    {/* Animacja analizy danych */}
                    {isLoading && (
                        <div className="flex justify-start">
                            <div className="bg-white border border-slate-200 rounded-2xl rounded-bl-xs px-4 py-3 shadow-xs">
                                <div className="flex items-center gap-2">
                                    <div className="w-2 h-2 bg-indigo-600 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                                    <div className="w-2 h-2 bg-indigo-600 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                                    <div className="w-2 h-2 bg-indigo-600 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                                    <span className="text-xs text-slate-500 font-medium ml-1">
                                        Orchestrator: Pobieranie danych & Obliczenia Python...
                                    </span>
                                </div>
                            </div>
                        </div>
                    )}

                    <div ref={messagesEndRef} />
                </div>

                {/* Pole wprowadzania zapytania */}
                <div className="p-3.5 bg-white border-t border-slate-200 flex-shrink-0">
                    <div className="flex gap-2 items-end">
                        <textarea
                            value={input}
                            onChange={e => setInput(e.target.value)}
                            onKeyDown={handleKeyDown}
                            placeholder="Zadaj pytanie (np. Pokaż wykres słupkowy resztek w strefach...)"
                            rows={2}
                            disabled={isLoading}
                            className="flex-1 resize-none px-3.5 py-2.5 border border-slate-300 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none disabled:bg-slate-50 disabled:text-slate-400"
                        />
                        <button
                            onClick={() => sendMessage(input)}
                            disabled={isLoading || !input.trim()}
                            className="px-4 py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-200 disabled:text-slate-400 text-white rounded-xl font-bold text-sm transition flex-shrink-0 self-end mb-0.5 shadow-sm"
                        >
                            {isLoading ? '⏳' : 'Wyślij'}
                        </button>
                    </div>
                    <div className="flex items-center justify-between text-[10px] text-slate-400 mt-1.5 px-1">
                        <span>Enter = wyślij, Shift+Enter = nowa linia</span>
                        <span>PESAM Live Intelligence</span>
                    </div>
                </div>
            </div>
        </>
    );
}
