import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { once } from 'node:events';
import { createOutboundFetch } from './src/outbound.js';
import { MovieBox,mediaHeaders } from './src/moviebox.js';
import { fetchMedia,seal } from './src/tickets.js';
import { modernRoute } from './src/router.js';

test('upstream signing header is honored instead of assuming Cookie',()=>{
    assert.deepEqual(mediaHeaders({signHeaderKey:'X-MB-Token',signCookie:'signed-value'}),
        {'X-MB-Token':'signed-value'});
    assert.deepEqual(mediaHeaders({signCookie:'Edge-Cache-Cookie=signed-value'}),
        {Cookie:'Edge-Cache-Cookie=signed-value'});
    for(const name of ['Host','Authorization','Range','bad\r\nheader'])
        assert.throws(()=>mediaHeaders({signHeaderKey:name,signCookie:'value'}));
    assert.throws(()=>mediaHeaders({signCookie:'bad\r\nvalue'}));
});

test('media transport forwards signing and byte ranges; rejects unsafe redirects',async()=>{
    const seen=[];
    const response=await fetchMedia('https://sbcdnw.hakunaymatata.com/test.mpd',
        {'X-MB-Token':'fixture-signature',Cookie:'fixture-cookie','User-Agent':'fixture'},
        'bytes=10-19','GET',async(url,init)=>{
            seen.push({url:String(url),init});
            return seen.length===1 ?
                new Response(null,{status:302,headers:{Location:'https://bcdnw.hakunaymatata.com/test.mp4'}}):
                new Response(new Uint8Array(10),{status:206,headers:{'Content-Range':'bytes 10-19/100'}});
        });
    assert.equal(response.status,206);
    assert.equal(seen[0].init.headers['X-MB-Token'],'fixture-signature');
    assert.equal(seen[0].init.headers.Range,'bytes=10-19');
    assert.equal(seen[1].init.headers['X-MB-Token'],undefined);
    assert.equal(seen[1].init.headers.Cookie,undefined);
    assert.equal(seen[1].init.headers.Range,'bytes=10-19');
    await assert.rejects(fetchMedia('https://bcdnw.hakunaymatata.com/test.mp4',{},null,'GET',
        async()=>new Response(null,{status:302,headers:{Location:'https://127.0.0.1/private'}})));
});

test('signed stream/download routes preserve binary bytes, Range, HEAD and revocation',async()=>{
    const secret='test-fixture-only',bytes=Uint8Array.from([0,0,0,24,102,116,121,112]);
    const ticket=seal({url:'https://bcdnw.hakunaymatata.com/movie.mp4',
        headers:{'X-MB-Token':'fixture'},key:'test-key',exp:Date.now()+10000},secret);
    let revoked=false,calls=0;
    const env={ADMIN_SECRET:secret,ledger:async()=>({status:revoked?401:200}),
        media:async(url,headers,range,method)=>{
            calls++;assert.equal(range,'bytes=0-7');assert.equal(headers['X-MB-Token'],'fixture');
            return new Response(method==='HEAD'?null:bytes,{status:206,headers:{
                'Content-Type':'video/mp4','Content-Range':'bytes 0-7/100','Content-Length':'8','Accept-Ranges':'bytes'}});
        }};
    for(const path of ['stream','download']){
        const r=await modernRoute(new Request(`https://api.example/api/v3/${path}?ticket=${ticket}`,
            {headers:{Range:'bytes=0-7'}}),env);
        assert.equal(r.status,206);assert.equal(r.headers.get('content-range'),'bytes 0-7/100');
        assert.deepEqual(new Uint8Array(await r.arrayBuffer()),bytes);
        if(path==='download') assert.match(r.headers.get('content-disposition'),/^attachment/);
    }
    const head=await modernRoute(new Request(`https://api.example/api/v3/stream?ticket=${ticket}`,
        {method:'HEAD',headers:{Range:'bytes=0-7'}}),env);
    assert.equal((await head.arrayBuffer()).byteLength,0);
    revoked=true;
    assert.equal((await modernRoute(new Request(`https://api.example/api/v3/stream?ticket=${ticket}`),env)).status,401);
    assert.equal(calls,3);
});

test('CDN rejection is an explicit failure, not a successful playback response',async()=>{
    const ticket=seal({url:'https://bcdnw.hakunaymatata.com/video.mp4',key:'fixture',exp:Date.now()+10000},'fixture');
    const r=await modernRoute(new Request(`https://api.example/api/v3/stream?ticket=${ticket}`),{
        ADMIN_SECRET:'fixture',ledger:async()=>({status:200}),
        media:async()=>new Response('426 Forbidden',{status:426})});
    assert.equal(r.status,502);assert.equal((await r.json()).upstreamStatus,426);
});

test('one authenticated outbound proxy carries metadata and media requests',async()=>{
    const video=Uint8Array.from([0,0,0,24,102,116,121,112]);
    const target=createServer((req,res)=>{
        assert.equal(req.headers['proxy-authorization'],undefined);
        if(req.url==='/metadata') {res.setHeader('content-type','application/json');res.end('{"ok":true}');}
        else {assert.equal(req.headers.range,'bytes=0-7');res.writeHead(206,{'Content-Type':'video/mp4','Content-Range':'bytes 0-7/100'});res.end(video);}
    });
    target.listen(0,'127.0.0.1');await once(target,'listening');
    const proxy=createServer(),sockets=new Set(),tunnels=[];
    proxy.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
    proxy.on('connect',(req,client,head)=>{
        tunnels.push(req.url);
        assert.equal(req.headers['proxy-authorization'],'Basic '+Buffer.from('fixture:password').toString('base64'));
        const upstream=connect(target.address().port,'127.0.0.1',()=>{
            client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if(head.length)upstream.write(head);
            upstream.pipe(client);client.pipe(upstream);
        });
        client.on('close',()=>upstream.destroy());upstream.on('error',()=>client.destroy());
    });
    proxy.listen(0,'127.0.0.1');await once(proxy,'listening');
    const outbound=createOutboundFetch(`http://fixture:password@127.0.0.1:${proxy.address().port}`);
    try {
        assert.equal((await(await outbound('http://metadata.fixture/metadata')).json()).ok,true);
        const r=await outbound('http://media.fixture/video',{headers:{Range:'bytes=0-7'}});
        assert.equal(r.status,206);assert.deepEqual(new Uint8Array(await r.arrayBuffer()),video);
        assert.deepEqual(tunnels.sort(),['media.fixture:80','metadata.fixture:80']);
    } finally {
        await outbound.close();
        for(const socket of sockets)socket.destroy();
        await Promise.all([new Promise(resolve=>proxy.close(resolve)),new Promise(resolve=>target.close(resolve))]);
    }
});

test('proxy configuration rejects invalid values without echoing credentials',()=>{
    for(const value of ['socks5://name:password@host:1080','not a URL','https://user:password@host/path'])
        assert.throws(()=>createOutboundFetch(value),{message:'MOVIEBOX_PROXY_URL must be an HTTP(S) proxy URL'});
});

test('MovieBox source signing uses the injected transport',async()=>{
    const requests=[];
    const engine=new MovieBox(async(input,init)=>{
        requests.push(String(input));
        if(String(input).includes('/detail?'))return Response.json({data:{subject:{subjectId:'123456',title:'Fixture'}}});
        if(String(input).includes('/subject/play?'))return Response.json({data:{dash:[{
            id:'123456',url:'https://sbcdnw.hakunaymatata.com/video.mpd',
            format:'DASH',signHeaderKey:'X-MB-Token',signCookie:'fixture-signature'}]}});
        throw new Error('Unexpected request');
    });
    engine.token='fixture';engine.tokenUntil=Date.now()+10000;
    const result=await engine.sources('123456',{});
    assert.equal(result.results[0].headers['X-MB-Token'],'fixture-signature');
    assert.equal(result.results[0].headers.Cookie,undefined);
    assert.equal(requests.length,2);
});
