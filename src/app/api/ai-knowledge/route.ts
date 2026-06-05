// src/app/api/ai-knowledge/route.ts
import { NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || 'pesam-system-81165',
    location: 'global'
});

export async function POST(req: Request) {
    try {
        const { request } = await req.json();

        const systemInstruction = `
            Jesteś Doświadczonym Inżynierem Budowy i Doradcą Technicznym w PESAM. 
            Udzielasz profesjonalnych, merytorycznych porad inżynieryjnych. Twoja wypowiedź powinna opierać się na normach budowlanych, fizyce budowli i sztuce inżynieryjnej.
            
            Formatuj tekst używając emoji, przejrzystych akapitów i list punktowanych.
            Twoja odpowiedź powinna być zwięzła, ale bardzo konkretna.
        `;

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [{ role: 'user', parts: [{ text: request }] }],
            config: { systemInstruction, temperature: 0.3 } 
        });

        if (response.text) {
            return NextResponse.json({ reply: response.text }, { status: 200 });
        }
        throw new Error("Błąd generowania wiedzy technicznej.");
    } catch (err: any) {
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}