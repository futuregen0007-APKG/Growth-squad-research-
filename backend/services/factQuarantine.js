/**
 * factQuarantine.js
 * ====================
 * Phase 6B: semantic and dimensional screening for stored facts, with
 * QUARANTINE as a first-class outcome distinct from rejection.
 *
 * WHY QUARANTINE RATHER THAN CORRECTION. The corpus contains real
 * extraction mistakes — INFY `ORDER_BOOK = 3.2 USD_MILLION` is almost
 * certainly $3.2 BILLION, TCS `EPS = 29.64 INR_CRORE` is a per-share figure
 * wearing a total's unit. The tempting move is to "fix" them by inferring
 * the intended scale. That would be fabrication: we would be inventing a
 * number the source never stated, and the audit trail would show a figure
 * nobody published.
 *
 * So a suspicious fact is neither shown nor silently dropped. It is
 * QUARANTINED: excluded from answers, recorded with a machine-readable
 * reason, and counted so its coverage impact is visible in diagnostics. The
 * ORIGINAL stored record is never modified — this module is pure and
 * returns verdicts about facts, it does not write to them.
 *
 * Three screens, in order of confidence:
 *   1. CONTRACT   - the unit contradicts the metric outright
 *                   (a margin in crore). Already handled by
 *                   storedFundamentals.validateStoredFact; reused here so
 *                   one vocabulary covers both paths.
 *   2. DIMENSIONAL- the magnitude is impossible for the metric at this
 *                   scale (a revenue of 3 crore for a company whose PAT is
 *                   20,000 crore).
 *   3. SEMANTIC   - the label and the surrounding text disagree (a "level"
 *                   metric whose title describes a change).
 */
import { validateStoredFact, isDeltaFact } from './storedFundamentals.js';

const PERCENTAGE_LIKE_UNITS = new Set(['PERCENTAGE', 'PERCENT', 'PCT', '%']);
const LEVEL_ONLY_METRICS = new Set(['NIM', 'ROA', 'ROE', 'GNPA', 'NNPA', 'CASA', 'OPERATING_MARGIN', 'EBITDA_MARGIN']);

export const FACT_VERDICTS = Object.freeze({
  USABLE: 'USABLE',
  QUARANTINED: 'QUARANTINED',
  REJECTED: 'REJECTED',
});

export const QUARANTINE_REASONS = Object.freeze({
  SCALE_IMPLAUSIBLE: 'SCALE_IMPLAUSIBLE',
  UNIT_AMBIGUOUS: 'UNIT_AMBIGUOUS',
  LABEL_CONTRADICTS_TEXT: 'LABEL_CONTRADICTS_TEXT',
  OUTLIER_VS_PEER_PERIOD: 'OUTLIER_VS_PEER_PERIOD',
});

/**
 * Plausible magnitude bands, expressed in the metric's own reporting unit.
 * Deliberately WIDE: the job is to catch an order-of-magnitude error, not
 * to police a company's actual performance. A figure inside the band is
 * left alone even if it looks surprising.
 */
const MAGNITUDE_BANDS = Object.freeze({
  // Order book is reported in either currency; a listed company quoting an
  // order book of a few million dollars alongside revenues in the billions
  // is the classic scale slip (INFY 3.2 USD_MILLION for a ~$3.2bn book).
  ORDER_BOOK: { INR_CRORE: [100, 10_000_000], USD_MILLION: [100, 500_000] },
  REVENUE: { INR_CRORE: [10, 10_000_000], USD_MILLION: [10, 500_000] },
  PAT: { INR_CRORE: [-1_000_000, 10_000_000], USD_MILLION: [-100_000, 500_000] },
  EBITDA: { INR_CRORE: [-1_000_000, 10_000_000], USD_MILLION: [-100_000, 500_000] },
  DEPOSITS: { INR_CRORE: [100, 50_000_000] },
  LOAN_PORTFOLIO: { INR_CRORE: [100, 50_000_000] },
});

/** A per-share figure should look like one: single/double/triple digits, not thousands. */
const PER_SHARE_BAND = Object.freeze({ EPS: [-10_000, 10_000] });

/**
 * screenFact - one fact's verdict. Pure: takes a fact-like object, returns
 * { verdict, reason, detail }. Never mutates, never "repairs".
 *
 * `peerContext` is optional; when supplied it carries the same metric's
 * other observations (e.g. the same company's other periods) so a lone
 * value three orders of magnitude away from its own history can be caught.
 */
export const screenFact = ({ metric, value, unit, title, statement } = {}, peerContext = []) => {
  // 1. Contract: the unit flatly contradicts the metric.
  const contractFailure = validateStoredFact({ metric, value, unit });
  if (contractFailure) {
    return { verdict: FACT_VERDICTS.REJECTED, reason: contractFailure, detail: `${metric}=${value} ${unit || '(no unit)'}` };
  }

  // 2. Semantic: a title describing a MOVEMENT where the value could
  //    plausibly be that movement rather than a level.
  //
  //    Deliberately narrow. A title like "Revenue Growth in Q2" alongside a
  //    value of 58,229 INR_CRORE is a LEVEL reported under a growth-themed
  //    heading - quarantining it withheld 39 genuine TCS facts in testing,
  //    which is a real coverage cost for no safety gain. The ambiguity only
  //    bites when the value could itself BE the change: a percentage (a
  //    rate) or a metric that is only meaningful as a level.
  const unitIsRate = PERCENTAGE_LIKE_UNITS.has(String(unit || '').toUpperCase());
  const ambiguousAsDelta = unitIsRate || LEVEL_ONLY_METRICS.has(metric);
  if (ambiguousAsDelta && isDeltaFact(title) && !isDeltaFact(statement || '')) {
    return {
      verdict: FACT_VERDICTS.QUARANTINED,
      reason: QUARANTINE_REASONS.LABEL_CONTRADICTS_TEXT,
      detail: `title describes a change and the value is a rate, so it may be the change rather than the level: "${title}"`,
    };
  }

  // 3. Dimensional: impossible magnitude for this metric and unit.
  const normalizedUnit = String(unit || '').toUpperCase();
  const band = MAGNITUDE_BANDS[metric]?.[normalizedUnit];
  if (band && Number.isFinite(value)) {
    const [min, max] = band;
    if (value < min || value > max) {
      return {
        verdict: FACT_VERDICTS.QUARANTINED,
        reason: QUARANTINE_REASONS.SCALE_IMPLAUSIBLE,
        detail: `${metric}=${value} ${normalizedUnit} is outside the plausible band ${min}..${max}; likely a scale error, not corrected`,
      };
    }
  }

  const perShare = PER_SHARE_BAND[metric];
  if (perShare && Number.isFinite(value) && (value < perShare[0] || value > perShare[1])) {
    return {
      verdict: FACT_VERDICTS.QUARANTINED,
      reason: QUARANTINE_REASONS.SCALE_IMPLAUSIBLE,
      detail: `${metric}=${value} is not a plausible per-share amount`,
    };
  }

  // 4. Outlier against the company's own other observations of the SAME
  //    metric and unit. Three orders of magnitude apart is a scale slip, not
  //    a business result.
  const peers = peerContext
    .filter((p) => p && p.metric === metric && String(p.unit || '').toUpperCase() === normalizedUnit && Number.isFinite(p.value) && p.value !== 0)
    .map((p) => Math.abs(p.value));
  if (peers.length >= 2 && Number.isFinite(value) && value !== 0) {
    const median = [...peers].sort((a, b) => a - b)[Math.floor(peers.length / 2)];
    const ratio = Math.abs(value) > median ? Math.abs(value) / median : median / Math.abs(value);
    if (ratio >= 1000) {
      return {
        verdict: FACT_VERDICTS.QUARANTINED,
        reason: QUARANTINE_REASONS.OUTLIER_VS_PEER_PERIOD,
        detail: `${metric}=${value} ${normalizedUnit} differs from this company's own median (${median}) by ${Math.round(ratio)}x`,
      };
    }
  }

  return { verdict: FACT_VERDICTS.USABLE, reason: null, detail: null };
};

/**
 * screenFacts - screens a list and reports the coverage impact, so
 * diagnostics can say how much of a company's data is being withheld and
 * why rather than silently showing less.
 */
export const screenFacts = (facts = []) => {
  const usable = [];
  const quarantined = [];
  const rejected = [];

  for (const fact of facts) {
    const outcome = screenFact(fact, facts);
    const record = { ...fact, screen: outcome };
    if (outcome.verdict === FACT_VERDICTS.USABLE) usable.push(record);
    else if (outcome.verdict === FACT_VERDICTS.QUARANTINED) quarantined.push(record);
    else rejected.push(record);
  }

  const byReason = {};
  for (const record of [...quarantined, ...rejected]) {
    const key = record.screen.reason || 'UNKNOWN';
    byReason[key] = (byReason[key] || 0) + 1;
  }

  return {
    usable,
    quarantined,
    rejected,
    coverage: {
      total: facts.length,
      usable: usable.length,
      quarantined: quarantined.length,
      rejected: rejected.length,
      // What fraction of the company's facts we are declining to show.
      withheldRatio: facts.length ? Number(((quarantined.length + rejected.length) / facts.length).toFixed(3)) : 0,
      byReason,
    },
  };
};

export default { screenFact, screenFacts, FACT_VERDICTS, QUARANTINE_REASONS };
