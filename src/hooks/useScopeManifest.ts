'use client';

// ============================================================
// PESAM 2.0 – Hook: useScopeManifest (Real-Time Listener)
// Odpowiada za pobieranie i synchronizację mapy ciepła na żywo.
// ============================================================

import { useEffect, useState, useCallback } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase/config';
import type {
    ScopeManifest,
    CoverageEntry,
    DataQuality,
    ObjectType,
} from '../app/api/kosztorysant/_shared/scopeManifest.types';

export type HeatMapColor = 'green' | 'yellow' | 'red' | 'gray' | 'blue' | 'purple';

export interface HeatMapEntry {
    elementId: string;
    divisionId: string;
    divisionName: string;
    elementName: string;
    color: HeatMapColor;
    dataQuality: DataQuality;
    status: string;
    gapFillerNote: string | null;
    gapFillerValue: number | null;
    isMandatoryByLaw: boolean;
    tooltipText: string;
    mappedFileId?: string | null;
    quantityEstimated?: number | null;
}

export interface PendingQuestion {
    elementId: string;
    divisionId: string;
    elementName: string;
    question: string;
}

export interface CoverageStats {
    total: number;
    covered: number;
    gapFilled: number;
    missing: number;
    waitingUser: number;
    needsQuantity: number;
    techRequired: number;
    coveragePercent: number;
    confidenceScore: number;
    objectType: ObjectType | null;
    objectArea_m2: number | null;
    riskBufferPercent: number;
}

export interface UseScopeManifestReturn {
    manifest: ScopeManifest | null;
    isLoading: boolean;
    error: string | null;
    heatMap: HeatMapEntry[];
    pendingQuestions: PendingQuestion[];
    coverageStats: CoverageStats;
    markAsNeedsReview: (elementId: string) => Promise<void>;
    answerQuestion: (elementId: string, value: number, unit: string) => Promise<void>;
}

// Kolorowanie logiki na podstawie nowych statusów PESAM 2.0
function qualityToColor(quality: DataQuality, status: string): HeatMapColor {
    if (status === 'MISSING' || status === 'WAITING_USER') return 'red';
    if (status === 'NEEDS_QUANTITY') return 'blue'; // Znalazł Detektyw, czeka na Ilościowca
    if (status === 'TECH_REQUIRED') return 'purple'; // Wymóg dopisany przez Cichego Rewidenta
    if (status === 'COVERED' && (quality === 'MARKET_VERIFIED' || quality === 'NORMATIVE')) return 'green';
    if (status === 'GAP_FILLED' || quality === 'ESTIMATED') return 'yellow';
    return 'gray';
}

function buildTooltip(entry: CoverageEntry, quality: DataQuality, status: string): string {
    if (status === 'WAITING_USER') {
        return '🔴 Blokada: Czeka na Twoje dane wejściowe. Podaj parametry w oknie czatu.';
    }
    if (status === 'MISSING') {
        return '🔴 Brak danych: Projektant nie załączył dokumentacji dla tej pozycji.';
    }
    if (status === 'NEEDS_QUANTITY') {
        return '🔵 Dokument zlokalizowany: Detektyw przypisał plik. Ilościowiec właśnie zlicza z niego wymiary...';
    }
    if (status === 'TECH_REQUIRED') {
        return `🟣 Pułapka technologiczna (Cichy Rewident): ${entry.gapFillerNote ?? 'Wymóg dodany bezpieczeństwa.'}`;
    }
    if (status === 'COVERED') {
        return `🟢 Wyliczono precyzyjnie: ${entry.gapFillerNote ?? 'Z dokumentacji.'}`;
    }
    if (status === 'GAP_FILLED') {
        return `🟡 Szacunek wskaźnikowy: ${entry.gapFillerNote ?? 'Uzupełniono przez normatywy/mózg.'}`;
    }
    return '⚪ Trwa przetwarzanie...';
}

export function useScopeManifest(tenderId: string | null): UseScopeManifestReturn {
    const [manifest, setManifest] = useState<ScopeManifest | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!tenderId) {
            setIsLoading(false);
            return;
        }

        const manifestRef = doc(db, `tenders/${tenderId}/scopeManifest/main`);
        const unsubscribe = onSnapshot(
            manifestRef,
            (snap) => {
                if (snap.exists()) {
                    setManifest(snap.data() as ScopeManifest);
                } else {
                    setManifest(null);
                }
                setIsLoading(false);
                setError(null);
            },
            (err) => {
                console.error('[useScopeManifest] Błąd:', err);
                setError(err.message);
                setIsLoading(false);
            }
        );

        return () => unsubscribe();
    }, [tenderId]);

    const heatMap: HeatMapEntry[] = (() => {
        if (!manifest) return [];
        const entries: HeatMapEntry[] = [];

        for (const div of manifest.requiredDivisions) {
            for (const el of div.elements) {
                const coverage = manifest.coverageStatus.find(c => c.elementId === el.elementId);
                const quality: DataQuality = coverage?.dataQuality ?? 'MISSING';
                const status = coverage?.status ?? 'MISSING';

                entries.push({
                    elementId: el.elementId,
                    divisionId: div.divisionId,
                    divisionName: div.divisionName,
                    elementName: el.name,
                    color: qualityToColor(quality, status),
                    dataQuality: quality,
                    status,
                    gapFillerNote: coverage?.gapFillerNote ?? null,
                    gapFillerValue: coverage?.gapFillerValue ?? null,
                    isMandatoryByLaw: el.isMandatoryByLaw,
                    tooltipText: coverage ? buildTooltip(coverage, quality, status) : '⚪ Brak danych',
                    mappedFileId: coverage?.mappedFileId,
                    quantityEstimated: coverage?.quantityEstimated,
                });
            }
        }
        return entries;
    })();

    const pendingQuestions: PendingQuestion[] = (() => {
        if (!manifest) return [];
        return manifest.coverageStatus
            .filter((c) => c.status === 'WAITING_USER' && c.pendingQuestion)
            .map((c) => {
                const div = manifest.requiredDivisions.find((d) => d.divisionId === c.divisionId);
                const el = div?.elements.find((e) => e.elementId === c.elementId);
                return {
                    elementId: c.elementId,
                    divisionId: c.divisionId,
                    elementName: el?.name ?? c.elementId,
                    question: c.pendingQuestion!,
                };
            });
    })();

    const coverageStats: CoverageStats = (() => {
        if (!manifest) {
            return {
                total: 0, covered: 0, gapFilled: 0, missing: 0, waitingUser: 0,
                needsQuantity: 0, techRequired: 0, coveragePercent: 0, confidenceScore: 0,
                objectType: null, objectArea_m2: null, riskBufferPercent: 0,
            };
        }

        const cov = manifest.coverageStatus;
        const total = cov.length;
        const covered = cov.filter((c) => c.status === 'COVERED').length;
        const gapFilled = cov.filter((c) => c.status === 'GAP_FILLED').length;
        const missing = cov.filter((c) => c.status === 'MISSING').length;
        const waitingUser = cov.filter((c) => c.status === 'WAITING_USER').length;
        const needsQuantity = cov.filter((c) => c.status === 'NEEDS_QUANTITY').length;
        const techRequired = cov.filter((c) => c.status === 'TECH_REQUIRED').length;

        // Liczymy "sukcesy" (Covered = 100%, GapFilled = 70%, TechReq = 100% zabezpieczenia)
        const coveragePercent = total > 0
            ? Math.round(((covered + techRequired + gapFilled * 0.7) / total) * 100)
            : 0;

        const riskBufferPercent = manifest.missingDataRisks.reduce((sum, r) => sum + (r.userOverridePercent ?? r.costImpactPercent), 0);

        return {
            total, covered, gapFilled, missing, waitingUser, needsQuantity, techRequired,
            coveragePercent, confidenceScore: manifest.meta.confidenceScore,
            objectType: manifest.meta.objectType, objectArea_m2: manifest.meta.objectArea_m2, riskBufferPercent,
        };
    })();

    const markAsNeedsReview = useCallback(async (elementId: string) => {
        if (!tenderId || !manifest) return;
        try {
            await fetch(`/api/kosztorysant/scope-manifest/update-coverage`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tenderId, elementId, status: 'NEEDS_REVIEW' }),
            });
        } catch (e) { console.error(e); }
    }, [tenderId, manifest]);

    const answerQuestion = useCallback(async (elementId: string, value: number, unit: string) => {
        if (!tenderId) return;
        try {
            await fetch(`/api/kosztorysant/scope-manifest/answer-question`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tenderId, elementId, value, unit }),
            });
        } catch (e) { console.error(e); }
    }, [tenderId]);

    return { manifest, isLoading, error, heatMap, pendingQuestions, coverageStats, markAsNeedsReview, answerQuestion };
}