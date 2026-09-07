#!/usr/bin/env node
/**
 * Extract Promises from HDFCBANK Earnings Transcript
 */

import axios from 'axios';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractPromisesFromDocument } from './services/PromiseExtractionService.js';

const testHdfcbankTranscript = async () => {
  console.log('\n' + '='.repeat(80));
  console.log('HDFCBANK EARNINGS TRANSCRIPT PROMISE SEARCH');
  console.log('='.repeat(80) + '\n');

  const browserHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://www.hdfcbank.com/personal/about-us/investor-relations/financial-results',
    'Connection': 'keep-alive'
  };

  // Get HDFCBANK financial results page
  console.log('STEP 1: Fetching HDFCBANK financial results page...');
  let transcriptUrls = [];
  
  try {
    const irResponse = await axios.get('https://www.hdfcbank.com/personal/about-us/investor-relations/financial-results', {
      timeout: 15000,
      maxRedirects: 5,
      headers: browserHeaders
    });

    // Find PDF links related to transcripts
    const pdfLinkRegex = /href=['"]([^'"]*\.pdf[^'"]*)['"]/gi;
    const matches = [...irResponse.data.matchAll(pdfLinkRegex)];
    
    console.log(`  Found ${matches.length} PDF links\n`);
    
    // Look for transcript PDFs
    for (const match of matches) {
      let url = match[1];
      const lowerUrl = url.toLowerCase();
      
      // Prioritize transcript PDFs
      if (lowerUrl.includes('transcript') || lowerUrl.includes('earnings') || lowerUrl.includes('conference') || lowerUrl.includes('concall')) {
        if (!url.startsWith('http')) {
          if (url.startsWith('/')) {
            url = 'https://www.hdfcbank.com' + url;
          } else {
            url = 'https://www.hdfcbank.com/personal/about-us/investor-relations/financial-results/' + url;
          }
        }
        transcriptUrls.push(url);
        console.log(`✓ Found transcript: ${url.substring(0, 80)}...`);
      }
    }
    
    console.log(`\n✓ Selected ${transcriptUrls.length} transcript PDFs\n`);
  } catch (error) {
    console.log(`✗ Failed to fetch IR page: ${error.message}\n`);
    process.exit(1);
  }

  if (transcriptUrls.length === 0) {
    console.log('✗ No transcript PDFs found\n');
    process.exit(1);
  }

  // Process first transcript
  const pdfUrl = transcriptUrls[0];
  console.log(`\nSTEP 2: Processing transcript...`);
  console.log(`  URL: ${pdfUrl.substring(0, 80)}...\n`);

  let pdfBuffer = null;
  try {
    const response = await axios.get(pdfUrl, {
      timeout: 30000,
      maxRedirects: 5,
      responseType: 'arraybuffer',
      headers: browserHeaders,
      validateStatus: () => true
    });

    if (response.data.length > 0) {
      const bufferView = new Uint8Array(response.data);
      const pdfSignature = String.fromCharCode(...bufferView.slice(0, 4));
      
      if (pdfSignature === '%PDF') {
        pdfBuffer = response.data;
        console.log(`✓ PDF downloaded (${response.data.length} bytes)\n`);
      } else {
        console.log(`✗ Invalid PDF signature\n`);
        process.exit(1);
      }
    } else {
      console.log(`✗ No content returned\n`);
      process.exit(1);
    }
  } catch (error) {
    console.log(`✗ Download failed: ${error.code || error.message}\n`);
    process.exit(1);
  }

  // Extract text page by page
  console.log(`  Extracting text...`);
  const pages = [];
  
  try {
    const uint8Array = new Uint8Array(pdfBuffer);
    const loadingTask = pdfjsLib.getDocument({ data: uint8Array });
    const pdfDocument = await loadingTask.promise;
    
    const numPages = pdfDocument.numPages;
    console.log(`  Total pages: ${numPages}`);
    
    // Extract all pages
    for (let j = 1; j <= numPages; j++) {
      const page = await pdfDocument.getPage(j);
      const textContent = await page.getTextContent();
      
      const pageText = textContent.items
        .map(item => item.str)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      
      pages.push({
        pageNumber: j,
        text: pageText
      });
    }
    
    console.log(`✓ Extracted ${pages.length} pages\n`);
  } catch (error) {
    console.log(`✗ Failed to extract pages: ${error.message}\n`);
    process.exit(1);
  }

  // Extract promises
  const document = {
    sourceUrl: pdfUrl,
    sourceName: 'HDFCBANK Earnings Transcript',
    sourceDate: new Date().toISOString(),
    title: 'HDFCBANK Earnings Transcript',
    pages: pages
  };
  
  const promises = extractPromisesFromDocument(document);
  console.log(`✓ Extracted ${promises.length} promises\n`);

  // Display all promises
  console.log('\n' + '='.repeat(80));
  console.log('ALL EXTRACTED PROMISES:');
  console.log('='.repeat(80) + '\n');
  
  for (const promise of promises) {
    console.log(`Statement: ${promise.statement.substring(0, 150)}...`);
    console.log(`Metric: ${promise.metric}`);
    console.log(`Target Value: ${promise.targetValue}`);
    console.log(`Target Unit: ${promise.targetUnit}`);
    console.log(`Direction: ${promise.direction}`);
    console.log(`Period: ${promise.period}`);
    console.log(`Page: ${promise.evidence.page}`);
    console.log('---\n');
  }

  console.log('='.repeat(80));
  console.log('TEST COMPLETE');
  console.log('='.repeat(80) + '\n');
};

await testHdfcbankTranscript();
