// src/lib/co2/co2-calculator.ts

/**
 * Global CO2 emission and cost parameters for PESAM warehouse management system.
 * Based on 'baza_wskaznikow_co2.md' and official sources (KOBiZE 2026, DEFRA 2025).
 */
export const CO2_GLOBAL_PARAMS = {
  defaultConstructionDistanceKm: 100, // Domyślny promień zwrotu z budowy (km w jedną stronę)
  roundTripMultiplier: 2, // Mnożnik trasy (tam i z powrotem = 2x dystans)
  defaultFleetVehicleFuelConsumptionLPer100km: 11.5, // Iveco do 3.5t diesel (l/100km)
  dieselCo2PerLiterKg: 2.661, // KOBiZE 2026, Tabela 16 (WO=43.0 MJ/kg, WE=74.1 kg CO2/GJ, gęstość=0.835 kg/l)
};

/**
 * Wskaźniki emisyjności zagospodarowania odpadów budowlanych (kg CO2e / tonę).
 * Źródło: UK DEFRA/BEIS 2025 z 'baza_wskaznikow_co2.md'.
 */
export const DISPOSAL_CO2_FACTORS_KG_PER_TONNE: Record<string, { name: string; factor: number; method: string; status: string }> = {
  util_budowlane_zamknieta_petla: {
    name: "Odpady budowlane – recykling (closed-loop)",
    factor: 1.008,
    method: "recykling_closed_loop",
    status: "DEFRA 2025"
  },
  util_budowlane_otwarta_petla: {
    name: "Odpady budowlane – recykling (open-loop)",
    factor: 1.00835,
    method: "recykling_open_loop",
    status: "DEFRA 2025"
  },
  util_beton_otwarta_petla: {
    name: "Odpady betonowe – recykling (open-loop)",
    factor: 1.00835,
    method: "recykling_open_loop",
    status: "DEFRA 2025"
  },
  util_kruszywa_otwarta_petla: {
    name: "Kruszywa – recykling (open-loop)",
    factor: 1.00835,
    method: "recykling_open_loop",
    status: "DEFRA 2025"
  },
  util_kruszywa_skladowisko: {
    name: "Kruszywa – składowisko",
    factor: 1.26338,
    method: "skladowisko",
    status: "DEFRA 2025"
  },
  util_beton_skladowisko: {
    name: "Odpady betonowe – składowisko",
    factor: 1.26338,
    method: "skladowisko",
    status: "DEFRA 2025"
  },
  util_budowlane_spalanie: {
    name: "Odpady budowlane – spalanie z odzyskiem energii",
    factor: 4.68568,
    method: "spalanie_z_odzyskiem",
    status: "DEFRA 2025"
  },
  util_drewno_skladowisko: {
    name: "Odpady drzewne – składowisko",
    factor: 925.34348,
    method: "skladowisko",
    status: "DEFRA 2025"
  },
  reuse_magazyn: {
    name: "Magazyn – ponowne użycie (odpadowość zerowa / cyrkularność)",
    factor: 0,
    method: "reuse_circular",
    status: "PESAM Reuse"
  }
};

/**
 * Szacowana uniknięta emisja przy ponownym wykorzystaniu materiału (kg CO2e / tonę).
 * Odpowiada uniknięciu produkcji surowca pierwotnego cement/gips/profil (A1-A3).
 */
export const REUSE_CO2_SAVINGS_KG_PER_TONNE = 150;

/**
 * Widełki cenowe CO2 w UE (ETS): 55 EUR - 150 EUR za tonę.
 */
export const CO2_COST_PARAMS = {
  defaultMinEurPerTon: 55, // 0.055 EUR / kg CO2
  defaultMaxEurPerTon: 150, // 0.150 EUR / kg CO2
  defaultEurToPlnRate: 4.30,
};

export interface ProtocolItemInput {
  id?: string;
  name: string;
  quantity?: number;
  receivedQty?: number;
  unit?: string;
  notes?: string;
  condition?: string;
  isWaste?: boolean;
  isResidual?: boolean;
  inventoryNumber?: string;
  disposalMethodKey?: string;
}

export interface ProtocolInput {
  id: string;
  documentNumber?: string;
  sourceSiteName?: string;
  sourceId?: string;
  createdAt?: string;
  documentDate?: string;
  items: ProtocolItemInput[];
  constructionDistanceKm?: number;
}

export interface ItemCo2Details {
  itemId: string;
  itemName: string;
  quantity: number;
  unit: string;
  estimatedWeightKg: number;
  disposalMethodKey: string;
  disposalMethodName: string;
  disposalCo2Kg: number;
  isReuse: boolean;
  co2SavedKg: number;
}

export interface Co2CostResult {
  minEur: number;
  maxEur: number;
  avgEur: number;
  minPln: number;
  maxPln: number;
  avgPln: number;
}

export interface ProtocolCo2Summary {
  protocolId: string;
  protocolNumber: string;
  siteName: string;
  date: string;
  distanceKm: number;
  totalEstimatedWeightKg: number;
  transportCo2Kg: number;
  disposalCo2Kg: number;
  totalCo2EmissionKg: number;
  totalCo2SavedKg: number;
  netCo2EmissionKg: number;
  costs: Co2CostResult;
  itemDetails: ItemCo2Details[];
  hasResiduals: boolean;
}

/**
 * Szacuje wagę pozycji zwrotu w kilogramach na podstawie nazwy, jednostki i stanu.
 */
export function estimateItemWeightKg(item: { name: string; quantity?: number; receivedQty?: number; unit?: string; notes?: string; condition?: string }): number {
  let estimatedWeightKg = 0;
  const qty = typeof item.receivedQty === "number" && item.receivedQty > 0
    ? item.receivedQty
    : (typeof item.quantity === "number" && item.quantity > 0 ? item.quantity : 1);

  const nameLower = (item.name || "").toLowerCase();
  const unitLower = (item.unit || "").toLowerCase();
  const notesLower = (item.notes || "").toLowerCase();
  const conditionLower = (item.condition || "").toLowerCase();

  // 1. Sprawdzenie jawnej wagi w nazwie lub jednostce (np. "25kg", "25 kg", "50kg")
  const weightRegex = /(\d+(\.\d+)?)\s*(kg|g|t|tona|tony|ton)/;
  let match = nameLower.match(weightRegex);
  if (!match) {
    match = unitLower.match(weightRegex);
  }

  if (match) {
    const value = parseFloat(match[1]);
    const unit = match[3];
    if (unit === 'kg') {
      estimatedWeightKg = value * qty;
    } else if (unit === 'g') {
      estimatedWeightKg = (value / 1000) * qty;
    } else if (unit.startsWith('t')) {
      estimatedWeightKg = value * 1000 * qty;
    }
  }

  // 2. Jeśli brak jawnej wagi w nazwie, sprawdzamy jednostki potoczne
  if (estimatedWeightKg === 0) {
    if (unitLower === 'kg') {
      estimatedWeightKg = qty;
    } else if (unitLower === 't' || unitLower === 'tona' || unitLower === 'tony') {
      estimatedWeightKg = qty * 1000;
    } else if (nameLower.includes('worek') || nameLower.includes('worki') || unitLower.includes('work')) {
      estimatedWeightKg = 25 * qty; // domyślny worek chemii / kleju / cementu = 25 kg
    } else if (nameLower.includes('wiadro') || nameLower.includes('wiadra') || unitLower.includes('wiad')) {
      estimatedWeightKg = 20 * qty; // wiadro tynku/farby/gruntu = 20 kg
    } else if (nameLower.includes('płyta') || nameLower.includes('plyta') || nameLower.includes('g-k') || nameLower.includes('gk')) {
      estimatedWeightKg = 28 * qty; // płyta GK standard 12.5mm 1200x2600 = ~28 kg
    } else if (nameLower.includes('podstawa betonowa') || nameLower.includes('stopa betonowa')) {
      estimatedWeightKg = 32 * qty; // stopa ogrodzenia betonowa = ok. 32 kg
    } else if (nameLower.includes('paleta')) {
      estimatedWeightKg = 500 * qty;
    } else if (nameLower.includes('gruz') || nameLower.includes('beton')) {
      estimatedWeightKg = 25 * qty;
    } else {
      estimatedWeightKg = 10 * qty; // domyślny fallback
    }
  }

  // 3. Mnożnik stopnia zużycia / resztki (np. "ok. 50%", "połowa", "resztka na dnie")
  let multiplier = 1;
  const percentMatch = (notesLower + " " + conditionLower).match(/(\d+(\.\d+)?)%/);
  if (percentMatch) {
    multiplier = parseFloat(percentMatch[1]) / 100;
  } else if (notesLower.includes('połowa') || conditionLower.includes('połow') || notesLower.includes('50%')) {
    multiplier = 0.5;
  } else if (notesLower.includes('dnie') || conditionLower.includes('resztka')) {
    multiplier = 0.25;
  } else if (notesLower.includes('3/4') || notesLower.includes('trzy czwarte')) {
    multiplier = 0.75;
  }

  return Math.max(0.1, Number((estimatedWeightKg * multiplier).toFixed(2)));
}

/**
 * Wylicza emisję CO2 kursu transportowego (tam i z powrotem)
 */
export function calculateTransportCo2(
  distanceKm: number,
  fuelLPer100km: number = CO2_GLOBAL_PARAMS.defaultFleetVehicleFuelConsumptionLPer100km,
  fuelCo2PerL: number = CO2_GLOBAL_PARAMS.dieselCo2PerLiterKg,
  roundTripMultiplier: number = CO2_GLOBAL_PARAMS.roundTripMultiplier
): number {
  if (distanceKm <= 0 || fuelLPer100km <= 0 || fuelCo2PerL <= 0) return 0;
  const totalDistance = distanceKm * roundTripMultiplier;
  const liters = (totalDistance / 100) * fuelLPer100km;
  return Number((liters * fuelCo2PerL).toFixed(3));
}

/**
 * Wylicza emisję CO2 z utylizacji odpadu
 */
export function calculateDisposalCo2(weightKg: number, disposalKey: string): number {
  if (weightKg <= 0) return 0;
  const factorObj = DISPOSAL_CO2_FACTORS_KG_PER_TONNE[disposalKey];
  const factor = factorObj ? factorObj.factor : 1.00835; // fallback: recykling open-loop
  const tonnes = weightKg / 1000;
  return Number((tonnes * factor).toFixed(4));
}

/**
 * Oblicza koszt emisji CO2 w widełkach zadanych przez użytkownika (55 - 150 EUR/t)
 */
export function calculateCo2Cost(
  co2Kg: number,
  minEurPerTon: number = CO2_COST_PARAMS.defaultMinEurPerTon,
  maxEurPerTon: number = CO2_COST_PARAMS.defaultMaxEurPerTon,
  eurToPln: number = CO2_COST_PARAMS.defaultEurToPlnRate
): Co2CostResult {
  const tonnes = Math.max(0, co2Kg) / 1000;
  const minEur = tonnes * minEurPerTon;
  const maxEur = tonnes * maxEurPerTon;
  const avgEur = (minEur + maxEur) / 2;

  const minPln = minEur * eurToPln;
  const maxPln = maxEur * eurToPln;
  const avgPln = avgEur * eurToPln;

  return {
    minEur: Number(minEur.toFixed(2)),
    maxEur: Number(maxEur.toFixed(2)),
    avgEur: Number(avgEur.toFixed(2)),
    minPln: Number(minPln.toFixed(2)),
    maxPln: Number(maxPln.toFixed(2)),
    avgPln: Number(avgPln.toFixed(2))
  };
}

/**
 * Domyślna detekcja metody utylizacji na podstawie pozycji
 */
export function detectDefaultDisposalMethod(item: ProtocolItemInput): string {
  if (item.disposalMethodKey && DISPOSAL_CO2_FACTORS_KG_PER_TONNE[item.disposalMethodKey]) {
    return item.disposalMethodKey;
  }
  const name = (item.name || "").toLowerCase();
  const isWaste = item.isWaste || item.inventoryNumber === "ODPAD" || (item.condition || "").includes("odpad");

  if (!isWaste) {
    // Sprawne resztki wracające na stan magazynowy
    return "reuse_magazyn";
  }

  if (name.includes("drewn") || name.includes("deski") || name.includes("palet")) {
    return "util_drewno_skladowisko";
  }
  if (name.includes("beton") || name.includes("gruz")) {
    return "util_beton_skladowisko";
  }
  if (name.includes("piasek") || name.includes("kruszyw") || name.includes("kamie")) {
    return "util_kruszywa_skladowisko";
  }
  if (name.includes("styropian") || name.includes("plastik") || name.includes("folia") || name.includes("piana")) {
    return "util_budowlane_spalanie";
  }
  return "util_budowlane_otwarta_petla";
}

/**
 * Podsumowuje protokół pod kątem emisji CO2 i kosztów
 */
export function calculateProtocolCo2Summary(
  protocol: ProtocolInput,
  overrideDistanceKm?: number,
  params?: {
    minEurPerTon?: number;
    maxEurPerTon?: number;
    eurToPln?: number;
    fuelLPer100km?: number;
  }
): ProtocolCo2Summary {
  const minEur = params?.minEurPerTon ?? CO2_COST_PARAMS.defaultMinEurPerTon;
  const maxEur = params?.maxEurPerTon ?? CO2_COST_PARAMS.defaultMaxEurPerTon;
  const eurToPln = params?.eurToPln ?? CO2_COST_PARAMS.defaultEurToPlnRate;
  const fuelLPer100km = params?.fuelLPer100km ?? CO2_GLOBAL_PARAMS.defaultFleetVehicleFuelConsumptionLPer100km;

  const distanceKm = overrideDistanceKm ?? protocol.constructionDistanceKm ?? CO2_GLOBAL_PARAMS.defaultConstructionDistanceKm;

  let totalWeightKg = 0;
  let totalDisposalCo2 = 0;
  let totalCo2Saved = 0;
  const itemDetails: ItemCo2Details[] = [];

  const items = Array.isArray(protocol.items) ? protocol.items : [];
  
  // Czy protokół zawiera resztki lub odpady
  const hasResiduals = items.some(i => 
    i.isResidual || 
    i.isWaste || 
    i.inventoryNumber === "RESZTKI" || 
    i.inventoryNumber === "ODPAD" ||
    (i.name && (i.name.toLowerCase().includes("resztk") || i.name.toLowerCase().includes("odpad")))
  );

  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx];
    const weightKg = estimateItemWeightKg(item);
    totalWeightKg += weightKg;

    const methodKey = detectDefaultDisposalMethod(item);
    const isReuse = methodKey === "reuse_magazyn";

    let disposalCo2 = 0;
    let savedCo2 = 0;

    if (isReuse) {
      disposalCo2 = 0;
      savedCo2 = Number(((weightKg / 1000) * REUSE_CO2_SAVINGS_KG_PER_TONNE).toFixed(3));
    } else {
      disposalCo2 = calculateDisposalCo2(weightKg, methodKey);
    }

    totalDisposalCo2 += disposalCo2;
    totalCo2Saved += savedCo2;

    const methodName = DISPOSAL_CO2_FACTORS_KG_PER_TONNE[methodKey]?.name || methodKey;

    itemDetails.push({
      itemId: item.id || `item-${idx}`,
      itemName: item.name || "Pozycja",
      quantity: typeof item.receivedQty === "number" ? item.receivedQty : (item.quantity || 1),
      unit: item.unit || "szt.",
      estimatedWeightKg: weightKg,
      disposalMethodKey: methodKey,
      disposalMethodName: methodName,
      disposalCo2Kg: disposalCo2,
      isReuse,
      co2SavedKg: savedCo2
    });
  }

  // Emisja transportu
  const transportCo2Kg = calculateTransportCo2(distanceKm, fuelLPer100km);
  const totalCo2EmissionKg = Number((transportCo2Kg + totalDisposalCo2).toFixed(3));
  const netCo2EmissionKg = Number((Math.max(0, totalCo2EmissionKg - totalCo2Saved)).toFixed(3));

  const costs = calculateCo2Cost(totalCo2EmissionKg, minEur, maxEur, eurToPln);

  return {
    protocolId: protocol.id,
    protocolNumber: protocol.documentNumber || protocol.id,
    siteName: protocol.sourceSiteName || "Magazyn / Budowa",
    date: protocol.documentDate || (protocol.createdAt ? protocol.createdAt.split("T")[0] : ""),
    distanceKm,
    totalEstimatedWeightKg: Number(totalWeightKg.toFixed(2)),
    transportCo2Kg,
    disposalCo2Kg: Number(totalDisposalCo2.toFixed(3)),
    totalCo2EmissionKg,
    totalCo2SavedKg: Number(totalCo2Saved.toFixed(3)),
    netCo2EmissionKg,
    costs,
    itemDetails,
    hasResiduals
  };
}
