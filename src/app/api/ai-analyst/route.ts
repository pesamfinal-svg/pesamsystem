// src/app/api/ai-analyst/route.ts
import { NextResponse } from 'next/server';
import { GoogleGenAI, Type } from '@google/genai';
import { db } from "@/lib/firebase/config"; // Import Twojej bazy danych
import { collection, getDocs, query, where } from "firebase/firestore";

const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || 'pesam-system-81165',
    location: 'global'
});

export const maxDuration = 60;

// =========================================================================
// 1. BEZPOŚREDNIE FUNKCJE BAZODANOWE (Wywoływane przez serwer na żądanie AI)
// =========================================================================

// Pobiera listę samochodów (tylko podstawowe metadane, bez śmieci)
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

// Pobiera historię napraw (opcjonalnie przefiltrowaną dla konkretnego pojazdu)
async function dbGetRepairs(vehicleId?: string) {
    let q = query(collection(db, "repairs"));
    if (vehicleId) {
        q = query(collection(db, "repairs"), where("vehicleId", "==", vehicleId));
    }
    const snap = await getDocs(q);
    return snap.docs.map(doc => {
        const data = doc.data();
        return {
            id: doc.id,
            vehicleId: data.vehicleId,
            cost: data.cost || 0,
            date: data.date,
            repairType: data.repairType || "Inna",
            comments: data.comments || ""
        };
    });
}

// =========================================================================
// 2. DEFINICJE NARZĘDZI DLA MODELI AI
// =========================================================================

// Narzędzie pobierania aut dla Flasha i Pro
const GET_VEHICLES_TOOL = {
    name: "fetchVehiclesFromDB",
    description: "Pobiera aktualną listę pojazdów z bazy danych Firestore (zwraca id, markę, model i rejestrację). Użyj tego, gdy musisz dowiedzieć się, jakimi pojazdami dysponujemy.",
    parameters: { type: Type.OBJECT, properties: {} }
};

// Narzędzie pobierania napraw dla Pro
const GET_REPAIRS_TOOL = {
    name: "fetchRepairsFromDB",
    description: "Pobiera listę napraw i kosztów z bazy danych Firestore. Możesz opcjonalnie podać 'vehicleId', aby pobrać historię tylko jednego auta.",
    parameters: {
        type: Type.OBJECT,
        properties: {
            vehicleId: { type: Type.STRING, description: "ID konkretnego pojazdu (opcjonalnie)." }
        }
    }
};

const RENDER_CHART_TOOL = {
    name: "renderChartWidget",
    description: "Generuje interaktywny wykres na ekranie obok.",
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

// =========================================================================
// 3. GŁÓWNY ROUTE POST
// =========================================================================
export async function POST(req: Request) {
    try {
        // DODANO cachedData do pobierania z frontu
        const { question, currentHistory, cachedData } = await req.json();

        const historyText = currentHistory.map((msg: any) => `${msg.role === 'user' ? 'Użytkownik' : 'AI'}: ${msg.text}`).join('\n');

        // ==========================================
        // ETAP 1: AGENT 1 (Recepcjonista 3.5-flash) - Odpytuje bazę o listę aut, jeśli trzeba
        // ==========================================
        let routerResponse = await ai.models.generateContent({
            model: 'gemini-3.5-flash',
            contents: [
                { role: 'user', parts: [{ text: `Oto nasza rozmowa:\n${historyText}\n\nUżytkownik pisze: "${question}"` }] }
            ],
            config: {
                systemInstruction: "Jesteś asystentem Floty PESAM. Odpowiadaj naturalnie. Jeśli użytkownik zadaje pytanie dotyczące floty, a Ty jeszcze nie pobrałeś listy pojazdów, ZAWSZE najpierw wywołaj narzędzie 'fetchVehiclesFromDB'. Gdy już znasz pojazdy, zaproponuj użytkownikowi uściślenie (np. konkretne auto), a gdy poda szczegóły lub od razu chce pełnych statystyk, powiedz, że przekazujesz sprawę do analizy kosztów.",
                temperature: 0.3,
                tools: [{ functionDeclarations: [GET_VEHICLES_TOOL] }]
            }
        });

        // Obsługa wywołania narzędzia przez Flasha (pobieranie aut z Firestore)
        if (routerResponse.functionCalls?.some(call => call.name === "fetchVehiclesFromDB")) {
            const vehiclesList = await dbGetVehiclesList();

            // Odsyłamy dane z Firestore z powrotem do Flasha, żeby mógł dokończyć wypowiedź
            routerResponse = await ai.models.generateContent({
                model: 'gemini-3.5-flash',
                contents: [
                    { role: 'user', parts: [{ text: `Oto nasza rozmowa:\n${historyText}\n\nUżytkownik pisze: "${question}"` }] },
                    { role: 'model', parts: [{ functionCall: { name: "fetchVehiclesFromDB", args: {} } }] },
                    { role: 'user', parts: [{ text: `Oto wynik z bazy danych Firestore: ${JSON.stringify(vehiclesList)}` }] }
                ],
                config: {
                    systemInstruction: "Znasz już listę pojazdów z bazy. Użyj tych danych, by mądrze dopytać użytkownika, o co dokładnie mu chodzi, podając przykłady aut i ich rejestracji z bazy.",
                    temperature: 0.3
                }
            });
        }

        // Sprawdzamy, czy musimy uruchomić Ciężką Analizę
        // Flash decyduje się na przekazanie sprawy, jeśli użytkownik podał konkrety lub chce analizy całej floty
        const isRequestingAnalysis = question.toLowerCase().includes("koszt") ||
            question.toLowerCase().includes("wykres") ||
            question.toLowerCase().includes("analiz") ||
            currentHistory.length > 2; // Po uściśleniu na czacie

        if (!isRequestingAnalysis) {
            return NextResponse.json({
                message: routerResponse.text || "W czym mogę pomóc?",
                uiAction: null
            }, { status: 200 });
        }

        // ==========================================
        // ETAP 2: AGENT 2 (Analityk Pro 3.1) - Pobiera naprawy z Firestore i generuje wykres
        // ==========================================

        // Jeśli mamy dane w pamięci podręcznej (z poprzedniego pytania), dajemy je AI
        const cacheString = cachedData && Object.keys(cachedData).length > 0
            ? `Oto dane pobrane z bazy w poprzednim kroku: ${JSON.stringify(cachedData)}. Użyj ich, zamiast odpytywać bazę ponownie (chyba że użytkownik prosi o zupełnie inne pojazdy).`
            : `Nie masz jeszcze pobranych żadnych danych z bazy. Musisz użyć narzędzi.`;

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
                systemInstruction: "Jesteś PESAM AI Data Analyst. Najpierw musisz pobrać dane z bazy za pomocą 'fetchVehiclesFromDB' oraz 'fetchRepairsFromDB'. Do obliczania średnich, sum, podatków i trudniejszej matematyki ZAWSZE pisz kod w języku Python (zostanie automatycznie wykonany). Na koniec wygeneruj wykres za pomocą 'renderChartWidget'.",
                temperature: 0.0,
                tools: [
                    { functionDeclarations: [GET_VEHICLES_TOOL, GET_REPAIRS_TOOL, RENDER_CHART_TOOL] },
                    { codeExecution: {} }
                ]
            }
        });

        // PĘTLA OBSŁUGI NARZĘDZI DLA ANALITYKA (AI odpytuje bazę w locie)
        let executionLimit = 3; // Bezpiecznik przed nieskończonymi zapytaniami
        let currentSessionCache = cachedData || {}; // Tworzymy bufor pamięci

        while (analystResponse.functionCalls && analystResponse.functionCalls.length > 0 && executionLimit > 0) {
            const call = analystResponse.functionCalls[0];
            executionLimit--;

            let resultData: any = {};

            if (call.name === "fetchVehiclesFromDB") {
                resultData = await dbGetVehiclesList();
                currentSessionCache.vehicles = resultData; // Zapisujemy do pamięci
            } else if (call.name === "fetchRepairsFromDB") {
                const args = call.args as { vehicleId?: string };
                resultData = await dbGetRepairs(args.vehicleId);
                currentSessionCache.repairs = resultData; // Zapisujemy do pamięci
            } else if (call.name === "renderChartWidget") {
                break;
            }

            // Przesyłamy wynik zapytania SQL/Firestore z powrotem do AI
            analystResponse = await ai.models.generateContent({
                model: 'gemini-3.1-pro-preview',
                contents: [
                    { role: 'user', parts: [{ text: analystPrompt }] },
                    { role: 'model', parts: [{ functionCall: call }] },
                    { role: 'user', parts: [{ text: `Wynik z bazy danych dla ${call.name}: ${JSON.stringify(resultData)}` }] }
                ],
                config: {
                    systemInstruction: "Przeanalizuj otrzymane z bazy rekordy. Wykorzystaj Pythona do obliczeń, a następnie wygeneruj ostateczny wykres przy użyciu 'renderChartWidget'.",
                    temperature: 0.0,
                    tools: [
                        { functionDeclarations: [GET_VEHICLES_TOOL, GET_REPAIRS_TOOL, RENDER_CHART_TOOL] },
                        { codeExecution: {} }
                    ]
                }
            });
        }

        // Końcowe renderowanie wykresu
        let textMessage = analystResponse.text || "Zakończyłem analizę.";
        let uiAction = null;

        if (analystResponse.functionCalls && analystResponse.functionCalls.length > 0) {
            const call = analystResponse.functionCalls[0];
            if (call.name === "renderChartWidget" && call.args) {
                const args = call.args as { chartType: string; title: string; datasetLabel: string; labels: string[]; values: number[]; };
                uiAction = {
                    type: "chart",
                    payload: {
                        chartType: args.chartType,
                        title: args.title,
                        datasetLabel: args.datasetLabel,
                        labels: args.labels,
                        values: args.values,
                        colors: args.labels.map(() => `#${Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0')}`)
                    }
                };
                textMessage = `Sporządziłem wykres: "${args.title}". Wynik znajdziesz na panelu.`;
            }
        }

        // DODANO: Zwracamy currentSessionCache do Frontendu
        return NextResponse.json({ message: textMessage, uiAction, newCache: currentSessionCache }, { status: 200 });

    } catch (error: any) {
        console.error("Błąd AI:", error);
        return NextResponse.json({ error: error.message || "Błąd analityki AI" }, { status: 500 });
    }
}