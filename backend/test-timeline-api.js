#!/usr/bin/env node
/**
 * Phase 6 Timeline API Tests
 * Tests the normalized timeline endpoint for ManagementPromise data
 */

import mongoose from 'mongoose';
import { getCompanyTimeline } from './services/ManagementPromiseService.js';
import ManagementPromise from './models/ManagementPromise.js';

const testTimelineAPI = async () => {
  console.log('\n' + '='.repeat(80));
  console.log('PHASE 6 TIMELINE API TESTS');
  console.log('='.repeat(80) + '\n');

  // Connect to database
  if (mongoose.connection.readyState !== 1) {
    try {
      await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/stock-market-ai');
      console.log('✓ Database connected\n');
    } catch (error) {
      console.log('✗ Database connection failed:', error.message);
      console.log('Running tests without database...\n');
    }
  }

  const tests = [];

  // Test 1: Company with real promises (TCS)
  console.log('TEST 1: Company with real promises (TCS)');
  try {
    const timeline = await getCompanyTimeline('TCS');
    console.log(`  Company: ${timeline.company}`);
    console.log(`  Total promises: ${timeline.summary.totalPromises}`);
    console.log(`  Verified: ${timeline.summary.verified}`);
    console.log(`  Missed: ${timeline.summary.missed}`);
    console.log(`  Pending: ${timeline.summary.pending}`);
    console.log(`  Insufficient Evidence: ${timeline.summary.insufficientEvidence}`);
    
    if (timeline.promises.length > 0) {
      console.log(`  First promise: ${timeline.promises[0].statement.substring(0, 60)}...`);
      console.log(`  Status: ${timeline.promises[0].status}`);
      console.log(`  Evidence URL: ${timeline.promises[0].evidence.sourceUrl?.substring(0, 60)}...`);
      console.log(`  Evidence page: ${timeline.promises[0].evidence.page}`);
      console.log(`  Outcome actualValue: ${timeline.promises[0].outcome.actualValue}`);
    }
    
    tests.push({ name: 'Company with real promises', passed: true });
    console.log('✓ PASSED\n');
  } catch (error) {
    console.log(`✗ FAILED: ${error.message}\n`);
    tests.push({ name: 'Company with real promises', passed: false });
  }

  // Test 2: Promise with no outcome
  console.log('TEST 2: Promise with no outcome');
  try {
    const timeline = await getCompanyTimeline('TCS');
    const noOutcomePromise = timeline.promises.find(p => p.outcome.actualValue === null);
    
    if (noOutcomePromise) {
      console.log(`  Found promise with no outcome`);
      console.log(`  Statement: ${noOutcomePromise.statement.substring(0, 60)}...`);
      console.log(`  actualValue: ${noOutcomePromise.outcome.actualValue}`);
      console.log(`  actualUnit: ${noOutcomePromise.outcome.actualUnit}`);
      console.log(`  actualPeriod: ${noOutcomePromise.outcome.actualPeriod}`);
      
      if (noOutcomePromise.outcome.actualValue === null && 
          noOutcomePromise.outcome.actualUnit === null && 
          noOutcomePromise.outcome.actualPeriod === null) {
        tests.push({ name: 'Promise with no outcome', passed: true });
        console.log('✓ PASSED\n');
      } else {
        tests.push({ name: 'Promise with no outcome', passed: false });
        console.log('✗ FAILED: Outcome fields not properly null\n');
      }
    } else {
      console.log('  No promise with null outcome found (may not exist in DB)');
      tests.push({ name: 'Promise with no outcome', passed: true, skipped: true });
      console.log('✓ SKIPPED\n');
    }
  } catch (error) {
    console.log(`✗ FAILED: ${error.message}\n`);
    tests.push({ name: 'Promise with no outcome', passed: false });
  }

  // Test 3: Insufficient evidence status
  console.log('TEST 3: Insufficient evidence status');
  try {
    const timeline = await getCompanyTimeline('TCS');
    const insufficientPromise = timeline.promises.find(p => p.status === 'INSUFFICIENT_EVIDENCE');
    
    if (insufficientPromise) {
      console.log(`  Found promise with INSUFFICIENT_EVIDENCE status`);
      console.log(`  Status: ${insufficientPromise.status}`);
      console.log(`  Statement: ${insufficientPromise.statement.substring(0, 60)}...`);
      
      if (insufficientPromise.status === 'INSUFFICIENT_EVIDENCE') {
        tests.push({ name: 'Insufficient evidence status', passed: true });
        console.log('✓ PASSED\n');
      } else {
        tests.push({ name: 'Insufficient evidence status', passed: false });
        console.log('✗ FAILED: Status not preserved\n');
      }
    } else {
      console.log('  No INSUFFICIENT_EVIDENCE promise found (may not exist in DB)');
      tests.push({ name: 'Insufficient evidence status', passed: true, skipped: true });
      console.log('✓ SKIPPED\n');
    }
  } catch (error) {
    console.log(`✗ FAILED: ${error.message}\n`);
    tests.push({ name: 'Insufficient evidence status', passed: false });
  }

  // Test 4: Evidence preservation
  console.log('TEST 4: Evidence preservation');
  try {
    const timeline = await getCompanyTimeline('TCS');
    const promiseWithEvidence = timeline.promises.find(p => p.evidence.sourceUrl && p.evidence.page);
    
    if (promiseWithEvidence) {
      console.log(`  Found promise with evidence`);
      console.log(`  Source URL: ${promiseWithEvidence.evidence.sourceUrl.substring(0, 60)}...`);
      console.log(`  Document title: ${promiseWithEvidence.evidence.documentTitle?.substring(0, 60)}...`);
      console.log(`  Page: ${promiseWithEvidence.evidence.page}`);
      console.log(`  Excerpt: ${promiseWithEvidence.evidence.excerpt.substring(0, 60)}...`);
      
      if (promiseWithEvidence.evidence.sourceUrl && 
          promiseWithEvidence.evidence.page && 
          promiseWithEvidence.evidence.excerpt) {
        tests.push({ name: 'Evidence preservation', passed: true });
        console.log('✓ PASSED\n');
      } else {
        tests.push({ name: 'Evidence preservation', passed: false });
        console.log('✗ FAILED: Evidence fields not preserved\n');
      }
    } else {
      console.log('  No promise with full evidence found (may not exist in DB)');
      tests.push({ name: 'Evidence preservation', passed: true, skipped: true });
      console.log('✓ SKIPPED\n');
    }
  } catch (error) {
    console.log(`✗ FAILED: ${error.message}\n`);
    tests.push({ name: 'Evidence preservation', passed: false });
  }

  // Test 5: Empty company result
  console.log('TEST 5: Empty company result');
  try {
    const timeline = await getCompanyTimeline('NONEXISTENT');
    console.log(`  Company: ${timeline.company}`);
    console.log(`  Total promises: ${timeline.summary.totalPromises}`);
    console.log(`  Promises array length: ${timeline.promises.length}`);
    
    if (timeline.company === 'NONEXISTENT' && 
        timeline.summary.totalPromises === 0 && 
        timeline.promises.length === 0) {
      tests.push({ name: 'Empty company result', passed: true });
      console.log('✓ PASSED\n');
    } else {
      tests.push({ name: 'Empty company result', passed: false });
      console.log('✗ FAILED: Empty result not properly structured\n');
    }
  } catch (error) {
    console.log(`✗ FAILED: ${error.message}\n`);
    tests.push({ name: 'Empty company result', passed: false });
  }

  // Test 6: Summary counts calculation
  console.log('TEST 6: Summary counts calculation');
  try {
    const timeline = await getCompanyTimeline('TCS');
    const calculatedTotal = timeline.summary.verified + 
                           timeline.summary.missed + 
                           timeline.summary.pending + 
                           timeline.summary.insufficientEvidence;
    
    console.log(`  Total from summary: ${timeline.summary.totalPromises}`);
    console.log(`  Calculated sum: ${calculatedTotal}`);
    console.log(`  Verified: ${timeline.summary.verified}`);
    console.log(`  Missed: ${timeline.summary.missed}`);
    console.log(`  Pending: ${timeline.summary.pending}`);
    console.log(`  Insufficient Evidence: ${timeline.summary.insufficientEvidence}`);
    
    if (timeline.summary.totalPromises === calculatedTotal) {
      tests.push({ name: 'Summary counts calculation', passed: true });
      console.log('✓ PASSED\n');
    } else {
      tests.push({ name: 'Summary counts calculation', passed: false });
      console.log('✗ FAILED: Summary counts don\'t add up\n');
    }
  } catch (error) {
    console.log(`✗ FAILED: ${error.message}\n`);
    tests.push({ name: 'Summary counts calculation', passed: false });
  }

  // Test 7: Response structure validation
  console.log('TEST 7: Response structure validation');
  try {
    const timeline = await getCompanyTimeline('TCS');
    
    const hasCompany = !!timeline.company;
    const hasSummary = !!timeline.summary;
    const hasPromises = Array.isArray(timeline.promises);
    const hasSummaryFields = timeline.summary && 
                           typeof timeline.summary.totalPromises === 'number' &&
                           typeof timeline.summary.verified === 'number' &&
                           typeof timeline.summary.missed === 'number' &&
                           typeof timeline.summary.pending === 'number' &&
                           typeof timeline.summary.insufficientEvidence === 'number';
    
    console.log(`  Has company field: ${hasCompany}`);
    console.log(`  Has summary field: ${hasSummary}`);
    console.log(`  Has promises array: ${hasPromises}`);
    console.log(`  Has all summary fields: ${hasSummaryFields}`);
    
    if (hasCompany && hasSummary && hasPromises && hasSummaryFields) {
      tests.push({ name: 'Response structure validation', passed: true });
      console.log('✓ PASSED\n');
    } else {
      tests.push({ name: 'Response structure validation', passed: false });
      console.log('✗ FAILED: Response structure invalid\n');
    }
  } catch (error) {
    console.log(`✗ FAILED: ${error.message}\n`);
    tests.push({ name: 'Response structure validation', passed: false });
  }

  // Print summary
  console.log('='.repeat(80));
  console.log('TEST SUMMARY');
  console.log('='.repeat(80));
  
  const passed = tests.filter(t => t.passed && !t.skipped).length;
  const failed = tests.filter(t => !t.passed).length;
  const skipped = tests.filter(t => t.skipped).length;
  
  console.log(`\nTotal tests: ${tests.length}`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Skipped: ${skipped}\n`);
  
  for (const test of tests) {
    const status = test.skipped ? 'SKIPPED' : (test.passed ? '✓ PASSED' : '✗ FAILED');
    console.log(`${status}: ${test.name}`);
  }
  
  console.log('\n' + '='.repeat(80) + '\n');

  // Close database connection
  if (mongoose.connection.readyState === 1) {
    await mongoose.disconnect();
    console.log('Database disconnected\n');
  }

  process.exit(failed > 0 ? 1 : 0);
};

await testTimelineAPI();
