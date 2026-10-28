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
            mimeType = 'audio/webm',
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

        // Pobierz aktualne miejsca składowania i ich zapełnienie
        let storageLocations: any[] = [];
        try {
            const capDoc = await adminDb.doc("settings/warehouse_capacity").get();
            if (capDoc.exists && Array.isArray(capDoc.data()?.locations) && capDoc.data()!.locations.length > 0) {
                storageLocations = capDoc.data()!.locations;
            }
        } catch (e) {
            console.warn("Błąd pobierania warehouse_capacity w API:", e);
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

        // Sformatuj informacje o miejscach składowania i ich zapełnieniu
        const storageLocationsFormatted = storageLocations.length > 0
            ? storageLocations.map(loc => {
                const fillPct = loc.totalCapacity > 0 ? Math.round(((loc.currentOccupied || 0) / loc.totalCapacity) * 100) : 0;
                const catNames = (loc.categories || []).map((catId: string) => {
                    const match = activeCategories.find(c => c.id === catId);
                    return match ? match.name : catId;
                }).join(', ');
                const status = fillPct >= (loc.criticalThreshold || 85)
                    ? '🚨 PRZEPEŁNIENIE KRYTYCZNE'
                    : fillPct >= (loc.alertThreshold || 70)
                        ? '⚠️ WYSOKIE ZAPEŁNIENIE (OSTRZEŻENIE)'
                        : '🟢 MIEJSCE DOSTĘPNE';
                return `- Miejsce: "${loc.name}" (Pojemność: ${loc.totalCapacity} JPP, Zajęte: ${loc.currentOccupied || 0} JPP, Zapełnienie: ${fillPct}% [${status}]) -> Składowane kategorie: [${catNames || 'brak'}]`;
            }).join('\n')
            : '';

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

            ${storageLocationsFormatted ? `STAN I MIEJSCA SKŁADOWANIA W MAGAZYNIE:
${storageLocationsFormatted}

ZASADA MIEJSC SKŁADOWANIA:
Dla każdego materiału sprawdź, do którego miejsca składowania należy jego kategoria.
Ustal 'storageLocation' jako nazwę tego miejsca (lub puste jeśli brak).
Jeśli to miejsce składowania ma wysokie zapełnienie (>= 70% lub krytyczne >= 85%), KONIECZNIE dopisz to w 'ruleNotes' (np. "Uwaga: Trafia na Plac Zewnętrzny, który jest zajęty w 70%!").
` : ''}

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
            8. 'ruleNotes' - zwięzły komentarz oceny reguł oraz ew. ostrzeżenie o zapełnieniu miejsca składowania.
            9. 'storageLocation' - nazwa miejsca składowania (np. 'Plac Zewnętrzny', 'Magazyn Farb i Chemii') lub null jeśli nieprzypisane.
            10. 'storageFillPercentage' - aktualny procent zapełnienia tego miejsca składowania w magazynie (liczba np. 70) lub null.
        `;

        const cleanMime = (mimeType || 'audio/webm').split(';')[0].trim() || 'audio/webm';

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [
                {
                    role: 'user',
                    parts: [
                        { text: "Przeanalizuj nagranie audio kierowcy z budowy, sporządź pełną transkrypcję, przypisz każdą pozycję do jednej z 12 głównych kategorii PESAM i zweryfikuj zgodność z regułami Szefa oraz Magazynu." },
                        {
                            inlineData: {
                                mimeType: cleanMime,
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
                                    },
                                    storageLocation: {
                                        type: Type.STRING,
                                        description: "Nazwa sugerowanego miejsca składowania (np. Plac Zewnętrzny, Magazyn Farb i Chemii) lub null."
                                    },
                                    storageFillPercentage: {
                                        type: Type.NUMBER,
                                        description: "Aktualny procent zapełnienia tego miejsca składowania (liczba od 0 do 100) lub null."
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
