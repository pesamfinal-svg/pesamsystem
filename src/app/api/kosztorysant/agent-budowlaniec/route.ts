// ============================================================
// PESAM 3.0 – Agent Specjalista: BUDOWLANIEC (Inżynier Budowy)
// POST /api/kosztorysant/agent-budowlaniec
// ============================================================

import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { FieldValue } from "firebase-admin/firestore";
import { GoogleGenAI, Type } from "@google/genai";
import { randomUUID } from "crypto"; // Natywna biblioteka Node.js (Gwarancja budowania bez błędów)

export const dynamic = "force-dynamic";

// Inicjalizacja klienta SDK w bezpiecznej globalnej lokalizacji Vertex AI
const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
    location: "global"
});

const MODEL_PRO = "gemini-2.5-pro"; // Wymagany do zaawansowanego projektowania i debaty
const MODEL_FLASH = "gemini-2.5-flash"; // Do szybkiej strukturyzacji końcowej

// Schemat strukturyzacji wyjściowej (Zgodny ze Standardem 1)
const BUDOWLANIEC_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        missingDataQuestions: {
            type: Type.ARRAY,
            description: "Krytyczne pytania inżynieryjne o brakujące parametry (jeśli występują).",
            items: { type: Type.STRING }
        },
        items: {
            type: Type.ARRAY,
            description: "Wygenerowane pozycje robót budowlanych podzielone na etapy (ziemne, zero, surowy, wykończenie).",
            items: {
                type: Type.OBJECT,
                properties: {
                    pozycja: { type: Type.STRING, description: "Nazwa roboty, np. 'Wykopy pod ławy fundamentowe'" },
                    opis: { type: Type.STRING, description: "Szczegółowy opis techniczny i technologiczny roboty" },
                    ilosc: { type: Type.NUMBER, description: "Szacowana ilość (liczba)" },
                    KNR_ref: { type: Type.STRING, description: "Sugerowana podstawa KNR, np. 'KNR 2-01'" }
                },
                required: ["pozycja", "opis", "ilosc", "KNR_ref"]
            }
        },
        summary: { type: Type.STRING, description: "Krótkie podsumowanie założeń inżynieryjnych." }
    },
    required: ["missingDataQuestions", "items", "summary"]
};

export async function POST(req: Request) {
    let tenderId: string | undefined;
    let taskId: string | undefined;

    try {
        const body = await req.json();
        tenderId = body.tenderId;
        taskId = body.taskId;

        if (!tenderId || !taskId) return NextResponse.json({ error: "Brak parametrów" }, { status: 400 });

        console.log(`[PESAM 3.0 🧱] BUDOWLANIEC wybudzony dla przetargu: ${tenderId}`);

        const taskRef = adminDb.collection(`tenders/${tenderId}/tasks`).doc(taskId);
        const taskDoc = await taskRef.get();
        if (!taskDoc.exists) throw new Error("Zadanie nie istnieje.");

        const taskData = taskDoc.data()!;

        // Idempotentność: Pomijamy jeśli już przetworzone
        if (taskData.status !== "PENDING") {
            console.log(`[PESAM 3.0 🧱] Zadanie ${taskId} ma status ${taskData.status}. Pomijam.`);
            return NextResponse.json({ message: "Zadanie już wykonane." });
        }

        await taskRef.update({ status: "IN_PROGRESS", updatedAt: new Date() });

        // 1. Zbieranie faktów i typologii obiektu
        const tenderDoc = await adminDb.collection("tenders").doc(tenderId).get();
        const objectType = tenderDoc.data()?.objectType || "Obiekt budowlany";

        const brainRef = adminDb.collection(`tenders/${tenderId}/brain`).doc("main");
        const brainDoc = await brainRef.get();
        const knownFacts = brainDoc.exists ? brainDoc.data()?.knownFacts || {} : {};

        let totalTokensUsed = 0;

        // ====================================================================
        // DEBATA - KROK 1: Projekt Technologii Budowy (Budowlaniec + Google Search)
        // ====================================================================
        const designPrompt = `
Jesteś Głównym Inżynierem Budowy. Zaprojektuj technologię budowy obiektu typu: ${objectType}.
Znane fakty o projekcie: ${JSON.stringify(knownFacts)}

Uwzględnij pełen cykl budowlany:
1. Prace ziemne i stan zerowy (geodezja, humus, ławy, instalacje podposadzkowe, chudy beton).
2. Stan surowy (ściany nośne, stropy, więźba dachowa, pokrycie dachu, stolarka okienna i drzwiowa).
3. Instalacje i wykończenie.

Jeśli brakuje Ci krytycznych danych do precyzyjnego zaprojektowania (np. kategoria gruntu, dokładna powierzchnia), wymień te pytania na początku swojego raportu jako 'BRAKI:'.
Zwróć raport w formie czytelnego tekstu.
`;
        // POPRAWKA TS2353: 'tools' poprawnie zagnieżdżone wewnątrz obiektu 'config'
        const designResult = await ai.models.generateContent({
            model: MODEL_PRO,
            contents: [{ role: "user", parts: [{ text: designPrompt }] }],
            config: {
                tools: [{ googleSearch: {} }] // Używamy wyszukiwarki do weryfikacji standardów WT 2021
            }
        });

        const builderProposal = designResult.text ?? "";
        totalTokensUsed += designResult.usageMetadata?.totalTokenCount || 0;

        // ====================================================================
        // DEBATA - KROK 2: Krytyka i Audyt (Simulated Silent Auditor)
        // ====================================================================
        const auditPrompt = `
Jesteś Inspektorem Nadzoru i Cichym Audytorem. Przeanalizuj poniższą propozycję technologii budowy dla obiektu: ${objectType}.
Wytknij błędy, braki i pominięcia technologiczne (np. czy zapomniano o transporcie urobku, zabezpieczeniu wykopów, deskowaniach, izolacjach pionowych/poziomych).

Propozycja:
${builderProposal}

Zwróć listę uwag i poprawek w formie zwykłego tekstu.
`;
        const auditResult = await ai.models.generateContent({
            model: MODEL_PRO,
            contents: [{ role: "user", parts: [{ text: auditPrompt }] }]
        });

        const auditorFeedback = auditResult.text ?? "";
        totalTokensUsed += auditResult.usageMetadata?.totalTokenCount || 0;

        // ====================================================================
        // DEBATA - KROK 3: Synteza i Strukturyzacja na JSON (Model Flash)
        // ====================================================================
        const synthesisPrompt = `
Jesteś Głównym Inżynierem. Przeanalizuj uwagi Audytora i skoryguj swój projekt budowy.
Wygeneruj ostateczną, kompletną listę pozycji kosztorysowych, uwzględniając poprawki.
Zwróć dane jako czysty JSON według zadanego schematu.

Twoja propozycja:
${builderProposal}

Uwagi Audytora:
${auditorFeedback}
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

        const parsedResult = JSON.parse(structureResult.text ?? "{}");
        totalTokensUsed += structureResult.usageMetadata?.totalTokenCount || 0;

        const batch = adminDb.batch();

        // 2. Jeśli brakuje danych krytycznych - dopytujemy Mózg / Kosztorysanta i wstrzymujemy proces
        if (parsedResult.missingDataQuestions && parsedResult.missingDataQuestions.length > 0) {
            console.log(`[PESAM 3.0 🧱] Wykryto braki danych. Dopytuję Mózg: ${parsedResult.missingDataQuestions.join(", ")}`);

            // Zapisujemy pytania do stanu umysłu Mózgu (pendingDecisions / missingData)
            batch.update(brainRef, {
                missingData: FieldValue.arrayUnion(...parsedResult.missingDataQuestions),
                reasoningLog: FieldValue.arrayUnion(`Budowlaniec wstrzymał pracę: brak danych o: ${parsedResult.missingDataQuestions.join(", ")}`)
            });

            // Wstrzymujemy zadanie, zmieniając status na WAITING_INPUT
            batch.update(taskRef, {
                status: "WAITING_INPUT",
                result: { questions: parsedResult.missingDataQuestions },
                updatedAt: new Date()
            });

            // Wysyłamy powiadomienie na czat projektu w imieniu Mózgu
            const chatRef = adminDb.collection(`tenders/${tenderId}/chat`).doc();
            batch.set(chatRef, {
                role: "brain",
                content: `⏸️ Agent Budowlany wstrzymał projektowanie technologii. Potrzebuję dodatkowych informacji: \n\n${parsedResult.missingDataQuestions.map((q: string, i: number) => `${i + 1}. ${q}`).join("\n")}\n\nOdpowiedz na czacie, aby wznowić proces.`,
                timestamp: new Date(),
                intent: "GENERAL"
            });

            await batch.commit();

            // Budzimy Mózg loopbackiem
            const localOrigin = `http://127.0.0.1:${process.env.PORT || "3000"}`;
            fetch(`${localOrigin}/api/kosztorysant/glowny-kosztorysant`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ tenderId, trigger: `TASK_WAITING_INPUT_${taskId}` })
            }).catch(e => console.error(e));

            return NextResponse.json({ success: true, waitingOnInput: true });
        }

        // 3. Jeśli wszystko jest jasne - zapisujemy pozycje do kosztorysu (Standard 1: subkolekcja)
        const generatedItems = parsedResult.items || [];
        if (generatedItems.length > 0) {
            const sectionId = `sec_budowlaniec_${taskId}`;
            const sectionRef = adminDb.collection(`tenders/${tenderId}/estimate`).doc(sectionId);

            // Zapis nagłówka sekcji oraz tablicy items na poziomie dokumentu nadrzędnego dla błyskawicznego renderowania na froncie
            batch.set(sectionRef, {
                section: `Prace Budowlane (Stan Surowy i Zerowy - Projekt Inżynierski)`,
                status: "QUANTITY_READY", // Gotowe do wyceny przez Brokera
                totalValue: 0,
                sourceTaskId: taskId,
                items: generatedItems.map((item: any) => ({
                    id: randomUUID(), // Poprawione: Wywołanie bezpiecznego, natywnego generatora Node.js
                    pozycja: item.pozycja,
                    opis: item.opis,
                    ilosc: Number(item.ilosc) || 1,
                    cenaJed: 0,
                    KNR_ref: item.KNR_ref || "KNR 2-01",
                    confidence: "HIGH",
                    sourceTrack: `Zaprojektowane przez: BUDOWLANIEC (Debata z Cichym Audytorem)`
                })),
                updatedAt: new Date()
            });

            // Zapis pozycji do subkolekcji `items` (Standard 1)
            generatedItems.forEach((item: any) => {
                const itemId = randomUUID(); // Natywny generator bez bibliotek zewnętrznych
                const itemRef = sectionRef.collection("items").doc(itemId);

                batch.set(itemRef, {
                    id: itemId,
                    pozycja: item.pozycja,
                    opis: item.opis,
                    ilosc: Number(item.ilosc) || 1,
                    cenaJed: 0, // Broker to wyceni rynkowo
                    KNR_ref: item.KNR_ref || "KNR 2-01",
                    confidence: "HIGH",
                    sourceTrack: `Zaprojektowane przez: BUDOWLANIEC (Debata z Cichym Audytorem)`
                });
            });
        }

        // Zakończenie zadania
        batch.update(taskRef, {
            status: "DONE",
            result: { summary: parsedResult.summary, itemsAdded: generatedItems.length },
            costTokens: totalTokensUsed,
            updatedAt: new Date()
        });

        // Naliczanie kosztu tokenów (PRO: ~$0.002 / 1k, FLASH: ~$0.000015 / 1k)
        const costUSD = (totalTokensUsed * 0.9 / 1000) * 0.002 + (totalTokensUsed * 0.1 / 1000) * 0.000015;
        const tenderRef = adminDb.collection("tenders").doc(tenderId);
        batch.update(tenderRef, {
            "budgetGuard.currentCostUSD": FieldValue.increment(costUSD)
        });

        await batch.commit();
        console.log(`[PESAM 3.0 🧱] Budowlaniec pomyślnie zaprojektował i zapisał ${generatedItems.length} pozycji.`);

        // 4. Wybudzenie Mózgu lokalnym loopbackiem
        const localOrigin = `http://127.0.0.1:${process.env.PORT || "3000"}`;
        fetch(`${localOrigin}/api/kosztorysant/glowny-kosztorysant`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tenderId, trigger: `TASK_COMPLETED_${taskId}` })
        }).catch(e => console.error(e));

        return NextResponse.json({ success: true, itemsAdded: generatedItems.length });

    } catch (error: any) {
        console.error("[PESAM 3.0 🧱] Błąd krytyczny Agenta Budowlanego:", error);
        if (tenderId && taskId) {
            try {
                await adminDb.collection(`tenders/${tenderId}/tasks`).doc(taskId).update({
                    status: "ERROR",
                    result: { error: error.message }
                });
            } catch (dbError) {
                console.error("[PESAM 3.0 🧱] Nie udało się zapisać statusu błędu:", dbError);
            }
        }
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}