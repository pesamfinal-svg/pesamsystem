import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { FieldValue } from "firebase-admin/firestore";
import { GoogleGenAI } from "@google/genai";
import { jsonrepair } from "jsonrepair";
import dns from "dns";
dns.setDefaultResultOrder("ipv4first");

export const dynamic = "force-dynamic";
export const maxDuration = 300; // Podnosimy timeout ze względu na duże PDFy

const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
    location: "global"
});

const MODEL_FLASH = "gemini-2.5-flash";

async function callGeminiWithRetry(fn: () => Promise<any>, retries = 5, delay = 4000): Promise<any> {
    try {
        return await fn();
    } catch (error: any) {
        const isRateLimit = error.toString().includes("429") || error.toString().includes("RESOURCE_EXHAUSTED");
        if (isRateLimit && retries > 0) {
            console.warn(`[MATERIAL DETECTIVE 🔍] Limit 429. Czekam ${delay / 1000}s...`);
            await new Promise(r => setTimeout(r, delay + Math.random() * 2000));
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

        console.log(`[MATERIAL DETECTIVE 🔍] Start. tenderId: ${tenderId}, taskId: ${taskId}`);

        if (!tenderId || !taskId) return NextResponse.json({ error: "Brak parametrów" }, { status: 400 });

        const taskRef = adminDb.collection(`tenders/${tenderId}/technolog_tasks`).doc(taskId);
        const taskDoc = await taskRef.get();
        if (!taskDoc.exists) throw new Error("Zadanie nie istnieje.");

        const taskData = taskDoc.data()!;
        if (taskData.status !== "PENDING") return NextResponse.json({ message: "Zadanie obsłużone." });

        await taskRef.update({ status: "IN_PROGRESS", updatedAt: new Date() });

        const inputDocIds: string[] = taskData.inputDocIds || [];
        const bucketName = process.env.STORAGE_BUCKET || "pesam-system-81165.firebasestorage.app";
        let totalTokensUsed = 0;
        const allFindings: any[] = [];

        for (const docId of inputDocIds) {
            const docSnap = await adminDb.collection(`tenders/${tenderId}/documents`).doc(docId).get();
            if (!docSnap.exists) continue;

            const docData = docSnap.data()!;
            const fileUri = `gs://${bucketName}/${docData.storagePath}`;

            console.log(`[MATERIAL DETECTIVE 🔍] Skanuję: "${docData.fileName}"`);

            const scanPrompt = `
Jesteś Detektywem Materiałowym w systemie PESAM 3.0.
Wyszukaj wszystkie wzmianki o technologiach i klasach materiałów budowlanych.

=== POLECENIE OD TECHNOLOGA ===
${taskData.instruction}

Zwróć wyniki w strukturze JSON zawierającej klucz "materialFindings", który będzie listą zdefiniowaną jak poniżej:
[
  {
    "material": "Nazwa materiału (np. beton, pustak)",
    "specification": "Dokładna klasa/parametr (np. C25/30, Ytong 24cm)",
    "context": "Gdzie ma być użyty (np. ściany konstrukcyjne)",
    "confidence": 90
  }
]

UWAGA: Zwróć wyłącznie prawidłowy format JSON (bez bloków markdown np. \`\`\`json).
`;

            const result = await callGeminiWithRetry(() =>
                ai.models.generateContent({
                    model: MODEL_FLASH,
                    contents: [
                        {
                            role: "user",
                            parts: [
                                { text: scanPrompt },
                                { fileData: { fileUri, mimeType: docData.mimeType || "application/pdf" } }
                            ]
                        }
                    ],
                    config: {
                        temperature: 0.1
                        // USUNIĘTO: responseMimeType dla stabilności z dużymi plikami PDF
                    }
                })
            );

            totalTokensUsed += result.usageMetadata?.totalTokenCount || 0;

            try {
                let rawText = result.text ?? "{}";
                rawText = rawText.replace(/```json/gi, "").replace(/```/g, "").trim();
                const parsed = JSON.parse(jsonrepair(rawText));

                const findings = parsed.materialFindings || [];
                allFindings.push(...findings.map((f: any) => ({ ...f, sourceDoc: docData.fileName })));
                console.log(`[MATERIAL DETECTIVE 🔍] Pomyślnie zebrano ${findings.length} parametrów z pliku.`);
            } catch (e) {
                console.warn(`[MATERIAL DETECTIVE 🔍] Błąd parsowania wyjścia z pliku ${docData.fileName}`);
            }

            // Pauza między plikami, żeby nie zamęczyć limitu
            await new Promise(r => setTimeout(r, 2000));
        }

        await taskRef.update({
            status: "DONE",
            rawResult: {
                materialFindings: allFindings,
                summary: `Wyciągnięto ${allFindings.length} cech technologicznych materiałów z dokumentacji.`
            },
            processedByTechnolog: false,
            costTokens: totalTokensUsed,
            updatedAt: new Date()
        });

        const costUSD = (totalTokensUsed / 1000) * 0.000015;
        await adminDb.collection("tenders").doc(tenderId).update({ "budgetGuard.currentCostUSD": FieldValue.increment(costUSD) });

        isSuccess = true;
        return NextResponse.json({ success: true, findingsCount: allFindings.length });

    } catch (error: any) {
        console.error("[MATERIAL DETECTIVE 🔍] ❌ Błąd krytyczny:", error);
        if (tenderId && taskId) {
            await adminDb.collection(`tenders/${tenderId}/technolog_tasks`).doc(taskId).update({
                status: "ERROR", rawResult: { error: error.message }, processedByTechnolog: false, updatedAt: new Date()
            }).catch(() => { });
        }
        return NextResponse.json({ error: error.message }, { status: 500 });
    } finally {
        if (tenderId && taskId) {
            const localOrigin = `http://localhost:${process.env.PORT || "3000"}`;
            fetch(`${localOrigin}/api/technolog/glowny-technolog`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ tenderId, trigger: isSuccess ? `TASK_COMPLETED_${taskId}` : `TASK_FAILED_${taskId}` })
            }).catch(() => { });
        }
    }
}