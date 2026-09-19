/**
 * earningsIntelligenceValidation.js
 * ==================================
 * Business-rule validators for the curated Earnings Intelligence dataset
 * (backend/data/earnings-intelligence/**). These sit alongside, not instead
 * of, the descriptive JSON Schemas in data/earnings-intelligence/schemas/ --
 * the schemas document the shape; this module enforces the shape PLUS the
 * cross-cutting integrity rules a JSON Schema can't express on its own
 * (domain allowlisting, unit compatibility, cross-company checks, dataset-wide
 * duplicate-id detection).
 *
 * Every function here is pure and side-effect free so it can run safely from
 * the CLI scripts, the runtime service, and tests alike.
 */

export const PROMISE_CATEGORIES = [
  'REVENUE_GROWTH', 'MARGIN', 'ORDER_BOOK', 'CAPEX', 'DEBT_REDUCTION',
  'PROFITABILITY', 'LOAN_GROWTH', 'DEPOSIT_GROWTH', 'ASSET_QUALITY',
  'GUIDANCE', 'PRODUCT_LAUNCH', 'EXPANSION', 'OTHER',
];

export const OUTCOME_STATUSES = ['ACHIEVED', 'PARTIAL', 'MISSED', 'PENDING', 'INSUFFICIENT_EVIDENCE'];
export const RESOLVED_STATUSES = ['ACHIEVED', 'PARTIAL', 'MISSED'];

export const PROMISE_OPERATORS = ['AT_LEAST', 'AT_MOST', 'EXACT', 'RANGE', 'QUALITATIVE'];
export const TARGET_TYPES = ['PERCENTAGE', 'ABSOLUTE', 'QUALITATIVE'];
export const TARGET_UNITS = ['PERCENT', 'INR_CRORE', 'INR_LAKH', 'USD_MILLION', 'USD_BILLION', 'COUNT'];

export const EVIDENCE_SOURCE_TYPES = [
  'ANNUAL_REPORT', 'FINANCIAL_RESULTS', 'EARNINGS_PRESENTATION',
  'EARNINGS_TRANSCRIPT', 'EXCHANGE_FILING', 'PRESS_RELEASE',
];

export const DATA_MODES = ['CURATED_VERIFIED', 'DEMO_SYNTHETIC', 'RESEARCH_PENDING'];
export const COVERAGE_STATUSES = ['COMPLETE', 'PARTIAL', 'RESEARCH_PENDING', 'STALE'];

/**
 * Phase 4F: Earnings Evidence Integrity Audit
 * ==============================================
 * A record's `evidenceIntegrity` (optional additive field, both on curated
 * JSON records and on ManagementPromise Mongo documents) is the outcome of
 * auditing its promise/outcome evidence against the REAL, locally
 * re-verifiable primary source -- never a re-statement of `verification`
 * (which only records who/when a human curated the record, not whether
 * the underlying PDF text was actually re-checked against it this audit).
 *
 *   VERIFIED_PRIMARY      - the source is the company's own official IR
 *                            domain, and the exact claim was re-confirmed
 *                            against real, locally re-fetched/stored text.
 *   VERIFIED_EXCHANGE_COPY - the source is an official BSE/NSE exchange
 *                            corporate-filing archive hosting the exact
 *                            same regulatorily-disclosed document, and the
 *                            exact claim was re-confirmed against real,
 *                            locally re-fetched/stored text.
 *   SOURCE_UNAVAILABLE    - the cited URL could not be fetched through any
 *                            currently-supported legitimate channel (a
 *                            company IR domain blocking automated fetching,
 *                            or a BSE/NSE path that no longer resolves) --
 *                            this alone is NEVER treated as verification.
 *   PROVENANCE_INCOMPLETE - the document is reachable/registered but page
 *                            or chunk-level provenance could not be
 *                            resolved (e.g. no page number was ever
 *                            recorded, or the document was registered but
 *                            never durably chunked).
 *   CLAIM_NOT_FOUND       - the source was fetched, but the claimed
 *                            excerpt/claim does not appear on the cited
 *                            page (or anywhere in the document).
 *   VALUE_MISMATCH        - the claimed metric/value/unit does not match
 *                            what the real source text actually states.
 *   PERIOD_MISMATCH       - the claimed target/actual period does not
 *                            match what the real source text actually
 *                            states.
 *   UNSUPPORTED           - the source itself fails the domain/authority
 *                            bar (not an official IR or exchange-filing
 *                            domain -- e.g. a news aggregator or blog),
 *                            regardless of whether the claim is accurate.
 *   QUARANTINED           - the terminal, public-facing state: this
 *                            record must never appear in any public
 *                            timeline/score/evidence-envelope output. A
 *                            record becomes QUARANTINED for any of the
 *                            failure reasons above; the specific
 *                            underlying reason is preserved in
 *                            `evidenceIntegrity.notes`, never discarded.
 *
 * Only VERIFIED_PRIMARY and VERIFIED_EXCHANGE_COPY are "public safe" --
 * every other status (including simply never having been audited at all,
 * for the curated JSON dataset specifically -- see
 * CuratedEarningsIntelligenceService.js's isPubliclyVisibleRecord) means a
 * record does not appear publicly.
 */
export const EVIDENCE_INTEGRITY_STATUSES = [
  'VERIFIED_PRIMARY', 'VERIFIED_EXCHANGE_COPY', 'SOURCE_UNAVAILABLE', 'PROVENANCE_INCOMPLETE',
  'CLAIM_NOT_FOUND', 'VALUE_MISMATCH', 'PERIOD_MISMATCH', 'UNSUPPORTED', 'QUARANTINED',
];

export const PUBLIC_SAFE_EVIDENCE_STATUSES = ['VERIFIED_PRIMARY', 'VERIFIED_EXCHANGE_COPY'];

/**
 * isPubliclyVisibleRecord - the ONE gate every public-facing consumer of a
 * CURATED JSON record must apply (Task 4: "No grandfathering -- existing
 * JSON does not prove correctness"). Fails CLOSED: a record with no
 * evidenceIntegrity field at all (never audited) is NOT publicly visible,
 * exactly the same as one explicitly marked QUARANTINED/UNSUPPORTED/etc.
 * This is deliberately stricter than isPubliclyVisiblePromise below (which
 * governs the much broader, cross-symbol live-research ManagementPromise
 * collection and fails OPEN for an absent field) -- the curated JSON
 * dataset is small, hand-authored, and every record in it has now been
 * explicitly audited, so there is no legitimate reason for a real one to
 * be missing this field going forward.
 */
export const isPubliclyVisibleRecord = (record) => Boolean(
  record?.evidenceIntegrity?.status && PUBLIC_SAFE_EVIDENCE_STATUSES.includes(record.evidenceIntegrity.status),
);

/**
 * isPubliclyVisiblePromise - the gate for a ManagementPromise Mongo
 * document (the live-research, cross-symbol collection the real grounded-
 * RAG `getEarningsTimeline` tool reads). Fails OPEN: a document with no
 * evidenceIntegrity field is treated as publicly visible (preserving
 * existing behavior for the many symbols never touched by this Phase 4F
 * audit, which is scoped to TCS -- see the task's own "do not proceed to
 * broader company expansion" instruction); only a document EXPLICITLY
 * marked with a non-public-safe status is excluded.
 */
export const isPubliclyVisiblePromise = (doc) => {
  const status = doc?.evidenceIntegrity?.status;
  if (!status) return true;
  return PUBLIC_SAFE_EVIDENCE_STATUSES.includes(status);
};

// Evidence source priority, per Step 4 of the curated-research plan (higher = preferred).
export const SOURCE_TYPE_PRIORITY = {
  ANNUAL_REPORT: 5,
  FINANCIAL_RESULTS: 4,
  EARNINGS_PRESENTATION: 3,
  EARNINGS_TRANSCRIPT: 2,
  EXCHANGE_FILING: 1,
  PRESS_RELEASE: 1,
};

// Domains that are never acceptable as evidence for a CURATED_VERIFIED record:
// social media, blogs/aggregators, stock-tip sites, and generic news/search
// result mirrors. This mirrors (and is kept in sync in spirit with) the
// blocklist already used for the company source registry.
const BLOCKED_EVIDENCE_DOMAINS = [
  'moneycontrol.com', 'groww.in', 'screener.in', 'economictimes.indiatimes.com',
  'livemint.com', 'business-standard.com', 'ndtv.com', 'reuters.com', 'bloomberg.com',
  'zerodha.com', 'medium.com', 'blogspot.com', 'wordpress.com', 'reddit.com',
  'twitter.com', 'x.com', 'facebook.com', 'quora.com', 'youtube.com', 'linkedin.com',
  'wikipedia.org', 'investing.com', 'yahoo.com', 'tradingview.com', 'trendlyne.com',
  'stockmirror.in', 'alphaspread.com', 'quartr.com',
];

const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;

const isIsoDate = (value) => {
  if (!isNonEmptyString(value)) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime());
};

export const isValidEvidenceUrl = (url) => {
  if (!isNonEmptyString(url)) return false;
  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const hostname = parsed.hostname.toLowerCase();
  return !BLOCKED_EVIDENCE_DOMAINS.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
};

/** Unit families that CAN be safely compared/converted; INR and USD are never cross-converted (no FX rate assumed). */
const UNIT_CONVERSION_TO_BASE = {
  PERCENT: { family: 'PERCENT', factor: 1 },
  COUNT: { family: 'COUNT', factor: 1 },
  INR_CRORE: { family: 'INR', factor: 1 },
  INR_LAKH: { family: 'INR', factor: 0.01 },
  USD_MILLION: { family: 'USD', factor: 1 },
  USD_BILLION: { family: 'USD', factor: 1000 },
};

export const areUnitsCompatible = (unitA, unitB) => {
  if (!unitA || !unitB) return true; // nothing to compare
  const a = UNIT_CONVERSION_TO_BASE[unitA];
  const b = UNIT_CONVERSION_TO_BASE[unitB];
  if (!a || !b) return false;
  return a.family === b.family;
};

const evidenceSchema = (evidence, { path, required }) => {
  const errors = [];
  if (!evidence) {
    if (required) errors.push(`${path}: evidence is required`);
    return errors;
  }
  if (!isNonEmptyString(evidence.sourceTitle)) errors.push(`${path}.sourceTitle: required non-empty string`);
  if (!EVIDENCE_SOURCE_TYPES.includes(evidence.sourceType)) errors.push(`${path}.sourceType: must be one of ${EVIDENCE_SOURCE_TYPES.join(', ')}`);
  if (!isValidEvidenceUrl(evidence.sourceUrl)) errors.push(`${path}.sourceUrl: must be an HTTP(S) URL on an approved primary-source domain, not "${evidence.sourceUrl}"`);
  if (!isIsoDate(evidence.publishedAt)) errors.push(`${path}.publishedAt: must be an ISO date (YYYY-MM-DD)`);
  if (evidence.pageNumber != null && (!Number.isInteger(evidence.pageNumber) || evidence.pageNumber < 1)) {
    errors.push(`${path}.pageNumber: must be a positive integer or null`);
  }
  if (!isNonEmptyString(evidence.excerpt)) errors.push(`${path}.excerpt: required non-empty string`);
  return errors;
};

/**
 * Validates one management-promise record. `context.symbol` is the symbol the
 * record was loaded from (i.e. the promises/<SYMBOL>.json filename) -- used to
 * catch a record that claims a different company than the file it lives in.
 */
export const validateManagementPromiseRecord = (record, context = {}) => {
  const errors = [];
  const warnings = [];
  const { symbol: fileSymbol, allowDemo = false } = context;

  if (!record || typeof record !== 'object') {
    return { valid: false, errors: ['record is missing or not an object'], warnings };
  }

  if (!isNonEmptyString(record.id)) errors.push('id: required non-empty string');
  if (!isNonEmptyString(record.symbol)) errors.push('symbol: required non-empty string');

  if (fileSymbol && record.symbol && record.symbol !== fileSymbol) {
    errors.push(`symbol: record declares "${record.symbol}" but was loaded from the ${fileSymbol} dataset file (cross-company record rejected)`);
  }
  if (record.id && record.symbol && !record.id.startsWith(`${record.symbol}-`)) {
    errors.push(`id: "${record.id}" does not start with "${record.symbol}-" (id must belong to its own company)`);
  }

  if (!DATA_MODES.includes(record.dataMode) || record.dataMode === 'RESEARCH_PENDING') {
    errors.push(`dataMode: must be CURATED_VERIFIED or DEMO_SYNTHETIC (got "${record.dataMode}")`);
  }
  if (record.dataMode === 'DEMO_SYNTHETIC' && !allowDemo) {
    warnings.push('dataMode: DEMO_SYNTHETIC record present -- will be excluded unless demo mode is explicitly enabled');
  }

  const promise = record.promise || {};
  if (!isNonEmptyString(promise.statement)) errors.push('promise.statement: required non-empty string');
  if (!PROMISE_CATEGORIES.includes(promise.category)) errors.push(`promise.category: must be one of ${PROMISE_CATEGORIES.join(', ')}`);
  if (!isIsoDate(promise.promiseDate)) errors.push('promise.promiseDate: must be an ISO date (YYYY-MM-DD)');
  if (!isNonEmptyString(promise.targetPeriod)) errors.push('promise.targetPeriod: required non-empty string (e.g. "FY2026")');
  if (!TARGET_TYPES.includes(promise.targetType)) errors.push(`promise.targetType: must be one of ${TARGET_TYPES.join(', ')}`);
  if (!PROMISE_OPERATORS.includes(promise.operator)) errors.push(`promise.operator: must be one of ${PROMISE_OPERATORS.join(', ')}`);
  if (promise.targetUnit != null && !TARGET_UNITS.includes(promise.targetUnit)) errors.push(`promise.targetUnit: must be one of ${TARGET_UNITS.join(', ')} or null`);
  if (promise.targetValue != null && typeof promise.targetValue !== 'number') errors.push('promise.targetValue: must be a number or null');

  const outcome = record.outcome || {};
  if (!OUTCOME_STATUSES.includes(outcome.status)) errors.push(`outcome.status: must be one of ${OUTCOME_STATUSES.join(', ')}`);
  if (outcome.actualUnit != null && !TARGET_UNITS.includes(outcome.actualUnit)) errors.push(`outcome.actualUnit: must be one of ${TARGET_UNITS.join(', ')} or null`);
  if (outcome.evaluationDate != null && !isIsoDate(outcome.evaluationDate)) errors.push('outcome.evaluationDate: must be an ISO date or null');
  if (isIsoDate(promise.promiseDate) && isIsoDate(outcome.evaluationDate) && new Date(outcome.evaluationDate) < new Date(promise.promiseDate)) {
    errors.push('outcome.evaluationDate: cannot be earlier than promise.promiseDate (invalid period ordering)');
  }
  if (!areUnitsCompatible(promise.targetUnit, outcome.actualUnit)) {
    errors.push(`outcome.actualUnit: "${outcome.actualUnit}" is not compatible with promise.targetUnit "${promise.targetUnit}"`);
  }

  errors.push(...evidenceSchema(record.promiseEvidence, { path: 'promiseEvidence', required: true }));

  const isResolved = RESOLVED_STATUSES.includes(outcome.status);
  if (isResolved) {
    errors.push(...evidenceSchema(record.outcomeEvidence, { path: 'outcomeEvidence', required: true }));
  } else if (record.outcomeEvidence) {
    errors.push(...evidenceSchema(record.outcomeEvidence, { path: 'outcomeEvidence', required: false }));
  }

  const verification = record.verification || {};
  if (!isIsoDate(verification.verifiedAt)) errors.push('verification.verifiedAt: must be an ISO date');
  if (!isNonEmptyString(verification.verifiedBy)) errors.push('verification.verifiedBy: required non-empty string');
  if (typeof verification.evidenceConfidence !== 'number' || verification.evidenceConfidence < 0 || verification.evidenceConfidence > 1) {
    errors.push('verification.evidenceConfidence: must be a number between 0 and 1');
  }

  return { valid: errors.length === 0, errors, warnings };
};

/** Validates one companies.json coverage entry. */
export const validateCuratedCompanyRecord = (record) => {
  const errors = [];
  const warnings = [];

  if (!record || typeof record !== 'object') {
    return { valid: false, errors: ['record is missing or not an object'], warnings };
  }

  if (!isNonEmptyString(record.symbol)) errors.push('symbol: required non-empty string');
  if (!isNonEmptyString(record.companyName)) errors.push('companyName: required non-empty string');
  if (!isNonEmptyString(record.sector)) errors.push('sector: required non-empty string');
  if (!DATA_MODES.includes(record.dataMode)) errors.push(`dataMode: must be one of ${DATA_MODES.join(', ')}`);
  if (!COVERAGE_STATUSES.includes(record.coverageStatus)) errors.push(`coverageStatus: must be one of ${COVERAGE_STATUSES.join(', ')}`);

  for (const field of ['coverageStart', 'coverageEnd', 'lastVerifiedAt', 'nextReviewAfter']) {
    if (record[field] != null && !isIsoDate(record[field])) errors.push(`${field}: must be an ISO date (YYYY-MM-DD) or null`);
  }
  for (const field of ['verifiedPromiseCount', 'resolvedPromiseCount', 'pendingPromiseCount']) {
    if (record[field] != null && (!Number.isInteger(record[field]) || record[field] < 0)) {
      errors.push(`${field}: must be a non-negative integer`);
    }
  }
  if (Number.isInteger(record.resolvedPromiseCount) && Number.isInteger(record.verifiedPromiseCount) && record.resolvedPromiseCount > record.verifiedPromiseCount) {
    errors.push('resolvedPromiseCount cannot exceed verifiedPromiseCount');
  }
  if (record.dataMode === 'RESEARCH_PENDING' && record.coverageStatus !== 'RESEARCH_PENDING') {
    warnings.push('dataMode is RESEARCH_PENDING but coverageStatus is not -- these are normally kept in sync');
  }
  if (record.coverageStatus === 'COMPLETE' && Number.isInteger(record.resolvedPromiseCount) && record.resolvedPromiseCount < 3) {
    warnings.push('coverageStatus is COMPLETE with fewer than 3 resolved promises -- a public Faith Score will still be null; consider PARTIAL instead');
  }

  return { valid: errors.length === 0, errors, warnings };
};

export const CANDIDATE_REVIEW_STATUSES = ['PENDING_REVIEW', 'ACCEPTED', 'REJECTED'];

/**
 * Validates one automated candidate record (backend/data/earnings-intelligence/
 * candidates/<SYMBOL>.json). A candidate is structurally a full, valid
 * managementPromiseRecord (same schema, same evidence/unit/cross-company
 * rules) plus a `reviewStatus` field -- reusing validateManagementPromiseRecord
 * wholesale means a candidate can never be promoted (or even generated) with
 * a shape that the real validator would reject, and there is only one place
 * evidence/unit/domain rules are enforced.
 */
export const validateCandidatePromiseRecord = (record, context = {}) => {
  const core = validateManagementPromiseRecord(record, context);
  const errors = [...core.errors];
  const warnings = [...core.warnings];
  if (!CANDIDATE_REVIEW_STATUSES.includes(record?.reviewStatus)) {
    errors.push(`reviewStatus: must be one of ${CANDIDATE_REVIEW_STATUSES.join(', ')}`);
  }
  return { valid: errors.length === 0, errors, warnings };
};

/** Dataset-wide duplicate-id detection across every loaded promise record. */
export const findDuplicatePromiseIds = (allRecords = []) => {
  const seen = new Map();
  const duplicates = [];
  for (const record of allRecords) {
    const id = record?.id;
    if (!id) continue;
    if (seen.has(id)) {
      duplicates.push({ id, symbols: [seen.get(id), record.symbol] });
    } else {
      seen.set(id, record.symbol);
    }
  }
  return duplicates;
};

export default {
  PROMISE_CATEGORIES,
  OUTCOME_STATUSES,
  RESOLVED_STATUSES,
  PROMISE_OPERATORS,
  TARGET_TYPES,
  TARGET_UNITS,
  EVIDENCE_SOURCE_TYPES,
  DATA_MODES,
  COVERAGE_STATUSES,
  SOURCE_TYPE_PRIORITY,
  isValidEvidenceUrl,
  areUnitsCompatible,
  validateManagementPromiseRecord,
  validateCuratedCompanyRecord,
  validateCandidatePromiseRecord,
  CANDIDATE_REVIEW_STATUSES,
  findDuplicatePromiseIds,
  EVIDENCE_INTEGRITY_STATUSES,
  PUBLIC_SAFE_EVIDENCE_STATUSES,
  isPubliclyVisibleRecord,
  isPubliclyVisiblePromise,
};
