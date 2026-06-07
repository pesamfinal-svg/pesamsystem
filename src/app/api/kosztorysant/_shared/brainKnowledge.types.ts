// ============================================================
// PESAM – Typy dla modułu PESAM Brain (Baza Wiedzy)
// Zawiera struktury dla Firestore oraz logikę matematyczną (Rolling Average)
// ============================================================

export type ObjectType =
    | 'przedszkole'
    | 'szkola'
    | 'biurowiec'
    | 'hala_sportowa'
    | 'hala_produkcyjna'
    | 'budynek_mieszkalny'
    | 'szpital'
    | 'inne';

export type UploadSource = 'PESAM_EXPORT' | 'EXTERNAL_PDF' | 'EXTERNAL_XLSX';
export type FreshnessLevel = 'FRESH' | 'STALE' | 'EXPIRED';
export type UploadStatus = 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED' | 'PARTIAL';

// Struktura pojedynczej statystyki kroczącej
export interface RollingStats {
    avg: number;
    min: number;
    max: number;
    samples: number;
}

// ============================================================
// STRUKTURY FIRESTORE (settings/brainKnowledge/{objectType}/*)
// ============================================================

export interface QuantityIndicators {
    objectType: string;
    lastUpdated: string;
    sampleCount: number;
    // Wskaźniki
    concretePerM2Floor?: RollingStats;
    steelPerM3Concrete?: RollingStats;
    excavationPerM2Floor?: RollingStats;
    wallM2PerM2Floor?: RollingStats;
    slabM2PerM2Floor?: RollingStats;
    roofM2PerM2Floor?: RollingStats;
    plasterM2PerM2Floor?: RollingStats;
    flooringM2PerM2Floor?: RollingStats;
    windowsM2PerM2Wall?: RollingStats;
    totalArea_m2?: RollingStats;
}

export interface BranchProportions {
    objectType: string;
    lastUpdated: string;
    sampleCount: number;
    // Proporcje branż (%)
    D1_zeroPercent?: RollingStats;
    D2_roughPercent?: RollingStats;
    D3_finishPercent?: RollingStats;
    D4_facadePercent?: RollingStats;
    D5_sanitaryPercent?: RollingStats;
    D6_electricPercent?: RollingStats;
    D7_specialPercent?: RollingStats;
    D8_techPercent?: RollingStats;
    // Koszt ogólny
    costPerM2?: RollingStats;
}

export interface PriceHistoryEntry {
    itemKey: string;
    itemName: string;
    unit: string;
    objectType: string;
    historicalPrice: number;
    documentDate: string;
    uploadedAt: string;
    freshness: FreshnessLevel;
    currentPrice: number | null;
    priceVerifiedAt: string | null;
    priceChangePercent: number | null;
    rollingHistorical: RollingStats;
}

// ============================================================
// STRUKTURA REJESTRU WGRANYCH KOSZTORYSÓW
// ============================================================

export interface BrainUploadRecord {
    uploadId: string;
    fileName: string;
    source: UploadSource;
    objectType: string;
    documentDate: string; // Kiedy projekt powstał
    uploadedAt: string;   // Kiedy wgrano do systemu

    status: UploadStatus;
    userNotes?: string;
    approvedAt?: string;
    rejectedAt?: string;

    totalCost_PLN: number | null;
    totalArea_m2: number | null;
    extractedPriceCount: number;

    freshnessLevel: FreshnessLevel;
    freshnessWarning: string | null;
    pricesUsedForLearning: boolean;
    confidenceScore: number;
    warnings: string[];

    extractedIndicators: Partial<QuantityIndicators>;
    extractedProportions: Partial<BranchProportions>;
}

export interface BrainContext {
    objectType: ObjectType;
    hasLearned: boolean;
    sampleCount: number;
    indicators: QuantityIndicators | null;
    proportions: BranchProportions | null;
    freshPriceHints: Array<{
        itemKey: string;
        itemName: string;
        unit: string;
        historicalAvg: number;
        currentVerified: number | null;
        freshnessNote: string;
    }>;
    learningNotes: string[];
}

// ============================================================
// SILNIK MATEMATYCZNY MÓZGU (Rolling Average)
// ============================================================

/**
 * Przelicza nową średnią kroczącą (bez konieczności trzymania pełnej tablicy historii).
 */
export function updateRolling(old: RollingStats | null, newVal: number): RollingStats {
    console.log(`[PESAM Brain Math] 🧮 Aktualizacja wskaźnika. Nowa wartość wejściowa: ${newVal}`);

    if (!old || old.samples === 0) {
        const res = { avg: newVal, min: newVal, max: newVal, samples: 1 };
        console.log(`[PESAM Brain Math] ✨ Brak historii. Utworzono nową statystykę:`, res);
        return res;
    }

    const samples = old.samples + 1;
    const avg = ((old.avg * old.samples) + newVal) / samples;
    const min = Math.min(old.min, newVal);
    const max = Math.max(old.max, newVal);

    const res = { avg, min, max, samples };
    console.log(`[PESAM Brain Math] 🔄 Przeliczono na próbce nr ${samples}. Poprzednia śr: ${old.avg.toFixed(2)} -> Nowa śr: ${avg.toFixed(2)}`);

    return res;
}