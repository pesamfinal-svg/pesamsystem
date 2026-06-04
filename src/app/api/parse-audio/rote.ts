// src/app/api/parse-audio/route.ts
import { NextResponse } from 'next/server';
import { GoogleGenAI, Type } from '@google/genai';

const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || 'pesam-system-81165',
    location: 'global'
});

export const maxDuration = 60;

export async function POST(req: Request) {
    try {
        const { audioUrl } = await req.json();

        if (!audioUrl) {
            return NextResponse.json({ error: "Brak linku do pliku audio" }, { status: 400 });
        }

        const audioResponse = await fetch(audioUrl);
        const arrayBuffer = await audioResponse.arrayBuffer();
        const base64Audio = Buffer.from(arrayBuffer).toString('base64');

        const systemInstruction = `
            Jesteś inżynierem budownictwa i doradcą ds. zaopatrzenia w PESAM. 
            Twoim zadaniem jest odsłuchanie nagrania głosowego i wyciągnięcie z niego pozycji zakupowych i sprzętowych.
            
            Bezwzględnie podziel każdą pozycję na jeden z dwóch typów ('type'):
            1. 'WAREHOUSE' - dla elektronarzędzi, maszyn, rusztowań, szalunków, narzędzi ręcznych (rzeczy wielorazowe, które firma ma na stanie magazynowym).
            2. 'PURCHASE' - dla materiałów budowlanych, chemii, wkrętów, płyt g-k, gipsu, kabli (materiały jednorazowe, zużywalne, które musimy kupić na zewnątrz).

            DLA POZYCJI TYPU 'PURCHASE':
            Wygeneruj tablicę 'suggestions' zawierającą 3-4 najbardziej prawdopodobne, dokładne polskie specyfikacje handlowe (wymiary, rodzaje, standardy rynkowe), aby użytkownik mógł wybrać właściwy produkt.

            DLA POZYCJI TYPU 'WAREHOUSE':
            Zwróć w 'suggestions' pustą tablicę. Twoim zadaniem jest podanie w 'roughName' prostej, standardowej nazwy urządzenia (np. 'Szlifierka kątowa', 'Wiertarka udarowa'), która ułatwi wyszukanie jej w naszym katalogu.
        `;

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [
                {
                    role: 'user',
                    parts: [
                        { text: "Przeanalizuj nagranie audio z budowy, sklasyfikuj pozycje i wygeneruj profesjonalne sugestie techniczne." },
                        {
                            inlineData: {
                                mimeType: "audio/mp3",
                                data: base64Audio
                            }
                        }
                    ]
                }
            ],
            config: {
                systemInstruction: systemInstruction,
                temperature: 0.1,
                responseMimeType: "application/json",
                responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                        items: {
                            type: Type.ARRAY,
                            description: "Lista pozycji wyodrębnionych z nagrania.",
                            items: {
                                type: Type.OBJECT,
                                properties: {
                                    roughName: {
                                        type: Type.STRING,
                                        description: "Nazwa usłyszana z nagrania, np. 'regipsy', 'szlifierka'."
                                    },
                                    quantity: {
                                        type: Type.INTEGER,
                                        description: "Liczba sztuk / opakowań."
                                    },
                                    unit: {
                                        type: Type.STRING,
                                        description: "Jednostka miary (np. sztuka, karton, worek, opakowanie)."
                                    },
                                    type: {
                                        type: Type.STRING,
                                        description: "Wybierz 'WAREHOUSE' (sprzęt, rusztowania, narzędzia) lub 'PURCHASE' (materiały budowlane, wkręty, regipsy)."
                                    },
                                    suggestions: {
                                        type: Type.ARRAY,
                                        description: "Dla typu 'PURCHASE': 3-4 rynkowe specyfikacje. Dla typu 'WAREHOUSE': pusta tablica.",
                                        items: { type: Type.STRING }
                                    }
                                },
                                required: ["roughName", "quantity", "unit", "type", "suggestions"]
                            }
                        }
                    },
                    required: ["items"]
                }
            }
        });

        if (response.text) {
            let aiText = response.text.trim();
            aiText = aiText.replace(/```json/g, '').replace(/```/g, '').trim();
            const parsedJson = JSON.parse(aiText);
            return NextResponse.json(parsedJson, { status: 200 });
        } else {
            throw new Error("Pusta odpowiedź z API");
        }

    } catch (err: any) {
        console.error("Błąd transkrypcji audio:", err);
        return NextResponse.json({ error: err.message || "Błąd wewnętrzny" }, { status: 500 });
    }
}