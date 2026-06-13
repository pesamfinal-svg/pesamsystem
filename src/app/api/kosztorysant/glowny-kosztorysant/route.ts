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

// ZMIANA 1: Schema z opisami które faktycznie prowadzą model, nie go wiążą
const BRAIN_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        reasoning: {
            type: Type.STRING,
            description: `Twój wewnętrzny tok myślenia — wypełnij PRZED podjęciem decyzji o zadaniach.
Odpowiedz tu na: Jaki to obiekt i co z dokumentów/czatu o nim wiem? Co agenci już zrobili i co z tego wynika?
Czy kosztorys jest kompletny czy ma dziury? Jakich branż brakuje? Kogo wezwę i dlaczego właśnie ich?
Minimum 5 zdań. To twój dziennik rozumowania — im lepszy, tym lepsze decyzje.`
        },
        updateKnownFacts: {
            type: Type.OBJECT,
            description: `Twarda encyklopedia faktów o projekcie. Wyciągaj z rawResult agentów i z dokumentów.
Klucze opisowe, np: "typ_obiektu", "powierzchnia_m2", "liczba_kondygnacji", "wadium_kwota", "termin_realizacji_dni",
"branze_z_dokumentow", "kary_umowne_procent", "standard_wykonczenia". Dorzucaj fakty z każdej tury.`
        },
        chatReply: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: `Wiadomości do kosztorysanta. UŻYJ TYLKO gdy brakuje informacji prawnie krytycznej,
której NIE MA w żadnym dokumencie i której NIE DA SIĘ wywnioskować ani wyszukać w normach.
Przykłady uzasadniające użycie: brak kwoty wadium w SWZ, sprzeczne zapisy umowy wymagające decyzji inwestora.
Przykłady NIE uzasadniające: brak rysunków (→ BUDOWLANIEC), brak obmiarów (→ BOQ_PARSER lub BUDOWLANIEC),
nieznane ceny materiałów (→ BROKER). Zostaw puste jeśli Rój może działać samodzielnie.`
        },
        newEstimateItems: {
            type: Type.ARRAY,
            description: `Pozycje kosztorysowe wyciągnięte lub zagregowane z wyników agentów.
Wypełniaj gdy masz konkretne ilości z BOQ_PARSER, VISION lub PYTHON_CALC.
Nie wymyślaj ilości — jeśli ich nie masz, zleć właściwego agenta w newTasks.`,
            items: {
                type: Type.OBJECT,
                properties: {
                    sectionName: { type: Type.STRING, description: "Branża/dział kosztorysu, np: 'Roboty ziemne', 'Konstrukcja', 'Instalacje elektryczne'" },
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
            description: `Stan pracy Roju:
PLANNING — zbierasz info, planujesz pierwsze zadania (użyj gdy dopiero startujesz lub trawiłeś wyniki).
WORKING — zadania są w toku lub właśnie zlecasz nowe.
WAITING_INPUT — TYLKO gdy czekasz na odpowiedź kosztorysanta (użyj razem z chatReply).
DONE — kosztorys jest kompletny, wszystkie branże wycenione, nic nie brakuje.`
        },
        currentGoal: {
            type: Type.STRING,
            description: "Jedno zdanie: co aktualnie próbujesz osiągnąć. Widoczne w panelu kosztorysanta."
        },
        newTasks: {
            type: Type.ARRAY,
            description: `Zadania dla agentów. ZASADA: jeśli phase != DONE i != WAITING_INPUT, ta lista nie może być pusta.
Możesz i powinieneś zlecać wiele zadań równolegle — każde trafia do innego agenta jednocześnie.
Nie wzywaj agenta którego już widzisz w historii wykonanych zadań, chyba że masz nowe dane dla niego.`,
            items: {
                type: Type.OBJECT,
                properties: {
                    agentType: {
                        type: Type.STRING,
                        description: "Dokładna nazwa agenta z listy dostępnych, np: BUDOWLANIEC, BOQ_PARSER, LEGAL_EXPERT"
                    },
                    instruction: {
                        type: Type.STRING,
                        description: `Szczegółowa instrukcja dla agenta. Napisz co ma przeanalizować, jakie informacje wyciągnąć,
w jakim formacie zwrócić wynik. Im dokładniejsza instrukcja, tym lepszy wynik agenta.
Podaj mu też kontekst: typ obiektu, standard, lokalizacja — wszystko co wiesz.`
                    },
                    inputDocIds: {
                        type: Type.ARRAY,
                        items: { type: Type.STRING },
                        description: "ID dokumentów z listy DOKUMENTY PROJEKTU które agent ma przeanalizować. Pusta tablica jeśli agent korzysta tylko z faktów."
                    },
                    inputFactsKeys: {
                        type: Type.ARRAY,
                        items: { type: Type.STRING },
                        description: "Klucze z updateKnownFacts które mają trafić do agenta jako kontekst."
                    }
                },
                required: ["agentType", "instruction", "inputDocIds"]
            }
        }
    },
    required: ["reasoning", "updateKnownFacts", "chatReply", "newEstimateItems", "phase", "currentGoal", "newTasks"]
};

export async function POST(req: Request) {
    try {
        const { tenderId, trigger } = await req.json();
        if (!tenderId) return NextResponse.json({ error: "Brak tenderId" }, { status: 400 });

        console.log(`[MÓZG 🧠] Przebudzenie. tenderID: ${tenderId} | Trigger: ${trigger}`);

        const tasksRef = adminDb.collection(`tenders/${tenderId}/tasks`);
        const brainRef = adminDb.collection(`tenders/${tenderId}/brain`).doc("main");
        const tenderRef = adminDb.collection("tenders").doc(tenderId);

        // Seeding agentów (bez zmian w stosunku do oryginału)
        let agentRegistrySnap = await adminDb.collection("agentRegistry").get();
        if (agentRegistrySnap.empty) {
            const defaultAgents = [
                { name: "VISION", endpoint: "/api/kosztorysant/agent-wbs-architekt", capabilities: ["vision", "pdf_parsing"], description: "Analizuje rysunki budowlane i techniczne w PDF/obraz. Wyciąga wymiary, rzuty, przekroje, powierzchnie, ilości z dokumentacji graficznej." },
                { name: "LEGAL_EXPERT", endpoint: "/api/kosztorysant/czytacz-dokumentow", capabilities: ["text_analysis"], description: "Czyta umowy, SWZ, specyfikacje techniczne. Wyciąga: kary umowne, termin realizacji, zakres robót, standard wykonania, wadium, gwarancję, wymagania materiałowe." },
                { name: "PYTHON_CALC", endpoint: "/api/kosztorysant/agent-python-calc", capabilities: ["codeExecution"], description: "Kalkulator. Oblicza dokładne ilości: powierzchnie, objętości, długości — na podstawie wymiarów z faktów. Używaj po VISION lub gdy masz surowe dane liczbowe." },
                { name: "BROKER", endpoint: "/api/kosztorysant/broker-cenowy", capabilities: ["googleSearch"], description: "Wyceniacz rynkowy. Szuka aktualnych cen B2B w Polsce dla gotowych pozycji kosztorysowych. Rozbija na R/M/S. Używaj gdy masz pozycje z ilościami ale bez cen." },
                { name: "BUDOWLANIEC", endpoint: "/api/kosztorysant/agent-budowlaniec", capabilities: ["engineering", "googleSearch"], description: "Inżynier budowy z dostępem do norm i wyszukiwarki. Projektuje kompletną technologię robót od zera — stan zerowy, surowy, wykończenie, instalacje. IDEALNY gdy brakuje obmiarów, rysunków lub przedmiaru. Podaj mu typ obiektu i fakty z umowy, sam doliczy resztę z norm." },
                { name: "SILENT_AUDITOR", endpoint: "/api/kosztorysant/agent-cichy-rewident", capabilities: ["audit", "googleSearch"], description: "Weryfikuje gotowy kosztorys pod kątem przepisów: WT 2021, Sanepid, PPOŻ, PZP. Używaj na końcu, gdy masz już pozycje." },
                { name: "GAP_FILLER", endpoint: "/api/kosztorysant/agent-gap-filler", capabilities: ["estimation", "googleSearch"], description: "Szacuje wskaźnikowo/parametrycznie koszty branż instalacyjnych gdy brakuje rysunków. Użyj dla: wod-kan, elektryki, wentylacji, ogrzewania — gdy nie ma rysunków instalacyjnych." },
                { name: "BOQ_PARSER", endpoint: "/api/kosztorysant/agent-ilosciowiec", capabilities: ["table_parsing"], description: "Czyta ślepe przedmiary: Excel (natywnie, bezbłędnie) i PDF (przez model Pro). Wyciąga pozycje z ilościami. Używaj gdy jest plik przedmiaru lub kosztorysu do przepisania." },
                { name: "KAMELEON", endpoint: "/api/kosztorysant/agent-kameleon", capabilities: ["specialist_analysis"], description: "Specjalista od wąskich branż: technologia basenowa, gazy medyczne, windy, systemy BMS, fotowoltaika. Używaj gdy dokumentacja jest bardzo techniczna i niszowa." },
                { name: "REVISOR_JUDGE", endpoint: "/api/kosztorysant/agent-rewident", capabilities: ["legal_reasoning", "googleSearch"], description: "Sędzia Roju. Rozstrzyga spory między agentami, weryfikuje spójność kosztorysu z PZP i hierarchią dokumentów." },
                { name: "MAPPING_DETECTIVE", endpoint: "/api/kosztorysant/agent-detektyw", capabilities: ["pdf_parsing", "correlations"], description: "Koreluje rzuty 2D z przekrojami pionowymi. Buduje mapę powiązań między rysunkami. Używaj gdy jest wiele rysunków technicznych i trzeba je ze sobą połączyć." }
            ];
            const seedBatch = adminDb.batch();
            for (const agent of defaultAgents) seedBatch.set(adminDb.collection("agentRegistry").doc(agent.name), agent);
            await seedBatch.commit();
            agentRegistrySnap = await adminDb.collection("agentRegistry").get();
        }
        const availableAgents = agentRegistrySnap.docs.map(d => d.data());

        // ZMIANA 2: Timeout detection — zamrożone zadania nie blokują Mózgu w nieskończoność
        const activeTasksSnap = await tasksRef.where("status", "in", ["PENDING", "IN_PROGRESS"]).get();
        const now = Date.now();
        const TIMEOUT_MS = 10 * 60 * 1000;
        const lockBatch = adminDb.batch();
        let trulyActiveCount = 0;

        activeTasksSnap.docs.forEach(doc => {
            const data = doc.data();
            const lastActive = data.updatedAt?.toMillis?.() || data.createdAt?.toMillis?.() || now;
            if (now - lastActive >= TIMEOUT_MS) {
                console.warn(`[MÓZG 🧠] Zadanie ${doc.id} (${data.agentType}) przekroczyło timeout. Oznaczam jako ERROR.`);
                lockBatch.update(doc.ref, {
                    status: "ERROR",
                    rawResult: { error: "TIMEOUT_EXCEEDED", message: "Agent nie odpowiedział w ciągu 10 minut." },
                    processedByBrain: false,
                    updatedAt: new Date()
                });
            } else {
                trulyActiveCount++;
            }
        });

        if (trulyActiveCount > 0) {
            await lockBatch.commit();
            console.log(`[MÓZG 🧠] ${trulyActiveCount} agentów wciąż pracuje. Usypiam do ich odzewu.`);
            return NextResponse.json({ message: "Agenci pracują..." });
        }
        await lockBatch.commit();

        // ZMIANA 3: Pełny zestaw danych dla Mózgu — wszystko w jednym Promise.all
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
            tasksRef.get() // Pełna historia wszystkich zadań
        ]);

        if (tenderDoc.exists && tenderDoc.data()?.status === "HALTED") {
            return NextResponse.json({ message: "Przetarg zatrzymany (HALTED)." });
        }

        const documents = docsSnap.docs.map(d => ({
            id: d.id,
            fileName: d.data().fileName,
            tags: d.data().tags || [],
            summary: d.data().summary || "(brak streszczenia)"
        }));

        const currentBrainState = brainSnap.exists ? brainSnap.data() : { knownFacts: {}, phase: "PLANNING" };

        const chatHistory = chatHistSnap.docs.map(c => ({
            rola: c.data().role,
            treść: c.data().content
        }));

        const newlyFinishedResults = unprocessedTasksSnap.docs.map(d => ({
            taskId: d.id,
            agentType: d.data().agentType,
            status: d.data().status,
            instruction: d.data().instruction,
            rawResult: d.data().rawResult
        }));

        // ZMIANA 4: Historia zadań z pełnym statusem — Mózg wie co się stało z każdym zadaniem
        const taskHistory = allTasksHistorySnap.docs.map(d => ({
            agentType: d.data().agentType,
            status: d.data().status,
            // Skracamy rawResult żeby nie zapychać kontekstu — Mózg dostaje summary
            resultSummary: d.data().status === "DONE"
                ? (d.data().rawResult?.summary || `${d.data().agentType} zakończył pracę`)
                : (d.data().rawResult?.error || "BŁĄD")
        }));

        // Stan kosztorysu — co już jest wycenione
        const estimateState = estimateSnap.docs.map(d => ({
            sekcja: d.data().section,
            status: d.data().status,
            liczba_pozycji: d.data().items?.length || 0,
            wartosc_zl: d.data().totalValue || 0
        }));

        const isEstimateEmpty = estimateState.length === 0 || estimateState.every(s => s.liczba_pozycji === 0);

        // ZMIANA 5: Prompt skupiony na celu i autonomii, nie na regułach
        const systemPrompt = `Jesteś autonomicznym ekspertem ds. kosztorysowania budowlanego — Mózgiem systemu PESAM 3.0.

Twój jedyny cel: zorganizować pracę zespołu AI i doprowadzić do kompletnego kosztorysu tej inwestycji.
Nie dostajesz gotowych reguł co robić. Sam analizujesz sytuację i podejmujesz decyzje jak doświadczony kierownik projektu.

=== DOSTĘPNI AGENCI ===
${JSON.stringify(availableAgents.map(a => ({ name: a.name, opis: a.description, mozliwosci: a.capabilities })), null, 2)}

=== DOKUMENTY PROJEKTU ===
${JSON.stringify(documents, null, 2)}

=== CO JUŻ WIESZ O PROJEKCIE ===
${JSON.stringify(currentBrainState?.knownFacts || {}, null, 2)}

=== WYNIKI AGENTÓW DO STRAWIENIA (nowe, nieprzetworzone) ===
${JSON.stringify(newlyFinishedResults, null, 2)}

=== HISTORIA WSZYSTKICH ZADAŃ (co już zrobiono) ===
${JSON.stringify(taskHistory, null, 2)}

=== AKTUALNY STAN KOSZTORYSU ===
${isEstimateEmpty ? "⚠️ KOSZTORYS JEST PUSTY — żadna pozycja nie została jeszcze wyceniona." : JSON.stringify(estimateState, null, 2)}

=== HISTORIA CZATU Z KOSZTORYSANTEM ===
${chatHistory.length > 0 ? JSON.stringify(chatHistory, null, 2) : "(brak wiadomości)"}

=== JAK MYŚLEĆ ===
W polu "reasoning" przerób sobie te pytania zanim cokolwiek zaplanujesz:
- Jaki to obiekt budowlany? Co wynika z dokumentów i czatu?
- Co agenci już zrobili i jakie fakty z tego wyciągam?
- Czy kosztorys jest kompletny? Jakich branż brakuje?
- Jakie jest moje następne posunięcie i dlaczego?

Pamiętaj o autonomii:
- Brak rysunków lub obmiarów NIE JEST powodem do pytania kosztorysanta — masz BUDOWLANIEC i GAP_FILLER.
- Brak cen NIE JEST powodem do pytania — masz BROKER.
- Pytaj kosztorysanta TYLKO o decyzje prawne/biznesowe których nie ma w żadnym dokumencie.
- Możesz zlecać wielu agentów równolegle — rób to gdy zadania są od siebie niezależne.`;

        console.log(`[MÓZG 🧠] Prompt gotowy. Wysyłam do ${MODEL_PRO}. Nieprzetworzone zadania: ${newlyFinishedResults.length}. Kosztorys pusty: ${isEstimateEmpty}.`);

        const result = await callGeminiWithRetry(async () => {
            return await ai.models.generateContent({
                model: MODEL_PRO,
                contents: systemPrompt,
                config: {
                    // ZMIANA 6: temperatura 0.6 — daje kreatywność w planowaniu bez halucynacji w danych
                    temperature: 0.6,
                    responseMimeType: "application/json",
                    responseSchema: BRAIN_SCHEMA as any
                }
            });
        });

        const parsedResult = JSON.parse(result.text ?? "{}");
        console.log(`[MÓZG 🧠] Reasoning: ${parsedResult.reasoning?.substring(0, 200)}...`);
        console.log(`[MÓZG 🧠] Faza: ${parsedResult.phase}. Nowe zadania: ${parsedResult.newTasks?.length || 0}. Pozycje kosztorysu: ${parsedResult.newEstimateItems?.length || 0}.`);

        const batch = adminDb.batch();

        // Oznacz przetworzone zadania
        unprocessedTasksSnap.docs.forEach(doc => batch.update(doc.ref, { processedByBrain: true }));

        // Wiadomości na czat
        if (parsedResult.chatReply?.length > 0) {
            parsedResult.chatReply.forEach((msg: string) => {
                const ref = adminDb.collection(`tenders/${tenderId}/chat`).doc();
                batch.set(ref, {
                    role: "brain",
                    content: msg,
                    timestamp: FieldValue.serverTimestamp(),
                    intent: "BRAIN_MESSAGE"
                });
            });
        }

        // Aktualizacja stanu Mózgu
        const mergedFacts = {
            ...(currentBrainState?.knownFacts || {}),
            ...(parsedResult.updateKnownFacts || {})
        };

        batch.update(brainRef, {
            phase: parsedResult.phase,
            currentGoal: parsedResult.currentGoal,
            knownFacts: mergedFacts,
            reasoningLog: FieldValue.arrayUnion(parsedResult.reasoning || "")
        });

        // Zapis pozycji kosztorysowych
        if (parsedResult.newEstimateItems?.length > 0) {
            console.log(`[MÓZG 🧠] Zapisuję ${parsedResult.newEstimateItems.length} nowych pozycji do kosztorysu.`);
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
                    confidence: "BRAIN_ESTIMATE",
                    sourceTrack: `Mózg → ${parsedResult.reasoning?.substring(0, 60) || "orkiestracja"}`
                }));

                batch.set(sectionRef, {
                    section: sectionName,
                    status: "QUANTITY_READY",
                    items: formattedItems,
                    totalValue: 0,
                    updatedAt: new Date()
                }, { merge: true });

                formattedItems.forEach(fItem => {
                    batch.set(sectionRef.collection("items").doc(fItem.id), fItem);
                });
            }
        }

        // Tworzenie nowych zadań
        const newTasksCreated: any[] = [];
        (parsedResult.newTasks || []).forEach((task: any) => {
            const taskRef = tasksRef.doc();
            const inputFacts: Record<string, any> = {};
            (task.inputFactsKeys || []).forEach((key: string) => {
                if (mergedFacts[key] !== undefined) inputFacts[key] = mergedFacts[key];
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

        // Aktualizacja statusu przetargu
        const newTenderStatus =
            parsedResult.phase === "DONE" ? "DONE" :
                parsedResult.phase === "WAITING_INPUT" ? "WAITING_INPUT" :
                    "ORCHESTRATING";

        batch.update(tenderRef, {
            "budgetGuard.currentCostUSD": FieldValue.increment(
                ((result.usageMetadata?.totalTokenCount || 0) / 1000) * 0.002
            ),
            status: newTenderStatus,
            updatedAt: new Date()
        });

        await batch.commit();
        console.log(`[MÓZG 🧠] Batch zapisany. Status przetargu: ${newTenderStatus}. Uruchamiam ${newTasksCreated.length} agentów.`);

        // Uruchomienie agentów (fire-and-forget)
        const localOrigin = `http://localhost:${process.env.PORT || "3000"}`;
        for (const task of newTasksCreated) {
            const agentDef = availableAgents.find(a => a.name === task.agentType);
            if (agentDef?.endpoint) {
                console.log(`[MÓZG 🧠] Uruchamiam agenta: ${task.agentType} (task: ${task.taskId})`);
                fetch(`${localOrigin}${agentDef.endpoint}`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ tenderId, taskId: task.taskId })
                }).catch(err => console.error(`[MÓZG 🧠] Błąd uruchamiania ${task.agentType}:`, err.message));
            } else {
                console.error(`[MÓZG 🧠] ⚠️ Nieznany agent: "${task.agentType}" — nie ma go w rejestrze!`);
                await adminDb.collection(`tenders/${tenderId}/tasks`).doc(task.taskId).update({
                    status: "ERROR",
                    rawResult: { error: `Agent "${task.agentType}" nie istnieje w rejestrze.` },
                    processedByBrain: false,
                    updatedAt: new Date()
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