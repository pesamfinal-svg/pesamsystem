// src/app/api/parse-invoice/route.ts
import { NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';

// Inicjalizacja Twojego oficjalnego klienta Google Gen AI (Vertex AI na GCP)
const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || 'pesam-system-81165',
    location: 'global'
});

export async function POST(req: Request) {
    try {
        const { fileBase64, mimeType } = await req.json();

        if (!fileBase64 || !mimeType) {
            return NextResponse.json({ error: "Brak pliku do analizy" }, { status: 400 });
        }

        // Prompt instruujący model, jak ma zinterpretować strukturę faktury
        const systemInstruction = `
            Jesteś profesjonalnym systemem księgowym. Twoim jedynym zadaniem jest odczytanie danych z załączonego dokumentu (faktura, paragon, zlecenie serwisowe) i zwrócenie ich w czystym formacie JSON.
            
            Kluczowe wytyczne:
            1. Znajdź sumaryczną kwotę NETTO całej faktury (często opisaną jako 'Suma Netto', 'Wartość netto', 'Razem Netto').
            2. Wyciągnij numer faktury, datę (sformatuj jako YYYY-MM-DD).
            3. Wyciągnij przebieg/stan licznika w kilometrach (często dopisany w uwagach lub pozycjach jako np. "stan licznika: 125000 km"). Jeśli brak, zwróć 0.
            4. Krótko streść zakres prac (np. "Wymiana filtrów, oleju, klocków hamulcowych").
            5. Dopasuj typ usterki wybierając jedną z opcji: Mechaniczna, Elektryczna, Zawieszenie, Silnik, Wulkanizacja, Lakiernicza, Eksploatacyjna.
        `;

        const prompt = "Przeanalizuj ten dokument i wyciągnij dane do faktury zgodnie z instrukcją systemową.";

        // Wywołanie modelu przy użyciu oficjalnego SDK Google Gen AI
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash', // Model z serii 2.5 o doskonałych zdolnościach wizualnych i OCR
            contents: [
                {
                    role: 'user',
                    parts: [
                        { text: prompt },
                        {
                            inlineData: {
                                mimeType: mimeType,
                                data: fileBase64
                            }
                        }
                    ]
                }
            ],
            config: {
                systemInstruction: systemInstruction,
                temperature: 0.1, // Bardzo niska temperatura dla maksymalnej precyzji matematycznej
                responseMimeType: "application/json" // Wymuszenie zwrotu struktury JSON
            }
        });

        if (response.text) {
            let aiText = response.text.trim();

            // Oczyszczanie na wypadek, gdyby model dodał markdown
            aiText = aiText.replace(/```json/g, '').replace(/```/g, '').trim();

            const parsedJson = JSON.parse(aiText);
            return NextResponse.json(parsedJson, { status: 200 });
        } else {
            throw new Error("Pusta odpowiedź z API Gemini");
        }

    } catch (error: any) {
        console.error("Błąd analizy faktury przez Google Gen AI (Vertex):", error);
        return NextResponse.json({ error: error.message || "Błąd wewnętrzny serwera" }, { status: 500 });
    }
}