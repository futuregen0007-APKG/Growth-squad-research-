#!/usr/bin/env node
/**
 * Test basic network connectivity and HTTPS
 */

import axios from 'axios';

const testConnectivity = async () => {
  console.log('\n' + '='.repeat(80));
  console.log('NETWORK CONNECTIVITY TEST');
  console.log('='.repeat(80) + '\n');

  const tests = [
    { name: 'Google', url: 'https://www.google.com', timeout: 10000 },
    { name: 'GitHub API', url: 'https://api.github.com', timeout: 10000 },
    { name: 'HDFCBANK IR Page', url: 'https://www.hdfcbank.com/personal/about-us/investor-relations', timeout: 15000 },
    { name: 'HDFCBANK PDF Direct', url: 'https://www.hdfcbank.com/content/dam/hdfcbankpws/in/en/pdf/annual-reports/ann_report-2023-24.pdf', timeout: 15000 }
  ];

  for (const test of tests) {
    process.stdout.write(`${test.name}... `);
    try {
      const response = await axios.head(test.url, {
        timeout: test.timeout,
        maxRedirects: 5,
        validateStatus: () => true
      });
      console.log(`✓ ${response.status}`);
    } catch (error) {
      console.log(`✗ ${error.code || error.message}`);
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  console.log('\n');
};

await testConnectivity();
