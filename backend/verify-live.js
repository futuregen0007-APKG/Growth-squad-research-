import { AngelOneService } from './services/angelOne.service.js';

const angelOne = new AngelOneService();

const symbols = ['USDINR=X', 'RELIANCE.NS', 'HAL.NS', 'HDFCBANK.NS'];

for (const symbol of symbols) {
  try {
    const q = await angelOne.fetchQuote(symbol);
    console.log(JSON.stringify({
      symbol,
      price: q.price,
      change: q.change,
      changePct: q.percentage,
      prevClose: q.previousClose,
      high: q.high,
      low: q.low,
      name: q.companyName,
      timestamp: q.timestamp
    }, null, 2));
  } catch (error) {
    console.log(JSON.stringify({ symbol, error: error.message }, null, 2));
  }
}
