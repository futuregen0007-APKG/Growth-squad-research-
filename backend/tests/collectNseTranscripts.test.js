import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planTranscriptBatch, shouldStopTranscripts, processSymbol, MAX_CONSECUTIVE_FAILURES, estimateModelCostUsd, discoveryRecord,
} from '../scripts/collectNseTranscripts.js';

/**
 * collectNseTranscripts.test.js
 * ================================
 * The transcript runner decides what to do next from the database and reports
 * what it found; these pin the selection, the stop rules, and that a
 * document's bytes are downloaded once, duplicates are not counted twice, and
 * "found nothing" stays apart from "could not look".
 */

const row = (symbol, promiseStage = 'NOT_RUN', registry = {}, lastGuidanceDiscoveryAt = null) => ({
  symbol, promiseStage, registry: { promisePending: 0, promiseFailed: 0, ...registry }, profile: { researchEnabled: true, lastGuidanceDiscoveryAt },
});

test('fair rotation: never-attempted companies first, then the least recently attempted, settled companies included', () => {
  const rows = [
    row('SETTLED_OLD', 'EXTRACTED_NONE_FOUND', {}, '2026-01-01T00:00:00Z'),
    row('NEVER_B'),
    row('RECENT', 'NOT_RUN', {}, '2026-09-30T00:00:00Z'),
    row('NEVER_A', 'CANDIDATES_PENDING_REVIEW', { promisePending: 2 }),
    row('MIDDLE', 'ACCEPTED_PRESENT', { promiseFailed: 1 }, '2026-06-01T00:00:00Z'),
  ];
  // A settled company is revisited (its next quarter's call must be found); it just waits its turn.
  assert.deepEqual(planTranscriptBatch(rows, { batchSize: 10 }), ['NEVER_A', 'NEVER_B', 'SETTLED_OLD', 'MIDDLE', 'RECENT']);
});

test('on a tie in last attempt, unsettled companies go before settled ones, then alphabetically', () => {
  const at = '2026-05-01T00:00:00Z';
  const rows = [row('B_SETTLED', 'EXTRACTED_NONE_FOUND', {}, at), row('C_UNSETTLED', 'NOT_RUN', {}, at), row('A_SETTLED', 'ACCEPTED_PRESENT', {}, at)];
  assert.deepEqual(planTranscriptBatch(rows, { batchSize: 10 }), ['C_UNSETTLED', 'A_SETTLED', 'B_SETTLED']);
});

test('consecutive bounded runs never re-select the same companies once each attempt is recorded', () => {
  let clock = Date.parse('2026-10-01T00:00:00Z');
  const rows = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE'].map((s) => row(s, 'NOT_RUN'));
  const seen = [];
  for (let run = 0; run < 3; run += 1) {
    const batch = planTranscriptBatch(rows, { batchSize: 2 });
    seen.push(batch);
    // What the collector writes after each company (discoveryRecord): a newer attempt timestamp.
    for (const symbol of batch) { clock += 1000; rows.find((r) => r.symbol === symbol).profile.lastGuidanceDiscoveryAt = new Date(clock).toISOString(); }
  }
  assert.deepEqual(seen, [['AAA', 'BBB'], ['CCC', 'DDD'], ['EEE', 'AAA']]);
});

test('priority order, batch size, attempted companies and an explicit list are honoured', () => {
  const rows = [row('AAA'), row('BBB'), row('CCC'), row('DDD', 'EXTRACTED_NONE_FOUND')];
  assert.deepEqual(planTranscriptBatch(rows, { batchSize: 10, priority: ['CCC', 'BBB'] }), ['CCC', 'BBB', 'AAA', 'DDD']);
  assert.deepEqual(planTranscriptBatch(rows, { batchSize: 2 }), ['AAA', 'BBB']);
  assert.deepEqual(planTranscriptBatch(rows, { batchSize: 10, attempted: new Set(['AAA']) }), ['BBB', 'CCC', 'DDD']);
  assert.deepEqual(planTranscriptBatch(rows, { batchSize: 10, explicit: ['DDD', 'ZZZ', 'AAA'] }), ['DDD', 'AAA']);
});

test('discoveryRecord records the attempt time and an honest result: no documents, error, and counts by type', () => {
  const at = new Date('2026-10-03T00:00:00Z');
  const record = discoveryRecord({
    discovered: 0, byType: {}, registered: 0, duplicates: 0, downloadFailed: 0, promiseDocsProcessed: 0, noGuidanceDocs: 0, promiseFailures: 0, candidates: 0, noTranscripts: true, error: null,
  }, at);
  assert.equal(record.lastGuidanceDiscoveryAt, at);
  assert.equal(record.lastGuidanceDiscoveryResult.noDocuments, true);
  assert.equal(record.lastGuidanceDiscoveryResult.error, null);
  const failed = discoveryRecord({ discovered: 0, error: 'discovery failed: NSE returned a non-JSON page', noTranscripts: false }, at);
  assert.match(failed.lastGuidanceDiscoveryResult.error, /non-JSON/);
});

test('the run stops on repeated failure, the time budget or the batch limit, and otherwise continues', () => {
  assert.equal(shouldStopTranscripts({}), null);
  assert.match(shouldStopTranscripts({ consecutiveFailures: MAX_CONSECUTIVE_FAILURES }), /in a row failed/);
  assert.match(shouldStopTranscripts({ elapsedMs: 61000, maxRuntimeMs: 60000 }), /max-runtime-min/);
  assert.match(shouldStopTranscripts({ batchesDone: 3, maxBatches: 3 }), /max-batches/);
  assert.equal(shouldStopTranscripts({ consecutiveFailures: MAX_CONSECUTIVE_FAILURES - 1, elapsedMs: 1, maxRuntimeMs: 60000 }), null);
});

test('the run stops once the explicit --max-cost-usd budget is reached, and a zero budget means unlimited', () => {
  assert.equal(shouldStopTranscripts({ estimatedUsd: 0.5, maxCostUsd: 0 }), null, 'no cap configured -> never stops on cost');
  assert.equal(shouldStopTranscripts({ estimatedUsd: 0.49, maxCostUsd: 0.5 }), null, 'under budget -> continue');
  assert.match(shouldStopTranscripts({ estimatedUsd: 0.5, maxCostUsd: 0.5 }), /max-cost-usd/, 'at the cap -> stop, not just over it');
  assert.match(shouldStopTranscripts({ estimatedUsd: 1.2, maxCostUsd: 0.5 }), /max-cost-usd/);
});

test('estimateModelCostUsd prices prompt and completion tokens separately at gpt-4o-mini list rates', () => {
  assert.equal(estimateModelCostUsd({ promptTokens: 0, completionTokens: 0 }), 0);
  // 1,000,000 prompt tokens -> $0.15; 1,000,000 completion tokens -> $0.60
  assert.equal(estimateModelCostUsd({ promptTokens: 1_000_000, completionTokens: 0 }), 0.15);
  assert.equal(estimateModelCostUsd({ promptTokens: 0, completionTokens: 1_000_000 }), 0.60);
  assert.equal(estimateModelCostUsd({ promptTokens: 500_000, completionTokens: 250_000 }), 0.225);
});

// ---------------------------------------------------------------------------
// processSymbol
// ---------------------------------------------------------------------------

const filing = (fiscalYear, n) => ({ symbol: 'ACME', fiscalYear, url: `https://nsearchives.nseindia.com/corporate/${fiscalYear}_${n}.pdf` });
const FILINGS = [filing('FY2025', 1), filing('FY2025', 2), filing('FY2026', 1), filing('FY2026', 2)];

const harness = (over = {}) => {
  const calls = { register: [], promises: [] };
  const deps = {
    fromYear: 2025,
    toYear: 2026,
    delayMs: 0,
    discover: async () => ({ filings: FILINGS, rowsSeen: 400 }),
    register: async (f) => {
      calls.register.push(f.url);
      return { status: 'REGISTERED', buffer: Buffer.from(`pdf:${f.url}`) };
    },
    runPromises: async (symbol, options) => {
      calls.promises.push({ symbol, sample: await options.getBuffer({ url: FILINGS[0].url }), missing: await options.getBuffer({ url: 'https://elsewhere/x.pdf' }) });
      return { documentsProcessed: 4, documentsWithNoGuidance: 3, candidatesSaved: 5, errors: [] };
    },
    ...over,
  };
  return { deps, calls };
};

test('a company is discovered, registered once per document, and its promise stage reuses the downloaded bytes', async () => {
  const { deps, calls } = harness();
  const result = await processSymbol('ACME', deps);
  assert.equal(result.discovered, 4);
  assert.deepEqual(result.byFiscalYear, { FY2025: 2, FY2026: 2 });
  assert.equal(result.registered, 4);
  assert.equal(calls.register.length, 4);
  assert.equal(result.promiseDocsProcessed, 4);
  assert.equal(result.noGuidanceDocs, 3, 'read in full, nothing qualified: recorded apart from failures');
  assert.equal(result.candidates, 5);
  assert.equal(result.promiseFailures, 0);
  assert.equal(result.error, null);
  assert.equal(calls.promises[0].sample.source, 'IN_MEMORY');
  assert.equal(calls.promises[0].sample.buffer.toString(), `pdf:${FILINGS[0].url}`);
  assert.equal(calls.promises[0].missing, null, 'a document not downloaded this pass is left to the pipeline to fetch');
});

test('already-registered, duplicate and failed downloads are counted separately and only new bytes are kept', async () => {
  const statuses = ['REGISTERED', 'ALREADY_REGISTERED', 'DUPLICATE_CONTENT', 'DOWNLOAD_FAILED'];
  const { deps, calls } = harness({
    register: async (f) => {
      const status = statuses.shift();
      return status === 'REGISTERED' ? { status, buffer: Buffer.from('x') } : { status, error: status === 'DOWNLOAD_FAILED' ? 'HTTP 503' : undefined };
    },
  });
  const result = await processSymbol('ACME', deps);
  assert.deepEqual([result.registered, result.alreadyRegistered, result.duplicates, result.downloadFailed], [1, 1, 1, 1]);
  assert.deepEqual(result.errors, [{ url: FILINGS[3].url, error: 'HTTP 503' }]);
  assert.equal(calls.promises.length, 1);
});

test('a second, later run discovers a genuinely new filing for an already-processed company: the old ones are ALREADY_REGISTERED and only the new one is registered and promise-extracted', async () => {
  // A stateful fake registry, shared across two sequential processSymbol calls, standing in for the real
  // CompanyDocumentRegistry collection: registering the same URL twice must not download or extract it twice.
  const registeredUrls = new Set();
  const promiseRuns = [];
  const makeDeps = (filings) => ({
    fromYear: 2025,
    toYear: 2026,
    delayMs: 0,
    discover: async () => ({ filings, rowsSeen: filings.length }),
    register: async (f) => {
      if (registeredUrls.has(f.url)) return { status: 'ALREADY_REGISTERED' };
      registeredUrls.add(f.url);
      return { status: 'REGISTERED', buffer: Buffer.from(`pdf:${f.url}`) };
    },
    runPromises: async (symbol) => {
      promiseRuns.push(symbol);
      return { documentsProcessed: 1, documentsWithNoGuidance: 0, candidatesSaved: 1, errors: [] };
    },
  });

  // Run 1: NSE's feed currently holds one transcript. It is discovered and registered.
  const firstRun = await processSymbol('ACME', makeDeps([FILINGS[0]]));
  assert.equal(firstRun.registered, 1);
  assert.equal(firstRun.alreadyRegistered, 0);
  assert.equal(promiseRuns.length, 1);

  // Run 2 (a later scheduled run): NSE has since filed a new transcript alongside the old one.
  const secondRun = await processSymbol('ACME', makeDeps([FILINGS[0], FILINGS[1]]));
  assert.equal(secondRun.discovered, 2, 'both the old and the newly-filed document are discovered');
  assert.equal(secondRun.registered, 1, 'only the genuinely new filing is registered');
  assert.equal(secondRun.alreadyRegistered, 1, 'the previously-processed filing is recognised, not re-downloaded');
  assert.equal(promiseRuns.length, 2, 'the promise stage still runs on the second pass, to read the newly-registered document');
});

test('a company with no transcripts is reported as that, not as a failure and not as "no guidance"', async () => {
  // The promise stage still runs (it resumes documents registered earlier); with none on file it reads nothing.
  const { deps, calls } = harness({
    discover: async () => ({ filings: [], rowsSeen: 120 }),
    runPromises: async () => ({
      documentsProcessed: 0, documentsWithNoGuidance: 0, candidatesSaved: 0, errors: [],
    }),
  });
  const result = await processSymbol('ACME', deps);
  assert.equal(result.noTranscripts, true);
  assert.equal(result.error, null);
  assert.equal(result.noGuidanceDocs, 0);
  assert.equal(calls.register.length, 0);
});

test('a discovery error is returned as an error and nothing is registered', async () => {
  const { deps, calls } = harness({ discover: async () => { throw new Error('NSE returned a non-JSON page'); } });
  const result = await processSymbol('ACME', deps);
  assert.match(result.error, /discovery failed: NSE returned a non-JSON page/);
  assert.equal(result.noTranscripts, false);
  assert.equal(calls.register.length, 0);
});

test('failed promise documents are reported as failures, separate from documents with no guidance', async () => {
  const { deps } = harness({
    runPromises: async () => ({
      documentsProcessed: 2, documentsWithNoGuidance: 2, candidatesSaved: 0, errors: [{ url: 'u', error: 'OpenAI is not configured' }, { url: 'v', error: 'Timed out after 120000ms' }],
    }),
  });
  const result = await processSymbol('ACME', deps);
  assert.equal(result.noGuidanceDocs, 2);
  assert.equal(result.promiseFailures, 2);
  assert.equal(result.errors.length, 2);
});

test('a dry run discovers only: nothing is downloaded, registered or extracted', async () => {
  const { deps, calls } = harness({ dryRun: true });
  const result = await processSymbol('ACME', deps);
  assert.equal(result.discovered, 4);
  assert.equal(calls.register.length, 0);
  assert.equal(calls.promises.length, 0);
});

test('--skip-promises registers documents but does not run the promise stage', async () => {
  const { deps, calls } = harness({ skipPromises: true });
  const result = await processSymbol('ACME', deps);
  assert.equal(result.registered, 4);
  assert.equal(calls.promises.length, 0);
});

test('--max-docs-per-symbol keeps the most recent documents', async () => {
  const { deps, calls } = harness({ maxDocs: 2 });
  const result = await processSymbol('ACME', deps);
  assert.equal(result.discovered, 2);
  assert.deepEqual(calls.register, [FILINGS[2].url, FILINGS[3].url]);
});
