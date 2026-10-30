// Shared synchronous SQLite operations. A single Durable Object serializes all
// production mutations; the local adapter uses node:sqlite with identical SQL.
import {inputError,keyName,keyInput,keyCodes} from './key-config.js';
import {installRequests,listRequests,submitRequest,reviewRequest} from './key-requests.js';
import {keyContact} from './key-contact.js';
export class KeyStore {
    constructor(sql) {
        this.sql = sql;
        sql.exec(`CREATE TABLE IF NOT EXISTS api_keys (
            key TEXT PRIMARY KEY, owner TEXT NOT NULL, domains TEXT NOT NULL DEFAULT '[]',
            enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, expires_at TEXT,
            daily_limit INTEGER, monthly_limit INTEGER, lifetime_limit INTEGER,
            day TEXT NOT NULL, month TEXT NOT NULL, daily INTEGER NOT NULL DEFAULT 0,
            monthly INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0, last_used TEXT)`);
        sql.exec(`CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT NOT NULL)`);
        try {sql.exec('SELECT metadata FROM api_keys LIMIT 0');}
        catch(e) {
            if(!/no such column/i.test(e.message))throw e;
            sql.exec("ALTER TABLE api_keys ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}'");
        }
        installRequests(sql);
        sql.exec(`CREATE TABLE IF NOT EXISTS playback_sessions (
            token TEXT PRIMARY KEY, key TEXT NOT NULL, payload TEXT NOT NULL, expires INTEGER NOT NULL)`);
        sql.exec('CREATE INDEX IF NOT EXISTS playback_expiry ON playback_sessions(expires)');
        this.nextPlaybackCleanup=0;
        // Only seed once: deleting the free key must not silently recreate it.
        if (!this.rows("SELECT value FROM settings WHERE name='seeded'").length) {
            this.create({ key: 'daratechapi', owner: 'Public documentation key',plan:'free',
                limits: { daily: 50, monthly: 1000, allTime: null } });
            sql.exec("INSERT INTO settings(name,value) VALUES('seeded','1')");
        }
    }
    rows(query, ...args) { return [...this.sql.exec(query, ...args)]; }
    record(row, now = new Date()) {
        if (!row) return null;
        const day = now.toISOString().slice(0, 10), month = day.slice(0, 7);
        const usage = { daily: row.day === day ? row.daily : 0,
            monthly: row.month === month ? row.monthly : 0, allTime: row.total, lastUsed: row.last_used };
        const limits = { daily: row.daily_limit, monthly: row.monthly_limit, allTime: row.lifetime_limit };
        const remaining = Object.fromEntries(Object.entries(limits).map(([k,v]) => [k,v === null ? null : Math.max(0,v-usage[k])]));
        const domains=JSON.parse(row.domains);
        return { email:'',phone:'',note:'',plan:row.key==='daratechapi'?'free':'standard',
            ...JSON.parse(row.metadata||'{}'),key: row.key, owner: row.owner, domains, domain:domains.join(', '),enabled: !!row.enabled,
            requests:usage.allTime,limit:limits.allTime,dailyLimit:limits.daily,monthlyLimit:limits.monthly,lastUsed:usage.lastUsed,
            createdAt: row.created_at, expiresAt: row.expires_at, limits, usage, remaining };
    }
    get(key) { return this.record(this.rows('SELECT * FROM api_keys WHERE key=?', key)[0]); }
    list() { return this.rows('SELECT * FROM api_keys ORDER BY created_at DESC').map(r => this.record(r)); }
    validate(input, previous) {
        input=keyInput(input,previous);
        const record = { owner: previous?.owner || 'API client', domains: previous?.domains || [],
            enabled: previous?.enabled ?? true, expiresAt: previous?.expiresAt ?? null,
            ...input, limits: { daily: null, monthly: null, allTime: null, ...previous?.limits, ...input.limits } };
        if (typeof record.owner !== 'string' || !record.owner.trim() || record.owner.length > 160) throw inputError('Owner must be 1–160 characters');
        if (!Array.isArray(record.domains) || record.domains.some(d => typeof d !== 'string' || !/^(?:\*\.)?[a-z0-9.-]+$/i.test(d))) throw inputError('Domains must be hostnames, without https:// or paths');
        if (typeof record.enabled !== 'boolean') throw inputError('Enabled must be true or false');
        if (record.expiresAt !== null && !Number.isFinite(Date.parse(record.expiresAt))) throw inputError('Invalid expiry date');
        for (const value of Object.values(record.limits)) {
            if (value !== null && (!Number.isSafeInteger(value) || value < 0)) throw inputError('Limits must be nonnegative whole numbers or null (unlimited)');
        }
        return record;
    }
    create(input) {
        const requested=typeof input.key==='string'?input.key.trim():input.key;
        const key = requested===undefined||requested===''?`runflix_${crypto.randomUUID().replaceAll('-', '')}`:requested;
        keyName(key);
        if (this.get(key)) throw inputError('API key already exists',409,'KEY_EXISTS');
        const r = this.validate(input), now = new Date().toISOString();
        this.sql.exec(`INSERT INTO api_keys(key,owner,domains,enabled,created_at,expires_at,daily_limit,monthly_limit,lifetime_limit,day,month)
            VALUES(?,?,?,?,?,?,?,?,?,?,?)`, key,r.owner.trim(),JSON.stringify(r.domains),+r.enabled,now,r.expiresAt,r.limits.daily,r.limits.monthly,r.limits.allTime,now.slice(0,10),now.slice(0,7));
        this.sql.exec('UPDATE api_keys SET metadata=? WHERE key=?',JSON.stringify(r.metadata),key);
        return this.get(key);
    }
    update(key, input) {
        const old = this.get(key);
        if (!old) return null;
        const r = this.validate(input, old);
        const next=input.newKey===undefined?key:keyName(input.newKey);
        if(next!==key&&this.get(next))throw inputError('Replacement API key already exists',409,'KEY_EXISTS');
        this.sql.exec(`UPDATE api_keys SET owner=?,domains=?,enabled=?,expires_at=?,daily_limit=?,monthly_limit=?,lifetime_limit=? WHERE key=?`,
            r.owner.trim(),JSON.stringify(r.domains),+r.enabled,r.expiresAt,r.limits.daily,r.limits.monthly,r.limits.allTime,key);
        this.sql.exec('UPDATE api_keys SET metadata=? WHERE key=?',JSON.stringify(r.metadata),key);
        if(next!==key) {
            this.sql.exec('DELETE FROM playback_sessions WHERE key=?',key);
            this.sql.exec('UPDATE api_keys SET key=? WHERE key=?',next,key);
            this.sql.exec('UPDATE key_requests SET issued_key=? WHERE issued_key=?',next,key);
        }
        return this.get(next);
    }
    delete(key) {
        const exists = !!this.get(key);
        this.sql.exec('DELETE FROM playback_sessions WHERE key=?',key);
        this.sql.exec('DELETE FROM api_keys WHERE key=?', key);
        return exists;
    }
    check(key, origin = null, consume = false, now = new Date()) {
        if(typeof key!=='string'||key.length>160)return {status:401,valid:false,code:keyCodes.invalid,message:'Invalid API key'};
        const raw = this.rows('SELECT * FROM api_keys WHERE key=?',key)[0], record = this.record(raw,now);
        if (!record) return { status:401,valid:false,code:key?keyCodes.invalid:keyCodes.missing,message:key?'Invalid or revoked API key':'No API key provided',
            ...keyContact(key,'invalid or revoked access') };
        if (!record.enabled) return { status:403,valid:false,code:keyCodes.disabled,message:'API key is disabled',...keyContact(key,'disabled access') };
        if (record.expiresAt && Date.parse(record.expiresAt) <= +now) return { status:401,valid:false,code:keyCodes.expired,message:'API key has expired',...keyContact(key,'renewal') };
        if (origin && record.domains.length) {
            let host; try { host = new URL(origin).hostname; } catch { return {status:403,valid:false,message:'Invalid origin'}; }
            if (!record.domains.some(d => d.startsWith('*.') ? host.endsWith(d.slice(1)) : host === d)) return { status:403,valid:false,code:'API_KEY_ORIGIN_FORBIDDEN',message:'Origin not allowed for this API key' };
        }
        // A checker is read-only; an exhausted key remains valid, but requests fail.
        if (!consume) return {status:200,valid:true,key:record};
        for (const period of ['allTime','daily','monthly']) {
            if (record.limits[period] !== null && record.usage[period] >= record.limits[period]) {
                const reset = period === 'daily' ? new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()+1)) :
                    period === 'monthly' ? new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()+1,1)) : null;
                return {status:429,valid:true,code:{allTime:keyCodes.limit_exceeded,daily:keyCodes.daily_limit_exceeded,monthly:keyCodes.monthly_limit_exceeded}[period],
                    message:`${period} request limit reached`,...keyContact(key,period+' limit increase'),period,key:record,
                    retryAfter:reset ? Math.max(1,Math.ceil((+reset-+now)/1000)) : null};
            }
        }
        // No awaits between checking and incrementing: exact quotas across concurrent requests.
        const iso = now.toISOString();
        this.sql.exec(`UPDATE api_keys SET daily=?,monthly=?,total=total+1,day=?,month=?,last_used=? WHERE key=?`,
            record.usage.daily+1,record.usage.monthly+1,iso.slice(0,10),iso.slice(0,7),iso,key);
        return {status:200,valid:true,key:this.record(this.rows('SELECT * FROM api_keys WHERE key=?',key)[0],now)};
    }
    savePlayback(key,entries,now=Date.now()) {
        const checked=this.check(key);
        if(checked.status!==200)return checked;
        if(!Array.isArray(entries)||!entries.length||entries.length>40)throw inputError('Invalid playback session batch');
        for(const entry of entries) {
            if(!/^[A-Za-z0-9_-]{24}$/.test(entry.token)||!Number.isSafeInteger(entry.expires)||
                entry.expires<=now||entry.expires>now+6*60*60*1000||
                !entry.data||JSON.stringify(entry.data).length>32000)throw inputError('Invalid playback session');
        }
        if(now>=this.nextPlaybackCleanup) {
            this.sql.exec('DELETE FROM playback_sessions WHERE expires<=?',now);
            this.nextPlaybackCleanup=now+10*60*1000;
        }
        for(const entry of entries)this.sql.exec(
            'INSERT INTO playback_sessions(token,key,payload,expires) VALUES(?,?,?,?)',
            entry.token,key,JSON.stringify(entry.data),entry.expires);
        return {status:200};
    }
    playback(token,now=Date.now()) {
        if(!/^[A-Za-z0-9_-]{24}$/.test(token||''))return {status:401,message:'Invalid playback link'};
        const row=this.rows('SELECT * FROM playback_sessions WHERE token=?',token)[0];
        if(!row||row.expires<=now)return {status:401,message:'Playback link expired; request fresh sources'};
        return {status:200,data:{...JSON.parse(row.payload),key:row.key,exp:row.expires}};
    }
    dispatch({ action, key, input, origin, token,rateKey,id }) {
        if(action==='request-submit')return submitRequest(this,input,rateKey);
        if(action==='request-list')return {status:200,requests:listRequests(this)};
        if(action==='request-approve'||action==='request-reject')return reviewRequest(this,id,action.split('-')[1],input);
        if(action==='request-delete') {
            if(!this.rows('SELECT id FROM key_requests WHERE id=?',id).length)return {status:404,message:'Request not found',code:'REQUEST_NOT_FOUND'};
            this.sql.exec('DELETE FROM key_requests WHERE id=?',id);return {status:200};
        }
        if (action === 'playback-save') return this.savePlayback(key,input?.entries);
        if (action === 'playback-get') return this.playback(token);
        if (action === 'list') return {status:200,keys:this.list()};
        if (action === 'create') return {status:201,key:this.create(input || {})};
        if (action === 'update') { const r=this.update(key,input||{}); return r ? {status:200,key:r} : {status:404,message:'API key not found'}; }
        if (action === 'delete') return this.delete(key) ? {status:200} : {status:404,message:'API key not found'};
        if (action === 'check' || action === 'consume') return this.check(key || '',origin,action === 'consume');
        return {status:400,message:'Unknown key action'};
    }
}
