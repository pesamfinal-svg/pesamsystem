import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { FieldValue } from "firebase-admin/firestore";
import { GoogleGenAI, Type } from "@google/genai";

export const dynamic = "force-dynamic";

const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
    location: "global"
});

const MODEL_PRO = "gemini-2.5-pro"; // Judicial reasoning and conflict resolution requires high-level logic (Pro model)

// Schemat ustrukturyzowanego wyjścia wyroków
const JUDGE_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        resolutions: {
            type: Type.ARRAY,
            description: "Lista rozstrzygniętych spraw spornych.",
            items: {
                type: Type.OBJECT,
                properties: {
                    conflictId: { type: Type.STRING, description: "Unikalny identyfikator konfliktu przekazany przez Mózg." },
                    decision: { type: Type.STRING, description: "Wybrana ostateczna wartość, technologia lub rozstrzygnięcie." },
                    justification: { type: Type.STRING, description: "Uzasadnienie oparte na hierarchii dokumentów, Prawie Budowlanym, PZP lub WT 2021." },
                    escalateToUser: { type: Type.BOOLEAN, description: "Ustaw na true, jeśli konflikt jest krytyczny finansowo lub niemożliwy do pogodzenia bez decyzji Kosztorysanta." }
                },
                required: ["conflictId", "decision", "justification", "escalateToUser"]
            }
        },
        summary: { type: Type.STRING, description: "Krótkie podsumowanie wydanych wyroków dla Mózgu." }
    },
    required: ["resolutions", "summary"]
};

export async function POST(req: Request) {
    let tenderId: string | undefined;
    let taskId: string | undefined;
    let isSuccess = false;

    try {
        const body = await req.json();
        tenderId = body.tenderId;
        taskId = body.taskId;

        console.log(`[SĘDZIA ⚖️] Otrzymano żądanie POST. tenderId: ${tenderId}, taskId: ${taskId}`);

        if (!tenderId || !taskId) {
            console.error("[SĘDZIA ⚖️] Błąd: Brak wymaganych parametrów tenderId lub taskId.");
            return NextResponse.json({ error: "Brak danych" }, { status: 400 });
        }

        const taskRef = adminDb.collection(`tenders/${tenderId}/tasks`).doc(taskId);
        const taskDoc = await taskRef.get();

        if (!taskDoc.exists) {
            console.error(`[SĘDZIA ⚖️] Zadanie o ID ${taskId} nie istnieje w bazie.`);
            throw new Error("Zadanie nie istnieje.");
        }

        const taskData = taskDoc.data()!;
        console.log(`[SĘDZIA ⚖️] Wczytano zadanie. Status w bazie: ${taskData.status}`);

        if (taskData.status !== "PENDING") {
            console.log(`[SĘDZIA ⚖️] Zadanie ma status ${taskData.status}. Przerywam.`);
            return NextResponse.json({ message: "Zadanie już obsłużone." });
        }

        // Zmiana statusu na IN_PROGRESS
        console.log("[SĘDZIA ⚖️] Zmieniam status zadania na IN_PROGRESS.");
        await taskRef.update({ status: "IN_PROGRESS", updatedAt: new Date() });

        // Pobieramy konflikty przekazane przez Mózg w inputFacts
        const conflictsToResolve = taskData.inputFacts?.conflicts || [];
        console.log(`[SĘDZIA ⚖️] Pobrano ${conflictsToResolve.length} spraw spornych do rozpatrzenia.`);

        if (conflictsToResolve.length === 0) {
            console.warn("[SĘDZIA ⚖️] Brak konfliktów w inputFacts. Kończę zadanie bez wyroku.");
            await taskRef.update({
                status: "DONE",
                rawResult: { resolutions: [], summary: "Brak spraw spornych do rozstrzygnięcia." },
                processedByBrain: false,
                updatedAt: new Date()
            });
            isSuccess = true;
            return NextResponse.json({ message: "Brak konfliktów." });
        }

        // Przygotowujemy opis spraw spornych dla LLM
        const casesDescription = conflictsToResolve.map((c: any, index: number) => {
            const partiesText = (c.parties || []).map((p: any) =>
                `- Agent: ${p.agent} | Twierdzi: "${p.claim}" | Źródło: ${p.sourceDoc}`
            ).join("\n");

            return `
Sprawa #${index + 1} (ConflictId: ${c.id})
Temat sporu: ${c.topic}
Stanowiska stron:
${partiesText}
`;
        }).join("\n");

        // Kompilujemy prompt prawno-inżynieryjny z wyszukiwarką
        const prompt = `
Jesteś Głównym Sędzią i Rewidentem technicznym w systemie kosztorysowym PESAM 3.0.
Rozpatrujesz spory technologiczne i interpretacyjne między agentami analizującymi projekt budowlany.

Oto wykaz spraw do rozstrzygnięcia:
${casesDescription}

Twoje polecenie od Mózgu:
${taskData.instruction}

Zasady orzekania:
1. Użyj wyszukiwarki Google Search, aby zweryfikować standardy budowlane, prawo zamówień publicznych (PZP) czy polskie normy inżynieryjne.
2. Zastosuj ogólnie przyjęte zasady (np. rysunki konstrukcyjne są ważniejsze niż opisy w SWZ, a projekt budowlany/wykonawczy jest nadrzędny nad PFU).
3. Dla każdej sprawy spornej wydaj jasne, jednoznaczne rozstrzygnięcie techniczne lub prawne oraz je rzetelnie uzasadnij.
4. Jeśli sprawa jest bardzo skomplikowana lub niesie ryzyko wysokich kosztów, ustaw 'escalateToUser' na true.
5. Zwróć wynik jako poprawny obiekt JSON, pasujący dokładnie do zdefiniowanego schematu.
6. Nie dodawaj żadnego innego tekstu poza czystym JSON-em.
`;

        console.log("[SĘDZIA ⚖️] Uruchamiam proces analizy sądowej w Gemini Pro z włączonym Google Search...");

        const result = await ai.models.generateContent({
            model: taskData.modelOverride || MODEL_PRO, // Sędzia zawsze powinien używać Pro
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            config: {
                tools: [{ googleSearch: {} }], // Grounding orzeczniczy i prawny
                temperature: 0.1,
                responseMimeType: "application/json",
                responseSchema: JUDGE_SCHEMA as any
            }
        });

        console.log("[SĘDZIA ⚖️] Odebrano wyrok z Gemini Pro. Parsuję JSON...");
        const parsedResult = JSON.parse(result.text ?? "{}");
        const tokensUsed = result.usageMetadata?.totalTokenCount || 0;
        console.log(`[SĘDZIA ⚖️] Wyroki wydane. Zużyto tokenów: ${tokensUsed}. Zapisuję rawResult.`);

        // Zapisujemy wyroki bezpośrednio do rawResult i oznaczamy zadanie jako DONE
        await taskRef.update({
            status: "DONE",
            rawResult: parsedResult,
            processedByBrain: false,
            costTokens: tokensUsed,
            updatedAt: new Date()
        });

        // Koszt tokenów (Pro: ~$0.002 / 1k)
        const costUSD = (tokensUsed / 1000) * 0.002;

        console.log(`[SĘDZIA ⚖️] Koszt tokenów: ${costUSD.toFixed(6)} USD. Aktualizuję Budget Guard.`);
        await adminDb.collection("tenders").doc(tenderId).update({
            "budgetGuard.currentCostUSD": FieldValue.increment(costUSD)
        });

        isSuccess = true;
        console.log("[SĘDZIA ⚖️] Wszystkie sprawy sporne zostały rozstrzygnięte.");
        return NextResponse.json({ success: true });

    } catch (error: any) {
        console.error("[SĘDZIA ⚖️] ❌ Błąd krytyczny w agencie sędziowskim:", error);
        if (tenderId && taskId) {
            console.log("[SĘDZIA ⚖️] Zapisuję status błędu (ERROR) do bazy.");
            await adminDb.collection(`tenders/${tenderId}/tasks`).doc(taskId).update({
                status: "ERROR",
                rawResult: { error: error.message },
                processedByBrain: false,
                updatedAt: new Date()
            }).catch((dbErr) => console.error("[SĘDZIA ⚖️] Błąd zapisu błędu do Firestore:", dbErr));
        }
        return NextResponse.json({ error: error.message }, { status: 500 });

    } finally {
        // Gwarancja wybudzenia Mózgu
        if (tenderId && taskId) {
            const localOrigin = `http://127.0.0.1:${process.env.PORT || "3000"}`;
            console.log(`[SĘDZIA ⚖️] Wybudzam Mózg przez loopback: ${localOrigin}`);
            fetch(`${localOrigin}/api/kosztorysant/glowny-kosztorysant`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    tenderId,
                    trigger: isSuccess ? `TASK_COMPLETED_${taskId}` : `TASK_FAILED_${taskId}`
                })
            }).catch((fetchErr) => console.error("[SĘDZIA ⚖️] Błąd wybudzania Mózgu przez fetch:", fetchErr));
        }
    }
}