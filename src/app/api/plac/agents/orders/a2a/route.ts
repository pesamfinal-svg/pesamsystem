// src/app/api/plac/agents/orders/a2a/route.ts
// Agent Zamówień — Serwer A2A (Google Agent-to-Agent Protocol)

import { NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase/admin';
import { TaskState } from '@a2a-js/sdk';
import { buildA2ATaskResponse } from '@/lib/agents/a2aHelper';

export const maxDuration = 60;

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const userMessage = (body.message?.parts?.[0]?.text || body.userMessage || '').toLowerCase();

        // Pobierz ostatnie zamówienia z Firestore
        const ordersSnap = await adminDb.collection('orders')
            .orderBy('createdAt', 'desc')
            .limit(15)
            .get();

        const orders: any[] = [];
        ordersSnap.docs.forEach(doc => {
            const data = doc.data();
            orders.push({
                id: doc.id,
                orderId: data.orderId || doc.id.slice(0, 6).toUpperCase(),
                siteName: data.siteName || 'Nieokreślona budowa',
                orderedByName: data.orderedByName || data.orderedBy || 'Kierownik',
                status: data.status || 'W REALIZACJI',
                createdAt: data.createdAt || '',
                itemsCount: Array.isArray(data.items) ? data.items.length : 0,
                items: Array.isArray(data.items) ? data.items.slice(0, 5) : []
            });
        });

        // Opcjonalne filtrowanie po nazwie budowy jeśli padła w wypowiedzi
        let filtered = orders;
        let matchedSiteName = '';
        for (const ord of orders) {
            if (ord.siteName && userMessage.includes(ord.siteName.toLowerCase())) {
                matchedSiteName = ord.siteName;
                filtered = orders.filter(o => o.siteName.toLowerCase() === ord.siteName.toLowerCase());
                break;
            }
        }

        let speechReply = '';
        if (filtered.length === 0) {
            speechReply = matchedSiteName
                ? `Nie ma obecnie aktywnych zamówień dla budowy ${matchedSiteName}.`
                : 'Brak zarejestrowanych zamówień na dzisiaj.';
        } else if (matchedSiteName) {
            const topOrder = filtered[0];
            speechReply = `Dla budowy ${matchedSiteName} mamy zamówienie nr ${topOrder.orderId} z ${topOrder.itemsCount} pozycjami. Status: ${topOrder.status.toLowerCase()}.`;
        } else {
            const count = filtered.length;
            const sitesSummary = Array.from(new Set(filtered.map(o => o.siteName))).slice(0, 3).join(', ');
            speechReply = `Mamy ${count} zamówień na dzisiaj, m.in. na budowy: ${sitesSummary}. Podsumowanie masz na ekranie.`;
        }

        const taskId = `task_ord_${Date.now()}`;
        const task = buildA2ATaskResponse({
            taskId,
            state: TaskState.TASK_STATE_COMPLETED,
            messageText: speechReply,
            data: {
                totalOrders: filtered.length,
                siteFilter: matchedSiteName || null,
                orders: filtered.slice(0, 6)
            },
            metadata: {
                action: 'ORDERS_FOUND',
                quickReplies: ['Pokaż wszystkie zlecenia', 'Otwórz moduł zamówień']
            }
        });

        return NextResponse.json(task);
    } catch (error: any) {
        console.error('[OrdersAgent] Błąd serwera A2A:', error);
        const task = buildA2ATaskResponse({
            taskId: `task_err_${Date.now()}`,
            state: TaskState.TASK_STATE_FAILED,
            messageText: 'Nie udało się pobrać zamówień. Spróbuj ponownie.'
        });
        return NextResponse.json(task, { status: 500 });
    }
}
