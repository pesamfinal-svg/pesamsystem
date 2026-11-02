// src/app/api/ai-identify-material/route.ts
// =============================================================================
// PESAM — AI Scan & Identify
// Rozpoznaje materiały budowlane ze zdjęć za pomocą Gemini Vision
// =============================================================================

import { NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';
import { jsonrepair } from 'jsonrepair';

const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || 'pesam-system-81165',
    location: 'global'
});

export const maxDuration = 30;

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const { imageBase64, hint } = body as { imageBase64: string; hint?: string };

        if (!imageBase64) {
            return NextResponse.json({ error: 'Brak zdjęcia (imageBase64)' }, { status: 400 });
        }

        // Wyodrębnij base64 bez nagłówka "data:image/jpeg;base64,"
        const base64Data = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64;
        const mimeType = imageBase64.startsWith('data:image/png') ? 'image/png' : 'image/jpeg';

        const systemInstruction = `Jesteś ekspertem od materiałów budowlanych pracującym w polskiej firmie budowlanej PESAM.
Twoje zadanie: rozpoznać materiał budowlany ze zdjęcia i zwrócić dane w formacie JSON.

Dostępne kategorie (zwróć DOKŁADNIE jedną z tych wartości w polu "category"):
- pustaki (bloczki betonowe, pustaki, cegły, termoizolacyjne)
- kable-elektryka (kable, przewody, rury elektryczne, listwy)
- szalunki (deski szalunkowe, stemple, stężenia)
- stal-ogrodzenia (bednarka, pręty, siatka, stal, ogrodzenia)
- kanalizacja-odwodnienia (rury PVC, studzienki, kształtki kanalizacyjne)
- farby-chemia (farby, impregnat, emulsja, lakiery, środki chemiczne)
- pianki-silikony (pianka montażowa, silikon, uszczelniacz)
- kleje (klej do płytek, klej budowlany, zaprawa klejowa)
- plyty-gk (płyty gipsowo-kartonowe, sufit podwieszany, profile)
- gipsy-gladzie (gips, gładź, tynk gipsowy, szpachla)
- izolacje-folie (wełna mineralna, styropian, folia budowlana, membrana)
- inne (jeśli nie pasuje do żadnej z powyższych)

Dostępne jednostki (zwróć DOKŁADNIE jedną): szt., worki, rolki, krąg, mb, m2, op., kg, litry, paleta

Odpowiedz WYŁĄCZNIE poprawnym JSON-em bez żadnych komentarzy ani markdown:
{
  "name": "Pełna nazwa materiału np. Bloczek betonowy 590x120x239",
  "category": "pustaki",
  "unit": "szt.",
  "confidence": 0.85,
  "description": "Krótki opis (1-2 zdania) co to jest i do czego służy",
  "additionalInfo": "Ewentualne uwagi o stanie, ilości widocznej na zdjęciu, przybliżonym rozmiarze itp."
}`;

        const userText = hint
            ? `Rozpoznaj ten materiał budowlany. Dodatkowa wskazówka od pracownika: "${hint}"`
            : 'Rozpoznaj ten materiał budowlany ze zdjęcia.';

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [
                {
                    role: 'user',
                    parts: [
                        {
                            inlineData: {
                                mimeType,
                                data: base64Data
                            }
                        },
                        { text: userText }
                    ]
                }
            ],
            config: {
                systemInstruction,
                temperature: 0.1,
                responseMimeType: 'application/json'
            }
        });

        const rawText = response.text || '{}';

        let parsed: {
            name?: string;
            category?: string;
            unit?: string;
            confidence?: number;
            description?: string;
            additionalInfo?: string;
        };

        try {
            parsed = JSON.parse(rawText);
        } catch {
            try {
                parsed = JSON.parse(jsonrepair(rawText));
            } catch {
                parsed = {};
            }
        }

        const VALID_CATEGORIES = [
            'pustaki', 'kable-elektryka', 'szalunki', 'stal-ogrodzenia',
            'kanalizacja-odwodnienia', 'farby-chemia', 'pianki-silikony',
            'kleje', 'plyty-gk', 'gipsy-gladzie', 'izolacje-folie', 'inne'
        ];
        const VALID_UNITS = ['szt.', 'worki', 'rolki', 'krąg', 'mb', 'm2', 'op.', 'kg', 'litry', 'paleta'];

        const result = {
            name: parsed.name || 'Nieznany materiał budowlany',
            category: VALID_CATEGORIES.includes(parsed.category || '') ? parsed.category! : 'inne',
            unit: VALID_UNITS.includes(parsed.unit || '') ? parsed.unit! : 'szt.',
            confidence: Math.min(1, Math.max(0, Number(parsed.confidence) || 0.5)),
            description: parsed.description || '',
            additionalInfo: parsed.additionalInfo || ''
        };

        return NextResponse.json(result, { status: 200 });
    } catch (err: any) {
        console.error('[PESAM AI Identify] Błąd:', err);
        return NextResponse.json(
            { error: err?.message || 'Błąd rozpoznawania materiału' },
            { status: 500 }
        );
    }
}

