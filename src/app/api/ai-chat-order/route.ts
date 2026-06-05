// src/app/api/ai-chat-order/route.ts
import { NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || 'pesam-system-81165',
    location: 'global'
});

export const maxDuration = 60; // AI z Pythonem potrzebuje czasem chwili na uruchomienie kodu

// Prawdziwie pancerny ekstraktor JSON (odporny na zagnieżdżone obiekty i tablice)
function extractAllJSONObjects(text: string) {
    const objects = [];
    let depth = 0;
    let startIndex = -1;
    let inString = false;
    let escape = false;

    for (let i = 0; i < text.length; i++) {
        const char = text[i];

        if (inString) {
            if (char === '\\') escape = !escape;
            else if (char === '"' && !escape) inString = false;
            else escape = false;
        } else {
            if (char === '"') {
                inString = true;
            } else if (char === '{') {
                if (depth === 0) startIndex = i;
                depth++;
            } else if (char === '}') {
                if (depth > 0) {
                    depth--;
                    if (depth === 0 && startIndex !== -1) {
                        const jsonStr = text.substring(startIndex, i + 1);
                        try {
                            objects.push(JSON.parse(jsonStr));
                        } catch (e) {
                            // Ignorujemy błędne fragmenty
                        }
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
        const { history, currentText, currentAudioBase64 } = await req.json();

        const systemInstruction = `
            Jesteś Głównym Kosztorysantem Budowlanym w firmie PESAM. Prowadzisz wywiad z kierownikiem budowy, aby wyliczyć i skompletować dla niego dokładną listę materiałów.
            
            TWOJE ZASADY:
            1. Pytaj o szczegóły: Jeśli kierownik mówi "chcę ściankę z regipsów", dopytaj o długość, wysokość, grubość profilu (50/75/100), rodzaj płyty (zwykła/zielona/ogień) i czy wełna w środek.
            2. Python (Kalkulator): Do wszelkich wyliczeń zużycia (np. ile sztuk profili CD, ile m2 płyty, ile kg gipsu) UŻYWAJ PYTHONA. Znasz normy budowlane (np. profile co 60cm).
            3. Separacja tematów: Jeśli użytkownik kończy jeden temat (np. wyliczyłeś już bloczki) i w tej samej rozmowie nagle przechodzi do zupełnie innego tematu (np. ścianka G-K), odetnij stary kontekst. Skup się wyłącznie na nowym zadaniu.
            4. ZASADA TABLICY "generatedItems": W tablicy umieszczaj TYLKO I WYŁĄCZNIE materiały wyliczone dla BIEŻĄCEGO zapytania. Absolutnie NIE POWTARZAJ materiałów, które wyliczyłeś w poprzednich wiadomościach (np. jeśli wcześniej wyliczyłeś bloczki, a teraz liczysz G-K, w tablicy mają być tylko elementy G-K).
            5. Twoja odpowiedź musi być ZAWSZE poprawnym i czystym obiektem JSON zawierającym dwa pola:
               - "reply": Twoja wiadomość tekstowa do kierownika (odpowiedź, podsumowanie obliczeń lub dodatkowe pytania).
               - "generatedItems": Tablica z wyliczonymi materiałami (jeśli masz komplet danych). Jeśli wciąż pytasz o szczegóły, tablica musi być pusta: [].
            
            Struktura pojedynczego elementu w "generatedItems":
            { "name": "Pełna nazwa rynkowa", "quantity": 10, "unit": "szt." }

            BEZWZGLĘDNY WARUNEK: Wygeneruj DOKŁADNIE JEDEN obiekt JSON. Nie generuj dwóch obiektów jeden po drugim. Twoja odpowiedź musi kończyć się na pojedynczym nawiasie klamrowym zamknięcia "}".
        `;

        // Budujemy historię dla modelu
        const contents: any[] = history.map((msg: any) => ({
            role: msg.role === 'ai' ? 'model' : 'user',
            parts: [{ text: msg.content }]
        }));

        // Dodajemy aktualną wiadomość (Tekst lub Głos)
        const currentParts: any[] = [];
        if (currentText) currentParts.push({ text: currentText });
        if (currentAudioBase64) {
            currentParts.push({ text: "Odsłuchaj nagranie od kierownika:" });
            currentParts.push({
                inlineData: {
                    mimeType: "audio/mp3",
                    data: currentAudioBase64
                }
            });
        }
        
        contents.push({ role: 'user', parts: currentParts });

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: contents,
            config: {
                systemInstruction: systemInstruction,
                temperature: 0.1, // Bardzo niska temperatura dla stabilności formatu
                tools: [{ codeExecution: {} }] // ZOSTAWIANY PYTHONA!
            }
        });

        if (response.text) {
            let aiText = response.text.trim();
            
            // Oczyszczamy z ewentualnych znaczników markdownu ```json
            aiText = aiText.replace(/```json/gi, '').replace(/```/gi, '').trim();
            
            try {
                // Próba 1: Standardowe parsowanie (jeśli AI wypluło czysty, pojedynczy obiekt)
                const parsedJson = JSON.parse(aiText);
                return NextResponse.json(parsedJson, { status: 200 });
            } catch (parseErr) {
                console.warn("[AI Parser] Standardowe parsowanie zawiodło, uruchamiam inteligentny ekstraktor JSON...");
                
                // Próba 2: Inteligentne wyciąganie wszystkich poprawnych obiektów JSON z tekstu
                const extractedObjects = extractAllJSONObjects(aiText);
                
                if (extractedObjects.length > 0) {
                    // Bierzemy OSTATNI poprawny obiekt JSON (bo AI często najpierw generuje pusty, a potem pełny z wyliczeniami)
                    const finalObject = extractedObjects[extractedObjects.length - 1];
                    console.log("[AI Parser] Inteligentna ekstrakcja zakończona sukcesem!");
                    return NextResponse.json(finalObject, { status: 200 });
                }

                console.error("[AI Parser] Całkowity błąd parsowania. Surowy tekst z AI:", aiText);
                return NextResponse.json({
                    reply: "Mam problem ze sformatowaniem moich wyliczeń. Spróbuj opisać wymiary jeszcze raz.",
                    generatedItems: []
                }, { status: 200 });
            }
        } else {
            throw new Error("Pusta odpowiedź z API");
        }
    } catch (err: any) {
        console.error("Błąd AI Czatu:", err);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}