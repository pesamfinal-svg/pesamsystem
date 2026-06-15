import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { FieldValue } from "firebase-admin/firestore";
import { GoogleGenAI } from "@google/genai";
import { jsonrepair } from "jsonrepair";
import dns from "dns";
dns.setDefaultResultOrder("ipv4first");

export const dynamic = "force-dynamic";

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

        // Co już mamy z dokumentów (żeby nie szukać duplikatów)
        const existingDocs = docsSnap.docs.map(d => d.data().fileName || "").join(", ");
        const existingScopes = knownFacts.confirmedScopes || [];

        const researchPrompt = `
Jesteś ekspertem kosztorysowym budownictwa w Polsce. Twoim zadaniem jest ustalenie PEŁNEGO zakresu robót 
dla inwestycji budowlanej i znalezienie BRAKUJĄCYCH elementów w stosunku do tego co już jest w dokumentacji.

=== TYP INWESTYCJI ===
${objectType}
${objectDescription}

=== CO JUŻ WIEMY Z DOKUMENTÓW ===
Dokumenty w projekcie: ${existingDocs}
Zakresy potwierdzone: ${JSON.stringify(existingScopes)}
Fakty z Mózgu PESAM: ${JSON.stringify(brainFacts)}

=== TWOJE ZADANIE ===
1. Wyszukaj w internecie przykładowe kosztorysy inwestorskie lub przedmiary robót dla: "${objectType}" w Polsce
   - Szukaj na BIP gmin, eb2b.com.pl, przetargi.pl, bazakosztorysow.pl, lub inne polskie portale budowlane
   - Szukaj fraz: "kosztorys inwestorski ${objectType} przedmiar" lub "SIWZ ${objectType} zakres robót"

2. Na podstawie znalezionych przykładów ORAZ swojej wiedzy eksperckiej ustal:
   - Jakie DZIAŁY kosztorysowe MUSZĄ wystąpić w typowym projekcie "${objectType}"
   - Które z tych działów NIE SĄ pokryte istniejącymi dokumentami
   - Jakie instalacje, elementy, roboty zewnętrzne są standardem dla tego typu obiektu

3. Uwzględnij wymogi prawne (Prawo Budowlane, rozporządzenia branżowe) dla tego typu obiektu

Zwróć WYŁĄCZNIE JSON (bez komentarzy, bez markdown) w tej strukturze:
{
  "searchSummary": "Co znalazłeś i skąd",
  "typicalScopeForObjectType": [
    {
      "division": "Nazwa działu kosztorysowego",
      "description": "Co obejmuje",
      "isMandatory": true,
      "legalBasis": "Podstawa prawna lub norma jeśli dotyczy",
      "isLikelyMissingInProject": true,
      "missingReason": "Dlaczego podejrzewasz że brakuje (jeśli brakuje)"
    }
  ],
  "criticalGaps": [
    {
      "gapName": "Nazwa brakującego zakresu",
      "impactScore": 0,
      "estimatedCostShare": "szacunkowy % wartości inwestycji",
      "recommendation": "Co Technolog powinien zrobić"
    }
  ],
  "sourcesFound": ["url1", "url2"],
  "confidence": 0
}
`;

        const result = await callGeminiWithRetry(() =>
            ai.models.generateContent({
                model: MODEL_FLASH,
                contents: researchPrompt,
                config: {
                    tools: [{ googleSearch: {} }],
                    temperature: 0.2
                    // USUNIĘTO: responseMimeType: "application/json" (Konflikt z Google Search API 400)
                }
            })
        );

        const totalTokensUsed = result.usageMetadata?.totalTokenCount || 0;

        let parsed: any = {};
        try {
            // Oczyszczanie z Markdown, ponieważ bez MimeType model lubi dodać ```json na początku
            let rawText = result.text ?? "{}";
            rawText = rawText.replace(/```json/gi, "").replace(/```/g, "").trim();

            parsed = JSON.parse(jsonrepair(rawText));
        } catch (e) {
            console.warn("[SCOPE RESEARCHER 🔭] Błąd parsowania JSON, próba odzysku...");
            parsed = { searchSummary: result.text, typicalScopeForObjectType: [], criticalGaps: [], confidence: 30 };
        }

        console.log(`[SCOPE RESEARCHER 🔭] Znaleziono ${parsed.typicalScopeForObjectType?.length || 0} działów, ${parsed.criticalGaps?.length || 0} luk krytycznych`);

        await taskRef.update({
            status: "DONE",
            rawResult: {
                typicalScopeForObjectType: parsed.typicalScopeForObjectType || [],
                criticalGaps: parsed.criticalGaps || [],
                searchSummary: parsed.searchSummary || "",
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
        console.error("[SCOPE RESEARCHER 🔭] Błąd:", error);
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