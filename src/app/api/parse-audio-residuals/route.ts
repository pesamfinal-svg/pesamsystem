// src/app/api/parse-audio-residuals/route.ts
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
        if (!audioResponse.ok) {
            return NextResponse.json({ error: "Nie udało się pobrać pliku audio" }, { status: 400 });
        }

        const arrayBuffer = await audioResponse.arrayBuffer();
        const base64Audio = Buffer.from(arrayBuffer).toString('base64');

        const systemInstruction = `
            Jesteś inżynierem budowlanym i pracownikiem magazynu firmy PESAM.
            Twoim zadaniem jest odsłuchanie notatki głosowej nagranej przez kierowcę na budowie.
            Kierowca wymienia resztki budowlane, pozostałości materiałów, chemię budowlaną, profile, worki z klejem/gipsem, końcówki kabli itp., które zabiera z budowy do magazynu lub do utylizacji.

            Zadanie:
            Wyodrębnij z nagrania wszystkie wymienione pozycje materiałowe.
            Dla każdej pozycji ustal:
            1. 'name' - czytelna, standardowa polska nazwa materiału (np. 'Worek kleju do siatki', 'Profile sufitowe CD60 3m', 'Resztka farby białej gruntującej')
            2. 'quantity' - liczba sztuk, opakowań, worków, metrów (jeśli nie podano precyzyjnie liczby, przyjmij 1)
            3. 'unit' - jednostka miary: 'szt.', 'worek', 'opak.', 'mb', 'kg', 'm²', 'litr', 'wiaderko'
            4. 'isWaste' - wartość boolean: true jeśli kierowca mówi o śmieciach, zniszczonych odpadach, resztkach nienadających się do użycia; false jeśli materiał jest pełnowartościowy / użyteczny do ponownego wykorzystania.
        `;

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [
                {
                    role: 'user',
                    parts: [
                        { text: "Przeanalizuj nagranie audio kierowcy z budowy i wyodrębnij listę resztek i pozostałości materiałowych." },
                        {
                            inlineData: {
                                mimeType: "audio/webm",
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
                        residuals: {
                            type: Type.ARRAY,
                            description: "Lista rozpoznanych resztek budowlanych z nagrania.",
                            items: {
                                type: Type.OBJECT,
                                properties: {
                                    name: {
                                        type: Type.STRING,
                                        description: "Nazwa materiału lub resztki budowlanej."
                                    },
                                    quantity: {
                                        type: Type.NUMBER,
                                        description: "Ilość materiału."
                                    },
                                    unit: {
                                        type: Type.STRING,
                                        description: "Jednostka miary (np. szt., worek, opak., mb, kg, litr)."
                                    },
                                    isWaste: {
                                        type: Type.BOOLEAN,
                                        description: "Czy jest to odpad do utylizacji."
                                    }
                                },
                                required: ["name", "quantity", "unit", "isWaste"]
                            }
                        }
                    },
                    required: ["residuals"]
                }
            }
        });

        if (response.text) {
            let aiText = response.text.trim();
            aiText = aiText.replace(/```json/g, '').replace(/```/g, '').trim();
            const parsedJson = JSON.parse(aiText);
            return NextResponse.json(parsedJson, { status: 200 });
        } else {
            return NextResponse.json({ residuals: [] }, { status: 200 });
        }

    } catch (err: any) {
        console.error("Błąd transkrypcji audio pozostałości:", err);
        return NextResponse.json({ 
            residuals: [],
            warning: "Błąd transkrypcji AI: " + (err.message || "Błąd wewnętrzny")
        }, { status: 200 }); // Zwracamy status 200 z pustą listą, aby nie blokować kierowcy
    }
}
