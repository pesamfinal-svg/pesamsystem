import { NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || 'pesam-system-81165',
    location: 'global'
});

export const maxDuration = 60;

export async function POST(req: Request) {
    try {
        const { text } = await req.json();

        if (!text || typeof text !== 'string' || !text.trim()) {
            return NextResponse.json({ error: "Brak tekstu do analizy" }, { status: 400 });
        }

        const systemInstruction = `
            Jesteś bardzo doświadczonym asystentem magazynu budowlanego PESAM.
            Kierownik budowy wpisał jednym ciągiem potoczną notatkę o zwracanych pozostałościach budowlanych, resztkach, otwartych workach, napoczętych wiadrach itp.
            
            Twoim zadaniem jest przekształcić tę notatkę w ustrukturyzowaną listę pozycji:
            - name: Czytelna, profesjonalna nazwa materiału (np. "Cement (otwarty / resztka)", "Płyta G-K (regips)", "Klej do siatki", "Gładź szpachlowa").
            - quantity: Liczba (jeśli np. "3 worki po połowie" to podaj 3 lub oszacowaną ilość, np. 3 z opisem w condition).
            - unit: Jednostka (np. "worki", "szt.", "wiadra", "kg", "m²", "opak.").
            - condition: Stan/stopień zużycia (np. "otwarty / ok. 50%", "pęknięta", "resztka na dnie", "pełne", "otwarte").
            - isWaste: boolean - czy z opisu ewidentnie wynika, że to gruz, śmieci, ścinki nie do ponownego użycia (np. "resztki połamanych płyt", "resztki gruzu", "wyschnięta piana").
        `;

        const prompt = `Przeanalizuj poniższą notatkę kierownika budowy i wyodrębnij pozycje w formacie JSON:\n\n"${text.trim()}"`;

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [
                {
                    role: 'user',
                    parts: [{ text: prompt }]
                }
            ],
            config: {
                systemInstruction,
                temperature: 0.1,
                responseMimeType: "application/json",
                responseSchema: {
                    type: "OBJECT",
                    properties: {
                        items: {
                            type: "ARRAY",
                            items: {
                                type: "OBJECT",
                                properties: {
                                    name: { type: "STRING" },
                                    quantity: { type: "NUMBER" },
                                    unit: { type: "STRING" },
                                    condition: { type: "STRING" },
                                    isWaste: { type: "BOOLEAN" }
                                },
                                required: ["name", "quantity", "unit", "condition", "isWaste"]
                            }
                        }
                    },
                    required: ["items"]
                }
            }
        });

        const rawText = response.text?.trim() || "{}";
        const parsed = JSON.parse(rawText);

        return NextResponse.json({ items: parsed.items || [] });
    } catch (error: any) {
        console.error("Błąd podczas parsowania pozostałości budowlanych:", error);
        return NextResponse.json({ error: error.message || "Błąd analizy AI" }, { status: 500 });
    }
}
