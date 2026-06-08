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
    | 'HARDCODED_NORM'
    | 'AI_WBS_HEURISTIC'
    | 'TECH_AUDIT';

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
    | 'WAITING_USER'
    | 'NEEDS_QUANTITY'
    | 'TECH_REQUIRED';

export type DataQuality =
    | 'MARKET_VERIFIED'
    | 'NORMATIVE'
    | 'ESTIMATED'
    | 'MISSING';

export type RiskSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type AgentPhase =
    | 'WBS_ARCHITECT'
    | 'MAPPING_DETECTIVE'
    | 'QUANTITY_SURVEYOR'
    | 'SILENT_AUDITOR'
    | 'LEGAL'
    | 'VISION'
    | 'KNR'
    | 'NORMATIVE_STEEL'
    | 'PARAMETRIC'
    | 'BROKER'
    | 'GAP_FILLER'
    | 'REWIDENT'
    | 'ANALITYK_ZAKRESU';

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
    completedPhases?: AgentPhase[];
}

export interface HardRequirement {
    id: string;
    description: string;
    sourceRef: string;
    affectedDivisionIds: string[];
    isMandatory: boolean;
    addedBy: 'AI' | 'USER';
}

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
    mappedFileId?: string | null;
    quantity?: number | null;
    quantitySource?: 'VISION' | 'BRAIN_INDICATOR' | 'MANUAL' | null;
    techAuditNote?: string | null;
}

export interface ScopeDivision {
    divisionId: string;
    divisionName: string;
    displayOrder: number;
    elements: ScopeElement[];
}

export interface MissingDataRisk {
    riskId: string;
    description: string;
    costImpactPercent: number;
    affectedDivisionIds: string[];
    severity: RiskSeverity;
    addedBy: 'AI' | 'USER';
    userOverridePercent?: number;
}

export interface CoverageEntry {
    elementId: string;
    divisionId: string;
    status: CoverageStatus;
    dataSource?: DataSource;
    coveredBySectionId: string | null;
    dataQuality: DataQuality;
    gapFillerNote: string | null;
    gapFillerValue: number | null;
    lastUpdatedBy: string;
    lastUpdatedAt: string;
    pendingQuestion?: string;
    mappedFileId?: string | null;
    quantityEstimated?: number | null;
    quantitySource?: 'VISION' | 'BRAIN_INDICATOR' | 'MANUAL' | null;
}

export interface ScopeManifest {
    meta: ScopeManifestMeta;
    hardRequirements: HardRequirement[];
    requiredDivisions: ScopeDivision[];
    missingDataRisks: MissingDataRisk[];
    coverageStatus: CoverageEntry[];
    techAlerts?: TechAlert[];
}

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