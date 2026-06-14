import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { FieldValue } from "firebase-admin/firestore";
import { GoogleGenAI, Type } from "@google/genai";
import { jsonrepair } from "jsonrepair";

export const dynamic = "force-dynamic";

const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
    location: "global"
});

const MODEL_PRO = "gemini-2.5-pro";
const MODEL_FLASH = "gemini-2.5-flash";

// Pomocnicza funkcja realizująca Exponential Backoff dla błędów 429 (RESOURCE_EXHAUSTED) u Budowlańca
async function callGeminiWithRetry(fn: () => Promise<any>, retries = 3, delay = 3000): Promise<any> {
    try {
        return await fn();
    } catch (error: any) {
        const errorText = error.toString() || "";
        const isRateLimit = errorText.includes("429") || errorText.includes("RESOURCE_EXHAUSTED");

        if (isRateLimit && retries > 0) {
            console.warn(`[BUDOWLANIEC 🧱] Wykryto limit API 429. Chmura przeciążona. Czekam ${delay / 1000}s przed próbą ponowienia... (Pozostało prób: ${retries})`);
            await new Promise(resolve => setTimeout(resolve, delay));
            return callGeminiWithRetry(fn, retries - 1, delay * 2); // Exponential backoff
        }
        throw error;
    }
}

const BUDOWLANIEC_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        rawFindings: {
            type: Type.STRING,
            description: "Pełny, szczegółowy raport technologiczny zawierający proponowane procesy budowlane, normy zużycia materiałów, wymagane klasy betonu, stali, grubości warstw i parametry inżynieryjne wyliczone dla tego obiektu."
        },
        assumedParameters: {
            type: Type.ARRAY,
            description: "Lista twardych założeń inżynieryjnych (parametrów), które przyjąłeś jako bezpieczne domyślne dla tego typu obiektu.",
            items: { type: Type.STRING }
        }
    },
    required: ["rawFindings", "assumedParameters"]
};

export async function POST(req: Request) {
    let tenderId: string | undefined;
    let taskId: string | undefined;
    let isSuccess = false;

    try {
        const body = await req.json();
        tenderId = body.tenderId;
        taskId = body.taskId;

        console.log(`[BUDOWLANIEC 🧱] Start. tenderId: ${tenderId}, taskId: ${taskId}`);

        if (!tenderId || !taskId) return NextResponse.json({ error: "Brak parametrów" }, { status: 400 });

        const taskRef = adminDb.collection(`tenders/${tenderId}/tasks`).doc(taskId);
        const taskDoc = await taskRef.get();

        if (!taskDoc.exists) throw new Error("Zadanie nie istnieje.");

        const taskData = taskDoc.data()!;
        if (taskData.status !== "PENDING") return NextResponse.json({ message: "Zadanie już wykonane." });

        await taskRef.update({ status: "IN_PROGRESS", updatedAt: new Date() });

        const knownFacts = taskData.inputFacts || {};
        let totalTokensUsed = 0;

        console.log("[BUDOWLANIEC 🧱] Rozpoczynam KROK 1: Projektowanie z Google Search (Zabezpieczone Retry)...");
        const designPrompt = `
Jesteś Głównym Inżynierem Budowy. Twoja żelazna zasada pracy brzmi: Jesteś samodzielny. Jeśli w podanych znanych faktach ${JSON.stringify(knownFacts)} omija się szczegóły inżynieryjne (klasy betonów pod ławy w danym typie terenu, gęstości, siatki poprzeczne/podłużne), TO SAM je ustalaj pod kątem Polskiego standardu dla opisywanych obiektów.

Wskazówki Mózgu: ${taskData.instruction}

Nie proś ludzi o informację: jeśli SWZ nie pisze czy rurki to 15mm czy 20mm pod PEX ogrzewanie - zajrzyj w normę instalacyjną (masz dostęp włączony - uzyj wyszukiwarki). Przyjmij wyguglowaną optymalną i ekonomicznie racjonalną w Polsce miarę do opisu roboczego, jako gotową tezę kosztorysowania dla nas, zamiast odpytywać Kosztorysanta i go nudzić błachostkami o stali budowlanej - Kosztorysant też ma prawo nie znać milimetrowej specyfikacji, licz po najsensowniejszym wspóczynniku domyślnym inżynierskim jako doświadczony samodzielnie pracownik z norm dla typowych bloków czy stalaży dla budynku publicznego!

Daj czysty szczegółowy technologiczny wykaz od podbudów do tynku z racjonalnym rozpisaniem. Wyłącznie ostatecznie jak system lub dokument się nie spina prawnie co zrzuca miliony i to błąd specyfikacji to zjaw problem brakiem!`;

        const designResult = await callGeminiWithRetry(async () => {
            return await ai.models.generateContent({
                model: MODEL_PRO,
                contents: designPrompt, // Czysty string, brak błędu TS2353
                config: { tools: [{ googleSearch: {} }], temperature: 0.2 }
            });
        });

        const builderProposal = designResult.text ?? "";
        const tokensStep1 = designResult.usageMetadata?.totalTokenCount || 0;
        totalTokensUsed += tokensStep1;
        console.log(`[BUDOWLANIEC 🧱] Krok 1 zakończony. Zużyto tokenów: ${tokensStep1}`);

        console.log("[BUDOWLANIEC 🧱] Rozpoczynam KROK 2 Audytu Z Cichego Rejestratora (Zabezpieczone Retry)...");
        const auditPrompt = `Przeanalizuj autokrytycznie swoją autorską zarysowana koncepcje samodzielnie i wypunktuj niedociągniecia budowlanych procesow pobocznych logistyk roboczo ziemnej izolacyjnej, ktore mogles nie wymienic do cyklu np zwozek lub sprzetów do:\n ${builderProposal}`;

        const auditResult = await callGeminiWithRetry(async () => {
            return await ai.models.generateContent({
                model: MODEL_PRO,
                contents: auditPrompt,
                config: { temperature: 0.2 }
            });
        });

        const auditorFeedback = auditResult.text ?? "";
        const tokensStep2 = auditResult.usageMetadata?.totalTokenCount || 0;
        totalTokensUsed += tokensStep2;
        console.log(`[BUDOWLANIEC 🧱] Krok 2 zakończony. Zużyto tokenów: ${tokensStep2}`);

        console.log("[BUDOWLANIEC 🧱] Rozpoczynam KROK 3 - finalny autozależnościowy ustruktur JSON (Zabezpieczone Retry)...");
        const synthesisPrompt = `Przeanalizuj plan technologiczny oraz błędy audytu. Przygotuj spójny, inżynieryjny zestaw surowych danych i założeń technologicznych w formacie JSON.\nPlan:${builderProposal} \nBledy Audytu:${auditorFeedback}. Wymień szczegółowo parametry techniczne materiałów i procesów (np. klasy betonu, normy KNR), które Mózg powinien wykorzystać do stworzenia kosztorysu.`;

        const structureResult = await callGeminiWithRetry(async () => {
            return await ai.models.generateContent({
                model: MODEL_FLASH,
                contents: synthesisPrompt,
                config: {
                    temperature: 0.1,
                    responseMimeType: "application/json",
                    responseSchema: BUDOWLANIEC_SCHEMA as any
                }
            });
        });

        const parsedResult = JSON.parse(jsonrepair(structureResult.text ?? "{}"));
        const tokensStep3 = structureResult.usageMetadata?.totalTokenCount || 0;
        totalTokensUsed += tokensStep3;
        console.log(`[BUDOWLANIEC 🧱] Krok 3 zakończony. Zużyto tokenów: ${tokensStep3}`);

        await taskRef.update({
            status: "DONE",
            rawResult: parsedResult,
            processedByBrain: false,
            costTokens: totalTokensUsed,
            updatedAt: new Date()
        });

        const totalCostUSD = (totalTokensUsed / 1000) * 0.002;
        await adminDb.collection("tenders").doc(tenderId).update({ "budgetGuard.currentCostUSD": FieldValue.increment(totalCostUSD) });

        isSuccess = true;
        console.log("[BUDOWLANIEC 🧱] Pomyślny autogenerat inżynierstwa zakończony bez pytań usera jeśli standard dostępny normowany znaleziono sieci Google!");
        return NextResponse.json({ success: true });

    } catch (error: any) {
        console.error("[BUDOWLANIEC 🧱] ❌ Błąd krytyczny:", error);
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
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ tenderId, trigger: isSuccess ? `TASK_COMPLETED_${taskId}` : `TASK_FAILED_${taskId}` })
            }).catch(() => { });
        }
    }
}