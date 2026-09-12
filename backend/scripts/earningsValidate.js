/**
 * earningsValidate.js
 * ====================
 * `npm run earnings:validate`
 *
 * Validates every file under backend/data/earnings-intelligence/ (companies.json,
 * promises/*.json, demo/*.json) using the same loader the runtime service uses,
 * then reports every issue it found: duplicate record ids, incompatible units,
 * invalid dates, unsupported/blocked evidence domains, missing evidence, and any
 * other schema/business-rule violation. Exits non-zero if any CURATED_VERIFIED
 * record failed validation, so it can gate CI.
 */
import { reloadCuratedDataset, listSupportedCompanies } from '../services/CuratedEarningsIntelligenceService.js';

const summary = reloadCuratedDataset();

console.log('Earnings Intelligence curated dataset validation');
console.log('='.repeat(60));
console.log(`Supported stocks (from SUPPORTED_STOCKS): ${listSupportedCompanies().length}`);
console.log(`Companies with a curated coverage override: ${summary.companies}`);
console.log(`Companies with verified promise records: ${summary.verifiedCompanies}`);
console.log(`Companies with demo/synthetic records: ${summary.demoCompanies}`);
console.log(`Loaded at: ${summary.loadedAt}`);
console.log('');

if (summary.issues.length === 0) {
  console.log('No validation issues found. All curated files are valid.');
  process.exit(0);
}

console.log(`Found ${summary.issues.length} issue(s):`);
console.log('-'.repeat(60));
for (const issue of summary.issues) {
  const label = issue.recordId ? `${issue.symbol} / ${issue.recordId}` : issue.symbol;
  if (issue.errors) {
    console.log(`[REJECTED] ${label}`);
    for (const error of issue.errors) console.log(`    - ${error}`);
  } else if (issue.error) {
    console.log(`[ERROR] ${label}: ${issue.error}`);
  }
}

console.log('');
console.log('Validation FAILED -- one or more curated records were rejected. See details above.');
process.exit(1);
