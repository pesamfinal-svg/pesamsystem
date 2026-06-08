// ============================================================
// PESAM 3.0 – Agent Specjalista: UNIVERSAL_SPECIALIST (Kameleon)
// POST /api/kosztorysant/agent-kameleon
// ============================================================

import { NextResponse } from "next/server";
import { adminDb, adminStorage } from "@/lib/firebase/admin";
import { FieldValue } from "firebase-admin/firestore";
import { GoogleGenAI, Type } from "@google/genai";
import { v4 as uuidv4 } from "uuid";

export const dynamic = "force-dynamic";

const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
    location: "global"
});

const MODEL_PRO = "gemini-2.5-pro";

const KAMELEON_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        items: {
            type: Type.ARRAY,
            description: "Lista wyciągniętych pozycji specjalistycznych.",
            items: {
                type: Type.OBJECT,
                properties: {
                    pozycja: { type: Type.STRING },
                    opis: { type: Type.STRING },
                    ilosc: { type: Type.NUMBER },
                    KNR_ref: { type: Type.STRING }
                },
                required: ["pozycja", "opis", "ilosc", "KNR_ref"]
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

        console.log(`[PESAM 3.0 🦎] KAMELEON start dla: ${tenderId}`);

        const taskRef = adminDb.collection(`tenders/${tenderId}/tasks`).doc(taskId);
        const taskDoc = await taskRef.get();
        if (!taskDoc.exists || taskDoc.data()!.status !== "PENDING") {
            return NextResponse.json({ message: "Task handled." });
        }

        await taskRef.update({ status: "IN_PROGRESS", updatedAt: new Date() });
        const taskData = taskDoc.data()!;

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
Jesteś Ekspertem Technologicznym.
Zadanie: ${taskData.description}
Przeanalizuj plik i wyciągnij pozycje kosztorysowe. Zwróć JSON.
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
                        responseSchema: KAMELEON_SCHEMA as any
                    }
                });

                const parsedResult = JSON.parse(result.text ?? "{}");
                totalTokensUsed += result.usageMetadata?.totalTokenCount || 0;

                if (parsedResult.items) {
                    allExtractedItems.push(...parsedResult.items);
                }
            } catch (err) {
                console.error(err);
            }
        }

        const batch = adminDb.batch();

        if (allExtractedItems.length > 0) {
            const sectionId = `sec_kameleon_${taskId}`;
            const sectionRef = adminDb.collection(`tenders/${tenderId}/estimate`).doc(sectionId);

            // Standard 1: Zapis nagłówka sekcji z tablicą items dla błyskawicznego renderingu
            batch.set(sectionRef, {
                section: "Roboty Specjalistyczne (Kameleon)",
                status: "QUANTITY_READY",
                totalValue: 0,
                sourceTaskId: taskId,
                items: allExtractedItems.map((item: any) => ({
                    id: uuidv4(),
                    pozycja: item.pozycja || "Pozycja specjalistyczna",
                    opis: item.opis || "",
                    ilosc: Number(item.ilosc) || 0,
                    cenaJed: 0,
                    KNR_ref: item.KNR_ref || "WYCENA_INDYWIDUALNA",
                    confidence: "MEDIUM",
                    sourceTrack: `Analiza Kameleon (Task-${taskId})`
                })),
                updatedAt: new Date()
            });

            // Standard 1: Zapis pozycji do podkolekcji `items`
            allExtractedItems.forEach((item: any) => {
                const itemId = uuidv4();
                const itemRef = sectionRef.collection("items").doc(itemId);

                batch.set(itemRef, {
                    id: itemId,
                    pozycja: item.pozycja || "Pozycja specjalistyczna",
                    opis: item.opis || "",
                    ilosc: Number(item.ilosc) || 0,
                    cenaJed: 0,
                    KNR_ref: item.KNR_ref || "WYCENA_INDYWIDUALNA",
                    confidence: "MEDIUM",
                    sourceTrack: `Analiza Kameleon (Task-${taskId})`
                });
            });
        }

        batch.update(taskRef, {
            status: "DONE",
            result: { itemsCount: allExtractedItems.length },
            costTokens: totalTokensUsed,
            updatedAt: new Date()
        });

        const costUSD = (totalTokensUsed / 1000) * 0.002;
        batch.update(adminDb.collection("tenders").doc(tenderId), {
            "budgetGuard.currentCostUSD": FieldValue.increment(costUSD)
        });

        await batch.commit();

        const localOrigin = `http://127.0.0.1:${process.env.PORT || "3000"}`;
        console.log(`[PESAM 3.0 🦎] Wybudzam Mózg lokalnie przez loopback: ${localOrigin}`);

        fetch(`${localOrigin}/api/kosztorysant/glowny-kosztorysant`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tenderId, trigger: `TASK_COMPLETED_${taskId}` })
        }).catch(e => console.error("[PESAM 3.0] Błąd wybudzania Mózgu po analizie kameleon:", e));

        return NextResponse.json({ success: true, itemsExtracted: allExtractedItems.length });

    } catch (error: any) {
        console.error(error);
        if (tenderId && taskId) {
            await adminDb.collection(`tenders/${tenderId}/tasks`).doc(taskId).update({ status: "ERROR" }).catch(() => { });
        }
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}