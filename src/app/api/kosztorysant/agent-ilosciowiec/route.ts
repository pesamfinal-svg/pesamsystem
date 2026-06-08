// ============================================================
// PESAM 3.0 – Agent Specjalista: BOQ_PARSER (Przedmiarowiec)
// POST /api/kosztorysant/agent-ilosciowiec
// ============================================================

import { NextResponse } from "next/server";
import { adminDb, adminStorage } from "@/lib/firebase/admin";
import { FieldValue } from "firebase-admin/firestore";
import { GoogleGenAI, Type } from "@google/genai";
import { randomUUID } from "crypto";

export const dynamic = "force-dynamic";

const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
    location: "global"
});

// Używamy modelu PRO, bo parsowanie gęstych tabel wymaga wysokiej precyzji
const MODEL_PRO = "gemini-2.5-pro";

const BOQ_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        items: {
            type: Type.ARRAY,
            items: {
                type: Type.OBJECT,
                properties: {
                    pozycja: { type: Type.STRING, description: "Numer lub krótka nazwa pozycji (np. '1.1', 'Wykopy')" },
                    opis: { type: Type.STRING, description: "Pełny opis z tabeli przedmiaru" },
                    ilosc: { type: Type.NUMBER, description: "Ilość z przedmiaru (tylko liczba)" },
                    jednostka: { type: Type.STRING, description: "Jednostka miary (np. m3, m2)" },
                    KNR_ref: { type: Type.STRING, description: "Podstawa wyceny (np. KNR 2-01 0119-03)" }
                },
                required: ["pozycja", "opis", "ilosc", "jednostka"]
            }
        },
        summary: { type: Type.STRING }
    },
    required: ["items", "summary"]
};

export async function POST(req: Request) {
    let tenderId: string | undefined;
    let taskId: string | undefined;

    try {
        const body = await req.json();
        tenderId = body.tenderId;
        taskId = body.taskId;

        if (!tenderId || !taskId) return NextResponse.json({ error: "Brak danych" }, { status: 400 });

        console.log(`[PESAM 3.0 📊] BOQ_PARSER wybudzony. Przetarg: ${tenderId}`);

        const taskRef = adminDb.collection(`tenders/${tenderId}/tasks`).doc(taskId);
        const taskDoc = await taskRef.get();
        if (!taskDoc.exists || taskDoc.data()!.status !== "PENDING") return NextResponse.json({ message: "Pominięto." });

        const taskData = taskDoc.data()!;
        await taskRef.update({ status: "IN_PROGRESS", updatedAt: new Date() });

        const inputDocIds: string[] = taskData.inputDocIds || [];
        let totalTokensUsed = 0;
        const allExtractedItems: any[] = [];

        const bucketName = process.env.STORAGE_BUCKET || "pesam-system-81165.firebasestorage.app";
        const bucket = adminStorage.bucket(bucketName);

        for (const docId of inputDocIds) {
            const docSnap = await adminDb.collection(`tenders/${tenderId}/documents`).doc(docId).get();
            if (!docSnap.exists) continue;
            const docData = docSnap.data()!;

            try {
                const fileRef = bucket.file(docData.storagePath);
                const [downloadedBuffer] = await fileRef.download();
                const safeArrayBuffer = new Uint8Array(downloadedBuffer).buffer;
                const base64Data = Buffer.from(safeArrayBuffer).toString("base64");

                const prompt = `
Jesteś Przedmiarowcem (BOQ_PARSER). Przeanalizuj załączony dokument (ślepy kosztorys / przedmiar).
Wyciągnij wszystkie pozycje kosztorysowe, ich opisy, ilości i jednostki.
Zignoruj puste wiersze i nagłówki stron. Zwróć czysty JSON.
`;
                const result = await ai.models.generateContent({
                    model: MODEL_PRO,
                    contents: [
                        {
                            role: "user",
                            parts: [
                                { text: prompt },
                                { inlineData: { data: base64Data, mimeType: docData.mimeType || "application/pdf" } }
                            ]
                        }
                    ],
                    config: {
                        temperature: 0.1,
                        responseMimeType: "application/json",
                        responseSchema: BOQ_SCHEMA as any
                    }
                });

                const parsedResult = JSON.parse(result.text ?? "{}");
                totalTokensUsed += result.usageMetadata?.totalTokenCount || 0;

                if (parsedResult.items) {
                    const formattedItems = parsedResult.items.map((item: any) => ({
                        id: randomUUID(),
                        pozycja: item.pozycja,
                        opis: item.opis,
                        ilosc: Number(item.ilosc) || 0,
                        jednostka: item.jednostka || "szt",
                        cenaJed: 0, // Broker wyceni
                        KNR_ref: item.KNR_ref || "Z Przedmiaru",
                        confidence: "HIGH",
                        sourceTrack: `Przedmiar: ${docData.fileName}`
                    }));
                    allExtractedItems.push(...formattedItems);
                }
            } catch (err) {
                console.error(`[PESAM 3.0 📊] Błąd parsowania ${docData.fileName}:`, err);
            }
        }

        const batch = adminDb.batch();

        if (allExtractedItems.length > 0) {
            const sectionId = `sec_boq_${taskId}`;
            const estimateRef = adminDb.collection(`tenders/${tenderId}/estimate`).doc(sectionId);

            batch.set(estimateRef, {
                section: "Pozycje z Przedmiaru (BOQ)",
                status: "QUANTITY_READY", // Gotowe dla Brokera
                totalValue: 0,
                sourceTaskId: taskId,
                items: allExtractedItems,
                updatedAt: new Date()
            });
        }

        batch.update(taskRef, {
            status: "DONE",
            result: { itemsExtracted: allExtractedItems.length },
            costTokens: totalTokensUsed,
            updatedAt: new Date()
        });

        // Model PRO jest droższy ($0.002 / 1k tokenów)
        const costUSD = (totalTokensUsed / 1000) * 0.002;
        batch.update(adminDb.collection("tenders").doc(tenderId), {
            "budgetGuard.currentCostUSD": FieldValue.increment(costUSD)
        });

        await batch.commit();

        const localOrigin = `http://127.0.0.1:${process.env.PORT || "3000"}`;
        console.log(`[PESAM 3.0 📊] Wybudzam Mózg lokalnie przez loopback: ${localOrigin}`);

        fetch(`${localOrigin}/api/kosztorysant/glowny-kosztorysant`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tenderId, trigger: `TASK_COMPLETED_${taskId}` })
        }).catch(e => console.error("[PESAM 3.0] Błąd wybudzania Mózgu po analizie przedmiaru:", e));

        return NextResponse.json({ success: true, itemsExtracted: allExtractedItems.length });

    } catch (error: any) {
        console.error("[PESAM 3.0 📊] Błąd:", error);
        if (tenderId && taskId) {
            await adminDb.collection(`tenders/${tenderId}/tasks`).doc(taskId).update({ status: "ERROR" }).catch(() => { });
        }
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}