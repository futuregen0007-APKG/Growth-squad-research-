import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildExplainPrompt, validateGroundedExplanation, explainCompanyFinancials,
} from '../services/CompanyFinancialsExplainService.js';
import { OpenAIClientFactory } from '../llm/OpenAIClientFactory.js';

// FIXTURE normalized sections -- shaped exactly like
// UpstoxNormalizer's real output, never live-verified data.
const SECTIONS_FIXTURE = {
  profile: {
    symbol: 'TCS', isin: 'INE467B01029', provider: 'UPSTOX', fetchedAt: '2026-09-29T00:00:00.000Z',
    companyProfile: 'A leading IT services company.', sector: 'Information Technology', sectorMarketCapInr: null, sectorMarketCapUsd: null, raw: {},
  },
  balanceSheet: {
    symbol: 'TCS', isin: 'INE467B01029', statementType: 'CONSOLIDATED', period: 'YEARLY', units: 'INR_CRORE', provider: 'UPSTOX', fetchedAt: '2026-09-29T00:00:00.000Z',
    metrics: [{ financialYear: 'FY2026', label: 'total_asset', value: 500000, changePct: null }],
    raw: {},
  },
  cashFlow: null,
  incomeStatement: {
    symbol: 'TCS', isin: 'INE467B01029', statementType: 'CONSOLIDATED', period: 'YEARLY', units: 'INR_CRORE', provider: 'UPSTOX', fetchedAt: '2026-09-29T00:00:00.000Z',
    metrics: [
      { financialYear: 'FY2026', label: 'revenue', value: 250000, changePct: 12.5 },
      { financialYear: 'FY2026', label: 'net_profit', value: 45000, changePct: 15.2 },
    ],
    raw: {},
  },
  keyRatios: {
    symbol: 'TCS', isin: 'INE467B01029', provider: 'UPSTOX', fetchedAt: '2026-09-29T00:00:00.000Z',
    ratios: [
      { name: 'P/E', companyValue: 28.4, companyValueUnit: 'NUMBER', sectorValue: 24.1, sectorValueUnit: 'NUMBER' },
      { name: 'ROE', companyValue: 45.89, companyValueUnit: 'PERCENT', sectorValue: 8.65, sectorValueUnit: 'PERCENT' },
    ],
    raw: {},
  },
  shareholding: null,
  corporateActions: null,
};

test('buildExplainPrompt only ever embeds values sourced from the normalized sections object', () => {
  const prompt = buildExplainPrompt({ symbol: 'TCS', companyName: 'Tata Consultancy Services Ltd.', sections: SECTIONS_FIXTURE });
  // Every real number in the fixture must appear.
  for (const value of [500000, 250000, 45000, 12.5, 15.2, 28.4, 24.1]) {
    assert.ok(prompt.includes(String(value)), `prompt must embed sourced value ${value}`);
  }
  // A number that was never in the fixture must never appear as a DATA figure.
  assert.ok(!prompt.includes('999999'), 'prompt must never embed a value absent from the normalized sections');
  // Missing sections are named, not silently dropped.
  assert.ok(/cashFlow/.test(prompt) && /shareholding/.test(prompt) && /corporateActions/.test(prompt));
});

test('validateGroundedExplanation accepts an explanation whose cited values are all real', () => {
  const parsed = {
    summary: 'Revenue grew to 250000 Cr in FY2026.',
    observations: [{ statement: 'Revenue was 250000 in FY2026', citedLabel: 'revenue', citedFinancialYear: 'FY2026', citedValue: 250000 }],
    missingSectionsNote: 'Cash flow, shareholding, and corporate actions were not available this time.',
  };
  const result = validateGroundedExplanation(parsed, SECTIONS_FIXTURE);
  assert.equal(result.valid, true);
});

test('required: validateGroundedExplanation REJECTS an explanation citing a number never present in the normalized data (no invented figures survive)', () => {
  const parsed = {
    summary: 'Revenue grew to 999999 Cr in FY2026.',
    observations: [{ statement: 'Revenue was 999999 in FY2026', citedLabel: 'revenue', citedFinancialYear: 'FY2026', citedValue: 999999 }],
    missingSectionsNote: null,
  };
  const result = validateGroundedExplanation(parsed, SECTIONS_FIXTURE);
  assert.equal(result.valid, false);
  assert.ok(result.reason.includes('999999'));
});

test('required: validateGroundedExplanation REJECTS a fabricated observation that cites a REAL number under a WRONG label -- closes the old "value exists anywhere" bug', () => {
  // SECTIONS_FIXTURE's balanceSheet really does have total_asset=500000 for
  // FY2026. The old flat-value-Set check (buildSourceValueIndex) would have
  // accepted this: 500000 is a real number present somewhere in the digest,
  // and the old check never looked at WHICH label it was supposed to belong
  // to. The new indexed check resolves "revenue|FY2026" first (which is
  // really 250000 in this fixture) and only then compares the cited value,
  // so a real total_asset figure mislabeled as revenue must now fail.
  const parsed = {
    summary: 'TCS reported revenue of 500000 Cr in FY2026.',
    observations: [{
      statement: 'Revenue was 500000 in FY2026', citedLabel: 'revenue', citedFinancialYear: 'FY2026', citedValue: 500000,
    }],
    missingSectionsNote: null,
  };
  const result = validateGroundedExplanation(parsed, SECTIONS_FIXTURE);
  assert.equal(result.valid, false, 'a real number under the wrong label must be rejected, not just a never-seen number');
  assert.equal(result.ungroundedObservation.citedValue, 500000);
});

test('validateGroundedExplanation ACCEPTS a correctly-labeled, verified-definition citation (income-statement metric carrying verifiedLabel/verifiedDefinition)', () => {
  const sectionsWithVerifiedIncomeStatement = {
    ...SECTIONS_FIXTURE,
    incomeStatement: {
      ...SECTIONS_FIXTURE.incomeStatement,
      metrics: [
        {
          financialYear: 'FY2026', label: 'revenue', value: 271423, changePct: 4.68, providerLabel: 'revenue', verifiedDefinition: 'TOTAL_INCOME', verifiedLabel: 'Total income',
        },
      ],
    },
  };
  const parsed = {
    summary: 'TCS reported total income of 271423 Cr in FY2026.',
    observations: [{
      statement: 'Total income was 271423 Cr in FY2026 (Upstox-verified)', citedLabel: 'Total income', citedFinancialYear: 'FY2026', citedValue: 271423, statementType: 'CONSOLIDATED', definitionVerified: true,
    }],
    missingSectionsNote: null,
  };
  const result = validateGroundedExplanation(parsed, sectionsWithVerifiedIncomeStatement);
  assert.equal(result.valid, true);
});

test('validateGroundedExplanation REJECTS a citation that uses the RAW label when a verifiedLabel exists for that metric -- the model must cite the verified name, not the provider name, once one is available', () => {
  const sectionsWithVerifiedIncomeStatement = {
    ...SECTIONS_FIXTURE,
    incomeStatement: {
      ...SECTIONS_FIXTURE.incomeStatement,
      metrics: [
        {
          financialYear: 'FY2026', label: 'revenue', value: 271423, changePct: 4.68, providerLabel: 'revenue', verifiedDefinition: 'TOTAL_INCOME', verifiedLabel: 'Total income',
        },
      ],
    },
  };
  const parsed = {
    summary: 'TCS reported revenue of 271423 Cr in FY2026.',
    observations: [{
      statement: 'Revenue was 271423 Cr in FY2026', citedLabel: 'revenue', citedFinancialYear: 'FY2026', citedValue: 271423,
    }],
    missingSectionsNote: null,
  };
  const result = validateGroundedExplanation(parsed, sectionsWithVerifiedIncomeStatement);
  assert.equal(result.valid, false, 'once a verifiedLabel exists, the raw provider label is no longer a valid citation key');
});

test('validateGroundedExplanation REJECTS a correctly-valued citation that claims the wrong statement basis', () => {
  const parsed = {
    summary: 'TCS reported revenue of 250000 Cr in FY2026 on a standalone basis.',
    observations: [{
      statement: 'Revenue was 250000 in FY2026', citedLabel: 'revenue', citedFinancialYear: 'FY2026', citedValue: 250000, statementType: 'STANDALONE',
    }],
    missingSectionsNote: null,
  };
  const result = validateGroundedExplanation(parsed, SECTIONS_FIXTURE); // fixture's incomeStatement is CONSOLIDATED
  assert.equal(result.valid, false);
  assert.ok(result.reason.toLowerCase().includes('statement basis'));
});

test('required: validateGroundedExplanation REJECTS a correctly-valued ratio citation that claims the wrong unit -- closes the real HDFCBANK CASA bug class (a NUMBER ratio mislabeled as PERCENT, or vice versa)', () => {
  const parsed = {
    summary: "TCS's ROE was 45.89 in FY2026.",
    observations: [{ statement: 'ROE was 45.89', citedLabel: 'ROE', citedFinancialYear: null, citedValue: 45.89, unit: 'NUMBER' }],
    missingSectionsNote: null,
  };
  const result = validateGroundedExplanation(parsed, SECTIONS_FIXTURE); // fixture's ROE is PERCENT
  assert.equal(result.valid, false);
  assert.ok(result.reason.toLowerCase().includes('unit'));
});

test('validateGroundedExplanation ACCEPTS a ratio citation whose unit correctly matches (PERCENT with a "%" sign in the statement, NUMBER without one)', () => {
  const parsed = {
    summary: "TCS's ROE was 45.89% and P/E was 28.4 in FY2026.",
    observations: [
      { statement: 'ROE was 45.89%', citedLabel: 'ROE', citedFinancialYear: null, citedValue: 45.89, unit: 'PERCENT' },
      { statement: 'P/E was 28.4', citedLabel: 'P/E', citedFinancialYear: null, citedValue: 28.4, unit: 'NUMBER' },
    ],
    missingSectionsNote: null,
  };
  const result = validateGroundedExplanation(parsed, SECTIONS_FIXTURE);
  assert.equal(result.valid, true);
});

test('validateGroundedExplanation tolerates a purely qualitative observation that cites no number', () => {
  const parsed = {
    summary: 'The company operates in IT services.',
    observations: [{ statement: 'The company is in the IT sector', citedLabel: null, citedFinancialYear: null, citedValue: null }],
    missingSectionsNote: null,
  };
  const result = validateGroundedExplanation(parsed, SECTIONS_FIXTURE);
  assert.equal(result.valid, true);
});

const withMockedOpenAI = async (fn, responseContent) => {
  const originalGetClient = OpenAIClientFactory.getClient;
  const originalIsConfigured = OpenAIClientFactory.isConfigured;
  OpenAIClientFactory.isConfigured = () => true;
  OpenAIClientFactory.getClient = () => ({
    chat: {
      completions: {
        create: async () => ({ choices: [{ message: { content: JSON.stringify(responseContent) } }] }),
      },
    },
  });
  try {
    return await fn();
  } finally {
    OpenAIClientFactory.getClient = originalGetClient;
    OpenAIClientFactory.isConfigured = originalIsConfigured;
  }
};

test('explainCompanyFinancials returns available:true for a genuinely grounded AI response', async () => {
  const result = await withMockedOpenAI(
    () => explainCompanyFinancials('TCS', SECTIONS_FIXTURE, 'Tata Consultancy Services Ltd.'),
    {
      summary: 'TCS reported revenue of 250000 Cr in FY2026.',
      observations: [{ statement: 'Revenue was 250000 in FY2026', citedLabel: 'revenue', citedFinancialYear: 'FY2026', citedValue: 250000 }],
      missingSectionsNote: 'Cash flow, shareholding, and corporate actions were unavailable.',
    },
  );
  assert.equal(result.available, true);
  assert.equal(typeof result.summary, 'string');
});

test('required: explainCompanyFinancials WITHHOLDS an ungrounded AI response rather than passing an invented number through (HTTP-caller-safe: available:false, not a crash)', async () => {
  const result = await withMockedOpenAI(
    () => explainCompanyFinancials('TCS', SECTIONS_FIXTURE, 'Tata Consultancy Services Ltd.'),
    {
      summary: 'TCS reported revenue of 999999 Cr in FY2026.',
      observations: [{ statement: 'Revenue was 999999 in FY2026', citedLabel: 'revenue', citedFinancialYear: 'FY2026', citedValue: 999999 }],
      missingSectionsNote: null,
    },
  );
  assert.equal(result.available, false);
  assert.ok(result.reason.toLowerCase().includes('withheld') || result.reason.toLowerCase().includes('verified'));
});

test('required: explainCompanyFinancials (end-to-end, mocked OpenAI) WITHHOLDS a response that cites a REAL number under the WRONG label -- the exact old bug, closed', async () => {
  // Same shape of bug as the direct validateGroundedExplanation test above,
  // but exercised through the full explainCompanyFinancials path (real
  // OpenAI-response mocking) to prove the fix holds end-to-end, not just at
  // the unit level: balanceSheet's real total_asset=500000 is cited as if
  // it were revenue. The old flat-value-Set grounding check would have
  // accepted this (500000 is a real number somewhere in the digest); the
  // new label+period-indexed check must reject it.
  const result = await withMockedOpenAI(
    () => explainCompanyFinancials('TCS', SECTIONS_FIXTURE, 'Tata Consultancy Services Ltd.'),
    {
      summary: 'TCS reported revenue of 500000 Cr in FY2026.',
      observations: [{ statement: 'Revenue was 500000 in FY2026', citedLabel: 'revenue', citedFinancialYear: 'FY2026', citedValue: 500000 }],
      missingSectionsNote: null,
    },
  );
  assert.equal(result.available, false, 'a real figure mislabeled as a different metric must still be withheld');
  assert.ok(result.reason.toLowerCase().includes('withheld') || result.reason.toLowerCase().includes('verified'));
});

test('explainCompanyFinancials (end-to-end, mocked OpenAI) accepts a correctly-labeled verified-definition citation', async () => {
  const sectionsWithVerifiedIncomeStatement = {
    ...SECTIONS_FIXTURE,
    incomeStatement: {
      ...SECTIONS_FIXTURE.incomeStatement,
      metrics: [
        {
          financialYear: 'FY2026', label: 'revenue', value: 271423, changePct: 4.68, providerLabel: 'revenue', verifiedDefinition: 'TOTAL_INCOME', verifiedLabel: 'Total income',
        },
      ],
    },
  };
  const result = await withMockedOpenAI(
    () => explainCompanyFinancials('TCS', sectionsWithVerifiedIncomeStatement, 'Tata Consultancy Services Ltd.'),
    {
      summary: 'TCS reported total income of 271423 Cr in FY2026.',
      observations: [{
        statement: 'Total income was 271423 Cr in FY2026 (Upstox-verified)', citedLabel: 'Total income', citedFinancialYear: 'FY2026', citedValue: 271423, statementType: 'CONSOLIDATED', definitionVerified: true,
      }],
      missingSectionsNote: null,
    },
  );
  assert.equal(result.available, true);
});

test('explainCompanyFinancials degrades gracefully when OpenAI is not configured -- never throws, HTTP-200-safe', async () => {
  const originalIsConfigured = OpenAIClientFactory.isConfigured;
  OpenAIClientFactory.isConfigured = () => false;
  try {
    const result = await explainCompanyFinancials('TCS', SECTIONS_FIXTURE, 'Tata Consultancy Services Ltd.');
    assert.equal(result.available, false);
    assert.ok(result.reason);
  } finally {
    OpenAIClientFactory.isConfigured = originalIsConfigured;
  }
});

test('explainCompanyFinancials rejects an empty symbol without touching anything else', async () => {
  const result = await explainCompanyFinancials('', SECTIONS_FIXTURE, 'Tata Consultancy Services Ltd.');
  assert.equal(result.available, false);
  assert.ok(result.reason);
});
