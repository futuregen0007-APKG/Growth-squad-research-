import mongoose from 'mongoose';
import ManagementPromise from '../models/ManagementPromise.js';
import CompanyHistoricalFact, { FACT_CATEGORIES } from '../models/CompanyHistoricalFact.js';
import ResearchRun from '../models/ResearchRun.js';
import { SUPPORTED_STOCKS, FEATURED_SYMBOLS } from '../utils/constants.js';
import { collectDocuments, SOURCE_AUTHORITY, DOCUMENT_TYPES } from '../research/DocumentResearchService.js';
import { getCompanyResearchProfile } from '../research/CompanyResearchProfiles.js';
import {
  calculateCompanyExecutionScore,
  calculateConfidence,
  buildFinancialSnapshot,
  calculateCagr,
  calculateYoY,
  getExecutionRatingLabel
} from './ExecutionScoreService.js';
import openai from './openaiClient.js';
import { logger } from '../utils/logger.js';

const isDbConnected = () => mongoose.connection?.readyState === 1;

const researchJobs = new Map();

const companyFor = (symbol) => {
  const normalized = String(symbol || '').toUpperCase().trim();
  return SUPPORTED_STOCKS[normalized]?.name || normalized;
};

const toDate = (value) => {
  const parsed = value ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
};

// Promise importance weights as defined in specifications
export const IMPORTANCE_WEIGHTS = {
  HIGH: 1.5,
  MEDIUM: 1.0,
  LOW: 0.5
};

// Status scores for deterministic reliability calculation
export const STATUS_SCORE = {
  FULFILLED: 1.0,
  PARTIALLY_FULFILLED: 0.6,
  MISSED: 0.0,
  PENDING: null,
  INSUFFICIENT_EVIDENCE: null
};

/**
 * Deterministic Promise Verification Algorithm
 * Compares target value against actual value based on direction and metric.
 */
export const calculatePromiseStatus = ({ 
  targetValue, 
  actualValue, 
  direction = null, 
  metric = '', 
  metricType = '',
  targetPeriod = '' 
}) => {
  const normMetric = String(metric || metricType || '').toUpperCase().trim();
  
  // Infer direction if not explicitly given
  let resolvedDirection = direction;
  if (!resolvedDirection) {
    if (normMetric === 'DEBT' || normMetric === 'DEBT_REDUCTION' || normMetric.includes('COST')) {
      resolvedDirection = 'LOWER_IS_BETTER';
    } else {
      resolvedDirection = 'HIGHER_IS_BETTER';
    }
  }

  // If actualValue is not provided or targetValue is invalid
  if (actualValue === null || actualValue === undefined || !Number.isFinite(Number(actualValue))) {
    // Check if targetPeriod is in future / ongoing
    const isFutureOrOngoing = targetPeriod && (
      targetPeriod.includes('2026') || 
      targetPeriod.includes('2027') || 
      targetPeriod.includes('FY26') || 
      targetPeriod.includes('FY27')
    );

    if (isFutureOrOngoing) {
      return {
        achievementPercentage: null,
        status: 'PENDING',
        calculationExplanation: `Target period (${targetPeriod}) is ongoing or in the future. Outcome is pending official reporting.`
      };
    }

    return { 
      achievementPercentage: null, 
      status: 'INSUFFICIENT_EVIDENCE', 
      calculationExplanation: 'Cannot calculate achievement: verified actual outcome value is not available in public records.' 
    };
  }

  if (!Number.isFinite(Number(targetValue)) || Number(targetValue) === 0) {
    return {
      achievementPercentage: null,
      status: 'INSUFFICIENT_EVIDENCE',
      calculationExplanation: 'Cannot calculate achievement: target value is invalid or zero.'
    };
  }

  const target = Number(targetValue);
  const actual = Number(actualValue);
  let achievementPercentage;
  let calculationExplanation;

  // Deterministic calculation based on direction
  if (resolvedDirection === 'HIGHER_IS_BETTER') {
    achievementPercentage = Number(((actual / target) * 100).toFixed(2));
    calculationExplanation = `Target: ${target}, Actual: ${actual}. Direction: HIGHER_IS_BETTER. Achievement = (${actual} / ${target}) × 100 = ${achievementPercentage}%.`;
  } else if (resolvedDirection === 'LOWER_IS_BETTER') {
    achievementPercentage = Number(((target / actual) * 100).toFixed(2));
    calculationExplanation = `Target: ${target}, Actual: ${actual}. Direction: lower-is-better comparison. Achievement = (${target} / ${actual}) × 100 = ${achievementPercentage}%.`;
  } else if (resolvedDirection === 'TARGET_RANGE') {
    achievementPercentage = Number(((actual / target) * 100).toFixed(2));
    calculationExplanation = `Target: ${target}, Actual: ${actual}. Direction: TARGET_RANGE. Achievement = ${achievementPercentage}%.`;
  } else {
    achievementPercentage = Number(((actual / target) * 100).toFixed(2));
    calculationExplanation = `Target: ${target}, Actual: ${actual}. Achievement = (${actual} / ${target}) × 100 = ${achievementPercentage}%.`;
  }

  // Deterministic status thresholds
  let status;
  if (achievementPercentage >= 90) {
    status = 'FULFILLED';
  } else if (achievementPercentage >= 60) {
    status = 'PARTIALLY_FULFILLED';
  } else {
    status = 'MISSED';
  }

  return { achievementPercentage, status, calculationExplanation };
};

/**
 * Calculates recency weight based on guidance date
 * Newest = 1.0, Oldest = 0.7
 */
export const recencyWeight = (date) => {
  if (!date) return 0.85;
  const currentYear = new Date().getFullYear();
  const promiseYear = new Date(date).getFullYear();
  const yearsAgo = Math.max(0, currentYear - promiseYear);
  return Math.max(0.7, Number((1 - Math.min(yearsAgo, 3) * 0.1).toFixed(2)));
};

/**
 * Calculates overall management reliability score
 * Requires at least 3 verified promises
 */
export const calculateReliability = (promises = []) => {
  const totalPromises = promises.length;
  const pending = promises.filter((p) => {
    const status = p.verification?.status || p.status;
    return status === 'PENDING';
  }).length;

  const historical = promises.filter((promise) => {
    const status = promise.verification?.status || promise.status;
    return status === 'FULFILLED' || status === 'PARTIALLY_FULFILLED' || status === 'MISSED';
  });

  const fulfilled = historical.filter(p => (p.verification?.status || p.status) === 'FULFILLED').length;
  const partiallyFulfilled = historical.filter(p => (p.verification?.status || p.status) === 'PARTIALLY_FULFILLED').length;
  const missed = historical.filter(p => (p.verification?.status || p.status) === 'MISSED').length;

  // Requirement: at least 3 historical promises have verified outcomes
  if (historical.length < 3) {
    return { 
      score: null, 
      totalPromises, 
      verifiedPromises: historical.length,
      fulfilled, 
      partiallyFulfilled, 
      missed, 
      pending, 
      weightedAchievement: null, 
      trend: 'INSUFFICIENT_DATA', 
      fulfillmentRate: null, 
      averageAchievement: null,
      confidence: historical.length ? Number((historical.length / 3).toFixed(2)) : 0
    };
  }

  let weightedTotal = 0;
  let weightedScore = 0;

  historical.forEach((promise) => {
    const imp = promise.promise?.importance || promise.importance || 'MEDIUM';
    const importanceWeight = IMPORTANCE_WEIGHTS[imp] || 1.0;
    const pDate = promise.promise?.promiseDate || promise.announcementDate || promise.guidanceDate || promise.createdAt;
    const rWeight = recencyWeight(pDate);
    const weight = importanceWeight * rWeight;

    const status = promise.verification?.status || promise.status;
    const scoreVal = STATUS_SCORE[status] != null ? STATUS_SCORE[status] : 0;

    weightedTotal += weight;
    weightedScore += weight * scoreVal;
  });

  const reliabilityScore = Number(((weightedScore / weightedTotal) * 10).toFixed(1));

  // Determine trend by chronological comparison of older vs newer halves
  const ordered = [...historical].sort((a, b) => {
    const dateA = new Date(a.promise?.promiseDate || a.announcementDate || a.createdAt || 0);
    const dateB = new Date(b.promise?.promiseDate || b.announcementDate || b.createdAt || 0);
    return dateA - dateB;
  });

  const midpoint = Math.ceil(ordered.length / 2);
  const firstHalf = ordered.slice(0, midpoint);
  const secondHalf = ordered.slice(midpoint);

  const avgAchievement = (items) => {
    if (!items.length) return 0;
    return items.reduce((sum, item) => {
      const pct = item.verification?.achievementPercentage != null ? item.verification.achievementPercentage : (item.achievementPercentage != null ? item.achievementPercentage : (STATUS_SCORE[item.status] * 100));
      return sum + Number(pct || 0);
    }, 0) / items.length;
  };

  const firstAvg = avgAchievement(firstHalf);
  const secondAvg = avgAchievement(secondHalf);
  const trend = secondHalf.length && secondAvg > firstAvg + 5 ? 'IMPROVING' : secondHalf.length && secondAvg < firstAvg - 5 ? 'DECLINING' : 'STABLE';

  const averageAch = Number(avgAchievement(historical).toFixed(1));
  const fulfillmentRate = Number(((fulfilled / historical.length) * 100).toFixed(1));

  return {
    score: reliabilityScore,
    totalPromises,
    verifiedPromises: historical.length,
    fulfilled,
    partiallyFulfilled,
    missed,
    pending,
    weightedAchievement: Number((weightedScore / weightedTotal).toFixed(2)),
    fulfillmentRate,
    averageAchievement: averageAch,
    trend,
    confidence: Number(Math.min(1.0, 0.6 + (historical.length * 0.08)).toFixed(2))
  };
};

/**
 * Deduplicate facts based on similarity of topic, metric, and period
 */
export const deduplicateFacts = (facts = []) => {
  const seen = new Set();
  const result = [];

  for (const fact of facts) {
    if (!fact.title || !fact.fact) continue;
    const key = `${fact.period || ''}_${fact.category || ''}_${fact.metrics?.metric || ''}_${fact.title.toLowerCase().substring(0, 30)}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(fact);
    }
  }

  return result;
};

/**
 * Fact Extraction Prompt: Extracts structured 3-5 year historical facts from collected documents
 */
const historicalFactsPrompt = (profile, articles) => {
  const sourcesPayload = JSON.stringify(articles.slice(0, 35).map(a => ({
    title: a.title,
    sourceName: a.sourceName,
    sourceUrl: a.sourceUrl,
    sourceDate: a.sourceDate,
    documentType: a.documentType,
    authorityLevel: a.authorityLevel,
    excerpt: a.excerpt
  })));

  return `You are a world-class financial research analyst building a 3-5 year verified historical intelligence profile for ${profile.companyName} (${profile.symbol}).

SECTOR: ${profile.sector}
CORE SECTOR METRICS: ${JSON.stringify(profile.sectorMetrics || [])}

EXTRACTION OBJECTIVES:
Extract ONLY objectively verifiable, factual historical events, financial performance milestones, business achievements, operational developments, and negative developments from the provided documents.

CATEGORIES TO EXTRACT (must be one of):
- FINANCIAL_PERFORMANCE (Revenue, EBITDA, PAT, EPS, Debt, Margins, Cash Flow)
- OPERATIONAL_PERFORMANCE (Capacity utilization, hiring, deal wins, client additions)
- MANAGEMENT_COMMENTARY (Executive statements, strategic vision, outlook commentary)
- STRATEGY (Strategic shifts, partnerships, corporate transformations)
- ORDER_BOOK (Order book size, order inflows, backlog)
- CONTRACT (Major client contracts, multi-year deals)
- PRODUCT (New product launches, SaaS platform updates, approvals)
- EXPANSION (Geographic expansion, new offices/facilities)
- ACQUISITION (M&A, strategic investments, divestments)
- CAPEX (Capital expenditure, manufacturing capacity expansion)
- EARNINGS (Quarterly/annual financial results commentary)
- CORPORATE_ACTION (Dividends, bonus issues, buybacks, stock splits)
- RISK (Negative developments: revenue decline, margin compression, project delays, regulatory penalties, debt surge)
- GUIDANCE (Guidance announcements or revisions)
- OTHER

CRITICAL EXTRACTION RULES:
1. Extract facts across the entire available timeline: FY2021, FY2022, FY2023, FY2024, FY2025, FY2026.
2. DO NOT fabricate numbers, dates, statements, or source URLs.
3. If a fact represents a negative development (e.g. margin drop, missed target, debt rise, loss of customer, project delay), set "isNegative": true.
4. Always link each fact to its exact sourceUrl and provide an exact sourceExcerpt.

Return strictly valid JSON:
{
  "facts": [
    {
      "date": "2024-05-15T00:00:00.000Z",
      "period": "FY2024",
      "category": "FINANCIAL_PERFORMANCE|OPERATIONAL_PERFORMANCE|MANAGEMENT_COMMENTARY|STRATEGY|ORDER_BOOK|CONTRACT|PRODUCT|EXPANSION|ACQUISITION|CAPEX|EARNINGS|CORPORATE_ACTION|RISK|GUIDANCE|OTHER",
      "title": "Clear 4-8 word title of the historical fact",
      "fact": "Exact factual description of what occurred",
      "summary": "Brief 1-sentence analytical context",
      "isNegative": false,
      "metrics": {
        "metric": "REVENUE|EBITDA_MARGIN|PAT|ORDER_BOOK|DEBT|DEAL_WINS|NIM|GNPA|EPS|ROE|ROCE|OTHER",
        "actualValue": 1270,
        "previousValue": 1080,
        "unit": "INR_CRORE|PERCENTAGE|COUNT|USD_MILLION",
        "changePercent": 17.59,
        "currency": "INR"
      },
      "source": {
        "type": "ANNUAL_REPORT|INVESTOR_PRESENTATION|EARNINGS_CALL_TRANSCRIPT|EXCHANGE_FILING|PRESS_RELEASE|FINANCIAL_PUBLICATION|NEWS_ARTICLE",
        "title": "Document title or headline",
        "url": "https://...",
        "publishedAt": "2024-05-15T00:00:00.000Z",
        "excerpt": "Exact excerpt from the source text"
      },
      "confidence": 0.95
    }
  ]
}

Available Sources:
${sourcesPayload}`;
};

/**
 * Extract structured historical facts using LLM
 */
export const extractHistoricalFactsFromSources = async (profile, documents = []) => {
  if (!documents.length) return [];
  if (!openai) {
    logger.warn('[Research] OpenAI client is not initialized.');
    return [];
  }

  try {
    logger.info(`[Research] Extracting structured historical facts from ${documents.length} sources for ${profile.symbol}`);
    const prompt = historicalFactsPrompt(profile, documents);
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      response_format: { type: 'json_object' }
    });

    const content = response.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(content);
    const facts = Array.isArray(parsed.facts) ? parsed.facts : [];
    logger.info(`[Research] Extracted ${facts.length} historical facts for ${profile.symbol}`);
    return facts;
  } catch (error) {
    logger.error(`[Research] Historical facts extraction error for ${profile.symbol}: ${error.message}`);
    return [];
  }
};

/**
 * Stage A Prompt: Extract management guidance statements from collected sources
 */
const promiseExtractionPrompt = (profile, articles) => {
  const sourcesPayload = JSON.stringify(articles.slice(0, 30).map(a => ({
    title: a.title,
    sourceName: a.sourceName,
    sourceUrl: a.sourceUrl,
    sourceDate: a.sourceDate,
    documentType: a.documentType,
    authorityLevel: a.authorityLevel,
    excerpt: a.excerpt
  })));

  return `You are an expert financial analyst extracting explicit, quantifiable management guidance/promises for ${profile.companyName} (${profile.symbol}).

CRITICAL EXTRACTION RULES:
1. Extract ONLY explicit management commitments, targets, or forecasts made by the company leadership.
2. DO NOT extract broker targets, analyst estimates, consensus estimates, or third-party forecasts.
3. Every promise MUST contain an objectively measurable numeric target (e.g. "Order book to reach ₹1,000 Cr", "Revenue growth of 20%", "EBITDA margin of 25%").
4. Extract only statements from the provided sources. Do NOT invent, assume, or hallucinate targets.
5. If targetValue or targetPeriod cannot be determined with certainty, DO NOT extract it.
6. Target years to focus on: FY2021, FY2022, FY2023, FY2024, FY2025, FY2026.

METRIC ENUMS (must be one of):
- REVENUE
- REVENUE_GROWTH
- EBITDA
- EBITDA_MARGIN
- PAT
- PAT_GROWTH
- ORDER_BOOK
- ORDER_INTAKE
- ARR
- BOOKINGS
- CAPEX
- DEBT
- DEBT_REDUCTION
- MARGIN
- MARKET_SHARE
- CUSTOMER_COUNT
- EMPLOYEE_COUNT
- OTHER_QUANTIFIABLE

TARGET UNITS:
- INR_CRORE
- INR_LAKH
- USD_MILLION
- USD_BILLION
- PERCENTAGE
- COUNT
- OTHER

DIRECTION:
- HIGHER_IS_BETTER
- LOWER_IS_BETTER
- TARGET_RANGE

IMPORTANCE:
- HIGH
- MEDIUM
- LOW

Return strictly valid JSON:
{
  "promises": [
    {
      "exactManagementStatement": "Exact quote or specific guidance statement from management",
      "metric": "REVENUE|REVENUE_GROWTH|EBITDA|EBITDA_MARGIN|PAT|PAT_GROWTH|ORDER_BOOK|ORDER_INTAKE|ARR|BOOKINGS|CAPEX|DEBT|DEBT_REDUCTION|MARGIN|MARKET_SHARE|CUSTOMER_COUNT|EMPLOYEE_COUNT|OTHER_QUANTIFIABLE",
      "targetValue": 1000,
      "targetUnit": "INR_CRORE|INR_LAKH|USD_MILLION|USD_BILLION|PERCENTAGE|COUNT|OTHER",
      "targetPeriod": "FY2025",
      "promiseDate": "2023-05-15T00:00:00.000Z",
      "direction": "HIGHER_IS_BETTER|LOWER_IS_BETTER|TARGET_RANGE",
      "importance": "HIGH|MEDIUM|LOW",
      "sourceUrl": "https://...",
      "sourceDate": "2023-05-15T00:00:00.000Z",
      "sourceDocument": "Investor Presentation FY24",
      "sourceExcerpt": "Exact excerpt showing guidance statement and numbers",
      "sourceAuthority": 0.95
    }
  ]
}

Available Sources:
${sourcesPayload}`;
};

/**
 * STAGE A: Extract quantitative promises from collected documents using LLM
 */
export const extractPromisesFromSources = async (profile, documents = []) => {
  if (!documents.length) return [];
  if (!openai) {
    logger.warn('[Research] OpenAI client is not initialized.');
    return [];
  }

  try {
    logger.info(`[Research] Stage A: Extracting management promises from ${documents.length} sources for ${profile.symbol}`);
    const prompt = promiseExtractionPrompt(profile, documents);
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      response_format: { type: 'json_object' }
    });

    const content = response.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(content);
    const promises = Array.isArray(parsed.promises) ? parsed.promises : [];
    logger.info(`[Research] Stage A complete: Extracted ${promises.length} candidate promises for ${profile.symbol}`);
    return promises;
  } catch (error) {
    logger.error(`[Research] Stage A extraction error for ${profile.symbol}: ${error.message}`);
    return [];
  }
};

/**
 * STAGE B: Search for actual reported outcomes for an individual promise
 */
export const searchActualOutcomes = async (profile, promise) => {
  if (!promise.targetPeriod || !promise.metric) {
    logger.warn(`[Research] Cannot search actual outcome: missing targetPeriod or metric for ${profile.symbol}`);
    return null;
  }

  const { getStockNews } = await import('./NewsAPIService.js');
  const targetPeriod = promise.targetPeriod;
  const metric = promise.metric;

  // Check if the target period is in the future
  const isFuture = targetPeriod.includes('FY2026') || targetPeriod.includes('FY2027') || targetPeriod.includes('FY26') || targetPeriod.includes('FY27');
  if (isFuture) {
    return {
      actualValue: null,
      actualPeriod: targetPeriod,
      outcomeStatement: 'Target period is in progress or future; outcome pending.',
      outcomeSource: null,
      outcomeSourceUrl: null,
      outcomeSourceDate: null,
      isPending: true
    };
  }

  logger.info(`[Research] Stage B: Searching actual outcomes for ${profile.symbol} metric ${metric} in ${targetPeriod}`);

  try {
    const outcomeArticles = await getStockNews(profile.symbol, { days: 1825 });
    if (!outcomeArticles.length) return null;

    const outcomePrompt = `You are evaluating whether ${profile.companyName} (${profile.symbol}) published actual financial results for target period ${targetPeriod} regarding ${metric}.

Management Guidance:
- Target: ${promise.targetValue} ${promise.targetUnit}
- Target Period: ${targetPeriod}
- Metric: ${metric}
- Statement: "${promise.exactManagementStatement || promise.statement}"

Articles to examine:
${JSON.stringify(outcomeArticles.slice(0, 25).map(a => ({ title: a.title, description: a.description, url: a.url, publishedAt: a.publishedAt, source: a.source })))}

INSTRUCTIONS:
1. Search the articles for the ACTUAL REPORTED result for ${targetPeriod} (e.g. actual revenue, actual order book, actual EBITDA, actual margin achieved).
2. If the actual reported number is found, return actualValue as a number.
3. If not found in the provided articles, set actualValue to null.
4. Return strictly valid JSON:
{
  "actualValue": number or null,
  "actualUnit": "${promise.targetUnit}",
  "actualPeriod": "${targetPeriod}",
  "outcomeStatement": "Exact quote stating the actual achieved result",
  "outcomeSource": "Source publication or report title",
  "outcomeSourceUrl": "https://...",
  "outcomeSourceDate": "ISO date string"
}`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: outcomePrompt }],
      temperature: 0.1,
      response_format: { type: 'json_object' }
    });

    const parsed = JSON.parse(response.choices?.[0]?.message?.content || '{}');
    if (parsed.actualValue !== null && parsed.actualValue !== undefined) {
      logger.info(`[Research] Stage B outcome found for ${profile.symbol} ${metric} ${targetPeriod}: actual = ${parsed.actualValue}`);
      return parsed;
    }
    return null;
  } catch (error) {
    logger.warn(`[Research] Stage B outcome search error for ${profile.symbol}: ${error.message}`);
    return null;
  }
};

/**
 * STAGE D: Search for management explanations for missed or partially fulfilled targets
 */
export const searchManagementExplanation = async (profile, promise, status) => {
  const { getStockNews } = await import('./NewsAPIService.js');
  const metric = promise.metric;
  const targetPeriod = promise.targetPeriod;

  logger.info(`[Research] Stage D: Searching management explanation for ${profile.symbol} ${metric} (${status}) in ${targetPeriod}`);

  try {
    const articles = await getStockNews(profile.symbol, { days: 1825 });
    if (!articles.length) return null;

    const explanationPrompt = `You are extracting management's explanation for why the ${metric} guidance for ${targetPeriod} was ${status} for ${profile.companyName} (${profile.symbol}).

Target: ${promise.targetValue} ${promise.targetUnit}
Actual: ${promise.actualValue} ${promise.targetUnit}
Status: ${status}

Articles to examine:
${JSON.stringify(articles.slice(0, 25).map(a => ({ title: a.title, description: a.description, url: a.url, publishedAt: a.publishedAt, source: a.source })))}

INSTRUCTIONS:
1. Extract ONLY public explanations or commentary given by the company's management in earnings calls, investor presentations, annual reports, or interviews.
2. DO NOT fabricate or guess reasons.
3. Return strictly valid JSON:
{
  "explanation": "Management statement explaining the variance or null",
  "reasonCategory": "DEMAND_WEAKNESS|EXECUTION_DELAY|CUSTOMER_DELAY|MACROECONOMIC|REGULATORY|COMPETITIVE_PRESSURE|CURRENCY|ACQUISITION|ONE_OFF|CAPACITY_CONSTRAINT|MANAGEMENT_REVISED_GUIDANCE|PROJECT_DELAY|UNSPECIFIED|NO_EXPLANATION_FOUND",
  "sourceUrl": "https://...",
  "sourceDate": "ISO date string",
  "exactStatement": "Exact quote from management"
}`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: explanationPrompt }],
      temperature: 0.1,
      response_format: { type: 'json_object' }
    });

    const parsed = JSON.parse(response.choices?.[0]?.message?.content || '{}');
    if (parsed.explanation && parsed.reasonCategory !== 'NO_EXPLANATION_FOUND') {
      return parsed;
    }
    return null;
  } catch (error) {
    logger.warn(`[Research] Stage D explanation search error for ${profile.symbol}: ${error.message}`);
    return null;
  }
};

/**
 * Executes complete multi-tier research run for a company (Facts + Guidance)
 */
export const refreshCompanyResearch = async (symbol, researchRunId = null, progressCallback = null) => {
  const normalized = String(symbol || '').toUpperCase().trim();
  if (!SUPPORTED_STOCKS[normalized]) throw new Error(`Unsupported company symbol: ${normalized}`);

  const profile = getCompanyResearchProfile(normalized, SUPPORTED_STOCKS[normalized].name, SUPPORTED_STOCKS[normalized].sector);
  const rejectionReasonsMap = {};
  const rejectionReasonsList = [];

  const addRejection = (reason) => {
    rejectionReasonsMap[reason] = (rejectionReasonsMap[reason] || 0) + 1;
    rejectionReasonsList.push(reason);
  };

  const updateProgress = (step, message) => {
    logger.info(`[Research] ${normalized} - ${step}: ${message}`);
    if (progressCallback) progressCallback(step, message);
  };

  try {
    updateProgress('COLLECTING_SOURCES', `Collecting documents across Tier 1 (IR/Annual Reports), Tier 2 (Exchanges), and Tier 3/4 (Historical Disclosures) for ${profile.companyName}...`);

    // Tier 1-4 Document Discovery
    const documentResult = await collectDocuments(normalized);
    const documents = documentResult.documents;

    updateProgress('EXTRACTING_FACTS', `Extracting structured historical facts across 3-5 years from ${documents.length} sources...`);
    const rawFacts = await extractHistoricalFactsFromSources(profile, documents);
    const verifiedFacts = deduplicateFacts(rawFacts);

    updateProgress('SAVING_FACTS', `Storing ${verifiedFacts.length} verified historical facts in intelligence database...`);
    if (isDbConnected()) {
      for (const fact of verifiedFacts) {
        if (!fact.title || !fact.fact || !fact.source?.url) continue;
        await CompanyHistoricalFact.updateOne(
          {
            symbol: normalized,
            period: fact.period,
            title: fact.title,
            'source.url': fact.source.url
          },
          {
            $set: {
              symbol: normalized,
              companyName: profile.companyName,
              date: toDate(fact.date) || toDate(fact.source?.publishedAt) || new Date(),
              period: fact.period || 'FY2025',
              category: FACT_CATEGORIES.includes(fact.category) ? fact.category : 'OTHER',
              title: fact.title,
              fact: fact.fact,
              summary: fact.summary || null,
              isNegative: Boolean(fact.isNegative),
              metrics: fact.metrics || {},
              source: {
                type: fact.source?.type || 'NEWS_ARTICLE',
                title: fact.source?.title || fact.title,
                url: fact.source?.url,
                publishedAt: toDate(fact.source?.publishedAt) || new Date(),
                pageNumber: fact.source?.pageNumber || null,
                excerpt: fact.source?.excerpt || fact.fact
              },
              confidence: fact.confidence || 0.85,
              verified: true,
              researchRunId
            }
          },
          { upsert: true }
        );
      }
    }

    updateProgress('EXTRACTING_PROMISES', `Analyzing sources for measurable management guidance targets...`);
    const extractedPromises = await extractPromisesFromSources(profile, documents);

    let savedPromises = 0;
    let outcomesFound = 0;
    let explanationsFound = 0;

    for (let i = 0; i < extractedPromises.length; i++) {
      const p = extractedPromises[i];
      const statement = p.exactManagementStatement || p.statement;

      if (!statement) { addRejection('MISSING_STATEMENT'); continue; }
      if (!p.metric) { addRejection('MISSING_METRIC'); continue; }
      if (p.targetValue === undefined || p.targetValue === null || !Number.isFinite(Number(p.targetValue))) {
        addRejection('NO_NUMERIC_TARGET');
        continue;
      }
      if (!p.targetPeriod) { addRejection('NO_TARGET_PERIOD'); continue; }
      if (!p.sourceUrl) { addRejection('LOW_SOURCE_AUTHORITY'); continue; }

      updateProgress('VERIFYING_OUTCOMES', `Verifying guidance target ${i + 1}/${extractedPromises.length}: ${statement.substring(0, 45)}...`);

      // Stage B: Search actual outcome
      const outcome = await searchActualOutcomes(profile, p);
      if (outcome && outcome.actualValue !== null && outcome.actualValue !== undefined) {
        outcomesFound++;
      }

      // Stage C: Deterministic verification in JavaScript
      const verification = calculatePromiseStatus({
        targetValue: p.targetValue,
        actualValue: outcome?.actualValue ?? null,
        direction: p.direction || 'HIGHER_IS_BETTER',
        metric: p.metric,
        targetPeriod: p.targetPeriod
      });

      // Stage D: Management explanation research for missed / partial
      let explanationData = null;
      if (verification.status === 'MISSED' || verification.status === 'PARTIALLY_FULFILLED') {
        explanationData = await searchManagementExplanation(profile, { ...p, actualValue: outcome?.actualValue }, verification.status);
        if (explanationData) {
          explanationsFound++;
        }
      }

      const authorityLevel = p.sourceAuthority || SOURCE_AUTHORITY.EVENT_REGISTRY;
      const promiseDate = toDate(p.promiseDate) || toDate(p.sourceDate) || new Date();

      const record = {
        companyId: normalized,
        symbol: normalized,
        companyName: profile.companyName,
        promise: {
          statement,
          metric: p.metric,
          targetValue: Number(p.targetValue),
          targetUnit: p.targetUnit || 'INR_CRORE',
          targetPeriod: p.targetPeriod,
          promiseDate,
          direction: p.direction || 'HIGHER_IS_BETTER',
          importance: p.importance || 'MEDIUM'
        },
        outcome: {
          actualValue: outcome?.actualValue != null ? Number(outcome.actualValue) : null,
          actualUnit: p.targetUnit || 'INR_CRORE',
          actualPeriod: outcome?.actualPeriod || p.targetPeriod,
          statement: outcome?.outcomeStatement || null,
          sourceUrl: outcome?.outcomeSourceUrl || null,
          sourceDate: toDate(outcome?.outcomeSourceDate) || null,
          excerpt: outcome?.outcomeStatement || null
        },
        verification: {
          achievementPercentage: verification.achievementPercentage,
          status: verification.status,
          calculationExplanation: verification.calculationExplanation,
          confidence: authorityLevel
        },
        explanation: explanationData ? {
          managementExplanation: explanationData.explanation || explanationData.exactStatement,
          category: explanationData.reasonCategory || 'OTHER',
          sourceUrl: explanationData.sourceUrl || null,
          sourceDate: toDate(explanationData.sourceDate) || null,
          excerpt: explanationData.exactStatement || explanationData.explanation
        } : {
          managementExplanation: (verification.status === 'MISSED' || verification.status === 'PARTIALLY_FULFILLED') 
            ? 'Management explanation not found in available public sources.' 
            : null,
          category: 'NO_EXPLANATION_FOUND',
          sourceUrl: null,
          sourceDate: null,
          excerpt: null
        },
        evidence: {
          promiseSource: {
            sourceType: p.sourceDocument || DOCUMENT_TYPES.INVESTOR_PRESENTATION,
            sourceName: p.sourceDocument || 'Company Disclosures',
            sourceUrl: p.sourceUrl,
            sourceDate: toDate(p.sourceDate) || promiseDate,
            publicationDate: toDate(p.sourceDate) || promiseDate,
            title: p.sourceDocument || statement,
            excerpt: p.sourceExcerpt || statement,
            documentType: p.sourceDocument || DOCUMENT_TYPES.INVESTOR_PRESENTATION,
            authorityLevel
          },
          outcomeSource: outcome?.outcomeSourceUrl ? {
            sourceType: DOCUMENT_TYPES.NEWS_ARTICLE,
            sourceName: outcome.outcomeSource || 'Reported Results',
            sourceUrl: outcome.outcomeSourceUrl,
            sourceDate: toDate(outcome.outcomeSourceDate) || new Date(),
            publicationDate: toDate(outcome.outcomeSourceDate) || new Date(),
            title: outcome.outcomeStatement || 'Actual Reported Results',
            excerpt: outcome.outcomeStatement || '',
            documentType: DOCUMENT_TYPES.NEWS_ARTICLE,
            authorityLevel: SOURCE_AUTHORITY.FINANCIAL_PUBLICATION
          } : null,
          explanationSource: explanationData?.sourceUrl ? {
            sourceType: DOCUMENT_TYPES.NEWS_ARTICLE,
            sourceName: 'Management Commentary',
            sourceUrl: explanationData.sourceUrl,
            sourceDate: toDate(explanationData.sourceDate) || new Date(),
            publicationDate: toDate(explanationData.sourceDate) || new Date(),
            title: explanationData.exactStatement || 'Management Commentary',
            excerpt: explanationData.explanation || '',
            documentType: DOCUMENT_TYPES.NEWS_ARTICLE,
            authorityLevel: SOURCE_AUTHORITY.FINANCIAL_PUBLICATION
          } : null
        },
        researchRunId,

        // Backward-compatible flat fields
        exchange: 'NSE',
        financialYear: p.targetPeriod,
        period: p.targetPeriod,
        promiseTitle: statement,
        promiseText: statement,
        promiseDescription: statement,
        promiseType: p.metric,
        metric: p.metric,
        metricType: 'QUANTITATIVE',
        targetValue: Number(p.targetValue),
        targetUnit: p.targetUnit || 'INR_CRORE',
        targetPeriod: p.targetPeriod,
        guidanceDate: promiseDate,
        announcementDate: promiseDate,
        actualValue: outcome?.actualValue != null ? Number(outcome.actualValue) : null,
        actualUnit: p.targetUnit || 'INR_CRORE',
        actualPeriod: outcome?.actualPeriod || p.targetPeriod,
        actualDate: toDate(outcome?.outcomeSourceDate) || null,
        actualSourceUrl: outcome?.outcomeSourceUrl || null,
        actualSourceTitle: outcome?.outcomeStatement || null,
        actualSourceDate: toDate(outcome?.outcomeSourceDate) || null,
        actualSourceExcerpt: outcome?.outcomeStatement || null,
        achievementPercentage: verification.achievementPercentage,
        calculationExplanation: verification.calculationExplanation,
        status: verification.status,
        importance: p.importance || 'MEDIUM',
        sourceType: p.sourceDocument || 'NEWS_ARTICLE',
        sourceTitle: p.sourceDocument || statement,
        sourceUrl: p.sourceUrl,
        sourceDate: toDate(p.sourceDate) || promiseDate,
        sourceExcerpt: p.sourceExcerpt || statement,
        confidenceScore: authorityLevel,
        confidence: authorityLevel,
        managementExplanation: explanationData?.explanation || null,
        managementReason: explanationData?.explanation || null,
        reasonType: explanationData ? 'MANAGEMENT_STATED' : 'UNAVAILABLE',
        reasonSourceUrl: explanationData?.sourceUrl || null,
        reasonSourceExcerpt: explanationData?.exactStatement || null
      };

      if (isDbConnected()) {
        await ManagementPromise.updateOne(
          {
            symbol: normalized,
            'promise.targetPeriod': record.promise.targetPeriod,
            'promise.metric': record.promise.metric,
            'evidence.promiseSource.sourceUrl': record.evidence.promiseSource.sourceUrl
          },
          { $set: record },
          { upsert: true }
        );
      }
      savedPromises += 1;
    }

    updateProgress('CALCULATING_EXECUTION_SCORE', 'Calculating deterministic Company Execution Score & financial snapshot...');

    const allDbFacts = isDbConnected() ? await CompanyHistoricalFact.find({ symbol: normalized }).lean() : verifiedFacts;
    const allDbPromises = isDbConnected() ? await ManagementPromise.find({ symbol: normalized }).lean() : [];

    const executionScoreResult = calculateCompanyExecutionScore({
      facts: allDbFacts,
      promises: allDbPromises,
      profile
    });

    const periods = [...new Set(allDbFacts.map(f => f.period).filter(Boolean))];
    const coverageStart = periods.length ? periods[0] : 'FY2022';
    const coverageEnd = periods.length ? periods[periods.length - 1] : 'FY2026';

    const confidenceResult = calculateConfidence({
      facts: allDbFacts,
      promises: allDbPromises,
      sources: documents,
      coverageYears: periods
    });

    const state = allDbFacts.length >= 8 ? 'HISTORICAL_DATA_AVAILABLE' : allDbFacts.length > 0 ? 'LIMITED_COVERAGE' : 'INSUFFICIENT_EVIDENCE';

    if (researchRunId && isDbConnected()) {
      await ResearchRun.findByIdAndUpdate(researchRunId, {
        sourceStats: documentResult.stats,
        extractionStats: {
          documentsAnalyzed: documents.length,
          factsExtracted: rawFacts.length,
          factsVerified: verifiedFacts.length,
          candidatePromises: extractedPromises.length,
          verifiedPromises: savedPromises,
          outcomesFound,
          explanationsFound
        },
        providerStats: documentResult.stats.providers,
        rejectionReasons: rejectionReasonsList,
        coverageStart,
        coverageEnd,
        factsExtracted: rawFacts.length,
        factsVerified: verifiedFacts.length,
        promisesFound: extractedPromises.length,
        promisesVerified: savedPromises,
        executionScore: executionScoreResult.executionScore,
        confidenceLevel: confidenceResult.level,
        state
      });
    }

    return {
      status: 'COMPLETED',
      symbol: normalized,
      companyName: profile.companyName,
      sourcesFound: documentResult.stats.documentsFound,
      providers: documentResult.stats.providers,
      factsExtracted: rawFacts.length,
      factsVerified: verifiedFacts.length,
      promisesExtracted: extractedPromises.length,
      promisesVerified: savedPromises,
      outcomesFound,
      explanationsFound,
      rejectionReasons: rejectionReasonsMap,
      executionScore: executionScoreResult,
      confidence: confidenceResult,
      coverage: `${coverageStart}–${coverageEnd}`,
      state
    };
  } catch (error) {
    updateProgress('RESEARCH_FAILED', `Research failed: ${error.message}`);
    logger.error(`[Research] Research failed for ${normalized}: ${error.message}`);

    if (researchRunId && isDbConnected()) {
      await ResearchRun.findByIdAndUpdate(researchRunId, {
        rejectionReasons: [error.message],
        error: error.message,
        state: 'RESEARCH_FAILED'
      });
    }

    return {
      status: 'FAILED',
      symbol: normalized,
      error: error.message,
      rejectionReasons: { ERROR: 1 },
      state: 'RESEARCH_FAILED'
    };
  }
};

export const getFeaturedCompanies = async () => Promise.all(FEATURED_SYMBOLS.map((symbol) => getCompanySummary(symbol)));

export const searchCompanies = async (query = '') => {
  const term = String(query).trim().toLowerCase();
  const allSymbols = [...new Set([...FEATURED_SYMBOLS, ...Object.keys(SUPPORTED_STOCKS)])];
  return allSymbols
    .filter((symbol) => !term || symbol.toLowerCase().includes(term) || companyFor(symbol).toLowerCase().includes(term))
    .slice(0, 20)
    .map((symbol) => ({
      symbol,
      companyName: companyFor(symbol),
      sector: SUPPORTED_STOCKS[symbol]?.sector || 'Unknown'
    }));
};

export const getCompanyPromises = async (symbol, filters = {}) => {
  if (!isDbConnected()) return [];
  const query = { symbol: String(symbol).toUpperCase() };
  if (filters.year) query.financialYear = String(filters.year);
  if (filters.status) query.status = String(filters.status).toUpperCase();
  if (filters.metric) query.metric = new RegExp(String(filters.metric), 'i');
  try {
    return await ManagementPromise.find(query).sort({ 'promise.promiseDate': -1, announcementDate: -1, createdAt: -1 }).lean();
  } catch (err) {
    logger.warn(`Failed to fetch promises for ${symbol}: ${err.message}`);
    return [];
  }
};

export const getCompanyFacts = async (symbol, filters = {}) => {
  if (!isDbConnected()) return [];
  const query = { symbol: String(symbol).toUpperCase() };
  if (filters.category) query.category = String(filters.category).toUpperCase();
  if (filters.year) query.period = new RegExp(String(filters.year), 'i');
  if (filters.period) query.period = String(filters.period);
  if (filters.sourceType) query['source.type'] = String(filters.sourceType).toUpperCase();
  try {
    return await CompanyHistoricalFact.find(query).sort({ date: -1, createdAt: -1 }).lean();
  } catch (err) {
    logger.warn(`Failed to fetch historical facts for ${symbol}: ${err.message}`);
    return [];
  }
};

export const getCompanyHistory = async (symbol, options = {}) => {
  const facts = await getCompanyFacts(symbol, options);
  const page = parseInt(options.page, 10) || 1;
  const limit = parseInt(options.limit, 10) || 50;
  const startIndex = (page - 1) * limit;
  const paginated = facts.slice(startIndex, startIndex + limit);

  return {
    symbol: String(symbol).toUpperCase(),
    total: facts.length,
    page,
    limit,
    totalPages: Math.ceil(facts.length / limit),
    facts: paginated
  };
};

export const getCompanySummary = async (symbol) => {
  const normalized = String(symbol).toUpperCase();
  const profile = getCompanyResearchProfile(normalized, companyFor(normalized), SUPPORTED_STOCKS[normalized]?.sector);
  const facts = await getCompanyFacts(normalized);
  const promises = await getCompanyPromises(normalized);
  const reliability = calculateReliability(promises);

  let latestRun = null;
  if (isDbConnected()) {
    try {
      latestRun = await ResearchRun.findOne({ companySymbol: normalized }).sort({ createdAt: -1 }).lean();
    } catch (err) {
      logger.warn(`Failed to fetch research run for ${symbol}: ${err.message}`);
    }
  }

  const executionScoreResult = calculateCompanyExecutionScore({
    facts,
    promises,
    profile
  });

  const periods = [...new Set(facts.map(f => f.period).filter(Boolean))].sort((a, b) => {
    const yearA = parseInt(String(a).match(/\d+/)?.[0] || '0', 10);
    const yearB = parseInt(String(b).match(/\d+/)?.[0] || '0', 10);
    return yearA - yearB;
  });
  const coverageYears = periods.length ? `${periods[0]}–${periods[periods.length - 1]}` : (latestRun?.coverageStart ? `${latestRun.coverageStart}–${latestRun.coverageEnd}` : 'FY2022–FY2026');

  // Count unique source documents
  const uniqueSourceUrls = new Set();
  facts.forEach(f => { if (f.source?.url) uniqueSourceUrls.add(f.source.url); });
  promises.forEach(p => { if (p.evidence?.promiseSource?.sourceUrl) uniqueSourceUrls.add(p.evidence.promiseSource.sourceUrl); });

  const confidence = calculateConfidence({
    facts,
    promises,
    sources: Array.from(uniqueSourceUrls),
    coverageYears: periods
  });

  let researchState = 'RESEARCH_REQUIRED';
  if (latestRun?.status === 'RUNNING') {
    researchState = 'RESEARCH_RUNNING';
  } else if (latestRun?.status === 'FAILED') {
    researchState = 'API_ERROR';
  } else if (facts.length >= 8) {
    researchState = 'HISTORICAL_DATA_AVAILABLE';
  } else if (facts.length > 0) {
    researchState = 'LIMITED_COVERAGE';
  } else if (latestRun) {
    researchState = 'INSUFFICIENT_EVIDENCE';
  }

  return {
    // Backward compatibility with previous score format
    ...reliability,
    score: reliability,
    symbol: normalized,
    companyName: profile.companyName,
    sector: profile.sector,
    executionScore: executionScoreResult.executionScore,
    ratingLabel: executionScoreResult.ratingLabel,
    scoreBreakdown: executionScoreResult.scoreBreakdown,
    financialSnapshot: executionScoreResult.financialSnapshot,
    guidanceSuccessRate: executionScoreResult.guidanceSuccessRate,
    confidence: confidence.level,
    confidenceReason: confidence.reason,
    coverage: coverageYears,
    factsCount: facts.length,
    sourcesCount: uniqueSourceUrls.size || latestRun?.sourceStats?.documentsFound || 0,
    managementTrackRecord: {
      totalTargets: promises.length,
      fulfilled: reliability.fulfilled,
      partiallyFulfilled: reliability.partiallyFulfilled,
      missed: reliability.missed,
      pending: reliability.pending,
      score: reliability.score,
      trend: reliability.trend
    },
    researchState,
    lastResearchAt: latestRun?.completedAt || null,
    latestRun: latestRun || null
  };
};

export const getCompanyReport = async (symbol) => {
  const normalized = String(symbol).toUpperCase();
  const profile = getCompanyResearchProfile(normalized, companyFor(normalized), SUPPORTED_STOCKS[normalized]?.sector);
  const facts = await getCompanyFacts(normalized);
  const promises = await getCompanyPromises(normalized);
  const summary = await getCompanySummary(normalized);
  const latestRun = summary.latestRun;

  const strategicFacts = facts.filter(f => 
    f.category === 'STRATEGY' || 
    f.category === 'EXPANSION' || 
    f.category === 'ACQUISITION' || 
    f.category === 'CONTRACT' || 
    f.category === 'PRODUCT' || 
    f.category === 'CAPEX'
  );

  const risksAndNegatives = facts.filter(f => 
    f.isNegative || 
    f.category === 'RISK' ||
    (f.fact && (
      f.fact.toLowerCase().includes('decline') ||
      f.fact.toLowerCase().includes('compression') ||
      f.fact.toLowerCase().includes('delayed') ||
      f.fact.toLowerCase().includes('slowdown')
    ))
  );

  // Deduplicated source documents library
  const sourceMap = new Map();
  facts.forEach(f => {
    if (f.source?.url && !sourceMap.has(f.source.url)) {
      sourceMap.set(f.source.url, {
        title: f.source.title || f.title,
        url: f.source.url,
        type: f.source.type || 'DOCUMENT',
        publishedAt: f.source.publishedAt,
        excerpt: f.source.excerpt || f.fact,
        authorityLevel: SOURCE_AUTHORITY[f.source.type] || 0.85
      });
    }
  });
  promises.forEach(p => {
    if (p.evidence?.promiseSource?.sourceUrl && !sourceMap.has(p.evidence.promiseSource.sourceUrl)) {
      sourceMap.set(p.evidence.promiseSource.sourceUrl, {
        title: p.evidence.promiseSource.title || p.statement,
        url: p.evidence.promiseSource.sourceUrl,
        type: p.evidence.promiseSource.sourceType || 'INVESTOR_PRESENTATION',
        publishedAt: p.evidence.promiseSource.sourceDate,
        excerpt: p.evidence.promiseSource.excerpt || p.statement,
        authorityLevel: p.evidence.promiseSource.authorityLevel || 0.95
      });
    }
  });

  const sourceDocuments = Array.from(sourceMap.values());

  return {
    company: {
      symbol: normalized,
      companyName: profile.companyName,
      sector: profile.sector,
      aliases: profile.aliases,
      exchangeSymbols: profile.exchangeSymbols,
      sectorMetrics: profile.sectorMetrics
    },
    executionScore: summary.executionScore,
    ratingLabel: summary.ratingLabel,
    guidanceSuccessRate: summary.guidanceSuccessRate,
    scoreBreakdown: summary.scoreBreakdown,
    confidence: {
      level: summary.confidence,
      reason: summary.confidenceReason,
      verifiedFactsCount: facts.length,
      verifiedSourcesCount: sourceDocuments.length,
      verifiedPromisesCount: summary.managementTrackRecord.totalTargets
    },
    coverage: summary.coverage,
    financialSnapshot: summary.financialSnapshot,
    historicalFacts: facts,
    timeline: facts, // Full chronological verified events
    businessDevelopments: strategicFacts,
    managementTrackRecord: summary.managementTrackRecord,
    risksAndNegatives,
    sourceDocuments,
    researchState: summary.researchState,
    lastResearchDate: summary.lastResearchAt,
    latestRun,
    researchMetadata: {
      lastResearchAt: summary.lastResearchAt,
      duration: latestRun?.duration || null,
      sourceStats: latestRun?.sourceStats || null,
      extractionStats: latestRun?.extractionStats || null,
      providerStats: latestRun?.providerStats || [],
      rejectionReasons: latestRun?.rejectionReasons || []
    },

    // Legacy fields for backward compatibility
    score: summary.score,
    summary: {
      message: facts.length
        ? `${facts.length} verified historical facts and ${promises.length} management targets tracked across ${summary.coverage}.`
        : 'No verified historical records found in database. Run Historical AI Research to analyze official disclosures.'
    },
    promises,
    trend: summary.financialSnapshot?.annualSeries || [],
    currentGuidance: promises.filter((promise) => {
      const status = promise.verification?.status || promise.status;
      return status === 'PENDING';
    })
  };
};

export const createResearchJob = async (symbol) => {
  const normalized = String(symbol || '').toUpperCase();
  if (!SUPPORTED_STOCKS[normalized]) throw new Error(`Unsupported company symbol: ${normalized}`);
  if (!isDbConnected()) throw new Error('Database is currently offline. Cannot create research run.');
  
  const latest = await ResearchRun.findOne({ companySymbol: normalized }).sort({ createdAt: -1 }).lean();
  if (latest?.status === 'RUNNING') return { status: 'PROCESSING', jobId: String(latest._id) };
  if (latest?.status === 'COMPLETED' && latest.completedAt && Date.now() - new Date(latest.completedAt).getTime() < 60 * 60 * 1000) {
    return { status: 'CACHED', jobId: String(latest._id), lastResearchAt: latest.completedAt };
  }

  const run = await ResearchRun.create({ companySymbol: normalized, status: 'RUNNING' });
  const jobId = String(run._id);
  researchJobs.set(jobId, 'RUNNING');

  refreshCompanyResearch(normalized, run._id, (step, message) => {
    ResearchRun.findByIdAndUpdate(run._id, {
      progressStep: step,
      progressMessage: message
    }).catch(() => {});
  }).then(async (result) => {
    await ResearchRun.findByIdAndUpdate(run._id, {
      status: 'COMPLETED',
      completedAt: new Date(),
      state: result.state
    });
    researchJobs.set(jobId, 'COMPLETED');
  }).catch(async (error) => {
    await ResearchRun.findByIdAndUpdate(run._id, {
      status: 'FAILED',
      completedAt: new Date(),
      error: error.message,
      state: 'RESEARCH_FAILED'
    });
    researchJobs.set(jobId, 'FAILED');
  });

  return { status: 'PROCESSING', jobId };
};

export const getResearchJob = async (jobId) => {
  if (!isDbConnected()) return { jobId, status: researchJobs.get(jobId) || 'FAILED', error: 'Database unavailable.' };
  const run = await ResearchRun.findById(jobId).lean();
  if (!run) return { jobId, status: researchJobs.get(jobId) || 'FAILED', error: 'Research run not found.' };
  return {
    jobId,
    status: run.status,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    duration: run.duration,
    progressStep: run.progressStep,
    progressMessage: run.progressMessage,
    state: run.state,
    coverageStart: run.coverageStart,
    coverageEnd: run.coverageEnd,
    factsExtracted: run.factsExtracted,
    factsVerified: run.factsVerified,
    promisesFound: run.promisesFound,
    promisesVerified: run.promisesVerified,
    executionScore: run.executionScore,
    confidenceLevel: run.confidenceLevel,
    sourceStats: run.sourceStats,
    extractionStats: run.extractionStats,
    providerStats: run.providerStats,
    rejectionReasons: run.rejectionReasons,
    error: run.error
  };
};

/**
 * Returns debug inspection data for a company research run
 */
export const getCompanyResearchDebug = async (symbol) => {
  const normalized = String(symbol || '').toUpperCase().trim();
  const profile = getCompanyResearchProfile(normalized, companyFor(normalized));
  let latestRun = null;
  let facts = [];
  let promises = [];

  if (isDbConnected()) {
    try {
      latestRun = await ResearchRun.findOne({ companySymbol: normalized }).sort({ createdAt: -1 }).lean();
      facts = await CompanyHistoricalFact.find({ symbol: normalized }).lean();
      promises = await ManagementPromise.find({ symbol: normalized }).lean();
    } catch (err) {
      logger.warn(`Failed to query debug data for ${symbol}: ${err.message}`);
    }
  }

  const outcomesFound = promises.filter(p => p.outcome?.actualValue !== null && p.outcome?.actualValue !== undefined).length;
  const explanationsFound = promises.filter(p => p.explanation?.managementExplanation && p.explanation?.category !== 'NO_EXPLANATION_FOUND').length;

  const rejectionReasonsMap = {};
  if (latestRun?.rejectionReasons) {
    latestRun.rejectionReasons.forEach(r => {
      rejectionReasonsMap[r] = (rejectionReasonsMap[r] || 0) + 1;
    });
  }

  const documentsByProvider = {};
  if (latestRun?.providerStats) {
    latestRun.providerStats.forEach(p => {
      documentsByProvider[p.provider || p.name] = p.documentsFound || 0;
    });
  }

  return {
    symbol: normalized,
    companyName: profile.companyName,
    aliases: profile.aliases,
    sector: profile.sector,
    sourcesFound: latestRun?.sourceStats?.documentsFound || 0,
    documentsByProvider,
    factsExtracted: latestRun?.extractionStats?.factsExtracted || facts.length,
    factsVerified: latestRun?.extractionStats?.factsVerified || facts.length,
    promisesExtracted: latestRun?.extractionStats?.candidatePromises || promises.length,
    promisesRejected: latestRun?.rejectionReasons?.length || 0,
    rejectionReasons: rejectionReasonsMap,
    outcomesFound: latestRun?.extractionStats?.outcomesFound || outcomesFound,
    explanationsFound: latestRun?.extractionStats?.explanationsFound || explanationsFound,
    factRecords: facts,
    promiseRecords: promises
  };
};

export { FEATURED_SYMBOLS };
export default {
  getFeaturedCompanies,
  searchCompanies,
  getCompanySummary,
  getCompanyReport,
  getCompanyPromises,
  getCompanyFacts,
  getCompanyHistory,
  refreshCompanyResearch,
  createResearchJob,
  getResearchJob,
  getCompanyResearchDebug,
  calculateReliability,
  calculatePromiseStatus,
  recencyWeight,
  IMPORTANCE_WEIGHTS,
  STATUS_SCORE
};
