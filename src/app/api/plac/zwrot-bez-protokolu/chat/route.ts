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
            currentDraft = {
                siteName: '',
                driver: '',
                items: [],
                missingFields: [],
                isReadyToSave: false
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

        // 3. Pobierz listę aktywnych budów z Firestore (dla podpowiedzi i rozpoznawania)
        let siteNames: string[] = [];
        try {
            const sitesSnap = await adminDb.collection("sites").limit(50).get();
            siteNames = sitesSnap.docs.map(doc => doc.data()?.name).filter(Boolean);
        } catch (e) {
            console.warn("Błąd pobierania budów:", e);
        }

        // Formatowanie reguł dla promptu
        const formattedCategoryRules = categories.map(cat => {
            const catRule = noProtocolCategoryRules[cat.id]?.trim();
            if (!catRule) return null;
            return `Kategoria "${cat.name}" (${cat.id}):\nWytyczna: ${catRule}`;
        }).filter(Boolean).join("\n\n");

        const knownSite = currentDraft?.siteName?.trim() || "";
        const knownDriver = currentDraft?.driver?.trim() || "";
        const knownItems: any[] = Array.isArray(currentDraft?.items) ? currentDraft.items : [];

        const systemInstruction = `
Jesteś inteligentnym, profesjonalnym i uprzejmym Głosowym Asystentem Magazynu firmy PESAM.
Twój rozmówca to magazynier na placu budowlanym, który zgłasza zwrot materiałów lub sprzętu przywieziony z budowy BEZ PAPIEROWEGO PROTOKOŁU ZWROTU.

BARDZO WAŻNE - FORMAT ODPOWIEDZI:
Twoja odpowiedź w polu "speechReply" ZOSTANIE ODCZYTANA NA GŁOS PRZEZ SYNTEZATOR MOWY W TELEFONIE MAGAZYNIERA (Text-To-Speech).
- Pisz czystym tekstem, BEZ GWIAZDEK, bez formatowania Markdown (#, **, * itp.), bez list punktowanych!
- Mów naturalnie, po polsku, profesjonalnie, zwięźle (maksymalnie 1-2 krótkie, konkretne zdania).
- Magazynier ma zajęte ręce, więc dialog musi być dynamiczny.

STAN WIEDZY KTÓRY JUŻ POSIADASZ (BĄDŹ ŚWIADOMY CO JUŻ ZOSTAŁO POWIEDZIANE):
- Budowa źródłowa: ${knownSite ? `USTALONA: "${knownSite}" (BEZWZGLĘDNY ZAKAZ PYTANIA PONOWNIE!)` : "BRAK - zapytaj o budowę jeśli nie padła w tej wypowiedzi"}
- Kierowca / Zdający: ${knownDriver ? `USTALONY: "${knownDriver}" (BEZWZGLĘDNY ZAKAZ PYTANIA PONOWNIE!)` : "BRAK - zapytaj o kierowcę jeśli nie padł w tej wypowiedzi"}
- Zarejestrowane dotąd pozycje: ${knownItems.length > 0 ? JSON.stringify(knownItems) : "Brak pozycji - wyodrębnij z wypowiedzi"}

ŻELAZNA ZASADA PAMIĘCI I KONTYNUACJI:
1. JEŚLI BUDOWA JEST JUŻ USTALONA: NIGDY WIĘCEJ O NIĄ NIE PYTAJ! W polu draft.siteName zawsze przepisz "${knownSite || ""}".
2. JEŚLI KIEROWCA JEST JUŻ USTALONY: NIGDY WIĘCEJ O NIEGO NIE PYTAJ! W polu draft.driver zawsze przepisz "${knownDriver || ""}".
3. JEŚLI PRZEDMIOTY ZOSTAŁY JUŻ ZGŁOSZONE (np. deski), a teraz magazynier odpowiada na pytanie o pospinanie lub podaje budowę/kierowcę:
   - ZACHOWAJ dotychczasowe przedmioty w 'draft.items'!
   - Nie pytaj ponownie "co przyjechało", tylko odnotuj odpowiedź!
4. REGUŁA DLA DESEK / DREWNA:
   Jeśli zgłoszono drewno/deski, a nie ustalono jeszcze czy są spięte:
   Zapytaj TYLKO: "Czy deski są pospinane taśmą i posegregowane według reguł?".
   Gdy magazynier odpowie "tak, są spięte" lub podobnie:
   Zaktualizuj 'isSecured: true', 'isRuleCompliant: true' i przejdź do podsumowania! NIE PYTAJ PONOWNIE o budowę ani kierowcę jeśli już ich znasz!
5. PODSUMOWANIE I POTWIERDZENIE ZAPISU:
   Gdy mamy: budowę, kierowcę i zweryfikowane pozycje:
   Powiedz: "Mamy komplet: zwrot z budowy [Budowa], kierowca [Kierowca], [Pozycje]. Czy zatwierdzasz zapisanie w systemie?".
   Jeśli magazynier potwierdzi ("tak", "zapisz", "zatwierdź"): ustaw 'readyToSave: true' i powiedz: "Zwrot został zatwierdzony i jest zapisywany w systemie.".

AKTUALNE REGUŁY ZWROTÓW BEZ PROTOKOŁU W PESAM:
"""${noProtocolRules || "Wymagane podanie budowy źródłowej i kierowcy. Wszystkie deski i drewno szalunkowe muszą być pospinane taśmami stalowymi lub PET i posegregowane według wymiaru. W razie braku spięcia lub uszkodzeń odnotować zastrzeżenie."}"""

${formattedCategoryRules ? `Reguły dla poszczególnych kategorii:\n${formattedCategoryRules}\n` : ''}

${bossRules ? `Dodatkowe wytyczne Dyrekcji:\n"""${bossRules}"""\n` : ''}
Znane budowy w systemie: ${siteNames.slice(0, 15).join(', ')}.
`;

        // Formatowanie historii rozmowy
        const cleanHistory = (Array.isArray(history) ? history : [])
            .filter((h: any) => h && h.content && h.content !== userMessage)
            .map((h: any) => `${h.role === 'user' ? 'Magazynier' : 'Asystent AI'}: "${h.content}"`);

        const conversationContext = [
            `FAKTY Z DOTYCHCZASOWEGO SZKICU:\n- Budowa: "${knownSite || 'brak'}"\n- Kierowca: "${knownDriver || 'brak'}"\n- Pozycje: ${JSON.stringify(knownItems)}`,
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
                                driver: {
                                    type: Type.STRING,
                                    description: "Imię i nazwisko kierowcy (zachowaj jeśli już było ustalone)"
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
                                            }
                                        },
                                        required: ["name", "quantity", "unit", "category"]
                                    }
                                },
                                missingFields: {
                                    type: Type.ARRAY,
                                    description: "Lista brakujących informacji np. ['budowa', 'kierowca', 'pospinanie_desek']",
                                    items: { type: Type.STRING }
                                },
                                isReadyToSave: {
                                    type: Type.BOOLEAN,
                                    description: "True jeśli magazynier potwierdził zapis kompletnego zwrotu"
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

        const finalSiteName = (modelSite && modelSite !== 'brak' && modelSite !== 'undefined')
            ? modelSite
            : knownSite;

        const finalDriver = (modelDriver && modelDriver !== 'brak' && modelDriver !== 'undefined')
            ? modelDriver
            : knownDriver;

        // Łączenie pozycji
        let finalItems: any[] = [];
        const modelItems: any[] = Array.isArray(parsed.draft?.items) ? parsed.draft.items : [];

        if (modelItems.length > 0) {
            finalItems = modelItems.map(mItem => {
                const existing = knownItems.find(k => k.name?.toLowerCase() === mItem.name?.toLowerCase());
                return {
                    ...existing,
                    ...mItem,
                    quantity: mItem.quantity || existing?.quantity || 1,
                    unit: mItem.unit || existing?.unit || "szt.",
                    category: mItem.category || existing?.category || "Inne Materiały, Drewno i Odpady",
                    isSecured: mItem.isSecured !== undefined ? mItem.isSecured : (existing?.isSecured ?? null),
                    isRuleCompliant: mItem.isRuleCompliant !== undefined ? mItem.isRuleCompliant : (existing?.isRuleCompliant ?? null),
                    ruleNotes: mItem.ruleNotes || existing?.ruleNotes || ""
                };
            });
        } else {
            finalItems = knownItems;
        }

        // Sprawdź czy brakujące pola są faktycznie brakujące
        const missingFields: string[] = [];
        if (!finalSiteName) missingFields.push("budowa");
        if (!finalDriver) missingFields.push("kierowca");
        if (finalItems.length === 0) missingFields.push("przedmioty");
        finalItems.forEach(it => {
            if (it.isSecured === null || it.isSecured === undefined) {
                missingFields.push(`pospinanie_${it.name}`);
            }
        });

        const isReady = Boolean(parsed.draft?.isReadyToSave) && missingFields.length === 0;

        const responsePayload = {
            speechReply: parsed.speechReply,
            draft: {
                siteName: finalSiteName,
                driver: finalDriver,
                items: finalItems,
                missingFields,
                isReadyToSave: isReady
            },
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
