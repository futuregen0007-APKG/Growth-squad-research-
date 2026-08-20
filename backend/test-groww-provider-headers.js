import { YahooFinanceService } from './services/yahooFinance.service.js';

const yahoo = new YahooFinanceService();

async function testQuote(symbol) {
  try {
    console.log(`Fetching ${symbol} via Yahoo Finance...`);
    const quote = await yahoo.fetchQuote(symbol);
    console.log('Quote:', JSON.stringify(quote, null, 2));
  } catch (err) {
    console.error('Error fetching quote:', err.message);
  }
}

await testQuote('HAL');
