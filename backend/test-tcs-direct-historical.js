#!/usr/bin/env node
/**
 * Direct Access to TCS Historical Annual Reports
 */

import axios from 'axios';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractPromisesFromDocument } from './services/PromiseExtractionService.js';

const testTcsDirectHistorical = async () => {
  console.log('\n' + '='.repeat(80));
  console.log('TCS DIRECT HISTORICAL DOCUMENT ACCESS');
  console.log('='.repeat(80) + '\n');

  const browserHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://www.tcs.com/investor-relations',
    'Connection': 'keep-alive'
  };

  // Known TCS annual report URL patterns
  const historicalPdfUrls = [
    'https://www.tcs.com/content/dam/tcs/investor-relations/financial-statements/2024-25/annual-report/TCS-Annual-Report-2024-25.pdf',
    'https://www.tcs.com/content/dam/tcs/investor-relations/financial-statements/2023-24/annual-report/TCS-Annual-Report-2023-24.pdf',
    'https://www.tcs.com/investor-relations/annual-reports'
  ];

  console.log('STEP 1: Testing known historical TCS PDF URLs...\n');

  for (const pdfUrl of historicalPdfUrls) {
    console.log(`Testing: ${pdfUrl.substring(0, 80)}...`);
    
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
          console.log(`✓ PDF accessible (${response.data.length} bytes)\n`);
          
          // Extract text
          console.log(`  Extracting text...`);
          const pages = [];
          
          try {
            const uint8Array = new Uint8Array(pdfBuffer);
            const loadingTask = pdfjsLib.getDocument({ data: uint8Array });
            const pdfDocument = await loadingTask.promise;
            
            const numPages = pdfDocument.numPages;
            console.log(`  Total pages: ${numPages}`);
            
            // Extract first 10 pages for quick scan
            for (let j = 1; j <= Math.min(10, numPages); j++) {
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
            
            // Extract promises
            const document = {
              sourceUrl: pdfUrl,
              sourceName: 'TCS Annual Report',
              sourceDate: new Date().toISOString(),
              title: 'TCS Annual Report',
              pages: pages
            };
            
            const promises = extractPromisesFromDocument(document);
            console.log(`✓ Extracted ${promises.length} promises\n`);
            
            if (promises.length > 0) {
              console.log('PROMISES FOUND:');
              console.log('-'.repeat(80));
              for (const promise of promises) {
                console.log(`Statement: ${promise.statement.substring(0, 100)}...`);
                console.log(`Metric: ${promise.metric}`);
                console.log(`Target: ${promise.targetValue} ${promise.targetUnit}`);
                console.log(`Direction: ${promise.direction}`);
                console.log(`Period: ${promise.period}`);
                console.log(`Page: ${promise.evidence.page}`);
                console.log('---');
              }
              console.log('');
            }
            
            // If we found promises, stop
            if (promises.length > 0) {
              console.log('✓✓✓ Found promises in historical document');
              break;
            }
            
          } catch (error) {
            console.log(`✗ Failed to extract: ${error.message}\n`);
          }
        } else {
          console.log(`✗ Not a PDF\n`);
        }
      } else {
        console.log(`✗ No content\n`);
      }
    } catch (error) {
      console.log(`✗ Failed: ${error.code || error.message}\n`);
    }
  }

  console.log('='.repeat(80));
  console.log('TEST COMPLETE');
  console.log('='.repeat(80) + '\n');
};

await testTcsDirectHistorical();
