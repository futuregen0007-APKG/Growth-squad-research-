import { createClient } from 'redis';

const url = process.env.REDIS_URL || `redis://127.0.0.1:6379`;
const client = createClient({ url });
client.on('error', (e)=> console.error('ERR', e.message));

(async ()=>{
  try{
    await client.connect();
    console.log('CONNECTED');
    const pong = await client.ping();
    console.log('PING', pong);
    const dbsize = await client.dbSize();
    console.log('DBSIZE', dbsize);
    const collect = async (match) => {
      const out = [];
      for await (const k of client.scanIterator({ MATCH: match, COUNT: 100 })) {
        out.push(k);
        if (out.length >= 200) break;
      }
      return out;
    };
    const sectorKeys = await collect('sector*');
    console.log('sector* keys:', sectorKeys);
    const alphaKeys = await collect('alpha*');
    console.log('alpha* keys:', alphaKeys);
    const rotKeys = await collect('*sector-rotation*');
    console.log('*sector-rotation* keys:', rotKeys);
    await client.disconnect();
    process.exit(0);
  }catch(e){
    console.error('FAIL', e.message);
    try{ await client.disconnect(); } catch(_){}
    process.exit(1);
  }
})();
