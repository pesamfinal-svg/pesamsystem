// ============================================================
// PESAM 3.0 – Globalne Typy Kosztorysowe i RMS (Wyceny)
// ============================================================

export type ItemType = "R" | "M" | "S";

export type AgentMode =
    | "GENERATE_FROM_SCRATCH"
    | "MODIFY_TECHNOLOGY"
    | "RECALCULATE_DIVISION"
    | "RISK_ANALYSIS"
    | "EXPLAIN_POSITION"
    | "GENERAL_QUERY";

export interface EstimateItem {
    id: string;
    code?: string;
    name: string;
    type: ItemType;
    quantity: number;
    unit: string;
    basePrice: number;
    unitPrice: number;
}

export interface EstimateSection {
    id: string;
    name: string;
    items: EstimateItem[];
}

export interface MarketTrends {
    laborAdjustment: number;
    materialAdjustment: number;
    equipmentAdjustment: number;
    kp: number;
    zysk: number;
}