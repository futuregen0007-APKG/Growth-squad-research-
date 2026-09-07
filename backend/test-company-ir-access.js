#!/usr/bin/env node
/**
 * Test IR Page Accessibility for Supported Companies
 */

import axios from 'axios';

const testCompanyIR = async (symbol, irUrl) => {
  console.log(`\nTesting ${symbol}...`);
  console.log(`  URL: ${irUrl}`);
  
  try {
    const response = await axios.get(irUrl, {
      timeout: 15000,
      maxRedirects: 5,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      validateStatus: () => true
    });

    console.log(`  Status: ${response.status}`);
    
    if (response.status === 200) {
      const pdfLinkRegex = /href=['"]([^'"]*\.pdf[^'"]*)['"]/gi;
      const matches = [...response.data.matchAll(pdfLinkRegex)];
      console.log(`  PDF links found: ${matches.length}`);
      
      // Look for annual report or quarterly results
      const relevantPdfs = matches.filter(m => {
        const url = m[1].toLowerCase();
        return url.includes('annual') || url.includes('quarterly') || url.includes('result') || url.includes('earnings');
      });
      console.log(`  Relevant PDFs: ${relevantPdfs.length}`);
      
      if (relevantPdfs.length > 0) {
        console.log(`  Sample PDF: ${relevantPdfs[0][1].substring(0, 80)}...`);
      }
      
      return { accessible: true, pdfCount: matches.length, relevantCount: relevantPdfs.length };
    }
    
    return { accessible: false, status: response.status };
  } catch (error) {
    console.log(`  Error: ${error.code || error.message}`);
    return { accessible: false, error: error.code || error.message };
  }
};

const main = async () => {
  console.log('\n' + '='.repeat(80));
  console.log('IR PAGE ACCESSIBILITY TEST');
  console.log('='.repeat(80));

  const companies = [
    { symbol: 'INFY', url: 'https://www.infosys.com/investors.html' },
    { symbol: 'HDFCBANK', url: 'https://www.hdfcbank.com/personal/about-us/investor-relations' },
    { symbol: 'ICICIBANK', url: 'https://www.icicibank.com/about-us/investor-relations' },
    { symbol: 'BHEL', url: 'https://www.bhel.com/investor-relations' },
    { symbol: 'NEWGEN', url: 'https://newgensoft.com/investor-relations/' },
    { symbol: 'LT', url: 'https://www.larsentoubro.com/investors' },
    { symbol: 'HAL', url: 'https://hal-india.co.in/investor-relations' }
  ];

  const results = [];
  for (const company of companies) {
    const result = await testCompanyIR(company.symbol, company.url);
    results.push({ ...company, ...result });
  }

  console.log('\n' + '='.repeat(80));
  console.log('SUMMARY');
  console.log('='.repeat(80));
  
  const accessible = results.filter(r => r.accessible);
  console.log(`\nAccessible IR pages: ${accessible.length}/${results.length}`);
  
  for (const r of accessible) {
    console.log(`  ${r.symbol}: ${r.pdfCount} PDFs, ${r.relevantCount} relevant`);
  }
  
  console.log('\n' + '='.repeat(80) + '\n');
};

await main();
