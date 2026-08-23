import axios from 'axios';
import dotenv from 'dotenv';
import { openai } from './openaiClient.js';
import redisClient from '../utils/redisClient.js';
import { getStockNews } from './NewsAPIService.js';

dotenv.config();

const ALPHA_KEY = process.env.ALPHA_VANTAGE_API_KEY;

const alphaUrl = 'https://www.alphavantage.co/query';

async function fetchAlphaOverview(symbol) {
  try {
    const cacheKey = `alpha:overview:${symbol}`;
    const cached = await redisClient.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const res = await axios.get(alphaUrl, {
      params: { function: 'OVERVIEW', symbol, apikey: ALPHA_KEY },
      timeout: 15000,
    });
    await redisClient.setEx(cacheKey, 3600, JSON.stringify(res.data));
    return res.data;
  } catch (err) {
    return null;
  }
}

async function fetchAlphaDaily(symbol) {
  try {
    const cacheKey = `alpha:daily:${symbol}`;
    const cached = await redisClient.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const res = await axios.get(alphaUrl, {
      params: { function: 'TIME_SERIES_DAILY_ADJUSTED', symbol, apikey: ALPHA_KEY, outputsize: 'compact' },
      timeout: 20000,
    });
    await redisClient.setEx(cacheKey, 300, JSON.stringify(res.data));
    return res.data;
  } catch (err) {
    return null;
  }
}

function extractRuleBasedSentiment(articles = []) {
  if (!articles.length) return { sentimentScore: 0, sentimentConfidence: 0.5, sentimentDrivers: [] };
  
  const positiveWords = ['growth', 'profit', 'surges', 'jump', 'beats', 'upgrade', 'order', 'record', 'gain', 'expands', 'bullish', 'dividend', 'deal'];
  const negativeWords = ['loss', 'drop', 'slump', 'falls', 'probe', 'fraud', 'downgrade', 'penalty', 'miss', 'debt', 'bearish', 'cut', 'resigns', 'litigation'];
  
  let score = 0;
  const drivers = [];
  
  articles.forEach((a) => {
    const text = `${a.title || ''} ${a.description || ''}`.toLowerCase();
    positiveWords.forEach((word) => {
      if (text.includes(word)) {
        score += 0.2;
        if (drivers.length < 3 && a.title) drivers.push(a.title);
      }
    });
    negativeWords.forEach((word) => {
      if (text.includes(word)) {
        score -= 0.35;
        if (drivers.length < 3 && a.title) drivers.push(a.title);
      }
    });
  });

  const clampedScore = Math.max(-1, Math.min(1, Number(score.toFixed(2))));
  return {
    sentimentScore: clampedScore,
    sentimentConfidence: 0.65,
    sentimentDrivers: [...new Set(drivers)].slice(0, 3),
  };
}

async function summarizeArticles(openAiClient, articles = [], symbol) {
  const fallback = extractRuleBasedSentiment(articles);
  if (!openAiClient) {
    return {
      history: '',
      present: '',
      future: '',
      sentimentScore: fallback.sentimentScore,
      sentimentConfidence: fallback.sentimentConfidence,
      sentimentDrivers: fallback.sentimentDrivers,
      articles: articles.slice(0, 6),
    };
  }

  const sources = articles.slice(0, 6).map((a) => `${a.source?.name || a.source}: ${a.title} - ${a.url}`);
  const prompt = `You are a cautious equity research assistant. Use only the supplied articles for ${symbol}; do not invent facts, numbers, guidance, or events. Return valid JSON only with this exact shape: {"history":"...","present":"...","future":"...","sentimentScore":0.0,"sentimentConfidence":0.8,"sentimentDrivers":["driver 1","driver 2"]}.
Rules:
- History must discuss only historical events explicitly supported by the sources (<80 words).
- Present must discuss only current events explicitly supported by the sources (<80 words).
- Future must contain evidence-backed implications or state that sources do not support a forward-looking conclusion (<80 words).
- sentimentScore must be a float between -1.0 (strongly negative/regulatory/scandal) and +1.0 (strongly positive/earnings beat/expansion). Neutral is 0.0.
- sentimentConfidence must be a float between 0.1 and 1.0 based on data quality.
- sentimentDrivers must be an array of up to 3 short factual catalyst phrases from the articles.
Sources:\n${sources.join('\n')}`;

  try {
    const resp = await openAiClient.responses.create({
      model: 'gpt-4o-mini',
      input: prompt,
      max_output_tokens: 750,
    });
    const text = (resp.output_text || resp.output?.[0]?.content?.[0]?.text) || '';
    const parsed = JSON.parse(text.replace(/^```json\s*|\s*```$/g, '').trim());
    
    const parsedScore = Number(parsed.sentimentScore);
    const sentimentScore = Number.isFinite(parsedScore) ? Math.max(-1, Math.min(1, parsedScore)) : fallback.sentimentScore;
    const parsedConfidence = Number(parsed.sentimentConfidence);
    const sentimentConfidence = Number.isFinite(parsedConfidence) ? Math.max(0.1, Math.min(1, parsedConfidence)) : fallback.sentimentConfidence;
    const sentimentDrivers = Array.isArray(parsed.sentimentDrivers) && parsed.sentimentDrivers.length ? parsed.sentimentDrivers : fallback.sentimentDrivers;

    return {
      history: typeof parsed.history === 'string' ? parsed.history : '',
      present: typeof parsed.present === 'string' ? parsed.present : '',
      future: typeof parsed.future === 'string' ? parsed.future : '',
      sentimentScore: Number(sentimentScore.toFixed(2)),
      sentimentConfidence: Number(sentimentConfidence.toFixed(2)),
      sentimentDrivers,
      articles: articles.slice(0, 6),
    };
  } catch (err) {
    return {
      history: '',
      present: '',
      future: '',
      sentimentScore: fallback.sentimentScore,
      sentimentConfidence: fallback.sentimentConfidence,
      sentimentDrivers: fallback.sentimentDrivers,
      articles: articles.slice(0, 6),
    };
  }
}

const ResearchService = {
  getStockNews,
  async enrichSymbols(symbols = []) {
    const results = [];
    for (const s of symbols) {
      const symbol = s.toUpperCase();
      const overview = await fetchAlphaOverview(symbol);
      const daily = await fetchAlphaDaily(symbol);
      const news = await getStockNews(symbol);
      const summary = await summarizeArticles(openai, news, symbol);

      results.push({
        ticker: symbol,
        overview,
        daily,
        news: summary.articles,
        historySummary: summary.history,
        presentSummary: summary.present,
        futureSummary: summary.future,
        sentimentScore: summary.sentimentScore,
        sentimentConfidence: summary.sentimentConfidence,
        sentimentDrivers: summary.sentimentDrivers,
      });
    }
    return results;
  },
};

export default ResearchService;
