// ============================================================
// PESAM – ScopeManifest Types
// Kręgosłup systemu. Każdy agent czyta stąd swoje zadanie.
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

export type DataSource =
    | 'AI_FROM_PFU'
    | 'AI_FROM_SWZ'
    | 'AI_HEURISTIC'
    | 'HARDCODED_NORM';

export type GapFillerStrategy =
    | 'SEKOCENBUD_M2'
    | 'EUROKOD_NORM'
    | 'GUS_PERCENT'
    | 'ASK_USER';

export type CoverageStatus =
    | 'COVERED'
    | 'GAP_FILLED'
    | 'MISSING'
    | 'NEEDS_REVIEW'
    | 'WAITING_USER';

export type DataQuality =
    | 'MARKET_VERIFIED'
    | 'NORMATIVE'
    | 'ESTIMATED'
    | 'MISSING';

export type RiskSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

// --- Poziom 1: Nagłówek manifestu ---
export interface ScopeManifestMeta {
    tenderId: string;
    generatedAt: string;
    updatedAt: string;
    docLevel: DocLevel;
    objectType: ObjectType;
    objectArea_m2: number | null;
    estimationMethod: EstimationMethod;
    confidenceScore: number;
    sourceDocuments: string[];
    isLocked: boolean;
}

// --- Poziom 2: Wymagania twarde z SWZ/OPZ ---
export interface HardRequirement {
    id: string;
    description: string;
    sourceRef: string;
    affectedDivisionIds: string[];
    isMandatory: boolean;
    addedBy: 'AI' | 'USER';
}

// --- Poziom 3: Wymagane działy (serce manifestu) ---
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
}

export interface ScopeDivision {
    divisionId: string;
    divisionName: string;
    displayOrder: number;
    elements: ScopeElement[];
}

// --- Poziom 4: Ryzyka ---
export interface MissingDataRisk {
    riskId: string;
    description: string;
    costImpactPercent: number;
    affectedDivisionIds: string[];
    severity: RiskSeverity;
    addedBy: 'AI' | 'USER';
    userOverridePercent?: number;
}

// --- Poziom 5: Status pokrycia (żywy dokument) ---
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
}

// --- Kompletny dokument ScopeManifest ---
export interface ScopeManifest {
    meta: ScopeManifestMeta;
    hardRequirements: HardRequirement[];
    requiredDivisions: ScopeDivision[];
    missingDataRisks: MissingDataRisk[];
    coverageStatus: CoverageEntry[];
}

// --- Typy pomocnicze dla agentów ---
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