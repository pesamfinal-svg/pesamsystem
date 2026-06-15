import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { FieldValue } from "firebase-admin/firestore";
import { GoogleGenAI } from "@google/genai";
import { jsonrepair } from "jsonrepair";
import dns from "dns";
dns.setDefaultResultOrder("ipv4first");

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
    location: "global"
});

const MODEL_FLASH = "gemini-2.5-flash";

async function callGeminiWithRetry(fn: () => Promise<any>, retries = 5, delay = 4000): Promise<any> {
    try {
        return await fn();
    } catch (error: any) {
        const isRateLimit = error.toString().includes("429") || error.toString().includes("RESOURCE_EXHAUSTED");
        if (isRateLimit && retries > 0) {
            const jitter = Math.random() * 2000;
            const waitTime = delay + jitter;
            console.warn(`[NORM ADVISOR 📋] Limit 429. Czekam ${Math.round(waitTime / 1000)}s... (prób: ${retries})`);
            await new Promise(r => setTimeout(r, waitTime));
            return callGeminiWithRetry(fn, retries - 1, delay * 2);
        }
        throw error;
    }
}

export async function POST(req: Request) {
    let tenderId: string | undefined;
    let taskId: string | undefined;
    let isSuccess = false;

    try {
        const body = await req.json();
        tenderId = body.tenderId;
        taskId = body.taskId;

        console.log(`[NORM ADVISOR 📋] Start. tenderId: ${tenderId}, taskId: ${taskId}`);
        if (!tenderId || !taskId) return NextResponse.json({ error: "Brak parametrów" }, { status: 400 });

        const taskRef = adminDb.collection(`tenders/${tenderId}/technolog_tasks`).doc(taskId);
        const taskDoc = await taskRef.get();
        if (!taskDoc.exists) throw new Error("Zadanie nie istnieje.");

        const taskData = taskDoc.data()!;
        if (taskData.status !== "PENDING") return NextResponse.json({ message: "Zadanie obsłużone." });

        await taskRef.update({ status: "IN_PROGRESS", updatedAt: new Date() });

        // Pobierz pełny kontekst — Mózg + Technolog + wyniki SCOPE_RESEARCHER
        const [brainSnap, techSnap, estimateSectionsSnap] = await Promise.all([
            adminDb.collection(`tenders/${tenderId}/brain`).doc("main").get(),
            adminDb.collection(`tenders/${tenderId}/technolog`).doc("main").get(),
            adminDb.collection(`tenders/${tenderId}/estimate`).get()
        ]);

        const knownFacts = taskData.inputFacts || {};
        const brainFacts = brainSnap.exists ? (brainSnap.data()?.cognitiveState?.knownFacts || {}) : {};
        const techState = techSnap.exists ? techSnap.data()?.technologicalState : {};

        // Wyciągnij brakujące zakresy ze SCOPE_RESEARCHER i Technologa
        const scopeResearchResults = techState?.scopeResearchResults || [];
        const identifiedMissingScopes = techState?.identifiedMissingScopes || [];

        const missingDivisions = [
            // Z SCOPE_RESEARCHER
            ...scopeResearchResults.flatMap((r: any) =>
                (r.criticalGaps || [])
                    .filter((g: any) => g.impactScore > 5)
                    .map((g: any) => `${g.gapName} (~${g.estimatedCostShare})`)
            ),
            // Z identifiedMissingScopes Technologa
            ...identifiedMissingScopes
                .filter((s: any) => s.impactScore > 5)
                .map((s: any) => `${s.division} (~${s.estimatedCostShare})`)
        ];

        // Deduplikacja
        const uniqueMissingDivisions = [...new Set(missingDivisions)];

        // Aktualny kosztorys — co już jest
        const existingEstimateSections = estimateSectionsSnap.docs.map(d => d.data().section || "").filter(Boolean);

        const objectType = knownFacts.objectType || brainFacts.objectType || techState?.objectProfile?.objectType || "obiekt budowlany";

        const normPrompt = `Jesteś ekspertem budowlanym, prawnym i normowym dla inwestycji w Polsce.
Używasz Google Search by znaleźć aktualne, konkretne dane.

=== OBIEKT ===
Typ: ${objectType}
Opis: ${knownFacts.objectDescription || brainFacts.objectDescription || "brak szczegółów"}

=== ZADANIE OD TECHNOLOGA ===
${taskData.instruction}

=== CO JUŻ JEST W KOSZTORYSIE ===
${existingEstimateSections.length > 0 ? existingEstimateSections.join(", ") : "(kosztorys pusty)"}

=== BRAKUJĄCE ZAKRESY (zidentyfikowane przez SCOPE_RESEARCHER) ===
${uniqueMissingDivisions.length > 0 ? uniqueMissingDivisions.join("\n") : "brak — skup się na parametrach normowych dla znanych elementów"}

=== FAKTY Z MÓZGU PESAM ===
${JSON.stringify(brainFacts, null, 2)}

=== TWOJE ZADANIE ===

Użyj Google Search aby znaleźć i zweryfikować aktualne dane (rok 2024-2025):

**1. PARAMETRY NORMOWE** dla elementów ${objectType}:
- Współczynniki przenikania ciepła U wg WT2021 (Rozporządzenie Ministra Infrastruktury z 12.04.2002 ze zmianami)
- Wymagania ognioodporności REI/EI wg Rozporządzenia MSWiA ws. ochrony przeciwpożarowej
- Parametry akustyczne wg PN-B-02151-3:2015
- Klasy betonu, stali, kategorie geotechniczne wg Eurokodów (PN-EN 1992, PN-EN 1997)
Szukaj fraz: "WT2021 współczynnik U ${objectType}", "wymagania pożarowe ${objectType} REI"

**2. WSKAŹNIKI KOSZTOWE** dla brakujących działów:
${uniqueMissingDivisions.length > 0 ? uniqueMissingDivisions.slice(0, 5).map(d => `- ${d}`).join("\n") : "- Główne roboty budowlane dla " + objectType}
Szukaj na: SEKOCENBUD (sekocenbud.pl), BCO (bcobcb.pl), przetargi.gov.pl
Szukaj fraz: "SEKOCENBUD wskaźnik ${objectType} 2024", "koszt instalacji [dział] ${objectType} zł/m2"

**3. WYMAGANIA PRAWNE** specyficzne dla ${objectType}:
- Ustawa Prawo Budowlane (Dz.U.2020.1333 ze zm.)
- Rozporządzenie ws. warunków technicznych (WT2021)
- Rozporządzenia branżowe (np. Ministra Edukacji dla placówek oświatowych, Sanepid dla obiektów żywienia)
- Decyzje o warunkach zabudowy — typowe wymagania
Szukaj fraz: "wymagania techniczne ${objectType} przepisy", "rozporządzenie ${objectType} warunki"

Zwróć WYŁĄCZNIE poprawny JSON (bez markdown, bez komentarzy, bez \`\`\`json):
{
  "normParameters": [
    {
      "parameterName": "Nazwa parametru (np. Współczynnik U ściany zewnętrznej)",
      "element": "Element budynku (np. ściana zewnętrzna, stropodach, okna)",
      "derivedValue": "Konkretna wartość (np. U ≤ 0.20 W/m²K od 2021)",
      "normReference": "Dokładny akt prawny + paragraf (np. Rozp. ws. WT, Dz.U.2002.75.690 §321 ust.1 Tabela 1)",
      "searchSource": "URL lub tytuł źródła",
      "confidence": 0,
      "notes": "Ewentualne uwagi, wyjątki, warunki stosowania"
    }
  ],
  "costIndicators": [
    {
      "scope": "Pełna nazwa zakresu robót (np. Instalacja wentylacji mechanicznej z rekuperacją)",
      "unit": "Jednostka (m2 PU / m2 pow. / mb / kpl / szt)",
      "estimatedUnitCostMin": 0,
      "estimatedUnitCostMax": 0,
      "currency": "PLN",
      "source": "SEKOCENBUD Q4 2024 / BCO 2024 / Kalkulacja własna",
      "year": "2024",
      "applicableTo": "Opis gdy wskaźnik ma zastosowanie (np. dla budynków > 500m2 PU)",
      "confidence": 0
    }
  ],
  "legalRequirements": [
    {
      "requirement": "Treść wymagania (np. Kuchnia w przedszkolu musi posiadać węzeł sanitarny dla personelu)",
      "legalBasis": "Pełna nazwa aktu prawnego + artykuł/paragraf",
      "applicableTo": "Konkretny element/pomieszczenie/instalacja",
      "consequence": "Skutek pominięcia (np. brak odbioru sanitarnego, nakaz rozbiórki)",
      "estimatedCostImpact": "Szacunkowy koszt dostosowania jeśli brakuje"
    }
  ],
  "summary": "Podsumowanie: ile parametrów znaleziono, jakie kluczowe wymagania, na co PESAM powinien zwrócić uwagę"
}`;

        console.log(`[NORM ADVISOR 📋] Wywołuję model z googleSearch dla: ${objectType}`);

        const result = await callGeminiWithRetry(() =>
            ai.models.generateContent({
                model: MODEL_FLASH,
                contents: normPrompt,
                config: {
                    tools: [{ googleSearch: {} }],
                    temperature: 0.1,
                    responseMimeType: "application/json"
                }
            })
        );

        const totalTokensUsed = result.usageMetadata?.totalTokenCount || 0;
        console.log(`[NORM ADVISOR 📋] Użyto ${totalTokensUsed} tokenów.`);

        let parsed: any = { normParameters: [], costIndicators: [], legalRequirements: [], summary: "" };
        try {
            const rawText = result.text ?? "{}";
            parsed = JSON.parse(jsonrepair(rawText));
        } catch (e) {
            console.warn("[NORM ADVISOR 📋] Błąd parsowania JSON — surowy tekst jako fallback.");
            parsed.summary = `Błąd parsowania. Surowy tekst: ${result.text?.substring(0, 300) || "brak"}`;
        }

        const normCount = parsed.normParameters?.length || 0;
        const costCount = parsed.costIndicators?.length || 0;
        const legalCount = parsed.legalRequirements?.length || 0;

        console.log(`[NORM ADVISOR 📋] Wyniki: ${normCount} parametrów normowych, ${costCount} wskaźników kosztowych, ${legalCount} wymagań prawnych`);

        await taskRef.update({
            status: "DONE",
            rawResult: {
                normParameters: parsed.normParameters || [],
                costIndicators: parsed.costIndicators || [],
                legalRequirements: parsed.legalRequirements || [],
                missingDivisionsResearched: uniqueMissingDivisions,
                summary: parsed.summary || `Znaleziono: ${normCount} parametrów normowych, ${costCount} wskaźników kosztowych, ${legalCount} wymagań prawnych dla ${objectType}.`
            },
            processedByTechnolog: false,
            costTokens: totalTokensUsed,
            updatedAt: new Date()
        });

        const costUSD = (totalTokensUsed / 1000) * 0.000015;
        await adminDb.collection("tenders").doc(tenderId).update({
            "budgetGuard.currentCostUSD": FieldValue.increment(costUSD)
        });

        isSuccess = true;
        return NextResponse.json({
            success: true,
            normParametersCount: normCount,
            costIndicatorsCount: costCount,
            legalRequirementsCount: legalCount
        });

    } catch (error: any) {
        console.error("[NORM ADVISOR 📋] Błąd:", error);
        if (tenderId && taskId) {
            await adminDb.collection(`tenders/${tenderId}/technolog_tasks`).doc(taskId).update({
                status: "ERROR",
                rawResult: { error: error.message },
                processedByTechnolog: false,
                updatedAt: new Date()
            }).catch(() => { });
        }
        return NextResponse.json({ error: error.message }, { status: 500 });

    } finally {
        if (tenderId && taskId) {
            // Jitter przed callbackiem — rozłożenie żądań w czasie
            const jitter = 1000 + Math.random() * 3000;
            await new Promise(r => setTimeout(r, jitter));

            const localOrigin = `http://localhost:${process.env.PORT || "3000"}`;
            fetch(`${localOrigin}/api/technolog/glowny-technolog`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    tenderId,
                    trigger: isSuccess ? `TASK_COMPLETED_${taskId}` : `TASK_FAILED_${taskId}`
                })
            }).catch(err => console.error("[NORM ADVISOR 📋] Błąd powiadamiania Technologa:", err.message));
        }
    }
}