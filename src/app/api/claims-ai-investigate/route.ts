// src/app/api/claims-ai-investigate/route.ts
import { NextResponse } from 'next/server';
import { VertexAI } from '@google-cloud/vertexai';

interface ConversationMessage {
    role: "user" | "assistant";
    content: string;
}

export async function POST(req: Request) {
    try {
        const payload = await req.json();
        const { inventoryName, inventoryNumber, siteName, messages, isInitial } = payload;

        // Inicjalizacja Vertex AI wewnątrz funkcji (bezpieczne dla wdrożenia)
        const vertexAI = new VertexAI({
            project: process.env.GCP_PROJECT_ID || 'pesam-system-81165',
            location: 'europe-west1'
        });

        // 1. Logika sprawdzania, czy zdjęcia już są w historii rozmowy
        const clientMessages: ConversationMessage[] = messages || [];
        const hasPhotosInHistory = clientMessages.some(m =>
            m.content.includes("[Zdjęcia:") || m.content.toLowerCase().includes("załączyłem zdjęcie")
        );

        // 2. Wybór stabilnego modelu (1.5-pro jest najdokładniejszy do JSONa)
        const model = vertexAI.getGenerativeModel({
            model: 'gemini-2.5-pro',
            systemInstruction: {
                role: 'system',
                parts: [{
                    text: `Jesteś Asystentem Śledczym PESAM. Twoim rozmówcą jest MAGAZYNIER odbierający sprzęt "${inventoryName}" z budowy "${siteName}".

Twoje zadanie: zebrać konkretny raport techniczny przed przekazaniem sprawy do Zarządu.

PROTOKÓŁ PRZESŁUCHANIA MAGAZYNU:
Zadajesz JEDNO konkretne pytanie naraz. 

OBOWIĄZKOWE INFORMACJE DO ZEBRANIA:
1. STAN FIZYCZNY: Co dokładnie jest uszkodzone (pęknięcia, spalenia, braki)?
2. ROKOWANIA: Czy sprzęt nadaje się do naprawy, czy to złom?
3. GWARANCJA / HISTORIA: Czy jest gwarancja? Czy sprzęt był już w serwisie?
4. DOKUMENTACJA ZDJĘCIOWA: Czy są zdjęcia w systemie? 

STATUS ZDJĘĆ:
${hasPhotosInHistory
                            ? "UWAGA: Zdjęcia są już w aktach (punkt 4 ZALICZONY). Nie pytaj o nie. Potwierdź ich otrzymanie i przejdź do podsumowania."
                            : "PUNKT 4 (ZDJĘCIA) JEST WYMAGANY - dopytaj o nie, jeśli jeszcze ich nie ma."}

TAKTYKI:
- Magazynier NIE BYŁ na budowie. NIGDY nie pytaj o okoliczności awarii ani o to, kto zawinił.
- Skup się na technice i serwisie.
- Odpowiadaj WYŁĄCZNIE czystym JSON.

FORMAT JSON:
Gdy zbierasz info: {"reply":"Twoja wiadomość","isComplete":false,"needsPhotos":${hasPhotosInHistory ? "false" : "true"},"caseContext":null}
Gdy masz KOMPLET: {"reply":"Dziękuję. Protokół zabezpieczony.","isComplete":true,"needsPhotos":false,"caseContext":"RAPORT MAGAZYNU:\\nSprzęt: [nazwa]\\nStan: [opis]\\nDiagnoza: [naprawa/złom]\\nHistoria: [info]\\nZdjęcia: [tak/nie]"}`
                }]
            }
        });

        const INIT_MESSAGE = `Nowe zgłoszenie szkody. Sprzęt: "${inventoryName}" (Nr mag: ${inventoryNumber}), Budowa: "${siteName}". Rozpocznij szybki protokół zdawczo-odbiorczy z magazynem.`;

        // --- OBSŁUGA PIERWSZEGO WYWOŁANIA ---
        if (isInitial) {
            const result = await model.generateContent(INIT_MESSAGE);
            const response = await result.response;
            const rawText = response.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
            const cleanText = rawText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

            try {
                return NextResponse.json(JSON.parse(cleanText));
            } catch {
                return NextResponse.json({ reply: rawText, isComplete: false, needsPhotos: true, caseContext: null });
            }
        }

        // --- OBSŁUGA KONTYNUACJI ROZMOWY ---
        const allMessages: ConversationMessage[] = [
            { role: "user", content: INIT_MESSAGE },
            ...clientMessages
        ];

        if (allMessages.length < 2) {
            return NextResponse.json({ reply: "Błąd konwersacji.", isComplete: false, needsPhotos: true, caseContext: null });
        }

        const historyMessages = allMessages.slice(0, -1);
        const currentMessage = allMessages[allMessages.length - 1];

        const geminiHistory = historyMessages.map(m => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }]
        }));

        const chat = model.startChat({ history: geminiHistory });
        const result = await chat.sendMessage(currentMessage.content);
        const response = await result.response;
        const rawText = response.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
        const cleanText = rawText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

        try {
            return NextResponse.json(JSON.parse(cleanText));
        } catch {
            return NextResponse.json({ reply: rawText, isComplete: false, needsPhotos: true, caseContext: null });
        }

    } catch (error: any) {
        console.error("Investigation AI error:", error);
        return NextResponse.json(
            { error: error.message || "Błąd wewnętrzny Vertex AI" },
            { status: 500 }
        );
    }
}