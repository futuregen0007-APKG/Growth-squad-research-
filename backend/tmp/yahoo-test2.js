import yf from 'yahoo-finance2';
(async ()=>{
  try{
    const client = new yf();
    console.log('client has historical?', typeof client.historical);
    const bench = '^NSEI';
    const hist = await client.historical(bench, { period: '90d', interval: '1wk' });
    console.log('bench points', hist ? hist.length : 0);
    console.log(hist && hist.slice(-3).map(h=>({date:h.date, close:h.close})));
  }catch(e){
    console.error('ERR', e && e.message);
    process.exit(1);
  }
})();
