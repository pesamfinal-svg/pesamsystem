import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { FieldValue } from "firebase-admin/firestore";
import { GoogleGenAI, Type } from "@google/genai";
import { randomUUID } from "crypto";
import dns from "dns";
dns.setDefaultResultOrder("ipv4first");

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
    location: "global"
});

const MODEL_FLASH = "gemini-2.5-flash";

// ─────────────────────────────────────────────────────────────────────────────
// REJESTR AGENTÓW I SCHEMATY (Zadeklarowane na samej górze przed użyciem)
// ─────────────────────────────────────────────────────────────────────────────

const TECHNOLOG_AGENTS = [
    { name: "MATERIAL_DETECTIVE", endpoint: "/api/technolog/agent-technolog-materialowy", description: "Skanuje dokumenty w poszukiwaniu parametrów technicznych materiałów budowlanych." },
    { name: "QUANTITY_ESTIMATOR", endpoint: "/api/technolog/agent-technolog-przedmiarowy", description: "Przelicza wskaźnikowo ilości elementów budowlanych." },
    { name: "NORM_ADVISOR", endpoint: "/api/technolog/agent-technolog-norm", description: "Dobiera brakujące parametry techniczne z norm WT2021/Eurokodów." }
];

const TECHNOLOG_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        reasoning: {
            type: Type.STRING,
            description: "Tok rozumowania technologicznego. Co wiem o technologii tego obiektu? Co mi brakuje? Jakie normy zastosować?"
        },
        selfCritique: {
            type: Type.STRING,
            description: "Samokrytyka: Które z moich założeń technologicznych mogą być błędne? Gdzie ryzyko doboru złej technologii?"
        },
        nextBestAction: {
            type: Type.STRING,
            description: "Jaka pojedyncza informacja techniczna najbardziej zwiększy jakość opisu technologicznego?"
        },
        phase: {
            type: Type.STRING,
            description: "ANALYZING, WORKING, SYNTHESIZING lub DONE"
        },
        currentGoal: {
            type: Type.STRING,
            description: "Aktualny cel technologiczny"
        },
        technologicalState: {
            type: Type.OBJECT,
            properties: {
                objectProfile: {
                    type: Type.OBJECT,
                    description: "Profil technologiczny obiektu wynikający z dokumentów",
                    properties: {
                        objectType: { type: Type.STRING, description: "Typ obiektu np. 'przedszkole', 'hala'" },
                        constructionSystem: { type: Type.STRING, description: "System konstrukcyjny" },
                        foundationType: { type: Type.STRING, description: "Typ fundamentów" },
                        roofType: { type: Type.STRING, description: "Typ dachu" },
                        insulationType: { type: Type.STRING, description: "Izolacja termiczna" },
                        finishStandard: { type: Type.STRING, description: "Standard wykończenia WT2021" }
                    }
                },
                confirmedMaterials: {
                    type: Type.ARRAY,
                    description: "Materiały i technologie POTWIERDZONE w dokumentach",
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            material: { type: Type.STRING },
                            specification: { type: Type.STRING },
                            sourceDoc: { type: Type.STRING },
                            confidence: { type: Type.NUMBER }
                        },
                        required: ["material", "specification", "sourceDoc", "confidence"]
                    }
                },
                derivedParameters: {
                    type: Type.ARRAY,
                    description: "Parametry DOBRANE przez Technologa z norm gdy brakuje danych",
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            parameter: { type: Type.STRING },
                            value: { type: Type.STRING },
                            normBasis: { type: Type.STRING },
                            confidence: { type: Type.NUMBER }
                        },
                        required: ["parameter", "value", "normBasis", "confidence"]
                    }
                },
                quantityIndicators: {
                    type: Type.ARRAY,
                    description: "Wskaźniki ilościowe przeliczone przez Technologa dla brakujących przedmiarów",
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            element: { type: Type.STRING },
                            estimatedQuantity: { type: Type.NUMBER },
                            unit: { type: Type.STRING },
                            calculationBasis: { type: Type.STRING },
                            confidence: { type: Type.NUMBER }
                        },
                        required: ["element", "estimatedQuantity", "unit", "calculationBasis", "confidence"]
                    }
                },
                technologicalConflicts: {
                    type: Type.ARRAY,
                    description: "Sprzeczności technologiczne wykryte między dokumentami",
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            topic: { type: Type.STRING },
                            conflictingData: { type: Type.ARRAY, items: { type: Type.STRING } },
                            recommendation: { type: Type.STRING }
                        },
                        required: ["topic", "conflictingData", "recommendation"]
                    }
                },
                technologicalGaps: {
                    type: Type.ARRAY,
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            element: { type: Type.STRING },
                            impactScore: { type: Type.NUMBER },
                            suggestedAgent: { type: Type.STRING }
                        },
                        required: ["element", "impactScore", "suggestedAgent"]
                    }
                }
            },
            required: ["objectProfile", "confirmedMaterials", "derivedParameters", "quantityIndicators", "technologicalConflicts", "technologicalGaps"]
        },
        newTasks: {
            type: Type.ARRAY,
            items: {
                type: Type.OBJECT,
                properties: {
                    agentType: { type: Type.STRING },
                    instruction: { type: Type.STRING },
                    inputDocIds: { type: Type.ARRAY, items: { type: Type.STRING } },
                    inputFacts: { type: Type.OBJECT }
                },
                required: ["agentType", "instruction", "inputDocIds"]
            }
        },
        findingsForPESAM: {
            type: Type.ARRAY,
            description: "Fakty technologiczne gotowe do przekazania Mózgowi PESAM.",
            items: {
                type: Type.OBJECT,
                properties: {
                    findingId: { type: Type.STRING },
                    category: { type: Type.STRING },
                    facts: { type: Type.OBJECT },
                    confidence: { type: Type.NUMBER },
                    normBasis: { type: Type.STRING }
                },
                required: ["findingId", "category", "facts", "confidence"]
            }
        },
        chatReply: {
            type: Type.ARRAY,
            items: { type: Type.STRING }
        }
    },
    required: ["reasoning", "selfCritique", "nextBestAction", "phase", "currentGoal", "technologicalState", "newTasks", "findingsForPESAM", "chatReply"]
};

// ─────────────────────────────────────────────────────────────────────────────
// FUNKCJE POMOCNICZE I POST HANDLER
// ─────────────────────────────────────────────────────────────────────────────

async function callGeminiWithRetry(fn: () => Promise<any>, retries = 5, delay = 5000): Promise<any> {
    try {
        return await fn();
    } catch (error: any) {
        const errorText = error.toString() || "";
        const isRateLimit = errorText.includes("429") || errorText.includes("RESOURCE_EXHAUSTED");
        if (isRateLimit && retries > 0) {
            console.warn(`[TECHNOLOG 🏗️] Limit 429. Czekam ${delay / 1000}s... (Pozostało prób: ${retries})`);
            await new Promise(resolve => setTimeout(resolve, delay));
            return callGeminiWithRetry(fn, retries - 1, delay * 2);
        }
        throw error;
    }
}

export async function POST(req: Request) {
    try {
        const { tenderId, trigger } = await req.json();
        if (!tenderId) return NextResponse.json({ error: "Brak tenderId" }, { status: 400 });

        console.log(`[TECHNOLOG 🏗️] Cognitive Wake-up. tenderId: ${tenderId} | Trigger: ${trigger}`);

        const techRef = adminDb.collection(`tenders/${tenderId}/technolog`).doc("main");
        const tasksRef = adminDb.collection(`tenders/${tenderId}/technolog_tasks`);
        const tenderRef = adminDb.collection("tenders").doc(tenderId);

        const tenderDoc = await tenderRef.get();
        if (tenderDoc.exists && tenderDoc.data()?.status === "HALTED") {
            return NextResponse.json({ message: "Przetarg zatrzymany (HALTED)." });
        }

        const activeTasksSnap = await tasksRef.where("status", "in", ["PENDING", "IN_PROGRESS"]).get();
        const now = Date.now();
        const TIMEOUT_MS = 10 * 60 * 1000;
        const lockBatch = adminDb.batch();
        let trulyActiveCount = 0;

        activeTasksSnap.docs.forEach(doc => {
            const data = doc.data();
            const lastActive = data.updatedAt?.toMillis?.() || data.createdAt?.toMillis?.() || now;
            if (now - lastActive >= TIMEOUT_MS) {
                lockBatch.set(doc.ref, { status: "ERROR", rawResult: { error: "TIMEOUT_EXCEEDED" }, processedByTechnolog: false, updatedAt: new Date() }, { merge: true });
            } else {
                trulyActiveCount++;
            }
        });

        if (trulyActiveCount > 0) {
            await lockBatch.commit();
            return NextResponse.json({ message: "Agenci Technologa pracują..." });
        }
        await lockBatch.commit();

        const [docsSnap, techSnap, unprocessedTasksSnap, allTasksSnap, pesamBrainSnap, chatSnap] = await Promise.all([
            adminDb.collection(`tenders/${tenderId}/documents`).get(),
            techRef.get(),
            tasksRef.where("status", "in", ["DONE", "ERROR"]).where("processedByTechnolog", "==", false).get(),
            tasksRef.get(),
            adminDb.collection(`tenders/${tenderId}/brain`).doc("main").get(),
            adminDb.collection(`tenders/${tenderId}/chat`).orderBy("timestamp", "asc").limit(10).get()
        ]);

        const documents = docsSnap.docs.map(d => ({
            id: d.id,
            fileName: d.data().fileName,
            tags: d.data().tags || [],
            summary: d.data().summary || "(brak)",
            detailedElement: d.data().detailedElement || "NIE_DOTYCZY",
            containsDrawings: d.data().containsDrawings || false,
            containsTablesWithDimensions: d.data().containsTablesWithDimensions || false
        }));

        const currentTechData = techSnap.exists ? techSnap.data() : {};
        const currentTechState = currentTechData?.technologicalState || {
            objectProfile: {}, confirmedMaterials: [], derivedParameters: [], quantityIndicators: [], technologicalConflicts: [], technologicalGaps: []
        };

        const pesamKnownFacts = pesamBrainSnap.exists ? (pesamBrainSnap.data()?.cognitiveState?.knownFacts || {}) : {};
        const newlyFinishedResults = unprocessedTasksSnap.docs.map(d => ({
            taskId: d.id, agentType: d.data().agentType, status: d.data().status, instruction: d.data().instruction, rawResult: d.data().rawResult
        }));

        const taskHistory = allTasksSnap.docs.map(d => ({
            agentType: d.data().agentType, status: d.data().status,
            resultSummary: d.data().status === "DONE" ? (d.data().rawResult?.summary || "Wykonano") : (d.data().rawResult?.error || "BŁĄD")
        }));

        const chatHistory = chatSnap.docs.map(c => ({ rola: c.data().role, treść: c.data().content }));

        const existingFindingsSnap = await adminDb.collection(`tenders/${tenderId}/technologistFindings`).get();
        const existingFindings = existingFindingsSnap.docs.map(d => ({ category: d.data().category, confidence: d.data().confidence }));

        const systemPrompt = `Jesteś Technologiem Budowlanym – autonomicznym ekspertem technicznym w systemie PESAM 3.0.

=== TWOJA ROLA ===
Pracujesz równolegle do Kosztorysanta. Twoja domena to TECHNOLOGIA (z czego to jest, jak to zbudować, normy WT2021).
PESAM czeka na Twoje ustalenia (findings) by automatycznie wycenić luki w kosztorysie.

=== TWOJE NARZĘDZIA ===
${JSON.stringify(TECHNOLOG_AGENTS.map(a => ({ name: a.name, opis: a.description })), null, 2)}

=== DOKUMENTY PROJEKTU ===
${JSON.stringify(documents, null, 2)}

=== CO JUŻ WIE KOSZTORYSANT ===
${JSON.stringify(pesamKnownFacts, null, 2)}

=== TWÓJ STAN TECHNOLOGICZNY ===
${JSON.stringify(currentTechState, null, 2)}

=== WYNIKI AGENTÓW ===
${JSON.stringify(newlyFinishedResults, null, 2)}

=== FAKTY JUŻ PRZEKAZANE ===
${JSON.stringify(existingFindings, null, 2)}

=== CO MASZ TERAZ ZRObić ===
Zaktualizuj technologicalState. Jeśli masz pewne fakty (>70%), zapisz je do findingsForPESAM. Nie generuj w newTasks standardowych pól, skup się na lukach technologicznych.`;

        const result = await callGeminiWithRetry(async () => {
            return await ai.models.generateContent({
                model: MODEL_FLASH,
                contents: systemPrompt,
                config: {
                    temperature: 0.3,
                    responseMimeType: "application/json",
                    responseSchema: TECHNOLOG_SCHEMA as any
                }
            });
        });

        const parsed = JSON.parse(result.text ?? "{}");
        const batch = adminDb.batch();

        unprocessedTasksSnap.docs.forEach(doc => batch.set(doc.ref, { processedByTechnolog: true }, { merge: true }));

        batch.set(techRef, {
            phase: parsed.phase,
            currentGoal: parsed.currentGoal,
            technologicalState: parsed.technologicalState,
            reasoning: parsed.reasoning,
            updatedAt: new Date()
        }, { merge: true });

        if (parsed.findingsForPESAM?.length > 0) {
            parsed.findingsForPESAM.forEach((finding: any) => {
                const findingRef = adminDb.collection(`tenders/${tenderId}/technologistFindings`).doc(finding.findingId || randomUUID());
                batch.set(findingRef, { ...finding, createdAt: new Date(), updatedAt: new Date(), source: "TECHNOLOG" }, { merge: true });
            });
            batch.set(tenderRef, { hasNewTechnologistFindings: true, lastTechnologistUpdate: new Date() }, { merge: true });
        }

        const newTasksCreated: any[] = [];
        (parsed.newTasks || []).forEach((task: any) => {
            const taskRef = tasksRef.doc();
            const taskData = {
                taskId: taskRef.id,
                agentType: task.agentType,
                instruction: task.instruction,
                inputDocIds: task.inputDocIds || [],
                inputFacts: task.inputFacts || {},
                status: "PENDING",
                processedByTechnolog: false,
                createdAt: new Date(),
                updatedAt: new Date()
            };
            batch.set(taskRef, taskData);
            newTasksCreated.push(taskData);
        });

        batch.set(tenderRef, {
            "budgetGuard.currentCostUSD": FieldValue.increment(((result.usageMetadata?.totalTokenCount || 0) / 1000) * 0.000015),
            updatedAt: new Date()
        }, { merge: true });

        await batch.commit();

        const localOrigin = `http://localhost:${process.env.PORT || "3000"}`;

        // Pancerne, asynchroniczne wywoływanie agentów z odstępem 3 sekund dla drugiego Mózgu
        const triggerTechAgentsWithPacing = async () => {
            for (let i = 0; i < newTasksCreated.length; i++) {
                const task = newTasksCreated[i];
                const agentDef = TECHNOLOG_AGENTS.find(a => a.name === task.agentType);
                if (agentDef?.endpoint) {
                    if (i > 0) await new Promise(r => setTimeout(r, 3000)); // Bezpieczna pauza

                    await fetch(`${localOrigin}${agentDef.endpoint}`, {
                        method: "POST", headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ tenderId, taskId: task.taskId })
                    }).catch(() => { });
                }
            }
        };

        // Oczekujemy na wybudzenie wszystkich agentów, aby Cloud Run nie zamroził kontenera przed rozesłaniem żądań!
        await triggerTechAgentsWithPacing();

        if (parsed.findingsForPESAM?.length > 0 && parsed.phase !== "DONE") {
            await fetch(`${localOrigin}/api/kosztorysant/glowny-kosztorysant`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ tenderId, trigger: "TECHNOLOGIST_NEW_FINDINGS" })
            }).catch(() => { });
        }

        return NextResponse.json({ success: true, phase: parsed.phase, tasksCreated: newTasksCreated.length });
    } catch (error: any) {
        console.error("[TECHNOLOG 🏗️] Krytyczny błąd:", error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}