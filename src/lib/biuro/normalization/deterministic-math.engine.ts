// src/lib/biuro/normalization/deterministic-math.engine.ts
//
// Agent Matematyk (Deterministyczny Kalkulator TS)
// Żelazna Reguła: Modelowi AI NIE WOLNO wykonać ani jednego działania arytmetycznego!
// Wszystkie sumy, zaokrąglenia groszowe i przeliczniki są liczone tutaj.
// Zgodny ze specyfikacją biuro-ai.md §Część 1/3

export class DeterministicMathEngine {
  /**
   * Bezpieczne zaokrąglenie walutowe do 2 miejsc po przecinku (do grosza).
   */
  static roundCurrency(amount: number): number {
    return Math.round((amount + Number.EPSILON) * 100) / 100;
  }

  /**
   * Zaokrąglenie jednostkowe/metryczne do 4 miejsc po przecinku.
   */
  static roundUnits(quantity: number): number {
    return Math.round((quantity + Number.EPSILON) * 10000) / 10000;
  }

  /**
   * Zaokrąglenie wskaźników procentowych do 2 miejsc po przecinku.
   */
  static roundPct(pct: number): number {
    return Math.round((pct + Number.EPSILON) * 100) / 100;
  }

  /**
   * Przeliczenie ilości i ceny jednostkowej przy danym mnożniku:
   * raw_quantity * multiplier = normalized_quantity
   * total_net pozostaje nienaruszone (identyczne do grosza).
   * normalized_unit_price = total_net / normalized_quantity
   */
  static convertDualUnit(params: {
    rawQuantity: number;
    rawUnitPriceNet: number;
    multiplier: number;
    operation?: 'MULTIPLY' | 'DIVIDE' | 'STATIC';
  }): {
    rawTotalNet: number;
    normalizedQuantity: number;
    normalizedUnitPriceNet: number;
    normalizedTotalNet: number;
  } {
    const { rawQuantity, rawUnitPriceNet, multiplier, operation = 'MULTIPLY' } = params;

    const rawTotalNet = this.roundCurrency(rawQuantity * rawUnitPriceNet);

    let normalizedQuantity = rawQuantity;
    if (operation === 'MULTIPLY') {
      normalizedQuantity = this.roundUnits(rawQuantity * multiplier);
    } else if (operation === 'DIVIDE' && multiplier > 0) {
      normalizedQuantity = this.roundUnits(rawQuantity / multiplier);
    }

    // Aby zachować dokładność finansową, kwota łączna pozycji jest twardo równa rawTotalNet
    const normalizedTotalNet = rawTotalNet;
    const normalizedUnitPriceNet = normalizedQuantity > 0
      ? this.roundCurrency(normalizedTotalNet / normalizedQuantity)
      : 0;

    return {
      rawTotalNet,
      normalizedQuantity,
      normalizedUnitPriceNet,
      normalizedTotalNet,
    };
  }

  /**
   * Obliczenie odchyłki ceny (Variance) w ujęciu procentowym i kwotowym:
   * Variance % = ((Cena_KSeF - Cena_WZ) / Cena_WZ) * 100
   */
  static calculatePriceVariance(params: {
    priceWz: number;
    priceKsef: number;
  }): {
    variancePct: number;
    varianceAmount: number;
    isPriceIncrease: boolean;
    isPriceDecrease: boolean;
    isIdentical: boolean;
  } {
    const { priceWz, priceKsef } = params;
    const varianceAmount = this.roundCurrency(priceKsef - priceWz);

    if (priceWz <= 0) {
      return {
        variancePct: 0,
        varianceAmount,
        isPriceIncrease: varianceAmount > 0,
        isPriceDecrease: varianceAmount < 0,
        isIdentical: varianceAmount === 0,
      };
    }

    const variancePct = this.roundPct(((priceKsef - priceWz) / priceWz) * 100);

    return {
      variancePct,
      varianceAmount,
      isPriceIncrease: variancePct > 0.05,
      isPriceDecrease: variancePct < -0.05,
      isIdentical: Math.abs(variancePct) <= 0.05,
    };
  }

  /**
   * Weryfikacja sumy kontrolnej wierszy (Checksum)
   */
  static verifyRowChecksum(declaredCount: number, actualCount: number): {
    matches: boolean;
    difference: number;
    summary: string;
  } {
    const matches = declaredCount === actualCount;
    const difference = actualCount - declaredCount;

    return {
      matches,
      difference,
      summary: matches
        ? `Suma kontrolna wierszy poprawna (${declaredCount} == ${actualCount}).`
        : `Rozbieżność sumy kontrolnej: deklarowano ${declaredCount}, na dokumencie jest ${actualCount} wierszy (różnica: ${difference}).`,
    };
  }

  /**
   * Weryfikacja tolerancji ilościowej (np. ±2% lub ±1 sztuka przy małych liczbach)
   */
  static verifyQuantityMatch(declaredQty: number, actualQty: number, tolerancePct: number = 2.0): boolean {
    if (declaredQty === actualQty) return true;
    if (declaredQty <= 0) return false;

    const diff = Math.abs(declaredQty - actualQty);
    const diffPct = (diff / declaredQty) * 100;
    return diffPct <= tolerancePct;
  }

  /**
   * Obliczenie sum dokumentu z zaokrągleniem bankowym.
   */
  static calculateTotals(items: Array<{ total_net: number; vat_rate?: number }>): {
    totalNet: number;
    totalVat: number;
    totalGross: number;
  } {
    let totalNet = 0;
    let totalVat = 0;

    for (const item of items) {
      const net = this.roundCurrency(item.total_net || 0);
      const vatRate = item.vat_rate !== undefined ? item.vat_rate : 23;
      const vat = this.roundCurrency((net * vatRate) / 100);

      totalNet = this.roundCurrency(totalNet + net);
      totalVat = this.roundCurrency(totalVat + vat);
    }

    const totalGross = this.roundCurrency(totalNet + totalVat);

    return { totalNet, totalVat, totalGross };
  }
}
