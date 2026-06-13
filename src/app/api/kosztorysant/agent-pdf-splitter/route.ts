import { NextResponse } from "next/server";
import { adminDb, adminStorage } from "@/lib/firebase/admin";
import { FieldValue } from "firebase-admin/firestore";
import { GoogleGenAI } from "@google/genai";
import { jsonrepair } from "jsonrepair";
import dns from "dns";
dns.setDefaultResultOrder("ipv4first");

export const dynamic = "force-dynamic";

// Używamy modelu Flash-Lite: jest niesamowicie tani, szybki i doskonale radzi sobie z mapowaniem struktury dokumentów
const MODEL_LITE = "gemini-2.5-flash-lite";

const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
    location: "global"
});

async function callGeminiWithRetry(fn: () => Promise<any>, retries = 5, delay = 4000): Promise<any> {
    try {
        return await fn();
    } catch (error: any) {
        const errorText = error.toString() || "";
        const isRateLimit = errorText.includes("429") || errorText.includes("RESOURCE_EXHAUSTED");
        if (isRateLimit && retries > 0) {
            console.warn(`[PDF SPLITTER ✂️] Limit 429. Czekam ${delay / 1000}s... (Pozostało prób: ${retries})`);
            await new Promise(resolve => setTimeout(resolve, delay));
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

        console.log(`[PDF SPLITTER ✂️] Rozpoczynam mapowanie logiczne dokumentów. Przetarg: ${tenderId} | Zadanie: ${taskId}`);

        if (!tenderId || !taskId) {
            return NextResponse.json({ error: "Brak parametrów" }, { status: 400 });
        }

        const taskRef = adminDb.collection(`tenders/${tenderId}/tasks`).doc(taskId);
        const taskDoc = await taskRef.get();
        if (!taskDoc.exists) throw new Error("Zadanie nie istnieje.");

        const taskData = taskDoc.data()!;
        if (taskData.status !== "PENDING") {
            return NextResponse.json({ message: "Zadanie zostało już obsłużone." });
        }

        await taskRef.update({ status: "IN_PROGRESS", updatedAt: new Date() });

        const inputDocIds: string[] = taskData.inputDocIds || [];
        if (inputDocIds.length === 0) {
            await taskRef.update({
                status: "DONE",
                rawResult: { message: "Brak dokumentów wskazanych do podziału.", segments: [] },
                processedByBrain: false,
                updatedAt: new Date()
            });
            isSuccess = true;
            return NextResponse.json({ message: "Brak dokumentów." });
        }

        const bucketName = process.env.STORAGE_BUCKET || "pesam-system-81165.firebasestorage.app";
        let totalTokensUsed = 0;
        const allSegments: any[] = [];

        // Przetwarzamy każdy przypisany dokument
        for (const docId of inputDocIds) {
            const docSnap = await adminDb
                .collection(`tenders/${tenderId}/documents`)
                .doc(docId)
                .get();

            if (!docSnap.exists) {
                console.warn(`[PDF SPLITTER ✂️] Dokument o ID ${docId} nie istnieje w bazie. Pomijam.`);
                continue;
            }

            const docData = docSnap.data()!;
            console.log(`[PDF SPLITTER ✂️] ── Skanuję strukturę logiczną: "${docData.fileName}"`);

            // Ścieżka bezpośrednia do Google Cloud Storage
            const fileUri = `gs://${bucketName}/${docData.storagePath}`;

            const scanPrompt = `
Jesteś Kognitywnym Skanerem Struktury Dokumentów Budowlanych (PESAM 3.0, Faza 0.5).
Twoim jedynym zadaniem jest zmapowanie LOGICZNYCH GRANIC tego dokumentu PDF.

=== INSTRUKCJA OD MÓZGU ===
${taskData.instruction}

=== KONTEKST ===
Plik: ${docData.fileName}
Znane fakty projektu: ${JSON.stringify(taskData.inputFacts || {}).substring(0, 1000)}

=== TWOJE ZADANIE ===
Przejrzyj spis treści, nagłówki rysunków, tabelki rysunkowe i ogólną strukturę tego dokumentu.
Zidentyfikuj wszystkie LOGICZNE SEKCJE – czyli grupy stron, które absolutnie NIE MOGĄ być rozerwane
(np. rysunek zbrojenia płyty fundamentowej + jego legenda + zestawienie stali to jedna nierozrywalna jednostka).

Zwróć WYŁĄCZNIE czysty obiekt JSON (bez znaczników markdown) z tablicą segmentów.
Każdy segment to obiekt o strukturze:
- "segmentId": STRING – unikalny identyfikator, np. "seg_01"
- "label": STRING – krótka, czytelna nazwa sekcji, np. "Zbrojenie płyty fundamentowej"
- "pageFrom": NUMBER – pierwsza strona tej sekcji (indeksowana od 1)
- "pageTo": NUMBER – ostatnia strona tej sekcji (indeksowana od 1, włącznie)
- "elementType": STRING – typ elementu: "RYSUNEK_ZBROJENIA" | "ZESTAWIENIE_STALI" | "OPIS_TECHNICZNY" | "PRZEDMIAR" | "SWZ" | "UMOWA" | "INNY"
- "recommendedAgent": STRING – sugerowane narzędzie do obróbki: "VISION" | "BOQ_PARSER" | "LEGAL_EXPERT" | "KAMELEON"
- "priority": NUMBER – priorytet ekonomiczny 1-100 (100 = największy wpływ na kosztorys, np. zbrojenie płyty, fundamenty; 5 = mało ważny detal)
- "canSplitFurther": BOOLEAN – czy tę sekcję można bezpiecznie podzielić na mniejsze kawałki
- "notes": STRING – ważne uwagi i instrukcje dla agenta, który otrzyma ten segment

Zasady krytyczne:
- Rysunek techniczny + jego legenda + powiązana tabela stali = JEDEN wspólny segment
- Nigdy nie rozdzielaj tabeli przedmiarowej, która przechodzi płynnie między stronami
- Spis treści i strona tytułowa = osobny segment o niskim priorytecie
- Jeśli nie potrafisz wyznaczyć precyzyjnych granic – zwróć jeden segment obejmujący cały dokument
`;

            const scanResult = await callGeminiWithRetry(() =>
                ai.models.generateContent({
                    model: MODEL_LITE,
                    contents: [
                        {
                            role: "user",
                            parts: [
                                { text: scanPrompt },
                                {
                                    fileData: {
                                        fileUri,
                                        mimeType: docData.mimeType || "application/pdf"
                                    }
                                }
                            ]
                        }
                    ],
                    config: {
                        temperature: 0.05,
                        responseMimeType: "application/json"
                    }
                })
            );

            totalTokensUsed += scanResult.usageMetadata?.totalTokenCount || 0;

            let segments: any[] = [];
            try {
                const parsed = JSON.parse(jsonrepair(scanResult.text ?? "{}"));
                segments = Array.isArray(parsed)
                    ? parsed
                    : (parsed.segments || parsed.items || [parsed]);
            } catch (parseErr) {
                console.error(`[PDF SPLITTER ✂️] Błąd parsowania mapy logicznej dla "${docData.fileName}". Tworzę awaryjny segment dla całego pliku.`);
                segments = [{
                    segmentId: `seg_fallback_${docId}`,
                    label: docData.fileName,
                    pageFrom: 1,
                    pageTo: 9999,
                    elementType: "INNY",
                    recommendedAgent: docData.containsDrawings ? "VISION" : "BOQ_PARSER",
                    priority: 50,
                    canSplitFurther: false,
                    notes: "Błąd parsowania mapy – wycofano do pełnego dokumentu."
                }];
            }

            console.log(`[PDF SPLITTER ✂️] Zmapowano ${segments.length} logicznych sekcji w "${docData.fileName}".`);

            // Wzbogacenie każdego segmentu o ścieżki i instrukcje dla Mózgu
            const enrichedSegments = segments.map((seg: any) => ({
                ...seg,
                sourceDocId: docId,
                sourceFileName: docData.fileName,
                storagePath: docData.storagePath,
                mimeType: docData.mimeType || "application/pdf",
                fileUri: `gs://${bucketName}/${docData.storagePath}`,
                agentInstruction: `Przetwórz WYŁĄCZNIE strony ${seg.pageFrom}-${seg.pageTo} dokumentu "${docData.fileName}". 
Zakres sekcji: "${seg.label}". 
${seg.notes ? `Uwagi: ${seg.notes}` : ""}
Oryginalna wytyczna: ${taskData.instruction}`
            }));

            allSegments.push(...enrichedSegments);

            // Zapisanie wyliczonej mapy segmentów bezpośrednio do metadanych dokumentu w Firestore
            await docSnap.ref.update({
                logicalSegments: enrichedSegments,
                segmentsMappedAt: new Date(),
                segmentsCount: enrichedSegments.length
            });
        }

        // Sortowanie segmentów po priorytecie ekonomicznym (od najważniejszych do wyceny)
        allSegments.sort((a, b) => (b.priority || 0) - (a.priority || 0));

        console.log(`[PDF SPLITTER ✂️] Proces orzekania zakończony. Łączna liczba wygenerowanych segmentów: ${allSegments.length}.`);
        allSegments.forEach((s, i) =>
            console.log(`[PDF SPLITTER ✂️]   [${i + 1}] "${s.label}" (str. ${s.pageFrom}-${s.pageTo}) → Agent: ${s.recommendedAgent} | Priorytet: ${s.priority}`)
        );

        // Zapis wyniku zadania w Firestore dla Mózgu
        await taskRef.update({
            status: "DONE",
            rawResult: {
                segments: allSegments,
                summary: `Zmapowano pomyślnie ${allSegments.length} logicznych segmentów. Mózg może teraz precyzyjnie delegować zadania na określone przedziały stron.`,
                byAgent: {
                    VISION: allSegments.filter(s => s.recommendedAgent === "VISION").map(s => s.segmentId),
                    BOQ_PARSER: allSegments.filter(s => s.recommendedAgent === "BOQ_PARSER").map(s => s.segmentId),
                    LEGAL_EXPERT: allSegments.filter(s => s.recommendedAgent === "LEGAL_EXPERT").map(s => s.segmentId),
                    KAMELEON: allSegments.filter(s => s.recommendedAgent === "KAMELEON").map(s => s.segmentId)
                }
            },
            processedByBrain: false,
            costTokens: totalTokensUsed,
            updatedAt: new Date()
        });

        // Flash-Lite jest bardzo tani (koszt: 0.0000375 $ za 1k input tokenów)
        const costUSD = (totalTokensUsed / 1000) * 0.0000375;
        await adminDb.collection("tenders").doc(tenderId).update({
            "budgetGuard.currentCostUSD": FieldValue.increment(costUSD)
        });

        isSuccess = true;
        return NextResponse.json({
            success: true,
            segmentsCount: allSegments.length,
            documentsProcessed: inputDocIds.length
        });

    } catch (error: any) {
        console.error("[PDF SPLITTER ✂️] ❌ Krytyczny błąd podczas pracy splittera:", error);
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
            const localOrigin = `http://localhost:${process.env.PORT || "3000"}`;
            fetch(`${localOrigin}/api/kosztorysant/glowny-kosztorysant`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    tenderId,
                    trigger: isSuccess ? `TASK_COMPLETED_${taskId}` : `TASK_FAILED_${taskId}`
                })
            }).catch(() => { });
        }
    }
}