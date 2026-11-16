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
Jesteś doświadczonym archiwistą dokumentacji pracowniczej i akt osobowych (spółdzielnia PSS SPOŁEM Tarnów).
Oglądasz nagranie wideo z przeglądania teczki personalnej / akt osobowych pracownika.

NAJWAŻNIEJSZA ZASADA:
NIE CZYTAJ I NIE PRZEPISUJ TREŚCI DOKUMENTÓW! 
Nie interesują nas szczegóły zdań, adresy, zarobki, oceny ani drobny druk.
Twoim JEDYNYM celem jest ZIDENTYFIKOWANIE TYPU DOKUMENTU (co to za dokument) oraz stworzenie zwięzłego, czystego wykazu pozycji znajdujących się w teczce.

Typowe dokumenty w teczkach PSS SPOŁEM:
- Życiorys (CV)
- Kwestionariusz osobowy
- Umowa o pracę / Umowy i angaże
- Świadectwo pracy / Świadectwa pracy
- Dokumenty ZUS (deklaracje zgłoszeniowe ZUS ZUA, zaświadczenia)
- Zaświadczenia lekarskie / Badania profilaktyczne / BHP
- Świadectwa szkolne / Dyplomy / Uprawnienia zawodowe
- Karta obiegowa / Karta urlopowa
- Zawiadomienia o zmianie warunków pracy lub płacy
- Oświadczenia pracownika / Pisma pracownicze
- Kary, nagrody, wyróżnienia

Jeśli dany typ dokumentu występuje wielokrotnie (np. kilka świadectw pracy z różnych lat, kilka angaży), zgrupuj je jako jedną pozycję i wpisz łączną liczbę w 'ilosc', np. "Świadectwa pracy", ilosc: 2.

Zwróć odpowiedź WYŁĄCZNIE jako czysty JSON (bez markdown, bez znaczników \`\`\`json):
{
  "teczkaOpis": "Krótki opis teczki/segregatora (np. 'Teczka akt osobowych - Jan Kowalski, sygnatura...')",
  "pracownik": "Imię i nazwisko pracownika z okładki lub nagłówka (jeśli widoczne)",
  "dataOd": "Najwcześniejsza orientacyjna data/rok z teczki (np. 1978 lub 1978-05-01)",
  "dataDo": "Najpóźniejsza orientacyjna data/rok z teczki (np. 1995 lub 1995-12-31)",
  "dokumenty": [
    {
      "nazwa": "Nazwa typu dokumentu (np. 'Życiorys', 'Kwestionariusz osobowy', 'Świadectwa pracy', 'Dokumenty ZUS')",
      "ilosc": 1,
      "uwagi": "Opcjonalna krótka uwaga (np. 'oryginał', 'odpis', 'lata 1980-1985') - nie przepisuj treści!"
    }
  ],
  "uwagi": "Ogólny stan zachowania teczki (np. 'Dokumenty kompletne, stan dobry, widoczne zażółcenia papieru')"
}
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
