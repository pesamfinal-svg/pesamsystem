// ============================================================
// PESAM – Agent Rewident (Rozszerzony o Audyt Zakresu)
// POST /api/kosztorysant/agent-rewident
//
// Zapisuje: tenders/{tenderId} (rewidentReport, finalScore, status)
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenAI, Type } from '@google/genai';
import { adminDb } from '@/lib/firebase/admin';
import { runCoverageAudit, type CoverageAuditResult } from './coverageAudit';

export const dynamic = "force-dynamic";

const MODEL_PRO = "gemini-2.5-pro";

interface Section {
    sectionId: string;
    divisionId: string;
    divisionName: string;
    items: Array<{
        itemId: string;
        name: string;
        unit: string;
        quantity: number | null;
        unitPrice: number | null;
        totalPrice: number;
        dataQuality?: string;
    }>;
    totalPrice: number;
}

interface DeterministicAlert {
    severity: 'CRITICAL' | 'WARNING' | 'INFO';
    code: string;
    message: string;
    value?: number;
}

const BRANCH_NORMS = {
    D1_ZERO_PERCENT: { min: 8, max: 20, label: 'Stan Zerowy (Roboty ziemne / fundamenty)' },
    D2_ROUGH_PERCENT: { min: 30, max: 55, label: 'Stan Surowy (Ściany / strop / dach)' },
    D3_FINISH_PERCENT: { min: 15, max: 35, label: 'Wykończenie wewnętrzne' },
    D5_SANITARY_PERCENT: { min: 8, max: 18, label: 'Instalacje Sanitarne' },
    D6_ELECTRIC_PERCENT: { min: 6, max: 14, label: 'Instalacje Elektryczne' },
    LABOR_RATE_MIN: 35,
    LABOR_RATE_MAX: 85,
};

// ============================================================
// ETAP 1: Audyt deterministyczny (TypeScript)
// ============================================================

function runDeterministicAudit(sections: Section[]): DeterministicAlert[] {
    console.log(`[Rewident] [Etap 1] Uruchamiam matematyczne testy walidacyjne kosztorysu...`);
    const alerts: DeterministicAlert[] = [];

    const totalCost = sections.reduce((s, sec) => s + sec.totalPrice, 0);
    if (totalCost === 0) {
        alerts.push({
            severity: 'CRITICAL',
            code: 'ZERO_TOTAL_COST',
            message: '❗ KATASTROFA FINANSOWA: Łączny budżet wyceny wynosi 0 PLN. Sprawdź czy pozycje zostały poprawnie zaimportowane.',
        });
        return alerts;
    }

    // Wyszukiwanie zerowych cen w pozycjach wycenionych
    for (const section of sections) {
        for (const item of section.items) {
            if (item.totalPrice === 0 && item.quantity !== 0) {
                alerts.push({
                    severity: 'CRITICAL',
                    code: 'ZERO_PRICE_ITEM',
                    message: `❗ LUKA CENOWA: Pozycja **"${item.name}"** (${section.divisionName}) posiada wycenę rynkową wynoszącą 0.00 PLN. Sprawdź i uzupełnij cenę.`,
                    value: 0,
                });
            }
        }
    }

    // Analiza wskaźników procentowych branż
    const divisionTotals: Record<string, number> = {};
    for (const sec of sections) {
        divisionTotals[sec.divisionId] = (divisionTotals[sec.divisionId] ?? 0) + sec.totalPrice;
    }

    function checkPercent(divId: string, norm: { min: number; max: number; label: string }) {
        const divTotal = divisionTotals[divId] ?? 0;
        const percent = (divTotal / totalCost) * 100;
        if (divTotal === 0) {
            alerts.push({
                severity: 'WARNING',
                code: `MISSING_DIVISION_${divId}`,
                message: `⚠️ POMINIĘTY DZIAŁ: Kosztorys nie zawiera żadnej pozycji dla branży **"${norm.label}"** (ID: ${divId}).`,
            });
        } else if (percent < norm.min) {
            alerts.push({
                severity: 'WARNING',
                code: `LOW_PROPORTION_${divId}`,
                message: `⚠️ ANOMALIA PROPORCJI: Branża **"${norm.label}"** stanowi zaledwie ${percent.toFixed(1)}% kosztorysu (średni wskaźnik rynkowy: ${norm.min}-${norm.max}%).`,
                value: percent,
            });
        } else if (percent > norm.max) {
            alerts.push({
                severity: 'WARNING',
                code: `HIGH_PROPORTION_${divId}`,
                message: `⚠️ ANOMALIA PROPORCJI: Branża **"${norm.label}"** pochłania aż ${percent.toFixed(1)}% całego budżetu (średni wskaźnik rynkowy: ${norm.min}-${norm.max}%).`,
                value: percent,
            });
        }
    }

    checkPercent('D1', BRANCH_NORMS.D1_ZERO_PERCENT);
    checkPercent('D2', BRANCH_NORMS.D2_ROUGH_PERCENT);
    checkPercent('D3', BRANCH_NORMS.D3_FINISH_PERCENT);
    checkPercent('D5', BRANCH_NORMS.D5_SANITARY_PERCENT);
    checkPercent('D6', BRANCH_NORMS.D6_ELECTRIC_PERCENT);

    // Walidacja rynkowych stawek roboczogodziny (r-g)
    for (const section of sections) {
        for (const item of section.items) {
            if (item.unit === 'r-g' && item.unitPrice !== null) {
                if (item.unitPrice < BRANCH_NORMS.LABOR_RATE_MIN) {
                    alerts.push({
                        severity: 'CRITICAL',
                        code: 'LOW_LABOR_RATE',
                        message: `❗ STAWKA DEFICYTOWA: Roboczogodzina r-g w pozycji **"${item.name}"** wynosi tylko ${item.unitPrice} PLN. Spadek poniżej progu ${BRANCH_NORMS.LABOR_RATE_MIN} PLN grozi odrzuceniem przez PIP lub brakiem rąk do pracy.`,
                        value: item.unitPrice,
                    });
                } else if (item.unitPrice > BRANCH_NORMS.LABOR_RATE_MAX) {
                    alerts.push({
                        severity: 'WARNING',
                        code: 'HIGH_LABOR_RATE',
                        message: `⚠️ PRZESZACOWANIE ROBOCIZNY: Stawka ${item.unitPrice} PLN/r-g w pozycji **"${item.name}"** wykracza ponad zalecane maksimum rynkowe (${BRANCH_NORMS.LABOR_RATE_MAX} PLN).`,
                        value: item.unitPrice,
                    });
                }
            }
        }
    }

    return alerts;
}

// ============================================================
// ETAP 2: Audyt anomalii inżynierskich (Gemini Pro)
// ============================================================

async function runAIEngineeringAudit(
    sections: Section[],
    totalCost: number,
    objectType: string
): Promise<string[]> {
    console.log(`[Rewident] [Etap 2] Wzywam Agenta Gemini Pro w celu wychwycenia technologicznych błędów inżynieryjnych...`);

    const ai = new GoogleGenAI({
        vertexai: true,
        project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
        location: "global",
    });

    const summary = sections.map((sec) => ({
        dział: sec.divisionName,
        koszt: sec.totalPrice,
        pozycje: sec.items.map((i) => ({ nazwa: i.name, ilość: i.quantity, jednostka: i.unit, cena: i.totalPrice })),
    }));

    const prompt = `
Przeanalizuj poniższy uproszczony kosztorys.
Inwestycja: Budowa obiektu o przeznaczeniu: "${objectType}".
Całkowity budżet: ${totalCost.toLocaleString('pl-PL')} PLN.

DANE KOSZTORYSOWE:
${JSON.stringify(summary, null, 2)}

Oceń wzajemne powiązania elementów pod kątem fizyki budowli i technologii. 
Czy nie ma rażących dysproporcji (np. doliczone tynki bez ścian, zbrojenie niespójne z objętością betonu)?
  `.trim();

    try {
        const result = await ai.models.generateContent({
            model: MODEL_PRO,
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            config: {
                systemInstruction: `Jesteś Głównym Audytorem Budowlanym. Zwróć wyłącznie tablicę JSON zawierającą maksymalnie 4 najważniejsze, konkretne anomalie inżynierskie. Odpowiadaj tylko po polsku. Format: ["anomalia 1", "anomalia 2"]. Jeśli błędów brak, zwróć pustą tablicę [].`,
                temperature: 0.1,
                responseMimeType: "application/json",
            }
        });

        const raw = (result.text ?? "[]").replace(/```json|```/g, '').trim();
        const anomalies = JSON.parse(raw) as string[];
        console.log(`[Rewident] [Etap 2] Analiza AI zakończona. Wykryto anomalii technologicznych: ${anomalies.length}`);
        return anomalies;
    } catch (err) {
        console.error(`[Rewident] [Etap 2] Błąd podczas analizy inżynieryjnej AI:`, err);
        return [];
    }
}

// Przeliczenie ostatecznego wyniku (0-100)
function calculateFinalScore(
    deterministicAlerts: DeterministicAlert[],
    aiAnomalies: string[],
    coverageResult: CoverageAuditResult
): number {
    let score = 100;

    for (const alert of deterministicAlerts) {
        if (alert.severity === 'CRITICAL') score -= 15;
        if (alert.severity === 'WARNING') score -= 5;
    }

    score -= aiAnomalies.length * 8;

    // Uwzględniamy Wskaźnik Pokrycia Zakresu (Waga 30% całego wyniku)
    const coveragePenalty = Math.round((1 - coverageResult.coverageScore / 100) * 30);
    score -= coveragePenalty;

    // Kara za niespełnienie twardych warunków SWZ/OPZ
    score -= coverageResult.hardRequirementViolations.length * 10;

    const final = Math.max(0, Math.min(100, score));
    console.log(`[Rewident] [Kalkulator] Wynik ostateczny = ${final}/100 | Kara za brak pokrycia: -${coveragePenalty} pkt.`);
    return final;
}

// ============================================================
// GŁÓWNY HANDLER POST
// ============================================================

export async function POST(req: NextRequest) {
    const startTime = Date.now();
    console.log("==================================================");
    console.log("[Rewident] === ROZPOCZĘTO WIELOBRANŻOWY AUDYT KOSZTORYSU ===");
    console.log("==================================================");

    try {
        const { tenderId } = await req.json() as { tenderId: string };

        if (!tenderId) {
            console.error("[Rewident] ❌ Błąd: Brak parametru tenderId.");
            return NextResponse.json({ error: 'Brak parametru tenderId' }, { status: 400 });
        }

        const tenderDoc = await adminDb.doc(`tenders/${tenderId}`).get();
        const tenderData = tenderDoc.data();
        if (!tenderData) {
            console.error(`[Rewident] ❌ Błąd: Przetarg ${tenderId} nie istnieje w bazie.`);
            return NextResponse.json({ error: 'Przetarg nie istnieje' }, { status: 404 });
        }

        const sections: Section[] = tenderData.sections ?? [];
        const totalCost = sections.reduce((s, sec) => s + sec.totalPrice, 0);
        const objectType = tenderData.objectType ?? 'nieznany';

        // --- ETAP 1: Audyt matematyczny ---
        const deterministicAlerts = runDeterministicAudit(sections);

        // --- ETAP 2: Audyt technologiczny AI ---
        const aiAnomalies = await runAIEngineeringAudit(sections, totalCost, objectType);

        // --- ETAP 3: Audyt pokrycia z ScopeManifestu ---
        const coverageResult = await runCoverageAudit(tenderId, totalCost);

        // --- Kalkulacja finalnego punktu ---
        const finalScore = calculateFinalScore(deterministicAlerts, aiAnomalies, coverageResult);

        const report = {
            tenderId,
            generatedAt: new Date().toISOString(),
            finalScore,
            totalCost_PLN: totalCost,

            deterministicAlerts,
            aiAnomalies,

            // Dane z ScopeManifestu (nowość)
            coverageScore: coverageResult.coverageScore,
            coverageAlerts: coverageResult.alerts,
            coverageStats: {
                total: coverageResult.totalElements,
                covered: coverageResult.coveredCount,
                gapFilled: coverageResult.gapFilledCount,
                missing: coverageResult.missingCount,
                waitingUser: coverageResult.waitingUserCount,
            },
            hardRequirementViolations: coverageResult.hardRequirementViolations,

            riskBuffer: {
                percent: coverageResult.totalRiskBuffer_Percent,
                value_PLN: coverageResult.totalRiskBuffer_PLN,
                budgetWithRisk_PLN: totalCost + coverageResult.totalRiskBuffer_PLN,
            },

            chatSummary: buildChatSummary(
                finalScore,
                coverageResult,
                deterministicAlerts,
                aiAnomalies,
                totalCost
            ),
        };

        // Zapis raportu do Firestore
        console.log(`[Rewident] Zapisuję finalny raport i status wyceny w rekordzie głównym tenders/${tenderId}...`);
        await adminDb.doc(`tenders/${tenderId}`).update({
            rewidentReport: report,
            finalScore,
            status: finalScore >= 70 ? 'READY_FOR_REVIEW' : 'NEEDS_CORRECTION',
            updatedAt: new Date().toISOString(),
        });

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`[Rewident] ✅ Audyt zakończony sukcesem w czasie ${duration} sek.`);
        console.log("==================================================");

        return NextResponse.json({ success: true, report });

    } catch (error: any) {
        console.error('[Rewident] ❌ Krytyczny błąd audytora:', error);
        return NextResponse.json(
            { error: 'Błąd audytu Rewidenta', details: String(error) },
            { status: 500 }
        );
    }
}

function buildChatSummary(
    score: number,
    coverage: CoverageAuditResult,
    detAlerts: DeterministicAlert[],
    aiAnomalies: string[],
    totalCost: number
): string {
    const emoji = score >= 82 ? '✅' : score >= 65 ? '⚠️' : '❌';
    const verdict = score >= 82
        ? 'Kosztorys został zweryfikowany i jest wysoce spójny technicznie.'
        : score >= 65
            ? 'Kosztorys zawiera niepewne dane lub luki. Zalecany audyt ręczny przed złożeniem oferty.'
            : 'KRYTYCZNE BŁĘDY: Kosztorys jest skrajnie niekompletny lub zawiera rażące luki cenowe. Nie składaj oferty!';

    const criticalCount = [
        ...detAlerts.filter((a) => a.severity === 'CRITICAL'),
        ...coverage.alerts.filter((a) => a.severity === 'CRITICAL'),
    ].length;

    const warningCount = [
        ...detAlerts.filter((a) => a.severity === 'WARNING'),
        ...coverage.alerts.filter((a) => a.severity === 'WARNING'),
    ].length;

    return [
        `${emoji} **Rewident zakończył audyt. Score: ${score}/100.**`,
        `💬 *Diagnoza:* ${verdict}`,
        ``,
        `📊 **Pokrycie zakresu:** ${coverage.coverageScore}% (Wyliczone: ${coverage.coveredCount} | Normatywne: ${coverage.gapFilledCount} | Do uzupełnienia: ${coverage.missingCount + coverage.waitingUserCount})`,
        `💰 **Całkowity koszt kosztorysu:** ${totalCost.toLocaleString('pl-PL')} PLN`,
        coverage.totalRiskBuffer_PLN > 0
            ? `⚠️ **Rezerwa ryzyka dokumentacyjnego (+${coverage.totalRiskBuffer_Percent}%):** +${coverage.totalRiskBuffer_PLN.toLocaleString('pl-PL')} PLN\n📈 **Zalecana oferta z buforem bezpieczeństwa:** **${(totalCost + coverage.totalRiskBuffer_PLN).toLocaleString('pl-PL')} PLN**`
            : '',
        ``,
        criticalCount > 0 ? `❗ **Wykryto ${criticalCount} błędów krytycznych** (błędy uniemożliwiające złożenie oferty).` : '',
        warningCount > 0 ? `⚠️ **Wykryto ${warningCount} ostrzeżeń** (potencjalne braki lub anomalie proporcji).` : '',
        aiAnomalies.length > 0
            ? `🔍 **Wnioski technologiczne AI (${aiAnomalies.length}):**\n` + aiAnomalies.map((a) => `• ${a}`).join('\n')
            : '',
    ]
        .filter(Boolean)
        .join('\n');
}