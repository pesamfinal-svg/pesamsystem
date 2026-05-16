// src/app/api/claims-ai/route.ts
import { NextResponse } from 'next/server';
import { VertexAI } from '@google-cloud/vertexai';

// FUNKCJA POMOCNICZA: Konwertuje publiczny URL z Firebase Storage na wewnętrzny format `gs://`
// To jest kluczowy element, aby Vertex AI mogło "zobaczyć" obrazy.
function convertHttpsToGsUri(httpsUrl: string): string | null {
    // Sprawdzamy, czy link pasuje do wzorca Firebase Storage
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
            location: 'europe-west1' // Jeśli tu nadal będzie problem, zmień na 'us-central1'
        });

        // Używamy stabilnej i potężnej wersji modelu, która obsługuje multimodalność
        const model = vertexAI.getGenerativeModel({
            model: 'gemini-2.5-pro',
            systemInstruction: {
                role: 'system',
                parts: [{
                    text: `Jesteś Asystentem Śledczym PESAM. Twoim zadaniem jest konfrontowanie kierowników z faktami technicznymi z magazynu i dowodami wizualnymi. Bądź surowy, konkretny i techniczny. Zadawaj 2-3 kluczowe pytania, aby wykazać błędy w eksploatacji.`
                }]
            }
        });

        // --- SCENARIUSZ 1: PIERWSZE WEZWANIE DO KIEROWNIKA ---
        if (isInitial) {
            // Budujemy dynamicznie prompt składający się z tekstu i obrazów
            const promptParts: any[] = [
                { text: `AKTA SPRAWY:\n- Sprzęt: ${inventoryName} (Nr: ${inventoryNumber})\n- Budowa: ${siteName}\n- RAPORT TECHNICZNY MAGAZYNU: ${warehouseSummary}\n\nZADANIE:\nNa podstawie powyższego raportu i załączonych zdjęć dowodowych, sformułuj pierwsze, surowe wezwanie do wyjaśnień dla kierownika.` }
            ];

            // Jeśli frontend przesłał zdjęcia, konwertujemy je na format GS i dodajemy do promptu
            if (evidencePhotos && Array.isArray(evidencePhotos) && evidencePhotos.length > 0) {
                evidencePhotos.forEach((url: string) => {
                    const gsUri = convertHttpsToGsUri(url);
                    if (gsUri) {
                        promptParts.push({
                            fileData: {
                                mimeType: 'image/jpeg', // Zakładamy JPEG, można to rozbudować
                                fileUri: gsUri
                            }
                        });
                    }
                });
            }

            // Wysyłamy do AI kompletny, multimodalny prompt
            const result = await model.generateContent({ contents: [{ role: 'user', parts: promptParts }] });
            const response = await result.response;
            const text = response.candidates?.[0]?.content?.parts?.[0]?.text || "Błąd generowania odpowiedzi. Sprawdź logi.";

            return NextResponse.json({ reply: text });
        }

        // --- SCENARIUSZ 2: ANALIZA TRWAJĄCEJ ROZMOWY ---
        const formattedHistory = (messages || []).map((m: any) =>
            `[${m.senderRole}] ${m.senderName}: ${m.text}`
        ).join("\n\n");

        const analysisPrompt = `
        KONTEKST TECHNICZNY (Raport magazynu): ${warehouseSummary}
        
        PRZEBIEG PRZESŁUCHANIA:
        ${formattedHistory}

        ZADANIE:
        Przeanalizuj odpowiedzi kierownika. Wskaż niespójności z raportem magazynu i podpowiedz Dyrektorowi następne miażdżące pytanie.
        `;

        const result = await model.generateContent(analysisPrompt);
        const response = await result.response;
        const text = response.candidates?.[0]?.content?.parts?.[0]?.text || "Brak odpowiedzi AI.";

        return NextResponse.json({ reply: text });

    } catch (error: any) {
        console.error("--- Błąd Vertex AI Detail ---");
        console.error(error); // Wyświetli pełny błąd w logach serwera
        return NextResponse.json(
            { error: error.message || "Błąd wewnętrzny Vertex AI" },
            { status: 500 }
        );
    }
}