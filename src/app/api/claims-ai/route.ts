// src/app/api/claims-ai/route.ts
import { NextResponse } from 'next/server';
import { VertexAI } from '@google-cloud/vertexai';

export async function POST(req: Request) {
    try {
        const payload = await req.json();
        const { inventoryName, messages, isInitial } = payload;

        console.log("--- Vertex AI (Gemini) Request ---");
        console.log("isInitial:", isInitial);
        console.log("inventoryName:", inventoryName);
        console.log("Project ID:", process.env.GCP_PROJECT_ID);

        // Inicjalizacja Vertex AI (Używa ADC - Application Default Credentials)
        // Musisz mieć ustawioną zmienną GOOGLE_APPLICATION_CREDENTIALS w systemie lub .env.local
        const vertexAI = new VertexAI({
            project: process.env.GCP_PROJECT_ID || 'pesam-system-81165',
            location: 'europe-west1'
        });

        // Fragment w src/app/api/claims-ai/route.ts
        const model = vertexAI.getGenerativeModel({
            model: 'gemini-2.5-flash', // ZMIANA: Model Flash jest znacznie szybszy do krótkich zadań
            systemInstruction: {
                role: 'system',
                parts: [{
                    text: `Jesteś bezwzględnym Asystentem Śledczym PESAM. 
            Twoim zadaniem jest SZYBKIE wydobycie prawdy od kierownika.
            ZASADY:
            1. Nie pisz długich listów. Pisz krótko, surowo i technicznie.
            2. Zadaj MAKSYMALNIE 2-3 konkretne pytania o osprzęt, zasilanie lub błędy operatora.
            3. Nie używaj uprzejmości. 
            4. Jeśli to wezwanie początkowe, od razu uderzaj w czułe punkty urządzenia (np. przekrój kabla przy spalonym silniku).`
                }]
            }
        });

        if (isInitial) {
            const prompt = `Zgłoszono zniszczenie urządzenia: ${inventoryName}. Wygeneruj pierwsze, surowe wezwanie do wyjaśnień dla kierownika. Zapytaj o osprzęt, DTR i zdjęcia.`;
            const result = await model.generateContent(prompt);
            const response = await result.response;
            const text = response.candidates?.[0]?.content?.parts?.[0]?.text || "Brak odpowiedzi AI.";
            return NextResponse.json({ reply: text });
        }

        // Analiza toczącej się rozmowy
        const formattedHistory = (messages || []).map((m: any) =>
            `[${m.senderRole}] ${m.senderName}: ${m.text}`
        ).join("\n\n");

        const prompt = `Oto przebieg dotychczasowej rozmowy w sprawie szkody:\n\n${formattedHistory}\n\nPrzeanalizuj tłumaczenia kierownika. Gdzie kłamie lub kręci? Wypunktuj niespójności i podpowiedz Dyrektorowi następne miażdżące pytanie.`;

        console.log("Sending prompt to Vertex AI...");
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.candidates?.[0]?.content?.parts?.[0]?.text || "Brak odpowiedzi AI.";
        console.log("Vertex AI response received.");

        return NextResponse.json({ reply: text });

    } catch (error: any) {
        console.error("--- Błąd Vertex AI Detail ---");
        console.error(error);
        return NextResponse.json({ error: error.message || "Błąd wewnętrzny Vertex AI" }, { status: 500 });
    }
}