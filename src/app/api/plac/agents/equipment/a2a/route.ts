// src/app/api/plac/agents/equipment/a2a/route.ts
// Agent Sprzętu i Magazynu — Serwer A2A (Google Agent-to-Agent Protocol)

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

        if (!userMessage) {
            return NextResponse.json({ error: 'Brak treści wiadomości' }, { status: 400 });
        }

        // 1. Ekstrakcja parametrów zapytania przez AI
        const extraction = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [
                {
                    role: 'user',
                    parts: [{ text: `Wypowiedź użytkownika: "${userMessage}"` }]
                }
            ],
            config: {
                systemInstruction: `
Jesteś analitykiem zapytań o sprzęt budowlany w firmie PESAM.
Wyodrębnij:
- searchTerm: kluczowa nazwa szukanego narzędzia (np. "wiertarka", "młotowiertarka", "agregat", "zagęszczarka", "rusztowanie")
- inventoryNumber: numer magazynowy jeśli padł w wypowiedzi (np. "61", "14")
- targetLocation: nazwa budowy jeśli użytkownik pyta o konkretną budowę (np. "Tuchów", "Wielicka", "magazyn")
`,
                temperature: 0.1,
                responseMimeType: 'application/json',
                responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                        searchTerm: { type: Type.STRING },
                        inventoryNumber: { type: Type.STRING },
                        targetLocation: { type: Type.STRING }
                    },
                    required: ['searchTerm']
                }
            }
        });

        const queryParams = JSON.parse(extraction.text?.trim() || '{}');
        const term = (queryParams.searchTerm || '').toLowerCase().trim();
        const invNr = (queryParams.inventoryNumber || '').trim();
        const targetLoc = (queryParams.targetLocation || '').toLowerCase().trim();

        // 2. Pobierz bazę budów do mapowania ID
        let sitesMap: Record<string, string> = { MAGAZYN: 'Magazyn Główny' };
        try {
            const sitesSnap = await adminDb.collection('sites').limit(100).get();
            sitesSnap.docs.forEach(d => {
                sitesMap[d.id] = (d.data()?.name || '').trim();
            });
        } catch (e) {
            console.warn('[EquipmentAgent] Błąd pobierania budów:', e);
        }

        // 3. Przeszukaj kolekcję inventory
        const invSnap = await adminDb.collection('inventory').limit(250).get();
        let matchedItems: any[] = [];

        invSnap.docs.forEach(doc => {
            const data = doc.data();
            const name = (data.name || '').toLowerCase();
            const category = (data.category || '').toLowerCase();
            const itemInvNr = (data.inventoryNumber || '').toString().toLowerCase();

            let match = false;
            if (invNr && itemInvNr === invNr.toLowerCase()) {
                match = true;
            } else if (term && (name.includes(term) || category.includes(term))) {
                match = true;
            }

            if (match) {
                // Oblicz alokacje
                const allocations = data.allocations || {};
                const locations: Array<{ siteId: string; siteName: string; qty: number }> = [];

                Object.keys(allocations).forEach(siteId => {
                    const qty = Number(allocations[siteId]) || 0;
                    if (qty > 0) {
                        const siteName = sitesMap[siteId] || (siteId === 'MAGAZYN' ? 'Magazyn Główny' : siteId);
                        locations.push({ siteId, siteName, qty });
                    }
                });

                // Jeśli użytkownik pytał o konkretną lokalizację, przefiltruj
                if (targetLoc) {
                    const matchesLoc = locations.some(l => l.siteName.toLowerCase().includes(targetLoc));
                    if (!matchesLoc) return;
                }

                matchedItems.push({
                    id: doc.id,
                    name: data.name || 'Narzędzie',
                    inventoryNumber: data.inventoryNumber || '',
                    category: data.category || 'Sprzęt',
                    type: data.type || 'UNIQUE',
                    status: data.status || 'SPRAWNY',
                    locations
                });
            }
        });

        matchedItems = matchedItems.slice(0, 8); // Ogranicz do 8 najważniejszych kart

        // 4. Wygeneruj zwięzłe podsumowanie głosowe
        let speechReply = '';
        if (matchedItems.length === 0) {
            speechReply = `Nie znalazłem sprzętu pasującego do zapytania "${term || invNr}".`;
        } else if (invNr && matchedItems.length === 1) {
            const it = matchedItems[0];
            const locStr = it.locations.map((l: any) => `${l.siteName} (${l.qty} szt.)`).join(', ') || 'brak na stanie';
            speechReply = `${it.name} numer ${it.inventoryNumber} znajduje się w lokalizacji: ${locStr}. Stan: ${it.status.toLowerCase()}.`;
        } else {
            const total = matchedItems.length;
            const top = matchedItems[0];
            const locStr = top.locations[0]?.siteName || 'Magazyn';
            speechReply = `Znalazłem ${total} pozycji dla "${term}". Na przykład ${top.name} jest w ${locStr}. Szczegóły masz na ekranie.`;
        }

        const taskId = `task_equip_${Date.now()}`;
        const task = buildA2ATaskResponse({
            taskId,
            state: TaskState.TASK_STATE_COMPLETED,
            messageText: speechReply,
            data: {
                searchTerm: term,
                totalFound: matchedItems.length,
                items: matchedItems
            },
            metadata: {
                action: 'EQUIPMENT_FOUND',
                quickReplies: ['Pokaż magazyn główny', 'Wszystkie wiertarki']
            }
        });

        return NextResponse.json(task);
    } catch (error: any) {
        console.error('[EquipmentAgent] Błąd serwera A2A:', error);
        const task = buildA2ATaskResponse({
            taskId: `task_err_${Date.now()}`,
            state: TaskState.TASK_STATE_FAILED,
            messageText: 'Nie udało się pobrać stanów magazynowych. Spróbuj ponownie.'
        });
        return NextResponse.json(task, { status: 500 });
    }
}
