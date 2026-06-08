// ============================================================
// PESAM 3.0 – Agent Specjalista: VISION (Architekt / Konstruktor)
// POST /api/kosztorysant/agent-wbs-architekt
// ============================================================

import { NextResponse } from "next/server";
import { adminDb, adminStorage } from "@/lib/firebase/admin";
import { FieldValue } from "firebase-admin/firestore";
import { GoogleGenAI, Type } from "@google/genai";
import { randomUUID } from "crypto"; // Standard 4: Natywny generator bez zewnętrznych zależności

export const dynamic = "force-dynamic";

// Standard 3 & 4: Inicjalizacja klienta Google GenAI (Vertex AI, global)
const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
    location: "global"
});

const MODEL_FLASH = "gemini-2.5-flash";

// Schemat odpowiedzi Agenta Wizyjnego (Zgodność ze Standardem 1)
const VISION_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        items: {
            type: Type.ARRAY,
            description: "Lista wyciągniętych pozycji przedmiarowych z rysunku.",
            items: {
                type: Type.OBJECT,
                properties: {
                    pozycja: { type: Type.STRING, description: "Krótka nazwa elementu, np. 'Ściana nośna gr. 24cm', 'Ława fundamentowa'" },
                    opis: { type: Type.STRING, description: "Szczegółowy opis z wymiarami, np. 'Ściana z pustaków ceramicznych, wys. 3m, dł. 12m'" },
                    ilosc: { type: Type.NUMBER, description: "Wyliczona ilość (zawsze jako liczba zmiennoprzecinkowa, np. 36.0)" },
                    jednostka: { type: Type.STRING, description: "Jednostka miary, np. 'm2', 'm3', 'mb', 'szt'" },
                    KNR_ref: { type: Type.STRING, description: "Sugerowany kod KNR lub kategoria, np. 'KNR 2-02', 'KNR 2-01'" },
                    confidence: { type: Type.STRING, description: "Pewność odczytu: 'HIGH', 'MEDIUM', 'LOW'" }
                },
                required: ["pozycja", "opis", "ilosc", "jednostka", "KNR_ref", "confidence"]
            }
        },
        summary: {
            type: Type.STRING,
            description: "Krótkie podsumowanie tego, co udało się odczytać z rysunku."
        }
    },
    required: ["items", "summary"]
};

export async function POST(req: Request) {
    let tenderId: string | undefined;
    let taskId: string | undefined;

    try {
        const body = await req.json();
        tenderId = body.tenderId;
        taskId = body.taskId;

        if (!tenderId || !taskId) {
            return NextResponse.json({ error: "Brak tenderId lub taskId" }, { status: 400 });
        }

        console.log(`[PESAM 3.0 📐] VISION_AGENT wybudzony. Przetarg: ${tenderId} | Zadanie: ${taskId}`);

        const taskRef = adminDb.collection(`tenders/${tenderId}/tasks`).doc(taskId);
        const taskDoc = await taskRef.get();

        if (!taskDoc.exists) throw new Error("Zadanie nie istnieje.");

        const taskData = taskDoc.data()!;

        // Idempotentność
        if (taskData.status !== "PENDING") {
            console.log(`[PESAM 3.0 📐] Zadanie ${taskId} ma status ${taskData.status}. Pomijam.`);
            return NextResponse.json({ message: "Task already processed." });
        }

        // 1. Oznaczamy zadanie jako IN_PROGRESS
        await taskRef.update({ status: "IN_PROGRESS", updatedAt: new Date() });

        const inputDocIds: string[] = taskData.inputDocIds || [];
        if (inputDocIds.length === 0) {
            await taskRef.update({ status: "DONE", result: { summary: "Brak rysunków do analizy." } });
            return NextResponse.json({ message: "Brak dokumentów." });
        }

        let totalTokensUsed = 0;
        const allExtractedItems: any[] = [];
        const summaries: string[] = [];

        // 2. Pobieranie i analiza rysunków
        const bucketName = process.env.STORAGE_BUCKET || "pesam-system-81165.firebasestorage.app";
        const bucket = adminStorage.bucket(bucketName);

        for (const docId of inputDocIds) {
            const docSnap = await adminDb.collection(`tenders/${tenderId}/documents`).doc(docId).get();
            if (!docSnap.exists) continue;

            const docData = docSnap.data()!;
            console.log(`[PESAM 3.0 📐] Analizuję rysunek: ${docData.fileName}`);

            try {
                // Standard 3: Bezpieczne pobieranie bufora
                const fileRef = bucket.file(docData.storagePath);
                const [downloadedBuffer] = await fileRef.download();
                const safeArrayBuffer = new Uint8Array(downloadedBuffer).buffer;
                const base64Data = Buffer.from(safeArrayBuffer).toString("base64");

                const prompt = `
Jesteś Inżynierem (Architektem/Konstruktorem) w systemie PESAM 3.0.
Twoje zadanie: ${taskData.description}

Przeanalizuj załączony rysunek techniczny.
Zidentyfikuj główne elementy budowlane (np. ściany, stropy, fundamenty, stolarkę okienną).
Odczytaj wymiary i oblicz przybliżone ilości (np. powierzchnię w m2, objętość w m3).
Zwróć dane w ustrukturyzowanym formacie JSON.
`;

                const result = await ai.models.generateContent({
                    model: MODEL_FLASH,
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
                        responseSchema: VISION_SCHEMA as any
                    }
                });

                const responseText = result.text ?? "{}";
                const parsedResult = JSON.parse(responseText);

                totalTokensUsed += result.usageMetadata?.totalTokenCount || 0;

                if (parsedResult.items && Array.isArray(parsedResult.items)) {
                    // Formatowanie pozycji zgodnie ze Standardem 1 (items/{itemId})
                    const formattedItems = parsedResult.items.map((item: any) => ({
                        id: randomUUID(), // Standard 4: Natywny UUID
                        pozycja: item.pozycja || "Nieznana pozycja",
                        opis: item.opis || "",
                        ilosc: Number(item.ilosc) || 0, // Zawsze liczba
                        jednostka: item.jednostka || "szt",
                        cenaJed: 0, // Agent wizyjny nie zna cen, wyceni to Broker
                        wartosc: 0,
                        KNR_ref: item.KNR_ref || "Analiza Własna",
                        confidence: item.confidence || "MEDIUM",
                        sourceTrack: `Wymiar: Task-${taskId} (${taskData.agentType}) | Plik: ${docData.fileName}`,
                        sourceTaskId: taskId
                    }));
                    allExtractedItems.push(...formattedItems);
                }

                if (parsedResult.summary) summaries.push(parsedResult.summary);

            } catch (err) {
                console.error(`[PESAM 3.0 📐] Błąd analizy rysunku ${docData.fileName}:`, err);
            }
        }

        // 3. Zapis wyników do bazy (Aktualizacja Zadania i Kosztorysu)
        const batch = adminDb.batch();

        // A. Zakończenie zadania
        batch.update(taskRef, {
            status: "DONE",
            result: {
                itemsCount: allExtractedItems.length,
                summary: summaries.join(" | ")
            },
            costTokens: totalTokensUsed,
            updatedAt: new Date()
        });

        // B. Zapis do Żywego Kosztorysu (Kolekcja estimate) z unikiem nadpisania danych (Standard 1)
        if (allExtractedItems.length > 0) {
            const sectionId = `sec_${taskId}`;
            const estimateRef = adminDb.collection(`tenders/${tenderId}/estimate`).doc(sectionId);

            // Pobieramy ewentualne istniejące pozycje, aby nie wymazać wyników pracy innych plików
            const estimateDoc = await estimateRef.get();
            let combinedItems = allExtractedItems;
            if (estimateDoc.exists) {
                const existingItems = estimateDoc.data()?.items || [];
                combinedItems = [...existingItems, ...allExtractedItems];
            }

            const sectionName = taskData.agentType === "VISION_CONSTRUCT"
                ? "Roboty Konstrukcyjne (Stan Surowy)"
                : "Roboty Architektoniczne i Wykończeniowe";

            batch.set(estimateRef, {
                section: sectionName,
                status: "QUANTITY_READY",
                totalValue: 0,
                sourceTaskId: taskId,
                items: combinedItems, // Scalona tablica
                updatedAt: new Date()
            }, { merge: true });
        }

        // C. Aktualizacja Budget Guard (Flash: ~$0.000015 / 1k tokenów)
        const costUSD = (totalTokensUsed / 1000) * 0.000015;
        const tenderRef = adminDb.collection("tenders").doc(tenderId);
        batch.update(tenderRef, {
            "budgetGuard.currentCostUSD": FieldValue.increment(costUSD)
        });

        await batch.commit();
        console.log(`[PESAM 3.0 📐] Zadanie ${taskId} zakończone. Zapisano ${allExtractedItems.length} nowych pozycji.`);

        // 4. Wybudzenie Mózgu (ReAct Loop)
        const localOrigin = `http://127.0.0.1:${process.env.PORT || "3000"}`;
        console.log(`[PESAM 3.0 📐] Wybudzam Mózg lokalnie przez loopback: ${localOrigin}`);

        fetch(`${localOrigin}/api/kosztorysant/glowny-kosztorysant`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tenderId, trigger: `TASK_COMPLETED_${taskId}` })
        }).catch(e => console.error("[PESAM 3.0] Błąd wybudzania Mózgu po zadaniu wizyjnym:", e));

        return NextResponse.json({ success: true, itemsExtracted: allExtractedItems.length });

    } catch (error: any) {
        console.error("[PESAM 3.0 📐] ❌ Błąd krytyczny Agenta Wizyjnego:", error);

        // Bezpieczny raport awarii przy użyciu zmiennych lokalnych
        if (tenderId && taskId) {
            try {
                await adminDb.collection(`tenders/${tenderId}/tasks`).doc(taskId).update({
                    status: "ERROR",
                    result: { error: error.message }
                });
            } catch (dbError) {
                console.error("[PESAM 3.0 📐] Nie udało się zapisać statusu błędu:", dbError);
            }
        }

        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}