// ============================================================
// PESAM 3.0 – Agent Specjalista: GAP_FILLER (Łatacz / Wskaźnikowiec)
// POST /api/kosztorysant/agent-gap-filler
// ============================================================

import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { FieldValue } from "firebase-admin/firestore";
import { GoogleGenAI, Type } from "@google/genai";
import { v4 as uuidv4 } from "uuid";

export const dynamic = "force-dynamic";

const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
    location: "global"
});

const MODEL_FLASH = "gemini-2.5-flash";

const GAP_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        estimatedItems: {
            type: Type.ARRAY,
            description: "Lista oszacowanych pozycji wskaźnikowych.",
            items: {
                type: Type.OBJECT,
                properties: {
                    pozycja: { type: Type.STRING, description: "Nazwa brakującej branży/elementu" },
                    opis: { type: Type.STRING, description: "Uzasadnienie rynkowe wskaźnika" },
                    ilosc: { type: Type.NUMBER, description: "Szacowana ilość (zawsze jako liczba)" },
                    KNR_ref: { type: Type.STRING, description: "Zawsze 'WSKAŹNIK_RYNKOWY'" }
                },
                required: ["pozycja", "opis", "ilosc", "KNR_ref"]
            }
        },
        summary: { type: Type.STRING, description: "Podsumowanie audytu braków." }
    },
    required: ["estimatedItems", "summary"]
};

export async function POST(req: Request) {
    let tenderId: string | undefined;
    let taskId: string | undefined;

    try {
        const body = await req.json();
        tenderId = body.tenderId;
        taskId = body.taskId;

        if (!tenderId || !taskId) return NextResponse.json({ error: "Brak danych" }, { status: 400 });

        console.log(`[PESAM 3.0 🧩] GAP_FILLER start dla: ${tenderId}`);

        const taskRef = adminDb.collection(`tenders/${tenderId}/tasks`).doc(taskId);
        const taskDoc = await taskRef.get();
        if (!taskDoc.exists || taskDoc.data()!.status !== "PENDING") {
            return NextResponse.json({ message: "Zadanie obsłużone." });
        }

        await taskRef.update({ status: "IN_PROGRESS", updatedAt: new Date() });

        const tenderDoc = await adminDb.collection("tenders").doc(tenderId).get();
        const objectType = tenderDoc.data()?.objectType || "Obiekt budowlany";

        let totalTokensUsed = 0;

        // KROK 1: Grounding Search
        const searchPrompt = `
Wyszukaj wskaźniki cenowe i procentowe dla brakującej branży w obiekcie typu: ${objectType}.
Zadanie: ${taskDoc.data()!.description}
Podaj standardowe wartości rynkowe w Polsce. Zwróć tekst.
`;

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

        // KROK 2: Strukturyzacja JSON
        const structurePrompt = `Na podstawie raportu, utwórz pozycje kosztorysowe. Raport:\n${searchContext}`;
        const structureResult = await ai.models.generateContent({
            model: MODEL_FLASH,
            contents: [{ role: "user", parts: [{ text: structurePrompt }] }],
            config: {
                temperature: 0.1,
                responseMimeType: "application/json",
                responseSchema: GAP_SCHEMA as any
            }
        });

        const parsedResult = JSON.parse(structureResult.text ?? "{}");
        totalTokensUsed += structureResult.usageMetadata?.totalTokenCount || 0;

        const estimatedItems = parsedResult.estimatedItems || [];
        const batch = adminDb.batch();

        if (estimatedItems.length > 0) {
            const sectionId = `sec_gap_${taskId}`;
            const sectionRef = adminDb.collection(`tenders/${tenderId}/estimate`).doc(sectionId);

            // Standard 1: Nagłówek sekcji kosztorysu z tablicą items dla renderowania na froncie
            batch.set(sectionRef, {
                section: "Szacunki Wskaźnikowe (Braki w dokumentacji)",
                status: "QUANTITY_READY",
                totalValue: 0,
                sourceTaskId: taskId,
                items: estimatedItems.map((item: any) => ({
                    id: uuidv4(),
                    pozycja: item.pozycja,
                    opis: item.opis,
                    ilosc: Number(item.ilosc) || 1,
                    cenaJed: 0,
                    KNR_ref: item.KNR_ref || "WSKAŹNIK_RYNKOWY",
                    confidence: "LOW",
                    sourceTrack: "Szacunek Wskaźnikowy (GAP_FILLER)"
                })),
                updatedAt: new Date()
            });

            // Standard 1: Pozycje jako dokumenty w podkolekcji `items`
            estimatedItems.forEach((item: any) => {
                const itemId = uuidv4();
                const itemRef = sectionRef.collection("items").doc(itemId);

                batch.set(itemRef, {
                    id: itemId,
                    pozycja: item.pozycja,
                    opis: item.opis,
                    ilosc: Number(item.ilosc) || 1,
                    cenaJed: 0,
                    KNR_ref: item.KNR_ref || "WSKAŹNIK_RYNKOWY",
                    confidence: "LOW",
                    sourceTrack: "Szacunek Wskaźnikowy (GAP_FILLER)"
                });
            });
        }

        batch.update(taskRef, {
            status: "DONE",
            result: { summary: parsedResult.summary, itemsAdded: estimatedItems.length },
            costTokens: totalTokensUsed,
            updatedAt: new Date()
        });

        const costUSD = (totalTokensUsed / 1000) * 0.000015;
        batch.update(adminDb.collection("tenders").doc(tenderId), {
            "budgetGuard.currentCostUSD": FieldValue.increment(costUSD)
        });

        await batch.commit();

        const localOrigin = `http://127.0.0.1:${process.env.PORT || "3000"}`;
        console.log(`[PESAM 3.0 🧩] Wybudzam Mózg lokalnie przez loopback: ${localOrigin}`);

        fetch(`${localOrigin}/api/kosztorysant/glowny-kosztorysant`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tenderId, trigger: `TASK_COMPLETED_${taskId}` })
        }).catch(e => console.error("[PESAM 3.0] Błąd wybudzania Mózgu po Gap Filler:", e));

        return NextResponse.json({ success: true, itemsAdded: estimatedItems.length });

    } catch (error: any) {
        console.error("[PESAM 3.0 🧩] Błąd:", error);
        if (tenderId && taskId) {
            await adminDb.collection(`tenders/${tenderId}/tasks`).doc(taskId).update({ status: "ERROR" }).catch(() => { });
        }
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}