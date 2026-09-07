#!/usr/bin/env node
/**
 * Test IR Website Accessibility
 * Checks which supported companies have accessible investor-relations sites
 */

import axios from 'axios';

const companies = {
  TCS: {
    name: 'Tata Consultancy Services',
    url: 'https://www.tcs.com/investor-relations',
    sector: 'IT / Software'
  },
  INFY: {
    name: 'Infosys',
    url: 'https://www.infosys.com/investors.html',
    sector: 'IT / Software'
  },
  HDFCBANK: {
    name: 'HDFC Bank',
    url: 'https://www.hdfcbank.com/personal/about-us/investor-relations',
    sector: 'Banking'
  },
  ICICIBANK: {
    name: 'ICICI Bank',
    url: 'https://www.icicibank.com/about-us/investor-relations',
    sector: 'Banking'
  },
  BHEL: {
    name: 'Bharat Heavy Electricals',
    url: 'https://www.bhel.com/investor-relations',
    sector: 'Capital Goods'
  },
  RELIANCE: {
    name: 'Reliance Industries',
    url: 'https://www.ril.com/investor-relations',
    sector: 'Conglomerate'
  }
};

const testAccessibility = async () => {
  console.log('\n' + '='.repeat(80));
  console.log('SUPPORTED COMPANY IR ACCESSIBILITY TEST');
  console.log('='.repeat(80) + '\n');

  const results = [];

  for (const [symbol, company] of Object.entries(companies)) {
    try {
      const response = await axios.get(company.url, {
        timeout: 15000,
        maxRedirects: 5,
        validateStatus: () => true,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      const status = response.status;
      const contentLength = (response.data || '').length;
      const hasContent = contentLength > 500;
      const checkForPdfLinks = (response.data || '').toLowerCase().includes('pdf');

      results.push({
        symbol,
        name: company.name,
        sector: company.sector,
        url: company.url,
        accessible: status >= 200 && status < 400,
        statusCode: status,
        contentSize: contentLength,
        hasContent: hasContent,
        hasPdfLinks: checkForPdfLinks
      });

      console.log(`✓ ${symbol.padEnd(12)} ${company.name.padEnd(30)} - Status ${status} (${contentLength} bytes)`);
    } catch (error) {
      results.push({
        symbol,
        name: company.name,
        sector: company.sector,
        url: company.url,
        accessible: false,
        statusCode: null,
        contentSize: 0,
        hasContent: false,
        hasPdfLinks: false,
        error: error.code || error.message
      });

      console.log(`✗ ${symbol.padEnd(12)} ${company.name.padEnd(30)} - ${error.code || error.message}`);
    }

    // Add delay to avoid overwhelming servers
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  console.log('\n' + '='.repeat(80));
  console.log('SUMMARY');
  console.log('='.repeat(80));

  const accessible = results.filter(r => r.accessible);
  const withContent = results.filter(r => r.hasContent);
  const withPdfs = results.filter(r => r.hasPdfLinks);

  console.log(`\nAccessible Sites: ${accessible.length}/${results.length}`);
  for (const r of accessible) {
    console.log(`  ✓ ${r.symbol}: ${r.name} (${r.statusCode})`);
  }

  console.log(`\nSites with Substantial Content (>500 bytes): ${withContent.length}/${results.length}`);
  for (const r of withContent) {
    console.log(`  ✓ ${r.symbol}: ${r.contentSize} bytes`);
  }

  console.log(`\nSites Likely with PDF Links (contain 'pdf'): ${withPdfs.length}/${results.length}`);
  for (const r of withPdfs) {
    console.log(`  ✓ ${r.symbol}: ${r.name}`);
  }

  console.log('\n' + '='.repeat(80));
  console.log('RECOMMENDATIONS FOR PHASE 5B');
  console.log('='.repeat(80));

  const candidates = accessible
    .filter(r => r.hasContent && r.hasPdfLinks)
    .sort((a, b) => b.contentSize - a.contentSize);

  if (candidates.length > 0) {
    console.log('\nTop candidates for end-to-end testing:');
    for (let i = 0; i < Math.min(3, candidates.length); i++) {
      const c = candidates[i];
      console.log(`\n${i + 1}. ${c.symbol} - ${c.name}`);
      console.log(`   Sector: ${c.sector}`);
      console.log(`   URL: ${c.url}`);
      console.log(`   Content: ${c.contentSize} bytes`);
      console.log(`   Status: Accessible ✓, Has PDF Links ✓`);
    }
  } else {
    console.log('\nNo perfect candidates found. Manual review of results above.');
  }

  console.log('\n');
};

await testAccessibility();
