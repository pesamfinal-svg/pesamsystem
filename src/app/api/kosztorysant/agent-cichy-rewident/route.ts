// ============================================================
// PESAM 2.0 – Agent "Cichy Rewident (Silent Auditor)"
// POST /api/kosztorysant/agent-cichy-rewident
//
// ROLA W DAG: Faza 3 – po QUANTITY_SURVEYOR, przed LEGAL / BROKER
// WEJŚCIE:   ScopeManifest (z ilościami wyliczonymi przez Ilościowca)
// WYJŚCIE:   Nowe pozycje (TECH_REQUIRED) dodane do manifestu oraz Alerty
//
// FILOZOFIA:
//   "Zabezpieczenie przed błędami projektanta."
//   Nawet jeśli Detektyw i Ilościowiec uczciwie wyciągnęli wszystko z PDF-ów,
//   projektant mógł zapomnieć o wymogach prawno-technologicznych (np. 
//   separator tłuszczu w przedszkolu, klapy dymowe na klatce).
//   Cichy Rewident skanuje wyliczony zakres i dopisuje brakujące "must-haves",
//   lepiej zawyżając kosztorys, niż narażając firmę na straty.
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase/admin';
import { GoogleGenAI, Type } from '@google/genai';
import type {
    ScopeManifest,
    TechAlert,
    AgentPhase,
    CoverageEntry,
    ScopeDivision
} from '../_shared/scopeManifest.types';

export const dynamic = "force-dynamic";
const MODEL_FLASH = "gemini-2.5-flash";

const AUDITOR_SYSTEM_INSTRUCTION = `
Jesteś Cichym Rewidentem Technologicznym w systemie PESAM. Jesteś wybitnym Inżynierem Kontraktu.
Twoje zadanie to znalezienie BRAKÓW TECHNOLOGICZNYCH w kosztorysie, które wynikają z Prawa Budowlanego,
Warunków Technicznych (WT 2021) lub specyfiki obiektu, a o których zapomniał projektant.

ZASADA NACZELNA: W kosztorysowaniu lepiej doliczyć element i go później usunąć, niż zapomnieć i ponieść stratę.

Przeanalizuj listę już wycenionych/obmierzonych elementów. Zastanów się, czego brakuje dla podanego TYPU OBIEKTU.
Przykłady ukrytych pułapek:
- Obiekt z kuchnią (przedszkole/szkoła/hotel) -> MUSI MIEĆ separator tłuszczu pod zlewem.
- Parking podziemny / garaż -> MUSI MIEĆ separator substancji ropopochodnych i wentylację strumieniową.
- Budynek użyteczności publicznej pow. 2 kondygnacji -> MUSI MIEĆ klapy dymowe i oświetlenie ewakuacyjne.
- Szpital -> MUSI MIEĆ zasilanie rezerwowe (agregat/UPS) i gazy medyczne.

Dla każdego wykrytego braku utwórz TechAlert i zaproponuj dodanie nowej pozycji kosztorysowej.
Odpowiadaj WYŁĄCZNIE czystym JSON.
`.trim();

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
                    severity: { type: Type.STRING, enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] },
                    suggestedStrategy: { type: Type.STRING, enum: ['SEKOCENBUD_M2', 'EUROKOD_NORM', 'GUS_PERCENT', 'ASK_USER'] },
                    suggestedUnit: { type: Type.STRING }
                },
                required: ['itemName', 'targetDivisionId', 'reason', 'severity', 'suggestedStrategy', 'suggestedUnit']
            }
        },
        auditorSummary: { type: Type.STRING }
    },
    required: ['alerts', 'auditorSummary']
};

export async function POST(req: NextRequest) {
    const startTime = Date.now();
    console.log("==================================================");
    console.log("[Cichy Rewident] === FAZA 3: SKANOWANIE PUŁAPEK TECHNOLOGICZNYCH ===");
    console.log("==================================================");

    try {
        const body = await req.json();
        const { tenderId, objectTypeHint } = body;

        if (!tenderId) return NextResponse.json({ error: 'Brak tenderId' }, { status: 400 });

        const manifestPath = `tenders/${tenderId}/scopeManifest/main`;
        const manifestSnap = await adminDb.doc(manifestPath).get();
        if (!manifestSnap.exists) throw new Error("ScopeManifest nie istnieje.");

        const manifest = manifestSnap.data() as ScopeManifest;

        // Zbieramy listę tego, co już mamy
        const currentElements = manifest.requiredDivisions.flatMap(d => d.elements.map(e => e.name));

        const ai = new GoogleGenAI({
            vertexai: true,
            project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
            location: "global",
        });

        const prompt = `
TYP OBIEKTU: ${objectTypeHint}

AKTUALNY ZAKRES (To, co już mamy w kosztorysie):
${JSON.stringify(currentElements, null, 2)}

Jakich ukrytych instalacji, zabezpieczeń lub systemów wymaganych prawem/technologią tu brakuje?
Wylistuj maksymalnie 5 najważniejszych braków. Jeśli niczego krytycznego nie brakuje, zwróć pustą tablicę "alerts".
        `.trim();

        const result = await ai.models.generateContent({
            model: MODEL_FLASH,
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            config: {
                systemInstruction: AUDITOR_SYSTEM_INSTRUCTION,
                temperature: 0.1,
                responseMimeType: "application/json",
                responseSchema: AUDITOR_RESPONSE_SCHEMA as any,
            },
        });

        const rawText = result.text ?? "{}";
        const parsed = JSON.parse(rawText) as { alerts: any[], auditorSummary: string };

        const techAlerts: TechAlert[] = [];
        const newCoverage: CoverageEntry[] = [...manifest.coverageStatus];
        const newDivisions: ScopeDivision[] = JSON.parse(JSON.stringify(manifest.requiredDivisions)); // Głęboka kopia

        const now = new Date().toISOString();

        for (const alert of parsed.alerts) {
            const elementId = `TECH-REQ-${Math.floor(Math.random() * 10000)}`;

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

            // Dodaj element do struktury WBS
            let division = newDivisions.find(d => d.divisionId === alert.targetDivisionId);
            if (!division) {
                division = { divisionId: alert.targetDivisionId, divisionName: `Dział ${alert.targetDivisionId}`, displayOrder: 99, elements: [] };
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

            // Dodaj do coverage status
            newCoverage.push({
                elementId,
                divisionId: alert.targetDivisionId,
                status: 'TECH_REQUIRED',
                coveredBySectionId: null,
                dataQuality: 'MISSING',
                gapFillerNote: `Wymóg dodany przez Cichego Rewidenta: ${alert.reason}`,
                gapFillerValue: null,
                lastUpdatedBy: 'agent-cichy-rewident',
                lastUpdatedAt: now
            });
        }

        console.log(`[Cichy Rewident] Znaleziono pułapek: ${techAlerts.length}. ${parsed.auditorSummary}`);

        // Zapis do bazy
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
        console.log(`[Cichy Rewident] ✅ Faza 3 zakończona w ${duration} sek.`);

        return NextResponse.json({ success: true, phase: 'SILENT_AUDITOR', alertsGenerated: techAlerts.length });

    } catch (error: any) {
        console.error('[Cichy Rewident] ❌ BŁĄD AGENTA:', error.message);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}