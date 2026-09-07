#!/usr/bin/env node
/**
 * Test TCS Promise Outcome Verification
 * Tests the new official document outcome search for the TCS employee-percentage promise
 */

import { searchActualOutcomes } from './services/ManagementPromiseService.js';
import { getCompanyResearchProfile } from './research/CompanyResearchProfiles.js';
import { calculatePromiseStatus } from './services/ManagementPromiseService.js';

const testTcsOutcomeVerification = async () => {
  console.log('\n' + '='.repeat(80));
  console.log('TCS PROMISE OUTCOME VERIFICATION TEST');
  console.log('='.repeat(80) + '\n');

  // TCS profile
  const symbol = 'TCS';
  const profile = getCompanyResearchProfile(symbol);
  
  console.log('STEP 1: TCS Company Profile');
  console.log(`  Symbol: ${profile.symbol}`);
  console.log(`  Company: ${profile.companyName}`);
  console.log(`  Sector: ${profile.sector}\n`);

  // The TCS promise extracted from Q1 FY27 earnings call
  // Using a past date to enable outcome search testing
  const promise = {
    statement: 'But going forward, we would definitely target to have the definition that we come up with, and target to have at least 1% of our employee base...',
    metric: 'EMPLOYEE_PERCENTAGE',
    targetValue: 1,
    targetUnit: 'PERCENTAGE',
    targetPeriod: 'GOING_FORWARD',
    direction: 'AT_LEAST',
    operator: 'GTE',
    promiseDate: '2024-01-01T00:00:00.000Z', // Past date to enable outcome search
    exactManagementStatement: 'target to have at least 1% of our employee base'
  };

  console.log('STEP 2: TCS Promise Details');
  console.log(`  Statement: ${promise.statement.substring(0, 80)}...`);
  console.log(`  Metric: ${promise.metric}`);
  console.log(`  Target Value: ${promise.targetValue} ${promise.targetUnit}`);
  console.log(`  Target Period: ${promise.targetPeriod}`);
  console.log(`  Direction: ${promise.direction}`);
  console.log(`  Operator: ${promise.operator}`);
  console.log(`  Promise Date: ${promise.promiseDate}\n`);

  // Search for actual outcome
  console.log('STEP 3: Searching for actual outcome in official documents...');
  const outcome = await searchActualOutcomes(profile, promise);

  if (!outcome) {
    console.log('✗ No outcome found\n');
    console.log('STEP 4: Verification Status');
    console.log(`  Status: INSUFFICIENT_EVIDENCE`);
    console.log(`  Reason: No actual value found in official documents or news\n`);
  } else if (outcome.isPending) {
    console.log('✓ Outcome is pending');
    console.log(`  Reason: ${outcome.outcomeStatement}\n`);
    console.log('STEP 4: Verification Status');
    console.log(`  Status: PENDING`);
    console.log(`  Reason: ${outcome.outcomeStatement}\n`);
  } else {
    console.log('✓ Outcome found');
    console.log(`  Actual Value: ${outcome.actualValue} ${outcome.actualUnit}`);
    console.log(`  Actual Period: ${outcome.actualPeriod}`);
    console.log(`  Outcome Statement: ${outcome.outcomeStatement.substring(0, 80)}...`);
    console.log(`  Outcome Source: ${outcome.outcomeSource}`);
    console.log(`  Outcome Source URL: ${outcome.outcomeSourceUrl?.substring(0, 60)}...`);
    console.log(`  Outcome Source Date: ${outcome.outcomeSourceDate}`);
    console.log(`  Page: ${outcome.page || 'N/A'}\n`);

    // Calculate verification status
    console.log('STEP 4: Calculating verification status...');
    const verification = calculatePromiseStatus({
      targetValue: promise.targetValue,
      actualValue: outcome.actualValue,
      operator: promise.operator,
      direction: promise.direction,
      metric: promise.metric,
      targetPeriod: promise.targetPeriod,
      targetUnit: promise.targetUnit,
      actualUnit: outcome.actualUnit
    });

    console.log(`  Achievement Percentage: ${verification.achievementPercentage}%`);
    console.log(`  Status: ${verification.status}`);
    console.log(`  Calculation: ${verification.calculationExplanation}\n`);
  }

  console.log('='.repeat(80));
  console.log('TEST COMPLETE');
  console.log('='.repeat(80) + '\n');
};

await testTcsOutcomeVerification();
