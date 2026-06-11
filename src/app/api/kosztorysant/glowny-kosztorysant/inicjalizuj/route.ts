import { NextResponse } from "next/server";
import { adminDb, adminStorage } from "@/lib/firebase/admin";
import { GoogleGenAI, Type } from "@google/genai";

export const dynamic = "force-dynamic";

const MODEL_FLASH = "gemini-2.5-flash";

const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
    location: "global"
});

// Definicja schematu odpowiedzi klasyfikatora
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

// Pomocnicza funkcja realizująca Exponential Backoff dla błędów 429 (RESOURCE_EXHAUSTED)
async function callGeminiWithRetry(fn: () => Promise<any>, retries = 3, delay = 3000): Promise<any> {
    try {
        return await fn();
    } catch (error: any) {
        const errorText = error.toString() || "";
        const isRateLimit = errorText.includes("429") || errorText.includes("RESOURCE_EXHAUSTED");

        if (isRateLimit && retries > 0) {
            console.warn(`[FAZA 0 🚀] Wykryto limit 429/RESOURCE_EXHAUSTED. Chmura jest przeciążona. Czekam ${delay / 1000}s i próbuje ponownie... (Pozostało prób: ${retries})`);
            await new Promise(resolve => setTimeout(resolve, delay));
            return callGeminiWithRetry(fn, retries - 1, delay * 2); // Podwajamy czas oczekiwania
        }
        throw error;
    }
}

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const { tenderId } = body;

        console.log(`[FAZA 0 🚀] Start inicjalizacji i klasyfikacji dla przetargu: ${tenderId}`);

        if (!tenderId) {
            console.error("[FAZA 0 🚀] Błąd: Brak wymaganej zmiennej tenderId.");
            return NextResponse.json({ error: "Brak tenderId" }, { status: 400 });
        }

        const docsRef = adminDb.collection(`tenders/${tenderId}/documents`);
        const snapshot = await docsRef.where("status", "==", "UPLOADED").get();

        if (snapshot.empty) {
            console.log(`[FAZA 0 🚀] Brak nowych dokumentów (UPLOADED) do klasyfikacji.`);
            return NextResponse.json({ message: "Brak dokumentów do przetworzenia." });
        }

        console.log(`[FAZA 0 🚀] Znaleziono ${snapshot.size} dokumentów do sklasyfikowania.`);
        let totalTokensUsed = 0;

        const bucketName = process.env.STORAGE_BUCKET || "pesam-system-81165.firebasestorage.app";
        const bucket = adminStorage.bucket(bucketName);

        // Klasyfikator w pętli dla każdego dokumentu
        for (let i = 0; i < snapshot.docs.length; i++) {
            const docSnap = snapshot.docs[i];
            const docData = docSnap.data();

            // API pacing - jeśli to kolejny plik, czekamy chwilę, żeby nie bombardować chmury
            if (i > 0) {
                console.log("[FAZA 0 🚀] Odczekuję 3 sekundy (API Pacing) przed kolejnym dużym plikiem...");
                await new Promise(resolve => setTimeout(resolve, 3000));
            }

            console.log(`[FAZA 0 🚀] Rozpoczynam klasyfikację pliku: ${docData.fileName}`);

            try {
                const fileRef = bucket.file(docData.storagePath);
                const [downloadedBuffer] = await fileRef.download();
                console.log(`[FAZA 0 🚀] Pobrano ${downloadedBuffer.length} bajtów pliku.`);

                const safeArrayBuffer = new Uint8Array(downloadedBuffer).buffer;
                const base64Data = Buffer.from(safeArrayBuffer).toString("base64");

                const prompt = `
Jesteś Klasyfikatorem systemu kosztorysowego PESAM 3.0. 
Przeanalizuj pierwszą stronę lub widoczną treść tego dokumentu budowlanego. 
Zwróć JSON z odpowiednimi tagami i krótkim streszczeniem.
`;

                const imagePart = {
                    inlineData: {
                        data: base64Data,
                        mimeType: docData.mimeType || "application/pdf"
                    }
                };

                console.log(`[FAZA 0 🚀] Wywołuję Gemini dla ${docData.fileName} (z zabezpieczeniem przed limitami)...`);

                // Opakowujemy zapytanie do chmury w nasz system automatycznego ponawiania prób
                const result = await callGeminiWithRetry(async () => {
                    return await ai.models.generateContent({
                        model: MODEL_FLASH,
                        contents: [
                            {
                                role: "user",
                                parts: [
                                    { text: prompt },
                                    imagePart
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

                console.log(`[FAZA 0 🚀] Plik sklasyfikowany pomyślnie. Tagi: ${JSON.stringify(parsedResult.tags)}. Zużyto tokenów: ${tokensUsed}`);

                // Aktualizacja metadanych dokumentu w bazie
                await docSnap.ref.update({
                    tags: parsedResult.tags,
                    summary: parsedResult.summary,
                    status: "CLASSIFIED",
                    classifyModel: MODEL_FLASH,
                    updatedAt: new Date()
                });

            } catch (docError: any) {
                console.error(`[FAZA 0 🚀] ❌ Krytyczny błąd klasyfikacji pliku ${docData.fileName} po próbach ponowienia:`, docError);
                await docSnap.ref.update({
                    status: "ERROR_CLASSIFYING",
                    errorDetails: docError.message,
                    updatedAt: new Date()
                }).catch(() => { });
            }
        }

        // 3. Aktualizacja Bezpiecznika Budżetowego (Budget Guard)
        const estimatedCostUSD = (totalTokensUsed / 1000) * 0.000015;
        console.log(`[FAZA 0 🚀] Łączny koszt tokenów Flash: ${estimatedCostUSD.toFixed(6)} USD. Aktualizuję Budget Guard.`);

        const tenderRef = adminDb.collection("tenders").doc(tenderId);
        await adminDb.runTransaction(async (t) => {
            const tenderDoc = await t.get(tenderRef);
            if (tenderDoc.exists) {
                const currentBudget = tenderDoc.data()?.budgetGuard || { currentCostUSD: 0, maxBudgetUSD: 5.0, limitReached: false, iterationCount: 0, maxIterations: 50 };

                const newCost = currentBudget.currentCostUSD + estimatedCostUSD;
                const limitReached = newCost >= currentBudget.maxBudgetUSD;

                t.update(tenderRef, {
                    status: "ORCHESTRATING",
                    "budgetGuard.currentCostUSD": newCost,
                    "budgetGuard.limitReached": limitReached,
                    updatedAt: new Date()
                });
            }
        });

        // 4. Inicjalizacja Stanu Umysłu (Brain State)
        console.log("[FAZA 0 🚀] Inicjalizuję podstawowy stan pamięci Mózgu (brain/main)...");
        const brainRef = adminDb.collection(`tenders/${tenderId}/brain`).doc("main");
        await brainRef.set({
            phase: "PLANNING",
            currentGoal: "Analiza tagów dokumentów i zaplanowanie zadań dla agentów.",
            knownFacts: {},
            missingData: [],
            activeTaskIds: [],
            pendingDecisions: [],
            reasoningLog: ["Zakończono klasyfikację dokumentów. Rozpoczynam planowanie."],
            totalCostUSD: estimatedCostUSD
        }, { merge: true });

        // 5. Dynamiczne i asynchroniczne wybudzenie Głównego Orkiestratora (Mózgu)
        const localOrigin = `http://127.0.0.1:${process.env.PORT || "3000"}`;
        console.log(`[FAZA 0 🚀] Wybudzam Mózg przez loopback: ${localOrigin}/api/kosztorysant/glowny-kosztorysant`);

        fetch(`${localOrigin}/api/kosztorysant/glowny-kosztorysant`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tenderId, trigger: "CLASSIFICATION_COMPLETE" })
        }).catch(e => console.error("[FAZA 0 🚀] Błąd wybudzania Mózgu po klasyfikacji:", e));

        console.log("[FAZA 0 🚀] Inicjalizacja i klasyfikacja zakończona.");
        return NextResponse.json({
            success: true,
            message: "Faza 0 zakończona. Mózg został wybudzony.",
            tokensUsed: totalTokensUsed
        });

    } catch (error: any) {
        console.error("[FAZA 0 🚀] ❌ Błąd krytyczny Fazy 0:", error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}