// src/app/api/parse-audio/route.ts
import { NextResponse } from 'next/server';
import { GoogleGenAI, Type } from '@google/genai';

const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || 'pesam-system-81165',
    location: 'global'
});

export const maxDuration = 60;

export async function POST(req: Request) {
    try {
        const { audioUrl } = await req.json();

        if (!audioUrl) {
            return NextResponse.json({ error: "Brak linku do pliku audio" }, { status: 400 });
        }

        const audioResponse = await fetch(audioUrl);
        const arrayBuffer = await audioResponse.arrayBuffer();
        const base64Audio = Buffer.from(arrayBuffer).toString('base64');

        const systemInstruction = `
            Jesteś elitarnym inżynierem budownictwa i doradcą technicznym w PESAM. 
            Twoim zadaniem jest odsłuchanie nagrania głosowego kierownika budowy. Kierownicy często mówią skrótami myślowymi, chaotycznie, a w tle słychać hałas maszyn lub głosy innych robotników (całkowicie zignoruj hałas i głosy poboczne).
            
            Wyciągnij z nagrania zgrubne pozycje zakupowe, a następnie wykorzystaj swoją wiedzę o rynku materiałów budowlanych w Polsce, aby dla każdej zgrubnej pozycji zaproponować 3-4 dokładne, profesjonalne specyfikacje handlowe (wymiary, rodzaje, standardy), z których użytkownik będzie mógł wybrać właściwą.

            PRZYKŁAD ANALIZY:
            1. Usłyszano: "regipsy" -> Twoje sugestie:
               - "Płyta gipsowo-kartonowa standardowa GKB 1200x2000x12.5mm (Biała)"
               - "Płyta gipsowo-kartonowa wodoodporna GKBI 1200x2000x12.5mm (Zielona)"
               - "Płyta gipsowo-kartonowa ogniochronna GKF 1200x2000x12.5mm (Czerwona)"
            2. Usłyszano: "wkręty do regipsów" -> Twoje sugestie:
               - "Wkręty fosfatowane do konstrukcji metalowych (płyta-metal) CD/UD 3.5x25mm"
               - "Wkręty fosfatowane do konstrukcji drewnianych (płyta-drewno) 3.5x35mm"
               - "Wkręty samowiercące do łączenia profili metalowych ze sobą (pchełki) 3.5x9.5mm"
        `;

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [
                {
                    role: 'user',
                    parts: [
                        { text: "Przeanalizuj nagranie audio z budowy i wygeneruj profesjonalne sugestie techniczne dla każdej pozycji." },
                        {
                            inlineData: {
                                mimeType: "audio/mp3",
                                data: base64Audio
                            }
                        }
                    ]
                }
            ],
            config: {
                systemInstruction: systemInstruction,
                temperature: 0.1, // Niska temperatura gwarantuje trzymanie się standardów rynkowych
                responseMimeType: "application/json",
                responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                        items: {
                            type: Type.ARRAY,
                            description: "Lista pozycji wyodrębnionych z nagrania.",
                            items: {
                                type: Type.OBJECT,
                                properties: {
                                    roughName: {
                                        type: Type.STRING,
                                        description: "Zgrubna, dosłowna nazwa usłyszana z nagrania, np. 'regipsy', 'wkret do plyty'."
                                    },
                                    quantity: {
                                        type: Type.INTEGER,
                                        description: "Liczba sztuk / opakowań."
                                    },
                                    unit: {
                                        type: Type.STRING,
                                        description: "Jednostka miary (np. sztuka, karton, worek, opakowanie)."
                                    },
                                    suggestions: {
                                        type: Type.ARRAY,
                                        description: "3-4 profesjonalne, dokładne, polskie specyfikacje handlowe/techniczne odpowiadające temu produktowi, gotowe do zakupu.",
                                        items: { type: Type.STRING }
                                    }
                                },
                                required: ["roughName", "quantity", "unit", "suggestions"]
                            }
                        }
                    },
                    required: ["items"]
                }
            }
        });

        if (response.text) {
            let aiText = response.text.trim();
            aiText = aiText.replace(/```json/g, '').replace(/```/g, '').trim();
            const parsedJson = JSON.parse(aiText);
            return NextResponse.json(parsedJson, { status: 200 });
        } else {
            throw new Error("Pusta odpowiedź z API");
        }

    } catch (err: any) {
        console.error("Błąd transkrypcji audio:", err);
        return NextResponse.json({ error: err.message || "Błąd wewnętrzny" }, { status: 500 });
    }
}