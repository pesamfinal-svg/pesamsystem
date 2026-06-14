import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { FieldValue } from "firebase-admin/firestore";
import { GoogleGenAI, Type } from "@google/genai";
import { jsonrepair } from "jsonrepair";
import dns from "dns";
dns.setDefaultResultOrder("ipv4first");

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
    location: "global"
});

const MODEL_FLASH = "gemini-2.5-flash";

const CALC_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        calculations: {
            type: Type.OBJECT,
            description: "Słownik (mapa klucz-wartość) zawierający wyliczone zmienne i ich dokładne wartości liczbowe (np. { totalPowerKwp: 50.4, panelsNeeded: 120, excavationVolumeM3: 4261 }). Nazwy kluczy dobierz dynamicznie w camelCase na podstawie zadania."
        },
        summary: {
            type: Type.STRING,
            description: "Opis wykonanych obliczeń wraz ze wzorami matematycznymi i komentarzem inżynieryjnym."
        }
    },
    required: ["calculations", "summary"]
};

export async function POST(req: Request) {
    let tenderId: string | undefined;
    let taskId: string | undefined;
    let isSuccess = false;

    try {
        const body = await req.json();
        tenderId = body.tenderId;
        taskId = body.taskId;

        console.log(`[MATEMATYK 🧮] Start. tenderId: ${tenderId}, taskId: ${taskId}`);

        if (!tenderId || !taskId) return NextResponse.json({ error: "Brak danych" }, { status: 400 });

        const taskRef = adminDb.collection(`tenders/${tenderId}/tasks`).doc(taskId);
        const taskDoc = await taskRef.get();
        if (!taskDoc.exists) throw new Error("Zadanie nie istnieje.");

        const taskData = taskDoc.data()!;
        if (taskData.status !== "PENDING") return NextResponse.json({ message: "Zadanie już wykonane." });

        await taskRef.update({ status: "IN_PROGRESS", updatedAt: new Date() });

        // KROK 1: Wykonanie kodu Python (BEZ RESPONSE SCHEMA - rozwiązuje to konflikt 400!)
        console.log("[MATEMATYK 🧮] KROK 1: Uruchamiam piaskownicę Python...");
        const calcPrompt = `
Jesteś Matematykiem i Ekspertem ds. obliczeń inżynieryjnych.
Musisz rozwiązać następujące zadanie obliczeniowe:

Zadanie: ${taskData.instruction}

Dane wejściowe ze stanu kognitywnego:
${JSON.stringify(taskData.inputFacts || {})}

Użyj wbudowanego narzędzia Code Execution (piaskownicy Pythona) aby:
1. Napisać skrypt obliczeniowy rozwiązujący to zadanie.
2. Wykonać go i pobrać dokładny, bezbłędny wynik matematyczny.
`;

        const calcResult = await ai.models.generateContent({
            model: MODEL_FLASH,
            contents: calcPrompt,
            config: {
                tools: [{ codeExecution: {} }], // Aktywujemy Pythona
                temperature: 0.1
                // BRAK responseSchema! To eliminuje konflikt chmurowy 400.
            }
        });

        const rawPythonOutput = calcResult.text ?? "";
        let totalTokensUsed = calcResult.usageMetadata?.totalTokenCount || 0;
        console.log("[MATEMATYK 🧮] Python zakończył obliczenia.");

        // KROK 2: Strukturyzacja wyników na JSON (Bez Pythona, ze schematem)
        console.log("[MATEMATYK 🧮] KROK 2: Porządkowanie wyników obliczeń do JSON...");
        const structurePrompt = `
Na podstawie poniższego wykonanego skryptu i jego wyników, wyodrębnij surowe zmienne liczbowe i sformatuj je jako płaski słownik JSON (klucz-wartość), aby Mózg mógł je bezpośrednio wczytać do swojej bazy znanych faktów (knownFacts).

Wyniki Pythona:
${rawPythonOutput}
`;

        const structureResult = await ai.models.generateContent({
            model: MODEL_FLASH,
            contents: structurePrompt,
            config: {
                temperature: 0.1,
                responseMimeType: "application/json",
                responseSchema: CALC_SCHEMA as any
            }
        });

        let parsedResult: any = {};
        try {
            parsedResult = JSON.parse(jsonrepair(structureResult.text ?? "{}"));
        } catch (e) {
            console.error("[MATEMATYK 🧮] Błąd parsowania wyliczeń.");
        }

        totalTokensUsed += structureResult.usageMetadata?.totalTokenCount || 0;

        await taskRef.update({
            status: "DONE",
            rawResult: parsedResult,
            processedByBrain: false,
            costTokens: totalTokensUsed,
            updatedAt: new Date()
        });

        const costUSD = (totalTokensUsed / 1000) * 0.000015;
        await adminDb.collection("tenders").doc(tenderId).update({
            "budgetGuard.currentCostUSD": FieldValue.increment(costUSD)
        });

        isSuccess = true;
        console.log("[MATEMATYK 🧮] Obliczenia zakończone sukcesem.");
        return NextResponse.json({ success: true });

    } catch (error: any) {
        console.error("[MATEMATYK 🧮] ❌ Błąd:", error);
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
                body: JSON.stringify({ tenderId, trigger: isSuccess ? `TASK_COMPLETED_${taskId}` : `TASK_FAILED_${taskId}` })
            }).catch(() => { });
        }
    }
}