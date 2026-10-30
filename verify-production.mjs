// Uses a short-lived, dedicated key; never consumes a customer's quota.
// Supply an origin obtained from deployment metadata, not a preview address.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const [originArg,workerArg]=process.argv.slice(2);
if(!originArg || !workerArg || !process.env.ADMIN_SECRET) {
    console.error('Usage: node movieapi/verify-production.mjs <verified-production-origin> <worker-origin> (requires ADMIN_SECRET)');
    process.exit(1);
}
const origin=new URL(originArg).origin,worker=new URL(workerArg).origin;
for(const url of [origin,worker]) assert.ok(url.startsWith('https://')&&!new URL(url).hostname.endsWith('.replit.dev'),'Use HTTPS production origins only');
const admin={Authorization:`Bearer ${process.env.ADMIN_SECRET}`,'Content-Type':'application/json'};
const report={checkedAt:new Date().toISOString(),origin,worker,checks:[],upstreamBlocks:[],failures:[]};
const temporaryKeys=new Set();
const redact=text=>String(text).replace(/https?:\/\/[^\s"<>]+/g,'[URL]').replace(/(?:runflix_|Bearer |ticket=)[^\s"<>]+/g,'[credential]');
function record(name,details={}) {
    const row={name,...details};report.checks.push(row);console.log(JSON.stringify(row));
}
async function request(base,path,{method='GET',body,headers={},key}={}) {
    return fetch(base+path,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),
        ...(key?{Authorization:`Bearer ${key}`} : {}),...headers},
        ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(150000)});
}
async function jsonRequest(base,path,options={}) {
    const r=await request(base,path,options),data=await r.json();
    assert.equal(r.status,200,`${path}: HTTP ${r.status} ${redact(data.message||'')}`);
    return data;
}
async function createKey(limits) {
    const r=await request(worker,'/admin/api/keys',{method:'POST',headers:admin,
        body:{owner:'Temporary production verification',limits,expiresAt:new Date(Date.now()+3600000).toISOString()}});
    const d=await r.json();assert.equal(r.status,201,'Create verification key');
    temporaryKeys.add(d.key.key);return d.key.key;
}
async function check(base,key) {
    return jsonRequest(base,'/api/key/check',{method:'POST',body:{key}});
}
async function limitedBytes(response,max=65536) {
    const reader=response.body?.getReader();if(!reader)return Buffer.alloc(0);
    const chunks=[];let size=0;
    try {
        for(;;){const {done,value}=await reader.read();if(done)break;
            size+=value.length;assert.ok(size<=max,'Response exceeded verification byte limit');chunks.push(value);}
    }finally{await reader.cancel();}
    return Buffer.concat(chunks);
}
async function media(url,name,{range,download=false}={}) {
    const u=new URL(url);assert.equal(u.origin,worker,'All playback must stay on Cloudflare');
    if(download) {
        assert.equal(u.pathname,'/api/v3/stream','Expected signed stream URL');
        u.pathname='/api/v3/download';
    }
    const r=await fetch(u,{headers:range?{Range:range}:{},signal:AbortSignal.timeout(50000)});
    const bytes=await limitedBytes(r,range?65536:2*1024*1024),type=r.headers.get('content-type')||'';
    if(!r.ok) {
        let error={};try{error=JSON.parse(bytes.toString());}catch{}
        if(error.upstreamStatus) {
            const block={name,status:r.status,upstreamStatus:error.upstreamStatus};
            report.upstreamBlocks.push(block);console.log(JSON.stringify(block));return null;
        }
        throw new Error(`${name}: HTTP ${r.status}`);
    }
    assert.ok(!/text\/html|application\/(?:problem\+)?json/i.test(type),`${name}: not media`);
    const details={status:r.status,type,bytes:bytes.length};
    if(range) {
        const [,start,end]=range.match(/^bytes=(\d+)-(\d+)$/)||[];
        assert.equal(r.status,206,`${name}: range must return 206`);
        assert.match(r.headers.get('content-range')||'',new RegExp(`^bytes ${start}-${end}/\\d+$`),name);
        assert.equal(bytes.length,Number(end)-Number(start)+1,name);
        details.contentRange=r.headers.get('content-range');
        details.sha256=createHash('sha256').update(bytes).digest('hex');
    }
    if(download) {
        assert.match(r.headers.get('content-disposition')||'',/^attachment;/,name);
        details.contentDisposition=r.headers.get('content-disposition');
    }
    record(name,details);return {bytes,type,url:u.href};
}
async function videoRanges(url,name) {
    const first=await media(url,`${name}: initial range`,{range:'bytes=0-1023'});
    if(!first)return;
    const prefix=first.bytes.subarray(0,64);
    assert.ok(prefix[0]===0x47||prefix.includes(Buffer.from('ftyp'))||prefix.includes(Buffer.from('styp'))||prefix.includes(Buffer.from('moof')),`${name}: unrecognized video bytes`);
    const seek=await media(url,`${name}: seek range`,{range:'bytes=1048576-1049599'});
    assert.ok(seek,`${name}: seek blocked`);
    assert.notDeepEqual(first.bytes,seek.bytes,`${name}: seek must not return the first bytes`);
    const download=await media(url,`${name}: download range`,{range:'bytes=0-1023',download:true});
    assert.ok(download,`${name}: download blocked`);assert.deepEqual(first.bytes,download.bytes);
}
async function hls(url,name,depth=0) {
    assert.ok(depth<4,'Too many nested playlists');
    const manifest=await media(url,`${name}: HLS manifest`);if(!manifest)return;
    const text=manifest.bytes.toString();assert.ok(text.trimStart().startsWith('#EXTM3U'),'Invalid HLS');
    const lines=text.split('\n').map(s=>s.trim()).filter(s=>s&&!s.startsWith('#'));
    assert.ok(lines.length,'HLS has no variants/segments');
    // Validate encryption keys and alternate rendition playlists too.
    for(const line of text.split('\n').filter(l=>/^#EXT-X-(KEY|MEDIA|I-FRAME-STREAM-INF):/.test(l))) {
        const uri=line.match(/URI="([^"]+)"/)?.[1];if(!uri)continue;
        if(line.startsWith('#EXT-X-KEY:')) assert.ok(await media(new URL(uri,url).href,`${name}: HLS encryption key`));
        else await hls(new URL(uri,url).href,`${name}: alternate rendition`,depth+1);
    }
    for(const [i,relative]of lines.entries()) {
        const target=new URL(relative,url).href;
        if(text.includes('#EXT-X-STREAM-INF:')) await hls(target,`${name}: variant ${i+1}`,depth+1);
        else await videoRanges(target,`${name}: segment ${i+1}`);
    }
}

try {
    for(const base of [origin,worker]) {
        const d=await jsonRequest(base,`/api/v3/health?verify=${Date.now()}`);
        assert.equal(d.storage,'durable-sqlite');record(`${base}: durable health`,{storage:d.storage});
    }
    for(const path of ['/internal/moviebox','/internal/moviebox-media']) {
        for(const method of ['GET','POST'])for(const secret of [undefined,'incorrect-verification-secret']) {
            const r=await request(origin,path,{method,...(method==='POST'?{body:{}}:{}),
                headers:secret?{'x-relay-secret':secret}:{}});
            await r.body?.cancel();assert.equal(r.status,401);record(`${path}: ${method} rejects ${secret?'wrong':'missing'} secret`,{status:r.status});
        }
        const r=await request(origin,path,{headers:{'x-relay-secret':process.env.ADMIN_SECRET}});
        await r.body?.cancel();assert.equal(r.status,405);record(`${path}: authenticated GET rejected`,{status:405});
    }
    const key=await createKey({daily:120,allTime:120});
    const get=async path=>{
        const d=await jsonRequest(worker,path,{key});record(path,{status:200});return d;
    };
    const search=await get('/api/v3/search/Avengers?perPage=5');assert.ok(search.results.items.length);
    const home=await get('/api/v3/trending?perPage=30');assert.ok(home.results.items.length);
    const movie=home.results.items.find(x=>x.subjectType===1),series=home.results.items.find(x=>x.subjectType===2);
    assert.ok(movie&&series,'Need a real movie and series from the live homepage');
    const info=await get('/api/v3/info/'+movie.id);assert.ok(info.results.title);
    const episodes=await get('/api/v3/episodes/'+series.id);assert.ok(episodes.seasons.length);
    const season=await get(`/api/v3/season/${series.id}/${episodes.seasons[0].season}`);assert.ok(season.episodes.length);
    for(const title of [movie,search.results.items.find(x=>/Infinity War/i.test(x.title))].filter(Boolean)) {
        const sources=await get('/api/v3/sources/'+title.id);assert.ok(sources.results.length);
        record(`${title.title}: sources`,{formats:sources.results.map(s=>s.format),count:sources.results.length});
        // Test one MP4 per title and every returned manifest.
        const mp4=sources.results.find(s=>s.format==='MP4');
        if(mp4) {
            await videoRanges(mp4.streamUrl,`${title.title}: MP4`);
            await media(mp4.downloadUrl,`${title.title}: source download`,{range:'bytes=0-1023'});
        }
        for(const source of sources.results.filter(s=>s.format!=='MP4')) {
            if(source.format==='HLS')await hls(source.streamUrl,`${title.title}: HLS`);
            else {
                const manifest=await media(source.streamUrl,`${title.title}: ${source.format} manifest`);
                // Never silently call an accessible but untested DASH manifest playable.
                if(manifest)throw new Error(`${title.title}: DASH now reachable; verify its initialization and media segments before claiming playback`);
            }
        }
    }
    const fixtures=await get('/api/v3/football');assert.ok(fixtures.results.items.length);
    for(const match of fixtures.results.items) {
        assert.ok(!match.playPath&&!match.playSource,'Football must not leak raw play paths');
        await get('/api/v3/football/'+match.id);
        const sources=await get(`/api/v3/football/${match.id}/sources`);
        for(const source of sources.results)await hls(source.streamUrl,match.title);
    }
    const a=await check(origin,key),b=await check(worker,key);
    assert.deepEqual(a.key,b.key);record('Shared Durable Object quota counters',{usage:a.key.usage,limits:a.key.limits});
    const quotaKey=await createKey({daily:2});
    const before=await check(origin,quotaKey);await check(worker,quotaKey);await check(origin,quotaKey);
    assert.equal(before.key.usage.allTime,0);
    await jsonRequest(origin,'/api/v3/homepage',{key:quotaKey});
    assert.equal((await check(worker,quotaKey)).key.usage.allTime,1);
    await jsonRequest(worker,'/api/v3/homepage',{key:quotaKey});
    const exhausted=await request(origin,'/api/v3/homepage',{key:quotaKey,headers:{Origin:'https://runflix.name.ng'}});
    assert.equal(exhausted.status,429);assert.ok(exhausted.headers.get('retry-after'));
    const d=await exhausted.json();assert.equal(d.period,'daily');
    assert.equal((await check(worker,quotaKey)).key.usage.allTime,2);
    record('Quota is exact across both services; checker is read-only; Origin cannot bypass',{status:429,usage:2});
}catch(e) {
    report.failures.push(redact(e.message));console.error(redact(e.message));
}finally {
    for(const key of temporaryKeys) {
        try {
            const r=await request(worker,'/admin/api/keys/'+encodeURIComponent(key),{method:'DELETE',headers:admin});
            await r.body?.cancel();assert.equal(r.status,200,'Delete verification key');
            for(const base of [origin,worker]) {
                const check=await request(base,'/api/key/check',{method:'POST',body:{key}});
                await check.body?.cancel();assert.equal(check.status,401,'Deleted verification key must be invalid');
            }
            record('Temporary verification key deleted and invalid on both services');
        }catch(e){report.failures.push(redact(e.message));}
    }
    report.result=report.failures.length?'FAILED':report.upstreamBlocks.length?'UPSTREAM_BLOCKED':'PASSED';
    await mkdir('generated-artifacts',{recursive:true});
    await writeFile('generated-artifacts/movieapi-production-verification.json',JSON.stringify(report,null,2)+'\n');
    console.log(`Result: ${report.result}. Report: generated-artifacts/movieapi-production-verification.json`);
    process.exitCode=report.failures.length?1:report.upstreamBlocks.length?2:0;
}
