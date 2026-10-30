import legacy from './worker.js';
import { modernRoute, json, secretEqual } from './src/router.js';
import { seal } from './src/tickets.js';
export { ApiKeyLedger } from './src/quota-object.js';

function services(env) {
    const stub=env.API_KEY_LEDGER.get(env.API_KEY_LEDGER.idFromName('movieapi-key-ledger'));
    const relayUrl=String(env.ENGINE_RELAY_URL||'').replace(/\/+$/,'');
    const relaySecret=env.RELAY_SECRET||env.MOVIE_RELAY_SECRET;
    return {
        ...env, STORAGE_LABEL:'durable-sqlite',
        ledger:async data=>{
            const response=await stub.fetch('https://ledger.internal/',{method:'POST',body:JSON.stringify(data)});
            return response.json();
        },
        engine:async(action,params)=>{
            if(!relayUrl||!relaySecret) throw Object.assign(new Error('MovieBox Railway relay is not configured'),{status:503});
            const response=await fetch(relayUrl+'/internal/moviebox',{method:'POST',
                headers:{'Content-Type':'application/json','x-relay-secret':relaySecret},
                body:JSON.stringify({action,params}),signal:AbortSignal.timeout(90000)});
            const data=await response.json().catch(()=>null);
            if(!response.ok) {
                const upstreamFailure=response.status>=500;
                throw Object.assign(new Error(upstreamFailure
                    ?'Movie data is temporarily unavailable. Please try again shortly.'
                    :(data?.message||'Request could not be completed.')),{
                    status:upstreamFailure?502:response.status,
                    ...(data?.code?{code:data.code}:upstreamFailure?{code:'UPSTREAM_ERROR'}:{})
                });
            }
            return data?.results;
        },
        media:async(target,headers,range,method)=>{
            if(!relayUrl||!relaySecret) throw Object.assign(new Error('MovieBox Railway relay is not configured'),{status:503});
            const ticket=seal({url:target,headers,exp:Date.now()+120000},relaySecret);
            return fetch(relayUrl+'/internal/moviebox-media',{method:'POST',
                headers:{'Content-Type':'application/json','x-relay-secret':relaySecret,...(range?{Range:range}:{})},
                body:JSON.stringify({ticket,method})});
        }
    };
}
export default {
    async fetch(request,env,ctx) {
        const url=new URL(request.url),runtime=services(env);
        if(url.pathname==='/internal/ledger') {
            if(!secretEqual(request.headers.get('x-relay-secret'),env.ADMIN_SECRET)) return json({message:'Unauthorized'},401);
            try {const result=await runtime.ledger(await request.json());return json(result,result.status);}
            catch{return json({message:'Ledger operation failed'},503);}
        }
        const response=await modernRoute(request,runtime);
        if(response) return response;
        // Manga is the only legacy API provider; auth/quota is already enforced.
        if(url.pathname.startsWith('/api/v3/manga')) {
            const r=await legacy.fetch(request,env,ctx);
            const h=new Headers(r.headers);h.set('Access-Control-Allow-Origin','*');h.set('Cache-Control','no-store');
            return new Response(r.body,{status:r.status,headers:h});
        }
        return legacy.fetch(request,env,ctx);
    }
};
