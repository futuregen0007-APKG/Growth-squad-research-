import test from 'node:test';
import assert from 'node:assert/strict';
import { getCompanyResearchBundle } from '../services/CompanyResearchService.js';

class FakeProvider {
  get providerName() { return 'fake-provider'; }
  get isConfigured() { return true; }
  async getCompanyProfile() { return { supported: true, provider: 'fake-provider', data: { identity: { companyName: 'Fake Co' } }, provenance: { fetchedAt: new Date().toISOString() } }; }
  async getFinancials() { throw new Error('upstream financials endpoint failed'); }
  async getKeyMetrics() { return { supported: false, capability: 'getKeyMetrics', provider: 'fake-provider', reason: 'not supported' }; }
  async getShareholding() { return { supported: true, provider: 'fake-provider', data: [{ period: 'FY2025' }], provenance: { fetchedAt: new Date().toISOString() } }; }
  async getCorporateActions() { return { supported: true, provider: 'fake-provider', data: [], provenance: { fetchedAt: new Date().toISOString() } }; }
  async getAnalystData() { return { supported: true, provider: 'fake-provider', data: null, provenance: { fetchedAt: new Date().toISOString() } }; }
  async getCompanyNews() { return { supported: true, provider: 'fake-provider', data: [], provenance: { fetchedAt: new Date().toISOString() } }; }
}

test('getCompanyResearchBundle: a single failing section never hides the sections that succeeded', async () => {
  const bundle = await getCompanyResearchBundle('ZZTESTCO', { provider: new FakeProvider() });

  assert.equal(bundle.sections.profile.available, true);
  assert.equal(bundle.sections.profile.data.identity.companyName, 'Fake Co');

  assert.equal(bundle.sections.financials.available, false);
  assert.equal(bundle.sections.financials.error.message, 'upstream financials endpoint failed');

  assert.equal(bundle.sections.keyMetrics.available, false);
  assert.equal(bundle.sections.keyMetrics.error.code, 'UNSUPPORTED_CAPABILITY');

  assert.equal(bundle.sections.shareholding.available, true);
  assert.equal(bundle.sections.shareholding.data.length, 1);
});

test('getCompanyResearchBundle: no provider configured returns an honest unavailable state for every section, never a crash', async () => {
  const bundle = await getCompanyResearchBundle('ZZTESTCO', { provider: null });
  for (const section of Object.values(bundle.sections)) {
    assert.equal(section.available, false);
    assert.equal(section.error.code, 'CONFIGURATION_ERROR');
    assert.equal(section.data, null);
  }
});

test('getCompanyResearchBundle never includes a provider secret in its response', async () => {
  const bundle = await getCompanyResearchBundle('ZZTESTCO', { provider: new FakeProvider() });
  const serialized = JSON.stringify(bundle);
  assert.equal(serialized.toLowerCase().includes('apikey'), false);
  assert.equal(serialized.toLowerCase().includes('x-api-key'), false);
});
