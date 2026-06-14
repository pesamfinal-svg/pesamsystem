import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { FieldValue } from "firebase-admin/firestore";
import { GoogleGenAI } from "@google/genai";
import { jsonrepair } from "jsonrepair";
import dns from "dns";
dns.setDefaultResultOrder("ipv4first");

export const dynamic = "force-dynamic";

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
            console.warn(`[NORM ADVISOR 📋] Limit 429. Czekam ${delay / 1000}s...`);
            await new Promise(r => setTimeout(r, delay));
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

        console.log(`[NORM ADVISOR 📋] Start. tenderId: ${tenderId}, taskId: ${taskId}`);

        if (!tenderId || !taskId) return NextResponse.json({ error: "Brak parametrów" }, { status: 400 });

        const taskRef = adminDb.collection(`tenders/${tenderId}/technolog_tasks`).doc(taskId);
        const taskDoc = await taskRef.get();
        if (!taskDoc.exists) throw new Error("Zadanie nie istnieje.");

        const taskData = taskDoc.data()!;
        if (taskData.status !== "PENDING") return NextResponse.json({ message: "Zadanie obsłużone." });

        await taskRef.update({ status: "IN_PROGRESS", updatedAt: new Date() });

        const knownFacts = taskData.inputFacts || {};
        let totalTokensUsed = 0;

        const normPrompt = `
Jesteś ekspert budowlanym i prawnym. Dobierz parametry techniczne z norm i ustaw dla poniższego kontekstu.

=== ZADANIE OD TECHNOLOGA ===
${taskData.instruction}

=== FAKTY WEJŚCIOWE ===
${JSON.stringify(knownFacts, null, 2)}

Użyj wyszukiwarki Google Search, aby znaleźć i uwiarygodnić:
1. Współczynniki przenikania ciepła U, wymagania PPOŻ lub BHP dla tego typu budynku wg WT2021.
2. Odpowiednie Polskie Normy (PN-EN).

Zwróć strukturę JSON z tablicą "normParameters":
- parameterName: "Nazwa dobranego parametru"
- derivedValue: "Wartość (np. U=0.20)"
- normReference: "Dokładny artykuł/norma prawna"
- confidence: 0-100
`;

        const result = await callGeminiWithRetry(() =>
            ai.models.generateContent({
                model: MODEL_FLASH,
                contents: normPrompt,
                config: {
                    tools: [{ googleSearch: {} }],
                    temperature: 0.1,
                    responseMimeType: "application/json"
                }
            })
        );

        totalTokensUsed += result.usageMetadata?.totalTokenCount || 0;

        let normParameters: any[] = [];
        try {
            const parsed = JSON.parse(jsonrepair(result.text ?? "{}"));
            normParameters = parsed.normParameters || [];
        } catch (e) {
            console.warn("[NORM ADVISOR 📋] Błąd strukturyzacji norm.");
        }

        await taskRef.update({
            status: "DONE",
            rawResult: {
                normParameters,
                summary: `Dobrano ${normParameters.length} szczegółowych parametrów normowych z baz internetowych.`
            },
            processedByTechnolog: false,
            costTokens: totalTokensUsed,
            updatedAt: new Date()
        });

        const costUSD = (totalTokensUsed / 1000) * 0.000015;
        await adminDb.collection("tenders").doc(tenderId).update({ "budgetGuard.currentCostUSD": FieldValue.increment(costUSD) });

        isSuccess = true;
        return NextResponse.json({ success: true, parametersCount: normParameters.length });

    } catch (error: any) {
        console.error("[NORM ADVISOR 📋] Błąd:", error);
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