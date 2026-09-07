#!/usr/bin/env node
/**
 * Phase 7: Test TCS Research Pipeline with PromiseExtractionService Integration
 */

import mongoose from 'mongoose';
import { refreshCompanyResearch } from './services/ManagementPromiseService.js';
import ManagementPromise from './models/ManagementPromise.js';

const testTCSResearch = async () => {
  console.log('\n' + '='.repeat(80));
  console.log('PHASE 7 TCS RESEARCH PIPELINE TEST');
  console.log('='.repeat(80) + '\n');

  // Connect to database
  if (mongoose.connection.readyState !== 1) {
    try {
      await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/stock-market-ai');
      console.log('✓ Database connected\n');
    } catch (error) {
      console.log('✗ Database connection failed:', error.message);
      process.exit(1);
    }
  }

  const symbol = 'TCS';
  
  // Check existing promises before research
  const beforeCount = await ManagementPromise.countDocuments({ symbol, dataOrigin: 'REAL_RESEARCH' });
  console.log(`Existing TCS promises before research: ${beforeCount}`);

  try {
    console.log('\nStarting TCS research pipeline...\n');
    const result = await refreshCompanyResearch(symbol);
    
    console.log('\n' + '='.repeat(80));
    console.log('RESEARCH RESULT');
    console.log('='.repeat(80) + '\n');
    console.log(JSON.stringify(result, null, 2));
    
    // Check promises after research
    const afterCount = await ManagementPromise.countDocuments({ symbol, dataOrigin: 'REAL_RESEARCH' });
    console.log(`\n\nExisting TCS promises after research: ${afterCount}`);
    console.log(`New promises created: ${afterCount - beforeCount}`);
    
    // Get sample promises
    const samplePromises = await ManagementPromise.find({ symbol, dataOrigin: 'REAL_RESEARCH' }).limit(5).lean();
    console.log('\n' + '='.repeat(80));
    console.log('SAMPLE PROMISES');
    console.log('='.repeat(80) + '\n');
    samplePromises.forEach((p, idx) => {
      console.log(`Promise ${idx + 1}:`);
      console.log(`  Statement: ${p.promise?.statement || p.promiseText}`);
      console.log(`  Metric: ${p.promise?.metric}`);
      console.log(`  Target: ${p.promise?.targetValue} ${p.promise?.targetUnit}`);
      console.log(`  Period: ${p.promise?.targetPeriod}`);
      console.log(`  Status: ${p.verification?.status}`);
      console.log(`  Source: ${p.evidence?.promiseSource?.sourceUrl}`);
      console.log('');
    });
    
    console.log('\n' + '='.repeat(80));
    console.log('TEST SUMMARY');
    console.log('='.repeat(80));
    console.log(`✓ Research completed successfully`);
    console.log(`✓ Total promises in database: ${afterCount}`);
    console.log(`✓ New promises created: ${afterCount - beforeCount}`);
    
    if (afterCount > beforeCount) {
      console.log('✓ SUCCESS: New promises were persisted');
    } else if (afterCount > 0) {
      console.log('⚠ WARNING: No new promises, but existing promises found');
    } else {
      console.log('✗ FAILURE: No promises in database');
    }
    
  } catch (error) {
    console.log('\n✗ Research failed:', error.message);
    console.log(error.stack);
  } finally {
    await mongoose.disconnect();
    console.log('\nDatabase disconnected\n');
  }

  process.exit(0);
};

await testTCSResearch();
