// ============================================================
// PESAM 3.0 – Agent Specjalista: BROKER (Zaopatrzeniowiec)
// POST /api/kosztorysant/broker-cenowy
// ============================================================

import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { FieldValue } from "firebase-admin/firestore";
import { GoogleGenAI, Type } from "@google/genai";

export const dynamic = "force-dynamic";

// Standard 3 & 4: Inicjalizacja klienta Google GenAI (Vertex AI, global, brak undici)
const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
    location: "global"
});

const MODEL_FLASH = "gemini-2.5-flash";

// Schemat dla Kroku 2 (Strukturyzacja)
const BROKER_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        prices: {
            type: Type.ARRAY,
            description: "Lista wycenionych pozycji.",
            items: {
                type: Type.OBJECT,
                properties: {
                    id: { type: Type.STRING, description: "ID pozycji (musi dokładnie pasować do wejściowego)" },
                    cenaJed: { type: Type.NUMBER, description: "Ustalona cena jednostkowa netto w PLN (tylko liczba)" },
                    uzasadnienie: { type: Type.STRING, description: "Krótkie źródło/uzasadnienie ceny, np. 'Średnia rynkowa z wyszukiwarki'" }
                },
                required: ["id", "cenaJed", "uzasadnienie"]
            }
        }
    },
    required: ["prices"]
};

export async function POST(req: Request) {
    // Bezpieczna deklaracja zmiennych (ochrona przed błędem strumienia w catch)
    let tenderId: string | undefined;
    let taskId: string | undefined;

    try {
        const body = await req.json();
        tenderId = body.tenderId;
        taskId = body.taskId;

        if (!tenderId || !taskId) {
            return NextResponse.json({ error: "Brak tenderId lub taskId" }, { status: 400 });
        }

        console.log(`[PESAM 3.0 💰] BROKER wybudzony. Przetarg: ${tenderId} | Zadanie: ${taskId}`);

        const taskRef = adminDb.collection(`tenders/${tenderId}/tasks`).doc(taskId);
        const taskDoc = await taskRef.get();

        if (!taskDoc.exists) throw new Error("Zadanie nie istnieje.");

        const taskData = taskDoc.data()!;

        // Idempotentność
        if (taskData.status !== "PENDING") {
            console.log(`[PESAM 3.0 💰] Zadanie ${taskId} ma status ${taskData.status}. Pomijam.`);
            return NextResponse.json({ message: "Task already processed." });
        }

        // 1. Oznaczamy zadanie jako IN_PROGRESS
        await taskRef.update({ status: "IN_PROGRESS", updatedAt: new Date() });

        // 2. Szukamy sekcji kosztorysu gotowych do wyceny (QUANTITY_READY)
        const estimateRef = adminDb.collection(`tenders/${tenderId}/estimate`);
        const sectionsSnap = await estimateRef.where("status", "==", "QUANTITY_READY").get();

        if (sectionsSnap.empty) {
            console.log(`[PESAM 3.0 💰] Brak pozycji do wyceny.`);
            await taskRef.update({ status: "DONE", result: { summary: "Brak pozycji o statusie QUANTITY_READY." } });

            // Wybudzenie Mózgu
            const origin = new URL(req.url).origin;
            fetch(`${origin}/api/kosztorysant/glowny-kosztorysant`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ tenderId, trigger: `TASK_COMPLETED_${taskId}` })
            }).catch(e => console.error("[PESAM 3.0] Błąd wybudzania Mózgu:", e));

            return NextResponse.json({ message: "Brak pozycji do wyceny." });
        }

        let totalTokensUsed = 0;
        let pricedItemsCount = 0;
        const batch = adminDb.batch();

        // 3. Przetwarzanie każdej sekcji
        for (const sectionDoc of sectionsSnap.docs) {
            const sectionData = sectionDoc.data();
            const items = sectionData.items || [];

            if (items.length === 0) continue;

            console.log(`[PESAM 3.0 💰] Wyceniam sekcję: ${sectionData.section} (${items.length} pozycji)`);

            // Przygotowanie listy do zapytania
            const itemsQuery = items.map((i: any) => `ID: ${i.id} | Pozycja: ${i.pozycja} | Opis: ${i.opis} | Jednostka: ${i.jednostka}`).join("\n");

            // ====================================================================
            // STANDARD 2: KROK 1 - WYSZUKIWANIE (Google Search Grounding, BEZ JSON)
            // ====================================================================
            const searchPrompt = `
Jesteś Brokerem Cenowym (Zaopatrzeniowcem) w Polsce.
Znajdź aktualne średnie ceny rynkowe netto (w PLN) dla poniższych robót/materiałów budowlanych.
Podaj konkretne kwoty za jednostkę. Zwróć odpowiedź jako zwykły tekst (raport).

Lista pozycji do wyceny:
${itemsQuery}
`;
            const searchResult = await ai.models.generateContent({
                model: MODEL_FLASH,
                contents: [{ role: "user", parts: [{ text: searchPrompt }] }],
                config: {
                    tools: [{ googleSearch: {} }] // Standard 2: Narzędzia zawsze wewnątrz config
                }
            });

            const searchContext = searchResult.text ?? "";
            totalTokensUsed += searchResult.usageMetadata?.totalTokenCount || 0;

            // ====================================================================
            // STANDARD 2: KROK 2 - STRUKTURYZACJA (JSON Schema, BEZ NARZĘDZI)
            // ====================================================================
            const structurePrompt = `
Na podstawie poniższego raportu cenowego, przypisz cenę jednostkową (cenaJed) do każdego ID pozycji.
Zwróć TYLKO poprawny obiekt JSON.

Raport cenowy:
${searchContext}
`;
            const structureResult = await ai.models.generateContent({
                model: MODEL_FLASH,
                contents: [{ role: "user", parts: [{ text: structurePrompt }] }],
                config: {
                    temperature: 0.1,
                    responseMimeType: "application/json",
                    responseSchema: BROKER_SCHEMA as any // Wymuszony JSON
                }
            });

            const structureText = structureResult.text ?? "{}";
            const parsedPrices = JSON.parse(structureText);
            totalTokensUsed += structureResult.usageMetadata?.totalTokenCount || 0;

            // 4. Aktualizacja pozycji w sekcji (Defensywne mapowanie id/itemId z jawnym typem Mapy - Standard 1)
            const priceMap = new Map<string, any>(parsedPrices.prices?.map((p: any) => [p.id, p]));
            let sectionTotalValue = 0;

            const updatedItems = items.map((item: any) => {
                const itemId = item.id || item.itemId;
                const priceData = priceMap.get(itemId);
                const newPrice = priceData ? Number(priceData.cenaJed) : 0;

                // Obliczanie wartości całkowitej dla pozycji
                const itemTotal = (Number(item.ilosc) || 0) * newPrice;
                sectionTotalValue += itemTotal;

                return {
                    ...item,
                    cenaJed: newPrice,
                    confidence: newPrice > 0 ? "HIGH" : "LOW",
                    sourceTrack: `${item.sourceTrack} -> Wycena: Broker (Google Search)`
                };
            });

            // Zapis zaktualizowanej sekcji do batcha
            batch.update(sectionDoc.ref, {
                items: updatedItems,
                totalValue: sectionTotalValue,
                status: "PRICED",
                updatedAt: new Date()
            });

            pricedItemsCount += updatedItems.length;
        }

        // 5. Zakończenie zadania i aktualizacja budżetu
        batch.update(taskRef, {
            status: "DONE",
            result: {
                pricedItems: pricedItemsCount,
                summary: `Wyceniono ${pricedItemsCount} pozycji na podstawie danych z internetu.`
            },
            costTokens: totalTokensUsed,
            updatedAt: new Date()
        });

        // Aktualizacja Budget Guard (Flash: ~$0.000015 / 1k tokenów)
        const costUSD = (totalTokensUsed / 1000) * 0.000015;
        const tenderRef = adminDb.collection("tenders").doc(tenderId);
        batch.update(tenderRef, {
            "budgetGuard.currentCostUSD": FieldValue.increment(costUSD)
        });

        await batch.commit();
        console.log(`[PESAM 3.0 💰] Zadanie ${taskId} zakończone. Wyceniono ${pricedItemsCount} pozycji.`);

        // 6. Wybudzenie Mózgu (ReAct Loop)
        const origin = new URL(req.url).origin;
        fetch(`${origin}/api/kosztorysant/glowny-kosztorysant`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tenderId, trigger: `TASK_COMPLETED_${taskId}` })
        }).catch(e => console.error("[PESAM 3.0] Błąd wybudzania Mózgu po wycenie:", e));

        return NextResponse.json({ success: true, pricedItemsCount });

    } catch (error: any) {
        console.error("[PESAM 3.0 💰] ❌ Błąd krytyczny Brokera Cenowego:", error);

        if (tenderId && taskId) {
            try {
                await adminDb.collection(`tenders/${tenderId}/tasks`).doc(taskId).update({
                    status: "ERROR",
                    result: { error: error.message }
                });
            } catch (dbError) {
                console.error("[PESAM 3.0 💰] Nie udało się zapisać statusu ERROR do bazy:", dbError);
            }
        }

        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}