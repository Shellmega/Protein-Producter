/**
 * Type declarations for the plain-ESM P36 classifier shared with the evidence
 * runner (`scripts/persistence-evidence/run.mjs`). Keep in sync with
 * `p36Stats.mjs`.
 */

export interface P36VitestAssertion {
  title?: string;
  status?: string;
  ancestorTitles?: string[];
  fullName?: string;
}

export interface P36VitestFile {
  name?: string;
  status?: string;
  assertionResults?: P36VitestAssertion[];
}

export interface P36VitestReport {
  numTotalTests?: number;
  numPassedTests?: number;
  numFailedTests?: number;
  testResults?: P36VitestFile[];
}

export interface P36CaseInput {
  kind?: string;
  file?: string;
  generator?: string;
}

export interface P36Case {
  id: string;
  category: string;
  input?: P36CaseInput;
}

export interface P36CasesDocument {
  cases?: P36Case[];
}

export interface P36LayerSummary {
  expected: number;
  observed: string[];
}

export interface P36Samples {
  corpus: { case: string; status: string }[];
  generated_boundary: { test: string; status: string; suite: string }[];
  spatial_layering: { test: string; status: string; suite: string }[];
}

export interface P36Classification {
  kind: string;
  method: string;
  corpus_expected: number;
  corpus_cases: number;
  corpus_passed: number;
  corpus_failed: number;
  corpus_missing_case_ids: string[];
  corpus_duplicate_case_ids: string[];
  corpus_unknown_titles: string[];
  corpus_matches_frozen_count: boolean;
  generated_boundary_cases: number;
  generated_boundary_passed: number;
  generated_boundary_failed: number;
  generated_case_ids_in_package: string[];
  spatial_layering_cases: number;
  spatial_layering_passed: number;
  spatial_layering_failed: number;
  spatial_layers: {
    coincidence_vectors: P36LayerSummary;
    roundoff_vectors: P36LayerSummary;
    tau_inputs: P36LayerSummary;
  };
  samples: P36Samples;
}

export interface P36Input {
  report: P36VitestReport;
  cases: P36CasesDocument;
  coincidenceVectorIds?: string[];
  roundoffVectorIds?: string[];
  tauInputIds?: string[];
}

export const FROZEN_BODY_CASE_COUNT: number;
export const OUT_OF_CLIENT_SCOPE_CATEGORIES: string[];
export const CORPUS_SUITE: string;
export const GENERATED_BOUNDARY_SUITES: string[];
export const SPATIAL_LAYERING_SUITE_PREFIXES: string[];
export const TAU_INPUT_IDS: string[];

export function bodyCaseIds(casesDocument: P36CasesDocument): string[];
export function generatedCaseIds(casesDocument: P36CasesDocument): string[];
export function classifyP36(input: P36Input): P36Classification;
