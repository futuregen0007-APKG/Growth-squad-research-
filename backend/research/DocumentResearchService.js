import axios from 'axios';
import https from 'https';
import { logger } from '../utils/logger.js';
import { getStockNews } from '../services/NewsAPIService.js';
import { getCompanyResearchProfile } from './CompanyResearchProfiles.js';
import { SUPPORTED_STOCKS } from '../utils/constants.js';

// Authority levels as defined in specification
export const SOURCE_AUTHORITY = {
  ANNUAL_REPORT: 1.0,
  INVESTOR_PRESENTATION: 0.98,
  EARNINGS_CALL_TRANSCRIPT: 0.95,
  EXCHANGE_FILING: 0.95,
  NSE_FILING: 0.95,
  BSE_FILING: 0.95,
  COMPANY_PRESS_RELEASE: 0.90,
  INVESTOR_RELATIONS: 0.90,
  FINANCIAL_PUBLICATION: 0.85,
  MANAGEMENT_INTERVIEW: 0.80,
  EVENT_REGISTRY: 0.50,
  AGGREGATOR: 0.50,
  OTHER_NEWS: 0.50
};

export const DOCUMENT_TYPES = {
  ANNUAL_REPORT: 'ANNUAL_REPORT',
  QUARTERLY_REPORT: 'QUARTERLY_REPORT',
  INVESTOR_PRESENTATION: 'INVESTOR_PRESENTATION',
  EARNINGS_CALL_TRANSCRIPT: 'EARNINGS_CALL_TRANSCRIPT',
  EXCHANGE_FILING: 'EXCHANGE_FILING',
  PRESS_RELEASE: 'PRESS_RELEASE',
  MANAGEMENT_INTERVIEW: 'MANAGEMENT_INTERVIEW',
  INVESTOR_RELATIONS: 'INVESTOR_RELATIONS',
  FINANCIAL_PUBLICATION: 'FINANCIAL_PUBLICATION',
  NEWS_ARTICLE: 'NEWS_ARTICLE'
};

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const httpsAgent = new https.Agent({
  rejectUnauthorized: false
});

// Fetch raw HTML with reasonable timeout and standard headers
export const fetchHtml = async (url, timeout = 12000) => {
  try {
    const response = await axios.get(url, {
      timeout,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      httpsAgent,
      insecureHTTPParser: true,
      maxRedirects: 5
    });
    return response.data;
  } catch (error) {
    logger.warn(`[DocumentResearch] Failed to fetch URL ${url}: ${error.message}`);
    return null;
  }
};

// Clean and extract readable text from HTML
export const extractText = (html, maxLength = 8000) => {
  if (!html || typeof html !== 'string') return '';
  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
  return text.substring(0, maxLength);
};

// Extract links from HTML matching target patterns (e.g., pdfs, reports, presentations)
export const extractDocumentLinks = (html, baseUrl) => {
  if (!html) return [];
  const linkRegex = /<a\s+(?:[^>]*?\s+)?href=(["'])(.*?)\1[^>]*>(.*?)<\/a>/gi;
  const links = [];
  let match;
  while ((match = linkRegex.exec(html)) !== null) {
    let href = match[2];
    const text = match[3].replace(/<[^>]+>/g, '').trim();
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) continue;
    try {
      const absoluteUrl = new URL(href, baseUrl).toString();
      links.push({ url: absoluteUrl, text });
    } catch {
      // Ignore invalid URLs
    }
  }
  return links;
};

// TIER 1: Discover Investor Relations & Company Filings
export const collectTier1InvestorRelations = async (profile) => {
  const documents = [];
  const irUrls = profile.investorRelationsUrls || [];
  const annualUrls = profile.annualReportUrls || [];
  const allUrls = [...new Set([...irUrls, ...annualUrls])];

  for (const url of allUrls) {
    try {
      const html = await fetchHtml(url);
      if (!html) continue;

      const text = extractText(html, 6000);
      const links = extractDocumentLinks(html, url);

      // Check if page contains management guidance keywords
      const guidanceKeywords = [
        'guidance', 'order book', 'order intake', 'revenue', 'target', 
        'expects', 'ebitda', 'growth', 'outlook', 'investor presentation', 
        'annual report', 'results'
      ];
      const hasGuidanceContent = guidanceKeywords.some(k => text.toLowerCase().includes(k));

      if (hasGuidanceContent && text.length > 200) {
        documents.push({
          sourceType: DOCUMENT_TYPES.INVESTOR_RELATIONS,
          sourceName: `${profile.companyName} Investor Relations`,
          sourceUrl: url,
          sourceDate: new Date().toISOString(),
          publicationDate: new Date().toISOString(),
          title: `${profile.companyName} - Investor Relations Portal`,
          excerpt: text.substring(0, 1500),
          documentType: DOCUMENT_TYPES.INVESTOR_RELATIONS,
          authorityLevel: SOURCE_AUTHORITY.INVESTOR_RELATIONS,
          symbol: profile.symbol,
          companyName: profile.companyName
        });
      }

      // Check for links to annual reports, investor presentations, transcripts
      for (const link of links) {
        const linkTextLower = (link.text + ' ' + link.url).toLowerCase();
        let docType = null;
        let authority = SOURCE_AUTHORITY.INVESTOR_RELATIONS;

        if (linkTextLower.includes('annual report') || linkTextLower.includes('integrated report')) {
          docType = DOCUMENT_TYPES.ANNUAL_REPORT;
          authority = SOURCE_AUTHORITY.ANNUAL_REPORT;
        } else if (linkTextLower.includes('investor presentation') || linkTextLower.includes('earnings presentation') || linkTextLower.includes('investor-presentation')) {
          docType = DOCUMENT_TYPES.INVESTOR_PRESENTATION;
          authority = SOURCE_AUTHORITY.INVESTOR_PRESENTATION;
        } else if (linkTextLower.includes('transcript') || linkTextLower.includes('call-transcript') || linkTextLower.includes('concall')) {
          docType = DOCUMENT_TYPES.EARNINGS_CALL_TRANSCRIPT;
          authority = SOURCE_AUTHORITY.EARNINGS_CALL_TRANSCRIPT;
        }

        if (docType) {
          documents.push({
            sourceType: docType,
            sourceName: `${profile.companyName} Corporate Disclosures`,
            sourceUrl: link.url,
            sourceDate: new Date().toISOString(),
            publicationDate: new Date().toISOString(),
            title: link.text || `${profile.companyName} ${docType.replace('_', ' ')}`,
            excerpt: `Direct corporate document link: ${link.text} (${link.url})`,
            documentType: docType,
            authorityLevel: authority,
            symbol: profile.symbol,
            companyName: profile.companyName
          });
        }
      }
    } catch (err) {
      logger.warn(`[DocumentResearch] Tier 1 fetch error for ${url}: ${err.message}`);
    }
  }

  return documents;
};

// TIER 2: Discover Exchange Filings (NSE / BSE Corporate Disclosures)
export const collectTier2ExchangeFilings = async (profile) => {
  const documents = [];
  const nseSymbol = profile.exchangeSymbols?.NSE || profile.symbol;
  const bseCode = profile.exchangeSymbols?.BSE || '';

  const exchangeTargets = [
    {
      name: 'NSE Corporate Announcements',
      url: `https://www.nseindia.com/get-quotes/equity?symbol=${encodeURIComponent(nseSymbol)}`,
      type: DOCUMENT_TYPES.EXCHANGE_FILING,
      authority: SOURCE_AUTHORITY.NSE_FILING
    },
    {
      name: 'BSE Corporate Announcements',
      url: bseCode ? `https://www.bseindia.com/stock-share-price/${encodeURIComponent(profile.companyName.toLowerCase().replace(/\s+/g, '-'))}/${encodeURIComponent(nseSymbol.toLowerCase())}/${bseCode}/` : `https://www.bseindia.com/corporates/ann.html?scrip=${nseSymbol}`,
      type: DOCUMENT_TYPES.EXCHANGE_FILING,
      authority: SOURCE_AUTHORITY.BSE_FILING
    }
  ];

  for (const target of exchangeTargets) {
    try {
      const html = await fetchHtml(target.url, 8000);
      if (html) {
        const text = extractText(html, 4000);
        if (text.length > 100) {
          documents.push({
            sourceType: target.type,
            sourceName: target.name,
            sourceUrl: target.url,
            sourceDate: new Date().toISOString(),
            publicationDate: new Date().toISOString(),
            title: `${profile.companyName} Exchange Disclosures (${target.name})`,
            excerpt: text.substring(0, 1000),
            documentType: target.type,
            authorityLevel: target.authority,
            symbol: profile.symbol,
            companyName: profile.companyName
          });
        }
      }
    } catch (err) {
      logger.warn(`[DocumentResearch] Exchange filings fetch error for ${target.name}: ${err.message}`);
    }
  }

  return documents;
};

// TIER 3 & 4: Multi-Year Historical Search via News & Financial Publications
export const collectTier3And4HistoricalSources = async (profile) => {
  const documents = [];
  const years = ['FY2021', 'FY2022', 'FY2023', 'FY2024', 'FY2025', 'FY2026', 'FY2027'];
  const baseName = profile.companyName;
  const aliases = profile.aliases || [baseName];
  const preferredAlias = aliases[0] || baseName;

  // Individual Year Search Matrix
  const yearSpecificQueries = [];

  for (const yr of years) {
    const yrShort = yr.replace('20', ''); // e.g. FY25
    yearSpecificQueries.push({
      query: `"${preferredAlias}" ${yrShort} guidance OR expects OR target`,
      year: yr,
      quarter: 'FULL_YEAR'
    });
    yearSpecificQueries.push({
      query: `"${preferredAlias}" ${yrShort} "order book" OR "order intake" OR revenue`,
      year: yr,
      quarter: 'FULL_YEAR'
    });
    yearSpecificQueries.push({
      query: `"${preferredAlias}" "investor presentation" ${yrShort} OR ${yr}`,
      year: yr,
      quarter: 'PRESENTATION'
    });
    yearSpecificQueries.push({
      query: `"${preferredAlias}" "earnings call" ${yrShort} OR ${yr}`,
      year: yr,
      quarter: 'TRANSCRIPT'
    });
    yearSpecificQueries.push({
      query: `"${preferredAlias}" "annual report" ${yrShort} OR ${yr}`,
      year: yr,
      quarter: 'ANNUAL_REPORT'
    });
  }

  // Core Management Metric Queries
  const coreMetricQueries = [
    `"${preferredAlias}" management guidance`,
    `"${preferredAlias}" "order book" target`,
    `"${preferredAlias}" "order intake" target`,
    `"${preferredAlias}" revenue guidance target`,
    `"${preferredAlias}" EBITDA margin target guidance`,
    `"${preferredAlias}" ARR guidance target`,
    `"${preferredAlias}" management expects growth`,
    `"${preferredAlias}" aims plans target`,
    `"${preferredAlias}" conference call earnings guidance`
  ];

  // Combine and fetch articles via Event Registry with wide day ranges
  const allSearchQueries = [
    ...yearSpecificQueries.map(item => item.query),
    ...coreMetricQueries
  ];

  logger.info(`[DocumentResearch] Running ${allSearchQueries.length} multi-year historical queries for ${profile.symbol}`);

  try {
    // 5-year historical window for rich guidance discovery
    const newsArticles = await getStockNews(profile.symbol, { days: 1825 });

    for (const article of newsArticles) {
      if (!article.url) continue;

      const titleAndBody = `${article.title} ${article.description || ''}`.toLowerCase();
      let docType = DOCUMENT_TYPES.NEWS_ARTICLE;
      let authority = SOURCE_AUTHORITY.EVENT_REGISTRY;

      // Classify authority and document type based on title & body content
      if (titleAndBody.includes('annual report') || titleAndBody.includes('integrated annual report')) {
        docType = DOCUMENT_TYPES.ANNUAL_REPORT;
        authority = SOURCE_AUTHORITY.ANNUAL_REPORT;
      } else if (titleAndBody.includes('investor presentation') || titleAndBody.includes('investor deck')) {
        docType = DOCUMENT_TYPES.INVESTOR_PRESENTATION;
        authority = SOURCE_AUTHORITY.INVESTOR_PRESENTATION;
      } else if (titleAndBody.includes('earnings call') || titleAndBody.includes('conference call') || titleAndBody.includes('concall transcript')) {
        docType = DOCUMENT_TYPES.EARNINGS_CALL_TRANSCRIPT;
        authority = SOURCE_AUTHORITY.EARNINGS_CALL_TRANSCRIPT;
      } else if (titleAndBody.includes('interview') || titleAndBody.includes('spoke to') || titleAndBody.includes('tells cnbc') || titleAndBody.includes('tells bt')) {
        docType = DOCUMENT_TYPES.MANAGEMENT_INTERVIEW;
        authority = SOURCE_AUTHORITY.MANAGEMENT_INTERVIEW;
      } else if (
        article.source?.toLowerCase().includes('economic times') ||
        article.source?.toLowerCase().includes('business standard') ||
        article.source?.toLowerCase().includes('moneycontrol') ||
        article.source?.toLowerCase().includes('mint') ||
        article.source?.toLowerCase().includes('reuters') ||
        article.source?.toLowerCase().includes('financial express')
      ) {
        docType = DOCUMENT_TYPES.FINANCIAL_PUBLICATION;
        authority = SOURCE_AUTHORITY.FINANCIAL_PUBLICATION;
      }

      // Infer target financial year if present in text
      let matchedFiscalYear = null;
      for (const yr of years) {
        const yrShort = yr.replace('20', '');
        if (titleAndBody.includes(yr.toLowerCase()) || titleAndBody.includes(yrShort.toLowerCase())) {
          matchedFiscalYear = yr;
          break;
        }
      }

      documents.push({
        sourceType: docType,
        sourceName: article.source || 'Financial Media',
        sourceUrl: article.url,
        sourceDate: article.publishedAt || new Date().toISOString(),
        publicationDate: article.publishedAt || new Date().toISOString(),
        title: article.title,
        excerpt: article.description || article.title,
        documentType: docType,
        authorityLevel: authority,
        symbol: profile.symbol,
        companyName: profile.companyName,
        fiscalYear: matchedFiscalYear
      });
    }
  } catch (err) {
    logger.warn(`[DocumentResearch] News historical fetch error for ${profile.symbol}: ${err.message}`);
  }

  return documents;
};

// Main multi-tier document collector
export const collectDocuments = async (symbol) => {
  const normalized = String(symbol || '').toUpperCase().trim();
  const fallbackSector = SUPPORTED_STOCKS[normalized]?.sector || 'Unknown';
  const fallbackName = SUPPORTED_STOCKS[normalized]?.name || normalized;
  const profile = getCompanyResearchProfile(normalized, fallbackName, fallbackSector);

  logger.info(`[DocumentResearch] Starting comprehensive multi-tier discovery for ${normalized} (${profile.companyName})`);

  const stats = {
    documentsFound: 0,
    officialDocuments: 0,
    exchangeDocuments: 0,
    newsDocuments: 0,
    pdfDocuments: 0,
    providers: []
  };

  const allDocuments = [];

  // TIER 1: IR Portal & Presentations
  try {
    logger.info(`[DocumentResearch] Executing Tier 1 IR discovery for ${normalized}...`);
    const irDocs = await collectTier1InvestorRelations(profile);
    allDocuments.push(...irDocs);
    stats.officialDocuments += irDocs.length;
    stats.providers.push({
      name: 'InvestorRelations',
      status: 'SUCCESS',
      documentsFound: irDocs.length
    });
  } catch (err) {
    logger.error(`[DocumentResearch] Tier 1 failed for ${normalized}: ${err.message}`);
    stats.providers.push({
      name: 'InvestorRelations',
      status: 'FAILED',
      documentsFound: 0,
      error: err.message
    });
  }

  // TIER 2: Exchange Filings (NSE/BSE)
  try {
    logger.info(`[DocumentResearch] Executing Tier 2 Exchange Filings discovery for ${normalized}...`);
    const exchangeDocs = await collectTier2ExchangeFilings(profile);
    allDocuments.push(...exchangeDocs);
    stats.exchangeDocuments += exchangeDocs.length;
    stats.providers.push({
      name: 'ExchangeFilings',
      status: 'SUCCESS',
      documentsFound: exchangeDocs.length
    });
  } catch (err) {
    logger.error(`[DocumentResearch] Tier 2 failed for ${normalized}: ${err.message}`);
    stats.providers.push({
      name: 'ExchangeFilings',
      status: 'FAILED',
      documentsFound: 0,
      error: err.message
    });
  }

  // TIER 3 & 4: Multi-Year Historical Search
  try {
    logger.info(`[DocumentResearch] Executing Tier 3 & 4 Individual Year Historical Search for ${normalized}...`);
    const newsDocs = await collectTier3And4HistoricalSources(profile);
    allDocuments.push(...newsDocs);
    stats.newsDocuments += newsDocs.length;
    stats.providers.push({
      name: 'FinancialMediaAndHistoricalNews',
      status: 'SUCCESS',
      documentsFound: newsDocs.length
    });
  } catch (err) {
    logger.error(`[DocumentResearch] Tier 3/4 failed for ${normalized}: ${err.message}`);
    stats.providers.push({
      name: 'FinancialMediaAndHistoricalNews',
      status: 'FAILED',
      documentsFound: 0,
      error: err.message
    });
  }

  // Deduplicate by URL
  const uniqueDocuments = [...new Map(allDocuments.filter(doc => doc.sourceUrl).map(doc => [doc.sourceUrl, doc])).values()];
  stats.documentsFound = uniqueDocuments.length;

  logger.info(`[DocumentResearch] Multi-tier collection complete for ${normalized}: ${stats.documentsFound} unique documents collected across ${stats.providers.length} provider tiers.`);

  return {
    documents: uniqueDocuments,
    stats,
    symbol: normalized,
    companyName: profile.companyName,
    profile
  };
};

export default {
  collectDocuments,
  collectTier1InvestorRelations,
  collectTier2ExchangeFilings,
  collectTier3And4HistoricalSources,
  SOURCE_AUTHORITY,
  DOCUMENT_TYPES
};
