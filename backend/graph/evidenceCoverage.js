/**
 * evidenceCoverage.js
 * =====================
 * Phase 2 "deterministic evidence-coverage assessment". Given what was
 * requested (entities.symbols x requestedDimensions) and what actually
 * came back (toolResults + evidence), computes a per-symbol, per-dimension
 * coverage matrix with a fixed, closed status vocabulary. No LLM call —
 * every status here is derived by inspecting real tool outcomes and real
 * evidence records, never guessed.
 *
 * This is deliberately a plain function over plain data (not a graph
 * node itself — see nodes/assessEvidenceSufficiency.js for the thin node
 * wrapper) so it can be unit-tested directly against hand-built
 * toolResults/evidence fixtures.
 */

export const EVIDENCE_COVERAGE_STATUS = Object.freeze({
  COVERED: 'COVERED',
  EMPTY: 'EMPTY',
  UNAVAILABLE: 'UNAVAILABLE',
  UNSUPPORTED: 'UNSUPPORTED',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  NOT_REQUESTED: 'NOT_REQUESTED',
});

// Which evidence claim types (graph/evidence.js's CLAIM_TYPES) count as
// "real coverage" for each requested dimension. PORTFOLIO/WATCHLIST/
// GENERAL are handled separately below (account-scoped or no-evidence
// dimensions, never per-company).
// Exported for nodes/buildSafeFallback.js (Phase 3) — the deterministic
// fallback builds one safe fact-line per COVERED row directly from real
// evidence, using the SAME claim-type mapping this file already uses to
// decide COVERED in the first place (a single source of truth, not a
// second copy that could drift).
export const DIMENSION_CLAIM_TYPES = Object.freeze({
  PRICE: ['LIVE_PRICE'],
  FINANCIALS: ['FINANCIAL_DATA'],
  COMPANY_RESEARCH: ['COMPANY_PROFILE', 'KEY_METRIC', 'SHAREHOLDING', 'CORPORATE_ACTION', 'ANALYST_FORECAST'],
  NEWS: ['COMPANY_NEWS'],
  GUIDANCE: ['MANAGEMENT_PROMISE', 'PROMISE_OUTCOME'],
  DOCUMENTS: ['DOCUMENT_EXCERPT'],
});

// Which planned tools could possibly have produced that dimension's
// evidence for a symbol — a plain top-level call OR nested inside a
// compareStocks step's per-symbol/per-dimension breakdown (see
// tools/toolRegistry.js's compareStocks). GUIDANCE deliberately lists both
// getEarningsTimeline and getManagementPromiseDetails: either route can
// legitimately be the one planTools chose.
// Exported for replanMissingEvidence.js — the ONE place that turns a
// missing (symbol, dimension) gap into a concrete replan tool-plan step,
// so the tool-name choice per dimension is defined in exactly one place.
export const DIMENSION_TOOLS = Object.freeze({
  PRICE: ['getLiveQuote'],
  FINANCIALS: ['getCompanyFinancials'],
  COMPANY_RESEARCH: ['getCompanyResearch'],
  NEWS: ['getCompanyNews'],
  GUIDANCE: ['getEarningsTimeline', 'getManagementPromiseDetails'],
  DOCUMENTS: ['searchResearchDocuments'],
});

const ACCOUNT_SCOPED_TOOL = Object.freeze({ PORTFOLIO: 'getPortfolio', WATCHLIST: 'getWatchlist' });

/** Every attempt (direct tool result, or a compareStocks entry's nested per-dimension result) relevant to one symbol+dimension pair. */
const findAttempts = (symbol, dimension, toolResults) => {
  const directTools = DIMENSION_TOOLS[dimension] || [];
  const direct = toolResults.filter((r) => directTools.includes(r.tool) && (r.symbol == null || r.symbol === symbol));
  const compareStocksResults = toolResults.filter((r) => r.tool === 'compareStocks' && Array.isArray(r.data));
  const nested = compareStocksResults
    .flatMap((r) => r.data)
    .filter((entry) => entry.symbol === symbol && entry.dimensions?.[dimension])
    .map((entry) => entry.dimensions[dimension]);
  return [...direct, ...nested];
};

/** Reduces a set of attempts (possibly zero) down to one coverage status, when there is no direct evidence match. Priority: AUTH_REQUIRED > UNSUPPORTED > UNAVAILABLE > EMPTY (no attempts at all is also EMPTY -- "requested but nothing came back", the actionable case for a replan). */
const statusFromAttempts = (attempts) => {
  if (attempts.some((a) => a.errorCode === 'AUTH_REQUIRED' || /authentication is required/i.test(a.warning || ''))) return EVIDENCE_COVERAGE_STATUS.AUTH_REQUIRED;
  if (attempts.some((a) => a.status === 'UNSUPPORTED')) return EVIDENCE_COVERAGE_STATUS.UNSUPPORTED;
  if (attempts.some((a) => a.status === 'UNAVAILABLE' || a.status === 'ERROR')) return EVIDENCE_COVERAGE_STATUS.UNAVAILABLE;
  return EVIDENCE_COVERAGE_STATUS.EMPTY;
};

/**
 * computeEvidenceCoverage - pure function, no LLM, no I/O.
 * Returns { evidenceCoverage, missingEvidence }. evidenceCoverage covers
 * only REQUESTED dimensions (GENERAL is never included — it names no
 * specific data type to check) — a dimension the user never asked about
 * is simply absent from the matrix rather than materialized as a
 * NOT_REQUESTED row for every symbol, which would balloon the matrix
 * without adding actionable information.
 */
export const computeEvidenceCoverage = ({
  symbols = [], requestedDimensions = [], toolResults = [], evidence = [], userId = null,
}) => {
  const evidenceCoverage = [];

  const companyDimensions = requestedDimensions.filter((d) => DIMENSION_CLAIM_TYPES[d]);
  for (const symbol of symbols) {
    for (const dimension of companyDimensions) {
      const claimTypes = DIMENSION_CLAIM_TYPES[dimension];
      const covered = evidence.some((e) => e.symbol === symbol && claimTypes.includes(e.claimType));
      const status = covered
        ? EVIDENCE_COVERAGE_STATUS.COVERED
        : statusFromAttempts(findAttempts(symbol, dimension, toolResults));
      evidenceCoverage.push({ symbol, dimension, status });
    }
  }

  // PORTFOLIO/WATCHLIST are account-scoped, not per-company-symbol.
  for (const dimension of ['PORTFOLIO', 'WATCHLIST']) {
    if (!requestedDimensions.includes(dimension)) continue;
    if (!userId) {
      evidenceCoverage.push({ symbol: null, dimension, status: EVIDENCE_COVERAGE_STATUS.AUTH_REQUIRED });
      continue;
    }
    const claimType = dimension === 'PORTFOLIO' ? 'PORTFOLIO_DATA' : 'WATCHLIST_DATA';
    const covered = evidence.some((e) => e.claimType === claimType);
    const attempt = toolResults.find((r) => r.tool === ACCOUNT_SCOPED_TOOL[dimension]);
    const status = covered ? EVIDENCE_COVERAGE_STATUS.COVERED : statusFromAttempts(attempt ? [attempt] : []);
    evidenceCoverage.push({ symbol: null, dimension, status });
  }

  const missingEvidence = evidenceCoverage.filter((row) => row.status !== EVIDENCE_COVERAGE_STATUS.COVERED);
  return { evidenceCoverage, missingEvidence };
};

const STATUS_PHRASE = Object.freeze({
  EMPTY: 'no data was found',
  UNAVAILABLE: 'temporarily unavailable',
  UNSUPPORTED: 'not a capability GS Copilot currently supports',
  AUTH_REQUIRED: 'requires the user to be signed in',
});

// Exported for nodes/buildSafeFallback.js — same reuse rationale as
// DIMENSION_CLAIM_TYPES above.
export const DIMENSION_LABEL = Object.freeze({
  PRICE: 'price', FINANCIALS: 'financials', COMPANY_RESEARCH: 'company research',
  NEWS: 'news', GUIDANCE: 'management guidance/promise tracking', DOCUMENTS: 'documents',
  PORTFOLIO: 'portfolio', WATCHLIST: 'watchlist',
});

/**
 * formatMissingEvidenceForPrompt - turns the coverage gaps into a short,
 * plain-language list the composer prompt can hand the model directly, so
 * an honest "I don't have X" statement is told to it explicitly rather
 * than left for the model to infer from evidence merely being sparse.
 * Item 8 ("prevent evidence/section mismatch... honest availability
 * statements") — deterministic, no LLM call.
 */
export const formatMissingEvidenceForPrompt = (missingEvidence = []) => missingEvidence
  .map((row) => {
    const label = DIMENSION_LABEL[row.dimension] || row.dimension;
    const phrase = STATUS_PHRASE[row.status] || 'unavailable';
    return row.symbol ? `${row.symbol} ${label}: ${phrase}` : `${label}: ${phrase}`;
  });

export default {
  EVIDENCE_COVERAGE_STATUS, computeEvidenceCoverage, DIMENSION_TOOLS, formatMissingEvidenceForPrompt,
  DIMENSION_CLAIM_TYPES, DIMENSION_LABEL,
};
