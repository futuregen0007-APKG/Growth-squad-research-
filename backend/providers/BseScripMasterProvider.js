/**
 * BseScripMasterProvider.js
 * ============================
 * Real, official BSE scrip master (the same JSON API bseindia.com's own
 * "List of Scrips" search page calls) -- gives a live symbol -> BSE scrip
 * code -> market cap mapping for every active equity listing, confirmed
 * live (Sep 2026, 5000+ rows) against known values for TCS (532540), INFY
 * (500209), HDFCBANK (500180). This is what makes CompanyResearchProfile
 * generation dynamic instead of 205 hardcoded entries: each SUPPORTED_STOCKS
 * symbol is matched against this real master by its `scrip_id` field
 * (BSE's own NSE-style trading symbol), with a small, explicit override map
 * only for the handful of symbols that don't match directly (renames,
 * demergers) -- never a guessed or invented scrip code.
 */
import axios from 'axios';
import https from 'node:https';
import { getCache, setCache } from '../utils/redisClient.js';
import { logger } from '../utils/logger.js';

const BSE_SCRIP_LIST_URL = 'https://api.bseindia.com/BseIndiaAPI/api/ListofScripData/w';
const BSE_REFERER = 'https://www.bseindia.com/corporates/List_Scrips.aspx';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const CACHE_KEY = 'bse:scrip-master';
const CACHE_TTL_SECONDS = 24 * 60 * 60;
const NO_KEEPALIVE_AGENT = new https.Agent({ keepAlive: false });

/**
 * Confirmed-real exceptions where a SUPPORTED_STOCKS symbol does not match
 * the BSE master's scrip_id directly (renames/demergers/spelling), resolved
 * by looking up the real company name in the master (Sep 2026). Two symbols
 * (LTIM, GUJGASLTD) could not be found in this endpoint's "Active Equity"
 * segment and are intentionally left unmapped rather than guessed.
 */
export const SCRIP_ID_OVERRIDES = {
  REC: 'RECLTD',
  MAXFIN: 'MFSL',
  TATAMOTORS: 'TMCV',
  AMARAJABAT: 'ARE&M',
  'UNO MINDA': 'UNOMINDA',
  CEAT: 'CEATLTD',
  HPCL: 'HINDPETRO',
  KALPATPOWR: 'KPIL',
  SUMITOMOIND: 'SUMICHEM',
  ZOMATO: 'ETERNAL',
  PBFINTECH: 'POLICYBZR',
  INFOEDGE: 'NAUKRI',
  GMRINFRA: 'GMRAIRPORT',
};

const fetchScripMasterRaw = async () => {
  const response = await axios.get(BSE_SCRIP_LIST_URL, {
    params: { Group: '', Scripcode: '', industry: '', segment: 'Equity', status: 'Active' },
    headers: { 'User-Agent': BROWSER_UA, Referer: BSE_REFERER, Accept: 'application/json, text/plain, */*' },
    httpsAgent: NO_KEEPALIVE_AGENT,
    timeout: 30000,
  });
  if (!Array.isArray(response.data)) {
    throw new Error('BSE scrip master response was not the expected array -- provider schema may have changed');
  }
  return response.data;
};

/** Real, cached (24h) BSE scrip master: [{scripCode, symbol, companyName, marketCapCr, isin}]. */
export const getScripMaster = async ({ forceRefresh = false } = {}) => {
  if (!forceRefresh) {
    const cached = await getCache(CACHE_KEY);
    if (cached && Array.isArray(cached) && cached.length) return cached;
  }
  try {
    const raw = await fetchScripMasterRaw();
    const normalized = raw
      .filter((row) => row.scrip_id && row.SCRIP_CD)
      .map((row) => ({
        scripCode: String(row.SCRIP_CD),
        symbol: String(row.scrip_id).toUpperCase(),
        companyName: row.Issuer_Name || row.Scrip_Name || row.scrip_id,
        marketCapCr: Number(row.Mktcap) || null,
        isin: row.ISIN_NUMBER || null,
      }));
    await setCache(CACHE_KEY, normalized, CACHE_TTL_SECONDS);
    return normalized;
  } catch (error) {
    logger.warn(`[BseScripMasterProvider] Failed to fetch BSE scrip master: ${error.message}`);
    return [];
  }
};

/** Resolves one SUPPORTED_STOCKS symbol to its real BSE scrip code + market cap, via direct match or the explicit override map. Returns null (never a guess) if genuinely unresolved. */
export const resolveScripForSymbol = async (symbol, scripMaster) => {
  const normalized = String(symbol || '').toUpperCase();
  const bseSymbol = SCRIP_ID_OVERRIDES[normalized] || normalized;
  return scripMaster.find((row) => row.symbol === bseSymbol) || null;
};

export default { getScripMaster, resolveScripForSymbol, SCRIP_ID_OVERRIDES };
