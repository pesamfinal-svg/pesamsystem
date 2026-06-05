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
            Twoim zadaniem jest analiza poniższej listy materiałów (koszyka).
            Zwróć uwagę, że zamówienie może dotyczyć naraz wielu różnych robót (np. szalunki i ściany G-K).

            MASZ DWA ZADANIA:
            
            1. SUGEROWANIE BRAKÓW (Domówienia):
            Analizuj logiczne systemy. Jeśli są płyty G-K i profile, ale brakuje wkrętów, gipsu lub siatki - zasugeruj je. Jeśli są cegły, a nie ma zaprawy - zasugeruj.
            Zasugerowane nazwy muszą być od razu profesjonalnymi określeniami rynkowymi.
            
            2. NORMALIZACJA (Tłumaczenie na profesjonalny język):
            Jeśli użytkownik w koszyku wpisał coś potocznie, np. "regipsy", "wkręty", "piana", "folia", to do tablicy 'normalizedItems' wrzuć oryginał oraz poprawioną, pełną nazwę rynkową (np. "Płyta G-K typ A 12.5mm", "Wkręty fosfatowane TN 3.5x25", "Pianka montażowa niskoprężna wężykowa").
            Jeśli nazwa w koszyku jest w miarę poprawna, zignoruj ją (nie normalizuj na siłę).
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
                temperature: 0.1, // Niska temperatura, zero halucynacji
                responseMimeType: "application/json",
                responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                        analysis: {
                            type: Type.STRING,
                            description: "Krótkie podsumowanie. Np. 'Zidentyfikowano materiały do suchej zabudowy oraz dociepleń. Wymagane doprecyzowanie nazw.'"
                        },
                        systemsIdentified: {
                            type: Type.ARRAY,
                            description: "Jakie systemy budowlane tu widzisz? np. ['Sucha zabudowa', 'Szalunki systemowe']",
                            items: { type: Type.STRING }
                        },
                        suggestedItems: {
                            type: Type.ARRAY,
                            description: "Lista dokładnych nazw sugerowanych materiałów do dodania.",
                            items: { type: Type.STRING }
                        },
                        normalizedItems: {
                            type: Type.ARRAY,
                            description: "Lista pozycji do poprawy. Jeśli użytkownik użył slangowych nazw, podaj oryginał i sugerowaną nazwę.",
                            items: {
                                type: Type.OBJECT,
                                properties: {
                                    original: { type: Type.STRING, description: "Dokładny tekst z koszyka np. 'regipsy'" },
                                    professional: { type: Type.STRING, description: "Profesjonalna nazwa np. 'Płyta G-K typ A 12.5mm'" }
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
            const parsedJson = JSON.parse(aiText);
            return NextResponse.json(parsedJson, { status: 200 });
        } else {
            throw new Error("Pusta odpowiedź z API");
        }

    } catch (err: any) {
        console.error("Błąd AI podczas weryfikacji koszyka:", err);
        return NextResponse.json({ error: err.message || "Błąd wewnętrzny" }, { status: 500 });
    }
}