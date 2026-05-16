// src/app/api/claims-ai-investigate/route.ts
import { NextResponse } from 'next/server';
import { VertexAI } from '@google-cloud/vertexai';

const vertexAI = new VertexAI({
    project: process.env.GCP_PROJECT_ID || 'pesam-system-81165',
    location: 'europe-west1'
});

interface ConversationMessage {
    role: "user" | "assistant";
    content: string;
}

export async function POST(req: Request) {
    try {
        const { inventoryName, inventoryNumber, siteName, messages, isInitial } = await req.json();

        const INIT_MESSAGE = `Nowe zgłoszenie szkody. Sprzęt: "${inventoryName}" (Nr mag: ${inventoryNumber}), Budowa: "${siteName}". Rozpocznij protokół przesłuchania.`;

        const model = vertexAI.getGenerativeModel({
            model: 'gemini-2.5-pro',
            systemInstruction: {
                role: 'system',
                parts: [{
                    text: `Jesteś Asystentem Śledczym PESAM – precyzyjnym, rzeczowym i nieustępliwym.
Twoje zadanie: zebrać KOMPLETNĄ dokumentację szkody dla sprzętu "${inventoryName}" z budowy "${siteName}" ZANIM sprawa trafi do Zarządu.

PROTOKÓŁ PRZESŁUCHANIA:
Zadajesz JEDNO pytanie naraz. Pytania są konkretne i techniczne. Jeśli odpowiedź jest ogólnikowa – dociskasz.

OBOWIĄZKOWE INFORMACJE DO ZEBRANIA (nie kończ bez nich):
1. OPIS USZKODZENIA: Co dokładnie jest uszkodzone? Jak wygląda? (pęknięte, zgięte, rozstrzaskane, przepalone, zalane?)
2. OKOLICZNOŚCI: Kiedy to się stało? Podczas jakiej pracy? Jakie warunki?
3. MECHANIZM: Jak doszło do uszkodzenia? Upadek, uderzenie, niewłaściwe użycie, wada?
4. OSOBY: Kto był ostatnim użytkownikiem? Czy byli świadkowie?
5. DOKUMENTACJA: Czy zostały wykonane zdjęcia? Jeśli nie – przypomnij o obowiązku ich dołączenia.

TAKTYKI PRZESŁUCHANIA:
- Na ogólnikowe "nie wiem" → pytaj kto wie lub kto był przy sprzęcie
- Na "zepsuło się samo" → pytaj o okoliczności dokładnie przed awarią
- Jeśli ktoś wymienia wielu użytkowników → pytaj o ostatniego konkretnie
- Brak zdjęć → przypomnij że są WYMAGANE do akt sprawy

WAŻNE - FORMAT ODPOWIEDZI:
Odpowiadaj WYŁĄCZNIE czystym JSON (bez markdown, bez żadnych dodatkowych znaków, bez backticks).

Gdy zbierasz informacje:
{"reply":"Twoja wiadomość do magazyniera","isComplete":false,"needsPhotos":true,"caseContext":null}

Gdy masz KOMPLET (wszystkie 5 punktów + wzmianka o zdjęciach):
{"reply":"Podsumowanie przesłuchania i informacja że sprawa trafia do Zarządu","isComplete":true,"needsPhotos":false,"caseContext":"PROTOKÓŁ WSTĘPNY:\\nSprzęt: [nazwa]\\nUszkodzenia: [opis]\\nOkoliczności: [kiedy, jak, gdzie]\\nOsoby: [kto]\\nDokumentacja: [czy są zdjęcia]\\nWstępna ocena: [co mogło być przyczyną]"}`
                }]
            }
        });

        // Build conversation for Gemini (uses 'user'/'model' roles, not 'user'/'assistant')
        let geminiHistory: Array<{ role: string; parts: Array<{ text: string }> }> = [];

        if (isInitial) {
            // First call - just the init message
            const result = await model.generateContent(INIT_MESSAGE);
            const response = await result.response;
            const rawText = response.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
            const cleanText = rawText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

            try {
                const parsed = JSON.parse(cleanText);
                return NextResponse.json(parsed);
            } catch {
                return NextResponse.json({ reply: rawText, isComplete: false, needsPhotos: true, caseContext: null });
            }
        }

        // Subsequent calls - build full conversation history
        const clientMessages: ConversationMessage[] = messages || [];

        // Prepend the init message as the first user turn
        const allMessages: ConversationMessage[] = [
            { role: "user", content: INIT_MESSAGE },
            ...clientMessages
        ];

        // Convert to Gemini format (role: 'user' | 'model')
        // Last message must be from 'user' for generateContent
        if (allMessages.length < 2) {
            return NextResponse.json({ reply: "Błąd konwersacji.", isComplete: false, needsPhotos: true, caseContext: null });
        }

        // Split into history (all but last) and current prompt (last)
        const historyMessages = allMessages.slice(0, -1);
        const currentMessage = allMessages[allMessages.length - 1];

        geminiHistory = historyMessages.map(m => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }]
        }));

        const chat = model.startChat({ history: geminiHistory });
        const result = await chat.sendMessage(currentMessage.content);
        const response = await result.response;
        const rawText = response.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
        const cleanText = rawText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

        try {
            const parsed = JSON.parse(cleanText);
            return NextResponse.json(parsed);
        } catch {
            return NextResponse.json({ reply: rawText, isComplete: false, needsPhotos: true, caseContext: null });
        }

    } catch (error: any) {
        console.error("Investigation AI (Vertex) error:", error);
        return NextResponse.json({ error: error.message || "Błąd Vertex AI" }, { status: 500 });
    }
}