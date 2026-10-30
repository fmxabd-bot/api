import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { KeyStore } from './src/key-store.js';
import { modernRoute } from './src/router.js';
import { seal,open,safeMediaUrl } from './src/tickets.js';

function store() {
    const db=new DatabaseSync(':memory:');
    const sql={exec(q,...p){const s=db.prepare(q);return /^\s*SELECT/i.test(q)?s.all(...p):(s.run(...p),[]);}};
    return new KeyStore(sql);
}
test('free key is seeded once; deleted free key stays deleted',()=>{
    const s=store();assert.equal(s.get('daratechapi').limits.daily,50);
    assert.equal(s.delete('daratechapi'),true);assert.equal(s.get('daratechapi'),null);
    new KeyStore(s.sql);assert.equal(s.get('daratechapi'),null);
});
test('daily quota is exact, checker does not consume, editing works',()=>{
    const s=store();s.create({key:'daily-test',limits:{daily:2}});
    for(let i=0;i<4;i++)assert.equal(s.check('daily-test').status,200);
    assert.equal(s.get('daily-test').usage.allTime,0);
    assert.equal(s.check('daily-test',null,true).status,200);
    assert.equal(s.check('daily-test',null,true).status,200);
    assert.equal(s.check('daily-test',null,true).status,429);
    s.update('daily-test',{limits:{daily:3}});
    assert.equal(s.check('daily-test',null,true).status,200);
    assert.equal(s.get('daily-test').usage.allTime,3);
});
test('monthly/lifetime/zero/unlimited limits are independent',()=>{
    for(const field of ['monthly','allTime']){
        const s=store();s.create({key:'limit-test',limits:{[field]:1}});
        assert.equal(s.check('limit-test',null,true).status,200);
        assert.equal(s.check('limit-test',null,true).period,field);
    }
    const s=store();s.create({key:'zero',limits:{daily:0}});
    assert.equal(s.check('zero',null,true).status,429);
    s.update('zero',{limits:{daily:null}});
    assert.equal(s.check('zero',null,true).status,200);
});
test('calendar rollover uses UTC; lifetime never resets',()=>{
    const s=store();s.create({key:'rollover',limits:{daily:1,monthly:2}});
    assert.equal(s.check('rollover',null,true,new Date('2030-01-30T23:59:00Z')).status,200);
    assert.equal(s.check('rollover',null,true,new Date('2030-01-31T00:00:00Z')).status,200);
    const blocked=s.check('rollover',null,true,new Date('2030-01-31T00:01:00Z'));
    assert.equal(blocked.status,429);
    assert.equal(s.check('rollover',null,true,new Date('2030-02-01T00:00:00Z')).status,200);
    assert.equal(s.get('rollover').usage.allTime,3);
});
test('disabled, expired, deleted and restricted keys cannot be used',()=>{
    const s=store();s.create({key:'restricted',domains:['example.com']});
    assert.equal(s.check('restricted','https://evil.example').status,403);
    assert.equal(s.check('restricted','https://example.com').status,200);
    s.update('restricted',{enabled:false});assert.equal(s.check('restricted').status,403);
    s.update('restricted',{enabled:true,expiresAt:'2000-01-01T00:00:00Z'});assert.equal(s.check('restricted').status,401);
    s.delete('restricted');assert.equal(s.check('restricted').status,401);
});
test('limits validate, duplicate keys rejected, edits preserve usage',()=>{
    const s=store();assert.throws(()=>s.create({key:'bad-key',limits:{daily:-1}}));
    s.create({key:'test-key'});assert.throws(()=>s.create({key:'test-key'}));
    s.check('test-key',null,true);s.update('test-key',{owner:'Changed',limits:{monthly:4}});
    assert.equal(s.get('test-key').usage.allTime,1);
});
test('tickets are authenticated, expire and cannot make an open proxy',()=>{
    const secret='test-only-not-a-production-secret',payload={url:'https://bcdn.hakunaymatata.com/video.mp4',key:'test',exp:Date.now()+10000};
    const t=seal(payload,secret);assert.deepEqual(open(t,secret),payload);
    assert.throws(()=>open(t,'wrong-secret'));assert.throws(()=>open(t.slice(0,-6)+'AAAAAA',secret));
    assert.throws(()=>open(seal({...payload,exp:1},secret),secret));
    for(const bad of ['http://127.0.0.1','https://evil.example','https://hakunaymatata.com.evil.example','https://aoneroom.com:444/'])
        assert.throws(()=>safeMediaUrl(bad));
});
test('API quotas cannot be bypassed with Origin and retired routes return 410',async()=>{
    const s=store();s.create({key:'blocked',limits:{daily:0}});
    const env={ADMIN_SECRET:'test-secret',STORAGE_LABEL:'test',ledger:async data=>s.dispatch(data),engine:async()=>({})};
    const req=new Request('https://example.com/api/v3/homepage',{headers:{Authorization:'Bearer blocked',Origin:'https://runflix.name.ng'}});
    assert.equal((await modernRoute(req,env)).status,429);
    for(const route of ['live','live/categories','schedule','schedule/popular','seasons/upcoming'])
        assert.equal((await modernRoute(new Request('https://example.com/api/v3/'+route),env)).status,410);
    assert.equal((await modernRoute(new Request('https://example.com/api/v3/homepage'),env)).status,401);
});
test('media rejects HTTP 200 error documents and invalid manifests',async()=>{
    const secret='test-secret',ticket=seal({url:'https://bcdn.hakunaymatata.com/video.mp4',key:'test',exp:Date.now()+10000},secret);
    for(const type of ['text/html','application/json','application/problem+json','application/vnd.apple.mpegurl','application/dash+xml']) {
        const env={ADMIN_SECRET:secret,ledger:async()=>({status:200}),
            media:async()=>new Response('<html>Forbidden</html>',{headers:{'content-type':type}})};
        const r=await modernRoute(new Request(`https://example.com/api/v3/stream?ticket=${ticket}`),env);
        assert.equal(r.status,502,type);
    }
});
test('HLS segment ranges and downloads preserve actual bytes and format',async()=>{
    const secret='test-secret',ticket=seal({url:'https://live-pull.aisports.mobi/moviebox/segment.ts',key:'test',exp:Date.now()+10000},secret);
    const bytes=new Uint8Array(188*2);bytes[0]=bytes[188]=0x47;
    const env={ADMIN_SECRET:secret,ledger:async()=>({status:200}),media:async(target,headers,range,method)=>{
        assert.equal(range,'bytes=0-375');assert.equal(method,'GET');
        return new Response(bytes,{status:206,headers:{'content-type':'video/mp2t','content-length':'376','content-range':'bytes 0-375/1880'}});
    }};
    const r=await modernRoute(new Request(`https://example.com/api/v3/download?ticket=${ticket}`,{headers:{Range:'bytes=0-375'}}),env);
    assert.equal(r.status,206);
    assert.equal(r.headers.get('content-range'),'bytes 0-375/1880');
    assert.match(r.headers.get('content-disposition'),/\.ts"/);
    assert.match(r.headers.get('access-control-expose-headers'),/Content-Disposition/);
    assert.deepEqual(new Uint8Array(await r.arrayBuffer()),bytes);
});
