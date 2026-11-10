import { NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';

interface ItemToPrice {
    id: string;
    name: string;
    quantity: number;
    unit?: string;
    // Rzeczywista cena zakupu z bazy inwentaryzacyjnej PESAM.
    // Jeśli podana i > 0, system ZAWSZE użyje jej jako podstawy wyceny
    // zamiast szukać cen rynkowych. AI jest używane tylko dla pozycji bez ceny.
    purchasePrice?: number;
    // Opcjonalne podpowiedzi użytkownika przed wywołaniem AI
    brandHint?: string;      // np. "Stabila", "Hilti", "Leica" – doprecyzuje wyszukiwanie
    userPriceHint?: number;  // zapamiętana cena przez użytkownika – priorytet nad AI
}

// Baza orientacyjnych cen rynkowych (PLN) – WYŁĄCZNIE jako fallback
// dla pozycji, które nie mają ceny zakupu w bazie PESAM!
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
            return { price: val, source: "Katalog cen rynkowych PESAM (brak ceny zakupu w bazie)" };
        }
    }
    return { price: 100, source: "Szacunek domyślny (brak ceny zakupu w bazie)" };
}

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const items: ItemToPrice[] = body.items || [];

        if (!items || items.length === 0) {
            return NextResponse.json({ success: true, estimates: {} });
        }

        const estimates: Record<string, { estimatedUnitCost: number; reasoning: string }> = {};

        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        // ETAP 1: Pozycje z REALNĄ CENĄ ZAKUPU w bazie PESAM → użyj jej bezpośrednio.
        // Nie pytamy AI o cenę rynkową – PESAM płacił konkretną kwotę i to jest
        // właściwa podstawa wyceny strat/długu wobec firmy.
        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        const itemsNeedingAI: ItemToPrice[] = [];

        for (const item of items) {
            if (item.purchasePrice && item.purchasePrice > 0) {
                // Mamy realną cenę z bazy – użyj jej; AI nie jest potrzebne
                estimates[item.id] = {
                    estimatedUnitCost: Math.round(item.purchasePrice),
                    reasoning: `Cena zakupu z bazy inwentaryzacyjnej PESAM: ${item.purchasePrice} zł / szt.`
                };
            } else if (item.userPriceHint && item.userPriceHint > 0) {
                // Użytkownik podał zapamiętaną cenę – traktuj jako pewną
                estimates[item.id] = {
                    estimatedUnitCost: Math.round(item.userPriceHint),
                    reasoning: `Cena podana przez użytkownika: ${item.userPriceHint} zł / szt.`
                };
            } else {
                // Brak ceny zakupu → wyślij do AI po oszacowanie
                itemsNeedingAI.push(item);
            }
        }

        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        // ETAP 2: Pozostałe pozycje (bez ceny zakupu) – wycena przez Gemini AI.
        // Dotyczy: napraw usterek, drobnych wydatków, sprzętu masowego bez ceny.
        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        if (itemsNeedingAI.length > 0) {
            try {
                const ai = new GoogleGenAI({
                    vertexai: true,
                    project: process.env.GCP_PROJECT_ID || 'pesam-system-81165',
                    location: 'global'
                });

                const itemLines = itemsNeedingAI.map(i => {
                    let line = `- ID: "${i.id}" | Nazwa: "${i.name}" | Ilość: ${i.quantity} ${i.unit || "szt."}`;
                    if (i.brandHint) line += ` | Marka/Model: ${i.brandHint}`;
                    if (i.userPriceHint && i.userPriceHint > 0) line += ` | Podana przez użytkownika cena: ${i.userPriceHint} zł (zweryfikuj czy realna)`;
                    return line;
                }).join('\n');

                const prompt = `Jesteś ekspertem ds. kosztorysowania dla polskiej firmy budowlanej PESAM.
Poniższe pozycje NIE mają ceny zakupu w naszej bazie – wyszukaj i podaj aktualną orientacyjną wartość.
Skorzystaj z internetu, aby sprawdzić aktualne ceny rynkowe w Polsce (sklepy budowlane, hurtownie).

Zasady wyceny:
- Dla utraconego sprzętu/narzędzi: podaj cenę zakupu nowego zamiennika na polskim rynku (cena hurtowa netto PLN)
- Dla usług naprawy: podaj szacunkowy koszt naprawy (robocizna serwisowa + części zamienne) w PLN netto
- Dla materiałów jednorazowych: cenę rynkową za jednostkę w Polsce
- JEŚLI użytkownik podał markę/model lub cenę – uwzględnij to jako wskazówkę i zweryfikuj

Pozycje do oszacowania:
${itemLines}

WAŻNE: Odpowiedz WYŁĄCZNIE poprawnym formatem JSON bez żadnych ozdobników markdown.
Format: { "estimates": [ { "id": "...", "price": 123, "reasoning": "Skąd cena (sklep/hurtownia)" } ] }`;

                // Użyj modelu z Google Search grounding – AI wyszuka aktualne ceny w sieci
                // gemini-2.5-flash obsługuje googleSearch tool (grounding)
                const response = await ai.models.generateContent({
                    model: 'gemini-2.5-flash',
                    contents: prompt,
                    config: {
                        tools: [{ googleSearch: {} }],
                    }
                });

                const text = response.text || "";
                const cleanJson = text.replace(/```json/g, '').replace(/```/g, '').trim();
                const parsed = JSON.parse(cleanJson);

                if (parsed && Array.isArray(parsed.estimates)) {
                    for (const est of parsed.estimates) {
                        estimates[est.id] = {
                            estimatedUnitCost: Math.round(Number(est.price) || 0),
                            reasoning: `⚠️ Szacunek AI (brak ceny w bazie): ${est.reasoning || "Wycena orientacyjna"}`
                        };
                    }
                }
            } catch (aiErr) {
                console.warn("Brak odpowiedzi z modelu Gemini dla wyceny, użyto katalogu cen PESAM:", aiErr);
            }
        }

        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        // ETAP 3: Ostateczny fallback dla pozycji, których AI też nie wyceniło
        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        for (const item of items) {
            if (!estimates[item.id] || estimates[item.id].estimatedUnitCost <= 0) {
                const fb = getFallbackEstimate(item.name);
                estimates[item.id] = {
                    estimatedUnitCost: fb.price,
                    reasoning: `⚠️ ${fb.source} – sprawdź ręcznie!`
                };
            }
        }

        return NextResponse.json({ success: true, estimates });
    } catch (error: any) {
        console.error("Błąd endpointu wyceny:", error);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}

