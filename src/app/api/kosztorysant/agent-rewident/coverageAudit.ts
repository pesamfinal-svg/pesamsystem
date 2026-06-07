// ============================================================
// PESAM – Rozszerzenie Audytu o Pokrycie Zakresu (Coverage Check)
// Analizuje ScopeManifest i generuje alerty dla Rewidenta.
// ============================================================

import { adminDb } from '@/lib/firebase/admin';
import type {
    ScopeManifest,
    CoverageEntry,
} from '../_shared/scopeManifest.types';

export interface CoverageAlert {
    severity: 'CRITICAL' | 'WARNING' | 'INFO';
    code: string;
    elementId: string;
    elementName: string;
    divisionName: string;
    message: string;
    sourceRef?: string;
    estimatedImpact_PLN?: number;
}

export interface CoverageAuditResult {
    coverageScore: number;
    totalElements: number;
    coveredCount: number;
    gapFilledCount: number;
    missingCount: number;
    waitingUserCount: number;
    alerts: CoverageAlert[];
    totalRiskBuffer_PLN: number;
    totalRiskBuffer_Percent: number;
    hardRequirementViolations: string[];
}

// ============================================================
// GŁÓWNA METODA AUDYTU POKRYCIA
// ============================================================

export async function runCoverageAudit(
    tenderId: string,
    totalCost_PLN: number
): Promise<CoverageAuditResult> {
    console.log(`[Coverage Audit] 🔍 Rozpoczynam audyt szczelności zakresu dla przetargu: ${tenderId}...`);

    const manifestDoc = await adminDb
        .doc(`tenders/${tenderId}/scopeManifest/main`)
        .get();

    if (!manifestDoc.exists) {
        console.warn(`[Coverage Audit] ⚠️ Ostrzeżenie: Brak dokumentu ScopeManifest dla przetargu ${tenderId}.`);
        return buildEmptyResult('Brak ScopeManifest. Generowanie alertów pokrycia pominięte.');
    }

    const manifest = manifestDoc.data() as ScopeManifest;
    const alerts: CoverageAlert[] = [];

    const coverage = manifest.coverageStatus;
    const total = coverage.length;
    const covered = coverage.filter((c) => c.status === 'COVERED').length;
    const gapFilled = coverage.filter((c) => c.status === 'GAP_FILLED').length;
    const missing = coverage.filter((c) => c.status === 'MISSING').length;
    const waitingUser = coverage.filter((c) => c.status === 'WAITING_USER').length;

    console.log(`[Coverage Audit] Dane pokrycia: Wyliczone=${covered} | Łatki=${gapFilled} | Brakujące=${missing} | Blokady=${waitingUser}`);

    // 1. Wykrywanie twardych braków (MISSING lub WAITING_USER)
    for (const entry of coverage.filter((c) => c.status === 'MISSING' || c.status === 'WAITING_USER')) {
        const element = findElement(manifest, entry.elementId);
        const division = manifest.requiredDivisions.find((d) => d.divisionId === entry.divisionId);
        if (!element || !division) continue;

        if (element.isMandatoryByLaw) {
            console.log(`[Coverage Audit] ❗ Wykryto krytyczny brak prawny: "${element.name}" jest wymagane przepisami.`);
            alerts.push({
                severity: 'CRITICAL',
                code: 'MISSING_MANDATORY_BY_LAW',
                elementId: entry.elementId,
                elementName: element.name,
                divisionName: division.divisionName,
                message: `❗ BRAK BEZWZGLĘDNY: Wycena nie zawiera pozycji **${element.name}** (${division.divisionName}) wymaganej przez polskie Prawo Budowlane. Oferta grozi odrzuceniem!`,
            });
        } else if (entry.status === 'WAITING_USER') {
            alerts.push({
                severity: 'WARNING',
                code: 'WAITING_USER_INPUT',
                elementId: entry.elementId,
                elementName: element.name,
                divisionName: division.divisionName,
                message: `⚠️ Pozycja **${element.name}** nie została wyceniona. System czeka na podanie parametrów w oknie czatu (ASK_USER).`,
            });
        } else {
            alerts.push({
                severity: 'WARNING',
                code: 'MISSING_ELEMENT',
                elementId: entry.elementId,
                elementName: element.name,
                divisionName: division.divisionName,
                message: `⚠️ Wykryto lukę: kosztorys nie uwzględnia pozycji **${element.name}** (${division.divisionName}). Gap Filler nie posiadał danych do jej oszacowania.`,
            });
        }
    }

    // 2. Sumaryczny raport z pracy Gap Fillera
    const gapFilledEntries = coverage.filter((c) => c.status === 'GAP_FILLED');
    if (gapFilledEntries.length > 0) {
        const totalGapValue = gapFilledEntries.reduce((sum, c) => sum + (c.gapFillerValue ?? 0), 0);
        const gapPercent = totalCost_PLN > 0 ? ((totalGapValue / totalCost_PLN) * 100).toFixed(1) : '0';

        alerts.push({
            severity: 'INFO',
            code: 'GAP_FILLED_SUMMARY',
            elementId: 'SUMMARY',
            elementName: 'Raport Gap Fillera',
            divisionName: 'Wszystkie działy',
            message: `ℹ️ Gap Filler automatycznie doliczył **${gapFilledEntries.length} pozycji** na podstawie norm i wskaźników (łącznie: **${totalGapValue.toLocaleString('pl-PL')} PLN**, tj. **${gapPercent}%** budżetu).`,
            estimatedImpact_PLN: totalGapValue,
        });
    }

    // 3. Weryfikacja twardych wymagań z SWZ (HardRequirements)
    const hardRequirementViolations: string[] = [];
    for (const req of manifest.hardRequirements.filter((hr) => hr.isMandatory)) {
        const affectedDivsCovered = req.affectedDivisionIds.every((divId) => {
            const divCoverage = coverage.filter(
                (c) => c.divisionId === divId && (c.status === 'COVERED' || c.status === 'GAP_FILLED')
            );
            return divCoverage.length > 0;
        });

        if (!affectedDivsCovered) {
            console.log(`[Coverage Audit] ❗ Naruszono twardy warunek SWZ: "${req.description}"`);
            hardRequirementViolations.push(req.id);
            alerts.push({
                severity: 'CRITICAL',
                code: 'HARD_REQUIREMENT_VIOLATION',
                elementId: req.id,
                elementName: req.description,
                divisionName: req.affectedDivisionIds.join(', '),
                message: `❗ BŁĄD ZGODNOŚCI Z SWZ: Oferta nie spełnia zapisu o treści: **"${req.description}"** (${req.sourceRef}). Ryzyko odrzucenia oferty przez Inwestora.`,
                sourceRef: req.sourceRef,
            });
        }
    }

    // 4. Kalkulacja buforów ryzyka za wykryte braki
    let totalRiskPercent = 0;
    for (const risk of manifest.missingDataRisks) {
        totalRiskPercent += risk.userOverridePercent ?? risk.costImpactPercent;
    }
    const totalRiskBuffer_PLN = Math.round(totalCost_PLN * (totalRiskPercent / 100));

    if (totalRiskPercent > 12) {
        alerts.push({
            severity: 'WARNING',
            code: 'HIGH_RISK_BUFFER',
            elementId: 'RISK',
            elementName: 'Rezerwa ryzyka',
            divisionName: 'Budżet całkowity',
            message: `⚠️ Wykryte braki w dokumentacji generują wysokie ryzyko finansowe. Doliczona zalecana rezerwa: **+${totalRiskPercent.toFixed(0)}%** budżetu (tj. **${totalRiskBuffer_PLN.toLocaleString('pl-PL')} PLN**).`,
            estimatedImpact_PLN: totalRiskBuffer_PLN,
        });
    }

    // 5. Ostateczny wskaźnik pokrycia (Coverage Score)
    const weightedCoverage = total > 0
        ? (covered * 1.0 + gapFilled * 0.7 + waitingUser * 0.3) / total
        : 0;
    const coverageScore = Math.round(weightedCoverage * 100);

    if (coverageScore < 60) {
        console.log(`[Coverage Audit] ❌ Krytycznie niski wskaźnik szczelności: ${coverageScore}%`);
        alerts.unshift({
            severity: 'CRITICAL',
            code: 'LOW_COVERAGE_SCORE',
            elementId: 'COVERAGE',
            elementName: 'Pokrycie zakresu',
            divisionName: 'Wszystkie działy',
            message: `❗ KRYTYCZNA NIEKOMPLETNOŚĆ: Całkowity wskaźnik szczelności zakresu wynosi zaledwie **${coverageScore}%**. Kosztorys posiada zbyt wiele luk, by złożyć bezpieczną ofertę.`,
        });
    }

    console.log(`[Coverage Audit] Audyt zakończony. CoverageScore: ${coverageScore}% | Wygenerowano alertów: ${alerts.length}`);
    return {
        coverageScore,
        totalElements: total,
        coveredCount: covered,
        gapFilledCount: gapFilled,
        missingCount: missing,
        waitingUserCount: waitingUser,
        alerts: alerts.sort(sortAlerts),
        totalRiskBuffer_PLN,
        totalRiskBuffer_Percent: totalRiskPercent,
        hardRequirementViolations,
    };
}

// Helper: Markuje elementy jako pokryte przez agenty w locie (A2A)
export async function markElementAsCovered(
    tenderId: string,
    divisionId: string,
    sectionId: string,
    dataQuality: 'MARKET_VERIFIED' | 'NORMATIVE' | 'ESTIMATED'
): Promise<void> {
    console.log(`[Coverage Audit] Oznaczam element w dziale "${divisionId}" jako pokryty przez sekcję "${sectionId}"...`);
    try {
        const manifestRef = adminDb.doc(`tenders/${tenderId}/scopeManifest/main`);
        const manifestDoc = await manifestRef.get();

        if (!manifestDoc.exists) return;

        const manifest = manifestDoc.data() as ScopeManifest;
        const now = new Date().toISOString();

        const updatedCoverage = manifest.coverageStatus.map((entry) => {
            if (entry.divisionId === divisionId && entry.status === 'MISSING') {
                return {
                    ...entry,
                    status: 'COVERED' as const,
                    coveredBySectionId: sectionId,
                    dataQuality,
                    lastUpdatedBy: `agent-roj`,
                    lastUpdatedAt: now,
                };
            }
            return entry;
        });

        await manifestRef.update({
            coverageStatus: updatedCoverage,
            'meta.updatedAt': now,
        });
    } catch (e) {
        console.error('[Coverage Audit] Błąd uaktualniania statusu:', e);
    }
}

function findElement(manifest: ScopeManifest, elementId: string) {
    for (const div of manifest.requiredDivisions) {
        const el = div.elements.find((e) => e.elementId === elementId);
        if (el) return el;
    }
    return null;
}

function sortAlerts(a: CoverageAlert, b: CoverageAlert): number {
    const order = { CRITICAL: 0, WARNING: 1, INFO: 2 };
    return order[a.severity] - order[b.severity];
}

function buildEmptyResult(reason: string): CoverageAuditResult {
    return {
        coverageScore: 0,
        totalElements: 0,
        coveredCount: 0,
        gapFilledCount: 0,
        missingCount: 0,
        waitingUserCount: 0,
        alerts: [{
            severity: 'WARNING',
            code: 'NO_MANIFEST',
            elementId: 'META',
            elementName: 'ScopeManifest',
            divisionName: 'System',
            message: `⚠️ ${reason}`,
        }],
        totalRiskBuffer_PLN: 0,
        totalRiskBuffer_Percent: 0,
        hardRequirementViolations: [],
    };
}