/**
 * CompanyResearchProfiles.js
 * ==========================
 * Deep configuration profiles for Indian listed equities to empower multi-tier
 * document discovery, IR portal targeting, exchange filings, and financial year searches.
 *
 * SOURCE REGISTRY
 * ----------------
 * Each profile carries a `sourceRegistry` object that is the single source of
 * truth for where official documents can be discovered:
 *
 *   sourceRegistry: {
 *     investorRelations:    [...],  // IR landing / hub pages
 *     financialResults:     [...],  // quarterly / annual results pages
 *     annualReports:        [...],  // annual report archive pages
 *     earningsPresentations:[...],  // investor / analyst presentation archives
 *     earningsTranscripts:  [...],  // earnings-call transcript archives
 *     exchangeFilings: { nse: [...], bse: [...] }
 *   }
 *
 * Every URL below was verified against the company's own official domain (or
 * NSE/BSE) before being added. Moneycontrol, Groww, Screener, and general news
 * sites are intentionally never used as primary sources here. Where an official
 * URL could not be verified, the array is left empty (never guessed/fabricated)
 * and the `sourceRegistryVerified` flag documents that a manual follow-up is
 * needed rather than silently returning incomplete-looking data.
 *
 * The legacy flat fields (`investorRelationsUrls`, `annualReportUrls`,
 * `exchangeSymbols`) are preserved and are *derived* from `sourceRegistry` by
 * `getCompanyResearchProfile()` / `getRegisteredCompanyProfile()` so existing
 * callers (DocumentResearchService, ManagementPromiseService, tests) keep
 * working unchanged.
 */

// ------------------------------------------------------------------
// Small, dependency-free URL helpers (no imports from DocumentResearchService
// to avoid a circular import, since that module imports from this file).
// ------------------------------------------------------------------

const isValidHttpUrl = (value) => {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
};

const TRACKING_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid'];

const normalizeRegistryUrl = (value) => {
  if (!isValidHttpUrl(value)) return null;
  const parsed = new URL(value.trim());
  parsed.hash = '';
  for (const param of TRACKING_PARAMS) parsed.searchParams.delete(param);
  let normalized = parsed.toString();
  // Strip a single trailing slash on a bare path so "/x" and "/x/" dedupe together.
  if (normalized.endsWith('/') && parsed.pathname !== '/') normalized = normalized.slice(0, -1);
  return normalized;
};

const dedupeRegistryUrls = (urls = []) => {
  const seen = new Set();
  const out = [];
  for (const url of urls) {
    const normalized = normalizeRegistryUrl(url);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
};

/** Deterministic, officially-hosted NSE/BSE URLs built from the exchange identifiers. */
const buildExchangeFilingUrls = (nseSymbol, bseCode) => ({
  nse: nseSymbol
    ? dedupeRegistryUrls([
        `https://www.nseindia.com/get-quotes/equity?symbol=${encodeURIComponent(nseSymbol)}`,
        `https://www.nseindia.com/companies-listing/corporate-filings-announcements?symbol=${encodeURIComponent(nseSymbol)}`,
        `https://www.nseindia.com/companies-listing/corporate-filings-financial-results?symbol=${encodeURIComponent(nseSymbol)}`,
      ])
    : [],
  bse: bseCode
    ? dedupeRegistryUrls([
        `https://www.bseindia.com/corporates/ann.html?scrip=${encodeURIComponent(bseCode)}`,
        `https://www.bseindia.com/corporates/announcements.aspx?scrip=${encodeURIComponent(bseCode)}`,
      ])
    : [],
});

const deriveFlatUrlsFromRegistry = (registry) => {
  if (!registry) return { investorRelationsUrls: [], annualReportUrls: [] };
  return {
    investorRelationsUrls: dedupeRegistryUrls([
      ...(registry.investorRelations || []),
      ...(registry.financialResults || []),
      ...(registry.earningsPresentations || []),
      ...(registry.earningsTranscripts || []),
    ]),
    annualReportUrls: dedupeRegistryUrls([...(registry.annualReports || [])]),
  };
};

// ------------------------------------------------------------------
// Company profiles
// ------------------------------------------------------------------

export const COMPANY_RESEARCH_PROFILES = {
  NEWGEN: {
    symbol: 'NEWGEN',
    companyName: 'Newgen Software Technologies',
    aliases: [
      'Newgen Software Technologies',
      'Newgen Software',
      'Newgen',
      'NEWGEN',
    ],
    sector: 'IT / Software',
    exchangeSymbols: { NSE: 'NEWGEN', BSE: '540900' },
    exchangeIdentifiers: { nseSymbol: 'NEWGEN', bseCode: '540900' },
    sourceRegistryVerified: true,
    sourceRegistry: {
      investorRelations: ['https://newgensoft.com/investor-relations/'],
      financialResults: [
        'https://newgensoft.com/investor-relations/financial-information/',
        'https://newgensoft.com/investor-relations/quarterly-results/',
      ],
      annualReports: ['https://newgensoft.com/investor-relations/annual-reports/'],
      earningsPresentations: ['https://newgensoft.com/investor-relations/investor-presentations/'],
      // NOTE: no distinct, stable transcript-archive URL verified on newgensoft.com at
      // review time; leaving empty rather than guessing one. Transcripts are still
      // discoverable via the IR landing page crawl in Tier 1.
      earningsTranscripts: [],
      exchangeFilings: buildExchangeFilingUrls('NEWGEN', '540900'),
    },
    commonManagementTerms: [
      'management guidance',
      'order book',
      'order intake',
      'revenue guidance',
      'revenue target',
      'ARR guidance',
      'EBITDA guidance',
      'margin guidance',
      'FY25 guidance',
      'FY26 guidance',
      'investor presentation',
      'earnings call',
      'conference call',
      'annual report',
      'investor presentation order book',
      'management expects',
      'management targets',
      'expects',
      'aims',
      'plans',
      'target',
      'large deal wins',
      'subscription revenue',
      'SaaS revenue',
      'BFSI',
    ],
  },
  TCS: {
    symbol: 'TCS',
    companyName: 'Tata Consultancy Services',
    aliases: ['Tata Consultancy Services', 'TCS', 'Tata Consultancy'],
    sector: 'IT / Software',
    exchangeSymbols: { NSE: 'TCS', BSE: '532540' },
    exchangeIdentifiers: { nseSymbol: 'TCS', bseCode: '532540' },
    sourceRegistryVerified: true,
    sourceRegistry: {
      investorRelations: ['https://www.tcs.com/investor-relations'],
      financialResults: ['https://www.tcs.com/investor-relations/financial-statements'],
      annualReports: ['https://www.tcs.com/investor-relations/management-commentary/annual-report-sections'],
      // NOTE: TCS publishes presentations/transcripts as per-quarter PDFs under
      // /content/dam/tcs/investor-relations/financial-statements/<FY>/<Q>/... rather
      // than a single stable archive page, so no top-level URL is added here; the
      // financial-statements landing page above is still crawled by Tier 1.
      earningsPresentations: [],
      earningsTranscripts: [],
      exchangeFilings: buildExchangeFilingUrls('TCS', '532540'),
    },
    commonManagementTerms: [
      'revenue growth',
      'margin guidance',
      'EBIT margin',
      'deal wins',
      'total contract value',
      'order book',
      'hiring',
      'attrition',
      'digital revenue',
      'cloud transformation',
      'guidance',
    ],
  },
  INFY: {
    symbol: 'INFY',
    companyName: 'Infosys',
    aliases: ['Infosys Limited', 'Infosys', 'INFY'],
    sector: 'IT / Software',
    exchangeSymbols: { NSE: 'INFY', BSE: '500209' },
    exchangeIdentifiers: { nseSymbol: 'INFY', bseCode: '500209' },
    sourceRegistryVerified: true,
    sourceRegistry: {
      investorRelations: ['https://www.infosys.com/investors.html'],
      financialResults: ['https://www.infosys.com/investors/reports-filings.html'],
      annualReports: ['https://www.infosys.com/investors/reports-filings/annual-report.html'],
      earningsPresentations: [],
      earningsTranscripts: [],
      exchangeFilings: buildExchangeFilingUrls('INFY', '500209'),
    },
    commonManagementTerms: [
      'revenue guidance',
      'margin guidance',
      'operating margin',
      'large deal TCV',
      'free cash flow',
      'digital revenue',
      'FY25 guidance',
      'FY26 guidance',
      'constant currency growth',
    ],
  },
  HDFCBANK: {
    symbol: 'HDFCBANK',
    companyName: 'HDFC Bank',
    aliases: ['HDFC Bank Limited', 'HDFC Bank', 'HDFCBANK'],
    sector: 'Banking',
    exchangeSymbols: { NSE: 'HDFCBANK', BSE: '500180' },
    exchangeIdentifiers: { nseSymbol: 'HDFCBANK', bseCode: '500180' },
    sourceRegistryVerified: true,
    sourceRegistry: {
      // HDFC Bank's investor relations pages now live on the RBI-mandated
      // ".bank.in" domain; hdfcbank.com 301-redirects to hdfc.bank.in for these
      // paths, so the canonical .bank.in URLs are used directly.
      investorRelations: ['https://www.hdfc.bank.in/about-us/investor-relations'],
      financialResults: ['https://www.hdfc.bank.in/about-us/investor-relations/financial-results'],
      annualReports: ['https://www.hdfc.bank.in/about-us/investor-relations/annual-reports'],
      earningsPresentations: [],
      earningsTranscripts: [],
      exchangeFilings: buildExchangeFilingUrls('HDFCBANK', '500180'),
    },
    commonManagementTerms: [
      'credit growth',
      'deposit growth',
      'NIM guidance',
      'net interest margin',
      'asset quality',
      'GNPA',
      'CASA ratio',
      'branch expansion',
      'cost to income ratio',
    ],
  },
  ICICIBANK: {
    symbol: 'ICICIBANK',
    companyName: 'ICICI Bank',
    aliases: ['ICICI Bank Limited', 'ICICI Bank', 'ICICIBANK'],
    sector: 'Banking',
    exchangeSymbols: { NSE: 'ICICIBANK', BSE: '532174' },
    exchangeIdentifiers: { nseSymbol: 'ICICIBANK', bseCode: '532174' },
    sourceRegistryVerified: true,
    sourceRegistry: {
      // Same ".bank.in" migration as HDFC Bank: icicibank.com 301-redirects here.
      investorRelations: ['https://www.icici.bank.in/about-us/invest-relations'],
      financialResults: ['https://www.icici.bank.in/about-us/qfr'],
      annualReports: ['https://www.icici.bank.in/about-us/annual'],
      earningsPresentations: ['https://www.icici.bank.in/about-us/investor'],
      earningsTranscripts: [],
      exchangeFilings: buildExchangeFilingUrls('ICICIBANK', '532174'),
    },
    commonManagementTerms: [
      'loan growth',
      'net interest margin',
      'domestic loan growth',
      'NIM',
      'asset quality',
      'cost of deposits',
      'return on equity',
      'branch additions',
    ],
  },
  BHEL: {
    symbol: 'BHEL',
    companyName: 'Bharat Heavy Electricals',
    aliases: ['Bharat Heavy Electricals Limited', 'Bharat Heavy Electricals', 'BHEL'],
    sector: 'Capital Goods',
    exchangeSymbols: { NSE: 'BHEL', BSE: '500103' },
    exchangeIdentifiers: { nseSymbol: 'BHEL', bseCode: '500103' },
    sourceRegistryVerified: true,
    sourceRegistry: {
      investorRelations: ['https://www.bhel.com/investor-relations'],
      financialResults: [
        'https://www.bhel.com/un-audited-quarterly-results',
        'https://www.bhel.com/audited-results',
        'https://www.bhel.com/financial-information',
      ],
      annualReports: ['https://www.bhel.com/annual-reports'],
      earningsPresentations: ['https://www.bhel.com/presentations-conference-calls'],
      earningsTranscripts: [],
      exchangeFilings: buildExchangeFilingUrls('BHEL', '500103'),
    },
    commonManagementTerms: [
      'order inflow',
      'order book',
      'thermal power orders',
      'defence orders',
      'railway orders',
      'revenue target',
      'execution timeline',
      'EBITDA margin',
    ],
  },
  LT: {
    symbol: 'LT',
    companyName: 'Larsen & Toubro Limited',
    aliases: [
      'Larsen & Toubro Limited',
      'Larsen & Toubro',
      'Larsen and Toubro',
      'L&T',
      'L & T',
      'LARSEN',
      'LT',
    ],
    // Classified as Capital Goods for research-metric purposes (order book /
    // order intake / EBITDA margin / capex are the metrics management actually
    // guides on), independent of the broader stock-service "Manufacturing"
    // sector tag used elsewhere in the app for display/watchlist grouping.
    sector: 'Capital Goods',
    exchangeSymbols: { NSE: 'LT', BSE: '500510' },
    exchangeIdentifiers: { nseSymbol: 'LT', bseCode: '500510' },
    sourceRegistryVerified: true,
    sourceRegistry: {
      investorRelations: ['https://investors.larsentoubro.com/'],
      financialResults: ['https://investors.larsentoubro.com/Quarterly-Results-Archives.aspx'],
      annualReports: ['https://investors.larsentoubro.com/Annual-Reports-Archives.aspx'],
      earningsPresentations: ['https://investors.larsentoubro.com/Analyst-Presentation-Archives.aspx'],
      earningsTranscripts: ['https://investors.larsentoubro.com/Transcripts-Archives.aspx'],
      exchangeFilings: buildExchangeFilingUrls('LT', '500510'),
    },
    commonManagementTerms: [
      'order inflow',
      'order book',
      'order intake',
      'infrastructure orders',
      'hydrocarbon orders',
      'defence orders',
      'execution timeline',
      'revenue guidance',
      'EBITDA margin',
      'capex',
      'working capital',
      'international orders',
    ],
  },
  HAL: {
    symbol: 'HAL',
    companyName: 'Hindustan Aeronautics Limited',
    aliases: [
      'Hindustan Aeronautics Limited',
      'Hindustan Aeronautics',
      'HAL',
    ],
    sector: 'Capital Goods',
    exchangeSymbols: { NSE: 'HAL', BSE: '541154' },
    exchangeIdentifiers: { nseSymbol: 'HAL', bseCode: '541154' },
    sourceRegistryVerified: true,
    sourceRegistry: {
      investorRelations: ['https://hal-india.co.in/investor'],
      financialResults: ['https://hal-india.co.in/investors/financial-results'],
      annualReports: ['https://hal-india.co.in/investors/annual-report'],
      // NOTE: HAL hosts investor-presentation PDFs directly under a WordPress
      // uploads path rather than a stable archive page; no top-level URL is
      // verified so this stays empty rather than guessing.
      earningsPresentations: [],
      earningsTranscripts: [],
      exchangeFilings: buildExchangeFilingUrls('HAL', '541154'),
    },
    commonManagementTerms: [
      'order book',
      'order inflow',
      'indigenisation',
      'defence orders',
      'delivery schedule',
      'revenue guidance',
      'EBITDA margin',
      'capex',
      'production targets',
      'export orders',
    ],
  },
  RELIANCE: {
    symbol: 'RELIANCE',
    companyName: 'Reliance Industries',
    aliases: ['Reliance Industries Limited', 'Reliance Industries', 'RIL', 'Reliance'],
    sector: 'Conglomerate / Energy & Telecom',
    exchangeSymbols: { NSE: 'RELIANCE', BSE: '500325' },
    exchangeIdentifiers: { nseSymbol: 'RELIANCE', bseCode: '500325' },
    sourceRegistryVerified: true,
    sourceRegistry: {
      investorRelations: ['https://www.ril.com/investor-relations'],
      financialResults: ['https://www.ril.com/investor-relations/financial-reporting'],
      annualReports: ['https://www.ril.com/investor-relations/annual-reports'],
      earningsPresentations: [],
      earningsTranscripts: [],
      exchangeFilings: buildExchangeFilingUrls('RELIANCE', '500325'),
    },
    commonManagementTerms: [
      'Jio subscriber growth',
      'ARPU',
      'Retail footprint',
      'O2C EBITDA',
      'Green energy capex',
      'New Energy',
      'Debt reduction',
      'EBITDA guidance',
      'capex target',
      'management outlook',
    ],
  },
};

export const SECTOR_METRICS = {
  'IT / Software': [
    { key: 'REVENUE_GROWTH', label: 'Revenue Growth (CC)', unit: 'PERCENTAGE', direction: 'HIGHER_IS_BETTER' },
    { key: 'EBIT_MARGIN', label: 'Operating (EBIT) Margin', unit: 'PERCENTAGE', direction: 'HIGHER_IS_BETTER' },
    { key: 'DEAL_WINS', label: 'Large Deal TCV', unit: 'USD_MILLION', direction: 'HIGHER_IS_BETTER' },
    { key: 'ARR', label: 'Annual Recurring Revenue', unit: 'INR_CRORE', direction: 'HIGHER_IS_BETTER' },
    { key: 'ATTRITION', label: 'LTM Attrition', unit: 'PERCENTAGE', direction: 'LOWER_IS_BETTER' },
  ],
  Banking: [
    { key: 'NIM', label: 'Net Interest Margin', unit: 'PERCENTAGE', direction: 'HIGHER_IS_BETTER' },
    { key: 'GNPA', label: 'Gross NPA Ratio', unit: 'PERCENTAGE', direction: 'LOWER_IS_BETTER' },
    { key: 'NNPA', label: 'Net NPA Ratio', unit: 'PERCENTAGE', direction: 'LOWER_IS_BETTER' },
    { key: 'CREDIT_GROWTH', label: 'Loan / Credit Growth', unit: 'PERCENTAGE', direction: 'HIGHER_IS_BETTER' },
    { key: 'CASA', label: 'CASA Deposit Ratio', unit: 'PERCENTAGE', direction: 'HIGHER_IS_BETTER' },
    { key: 'ROE', label: 'Return on Equity', unit: 'PERCENTAGE', direction: 'HIGHER_IS_BETTER' },
  ],
  'Capital Goods': [
    { key: 'ORDER_BOOK', label: 'Total Order Book', unit: 'INR_CRORE', direction: 'HIGHER_IS_BETTER' },
    { key: 'ORDER_INTAKE', label: 'Annual Order Inflow', unit: 'INR_CRORE', direction: 'HIGHER_IS_BETTER' },
    { key: 'EBITDA_MARGIN', label: 'EBITDA Margin', unit: 'PERCENTAGE', direction: 'HIGHER_IS_BETTER' },
    { key: 'CAPEX', label: 'Capital Expenditure', unit: 'INR_CRORE', direction: 'TARGET_RANGE' },
  ],
  'Pharma / Healthcare': [
    { key: 'REVENUE', label: 'Total Revenue', unit: 'INR_CRORE', direction: 'HIGHER_IS_BETTER' },
    { key: 'EBITDA_MARGIN', label: 'EBITDA Margin', unit: 'PERCENTAGE', direction: 'HIGHER_IS_BETTER' },
    { key: 'RND_SPEND', label: 'R&D Spend (% of Rev)', unit: 'PERCENTAGE', direction: 'HIGHER_IS_BETTER' },
    { key: 'ANDA_APPROVALS', label: 'USFDA / Global Approvals', unit: 'COUNT', direction: 'HIGHER_IS_BETTER' },
  ],
  Generic: [
    { key: 'REVENUE', label: 'Revenue', unit: 'INR_CRORE', direction: 'HIGHER_IS_BETTER' },
    { key: 'REVENUE_GROWTH', label: 'Revenue Growth', unit: 'PERCENTAGE', direction: 'HIGHER_IS_BETTER' },
    { key: 'EBITDA_MARGIN', label: 'EBITDA Margin', unit: 'PERCENTAGE', direction: 'HIGHER_IS_BETTER' },
    { key: 'PAT', label: 'Net Profit (PAT)', unit: 'INR_CRORE', direction: 'HIGHER_IS_BETTER' },
    { key: 'DEBT', label: 'Total Debt', unit: 'INR_CRORE', direction: 'LOWER_IS_BETTER' },
  ],
};

// ------------------------------------------------------------------
// Alias index (built once) — used by normalizeResearchSymbol(). Exact,
// normalized-key matching only; no substring/fuzzy matching, so e.g. "LTIM"
// or "LTF" (real, unrelated NSE tickers) can never resolve to "LT".
// ------------------------------------------------------------------

const normalizeAliasKey = (value) => String(value || '').toUpperCase().trim().replace(/[^A-Z0-9]/g, '');

const buildAliasIndex = () => {
  const index = new Map();
  for (const [symbol, profile] of Object.entries(COMPANY_RESEARCH_PROFILES)) {
    const candidates = new Set([symbol, profile.companyName, ...(profile.aliases || [])]);
    for (const candidate of candidates) {
      const key = normalizeAliasKey(candidate);
      if (!key) continue;
      const existing = index.get(key);
      if (existing && existing !== symbol) {
        // Never let a later profile silently steal an alias from an earlier one.
        // eslint-disable-next-line no-console
        console.warn(`[CompanyResearchProfiles] Alias collision for "${candidate}": already mapped to ${existing}, ignoring claim by ${symbol}`);
        continue;
      }
      index.set(key, symbol);
    }
  }
  return index;
};

const ALIAS_INDEX = buildAliasIndex();

/**
 * Resolves any known symbol, company name, or alias (case-insensitive, and
 * punctuation/whitespace-insensitive) to the canonical registry symbol.
 * Returns null for anything not explicitly registered — it never guesses.
 */
export function normalizeResearchSymbol(symbol) {
  const key = normalizeAliasKey(symbol);
  if (!key) return null;
  return ALIAS_INDEX.get(key) || null;
}

/** All symbols with a curated registry profile (no fabricated fallback profiles). */
export function getSupportedResearchSymbols() {
  return Object.keys(COMPANY_RESEARCH_PROFILES);
}

const cloneProfile = (profile) => (
  typeof structuredClone === 'function' ? structuredClone(profile) : JSON.parse(JSON.stringify(profile))
);

/**
 * Strict, registry-only profile lookup: case-insensitive and alias-aware, but
 * returns null (never a fabricated or borrowed profile) for anything not
 * explicitly registered in COMPANY_RESEARCH_PROFILES. The returned object is a
 * deep clone, so callers can never mutate the stored profile.
 */
export function getRegisteredCompanyProfile(symbol) {
  const canonical = normalizeResearchSymbol(symbol);
  if (!canonical) return null;
  const base = COMPANY_RESEARCH_PROFILES[canonical];
  if (!base) return null;

  const clone = cloneProfile(base);
  const derived = deriveFlatUrlsFromRegistry(clone.sourceRegistry);
  return {
    ...clone,
    investorRelationsUrls: derived.investorRelationsUrls,
    annualReportUrls: derived.annualReportUrls,
    sectorMetrics: SECTOR_METRICS[clone.sector] || SECTOR_METRICS.Generic,
  };
}

/** Convenience accessor: the sourceRegistry for a known symbol, or null. */
export function getCompanySourceRegistry(symbol) {
  const profile = getRegisteredCompanyProfile(symbol);
  return profile ? profile.sourceRegistry : null;
}

const BLOCKED_SOURCE_DOMAINS = [
  'moneycontrol.com',
  'groww.in',
  'screener.in',
  'economictimes.indiatimes.com',
  'livemint.com',
  'business-standard.com',
  'ndtv.com',
  'reuters.com',
  'bloomberg.com',
  'zerodha.com',
];

const REGISTRY_URL_FIELDS = ['investorRelations', 'financialResults', 'annualReports', 'earningsPresentations', 'earningsTranscripts'];

/**
 * Validates a company research profile's sourceRegistry: every URL must be a
 * well-formed http(s) URL, HTTPS is preferred, known aggregator/news domains
 * are rejected outright, and duplicate URLs (after normalization) are flagged.
 * Returns { valid, errors, warnings } instead of throwing, so callers (tests,
 * dry runs) can report every issue at once.
 */
export function validateCompanyResearchProfile(profile) {
  const errors = [];
  const warnings = [];

  if (!profile || typeof profile !== 'object') {
    return { valid: false, errors: ['Profile is missing or not an object'], warnings };
  }
  if (!profile.symbol) errors.push('symbol is required');
  if (!profile.companyName) errors.push('companyName is required');

  const registry = profile.sourceRegistry;
  if (!registry || typeof registry !== 'object') {
    errors.push('sourceRegistry is required');
    return { valid: errors.length === 0, errors, warnings };
  }

  for (const field of REGISTRY_URL_FIELDS) {
    const list = Array.isArray(registry[field]) ? registry[field] : [];
    for (const url of list) {
      if (!isValidHttpUrl(url)) {
        errors.push(`sourceRegistry.${field}: invalid or non-HTTP(S) URL "${url}"`);
        continue;
      }
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:') {
        warnings.push(`sourceRegistry.${field}: "${url}" should use HTTPS`);
      }
      if (BLOCKED_SOURCE_DOMAINS.some((domain) => parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`))) {
        errors.push(`sourceRegistry.${field}: "${parsed.hostname}" is a blocked aggregator/news domain, not a primary source`);
      }
    }
    if (dedupeRegistryUrls(list).length !== list.length) {
      warnings.push(`sourceRegistry.${field}: contains duplicate URLs after normalization`);
    }
  }

  const exchangeFilings = registry.exchangeFilings || {};
  for (const venue of ['nse', 'bse']) {
    const list = Array.isArray(exchangeFilings[venue]) ? exchangeFilings[venue] : [];
    for (const url of list) {
      if (!isValidHttpUrl(url)) errors.push(`sourceRegistry.exchangeFilings.${venue}: invalid URL "${url}"`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Returns or dynamically constructs a CompanyResearchProfile for any stock
 * symbol. This is the original, app-wide helper used across
 * DocumentResearchService/ManagementPromiseService for every symbol in
 * SUPPORTED_STOCKS (~150 tickers), not just the curated registry above.
 *
 * For symbols with a curated profile, the flat `investorRelationsUrls` /
 * `annualReportUrls` fields are derived from `sourceRegistry` (see above).
 *
 * For symbols WITHOUT a curated profile, this intentionally returns EMPTY
 * source arrays rather than guessing a company domain — a prior version of
 * this function fabricated URLs like `https://www.<companyname>.com/investors`,
 * which is exactly the kind of unverified-source risk this registry exists to
 * remove. Downstream document discovery treats an empty source list as "no
 * official sources on file", not as a fetch failure.
 */
export function getCompanyResearchProfile(symbol, fallbackName = '', fallbackSector = 'Generic') {
  const normalized = String(symbol || '').toUpperCase().trim();

  if (COMPANY_RESEARCH_PROFILES[normalized]) {
    const base = COMPANY_RESEARCH_PROFILES[normalized];
    const clone = cloneProfile(base);
    const derived = deriveFlatUrlsFromRegistry(clone.sourceRegistry);
    return {
      ...clone,
      investorRelationsUrls: derived.investorRelationsUrls,
      annualReportUrls: derived.annualReportUrls,
      sectorMetrics: SECTOR_METRICS[clone.sector] || SECTOR_METRICS.Generic,
    };
  }

  const name = fallbackName || normalized;
  const cleanName = name.replace(/\s+(Limited|Ltd\.?|Corporation|Corp\.?)$/i, '');
  const sector = fallbackSector || 'Generic';

  return {
    symbol: normalized,
    companyName: name,
    aliases: [name, cleanName, normalized],
    sector,
    sectorMetrics: SECTOR_METRICS[sector] || SECTOR_METRICS.Generic,
    exchangeSymbols: { NSE: normalized, BSE: normalized },
    exchangeIdentifiers: { nseSymbol: normalized, bseCode: normalized },
    // No curated, verified IR domain on file for this symbol — left empty
    // rather than fabricated. NSE's URL pattern is deterministic and official,
    // so it is still safe to include for exchange-filing discovery.
    investorRelationsUrls: [],
    annualReportUrls: [],
    sourceRegistryVerified: false,
    sourceRegistry: {
      investorRelations: [],
      financialResults: [],
      annualReports: [],
      earningsPresentations: [],
      earningsTranscripts: [],
      exchangeFilings: buildExchangeFilingUrls(normalized, null),
    },
    commonManagementTerms: [
      'management guidance',
      'revenue guidance',
      'revenue target',
      'EBITDA guidance',
      'margin guidance',
      'order book',
      'order intake',
      'capex',
      'expects',
      'targets',
      'aims',
    ],
  };
}

export default COMPANY_RESEARCH_PROFILES;
