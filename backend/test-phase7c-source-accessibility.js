#!/usr/bin/env node
/**
 * Phase 7C: Lightweight Source Accessibility Test
 * Tests document acquisition for TCS, NEWGEN, HDFCBANK without LLM extraction
 */

import { collectDocuments } from './research/DocumentResearchService.js';

const testCompany = async (symbol) => {
  console.log('\n' + '='.repeat(80));
  console.log(`SOURCE ACCESSIBILITY TEST: ${symbol}`);
  console.log('='.repeat(80) + '\n');

  const startTime = Date.now();
  const debugState = {
    urlsAttempted: [],
    urlsSuccessfullyRetrieved: [],
    failedUrls: [],
    documentsDiscovered: [],
    linksDiscovered: 0,
    pdfsDiscovered: [],
    pdfsSuccessfullyExtracted: [],
    rejectedDocuments: [],
    countsByProvider: {},
    tlsFailures: [],
    tlsSummary: {
      totalTlsErrors: 0,
      uniqueUrlsWithTlsErrors: []
    }
  };

  try {
    const result = await collectDocuments(symbol, debugState);
    const duration = Date.now() - startTime;

    // Count IR pages attempted/successful
    const irUrlsAttempted = debugState.urlsAttempted.filter(url => 
      url.includes('investor-relations') || 
      url.includes('investors') ||
      url.includes('annual-reports')
    );
    const irUrlsSuccessful = debugState.urlsSuccessfullyRetrieved.filter(url =>
      url.includes('investor-relations') ||
      url.includes('investors') ||
      url.includes('annual-reports')
    );

    // Count PDF URLs discovered
    const pdfUrlsDiscovered = debugState.pdfsDiscovered.length;
    
    // Count PDFs downloaded and extracted
    const pdfsDownloaded = debugState.pdfsSuccessfullyExtracted.length;

    // Count documents passing quality gate
    const documentsPassingQualityGate = result.documents.length;

    // Count documents with meaningful management content
    const managementKeywords = ['guidance', 'target', 'expect', 'outlook', 'forecast', 'projection', 'order book', 'margin guidance', 'revenue guidance'];
    const documentsWithManagementContent = result.documents.filter(doc => {
      const text = (doc.text || '').toLowerCase();
      return managementKeywords.some(keyword => text.includes(keyword));
    }).length;

    // Provider errors
    const providerErrors = debugState.failedUrls.map(f => ({
      url: f.url,
      code: f.code,
      reason: f.reason
    }));

    // Rejection breakdown
    const rejectionBreakdown = {};
    for (const rejected of debugState.rejectedDocuments) {
      const reason = rejected.reason || 'UNKNOWN';
      rejectionBreakdown[reason] = (rejectionBreakdown[reason] || 0) + 1;
    }

    console.log(`IR Pages Attempted: ${irUrlsAttempted.length}`);
    console.log(`IR Pages Successfully Fetched: ${irUrlsSuccessful.length}`);
    console.log(`Official Document URLs Discovered: ${result.documents.length}`);
    console.log(`PDF URLs Discovered: ${pdfUrlsDiscovered}`);
    console.log(`PDFs Successfully Downloaded: ${pdfsDownloaded}`);
    console.log(`PDFs Successfully Text Extracted: ${debugState.pdfsSuccessfullyExtracted.length}`);
    console.log(`Documents Passing Quality Gate: ${documentsPassingQualityGate}`);
    console.log(`Documents with Meaningful Management Content: ${documentsWithManagementContent}`);
    console.log(`Provider Errors: ${providerErrors.length}`);
    console.log(`Total Duration: ${(duration / 1000).toFixed(2)}s`);

    if (providerErrors.length > 0) {
      console.log('\nProvider Errors:');
      providerErrors.slice(0, 5).forEach(err => {
        console.log(`  - ${err.code}: ${err.reason}`);
      });
      if (providerErrors.length > 5) {
        console.log(`  ... and ${providerErrors.length - 5} more`);
      }
    }

    if (Object.keys(rejectionBreakdown).length > 0) {
      console.log('\nRejection Breakdown:');
      Object.entries(rejectionBreakdown).forEach(([reason, count]) => {
        console.log(`  - ${reason}: ${count}`);
      });
    }

    if (documentsWithManagementContent > 0) {
      console.log('\nSample Document with Management Content:');
      const sampleDoc = result.documents.find(doc => {
        const text = (doc.text || '').toLowerCase();
        return managementKeywords.some(keyword => text.includes(keyword));
      });
      if (sampleDoc) {
        console.log(`  URL: ${sampleDoc.url}`);
        console.log(`  Title: ${sampleDoc.title}`);
        console.log(`  Type: ${sampleDoc.sourceType}`);
        console.log(`  Text Length: ${sampleDoc.text?.length || 0}`);
        console.log(`  Excerpt: ${(sampleDoc.text || '').substring(0, 200)}...`);
      }
    }

    return {
      symbol,
      irPagesAttempted: irUrlsAttempted.length,
      irPagesSuccessfullyFetched: irUrlsSuccessful.length,
      officialDocumentsFound: result.documents.length,
      pdfUrlsDiscovered,
      pdfsDownloaded,
      pdfsTextExtracted: debugState.pdfsSuccessfullyExtracted.length,
      documentsPassingQualityGate: documentsPassingQualityGate,
      documentsWithManagementContent,
      providerErrors: providerErrors.length,
      duration: duration / 1000,
      rejectionBreakdown
    };

  } catch (error) {
    const duration = Date.now() - startTime;
    console.log(`Error: ${error.message}`);
    return {
      symbol,
      irPagesAttempted: 0,
      irPagesSuccessfullyFetched: 0,
      officialDocumentsFound: 0,
      pdfUrlsDiscovered: 0,
      pdfsDownloaded: 0,
      pdfsTextExtracted: 0,
      documentsPassingQualityGate: 0,
      documentsWithManagementContent: 0,
      providerErrors: 1,
      duration: duration / 1000,
      rejectionBreakdown: {},
      error: error.message
    };
  }
};

const main = async () => {
  console.log('\n' + '='.repeat(80));
  console.log('PHASE 7C - SOURCE ACCESSIBILITY COMPARISON');
  console.log('='.repeat(80));

  const companies = ['TCS', 'NEWGEN', 'HDFCBANK'];
  const results = [];

  for (const symbol of companies) {
    const result = await testCompany(symbol);
    results.push(result);
  }

  console.log('\n' + '='.repeat(80));
  console.log('COMPARISON TABLE');
  console.log('='.repeat(80) + '\n');

  console.log('Company'.padEnd(12) + 
             'IR Access'.padEnd(10) + 
             'Docs Found'.padEnd(12) + 
             'PDF URLs'.padEnd(10) + 
             'PDFs DL'.padEnd(10) + 
             'Quality Gate'.padEnd(13) + 
             'Mgmt Content'.padEnd(13) + 
             'Duration'.padEnd(10));
  console.log('-'.repeat(100));

  for (const result of results) {
    console.log(
      result.symbol.padEnd(12) +
      `${result.irPagesSuccessfullyFetched}/${result.irPagesAttempted}`.padEnd(10) +
      String(result.officialDocumentsFound).padEnd(12) +
      String(result.pdfUrlsDiscovered).padEnd(10) +
      String(result.pdfsDownloaded).padEnd(10) +
      String(result.documentsPassingQualityGate).padEnd(13) +
      String(result.documentsWithManagementContent).padEnd(13) +
      `${result.duration.toFixed(1)}s`.padEnd(10)
    );
  }

  console.log('\n' + '='.repeat(80));
  console.log('RECOMMENDATION');
  console.log('='.repeat(80) + '\n');

  const bestCompany = results
    .filter(r => r.documentsWithManagementContent > 0)
    .sort((a, b) => b.documentsWithManagementContent - a.documentsWithManagementContent)[0];

  if (bestCompany) {
    console.log(`Recommended validation company: ${bestCompany.symbol}`);
    console.log(`  - Documents with management content: ${bestCompany.documentsWithManagementContent}`);
    console.log(`  - Documents passing quality gate: ${bestCompany.documentsPassingQualityGate}`);
    console.log(`  - PDFs successfully extracted: ${bestCompany.pdfsTextExtracted}`);
  } else {
    console.log('No company has documents with meaningful management content.');
    console.log('Recommendation: Investigate alternative document sources or providers.');
  }

  process.exit(0);
};

await main();
