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

const MODEL_FLASH = "gemini-2.5-flash"; // Ultra-tani model

async function callGeminiWithRetry(fn: () => Promise<any>, retries = 5, delay = 4000): Promise<any> {
    try {
        return await fn();
    } catch (error: any) {
        const isRateLimit = error.toString().includes("429") || error.toString().includes("RESOURCE_EXHAUSTED");
        if (isRateLimit && retries > 0) {
            console.warn(`[QUANTITY ESTIMATOR 📐] Limit 429. Czekam ${delay / 1000}s...`);
            await new Promise(r => setTimeout(r, delay));
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

        console.log(`[QUANTITY ESTIMATOR 📐] Start. tenderId: ${tenderId}, taskId: ${taskId}`);

        if (!tenderId || !taskId) return NextResponse.json({ error: "Brak parametrów" }, { status: 400 });

        const taskRef = adminDb.collection(`tenders/${tenderId}/technolog_tasks`).doc(taskId);
        const taskDoc = await taskRef.get();
        if (!taskDoc.exists) throw new Error("Zadanie nie istnieje.");

        const taskData = taskDoc.data()!;
        if (taskData.status !== "PENDING") return NextResponse.json({ message: "Zadanie obsłużone." });

        await taskRef.update({ status: "IN_PROGRESS", updatedAt: new Date() });

        // ── KLUCZOWY RECYKLING DANYCH: Pobieramy to, co Kosztorysant już ma w bazie ──
        const estimateRef = adminDb.collection(`tenders/${tenderId}/estimate`);
        const estimateSectionsSnap = await estimateRef.get();

        const currentEstimateState: any[] = [];

        for (const secDoc of estimateSectionsSnap.docs) {
            const itemsSnap = await estimateRef.doc(secDoc.id).collection("items").get();
            const items = itemsSnap.docs.map(i => ({
                pozycja: i.data().pozycja,
                opis: i.data().opis,
                ilosc: i.data().ilosc,
                jednostka: i.data().jednostka
            }));
            if (items.length > 0) {
                currentEstimateState.push({
                    sekcja: secDoc.data().section,
                    pozycje: items
                });
            }
        }

        console.log(`[QUANTITY ESTIMATOR 📐] Zaimportowano ${currentEstimateState.length} sekcji kosztorysu jako kontekst.`);

        const searchPrompt = `
Jesteś Inżynierem-Audytorem Zakresu (Scope Auditor) w systemie PESAM 3.0.
Twoim zadaniem jest przeanalizowanie obecnego kosztorysu pod kątem KOMPLETNOŚCI technologicznej.

=== POLECENIE OD TECHNOLOGA ===
${taskData.instruction}

=== AKTUALNE POZYCJE W KOSZTORYSIE (Co już wyciągnął Kosztorysant) ===
${JSON.stringify(currentEstimateState, null, 2)}

=== TWOJE ZADANIE ===
1. Przeanalizuj obecne pozycje kosztorysowe.
2. Porównaj je z wiedzą inżynieryjną: co MUSI zawierać budowa obiektu tego typu (np. przedszkole)?
3. Zidentyfikuj brakujące działy lub procesy poboczne, o których zapomniano w kosztorysie, a które są technologicznie niezbędne (np. wywiezienie ziemi przy wykopach, izolacja pionowa przy fundamentach, warstwy spadkowe na dachu płaskim, rusztowania przy tynkach zewnętrznych).
4. Jeśli dany proces jest wymagany, ale brak go w kosztorysie – zgłoś to jako lukę (GAP).

Użyj wyszukiwarki Google Search, aby zweryfikować standardowe technologie i kompletność robót (np. checklista robót stanu surowego dla przedszkoli).

Zwróć raport w formacie JSON z tablicą "quantityEstimates" (reprezentującą brakujące działy/luki zakresu):
- element: "Nazwa brakującego zakresu/procesu (np. Izolacja przeciwwilgociowa ław)"
- estimatedQuantity: 0 (Ustaw na 0 – nie zgadujemy cyfr, skupiamy się na samym fakcie braku pozycji!)
- unit: "j.m. właściwa dla elementu"
- calculationSteps: "Szczegółowe uzasadnienie inżynieryjne dlaczego ten proces jest niezbędny i gdzie Mózg powinien go szukać"
- indicatorSource: "Podstawa technologiczna / norma / KNR"
- confidence: Twoja pewność analizy 0-100
`;

        const result = await callGeminiWithRetry(() =>
            ai.models.generateContent({
                model: MODEL_FLASH,
                contents: searchPrompt,
                config: {
                    tools: [{ googleSearch: {} }],
                    temperature: 0.1,
                    responseMimeType: "application/json"
                }
            })
        );

        let totalTokensUsed = result.usageMetadata?.totalTokenCount || 0;

        let quantityEstimates: any[] = [];
        try {
            const parsed = JSON.parse(jsonrepair(result.text ?? "{}"));
            quantityEstimates = parsed.quantityEstimates || parsed.estimates || [];
        } catch (e) {
            console.error("[QUANTITY ESTIMATOR 📐] Błąd parsowania wyliczeń.");
        }

        await taskRef.update({
            status: "DONE",
            rawResult: {
                quantityEstimates,
                summary: `Wykonano przeliczenia inżynieryjne. Wygenerowano ${quantityEstimates.length} wskaźnikowych propozycji ilościowych dla Mózgu.`,
                recycledSectionsCount: currentEstimateState.length
            },
            processedByTechnolog: false,
            costTokens: totalTokensUsed,
            updatedAt: new Date()
        });

        const costUSD = (totalTokensUsed / 1000) * 0.000015;
        await adminDb.collection("tenders").doc(tenderId).update({ "budgetGuard.currentCostUSD": FieldValue.increment(costUSD) });

        isSuccess = true;
        return NextResponse.json({ success: true, estimatesCount: quantityEstimates.length });

    } catch (error: any) {
        console.error("[QUANTITY ESTIMATOR 📐] Błąd:", error);
        if (tenderId && taskId) {
            await adminDb.collection(`tenders/${tenderId}/technolog_tasks`).doc(taskId).update({
                status: "ERROR", rawResult: { error: error.message }, processedByTechnolog: false, updatedAt: new Date()
            }).catch(() => { });
        }
        return NextResponse.json({ error: error.message }, { status: 500 });
    } finally {
        if (tenderId && taskId) {
            const localOrigin = `http://localhost:${process.env.PORT || "3000"}`;
            fetch(`${localOrigin}/api/technolog/glowny-technolog`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ tenderId, trigger: isSuccess ? `TASK_COMPLETED_${taskId}` : `TASK_FAILED_${taskId}` })
            }).catch(() => { });
        }
    }
}