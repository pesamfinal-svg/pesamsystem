// src/app/api/ai-warehouse-agent/route.ts
// =============================================================================
// PESAM Autonomous AI Orchestrator v2.0 (High-Speed Function Calling Architecture)
//
// 1. Zero Zrzutu Ciężarówką: Zamiast 500 surowych dokumentów JSON (>40k tokenów),
//    używamy deterministycznych narzędzi agregujących w TypeScript (~200 tokenów).
// 2. Twarde Guardrails: Kolekcje `users` i `roles` są całkowicie odcięte od AI.
// 3. Koniec z regexami: Czysty natywny Structured Output (responseSchema).
// 4. Czas odpowiedzi: ~1.5 - 3s (zamiast 45-60s i timeoutów).
// =============================================================================

import { NextResponse } from 'next/server';
import { GoogleGenAI, Type } from '@google/genai';
import { adminDb, adminAuth } from '@/lib/firebase/admin';
import {
    WAREHOUSE_TOOL_DECLARATIONS,
    dispatchWarehouseTool
} from '@/lib/ai/warehouse-tools';

const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || 'pesam-system-81165',
    location: 'global'
});

export const maxDuration = 60;

// Modele z możliwością konfiguracji przez ENV
const AGENT_MODEL = process.env.GEMINI_AGENT_MODEL || 'gemini-2.5-flash';
const PRESENTER_MODEL = process.env.GEMINI_PRESENTER_MODEL || 'gemini-2.5-flash';

// ─── HELPER: ZAPIS LOGÓW DO FIRESTORE (ai_agent_logs) ────────────────────────
async function saveAgentLog(entry: {
    question: string;
    userId: string;
    logs: string[];
    success: boolean;
    durationMs: number;
    error?: string;
    widgetType?: string;
    toolUsed?: string;
}) {
    try {
        await adminDb.collection('ai_agent_logs').add({
            ...entry,
            timestamp: new Date().toISOString(),
            version: 'v2.0-aggregated'
        });
    } catch {
        // Nie blokujemy odpowiedzi jeśli zapis logu się nie powiedzie
    }
}

// ─── SCHEMAT WIDGETU DLA PREZENTERA UI (Natywny Structured Output) ───────────
const PRESENTER_RESPONSE_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        reply: {
            type: Type.STRING,
            description: 'Zwięzłe, merytoryczne podsumowanie w języku polskim z kluczowymi liczbami i wnioskami. Odpowiedź bezpośrednio do użytkownika.'
        },
        widget: {
            type: Type.OBJECT,
            description: 'Widget do wyrenderowania w interfejsie. Jeśli to zwykła rozmowa lub brak danych liczbowych, ustaw null.',
            properties: {
                type: {
                    type: Type.STRING,
                    description: 'Typ widgetu: "chart" dla wykresów, "table" dla zestawień, "kpi" dla kluczowych wskaźników liczbowych.'
                },
                chartType: {
                    type: Type.STRING,
                    description: '"bar" | "pie" | "line" (wymagane tylko gdy type="chart").'
                },
                title: {
                    type: Type.STRING,
                    description: 'Tytuł widgetu widoczny w nagłówku.'
                },
                datasetLabel: {
                    type: Type.STRING,
                    description: 'Etykieta serii danych (np. "Koszty w PLN", "Ilość sztuk").'
                },
                labels: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                    description: 'Etykiety osi X lub kategorii wykresu (np. nazwy marek lub stref).'
                },
                values: {
                    type: Type.ARRAY,
                    items: { type: Type.NUMBER },
                    description: 'Wartości liczbowe odpowiadające etykietom labels.'
                },
                columns: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                    description: 'Nazwy kolumn tabeli (gdy type="table").'
                },
                rows: {
                    type: Type.ARRAY,
                    items: {
                        type: Type.ARRAY,
                        items: { type: Type.STRING }
                    },
                    description: 'Wiersze tabeli jako tablice stringów (gdy type="table").'
                },
                metrics: {
                    type: Type.ARRAY,
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            label: { type: Type.STRING },
                            value: { type: Type.STRING }
                        },
                        required: ['label', 'value']
                    },
                    description: 'Kafelki KPI z wartościami (1-4 elementy, gdy type="kpi").'
                }
            },
            required: ['type', 'title']
        }
    },
    required: ['reply']
};

// ─── GŁÓWNY HANDLER POST ─────────────────────────────────────────────────────
export async function POST(req: Request) {
    const logs: string[] = [];
    const requestStartTime = Date.now();
    let currentUserId = 'unknown';
    let currentQuestion = 'unknown';

    try {
        // 1. Weryfikacja sesji użytkownika
        const authHeader = req.headers.get('Authorization');
        if (!authHeader?.startsWith('Bearer ')) {
            return NextResponse.json({ error: 'Brak autoryzacji' }, { status: 401 });
        }
        const token = authHeader.slice(7);
        const decoded = await adminAuth.verifyIdToken(token);
        currentUserId = decoded.uid;

        // 2. Weryfikacja uprawnień (users i roles sprawdzane wyłącznie tu!)
        const userDoc = await adminDb.doc(`users/${decoded.uid}`).get();
        if (!userDoc.exists) {
            return NextResponse.json({ error: 'Użytkownik nie istnieje w systemie' }, { status: 403 });
        }
        const userData = userDoc.data()!;
        const overrides: Record<string, boolean> = userData.permissionOverrides || {};
        let rolePerms: Record<string, boolean> = {};

        if (userData.roleId) {
            const roleDoc = await adminDb.doc(`roles/${userData.roleId}`).get();
            if (roleDoc.exists) rolePerms = roleDoc.data()!.permissions || {};
        }

        const hasChatAI = overrides.useChatAI === true || (
            overrides.useChatAI !== false && (
                rolePerms.useChatAI === true ||
                rolePerms.manageRoles === true ||
                userData.roleId === 'admin'
            )
        );

        if (!hasChatAI) {
            return NextResponse.json({ error: 'Brak uprawnienia do Asystenta AI' }, { status: 403 });
        }

        // 3. Pobranie zapytania użytkownika
        const { messages } = await req.json() as { messages: Array<{ role: string; content: string }> };
        if (!messages?.length) {
            return NextResponse.json({ error: 'Brak treści wiadomości' }, { status: 400 });
        }
        const latestQuestion = messages[messages.length - 1].content;
        currentQuestion = latestQuestion;
        logs.push(`👤 USER: "${latestQuestion}"`);

        // 4. KROK 1: AGENT ANALITYCZNY — FUNCTION CALLING (ReAct)
        logs.push(`🧠 [Agent Analityczny] Analiza intencji i dobór narzędzia (${AGENT_MODEL})...`);

        const systemInstruction = `
Jesteś Głównym Analitykiem i Doradcą Systemu Magazynowo-Flotowego PESAM.
Masz dostęp do deterministycznych narzędzi agregujących dane w czasie rzeczywistym.
Jeśli użytkownik zadaje pytanie o:
- naprawy, serwisy, koszty, wydatki na auta, porównanie marek -> wywołaj getRepairsSummary
- stany magazynowe, resztki w strefach, braki materiałowe -> wywołaj getInventorySummary
- flotę, liczbę pojazdów, badania techniczne, rejestracje -> wywołaj getFleetOverview
- budowy i kierowników -> wywołaj getSitesOverview
- spory (CLS), kary i rozliczenia zamknięć -> wywołaj getClaimsAndCloseoutsSummary
Jeśli to zwykłe powitanie (np. "Cześć", "Dzień dobry") lub rozmowa ogólna -> odpowiedz krótko i uprzejmie po polsku bez wywoływania narzędzi.
`;

        const recentHistory = messages.slice(-6).map(m => ({
            role: m.role === 'user' ? 'user' : 'model',
            parts: [{ text: m.content }]
        }));

        const agentResponse = await ai.models.generateContent({
            model: AGENT_MODEL,
            contents: recentHistory,
            config: {
                systemInstruction,
                temperature: 0.0,
                tools: [{ functionDeclarations: WAREHOUSE_TOOL_DECLARATIONS }]
            }
        });

        // Sprawdź czy model wywołał narzędzie
        const candidate = agentResponse.candidates?.[0];
        const functionCalls = candidate?.content?.parts?.filter((p: any) => p.functionCall).map((p: any) => p.functionCall) || [];

        let toolData: any = null;
        let executedToolName = '';

        if (functionCalls.length > 0) {
            const call = functionCalls[0];
            executedToolName = call.name;
            const args = call.args || {};
            logs.push(`🔧 [Narzędzie] Wywołanie: ${call.name}(${JSON.stringify(args)})`);

            try {
                toolData = await dispatchWarehouseTool(call.name, args);
                logs.push(`⚡ [Narzędzie] Wykonano pomyślnie w TypeScript (agregat gotowy).`);
            } catch (toolErr: any) {
                logs.push(`❌ [Narzędzie Błąd] ${toolErr?.message || toolErr}`);
                toolData = { error: toolErr?.message || 'Błąd wykonania narzędzia' };
            }
        }

        // Jeśli brak wywołania narzędzia — model udzielił bezpośredniej odpowiedzi konwersacyjnej
        if (!executedToolName) {
            const directReply = agentResponse.text || 'W czym mogę Ci pomóc w systemie PESAM?';
            logs.push(`💬 [Rozmowa] Bezpośrednia odpowiedź agenta.`);
            const durationMs = Date.now() - requestStartTime;

            saveAgentLog({
                question: latestQuestion,
                userId: currentUserId,
                logs,
                success: true,
                durationMs
            });

            return NextResponse.json({
                reply: directReply,
                widget: null,
                logs
            });
        }

        // 5. KROK 2: PREZENTER UI — STRUCTURED OUTPUT (Natywny responseSchema)
        logs.push(`🎨 [Prezenter UI] Formatowanie danych do widgetu (${PRESENTER_MODEL})...`);

        const presenterPrompt = `
Pytanie użytkownika: "${latestQuestion}"
Użyte narzędzie: ${executedToolName}
Dane zagregowane z bazy PESAM (JSON):
${JSON.stringify(toolData)}

ZADANIE:
1. Przygotuj zwięzłą, konkretną odpowiedź w języku polskim z podsumowaniem kluczowych liczb (w polu 'reply').
2. Jeśli dane nadają się do wizualizacji, stwórz widget w obiekcie 'widget':
   - 'chart' (bar/pie/line): jeśli mamy podział na kategorie, strefy, marki lub miesiące.
   - 'table': jeśli to lista pozycji (np. lista aut, budów).
   - 'kpi': jeśli to 1-4 kluczowe liczby podsumowujące (np. łączny koszt, ilość napraw, średnia).
3. Etykiety i tytuły muszą być po polsku. Kwoty w PLN.
`;

        const presenterRes = await ai.models.generateContent({
            model: PRESENTER_MODEL,
            contents: [{ role: 'user', parts: [{ text: presenterPrompt }] }],
            config: {
                systemInstruction: 'Jesteś Dyrektorem Raportowania PESAM. Prezentujesz dane biznesowe w czytelnej formie. Generujesz wyłącznie poprawny format JSON.',
                temperature: 0.0,
                responseMimeType: 'application/json',
                responseSchema: PRESENTER_RESPONSE_SCHEMA
            }
        });

        let presenterData: any = {};
        try {
            const rawJson = presenterRes.text?.trim() || '{}';
            presenterData = JSON.parse(rawJson);
        } catch (jsonErr) {
            logs.push(`⚠️ [Prezenter] Błąd parsowania odpowiedzi JSON: ${jsonErr}`);
            presenterData = {
                reply: presenterRes.text || 'Analiza danych zakończona pomyślnie.',
                widget: null
            };
        }

        const durationMs = Date.now() - requestStartTime;
        logs.push(`⏱️ [Koniec] Całkowity czas wykonania: ${durationMs}ms`);

        if (presenterData.widget) {
            logs.push(`📊 [Widget UI] Wygenerowano widget typu: ${presenterData.widget.type} ("${presenterData.widget.title}")`);
        }

        // Zapis do bazy audytowej
        saveAgentLog({
            question: latestQuestion,
            userId: currentUserId,
            logs,
            success: true,
            durationMs,
            widgetType: presenterData.widget?.type,
            toolUsed: executedToolName
        });

        // 6. Zwrócenie odpowiedzi do WarehouseChatWidget
        return NextResponse.json({
            reply: presenterData.reply || 'Oto zestawienie danych z systemu PESAM.',
            widget: presenterData.widget || null,
            toolUsed: {
                id: executedToolName,
                name: executedToolName
            },
            pythonExecuted: false,
            dataUsed: [executedToolName],
            logs
        });

    } catch (err: any) {
        console.error('[PESAM AI Warehouse Agent v2.0 Error]:', err);
        const durationMs = Date.now() - requestStartTime;
        logs.push(`❌ [Błąd krytyczny] ${err?.message || err}`);

        saveAgentLog({
            question: currentQuestion,
            userId: currentUserId,
            logs,
            success: false,
            durationMs,
            error: err?.message || String(err)
        });

        return NextResponse.json({
            error: 'Wystąpił błąd podczas przetwarzania zapytania AI.',
            detail: err?.message || 'Nieznany błąd',
            logs
        }, { status: 500 });
    }
}
