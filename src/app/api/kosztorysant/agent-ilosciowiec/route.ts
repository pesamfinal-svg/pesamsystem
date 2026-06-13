import { NextResponse } from "next/server";
import { adminDb, adminStorage } from "@/lib/firebase/admin";
import { FieldValue } from "firebase-admin/firestore";
import { Agent, setGlobalDispatcher } from "undici";

// Zwiększenie limitu oczekiwania na odpowiedź z API Gemini do 5 minut (300 000 ms)
setGlobalDispatcher(new Agent({ headersTimeout: 300000, bodyTimeout: 300000 }));
import { GoogleGenAI, Type } from "@google/genai";
import { jsonrepair } from "jsonrepair";
import * as xlsx from "xlsx";

export const dynamic = "force-dynamic";

const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
    location: "global"
});

const MODEL_PRO = "gemini-2.5-pro";
const MODEL_FLASH = "gemini-2.5-flash";

// ─────────────────────────────────────────────────────────────────
// TYPY — extractionProfile jest teraz w pełni dynamiczny
// ─────────────────────────────────────────────────────────────────

type FieldType = "STRING" | "NUMBER" | "BOOLEAN";

interface CustomField {
    name: string;          // nazwa właściwości w JSON, np. "srednicaMm"
    type: FieldType;       // typ danych
    description: string;    // opis dla Gemini, co tu wpisać
}

interface ExtractionProfile {
    contextLabel: string;        // dowolna etykieta od Mózgu, np. "RYSUNEK_ZBROJENIA"
    modelHint: "PRO" | "FLASH";  // rekomendacja modelu od Mózgu
    customFields: CustomField[]; // pola, które Mózg chce dynamicznie wyciągnąć
}

// ─────────────────────────────────────────────────────────────────
// BEZPIECZNY RETRY DLA ODPORNOŚCI NA LIMIT 429
// ─────────────────────────────────────────────────────────────────

async function callGeminiWithRetry(
    fn: () => Promise<any>,
    retries = 3,
    delay = 3000
): Promise<any> {
    try {
        return await fn();
    } catch (error: any) {
        const isRateLimit =
            error.toString().includes("429") ||
            error.toString().includes("RESOURCE_EXHAUSTED");
        if (isRateLimit && retries > 0) {
            console.warn(
                `[ILOŚCIOWIEC 📊] Wykryto limit API 429. Odczekuję ${delay / 1000}s... (Pozostało prób: ${retries})`
            );
            await new Promise((r) => setTimeout(r, delay));
            return callGeminiWithRetry(fn, retries - 1, delay * 2);
        }
        throw error;
    }
}

// ─────────────────────────────────────────────────────────────────
// BAZOWE POLA — zawsze obecne w kosztorysie, niezależnie od Mózgu
// ─────────────────────────────────────────────────────────────────

const BASE_ITEM_PROPERTIES = {
    pozycja: { type: Type.STRING, description: "Numer referencyjny pozycji kosztorysowej, np. '1.1', '2.3.1'" },
    opis: { type: Type.STRING, description: "Dokładny opis roboty budowlanej, elementu lub urządzenia." },
    ilosc: { type: Type.NUMBER, description: "Ilość / wartość przedmiarowa" },
    jednostka: { type: Type.STRING, description: "Jednostka miary, np. szt., mb, m2, m3, kg, t, r-godz" },
    KNR_ref: { type: Type.STRING, description: "Referencja do katalogu norm, np. KNR 2-01, jeśli widoczna w dokumencie" }
};

const BASE_REQUIRED = ["pozycja", "opis", "ilosc", "jednostka"];

const TYPE_MAP: Record<FieldType, any> = {
    STRING: Type.STRING,
    NUMBER: Type.NUMBER,
    BOOLEAN: Type.BOOLEAN
};

// ─────────────────────────────────────────────────────────────────
// BUDOWANIE DYNAMICZNEGO SCHEMATU W LOCIE (RUNTIME SCHEMA SYNTHESIS)
// ─────────────────────────────────────────────────────────────────

function buildDynamicSchema(customFields: CustomField[]): any {
    const itemProperties: Record<string, any> = { ...BASE_ITEM_PROPERTIES };

    for (const field of customFields) {
        if (!field?.name || typeof field.name !== "string") continue;
        const safeName = field.name.trim();

        // Zabezpieczenie: walidacja poprawności nazwy zmiennej dla schematu JSON
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(safeName)) {
            console.warn(`[ILOŚCIOWIEC 📊] Ignoruję niepoprawną nazwę pola: "${safeName}"`);
            continue;
        }
        // Zabezpieczenie: nie pozwalamy Mózgowi nadpisać pól bazowych
        if (safeName in BASE_ITEM_PROPERTIES) {
            console.warn(`[ILOŚCIOWIEC 📊] Ignoruję próbę nadpisania pola bazowego: "${safeName}"`);
            continue;
        }

        itemProperties[safeName] = {
            type: TYPE_MAP[field.type.toUpperCase() as FieldType] || Type.STRING,
            description: field.description || `Dynamiczne pole: ${safeName}`
        };
    }

    return {
        type: Type.OBJECT,
        properties: {
            items: {
                type: Type.ARRAY,
                description: "Lista wyizolowanych pozycji/elementów kosztorysowych wyciągniętych z dokumentu",
                items: {
                    type: Type.OBJECT,
                    properties: itemProperties,
                    required: BASE_REQUIRED
                }
            },
            summary: {
                type: Type.STRING,
                description: "Krótkie podsumowanie przeanalizowanego dokumentu."
            }
        },
        required: ["items", "summary"]
    };
}

// ─────────────────────────────────────────────────────────────────
// BUDOWANIE DYNAMICZNEGO PROMPTU WEJŚCIOWEGO
// ─────────────────────────────────────────────────────────────────

function buildExtractionPrompt(
    profile: ExtractionProfile,
    baseInstruction: string,
    isExcel: boolean
): string {
    const { contextLabel, customFields } = profile;

    const fieldsList = customFields.length > 0
        ? `\nZidentyfikuj i wyciągnij następujące pola specyficzne dla kontekstu [${contextLabel}]:\n` +
        customFields.map((f) => `  - ${f.name} (${f.type}): ${f.description}`).join("\n") + "\n"
        : "";

    const excelNote = isExcel
        ? "\nUWAGA: Dane wejściowe to surowy JSON z arkusza Excel. Ignoruj puste wiersze, nagłówki i metadane dokumentu."
        : "";

    return `=== KONTRAKT DYNAMICZNEJ EKSTRAKCJI DANYCH (PESAM 3.0) ===
Etykieta kontekstowa zadania: ${contextLabel}
${fieldsList}
Szczegółowa instrukcja od Mózgu: ${baseInstruction}
${excelNote}

ZASADY KRYTYCZNE:
- Zwróć TYLKO te dane, które faktycznie widzisz w dokumencie. Nie zgaduj wartości.
- Jeśli jakiegoś opcjonalnego pola nie ma dla danej pozycji — pomiń je w strukturze (nie halucynuj).
- Jeśli dokument nie zawiera żadnych danych zgodnych z instrukcją — zwróć pustą tablicę "items".
- Zachowaj polskie znaki diakrytyczne. Numeruj pozycje hierarchicznie np. 1.1, 1.2, 2.1.`;
}

// ─────────────────────────────────────────────────────────────────
// MODEL RESOLVER (KORZYSTA Z SUGEROWANEGO PROFILU)
// ─────────────────────────────────────────────────────────────────

function resolveModel(
    profile: ExtractionProfile,
    taskModelOverride?: string
): string {
    if (taskModelOverride) return taskModelOverride;
    if (profile.modelHint === "PRO") return MODEL_PRO;
    if (profile.modelHint === "FLASH") return MODEL_FLASH;
    return MODEL_PRO; // Bezpieczny fallback
}

// ─────────────────────────────────────────────────────────────────
// POST HANDLER (GŁÓWNY PUNKT WEJŚCIA)
// ─────────────────────────────────────────────────────────────────

export async function POST(req: Request) {
    let tenderId: string | undefined;
    let taskId: string | undefined;
    let isSuccess = false;

    try {
        const body = await req.json();
        tenderId = body.tenderId;
        taskId = body.taskId;

        console.log(`[ILOŚCIOWIEC 📊] Start procesu. Przetarg: ${tenderId} | Zadanie: ${taskId}`);

        if (!tenderId || !taskId) {
            return NextResponse.json({ error: "Brak parametrów" }, { status: 400 });
        }

        const taskRef = adminDb.collection(`tenders/${tenderId}/tasks`).doc(taskId);
        const taskDoc = await taskRef.get();
        if (!taskDoc.exists) throw new Error("Zadanie nie istnieje w bazie.");

        const taskData = taskDoc.data()!;
        if (taskData.status !== "PENDING") {
            return NextResponse.json({ message: "Zadanie zostało już przetworzone." });
        }

        // Zmiana statusu na roboczy
        await taskRef.update({ status: "IN_PROGRESS", updatedAt: new Date() });

        // Odczyt profilu ekstrakcji przesłanego przez Mózg
        const rawProfile = taskData.extractionProfile;
        const profile: ExtractionProfile = {
            contextLabel: rawProfile?.contextLabel || "NIEOKREŚLONY",
            modelHint: rawProfile?.modelHint === "FLASH" ? "FLASH" : "PRO",
            customFields: Array.isArray(rawProfile?.customFields) ? rawProfile.customFields : []
        };

        console.log(`[ILOŚCIOWIEC 📊] [LOG] Otrzymano profil ekstrakcji:`);
        console.log(`[ILOŚCIOWIEC 📊]   - Kontekst: ${profile.contextLabel}`);
        console.log(`[ILOŚCIOWIEC 📊]   - Sugerowany model: ${profile.modelHint}`);
        console.log(`[ILOŚCIOWIEC 📊]   - Dynamiczne pola (${profile.customFields.length} szt.): ${profile.customFields.map(f => f.name).join(", ") || "(brak)"}`);

        const inputDocIds: string[] = taskData.inputDocIds || [];
        if (inputDocIds.length === 0) {
            console.warn("[ILOŚCIOWIEC 📊] Brak dokumentów przypisanych do zadania. Kończę ze statusem DONE.");
            await taskRef.update({
                status: "DONE",
                rawResult: { message: "Brak dokumentów wejściowych." },
                processedByBrain: false,
                updatedAt: new Date()
            });
            isSuccess = true;
            return NextResponse.json({ message: "Brak dokumentów." });
        }

        // SYNTEZA SCHEMATU W RUNTIME (Kluczowy element architektury kognitywnej)
        const dynamicSchema = buildDynamicSchema(profile.customFields);
        console.log(`[ILOŚCIOWIEC 📊] [LOG] Dynamiczny schemat wyjściowy skompilowany pomyślnie.`);

        const bucketName = process.env.STORAGE_BUCKET || "pesam-system-81165.firebasestorage.app";
        const bucket = adminStorage.bucket(bucketName);
        const allExtractedItems: any[] = [];
        let totalTokensUsed = 0;
        const processingLog: string[] = [];

        // Przetwarzanie plików
        for (let idx = 0; idx < inputDocIds.length; idx++) {
            const docId = inputDocIds[idx];
            const docSnap = await adminDb.collection(`tenders/${tenderId}/documents`).doc(docId).get();

            if (!docSnap.exists) {
                console.warn(`[ILOŚCIOWIEC 📊] Dokument ${docId} nie istnieje w bazie. Pomijam.`);
                continue;
            }

            const docData = docSnap.data()!;
            const sizeMB = (docData.sizeBytes / 1024 / 1024).toFixed(2);
            const isExcel =
                docData.mimeType?.includes("excel") ||
                docData.mimeType?.includes("spreadsheetml") ||
                docData.fileName.toLowerCase().endsWith(".xlsx") ||
                docData.fileName.toLowerCase().endsWith(".xls");

            console.log(`[ILOŚCIOWIEC 📊] Skanuję plik [${idx + 1}/${inputDocIds.length}]: "${docData.fileName}" (${sizeMB} MB)`);

            // Excel jest parsowany natywnie w Node, więc zawsze używamy tańszego i szybszego Flasha
            const modelToUse = isExcel ? MODEL_FLASH : resolveModel(profile, taskData.modelOverride);
            const prompt = buildExtractionPrompt(profile, taskData.instruction, isExcel);

            try {
                if (isExcel) {
                    // ── ŚCIEŻKA NATYWNA DLA EXCELA ─────────────────────────────
                    const fileRef = bucket.file(docData.storagePath);
                    const [downloadedBuffer] = await fileRef.download();
                    const safeBuffer = Buffer.from(new Uint8Array(downloadedBuffer).buffer);

                    const workbook = xlsx.read(safeBuffer, { type: "buffer" });
                    const sheetName = workbook.SheetNames[0];
                    const rawJsonText = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1 });

                    const fullPrompt = `${prompt}\n\nSurowe dane z Excela (JSON):\n${JSON.stringify(rawJsonText).substring(0, 30000)}`;

                    const result = await callGeminiWithRetry(() =>
                        ai.models.generateContent({
                            model: MODEL_FLASH,
                            contents: fullPrompt,
                            config: {
                                temperature: 0.1,
                                responseMimeType: "application/json",
                                responseSchema: dynamicSchema
                            }
                        })
                    );

                    let parsed: any = {};
                    try { parsed = JSON.parse(jsonrepair(result.text ?? "{}")); }
                    catch (e) { console.error("Błąd parsowania:", e); }
                    totalTokensUsed += result.usageMetadata?.totalTokenCount || 0;
                    if (parsed.items) allExtractedItems.push(...parsed.items);
                    processingLog.push(`✅ Excel "${docData.fileName}": wyciągnięto ${parsed.items?.length || 0} pozycji (model: ${MODEL_FLASH})`);

                } else {
                    // ── BEZSERWEROWA ŚCIEŻKA GCS DLA PDF / WIZJI ───────────────
                    const fileUri = `gs://${bucketName}/${docData.storagePath}`;

                    const result = await callGeminiWithRetry(() =>
                        ai.models.generateContent({
                            model: modelToUse,
                            contents: [
                                {
                                    role: "user",
                                    parts: [
                                        { text: prompt },
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
                                temperature: 0.1,
                                responseMimeType: "application/json",
                                responseSchema: dynamicSchema
                            }
                        })
                    );

                    let parsed: any = {};
                    try { parsed = JSON.parse(jsonrepair(result.text ?? "{}")); }
                    catch (e) { console.error("Błąd parsowania:", e); }
                    totalTokensUsed += result.usageMetadata?.totalTokenCount || 0;
                    if (parsed.items) allExtractedItems.push(...parsed.items);
                    processingLog.push(`✅ PDF "${docData.fileName}": wyciągnięto ${parsed.items?.length || 0} pozycji (model: ${modelToUse})`);
                }

            } catch (err: any) {
                console.error(`[ILOŚCIOWIEC 📊] ❌ Błąd krytyczny podczas skanowania pliku "${docData.fileName}":`, err.message);
                processingLog.push(`❌ "${docData.fileName}": ${err.message}`);
                throw err;
            }
        }

        // Zapis zaimplementowanych, w pełni dynamicznych wyników do Firestore
        await taskRef.update({
            status: "DONE",
            rawResult: {
                items: allExtractedItems,
                summary: `Pomyślnie zakończono ekstrakcję. Wyodrębniono ${allExtractedItems.length} pozycji kosztorysowych w kontekście [${profile.contextLabel}].`,
                processingLog,
                contextLabel: profile.contextLabel,
                fieldsRequested: profile.customFields.map(f => f.name)
            },
            processedByBrain: false,
            costTokens: totalTokensUsed,
            updatedAt: new Date()
        });

        // Koszt tokenów (0.002 $ za 1k dla Pro i 0.000075 $ za 1k dla Flash-Lite/Flash)
        const costUSD = (totalTokensUsed / 1000) * 0.002;
        await adminDb.collection("tenders").doc(tenderId).update({
            "budgetGuard.currentCostUSD": FieldValue.increment(costUSD)
        });

        isSuccess = true;
        console.log(`[ILOŚCIOWIEC 📊] Sukces. Zapisano ${allExtractedItems.length} pozycji.`);
        processingLog.forEach(logLine => console.log(`[ILOŚCIOWIEC 📊]   ${logLine}`));

        return NextResponse.json({
            success: true,
            itemsExtracted: allExtractedItems.length,
            contextLabel: profile.contextLabel,
            customFieldsUsed: profile.customFields.map(f => f.name)
        });

    } catch (error: any) {
        console.error("[ILOŚCIOWIEC 📊] ❌ Błąd krytyczny Agenta:", error);
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