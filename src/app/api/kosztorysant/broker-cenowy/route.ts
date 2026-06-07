/**
 * PESAM – Agent Broker Cenowy (Wycena Rynkowa z Kontekstem Technicznym)
 *
 * Ścieżka: src/app/api/kosztorysant/agent-broker-cenowy/route.ts
 *
 * Odpowiedzialność:
 *  - Przyjmuje pozycje kosztorysowe z KNR Lookup.
 *  - Przyjmuje sygnały złożoności (complexitySignals) z Vision Konstruktora.
 *  - Używa Gemini Pro do ustalenia przedziału cenowego na bazie złożoności.
 *  - Używa Gemini Flash + Google Search do weryfikacji cen rynkowych.
 *  - Zwraca wycenę z uzasadnieniem i rekomendowaną ceną ofertową.
 */

import { GoogleGenAI } from "@google/genai";
import { NextRequest, NextResponse } from "next/server";
import { EstimateSection } from "../_shared/types";

export const dynamic = "force-dynamic";

const MODEL_PRO = "gemini-2.5-pro";
const MODEL_FLASH = "gemini-3.5-flash"; // Najlepszy i najszybszy do Google Search

// ── Typy ─────────────────────────────────────────────────────────────────────

type ComplexityLevel = "SIMPLE" | "MEDIUM" | "COMPLEX" | "VERY_COMPLEX";
type PriceConfidence = "MARKET_VERIFIED" | "ESTIMATED" | "FALLBACK";

interface TechnicalComplexity {
  level: ComplexityLevel;
  factors: string[];
  multiplier: number;
}

interface PriceRange {
  min: number;
  optimal: number;
  max: number;
  unit: string;
}

interface BrokerPricedItem {
  itemId: string;
  itemName: string;
  complexity: TechnicalComplexity;
  priceRange: PriceRange;
  recommendedPrice: number;
  marketSource?: string;
  marketDate?: string;
  confidence: PriceConfidence;
  pricingNotes: string;
}

interface BrokerResponse {
  region: string;
  pricedItems: BrokerPricedItem[];
  marketSummary: string;
  regionalTrend: string;
  warnings: string[];
}

// ── Pomocnik: Budowanie kontekstu złożoności z danych Vision ─────────────────

function buildComplexityContext(visionSignals: any, projectContext: string): string {
  if (!visionSignals || !visionSignals.signals || visionSignals.signals.length === 0) {
    return `Brak danych z analizy rysunków (Vision). Użyj kontekstu projektu: "${projectContext}". Zakładaj domyślnie złożoność MEDIUM, chyba że nazwa pozycji sugeruje inaczej.`;
  }

  const signalDescriptions = visionSignals.signals.map((s: any) =>
    `- Kategoria [${s.category}]: Poziom ${s.level}. Dowody z rysunku: ${s.evidence.join("; ")}. Dotyczy elementów: ${s.affectedItems.join(", ")}`
  ).join("\n");

  return `
DANE Z ANALIZY RYSUNKÓW TECHNICZNYCH (Od Agenta Vision):
Ogólna ocena złożoności projektu: ${visionSignals.overall}

Szczegółowe sygnały z rysunków:
${signalDescriptions}

Kontekst projektu: "${projectContext}"
    `.trim();
}

// ── Pomocnik: Budowanie zapytania do Google Search ───────────────────────────

function buildSearchQuery(itemName: string, region: string, unit: string): string {
  const name = itemName.toLowerCase();
  const year = new Date().getFullYear();

  if (name.includes("stal") || name.includes("zbrojenie") || name.includes("b500sp")) return `cena stali zbrojeniowej B500SP kg tona ${region} ${year}`;
  if (name.includes("beton c30") || name.includes("c30/37")) return `cena betonu towarowego C30/37 m3 ${region} ${year}`;
  if (name.includes("beton c25") || name.includes("c25/30")) return `cena betonu C25/30 m3 ${region} ${year}`;
  if (name.includes("ytong") || name.includes("gazobeton")) return `cena bloczków Ytong gazobeton 24cm szt ${region} ${year}`;
  if (name.includes("silikat")) return `cena bloczków silikatowych 18cm murowych ${region} ${year}`;
  if (name.includes("dachówk")) return `cena dachówki ceramicznej m2 ${region} ${year}`;
  if (name.includes("membran") || name.includes("epdm")) return `cena membrany EPDM dachowej m2 ${year}`;
  if (name.includes("papa")) return `cena papy termozgrzewalnej m2 wierzchniego krycia ${year}`;
  if (name.includes("tynk maszynow")) return `cena tynku maszynowego m2 robocizna ${region} ${year}`;
  if (name.includes("robocizn") || name.includes("r-g")) return `stawka robocizny budowlanej r-g netto ${region} ${year}`;
  if (name.includes("wykop") || name.includes("kopark")) return `cena wykopu mechanicznego koparka m3 ${region} ${year}`;

  const shortName = itemName.split(" ").slice(0, 4).join(" ");
  return `cena ${shortName} budowlana netto ${region} ${year}`;
}

// ── Główny Handler ────────────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  console.log("==================================================");
  console.log("[Broker Cenowy] === ROZPOCZĘTO WYCENĘ RYNKOWĄ ===");
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
      region = "Polska",
      projectContext = "",
      visionSignals = null,
      forceMarketSearch = true,
    } = body;

    if (!sections || sections.length === 0) {
      console.warn("[Broker Cenowy] Ostrzeżenie: Brak sekcji kosztorysu. Przerywam pracę i zwracam pusty raport.");
      return NextResponse.json({
        region,
        pricedItems: [],
        marketSummary: "Kosztorys był pusty na etapie wyceny rynkowej.",
        regionalTrend: `Brak danych do wyceny w regionie ${region}.`,
        warnings: ["Brak pozycji do wyceny. Upewnij się, że Ilościowiec i Gap Filler zakończyli pracę prawidłowo."]
      }, { status: 200 });
    }

    const allItems = (sections as EstimateSection[]).flatMap((sec: EstimateSection) =>
      (sec.items || []).map((item: any) => ({ ...item, sectionName: sec.name }))
    );

    console.log(`[Broker Cenowy] Przetwarzam ${allItems.length} pozycji dla regionu: ${region}`);

    // ════════════════════════════════════════════════════════════════════════
    // ETAP 1: OCENA ZŁOŻONOŚCI I BAZOWE WIDEŁKI (Gemini Pro)
    // ════════════════════════════════════════════════════════════════════════
    console.log("[Broker Cenowy] Etap 1: Analiza złożoności technicznej na bazie danych z Vision...");

    const complexityContext = buildComplexityContext(visionSignals, projectContext);

    const complexityPrompt = `
Jesteś ekspertem od wyceny robót budowlanych w Polsce.
Analizujesz kosztorys dla regionu: ${region}.

${complexityContext}

TWOJE ZADANIE:
Dla każdej pozycji kosztorysowej poniżej ustal przedział cenowy [min, optimal, max].
Opieraj się NA DANYCH Z RYSUNKÓW (Vision) powyżej. 
Jeśli Vision wykrył VERY_COMPLEX dla zbrojenia – użyj górnych widełek cenowych.
Jeśli Vision wykrył SIMPLE dla murów – użyj dolnych widełek.

WIDEŁKI CENOWE BAZOWE (dostosuj wg złożoności):
- Zbrojenie: SIMPLE=4.20-4.80 | MEDIUM=4.80-5.80 | COMPLEX=5.80-7.00 | VERY_COMPLEX=7.00-9.50 PLN/kg
- Murowanie: SIMPLE=35-50 | MEDIUM=50-70 | COMPLEX=70-100 | VERY_COMPLEX=100-160 PLN/m²
- Beton: SIMPLE=380-440 | MEDIUM=440-580 | COMPLEX=580-750 | VERY_COMPLEX=750-1400 PLN/m³
- Robocizna: zależna od regionu (${region}): podkarpacie/lubelskie=38-52, reszta=45-65 PLN/r-g

POZYCJE DO WYCENY:
${JSON.stringify(allItems.map(item => ({ id: item.id, name: item.name, quantity: item.quantity, unit: item.unit, currentBasePrice: item.basePrice })), null, 2)}

Zwróć TYLKO czysty JSON (bez markdown, bez cudzysłowów wewnątrz tekstów):
{
  "complexityAssessments": [
    {
      "itemId": "item-1-1",
      "complexity": { "level": "MEDIUM", "factors": ["proste geometrie"], "multiplier": 1.15 },
      "priceRange": { "min": 380, "optimal": 420, "max": 520, "unit": "m³" },
      "pricingNotes": "Beton C25/30 w ławach. Cena dla regionu."
    }
  ],
  "regionalTrend": "Obserwacja rynkowa dla regionu"
}
        `.trim();

    const complexityResponse = await ai.models.generateContent({
      model: MODEL_PRO,
      contents: [{ role: "user", parts: [{ text: complexityPrompt }] }],
      config: { temperature: 0.1, maxOutputTokens: 8192, responseMimeType: "application/json" },
    });

    let complexityAssessments: any[] = [];
    let regionalTrend = `Rynek ${region} – wycena standardowa.`;

    try {
      const parsed = JSON.parse(complexityResponse.text ?? "{}");
      complexityAssessments = parsed.complexityAssessments ?? [];
      regionalTrend = parsed.regionalTrend ?? regionalTrend;
      console.log(`[Broker Cenowy] Oceniono złożoność dla ${complexityAssessments.length} pozycji.`);
    } catch (e) {
      console.warn("[Broker Cenowy] Błąd parsowania oceny złożoności z Gemini Pro.");
    }

    // ════════════════════════════════════════════════════════════════════════
    // ETAP 2: GOOGLE SEARCH - WERYFIKACJA RYNKOWA (Gemini Flash)
    // ════════════════════════════════════════════════════════════════════════
    const marketPrices: Map<string, { price: number; source: string; date: string }> = new Map();

    if (forceMarketSearch) {
      console.log("[Broker Cenowy] Etap 2: Google Search – weryfikacja najdroższych pozycji...");

      // Wybierz TOP 5 najdroższych pozycji do weryfikacji w Google
      const topItems = [...allItems]
        .sort((a, b) => (b.quantity * b.basePrice) - (a.quantity * a.basePrice))
        .slice(0, 5);

      for (const item of topItems) {
        const searchQuery = buildSearchQuery(item.name, region, item.unit);
        console.log(`[Broker Cenowy] Szukam w Google: "${searchQuery}"`);

        try {
          const searchResponse = await ai.models.generateContent({
            model: MODEL_FLASH,
            contents: [{
              role: "user",
              parts: [{ text: `${searchQuery}\n\nZwróć TYLKO JSON: {"priceMin": 0, "priceMax": 0, "unit": "", "source": "nazwa portalu/sklepu", "date": "YYYY-MM-DD"}. Podaj ceny netto PLN z aktualnych ofert.` }]
            }],
            config: {
              temperature: 0.0,
              maxOutputTokens: 256,
              responseMimeType: "application/json",
              tools: [{ googleSearch: {} } as any], // Włączenie Google Search Grounding
            },
          });

          const parsed = JSON.parse(searchResponse.text ?? "{}");
          if (parsed.priceMin > 0 && parsed.priceMax > 0) {
            const avgPrice = (parsed.priceMin + parsed.priceMax) / 2;
            marketPrices.set(item.id, {
              price: avgPrice,
              source: parsed.source || "Google Search",
              date: parsed.date || new Date().toISOString().split("T")[0],
            });
            console.log(`[Broker Cenowy] Znaleziono cenę rynkową dla "${item.name}": ~${avgPrice.toFixed(2)} PLN/${parsed.unit} (Źródło: ${parsed.source})`);
          }
        } catch (searchErr) {
          console.warn(`[Broker Cenowy] Błąd wyszukiwania Google dla "${item.name}". Pomijam.`);
        }
      }
    }

    // ════════════════════════════════════════════════════════════════════════
    // ETAP 3: SYNTEZA I EFEKT SKALI
    // ════════════════════════════════════════════════════════════════════════
    console.log("[Broker Cenowy] Etap 3: Synteza cen, aplikacja efektu skali...");

    const pricedItems: BrokerPricedItem[] = allItems.map(item => {
      const assessment = complexityAssessments.find(a => a.itemId === item.id);

      let priceRange: PriceRange = assessment?.priceRange ?? {
        min: item.basePrice * 0.85,
        optimal: item.basePrice,
        max: item.basePrice * 1.30,
        unit: item.unit,
      };

      const marketData = marketPrices.get(item.id);
      let confidence: PriceConfidence = assessment ? "ESTIMATED" : "FALLBACK";
      let marketSource: string | undefined;
      let marketDate: string | undefined;

      // Jeśli mamy cenę z Google, uśredniamy ją z oceną AI (60% Google / 40% AI)
      if (marketData) {
        const marketWeight = 0.60;
        const aiWeight = 0.40;

        priceRange = {
          min: Math.round(priceRange.min * aiWeight + marketData.price * 0.85 * marketWeight),
          optimal: Math.round(priceRange.optimal * aiWeight + marketData.price * marketWeight),
          max: Math.round(priceRange.max * aiWeight + marketData.price * 1.20 * marketWeight),
          unit: priceRange.unit,
        };

        confidence = "MARKET_VERIFIED";
        marketSource = marketData.source;
        marketDate = marketData.date;
      }

      let recommendedPrice = priceRange.optimal;

      // Efekt skali – duże ilości obniżają cenę w kierunku minimum
      if (item.unit === "m3" && item.quantity > 200) recommendedPrice = Math.round(priceRange.min * 1.05);
      if (item.unit === "m2" && item.quantity > 1000) recommendedPrice = Math.round(priceRange.min * 1.08);
      if (item.unit === "kg" && item.quantity > 10000) recommendedPrice = Math.round(priceRange.min * 1.05);
      if (item.unit === "t" && item.quantity > 20) recommendedPrice = Math.round(priceRange.min * 1.05);

      return {
        itemId: item.id,
        itemName: item.name,
        complexity: assessment?.complexity ?? { level: "MEDIUM", factors: ["brak szczegółowej analizy"], multiplier: 1.0 },
        priceRange,
        recommendedPrice,
        marketSource,
        marketDate,
        confidence,
        pricingNotes: assessment?.pricingNotes ?? `Cena bazowa z katalogu KNR, region: ${region}.`,
      };
    });

    // ── Ostrzeżenia ──
    const warnings: string[] = [];
    const veryComplexItems = pricedItems.filter(i => i.complexity.level === "VERY_COMPLEX");
    if (veryComplexItems.length > 0) {
      warnings.push(`⚠️ Wykryto ${veryComplexItems.length} pozycje o złożoności VERY_COMPLEX – rozważ podzlecenie specjalistom.`);
    }

    const marketSummary = `Zweryfikowano rynkowo (Google Search) ${marketPrices.size} z ${allItems.length} pozycji. Przedziały cenowe uwzględniają złożoność techniczną z rysunków i efekty skali dla regionu ${region}.`;

    console.log(`[Broker Cenowy] Zakończono sukcesem. Wyceniono ${pricedItems.length} pozycji.`);
    console.log("==================================================");

    return NextResponse.json({
      region,
      pricedItems,
      marketSummary,
      regionalTrend,
      warnings,
    });

  } catch (error: any) {
    console.error("[Broker Cenowy] Krytyczny błąd:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}