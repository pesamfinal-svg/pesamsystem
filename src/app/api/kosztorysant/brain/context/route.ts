import { NextRequest, NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase/admin';
import type { BrainContext, QuantityIndicators, BranchProportions, PriceHistoryEntry } from '../../_shared/brainKnowledge.types';

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
    const objectType = req.nextUrl.searchParams.get('objectType') ?? 'inne';

    console.log(`[Brain Context] 🧠 Agenci Roju odpytują mózg o wiedzę dla: "${objectType}"...`);

    try {
        // NOWA STRUKTURA ŚCIEŻEK (PESAM 2.0):
        // 1. brain_knowledge (Kolekcja)
        // 2. {objectType} (Dokument)
        // 3. priceHistory (Podkolekcja - NIEPARZYSTA = OK)
        const baseDocPath = `brain_knowledge/${objectType}`;
        const priceHistoryCollPath = `${baseDocPath}/priceHistory`;

        const [indicatorsSnap, proportionsSnap, priceHistorySnap] = await Promise.all([
            adminDb.doc(`${baseDocPath}/stats/indicators`).get(), // Dokument (4 segmenty)
            adminDb.doc(`${baseDocPath}/stats/proportions`).get(), // Dokument (4 segmenty)
            adminDb.collection(priceHistoryCollPath).where('freshness', '==', 'FRESH').limit(100).get(), // Kolekcja (3 segmenty)
        ]);

        const indicators = indicatorsSnap.exists ? (indicatorsSnap.data() as QuantityIndicators) : null;
        const proportions = proportionsSnap.exists ? (proportionsSnap.data() as BranchProportions) : null;
        const sampleCount = indicators?.sampleCount ?? 0;

        console.log(`[Brain Context] 📈 Pobrano dane dla "${objectType}": Wskaźniki=${!!indicators}, Proporcje=${!!proportions}, Świeże Ceny=${priceHistorySnap.docs.length}.`);

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
                ? [`🧠 PESAM Brain: Dane oparte na ${sampleCount} Twoich zweryfikowanych projektach.`]
                : [`⚠️ Brak Twoich danych historycznych dla "${objectType}". System użyje norm inżynieryjnych.`],
        };

        return NextResponse.json(context);
    } catch (error) {
        console.error('[Brain Context] ❌ BŁĄD POBIERANIA KONTEKSTU:', error);
        return NextResponse.json({ error: String(error) }, { status: 500 });
    }
}