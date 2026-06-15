import { NextResponse } from "next/server";
import { adminDb, adminStorage } from "@/lib/firebase/admin";
import { GoogleGenAI, Type } from "@google/genai";
import { jsonrepair } from "jsonrepair";
import dns from "dns";
dns.setDefaultResultOrder("ipv4first");

export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 minut - maksymalny czas dla Cloud Run

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
            description: "Tagi dokumentu, np. [SWZ], [UMOWA], [SPECYFIKACJA], [RZUTY]"
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

// 🛡️ Pancerny Retry obsługujący błędy 429 oraz wszelkie zerwania gniazd sieciowych
async function callGeminiWithRetry(fn: () => Promise<any>, retries = 5, delay = 5000): Promise<any> {
    try {
        return await fn();
    } catch (error: any) {
        const errorText = error?.toString?.() || "";
        const causeText = error?.cause?.toString?.() || "";
        const fullText = `${errorText} ${causeText}`;

        const isRateLimit = fullText.includes("429") || fullText.includes("RESOURCE_EXHAUSTED");
        const isSocketError =
            fullText.includes("UND_ERR_SOCKET") ||
            fullText.includes("fetch failed") ||
            fullText.includes("other side closed") ||
            fullText.includes("ECONNRESET") ||
            fullText.includes("ETIMEDOUT") ||
            fullText.includes("SocketError");

        if ((isRateLimit || isSocketError) && retries > 0) {
            const jitter = Math.random() * 3000;
            const waitTime = delay + jitter;
            const reason = isRateLimit ? "Limit API 429" : "Błąd sieci/socketu (zerwane połączenie)";
            console.warn(`[FAZA 0/0.5 ⚠️] ${reason}. Czekam ${Math.round(waitTime / 1000)}s... (Pozostało prób: ${retries})`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
            return callGeminiWithRetry(fn, retries - 1, delay * 2); // Exponential backoff
        }
        throw error;
    }
}

// 🚄 Pomocnicza funkcja do kontrolowania współbieżności (zabezpieczenie przed Timeoutem)
async function runWithConcurrency<T>(tasks: (() => Promise<T>)[], concurrency: number): Promise<T[]> {
    const results: T[] = [];
    const executing = new Set<Promise<void>>();
    
    for (const task of tasks) {
        const p = task().then(res => {
            results.push(res);
        });
        executing.add(p);
        p.finally(() => executing.delete(p));
        
        if (executing.size >= concurrency) {
            await Promise.race(executing);
        }
    }
    await Promise.all(executing);
    return results;
}

/**
 * 🚀 METODA DZIEL I ŁĄCZ 2.0 (Hybrydowa + Współbieżna)
 * Konwertuje tekstowe pliki PDF na Markdown z użyciem zmiennego rozmiaru paczek.
 */
async function convertPdfToMarkdownInShadow(
    docSnap: FirebaseFirestore.QueryDocumentSnapshot,
    bucketName: string,
    pageCount: number,
    containsTables: boolean
): Promise<number> {
    const docData = docSnap.data();
    const originalPath = docData.storagePath as string;
    const mdPath = `${originalPath}.md`;
    const fileUri = `gs://${bucketName}/${originalPath}`;

    // INTELIGENTNY ROUTING: Zmienny rozmiar paczek
    const CHUNK_SIZE = containsTables ? 10 : 30; 
    let totalTokensUsed = 0;

    console.log(`[FAZA 0.5 🏗️] Start konwersji MD: ${docData.fileName} (${pageCount} str.) | Tabele: ${containsTables} | Paczka: ${CHUNK_SIZE}`);

    const chunks: { start: number, end: number }[] = [];
    for (let startPage = 1; startPage <= pageCount; startPage += CHUNK_SIZE) {
        chunks.push({
            start: startPage,
            end: Math.min(startPage + CHUNK_SIZE - 1, pageCount)
        });
    }

    const tasks = chunks.map(({ start, end }) => async () => {
        console.log(`[FAZA 0.5 🏗️] Przetwarzam strony: ${start} - ${end}...`);
        
        const converterPrompt = `
Jesteś precyzyjnym konwerterem dokumentów budowlanych.
Przeanalizuj i przepisz na format Markdown TYLKO STRONY OD ${start} DO ${end} (włącznie).
Zasady:
- Skup się wyłącznie na stronach od ${start} do ${end}.
${containsTables 
    ? "- ZACHOWAJ TABELE jako czyste tabele Markdown (| kolumna | kolumna |) i zachowaj wszystkie liczby, jednostki oraz przedmiary." 
    : "- To dokument opisowy (np. SWZ, umowa). Przepisz tekst z zachowaniem oryginalnej struktury nagłówków (#, ##, ###)."}
- Odpowiedz TYLKO i WYŁĄCZNIE treścią Markdown, bez jakichkolwiek wstępów i komentarzy.
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

        const tokens = result.usageMetadata?.totalTokenCount || 0;
        let chunkText = result.text ?? "";
        chunkText = chunkText.replace(/```markdown/gi, "").replace(/```/g, "").trim();

        return { start, end, text: chunkText, tokens };
    });

    // Uruchamiamy współbieżnie (Max 3 na raz, chroni przed 429 i Timeout Cloud Run)
    const MAX_CONCURRENCY = 3; 
    const results = await runWithConcurrency(tasks, MAX_CONCURRENCY);

    // Sortujemy wyniki, ponieważ współbieżność może zwrócić je w różnej kolejności
    results.sort((a, b) => a.start - b.start);
    const markdownChunks = results
        .filter(r => r.text.length > 5)
        .map(r => `<!-- STRONY ${r.start}-${r.end} -->\n${r.text}`);
    
    totalTokensUsed = results.reduce((acc, curr) => acc + curr.tokens, 0);
    const compiledMarkdown = markdownChunks.join("\n\n---\n\n");

    if (!compiledMarkdown.trim() || compiledMarkdown.length < 50) {
         console.warn(`[FAZA 0.5 ⚠️] Wynik dla ${docData.fileName} jest zbyt krótki. Możliwy pusty dokument.`);
         return totalTokensUsed;
    }

    // Zapis do Cloud Storage
    const bucket = adminStorage.bucket(bucketName);
    await bucket.file(mdPath).save(compiledMarkdown, {
        contentType: "text/markdown; charset=utf-8",
        metadata: { cacheControl: "no-cache" }
    });

    // Aktualizacja Firestore - Przezroczysta podmiana ścieżki
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

        console.log(`[FAZA 0 🚀] Start sensoryczny dla przetargu: ${tenderId}`);
        if (!tenderId) return NextResponse.json({ error: "Brak tenderId" }, { status: 400 });

        const docsRef = adminDb.collection(`tenders/${tenderId}/documents`);
        const snapshot = await docsRef.where("status", "==", "UPLOADED").get();

        if (snapshot.empty) return NextResponse.json({ message: "Brak dokumentów do klasyfikacji." });

        console.log(`[FAZA 0 🚀] Przetwarzam ${snapshot.size} dokumentów SEKWENCYJNIE (one-by-one)...`);
        let totalTokensUsed = 0;
        const bucketName = process.env.STORAGE_BUCKET || "pesam-system-81165.firebasestorage.app";

        // Sekwencyjność na głównej pętli chroni pamięć RAM przed OOM na Cloud Run
        for (let j = 0; j < snapshot.docs.length; j++) {
            const docSnap = snapshot.docs[j];
            const docData = docSnap.data();
            console.log(`[FAZA 0 🚀] [Dokument ${j + 1}/${snapshot.size}] Analizuję: ${docData.fileName}`);

            try {
                const fileUri = `gs://${bucketName}/${docData.storagePath}`;
                const prompt = `
Jesteś Klasyfikatorem Sensorycznym systemu kosztorysowego PESAM 3.0. 
Przeanalizuj pierwszą stronę, spis treści lub próbkę dokumentu budowlanego. 
Zwróć JSON z odpowiednimi tagami, streszczeniem oraz dokładnie określ, czy plik zawiera tabele/przedmiary oraz rysunki/rzuty techniczne.
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

                console.log(`[FAZA 0 🚀] Sklasyfikowano: ${docData.fileName} (Strony: ${pageCount}, Tabele: ${parsedResult.containsTablesWithDimensions}, Rysunki: ${parsedResult.containsDrawings})`);

                // --- KROK 2: Inteligenty Routing Dokumentów ---
                const isPdf = (docData.mimeType || "").includes("pdf") || (docData.storagePath || "").toLowerCase().endsWith(".pdf");
                const hasDrawings = parsedResult.containsDrawings === true;

                if (isPdf && !hasDrawings) {
                    // 📄 Dokument zawiera tylko tekst lub tabele (brak rysunków) -> Konwersja na Markdown
                    try {
                        const mdTokens = await convertPdfToMarkdownInShadow(
                            docSnap, 
                            bucketName, 
                            pageCount, 
                            parsedResult.containsTablesWithDimensions
                        );
                        totalTokensUsed += mdTokens;
                    } catch (convErr: any) {
                        console.warn(`[FAZA 0.5 📄] Pomijam optymalizację Markdown dla ${docData.fileName}: ${convErr.message}`);
                    }
                } else if (isPdf && hasDrawings) {
                    // 📐 Dokument zawiera rysunki techniczne -> Omijamy konwersję na rzecz Agenta Vision
                    console.log(`[FAZA 0.5 👁️] Dokument ${docData.fileName} zawiera rysunki. Pozostawiam jako natywny PDF dla Agenta Vision.`);
                } else {
                    // 📎 Inny plik (np. .docx, .xlsx, .dwg)
                    console.log(`[FAZA 0.5 📎] Pomijam konwersję dla ${docData.fileName} (nie jest to plik PDF).`);
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
            reasoningLog: ["Inicjalizacja sensoryczna (klasyfikacja + generowanie Markdown) zakończona pomyślnie."],
            totalCostUSD: estimatedCostUSD
        }, { merge: true });

        const localOrigin = `http://localhost:${process.env.PORT || "3000"}`;

        // Wybudzenie Głównego Kosztorysanta
        fetch(`${localOrigin}/api/kosztorysant/glowny-kosztorysant`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tenderId, trigger: "CLASSIFICATION_COMPLETE" })
        }).catch(() => { });

        // Wybudzenie Głównego Technologa Budowlanego
        fetch(`${localOrigin}/api/technolog/glowny-technolog`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tenderId, trigger: "CLASSIFICATION_COMPLETE" })
        }).catch(() => { });

        return NextResponse.json({ success: true, tokensUsed: totalTokensUsed });

    } catch (error: any) {
        console.error("[FAZA 0 🚀] Błąd krytyczny API:", error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}