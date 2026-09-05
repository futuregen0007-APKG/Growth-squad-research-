import axios from 'axios';
import dotenv from 'dotenv';
import { SUPPORTED_STOCKS } from '../utils/constants.js';
import { logger } from '../utils/logger.js';

dotenv.config();

const NEWS_API_URL = 'https://eventregistry.org/api/v1/article/getArticles';
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map();

export class NewsAPIError extends Error {
  constructor(message, statusCode = 503) {
    super(message);
    this.name = 'NewsAPIError';
    this.statusCode = statusCode;
  }
}

export const STOCK_NEWS_QUERY_MAP = {
  HDFCBANK: '"HDFC Bank"',
  ICICIBANK: '"ICICI Bank"',
  SBIN: '"State Bank of India"',
  AXISBANK: '"Axis Bank"',
  KOTAKBANK: '"Kotak Mahindra Bank"',
  RELIANCE: '"Reliance Industries"',
  TCS: '"Tata Consultancy Services"',
  INFY: '"Infosys"',
  ITC: '"ITC Limited" OR "ITC Hotels"',
  SUNPHARMA: '"Sun Pharma"',
};

const COMPANY_FALLBACK_IMAGES = {
  HDFCBANK: 'https://images.unsplash.com/photo-1556761175-b413da4baf72?auto=format&fit=crop&w=900&q=80',
  ICICIBANK: 'https://images.unsplash.com/photo-1551836022-d5d88e9218df?auto=format&fit=crop&w=900&q=80',
  SBIN: 'https://images.unsplash.com/photo-1556742049-0cfed4f6a45d?auto=format&fit=crop&w=900&q=80',
  AXISBANK: 'https://images.unsplash.com/photo-1554224155-6726b3ff858f?auto=format&fit=crop&w=900&q=80',
  KOTAKBANK: 'https://images.unsplash.com/photo-1444653614773-995cb1ef9efa?auto=format&fit=crop&w=900&q=80',
  RELIANCE: 'https://images.unsplash.com/photo-1565610222536-ef125c59da2e?auto=format&fit=crop&w=900&q=80',
  TCS: 'https://images.unsplash.com/photo-1519389950473-47ba0277781c?auto=format&fit=crop&w=900&q=80',
  INFY: 'https://images.unsplash.com/photo-1552664730-d307ca884978?auto=format&fit=crop&w=900&q=80',
  ITC: 'https://images.unsplash.com/photo-1556740749-887f6717d7e4?auto=format&fit=crop&w=900&q=80',
  SUNPHARMA: 'https://images.unsplash.com/photo-1584308666744-24d5c474f2ae?auto=format&fit=crop&w=900&q=80',
  default: 'https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?auto=format&fit=crop&w=900&q=80',
};

const stopWords = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'after', 'from', 'with', 'is', 'are', 'as', 'at', 'by']);
const asDate = (value) => new Date(value || 0).getTime() || 0;
const words = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9$ ]/g, ' ').split(/\s+/).filter((word) => word && !stopWords.has(word));
const tokenSet = (value) => new Set(words(value));
const fallbackImage = (symbol) => COMPANY_FALLBACK_IMAGES[symbol] || COMPANY_FALLBACK_IMAGES.default;

const validUrl = (value) => {
  try {
    const url = new URL(String(value || '').trim());
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
};

const companyNameFor = (symbol) => SUPPORTED_STOCKS[symbol]?.name || symbol;
const queryFor = (symbol) => STOCK_NEWS_QUERY_MAP[symbol] || `"${companyNameFor(symbol)}"`;

const relevanceScore = (article, companyName) => {
  const title = String(article.title || '').toLowerCase();
  const body = `${article.description || ''} ${article.content || ''}`.toLowerCase();
  const aliases = [companyName.toLowerCase(), companyName.toLowerCase().replace(/\s+(limited|ltd\.?|corporation|corp\.?)$/, '')];
  if (aliases.some((alias) => title.includes(alias))) return 3;
  if (aliases.some((alias) => body.includes(alias))) return 2;
  return 0;
};

const similarEnough = (left, right) => {
  const a = tokenSet(left);
  const b = tokenSet(right);
  const overlap = [...a].filter((word) => b.has(word)).length / Math.max(a.size, b.size, 1);
  const moneyA = String(left).match(/(?:\$|usd\s*)[\d.,]+\s*(?:billion|million|bn|mn)?/i)?.[0]?.replace(/\s/g, '').toLowerCase();
  const moneyB = String(right).match(/(?:\$|usd\s*)[\d.,]+\s*(?:billion|million|bn|mn)?/i)?.[0]?.replace(/\s/g, '').toLowerCase();
  return overlap >= 0.72 || (moneyA && moneyA === moneyB && overlap >= 0.35);
};

export const deduplicate = (articles) => {
  const result = [];
  for (const article of articles) {
    if (!result.some((existing) => similarEnough(existing.title, article.title))) result.push(article);
  }
  return result;
};

// Canonical-URL dedup for merging results across multiple symbol queries
// (a single article can legitimately match more than one company's query).
// Strips query string/fragment/trailing slash and lowercases so the same
// article reached via different tracking params still collapses to one.
export const canonicalizeArticleUrl = (url) => {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '').toLowerCase();
  } catch {
    return String(url || '').trim().toLowerCase();
  }
};

const normalize = (article, symbol, companyName, sector) => {
  const url = validUrl(article.url);
  if (!url) return null;
  const imageUrl = validUrl(article.image);
  return {
    title: article.title || 'Untitled article',
    description: article.body || article.description || '',
    source: article.source?.title || article.source?.uri || 'Unknown source',
    publishedAt: article.dateTimePub || article.dateTime || article.publishedAt || null,
    url,
    imageUrl: imageUrl || fallbackImage(symbol),
    imageSource: imageUrl ? 'newsapi-ai' : 'company-fallback',
    symbol,
    companyName,
    category: sector || 'Company',
  };
};

const newsApiError = (error) => {
  const status = error.response?.status;
  if (status === 401 || status === 403) return new NewsAPIError('News service authentication failed.', status);
  if (status === 429) return new NewsAPIError('News service rate limit reached.', status);
  if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') return new NewsAPIError('Unable to load latest news.', 504);
  return new NewsAPIError('Unable to load latest news.', 502);
};

export async function getStockNews(symbol, { days = 3 } = {}) {
  const normalizedSymbol = String(symbol || '').trim().toUpperCase();
  const apiKey = process.env.NEWS_API_KEY;
  if (!apiKey) {
    logger.warn('NEWS_API_KEY is not configured.');
    return [];
  }

  const cacheKey = `${normalizedSymbol}:${days}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.data;

  const companyName = companyNameFor(normalizedSymbol);
  const sector = SUPPORTED_STOCKS[normalizedSymbol]?.sector;
  const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  try {
    const response = await axios.get(NEWS_API_URL, {
      params: {
        keyword: queryFor(normalizedSymbol),
        keywordLoc: 'body',
        dateStart: from.slice(0, 10),
        articlesPage: 1,
        articlesCount: 50,
        articlesSortBy: 'date',
        articlesSortByAsc: false,
        resultType: 'articles',
        apiKey,
      },
      timeout: 12000,
    });

    // Event Registry can return HTTP 200 with a top-level {"error": "..."}
    // body when the daily token quota is exhausted or the request is
    // otherwise rejected — this must be classified as a provider failure,
    // never treated as "zero articles found" (which would then get cached
    // as if it were a real, valid empty result).
    if (typeof response.data?.error === 'string' && response.data.error.trim()) {
      throw new NewsAPIError(`News provider quota/error: ${response.data.error}`, 429);
    }

    const normalized = deduplicate(response.data?.articles?.results
      ?.map((article) => ({ article, score: relevanceScore(article, companyName) }))
      .filter(({ score }) => score >= 2)
      .sort((a, b) => asDate(b.article.publishedAt) - asDate(a.article.publishedAt))
      .map(({ article }) => normalize(article, normalizedSymbol, companyName, sector))
      .filter(Boolean) || []).slice(0, 8);

    cache.set(cacheKey, { data: normalized, fetchedAt: Date.now() });
    return normalized;
  } catch (error) {
    const normalizedError = error instanceof NewsAPIError ? error : newsApiError(error);
    logger.warn(`[NewsAPI] ${normalizedSymbol}: ${normalizedError.message}`);
    throw normalizedError;
  }
}

export function clearNewsCache() {
  cache.clear();
}
