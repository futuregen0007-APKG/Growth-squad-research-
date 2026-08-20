import { createClient } from 'redis';
const client = createClient({ url: process.env.REDIS_URL || 'redis://127.0.0.1:6379' });
client.on('error', e=>console.error('ERR', e.message));
(async()=>{
  try{
    await client.connect();
    console.log('CONNECTED');
    const arr = [];
    for await (const k of client.scanIterator({ MATCH: '*', COUNT: 100 })){
      arr.push(k);
    }
    console.log('TOTAL KEYS:', arr.length);
    console.log(arr.slice(0,200).join('\n'));
    await client.disconnect();
    process.exit(0);
  }catch(e){
    console.error('ERR', e.message);
    try{await client.disconnect()}catch(_){ }
    process.exit(1);
  }
})();
