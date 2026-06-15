import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { FieldValue } from "firebase-admin/firestore";
import { GoogleGenAI, Type } from "@google/genai";
import { jsonrepair } from "jsonrepair";
import dns from "dns";
dns.setDefaultResultOrder("ipv4first");

export const dynamic = "force-dynamic";
export const maxDuration = 300; // Podniesiony czas, bo robimy 2 kroki

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
            console.warn(`[SCOPE RESEARCHER 🔭] Limit 429. Czekam ${delay / 1000}s... (prób: ${retries})`);
            await new Promise(r => setTimeout(r, delay + Math.random() * 2000)); // jitter
            return callGeminiWithRetry(fn, retries - 1, delay * 2);
        }
        throw error;
    }
}

// Schemat wyjściowy dla kroku 2 (Strukturyzacja)
const SCOPE_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        searchSummary: { type: Type.STRING },
        typicalScopeForObjectType: {
            type: Type.ARRAY,
            items: {
                type: Type.OBJECT,
                properties: {
                    division: { type: Type.STRING },
                    description: { type: Type.STRING },
                    isMandatory: { type: Type.BOOLEAN },
                    legalBasis: { type: Type.STRING },
                    isLikelyMissingInProject: { type: Type.BOOLEAN },
                    missingReason: { type: Type.STRING }
                },
                required: ["division", "isMandatory", "isLikelyMissingInProject"]
            }
        },
        criticalGaps: {
            type: Type.ARRAY,
            items: {
                type: Type.OBJECT,
                properties: {
                    gapName: { type: Type.STRING },
                    impactScore: { type: Type.NUMBER },
                    estimatedCostShare: { type: Type.STRING },
                    recommendation: { type: Type.STRING }
                },
                required: ["gapName", "impactScore", "recommendation"]
            }
        },
        sourcesFound: { type: Type.ARRAY, items: { type: Type.STRING } },
        confidence: { type: Type.NUMBER }
    },
    required: ["searchSummary", "typicalScopeForObjectType", "criticalGaps", "confidence"]
};

export async function POST(req: Request) {
    let tenderId: string | undefined;
    let taskId: string | undefined;
    let isSuccess = false;

    try {
        const body = await req.json();
        tenderId = body.tenderId;
        taskId = body.taskId;

        console.log(`[SCOPE RESEARCHER 🔭] Start. tenderId: ${tenderId}, taskId: ${taskId}`);
        if (!tenderId || !taskId) return NextResponse.json({ error: "Brak parametrów" }, { status: 400 });

        const taskRef = adminDb.collection(`tenders/${tenderId}/technolog_tasks`).doc(taskId);
        const taskDoc = await taskRef.get();
        if (!taskDoc.exists) throw new Error("Zadanie nie istnieje.");

        const taskData = taskDoc.data()!;
        if (taskData.status !== "PENDING") return NextResponse.json({ message: "Zadanie obsłużone." });

        await taskRef.update({ status: "IN_PROGRESS", updatedAt: new Date() });

        // Pobierz kontekst z Mózgu i dokumentów
        const [brainSnap, docsSnap] = await Promise.all([
            adminDb.collection(`tenders/${tenderId}/brain`).doc("main").get(),
            adminDb.collection(`tenders/${tenderId}/documents`).get()
        ]);

        const knownFacts = taskData.inputFacts || {};
        const objectType = knownFacts.objectType || "budynek użyteczności publicznej";
        const objectDescription = knownFacts.objectDescription || "";
        const brainFacts = brainSnap.exists ? (brainSnap.data()?.cognitiveState?.knownFacts || {}) : {};

        const existingDocs = docsSnap.docs.map(d => d.data().fileName || "").join(", ");
        const existingScopes = knownFacts.confirmedScopes || [];
        let totalTokensUsed = 0;

        // ==========================================
        // KROK 1: BADANIE SIECI (Google Search) - Zwraca czysty tekst!
        // ==========================================
        console.log("[SCOPE RESEARCHER 🔭] KROK 1: Szukanie informacji w sieci...");
        const searchPrompt = `
Jesteś ekspertem kosztorysowym budownictwa w Polsce. 

=== TYP INWESTYCJI ===
${objectType}
${objectDescription}

=== CO JUŻ WIEMY Z DOKUMENTÓW ===
Dokumenty w projekcie: ${existingDocs}
Zakresy potwierdzone: ${JSON.stringify(existingScopes)}
Fakty z Mózgu PESAM: ${JSON.stringify(brainFacts)}

=== ZADANIE WYSZUKIWANIA ===
1. Wyszukaj w internecie (Google Search) przykładowe kosztorysy inwestorskie lub przedmiary robót dla: "${objectType}" w Polsce. Szukaj na BIP gmin, eb2b, itp.
2. Na podstawie wyników, sporządź szczegółowy RAPORT TEKSTOWY.
3. W raporcie wymień: jakie działy kosztorysowe są wymagane w takim obiekcie, czego brakuje w obecnych dokumentach (wyłap luki), oraz jakie źródła (linki) znalazłeś.

Napisz raport jako zwykły tekst, kategorycznie BEZ struktury JSON.
`;

        const searchResult = await callGeminiWithRetry(() =>
            ai.models.generateContent({
                model: MODEL_FLASH,
                contents: searchPrompt,
                config: {
                    tools: [{ googleSearch: {} }],
                    temperature: 0.2
                    // NIE MA responseMimeType !
                }
            })
        );

        totalTokensUsed += searchResult.usageMetadata?.totalTokenCount || 0;
        const rawReport = searchResult.text || "Nie udało się znaleźć precyzyjnych danych.";
        console.log("[SCOPE RESEARCHER 🔭] KROK 1: Pomyślnie zebrano raport tekstowy.");

        // ==========================================
        // KROK 2: STRUKTURYZACJA WYNIKÓW (Bez Google Search, narzucony JSON)
        // ==========================================
        console.log("[SCOPE RESEARCHER 🔭] KROK 2: Strukturyzacja raportu do JSON...");
        const structurePrompt = `
Poniżej znajduje się surowy raport z poszukiwań typowych zakresów robót w internecie.
Zmień te informacje w ustrukturyzowany format JSON, ściśle według zadanego schematu.

RAPORT BADACZA:
${rawReport}
`;

        const structureResult = await callGeminiWithRetry(() =>
            ai.models.generateContent({
                model: MODEL_FLASH,
                contents: structurePrompt,
                config: {
                    // BEZ narzedzia Google Search!
                    temperature: 0.1,
                    responseMimeType: "application/json",
                    responseSchema: SCOPE_SCHEMA as any
                }
            })
        );

        totalTokensUsed += structureResult.usageMetadata?.totalTokenCount || 0;

        let parsed: any = {};
        try {
            parsed = JSON.parse(jsonrepair(structureResult.text ?? "{}"));
        } catch (e) {
            console.warn("[SCOPE RESEARCHER 🔭] Błąd parsowania ostatecznego JSON-a, używam fallbacku.");
            parsed = { searchSummary: "Błąd parsowania", typicalScopeForObjectType: [], criticalGaps: [], confidence: 10 };
        }

        console.log(`[SCOPE RESEARCHER 🔭] Sukces strukturyzacji: Znaleziono ${parsed.typicalScopeForObjectType?.length || 0} działów, ${parsed.criticalGaps?.length || 0} luk krytycznych.`);

        await taskRef.update({
            status: "DONE",
            rawResult: {
                typicalScopeForObjectType: parsed.typicalScopeForObjectType || [],
                criticalGaps: parsed.criticalGaps || [],
                searchSummary: parsed.searchSummary || rawReport.substring(0, 500),
                sourcesFound: parsed.sourcesFound || [],
                confidence: parsed.confidence || 50,
                summary: `Zbadano zakres dla "${objectType}". Znaleziono ${parsed.criticalGaps?.length || 0} krytycznych luk w dokumentacji.`
            },
            processedByTechnolog: false,
            costTokens: totalTokensUsed,
            updatedAt: new Date()
        });

        const costUSD = (totalTokensUsed / 1000) * 0.000015;
        await adminDb.collection("tenders").doc(tenderId!).update({
            "budgetGuard.currentCostUSD": FieldValue.increment(costUSD)
        });

        isSuccess = true;
        return NextResponse.json({
            success: true,
            divisionsFound: parsed.typicalScopeForObjectType?.length || 0,
            criticalGaps: parsed.criticalGaps?.length || 0
        });

    } catch (error: any) {
        console.error("[SCOPE RESEARCHER 🔭] ❌ Błąd krytyczny:", error);
        if (tenderId && taskId) {
            await adminDb.collection(`tenders/${tenderId}/technolog_tasks`).doc(taskId).update({
                status: "ERROR",
                rawResult: { error: error.message },
                processedByTechnolog: false,
                updatedAt: new Date()
            }).catch(() => { });
        }
        return NextResponse.json({ error: error.message }, { status: 500 });
    } finally {
        if (tenderId && taskId) {
            const localOrigin = `http://localhost:${process.env.PORT || "3000"}`;
            fetch(`${localOrigin}/api/technolog/glowny-technolog`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    tenderId,
                    trigger: isSuccess ? `TASK_COMPLETED_${taskId}` : `TASK_FAILED_${taskId}`
                })
            }).catch(() => { });
        }
    }
}