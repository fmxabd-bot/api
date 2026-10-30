import {inputError} from './key-config.js';
import {requestContact} from './key-contact.js';

export function installRequests(sql) {
    sql.exec(`CREATE TABLE IF NOT EXISTS key_requests (
        id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', issued_key TEXT, reviewed_at TEXT, reason TEXT)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS request_windows (
        id TEXT PRIMARY KEY, window INTEGER NOT NULL, count INTEGER NOT NULL)`);
}
export function listRequests(store) {
    return store.rows('SELECT * FROM key_requests ORDER BY created_at DESC').map(row=>({
        ...JSON.parse(row.payload),id:row.id,createdAt:row.created_at,status:row.status,
        issuedKey:row.issued_key,reviewedAt:row.reviewed_at,reason:row.reason}));
}
export function submitRequest(store,input,rateKey) {
    if(!input||typeof input!=='object')throw inputError('A JSON object is required');
    const data={};
    for(const [name,max]of [['name',160],['email',254],['phone',80],['website',500],['useCase',3000]]) {
        const value=input[name]??'';
        if(typeof value!=='string'||value.trim().length>max)throw inputError(`Invalid ${name}`);
        data[name]=value.trim();
    }
    if(!data.name||!data.useCase||(!data.email&&!data.phone))throw inputError('Name, use case and an email address or phone number are required');
    if(data.email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email))throw inputError('Invalid email address');
    if(data.website) {
        try {const u=new URL(/^https?:\/\//i.test(data.website)?data.website:'https://'+data.website);
            if(!['http:','https:'].includes(u.protocol)||u.username||u.password||!u.hostname.includes('.'))throw new Error();
            data.website=u.href;}
        catch{throw inputError('Website must be a valid HTTP or HTTPS URL');}
    }
    const window=Math.floor(Date.now()/3600000),id=String(rateKey||'unknown');
    const rate=store.rows('SELECT * FROM request_windows WHERE id=?',id)[0];
    if(rate?.window===window&&rate.count>=5)return {status:429,code:'REQUEST_RATE_LIMITED',
        message:'Too many key requests. Please try again next hour.',retryAfter:Math.max(1,Math.ceil(((window+1)*3600000-Date.now())/1000))};
    store.sql.exec('DELETE FROM request_windows WHERE window<?',window-48);
    store.sql.exec(`INSERT INTO request_windows(id,window,count) VALUES(?,?,1)
        ON CONFLICT(id) DO UPDATE SET window=excluded.window,count=CASE WHEN window=excluded.window THEN count+1 ELSE 1 END`,id,window);
    const requestId='req_'+crypto.randomUUID().replaceAll('-',''),now=new Date().toISOString();
    store.sql.exec('INSERT INTO key_requests(id,payload,created_at) VALUES(?,?,?)',requestId,JSON.stringify(data),now);
    return {status:201,requestId,whatsappUrl:requestContact(data,requestId),
        message:'Your request has been saved for review. Continue to WhatsApp and send the prepared message to complete your request.'};
}
export function reviewRequest(store,id,decision,input={}) {
    const request=listRequests(store).find(r=>r.id===id);
    if(!request)throw inputError('Request not found',404,'REQUEST_NOT_FOUND');
    if(request.status!=='pending')throw inputError('This request has already been reviewed',409,'REQUEST_ALREADY_REVIEWED');
    const reason=input.reason??'';
    if(typeof reason!=='string'||reason.length>1000)throw inputError('Invalid rejection reason');
    let key;
    if(decision==='approve')key=store.create({owner:request.name,email:request.email,phone:request.phone,
        domain:request.website,...input,approvedFrom:id});
    else if(decision!=='reject')throw inputError('Invalid review operation');
    store.sql.exec('UPDATE key_requests SET status=?,issued_key=?,reviewed_at=?,reason=? WHERE id=?',
        decision==='approve'?'approved':'rejected',key?.key||null,new Date().toISOString(),reason,id);
    return {status:200,...(key?{key}:{}),request:listRequests(store).find(r=>r.id===id)};
}
