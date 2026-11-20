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
Jesteś profesjonalnym Asystentem Magazynu firmy PESAM obsługującym ZWROTY BEZ PROTOKOŁU.
Twój rozmówca to magazynier na placu budowlanym przyjmujący zwrot z budowy.

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

BEZWZGLĘDNE REGUŁY ZWROTU BEZ PROTOKOŁU PESAM:
1. PROTOKÓŁ JEST WYMAGANY: Jeśli brak – zapytaj: "Dlaczego kierownik lub kierowca nie wystawił protokołu?".
2. ELEKTRONARZĘDZIA / MASZYNY (UNIQUE): Każde musi mieć numer magazynowy. Zapytaj jeśli nie padł!
3. STAN TECHNICZNY URZĄDZEŃ: Muszą mieć określony stan — sprawne lub uszkodzone.
4. RUSZTOWANIA / OSPRZĘT (BULK): Muszą być przeliczone — zapytaj o dokładną ilość.
5. POZOSTAŁOŚCI I MATERIAŁY: Muszą być pospinane taśmami i posegregowane.
6. WYKRYWANIE PRZERZUTÓW MIĘDZY BUDOWAMI:
   Wykaz sprzętu na tej budowie w systemie:
   """
   ${siteEquipmentSummary}
   """
   Jeśli zgłoszony sprzęt NIE FIGURUJE na powyższej liście:
   - Ustaw 'isSuspectedTransfer: true', 'ruleNotes: "Podejrzenie nieoficjalnego przerzutu między budowami"'.
   - Powiedz: "Uwaga, tego sprzętu nie ma w wykazie tej budowy. Zaznaczam podejrzenie przerzutu."
7. NAKAZ ZDJĘCIA PRZY ZŁAMANIU REGUŁ:
   Przy niepospinanych, uszkodzonych lub podejrzanych przedmiotach:
   - Ustaw 'shouldPromptPhoto: true' oraz 'requiresPhoto: true' dla danej pozycji.
   - Powiedz: "Zrób telefonem zdjęcie jako dowód naruszenia reguły."
8. KOD ZABEZPIECZAJĄCY (BYPASS E-MAIL):
   WAŻNE: NIE ZNASZ KODU i NIGDY go nie wymieniaj ani nie sugeruj.
   Gdy masz KOMPLET DANYCH (budowa, kierowca, powód, wszystkie pozycje zweryfikowane):
   Zapytaj WYŁĄCZNIE: "Podaj kod zabezpieczający jeśli chcesz pominąć wysyłkę do dyrekcji. Albo zatwierdź bez kodu."
   Ustaw quickReplies: ["Zatwierdź — wyślij do dyrekcji", "Mam kod"].
   Ustaw isReadyToSave: false i czekaj na odpowiedź.
   - Jeśli magazynier poda COKOLWIEK jako kod (dowolny ciąg znaków): ustaw bypassCode równe temu co podał — backend zweryfikuje poprawność.
   - Jeśli powie "nie", "bez kodu", "zatwierdź", "wyślij": ustaw bypassCode: "" oraz isReadyToSave: true.
   - Jeśli podał wcześniej błędny kod (bypassAttempts >= 1): poinformuj "Błędny kod, spróbuj ponownie lub zatwierdź z wysyłką."
   - Jeśli bypassAttempts >= 3: ustaw isReadyToSave: true, bypassCode: "". Powiedz: "Zatwierdzam z wysyłką do dyrekcji."
9. PODSUMOWANIE: Po ustaleniu kodu lub decyzji zatwierdź zapis.

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
            // Sprawdzenie stanu poszczególnych pozycji
            const uniqueWithoutNr = knownItems.find(i =>
                (i.type === "UNIQUE" || (i.category && i.category.toLowerCase().includes("narzędz")) || (i.name && /młot|wiertark|agregat|szlifierk|betoniark|zagęszczark|poziomic|pilark/i.test(i.name))) &&
                !i.inventoryNumber
            );
            const itemWithoutCondition = knownItems.find(i =>
                (i.type === "UNIQUE" || (i.category && i.category.toLowerCase().includes("narzędz")) || /agregat|betoniark|młot|wiertark|maszyn|szlifierk/i.test(i.name)) &&
                !i.condition
            );
            const unverifiedSecured = knownItems.find(i =>
                i.isSecured === null || i.isSecured === undefined
            );
            const brokenRulesItem = knownItems.find(i =>
                (i.isSecured === false || i.condition === "USZKODZONY" || i.isSuspectedTransfer === true) && !i.requiresPhoto
            );

            if (uniqueWithoutNr) {
                dynamicGuidance = `Elektronarzędzie / maszyna "${uniqueWithoutNr.name}" wymaga numeru magazynowego. Zapytaj WYŁĄCZNIE: "Jaki jest numer magazynowy dla: ${uniqueWithoutNr.name}?".`;
            } else if (itemWithoutCondition) {
                dynamicGuidance = `Sprzęt "${itemWithoutCondition.name}" wymaga określenia stanu technicznego. Zapytaj: "Czy ${itemWithoutCondition.name} jest sprawne, czy uszkodzone?".`;
            } else if (unverifiedSecured) {
                dynamicGuidance = `Zgłoszono: "${unverifiedSecured.name}". Zapytaj czy materiały są zabezpieczone, pospinane taśmą i posegregowane do składowania.`;
            } else if (brokenRulesItem) {
                dynamicGuidance = `Wykryto naruszenie reguł (${brokenRulesItem.name}). Nakaz magazynierowi: "Proszę zrób teraz telefonem zdjęcie jako dowód naruszenia reguły". Ustaw shouldPromptPhoto: true.`;
            } else {
                // Faza pytania o kod zabezpieczający — AI NIE zna kodu, tylko pyta ogólnie
                const previousAttempts = Number(currentDraft?.bypassAttempts) || 0;
                const userInput = userMessage.toLowerCase().trim();
                
                // Wykryj jawną rezygnację z kodu (bez próby podania kodu)
                const userDeclinedCode = userInput.includes("wyślij") || 
                                         userInput.includes("bez kodu") || 
                                         userInput.includes("zatwierdź") ||
                                         userInput.includes("wyslij") ||
                                         userInput.includes("zatwierdz");

                // Wykryj czy użytkownik próbował podać jakikolwiek kod (jest coś w bypassCode z drafta)
                const bypassAttempted = Boolean(currentDraft?.bypassCode && currentDraft.bypassCode !== "");

                if (previousAttempts >= 3) {
                    // Po 3 błędnych próbach — zapis z wysyłką
                    dynamicGuidance = `PRZEKROCZONO LIMIT PRÓB KODU (${previousAttempts} błędne próby). Poinformuj: "Przekroczono limit prób. Zatwierdzam zwrot z wysyłką do dyrekcji." Ustaw isReadyToSave: true, bypassCode: "".`;
                } else if (userDeclinedCode) {
                    dynamicGuidance = `Użytkownik rezygnuje z kodu — zatwierdź z wysyłką. Ustaw isReadyToSave: true, bypassCode: "". Powiedz: "Zatwierdzam, wysyłam powiadomienie do dyrekcji."`;
                } else if (!bypassAttempted) {
                    // Jeszcze nie pytano o kod — zapytaj po raz pierwszy (BEZ ujawniania kodu!)
                    dynamicGuidance = `MAMY KOMPLET DANYCH (Budowa: ${knownSite}, Kierowca: ${knownDriver}, Pozycje zweryfikowane).
ZAPYTAJ MAGAZYNIERA O KOD ZABEZPIECZAJĄCY (nie podawaj żadnej wartości kodu!):
Powiedz dokładnie: "Podaj kod zabezpieczający jeśli chcesz pominąć wysyłkę do dyrekcji. Albo zatwierdź bez kodu."
Ustaw isReadyToSave: false.
Ustaw quickReplies: ["Zatwierdź — wyślij do dyrekcji", "Mam kod"].`;
                } else {
                    // Użytkownik podał kod (bypassCode != "") — backend sprawdzi poprawność, AI potwierdza
                    dynamicGuidance = `Użytkownik podał kod zabezpieczający. Backend zweryfikuje jego poprawność.
Powiedz: "Przyjąłem. Sprawdzam kod i zapisuję zwrot." Ustaw isReadyToSave: true i zachowaj wartość bypassCode jaką podał użytkownik.`;
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

        if (modelItems.length > 0) {
            finalItems = modelItems.map(mItem => {
                const existing = knownItems.find(k => k.name?.toLowerCase() === mItem.name?.toLowerCase());
                const requiresPhoto = mItem.requiresPhoto ?? (mItem.isSecured === false || mItem.condition === "USZKODZONY" || mItem.isSuspectedTransfer === true || (existing?.requiresPhoto ?? false));

                return {
                    ...existing,
                    ...mItem,
                    quantity: mItem.quantity || existing?.quantity || 1,
                    unit: mItem.unit || existing?.unit || "szt.",
                    category: mItem.category || existing?.category || "Inne Materiały, Drewno i Odpady",
                    type: mItem.type || existing?.type || "MATERIAL",
                    inventoryNumber: mItem.inventoryNumber || existing?.inventoryNumber || "",
                    condition: mItem.condition || existing?.condition || "",
                    isSecured: mItem.isSecured !== undefined ? mItem.isSecured : (existing?.isSecured ?? null),
                    isRuleCompliant: mItem.isRuleCompliant !== undefined ? mItem.isRuleCompliant : (existing?.isRuleCompliant ?? null),
                    ruleNotes: mItem.ruleNotes || existing?.ruleNotes || "",
                    isSuspectedTransfer: mItem.isSuspectedTransfer !== undefined ? mItem.isSuspectedTransfer : (existing?.isSuspectedTransfer ?? false),
                    requiresPhoto: Boolean(requiresPhoto)
                };
            });
        } else {
            finalItems = knownItems;
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
        const shouldPromptPhoto = Boolean(parsed.draft?.shouldPromptPhoto || anyItemNeedsPhoto);

        if (anyItemNeedsPhoto && photosCount === 0) {
            missingFields.push("zdjęcie_naruszenia_reguł");
        }

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
                bypassAttempts: newBypassAttempts
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
