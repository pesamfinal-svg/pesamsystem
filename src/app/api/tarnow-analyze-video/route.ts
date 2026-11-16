// src/app/api/tarnow-analyze-video/route.ts
// Analizuje nagranie wideo telefonem i zwraca dane o teczce archiwalnej

import { NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || 'pesam-system-81165',
    location: 'global'
});

export const maxDuration = 120;

export async function POST(req: Request) {
    try {
        const { videoBase64, mimeType } = await req.json();

        if (!videoBase64) {
            return NextResponse.json({ error: 'Brak danych wideo' }, { status: 400 });
        }

        const systemInstruction = `
Jesteś doświadczonym archiwistą PSS SPOŁEM Tarnów. Analizujesz wideo/filmik nagrany telefonem 
pokazujący teczkę lub zbiór dokumentów archiwalnych pracownika.

Twoim zadaniem jest wyciągnąć z nagrania maksymalnie szczegółowe informacje do wypełnienia 
wykazu dokumentów przekazywanych pracownikom.

Zwróć odpowiedź WYŁĄCZNIE jako JSON (bez żadnego tekstu przed ani po) z następującymi polami:
{
  "teczkaOpis": "opis teczki/segregatora (kolor, oznaczenia, napisy na grzbiecie)",
  "pracownik": "imię i nazwisko pracownika jeśli widoczne, lub pusty string",
  "dataOd": "data początkowa dokumentów jeśli widoczna (format YYYY-MM-DD lub pusty string)",
  "dataDo": "data końcowa dokumentów jeśli widoczna (format YYYY-MM-DD lub pusty string)",
  "dokumenty": [
    {
      "nazwa": "nazwa dokumentu",
      "ilosc": 1,
      "uwagi": "dodatkowe uwagi np. brak podpisu, kserokopia itp."
    }
  ],
  "uwagi": "dodatkowe uwagi archiwisty, stan dokumentów, widoczne uszkodzenia itp."
}

Jeśli nie możesz odczytać jakiegoś pola - zostaw pusty string lub pustą tablicę.
Spróbuj rozpoznać każdy widoczny dokument z osobna.
`;

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            config: {
                systemInstruction,
                temperature: 0.1,
            },
            contents: [
                {
                    role: 'user',
                    parts: [
                        { text: 'Przeanalizuj nagranie i wyciągnij dane do wykazu dokumentów archiwalnych.' },
                        {
                            inlineData: {
                                mimeType: mimeType || 'video/mp4',
                                data: videoBase64,
                            }
                        }
                    ]
                }
            ]
        });

        const rawText = response.candidates?.[0]?.content?.parts?.[0]?.text || '';

        // Wyciągnij JSON z odpowiedzi
        const jsonMatch = rawText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            return NextResponse.json({ error: 'AI nie zwróciło poprawnych danych', rawText }, { status: 500 });
        }

        const data = JSON.parse(jsonMatch[0]);
        return NextResponse.json({ success: true, data });

    } catch (error: unknown) {
        console.error('Błąd analizy wideo:', error);
        const message = error instanceof Error ? error.message : 'Nieznany błąd';
        return NextResponse.json({ error: `Błąd analizy: ${message}` }, { status: 500 });
    }
}
