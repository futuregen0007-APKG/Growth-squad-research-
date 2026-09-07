import axios from 'axios';
import dotenv from 'dotenv';
import { SUPPORTED_STOCKS } from '../utils/constants.js';
import { logger } from '../utils/logger.js';

dotenv.config();

const NEWS_API_URL = 'https://eventregistry.org/api/v1/article/getArticles';
const CACHE_TTL_MS = 10 * 60 * 1000; // documented short TTL — real articles go stale fast
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

const stopWords = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'after', 'from', 'with', 'is', 'are', 'as', 'at', 'by']);
const asDate = (value) => new Date(value || 0).getTime() || 0;
const words = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9$ ]/g, ' ').split(/\s+/).filter((word) => word && !stopWords.has(word));
const tokenSet = (value) => new Set(words(value));

const validUrl = (value) => {
  try {
    const url = new URL(String(value || '').trim());
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
};

// A date is "valid where supplied": absent is fine (sorts last), but a
// value that doesn't parse to a real instant means the article is rejected
// rather than shown with a garbled or misleading timestamp.
const parsePublishedAt = (rawValue) => {
  if (rawValue == null || rawValue === '') return { present: false, iso: null };
  const time = new Date(rawValue).getTime();
  if (!Number.isFinite(time)) return { present: true, iso: undefined }; // undefined = invalid
  return { present: true, iso: new Date(time).toISOString() };
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

// Title near-duplicate dedup (same story, different outlets/URLs).
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

// Newest-first, with articles missing a publish date sorted to the end
// (never guessed at, never treated as "now").
export const sortNewestFirst = (articles) => [...articles].sort((a, b) => {
  const aTime = a.publishedAt ? asDate(a.publishedAt) : -Infinity;
  const bTime = b.publishedAt ? asDate(b.publishedAt) : -Infinity;
  return bTime - aTime;
});

// Real-articles-only normalization. Returns null (rejects the article)
// rather than substituting a placeholder for any required field — a
// fabricated title/date is exactly the kind of "fallback fact" this
// service must never produce.
const normalize = (article, symbol) => {
  const url = validUrl(article.url);
  if (!url) return null;

  const title = String(article.title || '').trim();
  if (!title) return null;

  const { iso: publishedAt } = parsePublishedAt(article.dateTimePub || article.dateTime || article.publishedAt);
  if (publishedAt === undefined) return null; // a date was supplied but didn't parse

  const imageUrl = validUrl(article.image);

  return {
    title,
    description: article.body || article.description || '',
    url,
    imageUrl: imageUrl || null,
    source: article.source?.title || article.source?.uri || 'Unknown source',
    publishedAt: publishedAt || null,
    symbols: [symbol],
    fetchedAt: new Date().toISOString(),
  };
};

// Pure response-processing step, split out from the network call so it can
// be unit-tested with fixture payloads instead of a live/mocked HTTP call.
// Throws NewsAPIError for an Event-Registry quota/error payload (even
// though the HTTP status was 200) rather than ever treating it as "zero
// articles found".
export function processArticlesResponse(responseData, { symbol, companyName }) {
  if (typeof responseData?.error === 'string' && responseData.error.trim()) {
    throw new NewsAPIError(`News provider quota/error: ${responseData.error}`, 429);
  }

  const results = responseData?.articles?.results || [];
  const normalized = results
    .map((article) => ({ article, score: relevanceScore(article, companyName) }))
    .filter(({ score }) => score >= 2)
    .map(({ article }) => normalize(article, symbol))
    .filter(Boolean);

  return sortNewestFirst(deduplicate(normalized));
}

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

    // processArticlesResponse throws for an Event Registry quota/error
    // payload (even on HTTP 200) — caught below and never cached.
    const normalized = processArticlesResponse(response.data, { symbol: normalizedSymbol, companyName }).slice(0, 8);

    cache.set(cacheKey, { data: normalized, fetchedAt: Date.now() });
    return normalized;
  } catch (error) {
    const normalizedError = error instanceof NewsAPIError ? error : newsApiError(error);
    logger.warn(`[NewsAPI] ${normalizedSymbol}: ${normalizedError.message}`);
    // Never cache an error/quota response as if it were a valid empty result.
    throw normalizedError;
  }
}

export function clearNewsCache() {
  cache.clear();
}
