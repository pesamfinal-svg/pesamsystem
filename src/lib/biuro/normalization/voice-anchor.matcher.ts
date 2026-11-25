// src/lib/biuro/normalization/voice-anchor.matcher.ts
//
// Podagent Weryfikacji Kotwicy (Checksum & Anchor Matcher)
// Implementuje procedurę meldunku SOP z pełną konfigurowalnością tolerancji:
// - Tolerancja różnicy liczby wierszy (np. +/- 0, 1, 2, 3 pozycje)
// - Obsługa braku deklaracji liczby pozycji
// - Tolerancja ilościowa towaru kotwiczącego (+/- X%)
// - Próg drobnicy montażowej

import { DriverAuditInfo } from '@/types/biuro/reconciledDelivery.types';
import { BiuroMatchingPolicy, DEFAULT_BIURO_MATCHING_POLICY } from '@/types/biuro/matchingPolicy.types';
import { DeterministicMathEngine } from './deterministic-math.engine';

export interface VoiceAnchorInput {
  driverText: string;
  driverAudioRef?: string;
  driverName?: string;
  wzItems: Array<{
    lp: number;
    name: string;
    quantity: number;
    unit?: string;
    total_net?: number | null;
  }>;
  wzVendorName?: string;
  wzVendorNip?: string;
  wzTargetSite?: string;
  policy?: BiuroMatchingPolicy;
}

export interface VoiceParsedDeclaration {
  vendorHint?: string;
  siteHint?: string;
  declaredLineCount?: number;
  anchorItemName?: string;
  anchorItemQuantity?: number;
  anchorItemUnit?: string;
}

export class VoiceAnchorMatcher {
  /**
   * Parsowanie tekstu meldunku kierowcy na ustrukturyzowane pola
   */
  static parseDeclaration(text: string): VoiceParsedDeclaration {
    const raw = text.trim();
    const result: VoiceParsedDeclaration = {};

    // 1. Wykrycie liczby pozycji: np. "7 pozycji", "siedem pozycji", "7 wierszy", "7 pozycji na kwicie"
    const lineCountMatch = raw.match(/(\d+)\s*(?:pozycji|pozycje|pozycja|wierszy|wiersze|wiersz|sztuk pozycji)/i);
    if (lineCountMatch) {
      result.declaredLineCount = parseInt(lineCountMatch[1], 10);
    } else {
      const wordMap: Record<string, number> = {
        'jedna': 1, 'jeden': 1, 'dwa': 2, 'dwie': 2, 'trzy': 3, 'cztery': 4,
        'pięć': 5, 'piec': 5, 'sześć': 6, 'szesc': 6, 'siedem': 7, 'osiem': 8,
        'dziewięć': 9, 'dziewiec': 9, 'dziesięć': 10, 'dziesiec': 10
      };
      for (const [word, val] of Object.entries(wordMap)) {
        if (new RegExp(`\\b${word}\\s+pozycji`, 'i').test(raw)) {
          result.declaredLineCount = val;
          break;
        }
      }
    }

    // 2. Wykrycie towaru kotwiczącego: np. "w tym 6 płyt OSB", "6 płyt osb", "w tym 27 profili"
    const anchorMatch = raw.match(/(?:w tym|w tym jest|oraz|głównie|glownie)?\s*(\d+(?:[.,]\d+)?)\s*(?:szt\.?|sztuk|płyt|plyt|opakowań|opak|paczek|metrów|mb|rolek)?\s+([A-Za-z0-9ąćęłńóśźżĄĆĘŁŃÓŚŹŻ -]{3,35})/i)
      || raw.match(/(\d+(?:[.,]\d+)?)\s+([A-Za-z0-9ąćęłńóśźżĄĆĘŁŃÓŚŹŻ -]{3,35})/i);

    if (anchorMatch) {
      const qtyStr = anchorMatch[1].replace(',', '.');
      result.anchorItemQuantity = parseFloat(qtyStr);
      result.anchorItemName = anchorMatch[2].trim().replace(/\s+(na|dla|budowa|kielce|debica).*$/i, '');
    }

    // 3. Wykrycie budowy: np. "na Kielce", "dla Kielce Przychodnia"
    const siteMatch = raw.match(/(?:na|do|budowa|plac)\s+([A-Za-z0-9ąćęłńóśźżĄĆĘŁŃÓŚŹŻ ]+?)(?:,|\.|\b\d|\bw tym|$)/i);
    if (siteMatch) {
      result.siteHint = siteMatch[1].trim();
    }

    // 4. Wykrycie dostawcy: np. "CMB", "SIG", "Castorama"
    const vendorMatch = raw.match(/\b(CMB|SIG|Castorama|Leroy|Bricoman|MFO|Dębica)\b/i);
    if (vendorMatch) {
      result.vendorHint = vendorMatch[1].trim();
    }

    return result;
  }

  /**
   * Główna procedura weryfikacji sumy kontrolnej i kotwicy z uwzględnieniem konfigurowalnych tolerancji
   */
  static verify(input: VoiceAnchorInput): DriverAuditInfo {
    const { driverText, driverAudioRef, driverName, wzItems, wzVendorName, wzTargetSite, policy = DEFAULT_BIURO_MATCHING_POLICY } = input;

    if (!driverText || driverText.trim().length === 0) {
      return {
        verification_method: 'NONE',
        is_physically_confirmed: false,
        verdict_reason: 'Brak meldunku głosowego kierowcy w systemie.',
        driver_name: driverName,
      };
    }

    const parsed = this.parseDeclaration(driverText);
    const actualLineCount = wzItems.length;
    const declaredLineCount = parsed.declaredLineCount;

    // ── KROK 0: Zgodność Kontekstu (Dostawca / Budowa) ──
    let contextMatched = true;
    let contextMismatchReason = '';

    if (parsed.vendorHint && wzVendorName) {
      const vendorHintUpper = parsed.vendorHint.toUpperCase();
      const wzVendorUpper = wzVendorName.toUpperCase();
      if (!wzVendorUpper.includes(vendorHintUpper)) {
        contextMatched = false;
        contextMismatchReason += `Niezgodność dostawcy: meldunek "${parsed.vendorHint}" vs WZ "${wzVendorName}". `;
      }
    }

    if (parsed.siteHint && wzTargetSite) {
      const siteHintUpper = parsed.siteHint.toUpperCase();
      const wzSiteUpper = wzTargetSite.toUpperCase();
      if (!wzSiteUpper.includes(siteHintUpper) && !siteHintUpper.includes(wzSiteUpper)) {
        contextMatched = false;
        contextMismatchReason += `Niezgodność budowy: meldunek "${parsed.siteHint}" vs WZ "${wzTargetSite}". `;
      }
    }

    if (!contextMatched) {
      return {
        verification_method: 'CHECKSUM_AND_ANCHOR',
        is_physically_confirmed: false,
        declared_line_count: declaredLineCount,
        actual_line_count: actualLineCount,
        line_count_matched: false,
        driver_audio_ref: driverAudioRef,
        driver_audio_text: driverText,
        verdict_reason: `❌ Odrzucono powiązanie: ${contextMismatchReason}`,
        driver_name: driverName,
      };
    }

    // ── KROK 1: Suma Kontrolna Wierszy z Konfigurowalną Tolerancją ──
    const maxDiscrepancy = policy.voice_rules.max_row_count_discrepancy ?? 1;
    const allowMissingCount = policy.voice_rules.allow_missing_row_count_declaration ?? true;

    let lineCountMatched = true;
    let lineCountDifference = 0;

    if (declaredLineCount !== undefined) {
      lineCountDifference = Math.abs(actualLineCount - declaredLineCount);
      lineCountMatched = lineCountDifference <= maxDiscrepancy;
    } else {
      // Kierowca nie podał liczby wierszy
      lineCountMatched = allowMissingCount;
    }

    if (policy.voice_rules.require_checksum_match && declaredLineCount !== undefined && !lineCountMatched) {
      return {
        verification_method: 'CHECKSUM_AND_ANCHOR',
        is_physically_confirmed: false,
        declared_line_count: declaredLineCount,
        actual_line_count: actualLineCount,
        line_count_matched: false,
        driver_audio_ref: driverAudioRef,
        driver_audio_text: driverText,
        verdict_reason: `⚠️ ALERT HITL: Przekroczono dopuszczalną tolerancję wierszy. Kierowca podał ${declaredLineCount} pozycji, na WZ jest ${actualLineCount} (różnica: ${lineCountDifference} wierszy, dozwolone maks: ${maxDiscrepancy}).`,
        driver_name: driverName,
      };
    }

    // ── KROK 2: Test Towaru Kotwiczącego z Tolerancją Ilościową ──
    const anchorTolerancePct = policy.voice_rules.anchor_quantity_tolerance_pct ?? 5.0;
    let anchorMatched = false;
    let anchorItemFoundName: string | undefined;

    if (parsed.anchorItemName && parsed.anchorItemQuantity !== undefined) {
      const declaredAnchorUpper = parsed.anchorItemName.toUpperCase();
      const anchorTokens = declaredAnchorUpper.split(/\s+/).filter(t => t.length > 2);

      for (const item of wzItems) {
        const itemUpper = item.name.toUpperCase();
        const isNameMatch = anchorTokens.some(token => itemUpper.includes(token));

        if (isNameMatch) {
          anchorItemFoundName = item.name;
          const isQtyMatch = DeterministicMathEngine.verifyQuantityMatch(
            parsed.anchorItemQuantity,
            item.quantity,
            anchorTolerancePct
          );
          if (isQtyMatch) {
            anchorMatched = true;
            break;
          }
        }
      }

      if (policy.voice_rules.require_anchor_match && !anchorMatched) {
        return {
          verification_method: 'CHECKSUM_AND_ANCHOR',
          is_physically_confirmed: false,
          declared_line_count: declaredLineCount,
          actual_line_count: actualLineCount,
          line_count_matched: lineCountMatched,
          anchor_item: parsed.anchorItemName,
          anchor_quantity_matched: false,
          driver_audio_ref: driverAudioRef,
          driver_audio_text: driverText,
          verdict_reason: `⚠️ ALERT HITL: Rozbieżność Towaru Kotwiczącego. Kierowca zgłosił: "${parsed.anchorItemQuantity}x ${parsed.anchorItemName}", na kwicie WZ brak zgodnej pozycji w tolerancji ${anchorTolerancePct}%.`,
          driver_name: driverName,
        };
      }
    } else {
      anchorMatched = true;
    }

    // ── KROK 3: Sukces z Raportem Zastosowanych Reguł Tolerancji ──
    const summaryNotes: string[] = [];
    if (declaredLineCount !== undefined) {
      if (declaredLineCount === actualLineCount) {
        summaryNotes.push(`Suma wierszy zgodna co do sztuki (${actualLineCount})`);
      } else {
        summaryNotes.push(`Różnica ${lineCountDifference} wierszy mieści się w tolerancji ±${maxDiscrepancy}`);
      }
    } else if (allowMissingCount) {
      summaryNotes.push('Pominięto brak liczby wierszy (zgodnie z polityką)');
    }

    if (parsed.anchorItemName) {
      summaryNotes.push(`Kotwica: ${parsed.anchorItemQuantity || ''} ${parsed.anchorItemName || ''} potwierdzona`);
    }

    return {
      verification_method: 'CHECKSUM_AND_ANCHOR',
      is_physically_confirmed: true,
      declared_line_count: declaredLineCount,
      actual_line_count: actualLineCount,
      line_count_matched: true,
      anchor_item: anchorItemFoundName || parsed.anchorItemName,
      anchor_quantity_matched: true,
      driver_audio_ref: driverAudioRef,
      driver_audio_text: driverText,
      verdict_reason: `✅ AUTO_VERIFIED: Przyjęcie towaru potwierdzone głosem (${summaryNotes.join(', ')}).`,
      driver_name: driverName,
    };
  }
}
