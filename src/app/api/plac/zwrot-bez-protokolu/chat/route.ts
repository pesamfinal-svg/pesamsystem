// src/app/api/plac/zwrot-bez-protokolu/chat/route.ts
// Głosowy asystent AI dla Magazyniera PESAM - zwroty bez protokołu

import { NextResponse } from 'next/server';
import { GoogleGenAI, Type } from '@google/genai';
import { adminDb } from '@/lib/firebase/admin';
import { RESIDUAL_MAIN_CATEGORIES } from '@/lib/constants/residualCategories';

const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || 'pesam-system-81165',
    location: 'global'
});

export const maxDuration = 60;

function parsePolishQuantity(text: string): number | null {
    if (!text) return null;
    const clean = text.toLowerCase().trim();
    // Szukaj cyfry w tekście
    const digitMatch = clean.match(/\d+(\s*,\s*\d+)?/);
    if (digitMatch) {
        const val = parseFloat(digitMatch[0].replace(',', '.'));
        if (!isNaN(val) && val > 0) return val;
    }
    const polishNumbers: Record<string, number> = {
        "jeden": 1, "jedna": 1, "jedno": 1, "jednej": 1, "jednego": 1,
        "dwa": 2, "dwie": 2, "dwóch": 2, "dwoje": 2,
        "trzy": 3, "trzech": 3, "troje": 3,
        "cztery": 4, "czterech": 4, "czworo": 4,
        "pięć": 5, "piec": 5, "pięciu": 5, "pieciu": 5,
        "sześć": 6, "szesc": 6, "sześciu": 6, "szesciu": 6,
        "siedem": 7, "siedmiu": 7,
        "osiem": 8, "ośmiu": 8, "osmiu": 8,
        "dziewięć": 9, "dziewiec": 9, "dziewięciu": 9, "dziewieciu": 9,
        "dziesięć": 10, "dziesiec": 10, "dziesięciu": 10, "dziesieciu": 10,
        "jedenaście": 11, "jedenascie": 11,
        "dwanaście": 12, "dwanascie": 12,
        "trzynaście": 13, "trzynascie": 13,
        "czternaście": 14, "czternascie": 14,
        "piętnaście": 15, "pietnascie": 15,
        "szesnaście": 16, "szesnascie": 16,
        "siedemnaście": 17, "siedemnascie": 17,
        "osiemnaście": 18, "osiemnascie": 18,
        "dziewiętnaście": 19, "dziewietnascie": 19,
        "dwadzieścia": 20, "dwadziescia": 20,
        "trzydzieści": 30, "trzydziesci": 30,
        "czterdzieści": 40, "czterdziesci": 40,
        "pięćdziesiąt": 50, "piecdziesiat": 50,
        "sześćdziesiąt": 60, "szescdziesiat": 60,
        "siedemdziesiąt": 70, "siedemdziesiat": 70,
        "osiemdziesiąt": 80, "osiemdziesiat": 80,
        "dziewięćdziesiąt": 90, "dziewiecdziesiat": 90,
        "sto": 100, "dwieście": 200, "dwiescie": 200
    };
    // Rozbij tekst na słowa z uwzględnieniem polskich znaków diakrytycznych
    const words = clean.split(/[^a-zA-Z0-9ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]+/).filter(Boolean);
    for (const w of words) {
        if (polishNumbers[w] !== undefined) {
            return polishNumbers[w];
        }
    }
    return null;
}

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const {
            userMessage = '',
            history = [],
            photosCount = 0,
            currentDraft = {
                siteName: '',
                siteId: '',
                driver: '',
                reasonForNoProtocol: '',
                items: [],
                missingFields: [],
                isReadyToSave: false,
                shouldPromptPhoto: false,
                bypassAttempts: 0
            }
        } = body;

        if (!userMessage && history.length === 0) {
            return NextResponse.json({ error: "Brak wiadomości" }, { status: 400 });
        }

        // 1. Pobierz reguły zwrotów z Firestore
        let bossRules = "";
        let warehouseRules = "";
        let noProtocolRules = "";
        let noProtocolCategoryRules: Record<string, string> = {};
        let configuredBypassCode = "jebacto";

        try {
            const rulesSnap = await adminDb.doc("settings/residual_rules").get();
            if (rulesSnap.exists) {
                const data = rulesSnap.data() || {};
                bossRules = data.bossRules || "";
                warehouseRules = data.warehouseRules || "";
                noProtocolRules = data.noProtocolRules || "";
                noProtocolCategoryRules = data.noProtocolCategoryRules || {};
            }
        } catch (e) {
            console.warn("Błąd pobierania residual_rules w API chatu:", e);
        }

        try {
            const sysSnap = await adminDb.doc("settings/system").get();
            if (sysSnap.exists) {
                configuredBypassCode = sysSnap.data()?.noProtocolBypassCode || "jebacto";
            }
        } catch (e) {
            console.warn("Błąd pobierania settings/system:", e);
        }

        // 2. Pobierz aktualne kategorie
        let categories = RESIDUAL_MAIN_CATEGORIES;
        try {
            const catDoc = await adminDb.doc("settings/residual_categories").get();
            if (catDoc.exists && Array.isArray(catDoc.data()?.categories) && catDoc.data()!.categories.length > 0) {
                categories = catDoc.data()!.categories;
            }
        } catch (e) {
            console.warn("Błąd pobierania residual_categories:", e);
        }

        // 3. Pobierz listę aktywnych budów z Firestore
        let sites: Array<{ id: string; name: string }> = [];
        try {
            const sitesSnap = await adminDb.collection("sites").limit(100).get();
            sites = sitesSnap.docs.map(doc => ({
                id: doc.id,
                name: (doc.data()?.name || "").trim()
            })).filter(s => s.name);
        } catch (e) {
            console.warn("Błąd pobierania budów:", e);
        }

        const knownSite = currentDraft?.siteName?.trim() || "";
        const knownDriver = currentDraft?.driver?.trim() || "";
        const knownReason = currentDraft?.reasonForNoProtocol?.trim() || "";
        const knownItems: any[] = Array.isArray(currentDraft?.items) ? currentDraft.items : [];

        // 4. Dopasuj budowę źródłową
        let matchedSite = sites.find(s =>
            knownSite && (s.name.toLowerCase() === knownSite.toLowerCase() || knownSite.toLowerCase().includes(s.name.toLowerCase()) || s.name.toLowerCase().includes(knownSite.toLowerCase()))
        );
        if (!matchedSite && userMessage) {
            matchedSite = sites.find(s => userMessage.toLowerCase().includes(s.name.toLowerCase()));
        }

        // 5. BŁYSKAWICZNE POBRANIE SPRZĘTU Z TEJ BUDOWY Z FIRESTORE (INVENTORY)
        let siteEquipmentList: Array<{ name: string; inventoryNumber?: string; type: string; qty: number }> = [];
        let siteEquipmentSummary = "Brak wskazanego lub zarejestrowanego sprzętu na tej budowie.";

        if (matchedSite) {
            try {
                const invSnap = await adminDb.collection("inventory")
                    .where(`allocations.${matchedSite.id}`, ">", 0)
                    .limit(60)
                    .get();

                if (!invSnap.empty) {
                    siteEquipmentList = invSnap.docs.map(d => {
                        const data = d.data();
                        return {
                            name: data.name || "Nieznany sprzęt",
                            inventoryNumber: data.inventoryNumber || "",
                            type: data.type || "BULK",
                            qty: Number(data.allocations?.[matchedSite!.id]) || 1
                        };
                    });

                    siteEquipmentSummary = `WYKAZ SPRZĘTU AKTUALNIE PRZYPISANEGO DO BUDOWY "${matchedSite.name}" W BAZIE PESAM:\n` +
                        siteEquipmentList.map(it =>
                            `- ${it.name} [Typ: ${it.type}${it.inventoryNumber ? `, Nr mag: ${it.inventoryNumber}` : ""}, Na stanie budowy: ${it.qty} szt.]`
                        ).join("\n");
                } else {
                    siteEquipmentSummary = `Na budowie "${matchedSite.name}" w systemie nie figuruje obecnie żaden sprzęt z katalogu.`;
                }
            } catch (invErr) {
                console.warn("Błąd pobierania sprzętu budowy:", invErr);
            }
        }

        // Formatowanie reguł dla promptu
        const formattedCategoryRules = categories.map(cat => {
            const catRule = noProtocolCategoryRules[cat.id]?.trim();
            if (!catRule) return null;
            return `Kategoria "${cat.name}" (${cat.id}):\nWytyczna: ${catRule}`;
        }).filter(Boolean).join("\n\n");

        const systemInstruction = `
Jesteś profesjonalnym Asystentem Magazynu firmy PESAM obsługującym ZWROTY BEZ PROTOKOŁU (ZBP).
Twój rozmówca to magazynier na placu budowlanym przyjmujący materiały lub sprzęt bez protokołu.

BARDZO WAŻNE - FORMAT ODPOWIEDZI:
Twoja odpowiedź w polu "speechReply" ZOSTANIE ODCZYTANA NA GŁOS przez syntezator mowy (Text-To-Speech).
- Pisz czystym tekstem, BEZ GWIAZDEK, bez formatowania Markdown, bez list punktowanych!
- Zadawaj JEDNO konkretne pytanie na raz. Maksymalnie 1-2 zdania.
- Zero small-talk. Zero powitań. Tylko konkretne pytania i potwierdzenia.

STAN WIEDZY KTÓRY JUŻ POSIADASZ:
- Budowa źródłowa: ${knownSite ? `USTALONA: "${knownSite}" (BEZWZGLĘDNY ZAKAZ PYTANIA PONOWNIE!)` : "BRAK"}
- Kierowca / Zdający: ${knownDriver ? `USTALONY: "${knownDriver}" (BEZWZGLĘDNY ZAKAZ PYTANIA PONOWNIE!)` : "BRAK"}
- Powód braku protokołu: ${knownReason ? `USTALONY: "${knownReason}" (BEZWZGLĘDNY ZAKAZ PYTANIA PONOWNIE!)` : "BRAK"}
- Zarejestrowane pozycje: ${knownItems.length > 0 ? JSON.stringify(knownItems) : "Brak"}

AKTYWNE REGUŁY ZWROTÓW W SYSTEMIE PESAM (z bazy Firestore):
${noProtocolRules || "Brak dodatkowych reguł tekstowych."}

${formattedCategoryRules ? `WYTYCZNE DLA KATEGORII:\n${formattedCategoryRules}` : ""}

SZCZEGÓŁOWE ZASADY PROCEDURY ZWROTU BEZ PROTOKOŁU:
1. SAM BRAK PROTOKOŁU JEST NARUSZENIEM: Zawsze ustal dlaczego kierownik/kierowca nie wystawił protokołu.
2. PALETY (EUROPALETY, JEDNORAZOWE, MIESZANKI):
   BEZWZGLĘDNY ZAKAZ ZWÓZKI PALET NA BAZĘ! Palet nie zwozi się na magazyn.
   Każdy zwrot palet na plac traktuj ZAWSZE jako NARUSZENIE REGUŁ:
   - Ustaw: isRuleCompliant: false, requiresPhoto: true.
   - Jeśli magazynier podał, że palety są uszkodzone ("uszkodzona część"), ustaw condition: "USZKODZONY".
   - W ruleNotes wpisz RZECZYWISTY POWÓD ZGŁOSZONY PRZEZ MAGAZYNIERA: "Zwózka palet na bazę (zakaz zwózki palet na magazyn). Uszkodzona część palet." (lub dokładnie to co podał magazynier).
   - BEZWZGLĘDNY ZAKAZ wpisywania "brak segregacji i spięcia taśmą" dla palet!
3. WIARYGODNOŚĆ RULENOTES (ŻELAZNA ZASADA):
   Pole 'ruleNotes' musi precyzyjnie opisywać rzeczywisty powód naruszenia lub stan podany przez magazyniera (np. uszkodzenia, pęknięcia, brak numeru seryjnego, zwózka zabronionego materiału). Zakaz wklejania szablonowych tekstów niezwiązanych ze zgłoszeniem!
4. ILOŚCI (QUANTITY):
   Gdy magazynier podaje liczbę sztuk słownie (np. "dziewięć", "dwie", "pięć") lub cyfrą (np. "9"), bezwzględnie przekonwertuj to na liczbę w polu 'quantity' (np. 9). Nigdy nie zostawiaj pustej ilości.
5. ELEKTRONARZĘDZIA / MASZYNY (UNIQUE): Każde musi mieć numer magazynowy. Zapytaj jeśli nie padł!
6. STAN TECHNICZNY: Musi być określony stan — SPRAWNY lub USZKODZONY.
7. RUSZTOWANIA / OSPRZĘT (BULK): Muszą być przeliczone — zapytaj o dokładną ilość.
8. POZOSTAŁOŚCI I MATERIAŁY: Jeśli to materiały sypkie/resztki, zapytaj czy są zabezpieczone do składowania.
9. WYKRYWANIE PRZERZUTÓW MIĘDZY BUDOWAMI:
   Wykaz sprzętu na tej budowie w systemie:
   """
   ${siteEquipmentSummary}
   """
   Jeśli zgłoszony sprzęt NIE FIGURUJE na powyższej liście:
   - Ustaw 'isSuspectedTransfer: true', 'ruleNotes: "Podejrzenie nieoficjalnego przerzutu między budowami"'.
   - Powiedz: "Uwaga, tego sprzętu nie ma w wykazie tej budowy. Zaznaczam podejrzenie przerzutu."
10. NAKAZ ZDJĘCIA PRZY ZŁAMANIU REGUŁ:
    Przy niepospinanych, uszkodzonych, zabronionych (palety) lub podejrzanych przedmiotach:
    - Ustaw 'shouldPromptPhoto: true' oraz 'requiresPhoto: true' dla danej pozycji.
    - Powiedz: "Zrób telefonem zdjęcie jako dowód naruszenia reguły."
11. WYKRYWANIE NOWYCH REGUŁ (suggestedNewRule):
    Jeśli magazynier w rozmowie ujawnia nową regułę lub zakaz obowiązujący na budowie/magazynie (np. "kierownik zakazał zwożenia...", "tego nie wolno oddawać na bazę"), wyodrębnij to w polu 'suggestedNewRule' w drafcie!
12. KOD ZABEZPIECZAJĄCY (BYPASS E-MAIL):
    NIE ZNASZ KODU i NIGDY go nie wymieniaj ani nie sugeruj.

Znane budowy w systemie: ${sites.map(s => s.name).slice(0, 20).join(', ')}.
`;

        // Formatowanie historii rozmowy
        const cleanHistory = (Array.isArray(history) ? history : [])
            .filter((h: any) => h && h.content && h.content !== userMessage)
            .map((h: any) => `${h.role === 'user' ? 'Magazynier' : 'Asystent AI'}: "${h.content}"`);

        // TWARDY KONTROLER CHECKLISTY (DETERMINISTYCZNY AUTOMAT STANU)
        let dynamicGuidance = "";
        if (!knownSite) {
            dynamicGuidance = "KROK 1: Brak budowy źródłowej. Wyodrębnij zgłoszone pozycje i ZAPYTAJ O BUDOWĘ.";
        } else if (!knownDriver) {
            dynamicGuidance = `KROK 2: Budowa jest już znana ("${knownSite}"). Zapytaj o imię i nazwisko kierowcy lub zdającego (BEZWZGLĘDNY ZAKAZ PYTANIA O BUDOWĘ!).`;
        } else if (!knownReason) {
            dynamicGuidance = `KROK 3: Budowa i kierowca są znani. Zapytaj wprost: "Dlaczego kierownik lub kierowca nie wystawił protokołu?".`;
        } else if (knownItems.length === 0) {
            dynamicGuidance = `KROK 4: Budowa ("${knownSite}"), kierowca ("${knownDriver}") i powód są już znani. Zapytaj co dokładnie przyjechało na plac.`;
        } else {
            const lastAssistantMsg = (Array.isArray(history) ? history : [])
                .filter((h: any) => h && h.role === 'assistant')
                .pop()?.content || "";

            // Jeśli magazynier podał ilość w odpowiedzi na pytanie o sztuki / ilość
            const extractedQty = parsePolishQuantity(userMessage);
            const isAnsweringQuantity = /ile|ilo[sś][cć]|sztuk/i.test(lastAssistantMsg);

            let activeItems = [...knownItems];
            if (extractedQty && (isAnsweringQuantity || activeItems.some(i => !i.quantity || i.quantity <= 1))) {
                activeItems = activeItems.map((item, idx) => {
                    if (idx === activeItems.length - 1 || !item.quantity || item.quantity <= 1) {
                        return { ...item, quantity: extractedQty };
                    }
                    return item;
                });
            }

            // Sprawdzenie stanu poszczególnych pozycji
            const uniqueWithoutNr = activeItems.find(i =>
                (i.type === "UNIQUE" || (i.category && i.category.toLowerCase().includes("narzędz")) || (i.name && /młot|wiertark|agregat|szlifierk|betoniark|zagęszczark|poziomic|pilark/i.test(i.name))) &&
                !i.inventoryNumber
            );
            const itemWithoutCondition = activeItems.find(i =>
                (i.type === "UNIQUE" || (i.category && i.category.toLowerCase().includes("narzędz")) || /agregat|betoniark|młot|wiertark|maszyn|szlifierk/i.test(i.name)) &&
                !i.condition
            );
            const itemWithoutQuantity = activeItems.find(i =>
                i.quantity === undefined || i.quantity === null || isNaN(Number(i.quantity)) || Number(i.quantity) <= 0
            );
            const unverifiedSecured = activeItems.find(i =>
                i.type !== "UNIQUE" && !/palet/i.test(i.name || "") && (i.isSecured === null || i.isSecured === undefined)
            );
            const brokenRulesItem = activeItems.find(i =>
                (i.isSecured === false || i.condition === "USZKODZONY" || i.isSuspectedTransfer === true || /palet/i.test(i.name || "")) && !i.requiresPhoto
            );

            if (uniqueWithoutNr) {
                dynamicGuidance = `Elektronarzędzie / maszyna "${uniqueWithoutNr.name}" wymaga numeru magazynowego. Zapytaj WYŁĄCZNIE: "Jaki jest numer magazynowy dla: ${uniqueWithoutNr.name}?".`;
            } else if (itemWithoutQuantity) {
                dynamicGuidance = `Pozycja "${itemWithoutQuantity.name}" nie ma ustalonej ilości. Zapytaj WYŁĄCZNIE: "Ile sztuk ${itemWithoutQuantity.name} przyjechało do zwrotu?".`;
            } else if (itemWithoutCondition) {
                dynamicGuidance = `Sprzęt "${itemWithoutCondition.name}" wymaga określenia stanu technicznego. Zapytaj: "Czy ${itemWithoutCondition.name} jest sprawne, czy uszkodzone?".`;
            } else if (unverifiedSecured) {
                dynamicGuidance = `Zgłoszono: "${unverifiedSecured.name}". Zapytaj czy materiały są zabezpieczone, pospinane taśmą i posegregowane do składowania.`;
            } else if (brokenRulesItem) {
                dynamicGuidance = `Wykryto naruszenie reguł (${brokenRulesItem.name}). Nakaz magazynierowi: "Proszę zrób teraz telefonem zdjęcie jako dowód naruszenia reguły". Ustaw shouldPromptPhoto: true.`;
            } else {
                // =========================================================================
                // DETERMINISTYCZNY AUTOMAT FAZY KODU ZABEZPIECZAJĄCEGO (BYPASS ALERTU E-MAIL)
                // Wszystkie dane zwrotu są już zebrane i zweryfikowane!
                // AI nie zna kodu — backend decyduje deterministycznie w 100%.
                // =========================================================================
                const isCodePhaseActive = /kod zabezpieczaj|pomin[aą][cć] wysy[lł]k|zatwierd[zź] bez kodu|kod/i.test(lastAssistantMsg);
                const previousAttempts = Number(currentDraft?.bypassAttempts) || 0;
                const userInput = userMessage.toLowerCase().trim();

                // Wykryj każdą formę rezygnacji z kodu / zgody na wysyłkę do dyrekcji
                const isDeclineCode = (
                    /(bez|brak|nie\s+mam|pomi[nń]|olej).*kod/i.test(userInput) ||
                    /(wy[sś]l|kierownictw|dyrekcj|zarz[aą]d)/i.test(userInput) ||
                    /(zatwierd[zź]|zapisz|zapisuj|tak|potwierd[zź]|gotowe|koniec)/i.test(userInput) ||
                    userInput === "nie" || userInput === "bez" || userInput === "nie mam" || userInput === "brak"
                );

                if (isCodePhaseActive) {
                    if (isDeclineCode) {
                        // Użytkownik rezygnuje z kodu — zapisujemy z powiadomieniem do dyrekcji
                        return NextResponse.json({
                            speechReply: "Zatwierdzam zwrot. Wysyłam powiadomienie do dyrekcji.",
                            draft: {
                                siteName: knownSite,
                                siteId: matchedSite?.id || currentDraft?.siteId || "",
                                driver: knownDriver,
                                reasonForNoProtocol: knownReason,
                                items: activeItems,
                                missingFields: [],
                                isReadyToSave: true,
                                shouldPromptPhoto: false,
                                bypassCode: "",
                                bypassAttempts: previousAttempts
                            },
                            quickReplies: ["Zapisano zwrot"]
                        });
                    }

                    // Użytkownik podał próbę kodu
                    const candidateCode = userMessage.trim()
                        .replace(/^(m[oó]j\s+)?(kod|has[lł]o)(\s+to)?\s*[:=-]?\s*/i, '')
                        .trim();

                    const isCodeCorrect = candidateCode.toLowerCase() === configuredBypassCode.toLowerCase();

                    if (isCodeCorrect) {
                        // Poprawny kod — zatwierdzamy z wyłączonym alertem
                        return NextResponse.json({
                            speechReply: "Kod zabezpieczający poprawny. Zatwierdzam zwrot bez wysyłania alertu do dyrekcji.",
                            draft: {
                                siteName: knownSite,
                                siteId: matchedSite?.id || currentDraft?.siteId || "",
                                driver: knownDriver,
                                reasonForNoProtocol: knownReason,
                                items: activeItems,
                                missingFields: [],
                                isReadyToSave: true,
                                shouldPromptPhoto: false,
                                bypassCode: configuredBypassCode,
                                bypassAttempts: previousAttempts
                            },
                            quickReplies: ["Zapisano zwrot"]
                        });
                    }

                    // Błędny kod
                    const newAttempts = previousAttempts + 1;
                    if (newAttempts >= 3) {
                        return NextResponse.json({
                            speechReply: "Przekroczono limit prób kodu. Zatwierdzam zwrot z wysyłką powiadomienia do dyrekcji.",
                            draft: {
                                siteName: knownSite,
                                siteId: matchedSite?.id || currentDraft?.siteId || "",
                                driver: knownDriver,
                                reasonForNoProtocol: knownReason,
                                items: activeItems,
                                missingFields: [],
                                isReadyToSave: true,
                                shouldPromptPhoto: false,
                                bypassCode: "",
                                bypassAttempts: newAttempts
                            },
                            quickReplies: ["Zapisano zwrot"]
                        });
                    } else {
                        return NextResponse.json({
                            speechReply: `Błędny kod zabezpieczający. Próba ${newAttempts} z 3. Podaj poprawny kod lub powiedz "zatwierdź bez kodu".`,
                            draft: {
                                siteName: knownSite,
                                siteId: matchedSite?.id || currentDraft?.siteId || "",
                                driver: knownDriver,
                                reasonForNoProtocol: knownReason,
                                items: activeItems,
                                missingFields: [],
                                isReadyToSave: false,
                                shouldPromptPhoto: false,
                                bypassCode: "",
                                bypassAttempts: newAttempts
                            },
                            quickReplies: ["Zatwierdź — wyślij do dyrekcji", "Mam kod"]
                        });
                    }
                } else {
                    // Pierwsze wejście w fazę kodu — pytamy magazyniera
                    return NextResponse.json({
                        speechReply: "Podaj kod zabezpieczający jeśli chcesz pominąć wysyłkę do dyrekcji. Albo zatwierdź bez kodu.",
                        draft: {
                            siteName: knownSite,
                            siteId: matchedSite?.id || currentDraft?.siteId || "",
                            driver: knownDriver,
                            reasonForNoProtocol: knownReason,
                            items: activeItems,
                            missingFields: [],
                            isReadyToSave: false,
                            shouldPromptPhoto: false,
                            bypassCode: "",
                            bypassAttempts: 0
                        },
                        quickReplies: ["Zatwierdź — wyślij do dyrekcji", "Mam kod"]
                    });
                }
            }
        }

        const conversationContext = [
            `CHECKLISTA ZWROTU I FAKTY:\n- Budowa: "${knownSite || 'brak'}"\n- Kierowca: "${knownDriver || 'brak'}"\n- Powód braku protokołu: "${knownReason || 'brak'}"\n- Pozycje: ${JSON.stringify(knownItems)}`,
            `DEDYKOWANY CEL NA TEN KROK:\n${dynamicGuidance}`,
            cleanHistory.length > 0 ? `HISTORIA POPRZEDNICH WYPOWIEDZI:\n${cleanHistory.join('\n')}` : '',
            `NAJNOWSZA WYPOWIEDŹ MAGAZYNIERA TERAZ: "${userMessage}"`
        ].filter(Boolean).join('\n\n');

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [
                {
                    role: 'user',
                    parts: [
                        { text: conversationContext }
                    ]
                }
            ],
            config: {
                systemInstruction: systemInstruction,
                temperature: 0.1,
                responseMimeType: "application/json",
                responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                        speechReply: {
                            type: Type.STRING,
                            description: "Zwięzła, naturalna odpowiedź bez markdown przeznaczona do odczytania na głos przez syntezator mowy (1-2 zdania)."
                        },
                        draft: {
                            type: Type.OBJECT,
                            description: "Aktualny stan zbieranego protokołu zwrotu",
                            properties: {
                                siteName: {
                                    type: Type.STRING,
                                    description: "Nazwa budowy źródłowej (zachowaj jeśli już była ustalona)"
                                },
                                siteId: {
                                    type: Type.STRING,
                                    description: "Identyfikator budowy w bazie jeśli dopasowano"
                                },
                                driver: {
                                    type: Type.STRING,
                                    description: "Imię i nazwisko kierowcy (zachowaj jeśli już było ustalone)"
                                },
                                reasonForNoProtocol: {
                                    type: Type.STRING,
                                    description: "Powód braku protokołu od kierownika lub kierowcy"
                                },
                                items: {
                                    type: Type.ARRAY,
                                    description: "Lista zwracanych pozycji (zawsze zachowaj wcześniej dodane pozycje i zaktualizuj ich stan)",
                                    items: {
                                        type: Type.OBJECT,
                                        properties: {
                                            name: { type: Type.STRING },
                                            quantity: { type: Type.NUMBER },
                                            unit: { type: Type.STRING },
                                            category: { type: Type.STRING },
                                            type: {
                                                type: Type.STRING,
                                                description: "UNIQUE (narzędzia/maszyny), BULK (rusztowania/osprzęt) lub MATERIAL (drewno/resztki)"
                                            },
                                            inventoryNumber: {
                                                type: Type.STRING,
                                                description: "Numer magazynowy dla elektronarzędzi i maszyn (UNIQUE)"
                                            },
                                            condition: {
                                                type: Type.STRING,
                                                description: "Stan techniczny: SPRAWNY lub USZKODZONY"
                                            },
                                            isSecured: { 
                                                type: Type.BOOLEAN,
                                                description: "Czy materiał jest pospinany/posegregowany zgodnie z regułami" 
                                            },
                                            isRuleCompliant: {
                                                type: Type.BOOLEAN,
                                                description: "Czy spełnia reguły zwrotu bez protokołu"
                                            },
                                            ruleNotes: {
                                                type: Type.STRING,
                                                description: "Notatka dotycząca zgodności z regułami lub uwag magazyniera"
                                            },
                                            isSuspectedTransfer: {
                                                type: Type.BOOLEAN,
                                                description: "True jeśli sprzęt nie figurował na stanie tej budowy (podejrzenie przerzutu między budowami)"
                                            },
                                            requiresPhoto: {
                                                type: Type.BOOLEAN,
                                                description: "True jeśli materiał jest niepospinany, uszkodzony lub wymaga udokumentowania zdjęciem"
                                            }
                                        },
                                        required: ["name", "quantity", "unit", "category"]
                                    }
                                },
                                missingFields: {
                                    type: Type.ARRAY,
                                    description: "Lista brakujących informacji np. ['budowa', 'kierowca', 'powod_braku_protokolu', 'nr_magazynowy']",
                                    items: { type: Type.STRING }
                                },
                                isReadyToSave: {
                                    type: Type.BOOLEAN,
                                    description: "True jeśli magazynier potwierdził zapis kompletnego zwrotu"
                                },
                                shouldPromptPhoto: {
                                    type: Type.BOOLEAN,
                                    description: "True jeśli w tej turze aplikacja na telefonie powinna wyraźnie wymusić zrobienie zdjęcia"
                                },
                                bypassCode: {
                                    type: Type.STRING,
                                    description: "Dokładnie to co powiedział/wpisał użytkownik jako kod — backend zweryfikuje poprawność. Nie modyfikuj, nie uzupełniaj."
                                },
                                suggestedNewRule: {
                                    type: Type.STRING,
                                    description: "Nowa reguła lub zakaz dotyczący zwózki/magazynu, jeśli magazynier wspomniał o nowej zasadzie (np. 'Nie zwozimy palet na bazę')"
                                }
                            },
                            required: ["siteName", "driver", "items", "missingFields", "isReadyToSave"]
                        },
                        quickReplies: {
                            type: Type.ARRAY,
                            description: "2-4 krótkie podpowiedzi do kliknięcia na telefonie",
                            items: { type: Type.STRING }
                        }
                    },
                    required: ["speechReply", "draft", "quickReplies"]
                }
            }
        });

        const rawJson = response.text?.trim() || "{}";
        let parsed: any;
        try {
            parsed = JSON.parse(rawJson);
        } catch {
            const cleaned = rawJson.replace(/```json/g, '').replace(/```/g, '').trim();
            parsed = JSON.parse(cleaned);
        }

        // =========================================================================
        // ŻELAZNA OCHRONA PAMIĘCI (STATE MERGING GUARANTEE)
        // Nigdy nie pozwalamy modelowi wyzerować wcześniej zdobytej wiedzy!
        // =========================================================================
        const modelSite = parsed.draft?.siteName?.trim();
        const modelDriver = parsed.draft?.driver?.trim();
        const modelReason = parsed.draft?.reasonForNoProtocol?.trim();

        const finalSiteName = (modelSite && modelSite !== 'brak' && modelSite !== 'undefined')
            ? modelSite
            : knownSite;

        const finalDriver = (modelDriver && modelDriver !== 'brak' && modelDriver !== 'undefined')
            ? modelDriver
            : knownDriver;

        const finalReason = (modelReason && modelReason !== 'brak' && modelReason !== 'undefined')
            ? modelReason
            : knownReason;

        const modelBypass = parsed.draft?.bypassCode?.trim() || "";

        // =========================================================================
        // WALIDACJA KODU ZABEZPIECZAJĄCEGO PO STRONIE SERWERA
        // AI nie zna kodu — tylko przekazuje co powiedział użytkownik.
        // Backend decyduje czy kod jest poprawny.
        // =========================================================================
        const previousAttempts = Number(currentDraft?.bypassAttempts) || 0;

        // Sprawdź czy użytkownik podał cokolwiek jako kod (AI zapisuje to w bypassCode)
        const userProvidedCode = modelBypass !== "" && modelBypass !== "brak" && modelBypass !== "undefined";
        
        // Zweryfikuj poprawność po stronie serwera
        const isCodeCorrect = userProvidedCode && modelBypass === configuredBypassCode;
        
        // Zlicz błędne próby (tylko gdy podano niepusty, niepoprawny kod)
        const newBypassAttempts = userProvidedCode && !isCodeCorrect
            ? previousAttempts + 1
            : previousAttempts;

        // Ustal finalny kod: tylko jeśli backend potwierdził poprawność
        const finalBypass = isCodeCorrect ? configuredBypassCode : (currentDraft?.bypassCode === configuredBypassCode ? configuredBypassCode : "");

        const finalSiteId = parsed.draft?.siteId || matchedSite?.id || currentDraft?.siteId || "";

        // Łączenie pozycji
        let finalItems: any[] = [];
        const modelItems: any[] = Array.isArray(parsed.draft?.items) ? parsed.draft.items : [];

        // Bezpieczne wyodrębnienie ilości z wypowiedzi magazyniera (np. "dziewięć", "9")
        const extractedQty = parsePolishQuantity(userMessage);

        if (modelItems.length > 0) {
            finalItems = modelItems.map(mItem => {
                const existing = knownItems.find(k => 
                    k.name?.toLowerCase() === mItem.name?.toLowerCase() ||
                    (k.name && mItem.name && (k.name.toLowerCase().includes(mItem.name.toLowerCase()) || mItem.name.toLowerCase().includes(k.name.toLowerCase())))
                ) || (modelItems.length === 1 && knownItems.length === 1 ? knownItems[0] : undefined);

                const isPallet = /palet/i.test(mItem.name || "") || (existing?.name && /palet/i.test(existing.name));
                const requiresPhoto = mItem.requiresPhoto ?? (mItem.isSecured === false || mItem.condition === "USZKODZONY" || mItem.isSuspectedTransfer === true || isPallet || (existing?.requiresPhoto ?? false));

                let resolvedQty = (typeof mItem.quantity === 'number' && mItem.quantity > 0) ? mItem.quantity : undefined;
                if (!resolvedQty && extractedQty) resolvedQty = extractedQty;
                if (!resolvedQty && existing?.quantity) resolvedQty = existing.quantity;
                if (!resolvedQty) resolvedQty = 1;

                // Precyzyjne reguły dla palet (zakaz zwózki na bazę + uszkodzenia)
                let finalCondition = mItem.condition || existing?.condition || (isPallet ? "USZKODZONY" : "");
                let finalRuleNotes = mItem.ruleNotes || existing?.ruleNotes || "";
                let finalIsCompliant = mItem.isRuleCompliant !== undefined ? mItem.isRuleCompliant : (isPallet ? false : (existing?.isRuleCompliant ?? null));

                if (isPallet) {
                    finalIsCompliant = false;
                    if (!finalRuleNotes || finalRuleNotes.includes("brak segregacji")) {
                        finalRuleNotes = "Zwózka palet na bazę (zakaz zwózki palet na magazyn). Uszkodzona część palet.";
                    }
                }

                return {
                    ...existing,
                    ...mItem,
                    quantity: resolvedQty,
                    unit: mItem.unit || existing?.unit || "szt.",
                    category: mItem.category || existing?.category || (isPallet ? "Materiały" : "Inne Materiały, Drewno i Odpady"),
                    type: mItem.type || existing?.type || "MATERIAL",
                    inventoryNumber: mItem.inventoryNumber || existing?.inventoryNumber || "",
                    condition: finalCondition,
                    isSecured: isPallet ? false : (mItem.isSecured !== undefined ? mItem.isSecured : (existing?.isSecured ?? null)),
                    isRuleCompliant: finalIsCompliant,
                    ruleNotes: finalRuleNotes,
                    isSuspectedTransfer: mItem.isSuspectedTransfer !== undefined ? mItem.isSuspectedTransfer : (existing?.isSuspectedTransfer ?? false),
                    requiresPhoto: Boolean(requiresPhoto)
                };
            });
        } else if (knownItems.length > 0) {
            finalItems = knownItems.map(kItem => {
                if (extractedQty && (!kItem.quantity || kItem.quantity === 1)) {
                    return { ...kItem, quantity: extractedQty };
                }
                return kItem;
            });
        }

        // Auto-zapis nowo wykrytej reguły przez AI (np. z wypowiedzi magazyniera)
        const suggestedRule = parsed.draft?.suggestedNewRule?.trim() || "";
        if (suggestedRule && suggestedRule.length > 5) {
            try {
                const rulesRef = adminDb.doc("settings/residual_rules");
                const snap = await rulesRef.get();
                const currentRules = snap.data()?.noProtocolRules || "";
                if (!currentRules.toLowerCase().includes(suggestedRule.toLowerCase())) {
                    const updatedRules = `${currentRules}\n- NOWA REGUŁA (AI): ${suggestedRule}`;
                    await rulesRef.update({
                        noProtocolRules: updatedRules,
                        noProtocolUpdatedAt: new Date().toLocaleString("pl-PL"),
                        noProtocolUpdatedBy: "AI Asystent (z rozmowy na placu)"
                    });
                    console.log(`[AutoRule] Dopisano nową regułę do settings/residual_rules: "${suggestedRule}"`);
                }
            } catch (ruleErr) {
                console.warn("Błąd auto-zapisu reguły:", ruleErr);
            }
        }

        // Sprawdź czy brakujące pola są faktycznie brakujące
        const missingFields: string[] = [];
        if (!finalSiteName) missingFields.push("budowa");
        if (!finalDriver) missingFields.push("kierowca");
        if (!finalReason) missingFields.push("powód_braku_protokołu");
        if (finalItems.length === 0) missingFields.push("przedmioty");
        finalItems.forEach(it => {
            if ((it.type === "UNIQUE" || (it.category && it.category.toLowerCase().includes("narzędz"))) && !it.inventoryNumber) {
                missingFields.push(`nr_mag_${it.name}`);
            }
            if (it.isSecured === null && it.type !== "UNIQUE") {
                missingFields.push(`pospinanie_${it.name}`);
            }
        });

        const anyItemNeedsPhoto = finalItems.some(it => it.requiresPhoto || it.isSecured === false || it.condition === "USZKODZONY" || it.isSuspectedTransfer === true);
        const shouldPromptPhoto = Boolean(parsed.draft?.shouldPromptPhoto || (anyItemNeedsPhoto && photosCount === 0));

        const isReady = Boolean(parsed.draft?.isReadyToSave) && missingFields.length === 0;

        // Po 3 błędnych próbach kodu — wymuś zapis z wysyłką e-mail
        const forceSaveAfterMaxAttempts = newBypassAttempts >= 3 && !isCodeCorrect;

        const responsePayload = {
            speechReply: parsed.speechReply,
            draft: {
                siteName: finalSiteName,
                siteId: finalSiteId,
                driver: finalDriver,
                reasonForNoProtocol: finalReason,
                items: finalItems,
                missingFields,
                isReadyToSave: isReady || forceSaveAfterMaxAttempts,
                shouldPromptPhoto,
                bypassCode: finalBypass,
                bypassAttempts: newBypassAttempts,
                suggestedNewRule: suggestedRule
            },
            // Nie zwracamy configuredBypassCode do frontendu — bezpieczeństwo
            quickReplies: Array.isArray(parsed.quickReplies) && parsed.quickReplies.length > 0
                ? parsed.quickReplies
                : ["Tak, zatwierdź", "Zapisz zwrot"]
        };

        return NextResponse.json(responsePayload);
    } catch (error: any) {
        console.error("Błąd API plac/zwrot-bez-protokolu/chat:", error);
        return NextResponse.json({
            speechReply: "Przepraszam, miałem chwilowy problem. Proszę powtórz odpowiedź.",
            draft: null,
            quickReplies: ["Powtórz", "Zatwierdź zwrot"],
            error: error?.message || "Internal server error"
        }, { status: 500 });
    }
}
