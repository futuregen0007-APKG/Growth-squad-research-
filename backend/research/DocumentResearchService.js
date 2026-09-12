import axios from 'axios';
import crypto from 'node:crypto';
import { logger } from '../utils/logger.js';
import { getStockNews } from '../services/NewsAPIService.js';
import { getCompanyResearchProfile, COMPANY_RESEARCH_PROFILES } from './CompanyResearchProfiles.js';
import { SUPPORTED_STOCKS } from '../utils/constants.js';

export const SOURCE_AUTHORITY = {
  ANNUAL_REPORT: 1.0,
  INVESTOR_PRESENTATION: 0.98,
  EARNINGS_CALL_TRANSCRIPT: 0.95,
  EXCHANGE_FILING: 0.95,
  NSE_FILING: 0.95,
  BSE_FILING: 0.95,
  COMPANY_PRESS_RELEASE: 0.9,
  INVESTOR_RELATIONS: 0.9,
  FINANCIAL_PUBLICATION: 0.85,
  MANAGEMENT_INTERVIEW: 0.8,
  EVENT_REGISTRY: 0.5,
  AGGREGATOR: 0.5,
  OTHER_NEWS: 0.5
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
const DEFAULT_TIMEOUT = 20000;

export const classifyFetchFailure = (error = {}) => {
  const code = String(error.code || error.name || 'UNKNOWN_ERROR');
  const message = String(error.message || '');
  const status = error.response?.status || error.status || null;
  const lower = message.toLowerCase();
  
  // Extract TLS-specific details if available
  let tlsDetails = null;
  if (error.cause) {
    const causeStr = String(error.cause);
    if (causeStr.includes('certificate') || causeStr.includes('cert')) {
      tlsDetails = {
        cause: causeStr,
        errno: error.cause.errno || null,
        syscall: error.cause.syscall || null
      };
    }
  }

  if (code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || code === 'CERT_HAS_EXPIRED' || lower.includes('unable to verify the first certificate') || lower.includes('self signed certificate') || lower.includes('certificate')) {
    return { 
      code, 
      message, 
      severity: 'TLS_FAILURE', 
      isBlocking: true,
      tlsDetails 
    };
  }

  if (status && status >= 400) {
    return { code: `HTTP_${status}`, message, severity: 'HTTP_FAILURE', isBlocking: true, status };
  }

  if (lower.includes('redirect') || code === 'ERR_BAD_REQUEST') {
    return { code, message, severity: 'REDIRECT_FAILURE', isBlocking: true, status };
  }

  if (lower.includes('network') || code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ENOTFOUND') {
    return { code, message, severity: 'NETWORK_FAILURE', isBlocking: true };
  }

  return { code, message, severity: 'FETCH_FAILURE', isBlocking: true };
};

export const isPdfBuffer = (value) => {
  if (!value) return false;
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return buffer.subarray(0, 5).toString('ascii') === '%PDF-';
};

const toIsoDate = (value) => {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
};

export const normalizeDocumentUrl = (value, baseUrl = '') => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  if (trimmed.startsWith('javascript:') || trimmed.startsWith('mailto:') || trimmed.startsWith('tel:')) return null;

  try {
    const parsed = new URL(trimmed, baseUrl || undefined);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    return parsed.toString().split('#')[0];
  } catch {
    return null;
  }
};

export const deduplicateUrls = (values = []) => {
  const unique = new Map();

  for (const value of values) {
    const normalized = normalizeDocumentUrl(value);
    if (!normalized) continue;
    const parsed = new URL(normalized);
    const key = `${parsed.origin}${parsed.pathname}${parsed.search}`;
    if (!unique.has(key)) unique.set(key, normalized);
  }

  return Array.from(unique.values());
};

export const discoverPdfLinks = (html, baseUrl, provider = 'Unknown') => {
  if (!html || typeof html !== 'string') return [];

  // Enhanced regex to capture all link attributes
  const matches = [...html.matchAll(/<a\b[^>]*href=(['"])(.*?)\1[^>]*>(.*?)<\/a>/gis)];
  const discovered = [];
  const seen = new Set();

  // Document type patterns for improved classification
  const reportPatterns = /annual|quarterly|results|earnings|presentation|transcript|filing|financial|report|disclosure|prospectus|form|statement|notice|audit|consolidated|standalone/i;
  const pdfPatterns = /\.pdf(?:$|[?#])/i;
  const docPatterns = /\.(pdf|doc|docx|xlsx|xls|ppt|pptx)(?:$|[?#])/i;
  const exchangePatterns = /nse|bse|exchange|filing|corporate|announcement/i;

  for (const match of matches) {
    const rawHref = match[2] || '';
    const anchorText = match[3] || '';
    
    // Extract clean text from anchor
    const title = anchorText
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    
    const normalizedUrl = normalizeDocumentUrl(rawHref, baseUrl);
    if (!normalizedUrl) continue;

    const lowerUrl = normalizedUrl.toLowerCase();
    const searchText = (title + ' ' + normalizedUrl).toLowerCase();
    
    // Comprehensive document detection
    const isPdfFile = pdfPatterns.test(normalizedUrl);
    const isDocFile = docPatterns.test(normalizedUrl);
    const isReportLike = reportPatterns.test(searchText) && docPatterns.test(normalizedUrl);
    const isExchangeFiling = exchangePatterns.test(searchText) && docPatterns.test(normalizedUrl);
    const isFinancialDocument = (isPdfFile || isDocFile) && (searchText.includes('result') || searchText.includes('annual') || searchText.includes('quarterly') || searchText.includes('presentation'));
    
    // Accept document if it matches any criteria
    if (!(isPdfFile || isReportLike || isExchangeFiling || isFinancialDocument)) continue;
    
    if (seen.has(normalizedUrl)) continue;
    seen.add(normalizedUrl);

    discovered.push({
      url: normalizedUrl,
      title: title || normalizedUrl.split('/').pop(),
      provider,
      sourcePage: baseUrl,
      discoveredFrom: baseUrl,
      kind: 'DOCUMENT',
      classification: isReportLike ? 'REPORT' : isExchangeFiling ? 'EXCHANGE_FILING' : 'DOCUMENT'
    });
  }

  return discovered;
};

export const buildDocumentProvenance = ({
  url,
  title,
  provider,
  sourceType,
  discoveredFrom,
  publishedAt,
  text = '',
  extractionStatus = 'SUCCESS',
  contentLength,
  sourceDate,
  // NEW: Source trust metadata
  resolvedUrl = null,
  httpStatus = null,
  contentType = null,
  trustLevel = 'OFFICIAL',
  discoveryPath = null,
  sourceHash = null,
  pages = null
}) => {
  const canonicalUrl = normalizeDocumentUrl(url, discoveredFrom || '');
  const safeText = String(text || '').trim();
  const hashSource = `${canonicalUrl || ''}|${provider || ''}|${sourceType || ''}|${safeText}`;
  const contentHash = crypto.createHash('sha256').update(hashSource).digest('hex');

  return {
    url: canonicalUrl || url || null,
    canonicalUrl: canonicalUrl || url || null,
    title: String(title || 'Untitled Document').trim() || 'Untitled Document',
    provider: provider || 'Unknown',
    sourceType: sourceType || 'INVESTOR_RELATIONS',
    discoveredFrom: discoveredFrom || null,
    publishedAt: toIsoDate(publishedAt || sourceDate) || null,
    sourceDate: toIsoDate(publishedAt || sourceDate) || null,
    retrievedAt: new Date().toISOString(),
    contentHash: contentHash,
    extractionStatus: extractionStatus || 'SUCCESS',
    contentLength: Number.isFinite(contentLength) ? Number(contentLength) : safeText.length,
    text: safeText,
    pages: Array.isArray(pages) ? pages : undefined,
    excerpt: safeText.slice(0, 2000),
    // NEW: Source trust metadata
    sourceTrust: {
      resolvedUrl: resolvedUrl || canonicalUrl || null,
      httpStatus: httpStatus || 200,
      contentType: contentType || 'application/pdf',
      trustLevel: trustLevel, // OFFICIAL, TRUSTED_EXCHANGE, TRUSTED_MEDIA, DISCOVERY_ONLY
      discoveryPath: discoveryPath || [url], // Chain: [landing_page, intermediate, final_url]
      sourceHash: sourceHash || contentHash
    }
  };
};

/** NEW: Discover PDFs from landing pages that link to PDFs */
export const discoverPdfsFromLandingPage = async (landingPageUrl, baseHtml, provider = 'ExchangeFilings', maxDepth = 1) => {
  const discovered = [];
  const visited = new Set([landingPageUrl]);
  
  const trustedDomains = [
    'nseindia.com',
    'bseindia.com',
    'newgensoft.com',
    'tcs.com',
    'infosys.com',
    'tata.com'
  ];
  
  const isTrustedDomain = (urlStr) => {
    try {
      const url = new URL(urlStr);
      return trustedDomains.some(domain => url.hostname.includes(domain));
    } catch {
      return false;
    }
  };

  const extractCandidatePdfLinks = (html, baseUrl) => {
    const candidates = [];
    
    // Pattern 1: Direct PDF links in href
    const pdfLinkRegex = /<a\b[^>]*href=(['"])(.*?\.pdf.*?)\1[^>]*>(.*?)<\/a>/gis;
    let match;
    while ((match = pdfLinkRegex.exec(html)) !== null) {
      const href = match[2];
      const text = match[3];
      const normalized = normalizeDocumentUrl(href, baseUrl);
      if (normalized && isTrustedDomain(normalized)) {
        candidates.push({ url: normalized, text, type: 'DIRECT_PDF' });
      }
    }

    // Pattern 2: Links that might be PDF landing pages (results, presentations, reports)
    const docLinkRegex = /<a\b[^>]*href=(['"])(.*?)\1[^>]*>(.*?(?:result|presentation|report|annual|quarterly|filing|disclosure).*?)<\/a>/gis;
    while ((match = docLinkRegex.exec(html)) !== null) {
      const href = match[2];
      const text = match[3];
      const normalized = normalizeDocumentUrl(href, baseUrl);
      if (normalized && isTrustedDomain(normalized) && !normalized.endsWith('.pdf')) {
        candidates.push({ url: normalized, text, type: 'LANDING_PAGE' });
      }
    }

    return candidates;
  };

  // Start with landing page
  const directPdfs = extractCandidatePdfLinks(baseHtml, landingPageUrl);
  for (const pdf of directPdfs) {
    if (pdf.type === 'DIRECT_PDF') {
      discovered.push({
        url: pdf.url,
        title: pdf.text || pdf.url.split('/').pop(),
        provider,
        discoveredFrom: landingPageUrl,
        discoveryPath: [landingPageUrl, pdf.url],
        kind: 'DOCUMENT'
      });
    }
  }

  // Follow landing pages to depth 1
  if (maxDepth > 0) {
    const landingPages = directPdfs.filter(p => p.type === 'LANDING_PAGE');
    for (const landing of landingPages.slice(0, 5)) { // Limit to avoid excessive fetches
      if (visited.has(landing.url)) continue;
      visited.add(landing.url);

      try {
        const landingResult = await fetchWithMetadata(landing.url, 15000, 'text');
        if (landingResult.ok && landingResult.data) {
          const landingPdfs = extractCandidatePdfLinks(landingResult.data, landing.url);
          for (const pdf of landingPdfs) {
            if (pdf.type === 'DIRECT_PDF') {
              discovered.push({
                url: pdf.url,
                title: pdf.text || pdf.url.split('/').pop(),
                provider,
                discoveredFrom: landingPageUrl,
                discoveryPath: [landingPageUrl, landing.url, pdf.url],
                kind: 'DOCUMENT'
              });
            }
          }
        }
      } catch (err) {
        logger.debug(`[DocumentResearch] Failed to follow landing page ${landing.url}: ${err.message}`);
      }
    }
  }

  return discovered;
};

export const documentQualityGate = (document = {}) => {
  const url = normalizeDocumentUrl(document.url || document.sourceUrl || document.canonicalUrl, document.discoveredFrom || '');
  if (!url) return false;
  if (!document.provider && !document.sourceName) return false;
  if (!document.title && !document.name) return false;
  if (document.extractionStatus !== 'SUCCESS') return false;

  const text = String(document.text || document.excerpt || document.fullText || '').trim();
  if (text.length < 80) return false;
  if (text.split(/\s+/).length < 8) return false;
  if (document.contentLength != null && Number(document.contentLength) < 80) return false;

  // NEW: Reject generic landing pages
  const genericLandingPatterns = [
    /NSE - National Stock Exchange of India/i,
    /BSE SENSEX.*Live Share Market/i,
    /Quick Links.*Equity.*Listing.*IPO/i,
    /YOU ARE ON THE NEW NSE WEBSITE/i,
    /CAS Option Chain Market Turnover/i,
    /Corporate Filings Announcement - Equity/i,
    /LIVE Stock.*Share Market.*Indian Stock/i
  ];
  
  const isGenericLandingPage = genericLandingPatterns.some(pattern => pattern.test(text));
  if (isGenericLandingPage) {
    logger.debug(`[DocumentQuality] Rejected generic landing page: ${url}`);
    return false;
  }

  // NEW: Reject documents that are just URL+title placeholders
  const isPlaceholder = text === `${document.title || ''} ${url}` || text === `${document.title || document.sourceName || ''} ${url}`;
  if (isPlaceholder && text.length < 200) {
    logger.debug(`[DocumentQuality] Rejected placeholder document: ${url}`);
    return false;
  }

  return true;
};

/**
 * Conservative cross-company guard: rejects a document only when its text/title
 * clearly names a *different* registered company and never mentions the one
 * being researched. It never rejects for silence about the target company alone
 * (sector/market commentary legitimately may not repeat the ticker), so it only
 * catches the detectable case of evidence attributed to the wrong company.
 */
export const documentMatchesCompany = (document = {}, profile = {}) => {
  const symbol = String(profile.symbol || '').trim().toUpperCase();
  const knownNames = [profile.companyName, ...(profile.aliases || [])].filter(Boolean).map((n) => String(n).toLowerCase());
  if (!symbol && !knownNames.length) return true;

  const haystack = `${document.title || ''} ${document.text || document.excerpt || ''}`.toLowerCase();
  if (!haystack.trim()) return true;

  const mentionsTarget = (symbol && haystack.includes(symbol.toLowerCase())) || knownNames.some((name) => haystack.includes(name));
  if (mentionsTarget) return true;

  for (const [otherSymbol, otherProfile] of Object.entries(COMPANY_RESEARCH_PROFILES)) {
    if (otherSymbol === symbol) continue;
    const otherNames = [otherProfile.companyName, ...(otherProfile.aliases || [])].filter(Boolean).map((n) => String(n).toLowerCase());
    if (otherNames.some((name) => haystack.includes(name))) return false;
  }

  return true;
};

const fetchWithMetadata = async (url, timeout = DEFAULT_TIMEOUT, responseType = 'text') => {
  try {
    const response = await axios.get(url, {
      timeout,
      responseType,
      maxRedirects: 5,
      validateStatus: (status) => status >= 200 && status < 400,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': responseType === 'arraybuffer'
          ? 'application/pdf,application/octet-stream;q=0.9,*/*;q=0.1'
          : 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      }
    });

    if (responseType === 'arraybuffer' && !isPdfBuffer(response.data)) {
      const contentType = String(response.headers?.['content-type'] || '').toLowerCase();
      const failure = {
        ...classifyFetchFailure({
          code: 'INVALID_DOCUMENT',
          message: `Expected PDF but received ${contentType || 'unknown content'}`,
          status: response.status
        }),
        code: 'INVALID_DOCUMENT',
        severity: 'INVALID_DOCUMENT',
        contentType
      };
      logger.warn(`[DocumentResearch] Rejected non-PDF response from ${url}: ${failure.message}`);
      return { ok: false, url, error: failure, status: response.status, data: null, finalUrl: null };
    }

    return {
      ok: true,
      url,
      data: response.data,
      finalUrl: response.request?.res?.responseUrl || response.config?.url || url,
      status: response.status,
      headers: response.headers || {}
    };
  } catch (error) {
    const failure = classifyFetchFailure(error);
    
    // Log detailed TLS errors for debugging
    if (failure.severity === 'TLS_FAILURE') {
      logger.warn(`[DocumentResearch] TLS failure fetching ${url}: ${failure.code} - ${failure.message}`, {
        url: url.split('?')[0], // Hide query params
        code: failure.code,
        tlsDetails: failure.tlsDetails,
        userAgent: USER_AGENT
      });
    } else {
      logger.warn(`[DocumentResearch] Failed to fetch URL ${url}: ${failure.code} - ${failure.message}`);
    }
    
    return { ok: false, url, error: failure, status: null, data: null, finalUrl: null };
  }
};

export const fetchPdf = async (url, timeout = DEFAULT_TIMEOUT) => (
  fetchWithMetadata(url, timeout, 'arraybuffer')
);

export const fetchHtml = async (url, timeout = DEFAULT_TIMEOUT) => {
  const result = await fetchWithMetadata(url, timeout, 'text');
  return result.ok ? result.data : null;
};

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

export const extractDocumentLinks = (html, baseUrl) => {
  if (!html) return [];
  const linkRegex = /<a\s+(?:[^>]*?\s+)?href=(['"])(.*?)\1[^>]*>(.*?)<\/a>/gi;
  const links = [];
  const seen = new Set();
  let match;

  while ((match = linkRegex.exec(html)) !== null) {
    const href = match[2];
    const text = (match[3] || '').replace(/<[^>]+>/g, '').trim();
    if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:')) continue;
    const normalized = normalizeDocumentUrl(href, baseUrl);
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    links.push({ url: normalized, text });
  }

  return links;
};

const classifyLinkType = (linkText, rawUrl) => {
  const lower = `${linkText || ''} ${rawUrl || ''}`.toLowerCase();

  if (lower.includes('annual report') || lower.includes('integrated report') || lower.includes('annual-report')) return DOCUMENT_TYPES.ANNUAL_REPORT;
  if (lower.includes('quarterly results') || lower.includes('quarterly result') || /(q[1-4])/.test(lower)) return DOCUMENT_TYPES.QUARTERLY_REPORT;
  if (lower.includes('investor presentation') || lower.includes('earnings presentation') || lower.includes('investor-presentation')) return DOCUMENT_TYPES.INVESTOR_PRESENTATION;
  if (lower.includes('transcript') || lower.includes('earnings call') || lower.includes('conference call') || lower.includes('concall')) return DOCUMENT_TYPES.EARNINGS_CALL_TRANSCRIPT;
  if (lower.includes('exchange filing') || lower.includes('corporate filing') || lower.includes('filing')) return DOCUMENT_TYPES.EXCHANGE_FILING;
  if (lower.includes('press release')) return DOCUMENT_TYPES.PRESS_RELEASE;
  return DOCUMENT_TYPES.INVESTOR_RELATIONS;
};

const buildEvidenceFromLink = (link, sourcePage, providerName) => {
  const candidateUrl = normalizeDocumentUrl(link.url, sourcePage);
  if (!candidateUrl) return null;
  const docType = classifyLinkType(link.text, candidateUrl);
  const title = (link.text || docType.replace(/_/g, ' ')).trim() || `${providerName} Document`;

  return buildDocumentProvenance({
    url: candidateUrl,
    title,
    provider: providerName,
    sourceType: docType,
    discoveredFrom: sourcePage,
    publishedAt: null,
    text: `${title} ${candidateUrl}`,
    extractionStatus: 'SUCCESS',
    contentLength: (title + ' ' + candidateUrl).length
  });
};

const safePdfText = (text = '') => String(text || '').replace(/\s+/g, ' ').trim().slice(0, 20000);

const extractPdfText = async (buffer) => {
  try {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: buffer });
    const parsed = await parser.getText();
    await parser.destroy();
    return {
      text: safePdfText(parsed.text || ''),
      pages: (parsed.pages || []).map((page, index) => ({
        pageNumber: index + 1,
        text: safePdfText(page.text || '')
      }))
    };
  } catch (err) {
    logger.warn(`[DocumentResearch] Failed to parse PDF: ${err.message}`);
    return null;
  }
};

export const collectTier1InvestorRelations = async (profile, debugState = null) => {
  const documents = [];
  const irUrls = profile.investorRelationsUrls || [];
  const annualUrls = profile.annualReportUrls || [];
  const allUrls = deduplicateUrls([...irUrls, ...annualUrls]);

  for (const url of allUrls) {
    const result = await fetchWithMetadata(url, 20000, 'text');
    if (debugState) {
      debugState.urlsAttempted.push(url);
      if (result.ok) {
        debugState.urlsSuccessfullyRetrieved.push(result.finalUrl || url);
      } else {
        debugState.failedUrls.push({ 
          url, 
          code: result.error?.code || 'UNKNOWN_ERROR', 
          reason: result.error?.message || 'Request failed',
          severity: result.error?.severity || 'UNKNOWN',
          tlsDetails: result.error?.tlsDetails || null
        });
      }
    }

    if (!result.ok || !result.data) continue;

    const html = result.data;
    const text = extractText(html, 6000);
    
    // Enhanced link discovery using both discoverPdfLinks and extractDocumentLinks
    const links = extractDocumentLinks(html, url);
    const pdfLinks = discoverPdfLinks(html, url, 'InvestorRelations');
    
    // Combine discovered links, preferring documents
    const allDiscoveredLinks = [...pdfLinks, ...links.map(link => ({
      url: link.url,
      title: link.text || link.url,
      provider: 'InvestorRelations',
      discoveredFrom: url,
      kind: 'LINK'
    }))];

    // Track discovered links
    for (const link of allDiscoveredLinks) {
      if (debugState) {
        debugState.linksDiscovered = (debugState.linksDiscovered || 0) + 1;
      }
    }

    // NEW: Enhanced PDF discovery - direct PDFs AND from landing pages
    const directPdfs = discoverPdfLinks(html, url, 'InvestorRelations');
    const landingPagePdfs = await discoverPdfsFromLandingPage(url, html, 'InvestorRelations', 1);
    const allPdfsToFetch = [...directPdfs, ...landingPagePdfs];

    // Download and extract PDFs
    for (const pdfLink of allPdfsToFetch) {
      const pdfFetch = await fetchWithMetadata(pdfLink.url, 30000, 'arraybuffer');
      if (debugState) {
        debugState.pdfsDiscovered.push(pdfLink.url);
      }
      
      if (!pdfFetch.ok) {
        if (debugState) {
          debugState.failedUrls.push({ 
            url: pdfLink.url, 
            code: pdfFetch.error?.code || 'UNKNOWN_ERROR', 
            reason: pdfFetch.error?.message || 'PDF download failed',
            severity: pdfFetch.error?.severity || 'UNKNOWN',
            tlsDetails: pdfFetch.error?.tlsDetails || null
          });
        }
        continue;
      }

      const extractedText = await extractPdfText(pdfFetch.data);
      if (!extractedText || extractedText.text.length < 200) {
        if (debugState) {
          debugState.rejectedDocuments.push({ 
            url: pdfLink.url, 
            reason: 'EMPTY_OR_SHORT_PDF',
            contentLength: extractedText?.text.length || 0
          });
        }
        continue;
      }

      const doc = buildDocumentProvenance({
        url: pdfLink.url,
        title: pdfLink.title || 'PDF Document',
        provider: 'InvestorRelations',
        sourceType: DOCUMENT_TYPES.ANNUAL_REPORT,
        discoveredFrom: url,
        publishedAt: null,
        text: extractedText.text,
        pages: extractedText.pages,
        extractionStatus: 'SUCCESS',
        contentLength: extractedText.text.length,
        discoveryPath: pdfLink.discoveryPath,
        trustLevel: 'OFFICIAL'
      });

      if (documentQualityGate(doc)) {
        if (debugState) {
          debugState.pdfsSuccessfullyExtracted.push(pdfLink.url);
        }
        documents.push(doc);
      } else if (debugState) {
        debugState.rejectedDocuments.push({ 
          url: pdfLink.url, 
          reason: 'QUALITY_GATE_FAILED',
          contentLength: doc.contentLength
        });
      }
    }

    // Process landing page content
    const guidanceKeywords = ['guidance', 'order book', 'order intake', 'revenue', 'target', 'expects', 'ebitda', 'outlook', 'annual report', 'results'];
    const hasGuidanceContent = guidanceKeywords.some((keyword) => text.toLowerCase().includes(keyword));
    if (hasGuidanceContent && text.length > 200) {
      const landingDoc = buildDocumentProvenance({
        url,
        title: `${profile.companyName} Investor Relations`,
        provider: 'InvestorRelations',
        sourceType: DOCUMENT_TYPES.INVESTOR_RELATIONS,
        discoveredFrom: url,
        publishedAt: null,
        text,
        extractionStatus: 'SUCCESS',
        contentLength: text.length,
      });

      if (documentQualityGate(landingDoc)) {
        documents.push(landingDoc);
      }
    }

    // Link metadata alone is not evidence; only downloaded and extracted documents qualify.
  }

  return documents;
};

export const collectTier2ExchangeFilings = async (profile, debugState = null) => {
  const documents = [];
  const nseSymbol = profile.exchangeSymbols?.NSE || profile.symbol;
  const bseCode = profile.exchangeSymbols?.BSE || '';

  // Registry-sourced (CompanyResearchProfiles.sourceRegistry.exchangeFilings) URLs are
  // merged in and deduplicated alongside the always-present, symbol-parametrized ones
  // below, so a curated registry entry can extend exchange discovery without replacing it.
  const registryNseLinks = Array.isArray(profile.sourceRegistry?.exchangeFilings?.nse) ? profile.sourceRegistry.exchangeFilings.nse : [];
  const registryBseLinks = Array.isArray(profile.sourceRegistry?.exchangeFilings?.bse) ? profile.sourceRegistry.exchangeFilings.bse : [];

  const exchangeTargets = [
    {
      name: 'NSE Corporate Announcements',
      url: `https://www.nseindia.com/get-quotes/equity?symbol=${encodeURIComponent(nseSymbol)}`,
      type: DOCUMENT_TYPES.EXCHANGE_FILING,
      authority: SOURCE_AUTHORITY.NSE_FILING,
      secondaryLinks: deduplicateUrls([
        `https://www.nseindia.com/companies-listing/corporate-filings-announcements?symbol=${encodeURIComponent(nseSymbol)}`,
        `https://www.nseindia.com/companies-listing/corporate-filings-financial-results?symbol=${encodeURIComponent(nseSymbol)}`,
        `https://www.nseindia.com/companies-listing/corporate-filings-board-meetings?symbol=${encodeURIComponent(nseSymbol)}`,
        ...registryNseLinks
      ])
    },
    {
      name: 'BSE Corporate Announcements',
      url: bseCode ? `https://www.bseindia.com/stock-share-price/${encodeURIComponent(profile.companyName.toLowerCase().replace(/\s+/g, '-'))}/${encodeURIComponent(nseSymbol.toLowerCase())}/${bseCode}/` : `https://www.bseindia.com/corporates/ann.html?scrip=${nseSymbol}`,
      type: DOCUMENT_TYPES.EXCHANGE_FILING,
      authority: SOURCE_AUTHORITY.BSE_FILING,
      secondaryLinks: deduplicateUrls([
        `https://www.bseindia.com/corporates/ann.html?scrip=${nseSymbol}`,
        `https://www.bseindia.com/corporates/announcements.aspx?scrip=${bseCode}`,
        ...registryBseLinks
      ])
    }
  ];

  const processExchangePage = async (target, url, parentName) => {
    const result = await fetchWithMetadata(url, 12000, 'text');
    if (debugState) {
      debugState.urlsAttempted.push(url);
      if (result.ok) {
        debugState.urlsSuccessfullyRetrieved.push(result.finalUrl || url);
      } else {
        debugState.failedUrls.push({ 
          url, 
          code: result.error?.code || 'UNKNOWN_ERROR', 
          reason: result.error?.message || 'Exchange fetch failed',
          severity: result.error?.severity || 'UNKNOWN',
          tlsDetails: result.error?.tlsDetails || null
        });
      }
    }

    if (!result.ok || !result.data) return;
    
    const html = result.data;
    const text = extractText(html, 4000);
    if (text.length <= 100) return;

    // NEW: Enhanced PDF discovery from landing pages
    // Discover PDFs directly on this page AND from linked landing pages
    const directPdfs = discoverPdfLinks(html, url, 'ExchangeFilings');
    const landingPagePdfs = await discoverPdfsFromLandingPage(url, html, 'ExchangeFilings', 1);
    const allDiscoveredPdfs = [...directPdfs, ...landingPagePdfs];
    
    for (const pdf of allDiscoveredPdfs) {
      if (debugState) {
        debugState.pdfsDiscovered.push(pdf.url);
      }
      
      // NEW: Actually download and extract PDF content
      const pdfFetch = await fetchWithMetadata(pdf.url, 30000, 'arraybuffer');
      
      if (!pdfFetch.ok) {
        if (debugState) {
          debugState.failedUrls.push({ 
            url: pdf.url, 
            code: pdfFetch.error?.code || 'UNKNOWN_ERROR', 
            reason: pdfFetch.error?.message || 'PDF download failed',
            severity: pdfFetch.error?.severity || 'UNKNOWN',
            tlsDetails: pdfFetch.error?.tlsDetails || null
          });
        }
        continue;
      }

      const extractedText = await extractPdfText(pdfFetch.data);
      if (!extractedText || extractedText.text.length < 200) {
        if (debugState) {
          debugState.rejectedDocuments.push({ 
            url: pdf.url, 
            reason: 'EMPTY_OR_SHORT_PDF',
            contentLength: extractedText?.text.length || 0
          });
        }
        continue;
      }

      if (debugState) {
        debugState.pdfsSuccessfullyExtracted.push(pdf.url);
      }
      
      // NEW: Include discovery path in provenance with actual PDF content
      const doc = buildDocumentProvenance({
        url: pdf.url,
        title: pdf.title,
        provider: 'ExchangeFilings',
        sourceType: DOCUMENT_TYPES.EXCHANGE_FILING,
        discoveredFrom: url,
        publishedAt: null,
        text: extractedText.text,
        pages: extractedText.pages,
        extractionStatus: 'SUCCESS',
        contentLength: extractedText.text.length,
        discoveryPath: pdf.discoveryPath,
        trustLevel: 'TRUSTED_EXCHANGE'
      });
      
      if (documentQualityGate(doc)) {
        documents.push(doc);
      } else if (debugState) {
        debugState.rejectedDocuments.push({ 
          url: doc.url, 
          reason: 'QUALITY_GATE_FAILED',
          contentLength: doc.contentLength,
          discoveryPath: pdf.discoveryPath
        });
      }
    }

    // If this is a secondary page and has content, add it as a document
    if (parentName !== url) {
      const pageDoc = buildDocumentProvenance({
        url,
        title: `${profile.companyName} Exchange Disclosures (${parentName})`,
        provider: 'ExchangeFilings',
        sourceType: DOCUMENT_TYPES.EXCHANGE_FILING,
        discoveredFrom: url,
        publishedAt: null,
        text,
        extractionStatus: 'SUCCESS',
        contentLength: text.length,
      });
      if (documentQualityGate(pageDoc)) {
        documents.push(pageDoc);
      } else if (debugState) {
        debugState.rejectedDocuments.push({ 
          url: pageDoc.url, 
          reason: 'QUALITY_GATE_FAILED',
          contentLength: pageDoc.contentLength
        });
      }
    }
  };

  for (const target of exchangeTargets) {
    // Process primary page
    await processExchangePage(target, target.url, target.name);

    // Look for and process secondary pages (filings, results, announcements)
    if (target.secondaryLinks && target.secondaryLinks.length > 0) {
      for (const secondaryUrl of target.secondaryLinks) {
        // Add slight delay to avoid overwhelming servers
        await new Promise(resolve => setTimeout(resolve, 500));
        await processExchangePage(target, secondaryUrl, target.name);
      }
    }
  }

  return documents;
};

export const collectTier3And4HistoricalSources = async (profile) => {
  const documents = [];
  const years = ['FY2021', 'FY2022', 'FY2023', 'FY2024', 'FY2025', 'FY2026', 'FY2027'];
  const aliases = profile.aliases || [profile.companyName];
  const preferredAlias = aliases[0] || profile.companyName;

  const yearSpecificQueries = [];
  for (const yr of years) {
    const yrShort = yr.replace('20', '');
    yearSpecificQueries.push({ query: `"${preferredAlias}" ${yrShort} guidance OR expects OR target`, year: yr, quarter: 'FULL_YEAR' });
    yearSpecificQueries.push({ query: `"${preferredAlias}" ${yrShort} "order book" OR "order intake" OR revenue`, year: yr, quarter: 'FULL_YEAR' });
    yearSpecificQueries.push({ query: `"${preferredAlias}" "investor presentation" ${yrShort} OR ${yr}`, year: yr, quarter: 'PRESENTATION' });
    yearSpecificQueries.push({ query: `"${preferredAlias}" "earnings call" ${yrShort} OR ${yr}`, year: yr, quarter: 'TRANSCRIPT' });
    yearSpecificQueries.push({ query: `"${preferredAlias}" "annual report" ${yrShort} OR ${yr}`, year: yr, quarter: 'ANNUAL_REPORT' });
  }

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

  const allSearchQueries = [...yearSpecificQueries.map((item) => item.query), ...coreMetricQueries];
  logger.info(`[DocumentResearch] Running ${allSearchQueries.length} multi-year historical queries for ${profile.symbol}`);

  try {
    const newsArticles = await getStockNews(profile.symbol, { days: 1825 });
    for (const article of newsArticles) {
      if (!article.url) continue;
      const titleAndBody = `${article.title} ${article.description || ''}`.toLowerCase();
      let docType = DOCUMENT_TYPES.NEWS_ARTICLE;
      let authority = SOURCE_AUTHORITY.EVENT_REGISTRY;

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

      let matchedFiscalYear = null;
      for (const yr of years) {
        const yrShort = yr.replace('20', '');
        if (titleAndBody.includes(yr.toLowerCase()) || titleAndBody.includes(yrShort.toLowerCase())) {
          matchedFiscalYear = yr;
          break;
        }
      }

      // Normalize to buildDocumentProvenance schema for consistency
      const normalizedDoc = buildDocumentProvenance({
        url: article.url,
        title: article.title,
        provider: article.source || 'Financial Media',
        sourceType: docType,
        discoveredFrom: article.url,
        publishedAt: article.publishedAt,
        text: `${article.title} ${article.description || ''}`,
        extractionStatus: 'SUCCESS',
        contentLength: (article.title + ' ' + (article.description || '')).length,
        trustLevel: 'TRUSTED_MEDIA'
      });
      
      // Add Tier 3/4 specific fields for compatibility
      normalizedDoc.sourceName = article.source || 'Financial Media';
      normalizedDoc.sourceUrl = article.url;
      normalizedDoc.documentType = docType;
      normalizedDoc.authorityLevel = authority;
      normalizedDoc.symbol = profile.symbol;
      normalizedDoc.companyName = profile.companyName;
      normalizedDoc.fiscalYear = matchedFiscalYear;

      if (!documentMatchesCompany(normalizedDoc, profile)) {
        logger.debug(`[DocumentResearch] Rejected article attributed to a different company for ${profile.symbol}: ${article.url}`);
        continue;
      }

      documents.push(normalizedDoc);
    }
  } catch (err) {
    logger.warn(`[DocumentResearch] News historical fetch error for ${profile.symbol}: ${err.message}`);
  }

  return documents;
};

export const collectDocuments = async (symbol, debugState = null) => {
  const normalized = String(symbol || '').toUpperCase().trim();
  const fallbackSector = SUPPORTED_STOCKS[normalized]?.sector || 'Unknown';
  const fallbackName = SUPPORTED_STOCKS[normalized]?.name || normalized;
  const profile = getCompanyResearchProfile(normalized, fallbackName, fallbackSector);

  if (!debugState) {
    debugState = {
      urlsAttempted: [],
      urlsSuccessfullyRetrieved: [],
      failedUrls: [],
      documentsDiscovered: [],
      linksDiscovered: 0,
      pdfsDiscovered: [],
      pdfsSuccessfullyExtracted: [],
      rejectedDocuments: [],
      countsByProvider: {},
      tlsFailures: [],
      tlsSummary: {
        totalTlsErrors: 0,
        uniqueUrlsWithTlsErrors: []
      }
    };
  }

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

  try {
    logger.info(`[DocumentResearch] Executing Tier 1 IR discovery for ${normalized}...`);
    const irDocs = await collectTier1InvestorRelations(profile, debugState);
    allDocuments.push(...irDocs);
    stats.officialDocuments += irDocs.length;
    stats.providers.push({ name: 'InvestorRelations', status: 'SUCCESS', documentsFound: irDocs.length });
    debugState.countsByProvider.InvestorRelations = irDocs.length;
    
    // Track TLS failures
    const tlsFailuresThisTier = debugState.failedUrls.filter(f => f.severity === 'TLS_FAILURE' && f.provider !== 'ExchangeFilings' && f.provider !== 'FinancialMediaAndHistoricalNews');
    if (tlsFailuresThisTier.length > 0) {
      debugState.tlsSummary.totalTlsErrors += tlsFailuresThisTier.length;
      for (const failure of tlsFailuresThisTier) {
        if (!debugState.tlsSummary.uniqueUrlsWithTlsErrors.includes(failure.url)) {
          debugState.tlsSummary.uniqueUrlsWithTlsErrors.push(failure.url);
        }
      }
    }
  } catch (err) {
    logger.error(`[DocumentResearch] Tier 1 failed for ${normalized}: ${err.message}`);
    stats.providers.push({ name: 'InvestorRelations', status: 'FAILED', documentsFound: 0, error: err.message });
    debugState.countsByProvider.InvestorRelations = 0;
  }

  try {
    logger.info(`[DocumentResearch] Executing Tier 2 Exchange Filings discovery for ${normalized}...`);
    const exchangeDocs = await collectTier2ExchangeFilings(profile, debugState);
    allDocuments.push(...exchangeDocs);
    stats.exchangeDocuments += exchangeDocs.length;
    stats.providers.push({ name: 'ExchangeFilings', status: 'SUCCESS', documentsFound: exchangeDocs.length });
    debugState.countsByProvider.ExchangeFilings = exchangeDocs.length;
  } catch (err) {
    logger.error(`[DocumentResearch] Tier 2 failed for ${normalized}: ${err.message}`);
    stats.providers.push({ name: 'ExchangeFilings', status: 'FAILED', documentsFound: 0, error: err.message });
    debugState.countsByProvider.ExchangeFilings = 0;
  }

  try {
    logger.info(`[DocumentResearch] Executing Tier 3 & 4 Individual Year Historical Search for ${normalized}...`);
    const newsDocs = await collectTier3And4HistoricalSources(profile);
    allDocuments.push(...newsDocs);
    stats.newsDocuments += newsDocs.length;
    stats.providers.push({ name: 'FinancialMediaAndHistoricalNews', status: 'SUCCESS', documentsFound: newsDocs.length });
    debugState.countsByProvider.FinancialMediaAndHistoricalNews = newsDocs.length;
  } catch (err) {
    logger.error(`[DocumentResearch] Tier 3/4 failed for ${normalized}: ${err.message}`);
    stats.providers.push({ name: 'FinancialMediaAndHistoricalNews', status: 'FAILED', documentsFound: 0, error: err.message });
    debugState.countsByProvider.FinancialMediaAndHistoricalNews = 0;
  }

  // Phase 7B: Enhanced quality statistics
  const documentsBeforeQualityGate = allDocuments.filter((doc) => doc.url || doc.canonicalUrl || doc.sourceUrl);
  const documentsAfterQualityGate = documentsBeforeQualityGate.filter((doc) => documentQualityGate(doc));
  const uniqueDocuments = [...new Map(documentsAfterQualityGate.map((doc) => [(doc.canonicalUrl || doc.url || doc.sourceUrl), doc])).values()];
  
  stats.documentsFound = uniqueDocuments.length;
  stats.pdfDocuments = uniqueDocuments.filter((doc) => /\.pdf(?:$|[?#])/i.test(doc.url || doc.sourceUrl || '')).length;

  debugState.documentsDiscovered = deduplicateUrls(uniqueDocuments.map((doc) => doc.url || doc.canonicalUrl || doc.sourceUrl || ''));
  if (!debugState.pdfsDiscovered.length) {
    debugState.pdfsDiscovered = uniqueDocuments.filter((doc) => /\.pdf(?:$|[?#])/i.test(doc.url || doc.sourceUrl || '')).map((doc) => doc.url || doc.sourceUrl);
  }

  // Phase 7B: Detailed rejection analysis
  const rejectionReasons = {};
  for (const rejected of debugState.rejectedDocuments || []) {
    const reason = rejected.reason || 'UNKNOWN';
    rejectionReasons[reason] = (rejectionReasons[reason] || 0) + 1;
  }

  // Add detailed stats to debug state
  debugState.stats = {
    totalUrlsAttempted: debugState.urlsAttempted.length,
    totalUrlsRetrieved: debugState.urlsSuccessfullyRetrieved.length,
    totalFailedUrls: debugState.failedUrls.length,
    totalLinksDiscovered: debugState.linksDiscovered,
    totalPdfsDiscovered: debugState.pdfsDiscovered.length,
    totalPdfsExtracted: debugState.pdfsSuccessfullyExtracted.length,
    totalRejectedDocuments: debugState.rejectedDocuments.length,
    tlsFailureCount: debugState.tlsSummary.totalTlsErrors,
    uniqueTlsFailureUrls: debugState.tlsSummary.uniqueUrlsWithTlsErrors.length,
    // Phase 7B: Quality gate statistics
    documentsBeforeQualityGate: documentsBeforeQualityGate.length,
    documentsAfterQualityGate: documentsAfterQualityGate.length,
    documentsRejectedByQualityGate: documentsBeforeQualityGate.length - documentsAfterQualityGate.length,
    rejectionReasons
  };

  logger.info(`[DocumentResearch] Multi-tier collection complete for ${normalized}: ${stats.documentsFound} unique documents collected across ${stats.providers.length} provider tiers.`, {
    stats: debugState.stats,
    providers: debugState.countsByProvider
  });

  // Phase 7B: Pipeline quality summary
  logger.info(`[DOCUMENT_PIPELINE_SUMMARY] ${normalized}`, {
    documentsDiscovered: documentsBeforeQualityGate.length,
    documentsFetched: debugState.urlsSuccessfullyRetrieved.length,
    documentsRejectedBeforeExtraction: debugState.rejectedDocuments.length,
    documentsWithValidSourceUrls: documentsBeforeQualityGate.filter(d => d.url || d.sourceUrl).length,
    documentsWithMeaningfulText: documentsBeforeQualityGate.filter(d => (d.text || '').length >= 80).length,
    documentsRejectedAsGenericPages: rejectionReasons['GENERIC_LANDING_PAGE'] || 0,
    documentsRejectedAsPlaceholders: rejectionReasons['PLACEHOLDER_DOCUMENT'] || 0,
    documentsPassingQualityGate: documentsAfterQualityGate.length,
    documentsSentToResearch: uniqueDocuments.length,
    rejectionBreakdown: rejectionReasons
  });

  return {
    documents: uniqueDocuments,
    stats,
    symbol: normalized,
    companyName: profile.companyName,
    profile,
    debug: debugState
  };
};

export default {
  collectDocuments,
  collectTier1InvestorRelations,
  collectTier2ExchangeFilings,
  collectTier3And4HistoricalSources,
  SOURCE_AUTHORITY,
  DOCUMENT_TYPES,
  normalizeDocumentUrl,
  deduplicateUrls,
  discoverPdfLinks,
  discoverPdfsFromLandingPage,
  documentQualityGate,
  documentMatchesCompany,
  buildDocumentProvenance,
  classifyFetchFailure,
  fetchHtml,
  fetchPdf,
  isPdfBuffer,
  extractText,
  extractDocumentLinks,
};
