#!/usr/bin/env node
/**
 * Test HDFCBANK PDF with comprehensive browser simulation
 */

import axios from 'axios';

const testWithBrowserHeaders = async () => {
  console.log('\n' + '='.repeat(80));
  console.log('HDFCBANK PDF DOWNLOAD WITH BROWSER SIMULATION');
  console.log('='.repeat(80) + '\n');

  // Get a PDF URL from the IR page
  console.log('STEP 1: Fetching IR page...');
  let pdfUrl = null;
  
  try {
    const irResponse = await axios.get('https://www.hdfcbank.com/personal/about-us/investor-relations', {
      timeout: 20000,
      maxRedirects: 5,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    const pdfLinkRegex = /href=['"]([^'"]*\.pdf[^'"]*)['"]/i;
    const match = pdfLinkRegex.exec(irResponse.data);
    
    if (match) {
      const url = match[1];
      pdfUrl = url.startsWith('http') ? url : 
               url.startsWith('/') ? 'https://www.hdfcbank.com' + url :
               'https://www.hdfcbank.com/personal/about-us/investor-relations/' + url;
      console.log(`✓ Found PDF\n`);
    }
  } catch (error) {
    console.log(`✗ Failed: ${error.message}\n`);
    process.exit(1);
  }

  if (!pdfUrl) {
    console.log('✗ No PDF found\n');
    process.exit(1);
  }

  // Test with comprehensive browser headers
  const browserHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Referer': 'https://www.hdfcbank.com/personal/about-us/investor-relations',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin'
  };

  console.log('STEP 2: Attempting PDF download...');
  
  try {
    const response = await axios.get(pdfUrl, {
      timeout: 20000,
      maxRedirects: 5,
      responseType: 'arraybuffer',
      headers: browserHeaders,
      validateStatus: () => true
    });

    console.log(`✓ Status: ${response.status}`);
    console.log(`✓ Content-Type: ${response.headers['content-type']}`);
    console.log(`✓ Content-Length: ${response.data.length} bytes`);

    if (response.data.length > 0) {
      // Check if it's PDF
      const bufferView = new Uint8Array(response.data);
      const pdfSignature = String.fromCharCode(...bufferView.slice(0, 4));
      
      if (pdfSignature === '%PDF') {
        console.log(`✓ Valid PDF signature detected`);
        console.log(`\n✓✓✓ SUCCESS: Retrieved ${response.data.length} bytes of PDF content`);
      } else {
        console.log(`✗ Content is not a valid PDF`);
        console.log(`   First 100 bytes: ${response.data.slice(0, 100).toString('utf8', 0, 100)}`);
      }
    } else {
      console.log(`✗ No content returned`);
    }

  } catch (error) {
    console.log(`✗ Download failed: ${error.code || error.message}`);
  }

  console.log('\n');
};

await testWithBrowserHeaders();
