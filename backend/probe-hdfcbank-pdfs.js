#!/usr/bin/env node
/**
 * Quick HDFCBANK IR Page Probe
 * Check what PDF URLs are actually discoverable
 */

import axios from 'axios';

const probeHdfcbankIr = async () => {
  console.log('\n' + '='.repeat(80));
  console.log('HDFCBANK IR PAGE PROBE');
  console.log('='.repeat(80) + '\n');

  const irUrl = 'https://www.hdfcbank.com/personal/about-us/investor-relations';

  try {
    const response = await axios.get(irUrl, {
      timeout: 20000,
      maxRedirects: 5,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    const content = response.data;
    console.log(`✓ IR page fetched: ${response.status}`);
    console.log(`✓ Content size: ${content.length} bytes\n`);

    // Extract PDF links
    const pdfLinkRegex = /href=['"]([^'"]*\.pdf[^'"]*)['"]/gi;
    const pdfLinks = [];
    let match;
    
    while ((match = pdfLinkRegex.exec(content)) !== null) {
      const url = match[1];
      // Normalize URLs
      const fullUrl = url.startsWith('http') ? url : 
                      url.startsWith('/') ? 'https://www.hdfcbank.com' + url :
                      'https://www.hdfcbank.com/personal/about-us/investor-relations/' + url;
      
      if (!pdfLinks.includes(fullUrl)) {
        pdfLinks.push(fullUrl);
      }
    }

    console.log(`✓ PDF links found: ${pdfLinks.length}\n`);
    
    if (pdfLinks.length > 0) {
      console.log('First 5 PDF links:');
      for (let i = 0; i < Math.min(5, pdfLinks.length); i++) {
        const shortUrl = pdfLinks[i].length > 70 ? 
          pdfLinks[i].substring(0, 67) + '...' : 
          pdfLinks[i];
        console.log(`  ${i + 1}. ${shortUrl}`);
      }

      // Try to download first few and check headers
      console.log('\n' + '='.repeat(80));
      console.log('TESTING FIRST 3 PDF URLS (headers only)');
      console.log('='.repeat(80) + '\n');

      for (let i = 0; i < Math.min(3, pdfLinks.length); i++) {
        const url = pdfLinks[i];
        try {
          const response = await axios.head(url, {
            timeout: 15000,
            maxRedirects: 5,
            validateStatus: () => true
          });

          const displayUrl = url.length > 60 ? url.substring(0, 57) + '...' : url;
          console.log(`${i + 1}. ${displayUrl}`);
          console.log(`   Status: ${response.status}`);
          console.log(`   Content-Type: ${response.headers['content-type'] || 'unknown'}`);
          console.log(`   Content-Length: ${response.headers['content-length'] || 'unknown'}`);
        } catch (error) {
          console.log(`${i + 1}. Error: ${error.code}`);
        }

        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

  } catch (error) {
    console.log(`✗ Error: ${error.message}`);
  }

  console.log('\n');
};

await probeHdfcbankIr();
