/**
 * modelPricing.js
 * =================
 * Phase 5B: the validated configuration module every LLM price in this
 * project comes from. Phase 5A kept the price table inline in
 * costEstimation.js; this splits the DATA (what a model costs, where that
 * figure came from, when it was last confirmed) from the ARITHMETIC (how a
 * call's cost is computed from it), so the table can be audited, validated,
 * and checked for staleness on its own.
 *
 * Three rules this module exists to enforce:
 *
 *   1. An unknown model NEVER receives an invented price. There is no
 *      fuzzy matching, no "strip the date suffix and hope", no default
 *      rate. A model is priced only if it is in the table or in the
 *      explicit alias map; otherwise `getPricing` returns null and the
 *      caller reports the cost as unknown.
 *   2. A malformed entry is DROPPED, not trusted. Validation runs once at
 *      module load; an entry that fails (missing/zero/negative rate,
 *      cached input dearer than fresh input, unknown field) is excluded
 *      from the usable table and logged. A dropped model then prices as
 *      unknown — the safe direction. Validation never throws, because a
 *      typo in a price must not stop the server from answering questions.
 *   3. The table dates itself. It is manually confirmed against the
 *      provider's published pricing, never auto-fetched, so it WILL drift.
 *      `getPricingMetadata()` reports its own age and whether it is stale,
 *      and the ops endpoint surfaces that — drift shows up as a visible
 *      staleness flag rather than as a silently wrong number.
 */
import { logger } from '../../utils/logger.js';

export const PRICING_CURRENCY = 'USD';

// Provenance. PRICING_SOURCE is where the figures were read from;
// PRICING_LAST_UPDATED is when a human last confirmed them against it. Both
// are recorded here rather than inferred, and this file's own git history —
// not a runtime timestamp — is the record of when they changed.
export const PRICING_SOURCE = 'OpenAI published API pricing (https://openai.com/api/pricing/), manually confirmed';
export const PRICING_VERSION = '2026-09-2';
export const PRICING_LAST_UPDATED = '2026-09-19';

// How long a manually-confirmed table is considered current. Past this, the
// metadata reports `stale: true` — not an error, and never a reason to stop
// pricing, just an honest "someone should re-confirm these."
export const PRICING_STALE_AFTER_DAYS = 180;

/**
 * Rates are $ per 1,000,000 tokens. `cachedInputPer1M` is the discounted
 * rate providers charge for a prompt prefix served from their own cache;
 * it is priced separately so a cached prompt is never billed as fresh
 * input (see costEstimation.js).
 */
const RAW_PRICING = {
  'gpt-4o-mini': { inputPer1M: 0.15, cachedInputPer1M: 0.075, outputPer1M: 0.60 },
  'gpt-4o': { inputPer1M: 2.50, cachedInputPer1M: 1.25, outputPer1M: 10.00 },
  'gpt-4.1-mini': { inputPer1M: 0.40, cachedInputPer1M: 0.10, outputPer1M: 1.60 },
  'gpt-4.1': { inputPer1M: 2.00, cachedInputPer1M: 0.50, outputPer1M: 8.00 },
};

/**
 * Explicit alias map: a dated/pinned model id a provider may return in a
 * response, mapped to the canonical entry it is priced as. Deliberately an
 * explicit list rather than a pattern — stripping a `-YYYY-MM-DD` suffix
 * automatically would silently price a genuinely NEW model at an OLD
 * model's rate, which is exactly the invented price this module forbids.
 * A pinned id not listed here prices as unknown, which is correct: nobody
 * has confirmed what it costs.
 */
const MODEL_ALIASES = {
  'gpt-4o-mini-2024-07-18': 'gpt-4o-mini',
  'gpt-4o-2024-08-06': 'gpt-4o',
  'gpt-4o-2024-11-20': 'gpt-4o',
  'gpt-4.1-mini-2025-04-14': 'gpt-4.1-mini',
  'gpt-4.1-2025-04-14': 'gpt-4.1',
};

const REQUIRED_RATE_FIELDS = ['inputPer1M', 'outputPer1M'];
const ALLOWED_RATE_FIELDS = new Set(['inputPer1M', 'outputPer1M', 'cachedInputPer1M']);

/**
 * validatePricingEntry - returns the list of reasons an entry is unusable.
 * An empty list means the entry is safe to price with.
 */
export const validatePricingEntry = (modelId, entry) => {
  const errors = [];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return [`${modelId}: pricing must be an object`];
  }

  for (const field of REQUIRED_RATE_FIELDS) {
    const value = entry[field];
    if (!Number.isFinite(value)) errors.push(`${modelId}: ${field} must be a finite number`);
    else if (value <= 0) errors.push(`${modelId}: ${field} must be greater than zero`);
  }

  if (entry.cachedInputPer1M !== undefined) {
    if (!Number.isFinite(entry.cachedInputPer1M) || entry.cachedInputPer1M < 0) {
      errors.push(`${modelId}: cachedInputPer1M must be a non-negative number`);
    } else if (Number.isFinite(entry.inputPer1M) && entry.cachedInputPer1M > entry.inputPer1M) {
      // A cached prompt costing MORE than an uncached one is always a typo,
      // and would make a cached call look more expensive than it is.
      errors.push(`${modelId}: cachedInputPer1M must not exceed inputPer1M`);
    }
  }

  for (const key of Object.keys(entry)) {
    if (!ALLOWED_RATE_FIELDS.has(key)) errors.push(`${modelId}: unknown pricing field "${key}"`);
  }

  return errors;
};

/**
 * validatePricingTable - validates every entry, returning the usable subset
 * plus every rejection reason. Pure: takes a table, returns a result. Never
 * throws and never mutates its input, so a test can validate a deliberately
 * broken table without touching the real one.
 */
export const validatePricingTable = (table = RAW_PRICING) => {
  const valid = {};
  const errors = [];

  for (const [modelId, entry] of Object.entries(table)) {
    const entryErrors = validatePricingEntry(modelId, entry);
    if (entryErrors.length) { errors.push(...entryErrors); continue; }
    valid[modelId] = Object.freeze({
      inputPer1M: entry.inputPer1M,
      outputPer1M: entry.outputPer1M,
      // A model whose provider publishes no cached rate is priced with
      // cached input at the full input rate — never at zero, which would
      // under-report a real cost.
      cachedInputPer1M: Number.isFinite(entry.cachedInputPer1M) ? entry.cachedInputPer1M : entry.inputPer1M,
    });
  }

  return { valid: Object.freeze(valid), errors };
};

/**
 * validateAliasMap - an alias pointing at a model that is not in the usable
 * table is unusable: resolving it would hand back a canonical id nothing
 * can price, or (worse, if the target were later renamed) the wrong price.
 */
export const validateAliasMap = (aliases = MODEL_ALIASES, table = RAW_PRICING) => {
  const valid = {};
  const errors = [];

  for (const [alias, canonical] of Object.entries(aliases)) {
    if (alias === canonical) { errors.push(`${alias}: alias points at itself`); continue; }
    if (!table[canonical]) { errors.push(`${alias}: points at "${canonical}", which is not a priced model`); continue; }
    if (table[alias]) { errors.push(`${alias}: is both a priced model and an alias`); continue; }
    valid[alias] = canonical;
  }

  return { valid: Object.freeze(valid), errors };
};

// Validated once, at module load. Anything rejected is logged loudly and
// then simply absent — callers see it as an unpriced model.
const tableResult = validatePricingTable(RAW_PRICING);
const aliasResult = validateAliasMap(MODEL_ALIASES, tableResult.valid);
export const PRICING_VALIDATION_ERRORS = Object.freeze([...tableResult.errors, ...aliasResult.errors]);

if (PRICING_VALIDATION_ERRORS.length) {
  logger.warn(`[model-pricing] ${PRICING_VALIDATION_ERRORS.length} pricing entr(ies) rejected and will price as UNKNOWN: ${PRICING_VALIDATION_ERRORS.join('; ')}`);
}

export const PRICING_TABLE = tableResult.valid;
export const PRICING_ALIASES = aliasResult.valid;

/**
 * resolveModelId - canonical id for a model string, or null when nothing in
 * this module knows it. Case-insensitive on the exact id only (providers
 * are consistent about case, but a config file may not be); never a partial
 * or prefix match.
 */
export const resolveModelId = (model) => {
  if (typeof model !== 'string' || !model) return null;
  const trimmed = model.trim();
  if (PRICING_TABLE[trimmed]) return trimmed;
  if (PRICING_ALIASES[trimmed]) return PRICING_ALIASES[trimmed];

  const lowered = trimmed.toLowerCase();
  if (PRICING_TABLE[lowered]) return lowered;
  if (PRICING_ALIASES[lowered]) return PRICING_ALIASES[lowered];

  return null;
};

/** getPricing - validated rates for a model (following aliases), or null when unknown. */
export const getPricing = (model) => {
  const canonical = resolveModelId(model);
  return canonical ? PRICING_TABLE[canonical] : null;
};

/** Whole days between the table's last-confirmed date and `now`. */
export const pricingAgeDays = (now = Date.now()) => {
  const confirmedAt = Date.parse(`${PRICING_LAST_UPDATED}T00:00:00Z`);
  if (!Number.isFinite(confirmedAt)) return null;
  return Math.floor((now - confirmedAt) / 86_400_000);
};

/** isPricingStale - past PRICING_STALE_AFTER_DAYS since a human last confirmed the table. */
export const isPricingStale = (now = Date.now()) => {
  const age = pricingAgeDays(now);
  return age === null ? true : age > PRICING_STALE_AFTER_DAYS;
};

/**
 * getPricingMetadata - everything an operator needs to judge whether a cost
 * figure can be trusted, with no rates in it (the ops endpoint reports this,
 * not the table itself).
 */
export const getPricingMetadata = (now = Date.now()) => ({
  source: PRICING_SOURCE,
  version: PRICING_VERSION,
  lastUpdated: PRICING_LAST_UPDATED,
  currency: PRICING_CURRENCY,
  pricedModelCount: Object.keys(PRICING_TABLE).length,
  aliasCount: Object.keys(PRICING_ALIASES).length,
  ageDays: pricingAgeDays(now),
  staleAfterDays: PRICING_STALE_AFTER_DAYS,
  stale: isPricingStale(now),
  validationErrorCount: PRICING_VALIDATION_ERRORS.length,
});

export default {
  PRICING_TABLE, PRICING_ALIASES, PRICING_SOURCE, PRICING_VERSION, PRICING_LAST_UPDATED, PRICING_CURRENCY,
  resolveModelId, getPricing, getPricingMetadata, isPricingStale, pricingAgeDays,
  validatePricingEntry, validatePricingTable, validateAliasMap,
};
