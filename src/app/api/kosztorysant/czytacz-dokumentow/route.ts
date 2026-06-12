import { NextResponse } from "next/server";
import { adminDb, adminStorage } from "@/lib/firebase/admin";
import { FieldValue } from "firebase-admin/firestore";
import { GoogleGenAI } from "@google/genai";
import dns from "dns";
dns.setDefaultResultOrder("ipv4first"); // Wymuszenie stabilnego protokołu IPv4 dla całego procesu

export const dynamic = "force-dynamic";

const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
    location: "global"
});

// Pomocnicza funkcja realizująca Exponential Backoff dla błędów 429 (RESOURCE_EXHAUSTED) u Agenta
async function callGeminiWithRetry(fn: () => Promise<any>, retries = 3, delay = 3000): Promise<any> {
    try {
        return await fn();
    } catch (error: any) {
        const errorText = error.toString() || "";
        const isRateLimit = errorText.includes("429") || errorText.includes("RESOURCE_EXHAUSTED");

        if (isRateLimit && retries > 0) {
            console.warn(`[LEGAL EXPERT ⚖️] Wykryto limit API 429. Chmura przeciążona. Czekam ${delay / 1000}s przed próbą ponowienia... (Pozostało prób: ${retries})`);
            await new Promise(resolve => setTimeout(resolve, delay));
            return callGeminiWithRetry(fn, retries - 1, delay * 2); // Exponential backoff
        }
        throw error;
    }
}

export async function POST(req: Request) {
    let tenderId: string | undefined;
    let taskId: string | undefined;
    let isSuccess = false;

    try {
        const body = await req.json();
        tenderId = body.tenderId;
        taskId = body.taskId;

        console.log(`[LEGAL EXPERT ⚖️] Otrzymano żądanie POST dla tenderId: ${tenderId}, taskId: ${taskId}`);

        if (!tenderId || !taskId) {
            console.error("[LEGAL EXPERT ⚖️] Błąd: Brak parametrów tenderId lub taskId.");
            return NextResponse.json({ error: "Brak tenderId lub taskId" }, { status: 400 });
        }

        const taskRef = adminDb.collection(`tenders/${tenderId}/tasks`).doc(taskId);
        const taskDoc = await taskRef.get();

        if (!taskDoc.exists) {
            console.error(`[LEGAL EXPERT ⚖️] Zadanie o ID ${taskId} nie istnieje w bazie.`);
            throw new Error("Zadanie nie istnieje.");
        }

        const taskData = taskDoc.data()!;
        console.log(`[LEGAL EXPERT ⚖️] Wczytano zadanie. Status: ${taskData.status}`);

        if (taskData.status !== "PENDING") {
            console.log(`[LEGAL EXPERT ⚖️] Zadanie zostało już przetworzone (status: ${taskData.status}). Przerywam.`);
            return NextResponse.json({ message: "Task already processed or in progress." });
        }

        // Zmiana statusu na IN_PROGRESS
        console.log("[LEGAL EXPERT ⚖️] Zmieniam status zadania na IN_PROGRESS.");
        await taskRef.update({ status: "IN_PROGRESS", updatedAt: new Date() });

        const inputDocIds: string[] = taskData.inputDocIds || [];
        console.log(`[LEGAL EXPERT ⚖️] Do przeanalizowania wskazano dokumenty o ID: ${JSON.stringify(inputDocIds)}`);

        if (inputDocIds.length === 0) {
            console.warn("[LEGAL EXPERT ⚖️] Brak dokumentów wejściowych w zadaniu. Kończę pomyślnie bez analizy.");
            await taskRef.update({
                status: "DONE",
                rawResult: { message: "Brak dokumentów do analizy." },
                processedByBrain: false,
                updatedAt: new Date()
            });
            isSuccess = true;
            return NextResponse.json({ message: "Brak dokumentów." });
        }

        const bucketName = process.env.STORAGE_BUCKET || "pesam-system-81165.firebasestorage.app";
        const bucket = adminStorage.bucket(bucketName);
        const parts: any[] = [];

        // Pobieramy i konwertujemy pliki do base64
        for (const docId of inputDocIds) {
            console.log(`[LEGAL EXPERT ⚖️] Pobieram metadane dokumentu o ID: ${docId}`);
            const docSnap = await adminDb.collection(`tenders/${tenderId}/documents`).doc(docId).get();

            if (!docSnap.exists) {
                console.warn(`[LEGAL EXPERT ⚖️] Dokument o ID ${docId} nie istnieje w Firestore. Pomijam.`);
                continue;
            }

            const docData = docSnap.data()!;
            console.log(`[LEGAL EXPERT ⚖️] Pobieram plik ze Storage: ${docData.storagePath}`);

            try {
                const fileRef = bucket.file(docData.storagePath);
                const [downloadedBuffer] = await fileRef.download();
                console.log(`[LEGAL EXPERT ⚖️] Pobrano ${downloadedBuffer.length} bajtów dla pliku: ${docData.fileName}`);

                const safeArrayBuffer = new Uint8Array(downloadedBuffer).buffer;
                const base64Data = Buffer.from(safeArrayBuffer).toString("base64");
                console.log(`[LEGAL EXPERT ⚖️] Pomyślnie przekonwertowano ${docData.fileName} do Base64.`);

                parts.push({
                    inlineData: {
                        data: base64Data,
                        mimeType: docData.mimeType || "application/pdf"
                    }
                });
            } catch (err: any) {
                console.error(`[LEGAL EXPERT ⚖️] Błąd pobierania pliku ${docData.fileName} ze Storage:`, err);
                throw err;
            }
        }

        // Składanie dynamicznego promptu od Mózgu
        const prompt = `
Jesteś Ekspertem Prawnym i Analitykiem Umów Przetargowych w Polsce.
Przeanalizuj załączone pliki w oparciu o poniższą instrukcję od Mózgu:

${taskData.instruction}

Ważne zasady:
- Skup się na twardych danych mających realny wpływ na koszty i ryzyko.
- Zwróć wynik jako poprawny obiekt JSON, pasujący dokładnie do struktury zdefiniowanej przez Mózg w instrukcji.
- Nie dodawaj żadnego dodatkowego tekstu ani znaczników markdown poza czystym JSON-em.
`;

        parts.unshift({ text: prompt });
        console.log(`[LEGAL EXPERT ⚖️] Wysyłam zapytanie do Gemini z ${parts.length - 1} plikami jako wsad multimedialny (z zabezpieczeniem przed limitami)...`);

        // Wywołanie z systemem Exponential Backoff
        const result = await callGeminiWithRetry(async () => {
            return await ai.models.generateContent({
                model: taskData.modelOverride || "gemini-2.5-flash", // Domyślnie Flash
                contents: parts, // Direct, clean typesafe Turn array (Part[])
                config: {
                    temperature: 0.1,
                    responseMimeType: "application/json"
                }
            });
        });

        console.log("[LEGAL EXPERT ⚖️] Odebrano odpowiedź z Gemini. Parsuję wynik JSON...");
        const rawResult = JSON.parse(result.text ?? "{}");
        const tokensUsed = result.usageMetadata?.totalTokenCount || 0;
        console.log(`[LEGAL EXPERT ⚖️] Zużyto tokenów: ${tokensUsed}. Zapisuję rawResult w bazie.`);

        // Aktualizujemy zadanie jako DONE
        await taskRef.update({
            status: "DONE",
            rawResult: rawResult,
            processedByBrain: false,
            costTokens: tokensUsed,
            updatedAt: new Date()
        });

        // Koszt tokenów
        const costPerThousand = (taskData.modelOverride === "gemini-2.5-pro") ? 0.002 : 0.000015;
        const costUSD = (tokensUsed / 1000) * costPerThousand;

        console.log(`[LEGAL EXPERT ⚖️] Koszt: ${costUSD.toFixed(6)} USD. Aktualizuję Budget Guard.`);
        await adminDb.collection("tenders").doc(tenderId).update({
            "budgetGuard.currentCostUSD": FieldValue.increment(costUSD)
        });

        isSuccess = true;
        console.log("[LEGAL EXPERT ⚖️] Zadanie zakończone sukcesem.");
        return NextResponse.json({ success: true });

    } catch (error: any) {
        console.error("[LEGAL EXPERT ⚖️] ❌ Błąd krytyczny w Legal Expert:", error);
        if (tenderId && taskId) {
            console.log("[LEGAL EXPERT ⚖️] Zapisuję status błędu (ERROR) do zadania w bazie.");
            await adminDb.collection(`tenders/${tenderId}/tasks`).doc(taskId).update({
                status: "ERROR",
                rawResult: { error: error.message },
                processedByBrain: false,
                updatedAt: new Date()
            }).catch((dbErr) => console.error("[LEGAL EXPERT ⚖️] Nie udało się zapisać błędu do Firestore:", dbErr));
        }
        return NextResponse.json({ error: error.message }, { status: 500 });

    } finally {
        // Gwarancja wybudzenia Mózgu (zawsze w finally)
        if (tenderId && taskId) {
            const localOrigin = `http://localhost:${process.env.PORT || "3000"}`;
            console.log(`[...] Wybudzam Mózg przez bezpieczny loopback: ${localOrigin}`);
            fetch(`${localOrigin}/api/kosztorysant/glowny-kosztorysant`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    tenderId,
                    trigger: isSuccess ? `TASK_COMPLETED_${taskId}` : `TASK_FAILED_${taskId}`
                })
            }).catch((fetchErr) => console.error("[LEGAL EXPERT ⚖️] Błąd wybudzania Mózgu przez fetch:", fetchErr));
        }
    }
}