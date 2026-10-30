import { Readable } from 'node:stream';
import { MovieBox } from './moviebox.js';
import { modernRoute,json,secretEqual } from './router.js';
import { open,fetchMedia } from './tickets.js';
import { createOutboundFetch } from './outbound.js';

const outbound=createOutboundFetch();
const engine=new MovieBox(outbound);
const media=(url,headers,range,method)=>fetchMedia(url,headers,range,method,outbound);
const callEngine=(action,params)=>engine.call(action,params);
async function send(response,res) {
    res.status(response.status);
    for(const [k,v] of response.headers) res.setHeader(k,v);
    if(!response.body) return res.end();
    const stream=Readable.fromWeb(response.body);
    res.on('close',()=>stream.destroy());
    stream.on('error',()=>res.destroy());
    stream.pipe(res);
}
export function installModern(app) {
    app.use(async(req,res,next)=>{
        try {
            if(['/internal/moviebox','/internal/moviebox-media'].includes(req.path)) {
                if(!secretEqual(req.headers['x-relay-secret'],process.env.ADMIN_SECRET))
                    return send(json({message:'Unauthorized'},401),res);
                if(req.method!=='POST') return send(json({message:'Use POST'},405),res);
                if(req.path==='/internal/moviebox') {
                    const results=await callEngine(req.body.action,req.body.params||{});
                    return send(json({results}),res);
                }
                const data=open(req.body.ticket,process.env.ADMIN_SECRET);
                return send(await media(data.url,data.headers,req.headers.range,req.body.method==='HEAD'?'HEAD':'GET'),res);
            }
            if(process.env.NODE_ENV==='production' && (
                req.path.startsWith('/debug/') || req.path.startsWith('/try-') ||
                req.path.startsWith('/sample-') || req.path.startsWith('/internal/')
            )) return send(json({message:'Endpoint not available'},404),res);
            const protocol=req.headers['x-forwarded-proto']?.split(',')[0] || req.protocol;
            const url=`${protocol}://${req.get('host')}${req.originalUrl}`;
            const request=new Request(url,{method:req.method,headers:req.headers,
                ...(!['GET','HEAD'].includes(req.method)?{body:JSON.stringify(req.body||{})}:{})});
            const runtime={
                ADMIN_SECRET:process.env.ADMIN_SECRET,
                STORAGE_LABEL:process.env.KEY_LEDGER_URL?'durable-sqlite':'local-sqlite',
                ledger:async data=>{
                    if(process.env.KEY_LEDGER_URL) {
                        const r=await fetch(process.env.KEY_LEDGER_URL+'/internal/ledger',{method:'POST',
                            headers:{'Content-Type':'application/json','x-relay-secret':process.env.ADMIN_SECRET},
                            body:JSON.stringify(data),signal:AbortSignal.timeout(15000)});
                        if(r.status>=500)throw new Error('Quota storage unavailable; requests are blocked to protect limits');
                        return r.json();
                    }
                    if(process.env.NODE_ENV==='production') throw new Error('Persistent quota storage is not configured');
                    try{
                        const {localLedger}=await import('./local-ledger.js');
                        return localLedger.dispatch(data);
                    }
                    catch(e){return {status:e.status||503,code:e.code||'KEY_STORE_UNAVAILABLE',
                        message:e.status?e.message:'Persistent key storage is temporarily unavailable'};}
                },
                engine:callEngine,
                media
            };
            const response=await modernRoute(request,runtime);
            if(response) return send(response,res);
            next();
        } catch(e) {return send(json({message:e.message},e.status||502),res);}
    });
}
