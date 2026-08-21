import { AngelOneService } from './services/angelOne.service.js';

const angelOne = new AngelOneService();

async function testQuote(symbol) {
  try {
    console.log(`Fetching ${symbol} via Angel One...`);
    const quote = await angelOne.fetchQuote(symbol);
    console.log('Quote:', JSON.stringify(quote, null, 2));
  } catch (err) {
    console.error('Error fetching quote:', err.message);
  }
}

await testQuote('HAL');
