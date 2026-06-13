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

// ─────────────────────────────────────────────────────────────────
// BRAIN SCHEMA — dynamiczny extractionProfile w newTasks
// ─────────────────────────────────────────────────────────────────

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
        assumptionMode: {
            type: Type.BOOLEAN,
            description: `Ustaw na TRUE TYLKO jeśli świadomie decydujesz się na wycenę koncepcyjną z powodu braku dokumentacji technicznej.`
        },
        assumptionDisclaimer: {
            type: Type.STRING,
            description: `Wyraźne, profesjonalne ostrzeżenie dla Kosztorysanta – z jakich źródeł i norm korzystasz oraz jakie ryzyko niesie ten tryb.`
        },
        cognitiveState: {
            type: Type.OBJECT,
            description: `Twój wewnętrzny stan poznawczy inwestycji. Ewoluuje z każdym cyklem.`,
            properties: {
                worldModel: {
                    type: Type.ARRAY,
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            entity: { type: Type.STRING },
                            confidence: { type: Type.NUMBER },
                            attributes: { type: Type.ARRAY, items: { type: Type.STRING } },
                            subElements: { type: Type.ARRAY, items: { type: Type.STRING } }
                        },
                        required: ["entity", "confidence", "attributes", "subElements"]
                    }
                },
                knownFacts: { type: Type.OBJECT },
                hypotheses: {
                    type: Type.ARRAY,
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            statement: { type: Type.STRING },
                            confidence: { type: Type.NUMBER },
                            evidence: { type: Type.ARRAY, items: { type: Type.STRING } }
                        },
                        required: ["statement", "confidence", "evidence"]
                    }
                },
                assumptions: {
                    type: Type.ARRAY,
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            statement: { type: Type.STRING },
                            confidence: { type: Type.NUMBER },
                            evidence: { type: Type.ARRAY, items: { type: Type.STRING } }
                        },
                        required: ["statement", "confidence", "evidence"]
                    }
                },
                knowledgeGaps: {
                    type: Type.ARRAY,
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            topic: { type: Type.STRING },
                            economicImpactScore: { type: Type.NUMBER }
                        },
                        required: ["topic", "economicImpactScore"]
                    }
                },
                failedStrategies: {
                    type: Type.ARRAY,
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            strategy: { type: Type.STRING },
                            reason: { type: Type.STRING }
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
            description: `Komunikacja z użytkownikiem. Używaj TYLKO w ostateczności.`
        },
        newEstimateItems: {
            type: Type.ARRAY,
            items: {
                type: Type.OBJECT,
                properties: {
                    sectionName: { type: Type.STRING },
                    pozycja: { type: Type.STRING },
                    opis: { type: Type.STRING },
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
        currentGoal: { type: Type.STRING },
        newTasks: {
            type: Type.ARRAY,
            description: `Zadania dla narzędzi. KLUCZOWE: dla BOQ_PARSER i VISION zawsze dołącz pole extractionProfile z niestandardowymi polami dopasowanymi do luki w wiedzy.`,
            items: {
                type: Type.OBJECT,
                properties: {
                    agentType: { type: Type.STRING },
                    instruction: { type: Type.STRING },
                    inputDocIds: { type: Type.ARRAY, items: { type: Type.STRING } },
                    inputFactsKeys: { type: Type.ARRAY, items: { type: Type.STRING } },

                    // ── DYNAMICZNY PROFIL EKSTRAKCJI (Zaprojektowany przez Mózg) ──
                    extractionProfile: {
                        type: Type.OBJECT,
                        description: `WYMAGANE dla BOQ_PARSER i VISION. Określa dynamiczny kontrakt pól, które agent ma wyciągnąć z dokumentu.`,
                        properties: {
                            contextLabel: {
                                type: Type.STRING,
                                description: "Nazwa kontekstu branżowego pisana dużymi literami z podkreśleniami, np. 'ZBROJENIE_SLUPOW', 'INSTALACJA_PV', 'NAWIERZCHNIA_ASPO'"
                            },
                            modelHint: {
                                type: Type.STRING,
                                description: "Rekomendacja modelu: 'PRO' dla rysunków/planów graficznych, 'FLASH' dla czystych tabel i tekstów."
                            },
                            customFields: {
                                type: Type.ARRAY,
                                description: "Dynamicznie zaprojektowane przez Ciebie zmienne, które chcesz wyciągnąć z pliku w tym zadaniu.",
                                items: {
                                    type: Type.OBJECT,
                                    properties: {
                                        name: { type: Type.STRING, description: "Unikalna nazwa zmiennej w camelCase, np. mocInstalacjiKwp, klasaStali, gruboscPodbudowyCm" },
                                        type: { type: Type.STRING, description: "STRING, NUMBER lub BOOLEAN" },
                                        description: { type: Type.STRING, description: "Precyzyjna instrukcja dla agenta, czego konkretnie ma szukać w pliku na potrzeby tego pola" }
                                    },
                                    required: ["name", "type", "description"]
                                }
                            }
                        },
                        required: ["contextLabel", "modelHint", "customFields"]
                    }
                    // ─────────────────────────────────────────────────────────
                },
                required: ["agentType", "instruction", "inputDocIds"]
            }
        }
    },
    required: ["reasoning", "selfCritique", "nextBestAction", "assumptionMode", "assumptionDisclaimer", "cognitiveState", "chatReply", "newEstimateItems", "phase", "currentGoal", "newTasks"]
};

// Przewodnik projektowania pól na podstawie niepewności
const EXTRACTION_PROFILES_GUIDE = `
=== DYNAMICZNE PROFILE EKSTRAKCJI (extractionProfile) ===

Kiedy zlecasz zadanie do BOQ_PARSER lub VISION, ZAWSZE dynamicznie projektuj strukturę bazy danych przez 'extractionProfile'. Ty decydujesz, jakie pola są kluczowe dla załatania luk (knowledgeGaps).

ZASADY TWORZENIA PÓL (customFields):
1. Dopasuj pola do specyfiki elementu w worldModel.
2. Zmienne nazywaj w camelCase, określaj typ (STRING/NUMBER/BOOLEAN) i daj precyzyjny opis instrukcji.

Przykład dla Instalacji Fotowoltaicznej:
  contextLabel: "INSTALACJA_PV",
  modelHint: "PRO",
  customFields: [
    { name: "mocModuluWp", type: "NUMBER", description: "Moc pojedynczego panelu w Wp" },
    { name: "liczbaModulow", type: "NUMBER", description: "Łączna ilość modułów" },
    { name: "typInwertera", type: "STRING", description: "Dokładny model/moc falownika" }
  ]

Przykład dla Robót Drogowych:
  contextLabel: "ROBOTY_DROGOWE",
  modelHint: "FLASH",
  customFields: [
    { name: "szerokoscJezdniM", type: "NUMBER", description: "Szerokość projektowanej jezdni w metrach" },
    { name: "gruboscAsfaltuCm", type: "NUMBER", description: "Grubość warstwy ścieralnej w centymetrach" }
  ]
`;

export async function POST(req: Request) {
    try {
        const { tenderId, trigger } = await req.json();
        if (!tenderId) return NextResponse.json({ error: "Brak tenderId" }, { status: 400 });

        console.log(`[MÓZG 🧠] Cognitive Wake-up. tenderID: ${tenderId} | Trigger: ${trigger}`);

        const tasksRef = adminDb.collection(`tenders/${tenderId}/tasks`);
        const brainRef = adminDb.collection(`tenders/${tenderId}/brain`).doc("main");
        const tenderRef = adminDb.collection("tenders").doc(tenderId);

        // Seeding agentów
        let agentRegistrySnap = await adminDb.collection("agentRegistry").get();
        if (agentRegistrySnap.empty) {
            console.log("[MÓZG 🧠] Seeding bazy agentów...");
            const defaultAgents = [
                { name: "VISION", endpoint: "/api/kosztorysant/agent-wbs-architekt", capabilities: ["vision", "pdf_parsing"], description: "Narzędzie (Skaner). Czyta wymiary, przekroje i legendy z PDF z rysunkami. WYMAGA extractionProfile." },
                { name: "LEGAL_EXPERT", endpoint: "/api/kosztorysant/czytacz-dokumentow", capabilities: ["text_analysis"], description: "Narzędzie (Skaner tekstu). Szuka słów kluczowych o umowach, karach i SWZ." },
                { name: "PYTHON_CALC", endpoint: "/api/kosztorysant/agent-python-calc", capabilities: ["codeExecution"], description: "Narzędzie (Kalkulator). Odpal by przemnożyć setki liczb wyciągniętych przez inne narzędzia." },
                { name: "BROKER", endpoint: "/api/kosztorysant/broker-cenowy", capabilities: ["googleSearch"], description: "Narzędzie (Pobieracz stawek). Wezwij by wrzucił ceny R/M/S do gotowych pozycji." },
                { name: "BUDOWLANIEC", endpoint: "/api/kosztorysant/agent-budowlaniec", capabilities: ["engineering", "googleSearch"], description: "Narzędzie (Wyszukiwarka Norm). Poproś go, by wrzucił technologię domyślną z norm dla np. szkół czy bloków, gdy masz lukę." },
                { name: "SILENT_AUDITOR", endpoint: "/api/kosztorysant/agent-cichy-rewident", capabilities: ["audit", "googleSearch"], description: "Narzędzie (Audytor Prawny). Waliduje gotowe pozycje z WT2021 i PPOŻ." },
                { name: "GAP_FILLER", endpoint: "/api/kosztorysant/agent-gap-filler", capabilities: ["estimation", "googleSearch"], description: "Narzędzie (Szacowarka). Wycenia wskaźnikowo to, co ma 'economicImpactScore' wysoki a brakuje rysunków." },
                { name: "BOQ_PARSER", endpoint: "/api/kosztorysant/agent-ilosciowiec", capabilities: ["table_parsing"], description: "Narzędzie (Ekstraktor Excel/PDF). Ściąga czyste dane tabelaryczne z przedmiarów. WYMAGA extractionProfile." },
                { name: "KAMELEON", endpoint: "/api/kosztorysant/agent-kameleon", capabilities: ["specialist_analysis"], description: "Narzędzie (Skaner specjalistyczny). Czyta dziwne i wąskie opisy technologii." },
                { name: "REVISOR_JUDGE", endpoint: "/api/kosztorysant/agent-rewident", capabilities: ["legal_reasoning", "googleSearch"], description: "Narzędzie (Solver konfliktów)." },
                { name: "MAPPING_DETECTIVE", endpoint: "/api/kosztorysant/agent-detektyw", capabilities: ["pdf_parsing", "correlations"], description: "Narzędzie (Korelator PDF). Łączy 2 pliki pdf w wymiar 3D." }
            ];
            const seedBatch = adminDb.batch();
            for (const agent of defaultAgents)
                seedBatch.set(adminDb.collection("agentRegistry").doc(agent.name), agent);
            await seedBatch.commit();
            agentRegistrySnap = await adminDb.collection("agentRegistry").get();
        }
        const availableAgents = agentRegistrySnap.docs.map(d => d.data());

        // Sprawdzanie timeoutów zadań
        const activeTasksSnap = await tasksRef.where("status", "in", ["PENDING", "IN_PROGRESS"]).get();
        const now = Date.now();
        const TIMEOUT_MS = 10 * 60 * 1000;
        const lockBatch = adminDb.batch();
        let trulyActiveCount = 0;

        activeTasksSnap.docs.forEach(doc => {
            const data = doc.data();
            const lastActive = data.updatedAt?.toMillis?.() || data.createdAt?.toMillis?.() || now;
            if (now - lastActive >= TIMEOUT_MS) {
                console.log(`[MÓZG 🧠] Oznaczam zawieszone zadanie ${doc.id} jako ERROR.`);
                lockBatch.update(doc.ref, { status: "ERROR", rawResult: { error: "TIMEOUT_EXCEEDED" }, processedByBrain: false, updatedAt: new Date() });
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

        // Pobieranie danych wejściowych i stanu Roju
        const [docsSnap, brainSnap, unprocessedTasksSnap, tenderDoc, chatHistSnap, estimateSnap, allTasksHistorySnap] = await Promise.all([
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
            worldModel: [], knownFacts: {}, hypotheses: [], assumptions: [], knowledgeGaps: [], failedStrategies: []
        };

        const chatHistory = chatHistSnap.docs.map(c => ({ rola: c.data().role, treść: c.data().content }));
        const newlyFinishedResults = unprocessedTasksSnap.docs.map(d => ({
            taskId: d.id, agentType: d.data().agentType, status: d.data().status,
            instruction: d.data().instruction, rawResult: d.data().rawResult,
            extractionProfile: d.data().extractionProfile || null
        }));
        const taskHistory = allTasksHistorySnap.docs.map(d => ({
            agentType: d.data().agentType, status: d.data().status,
            resultSummary: d.data().status === "DONE"
                ? (d.data().rawResult?.summary || "Wykonano")
                : (d.data().rawResult?.error || "BŁĄD"),
            extractionProfile: d.data().extractionProfile || null
        }));

        const estimateState = estimateSnap.docs.map(d => ({ sekcja: d.data().section, liczba_pozycji: d.data().items?.length || 0, wartosc_zl: d.data().totalValue || 0 }));
        const isEstimateEmpty = estimateState.length === 0 || estimateState.every(s => s.liczba_pozycji === 0);

        const systemPrompt = `Jesteś Mózgiem (Orkiestratorem), jedynym Inżynierem i Architektem systemu PESAM 3.0. 

=== ZASADA DZIAŁANIA (COGNITIVE ARCHITECTURE) ===
Nie jesteś tu by ślepo delegować zadania do ekspertów. TO TY JESTEŚ JEDYNYM EKSPERTEM.
Twój proces myślowy to: 
1. Budowa hipotezy czym jest inwestycja (Cognitive State -> worldModel).
2. BELIEF REVISION (Rewizja Przekonań): Konfrontuj nowe dane od narzędzi ze starymi hipotezami. Obniżaj lub podnoś pewność, żądaj dowodów (evidence).
3. Wykrywanie luk w Twojej wiedzy. Oblicz ich Wpływ Ekonomiczny (Economic Impact Score 1-100).
4. Wysyłanie "Głupich Narzędzi" TYLKO by zweryfikować luki o najwyższym ryzyku finansowym.
5. Generowanie pozycji do kosztorysu WYŁĄCZNIE, gdy masz pewność (confidence) danego faktu/założenia na poziomie MINIMUM 75%.

=== TRYB ZAŁOŻEŃ RYNKOWYCH (ASSUMPTION_MODE) ===
Jeśli brakuje krytycznej dokumentacji (np. Załącznik nr 5, rysunki, szczegółowe przedmiary):
- Możesz rozważyć włączenie assumptionMode: true.
- W takim przypadku przygotuj klarowny 'assumptionDisclaimer'.
- Używaj agresywnie BUDOWLANIEC + GAP_FILLER.
- Każdą pozycję wygenerowaną w tym trybie oznacz w opisie jako **[ZAŁOŻENIE RYNKOWE]**.

=== TWOJE NARZĘDZIA ===
${JSON.stringify(availableAgents.map(a => ({ name: a.name, opis: a.description, mozliwosci: a.capabilities })), null, 2)}

${EXTRACTION_PROFILES_GUIDE}

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
Przeprowadź Samokrytykę. Ustal 'nextBestAction'. 
Pamiętaj o 'failedStrategies' by nie kręcić się w kółko!
Gdy tworzysz zadanie dla BOQ_PARSER lub VISION — zawsze dynamicznie zaprojektuj i wypełnij 'extractionProfile'.`;

        console.log(`[MÓZG 🧠] Prompt Poznawczy wygenerowany. Trawienie danych...`);

        const result = await callGeminiWithRetry(async () => {
            return await ai.models.generateContent({
                model: MODEL_PRO,
                contents: systemPrompt,
                config: {
                    temperature: 0.4,
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
            assumptionMode: parsedResult.assumptionMode || false,
            assumptionDisclaimer: parsedResult.assumptionDisclaimer || null,
            reasoningLog: FieldValue.arrayUnion(`Reasoning: ${parsedResult.reasoning || ""} | Next Action: ${parsedResult.nextBestAction || ""}`)
        });

        if (parsedResult.newEstimateItems?.length > 0) {
            console.log(`[MÓZG 🧠] Zapisuję ${parsedResult.newEstimateItems.length} pozycji (>75% pewności lub tryb założeń).`);
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
                    confidence: parsedResult.assumptionMode ? "ASSUMPTION_MODE" : "AI_COGNITIVE_MODEL",
                    sourceTrack: parsedResult.assumptionMode ? "Konceptualizacja Mózgu" : "Model Poznawczy Mózgu"
                }));
                batch.set(sectionRef, { section: sectionName, status: "QUANTITY_READY", items: formattedItems, totalValue: 0, updatedAt: new Date() }, { merge: true });
                formattedItems.forEach(fItem => {
                    batch.set(sectionRef.collection("items").doc(fItem.id), fItem);
                });
            }
        }

        const newTasksCreated: any[] = [];
        (parsedResult.newTasks || []).forEach((task: any) => {
            const taskRef = tasksRef.doc();
            const inputFacts: Record<string, any> = {};
            (task.inputFactsKeys || []).forEach((key: string) => {
                if (parsedResult.cognitiveState?.knownFacts?.[key] !== undefined) {
                    inputFacts[key] = parsedResult.cognitiveState.knownFacts[key];
                }
            });

            if (task.extractionProfile) {
                console.log(`[MÓZG 🧠 LOG] Tworzę zadanie z DYNAMICZNYM PROFILEM EKSTRAKCJI:`);
                console.log(`[MÓZG 🧠 LOG]   - Agent: ${task.agentType}`);
                console.log(`[MÓZG 🧠 LOG]   - Kontekst: ${task.extractionProfile.contextLabel}`);
                console.log(`[MÓZG 🧠 LOG]   - Rekomendowany model: ${task.extractionProfile.modelHint}`);
                console.log(`[MÓZG 🧠 LOG]   - Zaprojektowane pola: ${task.extractionProfile.customFields?.map((f: any) => `${f.name} (${f.type})`).join(", ") || "brak"}`);
            }

            const taskData = {
                taskId: taskRef.id,
                agentType: task.agentType,
                instruction: task.instruction,
                inputDocIds: task.inputDocIds || [],
                inputFacts,
                extractionProfile: task.extractionProfile || null,
                status: "PENDING",
                processedByBrain: false,
                createdAt: new Date(),
                updatedAt: new Date()
            };
            batch.set(taskRef, taskData);
            newTasksCreated.push(taskData);
        });

        const newTenderStatus = parsedResult.phase === "DONE" ? "DONE"
            : parsedResult.phase === "WAITING_INPUT" ? "WAITING_INPUT"
                : "ORCHESTRATING";

        batch.update(tenderRef, {
            "budgetGuard.currentCostUSD": FieldValue.increment(((result.usageMetadata?.totalTokenCount || 0) / 1000) * 0.002),
            status: newTenderStatus,
            updatedAt: new Date()
        });

        await batch.commit();
        console.log(`[MÓZG 🧠] Batch zapisany. Status: ${newTenderStatus}. Narzędzi: ${newTasksCreated.length}.`);

        const localOrigin = `http://localhost:${process.env.PORT || "3000"}`;
        for (const task of newTasksCreated) {
            const agentDef = availableAgents.find(a => a.name === task.agentType);
            if (agentDef?.endpoint) {
                fetch(`${localOrigin}${agentDef.endpoint}`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ tenderId, taskId: task.taskId })
                }).catch(err => console.error(`[MÓZG 🧠] Błąd uruchamiania ${task.agentType}:`, err.message));
            } else {
                await adminDb.collection(`tenders/${tenderId}/tasks`).doc(task.taskId).update({
                    status: "ERROR", rawResult: { error: `Narzędzie "${task.agentType}" nie istnieje w rejestrze.` }, processedByBrain: false, updatedAt: new Date()
                }).catch(() => { });
            }
        }

        return NextResponse.json({
            success: true,
            phase: parsedResult.phase,
            tasksCreated: newTasksCreated.length,
            estimateItemsAdded: parsedResult.newEstimateItems?.length || 0
        });

    } catch (error: any) {
        console.error("[MÓZG 🧠] ❌ Krytyczny błąd Mózgu:", error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}