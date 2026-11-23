// src/app/api/biuro/driver-note/route.ts
// Zapisuje notatkę kierowcy (tekst lub transkrypt audio) powiązaną z numerem WZ.
// Gemini wyciąga z tekstu listę pozycji {name, quantity, unit}.
// Zapis do Firestore: driver_wz_notes/{auto-id}

import { NextResponse } from 'next/server';
import { GoogleGenAI, Type } from '@google/genai';
import { db } from '@/lib/firebase/config';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';

const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || 'pesam-system-81165',
    location: 'global'
});

export const runtime = 'nodejs';

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const { wz_ref, raw_text, driver_name, site_id } = body as {
            wz_ref: string;        // np. "WZT/963/11/2026/DE"
            raw_text: string;      // co kierowca powiedział / napisał
            driver_name?: string;
            site_id?: string;
        };

        if (!wz_ref || !raw_text) {
            return NextResponse.json({ error: 'Wymagane pola: wz_ref, raw_text' }, { status: 400 });
        }

        // Gemini Flash-Lite wyciąga pozycje z tekstu kierowcy
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash-lite',
            contents: [{
                role: 'user',
                parts: [{ text: `Kierowca budowy napisał/powiedział:\n"${raw_text}"\n\nWyciągnij z tego tekstu listę materiałów/towarów. Używaj potocznych nazw tak jak padły (nie tłumacz "regipsy" na "płyta G-K"). Liczby zamieniaj zawsze na cyfry.` }]
            }],
            config: {
                temperature: 0.1,
                responseMimeType: 'application/json',
                responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                        items: {
                            type: Type.ARRAY,
                            items: {
                                type: Type.OBJECT,
                                properties: {
                                    name: { type: Type.STRING, description: 'Nazwa materiału tak jak padła w wypowiedzi kierowcy.' },
                                    quantity: { type: Type.NUMBER, description: 'Ilość. 0 jeśli nie podano.' },
                                    unit: { type: Type.STRING, description: 'Jednostka (szt, mb, m2, kg, op, rolka, worek). Jeśli brak — "szt".' }
                                },
                                required: ['name', 'quantity', 'unit']
                            }
                        }
                    },
                    required: ['items']
                }
            }
        });

        let parsedItems: { name: string; quantity: number; unit: string }[] = [];
        try {
            const aiJson = JSON.parse(response.text || '{}');
            parsedItems = aiJson.items || [];
        } catch {
            parsedItems = [];
        }

        // Zapis do Firestore
        const docRef = await addDoc(collection(db, 'driver_wz_notes'), {
            wz_ref: wz_ref.trim().toUpperCase(),
            raw_text,
            items: parsedItems,
            driver_name: driver_name || 'Nieznany',
            site_id: site_id || null,
            source: 'MANUAL_TEXT', // lub 'AUDIO' gdy będzie prawdziwy moduł
            createdAt: serverTimestamp()
        });

        return NextResponse.json({
            success: true,
            note_id: docRef.id,
            wz_ref,
            extracted_items: parsedItems
        });

    } catch (error: any) {
        console.error('[driver-note] Błąd:', error);
        return NextResponse.json({ error: error.message || 'Błąd serwera' }, { status: 500 });
    }
}
