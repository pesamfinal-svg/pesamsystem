// src/app/api/ai-chat-order/route.ts
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
        const { history, currentText, currentAudioBase64 } = await req.json();

        // AI 1: DORADCA (Bez Pythona, tylko logika wyboru materiałów)
        const systemInstruction = `
            Jesteś Doradcą Budowlanym. Klient podaje wymiary i co chce zbudować (np. ścianka z G-K).
            Twoim zadaniem NIE JEST liczenie ilości. Twoim zadaniem jest zidentyfikowanie, JAKICH DECYZJI brakuje, aby móc to policzyć.
            
            ZASADY:
            1. Zidentyfikuj system (np. sucha zabudowa, murowanie).
            2. Wygeneruj opcje do wyboru dla klienta (np. rodzaj płyty, grubość profilu, rodzaj tynku).
            3. Zwróć DOKŁADNIE JEDEN obiekt JSON w formacie:
            {
                "reply": "Krótki tekst potwierdzający przyjęcie wymiarów i prośba o wybór materiałów poniżej.",
                "originalRequest": "Tutaj przepisz wymiary i cel podany przez klienta (np. Ścianka G-K 10x2.5m)",
                "materialOptions": [
                    { "category": "Grubość profilu", "options": ["50 mm", "75 mm", "100 mm"] },
                    { "category": "Rodzaj płyty", "options": ["Zwykła (GKB)", "Wodoodporna (GKBI)", "Ogień (GKF)"] }
                ]
            }
            Jeśli klient podał już wszystkie szczegóły w pierwszej wiadomości, i tak wygeneruj "materialOptions" z jedną opcją w każdej kategorii, aby mógł to zatwierdzić.
        `;

        const contents: any[] = history.map((msg: any) => ({
            role: msg.role === 'ai' ? 'model' : 'user',
            parts: [{ text: msg.content }]
        }));

        const currentParts: any[] = [];
        if (currentText) currentParts.push({ text: currentText });
        if (currentAudioBase64) currentParts.push({ inlineData: { mimeType: "audio/mp3", data: currentAudioBase64 } });
        contents.push({ role: 'user', parts: currentParts });

        const response = await ai.models.generateContent({
            model: 'gemini-3.5-flash',
            contents: contents,
            config: { systemInstruction, temperature: 0.2 } // Usunięto Pythona!
        });

        if (response.text) {
            const extractedObjects = extractAllJSONObjects(response.text);
            if (extractedObjects.length > 0) {
                return NextResponse.json(extractedObjects[extractedObjects.length - 1], { status: 200 });
            }
        }
        throw new Error("Błąd parsowania odpowiedzi Doradcy.");
    } catch (err: any) {
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}