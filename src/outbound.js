// Node origins only. Never import this transport into the Cloudflare Worker.
import { ProxyAgent, fetch as proxyFetch } from 'undici';

export function createOutboundFetch(proxyUrl=process.env.MOVIEBOX_PROXY_URL) {
    if(!proxyUrl) return globalThis.fetch.bind(globalThis);
    let url;
    try {
        url=new URL(proxyUrl);
        if(!['http:','https:'].includes(url.protocol) || url.hash || url.search ||
            (url.pathname && url.pathname!=='/')) throw new Error();
    } catch {
        throw new Error('MOVIEBOX_PROXY_URL must be an HTTP(S) proxy URL');
    }
    let dispatcher;
    try {dispatcher=new ProxyAgent(url);}
    catch {throw new Error('MOVIEBOX_PROXY_URL contains invalid proxy settings');}
    // Deliberately do not fall back to direct requests: tokens/media URLs may
    // be IP-bound, and silently changing egress would invalidate the session.
    const outbound=async(input,init={})=>{
        try {return await proxyFetch(input,{...init,dispatcher});}
        catch {
            if(init.signal?.aborted) throw init.signal.reason;
            throw new Error('MovieBox outbound proxy connection failed');
        }
    };
    outbound.close=()=>dispatcher.close();
    return outbound;
}
