/**
 * PESAM – Agent Vision: Konstruktor (Analiza Rysunków Technicznych)
 *
 * Ścieżka: src/app/api/kosztorysant/agent-vision-konstruktor/route.ts
 *
 * Odpowiedzialność:
 *  - Przyjmuje wycięte strony PDF z rysunkami konstrukcyjnymi (via URL ze Storage)
 *  - Używa gemini-3-pro-image do odczytu wymiarów z rzutów, przekrojów, detali
 *  - Wykrywa skalę rysunku automatycznie
 *  - Zwraca zmierzone ilości oraz SYGNAŁY ZŁOŻONOŚCI (dla Brokera Cenowego)
 */

import { GoogleGenAI } from "@google/genai";
import { NextRequest, NextResponse } from "next/server";
import { PDFDocument } from "pdf-lib";

export const dynamic = "force-dynamic";

// Używamy modelu wskazanego przez Ciebie do analizy wizyjnej
const MODEL_VISION = "gemini-3-pro-image";

// ── Typy ─────────────────────────────────────────────────────────────────────

interface MeasuredElement {
    name: string;
    elementType: "FOUNDATION" | "WALL_STRUCTURAL" | "WALL_PARTITION" | "SLAB" | "COLUMN" | "BEAM" | "ROOF" | "STAIRS" | "OTHER";
    quantity: number;
    unit: "m3" | "m2" | "mb" | "szt" | "kg" | "t";
    dimensions: { length_m?: number; width_m?: number; height_m?: number; thickness_m?: number; diameter_mm?: number; };
    material?: string;
    confidence: "HIGH" | "MEDIUM" | "LOW";
    note?: string;
}

interface ComplexitySignal {
    category: string;
    level: "SIMPLE" | "MEDIUM" | "COMPLEX" | "VERY_COMPLEX";
    evidence: string[];
    affectedItems: string[];
}

interface VisionKonstruktorResponse {
    detectedScale: string;
    drawingType: string;
    elements: MeasuredElement[];
    steelEstimate?: { totalKg: number; barsDetected: string[]; };
    complexitySignals: {
        overall: "SIMPLE" | "MEDIUM" | "COMPLEX" | "VERY_COMPLEX";
        score: number;
        signals: ComplexitySignal[];
    };
    warnings: string[];
    narrativeHints: string;
}

// ── Prompt systemowy ──────────────────────────────────────────────────────────

const SYSTEM_INSTRUCTION = `
Jesteś Agentem Vision systemu PESAM – doświadczonym Inżynierem Konstruktorem.
Specjalizujesz się w odczycie polskich rysunków budowlanych i konstrukcyjnych.

KROK 1 – WYKRYJ SKALĘ I TYP RYSUNKU:
Szukaj ramki rysunku lub legendy (np. "Skala 1:50", "Rzut fundamentów").

KROK 2 – ZMIERZ ELEMENTY:
Odczytaj wymiary z opisów na rysunku, oblicz objętość/powierzchnię/długość.
Zidentyfikuj materiał (np. beton C25/30, stal B500SP).

KROK 3 – OCEŃ ZŁOŻONOŚĆ TECHNICZNĄ (DLA BROKERA CENOWEGO):
Na podstawie TEGO CO WIDZISZ na rysunku – oceń złożoność dla każdej kategorii robót.
- ZBROJENIE: Proste (pręty równoległe), Złożone (haki, strzemiona zamknięte, gęsto), Bardzo złożone (skosy, 3 kierunki).
- MURY: Proste (długie ściany), Złożone (dużo otworów, skosy), Bardzo złożone (łuki).
- BETON: Prosty (prostokąty), Złożony (zmienne przekroje), Bardzo złożony (krzywoliniowe).

FORMAT ODPOWIEDZI – WYŁĄCZNIE czysty JSON (bez markdown):
{
  "detectedScale": "1:100",
  "drawingType": "Rzut fundamentów",
  "elements": [
    {
      "name": "Ława fundamentowa L1",
      "elementType": "FOUNDATION",
      "quantity": 28.5,
      "unit": "m3",
      "dimensions": { "length_m": 47.5, "width_m": 0.8, "height_m": 0.6 },
      "material": "Beton C25/30",
      "confidence": "HIGH"
    }
  ],
  "steelEstimate": {
    "totalKg": 3420,
    "barsDetected": ["φ16 co 15cm", "φ8 strzemiona co 25cm"]
  },
  "complexitySignals": {
    "overall": "COMPLEX",
    "score": 75,
    "signals": [
      {
        "category": "STEEL_REINFORCEMENT",
        "level": "VERY_COMPLEX",
        "evidence": ["zbrojenie φ16 co 8cm – gęste", "widoczne strzemiona zamknięte"],
        "affectedItems": ["Ława fundamentowa L1"]
      }
    ]
  },
  "warnings": ["Brak wymiaru przekroju słupa S2"],
  "narrativeHints": "Ławy fundamentowe o jednorodnym przekroju..."
}
`.trim();

// ── Pomocnik: Wyciąganie pojedynczej strony jako PDF ──────────────────────────

async function extractSinglePagePdfBase64(pdfBuffer: Buffer, pageIndex: number): Promise<string> {
    const srcDoc = await PDFDocument.load(pdfBuffer);
    const singleDoc = await PDFDocument.create();
    const [page] = await singleDoc.copyPages(srcDoc, [pageIndex]);
    singleDoc.addPage(page);
    const singlePdfBytes = await singleDoc.save();
    return Buffer.from(singlePdfBytes).toString("base64");
}

// ── Główny Handler ────────────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
    console.log("==================================================");
    console.log("[Vision Konstruktor] === ROZPOCZĘTO ANALIZĘ RYSUNKU ===");
    console.log("==================================================");

    try {
        const ai = new GoogleGenAI({
            vertexai: true,
            project: process.env.GCP_PROJECT_ID || "pesam-system-81165",
            location: "global",
        });

        const body = await req.json();
        const { fileUrl, pageNumbers = [], drawingHints = "" } = body;

        if (!fileUrl) {
            console.error("[Vision Konstruktor] Błąd: Brak fileUrl.");
            return NextResponse.json({ error: "Brak parametru fileUrl." }, { status: 400 });
        }

        console.log(`[Vision Konstruktor] Pobieram rysunek ze Storage: ${fileUrl}`);
        const fileRes = await fetch(fileUrl);
        if (!fileRes.ok) throw new Error(`HTTP ${fileRes.status} przy pobieraniu pliku`);

        const arrayBuffer = await fileRes.arrayBuffer();
        const pdfBuffer = Buffer.from(arrayBuffer);

        const srcDoc = await PDFDocument.load(pdfBuffer);
        const totalPages = srcDoc.getPageCount();
        console.log(`[Vision Konstruktor] Plik PDF pobrany. Liczba stron: ${totalPages}`);

        // Analizujemy wskazane strony lub maksymalnie pierwsze 4 (dla wydajności)
        const pagesToAnalyze: number[] = pageNumbers.length > 0
            ? pageNumbers.map((p: number) => p - 1).filter((i: number) => i >= 0 && i < totalPages)
            : Array.from({ length: Math.min(totalPages, 4) }, (_, i) => i);

        console.log(`[Vision Konstruktor] Strony do analizy wizyjnej (0-based): ${pagesToAnalyze.join(", ")}`);

        const allElements: MeasuredElement[] = [];
        const allWarnings: string[] = [];
        const allSignals: ComplexitySignal[] = [];
        let finalScale = "nieznana";
        let finalDrawingType = "Rysunek techniczny";
        let finalSteel: VisionKonstruktorResponse["steelEstimate"] = undefined;
        const narratives: string[] = [];

        for (const pageIndex of pagesToAnalyze) {
            console.log(`[Vision Konstruktor] Analizuję stronę ${pageIndex + 1}/${totalPages} modelem ${MODEL_VISION}...`);

            const base64Data = await extractSinglePagePdfBase64(pdfBuffer, pageIndex);

            const userPrompt = `
Przeanalizuj rysunek techniczny (strona ${pageIndex + 1} z ${totalPages}).
${drawingHints ? `Kontekst projektu: ${drawingHints}` : ""}
Zmierz wszystkie widoczne elementy konstrukcyjne i oceń złożoność. Zwróć dane w formacie JSON.
            `.trim();

            const response = await ai.models.generateContent({
                model: MODEL_VISION,
                contents: [{
                    role: "user",
                    parts: [
                        { inlineData: { data: base64Data, mimeType: "application/pdf" } },
                        { text: userPrompt },
                    ],
                }],
                config: {
                    systemInstruction: SYSTEM_INSTRUCTION,
                    temperature: 0.1,
                    maxOutputTokens: 8192,
                    responseMimeType: "application/json",
                },
            });

            const rawText = response.text ?? "";
            console.log(`[Vision Konstruktor] Odebrano odpowiedź dla strony ${pageIndex + 1} (${rawText.length} znaków).`);

            try {
                const parsed: VisionKonstruktorResponse = JSON.parse(rawText);

                allElements.push(...(parsed.elements ?? []));
                allWarnings.push(...(parsed.warnings ?? []));
                if (parsed.complexitySignals?.signals) {
                    allSignals.push(...parsed.complexitySignals.signals);
                }

                if (parsed.detectedScale && finalScale === "nieznana") finalScale = parsed.detectedScale;
                if (parsed.drawingType && finalDrawingType === "Rysunek techniczny") finalDrawingType = parsed.drawingType;

                if (parsed.steelEstimate) {
                    if (!finalSteel) finalSteel = { totalKg: 0, barsDetected: [] };
                    finalSteel.totalKg += parsed.steelEstimate.totalKg;
                    finalSteel.barsDetected.push(...parsed.steelEstimate.barsDetected);
                }

                if (parsed.narrativeHints) narratives.push(`Str.${pageIndex + 1}: ${parsed.narrativeHints}`);

            } catch (parseErr) {
                console.warn(`[Vision Konstruktor] Błąd parsowania JSON dla strony ${pageIndex + 1}.`);
            }
        }

        // Deduplikacja elementów o tej samej nazwie
        const dedupedElements = new Map<string, MeasuredElement>();
        for (const el of allElements) {
            const key = `${el.elementType}__${el.name}__${el.unit}`;
            if (dedupedElements.has(key)) {
                dedupedElements.get(key)!.quantity += el.quantity;
            } else {
                dedupedElements.set(key, { ...el });
            }
        }

        const finalResponse: VisionKonstruktorResponse = {
            detectedScale: finalScale,
            drawingType: finalDrawingType,
            elements: Array.from(dedupedElements.values()),
            steelEstimate: finalSteel,
            complexitySignals: {
                overall: allSignals.some(s => s.level === "VERY_COMPLEX") ? "VERY_COMPLEX" :
                    allSignals.some(s => s.level === "COMPLEX") ? "COMPLEX" : "MEDIUM",
                score: 70, // Uproszczony score
                signals: allSignals
            },
            warnings: allWarnings,
            narrativeHints: narratives.join(" | ") || "Analiza rysunku zakończona.",
        };

        console.log(`[Vision Konstruktor] Zakończono. Wykryto ${finalResponse.elements.length} elementów oraz ${allSignals.length} sygnałów złożoności.`);
        console.log("==================================================");

        return NextResponse.json(finalResponse);

    } catch (error: any) {
        console.error("[Vision Konstruktor] Krytyczny błąd:", error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}