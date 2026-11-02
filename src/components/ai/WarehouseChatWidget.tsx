// src/components/ai/WarehouseChatWidget.tsx
// PESAM — Asystent Magazynowy (Chat Widget)
'use client';

import { useState, useRef, useEffect, KeyboardEvent } from 'react';
import { useAuth } from '@/lib/auth/AuthContext';
import { getAuth } from 'firebase/auth';

interface ChatMessage {
    role: 'user' | 'assistant';
    content: string;
}

interface Props {
    isOpen: boolean;
    onClose: () => void;
}

// Proste renderowanie markdown: **bold**, nowe linie, tabele
function renderContent(text: string) {
    // Sprawdź czy jest tabela (linie zaczynające się od |)
    const lines = text.split('\n');
    const hasTable = lines.some(l => l.trim().startsWith('|'));

    if (hasTable) {
        // Znajdź blok tabelaryczny
        const tableLines = lines.filter(l => l.trim().startsWith('|') || l.trim().startsWith('|-'));
        const nonTableLines = lines.filter(l => !l.trim().startsWith('|') && !l.trim().startsWith('|-'));

        const headers = tableLines[0]?.split('|').map(h => h.trim()).filter(Boolean) || [];
        const rows = tableLines.slice(2).map(l => l.split('|').map(c => c.trim()).filter(Boolean));

        return (
            <div className="space-y-2">
                {nonTableLines.join('\n').trim() && (
                    <div dangerouslySetInnerHTML={{ __html: formatText(nonTableLines.join('\n')) }} />
                )}
                {headers.length > 0 && (
                    <div className="overflow-x-auto rounded border border-slate-200">
                        <table className="min-w-full text-xs">
                            <thead className="bg-slate-100">
                                <tr>
                                    {headers.map((h, i) => (
                                        <th key={i} className="px-2 py-1.5 text-left font-semibold text-slate-700 whitespace-nowrap">{h}</th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map((row, ri) => (
                                    <tr key={ri} className={ri % 2 === 0 ? 'bg-white' : 'bg-slate-50'}>
                                        {row.map((cell, ci) => (
                                            <td key={ci} className="px-2 py-1 text-slate-700 whitespace-nowrap">{cell}</td>
                                        ))}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        );
    }

    return <div className="leading-relaxed" dangerouslySetInnerHTML={{ __html: formatText(text) }} />;
}

function formatText(text: string): string {
    return text
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/\n/g, '<br/>');
}

const STARTER_CHIPS = [
    { label: '📦 Co mamy za dużo?', question: 'Podsumuj stan magazynu resztek — które kategorie mamy w największej ilości?' },
    { label: '⚠️ Resztki bez ruchu >30 dni', question: 'Pokaż resztki które nie były aktualizowane od ponad 30 dni (zalegają w magazynie).' },
    { label: '🔍 Pianki i silikony', question: 'Ile mamy pianek montażowych i silikonów? Pokaż szczegóły.' },
    { label: '🚗 Koszty napraw floty', question: 'Jakie były łączne koszty napraw pojazdów w tym roku? Pokaż podział na pojazdy.' },
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
            // Pobierz token Firebase
            const firebaseAuth = getAuth();
            const token = await firebaseAuth.currentUser?.getIdToken();
            if (!token) throw new Error('Brak tokenu uwierzytelniającego');

            const res = await fetch('/api/ai-warehouse-agent', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({ messages: newHistory, userId: user?.uid })
            });

            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error || 'Błąd serwera');
            }

            const data = await res.json();
            setMessages(prev => [...prev, { role: 'assistant', content: data.reply }]);
        } catch (err) {
            setMessages(prev => [...prev, {
                role: 'assistant',
                content: `❌ Błąd: ${err instanceof Error ? err.message : 'Wystąpił nieznany błąd. Spróbuj ponownie.'}`
            }]);
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
            {/* Overlay */}
            {isOpen && (
                <div
                    className="fixed inset-0 bg-black/20 z-40 transition-opacity"
                    onClick={onClose}
                />
            )}

            {/* Panel */}
            <div className={`fixed top-0 right-0 h-screen w-[420px] max-w-full bg-white shadow-2xl z-50 flex flex-col transition-transform duration-300 ease-in-out ${isOpen ? 'translate-x-0' : 'translate-x-full'}`}>

                {/* Nagłówek */}
                <div className="bg-slate-900 text-white px-4 py-3 flex items-center justify-between flex-shrink-0">
                    <div className="flex items-center gap-2">
                        <span className="text-xl">🤖</span>
                        <div>
                            <div className="font-bold text-sm">Asystent Magazynowy PESAM</div>
                            <div className="text-xs text-slate-400">Powered by Gemini AI</div>
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        className="text-slate-400 hover:text-white transition text-xl leading-none p-1"
                    >
                        ✕
                    </button>
                </div>

                {/* Lista wiadomości */}
                <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-slate-50">

                    {/* Starter chips — widoczne gdy brak historii */}
                    {messages.length === 0 && (
                        <div className="space-y-3">
                            <div className="text-center">
                                <div className="text-3xl mb-2">🤖</div>
                                <p className="text-sm text-slate-600 font-medium">Cześć! Jestem Twoim asystentem magazynowym.</p>
                                <p className="text-xs text-slate-400 mt-1">Pytaj o resztki, flotę, zamówienia, budowy...</p>
                            </div>
                            <div className="grid grid-cols-2 gap-2 mt-4">
                                {STARTER_CHIPS.map((chip) => (
                                    <button
                                        key={chip.label}
                                        onClick={() => sendMessage(chip.question)}
                                        className="text-left px-3 py-2 bg-white border border-slate-200 rounded-lg text-xs text-slate-700 hover:bg-violet-50 hover:border-violet-300 transition shadow-sm"
                                    >
                                        {chip.label}
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Wiadomości */}
                    {messages.map((msg, idx) => (
                        <div
                            key={idx}
                            className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                        >
                            <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm shadow-sm ${msg.role === 'user'
                                    ? 'bg-violet-600 text-white rounded-br-sm'
                                    : 'bg-white text-slate-800 border border-slate-200 rounded-bl-sm'
                                }`}>
                                {msg.role === 'assistant'
                                    ? renderContent(msg.content)
                                    : <span>{msg.content}</span>
                                }
                            </div>
                        </div>
                    ))}

                    {/* Wskaźnik ładowania */}
                    {isLoading && (
                        <div className="flex justify-start">
                            <div className="bg-white border border-slate-200 rounded-2xl rounded-bl-sm px-4 py-3 shadow-sm">
                                <div className="flex items-center gap-1.5">
                                    <div className="w-1.5 h-1.5 bg-violet-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                                    <div className="w-1.5 h-1.5 bg-violet-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                                    <div className="w-1.5 h-1.5 bg-violet-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                                    <span className="text-xs text-slate-400 ml-1">Analizuję dane...</span>
                                </div>
                            </div>
                        </div>
                    )}

                    <div ref={messagesEndRef} />
                </div>

                {/* Input */}
                <div className="p-3 bg-white border-t border-slate-200 flex-shrink-0">
                    <div className="flex gap-2 items-end">
                        <textarea
                            value={input}
                            onChange={e => setInput(e.target.value)}
                            onKeyDown={handleKeyDown}
                            placeholder="Napisz pytanie... (Enter = wyślij, Shift+Enter = nowa linia)"
                            rows={2}
                            disabled={isLoading}
                            className="flex-1 resize-none px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-violet-500 focus:border-transparent outline-none disabled:bg-slate-50 disabled:text-slate-400"
                        />
                        <button
                            onClick={() => sendMessage(input)}
                            disabled={isLoading || !input.trim()}
                            className="px-4 py-2 bg-violet-600 hover:bg-violet-700 disabled:bg-slate-300 text-white rounded-lg font-bold text-sm transition flex-shrink-0 self-end mb-0"
                        >
                            {isLoading ? '⏳' : '→'}
                        </button>
                    </div>
                    <p className="text-[10px] text-slate-400 mt-1 text-center">PESAM AI — dane z Twojego systemu w czasie rzeczywistym</p>
                </div>
            </div>
        </>
    );
}
