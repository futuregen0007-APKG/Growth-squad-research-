/**
 * ragHoldoutDataset.js
 * =====================
 * Phase 4A.2 hardening, item 6B: a SEPARATE holdout evaluation set, kept
 * apart from fixtures/ragGoldenDataset.js (the development set the
 * ranking formula was iterated against). These 8 questions were verified
 * against real, already-indexed TCS/INFY chunk text at construction time
 * (so every `expected` value below is a genuine, checkable fact — never
 * fabricated), but the RANKING FORMULA itself was not adjusted in
 * response to any individual holdout question's result after that
 * verification — see the Phase 4A.2 report for how this separation was
 * enforced (the one true vocabulary fix made during construction --
 * adding 'dso' to the general METRIC_TERMS list -- is a general
 * financial-vocabulary completion alongside existing entries like
 * roe/roce/ebitda, not a fact-specific bonus, and was applied BEFORE any
 * formal holdout run, not in response to seeing a formal result).
 */

export const HOLDOUT_DATASET = [
  {
    id: 'holdout-exact-numerical-1',
    category: 'exact_numerical_outcome',
    description: 'Exact numerical outcome (full-year revenue growth rate), verifiable from a real FY2022 TCS earnings call transcript.',
    query: 'What was the full year revenue growth rate?',
    symbols: ['TCS'],
    fiscalYears: ['FY2022'],
    expected: {
      status: 'SUCCESS',
      sourceUrlContains: 'f424c104-aab6-47ba-9659-65a2ce5689e1',
      pageIn: [3, 3],
      textIncludes: '16.8%',
    },
  },
  {
    id: 'holdout-forward-guidance-1',
    category: 'forward_management_guidance',
    description: 'Forward-looking management guidance (utilization outlook), verifiable from a real FY2024 Infosys earnings call transcript.',
    query: 'What is the outlook for utilization in the coming quarters?',
    symbols: ['INFY'],
    fiscalYears: ['FY2024'],
    expected: {
      status: 'SUCCESS',
      sourceUrlContains: 'c94d45c5-a44a-49d9-89af-6ef6532c4a30',
      pageIn: [30, 30],
      textIncludes: 'improve gradually in the coming quarters',
    },
  },
  {
    id: 'holdout-fiscal-period-constraint-1',
    category: 'fiscal_period_constraint',
    description: 'Fiscal-period-constrained fact (DSO), verifiable from a real Q1 FY2026 TCS earnings call transcript -- must not be confused with any other period\'s working-capital figures.',
    query: 'What was the DSO (days sales outstanding) this period?',
    symbols: ['TCS'],
    fiscalYears: ['FY2026'],
    expected: {
      status: 'SUCCESS',
      sourceUrlContains: '9cee0fdb-07a3-4dc6-af7a-40dce51e1348',
      pageIn: [5, 5],
      textIncludes: '75 days DSO',
    },
  },
  {
    id: 'holdout-paraphrased-semantic-1',
    category: 'paraphrased_semantic_query',
    description: 'Paraphrased query (no literal "outlook"/"utilization... improve" wording overlap with the source phrasing) targeting the SAME real FY2024 Infosys fact as holdout-forward-guidance-1 -- tests whether semantic (cosine) reranking recalls it without exact lexical overlap.',
    query: 'How does Infosys expect capacity utilization to trend going forward?',
    symbols: ['INFY'],
    fiscalYears: ['FY2024'],
    expected: {
      status: 'SUCCESS',
      textIncludes: 'improve gradually in the coming quarters',
    },
  },
  {
    id: 'holdout-company-alias-1',
    category: 'company_alias',
    description: 'Company-alias resolution using the FULL legal name ("Tata Consultancy Services") rather than the ticker, dynamically resolved via CompanyAliasResolver (not a hardcoded map) -- verifiable from the same real Q1 FY2026 TCS transcript as holdout-fiscal-period-constraint-1.',
    query: 'Tata Consultancy Services days sales outstanding this quarter',
    symbols: ['TCS'],
    fiscalYears: ['FY2026'],
    expected: {
      status: 'SUCCESS',
      textIncludes: '75 days DSO',
    },
  },
  {
    id: 'holdout-absent-answer-1',
    category: 'absent_answer',
    description: 'A question whose answer is absent from the entire indexed corpus -- must abstain honestly (EMPTY), never fabricate.',
    query: 'What is Infosys\'s position on volcanic hazard insurance?',
    symbols: ['INFY'],
    expected: { status: 'EMPTY' },
  },
  {
    id: 'holdout-generic-low-signal-1',
    category: 'generic_low_signal_query',
    description: 'A generic, low-signal query with no real, non-generic search terms -- must never produce SUCCESS however much real content exists for the symbol.',
    query: 'Please tell me about the results.',
    symbols: ['TCS'],
    expected: { status: 'EMPTY' },
  },
  {
    id: 'holdout-wrong-period-trap-1',
    category: 'wrong_period_trap',
    description: 'Wrong-period trap: the exact same DSO question as holdout-fiscal-period-constraint-1, but scoped to FY2022 instead of the fiscal year (FY2026) the real fact actually belongs to -- the FY2026 figure must never leak in just because the underlying metric/wording matches.',
    query: 'What was the DSO this period?',
    symbols: ['TCS'],
    fiscalYears: ['FY2022'],
    expected: {
      status: 'EMPTY',
      mustNotInclude: '75 days DSO',
    },
  },
];

export default HOLDOUT_DATASET;
