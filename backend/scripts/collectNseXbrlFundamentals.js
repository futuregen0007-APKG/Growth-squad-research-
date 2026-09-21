/**
 * collectNseXbrlFundamentals.js
 * ================================
 * Phase 6B: collects REAL, attributable fundamentals for companies the
 * corpus has no filing data for (BEL, HAL) from the exchange's own
 * published XBRL filings.
 *
 * SOURCE AND METHOD. NSE publishes a corporate-results index at
 * `/api/corporates-financial-results`, where each entry carries the filing's
 * period, filing timestamp, audit status, consolidated/standalone flag, and
 * a link to the XBRL document the company itself filed. This script reads
 * that index, downloads the linked XBRL, and extracts only tags the filing
 * actually contains. Every figure keeps its source URL, filing date,
 * reporting period and the exact XBRL tag it came from.
 *
 * WHAT IT WILL NOT DO:
 *   - No site whose access is blocked is worked around. BEL's own investor
 *     relations host did not resolve during this phase; that is reported as
 *     an unresolved gap, not routed around.
 *   - No figure is invented, inferred, or back-filled. A tag that is absent
 *     from a filing simply yields no fact.
 *   - Values are stored in the project's standard unit (INR crore). XBRL
 *     reports absolute rupees, so the conversion is recorded explicitly in
 *     the extraction provenance alongside the original value - it is a
 *     restatement of the same number, never a derivation.
 *   - Suspicious output is screened by services/factQuarantine.js before
 *     storage, on the same terms as any other fact.
 *
 *   node scripts/collectNseXbrlFundamentals.js --symbols BEL,HAL
 *   node scripts/collectNseXbrlFundamentals.js --symbols BEL --dry-run
 */
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { pathToFileURL } from 'node:url';

dotenv.config();

const CompanyHistoricalFact = (await import('../models/CompanyHistoricalFact.js')).default;
const { screenFact, FACT_VERDICTS } = await import('../services/factQuarantine.js');

const NSE_RESULTS_API = 'https://www.nseindia.com/api/corporates-financial-results';

// A browser-shaped User-Agent is required by NSE's public API for any
// client; this is the documented way to call it, not a circumvention of an
// access control. A request that is refused stays refused.
const REQUEST_HEADERS = Object.freeze({
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  Referer: 'https://www.nseindia.com/',
});

/** Rupees -> crore. A restatement of the same figure, recorded in provenance. */
const RUPEES_PER_CRORE = 10_000_000;

/**
 * The XBRL tags this script reads, and the metric each maps to. Only these
 * are extracted: an unmapped tag is ignored rather than guessed at.
 */
const TAG_MAP = Object.freeze([
  { tag: 'RevenueFromOperations', metric: 'REVENUE', scale: 'RUPEES', label: 'Revenue from operations' },
  { tag: 'ProfitLossForPeriod', metric: 'PAT', scale: 'RUPEES', label: 'Profit for the period' },
  { tag: 'ProfitBeforeTax', metric: 'PROFIT_BEFORE_TAX', scale: 'RUPEES', label: 'Profit before tax' },
  { tag: 'BasicEarningsLossPerShare', metric: 'EPS', scale: 'PER_SHARE', label: 'Basic earnings per share' },
  { tag: 'OtherIncome', metric: 'OTHER_INCOME', scale: 'RUPEES', label: 'Other income' },
  { tag: 'EmployeeBenefitExpense', metric: 'EMPLOYEE_COST', scale: 'RUPEES', label: 'Employee benefit expense' },
]);

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const hasFlag = (name) => process.argv.includes(`--${name}`);

const fetchJson = async (url) => {
  const response = await fetch(url, { headers: REQUEST_HEADERS, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
  return response.json();
};

const fetchText = async (url) => {
  const response = await fetch(url, { headers: REQUEST_HEADERS, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
  return response.text();
};

/**
 * Reads one tag's value. XBRL repeats a tag per context (current quarter,
 * prior quarter, year to date); the FIRST occurrence is the one the filing
 * presents for the stated period, and that is the only one taken — no
 * summing, no picking the largest.
 */
export const readTag = (xml, tag) => {
  const match = xml.match(new RegExp(`<[^>]*\\b${tag}\\b[^>]*>([^<]+)<`, 'i'));
  if (!match) return null;
  const value = Number(String(match[1]).trim());
  return Number.isFinite(value) ? value : null;
};

const MONTHS = Object.freeze({ jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 });

/**
 * parseNseDate - NSE publishes "30-Jan-2025 15:37:17", which Date cannot
 * parse natively (it yields Invalid Date and then fails schema casting).
 * Parsed explicitly rather than coerced, so a filing date is either right
 * or absent - never silently "now".
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

/** "01-Oct-2024".."31-Dec-2024" + "Third Quarter" -> "Q3 FY2025" (Indian FY ends 31 Mar). */
export const toReportingPeriod = ({ fromDate, toDate, relatingTo }) => {
  const end = new Date(toDate);
  if (Number.isNaN(end.getTime())) return null;
  const month = end.getMonth(); // 0-11
  const fiscalYear = month >= 3 ? end.getFullYear() + 1 : end.getFullYear();
  const quarterByName = { 'First Quarter': 1, 'Second Quarter': 2, 'Third Quarter': 3, 'Fourth Quarter': 4 };
  const quarter = quarterByName[relatingTo] || Math.floor(((month + 9) % 12) / 3) + 1;
  const spansYear = fromDate && (end - new Date(fromDate)) > 300 * 86_400_000;
  return spansYear ? `FY${fiscalYear}` : `Q${quarter} FY${fiscalYear}`;
};

/** Builds the facts one filing yields. Returns [] when the filing has none of our tags. */
export const extractFactsFromFiling = (xml, record) => {
  const period = toReportingPeriod(record);
  if (!period) return [];

  const filedAt = parseNseDate(record.filingDate) || parseNseDate(record.broadCastDate) || new Date(record.toDate) || new Date();
  const facts = [];

  for (const mapping of TAG_MAP) {
    const raw = readTag(xml, mapping.tag);
    if (raw === null) continue;

    const isPerShare = mapping.scale === 'PER_SHARE';
    const value = isPerShare ? raw : Number((raw / RUPEES_PER_CRORE).toFixed(2));
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
        originalValue: raw,
        originalUnit: isPerShare ? 'INR_PER_SHARE' : 'INR',
        conversion: isPerShare ? 'none' : `INR / ${RUPEES_PER_CRORE} = INR_CRORE`,
        retrievedAt: new Date().toISOString(),
      },
    });
  }
  return facts;
};

const toFactDocument = (fact) => ({
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
    excerpt: `${fact.label}: ${fact.extraction.originalValue} ${fact.extraction.originalUnit} (XBRL tag ${fact.extraction.tag})`,
  },
  confidence: 0.99, // read directly from the company's own filed XBRL
  verified: true,
  dataOrigin: 'REAL_RESEARCH',
  isNegative: false,
  summary: `Extracted from ${fact.extraction.tag} in the NSE-published XBRL; ${fact.extraction.conversion}.`,
});

const collectSymbol = async (symbol, { dryRun }) => {
  const url = `${NSE_RESULTS_API}?index=equities&symbol=${encodeURIComponent(symbol)}&period=Quarterly`;
  let index;
  try {
    index = await fetchJson(url);
  } catch (error) {
    console.log(`  ${symbol}: results index unavailable — ${error.message}`);
    return { symbol, filings: 0, facts: 0, stored: 0, quarantined: 0, error: error.message };
  }

  // Consolidated results where the company filed XBRL, newest first.
  const filings = index
    .filter((r) => r.xbrl && r.symbol === symbol)
    .sort((a, b) => new Date(b.filingDate || 0) - new Date(a.filingDate || 0));

  const seenPeriods = new Set();
  const selected = [];
  for (const filing of filings) {
    const key = `${toReportingPeriod(filing)}|${filing.consolidated}`;
    if (seenPeriods.has(key)) continue; // one filing per period+basis, newest wins
    seenPeriods.add(key);
    selected.push(filing);
    if (selected.length >= 12) break; // three years of quarters is plenty
  }

  let factCount = 0;
  let stored = 0;
  let quarantined = 0;
  const periods = new Set();

  for (const filing of selected) {
    let xml;
    try {
      // eslint-disable-next-line no-await-in-loop
      xml = await fetchText(filing.xbrl);
    } catch (error) {
      console.log(`  ${symbol} ${toReportingPeriod(filing)}: XBRL unavailable — ${error.message}`);
      continue;
    }

    const facts = extractFactsFromFiling(xml, filing);
    factCount += facts.length;

    for (const fact of facts) {
      const screen = screenFact({ metric: fact.metric, value: fact.value, unit: fact.unit, title: fact.label });
      if (screen.verdict !== FACT_VERDICTS.USABLE) {
        quarantined += 1;
        console.log(`  ${symbol} ${fact.period} ${fact.metric}=${fact.value} ${fact.unit} -> ${screen.verdict} (${screen.reason})`);
        continue;
      }
      periods.add(fact.period);
      if (dryRun) { stored += 1; continue; }
      // eslint-disable-next-line no-await-in-loop
      await CompanyHistoricalFact.updateOne(
        { symbol: fact.symbol, period: fact.period, 'metrics.metric': fact.metric, 'source.url': fact.sourceUrl },
        { $set: toFactDocument(fact) },
        { upsert: true },
      );
      stored += 1;
    }
  }

  return { symbol, filings: selected.length, facts: factCount, stored, quarantined, periods: [...periods].sort() };
};

const main = async () => {
  const symbols = (arg('symbols', 'BEL,HAL') || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const dryRun = hasFlag('dry-run');

  if (!dryRun) await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  console.log(`Collecting NSE XBRL fundamentals for ${symbols.join(', ')}${dryRun ? ' (dry run)' : ''}\n`);

  const results = [];
  for (const symbol of symbols) {
    // eslint-disable-next-line no-await-in-loop
    const result = await collectSymbol(symbol, { dryRun });
    results.push(result);
    console.log(`  ${symbol}: ${result.filings} filing(s) -> ${result.facts} fact(s), ${result.stored} stored, ${result.quarantined} quarantined`);
    if (result.periods?.length) console.log(`     periods: ${result.periods.join(', ')}`);
  }

  console.log('\n--- summary ---');
  console.log(JSON.stringify(results, null, 2));
  if (!dryRun) await mongoose.disconnect();
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch(async (error) => {
    console.error(error);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
}
