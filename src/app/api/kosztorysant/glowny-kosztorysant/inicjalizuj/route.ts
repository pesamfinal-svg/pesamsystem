// src/app/api/kosztorysant/glowny-kosztorysant/inicjalizuj/route.ts
import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";

export const dynamic = "force-dynamic";

interface TaskTemplate {
    agentType: "LEGAL" | "QUANTITY" | "CONSTRUCTION" | "PRICING";
    description: string;
    categoryFilter: "SWZ" | "ESTIMATE" | "DRAWING" | "CONTRACT";
}

// Szablony zadań, które Główny Kosztorysant przydzieli do Roju
const DEFAULT_TASKS: TaskTemplate[] = [
    {
        agentType: "LEGAL",
        description: "Przeanalizuj umowę i specyfikację pod kątem kar umownych, terminów płatności, okresu gwarancji i zabezpieczenia należytego wykonania.",
        categoryFilter: "SWZ",
    },
    {
        agentType: "QUANTITY",
        description: "Wyciągnij z przedmiaru lub specyfikacji główne, scalone pozycje robót wraz z ilościami i jednostkami miary.",
        categoryFilter: "ESTIMATE",
    },
    {
        agentType: "CONSTRUCTION",
        description: "Porównaj rzuty konstrukcyjne z przedmiarem ślepym. Sprawdź poprawność grubości warstw, ilości betonu i ton stali zbrojeniowej.",
        categoryFilter: "DRAWING",
    }
];

export async function POST(req: NextRequest) {
    console.log("==================================================");
    console.log("[Główny Kosztorysant / Inicjalizator] === ROZPOCZĘTO INICJALIZACJĘ PRZETARGU ===");
    console.log("==================================================");

    try {
        const { tenderId } = await req.json();

        if (!tenderId) {
            console.error("[Inicjalizator] Błąd: Brak tenderId w żądaniu.");
            return NextResponse.json({ error: "Brak identyfikatora przetargu (tenderId)." }, { status: 400 });
        }

        console.log(`[Inicjalizator] Przetwarzam projekt o ID: ${tenderId}...`);

        // 1. Pobieramy listę plików z bazy, aby wiedzieć, czym dysponujemy
        const filesSnap = await adminDb.collection("tenders").doc(tenderId).collection("files").get();
        const filesList = filesSnap.docs.map(doc => doc.data());

        console.log(`[Inicjalizator] Znaleziono ${filesList.length} plików zaindeksowanych dla tego przetargu.`);

        if (filesList.length === 0) {
            console.warn("[Inicjalizator] Ostrzeżenie: Brak plików. Nie mogę utworzyć zadań rzetelnie.");
            return NextResponse.json({ error: "Brak powiązanych plików. Najpierw wgraj paczkę ZIP." }, { status: 422 });
        }

        // Zmieniamy status przetargu na "CALCULATING" (W trakcie analizy)
        await adminDb.collection("tenders").doc(tenderId).update({
            status: "CALCULATING",
            updatedAt: new Date().toISOString()
        });

        console.log("[Inicjalizator] Status przetargu zmieniony na CALCULATING.");

        let tasksCreatedCount = 0;

        // 2. Mapujemy i tworzymy zadania w Firestore na podstawie szablonów i pasujących plików
        for (const template of DEFAULT_TASKS) {
            // Szukamy plików pasujących do danej kategorii (SWZ dla prawa, ESTIMATE dla przedmiaru, itp.)
            const matchingFiles = filesList.filter(f => f.category === template.categoryFilter);

            // Jeśli nie ma pliku o danej kategorii, bierzemy pierwszy lepszy dokument typu PDF lub bierzemy ogólną listę
            const finalFiles = matchingFiles.length > 0
                ? matchingFiles
                : filesList.filter(f => f.type === "application/pdf").slice(0, 1);

            if (finalFiles.length === 0) {
                console.warn(`[Inicjalizator] Pomijam zadanie ${template.agentType} - brak pasującego pliku.`);
                continue;
            }

            const taskId = `task-${Math.random().toString(36).slice(2, 9)}`;
            const fileUrls = finalFiles.map(f => f.storageUrl);

            // Zapisujemy nowe zadanie w podkolekcji "tasks" w Firestore
            await adminDb.collection("tenders").doc(tenderId).collection("tasks").doc(taskId).set({
                id: taskId,
                agentType: template.agentType,
                description: template.description,
                inputFiles: fileUrls, // Przekazujemy bezpośrednie, bezpieczne linki do Storage
                status: "PENDING",    // Oczekiwanie na podjęcie przez Agenta-Brygadzistę
                result: null,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            });

            console.log(`[Inicjalizator] Stworzono zadanie w Firestore: ${taskId} dla agenta ${template.agentType}`);
            tasksCreatedCount++;
        }

        console.log(`[Inicjalizator] Pomyślnie zainicjalizowano ${tasksCreatedCount} zadań dla roju PESAM.`);
        console.log("==================================================");

        return NextResponse.json({
            success: true,
            tenderId,
            tasksCreated: tasksCreatedCount
        }, { status: 200 });

    } catch (error: any) {
        console.error("[Inicjalizator] Krytyczny błąd podczas inicjalizacji bazy:", error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}