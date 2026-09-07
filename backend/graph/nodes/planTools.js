import { zodResponseFormat } from 'openai/helpers/zod';
import { OpenAIClientFactory, LLM_CONFIG } from '../../llm/OpenAIClientFactory.js';
import { mapOpenAIError } from '../../llm/errors.js';
import { ToolPlanSchema, APPROVED_TOOLS } from '../schemas.js';
import { toolPlanPrompt } from '../prompts/index.js';
import { AUTH_REQUIRED_TOOLS } from '../tools/toolRegistry.js';
import { logger } from '../../utils/logger.js';

export const MAX_TOOL_CALLS_PER_REQUEST = 4;

const DEBT_KEYWORDS = /\bdebt|leverage|borrowing/i;
const NEWS_KEYWORDS = /\bnews|headline|announcement/i;
// Confirmed bug: "Analyse HAL Q2 FY26 results" matched none of these, so
// only getCompanyResearch (profile/keyMetrics/shareholding/corporate
// actions/analyst — never the financials array) was planned for a request
// that is fundamentally about quarterly results. "results"/"earnings"/
// "performance"/"quarter(ly)" are now included, and an explicit fiscal
// period mention (see extractEntities.js's PERIOD_PATTERN) independently
// triggers financials too — a period reference is itself strong evidence
// the user wants a specific reporting period's numbers.
const FINANCIALS_KEYWORDS = /\brevenue|profit|margin|ebitda|pat\b|balance sheet|cash flow|results?\b|earnings|performance|quarterly|\bq[1-4]\b/i;
const PERIOD_MENTIONED = /\bQ[1-4]\s*['’]?\s*FY\s*\d{2,4}\b|\bFY\s*\d{2,4}\b/i;

const wantsFinancialsSignal = (message, entities) => FINANCIALS_KEYWORDS.test(message) || DEBT_KEYWORDS.test(message)
  || PERIOD_MENTIONED.test(message) || Boolean(entities?.periods?.length);

/**
 * deterministicPlan - maps intent (+ resolved entities) to a tool plan
 * without a model call for the common cases (Phase 11: "do not call the
 * main model when deterministic logic is sufficient"). Returns null when
 * the case is ambiguous enough to need the LLM planner (e.g. COMPANY_
 * RESEARCH with no resolved symbol at all — the model gets one more
 * chance to see if it can infer one from context; if not, executeTools
 * will simply have nothing to do and composeAnswer explains that).
 */
const deterministicPlan = (intent, entities, message) => {
  const symbols = (entities.symbols || []).slice(0, 3);
  const primary = symbols[0];

  switch (intent) {
    case 'GENERAL_EDUCATION':
    case 'UNSUPPORTED':
      return [];

    case 'WATCHLIST_ANALYSIS':
      return [{ tool: 'getWatchlist', args: {} }];

    case 'PORTFOLIO_ANALYSIS':
      return [{ tool: 'getPortfolio', args: {} }];

    case 'LIVE_MARKET_DATA':
      return primary ? symbols.map((symbol) => ({ tool: 'getLiveQuote', args: { symbol } })) : null;

    case 'NEWS_RESEARCH':
      return primary ? [{ tool: 'getCompanyNews', args: { symbol: primary } }] : null;

    case 'DOCUMENT_RESEARCH':
      return primary ? [{ tool: 'searchResearchDocuments', args: { symbol: primary } }] : null;

    // EARNINGS_INTELLIGENCE queries a specific reporting period ("Q2 FY26
    // results") almost always also want the actual reported numbers, not
    // just management-promise tracking — getEarningsTimeline alone found
    // nothing for HAL (no seeded/real promise data exists for it) even
    // though real IndianAPI financials for HAL do exist, confirmed by
    // manual testing. Both tools run in parallel; a company with no
    // Earnings Intelligence history still gets an honest financials-based
    // answer instead of "no evidence" when the numbers were available all
    // along under a different tool.
    case 'EARNINGS_INTELLIGENCE': {
      if (!primary) return null;
      const wantsFinancials = wantsFinancialsSignal(message, entities);
      return wantsFinancials
        ? [{ tool: 'getEarningsTimeline', args: { symbol: primary } }, { tool: 'getCompanyFinancials', args: { symbol: primary } }]
        : [{ tool: 'getEarningsTimeline', args: { symbol: primary } }];
    }

    case 'STOCK_COMPARISON':
      return symbols.length >= 2 ? [{ tool: 'compareStocks', args: { symbols } }] : null;

    case 'COMPANY_RESEARCH': {
      if (!primary) return null;
      const wantsFinancials = wantsFinancialsSignal(message, entities);
      return wantsFinancials
        ? [{ tool: 'getCompanyFinancials', args: { symbol: primary } }, { tool: 'getCompanyResearch', args: { symbol: primary } }]
        : [{ tool: 'getCompanyResearch', args: { symbol: primary } }];
    }

    case 'FOLLOW_UP': {
      if (!primary) return null;
      if (wantsFinancialsSignal(message, entities)) {
        return [{ tool: 'getCompanyFinancials', args: { symbol: primary } }];
      }
      if (NEWS_KEYWORDS.test(message)) {
        return [{ tool: 'getCompanyNews', args: { symbol: primary } }];
      }
      if (/\bpromise|guidance|earnings|reliability/i.test(message)) {
        return [{ tool: 'getEarningsTimeline', args: { symbol: primary } }];
      }
      return [{ tool: 'getCompanyResearch', args: { symbol: primary } }];
    }

    default:
      return null;
  }
};

/** Removes tools requiring authentication when there's no userId — never silently executed, always explained via a warning. */
const enforceAuth = (plan, userId, warnings) => {
  if (userId) return plan;
  const stripped = plan.filter((step) => !AUTH_REQUIRED_TOOLS.includes(step.tool));
  if (stripped.length !== plan.length) {
    warnings.push('Sign in to let GS Copilot look at your watchlist or portfolio.');
  }
  return stripped;
};

const enforceApprovedTools = (plan) => plan.filter((step) => APPROVED_TOOLS.includes(step.tool));

export const planTools = async (state) => {
  if (state.errors.length) return {};
  const lastMessage = state.messages[state.messages.length - 1];
  const text = String(lastMessage?.content || '');
  const warnings = [];

  let plan = deterministicPlan(state.intent, state.entities, text);

  if (plan === null) {
    if (!OpenAIClientFactory.isConfigured()) {
      plan = [];
    } else {
      try {
        const client = OpenAIClientFactory.getClient();
        const response = await client.chat.completions.parse({
          model: LLM_CONFIG.chatModel,
          temperature: 0,
          max_tokens: 400,
          messages: [{ role: 'user', content: toolPlanPrompt(text, state.intent, state.entities) }],
          response_format: zodResponseFormat(ToolPlanSchema, 'tool_plan'),
        });
        const parsed = response.choices?.[0]?.message?.parsed;
        // Strip the schema's nullable placeholders down to the fields a
        // tool actually got — see schemas.js's ToolArgsSchema note on why
        // args can't be a free-form map under OpenAI strict mode.
        plan = (parsed?.tools || []).map((t) => ({
          tool: t.tool,
          args: Object.fromEntries(Object.entries(t.args || {}).filter(([, v]) => v !== null)),
        }));
      } catch (error) {
        const mapped = mapOpenAIError(error, { operation: 'planTools' });
        logger.warn(`[Graph] planTools LLM fallback failed: ${mapped.message}`);
        plan = [];
      }
    }
  }

  plan = enforceApprovedTools(plan);
  plan = enforceAuth(plan, state.userId, warnings);
  if (plan.length > MAX_TOOL_CALLS_PER_REQUEST) {
    warnings.push(`Limited tool usage to ${MAX_TOOL_CALLS_PER_REQUEST} calls for this request.`);
    plan = plan.slice(0, MAX_TOOL_CALLS_PER_REQUEST);
  }

  return { toolPlan: plan, warnings };
};

export default planTools;
