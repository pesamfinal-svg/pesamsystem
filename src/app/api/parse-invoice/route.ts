// src/app/api/parse-invoice/route.ts
import { NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';

// Inicjalizacja klienta Google Gen AI (Vertex AI na GCP)
const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || 'pesam-system-81165',
    location: 'global'
});

export async function POST(req: Request) {
    try {
        const { files } = await req.json();

        if (!files || !Array.isArray(files) || files.length === 0) {
            return NextResponse.json({ error: "Brak plików do analizy" }, { status: 400 });
        }

        const apiKey = process.env.GEMINI_API_KEY || "AIzaSyDPxqAYExThwmrye-o0sEOvqDs4MzgkSDk";
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

        const systemInstruction = `
            Jesteś profesjonalnym systemem księgowym. Przeanalizuj załączone dokumenty (może być ich kilka na raz, np. oficjalna faktura KAS oraz specyfikacja naprawy z warsztatu).
            
            Twoim zadaniem jest połączyć informacje z tych dokumentów i wygenerować jeden spójny obiekt JSON:
            1. Znajdź ostateczną sumaryczną kwotę NETTO całej usługi (najczęściej na fakturze KAS).
            2. Wyciągnij numer faktury i datę (format YYYY-MM-DD).
            3. Wyciągnij przebieg/stan licznika (najczęściej na specyfikacji warsztatowej). Jeśli brak, zwróć 0.
            4. Przeczytaj specyfikację naprawy z warsztatu i krótko streść zakres prac (np. "Wymiana oleju, klocków hamulcowych tył, naprawa alternatora").
            5. Wybierz JEDNĄ pasującą kategorię usterki: Mechaniczna, Elektryczna, Zawieszenie, Silnik, Wulkanizacja, Lakiernicza, Eksploatacyjna.
            
            Zwróć TYLKO I WYŁĄCZNIE obiekt JSON (bez znaczników markdown, bez słowa "json" na początku).
            Struktura JSON:
            {
                "date": "YYYY-MM-DD",
                "cost": 0.00,
                "accountingNumber": "",
                "mileage": 0,
                "comments": "",
                "repairType": "Mechaniczna"
            }
        `;

        const prompt = "Przeanalizuj załączone dokumenty, skompiluj dane i wyciągnij ostateczny wynik w formacie JSON.";

        // Mapujemy wszystkie przesłane pliki (niezależnie od tego, czy to 1 czy 3)
        const inlineFilesParts = files.map((file: any) => ({
            inlineData: {
                mimeType: file.mimeType,
                data: file.fileBase64
            }
        }));

        const payload = {
            contents: [
                {
                    parts: [
                        { text: prompt },
                        ...inlineFilesParts
                    ]
                }
            ],
            config: {
                systemInstruction: systemInstruction,
                temperature: 0.1,
                responseMimeType: "application/json"
            }
        };

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const data = await response.json();

        if (data.candidates && data.candidates.length > 0) {
            let aiText = data.candidates[0].content.parts[0].text;
            aiText = aiText.replace(/```json/g, '').replace(/```/g, '').trim();

            const parsedJson = JSON.parse(aiText);
            return NextResponse.json(parsedJson, { status: 200 });
        } else {
            throw new Error("AI nie wygenerowało poprawnej odpowiedzi");
        }

    } catch (error: any) {
        console.error("Błąd podczas analizy plików przez Google Gen AI:", error);
        return NextResponse.json({ error: error.message || "Błąd wewnętrzny" }, { status: 500 });
    }
}