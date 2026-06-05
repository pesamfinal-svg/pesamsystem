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
                "reply": "Krótkie podsumowanie, np. 'Oto wyliczone materiały dla Twojej ścianki...'",
                "reasoning": [
                    "Wymiary: ściana 4.0m × 2.5m = 10.0 m²",
                    "Słupki CW: ⌈4.0 / 0.60⌉ + 1 = 8 szt. → 8 × profil 3m (nie skracamy i nie sztukujemy!)",
                    "Profile UW (góra i dół): 2 × ⌈4.0 / 4.0m⌉ = 2 szt.",
                    "Płyty G-K: 10.0 m² / (1.2×2.6m) = 3.2 → 4 szt. × 2 strony = 8 szt. + 10% odpadu = 9 szt."
                ],
                "asciiDrawing": "PROFIL UW (SUFITOWY) - 400 cm\n================================\n||      |      |      |      ||\n||      |      |      |      ||\nCW      CW     CW     CW     CW\n\nNarysuj tutaj zwięzły szkic ASCII (używając znaków |, -, =, +, itp.) odpowiedni do zadania (np. przekrój ocieplenia, układ profili, rzut siatki). Używaj znaków nowej linii (\\n).",
                "generatedItems": [
                    { "name": "Płyta G-K Wodoodporna", "quantity": 10, "unit": "szt." }
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