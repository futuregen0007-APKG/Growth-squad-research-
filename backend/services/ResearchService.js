import axios from 'axios';
import dotenv from 'dotenv';
import { openai } from './openaiClient.js';
import redisClient from '../utils/redisClient.js';

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

async function fetchNewsForCompany(query) {
  // As NewsAPI key isn't provided, use a simple Google News RSS via gnews.io as fallback
  try {
    const url = `https://gnews.io/api/v4/search?q=${encodeURIComponent(query)}&lang=en&max=8&token=`; // no key
    const res = await axios.get(url, { timeout: 10000 });
    return res.data.articles || [];
  } catch (err) {
    return [];
  }
}

async function summarizeArticles(openAiClient, articles = [], symbol) {
  if (!openAiClient) return { history: '', present: '', future: '', articles: [] };

  const sources = articles.slice(0, 6).map((a) => `${a.source?.name || a.source}: ${a.title} - ${a.url}`);
  const prompt = `You are a concise equity research assistant. For ${symbol}, read the following article headlines and URLs:\n${sources.join('\n')}\n\nProduce 3 short sections (max 120 words each) titled:\n- History: key background and past performance summary\n- Present: current market/operational status and recent catalysts\n- Future Plans: management guidance, catalysts, risks, and what to watch.\nAlso return a short list of the article URLs as citations.`;

  try {
    const resp = await openAiClient.responses.create({
      model: 'gpt-4o-mini',
      input: prompt,
      max_output_tokens: 600,
    });
    const text = (resp.output_text || resp.output?.[0]?.content?.[0]?.text) || JSON.stringify(resp);
    return { history: text, present: text, future: text, articles: articles.slice(0, 6) };
  } catch (err) {
    return { history: '', present: '', future: '', articles: articles.slice(0, 6) };
  }
}

const ResearchService = {
  async enrichSymbols(symbols = []) {
    const results = [];
    for (const s of symbols) {
      const symbol = s.toUpperCase();
      const overview = await fetchAlphaOverview(symbol);
      const daily = await fetchAlphaDaily(symbol);
      const news = await fetchNewsForCompany(symbol);
      const summary = await summarizeArticles(openai, news, symbol);

      results.push({
        ticker: symbol,
        overview,
        daily,
        news: summary.articles,
        historySummary: summary.history,
        presentSummary: summary.present,
        futureSummary: summary.future,
      });
    }
    return results;
  },
};

export default ResearchService;
