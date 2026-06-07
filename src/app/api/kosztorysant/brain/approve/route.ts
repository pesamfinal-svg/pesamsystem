import { NextRequest, NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase/admin';

export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest) {
    console.log("[Brain Zarządzanie] Otrzymano polecenie PATCH na upload...");

    try {
        const { uploadId, action, userNotes } = (await req.json()) as {
            uploadId: string;
            action: 'REJECT' | 'UPDATE_NOTES';
            userNotes?: string;
        };

        if (!uploadId || !action) {
            console.warn("[Brain Zarządzanie] ⚠️ Brak wymaganych parametrów.");
            return NextResponse.json({ error: 'Brak parametrów' }, { status: 400 });
        }

        const uploadRef = adminDb.doc(`settings/brainKnowledge/uploads/${uploadId}`);
        const snap = await uploadRef.get();

        if (!snap.exists) {
            console.warn(`[Brain Zarządzanie] ⚠️ Rekord ${uploadId} nie istnieje.`);
            return NextResponse.json({ error: 'Nie znaleziono' }, { status: 404 });
        }

        if (action === 'REJECT') {
            console.log(`[Brain Zarządzanie] ❌ Odrzucam upload: ${uploadId}`);
            await uploadRef.update({
                status: 'REJECTED',
                userNotes: userNotes ?? null,
                rejectedAt: new Date().toISOString(),
            });
            return NextResponse.json({ success: true, action: 'REJECTED' });
        }

        if (action === 'UPDATE_NOTES') {
            console.log(`[Brain Zarządzanie] 📝 Aktualizacja notatek w uploadzie: ${uploadId}`);
            await uploadRef.update({ userNotes: userNotes ?? null });
            return NextResponse.json({ success: true, action: 'UPDATED' });
        }

        return NextResponse.json({ error: 'Nieznana akcja' }, { status: 400 });
    } catch (error) {
        console.error('[Brain Zarządzanie] ❌ KRYTYCZNY BŁĄD:', error);
        return NextResponse.json({ error: String(error) }, { status: 500 });
    }
}