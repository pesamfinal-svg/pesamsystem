import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { FieldValue } from "firebase-admin/firestore";
import { GoogleGenAI } from "@google/genai";
import dns from "dns";
dns.setDefaultResultOrder("ipv4first");

export const dynamic = "force-dynamic";
export const maxDuration = 300; 

// Wymuszamy najnowszy, szybki model Flash 2.5
const MODEL_FLASH = "gemini-2.5-flash";

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
            await new Promise(resolve => setTimeout(resolve, delay + Math.random() * 2000));
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

        for (const docId of inputDocIds) {
            const docSnap = await adminDb.collection(`tenders/${tenderId}/documents`).doc(docId).get();
            if (!docSnap.exists) continue;

            const docData = docSnap.data()!;
            
            // 🟢 INTELIGENTNY ROUTING PLIKU DLA WIZJI:
            // Jeśli Faza 0 wycięła z tego dokumentu rysunki do osobnego pliku, Agent Vision
            // pobiera ten wycięty plik (_drawings.pdf). W przeciwnym wypadku bierze oryginalny PDF.
            // Nigdy nie próbuje czytać pliku tekstowego .md!
            const storagePath = docData.hasSeparatedDrawings 
                ? docData.drawingsStoragePath 
                : (docData.originalStoragePath || docData.storagePath);

            const fileUri = `gs://${bucketName}/${storagePath}`;
            console.log(`[VISION 📐] Kieruję analizę wizyjną na plik PDF: ${storagePath}`);

            parts.push({
                fileData: {
                    fileUri: fileUri,
                    mimeType: "application/pdf" // Zawsze PDF dla silnika wizyjnego
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
        console.log(`[VISION 📐] Wysyłam zapytanie do Gemini...`);

        const result = await callGeminiWithRetry(async () => {
            return await ai.models.generateContent({
                model: MODEL_FLASH,
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

        const costUSD = (tokensUsed / 1000) * 0.000015; // Tani koszt modelu Flash
        await adminDb.collection("tenders").doc(tenderId).update({
            "budgetGuard.currentCostUSD": FieldValue.increment(costUSD)
        });

        isSuccess = true;
        console.log("[VISION 📐] Sukces analizy wizyjnej rysunków.");
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