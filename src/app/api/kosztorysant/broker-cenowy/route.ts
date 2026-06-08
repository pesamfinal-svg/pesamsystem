// ============================================================
// PESAM 3.0 – Broker Cenowy (Ścisła zgodność ze strukturą bazy)
// POST /api/kosztorysant/broker-cenowy
// ============================================================

import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { FieldValue } from "firebase-admin/firestore";
import { GoogleGenAI, Type } from "@google/genai";

export const dynamic = "force-dynamic";

const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
    location: "global"
});

const MODEL_FLASH = "gemini-2.5-flash";

const BROKER_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        prices: {
            type: Type.ARRAY,
            description: "Lista wycenionych pozycji.",
            items: {
                type: Type.OBJECT,
                properties: {
                    id: { type: Type.STRING },
                    cenaJed: { type: Type.NUMBER, description: "Cena rynkowa netto w PLN" }
                },
                required: ["id", "cenaJed"]
            }
        }
    },
    required: ["prices"]
};

export async function POST(req: Request) {
    let tenderId: string | undefined;
    let taskId: string | undefined;

    try {
        const body = await req.json();
        tenderId = body.tenderId;
        taskId = body.taskId;

        if (!tenderId || !taskId) return NextResponse.json({ error: "Brak danych" }, { status: 400 });

        console.log(`[PESAM 3.0 💰] BROKER start dla: ${tenderId}`);

        const taskRef = adminDb.collection(`tenders/${tenderId}/tasks`).doc(taskId);
        const taskDoc = await taskRef.get();
        if (!taskDoc.exists || taskDoc.data()!.status !== "PENDING") {
            return NextResponse.json({ message: "Task handled." });
        }

        await taskRef.update({ status: "IN_PROGRESS", updatedAt: new Date() });

        // Pobieramy sekcje do wyceny (QUANTITY_READY)
        const estimateRef = adminDb.collection(`tenders/${tenderId}/estimate`);
        const sectionsSnap = await estimateRef.where("status", "==", "QUANTITY_READY").get();

        if (sectionsSnap.empty) {
            await taskRef.update({ status: "DONE", result: { summary: "Brak pozycji do wyceny." } });

            const origin = new URL(req.url).origin;
            fetch(`${origin}/api/kosztorysant/glowny-kosztorysant`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ tenderId, trigger: `TASK_COMPLETED_${taskId}` })
            }).catch(e => console.error(e));

            return NextResponse.json({ message: "Brak pozycji." });
        }

        let totalTokensUsed = 0;
        let pricedItemsCount = 0;
        const globalBatch = adminDb.batch();

        for (const sectionDoc of sectionsSnap.docs) {
            const sectionId = sectionDoc.id;

            // Standard 1: Pobieramy pozycje bezpośrednio z podkolekcji `items`
            const itemsSnap = await estimateRef.doc(sectionId).collection("items").get();
            const items = itemsSnap.docs.map(d => d.data());

            if (items.length === 0) continue;

            const itemsQuery = items.map((i: any) =>
                `ID: ${i.id} | Pozycja: ${i.pozycja} | Opis: ${i.opis}`
            ).join("\n");

            // KROK 1: Grounding Search
            const searchPrompt = `Znajdź aktualne ceny netto w Polsce dla pozycji:\n${itemsQuery}\nZwróć raport tekstowy.`;

            // POPRAWKA TS2353: 'tools' poprawnie zagnieżdżone wewnątrz obiektu 'config'
            const searchResult = await ai.models.generateContent({
                model: MODEL_FLASH,
                contents: [{ role: "user", parts: [{ text: searchPrompt }] }],
                config: {
                    tools: [{ googleSearch: {} }]
                }
            });

            const searchContext = searchResult.text ?? "";
            totalTokensUsed += searchResult.usageMetadata?.totalTokenCount || 0;

            // KROK 2: JSON
            const structurePrompt = `Zwróć JSON z cenami jednostkowymi na podstawie raportu:\n${searchContext}`;
            const structureResult = await ai.models.generateContent({
                model: MODEL_FLASH,
                contents: [{ role: "user", parts: [{ text: structurePrompt }] }],
                config: {
                    temperature: 0.1,
                    responseMimeType: "application/json",
                    responseSchema: BROKER_SCHEMA as any
                }
            });

            const parsedPrices = JSON.parse(structureResult.text ?? "{}");
            totalTokensUsed += structureResult.usageMetadata?.totalTokenCount || 0;

            // POPRAWKA TS2363: Jawne typowanie mapy jako <string, number> w celu eliminacji błędu typów przy operacji arytmetycznej
            const priceMap = new Map<string, number>(
                (parsedPrices.prices || []).map((p: any) => [p.id, Number(p.cenaJed) || 0])
            );
            let sectionTotalValue = 0;

            for (const itemDoc of itemsSnap.docs) {
                const itemData = itemDoc.data();
                const price = priceMap.get(itemDoc.id) || 0; // price jest bezpiecznie wnioskowane jako number

                sectionTotalValue += (Number(itemData.ilosc) || 0) * price;

                globalBatch.update(itemDoc.ref, {
                    cenaJed: price,
                    confidence: "HIGH",
                    sourceTrack: `${itemData.sourceTrack || ""} -> Wycena: Broker (Google Search)`
                });
            }

            // Aktualizacja dokumentu głównego sekcji
            globalBatch.update(sectionDoc.ref, {
                totalValue: sectionTotalValue,
                status: "PRICED",
                updatedAt: new Date()
            });

            pricedItemsCount += items.length;
        }

        // Zakończenie zadania i aktualizacja budżetu
        globalBatch.update(taskRef, {
            status: "DONE",
            result: { pricedItems: pricedItemsCount },
            costTokens: totalTokensUsed,
            updatedAt: new Date()
        });

        const costUSD = (totalTokensUsed / 1000) * 0.000015;
        globalBatch.update(adminDb.collection("tenders").doc(tenderId), {
            "budgetGuard.currentCostUSD": FieldValue.increment(costUSD)
        });

        await globalBatch.commit();
        console.log(`[PESAM 3.0 💰] Ukończono wycenę subkolekcji. Pozycji: ${pricedItemsCount}`);

        const localOrigin = `http://127.0.0.1:${process.env.PORT || "3000"}`;
        console.log(`[PESAM 3.0 💰] Wybudzam Mózg lokalnie przez loopback: ${localOrigin}`);

        fetch(`${localOrigin}/api/kosztorysant/glowny-kosztorysant`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tenderId, trigger: `TASK_COMPLETED_${taskId}` })
        }).catch(e => console.error("[PESAM 3.0] Błąd wybudzania Mózgu po wycenie:", e));

        return NextResponse.json({ success: true, pricedItemsCount });

    } catch (error: any) {
        console.error(error);
        if (tenderId && taskId) {
            await adminDb.collection(`tenders/${tenderId}/tasks`).doc(taskId).update({ status: "ERROR" }).catch(() => { });
        }
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}