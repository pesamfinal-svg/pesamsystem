import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { FieldValue } from "firebase-admin/firestore";
import { GoogleGenAI, Type } from "@google/genai";
import { randomUUID } from "crypto";
import { jsonrepair } from "jsonrepair"; // <--- TEGO BRAKOWAŁO!
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

const TECHNOLOG_AGENTS = [
    {
        name: "MATERIAL_DETECTIVE",
        endpoint: "/api/technolog/agent-technolog-materialowy",
        description: "Skanuje dokumenty w poszukiwaniu parametrów technicznych materiałów budowlanych (klasy betonu, klasy stali, grubości warstw, U-wartości). Używaj gdy masz rysunki lub opisy techniczne."
    },
    {
        name: "QUANTITY_ESTIMATOR",
        endpoint: "/api/technolog/agent-technolog-przedmiarowy",
        description: "Audytor zakresu — porównuje obecny kosztorys z wymaganiami technologicznymi i wskazuje BRAKUJĄCE procesy (np. wywiezienie ziemi, izolacje, rusztowania). Używaj po SCOPE_RESEARCHER gdy masz wstępny kosztorys."
    },
    {
        name: "NORM_ADVISOR",
        endpoint: "/api/technolog/agent-technolog-norm",
        description: "Dobiera parametry techniczne z norm WT2021/Eurokodów/PPOŻ i wskaźniki kosztowe z SEKOCENBUD/BCO używając wyszukiwarki Google. Używaj gdy znasz brakujące zakresy i chcesz je wycenić wskaźnikowo."
    },
    {
        name: "SCOPE_RESEARCHER",
        endpoint: "/api/technolog/agent-scope-researcher",
        description: "PIERWSZE NARZĘDZIE — wyszukuje w internecie (BIP-y gmin, portale przetargowe, eb2b, bazakosztorysow.pl) typowe kosztorysy/przedmiary dla danego typu inwestycji. Identyfikuje luki w dokumentacji przez porównanie z typowym zakresem. URUCHOM JAKO PIERWSZY gdy wiesz jaki typ obiektu."
    }
];

const TECHNOLOG_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        reasoning: {
            type: Type.STRING,
            description: "Tok rozumowania technologicznego. Co wiem o technologii tego obiektu? Co mi brakuje? Czy uruchomiłem SCOPE_RESEARCHER? Jak porównuję zakres typowy vs Spis Działów z dokumentów?"
        },
        selfCritique: {
            type: Type.STRING,
            description: "Samokrytyka: Które z moich założeń mogą być błędne? Czy upewniłem się, że 'brakujący' dział naprawdę nie widnieje w 'constructionDivisions' wgranych plików?"
        },
        nextBestAction: {
            type: Type.STRING,
            description: "Jaka pojedyncza akcja najbardziej zwiększy kompletność kosztorysu?"
        },
        phase: {
            type: Type.STRING,
            description: "ANALYZING (zbieram dane), WORKING (agenci pracują), SYNTHESIZING (pakuję findings dla PESAM), DONE (przekazałem wszystko)"
        },
        currentGoal: {
            type: Type.STRING,
            description: "Aktualny cel technologiczny — konkretny, mierzalny"
        },
        technologicalState: {
            type: Type.OBJECT,
            properties: {
                objectProfile: {
                    type: Type.OBJECT,
                    description: "Profil technologiczny obiektu wyciągnięty z dokumentów",
                    properties: {
                        objectType: { type: Type.STRING, description: "Typ obiektu np. 'przedszkole', 'szkoła podstawowa', 'hala magazynowa'" },
                        constructionSystem: { type: Type.STRING, description: "System konstrukcyjny: murowany/szkieletowy/żelbetowy/stalowy" },
                        foundationType: { type: Type.STRING, description: "Typ fundamentów: ławy/pale/płyta/stopy" },
                        roofType: { type: Type.STRING, description: "Typ dachu: płaski/dwuspadowy/wielospadowy/zielony" },
                        insulationType: { type: Type.STRING, description: "System ocieplenia: ETICS/wdmuchiwana/wełna między krokwiami" },
                        finishStandard: { type: Type.STRING, description: "Standard wykończenia: podstawowy/podwyższony/luksusowy" },
                        estimatedFloorArea: { type: Type.NUMBER, description: "Szacowana powierzchnia użytkowa w m2 jeśli wyciągnięta z dokumentów" },
                        numberOfFloors: { type: Type.NUMBER, description: "Liczba kondygnacji" }
                    }
                },
                confirmedMaterials: {
                    type: Type.ARRAY,
                    description: "Materiały potwierdzone dokumentami z wysoką pewnością (>70%)",
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
                    description: "Parametry normowe wywnioskowane z norm (WT2021, Eurokody) lub szukania",
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
                    description: "Wskaźnikowe ilości elementów obliczone lub znalezione przez agentów",
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
                    description: "Sprzeczności między dokumentami lub normami",
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
                    description: "Luki technologiczne — brakujące info blokujące wycenę",
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            element: { type: Type.STRING },
                            impactScore: { type: Type.NUMBER, description: "0-10, gdzie 10 = bez tego nie da się wycenić" },
                            suggestedAgent: { type: Type.STRING }
                        },
                        required: ["element", "impactScore", "suggestedAgent"]
                    }
                },
                scopeResearchDone: {
                    type: Type.BOOLEAN,
                    description: "TRUE gdy SCOPE_RESEARCHER zakończył i wyniki są w scopeResearchResults"
                },
                identifiedMissingScopes: {
                    type: Type.ARRAY,
                    description: "Lista działów kosztorysowych których BRAKUJE w dokumentacji projektu (zidentyfikowanych przez SCOPE_RESEARCHER lub własną analizę)",
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            division: { type: Type.STRING, description: "Nazwa działu np. 'Instalacje elektryczne wewnętrzne'" },
                            impactScore: { type: Type.NUMBER, description: "0-10 — wpływ na wartość kosztorysu" },
                            estimatedCostShare: { type: Type.STRING, description: "Szacunkowy % wartości całej inwestycji" },
                            sentToPESAM: { type: Type.BOOLEAN, description: "TRUE gdy finding z tym zakresem jest już w findingsForPESAM" }
                        },
                        required: ["division", "impactScore", "estimatedCostShare", "sentToPESAM"]
                    }
                }
            },
            required: [
                "objectProfile", "confirmedMaterials", "derivedParameters",
                "quantityIndicators", "technologicalConflicts", "technologicalGaps",
                "scopeResearchDone", "identifiedMissingScopes"
            ]
        },
        newTasks: {
            type: Type.ARRAY,
            description: "Zadania do zlecenia agentom Technologa. Każde zadanie musi mieć konkretną instrukcję — nie ogólnikową.",
            items: {
                type: Type.OBJECT,
                properties: {
                    agentType: { type: Type.STRING, description: "Jeden z: MATERIAL_DETECTIVE, QUANTITY_ESTIMATOR, NORM_ADVISOR, SCOPE_RESEARCHER" },
                    instruction: { type: Type.STRING, description: "Precyzyjna instrukcja dla agenta — co konkretnie ma zrobić, czego szukać" },
                    inputDocIds: { type: Type.ARRAY, items: { type: Type.STRING }, description: "IDs dokumentów potrzebnych agentowi. [] jeśli agent korzysta tylko z bazy danych lub wyszukiwarki." },
                    inputFacts: {
                        type: Type.OBJECT,
                        description: "Fakty kontekstowe dla agenta (np. objectType, objectDescription, confirmedScopes)"
                    }
                },
                required: ["agentType", "instruction", "inputDocIds"]
            }
        },
        findingsForPESAM: {
            type: Type.ARRAY,
            description: "Fakty technologiczne i luki zakresu gotowe do przekazania Mózgowi PESAM. PESAM użyje ich do uzupełnienia kosztorysu. NIE duplikuj — sprawdź existingFindings przed dodaniem.",
            items: {
                type: Type.OBJECT,
                properties: {
                    findingId: { type: Type.STRING, description: "Unikalny ID — użyj np. 'missing_elektryka', 'material_beton_c25'" },
                    category: {
                        type: Type.STRING,
                        description: "MISSING_SCOPE (brakujący dział), MATERIAL_SPEC (specyfikacja materiału), QUANTITY_ESTIMATE (ilości wskaźnikowe), NORM_REQUIREMENT (wymóg normatywny), COST_INDICATOR (wskaźnik kosztowy)"
                    },
                    facts: {
                        type: Type.OBJECT,
                        description: "Konkretne fakty do przekazania. Dla MISSING_SCOPE: {divisionName, typicalItems[], estimatedCostShare, whyMissing}. Dla MATERIAL_SPEC: {element, material, specification, normBasis}. Dla QUANTITY_ESTIMATE: {element, quantity, unit, calculationMethod}. Dla COST_INDICATOR: {scope, unitCost, unit, source}."
                    },
                    confidence: { type: Type.NUMBER, description: "0-100 — pewność tego faktu" },
                    normBasis: { type: Type.STRING, description: "Podstawa normowa lub źródło jeśli dotyczy" }
                },
                required: ["findingId", "category", "facts", "confidence"]
            }
        },
        chatReply: {
            type: Type.ARRAY,
            description: "Komunikaty dla użytkownika — używaj tylko gdy potrzebujesz czegoś od niego lub masz ważne ostrzeżenie.",
            items: { type: Type.STRING }
        }
    },
    required: [
        "reasoning", "selfCritique", "nextBestAction", "phase",
        "currentGoal", "technologicalState", "newTasks", "findingsForPESAM", "chatReply"
    ]
};

async function callGeminiWithRetry(fn: () => Promise<any>, retries = 5, delay = 5000): Promise<any> {
    try {
        return await fn();
    } catch (error: any) {
        const errorText = error?.toString?.() || "";
        const causeText = error?.cause?.toString?.() || "";
        const fullText = `${errorText} ${causeText}`;

        const isRateLimit = fullText.includes("429") || fullText.includes("RESOURCE_EXHAUSTED");
        const isSocketError = fullText.includes("UND_ERR_SOCKET") || fullText.includes("fetch failed") || fullText.includes("ECONNRESET") || fullText.includes("ETIMEDOUT") || fullText.includes("SocketError");

        if ((isRateLimit || isSocketError) && retries > 0) {
            const jitter = Math.random() * 3000;
            const waitTime = delay + jitter;
            console.warn(`[TECHNOLOG 🏗️] Błąd sieci/limitu. Czekam ${Math.round(waitTime / 1000)}s... (Pozostało prób: ${retries})`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
            return callGeminiWithRetry(fn, retries - 1, delay * 2);
        }
        throw error;
    }
}

function buildScopeResearchContext(scopeResearchResults: any[]): string {
    if (!scopeResearchResults || scopeResearchResults.length === 0) {
        return "(SCOPE_RESEARCHER jeszcze nie był uruchomiony — uruchom go jako PIERWSZE zadanie gdy znasz typ obiektu)";
    }
    return scopeResearchResults.map((r: any, i: number) => `
--- Badanie zakresu #${i + 1} ---
Podsumowanie szukania: ${r.searchSummary || "brak"}
Źródła znalezione: ${(r.sourcesFound || []).join(", ") || "brak"}
Typowe działy dla tego obiektu:
${(r.typicalScopeForObjectType || []).map((d: any) =>
        `  • ${d.division} [${d.isMandatory ? "OBOWIĄZKOWY" : "opcjonalny"}]${d.isLikelyMissingInProject ? " ⚠️ BRAKUJE W PROJEKCIE — " + (d.missingReason || "") : ""}`
    ).join("\n")}
Krytyczne luki (impactScore > 5):
${(r.criticalGaps || [])
            .filter((g: any) => g.impactScore > 5)
            .map((g: any) => `  🔴 ${g.gapName} [impact: ${g.impactScore}/10, ~${g.estimatedCostShare} wartości inwestycji] — ${g.recommendation}`)
            .join("\n") || "  (brak krytycznych luk)"}
Pewność analizy: ${r.confidence || 0}%`
    ).join("\n\n");
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

        // Sprawdź aktywne zadania z timeout detection
        const activeTasksSnap = await tasksRef.where("status", "in", ["PENDING", "IN_PROGRESS"]).get();
        const now = Date.now();
        const TIMEOUT_MS = 10 * 60 * 1000;
        const lockBatch = adminDb.batch();
        let trulyActiveCount = 0;

        activeTasksSnap.docs.forEach(doc => {
            const data = doc.data();
            const lastActive = data.updatedAt?.toMillis?.() || data.createdAt?.toMillis?.() || now;
            if (now - lastActive >= TIMEOUT_MS) {
                console.log(`[TECHNOLOG 🏗️] Timeout zadania: ${doc.id}`);
                lockBatch.set(doc.ref, {
                    status: "ERROR",
                    rawResult: { error: "TIMEOUT_EXCEEDED" },
                    processedByTechnolog: false,
                    updatedAt: new Date()
                }, { merge: true });
            } else {
                trulyActiveCount++;
            }
        });

        if (trulyActiveCount > 0) {
            await lockBatch.commit();
            console.log(`[TECHNOLOG 🏗️] Agenci pracują (${trulyActiveCount} aktywnych). Czekam...`);
            return NextResponse.json({ message: "Agenci Technologa pracują..." });
        }
        await lockBatch.commit();

        // Pobierz wszystkie dane równolegle
        const [
            docsSnap,
            techSnap,
            unprocessedTasksSnap,
            allTasksSnap,
            pesamBrainSnap,
            existingFindingsSnap,
            estimateSectionsSnap
        ] = await Promise.all([
            adminDb.collection(`tenders/${tenderId}/documents`).get(),
            techRef.get(),
            tasksRef.where("status", "in", ["DONE", "ERROR"]).where("processedByTechnolog", "==", false).get(),
            tasksRef.get(),
            adminDb.collection(`tenders/${tenderId}/brain`).doc("main").get(),
            adminDb.collection(`tenders/${tenderId}/technologistFindings`).get(),
            adminDb.collection(`tenders/${tenderId}/estimate`).get()
        ]);

        // 🟢 UWZGLĘDNIENIE SPISÓW DZIAŁÓW Z DOKUMENTÓW (constructionDivisions)
        const documents = docsSnap.docs.map(d => ({
            id: d.id,
            fileName: d.data().fileName,
            tags: d.data().tags || [],
            summary: d.data().summary || "(brak)",
            detailedElement: d.data().detailedElement || "NIE_DOTYCZY",
            containsDrawings: d.data().containsDrawings || false,
            containsTablesWithDimensions: d.data().containsTablesWithDimensions || false,
            pageCount: d.data().pageCount || null,
            constructionDivisions: d.data().constructionDivisions || [] // 🟢 Pobrane wprost z bazy
        }));

        const currentTechData = techSnap.exists ? techSnap.data() : {};
        const currentTechState = currentTechData?.technologicalState || {
            objectProfile: {},
            confirmedMaterials: [],
            derivedParameters: [],
            quantityIndicators: [],
            technologicalConflicts: [],
            technologicalGaps: [],
            scopeResearchDone: false,
            identifiedMissingScopes: [],
            scopeResearchResults: []
        };

        const pesamKnownFacts = pesamBrainSnap.exists
            ? (pesamBrainSnap.data()?.cognitiveState?.knownFacts || {})
            : {};

        const pesamWorldModel = pesamBrainSnap.exists
            ? (pesamBrainSnap.data()?.cognitiveState?.worldModel || [])
            : [];

        const newlyFinishedResults = unprocessedTasksSnap.docs.map(d => ({
            taskId: d.id,
            agentType: d.data().agentType,
            status: d.data().status,
            instruction: d.data().instruction,
            rawResult: d.data().rawResult
        }));

        const taskHistory = allTasksSnap.docs.map(d => ({
            agentType: d.data().agentType,
            status: d.data().status,
            resultSummary: d.data().status === "DONE"
                ? (d.data().rawResult?.summary || "Wykonano")
                : (d.data().rawResult?.error || "BŁĄD")
        }));

        const existingFindings = existingFindingsSnap.docs.map(d => ({
            findingId: d.id,
            category: d.data().category,
            confidence: d.data().confidence,
            facts: d.data().facts
        }));

        // Aktualny stan kosztorysu — co już wyciągnął Mózg
        const currentEstimateSummary = estimateSectionsSnap.docs.map(d => ({
            sekcja: d.data().section,
            liczba_pozycji: d.data().items?.length || 0
        }));

        // Zbierz wyniki SCOPE_RESEARCHER z nowych zadań i akumuluj
        const newScopeResults = newlyFinishedResults
            .filter(t => t.agentType === "SCOPE_RESEARCHER" && t.status === "DONE")
            .map(t => t.rawResult);

        const allScopeResearchResults = [
            ...(currentTechState.scopeResearchResults || []),
            ...newScopeResults
        ];

        const scopeResearcherDoneSuccessfully = taskHistory.some(
            t => t.agentType === "SCOPE_RESEARCHER" && t.status === "DONE"
        );

        const systemPrompt = `Jesteś Technologiem Budowlanym — autonomicznym ekspertem technicznym w systemie PESAM 3.0.

=== TWOJA ROLA I MISJA ===
Twoja JEDYNA odpowiedzialność: KOMPLETNOŚĆ kosztorysu.
NIE tylko analizujesz to, co jest w dokumentach.
AKTYWNIE identyfikujesz CO BRAKUJE w stosunku do typowego, pełnego zakresu dla tego typu inwestycji.

Mózg PESAM (Kosztorysant) czeka na Twoje findings, by uzupełnić luki w kosztorysie.
Bez Ciebie kosztorys będzie niepełny i wartościowo zaniżony.

=== DOSTĘPNE NARZĘDZIA (agenci Technologa) ===
${JSON.stringify(TECHNOLOG_AGENTS.map(a => ({ name: a.name, opis: a.description })), null, 2)}

=== DOKUMENTY PROJEKTU (ZAWIERAJĄ SPIS DZIAŁÓW Z PDF) ===
${JSON.stringify(documents.map(d => ({ fileName: d.fileName, constructionDivisions: d.constructionDivisions })), null, 2)}

=== CO JUŻ WIE KOSZTORYSANT (Mózg PESAM — knownFacts) ===
${JSON.stringify(pesamKnownFacts, null, 2)}

=== MODEL ŚWIATA PESAM (worldModel) ===
${JSON.stringify(pesamWorldModel, null, 2)}

=== AKTUALNY STAN KOSZTORYSU (co już wyciągnął Mózg) ===
${currentEstimateSummary.length > 0
                ? JSON.stringify(currentEstimateSummary, null, 2)
                : "⚠️ Kosztorys jeszcze pusty — to wczesna faza."}

=== TWÓJ AKTUALNY STAN TECHNOLOGICZNY ===
${JSON.stringify(currentTechState, null, 2)}

=== WYNIKI BADANIA ZAKRESU (SCOPE_RESEARCHER) ===
${buildScopeResearchContext(allScopeResearchResults)}

=== NOWE WYNIKI AGENTÓW (do przetworzenia) ===
${newlyFinishedResults.length > 0
                ? JSON.stringify(newlyFinishedResults, null, 2)
                : "(brak nowych wyników)"}

=== HISTORIA WSZYSTKICH ZADAŃ ===
${JSON.stringify(taskHistory, null, 2)}

=== FAKTY JUŻ PRZEKAZANE DO PESAM (nie duplikuj!) ===
${existingFindings.length > 0
                ? JSON.stringify(existingFindings, null, 2)
                : "(brak — nic jeszcze nie przekazano)"}

=== TWOJA STRATEGIA (FOLLOW THIS STRICTLY) ===

**KROK 1 — SCOPE RESEARCH (PRIORYTET ABSOLUTNY)**
- Czy SCOPE_RESEARCHER był już uruchomiony i zwrócił wyniki? ${scopeResearcherDoneSuccessfully ? "✅ TAK" : "❌ NIE"}
- Jeśli NIE → Stwórz NATYCHMIAST zadanie dla SCOPE_RESEARCHER.
  * W inputFacts podaj: objectType (np. "przedszkole publiczne 4-oddziałowe"), objectDescription (z SWZ/dokumentów), confirmedScopes (sekcje które widzisz w kosztorysie lub dokumentach)
  * Instruction powinna brzmieć: "Wyszukaj w internecie przykładowe kosztorysy inwestorskie dla [typ obiektu]. Porównaj typowy zakres z tym co mamy: [lista tego co jest]. Podaj brakujące działy z impactScore."
- NIE twórz innych zadań w tej samej iteracji gdy SCOPE_RESEARCHER jeszcze nie zwrócił wyników.

**KROK 2 — ANALIZA LUK (ELIMINACJA FAŁSZYWYCH ALARMÓW)**
- Przejrzyj criticalGaps od SCOPE_RESEARCHER.
- 🛑 ZASADA KRYTYCZNA: Zanim uznasz jakikolwiek dział (np. instalacje sanitarne, wentylację) za brakujący, sprawdź absolutnie sekcję "DOKUMENTY PROJEKTU". Jeśli nazwa tego lub podobnego działu znajduje się w "constructionDivisions" któregokolwiek dokumentu (np. w spisie przedmiaru), OZNACZA TO, ŻE ZAKRES TEN ISTNIEJE w dokumentacji projektowej i Kosztorysant go wkrótce wczyta. W takim wypadku ABSOLUTNIE NIE ZGŁASZAJ GO jako MISSING_SCOPE.
- Zgłoś jako MISSING_SCOPE WYŁĄCZNIE te działy, których nie ma ani w obecnym Kosztorysie, ani w spisach "constructionDivisions" w plikach PDF. Dla każdej potwierdzonej luki z impactScore > 6 stwórz finding (category: "MISSING_SCOPE").
- Sprawdź existingFindings — nie duplikuj tych które już wysłałeś.

**KROK 3 — SPECYFIKACJE MATERIAŁÓW (równolegle po kroku 2)**
- Jeśli masz dokumenty z rysunkami lub opisem technicznym → MATERIAL_DETECTIVE.
- Jeśli brakuje parametrów normowych (U-wartości, klasy ognioodporności, klasy betonu) → NORM_ADVISOR z googleSearch.

**KROK 4 — ILOŚCI WSKAŹNIKOWE (po kroku 3)**
- Gdy masz materiały ale brak przedmiaru → QUANTITY_ESTIMATOR.
- Agent porówna obecny kosztorys z wymaganiami i wskaże brakujące procesy (izolacje, rusztowania, wywiezienie ziemi).

**KROK 5 — SYNTEZA I PAKOWANIE DLA PESAM**
- Gdy masz pełny obraz: materiały + parametry + luki zakresu → zapakuj jako findingsForPESAM.
- Ustaw scopeResearchDone=true gdy SCOPE_RESEARCHER skończył.
- Zaktualizuj identifiedMissingScopes z sentToPESAM=true dla przekazanych działów.
- Ustaw phase="DONE" gdy wszystkie luki są przekazane.

=== ZASADA ANTY-DUPLIKACJI ===
Przed dodaniem nowego finding sprawdź czy findingId już istnieje w "FAKTY JUŻ PRZEKAZANE DO PESAM".
Jeśli tak — nie dodawaj go ponownie. Zamiast tego zaktualizuj istniejący jeśli masz nowe dane.

=== FORMATY FINDINGS DLA PESAM ===

Dla MISSING_SCOPE:
{
  findingId: "missing_[nazwa_dzialu_snake_case]",
  category: "MISSING_SCOPE",
  facts: {
    divisionName: "Instalacje elektryczne wewnętrzne",
    typicalItems: ["Rozdzielnica główna RG", "Instalacja oświetlenia", "Gniazda wtykowe 230V", "WLZ z rozdzielni"],
    estimatedCostShare: "8-12% wartości inwestycji",
    whyMissing: "W dokumentach brak projektu elektrycznego, nie ma go również w spisie treści przedmiaru. SCOPE_RESEARCHER znalazł w 3 podobnych przetargach że instalacje elektryczne to obowiązkowy dział."
  },
  confidence: 85,
  normBasis: "Warunki techniczne dla budynków użyteczności publicznej"
}

Dla MATERIAL_SPEC:
{
  findingId: "material_[element]_[parametr]",
  category: "MATERIAL_SPEC",
  facts: { element: "Ściany zewnętrzne", material: "Pustak ceramiczny", specification: "Porotherm 25 P+W", normBasis: "WT2021 §321 U≤0.20 W/m²K" },
  confidence: 90
}

Dla COST_INDICATOR:
{
  findingId: "cost_[zakres]",
  category: "COST_INDICATOR",
  facts: { scope: "Instalacja wentylacji mechanicznej", unitCost: "150-200 zł/m2 PU", unit: "m2 powierzchni użytkowej", source: "SEKOCENBUD 2024 Q4" },
  confidence: 70
}`;

        console.log(`[TECHNOLOG 🏗️] Wywołuję model. ScopeResearched: ${scopeResearcherDoneSuccessfully}`);

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

        let parsed: any = {};
        try {
            parsed = JSON.parse(jsonrepair(result.text ?? "{}"));
        } catch (e) {
            console.error("[TECHNOLOG 🏗️] Błąd parsowania JSON:", e);
            throw new Error("Błąd parsowania odpowiedzi modelu");
        }

        console.log(`[TECHNOLOG 🏗️] Faza: ${parsed.phase} | Next: ${parsed.nextBestAction}`);

        const batch = adminDb.batch();

        // Oznacz przetworzone zadania
        unprocessedTasksSnap.docs.forEach(doc =>
            batch.set(doc.ref, { processedByTechnolog: true }, { merge: true })
        );

        // Zapisz stan Technologa z akumulacją scopeResearchResults
        batch.set(techRef, {
            phase: parsed.phase,
            currentGoal: parsed.currentGoal,
            technologicalState: {
                ...parsed.technologicalState,
                scopeResearchResults: allScopeResearchResults // Akumuluj — nie nadpisuj!
            },
            reasoning: parsed.reasoning,
            selfCritique: parsed.selfCritique,
            nextBestAction: parsed.nextBestAction,
            updatedAt: new Date()
        }, { merge: true });

        // Zapisz findings dla PESAM (merge: true żeby nie nadpisywać istniejących)
        let findingsSentCount = 0;
        if (parsed.findingsForPESAM?.length > 0) {
            parsed.findingsForPESAM.forEach((finding: any) => {
                if (!finding.findingId) {
                    finding.findingId = `finding_${randomUUID().slice(0, 8)}`;
                }
                // Sprawdź czy już istnieje
                const alreadyExists = existingFindings.some(f => f.findingId === finding.findingId);
                if (!alreadyExists) {
                    const findingRef = adminDb
                        .collection(`tenders/${tenderId}/technologistFindings`)
                        .doc(finding.findingId);
                    batch.set(findingRef, {
                        ...finding,
                        createdAt: new Date(),
                        updatedAt: new Date(),
                        source: "TECHNOLOG"
                    }, { merge: true });
                    findingsSentCount++;
                    console.log(`[TECHNOLOG 🏗️] Finding: [${finding.category}] ${finding.findingId}`);
                }
            });

            if (findingsSentCount > 0) {
                batch.set(tenderRef, {
                    hasNewTechnologistFindings: true,
                    lastTechnologistUpdate: new Date()
                }, { merge: true });
            }
        }

        // Stwórz nowe zadania dla agentów
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
            console.log(`[TECHNOLOG 🏗️] Nowe zadanie: ${task.agentType} — ${task.instruction.substring(0, 60)}...`);
        });

        // Koszt tokenów
        const totalTokens = result.usageMetadata?.totalTokenCount || 0;
        const costUSD = (totalTokens / 1000) * 0.000015;
        batch.set(tenderRef, {
            "budgetGuard.currentCostUSD": FieldValue.increment(costUSD),
            updatedAt: new Date()
        }, { merge: true });

        await batch.commit();
        console.log(`[TECHNOLOG 🏗️] Batch zapisany. Zadań: ${newTasksCreated.length}, Findings: ${findingsSentCount}`);

        const localOrigin = `http://localhost:${process.env.PORT || "3000"}`;

        // Uruchom agentów z pacingiem i jitterem — kluczowe dla unikania 429
        const triggerAgentsWithPacing = async () => {
            for (let i = 0; i < newTasksCreated.length; i++) {
                const task = newTasksCreated[i];
                const agentDef = TECHNOLOG_AGENTS.find(a => a.name === task.agentType);
                if (agentDef?.endpoint) {
                    if (i > 0) {
                        const pause = 4000 + Math.random() * 3000; // Jitter 4-7s między agentami
                        console.log(`[TECHNOLOG 🏗️] Pauza ${Math.round(pause / 1000)}s przed ${task.agentType}...`);
                        await new Promise(r => setTimeout(r, pause));
                    }
                    await fetch(`${localOrigin}${agentDef.endpoint}`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ tenderId, taskId: task.taskId })
                    }).catch(err => console.error(`[TECHNOLOG 🏗️] Błąd uruchamiania ${task.agentType}:`, err.message));
                } else {
                    console.warn(`[TECHNOLOG 🏗️] Agent ${task.agentType} nie ma endpointu w rejestrze!`);
                }
            }
        };

        await triggerAgentsWithPacing();

        // Powiadom Mózg PESAM jeśli są nowe findings
        if (findingsSentCount > 0) {
            console.log(`[TECHNOLOG 🏗️] Powiadamiam Mózg PESAM o ${findingsSentCount} nowych findings...`);
            await fetch(`${localOrigin}/api/kosztorysant/glowny-kosztorysant`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ tenderId, trigger: "TECHNOLOGIST_NEW_FINDINGS" })
            }).catch(err => console.error("[TECHNOLOG 🏗️] Błąd powiadamiania PESAM:", err.message));
        }

        return NextResponse.json({
            success: true,
            phase: parsed.phase,
            tasksCreated: newTasksCreated.length,
            findingsSent: findingsSentCount,
            scopeResearchDone: parsed.technologicalState?.scopeResearchDone || false
        });

    } catch (error: any) {
        console.error("[TECHNOLOG 🏗️] Krytyczny błąd:", error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}