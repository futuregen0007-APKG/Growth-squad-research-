#!/usr/bin/env node
/**
 * Evaluate TCS and INFY for Phase 5B Alternative
 */

import axios from 'axios';

const testCompanyDocs = async () => {
  console.log('\n' + '='.repeat(80));
  console.log('ALTERNATIVE COMPANY EVALUATION - TCS & INFY');
  console.log('='.repeat(80) + '\n');

  const companies = [
    { name: 'TCS', url: 'https://www.tcs.com/investor-relations', exchange: 'NSE: TCS, BSE: 532540' },
    { name: 'INFY', url: 'https://www.infigoal.com/investors', exchange: 'NSE: INFY, BSE: 500209' }
  ];

  const browserHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate',
    'Connection': 'keep-alive'
  };

  for (const company of companies) {
    console.log(`\n${'─'.repeat(80)}`);
    console.log(`Company: ${company.name} (${company.exchange})`);
    console.log(`${'─'.repeat(80)}`);

    try {
      const response = await axios.get(company.url, {
        timeout: 15000,
        maxRedirects: 5,
        headers: browserHeaders
      });

      console.log(`✓ Main page: ${response.status}`);
      console.log(`  Size: ${response.data.length} bytes`);

      // Look for PDF links
      const pdfMatch = response.data.match(/\.pdf/gi);
      const pdfLinkMatch = response.data.match(/href=['"][^'"]*\.pdf[^'"]*['"]/gi);
      console.log(`  PDF references: ${pdfMatch ? pdfMatch.length : 0}`);
      console.log(`  Direct PDF links: ${pdfLinkMatch ? pdfLinkMatch.length : 0}`);

      // Look for alternate document access patterns
      const annualReportMatch = response.data.match(/annual.?report|financials|investor.?report/gi);
      console.log(`  Document keywords: ${annualReportMatch ? annualReportMatch.length : 0}`);

      // Extract first few potential links
      if (pdfLinkMatch && pdfLinkMatch.length > 0) {
        console.log(`  Sample PDF links:`);
        const unique = new Set();
        for (const link of pdfLinkMatch.slice(0, 3)) {
          const url = link.replace(/href=['"]|['"]$/g, '');
          if (!unique.has(url)) {
            unique.add(url);
            const display = url.length > 70 ? url.substring(0, 67) + '...' : url;
            console.log(`    - ${display}`);
          }
        }
      }

    } catch (error) {
      console.log(`✗ Error: ${error.code || error.message}`);
    }

    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  console.log('\n');
};

await testCompanyDocs();
