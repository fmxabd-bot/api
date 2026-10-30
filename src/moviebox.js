import { createHash, createHmac, randomBytes } from 'node:crypto';
import * as cheerio from 'cheerio';

// Protocol adapted from walterwhite-69/Moviebox-API (MIT); see UPSTREAM-LICENSE.txt.
const SECRET = Buffer.from('76iRl07s0xSN9jqmEWAt79EBJZulIQIsV64FZr2O','base64');
const UA = 'com.community.mbox.in/50020130 (Linux; U; Android 14; en_IN; Pixel 8; Build/UD1A.230803.041; Cronet/145.0.7582.0)';
const WEB_UA = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
const HOSTS = ['https://api3.aoneroom.com','https://apig.inmoviebox.com','https://api6.aoneroom.com'];
const WEB = ['https://movieboxhd.net','https://123moviesfree.club','https://netnaija.film','https://h5-api.aoneroom.com','https://sflix.film'];
export class UpstreamError extends Error {
    constructor(message, status=502) { super(message); this.status=status; }
}
const md5 = v => createHash('md5').update(v).digest('hex');
const image = v => typeof v === 'object' ? v?.url || null : v || null;
export function normalize(item) {
    const s=item.subject || item;
    return { ...s, id:String(s.subjectId || s.id || ''),subjectId:String(s.subjectId || s.id || ''),
        title:s.title || s.name || '', thumbnail:image(s.cover || s.image || s.thumbnail),
        description:s.description || null,subjectType:s.subjectType,
        genres: typeof s.genre === 'string' ? s.genre.split(',').map(v=>v.trim()) : s.genres || [],
        rating:s.imdbRatingValue || null };
}
export function mediaHeaders(source,base={}) {
    const headers={...base};
    if(source.signCookie) {
        const name=source.signHeaderKey || 'Cookie';
        if(!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name) ||
            /^(host|authorization|proxy-authorization|connection|content-length|transfer-encoding|range)$/i.test(name) ||
            /[\r\n]/.test(source.signCookie))
            throw new UpstreamError('MovieBox returned an invalid media signing header');
        headers[name]=source.signCookie;
    }
    return headers;
}
export class MovieBox {
    constructor(fetcher=globalThis.fetch.bind(globalThis)) {
        this.fetch=fetcher;
        this.device=randomBytes(16).toString('hex');
        this.token=null; this.tokenUntil=0; this.bootstrapPromise=null;
        this.ci=JSON.stringify({package_name:'com.community.mbox.in',version_name:'4.0.03.0920.03',
            version_code:50020130,os:'android',os_version:'14',device_id:this.device,install_store:'official',
            gaid:'1b2212c1-dadf-43c3-a0c8-bd6ce48ae22d',brand:'Google',model:'Pixel 8',system_language:'en',
            net:'NETWORK_WIFI',region:'IN',timezone:'Asia/Calcutta',sp_code:''});
    }
    headers(method,url,body=null,token=this.token) {
        const ts=Date.now(), u=new URL(url), segments=u.search.slice(1).split('&').filter(Boolean).sort((a,b)=>a.split('=')[0].localeCompare(b.split('=')[0]));
        const canonical=[method,'application/json','application/json',body?String(Buffer.byteLength(body)):'',String(ts),
            body?md5(Buffer.from(body).subarray(0,102400)):'',u.pathname+(segments.length?'?'+segments.join('&'):'')].join('\n');
        return {'User-Agent':UA,Accept:'application/json','Content-Type':'application/json',
            'x-client-token':`${ts},${md5(String(ts).split('').reverse().join(''))}`,
            'x-tr-signature':`${ts}|2|${createHmac('md5',SECRET).update(canonical).digest('base64')}`,
            'x-client-info':this.ci,'x-client-status':'0',...(token?{Authorization:`Bearer ${token}`}:{})};
    }
    async bootstrap(force=false) {
        if (!force && this.token && Date.now()<this.tokenUntil) return;
        if(this.bootstrapPromise) return this.bootstrapPromise;
        this.bootstrapPromise=(async()=>{
            let last;
            // Current web homepage also issues x-user, and remains available in
            // regions where the repository's mobile bootstrap is rejected.
            for (const host of WEB) {
                try {
                    const r=await this.fetch(`${host}/wefeed-h5api-bff/home?host=movieboxhd.net`,{
                        headers:{'User-Agent':WEB_UA,Referer:host+'/'},signal:AbortSignal.timeout(10000)});
                    const token=JSON.parse(r.headers.get('x-user') || '{}').token;
                    await r.body?.cancel();
                    if(token){this.token=token;this.tokenUntil=Date.now()+40*60*1000;return;}
                } catch(e){last=e;}
            }
            for (const host of ['https://apig.inmoviebox.com',...HOSTS]) {
                const url=host+'/wefeed-mobile-bff/tab/ranking-list?tabId=0&categoryType=4516404531735022304&page=1&perPage=1';
                try {
                    const r=await this.fetch(url,{headers:this.headers('GET',url,null,null),signal:AbortSignal.timeout(12000)});
                    const token=JSON.parse(r.headers.get('x-user') || '{}').token;
                    if(token) {this.token=token;this.tokenUntil=Date.now()+40*60*1000; await r.body?.cancel();return;}
                    last=new Error(`Bootstrap HTTP ${r.status}`);
                    await r.body?.cancel();
                } catch(e) {last=e;}
            }
            throw new UpstreamError(`MovieBox token bootstrap failed: ${last?.message}`);
        })();
        try {await this.bootstrapPromise;} finally {this.bootstrapPromise=null;}
    }
    async native(path, body=null, retry=true) {
        await this.bootstrap();
        let last;
        for(const host of HOSTS) {
            const url=host+path, text=body===null?null:JSON.stringify(body), method=text?'POST':'GET';
            try {
                const r=await this.fetch(url,{method,headers:this.headers(method,url,text),body:text,signal:AbortSignal.timeout(16000)});
                if(!r.ok) {await r.body?.cancel();throw new Error(`HTTP ${r.status}`);}
                const data=await r.json();
                if([401,440,441].includes(Number(data.code))) {
                    if(retry) {await this.bootstrap(true);return this.native(path,body,false);}
                    throw new Error(`Authentication rejected (${data.code})`);
                }
                if(data.code !== undefined && ![0,200].includes(Number(data.code))) throw new Error(`MovieBox ${data.code}: ${data.message || data.msg || 'request rejected'}`);
                return data.data ?? data;
            } catch(e) {last=e;}
        }
        throw new UpstreamError(`MovieBox request failed: ${last?.message}`);
    }
    async web(path,body=null) {
        if(path !== '/home?host=movieboxhd.net') await this.bootstrap();
        let last;
        for(const host of WEB) {
            try {
                const r=await this.fetch(host+'/wefeed-h5api-bff'+path,{
                    method:body?'POST':'GET',headers:{'User-Agent':WEB_UA,Referer:host+'/',Origin:host,
                        Accept:'application/json','Content-Type':'application/json','x-client-info':'{"timezone":"Asia/Calcutta"}',
                        ...(this.token ? {Authorization:`Bearer ${this.token}`} : {})},
                    body:body?JSON.stringify(body):null,signal:AbortSignal.timeout(12000)});
                if(!r.ok){await r.body?.cancel();throw new Error(`HTTP ${r.status}`);}
                const data=await r.json();
                if(data.code !== undefined && ![0,200].includes(Number(data.code))) throw new Error(data.message || 'Upstream rejected request');
                return data.data ?? data;
            }catch(e){last=e;}
        }
        throw new UpstreamError(`MovieBox web request failed: ${last?.message}`);
    }
    async call(action,p={}) {
        const id=String(p.id || '');
        if(action==='home') return this.web('/home?host=movieboxhd.net');
        if(action==='search') {
            const data=await this.web('/subject/search',{keyword:p.query,page:p.page||1,perPage:p.perPage||20});
            return {items:(data.items || data.list || []).map(normalize),pager:data.pager || null};
        }
        if(action==='info') {
            const data=await this.web(`/detail?subjectId=${encodeURIComponent(id)}`);
            return {...normalize(data.subject || data),resource:data.resource,stars:data.stars,metadata:data.metadata};
        }
        if(action==='episodes') {
            const data=await this.web(`/detail?subjectId=${encodeURIComponent(id)}`);
            return {title:data.subject?.title || null,seasons:data.resource?.seasons || []};
        }
        if(action==='filter') {
            return this.web('/subject/filter',{tabId:p.type===2?5:4,filter:{sort:p.sort||'RECOMMEND',
                genre:p.genre||'ALL',country:p.country||'ALL',year:p.year||'ALL',language:p.language||'ALL'},
                page:p.page||1,perPage:p.perPage||20});
        }
        if(action==='sources') return this.sources(id,p);
        if(action==='captions') {
            const data=await this.native(`/wefeed-mobile-bff/subject-api/get-stream-captions?subjectId=${encodeURIComponent(id)}&streamId=${encodeURIComponent(p.streamId)}`);
            return Array.isArray(data)?data:data.extCaptions || data.captions || [];
        }
        if(['football','football-info','football-sources'].includes(action)) return this.football({...p,action});
        throw new UpstreamError('Unsupported MovieBox action',400);
    }
    async sources(id,p) {
        const se=Number(p.season||0), ep=Number(p.episode||0);
        const info=await this.call('info',{id});
        const detailPath=info.detailPath || String(info.detailUrl||'').split('/').pop() || '';
        await this.bootstrap();
        const results=[], seen=new Set();
        const add=(s,host)=>{
            const url=s.url;
            if(!url || seen.has(url)) return;
            seen.add(url);
            const q=String(s.resolutions || s.resolution || '');
            results.push({id:String(s.id||s.resourceId||''),url,quality:q.endsWith('p')?q:q+'p',
                qualityValue:parseInt(q)||0,format:s.format||(/\.mpd(?:\?|$)/.test(url)?'DASH':'MP4'),
                size:s.size||null,duration:s.duration||null,codec:s.codecName||null,
                browserCompatible:!/(hevc|h265|hvc1|hev1)/i.test(s.codecName||''),
                requireMemberType:s.requireMemberType??0,
                headers:mediaHeaders(s,{'User-Agent':host.includes('api3.')?UA:WEB_UA,Referer:host+'/',Origin:host})});
        };
        for (const host of WEB) {
            const qs=new URLSearchParams({subjectId:id,se:String(se),ep:String(ep),detailPath,streamSignType:'1','supportCodecs[hevc]':'1','supportCodecs[h264]':'1'});
            try {
                const r=await this.fetch(`${host}/wefeed-h5api-bff/subject/play?${qs}`,{headers:{'User-Agent':WEB_UA,
                    Referer:`${host}/movies/${detailPath}?id=${id}&type=/movie/detail`,Accept:'application/json',
                    'x-client-info':'{"timezone":"Asia/Calcutta"}','x-request-lang':'en','x-vip-restrict':'0',
                    'x-no-high-risk-restrict':'0','x-source':'moviebox',Authorization:`Bearer ${this.token}`},signal:AbortSignal.timeout(12000)});
                if(!r.ok){await r.body?.cancel();continue;}
                const d=(await r.json()).data || {};
                for(const s of [...d.streams || [],...d.dash || [],...d.hls || []]) add(s,host);
                if(results.length) break;
            }catch{}
        }
        if(!results.length) {
            const d=await this.native(`/wefeed-mobile-bff/subject-api/play-info?subjectId=${id}&se=${se}&ep=${ep}`);
            for(const s of d.streams || []) add(s,'https://api3.aoneroom.com');
        }
        if(!results.length) throw new UpstreamError('MovieBox returned no playable sources for this title/episode',404);
        return {title:info.title,results:results.sort((a,b)=>b.qualityValue-a.qualityValue),subtitles:[],audioTracks:info.dubs || []};
    }
    async football(p) {
        // Source is MovieBox's own live football page, not IPTV or a third-party score feed.
        const r=await this.fetch('https://movieboxhd.net/live',{headers:{'User-Agent':WEB_UA},signal:AbortSignal.timeout(20000)});
        if(!r.ok) throw new UpstreamError(`MovieBox football page HTTP ${r.status}`);
        const html=await r.text(), $=cheerio.load(html), matches=[], seen=new Set();
        const nuxtText=$('#__NUXT_DATA__').text();
        if(nuxtText) {
            const table=JSON.parse(nuxtText);
            const decode=(idx,depth=0)=>{
                if(depth>40) return null;
                if(typeof idx!=='number') return idx;
                if(idx<0) return null;
                const v=table[idx];
                if(Array.isArray(v)) return v.map(x=>decode(x,depth+1));
                if(v && typeof v==='object') return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,decode(x,depth+1)]));
                return v;
            };
            const entry=table.find(v=>v && typeof v==='object' && !Array.isArray(v) && 'matchList' in v);
            if(entry) {
                for(const m of decode(entry.matchList) || []) {
                    if(String(m.type).toLowerCase()!=='football') continue;
                    matches.push({...m,id:String(m.id),title:`${m.team1?.name || ''} vs ${m.team2?.name || ''}`,
                        source:'MovieBox',detailUrl:`https://movieboxhd.net/live/detail?id=${m.id}&sportType=football`});
                    seen.add(String(m.id));
                }
            }
        }
        $('a[href]').each((_,el)=>{
            const href=$(el).attr('href') || '';
            if(!/\/live\/(?:detail|match|football)|\/sports-detail\//i.test(href)) return;
            const url=new URL(href,'https://movieboxhd.net'), id=url.searchParams.get('id') || url.pathname.split('/').pop();
            if(url.searchParams.get('sportType') !== 'football') return;
            if(!id || seen.has(id)) return;
            seen.add(id); matches.push({id,title:$(el).text().replace(/\s+/g,' ').trim(),
                thumbnail:$(el).find('img').attr('src') || null,detailUrl:url.href});
        });
        if(!matches.length) throw new UpstreamError('MovieBox football feed is unavailable; no fixtures could be extracted. No substitute fixtures are returned.');
        if(p.id) {
            const match=matches.find(m=>m.id===p.id);
            if(!match) throw new UpstreamError('Match not found in the current MovieBox football feed',404);
            if(p.action==='football-sources') {
                if(!match.playPath || !/^https:/.test(match.playPath)) throw new UpstreamError('This match has no playable source yet',404);
                return {title:match.title,results:[{id:match.id,url:match.playPath,quality:'Live',format:'HLS',
                    headers:{'User-Agent':WEB_UA,Referer:'https://movieboxhd.net/',Origin:'https://movieboxhd.net'}}],subtitles:[],audioTracks:[]};
            }
            return match;
        }
        return {items:matches,source:'MovieBox'};
    }
}
