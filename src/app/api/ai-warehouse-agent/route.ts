// src/app/api/ai-warehouse-agent/route.ts
// =============================================================================
// PESAM Autonomous Data-Driven Multi-Agent Orchestrator v8.0
//
// Architektura Wieloagentowa Sterowana Słownikiem Bazy Danych (Data Dictionary):
//
// 1. Mózg / Orchestrator (gemini-2.5-pro z Google Vertex AI):
//    - Zna nazwy tabel i kolumn w DB_SCHEMA.
//    - Nie używa sztywnych filtrów ani maskowań typu "wszystkie".
//    - Jeśli pytanie jest ogólne (np. "jakimi autami dysponujemy"), generuje
//      czyste zapytanie o całą kolekcję bez warunków 'where'.
//    - Jeśli pytanie jest szczegółowe, precyzyjnie wskazuje kolumnę i operator.
// 2. Inżynier Danych (Data Engine):
//    - Wykonuje deklaratywne zapytania Firestore (collection, where, limit)
//    - Równoległe pobieranie przez Promise.all, automatyczna konwersja Timestamp
// 3. Rejestr ai_tools w Firestore:
//    - Zapisuje wytworzone narzędzia, aby nie tworzyć ich ponownie
// 4. Matematyk & Data Scientist (gemini-2.5-flash + Python Sandbox):
//    - 100% precyzji obliczeniowej w bezpiecznej piaskownicy Vertex AI
// 5. Prezenter UI (gemini-2.5-flash-lite):
//    - Formatuje wynik: wykres (bar, pie, line), tabela lub KPI
// =============================================================================

import { NextResponse } from 'next/server';
import { GoogleGenAI, Type } from '@google/genai';
import { adminDb, adminAuth } from '@/lib/firebase/admin';
import { Timestamp, FieldValue } from 'firebase-admin/firestore';

const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || 'pesam-system-81165',
    location: 'global'
});

export const maxDuration = 60;

// Modele Gemini dostępne w Google Cloud na endpointzie Global
const ORCHESTRATOR_MODEL = 'gemini-2.5-pro';
const ORCHESTRATOR_FALLBACK = 'gemini-2.5-flash';
const MATH_MODEL = 'gemini-2.5-flash';
const PRESENTER_MODEL = 'gemini-2.5-flash-lite';

// ─── SŁOWNIK BAZY DANYCH (Wstrzykiwany Mózgowi Orchestratora) ────────────────
const DB_SCHEMA = `
PESAM — SŁOWNIK BAZY DANYCH (DATA DICTIONARY):

1. KOLEKCJA "vehicles" (Flota samochodów firmy):
   - id: string (identyfikator unikalny)
   - brand: string (np. "Iveco", "Ford", "Renault", "Mercedes")
   - model: string (np. "Daily", "Transit", "Master", "Sprinter")
   - registration: string (np. "RDE HF31", "RDE 4522A")
   - year: number (rok produkcji)
   - initialMileage: number (przebieg początkowy w km)
   - currentTires: string ("Letnie" | "Zimowe")
   - inspectionDate: string (data badania technicznego YYYY-MM-DD)

2. KOLEKCJA "repairs" (Historia napraw i serwisu samochodów):
   - id: string (identyfikator unikalny)
   - vehicleId: string (FK -> wskazuje na vehicles.id)
   - date: string (format YYYY-MM-DD, np. "2024-03-15")
   - cost: number (kwota netto naprawy w PLN)
   - category: string ("Mechaniczna"|"Silnik"|"Układ hamulcowy"|"Zawieszenie"|
               "Elektryczna"|"Klimatyzacja"|"Opony"|"Eksploatacyjna"|"Blacharsko-Lakiernicza"|"Przeglądy"|"Inne")
   - mileage: number (przebieg w momencie naprawy)
   - comments: string (opis naprawy / wykonanych prac)
   - location: string (warsztat wykonujący)
   - partsList: string[] (tablica wymienionych części)

3. KOLEKCJA "residuals" (Resztki budowlane i materiały na placu/magazynie):
   - id: string
   - name: string (nazwa materiału, np. "Klej Atlas Plus 25kg", "Bloczek 590x120x239")
   - quantity: number (ilość)
   - unit: string (np. "szt.", "op.", "paleta", "m2", "mb")
   - category: string ("kleje"|"pustaki"|"plyty-gk"|"farby-chemia"|"pianki-silikony"|
               "kable-elektryka"|"gipsy-gladzie"|"izolacje-folie"|"szalunki"|"stal-ogrodzenia"|
               "rury-kanalizacja"|"drewno-odpady")
   - subcategory: string
   - storageZone: string (strefa: "Plac Zewnętrzny"|"Magazyn Farb i Chemii"|"Hala rozsuwana"|"Regał na stal"|"Wiata otwarta"|"Spawalnia")
   - updatedAt: Timestamp (data ostatniego ruchu / modyfikacji)
   - siteId: string (budowa źródłowa)

4. KOLEKCJA "inventory" (Sprzęt budowlany, narzędzia i maszyny):
   - id: string
   - name: string (np. "Zagęszczarka Wacker Neuson", "Wkrętarka Makita")
   - category: string
   - quantity: number
   - unit: string
   - location: string

5. KOLEKCJA "orders" (Zamówienia z budów):
   - id: string
   - status: string ("pending"|"completed"|"cancelled")
   - createdAt: Timestamp
   - items: array
   - siteId: string

6. KOLEKCJA "sites" (Budowy / Obiekty):
   - id: string
   - name: string
   - address: string
   - status: string ("active"|"closed")
`;

// ─── RETRY Z EXPONENTIAL BACKOFF ─────────────────────────────────────────────
async function runWithRetry(params: any, retries = 3, delay = 1000): Promise<any> {
    try {
        return await ai.models.generateContent(params);
    } catch (error: any) {
        const isRateLimit =
            error?.message?.includes('429') ||
            error?.message?.includes('RESOURCE_EXHAUSTED') ||
            error?.status === 429;

        if (isRateLimit && retries > 0) {
            await new Promise(res => setTimeout(res, delay));
            return runWithRetry(params, retries - 1, delay * 2);
        }
        throw error;
    }
}

// ─── SCHEMAT DEKLARATYWNEGO PLANU ZAPYTAŃ DLA ORCHESTRATORA ──────────────────
const QUERY_STEP_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        collection: {
            type: Type.STRING,
            enum: ['vehicles', 'repairs', 'residuals', 'inventory', 'orders', 'sites'],
            description: 'Nazwa kolekcji z DB_SCHEMA, którą należy pobrać z bazy'
        },
        where: {
            type: Type.ARRAY,
            description: 'Opcjonalne filtry. UŻYWAJ TYLKO jeśli użytkownik w pytaniu podał konkretne ograniczenie (np. konkretną markę "Iveco", konkretną kategorię czy datę). Jeśli pyta ogólnie o wszystkie samochody, naprawy lub resztki — zostaw tę tablicę PUSTĄ.',
            items: {
                type: Type.OBJECT,
                properties: {
                    field: { type: Type.STRING, description: 'Dokładna nazwa kolumny z DB_SCHEMA, np. "brand", "category", "storageZone", "date"' },
                    op: { type: Type.STRING, enum: ['==', '>=', '<=', '>', '<'] },
                    value: { type: Type.STRING, description: 'Konkretna wartość filtra (np. "Iveco", "2024-01-01")' }
                },
                required: ['field', 'op', 'value']
            }
        },
        limit: {
            type: Type.NUMBER,
            description: 'Maksymalna liczba rekordów (domyślnie 250, max 500)'
        }
    },
    required: ['collection']
};

const ORCHESTRATOR_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        isAnalysis: {
            type: Type.BOOLEAN,
            description: 'true = zapytanie o dane z bazy (flota, naprawy, magazyn, resztki, budowy, koszty); false = zwykłe powitanie, rozmowa ogólna, kim jesteś'
        },
        conversationalReply: {
            type: Type.STRING,
            description: 'Odpowiedź gdy isAnalysis=false (po polsku)'
        },
        toolAction: {
            type: Type.STRING,
            description: '"USE_EXISTING" jeśli zapytanie pasuje do jednego z zarejestrowanych narzędzi z EXISTING_TOOLS; "CREATE_NEW" jeśli takiego narzędzia jeszcze nie ma w rejestrze.',
            enum: ['USE_EXISTING', 'CREATE_NEW']
        },
        matchedToolId: {
            type: Type.STRING,
            description: 'ID narzędzia z EXISTING_TOOLS jeśli toolAction == "USE_EXISTING"'
        },
        newToolDefinition: {
            type: Type.OBJECT,
            description: 'Definicja nowego narzędzia jeśli toolAction == "CREATE_NEW"',
            properties: {
                id: { type: Type.STRING, description: 'Unikalny slug w snake_case, np. "fleet_cost_per_vehicle", "residual_stock_by_zone"' },
                name: { type: Type.STRING, description: 'Zwięzła polska nazwa narzędzia' },
                description: { type: Type.STRING, description: 'Opis co narzędzie liczy i kiedy go używać' },
                analyticalGoal: { type: Type.STRING, description: 'Dokładny cel wyliczeń dla Agenta Pythona' },
                preferredWidget: { type: Type.STRING, enum: ['chart', 'table', 'kpi'] },
                chartType: { type: Type.STRING, enum: ['bar', 'pie', 'line'] }
            },
            required: ['id', 'name', 'analyticalGoal']
        },
        queries: {
            type: Type.ARRAY,
            description: 'Lista zapytań do wykonania przez Inżyniera Danych w Firestore. Określ które kolekcje pobrać i czy mają mieć filtry.',
            items: QUERY_STEP_SCHEMA
        },
        analyticalGoal: {
            type: Type.STRING,
            description: 'Dokładny cel matematyczny dla Agenta Pythona (co ma policzyć, pogrupować, zsumować lub porównać ze zwróconych danych)'
        }
    },
    required: ['isAnalysis']
};

// ─── NARZĘDZIA PREZENTERA UI ─────────────────────────────────────────────────
const TOOL_RENDER_CHART = {
    name: 'renderChartWidget',
    description: 'Wykres słupkowy (bar), kołowy (pie) lub liniowy (line). Użyj dla porównań kategorii, kosztów lub trendów czasowych.',
    parameters: {
        type: Type.OBJECT,
        properties: {
            aiMessage: { type: Type.STRING, description: 'Czyste zdanie podsumowujące po polsku do dymku czatu. BEZ KODU PYTHON!' },
            chartType: { type: Type.STRING, description: '"bar" | "pie" | "line"' },
            title: { type: Type.STRING, description: 'Tytuł wykresu' },
            datasetLabel: { type: Type.STRING, description: 'Etykieta serii danych, np. "Koszt (PLN)" lub "Ilość"' },
            labels: { type: Type.ARRAY, items: { type: Type.STRING } },
            values: { type: Type.ARRAY, items: { type: Type.NUMBER } }
        },
        required: ['aiMessage', 'chartType', 'title', 'labels', 'values']
    }
};

const TOOL_RENDER_TABLE = {
    name: 'renderTableWidget',
    description: 'Tabela danych. Użyj dla list pozycji, szczegółowych rankingów lub zestawień wielokolumnowych.',
    parameters: {
        type: Type.OBJECT,
        properties: {
            aiMessage: { type: Type.STRING, description: 'Czyste zdanie podsumowujące po polsku do dymku czatu.' },
            title: { type: Type.STRING },
            columns: { type: Type.ARRAY, items: { type: Type.STRING } },
            rows: {
                type: Type.ARRAY,
                items: { type: Type.ARRAY, items: { type: Type.STRING } }
            }
        },
        required: ['aiMessage', 'title', 'columns', 'rows']
    }
};

const TOOL_RENDER_KPI = {
    name: 'renderKpiWidget',
    description: 'Kafelki z kluczowymi liczbami (1-4 wartości: suma, średnia, max, ilość).',
    parameters: {
        type: Type.OBJECT,
        properties: {
            aiMessage: { type: Type.STRING, description: 'Czysty tekst podsumowania do dymku czatu.' },
            title: { type: Type.STRING },
            metrics: {
                type: Type.ARRAY,
                items: {
                    type: Type.OBJECT,
                    properties: {
                        label: { type: Type.STRING },
                        value: { type: Type.STRING }
                    },
                    required: ['label', 'value']
                }
            }
        },
        required: ['aiMessage', 'title', 'metrics']
    }
};

// ─── DEKLARATYWNY SILNIK DANYCH (Inżynier Danych) ────────────────────────────
export interface FirestoreQueryStep {
    collection: string;
    where?: Array<{ field: string; op: string; value: any }>;
    limit?: number;
}

async function executeDeclarativeQueries(queries: FirestoreQueryStep[]): Promise<{ data: Record<string, any[]>; collectionsUsed: string[] }> {
    const data: Record<string, any[]> = {};
    const collectionsUsed: string[] = [];

    const tasks = queries.map(async (step) => {
        const colName = step.collection;
        let q: FirebaseFirestore.Query = adminDb.collection(colName);

        // Zastosuj filtry where tylko jeśli zostały rzeczywiście zdefiniowane
        if (Array.isArray(step.where) && step.where.length > 0) {
            for (const filter of step.where) {
                if (filter.field && filter.op && filter.value !== undefined && filter.value !== null) {
                    q = q.where(filter.field, filter.op as any, filter.value);
                }
            }
        }

        const limitVal = step.limit && step.limit > 0 ? Math.min(step.limit, 500) : 300;
        q = q.limit(limitVal);

        const snap = await q.get();
        data[colName] = snap.docs.map(doc => {
            const raw = doc.data();
            const record: Record<string, any> = { id: doc.id };
            for (const [key, val] of Object.entries(raw)) {
                if (val instanceof Timestamp) {
                    record[key] = val.toDate().toISOString().split('T')[0];
                    record[`${key}Millis`] = val.toMillis();
                } else if (typeof val === 'string' && val.length > 500) {
                    // Ignoruj olbrzymie stringi / skany / base64
                    continue;
                } else {
                    record[key] = val;
                }
            }
            return record;
        });

        if (!collectionsUsed.includes(colName)) {
            collectionsUsed.push(colName);
        }
    });

    await Promise.all(tasks);
    return { data, collectionsUsed };
}

// ─── GŁÓWNY HANDLER POST ─────────────────────────────────────────────────────
export async function POST(req: Request) {
    const logs: string[] = [];

    try {
        // 1. Weryfikacja sesji użytkownika
        const authHeader = req.headers.get('Authorization');
        if (!authHeader?.startsWith('Bearer ')) {
            return NextResponse.json({ error: 'Brak autoryzacji' }, { status: 401 });
        }
        const token = authHeader.slice(7);
        const decoded = await adminAuth.verifyIdToken(token);

        // 2. Weryfikacja uprawnień
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

        // 3. Pobranie zapytania
        const { messages } = await req.json() as { messages: Array<{ role: string; content: string }> };
        if (!messages?.length) {
            return NextResponse.json({ error: 'Brak treści wiadomości' }, { status: 400 });
        }
        const latestQuestion = messages[messages.length - 1].content;
        logs.push(`[Użytkownik] "${latestQuestion}"`);

        // 4. Pobranie biblioteki nauczonych narzędzi z Firestore (ai_tools)
        const savedToolsSnap = await adminDb.collection('ai_tools').orderBy('usageCount', 'desc').limit(40).get();
        const existingToolsList = savedToolsSnap.docs.map(d => {
            const data = d.data();
            return {
                id: d.id,
                name: data.name || d.id,
                description: data.description || '',
                analyticalGoal: data.analyticalGoal || '',
                preferredWidget: data.preferredWidget || 'chart',
                chartType: data.chartType || 'bar',
                queries: (data.queries as FirestoreQueryStep[]) || []
            };
        });

        const toolsSummary = existingToolsList.length > 0
            ? existingToolsList.map(t => `- [${t.id}] "${t.name}": ${t.description}`).join('\n')
            : '(Brak zarejestrowanych narzędzi — system wytworzy pierwsze narzędzie dla tego pytania)';

        // =====================================================================
        // AGENT 1: ORCHESTRATOR / MÓZG (gemini-2.5-pro)
        // =====================================================================
        logs.push(`[Mózg: Orchestrator] Analiza zapytania (Model: ${ORCHESTRATOR_MODEL})...`);

        const orchestratorPrompt = `
${DB_SCHEMA}

ZAREJESTROWANE NARZĘDZIA W BAZIE FIRESTORE (ai_tools):
${toolsSummary}

Pytanie użytkownika: "${latestQuestion}"
Dzisiejsza data: ${new Date().toISOString().split('T')[0]}

ZASADY DLA ORCHESTRATORA:
1. Znasz dokładne nazwy tabel i kolumn w DB_SCHEMA.
2. Gdy pytanie to zwykłe powitanie/rozmowa ogólna -> isAnalysis=false, conversationalReply="...".
3. Gdy pytanie dotyczy danych z bazy:
   a) Sprawdź, czy któreś narzędzie z ZAREJESTROWANYCH NARZĘDZI pasuje:
      - Jeśli TAK: ustaw toolAction="USE_EXISTING" oraz matchedToolId na ID pasującego narzędzia.
      - Jeśli NIE: ustaw toolAction="CREATE_NEW" i zdefiniuj newToolDefinition (slug, nazwa, opis, analyticalGoal dla Pythona).
   b) ZBUDUJ PRECYZYJNE ZAPYTANIA W 'queries':
      - Określ, które kolekcje z DB_SCHEMA muszą zostać pobrane ('vehicles', 'repairs', 'residuals', 'inventory', 'orders', 'sites').
      - Jeśli użytkownik pyta OGÓLNIE (np. "jakimi samochodami dysponujemy", "ile wydaliśmy na naprawy", "co mamy na magazynie") -> NIE DODAWASZ ŻADNYCH FILTRÓW! Zostaw tablicę 'where' jako pustą []. Wtedy Inżynier Danych pobierze wszystkie rekordy.
      - Jeśli użytkownik wskazał KONKRETNY filtr w pytaniu (np. "Iveco", "Zawieszenie", "rok 2024") -> dodaj filtr do tablicy 'where' z dokładną nazwą kolumny z DB_SCHEMA (np. field: "brand", op: "==", value: "Iveco").
`;

        let orchestratorRes: any;
        try {
            orchestratorRes = await runWithRetry({
                model: ORCHESTRATOR_MODEL,
                contents: [{ role: 'user', parts: [{ text: orchestratorPrompt }] }],
                config: {
                    systemInstruction: `Jesteś Głównym Mózgiem i Architektem Bazy Danych PESAM. Posługujesz się schematem DB_SCHEMA. Budujesz precyzyjne zapytania w 'queries'. Gdy pytanie jest ogólne o daną encję, tablica 'where' MUSI być pusta [].`,
                    temperature: 0.1,
                    responseMimeType: 'application/json',
                    responseSchema: ORCHESTRATOR_SCHEMA
                }
            });
        } catch (err) {
            logs.push(`[Orchestrator Fallback] Przełączanie na ${ORCHESTRATOR_FALLBACK}...`);
            orchestratorRes = await runWithRetry({
                model: ORCHESTRATOR_FALLBACK,
                contents: [{ role: 'user', parts: [{ text: orchestratorPrompt }] }],
                config: {
                    systemInstruction: `Jesteś Głównym Mózgiem i Architektem PESAM. Budujesz zapytania w 'queries' na podstawie DB_SCHEMA.`,
                    temperature: 0.1,
                    responseMimeType: 'application/json',
                    responseSchema: ORCHESTRATOR_SCHEMA
                }
            });
        }

        let plan: any = {};
        try {
            plan = JSON.parse(orchestratorRes.text?.replace(/```json|```/g, '').trim() || '{}');
        } catch {
            plan = { isAnalysis: true, toolAction: 'CREATE_NEW' };
        }

        // Ścieżka rozmowy ogólnej
        if (!plan.isAnalysis && plan.conversationalReply) {
            logs.push('[Orchestrator] Rozmowa ogólna -> Natychmiastowa odpowiedź.');
            return NextResponse.json({
                reply: plan.conversationalReply,
                widget: null,
                logs
            });
        }

        // =====================================================================
        // ROZSTRZYGNIĘCIE: SZYBKA ŚCIEŻKA (USE_EXISTING) vs NAUKA (CREATE_NEW)
        // =====================================================================
        let activeTool: any = null;
        let isToolNew = false;
        let queriesToRun: FirestoreQueryStep[] = Array.isArray(plan.queries) ? plan.queries : [];
        let analyticalGoal: string = plan.analyticalGoal || latestQuestion;

        if (plan.toolAction === 'USE_EXISTING' && plan.matchedToolId) {
            activeTool = existingToolsList.find(t => t.id === plan.matchedToolId);
            if (activeTool) {
                logs.push(`[ai_tools] ⚡ Błyskawiczne dopasowanie: "${activeTool.name}" [${activeTool.id}]`);
                analyticalGoal = activeTool.analyticalGoal;
                if (!queriesToRun.length && activeTool.queries?.length) {
                    queriesToRun = activeTool.queries;
                }
            }
        }

        if (!activeTool) {
            isToolNew = true;
            const newDef = plan.newToolDefinition || {
                id: `tool_${Date.now()}`,
                name: 'Nowa analiza danych',
                description: latestQuestion,
                analyticalGoal: latestQuestion,
                preferredWidget: 'chart',
                chartType: 'bar'
            };
            activeTool = { ...newDef, queries: queriesToRun };
            analyticalGoal = newDef.analyticalGoal || analyticalGoal;
            logs.push(`[ai_tools] 🎓 Tworzenie nowej umiejętności: "${activeTool.name}"`);
        }

        // Zabezpieczenie: jeśli queriesToRun jest puste, wywnioskuj kolekcję z intencji pytania
        if (queriesToRun.length === 0) {
            const ql = latestQuestion.toLowerCase();
            if (ql.includes('samoch') || ql.includes('aut') || ql.includes('flot') || ql.includes('pojazd') || ql.includes('napraw')) {
                queriesToRun.push({ collection: 'vehicles' });
                if (ql.includes('napraw') || ql.includes('koszt') || ql.includes('serwis') || ql.includes('pieni')) {
                    queriesToRun.push({ collection: 'repairs' });
                }
            } else if (ql.includes('resztk') || ql.includes('plac') || ql.includes('stref') || ql.includes('magazyn')) {
                queriesToRun.push({ collection: 'residuals' });
            } else if (ql.includes('sprzęt') || ql.includes('narzędz') || ql.includes('maszyn')) {
                queriesToRun.push({ collection: 'inventory' });
            } else if (ql.includes('zamówien')) {
                queriesToRun.push({ collection: 'orders' });
            } else if (ql.includes('budow')) {
                queriesToRun.push({ collection: 'sites' });
            }
        }

        // =====================================================================
        // AGENT 2: INŻYNIER DANYCH — POBIERANIE ZAPYTANIAMI DEKLARATYWNYMI
        // =====================================================================
        logs.push(`[Agent 2: Inżynier Danych] Wykonywanie zapytań do Firestore (${queriesToRun.map(q => q.collection).join(', ')})...`);
        const { data: dbData, collectionsUsed } = await executeDeclarativeQueries(queriesToRun);
        logs.push(`[Firestore] Pobrane rekordy z kolekcji: ${collectionsUsed.join(', ') || 'brak'}`);

        const totalRecords = Object.values(dbData).reduce((acc: number, arr: any[]) => acc + (Array.isArray(arr) ? arr.length : 0), 0);
        if (totalRecords === 0) {
            return NextResponse.json({
                reply: 'W systemie nie znaleziono rekordów odpowiadających podanemu zapytaniu.',
                widget: null,
                dataUsed: collectionsUsed,
                logs
            });
        }

        // =====================================================================
        // AGENT 4: MATEMATYK & DATA SCIENTIST (Python Code Execution)
        // =====================================================================
        logs.push(`[Agent 4: Matematyk] Uruchamianie Python Sandbox (Google Cloud)...`);

        const mathPrompt = `
Pytanie użytkownika: "${latestQuestion}"
Narzędzie: "${activeTool.name}"
Cel wyliczeń: "${analyticalGoal}"
Dzisiejsza data: ${new Date().toISOString().split('T')[0]}

DANE POBRANE Z FIRESTORE (JSON):
${JSON.stringify(dbData)}

TWOJE ZADANIE:
1. Napisz i uruchom kod w Pythonie, który przetworzy powyższe dane.
2. Wykonaj 100% precyzyjne obliczenia (sumy, średnie, wykaz samochodów, koszty napraw, rotacje).
3. Wypisz wyniki na stdout.
4. Na końcu wypisz sekcję:
PODSUMOWANIE DLA KIEROWNIKA:
(2-3 konkretne, czytelne zdania po polsku z liczbami i wnioskami biznesowymi)
`;

        const mathRes = await runWithRetry({
            model: MATH_MODEL,
            contents: [{ role: 'user', parts: [{ text: mathPrompt }] }],
            config: {
                systemInstruction: `Jesteś Matematykiem PESAM. Piszesz kod w Pythonie i wykonujesz go w sandboxie. Tylko bezbłędne, precyzyjne liczby. Zero halucynacji.`,
                temperature: 0.0,
                tools: [{ codeExecution: {} }]
            }
        });

        const mathParts = mathRes.candidates?.[0]?.content?.parts || [];
        const mathOutput = mathParts
            .map((p: any) => p.text || p.codeExecutionResult?.output || '')
            .filter(Boolean)
            .join('\n') || 'Obliczenia zakończone.';

        const pythonRan = mathParts.some((p: any) => p.executableCode || p.codeExecutionResult);
        logs.push(pythonRan ? '[Matematyk] ✓ Kod Python wykonany pomyślnie' : '[Matematyk] Kalkulacja zakończona');

        // =====================================================================
        // ZAPIS NOWEGO NARZĘDZIA DO FIRESTORE (ai_tools)
        // =====================================================================
        if (isToolNew && activeTool.id) {
            try {
                const toolRef = adminDb.collection('ai_tools').doc(activeTool.id);
                await toolRef.set({
                    id: activeTool.id,
                    name: activeTool.name,
                    description: activeTool.description || '',
                    analyticalGoal: activeTool.analyticalGoal || analyticalGoal,
                    preferredWidget: activeTool.preferredWidget || 'chart',
                    chartType: activeTool.chartType || 'bar',
                    queries: queriesToRun,
                    createdAt: new Date().toISOString(),
                    lastUsedAt: new Date().toISOString(),
                    usageCount: 1
                }, { merge: true });
                logs.push(`[ai_tools] 💾 Zapisano nowe narzędzie "${activeTool.name}" do bazy Firestore!`);
            } catch (saveErr) {
                console.error('Błąd zapisu do ai_tools:', saveErr);
            }
        } else if (activeTool.id) {
            try {
                await adminDb.collection('ai_tools').doc(activeTool.id).update({
                    usageCount: FieldValue.increment(1),
                    lastUsedAt: new Date().toISOString()
                });
            } catch {}
        }

        // =====================================================================
        // AGENT 5: PREZENTER UI (Architekt Raportów & Wykresów)
        // =====================================================================
        logs.push(`[Agent 5: Prezenter UI] Dobieranie wizualizacji...`);

        const presenterPrompt = `
Pytanie: "${latestQuestion}"
Narzędzie: "${activeTool.name}"

WYNIKI Z PIASKOWNICY PYTHON:
${mathOutput}

ZADANIE:
Wybierz JEDNO narzędzie i przygotuj dane:
1. renderChartWidget -> jeśli to porównanie liczb lub trend (chartType: "bar" | "pie" | "line").
2. renderTableWidget -> jeśli to szczegółowa lista (np. lista samochodów z markami, modelami i rejestracjami).
3. renderKpiWidget -> jeśli to 1-3 kluczowe liczby sumaryczne (np. łączny koszt napraw).

WAŻNE DLA aiMessage:
Napisz zwięzłe podsumowanie po polsku dla czatu (2-4 zdania). Wskaż najważniejsze liczby i wnioski.
BEZWZGLĘDNIE UKRYJ KOD PYTHONA I ZWYKŁY STDOUT!
`;

        const presenterRes = await runWithRetry({
            model: PRESENTER_MODEL,
            contents: [{ role: 'user', parts: [{ text: presenterPrompt }] }],
            config: {
                systemInstruction: `Jesteś Architektem UI PESAM. Wybierz narzędzie wizualne. aiMessage musi być czystym tekstem po polsku bez kodu.`,
                temperature: 0.0,
                tools: [{ functionDeclarations: [TOOL_RENDER_CHART, TOOL_RENDER_TABLE, TOOL_RENDER_KPI] }]
            }
        });

        let finalReply = 'Analiza zakończona.';
        let widgetData: any = null;

        const calls = presenterRes.functionCalls;
        if (calls && calls.length > 0) {
            const call = calls[0];
            const args = (call.args || {}) as any;
            finalReply = args.aiMessage || finalReply;

            if (call.name === 'renderChartWidget') {
                widgetData = {
                    type: 'chart',
                    chartType: args.chartType || 'bar',
                    title: args.title || activeTool.name,
                    datasetLabel: args.datasetLabel || 'Wartość',
                    labels: args.labels || [],
                    values: args.values || []
                };
            } else if (call.name === 'renderTableWidget') {
                widgetData = {
                    type: 'table',
                    title: args.title || activeTool.name,
                    columns: args.columns || [],
                    rows: args.rows || []
                };
            } else if (call.name === 'renderKpiWidget') {
                widgetData = {
                    type: 'kpi',
                    title: args.title || activeTool.name,
                    metrics: args.metrics || []
                };
            }
        } else {
            finalReply = presenterRes.text || mathOutput.split('PODSUMOWANIE DLA KIEROWNIKA:')[1]?.trim() || 'Oto wyniki zapytania.';
        }

        return NextResponse.json({
            reply: finalReply,
            widget: widgetData,
            toolUsed: {
                id: activeTool.id,
                name: activeTool.name,
                isNew: isToolNew
            },
            pythonExecuted: pythonRan,
            dataUsed: collectionsUsed,
            logs
        });

    } catch (err: any) {
        console.error('Błąd Orchestratora v8.0:', err);
        return NextResponse.json({
            error: 'Błąd przetwarzania wieloagentowego',
            detail: String(err?.message || err),
            logs
        }, { status: 500 });
    }
}
