import { NextResponse } from "next/server";
import { adminDb, adminStorage } from "@/lib/firebase/admin";
import { FieldValue } from "firebase-admin/firestore";
import { GoogleGenAI } from "@google/genai";

export const dynamic = "force-dynamic";

const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
    location: "global"
});

// Zabezpieczenie przed przeciążeniem chmury przy wysyłaniu ciężkich rysunków technicznych
async function callGeminiWithRetry(fn: () => Promise<any>, retries = 3, delay = 3000): Promise<any> {
    try {
        return await fn();
    } catch (error: any) {
        const errorText = error.toString() || "";
        const isRateLimit = errorText.includes("429") || errorText.includes("RESOURCE_EXHAUSTED");

        if (isRateLimit && retries > 0) {
            console.warn(`[VISION 📐] Wykryto limit API 429. Chmura przeciążona rysunkami. Czekam ${delay / 1000}s... (Pozostało prób: ${retries})`);
            await new Promise(resolve => setTimeout(resolve, delay));
            return callGeminiWithRetry(fn, retries - 1, delay * 2);
        }
        throw error;
    }
}

export async function POST(req: Request) {
    let tenderId: string | undefined;
    let taskId: string | undefined;
    let isSuccess = false;

    try {
        const body = await req.json();
        tenderId = body.tenderId;
        taskId = body.taskId;

        console.log(`[VISION 📐] Otrzymano żądanie POST. tenderId: ${tenderId}, taskId: ${taskId}`);

        if (!tenderId || !taskId) {
            return NextResponse.json({ error: "Brak tenderId lub taskId" }, { status: 400 });
        }

        const taskRef = adminDb.collection(`tenders/${tenderId}/tasks`).doc(taskId);
        const taskDoc = await taskRef.get();

        if (!taskDoc.exists) throw new Error("Zadanie nie istnieje.");

        const taskData = taskDoc.data()!;
        if (taskData.status !== "PENDING") return NextResponse.json({ message: "Task already processed." });

        await taskRef.update({ status: "IN_PROGRESS", updatedAt: new Date() });

        const inputDocIds: string[] = taskData.inputDocIds || [];
        if (inputDocIds.length === 0) {
            await taskRef.update({
                status: "DONE",
                rawResult: { message: "Brak rysunków do analizy." },
                processedByBrain: false,
                updatedAt: new Date()
            });
            isSuccess = true;
            return NextResponse.json({ message: "Brak dokumentów." });
        }

        const bucketName = process.env.STORAGE_BUCKET || "pesam-system-81165.firebasestorage.app";
        const bucket = adminStorage.bucket(bucketName);
        const parts: any[] = [];

        for (const docId of inputDocIds) {
            const docSnap = await adminDb.collection(`tenders/${tenderId}/documents`).doc(docId).get();
            if (!docSnap.exists) continue;

            const docData = docSnap.data()!;
            console.log(`[VISION 📐] Pobieram rysunek ze Storage: ${docData.storagePath}`);

            try {
                const fileRef = bucket.file(docData.storagePath);
                const [downloadedBuffer] = await fileRef.download();
                const safeArrayBuffer = new Uint8Array(downloadedBuffer).buffer;
                const base64Data = Buffer.from(safeArrayBuffer).toString("base64");

                parts.push({
                    inlineData: {
                        data: base64Data,
                        mimeType: docData.mimeType || "application/pdf"
                    }
                });
            } catch (err: any) {
                console.error(`[VISION 📐] Błąd pobierania rysunku:`, err);
                throw err;
            }
        }

        const prompt = `
Jesteś Inżynierem Projektantem, Architektem i Konstruktorem. 
Przeanalizuj załączone rysunki techniczne i schematy w oparciu o poniższą instrukcję od Mózgu:

${taskData.instruction}

Ważne zasady:
- Dokładnie odczytuj wymiary, rzędne, skale i opisy na rysunku.
- Zwróć wynik jako poprawny obiekt JSON, pasujący dokładnie do struktury zdefiniowanej przez Mózg w instrukcji.
- Nie dodawaj żadnego tekstu poza czystym JSON-em.
`;

        parts.unshift({ text: prompt });
        console.log(`[VISION 📐] Wysyłam ${parts.length - 1} rysunków do analizy (zabezpieczenie 429 aktywne)...`);

        const result = await callGeminiWithRetry(async () => {
            return await ai.models.generateContent({
                model: taskData.modelOverride || "gemini-2.5-flash",
                contents: parts, // format bezpośredniej tablicy Parts (brak błędu TS2353)
                config: {
                    temperature: 0.1,
                    responseMimeType: "application/json"
                }
            });
        });

        const rawResult = JSON.parse(result.text ?? "{}");
        const tokensUsed = result.usageMetadata?.totalTokenCount || 0;

        await taskRef.update({
            status: "DONE",
            rawResult: rawResult,
            processedByBrain: false,
            costTokens: tokensUsed,
            updatedAt: new Date()
        });

        const costPerThousand = (taskData.modelOverride === "gemini-2.5-pro") ? 0.002 : 0.000015;
        const costUSD = (tokensUsed / 1000) * costPerThousand;

        await adminDb.collection("tenders").doc(tenderId).update({
            "budgetGuard.currentCostUSD": FieldValue.increment(costUSD)
        });

        isSuccess = true;
        return NextResponse.json({ success: true });

    } catch (error: any) {
        console.error("[VISION 📐] ❌ Błąd krytyczny:", error);
        if (tenderId && taskId) {
            await adminDb.collection(`tenders/${tenderId}/tasks`).doc(taskId).update({
                status: "ERROR",
                rawResult: { error: error.message },
                processedByBrain: false,
                updatedAt: new Date()
            }).catch(() => { });
        }
        return NextResponse.json({ error: error.message }, { status: 500 });

    } finally {
        if (tenderId && taskId) {
            const localOrigin = `http://127.0.0.1:${process.env.PORT || "3000"}`;
            fetch(`${localOrigin}/api/kosztorysant/glowny-kosztorysant`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    tenderId,
                    trigger: isSuccess ? `TASK_COMPLETED_${taskId}` : `TASK_FAILED_${taskId}`
                })
            }).catch(() => { });
        }
    }
}