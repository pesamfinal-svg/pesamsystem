import { NextResponse } from 'next/server';
import { GoogleGenAI, Type } from '@google/genai';

const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || 'pesam-system-81165',
    location: 'global'
});

export async function POST(req: Request) {
    try {
        const { items } = await req.json();

        if (!items || items.length === 0) {
            return NextResponse.json({ error: "Koszyk jest pusty" }, { status: 400 });
        }

        const systemInstruction = `
            Jesteś bardzo doświadczonym Inżynierem Budowy PESAM. 
            Analizujesz koszyk z materiałami i sugerujesz braki technologiczne.

            ZASADY DLA SUGESTII (Domówień):
            Jeśli brakuje kluczowych elementów do systemu (np. zaprawa do cegieł, wkręty i gips do G-K), zaproponuj je.
            Dla KAŻDEJ sugestii podaj jej logiczną jednostkę rynkową w polu 'unit' (np. "szt.", "worki 25kg", "rolki").

            ZASADY DLA NORMALIZACJI (BARDZO WAŻNE):
            Masz SUROWY ZAKAZ poprawiania pozycji, które są zrozumiałe dla budowlańca.
            Zignoruj i ZOSTAW W SPOKOJU pozycje, jeśli zawierają słowa: "Profil", "Wkręt", "Płyta", lub wymiary (np. 50x50, 3m, 0.6mm). Nikogo nie obchodzi, czy jest napisane 50x50 czy 50/50.
            Użyj normalizacji TYLKO dla skrajnego slangu z placu budowy (np. zmień "pchełki" na "Wkręty typu pchełka", "regipsy" na "Płyta G-K", "piana" na "Pianka montażowa", "esy" na "Wieszak ES").
        `;

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [
                {
                    role: 'user',
                    parts: [
                        { text: `Przeanalizuj ten koszyk.\nZawartość:\n- ${items.join("\n- ")}` }
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
                        analysis: { type: Type.STRING },
                        systemsIdentified: { type: Type.ARRAY, items: { type: Type.STRING } },
                        suggestedItems: {
                            type: Type.ARRAY,
                            items: {
                                type: Type.OBJECT,
                                properties: {
                                    name: { type: Type.STRING },
                                    unit: { type: Type.STRING }
                                }
                            }
                        },
                        normalizedItems: {
                            type: Type.ARRAY,
                            items: {
                                type: Type.OBJECT,
                                properties: {
                                    original: { type: Type.STRING },
                                    professional: { type: Type.STRING }
                                }
                            }
                        }
                    },
                    required: ["analysis", "systemsIdentified", "suggestedItems", "normalizedItems"]
                }
            }
        });

        if (response.text) {
            let aiText = response.text.trim();
            aiText = aiText.replace(/```json/g, '').replace(/```/g, '').trim();
            return NextResponse.json(JSON.parse(aiText), { status: 200 });
        } else {
            throw new Error("Pusta odpowiedź API");
        }
    } catch (err: any) {
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}