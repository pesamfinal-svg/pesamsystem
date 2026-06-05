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
            Analizujesz koszyk z materiałami i sugerujesz braki technologiczne oraz poprawiasz nazewnictwo.

            ZASADY DLA SUGESTII (Domówień):
            Jeśli brakuje kluczowych elementów do systemu (np. zaprawa do cegieł, wkręty i gips do G-K), zaproponuj je.
            Dla KAŻDEJ sugestii musisz podać jej logiczną jednostkę rynkową w polu 'unit' (np. "szt.", "worki 25kg", "rolki", "op. 1000szt", "wiadro 20kg").
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
                        analysis: { type: Type.STRING, description: "Krótkie podsumowanie analizy." },
                        systemsIdentified: { type: Type.ARRAY, items: { type: Type.STRING } },
                        suggestedItems: {
                            type: Type.ARRAY,
                            description: "Lista brakujących materiałów z jednostkami",
                            items: {
                                type: Type.OBJECT,
                                properties: {
                                    name: { type: Type.STRING, description: "Nazwa profesjonalna np. 'Gips szpachlowy'" },
                                    unit: { type: Type.STRING, description: "Logiczna jednostka np. 'worki 25kg', 'szt.', 'rolki'" }
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