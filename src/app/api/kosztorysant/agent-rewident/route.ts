import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { FieldValue } from "firebase-admin/firestore";
import { GoogleGenAI, Type } from "@google/genai";
import { jsonrepair } from "jsonrepair";
import dns from "dns";
dns.setDefaultResultOrder("ipv4first");

export const dynamic = "force-dynamic";

const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
    location: "global"
});

// Sędzia wykonuje skomplikowaną analizę prawno-techniczną, dlatego używa modelu PRO
const MODEL_PRO = "gemini-2.5-pro";
const MODEL_FLASH = "gemini-2.5-flash";

async function callGeminiWithRetry(fn: () => Promise<any>, retries = 5, delay = 5000): Promise<any> {
    try {
        return await fn();
    } catch (error: any) {
        const errorText = error.toString() || "";
        const isRateLimit = errorText.includes("429") || errorText.includes("RESOURCE_EXHAUSTED");
        if (isRateLimit && retries > 0) {
            console.warn(`[REVISOR_JUDGE ⚖️] Limit 429. Czekam ${delay / 1000}s... (Pozostało prób: ${retries})`);
            await new Promise(resolve => setTimeout(resolve, delay));
            return callGeminiWithRetry(fn, retries - 1, delay * 2);
        }
        throw error;
    }
}

// Rygorystyczny schemat wyjściowy werdyktu sędziowskiego
const VERDICT_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        decision: {
            type: Type.STRING,
            description: "Jednoznaczna decyzja merytoryczna rozstrzygająca spór (które twierdzenie jest prawidłowe i dlaczego w 1 zdaniu)."
        },
        justification: {
            type: Type.STRING,
            description: "Pełne uzasadnienie prawne i techniczne z powołaniem na przepisy (WT 2021, PZP, Polskie Normy)."
        },
        winningParty: {
            type: Type.STRING,
            description: "Nazwa agenta, którego twierdzenie wygrało (np. 'VISION', 'BUDOWLANIEC'), lub 'ESCALATE' jeśli sprawa wymaga interwencji człowieka."
        },
        confidence: {
            type: Type.NUMBER,
            description: "Pewność wyroku w skali 0-100."
        },
        requiresUserDecision: {
            type: Type.BOOLEAN,
            description: "Ustaw na true, jeśli sprawa jest zbyt niejednoznaczna lub wymaga decyzji biznesowej użytkownika."
        },
        additionalFindings: {
            type: Type.STRING,
            description: "Opcjonalne dodatkowe ustalenia faktyczne przydatne dla kosztorysu."
        }
    },
    required: ["decision", "justification", "winningParty", "confidence", "requiresUserDecision"]
};

export async function POST(req: Request) {
    let tenderId: string | undefined;
    let taskId: string | undefined;
    let isSuccess = false;

    try {
        const body = await req.json();
        tenderId = body.tenderId;
        taskId = body.taskId;

        console.log(`[REVISOR_JUDGE ⚖️] Start sesji orzekania. Przetarg: ${tenderId} | Zadanie: ${taskId}`);

        if (!tenderId || !taskId) {
            return NextResponse.json({ error: "Brak parametrów" }, { status: 400 });
        }

        const taskRef = adminDb.collection(`tenders/${tenderId}/tasks`).doc(taskId);
        const taskDoc = await taskRef.get();
        if (!taskDoc.exists) throw new Error("Zadanie nie istnieje.");

        const taskData = taskDoc.data()!;
        if (taskData.status !== "PENDING") {
            return NextResponse.json({ message: "Zadanie zostało już obsłużone." });
        }

        await taskRef.update({ status: "IN_PROGRESS", updatedAt: new Date() });

        // 1. Pobieranie otwartych konfliktów z bazy danych
        const conflictsRef = adminDb.collection(`tenders/${tenderId}/conflicts`);
        const openConflictsSnap = await conflictsRef
            .where("status", "in", ["OPEN", "INVESTIGATING"])
            .get();

        if (openConflictsSnap.empty) {
            console.log("[REVISOR_JUDGE ⚖️] Brak otwartych konfliktów do rozstrzygnięcia. Zamykam sesję.");
            await taskRef.update({
                status: "DONE",
                rawResult: { summary: "Brak otwartych konfliktów do rozpatrzenia.", resolvedCount: 0 },
                processedByBrain: false,
                updatedAt: new Date()
            });
            isSuccess = true;
            return NextResponse.json({ success: true, resolvedCount: 0 });
        }

        console.log(`[REVISOR_JUDGE ⚖️] Znaleziono ${openConflictsSnap.size} otwartych konfliktów do zbadania.`);

        // 2. Pobieranie kontekstu poznawczego z Mózgu i GCS
        const [docsSnap, brainSnap] = await Promise.all([
            adminDb.collection(`tenders/${tenderId}/documents`).get(),
            adminDb.collection(`tenders/${tenderId}/brain`).doc("main").get()
        ]);

        const documentsList = docsSnap.docs.map(d => ({
            id: d.id,
            fileName: d.data().fileName,
            tags: d.data().tags || [],
            summary: d.data().summary || "(brak)",
            detailedElement: d.data().detailedElement || "NIE_DOTYCZY"
        }));

        const brainKnownFacts = brainSnap.exists
            ? (brainSnap.data()?.cognitiveState?.knownFacts || {})
            : {};

        let totalTokensUsed = 0;
        let resolvedCount = 0;
        let escalatedCount = 0;

        // 3. Pętla rozstrzygania spraw
        for (const conflictDoc of openConflictsSnap.docs) {
            const conflict = conflictDoc.data();
            console.log(`[REVISOR_JUDGE ⚖️] ──────────────────────────────────────────────────`);
            console.log(`[REVISOR_JUDGE ⚖️] Rozpatruję sprawę: "${conflict.topic}" (ID: ${conflictDoc.id})`);

            await conflictDoc.ref.update({ status: "INVESTIGATING", updatedAt: new Date() });

            // Krok 3a: Analiza prawno-techniczna z wyszukiwarką Google (Model PRO)
            const searchPrompt = `
Jesteś Sędzią Techniczno-Prawnym (REVISOR_JUDGE) w polskim systemie zamówień publicznych.
Musisz rozstrzygnąć następujący spór merytoryczny w kosztorysie budowlanym:

=== TEMAT SPORU ===
${conflict.topic}

=== STANOWISKA STRON ===
${(conflict.parties || []).map((p: any, i: number) => `
Strona ${i + 1} – Agent "${p.agent}":
  Twierdzenie: "${p.claim}"
  Dokument źródłowy: "${p.sourceDoc || "brak"}"
`).join("\n")}

=== ZNANY KONTEKST PROJEKTU ===
Fakty poznawcze: ${JSON.stringify(brainKnownFacts).substring(0, 1500)}
Wykaz dokumentów: ${documentsList.map(d => `[${d.tags.join(",")}] ${d.fileName} (${d.detailedElement}): ${d.summary}`).join("\n").substring(0, 1500)}

=== INSTRUKCJA OD MÓZGU ===
${taskData.instruction || "Rozstrzygnij spór zgodnie z hierarchią ważności dokumentów."}

=== ZASADY ORZEKANIA (HIERARCHIA WAŻNOŚCI) ===
1. Zapisy SWZ (Specyfikacja Warunków Zamówienia) mają BEZWZGLĘDNE pierwszeństwo przed innymi plikami.
2. Projekt Budowlany / Projekt Zagospodarowania Terenu (PZT).
3. Warunki Techniczne (WT 2021) oraz Polskie Normy (PN-EN).
4. Rysunki pomocnicze i opisy technologii.
5. Ogólne standardy branżowe.

Użyj wyszukiwarki Google Search aby:
- Sprawdzić aktualne przepisy techniczno-budowlane (WT 2021) dla tego sporu.
- Zweryfikować normy i interpretacje Urzędu Zamówień Publicznych (UZP) / KIO.

Napisz szczegółowe uzasadnienie wyroku z powołaniem na konkretne dokumenty i paragrafy ustaw.
`;

            const searchResult = await callGeminiWithRetry(() =>
                ai.models.generateContent({
                    model: MODEL_PRO,
                    contents: searchPrompt,
                    config: {
                        tools: [{ googleSearch: {} }],
                        temperature: 0.1
                    }
                })
            );

            const legalAnalysis = searchResult.text ?? "";
            totalTokensUsed += searchResult.usageMetadata?.totalTokenCount || 0;
            console.log(`[REVISOR_JUDGE ⚖️] Analiza dowodowa i prawna ukończona pomyślnie.`);

            // Krok 3b: Kognitywna synteza werdyktu do ustrukturyzowanego formatu JSON
            const verdictPrompt = `
Na podstawie poniższej analizy prawnej, wydaj ostateczny werdykt dla sporu.

=== ANALIZA PRAWNO-TECHNICZNA ===
${legalAnalysis}

=== STRONY SPORU ===
${JSON.stringify(conflict.parties || [])}

Zwróć czysty obiekt JSON pasujący dokładnie do schematu.
`;

            const verdictResult = await callGeminiWithRetry(() =>
                ai.models.generateContent({
                    model: MODEL_FLASH,
                    contents: verdictPrompt,
                    config: {
                        temperature: 0.05,
                        responseMimeType: "application/json",
                        responseSchema: VERDICT_SCHEMA as any
                    }
                })
            );

            totalTokensUsed += verdictResult.usageMetadata?.totalTokenCount || 0;

            let verdict: any = {};
            try {
                verdict = JSON.parse(jsonrepair(verdictResult.text ?? "{}"));
            } catch (parseErr) {
                console.error(`[REVISOR_JUDGE ⚖️] Błąd parsowania wyroku dla "${conflict.topic}":`, parseErr);
                verdict = {
                    decision: "Wymaga ręcznej weryfikacji ze względu na błąd techniczny generatora.",
                    justification: legalAnalysis.substring(0, 500),
                    winningParty: "ESCALATE",
                    confidence: 0,
                    requiresUserDecision: true
                };
            }

            const newStatus = verdict.requiresUserDecision ? "ESCALATED_TO_USER" : "RESOLVED";

            // Krok 3c: Zapis werdyktu bezpośrednio do dokumentu konfliktu w Firestore
            await conflictDoc.ref.update({
                status: newStatus,
                resolution: {
                    decision: verdict.decision || "Brak jednoznacznej decyzji",
                    justification: verdict.justification || legalAnalysis.substring(0, 1000),
                    winningParty: verdict.winningParty || "UNKNOWN",
                    confidence: verdict.confidence || 0,
                    additionalFindings: verdict.additionalFindings || null,
                    resolvedBy: "REVISOR_JUDGE",
                    resolvedAt: new Date()
                },
                updatedAt: new Date()
            });

            if (newStatus === "RESOLVED") {
                resolvedCount++;
                console.log(`[REVISOR_JUDGE ⚖️] Sprawa ROZSTRZYGNIĘTA. Wygrany: ${verdict.winningParty} (pewność: ${verdict.confidence}%)`);
            } else {
                escalatedCount++;
                console.log(`[REVISOR_JUDGE ⚖️] Sprawa ESKALOWANA do Kosztorysanta ze względu na niejednoznaczność.`);
            }
        }

        // 4. Zamykanie zadania dla Mózgu
        await taskRef.update({
            status: "DONE",
            rawResult: {
                summary: `Sesja orzekania zakończona. Spraw rozpatrzonych: ${openConflictsSnap.size}. Rozstrzygnięto: ${resolvedCount}. Eskalowano: ${escalatedCount}.`,
                resolvedCount,
                escalatedCount,
                totalConflicts: openConflictsSnap.size
            },
            processedByBrain: false,
            costTokens: totalTokensUsed,
            updatedAt: new Date()
        });

        const costUSD = (totalTokensUsed / 1000) * 0.002;
        await adminDb.collection("tenders").doc(tenderId).update({
            "budgetGuard.currentCostUSD": FieldValue.increment(costUSD)
        });

        isSuccess = true;
        console.log(`[REVISOR_JUDGE ⚖️] ✅ Protokół podpisany. Rozstrzygnięto: ${resolvedCount}.`);
        return NextResponse.json({ success: true, resolvedCount, escalatedCount });

    } catch (error: any) {
        console.error("[REVISOR_JUDGE ⚖️] ❌ Krytyczny błąd posiedzenia sądu:", error);
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
                body: JSON.stringify({
                    tenderId,
                    trigger: isSuccess ? `TASK_COMPLETED_${taskId}` : `TASK_FAILED_${taskId}`
                })
            }).catch(() => { });
        }
    }
}