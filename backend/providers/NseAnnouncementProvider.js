/**
 * NseAnnouncementProvider.js
 * ============================
 * Document discovery from NSE's own corporate-announcements API
 * (`/api/corporate-announcements`), for when the BSE announcement API
 * (`api.bseindia.com`, which ExchangeFilingDocumentProvider uses) refuses this
 * client. Every result is a real filing the company itself submitted to the
 * exchange, with the exchange-hosted PDF link (`nsearchives.nseindia.com`)
 * and the announcement's own timestamp; no URL is built or guessed.
 *
 * WHAT IT DISCOVERS. Earnings-call transcripts: announcements filed under
 * "Analysts/Institutional Investor Meet/Con. Call Updates" whose text says
 * "Transcript". Those are the documents where management states forward
 * guidance, so they feed the existing promise-extraction stage
 * (scripts/backfillPromises.js). Financial figures are NOT taken from these
 * PDFs: the verified route for those is the exchange's XBRL filings
 * (services/NseXbrlService.js), where each number is read from a tagged field
 * for an exact period rather than parsed from prose.
 *
 * FISCAL YEAR. A transcript is filed within weeks of the results call it
 * records, so its fiscal year is that of the period it discusses: the period
 * the announcement text names ("quarter ended 31st December, 2025", "Q2 FY26"),
 * otherwise the fiscal year its filing date falls in (Jul..Dec -> next FY,
 * Jan..Jun -> that FY).
 */
import axios from 'axios';
import { CompanyDocumentRegistry } from '../models/CompanyDocumentRegistry.js';
import { Semaphore } from '../utils/semaphore.js';
import { logger } from '../utils/logger.js';
import { saveDocument } from '../services/DocumentStorageService.js';
import { fetchRawDocumentBuffer, hashDocumentContent, withRetry } from './ExchangeFilingDocumentProvider.js';
import { parseNseDate, nseSymbolFor, NSE_REQUEST_HEADERS } from '../services/NseXbrlService.js';

const NSE_ANNOUNCEMENTS_URL = 'https://www.nseindia.com/api/corporate-announcements';

// One discovery request at a time: NSE's public API is the shared resource here.
let discoverySemaphore = new Semaphore(1);
export const configureNseDiscoveryConcurrency = (n) => { if (n) discoverySemaphore = new Semaphore(n); };

export class NseAnnouncementsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NseAnnouncementsError';
  }
}

// NSE's category for these filings changed name: "Analysts/Institutional Investor Meet/Con. Call Updates"
// (text says whether it is a transcript) in recent years, and "Transcript of Analysts/Institutional Investor
// Meet/Con. Call" (the category itself says so) in 2022. Schedules and recordings share the family, so the
// family alone is never enough.
const CALL_FAMILY = /analysts?\s*\/\s*institutional\s+investors?\s+meet\s*\/\s*con\.?\s*call/i;
const TRANSCRIPT_LEADING_CATEGORY = /^\s*transcript\s+of\b/i;
const MONTH_INDEX = Object.freeze({
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
});

/**
 * classifyNseAnnouncement - the supported document type of one announcement
 * row, or null. Deliberately narrow: an intimation of a call, an audio link or
 * a results letter is not a transcript, and a row without a PDF cannot be
 * downloaded.
 */
// An investor / analyst / earnings presentation filed as a document -- the deck itself. Companies file it
// under "Updates", "Investor Presentation" or the analyst-meet family. Excluded: an intimation or schedule
// of a meeting (the PDF is a cover letter, not the deck) and a recording.
const PRESENTATION_TEXT = /\b(?:investors?|analysts?|earnings|results|corporate)\s+(?:day\s+)?presentation\b/i;
const PRESENTATION_CATEGORY = /^\s*(?:updates|investor presentation|analysts?\/institutional investors? meet|general updates)\b/i;
const NOT_A_DECK = /\b(?:intimation|schedule[d]?|invitation|invite|will be (?:held|made)|to be held|audio|video|recording|link)\b/i;

export const classifyNseAnnouncement = (row) => {
  if (!row || !/\.pdf$/i.test(String(row.attchmntFile || ''))) return null;
  const category = String(row.desc || '');
  const text = String(row.attchmntText || '');
  if (CALL_FAMILY.test(category) && (TRANSCRIPT_LEADING_CATEGORY.test(category) || /transcript/i.test(text))) return 'EARNINGS_CALL_TRANSCRIPT';
  if ((PRESENTATION_CATEGORY.test(category) || CALL_FAMILY.test(category)) && PRESENTATION_TEXT.test(`${category} ${text}`) && !NOT_A_DECK.test(text)) return 'INVESTOR_PRESENTATION';
  return null;
};

/** Every document type this provider can discover (transcripts and presentations). */
export const NSE_GUIDANCE_DOCUMENT_TYPES = Object.freeze(['EARNINGS_CALL_TRANSCRIPT', 'INVESTOR_PRESENTATION']);

const fiscalYearOfDate = (date) => date.getUTCFullYear() + (date.getUTCMonth() >= 6 ? 1 : 0);

/** The fiscal year the announcement text says the call was about, or null. */
const fiscalYearNamedInText = (text) => {
  const dayFirst = text.match(/ended\s+(?:on\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})/i);
  const monthFirst = text.match(/ended\s+(?:on\s+)?([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/i);
  const named = dayFirst ? { month: dayFirst[2], year: dayFirst[3] } : monthFirst ? { month: monthFirst[1], year: monthFirst[3] } : null;
  if (named) {
    const month = MONTH_INDEX[named.month.slice(0, 3).toLowerCase()];
    if (month !== undefined) return Number(named.year) + (month >= 3 ? 1 : 0);
  }
  const quarter = text.match(/\bQ[1-4]\s*FY\s*'?(\d{4}|\d{2})\b/i);
  if (quarter) return quarter[1].length === 2 ? 2000 + Number(quarter[1]) : Number(quarter[1]);
  return null;
};

/** fiscalYearOfAnnouncement - the fiscal year (number) a transcript announcement belongs to, or null if its date is unreadable. */
export const fiscalYearOfAnnouncement = (row) => {
  const named = fiscalYearNamedInText(String(row?.attchmntText || ''));
  if (named) return named;
  const filed = parseNseDate(row?.an_dt);
  return filed ? fiscalYearOfDate(filed) : null;
};

const ddmmyyyy = (date) => `${String(date.getUTCDate()).padStart(2, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${date.getUTCFullYear()}`;

/** Every announcement NSE lists for `nseSymbol` between two dates. Throws NseAnnouncementsError if the reply is not the expected list (e.g. a challenge page). */
export const fetchNseAnnouncementRows = async (nseSymbol, from, to) => {
  const response = await discoverySemaphore.run(() => withRetry(() => axios.get(NSE_ANNOUNCEMENTS_URL, {
    params: {
      index: 'equities', symbol: nseSymbol, from_date: ddmmyyyy(from), to_date: ddmmyyyy(to),
    },
    headers: NSE_REQUEST_HEADERS,
    timeout: 45000,
  })));
  if (!Array.isArray(response.data)) {
    throw new NseAnnouncementsError(`NSE returned ${typeof response.data === 'string' ? 'a non-JSON page' : 'an unexpected body'} instead of an announcement list`);
  }
  return response.data;
};

/**
 * searchNseAnnouncements - the supported documents NSE lists for `symbol` in
 * fiscal years fromYear..toYear, in the filing shape the existing pipeline
 * uses. One request per fiscal-year window (Jul 1 of the prior year to Jun 30),
 * which keeps each reply small and a failed window attributable.
 */
export const searchNseAnnouncements = async (symbol, {
  fromYear, toYear, documentTypes = ['EARNINGS_CALL_TRANSCRIPT'], fetchRows = fetchNseAnnouncementRows,
} = {}) => {
  const normalized = String(symbol || '').toUpperCase();
  const nseSymbol = nseSymbolFor(normalized);
  const filings = new Map();
  let rowsSeen = 0;

  for (let year = fromYear; year <= toYear; year += 1) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await fetchRows(nseSymbol, new Date(Date.UTC(year - 1, 6, 1)), new Date(Date.UTC(year, 5, 30)));
    rowsSeen += rows.length;
    for (const row of rows) {
      const documentType = classifyNseAnnouncement(row);
      if (!documentType || !documentTypes.includes(documentType)) continue;
      const fiscalYear = fiscalYearOfAnnouncement(row);
      const published = parseNseDate(row.an_dt);
      if (fiscalYear == null || !published || fiscalYear < fromYear || fiscalYear > toYear) continue;
      if (filings.has(row.attchmntFile)) continue;
      filings.set(row.attchmntFile, {
        symbol: normalized,
        nseSymbol,
        companyName: row.sm_name || normalized,
        fiscalYear: `FY${fiscalYear}`,
        documentType,
        title: String(row.attchmntText || '').replace(/\s+/g, ' ').trim(),
        url: row.attchmntFile,
        fallbackUrl: null,
        publicationDate: published,
        exchange: 'NSE',
        announcementSeqId: row.seq_id || null,
      });
    }
  }
  return { filings: [...filings.values()].sort((a, b) => a.publicationDate - b.publicationDate), rowsSeen };
};

const defaultRegistry = {
  findByUrl: (symbol, url) => CompanyDocumentRegistry.findOne({ symbol, url }).lean(),
  findByHash: (symbol, pdfHash, url) => CompanyDocumentRegistry.findOne({
    symbol, pdfHash, url: { $ne: url }, extractionStatus: { $in: ['FETCHED', 'EXTRACTED'] },
  }).lean(),
  upsert: (symbol, url, fields, onInsert = null) => CompanyDocumentRegistry.findOneAndUpdate(
    { symbol, url },
    onInsert && Object.keys(onInsert).length ? { $set: fields, $setOnInsert: onInsert } : { $set: fields },
    { upsert: true, new: true },
  ).lean(),
};

/**
 * registerNseFiling - downloads one filing's PDF once and records it in
 * CompanyDocumentRegistry. Returns { status, registryDoc, buffer }.
 *
 * The registry row is written as EXTRACTED with factsExtracted 0: for these
 * documents the fact-extraction stage does not apply (see the header), and the
 * promise stage selects EXTRACTED rows. A document whose bytes equal one
 * already registered for the company under another URL (a re-filed copy) is
 * not registered again, so its guidance is never counted twice. A download or
 * non-PDF failure is recorded as FAILED with its reason, never skipped
 * silently.
 */
export const registerNseFiling = async (filing, {
  download = fetchRawDocumentBuffer, registry = defaultRegistry, persist = saveDocument,
} = {}) => {
  const existing = await registry.findByUrl(filing.symbol, filing.url);
  if (existing && ['FETCHED', 'EXTRACTED'].includes(existing.extractionStatus)) {
    return { status: 'ALREADY_REGISTERED', registryDoc: existing, buffer: null };
  }

  const base = {
    symbol: filing.symbol, companyName: filing.companyName, fiscalYear: filing.fiscalYear, sourceType: filing.documentType, url: filing.url, publicationDate: filing.publicationDate, title: filing.title || null,
  };

  let buffer;
  try {
    buffer = await download(filing.url);
  } catch (error) {
    await registry.upsert(filing.symbol, filing.url, { ...base, extractionStatus: 'FAILED', error: error.message }, { promiseExtractionStatus: 'PENDING' });
    logger.warn(`[NseAnnouncementProvider] Failed to download ${filing.url}: ${error.message}`);
    return { status: 'DOWNLOAD_FAILED', registryDoc: null, buffer: null, error: error.message };
  }

  if (!buffer || buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
    const message = 'The downloaded file is not a PDF';
    await registry.upsert(filing.symbol, filing.url, { ...base, extractionStatus: 'FAILED', error: message }, { promiseExtractionStatus: 'PENDING' });
    return { status: 'NOT_A_PDF', registryDoc: null, buffer: null, error: message };
  }

  const pdfHash = hashDocumentContent(buffer);
  const duplicate = await registry.findByHash(filing.symbol, pdfHash, filing.url);
  if (duplicate) return { status: 'DUPLICATE_CONTENT', registryDoc: duplicate, buffer: null };

  let storage = { storageKey: null, storageBackend: null };
  try {
    storage = await persist(buffer, { symbol: filing.symbol, url: filing.url });
  } catch (error) {
    logger.warn(`[NseAnnouncementProvider] Durable storage failed for ${filing.url}: ${error.message}`);
  }

  const registryDoc = await registry.upsert(
    filing.symbol,
    filing.url,
    {
      ...base,
      pdfHash,
      extractionStatus: 'EXTRACTED',
      factsExtracted: 0,
      fetchedAt: new Date(),
      error: null,
      storageKey: storage.storageKey || null,
      storageBackend: storage.storageBackend || null,
    },
    { promiseExtractionStatus: 'PENDING' },
  );
  return { status: 'REGISTERED', registryDoc, buffer };
};

export default {
  classifyNseAnnouncement, fiscalYearOfAnnouncement, fetchNseAnnouncementRows, searchNseAnnouncements, registerNseFiling, configureNseDiscoveryConcurrency,
};
