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
        const { photoBase64, mimeType = 'image/jpeg', residualNotes = '', declaredItems = [] } = await req.json();

        if (!photoBase64) {
            return NextResponse.json({ error: "Brak zdjęcia do weryfikacji" }, { status: 400 });
        }

        const cleanBase64 = photoBase64.includes(',') ? photoBase64.split(',')[1] : photoBase64;

        const systemInstruction = `
            Jesteś rzetelnym, technicznym audytorem i rzeczoznawcą magazynu budowlanego PESAM.
            Twoim celem jest obiektywne porównanie zdjęcia z paki samochodu dostawczego lub palety zadeklarowanego zwrotu z deklaracją tekstową kierownika budowy.
            
            Kierownik zgłasza zwrot pozostałości materiałowych i sprzętu.
            Musisz ustalić:
            1. Czy to, co widać na zdjęciu, odpowiada temu, co wpisał kierownik?
            2. Czy widać ewidentne braki (np. zgłoszono 4 worki, a na zdjęciu leżą tylko 2)?
            3. Czy widać przedmioty uszkodzone, zanieczyszczone, odpady lub śmieci?
            4. Werdykt:
               - "ZGODNE": stan wizualny z grubsza pokrywa się ze zgłoszeniem.
               - "ROZBIEŻNOŚCI": ewidentny brak deklarowanych materiałów lub zupełnie inne przedmioty.
               - "UWAGI": materiały widoczne, ale np. w złym stanie, otwarte, niekompletne lub trudne do precyzyjnego policzenia ze zdjęcia.
        `;

        const promptText = `
Zbadaj to zdjęcie i porównaj z deklaracją kierownika budowy:

NOTATKA KIEROWNIKA O POZOSTAŁOŚCIACH:
"${residualNotes || 'Brak wpisanej notatki'}"

${declaredItems && declaredItems.length > 0 ? `POZOSTAŁE POZYCJE PROTOKOŁU:\n- ${declaredItems.join('\n- ')}` : ''}

Podaj werdykt, podsumowanie (2-3 konkretne zdania po polsku), listę rozpoznanych na zdjęciu materiałów/obiektów oraz zalecenie dla magazyniera odbierającego dostawę.
        `.trim();

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [
                {
                    role: 'user',
                    parts: [
                        {
                            inlineData: {
                                mimeType,
                                data: cleanBase64
                            }
                        },
                        { text: promptText }
                    ]
                }
            ],
            config: {
                systemInstruction,
                temperature: 0.1,
                responseMimeType: "application/json",
                responseSchema: {
                    type: "OBJECT",
                    properties: {
                        verdict: {
                            type: "STRING",
                            description: "Wartość: 'ZGODNE', 'ROZBIEŻNOŚCI' lub 'UWAGI'"
                        },
                        summary: {
                            type: "STRING",
                            description: "Zwięzłe, rzeczowe podsumowanie po polsku opisujące zgodność zdjęcia z deklaracją"
                        },
                        detectedItems: {
                            type: "ARRAY",
                            items: { type: "STRING" },
                            description: "Lista przedmiotów/materiałów zauważonych na zdjęciu"
                        },
                        recommendations: {
                            type: "STRING",
                            description: "Krótka wskazówka dla magazyniera przy odbiorze (np. 'Przelicz worki, sprawdź czy wiadro nie jest puste')"
                        }
                    },
                    required: ["verdict", "summary", "detectedItems", "recommendations"]
                }
            }
        });

        const rawText = response.text?.trim() || "{}";
        const parsed = JSON.parse(rawText);

        return NextResponse.json(parsed);
    } catch (error: any) {
        console.error("Błąd podczas weryfikacji zdjęcia przez AI:", error);
        return NextResponse.json({ error: error.message || "Błąd analizy obrazu" }, { status: 500 });
    }
}
