// ============================================================
// PESAM 3.0 – Agent Specjalista: LEGAL_EXPERT (Czytacz Dokumentów)
// POST /api/kosztorysant/czytacz-dokumentow
// ============================================================

import { NextResponse } from "next/server";
import { adminDb, adminStorage } from "@/lib/firebase/admin";
import { FieldValue } from "firebase-admin/firestore";
import { GoogleGenAI, Type } from "@google/genai";

export const dynamic = "force-dynamic";

// Standard 3 & 4: Inicjalizacja klienta Google GenAI (Vertex AI, global, brak undici)
const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
    location: "global"
});

const MODEL_FLASH = "gemini-2.5-flash";

// Schemat odpowiedzi Agenta Prawnego
const LEGAL_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        extractedFacts: {
            type: Type.ARRAY,
            description: "Lista twardych faktów prawnych/administracyjnych wyciągniętych z dokumentu.",
            items: {
                type: Type.OBJECT,
                properties: {
                    key: { type: Type.STRING, description: "Kategoria, np. 'Termin_Realizacji', 'Wadium', 'Kary_Umowne', 'Gwarancja'" },
                    value: { type: Type.STRING, description: "Konkretna wartość, np. '12 miesięcy od podpisania umowy', '50 000 PLN'" }
                },
                required: ["key", "value"]
            }
        },
        summary: {
            type: Type.STRING,
            description: "Krótkie podsumowanie analizy prawnej dla Mózgu."
        }
    },
    required: ["extractedFacts", "summary"]
};

export async function POST(req: Request) {
    // POPRAWKA 2: Deklaracja zmiennych na zewnątrz bloku try, aby catch miał do nich bezpieczny dostęp
    let tenderId: string | undefined;
    let taskId: string | undefined;

    try {
        const body = await req.json();
        tenderId = body.tenderId;
        taskId = body.taskId;

        if (!tenderId || !taskId) {
            return NextResponse.json({ error: "Brak tenderId lub taskId" }, { status: 400 });
        }

        console.log(`[PESAM 3.0 ⚖️] LEGAL_EXPERT wybudzony. Przetarg: ${tenderId} | Zadanie: ${taskId}`);

        const taskRef = adminDb.collection(`tenders/${tenderId}/tasks`).doc(taskId);
        const taskDoc = await taskRef.get();

        if (!taskDoc.exists) {
            throw new Error("Zadanie nie istnieje.");
        }

        const taskData = taskDoc.data()!;

        // Idempotentność: Jeśli zadanie nie jest PENDING, ignorujemy
        if (taskData.status !== "PENDING") {
            console.log(`[PESAM 3.0 ⚖️] Zadanie ${taskId} ma status ${taskData.status}. Pomijam.`);
            return NextResponse.json({ message: "Task already processed or in progress." });
        }

        // 1. Oznaczamy zadanie jako IN_PROGRESS
        await taskRef.update({ status: "IN_PROGRESS", updatedAt: new Date() });

        const inputDocIds: string[] = taskData.inputDocIds || [];
        if (inputDocIds.length === 0) {
            await taskRef.update({ status: "DONE", result: { summary: "Brak dokumentów do analizy." } });
            return NextResponse.json({ message: "Brak dokumentów." });
        }

        let totalTokensUsed = 0;
        const allExtractedFacts: Record<string, string> = {};
        const summaries: string[] = [];

        // 2. Pobieranie i analiza dokumentów
        const bucketName = process.env.STORAGE_BUCKET || "pesam-system-81165.firebasestorage.app";
        const bucket = adminStorage.bucket(bucketName);

        for (const docId of inputDocIds) {
            const docSnap = await adminDb.collection(`tenders/${tenderId}/documents`).doc(docId).get();
            if (!docSnap.exists) continue;

            const docData = docSnap.data()!;
            console.log(`[PESAM 3.0 ⚖️] Czytam dokument: ${docData.fileName}`);

            try {
                // Standard 3: Bezpieczne pobieranie bufora
                const fileRef = bucket.file(docData.storagePath);
                const [downloadedBuffer] = await fileRef.download();
                const safeArrayBuffer = new Uint8Array(downloadedBuffer).buffer;
                const base64Data = Buffer.from(safeArrayBuffer).toString("base64");

                const prompt = `
Jesteś Agentem Prawnym (LEGAL_EXPERT) w systemie PESAM 3.0.
Twoje zadanie: ${taskData.description}

Przeanalizuj załączony dokument (np. SWZ, PFU, Umowa).
Szukaj wyłącznie twardych faktów mających wpływ na koszty i ryzyko:
- Terminy realizacji
- Kary umowne
- Wymagane wadium / zabezpieczenie należytego wykonania
- Okresy gwarancji
- Wymagania dotyczące certyfikatów lub ubezpieczeń

Zwróć dane w formacie JSON.
`;

                const result = await ai.models.generateContent({
                    model: MODEL_FLASH,
                    contents: [
                        {
                            role: "user",
                            parts: [
                                { text: prompt },
                                { inlineData: { data: base64Data, mimeType: docData.mimeType || "application/pdf" } }
                            ]
                        }
                    ],
                    config: {
                        temperature: 0.1,
                        responseMimeType: "application/json",
                        responseSchema: LEGAL_SCHEMA as any
                    }
                });

                const responseText = result.text ?? "{}";
                const parsedResult = JSON.parse(responseText);

                totalTokensUsed += result.usageMetadata?.totalTokenCount || 0;

                // Transformacja tablicy {key, value} na płaską mapę
                if (parsedResult.extractedFacts) {
                    // POPRAWKA 1: Bezpieczna nazwa pliku bez kropek (ochrona przed zagnieżdżaniem w Firestore)
                    const safeFileName = docData.fileName.replace(/\./g, "_");

                    parsedResult.extractedFacts.forEach((fact: any) => {
                        allExtractedFacts[`${safeFileName}_${fact.key}`] = fact.value;
                    });
                }
                if (parsedResult.summary) summaries.push(parsedResult.summary);

            } catch (err) {
                console.error(`[PESAM 3.0 ⚖️] Błąd analizy pliku ${docData.fileName}:`, err);
            }
        }

        // 3. Zapis wyników do bazy (Aktualizacja Zadania i Mózgu)
        const batch = adminDb.batch();

        // A. Zakończenie zadania
        batch.update(taskRef, {
            status: "DONE",
            result: {
                facts: allExtractedFacts,
                summary: summaries.join(" | ")
            },
            costTokens: totalTokensUsed,
            updatedAt: new Date()
        });

        // B. Wstrzyknięcie faktów do Mózgu (knownFacts)
        const brainRef = adminDb.collection(`tenders/${tenderId}/brain`).doc("main");

        const brainUpdates: Record<string, any> = {};
        for (const [key, value] of Object.entries(allExtractedFacts)) {
            brainUpdates[`knownFacts.${key}`] = value;
        }

        if (Object.keys(brainUpdates).length > 0) {
            batch.update(brainRef, brainUpdates);
        }

        // C. Aktualizacja Budget Guard
        const costUSD = (totalTokensUsed / 1000) * 0.000015;
        const tenderRef = adminDb.collection("tenders").doc(tenderId);
        batch.update(tenderRef, {
            "budgetGuard.currentCostUSD": FieldValue.increment(costUSD)
        });

        await batch.commit();
        console.log(`[PESAM 3.0 ⚖️] Zadanie ${taskId} zakończone. Fakty zapisane w Mózgu.`);

        // 4. Wybudzenie Mózgu (ReAct Loop kontynuuje działanie)
        const localOrigin = `http://127.0.0.1:${process.env.PORT || "3000"}`;
        console.log(`[PESAM 3.0 ⚖️] Wybudzam Mózg lokalnie przez loopback: ${localOrigin}`);

        fetch(`${localOrigin}/api/kosztorysant/glowny-kosztorysant`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tenderId, trigger: `TASK_COMPLETED_${taskId}` })
        }).catch(e => console.error("[PESAM 3.0] Błąd wybudzania Mózgu po zadaniu prawnym:", e));

        return NextResponse.json({ success: true, factsFound: Object.keys(allExtractedFacts).length });

    } catch (error: any) {
        console.error("[PESAM 3.0 ⚖️] ❌ Błąd krytyczny Agenta Prawnego:", error);

        // POPRAWKA 2: Bezpieczne użycie zmiennych z zewnętrznego scope'u bez ponownego czytania req.json()
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