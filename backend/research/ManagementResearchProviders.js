import axios from 'axios';
import { getStockNews } from '../services/NewsAPIService.js';
import { SUPPORTED_STOCKS } from '../utils/constants.js';
import { logger } from '../utils/logger.js';

const unavailable = (provider, reason) => ({ provider, documents: [], available: false, reason });

// Helper to fetch and parse HTML content
const fetchHtml = async (url, timeout = 10000) => {
  try {
    const response = await axios.get(url, {
      timeout,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });
    return response.data;
  } catch (error) {
    logger.warn(`Failed to fetch ${url}: ${error.message}`);
    return null;
  }
};

// Extract text from HTML
const extractText = (html, maxLength = 5000) => {
  if (!html) return '';
  // Remove script and style tags
  let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                 .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                 .replace(/<[^>]+>/g, ' ');
  // Normalize whitespace
  text = text.replace(/\s+/g, ' ').trim();
  return text.substring(0, maxLength);
};

export class ResearchProvider {
  constructor(name) { this.name = name; }
  async collect() { return unavailable(this.name, 'Provider not configured.'); }
}

// Tier 1: Investor Relations Provider
export class InvestorRelationsProvider extends ResearchProvider {
  constructor() { super('Investor Relations'); }

  async collect(symbol) {
    const companyName = SUPPORTED_STOCKS[symbol]?.name || symbol;
    const documents = [];

    // Common investor relations URL patterns for Indian companies
    const irUrls = [
      `https://www.${companyName.toLowerCase().replace(/\s+/g, '')}.com/investors`,
      `https://investor.${companyName.toLowerCase().replace(/\s+/g, '')}.com`,
      `https://www.${symbol.toLowerCase()}.com/investors`,
    ];

    // Try to fetch investor relations pages
    for (const url of irUrls) {
      try {
        const html = await fetchHtml(url);
        if (html) {
          const text = extractText(html);
          // Look for promise-related keywords
          const promiseKeywords = ['guidance', 'target', 'expect', 'forecast', 'outlook', 'projection', 'guidance for', 'we expect', 'we target'];
          if (promiseKeywords.some(keyword => text.toLowerCase().includes(keyword))) {
            documents.push({
              title: `${companyName} Investor Relations`,
              excerpt: text.substring(0, 500),
              url,
              date: new Date().toISOString(),
              type: 'INVESTOR_RELATIONS',
              source: 'Company Website'
            });
          }
        }
      } catch (error) {
        // Continue to next URL
      }
    }

    return { provider: this.name, documents, available: documents.length > 0, reason: documents.length === 0 ? 'No investor relations content found' : null };
  }
}

// Tier 2: Exchange Filings Provider (NSE/BSE)
export class ExchangeFilingsProvider extends ResearchProvider {
  constructor() { super('NSE/BSE Filings'); }

  async collect(symbol) {
    const documents = [];

    // NSE filing URL pattern
    const nseUrl = `https://www.nseindia.com/get-quotes/equity?symbol=${symbol}`;
    
    try {
      const html = await fetchHtml(nseUrl);
      if (html) {
        const text = extractText(html);
        documents.push({
          title: `${symbol} NSE Filings`,
          excerpt: text.substring(0, 500),
          url: nseUrl,
          date: new Date().toISOString(),
          type: 'EXCHANGE_FILING',
          source: 'NSE'
        });
      }
    } catch (error) {
      logger.warn(`NSE filings fetch failed for ${symbol}: ${error.message}`);
    }

    return { provider: this.name, documents, available: documents.length > 0, reason: documents.length === 0 ? 'No exchange filings found' : null };
  }
}

// Tier 1: Financial Reports Provider
export class FinancialReportsProvider extends ResearchProvider {
  constructor() { super('Financial Reports'); }

  async collect(symbol) {
    const companyName = SUPPORTED_STOCKS[symbol]?.name || symbol;
    const documents = [];

    // Search for annual reports and quarterly results
    const searchQueries = [
      `${companyName} annual report 2024`,
      `${companyName} quarterly results`,
      `${symbol} earnings report`,
      `${companyName} investor presentation`
    ];

    // For now, this is a placeholder. In production, this would:
    // 1. Search company website for annual reports
    // 2. Parse PDF reports
    // 3. Extract management commentary
    // 4. Look for guidance statements

    return { provider: this.name, documents, available: false, reason: 'Financial reports provider requires PDF parsing and company website crawling - not yet implemented' };
  }
}

// Tier 3: Enhanced News Provider with promise-specific search
export class NewsProvider extends ResearchProvider {
  constructor() { super('Event Registry News'); }

  async collect(symbol) {
    const companyName = SUPPORTED_STOCKS[symbol]?.name || symbol;
    
    // Promise-specific search queries
    const promiseQueries = [
      `"${companyName}" management guidance`,
      `"${companyName}" expects`,
      `"${companyName}" targets`,
      `"${companyName}" outlook`,
      `"${companyName}" forecast`,
      `"${companyName}" revenue guidance`,
      `"${companyName}" margin guidance`,
      `"${companyName}" order book`,
      `"${companyName}" capex`,
    ];

    const documents = [];
    
    // Collect news for each query
    for (const query of promiseQueries) {
      try {
        // Use extended time range to capture historical guidance
        const newsArticles = await getStockNews(symbol, { days: 1825 }); // 5 years
        documents.push(...newsArticles.map(article => ({
          title: article.title,
          excerpt: article.description,
          url: article.url,
          date: article.publishedAt,
          type: 'NEWS',
          source: article.source,
          query
        })));
      } catch (error) {
        logger.warn(`News search failed for query "${query}": ${error.message}`);
      }
    }

    // Deduplicate by URL
    const unique = [...new Map(documents.filter(doc => doc.url).map(doc => [doc.url, doc])).values()];

    return { provider: this.name, documents: unique, available: unique.length > 0, reason: unique.length === 0 ? 'No news articles found' : null };
  }
}

export const collectResearchSources = async (symbol) => {
  const providers = [
    new NewsProvider(), // Tier 3 - most likely to have content
    new InvestorRelationsProvider(), // Tier 1
    new ExchangeFilingsProvider(), // Tier 2
    new FinancialReportsProvider(), // Tier 1 - not fully implemented
  ];

  const results = await Promise.all(providers.map(async (provider) => {
    try {
      logger.info(`[Research] Collecting sources from ${provider.name} for ${symbol}`);
      return await provider.collect(symbol);
    } catch (error) {
      logger.error(`[Research] ${provider.name} failed for ${symbol}: ${error.message}`);
      return unavailable(provider.name, error.message);
    }
  }));

  const documents = results.flatMap((result) => result.documents);
  const unique = [...new Map(documents.filter((document) => document.url).map((document) => [document.url, document])).values()];

  logger.info(`[Research] Collected ${unique.length} unique documents for ${symbol} from ${results.filter(r => r.available).length} providers`);

  return { 
    documents: unique, 
    providers: results.map(({ provider, available, reason }) => ({ provider, available, reason })), 
    sourcesFound: unique.length 
  };
};
