// ============================================================
// PESAM 3.0 – Agent Specjalista: PYTHON_CALC (Matematyk / Geometra)
// POST /api/kosztorysant/agent-python-calc
// ============================================================

import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { FieldValue } from "firebase-admin/firestore";
import { GoogleGenAI, Type } from "@google/genai";

export const dynamic = "force-dynamic";

// Standard 3 & 4: Inicjalizacja klienta Google GenAI (Vertex AI, global)
const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
    location: "global"
});

const MODEL_PRO = "gemini-2.5-pro"; // Wymagany do zaawansowanego kodowania w Pythonie
const MODEL_FLASH = "gemini-2.5-flash"; // Do taniego formatowania JSON

// Schemat dla Kroku 2 (Strukturyzacja wyników)
const MATH_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        calculations: {
            type: Type.ARRAY,
            description: "Lista wykonanych obliczeń.",
            items: {
                type: Type.OBJECT,
                properties: {
                    opis: { type: Type.STRING, description: "Co zostało policzone, np. 'Objętość betonu ław fundamentowych'" },
                    wynik: { type: Type.NUMBER, description: "Dokładny wynik liczbowy (zawsze jako liczba)" },
                    jednostka: { type: Type.STRING, description: "Jednostka miary, np. 'm3', 'kg', 'm2'" }
                },
                required: ["opis", "wynik", "jednostka"]
            }
        },
        summary: {
            type: Type.STRING,
            description: "Krótkie podsumowanie wykonanych operacji matematycznych."
        }
    },
    required: ["calculations", "summary"]
};

export async function POST(req: Request) {
    // Bezpieczna deklaracja zmiennych (ochrona przed błędem strumienia w catch)
    let tenderId: string | undefined;
    let taskId: string | undefined;

    try {
        const body = await req.json();
        tenderId = body.tenderId;
        taskId = body.taskId;

        if (!tenderId || !taskId) {
            return NextResponse.json({ error: "Brak tenderId lub taskId" }, { status: 400 });
        }

        console.log(`[PESAM 3.0 🧮] PYTHON_CALC wybudzony. Przetarg: ${tenderId} | Zadanie: ${taskId}`);

        const taskRef = adminDb.collection(`tenders/${tenderId}/tasks`).doc(taskId);
        const taskDoc = await taskRef.get();

        if (!taskDoc.exists) throw new Error("Zadanie nie istnieje.");

        const taskData = taskDoc.data()!;

        // Idempotentność
        if (taskData.status !== "PENDING") {
            console.log(`[PESAM 3.0 🧮] Zadanie ${taskId} ma status ${taskData.status}. Pomijam.`);
            return NextResponse.json({ message: "Task already processed." });
        }

        // 1. Oznaczamy zadanie jako IN_PROGRESS
        await taskRef.update({ status: "IN_PROGRESS", updatedAt: new Date() });

        let totalTokensUsedPro = 0;
        let totalTokensUsedFlash = 0;

        // ====================================================================
        // STANDARD 2: KROK 1 - OBLICZENIA (Python Code Execution, BEZ JSON)
        // ====================================================================
        const calcPrompt = `
Jesteś Głównym Geometrą i Matematykiem w systemie PESAM 3.0.
Twoje zadanie: ${taskData.description}

Użyj narzędzia Code Execution (Python), aby wykonać absolutnie bezbłędne obliczenia.
Pamiętaj o:
- Przeliczaniu jednostek (np. cm na m).
- Używaniu dokładnych wzorów geometrycznych (np. pole koła, objętość ostrosłupa).
- Zwróceniu ostatecznych wyników w czytelnym tekście (co policzyłeś, jaki jest wynik, jaka jednostka).
`;

        console.log(`[PESAM 3.0 🧮] Uruchamiam środowisko Python dla zadania ${taskId}...`);

        const calcResult = await ai.models.generateContent({
            model: MODEL_PRO,
            contents: [{ role: "user", parts: [{ text: calcPrompt }] }],
            config: {
                tools: [{ codeExecution: {} }] // Standard 2: Narzędzia zawsze wewnątrz obiektu config!
            }
        });

        const calcContext = calcResult.text ?? "";
        totalTokensUsedPro += calcResult.usageMetadata?.totalTokenCount || 0;

        console.log(`[PESAM 3.0 🧮] Obliczenia zakończone. Formatuję wyniki...`);

        // ====================================================================
        // STANDARD 2: KROK 2 - STRUKTURYZACJA (JSON Schema, BEZ NARZĘDZI)
        // ====================================================================
        const structurePrompt = `
Na podstawie poniższego raportu z obliczeń matematycznych, wyodrębnij wyniki do formatu JSON.
Zwróć TYLKO poprawny obiekt JSON.

Raport z obliczeń:
${calcContext}
`;
        const structureResult = await ai.models.generateContent({
            model: MODEL_FLASH,
            contents: [{ role: "user", parts: [{ text: structurePrompt }] }],
            config: {
                temperature: 0.1,
                responseMimeType: "application/json",
                responseSchema: MATH_SCHEMA as any
            }
        });

        const parsedResult = JSON.parse(structureResult.text ?? "{}");
        totalTokensUsedFlash += structureResult.usageMetadata?.totalTokenCount || 0;

        // 2. Zapis wyników do bazy (Aktualizacja Zadania)
        const batch = adminDb.batch();

        // Matematyk nie zapisuje bezpośrednio do 'estimate'. 
        // Zwraca wynik do 'tasks', aby agent zlecający (np. VISION) lub Mózg mógł go użyć.
        batch.update(taskRef, {
            status: "DONE",
            result: {
                calculations: parsedResult.calculations || [],
                summary: parsedResult.summary
            },
            costTokens: totalTokensUsedPro + totalTokensUsedFlash,
            updatedAt: new Date()
        });

        // 3. Aktualizacja Budget Guard
        // Pro: ~$0.002 / 1k tokenów | Flash: ~$0.000015 / 1k tokenów
        const costUSD = (totalTokensUsedPro / 1000) * 0.002 + (totalTokensUsedFlash / 1000) * 0.000015;
        const tenderRef = adminDb.collection("tenders").doc(tenderId);
        batch.update(tenderRef, {
            "budgetGuard.currentCostUSD": FieldValue.increment(costUSD)
        });

        await batch.commit();
        console.log(`[PESAM 3.0 🧮] Zadanie ${taskId} zakończone. Wykonano ${parsedResult.calculations?.length || 0} obliczeń.`);

        // 4. Wybudzenie Mózgu (ReAct Loop kontynuuje działanie)
        const origin = new URL(req.url).origin;
        fetch(`${origin}/api/kosztorysant/glowny-kosztorysant`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tenderId, trigger: `TASK_COMPLETED_${taskId}` })
        }).catch(e => console.error("[PESAM 3.0] Błąd wybudzania Mózgu po obliczeniach:", e));

        return NextResponse.json({ success: true, calculations: parsedResult.calculations });

    } catch (error: any) {
        console.error("[PESAM 3.0 🧮] ❌ Błąd krytyczny Agenta Matematyka:", error);

        if (tenderId && taskId) {
            try {
                await adminDb.collection(`tenders/${tenderId}/tasks`).doc(taskId).update({
                    status: "ERROR",
                    result: { error: error.message }
                });
            } catch (dbError) {
                console.error("[PESAM 3.0 🧮] Nie udało się zapisać statusu ERROR do bazy:", dbError);
            }
        }

        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}