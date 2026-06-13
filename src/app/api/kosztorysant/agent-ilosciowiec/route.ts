import { NextResponse } from "next/server";
import { adminDb, adminStorage } from "@/lib/firebase/admin";
import { FieldValue } from "firebase-admin/firestore";
import { GoogleGenAI, Type } from "@google/genai";
import * as xlsx from "xlsx"; // NATYWNY MODUŁ PARSUJĄCY SUROWE PRZEDMIARY Z EXCEL

export const dynamic = "force-dynamic";

const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
    location: "global"
});

const MODEL_PRO = "gemini-2.5-pro"; // Zarezerwowany dla skanów przedmiarow-PDF
const MODEL_FLASH = "gemini-2.5-flash"; // Wystarczający, bardzo wydajny w filtrowaniu gotowych i oczyszczonych tekstów exela

// Zabezpieczenie chmury u Agenta BOQ 429 API EXHAUSTION Limits
async function callGeminiWithRetry(fn: () => Promise<any>, retries = 3, delay = 3000): Promise<any> {
    try {
        return await fn();
    } catch (error: any) {
        const errorText = error.toString() || "";
        const isRateLimit = errorText.includes("429") || errorText.includes("RESOURCE_EXHAUSTED");
        if (isRateLimit && retries > 0) {
            console.warn(`[BOQ PARSER 📊] Wykryto limit API 429... Czekam ${delay / 1000}s na przestygniecie przeplywu limitow. (Zostaly prob: ${retries})`);
            await new Promise(resolve => setTimeout(resolve, delay));
            return callGeminiWithRetry(fn, retries - 1, delay * 2);
        }
        throw error;
    }
}

const BOQ_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        items: {
            type: Type.ARRAY,
            description: "Lista wyizolowanych twardych pozycji ze ślepego przedmiaru",
            items: {
                type: Type.OBJECT,
                properties: {
                    pozycja: { type: Type.STRING, description: "Numer referencyjny np. '1.1'" },
                    opis: { type: Type.STRING, description: "Konkretny, inżynieryjny tytuł prac odcięty z ewentualnej 'od biedy - pustki' ze struktur surowego pliku!" },
                    ilosc: { type: Type.NUMBER, description: "Zestawienie twarde z liczby całkowitej lub ułamka na wykonastwo" },
                    jednostka: { type: Type.STRING, description: "np: szt., mb, r-godz itp" },
                    KNR_ref: { type: Type.STRING, description: "podstawy z katalogu dla ujednoliceń norm od Inwestora. (Podstawowy znacznik referencyjny)." }
                },
                required: ["pozycja", "opis", "ilosc", "jednostka"]
            }
        },
        summary: { type: Type.STRING, description: "Pojemność Przedmiarowanego frontu" }
    },
    required: ["items", "summary"]
};

export async function POST(req: Request) {
    let tenderId: string | undefined;
    let taskId: string | undefined;
    let isSuccess = false;

    try {
        const body = await req.json();
        tenderId = body.tenderId;
        taskId = body.taskId;

        console.log(`[BOQ PARSER 📊] Start żądania parsowania Ilości. Przetarg: ${tenderId}, TaskId: ${taskId}`);

        if (!tenderId || !taskId) return NextResponse.json({ error: "Brak parametrów" }, { status: 400 });

        const taskRef = adminDb.collection(`tenders/${tenderId}/tasks`).doc(taskId);
        const taskDoc = await taskRef.get();
        if (!taskDoc.exists) throw new Error("Zadanie nie istnieje.");

        const taskData = taskDoc.data()!;
        if (taskData.status !== "PENDING") return NextResponse.json({ message: "Zadanie Przetworzone wcześniej." });

        console.log("[BOQ PARSER 📊] Zmieniam status zadania na IN_PROGRESS");
        await taskRef.update({ status: "IN_PROGRESS", updatedAt: new Date() });

        const inputDocIds: string[] = taskData.inputDocIds || [];

        if (inputDocIds.length === 0) {
            console.warn("[BOQ PARSER 📊] Brak Dokumentów. Agresor nie działa pusty. Status -> DONE z braku załącznika.");
            await taskRef.update({ status: "DONE", rawResult: { message: "Brak Rysunku Wskazanego u Doc." }, processedByBrain: false, updatedAt: new Date() });
            isSuccess = true;
            return NextResponse.json({ message: "Brak wskazan do Plikow. Omija Procesora z biedy!" });
        }

        const bucketName = process.env.STORAGE_BUCKET || "pesam-system-81165.firebasestorage.app";
        const bucket = adminStorage.bucket(bucketName);
        const allExtractedItems: any[] = [];
        let totalTokensUsed = 0;

        for (const docId of inputDocIds) {
            const docSnap = await adminDb.collection(`tenders/${tenderId}/documents`).doc(docId).get();
            if (!docSnap.exists) continue;

            const docData = docSnap.data()!;
            console.log(`[BOQ PARSER 📊] Sprawdzam podłoża pod Rzut dla przedmiaru... MimeType : ${docData.mimeType}`);
            const isExcel = docData.mimeType?.includes("excel") || docData.mimeType?.includes("spreadsheetml") || docData.fileName.toLowerCase().endsWith(".xlsx") || docData.fileName.toLowerCase().endsWith(".xls");

            try {
                const fileRef = bucket.file(docData.storagePath);

                if (isExcel) {
                    // EXCEL: Pobieramy do pamięci, bo biblioteka xlsx musi go fizycznie przeczytać
                    const [downloadedBuffer] = await fileRef.download();
                    console.log(`[BOQ PARSER 📊] Pobrano : ${downloadedBuffer.length} B (Plik Excel - Parsowanie Pamięciowe)`);
                    const safeBuffer = Buffer.from(new Uint8Array(downloadedBuffer).buffer);

                    console.log(`[BOQ PARSER 📊] To Plik Typu Przedmiar Cyfrowego Nativ EXEL (Krzywy ubytek). Pcham jako wstrzykniecia parser!`);

                    const workbook = xlsx.read(safeBuffer, { type: "buffer" });
                    const sheetName = workbook.SheetNames[0];

                    const rawJsonText = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1 });
                    const promptExcelToNormalize = `Działa Twój Moduł Normalizator Tabulacyjny JSON od Inżynierów Odbioru Rządowych PZP ! 
Dostaniesz Surowe bezstratne rzutki po API, z programu Natywnego EXcel. Uzywaj instrukcj MOZGU : "${taskData.instruction}" - sfiltruj to jako ludzką predyktywą  AI (Uważając ! I odrzuc z ukladem brudy pustki , okna naglowkow Gmina  Miasto XYZ i dat wczesnych pod rzetelną bazową kosztorysa przedmiarem formatow i zepnij odpowiedz sztywnym w schemat ! Zrób to u struktury i zostaw z opisu sam R-G , M-j. \n Surowe dane (Szarpanego na klatki Json text - Exella ) : ${JSON.stringify(rawJsonText).substring(0, 30000)} ...  (ucinamy jeśli plik to całe puste loga dla Oszczedności). Uzywaj FLASH AI O Niskim koszcie...`;

                    const result = await callGeminiWithRetry(async () => {
                        return await ai.models.generateContent({
                            model: MODEL_FLASH,
                            contents: promptExcelToNormalize,
                            config: { temperature: 0.1, responseMimeType: "application/json", responseSchema: BOQ_SCHEMA as any }
                        });
                    });

                    const parsedExResult = JSON.parse(result.text ?? "{}");
                    totalTokensUsed += result.usageMetadata?.totalTokenCount || 0;
                    if (parsedExResult.items) allExtractedItems.push(...parsedExResult.items);

                } else {
                    // PDF: Przechodzimy na nowoczesny, referencyjny format chmurowy gs:// BEZ POBIERANIA DO RAM!
                    console.log(`[BOQ PARSER 📊] Użyto nowoczesnego linku gs:// dla przedmiaru PDF (Eliminacja UND_ERR_HEADERS_TIMEOUT).`);
                    const fileUri = `gs://${bucketName}/${docData.storagePath}`;
                    const promptPDF = `Odślepiaj formatami RZECZ Z MODELO'a Przedmiarów Dokumentów Urzędniczo budowlańca : Wykorzystuj z instrukcja : ${taskData.instruction}`;

                    const resultPDF = await callGeminiWithRetry(async () => {
                        return await ai.models.generateContent({
                            model: taskData.modelOverride || MODEL_PRO,
                            contents: [
                                {
                                    role: "user",
                                    parts: [
                                        { text: promptPDF },
                                        { fileData: { fileUri: fileUri, mimeType: docData.mimeType || "application/pdf" } }
                                    ]
                                }
                            ],
                            config: { temperature: 0.1, responseMimeType: "application/json", responseSchema: BOQ_SCHEMA as any }
                        });
                    });

                    const parsedPDFResult = JSON.parse(resultPDF.text ?? "{}");
                    totalTokensUsed += resultPDF.usageMetadata?.totalTokenCount || 0;
                    if (parsedPDFResult.items) allExtractedItems.push(...parsedPDFResult.items);
                }

            } catch (err: any) {
                console.error(`[BOQ PARSER 📊] Nieoczekiwa wina czytniku Odtwarzacza od doc pliku ${docData.fileName}:`, err);
                throw err;
            }
        }

        await taskRef.update({
            status: "DONE",
            rawResult: { items: allExtractedItems, summary: `Skasowane Odczytane Pół Prowincjonlnego exela i Sklejona Przedmiar` },
            processedByBrain: false,
            costTokens: totalTokensUsed,
            updatedAt: new Date()
        });

        const costUSD = (totalTokensUsed / 1000) * 0.002;
        await adminDb.collection("tenders").doc(tenderId).update({ "budgetGuard.currentCostUSD": FieldValue.increment(costUSD) });

        isSuccess = true;
        console.log(`[BOQ PARSER 📊] Niskokaloryczny, spowolniasz na portfel u Excel/PDF zoptymalizowan !! Koszty miedzi. Konczy sukcesnie BOQ !!`);
        return NextResponse.json({ success: true });

    } catch (error: any) {
        console.error("[BOQ PARSER 📊] ❌ Brak Biedy / Brak Powodzen w Pliku przedmiarze / Przetrawka błąd!", error);
        if (tenderId && taskId) {
            await adminDb.collection(`tenders/${tenderId}/tasks`).doc(taskId).update({
                status: "ERROR", rawResult: { error: error.message }, processedByBrain: false, updatedAt: new Date()
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