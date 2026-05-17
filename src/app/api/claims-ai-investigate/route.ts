// src/app/api/claims-ai-investigate/route.ts
import { NextResponse } from 'next/server';
// 1. Zmieniamy na główny pakiet @google/genai
import { GoogleGenAI } from '@google/genai';

// 2. Inicjalizujemy klienta z flagą vertexai: true, aby połączyć się z Google Cloud
const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || 'pesam-system-81165',
    location: 'global' // Używamy globalnego endpointu dla modeli serii 3.1
});

export async function POST(req: Request) {
    try {
        const payload = await req.json();
        const {
            inventoryName,
            inventoryNumber,
            siteName,
            messages,
            isInitial,
            warehouseNotes,
            declaredStatus
        } = payload;

        // Używamy najnowszego, szybkiego i taniego modelu Gemini 3.1 Flash
        const modelName = 'gemini-3-flash-preview';

        const clientMessages = messages || [];
        const hasPhotosInHistory = clientMessages.some((m: any) =>
            m.content.includes("[Zdjęcia:") ||
            m.content.includes("[Dołączono") ||
            m.content.toLowerCase().includes("załączyłem zdjęcie")
        );

        // UŻYTO TWOJEGO DOKŁADNEGO PROMPTU z drobnymi modyfikacjami dla nowego SDK
        const systemInstruction = `Jesteś Asystentem Śledczym PESAM. Twoim rozmówcą jest MAGAZYNIER odbierający sprzęt "${inventoryName}" z budowy "${siteName}".

Twoje zadanie: zebrać konkretny raport techniczny przed przekazaniem sprawy do Zarządu.

PROTOKÓŁ PRZESŁUCHANIA MAGAZYNU:
Zadajesz JEDNO konkretne pytanie naraz. 

UWAGA: Magazynier już wstępnie zdiagnozował problem jako: "${warehouseNotes}". 
Z tego powodu POMIŃ pytanie o stan fizyczny (co jest zepsute). 
Od razu przejdź do pytań o rokowania (czy da się naprawić) lub historię serwisową.

OBOWIĄZKOWE INFORMACJE DO ZEBRANIA:
1. ROKOWANIA: Czy sprzęt nadaje się do naprawy, czy to złom?
2. GWARANCJA / HISTORIA: Czy jest gwarancja? Czy sprzęt był już w serwisie?
3. DOKUMENTACJA ZDJĘCIOWA: Czy są zdjęcia w systemie? 

STATUS ZDJĘĆ:
${hasPhotosInHistory
                ? "UWAGA: Zdjęcia są już w aktach (punkt 3 ZALICZONY). Nie pytaj o nie. Potwierdź ich otrzymanie i przejdź do podsumowania."
                : "PUNKT 3 (ZDJĘCIA) JEST WYMAGANY - dopytaj o nie, jeśli jeszcze ich nie ma."}

TAKTYKI:
- Magazynier NIE BYŁ na budowie. NIGDY nie pytaj o okoliczności awarii ani o to, kto zawinił.
- Skup się na technice i serwisie.
- Odpowiadaj WYŁĄCZNIE czystym JSON.

FORMAT JSON:
Gdy zbierasz info: {"reply":"Twoja wiadomość","isComplete":false,"needsPhotos":${hasPhotosInHistory ? "false" : "true"},"caseContext":null}
Gdy masz KOMPLET: {"reply":"Dziękuję. Protokół zabezpieczony.","isComplete":true,"needsPhotos":false,"caseContext":"RAPORT MAGAZYNU:\\nSprzęt: ${inventoryName}\\nStan: ${warehouseNotes || declaredStatus}\\nDiagnoza: [naprawa/złom]\\nHistoria: [info]\\nZdjęcia: [tak/nie]"}`;

        // Budujemy historię rozmowy dla nowego SDK (rola 'model' zamiast 'assistant')
        const contents = clientMessages.map((m: any) => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }]
        }));

        const initialPrompt = `Nowe zgłoszenie szkody. Sprzęt: "${inventoryName}" (Nr mag: ${inventoryNumber}), Budowa: "${siteName}".
Magazynier nadał status: "${declaredStatus || 'uszkodzone'}" i wpisał uwagę: "${warehouseNotes || 'Brak uwag'}".
Potwierdź odbiór tych informacji i przejdź bezpośrednio do pytania o rokowania lub gwarancję/historię.`;

        // Logika czatu - w nowym SDK jest prostsza. Przekazujemy całą historię i dodajemy nową wiadomość na końcu.
        const finalContents = isInitial
            ? [{ role: 'user', parts: [{ text: initialPrompt }] }]
            : contents;

        const response = await ai.models.generateContent({
            model: modelName,
            contents: finalContents,
            config: {
                systemInstruction: systemInstruction,
                temperature: 0.2, // Niska temperatura dla stabilnego JSON
                responseMimeType: "application/json" // Wymuszamy format JSON, aby uniknąć błędów
            }
        });

        // W nowym SDK odpowiedź tekstowa jest bezpośrednio dostępna i czysta (bez ```)
        const rawText = response.text || '{}';

        return NextResponse.json(JSON.parse(rawText));

    } catch (error: any) {
        console.error("Investigation AI error:", error);
        return NextResponse.json(
            { error: error.message || "Błąd wewnętrzny Google Gen AI" },
            { status: 500 }
        );
    }
}