// src/app/api/ai-equipment/route.ts
import { NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || 'pesam-system-81165',
    location: 'global'
});

function extractAllJSONObjects(text: string) {
    const objects = [];
    let depth = 0; let startIndex = -1; let inString = false; let escape = false;
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (inString) {
            if (char === '\\') escape = !escape;
            else if (char === '"' && !escape) inString = false;
            else escape = false;
        } else {
            if (char === '"') inString = true;
            else if (char === '{') { if (depth === 0) startIndex = i; depth++; }
            else if (char === '}') {
                if (depth > 0) {
                    depth--;
                    if (depth === 0 && startIndex !== -1) {
                        try { objects.push(JSON.parse(text.substring(startIndex, i + 1))); } catch (e) {}
                        startIndex = -1;
                    }
                }
            }
        }
    }
    return objects;
}

export async function POST(req: Request) {
    try {
        const { request } = await req.json();

        const systemInstruction = `
            Jesteś Głównym Kosztorysantem Maszynowym i Koordynatorem Sprzętu w PESAM. 
            Twoim zadaniem jest oszacowanie czasu pracy maszyn (koparek, wywrotek, zagęszczarek) lub ludzi na podstawie zapytania użytkownika.
            
            ZASADY OBLICZEŃ (RMS - Litery R i S):
            1. UŻYWAJ PYTHONA do dokładnych obliczeń (np. wydajność na godzinę, pojemności łyżek, cykle pracy, objętość wykopu).
            2. Wyciągaj wnioski z kontekstu (np. jeśli mowa o wywozie, oblicz kursy ciężarówek, czas załadunku).
            3. Uwzględniaj trudne warunki pracy, spulchnienie gruntów (lekki ok. 15-20%, glina ok. 30%), czas na dojazdy i manewrowanie.
            
            Zwróć DOKŁADNIE JEVEN obiekt JSON w formacie:
            {
                "reply": "Krótkie podsumowanie wyników, np. 'Oto szacunkowy czas pracy sprzętu dla Twojego zapytania:'",
                "reasoning": [
                    "Wymiary/założenia: ...",
                    "Wydajność sprzętu: ...",
                    "Obliczenia krok po kroku: ..."
                ],
                "asciiDrawing": "Narysuj prosty rysunek ASCII nawiązujący do maszyn, wykopów, ciężarówek lub zagęszczarek.",
                "generatedItems": [
                    { "name": "Szacunkowy czas pracy koparki", "quantity": 12, "unit": "godz." },
                    { "name": "Szacunkowa liczba kursów wywrotki", "quantity": 25, "unit": "kursy" }
                ]
            }
        `;

        const response = await ai.models.generateContent({
            model: 'gemini-3.1-pro-preview',
            contents: [{ role: 'user', parts: [{ text: request }] }],
            config: { 
                systemInstruction, 
                temperature: 0.1,
                tools: [{ codeExecution: {} }] // Python włączony pod obliczenia sprzętu
            } 
        });

        if (response.text) {
            const extractedObjects = extractAllJSONObjects(response.text);
            if (extractedObjects.length > 0) {
                return NextResponse.json(extractedObjects[extractedObjects.length - 1], { status: 200 });
            }
        }
        throw new Error("Błąd parsowania odpowiedzi Agenta Sprzętu.");
    } catch (err: any) {
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}