export function inputError(message,status=400,code='VALIDATION_ERROR') {
    return Object.assign(new Error(message),{status,code});
}
export function keyName(key) {
    if(typeof key!=='string'||!/^[A-Za-z0-9_-]{4,160}$/.test(key)||
        /^(?:req_|issue_|resolved_issue_|usage:|rl:)/.test(key))
        throw inputError('Key must contain 4–160 letters, digits, underscores or hyphens; system prefixes are reserved');
    return key;
}
export function keyInput(input,old) {
    if(!input||Array.isArray(input)||typeof input!=='object')throw inputError('A JSON object is required');
    if(input.limits!==undefined&&(!input.limits||Array.isArray(input.limits)||typeof input.limits!=='object'||
        Object.keys(input.limits).some(k=>!['daily','monthly','allTime'].includes(k))))
        throw inputError('Limits must be an object with daily, monthly and allTime fields');
    const out={...input,limits:{...old?.limits,...input.limits}};
    for(const [alias,field] of [['dailyLimit','daily'],['monthlyLimit','monthly'],['limit','allTime']]) {
        if(input[alias]!==undefined) {
            const value=input[alias];
            out.limits[field]=value===''?null:typeof value==='string'&&/^\d+$/.test(value)?Number(value):value;
        }
    }
    const metadata={};
    for(const [name,max,fallback] of [['email',254,''],['phone',80,''],['plan',80,'standard'],['note',5000,''],['approvedFrom',100,'']]) {
        const value=input[name]??old?.[name]??fallback;
        if(typeof value!=='string'||value.length>max)throw inputError(`Invalid ${name}`);
        metadata[name]=value.trim();
    }
    if(metadata.email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(metadata.email))throw inputError('Invalid email address');
    out.metadata=metadata;
    if(input.domains===undefined&&input.domain!==undefined) {
        if(typeof input.domain!=='string')throw inputError('Invalid domain');
        const value=input.domain.trim();
        if(!value||value==='*')out.domains=[];
        else {
            let host=value;
            if(/^https?:\/\//i.test(value)) {
                try{const u=new URL(value);if(u.username||u.password)throw new Error();host=u.hostname;}
                catch{throw inputError('Invalid domain URL');}
            }
            out.domains=[host.toLowerCase()];
        }
    }
    if(input.expiresAt==='')out.expiresAt=null;
    if(typeof out.expiresAt==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(out.expiresAt)) {
        const day=out.expiresAt,date=new Date(day+'T23:59:59.999Z');
        if(!Number.isFinite(+date)||date.toISOString().slice(0,10)!==day)throw inputError('Invalid expiry date');
        out.expiresAt=date.toISOString();
    }
    return out;
}
export function publicKey(record) {
    if(!record)return record;
    const {key,email,phone,note,approvedFrom,...safe}=record;
    return safe;
}
export function keyState(record) {
    if(!record)return 'invalid';
    if(!record.enabled)return 'disabled';
    if(record.expiresAt&&Date.parse(record.expiresAt)<=Date.now())return 'expired';
    for(const period of ['allTime','daily','monthly'])
        if(record.limits[period]!==null&&record.usage[period]>=record.limits[period])
            return {allTime:'limit_exceeded',daily:'daily_limit_exceeded',monthly:'monthly_limit_exceeded'}[period];
    return 'ok';
}
export const keyCodes={missing:'API_KEY_MISSING',invalid:'API_KEY_INVALID',disabled:'API_KEY_DISABLED',
    expired:'API_KEY_EXPIRED',limit_exceeded:'API_KEY_LIMIT_EXCEEDED',daily_limit_exceeded:'API_KEY_DAILY_LIMIT_EXCEEDED',
    monthly_limit_exceeded:'API_KEY_MONTHLY_LIMIT_EXCEEDED',store_unavailable:'KEY_STORE_UNAVAILABLE'};
export function extractApiKey(request,{admin=false}={}) {
    const auth=request.headers.get('authorization')||'';
    const match=auth.match(/^(?:Bearer|ApiKey)\s+(.+)$/i);
    if(match)return match[1].trim();
    if(admin)return '';
    for(const h of ['x-api-key','apikey','api-key']) {
        const v=request.headers.get(h)?.trim();if(v)return v;
    }
    const q=new URL(request.url).searchParams;
    return (q.get('apikey')||q.get('api_key')||q.get('key')||'').trim();
}
