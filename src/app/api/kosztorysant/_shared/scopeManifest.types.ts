// ============================================================
// PESAM 2.0 – ScopeManifest Types
// Kręgosłup systemu. Każdy agent czyta stąd swoje zadanie.
//
// ZMIANY v2.0:
//   + CoverageStatus: dodano NEEDS_QUANTITY, TECH_REQUIRED
//   + DataSource: dodano AI_WBS_HEURISTIC, TECH_AUDIT
//   + Nowe interfejsy outputów dla 4 agentów progresywnych
//   + AgentPhase – kolejność faz DAG
//   + MappingResult – wynik Detektywa Mapowania
//   + QuantityResult – wynik Ilościowca
//   + TechAlert – wynik Cichego Rewidenta
// ============================================================

export type DocLevel = 0 | 1 | 2 | 3 | 4;

export type ObjectType =
    | 'przedszkole'
    | 'szkola'
    | 'biurowiec'
    | 'hala_sportowa'
    | 'hala_produkcyjna'
    | 'budynek_mieszkalny'
    | 'szpital'
    | 'inne';

export type EstimationMethod =
    | 'PARAMETRIC'
    | 'ANALOGICAL'
    | 'ELEMENT_BASED'
    | 'DETAILED_KNR';

// ----------------------------------------------------------------
// DataSource – rozszerzone o źródła z nowych agentów
// ----------------------------------------------------------------
export type DataSource =
    | 'AI_FROM_PFU'          // Analityk Zakresu – z treści PFU
    | 'AI_FROM_SWZ'          // Analityk Zakresu – z treści SWZ
    | 'AI_HEURISTIC'         // Analityk Zakresu – heurystyka ogólna
    | 'HARDCODED_NORM'       // Twarda norma (zawsze wymagana)
    | 'AI_WBS_HEURISTIC'     // [NOWE] Architekt WBS – DNA budynku bez dokumentów
    | 'TECH_AUDIT';          // [NOWE] Cichy Rewident – pułapka technologiczna

export type GapFillerStrategy =
    | 'SEKOCENBUD_M2'
    | 'EUROKOD_NORM'
    | 'GUS_PERCENT'
    | 'ASK_USER';

// ----------------------------------------------------------------
// CoverageStatus – rozszerzony o statusy nowych agentów
// ----------------------------------------------------------------
export type CoverageStatus =
    | 'COVERED'          // Ilościowiec lub KNR wyliczył wartość z dokumentów
    | 'GAP_FILLED'       // Gap Filler uzupełnił wskaźnikowo
    | 'MISSING'          // Nikt jeszcze tego nie dotknął
    | 'NEEDS_REVIEW'     // Rewident zgłosił wątpliwość
    | 'WAITING_USER'     // Czeka na odpowiedź użytkownika (ASK_USER)
    | 'NEEDS_QUANTITY'   // [NOWE] Detektyw zmapował plik, ale Ilościowiec jeszcze nie przeliczył
    | 'TECH_REQUIRED';   // [NOWE] Cichy Rewident dodał pozycję wymaganą technologicznie

export type DataQuality =
    | 'MARKET_VERIFIED'
    | 'NORMATIVE'
    | 'ESTIMATED'
    | 'MISSING';

export type RiskSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

// ----------------------------------------------------------------
// AgentPhase – fazy DAG (kolejność uruchamiania agentów)
// Używane przez inicjalizator do budowania kolejki i przez frontend
// do wizualizacji postępu.
// ----------------------------------------------------------------
export type AgentPhase =
    | 'WBS_ARCHITECT'       // Faza 0: DNA budynku (zawsze pierwszy)
    | 'MAPPING_DETECTIVE'   // Faza 1: dopasowanie plików do szkieletu
    | 'QUANTITY_SURVEYOR'   // Faza 2: zamiana nazw w liczby
    | 'SILENT_AUDITOR'      // Faza 3: ukryte pułapki technologiczne
    | 'LEGAL'               // Faza 4: analiza prawna SWZ/umowy
    | 'VISION'              // Faza 4b: analiza rysunków (Vision API)
    | 'KNR'                 // Faza 5: przedmiarowanie z normatywów
    | 'NORMATIVE_STEEL'     // Faza 5b: stal zbrojeniowa wskaźnikowo
    | 'PARAMETRIC'          // Faza 5c: wycena wskaźnikowa m2 (niski DocLevel)
    | 'BROKER'              // Faza 6: wycena rynkowa i weryfikacja cen
    | 'GAP_FILLER'          // Faza 7: łatanie pozostałych luk
    | 'REWIDENT'            // Faza 8: końcowy audytor (zawsze ostatni)
    // Zachowany dla kompatybilności wstecznej
    | 'ANALITYK_ZAKRESU';

// ================================================================
// Nagłówek manifestu
// ================================================================
export interface ScopeManifestMeta {
    tenderId: string;
    generatedAt: string;
    updatedAt: string;
    docLevel: DocLevel;
    objectType: ObjectType;
    objectArea_m2: number | null;
    areaIsEstimated?: boolean;
    estimationMethod: EstimationMethod;
    confidenceScore: number;
    sourceDocuments: string[];
    isLocked: boolean;
    // [NOWE] Ślad faz – które agenty już ukończyły pracę
    completedPhases?: AgentPhase[];
}

// ================================================================
// Wymagania twarde z SWZ/OPZ
// ================================================================
export interface HardRequirement {
    id: string;
    description: string;
    sourceRef: string;
    affectedDivisionIds: string[];
    isMandatory: boolean;
    addedBy: 'AI' | 'USER';
}

// ================================================================
// Wymagane działy (serce manifestu)
// ================================================================
export interface ScopeElement {
    elementId: string;
    name: string;
    unit: string;
    source: DataSource;
    isMandatoryByLaw: boolean;
    applicableObjectTypes: ObjectType[] | 'ALL';
    minDocLevel: DocLevel;
    gapFillerStrategy: GapFillerStrategy;
    gapFillerHint?: string;
    gapFillerMultiplier?: number;
    // [NOWE] Wynik Detektywa – który plik (fileId) pokrywa ten element
    mappedFileId?: string | null;
    // [NOWE] Wynik Ilościowca – wyliczona ilość i jednostka
    quantity?: number | null;
    quantitySource?: 'VISION' | 'BRAIN_INDICATOR' | 'MANUAL' | null;
    // [NOWE] Alert Cichego Rewidenta – opis pułapki technologicznej
    techAuditNote?: string | null;
}

export interface ScopeDivision {
    divisionId: string;
    divisionName: string;
    displayOrder: number;
    elements: ScopeElement[];
}

// ================================================================
// Ryzyka
// ================================================================
export interface MissingDataRisk {
    riskId: string;
    description: string;
    costImpactPercent: number;
    affectedDivisionIds: string[];
    severity: RiskSeverity;
    addedBy: 'AI' | 'USER';
    userOverridePercent?: number;
}

// ================================================================
// Status pokrycia (żywy dokument – aktualizowany przez każdy agent)
// ================================================================
export interface CoverageEntry {
    elementId: string;
    divisionId: string;
    status: CoverageStatus;
    coveredBySectionId: string | null;
    dataQuality: DataQuality;
    gapFillerNote: string | null;
    gapFillerValue: number | null;
    lastUpdatedBy: string;
    lastUpdatedAt: string;
    pendingQuestion?: string;
    // [NOWE] Który plik (fileId) Detektyw przypisał do tego elementu
    mappedFileId?: string | null;
    // [NOWE] Wyliczona ilość przez Ilościowca (przed wyceną)
    quantityEstimated?: number | null;
    quantitySource?: 'VISION' | 'BRAIN_INDICATOR' | 'MANUAL' | null;
}

// ================================================================
// Kompletny dokument ScopeManifest
// ================================================================
export interface ScopeManifest {
    meta: ScopeManifestMeta;
    hardRequirements: HardRequirement[];
    requiredDivisions: ScopeDivision[];
    missingDataRisks: MissingDataRisk[];
    coverageStatus: CoverageEntry[];
    // [NOWE] Alerty technologiczne od Cichego Rewidenta
    techAlerts?: TechAlert[];
}

// ================================================================
// Typy pomocnicze – OUTPUT każdego z nowych agentów
// ================================================================

// --- Output Architekta WBS (Faza 0) ---
export interface WbsArchitectOutput {
    objectType: ObjectType;
    objectArea_m2: number | null;
    confidenceScore: number;
    requiredDivisions: Array<{
        divisionId: string;
        divisionName: string;
        displayOrder: number;
        elements: Array<Omit<ScopeElement, 'isMandatoryByLaw' | 'applicableObjectTypes' | 'minDocLevel' | 'mappedFileId' | 'quantity' | 'quantitySource' | 'techAuditNote'>>;
    }>;
    initialRisks: Omit<MissingDataRisk, 'addedBy' | 'userOverridePercent'>[];
}

// --- Output Detektywa Mapowania (Faza 1) ---
export interface MappingResult {
    elementId: string;
    divisionId: string;
    mappedFileId: string | null;
    mappedFileName: string | null;
    newStatus: 'NEEDS_QUANTITY' | 'MISSING';
    extractionHint?: string;
}

// --- Output Ilościowca (Faza 2) ---
export interface QuantityResult {
    elementId: string;
    divisionId: string;
    quantity: number;
    unit: string;
    source: 'VISION' | 'BRAIN_INDICATOR';
    newStatus: 'COVERED' | 'GAP_FILLED';
    dataQuality: DataQuality;
    note: string;
}

// --- Alert technologiczny od Cichego Rewidenta (Faza 3) ---
export interface TechAlert {
    alertId: string;
    itemName: string;
    targetDivisionId: string;
    reason: string;
    severity: RiskSeverity;
    suggestedStrategy: GapFillerStrategy;
    suggestedUnit: string;
    autoAdded: boolean;
}

// --- Zachowany dla kompatybilności wstecznej ---
export interface AnalitykZakresuGeminiOutput {
    objectType: ObjectType;
    objectArea_m2: number | null;
    confidenceScore: number;
    hardRequirements: Omit<HardRequirement, 'addedBy'>[];
    requiredDivisions: Array<{
        divisionId: string;
        divisionName: string;
        displayOrder: number;
        elements: Omit<ScopeElement, 'isMandatoryByLaw' | 'applicableObjectTypes' | 'minDocLevel'>[];
    }>;
    missingDataRisks: Omit<MissingDataRisk, 'addedBy' | 'userOverridePercent'>[];
}

export interface GapFillerResult {
    elementId: string;
    divisionId: string;
    strategy: GapFillerStrategy;
    estimatedValue_PLN: number;
    note: string;
    dataQuality: DataQuality;
}