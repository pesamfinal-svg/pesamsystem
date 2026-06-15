import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { FieldValue } from "firebase-admin/firestore";
import { GoogleGenAI } from "@google/genai";
import dns from "dns";
dns.setDefaultResultOrder("ipv4first");

export const dynamic = "force-dynamic";
export const maxDuration = 300; // Upewniamy się, że timeout jest na maksa dla dużych SWZ

const MODEL_FLASH = "gemini-2.5-flash"; // Wymuszamy najnowszą, tańszą i stabilną wersję 2.5 Flash

const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
    location: "global"
});

async function callGeminiWithRetry(fn: () => Promise<any>, retries = 5, delay = 5000): Promise<any> {
    try {
        return await fn();
    } catch (error: any) {
        const errorText = error.toString() || "";
        const isRateLimit = errorText.includes("429") || errorText.includes("RESOURCE_EXHAUSTED");
        if (isRateLimit && retries > 0) {
            console.warn(`[LEGAL EXPERT ⚖️] Limit 429. Odczekuję ${delay / 1000}s...`);
            await new Promise(resolve => setTimeout(resolve, delay + Math.random() * 2000));
            return callGeminiWithRetry(fn, retries - 1, delay * 2);
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

        console.log(`[LEGAL EXPERT ⚖️] Start żądania. tenderId: ${tenderId}, taskId: ${taskId}`);

        if (!tenderId || !taskId) return NextResponse.json({ error: "Brak parametrów" }, { status: 400 });

        const taskRef = adminDb.collection(`tenders/${tenderId}/tasks`).doc(taskId);
        const taskDoc = await taskRef.get();
        if (!taskDoc.exists) throw new Error("Zadanie nie istnieje.");

        const taskData = taskDoc.data()!;
        if (taskData.status !== "PENDING") return NextResponse.json({ message: "Zadanie już obsłużone." });

        await taskRef.update({ status: "IN_PROGRESS", updatedAt: new Date() });

        const inputDocIds: string[] = taskData.inputDocIds || [];
        if (inputDocIds.length === 0) {
            await taskRef.update({ status: "DONE", rawResult: { message: "Brak dokumentów." }, processedByBrain: false, updatedAt: new Date() });
            isSuccess = true;
            return NextResponse.json({ message: "Brak plików." });
        }

        const bucketName = process.env.STORAGE_BUCKET || "pesam-system-81165.firebasestorage.app";
        const parts: any[] = [];

        // Generowanie bezpośrednich referencji do GCS (Zero ściągania bufferów)
        for (const docId of inputDocIds) {
            const docSnap = await adminDb.collection(`tenders/${tenderId}/documents`).doc(docId).get();
            if (!docSnap.exists) continue;

            const docData = docSnap.data()!;
            const fileUri = `gs://${bucketName}/${docData.storagePath}`;
            console.log(`[LEGAL EXPERT ⚖️] Przygotowuję referencję GCS dla pliku: ${docData.fileName}`);

            parts.push({
                fileData: {
                    fileUri: fileUri,
                    mimeType: docData.mimeType || "application/pdf"
                }
            });
        }

        const prompt = `
Jesteś Ekspertem Prawnym i Analitykiem Umów Przetargowych w Polsce.
Przeanalizuj załączone pliki w oparciu o poniższą instrukcję od Mózgu:

${taskData.instruction}

Ważne zasady:
- Skup się na twardych danych mających realny wpływ na koszty i ryzyko.
- Zwróć wynik jako poprawny obiekt JSON, z odpowiednimi mapowaniami klucz-wartość ułatwiającymi wczytanie do "knownFacts" Mózgu.
- Zwróć wynik jako czysty tekst. Zakazuje się owijania tekstu w bloki markdown takie jak \`\`\`json.
`;

        parts.unshift({ text: prompt });
        console.log(`[LEGAL EXPERT ⚖️] Wysyłam duże zapytanie referencyjne (PDF GCS) do modelu Gemini Flash...`);

        const result = await callGeminiWithRetry(async () => {
            return await ai.models.generateContent({
                model: MODEL_FLASH,
                contents: parts,
                config: {
                    temperature: 0.1
                    // Usunięto responseMimeType by ustabilizować zwrot na bardzo obszernych plikach SWZ
                }
            });
        });

        console.log("[LEGAL EXPERT ⚖️] Odebrano odpowiedź. Parsuję wynik tekstowy...");
        let rawText = result.text ?? "{}";
        rawText = rawText.replace(/```json/gi, "").replace(/```/g, "").trim();

        let rawResult = {};
        try {
            rawResult = JSON.parse(rawText);
        } catch (e) {
            console.warn("[LEGAL EXPERT ⚖️] System nie mógł idealnie sparsować formatu JSON (prawdopodobnie za dużo tekstu), zwracam w postaci ustrukturyzowanej surowej odpowiedzi.");
            rawResult = { summary: rawText };
        }

        const tokensUsed = result.usageMetadata?.totalTokenCount || 0;

        await taskRef.update({
            status: "DONE",
            rawResult: rawResult,
            processedByBrain: false,
            costTokens: tokensUsed,
            updatedAt: new Date()
        });

        const costUSD = (tokensUsed / 1000) * 0.000015;

        await adminDb.collection("tenders").doc(tenderId).update({
            "budgetGuard.currentCostUSD": FieldValue.increment(costUSD)
        });

        isSuccess = true;
        console.log("[LEGAL EXPERT ⚖️] Zadanie zakończone sukcesem.");
        return NextResponse.json({ success: true });

    } catch (error: any) {
        console.error("[LEGAL EXPERT ⚖️] ❌ Błąd krytyczny:", error);
        if (tenderId && taskId) {
            await adminDb.collection(`tenders/${tenderId}/tasks`).doc(taskId).update({
                status: "ERROR",
                rawResult: { error: error.message },
                processedByBrain: false,
                updatedAt: new Date()
            }).catch(() => { });
        }
        return NextResponse.json({ error: error.message }, { status: 500 });
    } finally {
        if (tenderId && taskId) {
            // Dodane niewielkie opóźnienie dla chmury (Jitter), żeby nie nadpisywać żądań
            const jitter = 1000 + Math.random() * 2000;
            await new Promise(r => setTimeout(r, jitter));

            const localOrigin = `http://localhost:${process.env.PORT || "3000"}`;
            fetch(`${localOrigin}/api/kosztorysant/glowny-kosztorysant`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ tenderId, trigger: isSuccess ? `TASK_COMPLETED_${taskId}` : `TASK_FAILED_${taskId}` })
            }).catch(() => { });
        }
    }
}