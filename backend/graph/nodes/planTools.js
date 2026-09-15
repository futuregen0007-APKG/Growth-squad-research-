import { OpenAIClientFactory, LLM_CONFIG } from '../../llm/OpenAIClientFactory.js';
import { ToolPlanSchema, APPROVED_TOOLS } from '../schemas.js';
import { toolPlanPrompt } from '../prompts/index.js';
import { AUTH_REQUIRED_TOOLS } from '../tools/toolRegistry.js';
import { DEFAULT_COMPARISON_DIMENSIONS } from '../dimensions.js';
import { invokeRoutingModel } from '../llmInvoke.js';
import { resolveResearchScope } from '../researchScope.js';
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
const deterministicPlan = (intent, entities, message, requestedDimensions) => {
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

    // Phase 4B: DOCUMENT_RESEARCH is grounded RAG's own intent — routed
    // through resolveResearchScope (graph/researchScope.js, pure/
    // deterministic, never an LLM call) rather than the LLM-planning
    // fallback below, exactly so "never guess an ambiguous company" is
    // enforced HERE rather than left to a model's discretion. An
    // ambiguous/unresolved company returns an EMPTY plan (never a
    // substitute company) — composeAnswer.js's grounded branch recomputes
    // the same scope and responds with a clarification request instead of
    // fabricating an answer with no evidence.
    case 'DOCUMENT_RESEARCH': {
      const scope = resolveResearchScope({ text: message, entities, intent });
      if (scope.ambiguousCompany || !scope.symbol) return [];
      return [{
        tool: 'retrieveGroundedEvidence',
        args: {
          symbol: scope.symbol, fiscalYear: scope.fiscalYear, fiscalQuarter: scope.fiscalQuarter, query: message,
        },
      }];
    }

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

    // Phase 2 canonical comparison planning: ONE compareStocks step,
    // carrying the requested dimensions through — never a separate
    // top-level getCompanyFinancials/getCompanyNews call alongside it (the
    // confirmed regression: comparison planning duplicated financial
    // calls and omitted requested news). compareStocks itself now fans
    // out ONLY to these dimensions — see toolRegistry.js.
    case 'STOCK_COMPARISON':
      return symbols.length >= 2
        ? [{ tool: 'compareStocks', args: { symbols, dimensions: requestedDimensions?.length ? requestedDimensions : [...DEFAULT_COMPARISON_DIMENSIONS] } }]
        : null;

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

/**
 * groundedResearchPlan - Phase 4C Part 4/5: builds the tool plan for a
 * turn resolveResearchScope has already decided needs the grounded
 * corpus, REGARDLESS of what intent classifyIntent.js assigned (see
 * researchScope.js's module note on why intent alone is unsafe to gate
 * on). Never guesses an ambiguous company (returns []); when
 * scope.mergeEarningsIntelligence is true (guidance/revised-guidance/
 * promise-vs-outcome questions), also plans getEarningsTimeline
 * alongside retrieveGroundedEvidence — executeTools.js normalizes its
 * structured promise/outcome data into the SAME trusted evidence
 * envelope (Part 5), so there is still only ONE grounded generation call
 * over the combined evidence, never two competing answers (Part 6).
 * getEarningsTimeline's own timeline/cards data is completely unaffected
 * elsewhere (Part 3) — this only adds one more parallel call in the
 * chat's tool plan, exactly like EARNINGS_INTELLIGENCE's existing case
 * below already runs it.
 */
const groundedResearchPlan = (scope, text) => {
  if (scope.ambiguousCompany || !scope.symbol) return [];
  const plan = [{
    tool: 'retrieveGroundedEvidence',
    args: {
      symbol: scope.symbol, fiscalYear: scope.fiscalYear, fiscalQuarter: scope.fiscalQuarter, query: text,
    },
  }];
  if (scope.mergeEarningsIntelligence) {
    plan.push({ tool: 'getEarningsTimeline', args: { symbol: scope.symbol } });
  }
  return plan;
};

export const planTools = async (state) => {
  if (state.errors.length) return {};
  const lastMessage = state.messages[state.messages.length - 1];
  const text = String(lastMessage?.content || '');
  const warnings = [];

  // Phase 4C: checked BEFORE the intent-keyed switch below — a "guidance"/
  // "promise"/"document" question is routed into the grounded RAG flow
  // independent of whatever intent label classifyIntent.js assigned (the
  // root cause this phase fixes; see researchScope.js). Every other
  // question (normal stock data, live price, watchlist, a genuine
  // multi-company comparison, ...) falls through to the EXISTING,
  // UNCHANGED deterministicPlan switch exactly as before.
  const scope = resolveResearchScope({ text, entities: state.entities, intent: state.intent });
  let plan = scope.needsResearchCorpus
    ? groundedResearchPlan(scope, text)
    : deterministicPlan(state.intent, state.entities, text, state.requestedDimensions);
  const llmCalls = [];

  if (plan === null) {
    if (!OpenAIClientFactory.isConfigured()) {
      plan = [];
    } else {
      const { parsed, error, diagnostic } = await invokeRoutingModel({
        node: 'planTools',
        model: LLM_CONFIG.routingModel,
        maxTokens: 400,
        schema: ToolPlanSchema,
        schemaName: 'tool_plan',
        prompt: toolPlanPrompt(text, state.intent, state.entities, state.requestedDimensions),
        signal: state.abortSignal,
        deadlineAt: state.deadlineAt,
      });
      llmCalls.push(diagnostic);
      if (parsed) {
        // Strip the schema's nullable placeholders down to the fields a
        // tool actually got — see schemas.js's ToolArgsSchema note on why
        // args can't be a free-form map under OpenAI strict mode.
        plan = (parsed.tools || []).map((t) => ({
          tool: t.tool,
          args: Object.fromEntries(Object.entries(t.args || {}).filter(([, v]) => v !== null)),
        }));
      } else {
        logger.warn(`[Graph] planTools LLM fallback failed: ${error}`);
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

  return { toolPlan: plan, warnings, llmCalls };
};

export default planTools;
