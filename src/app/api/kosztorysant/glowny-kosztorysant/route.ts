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

async function callGeminiWithRetry(fn: () => Promise<any>, retries = 3, delay = 3000): Promise<any> {
    try {
        return await fn();
    } catch (error: any) {
        const errorText = error.toString() || "";
        const isRateLimit = errorText.includes("429") || errorText.includes("RESOURCE_EXHAUSTED");

        if (isRateLimit && retries > 0) {
            console.warn(`[MÓZG 🧠] Limit 429 dla serca AI Orkiestry!. Czekam ${delay / 1000}s na pchniecie retry....`);
            await new Promise(resolve => setTimeout(resolve, delay));
            return callGeminiWithRetry(fn, retries - 1, delay * 2);
        }
        throw error;
    }
}

// Schemat Mózgu powiększony o funkcję chatReply do rozmów !
const BRAIN_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        updateKnownFacts: {
            type: Type.OBJECT,
            description: "Słownik (klucz-wartość) faktów pod rygorem zachowania - też uwag podanych przez Uzytkownik w Czacie."
        },
        chatReply: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: "Jesli potrzebujesz rozwinac zapytania do User Inzyniera lub User zadał Ci w Czat zapytanie, napisz z rygorem odpowiedź na Czat Frontowy w List[ String ] tu by pokazało w GUI! Jeśli wszystko w Roju płynne : oddaj tu z Pustą!"
        },
        newEstimateItems: {
            type: Type.ARRAY,
            description: "Wyliczone lub po autopsji wylądkowe nowe sztuki do tablic Żywego Wyceniacza.",
            items: {
                type: Type.OBJECT,
                properties: {
                    sectionName: { type: Type.STRING, description: "Np: Konstrukcyjne Surowe , Roboty Teren" },
                    pozycja: { type: Type.STRING },
                    opis: { type: Type.STRING },
                    ilosc: { type: Type.NUMBER },
                    jednostka: { type: Type.STRING },
                    KNR_ref: { type: Type.STRING }
                },
                required: ["sectionName", "pozycja", "ilosc", "jednostka"]
            }
        },
        reasoning: { type: Type.STRING, description: "Czym dysrybujesz sobie po fakcie tok Myśli " },
        phase: { type: Type.STRING, description: "WAITING_INPUT, PLANNING, WORKING, DONE" },
        currentGoal: { type: Type.STRING },
        newTasks: {
            type: Type.ARRAY,
            items: {
                type: Type.OBJECT,
                properties: {
                    agentType: { type: Type.STRING },
                    instruction: { type: Type.STRING, description: "Czysto wymierzone zdanie pod agent JSON wyjscie." },
                    inputDocIds: { type: Type.ARRAY, items: { type: Type.STRING } },
                    inputFactsKeys: { type: Type.ARRAY, items: { type: Type.STRING } },
                    modelOverride: { type: Type.STRING, description: "gemini-2.5-flash lub gemini-2.5-pro" }
                },
                required: ["agentType", "instruction", "inputDocIds"]
            }
        }
    },
    required: ["updateKnownFacts", "chatReply", "newEstimateItems", "reasoning", "phase", "currentGoal", "newTasks"]
};

export async function POST(req: Request) {
    try {
        const { tenderId, trigger } = await req.json();
        if (!tenderId) return NextResponse.json({ error: "Brak tenderId" }, { status: 400 });

        console.log(`[MÓZG 🧠] Pętla Zapala Przełożenie.. tenderID: ${tenderId} | Zaplon od zewn lub Agenta u Triggera: ${trigger}`);

        const tasksRef = adminDb.collection(`tenders/${tenderId}/tasks`);
        const brainRef = adminDb.collection(`tenders/${tenderId}/brain`).doc("main");
        const tenderRef = adminDb.collection("tenders").doc(tenderId);

        let agentRegistrySnap = await adminDb.collection("agentRegistry").get();

        if (agentRegistrySnap.empty) {
            console.log("[MÓZG 🧠] Przyśpieszam pod Seeder Agenta brak bazy.");
            const defaultAgents = [
                { name: "VISION", endpoint: "/api/kosztorysant/agent-wbs-architekt", capabilities: ["vision", "pdf_parsing"], description: "Analizuje rysunki budowlane w formacie PDF/obraz. Wymaga plików w 'inputDocIds'. Zwraca wymiary i ilości." },
                { name: "LEGAL_EXPERT", endpoint: "/api/kosztorysant/czytacz-dokumentow", capabilities: ["text_analysis"], description: "Analizuje umowy i SWZ. Wymaga plików tekstowych w 'inputDocIds'. Zwraca kary, terminy, wadium, gwarancje." },
                { name: "PYTHON_CALC", endpoint: "/api/kosztorysant/agent-python-calc", capabilities: ["codeExecution"], description: "Matematyk. Liczy pola i objętości w Pythonie. Wymaga podania wymiarów w 'inputFactsKeys'." },
                { name: "BROKER", endpoint: "/api/kosztorysant/broker-cenowy", capabilities: ["googleSearch"], description: "Wycenia rynkowo gotowe pozycje kosztorysowe. Szuka cen netto w polskim internecie." },
                { name: "BUDOWLANIEC", endpoint: "/api/kosztorysant/agent-budowlaniec", capabilities: ["engineering", "googleSearch"], description: "Inżynier budowy. Projektuje kompletną technologię budowy (stan zerowy, surowy, wykończenie) na podstawie faktów." },
                { name: "SILENT_AUDITOR", endpoint: "/api/kosztorysant/agent-cichy-rewident", capabilities: ["audit", "googleSearch"], description: "Audytor technologiczny. Weryfikuje wymogi prawne (WT 2021, Sanepid, PPOŻ) dla wygenerowanych już pozycji." },
                { name: "GAP_FILLER", endpoint: "/api/kosztorysant/agent-gap-filler", capabilities: ["estimation", "googleSearch"], description: "Łatacz / Wskaźnikowiec. Szacuje koszty parametrycznie/wskaźnikowo dla branż, dla których brakuje rysunków." },
                { name: "BOQ_PARSER", endpoint: "/api/kosztorysant/agent-ilosciowiec", capabilities: ["table_parsing"], description: "Przedmiarowiec. Analizuje tabele ze ślepych kosztorysów i wyciąga gotowe pozycje z ilościami." },
                { name: "KAMELEON", endpoint: "/api/kosztorysant/agent-kameleon", capabilities: ["specialist_analysis"], description: "Specjalista branżowy. Analizuje nietypowe, wąskie dokumentacje techniczne (np. baseny, gazy medyczne)." },
                { name: "REVISOR_JUDGE", endpoint: "/api/kosztorysant/agent-rewident", capabilities: ["legal_reasoning", "googleSearch"], description: "Sędzia Roju. Rozstrzyga merytoryczne konflikty prawne i inżynieryjne w oparciu o przepisy i hierarchię dokumentów." },

                // --- DODANE WZNIESIENIE MAPPING ARCHITEKTO:
                { name: "MAPPING_DETECTIVE", endpoint: "/api/kosztorysant/agent-detektyw", capabilities: ["pdf_parsing", "correlations"], description: "Korelator Rysunków Przestrzennych z 2D w Rój i Mapę Relacji Zmian np (Z płaskiego PDF-RZUT od A: Do Przekroi grubosc warst POSZADKI pliku np PD-CROSS na obięt m3 fundamentow)." }
            ];

            const seedBatch = adminDb.batch();
            for (const agent of defaultAgents) {
                seedBatch.set(adminDb.collection("agentRegistry").doc(agent.name), agent);
            }
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
                    rawResult: { error: "TIMEOUT_EXCEEDED", message: "Agent Został zamarźnięty bez zwrotów API ponad Limit (Móżdzu powołaj jak potrzeba Go jescze)." },
                    processedByBrain: false,
                    updatedAt: new Date()
                });
            } else {
                trulyActiveCount++;
            }
        });

        // WAZNY FRAGMENT DOTYCZĄCY WIADOMOŚĆ CZAT'OW! JEZELI ODBYLO SIĘ KLIKNIĘCIE I CZEKA ODBERUJ TE CZAT WIADONSC MIMO TRZYMAC SIE PĘTLI
        if (trulyActiveCount > 0) {
            await lockBatch.commit();
            console.log(`[MÓZG 🧠] Inni agenci z mojego stada pracują w Cloud Runie (Zostalo ich ${trulyActiveCount} do wykon.). Usypiam Loop Orchestartora Czekam w mroku na 'finally'.`);
            return NextResponse.json({ message: "Inne procesy żyją połącz się po ich odzewach .." });
        }

        const [docsSnap, brainSnap, unprocessedTasksSnap, tenderDoc, chatHistSnap] = await Promise.all([
            adminDb.collection(`tenders/${tenderId}/documents`).get(),
            brainRef.get(),
            tasksRef.where("status", "in", ["DONE", "ERROR"]).where("processedByBrain", "==", false).get(),
            tenderRef.get(),
            adminDb.collection(`tenders/${tenderId}/chat`).orderBy("timestamp", "asc").limit(20).get() // Wciąga Log Czat - na wyciagnięcię Inputa od User Inzynierów!. 
        ]);

        if (tenderDoc.exists && tenderDoc.data()?.status === "HALTED") {
            return NextResponse.json({ message: "GUI Panel został zblokowany. Bezpowrotny stan Orchiestacji odrzucony pod Twardy Stop!" });
        }

        const documents = docsSnap.docs.map(d => ({ id: d.id, tags: d.data().tags, summary: d.data().summary }));
        const currentBrainState = brainSnap.exists ? brainSnap.data() : { knownFacts: {}, phase: "PLANNING" };
        const recentlyTalkUserChatsToAnallyzingForMissing = chatHistSnap.docs.map(cObj => ({ roleRoleZRODLA: cObj.data().role, UserTekstNaPanel: cObj.data().content }));

        const newlyFinishedResults = unprocessedTasksSnap.docs.map(d => ({
            taskId: d.id,
            agentType: d.data().agentType,
            status: d.data().status,
            rawResult: d.data().rawResult
        }));

        const systemPrompt = `Jesteś Oświeconym i zarazem Piekielnie Bytrą Archiktekurą Głowy Roju Kosztorysowego MÓzgiem Centralnych Skrzynek dla API Budownictwa B2B (Pro i Zdalnej inżynierstwa Mózg.) . Posiadasz Czat Kontakt Z Wygogowanym kosztorysatorem, oraz stado Twoich pracowników AI:
DOSTĘPNI W TWOICH RĘKACH Z ROJU CIĘZCY AI: ${JSON.stringify(availableAgents.map(a => ({ name: a.name, description: a.description, capabilities: a.capabilities })), null, 2)}
AKTUALNA PAMIĘC Z NAROSTA : ${JSON.stringify(currentBrainState?.knownFacts || {}, null, 2)}
ZAŁĄCZNIK OD SYSTEMÓW FRONTU(Doks): ${JSON.stringify(documents, null, 2)}

WYRZUCOON TACKI: ${JSON.stringify(newlyFinishedResults, null, 2)}
LIVEE HISTORIA PULT-CZATA USER Z TOBĄ (Ostanie minuty):  ${JSON.stringify(recentlyTalkUserChatsToAnallyzingForMissing)} \n

MÓZG REGULACJE  ZMIAN NOWEGO PROTOKOLOWE: 
1. Traw nowe zwroty Wyrzucoonych taskow. Pchnij te uzasadniająca wyceny jak sa od `+ `BrokenRMS...` + ` poze kosztowe do [newEsti....ms...[]...] Sekcyjnych Mrowisach jako nowość w Kosztorysie z frontach
2. Przeanalizuj Historie z Pulpet - USER jeśli użytkownik jakoś wtracił Ci mroczny uchyb norm - to dorzuc to "Known Factami!" A jeśli ty po zczytaniach stwierdasz ZONk do robot np o braku ilosci , wywoła go po przez "chatRepty[ '....', '] " aby Front end zobacyz l że usterkiasz w czaciu brakujacy info (ustawa tez mu sie waiting status Faze) !!! `;

        console.log(`[MÓZG 🧠] Prompts Centralizuje wiedze . Sila pchnięta .. Podziw na zmartwychoWstawnie modeli pro O limitac! ..  `);

        const result = await callGeminiWithRetry(async () => {
            return await ai.models.generateContent({
                model: MODEL_PRO,
                contents: systemPrompt,
                config: { temperature: 0.1, responseMimeType: "application/json", responseSchema: BRAIN_SCHEMA as any }
            });
        });

        const parsedResult = JSON.parse(result.text ?? "{}");
        const batch = adminDb.batch();

        unprocessedTasksSnap.docs.forEach(doc => {
            batch.update(doc.ref, { processedByBrain: true });
        });

        // Obsługa Gadańca - wysłania z 'Chatu od mozgu dla użytkownika Kosztorysu ' na Widoki u Ekranu Bazy danych:   
        if (parsedResult.chatReply && parsedResult.chatReply.length > 0) {
            parsedResult.chatReply.forEach((brainTekscidlow: string) => {
                const nwDkZChatMzgReffRef = adminDb.collection(`tenders/${tenderId}/chat`).doc();
                batch.set(nwDkZChatMzgReffRef, { role: "brain", content: brainTekscidlow, timestamp: FieldValue.serverTimestamp(), intent: "PytankaMozgu-SystemAlert" })
                console.log(`[MÓZG 🧠💬 ] Skreślilem wiadmoscia od Systemów Roju w Ekran Pultanowy ! Tres :  ${brainTekscidlow.substring(0, 35)}.... `)
            })
        }

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
            console.log(`[MÓZG 🧠] Pcham Zbieraniowy  Sekcję Estimate DB. ${parsedResult.newEstimateItems.length} ilosci po Mroku Rzadu..`);
            const sectionsMap = new Map<string, any[]>();
            parsedResult.newEstimateItems.forEach((item: any) => {
                const sec = item.sectionName || "Z Mózgu po Burz. Ogólniej !";
                if (!sectionsMap.has(sec)) sectionsMap.set(sec, []);
                sectionsMap.get(sec)!.push(item);
            });

            for (const [sectionName, items] of Array.from(sectionsMap.entries())) {
                const safeName = sectionName.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 30);
                const sectionId = `sec_${safeName}`;
                const sectionRef = adminDb.collection(`tenders/${tenderId}/estimate`).doc(sectionId);

                const formattedItems = items.map((item: any) => ({
                    id: randomUUID(),
                    pozycja: item.pozycja,
                    opis: item.opis || "",
                    ilosc: Number(item.ilosc),
                    jednostka: item.jednostka || "szt",
                    cenaJed: 0,
                    KNR_ref: item.KNR_ref || "Z analizy Centralizacji AI (Boq z plik/Budowln z Fakcików)",
                    confidence: "HIGH",
                    sourceTrack: "Orkiestracyjny Zarzad Modulowo/Fakty -> Synt. Roju. "
                }));

                batch.set(sectionRef, {
                    section: sectionName,
                    status: "QUANTITY_READY",
                    items: formattedItems,
                    updatedAt: new Date()
                }, { merge: true });

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
            status: parsedResult.phase === "DONE" ? "DONE" : (parsedResult.phase === "WAITING_INPUT" ? "Czekamy za Zezwolic / Podpowiedzie  ! " : "ORCHESTRATING")
        });

        await batch.commit();
        const localOrigin = `http://localhost:${process.env.PORT || "3000"}`;

        for (const task of newTasksCreated) {
            const agentDef = availableAgents.find(a => a.name === task.agentType);
            if (agentDef && agentDef.endpoint) {
                fetch(`${localOrigin}${agentDef.endpoint}`, {
                    method: "POST", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ tenderId, taskId: task.taskId })
                }).catch(() => { });
            } else {
                adminDb.collection(`tenders/${tenderId}/tasks`).doc(task.taskId).update({
                    status: "ERROR", rawResult: { error: `Ciezko Wywołaci Agent . Bład Siewn.. Rejst brakowy na Typ:${task.agentType}.` },
                    processedByBrain: false, updatedAt: new Date()
                }).catch(() => { });
            }
        }

        return NextResponse.json({ success: true, rozmowaZWdrożonymRozem: true });
    } catch (error: any) {
        console.error("[MÓZG 🧠] ❌ Wtopione Zlecenie Pula Padła... Centrala Puste", error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}