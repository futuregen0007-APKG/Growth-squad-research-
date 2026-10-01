/**
 * CompanyFinancialsExplainService - optional AI explanation of an
 * already-fetched, already-normalized set of Upstox financial statement
 * sections. NEVER re-fetches from Upstox: the frontend sends back the
 * sections it already has from /search; if it doesn't, this falls back to
 * reading the SAME short-lived Redis cache UpstoxProvider already wrote
 * (UpstoxProvider.getCachedStatementsOnly), never a fresh upstream call.
 *
 * Grounding is enforced the same way ManagementPromiseService.
 * searchManagementExplanation() validates its own OpenAI output against a
 * known-good source set (there: real article URLs; here: real numeric
 * values actually present in the normalized sections) -- any observation
 * citing a number that isn't in that set gets the WHOLE explanation
 * rejected rather than partially trusted.
 *
 * A failed/slow/not-configured OpenAI call degrades to
 * `{ available: false, reason }`, HTTP 200 from the caller -- this must
 * never block or error the figures the search endpoint already returned.
 */
import { resolveCompanyForFinancials } from './CompanyFinancialsResolver.js';
import { getUpstoxProvider } from './CompanyFinancialsSearchService.js';
import { OpenAIClientFactory, LLM_CONFIG } from '../llm/OpenAIClientFactory.js';
import { mapOpenAIError } from '../llm/errors.js';
import { logger } from '../utils/logger.js';

const EXPLAIN_TIMEOUT_MS = 20000;

const round2 = (value) => Math.round(Number(value) * 100) / 100;

/**
 * Pulls a minimal {label, financialYear, value, changePct, verifiedLabel?,
 * verifiedDefinition?}[] digest out of one normalized statement section --
 * the ONLY place prompt values come from. verifiedLabel/verifiedDefinition
 * are only ever present on income-statement metrics (UpstoxNormalizer only
 * annotates those); they're included here verbatim, never recomputed, so
 * the model sees exactly which labels are verified vs provider-reported-only.
 */
const statementDigest = (section) => {
  if (!section?.metrics?.length) return [];
  return section.metrics
    .filter((m) => m.value !== null)
    .map((m) => ({
      label: m.label,
      financialYear: m.financialYear,
      value: m.value,
      changePct: m.changePct,
      ...(m.verifiedLabel ? { verifiedLabel: m.verifiedLabel } : {}),
      ...(m.verifiedDefinition ? { verifiedDefinition: m.verifiedDefinition } : {}),
    }));
};

const ratiosDigest = (section) => {
  if (!section?.ratios?.length) return [];
  return section.ratios
    .filter((r) => r.companyValue !== null || r.sectorValue !== null)
    .map((r) => ({ name: r.name, companyValue: r.companyValue, sectorValue: r.sectorValue }));
};

/** statementSectionDigest - wraps statementDigest with the section's own statementType tag (e.g. "CONSOLIDATED"), so the model always knows which statement basis a metric came from and can echo it back for grounding. `null` when the section itself is unavailable, never a guessed default. */
const statementSectionDigest = (section) => (section ? { statementType: section.statementType || null, metrics: statementDigest(section) } : null);

/**
 * buildDigest - EVERY number in here is copied verbatim from `sections`
 * (the normalized Upstox output already fetched) -- nothing here is
 * computed, estimated, or looked up elsewhere. This is what makes grounded
 * validation possible: the prompt can never contain a figure that isn't
 * also indexable by buildSourceIndex below.
 */
const buildDigest = (sections) => ({
  profile: sections?.profile ? { sector: sections.profile.sector || null, companyProfile: sections.profile.companyProfile || null } : null,
  balanceSheet: statementSectionDigest(sections?.balanceSheet),
  cashFlow: statementSectionDigest(sections?.cashFlow),
  incomeStatement: statementSectionDigest(sections?.incomeStatement),
  keyRatios: ratiosDigest(sections?.keyRatios),
});

/** buildExplainPrompt - the prompt-building function under test: only ever embeds values sourced from `sections` via buildDigest, never anything else. */
export const buildExplainPrompt = ({ symbol, companyName, sections }) => {
  const digest = buildDigest(sections);
  const missing = Object.entries(sections || {})
    .filter(([, value]) => !value)
    .map(([key]) => key);

  return `You are explaining ${companyName || symbol}'s (${symbol}) recently fetched financial statements to a retail investor. All figures are sourced from Upstox and reported in INR Crore unless a ratio (unitless).

RULES:
1. Use ONLY the figures in DATA below. Every numeric statement you make must restate a value that appears verbatim in DATA, tagged with the exact label and financial year (or ratio name) it came from.
2. NEVER invent a number, a financial year, or a trend that cannot be read directly from two DATA values.
3. If a section below is null, say so plainly in missingSectionsNote -- do not guess or fill the gap with outside knowledge.
4. Distinguish an observed fact ("revenue was X in FY2026") from interpretation ("this suggests...") -- interpretation is welcome but must still be grounded in a cited DATA value.
5. This is not investment advice -- never issue a buy/sell/hold recommendation.
6. incomeStatement metrics may carry a "verifiedLabel" that was cross-checked against Upstox's own detailed line-item breakdown for that exact period (one of "Revenue from operations", "Total income", "Profit before tax", "Profit after tax (consolidated)"). When a metric has a verifiedLabel, you MUST cite it using that EXACT verifiedLabel text as citedLabel (not the raw provider label), and set definitionVerified: true. When a metric has NO verifiedLabel (it is null or absent), cite its raw label as citedLabel, explicitly add the phrase "(Upstox-reported, exact definition not independently verified)" to that observation's statement text, and set definitionVerified: false.
7. "Profit after tax (consolidated)" is the CONSOLIDATED profit-after-tax figure. It may differ from the profit attributable to the parent company's own shareholders where the company has minority/non-controlling interests elsewhere in the group -- you may note this plainly, but NEVER state or imply a specific attributable-to-owners split, since that figure is not present in DATA.

DATA:
${JSON.stringify(digest)}

${missing.length ? `Sections not available this time: ${missing.join(', ')}` : 'All sections were available.'}

Respond with STRICT JSON only, no prose outside the JSON object, in exactly this shape:
{
  "summary": "2-4 sentence plain-English summary, grounded only in DATA",
  "observations": [
    { "statement": "one grounded sentence", "citedLabel": "Total income", "citedFinancialYear": "FY2026", "citedValue": 12345.6, "statementType": "CONSOLIDATED", "definitionVerified": true }
  ],
  "missingSectionsNote": "one sentence naming what's missing, or null if nothing is missing"
}`;
};

/**
 * buildSourceIndex - replaces the old flat "does this number exist
 * ANYWHERE" Set with a proper identity-checked lookup, built from the SAME
 * digest the model was given:
 *   - statementIndex: `${label}|${financialYear}` -> {value, changePct, statementType}
 *     for balanceSheet/cashFlow/incomeStatement metrics. `label` is the
 *     metric's verifiedLabel when it has one, else its raw label -- i.e.
 *     the EXACT string the model was instructed to cite, so a verified
 *     metric can only be grounded under its verified name, never its raw
 *     provider label.
 *   - ratioIndex: `name` -> {value} for keyRatios (no financial year).
 * This is what closes the old bug: previously a citedValue was checked
 * against a flat Set of every number anywhere in the data, so a REAL
 * number (e.g. TCS's real total_asset) cited under a WRONG label (e.g.
 * "revenue") still passed, because the set only tracked values, never
 * which label/period/statement they actually belonged to. Resolving by
 * (label, financialYear) FIRST and only then comparing the value closes
 * that gap.
 */
const buildSourceIndex = (sections) => {
  const statementIndex = new Map();
  for (const key of ['balanceSheet', 'cashFlow', 'incomeStatement']) {
    const section = sections?.[key];
    if (!section) continue;
    const statementType = section.statementType || null;
    for (const metric of statementDigest(section)) {
      const labelKey = metric.verifiedLabel || metric.label;
      if (labelKey == null || metric.financialYear == null || metric.value == null) continue;
      statementIndex.set(`${labelKey}|${metric.financialYear}`, {
        value: metric.value, changePct: metric.changePct, statementType,
      });
    }
  }
  const ratioIndex = new Map();
  for (const ratio of ratiosDigest(sections?.keyRatios)) {
    if (ratio.name == null || ratio.companyValue == null) continue;
    ratioIndex.set(ratio.name, { value: ratio.companyValue, statementType: null });
  }
  return { statementIndex, ratioIndex };
};

/**
 * validateGroundedExplanation - the caller-side check that makes it
 * impossible for an AI explanation to survive citing a number that was
 * never actually fetched UNDER THE LABEL/PERIOD/STATEMENT-BASIS it claims.
 * Mirrors searchManagementExplanation's validate-against-a-known-good-set
 * idiom in ManagementPromiseService.js, but checks metric identity (label +
 * period, and statement basis when echoed), not just numeric existence.
 */
export const validateGroundedExplanation = (parsed, sections) => {
  if (!parsed || typeof parsed.summary !== 'string' || !parsed.summary.trim()) {
    return { valid: false, reason: 'Model returned no usable summary.' };
  }
  const observations = Array.isArray(parsed.observations) ? parsed.observations : [];
  const { statementIndex, ratioIndex } = buildSourceIndex(sections);
  for (const observation of observations) {
    if (observation?.citedValue === null || observation?.citedValue === undefined) continue; // a purely qualitative observation cites no number -- nothing to ground
    const citedValue = Number(observation.citedValue);
    if (!Number.isFinite(citedValue)) {
      return {
        valid: false,
        reason: `Observation cites a non-numeric value (${observation.citedValue}).`,
        ungroundedObservation: observation,
      };
    }
    const citedLabel = observation?.citedLabel != null ? String(observation.citedLabel) : null;
    const citedFinancialYear = observation?.citedFinancialYear != null ? String(observation.citedFinancialYear) : null;

    // Resolve the SPECIFIC metric this observation claims to cite -- by
    // label+period first (statements), falling back to label-only (ratios,
    // which carry no financial year) -- never by value alone.
    let entry = null;
    if (citedLabel && citedFinancialYear) entry = statementIndex.get(`${citedLabel}|${citedFinancialYear}`) || null;
    if (!entry && citedLabel) entry = ratioIndex.get(citedLabel) || null;

    if (!entry) {
      return {
        valid: false,
        reason: `Observation cites "${citedLabel}" for ${citedFinancialYear || 'an unspecified period'}, which does not match any metric label/period actually present in the fetched Upstox data.`,
        ungroundedObservation: observation,
      };
    }

    const roundedCited = round2(citedValue);
    const valueMatches = roundedCited === round2(entry.value)
      || (entry.changePct != null && roundedCited === round2(entry.changePct));
    if (!valueMatches) {
      return {
        valid: false,
        reason: `Observation cites a value (${observation.citedValue}) that does not match the fetched value for "${citedLabel}" in ${citedFinancialYear || 'the cited period'}.`,
        ungroundedObservation: observation,
      };
    }

    if (observation?.statementType != null && entry.statementType != null
      && String(observation.statementType).toUpperCase() !== String(entry.statementType).toUpperCase()) {
      return {
        valid: false,
        reason: `Observation claims statement basis "${observation.statementType}" for "${citedLabel}", but the matched metric is actually ${entry.statementType}.`,
        ungroundedObservation: observation,
      };
    }
  }
  return { valid: true };
};

const hasAnySection = (sections) => Boolean(sections) && Object.values(sections).some(Boolean);

/**
 * explainCompanyFinancials - never throws. `sections` should be the SAME
 * normalized section objects (balanceSheet/cashFlow/incomeStatement/
 * keyRatios/profile) the /search endpoint already returned; when absent,
 * falls back to whatever is still in the short-lived Redis cache for this
 * symbol's ISIN, and NEVER calls Upstox itself either way.
 */
export const explainCompanyFinancials = async (symbol, sections, companyName = null) => {
  const normalizedSymbol = String(symbol || '').trim().toUpperCase();
  if (!normalizedSymbol) return { available: false, reason: 'A company symbol is required.' };

  let effectiveSections = sections && typeof sections === 'object' ? sections : null;
  if (!hasAnySection(effectiveSections)) {
    // Never throws out of explainCompanyFinancials: a DB/Redis hiccup while
    // reconstructing sections from cache must degrade the same as "nothing
    // cached yet", not surface as an unhandled failure to the route.
    try {
      const resolution = await resolveCompanyForFinancials(normalizedSymbol);
      if (resolution.status !== 'RESOLVED') {
        return { available: false, reason: 'No fetched financial data is available for this symbol yet — run a search first.' };
      }
      const provider = getUpstoxProvider();
      effectiveSections = await provider.getCachedStatementsOnly(resolution.isin, { symbol: normalizedSymbol });
      companyName = companyName || resolution.companyName;
    } catch (error) {
      logger.warn(`[CompanyFinancialsExplainService] cache-fallback lookup failed for ${normalizedSymbol}: ${error.message}`);
      return { available: false, reason: 'No fetched financial data is available for this symbol yet — run a search first.' };
    }
  }

  if (!hasAnySection(effectiveSections)) {
    return { available: false, reason: 'No financial data available yet to explain — run a search first.' };
  }

  if (!OpenAIClientFactory.isConfigured()) {
    return { available: false, reason: 'AI explanation is not configured on the server.' };
  }

  const prompt = buildExplainPrompt({ symbol: normalizedSymbol, companyName, sections: effectiveSections });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXPLAIN_TIMEOUT_MS);

  try {
    const client = OpenAIClientFactory.getClient();
    const response = await client.chat.completions.create({
      model: LLM_CONFIG.synthesisModel,
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }],
    }, { signal: controller.signal });

    const parsed = JSON.parse(response.choices?.[0]?.message?.content || '{}');
    const validation = validateGroundedExplanation(parsed, effectiveSections);
    if (!validation.valid) {
      logger.warn(`[CompanyFinancialsExplainService] rejected ungrounded AI explanation for ${normalizedSymbol}: ${validation.reason}`);
      return { available: false, reason: 'AI explanation could not be verified against the fetched data and was withheld.' };
    }

    return {
      available: true,
      summary: parsed.summary,
      observations: Array.isArray(parsed.observations) ? parsed.observations : [],
      missingSectionsNote: parsed.missingSectionsNote || null,
      generatedAt: new Date().toISOString(),
      model: LLM_CONFIG.synthesisModel,
    };
  } catch (error) {
    const timedOut = error?.name === 'APIUserAbortError' || error?.isAbort || controller.signal.aborted;
    if (timedOut) return { available: false, reason: 'AI explanation timed out.' };
    const mapped = mapOpenAIError(error, { operation: 'companyFinancialsExplain' });
    logger.warn(`[CompanyFinancialsExplainService] AI explanation failed for ${normalizedSymbol}: ${mapped.message}`);
    return { available: false, reason: 'AI explanation is temporarily unavailable.' };
  } finally {
    clearTimeout(timer);
  }
};

export default { explainCompanyFinancials, buildExplainPrompt, validateGroundedExplanation };
