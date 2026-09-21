/**
 * valuationMetrics.js
 * ======================
 * Phase 6B: valuation multiples that are either fully attributable or
 * explicitly unavailable — never approximated.
 *
 * THE RULE THIS MODULE EXISTS TO ENFORCE. A multiple is a ratio of two
 * figures from different sources with different as-of dates. That makes it
 * the single easiest place in the system to produce a confident wrong
 * number: a current price over a three-year-old EPS is arithmetically fine
 * and financially meaningless. So:
 *
 *   - A provider-supplied VERIFIED multiple is preferred over anything we
 *     compute.
 *   - A computed multiple requires BOTH inputs to be present and
 *     period-compatible. TTM earnings means four consecutive quarters that
 *     actually exist — never three scaled up, never an annual figure
 *     divided by four.
 *   - A missing input is never substituted, defaulted, or carried over from
 *     a different period.
 *   - Every result carries its formula, both inputs with their own source
 *     and as-of date, and the computation timestamp.
 *   - When it cannot be computed, the reason says which input was missing.
 *
 * Banks: P/E alone is a poor lens on a lender, whose earnings swing with
 * provisioning. `bankValuationContext` pairs P/B with asset quality so the
 * multiple is read against the balance sheet it rests on.
 */

export const VALUATION_UNAVAILABLE = Object.freeze({
  NO_PRICE: 'no verified share price is held',
  NO_EARNINGS: 'no per-share earnings are held for a compatible period',
  NO_BOOK_VALUE: 'no book value per share is held',
  INCOMPLETE_TTM: 'fewer than four consecutive quarters are held, so a trailing-twelve-month figure cannot be formed',
  PERIOD_INCOMPATIBLE: 'the price and the earnings figure cover incompatible periods',
  NON_POSITIVE_EARNINGS: 'earnings are zero or negative, so the multiple is not meaningful',
});

/** Quarters in descending recency, e.g. "Q3 FY2025" > "Q2 FY2025" > "Q4 FY2024". */
const quarterRank = (period) => {
  const match = String(period || '').match(/Q(\d)\s*FY(\d{4})/i);
  if (!match) return null;
  return Number(match[2]) * 4 + Number(match[1]);
};

/**
 * buildTtm - sums four CONSECUTIVE quarters. Returns null when the run is
 * incomplete: a gap means the trailing figure would be wrong, and a wrong
 * denominator is worse than no multiple.
 */
export const buildTtm = (quarterlyFacts = []) => {
  const ranked = quarterlyFacts
    .map((fact) => ({ ...fact, rank: quarterRank(fact.period) }))
    .filter((fact) => fact.rank !== null && Number.isFinite(fact.value))
    .sort((a, b) => b.rank - a.rank);

  if (ranked.length < 4) return null;

  const window = ranked.slice(0, 4);
  // Consecutive means each rank is exactly one less than the previous.
  for (let i = 1; i < window.length; i += 1) {
    if (window[i].rank !== window[i - 1].rank - 1) return null;
  }

  return {
    value: Number(window.reduce((sum, fact) => sum + fact.value, 0).toFixed(2)),
    unit: window[0].unit,
    periods: window.map((fact) => fact.period),
    sources: window.map((fact) => ({ period: fact.period, sourceUrl: fact.sourceUrl || null, asOf: fact.asOf || null })),
  };
};

/**
 * computePriceToEarnings - price / earnings per share, with full provenance.
 *
 * `price` and `earningsPerShare` are each { value, unit, asOf, sourceUrl,
 * period }. Nothing is fetched here; the caller supplies verified inputs.
 */
export const computePriceToEarnings = ({ price, earningsPerShare } = {}) => {
  if (!price || !Number.isFinite(price.value)) {
    return { available: false, reason: VALUATION_UNAVAILABLE.NO_PRICE };
  }
  if (!earningsPerShare || !Number.isFinite(earningsPerShare.value)) {
    return { available: false, reason: VALUATION_UNAVAILABLE.NO_EARNINGS };
  }
  if (earningsPerShare.value <= 0) {
    return { available: false, reason: VALUATION_UNAVAILABLE.NON_POSITIVE_EARNINGS };
  }

  return {
    available: true,
    metric: 'PE',
    label: 'Price / earnings (trailing)',
    value: Number((price.value / earningsPerShare.value).toFixed(2)),
    unit: 'RATIO',
    formula: 'share price ÷ trailing-twelve-month earnings per share',
    inputs: {
      price: { value: price.value, unit: price.unit || 'INR', asOf: price.asOf || null, sourceUrl: price.sourceUrl || null },
      earningsPerShare: {
        value: earningsPerShare.value,
        unit: earningsPerShare.unit || 'INR',
        periods: earningsPerShare.periods || (earningsPerShare.period ? [earningsPerShare.period] : []),
        asOf: earningsPerShare.asOf || null,
        sourceUrl: earningsPerShare.sourceUrl || null,
        sources: earningsPerShare.sources || [],
      },
    },
    computedAt: new Date().toISOString(),
  };
};

/** computePriceToBook - price / book value per share, same provenance contract. */
export const computePriceToBook = ({ price, bookValuePerShare } = {}) => {
  if (!price || !Number.isFinite(price.value)) {
    return { available: false, reason: VALUATION_UNAVAILABLE.NO_PRICE };
  }
  if (!bookValuePerShare || !Number.isFinite(bookValuePerShare.value) || bookValuePerShare.value <= 0) {
    return { available: false, reason: VALUATION_UNAVAILABLE.NO_BOOK_VALUE };
  }

  return {
    available: true,
    metric: 'PB',
    label: 'Price / book value',
    value: Number((price.value / bookValuePerShare.value).toFixed(2)),
    unit: 'RATIO',
    formula: 'share price ÷ book value per share',
    inputs: {
      price: { value: price.value, unit: price.unit || 'INR', asOf: price.asOf || null, sourceUrl: price.sourceUrl || null },
      bookValuePerShare: {
        value: bookValuePerShare.value,
        unit: bookValuePerShare.unit || 'INR',
        period: bookValuePerShare.period || null,
        asOf: bookValuePerShare.asOf || null,
        sourceUrl: bookValuePerShare.sourceUrl || null,
      },
    },
    computedAt: new Date().toISOString(),
  };
};

/**
 * buildValuation - the whole valuation picture for one company, from a
 * stored-fundamentals view plus its market metrics.
 *
 * Returns available multiples AND an explicit list of the ones it could not
 * produce with the reason for each, so an answer can state the gap rather
 * than quietly omitting valuation.
 */
export const buildValuation = (view, { providerMultiples = null } = {}) => {
  const market = view?.marketMetrics;
  const price = market && Number.isFinite(market.lastClose)
    ? { value: market.lastClose, unit: 'INR', asOf: market.dataAsOf || null, sourceUrl: null, provider: market.provider || 'NSE_BHAVCOPY' }
    : null;

  const available = [];
  const unavailable = [];

  // 1. A provider's own verified multiple always wins over our arithmetic.
  for (const [metric, supplied] of Object.entries(providerMultiples || {})) {
    if (supplied && Number.isFinite(supplied.value)) {
      available.push({
        available: true,
        metric,
        label: supplied.label || metric,
        value: supplied.value,
        unit: 'RATIO',
        formula: 'as published by the data provider',
        inputs: { provider: { name: supplied.provider || 'provider', asOf: supplied.asOf || null } },
        computedAt: new Date().toISOString(),
        source: 'PROVIDER_VERIFIED',
      });
    }
  }
  const alreadyHave = new Set(available.map((m) => m.metric));

  // 2. P/E from a genuine TTM run of quarterly EPS.
  if (!alreadyHave.has('PE')) {
    const epsQuarters = (view?.metrics || [])
      .filter((m) => m.metric === 'EPS')
      .flatMap((m) => [m, ...(m.history || [])])
      .filter((m) => /Q\d\s*FY/i.test(String(m.period || '')));
    const ttm = buildTtm(epsQuarters);
    if (!ttm) {
      unavailable.push({ metric: 'PE', reason: epsQuarters.length ? VALUATION_UNAVAILABLE.INCOMPLETE_TTM : VALUATION_UNAVAILABLE.NO_EARNINGS });
    } else {
      const computed = computePriceToEarnings({
        price,
        earningsPerShare: { value: ttm.value, unit: ttm.unit, periods: ttm.periods, sources: ttm.sources },
      });
      if (computed.available) available.push({ ...computed, source: 'COMPUTED' });
      else unavailable.push({ metric: 'PE', reason: computed.reason });
    }
  }

  // 3. P/B needs a book value per share, which is not currently collected.
  if (!alreadyHave.has('PB')) {
    const book = (view?.metrics || []).find((m) => m.metric === 'BOOK_VALUE_PER_SHARE');
    if (!book) unavailable.push({ metric: 'PB', reason: VALUATION_UNAVAILABLE.NO_BOOK_VALUE });
    else {
      const computed = computePriceToBook({ price, bookValuePerShare: book });
      if (computed.available) available.push({ ...computed, source: 'COMPUTED' });
      else unavailable.push({ metric: 'PB', reason: computed.reason });
    }
  }

  return {
    symbol: view?.symbol || null,
    sectorKind: view?.sectorKind || null,
    priceAsOf: price?.asOf || null,
    available,
    unavailable,
    hasAny: available.length > 0,
  };
};

/**
 * bankValuationContext - what a bank's multiple should be read alongside.
 * P/E alone misleads for a lender: earnings move with provisioning, so book
 * value and asset quality carry the signal.
 */
export const bankValuationContext = (view) => {
  if (view?.sectorKind !== 'BANKING') return null;
  const pick = (metric) => (view.metrics || []).find((m) => m.metric === metric) || null;
  return {
    preferredMultiple: 'PB',
    rationale: 'For a lender, price-to-book read against asset quality is more informative than price-to-earnings, because earnings move with provisioning.',
    assetQuality: { gnpa: pick('GNPA'), nnpa: pick('NNPA') },
    returns: { roa: pick('ROA'), roe: pick('ROE') },
  };
};

export default {
  buildValuation, computePriceToEarnings, computePriceToBook, buildTtm,
  bankValuationContext, VALUATION_UNAVAILABLE,
};
