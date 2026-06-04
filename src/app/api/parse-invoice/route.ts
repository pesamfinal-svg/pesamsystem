// src/app/api/parse-invoice/route.ts
import { NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || 'pesam-system-81165',
    location: 'global'
});

export const maxDuration = 60;

export async function POST(req: Request) {
    try {
        const { files } = await req.json();

        if (!files || !Array.isArray(files) || files.length === 0) {
            return NextResponse.json({ error: "Brak plików do analizy" }, { status: 400 });
        }

        const systemInstruction = `
            Jesteś precyzyjnym systemem OCR i analizy dokumentów finansowo-serwisowych. 
            Twoim zadaniem jest przeanalizowanie przesłanych faktur i wyciągnięcie z nich danych.
            
            ZASADY KATEGORYZACJI (BARDZO WAŻNE):
            Musisz przypisać dokładnie JEDNĄ kategorię z poniższej listy. Przeanalizuj całą fakturę i oszacuj, która grupa napraw wygenerowała NAJWIĘKSZY koszt netto:
            - "Mechaniczna" (ogólne usterki mechaniczne, skrzynia, sprzęgło)
            - "Silnik" (rozrząd, turbina, wtryski, wydech, głowica, filtry DPF/FAP)
            - "Układ hamulcowy" (klocki, tarcze, zaciski, płyn) -> Zawsze wybieraj to zamiast 'Mechaniczna', jeśli hamulce to główny koszt!
            - "Zawieszenie i Układ kierowniczy" (amortyzatory, wahacze, zbieżność, drążki, sprężyny)
            - "Elektryczna i Elektronika" (diagnostyka komputerowa, sondy, czujniki, żarówki, wiązki)
            - "Klimatyzacja" (nabijanie czynnika, szczelność, kompresor klimatyzacji) -> Uwaga: jeśli na fakturze jest wymiana oleju, filtr kabinowy i serwis klimy, a klima była najdroższa - wybierz 'Klimatyzacja'.
            - "Opony i Wulkanizacja" (zakup opon, felg, przekładka, wyważanie) -> Zawsze wybieraj to dla opon!
            - "Akumulatory" (zakup akumulatora, alternator, rozrusznik)
            - "Eksploatacyjna (Oleje / Filtry / Płyny)" (standardowa wymiana oleju silnikowego, filtrów i płynów eksploatacyjnych)
            - "Blacharsko-Lakiernicza" (lakierowanie, naprawy blacharskie, wymiana szyby czołowej/bocznych)
            - "Przeglądy i Badania" (badania techniczne na stacji kontroli, legalizacje tacho)
            - "Inne" (pióra wycieraczek, kosmetyki, płyn do spryskiwaczy, holowanie, drobne akcesoria)

            INSTRUKCJA FORMATOWANIA:
            - Kwoty: Jeśli kwota zawiera przecinek (np. "981,53"), przekonwertuj ją na kropkę: 981.53.
            - Części: Usuwaj kody kreskowe i dziwne ciągi znaków (np. "140221:1146"). Zostawiaj same czytelne nazwy.
        `;

        const prompt = "Odczytaj dane z dokumentów i zwróć je w formacie zgodnym ze schematem JSON.";

        const inlineFilesParts = files.map((file: any) => ({
            inlineData: {
                mimeType: file.mimeType,
                data: file.fileBase64
            }
        }));

        const response = await ai.models.generateContent({
            model: 'gemini-3-flash-preview',
            contents: [
                {
                    role: 'user',
                    parts: [
                        { text: prompt },
                        ...inlineFilesParts
                    ]
                }
            ],
            config: {
                systemInstruction: systemInstruction,
                temperature: 0.1, // Niska temperatura = bardziej analityczne myślenie
                responseMimeType: "application/json",

                responseSchema: {
                    type: "OBJECT",
                    properties: {
                        date: {
                            type: "STRING",
                            description: "Data wystawienia faktury lub wykonania usługi w formacie YYYY-MM-DD."
                        },
                        cost: {
                            type: "NUMBER",
                            description: "Wartość netto całej faktury (Suma netto). Przekonwertuj polski przecinek na kropkę."
                        },
                        accountingNumber: {
                            type: "STRING",
                            description: "Numer faktury VAT, paragonu lub zlecenia naprawy."
                        },
                        mileage: {
                            type: "INTEGER",
                            description: "Przebieg pojazdu w kilometrach odczytany z dokumentów. Jeśli nie ma, zwróć 0."
                        },
                        location: {
                            type: "STRING",
                            description: "Nazwa wystawcy faktury / warsztatu."
                        },
                        comments: {
                            type: "STRING",
                            description: "Wygeneruj jedno krótkie, logiczne zdanie podsumowujące naprawę (np. 'Wymiana tarcz i klocków hamulcowych przód, serwis olejowy')."
                        },
                        category: {
                            type: "STRING",
                            description: "Wybierz dokładnie JEDNĄ wartość z listy: Mechaniczna, Silnik, Układ hamulcowy, Zawieszenie i Układ kierowniczy, Elektryczna i Elektronika, Klimatyzacja, Opony i Wulkanizacja, Akumulatory, Eksploatacyjna (Oleje / Filtry / Płyny), Blacharsko-Lakiernicza, Przeglądy i Badania, Inne."
                        },
                        partsList: {
                            type: "ARRAY",
                            items: { type: "STRING" },
                            description: "Lista wszystkich wymienionych części, materiałów i wykonanych usług odczytanych z pozycji faktury."
                        },
                        registrationNumber: {
                            type: "STRING",
                            description: "Numer rejestracyjny pojazdu lub VIN odczytany z faktury. Jeśli brak, zwróć puste string."
                        }
                    },
                    required: ["date", "cost", "accountingNumber", "mileage", "location", "comments", "category", "partsList"]
                }
            }
        });

        if (response.text) {
            let aiText = response.text.trim();
            aiText = aiText.replace(/```json/g, '').replace(/```/g, '').trim();

            const parsedJson = JSON.parse(aiText);
            return NextResponse.json(parsedJson, { status: 200 });
        } else {
            throw new Error("Pusta odpowiedź z API Gemini");
        }

    } catch (error: any) {
        console.error("Błąd podczas analizy plików przez Google Gen AI:", error);
        return NextResponse.json({ error: error.message || "Błąd wewnętrzny serwera" }, { status: 500 });
    }
}