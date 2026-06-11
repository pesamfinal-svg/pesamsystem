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

const MODEL_FLASH = "gemini-2.5-flash";

// Schemat ustrukturyzowanego wyjścia dla szacunków wskaźnikowych
const GAP_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        estimatedItems: {
            type: Type.ARRAY,
            description: "Lista oszacowanych pozycji wskaźnikowych rynkowych.",
            items: {
                type: Type.OBJECT,
                properties: {
                    pozycja: { type: Type.STRING, description: "Nazwa brakującej branży lub elementu, np. 'Instalacja wentylacji mechanicznej'" },
                    opis: { type: Type.STRING, description: "Uzasadnienie rynkowe oszacowanego wskaźnika (np. średnia cena za m2 powierzchni użytkowej w Polsce)" },
                    ilosc: { type: Type.NUMBER, description: "Ilość wskaźnikowa (liczba)" },
                    jednostka: { type: Type.STRING, description: "Jednostka miary, np. m2, kpl, ryczałt" },
                    KNR_ref: { type: Type.STRING, description: "Zawsze wpisz 'WSKAŹNIK_RYNKOWY'" }
                },
                required: ["pozycja", "opis", "ilosc", "jednostka", "KNR_ref"]
            }
        },
        summary: { type: Type.STRING, description: "Krótkie podsumowanie wykonanych szacunków wskaźnikowych." }
    },
    required: ["estimatedItems", "summary"]
};

export async function POST(req: Request) {
    let tenderId: string | undefined;
    let taskId: string | undefined;
    let isSuccess = false;

    try {
        const body = await req.json();
        tenderId = body.tenderId;
        taskId = body.taskId;

        console.log(`[GAP FILLER 🧩] Otrzymano żądanie POST. tenderId: ${tenderId}, taskId: ${taskId}`);

        if (!tenderId || !taskId) {
            console.error("[GAP FILLER 🧩] Błąd: Brak wymaganych parametrów tenderId lub taskId.");
            return NextResponse.json({ error: "Brak danych" }, { status: 400 });
        }

        const taskRef = adminDb.collection(`tenders/${tenderId}/tasks`).doc(taskId);
        const taskDoc = await taskRef.get();

        if (!taskDoc.exists) {
            console.error(`[GAP FILLER 🧩] Zadanie o ID ${taskId} nie istnieje w bazie.`);
            throw new Error("Zadanie nie istnieje.");
        }

        const taskData = taskDoc.data()!;
        console.log(`[GAP FILLER 🧩] Wczytano zadanie. Status w bazie: ${taskData.status}`);

        if (taskData.status !== "PENDING") {
            console.log(`[GAP FILLER 🧩] Zadanie ma status ${taskData.status}. Przerywam.`);
            return NextResponse.json({ message: "Zadanie obsłużone." });
        }

        // Zmiana statusu na IN_PROGRESS
        console.log("[GAP FILLER 🧩] Zmieniam status zadania na IN_PROGRESS.");
        await taskRef.update({ status: "IN_PROGRESS", updatedAt: new Date() });

        // Pobieramy parametry przekazane przez Mózg
        const objectType = taskData.inputFacts?.objectType || "Obiekt budowlany";
        const missingScope = taskData.inputFacts?.missingScope || "Brakująca branża";

        console.log(`[GAP FILLER 🧩] Szacujemy parametrycznie branżę: "${missingScope}" dla obiektu typu: ${objectType}`);

        // Kompilujemy prompt z wyszukiwarką
        const prompt = `
Jesteś Ekspertem ds. Kosztorysowania Parametrycznego i Wskaźnikowego w Polsce.
Wyceniamy projekt budowy obiektu: ${objectType}.
W dokumentacji brakuje precyzyjnych rysunków lub danych dla zakresu: "${missingScope}".

Twoje polecenie od Mózgu:
${taskData.instruction}

Zasady wyceny wskaźnikowej:
1. Użyj wyszukiwarki Google Search, aby znaleźć aktualne (2025/2026 rok) wskaźniki cenowe Sekocenbud, GUS lub średnie rynkowe stawki wykonawcze w Polsce za m2, mb lub ryczałt dla zakresu: "${missingScope}".
2. Dokonaj rzetelnego, bezpiecznego inżynieryjnie oszacowania kosztu i ilości wskaźnikowych.
3. Zwróć wynik jako poprawny obiekt JSON, pasujący dokładnie do zdefiniowanego schematu.
4. Nie dodawaj żadnego innego tekstu poza czystym JSON-em.
`;

        console.log("[GAP FILLER 🧩] Wysyłam zapytanie do Gemini z włączonym Google Search Grounding...");

        const result = await ai.models.generateContent({
            model: taskData.modelOverride || MODEL_FLASH,
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            config: {
                tools: [{ googleSearch: {} }], // Szukamy wskaźników Sekocenbud / GUS w sieci
                temperature: 0.1,
                responseMimeType: "application/json",
                responseSchema: GAP_SCHEMA as any
            }
        });

        console.log("[GAP FILLER 🧩] Odebrano odpowiedź z Gemini. Parsuję JSON...");
        const parsedResult = JSON.parse(result.text ?? "{}");
        const tokensUsed = result.usageMetadata?.totalTokenCount || 0;
        console.log(`[GAP FILLER 🧩] Zużyto tokenów: ${tokensUsed}. Zapisuję rawResult w bazie.`);

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

        console.log(`[GAP FILLER 🧩] Koszt tokenów: ${costUSD.toFixed(6)} USD. Aktualizuję Budget Guard.`);
        await adminDb.collection("tenders").doc(tenderId).update({
            "budgetGuard.currentCostUSD": FieldValue.increment(costUSD)
        });

        isSuccess = true;
        console.log("[GAP FILLER 🧩] Szacowanie wskaźnikowe zakończone pomyślnie.");
        return NextResponse.json({ success: true });

    } catch (error: any) {
        console.error("[GAP FILLER 🧩] ❌ Błąd krytyczny w agencie gap filler:", error);
        if (tenderId && taskId) {
            console.log("[GAP FILLER 🧩] Zapisuję status błędu (ERROR) do bazy.");
            await adminDb.collection(`tenders/${tenderId}/tasks`).doc(taskId).update({
                status: "ERROR",
                rawResult: { error: error.message },
                processedByBrain: false,
                updatedAt: new Date()
            }).catch((dbErr) => console.error("[GAP FILLER 🧩] Błąd zapisu błędu do Firestore:", dbErr));
        }
        return NextResponse.json({ error: error.message }, { status: 500 });

    } finally {
        // Gwarancja wybudzenia Mózgu
        if (tenderId && taskId) {
            const localOrigin = `http://127.0.0.1:${process.env.PORT || "3000"}`;
            console.log(`[GAP FILLER 🧩] Wybudzam Mózg przez loopback: ${localOrigin}`);
            fetch(`${localOrigin}/api/kosztorysant/glowny-kosztorysant`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    tenderId,
                    trigger: isSuccess ? `TASK_COMPLETED_${taskId}` : `TASK_FAILED_${taskId}`
                })
            }).catch((fetchErr) => console.error("[GAP FILLER 🧩] Błąd wybudzania Mózgu przez fetch:", fetchErr));
        }
    }
}