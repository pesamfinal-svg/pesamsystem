import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { FieldValue } from "firebase-admin/firestore";
import { GoogleGenAI, Type } from "@google/genai";
import { randomUUID } from "crypto";
import dns from "dns";
dns.setDefaultResultOrder("ipv4first");

export const dynamic = "force-dynamic";

const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
    location: "global"
});

const MODEL_FLASH = "gemini-2.5-flash";

async function callGeminiWithRetry(fn: () => Promise<any>, retries = 5, delay = 5000): Promise<any> {
    try {
        return await fn();
    } catch (error: any) {
        const errorText = error.toString() || "";
        const isRateLimit = errorText.includes("429") || errorText.includes("RESOURCE_EXHAUSTED");
        if (isRateLimit && retries > 0) {
            console.warn(`[BROKER 💰] Limit 429. Odczekuję ${delay / 1000}s...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            return callGeminiWithRetry(fn, retries - 1, delay * 2);
        }
        throw error;
    }
}

const BROKER_RMS_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        prices: {
            type: Type.ARRAY,
            description: "Odłowiona paleta wycen dla hurtownego lub parametrycznie wykonanego składu rynków (Polska).",
            items: {
                type: Type.OBJECT,
                properties: {
                    id: { type: Type.STRING },
                    R_KosztNetto: { type: Type.NUMBER, description: "Taryfikacja Pracy i brygady [Robocizna na 1 JEDNOSTKĘ] zł" },
                    M_KosztHurtowyNetto: { type: Type.NUMBER, description: "B2B [Materiał]: Czysto materiał bez prac narzutowych z katalogów KNR" },
                    S_KosztSprzetuNetto: { type: Type.NUMBER, description: "[Sprzęt ciężki lub elektronarzedzi do tego procesu]" },
                    bazaCennikowZrodla: { type: Type.STRING, description: "Link lub krótka adnotacja katalogu norm dla audytu." }
                },
                required: ["id", "R_KosztNetto", "M_KosztHurtowyNetto", "S_KosztSprzetuNetto", "bazaCennikowZrodla"]
            }
        }
    },
    required: ["prices"]
};

export async function POST(req: Request) {
    let tenderId: string | undefined;
    let taskId: string | undefined;
    let isSuccess = false;

    try {
        const body = await req.json();
        tenderId = body.tenderId;
        taskId = body.taskId;

        console.log(`[BROKER 💰] Start. tenderId: ${tenderId}, taskId: ${taskId}`);

        if (!tenderId || !taskId) return NextResponse.json({ error: "Brak Danych" }, { status: 400 });

        const taskRef = adminDb.collection(`tenders/${tenderId}/tasks`).doc(taskId);
        const taskDoc = await taskRef.get();
        if (!taskDoc.exists) throw new Error("Zadanie nie istnieje.");

        const taskData = taskDoc.data()!;
        if (taskData.status !== "PENDING") return NextResponse.json({ message: "Zadanie już obsłużone." });

        await taskRef.update({ status: "IN_PROGRESS", updatedAt: new Date() });

        const estimateRef = adminDb.collection(`tenders/${tenderId}/estimate`);
        const sectionsSnap = await estimateRef.where("status", "==", "QUANTITY_READY").get();

        if (sectionsSnap.empty) {
            await taskRef.update({ status: "DONE", rawResult: { message: "Brak sekcji do wyceny." }, processedByBrain: false, updatedAt: new Date() });
            isSuccess = true;
            return NextResponse.json({ message: "Sekcje Empty!" });
        }

        let totalTokensUsed = 0;
        let pricedItemsCount = 0;
        const globalBatch = adminDb.batch();

        for (const sectionDoc of sectionsSnap.docs) {
            const sectionId = sectionDoc.id;
            const itemsSnap = await estimateRef.doc(sectionId).collection("items").get();
            const itemsInDB = itemsSnap.docs.map(d => ({ dbId: d.id, ...d.data() }));

            if (itemsInDB.length === 0) continue;

            const searchQueryInput = itemsInDB.map((i: any) =>
                `Dok_ID: ${i.dbId} | Norma/Typ: ${i.KNR_ref || i.pozycja} | Robota Inż.: ${i.opis.substring(0, 60)} | Unit: ${i.jednostka}`
            ).join("\n");

            // KROK 1: Szukanie cen w sieci (Surowy tekst)
            console.log("[BROKER 💰] KROK 1: Przeszukiwanie sieci (Google Search)...");
            const searchPrompt = `
Jesteś Brokerem Wycen w sieci Polskich Dystrybucji Norm / Używającym B2B standardu rynkowego.
Użyj wyszukiwarki Google Search, aby znaleźć aktualne rynkowe stawki wykonawcze (Robocizna, Materiały, Sprzęt) w Polsce dla pozycji:
${searchQueryInput}

Zadanie: ${taskData.instruction}

Napisz szczegółowy raport cenowy rynkowy dla każdej pozycji.
`;

            const searchResult = await callGeminiWithRetry(async () => {
                return await ai.models.generateContent({
                    model: taskData.modelOverride || MODEL_FLASH,
                    contents: searchPrompt,
                    config: {
                        tools: [{ googleSearch: {} }],
                        temperature: 0.1
                    }
                });
            });

            const rawReport = searchResult.text ?? "";
            totalTokensUsed += searchResult.usageMetadata?.totalTokenCount || 0;

            // KROK 2: Strukturyzacja cen na JSON (Bez Search)
            console.log("[BROKER 💰] KROK 2: Strukturyzacja wycen na JSON...");
            const structurePrompt = `
Na podstawie poniższego raportu z badania cen rynkowych, wyodrębnij wyceny i sformatuj je zgodnie ze schematem JSON.

Raport z cenami:
${rawReport}
`;

            const structureResult = await callGeminiWithRetry(async () => {
                return await ai.models.generateContent({
                    model: MODEL_FLASH,
                    contents: structurePrompt,
                    config: {
                        temperature: 0.1,
                        responseMimeType: "application/json",
                        responseSchema: BROKER_RMS_SCHEMA as any
                    }
                });
            });

            const structuredResponses = JSON.parse(structureResult.text ?? "{}");
            totalTokensUsed += structureResult.usageMetadata?.totalTokenCount || 0;

            const responseMapDict = new Map<string, any>(
                (structuredResponses.prices || []).map((bData: any) => [bData.id, bData])
            );

            let calculatedTotalValue = 0;

            for (const itemDBCache of itemsSnap.docs) {
                const liveObj = itemDBCache.data();
                const fetchedAgentBreak = responseMapDict.get(itemDBCache.id) || null;

                if (fetchedAgentBreak) {
                    const jnTotNetto = (Number(fetchedAgentBreak.R_KosztNetto) || 0) + (Number(fetchedAgentBreak.M_KosztHurtowyNetto) || 0) + (Number(fetchedAgentBreak.S_KosztSprzetuNetto) || 0);
                    calculatedTotalValue += (Number(liveObj.ilosc) || 0) * jnTotNetto;

                    const modifiedDescription = `${liveObj.opis || ""} | [WYCENA WSK. HURT RMS/B2B: R:${fetchedAgentBreak.R_KosztNetto || 0}zł / M:${fetchedAgentBreak.M_KosztHurtowyNetto || 0}zł / S:${fetchedAgentBreak.S_KosztSprzetuNetto || 0}zł | Z:(Goo Search Baza -> ${fetchedAgentBreak.bazaCennikowZrodla})].`;

                    globalBatch.update(itemDBCache.ref, {
                        cenaJed: jnTotNetto,
                        opis: modifiedDescription,
                        confidence: "HIGH",
                        sourceTrack: `${liveObj.sourceTrack || "Z narzuta B2B"} 💰 Pieniądze B2B`
                    });
                    pricedItemsCount++;
                }
            }

            globalBatch.update(sectionDoc.ref, {
                totalValue: calculatedTotalValue,
                status: "PRICED",
                updatedAt: new Date()
            });
        }

        globalBatch.update(taskRef, {
            status: "DONE",
            rawResult: { pricedOutQuant: pricedItemsCount },
            processedByBrain: false,
            costTokens: totalTokensUsed,
            updatedAt: new Date()
        });

        const costToDBStore = (totalTokensUsed / 1000) * 0.000015;
        globalBatch.update(adminDb.collection("tenders").doc(tenderId), { "budgetGuard.currentCostUSD": FieldValue.increment(costToDBStore) });

        await globalBatch.commit();
        isSuccess = true;
        console.log("[BROKER 💰] Sukces.");
        return NextResponse.json({ success: true, billedItemZ: pricedItemsCount });

    } catch (errx: any) {
        console.error("[BROKER 💰] ❌ Błąd:", errx);
        if (tenderId && taskId) {
            await adminDb.collection(`tenders/${tenderId}/tasks`).doc(taskId).update({
                status: "ERROR", rawResult: { error: errx.message }, processedByBrain: false, updatedAt: new Date()
            }).catch(() => { });
        }
        return NextResponse.json({ error: errx.message }, { status: 500 });
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