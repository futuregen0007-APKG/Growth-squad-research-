#!/usr/bin/env node
/**
 * Evaluate Phase 5B Candidates - Document Availability
 */

import axios from 'axios';
import { SUPPORTED_STOCKS } from './utils/constants.js';

const candidates = {
  TCS: {
    name: 'Tata Consultancy Services',
    sector: 'IT / Software',
    primaryUrl: 'https://www.tcs.com/investor-relations',
    secondaryUrls: [
      'https://www.tcs.com/investor-relations/financial-results',
      'https://www.tcs.com/investor-relations/annual-reports'
    ]
  },
  HDFCBANK: {
    name: 'HDFC Bank',
    sector: 'Banking',
    primaryUrl: 'https://www.hdfcbank.com/personal/about-us/investor-relations',
    secondaryUrls: [
      'https://www.hdfcbank.com/personal/about-us/investor-relations/financial-results',
      'https://www.hdfcbank.com/personal/about-us/investor-relations/annual-reports'
    ]
  },
  INFY: {
    name: 'Infosys',
    sector: 'IT / Software',
    primaryUrl: 'https://www.infosys.com/investors.html',
    secondaryUrls: [
      'https://www.infosys.com/investors/reports-filings.html',
      'https://www.infosys.com/investors/reports-filings/annual-report.html'
    ]
  }
};

const evaluateCandidate = async (symbol, data) => {
  console.log(`\n${'─'.repeat(80)}`);
  console.log(`${symbol}: ${data.name} (${data.sector})`);
  console.log(`${'─'.repeat(80)}`);

  const evaluation = {
    symbol,
    name: data.name,
    sector: data.sector,
    primaryAccessible: false,
    secondaryAccessible: 0,
    totalUrls: 1 + data.secondaryUrls.length,
    pdfIndicators: 0,
    guidance: 'UNKNOWN'
  };

  // Test primary URL
  try {
    const response = await axios.get(data.primaryUrl, {
      timeout: 15000,
      maxRedirects: 5,
      validateStatus: () => true,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    if (response.status >= 200 && response.status < 400) {
      evaluation.primaryAccessible = true;
      const content = (response.data || '').toLowerCase();
      
      // Check for indicators
      const pdfCount = (content.match(/\.pdf/g) || []).length;
      evaluation.pdfIndicators = pdfCount;
      
      console.log(`\n✓ Primary URL accessible (${response.status})`);
      console.log(`  Content size: ${(response.data || '').length} bytes`);
      console.log(`  PDF references found: ${pdfCount}`);

      // Check for guidance keywords
      const guidanceKeywords = [
        'guidance', 'outlook', 'target', 'expects', 'projects',
        'management commentary', 'forecast', 'will grow', 'foresee'
      ];
      const hasGuidance = guidanceKeywords.some(kw => content.includes(kw));
      if (hasGuidance) {
        evaluation.guidance = 'LIKELY';
        console.log(`  Guidance indicators found: Yes`);
      }
    }
  } catch (error) {
    console.log(`✗ Primary URL error: ${error.code || error.message}`);
  }

  // Test secondary URLs
  for (const url of data.secondaryUrls) {
    try {
      const response = await axios.get(url, {
        timeout: 10000,
        maxRedirects: 3,
        validateStatus: () => true,
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });

      if (response.status >= 200 && response.status < 400) {
        evaluation.secondaryAccessible++;
        const label = url.split('/').pop() || url;
        console.log(`✓ ${label}`);
      }
    } catch (error) {
      // Silently skip secondary URL failures
    }

    await new Promise(resolve => setTimeout(resolve, 500));
  }

  console.log(`\n✓ Accessible URLs: ${evaluation.primaryAccessible ? 1 : 0} primary + ${evaluation.secondaryAccessible} secondary`);
  console.log(`✓ PDF references: ${evaluation.pdfIndicators}`);
  console.log(`✓ Guidance indicators: ${evaluation.guidance}`);

  return evaluation;
};

const main = async () => {
  console.log('\n' + '='.repeat(80));
  console.log('PHASE 5B CANDIDATE EVALUATION - DOCUMENT AVAILABILITY');
  console.log('='.repeat(80));

  const evaluations = [];

  for (const [symbol, data] of Object.entries(candidates)) {
    const evaluation = await evaluateCandidate(symbol, data);
    evaluations.push(evaluation);
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  console.log('\n' + '='.repeat(80));
  console.log('EVALUATION SUMMARY');
  console.log('='.repeat(80) + '\n');

  for (const result of evaluations) {
    console.log(`${result.symbol.padEnd(12)} | Sector: ${result.sector.padEnd(20)} | URLs: ${result.totalUrls} | PDFs: ${result.pdfIndicators} | Guidance: ${result.guidance}`);
  }

  // Scoring
  console.log('\n' + '='.repeat(80));
  console.log('SCORING FOR PHASE 5B');
  console.log('='.repeat(80) + '\n');

  const scores = evaluations.map(result => ({
    symbol: result.symbol,
    name: result.name,
    score: (
      (result.primaryAccessible ? 40 : 0) +
      (result.secondaryAccessible * 15) +
      (Math.min(result.pdfIndicators, 20)) +
      (result.guidance === 'LIKELY' ? 25 : result.guidance === 'UNKNOWN' ? 10 : 0)
    )
  })).sort((a, b) => b.score - a.score);

  for (let i = 0; i < scores.length; i++) {
    console.log(`${i + 1}. ${scores[i].symbol} (${scores[i].name})`);
    console.log(`   Score: ${scores[i].score}/100`);
  }

  console.log(`\n✓ RECOMMENDED: ${scores[0].symbol} (${scores[0].name})`);
  console.log('\n');
};

await main();
