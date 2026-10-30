import { catalog } from './catalog.js';
import { normalize, UpstreamError } from './moviebox.js';
import { seal, open, fetchMedia, safeMediaUrl } from './tickets.js';
import { timingSafeEqual,randomBytes,createHmac } from 'node:crypto';
import { playbackLinks,downloadFilename,attachmentHeader,mediaFormat } from './media-links.js';
import { storedPlayback,playbackPattern } from './playback-sessions.js';
import { extractApiKey,publicKey,keyState,keyCodes } from './key-config.js';
import {keyContact} from './key-contact.js';

const allowedHeaders='Content-Type,Authorization,X-API-Key,apikey,api-key,Range,If-Range';
const exposedHeaders='Content-Range,Content-Length,Accept-Ranges,Retry-After,X-RateLimit-Limit,X-RateLimit-Remaining,X-RateLimit-Reset,X-RateLimit-Monthly-Limit,X-RateLimit-Monthly-Remaining,X-RateLimit-AllTime-Limit,X-RateLimit-AllTime-Remaining';

export function json(data,status=200) {
    const headers={'Content-Type':'application/json; charset=utf-8',
        'Cache-Control':'no-store','Access-Control-Allow-Origin':'*',
            'Access-Control-Allow-Headers':allowedHeaders,
            'Access-Control-Allow-Methods':'GET,HEAD,POST,PUT,DELETE,OPTIONS',
            'Access-Control-Expose-Headers':exposedHeaders,
            ...(data.retryAfter?{'Retry-After':String(data.retryAfter)}:{}),
            ...(status===401?{'WWW-Authenticate':'Bearer realm="RUNFLIX MovieAPI"'}:{})};
    if(status>=400) {
        const hideUpstreamDetails=status>=500&&data.code!=='KEY_STORE_UNAVAILABLE';
        const publicServerError='Movie data is temporarily unavailable. Please try again shortly.';
        const error={
            status,success:false,creator:'DaraTech',
            code:data.code||({400:'VALIDATION_ERROR',401:'UNAUTHORIZED',403:'FORBIDDEN',404:'NOT_FOUND',
                405:'METHOD_NOT_ALLOWED',409:'CONFLICT',410:'ENDPOINT_REMOVED',413:'REQUEST_TOO_LARGE',
                429:'RATE_LIMITED',502:'UPSTREAM_ERROR',503:'SERVICE_UNAVAILABLE'}[status]||'INTERNAL_ERROR'),
            error:hideUpstreamDetails?publicServerError:(data.error||data.message||'Request failed'),
            message:hideUpstreamDetails?publicServerError:(data.message||data.error||'Request failed'),
        };
        for(const name of ['hint','contact','contactAction','contactLabel','period','retryAfter','upstreamStatus','requestId'])
            if(data[name]!==undefined&&data[name]!==null&&!(hideUpstreamDetails&&name==='upstreamStatus'))error[name]=data[name];
        if(error.retryAfter)headers['Retry-After']=String(error.retryAfter);
        return new Response(JSON.stringify(error,null,2),{status,headers});
    }
    return Response.json({status,success:true,creator:'DaraTech',...data},{status,headers});
}
export function secretEqual(a,b) {
    if(!a || !b) return false;
    const x=Buffer.from(a),y=Buffer.from(b);
    return x.length===y.length && timingSafeEqual(x,y);
}
const keyFrom=extractApiKey;
const num=(v,def,max=10000)=> {
    if(v===null || v===undefined || v==='') return def;
    const n=Number(v);
    if(!Number.isInteger(n)||n<0||n>max) throw new UpstreamError(`Invalid numeric parameter: ${v}`,400);
    return n;
};
const anime=i=>/anime|animation/i.test((i.genre||'')+' '+(i.genres||[]).join(','));
function homeItems(data) {
    const sections=data.operatingList || data.items || [];
    const items=sections.flatMap(s=>[...(s.subjects||[]),...(s.banner?.items||[]).map(b=>b.subject||b)]);
    return [...new Map(items.filter(s=>s.subjectId).map(s=>[String(s.subjectId),normalize(s)])).values()];
}
function seasons(data) {
    return (data.seasons || []).map(s=>{
        const season=Number(s.se ?? s.season ?? 1);
        const raw=s.episodes || (s.allEp?String(s.allEp).split(','):Array.from({length:Number(s.maxEp||0)},(_,i)=>i+1));
        return {season,title:s.title || `Season ${season}`,totalEpisodes:Number(s.maxEp || raw.length),
            episodes:raw.map(e=>typeof e==='object'?{...e,episode:Number(e.ep||e.episode),title:e.title || null,description:e.description || null}:
                {episode:Number(e),title:null,description:null}),resolutions:s.resolutions || []};
    });
}
async function bodyJson(request) {
    try {const data=await request.json(); if(!data || Array.isArray(data)||typeof data!=='object')throw new Error();return data;}
    catch{throw Object.assign(new UpstreamError('A JSON object is required',400),{code:'INVALID_JSON'});}
}
async function route(request,env) {
    const url=new URL(request.url), path=url.pathname, method=request.method;
    try {
        if(method==='OPTIONS') return new Response(null,{status:204,headers:{
            'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':allowedHeaders,
            'Access-Control-Allow-Methods':'GET,HEAD,POST,PUT,DELETE,OPTIONS','Access-Control-Max-Age':'86400'}});
        if(path==='/api/v3/health') return json({version:'2.0.0',storage:env.STORAGE_LABEL,timestamp:new Date().toISOString()});
        if(path==='/api/v3/catalog') return json({endpoints:catalog});
        if(['/api/key/check','/key/info','/api/v3/key/info'].includes(path)) {
            if(!['GET','POST'].includes(method))return json({message:'Use GET or POST'},405);
            const data=method==='POST'?await bodyJson(request):{};
            const suppliedKey=keyFrom(request)||data.key||'';
            const checked=await env.ledger({action:'check',key:suppliedKey});
            if(checked.key) {
                checked.key=publicKey(checked.key);
                checked.keyStatus=keyState(checked.key);
                checked.code=keyCodes[checked.keyStatus]||'API_KEY_VALID';
                checked.quotaExceeded=checked.keyStatus.endsWith('limit_exceeded');
                checked.quotaExhausted=checked.quotaExceeded;
                Object.assign(checked,keyContact(suppliedKey,checked.quotaExceeded?'limit increase':'key upgrade'));
                const k=checked.key;
                Object.assign(checked,{owner:k.owner,domain:k.domain,plan:k.plan,requests:k.usage.allTime,
                    limit:k.limits.allTime,dailyLimit:k.limits.daily,monthlyLimit:k.limits.monthly,
                    dailyUsed:k.usage.daily,monthlyUsed:k.usage.monthly,createdAt:k.createdAt,
                    expiresAt:k.expiresAt,lastUsed:k.usage.lastUsed});
            } else checked.keyStatus={API_KEY_MISSING:'missing',API_KEY_EXPIRED:'expired',
                API_KEY_DISABLED:'disabled',KEY_STORE_UNAVAILABLE:'store_unavailable'}[checked.code]||'invalid';
            return json(checked,checked.status);
        }
        if(['/api/request-key','/request-key/submit'].includes(path)) {
            if(method!=='POST')return json({message:'Use POST'},405);
            const input=await bodyJson(request);
            const ip=request.headers.get('cf-connecting-ip')||request.headers.get('x-forwarded-for')?.split(',')[0]||'unknown';
            const rateKey=createHmac('sha256',env.ADMIN_SECRET||'movieapi-request-rate').update(ip).digest('hex');
            const result=await env.ledger({action:'request-submit',input,rateKey});
            return json(result,result.status);
        }
        if(path.startsWith('/admin/api/')) {
            if(!secretEqual(extractApiKey(request,{admin:true}),env.ADMIN_SECRET)) return json({message:'Unauthorized',code:'ADMIN_UNAUTHORIZED'},401);
            if(path==='/admin/api/generate' && method==='POST') return json({key:`runflix_${crypto.randomUUID().replaceAll('-','')}`});
            if(path==='/admin/api/requests'&&method==='GET') {
                const result=await env.ledger({action:'request-list'});return json(result,result.status);
            }
            const review=path.match(/^\/admin\/api\/requests\/([^/]+)(?:\/(approve|reject))?$/);
            if(review) {
                const id=decodeURIComponent(review[1]);
                const action=method==='POST'&&review[2]?'request-'+review[2]:
                    method==='DELETE'&&!review[2]?'request-delete':null;
                if(!action)return json({message:'Unsupported request operation'},405);
                const result=await env.ledger({action,id,...(method==='POST'?{input:await bodyJson(request)}:{})});
                return json(result,result.status);
            }
            let result;
            const key=path.startsWith('/admin/api/keys/')?decodeURIComponent(path.slice('/admin/api/keys/'.length)):null;
            if(path==='/admin/api/keys' && method==='GET') result=await env.ledger({action:'list'});
            else if(path==='/admin/api/keys' && method==='POST') result=await env.ledger({action:'create',input:await bodyJson(request)});
            else if(key && method==='PUT') result=await env.ledger({action:'update',key,input:await bodyJson(request)});
            else if(key && method==='DELETE') result=await env.ledger({action:'delete',key});
            else return json({message:'Unsupported admin operation'},405);
            return json(result,result.status);
        }
        // Retired routes cannot fall through to old code or cached sample responses.
        if(/^\/(?:api\/v3\/(?:live|schedule|seasons\/upcoming)(?:\/|$)|sample-(?:live|schedule|seasons-upcoming)|test-channels)/.test(path))
            return json({message:'This endpoint has been removed. Football is available at /api/v3/football.'},410);
        if(!path.startsWith('/api/v3/')) return null;
        const media=path.match(/^\/api\/v3\/media\/([^/]+)\/(.*)$/);
        const ticket=url.searchParams.get('ticket') || media?.[1];
        const stored=playbackPattern.test(path);
        if(['/api/v3/stream','/api/v3/download'].includes(path)||media||stored) {
            if(!['GET','HEAD'].includes(method)) return json({message:'Use GET or HEAD'},405);
            if(!ticket&&!stored) return json({message:'Use a stream or download URL from /sources. Arbitrary URLs are not accepted.'},400);
            const data=stored?await storedPlayback(request,env):open(ticket,env.ADMIN_SECRET);
            const checked=await env.ledger({action:'check',key:data.key,origin:request.headers.get('origin')});
            if(checked.status!==200) return json(checked,checked.status);
            let target=data.url;
            if(media) {
                // Ticket authorizes just this manifest directory, not arbitrary URLs.
                const base=new URL('.',data.url),child=new URL(media[2]+url.search,base);
                if(child.origin!==base.origin || !child.pathname.startsWith(base.pathname)) throw new UpstreamError('Media path escapes its signed directory',403);
                target=child.href;
            }
            const upstream=await env.media(target,data.headers,request.headers.get('range'),method);
            if(!upstream.ok&&upstream.status!==416) {
                const status=upstream.status; await upstream.body?.cancel();
                return json({message:`MovieBox media returned HTTP ${status}. Request fresh sources if the signed link expired.`,upstreamStatus:status},status===429?429:502);
            }
            const headers=new Headers({'Access-Control-Allow-Origin':'*','Access-Control-Expose-Headers':'Content-Range,Content-Length,Accept-Ranges',
                'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});
            for(const h of ['content-type','content-length','content-range','accept-ranges','etag','last-modified']) {
                if(upstream.headers.has(h)) headers.set(h,upstream.headers.get(h));
            }
            if(method==='HEAD'&&upstream.headers.has('x-media-content-length'))
                headers.set('Content-Length',upstream.headers.get('x-media-content-length'));
            const type=headers.get('content-type') || '';
            if(upstream.status!==416&&/(?:text\/html|application\/(?:problem\+)?json)/i.test(type)) {
                await upstream.body?.cancel();
                return json({message:'MovieBox returned an error document instead of media',upstreamStatus:upstream.status},502);
            }
            if(path==='/api/v3/download'||path.startsWith('/api/v3/download/')) {
                const ext=/mpegurl/i.test(type)?'m3u8':/dash\+xml/i.test(type)?'mpd':
                    /mp2t/i.test(type)?'ts':/webm/i.test(type)?'webm':
                    new URL(target).pathname.match(/\.(mp4|m4s|m4a|ts|m3u8|mpd)$/i)?.[1]?.toLowerCase() || 'mp4';
                const filename=data.filename?data.filename.replace(/\.[^.]+$/,'.'+ext):
                    downloadFilename(data.title,0,0,'Adaptive',ext==='mpd'?'dash':ext==='m3u8'?'hls':ext);
                headers.set('Content-Disposition',attachmentHeader(filename));
                headers.set('Access-Control-Expose-Headers','Content-Range,Content-Length,Accept-Ranges,Content-Disposition');
            }
            if(method!=='HEAD' && (/mpegurl|dash\+xml/.test(type)||/\.(m3u8|mpd)(?:\?|$)/.test(target))) {
                let text=await upstream.text();
                if(!(/dash\+xml/.test(type)||/\.mpd(?:\?|$)/.test(target) ?
                    /<MPD(?:\s|>)/.test(text) : text.trimStart().startsWith('#EXTM3U'))) {
                    return json({message:'MovieBox returned an invalid media manifest',upstreamStatus:upstream.status},502);
                }
                const proxied=(relative)=>{
                    if(!relative || /^(data:|urn:)/.test(relative)) return relative;
                    const absolute=safeMediaUrl(new URL(relative,target).href).href;
                    const t=seal({...data,url:absolute},env.ADMIN_SECRET);
                    return `${url.origin}/api/v3/stream?ticket=${t}`;
                };
                if(/\.mpd(?:\?|$)/.test(target)||/dash\+xml/.test(type)) {
                    // SegmentTemplate substitutions must remain outside the encrypted
                    // ticket. A signed directory URL preserves $Number$ / $Time$.
                    const baseTicket=seal({...data,url:target},env.ADMIN_SECRET);
                    const base=`${url.origin}/api/v3/media/${baseTicket}/`;
                    text=text.replace(/<BaseURL(?:\s[^>]*)?>[\s\S]*?<\/BaseURL>/g,'');
                    text=text.replace(/(<MPD\b[^>]*>)/,`$1<BaseURL>${base}</BaseURL>`);
                } else {
                    text=text.split('\n').map(line=>line.trim()&&!line.startsWith('#')?proxied(line.trim()):
                        line.replace(/URI="([^"]+)"/g,(_,v)=>`URI="${proxied(v)}"`)).join('\n');
                }
                headers.delete('content-length');return new Response(text,{status:upstream.status,headers});
            }
            return new Response(method==='HEAD'?null:upstream.body,{status:upstream.status,headers});
        }
        if(method!=='GET') return json({message:'Use GET for this endpoint'},405);
        const recognized=catalog.some(e=>new RegExp('^'+e.path.replace(/:[^/]+/g,'[^/]+')+'$').test(path));
        if(!recognized) return json({message:'Endpoint not found'},404);
        const key=keyFrom(request);
        const quota=await env.ledger({action:'consume',key,origin:request.headers.get('origin')});
        if(quota.status!==200) {
            const r=json(quota,quota.status);
            if(quota.retryAfter) r.headers.set('Retry-After',String(quota.retryAfter));
            return r;
        }
        // Manga keeps its existing provider but now passes through the same quota gate.
        if(path.startsWith('/api/v3/manga')) return null;
        const p={page:num(url.searchParams.get('page'),1),perPage:num(url.searchParams.get('perPage'),20,100),
            type:num(url.searchParams.get('type'),0,2),season:num(url.searchParams.get('season')||url.searchParams.get('se'),0),
            episode:num(url.searchParams.get('episode')||url.searchParams.get('ep'),0)};
        if(!p.page || !p.perPage) throw new UpstreamError('page and perPage must be greater than zero',400);
        const tail=path.slice('/api/v3/'.length).split('/').map(decodeURIComponent);
        const isAnime=tail[0]==='anime';
        if(isAnime && tail.length>1) tail.shift();
        let action=tail[0], result;
        if(action==='homepage') result=await env.engine('home',{});
        else if(action==='trending'||action==='anime') {
            let items=homeItems(await env.engine('home',{}));
            if(action==='anime') items=items.filter(anime);
            if(p.type)items=items.filter(i=>i.subjectType===p.type);
            const offset=(p.page-1)*p.perPage;
            result={items:items.slice(offset,offset+p.perPage),total:items.length,page:p.page,perPage:p.perPage,hasMore:offset+p.perPage<items.length};
        } else if(action==='search') {
            p.query=tail[1]?.trim(); if(!p.query)throw new UpstreamError('Search query required',400);
            result=await env.engine('search',p);
            if(isAnime) result.items=result.items.filter(anime);
            if(p.type) result.items=result.items.filter(i=>i.subjectType===p.type);
        } else if(action==='filter') {
            for(const name of ['sort','genre','country','year','language']) p[name]=url.searchParams.get(name)||undefined;
            const raw=await env.engine('filter',p);
            result={...raw,items:(raw.items||raw.subjects||[]).map(normalize)};
        } else if(['info','episodes','season','sources','captions'].includes(action)) {
            p.id=tail[1]; if(!/^\d{5,30}$/.test(p.id||'')) throw new UpstreamError('A numeric MovieBox subject ID is required',400);
            if(isAnime) {
                const info=await env.engine('info',p);
                if(!anime(info)) throw new UpstreamError('This title is not in the Anime/Animation genre',404);
            }
            if(action==='episodes'||action==='season') {
                const data=await env.engine('episodes',p), list=seasons(data);
                if(action==='episodes') return json({title:data.title,seasons:list,totalEpisodes:list.reduce((n,s)=>n+s.episodes.length,0)});
                const season=list.find(s=>s.season===num(tail[2],1));
                return season?json({title:data.title,season:season.season,seasonTitle:season.title,episodes:season.episodes}):json({message:'Season not found'},404);
            }
            if(action==='captions') {
                p.streamId=tail[2];if(!/^\d+$/.test(p.streamId||''))throw new UpstreamError('A numeric stream ID is required',400);
                result=await env.engine('captions',p);
                const format=url.searchParams.get('format')?.toLowerCase();
                if(format) result=result.filter(c=>String(c.url||'').split('?')[0].toLowerCase().endsWith('.'+format));
            } else result=await env.engine(action,p);
            if(action==='sources') return await sourceResponse(result,key,url,env,p);
        } else if(action==='football') {
            p.id=tail[1];
            const name=tail[2]==='sources'?'football-sources':p.id?'football-info':'football';
            result=await env.engine(name,p);
            if(name==='football-sources') return await sourceResponse(result,key,url,env,{...p,kind:'football'});
            // Do not expose unproxied playPath from the scraper.
            if(result.items)result.items=result.items.map(({playPath,playSource,...r})=>r);
            else {delete result.playPath;delete result.playSource;}
        } else return json({message:'Endpoint not found'},404);
        return json({results:result});
    } catch(e) {return json({message:e.message||'Request failed',...(e.code?{code:e.code}:{})},e.status || 502);}
}
export async function modernRoute(request,env) {
    let record;
    const runtime={...env,ledger:async data=>{
        let result;
        try{result=await env.ledger(data);}
        catch(e){
            result=e.status&&e.status<500?{status:e.status,code:e.code,message:e.message}:
                {status:503,code:'KEY_STORE_UNAVAILABLE',message:'API key storage is temporarily unavailable. No operation has been confirmed.'};
        }
        if(data.action==='consume'&&result.key)record=result.key;
        return result;
    }};
    const response=await route(request,runtime);
    if(response&&record) {
        const h=response.headers;
        for(const [label,period]of [['','daily'],['-Monthly','monthly'],['-AllTime','allTime']]) {
            h.set('X-RateLimit'+label+'-Limit',record.limits[period]===null?'unlimited':String(record.limits[period]));
            h.set('X-RateLimit'+label+'-Remaining',record.remaining[period]===null?'unlimited':String(record.remaining[period]));
        }
        const now=new Date();h.set('X-RateLimit-Reset',String(Math.floor(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()+1)/1000)));
    }
    return response;
}
async function sourceResponse(data,key,url,env,p) {
    const expires=Date.now()+6*60*60*1000,entries=[];
    const results=data.results.map(({headers,url:raw,...s})=>{
        safeMediaUrl(raw);
        const token=randomBytes(18).toString('base64url');
        const links=playbackLinks(url.origin,token);
        const filename=downloadFilename(data.title,p.season,p.episode,s.quality,mediaFormat({...s,url:raw}));
        entries.push({token,expires,data:{url:raw,headers,title:data.title,filename}});
        return {...s,url:links.streamUrl,...links,
            filename,expiresAt:new Date(expires).toISOString()};
    });
    if(entries.length) {
        const saved=await env.ledger({action:'playback-save',key,input:{entries}});
        if(saved.status!==200)throw new UpstreamError(saved.message||'Playback storage unavailable',saved.status);
    }
    const preferred=results.find(s=>mediaFormat(s)==='mp4'&&s.browserCompatible!==false)||results[0];
    return json({title:data.title,season:p.season||0,episode:p.episode||0,
        streamUrl:preferred?.streamUrl||null,downloadUrl:preferred?.downloadUrl||null,
        filename:preferred?.filename||null,results,subtitles:data.subtitles||[],audioTracks:data.audioTracks||[]});
}
