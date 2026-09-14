/**
 * validateFinalAnswer - deterministic post-generation audit. No extra
 * model call on the common path (validation here is checkable by rule,
 * not judgement, so an LLM call would be pure added cost/latency — see
 * Phase 11's "do not call the model when deterministic logic suffices").
 * Never blocks/regenerates the answer — flags are recorded as warnings on
 * the persisted message so the composer's behavior stays auditable.
 */

const GUARANTEE_PATTERNS = [
  /\bguaranteed?\s+(returns?|profit|gains?)\b/i,
  /\bwill\s+definitely\s+(rise|fall|grow|increase|decrease)\b/i,
  /\brisk[-\s]?free\b/i,
];

const BUY_SELL_WITHOUT_CONTEXT = /\b(buy|sell)\s+(now|immediately|today)\b/i;

const TIMESTAMP_PATTERN = /\b(\d{1,2}[:.]\d{2}|as of|20\d{2}-\d{2}-\d{2}|\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec))/i;

// Phase 2 item 8 (evidence/section mismatch prevention — deterministic
// detection only, never a repair/regeneration loop; see the module note
// above on why validateFinalAnswer never blocks or regenerates). These two
// checks are mechanically verifiable (presence/absence of a claim TYPE in
// state.evidence), not fuzzy semantic judgement, which is what keeps them
// deterministic and low-false-positive:
//   - NEWS_LANGUAGE: the answer talks about news/headlines/announcements
//     but no COMPANY_NEWS evidence exists at all this turn — the claim
//     structurally cannot be backed by a real news item.
//   - ACHIEVED_LANGUAGE: the answer says a target/guidance was achieved,
//     met, or delivered, but no PROMISE_OUTCOME evidence exists — only a
//     forecast/pending promise (MANAGEMENT_PROMISE/ANALYST_FORECAST) is
//     available, which must never be presented as an actual outcome.
const NEWS_LANGUAGE = /\b(recent news|according to (a |the )?(news|article|report)|news outlets?|headlines?|(has |have )?announced|reported that)\b/i;
const ACHIEVED_LANGUAGE = /\b(achieved|delivered on|met its (target|guidance)|fulfilled|exceeded its (target|guidance))\b/i;

export const validateFinalAnswer = async (state) => {
  if (!state.answer) return {};

  const issues = [];

  if (GUARANTEE_PATTERNS.some((pattern) => pattern.test(state.answer))) {
    issues.push('Answer used guarantee-style language about returns.');
  }
  if (BUY_SELL_WITHOUT_CONTEXT.test(state.answer) && !/risk|evidence|however|consider/i.test(state.answer)) {
    issues.push('Answer gave a directive buy/sell instruction without visible risk/evidence context.');
  }
  if (state.intent === 'LIVE_MARKET_DATA' && state.toolResults.some((t) => t.tool === 'getLiveQuote' && t.status === 'SUCCESS') && !TIMESTAMP_PATTERN.test(state.answer)) {
    issues.push('Live price claim is missing a visible timestamp.');
  }

  const claimTypes = new Set((state.evidence || []).map((e) => e.claimType));
  if (NEWS_LANGUAGE.test(state.answer) && !claimTypes.has('COMPANY_NEWS')) {
    issues.push('Answer references news/announcements with no COMPANY_NEWS evidence backing it this turn.');
  }
  if (ACHIEVED_LANGUAGE.test(state.answer) && !claimTypes.has('PROMISE_OUTCOME')) {
    issues.push('Answer describes a target/guidance as achieved without a verified PROMISE_OUTCOME record — a forecast must never be presented as an actual outcome.');
  }

  return issues.length ? { warnings: [`Response validation flagged: ${issues.join(' ')}`] } : {};
};

export default validateFinalAnswer;
