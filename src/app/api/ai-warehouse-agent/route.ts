// src/app/api/ai-warehouse-agent/route.ts
// =============================================================================
// PESAM Autonomous Self-Learning Multi-Agent Orchestrator v10.0
//
// Architektura 2-krokowa (eliminacja timeoutów):
// 1. getLiveDatabaseSchema() — NIEBLOKUJĄCA: jeśli cache zimny → statyczny schemat + odświeżanie w tle
// 2. AGENT 1: Orchestrator (gemini-2.5-flash-lite, ~3-5s) — tylko plan + queries
// 3. AGENT 2: Inżynier Danych (Firestore SDK) — pobiera dane
// 4. AGENT 3: Matematyk+Prezenter (gemini-2.5-flash, ~10-15s) — liczy + wybiera widget w 1 wywołaniu
// Łączny czas: ~20-25s (zamiast ~50s w v9.0)
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
const ORCHESTRATOR_MODEL = 'gemini-2.5-flash-lite'; // szybki planer
const MATH_PRESENTER_MODEL = 'gemini-2.5-flash';     // math + prezentacja w 1 wywołaniu

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

        // 3. Pobranie zapytania użytkownika
        const { messages } = await req.json() as { messages: Array<{ role: string; content: string }> };
        if (!messages?.length) {
            return NextResponse.json({ error: 'Brak treści wiadomości' }, { status: 400 });
        }
        const latestQuestion = messages[messages.length - 1].content;
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

        // Ogranicz dane do 150 rekordów na kolekcję aby nie przekroczyć limitu tokenów
        const trimmedData: Record<string, any[]> = {};
        for (const [col, records] of Object.entries(dbData)) {
            trimmedData[col] = (records as any[]).slice(0, 150);
        }

        // =====================================================================
        // AGENT 3: MATEMATYK + PREZENTER (gemini-2.5-flash) — JEDNO WYWOŁANIE
        // =====================================================================
        logs.push(`🐍 PYTHON [Matematyk+Prezenter] Obliczenia i wizualizacja (Model: ${MATH_PRESENTER_MODEL})...`);

        const mathPresenterPrompt = `Pytanie użytkownika: "${latestQuestion}"
Cel analizy: "${analyticalGoal}"
Dzisiejsza data: ${new Date().toISOString().split('T')[0]}

DANE POBRANE Z FIRESTORE (JSON):
${JSON.stringify(trimmedData)}

ZADANIE (2 kroki):
KROK 1 — PYTHON: Napisz i uruchom kod Pythona który:
  - Przetworzy powyższe dane
  - Wykona dokładne obliczenia (sumy, średnie, zakresy dat)
  - Wypisze wyniki i 2-3 zdania po polsku z wnioskami biznesowymi

KROK 2 — WIDGET: Po otrzymaniu wyników, wywołaj JEDNO narzędzie wizualne:
  - renderChartWidget → gdy porównujesz liczby wielu kategorii lub trend czasowy (chartType: "bar", "pie" lub "line")
  - renderTableWidget → gdy to lista pozycji z wieloma polami (auta, pracownicy, pozycje)
  - renderKpiWidget → gdy to 1-4 kluczowe liczby sumaryczne (łączna kwota, count, max)

W aiMessage napisz TYLKO podsumowanie po polsku (2-4 zdania). BEZ KODU PYTHON!`;

        const mathPresenterRes = await runWithRetry({
            model: MATH_PRESENTER_MODEL,
            contents: [{ role: 'user', parts: [{ text: mathPresenterPrompt }] }],
            config: {
                systemInstruction: `Jesteś Matematykiem i Prezenterem PESAM. Najpierw wykonaj obliczenia w Pythonie z pełną precyzją. Następnie wywołaj narzędzie wizualne z wynikami. aiMessage to czyste zdania po polsku, ZERO kodu.`,
                temperature: 0.0,
                tools: [
                    { codeExecution: {} },
                    { functionDeclarations: [TOOL_RENDER_CHART, TOOL_RENDER_TABLE, TOOL_RENDER_KPI] }
                ]
            }
        });

        // Zbierz logi z Python sandbox
        const mathParts = mathPresenterRes.candidates?.[0]?.content?.parts || [];
        const pythonOutput = mathParts
            .map((p: any) => p.codeExecutionResult?.output || '')
            .filter(Boolean)
            .join('\n');
        const pythonRan = mathParts.some((p: any) => p.executableCode || p.codeExecutionResult);

        if (pythonRan) {
            logs.push(`🐍 PYTHON ✓ Kod Python wykonany. Wynik: ${pythonOutput.slice(0, 300).replace(/\n/g, ' ')}`);
        } else {
            logs.push(`🐍 PYTHON Model odpowiedział bez kodu Python.`);
        }

        // Parsuj wynik prezentera
        let finalReply = 'Analiza zakończona.';
        let widgetData: any = null;

        const calls = mathPresenterRes.functionCalls;
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
                logs.push(`🎨 UI Wykres ${args.chartType}: "${args.title}" (${(args.labels||[]).length} kategorii)`);
            } else if (call.name === 'renderTableWidget') {
                widgetData = {
                    type: 'table',
                    title: args.title || activeTool.name,
                    columns: args.columns || [],
                    rows: args.rows || []
                };
                logs.push(`🎨 UI Tabela: "${args.title}" (${(args.rows||[]).length} wierszy)`);
            } else if (call.name === 'renderKpiWidget') {
                widgetData = {
                    type: 'kpi',
                    title: args.title || activeTool.name,
                    metrics: args.metrics || []
                };
                logs.push(`🎨 UI KPI: "${args.title}" (${(args.metrics||[]).length} wskaźników)`);
            }
        } else {
            // Fallback — tekst z Python output
            const textParts = mathParts.map((p: any) => p.text || '').filter(Boolean).join('\n');
            finalReply = textParts.split('PODSUMOWANIE')[1]?.trim() || textParts || pythonOutput || 'Oto wyniki analizy.';
            logs.push(`🎨 UI Brak wywołania narzędzia — odpowiedź tekstowa.`);
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
        console.error('Błąd Orchestratora v10.0:', err);
        return NextResponse.json({
            error: 'Błąd przetwarzania wieloagentowego',
            detail: String(err?.message || err),
            logs
        }, { status: 500 });
    }
}
