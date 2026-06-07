import { NextRequest, NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase/admin';
import type { BrainContext, QuantityIndicators, BranchProportions, PriceHistoryEntry } from '../../_shared/brainKnowledge.types';

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
    const objectType = req.nextUrl.searchParams.get('objectType') ?? 'inne';

    console.log(`[Brain Context] 🧠 Agenci Roju odpytują mózg o wiedzę dla: "${objectType}"...`);

    try {
        const base = `settings/brainKnowledge/${objectType}`;

        const [indicatorsSnap, proportionsSnap, priceHistorySnap] = await Promise.all([
            adminDb.doc(`${base}/indicators`).get(),
            adminDb.doc(`${base}/proportions`).get(),
            adminDb.collection(`${base}/priceHistory`).where('freshness', '==', 'FRESH').limit(100).get(),
        ]);

        const indicators = indicatorsSnap.exists ? (indicatorsSnap.data() as QuantityIndicators) : null;
        const proportions = proportionsSnap.exists ? (proportionsSnap.data() as BranchProportions) : null;
        const sampleCount = indicators?.sampleCount ?? 0;

        console.log(`[Brain Context] 📈 Pobrano: Wskaźniki=${!!indicators}, Proporcje=${!!proportions}, Świeże Ceny=${priceHistorySnap.docs.length}. Baza oparta na ${sampleCount} kosztorysach.`);

        const freshPriceHints = priceHistorySnap.docs.map((doc) => {
            const entry = doc.data() as PriceHistoryEntry;
            return {
                itemKey: entry.itemKey,
                itemName: entry.itemName,
                unit: entry.unit,
                historicalAvg: entry.rollingHistorical?.avg ?? entry.historicalPrice,
                currentVerified: entry.currentPrice ?? null,
                freshnessNote: `Wiedza historyczna z ok. ${new Date(entry.documentDate).getFullYear()} roku`,
            };
        });

        const context: BrainContext = {
            objectType: objectType as any,
            hasLearned: sampleCount > 0,
            sampleCount,
            indicators,
            proportions,
            freshPriceHints,
            learningNotes: sampleCount > 0
                ? [`🧠 PESAM wyciągnął lekcje z ${sampleCount} wgranych kosztorysów dla tego typu obiektu.`]
                : [`⚠️ Brak wyuczonych danych dla "${objectType}". System użyje bezpiecznych norm z Eurokodu/Sekocenbudu.`],
        };

        return NextResponse.json(context);
    } catch (error) {
        console.error('[Brain Context] ❌ BŁĄD POBIERANIA KONTEKSTU:', error);
        return NextResponse.json({ error: String(error) }, { status: 500 });
    }
}