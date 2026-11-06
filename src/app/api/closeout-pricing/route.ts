import { NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';

interface ItemToPrice {
    id: string;
    name: string;
    quantity: number;
    unit?: string;
}

// Baza orientacyjnych cen rynkowych (PLN) na polskim rynku budowlanym dla typowego sprzętu
const FALLBACK_PRICES: Record<string, number> = {
    "ogrodzenie": 120,
    "ogrodzenie mobilne": 125,
    "ramka": 110,
    "podstawa": 45,
    "podstawa betonowa": 45,
    "podpora": 55,
    "obejma": 8,
    "zawias": 25,
    "zamek": 35,
    "koło": 40,
    "łata": 160,
    "łata do niwelatora": 180,
    "kęgi": 75,
    "cęgi": 75,
    "cęgi zbrojarskie": 85,
    "młotek": 45,
    "młotek ciesielski": 60,
    "taczka": 190,
    "taczki": 190,
    "kilof": 70,
    "ochronniki": 40,
    "ochronniki akustyczne": 50,
    "przewód": 350,
    "kabel": 250,
    "cyrkularka": 2200,
    "piła stołowa": 2400,
    "osuszacz": 3200,
    "osuszacz powietrza": 3500,
    "rusztowanie": 250,
    "szalunek": 300,
    "dźwigar": 85,
    "stempel": 75,
    "wkrętarka": 650,
    "wiertarka": 550,
    "młot udarowy": 1800,
    "szlifierka": 450,
    "poziomica": 110,
    "laser": 1200,
    "niwelator": 1600
};

function getFallbackEstimate(name: string): { price: number; source: string } {
    const lower = name.toLowerCase().trim();
    for (const [key, val] of Object.entries(FALLBACK_PRICES)) {
        if (lower.includes(key)) {
            return { price: val, source: "Katalog cen rynkowych PESAM" };
        }
    }
    // Jeśli nie ma bezpośredniego dopasowania, bezpieczna wartość wyjściowa
    return { price: 100, source: "Szacunek domyślny" };
}

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const items: ItemToPrice[] = body.items || [];

        if (!items || items.length === 0) {
            return NextResponse.json({ success: true, estimates: {} });
        }

        const estimates: Record<string, { estimatedUnitCost: number; reasoning: string }> = {};

        // Próba użycia Gemini (Vertex AI / GoogleGenAI)
        try {
            const ai = new GoogleGenAI({
                vertexai: true,
                project: process.env.GCP_PROJECT_ID || 'pesam-system-81165',
                location: 'global'
            });

            const prompt = `Jesteś ekspertem ds. kosztorysowania i wyceny sprzętu budowlanego, szalunków, rusztowań i elektronarzędzi w Polsce.
Dla poniższej listy pozycji podaj orientacyjną średnią cenę rynkową zakupu nowego lub używanego zamiennika w PLN (złotych polskich netto).

Pozycje do wyceny:
${items.map(i => `- ID: "${i.id}" | Nazwa: "${i.name}"`).join('\n')}

Odpowiedz WYŁĄCZNIE poprawnym formatem JSON bez żadnych ozdobników markdown:
{
  "estimates": [
    { "id": "...", "price": 123, "reasoning": "Krótkie uzasadnienie rynkowe" }
  ]
}`;

            const response = await ai.models.generateContent({
                model: 'gemini-2.5-flash-lite',
                contents: prompt,
            });

            const text = response.text || "";
            const cleanJson = text.replace(/```json/g, '').replace(/```/g, '').trim();
            const parsed = JSON.parse(cleanJson);

            if (parsed && Array.isArray(parsed.estimates)) {
                for (const est of parsed.estimates) {
                    estimates[est.id] = {
                        estimatedUnitCost: Math.round(Number(est.price) || 0),
                        reasoning: est.reasoning || "Wycena AI na podstawie cen rynkowych"
                    };
                }
            }
        } catch (aiErr) {
            console.warn("Brak odpowiedzi z modelu Gemini dla wyceny, użyto algorytmu cen rynkowych:", aiErr);
        }

        // Uzupełnienie pozycji, dla których AI nie zwróciło wyceny
        for (const item of items) {
            if (!estimates[item.id] || estimates[item.id].estimatedUnitCost <= 0) {
                const fb = getFallbackEstimate(item.name);
                estimates[item.id] = {
                    estimatedUnitCost: fb.price,
                    reasoning: fb.source
                };
            }
        }

        return NextResponse.json({ success: true, estimates });
    } catch (error: any) {
        console.error("Błąd endpointu wyceny:", error);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}

