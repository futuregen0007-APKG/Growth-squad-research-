#!/usr/bin/env node
/**
 * Test TCS PDF Promise Extraction with Page Boundaries
 */

import axios from 'axios';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractPromisesFromDocument } from './services/PromiseExtractionService.js';

const testTcsPromiseExtraction = async () => {
  console.log('\n' + '='.repeat(80));
  console.log('TCS PDF PROMISE EXTRACTION TEST');
  console.log('='.repeat(80) + '\n');

  const browserHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://www.tcs.com/investor-relations',
    'Connection': 'keep-alive'
  };

  // Get TCS IR page and extract PDFs
  console.log('STEP 1: Fetching TCS IR page...');
  let pdfUrl = null;
  
  try {
    const irResponse = await axios.get('https://www.tcs.com/investor-relations', {
      timeout: 15000,
      maxRedirects: 5,
      headers: browserHeaders
    });

    // Find PDF links related to earnings call or Q1 FY27
    const pdfLinkRegex = /href=['"]([^'"]*\.pdf[^'"]*)['"]/gi;
    const matches = [...irResponse.data.matchAll(pdfLinkRegex)];
    
    console.log(`  Found ${matches.length} PDF links\n`);
    
    // Look for earnings call or Q1 FY27 related PDF
    for (const match of matches) {
      let url = match[1];
      const lowerUrl = url.toLowerCase();
      
      // Prioritize earnings call or Q1 FY27 PDFs
      if (lowerUrl.includes('earnings') || lowerUrl.includes('q1') || lowerUrl.includes('fy27') || lowerUrl.includes('quarterly')) {
        if (!url.startsWith('http')) {
          if (url.startsWith('/')) {
            url = 'https://www.tcs.com' + url;
          } else {
            url = 'https://www.tcs.com/investor-relations/' + url;
          }
        }
        pdfUrl = url;
        console.log(`✓ Found earnings-related PDF: ${url.substring(0, 80)}...\n`);
        break;
      }
    }
    
    // If no earnings PDF found, use the first PDF
    if (!pdfUrl && matches.length > 0) {
      let url = matches[0][1];
      if (!url.startsWith('http')) {
        if (url.startsWith('/')) {
          url = 'https://www.tcs.com' + url;
        } else {
          url = 'https://www.tcs.com/investor-relations/' + url;
        }
      }
      pdfUrl = url;
      console.log(`✓ Using first PDF: ${url.substring(0, 80)}...\n`);
    }
  } catch (error) {
    console.log(`✗ Failed to fetch IR page: ${error.message}\n`);
    process.exit(1);
  }

  if (!pdfUrl) {
    console.log('✗ No PDF found\n');
    process.exit(1);
  }

  // Download PDF
  console.log('STEP 2: Downloading PDF...');
  console.log(`  URL: ${pdfUrl}\n`);

  let pdfBuffer = null;
  try {
    const response = await axios.get(pdfUrl, {
      timeout: 20000,
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
        console.log(`✗ Invalid PDF signature: ${pdfSignature}\n`);
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

  // Extract text page by page using pdfjs-dist
  console.log('STEP 3: Extracting text page by page...');
  const pages = [];
  
  try {
    const uint8Array = new Uint8Array(pdfBuffer);
    const loadingTask = pdfjsLib.getDocument({ data: uint8Array });
    const pdfDocument = await loadingTask.promise;
    
    const numPages = pdfDocument.numPages;
    console.log(`  Total pages: ${numPages}\n`);
    
    for (let i = 1; i <= numPages; i++) {
      const page = await pdfDocument.getPage(i);
      const textContent = await page.getTextContent();
      
      const pageText = textContent.items
        .map(item => item.str)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      
      pages.push({
        pageNumber: i,
        text: pageText
      });
      
      if (i % 5 === 0 || i === numPages) {
        console.log(`  Extracted page ${i}/${numPages} (${pageText.length} chars)`);
      }
    }
    
    console.log(`\n✓ Extracted ${pages.length} pages\n`);
  } catch (error) {
    console.log(`✗ Failed to extract pages: ${error.message}\n`);
    process.exit(1);
  }

  // Pass to PromiseExtractionService
  console.log('STEP 4: Extracting promises using PromiseExtractionService...');
  
  const document = {
    sourceUrl: pdfUrl,
    sourceName: 'TCS Q1 FY27 Earnings Call',
    sourceDate: new Date().toISOString(),
    title: 'TCS Q1 FY27 Earnings Call',
    pages: pages
  };
  
  const promises = extractPromisesFromDocument(document);
  
  console.log(`✓ Extracted ${promises.length} promises\n`);
  
  // Display promises
  if (promises.length > 0) {
    console.log('EXTRACTED PROMISES:');
    console.log('-'.repeat(80));
    
    for (const promise of promises) {
      console.log(`\nStatement: ${promise.statement.substring(0, 100)}...`);
      console.log(`Metric: ${promise.metric}`);
      console.log(`Target Value: ${promise.targetValue}`);
      console.log(`Target Unit: ${promise.targetUnit}`);
      console.log(`Direction: ${promise.direction}`);
      console.log(`Period: ${promise.period}`);
      console.log(`Page: ${promise.evidence.page}`);
      console.log(`Confidence: ${promise.confidence}`);
    }
    
    console.log('\n' + '-'.repeat(80) + '\n');
  } else {
    console.log('No promises found.\n');
  }

  // Verify specific promise
  console.log('STEP 5: Verifying expected promise...');
  const expectedPromise = promises.find(p => 
    p.metric === 'EMPLOYEE_PERCENTAGE' &&
    p.targetValue === 1 &&
    p.period === 'GOING_FORWARD'
  );
  
  if (expectedPromise) {
    console.log('✓✓✓ SUCCESS: Found expected promise');
    console.log(`  Statement: ${expectedPromise.statement.substring(0, 80)}...`);
    console.log(`  Metric: ${expectedPromise.metric}`);
    console.log(`  Target Value: ${expectedPromise.targetValue}`);
    console.log(`  Period: ${expectedPromise.period}`);
    console.log(`  Page: ${expectedPromise.evidence.page}`);
    console.log(`  Confidence: ${expectedPromise.confidence}\n`);
    
    // Verify page number is 13
    if (expectedPromise.evidence.page === 13) {
      console.log('✓ Page number matches expected (13)\n');
    } else {
      console.log(`⚠ Page number is ${expectedPromise.evidence.page}, expected 13\n`);
    }
  } else {
    console.log('✗ Expected promise not found\n');
  }

  // Verify historical statements are not classified as promises
  console.log('STEP 6: Verifying historical statements are excluded...');
  const historicalKeywords = ['grew', 'grown', 'increased', 'decreased', 'declined', 'reported', 'stood at', 'was', 'were', 'rose', 'fell'];
  const historicalPromises = promises.filter(p => 
    historicalKeywords.some(kw => p.statement.toLowerCase().includes(kw))
  );
  
  if (historicalPromises.length === 0) {
    console.log('✓ No historical statements classified as promises\n');
  } else {
    console.log(`✗ Found ${historicalPromises.length} historical statements classified as promises:\n`);
    historicalPromises.forEach(p => {
      console.log(`  - ${p.statement.substring(0, 80)}...`);
    });
    console.log('');
  }

  console.log('='.repeat(80));
  console.log('TEST COMPLETE');
  console.log('='.repeat(80) + '\n');
};

await testTcsPromiseExtraction();
