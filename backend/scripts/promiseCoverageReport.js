/**
 * promiseCoverageReport.js
 * =========================
 * `npm run earnings:promise-coverage -- --expect-target <host>/<database> [--label name] [--symbols A,B]`
 *
 * READ-ONLY, reproducible per-company coverage of management guidance and its
 * outcomes, for every supported company. Writes reports/earnings-coverage/
 * promise-coverage-<label>-<timestamp>.{json,md,csv}. Built on the existing
 * coverage audit (scripts/earningsCoverageAudit.js) for financial years and
 * documents, and on the SAME management-delivery computation the site uses
 * (services/PromisesVsActualsService.js buildManagementDelivery), so the report
 * and the pages cannot disagree.
 *
 * Each company gets exactly one category, most-advanced first:
 *   VERIFIED_COMPARABLE_TARGETS   at least one published target has a completed, comparable outcome (met / exceeded / missed)
 *   GUIDANCE_WITHOUT_MATCHED_ACTUALS  published targets exist, none yet comparable (pending, or no like-for-like actual)
 *   QUALITATIVE_ONLY              only qualitative statements are published
 *   PENDING_REVIEW                guidance was extracted but nothing has passed the evidence-review gate
 *   NO_MEASURABLE_GUIDANCE        guidance documents were read in full and held no qualifying numeric target
 *   SOURCES_BLOCKED               guidance documents exist but every one failed to download or read
 *   NO_GUIDANCE_DOCUMENTS         discovery ran and NSE lists no transcript or presentation in the window
 *   NOT_RESEARCHED                discovery has never run for this company
 * "Not researched" and "researched, nothing measurable" are never merged.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { assertMongoTarget } from '../utils/mongoTarget.js';

const BACKEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const COVERAGE_CATEGORIES = Object.freeze([
  'VERIFIED_COMPARABLE_TARGETS', 'GUIDANCE_WITHOUT_MATCHED_ACTUALS', 'QUALITATIVE_ONLY', 'PENDING_REVIEW',
  'NO_MEASURABLE_GUIDANCE', 'SOURCES_BLOCKED', 'NO_GUIDANCE_DOCUMENTS', 'NOT_RESEARCHED',
]);

/** classifyPromiseCoverage - pure. One category per company, plus the specific reasons behind it. */
export const classifyPromiseCoverage = ({ delivery, docs, candidates, discovery }) => {
  const d = delivery?.managementDeliveryScore || {};
  const published = d.totalTargets || 0;
  const completed = d.completedCount || 0;
  const reasons = [];
  if (completed > 0) {
    if ((d.pendingCount || 0) + (d.insufficientEvidenceCount || 0) > 0) reasons.push(`${(d.pendingCount || 0) + (d.insufficientEvidenceCount || 0)} published target(s) still without a comparable outcome`);
    return { category: 'VERIFIED_COMPARABLE_TARGETS', reasons };
  }
  if (published > 0) {
    if (d.qualitativeOnlyCount === published) return { category: 'QUALITATIVE_ONLY', reasons: ['only qualitative statements are published'] };
    reasons.push(`${d.pendingCount || 0} pending (period not closed or results not yet due), ${d.insufficientEvidenceCount || 0} without a like-for-like actual`);
    return { category: 'GUIDANCE_WITHOUT_MATCHED_ACTUALS', reasons };
  }
  if (candidates.pendingV2 > 0) {
    reasons.push(`${candidates.pendingV2} extracted target(s) kept for review${candidates.topReasons.length ? `: ${candidates.topReasons.map(([r, n]) => `${r} x${n}`).join(', ')}` : ''}`);
    return { category: 'PENDING_REVIEW', reasons };
  }
  if (docs.read > 0) {
    reasons.push(`${docs.read} document(s) read in full (${Object.entries(docs.byType).map(([t, n]) => `${t.toLowerCase().replace(/_/g, ' ')} ${n}`).join(', ')}); no qualifying numeric target`);
    if (candidates.pendingV1 > 0) reasons.push(`${candidates.pendingV1} legacy v1 candidate(s) retained for audit, superseded by v2`);
    return { category: 'NO_MEASURABLE_GUIDANCE', reasons };
  }
  if (docs.total > 0 && docs.failed === docs.total) {
    return { category: 'SOURCES_BLOCKED', reasons: [`all ${docs.total} guidance document(s) failed: ${docs.topErrors.join('; ') || 'no error recorded'}`] };
  }
  if (discovery?.at) {
    if (discovery.error) return { category: 'NOT_RESEARCHED', reasons: [`last discovery attempt failed: ${discovery.error}`] };
    if (docs.total === 0) return { category: 'NO_GUIDANCE_DOCUMENTS', reasons: [`NSE lists no earnings-call transcript or investor presentation in the window (checked ${String(discovery.at).slice(0, 10)})`] };
    return { category: 'NOT_RESEARCHED', reasons: [`${docs.total - docs.read - docs.failed} guidance document(s) registered but not yet read`] };
  }
  return { category: 'NOT_RESEARCHED', reasons: ['guidance discovery has never run for this company'] };
};

const aggregateBySymbol = async (db, symbols) => {
  const match = symbols?.length ? { symbol: { $in: symbols } } : {};
  const [regs, cands] = await Promise.all([
    db.collection('companydocumentregistries').find({ ...match, sourceType: { $in: ['EARNINGS_CALL_TRANSCRIPT', 'FINANCIAL_RESULTS', 'INVESTOR_PRESENTATION'] } }, { projection: { symbol: 1, sourceType: 1, extractionStatus: 1, promiseExtractionStatus: 1, promiseExtractionVersion: 1, error: 1 } }).toArray(),
    db.collection('promisecandidates').find(match, { projection: { symbol: 1, reviewStatus: 1, extractionVersion: 1, 'autoReview.decision': 1, 'autoReview.reasons': 1, 'outcome.status': 1 } }).toArray(),
  ]);
  const docs = new Map();
  for (const r of regs) {
    if (!docs.has(r.symbol)) docs.set(r.symbol, { total: 0, read: 0, readV2: 0, failed: 0, pending: 0, byType: {}, errors: new Map() });
    const d = docs.get(r.symbol);
    d.total += 1;
    d.byType[r.sourceType] = (d.byType[r.sourceType] || 0) + 1;
    if (r.extractionStatus === 'FAILED' || r.promiseExtractionStatus === 'FAILED') {
      d.failed += 1;
      const e = String(r.error || 'promise extraction failed').slice(0, 100);
      d.errors.set(e, (d.errors.get(e) || 0) + 1);
    } else if (r.promiseExtractionStatus === 'EXTRACTED') {
      d.read += 1;
      if (r.promiseExtractionVersion === 'v2') d.readV2 += 1;
    } else d.pending += 1;
  }
  const cand = new Map();
  for (const c of cands) {
    if (!cand.has(c.symbol)) cand.set(c.symbol, { total: 0, accepted: 0, rejected: 0, pendingV1: 0, pendingV2: 0, reiterations: 0, reasons: new Map() });
    const x = cand.get(c.symbol);
    x.total += 1;
    if (c.reviewStatus === 'ACCEPTED') x.accepted += 1;
    else if (c.reviewStatus === 'REJECTED') x.rejected += 1;
    else if (c.extractionVersion === 'v2') {
      if (c.autoReview?.decision === 'REITERATION') x.reiterations += 1;
      else x.pendingV2 += 1;
      for (const reason of c.autoReview?.reasons || []) { const code = reason.split(':')[0]; x.reasons.set(code, (x.reasons.get(code) || 0) + 1); }
    } else x.pendingV1 += 1;
  }
  return { docs, cand };
};

const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : '-');

export const renderMarkdown = ({ label, target, generatedAt, totals, rows }) => {
  const lines = [`# Promise & outcome coverage: ${label}`, '', `- Target database: \`${target}\``, `- Generated: ${generatedAt}`, `- Supported companies: ${rows.length}`, '',
    '## Companies by category', '', '| Category | Companies |', '|---|---|'];
  for (const c of COVERAGE_CATEGORIES) lines.push(`| ${c} | ${totals.byCategory[c] || 0} |`);
  lines.push('', '## Totals', '', '| Metric | Value |', '|---|---|',
    `| Companies attempted (discovery ran) | ${totals.attempted} of ${rows.length} |`,
    `| Guidance documents registered / read (v2) / failed | ${totals.docs} / ${totals.docsReadV2} / ${totals.docsFailed} |`,
    `| Published targets | ${totals.published} |`, `| Completed and comparable (met / exceeded / missed) | ${totals.completed} (${totals.met} / ${totals.exceeded} / ${totals.missed}) |`,
    `| Pending / insufficient evidence / qualitative | ${totals.pending} / ${totals.insufficient} / ${totals.qualitative} |`,
    `| Candidates kept for review (v2) / reiterations / legacy v1 | ${totals.pendingV2} / ${totals.reiterations} / ${totals.pendingV1} |`, '',
    '## Per company', '', '| Symbol | Sector | Category | FY actuals | Guidance docs (read/failed) | Published (comparable) | Met/Exc/Missed | Pending/InsEv/Qual | Review queue | Reasons |', '|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    lines.push(`| ${r.symbol} | ${r.sector} | ${r.category} | ${r.financialYears.join(', ') || 'none'} | ${r.docs.total} (${r.docs.read}/${r.docs.failed}) | ${r.published} (${r.completed}) | ${r.met}/${r.exceeded}/${r.missed} | ${r.pending}/${r.insufficient}/${r.qualitative} | ${r.pendingV2} | ${r.reasons.join('; ').replace(/\|/g, '/')} |`);
  }
  return `${lines.join('\n')}\n`;
};

const parseArgs = (argv) => {
  const get = (flag) => { const eq = argv.find((a) => a.startsWith(`${flag}=`)); if (eq) return eq.slice(flag.length + 1); const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
  return {
    expectTarget: get('--expect-target'),
    label: get('--label') || 'promise-coverage',
    symbols: get('--symbols') ? get('--symbols').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) : null,
  };
};

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  (async () => {
    dotenv.config({ path: path.join(BACKEND_DIR, '.env') });
    const args = parseArgs(process.argv.slice(2));
    if (!args.expectTarget) throw new Error('--expect-target <host>/<database> is required');
    process.env.INDIAN_API_KEY = '';
    const target = assertMongoTarget(process.env.MONGODB_URI, args.expectTarget);
    mongoose.set('autoIndex', false); // read-only: never create collections or indexes
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000, autoIndex: false });
    const db = mongoose.connection.db;

    const { SUPPORTED_STOCKS } = await import('../utils/constants.js');
    const { collectCoverageRows } = await import('./earningsCoverageAudit.js');
    const { buildManagementDelivery } = await import('../services/PromisesVsActualsService.js');
    const { rows: auditRows } = await collectCoverageRows(db, { symbols: args.symbols });
    const { docs, cand } = await aggregateBySymbol(db, args.symbols);

    const emptyDocs = { total: 0, read: 0, readV2: 0, failed: 0, pending: 0, byType: {}, errors: new Map() };
    const emptyCand = { total: 0, accepted: 0, rejected: 0, pendingV1: 0, pendingV2: 0, reiterations: 0, reasons: new Map() };
    const rows = [];
    for (const a of auditRows) {
      // eslint-disable-next-line no-await-in-loop
      const delivery = await buildManagementDelivery(a.symbol).catch(() => null);
      const d = docs.get(a.symbol) || emptyDocs;
      const c = cand.get(a.symbol) || emptyCand;
      const topReasons = [...c.reasons].sort((x, y) => y[1] - x[1]).slice(0, 3);
      const docInfo = { ...d, topErrors: [...d.errors].sort((x, y) => y[1] - x[1]).slice(0, 2).map(([e, n]) => `${e} x${n}`) };
      const { category, reasons } = classifyPromiseCoverage({
        delivery, docs: docInfo, candidates: { ...c, topReasons }, discovery: a.profile?.lastGuidanceDiscoveryResult || (a.profile?.lastGuidanceDiscoveryAt ? { at: a.profile.lastGuidanceDiscoveryAt } : null),
      });
      const m = delivery?.managementDeliveryScore || {};
      rows.push({
        symbol: a.symbol,
        companyName: SUPPORTED_STOCKS[a.symbol]?.name || a.symbol,
        sector: SUPPORTED_STOCKS[a.symbol]?.sector || 'Unknown',
        category,
        reasons,
        financialYears: a.facts.coveredYears.map((y) => `FY${y}`),
        financialMissingYears: a.facts.missingYears.map((y) => `FY${y}`),
        lastXbrlAttemptAt: a.job?.lastAttemptAt || a.job?.updatedAt || null,
        lastGuidanceDiscoveryAt: a.profile?.lastGuidanceDiscoveryAt || null,
        docs: { total: d.total, read: d.read, readV2: d.readV2, failed: d.failed, pending: d.pending, byType: d.byType },
        published: m.totalTargets || 0,
        completed: m.completedCount || 0,
        met: m.metCount || 0,
        exceeded: m.exceededCount || 0,
        missed: m.missedCount || 0,
        pending: m.pendingCount || 0,
        insufficient: m.insufficientEvidenceCount || 0,
        qualitative: m.qualitativeOnlyCount || 0,
        superseded: m.supersededCount || 0,
        targetHitRate: m.targetHitRate ?? null,
        pendingV2: c.pendingV2,
        pendingV1: c.pendingV1,
        reiterations: c.reiterations,
        emptyState: delivery?.emptyState || null,
        unresolvedReasons: (delivery?.rows || []).filter((r) => ['PENDING', 'INSUFFICIENT_EVIDENCE'].includes(r.outcome)).map((r) => `${r.id}: ${r.reason || r.achievementReason || ''}`.slice(0, 220)),
      });
    }

    const sum = (f) => rows.reduce((s, r) => s + f(r), 0);
    const totals = {
      byCategory: Object.fromEntries(COVERAGE_CATEGORIES.map((cat) => [cat, rows.filter((r) => r.category === cat).length])),
      attempted: rows.filter((r) => r.lastGuidanceDiscoveryAt || r.docs.total > 0).length,
      docs: sum((r) => r.docs.total), docsReadV2: sum((r) => r.docs.readV2), docsFailed: sum((r) => r.docs.failed),
      published: sum((r) => r.published), completed: sum((r) => r.completed), met: sum((r) => r.met), exceeded: sum((r) => r.exceeded), missed: sum((r) => r.missed),
      pending: sum((r) => r.pending), insufficient: sum((r) => r.insufficient), qualitative: sum((r) => r.qualitative),
      pendingV2: sum((r) => r.pendingV2), reiterations: sum((r) => r.reiterations), pendingV1: sum((r) => r.pendingV1),
    };
    const generatedAt = new Date().toISOString();
    const outDir = path.join(BACKEND_DIR, 'reports', 'earnings-coverage');
    fs.mkdirSync(outDir, { recursive: true });
    const base = path.join(outDir, `${args.label}-${generatedAt.replace(/[:.]/g, '-')}`);
    fs.writeFileSync(`${base}.json`, JSON.stringify({ label: args.label, target: target.label, generatedAt, totals, rows }, null, 2));
    fs.writeFileSync(`${base}.md`, renderMarkdown({ label: args.label, target: target.label, generatedAt, totals, rows }));
    const csvHead = ['symbol', 'sector', 'category', 'financialYears', 'docs', 'docsRead', 'docsFailed', 'published', 'completed', 'met', 'exceeded', 'missed', 'pending', 'insufficient', 'qualitative', 'reviewQueue', 'reasons'];
    const csv = [csvHead.join(','), ...rows.map((r) => [r.symbol, r.sector, r.category, r.financialYears.join(' '), r.docs.total, r.docs.read, r.docs.failed, r.published, r.completed, r.met, r.exceeded, r.missed, r.pending, r.insufficient, r.qualitative, r.pendingV2, r.reasons.join(' | ')].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))].join('\n');
    fs.writeFileSync(`${base}.csv`, `${csv}\n`);
    console.log(`Categories: ${JSON.stringify(totals.byCategory)}`);
    console.log(`Totals: ${JSON.stringify({ ...totals, byCategory: undefined })}`);
    console.log(`Report saved: ${path.relative(process.cwd(), `${base}.md`)} (+ .json, .csv)`);
    await mongoose.disconnect();
    process.exit(0);
  })().catch(async (error) => {
    console.error('Promise coverage report failed:', error.message);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
}
