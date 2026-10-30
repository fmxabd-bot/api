import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {KeyStore} from './src/key-store.js';
import {modernRoute} from './src/router.js';

function fixture() {
    const db=new DatabaseSync(':memory:');
    const sql={exec(q,...p){const s=db.prepare(q);return /^\s*SELECT/i.test(q)?s.all(...p):(s.run(...p),[]);}};
    const store=new KeyStore(sql);
    const env={ADMIN_SECRET:'fixture-admin',engine:async()=>({items:[],total:0}),
        ledger:async data=>{
            db.exec('BEGIN IMMEDIATE');
            try{const r=store.dispatch(data);db.exec('COMMIT');return r;}
            catch(e){db.exec('ROLLBACK');throw e;}
        }};
    const request=async(path,method='GET',body,credential)=>{
        const r=await modernRoute(new Request('https://movieapi.fixture'+path,{method,
            headers:{...(credential?{Authorization:`Bearer ${credential}`}:{ }),
                ...(body!==undefined?{'Content-Type':'application/json'}:{})},
            ...(body!==undefined?{body:JSON.stringify(body)}:{})}),env);
        return {r,data:await r.json()};
    };
    return {store,env,request};
}
const applicant={name:'Test Developer',email:'dev@example.invalid',phone:'+10000000000',website:'https://example.invalid/app',useCase:'Build a movie catalogue'};
test('all ApiMovie header and parameter authentication methods enforce the same stored quotas',async()=>{
    const {env,store}=fixture();
    store.create({key:'auth-alias',limits:{daily:20}});
    const variants=[{headers:{Authorization:'Bearer auth-alias'}},{headers:{Authorization:'ApiKey auth-alias'}},
        ...['X-API-Key','apikey','api-key'].map(h=>({headers:{[h]:'auth-alias'}})),
        ...['apikey','api_key','key'].map(q=>({query:`?${q}=auth-alias`}))];
    for(const v of variants) {
        const r=await modernRoute(new Request('https://movieapi.fixture/api/v3/search/test'+(v.query||''),{headers:v.headers}),env);
        assert.equal(r.status,200);assert.equal(r.headers.get('X-RateLimit-Limit'),'20');
        assert.equal((await r.text()).includes('auth-alias'),false);
    }
    assert.equal(store.get('auth-alias').usage.allTime,variants.length);
    const bad=await modernRoute(new Request('https://movieapi.fixture/api/v3/search/test?key=auth-alias',
        {headers:{Authorization:'Bearer revoked'}}),env);
    assert.equal(bad.status,401);
    const cors=await modernRoute(new Request('https://movieapi.fixture/api/v3/search/test',{method:'OPTIONS'}),env);
    assert.match(cors.headers.get('Access-Control-Allow-Headers'),/X-API-Key/);
});
test('key configuration, metadata and rotation preserve usage and revoke previous sessions',async()=>{
    const {store}=fixture();
    const original=store.create({key:'config-key',email:'dev@example.invalid',phone:'123',plan:'premium',note:'Private note',
        domain:'https://example.invalid/app',dailyLimit:'20',monthlyLimit:'30',limit:'40',expiresAt:'2099-12-31'});
    assert.deepEqual(original.domains,['example.invalid']);assert.equal(original.limits.monthly,30);
    assert.equal(original.expiresAt,'2099-12-31T23:59:59.999Z');
    store.check('config-key',null,true);
    const token='s'.repeat(24);
    store.savePlayback('config-key',[{token,expires:Date.now()+10000,data:{url:'https://movieboxhd.net/a.mp4'}}]);
    const next=store.update('config-key',{newKey:'rotated-key',owner:'Changed',limits:{monthly:50}});
    assert.equal(next.usage.allTime,1);assert.equal(next.createdAt,original.createdAt);
    assert.equal(next.email,original.email);assert.equal(next.note,'Private note');assert.equal(next.limits.daily,20);
    assert.equal(store.get('config-key'),null);assert.equal(store.playback(token).status,401);
    assert.throws(()=>store.update('rotated-key',{newKey:'daratechapi'}),e=>e.status===409);
    assert.equal(store.get('rotated-key').owner,'Changed');
    assert.match(store.create({key:'  '}).key,/^runflix_/);
    assert.throws(()=>store.update('rotated-key',{expiresAt:'2027-02-30'}),e=>e.status===400);
    assert.throws(()=>store.update('rotated-key',{limits:[]}),e=>e.status===400);
});
test('missing, invalid, disabled, expired and every quota period have distinct error codes',async()=>{
    const {request,store}=fixture();
    let result=await request('/api/v3/search/test');assert.equal(result.data.code,'API_KEY_MISSING');
    result=await request('/api/v3/search/test','GET',undefined,'wrong');assert.equal(result.data.code,'API_KEY_INVALID');
    for(const [name,config,code,status]of [
        ['disabled',{enabled:false},'API_KEY_DISABLED',403],
        ['expired',{expiresAt:'2000-01-01'},'API_KEY_EXPIRED',401],
        ['daily',{limits:{daily:0}},'API_KEY_DAILY_LIMIT_EXCEEDED',429],
        ['monthly',{limits:{monthly:0}},'API_KEY_MONTHLY_LIMIT_EXCEEDED',429],
        ['lifetime',{limits:{allTime:0}},'API_KEY_LIMIT_EXCEEDED',429]]) {
        const key='case-'+name;store.create({key,note:'private-admin-note',...config});
        const {r,data}=await request('/api/v3/search/test','GET',undefined,key);
        assert.equal(r.status,status);assert.equal(data.code,code);assert.equal(data.success,false);
        assert.equal(typeof data.error,'string');assert.equal(data.message,data.error);
        assert.equal(new URL(data.contact).hostname,'wa.me');
        assert.equal(JSON.stringify(data).includes(key),false);assert.equal(JSON.stringify(data).includes('private-admin-note'),false);
        if(name==='daily'||name==='monthly')assert.ok(Number(r.headers.get('Retry-After'))>0);
    }
});
test('checker shows exhausted usage without spending quota or leaking credentials and admin notes',async()=>{
    const {request,store}=fixture();store.create({key:'checker-key',limits:{daily:0},note:'secret-note'});
    const {r,data}=await request('/key/info?api_key=checker-key');
    assert.equal(r.status,200);assert.equal(data.valid,true);assert.equal(data.keyStatus,'daily_limit_exceeded');
    assert.equal(data.quotaExceeded,true);assert.equal(data.requests,0);assert.equal(data.dailyLimit,0);
    assert.equal(new URL(data.contact).hostname,'wa.me');
    assert.equal(JSON.stringify(data).includes('checker-key'),false);assert.equal(JSON.stringify(data).includes('secret-note'),false);
    assert.equal(store.get('checker-key').usage.allTime,0);
});
test('public submission persists; admin approval, rejection and deletion are authenticated and durable',async()=>{
    const {request,store}=fixture();
    const submitted=await request('/api/request-key','POST',applicant);
    assert.equal(submitted.r.status,201);const id=submitted.data.requestId;
    assert.ok(id.startsWith('req_'));assert.equal(submitted.data.key,undefined);
    const handoff=new URL(submitted.data.whatsappUrl);
    assert.equal(handoff.hostname,'wa.me');assert.ok(handoff.searchParams.get('text').includes(id));
    assert.equal((await request('/admin/api/requests')).r.status,401);
    const listed=await request('/admin/api/requests','GET',undefined,'fixture-admin');
    assert.equal(listed.data.requests[0].status,'pending');
    const approved=await request(`/admin/api/requests/${id}/approve`,'POST',
        {key:'approved-key',limits:{daily:10,monthly:100,allTime:1000}},'fixture-admin');
    assert.equal(approved.r.status,200);assert.equal(approved.data.key.email,applicant.email);
    assert.equal(approved.data.key.domain,'example.invalid');assert.equal(approved.data.request.status,'approved');
    assert.equal((await request(`/admin/api/requests/${id}/approve`,'POST',{},'fixture-admin')).r.status,409);
    const next=await request('/request-key/submit','POST',{...applicant,email:'other@example.invalid'});
    const nid=next.data.requestId;
    assert.equal((await request(`/admin/api/requests/${nid}/reject`,'POST',{reason:'Not approved'},'fixture-admin')).data.request.status,'rejected');
    assert.equal((await request(`/admin/api/requests/${nid}`,'DELETE',undefined,'fixture-admin')).r.status,200);
    assert.equal((await request(`/admin/api/requests/${id}`,'DELETE',undefined,'fixture-admin')).r.status,200);
    assert.equal(store.get('approved-key').limits.monthly,100);
});
test('invalid and duplicate approvals leave requests pending, without partial key writes',async()=>{
    const {request,store}=fixture();
    const {data}=await request('/api/request-key','POST',applicant),id=data.requestId;
    let result=await request(`/admin/api/requests/${id}/approve`,'POST',{key:'daratechapi'},'fixture-admin');
    assert.equal(result.r.status,409);
    result=await request(`/admin/api/requests/${id}/approve`,'POST',
        {key:'partial-key',reason:'x'.repeat(1001)},'fixture-admin');
    assert.equal(result.r.status,400);assert.equal(store.get('partial-key'),null);
    assert.equal(store.dispatch({action:'request-list'}).requests[0].status,'pending');
});
test('request validation and durable request rate limiting return actionable errors',async()=>{
    const {request,store}=fixture();
    assert.equal((await request('/api/request-key','POST',{...applicant,email:'wrong'})).r.status,400);
    for(let i=0;i<5;i++)assert.equal((await request('/api/request-key','POST',applicant)).r.status,201);
    const {r,data}=await request('/api/request-key','POST',applicant);
    assert.equal(r.status,429);assert.equal(data.code,'REQUEST_RATE_LIMITED');assert.ok(r.headers.has('Retry-After'));
    assert.equal(store.dispatch({action:'request-list'}).requests.length,5);
});
test('storage outages fail closed with 503 instead of treating valid keys as invalid',async()=>{
    const env={ledger:async()=>{throw new Error('Database unavailable');}};
    const r=await modernRoute(new Request('https://movieapi.fixture/api/v3/search/test',{headers:{'X-API-Key':'test-key'}}),env);
    assert.equal(r.status,503);const d=await r.json();assert.equal(d.code,'KEY_STORE_UNAVAILABLE');
    assert.equal(d.success,false);
});
test('public-key checker and quota errors request a new key; personal keys offer WhatsApp upgrades',async()=>{
    const {request,store}=fixture();
    store.update('daratechapi',{limits:{daily:0}});
    const publicCheck=await request('/api/key/check','POST',{key:'daratechapi'});
    assert.equal(publicCheck.data.contact,'/request-key');
    assert.equal(publicCheck.data.contactAction,'request_key');
    assert.equal(publicCheck.data.contactLabel,'Request your own key');
    const publicError=await request('/api/v3/search/test','GET',undefined,'daratechapi');
    assert.equal(publicError.r.status,429);assert.equal(publicError.data.contact,'/request-key');
    store.create({key:'personal-free',plan:'free',limits:{daily:0}});
    const personal=await request('/api/key/check','POST',{key:'personal-free'});
    assert.equal(personal.data.contactAction,'upgrade');
    assert.equal(new URL(personal.data.contact).hostname,'wa.me');
    assert.equal(JSON.stringify(personal.data).includes('personal-free'),false);
});
