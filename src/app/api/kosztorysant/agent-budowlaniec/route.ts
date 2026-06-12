import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { FieldValue } from "firebase-admin/firestore";
import { GoogleGenAI, Type } from "@google/genai";

export const dynamic = "force-dynamic";

const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
    location: "global"
});

const MODEL_PRO = "gemini-2.5-pro";
const MODEL_FLASH = "gemini-2.5-flash";

const BUDOWLANIEC_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        missingQuestions: {
            type: Type.ARRAY,
            description: "Puste. NIE ZADAWAJ PYTAŃ do Kosztorysanta, chyba że dotyczy to nietypowej/krytycznej prawnie sprawy bez ujednoliconego rynkowego standardu (np. specyficznych metod renowacji zabytku). Jeśli brakuje standardowych danych, wyzeruj tę listę i poczyń własne bezpieczne założenia.",
            items: { type: Type.STRING }
        },
        items: {
            type: Type.ARRAY,
            description: "Wygenerowane pozycje robót budowlanych w oparciu o projekt lub standard rynkowy dla obiektu tego typu.",
            items: {
                type: Type.OBJECT,
                properties: {
                    pozycja: { type: Type.STRING, description: "Nazwa roboty" },
                    opis: { type: Type.STRING, description: "Opis. Jeśli założyłeś cyfry sam (np. pręty fi12 zamiast brakującej zmiennej z SWZ) DODAJ do opisu: '(Założenie rynkowe AI)'." },
                    ilosc: { type: Type.NUMBER },
                    jednostka: { type: Type.STRING },
                    KNR_ref: { type: Type.STRING }
                },
                required: ["pozycja", "opis", "ilosc", "jednostka", "KNR_ref"]
            }
        },
        summary: { type: Type.STRING, description: "Wymień założone samodzielnie parametry techniczne wprost (betony, stalaże) dla wiedzy Roju." }
    },
    required: ["missingQuestions", "items", "summary"]
};

export async function POST(req: Request) {
    let tenderId: string | undefined;
    let taskId: string | undefined;
    let isSuccess = false;

    try {
        const body = await req.json();
        tenderId = body.tenderId;
        taskId = body.taskId;

        console.log(`[BUDOWLANIEC 🧱] Start. tenderId: ${tenderId}, taskId: ${taskId}`);

        if (!tenderId || !taskId) return NextResponse.json({ error: "Brak parametrów" }, { status: 400 });

        const taskRef = adminDb.collection(`tenders/${tenderId}/tasks`).doc(taskId);
        const taskDoc = await taskRef.get();

        if (!taskDoc.exists) throw new Error("Zadanie nie istnieje.");

        const taskData = taskDoc.data()!;
        if (taskData.status !== "PENDING") return NextResponse.json({ message: "Zadanie już wykonane." });

        await taskRef.update({ status: "IN_PROGRESS", updatedAt: new Date() });

        const knownFacts = taskData.inputFacts || {};
        let totalTokensUsed = 0;

        console.log("[BUDOWLANIEC 🧱] Rozpoczynam KROK 1...");
        const designPrompt = `
Jesteś Głównym Inżynierem Budowy. Twoja żelazna zasada pracy brzmi: Jesteś samodzielny. Jeśli w podanych znanych faktach ${JSON.stringify(knownFacts)} omija się szczegóły inżynieryjne (klasy betonów pod ławy w danym typie terenu, gęstości, siatki poprzeczne/podłużne), TO SAM je ustalaj pod kątem Polskiego standardu dla opisywanych obiektów.

Wskazówki Mózgu: ${taskData.instruction}

Nie proś ludzi o informację: jeśli SWZ nie pisze czy rurki to 15mm czy 20mm pod PEX ogrzewanie - zajrzyj w normę instalacyjną (masz dostęp włączony - uzyj wyszukiwarki). Przyjmij wyguglowaną optymalną i ekonomicznie racjonalną w Polsce miarę do opisu roboczego, jako gotową tezę kosztorysowania dla nas, zamiast odpytywać Kosztorysanta i go nudzić błachostkami o stali budowlanej - Kosztorysant też ma prawo nie znać milimetrowej specyfikacji, licz po najsensowniejszym wspóczynniku domyślnym inżynierskim jako doświadczony samodzielnie pracownik z norm dla typowych bloków czy stalaży dla budynku publicznego!

Daj czysty szczegółowy technologiczny wykaz od podbudów do tynku z racjonalnym rozpisaniem. Wyłącznie ostatecznie jak system lub dokument się nie spina prawnie co zrzuca miliony i to błąd specyfikacji to zjaw problem brakiem!`;

        const designResult = await ai.models.generateContent({
            model: MODEL_PRO,
            contents: [{ role: "user", parts: [{ text: designPrompt }] }],
            config: { tools: [{ googleSearch: {} }], temperature: 0.2 }
        });

        const builderProposal = designResult.text ?? "";
        totalTokensUsed += designResult.usageMetadata?.totalTokenCount || 0;

        console.log("[BUDOWLANIEC 🧱] Rozpoczynam KROK 2 Audytu Z Cichego Rejestratora...");
        const auditPrompt = `Przeanalizuj autokrytycznie swoją autorską zarysowana koncepcje samodzielnie i wypunktuj niedociągniecia budowlanych procesow pobocznych logistyk roboczo ziemnej izolacyjnej, ktore mogles nie wymienic do cyklu np zwozek lub sprzetów do:
        \n ${builderProposal}`;

        const auditResult = await ai.models.generateContent({
            model: MODEL_PRO,
            contents: [{ role: "user", parts: [{ text: auditPrompt }] }],
            config: { temperature: 0.2 }
        });

        const auditorFeedback = auditResult.text ?? "";
        totalTokensUsed += auditResult.usageMetadata?.totalTokenCount || 0;

        console.log("[BUDOWLANIEC 🧱] Rozpoczynam KROK 3 - finalny autozależnościowy ustruktur JSON...");
        const synthesisPrompt = `Narzuc poprawki w plan technologiczny biorac i nie narzucając pytani dla czatu - sam generuj bezpieczne wymuszenia i rozbite pozycje z obu debat:\nPlan:${builderProposal} \nBledy Audytu:${auditorFeedback}. Wynik formatem jako ustrukturyzowana tabela! W pozycjach na materiały w opsach, np jeśli jest beton pisz C30 b30 czy pojęcia co zgooglowałęs normami w krok1 samemu! Brak zadawania zbędnych pytań, dopóki budowa nie upadnie przez rażące zatajenie Inwestorów do procedur (zbyt wczesnie rzec do uzytkownik i nudes!)`;

        const structureResult = await ai.models.generateContent({
            model: MODEL_FLASH,
            contents: [{ role: "user", parts: [{ text: synthesisPrompt }] }],
            config: {
                temperature: 0.1,
                responseMimeType: "application/json",
                responseSchema: BUDOWLANIEC_SCHEMA as any
            }
        });

        const parsedResult = JSON.parse(structureResult.text ?? "{}");
        totalTokensUsed += structureResult.usageMetadata?.totalTokenCount || 0;

        await taskRef.update({
            status: "DONE",
            rawResult: parsedResult,
            processedByBrain: false,
            costTokens: totalTokensUsed,
            updatedAt: new Date()
        });

        const totalCostUSD = (totalTokensUsed / 1000) * 0.002;
        await adminDb.collection("tenders").doc(tenderId).update({ "budgetGuard.currentCostUSD": FieldValue.increment(totalCostUSD) });

        isSuccess = true;
        console.log("[BUDOWLANIEC 🧱] Pomyślny autogenerat inżynierstwa zakończony bez pytań usera jeśli standard dostępny normowany znaleziono sieci Google!");
        return NextResponse.json({ success: true });

    } catch (error: any) {
        console.error("[BUDOWLANIEC 🧱] ❌ Błąd krytyczny:", error);
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
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ tenderId, trigger: isSuccess ? `TASK_COMPLETED_${taskId}` : `TASK_FAILED_${taskId}` })
            }).catch(() => { });
        }
    }
}