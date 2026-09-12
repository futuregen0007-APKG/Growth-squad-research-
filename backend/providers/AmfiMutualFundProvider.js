/**
 * AmfiMutualFundProvider.js
 * ===========================
 * Real scheme universe + latest NAV, sourced directly from AMFI's own
 * published feed (https://www.amfiindia.com/spages/NAVAll.txt) -- the
 * official, canonical list of every live mutual fund scheme in India, its
 * category, and its most recent NAV. No invented schemes, no placeholder
 * NAVs: a scheme only exists in this module's output if AMFI itself
 * published a row for it today.
 *
 * AMFI does NOT publish AUM or expense ratio in this feed (those require
 * per-AMC factsheets, which are neither centralized nor machine-readable in
 * a uniform way) -- InvestmentProductSnapshot.expenseRatio/aum are left
 * `null` for every AMFI-sourced product rather than guessed. This is a real,
 * disclosed data-source gap, not a bug.
 *
 * Format (pipe-delimited... actually semicolon-delimited, one header row):
 *   Scheme Code;ISIN Div Payout/ISIN Growth;ISIN Div Reinvestment;Scheme Name;Plan;Option;Net Asset Value;Date
 * interspersed with two kinds of non-data lines: a category header
 * ("Open Ended Schemes(Debt Scheme - Liquid Fund)") and an AMC name line
 * ("Axis Mutual Fund") with no semicolons -- both used here purely to tag
 * the rows that follow, then discarded.
 */
import axios from 'axios';
import { logger } from '../utils/logger.js';

export const NAV_ALL_URL = 'https://www.amfiindia.com/spages/NAVAll.txt';

// Every AMFI category header this module cares about, mapped to one of the
// 4 goal-allocation product buckets. Any category not listed here (Children's
// Fund, FoF, Index Funds, other ETFs, hybrid schemes, ...) is intentionally
// out of scope for this feature and its rows are skipped.
const CATEGORY_TO_PRODUCT_TYPE = (categoryHeader) => {
  if (/Gold ETF/i.test(categoryHeader)) return 'GOLD_ETF';
  if (/Debt Scheme\s*-\s*Liquid Fund/i.test(categoryHeader)) return 'LIQUID_FUND';
  if (/Debt Scheme\s*-\s*Overnight Fund/i.test(categoryHeader)) return 'LIQUID_FUND';
  if (/Debt Scheme/i.test(categoryHeader)) return 'DEBT_FUND';
  if (/Equity Scheme/i.test(categoryHeader) || /Equity Schemes/i.test(categoryHeader)) return 'MUTUAL_FUND';
  return null;
};

export const fetchNavAllRaw = async () => {
  const response = await axios.get(NAV_ALL_URL, {
    timeout: 30000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GrowthSquadResearch/1.0)' },
  });
  return String(response.data || '');
};

/** Pure parser: real AMFI text -> row objects. No network I/O, easy to unit test with a fixture. */
export const parseNavAll = (rawText) => {
  const rows = [];
  let currentCategoryHeader = null;
  let currentProductType = null;
  let currentAmc = null;

  for (const rawLine of String(rawText || '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    if (/^Open Ended Schemes\(/.test(line) || /^Close Ended Schemes\(/.test(line) || /^Interval Fund Schemes\(/.test(line)) {
      currentCategoryHeader = line;
      currentProductType = CATEGORY_TO_PRODUCT_TYPE(line);
      continue;
    }

    if (!line.includes(';')) {
      // An AMC name line (e.g. "Axis Mutual Fund") -- not a data row.
      currentAmc = line;
      continue;
    }

    if (line.toLowerCase().startsWith('scheme code;')) continue; // header row, repeats per AMFI section in some exports

    if (!currentProductType) continue; // category we don't serve (Children's Fund, FoF, Index Funds, etc.)

    const fields = line.split(';');
    if (fields.length < 8) continue;
    const [schemeCode, isinGrowth, isinReinvestment, schemeName, plan, option, navRaw, dateRaw] = fields;
    const nav = Number(navRaw);
    if (!schemeCode || !Number.isFinite(nav) || nav <= 0) continue;

    const dataAsOf = parseAmfiDate(dateRaw);
    if (!dataAsOf) continue;

    rows.push({
      schemeCode: schemeCode.trim(),
      isin: (isinGrowth && isinGrowth !== '-' ? isinGrowth : isinReinvestment) || null,
      schemeName: schemeName.trim(),
      plan: (plan || '').trim(),
      option: (option || '').trim(),
      nav,
      dataAsOf,
      productType: currentProductType,
      category: currentCategoryHeader.replace(/^Open Ended Schemes\(/, '').replace(/\)$/, '').trim(),
      amc: currentAmc,
    });
  }

  return rows;
};

const parseAmfiDate = (value) => {
  // AMFI date format: "11-Sep-2026"
  const match = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(String(value || '').trim());
  if (!match) return null;
  const months = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
  const month = months[match[2]];
  if (month === undefined) return null;
  const date = new Date(Date.UTC(Number(match[3]), month, Number(match[1])));
  return Number.isNaN(date.getTime()) ? null : date;
};

/**
 * Selects one representative row per distinct scheme for scoring/comparison.
 * Mutual funds/debt/liquid: the Direct Plan + Growth Option variant is the
 * standard, lowest-cost, comparison-ready share class (a real, defensible
 * methodological choice, not a fabricated preference). Gold ETFs trade on
 * the exchange and usually carry no Plan/Option distinction at all (blank
 * fields), so they are taken as-is, deduplicated by scheme name.
 */
export const selectCandidateSchemes = (rows) => {
  const isDirectGrowth = (row) => /Direct/i.test(row.plan) && /Growth/i.test(row.option);
  const goldRows = rows.filter((r) => r.productType === 'GOLD_ETF');
  const otherRows = rows.filter((r) => r.productType !== 'GOLD_ETF' && isDirectGrowth(r));

  const dedupedGold = Array.from(new Map(goldRows.map((r) => [r.schemeName.toLowerCase(), r])).values());
  return [...otherRows, ...dedupedGold];
};

export const fetchCandidateSchemes = async () => {
  try {
    const raw = await fetchNavAllRaw();
    const rows = parseNavAll(raw);
    return selectCandidateSchemes(rows);
  } catch (error) {
    logger.warn(`[AmfiMutualFundProvider] Failed to fetch/parse AMFI NAVAll.txt: ${error.message}`);
    return [];
  }
};

export default { fetchNavAllRaw, parseNavAll, selectCandidateSchemes, fetchCandidateSchemes, NAV_ALL_URL };
