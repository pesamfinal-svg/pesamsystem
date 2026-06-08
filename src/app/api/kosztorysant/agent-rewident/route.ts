// ============================================================
// PESAM 3.0 – Agent Specjalista: REVISOR_JUDGE (Sędzia / Rewident)
// POST /api/kosztorysant/agent-rewident
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

const MODEL_PRO = "gemini-2.5-pro"; // Sędzia potrzebuje najwyższej logiki
const MODEL_FLASH = "gemini-2.5-flash"; // Do taniego formatowania JSON

// Schemat dla Kroku 2 (Strukturyzacja Wyroku)
const JUDGE_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        decision: {
            type: Type.STRING,
            description: "Wybrana wartość (np. 'C25/30') lub informacja o braku rozstrzygnięcia."
        },
        justification: {
            type: Type.STRING,
            description: "Uzasadnienie wyroku, np. 'Zgodnie z Prawem Budowlanym, rysunek konstrukcyjny jest nadrzędny nad opisem ogólnym SWZ.'"
        },
        escalateToUser: {
            type: Type.BOOLEAN,
            description: "Ustaw na true, jeśli sprzeczność jest krytyczna i wymaga ręcznej decyzji Kosztorysanta."
        }
    },
    required: ["decision", "justification", "escalateToUser"]
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

        console.log(`[PESAM 3.0 ⚖️] REVISOR_JUDGE wybudzony. Przetarg: ${tenderId} | Zadanie: ${taskId}`);

        const taskRef = adminDb.collection(`tenders/${tenderId}/tasks`).doc(taskId);
        const taskDoc = await taskRef.get();

        if (!taskDoc.exists) throw new Error("Zadanie nie istnieje.");

        const taskData = taskDoc.data()!;

        // Idempotentność
        if (taskData.status !== "PENDING") {
            console.log(`[PESAM 3.0 ⚖️] Zadanie ${taskId} ma status ${taskData.status}. Pomijam.`);
            return NextResponse.json({ message: "Task already processed." });
        }

        // 1. Oznaczamy zadanie jako IN_PROGRESS
        await taskRef.update({ status: "IN_PROGRESS", updatedAt: new Date() });

        // 2. Pobieramy wszystkie otwarte konflikty dla tego przetargu
        const conflictsRef = adminDb.collection(`tenders/${tenderId}/conflicts`);
        const openConflictsSnap = await conflictsRef.where("status", "==", "OPEN").get();

        if (openConflictsSnap.empty) {
            console.log(`[PESAM 3.0 ⚖️] Brak otwartych konfliktów do rozstrzygnięcia.`);
            await taskRef.update({ status: "DONE", result: { summary: "Brak konfliktów." } });

            // Wybudzenie Mózgu
            const origin = new URL(req.url).origin;
            fetch(`${origin}/api/kosztorysant/glowny-kosztorysant`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ tenderId, trigger: `TASK_COMPLETED_${taskId}` })
            }).catch(e => console.error("[PESAM 3.0] Błąd wybudzania Mózgu:", e));

            return NextResponse.json({ message: "Brak konfliktów." });
        }

        let totalTokensUsedPro = 0;
        let totalTokensUsedFlash = 0;
        let resolvedCount = 0;
        let escalatedCount = 0;

        const batch = adminDb.batch();

        // 3. Rozpatrywanie każdego konfliktu (Sąd Roju)
        for (const conflictDoc of openConflictsSnap.docs) {
            const conflictData = conflictDoc.data();
            console.log(`[PESAM 3.0 ⚖️] Rozpatruję sprawę: ${conflictData.topic}`);

            const partiesInfo = (conflictData.parties || []).map((p: any) =>
                `- Agent: ${p.agent} | Twierdzi: "${p.claim}" | Źródło: ${p.sourceDoc}`
            ).join("\n");

            // ====================================================================
            // STANDARD 2: KROK 1 - BADANIE (Google Search Grounding, BEZ JSON)
            // ====================================================================
            const searchPrompt = `
Jesteś Głównym Sędzią (Rewidentem) w systemie kosztorysowym PESAM 3.0.
Wykryto konflikt między agentami analizującymi dokumentację przetargową.

Temat sporu: ${conflictData.topic}
Stanowiska stron:
${partiesInfo}

Twoje zadanie:
1. Użyj wyszukiwarki, aby sprawdzić standardy budowlane, Prawo Zamówień Publicznych (PZP) lub hierarchię ważności dokumentów (np. czy projekt wykonawczy jest ważniejszy od PFU/SWZ).
2. Przeanalizuj argumenty.
3. Wydaj werdykt w formie opisowej (zwykły tekst).
`;
            const searchResult = await ai.models.generateContent({
                model: MODEL_PRO,
                contents: [{ role: "user", parts: [{ text: searchPrompt }] }],
                config: {
                    tools: [{ googleSearch: {} }] // Standard 2: Narzędzia zawsze wewnątrz config
                }
            });

            const searchContext = searchResult.text ?? "";
            totalTokensUsedPro += searchResult.usageMetadata?.totalTokenCount || 0;

            // ====================================================================
            // STANDARD 2: KROK 2 - STRUKTURYZACJA WYROKU (JSON Schema, BEZ NARZĘDZI)
            // ====================================================================
            const structurePrompt = `
Na podstawie poniższego wyroku, sformatuj decyzję do obiektu JSON.
Jeśli nie jesteś w 100% pewien lub sprawa dotyczy krytycznych kosztów, ustaw 'escalateToUser' na true.

Wyrok:
${searchContext}
`;
            const structureResult = await ai.models.generateContent({
                model: MODEL_FLASH,
                contents: [{ role: "user", parts: [{ text: structurePrompt }] }],
                config: {
                    temperature: 0.1,
                    responseMimeType: "application/json",
                    responseSchema: JUDGE_SCHEMA as any
                }
            });

            const parsedResult = JSON.parse(structureResult.text ?? "{}");
            totalTokensUsedFlash += structureResult.usageMetadata?.totalTokenCount || 0;

            // 4. Optymalizacja zapisu: Jedna, ostateczna aktualizacja konfliktu w bazie (Standard 1)
            const finalStatus = parsedResult.escalateToUser ? "ESCALATED_TO_USER" : "RESOLVED";
            const finalDecision = parsedResult.escalateToUser ? "Wymagana decyzja człowieka" : parsedResult.decision;

            batch.update(conflictDoc.ref, {
                status: finalStatus,
                investigatorAssigned: taskId,
                resolution: {
                    decision: finalDecision,
                    justification: parsedResult.justification
                },
                updatedAt: new Date()
            });

            if (parsedResult.escalateToUser) {
                escalatedCount++;
                console.log(`[PESAM 3.0 ⚖️] Sprawa ${conflictDoc.id} eskalowana do Kosztorysanta.`);
            } else {
                resolvedCount++;
                console.log(`[PESAM 3.0 ⚖️] Sprawa ${conflictDoc.id} rozstrzygnięta: ${parsedResult.decision}`);
            }
        }

        // 5. Zakończenie zadania i aktualizacja budżetu
        batch.update(taskRef, {
            status: "DONE",
            result: {
                resolved: resolvedCount,
                escalated: escalatedCount,
                summary: `Rozstrzygnięto: ${resolvedCount}, Eskalowano: ${escalatedCount}`
            },
            costTokens: totalTokensUsedPro + totalTokensUsedFlash,
            updatedAt: new Date()
        });

        // Aktualizacja Budget Guard
        const costUSD = (totalTokensUsedPro / 1000) * 0.002 + (totalTokensUsedFlash / 1000) * 0.000015;
        const tenderRef = adminDb.collection("tenders").doc(tenderId);
        batch.update(tenderRef, {
            "budgetGuard.currentCostUSD": FieldValue.increment(costUSD)
        });

        await batch.commit();

        // 6. Wybudzenie Mózgu (ReAct Loop)
        const localOrigin = `http://127.0.0.1:${process.env.PORT || "3000"}`;
        console.log(`[PESAM 3.0 ⚖️] Wybudzam Mózg lokalnie przez loopback: ${localOrigin}`);

        fetch(`${localOrigin}/api/kosztorysant/glowny-kosztorysant`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tenderId, trigger: `TASK_COMPLETED_${taskId}` })
        }).catch(e => console.error("[PESAM 3.0] Błąd wybudzania Mózgu po wyrokach:", e));

        return NextResponse.json({ success: true, resolvedCount, escalatedCount });

    } catch (error: any) {
        console.error("[PESAM 3.0 ⚖️] ❌ Błąd krytyczny Sędziego:", error);

        if (tenderId && taskId) {
            try {
                await adminDb.collection(`tenders/${tenderId}/tasks`).doc(taskId).update({
                    status: "ERROR",
                    result: { error: error.message }
                });
            } catch (dbError) {
                console.error("[PESAM 3.0 ⚖️] Nie udało się zapisać statusu ERROR do bazy:", dbError);
            }
        }

        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}