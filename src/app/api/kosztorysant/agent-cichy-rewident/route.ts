import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { FieldValue } from "firebase-admin/firestore";
import { GoogleGenAI, Type } from "@google/genai";
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

async function callGeminiWithRetry(fn: () => Promise<any>, retries = 5, delay = 5000): Promise<any> {
    try {
        return await fn();
    } catch (error: any) {
        const errorText = error.toString() || "";
        const isRateLimit = errorText.includes("429") || errorText.includes("RESOURCE_EXHAUSTED");
        if (isRateLimit && retries > 0) {
            console.warn(`[SILENT AUDITOR 🕵️] Limit 429. Czekam ${delay / 1000}s...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            return callGeminiWithRetry(fn, retries - 1, delay * 2);
        }
        throw error;
    }
}

const AUDITOR_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        complianceIssues: {
            type: Type.ARRAY,
            description: "Zidentyfikowane braki prawne lub technologiczne w kosztorysie na podstawie WT2021, PPOŻ, Sanepid itp.",
            items: {
                type: Type.OBJECT,
                properties: {
                    issueCategory: { type: Type.STRING, description: "Kategoria problemu (np. PPOŻ, BHP, Konstrukcja, WT2021)" },
                    legalReference: { type: Type.STRING, description: "Podstawa prawna lub norma (np. konkretny paragraf)" },
                    missingTechnology: { type: Type.STRING, description: "Czego fizycznie brakuje w obiekcie (np. klapy dymowe, hydranty, balustrady)" },
                    impactDescription: { type: Type.STRING, description: "Uzasadnienie dlaczego ten element jest krytyczny prawnie" }
                },
                required: ["issueCategory", "legalReference", "missingTechnology", "impactDescription"]
            }
        },
        summary: { type: Type.STRING, description: "Krótkie podsumowanie audytu prawnego." }
    },
    required: ["complianceIssues", "summary"]
};

export async function POST(req: Request) {
    let tenderId: string | undefined;
    let taskId: string | undefined;
    let isSuccess = false;

    try {
        const body = await req.json();
        tenderId = body.tenderId;
        taskId = body.taskId;

        console.log(`[SILENT AUDITOR 🕵️] Start. tenderId: ${tenderId}, taskId: ${taskId}`);

        if (!tenderId || !taskId) return NextResponse.json({ error: "Brak danych" }, { status: 400 });

        const taskRef = adminDb.collection(`tenders/${tenderId}/tasks`).doc(taskId);
        const taskDoc = await taskRef.get();
        if (!taskDoc.exists) throw new Error("Zadanie nie istnieje.");

        const taskData = taskDoc.data()!;
        if (taskData.status !== "PENDING") return NextResponse.json({ message: "Task processed." });

        await taskRef.update({ status: "IN_PROGRESS", updatedAt: new Date() });

        const existingItems = taskData.inputFacts?.existingItems || [];
        const objectType = taskData.inputFacts?.objectType || "Obiekt budowlany";

        // KROK 1: Wyszukiwanie z Google Search (Surowy tekst)
        console.log("[SILENT AUDITOR 🕵️] KROK 1: Analiza przepisów z Google Search...");
        const searchPrompt = `
Analizujemy kosztorys dla obiektu typu: ${objectType}.
Obecnie w kosztorysie mamy m.in. następujące pozycje: 
${JSON.stringify(existingItems.slice(0, 50))}

Zadanie: ${taskData.instruction}

Użyj wyszukiwarki Google Search, aby sprawdzić aktualne, restrykcyjne przepisy budowlane w Polsce (Warunki Techniczne WT 2021, wymogi PPOŻ dla tej kategorii budynków, wymogi Sanepidu).
Zidentyfikuj, czy w dotychczasowym kosztorysie nie zapomniano o krytycznych, obowiązkowych elementach. 
Napisz techniczny raport z audytu.
`;

        const searchResult = await callGeminiWithRetry(async () => {
            return await ai.models.generateContent({
                model: MODEL_FLASH,
                contents: searchPrompt,
                config: {
                    tools: [{ googleSearch: {} }],
                    temperature: 0.1
                }
            });
        });

        const rawReport = searchResult.text ?? "";
        let totalTokensUsed = searchResult.usageMetadata?.totalTokenCount || 0;

        // KROK 2: Strukturyzacja na JSON (Bez Search)
        console.log("[SILENT AUDITOR 🕵️] KROK 2: Strukturyzacja wyników audytu na JSON...");
        const structurePrompt = `
Na podstawie poniższego raportu z audytu technicznego, wyodrębnij surowe fakty o brakach prawno-technologicznych (zgodnie ze schematem JSON), aby Mózg mógł podjąć na ich podstawie decyzję o rozszerzeniu kosztorysu.

Raport z audytu:
${rawReport}
`;

        const structureResult = await callGeminiWithRetry(async () => {
            return await ai.models.generateContent({
                model: MODEL_FLASH,
                contents: structurePrompt,
                config: {
                    temperature: 0.1,
                    responseMimeType: "application/json",
                    responseSchema: AUDITOR_SCHEMA as any
                }
            });
        });

        let parsedResult: any = {};
        try {
            parsedResult = JSON.parse(jsonrepair(structureResult.text ?? "{}"));
        } catch (e) {
            console.error("[SILENT AUDITOR 🕵️] Błąd naprawy JSON:", e);
        }
        totalTokensUsed += structureResult.usageMetadata?.totalTokenCount || 0;

        await taskRef.update({
            status: "DONE",
            rawResult: parsedResult,
            processedByBrain: false,
            costTokens: totalTokensUsed,
            updatedAt: new Date()
        });

        const costUSD = (totalTokensUsed / 1000) * 0.000015;
        await adminDb.collection("tenders").doc(tenderId).update({
            "budgetGuard.currentCostUSD": FieldValue.increment(costUSD)
        });

        isSuccess = true;
        console.log("[SILENT AUDITOR 🕵️] Sukces.");
        return NextResponse.json({ success: true });

    } catch (error: any) {
        console.error("[SILENT AUDITOR 🕵️] ❌ Błąd:", error);
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