#!/usr/bin/env node
/**
 * Phase 7: Inspect collected documents for TCS
 */

import mongoose from 'mongoose';
import { collectDocuments } from './research/DocumentResearchService.js';

const inspectDocuments = async () => {
  console.log('\n' + '='.repeat(80));
  console.log('PHASE 7 DOCUMENT INSPECTION FOR TCS');
  console.log('='.repeat(80) + '\n');

  const symbol = 'TCS';

  try {
    const result = await collectDocuments(symbol);
    
    console.log('Document Collection Summary:');
    console.log(`  Total documents: ${result.documents.length}`);
    console.log(`  Stats:`, result.stats);
    console.log(`  Providers:`, result.stats.providers);
    
    console.log('\n' + '='.repeat(80));
    console.log('DOCUMENT DETAILS');
    console.log('='.repeat(80) + '\n');
    
    result.documents.forEach((doc, idx) => {
      console.log(`Document ${idx + 1}:`);
      console.log(`  Type: ${doc.sourceType}`);
      console.log(`  Source: ${doc.sourceName}`);
      console.log(`  URL: ${doc.sourceUrl}`);
      console.log(`  Title: ${doc.title}`);
      console.log(`  Text length: ${doc.text?.length || 0}`);
      console.log(`  Has pages: ${doc.pages?.length || 0}`);
      console.log(`  Excerpt: ${doc.excerpt?.substring(0, 200)}...`);
      console.log('');
    });
    
    // Test PromiseExtractionService on these documents
    console.log('\n' + '='.repeat(80));
    console.log('TESTING PROMISE EXTRACTION ON COLLECTED DOCUMENTS');
    console.log('='.repeat(80) + '\n');
    
    const { extractPromisesFromDocument } = await import('./services/PromiseExtractionService.js');
    
    let totalPromises = 0;
    result.documents.forEach((doc, idx) => {
      const promises = extractPromisesFromDocument(doc);
      console.log(`Document ${idx + 1} (${doc.sourceType}): ${promises.length} promises found`);
      if (promises.length > 0) {
        promises.forEach((p, pIdx) => {
          console.log(`  Promise ${pIdx + 1}: ${p.statement.substring(0, 80)}...`);
          console.log(`    Metric: ${p.metric}, Target: ${p.targetValue} ${p.targetUnit}`);
        });
      }
      totalPromises += promises.length;
    });
    
    console.log(`\nTotal promises extracted: ${totalPromises}`);
    
  } catch (error) {
    console.log('Error:', error.message);
    console.log(error.stack);
  }

  process.exit(0);
};

await inspectDocuments();
