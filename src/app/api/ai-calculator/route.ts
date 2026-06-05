// src/app/api/ai-calculator/route.ts
import { NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || 'pesam-system-81165',
    location: 'global'
});

export const maxDuration = 60;

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

        // AI 2: KALKULATOR (Z Pythonem, tylko czysta matematyka)
        const systemInstruction = `
            Jesteś Głównym Kosztorysantem Budowlanym. Otrzymujesz wymiary oraz dokładnie wybrane przez klienta parametry materiałów.
            Twoim JEDYNYM zadaniem jest wyliczenie ilości potrzebnych materiałów (w tym akcesoriów jak wkręty, taśmy, gips) zgodnie ze sztuką budowlaną.
            
            ZASADY OBLICZEŃ (BARDZO WAŻNE):
            1. UŻYWAJ PYTHONA do obliczeń.
            2. Wymiary handlowe i docinki: Pamiętaj, że materiały mają standardowe wymiary (np. profile CW/UW mają 3m lub 4m, płyty G-K mają 1.2m x 2.6m). 
            3. Zakaz sztukowania: Jeśli ściana ma 2.5m wysokości, to na jeden słupek pionowy zużywasz 1 pełny profil 3m (nie sumuj resztek do tworzenia słupków nośnych!).
            4. Odpady: Zawsze doliczaj standardowy zapas na ścinki i odpady (ok. 5-10% w zależności od materiału).
            5. Zaokrąglenia: Wyniki zawsze zaokrąglaj w górę do pełnych sztuk, paczek lub worków.
            
            Zwróć DOKŁADNIE JEDEN obiekt JSON w formacie:
            {
                "reply": "Krótkie podsumowanie, np. 'Oto wyliczone materiały dla Twojej ścianki (uwzględniłem zapas na docinki):'",
                "generatedItems": [
                    { "name": "Płyta G-K Wodoodporna", "quantity": 10, "unit": "szt." },
                    { "name": "Profil CW 75 (dł. 3m)", "quantity": 15, "unit": "szt." },
                    { "name": "Wkręty (opakowanie)", "quantity": 1, "unit": "op." }
                ]
            }
        `;

        const response = await ai.models.generateContent({
            model: 'gemini-3.1-pro-preview',
            contents: [{ role: 'user', parts: [{ text: request }] }],
            config: { 
                systemInstruction, 
                temperature: 0.1,
                tools: [{ codeExecution: {} }] // Tutaj włączony jest Python
            } 
        });

        if (response.text) {
            const extractedObjects = extractAllJSONObjects(response.text);
            if (extractedObjects.length > 0) {
                return NextResponse.json(extractedObjects[extractedObjects.length - 1], { status: 200 });
            }
        }
        throw new Error("Błąd parsowania odpowiedzi Kalkulatora.");
    } catch (err: any) {
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}