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

const MODEL_PRO = "gemini-2.5-pro"; // Zaawansowana logika debaty wymaga modelu Pro
const MODEL_FLASH = "gemini-2.5-flash"; // Do końcowej syntezy na JSON

// Schemat ustrukturyzowanego wyjścia z debaty inżynierskiej
const BUDOWLANIEC_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        missingQuestions: {
            type: Type.ARRAY,
            description: "Krytyczne pytania inżynieryjne o brakujące parametry gruntowe lub projektowe, które uniemożliwiają wycenę. Zostaw puste jeśli nie ma krytycznych braków.",
            items: { type: Type.STRING }
        },
        items: {
            type: Type.ARRAY,
            description: "Wygenerowane pozycje robót budowlanych podzielone na etapy technologiczne.",
            items: {
                type: Type.OBJECT,
                properties: {
                    pozycja: { type: Type.STRING, description: "Nazwa roboty, np. 'Wykopy pod ławy fundamentowe'" },
                    opis: { type: Type.STRING, description: "Szczegółowy opis techniczny i technologiczny roboty" },
                    ilosc: { type: Type.NUMBER, description: "Szacowana ilość (liczba)" },
                    jednostka: { type: Type.STRING, description: "Jednostka miary, np. m3, m2, szt" },
                    KNR_ref: { type: Type.STRING, description: "Sugerowana podstawa KNR, np. 'KNR 2-01'" }
                },
                required: ["pozycja", "opis", "ilosc", "jednostka", "KNR_ref"]
            }
        },
        summary: { type: Type.STRING, description: "Krótkie podsumowanie założeń inżynieryjnych." }
    },
    required: ["missingQuestions", "items", "summary"]
};

export async function POST(req: Request) {
    let tenderId: string | undefined;
    let taskId: string | undefined;
    let isSuccess = false;

    try {
        const body = await req.json();
        tenderId = body.tenderId;
        taskId = body.taskId;

        console.log(`[BUDOWLANIEC 🧱] Otrzymano żądanie POST. tenderId: ${tenderId}, taskId: ${taskId}`);

        if (!tenderId || !taskId) {
            console.error("[BUDOWLANIEC 🧱] Błąd: Brak wymaganych parametrów tenderId lub taskId.");
            return NextResponse.json({ error: "Brak parametrów" }, { status: 400 });
        }

        const taskRef = adminDb.collection(`tenders/${tenderId}/tasks`).doc(taskId);
        const taskDoc = await taskRef.get();

        if (!taskDoc.exists) {
            console.error(`[BUDOWLANIEC 🧱] Zadanie o ID ${taskId} nie istnieje w bazie.`);
            throw new Error("Zadanie nie istnieje.");
        }

        const taskData = taskDoc.data()!;
        console.log(`[BUDOWLANIEC 🧱] Wczytano dane zadania. Status w bazie: ${taskData.status}`);

        if (taskData.status !== "PENDING") {
            console.log(`[BUDOWLANIEC 🧱] Zadanie ma status ${taskData.status}. Przerywam.`);
            return NextResponse.json({ message: "Zadanie już wykonane." });
        }

        // Zmiana statusu na IN_PROGRESS
        console.log("[BUDOWLANIEC 🧱] Zmieniam status zadania na IN_PROGRESS.");
        await taskRef.update({ status: "IN_PROGRESS", updatedAt: new Date() });

        const knownFacts = taskData.inputFacts || {};
        let totalTokensUsed = 0;

        // ====================================================================
        // DEBATA - KROK 1: Projekt Technologii Budowy (Model Pro + Google Search)
        // ====================================================================
        console.log("[BUDOWLANIEC 🧱] Rozpoczynam KROK 1: Projektowanie technologii budowy z Google Search Grounding...");
        const designPrompt = `
Jesteś Głównym Inżynierem Budowy. Zaprojektuj technologię budowy i procesy wykonawcze dla projektu.
Znane fakty o obiekcie przekazane przez Mózg: ${JSON.stringify(knownFacts)}

Twoje polecenie od Mózgu:
${taskData.instruction}

Zaprojektuj pełen cykl budowlany:
1. Prace ziemne i stan zerowy (humus, wykopy, ławy, instalacje podposadzkowe).
2. Stan surowy (ściany nośne, stropy, konstrukcja dachu).
3. Wykończenie i zagospodarowanie.

Użyj wyszukiwarki Google Search, aby zweryfikować aktualne standardy WT 2021 oraz normy budowlane w Polsce.
Zwróć kompletny raport technologiczny jako czytelny tekst.
`;

        const designResult = await ai.models.generateContent({
            model: MODEL_PRO,
            contents: [{ role: "user", parts: [{ text: designPrompt }] }],
            config: {
                tools: [{ googleSearch: {} }], // Grounding budowlany
                temperature: 0.2
            }
        });

        const builderProposal = designResult.text ?? "";
        const tokensStep1 = designResult.usageMetadata?.totalTokenCount || 0;
        totalTokensUsed += tokensStep1;
        console.log(`[BUDOWLANIEC 🧱] Ukończono KROK 1. Zużyto tokenów: ${tokensStep1}`);

        // ====================================================================
        // DEBATA - KROK 2: Krytyka i Audyt (Simulated Silent Auditor)
        // ====================================================================
        console.log("[BUDOWLANIEC 🧱] Rozpoczynam KROK 2: Symulacja krytycznego audytu inżynieryjnego...");
        const auditPrompt = `
Jesteś Inspektorem Nadzoru Budowlanego i Cichym Audytorem. 
Przeanalizuj krytycznie poniższą propozycję technologii budowy zaprojektowaną przez Głównego Inżyniera:

${builderProposal}

Wytknij błędy, pominięcia i braki technologiczne (np. brak zabezpieczenia ścian wykopów, pominięcie deskowań, brak pionowej izolacji przeciwwilgociowej, transportu urobku, itp.).
Wypunktuj wszystkie słabe punkty w formie zwykłego tekstu.
`;

        const auditResult = await ai.models.generateContent({
            model: MODEL_PRO,
            contents: [{ role: "user", parts: [{ text: auditPrompt }] }],
            config: { temperature: 0.2 }
        });

        const auditorFeedback = auditResult.text ?? "";
        const tokensStep2 = auditResult.usageMetadata?.totalTokenCount || 0;
        totalTokensUsed += tokensStep2;
        console.log(`[BUDOWLANIEC 🧱] Ukończono KROK 2. Zużyto tokenów: ${tokensStep2}`);

        // ====================================================================
        // DEBATA - KROK 3: Synteza i Strukturyzacja na JSON (Model Flash)
        // ====================================================================
        console.log("[BUDOWLANIEC 🧱] Rozpoczynam KROK 3: Synteza poprawek i generowanie struktury JSON...");
        const synthesisPrompt = `
Jesteś Głównym Inżynierem. Przeanalizuj uwagi krytyczne Audytora i skoryguj swój pierwotny projekt budowy.
Wygeneruj ostateczną, kompletną listę pozycji kosztorysowych, uwzględniając poprawki oraz wymogi techniczne.

Twoja pierwotna propozycja:
${builderProposal}

Uwagi Audytora:
${auditorFeedback}

Zwróć ostateczny wynik jako poprawny JSON dopasowany ściśle do wymaganego schematu.
`;

        const structureResult = await ai.models.generateContent({
            model: MODEL_FLASH,
            contents: [{ role: "user", parts: [{ text: synthesisPrompt }] }],
            config: {
                temperature: 0.1,
                responseMimeType: "application/json",
                responseSchema: BUDOWLANIEC_SCHEMA as any
            }
        });

        console.log("[BUDOWLANIEC 🧱] Pomyślnie sparsowano wynik do formatu JSON.");
        const parsedResult = JSON.parse(structureResult.text ?? "{}");
        const tokensStep3 = structureResult.usageMetadata?.totalTokenCount || 0;
        totalTokensUsed += tokensStep3;
        console.log(`[BUDOWLANIEC 🧱] Ukończono KROK 3. Zużyto tokenów: ${tokensStep3}`);

        // Zapisujemy całą strukturę (items, missingQuestions, summary) bezpośrednio do rawResult
        console.log("[BUDOWLANIEC 🧱] Zapisuję rawResult w bazie danych i oznaczam zadanie jako DONE.");
        await taskRef.update({
            status: "DONE",
            rawResult: parsedResult,
            processedByBrain: false,
            costTokens: totalTokensUsed,
            updatedAt: new Date()
        });

        // Przybliżona kalkulacja kosztu (KROK 1 i 2 na Pro, KROK 3 na Flash)
        const costPro = ((tokensStep1 + tokensStep2) / 1000) * 0.002;
        const costFlash = (tokensStep3 / 1000) * 0.000015;
        const totalCostUSD = costPro + costFlash;

        console.log(`[BUDOWLANIEC 🧱] Łączny koszt tokenów: ${totalCostUSD.toFixed(6)} USD. Aktualizuję Budget Guard.`);
        await adminDb.collection("tenders").doc(tenderId).update({
            "budgetGuard.currentCostUSD": FieldValue.increment(totalCostUSD)
        });

        isSuccess = true;
        console.log("[BUDOWLANIEC 🧱] Proces inżynieryjny zakończony pomyślnie.");
        return NextResponse.json({ success: true });

    } catch (error: any) {
        console.error("[BUDOWLANIEC 🧱] ❌ Błąd krytyczny w agencie budowlanym:", error);
        if (tenderId && taskId) {
            console.log("[BUDOWLANIEC 🧱] Zapisuję status błędu (ERROR) do bazy.");
            await adminDb.collection(`tenders/${tenderId}/tasks`).doc(taskId).update({
                status: "ERROR",
                rawResult: { error: error.message },
                processedByBrain: false,
                updatedAt: new Date()
            }).catch((dbErr) => console.error("[BUDOWLANIEC 🧱] Nie udało się zapisać błędu do Firestore:", dbErr));
        }
        return NextResponse.json({ error: error.message }, { status: 500 });

    } finally {
        // Gwarancja wybudzenia Mózgu (zawsze w finally)
        if (tenderId && taskId) {
            const localOrigin = `http://127.0.0.1:${process.env.PORT || "3000"}`;
            console.log(`[BUDOWLANIEC 🧱] Wybudzam Mózg przez loopback na adresie: ${localOrigin}`);
            fetch(`${localOrigin}/api/kosztorysant/glowny-kosztorysant`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    tenderId,
                    trigger: isSuccess ? `TASK_COMPLETED_${taskId}` : `TASK_FAILED_${taskId}`
                })
            }).catch((fetchErr) => console.error("[BUDOWLANIEC 🧱] Błąd wybudzania Mózgu przez fetch:", fetchErr));
        }
    }
}