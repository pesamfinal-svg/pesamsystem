// ============================================================
// PESAM 3.0 – Główny Orkiestrator (Mózg / ReAct Loop)
// POST /api/kosztorysant/glowny-kosztorysant
// ============================================================

import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { FieldValue } from "firebase-admin/firestore";
import { GoogleGenAI, Type } from "@google/genai";

export const dynamic = "force-dynamic";

// Standard 3: Inicjalizacja klienta Google GenAI (Vertex AI, global)
const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
    location: "global"
});

// Mózg używa modelu PRO do zaawansowanego wnioskowania i planowania
const MODEL_PRO = "gemini-2.5-pro";

// Rejestr Agentów (Książka telefoniczna Mózgu) - mapowanie na endpointy
const AGENT_ENDPOINTS: Record<string, string> = {
    "LEGAL_EXPERT": "/api/kosztorysant/czytacz-dokumentow",
    "VISION_ARCHITECTURE": "/api/kosztorysant/agent-wbs-architekt",
    "VISION_CONSTRUCT": "/api/kosztorysant/agent-wbs-architekt",
    "VISION_MEP": "/api/kosztorysant/agent-wbs-architekt", // Tymczasowo ten sam endpoint dla instalacji
    "BOQ_PARSER": "/api/kosztorysant/agent-ilosciowiec",
    "GAP_FILLER": "/api/kosztorysant/agent-gap-filler",
    "UNIVERSAL_SPECIALIST": "/api/kosztorysant/agent-kameleon",
    "PYTHON_CALC": "/api/kosztorysant/agent-python-calc",
    "BROKER": "/api/kosztorysant/broker-cenowy",
    "SILENT_AUDITOR": "/api/kosztorysant/agent-cichy-rewident",
    "REVISOR_JUDGE": "/api/kosztorysant/agent-rewident",
    "BUDOWLANIEC": "/api/kosztorysant/agent-budowlaniec" // Dodany Agent Budowlany
};

// Schemat odpowiedzi Mózgu (Standard 1: Ścisła spójność i obsługa tempId)
const BRAIN_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        reasoning: {
            type: Type.STRING,
            description: "Logika decyzyjna: dlaczego podejmujesz takie kroki w tej iteracji?"
        },
        phase: {
            type: Type.STRING,
            description: "Nowa faza: PLANNING, WORKING, WAITING_INPUT, CONSENSUS_BUILDING, DONE"
        },
        currentGoal: {
            type: Type.STRING,
            description: "Krótki opis tego, co system ma teraz osiągnąć."
        },
        newTasks: {
            type: Type.ARRAY,
            items: {
                type: Type.OBJECT,
                properties: {
                    tempId: {
                        type: Type.STRING,
                        description: "Unikalny identyfikator tymczasowy dla tego zadania, np. 'temp_legal', 'temp_vision'"
                    },
                    agentType: {
                        type: Type.STRING,
                        description: "Klucz z Rejestru Agentów, np. LEGAL_EXPERT, VISION_ARCHITECTURE"
                    },
                    description: {
                        type: Type.STRING,
                        description: "Szczegółowe polecenie dla agenta"
                    },
                    dependsOn: {
                        type: Type.ARRAY,
                        items: { type: Type.STRING },
                        description: "Tablica ID istniejących zadań z sekcji OBECNE ZADANIA lub 'tempId' zadań tworzonych w tym samym obiekcie JSON."
                    },
                    inputDocIds: {
                        type: Type.ARRAY,
                        items: { type: Type.STRING },
                        description: "Tablica ID dokumentów, które agent ma przeanalizować"
                    }
                },
                required: ["tempId", "agentType", "description", "dependsOn", "inputDocIds"]
            }
        }
    },
    required: ["reasoning", "phase", "currentGoal", "newTasks"]
};

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const { tenderId, trigger } = body;

        if (!tenderId) return NextResponse.json({ error: "Brak tenderId" }, { status: 400 });

        console.log(`[PESAM 3.0 🧠] Wybudzenie Mózgu. Przetarg: ${tenderId} | Trigger: ${trigger}`);

        const tenderRef = adminDb.collection("tenders").doc(tenderId);
        const brainRef = adminDb.collection(`tenders/${tenderId}/brain`).doc("main");

        // 1. Pobranie stanu przetargu i sprawdzenie Bezpiecznika (Budget Guard)
        const tenderDoc = await tenderRef.get();
        if (!tenderDoc.exists) throw new Error("Przetarg nie istnieje.");

        const tenderData = tenderDoc.data()!;
        const budgetGuard = tenderData.budgetGuard || { currentCostUSD: 0, maxBudgetUSD: 5.0, limitReached: false, iterationCount: 0, maxIterations: 50 };

        if (budgetGuard.limitReached || budgetGuard.iterationCount >= budgetGuard.maxIterations) {
            console.warn(`[PESAM 3.0 🧠] 🛑 Przekroczono budżet lub limit iteracji! Zatrzymuję Mózg.`);
            await tenderRef.update({ status: "HALTED" });
            return NextResponse.json({ message: "Halted by Budget Guard" });
        }

        // 2. Zbieranie Kontekstu (Obserwacja)
        const [docsSnap, tasksSnap, brainSnap] = await Promise.all([
            adminDb.collection(`tenders/${tenderId}/documents`).get(),
            adminDb.collection(`tenders/${tenderId}/tasks`).get(),
            brainRef.get()
        ]);

        const documents = docsSnap.docs.map(d => ({ id: d.id, fileName: d.data().fileName, tags: d.data().tags, summary: d.data().summary }));
        const tasks = tasksSnap.docs.map(d => ({ id: d.id, agentType: d.data().agentType, status: d.data().status, description: d.data().description }));
        const brainState = brainSnap.exists ? brainSnap.data() : { phase: "PLANNING", knownFacts: {} };

        // 3. Budowa Promptu dla Mózgu (Zapewnia pełną autonomię decyzyjną ReAct)
        const systemPrompt = `
Jesteś Głównym Orkiestratorem (Mózgiem) systemu kosztorysowego PESAM 3.0.
Działasz w pętli ReAct (Reason -> Act -> Observe). Twoim jedynym celem jest doprowadzenie do stworzenia kompletnego, wycenionego kosztorysu (Live Estimate) dla danego przetargu.
Służą do tego wyspecjalizowani agenci w bazie, którym delegujesz zadania. Samodzielnie analizujesz sytuację, posiadane dokumenty, ich tagi oraz braki i decydujesz o kolejnych krokach.

TWÓJ DYNAMICZNY REJESTR AGENTÓW (Możesz przydzielać im zadania w polu agentType):
- LEGAL_EXPERT: Analizuje umowy, SWZ, PFU pod kątem wymagań formalnych, kar, terminów, certyfikatów i wadium.
- VISION_ARCHITECTURE: Analizuje rysunki architektoniczne (wyciąga surowe wymiary ścian, okien, posadzek).
- VISION_CONSTRUCT: Analizuje rysunki konstrukcyjne (wyciąga klasy betonu, stal, fundamenty).
- VISION_MEP: Analizuje rysunki i schematy instalacji MEP (sanitarne, elektryczne).
- BOQ_PARSER: Parsuje ślepe kosztorysy/przedmiary w Excelu/tabelach, automatycznie wyciągając gotowe ilości.
- GAP_FILLER: Szacuje koszty i ilości wskaźnikowo/parametrycznie dla brakujących branż lub gdy brak jest jakichkolwiek rysunków technicznych.
- BUDOWLANIEC: Inżynier budowy. Projektuje od podstaw proces technologiczny (prace ziemne, stan zerowy, surowy, instalacje, wykończenie) dopasowany do typologii obiektu. Może dopytywać o brakujące dane i debatować z Silent Auditor [1].
- SILENT_AUDITOR: Weryfikuje kosztorys pod kątem WT 2021, Sanepidu i PPOŻ, dopisując brakujące wymagane elementy technologiczne.
- BROKER: Wycenia rynkowo pozycje (szuka cen netto w sieci) - uruchamiaj go dopiero, gdy ilości dla danej sekcji są już znane (QUANTITY_READY).
- REVISOR_JUDGE: Rozstrzyga spory i konflikty technologiczne między agentami.
- UNIVERSAL_SPECIALIST: Kameleon, któremu możesz w polu 'description' zadać unikalną rolę (np. "Przeanalizuj technologię basenową...").
- PYTHON_CALC: Matematyk. Pisze skrypty Python do bezbłędnych obliczeń geometrycznych i objętościowych. Wywołuj go jako pod-zadanie (sub-task) dla skomplikowanych obliczeń.

STAN OBECNY PRZETARGU:
Faza: ${brainState?.phase || "PLANNING"}
Wyzwalacz ostatniej akcji: ${trigger}

DOKUMENTY W BAZIE (Użyj ich identyfikatorów 'id' w polu inputDocIds):
${JSON.stringify(documents, null, 2)}

OBECNE ZADANIA W BAZIE (Użyj rzeczywistych ID dla zależności 'dependsOn' jeśli zadanie już istnieje):
${JSON.stringify(tasks, null, 2)}

ZASADY PLANOWANIA (RE-ACT WORKFLOW):
1. Twój cel to doprowadzenie kosztorysu do statusu wycenionego (DONE).
2. Samodzielnie analizuj, jakie pliki masz w bazie. Jeśli brakuje rysunków, używaj kombinacji BUDOWLANIEC i GAP_FILLER, aby zbudować szacunkowy kosztorys parametryczny i technologiczny na podstawie znanych faktów/SWZ, a następnie wyceń go BROKEREM [1].
3. Nigdy nie twórz zadań dublujących się z istniejącymi zadaniami w bazie (sprawdzaj listę OBECNE ZADANIA).
4. Planuj zależności logiczne za pomocą 'dependsOn' (używaj 'tempId' dla nowych zadań tworzonych w tym samym wywołaniu lub rzeczywistych ID dla już istniejących).
5. Samodzielnie zarządzaj stanem 'phase'. Gdy czekasz na zakończenie zadań agentów, ustaw phase na WORKING. Gdy wszystko jest gotowe, ustaw phase na DONE.
`;

        // 4. Wywołanie modelu Gemini Pro
        const result = await ai.models.generateContent({
            model: MODEL_PRO,
            contents: [{ role: "user", parts: [{ text: systemPrompt }] }],
            config: {
                temperature: 0.2,
                responseMimeType: "application/json",
                responseSchema: BRAIN_SCHEMA as any
            }
        });

        const responseText = result.text ?? "{}";
        const parsedResult = JSON.parse(responseText);

        console.log(`[PESAM 3.0 🧠] Decyzja: ${parsedResult.reasoning}`);

        // 5. Zapis nowych zadań i kompilacja zależności (Standard 1)
        const newTasksCreated: any[] = [];
        const batch = adminDb.batch();

        // Mapa do translacji tempId -> realDocId
        const tempIdToDocIdMap = new Map<string, string>();
        const taskRefs = (parsedResult.newTasks || []).map(() => adminDb.collection(`tenders/${tenderId}/tasks`).doc());

        // Krok A: Generowanie rzeczywistych identyfikatorów
        (parsedResult.newTasks || []).forEach((task: any, index: number) => {
            if (task.tempId) {
                tempIdToDocIdMap.set(task.tempId, taskRefs[index].id);
            }
        });

        // Krok B: Przypisywanie i translacja zależności
        for (let i = 0; i < (parsedResult.newTasks || []).length; i++) {
            const task = parsedResult.newTasks[i];
            const taskRef = taskRefs[i];

            // Tłumaczenie zależności tempId na rzeczywiste ID
            const resolvedDependsOn = (task.dependsOn || []).map((dep: string) => {
                return tempIdToDocIdMap.get(dep) || dep;
            });

            const taskData = {
                taskId: taskRef.id,
                agentType: task.agentType,
                description: task.description,
                dependsOn: resolvedDependsOn,
                inputDocIds: task.inputDocIds || [],
                status: "PENDING",
                priority: 5,
                createdAt: new Date()
            };
            batch.set(taskRef, taskData);
            newTasksCreated.push({ id: taskRef.id, ...taskData });
        }

        // Aktualizacja stanu Mózgu
        batch.update(brainRef, {
            phase: parsedResult.phase,
            currentGoal: parsedResult.currentGoal,
            reasoningLog: FieldValue.arrayUnion(parsedResult.reasoning)
        });

        // Aktualizacja Budget Guard (Pro kosztuje ok $0.002 / 1k tokenów)
        const tokensUsed = result.usageMetadata?.totalTokenCount || 0;
        const costUSD = (tokensUsed / 1000) * 0.002;

        batch.update(tenderRef, {
            "budgetGuard.currentCostUSD": FieldValue.increment(costUSD),
            "budgetGuard.iterationCount": FieldValue.increment(1),
            status: parsedResult.phase === "DONE" ? "DONE" : "ORCHESTRATING"
        });

        await batch.commit();

        // 6. Asynchroniczne i bezpieczne wybudzenie Agentów dla nowych zadań
        const localOrigin = `http://127.0.0.1:${process.env.PORT || "3000"}`;
        for (const task of newTasksCreated) {
            const endpoint = AGENT_ENDPOINTS[task.agentType];
            if (endpoint) {
                console.log(`[PESAM 3.0 🧠] ⚡ Wybudzam Agenta lokalnie przez loopback: ${task.agentType} -> ${localOrigin}${endpoint}`);
                fetch(`${localOrigin}${endpoint}`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ tenderId, taskId: task.id })
                }).catch(e => console.error(`[PESAM 3.0] Błąd wybudzania ${task.agentType}:`, e));
            } else {
                console.warn(`[PESAM 3.0 🧠] ⚠️ Brak zarejestrowanego endpointu dla agenta: ${task.agentType}`);
            }
        }

        return NextResponse.json({
            success: true,
            phase: parsedResult.phase,
            tasksCreated: newTasksCreated.length,
            costUSD
        });

    } catch (error: any) {
        console.error("[PESAM 3.0 🧠] ❌ Błąd krytyczny Mózgu:", error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}