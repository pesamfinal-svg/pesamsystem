// src/lib/biuro/normalization/voice-anchor.matcher.ts
//
// Podagent Weryfikacji Kotwicy (Checksum & Anchor Matcher)
// Implementuje 4-sekundową procedurę meldunku SOP:
// [Dostawca] -> [Budowa] -> [Liczba pozycji z kwitu] -> [Jeden główny towar + ilość]
// Zgodny ze specyfikacją biuro-ai.md §Część 3/3

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
      // Słownie
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

    // 2. Wykrycie towaru kotwiczącego: np. "w tym 6 płyt OSB", "6 płyt osb", "w tym 27 profili", "w tym 6 sztuk płyt"
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
   * Główna procedura weryfikacji sumy kontrolnej i kotwicy
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

    // ── KROK 1: Suma Kontrolna Wierszy (Checksum Test) ──
    const lineCountMatched = declaredLineCount !== undefined ? declaredLineCount === actualLineCount : true;
    if (policy.voice_rules.require_checksum_match && declaredLineCount !== undefined && !lineCountMatched) {
      return {
        verification_method: 'CHECKSUM_AND_ANCHOR',
        is_physically_confirmed: false,
        declared_line_count: declaredLineCount,
        actual_line_count: actualLineCount,
        line_count_matched: false,
        driver_audio_ref: driverAudioRef,
        driver_audio_text: driverText,
        verdict_reason: `⚠️ ALERT HITL: Błąd Sumy Kontrolnej. Kierowca zadeklarował ${declaredLineCount} pozycji, a na dokumencie WZ jest ${actualLineCount} wierszy!`,
        driver_name: driverName,
      };
    }

    // ── KROK 2: Test Towaru Kotwiczącego (Anchor Item Test) ──
    let anchorMatched = false;
    let anchorItemFoundName: string | undefined;

    if (parsed.anchorItemName && parsed.anchorItemQuantity !== undefined) {
      const declaredAnchorUpper = parsed.anchorItemName.toUpperCase();
      const anchorTokens = declaredAnchorUpper.split(/\s+/).filter(t => t.length > 2);

      for (const item of wzItems) {
        const itemUpper = item.name.toUpperCase();
        // Sprawdź czy nazwa pozycji na WZ zawiera kluczowe słowa z kotwicy (np. "OSB", "PROFIL")
        const isNameMatch = anchorTokens.some(token => itemUpper.includes(token));

        if (isNameMatch) {
          anchorItemFoundName = item.name;
          // Sprawdź ilość z dopuszczalną tolerancją (np. 6 == 6)
          const isQtyMatch = DeterministicMathEngine.verifyQuantityMatch(parsed.anchorItemQuantity, item.quantity);
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
          verdict_reason: `⚠️ ALERT HITL: Rozbieżność Towaru Kotwiczącego. Kierowca podał: "${parsed.anchorItemQuantity}x ${parsed.anchorItemName}", na kwicie WZ brak zgodnej ilości dla tej pozycji!`,
          driver_name: driverName,
        };
      }
    } else {
      // Jeśli kierowca nie podał kotwicy, ale liczba wierszy się zgadza
      anchorMatched = true;
    }

    // ── KROK 3: Sukces - Przyjęcie Potwierdzone (AUTO_VERIFIED) ──
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
      verdict_reason: `✅ AUTO_VERIFIED: Przyjęcie towaru potwierdzone głosem kierowcy (Suma wierszy: ${actualLineCount}, Kotwica: ${parsed.anchorItemQuantity || ''} ${parsed.anchorItemName || ''} zgodna).`,
      driver_name: driverName,
    };
  }
}
