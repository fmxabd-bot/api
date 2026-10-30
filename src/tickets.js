import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { UpstreamError } from './moviebox.js';

function key(secret) {
    if(!secret) throw new UpstreamError('Stream signing secret is not configured',503);
    return createHash('sha256').update(secret).digest();
}
export function seal(data,secret) {
    const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key(secret),iv);
    const body=Buffer.concat([cipher.update(JSON.stringify(data),'utf8'),cipher.final()]);
    return Buffer.concat([iv,cipher.getAuthTag(),body]).toString('base64url');
}
export function open(ticket,secret) {
    try {
        if(typeof ticket!=='string' || ticket.length>18000) throw new Error();
        const b=Buffer.from(ticket,'base64url'),cipher=createDecipheriv('aes-256-gcm',key(secret),b.subarray(0,12));
        cipher.setAuthTag(b.subarray(12,28));
        const data=JSON.parse(Buffer.concat([cipher.update(b.subarray(28)),cipher.final()]).toString());
        if(!data.exp || data.exp<Date.now()) throw new UpstreamError('Playback ticket expired; request fresh sources',401);
        return data;
    } catch(e) {
        if(e instanceof UpstreamError) throw e;
        throw new UpstreamError('Invalid playback ticket',401);
    }
}
export function safeMediaUrl(value) {
    const u=new URL(value);
    const suffixes=['hakunaymatata.com','aoneroom.com','histar.tv','cloudfront.net','aisports.mobi','aisports.cc','moviebox.ph','movieboxhd.net','inmoviebox.com'];
    if(u.protocol!=='https:' || u.username || u.password || (u.port && u.port!=='443') ||
        !suffixes.some(s=>u.hostname===s||u.hostname.endsWith('.'+s))) {
        throw new UpstreamError('Media host is not permitted',400);
    }
    return u;
}
export async function fetchMedia(url,headers,range=null,method='GET',fetcher=globalThis.fetch) {
    let target=safeMediaUrl(url);
    if(range && !/^bytes=\d*-\d*$/.test(range)) throw new UpstreamError('Only a single byte range is supported',416);
    // Redirect destinations are checked too: no arbitrary-URL or localhost proxy.
    for(let i=0;i<5;i++) {
        const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30000);
        let response;
        try {
            response=await fetcher(target,{method,headers:{...headers,...(range?{Range:range}:{})},
                redirect:'manual',signal:controller.signal});
        } finally {clearTimeout(timer);}
        if([301,302,303,307,308].includes(response.status)) {
            const location=response.headers.get('location'); await response.body?.cancel();
            if(!location) throw new UpstreamError('Media redirect has no location');
            const next=safeMediaUrl(new URL(location,target).href);
            if(next.hostname!==target.hostname) headers=Object.fromEntries(Object.entries(headers).filter(([k])=>
                ['user-agent','referer','origin','accept','accept-language'].includes(k.toLowerCase())));
            target=next;continue;
        }
        return response;
    }
    throw new UpstreamError('Too many media redirects');
}
