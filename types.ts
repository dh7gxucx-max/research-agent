// --- Criteria ---

export interface HardCriterion {
  field: string;
  description: string;
}

export interface SoftCriterion {
  description: string;
  weight: number; // 1-5
}

export interface ResearchCriteria {
  hard: HardCriterion[];
  soft: SoftCriterion[];
}

// --- Research Result ---

export interface ResearchResult {
  answer: string;
  iterations: number;
  toolCalls: number;
  candidatesEvaluated: number;
  sheetUrl?: string;
  cost?: {
    inputTokens: number;
    outputTokens: number;
    estimatedUsd: number;
  };
}

// --- Progress callback ---

export type ProgressCallback = (status: string) => void;

// --- Memory ---

export interface CandidateRecord {
  name: string;
  url?: string;
  verdict: "pass" | "fail" | "partial";
  hardResults: { criterion: string; passed: boolean; evidence: string }[];
  softScores: { criterion: string; score: number; reasoning: string }[];
  rejectionReason?: string;
  notes?: string;
}

export interface ResearchSession {
  id: string;
  timestamp: string;
  task: string;
  criteria: ResearchCriteria;
  candidates: CandidateRecord[];
  bestMatch?: string;
  searchQueries: string[];
  conclusion: string;
}

export interface MemoryStore {
  sessions: ResearchSession[];
  /** Known facts about services discovered across sessions */
  knownServices: Record<
    string,
    {
      url?: string;
      lastChecked: string;
      facts: Record<string, string>;
      verdict?: string;
      notes: string[];
    }
  >;
}
