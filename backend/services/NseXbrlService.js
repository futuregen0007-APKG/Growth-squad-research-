/**
 * NseXbrlService.js
 * ===================
 * Pure (no I/O) helpers for reading figures out of the XBRL result filings
 * NSE publishes, and for choosing which filings to read. Split out of
 * scripts/collectNseXbrlFundamentals.js so they are testable without a
 * database, a network, or that script's top-level side effects.
 *
 * WHY PERIOD-AWARE. A results filing repeats each tag once per reporting
 * period it carries. A Q4 filing, for example, holds the March quarter AND the
 * full year for revenue. Each occurrence names a `contextRef`, and that
 * context stands for a period. The figure for a filing's own period is the
 * occurrence whose context spans exactly that period, with no segment
 * dimension attached. Anything else (a year-to-date column, a prior-year
 * comparative, a per-segment breakdown) is a different number and is never
 * substituted. If no context matches, there is no fact: nothing is guessed.
 *
 * A context's period comes from its declaration, or, for older filings that
 * reference "OneD"/"FourD" without declaring them, from the period the filing
 * itself states for that context (see parseXbrlContexts).
 *
 * Verified against real NSE filings: for HINDUNILVR FY2022 the four quarterly
 * revenue figures summed exactly to the Q4 filing's own full-year figure.
 */

/** Rupees -> crore. A restatement of the same figure, recorded in provenance. */
export const RUPEES_PER_CRORE = 10_000_000;

// A browser-shaped User-Agent is required by NSE's public API for any
// client; this is the documented way to call it, not a circumvention of an
// access control. A request that is refused stays refused.
export const NSE_REQUEST_HEADERS = Object.freeze({
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  Referer: 'https://www.nseindia.com/',
});

/**
 * The XBRL tags read, and the metric each maps to. Only these are extracted:
 * an unmapped tag is ignored rather than guessed at.
 */
export const TAG_MAP = Object.freeze([
  { tag: 'RevenueFromOperations', metric: 'REVENUE', scale: 'RUPEES', label: 'Revenue from operations' },
  { tag: 'ProfitLossForPeriod', metric: 'PAT', scale: 'RUPEES', label: 'Profit for the period' },
  { tag: 'ProfitBeforeTax', metric: 'PROFIT_BEFORE_TAX', scale: 'RUPEES', label: 'Profit before tax' },
  { tag: 'BasicEarningsLossPerShare', metric: 'EPS', scale: 'PER_SHARE', label: 'Basic earnings per share' },
  { tag: 'OtherIncome', metric: 'OTHER_INCOME', scale: 'RUPEES', label: 'Other income' },
  { tag: 'EmployeeBenefitExpense', metric: 'EMPLOYEE_COST', scale: 'RUPEES', label: 'Employee benefit expense' },

  // Fallbacks: the same concept under the vocabulary other filing formats use
  // (checked live: banks file `Income` / `ProfitLossForThePeriod`; corporates
  // and NBFCs file EPS under the "...FromContinuingAndDiscontinuedOperations"
  // tag). Each is used ONLY for a metric the primary tag did not produce for
  // that filing, so a metric is never reported twice, and the tag actually
  // read is named in the fact's label and provenance.
  { tag: 'Income', metric: 'REVENUE', scale: 'RUPEES', label: 'Total income', fallback: true },
  { tag: 'ProfitLossForThePeriod', metric: 'PAT', scale: 'RUPEES', label: 'Profit for the period', fallback: true },
  { tag: 'BasicEarningsLossPerShareFromContinuingAndDiscontinuedOperations', metric: 'EPS', scale: 'PER_SHARE', label: 'Basic earnings per share', fallback: true },
  { tag: 'BasicEarningsPerShareAfterExtraordinaryItems', metric: 'EPS', scale: 'PER_SHARE', label: 'Basic earnings per share', fallback: true },

  // Insurers file the shareholders' result under these names (checked live on
  // SBI Life's FY2026 filing: PAT 804.6 crore, and total `Income` reconciles to
  // premium plus investment income). No other filing format uses them.
  { tag: 'ProfitLossAfterTaxAndExtraordinaryItems', metric: 'PAT', scale: 'RUPEES', label: 'Profit after tax', fallback: true },
  { tag: 'ProfitLossBeforeTax', metric: 'PROFIT_BEFORE_TAX', scale: 'RUPEES', label: 'Profit before tax', fallback: true },
  { tag: 'BasicAndDilutedEPSAfterExtraordinaryItemsNetOfTaxExpenseForThePeriodNotToBeAnnualized', metric: 'EPS', scale: 'PER_SHARE', label: 'Basic and diluted earnings per share', fallback: true },
]);

/** Every tag a stored fact of this metric may legitimately have been read from. */
export const tagsForMetric = (metric) => TAG_MAP.filter((m) => m.metric === metric).map((m) => m.tag);

/**
 * Supported symbols whose NSE trading symbol differs (renames). Each pair was
 * confirmed against NSE's own company name for that symbol (Sep 2026). TATAMOTORS
 * is deliberately absent: it demerged, TMCV has no results filings yet and TMPV
 * holds the old entity's history, so mapping it would be a guess.
 */
export const NSE_SYMBOL_ALIASES = Object.freeze({
  ZOMATO: 'ETERNAL',
  REC: 'RECLTD',
  MAXFIN: 'MFSL',
  AMARAJABAT: 'ARE&M',
  'UNO MINDA': 'UNOMINDA',
  CEAT: 'CEATLTD',
  HPCL: 'HINDPETRO',
  KALPATPOWR: 'KPIL',
  SUMITOMOIND: 'SUMICHEM',
  PBFINTECH: 'POLICYBZR',
  INFOEDGE: 'NAUKRI',
  GMRINFRA: 'GMRAIRPORT',
  // Confirmed 2026-09-28 against BSE/NSE corporate-filing PDFs and the
  // companies' own stock-exchange intimation letters (see the matching,
  // more fully-sourced comment on SCRIP_ID_OVERRIDES in
  // BseScripMasterProvider.js) -- not the earlier "unresolved" state noted
  // there before that date.
  LTIM: 'LTM',
  GUJGASLTD: 'GUJENERGY',
});

/** The symbol NSE knows a supported company by. */
export const nseSymbolFor = (symbol) => NSE_SYMBOL_ALIASES[symbol] || symbol;

const MONTHS = Object.freeze({ jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 });

/**
 * Reads one tag's first value. Retained for callers that only need "any
 * occurrence"; fact extraction uses readTagForPeriod, because the first
 * occurrence is not guaranteed to be the filing's own period.
 */
export const readTag = (xml, tag) => {
  const match = xml.match(new RegExp(`<[^>]*\\b${tag}\\b[^>]*>([^<]+)<`, 'i'));
  if (!match) return null;
  const value = Number(String(match[1]).trim());
  return Number.isFinite(value) ? value : null;
};

/**
 * parseNseDate - NSE publishes "30-Jan-2025 15:37:17", which Date cannot
 * parse natively. Parsed explicitly rather than coerced, so a filing date is
 * either right or absent - never silently "now".
 */
export const parseNseDate = (value) => {
  const match = String(value || '').match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!match) return null;
  const [, day, monthName, year, hour = '0', minute = '0', second = '0'] = match;
  const month = MONTHS[monthName.toLowerCase()];
  if (month === undefined) return null;
  const date = new Date(Date.UTC(Number(year), month, Number(day), Number(hour), Number(minute), Number(second)));
  return Number.isNaN(date.getTime()) ? null : date;
};

const isoDay = (date) => (date ? date.toISOString().slice(0, 10) : null);

const MONTH_LABELS = Object.freeze(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);

/** A UTC date written the way NSE writes it ("01-Jan-2026"); the inverse of parseNseDate for a whole day. */
export const toNseDateString = (date) => `${String(date.getUTCDate()).padStart(2, '0')}-${MONTH_LABELS[date.getUTCMonth()]}-${date.getUTCFullYear()}`;

/**
 * integratedRowToRecord - maps one row of NSE's Integrated Filing (Financials)
 * feed (`/api/integrated-filing-results`, which is current where the legacy
 * `corporates-financial-results` index stops at the quarter ended 2024-12-31)
 * onto the record shape the rest of this service reads.
 *
 * The feed gives the quarter END (`qe_Date`, e.g. "31-MAR-2026") but no start.
 * A results filing is for one quarter, so the start is the first day of the
 * month two before the end month. That is only a claim about which context to
 * look for: a figure is still stored only if the filing's own XBRL carries a
 * context spanning exactly that period, so a wrong guess yields no fact, never
 * a wrong one. Rows with no XBRL link, or an end date that is not a month end,
 * are refused (null).
 */
export const integratedRowToRecord = (row) => {
  const end = parseNseDate(row?.qe_Date);
  if (!end || !row?.xbrl) return null;
  if (new Date(end.getTime() + 86_400_000).getUTCDate() !== 1) return null;
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 2, 1));
  return {
    symbol: row.symbol,
    companyName: row.cmName || row.smName || row.symbol,
    fromDate: toNseDateString(start),
    toDate: toNseDateString(end),
    relatingTo: null,
    consolidated: row.consolidated,
    audited: row.audited,
    // A revision has no broadcast date; its revision date is when it superseded the original.
    filingDate: row.revised_Date || row.broadcast_Date || row.creation_Date || null,
    cumulative: null,
    xbrl: row.xbrl,
    feed: 'INTEGRATED_FILING',
    filingKind: row.type_Sub || null,
  };
};

/** "01-Oct-2024".."31-Dec-2024" + "Third Quarter" -> "Q3 FY2025" (Indian FY ends 31 Mar). */
export const toReportingPeriod = ({ fromDate, toDate, relatingTo }) => {
  const end = parseNseDate(toDate);
  if (!end) return null;
  const month = end.getUTCMonth();
  const fiscalYear = month >= 3 ? end.getUTCFullYear() + 1 : end.getUTCFullYear();
  const quarterByName = { 'First Quarter': 1, 'Second Quarter': 2, 'Third Quarter': 3, 'Fourth Quarter': 4 };
  const calendarQuarter = Math.floor(((month + 9) % 12) / 3) + 1;
  const namedQuarter = quarterByName[relatingTo];
  // A company whose own fiscal year does not run April-March numbers its quarters differently (checked live:
  // ABB India and VBL historically reported January-December, Siemens India October-September, each moving
  // to the standard April-March year only in its Integrated Filings from FY2025 -- e.g. ABB's own filing
  // states financialYear "01-Jan-2022 To 31-Dec-2022" while NSE's relatingTo says "First Quarter" for a
  // filing whose dates are 01-Jan-2022..31-Mar-2022). Every other part of this system (the coverage window,
  // quarter-sum corroboration, the annual snapshot) assumes the standard April-March grid, so a filing whose
  // own relatingTo disagrees with the quarter its calendar dates imply under that grid cannot be safely
  // placed on it -- refused rather than mislabeled (this exact mismatch was found stored as "Q1 FY2022" for
  // a Jan-Mar filing, which under the April-March convention this system uses everywhere else is Q4 FY2022).
  if (namedQuarter !== undefined && namedQuarter !== calendarQuarter) return null;
  const quarter = calendarQuarter;
  const start = parseNseDate(fromDate);
  const spansYear = start && (end - start) > 300 * 86_400_000;
  return spansYear ? `FY${fiscalYear}` : `Q${quarter} FY${fiscalYear}`;
};

/** The fiscal year a reporting period belongs to ("Q3 FY2025" -> 2025), or null. */
export const fiscalYearOfPeriod = (period) => {
  const match = String(period || '').match(/FY(\d{4})/);
  return match ? Number(match[1]) : null;
};

/** The calendar range a period label covers, as ISO dates: "Q4 FY2022" -> 2022-01-01..2022-03-31, "FY2022" -> 2021-04-01..2022-03-31. */
export const periodRange = (period) => {
  const fy = fiscalYearOfPeriod(period);
  if (fy == null) return null;
  const quarter = String(period).match(/^Q([1-4])\b/);
  if (!quarter) return { start: `${fy - 1}-04-01`, end: `${fy}-03-31` };
  return {
    1: { start: `${fy - 1}-04-01`, end: `${fy - 1}-06-30` },
    2: { start: `${fy - 1}-07-01`, end: `${fy - 1}-09-30` },
    3: { start: `${fy - 1}-10-01`, end: `${fy - 1}-12-31` },
    4: { start: `${fy}-01-01`, end: `${fy}-03-31` },
  }[Number(quarter[1])];
};

/**
 * The period each context stands for according to the filing's OWN statements
 * (DateOfStartOfReportingPeriod / DateOfEndOfReportingPeriod facts), whatever
 * the context declarations say: contextRef -> { start, end }.
 */
export const parseStatedPeriods = (xml) => {
  const stated = new Map();
  for (const [field, key] of [['DateOfStartOfReportingPeriod', 'start'], ['DateOfEndOfReportingPeriod', 'end']]) {
    const pattern = new RegExp(`<[^>]*\\b${field}\\b[^>]*\\bcontextRef="([^"]+)"[^>]*>\\s*(\\d{4}-\\d{2}-\\d{2})\\s*<`, 'g');
    for (const match of String(xml).matchAll(pattern)) {
      stated.set(match[1], { ...(stated.get(match[1]) || {}), [key]: match[2] });
    }
  }
  return new Map([...stated].filter(([, period]) => period.start && period.end));
};

/**
 * findTagByStatedPeriod - like findTagForPeriod, but trusts only what the
 * filing states about each context's period, ignoring declarations that
 * disagree with it. Used solely by the verifier to corroborate a full-year
 * figure (where the quarters must then sum to it), never to store a fact.
 */
export const findTagByStatedPeriod = (xml, tag, { start, end }) => {
  const stated = parseStatedPeriods(xml);
  for (const match of String(xml).matchAll(new RegExp(`<[^>]*\\b${tag}\\b[^>]*>([^<]+)<`, 'gi'))) {
    const contextRef = match[0].match(/\bcontextRef="([^"]+)"/)?.[1];
    const period = contextRef ? stated.get(contextRef) : null;
    if (!period || period.start !== start || period.end !== end) continue;
    const value = Number(String(match[1]).trim());
    if (Number.isFinite(value)) return { value, contextRef, source: 'STATED' };
  }
  return null;
};

/**
 * The reporting period each context stands for: id -> { start, end,
 * dimensioned, source, conflict? }.
 *
 * Declared `<xbrli:context>` elements are authoritative. Older exchange
 * filings reference their main contexts ("OneD", "FourD") without declaring
 * them, but every filing STATES its own periods as facts
 * (DateOfStartOfReportingPeriod / DateOfEndOfReportingPeriod, one pair per
 * context). Where a context is not declared, that stated period is used
 * (source 'STATED'). If both exist and disagree, the context is marked
 * `conflict` and is never used. A context with neither is unknown and yields
 * no figure.
 */
export const parseXbrlContexts = (xml) => {
  const document = String(xml);
  const contexts = new Map();
  for (const match of document.matchAll(/<(?:xbrli:)?context\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/(?:xbrli:)?context>/g)) {
    const body = match[2];
    contexts.set(match[1], {
      start: body.match(/<(?:xbrli:)?startDate>\s*([^<\s]+)\s*</)?.[1] || null,
      end: body.match(/<(?:xbrli:)?endDate>\s*([^<\s]+)\s*</)?.[1] || null,
      dimensioned: /dimension="|<xbrldi:/.test(body),
      source: 'DECLARED',
    });
  }

  const stated = parseStatedPeriods(document);
  for (const [id, period] of stated) {
    if (!period.start || !period.end) continue;
    const declared = contexts.get(id);
    if (!declared) contexts.set(id, { start: period.start, end: period.end, dimensioned: false, source: 'STATED' });
    else if (declared.start !== period.start || declared.end !== period.end) declared.conflict = true;
  }
  return contexts;
};

/**
 * findTagForPeriod - the occurrence of `tag` whose context spans exactly
 * [start, end] and carries no dimension. Returns { value, contextRef, source }
 * or null.
 */
export const findTagForPeriod = (xml, tag, { start, end }, contexts = parseXbrlContexts(xml)) => {
  if (!start || !end) return null;
  for (const match of String(xml).matchAll(new RegExp(`<[^>]*\\b${tag}\\b[^>]*>([^<]+)<`, 'gi'))) {
    const contextRef = match[0].match(/\bcontextRef="([^"]+)"/)?.[1];
    const context = contextRef ? contexts.get(contextRef) : null;
    if (!context || context.dimensioned || context.conflict || context.start !== start || context.end !== end) continue;
    const value = Number(String(match[1]).trim());
    if (Number.isFinite(value)) return { value, contextRef, source: context.source };
  }
  return null;
};

export const readTagForPeriod = (xml, tag, range, contexts) => findTagForPeriod(xml, tag, range, contexts)?.value ?? null;

/** contextSource of a full-year figure read through the period a filing STATES where its declared context says otherwise. */
export const STATED_OVER_DECLARED = 'STATED_OVER_DECLARED';

/**
 * Builds the facts for ONE period (a quarter or a full year) from a filing,
 * each read from the context spanning exactly [start, end]. A metric with no
 * such context yields nothing.
 */
const buildFactsForPeriod = (xml, record, {
  period, start, end, contexts, filedAt, allowStated = false,
}) => {
  const facts = [];

  for (const mapping of TAG_MAP) {
    if (mapping.fallback && facts.some((f) => f.metric === mapping.metric)) continue;
    // A context the filing declares with different dates than it states is refused above; with allowStated the
    // period the filing STATES is used instead, and the fact is marked so it is kept only if corroborated.
    let found = findTagForPeriod(xml, mapping.tag, { start, end }, contexts);
    if (!found && allowStated) {
      const stated = findTagByStatedPeriod(xml, mapping.tag, { start, end });
      // Marked distinctly from a context that is merely undeclared (source STATED, accepted as before): this one
      // overrides a declaration the filing itself contradicts, so it must be corroborated before it is kept.
      if (stated) found = { ...stated, source: STATED_OVER_DECLARED };
    }
    if (!found) continue;

    const isPerShare = mapping.scale === 'PER_SHARE';
    const value = isPerShare ? found.value : Number((found.value / RUPEES_PER_CRORE).toFixed(2));
    const unit = isPerShare ? 'INR' : 'INR_CRORE';

    facts.push({
      symbol: record.symbol,
      companyName: record.companyName,
      period,
      metric: mapping.metric,
      value,
      unit,
      filedAt,
      consolidated: record.consolidated,
      audited: record.audited,
      sourceUrl: record.xbrl,
      label: mapping.label,
      // Exactly how this number was obtained, for audit.
      extraction: {
        method: 'NSE_XBRL_TAG',
        tag: mapping.tag,
        contextRef: found.contextRef,
        contextSource: found.source,
        periodStart: start,
        periodEnd: end,
        originalValue: found.value,
        originalUnit: isPerShare ? 'INR_PER_SHARE' : 'INR',
        conversion: isPerShare ? 'none' : `INR / ${RUPEES_PER_CRORE} = INR_CRORE`,
        retrievedAt: new Date().toISOString(),
      },
    });
  }
  return facts;
};

/**
 * Builds the facts one filing yields. The filing's own quarter always; and,
 * for a March-quarter (Q4) filing, the full fiscal year too, because a Q4
 * filing also carries the year-to-date figures, which for that filing are the
 * whole year. The year is read only if the filing declares a context spanning
 * exactly April 1 to March 31 (and does not contradict it), so a filing whose
 * year context is missing or mislabelled yields quarter facts only.
 * Returns [] when the period is unreadable or no tag has a matching context.
 */
export const extractFactsFromFiling = (xml, record, { includeFullYear = true, allowStatedFullYear = false } = {}) => {
  const period = toReportingPeriod(record);
  const start = isoDay(parseNseDate(record.fromDate));
  const end = isoDay(parseNseDate(record.toDate));
  if (!period || !start || !end) return [];

  const filedAt = parseNseDate(record.filingDate) || parseNseDate(record.broadCastDate) || parseNseDate(record.toDate) || new Date();
  const contexts = parseXbrlContexts(xml);
  const facts = buildFactsForPeriod(xml, record, {
    period, start, end, contexts, filedAt,
  });

  const fiscalYear = fiscalYearOfPeriod(period);
  if (includeFullYear && fiscalYear && /^Q4 FY/.test(period) && end === `${fiscalYear}-03-31`) {
    facts.push(...buildFactsForPeriod(xml, record, {
      period: `FY${fiscalYear}`, start: `${fiscalYear - 1}-04-01`, end, contexts, filedAt, allowStated: allowStatedFullYear,
    }));
  }
  return facts;
};

const QUARTER_PERIOD = /^Q([1-4]) FY(\d{4})$/;
/** Standalone and Non-Consolidated are the same basis under the two feeds' names. */
export const basisKey = (label) => (/non-?consolidated|standalone/i.test(String(label || '')) ? 'STANDALONE' : /consolidated/i.test(String(label || '')) ? 'CONSOLIDATED' : 'UNKNOWN');

/**
 * factBasisFilter - a Mongo filter fragment that matches only a stored fact
 * for the SAME basis as `consolidatedLabel` ("Consolidated" / "Standalone" /
 * "Non-Consolidated", as toFactDocument writes it verbatim into the fact's
 * narrative sentence -- there is no separate basis field on the model).
 * Required in every query that finds-or-upserts an NSE XBRL fact by
 * {symbol, period, metric} alone: that triple is NOT unique on its own (a
 * company can file both a Consolidated and a Standalone result for the same
 * period), so a query without this would let a Standalone figure silently
 * overwrite a Consolidated one (or vice versa) under the same stored document.
 */
export const factBasisFilter = (consolidatedLabel) => ({
  fact: new RegExp(`\\(${String(consolidatedLabel || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')},`),
});
/** Additive across quarters, so four quarters can be summed against the year. Per-share and ratio figures are not. */
export const ADDITIVE_METRICS = Object.freeze(['REVENUE', 'PAT']);

/** checkQuarterSums - pure. Four quarterly figures must add up to the full-year figure (crore), within rounding. */
export const checkQuarterSums = (quarterValues, fullYearValue) => {
  const sum = Number(quarterValues.reduce((s, v) => s + v, 0).toFixed(2));
  const tolerance = Math.max(0.5, Math.abs(fullYearValue) * 0.001);
  return {
    status: Math.abs(sum - fullYearValue) <= tolerance ? 'SUM_MATCH' : 'SUM_MISMATCH', sum, fullYear: fullYearValue, difference: Number((sum - fullYearValue).toFixed(2)),
  };
};

/**
 * corroborateStatedFullYear - pure. Some filings (checked live: many March
 * 2023 and March 2024 results) DECLARE their year-to-date context with the
 * quarter's dates while STATING the true full-year period. Those year figures
 * come back from extractFactsFromFiling marked contextSource STATED_OVER_DECLARED.
 *
 * Corroboration is decided PER METRIC, never by group membership: a revenue
 * figure that sums correctly against its quarters does NOT vouch for PAT, EPS,
 * or any other metric read from the very same context (a real defect found and
 * fixed this session -- the first version accepted every metric in a filing
 * once ANY additive metric in it passed the sum check, which silently stored
 * unverified EPS/PROFIT_BEFORE_TAX/OTHER_INCOME/EMPLOYEE_COST figures on the
 * strength of an unrelated REVENUE match). A non-additive metric (anything
 * outside ADDITIVE_METRICS -- EPS and every ratio/margin) has no quarter-sum
 * check at all and is therefore NEVER kept via this path, whatever the other
 * metrics in the same filing corroborate to.
 *
 * `facts` are this run's facts; `storedQuarters` are quarter facts already in
 * the database as { period, metric, value, consolidated, tag }. Returns
 * { facts, rejected }: `facts` is everything to store, `rejected` names each
 * withheld (fiscalYear, basis, metric) and why.
 */
export const corroborateStatedFullYear = (facts, storedQuarters = []) => {
  const isStatedYear = (f) => /^FY\d{4}$/.test(f.period) && f.extraction?.contextSource === STATED_OVER_DECLARED;
  const kept = facts.filter((f) => !isStatedYear(f));
  const statedYears = facts.filter(isStatedYear);
  if (!statedYears.length) return { facts, rejected: [] };

  // This run's quarters come first: a filing read now supersedes what is stored.
  const quarterPool = [
    ...facts.filter((f) => QUARTER_PERIOD.test(f.period)).map((f) => ({
      period: f.period, metric: f.metric, value: f.value, consolidated: f.consolidated, tag: f.extraction?.tag,
    })),
    ...storedQuarters,
  ];

  const accepted = [];
  const rejected = [];
  for (const fact of statedYears) {
    const fiscalYear = fact.period;
    const basis = basisKey(fact.consolidated);
    if (!ADDITIVE_METRICS.includes(fact.metric)) {
      rejected.push({
        fiscalYear, basis, metric: fact.metric, reason: `${fact.metric} cannot be corroborated by quarter-sum (only ${ADDITIVE_METRICS.join('/')} are additive across quarters); a stated-but-undeclared annual context is not trusted for it`,
      });
      continue;
    }
    const quarters = [1, 2, 3, 4].map((q) => quarterPool.find((p) => p.period === `Q${q} ${fiscalYear}` && p.metric === fact.metric
      && basisKey(p.consolidated) === basis && p.tag === fact.extraction.tag));
    if (quarters.some((q) => !q)) {
      rejected.push({ fiscalYear, basis, metric: fact.metric, reason: 'no complete quarter set on the same basis and tag to corroborate the stated year' });
      continue;
    }
    const check = checkQuarterSums(quarters.map((q) => q.value), fact.value);
    if (check.status !== 'SUM_MATCH') {
      rejected.push({
        fiscalYear, basis, metric: fact.metric, reason: 'the four quarters do not sum to the stated year', failures: [{ metric: fact.metric, ...check }],
      });
      continue;
    }
    fact.extraction = { ...fact.extraction, corroboration: { method: 'QUARTER_SUM', evidence: [{ metric: fact.metric, ...check }] } };
    accepted.push(fact);
  }
  return { facts: [...kept, ...accepted], rejected };
};

/** A row's XBRL link is real only if it points at an .xml file; NSE lists a bare "-" (and similar) for filings with none. */
export const hasXbrlLink = (row) => /^https?:\/\/\S+\.xml$/i.test(String(row?.xbrl || ''));

/**
 * selectFilings - which filings from an NSE results index to read.
 *
 * Only non-cumulative (single-period) filings are read: a cumulative filing
 * reports a year-to-date span whose dates would not match the quarter it is
 * labelled with. One filing per period and basis, newest filing winning (a
 * restated result supersedes the original). With preferConsolidated, a period
 * keeps its consolidated filing and only falls back to standalone when there
 * is no consolidated one, so a period is never reported twice. Newest periods
 * come first; periods before `fromYear` are dropped; at most `maxFilings` are
 * kept.
 */
export const selectFilings = (index, {
  symbol = null, fromYear = null, toYear = null, maxFilings = 12, preferConsolidated = false,
} = {}) => {
  const time = (value) => parseNseDate(value)?.getTime() || 0;
  const newestFirst = (index || [])
    .filter((r) => hasXbrlLink(r) && (!symbol || r.symbol === symbol) && !/^cumulative$/i.test(String(r.cumulative || '')))
    .sort((a, b) => time(b.filingDate) - time(a.filingDate));

  const byKey = new Map();
  for (const filing of newestFirst) {
    const period = toReportingPeriod(filing);
    if (!period) continue;
    const key = `${period}|${filing.consolidated}`;
    if (!byKey.has(key)) byKey.set(key, { filing, period });
  }

  let chosen = [...byKey.values()];
  if (preferConsolidated) {
    const perPeriod = new Map();
    for (const entry of chosen) {
      const held = perPeriod.get(entry.period);
      if (!held || (entry.filing.consolidated === 'Consolidated' && held.filing.consolidated !== 'Consolidated')) perPeriod.set(entry.period, entry);
    }
    chosen = [...perPeriod.values()];
  }

  return chosen
    .filter((entry) => fromYear == null || (fiscalYearOfPeriod(entry.period) ?? 0) >= fromYear)
    .filter((entry) => toYear == null || (fiscalYearOfPeriod(entry.period) ?? Infinity) <= toYear)
    .sort((a, b) => time(b.filing.toDate) - time(a.filing.toDate))
    .slice(0, maxFilings)
    .map((entry) => entry.filing);
};

/**
 * olderVersionsOf - the other single-period filings for the same company,
 * period and basis as `filing`, newest first. selectFilings keeps only the
 * newest (a revision supersedes its original); this is the fallback when that
 * newest file turns out not to carry the statements, so a period is not lost
 * to a revision that only re-filed a cover page.
 */
export const olderVersionsOf = (index, filing) => {
  const time = (value) => parseNseDate(value)?.getTime() || 0;
  const period = toReportingPeriod(filing);
  return (index || [])
    .filter((r) => r !== filing && hasXbrlLink(r) && r.symbol === filing.symbol && r.consolidated === filing.consolidated
      && !/^cumulative$/i.test(String(r.cumulative || '')) && toReportingPeriod(r) === period)
    .sort((a, b) => time(b.filingDate) - time(a.filingDate));
};

/**
 * deriveJobOutcome - the ResearchJob status and reason to record after one
 * company's XBRL run, so an interrupted batch can resume from the database
 * alone and a later reader can tell "nothing exists" from "not tried yet".
 */
export const deriveJobOutcome = ({
  indexError = null, filings = 0, factsStored = 0, coveredYears = 0, expectedYears, latestPeriod = null, attempt = 1, maxAttempts = 3,
}) => {
  if (indexError) {
    return { status: attempt >= maxAttempts ? 'FAILED_PERMANENT' : 'FAILED_RETRYABLE', lastError: `NSE results feeds unavailable: ${indexError}` };
  }
  if (filings === 0) return { status: 'FAILED_PERMANENT', lastError: 'NSE\'s legacy results index and integrated filing feed have no XBRL filings for this symbol in the requested fiscal years' };
  if (coveredYears >= expectedYears) return { status: 'COMPLETED', lastError: null };
  if (coveredYears > 0) {
    return { status: 'PARTIAL', lastError: `Covered ${coveredYears}/${expectedYears} fiscal years from NSE XBRL${latestPeriod ? `; the newest filing available is ${latestPeriod}` : ''}` };
  }
  return {
    status: attempt >= maxAttempts ? 'FAILED_PERMANENT' : 'FAILED_RETRYABLE',
    lastError: factsStored === 0 ? 'No filing carried a mapped figure for its own reporting period' : 'Facts stored but none in the requested fiscal years',
  };
};

/** Provenance note for a full-year figure read through the period the filing states rather than the one it declares. */
const statedNote = (fact) => (fact.extraction.contextSource === STATED_OVER_DECLARED && fact.extraction.corroboration
  ? ' [Period stated by the filing; its declared context dates differ. Corroborated: the four quarters sum to this figure.]'
  : '');

/** The document shape stored for one extracted fact (dataOrigin REAL_RESEARCH, exchange-hosted source URL). */
export const toFactDocument = (fact) => ({
  symbol: fact.symbol,
  companyName: fact.companyName,
  date: fact.filedAt,
  period: fact.period,
  category: 'FINANCIAL_PERFORMANCE',
  title: `${fact.period} ${fact.label}`,
  fact: `${fact.companyName} reported ${fact.label} of ${fact.value} ${fact.unit} for ${fact.period} (${fact.consolidated}, ${fact.audited}).`,
  metrics: {
    metric: fact.metric,
    actualValue: fact.value,
    previousValue: null,
    unit: fact.unit,
    changePercent: null,
    currency: 'INR',
  },
  source: {
    type: 'QUARTERLY_REPORT',
    title: `${fact.symbol} ${fact.period} results (NSE XBRL filing)`,
    url: fact.sourceUrl,
    publishedAt: fact.filedAt,
    pageNumber: null,
    excerpt: `${fact.label}: ${fact.extraction.originalValue} ${fact.extraction.originalUnit} (XBRL tag ${fact.extraction.tag}, context ${fact.extraction.contextRef} ${fact.extraction.periodStart}..${fact.extraction.periodEnd})${statedNote(fact)}`,
  },
  confidence: fact.extraction.contextSource === STATED_OVER_DECLARED ? 0.95 : 0.99, // read directly from the company's own filed XBRL
  verified: true,
  dataOrigin: 'REAL_RESEARCH',
  isNegative: false,
  summary: `Extracted from ${fact.extraction.tag} in the NSE-published XBRL; ${fact.extraction.conversion}.${statedNote(fact)}`,
});
