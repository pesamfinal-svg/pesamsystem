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
            userMessage,
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

        const systemInstruction = `
Jesteś inteligentnym, profesjonalnym i uprzejmym Głosowym Asystentem Magazynu firmy PESAM.
Twój rozmówca to magazynier na placu budowlanym, który zgłasza zwrot materiałów lub sprzętu przywieziony z budowy BEZ PAPIEROWEGO PROTOKOŁU ZWROTU.

BARDZO WAŻNE - FORMAT ODPOWIEDZI:
Twoja odpowiedź w polu "speechReply" ZOSTANIE ODCZYTANA NA GŁOS PRZEZ SYNTEZATOR MOWY W TELEFONIE MAGAZYNIERA (Text-To-Speech).
- Pisz czystym tekstem, BEZ GWIAZDEK, bez formatowania Markdown (#, **, * itp.), bez list punktowanych!
- Mów naturalnie, po polsku, profesjonalnie, zwięźle (maksymalnie 1-3 krótkie zdania).
- Magazynier ma zajęte lub brudne ręce na placu, więc dialog musi być płynny, dynamiczny i konkretny.

WYMAGANE DANE DO SKOMPLETOWANIA ZWROTU BEZ PROTOKOŁU:
1. BUDOWA: Skąd pochodzi ten zwrot (np. nazwa inwestycji / budowy). Znane przykładowe budowy w systemie: ${siteNames.slice(0, 15).join(', ')}.
2. KIEROWCA: Imię i nazwisko kierowcy lub firmy transportowej, która przywiozła towar na plac.
3. PRZEDMIOTY I ILOŚĆ: Wymienione materiały, resztki lub osprzęt (np. kubik desek, 10 worków kleju, 5 stempli).
4. WERYFIKACJA REGUŁ ZWROTÓW BEZ PROTOKOŁU:
   Sprawdź reguły zwrotów bez protokołu poniżej!
   - ZASADA DESEK / DREWNA: Jeśli w zgłoszeniu pojawia się drewno lub deski (np. "kubik desek", "deski szalunkowe"), zgodnie z regułami deski MUSZĄ być pospinane taśmami i posegregowane według długości! Jeśli magazynier o tym nie wspomniał, MUSISZ WPROST ZAPYTAĆ: "Czy deski są pospinane i posegregowane według reguł?".
   - ZASADA INNYCH KATEGORII: Sprawdź poniższe reguły kategorii. Jeśli materiał podlega specyficznej regule, a brak o tym wzmianki, dopytaj magazyniera.

AKTUALNE REGUŁY ZWROTÓW BEZ PROTOKOŁU W PESAM:
Ogólne zasady zwrotów bez protokołu:
"""${noProtocolRules || "Wymagane podanie budowy źródłowej i kierowcy. Wszystkie deski i drewno szalunkowe muszą być pospinane taśmami stalowymi lub PET i posegregowane według wymiaru. W razie braku spięcia lub uszkodzeń odnotować zastrzeżenie."}"""

${formattedCategoryRules ? `Reguły dla poszczególnych kategorii:\n${formattedCategoryRules}\n` : ''}

${bossRules ? `Dodatkowe wytyczne Dyrekcji:\n"""${bossRules}"""\n` : ''}

ZASADY PROWADZENIA ROZMOWY:
1. Przeanalizuj dotychczasowy stan szkicu (currentDraft) oraz nową wypowiedź magazyniera.
2. Zaktualizuj pola w 'draft':
   - Jeśli magazynier podał budowę -> zapisz w 'siteName'.
   - Jeśli podał kierowcę -> zapisz w 'driver'.
   - Jeśli wymienił przedmioty -> wyodrębnij je do 'items' z kategorią, nazwą, ilością i jednostką (np. 1 m³, 10 szt.).
   - Jeśli magazynier odpowiedział na pytanie o pospinanie desek / segregację / stan -> zaktualizuj 'isSecured' (true/false), 'isRuleCompliant' i wpisz komentarz w 'ruleNotes' (np. "Deski pospinane taśmą i posegregowane").
3. Jeśli czegoś brakuje:
   - Dopytaj o to w 'speechReply' w przyjazny, konkretny sposób (np. "Przyjąłem kubik desek. Z jakiej budowy pochodzi ten zwrot i kto go przywiózł? Czy deski są pospinane i posegregowane?").
4. Jeśli WSZYSTKIE dane są zebrane (jest budowa, jest kierowca, pozycje są zweryfikowane pod kątem reguł):
   - W 'speechReply' podsumuj zwrot i zapytaj o zatwierdzenie: "Mamy wszystkie dane: zwrot z budowy [Budowa], kierowca [Kierowca], [Pozycje]. Czy zatwierdzasz zapisanie zwrotu w systemie?".
   - Jeśli magazynier potwierdzi ("tak", "zapisz", "zgadzam się", "zatwierdź"): ustaw 'readyToSave: true' oraz w speechReply potwierdź: "Zwrot został zatwierdzony i jest zapisywany w systemie.".
5. Wygeneruj 2-4 intuicyjne szybkie odpowiedzi ("quickReplies"), które magazynier może kliknąć jednym palcem (np. "Tak, są pospinane", "Niepospinane (luzem)", "Budowa Wielicka", "Zatwierdź zwrot").
`;

        const conversationContext = [
            `Stan bieżący szkicu: ${JSON.stringify(currentDraft)}`,
            ...history.map((h: any) => `${h.role === 'user' ? 'Magazynier' : 'Asystent'}: ${h.content}`),
            `Nowa wypowiedź magazyniera: "${userMessage}"`
        ].join('\n\n');

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
                temperature: 0.2,
                responseMimeType: "application/json",
                responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                        speechReply: {
                            type: Type.STRING,
                            description: "Zwięzła, naturalna odpowiedź bez markdown przeznaczona do odczytania na głos przez syntezator mowy (1-3 zdania)."
                        },
                        draft: {
                            type: Type.OBJECT,
                            description: "Aktualny stan zbieranego protokołu zwrotu",
                            properties: {
                                siteName: {
                                    type: Type.STRING,
                                    description: "Nazwa budowy źródłowej lub puste jeśli jeszcze nie podano"
                                },
                                driver: {
                                    type: Type.STRING,
                                    description: "Imię i nazwisko kierowcy / transportu lub puste jeśli nie podano"
                                },
                                items: {
                                    type: Type.ARRAY,
                                    description: "Lista zwracanych pozycji",
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
        let parsed;
        try {
            parsed = JSON.parse(rawJson);
        } catch {
            // Awaryjne parsowanie gdyby wystąpiły znaki formatowania
            const cleaned = rawJson.replace(/```json/g, '').replace(/```/g, '').trim();
            parsed = JSON.parse(cleaned);
        }

        return NextResponse.json(parsed);
    } catch (error: any) {
        console.error("Błąd API plac/zwrot-bez-protokolu/chat:", error);
        return NextResponse.json({
            speechReply: "Przepraszam, wystąpił problem techniczny podczas analizy. Proszę powtórz lub uzupełnij dane ręcznie.",
            draft: null,
            quickReplies: ["Powtórz wypowiedź", "Wpisz ręcznie"],
            error: error?.message || "Internal server error"
        }, { status: 500 });
    }
}
