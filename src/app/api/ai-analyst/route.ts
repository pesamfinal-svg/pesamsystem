// src/app/api/ai-analyst/route.ts
// =============================================================================
// PESAM Fleet Analytics — Multi-Agent AI System v5.0
//
// ARCHITEKTURA v5.0 — "Server-First Data":
//
//  Frontend wysyła: { question, currentHistory }   ← ZERO danych flotowych!
//
//  Pipeline agentów:
//   Agent 1: Dyspozytor    — czy to analiza czy rozmowa?        (flash-lite, ~0.2s)
//   Agent 0: Strateg Danych — buduje plan zapytania Firestore   (flash-lite, ~0.5s)
//            ↓ executeQueryPlan() — odpytuje Firestore po serwerze
//   Agent 2: Matematyk     — obliczenia Python na pobranych danych (flash, ~3s)
//   Agent 3: Prezenter     — wybiera widget UI                  (flash-lite, ~0.5s)
//
// KORZYŚCI vs v4.0:
//   • Frontend NIE wysyła danych — koniec z 17k tokenów wejściowych
//   • Firestore filtruje na bazie — np. tylko 16 napraw Iveca zamiast 400+
//   • Serwer pobiera minimalny zestaw pól (bez comments/location jeśli nie potrzeba)
//   • Przy pytaniu "iveco daily koszty" → ~1-2k tokenów zamiast 17k
// =============================================================================

import { NextResponse } from 'next/server';
import { GoogleGenAI, Type } from '@google/genai';
import { executeQueryPlan, FirestoreQueryPlan } from '../../../lib/db/firestore-query-builder';

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
interface RequestBody {
    question: string;
    currentHistory: Array<{ role: string; text: string }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// SCHEMAT BAZY — wiedza wspólna agentów (skrócona)
// ─────────────────────────────────────────────────────────────────────────────
const DB_SCHEMA = `
PESAM Fleet – Schemat Firestore:

KOLEKCJA vehicles (pojazdy):
  id, brand(string), model(string), registration(string), initialMileage(number/km)
  Przykładowe marki: Iveco, Ford, Renault, Opel, Skoda, Mercedes
  Przykładowe modele: Daily, Transit, Trafic, Vivaro, Superb

KOLEKCJA repairs (naprawy):
  vehicleId(FK→vehicles.id), date(YYYY-MM-DD), cost(number/PLN netto),
  category(string), mileage(number/km), comments(string),
  location(string/nazwa warsztatu), partsList(string[])
  Kategorie: Mechaniczna|Elektryczna|Zawieszenie|Silnik|Wulkanizacja|Lakiernicza|Eksploatacyjna|Inne

WAŻNE: pole kosztu = "cost", pole kategorii = "category"
`;

// ─────────────────────────────────────────────────────────────────────────────
// RETRY z exponential backoff
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
// SCHEMATY JSON dla agentów
// ─────────────────────────────────────────────────────────────────────────────

// Agent 1 — Dyspozytor
const DISPATCHER_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        isDataAnalysis: {
            type: Type.BOOLEAN,
            description: 'true = zapytanie analityczne (koszty/naprawy/pojazdy/wykresy/rankingi), false = rozmowa/powitanie'
        },
        conversationalReply: {
            type: Type.STRING,
            description: 'Odpowiedź gdy isDataAnalysis=false'
        }
    },
    required: ['isDataAnalysis']
};

// Agent 0 — Strateg Danych
const QUERY_PLAN_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        needsVehicles: { type: Type.BOOLEAN },
        vehicleFilters: {
            type: Type.OBJECT,
            properties: {
                brand: { type: Type.STRING, description: 'Marka pojazdu, np. "Iveco", "Ford". Puste jeśli nie wspomniana.' },
                model: { type: Type.STRING, description: 'Model pojazdu, np. "Daily", "Transit". Puste jeśli nie wspomniany.' },
                registration: { type: Type.STRING, description: 'Nr rejestracyjny, np. "RDE HF31". Puste jeśli nie wspomniany.' },
            }
        },
        needsRepairs: { type: Type.BOOLEAN },
        repairFilters: {
            type: Type.OBJECT,
            properties: {
                dateFrom: { type: Type.STRING, description: 'Data od YYYY-MM-DD. Puste jeśli nie wspomniana.' },
                dateTo: { type: Type.STRING, description: 'Data do YYYY-MM-DD. Puste jeśli nie wspomniana.' },
                category: { type: Type.STRING, description: 'Kategoria naprawy. Puste jeśli nie wspomniana.' },
            }
        },
        repairFields: {
            type: Type.OBJECT,
            properties: {
                needsComments: { type: Type.BOOLEAN, description: 'true gdy pytanie dotyczy opisów, komentarzy, szczegółów prac' },
                needsLocation: { type: Type.BOOLEAN, description: 'true gdy pytanie dotyczy warsztatu, miejsca naprawy' },
                needsPartsList: { type: Type.BOOLEAN, description: 'true gdy pytanie dotyczy wymienionych części' },
                needsMileage: { type: Type.BOOLEAN, description: 'true gdy pytanie dotyczy przebiegu, kilometrów' },
            }
        },
        repairsLimit: {
            type: Type.NUMBER,
            description: 'Limit pobieranych napraw. Przy konkretnym aucie: 200. Przy ogólnym zapytaniu floty: 500. Przy zapytaniu rok+auto: 100.'
        },
        reasoning: {
            type: Type.STRING,
            description: 'Jedno zdanie uzasadnienia: co filtrujesz i dlaczego.'
        }
    },
    required: ['needsVehicles', 'vehicleFilters', 'needsRepairs', 'repairFilters', 'repairFields', 'repairsLimit', 'reasoning']
};

// ─────────────────────────────────────────────────────────────────────────────
// NARZĘDZIA UI dla Agenta 3 (Prezenter) z parametrem aiMessage
// ─────────────────────────────────────────────────────────────────────────────
const TOOL_RENDER_CHART = {
    name: 'renderChartWidget',
    description: 'Wykres słupkowy, kołowy lub liniowy. Dla danych porównawczych, kategorialnych lub czasowych.',
    parameters: {
        type: Type.OBJECT,
        properties: {
            aiMessage: { type: Type.STRING, description: 'CZYSTE, naturalne zdanie do czatu podsumowujące wykres (np. "Najdroższym pojazdem jest Iveco. Szczegóły na wykresie."). BEZ KODU PYTHON i stdout!' },
            chartType: { type: Type.STRING, description: '"bar" | "pie" | "line"' },
            title: { type: Type.STRING },
            datasetLabel: { type: Type.STRING, description: 'np. "Koszt PLN"' },
            labels: { type: Type.ARRAY, items: { type: Type.STRING } },
            values: { type: Type.ARRAY, items: { type: Type.NUMBER } }
        },
        required: ['aiMessage', 'chartType', 'title', 'datasetLabel', 'labels', 'values']
    }
};

const TOOL_RENDER_TABLE = {
    name: 'renderTableWidget',
    description: 'Tabela danych. Dla list, rankingów, szczegółowych wpisów.',
    parameters: {
        type: Type.OBJECT,
        properties: {
            aiMessage: { type: Type.STRING, description: 'CZYSTE, naturalne zdanie do czatu podsumowujące tabelę. BEZ KODU PYTHON i stdout!' },
            title: { type: Type.STRING },
            columns: { type: Type.ARRAY, items: { type: Type.STRING } },
            rows: { type: Type.ARRAY, items: { type: Type.ARRAY, items: { type: Type.STRING } } }
        },
        required: ['aiMessage', 'title', 'columns', 'rows']
    }
};

const TOOL_RENDER_KPI = {
    name: 'renderKpiWidget',
    description: 'Kafelki KPI. Dla 1-4 kluczowych liczb: suma, średnia, max.',
    parameters: {
        type: Type.OBJECT,
        properties: {
            aiMessage: { type: Type.STRING, description: 'CZYSTE, naturalne zdanie do czatu podsumowujące dane liczbowe. BEZ KODU PYTHON i stdout!' },
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

// ─────────────────────────────────────────────────────────────────────────────
// HELPER — wyciąg czystego tekstu z odpowiedzi Agenta 2 (Agresywne czyszczenie)
// ─────────────────────────────────────────────────────────────────────────────
function extractCleanSummary(rawText: string): string {
    const match = rawText.match(/podsumowanie:\s*([\s\S]*)/i);
    if (match?.[1]) return match[1].trim();

    // Jeśli brak jawnej sekcji "Podsumowanie", usuwamy kod Pythona i tablice JSON z czatu
    return rawText
        .replace(/```[\s\S]*?```/g, '') // Usuń bloki kodu
        .replace(/\{[\s\S]*?\}/g, '')   // Usuń obiekty JSON
        .replace(/\[[\s\S]*?\]/g, '')   // Usuń tablice JSON
        .replace(/import json[\s\S]*?(\n|$)/g, '')
        .replace(/vehicles_json[\s\S]*?(\n|$)/g, '')
        .replace(/repairs_json[\s\S]*?(\n|$)/g, '')
        .replace(/WYNIKI STDOUT[\s\S]*?(\n|$)/gi, '')
        .replace(/Kod Python[\s\S]*?(\n|$)/gi, '')
        .trim() || 'Analiza zakończona. Wyniki widoczne na panelu.';
}

// ─────────────────────────────────────────────────────────────────────────────
// GŁÓWNY HANDLER
// ─────────────────────────────────────────────────────────────────────────────
export async function POST(req: Request) {
    const logs: string[] = [];
    let sessionInputTokens = 0;
    let sessionOutputTokens = 0;

    const trackTokens = (response: any) => {
        if (response?.usageMetadata) {
            sessionInputTokens += response.usageMetadata.promptTokenCount || 0;
            sessionOutputTokens += response.usageMetadata.candidatesTokenCount || 0;
        }
    };

    try {
        const body: RequestBody = await req.json();
        const { question, currentHistory } = body;

        if (!question?.trim()) {
            return NextResponse.json(
                { error: 'Brak pytania.', usage: { input: 0, output: 0 } },
                { status: 400 }
            );
        }

        logs.push(`[Init] Pytanie: "${question}"`);

        // Historia: ostatnie 4 wiadomości
        const historyText = (currentHistory || [])
            .slice(-4)
            .map(m => `${m.role === 'user' ? 'Użytkownik' : 'AI'}: ${m.text}`)
            .join('\n');

        // =====================================================================
        // AGENT 1: DYSPOZYTOR
        // Cel: szybko odfiltruj powitania i off-topic bez kosztownych agentów
        // =====================================================================
        logs.push('[Agent 1] Dyspozytor (gemini-2.5-flash-lite)');

        const dispatcherRes = await generateContent({
            model: 'gemini-2.5-flash-lite',
            contents: [{
                role: 'user',
                parts: [{ text: `Historia:\n${historyText}\n\nZapytanie: "${question}"` }]
            }],
            config: {
                systemInstruction: `Dyspozytor floty PESAM. isDataAnalysis=true gdy pytanie dotyczy danych flotowych (koszty, naprawy, pojazdy, wykresy, rankingi, statystyki, zestawienia, trendy). isDataAnalysis=false gdy to powitanie, pytanie ogólne lub small-talk. Jeśli false — napisz krótką odpowiedź po polsku w conversationalReply.`,
                temperature: 0.0,
                responseMimeType: 'application/json',
                responseSchema: DISPATCHER_SCHEMA
            }
        });
        trackTokens(dispatcherRes);

        let dispatcher: { isDataAnalysis: boolean; conversationalReply?: string };
        try {
            dispatcher = JSON.parse((dispatcherRes.text || '{}').replace(/```json|```/g, '').trim());
        } catch {
            dispatcher = { isDataAnalysis: true }; // fail-safe: zakładamy analityczne
        }

        if (!dispatcher.isDataAnalysis) {
            logs.push('[Agent 1] Rozmowa — odpowiedź bezpośrednia');
            return NextResponse.json({
                message: dispatcher.conversationalReply || 'Jak mogę pomóc?',
                uiAction: null, logs,
                usage: { input: sessionInputTokens, output: sessionOutputTokens }
            });
        }
        logs.push('[Agent 1] Analityczne ✓');

        // =====================================================================
        // AGENT 0: STRATEG DANYCH
        // Cel: zrozumieć pytanie i zbudować precyzyjny plan zapytania Firestore
        // =====================================================================
        logs.push('[Agent 0] Strateg Danych (gemini-2.5-flash-lite)');

        const strategistPrompt = `
${DB_SCHEMA}

Pytanie użytkownika: "${question}"
Kontekst rozmowy: ${historyText || 'brak'}

Zbuduj plan zapytania do Firestore który pobierze TYLKO dane niezbędne do odpowiedzi.

Zasady filtrowania:
- Jeśli pytanie zawiera nazwę marki (Iveco, Ford, Renault, Opel, Skoda...) → ustaw vehicleFilters.brand
- Jeśli pytanie zawiera model (Daily, Transit, Trafic...) → ustaw vehicleFilters.model
- Jeśli pytanie zawiera numer rejestracyjny → ustaw vehicleFilters.registration
- Jeśli pytanie zawiera rok (np. "w 2024", "za 2023") → ustaw dateFrom i dateTo
- Jeśli pytanie zawiera "tego roku" → dateFrom = bieżący rok 01-01
- Jeśli pytanie zawiera kategorię naprawy → ustaw repairFilters.category
- repairFields.needsMileage = true tylko jeśli pytanie dotyczy przebiegu lub km
- repairFields.needsComments = true tylko jeśli pytanie pyta o szczegóły/opisy prac
- repairFields.needsLocation = true tylko jeśli pytanie pyta o warsztat/miejsce
- repairFields.needsPartsList = true tylko jeśli pytanie pyta o części
- repairsLimit: konkretne auto → 200, rok+flota → 300, ogólna flota → 500
`;

        const strategistRes = await generateContent({
            model: 'gemini-2.5-flash-lite',
            contents: [{ role: 'user', parts: [{ text: strategistPrompt }] }],
            config: {
                systemInstruction: `Jesteś Strategiem Danych floty PESAM. Twoja jedyna rola to zbudowanie optymalnego planu zapytania do Firestore — minimalnego zestawu danych potrzebnych do odpowiedzi. Zawsze ustaw reasoning z jednozdaniowym uzasadnieniem.`,
                temperature: 0.0,
                responseMimeType: 'application/json',
                responseSchema: QUERY_PLAN_SCHEMA
            }
        });
        trackTokens(strategistRes);

        let queryPlan: FirestoreQueryPlan;
        try {
            queryPlan = JSON.parse((strategistRes.text || '{}').replace(/```json|```/g, '').trim());
        } catch {
            // Fail-safe: ogólny plan bez filtrów
            queryPlan = {
                needsVehicles: true,
                vehicleFilters: {},
                needsRepairs: true,
                repairFilters: {},
                repairFields: { needsComments: false, needsLocation: false, needsPartsList: false, needsMileage: true },
                repairsLimit: 300,
                reasoning: 'Fallback: brak sparsowanego planu'
            };
        }

        logs.push(`[Agent 0] Plan: ${queryPlan.reasoning}`);
        logs.push(`[Agent 0] Filtry: brand="${queryPlan.vehicleFilters.brand || '-'}" model="${queryPlan.vehicleFilters.model || '-'}" dateFrom="${queryPlan.repairFilters.dateFrom || '-'}" dateTo="${queryPlan.repairFilters.dateTo || '-'}" limit=${queryPlan.repairsLimit}`);

        // =====================================================================
        // FIRESTORE — wykonaj plan zapytania po stronie serwera
        // =====================================================================
        logs.push('[Firestore] Pobieranie danych według planu...');

        const { vehicles, repairs, fetchSummary } = await executeQueryPlan(queryPlan);
        logs.push(`[Firestore] Pobrano: ${fetchSummary}`);

        if (vehicles.length === 0 && repairs.length === 0) {
            return NextResponse.json({
                message: 'Nie znalazłem żadnych danych pasujących do Twojego zapytania. Sprawdź nazwy marek lub zakresy dat.',
                uiAction: null, logs,
                usage: { input: sessionInputTokens, output: sessionOutputTokens }
            });
        }

        // Szacowanie tokenów przed wysłaniem do Agenta 2
        const jsonRepairs = JSON.stringify(repairs);
        const jsonVehicles = JSON.stringify(vehicles);
        const estimatedTokens = Math.ceil((jsonRepairs.length + jsonVehicles.length) / 3.5);
        logs.push(`[Data] Szacowane tokeny danych: ~${Math.round(estimatedTokens / 1000)}k`);

        if (estimatedTokens > 40000) {
            return NextResponse.json({
                message: `⚠️ Dane są zbyt duże (~${Math.round(estimatedTokens / 1000)}k tokenów, ${repairs.length} napraw). Zawęź zapytanie — podaj konkretną markę, pojazd lub rok.`,
                uiAction: null, logs,
                usage: { input: sessionInputTokens, output: sessionOutputTokens }
            });
        }

        // =====================================================================
        // AGENT 2: MATEMATYK
        // Cel: obliczenia numeryczne na danych z Firestore
        // =====================================================================
        logs.push('[Agent 2] Matematyk (gemini-2.5-flash + Code Execution)');

        const mathPrompt = `
${DB_SCHEMA}

Pytanie użytkownika: "${question}"

Dane pobrane z bazy (już przefiltrowane):
vehicles = ${jsonVehicles}
repairs = ${jsonRepairs}

ZADANIE:
1. Napisz Python który załaduje powyższe dane (skopiuj JSON do kodu)
2. Wykonaj obliczenia: sumy, średnie, grupowania, rankingi, trendy — zgodnie z pytaniem
3. Wypisz wyniki na stdout z czytelnymi etykietami
4. Na końcu wypisz "PODSUMOWANIE:" + 2-3 zdania wniosków po polsku

ZASADY: tylko json/collections/statistics/datetime. Bez wykresów matplotlib.
`;

        const mathRes = await generateContent({
            model: 'gemini-2.5-flash',
            contents: [{ role: 'user', parts: [{ text: mathPrompt }] }],
            config: {
                systemInstruction: `Jesteś Matematykiem Floty PESAM. Wykonujesz obliczenia numeryczne w Pythonie. Tylko suche wyniki — zero wizualizacji, zero markdown.`,
                temperature: 0.0,
                tools: [{ codeExecution: {} }]
            }
        });
        trackTokens(mathRes);

        const mathResults = mathRes.text || 'Brak wyników.';
        const pythonExecuted = mathRes.candidates?.[0]?.content?.parts
            ?.some((p: any) => p.executableCode || p.codeExecutionResult) ?? false;

        logs.push(pythonExecuted
            ? '[Agent 2] ✓ Python wykonany'
            : '[Agent 2] ⚠ Python nie uruchomiony'
        );

        // =====================================================================
        // AGENT 3: PREZENTER
        // Cel: wybranie widgetu i sformatowanie danych
        // =====================================================================
        logs.push('[Agent 3] Prezenter (gemini-2.5-flash-lite)');

        const presenterPrompt = `
Pytanie: "${question}"

Wyniki obliczeń Matematyka:
${mathResults}

Wybierz JEDNO narzędzie i wypełnij danymi:
- renderKpiWidget    → 1-4 kluczowe liczby (suma, średnia, max, min)
- renderChartWidget  → dane porównawcze lub czasowe (bar/pie/line)
- renderTableWidget  → lista lub ranking z min. 3 wierszami

Dobór widgetu:
• Jedna/kilka liczb sumarycznych → kpi
• Koszty wg kategorii lub auta → bar lub pie
• Trend miesięczny/roczny → line
• Historia napraw, zestawienie → table

BARDZO WAŻNE:
Musisz wypełnić parametr 'aiMessage' krótkim, czystym zdaniem podsumowującym wyniki (np. "Najdroższym autem we flocie jest Iveco RDE HF31 (13.3k PLN). Szczegóły na wykresie."). 
Ten tekst trafi bezpośrednio do dymku czatu z użytkownikiem. Bezwzględnie odfiltruj i UKRYJ surowy kod Python, zrzuty JSON oraz stdout konsoli!
Użyj polskich etykiet. PLN z separatorem tysięcy (np. "13 388,52 PLN").
`;

        const presenterRes = await generateContent({
            model: 'gemini-2.5-flash-lite',
            contents: [{ role: 'user', parts: [{ text: presenterPrompt }] }],
            config: {
                systemInstruction: `Architekta UI PESAM. Wybierz jedno narzędzie wizualne z gotowymi danymi. aiMessage = czysty tekst, zero kodu.`,
                temperature: 0.0,
                tools: [{ functionDeclarations: [TOOL_RENDER_CHART, TOOL_RENDER_TABLE, TOOL_RENDER_KPI] }]
            }
        });
        trackTokens(presenterRes);

        // =====================================================================
        // PARSOWANIE ODPOWIEDZI
        // =====================================================================
        let textMessage = 'Analiza zakończona. Wyniki na panelu.';
        let uiAction = null;

        if (presenterRes.functionCalls?.length) {
            const call = presenterRes.functionCalls[0];
            const args = call.args as any;
            textMessage = args.aiMessage || extractCleanSummary(mathResults);

            switch (call.name) {
                case 'renderChartWidget':
                    uiAction = { type: 'chart', payload: args };
                    logs.push(`[Agent 3] ✓ Wykres "${args.title}" (${args.chartType})`);
                    break;
                case 'renderTableWidget':
                    uiAction = { type: 'table', payload: args };
                    logs.push(`[Agent 3] ✓ Tabela "${args.title}" (${args.rows?.length || 0} wierszy)`);
                    break;
                case 'renderKpiWidget':
                    uiAction = { type: 'kpi', payload: args };
                    logs.push(`[Agent 3] ✓ KPI "${args.title}" (${args.metrics?.length || 0} wskaźników)`);
                    break;
                default:
                    logs.push(`[Agent 3] ⚠ Nieznane narzędzie: ${call.name}`);
            }
        } else {
            textMessage = extractCleanSummary(mathResults);
            logs.push('[Agent 3] ⚠ Brak narzędzia — odpowiedź tekstowa');
        }

        logs.push(`[Tokeny] Input: ${sessionInputTokens}, Output: ${sessionOutputTokens}`);

        return NextResponse.json({
            message: textMessage,
            uiAction,
            logs,
            usage: { input: sessionInputTokens, output: sessionOutputTokens }
        }, { status: 200 });

    } catch (error: any) {
        console.error('[PESAM AI Error]', error);
        logs.push(`[BŁĄD] ${error?.message || 'Nieznany błąd'}`);
        return NextResponse.json({
            error: error?.message || 'Błąd systemu analitycznego',
            logs,
            usage: { input: sessionInputTokens, output: sessionOutputTokens }
        }, { status: 500 });
    }
}