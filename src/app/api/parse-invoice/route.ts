// src/app/api/parse-invoice/route.ts
import { NextResponse } from 'next/server';

export async function POST(req: Request) {
    try {
        const { fileBase64, mimeType } = await req.json();

        if (!fileBase64 || !mimeType) {
            return NextResponse.json({ error: "Brak pliku" }, { status: 400 });
        }

        // Pobieramy klucz z pliku .env.local (ten sam, co do innych funkcji)
        const apiKey = process.env.GEMINI_API_KEY || "AIzaSyDPxqAYExThwmrye-o0sEOvqDs4MzgkSDk";

        // Używamy modelu gemini-1.5-flash, który świetnie czyta PDFy i obrazy (OCR)
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

        // Prompt wymuszający odpowiedź w czystym formacie JSON
        const prompt = `
            Jesteś asystentem w firmie budowlanej/transportowej. 
            Przeanalizuj załączony dokument (to najpewniej faktura za naprawę samochodu, paragon lub zlecenie serwisowe).
            
            Wyciągnij z niego następujące dane i zwróć je TYLKO I WYŁĄCZNIE jako obiekt JSON (bez znaczników markdown, bez słowa "json" na początku).
            
            Struktura JSON musi wyglądać dokładnie tak:
            {
                "date": "YYYY-MM-DD", (Data wystawienia faktury lub wykonania usługi. Jeśli brak, zostaw puste)
                "cost": 0.00, (Całkowita kwota NETTO do zapłaty, jako liczba)
                "accountingNumber": "", (Numer faktury / zlecenia)
                "mileage": 0, (Stan licznika / przebieg - poszukaj słów 'przebieg', 'stan licznika', 'km'. Jeśli brak, daj 0)
                "comments": "", (Krótkie podsumowanie zakresu prac lub wymienionych części. Złącz to w zgrabne, jedno zdanie)
                "repairType": "Mechaniczna" (Wybierz JEDNĄ opcję z: Mechaniczna, Elektryczna, Zawieszenie, Silnik, Wulkanizacja, Lakiernicza, Eksploatacyjna. Dopasuj logicznie)
            }
        `;

        const payload = {
            contents: [
                {
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
            ]
        };

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const data = await response.json();

        if (data.candidates && data.candidates.length > 0) {
            let aiText = data.candidates[0].content.parts[0].text;

            // Czyszczenie odpowiedzi z ewentualnych znaczników markdown (```json ... ```)
            aiText = aiText.replace(/```json/g, '').replace(/```/g, '').trim();

            const parsedJson = JSON.parse(aiText);
            return NextResponse.json(parsedJson, { status: 200 });
        } else {
            throw new Error("AI nie zwróciło poprawnej odpowiedzi");
        }

    } catch (error: any) {
        console.error("Błąd parsowania faktury przez AI:", error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}