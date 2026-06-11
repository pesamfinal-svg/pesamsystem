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

        if (!tenderId || !taskId) {
            return NextResponse.json({ error: "Brak tenderId lub taskId" }, { status: 400 });
        }

        console.log(`[MATEMATYK 🧮] Startuję. Przetarg: ${tenderId} | Zadanie: ${taskId}`);

        const taskRef = adminDb.collection(`tenders/${tenderId}/tasks`).doc(taskId);
        const taskDoc = await taskRef.get();

        if (!taskDoc.exists) throw new Error("Zadanie nie istnieje.");
        const taskData = taskDoc.data()!;

        if (taskData.status !== "PENDING") {
            return NextResponse.json({ message: "Zadanie już obsłużone." });
        }

        await taskRef.update({ status: "IN_PROGRESS", updatedAt: new Date() });

        // Kompilujemy prompt z dynamicznej instrukcji od Mózgu i przekazanych faktów
        const prompt = `
Jesteś Matematykiem i Geometrą. Masz dostęp do środowiska Python (narzędzie Code Execution).
Oto dane wejściowe przekazane przez Mózg: ${JSON.stringify(taskData.inputFacts || {})}

Twoje zadanie:
${taskData.instruction}

Ważne zasady:
- Do wszystkich obliczeń używaj Pythona (codeExecution), aby wyeliminować błędy halucynacji liczb.
- Zwróć wynik jako poprawny obiekt JSON, pasujący strukturą do wymagań Mózgu opisanych w instrukcji.
- Nie zwracaj żadnego tekstu poza czystym JSON-em.
`;

        const result = await ai.models.generateContent({
            model: taskData.modelOverride || "gemini-2.5-pro", // Mózg decyduje, czy użyć tańszego Flash czy Pro
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            config: {
                tools: [{ codeExecution: {} }], // Zostawiamy włączone środowisko uruchomieniowe Pythona
                temperature: 0.1,
                responseMimeType: "application/json"
            }
        });

        const rawResult = JSON.parse(result.text ?? "{}");
        const tokensUsed = result.usageMetadata?.totalTokenCount || 0;

        await taskRef.update({
            status: "DONE",
            rawResult: rawResult,
            processedByBrain: false,
            costTokens: tokensUsed,
            updatedAt: new Date()
        });

        // Koszt tokenów dla modelu Pro: ~$0.002 / 1k, dla Flash: ~$0.000015 / 1k
        const costPerThousand = (taskData.modelOverride === "gemini-2.5-pro") ? 0.002 : 0.000015;
        const costUSD = (tokensUsed / 1000) * costPerThousand;

        await adminDb.collection("tenders").doc(tenderId).update({
            "budgetGuard.currentCostUSD": FieldValue.increment(costUSD)
        });

        isSuccess = true;
        console.log(`[MATEMATYK 🧮] Zadanie ukończone sukcesem.`);
        return NextResponse.json({ success: true });

    } catch (error: any) {
        console.error("[MATEMATYK 🧮] ❌ Błąd:", error);
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
        // Gwarancja wybudzenia Mózgu - zawsze wywoływana, nawet po crashu!
        if (tenderId && taskId) {
            const localOrigin = `http://127.0.0.1:${process.env.PORT || "3000"}`;
            fetch(`${localOrigin}/api/kosztorysant/glowny-kosztorysant`, {
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