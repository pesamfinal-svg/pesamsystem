import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { FieldValue } from "firebase-admin/firestore";
import { GoogleGenAI, Type } from "@google/genai";
import { jsonrepair } from "jsonrepair";

export const dynamic = "force-dynamic";

// ---> TUTAJ DODAJESZ TĘ LINIJKĘ: <---
const MODEL_FLASH = "gemini-2.5-flash";

const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
    location: "global" // Dzialajace zapytanie, dla wyjsc poza USA limity!
});

// Zabezpieczający Exponential Pacing Limit Quota u Brokera, na tysiącach szukajek B2B !
async function callGeminiWithRetry(fn: () => Promise<any>, retries = 3, delay = 3000): Promise<any> {
    try {
        return await fn();
    } catch (error: any) {
        const errorText = error.toString() || "";
        const isRateLimit = errorText.includes("429") || errorText.includes("RESOURCE_EXHAUSTED");
        if (isRateLimit && retries > 0) {
            console.warn(`[BROKER R-M-S 💰] Siec rozgrzana u wycen! Chmur odpoczywa: ${delay / 1000}s do podjęcia nowej puli RMS!`);
            await new Promise(resolve => setTimeout(resolve, delay));
            return callGeminiWithRetry(fn, retries - 1, delay * 2);
        }
        throw error;
    }
}

// Błyskotliwa Nowatorska Schemata wyliczeniowa 
const BROKER_RMS_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        prices: {
            type: Type.ARRAY,
            description: "Odłowiona paleta wycen dla hurtownego lub parametrycznie wykonanego składu rynków (Polska).",
            items: {
                type: Type.OBJECT,
                properties: {
                    id: { type: Type.STRING },
                    R_KosztNetto: { type: Type.NUMBER, description: "Taryfikacja Pracy i brygady [Robocizna na 1 JEDNOSTKĘ (z kosztami pobocznymi)] zł" },
                    M_KosztHurtowyNetto: { type: Type.NUMBER, description: "B2B [Materiał]: Czysto materiał bez prac narzutowych z katalogów KNR" },
                    S_KosztSprzetuNetto: { type: Type.NUMBER, description: "[Sprzęt ciężki lub elektronarzedzi do tego procesu mierzona roboczo, zl za M2 itp]" },
                    bazaCennikowZrodla: { type: Type.STRING, description: "Link lub krótka adnotacja katalogu norm dla audytu np(Ceny bistyp, Sekocenbud hurt budowlane XYZ.pl )" }
                },
                required: ["id", "R_KosztNetto", "M_KosztHurtowyNetto", "S_KosztSprzetuNetto", "bazaCennikowZrodla"]
            }
        }
    },
    required: ["prices"]
};

export async function POST(req: Request) {
    let tenderId: string | undefined;
    let taskId: string | undefined;
    let isSuccess = false;

    try {
        const body = await req.json();
        tenderId = body.tenderId;
        taskId = body.taskId;

        console.log(`[BROKER R-M-S 💰] Powitanie i przygotowywanie stopy Bazy R-M-S! tenderId: ${tenderId}, taskId: ${taskId}`);

        if (!tenderId || !taskId) return NextResponse.json({ error: "Brak Danych / tenderId / Tasku" }, { status: 400 });

        const taskRef = adminDb.collection(`tenders/${tenderId}/tasks`).doc(taskId);
        const taskDoc = await taskRef.get();

        if (!taskDoc.exists) throw new Error("Pojedyńczy Agent Task od Mózgu - zginął bezpowrotnie.");

        const taskData = taskDoc.data()!;
        if (taskData.status !== "PENDING") {
            return NextResponse.json({ message: "Szybka autoblokada, zignorowano!" });
        }

        console.log("[BROKER R-M-S 💰] Status IN_PROGRESS ... Poszukuje bezpośrednio w Rzeczywistych Szufladach Gotowych Do Kosztorysu.");
        await taskRef.update({ status: "IN_PROGRESS", updatedAt: new Date() });

        // PRZELAMANIE ARCHITEKTONICZNE: Agent Pobiera Ostatni Cykl Żywej Tabeli Pytaniem BEZ ZAJMOWANIA tokenow glowy Orkiestry. Szuka bezkarnie bez limits Token u Tenders-> Estimates .
        const estimateRef = adminDb.collection(`tenders/${tenderId}/estimate`);
        const sectionsSnap = await estimateRef.where("status", "==", "QUANTITY_READY").get();

        if (sectionsSnap.empty) {
            console.log(`[BROKER R-M-S 💰] Portfele Kosztów zamnkniete w sekcjach... Oczekuje bez operacji Bazy z sieci Internet. -> Kończę Proces Taskiem jako Pusto gotówkę`);
            await taskRef.update({ status: "DONE", rawResult: { message: "Sekcje na dzisiaj opróznione lub nie wyłożono kosztorysu gotowych item's." }, processedByBrain: false, updatedAt: new Date() });
            isSuccess = true;
            return NextResponse.json({ message: "Sekcje Empty!" });
        }

        let totalTokensUsed = 0;
        let pricedItemsCount = 0;
        const globalBatch = adminDb.batch(); // Hurt do szybkiego zakopania wyników cenowych. Zwiększa czas przebycia do mrygnięcia 23k itemu bez zajyakan !

        for (const sectionDoc of sectionsSnap.docs) {
            const sectionId = sectionDoc.id;

            // Standard - Wchodzi do "Pokoju Narzutów z sekcji i pyta ile leży Ilości" . Zgarniająć dokumentowe bazy . 
            const itemsSnap = await estimateRef.doc(sectionId).collection("items").get();
            const itemsInDB = itemsSnap.docs.map(d => ({ dbId: d.id, ...d.data() }));

            if (itemsInDB.length === 0) continue;

            console.log(`[BROKER R-M-S 💰] Badanie Urywane dla ${itemsInDB.length} cyfry Itemow - Przyjmuje zapytania z Hurtowi.. `);
            // Podsuń w pakiecach ryczałtem na mniejsze query na wielki JSON ! Skracając o 823 linie z google prompt 
            const searchQueryInput = itemsInDB.map((i: any) =>
                `Dok_ID: ${i.dbId} | Norma/Typ: ${i.KNR_ref || i.pozycja} | Robota Inż.: ${i.opis.substring(0, 60)} | Unit: ${i.jednostka}`
            ).join("\n");

            const rmbQueryHurtBroker = `Jesteś potężnym Gieldowo Zmieszanym Brokerem Wycen w sieci Polskich Dystrybucji Norm / Używającym B2B standardu rynkowego.  \n Przemebluj dla inwestora, i poinformuj Googlem Ceny Z KROJONĄ Strukturą M/S/R - na dzisiejszy kwartał rynkowych podzespołow inżynierstwa dla niższych elementów:\n${searchQueryInput} \n
Miej na uchu by oddalać sklepy OBI Casto za nie-inzynieryjne odleglości marz hurtowi dla budowlańca!. Pamiętaj nie wymyslaj radosnego tekstu , badź jak precyzyjnie operujący skalpel z JSON - bo plynem API na puste zwarcie wyrzuci Twój cyfrowy wysil na szkode Kosztorysa Firmie budowy - wiec TYLKO ryczałty dla 1 Jednostki M/S/R, by system po drugiej to odliczył ze mianownika u ilościowych . Jeśli KNR/RMS po szukaniach ma S= 0 to ustaw zero (np Rysownik murarstwa), M - Ustal . Sztywna cena pod hurtownie Netto PL. Wystarcz by była przyblizna 85%. \nWypełnij id jako w "Dok_ID" po badaniach...`;

            const searchResult = await callGeminiWithRetry(async () => {
                return await ai.models.generateContent({
                    model: taskData.modelOverride || MODEL_FLASH, // U Brokera Zalezalo czy puszczac cenniki - ale Flash w GCloud z narzuted GOOGLe-S Groundning odwala tutaj cuda ! Tnie tokeny o mili-grosze - Dziwne wahanie pingu minimalnie mniejsze dla hurt .  
                    contents: rmbQueryHurtBroker, // Skonsolide bez błędów w złącznym Typo  
                    config: {
                        tools: [{ googleSearch: {} }],
                        temperature: 0.1,
                        responseMimeType: "application/json",
                        responseSchema: BROKER_RMS_SCHEMA as any
                    }
                });
            });

            console.log("[BROKER R-M-S 💰] Uzykał rynnę kwotowania od hurtowieni! Ukladam je wg id...");
            const structuredResponses = JSON.parse(jsonrepair(searchResult.text ?? "{}"));
            totalTokensUsed += searchResult.usageMetadata?.totalTokenCount || 0;

            const responseMapDict = new Map<string, any>(
                (structuredResponses.prices || []).map((bData: any) => [bData.id, bData])
            );

            let calculatedTotalValueOnEstimatorDBLevel = 0;

            // Loop Przebiega wszystkie Item z Tabela DB w locie zapisując "Aktualności", uwalnianym CUDEM transparentnych śladow - Zmiana R/M/S prosto we `OPIS` - byś Pan Inzynier zobaczył w GUI koszt z suwakem - po jaku narzuca mu !. 
            for (const itemDBCache of itemsSnap.docs) {
                const liveObj = itemDBCache.data();
                const fetchedAgentBreak = responseMapDict.get(itemDBCache.id) || null;

                if (fetchedAgentBreak) {
                    // Wyliczenie jednostkowe total z narzutkami robocizn+Sprzet/hurt! Oraz Wsad całkowitego .   
                    const jnTotNetto = (Number(fetchedAgentBreak.R_KosztNetto) || 0) + (Number(fetchedAgentBreak.M_KosztHurtowyNetto) || 0) + (Number(fetchedAgentBreak.S_KosztSprzetuNetto) || 0);

                    // Dokładany narzut Mnożony dla Sekcji z sumowania (Dobra architekturowa statyst) !   
                    calculatedTotalValueOnEstimatorDBLevel += (Number(liveObj.ilosc) || 0) * jnTotNetto;

                    const modifiedTransaprentAdnotationDescp = `${liveObj.opis || ""} | [WYCENA WSK. HURT RMS/B2B: R:${fetchedAgentBreak.R_KosztNetto || 0}zł / M:${fetchedAgentBreak.M_KosztHurtowyNetto || 0}zł / S:${fetchedAgentBreak.S_KosztSprzetuNetto || 0}zł | Z:(Goo Search Baza -> ${fetchedAgentBreak.bazaCennikowZrodla})].`;

                    globalBatch.update(itemDBCache.ref, {
                        cenaJed: jnTotNetto,
                        opis: modifiedTransaprentAdnotationDescp,
                        confidence: "HIGH",
                        sourceTrack: `${liveObj.sourceTrack || "Z narzuta B2B / Bazy"} 💰 Pieniedźe B2B Agent Google...`
                    });
                    pricedItemsCount++;
                } else {
                    console.log(`[BROKER R-M-S 💰] Uwagowy Skip Węzła: ${itemDBCache.id} zgubił Czystosc Odłamu Modelowgo AI! Po wstawkę narzut bedzies z zeronem netto PLN . .`)
                }
            }

            console.log(`[BROKER R-M-S 💰] Aktualizacja Głównej Kartoteki Sekcj u Costach... ${calculatedTotalValueOnEstimatorDBLevel.toFixed(2)} Sum ... !`);

            // Wyceny spalone narzucona flaga Zmiana Tla GUI frontedn - Zdjecia Statusu z Peding .. "Oznaczony Sekcje Pod Cena- Rzecz!" 
            globalBatch.update(sectionDoc.ref, {
                totalValue: calculatedTotalValueOnEstimatorDBLevel,
                status: "PRICED", // Odbębnij - Zaprezentowane do Przerwania Bicia Mozgiemu! DLA GUI wysła - Cena !   
                updatedAt: new Date()
            });

            console.log(`[BROKER R-M-S 💰] ... Czeka na podjecie następn. sekcje .`);
        }

        console.log(`[BROKER R-M-S 💰]  Przykręcam nakrętki - Wpisuja globalBatch uderzy ze statystymi . Zuzyłem Pule! . ... . `);

        globalBatch.update(taskRef, {
            status: "DONE",
            rawResult: { "wynikTrans": "Transkrybcja Uporczywych z Hurt M/S/R Włozonych - Pomysłowych", pricedOutQuant: pricedItemsCount },
            processedByBrain: false,
            costTokens: totalTokensUsed,
            updatedAt: new Date()
        });

        // Flash (do 4k wyplute od Gemini po grosze za Bazy w interneice do kosztorysown ) / u limit . .. ..!   
        const costToDBStore = (totalTokensUsed / 1000) * 0.000015;
        globalBatch.update(adminDb.collection("tenders").doc(tenderId), { "budgetGuard.currentCostUSD": FieldValue.increment(costToDBStore) });

        await globalBatch.commit();
        isSuccess = true;

        console.log(`[BROKER R-M-S 💰] Finisz Ręczy. Szypnięćie na GIEŁDZIE (w chmurce udanych Zł)... z wciagnieciu `)

        return NextResponse.json({ success: true, billedItemZ: pricedItemsCount });
    } catch (errx: any) {
        console.error("[BROKER R-M-S 💰] ❌ Brak funduszy  u radosci - Pytania Krytyczne Usterka: Bęad:", errx);
        if (tenderId && taskId) {
            await adminDb.collection(`tenders/${tenderId}/tasks`).doc(taskId).update({
                status: "ERROR", rawResult: { error: errx.message }, processedByBrain: false, updatedAt: new Date()
            }).catch(() => { });
        }
        return NextResponse.json({ error: errx.message }, { status: 500 });
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