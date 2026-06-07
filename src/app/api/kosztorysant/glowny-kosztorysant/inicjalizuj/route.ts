// ============================================================
// PESAM 2.1 – Inicjalizator Zadań (Nowy Równoległy DAG)
// POST /api/kosztorysant/glowny-kosztorysant/inicjalizuj
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase/admin';
import { GoogleGenAI, Type } from '@google/genai';
import type { AgentPhase } from '../../_shared/scopeManifest.types';

export const dynamic = "force-dynamic";

const MODEL_FLASH = "gemini-2.5-flash";

type TaskType = AgentPhase | 'ANALITYK_ZAKRESU';

interface Task {
    taskId: string;
    type: TaskType;
    status: 'PENDING' | 'IN_PROGRESS' | 'DONE' | 'ERROR';
    createdAt: string;
    order: number;
    dependsOn: string[];
    payload: Record<string, unknown>;
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
    objectAreaHint_m2: number | null;
}

async function classifyDocuments(
    fileList: any[],
    documentTexts: Array<{ fileName: string; content: string }>
): Promise<ClassifierOutput> {
    console.log(`[Inicjalizator] [Klasyfikacja] Analizuję strukturę i treść dokumentów...`);

    const ai = new GoogleGenAI({
        vertexai: true,
        project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
        location: "global",
    });

    const textContext = documentTexts.length > 0
        ? documentTexts.map(t => `=== PLIK: "${t.fileName}" ===\n${t.content.slice(0, 12000)}`).join("\n\n")
        : "BRAK TREŚCI DOKUMENTÓW TEKSTOWYCH.";

    const prompt = `
Oceń poziom dokumentacji, typ budynku i jego dokładną powierzchnię na podstawie załączonych plików.

TREŚCI DOKUMENTÓW TEKSTOWYCH:
${textContext}

LISTA WSZYSTKICH PLIKÓW:
${JSON.stringify(fileList, null, 2)}

ZADANIE:
Znajdź:
- objectAreaHint_m2: Dokładną powierzchnię użytkową lub zabudowy z dokumentów. Zwróć jako liczbę. Jeśli brak, zwróć null.
- objectTypeHint: Typ budynku (przedszkole / szkola / biurowiec / hala_sportowa / hala_produkcyjna / budynek_mieszkalny / szpital / inne).

Zwróć wynik jako czysty obiekt JSON.
    `.trim();

    const response = await ai.models.generateContent({
        model: MODEL_FLASH,
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: {
            systemInstruction: "Jesteś Głównym Analitykiem Przetargowym. Odpowiadaj wyłącznie JSON-em.",
            temperature: 0.0,
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
                    objectAreaHint_m2: { type: Type.NUMBER },
                },
                required: [
                    'docLevel', 'estimationMethod', 'hasDrawings', 'hasSWZ', 'hasPFU',
                    'hasReinforcementDetails', 'hasGeotechnics', 'missingData', 'objectTypeHint', 'objectAreaHint_m2'
                ],
            },
        },
    });

    return JSON.parse(response.text ?? "{}");
}

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

    // FAZA 0: WBS i LEGAL (Niezależne, startują od razu)
    const wbsTaskId = `${tenderId}-WBS_ARCHITECT`;
    tasks.push({
        taskId: wbsTaskId,
        type: 'WBS_ARCHITECT',
        status: 'PENDING',
        createdAt: now,
        order: order++,
        dependsOn: [], // Brak zależności
        payload: {
            tenderId,
            objectTypeHint: classification.objectTypeHint,
            objectAreaHint_m2: classification.objectAreaHint_m2 ?? null,
            docLevel: classification.docLevel,
            estimationMethod: classification.estimationMethod,
            fileNamesContext: fileList.map((f) => `${f.fileName} [${f.category}]`),
        },
    });

    let legalTaskId: string | null = null;
    if (classification.hasSWZ || swzFiles.length > 0) {
        legalTaskId = `${tenderId}-LEGAL`;
        tasks.push({
            taskId: legalTaskId,
            type: 'LEGAL',
            status: 'PENDING',
            createdAt: now,
            order: order++,
            dependsOn: [], // Brak zależności
            payload: { tenderId, fileIds: swzFiles.map((f) => f.fileId) },
        });
    }

    // FAZA 1: Detektyw
    const detectiveTaskId = `${tenderId}-MAPPING_DETECTIVE`;
    tasks.push({
        taskId: detectiveTaskId,
        type: 'MAPPING_DETECTIVE',
        status: 'PENDING',
        createdAt: now,
        order: order++,
        dependsOn: [wbsTaskId], // Czeka na WBS
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

    // FAZA 2: Ilościowiec
    const surveyorTaskId = `${tenderId}-QUANTITY_SURVEYOR`;
    tasks.push({
        taskId: surveyorTaskId,
        type: 'QUANTITY_SURVEYOR',
        status: 'PENDING',
        createdAt: now,
        order: order++,
        dependsOn: [detectiveTaskId], // Czeka na Detektywa
        payload: {
            tenderId,
            hasDrawings: classification.hasDrawings,
            docLevel: classification.docLevel,
            drawingFileIds: drawingFiles.map((f) => f.fileId),
            useBrainFallback: !classification.hasDrawings || classification.docLevel <= 1,
        },
    });

    // FAZA 3: Gap Filler (Łatanie luk)
    const gapFillerTaskId = `${tenderId}-GAP_FILLER`;
    tasks.push({
        taskId: gapFillerTaskId,
        type: 'GAP_FILLER',
        status: 'PENDING',
        createdAt: now,
        order: order++,
        dependsOn: [surveyorTaskId], // Czeka aż Ilościowiec skończy
        payload: { tenderId, note: 'Łatanie brakujących pozycji' },
    });

    // FAZA 4: Audytor
    const auditorTaskId = `${tenderId}-SILENT_AUDITOR`;
    tasks.push({
        taskId: auditorTaskId,
        type: 'SILENT_AUDITOR',
        status: 'PENDING',
        createdAt: now,
        order: order++,
        dependsOn: [gapFillerTaskId], // Czeka na Gap Fillera żeby widzieć całość
        payload: {
            tenderId,
            objectTypeHint: classification.objectTypeHint,
            hasGeotechnics: classification.hasGeotechnics,
            hasSWZ: classification.hasSWZ,
            missingDataReport: classification.missingData,
        },
    });

    // FAZA 5: Broker
    const brokerTaskId = `${tenderId}-BROKER`;
    tasks.push({
        taskId: brokerTaskId,
        type: 'BROKER',
        status: 'PENDING',
        createdAt: now,
        order: order++,
        dependsOn: [auditorTaskId], // Czeka na komplet przed wyceną
        payload: { tenderId },
    });

    // FAZA 6: Rewident
    const rewidentDeps = [brokerTaskId];
    if (legalTaskId) rewidentDeps.push(legalTaskId);

    tasks.push({
        taskId: `${tenderId}-REWIDENT`,
        type: 'REWIDENT',
        status: 'PENDING',
        createdAt: now,
        order: order++,
        dependsOn: rewidentDeps, // Czeka na Brokera i na Prawnika
        payload: { tenderId },
    });

    return tasks;
}

export async function POST(req: NextRequest) {
    const startTime = Date.now();
    console.log("==================================================");
    console.log("[Inicjalizator] === PESAM 2.2 – PARALLEL DAG ===");
    console.log("==================================================");

    try {
        const { tenderId, fileList } = await req.json();
        if (!tenderId) return NextResponse.json({ error: 'Brak tenderId' }, { status: 400 });

        const safeFileList = fileList ?? [];
        const filesSnap = await adminDb.collection(`tenders/${tenderId}/files`).get();
        const documentTexts: Array<{ fileName: string; content: string }> = [];

        for (const doc of filesSnap.docs) {
            const data = doc.data();
            const cat = data.category?.toUpperCase() || "";
            if (['SWZ', 'PFU', 'OPZ', 'UMOWA'].includes(cat) && data.extractedText) {
                documentTexts.push({ fileName: data.fileName, content: data.extractedText });
            }
        }

        const classification = await classifyDocuments(safeFileList, documentTexts);
        const tasks = buildTaskQueue(tenderId, classification, safeFileList);

        const batch = adminDb.batch();
        for (const task of tasks) {
            batch.set(adminDb.doc(`tenders/${tenderId}/tasks/${task.taskId}`), task);
        }

        batch.update(adminDb.doc(`tenders/${tenderId}`), {
            status: 'INITIALIZED',
            docLevel: classification.docLevel,
            estimationMethod: classification.estimationMethod,
            objectTypeHint: classification.objectTypeHint,
            objectAreaHint_m2: classification.objectAreaHint_m2 ?? null,
            tasksCount: tasks.length,
            updatedAt: new Date().toISOString(),
        });

        await batch.commit();

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`[Inicjalizator] ✅ Sukces: Rój zainicjowany w ${duration} sek.`);
        return NextResponse.json({ success: true, tasksQueue: tasks.map(t => ({ taskId: t.taskId, type: t.type, dependsOn: t.dependsOn })) });

    } catch (error: any) {
        console.error('[Inicjalizator] ❌ BŁĄD:', error.message);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}