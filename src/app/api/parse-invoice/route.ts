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
        const { files } = await req.json();

        if (!files || !Array.isArray(files) || files.length === 0) {
            return NextResponse.json({ error: "Brak plików do analizy" }, { status: 400 });
        }

        const systemInstruction = `
            Jesteś precyzyjnym systemem OCR i analizy dokumentów finansowo-serwisowych. 
            Twoim jedynym zadaniem jest przeanalizowanie przesłanych dokumentów (faktura KAS, specyfikacje naprawy z warsztatu) i wyciągnięcie z nich danych.
            Musisz bezwzględnie dopasować odnalezione wartości do kluczy zdefiniowanych w schemacie odpowiedzi (responseSchema).
        `;

        const prompt = "Odczytaj dane z dokumentów i zwróć je w formacie zgodnym ze schematem JSON.";

        const inlineFilesParts = files.map((file: any) => ({
            inlineData: {
                mimeType: file.mimeType,
                data: file.fileBase64
            }
        }));

        // Wywołanie modelu z twardym wymuszeniem struktury JSON (Structured Outputs)
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
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
                temperature: 0.1, // Niska temperatura dla maksymalnej precyzji matematycznej i braku fantazji AI
                responseMimeType: "application/json",

                // ─── TWARDY SCHEMAT ODPOWIEDZI (responseSchema) ───
                // Model ma zablokowaną możliwość używania własnych kluczy. Musi użyć poniższych.
                responseSchema: {
                    type: "OBJECT",
                    properties: {
                        date: {
                            type: "STRING",
                            description: "Data wystawienia faktury lub wykonania usługi w formacie YYYY-MM-DD. Przeszukaj dokument pod kątem tej daty."
                        },
                        cost: {
                            type: "NUMBER",
                            description: "Sumaryczna kwota NETTO z faktury. Znajdź wartość opisaną jako Razem Netto, Suma Netto, lub zsumuj ceny netto części i robocizny. Zwróć jako liczbę zmiennoprzecinkową."
                        },
                        accountingNumber: {
                            type: "STRING",
                            description: "Numer faktury VAT, paragonu lub zlecenia naprawy."
                        },
                        mileage: {
                            type: "INTEGER",
                            description: "Przebieg pojazdu w kilometrach odczytany ze specyfikacji warsztatowej (szukaj słów: stan licznika, przebieg, km). Jeśli nie ma, zwróć 0."
                        },
                        comments: {
                            type: "STRING",
                            description: "Zwięzły i czytelny opis wykonanych prac i wymienionych części złączony w jedno logiczne zdanie."
                        },
                        repairType: {
                            type: "STRING",
                            description: "Wybierz JEDNĄ wartość z listy: Mechaniczna, Elektryczna, Zawieszenie, Silnik, Wulkanizacja, Lakiernicza, Eksploatacyjna. Dopasuj do typu usterki."
                        }
                    },
                    required: ["date", "cost", "accountingNumber", "mileage", "comments", "repairType"]
                }
            }
        });

        if (response.text) {
            let aiText = response.text.trim();

            // Oczyszczanie z ewentualnych znaczników markdownu
            aiText = aiText.replace(/```json/g, '').replace(/```/g, '').trim();

            const parsedJson = JSON.parse(aiText);
            return NextResponse.json(parsedJson, { status: 200 });
        } else {
            throw new Error("Pusta odpowiedź z API Gemini");
        }

    } catch (error: any) {
        console.error("Błąd podczas strukturyzowanej analizy plików przez Google Gen AI:", error);
        return NextResponse.json({ error: error.message || "Błąd wewnętrzny serwera" }, { status: 500 });
    }
}