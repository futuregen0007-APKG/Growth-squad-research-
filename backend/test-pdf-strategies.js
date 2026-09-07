#!/usr/bin/env node
/**
 * Test HDFCBANK PDF download with various strategies
 */

import axios from 'axios';

const testPdfDownload = async () => {
  console.log('\n' + '='.repeat(80));
  console.log('HDFCBANK PDF DOWNLOAD STRATEGIES');
  console.log('='.repeat(80) + '\n');

  // Get a PDF URL from the IR page first
  console.log('STEP 1: Fetching IR page to find PDFs...');
  let pdfUrl = null;
  
  try {
    const irResponse = await axios.get('https://www.hdfcbank.com/personal/about-us/investor-relations', {
      timeout: 20000,
      maxRedirects: 5,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    const pdfLinkRegex = /href=['"]([^'"]*\.pdf[^'"]*)['"]/i;
    const match = pdfLinkRegex.exec(irResponse.data);
    
    if (match) {
      const url = match[1];
      pdfUrl = url.startsWith('http') ? url : 
               url.startsWith('/') ? 'https://www.hdfcbank.com' + url :
               'https://www.hdfcbank.com/personal/about-us/investor-relations/' + url;
      console.log(`✓ Found PDF: ${pdfUrl.substring(0, 80)}...\n`);
    }
  } catch (error) {
    console.log(`✗ Failed to fetch IR page: ${error.message}\n`);
    process.exit(1);
  }

  if (!pdfUrl) {
    console.log('✗ No PDF found in IR page\n');
    process.exit(1);
  }

  // Test different strategies
  const strategies = [
    {
      name: 'Basic GET (30s timeout)',
      config: { timeout: 30000, maxRedirects: 5 }
    },
    {
      name: 'Short timeout (10s)',
      config: { timeout: 10000, maxRedirects: 5 }
    },
    {
      name: 'Browser headers',
      config: {
        timeout: 15000,
        maxRedirects: 5,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': 'https://www.hdfcbank.com/personal/about-us/investor-relations',
          'Connection': 'keep-alive'
        }
      }
    },
    {
      name: 'Stream response',
      config: {
        timeout: 15000,
        maxRedirects: 5,
        stream: true,
        headers: { 'User-Agent': 'Mozilla/5.0' }
      }
    }
  ];

  for (const strategy of strategies) {
    process.stdout.write(`Testing: ${strategy.name}... `);
    try {
      const response = await axios.get(pdfUrl, { ...strategy.config, validateStatus: () => true });
      const size = response.data ? 
                   (typeof response.data === 'string' ? response.data.length : 
                    Buffer.isBuffer(response.data) ? response.data.length : 0) : 0;
      console.log(`✓ Status ${response.status}, Size: ${size} bytes`);
    } catch (error) {
      console.log(`✗ ${error.code || error.message}`);
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  console.log('\n');
};

await testPdfDownload();
