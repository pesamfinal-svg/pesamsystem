import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { getFileUrl } from "../../../../../lib/storage";
import { DocumentationAssessment } from "../../agent-klasyfikator/route"; // Importujemy typy

export const dynamic = "force-dynamic";

// Budowanie bezpiecznego URL dla wywołań wewnętrznych
function internalUrl(req: NextRequest, path: string): string {
    const url = new URL(req.url);
    if (url.hostname === "0.0.0.0" || url.hostname === "127.0.0.1" || url.hostname === "localhost") {
        url.protocol = "http:";
    }
    return `${url.origin}${path}`;
}

interface TaskTemplate {
    agentType: string;
    description: string;
    categoryFilter: string | null;
    taskKeywords: string[];
}

// ── LOGIKA DOBORU ZADAŃ WG STRATEGII ─────────────────────────────────────────

function buildTasksByStrategy(assessment: DocumentationAssessment): TaskTemplate[] {
    const tasks: TaskTemplate[] = [];

    // ZAWSZE dodajemy analizę prawną (LEGAL)
    tasks.push({
        agentType: "LEGAL",
        description: "Przeanalizuj SWZ/PFU pod kątem kar, terminów i ryzyk kontraktowych.",
        categoryFilter: "SWZ",
        taskKeywords: ["kara", "gwarancja", "termin", "płatność"],
    });

    switch (assessment.estimationMethod) {
        case "PARAMETRIC":
            console.log("[Inicjalizator] Wybrano strategię: PARAMETRYCZNĄ (Brak rysunków)");
            tasks.push({
                agentType: "PARAMETRIC_ESTIMATE",
                description: `Brak rysunków. Wykonaj wycenę wskaźnikową PLN/m2 na podstawie opisu: ${assessment.executiveSummary}`,
                categoryFilter: null,
                taskKeywords: ["powierzchnia", "standard", "wskaźnik"],
            });
            break;

        case "ANALOGICAL":
            console.log("[Inicjalizator] Wybrano strategię: ANALOGICZNĄ (PFU)");
            tasks.push({
                agentType: "ANALOGICAL_ESTIMATE",
                description: "Wycena przez analogię na podstawie PFU. Rozbij koszt na główne stany budowy.",
                categoryFilter: "SWZ",
                taskKeywords: ["kubatura", "program funkcjonalny", "standard"],
            });
            break;

        case "ELEMENT_BASED":
            console.log("[Inicjalizator] Wybrano strategię: ELEMENTOWĄ (Projekt Budowlany)");
            tasks.push({
                agentType: "VISION",
                description: "Odczytaj geometrię z rzutów i przekrojów Projektu Budowlanego.",
                categoryFilter: "DRAWING",
                taskKeywords: ["rzut", "przekrój", "fundamenty"],
            });
            tasks.push({
                agentType: "QUANTITY",
                description: "Zbuduj strukturę kosztorysu KNR na podstawie dostępnych rzutów.",
                categoryFilter: "ESTIMATE",
                taskKeywords: ["przedmiar", "kosztorys"],
            });
            // Jeśli AI wykryło brak detali zbrojenia – dodajemy agenta od zgadywania stali!
            if (!assessment.availableData.hasReinforcementDetails) {
                console.log("[Inicjalizator] BRAK ZBROJENIA: Dodaję agenta NORMATIVE_STEEL.");
                tasks.push({
                    agentType: "NORMATIVE_STEEL",
                    description: "Oszacuj zużycie stali zbrojeniowej na podstawie wskaźników normatywnych dla m3 betonu.",
                    categoryFilter: "DRAWING",
                    taskKeywords: ["zbrojenie", "stal", "pręt"],
                });
            }
            break;

        case "DETAILED_KNR":
            console.log("[Inicjalizator] Wybrano strategię: SZCZEGÓŁOWĄ (Projekt Wykonawczy)");
            tasks.push({ agentType: "VISION", description: "Pełna analiza rysunków wykonawczych.", categoryFilter: "DRAWING", taskKeywords: ["zbrojenie", "detal"] });
            tasks.push({ agentType: "QUANTITY", description: "Szczegółowy przedmiar KNR.", categoryFilter: "ESTIMATE", taskKeywords: ["kosztorys"] });
            break;
    }

    // Na końcu każdej strategii (oprócz czysto wskaźnikowej) dodajemy Brokera i Rewidenta
    if (assessment.estimationMethod !== "PARAMETRIC") {
        tasks.push({ agentType: "PRICING", description: "Weryfikacja cen rynkowych.", categoryFilter: null, taskKeywords: [] });
        tasks.push({ agentType: "AUDIT", description: "Audyt końcowy kosztorysu.", categoryFilter: null, taskKeywords: [] });
    }

    return tasks;
}

// ── GŁÓWNY HANDLER ────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
    console.log("==================================================");
    console.log("[Inicjalizator] === ROZPOCZĘTO PROCES INTELIGENTNY ===");
    console.log("==================================================");

    try {
        const { tenderId } = await req.json();
        if (!tenderId) return NextResponse.json({ error: "Brak tenderId." }, { status: 400 });

        // 1. Pobieramy pliki z bazy
        console.log(`[Inicjalizator] Pobieram pliki dla przetargu: ${tenderId}...`);
        const filesSnap = await adminDb.collection("tenders").doc(tenderId).collection("files").get();
        const filesList = filesSnap.docs.map(doc => doc.data());

        if (filesList.length === 0) {
            console.error("[Inicjalizator] Błąd: Brak plików w bazie.");
            return NextResponse.json({ error: "Brak plików." }, { status: 422 });
        }

        // 2. WYWOŁANIE KLASYFIKATORA (KROK 1)
        console.log("[Inicjalizator] Wywołuję Agenta Klasyfikatora...");
        const classifyRes = await fetch(internalUrl(req, "/api/kosztorysant/agent-klasyfikator"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ filesList, projectName: tenderId })
        });

        if (!classifyRes.ok) throw new Error("Błąd podczas klasyfikacji dokumentacji.");
        const assessment: DocumentationAssessment = await classifyRes.json();

        // 3. Zapisujemy wynik klasyfikacji w głównym dokumencie przetargu
        console.log(`[Inicjalizator] Zapisuję ocenę dokumentacji (Level: ${assessment.docLevel}) w Firestore...`);
        await adminDb.collection("tenders").doc(tenderId).update({
            docLevel: assessment.docLevel,
            estimationMethod: assessment.estimationMethod,
            uncertaintyPercent: assessment.uncertaintyPercent,
            missingDataReport: assessment.missingData,
            status: "CALCULATING",
            updatedAt: new Date().toISOString()
        });

        // 4. GENEROWANIE ZADAŃ WG STRATEGII
        const tasksToCreate = buildTasksByStrategy(assessment);
        let tasksCreatedCount = 0;

        for (const template of tasksToCreate) {
            console.log(`[Inicjalizator] Tworzę zadanie: ${template.agentType}...`);

            let fileUrls: string[] = [];
            if (template.categoryFilter) {
                const matchingFiles = filesList.filter(f => f.category === template.categoryFilter);
                const finalFiles = matchingFiles.length > 0 ? matchingFiles : filesList.filter(f => f.type === "application/pdf").slice(0, 1);

                if (finalFiles.length > 0) {
                    fileUrls = await Promise.all(finalFiles.map(f => getFileUrl(f.storagePath)));
                }
            }

            const taskId = `task-${Math.random().toString(36).slice(2, 9)}`;
            await adminDb.collection("tenders").doc(tenderId).collection("tasks").doc(taskId).set({
                id: taskId,
                agentType: template.agentType,
                description: template.description,
                inputFiles: fileUrls,
                taskKeywords: template.taskKeywords,
                status: "PENDING",
                result: null,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            });
            tasksCreatedCount++;
        }

        console.log(`[Inicjalizator] Sukces. Stworzono ${tasksCreatedCount} zadań wg strategii ${assessment.estimationMethod}.`);
        console.log("==================================================");

        return NextResponse.json({ success: true, estimationMethod: assessment.estimationMethod, tasksCreated: tasksCreatedCount }, { status: 200 });

    } catch (error: any) {
        console.error("[Inicjalizator] KRYTYCZNY BŁĄD:", error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}