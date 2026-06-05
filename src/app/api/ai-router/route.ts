// src/app/api/ai-router/route.ts
import { NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || 'pesam-system-81165',
    location: 'global'
});

// Pomocnicza funkcja do wyciągania JSONa (zabezpieczenie przed dziwnym formatowaniem AI)
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
        const { currentText } = await req.json();

        const systemInstruction = `
            Jesteś głównym Dyspozytorem (Routerem) w systemie dla kierowników budowy PESAM.
            Otrzymujesz wiadomość od kierownika i Twoim JEDYNYM zadaniem jest określić intencję tej wiadomości.
            Nie udzielasz odpowiedzi na pytanie. Zwracasz tylko odpowiednią kategorię.

            ZASADY KLASYFIKACJI:
            1. "MATERIALY_ZAKUPY" - Kierownik chce obliczyć ilość materiałów do zamówienia (beton, stal, ściany G-K, bloczki) LUB chce po prostu wrzucić narzędzia do koszyka (np. "daj mi 5 młotków"). Wszystko co kończy się fizycznym materiałem / towarem do magazynu.
            2. "SPRZET_CZAS" - Kierownik pyta o czas wykonania jakiejś roboty, wydajność maszyn (np. "ile czasu zajmie wykop", "ile m3 na godzinę przerzuci koparka", "wydajność zagęszczarki"). Dotyczy to maszynogodzin i harmonogramu. NIE DODAJEMY TEGO DO KOSZYKA.
            3. "WIEDZA_OGOLNA" - Kierownik pyta o poradę techniczną (np. "w jakiej temperaturze lać beton", "jak głęboko kopać poniżej strefy przemarzania"). Brak tu matematyki, czysta teoria.
            4. "CHIT_CHAT" - Przywitania, luźna rozmowa ("Cześć", "W czym mogę pomóc").

            Zwróć DOKŁADNIE JEDEN obiekt JSON w formacie:
            {
                "intent": "MATERIALY_ZAKUPY" | "SPRZET_CZAS" | "WIEDZA_OGOLNA" | "CHIT_CHAT"
            }
        `;

        const response = await ai.models.generateContent({
            // Używamy najszybszego, taniego modelu tylko do klasyfikacji tekstu
            model: 'gemini-2.5-flash-lite',
            contents: [{ role: 'user', parts: [{ text: currentText || "brak tekstu" }] }],
            config: { systemInstruction, temperature: 0.1 } 
        });

        if (response.text) {
            const extractedObjects = extractAllJSONObjects(response.text);
            if (extractedObjects.length > 0) {
                return NextResponse.json(extractedObjects[extractedObjects.length - 1], { status: 200 });
            }
        }
        throw new Error("Błąd parsowania odpowiedzi Dyspozytora.");
    } catch (err: any) {
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}