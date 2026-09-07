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

  return issues.length ? { warnings: [`Response validation flagged: ${issues.join(' ')}`] } : {};
};

export default validateFinalAnswer;
