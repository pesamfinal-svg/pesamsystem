import { NextResponse } from "next/server";
import { adminDb, adminStorage } from "@/lib/firebase/admin";
import { FieldValue } from "firebase-admin/firestore";
import { GoogleGenAI } from "@google/genai";

export const dynamic = "force-dynamic";

const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
    location: "global"
});

export async function POST(req: Request) {
    let tenderId: string | undefined;
    let taskId: string | undefined;
    let isSuccess = false;

    try {
        const body = await req.json();
        tenderId = body.tenderId;
        taskId = body.taskId;

        console.log(`[VISION 📐] Otrzymano żądanie POST. tenderId: ${tenderId}, taskId: ${taskId}`);

        if (!tenderId || !taskId) {
            console.error("[VISION 📐] Błąd: Brak wymaganych parametrów tenderId lub taskId.");
            return NextResponse.json({ error: "Brak tenderId lub taskId" }, { status: 400 });
        }

        const taskRef = adminDb.collection(`tenders/${tenderId}/tasks`).doc(taskId);
        const taskDoc = await taskRef.get();

        if (!taskDoc.exists) {
            console.error(`[VISION 📐] Zadanie o ID ${taskId} nie istnieje w bazie.`);
            throw new Error("Zadanie nie istnieje.");
        }

        const taskData = taskDoc.data()!;
        console.log(`[VISION 📐] Wczytano dane zadania. Aktualny status: ${taskData.status}`);

        if (taskData.status !== "PENDING") {
            console.log(`[VISION 📐] Zadanie ma status ${taskData.status}. Przerywam przetwarzanie.`);
            return NextResponse.json({ message: "Task already processed." });
        }

        // Zmiana statusu na IN_PROGRESS
        console.log("[VISION 📐] Zmieniam status zadania na IN_PROGRESS.");
        await taskRef.update({ status: "IN_PROGRESS", updatedAt: new Date() });

        const inputDocIds: string[] = taskData.inputDocIds || [];
        console.log(`[VISION 📐] Dokumenty wejściowe do analizy wizualnej: ${JSON.stringify(inputDocIds)}`);

        if (inputDocIds.length === 0) {
            console.warn("[VISION 📐] Brak rysunków wejściowych w zadaniu. Kończę pomyślnie bez analizy.");
            await taskRef.update({
                status: "DONE",
                rawResult: { message: "Brak rysunków do analizy." },
                processedByBrain: false,
                updatedAt: new Date()
            });
            isSuccess = true;
            return NextResponse.json({ message: "Brak dokumentów." });
        }

        const bucketName = process.env.STORAGE_BUCKET || "pesam-system-81165.firebasestorage.app";
        const bucket = adminStorage.bucket(bucketName);
        const parts: any[] = [];

        // Pobieramy rysunki ze Storage i konwertujemy do Base64
        for (const docId of inputDocIds) {
            console.log(`[VISION 📐] Pobieram metadane dokumentu o ID: ${docId}`);
            const docSnap = await adminDb.collection(`tenders/${tenderId}/documents`).doc(docId).get();
            if (!docSnap.exists) {
                console.warn(`[VISION 📐] Dokument o ID ${docId} nie istnieje w Firestore. Pomijam.`);
                continue;
            }

            const docData = docSnap.data()!;
            console.log(`[VISION 📐] Pobieram rysunek ze Storage: ${docData.storagePath}`);

            try {
                const fileRef = bucket.file(docData.storagePath);
                const [downloadedBuffer] = await fileRef.download();
                console.log(`[VISION 📐] Pobrano ${downloadedBuffer.length} bajtów rysunku: ${docData.fileName}`);

                const safeArrayBuffer = new Uint8Array(downloadedBuffer).buffer;
                const base64Data = Buffer.from(safeArrayBuffer).toString("base64");
                console.log(`[VISION 📐] Przekonwertowano rysunek ${docData.fileName} do Base64.`);

                parts.push({
                    inlineData: {
                        data: base64Data,
                        mimeType: docData.mimeType || "application/pdf"
                    }
                });
            } catch (err: any) {
                console.error(`[VISION 📐] Błąd pobierania rysunku ${docData.fileName} ze Storage:`, err);
                throw err;
            }
        }

        // Kompilujemy dynamiczny prompt od Mózgu
        const prompt = `
Jesteś Inżynierem Projektantem, Architektem i Konstruktorem. 
Przeanalizuj załączone rysunki techniczne i schematy w oparciu o poniższą instrukcję od Mózgu:

${taskData.instruction}

Ważne zasady:
- Dokładnie odczytuj wymiary, rzędne, skale, grubości przegród i opisy na rysunku.
- Zwróć wynik jako poprawny obiekt JSON, pasujący dokładnie do struktury zdefiniowanej przez Mózg w instrukcji.
- Nie dodawaj żadnego dodatkowego tekstu ani znaczników markdown poza czystym JSON-em.
`;

        parts.unshift({ text: prompt });
        console.log(`[VISION 📐] Wysyłam zapytanie do Gemini z ${parts.length - 1} rysunkami jako wsad wizyjny...`);

        // Rysunki są trudnym zadaniem - domyślnie używamy Flash, ale Mózg może nakazać Pro (np. do gęstych rzutów)
        const result = await ai.models.generateContent({
            model: taskData.modelOverride || "gemini-2.5-flash",
            contents: [{ role: "user", parts }],
            config: {
                temperature: 0.1,
                responseMimeType: "application/json"
            }
        });

        console.log("[VISION 📐] Odebrano odpowiedź z Gemini. Parsuję wynik JSON...");
        const rawResult = JSON.parse(result.text ?? "{}");
        const tokensUsed = result.usageMetadata?.totalTokenCount || 0;
        console.log(`[VISION 📐] Zużyto tokenów: ${tokensUsed}. Zapisuję rawResult w bazie.`);

        // Aktualizujemy zadanie jako DONE
        await taskRef.update({
            status: "DONE",
            rawResult: rawResult,
            processedByBrain: false,
            costTokens: tokensUsed,
            updatedAt: new Date()
        });

        // Koszt tokenów (Flash: ~$0.000015 / 1k, Pro: ~$0.002 / 1k)
        const costPerThousand = (taskData.modelOverride === "gemini-2.5-pro") ? 0.002 : 0.000015;
        const costUSD = (tokensUsed / 1000) * costPerThousand;

        console.log(`[VISION 📐] Naliczyłem koszt: ${costUSD.toFixed(6)} USD. Aktualizuję Budget Guard.`);
        await adminDb.collection("tenders").doc(tenderId).update({
            "budgetGuard.currentCostUSD": FieldValue.increment(costUSD)
        });

        isSuccess = true;
        console.log("[VISION 📐] Zadanie zakończone sukcesem.");
        return NextResponse.json({ success: true });

    } catch (error: any) {
        console.error("[VISION 📐] ❌ Błąd krytyczny w agencie wizyjnym:", error);
        if (tenderId && taskId) {
            console.log("[VISION 📐] Zapisuję status błędu (ERROR) do zadania w bazie.");
            await adminDb.collection(`tenders/${tenderId}/tasks`).doc(taskId).update({
                status: "ERROR",
                rawResult: { error: error.message },
                processedByBrain: false,
                updatedAt: new Date()
            }).catch((dbErr) => console.error("[VISION 📐] Nie udało się zapisać błędu do Firestore:", dbErr));
        }
        return NextResponse.json({ error: error.message }, { status: 500 });

    } finally {
        // Gwarancja wybudzenia Mózgu (zawsze w finally)
        if (tenderId && taskId) {
            const localOrigin = `http://127.0.0.1:${process.env.PORT || "3000"}`;
            console.log(`[VISION 📐] Wybudzam Mózg przez loopback na adresie: ${localOrigin}`);
            fetch(`${localOrigin}/api/kosztorysant/glowny-kosztorysant`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    tenderId,
                    trigger: isSuccess ? `TASK_COMPLETED_${taskId}` : `TASK_FAILED_${taskId}`
                })
            }).catch((fetchErr) => console.error("[VISION 📐] Błąd wybudzania Mózgu przez fetch:", fetchErr));
        }
    }
}