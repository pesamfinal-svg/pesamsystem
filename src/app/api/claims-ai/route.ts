// src/app/api/claims-ai/route.ts
import { NextResponse } from 'next/server';
import { VertexAI } from '@google-cloud/vertexai';

// FUNKCJA POMOCNICZA: Konwertuje publiczny URL z Firebase Storage na wewnętrzny format `gs://`
function convertHttpsToGsUri(httpsUrl: string): string | null {
    const match = httpsUrl.match(/https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/([^/]+)\/o\/([^?]+)/);
    if (!match) {
        console.warn(`URL nie pasuje do formatu Firebase Storage: ${httpsUrl}`);
        return null;
    }
    const bucket = match[1];
    const objectPath = decodeURIComponent(match[2]);
    return `gs://${bucket}/${objectPath}`;
}

export async function POST(req: Request) {
    try {
        const payload = await req.json();

        const {
            inventoryName,
            inventoryNumber,
            siteName,
            warehouseSummary,
            evidencePhotos, // Tablica publicznych URL-i do zdjęć
            messages,
            isInitial
        } = payload;

        const vertexAI = new VertexAI({
            project: process.env.GCP_PROJECT_ID || 'pesam-system-81165',
            location: 'europe-west1'
        });

        // Używamy stabilnej i potężnej wersji modelu, która obsługuje multimodalność
        const model = vertexAI.getGenerativeModel({
            model: 'gemini-2.5-pro',
            systemInstruction: {
                role: 'system',
                parts: [{
                    // ZMIANA: Zmieniono rolę z "surowego śledczego" na "inteligentnego doradcę" (styl Google)
                    text: `Jesteś Asystentem Śledczym PESAM i inteligentnym doradcą Dyrektora. Twoim zadaniem jest podpowiadanie Dyrektorowi trafnych, dociekliwych pytań do zadania Kierownikowi budowy na czacie. Krótko, konkretnie, w formie listy pytań.`
                }]
            }
        });

        // --- SCENARIUSZ 1: PIERWSZE WEZWANIE DO KIEROWNIKA ---
        if (isInitial) {
            const promptParts: any[] = [
                {
                    text: `
                Jesteś asystentem Dyrektora. Otwieracie nową sprawę dotyczącą zniszczonego sprzętu.
                
                AKTA SPRAWY:
                - Sprzęt: ${inventoryName} (Nr: ${inventoryNumber})
                - Budowa: ${siteName}
                - Raport magazynu: ${warehouseSummary}
                
                ZADANIE:
                Na podstawie raportu magazynu i ewentualnych zdjęć, zaproponuj 3 krótkie, ostre pytania, które Dyrektor powinien zadać kierownikowi budowy, aby pociągnąć go za język.
                Zwróć TYLKO pytania. Każde pytanie w osobnej linii, poprzedzone numerem. Żadnych wstępów, powitań ani elaboratów.
                ` }
            ];

            if (evidencePhotos && Array.isArray(evidencePhotos) && evidencePhotos.length > 0) {
                evidencePhotos.forEach((url: string) => {
                    const gsUri = convertHttpsToGsUri(url);
                    if (gsUri) {
                        promptParts.push({
                            fileData: {
                                mimeType: 'image/jpeg',
                                fileUri: gsUri
                            }
                        });
                    }
                });
            }

            const result = await model.generateContent({ contents: [{ role: 'user', parts: promptParts }] });
            const response = await result.response;
            const text = response.candidates?.[0]?.content?.parts?.[0]?.text || "Błąd generowania odpowiedzi. Sprawdź logi.";

            return NextResponse.json({ reply: text });
        }

        // --- SCENARIUSZ 2: ANALIZA TRWAJĄCEJ ROZMOWY ---
        const formattedHistory = (messages || []).map((m: any) =>
            `[${m.senderRole}] ${m.senderName}: ${m.text}`
        ).join("\n\n");

        // ZMIANA: Całkowicie nowy prompt wzorowany na wyszukiwarce Google AI
        const analysisPrompt = `
        Działasz jako inteligentny doradca Dyrektora w systemie PESAM. 
        Analizujesz trwającą właśnie wymianę wiadomości (czat) pomiędzy Kierownikiem a Dyrekcją/Magazynem.
        
        KONTEKST (Co ustalił magazyn): ${warehouseSummary}
        
        HISTORIA CZATU:
        ${formattedHistory}

        TWOJE ZADANIE:
        Na podstawie tego co już zostało powiedziane wyżej, zaproponuj Dyrektorowi 2-3 krótkie, naturalne i dociekliwe pytania, które może teraz zadać Kierownikowi, aby wyciągnąć więcej informacji lub obnażyć błędy w eksploatacji.
        
        WYTYCZNE:
        - NIE pisz elaboratów ani oficjalnych wezwań.
        - Zachowuj się jak podpowiadacz (tak jak Tryb AI w wyszukiwarce Google).
        - Zwróć wynik jako prostą listę wypunktowaną z numerami (1., 2. itd.) na początku linii (bez zbędnych wstępów i listów do kogokolwiek).
        `;

        const result = await model.generateContent(analysisPrompt);
        const response = await result.response;
        const text = response.candidates?.[0]?.content?.parts?.[0]?.text || "Brak odpowiedzi AI.";

        return NextResponse.json({ reply: text });

    } catch (error: any) {
        console.error("--- Błąd Vertex AI Detail ---");
        console.error(error);
        return NextResponse.json(
            { error: error.message || "Błąd wewnętrzny Vertex AI" },
            { status: 500 }
        );
    }
}