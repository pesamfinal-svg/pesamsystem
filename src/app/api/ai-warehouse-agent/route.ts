// src/app/api/ai-warehouse-agent/route.ts
// PESAM — Główny Agent Magazynowy (Gemini Function Calling)

import { NextResponse } from 'next/server';
import { GoogleGenAI, Type } from '@google/genai';
import type { Content, Tool } from '@google/genai';
import { adminDb, adminAuth } from '@/lib/firebase/admin';
import { Timestamp } from 'firebase-admin/firestore';

const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || 'pesam-system-81165',
    location: 'global'
});

export const maxDuration = 60;

// ─── SCHEMAT BAZY — wiedza agenta ────────────────────────────────────────────
const DB_SCHEMA = `
PESAM — System Zarządzania Magazynem Budowlanym. Schemat Firestore:

KOLEKCJA residuals (resztki budowlane):
  name(string), quantity(number), unit(string), category(string), subcategory(string),
  location(string), storageZone(string), updatedAt(Timestamp), siteId(string)
  KATEGORIE: kleje|pustaki|plyty-gk|farby-chemia|pianki-silikony|kable-elektryka|
             gipsy-gladzie|izolacje-folie|szalunki|stal-ogrodzenia|rury-kanalizacja|drewno-odpady

KOLEKCJA inventory (katalog sprzętu i narzędzi):
  name(string), category(string), quantity(number), unit(string), description(string), location(string)

KOLEKCJA orders (zamówienia materiałów):
  status(string: pending|completed|cancelled), createdAt(Timestamp), items(array), siteId(string)

KOLEKCJA sites (budowy):
  name(string), address(string), status(string: active|closed)

KOLEKCJA vehicles (pojazdy floty):
  brand(string), model(string), registration(string), initialMileage(number)

KOLEKCJA repairs (historia napraw pojazdów):
  vehicleId(string - FK do vehicles), date(string YYYY-MM-DD), cost(number PLN netto),
  category(string), mileage(number), comments(string), location(string/warsztat), partsList(string[])
  KATEGORIE NAPRAW: Mechaniczna|Silnik|Układ hamulcowy|Zawieszenie|Elektryczna|
                    Klimatyzacja|Opony|Eksploatacyjna|Blacharsko-Lakiernicza|Przeglądy
`;

// ─── DEFINICJE NARZĘDZI (Function Calling) ───────────────────────────────────
const TOOLS: Tool[] = [
    {
        functionDeclarations: [
            {
                name: 'query_residuals',
                description: 'Pobiera resztki budowlane z magazynu. Użyj gdy pytanie dotyczy stanu resztek, nadmiarów, kategorii materiałów, stref składowania.',
                parameters: {
                    type: Type.OBJECT,
                    properties: {
                        category: { type: Type.STRING, description: 'Filtr kategorii, np. "pianki-silikony", "pustaki". Puste = wszystkie.' },
                        storageZone: { type: Type.STRING, description: 'Filtr strefy, np. "Plac Zewnętrzny". Puste = wszystkie strefy.' },
                        minDaysWithoutMovement: { type: Type.NUMBER, description: 'Minimalna liczba dni bez ruchu (bez aktualizacji). Użyj gdy pytanie o "leżące", "bez ruchu", "zalegające".' },
                        limit: { type: Type.NUMBER, description: 'Limit wyników (domyślnie 50, max 200).' }
                    },
                    required: []
                }
            },
            {
                name: 'get_warehouse_summary',
                description: 'Zwraca podsumowanie statystyczne magazynu: ilości per kategoria, strefy. Użyj jako pierwsze zapytanie gdy pytanie jest ogólne.',
                parameters: {
                    type: Type.OBJECT,
                    properties: {},
                    required: []
                }
            },
            {
                name: 'query_inventory',
                description: 'Pobiera sprzęt i narzędzia z katalogu inventory.',
                parameters: {
                    type: Type.OBJECT,
                    properties: {
                        category: { type: Type.STRING, description: 'Kategoria sprzętu. Puste = wszystkie.' },
                        limit: { type: Type.NUMBER, description: 'Limit wyników.' }
                    },
                    required: []
                }
            },
            {
                name: 'query_vehicles_and_repairs',
                description: 'Pobiera pojazdy i ich historię napraw. Użyj gdy pytanie dotyczy floty, kosztów napraw, awarii, pojazdów.',
                parameters: {
                    type: Type.OBJECT,
                    properties: {
                        brand: { type: Type.STRING, description: 'Marka pojazdu, np. "Iveco", "Ford". Puste = wszystkie.' },
                        registration: { type: Type.STRING, description: 'Nr rejestracyjny. Puste = wszystkie.' },
                        dateFrom: { type: Type.STRING, description: 'Data od (YYYY-MM-DD).' },
                        dateTo: { type: Type.STRING, description: 'Data do (YYYY-MM-DD).' },
                        repairCategory: { type: Type.STRING, description: 'Kategoria naprawy.' }
                    },
                    required: []
                }
            },
            {
                name: 'query_orders',
                description: 'Pobiera zamówienia materiałów.',
                parameters: {
                    type: Type.OBJECT,
                    properties: {
                        status: { type: Type.STRING, description: 'Status: pending|completed|cancelled. Puste = wszystkie.' },
                        limit: { type: Type.NUMBER, description: 'Limit wyników.' }
                    },
                    required: []
                }
            },
            {
                name: 'query_sites',
                description: 'Pobiera listę budów.',
                parameters: {
                    type: Type.OBJECT,
                    properties: {
                        status: { type: Type.STRING, description: 'Status: active|closed. Puste = wszystkie.' }
                    },
                    required: []
                }
            }
        ]
    }
];

// ─── WYKONYWANIE NARZĘDZI ────────────────────────────────────────────────────
type FunctionArgs = {
    category?: string;
    storageZone?: string;
    minDaysWithoutMovement?: number;
    limit?: number;
    brand?: string;
    registration?: string;
    dateFrom?: string;
    dateTo?: string;
    repairCategory?: string;
    status?: string;
    siteId?: string;
};

async function executeTool(name: string, args: FunctionArgs): Promise<{ result: unknown; collectionUsed: string }> {
    try {
        switch (name) {
            case 'query_residuals': {
                let query = adminDb.collection('residuals').limit(args.limit || 50);

                if (args.category) {
                    query = query.where('category', '==', args.category) as typeof query;
                }
                if (args.storageZone) {
                    query = query.where('storageZone', '==', args.storageZone) as typeof query;
                }

                const snap = await query.get();
                let docs = snap.docs.map(d => ({ id: d.id, ...d.data() })) as Array<Record<string, unknown>>;

                // Filtr po dniach bez ruchu (po stronie klienta bo Firestore nie obsługuje timestamp diff)
                if (args.minDaysWithoutMovement && args.minDaysWithoutMovement > 0) {
                    const cutoff = Date.now() - args.minDaysWithoutMovement * 24 * 60 * 60 * 1000;
                    docs = docs.filter(d => {
                        const ts = d.updatedAt as Timestamp | undefined;
                        if (!ts) return true;
                        const ms = ts.toMillis ? ts.toMillis() : (ts as unknown as number);
                        return ms < cutoff;
                    });
                }

                return {
                    result: {
                        count: docs.length,
                        items: docs.map(d => ({
                            name: d.name,
                            quantity: d.quantity,
                            unit: d.unit,
                            category: d.category,
                            subcategory: d.subcategory,
                            storageZone: d.storageZone,
                            updatedAt: (d.updatedAt as Timestamp)?.toDate?.().toISOString?.() || null,
                        }))
                    },
                    collectionUsed: 'residuals'
                };
            }

            case 'get_warehouse_summary': {
                const snap = await adminDb.collection('residuals').get();
                const byCategory: Record<string, { count: number; items: string[] }> = {};
                const zones = new Set<string>();

                snap.docs.forEach(d => {
                    const data = d.data();
                    const cat = data.category || 'inne';
                    if (!byCategory[cat]) byCategory[cat] = { count: 0, items: [] };
                    byCategory[cat].count += 1;
                    byCategory[cat].items.push(data.name);
                    if (data.storageZone) zones.add(data.storageZone);
                });

                return {
                    result: {
                        totalResiduals: snap.size,
                        categorySummary: byCategory,
                        storageZones: Array.from(zones)
                    },
                    collectionUsed: 'residuals'
                };
            }

            case 'query_inventory': {
                let query = adminDb.collection('inventory').limit(args.limit || 50);
                if (args.category) {
                    query = query.where('category', '==', args.category) as typeof query;
                }
                const snap = await query.get();
                return {
                    result: snap.docs.map(d => ({ id: d.id, ...d.data() })),
                    collectionUsed: 'inventory'
                };
            }

            case 'query_vehicles_and_repairs': {
                // Pobierz pojazdy
                const vehiclesSnap = await adminDb.collection('vehicles').get();
                let vehicles = vehiclesSnap.docs.map(d => ({ id: d.id, ...d.data() })) as Array<Record<string, unknown>>;

                // Filtruj po marce/rejestracji
                if (args.brand) {
                    vehicles = vehicles.filter(v =>
                        (v.brand as string)?.toLowerCase().includes(args.brand!.toLowerCase())
                    );
                }
                if (args.registration) {
                    vehicles = vehicles.filter(v =>
                        (v.registration as string)?.toLowerCase().includes(args.registration!.toLowerCase())
                    );
                }

                const vehicleIds = vehicles.map(v => v.id);

                // Pobierz naprawy
                const repairsSnap = await adminDb.collection('repairs').get();
                let repairs = repairsSnap.docs.map(d => ({ id: d.id, ...d.data() })) as Array<Record<string, unknown>>;

                // Filtruj naprawy
                repairs = repairs.filter(r => vehicleIds.includes(r.vehicleId as string));
                if (args.dateFrom) repairs = repairs.filter(r => (r.date as string) >= args.dateFrom!);
                if (args.dateTo) repairs = repairs.filter(r => (r.date as string) <= args.dateTo!);
                if (args.repairCategory) repairs = repairs.filter(r => r.category === args.repairCategory);

                const totalCost = repairs.reduce((s, r) => s + (Number(r.cost) || 0), 0);

                return {
                    result: {
                        vehicles: vehicles.map(v => ({ id: v.id, brand: v.brand, model: v.model, registration: v.registration })),
                        repairs: repairs.map(r => ({ vehicleId: r.vehicleId, date: r.date, cost: r.cost, category: r.category, comments: r.comments, location: r.location })),
                        totalRepairCost: totalCost,
                        repairsCount: repairs.length
                    },
                    collectionUsed: 'vehicles+repairs'
                };
            }

            case 'query_orders': {
                let query = adminDb.collection('orders').limit(args.limit || 30);
                if (args.status) {
                    query = query.where('status', '==', args.status) as typeof query;
                }
                const snap = await query.get();
                return {
                    result: snap.docs.map(d => ({ id: d.id, ...d.data() })),
                    collectionUsed: 'orders'
                };
            }

            case 'query_sites': {
                const snap = await adminDb.collection('sites').get();
                let sites = snap.docs.map(d => ({ id: d.id, ...d.data() })) as Array<Record<string, unknown>>;
                if (args.status) sites = sites.filter(s => s.status === args.status);
                return { result: sites, collectionUsed: 'sites' };
            }

            default:
                return { result: { error: 'Nieznane narzędzie' }, collectionUsed: 'none' };
        }
    } catch (err) {
        console.error(`Błąd narzędzia ${name}:`, err);
        return { result: { error: String(err) }, collectionUsed: name };
    }
}

// ─── MAIN HANDLER ────────────────────────────────────────────────────────────
export async function POST(req: Request) {
    try {
        // 1. Weryfikacja tokenu
        const authHeader = req.headers.get('Authorization');
        if (!authHeader?.startsWith('Bearer ')) {
            return NextResponse.json({ error: 'Brak autoryzacji' }, { status: 401 });
        }
        const token = authHeader.slice(7);
        const decoded = await adminAuth.verifyIdToken(token);

        // 2. Sprawdź uprawnienie useChatAI
        const userDoc = await adminDb.doc(`users/${decoded.uid}`).get();
        if (!userDoc.exists) {
            return NextResponse.json({ error: 'Użytkownik nie znaleziony' }, { status: 403 });
        }
        const userData = userDoc.data()!;
        const overrides: Record<string, boolean> = userData.permissionOverrides || {};
        let rolePerms: Record<string, boolean> = {};

        if (userData.roleId) {
            const roleDoc = await adminDb.doc(`roles/${userData.roleId}`).get();
            if (roleDoc.exists) rolePerms = roleDoc.data()!.permissions || {};
        }

        const hasChatAI = overrides.useChatAI === true || (!(overrides.useChatAI === false) && rolePerms.useChatAI === true);
        if (!hasChatAI) {
            return NextResponse.json({ error: 'Brak uprawnienia do Chat AI' }, { status: 403 });
        }

        // 3. Pobierz wiadomości
        const { messages } = await req.json() as { messages: Array<{ role: string; content: string }> };
        if (!messages?.length) {
            return NextResponse.json({ error: 'Brak wiadomości' }, { status: 400 });
        }

        // 4. Zbuduj historię dla Gemini
        const today = new Date().toLocaleDateString('pl-PL', { year: 'numeric', month: 'long', day: 'numeric' });
        const systemInstruction = `Jesteś Asystentem Magazynowym PESAM — inteligentnym chatbotem dla firmy budowlanej.
Dzisiejsza data: ${today}.
Odpowiadaj ZAWSZE po polsku, konkretnie i pomocnie.
Masz dostęp do następującej bazy danych:

${DB_SCHEMA}

Zasady:
- Gdy pytanie dotyczy danych, ZAWSZE wywołaj odpowiednie narzędzie — nigdy nie odpowiadaj "nie wiem" bez sprawdzenia bazy.
- Po otrzymaniu danych, analizuj je i wyciągaj wnioski (co jest za dużo, co leży zbyt długo, trendy kosztów itp.).
- Formatuj odpowiedzi czytelnie — używaj list i podsumowań.
- Gdy widzisz problem (np. resztki >60 dni bez ruchu, wysokie koszty napraw), sugeruj konkretne akcje.
- Pamiętasz historię rozmowy w tym wątku.`;

        // Konwersja historii do formatu Gemini (ostatnia wiadomość = nowe pytanie)
        const geminiHistory: Content[] = messages.slice(0, -1).map(m => ({
            role: m.role === 'user' ? 'user' : 'model',
            parts: [{ text: m.content }]
        }));
        const lastMessage = messages[messages.length - 1];

        // 5. Pętla agenta z Function Calling
        const collectionsUsed: string[] = [];
        let currentContents: Content[] = [...geminiHistory, { role: 'user', parts: [{ text: lastMessage.content }] }];

        let finalText = '';
        for (let iteration = 0; iteration < 4; iteration++) {
            const response = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: currentContents,
                config: {
                    temperature: 0.3,
                    systemInstruction,
                    tools: TOOLS,
                }
            });

            const candidate = response.candidates?.[0];
            if (!candidate) break;

            const parts = candidate.content?.parts || [];
            let hasFunctionCall = false;

            for (const part of parts) {
                if (part.text) {
                    finalText = part.text;
                }
                if (part.functionCall) {
                    hasFunctionCall = true;
                    const { name, args } = part.functionCall;
                    const toolResult = await executeTool(name!, (args || {}) as FunctionArgs);
                    if (!collectionsUsed.includes(toolResult.collectionUsed)) {
                        collectionsUsed.push(toolResult.collectionUsed);
                    }

                    // Dodaj wywołanie i odpowiedź narzędzia do historii
                    currentContents = [
                        ...currentContents,
                        { role: 'model', parts: [{ functionCall: part.functionCall }] } as Content,
                        {
                            role: 'user', parts: [{
                                functionResponse: {
                                    name: name!,
                                    response: { result: JSON.stringify(toolResult.result) }
                                }
                            }]
                        } as Content
                    ];
                }
            }

            if (!hasFunctionCall) break;
        }

        return NextResponse.json({ reply: finalText || 'Przepraszam, wystąpił problem z przetwarzaniem zapytania.', dataUsed: collectionsUsed });

    } catch (err) {
        console.error('Błąd AI Warehouse Agent:', err);
        return NextResponse.json({ error: 'Błąd serwera', detail: String(err) }, { status: 500 });
    }
}
