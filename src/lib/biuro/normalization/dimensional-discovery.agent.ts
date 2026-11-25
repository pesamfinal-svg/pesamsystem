// src/lib/biuro/normalization/dimensional-discovery.agent.ts
//
// Podagent Odkrywania Geometrii (Dimensional Discovery Agent)
// Analizuje ciąg tekstowy pod kątem wymiarów geometrycznych (np. 1250/2500 -> 3.125 m2, 3 MB -> 3 mb, OPAK.50SZT -> 50 szt)
// Wnioskuje regułę przeliczeniową i dopasowuje do Kanonu PESAM.
// Zgodny ze specyfikacją biuro-ai.md §Część 2/3

import { GoogleGenAI, Type } from '@google/genai';
import { PesamAccountingUnit, VendorCatalogItem } from '@/types/biuro/vendorCatalog.types';
import { DeterministicMathEngine } from './deterministic-math.engine';

const ai = new GoogleGenAI({
  vertexai: true,
  project: process.env.GCP_PROJECT_ID || 'pesam-system-81165',
  location: 'global'
});

export interface DiscoveredGeometryResult {
  vendor_nip: string;
  vendor_raw_name: string;
  vendor_invoiced_unit: string;
  canonical_product_id: string;
  canonical_name: string;
  pesam_accounting_unit: PesamAccountingUnit;
  conversion_rule: {
    multiplier: number;
    formula: string;
    operation: 'MULTIPLY' | 'DIVIDE' | 'STATIC';
  };
  confidence_score: number;
  is_high_confidence: boolean; // >= 0.95 -> auto-learn
  hitl_reason?: string;
  source: 'REGEX_DETERMINISTIC' | 'LLM_SEMANTIC_DISCOVERY';
}

export class DimensionalDiscoveryAgent {
  /**
   * Główna metoda odkrywania geometrii i reguły przeliczeniowej.
   */
  static async discover(params: {
    rawName: string;
    rawUnit: string;
    vendorNip: string;
  }): Promise<DiscoveredGeometryResult> {
    const { rawName, rawUnit, vendorNip } = params;

    // KROK 1: Szybka i deterministyczna analiza wzorców geometrycznych (0 ms, 0 zł)
    const regexResult = this.discoverFromRegex(rawName, rawUnit, vendorNip);
    if (regexResult && regexResult.confidence_score >= 0.95) {
      return regexResult;
    }

    // KROK 2: Analiza semantyczna z modelem Gemini Flash dla nietypowych nazw (z limitem czasu 6s)
    try {
      const llmPromise = this.discoverFromLlm(rawName, rawUnit, vendorNip);
      const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), 6000));
      const llmResult = await Promise.race([llmPromise, timeoutPromise]);
      if (llmResult) {
        return llmResult;
      }
    } catch (err) {
      console.warn('[DimensionalDiscoveryAgent] LLM discovery error, falling back to regex or 1:1 default:', err);
    }

    // Fallback: jeśli regex dał jakikolwiek wynik (nawet z niższą pewnością) lub 1:1
    if (regexResult) {
      return regexResult;
    }

    // Ostateczny bezpieczny domyślny przelicznik 1:1 (wymagający weryfikacji HITL)
    return {
      vendor_nip: vendorNip,
      vendor_raw_name: rawName,
      vendor_invoiced_unit: rawUnit || 'szt',
      canonical_product_id: 'MAT-GENERIC-ITEM',
      canonical_name: rawName,
      pesam_accounting_unit: (rawUnit === 'm2' || rawUnit === 'mb' || rawUnit === 'kg') ? rawUnit : 'szt',
      conversion_rule: {
        multiplier: 1.0,
        formula: '1:1 (Brak wykrytych wymiarów geometrycznych)',
        operation: 'STATIC',
      },
      confidence_score: 0.60,
      is_high_confidence: false,
      hitl_reason: 'Nie wykryto jednoznacznych wymiarów geometrycznych w nazwie produktu. Wymagana akceptacja przelicznika.',
      source: 'REGEX_DETERMINISTIC',
    };
  }

  /**
   * Deterministyczna analiza regex dla standardowych formatów budowlanych w Polsce
   */
  private static discoverFromRegex(
    rawName: string,
    rawUnit: string,
    vendorNip: string
  ): DiscoveredGeometryResult | null {
    const upper = rawName.toUpperCase();

    // ── 1. Płyty (OSB, G-K, MFP, cementowo-wiórowe) -> m² ──
    // Format: 1250/2500, 1250x2500, 1200x2600, 1200/2000 itp.
    const boardDimMatch = upper.match(/(\d{3,4})[\s/xX*]+(\d{3,4})/);
    if (boardDimMatch && (upper.includes('OSB') || upper.includes('PŁYTA') || upper.includes('PLYTA') || upper.includes('G-K') || upper.includes('KNAUF') || upper.includes('RIGIPS') || upper.includes('REGIPS'))) {
      const dimA = parseInt(boardDimMatch[1], 10);
      const dimB = parseInt(boardDimMatch[2], 10);

      // Konwersja z mm na metry
      const lengthM = Math.max(dimA, dimB) / 1000.0;
      const widthM = Math.min(dimA, dimB) / 1000.0;
      const areaM2 = DeterministicMathEngine.roundUnits(lengthM * widthM);

      const isOsb = upper.includes('OSB');
      const thicknessMatch = upper.match(/(?:GR\.?|GRUBOSC|GRUBŚĆ|\b)(\d{1,2}(?:\.\d)?)\s*(?:MM|\b)/);
      const thickness = thicknessMatch ? `${thicknessMatch[1]}mm` : '10mm';

      const canonicalId = isOsb ? `MAT-DREW-OSB-${thickness.replace('.', '_')}` : `MAT-GK-${thickness.replace('.', '_')}`;
      const canonicalName = isOsb ? `Płyta OSB-3 gr. ${thickness}` : `Płyta gipsowo-kartonowa gr. ${thickness}`;

      return {
        vendor_nip: vendorNip,
        vendor_raw_name: rawName,
        vendor_invoiced_unit: rawUnit || 'szt',
        canonical_product_id: canonicalId,
        canonical_name: canonicalName,
        pesam_accounting_unit: 'm2',
        conversion_rule: {
          multiplier: areaM2,
          formula: `${widthM}m * ${lengthM}m = ${areaM2} m2/szt`,
          operation: 'MULTIPLY',
        },
        confidence_score: 0.98,
        is_high_confidence: true,
        source: 'REGEX_DETERMINISTIC',
      };
    }

    // ── 2. Profile stalowe (C-50, U-50, CD-60, UD-27, CW, UW) -> mb ──
    // Format: 3 MB, 3MB, 3.0M, 4 MB, 2.6M itp.
    const profileMatch = upper.match(/PROFIL\s+([A-Z0-9-]+).*?(\d+(?:\.\d+)?)\s*(?:MB|MFO|M\b)/i)
      || upper.match(/PROFIL.*?(?:C|U|CD|UD|CW|UW)[- ]?(\d{2,3})[^\d]*(\d+(?:\.\d+)?)\s*(?:MB|M\b)/i);

    if (profileMatch || upper.includes('PROFIL')) {
      const lengthMatch = upper.match(/(\d+(?:\.\d+)?)\s*(?:MB|MFO|M\b)/i);
      const meters = lengthMatch ? parseFloat(lengthMatch[1]) : 3.0;

      const profileTypeMatch = upper.match(/(?:PROFIL\s+)?([CUW][D]?[ -]?\d{2,3})/i);
      const typeCode = profileTypeMatch ? profileTypeMatch[1].replace(/\s+/g, '-').toUpperCase() : 'C-50';

      return {
        vendor_nip: vendorNip,
        vendor_raw_name: rawName,
        vendor_invoiced_unit: rawUnit || 'szt',
        canonical_product_id: `MAT-STAL-${typeCode.replace(/[^A-Z0-9-]/g, '')}`,
        canonical_name: `Profil stalowy ścienny/obwodowy ${typeCode}`,
        pesam_accounting_unit: 'mb',
        conversion_rule: {
          multiplier: meters,
          formula: `1 szt = ${meters} mb`,
          operation: 'MULTIPLY',
        },
        confidence_score: 0.96,
        is_high_confidence: true,
        source: 'REGEX_DETERMINISTIC',
      };
    }

    // ── 3. Wkręty, kołki, łączniki (Paczki i opakowania) -> szt ──
    const packMatch = upper.match(/(?:OPAK\.?|OP\.?|PACZKA|PACK|TYP\s+[A-Z]+\s+A?)\s*(\d{2,4})\s*(?:SZT|\b)/i)
      || upper.match(/(\d{2,4})\s*SZT/i);

    if (packMatch && (upper.includes('WKRĘT') || upper.includes('WKRET') || upper.includes('KOŁK') || upper.includes('KOLK') || upper.includes('KLIMAS') || upper.includes('TEX'))) {
      const count = parseInt(packMatch[1], 10);
      const isTex = upper.includes('TEX') || upper.includes('WKRĘT') || upper.includes('WKRET');
      const canonicalId = isTex ? 'MAT-WKRET-TEX' : 'MAT-KOLKI-SM';
      const canonicalName = isTex ? 'Wkręty samowiercące / montażowe' : 'Kołki szybkiego montażu';

      return {
        vendor_nip: vendorNip,
        vendor_raw_name: rawName,
        vendor_invoiced_unit: rawUnit || 'opak',
        canonical_product_id: canonicalId,
        canonical_name: canonicalName,
        pesam_accounting_unit: 'szt',
        conversion_rule: {
          multiplier: count,
          formula: `1 opak = ${count} szt`,
          operation: 'MULTIPLY',
        },
        confidence_score: 0.95,
        is_high_confidence: true,
        source: 'REGEX_DETERMINISTIC',
      };
    }

    // ── 4. Chemia budowlana, kleje, gipsy (Worki, wiadra) -> kg / l ──
    const weightMatch = upper.match(/(\d+(?:\.\d+)?)\s*(?:KG|LITR|L\b)/i);
    if (weightMatch && (upper.includes('KLEJ') || upper.includes('GIPS') || upper.includes('TYNK') || upper.includes('GRUNT') || upper.includes('FARBA'))) {
      const weight = parseFloat(weightMatch[1]);
      const isLiquid = upper.includes('GRUNT') || upper.includes('FARBA') || upper.match(/\bL\b/i);
      const unit: PesamAccountingUnit = isLiquid ? 'l' : 'kg';

      return {
        vendor_nip: vendorNip,
        vendor_raw_name: rawName,
        vendor_invoiced_unit: rawUnit || 'szt',
        canonical_product_id: `MAT-CHEM-${isLiquid ? 'LIQUID' : 'DRY'}-${weight}`,
        canonical_name: rawName,
        pesam_accounting_unit: unit,
        conversion_rule: {
          multiplier: weight,
          formula: `1 opak = ${weight} ${unit}`,
          operation: 'MULTIPLY',
        },
        confidence_score: 0.95,
        is_high_confidence: true,
        source: 'REGEX_DETERMINISTIC',
      };
    }

    // ── 5. Narzędzia, taśmy, wiertła, piany, silikony (1 szt = 1 szt) -> szt ──
    if (
      upper.includes('TAŚMA') || upper.includes('TASMA') ||
      upper.includes('WIERTŁO') || upper.includes('WIERTLO') ||
      upper.includes('PIANA') || upper.includes('SILIKON') ||
      upper.includes('AKRYL') || upper.includes('NÓŻ') || upper.includes('NOZ') ||
      upper.includes('TUSZ') || upper.includes('FOLIA') || upper.includes('RĘKAWIC')
    ) {
      return {
        vendor_nip: vendorNip,
        vendor_raw_name: rawName,
        vendor_invoiced_unit: rawUnit || 'szt',
        canonical_product_id: `MAT-SZT-${rawName.replace(/[^A-Z0-9]/gi, '').slice(0, 12).toUpperCase()}`,
        canonical_name: rawName,
        pesam_accounting_unit: 'szt',
        conversion_rule: {
          multiplier: 1.0,
          formula: `1 ${rawUnit || 'szt'} = 1 szt`,
          operation: 'STATIC',
        },
        confidence_score: 0.96,
        is_high_confidence: true,
        source: 'REGEX_DETERMINISTIC',
      };
    }

    return null;
  }

  /**
   * Wnioskowanie semantyczne za pomocą modelu Gemini dla złożonych opisów
   */
  private static async discoverFromLlm(
    rawName: string,
    rawUnit: string,
    vendorNip: string
  ): Promise<DiscoveredGeometryResult | null> {
    const prompt = `Jesteś inżynierem kosztorysantem i architektem danych w firmie budowlanej PESAM.
Przeanalizuj pozycję materiałową z hurtowni i wydobądź regułę przeliczenia na jednostki kosztorysowe (m2, mb, szt, kg, l):
Nazwa surowa: "${rawName}"
Jednostka z faktury/WZ: "${rawUnit}"
NIP Dostawcy: "${vendorNip}"

Zadanie:
1. Odczytaj wymiary geometryczne (np. grubość, długość, szerokość, objętość, sztuki w paczce).
2. Wyznacz jednostkę docelową PESAM ('m2' | 'mb' | 'szt' | 'kg' | 'l').
3. Podaj mnożnik (multiplier) dla 1 jednostki surowej. Pamiętaj: NIE licz kwot, podaj tylko fizyczny mnożnik.
4. Określ poziom pewności (confidence 0.0 - 1.0).`;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        temperature: 0.1,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            canonical_product_id: { type: Type.STRING },
            canonical_name: { type: Type.STRING },
            pesam_accounting_unit: { type: Type.STRING, enum: ['m2', 'mb', 'szt', 'kg', 'l', 'kpl'] },
            multiplier: { type: Type.NUMBER },
            formula: { type: Type.STRING },
            confidence_score: { type: Type.NUMBER },
            reasoning: { type: Type.STRING }
          },
          required: ['canonical_product_id', 'canonical_name', 'pesam_accounting_unit', 'multiplier', 'formula', 'confidence_score']
        }
      }
    });

    const parsed = JSON.parse(response.text || '{}');
    if (!parsed.multiplier || parsed.multiplier <= 0) return null;

    const confidence = parsed.confidence_score || 0.85;

    return {
      vendor_nip: vendorNip,
      vendor_raw_name: rawName,
      vendor_invoiced_unit: rawUnit || 'szt',
      canonical_product_id: parsed.canonical_product_id || 'MAT-AUTO-DISCOVERED',
      canonical_name: parsed.canonical_name || rawName,
      pesam_accounting_unit: parsed.pesam_accounting_unit as PesamAccountingUnit,
      conversion_rule: {
        multiplier: parsed.multiplier,
        formula: parsed.formula || `1 ${rawUnit} = ${parsed.multiplier} ${parsed.pesam_accounting_unit}`,
        operation: 'MULTIPLY',
      },
      confidence_score: confidence,
      is_high_confidence: confidence >= 0.95,
      hitl_reason: confidence < 0.95 ? `Wymaga potwierdzenia człowieka (Pewność: ${Math.round(confidence * 100)}%): ${parsed.reasoning}` : undefined,
      source: 'LLM_SEMANTIC_DISCOVERY',
    };
  }
}
