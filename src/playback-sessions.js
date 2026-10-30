import { UpstreamError } from './moviebox.js';

export const playbackPattern=/^\/api\/v3\/(stream|download)\/([A-Za-z0-9_-]{24})$/;
export async function storedPlayback(request,env) {
    const url=new URL(request.url),match=url.pathname.match(playbackPattern);
    const token=match?.[2];
    if(!token)return null;
    const result=await env.ledger({action:'playback-get',token});
    if(result.status!==200)throw new UpstreamError(result.message,result.status);
    return result.data;
}
