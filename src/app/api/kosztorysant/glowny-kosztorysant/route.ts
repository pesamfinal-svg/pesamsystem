import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { FieldValue } from "firebase-admin/firestore";
import { GoogleGenAI, Type } from "@google/genai";
import { randomUUID } from "crypto";
import dns from "dns";
dns.setDefaultResultOrder("ipv4first");

export const dynamic = "force-dynamic";

const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
    location: "global"
});

const MODEL_PRO = "gemini-2.5-pro";

async function callGeminiWithRetry(fn: () => Promise<any>, retries = 5, delay = 5000): Promise<any> {
    try {
        return await fn();
    } catch (error: any) {
        const errorText = error.toString() || "";
        const isRateLimit = errorText.includes("429") || errorText.includes("RESOURCE_EXHAUSTED");
        if (isRateLimit && retries > 0) {
            console.warn(`[MÓZG 🧠] Limit API 429. Czekam ${delay / 1000}s... (Pozostało prób: ${retries})`);
            await new Promise(resolve => setTimeout(resolve, delay));
            return callGeminiWithRetry(fn, retries - 1, delay * 2);
        }
        throw error;
    }
}

const BRAIN_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        reasoning: {
            type: Type.STRING,
            description: `Twój tok rozumowania. Przeanalizuj swój 'World Model', oceń które z założeń są najbardziej ryzykowne i co musisz zrobić, by zmniejszyć niepewność kosztorysu.`
        },
        selfCritique: {
            type: Type.STRING,
            description: `Samokrytyka: Dlaczego mój kosztorys na tym etapie może być drastycznie błędny? Które z moich założeń mogłyby wywrócić budżet o ponad 10% jeśli są mylne?`
        },
        nextBestAction: {
            type: Type.STRING,
            description: `Jaka pojedyncza informacja/akcja najbardziej zwiększy w tym momencie jakość kosztorysu? Zdefiniuj JEDEN najważniejszy cel na teraz.`
        },
        cognitiveState: {
            type: Type.OBJECT,
            description: `Twój wewnętrzny stan poznawczy inwestycji. Ewoluuje z każdym cyklem. Nie masz zakodowanych sztywno branż – sam je budujesz.`,
            properties: {
                worldModel: {
                    type: Type.ARRAY,
                    description: `Opisz tu hierarchiczny, strukturalny model obiektu, który wyłania się z danych.`,
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            entity: { type: Type.STRING, description: "Nazwa elementu, np. 'Budynek główny', 'Dach', 'Instalacja elektryczna'" },
                            confidence: { type: Type.NUMBER, description: "Pewność istnienia i struktury (0-100)" },
                            attributes: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Cechy, np. 'Powierzchnia: 2500m2', 'Konstrukcja: Żelbet'" },
                            subElements: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Lista nazw elementów podrzędnych" }
                        },
                        required: ["entity", "confidence", "attributes", "subElements"]
                    }
                },
                knownFacts: {
                    type: Type.OBJECT,
                    description: `Słownik twardych faktów bez cienia wątpliwości (np. nazwa inwestora, dokładny adres, wymiar z rysunku).`
                },
                hypotheses: {
                    type: Type.ARRAY,
                    description: `Twoje hipotezy (np. "To prawdopodobnie budynek pasywny"). Zawsze weryfikuj (Belief Revision).`,
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            statement: { type: Type.STRING },
                            confidence: { type: Type.NUMBER, description: "Pewność (0-100)" },
                            evidence: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Lista twardych dowodów (np. 'Wzmianka w SWZ str. 5')" }
                        },
                        required: ["statement", "confidence", "evidence"]
                    }
                },
                assumptions: {
                    type: Type.ARRAY,
                    description: `Twarde założenia by wycenić braki (np. "Zakładam fundamenty żelbetowe ciągłe").`,
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            statement: { type: Type.STRING },
                            confidence: { type: Type.NUMBER, description: "Pewność (0-100)" },
                            evidence: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Z czego to wywnioskowałeś? (np. 'Typowy standard dla szkół wg norm')" }
                        },
                        required: ["statement", "confidence", "evidence"]
                    }
                },
                knowledgeGaps: {
                    type: Type.ARRAY,
                    description: `Luki w wiedzy. ZAWSZE oceniaj ich 'economicImpactScore' – jak bardzo ten brak wiedzy rozsadzi kosztorys. Skupiaj się tylko na 80-100 pkt.`,
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            topic: { type: Type.STRING },
                            economicImpactScore: { type: Type.NUMBER, description: "Wpływ na kosztorys w skali 1-100" }
                        },
                        required: ["topic", "economicImpactScore"]
                    }
                },
                failedStrategies: {
                    type: Type.ARRAY,
                    description: `Pamięć błędów i ślepych uliczek. Co nie zadziałało? Zapisz by tego nie powtarzać.`,
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            strategy: { type: Type.STRING, description: "Np. 'Szukanie powierzchni dachu w dokumencie SWZ'" },
                            reason: { type: Type.STRING, description: "Np. 'Agent nie znalazł, brak zapisu w tekście'" }
                        },
                        required: ["strategy", "reason"]
                    }
                }
            },
            required: ["worldModel", "knownFacts", "hypotheses", "assumptions", "knowledgeGaps", "failedStrategies"]
        },
        chatReply: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: `Komunikacja z użytkownikiem. UŻYwaj TYLKO ostateczności (spór prawny, brak finansowania). Nie pytaj o braki techniczne (masz hipotezy i narzędzia).`
        },
        newEstimateItems: {
            type: Type.ARRAY,
            description: `KRYTYCZNE: Możesz wygenerować pozycję kosztorysową TYLKO, gdy 'confidence' hipotezy/założenia dla tej roboty wynosi MINIMUM 75. Jeśli masz mniejszą pewność, wstrzymaj się i zleć narzędziom zbadanie luki (knowledgeGap).`,
            items: {
                type: Type.OBJECT,
                properties: {
                    sectionName: { type: Type.STRING },
                    pozycja: { type: Type.STRING },
                    opis: { type: Type.STRING, description: `Opis roboty. Oznacz w nim wyraźnie procent pewności (np. "Izolacja fundamentów [Pewność: 85%]").` },
                    ilosc: { type: Type.NUMBER },
                    jednostka: { type: Type.STRING },
                    KNR_ref: { type: Type.STRING }
                },
                required: ["sectionName", "pozycja", "opis", "ilosc", "jednostka"]
            }
        },
        phase: {
            type: Type.STRING,
            description: `PLANNING, WORKING, WAITING_INPUT lub DONE.`
        },
        currentGoal: {
            type: Type.STRING,
            description: "Jedno zdanie: co próbujesz udowodnić / zweryfikować w tej turze."
        },
        newTasks: {
            type: Type.ARRAY,
            description: `Zadania dla Narzędzi. Wyślij narzędzie do zbadania 'knowledgeGaps' o najwyższym 'economicImpactScore'. Nigdy nie powtarzaj akcji z 'failedStrategies'.`,
            items: {
                type: Type.OBJECT,
                properties: {
                    agentType: { type: Type.STRING, description: "Wybierz nazwę dostępnego narzędzia." },
                    instruction: { type: Type.STRING, description: `Rozkaz dla narzędzia. Czego konkretnie ma szukać by potwierdzić/obalić Twoją Hipotezę.` },
                    inputDocIds: { type: Type.ARRAY, items: { type: Type.STRING } },
                    inputFactsKeys: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Klucze z knownFacts potrzebne narzędziu." }
                },
                required: ["agentType", "instruction", "inputDocIds"]
            }
        }
    },
    required: ["reasoning", "selfCritique", "nextBestAction", "cognitiveState", "chatReply", "newEstimateItems", "phase", "currentGoal", "newTasks"]
};

export async function POST(req: Request) {
    try {
        const { tenderId, trigger } = await req.json();
        if (!tenderId) return NextResponse.json({ error: "Brak tenderId" }, { status: 400 });

        console.log(`[MÓZG 🧠] Cognitive Wake-up. tenderID: ${tenderId} | Trigger: ${trigger}`);

        const tasksRef = adminDb.collection(`tenders/${tenderId}/tasks`);
        const brainRef = adminDb.collection(`tenders/${tenderId}/brain`).doc("main");
        const tenderRef = adminDb.collection("tenders").doc(tenderId);

        let agentRegistrySnap = await adminDb.collection("agentRegistry").get();
        if (agentRegistrySnap.empty) {
            const defaultAgents = [
                { name: "VISION", endpoint: "/api/kosztorysant/agent-wbs-architekt", capabilities: ["vision", "pdf_parsing"], description: "Narzędzie (Skaner). Czyta wymiary, przekroje i legendy z PDF z rysunkami." },
                { name: "LEGAL_EXPERT", endpoint: "/api/kosztorysant/czytacz-dokumentow", capabilities: ["text_analysis"], description: "Narzędzie (Skaner tekstu). Szuka słów kluczowych o umowach, karach i SWZ." },
                { name: "PYTHON_CALC", endpoint: "/api/kosztorysant/agent-python-calc", capabilities: ["codeExecution"], description: "Narzędzie (Kalkulator). Odpal by przemnożyć setki liczb wyciągniętych przez inne narzędzia." },
                { name: "BROKER", endpoint: "/api/kosztorysant/broker-cenowy", capabilities: ["googleSearch"], description: "Narzędzie (Pobieracz stawek). Wezwij by wrzucił ceny R/M/S do gotowych pozycji." },
                { name: "BUDOWLANIEC", endpoint: "/api/kosztorysant/agent-budowlaniec", capabilities: ["engineering", "googleSearch"], description: "Narzędzie (Wyszukiwarka Norm). Poproś go, by wrzucił technologię domyślną z norm dla np. szkół czy bloków, gdy masz lukę." },
                { name: "SILENT_AUDITOR", endpoint: "/api/kosztorysant/agent-cichy-rewident", capabilities: ["audit", "googleSearch"], description: "Narzędzie (Audytor Prawny). Waliduje gotowe pozycje z WT2021 i PPOŻ." },
                { name: "GAP_FILLER", endpoint: "/api/kosztorysant/agent-gap-filler", capabilities: ["estimation", "googleSearch"], description: "Narzędzie (Szacowarka). Wycenia wskaźnikowo to, co ma 'economicImpactScore' wysoki a brakuje rysunków." },
                { name: "BOQ_PARSER", endpoint: "/api/kosztorysant/agent-ilosciowiec", capabilities: ["table_parsing"], description: "Narzędzie (Ekstraktor Excel/PDF). Ściąga czyste dane tabelaryczne z przedmiarów." },
                { name: "KAMELEON", endpoint: "/api/kosztorysant/agent-kameleon", capabilities: ["specialist_analysis"], description: "Narzędzie (Skaner specjalistyczny). Czyta dziwne i wąskie opisy technologii." },
                { name: "REVISOR_JUDGE", endpoint: "/api/kosztorysant/agent-rewident", capabilities: ["legal_reasoning", "googleSearch"], description: "Narzędzie (Solver konfliktów)." },
                { name: "MAPPING_DETECTIVE", endpoint: "/api/kosztorysant/agent-detektyw", capabilities: ["pdf_parsing", "correlations"], description: "Narzędzie (Korelator PDF). Łączy 2 pliki pdf w wymiar 3D." }
            ];
            const seedBatch = adminDb.batch();
            for (const agent of defaultAgents) seedBatch.set(adminDb.collection("agentRegistry").doc(agent.name), agent);
            await seedBatch.commit();
            agentRegistrySnap = await adminDb.collection("agentRegistry").get();
        }
        const availableAgents = agentRegistrySnap.docs.map(d => d.data());

        const activeTasksSnap = await tasksRef.where("status", "in", ["PENDING", "IN_PROGRESS"]).get();
        const now = Date.now();
        const TIMEOUT_MS = 10 * 60 * 1000;
        const lockBatch = adminDb.batch();
        let trulyActiveCount = 0;

        activeTasksSnap.docs.forEach(doc => {
            const data = doc.data();
            const lastActive = data.updatedAt?.toMillis?.() || data.createdAt?.toMillis?.() || now;
            if (now - lastActive >= TIMEOUT_MS) {
                lockBatch.update(doc.ref, {
                    status: "ERROR",
                    rawResult: { error: "TIMEOUT_EXCEEDED" },
                    processedByBrain: false,
                    updatedAt: new Date()
                });
            } else {
                trulyActiveCount++;
            }
        });

        if (trulyActiveCount > 0) {
            await lockBatch.commit();
            console.log(`[MÓZG 🧠] Czekam... Narzędzia przetwarzają dane (${trulyActiveCount} aktywnych).`);
            return NextResponse.json({ message: "Narzędzia pracują..." });
        }
        await lockBatch.commit();

        const [
            docsSnap,
            brainSnap,
            unprocessedTasksSnap,
            tenderDoc,
            chatHistSnap,
            estimateSnap,
            allTasksHistorySnap
        ] = await Promise.all([
            adminDb.collection(`tenders/${tenderId}/documents`).get(),
            brainRef.get(),
            tasksRef.where("status", "in", ["DONE", "ERROR"]).where("processedByBrain", "==", false).get(),
            tenderRef.get(),
            adminDb.collection(`tenders/${tenderId}/chat`).orderBy("timestamp", "asc").limit(20).get(),
            adminDb.collection(`tenders/${tenderId}/estimate`).get(),
            tasksRef.get()
        ]);

        if (tenderDoc.exists && tenderDoc.data()?.status === "HALTED") {
            return NextResponse.json({ message: "Przetarg zatrzymany (HALTED)." });
        }

        const documents = docsSnap.docs.map(d => ({
            id: d.id,
            fileName: d.data().fileName,
            tags: d.data().tags || [],
            summary: d.data().summary || "(brak)"
        }));

        const currentBrainData = brainSnap.exists ? brainSnap.data() : {};
        const currentCognitiveState = currentBrainData?.cognitiveState || {
            worldModel: [],
            knownFacts: {},
            hypotheses: [],
            assumptions: [],
            knowledgeGaps: [],
            failedStrategies: []
        };

        const chatHistory = chatHistSnap.docs.map(c => ({ rola: c.data().role, treść: c.data().content }));
        const newlyFinishedResults = unprocessedTasksSnap.docs.map(d => ({ taskId: d.id, agentType: d.data().agentType, status: d.data().status, instruction: d.data().instruction, rawResult: d.data().rawResult }));
        const taskHistory = allTasksHistorySnap.docs.map(d => ({ agentType: d.data().agentType, status: d.data().status, resultSummary: d.data().status === "DONE" ? (d.data().rawResult?.summary || `Wykonano`) : (d.data().rawResult?.error || "BŁĄD") }));

        const estimateState = estimateSnap.docs.map(d => ({ sekcja: d.data().section, liczba_pozycji: d.data().items?.length || 0, wartosc_zl: d.data().totalValue || 0 }));
        const isEstimateEmpty = estimateState.length === 0 || estimateState.every(s => s.liczba_pozycji === 0);

        const systemPrompt = `Jesteś Mózgiem (Orkiestratorem), jedynym Inżynierem i Architektem systemu. 

=== ZASADA DZIAŁANIA (COGNITIVE ARCHITECTURE) ===
Nie jesteś tu by ślepo delegować zadania do ekspertów. TO TY JESTEŚ JEDYNYM EKSPERTEM.
Twój proces myślowy to: 
1. Budowa hipotezy czym jest inwestycja (Cognitive State -> worldModel).
2. BELIEF REVISION (Rewizja Przekonań): Konfrontuj nowe dane od narzędzi ze starymi hipotezami. Obniżaj lub podnoś pewność, żądaj dowodów (evidence).
3. Wykrywanie luk w Twojej wiedzy. Oblicz ich Wpływ Ekonomiczny (Economic Impact Score 1-100).
4. Wysyłanie "Głupich Narzędzi" TYLKO by zweryfikować luki o najwyższym ryzyku finansowym.
5. Generowanie pozycji do kosztorysu WYŁĄCZNIE, gdy masz pewność (confidence) danego faktu/założenia na poziomie MINIMUM 75%.

=== TWOJE NARZĘDZIA ===
${JSON.stringify(availableAgents.map(a => ({ name: a.name, opis: a.description, mozliwosci: a.capabilities })), null, 2)}

=== DOKUMENTY (Wejście sensoryczne) ===
${JSON.stringify(documents, null, 2)}

=== TWÓJ AKTUALNY STAN POZNAWCZY (Z poprzedniej tury) ===
${JSON.stringify(currentCognitiveState, null, 2)}

=== ODPOWIEDZI OD NARZĘDZI (Świeże dane do strawienia) ===
${JSON.stringify(newlyFinishedResults, null, 2)}

=== HISTORIA URUCHOMIONYCH NARZĘDZI ===
${JSON.stringify(taskHistory, null, 2)}

=== AKTUALNY STAN KOSZTORYSU ===
${isEstimateEmpty ? "⚠️ KOSZTORYS JEST PUSTY. Szukaj luk kosztotwórczych (80-100 pkt) i twardych faktów." : JSON.stringify(estimateState, null, 2)}

=== HISTORIA CZATU Z KOSZTORYSANTEM ===
${chatHistory.length > 0 ? JSON.stringify(chatHistory, null, 2) : "(brak wiadomości)"}

=== CO MASZ ZROBIĆ ===
Zaktualizuj swój CognitiveState. Przerób nowe wyniki w fakty, zweryfikuj stare hipotezy (Belief Revision).
Przeprowadź Samokrytykę. Ustal 'nextBestAction'. Pamiętaj o 'failedStrategies' by nie kręcić się w kółko!`;

        console.log(`[MÓZG 🧠] Prompt Poznawczy wygenerowany. Trawienie danych...`);

        const result = await callGeminiWithRetry(async () => {
            return await ai.models.generateContent({
                model: MODEL_PRO,
                contents: systemPrompt,
                config: {
                    temperature: 0.4, // Analityczny chłód i konsekwencja 
                    responseMimeType: "application/json",
                    responseSchema: BRAIN_SCHEMA as any
                }
            });
        });

        const parsedResult = JSON.parse(result.text ?? "{}");
        console.log(`[MÓZG 🧠] Next Best Action: ${parsedResult.nextBestAction}`);
        console.log(`[MÓZG 🧠] Self-Critique: ${parsedResult.selfCritique?.substring(0, 80)}...`);

        const batch = adminDb.batch();

        unprocessedTasksSnap.docs.forEach(doc => batch.update(doc.ref, { processedByBrain: true }));

        if (parsedResult.chatReply?.length > 0) {
            parsedResult.chatReply.forEach((msg: string) => {
                const ref = adminDb.collection(`tenders/${tenderId}/chat`).doc();
                batch.set(ref, { role: "brain", content: msg, timestamp: FieldValue.serverTimestamp(), intent: "BRAIN_MESSAGE" });
            });
        }

        batch.update(brainRef, {
            phase: parsedResult.phase,
            currentGoal: parsedResult.currentGoal,
            cognitiveState: parsedResult.cognitiveState,
            reasoningLog: FieldValue.arrayUnion(`Reasoning: ${parsedResult.reasoning || ""} | Next Action: ${parsedResult.nextBestAction || ""}`)
        });

        if (parsedResult.newEstimateItems?.length > 0) {
            console.log(`[MÓZG 🧠] Zapisuję ${parsedResult.newEstimateItems.length} zweryfikowanych pozycji (>75% pewności).`);
            const sectionsMap = new Map<string, any[]>();
            parsedResult.newEstimateItems.forEach((item: any) => {
                const sec = item.sectionName || "Ogólne";
                if (!sectionsMap.has(sec)) sectionsMap.set(sec, []);
                sectionsMap.get(sec)!.push(item);
            });

            for (const [sectionName, items] of sectionsMap.entries()) {
                const sectionId = `sec_${sectionName.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 30)}`;
                const sectionRef = adminDb.collection(`tenders/${tenderId}/estimate`).doc(sectionId);

                const formattedItems = items.map((item: any) => ({
                    id: randomUUID(),
                    pozycja: item.pozycja || "",
                    opis: item.opis || "",
                    ilosc: Number(item.ilosc) || 0,
                    jednostka: item.jednostka || "szt",
                    cenaJed: 0,
                    KNR_ref: item.KNR_ref || "",
                    confidence: "AI_COGNITIVE_MODEL",
                    sourceTrack: `Model Poznawczy Mózgu`
                }));

                batch.set(sectionRef, { section: sectionName, status: "QUANTITY_READY", items: formattedItems, totalValue: 0, updatedAt: new Date() }, { merge: true });
                formattedItems.forEach(fItem => { batch.set(sectionRef.collection("items").doc(fItem.id), fItem); });
            }
        }

        const newTasksCreated: any[] = [];
        (parsedResult.newTasks || []).forEach((task: any) => {
            const taskRef = tasksRef.doc();
            const inputFacts: Record<string, any> = {};
            (task.inputFactsKeys || []).forEach((key: string) => {
                if (parsedResult.cognitiveState?.knownFacts && parsedResult.cognitiveState.knownFacts[key] !== undefined) {
                    inputFacts[key] = parsedResult.cognitiveState.knownFacts[key];
                }
            });

            const taskData = {
                taskId: taskRef.id,
                agentType: task.agentType,
                instruction: task.instruction,
                inputDocIds: task.inputDocIds || [],
                inputFacts,
                status: "PENDING",
                processedByBrain: false,
                createdAt: new Date(),
                updatedAt: new Date()
            };
            batch.set(taskRef, taskData);
            newTasksCreated.push(taskData);
        });

        const newTenderStatus = parsedResult.phase === "DONE" ? "DONE" : parsedResult.phase === "WAITING_INPUT" ? "WAITING_INPUT" : "ORCHESTRATING";

        batch.update(tenderRef, {
            "budgetGuard.currentCostUSD": FieldValue.increment(((result.usageMetadata?.totalTokenCount || 0) / 1000) * 0.002),
            status: newTenderStatus,
            updatedAt: new Date()
        });

        await batch.commit();
        console.log(`[MÓZG 🧠] Batch zapisany. Status: ${newTenderStatus}. Wysyłam ${newTasksCreated.length} narzędzi na zwiady.`);

        const localOrigin = `http://localhost:${process.env.PORT || "3000"}`;
        for (const task of newTasksCreated) {
            const agentDef = availableAgents.find(a => a.name === task.agentType);
            if (agentDef?.endpoint) {
                fetch(`${localOrigin}${agentDef.endpoint}`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ tenderId, taskId: task.taskId })
                }).catch(err => console.error(`[MÓZG 🧠] Błąd uruchamiania narzędzia ${task.agentType}:`, err.message));
            } else {
                await adminDb.collection(`tenders/${tenderId}/tasks`).doc(task.taskId).update({
                    status: "ERROR", rawResult: { error: `Narzędzie "${task.agentType}" nie istnieje w rejestrze.` }, processedByBrain: false, updatedAt: new Date()
                }).catch(() => { });
            }
        }

        return NextResponse.json({ success: true, phase: parsedResult.phase, tasksCreated: newTasksCreated.length, estimateItemsAdded: parsedResult.newEstimateItems?.length || 0 });

    } catch (error: any) {
        console.error("[MÓZG 🧠] ❌ Krytyczny błąd Mózgu:", error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}