// ============================================================
// PESAM 3.0 – Agent Specjalista: UNIVERSAL_SPECIALIST (Kameleon)
// POST /api/kosztorysant/agent-kameleon
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

// Kameleon używa modelu PRO, ponieważ musi adaptować się do skomplikowanych, nietypowych instrukcji
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
                    pozycja: { type: Type.STRING, description: "Nazwa elementu" },
                    opis: { type: Type.STRING, description: "Szczegółowy opis techniczny" },
                    ilosc: { type: Type.NUMBER, description: "Ilość (liczba)" },
                    jednostka: { type: Type.STRING, description: "Jednostka miary" },
                    KNR_ref: { type: Type.STRING, description: "Sugerowany kod lub 'WYCENA_INDYWIDUALNA'" }
                },
                required: ["pozycja", "opis", "ilosc", "jednostka", "KNR_ref"]
            }
        },
        summary: { type: Type.STRING, description: "Raport z wykonania zadania specjalnego." }
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

        console.log(`[PESAM 3.0 🦎] KAMELEON wybudzony. Przetarg: ${tenderId}`);

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

                // Kameleon przyjmuje tożsamość zadaną przez Mózg w taskData.description
                const prompt = `
Jesteś Uniwersalnym Specjalistą (Kameleonem) w systemie PESAM 3.0.
Mózg systemu nadał Ci następującą rolę i zadanie:
"${taskData.description}"

Przeanalizuj załączony dokument zgodnie z tą rolą.
Wyciągnij specjalistyczne pozycje kosztorysowe, ilości i parametry.
Zwróć dane w formacie JSON.
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
                        temperature: 0.2,
                        responseMimeType: "application/json",
                        responseSchema: KAMELEON_SCHEMA as any
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
                        cenaJed: 0,
                        KNR_ref: item.KNR_ref || "WYCENA_INDYWIDUALNA",
                        confidence: "MEDIUM",
                        sourceTrack: `Specjalista: Kameleon | Plik: ${docData.fileName}`
                    }));
                    allExtractedItems.push(...formattedItems);
                }
            } catch (err) {
                console.error(`[PESAM 3.0 🦎] Błąd analizy ${docData.fileName}:`, err);
            }
        }

        const batch = adminDb.batch();

        if (allExtractedItems.length > 0) {
            const sectionId = `sec_kameleon_${taskId}`;
            const estimateRef = adminDb.collection(`tenders/${tenderId}/estimate`).doc(sectionId);

            batch.set(estimateRef, {
                section: "Roboty Specjalistyczne (Nietypowe)",
                status: "QUANTITY_READY", // Przekazujemy Brokerowi do wyceny
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

        const origin = new URL(req.url).origin;
        fetch(`${origin}/api/kosztorysant/glowny-kosztorysant`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tenderId, trigger: `TASK_COMPLETED_${taskId}` })
        }).catch(e => console.error(e));

        return NextResponse.json({ success: true, itemsExtracted: allExtractedItems.length });

    } catch (error: any) {
        console.error("[PESAM 3.0 🦎] Błąd:", error);
        if (tenderId && taskId) {
            await adminDb.collection(`tenders/${tenderId}/tasks`).doc(taskId).update({ status: "ERROR" }).catch(() => { });
        }
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}