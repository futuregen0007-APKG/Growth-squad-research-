/**
 * autoReviewCandidates.js
 * ========================
 * `npm run earnings:auto-review -- --expect-target <host>/<database>
 *    [--symbols A,B] [--dry-run] [--concurrency 2] [--delay-ms 600] [--label name]`
 *
 * Runs the deterministic evidence-review gate (services/PromiseReviewGate.js)
 * over PENDING_REVIEW promise candidates, and promotes ONLY those that pass
 * every check through the established review path -- scripts/earningsReview.js
 * acceptCandidate, the same function `npm run earnings:review --accept` uses,
 * with the same EARNINGS_REVIEW_SECRET authorisation and evidence status
 * VERIFIED_EXCHANGE_COPY (asserted because the excerpt was re-found verbatim
 * on the cited page of the exchange-hosted copy, downloaded in this run).
 *
 * Nothing is rejected and nothing is edited: a candidate that fails any check
 * stays PENDING_REVIEW with the specific reasons recorded in `autoReview`, for
 * a human. A reiteration of an already-published target is recorded as such
 * and not promoted, so the same guidance is never counted twice.
 *
 * --dry-run reads the database and downloads the source documents, but writes
 * nothing (no autoReview fields, no promotion); the report is still saved.
 * Idempotent: re-running re-derives every decision from the current data.
 * Promoted records land in data/earnings-intelligence/promises/<SYMBOL>.json,
 * which must be committed for the public site to serve them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { assertMongoTarget } from '../utils/mongoTarget.js';
import { preCheck, contentCheck, decideGroups } from '../services/PromiseReviewGate.js';
import { isPubliclyVisibleRecord } from '../utils/earningsIntelligenceValidation.js';

const BACKEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROMISES_DIR = path.join(BACKEND_DIR, 'data', 'earnings-intelligence', 'promises');
export const GATE_REVIEWER = 'automated-evidence-gate (earnings:auto-review)';

const normalize = (value) => String(value || '')
  .replace(/[‘’′]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
  .replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * locateExcerpt - pure. Whether `excerpt` is on `pageText` verbatim (after
 * whitespace / quote normalisation), and the ~600 characters before it on that
 * page (the question or sentences that name the metric / period).
 */
export const locateExcerpt = (excerpt, pageText) => {
  const needle = normalize(excerpt);
  const hay = normalize(pageText);
  if (needle.length < 12) return { found: false, context: '' };
  const at = hay.indexOf(needle);
  if (at < 0) return { found: false, context: '' };
  return { found: true, context: hay.slice(Math.max(0, at - 600), at) };
};

/** readPublishedRecords - the publicly visible curated records on disk, per symbol. */
export const readPublishedRecords = (dir = PROMISES_DIR) => {
  const bySymbol = new Map();
  if (!fs.existsSync(dir)) return bySymbol;
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      const records = (parsed.records || []).filter((r) => isPubliclyVisibleRecord(r));
      bySymbol.set(path.basename(file, '.json').toUpperCase(), records);
    } catch { /* an unreadable file contributes nothing */ }
  }
  return bySymbol;
};

/**
 * reviewCandidates - the whole gate, with I/O injected so it is testable.
 *   fetchPages(url) -> [{pageNumber, text}] (throws on a failed download)
 * Returns { results: [{ candidate, decision, reasons, sourceCheck, ... }], summary }.
 */
export const reviewCandidates = async (candidates, {
  fetchPages, published = new Map(), concurrency = 2, delayMs = 0, log = () => {},
}) => {
  const pre = new Map(candidates.map((c) => [c.id, preCheck(c)]));
  const toVerify = candidates.filter((c) => pre.get(c.id).length === 0);
  const urls = [...new Set(toVerify.map((c) => c.promiseEvidence.sourceUrl))];
  const pagesByUrl = new Map();
  const queue = [...urls];
  const worker = async () => {
    while (queue.length) {
      const url = queue.shift();
      try {
        // eslint-disable-next-line no-await-in-loop
        pagesByUrl.set(url, { pages: await fetchPages(url), error: null });
      } catch (error) {
        pagesByUrl.set(url, { pages: null, error: `the exchange copy could not be downloaded (${error.message})` });
      }
      if (pagesByUrl.get(url).error || pagesByUrl.size % 20 === 0 || pagesByUrl.size === urls.length) {
        log(`  sources checked ${pagesByUrl.size}/${urls.length}${pagesByUrl.get(url).error ? ` (download failed: ${url})` : ''}`);
      }
      // eslint-disable-next-line no-await-in-loop
      if (delayMs) await new Promise((resolve) => { setTimeout(resolve, delayMs); });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));

  const sourceChecks = new Map();
  for (const c of toVerify) {
    const doc = pagesByUrl.get(c.promiseEvidence.sourceUrl);
    if (!doc || doc.error) { sourceChecks.set(c.id, { error: doc?.error || 'not downloaded' }); continue; }
    const page = doc.pages.find((p) => p.pageNumber === c.promiseEvidence.pageNumber);
    sourceChecks.set(c.id, page ? locateExcerpt(c.promiseEvidence.excerpt, page.text) : { found: false, context: '' });
  }

  const individual = new Map();
  for (const c of candidates) {
    const reasons = pre.get(c.id).length ? pre.get(c.id) : contentCheck(c, sourceChecks.get(c.id));
    individual.set(c.id, reasons);
  }
  const passing = candidates.filter((c) => individual.get(c.id).length === 0);
  const publishedForPassing = [...new Set(passing.map((c) => c.symbol))].flatMap((s) => published.get(s) || []);
  const groupDecisions = decideGroups(passing, publishedForPassing);

  const results = candidates.map((c) => {
    const reasons = individual.get(c.id);
    if (reasons.length) return { candidate: c, decision: 'KEPT_PENDING', reasons, sourceCheck: sourceChecks.get(c.id) || null };
    const g = groupDecisions.get(c.id);
    return { candidate: c, ...g, sourceCheck: sourceChecks.get(c.id) };
  });

  const summary = { candidates: candidates.length, accepted: 0, revisions: 0, reiterations: 0, keptPending: 0, sourcesChecked: urls.length, sourcesFailed: [...pagesByUrl.values()].filter((d) => d.error).length, reasons: {} };
  for (const r of results) {
    if (r.decision === 'ACCEPTED') { summary.accepted += 1; if (r.revisesPromiseId) summary.revisions += 1; }
    else if (r.decision === 'REITERATION') summary.reiterations += 1;
    else summary.keptPending += 1;
    for (const reason of r.reasons || []) {
      const code = reason.split(':')[0];
      summary.reasons[code] = (summary.reasons[code] || 0) + 1;
    }
  }
  return { results, summary };
};

const renderMarkdown = ({ label, target, summary, results }) => {
  const lines = [`# Promise review gate: ${label}`, '', `- Target database: \`${target}\``, `- Generated: ${new Date().toISOString()}`, '',
    '## Summary', '', '| Metric | Value |', '|---|---|',
    `| Candidates reviewed | ${summary.candidates} |`, `| Accepted (published) | ${summary.accepted} (of which revisions: ${summary.revisions}) |`,
    `| Reiterations (not counted twice) | ${summary.reiterations} |`, `| Kept pending for a human | ${summary.keptPending} |`,
    `| Source documents verified / failed | ${summary.sourcesChecked} / ${summary.sourcesFailed} |`, '', '## Why candidates stayed pending', '', '| Reason | Candidates |', '|---|---|'];
  for (const [code, n] of Object.entries(summary.reasons).sort((a, b) => b[1] - a[1])) lines.push(`| ${code} | ${n} |`);
  lines.push('', '## Accepted', '', '| Symbol | Id | Metric | Period | Target | Revises | Excerpt |', '|---|---|---|---|---|---|---|');
  for (const r of results.filter((x) => x.decision === 'ACCEPTED')) {
    const p = r.candidate.promise;
    lines.push(`| ${r.candidate.symbol} | ${r.candidate.id} | ${p.metric} | ${p.targetPeriod} | ${p.operator} ${p.targetValue}${p.targetValueMax != null ? `-${p.targetValueMax}` : ''} ${p.targetUnit} | ${r.revisesPromiseId || ''} | ${String(r.candidate.promiseEvidence.excerpt).replace(/\|/g, '/').slice(0, 160)} |`);
  }
  return `${lines.join('\n')}\n`;
};

const parseArgs = (argv) => {
  const get = (flag) => {
    const eq = argv.find((a) => a.startsWith(`${flag}=`));
    if (eq) return eq.slice(flag.length + 1);
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : null;
  };
  return {
    expectTarget: get('--expect-target'),
    symbols: get('--symbols') ? get('--symbols').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) : null,
    dryRun: argv.includes('--dry-run'),
    concurrency: Number(get('--concurrency')) || 2,
    delayMs: get('--delay-ms') ? Number(get('--delay-ms')) : 600,
    label: get('--label') || 'auto-review',
    onlyUnreviewed: argv.includes('--only-unreviewed'),
  };
};

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  (async () => {
    dotenv.config({ path: path.join(BACKEND_DIR, '.env') });
    const args = parseArgs(process.argv.slice(2));
    if (!args.expectTarget) throw new Error('--expect-target <host>/<database> is required');
    process.env.INDIAN_API_KEY = ''; // no paid API from this gate
    const target = assertMongoTarget(process.env.MONGODB_URI, args.expectTarget);
    console.log(`Target database: ${target.label}${args.dryRun ? '  (DRY RUN: nothing is written)' : ''}`);
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });

    const { default: PromiseCandidate } = await import('../models/PromiseCandidate.js');
    const { fetchRawDocumentBuffer } = await import('../providers/ExchangeFilingDocumentProvider.js');
    const { extractPdfPages } = await import('../services/FactExtractionService.js');
    const { acceptCandidate } = await import('./earningsReview.js');

    // --only-unreviewed (the weekly cron): candidates the gate has never decided -- new or re-extracted ones,
    // since a re-extraction clears autoReview -- so a scheduled run never re-downloads settled decisions.
    const candidates = await PromiseCandidate.find({
      reviewStatus: 'PENDING_REVIEW',
      ...(args.symbols ? { symbol: { $in: args.symbols } } : {}),
      ...(args.onlyUnreviewed ? { autoReview: null } : {}),
    }).lean();
    console.log(`Candidates pending review${args.onlyUnreviewed ? ' (not yet gated)' : ''}: ${candidates.length}`);
    const { results, summary } = await reviewCandidates(candidates, {
      fetchPages: async (url) => extractPdfPages(await fetchRawDocumentBuffer(url)),
      published: readPublishedRecords(),
      concurrency: args.concurrency,
      delayMs: args.delayMs,
      log: (line) => console.log(line),
    });
    console.log(`Gate: ${JSON.stringify(summary)}`);

    const outDir = path.join(BACKEND_DIR, 'reports', 'earnings-coverage');
    fs.mkdirSync(outDir, { recursive: true });
    const base = path.join(outDir, `${args.label}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    const slim = results.map((r) => ({
      id: r.candidate.id, symbol: r.candidate.symbol, decision: r.decision, reasons: r.reasons || [], revisesPromiseId: r.revisesPromiseId || null, reiterationOf: r.reiterationOf || null,
      metric: r.candidate.promise.metric, period: r.candidate.promise.targetPeriod, extractionVersion: r.candidate.extractionVersion || null,
    }));
    fs.writeFileSync(`${base}.json`, JSON.stringify({ label: args.label, target: target.label, dryRun: args.dryRun, summary, results: slim }, null, 2));
    fs.writeFileSync(`${base}.md`, renderMarkdown({ label: args.label, target: target.label, summary, results }));
    console.log(`Report saved: ${path.relative(process.cwd(), `${base}.md`)} (+ .json)`);

    if (!args.dryRun) {
      const secret = process.env.EARNINGS_REVIEW_SECRET;
      let promoted = 0;
      const failures = [];
      // Record every decision first (so a human sees the reasons even for those not promoted).
      for (const r of results) {
        // eslint-disable-next-line no-await-in-loop
        await PromiseCandidate.updateOne({ _id: r.candidate._id, reviewStatus: 'PENDING_REVIEW' }, {
          $set: {
            autoReview: {
              checkedAt: new Date(), decision: r.decision, reasons: r.reasons || [], groupKey: r.groupKey || null, reiterationOf: r.reiterationOf || null, sourceVerified: r.sourceCheck ? Boolean(r.sourceCheck.found) : null,
            },
          },
        });
      }
      // Promote in statement order so a revision always links to a record that is already published.
      const accepted = results.filter((r) => r.decision === 'ACCEPTED').sort((a, b) => String(a.candidate.promise.promiseDate).localeCompare(String(b.candidate.promise.promiseDate)));
      for (const r of accepted) {
        if (r.revisesPromiseId) {
          // eslint-disable-next-line no-await-in-loop
          await PromiseCandidate.updateOne({ _id: r.candidate._id }, { $set: { 'promise.revisesPromiseId': r.revisesPromiseId } });
        }
        // eslint-disable-next-line no-await-in-loop
        const result = await acceptCandidate(r.candidate.symbol, r.candidate.id, {
          reviewer: GATE_REVIEWER,
          secret,
          evidenceIntegrity: {
            status: 'VERIFIED_EXCHANGE_COPY',
            notes: `Automated evidence gate: the excerpt was re-found verbatim on page ${r.candidate.promiseEvidence.pageNumber} of the exchange-hosted copy (${r.candidate.promiseEvidence.sourceUrl}) on ${new Date().toISOString().slice(0, 10)}; spoken by management; target value and unit written in the excerpt; metric and fiscal period stated in the excerpt or the sentences before it; the period was still in the future when stated.${r.revisesPromiseId ? ` Revises ${r.revisesPromiseId}.` : ''}`,
          },
        });
        if (result.ok) promoted += 1; else failures.push(`${r.candidate.id}: ${result.error}`);
      }
      console.log(`Promoted ${promoted} of ${accepted.length}.${failures.length ? ` Not promoted: ${failures.join(' | ')}` : ''}`);
    }
    await mongoose.disconnect();
    process.exit(0);
  })().catch(async (error) => {
    console.error('Review gate failed:', error.message);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
}
