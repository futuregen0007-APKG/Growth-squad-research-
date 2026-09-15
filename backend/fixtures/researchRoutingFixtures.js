/**
 * researchRoutingFixtures.js
 * ============================
 * Phase 4C Part 8: ≥30 realistic natural-language research queries with
 * their expected deterministic routing decision (graph/researchScope.js's
 * resolveResearchScope). Each entry pairs a query with the `entities`
 * shape extractEntities.js would ALREADY have deterministically resolved
 * for it (company resolution itself is extractEntities' job and is
 * already covered by its own test suite — chatEntityExtraction.test.js —
 * so this fixture set tests the ROUTING POLICY in isolation, not entity
 * resolution).
 *
 * `intent` is the intent classifyIntent.js would plausibly assign (several
 * of these are exactly the "wrong" EARNINGS_INTELLIGENCE label the Phase
 * 4C root-cause fix is about — see researchScope.js's module note) —
 * included so the fixture also demonstrates the routing decision is
 * INDEPENDENT of that label wherever `expected.needsResearchCorpus` is
 * true regardless of intent.
 */

export const RESEARCH_ROUTING_FIXTURES = [
  {
    id: 'management-guidance-1',
    query: 'What margin guidance did Infosys give for FY2023?',
    intent: 'EARNINGS_INTELLIGENCE',
    entities: { symbols: ['INFY'], companyNames: ['Infosys'], periods: ['FY2023'], comparisonMode: false },
    expected: {
      researchQuestionType: 'MANAGEMENT_GUIDANCE', needsResearchCorpus: true, mergeEarningsIntelligence: true, ambiguousCompany: false, symbol: 'INFY', fiscalYear: 'FY2023', fiscalQuarter: null,
    },
  },
  {
    id: 'revised-guidance-1',
    query: 'Did Infosys revise its margin forecast?',
    intent: 'EARNINGS_INTELLIGENCE',
    entities: { symbols: ['INFY'], companyNames: ['Infosys'], periods: [], comparisonMode: false },
    expected: {
      researchQuestionType: 'REVISED_GUIDANCE', needsResearchCorpus: true, mergeEarningsIntelligence: true, ambiguousCompany: false, symbol: 'INFY',
    },
  },
  {
    id: 'earnings-call-statement-1',
    query: 'What did TCS management say about AI investment?',
    intent: 'COMPANY_RESEARCH',
    entities: { symbols: ['TCS'], companyNames: ['Tata Consultancy Services'], periods: [], comparisonMode: false },
    expected: {
      researchQuestionType: 'EARNINGS_CALL_STATEMENT', needsResearchCorpus: true, mergeEarningsIntelligence: false, ambiguousCompany: false, symbol: 'TCS',
    },
  },
  {
    id: 'promise-vs-outcome-1',
    query: 'Did management deliver what it promised?',
    intent: 'FOLLOW_UP',
    entities: { symbols: ['TCS'], companyNames: [], periods: [], comparisonMode: false },
    expected: {
      researchQuestionType: 'PROMISE_VS_OUTCOME', needsResearchCorpus: true, mergeEarningsIntelligence: true, ambiguousCompany: false, symbol: 'TCS',
    },
  },
  {
    id: 'revised-guidance-2-compare',
    query: 'Compare original and revised guidance.',
    intent: 'FOLLOW_UP',
    entities: { symbols: ['TCS'], companyNames: [], periods: [], comparisonMode: false },
    expected: {
      researchQuestionType: 'REVISED_GUIDANCE', needsResearchCorpus: true, mergeEarningsIntelligence: true, ambiguousCompany: false, symbol: 'TCS',
    },
  },
  {
    id: 'ambiguous-company-1',
    query: 'What was the guidance for FY2023?',
    intent: 'EARNINGS_INTELLIGENCE',
    entities: { symbols: [], companyNames: [], periods: ['FY2023'], comparisonMode: false },
    expected: {
      researchQuestionType: 'MANAGEMENT_GUIDANCE', needsResearchCorpus: true, mergeEarningsIntelligence: true, ambiguousCompany: true, symbol: null,
    },
  },
  {
    id: 'ambiguous-company-2-pronoun',
    query: 'What guidance did they give?',
    intent: 'FOLLOW_UP',
    entities: { symbols: [], companyNames: [], periods: [], comparisonMode: false },
    expected: {
      researchQuestionType: 'MANAGEMENT_GUIDANCE', needsResearchCorpus: true, mergeEarningsIntelligence: true, ambiguousCompany: true, symbol: null,
    },
  },
  {
    id: 'unsupported-company-1',
    query: 'What did XYZUnknownCorp say about its guidance?',
    intent: 'EARNINGS_INTELLIGENCE',
    entities: { symbols: [], companyNames: [], periods: [], comparisonMode: false },
    expected: {
      researchQuestionType: 'MANAGEMENT_GUIDANCE', needsResearchCorpus: true, mergeEarningsIntelligence: true, ambiguousCompany: true, symbol: null,
    },
  },
  {
    id: 'normal-chat-1',
    query: 'Hi, how are you?',
    intent: 'GENERAL_EDUCATION',
    entities: { symbols: [], companyNames: [], periods: [], comparisonMode: false },
    expected: {
      researchQuestionType: 'NORMAL_STOCK_DATA', needsResearchCorpus: false, mergeEarningsIntelligence: false, ambiguousCompany: false, symbol: null,
    },
  },
  {
    id: 'normal-stock-data-price',
    query: "What is TCS's current price?",
    intent: 'LIVE_MARKET_DATA',
    entities: { symbols: ['TCS'], companyNames: [], periods: [], comparisonMode: false },
    expected: {
      researchQuestionType: 'NORMAL_STOCK_DATA', needsResearchCorpus: false, mergeEarningsIntelligence: false, ambiguousCompany: false, symbol: null,
    },
  },
  {
    id: 'normal-stock-data-pe-ratio',
    query: "What is TCS's P/E ratio?",
    intent: 'COMPANY_RESEARCH',
    entities: { symbols: ['TCS'], companyNames: [], periods: [], comparisonMode: false },
    expected: {
      researchQuestionType: 'NORMAL_STOCK_DATA', needsResearchCorpus: false, mergeEarningsIntelligence: false, ambiguousCompany: false, symbol: null,
    },
  },
  {
    id: 'financial-results-1',
    query: "What were TCS's Q4 FY2023 results?",
    intent: 'EARNINGS_INTELLIGENCE',
    entities: { symbols: ['TCS'], companyNames: [], periods: ['Q4 FY2023'], comparisonMode: false },
    expected: {
      researchQuestionType: 'FINANCIAL_RESULTS', needsResearchCorpus: false, mergeEarningsIntelligence: false, ambiguousCompany: false, symbol: null,
    },
  },
  {
    id: 'document-filing-1',
    query: 'Search TCS documents for mentions of AI investments',
    intent: 'DOCUMENT_RESEARCH',
    entities: { symbols: ['TCS'], companyNames: [], periods: [], comparisonMode: false },
    expected: {
      researchQuestionType: 'DOCUMENT_FILING_QUESTION', needsResearchCorpus: true, mergeEarningsIntelligence: false, ambiguousCompany: false, symbol: 'TCS',
    },
  },
  {
    id: 'management-guidance-2-document-framed',
    query: 'Find in TCS filed documents what management said about revenue growth guidance',
    intent: 'EARNINGS_INTELLIGENCE',
    entities: { symbols: ['TCS'], companyNames: [], periods: [], comparisonMode: false },
    expected: {
      // Contains "guidance" -- MANAGEMENT_GUIDANCE outranks DOCUMENT_FILING_QUESTION by design priority (see researchScope.js).
      researchQuestionType: 'MANAGEMENT_GUIDANCE', needsResearchCorpus: true, mergeEarningsIntelligence: true, ambiguousCompany: false, symbol: 'TCS',
    },
  },
  {
    id: 'promise-vs-outcome-2-track-record',
    query: "What is TCS's track record of fulfilling promises?",
    intent: 'EARNINGS_INTELLIGENCE',
    entities: { symbols: ['TCS'], companyNames: [], periods: [], comparisonMode: false },
    expected: {
      researchQuestionType: 'PROMISE_VS_OUTCOME', needsResearchCorpus: true, mergeEarningsIntelligence: true, ambiguousCompany: false, symbol: 'TCS',
    },
  },
  {
    id: 'revised-guidance-3-was-later-revised',
    query: "Was TCS's FY2023 guidance later revised?",
    intent: 'EARNINGS_INTELLIGENCE',
    entities: { symbols: ['TCS'], companyNames: [], periods: ['FY2023'], comparisonMode: false },
    expected: {
      researchQuestionType: 'REVISED_GUIDANCE', needsResearchCorpus: true, mergeEarningsIntelligence: true, ambiguousCompany: false, symbol: 'TCS', fiscalYear: 'FY2023',
    },
  },
  {
    id: 'earnings-call-2-transcript',
    query: 'What does the earnings call transcript say about hiring plans?',
    intent: 'COMPANY_RESEARCH',
    entities: { symbols: ['TCS'], companyNames: [], periods: [], comparisonMode: false },
    expected: {
      researchQuestionType: 'EARNINGS_CALL_STATEMENT', needsResearchCorpus: true, mergeEarningsIntelligence: false, ambiguousCompany: false, symbol: 'TCS',
    },
  },
  {
    id: 'document-filing-2-look-through',
    query: 'Look through TCS filings for any mention of a new data center',
    intent: 'DOCUMENT_RESEARCH',
    entities: { symbols: ['TCS'], companyNames: [], periods: [], comparisonMode: false },
    expected: {
      researchQuestionType: 'DOCUMENT_FILING_QUESTION', needsResearchCorpus: true, mergeEarningsIntelligence: false, ambiguousCompany: false, symbol: 'TCS',
    },
  },
  {
    id: 'document-filing-3-excerpts',
    query: 'Find document excerpts from TCS filings about capital expenditure',
    intent: 'DOCUMENT_RESEARCH',
    entities: { symbols: ['TCS'], companyNames: [], periods: [], comparisonMode: false },
    expected: {
      researchQuestionType: 'DOCUMENT_FILING_QUESTION', needsResearchCorpus: true, mergeEarningsIntelligence: false, ambiguousCompany: false, symbol: 'TCS',
    },
  },
  {
    id: 'earnings-call-3-conference-call',
    query: 'What did Infosys management state during the conference call about attrition?',
    intent: 'COMPANY_RESEARCH',
    entities: { symbols: ['INFY'], companyNames: [], periods: [], comparisonMode: false },
    expected: {
      researchQuestionType: 'EARNINGS_CALL_STATEMENT', needsResearchCorpus: true, mergeEarningsIntelligence: false, ambiguousCompany: false, symbol: 'INFY',
    },
  },
  {
    id: 'promise-vs-outcome-3-did-achieve',
    query: 'Did TCS achieve its FY2022 revenue guidance?',
    intent: 'EARNINGS_INTELLIGENCE',
    entities: { symbols: ['TCS'], companyNames: [], periods: ['FY2022'], comparisonMode: false },
    expected: {
      // "did ... achieve" (PROMISE_VS_OUTCOME) outranks the "guidance" mention.
      researchQuestionType: 'PROMISE_VS_OUTCOME', needsResearchCorpus: true, mergeEarningsIntelligence: true, ambiguousCompany: false, symbol: 'TCS', fiscalYear: 'FY2022',
    },
  },
  {
    id: 'management-guidance-3-outlook',
    query: "What is Infosys's outlook for FY2024?",
    intent: 'COMPANY_RESEARCH',
    entities: { symbols: ['INFY'], companyNames: [], periods: ['FY2024'], comparisonMode: false },
    expected: {
      researchQuestionType: 'MANAGEMENT_GUIDANCE', needsResearchCorpus: true, mergeEarningsIntelligence: true, ambiguousCompany: false, symbol: 'INFY', fiscalYear: 'FY2024',
    },
  },
  {
    id: 'revised-guidance-4-raised',
    query: 'TCS raised its guidance for the year',
    intent: 'EARNINGS_INTELLIGENCE',
    entities: { symbols: ['TCS'], companyNames: [], periods: [], comparisonMode: false },
    expected: {
      researchQuestionType: 'REVISED_GUIDANCE', needsResearchCorpus: true, mergeEarningsIntelligence: true, ambiguousCompany: false, symbol: 'TCS',
    },
  },
  {
    id: 'revised-guidance-5-lowered',
    query: 'TCS lowered its outlook',
    intent: 'EARNINGS_INTELLIGENCE',
    entities: { symbols: ['TCS'], companyNames: [], periods: [], comparisonMode: false },
    expected: {
      researchQuestionType: 'REVISED_GUIDANCE', needsResearchCorpus: true, mergeEarningsIntelligence: true, ambiguousCompany: false, symbol: 'TCS',
    },
  },
  {
    id: 'management-guidance-4-forecast',
    query: "What was TCS's forecast?",
    intent: 'COMPANY_RESEARCH',
    entities: { symbols: ['TCS'], companyNames: [], periods: [], comparisonMode: false },
    expected: {
      researchQuestionType: 'MANAGEMENT_GUIDANCE', needsResearchCorpus: true, mergeEarningsIntelligence: true, ambiguousCompany: false, symbol: 'TCS',
    },
  },
  {
    id: 'stock-comparison-1-two-company',
    query: 'Compare TCS and Infosys',
    intent: 'STOCK_COMPARISON',
    entities: { symbols: ['TCS', 'INFY'], companyNames: [], periods: [], comparisonMode: true },
    expected: {
      researchQuestionType: 'NORMAL_STOCK_DATA', needsResearchCorpus: false, mergeEarningsIntelligence: false, ambiguousCompany: false, symbol: null,
    },
  },
  {
    id: 'watchlist-1',
    query: 'What is my watchlist showing today?',
    intent: 'WATCHLIST_ANALYSIS',
    entities: { symbols: [], companyNames: [], periods: [], comparisonMode: false },
    expected: {
      researchQuestionType: 'NORMAL_STOCK_DATA', needsResearchCorpus: false, mergeEarningsIntelligence: false, ambiguousCompany: false, symbol: null,
    },
  },
  {
    id: 'portfolio-1',
    query: "What is my portfolio's performance?",
    intent: 'PORTFOLIO_ANALYSIS',
    entities: { symbols: [], companyNames: [], periods: [], comparisonMode: false },
    expected: {
      researchQuestionType: 'NORMAL_STOCK_DATA', needsResearchCorpus: false, mergeEarningsIntelligence: false, ambiguousCompany: false, symbol: null,
    },
  },
  {
    id: 'news-1-normal',
    query: 'What is the news on TCS today?',
    intent: 'NEWS_RESEARCH',
    entities: { symbols: ['TCS'], companyNames: [], periods: [], comparisonMode: false },
    expected: {
      researchQuestionType: 'NORMAL_STOCK_DATA', needsResearchCorpus: false, mergeEarningsIntelligence: false, ambiguousCompany: false, symbol: null,
    },
  },
  {
    id: 'document-filing-4-say-in-filing',
    query: 'What did TCS say in its filing about the merger?',
    intent: 'COMPANY_RESEARCH',
    entities: { symbols: ['TCS'], companyNames: [], periods: [], comparisonMode: false },
    expected: {
      researchQuestionType: 'DOCUMENT_FILING_QUESTION', needsResearchCorpus: true, mergeEarningsIntelligence: false, ambiguousCompany: false, symbol: 'TCS',
    },
  },
  {
    id: 'earnings-call-4-commentary',
    query: "Did TCS's management commentary confirm the AI hackathon investment?",
    intent: 'COMPANY_RESEARCH',
    entities: { symbols: ['TCS'], companyNames: [], periods: [], comparisonMode: false },
    expected: {
      researchQuestionType: 'EARNINGS_CALL_STATEMENT', needsResearchCorpus: true, mergeEarningsIntelligence: false, ambiguousCompany: false, symbol: 'TCS',
    },
  },
  {
    id: 'revised-guidance-6-priority-over-guidance',
    query: 'What guidance did TCS give for margins, and was it later revised?',
    intent: 'EARNINGS_INTELLIGENCE',
    entities: { symbols: ['TCS'], companyNames: [], periods: [], comparisonMode: false },
    expected: {
      researchQuestionType: 'REVISED_GUIDANCE', needsResearchCorpus: true, mergeEarningsIntelligence: true, ambiguousCompany: false, symbol: 'TCS',
    },
  },
  {
    id: 'wrong-period-1',
    query: "What was TCS's guidance for FY2019?",
    intent: 'EARNINGS_INTELLIGENCE',
    entities: { symbols: ['TCS'], companyNames: [], periods: ['FY2019'], comparisonMode: false },
    expected: {
      researchQuestionType: 'MANAGEMENT_GUIDANCE', needsResearchCorpus: true, mergeEarningsIntelligence: true, ambiguousCompany: false, symbol: 'TCS', fiscalYear: 'FY2019', fiscalQuarter: null,
    },
  },
  {
    id: 'quarter-isolation-1',
    query: "What was TCS's Q1 FY2023 revenue guidance?",
    intent: 'EARNINGS_INTELLIGENCE',
    entities: { symbols: ['TCS'], companyNames: [], periods: ['Q1 FY2023'], comparisonMode: false },
    expected: {
      researchQuestionType: 'MANAGEMENT_GUIDANCE', needsResearchCorpus: true, mergeEarningsIntelligence: true, ambiguousCompany: false, symbol: 'TCS', fiscalYear: 'FY2023', fiscalQuarter: 'Q1',
    },
  },
  {
    id: 'follow-up-guidance-1',
    query: 'And what about its guidance for next year?',
    intent: 'FOLLOW_UP',
    entities: { symbols: ['TCS'], companyNames: [], periods: [], comparisonMode: false },
    expected: {
      researchQuestionType: 'MANAGEMENT_GUIDANCE', needsResearchCorpus: true, mergeEarningsIntelligence: true, ambiguousCompany: false, symbol: 'TCS',
    },
  },
  {
    id: 'document-filing-5-annual-report',
    query: "What does TCS's annual report say about sustainability initiatives?",
    intent: 'COMPANY_RESEARCH',
    entities: { symbols: ['TCS'], companyNames: [], periods: [], comparisonMode: false },
    expected: {
      researchQuestionType: 'DOCUMENT_FILING_QUESTION', needsResearchCorpus: true, mergeEarningsIntelligence: false, ambiguousCompany: false, symbol: 'TCS',
    },
  },
];

export default RESEARCH_ROUTING_FIXTURES;
