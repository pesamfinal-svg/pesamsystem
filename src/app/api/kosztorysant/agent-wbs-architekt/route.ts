import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { FieldValue } from "firebase-admin/firestore";
import { GoogleGenAI } from "@google/genai";
import dns from "dns";
dns.setDefaultResultOrder("ipv4first");

export const dynamic = "force-dynamic";

const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
    location: "global"
});

async function callGeminiWithRetry(fn: () => Promise<any>, retries = 5, delay = 5000): Promise<any> {
    try {
        return await fn();
    } catch (error: any) {
        const errorText = error.toString() || "";
        const isRateLimit = errorText.includes("429") || errorText.includes("RESOURCE_EXHAUSTED");
        if (isRateLimit && retries > 0) {
            console.warn(`[VISION 📐] Limit 429. Odczekuję ${delay / 1000}s...`);
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

        console.log(`[VISION 📐] Start żądania. tenderId: ${tenderId}, taskId: ${taskId}`);

        if (!tenderId || !taskId) return NextResponse.json({ error: "Brak parametrów" }, { status: 400 });

        const taskRef = adminDb.collection(`tenders/${tenderId}/tasks`).doc(taskId);
        const taskDoc = await taskRef.get();
        if (!taskDoc.exists) throw new Error("Zadanie nie istnieje.");

        const taskData = taskDoc.data()!;
        if (taskData.status !== "PENDING") return NextResponse.json({ message: "Task already processed." });

        await taskRef.update({ status: "IN_PROGRESS", updatedAt: new Date() });

        const inputDocIds: string[] = taskData.inputDocIds || [];
        if (inputDocIds.length === 0) {
            await taskRef.update({ status: "DONE", rawResult: { message: "Brak rysunków." }, processedByBrain: false, updatedAt: new Date() });
            isSuccess = true;
            return NextResponse.json({ message: "Brak plików." });
        }

        const bucketName = process.env.STORAGE_BUCKET || "pesam-system-81165.firebasestorage.app";
        const parts: any[] = [];

        // Generujemy bezpośrednie linki GCS
        for (const docId of inputDocIds) {
            const docSnap = await adminDb.collection(`tenders/${tenderId}/documents`).doc(docId).get();
            if (!docSnap.exists) continue;

            const docData = docSnap.data()!;
            const fileUri = `gs://${bucketName}/${docData.storagePath}`;
            console.log(`[VISION 📐] Referencja GCS dla rysunku: ${fileUri}`);

            parts.push({
                fileData: {
                    fileUri: fileUri,
                    mimeType: docData.mimeType || "application/pdf"
                }
            });
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
        console.log(`[VISION 📐] Wysyłam zapytanie referencyjne GCS do Gemini...`);

        const result = await callGeminiWithRetry(async () => {
            return await ai.models.generateContent({
                model: taskData.modelOverride || "gemini-2.5-flash",
                contents: parts,
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
        console.log("[VISION 📐] Sukces.");
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
            const localOrigin = `http://localhost:${process.env.PORT || "3000"}`;
            fetch(`${localOrigin}/api/kosztorysant/glowny-kosztorysant`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ tenderId, trigger: isSuccess ? `TASK_COMPLETED_${taskId}` : `TASK_FAILED_${taskId}` })
            }).catch(() => { });
        }
    }
}