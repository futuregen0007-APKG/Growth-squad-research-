import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyNseAnnouncement, fiscalYearOfAnnouncement, searchNseAnnouncements, registerNseFiling,
} from '../providers/NseAnnouncementProvider.js';
import { refererForDocument } from '../providers/ExchangeFilingDocumentProvider.js';
import { maxCandidateSequence } from '../scripts/backfillPromises.js';
import { extractPromisesFromPdfBuffer, PromiseExtractionFailure } from '../services/PromiseExtractionService.js';

/**
 * nseAnnouncementProvider.test.js
 * =================================
 * Pins how NSE announcement rows become earnings-call transcript filings, that
 * a document is registered once, and the two promise-stage guarantees this
 * work depends on: an extraction that could not run is a failure (never "no
 * guidance found"), and a resumed run never reuses a candidate id.
 */

const CALL = 'Analysts/Institutional Investor Meet/Con. Call Updates';
const pdf = (file) => `https://nsearchives.nseindia.com/corporate/${file}`;
const row = (over = {}) => ({
  symbol: 'ACME', sm_name: 'Acme Limited', desc: CALL, an_dt: '07-May-2026 20:09:41', attchmntFile: pdf('ACME_07052026200941_Transcript.pdf'), attchmntText: 'Transcript of the Earnings Call for the quarter and financial year ended 31st March, 2026', seq_id: '1', ...over,
});

test('only a transcript announcement with a PDF is classified; intimations, audio links and other categories are not', () => {
  assert.equal(classifyNseAnnouncement(row()), 'EARNINGS_CALL_TRANSCRIPT');
  assert.equal(classifyNseAnnouncement(row({ attchmntText: 'Acme Limited has informed the Exchange about Transcript' })), 'EARNINGS_CALL_TRANSCRIPT');
  assert.equal(classifyNseAnnouncement(row({ attchmntText: 'Acme Limited has informed the Exchange about Schedule of Analyst/Institutional Investor Meet' })), null, 'a schedule notice');
  assert.equal(classifyNseAnnouncement(row({ desc: 'Outcome of Board Meeting' })), null, 'other category');
  assert.equal(classifyNseAnnouncement(row({ desc: 'General Updates' })), null);

  // 2022 wording: the category itself names the transcript, whatever the text says.
  const OLD = 'Transcript of Analysts/Institutional Investor Meet/Con. Call';
  assert.equal(classifyNseAnnouncement(row({ desc: OLD, attchmntText: 'Acme Limited has informed the Exchange about Transcript of Analysts/Institutional Investor Meet/Con. Call' })), 'EARNINGS_CALL_TRANSCRIPT');
  assert.equal(classifyNseAnnouncement(row({ desc: OLD, attchmntText: 'Acme Limited has informed the Exchange about the call' })), 'EARNINGS_CALL_TRANSCRIPT');
  assert.equal(classifyNseAnnouncement(row({ desc: 'Schedule of Analysts/Institutional Investor Meet/Con. Call', attchmntText: 'Acme Limited has informed the Exchange about Schedule of meet' })), null, '2022 schedule notice');
  assert.equal(classifyNseAnnouncement(row({ desc: 'Audio/Video recording of Analysts/Institutional Investor Meet/Con. Call', attchmntText: 'Link of Recording' })), null, 'a recording link');
  assert.equal(classifyNseAnnouncement(row({ attchmntFile: pdf('ACME_x.xml') })), null, 'not a PDF');
  assert.equal(classifyNseAnnouncement(row({ attchmntFile: null })), null);
  assert.equal(classifyNseAnnouncement(null), null);
});

test('the fiscal year comes from the period the announcement names, else from the filing date', () => {
  assert.equal(fiscalYearOfAnnouncement(row()), 2026, 'year ended 31st March, 2026');
  assert.equal(fiscalYearOfAnnouncement(row({ attchmntText: 'Transcript for the quarter ended 31st December, 2025', an_dt: '19-Feb-2026 19:12:46' })), 2026, 'December quarter belongs to the FY ending the next March');
  assert.equal(fiscalYearOfAnnouncement(row({ attchmntText: 'Transcript for the quarter and half year ended 30th September, 2025', an_dt: '29-Oct-2025 17:25:38' })), 2026);
  assert.equal(fiscalYearOfAnnouncement(row({ attchmntText: 'quarter ended June 30, 2025', an_dt: '07-Aug-2025 15:00:40' })), 2026, 'month-first date');
  assert.equal(fiscalYearOfAnnouncement(row({ attchmntText: 'Transcript of Analyst meet for Q2 FY26 held on 04.11.2025', an_dt: '12-Nov-2025 18:12:48' })), 2026, 'Q2 FY26');
  assert.equal(fiscalYearOfAnnouncement(row({ attchmntText: 'Transcript for Q4 FY2025', an_dt: '03-Jul-2025 10:00:00' })), 2025, 'a late upload keeps the period it names');

  // No period named: the filing date decides.
  assert.equal(fiscalYearOfAnnouncement(row({ attchmntText: 'Acme has informed the Exchange about Transcript', an_dt: '14-Apr-2026 20:01:32' })), 2026);
  assert.equal(fiscalYearOfAnnouncement(row({ attchmntText: 'Acme has informed the Exchange about Transcript', an_dt: '14-Jul-2025 19:06:35' })), 2026);
  assert.equal(fiscalYearOfAnnouncement(row({ attchmntText: 'Acme has informed the Exchange about Transcript', an_dt: '30-Jun-2025 10:00:00' })), 2025);
  assert.equal(fiscalYearOfAnnouncement(row({ attchmntText: 'about Transcript', an_dt: 'garbage' })), null);
});

test('discovery asks one window per fiscal year, keeps transcripts inside the range, and drops duplicates', async () => {
  const windows = [];
  const fetchRows = async (symbol, from, to) => {
    windows.push([symbol, from.toISOString().slice(0, 10), to.toISOString().slice(0, 10)]);
    if (from.getUTCFullYear() === 2025) {
      return [
        row(),
        row({ attchmntFile: pdf('ACME_dup.pdf') }),
        row({ attchmntFile: pdf('ACME_dup.pdf') }),
        row({ desc: 'General Updates', attchmntFile: pdf('ACME_other.pdf') }),
      ];
    }
    return [];
  };
  const { filings, rowsSeen } = await searchNseAnnouncements('ZOMATO', { fromYear: 2025, toYear: 2026, fetchRows });

  assert.deepEqual(windows, [['ETERNAL', '2024-07-01', '2025-06-30'], ['ETERNAL', '2025-07-01', '2026-06-30']], 'a renamed company is asked for under its NSE name');
  assert.equal(rowsSeen, 4);
  assert.equal(filings.length, 2, 'the duplicate URL and the non-transcript are dropped');
  assert.equal(filings[0].symbol, 'ZOMATO', 'stored under the supported symbol');
  assert.equal(filings[0].fiscalYear, 'FY2026');
  assert.equal(filings[0].documentType, 'EARNINGS_CALL_TRANSCRIPT');
  assert.equal(filings[0].exchange, 'NSE');
  assert.equal(filings[0].fallbackUrl, null);
  assert.equal(filings[0].publicationDate.toISOString().slice(0, 10), '2026-05-07');
});

test('a transcript outside the requested fiscal years is not returned', async () => {
  const fetchRows = async () => [row({ attchmntText: 'quarter ended 31st March, 2021', an_dt: '20-May-2021 10:00:00' })];
  const { filings } = await searchNseAnnouncements('ACME', { fromYear: 2022, toYear: 2022, fetchRows });
  assert.equal(filings.length, 0);
});

// ---------------------------------------------------------------------------
// registerNseFiling
// ---------------------------------------------------------------------------

const memoryRegistry = () => {
  const docs = new Map();
  return {
    docs,
    findByUrl: async (symbol, url) => docs.get(`${symbol}|${url}`) || null,
    findByHash: async (symbol, hash, url) => [...docs.values()].find((d) => d.symbol === symbol && d.pdfHash === hash && d.url !== url && ['FETCHED', 'EXTRACTED'].includes(d.extractionStatus)) || null,
    upsert: async (symbol, url, fields, onInsert) => {
      const key = `${symbol}|${url}`;
      const merged = { ...(docs.get(key) || { symbol, url, ...(onInsert || {}) }), ...fields };
      docs.set(key, merged);
      return merged;
    },
  };
};

const FILING = {
  symbol: 'ACME', companyName: 'Acme Limited', fiscalYear: 'FY2026', documentType: 'EARNINGS_CALL_TRANSCRIPT', url: pdf('a.pdf'), publicationDate: new Date('2026-05-07T00:00:00Z'),
};
const noPersist = async () => ({ storageKey: null, storageBackend: null });
const PDF_BYTES = Buffer.from('%PDF-1.7 fake body one');

test('a new transcript is downloaded once, hashed and registered with the promise stage still to run', async () => {
  const registry = memoryRegistry();
  let downloads = 0;
  const result = await registerNseFiling(FILING, { download: async () => { downloads += 1; return PDF_BYTES; }, registry, persist: noPersist });
  assert.equal(result.status, 'REGISTERED');
  assert.equal(result.buffer, PDF_BYTES, 'the bytes are handed back so the promise stage need not download again');
  const doc = registry.docs.get(`ACME|${FILING.url}`);
  assert.equal(doc.extractionStatus, 'EXTRACTED');
  assert.equal(doc.factsExtracted, 0);
  assert.equal(doc.promiseExtractionStatus, 'PENDING');
  assert.equal(doc.sourceType, 'EARNINGS_CALL_TRANSCRIPT');
  assert.match(doc.pdfHash, /^[0-9a-f]{64}$/);

  const again = await registerNseFiling(FILING, { download: async () => { downloads += 1; return PDF_BYTES; }, registry, persist: noPersist });
  assert.equal(again.status, 'ALREADY_REGISTERED');
  assert.equal(downloads, 1, 'never downloaded twice');
});

test('the same bytes under a second URL are not registered twice', async () => {
  const registry = memoryRegistry();
  await registerNseFiling(FILING, { download: async () => PDF_BYTES, registry, persist: noPersist });
  const copy = await registerNseFiling({ ...FILING, url: pdf('a_signed_copy.pdf') }, { download: async () => PDF_BYTES, registry, persist: noPersist });
  assert.equal(copy.status, 'DUPLICATE_CONTENT');
  assert.equal(registry.docs.size, 1);
});

test('a failed download or a non-PDF is recorded as FAILED with its reason, and is retried next time', async () => {
  const registry = memoryRegistry();
  const failed = await registerNseFiling(FILING, { download: async () => { throw new Error('HTTP 503'); }, registry, persist: noPersist });
  assert.equal(failed.status, 'DOWNLOAD_FAILED');
  assert.equal(registry.docs.get(`ACME|${FILING.url}`).extractionStatus, 'FAILED');
  assert.equal(registry.docs.get(`ACME|${FILING.url}`).error, 'HTTP 503');

  const notPdf = await registerNseFiling({ ...FILING, url: pdf('b.pdf') }, { download: async () => Buffer.from('<html>blocked</html>'), registry, persist: noPersist });
  assert.equal(notPdf.status, 'NOT_A_PDF');

  const retried = await registerNseFiling(FILING, { download: async () => PDF_BYTES, registry, persist: noPersist });
  assert.equal(retried.status, 'REGISTERED', 'a FAILED row is retried, not skipped');
  assert.equal(registry.docs.get(`ACME|${FILING.url}`).extractionStatus, 'EXTRACTED');
});

test('NSE documents are fetched with the NSE referer, BSE documents with the BSE one', () => {
  assert.equal(refererForDocument('https://nsearchives.nseindia.com/corporate/x.pdf'), 'https://www.nseindia.com/');
  assert.equal(refererForDocument('https://www.bseindia.com/xml-data/corpfiling/AttachLive/x.pdf'), 'https://www.bseindia.com/');
  assert.equal(refererForDocument('not a url'), 'https://www.bseindia.com/');
});

// ---------------------------------------------------------------------------
// Promise-stage guarantees
// ---------------------------------------------------------------------------

test('a resumed promise run continues after the highest candidate id, not the number of documents', () => {
  assert.equal(maxCandidateSequence([]), 0);
  assert.equal(maxCandidateSequence(['ACME-FY2027-CAND-001', 'ACME-FY2028-CAND-007', 'ACME-FY2027-CAND-004']), 7);
  assert.equal(maxCandidateSequence(['ACME-CURATED', null, undefined, 'x-CAND-']), 0, 'ids that do not follow the pattern are ignored');
});

/** A valid one-page PDF: `lines` become text, or the page holds only a drawn box when `lines` is empty. */
const makePdf = (lines) => {
  const stream = lines.length
    ? `BT /F1 11 Tf 40 750 Td 14 TL ${lines.map((l) => `(${l}) '`).join(' ')} ET`
    : '10 10 50 50 re f';
  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ];
  let body = '%PDF-1.4\n';
  const offsets = objects.map((object, i) => {
    const at = body.length;
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
    return at;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer\n<</Root 1 0 R/Size ${objects.length + 1}>>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(body, 'latin1');
};

const CONTEXT = {
  symbol: 'ACME', companyName: 'Acme', sourceType: 'EARNINGS_CALL_TRANSCRIPT', url: 'u', title: 't',
};

test('extraction that cannot run is a failure, never an empty result that reads as "no guidance found"', async () => {
  const savedKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const guidance = Array.from({ length: 8 }, () => 'We expect revenue guidance for FY2027 of at least 5000 crore and a margin target of 20 percent.');
    await assert.rejects(() => extractPromisesFromPdfBuffer(makePdf(guidance), CONTEXT), PromiseExtractionFailure);
  } finally {
    if (savedKey !== undefined) process.env.OPENAI_API_KEY = savedKey;
  }
});

test('a PDF with no text layer is a failure, not a document with no guidance', async () => {
  await assert.rejects(() => extractPromisesFromPdfBuffer(makePdf([]), CONTEXT), /no extractable text layer/);
});

test('a readable document with no guidance keywords is a finding (empty), not a failure', async () => {
  const smallTalk = Array.from({ length: 8 }, () => 'Thank you all for joining the call and good morning to everyone on the line today.');
  assert.deepEqual(await extractPromisesFromPdfBuffer(makePdf(smallTalk), CONTEXT), []);
});
