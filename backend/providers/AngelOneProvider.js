import axios from 'axios';
import { BaseProvider } from './BaseProvider.js';
import { logger } from '../utils/logger.js';
import { createProviderError } from '../utils/errorHandler.js';

const BASE_URL = 'https://apiconnect.angelone.in';
const LOGIN_PATH = '/rest/auth/angelbroking/user/v1/loginByPassword';
const QUOTE_PATH = '/rest/secure/angelbroking/market/v1/quote/';
const SEARCH_PATH = '/rest/secure/angelbroking/order/v1/searchScrip';
const CANDLE_PATH = '/rest/secure/angelbroking/historical/v1/getCandleData';
const SCRIP_MASTER_URL = 'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json';
const ALLOWED_EXCHANGES = new Set(['NSE', 'BSE']);

const INDEX_ALIASES = {
  NIFTY: { exchange: 'NSE', symbolToken: '99926000', tradingSymbol: 'NIFTY' },
  'NIFTY 50': { exchange: 'NSE', symbolToken: '99926000', tradingSymbol: 'NIFTY' },
  NIFTYIT: { exchange: 'NSE', symbolToken: '99926008', tradingSymbol: 'NIFTYIT' },
  BANKNIFTY: { exchange: 'NSE', symbolToken: '99926009', tradingSymbol: 'BANKNIFTY' },
  'NIFTY BANK': { exchange: 'NSE', symbolToken: '99926009', tradingSymbol: 'BANKNIFTY' },
  SENSEX: { exchange: 'BSE', symbolToken: '99919000', tradingSymbol: 'SENSEX' },
};

const SYMBOL_ALIASES = {
  GMRINFRA: 'GMRAIRPORT',
  CEAT: 'CEATLTD',
  KALPATPOWR: 'KALPATARU',
};

export class AngelOneProvider extends BaseProvider {
  constructor({
    apiKey = process.env.ANGEL_API_KEY,
    clientCode = process.env.ANGEL_CLIENT_CODE,
    pin = process.env.ANGEL_PIN,
    totpSecret = process.env.ANGEL_TOTP_SECRET,
    localIp = process.env.ANGEL_CLIENT_LOCAL_IP,
    publicIp = process.env.ANGEL_CLIENT_PUBLIC_IP,
    macAddress = process.env.ANGEL_MAC_ADDRESS,
  } = {}) {
    super();

    const missing = Object.entries({ apiKey, clientCode, pin, totpSecret, localIp, publicIp, macAddress })
      .filter(([, value]) => !value)
      .map(([name]) => name);

    if (missing.length) {
      throw new Error(`Missing Angel One configuration: ${missing.join(', ')}`);
    }

    this.credentials = { apiKey, clientCode, pin, totpSecret, localIp, publicIp, macAddress };
    this.client = axios.create({ baseURL: BASE_URL, timeout: 15000 });
    this.session = null;
    this.loginPromise = null;
    this.symbolCache = new Map();
    this.scripMasterPromise = null;
    this.providerName = 'Angel One';
  }

  getHeaders(jwtToken) {
    const { apiKey, localIp, publicIp, macAddress } = this.credentials;
    return {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-UserType': 'USER',
      'X-SourceID': 'WEB',
      'X-ClientLocalIP': localIp,
      'X-ClientPublicIP': publicIp,
      'X-MACAddress': macAddress,
      'X-PrivateKey': apiKey,
      ...(jwtToken ? { Authorization: `Bearer ${jwtToken}` } : {}),
    };
  }

  async login() {
    if (this.session?.expiresAt > Date.now()) {
      return this.session;
    }

    if (this.loginPromise) {
      return this.loginPromise;
    }

    this.loginPromise = (async () => {
      const { clientCode, pin, totpSecret } = this.credentials;
      const { generate } = await import('otplib');
      const totp = await generate({ secret: totpSecret });
      const response = await this.client.post(
        LOGIN_PATH,
        { clientcode: clientCode, password: pin, totp },
        { headers: this.getHeaders() },
      );

      if (!response.data?.status || !response.data?.data?.jwtToken) {
        throw new Error(response.data?.message || 'Angel One login failed');
      }

      this.session = {
        ...response.data.data,
        expiresAt: Date.now() + 10 * 60 * 1000,
      };
      logger.info('Angel One login successful');
      return this.session;
    })();

    try {
      return await this.loginPromise;
    } finally {
      this.loginPromise = null;
    }
  }

  normalizeExchange(exchange = 'NSE') {
    const normalized = String(exchange).trim().toUpperCase();
    if (!ALLOWED_EXCHANGES.has(normalized)) {
      throw new Error(`Unsupported exchange '${exchange}'. Only NSE and BSE are supported.`);
    }
    return normalized;
  }

  async resolveSymbol(symbol, exchange = 'NSE', jwtToken) {
    const normalized = String(symbol).trim().toUpperCase();
    const cacheKey = `${exchange}:${normalized}`;
    if (this.symbolCache.has(cacheKey)) {
      return this.symbolCache.get(cacheKey);
    }

    const alias = INDEX_ALIASES[normalized];
    if (alias) {
      this.symbolCache.set(cacheKey, alias);
      return alias;
    }

    const normalizedSearch = (SYMBOL_ALIASES[normalized] || normalized).replace(/\s+/g, '');
    const scripMaster = await this.loadScripMaster();
    const masterMatch = scripMaster.find((item) => {
      if (item.exch_seg !== exchange) return false;
      const itemSymbol = String(item.symbol || '').toUpperCase();
      const itemName = String(item.name || '').replace(/\s+/g, '').toUpperCase();
      return (
        itemSymbol === `${normalizedSearch}-EQ` ||
        itemSymbol === normalizedSearch ||
        itemName === normalizedSearch
      );
    });

    if (masterMatch?.token) {
      const resolved = {
        exchange,
        symbolToken: String(masterMatch.token),
        tradingSymbol: masterMatch.symbol,
      };
      this.symbolCache.set(cacheKey, resolved);
      return resolved;
    }

    const response = await this.client.post(
      SEARCH_PATH,
      { exchange, searchscrip: normalizedSearch },
      { headers: this.getHeaders(jwtToken) },
    );
    const results = response.data?.data || [];
    const match = results.find((item) => {
      const tradingSymbol = String(item.tradingsymbol || '').toUpperCase();
      return tradingSymbol === `${normalizedSearch}-EQ` || tradingSymbol === normalizedSearch;
    }) || results[0];

    if (!match?.symboltoken) {
      throw new Error(`Symbol '${symbol}' not found on ${exchange}`);
    }

    const resolved = {
      exchange,
      symbolToken: String(match.symboltoken),
      tradingSymbol: match.tradingsymbol,
    };
    this.symbolCache.set(cacheKey, resolved);
    return resolved;
  }

  async loadScripMaster() {
    if (this.scripMasterPromise) {
      return this.scripMasterPromise;
    }

    this.scripMasterPromise = this.client.get(SCRIP_MASTER_URL, { timeout: 30000 })
      .then((response) => {
        if (!Array.isArray(response.data)) {
          throw new Error('Angel One scrip master returned an invalid response');
        }
        logger.info(`Angel One scrip master loaded: ${response.data.length} instruments`);
        return response.data;
      })
      .catch((error) => {
        this.scripMasterPromise = null;
        throw error;
      });

    return this.scripMasterPromise;
  }

  async getQuotesForResolved(resolvedStocks, jwtToken) {
    const quotes = [];
    const batchSize = 50;

    for (let index = 0; index < resolvedStocks.length; index += batchSize) {
      const batch = resolvedStocks.slice(index, index + batchSize);
      const exchangeTokens = batch.reduce((grouped, item) => {
        if (!grouped[item.resolved.exchange]) {
          grouped[item.resolved.exchange] = [];
        }
        grouped[item.resolved.exchange].push(item.resolved.symbolToken);
        return grouped;
      }, {});

      const response = await this.client.post(
        QUOTE_PATH,
        { mode: 'FULL', exchangeTokens },
        { headers: this.getHeaders(jwtToken) },
      );
      quotes.push(...(response.data?.data?.fetched || []));
    }

    return quotes;
  }

  async getRawQuote(symbol) {
    this.validateSymbol(symbol);
    const session = await this.login();
    const [exchangePrefix, symbolValue] = String(symbol).split(':', 2);
    const hasExchangePrefix = symbolValue !== undefined;
    const requestedExchange = this.normalizeExchange(
      hasExchangePrefix
        ? exchangePrefix
        : process.env.ANGEL_DEFAULT_EXCHANGE || 'NSE',
    );
    const lookupSymbol = hasExchangePrefix ? symbolValue : symbol;
    const resolved = await this.resolveSymbol(lookupSymbol, requestedExchange, session.jwtToken);
    const quotes = await this.getQuotesForResolved(
      [{ symbol, resolved }],
      session.jwtToken,
    );
    const quote = quotes[0];
    if (!quote) {
      throw new Error(`No quote data returned for ${lookupSymbol}`);
    }
    return { quote, resolved };
  }

  async getStock(symbol) {
    try {
      const { quote, resolved } = await this.getRawQuote(symbol);
      const formatted = this.formatStockData(quote, symbol, resolved);
      logger.debug(`Angel One: fetched ${formatted.ticker} - Price: ${formatted.price}`);
      return formatted;
    } catch (error) {
      throw createProviderError(this.providerName, `Failed to fetch ${symbol}: ${error.message}`);
    }
  }

  async getMultipleStocks(symbols) {
    const uniqueSymbols = [...new Set((symbols || []).map((symbol) => String(symbol).trim().toUpperCase()).filter(Boolean))];
    if (!uniqueSymbols.length) return [];

    const session = await this.login();
    const resolvedStocks = [];

    for (const symbol of uniqueSymbols) {
      try {
        const [exchangePrefix, symbolValue] = symbol.split(':', 2);
        const hasExchangePrefix = symbolValue !== undefined;
        const exchange = this.normalizeExchange(
          hasExchangePrefix
            ? exchangePrefix
            : process.env.ANGEL_DEFAULT_EXCHANGE || 'NSE',
        );
        const lookupSymbol = hasExchangePrefix ? symbolValue : symbol;
        const resolved = await this.resolveSymbol(lookupSymbol, exchange, session.jwtToken);
        resolvedStocks.push({ symbol, resolved });
      } catch (error) {
        logger.warn(`Angel One: failed to fetch ${symbol}: ${error.message}`);
      }
    }

    if (!resolvedStocks.length) return [];

    try {
      const quotes = await this.getQuotesForResolved(resolvedStocks, session.jwtToken);
      const quoteByToken = new Map(
        quotes.map((quote) => [String(quote.symbolToken), quote]),
      );

      return resolvedStocks.flatMap(({ symbol, resolved }) => {
        const quote = quoteByToken.get(resolved.symbolToken);
        if (!quote) return [];
        const formatted = this.formatStockData(quote, symbol, resolved);
        logger.debug(`Angel One: fetched ${formatted.ticker} - Price: ${formatted.price}`);
        return [formatted];
      });
    } catch (error) {
      throw createProviderError(this.providerName, `Failed to fetch multiple stocks: ${error.message}`);
    }
  }

  async getCompanyDetails(symbol) {
    return {
      ticker: String(symbol).toUpperCase(),
      name: String(symbol).toUpperCase(),
      description: null,
      sector: null,
      marketCap: null,
      website: null,
      foundedYear: null,
    };
  }

  async getHistoricalData(symbol, period = '1D') {
    this.validateSymbol(symbol);
    const session = await this.login();
    const [exchangePrefix, symbolValue] = String(symbol).split(':', 2);
    const hasExchangePrefix = symbolValue !== undefined;
    const exchange = this.normalizeExchange(
      hasExchangePrefix ? exchangePrefix : process.env.ANGEL_DEFAULT_EXCHANGE || 'NSE',
    );
    const lookupSymbol = hasExchangePrefix ? symbolValue : symbol;
    const resolved = await this.resolveSymbol(lookupSymbol, exchange, session.jwtToken);
    const intervalMap = { '1D': 'ONE_MINUTE', '1W': 'ONE_WEEK', '1M': 'ONE_DAY', '3M': 'ONE_DAY', '1Y': 'ONE_DAY' };
    const interval = intervalMap[period] || 'ONE_DAY';
    const days = { '1D': 1, '1W': 14, '1M': 45, '3M': 120, '1Y': 370 }[period] || 45;
    const to = new Date();
    const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
    const formatDate = (date) => date.toISOString().slice(0, 19).replace('T', ' ');
    const response = await this.client.post(
      CANDLE_PATH,
      {
        exchange: resolved.exchange,
        symboltoken: resolved.symbolToken,
        interval,
        fromdate: formatDate(from),
        todate: formatDate(to),
      },
      { headers: this.getHeaders(session.jwtToken) },
    );
    return (response.data?.data || []).map((candle) => ({
      timestamp: new Date(candle[0]).getTime(),
      open: Number(candle[1]),
      high: Number(candle[2]),
      low: Number(candle[3]),
      close: Number(candle[4]),
      volume: Number(candle[5] || 0),
    }));
  }

  async getMarketStatus() {
    const now = new Date();
    const istTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const minutes = istTime.getHours() * 60 + istTime.getMinutes();
    const isOpen = minutes >= 555 && minutes < 930;
    return {
      isOpen,
      region: 'NSE / BSE',
      session: isOpen ? 'REGULAR' : 'CLOSED',
      closesAt: '15:30 IST',
      serverTime: `${istTime.toLocaleTimeString('en-US', { timeZone: 'Asia/Kolkata' })} IST`,
    };
  }

  formatStockData(data, symbol, resolved) {
    const price = Number(data.ltp ?? 0);
    const previousClose = Number(data.close ?? 0);
    return {
      ticker: String(symbol).toUpperCase(),
      name: resolved.tradingSymbol || String(symbol).toUpperCase(),
      price,
      change: Number(data.netChange ?? price - previousClose),
      changePct: Number(data.percentChange ?? 0),
      high: Number(data.high ?? 0),
      low: Number(data.low ?? 0),
      open: Number(data.open ?? 0),
      previousClose,
      volume: Number(data.tradeVolume ?? 0),
      currency: 'INR',
      lastUpdate: Date.now(),
      companyName: resolved.tradingSymbol || String(symbol).toUpperCase(),
      timestamp: data.exchTradeTime || data.exchFeedTime || new Date().toISOString(),
      exchange: resolved.exchange,
      symbolToken: resolved.symbolToken,
    };
  }
}