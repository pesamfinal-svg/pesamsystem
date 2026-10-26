// src/app/api/parse-audio-residuals/route.ts
import { NextResponse } from 'next/server';
import { GoogleGenAI, Type } from '@google/genai';
import { RESIDUAL_MAIN_CATEGORIES } from '@/lib/constants/residualCategories';

import { adminDb } from '@/lib/firebase/admin';

const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || 'pesam-system-81165',
    location: 'global'
});

export const maxDuration = 60;

export async function POST(req: Request) {
    try {
        const {
            audioUrl,
            bossRules,
            warehouseRules,
            bossCategoryRules = {},
            warehouseCategoryRules = {}
        } = await req.json();

        if (!audioUrl) {
            return NextResponse.json({ error: "Brak linku do pliku audio" }, { status: 400 });
        }

        const audioResponse = await fetch(audioUrl);
        if (!audioResponse.ok) {
            return NextResponse.json({ error: "Nie udało się pobrać pliku audio" }, { status: 400 });
        }

        const arrayBuffer = await audioResponse.arrayBuffer();
        const base64Audio = Buffer.from(arrayBuffer).toString('base64');

        // Pobierz aktualne kategorie (jeśli były zmodyfikowane w Ustawieniach / Kreatorze)
        let activeCategories = RESIDUAL_MAIN_CATEGORIES;
        try {
            const catDoc = await adminDb.doc("settings/residual_categories").get();
            if (catDoc.exists && Array.isArray(catDoc.data()?.categories) && catDoc.data()!.categories.length > 0) {
                activeCategories = catDoc.data()!.categories;
            }
        } catch (e) {
            console.warn("Błąd pobierania residual_categories w API, używam domyślnych:", e);
        }

        // Sformatuj reguły per kategoria
        const categoryRulesFormatted = activeCategories.map(cat => {
            const bRule = bossCategoryRules[cat.id]?.trim();
            const wRule = warehouseCategoryRules[cat.id]?.trim();
            if (!bRule && !wRule) return null;
            return `--- Kategoria: ${cat.name} (${cat.id}) ---
${bRule ? `Wytyczne Szefa: ${bRule}` : ''}
${wRule ? `Wytyczne Magazynu: ${wRule}` : ''}`;
        }).filter(Boolean).join('\n\n');

        const categoriesList = activeCategories.map(c => 
            `- "${c.name}" (przykłady podkategorii: ${c.subcategories.slice(0, 5).join(', ')})`
        ).join('\n');

        const systemInstruction = `
            Jesteś inżynierem budowlanym i pracownikiem magazynu firmy PESAM.
            Twoim zadaniem jest odsłuchanie notatki głosowej nagranej przez kierowcę na budowie.
            Kierowca wymienia resztki budowlane, pozostałości materiałów, chemię budowlaną, profile, worki z klejem/gipsem, końcówki kabli itp., które zabiera z budowy do magazynu lub do utylizacji.

            OFICJALNYCH 12 GŁÓWNYCH KATEGORII W SYSTEMIE PESAM (MUSISZ DOKŁADNIE DOPASOWAĆ DO JEDNEJ Z NICH):
            ${categoriesList}

            ${bossRules ? `OGÓLNE REGUŁY I WYTYCZNE SZEFA / DYREKCJI FIRMY PESAM:\n"""${bossRules}"""\n` : ''}
            ${warehouseRules ? `OGÓLNE REGUŁY I WYTYCZNE MAGAZYNU GŁÓWNEGO PESAM:\n"""${warehouseRules}"""\n` : ''}

            ${categoryRulesFormatted ? `SZCZEGÓŁOWE REGUŁY DLA POSZCZEGÓLNYCH KATEGORII:\n${categoryRulesFormatted}\n` : ''}

            Zadanie:
            1. Zapisz dokładną, pełną transkrypcję mowy na tekst ('transcription') - dokładnie to, co kierowca powiedział w notatce.
            2. Wyodrębnij z nagrania wszystkie wymienione pozycje materiałowe ('residuals').
            Dla każdej pozycji ustal:
            1. 'name' - czytelna, standardowa polska nazwa materiału (np. 'Worek kleju do siatki', 'Profile sufitowe CD60 3m', 'Resztka farby białej gruntującej')
            2. 'category' - nazwa dokładnie jednej z 12 powyższych głównych kategorii (np. 'Kleje i Zaprawy', 'Pustaki, Bloczki i Cegły', 'Płyty GK i Profile' itd.)
            3. 'subcategory' - najbardziej pasująca podkategoria (np. 'Klej do siatki i styropianu', 'Bloczek gazobeton / termobet', 'Profile sufitowe CD60')
            4. 'quantity' - liczba sztuk, opakowań, worków, metrów (jeśli nie podano precyzyjnie liczby, przyjmij 1)
            5. 'unit' - jednostka miary: 'szt.', 'worek', 'opak.', 'mb', 'kg', 'm²', 'litr', 'wiaderko', 'paleta', 'krąg'
            6. 'isWaste' - wartość boolean: true jeśli kierowca mówi o śmieciach, zniszczonych odpadach, resztkach nienadających się do użycia; false jeśli materiał jest pełnowartościowy / użyteczny do ponownego wykorzystania.
            7. 'rulesCompliant' - wartość boolean: true jeśli materiał spełnia reguły ogólne oraz reguły swojej kategorii; false jeśli narusza jakąkolwiek regułę Szefa lub Magazynu.
            8. 'ruleNotes' - zwięzły komentarz oceny reguł (np. "Zgodne z regułami", "Niezgodne z regułą dla Kleje i Zaprawy: otwarty powyżej miesiąca", "Niezgodne z regułą magazynu: kabel poniżej 15m").
        `;

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [
                {
                    role: 'user',
                    parts: [
                        { text: "Przeanalizuj nagranie audio kierowcy z budowy, sporządź pełną transkrypcję, przypisz każdą pozycję do jednej z 12 głównych kategorii PESAM i zweryfikuj zgodność z regułami Szefa oraz Magazynu." },
                        {
                            inlineData: {
                                mimeType: "audio/webm",
                                data: base64Audio
                            }
                        }
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
                        transcription: {
                            type: Type.STRING,
                            description: "Dokładny, pełny zapis słowo w słowo całej wypowiedzi kierowcy z nagrania."
                        },
                        residuals: {
                            type: Type.ARRAY,
                            description: "Lista rozpoznanych resztek budowlanych z nagrania skategoryzowana do 12 głównych grup wraz z weryfikacją reguł.",
                            items: {
                                type: Type.OBJECT,
                                properties: {
                                    name: {
                                        type: Type.STRING,
                                        description: "Nazwa materiału lub resztki budowlanej."
                                    },
                                    category: {
                                        type: Type.STRING,
                                        description: "Dokładna nazwa jednej z 12 głównych kategorii PESAM."
                                    },
                                    subcategory: {
                                        type: Type.STRING,
                                        description: "Konkretna podkategoria materiału."
                                    },
                                    quantity: {
                                        type: Type.NUMBER,
                                        description: "Ilość materiału."
                                    },
                                    unit: {
                                        type: Type.STRING,
                                        description: "Jednostka miary (np. szt., worek, opak., mb, kg, litr)."
                                    },
                                    isWaste: {
                                        type: Type.BOOLEAN,
                                        description: "Czy jest to odpad do utylizacji."
                                    },
                                    rulesCompliant: {
                                        type: Type.BOOLEAN,
                                        description: "Czy pozycja spełnia reguły Szefa i Magazynu."
                                    },
                                    ruleNotes: {
                                        type: Type.STRING,
                                        description: "Ocena lub uwagi na podstawie reguł Szefa i Magazynu."
                                    }
                                },
                                required: ["name", "category", "subcategory", "quantity", "unit", "isWaste", "rulesCompliant", "ruleNotes"]
                            }
                        }
                    },
                    required: ["transcription", "residuals"]
                }
            }
        });

        if (response.text) {
            let aiText = response.text.trim();
            aiText = aiText.replace(/```json/g, '').replace(/```/g, '').trim();
            const parsedJson = JSON.parse(aiText);
            return NextResponse.json(parsedJson, { status: 200 });
        } else {
            return NextResponse.json({ transcription: "", residuals: [] }, { status: 200 });
        }

    } catch (err: any) {
        console.error("Błąd transkrypcji audio pozostałości:", err);
        return NextResponse.json({ 
            residuals: [],
            warning: "Błąd transkrypcji AI: " + (err.message || "Błąd wewnętrzny")
        }, { status: 200 }); // Zwracamy status 200 z pustą listą, aby nie blokować kierowcy
    }
}
