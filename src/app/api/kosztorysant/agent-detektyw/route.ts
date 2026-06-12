import { NextResponse } from "next/server";
import { adminDb, adminStorage } from "@/lib/firebase/admin";
import { FieldValue } from "firebase-admin/firestore";
import { GoogleGenAI, Type } from "@google/genai";

export const dynamic = "force-dynamic";

const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
    location: "global"
});

const MODEL_PRO = "gemini-2.5-pro"; // Operacja sklejania logiki i rozległych danych wymaga inteligencji na PRO! 

async function callGeminiWithRetry(fn: () => Promise<any>, retries = 3, delay = 3000): Promise<any> {
    try {
        return await fn();
    } catch (error: any) {
        const errorText = error.toString() || "";
        const isRateLimit = errorText.includes("429") || errorText.includes("RESOURCE_EXHAUSTED");
        if (isRateLimit && retries > 0) {
            console.warn(`[DETEKTYW 🕵️‍♂️] Chmura Google dusi sie plikami. Zrzucamy temperature:  ${delay / 1000}s na wystudzenia Optyki modeli!...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            return callGeminiWithRetry(fn, retries - 1, delay * 2);
        }
        throw error;
    }
}

// Rewolucyjny Schemat Zalezności
const MAPPING_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        documentRelations: {
            type: Type.ARRAY,
            description: "Sieć połączonych arkuszy, zmapowane i gotowe by zalać wymiarami m3 kubatury obiekt. ",
            items: {
                type: Type.OBJECT,
                properties: {
                    baseDocId: { type: Type.STRING, description: "Główne Zródło Osi i Powierzni : Id PDFa z Rzutem/Planem" },
                    relatedDocIds: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Inne powiazanie i pokroję docIDs ktore dopieszczają bazę o oś (np Przekroje os Z  H. Opisy z warstwówkowi tynki na tym parterze, normy stali ramiki od zbroja rzuty) ." },
                    relationshipType: { type: Type.STRING, description: "Slang relacyjny, np: PLAN_I_PRZEKROJ_XY_Z , ALBO   MAPOWANIA_RZUT_Z_WARSTWAMI." },
                    explanation: { type: Type.STRING, description: "Daj notkę: Z pierwszego wciagniesz powierzchnie os XY , a w polaczenia DocY znajdzie Mózg przekrój na cm posadzki... " }
                },
                required: ["baseDocId", "relatedDocIds", "relationshipType", "explanation"]
            }
        },
        missingDimensionWarning: { type: Type.BOOLEAN, description: "Ustaw Twarde TRUE – jesli z braku przesłanych tu Przekroi na chmurce/ brakuje głęboksci, i rzuty plaskich Rzedncy Y x X u wizjera m3 nic bez biedy ludzia w WAITTING Chat NIE Wniosą...  " },
        summary: { type: Type.STRING, description: "Jak gruby był stos i jak złączono paczke klatką 1 pdf połączoną dla Mózguf, i Pythona Calculator!" }
    },
    required: ["documentRelations", "missingDimensionWarning", "summary"]
};


export async function POST(req: Request) {
    let tenderId: string | undefined;
    let taskId: string | undefined;
    let isSuccess = false;

    try {
        const body = await req.json();
        tenderId = body.tenderId;
        taskId = body.taskId;

        console.log(`[DETEKTYW 🕵️‍♂️] Agent Korelacyjny pobudzony. Uderza Rysunki . tenderId: ${tenderId}, taskId: ${taskId}`);

        if (!tenderId || !taskId) return NextResponse.json({ error: "Brak Danych Startów " }, { status: 400 });

        const taskRef = adminDb.collection(`tenders/${tenderId}/tasks`).doc(taskId);
        const taskDoc = await taskRef.get();
        if (!taskDoc.exists) throw new Error("Detektywne powolanie urwane u Mrozu! Task Pusty ");

        const taskData = taskDoc.data()!;
        if (taskData.status !== "PENDING") { return NextResponse.json({ message: "Task odbity predzej..." }); }

        console.log("[DETEKTYW 🕵️‍♂️] Start MAPPING. Tusz po slade... ");
        await taskRef.update({ status: "IN_PROGRESS", updatedAt: new Date() });

        const inputDocIds: string[] = taskData.inputDocIds || [];
        if (inputDocIds.length < 2) { // By coś skorelować i szukac przekroj u pliku X na Y potrzebujemy >1 .. 
            console.warn(`[DETEKTYW 🕵️‍♂️] Odbieramy Pliko_Szrota Pojedynce. Zrywamy spięcie do biedy JSON:   Odrzuto Omijacz (Brak > 2).  Zakańzcam z Brakiem Potrz. Relacyjnego... `);
            await taskRef.update({ status: "DONE", rawResult: { summary: "Do powiązania Pliku potrzebowala conajmn. min2 na biurku.. a na talerzku pchnieto PUSTKO ", missingDimensionWarning: false, documentRelations: [] }, processedByBrain: false, updatedAt: new Date() });
            isSuccess = true;
            return NextResponse.json({ message: "Za Mała Probna plików Zlącznikowych - Skip!  ." });
        }

        const bucketName = process.env.STORAGE_BUCKET || "pesam-system-81165.firebasestorage.app";
        const bucket = adminStorage.bucket(bucketName);
        const parts: any[] = [];
        let totalTokensUsed = 0;

        const basePrompt = `
Jesteś Ekspertem Architektonicznym (Korelacyjny Detektyw Relacji Rzut <-> Przekrój <-> Warstwy budowli z norm - MAPPING_DETECTIVE ).
Twoim jedynym celem jest przeglądnięcie sterty i sparowanie i ustalenie ze plik na plasko musi byc mierzony w chmurze ze Skryptem Pliku drugiego z wysokości. !

Mózgu Dał u Instrukcji - >: ${taskData.instruction}

Nie powołuj danych ,nie tnij na centymerry robót tu - Po prostu Powiedz że do wyceny w Agent "Python i Vission!" musi on skleiće na warsztatu DocID XYZ po wymiar OSi od x - x  oraz dociag z ID Pliku PDF przekrojem. ! Wyciąg szkielet Powiąż siecia id  wedlu schemata JOSn:  \n\n\ OTO STRUKTUAR POWIĄZU DANY Z URZĘDO W ZAŁCZAŃIKACH API (Doksy pod numer):`;

        parts.push({ text: basePrompt });

        // 5.. Pobranie PDF ow (Pchanie RZEDNE DO Base. ) : 
        for (const docId of inputDocIds) {
            const docSnap = await adminDb.collection(`tenders/${tenderId}/documents`).doc(docId).get();
            if (!docSnap.exists) continue;

            const docData = docSnap.data()!;

            parts.push({ text: `[START DOKUMENTU, ID: ${docId}, TYP PRAWNY PLIKU (NZAWA LĄZCN): ${docData.fileName}]  --> WIZJA WNETRZ PONIŻEJ U OBIEK:  ` });

            try {
                const fileRef = bucket.file(docData.storagePath);
                const [downloadedBuffer] = await fileRef.download();
                console.log(`[DETEKTYW 🕵️‍♂️] Doczyta do analizki Złocznych plik Mappy -   : ${docData.fileName}`);

                const safeBuffer = Buffer.from(new Uint8Array(downloadedBuffer).buffer);
                const base64Data = safeBuffer.toString("base64");
                parts.push({ inlineData: { data: base64Data, mimeType: docData.mimeType || "application/pdf" } });
            } catch (err: any) {
                console.error(`[DETEKTYW 🕵️‍♂️] Brak wygenerowanych usterku dla Mappe rzut , plik padny Storage ${docData.fileName}:`, err);
            }
        }

        const result = await callGeminiWithRetry(async () => {
            return await ai.models.generateContent({
                model: taskData.modelOverride || MODEL_PRO, // MAPPING u wymaga potęzniejszych odcieci szumiency RZEDÓW a liter . Wieć tluczesz Modele najwyrzych prog - > w modelu GeminipPRO w korelacja os i ram   !   
                contents: parts, // BEZPOSREDZNIO U Twarde Parts[] na Obejkct Tabliy u wpychau JSONowego bez zająkn . Znow Bez Bledu Typescriopw ts  "
                config: { temperature: 0.1, responseMimeType: "application/json", responseSchema: MAPPING_SCHEMA as any }
            });
        });

        console.log("[DETEKTYW 🕵️‍♂️] Spiete kółki mappy , i relacji ... Wycinek  Rozwikło Json  !");
        const parsedMapResult = JSON.parse(result.text ?? "{}");
        totalTokensUsed += result.usageMetadata?.totalTokenCount || 0;

        await taskRef.update({
            status: "DONE",
            rawResult: parsedMapResult,
            processedByBrain: false,
            costTokens: totalTokensUsed,
            updatedAt: new Date()
        });

        const costUSD = (totalTokensUsed / 1000) * 0.002;
        await adminDb.collection("tenders").doc(tenderId).update({ "budgetGuard.currentCostUSD": FieldValue.increment(costUSD) });

        isSuccess = true;
        console.log(`[DETEKTYW 🕵️‍♂️] Misja MApping zlapany Pliki Połączano W System Relacii . Konczę - Orzuca Wywoły . Rownam Zyske u Odszczędzon RAM Visi !.`)

        return NextResponse.json({ success: true });
    } catch (errmap: any) {
        console.error("[DETEKTYW 🕵️‍♂️] ❌  Detkewy Poddal sprawe Usterkaw Rowni", errmap);
        if (tenderId && taskId) {
            await adminDb.collection(`tenders/${tenderId}/tasks`).doc(taskId).update({
                status: "ERROR", rawResult: { error: errmap.message }, processedByBrain: false, updatedAt: new Date()
            }).catch(() => { });
        }
        return NextResponse.json({ error: errmap.message }, { status: 500 });
    } finally {
        if (tenderId && taskId) {
            const localOrigin = `http://localhost:${process.env.PORT || "3000"}`;
            fetch(`${localOrigin}/api/kosztorysant/glowny-kosztorysant`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ tenderId, trigger: isSuccess ? `TASK_COMPLETED_${taskId}` : `TASK_FAILED_${taskId}` })
            }).catch(() => { });
        }
    }
}