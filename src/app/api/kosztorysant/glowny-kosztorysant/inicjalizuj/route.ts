// ============================================================
// PESAM 3.0 – Inicjalizator Zadań (Faza 0: Klasyfikacja i Zapłon Roju)
// POST /api/kosztorysant/glowny-kosztorysant/inicjalizuj
// ============================================================

import { NextResponse } from "next/server";
import { adminDb, adminStorage } from "@/lib/firebase/admin";
import { GoogleGenAI, Type } from "@google/genai";

export const dynamic = "force-dynamic";

// Standard 4: Brak zewnętrznych zależności undici (region europe-west4 działa natywnie)
const MODEL_FLASH = "gemini-2.5-flash";

// Inicjalizacja klienta Google GenAI (Standard 3: lokalizacja global i Vertex AI)
const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
    location: "global"
});

// Definicja schematu odpowiedzi klasyfikatora (Zgodna z nowym SDK)
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

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const { tenderId } = body;

        if (!tenderId) {
            return NextResponse.json({ error: "Brak tenderId" }, { status: 400 });
        }

        console.log(`[PESAM 3.0] 🚀 Start Fazy 0 (Inicjalizacja) dla przetargu: ${tenderId}`);

        // 1. Pobranie dokumentów o statusie UPLOADED
        const docsRef = adminDb.collection(`tenders/${tenderId}/documents`);
        const snapshot = await docsRef.where("status", "==", "UPLOADED").get();

        if (snapshot.empty) {
            console.log(`[PESAM 3.0] Brak nowych dokumentów do klasyfikacji.`);
            return NextResponse.json({ message: "Brak dokumentów do przetworzenia." });
        }

        let totalTokensUsed = 0;

        // 2. Przetwarzanie każdego dokumentu (Klasyfikator)
        for (const docSnap of snapshot.docs) {
            const docData = docSnap.data();
            console.log(`[PESAM 3.0] 📄 Klasyfikacja pliku: ${docData.fileName}`);

            try {
                // Standard 3: Bezpieczne pobieranie ze Storage (jawny bucket i brak publicznych URL)
                const bucketName = process.env.STORAGE_BUCKET || "pesam-system-81165.firebasestorage.app";
                const bucket = adminStorage.bucket(bucketName);
                const fileRef = bucket.file(docData.storagePath);

                const [downloadedBuffer] = await fileRef.download();

                // Standard 3: Bezpieczna konwersja bufora w środowisku Next.js
                const safeArrayBuffer = new Uint8Array(downloadedBuffer).buffer;
                const base64Data = Buffer.from(safeArrayBuffer).toString("base64");

                // Przygotowanie wsadu dla Gemini
                const prompt = `Jesteś Klasyfikatorem systemu PESAM 3.0. Przeanalizuj pierwszą stronę lub widoczną treść tego dokumentu budowlanego. Zwróć JSON z odpowiednimi tagami i krótkim streszczeniem.`;

                const imagePart = {
                    inlineData: {
                        data: base64Data,
                        mimeType: docData.mimeType || "application/pdf"
                    }
                };

                // Wywołanie modelu z poprawną strukturą nowej biblioteki
                const result = await ai.models.generateContent({
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

                const responseText = result.text ?? "{}";
                const parsedResult = JSON.parse(responseText);

                // Zliczanie tokenów do Budget Guard
                totalTokensUsed += result.usageMetadata?.totalTokenCount || 0;

                // Aktualizacja dokumentu w bazie (Standard 1: Ścisła spójność schematu)
                await docSnap.ref.update({
                    tags: parsedResult.tags,
                    summary: parsedResult.summary,
                    status: "CLASSIFIED",
                    classifyModel: MODEL_FLASH,
                    updatedAt: new Date()
                });

                console.log(`[PESAM 3.0] ✅ Sklasyfikowano: ${docData.fileName} -> Tagi: ${parsedResult.tags.join(", ")}`);

            } catch (docError) {
                console.error(`[PESAM 3.0] ❌ Błąd klasyfikacji pliku ${docData.fileName}:`, docError);
                await docSnap.ref.update({ status: "ERROR_CLASSIFYING" });
            }
        }

        // 3. Aktualizacja Bezpiecznika Budżetowego (Budget Guard)
        // Przyjmujemy orientacyjny koszt dla Flash: $0.000015 / 1k tokenów
        const estimatedCostUSD = (totalTokensUsed / 1000) * 0.000015;

        const tenderRef = adminDb.collection("tenders").doc(tenderId);
        await adminDb.runTransaction(async (t) => {
            const tenderDoc = await t.get(tenderRef);
            if (tenderDoc.exists) {
                const currentBudget = tenderDoc.data()?.budgetGuard || { currentCostUSD: 0, maxBudgetUSD: 5.0, limitReached: false, iterationCount: 0, maxIterations: 50 };

                const newCost = currentBudget.currentCostUSD + estimatedCostUSD;
                const limitReached = newCost >= currentBudget.maxBudgetUSD;

                t.update(tenderRef, {
                    status: "ORCHESTRATING", // Przekazanie pałeczki do Mózgu
                    "budgetGuard.currentCostUSD": newCost,
                    "budgetGuard.limitReached": limitReached
                });
            }
        });

        // 4. Inicjalizacja Stanu Umysłu (Brain State)
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
        const origin = new URL(req.url).origin;
        fetch(`${origin}/api/kosztorysant/glowny-kosztorysant`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tenderId, trigger: "CLASSIFICATION_COMPLETE" })
        }).catch(e => console.error("[PESAM 3.0] Błąd wybudzania Mózgu:", e));

        return NextResponse.json({
            success: true,
            message: "Faza 0 zakończona. Mózg został wybudzony.",
            tokensUsed: totalTokensUsed
        });

    } catch (error: any) {
        console.error("[PESAM 3.0] ❌ Błąd krytyczny Fazy 0:", error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}