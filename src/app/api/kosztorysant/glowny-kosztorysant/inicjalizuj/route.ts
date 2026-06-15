import { NextResponse } from "next/server";
import { adminDb, adminStorage } from "@/lib/firebase/admin";
import { GoogleGenAI, Type } from "@google/genai";
import { jsonrepair } from "jsonrepair";
import { PDFDocument } from "pdf-lib"; // 📦 Nowa lekka biblioteka do fizycznego cięcia PDF
import dns from "dns";

dns.setDefaultResultOrder("ipv4first");

export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 minut - maksymalny czas dla Cloud Run

const MODEL_LITE = "gemini-2.5-flash-lite";
const MODEL_CONVERTER = "gemini-2.5-flash";

// 🌍 Klient GLOBALNY (dla zadań lekkich: klasyfikacji)
const aiGlobal = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
    location: "global"
});

// 🇪🇺 Klient REGIONALNY (dla ciężkich zadań: konwersji Markdown)
const aiRegional = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
    location: "europe-west4"
});

const CLASSIFIER_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        tags: { type: Type.ARRAY, items: { type: Type.STRING } },
        summary: { type: Type.STRING },
        detailedElement: { type: Type.STRING },
        containsTablesWithDimensions: { type: Type.BOOLEAN },
        containsDrawings: { type: Type.BOOLEAN },
        pageCount: { type: Type.NUMBER }
    },
    required: ["tags", "summary", "detailedElement", "containsTablesWithDimensions", "containsDrawings", "pageCount"]
};

// 🛡️ Pancerny Retry
async function callGeminiWithRetry(fn: () => Promise<any>, retries = 5, delay = 5000): Promise<any> {
    try {
        return await fn();
    } catch (error: any) {
        const fullText = `${error?.toString?.() || ""} ${error?.cause?.toString?.() || ""}`;
        const isRateLimit = fullText.includes("429") || fullText.includes("RESOURCE_EXHAUSTED");
        const isSocketError = fullText.includes("UND_ERR_SOCKET") || fullText.includes("fetch failed") || fullText.includes("ECONNRESET") || fullText.includes("ETIMEDOUT");

        if ((isRateLimit || isSocketError) && retries > 0) {
            const jitter = Math.random() * 3000;
            const waitTime = delay + jitter;
            console.warn(`[FAZA 0/0.5 ⚠️] ${isRateLimit ? "Limit 429" : "Błąd sieci"}. Czekam ${Math.round(waitTime / 1000)}s... (Próby: ${retries})`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
            return callGeminiWithRetry(fn, retries - 1, delay * 2);
        }
        throw error;
    }
}

// 🚄 Współbieżność
async function runWithConcurrency<T>(tasks: (() => Promise<T>)[], concurrency: number): Promise<T[]> {
    const results: T[] = [];
    const executing = new Set<Promise<void>>();
    for (const task of tasks) {
        const p = task().then(res => { results.push(res); });
        executing.add(p);
        p.finally(() => executing.delete(p));
        if (executing.size >= concurrency) await Promise.race(executing);
    }
    await Promise.all(executing);
    return results;
}

/**
 * 🚀 METODA DZIEL I ŁĄCZ 3.0 (Z FIZYCZNYM CIĘCIEM PDF I REGIONALNYM API)
 */
async function convertPdfToMarkdownInShadow(
    docSnap: FirebaseFirestore.QueryDocumentSnapshot,
    bucketName: string,
    classifierPageCount: number,
    containsTables: boolean
): Promise<number> {
    const docData = docSnap.data();
    const originalPath = docData.storagePath as string;
    const mdPath = `${originalPath}.md`;
    
    // 1. Pobieramy cały plik PDF do pamięci RAM (Cloud Run poradzi sobie z tym w ułamku sekundy)
    const bucket = adminStorage.bucket(bucketName);
    const [fileBuffer] = await bucket.file(originalPath).download();
    
    // 2. Ładujemy do silnika pdf-lib
    const originalPdf = await PDFDocument.load(fileBuffer);
    const actualPageCount = originalPdf.getPageCount(); // Prawdziwa liczba stron

    const CHUNK_SIZE = containsTables ? 10 : 30; 
    let totalTokensUsed = 0;

    console.log(`[FAZA 0.5 ✂️] Start fizycznego cięcia MD: ${docData.fileName} (${actualPageCount} str.) | Tabele: ${containsTables}`);

    const chunks: { start: number, end: number }[] = [];
    for (let startPage = 1; startPage <= actualPageCount; startPage += CHUNK_SIZE) {
        chunks.push({
            start: startPage,
            end: Math.min(startPage + CHUNK_SIZE - 1, actualPageCount)
        });
    }

    const tasks = chunks.map(({ start, end }) => async () => {
        console.log(`[FAZA 0.5 ✂️] Wycianam i procesuję strony: ${start} - ${end}...`);
        
        // 3. Tworzymy nowy fizyczny dokument dla tej konkretnej paczki
        const newPdf = await PDFDocument.create();
        const pageIndices = [];
        // pdf-lib indeksuje strony od 0, więc start - 1
        for (let p = start - 1; p < end; p++) {
            pageIndices.push(p);
        }
        
        const copiedPages = await newPdf.copyPages(originalPdf, pageIndices);
        copiedPages.forEach(page => newPdf.addPage(page));
        
        // 4. Konwertujemy wyciętą paczkę na Base64
        const newPdfBytes = await newPdf.save();
        const base64Data = Buffer.from(newPdfBytes).toString("base64");

        // PROMPT ZOSTAŁ UPROSZCZONY! Model widzi teraz TYLKO ten wycięty fragment,
        // więc nie musi ignorować reszty stron, co zapobiega halucynacjom.
        const converterPrompt = `
Jesteś precyzyjnym konwerterem dokumentów budowlanych.
Przeanalizuj i przepisz załączony fragment dokumentu na format Markdown.
Zasady:
${containsTables 
    ? "- ZACHOWAJ TABELE jako czyste tabele Markdown (| kolumna | kolumna |) i zachowaj wszystkie liczby, jednostki oraz przedmiary." 
    : "- To dokument opisowy (np. SWZ, umowa). Przepisz tekst z zachowaniem oryginalnej struktury nagłówków (#, ##, ###)."}
- Odpowiedz TYLKO i WYŁĄCZNIE treścią Markdown, bez jakichkolwiek wstępów i komentarzy.
`;

        const result = await callGeminiWithRetry(async () => {
            // 🔥 ZAUWAŻ: Używamy klienta Regionalnego (aiRegional)
            return await aiRegional.models.generateContent({
                model: MODEL_CONVERTER,
                contents: [{
                    role: "user",
                    parts: [
                        { text: converterPrompt },
                        // Zamiast wysyłać link do całego pliku w GCS, wysyłamy fizycznie wycięty fragment w locie
                        { inlineData: { data: base64Data, mimeType: "application/pdf" } }
                    ]
                }],
                config: { temperature: 0.1 }
            });
        });

        const tokens = result.usageMetadata?.totalTokenCount || 0;
        let chunkText = result.text ?? "";
        chunkText = chunkText.replace(/```markdown/gi, "").replace(/```/g, "").trim();

        return { start, end, text: chunkText, tokens };
    });

    const MAX_CONCURRENCY = 3; 
    const results = await runWithConcurrency(tasks, MAX_CONCURRENCY);

    results.sort((a, b) => a.start - b.start);
    const markdownChunks = results
        .filter(r => r.text.length > 5)
        .map(r => `<!-- STRONY ${r.start}-${r.end} -->\n${r.text}`);
    
    totalTokensUsed = results.reduce((acc, curr) => acc + curr.tokens, 0);
    const compiledMarkdown = markdownChunks.join("\n\n---\n\n");

    if (!compiledMarkdown.trim() || compiledMarkdown.length < 50) {
         console.warn(`[FAZA 0.5 ⚠️] Wynik dla ${docData.fileName} jest zbyt krótki.`);
         return totalTokensUsed;
    }

    await bucket.file(mdPath).save(compiledMarkdown, {
        contentType: "text/markdown; charset=utf-8",
        metadata: { cacheControl: "no-cache" }
    });

    await docSnap.ref.update({
        storagePath: mdPath,
        mimeType: "text/markdown",
        isMarkdownCache: true,
        originalStoragePath: originalPath,
    });

    console.log(`[FAZA 0.5 🏗️] ✅ Zakończono konwersję MD: ${docData.fileName} (Zużyto: ${totalTokensUsed} tkn)`);
    return totalTokensUsed;
}

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const { tenderId } = body;

        if (!tenderId) return NextResponse.json({ error: "Brak tenderId" }, { status: 400 });

        const docsRef = adminDb.collection(`tenders/${tenderId}/documents`);
        const snapshot = await docsRef.where("status", "==", "UPLOADED").get();

        if (snapshot.empty) return NextResponse.json({ message: "Brak dokumentów do klasyfikacji." });

        let totalTokensUsed = 0;
        const bucketName = process.env.STORAGE_BUCKET || "pesam-system-81165.firebasestorage.app";

        for (let j = 0; j < snapshot.docs.length; j++) {
            const docSnap = snapshot.docs[j];
            const docData = docSnap.data();
            
            try {
                const fileUri = `gs://${bucketName}/${docData.storagePath}`;
                const prompt = `
Jesteś Klasyfikatorem Sensorycznym systemu kosztorysowego PESAM 3.0. 
Przeanalizuj pierwszą stronę lub próbkę dokumentu budowlanego. 
Zwróć JSON z tagami, streszczeniem i zaznacz, czy plik ma tabele i rysunki techniczne.
`;
                const result = await callGeminiWithRetry(async () => {
                    // 🔥 ZAUWAŻ: Używamy klienta Globalnego (aiGlobal) do lekkiej klasyfikacji
                    return await aiGlobal.models.generateContent({
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

                const parsedResult = JSON.parse(jsonrepair(result.text ?? "{}"));
                const pageCount = parsedResult.pageCount || 1;
                totalTokensUsed += result.usageMetadata?.totalTokenCount || 0;

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

                // --- KROK 2: Routing Dokumentów ---
                const isPdf = (docData.mimeType || "").includes("pdf") || (docData.storagePath || "").toLowerCase().endsWith(".pdf");
                const hasDrawings = parsedResult.containsDrawings === true;

                if (isPdf && !hasDrawings) {
                    try {
                        const mdTokens = await convertPdfToMarkdownInShadow(
                            docSnap, 
                            bucketName, 
                            pageCount, 
                            parsedResult.containsTablesWithDimensions
                        );
                        totalTokensUsed += mdTokens;
                    } catch (convErr: any) {
                        console.warn(`[FAZA 0.5 📄] Błąd MD dla ${docData.fileName}:`, convErr);
                    }
                } else if (isPdf && hasDrawings) {
                    console.log(`[FAZA 0.5 👁️] Dokument ma rysunki - pomijam konwersję.`);
                }

            } catch (docError: any) {
                console.error(`[FAZA 0 🚀] Błąd dla ${docData.fileName}:`, docError);
                await docSnap.ref.update({ status: "ERROR_CLASSIFYING" }).catch(() => { });
            }
            await new Promise(r => setTimeout(r, 1000)); // Pacing
        }

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

        // (tutaj kod do wybudzenia innych agentów z poprzedniego przykładu)

        return NextResponse.json({ success: true, tokensUsed: totalTokensUsed });

    } catch (error: any) {
        console.error("[FAZA 0 🚀] Błąd krytyczny API:", error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}