/**
 * verifyNseXbrlFacts.js
 * =======================
 * `npm run earnings:verify-xbrl -- --symbols A,B,C [--sample N] [--delay-ms 1000]
 *    [--expect-target host/db] [--label pilot] [--fail-on-mismatch]`
 *
 * READ-ONLY, and independent of how the facts were collected. For each stored
 * REAL_RESEARCH fact whose source is an NSE XBRL filing, it re-downloads that
 * filing from the exchange and checks, against the document itself:
 *
 *   - the source URL is exchange-hosted;
 *   - the filing declares a context spanning exactly the fact's period, and the
 *     tag has a value in it (so the period label is right);
 *   - that value, converted to the stored unit, equals the stored figure;
 *   - the stored excerpt quotes the same raw value.
 *
 * It then runs an integrity check that needs no trust in the collector at all:
 * for every fiscal year with all four quarters stored on the same basis, the
 * four quarterly revenue (and profit) figures must sum to the full-year figure
 * carried by that year's Q4 filing.
 *
 * It never writes to the database. Requests are throttled.
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertMongoTarget } from '../utils/mongoTarget.js';
import {
  TAG_MAP, RUPEES_PER_CRORE, NSE_REQUEST_HEADERS, periodRange, parseXbrlContexts, findTagForPeriod,
} from '../services/NseXbrlService.js';

const BACKEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUM_METRICS = ['REVENUE', 'PAT']; // additive across quarters; EPS and margins are not

/** "Consolidated" / "Non-Consolidated" as recorded in the stored fact text, or null. */
export const basisOf = (fact) => String(fact?.fact || '').match(/\((Consolidated|Non-Consolidated),/)?.[1] || null;

const isExchangeHost = (url) => { try { const h = new URL(url).hostname.toLowerCase(); return h === 'nseindia.com' || h.endsWith('.nseindia.com'); } catch { return false; } };

/** The value the collector would store for a raw XBRL figure. */
export const expectedStoredValue = (mapping, rawValue) => (
  mapping.scale === 'PER_SHARE' ? rawValue : Number((rawValue / RUPEES_PER_CRORE).toFixed(2))
);

/**
 * verifyFactAgainstXml - pure. Returns { status, detail } where status is one
 * of MATCH, SOURCE_NOT_EXCHANGE, UNSUPPORTED_METRIC, PERIOD_UNREADABLE,
 * NO_CONTEXT_FOR_PERIOD, VALUE_MISMATCH, EXCERPT_MISMATCH.
 */
export const verifyFactAgainstXml = (fact, xml, contexts = parseXbrlContexts(xml)) => {
  if (!isExchangeHost(fact?.source?.url)) return { status: 'SOURCE_NOT_EXCHANGE', detail: fact?.source?.url || null };
  const mapping = TAG_MAP.find((m) => m.metric === fact.metrics?.metric);
  if (!mapping) return { status: 'UNSUPPORTED_METRIC', detail: fact.metrics?.metric || null };
  const range = periodRange(fact.period);
  if (!range) return { status: 'PERIOD_UNREADABLE', detail: fact.period };

  const found = findTagForPeriod(xml, mapping.tag, range, contexts);
  if (!found) return { status: 'NO_CONTEXT_FOR_PERIOD', detail: `${mapping.tag} has no non-dimensioned value for ${range.start}..${range.end}` };

  const expected = expectedStoredValue(mapping, found.value);
  const tolerance = mapping.scale === 'PER_SHARE' ? 1e-9 : 0.006;
  if (!(Math.abs(expected - fact.metrics?.actualValue) <= tolerance)) {
    return { status: 'VALUE_MISMATCH', detail: `stored ${fact.metrics?.actualValue}, filing says ${expected}` };
  }
  if (!String(fact.source?.excerpt || '').includes(String(found.value))) {
    return { status: 'EXCERPT_MISMATCH', detail: `excerpt does not quote raw value ${found.value}` };
  }
  return { status: 'MATCH', detail: `${mapping.tag} ${found.contextRef}` };
};

/** checkQuarterSums - pure. Four quarterly figures must add up to the full-year figure (crore), within rounding. */
export const checkQuarterSums = (quarterValues, fullYearValue) => {
  const sum = Number(quarterValues.reduce((s, v) => s + v, 0).toFixed(2));
  const tolerance = Math.max(0.5, Math.abs(fullYearValue) * 0.001);
  return { status: Math.abs(sum - fullYearValue) <= tolerance ? 'SUM_MATCH' : 'SUM_MISMATCH', sum, fullYear: fullYearValue, difference: Number((sum - fullYearValue).toFixed(2)) };
};

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const fetchXml = async (url) => {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const response = await fetch(url, { headers: NSE_REQUEST_HEADERS, signal: AbortSignal.timeout(30000) });
      if (response.ok) return { xml: await response.text() };
      if (response.status < 500 && response.status !== 429) return { error: `HTTP ${response.status}` };
    } catch (error) {
      if (attempt === 2) return { error: error.message };
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(3000);
  }
  return { error: 'unavailable after retry' };
};

const evenlySpaced = (items, n) => {
  if (!n || items.length <= n) return items;
  return Array.from({ length: n }, (_, i) => items[Math.floor((i * items.length) / n)]);
};

export const verifySymbol = async (db, symbol, { sample, delayMs, xmlCache }) => {
  const facts = await db.collection('companyhistoricalfacts').find({
    symbol, dataOrigin: 'REAL_RESEARCH', 'source.url': /nseindia\.com\/.*\.xml$/i,
  }).toArray();

  const byUrl = new Map();
  for (const fact of facts) { if (!byUrl.has(fact.source.url)) byUrl.set(fact.source.url, []); byUrl.get(fact.source.url).push(fact); }
  const urls = [...byUrl.keys()].sort((a, b) => (byUrl.get(a)[0].period > byUrl.get(b)[0].period ? 1 : -1));
  const chosen = evenlySpaced(urls, sample);

  const result = { symbol, storedFacts: facts.length, urlsStored: urls.length, urlsChecked: 0, factsChecked: 0, statuses: {}, failures: [], sums: { checked: 0, ok: 0, mismatches: [] }, fetchFailures: [] };
  const reportedFailures = new Set();
  const noteFetchFailure = (url, error) => {
    if (reportedFailures.has(url)) return;
    reportedFailures.add(url);
    result.fetchFailures.push({ url, error });
  };
  const getXml = async (url) => {
    if (xmlCache.has(url)) return xmlCache.get(url);
    const fetched = await fetchXml(url);
    xmlCache.set(url, fetched);
    await sleep(delayMs);
    return fetched;
  };

  for (const url of chosen) {
    // eslint-disable-next-line no-await-in-loop
    const { xml, error } = await getXml(url);
    if (error) { noteFetchFailure(url, error); continue; }
    result.urlsChecked += 1;
    const contexts = parseXbrlContexts(xml);
    for (const fact of byUrl.get(url)) {
      const verdict = verifyFactAgainstXml(fact, xml, contexts);
      result.factsChecked += 1;
      result.statuses[verdict.status] = (result.statuses[verdict.status] || 0) + 1;
      if (verdict.status !== 'MATCH') result.failures.push({ period: fact.period, metric: fact.metrics?.metric, status: verdict.status, detail: verdict.detail, url });
    }
  }

  // Integrity: Q1..Q4 stored on one basis must sum to the year the Q4 filing reports.
  const groups = new Map();
  for (const fact of facts) {
    const metric = fact.metrics?.metric;
    const basis = basisOf(fact);
    const q = String(fact.period).match(/^Q([1-4]) FY(\d{4})$/);
    if (!SUM_METRICS.includes(metric) || !basis || !q) continue;
    const key = `${basis}|${metric}|${q[2]}`;
    if (!groups.has(key)) groups.set(key, {});
    groups.get(key)[`Q${q[1]}`] = fact;
  }
  for (const [key, quarters] of groups) {
    if (!['Q1', 'Q2', 'Q3', 'Q4'].every((q) => quarters[q])) continue;
    const [basis, metric, fy] = key.split('|');
    const mapping = TAG_MAP.find((m) => m.metric === metric);
    // eslint-disable-next-line no-await-in-loop
    const { xml, error } = await getXml(quarters.Q4.source.url);
    if (error) { noteFetchFailure(quarters.Q4.source.url, error); continue; }
    const full = findTagForPeriod(xml, mapping.tag, periodRange(`FY${fy}`));
    if (!full) { result.sums.mismatches.push({ basis, metric, fy, status: 'NO_FULL_YEAR_CONTEXT' }); result.sums.checked += 1; continue; }
    const check = checkQuarterSums(['Q1', 'Q2', 'Q3', 'Q4'].map((q) => quarters[q].metrics.actualValue), expectedStoredValue(mapping, full.value));
    result.sums.checked += 1;
    if (check.status === 'SUM_MATCH') result.sums.ok += 1; else result.sums.mismatches.push({ basis, metric, fy, ...check });
  }
  return result;
};

const parseArgs = (argv) => {
  const get = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
  return {
    symbols: (get('--symbols') || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
    sample: get('--sample') ? Number(get('--sample')) : null,
    delayMs: get('--delay-ms') ? Number(get('--delay-ms')) : 1000,
    expectTarget: get('--expect-target'),
    label: get('--label') || 'xbrl-verification',
    failOnMismatch: argv.includes('--fail-on-mismatch'),
  };
};

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  (async () => {
    dotenv.config();
    const args = parseArgs(process.argv.slice(2));
    if (!args.symbols.length) throw new Error('--symbols is required');
    const target = assertMongoTarget(process.env.MONGODB_URI, args.expectTarget);
    console.log(`Target database: ${target.label}${target.implicitDatabase ? '  (URI names no database -> driver default "test")' : ''}`);
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });

    const xmlCache = new Map();
    const results = [];
    for (const symbol of args.symbols) {
      // eslint-disable-next-line no-await-in-loop
      const r = await verifySymbol(mongoose.connection.db, symbol, { sample: args.sample, delayMs: args.delayMs, xmlCache });
      results.push(r);
      const ok = r.statuses.MATCH || 0;
      console.log(`${symbol.padEnd(12)} stored=${r.storedFacts} urls ${r.urlsChecked}/${r.urlsStored} facts checked=${r.factsChecked} MATCH=${ok} other=${r.factsChecked - ok} | quarter-sum checks ${r.sums.ok}/${r.sums.checked} ok | fetch failures=${r.fetchFailures.length}`);
      for (const f of r.failures.slice(0, 5)) console.log(`    ! ${f.period} ${f.metric}: ${f.status} (${f.detail})`);
      for (const m of r.sums.mismatches.slice(0, 5)) console.log(`    ! sum ${m.basis} ${m.metric} FY${m.fy}: ${m.status} ${m.sum ?? ''} vs ${m.fullYear ?? ''}`);
    }
    const totals = results.reduce((t, r) => ({
      factsChecked: t.factsChecked + r.factsChecked, match: t.match + (r.statuses.MATCH || 0), sumsChecked: t.sumsChecked + r.sums.checked, sumsOk: t.sumsOk + r.sums.ok, fetchFailures: t.fetchFailures + r.fetchFailures.length,
    }), { factsChecked: 0, match: 0, sumsChecked: 0, sumsOk: 0, fetchFailures: 0 });
    console.log(`\nVERIFICATION: ${totals.match}/${totals.factsChecked} facts match their source filing; quarter sums ${totals.sumsOk}/${totals.sumsChecked}; fetch failures ${totals.fetchFailures}`);

    const outDir = path.join(BACKEND_DIR, 'reports', 'earnings-coverage');
    fs.mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, `${args.label}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(file, JSON.stringify({ label: args.label, target: target.label, generatedAt: new Date().toISOString(), totals, results }, null, 2));
    console.log(`Report saved: ${path.relative(process.cwd(), file)}`);
    await mongoose.disconnect();
    process.exit(args.failOnMismatch && (totals.match !== totals.factsChecked || totals.sumsOk !== totals.sumsChecked) ? 1 : 0);
  })().catch((error) => { console.error('Verification failed:', error.message); process.exit(1); });
}

