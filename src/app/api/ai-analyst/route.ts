// src/app/api/ai-analyst/route.ts
// =============================================================================
// PESAM Fleet Analytics — Multi-Agent AI System v3.0 (Dexie-first)
//
// NOWA ARCHITEKTURA:
// Dane NIE są już pobierane z Firestore po stronie serwera.
// Frontend czyta z lokalnej IndexedDB (Dexie), filtruje i wysyła
// tylko relevantne rekordy do tego API.
//
// Agenci:
//   Agent 1: Dyspozytor — ocenia intencję, ekstrahuje parametry
//   Agent 2: Matematyk  — obliczenia w piaskownicy Python
//   Agent 3: Prezenter  — dobiera widget UI (wykres/tabela/KPI)
// =============================================================================
import { NextResponse } from 'next/server';
import { GoogleGenAI, Type } from '@google/genai';

// ─────────────────────────────────────────────────────────────────────────────
// INICJALIZACJA
// ─────────────────────────────────────────────────────────────────────────────
const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || 'pesam-system-81165',
    location: 'global'
});

export const maxDuration = 60;

// ─────────────────────────────────────────────────────────────────────────────
// TYPY
// ─────────────────────────────────────────────────────────────────────────────
interface Vehicle {
    id: string;
    brand: string;
    model: string;
    registration: string;
    initialMileage: number;
}

interface Repair {
    vehicleId: string;
    cost: number;
    date: string;
    category: string;
    mileage?: number;
    comments?: string;
    location?: string;
    partsList?: string[];
}

interface RequestBody {
    question: string;
    currentHistory: Array<{ role: string; text: string }>;
    // Dane przychodzą z przeglądarki (IndexedDB) — już przefiltrowane przez frontend
    vehicles: Vehicle[];
    repairs: Repair[];
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. SCHEMAT BAZY — wiedza wspólna agentów
// ─────────────────────────────────────────────────────────────────────────────
const DB_SCHEMA = `
PESAM Fleet – Schemat danych:

vehicles (pojazdy):
  - id (string): Unikalny ID
  - brand (string): Marka np. "Ford", "Renault", "Iveco", "Opel"
  - model (string): Model np. "Transit", "Trafic", "Daily 35C15"
  - registration (string): Nr rejestracyjny np. "RDE HF31"
  - initialMileage (number): Początkowy stan licznika km

repairs (naprawy):
  - vehicleId (string): FK do vehicles.id
  - date (string): YYYY-MM-DD
  - cost (number): Koszt netto PLN (float) — ZAWSZE "cost", nigdy "price"
  - category (string): "Mechaniczna"|"Elektryczna"|"Zawieszenie"|"Silnik"|"Wulkanizacja"|"Lakiernicza"|"Eksploatacyjna"|"Inne"
  - mileage (number): Stan licznika km
  - comments (string): Opis prac
  - location (string): Nazwa warsztatu
  - partsList (string[]): Lista części

WAŻNE: Pole kosztu = "cost". Pole kategorii = "category". Nigdy inne nazwy.
`;

// ─────────────────────────────────────────────────────────────────────────────
// 2. RETRY
// ─────────────────────────────────────────────────────────────────────────────
async function generateContent(params: any, retries = 3, delay = 1000): Promise<any> {
    try {
        return await ai.models.generateContent(params);
    } catch (error: any) {
        const isRateLimit =
            error?.message?.includes('429') ||
            error?.message?.includes('RESOURCE_EXHAUSTED') ||
            error?.status === 429;

        if (isRateLimit && retries > 0) {
            await new Promise(res => setTimeout(res, delay));
            return generateContent(params, retries - 1, delay * 2);
        }
        throw error;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. SCHEMATY AGENTÓW
// ─────────────────────────────────────────────────────────────────────────────
const DISPATCHER_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        isDataAnalysis: {
            type: Type.BOOLEAN,
            description: 'true = zapytanie analityczne, false = zwykła rozmowa/powitanie'
        },
        conversationalReply: {
            type: Type.STRING,
            description: 'Odpowiedź gdy isDataAnalysis=false'
        }
    },
    required: ['isDataAnalysis']
};

// ─────────────────────────────────────────────────────────────────────────────
// 4. NARZĘDZIA UI (dla Agenta Prezentera)
// ─────────────────────────────────────────────────────────────────────────────
const TOOL_RENDER_CHART = {
    name: 'renderChartWidget',
    description: 'Wykres słupkowy, kołowy lub liniowy. Użyj dla danych porównawczych, kategorialnych lub czasowych.',
    parameters: {
        type: Type.OBJECT,
        properties: {
            chartType: { type: Type.STRING, description: '"bar" | "pie" | "line"' },
            title: { type: Type.STRING },
            datasetLabel: { type: Type.STRING, description: 'np. "Koszt PLN"' },
            labels: { type: Type.ARRAY, items: { type: Type.STRING } },
            values: { type: Type.ARRAY, items: { type: Type.NUMBER } }
        },
        required: ['chartType', 'title', 'datasetLabel', 'labels', 'values']
    }
};

const TOOL_RENDER_TABLE = {
    name: 'renderTableWidget',
    description: 'Tabela danych. Użyj dla list, rankingów, szczegółowych wpisów (min. 3 wiersze).',
    parameters: {
        type: Type.OBJECT,
        properties: {
            title: { type: Type.STRING },
            columns: { type: Type.ARRAY, items: { type: Type.STRING } },
            rows: {
                type: Type.ARRAY,
                items: { type: Type.ARRAY, items: { type: Type.STRING } }
            }
        },
        required: ['title', 'columns', 'rows']
    }
};

const TOOL_RENDER_KPI = {
    name: 'renderKpiWidget',
    description: 'Kafelki KPI. Użyj dla 1-4 kluczowych liczb: suma, średnia, max.',
    parameters: {
        type: Type.OBJECT,
        properties: {
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
        required: ['title', 'metrics']
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// 5. PRZYCINANIE DANYCH
// Usuwa zbędne pola tekstowe jeśli pytanie ich nie dotyczy.
// Zapobiega przekroczeniu limitu tokenów przy dużych flotach.
// ─────────────────────────────────────────────────────────────────────────────
function pruneForAnalysis(
    vehicles: Vehicle[],
    repairs: Repair[],
    question: string
): { vehicles: object[]; repairs: object[] } {
    const q = question.toLowerCase();

    const needsComments = /komentarz|opis|uwag|część|części|parts|wymieni|podzespół/.test(q);
    const needsLocation = /warsztat|miejsce|gdzie|lokalizac|serwis/.test(q);
    const needsPartsList = /lista części|parts list|wymienione/.test(q);

    const prunedVehicles = vehicles.map(v => ({
        id: v.id,
        brand: v.brand,
        model: v.model,
        // PRO-TIP 1: registration zawsze widoczny dla Matematyka.
        // Waży kilkanaście bajtów, ale daje Pythonowi ludzki identyfikator
        // zamiast surowego ID — "Ford RDE HF31" zamiast "v-8f92a1".
        registration: v.registration,
        initialMileage: v.initialMileage
    }));

    const prunedRepairs = repairs.map(r => ({
        vehicleId: r.vehicleId,
        cost: r.cost,
        date: r.date,
        category: r.category,
        mileage: r.mileage,
        ...(needsComments && { comments: r.comments }),
        ...(needsLocation && { location: r.location }),
        ...(needsPartsList && { partsList: r.partsList })
    }));

    return { vehicles: prunedVehicles, repairs: prunedRepairs };
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. GŁÓWNY HANDLER
// ─────────────────────────────────────────────────────────────────────────────
export async function POST(req: Request) {
    const logs: string[] = [];

    try {
        const body: RequestBody = await req.json();
        const { question, currentHistory, vehicles, repairs } = body;

        // Walidacja — frontend powinien zawsze wysyłać te tablice
        if (!Array.isArray(vehicles) || !Array.isArray(repairs)) {
            return NextResponse.json(
                { error: 'Brak danych: vehicles i repairs muszą być tablicami.' },
                { status: 400 }
            );
        }

        logs.push(`[Init] Odebrano: ${vehicles.length} pojazdów, ${repairs.length} napraw z IndexedDB`);

        // PRO-TIP 2: Guard przed zbyt dużym payloadem (limit Vercel ~4.5 MB).
        // Przy 2000+ naprawach model i tak nie przetworzyłby tego sensownie.
        if (repairs.length > 2000) {
            return NextResponse.json({
                message: `⚠️ Zapytanie obejmuje zbyt wiele rekordów (${repairs.length} napraw). Proszę zawęzić analizę — podaj konkretną markę, pojazd lub ramy czasowe (np. "koszty Forda w 2024").`,
                uiAction: null,
                logs
            }, { status: 200 });
        }

        // Skrócona historia — max 10 ostatnich wiadomości
        const historyText = (currentHistory || [])
            .slice(-10)
            .map(m => `${m.role === 'user' ? 'Użytkownik' : 'AI'}: ${m.text}`)
            .join('\n');

        // =====================================================================
        // AGENT 1: DYSPOZYTOR
        // Ocenia intencję — analityczna czy rozmowa?
        // =====================================================================
        logs.push('[Agent 1] Dyspozytor uruchomiony (gemini-2.5-flash-lite)');

        const dispatcherRes = await generateContent({
            model: 'gemini-2.5-flash-lite',
            contents: [{
                role: 'user',
                parts: [{ text: `Historia:\n${historyText}\n\nZapytanie: "${question}"` }]
            }],
            config: {
                systemInstruction: `Jesteś Dyspozytorem floty PESAM. Oceń czy zapytanie wymaga analizy danych flotowych (isDataAnalysis=true) czy to zwykła rozmowa/powitanie (isDataAnalysis=false). Jeśli to rozmowa, napisz krótką przyjazną odpowiedź po polsku w conversationalReply.`,
                temperature: 0.1,
                responseMimeType: 'application/json',
                responseSchema: DISPATCHER_SCHEMA
            }
        });

        const dispatcherRaw = (dispatcherRes.text || '{}')
            .replace(/```json|```/g, '')
            .trim();
        const dispatcher = JSON.parse(dispatcherRaw);

        if (!dispatcher.isDataAnalysis) {
            logs.push('[Agent 1] Wykryto rozmowę — odpowiedź bezpośrednia');
            return NextResponse.json({
                message: dispatcher.conversationalReply || 'W czym mogę pomóc?',
                uiAction: null,
                logs
            });
        }

        logs.push('[Agent 1] Wykryto zapytanie analityczne');

        // =====================================================================
        // PRZYGOTOWANIE DANYCH
        // Przytnij zbędne pola tekstowe zależnie od treści pytania
        // =====================================================================
        const pruned = pruneForAnalysis(vehicles, repairs, question);
        logs.push(`[Data] Przycinanie: ${pruned.vehicles.length} pojazdów, ${pruned.repairs.length} napraw → gotowe dla Matematyka`);

        // =====================================================================
        // AGENT 2: MATEMATYK (Python Sandbox)
        // Otrzymuje czyste dane — wykonuje obliczenia
        // =====================================================================
        logs.push('[Agent 2] Matematyk uruchomiony (gemini-2.5-pro + Python Sandbox)');

        const mathPrompt = `
${DB_SCHEMA}

Pytanie użytkownika: "${question}"

Dane do analizy:
vehicles = ${JSON.stringify(pruned.vehicles)}
repairs = ${JSON.stringify(pruned.repairs)}

ZADANIE:
1. Napisz kod Python który załaduje powyższe dane bezpośrednio (skopiuj JSON do kodu)
2. Wykonaj obliczenia: sumy, średnie, grupowania, rankingi, trendy — zgodnie z pytaniem
3. Wypisz wyniki na stdout z czytelnymi etykietami
4. Podsumuj wyniki w 2-4 zdaniach po polsku (tylko liczby i fakty)

ZASADY:
- Używaj tylko: json, collections, statistics, datetime (bez zewnętrznych bibliotek)
- NIE rysuj wykresów ani tabel tekstowych — od tego jest kolejny agent
- Jeśli danych brak lub puste tablice — napisz to wprost
`;

        const mathRes = await generateContent({
            model: 'gemini-3.1-pro-preview',
            contents: [{ role: 'user', parts: [{ text: mathPrompt }] }],
            config: {
                systemInstruction: `Jesteś precyzyjnym Matematykiem Floty PESAM. Twoja jedyna rola to obliczenia numeryczne w Pythonie na dostarczonych danych JSON. Zero wizualizacji, zero formatowania markdown — tylko suche wyniki.`,
                temperature: 0.0,
                tools: [{ codeExecution: {} }]
            }
        });

        const mathResults = mathRes.text || 'Brak wyników obliczeń.';

        const pythonExecuted = mathRes.candidates?.[0]?.content?.parts
            ?.some((p: any) => p.executableCode || p.codeExecutionResult) ?? false;

        logs.push(pythonExecuted
            ? '[Agent 2] ✓ Obliczenia Python wykonane'
            : '[Agent 2] ⚠ Python nie uruchomiony (dane puste lub pytanie proste)'
        );

        // =====================================================================
        // AGENT 3: PREZENTER (dobór widgetu UI)
        // Otrzymuje TYLKO wyniki Matematyka — zero surowych danych
        // =====================================================================
        logs.push('[Agent 3] Prezenter uruchomiony (gemini-2.5-flash)');

        const presenterPrompt = `
Pytanie użytkownika: "${question}"

Wyniki obliczeń Matematyka Floty:
${mathResults}

ZADANIE: Wybierz DOKŁADNIE JEDNO narzędzie i wypełnij je gotowymi danymi:

Kryteria wyboru:
- renderKpiWidget    → 1-4 kluczowe liczby (suma kosztów, średnia, maksimum)
- renderChartWidget  → dane porównawcze lub czasowe (koszty wg kategorii, trend miesięczny, ranking pojazdów)
- renderTableWidget  → lista lub ranking z wieloma kolumnami (historia napraw, zestawienie pojazdów)

Wskazówki:
• Koszty w czasie → "line" chart
• Podział na kategorie → "pie" lub "bar" chart
• Porównanie pojazdów → "bar" chart
• Jedna liczba sumaryczna → kpi
• Szczegółowa lista → table

Użyj polskich etykiet. Liczby PLN formatuj z separatorem tysięcy.
`;

        const presenterRes = await generateContent({
            model: 'gemini-3.5-flash',
            contents: [{ role: 'user', parts: [{ text: presenterPrompt }] }],
            config: {
                systemInstruction: `Jesteś Architektem UI PESAM. Wybierz JEDNO narzędzie wizualne i wypełnij je danymi od Matematyka. Nie analizuj danych — tylko prezentuj gotowe wyniki.`,
                temperature: 0.0,
                tools: [{ functionDeclarations: [TOOL_RENDER_CHART, TOOL_RENDER_TABLE, TOOL_RENDER_KPI] }]
            }
        });

        // =====================================================================
        // PARSOWANIE ODPOWIEDZI PREZENTERA
        // =====================================================================
        let textMessage = mathResults;
        let uiAction = null;

        if (presenterRes.functionCalls?.length) {
            const call = presenterRes.functionCalls[0];
            const args = call.args as any;

            switch (call.name) {
                case 'renderChartWidget':
                    uiAction = { type: 'chart', payload: args };
                    textMessage += '\n\n[Wykres wygenerowany na panelu wizualizacji]';
                    logs.push(`[Agent 3] ✓ Wykres: "${args.title}" (${args.chartType})`);
                    break;

                case 'renderTableWidget':
                    uiAction = { type: 'table', payload: args };
                    textMessage += '\n\n[Tabela wygenerowana na panelu wizualizacji]';
                    logs.push(`[Agent 3] ✓ Tabela: "${args.title}" (${args.rows?.length || 0} wierszy)`);
                    break;

                case 'renderKpiWidget':
                    uiAction = { type: 'kpi', payload: args };
                    textMessage += '\n\n[Kafelki KPI wygenerowane na panelu wizualizacji]';
                    logs.push(`[Agent 3] ✓ KPI: "${args.title}" (${args.metrics?.length || 0} wskaźników)`);
                    break;

                default:
                    logs.push(`[Agent 3] ⚠ Nieznane narzędzie: ${call.name}`);
            }
        } else {
            logs.push('[Agent 3] ⚠ Brak narzędzia — odpowiedź tekstowa');
        }

        // =====================================================================
        // ODPOWIEDŹ
        // Nie zwracamy już newCache — IndexedDB zarządza danymi lokalnie
        // =====================================================================
        return NextResponse.json({
            message: textMessage,
            uiAction,
            logs
        }, { status: 200 });

    } catch (error: any) {
        console.error('[PESAM AI Error]', error);
        logs.push(`[BŁĄD KRYTYCZNY] ${error?.message || 'Nieznany błąd'}`);
        return NextResponse.json(
            { error: error?.message || 'Błąd systemu analitycznego', logs },
            { status: 500 }
        );
    }
}