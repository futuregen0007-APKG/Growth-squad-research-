/**
 * MarketCapSegmentationService.js
 * ==================================
 * Classifies the TRACKED universe (not the whole real market -- this
 * project tracks ~215 stocks) into LARGE/MID/SMALL by market-cap rank, so
 * "Load Eligible Stocks" can rank each segment separately instead of one
 * combined list where large caps (which tend to have the most complete
 * verified data) crowd out every mid/small candidate.
 *
 * Percentile-based (not fixed absolute cutoffs): the top ~25% of the
 * universe BY VERIFIED MARKET CAP is LARGE, the next ~35% is MID, and the
 * remainder (still with a verified market cap) is SMALL. A stock with no
 * verified market cap is never guessed into a segment -- it gets
 * `marketCapSegment: null` and is excluded from all three segment lists.
 */
const LARGE_PERCENTILE = 0.25;
const MID_PERCENTILE = 0.60; // cumulative -- so MID is ranks (25%, 60%]

/**
 * classifyMarketCapSegments - pure function. `stocks` must each expose a
 * `marketCapCr` field (a real, parsed number) or null. Returns a NEW array
 * (same stocks, `marketCapSegment` added) -- never mutates the input.
 */
export const classifyMarketCapSegments = (stocks = []) => {
  const verified = stocks.filter((s) => Number.isFinite(s.marketCapCr) && s.marketCapCr > 0);
  const ranked = [...verified].sort((a, b) => b.marketCapCr - a.marketCapCr);
  const total = ranked.length;
  const largeCutoffIndex = Math.ceil(total * LARGE_PERCENTILE);
  const midCutoffIndex = Math.ceil(total * MID_PERCENTILE);

  const segmentBySymbol = new Map();
  ranked.forEach((stock, index) => {
    const symbol = stock.ticker || stock.symbol;
    let segment;
    if (index < largeCutoffIndex) segment = 'LARGE';
    else if (index < midCutoffIndex) segment = 'MID';
    else segment = 'SMALL';
    segmentBySymbol.set(symbol, segment);
  });

  return stocks.map((stock) => ({
    ...stock,
    marketCapSegment: segmentBySymbol.get(stock.ticker || stock.symbol) || null,
  }));
};

export default { classifyMarketCapSegments };
