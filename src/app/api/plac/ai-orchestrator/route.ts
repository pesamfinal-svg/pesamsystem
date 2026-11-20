// src/app/api/plac/ai-orchestrator/route.ts
// Mózg / Router — Orchestrator protokołu Google Agent-to-Agent (A2A)

import { NextResponse } from 'next/server';
import { GoogleGenAI, Type } from '@google/genai';
import { PESAM_A2A_REGISTRY, getAgentsDescriptionForOrchestrator } from '@/lib/agents/registry';
import { dispatchA2ATask } from '@/lib/agents/a2aHelper';

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
            sessionState = {},
            userContext = {}
        } = body;

        if (!userMessage && history.length === 0) {
            return NextResponse.json({ error: 'Brak wiadomości' }, { status: 400 });
        }

        const agentsOverview = getAgentsDescriptionForOrchestrator();

        const systemInstruction = `
Jesteś Głównym Mózgiem i Koordynatorem (Orchestratorem A2A) w aplikacji mobilnej PESAM PLAC dla magazynierów i kierowników.
Masz do dyspozycji zespół wyspecjalizowanych agentów współpracujących:

${agentsOverview}

MODUŁY NAWIGACYJNE APLIKACJI (jeśli użytkownik chce otworzyć ekran):
- Zwrot bez protokołu: /plac/zwrot-bez-protokolu (jeśli użytkownik mówi "chcę zgłosić zwrot", "przyjechał zwrot bez protokołu")
- Magazyn resztek: /plac/resztki (np. "otwórz resztki", "magazyn końcówek")
- Zamówienia: /plac/zamowienia
- Protokoły: /plac/protokol
- Inwentaryzacja: /plac/inwentaryzacja
- Archiwum Tarnów: /plac/tarnow

ZASADY PRACY:
1. Twoim zadaniem jest SKLASYFIKOWANIE intencji użytkownika i wybranie właściwego agenta:
   - "EXPENSE" -> selectedAgentId: "expense" (wszystko o kosztach, wydatkach, zakupach, paliwie na budowy)
   - "EQUIPMENT" -> selectedAgentId: "equipment" (narzędzia, wiertarki, sprzęt, stany magazynowe)
   - "ORDERS" -> selectedAgentId: "orders" (co dzisiaj jedzie, zamówienia dzienne)
   - "NAVIGATION" -> selectedAgentId: null, podaj odpowiedni navigateTo (np. /plac/resztki)
   - "RETURN_NO_PROTOCOL" -> selectedAgentId: null, navigateTo: "/plac/zwrot-bez-protokolu"
   - "GENERAL" -> odpowiedz bezpośrednio, zwięźle (1 zdanie)
2. Odpowiadasz lakonicznie, profesjonalnie, bez zbędnego small-talku.
`;

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [
                {
                    role: 'user',
                    parts: [
                        {
                            text: `Wypowiedź użytkownika na placu: "${userMessage}"`
                        }
                    ]
                }
            ],
            config: {
                systemInstruction,
                temperature: 0.1,
                responseMimeType: 'application/json',
                responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                        intent: {
                            type: Type.STRING,
                            description: 'EXPENSE, EQUIPMENT, ORDERS, NAVIGATION, RETURN_NO_PROTOCOL, lub GENERAL'
                        },
                        selectedAgentId: {
                            type: Type.STRING,
                            description: 'ID agenta z rejestru lub pusty string jeśli nawigacja/ogólne'
                        },
                        navigateTo: {
                            type: Type.STRING,
                            description: 'Ścieżka do podstrony jeśli intencja dotyczy nawigacji'
                        },
                        directSpeechReply: {
                            type: Type.STRING,
                            description: 'Odpowiedź mówiona jeśli nie wywołujemy zewnętrznego agenta'
                        },
                        quickReplies: {
                            type: Type.ARRAY,
                            items: { type: Type.STRING }
                        }
                    },
                    required: ['intent', 'directSpeechReply']
                }
            }
        });

        const raw = response.text?.trim() || '{}';
        const parsed = JSON.parse(raw);

        // Jeśli wybrano agenta współpracującego — deleguj zadanie przez A2A
        if (parsed.selectedAgentId) {
            const targetAgent = PESAM_A2A_REGISTRY.find(a => a.id === parsed.selectedAgentId);
            if (targetAgent) {
                // Wywołaj agenta przez A2A client
                // Pobierz URL bazowy z nagłówka host
                const host = req.headers.get('host') || 'localhost:3000';
                const protocol = host.includes('localhost') ? 'http' : 'https';
                const baseUrl = `${protocol}://${host}`;

                const a2aResult = await dispatchA2ATask(
                    targetAgent.endpoint,
                    {
                        userMessage,
                        userContext,
                        sessionContext: sessionState
                    },
                    baseUrl
                );

                return NextResponse.json({
                    intent: parsed.intent,
                    agentId: targetAgent.id,
                    agentName: targetAgent.name,
                    state: a2aResult.state,
                    speechReply: a2aResult.speechReply,
                    data: a2aResult.data,
                    missingFields: a2aResult.missingFields,
                    quickReplies: a2aResult.quickReplies?.length ? a2aResult.quickReplies : parsed.quickReplies || [],
                    navigateTo: null
                });
            }
        }

        // Nawigacja lub odpowiedź bezpośrednia
        return NextResponse.json({
            intent: parsed.intent,
            agentId: null,
            agentName: null,
            state: 'COMPLETED',
            speechReply: parsed.directSpeechReply || 'Rozumiem.',
            data: null,
            missingFields: [],
            quickReplies: parsed.quickReplies || ['Wróć', 'Pomoc'],
            navigateTo: parsed.navigateTo || null
        });
    } catch (error: any) {
        console.error('[Orchestrator] Błąd Mózgu AI:', error);
        return NextResponse.json({
            intent: 'ERROR',
            agentId: null,
            speechReply: 'Przepraszam, miałem problem z koordynacją zapytania. Powtórz proszę.',
            error: error?.message || 'Błąd wewnętrzny'
        }, { status: 500 });
    }
}
