// ============================================================
// PESAM 3.0 – Agent Specjalista: GAP_FILLER (Łatacz / Wskaźnikowiec)
// POST /api/kosztorysant/agent-gap-filler
// ============================================================

import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { FieldValue } from "firebase-admin/firestore";
import { GoogleGenAI, Type } from "@google/genai";
import { randomUUID } from "crypto";

export const dynamic = "force-dynamic";

const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
    location: "global"
});

const MODEL_FLASH = "gemini-2.5-flash";

// Schemat dla Kroku 2 (Strukturyzacja wskaźników)
const GAP_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        estimatedItems: {
            type: Type.ARRAY,
            description: "Lista oszacowanych pozycji wskaźnikowych.",
            items: {
                type: Type.OBJECT,
                properties: {
                    pozycja: { type: Type.STRING, description: "Nazwa brakującej branży/elementu, np. 'Instalacje elektryczne (szacunek wskaźnikowy)'" },
                    opis: { type: Type.STRING, description: "Uzasadnienie wskaźnika, np. 'Przyjęto 12% wartości stanu surowego na podstawie średnich rynkowych'" },
                    ilosc: { type: Type.NUMBER, description: "Ilość (zazwyczaj 1.0 dla kompletów lub powierzchnia m2)" },
                    jednostka: { type: Type.STRING, description: "Jednostka, np. 'kpl', 'm2'" },
                    KNR_ref: { type: Type.STRING, description: "Zawsze wpisz 'WSKAŹNIK_RYNKOWY'" }
                },
                required: ["pozycja", "opis", "ilosc", "jednostka", "KNR_ref"]
            }
        },
        summary: { type: Type.STRING, description: "Podsumowanie wyliczeń wskaźnikowych." }
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

        console.log(`[PESAM 3.0 🧩] GAP_FILLER wybudzony. Przetarg: ${tenderId}`);

        const taskRef = adminDb.collection(`tenders/${tenderId}/tasks`).doc(taskId);
        const taskDoc = await taskRef.get();
        if (!taskDoc.exists || taskDoc.data()!.status !== "PENDING") return NextResponse.json({ message: "Pominięto." });

        const taskData = taskDoc.data()!;
        await taskRef.update({ status: "IN_PROGRESS", updatedAt: new Date() });

        // 1. Zbieranie kontekstu (Co budujemy i co już mamy wycenione?)
        const tenderDoc = await adminDb.collection("tenders").doc(tenderId).get();
        const objectType = tenderDoc.data()?.objectType || "Obiekt budowlany";

        const estimateSnap = await adminDb.collection(`tenders/${tenderId}/estimate`).get();
        let currentTotalValue = 0;
        estimateSnap.docs.forEach(doc => {
            currentTotalValue += (doc.data().totalValue || 0);
        });

        let totalTokensUsed = 0;

        // ====================================================================
        // STANDARD 2: KROK 1 - WYSZUKIWANIE WSKAŹNIKÓW (Google Search)
        // ====================================================================
        const searchPrompt = `
Jesteś Kosztorysantem Wskaźnikowym. Budujemy obiekt: ${objectType}.
Obecna wartość wyliczonych robót (np. stan surowy) wynosi: ${currentTotalValue} PLN.

Zadanie od Głównego Inżyniera: ${taskData.description}

Użyj wyszukiwarki, aby znaleźć średnie wskaźniki procentowe lub cenowe (np. za m2 lub % całości) dla brakujących branż w tego typu obiektach w Polsce.
Zwróć raport tekstowy z propozycją wyliczeń.
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
        // STANDARD 2: KROK 2 - STRUKTURYZACJA (JSON Schema)
        // ====================================================================
        const structurePrompt = `
Na podstawie poniższego raportu wskaźnikowego, utwórz pozycje kosztorysowe.
Zwróć TYLKO poprawny obiekt JSON.

Raport:
${searchContext}
`;
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

        // 2. Zapis do Żywego Kosztorysu
        if (estimatedItems.length > 0) {
            const sectionId = `sec_gap_${taskId}`;
            const estimateRef = adminDb.collection(`tenders/${tenderId}/estimate`).doc(sectionId);

            const formattedItems = estimatedItems.map((item: any) => ({
                id: randomUUID(),
                pozycja: item.pozycja,
                opis: item.opis,
                ilosc: Number(item.ilosc) || 1,
                jednostka: item.jednostka || "kpl",
                cenaJed: 0, // Zostawiamy 0, Broker to wyceni lub Mózg zaakceptuje jako ryczałt
                KNR_ref: item.KNR_ref,
                confidence: "LOW", // Wskaźniki zawsze mają niską pewność
                sourceTrack: `Szacunek Wskaźnikowy (GAP_FILLER)`
            }));

            batch.set(estimateRef, {
                section: "Szacunki Wskaźnikowe (Braki w dokumentacji)",
                status: "QUANTITY_READY",
                totalValue: 0,
                sourceTaskId: taskId,
                items: formattedItems,
                updatedAt: new Date()
            });
        }

        // 3. Zakończenie zadania
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

        // 4. Wybudzenie Mózgu
        const origin = new URL(req.url).origin;
        fetch(`${origin}/api/kosztorysant/glowny-kosztorysant`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tenderId, trigger: `TASK_COMPLETED_${taskId}` })
        }).catch(e => console.error(e));

        return NextResponse.json({ success: true, itemsAdded: estimatedItems.length });

    } catch (error: any) {
        console.error("[PESAM 3.0 🧩] Błąd:", error);
        if (tenderId && taskId) {
            await adminDb.collection(`tenders/${tenderId}/tasks`).doc(taskId).update({ status: "ERROR" }).catch(() => { });
        }
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}