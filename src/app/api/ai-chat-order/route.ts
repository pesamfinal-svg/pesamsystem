// src/app/api/ai-chat-order/route.ts
import { NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || 'pesam-system-81165',
    location: 'global'
});

export const maxDuration = 60; // AI z Pythonem potrzebuje czasem chwili na uruchomienie kodu

export async function POST(req: Request) {
    try {
        const { history, currentText, currentAudioBase64 } = await req.json();

        const systemInstruction = `
            Jesteś Głównym Kosztorysantem Budowlanym w firmie PESAM. Prowadzisz wywiad z kierownikiem budowy, aby wyliczyć i skompletować dla niego dokładną listę materiałów.
            
            TWOJE ZASADY:
            1. Pytaj o szczegóły: Jeśli kierownik mówi "chcę ściankę z regipsów", dopytaj o długość, wysokość, grubość profilu (50/75/100), rodzaj płyty (zwykła/zielona/ogień) i czy wełna w środek.
            2. Python (Kalkulator): Do wszelkich wyliczeń zużycia (np. ile sztuk profili CD, ile m2 płyty, ile kg gipsu) UŻYWAJ PYTHONA. Znasz normy budowlane (np. profile co 60cm).
            3. Twoja odpowiedź musi być ZAWSZE poprawnym i czystym obiektem JSON zawierającym dwa pola:
               - "reply": Twoja wiadomość tekstowa do kierownika (odpowiedź, podsumowanie obliczeń lub dodatkowe pytania).
               - "generatedItems": Tablica z wyliczonymi materiałami (jeśli masz komplet danych). Jeśli wciąż pytasz o szczegóły, tablica musi być pusta: [].
            
            Struktura pojedynczego elementu w "generatedItems":
            { "name": "Pełna nazwa rynkowa", "quantity": 10, "unit": "szt." }

            BEZWZGLĘDNY WARUNEK: Zwróć tylko i wyłącznie poprawny obiekt JSON. Nie pisz żadnego tekstu wstępnego, nie dodawaj komentarzy poza strukturą JSON.
        `;

        // Budujemy historię dla modelu
        const contents: any[] = history.map((msg: any) => ({
            role: msg.role === 'ai' ? 'model' : 'user',
            parts: [{ text: msg.content }]
        }));

        // Dodajemy aktualną wiadomość (Tekst lub Głos)
        const currentParts: any[] = [];
        if (currentText) currentParts.push({ text: currentText });
        if (currentAudioBase64) {
            currentParts.push({ text: "Odsłuchaj nagranie od kierownika:" });
            currentParts.push({
                inlineData: {
                    mimeType: "audio/mp3",
                    data: currentAudioBase64
                }
            });
        }
        
        contents.push({ role: 'user', parts: currentParts });

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: contents,
            config: {
                systemInstruction: systemInstruction,
                temperature: 0.1, // Bardzo niska temperatura, aby AI ściśle trzymała się formatu JSON
                tools: [{ codeExecution: {} }] // ZOSTAWIAMY PYTHONA! (responseSchema usunięte z konfiguracji)
            }
        });

        if (response.text) {
            let aiText = response.text.trim();
            
            // Oczyszczamy odpowiedź na wypadek, gdyby AI mimo wszystko ubrała JSON w znaczniki markdownu (```json ... ```)
            aiText = aiText.replace(/```json/gi, '').replace(/```/gi, '').trim();
            
            try {
                const parsedJson = JSON.parse(aiText);
                return NextResponse.json(parsedJson, { status: 200 });
            } catch (parseErr) {
                console.error("Błąd parsowania JSON z odpowiedzi AI. Surowy tekst:", aiText);
                
                // Bezpieczny fallback na wypadek gdyby model wygenerował surowy tekst zamiast JSONa
                return NextResponse.json({
                    reply: aiText || "Mam problem z przetworzeniem tych obliczeń. Podaj wymiary ponownie.",
                    generatedItems: []
                }, { status: 200 });
            }
        } else {
            throw new Error("Pusta odpowiedź z API");
        }
    } catch (err: any) {
        console.error("Błąd AI Czatu:", err);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}