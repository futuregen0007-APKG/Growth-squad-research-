import YahooFinance from 'yahoo-finance2';

const yahooFinance = new YahooFinance();

const symbols = ['USDINR=X', 'RELIANCE.NS', 'HAL.NS', 'HDFCBANK.NS'];

for (const symbol of symbols) {
  try {
    const q = await yahooFinance.quote(symbol);
    console.log(JSON.stringify({
      symbol,
      price: q.regularMarketPrice,
      change: q.regularMarketChange,
      changePct: q.regularMarketChangePercent,
      prevClose: q.regularMarketPreviousClose,
      high: q.regularMarketDayHigh,
      low: q.regularMarketDayLow,
      name: q.shortName || q.longName,
      timestamp: q.regularMarketTime
    }, null, 2));
  } catch (error) {
    console.log(JSON.stringify({ symbol, error: error.message }, null, 2));
  }
}
