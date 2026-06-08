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

// Rejestr Agentów (Książka telefoniczna Mózgu) - mapowanie na endpointy (PESAM 3.0)
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
    "REVISOR_JUDGE": "/api/kosztorysant/agent-rewident"
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

        // 3. Budowa Promptu dla Mózgu
        const systemPrompt = `
Jesteś Głównym Orkiestratorem (Mózgiem) systemu kosztorysowego PESAM 3.0.
Działasz w pętli ReAct (Reason -> Act -> Observe). Twoim zadaniem jest delegowanie pracy do specjalistów.

DOSTĘPNI AGENCI (Rejestr):
- LEGAL_EXPERT: Analizuje umowy, SWZ, PFU. Szuka kar, terminów, gwarancji.
- VISION_ARCHITECTURE: Analizuje rysunki architektoniczne (rzuty, przekroje).
- VISION_CONSTRUCT: Analizuje rysunki konstrukcyjne (zbrojenia, beton).
- BOQ_PARSER: Wyciąga dane z przedmiarów (Excel, tabele).
- BROKER: Wycenia pozycje (uruchamiaj dopiero gdy ilości są znane).
- SILENT_AUDITOR: Szuka braków technologicznych (uruchamiaj na końcu).

STAN OBECNY:
Faza: ${brainState?.phase}
Wyzwalacz: ${trigger}

DOKUMENTY W BAZIE (Użyj ich identyfikatorów 'id' w polu inputDocIds):
${JSON.stringify(documents, null, 2)}

OBECNE ZADANIA W BAZIE (Jeśli chcesz określić zależność do istniejącego już zadania, użyj jego rzeczywistego ID z tej listy):
${JSON.stringify(tasks, null, 2)}

ZASADY PLANOWANIA:
1. Nie wykonuj pracy sam. Twórz zadania (newTasks) dla agentów.
2. Jeśli dokument ma tag [SWZ], zleć go do LEGAL_EXPERT.
3. Jeśli dokument ma tag [RYSUNEK, ARCHITEKTURA], zleć do VISION_ARCHITECTURE.
4. Używaj 'dependsOn' do określania kolejności. Możesz w nim wpisywać 'tempId' innych zadań, które tworzysz w tym samym wywołaniu.
5. Jeśli wszystkie dokumenty są w trakcie analizy, nie twórz nowych zadań, zmień fazę na WORKING.
6. Jeśli wszystkie zadania mają status DONE, zmień fazę na DONE.
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
        const origin = new URL(req.url).origin;
        for (const task of newTasksCreated) {
            const endpoint = AGENT_ENDPOINTS[task.agentType];
            if (endpoint) {
                console.log(`[PESAM 3.0 🧠] ⚡ Wybudzam Agenta: ${task.agentType} dla zadania ${task.id}`);
                fetch(`${origin}${endpoint}`, {
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