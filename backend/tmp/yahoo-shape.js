import yf from 'yahoo-finance2';
console.log('typeof yf', typeof yf);
console.log('keys', Object.keys(yf));
console.log('has historical', typeof yf.historical);
console.log('has YahooFinance', typeof yf.YahooFinance);
console.log('has default', typeof yf.default);
try{
  console.log('newable?', !!yf.prototype);
}catch(e){console.error(e.message)}
