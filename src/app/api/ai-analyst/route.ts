// src/app/api/ai-analyst/route.ts
import { NextResponse } from 'next/server';
import { GoogleGenAI, Type } from '@google/genai';
import { db } from "@/lib/firebase/config";
import * as admin from 'firebase-admin';

const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || 'pesam-system-81165',
    location: 'global'
});

export const maxDuration = 60;

if (!admin.apps.length) {
    admin.initializeApp();
}
const adminDb = admin.firestore();

// =========================================================================
// FUNKCJA POMOCNICZA: AUTOMATYCZNA SAMONAPRAWA DLA LIMITÓW 429 (BACKOFF)
// =========================================================================
async function generateContentWithRetry(params: any, retries = 3, delay = 1000): Promise<any> {
    try {
        return await ai.models.generateContent(params);
    } catch (error: any) {
        const isRateLimit = error.message?.includes("429") ||
            error.message?.includes("RESOURCE_EXHAUSTED") ||
            error.status === 429 ||
            error.code === 429;

        if (isRateLimit && retries > 0) {
            await new Promise(resolve => setTimeout(resolve, delay));
            return generateContentWithRetry(params, retries - 1, delay * 2);
        }
        throw error;
    }
}

// =========================================================================
// BEZPOŚREDNIE FUNKCJE BAZODANOWE (Wywoływane przez serwer)
// =========================================================================
async function dbGetVehiclesList() {
    const snap = await adminDb.collection("vehicles").get();
    return snap.docs.map(doc => {
        const data = doc.data();
        return {
            id: doc.id,
            brand: data.brand || "Nieznany",
            model: data.model || "Nieznany",
            registration: data.registration || "Brak tablic",
            initialMileage: data.initialMileage || 0 // DODANO: Przebieg początkowy pojazdu
        };
    });
}

async function dbGetRepairs(vehicleId?: string, vehicleIds?: string[]) {
    let allDocs: any[] = [];

    if (vehicleId) {
        const snap = await adminDb.collection("repairs").where("vehicleId", "==", vehicleId).get();
        allDocs = snap.docs;
    } else if (vehicleIds && Array.isArray(vehicleIds) && vehicleIds.length > 0) {
        const chunks = [];
        for (let i = 0; i < vehicleIds.length; i += 30) {
            chunks.push(vehicleIds.slice(i, i + 30));
        }

        const snapPromises = chunks.map(chunk => adminDb.collection("repairs").where("vehicleId", "in", chunk).get());
        const snaps = await Promise.all(snapPromises);
        allDocs = snaps.flatMap(snap => snap.docs);
    } else {
        const snap = await adminDb.collection("repairs").get();
        allDocs = snap.docs;
    }

    return allDocs.map((doc: any) => {
        const data = doc.data();

        let rawCost = data.cost;
        let parsedCost = 0;
        if (typeof rawCost === 'number') {
            parsedCost = rawCost;
        } else if (typeof rawCost === 'string') {
            parsedCost = parseFloat(rawCost.replace(/[^0-9.]/g, '')) || 0;
        }

        return {
            id: doc.id,
            vehicleId: data.vehicleId || null,
            cost: parsedCost,
            date: data.date || "Brak daty",
            category: data.category || data.repairType || "Inna",
            comments: data.comments || "",
            location: data.location || "Nieznany warsztat",
            mileage: data.mileage || 0 // DODANO: Przebieg pojazdu podczas naprawy
        };
    });
}

// =========================================================================
// DEFINICJE NARZĘDZI DLA MODELI AI (FUNCTION CALLING)
// =========================================================================
const GET_VEHICLES_TOOL = {
    name: "fetchVehiclesFromDB",
    description: "Pobiera listę pojazdów z bazy danych Firestore.",
    parameters: { type: Type.OBJECT, properties: {} }
};

const GET_REPAIRS_TOOL = {
    name: "fetchRepairsFromDB",
    description: "Pobiera listę napraw i kosztów z bazy danych Firestore. Możesz podać jedno 'vehicleId' lub tablicę 'vehicleIds' dla grupy pojazdów.",
    parameters: {
        type: Type.OBJECT,
        properties: {
            vehicleId: { type: Type.STRING, description: "ID konkretnego pojazdu (opcjonalnie)." },
            vehicleIds: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description: "Tablica ID pojazdów (opcjonalnie, np. gdy filtrujesz grupę aut danej marki)."
            }
        }
    }
};

const RENDER_CHART_TOOL = {
    name: "renderChartWidget",
    description: "Generuje interaktywny wykres.",
    parameters: {
        type: Type.OBJECT,
        properties: {
            chartType: { type: Type.STRING, description: "Typ: 'bar', 'pie', 'line'." },
            title: { type: Type.STRING, description: "Tytuł wykresu." },
            datasetLabel: { type: Type.STRING, description: "Opis danych, np. Koszt PLN." },
            labels: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Etykiety osi X." },
            values: { type: Type.ARRAY, items: { type: Type.NUMBER }, description: "Wartości osi Y." }
        },
        required: ["chartType", "title", "labels", "values", "datasetLabel"]
    }
};

const RENDER_TABLE_TOOL = {
    name: "renderTableWidget",
    description: "Generuje tabelę danych. Użyj, gdy użytkownik prosi o 'listę', 'ranking', 'zestawienie'.",
    parameters: {
        type: Type.OBJECT,
        properties: {
            title: { type: Type.STRING, description: "Tytuł tabeli (np. 'Najdroższe naprawy')." },
            columns: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Nazwy kolumn." },
            rows: {
                type: Type.ARRAY,
                description: "Wiersze tabeli (tablica w tablicy).",
                items: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                    description: "Pojedynczy wiersz tabeli."
                }
            }
        },
        required: ["title", "columns", "rows"]
    }
};

const RENDER_KPI_TOOL = {
    name: "renderKpiWidget",
    description: "Generuje kafelki statystyczne (Kluczowe Wskaźniki). Użyj do pojedynczych liczb, np. sum, średnich.",
    parameters: {
        type: Type.OBJECT,
        properties: {
            title: { type: Type.STRING, description: "Tytuł podsumowania." },
            metrics: {
                type: Type.ARRAY,
                description: "Obiekty z metrykami.",
                items: {
                    type: Type.OBJECT,
                    properties: {
                        label: { type: Type.STRING, description: "Krótki opis liczby." },
                        value: { type: Type.STRING, description: "Wartość." }
                    },
                    required: ["label", "value"]
                }
            }
        },
        required: ["title", "metrics"]
    }
};

const DELEGATE_ANALYSIS_TOOL = {
    name: "delegateToDataAnalyst",
    description: "Wywołaj to narzędzie ZAWSZE, gdy użytkownik prosi o zestawienie, historię napraw, statystyki, koszty, tabele lub wykresy i wiesz już, dla jakiego pojazdu to zrobić. Uruchomi to Głównego Analityka.",
    parameters: { type: Type.OBJECT, properties: {} }
};

// =========================================================================
// 3. GŁÓWNY ROUTE POST
// =========================================================================
export async function POST(req: Request) {
    const logs: string[] = [];
    try {
        const { question, currentHistory, cachedData } = await req.json();

        const historyText = currentHistory.map((msg: any) => `${msg.role === 'user' ? 'Użytkownik' : 'AI'}: ${msg.text}`).join('\n');

        // ==========================================
        // ETAP 1: AGENT 1 (Recepcjonista 3.5-flash)
        // ==========================================
        logs.push("Uruchomiono Agenta Recepcjonistę (Gemini 3.5 Flash)");

        let isRequestingAnalysis = false;

        let routerResponse = await generateContentWithRetry({
            model: 'gemini-3.5-flash',
            contents: [
                { role: 'user', parts: [{ text: `Oto nasza rozmowa:\n${historyText}\n\nUżytkownik pisze: "${question}"` }] }
            ],
            config: {
                systemInstruction: "Jesteś asystentem Floty PESAM. Odpowiadaj naturalnie. 1) Jeśli pytania dotyczą floty, ZAWSZE najpierw wywołaj 'fetchVehiclesFromDB'. 2) Jeśli wiesz, jakiego auta/aut dotyczy rozmowa, a użytkownik prosi o wyciągnięcie danych (historia, koszty, naprawy, tabele), MUSISZ wywołać narzędzie 'delegateToDataAnalyst'. Wtedy dopisz krótką wiadomość: 'Przekazuję do analityka...'",
                temperature: 0.1,
                tools: [{ functionDeclarations: [GET_VEHICLES_TOOL, DELEGATE_ANALYSIS_TOOL] }]
            }
        });

        let calls = routerResponse.functionCalls || [];

        if (calls.some((c: any) => c.name === "delegateToDataAnalyst")) {
            isRequestingAnalysis = true;
        }

        if (calls.some((c: any) => c.name === "fetchVehiclesFromDB")) {
            const call = calls.find((c: any) => c.name === "fetchVehiclesFromDB")!;
            logs.push("Flash: Sprawdzam bazę pojazdów Firestore...");
            const vehiclesList = await dbGetVehiclesList();

            const callAny = call as any;
            const partAny = (routerResponse.candidates?.[0]?.content?.parts?.[0]) as any;
            const flashSig = callAny.thoughtSignature || partAny?.thoughtSignature || "skip_thought_signature_validator";

            routerResponse = await generateContentWithRetry({
                model: 'gemini-3.5-flash',
                contents: [
                    { role: 'user', parts: [{ text: `Oto nasza rozmowa:\n${historyText}\n\nUżytkownik pisze: "${question}"` }] },
                    { role: 'model', parts: [{ functionCall: { name: call.name, args: call.args }, thoughtSignature: flashSig }] },
                    { role: 'user', parts: [{ functionResponse: { name: "fetchVehiclesFromDB", response: { vehicles: vehiclesList } } }] }
                ],
                config: {
                    systemInstruction: "Znasz już auta. Jeśli zapytanie wskazuje na chęć uzyskania konkretnych danych/historii z bazy napraw, UŻYJ narzędzia 'delegateToDataAnalyst'. Jeśli brakuje Ci danych (np. nie wiesz, który to Opel), dopytaj użytkownika tekstowo.",
                    temperature: 0.1,
                    tools: [{ functionDeclarations: [DELEGATE_ANALYSIS_TOOL] }]
                }
            });

            calls = routerResponse.functionCalls || [];
            if (calls.some((c: any) => c.name === "delegateToDataAnalyst")) {
                isRequestingAnalysis = true;
            }
        }

        // Jeśli to tylko zwykłe uściślanie / pogaduszki
        if (!isRequestingAnalysis) {
            logs.push("Recepcjonista uznał, że to tylko rozmowa lub doprecyzowanie. Nie uruchamia Głównego Analityka.");
            return NextResponse.json({
                message: routerResponse.text || "W czym mogę pomóc?",
                uiAction: null,
                logs
            }, { status: 200 });
        }

        // ==========================================
        // ETAP 2: AGENT 2 (Analityk Pro 3.1)
        // ==========================================
        logs.push("Przekazano sprawę do Głównego Analityka (Gemini 3.1 Pro)");

        const cacheString = cachedData && Object.keys(cachedData).length > 0
            ? `W pamięci podręcznej (Cache) posiadasz dane pobrane w poprzednim kroku: ${JSON.stringify(cachedData)}. Użyj ich TYLKO wtedy, gdy pasują do aktualnego zapytania. Jeśli użytkownik pyta o inne auto lub w Cache nie ma wystarczających danych, MUSISZ zignorować ten Cache i użyć narzędzi ('fetchVehiclesFromDB', 'fetchRepairsFromDB'), aby pobrać z bazy nowe rekordy!`
            : `Nie masz jeszcze pobranych żadnych danych z bazy. Aby przeanalizować flotę, wywołaj niezbędne narzędzia (fetchVehiclesFromDB, fetchRepairsFromDB).`;

        if (cachedData && Object.keys(cachedData).length > 0) {
            logs.push("Analityk: Przeskanowano lokalną pamięć podręczną (Cache)...");
        }

        const analystPrompt = `
            Użytkownik prosi o: "${question}"
            Kontekst rozmowy:
            ${historyText}
            
            ${cacheString}
        `;

        // INICJALIZACJA HISTORII CZATU DLA ANALITYKA PRO (contents)
        const analystContents: any[] = [
            { role: 'user', parts: [{ text: analystPrompt }] }
        ];

        let analystResponse = await generateContentWithRetry({
            model: 'gemini-3.1-pro-preview',
            contents: analystContents,
            config: {
                systemInstruction: "Jesteś PESAM AI Data Analyst. Najpierw upewnij się, że masz potrzebne dane (z cache lub pobierając z bazy). Do obliczania średnich, sum, podatków i skomplikowanej matematyki ZAWSZE pisz kod w języku Python (zostanie automatycznie wykonany). Na koniec zdecyduj i użyj jednego z narzędzi wizualnych: 'renderChartWidget' (dla wykresów), 'renderTableWidget' (dla list/rankingów) lub 'renderKpiWidget' (dla kilku kluczowych liczb/podsumowań).",
                temperature: 0.0,
                tools: [
                    { functionDeclarations: [GET_VEHICLES_TOOL, GET_REPAIRS_TOOL, RENDER_CHART_TOOL, RENDER_TABLE_TOOL, RENDER_KPI_TOOL] },
                    { codeExecution: {} }
                ]
            }
        });

        let executionLimit = 3;
        let currentSessionCache = cachedData || {};

        while (analystResponse.functionCalls && analystResponse.functionCalls.length > 0 && executionLimit > 0) {
            const call = analystResponse.functionCalls[0];
            executionLimit--;

            let resultData: any = {};
            let responsePayload: any = {};

            if (call.name === "fetchVehiclesFromDB") {
                logs.push("Analityk Pro: Pobieram listę pojazdów z bazy danych...");
                resultData = await dbGetVehiclesList();
                currentSessionCache.vehicles = resultData;
                responsePayload = { vehicles: resultData };
                logs.push(`Analityk Pro: Zaimportowano ${resultData.length} pojazdów.`);
            } else if (call.name === "fetchRepairsFromDB") {
                const args = call.args as { vehicleId?: string; vehicleIds?: string[] };
                logs.push(`Analityk Pro: Wykryto zapytanie o naprawy. Pobieram dane z Firestore...`);
                resultData = await dbGetRepairs(args.vehicleId, args.vehicleIds);
                currentSessionCache.repairs = resultData;
                responsePayload = { repairs: resultData };
                logs.push(`Analityk Pro: Pobrano ${resultData.length} wpisów serwisowych.`);
            }
            else if (call.name === "renderChartWidget" || call.name === "renderTableWidget" || call.name === "renderKpiWidget") {
                break;
            }

            const callAny = call as any;
            const partAny = (analystResponse.candidates?.[0]?.content?.parts?.[0]) as any;

            const originalSig = callAny.thoughtSignature ||
                partAny?.thoughtSignature ||
                "skip_thought_signature_validator";

            // AKUMULACJA: Dodajemy ruch modelu z wywołaniem funkcji do historii
            analystContents.push({
                role: 'model',
                parts: [{
                    functionCall: { name: call.name, args: call.args },
                    thoughtSignature: originalSig
                }]
            });

            // AKUMULACJA: Dodajemy naszą odpowiedź z danymi z Firestore do historii
            analystContents.push({
                role: 'user',
                parts: [{
                    functionResponse: {
                        name: call.name,
                        response: responsePayload
                    }
                }]
            });

            // Odsłanie wyników bazy do AI
            analystResponse = await generateContentWithRetry({
                model: 'gemini-3.1-pro-preview',
                contents: analystContents,
                config: {
                    systemInstruction: "Przeanalizuj otrzymane z bazy rekordy. Wykorzystaj Pythona do obliczeń matematycznych. Gdy będziesz gotowy, wygeneruj odpowiedni widget wizualny (Wykres, Tabelę lub KPI) za pomocą dostępnych narzędzi renderujących.",
                    temperature: 0.0,
                    tools: [
                        { functionDeclarations: [GET_VEHICLES_TOOL, GET_REPAIRS_TOOL, RENDER_CHART_TOOL, RENDER_TABLE_TOOL, RENDER_KPI_TOOL] },
                        { codeExecution: {} }
                    ]
                }
            });

            // Przechwycenie tekstu objaśniającego plan działania i kroki pośrednie AI
            if (analystResponse.text) {
                logs.push(`Plan AI: ${analystResponse.text}`);
            }
        }

        // Sprawdzenie, czy Gemini uruchomiło kod w piaskownicy Pythona
        const candidateParts = analystResponse.candidates?.[0]?.content?.parts || [];
        const ranPython = candidateParts.some((part: any) => part.executableCode || part.codeExecutionResult);
        if (ranPython) {
            logs.push("Analityk Pro: Uruchomiono Piaskownicę Pythona (Google Sandbox). Dokonano precyzyjnych obliczeń matematycznych.");
        }

        // ==========================================
        // ETAP 3: Przechwycenie wygenerowanego UI
        // ==========================================
        let textMessage = analystResponse.text || "Zakończyłem analizę.";
        let uiAction = null;

        if (analystResponse.functionCalls && analystResponse.functionCalls.length > 0) {
            const call = analystResponse.functionCalls[0];

            if (call.name === "renderChartWidget" && call.args) {
                const args = call.args as any;
                uiAction = {
                    type: "chart",
                    payload: {
                        ...args,
                        colors: args.labels?.map(() => `#${Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0')}`)
                    }
                };
                logs.push(`Analityk Pro: Wygenerowano żądanie renderowania wykresu: "${args.title}"`);
                textMessage = `Sporządziłem wykres: "${args.title}". Wynik znajdziesz na panelu obok.`;
            }
            else if (call.name === "renderTableWidget" && call.args) {
                const args = call.args as any;
                uiAction = {
                    type: "table",
                    payload: args
                };
                logs.push(`Analityk Pro: Wygenerowano żądanie renderowania tabeli: "${args.title}"`);
                textMessage = `Wygenerowałem szczegółową tabelę: "${args.title}". Spójrz na panel wizualizacji.`;
            }
            else if (call.name === "renderKpiWidget" && call.args) {
                const args = call.args as any;
                uiAction = {
                    type: "kpi",
                    payload: args
                };
                logs.push(`Analityk Pro: Wygenerowano żądanie renderowania kafelków statystycznych: "${args.title}"`);
                textMessage = `Oto najważniejsze wskaźniki liczbowe dotyczące Twojego zapytania. Spójrz na kafelki podsumowujące.`;
            }
        }

        return NextResponse.json({
            message: textMessage,
            uiAction: uiAction,
            newCache: currentSessionCache,
            logs
        }, { status: 200 });

    } catch (error: any) {
        console.error("Błąd AI:", error);
        logs.push(`KRYTYCZNY BŁĄD PROCESU: ${error.message || "Nieznany błąd"}`);
        return NextResponse.json({ error: error.message || "Błąd analityki AI", logs }, { status: 500 });
    }
}