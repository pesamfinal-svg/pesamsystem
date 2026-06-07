// ============================================================
// PESAM 2.1 – Agent "Cichy Rewident (Silent Auditor)" z Google Search Grounding
// POST /api/kosztorysant/agent-cichy-rewident
//
// ROLA W DAG: Faza 3 – po QUANTITY_SURVEYOR, przed LEGAL / BROKER
// WEJŚCIE:   ScopeManifest (z ilościami wyliczonymi przez Ilościowca)
// WYJŚCIE:   Nowe pozycje (TECH_REQUIRED) dodane do manifestu oraz Alerty
//
// FILOZOFIA PESAM 2.1:
//   Nawet jeśli Detektyw i Ilościowiec wyciągnęli wszystko z rysunków,
//   inżynier projektowy mógł zapomnieć o kluczowych instalacjach prawnych.
//   Silent Auditor korzysta z Google Search, by przeszukać polskie przepisy (np. WT 2021)
//   dla danego typu budynku i automatycznie doliczyć brakujące pozycje technologiczne.
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase/admin';
import { GoogleGenAI, Type } from '@google/genai';
import { buildMandatoryMinimum } from '../_shared/heurystyki';
import type {
    ScopeManifest,
    TechAlert,
    AgentPhase,
    CoverageEntry,
    ScopeDivision
} from '../_shared/scopeManifest.types';

export const dynamic = "force-dynamic";
const MODEL_FLASH = "gemini-2.5-flash";

// POPRAWKA: Usunięcie problematycznych "enum" ze schematu odpowiedzi, by uniknąć błędu payloadu Google API
const AUDITOR_RESPONSE_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        alerts: {
            type: Type.ARRAY,
            items: {
                type: Type.OBJECT,
                properties: {
                    itemName: { type: Type.STRING },
                    targetDivisionId: { type: Type.STRING },
                    reason: { type: Type.STRING },
                    severity: {
                        type: Type.STRING,
                        description: "Musi przyjąć dokładnie jedną z wartości: LOW, MEDIUM, HIGH, lub CRITICAL"
                    },
                    suggestedStrategy: {
                        type: Type.STRING,
                        description: "Musi przyjąć dokładnie jedną z wartości: SEKOCENBUD_M2, EUROKOD_NORM, GUS_PERCENT, lub ASK_USER"
                    },
                    suggestedUnit: { type: Type.STRING }
                },
                required: ['itemName', 'targetDivisionId', 'reason', 'severity', 'suggestedStrategy', 'suggestedUnit']
            }
        },
        auditorSummary: { type: Type.STRING }
    },
    required: ['alerts', 'auditorSummary']
};

const AUDITOR_SYSTEM_INSTRUCTION = `
Jesteś Cichym Rewidentem Technologicznym w systemie PESAM. Jesteś doświadczonym Inżynierem Kontraktu.
Twoje zadanie to znalezienie braków technologicznych w kosztorysie, o których zapomniał projektant.

WYKORZYSTAJ narzędzie wyszukiwania Google Search, aby zweryfikować polskie warunki techniczne (WT 2021) oraz prawo budowlane dla wybranego typu obiektu (np. "wymagania separatora tłuszczu w kuchniach zbiorowych", "klapy dymowe klatki schodowej przepisy", "agregat prądotwórczy szpital normy").

ZASADA: W kosztorysowaniu lepiej doliczyć element bezpieczeństwa i go później usunąć, niż zapomnieć i ponieść stratę.
ODPOWIADAJ WYŁĄCZNIE CZYSTYM JSON.
`.trim();

export async function POST(req: NextRequest) {
    const startTime = Date.now();
    console.log("==================================================");
    console.log("[Cichy Rewident] === FAZA 3: ANALIZA PUŁAPEK TECHNOLOGICZNYCH (v2.1) ===");
    console.log("==================================================");

    try {
        const body = await req.json();
        const { tenderId, objectTypeHint } = body;

        if (!tenderId) {
            console.error("[Cichy Rewident] ❌ Błąd: Brak parametru tenderId.");
            return NextResponse.json({ error: 'Brak tenderId' }, { status: 400 });
        }

        console.log(`[Cichy Rewident] Odczytuję manifest dla projektu: "${tenderId}"...`);
        const manifestPath = `tenders/${tenderId}/scopeManifest/main`;
        const manifestSnap = await adminDb.doc(manifestPath).get();
        if (!manifestSnap.exists) throw new Error("ScopeManifest nie istnieje.");

        const manifest = manifestSnap.data() as ScopeManifest;

        // Zbieramy listę tego, co już mamy w kosztorysie
        const currentElements = manifest.requiredDivisions.flatMap(d => d.elements.map(e => e.name));
        console.log(`[Cichy Rewident] Liczba aktualnych pozycji w wycenie: ${currentElements.length}`);

        console.log("[Cichy Rewident] Inicjalizuję klienta GoogleGenAI (Vertex AI Grounding)...");
        const ai = new GoogleGenAI({
            vertexai: true,
            project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
            location: "global",
        });

        const prompt = `
TYP OBIEKTU: ${objectTypeHint}

AKTUALNY ZAKRES KOSZTORYSU:
${JSON.stringify(currentElements, null, 2)}

ZADANIE:
1. Przeszukaj internet za pomocą Google Search pod kątem polskich norm technicznych i przepisów ppoż/budowlanych dla budynków typu: "${objectTypeHint}".
2. Wyryj krytyczne instalacje, systemy lub urządzenia, o których zapomniał projektant, a które są bezwzględnie wymagane do odbioru technicznego budynku.
3. Wylistuj maksymalnie 5 najważniejszych braków. Jeśli kosztorys jest kompletny, zwróć pustą tablicę "alerts".
        `.trim();

        console.log("[Cichy Rewident] Wysyłam zapytanie do Gemini z włączonym uziemieniem wyszukiwarki Google...");

        const result = await ai.models.generateContent({
            model: MODEL_FLASH,
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            config: {
                systemInstruction: AUDITOR_SYSTEM_INSTRUCTION,
                temperature: 0.1,
                responseMimeType: "application/json",
                responseSchema: AUDITOR_RESPONSE_SCHEMA as any,
                tools: [
                    { googleSearch: {} } // 👈 GROUNDING Z GOOGLE SEARCH WŁĄCZONE!
                ]
            },
        });

        const rawText = result.text ?? "{}";
        const parsed = JSON.parse(rawText) as { alerts: any[], auditorSummary: string };

        const techAlerts: TechAlert[] = [];
        const newCoverage: CoverageEntry[] = [...manifest.coverageStatus];
        const newDivisions: ScopeDivision[] = JSON.parse(JSON.stringify(manifest.requiredDivisions)); // Kopia struktury

        const now = new Date().toISOString();

        console.log(`[Cichy Rewident] Interpretuję ${parsed.alerts.length} braków technologicznych wykrytych przez AI...`);

        for (const alert of parsed.alerts) {
            const elementId = `TECH-REQ-${Math.floor(10000 + Math.random() * 90000)}`;
            console.log(`[Cichy Rewident] Dodaję automatycznie brakującą pozycję: "${alert.itemName}" do działu ${alert.targetDivisionId}`);

            techAlerts.push({
                alertId: elementId,
                itemName: alert.itemName,
                targetDivisionId: alert.targetDivisionId,
                reason: alert.reason,
                severity: alert.severity,
                suggestedStrategy: alert.suggestedStrategy,
                suggestedUnit: alert.suggestedUnit,
                autoAdded: true
            });

            // Dopisywanie brakującej pozycji technologicznej do działu WBS
            let division = newDivisions.find(d => d.divisionId === alert.targetDivisionId);
            if (!division) {
                division = {
                    divisionId: alert.targetDivisionId,
                    divisionName: `Dział ${alert.targetDivisionId}`,
                    displayOrder: 99,
                    elements: []
                };
                newDivisions.push(division);
            }

            division.elements.push({
                elementId,
                name: `[Wymóg Tech] ${alert.itemName}`,
                unit: alert.suggestedUnit,
                source: 'TECH_AUDIT',
                isMandatoryByLaw: true,
                applicableObjectTypes: 'ALL',
                minDocLevel: 0,
                gapFillerStrategy: alert.suggestedStrategy,
                techAuditNote: alert.reason,
                mappedFileId: null,
                quantity: null,
            });

            // Rejestracja w CoverageStatus jako TECH_REQUIRED
            newCoverage.push({
                elementId,
                divisionId: alert.targetDivisionId,
                status: 'TECH_REQUIRED',
                coveredBySectionId: null,
                dataQuality: 'MISSING',
                gapFillerNote: `Wymóg dodany bezpieczeństwa kosztorysu: ${alert.reason}`,
                gapFillerValue: null,
                lastUpdatedBy: 'agent-cichy-rewident',
                lastUpdatedAt: now
            });
        }

        console.log(`[Cichy Rewident] Aktualizuję ScopeManifest w Firestore o wykryte pułapki...`);
        const completedPhases: AgentPhase[] = [...(manifest.meta.completedPhases ?? []), 'SILENT_AUDITOR'];

        await adminDb.doc(manifestPath).update({
            requiredDivisions: newDivisions,
            coverageStatus: newCoverage,
            techAlerts: [...(manifest.techAlerts || []), ...techAlerts],
            'meta.updatedAt': now,
            'meta.completedPhases': completedPhases,
        });

        await adminDb.doc(`tenders/${tenderId}/tasks/${tenderId}-SILENT_AUDITOR`).update({
            status: 'DONE',
            result: { alertsFound: techAlerts.length, summary: parsed.auditorSummary },
            updatedAt: now,
        });

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`[Cichy Rewident] ✅ Faza 3 zakończona sukcesem w ${duration} sek.`);
        console.log("==================================================");

        return NextResponse.json({
            success: true,
            phase: 'SILENT_AUDITOR',
            alertsGenerated: techAlerts.length,
            summary: { alertsFound: techAlerts.length, comment: parsed.auditorSummary }
        });

    } catch (error: any) {
        console.error('[Cichy Rewident] ❌ BŁĄD AGENTA:', error.message);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}