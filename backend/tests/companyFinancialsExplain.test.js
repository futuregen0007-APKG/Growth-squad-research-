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
    ratios: [{ name: 'P/E', companyValue: 28.4, sectorValue: 24.1 }],
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
