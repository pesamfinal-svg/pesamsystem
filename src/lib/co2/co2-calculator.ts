// src/lib/co2/co2-calculator.ts

/**
 * Globalne parametry emisyjne i kosztowe CO2 dla systemu PESAM.
 * Oparte na 'baza_wskaznikow_co2.md' oraz oficjalnych źródłach (KOBiZE 2026, DEFRA 2025).
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
    name: "Odpady budowlane / Gips – recykling (closed-loop)",
    factor: 1.008,
    method: "recykling_closed_loop",
    status: "DEFRA 2025"
  },
  util_budowlane_otwarta_petla: {
    name: "Odpady budowlane / Gips – recykling (open-loop)",
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
    name: "Odpady budowlane / Tworzywa – spalanie z odzyskiem",
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
  category?: string;
  subcategory?: string;
  isWaste?: boolean;
  isResidual?: boolean;
  inventoryNumber?: string;
  finalStatus?: string;
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
  reuseWeightKg: number;
  wasteWeightKg: number;
  disposalMethodKey: string;
  disposalMethodName: string;
  disposalCo2Kg: number;
  isReuse: boolean;
  co2SavedKg: number;
  notesAnalysis: string;
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
  totalEstimatedWeightKg: number; // Masa samych resztek / odpadów
  totalReuseWeightKg: number; // Część zdatna do ponownego użycia na magazynie
  totalWasteWeightKg: number; // Część będąca odpadem/ścinkami podlegająca utylizacji
  totalCargoWeightKg: number; // Masa całkowita całego ładunku pojazdu (wraz ze sprzętem)
  allocationRatio: number; // Procentowy udział resztek w masie kursu (np. 0.1705 dla 17.05%)
  transportCo2Kg: number; // Emisja transportu przypisana proporcjonalnie do resztek
  fullCourseTransportCo2Kg: number; // Emisja całego kursu pojazdu (tam i z powrotem)
  disposalCo2Kg: number; // Emisja z utylizacji ścinek i odpadów (DEFRA 2025)
  totalCo2EmissionKg: number;
  totalCo2SavedKg: number;
  netCo2EmissionKg: number;
  costs: Co2CostResult;
  itemDetails: ItemCo2Details[]; // TYLKO pozycje resztek / odpadów
  hasResiduals: boolean;
  residualItemsCount: number;
  totalItemsCount: number;
}

/**
 * Sprawdza jednoznacznie czy dana pozycja to resztka materiału budowlanego lub odpad zwożony z budowy,
 * czy też regularny sprzęt magazynowy/inwentarzowy (ogrodzenia, rusztowania, szalunki, agregaty).
 */
export function isItemResidualOrWaste(item: ProtocolItemInput): boolean {
  if (item.isResidual === true || item.isWaste === true) {
    return true;
  }

  const invUpper = (item.inventoryNumber || "").toUpperCase().trim();
  if (invUpper === "RESZTKI" || invUpper === "ODPAD") {
    return true;
  }

  if (item.category === "Pozostałości budowlane" || item.subcategory === "Materiały otwarte / Resztki") {
    return true;
  }

  if (item.finalStatus === "odpad_utylizacja") {
    return true;
  }

  const textToSearch = [item.notes, item.condition, item.name]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (
    textToSearch.includes("[pozostałości]") ||
    textToSearch.includes("[resztki]") ||
    textToSearch.includes("odpad do utylizacji") ||
    textToSearch.includes("otwarty worek") ||
    textToSearch.includes("resztk")
  ) {
    return true;
  }

  return false;
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

  // 2. Jeśli brak jawnej wagi w nazwie, sprawdzamy jednostki i typy materiałów
  if (estimatedWeightKg === 0) {
    if (unitLower === 'kg') {
      estimatedWeightKg = qty;
    } else if (unitLower === 't' || unitLower === 'tona' || unitLower === 'tony') {
      estimatedWeightKg = qty * 1000;
    } else if (nameLower.includes('worek') || nameLower.includes('worki') || unitLower.includes('work')) {
      estimatedWeightKg = 25 * qty; // domyślny worek chemii / kleju / cementu = 25 kg
    } else if (nameLower.includes('wiadro') || nameLower.includes('wiadra') || unitLower.includes('wiad')) {
      estimatedWeightKg = 20 * qty; // wiadro tynku/farby/gruntu = 20 kg
    } else if (nameLower.includes('płyta') || nameLower.includes('plyta') || nameLower.includes('g-k') || nameLower.includes('gk') || nameLower.includes('regips')) {
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

  return Math.max(0.1, Number(estimatedWeightKg.toFixed(2)));
}

/**
 * Dobiera odpowiednią metodę utylizacji DEFRA 2025 dla odpadu w zależności od materiału.
 */
export function determineWasteDisposalMethod(item: ProtocolItemInput): { key: string; name: string } {
  if (item.disposalMethodKey && DISPOSAL_CO2_FACTORS_KG_PER_TONNE[item.disposalMethodKey]) {
    return {
      key: item.disposalMethodKey,
      name: DISPOSAL_CO2_FACTORS_KG_PER_TONNE[item.disposalMethodKey].name
    };
  }

  const text = [item.name, item.notes, item.category].filter(Boolean).join(" ").toLowerCase();

  if (text.includes("drewn") || text.includes("deski") || text.includes("palet")) {
    return { key: "util_drewno_skladowisko", name: DISPOSAL_CO2_FACTORS_KG_PER_TONNE["util_drewno_skladowisko"].name };
  }
  if (text.includes("beton") || text.includes("gruz") || text.includes("korek betonowy")) {
    return { key: "util_beton_skladowisko", name: DISPOSAL_CO2_FACTORS_KG_PER_TONNE["util_beton_skladowisko"].name };
  }
  if (text.includes("piasek") || text.includes("kruszyw") || text.includes("kamie")) {
    return { key: "util_kruszywa_skladowisko", name: DISPOSAL_CO2_FACTORS_KG_PER_TONNE["util_kruszywa_skladowisko"].name };
  }
  if (text.includes("styropian") || text.includes("plastik") || text.includes("folia") || text.includes("piana")) {
    return { key: "util_budowlane_spalanie", name: DISPOSAL_CO2_FACTORS_KG_PER_TONNE["util_budowlane_spalanie"].name };
  }
  if (text.includes("g-k") || text.includes("gk") || text.includes("regips") || text.includes("gips") || text.includes("gładź") || text.includes("gladź")) {
    return { key: "util_budowlane_otwarta_petla", name: "Recykling odpadów gipsowych / G-K (open-loop)" };
  }
  return { key: "util_budowlane_otwarta_petla", name: "Recykling odpadów budowlanych (open-loop)" };
}

/**
 * Analizuje pozycję resztek pod kątem podziału na część zdatną do ponownego użycia (Reuse)
 * oraz część odpadową/ścinki (Waste) podlegającą fizycznej utylizacji.
 */
export function analyzeItemReuseAndWasteSplit(item: ProtocolItemInput, totalWeightKg: number): {
  reuseWeightKg: number;
  wasteWeightKg: number;
  disposalMethodKey: string;
  disposalMethodName: string;
  notesAnalysis: string;
} {
  const method = determineWasteDisposalMethod(item);
  const qty = typeof item.receivedQty === "number" && item.receivedQty > 0
    ? item.receivedQty
    : (typeof item.quantity === "number" && item.quantity > 0 ? item.quantity : 1);

  const notesLower = (item.notes || "").toLowerCase();
  const conditionLower = (item.condition || "").toLowerCase();

  // 1. Pozycja jednoznacznie oznaczona jako odpad do utylizacji (np. gruz, śmieci, isWaste: true)
  if (
    item.isWaste === true ||
    item.inventoryNumber === "ODPAD" ||
    item.finalStatus === "odpad_utylizacja" ||
    notesLower.includes("odpad do utylizacji") ||
    notesLower.includes("gruz")
  ) {
    return {
      reuseWeightKg: 0,
      wasteWeightKg: totalWeightKg,
      disposalMethodKey: method.key,
      disposalMethodName: method.name,
      notesAnalysis: "100% odpad do utylizacji"
    };
  }

  // 2. Notatka precyzyjna o całych i ułamkach (np. "3 całe, 1 sztuka 50%", "1 pełny, 1 otwarty")
  if (notesLower.includes("całe") || notesLower.includes("pełny")) {
    const fullMatch = notesLower.match(/(\d+(\.\d+)?)\s*(całe|całych|cała|pełny|pełne|pełnych)/);
    if (fullMatch) {
      const fullQty = parseFloat(fullMatch[1]);
      if (qty > fullQty) {
        const wasteQty = qty - fullQty;
        const wasteKg = Number(((wasteQty / qty) * totalWeightKg).toFixed(2));
        const reuseKg = Number((totalWeightKg - wasteKg).toFixed(2));
        return {
          reuseWeightKg: reuseKg,
          wasteWeightKg: wasteKg,
          disposalMethodKey: method.key,
          disposalMethodName: method.name,
          notesAnalysis: `${fullQty} pełne (Reuse: ${reuseKg} kg) + ${wasteQty} ścinki/odpad (Utylizacja: ${wasteKg} kg)`
        };
      }
    }
  }

  // 3. Ilość ułamkowa (np. 3.5 regipsa, 1.5 worka)
  // Część całkowita to pełne elementy (Reuse), a część ułamkowa to ścinki/resztka (Utylizacja)
  if (qty > 1 && qty % 1 > 0) {
    const floorQty = Math.floor(qty);
    const fraction = qty - floorQty; // np. 0.5
    const wasteKg = Number(((fraction / qty) * totalWeightKg).toFixed(2));
    const reuseKg = Number((totalWeightKg - wasteKg).toFixed(2));
    return {
      reuseWeightKg: reuseKg,
      wasteWeightKg: wasteKg,
      disposalMethodKey: method.key,
      disposalMethodName: method.name,
      notesAnalysis: `${floorQty} całe (Reuse: ${reuseKg} kg) + ${fraction} ścinki/odpad (${wasteKg} kg)`
    };
  }

  // 4. Mała ilość (<= 1) z dopiskiem "otwarty", "ok. 50%", "resztka"
  if (qty <= 1 && (notesLower.includes("otwart") || conditionLower.includes("otwart") || notesLower.includes("50%") || conditionLower.includes("50%"))) {
    // 50% zdatne do użycia, 50% odpad / wyschnięta resztka do utylizacji
    const wasteKg = Number((totalWeightKg * 0.5).toFixed(2));
    const reuseKg = Number((totalWeightKg - wasteKg).toFixed(2));
    return {
      reuseWeightKg: reuseKg,
      wasteWeightKg: wasteKg,
      disposalMethodKey: method.key,
      disposalMethodName: method.name,
      notesAnalysis: `Otwarte opakowanie: 50% odzysk (${reuseKg} kg) + 50% odpad (${wasteKg} kg)`
    };
  }

  // 5. Pełna resztka bez ułamków (np. 1 pełny worek kleju, który nie był otwarty)
  // Domyślnie 90% ponowne użycie na magazynie, 10% straty transportowo-magazynowe / utylizacja opakowania
  const lossRatio = 0.10;
  const wasteKg = Number((totalWeightKg * lossRatio).toFixed(2));
  const reuseKg = Number((totalWeightKg - wasteKg).toFixed(2));
  return {
    reuseWeightKg: reuseKg,
    wasteWeightKg: wasteKg,
    disposalMethodKey: method.key,
    disposalMethodName: method.name,
    notesAnalysis: `Materiał zdatny do reuse (${reuseKg} kg) + 10% odpad/opakowanie (${wasteKg} kg)`
  };
}

/**
 * Wylicza całkowitą emisję CO2 kursu transportowego pojazdu (tam i z powrotem)
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
 * Wylicza emisję CO2 z utylizacji odpadu (DEFRA 2025)
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
 * Podsumowuje protokół pod kątem emisji CO2 i kosztów.
 * Rozbija pozycje resztek na:
 * - Część Reuse (ponowne wykorzystanie na magazynie, np. 3 całe płyty)
 * - Część Waste / Utylizacja (ścinki i odpady, np. 0.5 płyty) z naliczeniem fizycznej emisji utylizacji!
 */
export function calculateProtocolCo2Summary(
  protocol: ProtocolInput,
  overrideDistanceKm?: number,
  params?: {
    minEurPerTon?: number;
    maxEurPerTon?: number;
    eurToPln?: number;
    fuelLPer100km?: number;
    allocationMethod?: 'mass' | 'dedicated_100';
  }
): ProtocolCo2Summary {
  const minEur = params?.minEurPerTon ?? CO2_COST_PARAMS.defaultMinEurPerTon;
  const maxEur = params?.maxEurPerTon ?? CO2_COST_PARAMS.defaultMaxEurPerTon;
  const eurToPln = params?.eurToPln ?? CO2_COST_PARAMS.defaultEurToPlnRate;
  const fuelLPer100km = params?.fuelLPer100km ?? CO2_GLOBAL_PARAMS.defaultFleetVehicleFuelConsumptionLPer100km;
  const allocationMethod = params?.allocationMethod ?? 'mass';

  const distanceKm = overrideDistanceKm ?? protocol.constructionDistanceKm ?? CO2_GLOBAL_PARAMS.defaultConstructionDistanceKm;
  const allItems = Array.isArray(protocol.items) ? protocol.items : [];

  // 1. Oblicz masę CAŁEGO ładunku pojazdu (wraz ze sprzętem budowlanym)
  let totalCargoWeightKg = 0;
  for (const item of allItems) {
    totalCargoWeightKg += estimateItemWeightKg(item);
  }

  // 2. Wyodrębnij TYLKO pozycje resztek materiałowych i odpadów
  const residualItems = allItems.filter(isItemResidualOrWaste);
  const hasResiduals = residualItems.length > 0;

  let totalResidualWeightKg = 0;
  let totalReuseWeightKg = 0;
  let totalWasteWeightKg = 0;
  let totalDisposalCo2 = 0;
  let totalCo2Saved = 0;
  const itemDetails: ItemCo2Details[] = [];

  for (let idx = 0; idx < residualItems.length; idx++) {
    const item = residualItems[idx];
    const weightKg = estimateItemWeightKg(item);
    totalResidualWeightKg += weightKg;

    // Rozbicie na część ponownego użycia (Reuse) i część odpadową (Utylizacja)
    const split = analyzeItemReuseAndWasteSplit(item, weightKg);

    totalReuseWeightKg += split.reuseWeightKg;
    totalWasteWeightKg += split.wasteWeightKg;

    // Realnie naliczana emisja utylizacji dla ścinek/odpadów (DEFRA 2025)
    const disposalCo2 = calculateDisposalCo2(split.wasteWeightKg, split.disposalMethodKey);
    const savedCo2 = Number(((split.reuseWeightKg / 1000) * REUSE_CO2_SAVINGS_KG_PER_TONNE).toFixed(3));

    totalDisposalCo2 += disposalCo2;
    totalCo2Saved += savedCo2;

    itemDetails.push({
      itemId: item.id || `item-${idx}`,
      itemName: item.name || "Pozycja",
      quantity: typeof item.receivedQty === "number" ? item.receivedQty : (item.quantity || 1),
      unit: item.unit || "szt.",
      estimatedWeightKg: weightKg,
      reuseWeightKg: split.reuseWeightKg,
      wasteWeightKg: split.wasteWeightKg,
      disposalMethodKey: split.disposalMethodKey,
      disposalMethodName: split.disposalMethodName,
      disposalCo2Kg: disposalCo2,
      isReuse: split.reuseWeightKg > 0,
      co2SavedKg: savedCo2,
      notesAnalysis: split.notesAnalysis
    });
  }

  // 3. Emisja transportu i alokacja masowa zgodnie z baza_wskaznikow_co2.md
  const fullCourseTransportCo2Kg = calculateTransportCo2(distanceKm, fuelLPer100km);
  
  let allocationRatio = 0;
  if (hasResiduals) {
    if (allocationMethod === 'dedicated_100') {
      allocationRatio = 1.0;
    } else {
      allocationRatio = totalCargoWeightKg > 0
        ? Math.min(1.0, totalResidualWeightKg / Math.max(totalResidualWeightKg, totalCargoWeightKg))
        : 1.0;
    }
  }

  const transportCo2Kg = Number((fullCourseTransportCo2Kg * allocationRatio).toFixed(3));
  const totalCo2EmissionKg = Number((transportCo2Kg + totalDisposalCo2).toFixed(3));
  const netCo2EmissionKg = Number((Math.max(0, totalCo2EmissionKg - totalCo2Saved)).toFixed(3));

  const costs = calculateCo2Cost(totalCo2EmissionKg, minEur, maxEur, eurToPln);

  return {
    protocolId: protocol.id,
    protocolNumber: protocol.documentNumber || protocol.id,
    siteName: protocol.sourceSiteName || "Magazyn / Budowa",
    date: protocol.documentDate || (protocol.createdAt ? protocol.createdAt.split("T")[0] : ""),
    distanceKm,
    totalEstimatedWeightKg: Number(totalResidualWeightKg.toFixed(2)),
    totalReuseWeightKg: Number(totalReuseWeightKg.toFixed(2)),
    totalWasteWeightKg: Number(totalWasteWeightKg.toFixed(2)),
    totalCargoWeightKg: Number(totalCargoWeightKg.toFixed(2)),
    allocationRatio: Number(allocationRatio.toFixed(4)),
    transportCo2Kg,
    fullCourseTransportCo2Kg,
    disposalCo2Kg: Number(totalDisposalCo2.toFixed(3)),
    totalCo2EmissionKg,
    totalCo2SavedKg: Number(totalCo2Saved.toFixed(3)),
    netCo2EmissionKg,
    costs,
    itemDetails,
    hasResiduals,
    residualItemsCount: residualItems.length,
    totalItemsCount: allItems.length
  };
}
