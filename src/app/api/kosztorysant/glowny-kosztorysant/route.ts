import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { FieldValue } from "firebase-admin/firestore";
import { GoogleGenAI, Type } from "@google/genai";
import { randomUUID } from "crypto";

export const dynamic = "force-dynamic";

const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
    location: "global"
});

const MODEL_PRO = "gemini-2.5-pro";

// Schemat odpowiedzi Mózgu
const BRAIN_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        updateKnownFacts: {
            type: Type.OBJECT,
            description: "Słownik (klucz-wartość) nowych faktów do dopisania do pamięci Mózgu na podstawie przeanalizowanych wyników."
        },
        newEstimateItems: {
            type: Type.ARRAY,
            description: "Lista konkretnych pozycji do dodania do Żywego Kosztorysu.",
            items: {
                type: Type.OBJECT,
                properties: {
                    sectionName: { type: Type.STRING, description: "Nazwa sekcji, np. 'Roboty Ziemne', 'Wymogi Prawne'" },
                    pozycja: { type: Type.STRING },
                    opis: { type: Type.STRING },
                    ilosc: { type: Type.NUMBER },
                    jednostka: { type: Type.STRING },
                    KNR_ref: { type: Type.STRING }
                },
                required: ["sectionName", "pozycja", "ilosc", "jednostka"]
            }
        },
        reasoning: { type: Type.STRING, description: "Logika decyzyjna." },
        phase: { type: Type.STRING, description: "PLANNING, WORKING, DONE" },
        currentGoal: { type: Type.STRING },
        newTasks: {
            type: Type.ARRAY,
            items: {
                type: Type.OBJECT,
                properties: {
                    agentType: { type: Type.STRING, description: "Wybierz z listy dostępnych agentów." },
                    instruction: { type: Type.STRING, description: "Precyzyjna instrukcja dla agenta oraz struktura JSON jakiej od niego oczekujesz." },
                    inputDocIds: { type: Type.ARRAY, items: { type: Type.STRING } },
                    inputFactsKeys: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Klucze z knownFacts, które chcesz mu przekazać." },
                    modelOverride: { type: Type.STRING, description: "gemini-2.5-flash lub gemini-2.5-pro" }
                },
                required: ["agentType", "instruction", "inputDocIds"]
            }
        }
    },
    required: ["updateKnownFacts", "newEstimateItems", "reasoning", "phase", "currentGoal", "newTasks"]
};

export async function POST(req: Request) {
    try {
        const { tenderId, trigger } = await req.json();
        if (!tenderId) return NextResponse.json({ error: "Brak tenderId" }, { status: 400 });

        console.log(`[MÓZG 🧠] Przebudzenie. Przetarg: ${tenderId} | Trigger: ${trigger}`);

        const tasksRef = adminDb.collection(`tenders/${tenderId}/tasks`);
        const brainRef = adminDb.collection(`tenders/${tenderId}/brain`).doc("main");
        const tenderRef = adminDb.collection("tenders").doc(tenderId);

        // ==========================================
        // 1. POBIERANIE REJESTRU AGENTÓW (Z SEEDINGIEM)
        // ==========================================
        let agentRegistrySnap = await adminDb.collection("agentRegistry").get();

        if (agentRegistrySnap.empty) {
            console.log("[MÓZG 🧠] Rejestr agentów jest pusty. Inicjalizuję domyślny Seed...");
            const defaultAgents = [
                { name: "VISION", endpoint: "/api/kosztorysant/agent-wbs-architekt", capabilities: ["vision", "pdf_parsing"], description: "Analizuje rysunki budowlane w formacie PDF/obraz. Wymaga przekazania plików w 'inputDocIds'. Zwraca wymiary, materiały i zliczone ilości." },
                { name: "LEGAL_EXPERT", endpoint: "/api/kosztorysant/czytacz-dokumentow", capabilities: ["text_analysis"], description: "Analizuje tekst umów i SWZ. Wymaga przekazania plików tekstowych/PDF w 'inputDocIds'. Zwraca kary, terminy, gwarancje i wymagania formalne." },
                { name: "PYTHON_CALC", endpoint: "/api/kosztorysant/agent-python-calc", capabilities: ["codeExecution"], description: "Matematyk. Wykonuje zaawansowane obliczenia w Pythonie. NIE CZYTA PLIKÓW. Wymaga podania konkretnych danych liczbowych i wzorów w 'inputFactsKeys'. Zwraca gotowe wyniki obliczeń." },
                { name: "BROKER", endpoint: "/api/kosztorysant/broker-cenowy", capabilities: ["googleSearch"], description: "Wycenia rynkowo pozycje. Wymaga przekazania w 'instruction' listy materiałów lub robót do wyceny. Używa wyszukiwarki do znalezienia aktualnych cen netto." },
                { name: "UNIVERSAL_AGENT", endpoint: "/api/kosztorysant/agent-uniwersalny", capabilities: ["general_reasoning"], description: "Uniwersalny analityk. Używaj go do zadań logicznych, dedukcji lub gdy żaden inny specjalista nie pasuje. Może przyjmować zarówno pliki, jak i fakty." }
            ];

            const seedBatch = adminDb.batch();
            for (const agent of defaultAgents) {
                seedBatch.set(adminDb.collection("agentRegistry").doc(agent.name), agent);
            }
            await seedBatch.commit();
            agentRegistrySnap = await adminDb.collection("agentRegistry").get();
        }

        const availableAgents = agentRegistrySnap.docs.map(d => d.data());

        // ==========================================
        // 2. BLOKADA WYŚCIGU Z ZABEZPIECZENIEM (TIMEOUT)
        // ==========================================
        const activeTasksSnap = await tasksRef.where("status", "in", ["PENDING", "IN_PROGRESS"]).get();

        const now = Date.now();
        const TIMEOUT_MS = 10 * 60 * 1000; // 10 minut
        const lockBatch = adminDb.batch();
        let trulyActiveCount = 0;

        activeTasksSnap.docs.forEach(doc => {
            const data = doc.data();
            const lastActive = data.updatedAt?.toMillis?.() || data.createdAt?.toMillis?.() || now;

            if (now - lastActive >= TIMEOUT_MS) {
                console.warn(`[MÓZG 🧠] Zadanie ${doc.id} przekroczyło timeout! Oznaczam jako ERROR.`);
                lockBatch.update(doc.ref, {
                    status: "ERROR",
                    rawResult: { error: "TIMEOUT_EXCEEDED", message: "Agent nie odpowiedział w czasie 10 minut." },
                    processedByBrain: false,
                    updatedAt: new Date()
                });
            } else {
                trulyActiveCount++;
            }
        });

        if (trulyActiveCount > 0) {
            await lockBatch.commit();
            console.log(`[MÓZG 🧠] Ignoruję trigger. Inni agenci wciąż pracują (${trulyActiveCount} zadań). Idę spać.`);
            return NextResponse.json({ message: "Waiting for parallel tasks to finish." });
        }

        // ==========================================
        // 3. ZBIERANIE KONTEKSTU I WYNIKÓW
        // ==========================================
        const [docsSnap, brainSnap, unprocessedTasksSnap, tenderDoc] = await Promise.all([
            adminDb.collection(`tenders/${tenderId}/documents`).get(),
            brainRef.get(),
            tasksRef.where("status", "in", ["DONE", "ERROR"]).where("processedByBrain", "==", false).get(),
            tenderRef.get() // Dociągamy stan główny przetargu
        ]);

        // ZABEZPIECZENIE: Przerywamy działanie jeśli użytkownik wcisnął guzik STOP
        if (tenderDoc.exists && tenderDoc.data()?.status === "HALTED") {
            console.log(`[MÓZG 🧠] Przetarg ${tenderId} ma status HALTED. Natychmiast przerywam pętlę.`);
            return NextResponse.json({ message: "Brain is stopped by user." });
        }

        const documents = docsSnap.docs.map(d => ({ id: d.id, tags: d.data().tags, summary: d.data().summary }));
        const currentBrainState = brainSnap.exists ? brainSnap.data() : { knownFacts: {}, phase: "PLANNING" };

        const newlyFinishedResults = unprocessedTasksSnap.docs.map(d => ({
            taskId: d.id,
            agentType: d.data().agentType,
            status: d.data().status,
            rawResult: d.data().rawResult
        }));

        // ==========================================
        // 4. RE-ACT LOOP (WYWOŁANIE LLM MÓZGU)
        // ==========================================
        const systemPrompt = `
Jesteś Głównym Mózgiem systemu kosztorysowego. Twoim celem jest zbudowanie kompletnego kosztorysu.
Posiadasz bazę faktów (knownFacts) oraz listę dokumentów. 
Właśnie zakończyły się zadania agentów. Twoim zadaniem jest je 'przetrawić' i zaplanować kolejne kroki.

DOSTĘPNI AGENCI (Wybieraj 'agentType' TYLKO z poniższej listy!):
${JSON.stringify(availableAgents.map(a => ({ name: a.name, description: a.description, capabilities: a.capabilities })), null, 2)}

TWOJA BAZA FAKTÓW (knownFacts):
${JSON.stringify(currentBrainState?.knownFacts || {}, null, 2)}

DOSTĘPNE DOKUMENTY:
${JSON.stringify(documents, null, 2)}

ŚWIEŻE WYNIKI OD AGENTÓW (rawResult):
${JSON.stringify(newlyFinishedResults, null, 2)}

ZASADY:
1. Przeanalizuj 'ŚWIEŻE WYNIKI'. Jeśli agent odczytał z umowy termin realizacji, kary, czy powierzchnię z rysunku - dodaj je do "updateKnownFacts" (klucz-wartość).
2. Jeśli agent wyciągnął konkretne przedmiary lub zaprojektował technologię - przekaż je jako pozycje do "newEstimateItems". Zgrupuj je logicznie nadając im "sectionName".
3. Jeśli czegoś brakuje, zaplanuj "newTasks" dla agentów. Narzucaj im dokładną formę w polu 'instruction' (np. 'Zwróć wynik jako: { powierzchnia: 120 }').
4. Gdy nie ma już nic do roboty i masz wszystkie ilości, stwórz zadanie dla agenta BROKER, aby wycenił wszystko z sieci, a phase ustaw na WORKING. Gdy Broker skończy, phase na DONE.
`;

        const result = await ai.models.generateContent({
            model: MODEL_PRO,
            contents: systemPrompt,
            config: { temperature: 0.1, responseMimeType: "application/json", responseSchema: BRAIN_SCHEMA as any }
        });

        const parsedResult = JSON.parse(result.text ?? "{}");
        const batch = adminDb.batch();

        console.log(`[MÓZG 🧠] Decyzja: ${parsedResult.reasoning}`);

        // ==========================================
        // 5. APLIKACJA DECYZJI DO BAZY DANYCH
        // ==========================================

        unprocessedTasksSnap.docs.forEach(doc => {
            batch.update(doc.ref, { processedByBrain: true });
        });

        const mergedFacts = {
            ...(currentBrainState?.knownFacts || {}),
            ...(parsedResult.updateKnownFacts || {})
        };

        batch.update(brainRef, {
            phase: parsedResult.phase,
            currentGoal: parsedResult.currentGoal,
            knownFacts: mergedFacts,
            reasoningLog: FieldValue.arrayUnion(parsedResult.reasoning)
        });

        if (parsedResult.newEstimateItems && parsedResult.newEstimateItems.length > 0) {
            console.log(`[MÓZG 🧠] Przygotowuję zapis ${parsedResult.newEstimateItems.length} nowych pozycji do kosztorysu...`);
            const sectionsMap = new Map<string, any[]>();
            parsedResult.newEstimateItems.forEach((item: any) => {
                const sec = item.sectionName || "Inne";
                if (!sectionsMap.has(sec)) sectionsMap.set(sec, []);
                sectionsMap.get(sec)!.push(item);
            });

            for (const [sectionName, items] of Array.from(sectionsMap.entries())) {
                const safeName = sectionName.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 30);
                const sectionId = `sec_${safeName}`;
                const sectionRef = adminDb.collection(`tenders/${tenderId}/estimate`).doc(sectionId);

                // 1. Mapujemy pozycje i nadajemy im ID na poziomie Mózgu
                const formattedItems = items.map((item: any) => ({
                    id: randomUUID(),
                    pozycja: item.pozycja,
                    opis: item.opis || "",
                    ilosc: Number(item.ilosc),
                    jednostka: item.jednostka || "szt",
                    cenaJed: 0,
                    KNR_ref: item.KNR_ref || "Z analizy AI",
                    confidence: "HIGH",
                    sourceTrack: "Mózg -> Synteza wyników"
                }));

                console.log(`[MÓZG 🧠] Zapisuję sekcję: ${sectionName} (SectionId: ${sectionId}) z tablicą ${formattedItems.length} pozycji.`);

                // 2. Zapis do dokumentu nadrzędnego (dla błyskawicznego renderingu na frontendzie)
                batch.set(sectionRef, {
                    section: sectionName,
                    status: "QUANTITY_READY",
                    items: formattedItems, // Ta linijka ratuje Twój frontend!
                    updatedAt: new Date()
                }, { merge: true });

                // 3. Zapis do podkolekcji (dla zachowania porządku w strukturze danych)
                formattedItems.forEach((fItem) => {
                    batch.set(sectionRef.collection("items").doc(fItem.id), fItem);
                });
            }
        }

        const newTasksCreated: any[] = [];
        (parsedResult.newTasks || []).forEach((task: any) => {
            const taskRef = tasksRef.doc();

            const inputFacts: any = {};
            (task.inputFactsKeys || []).forEach((key: string) => {
                if (mergedFacts[key]) inputFacts[key] = mergedFacts[key];
            });

            const taskData = {
                taskId: taskRef.id,
                agentType: task.agentType,
                instruction: task.instruction,
                inputDocIds: task.inputDocIds || [],
                inputFacts: inputFacts,
                modelOverride: task.modelOverride || "gemini-2.5-flash",
                status: "PENDING",
                processedByBrain: false,
                createdAt: new Date(),
                updatedAt: new Date()
            };
            batch.set(taskRef, taskData);
            newTasksCreated.push(taskData);
        });

        batch.update(tenderRef, {
            "budgetGuard.currentCostUSD": FieldValue.increment((result.usageMetadata?.totalTokenCount || 0) * 0.000002),
            status: parsedResult.phase === "DONE" ? "DONE" : "ORCHESTRATING"
        });

        await batch.commit();

        // ==========================================
        // 6. DYNAMICZNY ROUTING (WYBUDZENIE AGENTÓW)
        // ==========================================
        const localOrigin = `http://127.0.0.1:${process.env.PORT || "3000"}`;

        for (const task of newTasksCreated) {
            const agentDef = availableAgents.find(a => a.name === task.agentType);

            if (agentDef && agentDef.endpoint) {
                console.log(`[MÓZG 🧠] ⚡ Budzę Agenta: ${task.agentType} -> ${agentDef.endpoint}`);
                fetch(`${localOrigin}${agentDef.endpoint}`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ tenderId, taskId: task.taskId })
                }).catch(e => console.error(`[MÓZG 🧠] Błąd wywołania ${task.agentType}:`, e));
            } else {
                console.warn(`[MÓZG 🧠] ⚠️ UWAGA: Nieznany agent: ${task.agentType}`);
                adminDb.collection(`tenders/${tenderId}/tasks`).doc(task.taskId).update({
                    status: "ERROR",
                    rawResult: { error: `Agent ${task.agentType} nie istnieje w rejestrze.` },
                    processedByBrain: false,
                    updatedAt: new Date()
                }).catch(() => { });
            }
        }

        return NextResponse.json({ success: true, newTasks: newTasksCreated.length });

    } catch (error: any) {
        console.error("[MÓZG 🧠] ❌ Błąd krytyczny:", error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}