/**
 * PromiseReviewGate.js
 * =====================
 * The deterministic evidence-review gate a promise candidate must pass before
 * it is promoted through the established review path (scripts/earningsReview.js
 * acceptCandidate, evidence status VERIFIED_EXCHANGE_COPY). Pure functions only
 * -- scripts/autoReviewCandidates.js does the I/O (database, exchange download).
 *
 * A candidate is ACCEPTED only when every check passes. Anything ambiguous is
 * KEPT_PENDING for a human, with the specific reason(s) recorded; nothing here
 * edits a target, a period, a value or an excerpt to make it pass.
 *
 *   1  extracted by v2 (precise metric, range upper bound, management speaker,
 *      excerpt checked verbatim and target value checked against the excerpt)
 *   2  a named, specific metric (not OTHER / unspecified margin)
 *   3  exchange-hosted source document (NSE / BSE)
 *   4  the excerpt re-found VERBATIM on the cited page of the re-downloaded
 *      exchange copy (done by the caller; passed in as `sourceCheck`)
 *   5  the target number(s) written in the excerpt, and a unit cue that agrees
 *   6  the metric named in the excerpt or the sentences just before it
 *   7  the target period grounded: an explicit fiscal year matching the target,
 *      or a relative phrase ("this year", "next year") that resolves to it
 *      from the publication date
 *   8  a FUTURE period at publication (a period already over is a result, not
 *      a promise) and no more than 5 fiscal years out
 *   9  not a question, not a hypothetical
 *  10  not a reiteration: within (company, metric, scope, period) the earliest
 *      statement is the original; a later SAME target is a reiteration (kept
 *      out, so it is never counted twice); a later DIFFERENT target is a
 *      revision (accepted, linked to what it revises).
 */

import { EXTRACTION_VERSION } from './PromiseExtractionService.js';

const DAY = 24 * 60 * 60 * 1000;

/** fiscalYearOf - Indian fiscal year (Apr-Mar) containing `date`, as its ending year (May 2023 -> 2024). */
export const fiscalYearOf = (date) => {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  return d.getUTCMonth() >= 3 ? d.getUTCFullYear() + 1 : d.getUTCFullYear();
};

const parseTargetPeriod = (period) => {
  const text = String(period || '').toUpperCase();
  const fy = text.match(/FY\s*(\d{4})/);
  if (!fy) return null;
  const quarter = text.match(/\bQ([1-4])\b/);
  const half = text.match(/\bH([12])\b/);
  return { fiscalYear: Number(fy[1]), quarter: quarter ? Number(quarter[1]) : null, half: half ? Number(half[1]) : null };
};

/** periodEndOf - last day of a target period (Indian fiscal calendar). */
export const periodEndOf = (period) => {
  const p = parseTargetPeriod(period);
  if (!p) return null;
  const endOfMonth = (y, m) => new Date(Date.UTC(y, m + 1, 0));
  if (p.quarter) return [null, endOfMonth(p.fiscalYear - 1, 5), endOfMonth(p.fiscalYear - 1, 8), endOfMonth(p.fiscalYear - 1, 11), endOfMonth(p.fiscalYear, 2)][p.quarter];
  if (p.half) return p.half === 1 ? endOfMonth(p.fiscalYear - 1, 8) : endOfMonth(p.fiscalYear, 2);
  return endOfMonth(p.fiscalYear, 2);
};

// The words a statement must contain (in the excerpt or just before it) for its metric to be grounded.
const METRIC_CUES = {
  REVENUE: /\b(revenue|top[- ]?line|sales|turnover|income from operations)\b/i,
  REVENUE_GROWTH: /\b(revenue|top[- ]?line|sales|turnover)\b/i,
  PAT: /\b(profit|pat|bottom[- ]?line|net income|earnings)\b/i,
  PAT_GROWTH: /\b(profit|pat|bottom[- ]?line|net income|earnings)\b/i,
  PAT_MARGIN: /\b(net (profit )?margin|pat margin)\b/i,
  EPS: /\b(eps|earnings per share)\b/i,
  EBITDA: /\bebitda\b/i,
  EBITDA_MARGIN: /\bebitda\b/i,
  EBIT_MARGIN: /\b(ebit\b|operating margin|operating profit margin)/i,
  OPERATING_MARGIN: /\b(operating margin|operating profit margin|ebit\b)/i,
  GROSS_MARGIN: /\bgross margin/i,
  TAX_RATE: /\btax\b/i,
  ORDER_BOOK: /\b(order ?book|backlog)\b/i,
  ORDER_INTAKE: /\b(order (inflow|intake|booking)s?|inflows?|orders)\b/i,
  BOOKINGS: /\b(tcv|bookings?|deal wins?)\b/i,
  LARGE_DEALS: /\b(large deals?|tcv)\b/i,
  ARR: /\b(arr|annual recurring)\b/i,
  CAPEX: /\b(capex|capital expenditure|capital spend|investment)\b/i,
  CAPACITY: /\b(capacity|mw|gw|mtpa|tonnes?|tons?)\b/i,
  VOLUME: /\b(volumes?|tonnes?|tons?|units)\b/i,
  DEBT: /\b(debt|borrowings?)\b/i,
  NET_DEBT: /\bnet debt\b/i,
  FREE_CASH_FLOW: /\b(free cash ?flow|fcf)\b/i,
  OPERATING_CASH_FLOW: /\b(operating cash ?flow|cash from operations|ocf)\b/i,
  WORKING_CAPITAL_DAYS: /\b(working capital|days)\b/i,
  ROE: /\b(roe|return on equity)\b/i,
  ROA: /\b(roa|return on assets)\b/i,
  ROCE: /\b(roce|return on capital)\b/i,
  NIM: /\b(nim|net interest margin|margins?)\b/i,
  CREDIT_GROWTH: /\b(credit|loans?|advances|loan book|book growth)\b/i,
  LOAN_GROWTH: /\b(loans?|advances|loan book)\b/i,
  DEPOSIT_GROWTH: /\bdeposits?\b/i,
  CASA: /\bcasa\b/i,
  GNPA: /\b(gnpa|gross npa|gross non[- ]performing)\b/i,
  NNPA: /\b(nnpa|net npa|net non[- ]performing)\b/i,
  CREDIT_COST: /\bcredit costs?\b/i,
  COST_TO_INCOME: /\bcost[- ]to[- ]income|cost income\b/i,
  AUM_GROWTH: /\b(aum|assets under management)\b/i,
  PREMIUM_GROWTH: /\b(premium|ape|gwp|gdpi)\b/i,
  VNB_MARGIN: /\b(vnb|value of new business)\b/i,
  ATTRITION: /\battrition\b/i,
  EMPLOYEE_COUNT: /\b(hire|hiring|headcount|employees|freshers?|graduates|recruit)/i,
  CUSTOMER_COUNT: /\b(customers?|clients?|subscribers?|users)\b/i,
  MARKET_SHARE: /\bmarket share\b/i,
  EXPORT_REVENUE: /\bexports?\b/i,
  DIVIDEND_PAYOUT: /\b(dividend|payout)\b/i,
};

const UNIT_CUES = {
  PERCENT: /%|\bper ?cent\b|\bpercentage\b/i,
  INR_CRORE: /\b(crores?|cr\b|crs\b)|₹|\brs\.?\b|\binr\b/i,
  INR_LAKH: /\b(lakhs?|lacs?)\b/i,
  USD_MILLION: /\$|\busd\b|\bdollars?\b|\bmillion\b|\bmn\b/i,
  USD_BILLION: /\$|\busd\b|\bdollars?\b|\bbillion\b|\bbn\b/i,
};
// A plain count is only meaningful for these metrics (a launch count, headcount, a number of deals...).
const COUNT_METRICS = new Set(['EMPLOYEE_COUNT', 'CUSTOMER_COUNT', 'LARGE_DEALS', 'PRODUCT_LAUNCH']);

const HYPOTHETICAL = /\b(if we assume|assuming|suppose|let'?s say|for example|for instance|hypothetically)\b/i;
// A compound rate or a cumulative amount over several years is not a single-period target.
const MULTI_YEAR = /\bcagr\b|\bcompounded\b|\bcumulative(ly)?\b|\bin total\b|\bover the next\b|\bnext (two|three|four|five|2|3|4|5) years\b|\bover (two|three|four|five|2|3|4|5) years\b/i;
// Words that put a company-scope target in doubt: a figure for one part of the business is never
// compared with a company-wide filing. (Banks: corporate / retail / SME books are segments.)
const SEGMENT_WORDS = /\b(segments?|divisions?|verticals?|subsidiar(y|ies)|business units?|domestic|international|overseas|export(s)?)\b/i;
const BANK_BOOK_WORDS = /\b(corporate|retail|sme|msme|agri|agricultural|home loans?|unsecured|wholesale)\b/i;
const BANK_BOOK_METRICS = new Set(['CREDIT_GROWTH', 'LOAN_GROWTH', 'DEPOSIT_GROWTH', 'CREDIT_COST', 'GNPA', 'NNPA']);
const RELATIVE_THIS = /\b(this|current|the current|ongoing|present) (fiscal|financial year|year|fy)\b|\bthis fiscal\b|\bfull[- ]year\b|\bfor the year\b/i;
const RELATIVE_NEXT = /\b(next|coming|following|subsequent) (fiscal|financial year|year|fy)\b|\bnext fiscal\b/i;

/** explicitFiscalYears - every fiscal year written in `text` (FY26, FY'26, FY2026, 2025-26, fiscal '27, fiscal 2027). */
export const explicitFiscalYears = (text) => {
  const years = new Set();
  const s = String(text || '');
  for (const m of s.matchAll(/\bFY\s*'?\s*(\d{4}|\d{2})\b/gi)) years.add(m[1].length === 2 ? 2000 + Number(m[1]) : Number(m[1]));
  for (const m of s.matchAll(/\bfiscal(?: year)?\s*'?\s*(\d{4}|\d{2})\b/gi)) years.add(m[1].length === 2 ? 2000 + Number(m[1]) : Number(m[1]));
  for (const m of s.matchAll(/\b(20\d{2})\s*[-–/]\s*'?(\d{2,4})\b/g)) {
    const end = m[2].length === 2 ? 2000 + Number(m[2]) : Number(m[2]);
    if (end === Number(m[1]) + 1) years.add(end);
  }
  return [...years];
};

/**
 * checkPeriodGrounding - pure. Is the target period actually stated (or
 * unambiguously implied) by the words around the target? Returns { ok, reason }.
 */
export const checkPeriodGrounding = ({ targetPeriod, excerpt, context = '', publicationDate }) => {
  const target = parseTargetPeriod(targetPeriod);
  if (!target) return { ok: false, reason: `target period "${targetPeriod}" is not a fiscal period` };
  const near = `${context} ${excerpt}`;
  const explicitInExcerpt = explicitFiscalYears(excerpt);
  if (explicitInExcerpt.length) {
    return explicitInExcerpt.includes(target.fiscalYear)
      ? { ok: true, reason: null }
      : { ok: false, reason: `the excerpt names FY${explicitInExcerpt.join('/FY')}, not the extracted FY${target.fiscalYear}` };
  }
  const pubFy = fiscalYearOf(publicationDate);
  if (RELATIVE_NEXT.test(excerpt)) {
    return pubFy && target.fiscalYear === pubFy + 1 ? { ok: true, reason: null } : { ok: false, reason: `"next year" from a ${String(publicationDate).slice(0, 10)} filing is FY${pubFy + 1}, not FY${target.fiscalYear}` };
  }
  if (RELATIVE_THIS.test(excerpt)) {
    return pubFy && target.fiscalYear === pubFy ? { ok: true, reason: null } : { ok: false, reason: `"this year" from a ${String(publicationDate).slice(0, 10)} filing is FY${pubFy}, not FY${target.fiscalYear}` };
  }
  const explicitNear = explicitFiscalYears(near);
  if (explicitNear.length === 1 && explicitNear[0] === target.fiscalYear) return { ok: true, reason: null };
  return { ok: false, reason: 'the target period is not stated in the statement (no fiscal year or "this/next year" in it)' };
};

/**
 * preCheck - pure. Every check that needs no network. Returns the list of
 * reasons a candidate cannot be accepted (empty = passes these checks).
 */
export const preCheck = (candidate) => {
  const reasons = [];
  const promise = candidate.promise || {};
  const evidence = candidate.promiseEvidence || {};
  const excerpt = String(evidence.excerpt || promise.originalExcerpt || '');
  const metric = String(promise.metric || '').toUpperCase();

  if (candidate.extractionVersion !== EXTRACTION_VERSION) {
    reasons.push('LEGACY_V1: extracted before the precise-metric / speaker / number checks; superseded by the v2 re-extraction of the same document');
    return reasons; // nothing else about a v1 record can be trusted enough to evaluate
  }
  if (!metric || ['OTHER', 'OTHER_QUANTIFIABLE'].includes(metric)) reasons.push('METRIC_UNIDENTIFIED: the metric is not a named, specific measure');
  if (metric === 'MARGIN') reasons.push('MARGIN_TYPE_UNSTATED: the speaker did not say which margin (gross, EBITDA, EBIT, net)');
  if (promise.speaker && promise.speaker !== 'MANAGEMENT') reasons.push(`SPEAKER: stated by ${promise.speaker}, not management`);
  if (!/^https?:\/\/([a-z0-9-]+\.)*(nseindia\.com|bseindia\.com)\//i.test(String(evidence.sourceUrl || ''))) reasons.push('SOURCE_NOT_EXCHANGE: the source is not an NSE/BSE-hosted filing');
  if (/\?/.test(excerpt)) reasons.push('QUESTION: the excerpt is a question');
  if (HYPOTHETICAL.test(excerpt)) reasons.push('HYPOTHETICAL: the excerpt is an assumption or example, not a target');
  if (MULTI_YEAR.test(excerpt)) reasons.push('MULTI_YEAR: a compound or cumulative target over several years, not a single-period target');
  if ((promise.scope || 'COMPANY') === 'COMPANY') {
    if (SEGMENT_WORDS.test(excerpt)) reasons.push('SCOPE_AMBIGUOUS: the statement mentions a segment, region or subsidiary, so it may not be company-wide');
    else if (BANK_BOOK_METRICS.has(metric) && BANK_BOOK_WORDS.test(excerpt)) reasons.push('SCOPE_AMBIGUOUS: the statement names one loan book (corporate / retail / SME ...), not the whole bank');
  }

  const unit = String(promise.targetUnit || '').toUpperCase();
  if (unit === 'COUNT' && !COUNT_METRICS.has(metric)) reasons.push(`UNIT: a plain count is not a meaningful unit for ${metric}`);
  else if (unit === 'OTHER' || !unit) reasons.push('UNIT: a non-standard unit (e.g. MW, tonnes) that is not recorded');
  else if (UNIT_CUES[unit] && !UNIT_CUES[unit].test(excerpt)) reasons.push(`UNIT: the excerpt has no ${unit === 'PERCENT' ? '%' : unit.toLowerCase().replace('_', ' ')} wording for the value`);

  const pub = new Date(promise.promiseDate || evidence.publishedAt);
  const end = periodEndOf(promise.targetPeriod);
  if (!end) reasons.push(`PERIOD: "${promise.targetPeriod}" is not a fiscal period`);
  else if (!Number.isNaN(pub.getTime())) {
    if (end.getTime() <= pub.getTime()) reasons.push(`PAST_PERIOD: ${promise.targetPeriod} had already ended when this was said (${promise.promiseDate}) -- a result, not a promise`);
    if (end.getTime() - pub.getTime() > 6 * 366 * DAY) reasons.push(`HORIZON: ${promise.targetPeriod} is more than five years after the statement`);
  }
  return reasons;
};

/**
 * contentCheck - pure. Checks that need the verified page text: the excerpt
 * was found verbatim (sourceCheck.found), and the metric and period are
 * grounded in the excerpt or the text just before it (sourceCheck.context).
 */
export const contentCheck = (candidate, sourceCheck) => {
  const reasons = [];
  const promise = candidate.promise || {};
  const excerpt = String(candidate.promiseEvidence?.excerpt || '');
  if (!sourceCheck) return ['SOURCE_UNVERIFIED: the exchange copy was not checked'];
  if (sourceCheck.error) return [`SOURCE_UNAVAILABLE: ${sourceCheck.error}`];
  if (!sourceCheck.found) return [`EXCERPT_NOT_FOUND: the excerpt is not on page ${candidate.promiseEvidence?.pageNumber} of the exchange copy`];
  const metric = String(promise.metric || '').toUpperCase();
  const cue = METRIC_CUES[metric];
  if (cue && !cue.test(excerpt) && !cue.test(sourceCheck.context || '')) reasons.push(`METRIC_NOT_STATED: neither the excerpt nor the sentences before it name ${metric.toLowerCase().replace(/_/g, ' ')}`);
  const period = checkPeriodGrounding({ targetPeriod: promise.targetPeriod, excerpt, context: sourceCheck.context, publicationDate: promise.promiseDate });
  if (!period.ok) reasons.push(`PERIOD_NOT_GROUNDED: ${period.reason}`);
  return reasons;
};

const targetKey = (r) => `${r.promise.operator}|${r.promise.targetValue}|${r.promise.targetValueMax ?? ''}|${r.promise.targetUnit}`;
export const groupKeyOf = (r) => [r.symbol, String(r.promise.metric || '').toUpperCase(), r.promise.scope || 'COMPANY', r.promise.segment || '', String(r.promise.targetPeriod || '').toUpperCase()].join('|');

/**
 * decideGroups - pure. `passing` are candidates that passed every individual
 * check; `published` are records already public for those companies (curated
 * JSON / previously accepted). Within each (company, metric, scope, period):
 *   - the earliest statement not already published is the ORIGINAL -> ACCEPTED
 *   - a later statement of the SAME target -> REITERATION of the latest
 *     version (not accepted, so it is never counted twice)
 *   - a later DIFFERENT target -> REVISION -> ACCEPTED with revisesPromiseId
 *   - two DIFFERENT targets on the SAME day -> both KEPT_PENDING (conflict)
 * Returns Map<candidate id, { decision, reasons, revisesPromiseId, reiterationOf, groupKey }>.
 */
export const decideGroups = (passing, published = []) => {
  const groups = new Map();
  const add = (r, isPublished) => {
    const key = groupKeyOf(r);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ r, isPublished });
  };
  for (const r of published) if (r?.promise?.metric) add(r, true);
  for (const r of passing) add(r, false);

  const decisions = new Map();
  for (const [key, members] of groups) {
    members.sort((a, b) => String(a.r.promise.promiseDate).localeCompare(String(b.r.promise.promiseDate)) || Number(b.isPublished) - Number(a.isPublished) || String(a.r.id).localeCompare(String(b.r.id)));
    // Same-day conflicts: different targets stated on one date cannot be ordered -> leave for a human.
    const byDate = new Map();
    for (const m of members) {
      const d = String(m.r.promise.promiseDate);
      if (!byDate.has(d)) byDate.set(d, new Set());
      byDate.get(d).add(targetKey(m.r));
    }
    let latest = null; // the current live version of this target
    for (const m of members) {
      const conflict = byDate.get(String(m.r.promise.promiseDate)).size > 1;
      if (m.isPublished) { latest = m.r; continue; }
      if (conflict) {
        decisions.set(m.r.id, { decision: 'KEPT_PENDING', reasons: [`SAME_DAY_CONFLICT: different targets for the same metric and period were stated on ${m.r.promise.promiseDate}`], groupKey: key });
        continue;
      }
      if (latest && targetKey(latest) === targetKey(m.r)) {
        decisions.set(m.r.id, { decision: 'REITERATION', reasons: [`REITERATION: restates ${latest.id} (same target), so it is not counted again`], reiterationOf: latest.id, groupKey: key });
        continue;
      }
      decisions.set(m.r.id, { decision: 'ACCEPTED', reasons: [], revisesPromiseId: latest ? latest.id : null, groupKey: key });
      latest = m.r;
    }
  }
  return decisions;
};

export default {
  fiscalYearOf, periodEndOf, explicitFiscalYears, checkPeriodGrounding, preCheck, contentCheck, decideGroups, groupKeyOf,
};
