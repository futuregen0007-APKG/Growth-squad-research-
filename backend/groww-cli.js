import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';
import { YahooFinanceProvider } from './providers/YahooFinanceProvider.js';

// Load environment variables
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

// Instantiate the Yahoo provider
const provider = new YahooFinanceProvider();

async function getStockPrice(query) {
  try {
    console.log(`🔍 Fetching quote for "${query}" via Yahoo Finance...`);
    const symbol = query.trim().toUpperCase();
    const quote = await provider.getStock(symbol);
    
    console.log('\n========================================');
    console.log(`📈 STOCK DETAILS FOR: ${quote.name} (${quote.ticker})`);
    console.log('========================================');
    console.log(`💵 Current Price : ₹${quote.price.toFixed(2)}`);
    console.log(`Change          : ₹${quote.change >= 0 ? '+' : ''}${quote.change.toFixed(2)} (${quote.changePct >= 0 ? '+' : ''}${quote.changePct.toFixed(2)}%)`);
    console.log(`High / Low      : ₹${quote.high.toFixed(2)} / ₹${quote.low.toFixed(2)}`);
    console.log(`Open Price      : ₹${quote.open.toFixed(2)}`);
    console.log(`Previous Close  : ₹${quote.previousClose.toFixed(2)}`);
    console.log(`Volume          : ${quote.volume.toLocaleString()}`);
    console.log(`Last Updated    : ${new Date(quote.lastUpdate).toLocaleString()}`);
    console.log('========================================\n');
  } catch (error) {
    console.error(`❌ Failed to fetch stock details: ${error.message}`);
  }
}

// Check command line arguments
const args = process.argv.slice(2);
if (args.length > 0) {
  const query = args.join(' ');
  await getStockPrice(query);
  process.exit(0);
} else {
  // Interactive Prompt
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const ask = () => {
    rl.question('Enter stock name or symbol (e.g. Reliance, HAL) [or type "exit" to quit]: ', async (answer) => {
      if (answer.trim().toLowerCase() === 'exit') {
        rl.close();
        process.exit(0);
      }
      if (answer.trim()) {
        await getStockPrice(answer);
      }
      ask();
    });
  };
  
  console.log('--- Stock Price Lookup CLI Tool (Yahoo Finance) ---');
  ask();
}
