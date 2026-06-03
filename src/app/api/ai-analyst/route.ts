// src/app/api/ai-analyst/route.ts
import { NextResponse } from 'next/server';
import { GoogleGenAI, Type } from '@google/genai';

const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || 'pesam-system-81165',
    location: 'global'
});

export const maxDuration = 60;

// --- Narzędzie dla Agenta 1 (Recepcjonisty) ---
const TRIGGER_ANALYST_TOOL = {
    name: "triggerDataAnalyst",
    description: "Użyj tego narzędzia DOPIERO WTEDY, gdy użytkownik wyraźnie sprecyzuje swoje żądanie (np. odpowie na Twoje pytanie doprecyzowujące) lub wyda jednoznaczną komendę typu 'Pokaż wykres dla wszystkich', 'Zrób zestawienie kosztów Mercedesa'.",
    parameters: { type: Type.OBJECT, properties: {} }
};

// --- Narzędzie dla Agenta 2 (Analityka Pro) ---
const RENDER_CHART_TOOL = {
    name: "renderChartWidget",
    description: "Użyj tej funkcji, aby wygenerować interaktywny wykres na interfejsie użytkownika.",
    parameters: {
        type: Type.OBJECT,
        properties: {
            chartType: { type: Type.STRING, description: "Typ: 'bar', 'pie', 'line'." },
            title: { type: Type.STRING, description: "Tytuł wykresu." },
            datasetLabel: { type: Type.STRING, description: "Etykieta danych (np. Koszt PLN)." },
            labels: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Oś X (kategorie)." },
            values: { type: Type.ARRAY, items: { type: Type.NUMBER }, description: "Oś Y (wartości)." }
        },
        required: ["chartType", "title", "labels", "values", "datasetLabel"]
    }
};

export async function POST(req: Request) {
    try {
        const { question, fleetData, currentHistory } = await req.json();

        // 1. GENEROWANIE "LEKKIEGO KONTEKSTU" DLA AGENTA 1
        const vehicles = fleetData?.vehicles || [];
        const uniqueBrands = [...new Set(vehicles.map((v: any) => v.brand))].filter(Boolean).join(', ');
        // Bierzemy max 10 pojazdów do pokazania w kontekście, żeby go nie przepełnić, jeśli aut są setki
        const sampleVehicles = vehicles.slice(0, 10).map((v: any) => `${v.brand} ${v.model} (${v.registration})`).join(', ');

        const lightContext = `
            STAN FLOTY PESAM:
            - Łącznie pojazdów: ${fleetData?.vehiclesCount || 0}
            - Dostępne marki: ${uniqueBrands || "brak danych"}
            - Przykładowe pojazdy w bazie: ${sampleVehicles || "brak danych"}
            - Zarejestrowanych napraw/kosztów: ${fleetData?.repairsCount || 0}
        `;

        // Formatowanie historii rozmowy
        const historyText = currentHistory.map((msg: any) => `${msg.role === 'user' ? 'Użytkownik' : 'AI'}: ${msg.text}`).join('\n');

        // ==========================================
        // ETAP 1: AGENT MĄDRY RECEPCJONISTA (3.5 Flash)
        // Zna nazwy i marki aut, ale nie ma dostępu do kosztów napraw.
        // ==========================================
        const flashInstruction = `
            Jesteś asystentem AI ds. Floty PESAM. Twój cel to zrozumienie, jakich danych potrzebuje użytkownik.
            Oto Twoja podstawowa wiedza o flocie:
            ${lightContext}
            
            ZASADY:
            1. Znasz marki i rejestracje, ale NIE MASZ dostępu do kosztów, faktur i historii awarii. Od tego jest narzędzie "triggerDataAnalyst".
            2. Jeśli użytkownik pisze ogólnikowo (np. "Pokaż koszty", "Jakie mamy awarie?"), ZAPYTAJ GO, czy chodzi mu o całą flotę, czy o konkretną markę lub pojazd (podaj mu przykłady z Twojej bazy, np. "Mogę to sprawdzić. Chcesz statystyki dla wszystkich aut, czy np. tylko dla Forda WX123?").
            3. Jeśli zapytanie jest precyzyjne od początku (np. "Pokaż mi koszty dla wszystkich", "Jak psuje się Iveco?") LUB użytkownik właśnie odpowiedział na Twoje pytanie - UŻYJ narzędzia triggerDataAnalyst natychmiast!
        `;

        const routerResponse = await ai.models.generateContent({
            model: 'gemini-3.5-flash',
            contents: [
                { role: 'user', parts: [{ text: `Oto nasza dotychczasowa rozmowa:\n${historyText}\n\nTeraz użytkownik pisze: "${question}"` }] }
            ],
            config: {
                systemInstruction: flashInstruction,
                temperature: 0.4, // Zwiększamy nieco temperaturę, żeby rozmowa była bardziej naturalna
                tools: [{ functionDeclarations: [TRIGGER_ANALYST_TOOL] }]
            }
        });

        const needsAnalysis = routerResponse.functionCalls?.some(call => call.name === "triggerDataAnalyst");

        if (!needsAnalysis) {
            // Flash odpowiada tekstem, bo chce dopytać użytkownika (np. "Czy chodzi Ci o całą flotę, czy tylko o markę Fiat?")
            return NextResponse.json({
                message: routerResponse.text || "W czym mogę pomóc?",
                uiAction: null
            }, { status: 200 });
        }

        // ==========================================
        // ETAP 2: AGENT ANALITYK (3.1 Pro Preview)
        // Włącza się tylko wtedy, gdy Flash uzna, że żądanie jest jasne.
        // ==========================================
        const analystPrompt = `
            Oto PEŁNA BAZA DANYCH floty w formacie JSON ze wszystkimi naprawami i kosztami:
            ${JSON.stringify(fleetData)}
            
            Ostatnie wiadomości z czatu dla kontekstu zadania:
            ${historyText}
            
            Zadanie od użytkownika brzmi: "${question}"
        `;

        const analystResponse = await ai.models.generateContent({
            model: 'gemini-3.1-pro-preview',
            contents: [
                { role: 'user', parts: [{ text: analystPrompt }] }
            ],
            config: {
                systemInstruction: "Jesteś PESAM AI Data Analyst. Analizujesz ciężki JSON. Gdy padnie prośba o podsumowanie kosztów, awarii lub statystyk wizualnych, ZAWSZE używaj narzędzia 'renderChartWidget', by wygenerować wykres (najlepiej typu 'bar' dla porównań lub 'pie' dla udziałów procentowych). Bądź bardzo precyzyjny w obliczeniach.",
                temperature: 0.0, // Absolutne zero dla twardej matematyki - zero halucynacji
                tools: [{ functionDeclarations: [RENDER_CHART_TOOL] }]
            }
        });

        let textMessage = "Przeanalizowałem dane.";
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
                textMessage = `Przeanalizowałem naszą bazę i wygenerowałem wykres: "${args.title}". Wyniki wyświetliłem na panelu obok. Zgadza się z tym o co prosiłeś?`;
            }
        } else if (analystResponse.text) {
            textMessage = analystResponse.text;
        }

        return NextResponse.json({
            message: textMessage,
            uiAction: uiAction
        }, { status: 200 });

    } catch (error: any) {
        console.error("Błąd AI:", error);
        return NextResponse.json({ error: error.message || "Błąd analityki AI" }, { status: 500 });
    }
}