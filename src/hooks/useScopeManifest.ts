'use client';

// ============================================================
// PESAM – Hook: useScopeManifest (Real-Time Listener)
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

export type HeatMapColor = 'green' | 'yellow' | 'red' | 'gray';

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

function qualityToColor(quality: DataQuality, status: string): HeatMapColor {
    if (status === 'MISSING' || status === 'WAITING_USER') return 'red';
    if (quality === 'MARKET_VERIFIED') return 'green';
    if (quality === 'NORMATIVE' || quality === 'ESTIMATED') return 'yellow';
    return 'gray';
}

function buildTooltip(entry: CoverageEntry, quality: DataQuality, status: string): string {
    if (status === 'WAITING_USER') {
        return '🔴 Blokada: Czeka na Twoje dane wejściowe. Podaj parametry w oknie czatu.';
    }
    if (status === 'MISSING') {
        return '🔴 Brak: Pozycja nie została wyceniona. Gap Filler pominął ją.';
    }
    if (quality === 'MARKET_VERIFIED') {
        return '🟢 Rynkowe: Pozycja precyzyjnie wyliczona i wyceniona przez Rój.';
    }
    if (quality === 'NORMATIVE') {
        return `🟡 Normowe: Uzupełniono automatycznie: ${entry.gapFillerNote ?? 'brak opisu'}`;
    }
    if (quality === 'ESTIMATED') {
        return `🟡 Szacunkowe: Wyliczono ze średnich GUS: ${entry.gapFillerNote ?? 'brak opisu'}`;
    }
    return '⚪ Brak danych o wycenie.';
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

        console.log(`[useScopeManifest] [Real-time] Podpinam nasłuch Firestore dla: tenders/${tenderId}/scopeManifest/main...`);
        setIsLoading(true);

        const manifestRef = doc(db, `tenders/${tenderId}/scopeManifest/main`);

        const unsubscribe = onSnapshot(
            manifestRef,
            (snap) => {
                if (snap.exists()) {
                    setManifest(snap.data() as ScopeManifest);
                    console.log(`[useScopeManifest] [Real-time] Dane zsynchronizowane pomyślnie.`);
                } else {
                    console.log(`[useScopeManifest] [Real-time] Brak ScopeManifestu w bazie.`);
                    setManifest(null);
                }
                setIsLoading(false);
                setError(null);
            },
            (err) => {
                console.error('[useScopeManifest] Błąd subskrypcji Firestore:', err);
                setError(err.message);
                setIsLoading(false);
            }
        );

        return () => {
            console.log(`[useScopeManifest] [Real-time] Zdejmuję nasłuch.`);
            unsubscribe();
        };
    }, [tenderId]);

    const heatMap: HeatMapEntry[] = (() => {
        if (!manifest) return [];

        const entries: HeatMapEntry[] = [];

        for (const div of manifest.requiredDivisions) {
            for (const el of div.elements) {
                const coverage = manifest.coverageStatus.find(
                    (c) => c.elementId === el.elementId
                );

                const quality: DataQuality = coverage?.dataQuality ?? 'MISSING';
                const status = coverage?.status ?? 'MISSING';
                const color = qualityToColor(quality, status);

                entries.push({
                    elementId: el.elementId,
                    divisionId: div.divisionId,
                    divisionName: div.divisionName,
                    elementName: el.name,
                    color,
                    dataQuality: quality,
                    status,
                    gapFillerNote: coverage?.gapFillerNote ?? null,
                    gapFillerValue: coverage?.gapFillerValue ?? null,
                    isMandatoryByLaw: el.isMandatoryByLaw,
                    tooltipText: coverage
                        ? buildTooltip(coverage, quality, status)
                        : '⚪ Brak danych',
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
                total: 0, covered: 0, gapFilled: 0,
                missing: 0, waitingUser: 0, coveragePercent: 0,
                confidenceScore: 0, objectType: null,
                objectArea_m2: null, riskBufferPercent: 0,
            };
        }

        const cov = manifest.coverageStatus;
        const total = cov.length;
        const covered = cov.filter((c) => c.status === 'COVERED').length;
        const gapFilled = cov.filter((c) => c.status === 'GAP_FILLED').length;
        const missing = cov.filter((c) => c.status === 'MISSING').length;
        const waitingUser = cov.filter((c) => c.status === 'WAITING_USER').length;

        const coveragePercent = total > 0
            ? Math.round(((covered + gapFilled * 0.7) / total) * 100)
            : 0;

        const riskBufferPercent = manifest.missingDataRisks.reduce(
            (sum, r) => sum + (r.userOverridePercent ?? r.costImpactPercent),
            0
        );

        return {
            total, covered, gapFilled, missing, waitingUser, coveragePercent,
            confidenceScore: manifest.meta.confidenceScore,
            objectType: manifest.meta.objectType,
            objectArea_m2: manifest.meta.objectArea_m2,
            riskBufferPercent,
        };
    })();

    const markAsNeedsReview = useCallback(async (elementId: string) => {
        if (!tenderId || !manifest) return;
        console.log(`[useScopeManifest] Akcja: Oznaczam "${elementId}" do weryfikacji manualnej...`);
        try {
            await fetch(`/api/kosztorysant/scope-manifest/update-coverage`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tenderId, elementId, status: 'NEEDS_REVIEW' }),
            });
        } catch (e) {
            console.error('[useScopeManifest] Błąd markAsNeedsReview:', e);
        }
    }, [tenderId, manifest]);

    const answerQuestion = useCallback(async (
        elementId: string,
        value: number,
        unit: string
    ) => {
        if (!tenderId) return;
        console.log(`[useScopeManifest] Akcja: Wysyłam odpowiedź użytkownika dla "${elementId}"...`);
        try {
            await fetch(`/api/kosztorysant/scope-manifest/answer-question`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tenderId, elementId, value, unit }),
            });
        } catch (e) {
            console.error('[useScopeManifest] Błąd answerQuestion:', e);
        }
    }, [tenderId]);

    return {
        manifest,
        isLoading,
        error,
        heatMap,
        pendingQuestions,
        coverageStats,
        markAsNeedsReview,
        answerQuestion,
    };
}