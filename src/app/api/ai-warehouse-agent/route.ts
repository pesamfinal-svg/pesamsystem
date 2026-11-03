// src/app/api/ai-warehouse-agent/route.ts
// =============================================================================
// PESAM Autonomous Self-Learning Multi-Agent Orchestrator v11.0
//
// Architektura 2-krokowa LLM (eliminacja timeoutów):
// 1. getLiveDatabaseSchema() — NIEBLOKUJĄCA: cache 5min, statyczny fallback + odświeżanie w tle
// 2. AGENT 1: Orchestrator (gemini-2.5-flash-lite, ~3-5s) — plan + queries
// 3. AGENT 2: Inżynier Danych (Firestore SDK) — pobiera dane bez LLM
// 4. AGENT 3: Analityk+Prezenter (gemini-2.5-flash, ~10-15s) — analiza JSON + widget (functionDeclarations ONLY)
//    UWAGA: codeExecution usunięte — Vertex AI nie pozwala łączyć codeExecution+functionDeclarations
//           w jednym wywołaniu. LLM analizuje JSON bezpośrednio, bez Python sandbox.
// Łączny czas: ~15-20s (zamiast ~50s w v9.0 i >60s z codeExecution)
//
// LOGI: Każde żądanie zapisywane do kolekcji Firestore "ai_agent_logs" do celów debugowania.
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

// Modele — globalny endpoint Vertex AI
const ORCHESTRATOR_MODEL = 'gemini-2.5-flash-lite'; // szybki planer i prezenter
const MATH_PRESENTER_MODEL = 'gemini-2.5-flash';     // analiza danych + widget

// ─── HELPER: ZAPIS LOGÓW DO FIRESTORE (ai_agent_logs) ────────────────────────
// Zapisuje każde żądanie do Firestore aby ułatwić diagnozowanie błędów
async function saveAgentLog(entry: {
    question: string;
    userId: string;
    logs: string[];
    success: boolean;
    durationMs: number;
    error?: string;
    widgetType?: string;
    collectionsUsed?: string[];
}) {
    try {
        await adminDb.collection('ai_agent_logs').add({
            ...entry,
            timestamp: new Date().toISOString(),
            version: 'v11.0'
        });
    } catch {
        // Nie blokuj głównego flow jeśli zapis logu się nie powiedzie
    }
}

// ─── STATYCZNY SCHEMAT (fallback gdy cache zimny) ────────────────────────────
// Aktualizowany automatycznie przy kolejnych żądaniach przez getLiveDatabaseSchema()
const STATIC_SCHEMA_TEXT = `STRUKTURA BAZY DANYCH PESAM (schemat statyczny — zaktualizowany na żywo przy kolejnym żądaniu):
KOLEKCJA "vehicles": brand(string), model(string), year(number), registration(string), initialMileage(number), inspectionDate(string), dateAdded(string), summerTires(string), winterTires(string), currentTires(string)
KOLEKCJA "repairs": vehicleId(string,FK→vehicles), date(string,YYYY-MM-DD), cost(number,PLN), category(string), mileage(number), comments(string), location(string), accountingNumber(string), partsList(array), repairType(string)
KOLEKCJA "inventory": name(string), quantity(number), unit(string), category(string), zone(string), siteId(string), updatedAt(Timestamp)
KOLEKCJA "sites": name(string), address(string), managerId(string)
KOLEKCJA "workers": firstName(string), lastName(string), siteId(string), role(string)
KOLEKCJA "orders": status(string), createdAt(Timestamp), totalAmount(number), siteId(string)
KOLEKCJA "claims": type(string), status(string), amount(number), date(string), description(string)
KOLEKCJA "protocols": siteId(string), date(string), type(string), status(string)
KOLEKCJA "closeouts": siteId(string), date(string), totalCost(number), status(string)
KOLEKCJA "transactions": type(string), amount(number), date(string), category(string), description(string)`;

// ─── 1. DYNAMICZNA INSPEKCJA SCHEMATU BAZY DANYCH (Live Discovery) ────────────
interface SchemaFieldInfo {
    type: string;
    sample: any;
}

interface CollectionSchema {
    collection: string;
    fields: Record<string, SchemaFieldInfo>;
}

// Pamięć podręczna schematu (TTL: 5 minut)
let cachedSchema: { timestamp: number; schema: Record<string, CollectionSchema> } | null = null;

async function getLiveDatabaseSchema(): Promise<Record<string, CollectionSchema>> {
    const now = Date.now();
    if (cachedSchema && (now - cachedSchema.timestamp < 300000)) {
        return cachedSchema.schema;
    }

    const KNOWN_COLLECTIONS = [
        'vehicles', 'repairs', 'inventory', 'sites', 'workers',
        'protocols', 'claims', 'pending_wz_items', 'roles', 'users',
        'closeouts', 'orders', 'transactions'
    ];

    try {
        let collectionRefs: FirebaseFirestore.CollectionReference[] = [];
        try {
            const cols = await adminDb.listCollections();
            collectionRefs = cols.filter(c => !c.id.startsWith('_') && c.id !== 'ai_tools');
        } catch (listErr) {
            console.warn('adminDb.listCollections() niedostępne, użycie sondowania znanych kolekcji:', listErr);
        }

        if (collectionRefs.length === 0) {
            collectionRefs = KNOWN_COLLECTIONS.map(name => adminDb.collection(name));
        }

        const result: Record<string, CollectionSchema> = {};

        await Promise.all(collectionRefs.map(async (colRef) => {
            try {
                const snap = await colRef.limit(3).get();
                if (snap.empty && !KNOWN_COLLECTIONS.includes(colRef.id)) {
                    return;
                }

                const fields: Record<string, SchemaFieldInfo> = {};

                snap.docs.forEach(doc => {
                    const data = doc.data();
                    for (const [key, val] of Object.entries(data)) {
                        if (val instanceof Timestamp) {
                            fields[key] = { type: 'Timestamp', sample: val.toDate().toISOString().split('T')[0] };
                        } else if (Array.isArray(val)) {
                            fields[key] = { type: 'array', sample: val.slice(0, 2) };
                        } else if (val === null) {
                            if (!fields[key]) fields[key] = { type: 'null', sample: null };
                        } else if (typeof val === 'object') {
                            fields[key] = { type: 'object', sample: '{...}' };
                        } else if (typeof val === 'string') {
                            fields[key] = { type: 'string', sample: val.length > 50 ? val.slice(0, 45) + '...' : val };
                        } else {
                            fields[key] = { type: typeof val, sample: val };
                        }
                    }
                });

                result[colRef.id] = {
                    collection: colRef.id,
                    fields
                };
            } catch (colErr) {
                console.error(`Błąd badania kolekcji ${colRef.id}:`, colErr);
            }
        }));

        cachedSchema = { timestamp: now, schema: result };
        return result;
    } catch (err) {
        console.error('Błąd badania schematu Firestore:', err);
        return cachedSchema?.schema || {};
    }
}

function formatSchemaForPrompt(schemaMap: Record<string, CollectionSchema>): string {
    const lines: string[] = ['AKTUALNA STRUKTURA BAZY DANYCH (POBRANA NA ŻYWO Z FIRESTORE):'];
    for (const [colName, colData] of Object.entries(schemaMap)) {
        lines.push(`\nKOLEKCJA "${colName}":`);
        const fieldEntries = Object.entries(colData.fields);
        if (fieldEntries.length === 0) {
            lines.push('  (Kolekcja pusta lub brak dokumentów próbnych)');
        } else {
            for (const [fname, finfo] of fieldEntries) {
                const sampleStr = finfo.sample !== undefined ? ` [np. ${JSON.stringify(finfo.sample)}]` : '';
                lines.push(`  - ${fname}: ${finfo.type}${sampleStr}`);
            }
        }
    }
    return lines.join('\n');
}

// ─── RETRY Z EXPONENTIAL BACKOFF ─────────────────────────────────────────────
async function runWithRetry(params: any, retries = 2, delay = 800): Promise<any> {
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

// ─── SCHEMATY JSON DLA ORCHESTRATORA ────────────────────────────────────────
const QUERY_STEP_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        collection: {
            type: Type.STRING,
            description: 'Nazwa kolekcji z bazy danych'
        },
        where: {
            type: Type.ARRAY,
            description: 'Filtry where. PUSTA TABLICA [] jeśli pytanie ogólne. Dodawaj filtry TYLKO gdy użytkownik wprost podał konkretną wartość.',
            items: {
                type: Type.OBJECT,
                properties: {
                    field: { type: Type.STRING, description: 'Nazwa pola' },
                    op: { type: Type.STRING, description: 'Operator: ==, >=, <=, >, <' },
                    value: { type: Type.STRING, description: 'Wartość filtra' }
                },
                required: ['field', 'op', 'value']
            }
        },
        limit: {
            type: Type.NUMBER,
            description: 'Limit rekordów (domyślnie 300, max 500)'
        }
    },
    required: ['collection', 'where']
};

const ORCHESTRATOR_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        isAnalysis: {
            type: Type.BOOLEAN,
            description: 'true = zapytanie o dane z bazy; false = zwykłe powitanie lub rozmowa ogólna'
        },
        conversationalReply: {
            type: Type.STRING,
            description: 'Odpowiedź gdy isAnalysis=false (po polsku)'
        },
        toolAction: {
            type: Type.STRING,
            description: '"USE_EXISTING" jeśli pasuje do istniejącego narzędzia; "CREATE_NEW" jeśli nowe zapytanie',
            enum: ['USE_EXISTING', 'CREATE_NEW']
        },
        matchedToolId: {
            type: Type.STRING,
            description: 'ID istniejącego narzędzia gdy toolAction == "USE_EXISTING"'
        },
        newToolDefinition: {
            type: Type.OBJECT,
            description: 'Definicja nowego narzędzia gdy toolAction == "CREATE_NEW"',
            properties: {
                id: { type: Type.STRING, description: 'Slug w snake_case, np. suma_kosztow_napraw' },
                name: { type: Type.STRING, description: 'Zwięzła polska nazwa narzędzia' },
                description: { type: Type.STRING, description: 'Opis działania narzędzia' },
                analyticalGoal: { type: Type.STRING, description: 'Dokładny cel wyliczeń' },
                preferredWidget: { type: Type.STRING, enum: ['chart', 'table', 'kpi'] },
                chartType: { type: Type.STRING, enum: ['bar', 'pie', 'line'] }
            }
        },
        queries: {
            type: Type.ARRAY,
            description: 'Lista zapytań do Firestore. GDY isAnalysis=true: OBOWIĄZKOWO co najmniej 1 element! Pytania o naprawy → "repairs", o auta → "vehicles", o magazyn → "inventory", o budowy → "sites", o pracowników → "workers".',
            items: QUERY_STEP_SCHEMA
        },
        analyticalGoal: {
            type: Type.STRING,
            description: 'Instrukcja obliczeniowa dla Matematyka'
        }
    },
    required: ['isAnalysis', 'queries', 'toolAction', 'analyticalGoal']
};

// ─── NARZĘDZIA PREZENTERA UI ─────────────────────────────────────────────────
const TOOL_RENDER_CHART = {
    name: 'renderChartWidget',
    description: 'Wykres słupkowy (bar), kołowy (pie) lub liniowy (line). Użyj dla porównań kategorii, kosztów lub trendów czasowych.',
    parameters: {
        type: Type.OBJECT,
        properties: {
            aiMessage: { type: Type.STRING, description: 'Zwięzłe podsumowanie po polsku do czatu. BEZ KODU PYTHON!' },
            chartType: { type: Type.STRING, description: '"bar" | "pie" | "line"' },
            title: { type: Type.STRING, description: 'Tytuł wykresu' },
            datasetLabel: { type: Type.STRING, description: 'Etykieta serii danych' },
            labels: { type: Type.ARRAY, items: { type: Type.STRING } },
            values: { type: Type.ARRAY, items: { type: Type.NUMBER } }
        },
        required: ['aiMessage', 'chartType', 'title', 'labels', 'values']
    }
};

const TOOL_RENDER_TABLE = {
    name: 'renderTableWidget',
    description: 'Tabela danych. Użyj dla list pozycji lub zestawień wielokolumnowych.',
    parameters: {
        type: Type.OBJECT,
        properties: {
            aiMessage: { type: Type.STRING, description: 'Zwięzłe podsumowanie po polsku do czatu.' },
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
            aiMessage: { type: Type.STRING, description: 'Czysty tekst podsumowania do czatu.' },
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

// ─── WYKONYWANIE ZAPYTAŃ PRZEZ INŻYNIERA DANYCH ──────────────────────────────
export interface FirestoreQueryStep {
    collection: string;
    where?: Array<{ field: string; op: string; value: any }>;
    limit?: number;
}

async function executeDataEngineQueries(queries: FirestoreQueryStep[], logs: string[]): Promise<{ data: Record<string, any[]>; collectionsUsed: string[] }> {
    const data: Record<string, any[]> = {};
    const collectionsUsed: string[] = [];

    if (!queries || queries.length === 0) {
        logs.push('[Inżynier Danych] ⚠️ Brak zapytań (queries: []) — Mózg nie wyznaczył żadnej kolekcji');
        return { data, collectionsUsed };
    }

    const tasks = queries.map(async (step) => {
        const colName = step.collection;
        let q: FirebaseFirestore.Query = adminDb.collection(colName);

        const filterDescs: string[] = [];
        if (Array.isArray(step.where) && step.where.length > 0) {
            for (const filter of step.where) {
                if (filter.field && filter.op && filter.value !== undefined && filter.value !== null) {
                    q = q.where(filter.field, filter.op as any, filter.value);
                    filterDescs.push(`${filter.field} ${filter.op} ${JSON.stringify(filter.value)}`);
                }
            }
        }

        const limitVal = step.limit && step.limit > 0 ? Math.min(step.limit, 500) : 300;
        q = q.limit(limitVal);

        const filterSummary = filterDescs.length > 0 ? `filtry: [${filterDescs.join(', ')}]` : 'bez filtrów (pobieranie całości)';
        logs.push(`[Inżynier Danych → Firestore] Zapytanie do "${colName}" (${filterSummary}, limit=${limitVal})`);

        try {
            const snap = await q.get();
            logs.push(`[Inżynier Danych ← Firestore] Kolekcja "${colName}": pobrano ${snap.size} dokumentów`);

            data[colName] = snap.docs.map(doc => {
                const raw = doc.data();
                const record: Record<string, any> = { id: doc.id };
                for (const [key, val] of Object.entries(raw)) {
                    if (val instanceof Timestamp) {
                        record[key] = val.toDate().toISOString().split('T')[0];
                        record[`${key}Millis`] = val.toMillis();
                    } else if (typeof val === 'string' && val.length > 500) {
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
        } catch (fetchErr: any) {
            logs.push(`[Inżynier Danych ❌ Błąd] Kolekcja "${colName}": ${fetchErr?.message || fetchErr}`);
        }
    });

    await Promise.all(tasks);
    return { data, collectionsUsed };
}

// ─── INTELIGENTNA SIATKA BEZPIECZEŃSTWA ─────────────────────────────────────
// Jeśli Mózg zwrócił pustą listę queries, automatycznie przypisujemy kolekcje
// na podstawie słów kluczowych w pytaniu użytkownika.
function keywordFallbackQueries(question: string): FirestoreQueryStep[] {
    const qLower = question.toLowerCase();
    const fallback: FirestoreQueryStep[] = [];

    if (qLower.includes('napraw') || qLower.includes('serwis') || qLower.includes('remont')) {
        fallback.push({ collection: 'repairs', where: [] });
    }
    if (qLower.includes('samoch') || qLower.includes('aut') || qLower.includes('flot') || qLower.includes('pojazd')) {
        if (!fallback.some(q => q.collection === 'vehicles')) {
            fallback.push({ collection: 'vehicles', where: [] });
        }
    }
    if (qLower.includes('magazyn') || qLower.includes('resztk') || qLower.includes('materiał') || qLower.includes('towar') || qLower.includes('stan')) {
        if (!fallback.some(q => q.collection === 'inventory')) {
            fallback.push({ collection: 'inventory', where: [] });
        }
    }
    if (qLower.includes('budow') || qLower.includes('obiekt') || qLower.includes('lokalizac')) {
        if (!fallback.some(q => q.collection === 'sites')) {
            fallback.push({ collection: 'sites', where: [] });
        }
    }
    if (qLower.includes('pracownik') || qLower.includes('monter') || qLower.includes('brygad')) {
        if (!fallback.some(q => q.collection === 'workers')) {
            fallback.push({ collection: 'workers', where: [] });
        }
    }
    if (qLower.includes('zamówi') || qLower.includes('zamowien') || qLower.includes('order')) {
        if (!fallback.some(q => q.collection === 'orders')) {
            fallback.push({ collection: 'orders', where: [] });
        }
    }
    if (qLower.includes('wydatek') || qLower.includes('wydatk') || qLower.includes('transakcj') || qLower.includes('koszt') || qLower.includes('wydali')) {
        // koszt może być w repairs LUB transactions — sprawdź czy repairs już nie ma
        if (!fallback.some(q => q.collection === 'repairs')) {
            fallback.push({ collection: 'transactions', where: [] });
        }
    }

    return fallback;
}

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

        // 3. Pobranie zapytania użytkownika
        const { messages } = await req.json() as { messages: Array<{ role: string; content: string }> };
        if (!messages?.length) {
            return NextResponse.json({ error: 'Brak treści wiadomości' }, { status: 400 });
        }
        const latestQuestion = messages[messages.length - 1].content;
        currentQuestion = latestQuestion;
        logs.push(`👤 USER "${latestQuestion}"`);

        // 4. SCHEMAT BAZY — nieblokujące: jeśli cache zimny → statyczny schemat, odświeżanie w tle
        let schemaPromptText: string;
        if (cachedSchema && (Date.now() - cachedSchema.timestamp < 300000)) {
            logs.push('🔍 SCHEMAT Używam schematu z cache...');
            const detectedCols = Object.keys(cachedSchema.schema);
            logs.push(`🔍 SCHEMAT Wykryto ${detectedCols.length} kolekcji: ${detectedCols.join(', ')}`);
            schemaPromptText = formatSchemaForPrompt(cachedSchema.schema);
        } else {
            logs.push('🔍 SCHEMAT Brak aktualnego cache — używam schematu statycznego. Odświeżanie w tle...');
            schemaPromptText = STATIC_SCHEMA_TEXT;
            // Odświeżanie schematu w tle (nieblokujące)
            getLiveDatabaseSchema().then((freshSchema) => {
                const detectedCols = Object.keys(freshSchema);
                console.log(`[Schema BG refresh] Wykryto ${detectedCols.length} kolekcji: ${detectedCols.join(', ')}`);
            }).catch(err => console.error('[Schema BG refresh error]', err));
        }

        // 5. Pobranie biblioteki nauczonych narzędzi z Firestore (ai_tools)
        const savedToolsSnap = await adminDb.collection('ai_tools').orderBy('usageCount', 'desc').limit(20).get();
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
            : '(Brak zarejestrowanych narzędzi — pierwsze zapytanie)';

        // =====================================================================
        // AGENT 1: ORCHESTRATOR / MÓZG (gemini-2.5-flash-lite — szybki planer)
        // =====================================================================
        logs.push(`🧠 MÓZG Analiza zapytania (Model: ${ORCHESTRATOR_MODEL})...`);

        const orchestratorPrompt = `${schemaPromptText}

ZAREJESTROWANE NARZĘDZIA (ai_tools):
${toolsSummary}

Pytanie użytkownika: "${latestQuestion}"
Dzisiejsza data: ${new Date().toISOString().split('T')[0]}

INSTRUKCJE DLA ORCHESTRATORA:
1. Zdecyduj czy to pytanie o dane (isAnalysis=true) czy rozmowa (isAnalysis=false).
2. GDY isAnalysis=true — OBOWIĄZKOWO wypełnij tablicę 'queries' co najmniej 1 elementem:
   - Pytania o naprawy / serwisy / koszty napraw → collection: "repairs", where: []
   - Pytania o samochody / flotę / auta / pojazdy → collection: "vehicles", where: []
   - Pytania o magazyn / materiały / towar → collection: "inventory", where: []
   - Pytania o budowy / obiekty / lokalizacje → collection: "sites", where: []
   - Pytania o pracowników / monterów → collection: "workers", where: []
   - Pytania o transakcje / wydatki finansowe → collection: "transactions", where: []
3. Filtry 'where' TYLKO gdy użytkownik wprost podał konkretną wartość (np. markę "Iveco" lub konkretny rok).
   W przeciwnym razie where: [] — Agent Matematyk przefiltruje i policzy daty w Pythonie.
4. Ustaw toolAction: "CREATE_NEW" lub "USE_EXISTING" (jeśli pasuje do ai_tools).
5. Wypełnij analyticalGoal — precyzyjny cel wyliczeń dla Agenta Matematyka.`;

        let plan: any = {};
        try {
            const orchestratorRes = await runWithRetry({
                model: ORCHESTRATOR_MODEL,
                contents: [{ role: 'user', parts: [{ text: orchestratorPrompt }] }],
                config: {
                    systemInstruction: `Jesteś Głównym Mózgiem PESAM. Analizujesz pytania i zlecasz zapytania do bazy danych. GDY isAnalysis=true, ZAWSZE wypełniaj 'queries' co najmniej jedną kolekcją. Nie zostawiaj queries jako pustej tablicy gdy pytanie dotyczy danych.`,
                    temperature: 0.0,
                    responseMimeType: 'application/json',
                    responseSchema: ORCHESTRATOR_SCHEMA
                }
            });
            plan = JSON.parse(orchestratorRes.text?.replace(/```json|```/g, '').trim() || '{}');
            logs.push(`🧠 MÓZG Plan: isAnalysis=${plan.isAnalysis}, toolAction=${plan.toolAction}, queries=${JSON.stringify((plan.queries||[]).map((q:any)=>q.collection))}`);
        } catch (err: any) {
            logs.push(`🧠 MÓZG ⚠️ Błąd modelu: ${err?.message?.slice(0, 100) || err}`);
            plan = { isAnalysis: true, toolAction: 'CREATE_NEW', analyticalGoal: latestQuestion, queries: [] };
        }

        // Ścieżka rozmowy ogólnej
        if (!plan.isAnalysis && plan.conversationalReply) {
            logs.push('🧠 MÓZG Rozmowa ogólna → Natychmiastowa odpowiedź.');
            return NextResponse.json({ reply: plan.conversationalReply, widget: null, logs });
        }

        // =====================================================================
        // ROZSTRZYGNIĘCIE: SZYBKA ŚCIEŻKA (USE_EXISTING) vs NAUKA (CREATE_NEW)
        // =====================================================================
        let activeTool: any = null;
        let isToolNew = false;
        let queriesToRun: FirestoreQueryStep[] = Array.isArray(plan.queries) ? plan.queries.filter((q: any) => q?.collection) : [];
        let analyticalGoal: string = plan.analyticalGoal || latestQuestion;

        if (plan.toolAction === 'USE_EXISTING' && plan.matchedToolId) {
            activeTool = existingToolsList.find(t => t.id === plan.matchedToolId);
            if (activeTool) {
                logs.push(`💾 TOOL ⚡ Narzędzie z biblioteki: "${activeTool.name}" [${activeTool.id}]`);
                analyticalGoal = activeTool.analyticalGoal || analyticalGoal;
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
            logs.push(`💾 TOOL 🎓 Tworzenie nowego narzędzia: "${activeTool.name}"`);
        }

        // ─── INTELIGENTNA SIATKA BEZPIECZEŃSTWA ─────────────────────────────
        if (queriesToRun.length === 0 && plan.isAnalysis !== false) {
            const fallback = keywordFallbackQueries(latestQuestion);
            if (fallback.length > 0) {
                queriesToRun = fallback;
                activeTool.queries = queriesToRun;
                logs.push(`🛡️ SIATKA Automatycznie wyznaczono kolekcje: [${queriesToRun.map(q => q.collection).join(', ')}]`);
            }
        }

        logs.push(`🧠 MÓZG Decyzja: akcja=${plan.toolAction || 'CREATE_NEW'}, cel="${analyticalGoal}"`);

        // =====================================================================
        // AGENT 2: INŻYNIER DANYCH — POBIERANIE Z FIRESTORE
        // =====================================================================
        logs.push(`🗄️ BAZA [Inżynier Danych] Wykonywanie zapytań do Firestore...`);
        const { data: dbData, collectionsUsed } = await executeDataEngineQueries(queriesToRun, logs);

        const totalRecords = Object.values(dbData).reduce((acc: number, arr: any[]) => acc + (Array.isArray(arr) ? arr.length : 0), 0);
        logs.push(`🗄️ BAZA Łącznie pobrano ${totalRecords} rekordów z ${collectionsUsed.join(', ') || 'brak'}.`);

        if (totalRecords === 0) {
            logs.push(`🧠 MÓZG ⚠️ Brak rekordów. Zakończono.`);
            return NextResponse.json({
                reply: `W systemie nie znaleziono rekordów odpowiadających zapytaniu (przeszukano: ${collectionsUsed.join(', ') || 'brak'}). Rozwiń podgląd procesu poniżej, aby zobaczyć zastosowane filtry.`,
                widget: null,
                dataUsed: collectionsUsed,
                logs
            });
        }

        // Ogranicz dane do 120 rekordów na kolekcję aby nie przekroczyć limitu tokenów
        const trimmedData: Record<string, any[]> = {};
        for (const [col, records] of Object.entries(dbData)) {
            trimmedData[col] = (records as any[]).slice(0, 120);
        }

        // =====================================================================
        // AGENT 3: MATEMATYK + PREZENTER (gemini-2.5-flash + codeExecution ONLY)
        //
        // Rozwiązanie konfliktu codeExecution vs functionDeclarations:
        // Vertex AI nie pozwala łączyć obu narzędzi w jednym wywołaniu.
        // Zamiast tego: Python sam generuje WIDGET_JSON:{...} na stdout.
        // Serwer parsuje ten JSON i buduje widget — zero dodatkowego LLM call.
        //
        // Format który Python musi wydrukować na końcu:
        // WIDGET_JSON:{"type":"chart","chartType":"bar","title":"...","labels":[...],"values":[...],"aiMessage":"..."}
        // lub:
        // WIDGET_JSON:{"type":"table","title":"...","columns":[...],"rows":[[...],...],"aiMessage":"..."}
        // lub:
        // WIDGET_JSON:{"type":"kpi","title":"...","metrics":[{"label":"...","value":"..."},...],"aiMessage":"..."}
        // =====================================================================
        logs.push(`🐍 PYTHON [Matematyk+Prezenter] Python sandbox (Model: ${MATH_PRESENTER_MODEL})...`);

        const mathPrompt = `Pytanie użytkownika: "${latestQuestion}"
Cel analizy: "${analyticalGoal}"
Dzisiejsza data: ${new Date().toISOString().split('T')[0]}

DANE POBRANE Z FIRESTORE (JSON):
${JSON.stringify(trimmedData)}

ZADANIE — napisz i wykonaj kod Pythona który:
1. Przetworzy dane i wykona obliczenia (sumy wg kategorii, zakresy dat, grupowania po vehicleId itp.).
2. Na SAMYM KOŃCU wydrukuje dokładnie jedną linię w formacie:
   WIDGET_JSON:<json>

Gdzie <json> to jeden z poniższych formatów (wybierz odpowiedni):

Dla wykresu słupkowego/kołowego/liniowego:
WIDGET_JSON:{"type":"chart","chartType":"bar","title":"<tytuł>","datasetLabel":"<etykieta serii>","labels":["<kat1>","<kat2>"],"values":[<num1>,<num2>],"aiMessage":"<2-4 zdania po polsku z liczbami>"}

Dla tabeli z listą pozycji:
WIDGET_JSON:{"type":"table","title":"<tytuł>","columns":["<kol1>","<kol2>"],"rows":[["<w1c1>","<w1c2>"],["<w2c1>","<w2c2>"]],"aiMessage":"<2-4 zdania po polsku>"}

Dla KPI (1-4 kluczowe liczby):
WIDGET_JSON:{"type":"kpi","title":"<tytuł>","metrics":[{"label":"<nazwa>","value":"<wartość>"}],"aiMessage":"<2-4 zdania po polsku>"}

WAŻNE:
- chartType: "bar" dla porównań kategorii, "pie" dla udziałów procentowych, "line" dla trendów czasowych
- aiMessage: konkretne zdania po polsku z liczbami i wnioskami. ZERO kodu Pythona w aiMessage!
- Linia WIDGET_JSON musi być ostatnią linią outputu i być poprawnym JSON`;

        const mathRes = await runWithRetry({
            model: MATH_PRESENTER_MODEL,
            contents: [{ role: 'user', parts: [{ text: mathPrompt }] }],
            config: {
                systemInstruction: `Jesteś Matematykiem PESAM. Wykonujesz obliczenia w Pythonie i na końcu drukujesz WIDGET_JSON z wynikami. aiMessage to czyste zdania po polsku z liczbami — zero kodu.`,
                temperature: 0.0,
                tools: [{ codeExecution: {} }]
            }
        });

        // Zbierz output z Python sandbox
        const mathParts = mathRes.candidates?.[0]?.content?.parts || [];
        const pythonRan = mathParts.some((p: any) => p.executableCode || p.codeExecutionResult);
        const allOutput = mathParts
            .map((p: any) => p.codeExecutionResult?.output || p.text || '')
            .filter(Boolean)
            .join('\n');

        if (pythonRan) {
            logs.push(`🐍 PYTHON ✓ Kod Python wykonany. Output: ${allOutput.slice(0, 250).replace(/\n/g, ' ')}`);
        } else {
            logs.push(`🐍 PYTHON Model odpowiedział bez uruchomienia kodu.`);
        }

        // ── Parsowanie WIDGET_JSON z outputu Pythona ──────────────────────────
        let finalReply = 'Analiza zakończona.';
        let widgetData: any = null;

        const widgetMatch = allOutput.match(/WIDGET_JSON:(\{[\s\S]*?\})\s*$/) ||
                            allOutput.match(/WIDGET_JSON:(\{[\s\S]*\})/);
        if (widgetMatch) {
            try {
                const parsed = JSON.parse(widgetMatch[1]);
                finalReply = parsed.aiMessage || finalReply;

                if (parsed.type === 'chart') {
                    widgetData = {
                        type: 'chart',
                        chartType: parsed.chartType || 'bar',
                        title: parsed.title || activeTool.name,
                        datasetLabel: parsed.datasetLabel || 'Wartość',
                        labels: parsed.labels || [],
                        values: parsed.values || []
                    };
                    logs.push(`🎨 UI Wykres ${parsed.chartType}: "${parsed.title}" (${(parsed.labels||[]).length} kategorii)`);
                } else if (parsed.type === 'table') {
                    widgetData = {
                        type: 'table',
                        title: parsed.title || activeTool.name,
                        columns: parsed.columns || [],
                        rows: parsed.rows || []
                    };
                    logs.push(`🎨 UI Tabela: "${parsed.title}" (${(parsed.rows||[]).length} wierszy)`);
                } else if (parsed.type === 'kpi') {
                    widgetData = {
                        type: 'kpi',
                        title: parsed.title || activeTool.name,
                        metrics: parsed.metrics || []
                    };
                    logs.push(`🎨 UI KPI: "${parsed.title}" (${(parsed.metrics||[]).length} wskaźników)`);
                }
            } catch (parseErr) {
                logs.push(`🎨 UI ⚠️ Błąd parsowania WIDGET_JSON: ${parseErr}`);
                // Fallback — odpowiedź tekstowa z outputu Pythona
                finalReply = allOutput.split('WIDGET_JSON:')[0].trim() || 'Oto wyniki analizy.';
            }
        } else {
            // Brak WIDGET_JSON — odpowiedź tekstowa
            const textParts = mathParts.map((p: any) => p.text || '').filter(Boolean).join('\n');
            finalReply = textParts || allOutput || 'Oto wyniki analizy.';
            logs.push(`🎨 UI Brak WIDGET_JSON w outputcie — odpowiedź tekstowa.`);
        }

        // =====================================================================
        // ZAPIS / AKTUALIZACJA NARZĘDZIA W FIRESTORE (ai_tools)
        // =====================================================================
        if (isToolNew && activeTool.id) {
            try {
                await adminDb.collection('ai_tools').doc(activeTool.id).set({
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
                logs.push(`💾 TOOL Zapisano narzędzie "${activeTool.name}" do ai_tools.`);
            } catch (saveErr) {
                console.error('Błąd zapisu do ai_tools:', saveErr);
            }
        } else if (activeTool.id) {
            try {
                await adminDb.collection('ai_tools').doc(activeTool.id).update({
                    usageCount: FieldValue.increment(1),
                    lastUsedAt: new Date().toISOString()
                });
            } catch { /* ignoruj błędy aktualizacji */ }
        }

        // ── Zapis logu sukcesu do ai_agent_logs ──────────────────────────────
        const durationMs = Date.now() - requestStartTime;
        logs.push(`⏱️ Czas wykonania: ${durationMs}ms`);
        await saveAgentLog({
            question: latestQuestion,
            userId: decoded.uid,
            logs,
            success: true,
            durationMs,
            widgetType: widgetData?.type || 'text',
            collectionsUsed
        });

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
        console.error('Błąd Orchestratora v11.0:', err);
        // ── Zapis logu błędu do ai_agent_logs ────────────────────────────────
        await saveAgentLog({
            question: currentQuestion,
            userId: currentUserId,
            logs,
            success: false,
            durationMs: Date.now() - requestStartTime,
            error: String(err?.message || err)
        });
        return NextResponse.json({
            error: 'Błąd przetwarzania wieloagentowego',
            detail: String(err?.message || err),
            logs
        }, { status: 500 });
    }
}
