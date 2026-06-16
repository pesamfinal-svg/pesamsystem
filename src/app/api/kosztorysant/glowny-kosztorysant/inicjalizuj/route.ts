import { NextResponse } from "next/server";
import { adminDb, adminStorage } from "@/lib/firebase/admin";
import { GoogleGenAI, Type } from "@google/genai";
import { jsonrepair } from "jsonrepair";
import { PDFDocument } from "pdf-lib";
import dns from "dns";

// Optymalizacja zapytań DNS w środowisku Node
dns.setDefaultResultOrder("ipv4first");

export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 minut - max na Cloud Run

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

// Schemat zwracany przez klasyfikatora (Mózg Sensoryczny)
const CLASSIFIER_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        tags: { type: Type.ARRAY, items: { type: Type.STRING } },
        summary: { type: Type.STRING },
        detailedElement: { type: Type.STRING },
        containsTablesWithDimensions: { type: Type.BOOLEAN },
        drawingPages: {
            type: Type.ARRAY,
            items: { type: Type.NUMBER },
            description: "Numery stron (liczone od 1), na których są rysunki techniczne, mapy, schematy ORAZ strony zawierające bezpośrednio powiązane z nimi opisy/legendy. Zwróć pustą tablicę, jeśli brak rysunków."
        },
        pageCount: { type: Type.NUMBER },
        constructionDivisions: {
            type: Type.ARRAY,
            description: "Hierarchiczny spis działów robót budowlanych/instalacyjnych znalezionych w dokumencie.",
            items: {
                type: Type.OBJECT,
                properties: {
                    id: { type: Type.STRING, description: "Numer działu np. '1.2', 'E.1', 'S.2'" },
                    name: { type: Type.STRING, description: "Nazwa działu np. 'Instalacje elektryczne', 'Strop nad przelotnią'" },
                    pageStart: { type: Type.NUMBER, description: "Strona, na której zaczyna się dział" }
                }
            }
        }
    },
    required: ["tags", "summary", "detailedElement", "containsTablesWithDimensions", "drawingPages", "pageCount"]
};

// 🛡️ Pancerny Retry API
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
            console.warn(`[FAZA 0/0.5 ⚠️] API Limit/Sieć. Czekam ${Math.round(waitTime / 1000)}s...`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
            return callGeminiWithRetry(fn, retries - 1, delay * 2);
        }
        throw error;
    }
}

// 🚄 Współbieżność zabezpieczająca limity pamięci i CPU
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

// 🛠️ Funkcja pomocnicza do rysunków
function groupConsecutivePages(pages: number[]): { start: number, end: number }[] {
    if (pages.length === 0) return [];
    const sorted = [...pages].sort((a, b) => a - b);
    const groups = [];
    let start = sorted[0];
    let prev = sorted[0];

    for (let i = 1; i < sorted.length; i++) {
        if (sorted[i] === prev + 1) {
            prev = sorted[i];
        } else {
            groups.push({ start, end: prev });
            start = sorted[i];
            prev = sorted[i];
        }
    }
    groups.push({ start, end: prev });
    return groups;
}

/**
 * 🚀 METODA DZIEL I ŁĄCZ 4.1: (Z Systemowymi Kotwicami i Spisem Działów)
 */
async function convertPdfToMarkdownInShadow(
    docSnap: FirebaseFirestore.QueryDocumentSnapshot,
    bucketName: string,
    originalPdf: PDFDocument,
    textPages: number[],
    drawingPages: number[],
    containsTables: boolean,
    drawingsFilename: string,
    constructionDivisions: any[]
): Promise<number> {
    const docData = docSnap.data();
    const originalPath = docData.storagePath as string;
    const mdPath = `${originalPath}.md`;

    const CHUNK_SIZE = containsTables ? 10 : 30;
    let totalTokensUsed = 0;

    console.log(`[FAZA 0.5 🏗️] Konwersja MD dla ${docData.fileName} (Stron tekstu: ${textPages.length})`);

    const chunks: { pages: number[] }[] = [];
    for (let i = 0; i < textPages.length; i += CHUNK_SIZE) {
        chunks.push({ pages: textPages.slice(i, i + CHUNK_SIZE) });
    }

    const tasks = chunks.map((chunk) => async () => {
        const pagesToExtract = chunk.pages;
        console.log(`[FAZA 0.5 ✂️] Wycianam i procesuję paczkę tekstu: [${pagesToExtract.join(", ")}]...`);

        const newPdf = await PDFDocument.create();
        const pageIndices = pagesToExtract.map(p => p - 1);
        const copiedPages = await newPdf.copyPages(originalPdf, pageIndices);
        copiedPages.forEach(page => newPdf.addPage(page));

        const newPdfBytes = await newPdf.save();
        const base64Data = Buffer.from(newPdfBytes).toString("base64");

        const converterPrompt = `
Jesteś precyzyjnym konwerterem dokumentów budowlanych.
Zignoruj to, że to wycinek z większej całości. Przeanalizuj i przepisz załączony fragment na format Markdown.
Zasady:
${containsTables
                ? "- ZACHOWAJ TABELE jako czyste tabele Markdown (| kolumna | kolumna |) i zachowaj wszystkie liczby, jednostki oraz przedmiary."
                : "- Przepisz tekst z zachowaniem oryginalnej struktury nagłówków (#, ##, ###)."}
- Odpowiedz TYLKO i WYŁĄCZNIE treścią Markdown.
`;

        const result = await callGeminiWithRetry(async () => {
            return await aiRegional.models.generateContent({
                model: MODEL_CONVERTER,
                contents: [{
                    role: "user",
                    parts: [
                        { text: converterPrompt },
                        { inlineData: { data: base64Data, mimeType: "application/pdf" } }
                    ]
                }],
                config: { temperature: 0.1 }
            });
        });

        const tokens = result.usageMetadata?.totalTokenCount || 0;
        let chunkText = result.text ?? "";
        chunkText = chunkText.replace(/```markdown/gi, "").replace(/```/g, "").trim();

        return { start: pagesToExtract[0], text: `<!-- Wyciąg ze stron: ${pagesToExtract.join(", ")} -->\n${chunkText}`, tokens };
    });

    const MAX_CONCURRENCY = 3;
    const results = await runWithConcurrency(tasks, MAX_CONCURRENCY);
    totalTokensUsed = results.reduce((acc, curr) => acc + curr.tokens, 0);

    const drawingGroups = groupConsecutivePages(drawingPages);
    for (const group of drawingGroups) {
        const pageRange = group.start === group.end ? `strony ${group.start}` : `stron ${group.start} - ${group.end}`;
        const anchorText = `
> ⚠️ **[SYSTEM PESAM - KOTWICA WIZUALNA]** 
> Z tego miejsca (${pageRange}) wyodrębniono rysunki techniczne/mapy do pliku: \`${drawingsFilename}\`.
`;
        results.push({ start: group.start, text: anchorText.trim(), tokens: 0 });
    }

    results.sort((a, b) => a.start - b.start);

    // WSTRZYKIWANIE SPISU DZIAŁÓW (TOC)
    let tocHeader = "";
    if (constructionDivisions && constructionDivisions.length > 0) {
        tocHeader = `# 🏗️ SPIS DZIAŁÓW ROBÓT BUDOWLANYCH (Wykryty automatycznie)\n\n`;
        tocHeader += `> *Globalna mapa zakresu opracowana przez Klasyfikator PESAM*\n\n`;
        constructionDivisions.forEach(div => {
            const indent = div.id ? (div.id.split('.').length - 1) : 0;
            const prefix = "  ".repeat(Math.max(0, indent));
            tocHeader += `${prefix}- **${div.id || '-'}** — ${div.name || 'Brak nazwy'} *(str. ${div.pageStart || '?'})*\n`;
        });
        tocHeader += "\n---\n\n";
    }

    const compiledMarkdown = tocHeader + results.map(r => r.text).join("\n\n---\n\n");

    if (compiledMarkdown.length >= 50) {
        const bucket = adminStorage.bucket(bucketName);
        await bucket.file(mdPath).save(compiledMarkdown, {
            contentType: "text/markdown; charset=utf-8",
            metadata: { cacheControl: "no-cache" }
        });

        await docSnap.ref.update({
            storagePath: mdPath,
            mimeType: "text/markdown",
            isMarkdownCache: true,
            originalStoragePath: originalPath,
            constructionDivisions: constructionDivisions
        });
        console.log(`[FAZA 0.5 🏗️] ✅ Zapisano posklejany Markdown ze Spisem Działów (TOC)`);
    }

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
        const bucket = adminStorage.bucket(bucketName);

        for (let j = 0; j < snapshot.docs.length; j++) {
            const docSnap = snapshot.docs[j];
            const docData = docSnap.data();

            try {
                const isPdf = (docData.mimeType || "").includes("pdf") || (docData.storagePath || "").toLowerCase().endsWith(".pdf");
                const fileUri = `gs://${bucketName}/${docData.storagePath}`;

                // 🟢 ZMODYFIKOWANY PROMPT KLASYFIKATORA: Pełny skan i wielobranżowy spis treści z nagłówków!
                const prompt = `
Jesteś Klasyfikatorem Sensorycznym systemu kosztorysowego PESAM 3.0. 
Otrzymujesz CAŁY dokument budowlany do przeskanowania (od deski do deski).
TWOJE ZADANIE:
1. Zwróć JSON z tagami, streszczeniem i łączną liczbą stron.
2. Zaznacz 'containsTablesWithDimensions': true dla tabel przedmiarowych.
3. Wypełnij 'drawingPages' numerami stron z rysunkami/mapami.
4. BARDZO WAŻNE: Znajdź "Spis treści" lub wylistowane nagłówki działów w tabelach przedmiarowych.
   Wyodrębnij WSZYSTKIE działy robót do 'constructionDivisions', łącznie z działami instalacyjnymi
   (np. elektryka, sanitarna, wentylacja). Zachowaj oryginalną numerację (np. "d.1.3", "E.1", "S.2").
   Dla dokumentów bez spisu treści — wyodrębnij działy z pogrubionych nagłówków tabel (zazwyczaj to wiersze bez ilości i ceny).
`;
                const result = await callGeminiWithRetry(async () => {
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
                totalTokensUsed += result.usageMetadata?.totalTokenCount || 0;

                let drawingPages: number[] = parsedResult.drawingPages || [];
                const pageCount = parsedResult.pageCount || 1;
                const constructionDivisions = parsedResult.constructionDivisions || [];

                await docSnap.ref.update({
                    tags: parsedResult.tags || [],
                    summary: parsedResult.summary || "(brak)",
                    detailedElement: parsedResult.detailedElement || "NIE_DOTYCZY",
                    containsTablesWithDimensions: parsedResult.containsTablesWithDimensions || false,
                    containsDrawings: drawingPages.length > 0,
                    pageCount: pageCount,
                    constructionDivisions: constructionDivisions,
                    status: "CLASSIFIED",
                    classifyModel: MODEL_LITE,
                    updatedAt: new Date()
                });

                console.log(`[FAZA 0 🚀] Sklasyfikowano: ${docData.fileName}. Wykryto ${constructionDivisions.length} działów głównych.`);

                if (isPdf) {
                    const [fileBuffer] = await bucket.file(docData.storagePath).download();
                    const originalPdf = await PDFDocument.load(fileBuffer);
                    const actualPageCount = originalPdf.getPageCount();

                    drawingPages = [...new Set(drawingPages)].filter(p => p >= 1 && p <= actualPageCount).sort((a, b) => a - b);

                    const textPages: number[] = [];
                    for (let p = 1; p <= actualPageCount; p++) {
                        if (!drawingPages.includes(p)) textPages.push(p);
                    }

                    const originalFileName = docData.fileName || "dokument.pdf";
                    const drawingsFilename = drawingPages.length > 0
                        ? originalFileName.replace(/\.pdf$/i, '_drawings.pdf')
                        : "Brak";

                    if (drawingPages.length > 0) {
                        const drawingsPdf = await PDFDocument.create();
                        const copiedDrawings = await drawingsPdf.copyPages(originalPdf, drawingPages.map(p => p - 1));
                        copiedDrawings.forEach(page => drawingsPdf.addPage(page));

                        const drawingsStoragePath = (docData.storagePath as string).replace(/\.pdf$/i, '_drawings.pdf');
                        const drawingsPdfBytes = await drawingsPdf.save();
                        await bucket.file(drawingsStoragePath).save(drawingsPdfBytes, { contentType: "application/pdf" });

                        await docSnap.ref.update({ drawingsStoragePath, hasSeparatedDrawings: true });
                    }

                    if (textPages.length > 0) {
                        try {
                            const mdTokens = await convertPdfToMarkdownInShadow(
                                docSnap,
                                bucketName,
                                originalPdf,
                                textPages,
                                drawingPages,
                                parsedResult.containsTablesWithDimensions,
                                drawingsFilename,
                                constructionDivisions
                            );
                            totalTokensUsed += mdTokens;
                        } catch (convErr: any) {
                            console.warn(`[FAZA 0.5 📄] Błąd MD dla ${docData.fileName}:`, convErr);
                        }
                    }
                }

            } catch (docError: any) {
                console.error(`[FAZA 0 🚀] Błąd dla dokumentu ${docData.fileName}:`, docError);
                await docSnap.ref.update({ status: "ERROR_CLASSIFYING", updatedAt: new Date() }).catch(() => { });
            }
            await new Promise(r => setTimeout(r, 1000));
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

        const brainRef = adminDb.collection(`tenders/${tenderId}/brain`).doc("main");
        await brainRef.set({
            phase: "PLANNING",
            currentGoal: "Analiza struktury dokumentów i planowanie podziału prac.",
            knownFacts: {},
            missingData: [],
            activeTaskIds: [],
            pendingDecisions: [],
            reasoningLog: ["Zakończono Fazę 0: System wykonał ekstrakcję dokumentów tekstowych oraz oddzielił rysunki techniczne do analizy wizualnej."],
            totalCostUSD: estimatedCostUSD
        }, { merge: true });

        const localOrigin = `http://localhost:${process.env.PORT || "3000"}`;
        fetch(`${localOrigin}/api/kosztorysant/glowny-kosztorysant`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tenderId, trigger: "CLASSIFICATION_COMPLETE" })
        }).catch(() => { });
        fetch(`${localOrigin}/api/technolog/glowny-technolog`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tenderId, trigger: "CLASSIFICATION_COMPLETE" })
        }).catch(() => { });

        return NextResponse.json({ success: true, tokensUsed: totalTokensUsed });

    } catch (error: any) {
        console.error("[FAZA 0 🚀] Błąd krytyczny API:", error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}