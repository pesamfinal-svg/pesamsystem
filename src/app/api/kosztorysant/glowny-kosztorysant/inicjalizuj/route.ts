// ============================================================
// PESAM – Inicjalizator Zadań (rozszerzony o Analizę Zakresu)
// POST /api/kosztorysant/glowny-kosztorysant/inicjalizuj
//
// ZMIANY:
//   + Dynamiczne tworzenie kolejki zadań z nowymi Agentami
//   + Dodany task ANALITYK_ZAKRESU jako inicjator Roju
//   + Dodany task GAP_FILLER przed Rewidentem
//   + Integracja ze zunifikowaną biblioteką @google/genai
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase/admin';
import { GoogleGenAI, Type } from '@google/genai';

export const dynamic = "force-dynamic";

const MODEL_FLASH = "gemini-2.5-flash";

type TaskType =
    | 'ANALITYK_ZAKRESU'   // Twórca wzorca
    | 'LEGAL'
    | 'VISION'
    | 'KNR'
    | 'NORMATIVE_STEEL'
    | 'PARAMETRIC'
    | 'BROKER'
    | 'GAP_FILLER'         // Łatacz luk
    | 'REWIDENT';          // Audytor końcowy

interface Task {
    taskId: string;
    type: TaskType;
    status: 'PENDING' | 'IN_PROGRESS' | 'DONE' | 'ERROR';
    createdAt: string;
    order: number;         // Kolejność w pętli roju
    payload: Record<string, any>;
    result?: any;
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
}

// ============================================================
// Szybki Klasyfikator Dokumentacji (Gemini)
// ============================================================

async function classifyDocuments(
    fileList: Array<{ fileName: string; category: string; storagePath: string }>
): Promise<ClassifierOutput> {
    console.log(`[Inicjalizator] [Klasyfikacja] Analizuję strukturę ${fileList.length} plików wejściowych...`);

    const ai = new GoogleGenAI({
        vertexai: true,
        project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
        location: "global",
    });

    const prompt = `
Oceń poziom dokumentacji i kompletność na podstawie następującej listy zaimportowanych plików:
${JSON.stringify(fileList, null, 2)}

Przypisz docLevel (0-4) oraz metodę wyceny:
- LEVEL 0 -> PARAMETRIC (tylko ogólny opis / brak projektów)
- LEVEL 1-2 -> ANALOGICAL (PFU / koncepcje)
- LEVEL 3 -> ELEMENT_BASED (są rzuty architektoniczne, brak zbrojenia i instalacji)
- LEVEL 4 -> DETAILED_KNR (pełny projekt wykonawczy ze specyfikacją)

Zwróć wynik jako czysty obiekt JSON.
  `.trim();

    const response = await ai.models.generateContent({
        model: MODEL_FLASH,
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: {
            systemInstruction: "Klasyfikuj dokumentację budowlaną pod kątem prawnym i technicznym. Odpowiadaj wyłącznie poprawnym JSON-em.",
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
                    missingData: { type: Type.ARRAY, items: { type: Type.STRING } }
                },
                required: ['docLevel', 'estimationMethod', 'hasDrawings', 'hasSWZ', 'hasPFU', 'hasReinforcementDetails', 'hasGeotechnics', 'missingData']
            }
        }
    });

    const parsed: ClassifierOutput = JSON.parse(response.text ?? "{}");
    console.log(`[Inicjalizator] [Klasyfikacja] Wynik: Level = ${parsed.docLevel} (${parsed.estimationMethod}). Wykryte rysunki: ${parsed.hasDrawings}`);
    return parsed;
}

// ============================================================
// Budowanie kolejki zadań dla Roju
// ============================================================

function buildTaskQueue(
    tenderId: string,
    classification: ClassifierOutput,
    fileList: Array<{ fileName: string; category: string; storagePath: string; fileId: string }>
): Task[] {
    const now = new Date().toISOString();
    const tasks: Task[] = [];
    let order = 0;

    const swzFiles = fileList.filter((f) => ['SWZ', 'OPZ', 'PFU', 'UMOWA'].includes(f.category.toUpperCase()));
    const drawingFiles = fileList.filter((f) => f.category.toUpperCase() === 'DRAWING');

    console.log(`[Inicjalizator] [Kolejka] Buduję optymalny łańcuch zadań dla przetargu: ${tenderId}...`);

    // 1. ANALITYK ZAKRESU – Zawsze na pierwszym miejscu (Tworzy ScopeManifest)
    tasks.push({
        taskId: `${tenderId}-ANALITYK_ZAKRESU`,
        type: 'ANALITYK_ZAKRESU',
        status: 'PENDING',
        createdAt: now,
        order: order++,
        payload: {
            tenderId,
            docLevel: classification.docLevel,
            estimationMethod: classification.estimationMethod,
            sourceDocuments: fileList.map((f) => f.fileName),
            swzFileIds: swzFiles.map((f) => f.fileId),
        },
    });
    console.log(`[Inicjalizator] [Kolejka] + Dodano zadanie [0] ANALITYK_ZAKRESU (Budowa kryteriów i manifestu)`);

    // 2. LEGAL – Analiza prawna umowy i SWZ
    if (classification.hasSWZ || swzFiles.length > 0) {
        tasks.push({
            taskId: `${tenderId}-LEGAL`,
            type: 'LEGAL',
            status: 'PENDING',
            createdAt: now,
            order: order++,
            payload: {
                tenderId,
                fileIds: swzFiles.map((f) => f.fileId),
            },
        });
        console.log(`[Inicjalizator] [Kolejka] + Dodano zadanie [${order - 1}] LEGAL (Przegląd kar, ryzyk i gwarancji)`);
    }

    // 3. VISION – Analiza rysunków technicznych (Jeśli wgrano i poziom to koncepcja/projekt)
    if (classification.hasDrawings && classification.docLevel >= 2) {
        tasks.push({
            taskId: `${tenderId}-VISION`,
            type: 'VISION',
            status: 'PENDING',
            createdAt: now,
            order: order++,
            payload: {
                tenderId,
                fileIds: drawingFiles.map((f) => f.fileId),
                docLevel: classification.docLevel,
            },
        });
        console.log(`[Inicjalizator] [Kolejka] + Dodano zadanie [${order - 1}] VISION (Zliczanie kubatur, rzuty, elewacje)`);
    }

    // 4. KNR (Przedmiarowanie) – Tylko dla projektów budowlanych/wykonawczych (Level 3+)
    if (classification.docLevel >= 3) {
        tasks.push({
            taskId: `${tenderId}-KNR`,
            type: 'KNR',
            status: 'PENDING',
            createdAt: now,
            order: order++,
            payload: { tenderId, docLevel: classification.docLevel },
        });
        console.log(`[Inicjalizator] [Kolejka] + Dodano zadanie [${order - 1}] KNR (Generowanie kosztorysu z normatywów)`);
    }

    // 5. NORMATIVE_STEEL – Jeśli to projekt budowlany (brak detali zbrojenia) – doliczamy stal wskaźnikowo
    if (classification.docLevel === 3 && !classification.hasReinforcementDetails) {
        tasks.push({
            taskId: `${tenderId}-NORMATIVE_STEEL`,
            type: 'NORMATIVE_STEEL',
            status: 'PENDING',
            createdAt: now,
            order: order++,
            payload: {
                tenderId,
                note: 'Dedykowany moduł szacowania stali konstrukcyjnej ze wskaźnika kg/m3 betonu',
            },
        });
        console.log(`[Inicjalizator] [Kolejka] + Dodano zadanie [${order - 1}] NORMATIVE_STEEL (Szacowanie stali zbrojeniowej)`);
    }

    // 6. PARAMETRIC – Wycena wskaźnikowa (Tylko dla niskich poziomów PFU/opis słowny)
    if (classification.docLevel <= 1) {
        tasks.push({
            taskId: `${tenderId}-PARAMETRIC`,
            type: 'PARAMETRIC',
            status: 'PENDING',
            createdAt: now,
            order: order++,
            payload: {
                tenderId,
                docLevel: classification.docLevel,
                hasPFU: classification.hasPFU,
            },
        });
        console.log(`[Inicjalizator] [Kolejka] + Dodano zadanie [${order - 1}] PARAMETRIC (Wycena wskaźnikowa m2)`);
    }

    // 7. BROKER – Wycena rynkowa i weryfikacja cen w Google (Zawsze wywoływana)
    tasks.push({
        taskId: `${tenderId}-BROKER`,
        type: 'BROKER',
        status: 'PENDING',
        createdAt: now,
        order: order++,
        payload: { tenderId },
    });
    console.log(`[Inicjalizator] [Kolejka] + Dodano zadanie [${order - 1}] BROKER (Wyszukiwanie cen online + marże)`);

    // 8. GAP_FILLER – Łatacz luk (Zawsze przed Rewidentem)
    tasks.push({
        taskId: `${tenderId}-GAP_FILLER`,
        type: 'GAP_FILLER',
        status: 'PENDING',
        createdAt: now,
        order: order++,
        payload: {
            tenderId,
            note: 'Analizuje luki w ScopeManifest i uzupełnia brakujące pozycje wycenami scalonymi',
        },
    });
    console.log(`[Inicjalizator] [Kolejka] + Dodano zadanie [${order - 1}] GAP_FILLER (Automatyczny łatacz braków)`);

    // 9. REWIDENT – Końcowa weryfikacja (Zawsze ostatni)
    tasks.push({
        taskId: `${tenderId}-REWIDENT`,
        type: 'REWIDENT',
        status: 'PENDING',
        createdAt: now,
        order: order++,
        payload: { tenderId },
    });
    console.log(`[Inicjalizator] [Kolejka] + Dodano zadanie [${order - 1}] REWIDENT (Końcowy audytor i bezpiecznik)`);

    return tasks;
}

// ============================================================
// GŁÓWNY HANDLER POST
// ============================================================

export async function POST(req: NextRequest) {
    const startTime = Date.now();
    console.log("==================================================");
    console.log("[Inicjalizator] === ROZPOCZĘTO INICJALIZACJĘ ROJU AGENTÓW ===");
    console.log("==================================================");

    try {
        const { tenderId, fileList } = await req.json() as {
            tenderId: string;
            fileList: Array<{
                fileName: string;
                category: string;
                storagePath: string;
                fileId: string;
            }>;
        };

        if (!tenderId || !fileList?.length) {
            console.error("[Inicjalizator] ❌ Błąd: Brak tenderId lub pusty fileList.");
            return NextResponse.json({ error: 'Brak parametrów wejściowych tenderId lub fileList' }, { status: 400 });
        }

        // 1. Klasyfikacja plików wejściowych
        const classification = await classifyDocuments(fileList);

        // 2. Generowanie dynamicznej kolejki zadań
        const tasks = buildTaskQueue(tenderId, classification, fileList);

        // 3. Masowy zapis w ramach paczki (Firestore Batch)
        console.log(`[Inicjalizator] Zapisuję ${tasks.length} zadań do podkolekcji Firestore w ramach transakcji Batch...`);
        const batch = adminDb.batch();

        for (const task of tasks) {
            const ref = adminDb
                .collection(`tenders/${tenderId}/tasks`)
                .doc(task.taskId);
            batch.set(ref, task);
        }

        // Aktualizacja statusu głównego rekordu przetargu
        console.log(`[Inicjalizator] Aktualizuję rekord główny przetargu: tenders/${tenderId}...`);
        batch.update(adminDb.doc(`tenders/${tenderId}`), {
            status: 'INITIALIZED',
            docLevel: classification.docLevel,
            estimationMethod: classification.estimationMethod,
            missingDataReport: classification.missingData,
            tasksCount: tasks.length,
            tasksOrder: tasks.map((t) => ({ taskId: t.taskId, type: t.type, order: t.order })),
            updatedAt: new Date().toISOString(),
        });

        await batch.commit();

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`[Inicjalizator] ✅ Sukces: Rój zainicjowany w ${duration} sek. Kolejka jest aktywna.`);
        console.log("==================================================");

        return NextResponse.json({
            success: true,
            tenderId,
            docLevel: classification.docLevel,
            estimationMethod: classification.estimationMethod,
            tasksQueue: tasks.map((t) => ({
                type: t.type,
                order: t.order,
                status: t.status,
            })),
        });

    } catch (error: any) {
        console.error('[Inicjalizator] ❌ KRYTYCZNY BŁĄD PODCZAS ZAPŁONU ROJU:', error);
        return NextResponse.json(
            { error: 'Krytyczny błąd inicjalizacji zadań roju', details: String(error) },
            { status: 500 }
        );
    }
}