// Railway origin: no public API keys, quotas, admin pages or local database.
// Cloudflare owns those; this service performs authenticated upstream I/O only.
import express from 'express';
import { Readable } from 'node:stream';
import { MovieBox } from './src/moviebox.js';
import { json, secretEqual } from './src/router.js';
import { open,fetchMedia } from './src/tickets.js';
import { createOutboundFetch } from './src/outbound.js';

const secret=process.env.RELAY_SECRET;
if(!secret) throw new Error('RELAY_SECRET must be configured before starting the Railway origin');
const outbound=createOutboundFetch();
const engine=new MovieBox(outbound),app=express();
const actions=new Set(['home','search','info','episodes','filter','sources','captions','football','football-info','football-sources']);
app.disable('x-powered-by');
app.use(express.json({limit:'32kb'}));
app.get('/health',(_req,res)=>res.json({success:true,service:'movieapi-origin',version:'2.0.0'}));
async function send(response,res) {
    res.status(response.status);
    for(const [k,v] of response.headers) res.setHeader(k,v);
    if(!response.body)return res.end();
    const stream=Readable.fromWeb(response.body);
    res.on('close',()=>stream.destroy());
    stream.on('error',()=>res.destroy());
    stream.pipe(res);
}
app.use('/internal',(req,res,next)=>{
    if(!secretEqual(req.headers['x-relay-secret'],secret))return res.status(401).json({message:'Unauthorized'});
    next();
});
app.post('/internal/moviebox',async(req,res)=>{
    try {
        if(!actions.has(req.body.action))return res.status(400).json({message:'Unknown MovieBox action'});
        const result=await engine.call(req.body.action,req.body.params||{});
        return send(json({results:result}),res);
    } catch(e){return send(json({message:e.message},e.status||502),res);}
});
app.post('/internal/moviebox-media',async(req,res)=>{
    try {
        const data=open(req.body.ticket,secret);
        return send(await fetchMedia(data.url,data.headers,req.headers.range,req.body.method==='HEAD'?'HEAD':'GET',outbound),res);
    } catch(e){return send(json({message:e.message},e.status||502),res);}
});
app.use((_req,res)=>res.status(404).json({message:'Not found'}));
app.use((err,_req,res,_next)=>res.status(err.status||500).json({message:err.status===413?'Request body is too large':'Invalid request'}));
app.listen(Number(process.env.PORT||3000),'0.0.0.0',()=>console.log('MovieAPI origin ready'));
