// ============================================================
// PESAM Brain – Hook useBrainUploads
// Nasłuchuje kolekcję settings/brainKnowledge/uploads w czasie rzeczywistym
// Zwraca posortowane uploady z akcjami zatwierdzania/odrzucania.
// ============================================================

'use client';

import { useEffect, useState, useCallback } from 'react';
import { collection, query, orderBy, onSnapshot, getFirestore } from 'firebase/firestore';
import { app } from '@/lib/firebase/config'; // <-- Upewnij się, że to właściwa ścieżka do Twojego Firebase config
import type { BrainUploadRecord } from '@/app/api/kosztorysant/_shared/brainKnowledge.types';

const db = getFirestore(app);

export interface BrainUploadWithId extends BrainUploadRecord {
    id: string;
}

export interface BrainStats {
    total: number;
    pending: number;
    approved: number;
    rejected: number;
    byObjectType: Record<string, number>;
}

export function useBrainUploads() {
    const [uploads, setUploads] = useState<BrainUploadWithId[]>([]);
    const [stats, setStats] = useState<BrainStats | null>(null);
    const [loading, setLoading] = useState(true);
    const [actionLoading, setActionLoading] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        console.log('[useBrainUploads] 🎧 Rozpoczynam nasłuch kolekcji uploads...');
        const q = query(collection(db, 'settings/brainKnowledge/uploads'), orderBy('uploadedAt', 'desc'));

        const unsub = onSnapshot(
            q,
            (snap) => {
                const items = snap.docs.map((doc) => ({
                    id: doc.id,
                    ...(doc.data() as BrainUploadRecord),
                }));

                console.log(`[useBrainUploads] 📥 Pobrano ${items.length} rekordów (w tym statusy PENDING_REVIEW).`);
                setUploads(items);
                setStats(computeStats(items));
                setLoading(false);
            },
            (err) => {
                console.error('[useBrainUploads] ❌ Błąd nasłuchu Firestore:', err);
                setError(err.message);
                setLoading(false);
            }
        );

        return () => {
            console.log('[useBrainUploads] 🔇 Zdejmuję nasłuch z uploads.');
            unsub();
        };
    }, []);

    // Akcja: Zatwierdź upload – wywołuje Agenta Uczącego API
    const approve = useCallback(async (uploadId: string, userNotes?: string) => {
        console.log(`[useBrainUploads] 🟢 Wywołuję zatwierdzenie dla uploadu: ${uploadId}`);
        setActionLoading(uploadId);
        try {
            const res = await fetch('/api/kosztorysant/brain/uczacy', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ uploadId, userNotes }),
            });
            if (!res.ok) throw new Error(await res.text());
            console.log(`[useBrainUploads] ✅ Sukces: Mózg się nauczył!`);
        } catch (err) {
            console.error(`[useBrainUploads] ❌ Błąd przy zatwierdzaniu:`, err);
            setError(String(err));
        } finally {
            setActionLoading(null);
        }
    }, []);

    // Akcja: Odrzuć upload
    const reject = useCallback(async (uploadId: string, userNotes?: string) => {
        console.log(`[useBrainUploads] 🔴 Wywołuję odrzucenie dla uploadu: ${uploadId}`);
        setActionLoading(uploadId);
        try {
            const res = await fetch('/api/kosztorysant/brain/approve', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ uploadId, action: 'REJECT', userNotes }),
            });
            if (!res.ok) throw new Error(await res.text());
        } catch (err) {
            console.error(`[useBrainUploads] ❌ Błąd przy odrzucaniu:`, err);
            setError(String(err));
        } finally {
            setActionLoading(null);
        }
    }, []);

    // Akcja: Aktualizuj notatki
    const updateNotes = useCallback(async (uploadId: string, userNotes: string) => {
        console.log(`[useBrainUploads] 📝 Aktualizacja notatek dla: ${uploadId}`);
        setActionLoading(uploadId);
        try {
            const res = await fetch('/api/kosztorysant/brain/approve', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ uploadId, action: 'UPDATE_NOTES', userNotes }),
            });
            if (!res.ok) throw new Error(await res.text());
        } catch (err) {
            console.error(`[useBrainUploads] ❌ Błąd notatek:`, err);
            setError(String(err));
        } finally {
            setActionLoading(null);
        }
    }, []);

    return { uploads, stats, loading, actionLoading, error, approve, reject, updateNotes };
}

function computeStats(uploads: BrainUploadWithId[]): BrainStats {
    const byObjectType: Record<string, number> = {};
    let pending = 0, approved = 0, rejected = 0;

    for (const u of uploads) {
        byObjectType[u.objectType] = (byObjectType[u.objectType] ?? 0) + 1;
        if (u.status === 'PENDING_REVIEW') pending++;
        else if (u.status === 'APPROVED') approved++;
        else if (u.status === 'REJECTED') rejected++;
    }

    return { total: uploads.length, pending, approved, rejected, byObjectType };
}