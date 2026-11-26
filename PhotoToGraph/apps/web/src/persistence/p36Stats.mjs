/**
 * P36 statistics classifier for the PTG-3 persistence evidence runner.
 *
 * Classification rules (C-PTG3-01):
 * - corpus cases are matched by Vitest suite (`ancestorTitles`) AND the stable
 *   case IDs frozen in `contracts/ptg-graph/v1/cases.json` — never by counting
 *   the `" -> "` substring in a test title, so an unrelated arrow-shaped test
 *   title cannot pollute the count;
 * - generated/boundary cases (e.g. the generated 2048/2049 node boundary) are
 *   counted from their own Vitest suites;
 * - spatial-layering cases (coincidence / roundoff / tau layers) are counted
 *   from their own suites and their stable vector IDs.
 *
 * This file is deliberately plain ESM: the evidence runner imports it with
 * plain Node (no transpile step) and the unit tests import the very same module,
 * so the classification rules cannot drift between the two.
 */

/** Frozen body-case count of the `ptg-graph/1.0-draft.gtp.5` corpus. */
export const FROZEN_BODY_CASE_COUNT = 84;

/** Categories the receiving service decides before the body stages (PTG-4/5). */
export const OUT_OF_CLIENT_SCOPE_CATEGORIES = [
  'invalid_syntax',
  'invalid_transport',
  'invalid_headers',
];

/** Suite title of the frozen body-case replay in `contract/validate.test.ts`. */
export const CORPUS_SUITE = 'frozen case corpus replay (body stages)';

/** Suite titles that exercise generated/boundary inputs (2048/2049, ...). */
export const GENERATED_BOUNDARY_SUITES = ['node count boundary'];

/** Suite-title prefixes that exercise the spatial coincidence/tau layers. */
export const SPATIAL_LAYERING_SUITE_PREFIXES = [
  'numeric boundary vectors',
  'E03/E09 fixed binary64 geometry',
];

/** Seven exact tau + 0..6 ULP inputs registered for the UI. */
export const TAU_INPUT_IDS = [
  'tau+0',
  'tau+1',
  'tau+2',
  'tau+3',
  'tau+4',
  'tau+5',
  'tau+6',
];

function casesOf(document) {
  return Array.isArray(document?.cases) ? document.cases : [];
}

/** Stable IDs of the 84 frozen body cases replayed by the unit layer. */
export function bodyCaseIds(casesDocument) {
  return casesOf(casesDocument)
    .filter(
      (entry) =>
        entry?.input?.kind === 'file' &&
        typeof entry?.input?.file === 'string' &&
        !OUT_OF_CLIENT_SCOPE_CATEGORIES.includes(entry.category),
    )
    .map((entry) => entry.id);
}

/**
 * Stable IDs of frozen cases whose input is generated rather than a stored
 * file (e.g. `invalid-node-count-high` = 2049 nodes). They are not part of the
 * 84 file-body corpus and are reported separately.
 */
export function generatedCaseIds(casesDocument) {
  return casesOf(casesDocument)
    .filter((entry) => entry?.input?.kind === 'generated')
    .map((entry) => entry.id);
}

/**
 * Match a title against a list of stable case/vector IDs. The character after
 * the ID must be a boundary (`end`, ` ->`, `:`, space, closing quote) so
 * `invalid-coincident` can never swallow `invalid-coincident-threshold`.
 * Vitest renders `it.each('$id: ...')` titles as `'tau+0': ...`, so leading
 * quotes are stripped before matching.
 */
function matchStableId(title, ids) {
  const normalized = title.replace(/^[\s'"]+/, '');
  for (const id of ids) {
    if (typeof id !== 'string' || !normalized.startsWith(id)) continue;
    const rest = normalized.slice(id.length);
    if (
      rest === '' ||
      rest.startsWith(' ->') ||
      rest.startsWith(':') ||
      rest.startsWith(' ') ||
      rest.startsWith("'") ||
      rest.startsWith('"')
    ) {
      return id;
    }
  }
  return null;
}

function suiteMatches(ancestorTitles, suite) {
  return ancestorTitles.some((title) => title === suite || title.startsWith(suite));
}

function sample(rows, limit) {
  return rows.slice(0, limit).map((row) => ({ test: row.title, status: row.status, suite: row.ancestorTitles.join(' / ') }));
}

/**
 * Classify the Vitest JSON report into the three P36 counters.
 *
 * @param {{
 *   report: { testResults?: { name?: string, assertionResults?: { title?: string, status?: string, ancestorTitles?: string[] }[] }[] },
 *   cases: { cases?: unknown[] },
 *   coincidenceVectorIds?: string[],
 *   roundoffVectorIds?: string[],
 *   tauInputIds?: string[],
 * }} input
 */
export function classifyP36(input) {
  const report = input?.report ?? {};
  const bodyIds = bodyCaseIds(input?.cases);
  const generatedIds = generatedCaseIds(input?.cases);
  const coincidenceVectorIds = Array.isArray(input?.coincidenceVectorIds) ? input.coincidenceVectorIds : [];
  const roundoffVectorIds = Array.isArray(input?.roundoffVectorIds) ? input.roundoffVectorIds : [];
  const tauInputIds = Array.isArray(input?.tauInputIds) ? input.tauInputIds : TAU_INPUT_IDS;

  const corpusById = new Map();
  const corpusUnknownTitles = [];
  const generatedBoundary = [];
  const spatialLayering = [];
  const observedVectors = { coincidence: new Set(), roundoff: new Set(), tau: new Set() };

  for (const file of report.testResults ?? []) {
    for (const assertion of file?.assertionResults ?? []) {
      const title = typeof assertion?.title === 'string' ? assertion.title : '';
      const status = typeof assertion?.status === 'string' ? assertion.status : 'unknown';
      const ancestorTitles = Array.isArray(assertion?.ancestorTitles)
        ? assertion.ancestorTitles.filter((value) => typeof value === 'string')
        : [];
      const row = { title, status, ancestorTitles };

      // 1. Frozen body-case corpus: suite + stable cases.json ID.
      if (suiteMatches(ancestorTitles, CORPUS_SUITE)) {
        const caseId = matchStableId(title, bodyIds);
        if (caseId !== null) {
          const rows = corpusById.get(caseId) ?? [];
          rows.push(row);
          corpusById.set(caseId, rows);
        } else if (title !== 'covers the expected number of body cases') {
          corpusUnknownTitles.push(row);
        }
        continue;
      }

      // 2. Generated / boundary inputs (e.g. 2048/2049 node boundary).
      const generatedCaseId =
        generatedIds.length > 0 ? matchStableId(title, generatedIds) : null;
      if (
        generatedCaseId !== null ||
        GENERATED_BOUNDARY_SUITES.some((suite) => suiteMatches(ancestorTitles, suite))
      ) {
        generatedBoundary.push(row);
        continue;
      }

      // 3. Spatial layering (coincidence / roundoff / tau vectors).
      const coincidenceId = matchStableId(title, coincidenceVectorIds);
      const roundoffId = matchStableId(title, roundoffVectorIds);
      const tauId = matchStableId(title, tauInputIds);
      if (coincidenceId !== null) observedVectors.coincidence.add(coincidenceId);
      if (roundoffId !== null) observedVectors.roundoff.add(roundoffId);
      if (tauId !== null) observedVectors.tau.add(tauId);
      if (
        SPATIAL_LAYERING_SUITE_PREFIXES.some((suite) => suiteMatches(ancestorTitles, suite)) ||
        coincidenceId !== null ||
        roundoffId !== null ||
        tauId !== null
      ) {
        spatialLayering.push(row);
      }
    }
  }

  const corpusRows = [...corpusById.values()];
  const corpusFailedIds = corpusRows.filter((rows) =>
    rows.some((row) => row.status !== 'passed'),
  ).length;
  const duplicateCaseIds = [...corpusById.entries()]
    .filter(([, rows]) => rows.length > 1)
    .map(([caseId]) => caseId);
  const missingCaseIds = bodyIds.filter((caseId) => !corpusById.has(caseId));

  const countFailed = (rows) => rows.filter((row) => row.status !== 'passed').length;
  const corpusSamples = bodyIds
    .filter((caseId) => corpusById.has(caseId))
    .map((caseId) => ({ case: caseId, status: corpusById.get(caseId)[0].status }));

  return {
    kind: 'PTG-3 contract corpus + numeric boundary (unit layer)',
    method:
      'classified by Vitest suite (ancestorTitles) + stable cases.json case IDs / vector IDs; no " -> " title-substring counting',
    corpus_expected: FROZEN_BODY_CASE_COUNT,
    corpus_cases: corpusById.size,
    corpus_passed: corpusById.size - corpusFailedIds,
    corpus_failed: corpusFailedIds,
    corpus_missing_case_ids: missingCaseIds,
    corpus_duplicate_case_ids: duplicateCaseIds,
    corpus_unknown_titles: corpusUnknownTitles.map((row) => row.title),
    corpus_matches_frozen_count:
      bodyIds.length === FROZEN_BODY_CASE_COUNT && corpusById.size === FROZEN_BODY_CASE_COUNT,
    generated_boundary_cases: generatedBoundary.length,
    generated_boundary_passed: generatedBoundary.length - countFailed(generatedBoundary),
    generated_boundary_failed: countFailed(generatedBoundary),
    generated_case_ids_in_package: generatedIds,
    spatial_layering_cases: spatialLayering.length,
    spatial_layering_passed: spatialLayering.length - countFailed(spatialLayering),
    spatial_layering_failed: countFailed(spatialLayering),
    spatial_layers: {
      coincidence_vectors: {
        expected: coincidenceVectorIds.length,
        observed: [...observedVectors.coincidence].sort(),
      },
      roundoff_vectors: {
        expected: roundoffVectorIds.length,
        observed: [...observedVectors.roundoff].sort(),
      },
      tau_inputs: {
        expected: tauInputIds.length,
        observed: [...observedVectors.tau].sort(),
      },
    },
    samples: {
      corpus: corpusSamples,
      generated_boundary: sample(generatedBoundary, 20),
      spatial_layering: sample(spatialLayering, 20),
    },
  };
}
