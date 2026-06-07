// ============================================================
// PESAM – Agent Gap Filler (Łatacz Luk) ZINTEGROWANY Z MÓZGIEM
// POST /api/kosztorysant/agent-gap-filler
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase/admin';
import type {
    ScopeManifest,
    ScopeElement,
    CoverageEntry,
    GapFillerResult,
} from '../_shared/scopeManifest.types';

export const dynamic = "force-dynamic";

// ============================================================
// Kalkulator Gap Fillera – logika per strategia
// ============================================================

interface GapCalcInput {
    element: ScopeElement;
    tenderData: {
        objectArea_m2: number | null;
        objectType: string;
        totalRoughCost_PLN: number | null;
        totalCost_PLN: number | null;
    };
    brainIndicators: any | null;
}

function calculateGapFill(input: GapCalcInput): GapFillerResult | null {
    const { element, tenderData, brainIndicators } = input;
    const area = tenderData.objectArea_m2;
    const roughCost = tenderData.totalRoughCost_PLN;

    console.log(`[Gap Filler] [Przelicznik] Wyliczam pozycję: "${element.name}" | Strategia: ${element.gapFillerStrategy}`);

    switch (element.gapFillerStrategy) {
        case 'EUROKOD_NORM': {
            let quantity = 0;
            let unitCost_PLN = 0;

            // FIX TS: Jawne przypisanie typu i pobranie wartości
            let usedMultiplier: number | undefined = element.gapFillerMultiplier;
            let noteSource = `Eurokod, mnożnik ${element.gapFillerMultiplier || 'domyślny'}`;

            // 🧠 ZASTOSOWANIE PESAM BRAIN
            if (element.unit === 'm³' && element.name.toLowerCase().includes('fundament') && brainIndicators?.concretePerM2Floor?.avg) {
                usedMultiplier = brainIndicators.concretePerM2Floor.avg;
                noteSource = `PESAM Brain (wiedza z historycznych projektów)`;
                console.log(`[Gap Filler] 🧠 Mózg zastąpił mnożnik dla Betonu: ${usedMultiplier!.toFixed(3)} m³/m²`);
            } else if (element.unit === 'm²' && element.name.toLowerCase().includes('tynk') && brainIndicators?.plasterM2PerM2Floor?.avg) {
                usedMultiplier = brainIndicators.plasterM2PerM2Floor.avg;
                noteSource = `PESAM Brain (wiedza z historycznych projektów)`;
                console.log(`[Gap Filler] 🧠 Mózg zastąpił mnożnik dla Tynków: ${usedMultiplier!.toFixed(3)} m²/m²`);
            }

            // FIX TS: Twarde sprawdzenie dla kompilatora przed matematyką
            if (!area || usedMultiplier === undefined || usedMultiplier <= 0) {
                console.warn(`[Gap Filler] [Przelicznik] ⚠️ Nie można doliczyć ${element.name} przez EUROKOD_NORM - brak powierzchni lub mnożnika.`);
                return null;
            }

            if (element.unit === 'm³') {
                quantity = area * usedMultiplier;
                unitCost_PLN = 800;
            } else if (element.unit === 'm²') {
                quantity = area * usedMultiplier;
                unitCost_PLN = 120;
            } else if (element.unit === 't') {
                quantity = area * usedMultiplier;
                unitCost_PLN = 5500;
            }

            if (quantity <= 0 || unitCost_PLN <= 0) return null;

            const cost = Math.round(quantity * unitCost_PLN);
            console.log(`[Gap Filler] [Przelicznik] Sukces: "${element.name}" -> ${quantity.toFixed(2)} ${element.unit} = ${cost} PLN.`);

            return {
                elementId: element.elementId,
                divisionId: '',
                strategy: 'EUROKOD_NORM',
                estimatedValue_PLN: cost,
                note: element.gapFillerHint ? `Szacunek wg: ${noteSource}. ${element.gapFillerHint}` : `Szacunek wg: ${noteSource}`,
                dataQuality: 'NORMATIVE',
            };
        }

        case 'SEKOCENBUD_M2': {
            if (!area) {
                console.warn(`[Gap Filler] [Przelicznik] ⚠️ Brak powierzchni (objectArea_m2) dla SEKOCENBUD_M2 dla: "${element.name}"`);
                return null;
            }

            const SEKOCENBUD_RATES: Record<string, number> = {
                'dach': 320,
                'posadzki': 185,
                'stolarka': 280,
                'elewacja': 420,
                'nawierzchnia': 180,
                'default': 250,
            };

            const rate = detectRate(element.name, SEKOCENBUD_RATES);
            const cost = Math.round(area * rate);
            console.log(`[Gap Filler] [Przelicznik] Sukces: "${element.name}" -> ${area} m² x ${rate} PLN = ${cost} PLN.`);

            return {
                elementId: element.elementId,
                divisionId: '',
                strategy: 'SEKOCENBUD_M2',
                estimatedValue_PLN: cost,
                note: `${rate} PLN/m² × ${area} m² PUM (Baza Sekocenbud Q1 2025, dane scalone)`,
                dataQuality: 'NORMATIVE',
            };
        }

        case 'GUS_PERCENT': {
            if (!roughCost && !tenderData.totalCost_PLN) {
                console.warn(`[Gap Filler] [Przelicznik] ⚠️ Brak kosztów bazowych dla GUS_PERCENT w pozycji: "${element.name}"`);
                return null;
            }
            const base = roughCost || tenderData.totalCost_PLN || 0;
            if (base === 0) return null;

            let multiplier = element.gapFillerMultiplier || 0.08;
            let noteSource = `średnich wskaźników GUS`;

            // 🧠 ZASTOSOWANIE PESAM BRAIN
            if (element.name.toLowerCase().includes('sanitarn') && brainIndicators?.proportions?.D5_sanitaryPercent?.avg) {
                multiplier = brainIndicators.proportions.D5_sanitaryPercent.avg / 100;
                noteSource = `PESAM Brain (wiedza z historycznych projektów)`;
                console.log(`[Gap Filler] 🧠 Mózg zastąpił narzut Sanitarki: ${(multiplier * 100).toFixed(1)}%`);
            } else if (element.name.toLowerCase().includes('elektrycz') && brainIndicators?.proportions?.D6_electricPercent?.avg) {
                multiplier = brainIndicators.proportions.D6_electricPercent.avg / 100;
                noteSource = `PESAM Brain (wiedza z historycznych projektów)`;
                console.log(`[Gap Filler] 🧠 Mózg zastąpił narzut Elektryki: ${(multiplier * 100).toFixed(1)}%`);
            }

            const cost = Math.round(base * multiplier);

            console.log(`[Gap Filler] [Przelicznik] Sukces: "${element.name}" -> ${(multiplier * 100).toFixed(1)}% z bazy ${base} PLN = ${cost} PLN.`);

            return {
                elementId: element.elementId,
                divisionId: '',
                strategy: 'GUS_PERCENT',
                estimatedValue_PLN: cost,
                note: `${(multiplier * 100).toFixed(1)}% kosztu bazowego stanu surowego (${base.toLocaleString('pl-PL')} PLN) wg ${noteSource}`,
                dataQuality: 'ESTIMATED',
            };
        }

        case 'ASK_USER':
            return null;

        default:
            return null;
    }
}

function detectRate(name: string, rates: Record<string, number>): number {
    const lower = name.toLowerCase();
    for (const [key, rate] of Object.entries(rates)) {
        if (key !== 'default' && lower.includes(key)) return rate;
    }
    return rates['default'];
}

// ============================================================
// Pobieranie finansowych danych z Firestore
// ============================================================

async function extractTenderFinancials(tenderId: string): Promise<{
    totalRoughCost_PLN: number | null;
    totalCost_PLN: number | null;
    concreteVolume_m3: number | null;
}> {
    console.log(`[Gap Filler] [Finanse] Przeszukuję dotychczas wyliczony kosztorys dla: ${tenderId}...`);
    try {
        const tenderDoc = await adminDb.doc(`tenders/${tenderId}`).get();
        const data = tenderDoc.data();
        if (!data?.sections) {
            console.log(`[Gap Filler] [Finanse] Brak sekcji (sections) w bazie.`);
            return { totalRoughCost_PLN: null, totalCost_PLN: null, concreteVolume_m3: null };
        }

        let totalRoughCost = 0;
        let totalCost = 0;
        let concreteVolume = 0;

        for (const section of data.sections) {
            // FIX TS: Wyeliminowano zbędne użycie ?? na korzyść standardowych if/else (ternary)
            const sectionTotal = section.items?.reduce(
                (sum: number, item: any) => sum + (item.totalPrice ? item.totalPrice : ((item.unitPrice || 0) * (item.quantity || 1))),
                0
            ) || 0;

            totalCost += sectionTotal;

            // Stan surowy = D1 (Zerowy) + D2 (Surowy)
            if (section.divisionId === 'D1' || section.divisionId === 'D2') {
                totalRoughCost += sectionTotal;
            }

            for (const item of section.items || []) {
                if (item.unit === 'm³' && item.name?.toLowerCase().includes('beton')) {
                    concreteVolume += item.quantity || 0;
                }
            }
        }

        console.log(`[Gap Filler] [Finanse] Podsumowanie: Koszt całkowity Roju = ${totalCost} PLN | Stan surowy = ${totalRoughCost} PLN`);
        return {
            totalRoughCost_PLN: totalRoughCost > 0 ? totalRoughCost : null,
            totalCost_PLN: totalCost > 0 ? totalCost : null,
            concreteVolume_m3: concreteVolume > 0 ? concreteVolume : null,
        };
    } catch (err) {
        console.error(`[Gap Filler] [Finanse] Błąd odczytu danych kosztorysu:`, err);
        return { totalRoughCost_PLN: null, totalCost_PLN: null, concreteVolume_m3: null };
    }
}

// ============================================================
// Dopasowanie pozycji (Weryfikacja pokrycia)
// ============================================================

async function detectCoveredElements(
    tenderId: string,
    manifest: ScopeManifest
): Promise<Map<string, string>> {
    console.log(`[Gap Filler] [Detekcja] Weryfikuję, co Rój zdołał wyliczyć w tym cyklu...`);
    const covered = new Map<string, string>();

    try {
        const tenderDoc = await adminDb.doc(`tenders/${tenderId}`).get();
        const sections = tenderDoc.data()?.sections || [];

        for (const div of manifest.requiredDivisions) {
            for (const el of div.elements) {
                for (const section of sections) {
                    if (section.divisionId === div.divisionId) {
                        if (section.sectionId?.startsWith('GAP-')) continue;
                        // FIX TS: Zamiana operatora ?? na logiczny OR ||
                        covered.set(el.elementId, section.sectionId || section.divisionId);
                        break;
                    }
                    for (const item of section.items || []) {
                        if (isNameMatch(item.name, el.name)) {
                            covered.set(el.elementId, section.sectionId);
                            break;
                        }
                    }
                }
            }
        }
    } catch (e) {
        console.error('[Gap Filler] [Detekcja] Błąd detekcji:', e);
    }

    console.log(`[Gap Filler] [Detekcja] Wynik: ${covered.size} z ${manifest.coverageStatus.length} pozycji zostało już pokrytych przez Rój.`);
    return covered;
}

function isNameMatch(sectionItemName: string, elementName: string): boolean {
    if (!sectionItemName || !elementName) return false;
    const normalize = (s: string) => s.toLowerCase().replace(/[^a-ząćęłńóśźż ]/g, '');
    const keywords = normalize(elementName).split(' ').filter((w) => w.length > 4);
    const target = normalize(sectionItemName);
    return keywords.filter((kw) => target.includes(kw)).length >= Math.ceil(keywords.length * 0.5);
}

function buildAskUserQuestion(element: ScopeElement): string {
    const hint = element.gapFillerHint
        ? `\n💡 Wskazówka systemowa: ${element.gapFillerHint}`
        : '';
    return `Wycena pozycji **${element.name}** wymaga Twojej decyzji.${hint}\n\nPodaj mi oczekiwaną kwotę lub parametry ilościowe z jednostką, abym doliczył to do budżetu.`;
}

// ============================================================
// GŁÓWNY HANDLER POST
// ============================================================

export async function POST(req: NextRequest) {
    const startTime = Date.now();
    console.log("==================================================");
    console.log("[Gap Filler] === ROZPOCZĘTO PROCES ŁATANIA LUK ===");
    console.log("==================================================");

    try {
        const { tenderId } = await req.json() as { tenderId: string };

        if (!tenderId) {
            console.error("[Gap Filler] ❌ Błąd: Brak parametru tenderId.");
            return NextResponse.json({ error: 'Brak parametru tenderId' }, { status: 400 });
        }

        const manifestPath = `tenders/${tenderId}/scopeManifest/main`;
        console.log(`[Gap Filler] Pobieram manifest projektu: "${manifestPath}"...`);
        const manifestDoc = await adminDb.doc(manifestPath).get();

        if (!manifestDoc.exists) {
            console.error(`[Gap Filler] ❌ Błąd: Brak dokumentu ScopeManifest pod ścieżką "${manifestPath}"!`);
            return NextResponse.json({ error: 'ScopeManifest nie istnieje dla tego projektu' }, { status: 404 });
        }

        const manifest = manifestDoc.data() as ScopeManifest;
        const financials = await extractTenderFinancials(tenderId);
        const coveredMap = await detectCoveredElements(tenderId, manifest);

        // 🧠 POBIERAMY WIEDZĘ MÓZGU DLA OBIEKTU
        const objectType = manifest.meta.objectType;
        let brainIndicators: any = null;

        if (objectType && objectType !== 'inne') {
            console.log(`[Gap Filler] 🧠 Odpytuję bazę PESAM Brain dla typu: ${objectType}...`);
            try {
                const [indSnap, propSnap] = await Promise.all([
                    adminDb.doc(`settings/brainKnowledge/${objectType}/indicators`).get(),
                    adminDb.doc(`settings/brainKnowledge/${objectType}/proportions`).get()
                ]);

                if (indSnap.exists) {
                    brainIndicators = {
                        ...indSnap.data(),
                        proportions: propSnap.exists ? propSnap.data() : null
                    };
                    console.log(`[Gap Filler] ✅ Mózg pobrany poprawnie! Będzie wspierał szacowanie luk.`);
                } else {
                    console.log(`[Gap Filler] ⚠️ Mózg nie ma jeszcze danych dla tego typu obiektu.`);
                }
            } catch (e) {
                console.error(`[Gap Filler] Błąd pobierania mózgu:`, e);
            }
        }

        const updatedCoverage: CoverageEntry[] = [];
        const gapFilledSections: any[] = [];
        const askUserQuestions: Array<{ elementId: string; question: string }> = [];
        const now = new Date().toISOString();

        for (const div of manifest.requiredDivisions) {
            for (const el of div.elements) {
                const existingCoverage = manifest.coverageStatus.find(
                    (c) => c.elementId === el.elementId
                );

                if (coveredMap.has(el.elementId)) {
                    updatedCoverage.push({
                        elementId: el.elementId,
                        divisionId: div.divisionId,
                        status: 'COVERED',
                        coveredBySectionId: coveredMap.get(el.elementId)!,
                        dataQuality: 'MARKET_VERIFIED',
                        gapFillerNote: null,
                        gapFillerValue: null,
                        lastUpdatedBy: 'agent-gap-filler',
                        lastUpdatedAt: now,
                    });
                    continue;
                }

                if (existingCoverage?.status === 'NEEDS_REVIEW') {
                    updatedCoverage.push(existingCoverage);
                    continue;
                }

                if (el.gapFillerStrategy === 'ASK_USER') {
                    const question = buildAskUserQuestion(el);
                    console.log(`[Gap Filler] ⏸️ Pozycja "${el.name}" blokuje automatyczną wycenę (ASK_USER).`);

                    askUserQuestions.push({ elementId: el.elementId, question });
                    updatedCoverage.push({
                        elementId: el.elementId,
                        divisionId: div.divisionId,
                        status: 'WAITING_USER',
                        coveredBySectionId: null,
                        dataQuality: 'MISSING',
                        gapFillerNote: null,
                        gapFillerValue: null,
                        lastUpdatedBy: 'agent-gap-filler',
                        lastUpdatedAt: now,
                        pendingQuestion: question,
                    });
                    continue;
                }

                // 🧠 Przeliczenie Z UŻYCIEM WIEDZY MÓZGU
                const result = calculateGapFill({
                    element: el,
                    tenderData: {
                        objectArea_m2: manifest.meta.objectArea_m2,
                        objectType: manifest.meta.objectType,
                        ...financials,
                    },
                    brainIndicators
                });

                if (result) {
                    result.divisionId = div.divisionId;

                    gapFilledSections.push({
                        sectionId: `GAP-${el.elementId}`,
                        divisionId: div.divisionId,
                        divisionName: div.divisionName,
                        items: [
                            {
                                itemId: `ITEM-${el.elementId}`,
                                name: el.name,
                                unit: el.unit,
                                quantity: null,
                                unitPrice: null,
                                totalPrice: result.estimatedValue_PLN,
                                dataQuality: result.dataQuality,
                                source: 'GAP_FILLED',
                                note: result.note,
                            },
                        ],
                        totalPrice: result.estimatedValue_PLN,
                        dataQuality: result.dataQuality,
                        isGapFilled: true,
                    });

                    updatedCoverage.push({
                        elementId: el.elementId,
                        divisionId: div.divisionId,
                        status: 'GAP_FILLED',
                        coveredBySectionId: `GAP-${el.elementId}`,
                        dataQuality: result.dataQuality,
                        gapFillerNote: result.note,
                        gapFillerValue: result.estimatedValue_PLN,
                        lastUpdatedBy: 'agent-gap-filler',
                        lastUpdatedAt: now,
                    });
                } else {
                    updatedCoverage.push({
                        elementId: el.elementId,
                        divisionId: div.divisionId,
                        status: 'MISSING',
                        coveredBySectionId: null,
                        dataQuality: 'MISSING',
                        gapFillerNote: 'Nie można wyliczyć pozycji bez podania powierzchni w PFU.',
                        gapFillerValue: null,
                        lastUpdatedBy: 'agent-gap-filler',
                        lastUpdatedAt: now,
                    });
                }
            }
        }

        const newScore = calculateNewConfidence(updatedCoverage, manifest.meta.confidenceScore);
        console.log(`[Gap Filler] Aktualizuję ScopeManifest... Nowy ConfidenceScore: ${newScore}/100`);

        await adminDb.doc(`tenders/${tenderId}/scopeManifest/main`).update({
            coverageStatus: updatedCoverage,
            'meta.updatedAt': now,
            'meta.confidenceScore': newScore,
        });

        if (gapFilledSections.length > 0) {
            console.log(`[Gap Filler] Zapisuję ${gapFilledSections.length} wygenerowanych sekcji normowych w tenders/${tenderId}...`);
            const tenderRef = adminDb.doc(`tenders/${tenderId}`);
            const tenderDoc = await tenderRef.get();
            const existingSections = tenderDoc.data()?.sections || [];

            const cleanSections = existingSections.filter(
                (s: any) => !s.sectionId?.startsWith('GAP-')
            );

            await tenderRef.update({
                sections: [...cleanSections, ...gapFilledSections],
            });
        }

        const stats = {
            total: updatedCoverage.length,
            covered: updatedCoverage.filter((c) => c.status === 'COVERED').length,
            gapFilled: updatedCoverage.filter((c) => c.status === 'GAP_FILLED').length,
            waitingUser: updatedCoverage.filter((c) => c.status === 'WAITING_USER').length,
            missing: updatedCoverage.filter((c) => c.status === 'MISSING').length,
            gapFilledTotal_PLN: gapFilledSections.reduce((s, sec) => s + sec.totalPrice, 0),
        };

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`[Gap Filler] ✅ Sukces: proces łatania zakończony w czasie ${duration} sek.`);
        console.log("==================================================");

        return NextResponse.json({
            success: true,
            stats,
            askUserQuestions,
            usedBrain: !!brainIndicators,
            chatMessages: buildChatMessages(stats, askUserQuestions, gapFilledSections),
        });

    } catch (error: any) {
        console.error('[Gap Filler] ❌ Krytyczny błąd podczas łatania kosztorysu:', error);
        return NextResponse.json(
            { error: 'Błąd Gap Fillera', details: String(error) },
            { status: 500 }
        );
    }
}

function calculateNewConfidence(coverage: CoverageEntry[], previousScore: number): number {
    const total = coverage.length;
    if (total === 0) return previousScore;
    const covered = coverage.filter((c) => c.status === 'COVERED').length;
    const gapFilled = coverage.filter((c) => c.status === 'GAP_FILLED').length;
    const weightedScore = (covered * 1.0 + gapFilled * 0.6) / total;
    return Math.round(Math.min(95, Math.max(previousScore, weightedScore * 100)));
}

function buildChatMessages(
    stats: any,
    askUserQuestions: Array<{ elementId: string; question: string }>,
    gapFilledSections: any[]
): string[] {
    const messages: string[] = [];

    if (stats.gapFilled > 0) {
        const total = gapFilledSections.reduce((s, sec) => s + sec.totalPrice, 0);
        messages.push(
            `🏗️ **Gap Filler** doliczył **${stats.gapFilled} pozycji** metodą szacunków normowych ` +
            `(na łączną kwotę ok. **${total.toLocaleString('pl-PL')} PLN**). ` +
            `Pozycje te oznaczono kolorem żółtym (🟡) w Twoim zestawieniu.`
        );
    }

    for (const q of askUserQuestions) {
        messages.push(`⏸️ **Zablokowana pozycja:**\n${q.question}`);
    }

    if (stats.missing > 0) {
        messages.push(
            `⚠️ Nie udało się wyliczyć ${stats.missing} wymaganych pozycji z powodu braku metrażu. ` +
            `Rewident zgłosi te braki jako alerty krytyczne.`
        );
    }

    return messages;
}