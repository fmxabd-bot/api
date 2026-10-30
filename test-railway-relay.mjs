import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const relaySecret='relay-test-only';
async function startRelay() {
    const reservation=createServer();
    reservation.listen(0,'127.0.0.1');
    await once(reservation,'listening');
    const port=reservation.address().port;
    await new Promise(resolve=>reservation.close(resolve));
    const child=spawn(process.env.PYTHON||'python3',['python-origin/local.py'],{
        cwd:new URL('.',import.meta.url),
        env:{PATH:process.env.PATH,HOME:process.env.HOME,PORT:String(port),RELAY_SECRET:relaySecret,PYTHONPATH:process.env.PYTHONPATH||''},
        stdio:['ignore','pipe','pipe']
    });
    let output='';
    child.stdout.on('data',chunk=>output+=chunk);
    child.stderr.on('data',chunk=>output+=chunk);
    const origin=`http://127.0.0.1:${port}`;
    const deadline=Date.now()+10000;
    while(Date.now()<deadline) {
        if(child.exitCode!==null)throw new Error(`Relay exited before health check: ${output}`);
        try {
            const response=await fetch(origin+'/health');
            if(response.ok)return {child,origin};
        } catch {}
        await new Promise(resolve=>setTimeout(resolve,100));
    }
    child.kill('SIGTERM');
    throw new Error(`Relay did not become healthy: ${output}`);
}

test('Railway relay is healthy and exposes no public API-key or arbitrary proxy routes',async t=>{
    const relay=await startRelay();
    t.after(()=>relay.child.kill('SIGTERM'));
    const health=await fetch(relay.origin+'/health').then(r=>r.json());
    assert.equal(health.service,'movieapi-origin');
    assert.equal((await fetch(relay.origin+'/api/v3/search/test')).status,404);
    assert.equal((await fetch(relay.origin+'/proxy?url=https://example.com')).status,404);
});

test('MovieBox internal routes require the private relay secret and validate inputs',async t=>{
    const relay=await startRelay();
    t.after(()=>relay.child.kill('SIGTERM'));
    const body=JSON.stringify({action:'not-allowed',params:{}});
    const unauthorized=await fetch(relay.origin+'/internal/moviebox',{
        method:'POST',headers:{'content-type':'application/json'},body
    });
    assert.equal(unauthorized.status,401);
    const invalid=await fetch(relay.origin+'/internal/moviebox',{
        method:'POST',headers:{'content-type':'application/json','x-relay-secret':relaySecret},body
    });
    assert.equal(invalid.status,400);
    const badTicket=await fetch(relay.origin+'/internal/moviebox-media',{
        method:'POST',headers:{'content-type':'application/json','x-relay-secret':relaySecret},
        body:JSON.stringify({ticket:'not-a-signed-ticket'})
    });
    assert.equal(badTicket.status,401);
});

test('production MovieAPI routing has no second-API or Replit relay configuration',async()=>{
    const runtime=await readFile(new URL('./runtime-worker.js',import.meta.url),'utf8');
    const worker=await readFile(new URL('./worker.js',import.meta.url),'utf8');
    const config=await readFile(new URL('./wrangler.toml',import.meta.url),'utf8');
    const pythonOrigin=await readFile(new URL('./python-origin/server.py',import.meta.url),'utf8');
    const railwayConfig=await readFile(new URL('./railway.toml',import.meta.url),'utf8');
    for(const source of [runtime,worker,config,pythonOrigin]) {
        assert.equal(source.includes('MOVIE_BACKEND_URL'),false);
        assert.equal(source.includes('daratech-backend-production'),false);
        assert.equal(source.includes('replit.app'),false);
        assert.equal(source.includes('REPLIT_PROXY_BASE'),false);
    }
    assert.match(railwayConfig,/MOVIEAPI_SOURCE_BUNDLE/);
    assert.match(railwayConfig,/python -c/);
    assert.doesNotMatch(railwayConfig,/node relay-server\.js/);
    assert.match(pythonOrigin,/CurlStreamClient/);
    assert.match(runtime,/env\.ENGINE_RELAY_URL/);
    assert.match(runtime,/env\.RELAY_SECRET/);
    assert.match(runtime,/env\.MOVIE_RELAY_SECRET/);
});
