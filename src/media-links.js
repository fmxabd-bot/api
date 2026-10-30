const clean=(value,fallback,max=120)=>String(value||fallback)
    .replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g,'').replace(/\s+/g,' ').trim().slice(0,max)||fallback;

export function mediaFormat(source) {
    const format=String(source.format||'').toLowerCase();
    if(format==='dash'||/\.mpd(?:\?|$)/i.test(source.url||''))return 'dash';
    if(format==='hls'||/\.m3u8(?:\?|$)/i.test(source.url||''))return 'hls';
    return format||'mp4';
}
export function resolution(source) {
    return Number(source.resolution ?? source.qualityValue) || parseInt(source.quality)||0;
}
export function downloadFilename(title,season,episode,quality,format='mp4') {
    const coordinates=Number(season)>0&&Number(episode)>0?` S${Number(season)}E${Number(episode)}`:'';
    const ext={dash:'mpd',hls:'m3u8',webm:'webm',ts:'ts'}[format]||'mp4';
    return `${clean(title,'Video')}${coordinates} ${clean(quality,'Adaptive',32)} DaraTech-Movieapi.${ext}`;
}
export function attachmentHeader(filename) {
    const safe=String(filename).replace(/[\r\n]/g,'').replace(/["\\]/g,'_');
    const ascii=safe.replace(/[^\x20-\x7e]/g,'_');
    const utf8=encodeURIComponent(safe).replace(/['()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
    return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}
export function playbackLinks(origin,token) {
    return {streamUrl:`${origin}/api/v3/stream/${token}`,downloadUrl:`${origin}/api/v3/download/${token}`};
}
