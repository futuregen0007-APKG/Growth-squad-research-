import { getCache, setCache } from '../utils/redisClient.js';
import { SUPPORTED_STOCKS } from '../utils/constants.js';
import { logger } from '../utils/logger.js';
import { getFundamentals } from './StockFundamentalsService.js';
import { classifyMarketCapSegments } from './MarketCapSegmentationService.js';
import { CompanyResearchProfile } from '../models/CompanyResearchProfile.js';

const UNIVERSE_CACHE_KEY = 'universe:eligible_stocks';
const UNIVERSE_TTL = 86400; // 24 hours

export class DynamicUniverseService {
  constructor(stockService, { getFundamentalsFn = getFundamentals } = {}) {
    this.stockService = stockService;
    this.getFundamentalsFn = getFundamentalsFn;
  }

  parseMarketCapToCr(mcapStr) {
    if (!mcapStr) return 0;
    if (typeof mcapStr === 'number') return mcapStr;
    const clean = String(mcapStr).toUpperCase().replace(/[^0-9.LKCRORES]/g, '');
    const num = parseFloat(clean);
    if (isNaN(num)) return 0;

    if (mcapStr.includes('L Cr') || mcapStr.includes('LCR')) return num * 100000;
    if (mcapStr.includes('K Cr') || mcapStr.includes('KCR')) return num * 1000;
    if (mcapStr.includes('Cr') || mcapStr.includes('CR')) return num;
    return num;
  }

  async getEligibleUniverse(options = {}) {
    const { minMarketCapCr = 1000, minVolume = 10000, forceRefresh = false } = options;

    if (!forceRefresh) {
      const cached = await getCache(UNIVERSE_CACHE_KEY);
      if (cached && Array.isArray(cached) && cached.length > 0) {
        return cached;
      }
    }

    logger.info('DynamicUniverseService: Screening market universe for eligible stocks...');

    let allStockData = [];
    try {
      if (this.stockService && typeof this.stockService.getAllStocks === 'function') {
        allStockData = await this.stockService.getAllStocks();
      }
    } catch (err) {
      logger.warn(`DynamicUniverseService: Failed to fetch from stockService: ${err.message}`);
    }

    if (!allStockData || allStockData.length === 0) {
      allStockData = Object.entries(SUPPORTED_STOCKS).map(([ticker, meta]) => ({
        ticker,
        symbol: ticker,
        name: meta.name || ticker,
        sector: meta.sector || 'General',
        currency: meta.currency || 'INR',
      }));
    }

    // Filter by Market Cap >= minMarketCapCr (e.g. ₹1,000 Cr) and liquidity
    const eligible = allStockData.filter((stock) => {
      const ticker = stock.ticker || stock.symbol;
      if (!ticker) return false;

      const mcapCr = this.parseMarketCapToCr(stock.marketCap);
      const isLargeEnough = mcapCr === 0 || mcapCr >= minMarketCapCr;
      const hasVolume = (stock.volume || 0) >= 0;

      return isLargeEnough && hasVolume;
    });

    // Merge in P/E + ROE from the daily-precomputed IndianAPI fundamentals
    // cache (see StockFundamentalsService.js / scripts/refreshStockFundamentals.js).
    // Without this, no stock ever carries fundamentals -- the live price
    // provider (Angel One) never returns pe/roe -- and GoalRecommendationService's
    // >=3-verified-metrics-spanning-both-categories rule then excludes every
    // stock, which is the root cause of "Load Eligible Stocks" always
    // returning an empty list. This is a cache-only read (never a live
    // IndianAPI fetch) so a cold cache degrades to "no fundamentals yet"
    // rather than blocking or slowing this request.
    const enriched = await Promise.all(eligible.map(async (stock) => {
      const ticker = stock.ticker || stock.symbol;
      let fundamentals = null;
      try {
        fundamentals = await this.getFundamentalsFn(ticker);
      } catch (err) {
        logger.warn(`DynamicUniverseService: fundamentals lookup failed for ${ticker}: ${err.message}`);
        return { ...stock, fundamentalsProviderError: true };
      }
      if (!fundamentals) return stock;
      // Priority 1 (a real value the price provider already supplied) always
      // wins over anything fundamentals-service returned -- never overwrites
      // a valid existing metric, per the durable-fundamentals contract.
      return {
        ...stock,
        pe: stock.pe ?? fundamentals.pe ?? undefined,
        roe: stock.roe ?? fundamentals.roe ?? undefined,
        revenueGrowth: stock.revenueGrowth ?? fundamentals.revenueGrowth ?? undefined,
        profitGrowth: stock.profitGrowth ?? fundamentals.profitGrowth ?? undefined,
        operatingMargin: stock.operatingMargin ?? fundamentals.operatingMargin ?? undefined,
        debtTrend: stock.debtTrend ?? fundamentals.debtTrend ?? undefined,
        fundamentalSource: fundamentals.source || stock.fundamentalSource,
        fundamentalSourceUrl: fundamentals.sourceUrl || null,
        fundamentalDataAsOf: fundamentals.dataAsOf || null,
        fundamentalIsStale: Boolean(fundamentals.isStale),
        fundamentalProvenance: fundamentals.provenance || null,
      };
    }));

    // Angel One's live-quote feed never returns a market-cap field, so
    // stock.marketCap is always undefined and parseMarketCapToCr would
    // always yield null. The real market cap instead comes from
    // CompanyResearchProfile.marketCapCr, which is synced from the BSE
    // scrip master's genuine `Mktcap` column (see
    // CompanyResearchProfileSync.js / BseScripMasterProvider.js). Look
    // that up in one batched query -- never per-symbol -- and prefer it,
    // falling back to a parsed provider string only if one is ever present.
    const tickers = enriched.map((stock) => stock.ticker || stock.symbol).filter(Boolean);
    let profileMarketCapBySymbol = new Map();
    try {
      const profiles = await CompanyResearchProfile.find(
        { symbol: { $in: tickers } },
        { symbol: 1, marketCapCr: 1 },
      ).lean();
      profileMarketCapBySymbol = new Map(profiles.map((p) => [p.symbol, p.marketCapCr]));
    } catch (err) {
      logger.warn(`DynamicUniverseService: CompanyResearchProfile market-cap lookup failed: ${err.message}`);
    }

    const withParsedMarketCap = enriched.map((stock) => {
      const ticker = stock.ticker || stock.symbol;
      const parsedFromProvider = this.parseMarketCapToCr(stock.marketCap) || null;
      const fromProfile = profileMarketCapBySymbol.get(ticker) ?? null;
      return {
        ...stock,
        marketCapCr: parsedFromProvider || fromProfile || null,
      };
    });
    const segmented = classifyMarketCapSegments(withParsedMarketCap);

    logger.info(`DynamicUniverseService: Screened ${segmented.length} eligible stocks (Market Cap >= ₹${minMarketCapCr} Cr)`);
    await setCache(UNIVERSE_CACHE_KEY, segmented, UNIVERSE_TTL);
    return segmented;
  }

  async screenStocks(filters = {}) {
    const universe = await this.getEligibleUniverse();
    let results = [...universe];

    if (filters.sector && filters.sector.toLowerCase() !== 'all') {
      const target = filters.sector.toLowerCase();
      results = results.filter((s) => (s.sector || '').toLowerCase() === target);
    }

    if (filters.minPrice) {
      results = results.filter((s) => Number(s.price || 0) >= Number(filters.minPrice));
    }

    if (filters.maxPrice) {
      results = results.filter((s) => Number(s.price || 0) <= Number(filters.maxPrice));
    }

    if (filters.minPe) {
      results = results.filter((s) => Number(s.pe || 0) >= Number(filters.minPe));
    }

    if (filters.maxPe) {
      results = results.filter((s) => Number(s.pe || 0) <= Number(filters.maxPe));
    }

    return results;
  }
}

export default DynamicUniverseService;
