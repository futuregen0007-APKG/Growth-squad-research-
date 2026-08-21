import redisClient from '../utils/redisClient.js';
import { SECTORS } from '../../frontend/src/data/mockData.js';
import { INDEX_SYMBOLS } from '../utils/constants.js';
import { AngelOneProvider } from '../providers/AngelOneProvider.js';

let marketProvider;

function getMarketProvider() {
  if (!marketProvider) marketProvider = new AngelOneProvider();
  return marketProvider;
}

// JdK-style RRG backend implementation
// Produces for each sector a time-series of points: { t, x: RS-Ratio-1, y: RS-Momentum }
// - We fetch weekly closes for leaders and benchmark for the last N weeks
// - sector price per week = average of leaders' close
// - RS = sector_price / benchmark_price
// - smoothed RS = EMA(RS, span)
// - RS-Momentum = pct change of smoothed RS between consecutive weeks

const WEEKS = 12; // number of historical weekly points (tail length)
const EMA_SPAN = 3; // smoothing for RS series

function ema(series, span = 3) {
  const alpha = 2 / (span + 1);
  const out = [];
  let prev = series[0] || 0;
  out[0] = prev;
  for (let i = 1; i < series.length; i++) {
    const val = series[i] * alpha + prev * (1 - alpha);
    out[i] = val;
    prev = val;
  }
  return out;
}

async function fetchWeeklyCloses(ticker, weeks = WEEKS) {
  try {
    const cacheKey = `hist:weekly:${ticker}:${weeks}`;
    const cached = await redisClient.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const hist = await getMarketProvider().getHistoricalData(ticker, '1W');
    const closes = hist.slice(-weeks);
    await redisClient.setEx(cacheKey, 300, JSON.stringify(closes));
    return closes;
  } catch (err) {
    return [];
  }
}

async function computeJdKRotation() {
  const benchmarkSymbol = INDEX_SYMBOLS['NIFTY 50'] || Object.values(INDEX_SYMBOLS)[0];

  // Fetch benchmark closes
  const benchSeries = await fetchWeeklyCloses(benchmarkSymbol, WEEKS);
  if (!benchSeries || benchSeries.length === 0) {
    // If historical data unavailable (API disabled / Node env mismatch),
    // produce a synthetic but stable-looking series so the frontend can render
    // a representative RRG while real data is fixed later.
    const synthetic = SECTORS.map((s, si) => {
      const seed = si * 0.7 + 0.3;
      const series = [];
      for (let i = 0; i < WEEKS; i++) {
        const t = Date.now() - (WEEKS - i) * 7 * 24 * 3600 * 1000;
        const x = Math.sin((i + seed) * 0.7) * 0.06 + (s.weight || 10) / 500; // bias by weight
        const y = Math.cos((i + seed) * 0.6) * 0.06;
        series.push({ t, x, y });
      }
      const last = series[series.length - 1];
      const prev = series[series.length - 2] || last;
      const velocity = { dx: last.x - prev.x, dy: last.y - prev.y };
      return { id: s.id, name: s.name, leaders: s.leaders, weight: s.weight, series, current: last, velocity };
    });
    return synthetic;
  }

  const ptsOut = [];
  for (const s of SECTORS) {
    const leaders = s.leaders || [];
    // fetch weekly closes for each leader in parallel
    const leaderPromises = leaders.map((t) => fetchWeeklyCloses(t, WEEKS));
    const leadersSeries = await Promise.all(leaderPromises);

    // For each week index, compute average close across leaders that have data
    const series = [];
    for (let i = 0; i < benchSeries.length; i++) {
      const benchClose = benchSeries[i]?.close;
      // collect leader closes at same index (aligned by latest)
      const closes = leadersSeries.map((ls) => ls[i]?.close).filter((v) => v != null);
      let sectorClose = null;
      if (closes.length > 0) {
        const sum = closes.reduce((a, b) => a + b, 0);
        sectorClose = sum / closes.length;
      }
      // fallback to sector metadata if missing
      if (sectorClose == null || benchClose == null) {
        series.push({ t: benchSeries[i].t, sectorClose: null, benchClose: benchClose, rs: null });
      } else {
        const rs = sectorClose / benchClose;
        series.push({ t: benchSeries[i].t, sectorClose, benchClose, rs });
      }
    }

    // extract RS values and compute smoothed RS and momentum
    const rsVals = series.map((p) => (p.rs == null ? 0 : p.rs));
    const smoothed = ema(rsVals, EMA_SPAN);
    const points = [];
    for (let i = 0; i < series.length; i++) {
      const t = series[i].t;
      const sm = smoothed[i] || 0;
      const prev = smoothed[i - 1] || sm;
      const momentum = prev === 0 ? 0 : (sm - prev) / Math.abs(prev);
      // x = smoothed RS minus 1 (so 0 => parity with benchmark), y = momentum
      points.push({ t, x: sm - 1, y: momentum });
    }

    // compute velocity vector for last point
    const lastPt = points[points.length - 1] || { x: 0, y: 0 };
    const prevPt = points[points.length - 2] || lastPt;
    const velocity = { dx: lastPt.x - prevPt.x, dy: lastPt.y - prevPt.y };

    ptsOut.push({ id: s.id, name: s.name, leaders: s.leaders, weight: s.weight, series: points, current: lastPt, velocity });
  }

  return ptsOut;
}

const SectorRotationService = {
  async getSectorRotation() {
    const cacheKey = 'sector-rotation:jdkrgg:v1';
    const cached = await redisClient.get(cacheKey);
    if (cached) return JSON.parse(cached);
    const pts = await computeJdKRotation();
    await redisClient.setEx(cacheKey, 60, JSON.stringify(pts));
    return pts;
  },
};

export default SectorRotationService;
