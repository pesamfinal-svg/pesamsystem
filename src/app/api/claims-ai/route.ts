// src/app/api/claims-ai/route.ts
import { NextResponse } from 'next/server';
import { VertexAI } from '@google-cloud/vertexai';

export async function POST(req: Request) {
    try {
        const payload = await req.json();

        // Wyciągamy kompletne dane z akt sprawy przesłane z frontendu
        const {
            inventoryName,
            inventoryNumber,
            siteName,
            warehouseSummary, // To jest kluczowe podsumowanie od magazyniera
            messages,
            isInitial
        } = payload;

        // Inicjalizacja Vertex AI
        const vertexAI = new VertexAI({
            project: process.env.GCP_PROJECT_ID || 'pesam-system-81165',
            location: 'europe-west1'
        });

        // Konfiguracja modelu - Używamy 1.5-flash dla błyskawicznych odpowiedzi
        const model = vertexAI.getGenerativeModel({
            model: 'gemini-1.5-flash',
            systemInstruction: {
                role: 'system',
                parts: [{
                    text: `Jesteś bezwzględnym i technicznym Asystentem Śledczym PESAM. 
                    Twoim zadaniem jest konfrontowanie tłumaczeń kierowników budowy z faktami technicznymi z magazynu.
                    
                    ZASADY:
                    1. Bądź surowy, konkretny i techniczny. Żadnych uprzejmości.
                    2. Zadawaj MAKSYMALNIE 2-3 mordercze pytania.
                    3. Twoim celem jest wykazanie błędów w eksploatacji (np. złe zasilanie, brak czyszczenia, przeciążenie).
                    4. Jeśli magazyn stwierdził konkretne uszkodzenie (np. spalony silnik), Twoje pytania muszą uderzać w przyczynę (np. długość przedłużacza).`
                }]
            }
        });

        // --- SCENARIUSZ 1: GENEROWANIE PIERWSZEGO WEZWANIA DLA KIEROWNIKA ---
        if (isInitial) {
            const initialPrompt = `
            AKTA SPRAWY:
            - Sprzęt: ${inventoryName} (Nr: ${inventoryNumber || 'Brak'})
            - Budowa: ${siteName || 'Brak danych'}
            - RAPORT TECHNICZNY MAGAZYNU: ${warehouseSummary || 'Brak opisu.'}

            ZADANIE:
            Na podstawie powyższych faktów z magazynu, sformułuj pierwsze, surowe wezwanie do wyjaśnień dla kierownika. 
            Nie pytaj co się stało (bo wiemy to z raportu). Pytaj o techniczne okoliczności, które doprowadziły do stanu opisanego przez magazyn.
            Zadaj 2-3 precyzyjne pytania.
            `;

            const result = await model.generateContent(initialPrompt);
            const response = await result.response;
            const text = response.candidates?.[0]?.content?.parts?.[0]?.text || "Brak odpowiedzi AI.";

            return NextResponse.json({ reply: text });
        }

        // --- SCENARIUSZ 2: ANALIZA ROZMOWY I POMOC DLA DYREKTORA ---
        const formattedHistory = (messages || []).map((m: any) =>
            `[${m.senderRole}] ${m.senderName}: ${m.text}`
        ).join("\n\n");

        const analysisPrompt = `
        KONTEKST TECHNICZNY (Co widział magazyn): ${warehouseSummary}
        
        PRZEBIEG PRZESŁUCHANIA:
        ${formattedHistory}

        ZADANIE:
        Przeanalizuj odpowiedzi kierownika pod kątem technicznym. 
        Wskaż, gdzie jego wersja nie zgadza się z raportem magazynu. 
        Wypunktuj kłamstwa/niespójności i podpowiedz Dyrektorowi następne miażdżące pytanie.
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