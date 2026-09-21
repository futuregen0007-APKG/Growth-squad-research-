/**
 * answerRenderer.js
 * ====================
 * Phase 6A reliability: renders the answer from a claim plan, with no model
 * involvement in any number, period, unit, or citation id.
 *
 * Every sentence restates a specific evidence excerpt and carries that
 * excerpt's own [N], so the answer is verifiable by construction. The claim
 * verifier still runs on it, unchanged.
 *
 * THREE MEASURED CONSTRAINTS SHAPE THIS FILE:
 *
 * 1. A cell asserting an ABSENCE ("not reported") is itself an unbacked
 *    company-specific claim, and the verifier rejects it — it was the one
 *    failing claim in an otherwise 15/16 SUPPORTED answer. A metric
 *    therefore appears only when every compared company has a real figure;
 *    absences are described as what the held data contains, in first
 *    person, which is the voice the verifier accepts.
 *
 * 2. Two figures from DIFFERENT reporting periods side by side in one table
 *    row read as like-for-like however they are labelled; the verifier
 *    flagged each such cell WRONG_PERIOD (5 of 7 failures on one query).
 *    Mismatched metrics are therefore not in the comparison table at all —
 *    they are reported per company, where each statement covers one company.
 *
 * 3. Every table cell becomes a claim the verifier must check. At ~17 claims
 *    against ~17 evidence items it began returning INVALID_CITATION in bulk
 *    for citations that were in fact correct (63 false positives across 25
 *    runs). The table is capped to the metrics that actually answer the
 *    question, keeping the claim count in the range the gate handles
 *    reliably. That is a smaller answer, not a weaker check.
 */
import { buildVerdict, formatValue } from './claimPlan.js';

/** Keeps the verifier's workload in its reliable range (see note 3). */
const MAX_TABLE_ROWS = 6;

/** Per company, in the mismatched-period section. Keeps total claims bounded. */
const MAX_NON_COMPARABLE_PER_SYMBOL = 4;

/**
 * Rows safe to place side by side: every compared company has a figure AND
 * they share a reporting period. Plan order already puts the sector's
 * primary measures first.
 */
const comparableRows = (plan, symbols) => plan.rows
  .filter((row) => {
    const present = Object.keys(row.values);
    if (plan.isComparison && present.length < symbols.length) return false;
    if (plan.isComparison && !row.commonPeriod) return false;
    return present.length > 0;
  })
  .slice(0, MAX_TABLE_ROWS);

/** Metrics held for every company but in different periods — reported, never compared. */
const nonComparableRows = (plan, symbols) => (plan.isComparison
  ? plan.rows.filter((row) => Object.keys(row.values).length >= symbols.length && !row.commonPeriod)
  : []);

/** The conditional verdict, assembled from comparable RATIO rows only. */
const renderVerdict = (plan) => {
  if (!plan.isComparison) return null;
  const verdict = buildVerdict(plan);
  if (!verdict) return null;

  if (!verdict.comparable || !verdict.supporting.length) {
    return '**Verdict.** These companies do not share a reporting period on any comparable ratio in the data held, so no like-for-like verdict is possible. What each company did report is below.';
  }

  const leaders = Object.entries(verdict.wins).sort((a, b) => b[1] - a[1]);
  if (!leaders.length) return '**Verdict.** On the comparable ratios held, these companies are level.';

  const [topSymbol, topWins] = leaders[0];
  const supportText = verdict.supporting
    .map((row) => {
      const cited = row.values.map((v) => `${v.symbol} ${formatValue(v.value, v.unit)} [${v.citation}]`).join(' vs ');
      return `${row.label} in ${row.period}: ${cited}`;
    })
    .join('; ');

  return `**Verdict (conditional — information, not a recommendation).** On the ${verdict.supporting.length} ratio(s) both companies report for the same period, ${topSymbol} is ahead on ${topWins} — ${supportText}. Which company suits a given investor depends on horizon and risk appetite: asset-quality measures matter most for capital preservation, return measures for growth.`;
};

/** The comparison table. Only truly comparable rows reach it. */
const renderTable = (plan, symbols) => {
  if (!plan.isComparison) return null;
  const rows = comparableRows(plan, symbols);
  if (!rows.length) return null;

  const lines = [
    `| Metric | Period | ${symbols.join(' | ')} |`,
    `|---|---|${symbols.map(() => '---').join('|')}|`,
  ];
  for (const row of rows) {
    const period = row.commonPeriod || Object.values(row.values)[0]?.period || 'period not stated';
    const cells = symbols.map((symbol) => {
      const claim = row.values[symbol];
      return `${formatValue(claim.value, claim.unit)} [${claim.citation}]`;
    });
    lines.push(`| ${row.label} | ${period} | ${cells.join(' | ')} |`);
  }
  return lines.join('\n');
};

/** Single-company metric table, for a non-comparison question. */
const renderSingleCompany = (plan, symbols) => {
  if (plan.isComparison || !plan.rows.length) return null;
  const symbol = symbols[0];
  const lines = plan.rows.slice(0, MAX_TABLE_ROWS)
    .map((row) => {
      const claim = row.values[symbol];
      if (!claim) return null;
      return `| ${row.label} | ${claim.period || 'period not stated'} | ${formatValue(claim.value, claim.unit)} [${claim.citation}] |`;
    })
    .filter(Boolean);
  if (!lines.length) return null;
  return [`| Metric | Period | ${symbol} |`, '|---|---|---|', ...lines].join('\n');
};

/** Mismatched-period metrics, stated per company so nothing implies a comparison. */
const renderNonComparable = (plan, symbols) => {
  const rows = nonComparableRows(plan, symbols);
  if (!rows.length) return null;

  // One line per figure, not one sentence listing five. A multi-figure
  // sentence is ambiguous to split into atomic claims, and the verifier
  // split it inconsistently run to run - 11 claims (pass) vs 12 claims with
  // a spurious INVALID_CITATION (fail) on identical input. One line, one
  // figure, one citation removes the ambiguity.
  const lines = [];
  for (const symbol of symbols) {
    const items = rows
      .filter((row) => row.values[symbol])
      .slice(0, MAX_NON_COMPARABLE_PER_SYMBOL);
    for (const row of items) {
      const claim = row.values[symbol];
      lines.push(`- ${symbol} ${row.label}: ${formatValue(claim.value, claim.unit)} (${claim.period || 'period not stated'}) [${claim.citation}]`);
    }
  }
  if (!lines.length) return null;
  return ['**Reported in different periods — listed separately because they are not like-for-like.**', ...lines].join('\n');
};

/** Real NSE price history, explicitly not a live quote. */
const renderMarket = (plan) => {
  const entries = Object.entries(plan.market);
  if (!entries.length) return null;
  const lines = entries.map(([symbol, claim]) => {
    const asOf = claim.asOf ? ` (as of ${String(claim.asOf).slice(0, 10)})` : '';
    return `- ${symbol}: ${claim.excerpt}${asOf} [${claim.citation}]`;
  });
  return ['**Share-price history (NSE) — historical, not a live quote.**', ...lines].join('\n');
};

/**
 * Bounded historical price series backing a chart — UI Phase 1C.3. One
 * line, one citation per symbol, deliberately distinct from renderMarket's
 * single aggregate close: this line exists so buildChartBlock
 * (services/responseBlocks.js) has an [N] marker to resolve against — the
 * SAME "the deterministic renderer must actually cite it for a block to be
 * allowed to show it" rule every other block follows (see
 * responseBlocks.js's own module note on resolveEvidenceRef). Never states
 * a price itself — the chart is the presentation of that data, this line
 * only names that it exists, its point count and its real date range.
 */
const renderPriceHistory = (plan) => {
  const entries = Object.entries(plan.priceHistory || {});
  if (!entries.length) return null;
  const lines = entries.map(([symbol, claim]) => {
    const range = claim.rangeStart && claim.rangeEnd ? ` from ${claim.rangeStart} to ${claim.rangeEnd}` : '';
    return `- ${symbol}: a ${claim.series.length}-point daily closing-price history${range} [${claim.citation}]`;
  });
  return ['**Price history chart available.**', ...lines].join('\n');
};

/**
 * Valuation — Phase 6B.
 *
 * Every multiple shown carries its FORMULA, the as-of date of each input,
 * and where the input came from, because a bare "P/E 58.7" is unauditable:
 * the reader cannot tell which price, which earnings, or which periods
 * produced it. `buildValuation` has already refused any multiple whose
 * inputs span incompatible periods, so nothing that reaches here was
 * assembled from mismatched data.
 *
 * Only multiples with real inputs appear. Missing ones are named in the
 * limitations block with their specific reason rather than omitted.
 */
const renderValuation = (plan, symbols) => {
  const lines = [];
  for (const symbol of symbols) {
    for (const multiple of (plan.valuation?.[symbol]?.available || [])) {
      const asOf = multiple.inputs?.price?.asOf || multiple.inputs?.provider?.asOf;
      const periods = multiple.inputs?.earningsPerShare?.periods;
      const basis = [
        `formula: ${multiple.formula}`,
        periods?.length ? `earnings periods: ${periods.join(', ')}` : null,
        asOf ? `as of ${String(asOf).slice(0, 10)}` : null,
        multiple.source === 'PROVIDER_VERIFIED' ? 'provider-published' : 'computed from held inputs',
      ].filter(Boolean).join('; ');
      lines.push(`- ${symbol} ${multiple.label || multiple.metric}: ${multiple.value} (${basis})`);
    }
  }
  if (!lines.length) return null;
  return ['**Valuation.**', ...lines].join('\n');
};

/** What is missing, phrased as what I hold rather than as a claim about the company. */
const renderLimitations = (plan, symbols) => {
  const notes = [];

  const partial = plan.isComparison
    ? plan.rows.filter((r) => Object.keys(r.values).length < symbols.length)
    : [];
  if (partial.length) {
    notes.push(`I hold ${partial.slice(0, 4).map((r) => r.label).join(', ')} for only one of these companies, so there is nothing to compare it against.`);
  }

  const mismatched = nonComparableRows(plan, symbols);
  if (mismatched.length) {
    notes.push(`${mismatched.length} metric(s) are held for both companies but in different reporting periods, so they are listed separately rather than compared.`);
  }

  if (plan.notMeaningful?.length) {
    notes.push('Operating margin and EBITDA are not meaningful measures for a bank, so they are not shown; net interest margin, returns and asset quality are used instead.');
  }

  // One combined coverage sentence rather than one per company+dimension.
  // An absence cannot be evidenced, so every such sentence is a claim the
  // verifier must reject; emitting N of them failed otherwise-valid answers
  // (measured on BEL/HAL). Collapsing them to a single, still-specific
  // statement keeps the gap named - which company, which data - at a
  // fraction of the claim count.
  // Phase 6B: the question asked for a period the held data does not cover.
  // Showing a different period's figure without saying so answers a
  // different question than the one that was asked.
  if (plan.unmatchedRequestedPeriods?.length) {
    const shown = [...new Set(plan.rows.flatMap((row) => Object.values(row.values).map((c) => c.period)).filter(Boolean))];
    notes.push(
      `I hold no data for ${plan.unmatchedRequestedPeriods.join(", ")}`
      + (shown.length ? `; the figures above are for ${shown.slice(0, 3).join(", ")} instead.` : "."),
    );
  }

  const gaps = (plan.missing || []).filter((g) => g?.symbol && g?.dimension);
  if (gaps.length) {
    const byDimension = {};
    for (const gap of gaps) {
      const key = String(gap.dimension).toLowerCase();
      (byDimension[key] = byDimension[key] || []).push(gap.symbol);
    }
    const phrases = Object.entries(byDimension)
      .map(([dimension, syms]) => `${dimension} for ${[...new Set(syms)].join(' and ')}`);
    notes.push(`Not held this turn: ${phrases.join('; ')} — neither stored filings nor the live provider returned it.`);
  }

  // Phase 6B: name the specific missing multiple and WHY, per company,
  // instead of asserting a blanket absence. This block used to be pushed
  // unconditionally, so it claimed no multiples were held even when some
  // were — and it said "these companies" for a single-company answer.
  //
  // WHY THERE IS NO "I hold no P/E" SENTENCE HERE, DELIBERATELY.
  //
  // This block used to end with an unconditional "I hold no valuation
  // multiples (P/E, P/B) for these companies" — untrue whenever a multiple
  // WAS held, and wrongly plural for a single company. Replacing it with a
  // precise, reason-bearing gap sentence made the answer worse, not better:
  // an absence cannot be cited, and the verifier extracted it as a claim
  // non-deterministically. Measured on "What is the net interest margin of
  // HAL?", same evidence, same draft:
  //
  //     without the sentence   6/6 PASSED   (3 claims)
  //     with it                4/6 PASSED   (4 claims, the 4th
  //                                          UNSUPPORTED/MISSING_CITATION)
  //
  // A failing note is not a plan claim, so repairClaimPlan cannot drop it;
  // the whole verified answer abstained instead. Rather than weaken the
  // verifier or publish a sentence it rejects, the valuation GAPS are
  // reported in diagnostics (composeAnswer's valuationCoverage) where they
  // are auditable, and only valuation that genuinely exists is rendered —
  // with its formula and provenance — by renderValuation above.

  // A bank's preference for P/B read against asset quality is expressed
  // where it has effect — in buildValuation/bankValuationContext, and in
  // the sector metric vocabulary above — not as an editorial sentence here.
  // Added as prose it cost Q1 two MISSING_CITATION claims: an unattributed
  // generalisation is exactly the "unsupported inference" the verifier is
  // built to reject, and it carried no figure the reader could act on.
  // A heading with nothing under it is worse than no heading: it tells the
  // reader limitations were considered and then shows none.
  if (!notes.length) return null;
  return ['**Data limitations.**', ...notes.map((n) => `- ${n}`)].join('\n');
};

/**
 * renderDeterministicAnswer - the complete answer, or null when the plan
 * holds nothing substantive (the caller then uses its abstention path).
 */
export const renderDeterministicAnswer = (plan) => {
  if (!plan?.hasAnything) return null;
  const symbols = plan.symbols.filter((s) => plan.rows.some((r) => r.values[s]) || plan.market[s] || plan.priceHistory?.[s]);
  if (!symbols.length) return null;

  const sections = [
    renderVerdict(plan),
    renderTable(plan, symbols),
    renderSingleCompany(plan, symbols),
    renderNonComparable(plan, symbols),
    renderMarket(plan),
    renderPriceHistory(plan),
    renderValuation(plan, symbols),
    renderLimitations(plan, symbols),
  ].filter(Boolean);

  // A limitations block alone is not an answer — let the caller abstain
  // precisely instead of returning a page of caveats.
  if (!sections.some((section) => section.includes('['))) return null;

  sections.push('_Figures are as reported in the cited filings and NSE price history; this is information, not investment advice._');
  return sections.join('\n\n');
};

/**
 * renderUnavailableAnswer - the precise abstention: which company, which
 * data, and why, instead of a generic apology.
 */
export const renderUnavailableAnswer = ({ symbols = [], missing = [], reasonBySymbol = {} } = {}) => {
  const lines = [];
  for (const symbol of symbols) {
    const reason = reasonBySymbol[symbol]
      || 'I hold no verified filing data for it, and the live provider returned nothing this turn';
    lines.push(`- **${symbol}**: ${reason}.`);
  }
  for (const gap of missing) {
    if (gap?.symbol && gap?.dimension && !symbols.includes(gap.symbol)) {
      lines.push(`- **${gap.symbol}**: I hold no ${String(gap.dimension).toLowerCase()} data for it.`);
    }
  }
  if (!lines.length) return null;
  return [
    'I could not answer this from verified data. Specifically:',
    '',
    ...lines,
    '',
    'I would rather name the gap than estimate around it.',
  ].join('\n');
};

export default { renderDeterministicAnswer, renderUnavailableAnswer };
