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
        // Czytamy przesłaną tablicę "files" z frontendu!
        const { files } = await req.json();

        if (!files || !Array.isArray(files) || files.length === 0) {
            return NextResponse.json({ error: "Brak plików do analizy" }, { status: 400 });
        }

        const systemInstruction = `
            Jesteś profesjonalnym systemem księgowym. Twoim jedynym zadaniem jest odczytanie danych z załączonych dokumentów (faktura, paragon, zlecenie serwisowe, specyfikacja) i zwrócenie ich w czystym formacie JSON.
            
            Kluczowe wytyczne:
            1. Znajdź sumaryczną kwotę NETTO całej usługi (najczęściej na fakturze KAS).
            2. Wyciągnij numer faktury, datę (sformatuj jako YYYY-MM-DD).
            3. Wyciągnij przebieg/stan licznika w kilometrach (często dopisany w uwagach lub pozycjach jako np. "stan licznika: 125000 km"). Jeśli brak, zwróć 0.
            4. Krótko streść zakres prac (np. "Wymiana filtrów, oleju, klocków hamulcowych").
            5. Dopasuj typ usterki wybierając jedną z opcji: Mechaniczna, Elektryczna, Zawieszenie, Silnik, Wulkanizacja, Lakiernicza, Eksploatacyjna.
        `;

        const prompt = "Przeanalizuj te dokumenty i wyciągnij dane do faktury zgodnie z instrukcją systemową.";

        // Mapujemy wszystkie pliki w tablicy (niezależnie od tego, czy to 1 czy 3 zrzuty ekranu) do formatu inlineData
        const inlineFilesParts = files.map((file: any) => ({
            inlineData: {
                mimeType: file.mimeType,
                data: file.fileBase64
            }
        }));

        // Wywołanie modelu przy użyciu oficjalnego SDK Google Gen AI
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash', // Najlepszy model do analizy obrazów i dokumentów
            contents: [
                {
                    role: 'user',
                    parts: [
                        { text: prompt },
                        ...inlineFilesParts
                    ]
                }
            ],
            config: {
                systemInstruction: systemInstruction,
                temperature: 0.1, // Niska temperatura dla precyzji obliczeń
                responseMimeType: "application/json" // Wymuszenie formatu JSON
            }
        });

        if (response.text) {
            let aiText = response.text.trim();

            // Oczyszczanie z ewentualnych znaczników markdown
            aiText = aiText.replace(/```json/g, '').replace(/```/g, '').trim();

            const parsedJson = JSON.parse(aiText);
            return NextResponse.json(parsedJson, { status: 200 });
        } else {
            throw new Error("Pusta odpowiedź z API Gemini");
        }

    } catch (error: any) {
        console.error("Błąd podczas analizy plików przez Google Gen AI:", error);
        return NextResponse.json({ error: error.message || "Błąd wewnętrzny serwera" }, { status: 500 });
    }
}