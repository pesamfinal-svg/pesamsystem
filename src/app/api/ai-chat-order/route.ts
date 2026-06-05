// src/app/api/ai-chat-order/route.ts
import { NextResponse } from 'next/server';
import { GoogleGenAI, Type } from '@google/genai';

const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || 'pesam-system-81165',
    location: 'global'
});

export const maxDuration = 60; // AI z Pythonem potrzebuje czasem chwili

export async function POST(req: Request) {
    try {
        const { history, currentText, currentAudioBase64 } = await req.json();

        const systemInstruction = `
            Jesteś Głównym Kosztorysantem Budowlanym w firmie PESAM. Prowadzisz wywiad z kierownikiem budowy, aby wyliczyć i skompletować dla niego dokładną listę materiałów.
            
            TWOJE ZASADY:
            1. Pytaj o szczegóły: Jeśli kierownik mówi "chcę ściankę z regipsów", dopytaj o długość, wysokość, grubość profilu (50/75/100), rodzaj płyty (zwykła/zielona/ogień) i czy wełna w środek.
            2. Python (Kalkulator): Do wszelkich wyliczeń zużycia (np. ile sztuk profili CD, ile m2 płyty, ile kg gipsu) UŻYWAJ PYTHONA. Znasz normy budowlane (np. profile co 60cm).
            3. Jeśli wciąż zbierasz dane -> zostaw tablicę 'generatedItems' PUSTĄ, a w 'reply' zadaj pytanie.
            4. Jeśli wyliczyłeś wszystko i zadanie jest gotowe -> w 'reply' podsumuj wyliczenia (np. "Na ściankę 10m2 potrzebujesz..."), a w tablicy 'generatedItems' podaj gotową listę.
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
                temperature: 0.2,
                tools: [{ codeExecution: {} }], // URUCHAMIAMY PYTHONA!
                responseMimeType: "application/json",
                responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                        reply: {
                            type: Type.STRING,
                            description: "Twoja odpowiedź dla kierownika. Widzi ją w oknie czatu."
                        },
                        generatedItems: {
                            type: Type.ARRAY,
                            description: "Wypełnij TO TYLKO, jeśli masz już komplet danych i wygenerowałeus listę. Inaczej zostaw puste.",
                            items: {
                                type: Type.OBJECT,
                                properties: {
                                    name: { type: Type.STRING, description: "Pełna nazwa rynkowa np. 'Płyta G-K typ A'" },
                                    quantity: { type: Type.INTEGER, description: "Wyliczona ilość (Zawsze zaokrąglaj w górę do pełnych sztuk/opakowań)" },
                                    unit: { type: Type.STRING, description: "Jednostka np. 'szt.', 'worki 25kg', 'rolki'" }
                                }
                            }
                        }
                    },
                    required: ["reply", "generatedItems"]
                }
            }
        });

        if (response.text) {
            let aiText = response.text.trim().replace(/```json/g, '').replace(/```/g, '').trim();
            return NextResponse.json(JSON.parse(aiText), { status: 200 });
        } else {
            throw new Error("Pusta odpowiedź z API");
        }
    } catch (err: any) {
        console.error("Błąd AI Czatu:", err);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}