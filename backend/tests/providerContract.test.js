import test from 'node:test';
import assert from 'node:assert/strict';
import { CompanyResearchProvider } from '../providers/contracts/CompanyResearchProvider.js';
import { IndianApiProvider } from '../providers/indian-api/IndianApiProvider.js';

/**
 * Phase 12 contract tests: any future CompanyResearchProvider (Global
 * Datafeeds included) must satisfy these. Run this same suite against a
 * new provider by adding it to CANDIDATE_PROVIDERS.
 */
const CANDIDATE_PROVIDERS = [
  { name: 'IndianApiProvider', instance: new IndianApiProvider({ apiKey: 'test-key' }) },
];

const REQUIRED_METHODS = [
  'resolveCompany', 'getCompanyProfile', 'getFinancials', 'getKeyMetrics',
  'getShareholding', 'getCorporateActions', 'getAnalystData', 'getCompanyNews', 'getOutcomeEvidence',
];

for (const { name, instance } of CANDIDATE_PROVIDERS) {
  test(`${name} extends CompanyResearchProvider`, () => {
    assert.ok(instance instanceof CompanyResearchProvider);
  });

  test(`${name} implements every required capability method`, () => {
    for (const method of REQUIRED_METHODS) {
      assert.equal(typeof instance[method], 'function', `${name}.${method} must be a function`);
    }
  });

  test(`${name} exposes a stable, non-empty providerName`, () => {
    assert.equal(typeof instance.providerName, 'string');
    assert.ok(instance.providerName.length > 0);
  });
}

test('CompanyResearchProvider base class returns a structured unsupported result instead of throwing for an unimplemented capability', async () => {
  class MinimalProvider extends CompanyResearchProvider {
    get providerName() { return 'minimal-test-provider'; }
  }
  const provider = new MinimalProvider();
  const result = await provider.getShareholding('ANY');
  assert.equal(result.supported, false);
  assert.equal(result.provider, 'minimal-test-provider');
  assert.equal(result.capability, 'getShareholding');
});
