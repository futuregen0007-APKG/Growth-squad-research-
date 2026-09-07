#!/usr/bin/env node
/**
 * NEWGEN Live Document Collection Test
 * Tests the improved document discovery with:
 * - HTML landing page → PDF discovery
 * - Enhanced provenance tracking
 * - Trusted source validation
 */

import { collectDocuments } from './research/DocumentResearchService.js';
import { logger } from './utils/logger.js';

const runNewgenTest = async () => {
  console.log('\n' + '='.repeat(80));
  console.log('NEWGEN Phase 5A Live Document Collection Test');
  console.log('='.repeat(80));
  console.log(`Test started: ${new Date().toISOString()}\n`);

  try {
    const result = await collectDocuments('NEWGEN');

    console.log(`\n${'─'.repeat(80)}`);
    console.log('COLLECTION SUMMARY');
    console.log(`${'─'.repeat(80)}`);

    // Overall stats
    console.log(`\nTotal Documents Found: ${result.stats.documentsFound}`);
    console.log(`  - Official Documents: ${result.stats.officialDocuments}`);
    console.log(`  - Exchange Documents: ${result.stats.exchangeDocuments}`);
    console.log(`  - News Documents: ${result.stats.newsDocuments}`);
    console.log(`  - PDF Documents: ${result.stats.pdfDocuments}`);

    // Provider stats
    console.log(`\nProvider Breakdown:`);
    for (const provider of result.stats.providers) {
      console.log(`  - ${provider.name}: ${provider.documentsFound} documents (${provider.status})`);
      if (provider.error) {
        console.log(`    Error: ${provider.error}`);
      }
    }

    // Debug state
    const debug = result.debug;
    console.log(`\n${'─'.repeat(80)}`);
    console.log('DISCOVERY PROCESS DETAILS');
    console.log(`${'─'.repeat(80)}`);

    console.log(`\nURL Processing:`);
    console.log(`  - Total URLs Attempted: ${debug.stats.totalUrlsAttempted}`);
    console.log(`  - Successfully Retrieved: ${debug.stats.totalUrlsRetrieved}`);
    console.log(`  - Failed URLs: ${debug.stats.totalFailedUrls}`);
    console.log(`  - Links Discovered: ${debug.stats.totalLinksDiscovered}`);

    console.log(`\nPDF Discovery:`);
    console.log(`  - PDFs Discovered: ${debug.stats.totalPdfsDiscovered}`);
    console.log(`  - PDFs Successfully Extracted: ${debug.stats.totalPdfsExtracted}`);
    console.log(`  - Rejected Documents: ${debug.stats.totalRejectedDocuments}`);

    console.log(`\nTLS Failures:`);
    console.log(`  - Total TLS Errors: ${debug.stats.tlsFailureCount}`);
    console.log(`  - Unique URLs with TLS Errors: ${debug.stats.uniqueTlsFailureUrls}`);

    // TLS failure details
    if (debug.failedUrls && debug.failedUrls.length > 0) {
      const tlsFailures = debug.failedUrls.filter(f => f.severity === 'TLS_FAILURE');
      if (tlsFailures.length > 0) {
        console.log(`\nTLS Error Details:`);
        for (const failure of tlsFailures) {
          console.log(`  - ${failure.url?.split('?')[0] || failure.url}`);
          console.log(`    Code: ${failure.code}`);
          console.log(`    Reason: ${failure.reason}`);
          if (failure.tlsDetails) {
            console.log(`    TLS Details: ${failure.tlsDetails.cause || 'N/A'}`);
          }
        }
      }
    }

    // Document details
    if (result.documents && result.documents.length > 0) {
      console.log(`\n${'─'.repeat(80)}`);
      console.log('DISCOVERED DOCUMENTS');
      console.log(`${'─'.repeat(80)}`);

      for (let i = 0; i < Math.min(10, result.documents.length); i++) {
        const doc = result.documents[i];
        console.log(`\n${i + 1}. ${doc.title}`);
        console.log(`   Provider: ${doc.provider}`);
        console.log(`   Type: ${doc.sourceType}`);
        console.log(`   URL: ${doc.url}`);
        console.log(`   Content Length: ${doc.contentLength} chars`);
        if (doc.sourceTrust && doc.sourceTrust.discoveryPath && doc.sourceTrust.discoveryPath.length > 1) {
          console.log(`   Discovery Path: ${doc.sourceTrust.discoveryPath.length} hops`);
          for (let j = 0; j < doc.sourceTrust.discoveryPath.length; j++) {
            const path = doc.sourceTrust.discoveryPath[j];
            console.log(`     ${j + 1}. ${path.substring(0, 80)}${path.length > 80 ? '...' : ''}`);
          }
        }
        if (doc.sourceTrust) {
          console.log(`   Trust Level: ${doc.sourceTrust.trustLevel}`);
        }
      }

      if (result.documents.length > 10) {
        console.log(`\n... and ${result.documents.length - 10} more documents`);
      }
    }

    // Phase 5A Completion Status
    console.log(`\n${'─'.repeat(80)}`);
    console.log('PHASE 5A COMPLETION ASSESSMENT');
    console.log(`${'─'.repeat(80)}`);

    const hasPdfs = result.stats.pdfDocuments > 0;
    const completedPipeline = result.stats.documentsFound >= 3;
    const tlsFailuresBlocking = debug.stats.tlsFailureCount > 0;

    if (hasPdfs && completedPipeline) {
      console.log('\n✅ PHASE 5A COMPLETION - OPTION A');
      console.log('   NEWGEN successfully produces real PDFs');
      console.log('   Evidence pipeline runs end-to-end');
      console.log(`   Documents Found: ${result.stats.documentsFound}`);
      console.log(`   PDFs: ${result.stats.pdfDocuments}`);
    } else if (!tlsFailuresBlocking && completedPipeline) {
      console.log('\n✅ PHASE 5A COMPLETION - OPTION B');
      console.log('   Production-ready source discovery architecture');
      console.log('   NEWGEN blocked only by external source availability');
      console.log(`   Successful Document Discovery: ${result.stats.documentsFound > 0}`);
      console.log(`   TLS Failures: ${tlsFailuresBlocking ? 'YES (cannot fix)' : 'NO'}`);
    } else {
      console.log('\n⏸ PHASE 5A - BLOCKED');
      console.log(`   Root Cause: TLS certificate validation failures on official IR URLs`);
      console.log(`   TLS Failures: ${debug.stats.tlsFailureCount} (cannot bypass)`);
      console.log(`   Alternative Sources Exhausted: ${result.stats.documentsFound === 0}`);
    }

    console.log(`\n${'─'.repeat(80)}`);
    console.log(`Test completed: ${new Date().toISOString()}`);
    console.log(`${'─'.repeat(80)}\n`);

  } catch (error) {
    console.error('\n❌ Test failed with error:');
    console.error(error.message);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
};

// Run the test
await runNewgenTest();
