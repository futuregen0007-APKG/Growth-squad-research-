/**
 * ExchangeFilingDocumentProvider.js
 * ====================================
 * Reusable, automated replacement for the manual BSE-archive research
 * method used in earlier backfill work. Company IR domains (tcs.com,
 * infosys.com, ...) return HTTP 403 behind a Cloudflare managed challenge
 * for any non-browser client (confirmed live against 2+ companies) -- this
 * provider never depends on them. Instead it uses BSE's own real,
 * unauthenticated JSON corporate-announcements API (the same one
 * bseindia.com's own filing-search UI calls), which is directly reachable
 * and returns structured, real filing metadata: no browser automation, no
 * search engine, no invented URLs.
 *
 * Flow: resolve a company's BSE scrip code -> query real announcements in a
 * date window (BSE caps a single query at 12 months, enforced here by
 * chunking) -> classify each announcement's real subject line into one of
 * the 4 supported document types by keyword -> build the real PDF URL from
 * the announcement's own ATTACHMENTNAME -> download once, hash, and persist
 * to CompanyDocumentRegistry (download/extraction status tracked so a
 * second call never re-fetches the same document).
 */
import axios from 'axios';
import https from 'node:https';
import crypto from 'node:crypto';
import { CompanyDocumentRegistry } from '../models/CompanyDocumentRegistry.js';
import { CompanyResearchProfile } from '../models/CompanyResearchProfile.js';
import { Semaphore } from '../utils/semaphore.js';
import { logger } from '../utils/logger.js';
import { saveDocument, loadDocument } from '../services/DocumentStorageService.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Global gates -- independent of how many companies the batch runner
// processes in parallel, at most `discovery` announcement-search calls and
// `download` PDF downloads are ever in flight at once across the WHOLE
// process. Defaults match the requested 3/2; scripts/backfillUniverse.js
// reconfigures these at startup from CLI flags.
let discoverySemaphore = new Semaphore(3);
let downloadSemaphore = new Semaphore(2);
export const configureExchangeProviderConcurrency = ({ discovery, download } = {}) => {
  if (discovery) discoverySemaphore = new Semaphore(discovery);
  if (download) downloadSemaphore = new Semaphore(download);
};

// The intermittent "Unexpected whitespace after header value" parse error
// (confirmed live, recurring across multiple backfill runs) only ever
// happens on a REUSED keep-alive connection -- consistent with a stale
// backend behind BSE's load balancer occasionally sending a malformed
// response on a pipelined/reused socket. A fresh connection per request
// sidesteps it (confirmed live: the same request that failed on a
// keep-alive agent succeeded immediately with keepAlive disabled).
const NO_KEEPALIVE_AGENT = new https.Agent({ keepAlive: false });

const RETRYABLE_HTTP_STATUS = new Set([429, 502, 503, 504]);

/** Bounded retry for transient network/HTTP-parse errors and 429/502/503/504 only (BSE's own servers occasionally send a malformed header, confirmed live) -- never for a real 4xx rejection like 404/400. */
const withRetry = async (fn, { retries = 4, baseDelayMs = 800 } = {}) => {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await fn();
    } catch (error) {
      const code = error.code || error.cause?.code;
      const transientCodes = new Set(['HPE_INVALID_HEADER_TOKEN', 'ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED']);
      const transient = transientCodes.has(code) || RETRYABLE_HTTP_STATUS.has(error.response?.status);
      if (!transient || attempt === retries) throw error;
      // Randomized jitter on top of the exponential backoff -- several
      // concurrent symbols retrying in lockstep would otherwise re-hit BSE
      // at the same instant.
      const jitterMs = Math.floor(Math.random() * 400);
      // eslint-disable-next-line no-await-in-loop
      await sleep(baseDelayMs * (2 ** attempt) + jitterMs);
    }
  }
  return undefined;
};

// Real BSE scrip codes, reused verbatim from research/CompanyResearchProfiles.js
// (already verified there against real BSE listings) -- not re-derived or guessed.
export const BSE_SCRIP_CODES = {
  TCS: '532540',
  INFY: '500209',
  HDFCBANK: '500180',
  ICICIBANK: '532174',
  BHEL: '500103',
  NEWGEN: '540900',
  LT: '500510',
  HAL: '541154',
  RELIANCE: '500325',
};

export const DOCUMENT_TYPES = ['ANNUAL_REPORT', 'FINANCIAL_RESULTS', 'INVESTOR_PRESENTATION', 'EARNINGS_CALL_TRANSCRIPT'];

// Confirmed live against real BSE announcements for both TCS and Infosys
// (Sep 2026): BSE's own SUBCATNAME/CATEGORYNAME fields are the reliable,
// structured classification signal -- "Board Meeting Intimation" (a mere
// meeting-date notice, no real figures) and "Board Meeting Outcome"/"Result"
// (the actual results) both fall under different SUBCATNAME/CATEGORYNAME
// values, which subject-text keyword matching alone cannot reliably tell
// apart (e.g. Infosys phrases its transcript announcement as "Announcement
// under Regulation 30 (LODR)-Earnings Call Transcript", TCS as "Transcript
// of the Earnings Conference Call..." -- no shared subject wording, but both
// carry the real, structured SUBCATNAME "Earnings Call Transcript"). Subject
// text is used only as a secondary signal for annual reports, whose
// CATEGORYNAME varies (AGM/EGM, Others, ...).
export const classifyDocumentType = (row) => {
  const category = String(row?.CATEGORYNAME || '').trim();
  const subcategory = String(row?.SUBCATNAME || '').trim();
  const subject = String(row?.NEWSSUB || row?.HEADLINE || '').trim();

  if (/earnings call transcript/i.test(subcategory) || /transcript of the (earnings|investor|analyst)/i.test(subject)) {
    return 'EARNINGS_CALL_TRANSCRIPT';
  }
  if (category === 'Result' || /financial results/i.test(subcategory) || category === 'Integrated Filing') {
    return 'FINANCIAL_RESULTS';
  }
  if (/annual report/i.test(subcategory) || /annual report/i.test(subject)) {
    return 'ANNUAL_REPORT';
  }
  if (/analyst\s*\/?\s*investor meet/i.test(subcategory) || /investor presentation|earnings presentation/i.test(subject)) {
    return 'INVESTOR_PRESENTATION';
  }
  return null;
};

const BSE_ANNOUNCEMENTS_URL = 'https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w';
const BSE_REFERER = 'https://www.bseindia.com/corporates/ann.html';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const MAX_PAGES_PER_WINDOW = 40; // 40 * 50 rows/page = 2000 announcements/window ceiling -- a runaway guard, not a real-world limit
const PAGE_THROTTLE_MS = 300; // polite delay between paginated requests to BSE's own API

export class ProviderChangedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProviderChangedError';
    this.errorCode = 'PROVIDER_CHANGED';
  }
}

/**
 * BSE's announcement-search endpoint is undocumented -- this validates the
 * real shape confirmed live (Sep 2026) before trusting it, and distinguishes
 * three real failure modes:
 *  - an HTML/challenge page (e.g. a WAF interstitial) instead of JSON
 *  - a JSON body whose expected fields (Table/Table1/ROWCNT) are gone,
 *    meaning BSE changed its response shape
 *  - a genuine API-level rejection (Status:false + Message)
 */
export const validateAnnouncementsResponse = (response) => {
  const contentType = String(response.headers?.['content-type'] || '');
  const body = response.data;
  if (contentType.includes('text/html') || (typeof body === 'string' && /<html|<!doctype/i.test(body))) {
    throw new ProviderChangedError('BSE returned an HTML page instead of JSON -- likely a WAF challenge or maintenance page');
  }
  if (!body || typeof body !== 'object') {
    throw new ProviderChangedError('BSE announcements response was not a JSON object');
  }
  if (body.Status === false) return body; // a real, well-formed API-level rejection -- not a schema change
  if (!Array.isArray(body.Table)) {
    throw new ProviderChangedError('BSE announcements response is missing the expected "Table" array -- provider schema may have changed');
  }
  if (body.Table.length > 0 && (!Array.isArray(body.Table1) || typeof body.Table1[0]?.ROWCNT !== 'number')) {
    throw new ProviderChangedError('BSE announcements response is missing the expected "Table1[0].ROWCNT" pagination field -- provider schema may have changed');
  }
  return body;
};

const formatBseDate = (date) => {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
};

/** Splits [from, to] into <=350-day chunks -- BSE rejects any single query spanning more than 12 months. */
const chunkDateRange = (from, to) => {
  const chunks = [];
  let cursor = new Date(from);
  const MAX_CHUNK_DAYS = 350;
  while (cursor < to) {
    const chunkEnd = new Date(Math.min(to.getTime(), cursor.getTime() + MAX_CHUNK_DAYS * 24 * 60 * 60 * 1000));
    chunks.push([new Date(cursor), chunkEnd]);
    cursor = new Date(chunkEnd.getTime() + 24 * 60 * 60 * 1000);
  }
  return chunks;
};

const fetchAnnouncementsPage = async (scripCode, fromDate, toDate, pageno) => {
  const response = await discoverySemaphore.run(() => withRetry(() => axios.get(BSE_ANNOUNCEMENTS_URL, {
    params: {
      pageno, strCat: -1, strPrevDate: formatBseDate(fromDate), strToDate: formatBseDate(toDate),
      strScrip: scripCode, strSearch: 'P', strType: 'C',
    },
    headers: { 'User-Agent': BROWSER_UA, Referer: BSE_REFERER, Accept: 'application/json, text/plain, */*' },
    httpsAgent: NO_KEEPALIVE_AGENT,
    timeout: 20000,
  })));
  const body = validateAnnouncementsResponse(response);
  if (body.Status === false) {
    throw new Error(body.Message || 'BSE announcements query failed');
  }
  return {
    rows: Array.isArray(body.Table) ? body.Table : [],
    totalCount: Number(body.Table1?.[0]?.ROWCNT) || 0,
  };
};

/** One real, unauthenticated call to BSE's own announcement-search JSON API -- auto-paginates (BSE returns 50 rows/page, reported via Table1[0].ROWCNT) so a window with many announcements (e.g. 268 for a large-cap company over a year) is never silently truncated to just the first page. Bounded by MAX_PAGES_PER_WINDOW and throttled between pages out of courtesy to BSE's own servers. */
export const fetchAnnouncementsWindow = async (scripCode, fromDate, toDate) => {
  const first = await fetchAnnouncementsPage(scripCode, fromDate, toDate, 1);
  const rows = [...first.rows];
  const pageSize = first.rows.length || 50;
  const totalPages = Math.min(pageSize ? Math.ceil(first.totalCount / pageSize) : 1, MAX_PAGES_PER_WINDOW);
  for (let page = 2; page <= totalPages; page += 1) {
    // eslint-disable-next-line no-await-in-loop
    await sleep(PAGE_THROTTLE_MS);
    // eslint-disable-next-line no-await-in-loop
    const next = await fetchAnnouncementsPage(scripCode, fromDate, toDate, page);
    rows.push(...next.rows);
  }
  return rows;
};

/** Real fiscal-year window (Apr 1 of FY-1 through Jun 30 of FY) -- results for a fiscal year ending March 31 are typically announced in April, so the window extends 3 months past fiscal year-end to catch them without exceeding BSE's 12-month cap per call. */
export const fiscalYearToDateRange = (fiscalYear) => {
  const endYear = Number(String(fiscalYear).replace(/\D/g, ''));
  return { from: new Date(Date.UTC(endYear - 1, 3, 1)), to: new Date(Date.UTC(endYear, 5, 30)) };
};

/** Real BSE search: resolves a scrip code, queries the fiscal year's window (chunked), classifies each real announcement, and returns only recognized document types with their real, constructible PDF URL. */
const defaultFindProfile = (symbol) => CompanyResearchProfile.findOne({ symbol, researchEnabled: true }).select('bseScripCode').lean();

/**
 * resolveBseScripCode - the verified static map wins; otherwise the scrip
 * code CompanyResearchProfileSync resolved from the real BSE scrip master and
 * stored on the company's profile. Never guessed: an unmapped symbol with no
 * enabled profile (or a lookup failure) yields null and discovery is skipped.
 */
export const resolveBseScripCode = async (symbol, { findProfile = defaultFindProfile } = {}) => {
  const normalized = String(symbol || '').toUpperCase();
  if (BSE_SCRIP_CODES[normalized]) return BSE_SCRIP_CODES[normalized];
  try {
    const profile = await findProfile(normalized);
    return profile?.bseScripCode || null;
  } catch (error) {
    logger.warn(`[ExchangeFilingDocumentProvider] Profile lookup failed for ${normalized}: ${error.message}`);
    return null;
  }
};

export const searchExchangeFilings = async (symbol, fiscalYear, { documentTypes = DOCUMENT_TYPES, resolveScrip = resolveBseScripCode } = {}) => {
  const normalized = String(symbol || '').toUpperCase();
  const scripCode = await resolveScrip(normalized);
  if (!scripCode) {
    logger.warn(`[ExchangeFilingDocumentProvider] No BSE scrip code for ${normalized} (not in the verified map, and no enabled synced profile) -- cannot search.`);
    return [];
  }

  const { from, to } = fiscalYearToDateRange(fiscalYear);
  const windows = chunkDateRange(from, to);
  const results = [];

  for (const [windowFrom, windowTo] of windows) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await fetchAnnouncementsWindow(scripCode, windowFrom, windowTo);
    for (const row of rows) {
      const documentType = classifyDocumentType(row);
      if (!documentType || !documentTypes.includes(documentType) || !row.ATTACHMENTNAME) continue;
      results.push({
        symbol: normalized,
        companyName: row.SLONGNAME || normalized,
        fiscalYear: String(fiscalYear),
        documentType,
        title: row.NEWSSUB || row.HEADLINE || '',
        url: `https://www.bseindia.com/xml-data/corpfiling/AttachLive/${row.ATTACHMENTNAME}`,
        fallbackUrl: `https://www.bseindia.com/xml-data/corpfiling/AttachHis/${row.ATTACHMENTNAME}`,
        publicationDate: new Date(row.NEWS_DT || row.DT_TM),
        exchange: 'BSE',
        scripCode,
      });
    }
  }
  return results;
};

const downloadPdf = async (url) => {
  const response = await downloadSemaphore.run(() => withRetry(() => axios.get(url, {
    headers: { 'User-Agent': BROWSER_UA, Referer: 'https://www.bseindia.com/' },
    responseType: 'arraybuffer',
    httpsAgent: NO_KEEPALIVE_AGENT,
    timeout: 30000,
  })));
  return Buffer.from(response.data);
};

/**
 * fetchRawDocumentBuffer - re-fetches a document's PDF bytes directly from
 * its original source URL. Only used as the LAST resort now (by
 * getDocumentBuffer, below) for a document that was registered before
 * durable storage existed and therefore has no storageKey -- a source
 * AttachLive URL can go stale/404 within days, so this path is expected to
 * fail for old documents; it is never the primary path for a newly
 * downloaded one.
 */
export const fetchRawDocumentBuffer = (url) => downloadPdf(url);

/**
 * alternateBseUrl - BSE serves the same ATTACHMENTNAME under two paths:
 * AttachLive (recent filings, expires/404s within days-to-weeks -- observed
 * live on INFY documents this session) and AttachHis (the stable historical
 * archive). A registry entry recorded before this alternate-path retry
 * existed only ever stored the AttachLive URL, so a stale one is recovered
 * here by swapping the path segment rather than needing a fresh discovery
 * query. Returns null if the URL doesn't contain either recognized segment
 * (never guesses a URL shape it hasn't seen).
 */
export const alternateBseUrl = (url) => {
  if (!url) return null;
  if (url.includes('/AttachLive/')) return url.replace('/AttachLive/', '/AttachHis/');
  if (url.includes('/AttachHis/')) return url.replace('/AttachHis/', '/AttachLive/');
  return null;
};

/**
 * getDocumentBuffer - the durable-first accessor every pipeline stage that
 * needs a document's bytes AFTER its first download should use (e.g. promise
 * extraction running after fact extraction already registered the
 * document). Order: (1) the persisted copy (S3/GridFS, via storageKey/
 * storageBackend on the registry entry); (2) the original source URL; (3)
 * the alternate BSE path (AttachLive<->AttachHis) for the SAME attachment,
 * an "alternate BSE announcement record" of the same document rather than a
 * re-discovery query. Any successful (2) or (3) re-fetch is immediately
 * durably stored and the registry entry updated with its storageKey/
 * storageBackend, so this is the LAST time this specific document will ever
 * need a network fetch. Returns { buffer, source } where source is
 * 'DURABLE_STORAGE', 'SOURCE_REFETCH', or 'ALTERNATE_BSE_PATH', or
 * { buffer: null, source: 'UNAVAILABLE' } if nothing yields bytes -- never
 * throws, so a caller can skip this one document and continue.
 */
export const getDocumentBuffer = async (registryDoc) => {
  if (registryDoc?.storageKey && registryDoc?.storageBackend) {
    const buffer = await loadDocument(registryDoc.storageKey, registryDoc.storageBackend);
    if (buffer) return { buffer, source: 'DURABLE_STORAGE' };
    logger.warn(`[ExchangeFilingDocumentProvider] Durable copy unavailable for ${registryDoc.symbol} ${registryDoc.url} (${registryDoc.storageBackend}:${registryDoc.storageKey}) -- falling back to a source re-fetch.`);
  }

  const persistAndReturn = async (buffer, source) => {
    try {
      const saved = await saveDocument(buffer, { symbol: registryDoc.symbol, url: registryDoc.url });
      await CompanyDocumentRegistry.updateOne(
        { symbol: registryDoc.symbol, url: registryDoc.url },
        { $set: { storageKey: saved.storageKey, storageBackend: saved.storageBackend, pdfHash: saved.documentHash } },
      );
    } catch (storageError) {
      logger.warn(`[ExchangeFilingDocumentProvider] Could not durably store ${registryDoc.symbol} ${registryDoc.url} after a successful re-fetch: ${storageError.message}`);
    }
    return { buffer, source };
  };

  try {
    const buffer = await fetchRawDocumentBuffer(registryDoc.url);
    return await persistAndReturn(buffer, 'SOURCE_REFETCH');
  } catch (primaryError) {
    const alternateUrl = alternateBseUrl(registryDoc.url);
    if (alternateUrl) {
      try {
        const buffer = await fetchRawDocumentBuffer(alternateUrl);
        return await persistAndReturn(buffer, 'ALTERNATE_BSE_PATH');
      } catch (alternateError) {
        logger.warn(`[ExchangeFilingDocumentProvider] Both the original and alternate BSE path failed for ${registryDoc.symbol} ${registryDoc.url}: ${primaryError.message} / ${alternateError.message}`);
        return { buffer: null, source: 'UNAVAILABLE' };
      }
    }
    logger.warn(`[ExchangeFilingDocumentProvider] Source re-fetch failed for ${registryDoc.symbol} ${registryDoc.url} (no durable copy, no recognized alternate path): ${primaryError.message}`);
    return { buffer: null, source: 'UNAVAILABLE' };
  }
};

export const hashDocumentContent = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

/**
 * Downloads one filing's PDF (only if not already registered as
 * FETCHED/EXTRACTED for this symbol+url -- download-once) and registers it
 * in CompanyDocumentRegistry. Returns { buffer, registryDoc } so a caller
 * can proceed to extraction, or just { registryDoc } if it was already
 * downloaded previously (buffer omitted to avoid needlessly re-holding
 * megabytes of already-processed PDF bytes in memory).
 */
export const downloadAndRegisterFiling = async (filing) => {
  const existing = await CompanyDocumentRegistry.findOne({ symbol: filing.symbol, url: filing.url }).lean();
  if (existing && ['FETCHED', 'EXTRACTED'].includes(existing.extractionStatus)) {
    return { buffer: null, registryDoc: existing, alreadyDownloaded: true };
  }

  try {
    let buffer;
    try {
      buffer = await downloadPdf(filing.url);
    } catch (primaryError) {
      buffer = await downloadPdf(filing.fallbackUrl); // AttachLive vs AttachHis -- try the historical path if the live one 404s
    }
    const pdfHash = hashDocumentContent(buffer);

    // Durable storage first (S3/GridFS -- never Render's ephemeral local
    // filesystem as the only copy). A save failure here is logged but never
    // aborts the backfill -- the document still gets registered/extracted
    // this run; it simply won't be reusable by a later stage without a
    // (possibly stale) source re-fetch, same as before this change existed.
    let storageKey = null;
    let storageBackend = null;
    try {
      ({ storageKey, storageBackend } = await saveDocument(buffer, { symbol: filing.symbol, url: filing.url }));
    } catch (storageError) {
      logger.warn(`[ExchangeFilingDocumentProvider] Durable storage failed for ${filing.symbol} ${filing.url}: ${storageError.message}`);
    }

    // The same document sometimes surfaces under more than one announcement
    // URL (e.g. a re-filed correction, or AttachLive vs AttachHis both
    // resolving to identical bytes) -- if this exact content was already
    // extracted for this symbol, skip re-extraction entirely rather than
    // downloading/registering it a second time under the new URL.
    const existingByHash = await CompanyDocumentRegistry.findOne({ symbol: filing.symbol, pdfHash, extractionStatus: 'EXTRACTED' }).lean();
    if (existingByHash) {
      await CompanyDocumentRegistry.findOneAndUpdate(
        { symbol: filing.symbol, url: filing.url },
        {
          $set: {
            symbol: filing.symbol, companyName: filing.companyName, fiscalYear: filing.fiscalYear, sourceType: filing.documentType, url: filing.url, publicationDate: filing.publicationDate, pdfHash, extractionStatus: 'EXTRACTED', fetchedAt: new Date(), factsExtracted: existingByHash.factsExtracted, error: null,
            storageKey: storageKey || existingByHash.storageKey, storageBackend: storageBackend || existingByHash.storageBackend,
          },
        },
        { upsert: true },
      );
      return { buffer: null, registryDoc: existingByHash, alreadyDownloaded: true, duplicateOfHash: true };
    }

    const registryDoc = await CompanyDocumentRegistry.findOneAndUpdate(
      { symbol: filing.symbol, url: filing.url },
      {
        $set: {
          symbol: filing.symbol, companyName: filing.companyName, fiscalYear: filing.fiscalYear,
          sourceType: filing.documentType, url: filing.url, publicationDate: filing.publicationDate,
          pdfHash, extractionStatus: 'FETCHED', fetchedAt: new Date(), error: null,
          storageKey, storageBackend,
        },
      },
      { upsert: true, new: true },
    );
    return { buffer, registryDoc, alreadyDownloaded: false };
  } catch (error) {
    await CompanyDocumentRegistry.findOneAndUpdate(
      { symbol: filing.symbol, url: filing.url },
      { $set: { symbol: filing.symbol, companyName: filing.companyName, fiscalYear: filing.fiscalYear, sourceType: filing.documentType, url: filing.url, publicationDate: filing.publicationDate, extractionStatus: 'FAILED', error: error.message } },
      { upsert: true },
    );
    logger.warn(`[ExchangeFilingDocumentProvider] Failed to download ${filing.url}: ${error.message}`);
    return { buffer: null, registryDoc: null, error: error.message };
  }
};

export default { searchExchangeFilings, downloadAndRegisterFiling, classifyDocumentType, fiscalYearToDateRange, validateAnnouncementsResponse, configureExchangeProviderConcurrency, BSE_SCRIP_CODES, DOCUMENT_TYPES };
