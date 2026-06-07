// ============================================================
// PESAM Brain – Agent Uczący (PESAM 2.0)
// POST /api/kosztorysant/brain/uczacy
//
// Wywoływany przez UI po kliknięciu "Zatwierdź i naucz mózg".
// Pobiera upload, odpala matematykę rolling average i nadpisuje wiedzę.
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase/admin';
import {
    updateRolling,
    type BrainUploadRecord,
    type QuantityIndicators,
    type BranchProportions,
    type PriceHistoryEntry,
    type RollingStats
} from '../../_shared/brainKnowledge.types';

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
    console.log("==================================================");
    console.log("[Brain Uczący] === START PROCESU UCZENIA MÓZGU ===");
    console.log("==================================================");

    try {
        const { uploadId, userNotes } = (await req.json()) as {
            uploadId: string;
            userNotes?: string;
        };

        if (!uploadId) {
            console.error("[Brain Uczący] ❌ Błąd: Brak uploadId w żądaniu.");
            return NextResponse.json({ error: 'Brak uploadId' }, { status: 400 });
        }

        console.log(`[Brain Uczący] 🔍 Szukam rekordu kosztorysu: ${uploadId}`);
        const uploadRef = adminDb.doc(`settings/brainKnowledge/uploads/${uploadId}`);
        const uploadSnap = await uploadRef.get();

        if (!uploadSnap.exists) {
            console.error(`[Brain Uczący] ❌ Błąd: Rekord ${uploadId} nie istnieje.`);
            return NextResponse.json({ error: 'Upload nie istnieje' }, { status: 404 });
        }

        const record = uploadSnap.data() as BrainUploadRecord;

        if (record.status === 'APPROVED') {
            console.warn(`[Brain Uczący] ⚠️ Rekord ${uploadId} został już wcześniej zatwierdzony!`);
            return NextResponse.json({ error: 'Upload już zatwierdzony' }, { status: 409 });
        }

        const { objectType } = record;
        console.log(`[Brain Uczący] 🏗️ Rozpoznany typ obiektu: "${objectType}". Rozpoczynam nadpisywanie wiedzy.`);

        // POPRAWKA: Zmiana ścieżki głównej Mózgu dla PESAM 2.0
        const brainBase = `brain_knowledge/${objectType}`;

        // 1. Zapis wskaźników ilościowych (ZAWSZE)
        console.log(`[Brain Uczący] 📊 Aktualizacja wskaźników ilościowych...`);
        await updateIndicators(brainBase, record);

        // 2. Zapis proporcji branżowych (ZAWSZE)
        console.log(`[Brain Uczący] 🥧 Aktualizacja proporcji branżowych...`);
        await updateProportions(brainBase, record);

        // 3. Zapis historii cen (TYLKO jeśli FRESH/STALE i AI coś wyciągnęło)
        if (record.pricesUsedForLearning && record.extractedPriceCount > 0) {
            console.log(`[Brain Uczący] 💰 Kosztorys jest odpowiednio świeży. Aktualizuję rejestr cen.`);
            await savePriceHistory(brainBase, record);
        } else {
            console.log(`[Brain Uczący] ⏭️ Kosztorys jest EXPIRED. Pomijam naukę cen.`);
        }

        // 4. Oznacz jako zatwierdzone
        console.log(`[Brain Uczący] 🏁 Zmieniam status rekordu na APPROVED.`);
        await uploadRef.update({
            status: 'APPROVED',
            userNotes: userNotes ?? record.userNotes ?? null,
            approvedAt: new Date().toISOString(),
        });

        console.log(`[Brain Uczący] ✅ Mózg zaktualizowany! Sukces dla typu: ${objectType}`);
        console.log("==================================================");

        return NextResponse.json({
            success: true,
            uploadId,
            objectType,
            pricesLearned: record.pricesUsedForLearning,
        });
    } catch (error) {
        console.error('[Brain Uczący] ❌ KRYTYCZNY BŁĄD:', error);
        return NextResponse.json(
            { error: 'Błąd aktualizacji mózgu', details: String(error) },
            { status: 500 }
        );
    }
}

// ---- Funkcje Pomocnicze (Transakcje Firestore) ----

async function updateIndicators(brainBase: string, record: BrainUploadRecord): Promise<void> {
    // POPRAWKA: Przeniesienie dokumentu do podkolekcji stats (poprawia segmentację ścieżki)
    const ref = adminDb.doc(`${brainBase}/stats/indicators`);

    await adminDb.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const existing = (snap.exists ? snap.data() : {}) as Partial<QuantityIndicators>;
        const extracted = record.extractedIndicators as Partial<QuantityIndicators>;
        const now = new Date().toISOString();

        const updated: Partial<QuantityIndicators> = {
            objectType: record.objectType,
            lastUpdated: now,
            sampleCount: (existing.sampleCount ?? 0) + 1,
        };

        const keys: (keyof QuantityIndicators)[] = [
            'concretePerM2Floor', 'steelPerM3Concrete', 'excavationPerM2Floor',
            'wallM2PerM2Floor', 'slabM2PerM2Floor', 'roofM2PerM2Floor',
            'plasterM2PerM2Floor', 'flooringM2PerM2Floor', 'windowsM2PerM2Wall', 'totalArea_m2'
        ];

        for (const key of keys) {
            const newVal = extracted[key] as RollingStats | undefined;
            if (newVal?.avg != null) {
                updated[key] = updateRolling((existing[key] as RollingStats | null) ?? null, newVal.avg) as any;
            }
        }

        if (snap.exists) tx.update(ref, updated as any);
        else tx.set(ref, updated);
    });
}

async function updateProportions(brainBase: string, record: BrainUploadRecord): Promise<void> {
    // POPRAWKA: Przeniesienie dokumentu do podkolekcji stats (poprawia segmentację ścieżki)
    const ref = adminDb.doc(`${brainBase}/stats/proportions`);

    await adminDb.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const existing = (snap.exists ? snap.data() : {}) as Partial<BranchProportions>;
        const extracted = record.extractedProportions as Partial<BranchProportions>;
        const now = new Date().toISOString();

        const updated: Partial<BranchProportions> = {
            objectType: record.objectType,
            lastUpdated: now,
            sampleCount: (existing.sampleCount ?? 0) + 1,
        };

        const propKeys: (keyof BranchProportions)[] = [
            'D1_zeroPercent', 'D2_roughPercent', 'D3_finishPercent', 'D4_facadePercent',
            'D5_sanitaryPercent', 'D6_electricPercent', 'D7_specialPercent', 'D8_techPercent', 'costPerM2'
        ];

        for (const key of propKeys) {
            const newVal = extracted[key] as RollingStats | undefined;
            if (newVal?.avg != null) {
                updated[key] = updateRolling((existing[key] as RollingStats | null) ?? null, newVal.avg) as any;
            }
        }

        if (snap.exists) tx.update(ref, updated as any);
        else tx.set(ref, updated);
    });
}

async function savePriceHistory(brainBase: string, record: BrainUploadRecord): Promise<void> {
    const priceItemsSnap = await adminDb.collection(`settings/brainKnowledge/uploads/${record.uploadId}/priceItems`).get();
    if (priceItemsSnap.empty) {
        console.log(`[Brain Uczący] Brak pozycji cenowych do wgrania.`);
        return;
    }

    const batch = adminDb.batch();
    let count = 0;

    for (const doc of priceItemsSnap.docs) {
        const item = doc.data();
        // Ta ścieżka ma teraz 4 segmenty (Document), co jest w 100% poprawne dla adminDb.doc()
        const historyRef = adminDb.doc(`${brainBase}/priceHistory/${item.itemKey}`);
        const historySnap = await historyRef.get();
        const existing = historySnap.exists ? (historySnap.data() as PriceHistoryEntry) : null;

        const entry: Partial<PriceHistoryEntry> = {
            itemKey: item.itemKey,
            itemName: item.itemName,
            unit: item.unit,
            objectType: record.objectType,
            historicalPrice: item.unitPrice,
            documentDate: record.documentDate,
            uploadedAt: record.uploadedAt,
            freshness: record.freshnessLevel,
            currentPrice: existing?.currentPrice ?? null,
            priceVerifiedAt: existing?.priceVerifiedAt ?? null,
            priceChangePercent: existing?.priceChangePercent ?? null,
            rollingHistorical: updateRolling(existing?.rollingHistorical ?? null, item.unitPrice),
        };

        if (historySnap.exists) batch.update(historyRef, entry as any);
        else batch.set(historyRef, entry);
        count++;
    }

    await batch.commit();
    console.log(`[Brain Uczący] Zaktualizowano ${count} pozycji cenowych w rejestrze historii.`);
}