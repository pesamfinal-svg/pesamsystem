import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { FieldValue } from "firebase-admin/firestore";
import { GoogleGenAI, Type } from "@google/genai";
import dns from "dns";
dns.setDefaultResultOrder("ipv4first"); // Zapewnienie stabilności IPv4

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
            console.warn(`[GAP FILLER 🧩] Limit 429. Odczekuję ${delay / 1000}s... (Zostało prób: ${retries})`);
            await new Promise(resolve => setTimeout(resolve, delay));
            return callGeminiWithRetry(fn, retries - 1, delay * 2);
        }
        throw error;
    }
}

const GAP_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        estimatedItems: {
            type: Type.ARRAY,
            description: "Lista oszacowanych pozycji wskaźnikowych rynkowych.",
            items: {
                type: Type.OBJECT,
                properties: {
                    pozycja: { type: Type.STRING, description: "Nazwa brakującej branży lub elementu" },
                    opis: { type: Type.STRING, description: "Uzasadnienie rynkowe oszacowanego wskaźnika" },
                    ilosc: { type: Type.NUMBER, description: "Ilość wskaźnikowa" },
                    jednostka: { type: Type.STRING, description: "Jednostka miary, np. m2, kpl, ryczałt" },
                    KNR_ref: { type: Type.STRING, description: "Zawsze 'WSKAŹNIK_RYNKOWY'" }
                },
                required: ["pozycja", "opis", "ilosc", "jednostka", "KNR_ref"]
            }
        },
        summary: { type: Type.STRING, description: "Krótkie podsumowanie." }
    },
    required: ["estimatedItems", "summary"]
};

export async function POST(req: Request) {
    let tenderId: string | undefined;
    let taskId: string | undefined;
    let isSuccess = false;

    try {
        const body = await req.json();
        tenderId = body.tenderId;
        taskId = body.taskId;

        console.log(`[GAP FILLER 🧩] Start. tenderId: ${tenderId}, taskId: ${taskId}`);

        if (!tenderId || !taskId) return NextResponse.json({ error: "Brak danych" }, { status: 400 });

        const taskRef = adminDb.collection(`tenders/${tenderId}/tasks`).doc(taskId);
        const taskDoc = await taskRef.get();
        if (!taskDoc.exists) throw new Error("Zadanie nie istnieje.");

        const taskData = taskDoc.data()!;
        if (taskData.status !== "PENDING") return NextResponse.json({ message: "Zadanie obsłużone." });

        await taskRef.update({ status: "IN_PROGRESS", updatedAt: new Date() });

        const objectType = taskData.inputFacts?.objectType || "Obiekt budowlany";
        const missingScope = taskData.inputFacts?.missingScope || "Brakująca branża";

        // KROK 1: Wyszukiwanie rynkowe z Google Search (Bez schema JSON, zwraca surowy raport tekstowy)
        console.log("[GAP FILLER 🧩] KROK 1: Szukanie wskaźników cenowych w sieci za pomocą Google Search...");
        const searchPrompt = `
Wyceniamy projekt budowy obiektu: ${objectType}.
W dokumentacji brakuje precyzyjnych rysunków dla zakresu: "${missingScope}".

Zadanie: ${taskData.instruction}

Użyj wyszukiwarki Google Search, aby znaleźć aktualne (2025/2026 r.) wskaźniki cenowe Sekocenbud, GUS lub średnie rynkowe stawki wykonawcze w Polsce za m2, mb lub ryczałt dla zakresu: "${missingScope}".
Napisz szczegółowy, techniczny raport z wyceny wskaźnikowej.
`;

        const searchResult = await callGeminiWithRetry(async () => {
            return await ai.models.generateContent({
                model: MODEL_FLASH,
                contents: searchPrompt,
                config: {
                    tools: [{ googleSearch: {} }],
                    temperature: 0.1
                }
            });
        });

        const rawReport = searchResult.text ?? "";
        let totalTokensUsed = searchResult.usageMetadata?.totalTokenCount || 0;
        console.log(`[GAP FILLER 🧩] Krok 1 ukończony. Pobrano raport rynkowy.`);

        // KROK 2: Strukturyzacja na JSON (Z responseSchema, bez Google Search!)
        console.log("[GAP FILLER 🧩] KROK 2: Porządkowanie danych i nakładanie struktury JSON...");
        const structurePrompt = `
Na podstawie poniższego raportu z wyceny wskaźnikowej, wyodrębnij pozycje kosztorysowe zgodnie z narzuconym schematem JSON.

Raport wyceny:
${rawReport}
`;

        const structureResult = await callGeminiWithRetry(async () => {
            return await ai.models.generateContent({
                model: MODEL_FLASH,
                contents: structurePrompt,
                config: {
                    temperature: 0.1,
                    responseMimeType: "application/json",
                    responseSchema: GAP_SCHEMA as any
                }
            });
        });

        const parsedResult = JSON.parse(structureResult.text ?? "{}");
        totalTokensUsed += structureResult.usageMetadata?.totalTokenCount || 0;

        await taskRef.update({
            status: "DONE",
            rawResult: parsedResult,
            processedByBrain: false,
            costTokens: totalTokensUsed,
            updatedAt: new Date()
        });

        const costUSD = (totalTokensUsed / 1000) * 0.000015;
        await adminDb.collection("tenders").doc(tenderId).update({
            "budgetGuard.currentCostUSD": FieldValue.increment(costUSD)
        });

        isSuccess = true;
        console.log("[GAP FILLER 🧩] Zakończono sukcesem (Ominięto konflikt Google 400).");
        return NextResponse.json({ success: true });

    } catch (error: any) {
        console.error("[GAP FILLER 🧩] ❌ Błąd:", error);
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
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ tenderId, trigger: isSuccess ? `TASK_COMPLETED_${taskId}` : `TASK_FAILED_${taskId}` })
            }).catch(() => { });
        }
    }
}