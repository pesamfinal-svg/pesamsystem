// src/app/api/plac/agents/expense/a2a/route.ts
// Agent Kosztów Budowy — Serwer A2A (Google Agent-to-Agent Protocol)

import { NextResponse } from 'next/server';
import { GoogleGenAI, Type } from '@google/genai';
import { adminDb } from '@/lib/firebase/admin';
import { TaskState } from '@a2a-js/sdk';
import { buildA2ATaskResponse } from '@/lib/agents/a2aHelper';

const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || 'pesam-system-81165',
    location: 'global'
});

export const maxDuration = 60;

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const userMessage = body.message?.parts?.[0]?.text || body.userMessage || '';
        const userContext = body.context?.user || {};
        const sessionContext = body.context?.session || {};

        if (!userMessage) {
            return NextResponse.json({ error: 'Brak treści wiadomości' }, { status: 400 });
        }

        // 1. Pobierz aktywne budowy z Firestore
        let sites: Array<{ id: string; name: string }> = [];
        try {
            const sitesSnap = await adminDb.collection('sites').limit(100).get();
            sites = sitesSnap.docs.map(doc => ({
                id: doc.id,
                name: (doc.data()?.name || '').trim()
            })).filter(s => s.name);
        } catch (e) {
            console.warn('[ExpenseAgent] Błąd pobierania budów:', e);
        }

        const sitesListStr = sites.map(s => `"${s.name}" (ID: ${s.id})`).join(', ');

        const systemInstruction = `
Jesteś Agentem Kosztów Budowy w systemie PESAM. Twoim zadaniem jest obsługa poleceń dopisywania wydatków, zakupów materiałów, paliwa i paragonów do budów.
Odpowiadasz zwięźle, bez small-talku i bez markdown (*, #). Maksymalnie 1-2 krótkie zdania.

Dostępne budowy w systemie:
${sitesListStr}

Zasady:
1. Do zapisania wydatku WYMAGANE są:
   - Budowa (siteName)
   - Kwota w PLN (amount)
   - Tytuł / Przeznaczenie wydatku (title, np. "paliwo do zagęszczarki", "śruby", "klej")
2. Jeśli użytkownik podał tylko kwotę i budowę (np. "Dopisz 20 zł na Tuchów"), zapytaj konkretnie:
   "Czego dotyczył ten wydatek?" (isComplete: false).
3. Jeśli użytkownik nie podał budowy: zapytaj o budowę (isComplete: false).
4. Jeśli użytkownik podał komplet: ustaw isComplete: true. Dopasuj kategorię: PALIWO, MATERIAL, NAPRAWA, NARZĘDZIA, TRANSPORT, lub INNE.
`;

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [
                {
                    role: 'user',
                    parts: [
                        {
                            text: `Kontekst sesji: ${JSON.stringify(sessionContext)}\nNowa wiadomość użytkownika: "${userMessage}"`
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
                        isComplete: {
                            type: Type.BOOLEAN,
                            description: 'True jeśli mamy budowę, kwotę i tytuł wydatku'
                        },
                        siteName: { type: Type.STRING },
                        siteId: { type: Type.STRING },
                        amount: { type: Type.NUMBER },
                        title: { type: Type.STRING },
                        category: {
                            type: Type.STRING,
                            description: 'PALIWO, MATERIAL, NAPRAWA, NARZĘDZIA, TRANSPORT, INNE'
                        },
                        missingField: {
                            type: Type.STRING,
                            description: 'budowa, kwota, lub tytul'
                        },
                        speechReply: {
                            type: Type.STRING,
                            description: 'Krótka wypowiedź dla syntezatora mowy (1 zdanie)'
                        }
                    },
                    required: ['isComplete', 'speechReply']
                }
            }
        });

        const raw = response.text?.trim() || '{}';
        const parsed = JSON.parse(raw);

        // Dopasuj siteId jeśli nie podano lub dopasuj z nazwy
        let matchedSite = sites.find(s =>
            (parsed.siteName && s.name.toLowerCase().includes(parsed.siteName.toLowerCase())) ||
            (parsed.siteId && s.id === parsed.siteId)
        );

        if (!matchedSite && parsed.siteName) {
            matchedSite = sites.find(s => parsed.siteName.toLowerCase().includes(s.name.toLowerCase()));
        }

        const taskId = `task_exp_${Date.now()}`;

        // Jeśli brakuje danych — stan INPUT_REQUIRED
        if (!parsed.isComplete || !parsed.amount || !matchedSite || !parsed.title) {
            const promptQuestion = parsed.speechReply || 'Czego dotyczył ten wydatek i na jaką budowę go przypisać?';
            const task = buildA2ATaskResponse({
                taskId,
                state: TaskState.TASK_STATE_INPUT_REQUIRED,
                messageText: promptQuestion,
                data: {
                    draft: {
                        siteName: matchedSite?.name || parsed.siteName || '',
                        siteId: matchedSite?.id || '',
                        amount: parsed.amount || null,
                        title: parsed.title || '',
                        category: parsed.category || 'INNE'
                    }
                },
                metadata: {
                    missingField: parsed.missingField || 'title',
                    quickReplies: matchedSite ? ['Paliwo', 'Materiały drobne', 'Śruby i kołki'] : ['Budowa Tuchów', 'Budowa Wielicka']
                }
            });
            return NextResponse.json(task);
        }

        // Komplet danych — zapis w kolekcji site_expenses
        const expenseDoc = {
            siteId: matchedSite.id,
            siteName: matchedSite.name,
            amount: Number(parsed.amount),
            title: parsed.title.trim(),
            category: parsed.category || 'INNE',
            reportedByUid: userContext.userId || '',
            reportedByName: userContext.userName || userContext.userEmail || 'Pracownik placu',
            createdAt: new Date().toISOString(),
            status: 'ZATWIERDZONE'
        };

        const docRef = await adminDb.collection('site_expenses').add(expenseDoc);

        const confirmationMsg = parsed.speechReply || `Zapisano ${parsed.amount} zł na ${matchedSite.name} za ${parsed.title}.`;

        const task = buildA2ATaskResponse({
            taskId,
            state: TaskState.TASK_STATE_COMPLETED,
            messageText: confirmationMsg,
            data: {
                id: docRef.id,
                ...expenseDoc
            },
            metadata: {
                action: 'EXPENSE_ADDED',
                quickReplies: ['Pokaż koszty', 'Dopisz kolejny wydatek']
            }
        });

        return NextResponse.json(task);
    } catch (error: any) {
        console.error('[ExpenseAgent] Błąd serwera A2A:', error);
        const task = buildA2ATaskResponse({
            taskId: `task_err_${Date.now()}`,
            state: TaskState.TASK_STATE_FAILED,
            messageText: 'Wystąpił problem przy zapisywaniu kosztu. Spróbuj ponownie.'
        });
        return NextResponse.json(task, { status: 500 });
    }
}
