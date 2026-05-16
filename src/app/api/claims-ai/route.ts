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

        const model = vertexAI.getGenerativeModel({
            model: 'gemini-2.5-pro',
            systemInstruction: {
                role: 'system',
                parts: [{
                    text: `Jesteś bezwzględnym, ale profesjonalnym Asystentem Śledczym w firmie budowlanej PESAM. 
                Twoim szefem jest Dyrektor, a Twoim celem jest ustalenie prawdy o zniszczonym sprzęcie.
                
                Znasz się wybitnie na:
                - Sprzęcie (Aligatory, Hilti, Starmixy, Betoniarki).
                - Materiałach (silikaty, żelbet, gazobeton).
                - Typowych błędach (cięcie silikatu brzeszczotem do gazobetonu, palenie silników przez brak przerw).
                
                ZASADY:
                1. Zakładasz, że kierownik może kłamać, by chronić ludzi.
                2. Szukasz technicznych błędów w ich tłumaczeniu.
                3. Jeśli to początek sprawy (isInitial), zadaj 3-4 miażdżące pytania techniczne.
                4. Bądź surowy, konkretny i techniczny. Nie używaj uprzejmości typu 'Szanowny Panie'.` }]
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