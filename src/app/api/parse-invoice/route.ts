// src/app/api/parse-invoice/route.ts
import { NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';

// Inicjalizacja klienta Google Gen AI (Vertex AI na GCP)
const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || 'pesam-system-81165',
    location: 'global'
});

export const maxDuration = 60;

export async function POST(req: Request) {
    try {
        // Czytamy przesłaną tablicę "files" z frontendu
        const { files } = await req.json();

        if (!files || !Array.isArray(files) || files.length === 0) {
            return NextResponse.json({ error: "Brak plików do analizy" }, { status: 400 });
        }

        const systemInstruction = `
            Jesteś precyzyjnym systemem OCR i analizy dokumentów finansowo-serwisowych. 
            Twoim zadaniem jest przeanalizowanie przesłanych dokumentów (faktura, specyfikacja naprawy z warsztatu) i wyciągnięcie z nich danych.
            Musisz bezwzględnie dopasować odnalezione wartości do kluczy zdefiniowanych w schemacie odpowiedzi (responseSchema).
            
            Ważna instrukcja dla kwot:
            Jeśli na fakturze kwota netto zawiera przecinek (np. "981,53"), przekonwertuj ją na poprawną liczbę zmiennoprzecinkową z kropką: 981.53. Nie toleruj pomyłek graficznych typu mylenie 9 z 8. Czytaj znaki z najwyższą uwagą.
        `;

        const prompt = "Odczytaj dane z dokumentów i zwróć je w formacie zgodnym ze schematem JSON.";

        const inlineFilesParts = files.map((file: any) => ({
            inlineData: {
                mimeType: file.mimeType,
                data: file.fileBase64
            }
        }));

        // Wywołanie modelu przy użyciu oficjalnego SDK Google Gen AI ze sztywną strukturą
        const response = await ai.models.generateContent({
            model: 'gemini-3-flash-preview',
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
                temperature: 0.1, // Blokuje halucynacje i błędny odczyt cyfr
                responseMimeType: "application/json",

                responseSchema: {
                    type: "OBJECT",
                    properties: {
                        date: {
                            type: "STRING",
                            description: "Data wystawienia faktury lub wykonania usługi w formacie YYYY-MM-DD."
                        },
                        cost: {
                            type: "NUMBER",
                            description: "Wartość netto całej faktury (Suma netto). Przekonwertuj polski przecinek na kropkę, np. dla '981,53' zwróć 981.53."
                        },
                        accountingNumber: {
                            type: "STRING",
                            description: "Numer faktury VAT, paragonu lub zlecenia naprawy."
                        },
                        mileage: {
                            type: "INTEGER",
                            description: "Przebieg pojazdu w kilometrach odczytany z dokumentów. Jeśli nie ma, zwróć 0."
                        },
                        location: {
                            type: "STRING",
                            description: "Nazwa warsztatu / sprzedawcy (np. 'F.H.U.T. BACATRANS Jacek Bieszczad' lub 'MASTER CAR')."
                        },
                        comments: {
                            type: "STRING",
                            description: "Krótkie streszczenie wykonanych prac ze specyfikacji."
                        },
                        repairType: {
                            type: "STRING",
                            description: "Wybierz JEDNĄ wartość: Mechaniczna, Elektryczna, Zawieszenie, Silnik, Wulkanizacja, Lakiernicza, Eksploatacyjna."
                        }
                    },
                    required: ["date", "cost", "accountingNumber", "mileage", "location", "comments", "repairType"]
                }
            }
        });

        if (response.text) {
            let aiText = response.text.trim();
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