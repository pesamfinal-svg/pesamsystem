import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { FieldValue } from "firebase-admin/firestore";
import { GoogleGenAI } from "@google/genai";

export const dynamic = "force-dynamic";

const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
    location: "global"
});

export async function POST(req: Request) {
    let tenderId: string | undefined;
    let taskId: string | undefined;
    let isSuccess = false;

    try {
        const body = await req.json();
        tenderId = body.tenderId;
        taskId = body.taskId;

        console.log(`[BROKER 💰] Otrzymano żądanie POST. tenderId: ${tenderId}, taskId: ${taskId}`);

        if (!tenderId || !taskId) {
            console.error("[BROKER 💰] Błąd: Brak wymaganych parametrów tenderId lub taskId.");
            return NextResponse.json({ error: "Brak tenderId lub taskId" }, { status: 400 });
        }

        const taskRef = adminDb.collection(`tenders/${tenderId}/tasks`).doc(taskId);
        const taskDoc = await taskRef.get();

        if (!taskDoc.exists) {
            console.error(`[BROKER 💰] Zadanie o ID ${taskId} nie istnieje w bazie.`);
            throw new Error("Zadanie nie istnieje.");
        }

        const taskData = taskDoc.data()!;
        console.log(`[BROKER 💰] Wczytano dane zadania. Status w bazie: ${taskData.status}`);

        if (taskData.status !== "PENDING") {
            console.log(`[BROKER 💰] Zadanie ma już status ${taskData.status}. Przerywam przetwarzanie.`);
            return NextResponse.json({ message: "Zadanie już obsłużone." });
        }

        // Oznaczamy jako IN_PROGRESS
        console.log(`[BROKER 💰] Zmieniam status zadania na IN_PROGRESS.`);
        await taskRef.update({ status: "IN_PROGRESS", updatedAt: new Date() });

        const itemsToPrice = taskData.inputFacts?.items || [];
        console.log(`[BROKER 💰] Pobrano ${itemsToPrice.length} pozycji do wyceny z inputFacts.`);

        // Kompilujemy dynamiczny prompt rynkowy dla Google Search Grounding
        const prompt = `
Jesteś Ekspertem ds. Wycen i Szacowania Kosztów w Polsce.
Użyj narzędzia wyszukiwarki internetowej (Google Search), aby znaleźć aktualne, realne, średnie ceny rynkowe netto (w PLN) dla poniższych pozycji:

${JSON.stringify(itemsToPrice, null, 2)}

Twój cel:
${taskData.instruction}

Ważne zasady:
- Podawaj ceny rynkowe netto w PLN (bez VAT).
- Zwróć wynik jako poprawny obiekt JSON, pasujący dokładnie do struktury zdefiniowanej przez Mózg w instrukcji.
- Nie dodawaj żadnego dodatkowego tekstu ani znaczników markdown poza czystym JSON-em.
`;

        console.log("[BROKER 💰] Wysyłam zapytanie do Gemini z włączonym Google Search Grounding...");

        const result = await ai.models.generateContent({
            model: taskData.modelOverride || "gemini-2.5-flash", // Domyślnie używamy tańszego Flash
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            config: {
                tools: [{ googleSearch: {} }], // Standard 2: Narzędzia zawsze wewnątrz config
                temperature: 0.1,
                responseMimeType: "application/json"
            }
        });

        console.log("[BROKER 💰] Odebrano odpowiedź z Gemini. Parsuję wynik JSON...");
        const rawResult = JSON.parse(result.text ?? "{}");
        const tokensUsed = result.usageMetadata?.totalTokenCount || 0;
        console.log(`[BROKER 💰] Zużyto tokenów: ${tokensUsed}. Zapisuję rawResult w bazie.`);

        // Aktualizujemy zadanie jako DONE
        await taskRef.update({
            status: "DONE",
            rawResult: rawResult,
            processedByBrain: false,
            costTokens: tokensUsed,
            updatedAt: new Date()
        });

        // Koszt tokenów (Flash: ~$0.000015 / 1k, Pro: ~$0.002 / 1k)
        const costPerThousand = (taskData.modelOverride === "gemini-2.5-pro") ? 0.002 : 0.000015;
        const costUSD = (tokensUsed / 1000) * costPerThousand;

        console.log(`[BROKER 💰] Naliczyłem koszt wykonania zadania: ${costUSD.toFixed(6)} USD. Aktualizuję Budget Guard.`);
        await adminDb.collection("tenders").doc(tenderId).update({
            "budgetGuard.currentCostUSD": FieldValue.increment(costUSD)
        });

        isSuccess = true;
        console.log(`[BROKER 💰] Zadanie ukończone sukcesem.`);
        return NextResponse.json({ success: true });

    } catch (error: any) {
        console.error("[BROKER 💰] ❌ Błąd krytyczny w brokerze cenowym:", error);
        if (tenderId && taskId) {
            console.log("[BROKER 💰] Zapisuję status błędu (ERROR) do zadania w bazie.");
            await adminDb.collection(`tenders/${tenderId}/tasks`).doc(taskId).update({
                status: "ERROR",
                rawResult: { error: error.message },
                processedByBrain: false,
                updatedAt: new Date()
            }).catch((dbErr) => console.error("[BROKER 💰] Nie udało się zapisać błędu do Firestore:", dbErr));
        }
        return NextResponse.json({ error: error.message }, { status: 500 });

    } finally {
        // Gwarancja wybudzenia Mózgu (zawsze w finally)
        if (tenderId && taskId) {
            const localOrigin = `http://127.0.0.1:${process.env.PORT || "3000"}`;
            console.log(`[BROKER 💰] Wybudzam Mózg przez loopback na adresie: ${localOrigin}`);
            fetch(`${localOrigin}/api/kosztorysant/glowny-kosztorysant`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    tenderId,
                    trigger: isSuccess ? `TASK_COMPLETED_${taskId}` : `TASK_FAILED_${taskId}`
                })
            }).catch((fetchErr) => console.error("[BROKER 💰] Błąd wybudzania Mózgu przez fetch:", fetchErr));
        }
    }
}