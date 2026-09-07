import { getCache, setCache } from '../utils/redisClient.js';
import { SUPPORTED_STOCKS } from '../utils/constants.js';
import { logger } from '../utils/logger.js';

const UNIVERSE_CACHE_KEY = 'universe:eligible_stocks';
const UNIVERSE_TTL = 86400; // 24 hours

export class DynamicUniverseService {
  constructor(stockService) {
    this.stockService = stockService;
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

    logger.info(`DynamicUniverseService: Screened ${eligible.length} eligible stocks (Market Cap >= ₹${minMarketCapCr} Cr)`);
    await setCache(UNIVERSE_CACHE_KEY, eligible, UNIVERSE_TTL);
    return eligible;
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
