import { NextResponse } from "next/server";
import { adminDb, adminStorage } from "@/lib/firebase/admin";
import { GoogleGenAI, Type } from "@google/genai";
import { jsonrepair } from "jsonrepair";
import dns from "dns";
dns.setDefaultResultOrder("ipv4first");

export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 minut - bezpieczny czas na pętlę konwersji dużych plików

const MODEL_LITE = "gemini-2.5-flash-lite";
const MODEL_CONVERTER = "gemini-2.5-flash";

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
            description: "Tagi dokumentu, np. [SWZ], [UMOWA], [SPECYFIKACJA]"
        },
        summary: {
            type: Type.STRING,
            description: "Maksymalnie 2-zdaniowe streszczenie zawartości pliku."
        },
        detailedElement: {
            type: Type.STRING,
            description: "Konkretny element budowlany, np. 'płyta fundamentowa'. Wpisz 'NIE_DOTYCZY' jeśli to dokument ogólny jak SWZ."
        },
        containsTablesWithDimensions: {
            type: Type.BOOLEAN,
            description: "Czy dokument zawiera tabele z przedmiarami, obmiarami lub wymiarami."
        },
        containsDrawings: {
            type: Type.BOOLEAN,
            description: "Czy dokument zawiera rysunki techniczne, rzuty czy schematy graficzne."
        },
        pageCount: {
            type: Type.NUMBER,
            description: "Dokładna liczba stron w tym dokumencie PDF."
        }
    },
    required: ["tags", "summary", "detailedElement", "containsTablesWithDimensions", "containsDrawings", "pageCount"]
};

async function callGeminiWithRetry(fn: () => Promise<any>, retries = 5, delay = 5000): Promise<any> {
    try {
        return await fn();
    } catch (error: any) {
        const errorText = error.toString() || "";
        const isRateLimit = errorText.includes("429") || errorText.includes("RESOURCE_EXHAUSTED");
        if (isRateLimit && retries > 0) {
            console.warn(`[FAZA 0 🚀] Limit 429. Odczekuję ${delay / 1000}s... (Pozostało prób: ${retries})`);
            await new Promise(resolve => setTimeout(resolve, delay));
            return callGeminiWithRetry(fn, retries - 1, delay * 2);
        }
        throw error;
    }
}

/**
 * METODA DZIEL I ŁĄCZ (Chunk & Join)
 * Konwertuje PDF na Markdown dzieląc go na przedziały po 10 stron,
 * aby ominąć limity tokenów wyjściowych (Output Limit) i zapobiec ucięciu tekstu.
 */
async function convertPdfToMarkdownInShadow(
    docSnap: FirebaseFirestore.QueryDocumentSnapshot,
    bucketName: string,
    pageCount: number
): Promise<number> {
    const docData = docSnap.data();
    const originalPath = docData.storagePath as string;
    const mdPath = `${originalPath}.md`;
    const fileUri = `gs://${bucketName}/${originalPath}`;

    const CHUNK_SIZE = 10;
    const markdownChunks: string[] = [];
    let totalTokensUsed = 0;

    console.log(`[FAZA 0.5 🏗️] Rozpoczynam konwersję 'Dziel i Łącz' dla: ${docData.fileName} (${pageCount} str.)`);

    for (let startPage = 1; startPage <= pageCount; startPage += CHUNK_SIZE) {
        const endPage = Math.min(startPage + CHUNK_SIZE - 1, pageCount);
        console.log(`[FAZA 0.5 🏗️] Przetwarzam przedział stron: ${startPage} - ${endPage}...`);

        const converterPrompt = `
Jesteś precyzyjnym konwerterem dokumentów budowlanych.
Z załączonego dokumentu PDF przeanalizuj i przepisz na format Markdown TYLKO STRONY OD ${startPage} DO ${endPage} (włącznie).
Zasady:
- Skup się wyłącznie na stronach od ${startPage} do ${endPage}. Ignoruj resztę dokumentu.
- Zachowaj tabele jako tabele Markdown (| kolumna | kolumna |)
- Zachowaj hierarchię nagłówków (#, ##, ###)
- Zachowaj wszystkie wartości liczbowe, jednostki i opisy bez skróceń.
- Odpowiedz TYLKO treścią Markdown dla tego przedziału stron, bez komentarzy i wstępów.
`;

        const result = await callGeminiWithRetry(async () => {
            return await ai.models.generateContent({
                model: MODEL_CONVERTER,
                contents: [{
                    role: "user",
                    parts: [
                        { text: converterPrompt },
                        { fileData: { fileUri, mimeType: "application/pdf" } }
                    ]
                }],
                config: { temperature: 0.1 }
            });
        });

        totalTokensUsed += result.usageMetadata?.totalTokenCount || 0;
        let chunkText = result.text ?? "";
        chunkText = chunkText.replace(/```markdown/gi, "").replace(/```/g, "").trim();

        if (chunkText.length > 5) {
            markdownChunks.push(`<!-- STRONY ${startPage}-${endPage} -->\n${chunkText}`);
        }

        // Mała pauza (pacing) między chunkami tego samego pliku, chroniąca przed 429
        if (startPage + CHUNK_SIZE <= pageCount) {
            await new Promise(r => setTimeout(r, 2000));
        }
    }

    const compiledMarkdown = markdownChunks.join("\n\n---\n\n");

    if (!compiledMarkdown.trim() || compiledMarkdown.length < 50) {
        throw new Error("Błąd konwersji — pusty plik wynikowy.");
    }

    // Zapisujemy połączony, pełny plik Markdown do chmury Storage
    const bucket = adminStorage.bucket(bucketName);
    await bucket.file(mdPath).save(compiledMarkdown, {
        contentType: "text/markdown; charset=utf-8",
        metadata: { cacheControl: "no-cache" }
    });

    // Podmieniamy ścieżkę w bazie danych — pełna przezroczystość!
    await docSnap.ref.update({
        storagePath: mdPath,
        mimeType: "text/markdown",
        isMarkdownCache: true,
        originalStoragePath: originalPath,
    });

    console.log(`[FAZA 0.5 🏗️] ✅ Pełna konwersja zakończona sukcesem dla: ${docData.fileName} (Zużyto: ${totalTokensUsed} tkn)`);
    return totalTokensUsed;
}

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const { tenderId } = body;

        console.log(`[FAZA 0 🚀] Start sensoryczny dla przetargu: ${tenderId}`);
        if (!tenderId) return NextResponse.json({ error: "Brak tenderId" }, { status: 400 });

        const docsRef = adminDb.collection(`tenders/${tenderId}/documents`);
        const snapshot = await docsRef.where("status", "==", "UPLOADED").get();

        if (snapshot.empty) return NextResponse.json({ message: "Brak dokumentów do klasyfikacji." });

        console.log(`[FAZA 0 🚀] Przetwarzam ${snapshot.size} dokumentów SEKWENCYJNIE (one-by-one)...`);
        let totalTokensUsed = 0;
        const bucketName = process.env.STORAGE_BUCKET || "pesam-system-81165.firebasestorage.app";

        // Sekwencyjność chroni pamięć RAM przed Out of Memory na Cloud Run
        for (let j = 0; j < snapshot.docs.length; j++) {
            const docSnap = snapshot.docs[j];
            const docData = docSnap.data();
            console.log(`[FAZA 0 🚀] [Dokument ${j + 1}/${snapshot.size}] Analizuję: ${docData.fileName}`);

            try {
                const fileUri = `gs://${bucketName}/${docData.storagePath}`;
                const prompt = `
Jesteś Klasyfikatorem Sensorycznym systemu kosztorysowego PESAM 3.0. 
Przeanalizuj pierwszą stronę lub spis treści tego dokumentu budowlanego. 
Zwróć JSON z odpowiednimi tagami, streszczeniem oraz określi liczbę stron i zawartość tabel/rysunków.
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

                const pageCount = parsedResult.pageCount || 1;
                const tokensUsed = result.usageMetadata?.totalTokenCount || 0;
                totalTokensUsed += tokensUsed;

                await docSnap.ref.update({
                    tags: parsedResult.tags || [],
                    summary: parsedResult.summary || "(brak)",
                    detailedElement: parsedResult.detailedElement || "NIE_DOTYCZY",
                    containsTablesWithDimensions: parsedResult.containsTablesWithDimensions || false,
                    containsDrawings: parsedResult.containsDrawings || false,
                    pageCount: pageCount,
                    status: "CLASSIFIED",
                    classifyModel: MODEL_LITE,
                    updatedAt: new Date()
                });

                console.log(`[FAZA 0 🚀] Sklasyfikowano: ${docData.fileName} (Strony: ${pageCount}, Rysunki: ${parsedResult.containsDrawings})`);

                // --- KROK 2: Bezpieczna, pętlowa konwersja 'Dziel i Łącz' na Markdown ---
                const isPdf = (docData.mimeType || "").includes("pdf") || (docData.storagePath || "").toLowerCase().endsWith(".pdf");
                const hasOnlyDrawings = parsedResult.containsDrawings && !parsedResult.containsTablesWithDimensions;

                if (isPdf && !hasOnlyDrawings) {
                    try {
                        const mdTokens = await convertPdfToMarkdownInShadow(docSnap, bucketName, pageCount);
                        totalTokensUsed += mdTokens;
                    } catch (convErr: any) {
                        console.warn(`[FAZA 0.5 📄] Pomijam optymalizację Markdown dla ${docData.fileName}: ${convErr.message}`);
                    }
                } else {
                    console.log(`[FAZA 0.5 📄] Pomijam konwersję dla ${docData.fileName} (rysunek techniczny lub nie-PDF).`);
                }

            } catch (docError: any) {
                console.error(`[FAZA 0 🚀] Błąd krytyczny dla ${docData.fileName}:`, docError);
                await docSnap.ref.update({ status: "ERROR_CLASSIFYING", errorDetails: docError.message, updatedAt: new Date() }).catch(() => { });
            }

            // Mała przerwa chroniąca limity RPM
            await new Promise(r => setTimeout(r, 1500));
        }

        // Estymacja kosztu
        const estimatedCostUSD = (totalTokensUsed / 1000) * 0.0003;
        const tenderRef = adminDb.collection("tenders").doc(tenderId);

        await adminDb.runTransaction(async (t) => {
            const tenderDoc = await t.get(tenderRef);
            if (tenderDoc.exists) {
                const currentBudget = tenderDoc.data()?.budgetGuard || { currentCostUSD: 0 };
                t.update(tenderRef, {
                    status: "ORCHESTRATING",
                    "budgetGuard.currentCostUSD": currentBudget.currentCostUSD + estimatedCostUSD,
                    updatedAt: new Date()
                });
            }
        });

        // Inicjalizacja stanu Mózgu
        const brainRef = adminDb.collection(`tenders/${tenderId}/brain`).doc("main");
        await brainRef.set({
            phase: "PLANNING",
            currentGoal: "Analiza struktury dokumentów i planowanie podziału prac.",
            knownFacts: {},
            missingData: [],
            activeTaskIds: [],
            pendingDecisions: [],
            reasoningLog: ["Inicjalizacja sensoryczna i optymalizacja dokumentów 'Dziel i Łącz' zakończone pomyślnie."],
            totalCostUSD: estimatedCostUSD
        }, { merge: true });

        const localOrigin = `http://localhost:${process.env.PORT || "3000"}`;

        // Wybudzenie Głównego Kosztorysanta (PESAM)
        fetch(`${localOrigin}/api/kosztorysant/glowny-kosztorysant`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tenderId, trigger: "CLASSIFICATION_COMPLETE" })
        }).catch(() => { });

        // Jednoczesne wybudzenie Głównego Technologa Budowlanego
        fetch(`${localOrigin}/api/technolog/glowny-technolog`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tenderId, trigger: "CLASSIFICATION_COMPLETE" })
        }).catch(() => { });

        return NextResponse.json({ success: true, tokensUsed: totalTokensUsed });

    } catch (error: any) {
        console.error("[FAZA 0 🚀] Błąd krytyczny:", error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}