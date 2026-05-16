// src/app/api/claims-ai-investigate/route.ts
import { NextResponse } from 'next/server';
import { VertexAI } from '@google-cloud/vertexai';

interface ConversationMessage {
    role: "user" | "assistant";
    content: string;
}

export async function POST(req: Request) {
    try {
        const vertexAI = new VertexAI({
            project: process.env.GCP_PROJECT_ID || 'pesam-system-81165',
            location: 'europe-west1'
        });

        const { inventoryName, inventoryNumber, siteName, messages, isInitial } = await req.json();

        const INIT_MESSAGE = `Nowe zgłoszenie szkody. Sprzęt: "${inventoryName}" (Nr mag: ${inventoryNumber}), Budowa: "${siteName}". Rozpocznij szybki protokół zdawczo-odbiorczy z magazynem.`;

        const model = vertexAI.getGenerativeModel({
            model: 'gemini-2.5-pro',
            systemInstruction: {
                role: 'system',
                parts: [{
                    text: `Jesteś Asystentem Śledczym PESAM. Twoim obecnym rozmówcą jest MAGAZYNIER, który właśnie fizycznie odebrał uszkodzony sprzęt ("${inventoryName}") wracający z budowy "${siteName}".

Twoje zadanie: przeprowadzić SZYBKI, konkretny wywiad z MAGAZYNIEREM, aby ocenić stan techniczny sprzętu i kwestie serwisowe, ZANIM sprawa zostanie przekazana do Zarządu i zanim rozpocznie się śledztwo z Kierownikiem Budowy.

PROTOKÓŁ PRZESŁUCHANIA MAGAZYNU:
Zadajesz JEDNO konkretne pytanie naraz. 

OBOWIĄZKOWE INFORMACJE DO ZEBRANIA OD MAGAZYNIERA (nie kończ bez nich):
1. STAN FIZYCZNY: Co dokładnie uległo uszkodzeniu z perspektywy magazynu (np. pęknięta obudowa, spalony silnik, brak wtyczki)?
2. ROKOWANIA: Jaka jest wstępna diagnoza magazynu? Czy sprzęt nadaje się do naprawy (własnej / serwisowej), czy to całkowity złom?
3. GWARANCJA / HISTORIA: Czy urządzenie jest jeszcze na gwarancji? Czy to urządzenie było już wcześniej wysyłane do serwisu lub sprawiało problemy?
4. DOKUMENTACJA ZDJĘCIOWA: Czy magazyn wykonał i załączył zdjęcia uszkodzeń w systemie? (Zdjęcia są wymagane).

TAKTYKI PRZESŁUCHANIA (BARDZO WAŻNE):
- PAMIĘTAJ: Magazynier NIE BYŁ na budowie. NIGDY nie pytaj go o to, jak doszło do awarii, o jakiej godzinie, kto był operatorem, ani czy byli świadkowie. Od tego będzie Kierownik!
- Skup się wyłącznie na "żelastwie" i "papierach".
- Jeśli odpowiedź to np. "zepsute" -> dociskaj o szczegóły techniczne (co dokładnie).

WAŻNE - FORMAT ODPOWIEDZI:
Odpowiadaj WYŁĄCZNIE czystym JSON (bez markdown, bez dodatkowych znaków).

Gdy zbierasz informacje:
{"reply":"Twoja wiadomość/pytanie do magazyniera","isComplete":false,"needsPhotos":true,"caseContext":null}

Gdy masz KOMPLET (zebrane 4 punkty, odpowiedziano o zdjęciach):
{"reply":"Dziękuję za raport techniczny. Pomyślnie zabezpieczono protokół z magazynu. Oczekuj na decyzję Zarządu, która zostanie wydana po przesłuchaniu Kierownika Budowy.","isComplete":true,"needsPhotos":false,"caseContext":"PROTOKÓŁ WERYFIKACJI MAGAZYNOWEJ:\\nSprzęt: [nazwa]\\nUszkodzenia: [opis fizyczny]\\nOcena magazynu: [naprawa/złom]\\nGwarancja/Historia: [co wiadomo]\\nZdjęcia: [zabezpieczone/brak]"}`
                }]
            }
        });

        let geminiHistory: Array<{ role: string; parts: Array<{ text: string }> }> = [];

        if (isInitial) {
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

        const clientMessages: ConversationMessage[] = messages || [];
        const allMessages: ConversationMessage[] = [
            { role: "user", content: INIT_MESSAGE },
            ...clientMessages
        ];

        if (allMessages.length < 2) {
            return NextResponse.json({ reply: "Błąd konwersacji.", isComplete: false, needsPhotos: true, caseContext: null });
        }

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
        console.error("Investigation AI error:", error);
        return NextResponse.json({ error: error.message || "Błąd Vertex AI" }, { status: 500 });
    }
}