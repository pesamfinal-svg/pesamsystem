// ============================================================
// PESAM 2.0 – Inicjalizator Zadań (Dynamiczny odczyt SWZ / PFU)
// POST /api/kosztorysant/glowny-kosztorysant/inicjalizuj
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase/admin';
import { GoogleGenAI, Type } from '@google/genai';
import type { AgentPhase } from '../../_shared/scopeManifest.types';

export const dynamic = "force-dynamic";

const MODEL_FLASH = "gemini-2.5-flash";

type TaskType = AgentPhase;

interface Task {
    taskId: string;
    type: TaskType;
    status: 'PENDING' | 'IN_PROGRESS' | 'DONE' | 'ERROR';
    createdAt: string;
    order: number;
    dependsOn: string[];
    payload: Record<string, unknown>;
    result?: unknown;
    error?: string;
}

interface ClassifierOutput {
    docLevel: 0 | 1 | 2 | 3 | 4;
    estimationMethod: string;
    hasDrawings: boolean;
    hasSWZ: boolean;
    hasPFU: boolean;
    hasReinforcementDetails: boolean;
    hasGeotechnics: boolean;
    missingData: string[];
    objectTypeHint: string;
    objectAreaHint_m2: number | null; // 👈 Prawdziwa powierzchnia wyciągnięta z tekstu
}

// ================================================================
// Klasyfikator czytający rzeczywistą treść dokumentów przetargowych
// ================================================================
async function classifyDocuments(
    fileList: any[],
    documentTexts: Array<{ fileName: string; content: string }>
): Promise<ClassifierOutput> {
    console.log(`[Inicjalizator] [Klasyfikacja] Analizuję strukturę i treść dokumentów (SWZ/PFU)...`);

    const ai = new GoogleGenAI({
        vertexai: true,
        project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
        location: "global",
    });

    // Budujemy kontekst tekstowy z przesłanych plików SWZ/PFU/OPZ
    const textContext = documentTexts.length > 0
        ? documentTexts.map(t => `=== PLIK: "${t.fileName}" ===\n${t.content.slice(0, 12000)}`).join("\n\n")
        : "BRAK TREŚCI DOKUMENTÓW TEKSTOWYCH.";

    const prompt = `
Oceń poziom dokumentacji, typ budynku i jego dokładną powierzchnię na podstawie załączonych plików.

TREŚCI DOKUMENTÓW TEKSTOWYCH (SWZ/PFU/OPZ):
${textContext}

LISTA WSZYSTKICH PLIKÓW W PACZCE:
${JSON.stringify(fileList, null, 2)}

ZADANIE:
Przeanalizuj treść dokumentów i znajdź:
- objectAreaHint_m2: Dokładną powierzchnię użytkową (PUM) lub zabudowy zapisaną w tych dokumentach (np. "powierzchnia użytkowa budynku wynosi 1240 m2"). Zwróć jako liczbę. Jeśli nie ma jej w tekście, zwróć null.
- objectTypeHint: Dokładny typ budynku (przedszkole / szkoła / biurowiec / hala_sportowa / hala_produkcyjna / budynek_mieszkalny / szpital / inne).

Zwróć wynik jako czysty obiekt JSON.
    `.trim();

    const response = await ai.models.generateContent({
        model: MODEL_FLASH,
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: {
            systemInstruction: "Jesteś Głównym Analitykiem Przetargowym. Wyciągasz rzeczywiste dane liczbowe i typy z dokumentów. Odpowiadaj wyłącznie JSON-em.",
            temperature: 0.0, // Maksymalny determinizm
            responseMimeType: "application/json",
            responseSchema: {
                type: Type.OBJECT,
                properties: {
                    docLevel: { type: Type.INTEGER },
                    estimationMethod: { type: Type.STRING },
                    hasDrawings: { type: Type.BOOLEAN },
                    hasSWZ: { type: Type.BOOLEAN },
                    hasPFU: { type: Type.BOOLEAN },
                    hasReinforcementDetails: { type: Type.BOOLEAN },
                    hasGeotechnics: { type: Type.BOOLEAN },
                    missingData: { type: Type.ARRAY, items: { type: Type.STRING } },
                    objectTypeHint: { type: Type.STRING },
                    objectAreaHint_m2: { type: Type.NUMBER }, // Wyciągamy rzeczywistą wartość
                },
                required: [
                    'docLevel', 'estimationMethod', 'hasDrawings', 'hasSWZ', 'hasPFU',
                    'hasReinforcementDetails', 'hasGeotechnics', 'missingData', 'objectTypeHint', 'objectAreaHint_m2'
                ],
            },
        },
    });

    const parsed: ClassifierOutput = JSON.parse(response.text ?? "{}");

    console.log(
        `[Inicjalizator] [Klasyfikacja] Odczytano z dokumentów: ` +
        `Typ = "${parsed.objectTypeHint}", Powierzchnia = ${parsed.objectAreaHint_m2 ?? "NIEZNANA"} m².`
    );

    return parsed;
}

// ================================================================
// Budowanie kolejki zadań DAG (Progressive Estimating)
// ================================================================
function buildTaskQueue(
    tenderId: string,
    classification: ClassifierOutput,
    fileList: any[]
): Task[] {
    const now = new Date().toISOString();
    const tasks: Task[] = [];
    let order = 0;

    const swzFiles = fileList.filter(f => ['SWZ', 'PFU', 'OPZ', 'UMOWA'].includes(f.category?.toUpperCase()));
    const drawingFiles = fileList.filter(f => f.category?.toUpperCase() === 'DRAWING' || f.category?.toUpperCase() === 'RYSUNEK');
    const hasAnyFiles = fileList.length > 0;

    console.log(`[Inicjalizator] Buduję optymalny łańcuch zadań (DAG) dla przetargu: ${tenderId}...`);

    if (hasAnyFiles) {
        // [0] WBS_ARCHITECT – DNA budynku
        const wbsTaskId = `${tenderId}-WBS_ARCHITECT`;
        tasks.push({
            taskId: wbsTaskId,
            type: 'WBS_ARCHITECT',
            status: 'PENDING',
            createdAt: now,
            order: order++,
            dependsOn: [],
            payload: {
                tenderId,
                objectTypeHint: classification.objectTypeHint,
                objectAreaHint_m2: classification.objectAreaHint_m2 ?? null,
                docLevel: classification.docLevel,
                estimationMethod: classification.estimationMethod,
                fileNamesContext: fileList.map((f) => `${f.fileName} [${f.category}]`),
            },
        });
        console.log(`[Inicjalizator] [Kolejka] + Dodano [0] WBS_ARCHITECT`);

        // [1] MAPPING_DETECTIVE – dopasowanie plików
        const detectiveTaskId = `${tenderId}-MAPPING_DETECTIVE`;
        tasks.push({
            taskId: detectiveTaskId,
            type: 'MAPPING_DETECTIVE',
            status: 'PENDING',
            createdAt: now,
            order: order++,
            dependsOn: [wbsTaskId],
            payload: {
                tenderId,
                fileList: fileList.map((f) => ({
                    fileId: f.fileId,
                    fileName: f.fileName,
                    category: f.category,
                    storagePath: f.storagePath,
                })),
            },
        });
        console.log(`[Inicjalizator] [Kolejka] + Dodano [1] MAPPING_DETECTIVE`);

        // [2] QUANTITY_SURVEYOR – zamiana nazw w liczby (Vision lub Brain)
        const surveyorTaskId = `${tenderId}-QUANTITY_SURVEYOR`;
        tasks.push({
            taskId: surveyorTaskId,
            type: 'QUANTITY_SURVEYOR',
            status: 'PENDING',
            createdAt: now,
            order: order++,
            dependsOn: [detectiveTaskId],
            payload: {
                tenderId,
                hasDrawings: classification.hasDrawings,
                docLevel: classification.docLevel,
                drawingFileIds: drawingFiles.map((f) => f.fileId),
                useBrainFallback: !classification.hasDrawings || classification.docLevel <= 1,
            },
        });
        console.log(`[Inicjalizator] [Kolejka] + Dodano [2] QUANTITY_SURVEYOR`);

        // [3] SILENT_AUDITOR – ukryte pułapki technologiczne
        const auditorTaskId = `${tenderId}-SILENT_AUDITOR`;
        tasks.push({
            taskId: auditorTaskId,
            type: 'SILENT_AUDITOR',
            status: 'PENDING',
            createdAt: now,
            order: order++,
            dependsOn: [surveyorTaskId],
            payload: {
                tenderId,
                objectTypeHint: classification.objectTypeHint,
                hasGeotechnics: classification.hasGeotechnics,
                hasSWZ: classification.hasSWZ,
                missingDataReport: classification.missingData,
            },
        });
        console.log(`[Inicjalizator] [Kolejka] + Dodano [3] SILENT_AUDITOR`);

    } else {
        // FALLBACK: Brak plików → stary ANALITYK_ZAKRESU
        console.log(`[Inicjalizator] [Kolejka] ⚠️ Brak plików wejściowych. Uruchamiam tryb awaryjny.`);
        const analitykTaskId = `${tenderId}-ANALITYK_ZAKRESU`;
        tasks.push({
            taskId: analitykTaskId,
            type: 'ANALITYK_ZAKRESU',
            status: 'PENDING',
            createdAt: now,
            order: order++,
            dependsOn: [],
            payload: {
                tenderId,
                docLevel: classification.docLevel,
                estimationMethod: classification.estimationMethod,
                sourceDocuments: fileList.map((f) => f.fileName),
                swzFileIds: swzFiles.map((f) => f.fileId),
            },
        });
    }

    const lastCoreTaskId = tasks[tasks.length - 1].taskId;

    // [4] LEGAL – Analiza prawna umowy i SWZ
    if (classification.hasSWZ || swzFiles.length > 0) {
        tasks.push({
            taskId: `${tenderId}-LEGAL`,
            type: 'LEGAL',
            status: 'PENDING',
            createdAt: now,
            order: order++,
            dependsOn: [tasks[0].taskId],
            payload: { tenderId, fileIds: swzFiles.map((f) => f.fileId) },
        });
    }

    // [5] BROKER – Wycena rynkowa (Zawsze)
    const brokerTaskId = `${tenderId}-BROKER`;
    tasks.push({
        taskId: brokerTaskId,
        type: 'BROKER',
        status: 'PENDING',
        createdAt: now,
        order: order++,
        dependsOn: [lastCoreTaskId],
        payload: { tenderId },
    });

    // [6] GAP_FILLER – Łatanie luk (Zawsze przed rewidentem)
    const gapFillerTaskId = `${tenderId}-GAP_FILLER`;
    tasks.push({
        taskId: gapFillerTaskId,
        type: 'GAP_FILLER',
        status: 'PENDING',
        createdAt: now,
        order: order++,
        dependsOn: [brokerTaskId],
        payload: { tenderId, note: 'Łatanie brakujących pozycji kosztorysowych' },
    });

    // [7] REWIDENT – Końcowy audyt (Zawsze ostatni)
    tasks.push({
        taskId: `${tenderId}-REWIDENT`,
        type: 'REWIDENT',
        status: 'PENDING',
        createdAt: now,
        order: order++,
        dependsOn: [gapFillerTaskId],
        payload: { tenderId },
    });

    return tasks;
}

// ================================================================
// GŁÓWNY HANDLER POST
// ================================================================
export async function POST(req: NextRequest) {
    const startTime = Date.now();
    console.log("==================================================");
    console.log("[Inicjalizator] === PESAM 2.1 – PROGRESSIVE ESTIMATING DAG ===");
    console.log("==================================================");

    try {
        const { tenderId, fileList } = await req.json() as {
            tenderId: string;
            fileList: any[];
        };

        if (!tenderId) return NextResponse.json({ error: 'Brak tenderId' }, { status: 400 });

        const safeFileList = fileList ?? [];

        // Pobieramy rzeczywistą treść dokumentacji tekstowej (SWZ/PFU) z Firestore
        console.log(`[Inicjalizator] Wyciągam treść dokumentów z Firestore w celu dynamicznej klasyfikacji...`);
        const filesSnap = await adminDb.collection(`tenders/${tenderId}/files`).get();
        const documentTexts: Array<{ fileName: string; content: string }> = [];

        for (const doc of filesSnap.docs) {
            const data = doc.data();
            const cat = data.category?.toUpperCase() || "";
            if (['SWZ', 'PFU', 'OPZ', 'UMOWA'].includes(cat) && data.extractedText) {
                console.log(`[Inicjalizator] Pobrano tekst z pliku: "${data.fileName}"`);
                documentTexts.push({
                    fileName: data.fileName,
                    content: data.extractedText
                });
            }
        }

        // 1. Klasyfikacja na podstawie rzeczywistych tekstów z dokumentów
        const classification = await classifyDocuments(safeFileList, documentTexts);

        // 2. Budowanie dynamicznej kolejki DAG
        const tasks = buildTaskQueue(tenderId, classification, safeFileList);

        // 3. Zapis Firestore Batch
        const batch = adminDb.batch();
        for (const task of tasks) {
            const ref = adminDb.collection(`tenders/${tenderId}/tasks`).doc(task.taskId);
            batch.set(ref, task);
        }

        // 4. Aktualizacja rekordu głównego
        batch.update(adminDb.doc(`tenders/${tenderId}`), {
            status: 'INITIALIZED',
            docLevel: classification.docLevel,
            estimationMethod: classification.estimationMethod,
            objectTypeHint: classification.objectTypeHint,
            objectAreaHint_m2: classification.objectAreaHint_m2 ?? null,
            missingDataReport: classification.missingData,
            tasksCount: tasks.length,
            tasksOrder: tasks.map(t => ({ taskId: t.taskId, type: t.type, order: t.order, dependsOn: t.dependsOn })),
            updatedAt: new Date().toISOString(),
        });

        await batch.commit();

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`[Inicjalizator] ✅ Sukces: Rój zainicjowany w ${duration} sek.`);
        console.log("==================================================");

        return NextResponse.json({
            success: true,
            tenderId,
            docLevel: classification.docLevel,
            estimationMethod: classification.estimationMethod,
            objectTypeHint: classification.objectTypeHint,
            objectAreaHint_m2: classification.objectAreaHint_m2,
            tasksQueue: tasks.map(t => ({ taskId: t.taskId, type: t.type, status: t.status, dependsOn: t.dependsOn }))
        });

    } catch (error: any) {
        console.error('[Inicjalizator] ❌ KRYTYCZNY BŁĄD PODCZAS ZAPŁONU ROJU:', error.message);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}