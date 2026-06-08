// ============================================================
// PESAM 3.0 – Hook czasu rzeczywistego dla mapy zakresu (ScopeManifest)
// ============================================================

import { useState, useEffect } from 'react';
import { db } from '@/lib/firebase/config';
import { doc, onSnapshot, updateDoc } from 'firebase/firestore';

// POPRAWKA TS2307: Import z prawidłowej lokalizacji w Twoim drzewie katalogów
import {
    ScopeManifest,
    CoverageStatus,
    CoverageEntry,
    ScopeDivision,
    ScopeElement
} from '@/app/api/kosztorysant/_shared/scopeManifest.types';

export type HeatMapColor = 'green' | 'yellow' | 'blue' | 'purple' | 'red' | 'gray';

export interface HeatMapEntry {
    elementId: string;
    elementName: string;
    divisionId: string;
    divisionName: string;
    color: HeatMapColor;
    isMandatoryByLaw: boolean;
    quantityEstimated: number | null;
    gapFillerValue: number | null;
    tooltipText: string;
}

interface CoverageStats {
    coveragePercent: number;
    confidenceScore: number;
    objectType: string;
    covered: number;
    needsQuantity: number;
    gapFilled: number;
    techRequired: number;
    missing: number;
}

const statusToColor = (status: CoverageStatus): HeatMapColor => {
    switch (status) {
        case 'COVERED': return 'green';
        case 'GAP_FILLED': return 'yellow';
        case 'NEEDS_QUANTITY': return 'blue';
        case 'TECH_REQUIRED': return 'purple';
        case 'MISSING': return 'red';
        case 'NEEDS_REVIEW':
        case 'WAITING_USER':
        default: return 'gray';
    }
};

export function useScopeManifest(tenderId: string | null) {
    const [manifest, setManifest] = useState<ScopeManifest | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const [heatMap, setHeatMap] = useState<HeatMapEntry[]>([]);
    const [pendingQuestions, setPendingQuestions] = useState<Array<{ elementId: string; elementName: string; question: string }>>([]);
    const [coverageStats, setCoverageStats] = useState<CoverageStats>({
        coveragePercent: 0,
        confidenceScore: 0,
        objectType: '',
        covered: 0,
        needsQuantity: 0,
        gapFilled: 0,
        techRequired: 0,
        missing: 0
    });

    useEffect(() => {
        if (!tenderId) {
            setIsLoading(false);
            return;
        }

        setIsLoading(true);
        setError(null);

        // Nasłuchiwanie dokumentu wygenerowanego przez agenta WBS_ARCHITECT
        const unsub = onSnapshot(doc(db, `tenders/${tenderId}/scopeManifest`, 'main'), (snap) => {
            if (snap.exists()) {
                const data = snap.data() as ScopeManifest;
                setManifest(data);

                // Budowanie HeatMapy na podstawie CoverageStatus i requiredDivisions
                const entries: HeatMapEntry[] = [];
                const questions: Array<{ elementId: string; elementName: string; question: string }> = [];
                let covered = 0, needsQuantity = 0, gapFilled = 0, techRequired = 0, missing = 0;

                // POPRAWKA TS7006: Dodano jawne typy dla parametrów cov, d oraz e
                data.coverageStatus?.forEach((cov: CoverageEntry) => {
                    const division = data.requiredDivisions?.find((d: ScopeDivision) => d.divisionId === cov.divisionId);
                    const element = division?.elements?.find((e: ScopeElement) => e.elementId === cov.elementId);

                    if (!element) return;

                    const color = statusToColor(cov.status);

                    // Statystyki
                    if (color === 'green') covered++;
                    if (color === 'blue') needsQuantity++;
                    if (color === 'yellow') gapFilled++;
                    if (color === 'purple') techRequired++;
                    if (color === 'red') missing++;

                    // Pytania od roju
                    if (cov.pendingQuestion) {
                        questions.push({
                            elementId: cov.elementId,
                            elementName: element.name,
                            question: cov.pendingQuestion
                        });
                    }

                    // Budowanie dynamicznego opisu (Tooltip)
                    let tooltipText = `${element.name} · Stan: ${cov.status} (${cov.dataQuality})`;
                    if (cov.gapFillerNote) tooltipText += ` · ${cov.gapFillerNote}`;

                    entries.push({
                        elementId: cov.elementId,
                        elementName: element.name,
                        divisionId: cov.divisionId,
                        divisionName: division?.divisionName || '',
                        color,
                        isMandatoryByLaw: element.isMandatoryByLaw,
                        quantityEstimated: cov.quantityEstimated ?? null,
                        gapFillerValue: cov.gapFillerValue ?? null,
                        tooltipText
                    });
                });

                setHeatMap(entries);
                setPendingQuestions(questions);

                // Przeliczanie procentu pokrycia
                const total = entries.length || 1;
                const coveragePercent = Math.round(((covered + gapFilled + techRequired) / total) * 100);

                setCoverageStats({
                    coveragePercent,
                    confidenceScore: data.meta?.confidenceScore || 0,
                    objectType: data.meta?.objectType || '',
                    covered,
                    needsQuantity,
                    gapFilled,
                    techRequired,
                    missing
                });

                setIsLoading(false);
            } else {
                setError("Nie znaleziono ScopeManifest dla tego projektu.");
                setIsLoading(false);
            }
        }, (err) => {
            console.error(err);
            setError(err.message);
            setIsLoading(false);
        });

        return () => unsub();
    }, [tenderId]);

    // Oznaczanie elementu do ponownej weryfikacji przez Mózg
    const markAsNeedsReview = async (elementId: string) => {
        if (!tenderId || !manifest) return;
        try {
            // POPRAWKA TS7006: Dodano jawny typ dla parametru cov
            const updatedCoverage = manifest.coverageStatus.map((cov: CoverageEntry) => {
                if (cov.elementId === elementId) {
                    return { ...cov, status: 'NEEDS_REVIEW' as CoverageStatus, lastUpdatedAt: new Date().toISOString() };
                }
                return cov;
            });
            await updateDoc(doc(db, `tenders/${tenderId}/scopeManifest`, 'main'), {
                coverageStatus: updatedCoverage
            });
        } catch (e) {
            console.error("Błąd zapisu statusu re-analizy:", e);
        }
    };

    // Odpowiedź użytkownika na wstrzymane pytanie od Roju
    const answerQuestion = async (elementId: string, value: number, unit: string) => {
        if (!tenderId || !manifest) return;
        try {
            // POPRAWKA TS7006: Dodano jawny typ dla parametru cov
            const updatedCoverage = manifest.coverageStatus.map((cov: CoverageEntry) => {
                if (cov.elementId === elementId) {
                    return {
                        ...cov,
                        status: 'COVERED' as CoverageStatus,
                        quantityEstimated: value,
                        quantitySource: 'MANUAL' as any,
                        pendingQuestion: "", // Czyszczenie pytania
                        lastUpdatedAt: new Date().toISOString()
                    };
                }
                return cov;
            });
            await updateDoc(doc(db, `tenders/${tenderId}/scopeManifest`, 'main'), {
                coverageStatus: updatedCoverage
            });
        } catch (e) {
            console.error("Błąd zapisu odpowiedzi użytkownika:", e);
        }
    };

    return {
        manifest,
        isLoading,
        error,
        heatMap,
        pendingQuestions,
        coverageStats,
        markAsNeedsReview,
        answerQuestion
    };
}