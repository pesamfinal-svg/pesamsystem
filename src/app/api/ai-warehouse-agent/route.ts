// src/app/api/ai-warehouse-agent/route.ts
// =============================================================================
// PESAM Self-Growing Multi-Agent Orchestrator v7.0
//
// Architektura Wieloagentowa z Rejestrem Narzędzi (Self-Growing Tool Registry):
//
// 1. Rejestr "ai_tools" w Firestore:
//    - Trwała baza nauczonych narzędzi AI (kod Pythona, plany zapytań, widgety)
// 2. Agent 1: Orchestrator / Główny Mózg (gemini-2.5-pro / gemini-2.5-flash)
//    - Posiada wstrzyknięty słownik danych (DB_SCHEMA) i listę istniejących toolsów
//    - Decyduje: SZYBKA ŚCIEŻKA (istniejące narzędzie) vs ŚCIEŻKA NAUKI (tworzy nowy tool)
// 3. Agent 2: Inżynier Danych (gemini-2.5-flash)
//    - Posiada instrukcję obsługi zapytań Firestore SDK (where, limit, daty, relacje)
//    - Pobiera z bazy optymalny zestaw rekordów po stronie serwera
// 4. Agent 3: Programista Narzędzi & Zapis do Firestore:
//    - Zapisuje nowo stworzone narzędzie do kolekcji 'ai_tools' na przyszłość
// 5. Agent 4: Matematyk & Data Scientist (gemini-2.5-flash + Python Sandbox codeExecution)
//    - 100% precyzyjne obliczenia matematyczne w piaskownicy Pythona Google
// 6. Agent 5: Prezenter UI (gemini-2.5-flash-lite)
//    - Formatuje wynik: wykres słupkowy (bar), kołowy (pie), liniowy (line), tabela lub KPI
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

// Modele dla poszczególnych ról
const ORCHESTRATOR_MODEL = 'gemini-2.5-pro';
const ORCHESTRATOR_FALLBACK = 'gemini-2.5-flash';
const DATA_ENGINEER_MODEL = 'gemini-2.5-flash';
const MATH_MODEL = 'gemini-2.5-flash';
const PRESENTER_MODEL = 'gemini-2.5-flash-lite';

// ─── SŁOWNIK BAZY DANYCH (Wstrzykiwany Mózgowi i Inżynierowi Danych) ─────────
const DB_SCHEMA = `
PESAM — SŁOWNIK BAZY DANYCH (FIRESTORE DATA DICTIONARY):

1. KOLEKCJA "residuals" (Resztki budowlane na placu i magazynach):
   - id: string
   - name: string (np. "Klej Atlas Plus 25kg", "Bloczek betonowy 590x120x239")
   - quantity: number (ilość na stanie)
   - unit: string (np. "szt.", "op.", "paleta", "m2", "mb")
   - category: string ("kleje"|"pustaki"|"plyty-gk"|"farby-chemia"|"pianki-silikony"|
               "kable-elektryka"|"gipsy-gladzie"|"izolacje-folie"|"szalunki"|"stal-ogrodzenia"|
               "rury-kanalizacja"|"drewno-odpady")
   - subcategory: string
   - storageZone: string (strefa składowania: "Plac Zewnętrzny"|"Magazyn Farb i Chemii"|"Hala rozsuwana"|"Regał na stal"|"Wiata otwarta"|"Spawalnia")
   - updatedAt: Timestamp (data ostatniego ruchu / inwentaryzacji resztki)
   - siteId: string (budowa źródłowa zwrotu)

2. KOLEKCJA "inventory" (Katalog sprzętu, elektronarzędzi i maszyn):
   - id: string
   - name: string (np. "Zagęszczarka Wacker Neuson", "Wkrętarka Makita DDF484")
   - category: string
   - quantity: number
   - unit: string
   - location: string

3. KOLEKCJA "vehicles" (Flota samochodowa firmy):
   - id: string
   - brand: string (np. "Iveco", "Ford", "Renault", "Mercedes")
   - model: string (np. "Daily", "Transit", "Master", "Sprinter")
   - registration: string (np. "RDE HF31", "RDE 4522A")
   - initialMileage: number (przebieg początkowy w km)

4. KOLEKCJA "repairs" (Książka serwisowa i historia napraw pojazdów):
   - id: string
   - vehicleId: string (FK do vehicles.id)
   - date: string (format ISO YYYY-MM-DD, np. "2024-03-15")
   - cost: number (koszt naprawy w PLN netto)
   - category: string ("Mechaniczna"|"Silnik"|"Układ hamulcowy"|"Zawieszenie"|
               "Elektryczna"|"Klimatyzacja"|"Opony"|"Eksploatacyjna"|"Blacharsko-Lakiernicza"|"Przeglądy"|"Inne")
   - mileage: number (przebieg licznika w momencie naprawy)
   - comments: string (opis usterki i wykonanych prac)
   - location: string (nazwa warsztatu / mechanika)
   - partsList: string[] (lista wymienionych części)

5. KOLEKCJA "orders" (Zamówienia zapotrzebowania z budów):
   - id: string
   - status: string ("pending"|"completed"|"cancelled")
   - createdAt: Timestamp
   - items: array (pozycje zamówione)
   - siteId: string

6. KOLEKCJA "sites" (Budowy i obiekty PESAM):
   - id: string
   - name: string (np. "Hala Rzeszów", "Osiedle Słoneczne")
   - address: string
   - status: string ("active"|"closed")
`;

// ─── INSTRUKCJA OBSŁUGI ZAPYTAŃ FIRESTORE (DLA INŻYNIERA DANYCH) ─────────────
const FIRESTORE_QUERY_MANUAL = `
INSTRUKCJA ZAPYTAŃ FIRESTORE ADMIN SDK:
1. Filtry proste: używaj where('field', '==', value).
2. Filtry zakresowe: where('date', '>=', dateFrom) i where('date', '<=', dateTo) — dozwolone tylko na JEDNYM polu w zapytaniu.
3. Nigdy nie łącz filtrów nierówności (<, >, <=, >=) na dwóch różnych polach bez composite index.
4. Zawsze stosuj limit(n) [domyślnie 100-250], aby zapobiec przeciążeniu pamięci.
5. Post-filtering w Pythonie: Jeśli zapytanie wymaga wyszukiwania tekstu w komentarzach ('comments'), częściach ('partsList') lub zaawansowanych korelacji, pobierz szerszy zestaw po pojeździe lub dacie, a dokładne filtrowanie powierz Pythonowi.
`;

// ─── FUNKCJA RETRY Z EXPONENTIAL BACKOFF ─────────────────────────────────────
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

// Schemat decyzji Orchestratora
const ORCHESTRATOR_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        isAnalysis: {
            type: Type.BOOLEAN,
            description: 'true = użytkownik pyta o dane, raporty, magazyn, resztki, flotę, koszty, budowy; false = zwykłe powitanie, rozmowa ogólna, kim jesteś'
        },
        conversationalReply: {
            type: Type.STRING,
            description: 'Uprzejma, pomocna odpowiedź gdy isAnalysis=false (po polsku).'
        },
        toolAction: {
            type: Type.STRING,
            description: '"USE_EXISTING" jeśli zapytanie pasuje do jednego z zarejestrowanych narzędzi z EXISTING_TOOLS; "CREATE_NEW" jeśli takiego narzędzia jeszcze nie ma i trzeba je wytworzyć.',
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
                id: { type: Type.STRING, description: 'Slug w snake_case, np. "fleet_cost_per_vehicle", "residual_stock_by_zone"' },
                name: { type: Type.STRING, description: 'Zwięzła polska nazwa narzędzia, np. "Koszty napraw aut w podziale na pojazdy"' },
                description: { type: Type.STRING, description: 'Opis co narzędzie liczy i kiedy go używać' },
                analyticalGoal: { type: Type.STRING, description: 'Dokładny cel wyliczeń dla Agenta Pythona' },
                preferredWidget: { type: Type.STRING, description: '"chart" | "table" | "kpi"' },
                chartType: { type: Type.STRING, description: '"bar" | "pie" | "line"' }
            }
        },
        dataRequirements: {
            type: Type.OBJECT,
            description: 'Instrukcje dla Inżyniera Danych — jakie dane pobrać z Firestore',
            properties: {
                needsResiduals: { type: Type.BOOLEAN },
                residualsCategory: { type: Type.STRING },
                residualsStorageZone: { type: Type.STRING },
                residualsLimit: { type: Type.NUMBER },
                needsInventory: { type: Type.BOOLEAN },
                inventoryCategory: { type: Type.STRING },
                needsVehicles: { type: Type.BOOLEAN },
                vehicleBrand: { type: Type.STRING },
                vehicleRegistration: { type: Type.STRING },
                needsRepairs: { type: Type.BOOLEAN },
                repairsDateFrom: { type: Type.STRING },
                repairsDateTo: { type: Type.STRING },
                repairsCategory: { type: Type.STRING },
                repairsLimit: { type: Type.NUMBER },
                needsOrders: { type: Type.BOOLEAN },
                ordersStatus: { type: Type.STRING },
                needsSites: { type: Type.BOOLEAN },
                reasoning: { type: Type.STRING }
            }
        }
    },
    required: ['isAnalysis']
};

// Narzędzia Prezentera UI
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

// ─── AGENT 2: INŻYNIER DANYCH — POBIERANIE Z FIRESTORE ───────────────────────
async function fetchFirestoreData(reqs: any): Promise<{ data: Record<string, any>; collectionsUsed: string[] }> {
    const data: Record<string, any> = {};
    const collectionsUsed: string[] = [];
    const tasks: Promise<void>[] = [];

    // 1. Resztki budowlane
    if (reqs?.needsResiduals) {
        tasks.push((async () => {
            let q = adminDb.collection('residuals').limit(reqs.residualsLimit || 150);
            if (reqs.residualsCategory) {
                q = q.where('category', '==', reqs.residualsCategory) as typeof q;
            }
            if (reqs.residualsStorageZone) {
                q = q.where('storageZone', '==', reqs.residualsStorageZone) as typeof q;
            }
            const snap = await q.get();
            data.residuals = snap.docs.map(doc => {
                const d = doc.data();
                const ts = d.updatedAt as Timestamp | undefined;
                return {
                    id: doc.id,
                    name: d.name || 'Brak nazwy',
                    quantity: Number(d.quantity) || 0,
                    unit: d.unit || 'szt.',
                    category: d.category || 'inne',
                    subcategory: d.subcategory || '',
                    storageZone: d.storageZone || 'Nieokreślona',
                    updatedAt: ts?.toDate?.() ? ts.toDate().toISOString().split('T')[0] : null,
                    updatedAtMillis: ts?.toMillis?.() || null
                };
            });
            collectionsUsed.push('residuals');
        })());
    }

    // 2. Narzędzia i sprzęt
    if (reqs?.needsInventory) {
        tasks.push((async () => {
            let q = adminDb.collection('inventory').limit(reqs.inventoryLimit || 100);
            if (reqs.inventoryCategory) {
                q = q.where('category', '==', reqs.inventoryCategory) as typeof q;
            }
            const snap = await q.get();
            data.inventory = snap.docs.map(doc => ({
                id: doc.id,
                name: doc.data().name,
                category: doc.data().category,
                quantity: Number(doc.data().quantity) || 0,
                unit: doc.data().unit || 'szt.',
                location: doc.data().location || ''
            }));
            collectionsUsed.push('inventory');
        })());
    }

    // 3. Pojazdy
    if (reqs?.needsVehicles || reqs?.needsRepairs) {
        tasks.push((async () => {
            const snap = await adminDb.collection('vehicles').get();
            let vehicles = snap.docs.map(doc => ({
                id: doc.id,
                brand: doc.data().brand || '',
                model: doc.data().model || '',
                registration: doc.data().registration || '',
                initialMileage: Number(doc.data().initialMileage) || 0
            }));
            if (reqs.vehicleBrand) {
                vehicles = vehicles.filter(v => v.brand.toLowerCase().includes(reqs.vehicleBrand.toLowerCase()));
            }
            if (reqs.vehicleRegistration) {
                vehicles = vehicles.filter(v => v.registration.toLowerCase().includes(reqs.vehicleRegistration.toLowerCase()));
            }
            data.vehicles = vehicles;
            collectionsUsed.push('vehicles');
        })());
    }

    // 4. Naprawy pojazdów
    if (reqs?.needsRepairs) {
        tasks.push((async () => {
            let q = adminDb.collection('repairs').limit(reqs.repairsLimit || 200);
            if (reqs.repairsCategory) {
                q = q.where('category', '==', reqs.repairsCategory) as typeof q;
            }
            const snap = await q.get();
            let repairs = snap.docs.map(doc => ({
                id: doc.id,
                vehicleId: doc.data().vehicleId,
                date: doc.data().date || '',
                cost: Number(doc.data().cost) || 0,
                category: doc.data().category || 'Inne',
                mileage: Number(doc.data().mileage) || 0,
                comments: doc.data().comments || '',
                location: doc.data().location || ''
            }));
            if (reqs.repairsDateFrom) repairs = repairs.filter(r => r.date >= reqs.repairsDateFrom);
            if (reqs.repairsDateTo) repairs = repairs.filter(r => r.date <= reqs.repairsDateTo);
            data.repairs = repairs;
            collectionsUsed.push('repairs');
        })());
    }

    // 5. Zamówienia
    if (reqs?.needsOrders) {
        tasks.push((async () => {
            let q = adminDb.collection('orders').limit(50);
            if (reqs.ordersStatus) {
                q = q.where('status', '==', reqs.ordersStatus) as typeof q;
            }
            const snap = await q.get();
            data.orders = snap.docs.map(doc => ({
                id: doc.id,
                status: doc.data().status,
                createdAt: doc.data().createdAt?.toDate?.() ? doc.data().createdAt.toDate().toISOString().split('T')[0] : null,
                itemCount: Array.isArray(doc.data().items) ? doc.data().items.length : 0,
                siteId: doc.data().siteId
            }));
            collectionsUsed.push('orders');
        })());
    }

    // 6. Budowy
    if (reqs?.needsSites) {
        tasks.push((async () => {
            const snap = await adminDb.collection('sites').get();
            data.sites = snap.docs.map(doc => ({
                id: doc.id,
                name: doc.data().name,
                status: doc.data().status
            }));
            collectionsUsed.push('sites');
        })());
    }

    await Promise.all(tasks);
    return { data, collectionsUsed };
}

// ─── GŁÓWNY HANDLER POST ─────────────────────────────────────────────────────
export async function POST(req: Request) {
    const logs: string[] = [];

    try {
        // 1. Weryfikacja tożsamości użytkownika
        const authHeader = req.headers.get('Authorization');
        if (!authHeader?.startsWith('Bearer ')) {
            return NextResponse.json({ error: 'Brak autoryzacji' }, { status: 401 });
        }
        const token = authHeader.slice(7);
        const decoded = await adminAuth.verifyIdToken(token);

        // 2. Uprawnienia useChatAI
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

        // 4. Pobranie zarejestrowanych narzędzi z Firestore (ai_tools)
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
                dataRequirements: data.dataRequirements || {}
            };
        });

        const toolsSummary = existingToolsList.length > 0
            ? existingToolsList.map(t => `- [${t.id}] "${t.name}": ${t.description}`).join('\n')
            : '(Brak zarejestrowanych narzędzi — system wytworzy pierwsze narzędzie dla tego pytania)';

        // =====================================================================
        // AGENT 1: ORCHESTRATOR / GŁÓWNY MÓZG
        // =====================================================================
        logs.push(`[Agent 1: Orchestrator] Analiza zapytania (Model: ${ORCHESTRATOR_MODEL})...`);

        const orchestratorPrompt = `
${DB_SCHEMA}

${FIRESTORE_QUERY_MANUAL}

ZAREJESTROWANE NARZĘDZIA W BAZIE FIRESTORE (ai_tools):
${toolsSummary}

Pytanie użytkownika: "${latestQuestion}"
Dzisiejsza data: ${new Date().toISOString().split('T')[0]}

ZADANIE DLA ORCHESTRATORA:
1. Jeśli to zwykłe powitanie/rozmowa ogólna -> isAnalysis=false, conversationalReply="...".
2. Jeśli to zapytanie analityczne:
   a) Sprawdź, czy któreś narzędzie z ZAREJESTROWANYCH NARZĘDZI pasuje:
      - Jeśli TAK: ustaw toolAction="USE_EXISTING" oraz matchedToolId na ID pasującego narzędzia.
      - Jeśli NIE: ustaw toolAction="CREATE_NEW" i zdefiniuj newToolDefinition (slug, czytelna nazwa, opis, analyticalGoal dla Pythona) oraz dataRequirements dla Inżyniera Danych.
`;

        let orchestratorRes: any;
        try {
            orchestratorRes = await runWithRetry({
                model: ORCHESTRATOR_MODEL,
                contents: [{ role: 'user', parts: [{ text: orchestratorPrompt }] }],
                config: {
                    systemInstruction: `Jesteś Głównym Architektem i Orchestratorem PESAM. Masz przed sobą schemat bazy i rejestr narzędzi. Decydujesz czy użyć gotowego narzędzia, czy utworzyć nowe.`,
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
                    systemInstruction: `Jesteś Głównym Architektem PESAM. Decydujesz czy użyć gotowego narzędzia, czy utworzyć nowe.`,
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
        let dataRequirements: any = plan.dataRequirements || {};
        let analyticalGoal: string = '';

        if (plan.toolAction === 'USE_EXISTING' && plan.matchedToolId) {
            activeTool = existingToolsList.find(t => t.id === plan.matchedToolId);
            if (activeTool) {
                logs.push(`[Rejestr ai_tools] ⚡ Błyskawiczne dopasowanie: "${activeTool.name}" [${activeTool.id}]`);
                analyticalGoal = activeTool.analyticalGoal;
                dataRequirements = { ...activeTool.dataRequirements, ...(plan.dataRequirements || {}) };
            }
        }

        if (!activeTool) {
            isToolNew = true;
            const newDef = plan.newToolDefinition || {
                id: `tool_${Date.now()}`,
                name: 'Nowa analiza magazynowa',
                description: latestQuestion,
                analyticalGoal: latestQuestion,
                preferredWidget: 'chart',
                chartType: 'bar'
            };
            activeTool = { ...newDef, dataRequirements };
            analyticalGoal = newDef.analyticalGoal || latestQuestion;
            logs.push(`[Rejestr ai_tools] 🎓 Tworzenie nowej umiejętności: "${activeTool.name}"`);
        }

        // =====================================================================
        // AGENT 2: INŻYNIER DANYCH — POBIERANIE REKORDÓW Z FIRESTORE
        // =====================================================================
        logs.push(`[Agent 2: Inżynier Danych] Pobieranie danych z Firestore wg instrukcji...`);
        const { data: dbData, collectionsUsed } = await fetchFirestoreData(dataRequirements);
        logs.push(`[Firestore] Pobrane kolekcje: ${collectionsUsed.join(', ') || 'brak'}`);

        const totalRecords = Object.values(dbData).reduce((acc: number, arr: any) => acc + (Array.isArray(arr) ? arr.length : 0), 0);
        if (totalRecords === 0) {
            return NextResponse.json({
                reply: 'W systemie nie znaleziono rekordów odpowiadających podanym kryteriom filtrowania.',
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

DANE WEJŚCIOWE Z FIRESTORE (JSON):
${JSON.stringify(dbData)}

TWOJE ZADANIE:
1. Napisz i uruchom kod w Pythonie, który przetworzy powyższe dane.
2. Wykonaj 100% precyzyjne operacje matematyczne (sumy, średnie, grupowania, sortowania, rotacja >30 dni).
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
                    analyticalGoal: activeTool.analyticalGoal || '',
                    preferredWidget: activeTool.preferredWidget || 'chart',
                    chartType: activeTool.chartType || 'bar',
                    dataRequirements,
                    createdAt: new Date().toISOString(),
                    lastUsedAt: new Date().toISOString(),
                    usageCount: 1
                }, { merge: true });
                logs.push(`[ai_tools] 💾 Zapisano nowe narzędzie "${activeTool.name}" do bazy Firestore!`);
            } catch (saveErr) {
                console.error('Błąd zapisu do ai_tools:', saveErr);
            }
        } else if (activeTool.id) {
            // Inkrementacja licznika użyć
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
2. renderTableWidget -> jeśli to szczegółowa lista z wieloma wierszami.
3. renderKpiWidget -> jeśli to 1-3 kluczowe liczby sumaryczne.

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
        console.error('Błąd Orchestratora v7.0:', err);
        return NextResponse.json({
            error: 'Błąd przetwarzania wieloagentowego',
            detail: String(err?.message || err),
            logs
        }, { status: 500 });
    }
}
