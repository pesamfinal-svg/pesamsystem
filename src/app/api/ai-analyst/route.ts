// src/app/api/ai-analyst/route.ts
import { NextResponse } from 'next/server';
import { GoogleGenAI, Type } from '@google/genai';
import { db } from "@/lib/firebase/config";
import { collection, getDocs, query, where } from "firebase/firestore";

const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || 'pesam-system-81165',
    location: 'global' // Upewnij się, że lokalizacja zgadza się z wdrożeniami (np. global lub europe-west4)
});

export const maxDuration = 60;

// =========================================================================
// 1. BEZPOŚREDNIE FUNKCJE BAZODANOWE (Wywoływane przez serwer)
// =========================================================================
async function dbGetVehiclesList() {
    const snap = await getDocs(collection(db, "vehicles"));
    return snap.docs.map(doc => {
        const data = doc.data();
        return {
            id: doc.id,
            brand: data.brand || "Nieznany",
            model: data.model || "Nieznany",
            registration: data.registration || "Brak tablic"
        };
    });
}

async function dbGetRepairs(vehicleId?: string) {
    let q = query(collection(db, "repairs"));
    if (vehicleId) {
        q = query(collection(db, "repairs"), where("vehicleId", "==", vehicleId));
    }
    const snap = await getDocs(q);
    return snap.docs.map(doc => {
        const data = doc.data();

        // Bezpieczne parsowanie ceny (obsługuje liczby, stringi oraz puste wartości)
        let rawCost = data.cost;
        let parsedCost = 0;
        if (typeof rawCost === 'number') {
            parsedCost = rawCost;
        } else if (typeof rawCost === 'string') {
            parsedCost = parseFloat(rawCost.replace(/[^0-9.]/g, '')) || 0;
        }

        return {
            id: doc.id,
            vehicleId: data.vehicleId || null, // Jeśli stary wpis nie ma przypisanego auta, nie wywali błędu
            cost: parsedCost,
            date: data.date || "Brak daty",
            // Dostosowano do Twoich pól z bazy: 'category' oraz 'location'
            category: data.category || data.repairType || "Inna",
            comments: data.comments || "",
            location: data.location || "Nieznany warsztat"
        };
    });
}

// =========================================================================
// 2. DEFINICJE NARZĘDZI DLA MODELI AI (FUNCTION CALLING)
// =========================================================================
const GET_VEHICLES_TOOL = {
    name: "fetchVehiclesFromDB",
    description: "Pobiera listę pojazdów z bazy danych Firestore (zwraca id, markę, model, rejestrację).",
    parameters: { type: Type.OBJECT, properties: {} }
};

const GET_REPAIRS_TOOL = {
    name: "fetchRepairsFromDB",
    description: "Pobiera listę napraw i kosztów z bazy danych Firestore. Możesz opcjonalnie podać 'vehicleId'.",
    parameters: {
        type: Type.OBJECT,
        properties: {
            vehicleId: { type: Type.STRING, description: "ID konkretnego pojazdu (opcjonalnie)." }
        }
    }
};

const RENDER_CHART_TOOL = {
    name: "renderChartWidget",
    description: "Generuje interaktywny wykres. Używaj do porównań i udziałów procentowych.",
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
            columns: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Nazwy kolumn (np. ['Pojazd', 'Koszt'])." },
            rows: {
                type: Type.ARRAY,
                description: "Wiersze tabeli (tablica w tablicy).",
                // DODANO: Poniższe pole items naprawia błąd INVALID_ARGUMENT dla Google API
                items: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                    description: "Pojedynczy wiersz zawierający komórki z tekstem."
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
            title: { type: Type.STRING, description: "Tytuł podsumowania (np. 'Ogólne statystyki')." },
            metrics: {
                type: Type.ARRAY,
                description: "Obiekty z metrykami.",
                items: {
                    type: Type.OBJECT,
                    properties: {
                        label: { type: Type.STRING, description: "Krótki opis liczby (np. 'Łączny koszt')." },
                        value: { type: Type.STRING, description: "Wartość (np. '14 500 PLN')." }
                    },
                    required: ["label", "value"]
                }
            }
        },
        required: ["title", "metrics"]
    }
};

// =========================================================================
// 3. GŁÓWNY ROUTE POST
// =========================================================================
export async function POST(req: Request) {
    try {
        const { question, currentHistory, cachedData } = await req.json();

        const historyText = currentHistory.map((msg: any) => `${msg.role === 'user' ? 'Użytkownik' : 'AI'}: ${msg.text}`).join('\n');

        // ==========================================
        // ETAP 1: AGENT 1 (Recepcjonista 3.5-flash) 
        // ==========================================
        let routerResponse = await ai.models.generateContent({
            model: 'gemini-3.5-flash',
            contents: [
                { role: 'user', parts: [{ text: `Oto nasza rozmowa:\n${historyText}\n\nUżytkownik pisze: "${question}"` }] }
            ],
            config: {
                systemInstruction: "Jesteś asystentem Floty PESAM. Odpowiadaj naturalnie. Jeśli użytkownik pyta o flotę, a w historii rozmowy nie ma jeszcze listy pojazdów z bazy, ZAWSZE wywołaj narzędzie 'fetchVehiclesFromDB'. Gdy znasz pojazdy, dopytaj użytkownika o szczegóły (np. konkretne auto). Gdy padnie konkretne zapytanie analityczne (koszty, wykresy, uściślenie), poinformuj, że przekazujesz sprawę do Głównego Analityka i zakończ wypowiedź.",
                temperature: 0.3,
                tools: [{ functionDeclarations: [GET_VEHICLES_TOOL] }]
            }
        });

        // Jeśli Flash użyje narzędzia do pobrania aut
        // Jeśli Flash użyje narzędzia do pobrania aut
        if (routerResponse.functionCalls?.some(call => call.name === "fetchVehiclesFromDB")) {
            const vehiclesList = await dbGetVehiclesList();

            routerResponse = await ai.models.generateContent({
                model: 'gemini-3.5-flash',
                contents: [
                    { role: 'user', parts: [{ text: `Użytkownik pisze: "${question}"` }] },
                    { role: 'model', parts: [{ functionCall: { name: "fetchVehiclesFromDB", args: {} } }] },
                    // Techniczne przekazanie wyniku funkcji - Gemini traktuje to jako twarde fakty bazodanowe
                    {
                        role: 'user',
                        parts: [{
                            functionResponse: {
                                name: "fetchVehiclesFromDB",
                                response: { vehicles: vehiclesList }
                            }
                        }]
                    }
                ],
                config: {
                    systemInstruction: "Jesteś asystentem Floty PESAM. Masz przed sobą RZECZYWISTE dane z bazy Firestore. Twoim jedynym zadaniem jest dopytać, o które auto chodzi. Musisz użyć TYLKO I WYŁĄCZNIE pojazdów, które faktycznie istnieją w przesłanej liście (np. FORD TRANSIT o rejestracji RDE 90WP). Pod rygorem błędu zabrania się wymyślania jakichkolwiek przykładowych modeli (Focus, Mondeo) lub rejestracji (KR 12345, WI 98765), których nie ma w przesłanej bazie.",
                    temperature: 0.1 // Obniżamy temperaturę, by wykluczyć kreatywność
                }
            });
        }

        // Router decyduje: pogaduszki, czy ciężka analiza?
        const isRequestingAnalysis = question.toLowerCase().includes("koszt") ||
            question.toLowerCase().includes("wykres") ||
            question.toLowerCase().includes("analiz") ||
            question.toLowerCase().includes("zrób") ||
            question.toLowerCase().includes("tabel") ||
            question.toLowerCase().includes("pokaż") ||
            currentHistory.length > 2;

        if (!isRequestingAnalysis) {
            return NextResponse.json({
                message: routerResponse.text || "W czym mogę pomóc?",
                uiAction: null
            }, { status: 200 });
        }

        // ==========================================
        // ETAP 2: AGENT 2 (Analityk Pro 3.1)
        // ==========================================

        // Zarządzanie pamięcią podręczną
        const cacheString = cachedData && Object.keys(cachedData).length > 0
            ? `Oto dane pobrane z bazy w poprzednim kroku: ${JSON.stringify(cachedData)}. Użyj ich, zamiast odpytywać bazę ponownie (chyba że użytkownik prosi o zupełnie inne pojazdy).`
            : `Nie masz jeszcze pobranych żadnych danych z bazy. Jeśli potrzebujesz aut lub napraw, użyj odpowiednich narzędzi (fetchVehiclesFromDB, fetchRepairsFromDB).`;

        const analystPrompt = `
            Użytkownik prosi o: "${question}"
            Kontekst rozmowy:
            ${historyText}
            
            ${cacheString}
        `;

        let analystResponse = await ai.models.generateContent({
            model: 'gemini-3.1-pro-preview',
            contents: [{ role: 'user', parts: [{ text: analystPrompt }] }],
            config: {
                systemInstruction: "Jesteś PESAM AI Data Analyst. Najpierw upewnij się, że masz potrzebne dane (z cache lub pobierając z bazy). Do obliczania średnich, sum, podatków i skomplikowanej matematyki ZAWSZE pisz kod w języku Python (zostanie automatycznie wykonany). Na koniec zdecyduj i użyj jednego z narzędzi wizualnych: 'renderChartWidget' (dla wykresów), 'renderTableWidget' (dla list/rankingów) lub 'renderKpiWidget' (dla kilku kluczowych liczb/podsumowań).",
                temperature: 0.0,
                tools: [
                    { functionDeclarations: [GET_VEHICLES_TOOL, GET_REPAIRS_TOOL, RENDER_CHART_TOOL, RENDER_TABLE_TOOL, RENDER_KPI_TOOL] },
                    { codeExecution: {} }
                ]
            }
        });

        // PĘTLA OBSŁUGI NARZĘDZI (Baza Danych & Generowanie Interfejsu)
        let executionLimit = 3;
        let currentSessionCache = cachedData || {};

        while (analystResponse.functionCalls && analystResponse.functionCalls.length > 0 && executionLimit > 0) {
            const call = analystResponse.functionCalls[0];
            executionLimit--;

            let resultData: any = {};

            // Obsługa narzędzi bazodanowych
            if (call.name === "fetchVehiclesFromDB") {
                resultData = await dbGetVehiclesList();
                currentSessionCache.vehicles = resultData;
            } else if (call.name === "fetchRepairsFromDB") {
                const args = call.args as { vehicleId?: string };
                resultData = await dbGetRepairs(args.vehicleId);
                currentSessionCache.repairs = resultData;
            }
            // Przerwanie pętli, jeśli AI generuje już komponent UI
            else if (call.name === "renderChartWidget" || call.name === "renderTableWidget" || call.name === "renderKpiWidget") {
                break;
            }

            // Odsłanie wyników bazy do AI (aby AI kontynuowało analizę)
            analystResponse = await ai.models.generateContent({
                model: 'gemini-3.1-pro-preview',
                contents: [
                    { role: 'user', parts: [{ text: analystPrompt }] },
                    { role: 'model', parts: [{ functionCall: call }] },
                    { role: 'user', parts: [{ text: `Wynik z bazy danych dla ${call.name}: ${JSON.stringify(resultData)}` }] }
                ],
                config: {
                    systemInstruction: "Przeanalizuj otrzymane z bazy rekordy. Wykorzystaj Pythona do obliczeń matematycznych. Gdy będziesz gotowy, wygeneruj odpowiedni widget wizualny (Wykres, Tabelę lub KPI) za pomocą dostępnych narzędzi renderujących.",
                    temperature: 0.0,
                    tools: [
                        { functionDeclarations: [GET_VEHICLES_TOOL, GET_REPAIRS_TOOL, RENDER_CHART_TOOL, RENDER_TABLE_TOOL, RENDER_KPI_TOOL] },
                        { codeExecution: {} }
                    ]
                }
            });
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
                textMessage = `Sporządziłem wykres: "${args.title}". Wynik znajdziesz na panelu obok.`;
            }
            else if (call.name === "renderTableWidget" && call.args) {
                const args = call.args as any;
                uiAction = {
                    type: "table",
                    payload: args
                };
                textMessage = `Wygenerowałem szczegółową tabelę: "${args.title}". Spójrz na panel wizualizacji.`;
            }
            else if (call.name === "renderKpiWidget" && call.args) {
                const args = call.args as any;
                uiAction = {
                    type: "kpi",
                    payload: args
                };
                textMessage = `Oto najważniejsze wskaźniki liczbowe dotyczące Twojego zapytania. Spójrz na kafelki podsumowujące.`;
            }
        }

        return NextResponse.json({
            message: textMessage,
            uiAction: uiAction,
            newCache: currentSessionCache
        }, { status: 200 });

    } catch (error: any) {
        console.error("Błąd AI:", error);
        return NextResponse.json({ error: error.message || "Błąd analityki AI" }, { status: 500 });
    }
}