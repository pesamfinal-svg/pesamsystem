// src/app/api/ai-warehouse-agent/route.ts
// =============================================================================
// PESAM Multi-Agent Orchestrator v6.0
//
// Pipeline Agentów:
//  Agent 1: Orchestrator / Dyspozytor (gemini-2.5-flash-lite)
//           -> Rozpoznaje czy to zwykła rozmowa czy zapytanie analityczne
//  Agent 2: Strateg Danych (Dynamic Query & Tool Builder, gemini-2.5-flash-lite)
//           -> Dynamicznie generuje plan zapytań do Firestore (dowolna kolekcja)
//           -> Pobiera dane z Firestore Admin SDK
//  Agent 3: Matematyk / Data Scientist (gemini-2.5-flash + Python Sandbox codeExecution)
//           -> Sam pisze kod w Pythonie, wykonuje w piaskownicy Vertex AI
//           -> 100% bezbłędne liczenie sum, średnich, grupowania, rotacji
//  Agent 4: Prezenter UI (Chart / Table / KPI Builder, gemini-2.5-flash-lite)
//           -> Dobiera widget: wykres słupkowy (bar), kołowy (pie), liniowy (line),
//              tabelę danych lub kafelki KPI dla interfejsu czatu
// =============================================================================

import { NextResponse } from 'next/server';
import { GoogleGenAI, Type } from '@google/genai';
import { adminDb, adminAuth } from '@/lib/firebase/admin';
import { Timestamp } from 'firebase-admin/firestore';

const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || 'pesam-system-81165',
    location: 'global'
});

export const maxDuration = 60;

// ─── SCHEMAT BAZY DANYCH DLA AGENTÓW ─────────────────────────────────────────
const DB_SCHEMA = `
PESAM — Schemat bazy danych Firestore:

1. KOLEKCJA "residuals" (resztki budowlane na placu i w magazynach):
   - id: string
   - name: string (nazwa materiału, np. "Klej Atlas Plus", "Bloczek 590x120")
   - quantity: number (ilość)
   - unit: string (jednostka, np. "szt.", "op.", "paleta", "m2", "mb")
   - category: string ("kleje"|"pustaki"|"plyty-gk"|"farby-chemia"|"pianki-silikony"|
               "kable-elektryka"|"gipsy-gladzie"|"izolacje-folie"|"szalunki"|"stal-ogrodzenia"|
               "rury-kanalizacja"|"drewno-odpady")
   - subcategory: string
   - storageZone: string (strefa składowania, np. "Plac Zewnętrzny", "Magazyn Farb i Chemii", "Hala rozsuwana")
   - updatedAt: Timestamp (data ostatniej modyfikacji / ruchu resztki)
   - siteId: string (budowa źródłowa)

2. KOLEKCJA "inventory" (sprzęt, elektronarzędzia, maszyny):
   - id: string
   - name: string (np. "Młot udarowy Bosch", "Rusztowanie Plettac")
   - category: string
   - quantity: number
   - unit: string
   - location: string

3. KOLEKCJA "vehicles" (flota samochodowa):
   - id: string
   - brand: string (np. "Iveco", "Ford", "Renault")
   - model: string (np. "Daily", "Transit", "Master")
   - registration: string (np. "RDE HF31")
   - initialMileage: number

4. KOLEKCJA "repairs" (naprawy i serwis aut):
   - id: string
   - vehicleId: string (FK do vehicles.id)
   - date: string (format YYYY-MM-DD)
   - cost: number (koszt w PLN netto)
   - category: string ("Mechaniczna"|"Silnik"|"Układ hamulcowy"|"Zawieszenie"|
               "Elektryczna"|"Klimatyzacja"|"Opony"|"Eksploatacyjna"|"Blacharsko-Lakiernicza"|"Przeglądy"|"Inne")
   - mileage: number (przebieg przy naprawie)
   - comments: string (opis naprawy / usterki)
   - location: string (warsztat)
   - partsList: string[] (lista części)

5. KOLEKCJA "orders" (zamówienia z budów):
   - id: string
   - status: string ("pending"|"completed"|"cancelled")
   - createdAt: Timestamp
   - items: array
   - siteId: string

6. KOLEKCJA "sites" (budowy):
   - id: string
   - name: string
   - address: string
   - status: string ("active"|"closed")
`;

// ─── RETRY FUNCTION Z EXPONENTIAL BACKOFF ────────────────────────────────────
async function generateContentWithRetry(params: any, retries = 3, delay = 1000): Promise<any> {
    try {
        return await ai.models.generateContent(params);
    } catch (error: any) {
        const isRateLimit =
            error?.message?.includes('429') ||
            error?.message?.includes('RESOURCE_EXHAUSTED') ||
            error?.status === 429;

        if (isRateLimit && retries > 0) {
            await new Promise(res => setTimeout(res, delay));
            return generateContentWithRetry(params, retries - 1, delay * 2);
        }
        throw error;
    }
}

// ─── SCHEMATY JSON DLA AGENTÓW ───────────────────────────────────────────────

// Agent 1: Dyspozytor
const DISPATCHER_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        isAnalysis: {
            type: Type.BOOLEAN,
            description: 'true = użytkownik pyta o dane, raporty, stany magazynu, resztki, flotę, koszty, budowy; false = zwykłe powitanie, rozmowa ogólna, kim jesteś'
        },
        conversationalReply: {
            type: Type.STRING,
            description: 'Uprzejma, pomocna odpowiedź gdy isAnalysis=false (po polsku).'
        },
        intentDescription: {
            type: Type.STRING,
            description: 'Krótki opis intencji analitycznej (np. "Podsumowanie resztek bez ruchu >30 dni z podziałem na strefy").'
        }
    },
    required: ['isAnalysis']
};

// Agent 2: Strateg Danych (Dynamic Query Planner)
const QUERY_PLAN_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        needsResiduals: { type: Type.BOOLEAN, description: 'Czy potrzebne są dane o resztkach budowlanych' },
        residualsCategory: { type: Type.STRING, description: 'Filtr kategorii resztek, puste jeśli wszystkie' },
        residualsStorageZone: { type: Type.STRING, description: 'Filtr strefy składowania, puste jeśli wszystkie' },
        residualsLimit: { type: Type.NUMBER, description: 'Limit pobieranych resztek (domyślnie 150, max 300)' },

        needsInventory: { type: Type.BOOLEAN, description: 'Czy potrzebne są dane o sprzęcie/narzędziach' },
        inventoryCategory: { type: Type.STRING, description: 'Filtr kategorii sprzętu' },
        inventoryLimit: { type: Type.NUMBER, description: 'Limit sprzętu (domyślnie 100)' },

        needsVehicles: { type: Type.BOOLEAN, description: 'Czy potrzebne są pojazdy floty' },
        vehicleBrand: { type: Type.STRING, description: 'Marka auta, np. "Iveco"' },
        vehicleRegistration: { type: Type.STRING, description: 'Nr rejestracyjny' },

        needsRepairs: { type: Type.BOOLEAN, description: 'Czy potrzebne są naprawy pojazdów' },
        repairsDateFrom: { type: Type.STRING, description: 'Data od YYYY-MM-DD' },
        repairsDateTo: { type: Type.STRING, description: 'Data do YYYY-MM-DD' },
        repairsCategory: { type: Type.STRING, description: 'Kategoria naprawy' },
        repairsLimit: { type: Type.NUMBER, description: 'Limit napraw (domyślnie 200)' },

        needsOrders: { type: Type.BOOLEAN, description: 'Czy potrzebne są zamówienia' },
        ordersStatus: { type: Type.STRING, description: 'Status zamówień (pending/completed)' },

        needsSites: { type: Type.BOOLEAN, description: 'Czy potrzebne są budowy' },

        analyticalGoal: {
            type: Type.STRING,
            description: 'Szczegółowy cel analityczny dla Agenta Pythona (co ma dokładnie wyliczyć, pogrupować, zsumować lub porównać).'
        },
        reasoning: {
            type: Type.STRING,
            description: 'Uzasadnienie doboru danych.'
        }
    },
    required: ['needsResiduals', 'needsVehicles', 'needsRepairs', 'analyticalGoal', 'reasoning']
};

// Agent 4: Narzędzia Prezentera UI
const TOOL_RENDER_CHART = {
    name: 'renderChartWidget',
    description: 'Wykres słupkowy (bar), kołowy (pie) lub liniowy (line). Użyj gdy pytanie dotyczy porównania kategorii, kosztów, udziałów procentowych lub trendów.',
    parameters: {
        type: Type.OBJECT,
        properties: {
            aiMessage: { type: Type.STRING, description: 'Czysty, profesjonalny tekst odpowiedzi do dymku czatu z podsumowaniem i wnioskami. BEZ KODU PYTHON!' },
            chartType: { type: Type.STRING, description: '"bar" | "pie" | "line"' },
            title: { type: Type.STRING, description: 'Tytuł wykresu' },
            datasetLabel: { type: Type.STRING, description: 'Etykieta serii, np. "Ilość sztuk" lub "Koszt netto (PLN)"' },
            labels: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Etykiety osi X lub segmentów koła' },
            values: { type: Type.ARRAY, items: { type: Type.NUMBER }, description: 'Wartości liczbowe' }
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
            aiMessage: { type: Type.STRING, description: 'Czysty tekst odpowiedzi z wnioskami do dymku czatu. BEZ KODU PYTHON!' },
            title: { type: Type.STRING, description: 'Tytuł tabeli' },
            columns: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Nazwy kolumn' },
            rows: {
                type: Type.ARRAY,
                items: { type: Type.ARRAY, items: { type: Type.STRING } },
                description: 'Wiersze tabeli'
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
            title: { type: Type.STRING, description: 'Tytuł sekcji wskaźników' },
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

// ─── POBIERANIE DANYCH Z FIRESTORE WG DYNAMICZNEGO PLANU ────────────────────
async function executeDynamicDataPlan(plan: any): Promise<{ data: Record<string, any>; collectionsUsed: string[] }> {
    const data: Record<string, any> = {};
    const collectionsUsed: string[] = [];
    const tasks: Promise<void>[] = [];

    // 1. Resztki budowlane
    if (plan.needsResiduals) {
        tasks.push((async () => {
            let q = adminDb.collection('residuals').limit(plan.residualsLimit || 150);
            if (plan.residualsCategory) {
                q = q.where('category', '==', plan.residualsCategory) as typeof q;
            }
            if (plan.residualsStorageZone) {
                q = q.where('storageZone', '==', plan.residualsStorageZone) as typeof q;
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
    if (plan.needsInventory) {
        tasks.push((async () => {
            let q = adminDb.collection('inventory').limit(plan.inventoryLimit || 100);
            if (plan.inventoryCategory) {
                q = q.where('category', '==', plan.inventoryCategory) as typeof q;
            }
            const snap = await q.get();
            data.inventory = snap.docs.map(doc => {
                const d = doc.data();
                return {
                    id: doc.id,
                    name: d.name,
                    category: d.category,
                    quantity: Number(d.quantity) || 0,
                    unit: d.unit || 'szt.',
                    location: d.location || ''
                };
            });
            collectionsUsed.push('inventory');
        })());
    }

    // 3. Pojazdy
    if (plan.needsVehicles || plan.needsRepairs) {
        tasks.push((async () => {
            const snap = await adminDb.collection('vehicles').get();
            let vehicles = snap.docs.map(doc => {
                const d = doc.data();
                return {
                    id: doc.id,
                    brand: d.brand || '',
                    model: d.model || '',
                    registration: d.registration || '',
                    initialMileage: Number(d.initialMileage) || 0
                };
            });
            if (plan.vehicleBrand) {
                vehicles = vehicles.filter(v => v.brand.toLowerCase().includes(plan.vehicleBrand.toLowerCase()));
            }
            if (plan.vehicleRegistration) {
                vehicles = vehicles.filter(v => v.registration.toLowerCase().includes(plan.vehicleRegistration.toLowerCase()));
            }
            data.vehicles = vehicles;
            collectionsUsed.push('vehicles');
        })());
    }

    // 4. Naprawy pojazdów
    if (plan.needsRepairs) {
        tasks.push((async () => {
            let q = adminDb.collection('repairs').limit(plan.repairsLimit || 200);
            if (plan.repairsCategory) {
                q = q.where('category', '==', plan.repairsCategory) as typeof q;
            }
            const snap = await q.get();
            let repairs = snap.docs.map(doc => {
                const d = doc.data();
                return {
                    id: doc.id,
                    vehicleId: d.vehicleId,
                    date: d.date || '',
                    cost: Number(d.cost) || 0,
                    category: d.category || 'Inne',
                    mileage: Number(d.mileage) || 0,
                    comments: d.comments || '',
                    location: d.location || ''
                };
            });
            if (plan.repairsDateFrom) {
                repairs = repairs.filter(r => r.date >= plan.repairsDateFrom);
            }
            if (plan.repairsDateTo) {
                repairs = repairs.filter(r => r.date <= plan.repairsDateTo);
            }
            data.repairs = repairs;
            collectionsUsed.push('repairs');
        })());
    }

    // 5. Zamówienia
    if (plan.needsOrders) {
        tasks.push((async () => {
            let q = adminDb.collection('orders').limit(50);
            if (plan.ordersStatus) {
                q = q.where('status', '==', plan.ordersStatus) as typeof q;
            }
            const snap = await q.get();
            data.orders = snap.docs.map(doc => {
                const d = doc.data();
                return {
                    id: doc.id,
                    status: d.status,
                    createdAt: d.createdAt?.toDate?.() ? d.createdAt.toDate().toISOString().split('T')[0] : null,
                    itemCount: Array.isArray(d.items) ? d.items.length : 0,
                    siteId: d.siteId
                };
            });
            collectionsUsed.push('orders');
        })());
    }

    // 6. Budowy
    if (plan.needsSites) {
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
        // 1. Weryfikacja tokenu uwierzytelniania
        const authHeader = req.headers.get('Authorization');
        if (!authHeader?.startsWith('Bearer ')) {
            return NextResponse.json({ error: 'Brak autoryzacji' }, { status: 401 });
        }
        const token = authHeader.slice(7);
        const decoded = await adminAuth.verifyIdToken(token);

        // 2. Sprawdzenie uprawnień
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

        // =====================================================================
        // AGENT 1: ORCHESTRATOR / DYSPOZYTOR
        // =====================================================================
        logs.push('[Agent 1] Orchestrator: Analiza intencji zapytania...');

        const dispatcherRes = await generateContentWithRetry({
            model: 'gemini-2.5-flash-lite',
            contents: [{
                role: 'user',
                parts: [{
                    text: `Pytanie użytkownika systemu budowlano-magazynowego PESAM:
"${latestQuestion}"

Oceń czy to zapytanie analityczne o dane z magazynu/floty/budów, czy zwykła pogawędka/powitanie.`
                }]
            }],
            config: {
                systemInstruction: `Jesteś Orchestratorem PESAM. Jeśli pytanie to zwykłe "Cześć", "Dzień dobry", "Co potrafisz?", ustaw isAnalysis=false i odpowiedz przyjaźnie po polsku jako Asystent Magazynowy. Jeśli pytanie wymaga danych (resztki, materiały, magazyn, naprawy, auta, koszty, budowy), ustaw isAnalysis=true.`,
                temperature: 0.1,
                responseMimeType: 'application/json',
                responseSchema: DISPATCHER_SCHEMA
            }
        });

        let dispatcherData: any = { isAnalysis: true, intentDescription: latestQuestion };
        try {
            dispatcherData = JSON.parse(dispatcherRes.text?.replace(/```json|```/g, '').trim() || '{}');
        } catch {
            dispatcherData = { isAnalysis: true, intentDescription: latestQuestion };
        }

        if (!dispatcherData.isAnalysis && dispatcherData.conversationalReply) {
            logs.push('[Agent 1] Rozmowa ogólna -> Szybka odpowiedź konwersacyjna.');
            return NextResponse.json({
                reply: dispatcherData.conversationalReply,
                widget: null,
                logs
            });
        }

        // =====================================================================
        // AGENT 2: STRATEG DANYCH (Dynamic Tool & Query Planner)
        // =====================================================================
        logs.push('[Agent 2] Strateg Danych: Tworzenie dynamicznego planu zapytań...');

        const strategistPrompt = `
${DB_SCHEMA}

Pytanie użytkownika: "${latestQuestion}"
Intencja: "${dispatcherData.intentDescription || latestQuestion}"
Dzisiejsza data: ${new Date().toISOString().split('T')[0]}

ZADANIE:
Zbuduj optymalny plan pobrania danych z Firestore, aby móc w 100% odpowiedzieć na to pytanie.
Zdefiniuj analyticalGoal z instrukcją dla Agenta Pythona — co ma dokładnie policzyć, zsumować, pogrupować lub posortować.
`;

        const strategistRes = await generateContentWithRetry({
            model: 'gemini-2.5-flash-lite',
            contents: [{ role: 'user', parts: [{ text: strategistPrompt }] }],
            config: {
                systemInstruction: `Jesteś Inżynierem i Strategiem Danych PESAM. Dobierasz kolekcje i filtry z bazy. Ustaw reasoning oraz precyzyjny analyticalGoal.`,
                temperature: 0.0,
                responseMimeType: 'application/json',
                responseSchema: QUERY_PLAN_SCHEMA
            }
        });

        let queryPlan: any = {};
        try {
            queryPlan = JSON.parse(strategistRes.text?.replace(/```json|```/g, '').trim() || '{}');
        } catch {
            queryPlan = {
                needsResiduals: true,
                needsVehicles: false,
                needsRepairs: false,
                analyticalGoal: 'Podsumuj dostępne resztki wg kategorii',
                reasoning: 'Fallback query plan'
            };
        }

        logs.push(`[Agent 2] Plan: ${queryPlan.reasoning || 'Pobieranie danych'}`);

        // Wykonanie planu zapytań do Firestore po stronie serwera
        const { data: dbData, collectionsUsed } = await executeDynamicDataPlan(queryPlan);
        logs.push(`[Firestore] Pobrano kolekcje: ${collectionsUsed.join(', ') || 'brak'}`);

        const totalRecords = Object.values(dbData).reduce((acc: number, arr: any) => acc + (Array.isArray(arr) ? arr.length : 0), 0);
        if (totalRecords === 0) {
            return NextResponse.json({
                reply: 'Nie znalazłem w bazie żadnych danych pasujących do podanych kryteriów.',
                widget: null,
                dataUsed: collectionsUsed,
                logs
            });
        }

        // =====================================================================
        // AGENT 3: MATEMATYK & DATA SCIENTIST (Python Code Execution)
        // =====================================================================
        logs.push('[Agent 3] Matematyk: Uruchamianie Python Sandbox (obliczenia bezbłędne)...');

        const mathPrompt = `
Pytanie użytkownika: "${latestQuestion}"
Cel analityczny: "${queryPlan.analyticalGoal}"
Dzisiejsza data: ${new Date().toISOString().split('T')[0]}

DANE POBRANE Z FIRESTORE (JSON):
${JSON.stringify(dbData)}

TWOJE ZADANIE:
1. Napisz kod w Pythonie, który przetworzy powyższe dane.
2. Policz precyzyjnie sumy, średnie, udziały procentowe, grupowania wg kategorii, stref lub pojazdów.
3. Jeśli pytanie dotyczy rotacji (>30 dni bez ruchu), porównaj pole 'updatedAt' lub 'updatedAtMillis' z dzisiejszą datą (${Date.now()} ms).
4. Wypisz wyniki na stdout w czytelnym formacie z etykietami.
5. Na końcu wypisz sekcję:
PODSUMOWANIE DLA KIEROWNIKA:
(2-3 konkretne wnioski biznesowe po polsku: co mamy za dużo, co zalega, jakie są największe koszty)
`;

        const mathRes = await generateContentWithRetry({
            model: 'gemini-2.5-flash',
            contents: [{ role: 'user', parts: [{ text: mathPrompt }] }],
            config: {
                systemInstruction: `Jesteś Matematykiem i Analitykiem Danych w firmie budowlanej PESAM. Piszesz kod w Pythonie, aby wykonać 100% precyzyjne obliczenia. Zero halucynacji matematycznych.`,
                temperature: 0.0,
                tools: [{ codeExecution: {} }]
            }
        });

        const mathParts = mathRes.candidates?.[0]?.content?.parts || [];
        const mathOutput = mathParts
            .map((p: any) => {
                if (p.text) return p.text;
                if (p.codeExecutionResult?.output) return p.codeExecutionResult.output;
                return '';
            })
            .filter(Boolean)
            .join('\n') || 'Obliczenia zakończone.';

        const pythonRan = mathParts.some((p: any) => p.executableCode || p.codeExecutionResult);
        logs.push(pythonRan ? '[Agent 3] ✓ Kod Python wykonany pomyślnie w sandboxie' : '[Agent 3] Wyniki kalkulacji gotowe');

        // =====================================================================
        // AGENT 4: ARCHITEKT PREZENTACJI (UI Widget & Chart Builder)
        // =====================================================================
        logs.push('[Agent 4] Prezenter UI: Przygotowanie widgetu wykresu / tabeli...');

        const presenterPrompt = `
Pytanie użytkownika: "${latestQuestion}"

OBLICZENIA Z SANDBOXA PYTHON:
${mathOutput}

ZADANIE:
Wybierz JEDNO narzędzie i przygotuj dane wizualne:
1. renderChartWidget -> Jeśli pytanie dotyczy porównania (np. ilości wg kategorii, koszty wg aut/kategorii, strefy). Wybierz chartType: "bar" (słupki) lub "pie" (koło) lub "line" (trendy).
2. renderTableWidget -> Jeśli to lista konkretnych pozycji (np. lista zalegających resztek z nazwami, ilościami, datami).
3. renderKpiWidget -> Jeśli to 1-3 kluczowe liczby sumaryczne.

WAŻNE DLA aiMessage:
Napisz w 'aiMessage' zwięzłą, uprzejmą odpowiedź po polsku dla użytkownika czatu (2-4 zdania).
Wytłumacz wprost wnioski (np. "W magazynie zalega łącznie 8 pozycji pustaków i bloczków bez ruchu od ponad 30 dni...").
NIGDY NIE UMIESZCZAJ W aiMessage KODU PYTHONA ANI SUROWEGO WYJŚCIA KONSOLI!
`;

        const presenterRes = await generateContentWithRetry({
            model: 'gemini-2.5-flash-lite',
            contents: [{ role: 'user', parts: [{ text: presenterPrompt }] }],
            config: {
                systemInstruction: `Jesteś Architektem Interfejsu PESAM. Zawsze wywołaj jedno z narzędzi wizualnych (renderChartWidget, renderTableWidget lub renderKpiWidget). Parametr aiMessage musi być czystym tekstem po polsku.`,
                temperature: 0.0,
                tools: [{ functionDeclarations: [TOOL_RENDER_CHART, TOOL_RENDER_TABLE, TOOL_RENDER_KPI] }]
            }
        });

        let finalReply = 'Analiza danych zakończona.';
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
                    title: args.title || 'Zestawienie',
                    datasetLabel: args.datasetLabel || 'Wartość',
                    labels: args.labels || [],
                    values: args.values || []
                };
                logs.push(`[Agent 4] ✓ Wygenerowano wykres "${widgetData.title}" (${widgetData.chartType})`);
            } else if (call.name === 'renderTableWidget') {
                widgetData = {
                    type: 'table',
                    title: args.title || 'Tabela danych',
                    columns: args.columns || [],
                    rows: args.rows || []
                };
                logs.push(`[Agent 4] ✓ Wygenerowano tabelę "${widgetData.title}" (${widgetData.rows.length} wierszy)`);
            } else if (call.name === 'renderKpiWidget') {
                widgetData = {
                    type: 'kpi',
                    title: args.title || 'Kluczowe wskaźniki',
                    metrics: args.metrics || []
                };
                logs.push(`[Agent 4] ✓ Wygenerowano kafelki KPI`);
            }
        } else {
            // Fallback tekstu jeśli model nie wywołał funkcji UI
            finalReply = presenterRes.text || mathOutput.split('PODSUMOWANIE DLA KIEROWNIKA:')[1]?.trim() || 'Oto wyniki analizy magazynowej.';
        }

        return NextResponse.json({
            reply: finalReply,
            widget: widgetData,
            pythonExecuted: pythonRan,
            dataUsed: collectionsUsed,
            logs
        });

    } catch (err: any) {
        console.error('Błąd Multi-Agent Orchestratora:', err);
        return NextResponse.json({
            error: 'Błąd przetwarzania wieloagentowego',
            detail: String(err?.message || err),
            logs
        }, { status: 500 });
    }
}
