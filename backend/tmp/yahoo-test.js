import yahoo from 'yahoo-finance2';

(async ()=>{
  try{
    const bench = '^NSEI';
    console.log('Fetching benchmark', bench);
    const hist = await yahoo.historical(bench, { period: '90d', interval: '1wk' });
    console.log('bench points', hist ? hist.length : 0);
    console.log(hist && hist.slice(-3).map(h=>({date:h.date, close:h.close})));

    const ticker = 'HAL';
    console.log('Fetching ticker', ticker);
    const th = await yahoo.historical(ticker, { period: '90d', interval: '1wk' });
    console.log('ticker points', th ? th.length : 0);
    console.log(th && th.slice(-3).map(h=>({date:h.date, close:h.close})));
  }catch(e){
    console.error('ERR', e && e.message);
    process.exit(1);
  }
})();
