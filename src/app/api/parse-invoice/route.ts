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

        // TUTAJ JEST KLUCZ DO SUKCESU: Mocna instrukcja warunkowa dla AI
        const systemInstruction = `
            Jesteś precyzyjnym systemem OCR i analizy dokumentów finansowo-serwisowych. 
            Twoim zadaniem jest przeanalizowanie przesłanych faktur i wyciągnięcie z nich danych.
            
            ZASADY KATEGORYZACJI (BARDZO WAŻNE):
            Musisz wybrać JEDNĄ kategorię. Nie patrz na kolejność pozycji na fakturze! 
            Oszacuj wartościowo, która grupa napraw wygenerowała najwyższy koszt netto i na tej podstawie nadaj kategorię.
            - Przykład: Jeśli wymiana oleju/filtrów kosztuje 300 zł, a wymiana tarcz/klocków 1200 zł -> wybierz "Mechaniczna".
            - Kategorię "Eksploatacyjna" wybieraj TYLKO wtedy, gdy koszty filtrów, oleju i płynów stanowią zdecydowaną większość kwoty na fakturze.
            - Klocki i tarcze hamulcowe to ZAWSZE kategoria "Mechaniczna".

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
                            description: "Wybierz dokładnie JEDNĄ wartość z listy: Mechaniczna, Elektryczna, Zawieszenie, Silnik, Wulkanizacja, Lakiernicza, Eksploatacyjna, Inne."
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