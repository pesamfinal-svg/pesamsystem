import { NextResponse } from "next/server";
import { adminDb, adminStorage } from "@/lib/firebase/admin";
import { GoogleGenAI, Type } from "@google/genai";
import dns from "dns";
dns.setDefaultResultOrder("ipv4first");

export const dynamic = "force-dynamic";

const MODEL_FLASH = "gemini-2.5-flash";

const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
    location: "global"
});

const CLASSIFIER_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        tags: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: "Tagi dokumentu, np. [SWZ], [RYSUNEK, ARCHITEKTURA], [PRZEDMIAR, EXCEL], [UMOWA]"
        },
        summary: {
            type: Type.STRING,
            description: "Maksymalnie 2-zdaniowe streszczenie zawartości pliku."
        }
    },
    required: ["tags", "summary"]
};

async function callGeminiWithRetry(fn: () => Promise<any>, retries = 5, delay = 5000): Promise<any> {
    try {
        return await fn();
    } catch (error: any) {
        const errorText = error.toString() || "";
        const isRateLimit = errorText.includes("429") || errorText.includes("RESOURCE_EXHAUSTED");
        if (isRateLimit && retries > 0) {
            console.warn(`[FAZA 0 🚀] Limit 429. Odczekuję ${delay / 1000}s...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            return callGeminiWithRetry(fn, retries - 1, delay * 2);
        }
        throw error;
    }
}

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const { tenderId } = body;

        console.log(`[FAZA 0 🚀] Start inicjalizacji dla przetargu: ${tenderId}`);

        if (!tenderId) return NextResponse.json({ error: "Brak tenderId" }, { status: 400 });

        const docsRef = adminDb.collection(`tenders/${tenderId}/documents`);
        const snapshot = await docsRef.where("status", "==", "UPLOADED").get();

        if (snapshot.empty) return NextResponse.json({ message: "Brak dokumentów." });

        console.log(`[FAZA 0 🚀] Skanuję ${snapshot.size} dokumentów...`);
        let totalTokensUsed = 0;
        const bucketName = process.env.STORAGE_BUCKET || "pesam-system-81165.firebasestorage.app";

        for (let i = 0; i < snapshot.docs.length; i++) {
            const docSnap = snapshot.docs[i];
            const docData = docSnap.data();

            if (i > 0) {
                console.log("[FAZA 0 🚀] API Pacing: Czekam 3 sekundy...");
                await new Promise(resolve => setTimeout(resolve, 3000));
            }

            console.log(`[FAZA 0 🚀] Klasyfikuję: ${docData.fileName}`);

            try {
                const fileUri = `gs://${bucketName}/${docData.storagePath}`;
                console.log(`[FAZA 0 🚀] Generuję ścieżkę GCS: ${fileUri}`);

                const prompt = `
Jesteś Klasyfikatorem systemu kosztorysowego PESAM 3.0. 
Przeanalizuj pierwszą stronę tego dokumentu budowlanego. 
Zwróć JSON z odpowiednimi tagami i krótkim streszczeniem.
`;

                const result = await callGeminiWithRetry(async () => {
                    return await ai.models.generateContent({
                        model: MODEL_FLASH,
                        contents: [
                            {
                                role: "user",
                                parts: [
                                    { text: prompt },
                                    {
                                        fileData: {
                                            fileUri: fileUri,
                                            mimeType: docData.mimeType || "application/pdf"
                                        }
                                    }
                                ]
                            }
                        ],
                        config: {
                            temperature: 0.1,
                            responseMimeType: "application/json",
                            responseSchema: CLASSIFIER_SCHEMA as any
                        }
                    });
                });

                const responseText = result.text ?? "{}";
                const parsedResult = JSON.parse(responseText);
                const tokensUsed = result.usageMetadata?.totalTokenCount || 0;
                totalTokensUsed += tokensUsed;

                await docSnap.ref.update({
                    tags: parsedResult.tags,
                    summary: parsedResult.summary,
                    status: "CLASSIFIED",
                    classifyModel: MODEL_FLASH,
                    updatedAt: new Date()
                });

                console.log(`[FAZA 0 🚀] Sukces dla ${docData.fileName}.`);

            } catch (docError: any) {
                console.error(`[FAZA 0 🚀] Błąd:`, docError);
                await docSnap.ref.update({ status: "ERROR_CLASSIFYING", errorDetails: docError.message, updatedAt: new Date() }).catch(() => { });
            }
        }

        // Zapis do bezpiecznika i budzenie mózgu (bez zmian)
        const estimatedCostUSD = (totalTokensUsed / 1000) * 0.000015;
        const tenderRef = adminDb.collection("tenders").doc(tenderId);
        await adminDb.runTransaction(async (t) => {
            const tenderDoc = await t.get(tenderRef);
            if (tenderDoc.exists) {
                const currentBudget = tenderDoc.data()?.budgetGuard || { currentCostUSD: 0, maxBudgetUSD: 5.0, limitReached: false, iterationCount: 0, maxIterations: 50 };
                t.update(tenderRef, {
                    status: "ORCHESTRATING",
                    "budgetGuard.currentCostUSD": currentBudget.currentCostUSD + estimatedCostUSD,
                    updatedAt: new Date()
                });
            }
        });

        const brainRef = adminDb.collection(`tenders/${tenderId}/brain`).doc("main");
        await brainRef.set({
            phase: "PLANNING",
            currentGoal: "Analiza tagów i planowanie.",
            knownFacts: {},
            missingData: [],
            activeTaskIds: [],
            pendingDecisions: [],
            reasoningLog: ["Inicjalizacja."],
            totalCostUSD: estimatedCostUSD
        }, { merge: true });

        const localOrigin = `http://localhost:${process.env.PORT || "3000"}`;
        fetch(`${localOrigin}/api/kosztorysant/glowny-kosztorysant`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tenderId, trigger: "CLASSIFICATION_COMPLETE" })
        }).catch(() => { });

        return NextResponse.json({ success: true, tokensUsed: totalTokensUsed });

    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}