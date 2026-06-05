/**
 * PESAM – Wspólne typy i helpery dla modułu kosztorysanta.
 * Importowane przez: dispatcher, knr-lookup, rms-engine.
 *
 * Ścieżka: src/app/api/kosztorysant/_shared/types.ts
 */

// ── Typy domenowe ─────────────────────────────────────────────────────────────

export type ItemType = "R" | "M" | "S";

export type AgentMode =
  | "GENERATE_FROM_SCRATCH"
  | "MODIFY_TECHNOLOGY"
  | "RECALCULATE_DIVISION"
  | "RISK_ANALYSIS"
  | "EXPLAIN_POSITION"
  | "GENERAL_QUERY";

export const VALID_MODES: AgentMode[] = [
  "GENERATE_FROM_SCRATCH",
  "MODIFY_TECHNOLOGY",
  "RECALCULATE_DIVISION",
  "RISK_ANALYSIS",
  "EXPLAIN_POSITION",
  "GENERAL_QUERY",
];

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

// ── Kształty request/response poszczególnych endpointów ───────────────────────

/** POST /api/kosztorysant/dispatcher */
export interface DispatcherRequest {
  request: string;
}
export interface DispatcherResponse {
  intent: AgentMode;
}

/** POST /api/kosztorysant/knr-lookup */
export interface KnrLookupRequest {
  request: string;
  currentTrends: MarketTrends;
  mode: AgentMode;
  currentSections?: EstimateSection[];
}
export interface KnrLookupResponse {
  sections: EstimateSection[];
  narrativeHints: string;
}

/** POST /api/kosztorysant/rms-engine (punkt wejścia frontendu) */
export interface RmsEngineRequest {
  request: string;
  currentTrends: MarketTrends;
  currentSections?: EstimateSection[];
}
export interface RmsEngineResponse {
  reply: string;
  generatedSections?: EstimateSection[];
  riskAlerts?: string[];
}

// ── Helper: bezpieczne wyciąganie obiektów JSON z tekstów AI ─────────────────

export function extractAllJSONObjects(text: string): unknown[] {
  const objects: unknown[] = [];
  let depth = 0;
  let startIndex = -1;
  let inString = false;
  let escape = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (inString) {
      if (char === "\\") {
        escape = !escape;
      } else if (char === '"' && !escape) {
        inString = false;
      } else {
        escape = false;
      }
    } else {
      if (char === '"') {
        inString = true;
      } else if (char === "{") {
        if (depth === 0) startIndex = i;
        depth++;
      } else if (char === "}") {
        if (depth > 0) {
          depth--;
          if (depth === 0 && startIndex !== -1) {
            try {
              objects.push(JSON.parse(text.substring(startIndex, i + 1)));
            } catch {
              // Uszkodzony fragment – pomijamy
            }
            startIndex = -1;
          }
        }
      }
    }
  }

  return objects;
}