import { WebSocketV2 } from 'smartapi-javascript';
import { logger } from '../utils/logger.js';

const NSE_EXCHANGE_TYPE = 1;
const SUBSCRIBE = 1;
const UNSUBSCRIBE = 0;
const LTP_MODE = 1;

const normalizeToken = (token) => String(token).replace(/^"|"$/g, '');

export class AngelWebSocketService {
  constructor(provider, livePriceService) {
    this.provider = provider;
    this.livePriceService = livePriceService;
    this.socket = null;
    this.connectPromise = null;
    this.subscriptions = new Map();
    this.tokenToSymbol = new Map();
  }

  async subscribe(symbol) {
    const normalizedSymbol = String(symbol).trim().toUpperCase();
    if (!normalizedSymbol) throw new Error('Symbol is required');

    const existing = this.subscriptions.get(normalizedSymbol);
    if (existing) return existing;

    const session = await this.provider.login();
    const resolved = await this.provider.resolveSymbol(normalizedSymbol, 'NSE', session.jwtToken);
    this.subscriptions.set(normalizedSymbol, resolved);
    this.tokenToSymbol.set(String(resolved.symbolToken), normalizedSymbol);

    await this.ensureConnected(session);
    this.sendSubscription(SUBSCRIBE, resolved.symbolToken);
    logger.info(`[AngelWS] Subscribed to ${normalizedSymbol} (${resolved.symbolToken})`);
    return resolved;
  }

  async unsubscribe(symbol) {
    const normalizedSymbol = String(symbol).trim().toUpperCase();
    const resolved = this.subscriptions.get(normalizedSymbol);
    if (!resolved) return;

    this.subscriptions.delete(normalizedSymbol);
    this.tokenToSymbol.delete(String(resolved.symbolToken));
    if (this.socket) {
      this.sendSubscription(UNSUBSCRIBE, resolved.symbolToken);
    }
  }

  async ensureConnected(session) {
    if (this.socket) return;
    if (this.connectPromise) return this.connectPromise;

    logger.info('[AngelWS] Connecting...');
    this.connectPromise = (async () => {
      const socket = new WebSocketV2({
        jwttoken: session.jwtToken,
        apikey: this.provider.credentials.apiKey,
        clientcode: this.provider.credentials.clientCode,
        feedtype: session.feedToken,
      });

      socket.on('tick', (tick) => this.handleTick(tick));
      socket.customError();
      socket.reconnection('exponential', 1000, 2);
      await socket.connect();
      this.socket = socket;
      logger.info('[AngelWS] Connected');
    })().catch((error) => {
      logger.error(`[AngelWS] Authentication or connection failed: ${error.message}`);
      this.socket = null;
      throw new Error(`Angel One WebSocket authentication failed: ${error.message}`);
    }).finally(() => {
      this.connectPromise = null;
    });

    return this.connectPromise;
  }

  sendSubscription(action, token) {
    if (!this.socket) return;
    this.socket.fetchData({
      correlationID: `stocks-${Date.now()}`,
      action,
      mode: LTP_MODE,
      exchangeType: NSE_EXCHANGE_TYPE,
      tokens: [String(token)],
    });
  }

  handleTick(tick) {
    if (!tick || typeof tick !== 'object') return;

    const token = normalizeToken(tick.token);
    const symbol = this.tokenToSymbol.get(token);
    const ltp = Number(tick.last_traded_price) / 100;
    if (!symbol || !Number.isFinite(ltp)) return;

    const price = this.livePriceService.update({
      symbol,
      token,
      exchange: 'NSE',
      ltp,
      timestamp: Number(tick.exchange_timestamp) || Date.now(),
    });
    logger.debug(`[AngelWS] Tick received: ${symbol} ${price.ltp}`);
  }

  async stop() {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.subscriptions.clear();
    this.tokenToSymbol.clear();
  }
}