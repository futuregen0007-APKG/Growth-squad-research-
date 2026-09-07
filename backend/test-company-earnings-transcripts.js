#!/usr/bin/env node
/**
 * Search for Earnings Call Transcripts from Supported Companies
 */

import axios from 'axios';

const testCompanyEarnings = async (symbol, irUrl) => {
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
      
      // Look for earnings call transcripts specifically
      const transcriptPdfs = matches.filter(m => {
        const url = m[1].toLowerCase();
        return url.includes('transcript') || url.includes('earnings') || url.includes('conference') || url.includes('concall');
      });
      console.log(`  Transcript PDFs: ${transcriptPdfs.length}`);
      
      if (transcriptPdfs.length > 0) {
        console.log(`  Sample transcript: ${transcriptPdfs[0][1].substring(0, 80)}...`);
        return { accessible: true, transcriptCount: transcriptPdfs.length, sample: transcriptPdfs[0][1] };
      }
      
      return { accessible: true, transcriptCount: 0 };
    }
    
    return { accessible: false, status: response.status };
  } catch (error) {
    console.log(`  Error: ${error.code || error.message}`);
    return { accessible: false, error: error.code || error.message };
  }
};

const main = async () => {
  console.log('\n' + '='.repeat(80));
  console.log('EARNINGS TRANSCRIPT ACCESSIBILITY TEST');
  console.log('='.repeat(80));

  const companies = [
    { symbol: 'INFY', url: 'https://www.infosys.com/investors/reports-filings.html' },
    { symbol: 'HDFCBANK', url: 'https://www.hdfcbank.com/personal/about-us/investor-relations/financial-results' },
    { symbol: 'ICICIBANK', url: 'https://www.icicibank.com/about-us/investor-relations/financial-results' },
    { symbol: 'BHEL', url: 'https://www.bhel.com/financial-results' },
    { symbol: 'LT', url: 'https://www.larsentoubro.com/corporate/investor-relations/financial-results' }
  ];

  const results = [];
  for (const company of companies) {
    const result = await testCompanyEarnings(company.symbol, company.url);
    results.push({ ...company, ...result });
  }

  console.log('\n' + '='.repeat(80));
  console.log('SUMMARY');
  console.log('='.repeat(80));
  
  const withTranscripts = results.filter(r => r.transcriptCount > 0);
  console.log(`\nCompanies with earnings transcripts: ${withTranscripts.length}/${results.length}`);
  
  for (const r of withTranscripts) {
    console.log(`  ${r.symbol}: ${r.transcriptCount} transcripts`);
    console.log(`    Sample: ${r.sample.substring(0, 80)}...`);
  }
  
  console.log('\n' + '='.repeat(80) + '\n');
};

await main();
