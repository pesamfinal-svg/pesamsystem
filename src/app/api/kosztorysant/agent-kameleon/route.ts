import { NextResponse } from "next/server";
import { adminDb, adminStorage } from "@/lib/firebase/admin";
import { FieldValue } from "firebase-admin/firestore";
import { GoogleGenAI, Type } from "@google/genai";
import { jsonrepair } from "jsonrepair";

export const dynamic = "force-dynamic";

const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
    location: "global"
});

const MODEL_PRO = "gemini-2.5-pro"; // Specjalistyczna analiza niszowych branż technologicznych wymaga modelu Pro

// Schemat ustrukturyzowanego wyjścia dla robotów specjalistycznych
const KAMELEON_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        items: {
            type: Type.ARRAY,
            description: "Lista wyciągniętych pozycji specjalistycznych.",
            items: {
                type: Type.OBJECT,
                properties: {
                    pozycja: { type: Type.STRING, description: "Nazwa lub indeks pozycji specjalistycznej" },
                    opis: { type: Type.STRING, description: "Pełny techniczny opis pozycji kosztorysowej" },
                    ilosc: { type: Type.NUMBER, description: "Szacowana ilość (liczba)" },
                    jednostka: { type: Type.STRING, description: "Jednostka miary, np. kpl, szt, m" },
                    KNR_ref: { type: Type.STRING, description: "Zapisz 'WYCENA_INDYWIDUALNA' lub sugerowany kod normy" }
                },
                required: ["pozycja", "opis", "ilosc", "jednostka", "KNR_ref"]
            }
        },
        summary: { type: Type.STRING, description: "Krótkie podsumowanie techniczne analizy specjalistycznej." }
    },
    required: ["items", "summary"]
};

export async function POST(req: Request) {
    let tenderId: string | undefined;
    let taskId: string | undefined;
    let isSuccess = false;

    try {
        const body = await req.json();
        tenderId = body.tenderId;
        taskId = body.taskId;

        console.log(`[KAMELEON 🦎] Otrzymano żądanie POST. tenderId: ${tenderId}, taskId: ${taskId}`);

        if (!tenderId || !taskId) {
            console.error("[KAMELEON 🦎] Błąd: Brak wymaganych parametrów tenderId lub taskId.");
            return NextResponse.json({ error: "Brak danych" }, { status: 400 });
        }

        const taskRef = adminDb.collection(`tenders/${tenderId}/tasks`).doc(taskId);
        const taskDoc = await taskRef.get();

        if (!taskDoc.exists) {
            console.error(`[KAMELEON 🦎] Zadanie o ID ${taskId} nie istnieje w bazie.`);
            throw new Error("Zadanie nie istnieje.");
        }

        const taskData = taskDoc.data()!;
        console.log(`[KAMELEON 🦎] Wczytano zadanie. Status w bazie: ${taskData.status}`);

        if (taskData.status !== "PENDING") {
            console.log(`[KAMELEON 🦎] Zadanie ma status ${taskData.status}. Pomijam.`);
            return NextResponse.json({ message: "Task handled." });
        }

        // Zmiana statusu na IN_PROGRESS
        console.log("[KAMELEON 🦎] Zmieniam status zadania na IN_PROGRESS.");
        await taskRef.update({ status: "IN_PROGRESS", updatedAt: new Date() });

        const inputDocIds: string[] = taskData.inputDocIds || [];
        console.log(`[KAMELEON 🦎] Pliki wejściowe do analizy specjalistycznej: ${JSON.stringify(inputDocIds)}`);

        if (inputDocIds.length === 0) {
            console.warn("[KAMELEON 🦎] Brak plików w zadaniu. Kończę pomyślnie.");
            await taskRef.update({
                status: "DONE",
                rawResult: { message: "Brak plików do przeanalizowania." },
                processedByBrain: false,
                updatedAt: new Date()
            });
            isSuccess = true;
            return NextResponse.json({ message: "Brak plików." });
        }

        const bucketName = process.env.STORAGE_BUCKET || "pesam-system-81165.firebasestorage.app";
        const bucket = adminStorage.bucket(bucketName);
        const allExtractedItems: any[] = [];
        let totalTokensUsed = 0;

        // Iterujemy po wszystkich plikach przeznaczonych do analizy branżowej
        for (const docId of inputDocIds) {
            console.log(`[KAMELEON 🦎] Pobieram metadane dokumentu: ${docId}`);
            const docSnap = await adminDb.collection(`tenders/${tenderId}/documents`).doc(docId).get();
            if (!docSnap.exists) {
                console.warn(`[KAMELEON 🦎] Dokument ${docId} nie istnieje w bazie. Pomijam.`);
                continue;
            }

            const docData = docSnap.data()!;
            console.log(`[KAMELEON 🦎] Pobieram plik ze Storage: ${docData.storagePath}`);

            try {
                const fileRef = bucket.file(docData.storagePath);
                const [downloadedBuffer] = await fileRef.download();
                console.log(`[KAMELEON 🦎] Pobrano plik ${docData.fileName} (${downloadedBuffer.length} bajtów).`);

                const safeArrayBuffer = new Uint8Array(downloadedBuffer).buffer;
                const base64Data = Buffer.from(safeArrayBuffer).toString("base64");
                console.log(`[KAMELEON 🦎] Przekonwertowano plik ${docData.fileName} do Base64.`);

                const prompt = `
Jesteś Ekspertem Technologicznym i Inżynierem Kosztorysantem w wąskiej branży specjalistycznej.
Przeanalizuj załączony dokument, aby wyodrębnić pozycje kosztorysowe.

Twoje polecenie od Mózgu:
${taskData.instruction}

Ważne zasady:
- Skup się na precyzji technologicznej (nazwy urządzeń, parametry, wymagane akcesoria montażowe).
- Zwróć wynik jako poprawny obiekt JSON, pasujący dokładnie do zdefiniowanego schematu.
- Nie dodawaj żadnego innego tekstu poza czystym JSON-em.
`;

                console.log(`[KAMELEON 🦎] Wysyłam zapytanie do Gemini Pro dla pliku: ${docData.fileName}`);

                const result = await ai.models.generateContent({
                    model: taskData.modelOverride || MODEL_PRO, // Domyślnie model Pro dla zadań specjalistycznych
                    contents: [
                        {
                            role: "user",
                            parts: [
                                { text: prompt },
                                { inlineData: { data: base64Data, mimeType: docData.mimeType || "application/pdf" } }
                            ]
                        }
                    ],
                    config: {
                        temperature: 0.1,
                        responseMimeType: "application/json",
                        responseSchema: KAMELEON_SCHEMA as any
                    }
                });

                console.log(`[KAMELEON 🦎] Odebrano odpowiedź z Gemini dla pliku: ${docData.fileName}. Parsuję JSON...`);
                const parsedResult = JSON.parse(jsonrepair(result.text ?? "{}"));
                const tokensUsed = result.usageMetadata?.totalTokenCount || 0;
                totalTokensUsed += tokensUsed;

                if (parsedResult.items && parsedResult.items.length > 0) {
                    console.log(`[KAMELEON 🦎] Wyciągnięto ${parsedResult.items.length} pozycji specjalistycznych z pliku ${docData.fileName}`);
                    allExtractedItems.push(...parsedResult.items);
                } else {
                    console.warn(`[KAMELEON 🦎] Nie wykryto pozycji specjalistycznych w pliku ${docData.fileName}.`);
                }

            } catch (err: any) {
                console.error(`[KAMELEON 🦎] Błąd krytyczny podczas parsowania pliku ${docData.fileName}:`, err);
                throw err;
            }
        }

        console.log(`[KAMELEON 🦎] Łącznie ze wszystkich plików wyodrębniono ${allExtractedItems.length} pozycji specjalistycznych.`);

        // Zapisujemy całą strukturę bezpośrednio do rawResult i oznaczamy zadanie jako DONE
        console.log("[KAMELEON 🦎] Zapisuję rawResult w bazie danych.");
        await taskRef.update({
            status: "DONE",
            rawResult: {
                items: allExtractedItems,
                summary: `Pomyślnie zanalizowano dokumentację specjalistyczną. Wyodrębniono ${allExtractedItems.length} pozycji.`
            },
            processedByBrain: false,
            costTokens: totalTokensUsed,
            updatedAt: new Date()
        });

        // Koszt tokenów (Pro: ~$0.002 / 1k, Flash: ~$0.000015 / 1k)
        const costPerThousand = (taskData.modelOverride === "gemini-2.5-flash") ? 0.000015 : 0.002;
        const costUSD = (totalTokensUsed / 1000) * costPerThousand;

        console.log(`[KAMELEON 🦎] Koszt tokenów: ${costUSD.toFixed(6)} USD. Aktualizuję Budget Guard.`);
        await adminDb.collection("tenders").doc(tenderId).update({
            "budgetGuard.currentCostUSD": FieldValue.increment(costUSD)
        });

        isSuccess = true;
        console.log("[KAMELEON 🦎] Analiza branżowa zakończona sukcesem.");
        return NextResponse.json({ success: true });

    } catch (error: any) {
        console.error("[KAMELEON 🦎] ❌ Błąd krytyczny w agencie kameleon:", error);
        if (tenderId && taskId) {
            console.log("[KAMELEON 🦎] Zapisuję status błędu (ERROR) do bazy.");
            await adminDb.collection(`tenders/${tenderId}/tasks`).doc(taskId).update({
                status: "ERROR",
                rawResult: { error: error.message },
                processedByBrain: false,
                updatedAt: new Date()
            }).catch((dbErr) => console.error("[KAMELEON 🦎] Błąd zapisu błędu do Firestore:", dbErr));
        }
        return NextResponse.json({ error: error.message }, { status: 500 });

    } finally {
        // Gwarancja wybudzenia Mózgu
        if (tenderId && taskId) {
            const localOrigin = `http://127.0.0.1:${process.env.PORT || "3000"}`;
            console.log(`[KAMELEON 🦎] Wybudzam Mózg przez loopback: ${localOrigin}`);
            fetch(`${localOrigin}/api/kosztorysant/glowny-kosztorysant`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    tenderId,
                    trigger: isSuccess ? `TASK_COMPLETED_${taskId}` : `TASK_FAILED_${taskId}`
                })
            }).catch((fetchErr) => console.error("[KAMELEON 🦎] Błąd wybudzania Mózgu przez fetch:", fetchErr));
        }
    }
}