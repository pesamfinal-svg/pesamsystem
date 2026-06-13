import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { GoogleGenAI, Type } from "@google/genai";
import { jsonrepair } from "jsonrepair";
import dns from "dns";
dns.setDefaultResultOrder("ipv4first");

export const dynamic = "force-dynamic";

// Używamy nowego, szybkiego i ultra-taniego modelu Flash-Lite dla klasyfikacji sensorycznej
const MODEL_LITE = "gemini-2.5-flash-lite";

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
            description: "Tagi dokumentu, np. [SWZ], [UMOWA], [SPECYFIKACJA], [OPIS_TECHNICZNY]"
        },
        summary: {
            type: Type.STRING,
            description: "Maksymalnie 2-zdaniowe streszczenie zawartości pliku."
        },
        detailedElement: {
            type: Type.STRING,
            description: "Konkretny, szczegółowy element budowlany, którego dotyczy rysunek/dokument wyciągnięty z tabelki rysunkowej (np. 'płyta fundamentowa', 'strop nad parterem', 'zbrojenie słupów', 'elewacja południowa', 'szczegół dachu', 'winda'). Wpisz 'NIE_DOTYCZY' jeśli to ogólny dokument tekstowy jak SWZ."
        },
        containsTablesWithDimensions: {
            type: Type.BOOLEAN,
            description: "Czy dokument zawiera tabele z przedmiarami, obmiarami lub wymiarami fizycznymi obiektu."
        },
        containsDrawings: {
            type: Type.BOOLEAN,
            description: "Czy dokument zawiera rysunki techniczne, rzuty, przekroje, schematy lub inną dokumentację graficzną."
        }
    },
    required: ["tags", "summary", "detailedElement", "containsTablesWithDimensions", "containsDrawings"]
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

        console.log(`[FAZA 0 🚀] Start inicjalizacji sensorycznej dla: ${tenderId}`);

        if (!tenderId) return NextResponse.json({ error: "Brak tenderId" }, { status: 400 });

        const docsRef = adminDb.collection(`tenders/${tenderId}/documents`);
        const snapshot = await docsRef.where("status", "==", "UPLOADED").get();

        if (snapshot.empty) return NextResponse.json({ message: "Brak dokumentów do klasyfikacji." });

        console.log(`[FAZA 0 🚀] Skanuję ${snapshot.size} dokumentów przy użyciu ${MODEL_LITE}...`);
        let totalTokensUsed = 0;
        const bucketName = process.env.STORAGE_BUCKET || "pesam-system-81165.firebasestorage.app";

        const BATCH_SIZE = 6;
        for (let i = 0; i < snapshot.docs.length; i += BATCH_SIZE) {
            const batch = snapshot.docs.slice(i, i + BATCH_SIZE);
            console.log(`[FAZA 0 🚀] Skanuję paczkę plików ${i + 1} do ${Math.min(i + BATCH_SIZE, snapshot.docs.length)}...`);

            await Promise.all(batch.map(async (docSnap) => {
                const docData = docSnap.data();
                console.log(`[FAZA 0 🚀] Analizuję strukturę: ${docData.fileName}`);

                try {
                    const fileUri = `gs://${bucketName}/${docData.storagePath}`;
                    const prompt = `
Jesteś Klasyfikatorem Sensorycznym systemu kosztorysowego PESAM 3.0. 
Przeanalizuj pierwszą stronę lub spis treści tego dokumentu budowlanego. 
Zwróć JSON z odpowiednimi tagami, streszczeniem oraz precyzyjnie określ, czy dokument zawiera tabele wymiarowe lub rysunki techniczne.
`;

                    const result = await callGeminiWithRetry(async () => {
                        return await ai.models.generateContent({
                            model: MODEL_LITE,
                            contents: [{
                                role: "user",
                                parts: [
                                    { text: prompt },
                                    { fileData: { fileUri: fileUri, mimeType: docData.mimeType || "application/pdf" } }
                                ]
                            }],
                            config: {
                                temperature: 0.1,
                                responseMimeType: "application/json",
                                responseSchema: CLASSIFIER_SCHEMA as any
                            }
                        });
                    });

                    let parsedResult: any = {};
                    try {
                        parsedResult = JSON.parse(jsonrepair(result.text ?? "{}"));
                    } catch (e) {
                        console.error(`[FAZA 0 🚀] Błąd parsowania JSON dla ${docData.fileName}`);
                    }

                    const tokensUsed = result.usageMetadata?.totalTokenCount || 0;
                    totalTokensUsed += tokensUsed;

                    await docSnap.ref.update({
                        tags: parsedResult.tags || [],
                        summary: parsedResult.summary || "(brak)",
                        detailedElement: parsedResult.detailedElement || "NIE_DOTYCZY",
                        containsTablesWithDimensions: parsedResult.containsTablesWithDimensions || false,
                        containsDrawings: parsedResult.containsDrawings || false,
                        status: "CLASSIFIED",
                        classifyModel: MODEL_LITE,
                        updatedAt: new Date()
                    });

                    console.log(`[FAZA 0 🚀] Sukces dla ${docData.fileName}. Tabele: ${parsedResult.containsTablesWithDimensions}, Rysunki: ${parsedResult.containsDrawings}`);

                } catch (docError: any) {
                    console.error(`[FAZA 0 🚀] Błąd klasyfikacji dla ${docData.fileName}:`, docError);
                    await docSnap.ref.update({ status: "ERROR_CLASSIFYING", errorDetails: docError.message, updatedAt: new Date() }).catch(() => { });
                }
            }));

            // Przerwa tylko między paczkami, a nie pojedynczymi plikami
            if (i + BATCH_SIZE < snapshot.docs.length) {
                await new Promise(r => setTimeout(r, 2000));
            }
        }

        // Koszt tokenów dla Flash-Lite jest drastycznie niższy (około $0.000075 za 1k input tokenów)
        const estimatedCostUSD = (totalTokensUsed / 1000) * 0.000075;
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
            currentGoal: "Analiza struktury dokumentów i planowanie podziału prac.",
            knownFacts: {},
            missingData: [],
            activeTaskIds: [],
            pendingDecisions: [],
            reasoningLog: ["Inicjalizacja sensoryczna zakończona pomyślnie."],
            totalCostUSD: estimatedCostUSD
        }, { merge: true });

        const localOrigin = `http://localhost:${process.env.PORT || "3000"}`;
        fetch(`${localOrigin}/api/kosztorysant/glowny-kosztorysant`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tenderId, trigger: "CLASSIFICATION_COMPLETE" })
        }).catch(() => { });

        return NextResponse.json({ success: true, tokensUsed: totalTokensUsed, modelUsed: MODEL_LITE });

    } catch (error: any) {
        console.error("[FAZA 0 🚀] Błąd krytyczny inicjalizacji:", error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}