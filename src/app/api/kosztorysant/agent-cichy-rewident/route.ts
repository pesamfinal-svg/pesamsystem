// ============================================================
// PESAM 3.0 – Agent Specjalista: SILENT_AUDITOR (Cichy Rewident)
// POST /api/kosztorysant/agent-cichy-rewident
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

// Schemat dla Kroku 2 (Strukturyzacja braków) - Standard 1
const AUDITOR_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        missingItems: {
            type: Type.ARRAY,
            description: "Lista brakujących elementów technologicznych/prawnych.",
            items: {
                type: Type.OBJECT,
                properties: {
                    pozycja: { type: Type.STRING, description: "Nazwa brakującego elementu, np. 'Separator tłuszczu', 'Drzwi ppoż EI60'" },
                    opis: { type: Type.STRING, description: "Uzasadnienie prawne/technologiczne, np. 'Wymóg WT 2021 dla kuchni zbiorowego żywienia'" },
                    ilosc: { type: Type.NUMBER, description: "Szacowana ilość (zawsze liczba)" },
                    jednostka: { type: Type.STRING, description: "Jednostka, np. 'kpl', 'szt'" },
                    KNR_ref: { type: Type.STRING, description: "Zawsze wpisz 'TECH_REQUIRED'" },
                    confidence: { type: Type.STRING, description: "Zawsze 'HIGH'" }
                },
                required: ["pozycja", "opis", "ilosc", "jednostka", "KNR_ref", "confidence"]
            }
        },
        summary: { type: Type.STRING, description: "Podsumowanie audytu." }
    },
    required: ["missingItems", "summary"]
};

export async function POST(req: Request) {
    // Bezpieczna deklaracja zmiennych (ochrona przed błędem strumienia w catch)
    let tenderId: string | undefined;
    let taskId: string | undefined;

    try {
        const body = await req.json();
        tenderId = body.tenderId;
        taskId = body.taskId;

        if (!tenderId || !taskId) return NextResponse.json({ error: "Brak danych" }, { status: 400 });

        console.log(`[PESAM 3.0 🕵️] SILENT_AUDITOR wybudzony. Przetarg: ${tenderId}`);

        const taskRef = adminDb.collection(`tenders/${tenderId}/tasks`).doc(taskId);
        const taskDoc = await taskRef.get();
        if (!taskDoc.exists) throw new Error("Zadanie nie istnieje.");

        const taskData = taskDoc.data()!;

        if (taskData.status !== "PENDING") return NextResponse.json({ message: "Task processed." });
        await taskRef.update({ status: "IN_PROGRESS", updatedAt: new Date() });

        // 1. Zbieranie kontekstu (Co budujemy i co już mamy?)
        const tenderDoc = await adminDb.collection("tenders").doc(tenderId).get();
        const objectType = tenderDoc.data()?.objectType || "Obiekt budowlany";

        const estimateSnap = await adminDb.collection(`tenders/${tenderId}/estimate`).get();
        const existingItems: string[] = [];
        estimateSnap.docs.forEach(doc => {
            const items = doc.data().items || [];
            items.forEach((i: any) => existingItems.push(i.pozycja));
        });

        let totalTokensUsed = 0;

        // ====================================================================
        // STANDARD 2: KROK 1 - WYSZUKIWANIE (Google Search Grounding)
        // ====================================================================
        const searchPrompt = `
Jesteś Cichym Rewidentem Technologicznym w Polsce.
Budujemy obiekt typu: ${objectType}.
Obecnie w kosztorysie mamy m.in.: ${existingItems.slice(0, 50).join(", ")}.

Użyj wyszukiwarki, aby sprawdzić aktualne przepisy (WT 2021, PPOŻ, Sanepid).
Czego ewidentnie brakuje w tym zestawieniu, a jest absolutnie wymagane prawem lub technologią dla tego typu obiektu? 
Wymień te elementy i krótko uzasadnij. Zwróć zwykły tekst.
`;

        const searchResult = await ai.models.generateContent({
            model: MODEL_FLASH,
            contents: [{ role: "user", parts: [{ text: searchPrompt }] }],
            config: {
                tools: [{ googleSearch: {} }], // Standard 2: Narzędzia zawsze wewnątrz config
                temperature: 0.1
            }
        });

        const searchContext = searchResult.text ?? "";
        totalTokensUsed += searchResult.usageMetadata?.totalTokenCount || 0;

        // ====================================================================
        // STANDARD 2: KROK 2 - STRUKTURYZACJA (JSON Schema)
        // ====================================================================
        const structurePrompt = `
Na podstawie poniższego raportu z audytu, wyodrębnij brakujące elementy jako pozycje kosztorysowe.
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
                responseSchema: AUDITOR_SCHEMA as any
            }
        });

        const parsedResult = JSON.parse(structureResult.text ?? "{}");
        totalTokensUsed += structureResult.usageMetadata?.totalTokenCount || 0;

        const missingItems = parsedResult.missingItems || [];
        const batch = adminDb.batch();

        // 2. Zapis braków do Żywego Kosztorysu
        if (missingItems.length > 0) {
            const sectionId = `sec_auditor_${taskId}`;
            const estimateRef = adminDb.collection(`tenders/${tenderId}/estimate`).doc(sectionId);

            const formattedItems = missingItems.map((item: any) => ({
                id: randomUUID(),
                pozycja: item.pozycja,
                opis: item.opis,
                ilosc: Number(item.ilosc) || 1,
                jednostka: item.jednostka || "kpl",
                cenaJed: 0, // Broker to wyceni
                KNR_ref: item.KNR_ref,
                confidence: item.confidence,
                sourceTrack: `Audyt Technologiczny (SILENT_AUDITOR)`
            }));

            batch.set(estimateRef, {
                section: "Wymogi Prawne i Technologiczne (Audyt)",
                status: "QUANTITY_READY", // Gotowe dla Brokera
                totalValue: 0,
                sourceTaskId: taskId,
                items: formattedItems,
                updatedAt: new Date()
            });
        }

        // 3. Zakończenie zadania
        batch.update(taskRef, {
            status: "DONE",
            result: { summary: parsedResult.summary, itemsAdded: missingItems.length },
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

        return NextResponse.json({ success: true, itemsAdded: missingItems.length });

    } catch (error: any) {
        console.error("[PESAM 3.0 🕵️] Błąd krytyczny Cichego Rewidenta:", error);

        // Bezpieczny raport awarii bez ponownego odczytu strumienia req
        if (tenderId && taskId) {
            try {
                await adminDb.collection(`tenders/${tenderId}/tasks`).doc(taskId).update({
                    status: "ERROR",
                    result: { error: error.message }
                });
            } catch (dbError) {
                console.error("[PESAM 3.0 🕵️] Nie udało się zapisać statusu błędu:", dbError);
            }
        }
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}