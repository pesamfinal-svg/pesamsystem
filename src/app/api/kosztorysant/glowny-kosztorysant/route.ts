import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { FieldValue } from "firebase-admin/firestore";
import { GoogleGenAI, Type } from "@google/genai";
import { randomUUID } from "crypto";
import { jsonrepair } from "jsonrepair";
import dns from "dns";
dns.setDefaultResultOrder("ipv4first");

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
    location: "global"
});

const MODEL_PRO = "gemini-2.5-pro";

// ─────────────────────────────────────────────────────────────────
// RETRY: 429 (rate limit) + błędy sieciowe/socketowe (UND_ERR_SOCKET,
// "fetch failed", "other side closed", ECONNRESET, ETIMEDOUT)
// ─────────────────────────────────────────────────────────────────

async function callGeminiWithRetry(fn: () => Promise<any>, retries = 5, delay = 5000): Promise<any> {
    try {
        return await fn();
    } catch (error: any) {
        const errorText = error?.toString?.() || "";
        const causeText = error?.cause?.toString?.() || "";
        const fullText = `${errorText} ${causeText}`;

        const isRateLimit = fullText.includes("429") || fullText.includes("RESOURCE_EXHAUSTED");
        const isSocketError =
            fullText.includes("UND_ERR_SOCKET") ||
            fullText.includes("fetch failed") ||
            fullText.includes("other side closed") ||
            fullText.includes("ECONNRESET") ||
            fullText.includes("ETIMEDOUT") ||
            fullText.includes("SocketError");

        if ((isRateLimit || isSocketError) && retries > 0) {
            const jitter = Math.random() * 3000;
            const waitTime = delay + jitter;
            const reason = isRateLimit ? "Limit API 429" : "Błąd sieci/socketu (zerwane połączenie)";
            console.warn(`[MÓZG 🧠] ${reason}. Czekam ${Math.round(waitTime / 1000)}s... (Pozostało prób: ${retries})`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
            return callGeminiWithRetry(fn, retries - 1, delay * 2);
        }
        throw error;
    }
}

// ─────────────────────────────────────────────────────────────────
// BRAIN SCHEMA — struktura własnego myślenia Mózgu
// ─────────────────────────────────────────────────────────────────

const BRAIN_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        reasoning: {
            type: Type.STRING,
            description: `Twój tok rozumowania. Przeanalizuj swój 'World Model', oceń które założenia są najbardziej ryzykowne i co musisz zrobić by zmniejszyć niepewność kosztorysu. UWZGLĘDNIJ: co dostarczył Technolog, które luki to pokrywa, co jeszcze brakuje, oraz co wynika z RZECZYWISTEGO stanu kosztorysu (sekcje + liczba pozycji) i z HISTORII ZADAŃ obu mózgów (Twojego i Technologa).`
        },
        selfCritique: {
            type: Type.STRING,
            description: `Samokrytyka: Dlaczego mój kosztorys na tym etapie może być drastycznie błędny? Które założenia mogłyby wywrócić budżet o ponad 10% jeśli są mylne? Czy w pełni wykorzystałem dane od Technologa? Czy nie zlecam ponownie czegoś, co już zostało zrobione (przez mój zespół LUB przez zespół Technologa)?`
        },
        nextBestAction: {
            type: Type.STRING,
            description: `Jaka pojedyncza informacja/akcja najbardziej zwiększy w tym momencie jakość kosztorysu?`
        },
        assumptionMode: {
            type: Type.BOOLEAN,
            description: `Ustaw na TRUE TYLKO jeśli świadomie decydujesz się na wycenę koncepcyjną z powodu braku dokumentacji technicznej.`
        },
        assumptionDisclaimer: {
            type: Type.STRING,
            description: `Wyraźne ostrzeżenie dla Kosztorysanta — z jakich źródeł i norm korzystasz oraz jakie ryzyko niesie ten tryb.`
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
            description: `Komunikacja z użytkownikiem. Używaj TYLKO w ostateczności lub gdy phase=WAITING_INPUT.`
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
                    KNR_ref: { type: Type.STRING },
                    cenaJed: { type: Type.NUMBER, description: "Wpisz SAMĄ stawkę jednostkową (np. 150), tylko gdy masz pewny wskaźnik kosztowy od Technologa (COST_INDICATOR). Domyślnie 0." }
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
            description: `Zadania dla narzędzi. Dla BOQ_PARSER i VISION zawsze dołącz extractionProfile. Workery działają bez sztywnego schematu — daj im precyzyjne instrukcje tekstowe. UWAGA: Przed zleceniem zadania sprawdź sekcję "HISTORIA WSZYSTKICH ZADAŃ" (Twoich i Technologa) — jeśli identyczne zadanie (ten sam agentType + te same inputDocIds) już istnieje w statusie PENDING/IN_PROGRESS/DONE, NIE twórz go ponownie. System i tak je odrzuci, ale unikaj tego na poziomie rozumowania.`,
            items: {
                type: Type.OBJECT,
                properties: {
                    agentType: { type: Type.STRING },
                    instruction: { type: Type.STRING },
                    inputDocIds: { type: Type.ARRAY, items: { type: Type.STRING } },
                    inputFactsKeys: { type: Type.ARRAY, items: { type: Type.STRING } },
                    extractionProfile: {
                        type: Type.OBJECT,
                        description: `WYMAGANE dla BOQ_PARSER i VISION.`,
                        properties: {
                            contextLabel: { type: Type.STRING },
                            modelHint: { type: Type.STRING },
                            customFields: {
                                type: Type.ARRAY,
                                items: {
                                    type: Type.OBJECT,
                                    properties: {
                                        name: { type: Type.STRING },
                                        type: { type: Type.STRING },
                                        description: { type: Type.STRING }
                                    },
                                    required: ["name", "type", "description"]
                                }
                            }
                        },
                        required: ["contextLabel", "modelHint", "customFields"]
                    }
                },
                required: ["agentType", "instruction", "inputDocIds"]
            }
        }
    },
    required: ["reasoning", "selfCritique", "nextBestAction", "assumptionMode", "assumptionDisclaimer", "cognitiveState", "chatReply", "newEstimateItems", "phase", "currentGoal", "newTasks"]
};

const EXTRACTION_PROFILES_GUIDE = `
=== DYNAMICZNE PROFILE EKSTRAKCJI (extractionProfile) ===

Dla BOQ_PARSER i VISION zawsze dynamicznie projektuj extractionProfile.

ZASADY:
1. Pola 'pozycja', 'opis', 'ilosc', 'jednostka', 'KNR_ref' są ZAWSZE automatyczne — NIE twórz dla nich customFields.
2. customFields to wyłącznie DODATKOWE parametry techniczne (np. mocFalownika, gruboscAsfaltu, klasaBetonu).
3. modelHint: 'PRO' dla rysunków/grafik, 'FLASH' dla tabel i tekstów.

Przykład dla Instalacji PV:
  contextLabel: "INSTALACJA_PV", modelHint: "PRO"
  customFields: [{ name: "mocModuluWp", type: "NUMBER", description: "Moc panelu w Wp" }]
`;

// ─────────────────────────────────────────────────────────────────
// Formatowanie findings od Technologa dla Mózgu
// ─────────────────────────────────────────────────────────────────

function buildTechnologistContext(findings: any[], techPhase: string): string {
    if (!findings || findings.length === 0) {
        return "Technolog jeszcze nie przekazał danych. Możesz go wybudzić triggerem TECHNOLOGIST_NEW_FINDINGS.";
    }

    const byCategory = findings.reduce((acc: any, f: any) => {
        const cat = f.category || "OTHER";
        if (!acc[cat]) acc[cat] = [];
        acc[cat].push(f);
        return acc;
    }, {});

    const sections: string[] = [];
    sections.push(`Status Technologa: ${techPhase || "UNKNOWN"}`);
    sections.push(`Łącznie findings: ${findings.length}`);
    sections.push("");

    // MISSING_SCOPE — najważniejsze
    if (byCategory["MISSING_SCOPE"]?.length > 0) {
        sections.push("=== 🔴 BRAKUJĄCE DZIAŁY KOSZTORYSU (MISSING_SCOPE) ===");
        sections.push("ZASADA: Dla każdego brakującego działu MUSISZ podjąć akcję — patrz instrukcje poniżej.");
        sections.push("UWAGA: Sprawdź sekcję 'AKTUALNY STAN KOSZTORYSU' i 'POKRYCIE MISSING_SCOPE PRZEZ KOSZTORYS' —");
        sections.push("jeśli dany dział JUŻ MA pozycje w kosztorysie (np. dzięki BOQ_PARSER zleconemu przez Technologa");
        sections.push("Obmiarowcowi), NIE generuj duplikatów — luka może być już częściowo lub w pełni pokryta.");
        sections.push("");
        byCategory["MISSING_SCOPE"].forEach((f: any) => {
            const facts = f.facts || {};
            sections.push(`▶ BRAKUJE: ${facts.divisionName || f.findingId}`);
            sections.push(`  Pewność: ${f.confidence}%`);
            sections.push(`  Szacowany udział w kosztorysie: ${facts.estimatedCostShare || "nieznany"}`);
            sections.push(`  Dlaczego brakuje: ${facts.whyMissing || "brak info"}`);
            if (facts.typicalItems?.length > 0) {
                sections.push(`  Typowe pozycje kosztorysowe (użyj ich!):`);
                facts.typicalItems.forEach((item: string) => sections.push(`    - ${item}`));
            }
            if (f.normBasis) sections.push(`  Podstawa: ${f.normBasis}`);
            sections.push("");
        });
    }

    // COST_INDICATOR — wskaźniki gotowe do użycia
    if (byCategory["COST_INDICATOR"]?.length > 0) {
        sections.push("=== 💰 WSKAŹNIKI KOSZTOWE OD TECHNOLOGA (COST_INDICATOR) ===");
        sections.push("ZASADA: Jeśli znasz powierzchnię/ilość — przelicz i wpisz cenaJed do pozycji kosztorysowej.");
        sections.push("");
        byCategory["COST_INDICATOR"].forEach((f: any) => {
            const facts = f.facts || {};
            sections.push(`▶ ${facts.scope || f.findingId}`);
            sections.push(`  Wskaźnik: ${facts.estimatedUnitCostMin || facts.unitCost || "?"} - ${facts.estimatedUnitCostMax || "?"} PLN/${facts.unit || "j.m."}`);
            sections.push(`  Źródło: ${facts.source || "brak"} (${facts.year || "?"})`);
            sections.push(`  Pewność: ${f.confidence}%`);
            sections.push("");
        });
    }

    // MATERIAL_SPEC
    if (byCategory["MATERIAL_SPEC"]?.length > 0) {
        sections.push("=== 🧱 SPECYFIKACJE MATERIAŁÓW (MATERIAL_SPEC) ===");
        sections.push("ZASADA: Wpisz te parametry do knownFacts i użyj w opisach pozycji kosztorysowych.");
        sections.push("");
        byCategory["MATERIAL_SPEC"].forEach((f: any) => {
            const facts = f.facts || {};
            sections.push(`▶ ${facts.element || f.findingId}: ${facts.material || ""} ${facts.specification || ""}`);
            sections.push(`  Podstawa: ${facts.normBasis || f.normBasis || "brak"} | Pewność: ${f.confidence}%`);
        });
        sections.push("");
    }

    // QUANTITY_ESTIMATE
    if (byCategory["QUANTITY_ESTIMATE"]?.length > 0) {
        sections.push("=== 📐 ILOŚCI WSKAŹNIKOWE (QUANTITY_ESTIMATE) ===");
        sections.push("ZASADA: Użyj tych ilości bezpośrednio w newEstimateItems (ilosc + jednostka gotowe).");
        sections.push("");
        byCategory["QUANTITY_ESTIMATE"].forEach((f: any) => {
            const facts = f.facts || {};
            sections.push(`▶ ${facts.element || f.findingId}: ${facts.quantity || "?"} ${facts.unit || "j.m."}`);
            sections.push(`  Metoda: ${facts.calculationMethod || "wskaźnikowa"} | Pewność: ${f.confidence}%`);
        });
        sections.push("");
    }

    // NORM_REQUIREMENT
    if (byCategory["NORM_REQUIREMENT"]?.length > 0) {
        sections.push("=== 📋 WYMAGANIA NORMOWE (NORM_REQUIREMENT) ===");
        byCategory["NORM_REQUIREMENT"].forEach((f: any) => {
            const facts = f.facts || {};
            sections.push(`▶ ${facts.requirement || f.findingId}`);
            sections.push(`  Podstawa: ${facts.legalBasis || f.normBasis || "brak"}`);
            if (facts.consequence) sections.push(`  Skutek pominięcia: ${facts.consequence}`);
        });
        sections.push("");
    }

    return sections.join("\n");
}

// ─────────────────────────────────────────────────────────────────
// Sygnatura zadania — do deduplikacji (agentType + zbiór inputDocIds + instrukcja)
// ─────────────────────────────────────────────────────────────────

function taskSignature(agentType: string, inputDocIds: string[] | undefined, instruction: string): string {
    const sortedIds = [...(inputDocIds || [])].sort();
    // Normalizujemy instrukcję (małe litery, brak spacji i znaków specjalnych),
    // aby drobne różnice w spacjach nie oszukały systemu, ale inne polecenia będą się różnić.
    const normalizedInstruction = (instruction || "")
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "");
    return `${agentType}::${sortedIds.join(",")}::${normalizedInstruction}`;
}

// ─────────────────────────────────────────────────────────────────
// Heurystyczne dopasowanie MISSING_SCOPE do sekcji kosztorysu
// ─────────────────────────────────────────────────────────────────

function normalizeForMatch(s: string): string {
    return (s || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "") // usuń diakrytyki
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
}

function buildScopeCoverageContext(
    technologistFindings: any[],
    estimateState: { sekcja: string; liczba_pozycji: number; wartosc_zl: number }[]
): string {
    const missingScopeFindings = technologistFindings.filter((f: any) => f.category === "MISSING_SCOPE");
    if (missingScopeFindings.length === 0) {
        return "Technolog nie zgłosił żadnych MISSING_SCOPE — brak do skorelowania.";
    }
    if (estimateState.length === 0) {
        return "Kosztorys jest całkowicie pusty — wszystkie zgłoszone MISSING_SCOPE są nadal NIEPOKRYTE.";
    }

    const normalizedSections = estimateState.map(s => ({
        original: s.sekcja,
        normalized: normalizeForMatch(s.sekcja),
        liczba_pozycji: s.liczba_pozycji
    }));

    const lines: string[] = [];
    lines.push("Korelacja MISSING_SCOPE od Technologa ze stanem kosztorysu (dopasowanie nazw — przybliżone, zweryfikuj sam):");
    lines.push("");

    missingScopeFindings.forEach((f: any) => {
        const facts = f.facts || {};
        const divisionName = facts.divisionName || f.findingId || "";
        const normDivision = normalizeForMatch(divisionName);

        const matches = normalizedSections.filter(s =>
            s.normalized.includes(normDivision) ||
            normDivision.includes(s.normalized) ||
            (normDivision.length > 4 && s.normalized.includes(normDivision.slice(0, Math.min(8, normDivision.length))))
        );

        if (matches.length > 0) {
            const totalItems = matches.reduce((sum, m) => sum + m.liczba_pozycji, 0);
            if (totalItems > 0) {
                lines.push(`▶ "${divisionName}" → ⚠️ MOŻLIWE POKRYCIE: znaleziono w kosztorysie sekcję/e [${matches.map(m => `"${m.original}" (${m.liczba_pozycji} poz.)`).join(", ")}].`);
                lines.push(`  NIE generuj ponownie tych pozycji i NIE zlecaj ponownie BOQ_PARSER/BUDOWLANIEC dla tego zakresu bez weryfikacji — sprawdź najpierw, czy te pozycje rzeczywiście odpowiadają temu zakresowi (np. mogły zostać dodane przez Obmiarowca na zlecenie Technologa).`);
            } else {
                lines.push(`▶ "${divisionName}" → sekcja o podobnej nazwie istnieje [${matches.map(m => `"${m.original}"`).join(", ")}], ale ma 0 pozycji. Wciąż NIEPOKRYTE — działaj.`);
            }
        } else {
            lines.push(`▶ "${divisionName}" → 🔴 NIEPOKRYTE. Brak odpowiadającej sekcji w kosztorysie. Wymaga akcji.`);
        }
    });

    return lines.join("\n");
}

function summarizeTaskDoc(d: any, origin: "MOZG" | "TECHNOLOG"): any {
    const data = d.data();
    return {
        origin,
        taskId: d.id,
        agentType: data.agentType,
        status: data.status,
        inputDocIds: data.inputDocIds || [],
        instruction: (data.instruction || "").substring(0, 160),
        resultSummary: data.status === "DONE"
            ? (data.rawResult?.summary || (data.rawResult?.items ? `Zwrócono ${data.rawResult.items.length} pozycji` : "Wykonano"))
            : (data.rawResult?.error || (data.status === "PENDING" || data.status === "IN_PROGRESS" ? "W toku" : "BŁĄD")),
        extractionProfile: data.extractionProfile || null
    };
}

export async function POST(req: Request) {
    try {
        const { tenderId, trigger } = await req.json();
        if (!tenderId) return NextResponse.json({ error: "Brak tenderId" }, { status: 400 });

        console.log(`[MÓZG 🧠] Cognitive Wake-up. tenderID: ${tenderId} | Trigger: ${trigger}`);

        const tasksRef = adminDb.collection(`tenders/${tenderId}/tasks`);
        const technologTasksRef = adminDb.collection(`tenders/${tenderId}/technologTasks`);
        const brainRef = adminDb.collection(`tenders/${tenderId}/brain`).doc("main");
        const tenderRef = adminDb.collection("tenders").doc(tenderId);

        // Seeding agentów
        let agentRegistrySnap = await adminDb.collection("agentRegistry").get();
        if (agentRegistrySnap.empty) {
            console.log("[MÓZG 🧠] Seeding bazy agentów...");
            const defaultAgents = [
                { name: "VISION", endpoint: "/api/kosztorysant/agent-wbs-architekt", capabilities: ["vision", "pdf_parsing"], description: "Narzędzie (Skaner). Czyta wymiary, przekroje i legendy z PDF z rysunkami. WYMAGA extractionProfile." },
                { name: "LEGAL_EXPERT", endpoint: "/api/kosztorysant/czytacz-dokumentow", capabilities: ["text_analysis"], description: "Narzędzie (Skaner tekstu). Szuka słów kluczowych o umowach, karach i SWZ." },
                { name: "PYTHON_CALC", endpoint: "/api/kosztorysant/agent-python-calc", capabilities: ["codeExecution"], description: "Narzędzie (Kalkulator). Przemnóż setki liczb wyciągniętych przez inne narzędzia." },
                { name: "BROKER", endpoint: "/api/kosztorysant/broker-cenowy", capabilities: ["googleSearch"], description: "Narzędzie (Pobieracz stawek). Wrzuca ceny R/M/S do gotowych pozycji." },
                { name: "BUDOWLANIEC", endpoint: "/api/kosztorysant/agent-budowlaniec", capabilities: ["engineering", "googleSearch"], description: "Narzędzie (Wyszukiwarka Norm). Wrzuca technologię domyślną z norm gdy masz lukę. Idealny do obsługi MISSING_SCOPE od Technologa — daj mu nazwę działu i typicalItems, on rozpisze pełny przedmiar." },
                { name: "SILENT_AUDITOR", endpoint: "/api/kosztorysant/agent-cichy-rewident", capabilities: ["audit", "googleSearch"], description: "Narzędzie (Audytor Prawny). Waliduje gotowe pozycje z WT2021 i PPOŻ." },
                { name: "GAP_FILLER", endpoint: "/api/kosztorysant/agent-gap-filler", capabilities: ["estimation", "googleSearch"], description: "Narzędzie (Szacowarka). Wycenia wskaźnikowo zakresy bez dokumentów. Użyj gdy Technolog dał MISSING_SCOPE z COST_INDICATOR — GAP_FILLER może od razu wycenić." },
                { name: "BOQ_PARSER", endpoint: "/api/kosztorysant/agent-ilosciowiec", capabilities: ["table_parsing"], description: "Narzędzie (Ekstraktor Excel/PDF). Ściąga czyste dane tabelaryczne z przedmiarów. WYMAGA extractionProfile." },
                { name: "KAMELEON", endpoint: "/api/kosztorysant/agent-kameleon", capabilities: ["specialist_analysis"], description: "Narzędzie (Skaner specjalistyczny). Czyta wąskie opisy technologii." },
                {
                    name: "REVISOR_JUDGE",
                    endpoint: "/api/kosztorysant/agent-rewident",
                    capabilities: ["legal_reasoning", "googleSearch", "conflict_resolution"],
                    description: "Narzędzie (Sędzia Roju). Skanuje kolekcję 'conflicts', rozstrzyga spory technologiczne i prawne w oparciu o PZP, WT 2021 i hierarchię dokumentów SWZ. Wywołuj gdy conflicts.status == OPEN lub INVESTIGATING."
                },
                {
                    name: "PDF_SPLITTER",
                    endpoint: "/api/kosztorysant/agent-pdf-splitter",
                    capabilities: ["pdf_parsing", "semantic_chunking"],
                    description: "Narzędzie (Semantyczny Skaner Struktury). ZAWSZE wywołaj przed wysłaniem dużego PDF (>5 stron) do VISION lub BOQ_PARSER. Mapuje logiczne granice dokumentu i zwraca gotową mapę segmentów."
                },
                { name: "MAPPING_DETECTIVE", endpoint: "/api/kosztorysant/agent-detektyw", capabilities: ["pdf_parsing", "correlations"], description: "Narzędzie (Korelator PDF). Łączy 2 pliki PDF w wymiar 3D." }
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
                console.log(`[MÓZG 🧠] Timeout zadania ${doc.id} — oznaczam jako ERROR.`);
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

        // Obsługa triggera od Technologa
        if (trigger === "TECHNOLOGIST_NEW_FINDINGS") {
            await tenderRef.update({ hasNewTechnologistFindings: false });
            console.log("[MÓZG 🧠] Wybudzony przez Technologa — nowe findings są dostępne.");
        }

        // Pobieranie wszystkich danych równolegle
        const [
            docsSnap,
            brainSnap,
            unprocessedTasksSnap,
            tenderDoc,
            chatHistSnap,
            estimateSnap,
            allTasksHistorySnap,
            technologistFindingsSnap,
            technologSnap,
            technologTasksSnap
        ] = await Promise.all([
            adminDb.collection(`tenders/${tenderId}/documents`).get(),
            brainRef.get(),
            tasksRef.where("status", "in", ["DONE", "ERROR"]).where("processedByBrain", "==", false).get(),
            tenderRef.get(),
            adminDb.collection(`tenders/${tenderId}/chat`).orderBy("timestamp", "asc").limit(20).get(),
            adminDb.collection(`tenders/${tenderId}/estimate`).get(),
            tasksRef.get(),
            adminDb.collection(`tenders/${tenderId}/technologistFindings`).get(),
            adminDb.collection(`tenders/${tenderId}/technolog`).doc("main").get(),
            technologTasksRef.get().catch(() => ({ docs: [] } as any))
        ]);

        if (tenderDoc.exists && tenderDoc.data()?.status === "HALTED") {
            return NextResponse.json({ message: "Przetarg zatrzymany (HALTED)." });
        }

        // 🟢 UWZGLĘDNIONE constructionDivisions ORAZ hasSeparatedDrawings
        const documents = docsSnap.docs.map(d => ({
            id: d.id,
            fileName: d.data().fileName,
            tags: d.data().tags || [],
            summary: d.data().summary || "(brak)",
            containsDrawings: d.data().containsDrawings || false,
            pageCount: d.data().pageCount || null,
            hasSeparatedDrawings: d.data().hasSeparatedDrawings || false,
            constructionDivisions: d.data().constructionDivisions || []
        }));

        const currentBrainData = brainSnap.exists ? brainSnap.data() : {};
        const currentCognitiveState = currentBrainData?.cognitiveState || {
            worldModel: [], knownFacts: {}, hypotheses: [], assumptions: [], knowledgeGaps: [], failedStrategies: []
        };

        const chatHistory = chatHistSnap.docs.map(c => ({ rola: c.data().role, treść: c.data().content }));

        const newlyFinishedResults = unprocessedTasksSnap.docs.map(d => ({
            taskId: d.id,
            agentType: d.data().agentType,
            status: d.data().status,
            instruction: d.data().instruction,
            rawResult: d.data().rawResult,
            extractionProfile: d.data().extractionProfile || null
        }));

        // Rzeczywisty stan kosztorysu (subkolekcje)
        const estimateState = await Promise.all(estimateSnap.docs.map(async (d) => {
            const itemsSnap = await d.ref.collection("items").get();
            return {
                sekcja: d.data().section,
                liczba_pozycji: itemsSnap.size,
                wartosc_zl: d.data().totalValue || 0
            };
        }));
        const isEstimateEmpty = estimateState.length === 0 || estimateState.every(s => s.liczba_pozycji === 0);

        const brainTaskSummaries = allTasksHistorySnap.docs.map(d => summarizeTaskDoc(d, "MOZG"));
        const technologTaskSummaries = (technologTasksSnap.docs || []).map((d: any) => summarizeTaskDoc(d, "TECHNOLOG"));
        const combinedTaskHistory = [...brainTaskSummaries, ...technologTaskSummaries];

        // Semantyczne sygnatury do guard rail
        const existingTaskSignatures = new Set<string>(
            combinedTaskHistory
                .filter((t: any) => ["PENDING", "IN_PROGRESS", "DONE"].includes(t.status))
                .map((t: any) => taskSignature(t.agentType, t.inputDocIds, t.instruction))
        );

        const technologistFindings = technologistFindingsSnap.docs.map(d => ({
            findingId: d.id,
            category: d.data().category,
            facts: d.data().facts,
            confidence: d.data().confidence,
            normBasis: d.data().normBasis || null
        }));
        const techPhase = technologSnap.exists ? (technologSnap.data()?.phase || "UNKNOWN") : "NOT_STARTED";
        const techGoal = technologSnap.exists ? (technologSnap.data()?.currentGoal || "") : "";
        const techIdentifiedMissingScopes = technologSnap.exists
            ? (technologSnap.data()?.technologicalState?.identifiedMissingScopes || [])
            : [];

        const technologistContext = buildTechnologistContext(technologistFindings, techPhase);
        const scopeCoverageContext = buildScopeCoverageContext(technologistFindings, estimateState);

        const technologGapsInProgress = technologSnap.exists
            ? (technologSnap.data()?.technologicalState?.technologicalGaps || []).map((g: any) => g.element)
            : [];

        const systemPrompt = `Jesteś Mózgiem (Orkiestratorem) — jedynym Inżynierem i Architektem systemu PESAM 3.0.

=== ZASADA DZIAŁANIA (COGNITIVE ARCHITECTURE) ===
Nie deleguj ślepo — TY JESTEŚ JEDYNYM EKSPERTEM.
Twój proces:
1. Budowa hipotezy czym jest inwestycja (worldModel).
2. BELIEF REVISION: Konfrontuj nowe dane ze starymi hipotezami. Obniżaj/podnoś pewność.
3. Wykrywanie luk. Oblicz Wpływ Ekonomiczny (Economic Impact Score 1-100).
4. Wysyłanie narzędzi TYLKO by zweryfikować luki o najwyższym ryzyku finansowym.
5. Generowanie pozycji WYŁĄCZNIE gdy pewność (confidence) ≥ 75%.

=== ZASADA WSPÓŁPRACY Z TECHNOLOGIEM ===
Masz drugiego eksperta — Technologa Budowlanego. On pracuje równolegle, ma WŁASNYCH workerów (np. może
samodzielnie zlecić Obmiarowcowi/BOQ_PARSER ekstrakcję konkretnego przedmiaru) i dostarcza Ci dodatkowo:
- Listę BRAKUJĄCYCH działów kosztorysowych (MISSING_SCOPE)
- Wskaźniki kosztowe (COST_INDICATOR)
- Specyfikacje materiałów (MATERIAL_SPEC)
- Ilości wskaźnikowe (QUANTITY_ESTIMATE)
- Wymagania normowe (NORM_REQUIREMENT)

KLUCZOWE: Sekcja "HISTORIA WSZYSTKICH ZADAŃ" zawiera zadania zlecone PRZEZ CIEBIE (origin: MOZG) ORAZ zadania
zlecone PRZEZ TECHNOLOGA jego workerom (origin: TECHNOLOG). Jeśli widzisz tam np. że Technolog zlecił
BOQ_PARSER dla konkretnego pliku/zakresu i ma status DONE — te dane PRAWDOPODOBNIE trafiły już do kosztorysu
(sekcja "AKTUALNY STAN KOSZTORYSU"). NIE zlecaj tego ponownie. Pamiętaj jednak, że zadanie Technologa może
dotyczyć tylko WYCINKA jednego działu (np. jednej branży instalacyjnej) — nie zakładaj automatycznie, że
CAŁY dział jest pokryty tylko bo Technolog coś zlecił. Zweryfikuj zakres (inputDocIds, instruction,
resultSummary) i porównaj z liczbą pozycji w odpowiadającej sekcji kosztorysu.

▸ Fizycznie wycięte rysunki (hasSeparatedDrawings: true):
  Jeśli dokument posiada flagę 'hasSeparatedDrawings: true', oznacza to, że rysunki techniczne zostały
  fizycznie odseparowane do osobnego pliku pomocniczego w celu optymalizacji kosztów. Kiedy będziesz 
  zlecać zadanie analizy rysunków Agentowi Vision, użyj normalnego ID tego dokumentu — Agent Vision 
  automatycznie i po cichu przekieruje swoje zapytanie na ten wycięty plik PDF z rysunkami.

ZASADY KORZYSTANIA Z DANYCH TECHNOLOGA:
▸ MISSING_SCOPE z confidence ≥ 70%:
  Sprawdź najpierw sekcję "POKRYCIE MISSING_SCOPE PRZEZ KOSZTORYS" poniżej — mówi ona, czy dany dział ma już
  pozycje w kosztorysie (niezależnie od tego, kto je tam wstawił — Ty, BOQ_PARSER czy worker Technologa).
  - Jeśli dział jest oznaczony jako NIEPOKRYTE → MUSISZ ZAREAGOWAĆ:
    a) Jeśli typicalItems są konkretne → generuj pozycje SAMODZIELNIE do newEstimateItems (assumptionMode: true, oznacz [ZAKRES TECHNOLOGA])
    b) Jeśli typicalItems są ogólne → zlecaj BUDOWLANIEC z instrukcją: "Rozpisz pełny przedmiar dla działu [nazwa], typowe pozycje: [lista]. Obiekt: [typ]"
  - Jeśli dział jest oznaczony jako MOŻLIWE POKRYCIE → NIE generuj duplikatów. Możesz jednak zlecić
    SILENT_AUDITOR lub PYTHON_CALC weryfikację kompletności/wartości istniejących pozycji, jeśli uznasz to
    za istotne, ale nie twórz nowych pozycji dla tego zakresu bez wyraźnego powodu.
  NIE ignoruj MISSING_SCOPE oznaczonego jako NIEPOKRYTE. Brak reakcji = dziura w kosztorysie.

▸ COST_INDICATOR z confidence ≥ 65%:
  Przelicz: unitCostMin × ilość = wartość. Wpisz do opisu pozycji [WSKAŹNIK: X PLN/j.m. × Y j.m. = Z PLN].
  Jeśli masz MISSING_SCOPE (NIEPOKRYTE) + COST_INDICATOR dla tego samego zakresu → zlecaj GAP_FILLER z oboma danymi.
  GAP_FILLER dostanie wskaźnik i wygeneruje pozycje z cenami.

▸ MATERIAL_SPEC z confidence ≥ 70%:
  Zapisz do knownFacts. Użyj w opisach pozycji (np. "Beton C25/30 wg PN-EN 206").

▸ QUANTITY_ESTIMATE z confidence ≥ 70%:
  Użyj bezpośrednio jako ilosc w newEstimateItems — nie szacuj własnych ilości gdy Technolog już podał.

▸ Technolog w fazie WORKING lub ANALYZING:
  Dla zakresów które MA W KOLEJCE (technologGapsInProgress) — POCZEKAJ zanim zaczniesz zgadywać.
  Nie twórz duplikatów. Sprawdź co Technolog już bada (sekcja HISTORIA WSZYSTKICH ZADAŃ, origin: TECHNOLOG,
  status PENDING/IN_PROGRESS).

▸ Technolog w fazie DONE:
  Wszystkie jego dane są finalne. Działaj na nich w pełni.

=== ZASADA DEDUPLIKACJI ZADAŃ (GUARD RAIL) ===
Przed dodaniem zadania do newTasks, sprawdź sekcję "HISTORIA WSZYSTKICH ZADAŃ" — jeśli istnieje wpis
(z Twojej historii LUB Technologa) z tym samym agentType i tym samym (lub podzbiorem/nadzbiorem) zestawem
inputDocIds, w statusie PENDING, IN_PROGRESS lub DONE — NIE twórz duplikatu. System odrzuci identyczne
sygnatury automatycznie, ale Twoim zadaniem jest nie próbować ich tworzyć w ogóle (oszczędza to cykl
rozumowania). Jeśli potrzebujesz INNEJ części tego samego dokumentu lub innego extractionProfile —
to NIE jest duplikat, możesz zlecić.

=== TRYB ZAŁOŻEŃ RYNKOWYCH (ASSUMPTION_MODE) ===
Jeśli brakuje dokumentacji technicznej LUB reagujesz na MISSING_SCOPE (NIEPOKRYTE) bez rysunków:
- Włącz assumptionMode: true
- Przygotuj assumptionDisclaimer
- Każdą pozycję oznacz w opisie jako [ZAŁOŻENIE RYNKOWE] lub [ZAKRES TECHNOLOGA]
- Używaj agresywnie BUDOWLANIEC + GAP_FILLER

=== TWOJE NARZĘDZIA ===
${JSON.stringify(availableAgents.map(a => ({ name: a.name, opis: a.description, mozliwosci: a.capabilities })), null, 2)}

${EXTRACTION_PROFILES_GUIDE}

=== ZASADY UŻYWANIA PDF_SPLITTER ===
Dokumenty > 5 stron z containsDrawings === true → ZAWSZE najpierw PDF_SPLITTER.
Użyj agentInstruction z każdego segmentu jako instruction dla VISION/BOQ_PARSER.

=== ZASADY UŻYWANIA REVISOR_JUDGE ===
Wywołuj gdy w kolekcji conflicts istnieje status == "OPEN" lub "INVESTIGATING".
Nie podawaj inputDocIds. Po wykonaniu sprawdź czy zmienił na RESOLVED lub ESCALATED_TO_USER.

=== DOKUMENTY PROJEKTU (ZAWIERAJĄ SPIS DZIAŁÓW) ===
${JSON.stringify(documents.map(d => ({
            id: d.id,
            fileName: d.fileName,
            summary: d.summary,
            hasSeparatedDrawings: d.hasSeparatedDrawings,
            constructionDivisions: d.constructionDivisions // Mózg od razu widzi, co jest w pliku
        })), null, 2)}

=== TWÓJ AKTUALNY STAN POZNAWCZY ===
${JSON.stringify(currentCognitiveState, null, 2)}

=== NOWE WYNIKI OD NARZĘDZI (świeże dane) ===
${newlyFinishedResults.length > 0 ? JSON.stringify(newlyFinishedResults, null, 2) : "(brak nowych wyników)"}

=== HISTORIA WSZYSTKICH ZADAŃ (Twoje + Technologa, origin = MOZG | TECHNOLOG) ===
${JSON.stringify(combinedTaskHistory, null, 2)}

=== AKTUALNY STAN KOSZTORYSU (sekcje + RZECZYWISTA liczba pozycji z subkolekcji items) ===
${isEstimateEmpty
                ? "⚠️ KOSZTORYS JEST PUSTY. Szukaj luk kosztotwórczych (80-100 pkt) i twardych faktów."
                : JSON.stringify(estimateState, null, 2)}

=== POKRYCIE MISSING_SCOPE PRZEZ KOSZTORYS (korelacja automatyczna — zweryfikuj) ===
${scopeCoverageContext}

=== DANE OD TECHNOLOGA BUDOWLANEGO ===
${technologistContext}

=== STATUS TECHNOLOGA ===
Faza: ${techPhase}
Aktualny cel: ${techGoal || "brak"}
Zakresy które Technolog aktualnie bada (NIE duplikuj): ${technologGapsInProgress.length > 0 ? technologGapsInProgress.join(", ") : "brak"}
Brakujące zakresy zidentyfikowane przez Technologa: ${techIdentifiedMissingScopes.length > 0
                ? techIdentifiedMissingScopes.map((s: any) => `${s.division} [impact: ${s.impactScore}/10]`).join(", ")
                : "brak"}

=== ŚLEDZENIE OBLICZEŃ (CALCULATION TRAIL) ===
Każda pozycja w newEstimateItems musi mieć w polu "opis" dowód matematyczny i źródłowy w nawiasie kwadratowym.
Przykład: "Beton C25/30 fundamenty [250 m3 × 450 zł/m3 = 112 500 PLN | źródło: MATERIAL_SPEC Technologa]"

UWAGA KRYTYCZNA: Pozycje BOQ_PARSER (zarówno Twoje, jak i Technologa) zapisują się AUTOMATYCZNIE do kosztorysu.
Jeśli widzisz w HISTORII WSZYSTKICH ZADAŃ, że BOQ_PARSER (origin: MOZG lub TECHNOLOG) zwrócił pozycje
(resultSummary "Zwrócono N pozycji") — te pozycje SĄ JUŻ w "AKTUALNY STAN KOSZTORYSU". NIE przepisuj ich
do newEstimateItems.

=== HISTORIA CZATU ===
${chatHistory.length > 0 ? JSON.stringify(chatHistory, null, 2) : "(brak wiadomości)"}

=== CO MASZ ZROBIĆ ===
1. Zaktualizuj CognitiveState. Przerób wyniki narzędzi i findings Technologa w fakty. Belief Revision.
   Uwzględnij RZECZYWISTY stan kosztorysu (estimateState) — jeśli pokazuje pozycje, których wcześniej nie
   widziałeś (bo zlecił je Technolog), zaktualizuj worldModel/knownFacts o tym fakcie.
2. Przeprowadź Samokrytykę. Sprawdź failedStrategies. Sprawdź, czy nie powtarzasz zadania, które już
   wykonał Technolog (HISTORIA WSZYSTKICH ZADAŃ, origin: TECHNOLOG).
3. REAGUJ na każde MISSING_SCOPE od Technologa oznaczone jako NIEPOKRYTE — to Twój priorytet gdy kosztorys
   jest niepełny. Dla MOŻLIWE POKRYCIE — zweryfikuj, nie duplikuj.
4. Gdy tworzysz zadanie dla BOQ_PARSER lub VISION — zawsze wypełnij extractionProfile.
5. Pamiętaj: workery (BUDOWLANIEC, GAP_FILLER, SILENT_AUDITOR itp.) działają BEZ sztywnego schematu — daj im precyzyjne instrukcje tekstowe w polu instruction.
6. Przed dodaniem zadania do newTasks sprawdź deduplikację (patrz ZASADA DEDUPLIKACJI ZADAŃ).`;

        console.log(`[MÓZG 🧠] Prompt gotowy. Findings od Technologa: ${technologistFindings.length}. Zadania Technologa w historii: ${technologTaskSummaries.length}. Wywołuję model...`);

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

        let parsedResult: any = {};
        try {
            parsedResult = JSON.parse(jsonrepair(result.text ?? "{}"));
        } catch (e) {
            console.error("[MÓZG 🧠] Krytyczny błąd parsowania JSON:", e);
        }

        console.log(`[MÓZG 🧠] Phase: ${parsedResult.phase}`);
        console.log(`[MÓZG 🧠] Next Best Action: ${parsedResult.nextBestAction}`);
        console.log(`[MÓZG 🧠] Self-Critique: ${parsedResult.selfCritique?.substring(0, 100)}...`);

        const batch = adminDb.batch();

        // Oznacz przetworzone zadania + AUTO-COMMITTER dla BOQ_PARSER
        unprocessedTasksSnap.docs.forEach(doc => {
            batch.update(doc.ref, { processedByBrain: true });

            const taskData = doc.data();
            if (taskData.agentType === "BOQ_PARSER" && taskData.status === "DONE" && taskData.rawResult?.items?.length > 0) {
                const items = taskData.rawResult.items;
                const sectionName = taskData.rawResult.contextLabel || "Przedmiar Zaimportowany";
                const sectionId = `sec_${sectionName.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 30)}`;
                const sectionRef = adminDb.collection(`tenders/${tenderId}/estimate`).doc(sectionId);

                batch.set(sectionRef, {
                    section: sectionName,
                    status: "QUANTITY_READY",
                    totalValue: 0,
                    updatedAt: new Date()
                }, { merge: true });

                items.forEach((item: any) => {
                    const id = randomUUID();
                    batch.set(sectionRef.collection("items").doc(id), {
                        id,
                        pozycja: item.pozycja || "",
                        opis: item.opis || "",
                        ilosc: Number(item.ilosc) || 0,
                        jednostka: item.jednostka || "j.m.",
                        cenaJed: 0,
                        KNR_ref: item.KNR_ref || "",
                        confidence: "HIGH",
                        sourceTrack: `BOQ_PARSER auto-commit (${sectionName})`
                    });
                });
                console.log(`[MÓZG 🧠] AUTO-COMMIT: ${items.length} pozycji → sekcja "${sectionName}"`);
            }
        });

        // Wiadomości do czatu
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

        // Zapisz stan Mózgu
        batch.update(brainRef, {
            phase: parsedResult.phase,
            currentGoal: parsedResult.currentGoal,
            cognitiveState: parsedResult.cognitiveState,
            assumptionMode: parsedResult.assumptionMode || false,
            assumptionDisclaimer: parsedResult.assumptionDisclaimer || null,
            reasoningLog: FieldValue.arrayUnion(
                `[${new Date().toISOString()}] Reasoning: ${(parsedResult.reasoning || "").substring(0, 200)} | Next: ${parsedResult.nextBestAction || ""}`
            ),
            updatedAt: new Date()
        });

        // Zapisz nowe pozycje kosztorysowe
        if (parsedResult.newEstimateItems?.length > 0) {
            console.log(`[MÓZG 🧠] Zapisuję ${parsedResult.newEstimateItems.length} pozycji (≥75% pewności lub tryb założeń).`);

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
                    cenaJed: Number(item.cenaJed) || 0,
                    KNR_ref: item.KNR_ref || "",
                    confidence: parsedResult.assumptionMode ? "ASSUMPTION_MODE" : "AI_COGNITIVE_MODEL",
                    sourceTrack: parsedResult.assumptionMode
                        ? "Konceptualizacja Mózgu / Dane Technologa"
                        : "Model Poznawczy Mózgu"
                }));

                batch.set(sectionRef, {
                    section: sectionName,
                    status: "QUANTITY_READY",
                    totalValue: 0,
                    updatedAt: new Date()
                }, { merge: true });

                formattedItems.forEach(fItem => {
                    batch.set(sectionRef.collection("items").doc(fItem.id), fItem);
                });
            }
        }

        // ── POPRAWKA #3: deduplikacja newTasks (guard rail po stronie kodu) ──
        const newTasksCreated: any[] = [];
        (parsedResult.newTasks || []).forEach((task: any) => {
            const sig = taskSignature(task.agentType, task.inputDocIds, task.instruction);

            if (existingTaskSignatures.has(sig)) {
                console.log(`[MÓZG 🧠] DEDUPLIKACJA: Zadanie ${task.agentType} dla [${(task.inputDocIds || []).join(", ")}] już istnieje (PENDING/IN_PROGRESS/DONE — Mózg lub Technolog) — odrzucono.`);
                return;
            }
            existingTaskSignatures.add(sig);

            const taskRef = tasksRef.doc();
            const inputFacts: Record<string, any> = {};
            (task.inputFactsKeys || []).forEach((key: string) => {
                if (parsedResult.cognitiveState?.knownFacts?.[key] !== undefined) {
                    inputFacts[key] = parsedResult.cognitiveState.knownFacts[key];
                }
            });

            if (task.extractionProfile) {
                console.log(`[MÓZG 🧠] Zadanie z extractionProfile: ${task.agentType} | ${task.extractionProfile.contextLabel} | pola: ${task.extractionProfile.customFields?.map((f: any) => f.name).join(", ")}`);
            } else {
                console.log(`[MÓZG 🧠] Zadanie: ${task.agentType} | ${task.instruction?.substring(0, 60)}...`);
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

        // Status przetargu
        const newTenderStatus = parsedResult.phase === "DONE" ? "DONE"
            : parsedResult.phase === "WAITING_INPUT" ? "WAITING_INPUT"
                : "ORCHESTRATING";

        batch.update(tenderRef, {
            "budgetGuard.currentCostUSD": FieldValue.increment(
                ((result.usageMetadata?.totalTokenCount || 0) / 1000) * 0.002
            ),
            status: newTenderStatus,
            updatedAt: new Date()
        });

        await batch.commit();
        console.log(`[MÓZG 🧠] Batch zapisany. Status: ${newTenderStatus}. Narzędzi zleconych: ${newTasksCreated.length}.`);

        const localOrigin = `http://localhost:${process.env.PORT || "3000"}`;

        // Uruchamianie agentów z pacingiem i jitterem
        const triggerAgentsWithPacing = async () => {
            for (let i = 0; i < newTasksCreated.length; i++) {
                const task = newTasksCreated[i];
                const agentDef = availableAgents.find(a => a.name === task.agentType);
                if (agentDef?.endpoint) {
                    if (i > 0) {
                        const pause = 3000 + Math.random() * 2000;
                        await new Promise(r => setTimeout(r, pause));
                    }
                    await fetch(`${localOrigin}${agentDef.endpoint}`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ tenderId, taskId: task.taskId })
                    }).catch(err => console.error(`[MÓZG 🧠] Błąd uruchamiania ${task.agentType}:`, err.message));
                } else {
                    await adminDb.collection(`tenders/${tenderId}/tasks`).doc(task.taskId).update({
                        status: "ERROR",
                        rawResult: { error: `Narzędzie "${task.agentType}" nie istnieje w rejestrze.` },
                        processedByBrain: false,
                        updatedAt: new Date()
                    }).catch(() => { });
                }
            }
        };

        await triggerAgentsWithPacing();

        return NextResponse.json({
            success: true,
            phase: parsedResult.phase,
            tasksCreated: newTasksCreated.length,
            estimateItemsAdded: parsedResult.newEstimateItems?.length || 0,
            technologistFindingsProcessed: technologistFindings.length
        });

    } catch (error: any) {
        console.error("[MÓZG 🧠] ❌ Krytyczny błąd Mózgu:", error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}