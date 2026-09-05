/**
 * HISTORICAL_METRICS.JS
 * ======================
 * Deterministic return/volatility/drawdown calculation from real daily
 * candles. No AI, no fallback scoring: a metric is only computed when the
 * candle sample is large enough to be statistically meaningful, otherwise it
 * is returned as `null` with a `missingReason` explaining why — never a
 * favorable placeholder.
 *
 * Thresholds match the same sufficiency bar already enforced for Goals
 * recommendation scoring:
 * - 1-year return needs close to a full year of trading days.
 * - Volatility uses a standard short realized-vol sample size.
 * - Max drawdown needs a longer look-back to capture a real peak-to-trough move.
 */

export const MIN_OBSERVATIONS_FOR_RETURN = 200;
export const MIN_OBSERVATIONS_FOR_VOLATILITY = 20;
export const MIN_OBSERVATIONS_FOR_DRAWDOWN = 60;

const unavailable = (reason) => ({ value: null, available: false, missingReason: reason });

/**
 * calculateDeterministicMetrics - Compute 1Y return, annualized volatility,
 * and max drawdown from an ascending array of daily candles.
 *
 * @param {Array<{close:number}>} candles
 * @returns {{
 *   observations: number,
 *   oneYearReturn: {value:number|null, available:boolean, missingReason:string|null},
 *   volatility: {value:number|null, available:boolean, missingReason:string|null},
 *   maxDrawdown: {value:number|null, available:boolean, missingReason:string|null},
 * }}
 */
export const calculateDeterministicMetrics = (candles = []) => {
  const closes = (Array.isArray(candles) ? candles : [])
    .map((candle) => Number(candle?.close))
    .filter((value) => Number.isFinite(value) && value > 0);
  const observations = closes.length;

  if (observations < 2) {
    const reason = `Fewer than 2 valid daily closes (${observations} observed)`;
    return {
      observations,
      oneYearReturn: unavailable(reason),
      volatility: unavailable(reason),
      maxDrawdown: unavailable(reason),
    };
  }

  const result = { observations };

  result.oneYearReturn = observations >= MIN_OBSERVATIONS_FOR_RETURN
    ? {
      value: Number((((closes[closes.length - 1] / closes[0]) - 1) * 100).toFixed(2)),
      available: true,
      missingReason: null,
    }
    : unavailable(`Needs >=${MIN_OBSERVATIONS_FOR_RETURN} observations for a verified 1-year return, has ${observations}`);

  if (observations >= MIN_OBSERVATIONS_FOR_VOLATILITY) {
    const returns = closes.slice(1).map((value, index) => (value / closes[index]) - 1).filter(Number.isFinite);
    const mean = returns.reduce((sum, value) => sum + value, 0) / Math.max(returns.length, 1);
    const variance = returns.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / Math.max(returns.length - 1, 1);
    result.volatility = {
      value: Number((Math.sqrt(variance) * Math.sqrt(252) * 100).toFixed(2)),
      available: true,
      missingReason: null,
    };
  } else {
    result.volatility = unavailable(`Needs >=${MIN_OBSERVATIONS_FOR_VOLATILITY} observations for volatility, has ${observations}`);
  }

  if (observations >= MIN_OBSERVATIONS_FOR_DRAWDOWN) {
    let peak = closes[0];
    let maxDrawdown = 0;
    closes.forEach((close) => {
      peak = Math.max(peak, close);
      maxDrawdown = Math.min(maxDrawdown, (close / peak) - 1);
    });
    result.maxDrawdown = {
      value: Number((maxDrawdown * 100).toFixed(2)),
      available: true,
      missingReason: null,
    };
  } else {
    result.maxDrawdown = unavailable(`Needs >=${MIN_OBSERVATIONS_FOR_DRAWDOWN} observations for max drawdown, has ${observations}`);
  }

  return result;
};

export default { calculateDeterministicMetrics, MIN_OBSERVATIONS_FOR_RETURN, MIN_OBSERVATIONS_FOR_VOLATILITY, MIN_OBSERVATIONS_FOR_DRAWDOWN };
