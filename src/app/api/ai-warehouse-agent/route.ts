// src/app/api/ai-warehouse-agent/route.ts
// =============================================================================
// PESAM Autonomous Self-Learning Multi-Agent Orchestrator v9.0
//
// Dynamic Schema Discovery & Autonomous Agent Collaboration:
//
// 1. Dynamic Schema Introspection (Brak sztywnego schematu w kodzie!):
//    - adminDb.listCollections() + próbkowanie dokumentów w locie
//    - Automatycznie wykrywa każdą nową kolekcję, nowe pole i typ danych
// 2. Mózg / Orchestrator (gemini-2.5-pro z Google Vertex AI):
//    - Otrzymuje świeżo zbadany schemat bazy i rejestr ai_tools
//    - Zleca zadania specjalistycznym agentom
// 3. Inżynier Danych (Firestore Expert):
//    - Posiada kompletną wiedzę jak operować na Firestore SDK
//    - Zamienia zlecenia na bezpieczne, wydajne zapytania (where, limit, relacje)
// 4. Rejestr ai_tools w Firestore:
//    - Pamięć długoterminowa: zapisuje nowe narzędzia, by natychmiast użyć ich w przyszłości
// 5. Matematyk & Data Scientist (gemini-2.5-flash + Python Sandbox):
//    - 100% precyzji obliczeniowej w bezpiecznej piaskownicy Vertex AI
// 6. Prezenter UI (gemini-2.5-flash-lite):
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

// Modele Gemini na endpointzie Global w Google Cloud
const ORCHESTRATOR_MODEL = 'gemini-2.5-pro';
const ORCHESTRATOR_FALLBACK = 'gemini-2.5-flash';
const MATH_MODEL = 'gemini-2.5-flash';
const PRESENTER_MODEL = 'gemini-2.5-flash-lite';

// ─── 1. DYNAMICZNA INSPEKCJA SCHEMATU BAZY DANYCH (Live Discovery) ────────────
interface SchemaFieldInfo {
    type: string;
    sample: any;
}

interface CollectionSchema {
    collection: string;
    fields: Record<string, SchemaFieldInfo>;
}

// Pamięć podręczna schematu (TTL: 5 minut), aby nie badać bazy przy każdym zapytaniu
let cachedSchema: { timestamp: number; schema: Record<string, CollectionSchema> } | null = null;

async function getLiveDatabaseSchema(): Promise<Record<string, CollectionSchema>> {
    const now = Date.now();
    if (cachedSchema && (now - cachedSchema.timestamp < 300000)) {
        return cachedSchema.schema;
    }

    const KNOWN_COLLECTIONS = [
        'vehicles', 'repairs', 'inventory', 'sites', 'workers',
        'protocols', 'claims', 'pending_wz_items', 'roles', 'users', 'closeouts'
    ];

    try {
        let collectionRefs: FirebaseFirestore.CollectionReference[] = [];
        try {
            const cols = await adminDb.listCollections();
            collectionRefs = cols.filter(c => !c.id.startsWith('_') && c.id !== 'ai_tools');
        } catch (listErr) {
            console.warn('adminDb.listCollections() niedostępne, użycie sondowania znanych kolekcji:', listErr);
        }

        // Jeśli listCollections nie zwróciło kolekcji, sondujemy znane kolekcje
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

// ─── 2. INSTRUKCJA DLA AGENTA INŻYNIERA DANYCH (FIRESTORE EXPERT) ────────────
const FIRESTORE_ENGINEER_INSTRUCTION = `
JESTEŚ EKSPERTEM BAZY FIRESTORE (INŻYNIEREM DANYCH):
Twoja wiedza o zasadach Firestore:
1. Pobieranie danych:
   - Jeśli zapytanie dotyczy ogółu danych (np. "wszystkie auta", "stany magazynowe", "jakie mamy pojazdy"), tablica 'where' MUSI być pusta [].
   - Nie dodawaj filtrów jeśli użytkownik nie sprecyzował konkretnej wartości w pytaniu.
2. Filtrowanie 'where':
   - Używaj wyłącznie pól, które naprawdę istnieją w zbadanym schemacie bazy.
   - Dozwolone operatory: '==' (równość), '>=' i '<=' (zakresy dat/liczb).
   - Nie łącz filtrów nierówności na różnych polach bez composite index.
3. Wydajność:
   - Ustawiaj limit w granicach 100-350 dokumentów.
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

// ─── SCHEMATY JSON ───────────────────────────────────────────────────────────
const QUERY_STEP_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        collection: {
            type: Type.STRING,
            description: 'Nazwa kolekcji wykrytej w zbadanym schemacie bazy danych'
        },
        where: {
            type: Type.ARRAY,
            description: 'Filtry where. PUSTA TABLICA [] jeśli użytkownik pyta ogólnie o wszystkie rekordy (np. wszystkie auta, wszystkie naprawy, cały magazyn). Filtry dodawaj TYLKO gdy użytkownik wprost podał konkretną wartość (np. markę "Iveco" lub datę).',
            items: {
                type: Type.OBJECT,
                properties: {
                    field: { type: Type.STRING, description: 'Rzeczywista nazwa kolumny ze zbadanego schematu' },
                    op: { type: Type.STRING, enum: ['==', '>=', '<=', '>', '<'] },
                    value: { type: Type.STRING, description: 'Wartość filtra' }
                },
                required: ['field', 'op', 'value']
            }
        },
        limit: {
            type: Type.NUMBER,
            description: 'Limit rekordów (domyślnie 250, max 500)'
        }
    },
    required: ['collection']
};

const ORCHESTRATOR_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        isAnalysis: {
            type: Type.BOOLEAN,
            description: 'true = zapytanie o dane z bazy; false = zwykłe powitanie, rozmowa ogólna, kim jesteś'
        },
        conversationalReply: {
            type: Type.STRING,
            description: 'Odpowiedź gdy isAnalysis=false (po polsku)'
        },
        toolAction: {
            type: Type.STRING,
            description: '"USE_EXISTING" jeśli zapytanie pasuje do jednego z zarejestrowanych narzędzi z EXISTING_TOOLS; "CREATE_NEW" jeśli takiego narzędzia jeszcze nie ma w bazie.',
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
                id: { type: Type.STRING, description: 'Slug w snake_case, np. suma_kosztow_napraw' },
                name: { type: Type.STRING, description: 'Zwięzła polska nazwa narzędzia' },
                description: { type: Type.STRING, description: 'Opis działania narzędzia' },
                analyticalGoal: { type: Type.STRING, description: 'Dokładny cel wyliczeń dla Agenta Pythona' },
                preferredWidget: { type: Type.STRING, enum: ['chart', 'table', 'kpi'] },
                chartType: { type: Type.STRING, enum: ['bar', 'pie', 'line'] }
            }
        },
        queries: {
            type: Type.ARRAY,
            description: 'Zlecenie dla Inżyniera Danych: lista zapytań do wykonania na kolekcjach zbadanego schematu. Gdy isAnalysis=true, MUSI zawierać co najmniej 1 kolekcję (np. collection="repairs", where=[]).',
            items: QUERY_STEP_SCHEMA
        },
        analyticalGoal: {
            type: Type.STRING,
            description: 'Instrukcja obliczeniowa dla Agenta Matematyka'
        }
    },
    required: ['isAnalysis', 'toolAction', 'queries', 'analyticalGoal']
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
        logs.push(`[Inżynier Danych -> Firestore] Zapytanie do "${colName}" (${filterSummary}, limit=${limitVal})`);

        try {
            const snap = await q.get();
            logs.push(`[Inżynier Danych <- Firestore] Kolekcja "${colName}": pobrano ${snap.size} dokumentów`);

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
        logs.push(`[Użytkownik] "${latestQuestion}"`);

        // 4. DYNAMICZNA INSPEKCJA BAZY DANYCH (Odkrywanie schematu na żywo)
        logs.push(`[Introspection] Badanie struktury Firestore w czasie rzeczywistym...`);
        const liveSchema = await getLiveDatabaseSchema();
        const detectedCols = Object.keys(liveSchema);
        logs.push(`[Live Schema] Wykryto ${detectedCols.length} kolekcji: ${detectedCols.join(', ')}`);
        const liveSchemaPromptText = formatSchemaForPrompt(liveSchema);

        // 5. Pobranie biblioteki nauczonych narzędzi z Firestore (ai_tools)
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
        // AGENT 1: ORCHESTRATOR / GŁÓWNY MÓZG (gemini-2.5-pro)
        // =====================================================================
        logs.push(`[Mózg: Orchestrator] Analiza zapytania (Model: ${ORCHESTRATOR_MODEL})...`);

        const orchestratorPrompt = `
${liveSchemaPromptText}

${FIRESTORE_ENGINEER_INSTRUCTION}

ZAREJESTROWANE NARZĘDZIA W BAZIE FIRESTORE (ai_tools):
${toolsSummary}

Pytanie użytkownika: "${latestQuestion}"
Dzisiejsza data: ${new Date().toISOString().split('T')[0]}

ROLA ORCHESTRATORA:
1. Przeanalizuj pytanie użytkownika w kontekście zbadanej struktury bazy danych.
2. Zdecyduj czy to zwykła rozmowa (isAnalysis=false), czy zadanie na danych (isAnalysis=true).
3. JEŚLI isAnalysis=true (OBOWIĄZKOWE ZASADY):
   - Tablica 'queries' NIE MOŻE BYĆ PUSTA! Musisz wyznaczyć co najmniej 1 trafną kolekcję ze zbadanego schematu.
     * Pytania o naprawy / serwisy / koszty eksploatacji -> kolekcja 'repairs'
     * Pytania o samochody / flotę / auta / pojazdy -> kolekcja 'vehicles'
     * Pytania o magazyn / resztki / stan towaru / materiały -> kolekcja 'inventory'
     * Pytania o budowy / lokalizacje -> kolekcja 'sites'
     * Pytania o pracowników / monterów -> kolekcja 'workers'
   - PAMIĘTAJ: Jeśli użytkownik pyta OGÓLNIE (np. "ile wydaliśmy na naprawy", "jakie mamy auta", "co jest w magazynie"), tablica 'where' MUSI być pusta []! Nie filtruj daty ani typu na poziomie bazy, ponieważ Agent Matematyk w Pythonie przeliczy daty i kwoty z pełną precyzją.
   - Ustaw toolAction="CREATE_NEW" (lub "USE_EXISTING" jeśli zapytanie pasuje do narzędzia z ai_tools).
   - Wypełnij newToolDefinition (slug, czytelna nazwa, analyticalGoal).
`;

        let orchestratorRes: any;
        try {
            orchestratorRes = await runWithRetry({
                model: ORCHESTRATOR_MODEL,
                contents: [{ role: 'user', parts: [{ text: orchestratorPrompt }] }],
                config: {
                    systemInstruction: `Jesteś Głównym Mózgiem i Menedżerem PESAM. Otrzymujesz strukturę bazy danych odkrytą na żywo. Zlecasz zapytania do bazy Inżynierowi Danych. ZAWSZE wypełniaj 'queries' co najmniej jedną kolekcją ze schematu.`,
                    temperature: 0.1,
                    responseMimeType: 'application/json',
                    responseSchema: ORCHESTRATOR_SCHEMA
                }
            });
        } catch (err: any) {
            logs.push(`[Mózg: Błąd ${ORCHESTRATOR_MODEL}] ${err?.message || err}`);
            logs.push(`[Orchestrator Fallback] Przełączanie na ${ORCHESTRATOR_FALLBACK}...`);
            orchestratorRes = await runWithRetry({
                model: ORCHESTRATOR_FALLBACK,
                contents: [{ role: 'user', parts: [{ text: orchestratorPrompt }] }],
                config: {
                    systemInstruction: `Jesteś Głównym Mózgiem PESAM. Zlecasz zapytania do bazy na podstawie zbadanego schematu. ZAWSZE wypełniaj 'queries' co najmniej jedną trafną kolekcją ze schematu (np. repairs, vehicles, inventory).`,
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
                logs.push(`[ai_tools] ⚡ Błyskawiczne dopasowanie narzędzia: "${activeTool.name}" [${activeTool.id}]`);
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
            logs.push(`[ai_tools] 🎓 Tworzenie nowego narzędzia: "${activeTool.name}"`);
        }

        // ─── INTELIGENTNA SIATKA BEZPIECZEŃSTWA (Safety Net) ────────────────────────
        // Jeśli Mózg zwrócił pustą listę queries, na podstawie słów kluczowych zapytania
        // i zbadanego schematu automatycznie przypisujemy odpowiednią kolekcję.
        if (queriesToRun.length === 0 && plan.isAnalysis) {
            const qLower = latestQuestion.toLowerCase();
            const fallbackQueries: FirestoreQueryStep[] = [];

            if (qLower.includes('napraw') || qLower.includes('serwis') || qLower.includes('koszt') || qLower.includes('faktur')) {
                fallbackQueries.push({ collection: 'repairs', where: [] });
            }
            if (qLower.includes('samoch') || qLower.includes('aut') || qLower.includes('flot') || qLower.includes('pojazd')) {
                if (!fallbackQueries.some(q => q.collection === 'vehicles')) {
                    fallbackQueries.push({ collection: 'vehicles', where: [] });
                }
            }
            if (qLower.includes('magazyn') || qLower.includes('resztk') || qLower.includes('piank') || qLower.includes('klej') || qLower.includes('materiał') || qLower.includes('towar') || qLower.includes('stan') || qLower.includes('pozycj')) {
                if (!fallbackQueries.some(q => q.collection === 'inventory')) {
                    fallbackQueries.push({ collection: 'inventory', where: [] });
                }
            }
            if (qLower.includes('budow') || qLower.includes('budów') || qLower.includes('site') || qLower.includes('obiekt')) {
                if (!fallbackQueries.some(q => q.collection === 'sites')) {
                    fallbackQueries.push({ collection: 'sites', where: [] });
                }
            }
            if (qLower.includes('pracownik') || qLower.includes('ludzi') || qLower.includes('monter') || qLower.includes('brygadz')) {
                if (!fallbackQueries.some(q => q.collection === 'workers')) {
                    fallbackQueries.push({ collection: 'workers', where: [] });
                }
            }

            if (fallbackQueries.length > 0) {
                queriesToRun = fallbackQueries;
                activeTool.queries = queriesToRun;
                logs.push(`[Inżynier Danych] 🛡️ Inteligentna siatka bezpieczeństwa: automatycznie wyznaczono kolekcje [${queriesToRun.map(q => q.collection).join(', ')}] na podstawie zapytania.`);
            }
        }

        logs.push(`[Mózg: Decyzja] akcja=${plan.toolAction || 'NOWE'}, cel="${analyticalGoal}"`);

        // =====================================================================
        // AGENT 2: INŻYNIER DANYCH — POBIERANIE ZAPYTANIAMI DEKLARATYWNYMI
        // =====================================================================
        logs.push(`[Agent 2: Inżynier Danych] Rozpoczęcie wykonywania zapytań do Firestore...`);
        const { data: dbData, collectionsUsed } = await executeDataEngineQueries(queriesToRun, logs);

        const totalRecords = Object.values(dbData).reduce((acc: number, arr: any[]) => acc + (Array.isArray(arr) ? arr.length : 0), 0);
        logs.push(`[Inżynier Danych] Łącznie pobrano ${totalRecords} rekordów z bazy.`);

        if (totalRecords === 0) {
            logs.push(`[Orchestrator] ⚠️ Brak rekordów dla zapytania. Zakończono.`);
            return NextResponse.json({
                reply: `W systemie nie znaleziono rekordów odpowiadających podanemu zapytaniu (przeszukano: ${collectionsUsed.join(', ') || 'brak'}). Rozwiń podgląd procesu poniżej, aby zweryfikować filtry bazy danych.`,
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
        if (pythonRan) {
            logs.push(`[Matematyk] ✓ Kod Python wykonany pomyślnie. Wynik: ${mathOutput.slice(0, 200).replace(/\n/g, ' ')}...`);
        } else {
            logs.push(`[Matematyk] Obliczenia zakończone.`);
        }

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

        logs.push(`[Prezenter UI] Przygotowano wizualizację: ${widgetData ? `Widget ${widgetData.type} ("${widgetData.title}")` : 'Podsumowanie tekstowe'}`);

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
        console.error('Błąd Orchestratora v9.0:', err);
        return NextResponse.json({
            error: 'Błąd przetwarzania wieloagentowego',
            detail: String(err?.message || err),
            logs
        }, { status: 500 });
    }
}
