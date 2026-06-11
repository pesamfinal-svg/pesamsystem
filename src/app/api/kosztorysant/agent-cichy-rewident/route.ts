import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { FieldValue } from "firebase-admin/firestore";
import { GoogleGenAI, Type } from "@google/genai";

export const dynamic = "force-dynamic";

const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
    location: "global"
});

const MODEL_FLASH = "gemini-2.5-flash"; // Model Flash świetnie radzi sobie z szybkim audytem rynkowym

// Schemat ustrukturyzowanego wyjścia z audytu
const AUDITOR_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        missingItems: {
            type: Type.ARRAY,
            description: "Lista brakujących elementów technologicznych, prawnych, BHP lub sanitarnych.",
            items: {
                type: Type.OBJECT,
                properties: {
                    pozycja: { type: Type.STRING, description: "Nazwa brakującego elementu, np. 'Drzwi ppoż EI60', 'Separator tłuszczu'" },
                    opis: { type: Type.STRING, description: "Szczegółowe uzasadnienie technologiczne lub prawne (np. wymóg WT 2021, PPOŻ, Sanepid)" },
                    ilosc: { type: Type.NUMBER, description: "Szacowana ilość (liczba)" },
                    jednostka: { type: Type.STRING, description: "Jednostka miary, np. szt, kpl, m" },
                    KNR_ref: { type: Type.STRING, description: "Zawsze wpisz 'TECH_REQUIRED'" }
                },
                required: ["pozycja", "opis", "ilosc", "jednostka", "KNR_ref"]
            }
        },
        summary: { type: Type.STRING, description: "Krótkie podsumowanie wykonanego audytu technicznego." }
    },
    required: ["missingItems", "summary"]
};

export async function POST(req: Request) {
    let tenderId: string | undefined;
    let taskId: string | undefined;
    let isSuccess = false;

    try {
        const body = await req.json();
        tenderId = body.tenderId;
        taskId = body.taskId;

        console.log(`[SILENT AUDITOR 🕵️] Otrzymano żądanie POST. tenderId: ${tenderId}, taskId: ${taskId}`);

        if (!tenderId || !taskId) {
            console.error("[SILENT AUDITOR 🕵️] Błąd: Brak wymaganych parametrów tenderId lub taskId.");
            return NextResponse.json({ error: "Brak danych" }, { status: 400 });
        }

        const taskRef = adminDb.collection(`tenders/${tenderId}/tasks`).doc(taskId);
        const taskDoc = await taskRef.get();

        if (!taskDoc.exists) {
            console.error(`[SILENT AUDITOR 🕵️] Zadanie o ID ${taskId} nie istnieje w bazie.`);
            throw new Error("Zadanie nie istnieje.");
        }

        const taskData = taskDoc.data()!;
        console.log(`[SILENT AUDITOR 🕵️] Wczytano zadanie. Status w bazie: ${taskData.status}`);

        if (taskData.status !== "PENDING") {
            console.log(`[SILENT AUDITOR 🕵️] Zadanie ma status ${taskData.status}. Pomijam.`);
            return NextResponse.json({ message: "Task processed." });
        }

        // Zmiana statusu na IN_PROGRESS
        console.log("[SILENT AUDITOR 🕵️] Zmieniam status zadania na IN_PROGRESS.");
        await taskRef.update({ status: "IN_PROGRESS", updatedAt: new Date() });

        // Pobieramy informacje kontekstowe przekazane przez Mózg
        const existingItems = taskData.inputFacts?.existingItems || [];
        const objectType = taskData.inputFacts?.objectType || "Obiekt budowlany";

        console.log(`[SILENT AUDITOR 🕵️] Projekt dotyczy obiektu typu: ${objectType}. Liczba dotychczasowych pozycji w kosztorysie: ${existingItems.length}`);

        // Kompilujemy prompt z wyszukiwarką
        const prompt = `
Jesteś Głównym Inspektorem Nadzoru i Audytorem Technologicznym w Polsce.
Analizujemy kosztorys dla obiektu typu: ${objectType}.
Obecnie w kosztorysie mamy m.in. następujące pozycje: 
${JSON.stringify(existingItems.slice(0, 50))}

Twoje polecenie od Mózgu:
${taskData.instruction}

Zasady audytu:
1. Użyj wyszukiwarki Google Search, aby sprawdzić aktualne, restrykcyjne przepisy budowlane w Polsce (Warunki Techniczne WT 2021, wymogi PPOŻ dla tej kategorii budynków, wymogi Sanepidu).
2. Zidentyfikuj, czy w dotychczasowym kosztorysie nie zapomniano o krytycznych, obowiązkowych elementach (np. instalacja odgromowa, separatory, drzwi pożarowe, klapy dymowe, zabezpieczenia BHP).
3. Zwróć wykryte braki jako poprawny obiekt JSON, pasujący dokładnie do zdefiniowanego schematu.
4. Nie dodawaj żadnego innego tekstu poza czystym JSON-em.
`;

        console.log("[SILENT AUDITOR 🕵️] Wysyłam zapytanie do Gemini z włączonym Google Search Grounding...");

        const result = await ai.models.generateContent({
            model: taskData.modelOverride || MODEL_FLASH,
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            config: {
                tools: [{ googleSearch: {} }], // Grounding techniczny i prawny
                temperature: 0.1,
                responseMimeType: "application/json",
                responseSchema: AUDITOR_SCHEMA as any
            }
        });

        console.log("[SILENT AUDITOR 🕵️] Odebrano odpowiedź z Gemini. Parsuję JSON...");
        const parsedResult = JSON.parse(result.text ?? "{}");
        const tokensUsed = result.usageMetadata?.totalTokenCount || 0;
        console.log(`[SILENT AUDITOR 🕵️] Zużyto tokenów: ${tokensUsed}. Zapisuję rawResult w bazie.`);

        // Zapisujemy czysty JSON do rawResult i oznaczamy zadanie jako DONE
        await taskRef.update({
            status: "DONE",
            rawResult: parsedResult,
            processedByBrain: false,
            costTokens: tokensUsed,
            updatedAt: new Date()
        });

        // Koszt tokenów (Flash: ~$0.000015 / 1k, Pro: ~$0.002 / 1k)
        const costPerThousand = (taskData.modelOverride === "gemini-2.5-pro") ? 0.002 : 0.000015;
        const costUSD = (tokensUsed / 1000) * costPerThousand;

        console.log(`[SILENT AUDITOR 🕵️] Koszt tokenów: ${costUSD.toFixed(6)} USD. Aktualizuję Budget Guard.`);
        await adminDb.collection("tenders").doc(tenderId).update({
            "budgetGuard.currentCostUSD": FieldValue.increment(costUSD)
        });

        isSuccess = true;
        console.log("[SILENT AUDITOR 🕵️] Audyt zakończony pomyślnie.");
        return NextResponse.json({ success: true });

    } catch (error: any) {
        console.error("[SILENT AUDITOR 🕵️] ❌ Błąd krytyczny w audytorze:", error);
        if (tenderId && taskId) {
            console.log("[SILENT AUDITOR 🕵️] Zapisuję status błędu (ERROR) do bazy.");
            await adminDb.collection(`tenders/${tenderId}/tasks`).doc(taskId).update({
                status: "ERROR",
                rawResult: { error: error.message },
                processedByBrain: false,
                updatedAt: new Date()
            }).catch((dbErr) => console.error("[SILENT AUDITOR 🕵️] Błąd zapisu błędu do Firestore:", dbErr));
        }
        return NextResponse.json({ error: error.message }, { status: 500 });

    } finally {
        // Gwarancja wybudzenia Mózgu
        if (tenderId && taskId) {
            const localOrigin = `http://127.0.0.1:${process.env.PORT || "3000"}`;
            console.log(`[SILENT AUDITOR 🕵️] Wybudzam Mózg przez loopback: ${localOrigin}`);
            fetch(`${localOrigin}/api/kosztorysant/glowny-kosztorysant`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    tenderId,
                    trigger: isSuccess ? `TASK_COMPLETED_${taskId}` : `TASK_FAILED_${taskId}`
                })
            }).catch((fetchErr) => console.error("[SILENT AUDITOR 🕵️] Błąd wybudzania Mózgu przez fetch:", fetchErr));
        }
    }
}