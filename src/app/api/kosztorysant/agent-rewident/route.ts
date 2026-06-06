/**
 * PESAM – Agent Rewident (Audytor Logiczny Kosztorysu)
 *
 * Ścieżka: src/app/api/kosztorysant/agent-rewident/route.ts
 *
 * Odpowiedzialność:
 *  - Ostatnie ogniwo w łańcuchu Roju – uruchamiany po wycenie rynkowej.
 *  - Sprawdza wewnętrzną spójność kosztorysu (logika budowlana, proporcje branż).
 *  - Używa Gemini 2.5 Pro do zaawansowanego wnioskowania inżynierskiego.
 *  - Zwraca listę alertów (CRITICAL / WARNING / INFO) i ogólny score jakości kosztorysu.
 */

import { GoogleGenAI } from "@google/genai";
import { NextRequest, NextResponse } from "next/server";
import { EstimateSection } from "../_shared/types";

export const dynamic = "force-dynamic";

const MODEL_PRO = "gemini-2.5-pro";

// ── Typy ─────────────────────────────────────────────────────────────────────

type AlertSeverity = "CRITICAL" | "WARNING" | "INFO";

interface AuditAlert {
    severity: AlertSeverity;
    category: "QUANTITY_MISMATCH" | "PRICE_ANOMALY" | "MISSING_POSITION" | "RATIO_VIOLATION" | "UNIT_ERROR" | "COMPLETENESS";
    position?: string;
    message: string;
    expectedValue?: string;
    actualValue?: string;
    suggestedAction?: string;
}

interface RevidentResponse {
    passed: boolean;
    score: number; // 0-100
    totalValuePln: number;
    alerts: AuditAlert[];
    branchRatios: {
        earthworks: number;
        construction: number;
        finishing: number;
        installations: number;
        other: number;
    };
    executiveSummary: string;
}

// ── Polskie Normy i Standardy Kosztorysowe (2025/2026) ───────────────────────

const BRANCH_NORMS = {
    earthworks: { min: 2, max: 12 },      // Roboty ziemne: 2-12% wartości kosztorysu
    construction: { min: 30, max: 55 },   // Stan surowy: 30-55%
    finishing: { min: 15, max: 35 },      // Wykończeniówka: 15-35%
    installations: { min: 15, max: 35 },  // Instalacje: 15-35%
};

const PRICE_NORMS: Record<string, { min: number; max: number; unit: string }> = {
    "r-g": { min: 35, max: 65, unit: "r-g" },
    "m3_beton_c2530": { min: 350, max: 480, unit: "m³" },
    "m3_wykop": { min: 18, max: 55, unit: "m³" },
    "m2_tynk": { min: 25, max: 80, unit: "m²" },
    "kg_stal": { min: 3.5, max: 6.5, unit: "kg" },
};

// ── Pomocnik: Klasyfikacja sekcji do odpowiedniej branży ─────────────────────

function classifySection(sectionName: string): keyof typeof BRANCH_NORMS | "other" {
    const name = sectionName.toLowerCase();
    if (name.includes("ziem") || name.includes("wykop") || name.includes("niwelac")) return "earthworks";
    if (name.includes("beton") || name.includes("mur") || name.includes("konstruk") ||
        name.includes("żelbeton") || name.includes("fundament") || name.includes("strop")) return "construction";
    if (name.includes("tynk") || name.includes("wykończ") || name.includes("podłog") ||
        name.includes("płytk") || name.includes("malars") || name.includes("stolark")) return "finishing";
    if (name.includes("install") || name.includes("elektr") || name.includes("sanitar") ||
        name.includes("wod-kan") || name.includes("c.o.") || name.includes("wentyl")) return "installations";
    return "other";
}

// ── ETAP 1: Lokalny pre-audit (deterministyczny, bez AI) ────────────────────

function runLocalAudit(sections: EstimateSection[]): {
    alerts: AuditAlert[];
    totalValue: number;
    branchValues: Record<string, number>;
} {
    const alerts: AuditAlert[] = [];
    let totalValue = 0;
    const branchValues: Record<string, number> = {
        earthworks: 0, construction: 0, finishing: 0, installations: 0, other: 0,
    };

    for (const section of sections) {
        const branch = classifySection(section.name);

        for (const item of section.items) {
            // Cena rynkowa to unitPrice (od brokera) lub basePrice
            const price = item.unitPrice || item.basePrice;
            const lineValue = item.quantity * price;
            totalValue += lineValue;
            branchValues[branch] += lineValue;

            // 1. Sprawdzenie stawek r-g (robocizna)
            if (item.unit === "r-g" && price > 0) {
                const norm = PRICE_NORMS["r-g"];
                if (price < norm.min || price > norm.max) {
                    alerts.push({
                        severity: price < 20 || price > 100 ? "CRITICAL" : "WARNING",
                        category: "PRICE_ANOMALY",
                        position: item.name,
                        message: `Stawka robocizny (r-g) budowlanej poza normą krajową (2025/2026).`,
                        expectedValue: `${norm.min}–${norm.max} PLN/r-g`,
                        actualValue: `${price} PLN/r-g`,
                        suggestedAction: "Zweryfikuj stawkę roboczogodziny dla wybranego regionu Polski.",
                    });
                }
            }

            // 2. Wykrywanie brakujących wycen (Cena = 0)
            if (price === 0) {
                alerts.push({
                    severity: "CRITICAL",
                    category: "PRICE_ANOMALY",
                    position: item.name,
                    message: `Pozycja kosztorysowa nie została wyceniona (cena wynosi 0 PLN).`,
                    suggestedAction: "Uzupełnij wycenę rynkową lub bazową dla tej pozycji.",
                });
            }

            // 3. Wykrywanie pustych przedmiarów (Ilość = 0)
            if (item.quantity === 0) {
                alerts.push({
                    severity: "WARNING",
                    category: "QUANTITY_MISMATCH",
                    position: item.name,
                    message: `Pozycja ma zerowy przedmiar (ilość = 0).`,
                    suggestedAction: "Upewnij się, czy ten zakres robót nie powinien zostać usunięty lub uzupełniony.",
                });
            }
        }
    }

    return { alerts, totalValue, branchValues };
}

// ── Główny Handler ────────────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
    console.log("==================================================");
    console.log("[Rewident] === ROZPOCZĘTO AUDYT KOSZTORYSU ===");
    console.log("==================================================");

    try {
        const ai = new GoogleGenAI({
            vertexai: true,
            project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
            location: "global",
        });

        const body = await req.json();
        const {
            sections,
            buildingType = "Budynek kubaturowy",
            buildingAreaM2 = 2000,
            kp = 65,
            zysk = 12,
        } = body;

        if (!sections?.length) {
            console.error("[Rewident] Błąd: Brak sekcji kosztorysu.");
            return NextResponse.json({ error: "Brak sekcji kosztorysu w żądaniu." }, { status: 400 });
        }

        // ════════════════════════════════════════════════════════════════════════
        // ETAP 1: PRE-AUDIT DETERMINISTYCZNY
        // ════════════════════════════════════════════════════════════════════════
        console.log("[Rewident] Etap 1: Uruchamiam lokalny pre-audit matematyczny...");
        const { alerts: localAlerts, totalValue, branchValues } = runLocalAudit(sections);

        const branchRatios = {
            earthworks: totalValue > 0 ? Math.round(branchValues.earthworks / totalValue * 100) : 0,
            construction: totalValue > 0 ? Math.round(branchValues.construction / totalValue * 100) : 0,
            finishing: totalValue > 0 ? Math.round(branchValues.finishing / totalValue * 100) : 0,
            installations: totalValue > 0 ? Math.round(branchValues.installations / totalValue * 100) : 0,
            other: totalValue > 0 ? Math.round(branchValues.other / totalValue * 100) : 0,
        };

        // Sprawdzanie wskaźników branżowych
        for (const [branch, norm] of Object.entries(BRANCH_NORMS)) {
            const ratio = branchRatios[branch as keyof typeof branchRatios];
            if (ratio > 0 && (ratio < norm.min || ratio > norm.max)) {
                localAlerts.push({
                    severity: "WARNING",
                    category: "RATIO_VIOLATION",
                    message: `Udział procentowy branży [${branch}] wynosi ${ratio}% i wykracza poza standard (${norm.min}% - ${norm.max}%).`,
                    expectedValue: `${norm.min}%–${norm.max}%`,
                    actualValue: `${ratio}%`,
                    suggestedAction: "Sprawdź, czy nie pominięto kluczowych działów lub czy wycena jednej z branż nie jest zawyżona.",
                });
            }
        }

        // Sprawdzenie wskaźnika PLN/m²
        if (buildingAreaM2 > 0) {
            const costPerM2 = totalValue / buildingAreaM2;
            console.log(`[Rewident] Wycena jednostkowa obiektu: ${Math.round(costPerM2)} PLN/m²`);

            if (costPerM2 < 2500) {
                localAlerts.push({
                    severity: "CRITICAL",
                    category: "RATIO_VIOLATION",
                    message: `Koszt budowy wynoszący ${Math.round(costPerM2)} PLN/m² jest skrajnie za niski. Kosztorys jest najprawdopodobniej niekompletny.`,
                    expectedValue: "3 500 - 8 000 PLN/m²",
                    actualValue: `${Math.round(costPerM2)} PLN/m²`,
                    suggestedAction: "Zweryfikuj czy uwzględniono wszystkie instalacje wewnętrzne oraz roboty wykończeniowe.",
                });
            }
        }

        // ════════════════════════════════════════════════════════════════════════
        // ETAP 2: AUDYT LOGICZNY AI (Gemini Pro)
        // ════════════════════════════════════════════════════════════════════════
        console.log("[Rewident] Etap 2: Wysyłam kosztorys do zaawansowanego audytu inżynieryjnego AI...");

        // Tworzymy lekki skrót kosztorysu dla AI, żeby nie przepełnić kontekstu (poprawione typowanie)
        const kosztorysSummary = (sections as EstimateSection[]).map((sec: EstimateSection) => ({
            section: sec.name,
            totalValue: (sec.items || []).reduce((sum: number, item: any) => sum + (item.quantity * (item.unitPrice || item.basePrice)), 0).toFixed(0),
            items: (sec.items || []).map((i: any) => ({ name: i.name, qty: i.quantity, unit: i.unit, price: i.unitPrice || i.basePrice }))
        }));

        const aiPrompt = `
Jesteś Głównym Rewidentem Kosztorysowym w Polsce.
Przeanalizuj poniższy kosztorys i znajdź błędy logiczne, niespójności technologiczne lub braki.

TYP INWESTYCJI: ${buildingType}
POWIERZCHNIA OBIEKTU: ${buildingAreaM2} m²
KOSZT BAZOWY NETTO: ${totalValue.toFixed(2)} PLN

SKRÓCONY KOSZTORYS PRZEDMIAROWY:
${JSON.stringify(kosztorysSummary, null, 2)}

PROPORCJE BRANŻOWE:
- Ziemne: ${branchRatios.earthworks}% | Konstrukcja: ${branchRatios.construction}% | Wykończenie: ${branchRatios.finishing}% | Instalacje: ${branchRatios.installations}%

WYMAGANE KONTROLE INŻYNIERSKIE:
1. Stosunek stali do betonu: Na 1 m³ betonu konstrukcyjnego (fundamenty, strop, słupy) powinno przypadać 80-130 kg stali. Sprawdź czy to się zgadza.
2. Powierzchnia tynków: Powierzchnia tynków ściennych wewnętrznych powinna być co najmniej 1.8-2.5 razy większa niż powierzchnia rzutu budynku.
3. Czy dla inwestycji "${buildingType}" nie zapomniano o kluczowych elementach (np. instalacji odgromowej, izolacji pionowej fundamentów, wentylacji)?

Zwróć odpowiedź WYŁĄCZNIE jako czysty JSON (bez markdown, bez cudzysłowów wewnątrz pól tekstowych):
{
  "aiAlerts": [
    {
      "severity": "CRITICAL" | "WARNING" | "INFO",
      "category": "QUANTITY_MISMATCH" | "PRICE_ANOMALY" | "MISSING_POSITION" | "RATIO_VIOLATION",
      "message": "Opis problemu po polsku (np. za mało stali zbrojeniowej w stosunku do objętości betonu)",
      "expectedValue": "np. 80-130 kg/m³",
      "actualValue": "np. 35 kg/m³",
      "suggestedAction": "Co kosztorysanc powinien poprawić"
    }
  ],
  "completenessScore": 85,
  "executiveSummary": "Trzy zdania inżynierskiego podsumowania kosztorysu."
}
        `.trim();

        const response = await ai.models.generateContent({
            model: MODEL_PRO,
            contents: [{ role: "user", parts: [{ text: aiPrompt }] }],
            config: {
                temperature: 0.1,
                maxOutputTokens: 4096,
                responseMimeType: "application/json",
            },
        });

        let aiAlerts: AuditAlert[] = [];
        let completenessScore = 80;
        let executiveSummary = "Audyt kosztorysu zakończony pomyślnie.";

        try {
            const parsed = JSON.parse(response.text ?? "{}");
            aiAlerts = parsed.aiAlerts ?? [];
            completenessScore = parsed.completenessScore ?? 80;
            executiveSummary = parsed.executiveSummary ?? executiveSummary;
            console.log(`[Rewident] AI wykryło ${aiAlerts.length} potencjalnych problemów.`);
        } catch (e) {
            console.warn("[Rewident] Nie udało się sparsować audytu z Gemini Pro. Używam tylko lokalnego pre-auditu.");
        }

        // Łączenie alertów deterministycznych i AI
        const allAlerts = [...localAlerts, ...aiAlerts];

        const criticalCount = allAlerts.filter(a => a.severity === "CRITICAL").length;
        const warningCount = allAlerts.filter(a => a.severity === "WARNING").length;

        // Finalny score obniżany za każdy błąd krytyczny i ostrzeżenie
        const finalScore = Math.max(0, completenessScore - (criticalCount * 15) - (warningCount * 5));
        const passed = criticalCount === 0;

        console.log(`[Rewident] Zakończono. Wynik: ${finalScore}/100. Status: ${passed ? "PASSED" : "FAILED"}`);
        console.log("==================================================");

        const finalResponse: RevidentResponse = {
            passed,
            score: finalScore,
            totalValuePln: totalValue,
            alerts: allAlerts,
            branchRatios,
            executiveSummary,
        };

        return NextResponse.json(finalResponse);

    } catch (error: any) {
        console.error("[Rewident] Krytyczny błąd audytora:", error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}