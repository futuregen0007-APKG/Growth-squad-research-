#!/usr/bin/env node
/**
 * Search TCS Historical Documents for Verifiable Promises
 */

import axios from 'axios';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractPromisesFromDocument } from './services/PromiseExtractionService.js';

const testTcsHistoricalPromises = async () => {
  console.log('\n' + '='.repeat(80));
  console.log('TCS HISTORICAL PROMISE SEARCH');
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
  let pdfUrls = [];
  
  try {
    const irResponse = await axios.get('https://www.tcs.com/investor-relations', {
      timeout: 15000,
      maxRedirects: 5,
      headers: browserHeaders
    });

    // Find PDF links related to FY2024, FY2025, or annual reports
    const pdfLinkRegex = /href=['"]([^'"]*\.pdf[^'"]*)['"]/gi;
    const matches = [...irResponse.data.matchAll(pdfLinkRegex)];
    
    console.log(`  Found ${matches.length} PDF links\n`);
    
    // Look for FY2024, FY2025, or annual report PDFs
    for (const match of matches) {
      let url = match[1];
      const lowerUrl = url.toLowerCase();
      
      // Prioritize FY2024, FY2025, or annual report PDFs
      if (lowerUrl.includes('fy24') || lowerUrl.includes('fy25') || lowerUrl.includes('fy2024') || lowerUrl.includes('fy2025') || lowerUrl.includes('annual') || lowerUrl.includes('quarterly') || lowerUrl.includes('q1') || lowerUrl.includes('q2') || lowerUrl.includes('q3') || lowerUrl.includes('q4')) {
        if (!url.startsWith('http')) {
          if (url.startsWith('/')) {
            url = 'https://www.tcs.com' + url;
          } else {
            url = 'https://www.tcs.com/investor-relations/' + url;
          }
        }
        pdfUrls.push(url);
        console.log(`✓ Found historical PDF: ${url.substring(0, 80)}...`);
      }
    }
    
    // If no specific PDFs found, use first available PDF
    if (pdfUrls.length === 0 && matches.length > 0) {
      let url = matches[0][1];
      if (!url.startsWith('http')) {
        if (url.startsWith('/')) {
          url = 'https://www.tcs.com' + url;
        } else {
          url = 'https://www.tcs.com/investor-relations/' + url;
        }
      }
      pdfUrls.push(url);
      console.log(`✓ Using first available PDF: ${url.substring(0, 80)}...`);
    }
    
    console.log(`\n✓ Selected ${pdfUrls.length} historical PDFs\n`);
  } catch (error) {
    console.log(`✗ Failed to fetch IR page: ${error.message}\n`);
    process.exit(1);
  }

  if (pdfUrls.length === 0) {
    console.log('✗ No historical PDFs found\n');
    process.exit(1);
  }

  // Process first 2 PDFs
  const allPromises = [];
  for (let i = 0; i < Math.min(2, pdfUrls.length); i++) {
    const pdfUrl = pdfUrls[i];
    console.log(`\nSTEP ${i + 2}.${i + 1}: Processing PDF ${i + 1}...`);
    console.log(`  URL: ${pdfUrl.substring(0, 80)}...\n`);

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
          console.log(`✗ Invalid PDF signature\n`);
          continue;
        }
      } else {
        console.log(`✗ No content returned\n`);
        continue;
      }
    } catch (error) {
      console.log(`✗ Download failed: ${error.code || error.message}\n`);
      continue;
    }

    // Extract text page by page
    console.log(`  Extracting text...`);
    const pages = [];
    
    try {
      const uint8Array = new Uint8Array(pdfBuffer);
      const loadingTask = pdfjsLib.getDocument({ data: uint8Array });
      const pdfDocument = await loadingTask.promise;
      
      const numPages = pdfDocument.numPages;
      
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
      continue;
    }

    // Extract promises
    const document = {
      sourceUrl: pdfUrl,
      sourceName: `TCS Historical Document ${i + 1}`,
      sourceDate: new Date().toISOString(),
      title: `TCS Historical Document ${i + 1}`,
      pages: pages
    };
    
    const promises = extractPromisesFromDocument(document);
    allPromises.push(...promises);
    console.log(`✓ Extracted ${promises.length} promises from PDF ${i + 1}\n`);
  }

  // Display all promises
  console.log('\n' + '='.repeat(80));
  console.log('ALL EXTRACTED PROMISES:');
  console.log('='.repeat(80) + '\n');
  
  for (const promise of allPromises) {
    console.log(`Statement: ${promise.statement.substring(0, 120)}...`);
    console.log(`Metric: ${promise.metric}`);
    console.log(`Target Value: ${promise.targetValue}`);
    console.log(`Target Unit: ${promise.targetUnit}`);
    console.log(`Direction: ${promise.direction}`);
    console.log(`Period: ${promise.period}`);
    console.log(`Page: ${promise.evidence.page}`);
    console.log(`Source: ${promise.evidence.sourceDocument?.substring(0, 60)}...`);
    console.log('---\n');
  }

  console.log('='.repeat(80));
  console.log('TEST COMPLETE');
  console.log('='.repeat(80) + '\n');
};

await testTcsHistoricalPromises();
