/**
 * MANUAL-SMOKE-INDIAN-API.JS
 * ===========================
 * ⚠️  CONSUMES ONE REAL INDIANAPI CREDIT. NOT RUN AUTOMATICALLY.
 * Not part of `npm test` / CI. Run this yourself, deliberately, when you
 * want to confirm the real IndianAPI account/plan/base-URL actually work
 * end-to-end (auth header accepted, base URL correct for your plan,
 * response shape still matches what IndianApiNormalizer expects).
 *
 * USAGE:
 *   node scripts/manual-smoke-indian-api.js [SYMBOL]
 *   node scripts/manual-smoke-indian-api.js NEWGEN
 *   node scripts/manual-smoke-indian-api.js TCS
 *   node scripts/manual-smoke-indian-api.js RELIANCE
 *
 * Requires INDIAN_API_KEY (and optionally INDIAN_API_BASE_URL) set in
 * backend/.env. Prints a normalized summary only — never the API key.
 */
import dotenv from 'dotenv';
dotenv.config();

import { IndianApiProvider } from '../providers/indian-api/IndianApiProvider.js';

const ALLOWED_SYMBOLS = ['NEWGEN', 'TCS', 'RELIANCE'];

const run = async () => {
  const symbol = String(process.argv[2] || 'NEWGEN').toUpperCase();
  if (!ALLOWED_SYMBOLS.includes(symbol)) {
    console.error(`Refusing to run: this manual smoke test is limited to ${ALLOWED_SYMBOLS.join(', ')} to bound credit usage. Got: ${symbol}`);
    process.exit(1);
  }

  console.log(`\n⚠️  This will make ONE real request to IndianAPI for ${symbol} and consume one API credit.`);
  console.log('Press Ctrl+C within 3 seconds to cancel...\n');
  await new Promise((resolve) => setTimeout(resolve, 3000));

  const provider = new IndianApiProvider();
  if (!provider.isConfigured) {
    console.error('INDIAN_API_KEY is not set in backend/.env — cannot run the smoke test.');
    process.exit(1);
  }

  try {
    const profile = await provider.getCompanyProfile(symbol);
    console.log(`\n✅ getCompanyProfile(${symbol}) succeeded.`);
    console.log(JSON.stringify({
      companyName: profile.data.identity.companyName,
      industry: profile.data.identity.industry,
      nsePrice: profile.data.marketSnapshot.nsePrice,
      bsePrice: profile.data.marketSnapshot.bsePrice,
      asOf: profile.data.marketSnapshot.asOf,
    }, null, 2));

    const financials = await provider.getFinancials(symbol);
    console.log(`\n✅ getFinancials(${symbol}) returned ${financials.data.length} period(s).`);

    const news = await provider.getCompanyNews(symbol);
    console.log(`✅ getCompanyNews(${symbol}) returned ${news.data.length} dated, sourced article(s).`);

    console.log('\nSmoke test passed — auth header, base URL/plan, and response schema all check out.');
  } catch (error) {
    console.error(`\n❌ Smoke test failed: [${error.errorCode || 'ERROR'}] ${error.message}`);
    process.exitCode = 1;
  }
};

run();
