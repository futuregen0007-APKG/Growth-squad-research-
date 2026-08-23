import { EventEmitter } from 'node:events';

export class LivePriceService extends EventEmitter {
  constructor() {
    super();
    this.latestPrices = new Map();
  }

  update(price) {
    const previous = this.latestPrices.get(price.symbol);
    if (previous?.ltp === price.ltp && previous?.timestamp === price.timestamp) {
      return previous;
    }

    this.latestPrices.set(price.symbol, price);
    this.emit('price', price);
    return price;
  }

  get(symbol) {
    return this.latestPrices.get(String(symbol).trim().toUpperCase()) || null;
  }

  clear() {
    this.latestPrices.clear();
  }
}