import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import nodemailer from "nodemailer";
import { fetch as undiciFetch, ProxyAgent } from "undici";
import crypto from "crypto";
import axios from "axios";
import * as cheerio from "cheerio";
import { installModern } from './src/local-modern.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3400;

// ─── SMTP email helper ──────────────────────────────────────────────────────────
const smtpTransport = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'mail.runflix.name.ng',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: {
        user: process.env.SMTP_USER || 'support@runflix.name.ng',
        pass: process.env.SMTP_PASS || ''
    },
    tls: { rejectUnauthorized: false }
});

async function sendRequestEmail({ name, email, website, useCase }) {
    try {
        await smtpTransport.sendMail({
            from: '"RUNFLIX API" <support@runflix.name.ng>',
            to: 'adtelecom.info@gmail.com',
            subject: `New API Key Request — ${name}`,
            text: [
                `New API key request received:`,
                ``,
                `Name:     ${name}`,
                `Email:    ${email || '—'}`,
                `Website:  ${website || '—'}`,
                `Use Case: ${useCase}`,
                ``,
                `Review and issue the key at your admin panel.`
            ].join('\n')
        });
        return true;
    } catch (e) {
        console.error('[email] Send failed:', e.message);
        return false;
    }
}

// ─── CORS — allow any origin so your website can call this directly ─────────────
app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Range");
    res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
});

app.use(express.json());
installModern(app);

// ─── Request logger ────────────────────────────────────────────────────────────
app.use((req, res, next) => {
    if (!req.path.startsWith("/api/")) return next();
    const start = Date.now();
    res.on("finish", () => {
        requestLog.unshift({
            ts: new Date().toISOString(),
            method: req.method,
            path: req.originalUrl,
            status: res.statusCode,
            ms: Date.now() - start
        });
        if (requestLog.length > MAX_REQUEST_LOGS) requestLog.pop();
    });
    next();
});

// ─── Mirror hosts ──────────────────────────────────────────────────────────────
// themoviebox.org removed — it serves a frontend SPA, not JSON API responses
const MIRROR_HOSTS = [
    "h5-api.aoneroom.com",
    "fmoviesunblocked.net",
    "netnaija.film",
    "filmboom.top"
];

// Pick a random mirror for each request rather than locking one at startup
function getNextMirror() {
    return MIRROR_HOSTS[Math.floor(Math.random() * MIRROR_HOSTS.length)];
}

// Keep a single "selected host" reference for log/debug messages only
const SELECTED_HOST = getNextMirror();
const HOST_URL = `https://${SELECTED_HOST}`;

// ─── IP rotation pool ──────────────────────────────────────────────────────────
// These are well-known public DNS / resolver IPs used to vary X-Forwarded-For.
// The upstream API checks this header for geo/rate decisions.
const IP_POOL = [
    "1.1.1.1",        "1.0.0.1",
    "8.8.8.8",        "8.8.4.4",
    "9.9.9.9",        "149.112.112.112",
    "208.67.222.222", "208.67.220.220",
    "185.228.168.9",  "185.228.169.9",
    "176.103.130.130","176.103.130.131",
    "94.140.14.14",   "94.140.15.15",
    "77.88.8.1",      "77.88.8.8",
    "195.46.39.39",   "195.46.39.40",
    "216.146.35.35",  "216.146.36.36",
    "45.90.28.0",     "45.90.30.0"
];

function getRandomIp() {
    return IP_POOL[Math.floor(Math.random() * IP_POOL.length)];
}

// ─── Proxy rotator ─────────────────────────────────────────────────────────────
// Set PROXY_LIST env var to a comma-separated list of HTTP/HTTPS proxy URLs.
// Example: PROXY_LIST=http://user:pass@proxy1.example.com:3128,http://proxy2:8080
// Proxies are cycled round-robin; if a request through a proxy fails, it is
// retried directly (or with the next proxy) by tryMirrors' fallback loop.
class ProxyRotator {
    constructor(rawList) {
        this.proxies = rawList.map(s => s.trim()).filter(Boolean);
        this.index = 0;
    }

    // Returns the next proxy URL (or null when the pool is empty)
    next() {
        if (!this.proxies.length) return null;
        const proxy = this.proxies[this.index];
        this.index = (this.index + 1) % this.proxies.length;
        return proxy;
    }

    get size() { return this.proxies.length; }
}

const PROXY_LIST_RAW = (process.env.PROXY_LIST || "").split(",").filter(Boolean);
const proxyRotator = new ProxyRotator(PROXY_LIST_RAW);

if (proxyRotator.size > 0) {
    console.log(`[proxy] IP rotation enabled — ${proxyRotator.size} proxy/proxies loaded`);
} else {
    console.log("[proxy] No PROXY_LIST set — using direct connection with X-Forwarded-For rotation");
}

// Build a fetch dispatcher for a proxy URL (undici ProxyAgent).
// Returns null for direct connections or unrecognised schemes.
function buildDispatcher(proxyUrl) {
    if (!proxyUrl) return null;
    try {
        return new ProxyAgent(proxyUrl);
    } catch (e) {
        console.warn(`[proxy] Failed to build agent for ${proxyUrl}: ${e.message}`);
        return null;
    }
}

// Wrapper: tries the next proxy first, falls back to direct on failure
async function fetchWithRotation(url, options = {}) {
    const proxyUrl = proxyRotator.next();
    const dispatcher = buildDispatcher(proxyUrl);

    if (dispatcher) {
        try {
            return await undiciFetch(url, { ...options, dispatcher });
        } catch (e) {
            console.warn(`[proxy] ${proxyUrl} failed (${e.message}), retrying direct`);
        }
    }

    // Direct connection (or proxy fallback)
    return fetch(url, options);
}

// ─── CF Worker relay (bypasses geo-blocks for search + sources) ────────────────
// Set CF_WORKER_URL=https://your-worker.workers.dev to enable relay mode.
// When set, geo-blocked endpoints route through the CF Worker's edge IPs instead
// of hitting the upstream API directly from this server.
const CF_WORKER_URL = (process.env.CF_WORKER_URL || "").replace(/\/$/, "");
// API key used when calling the CF Worker relay (must exist in its KV store)
const CF_WORKER_API_KEY = process.env.CF_WORKER_API_KEY || "runflix_relay_dev_key_2025";
if (CF_WORKER_URL) {
    console.log(`[relay] CF Worker relay enabled → ${CF_WORKER_URL}`);
} else {
    console.log("[relay] CF Worker relay disabled — set CF_WORKER_URL to enable");
}

// Base headers — X-Forwarded-For and Host are overridden per-request
const DEFAULT_HEADERS = {
    "X-Client-Info": '{"timezone":"Africa/Nairobi"}',
    "Accept-Language": "en-US,en;q=0.5",
    "Accept": "application/json",
    "User-Agent": "okhttp/4.12.0",
    "Connection": "keep-alive"
};

const SubjectType = { ALL: 0, MOVIES: 1, TV_SERIES: 2, MUSIC: 6 };

// ─── Platform / section filter map ────────────────────────────────────────────
// Section-based: maps to homepage section title keywords (most accurate — real curator data)
// Streaming-based: maps to keyword search (best-effort — upstream has no platform tags)
const PLATFORM_MAP = {
    // Streaming services → keyword search
    netflix:    { label: "Netflix",       mode: "search", keyword: "Netflix" },
    prime:      { label: "Amazon Prime",  mode: "search", keyword: "Amazon Prime" },
    apple:      { label: "Apple TV+",     mode: "search", keyword: "Apple TV" },
    disney:     { label: "Disney+",       mode: "search", keyword: "Disney" },
    hbo:        { label: "HBO Max",       mode: "search", keyword: "HBO" },
    hulu:       { label: "Hulu",          mode: "search", keyword: "Hulu" },
    paramount:  { label: "Paramount+",   mode: "search", keyword: "Paramount" },
    peacock:    { label: "Peacock",       mode: "search", keyword: "Peacock" },
    // Regional/cultural sections → homepage section match (accurate)
    bollywood:  { label: "Bollywood",    mode: "section", keyword: "bollywood" },
    south:      { label: "South Indian", mode: "section", keyword: "south indian" },
    hollywood:  { label: "Hollywood",    mode: "section", keyword: "hollywood" },
    asian:      { label: "Asian",        mode: "section", keyword: "asian" },
    anime:      { label: "Anime",        mode: "search",  keyword: "Anime" },
    kdrama:     { label: "K-Drama",      mode: "search",  keyword: "Korean drama" },
    trending:   { label: "Trending",     mode: "section", keyword: "trending" },
    cinema:     { label: "Cinema",       mode: "section", keyword: "cinema" },
};

// ─── Jikan (MAL) — replaces AniList (no IP blocks, no auth, CF Worker compatible) ─
const JIKAN_DAY_MAP = {
    mondays: 1, tuesdays: 2, wednesdays: 3, thursdays: 4,
    fridays: 5, saturdays: 6, sundays: 0
};

async function fetchJikanSchedule(page = 1) {
    const res = await fetch(`https://api.jikan.moe/v4/schedules?page=${page}`, {
        headers: { "Accept": "application/json" }
    });
    if (!res.ok) throw new Error(`Jikan HTTP ${res.status}`);
    return await res.json();
}

function normaliseJikanItem(item, date) {
    return {
        id:            String(item.mal_id),
        title:         item.title_english || item.title,
        titleNative:   item.title_japanese || null,
        thumbnail:     item.images?.jpg?.large_image_url || item.images?.jpg?.image_url || null,
        genres:        (item.genres || []).map(g => g.name),
        rating:        item.score ? +(item.score).toFixed(1) : null,
        status:        item.status,
        format:        item.type || null,
        totalEpisodes: item.episodes || null,
        season:        item.season,
        year:          item.year,
        description:   (item.synopsis || "").slice(0, 300),
        url:           item.url,
        broadcastDay:  item.broadcast?.day || null,
        broadcastTime: item.broadcast?.time || null,
        airingDate:    date || null,
        source:        "jikan"
    };
}

// ─── Request log buffer ────────────────────────────────────────────────────────
const MAX_REQUEST_LOGS = 200;
const requestLog = [];

// ─── Cookie cache ──────────────────────────────────────────────────────────────
let cookieCache = null;
let cookieCacheTime = 0;
const COOKIE_CACHE_DURATION = 3600000;

async function getCookies() {
    const now = Date.now();
    if (cookieCache && (now - cookieCacheTime) < COOKIE_CACHE_DURATION) return cookieCache;
    for (const host of MIRROR_HOSTS) {
        try {
            const headers = {
                ...DEFAULT_HEADERS,
                Host: host,
                Referer: `https://${host}`,
                "X-Forwarded-For": getRandomIp(),
                "X-Real-IP": getRandomIp()
            };
            const res = await fetchWithRotation(
                `https://${host}/wefeed-h5-bff/app/get-latest-app-pkgs?app_name=moviebox`,
                { headers }
            );
            const setCookieHeader = res.headers.get("set-cookie");
            if (setCookieHeader) {
                cookieCache = setCookieHeader.split(";")[0].trim();
                cookieCacheTime = now;
                return cookieCache;
            }
        } catch {}
    }
    return cookieCache;
}

async function makeApiRequest(url, options = {}) {
    const cookies = await getCookies();
    // Derive Host from URL so the header always matches the actual target
    const targetHost = new URL(url).hostname;
    const rotatedIp = getRandomIp();
    const headers = {
        ...DEFAULT_HEADERS,
        Host: targetHost,
        Referer: `https://${targetHost}`,
        "X-Forwarded-For": rotatedIp,
        "X-Real-IP": rotatedIp,
        ...(options.headers || {})
    };
    if (cookies) headers["Cookie"] = cookies;
    return fetchWithRotation(url, { ...options, headers });
}

// Try each mirror host in a shuffled order until one returns valid JSON
async function tryMirrors(path, validator, options = {}) {
    const cookies = await getCookies();
    // Shuffle mirrors so retries don't always hit the same first host
    const shuffled = [...MIRROR_HOSTS].sort(() => Math.random() - 0.5);
    for (const host of shuffled) {
        try {
            const rotatedIp = getRandomIp();
            const headers = {
                ...DEFAULT_HEADERS,
                Host: host,
                Referer: `https://${host}`,
                "X-Forwarded-For": rotatedIp,
                "X-Real-IP": rotatedIp,
                ...(options.headers || {})
            };
            if (cookies) headers["Cookie"] = cookies;
            const r = await fetchWithRotation(`https://${host}${path}`, { ...options, headers });
            const text = await r.text();
            if (!text.trim().startsWith("{")) continue;
            const data = JSON.parse(text);
            const content = processApiResponse(data);
            if (validator(content)) return { content, host };
        } catch {}
    }
    return null;
}

// ─── V3 API — signed requests (api6.aoneroom.com) ──────────────────────────────
// Implements moviebox-api v3 request signing to bypass geo-block and empty search index.
// Reference: moviebox-api-0.5.4 (crypto.py, constants.py, urls.py)

const V3_SECRET     = Buffer.from("76iRl07s0xSN9jqmEWAt79EBJZulIQIsV64FZr2O", "base64");
const V3_SECRET_ALT = Buffer.from("Xqn2nnO41/L92o1iuXhSLHTbXvY4Z5ZZ62m8mSLA", "base64");
const V3_SIG_BODY_MAX = 102400;
const V3_RETRY_CODES = new Set([403, 407, 429, 500, 502, 503, 504]);

const V3_HOST_POOL = [
    "https://api6.aoneroom.com",
    "https://api5.aoneroom.com",
    "https://api4.aoneroom.com",
    "https://api4sg.aoneroom.com",
    "https://api3.aoneroom.com",
    "https://api6sg.aoneroom.com",
    "https://api.inmoviebox.com",
];

// Random Android device fingerprint for X-Client-Info header diversity
function makeV3Identity() {
    const osVers = ["9","10","11","12","13"];
    const models = ["23078RKD5C","2201117TY","22101316G","21121210G","M2012K11AG","M2007J20CG"];
    const vcs    = [50020042,50020043,50020044,50020045,50020046];
    const tzs    = ["Asia/Kolkata","Asia/Shanghai","Asia/Tokyo","America/New_York","Europe/London"];
    const nets   = ["NETWORK_WIFI","NETWORK_MOBILE"];
    const os     = osVers [Math.floor(Math.random() * osVers.length)];
    const model  = models [Math.floor(Math.random() * models.length)];
    const vc     = vcs    [Math.floor(Math.random() * vcs.length)];
    const tz     = tzs    [Math.floor(Math.random() * tzs.length)];
    const net    = nets   [Math.floor(Math.random() * nets.length)];
    const deviceId = crypto.randomBytes(16).toString("hex");
    const gaid     = crypto.randomUUID();
    const ua = `com.community.oneroom/${vc} (Linux; U; Android ${os}; en_US; ${model}; Build/RP1A.200720.011; Cronet/135.0.7012.3)`;
    const ci = JSON.stringify({
        package_name:"com.community.oneroom",version_name:"3.0.03.0529.03",
        version_code:vc,os:"android",os_version:os,install_ch:"ps",
        device_id:deviceId,install_store:"ps",gaid,brand:"Redmi",model,
        system_language:"en",net,region:"US",timezone:tz,sp_code:"40401","X-Play-Mode":"2"
    });
    return { ua, ci };
}
const { ua: V3_UA, ci: V3_CI } = makeV3Identity();
let v3RuntimeToken = null;
let _v3InitPromise  = null;

// ─── CF KV token relay ─────────────────────────────────────────────────────────
// The local server (Replit IPs) can bootstrap the v3 token from tab-operating.
// CF Worker IPs may be geo-restricted from that endpoint, so after bootstrapping
// we push the token to CF KV so the worker can read it on cold start.
const CF_ACCOUNT_ID  = "8979e94775109424eb5e1b66c665e561";
const CF_KV_NS       = "1a518d50e5c241ae8e5d16974d3fb24c";
const CF_KV_IDENTITY_KEY = "v3_identity";
let _lastPushedToken = null;

// Push { token, ua, ci } to CF KV so the CF Worker uses the exact same device
// identity that this server used during bootstrap (upstream binds token to identity).
async function pushTokenToCfKv(token) {
    if (!token || token === _lastPushedToken) return;
    const cfApiToken = process.env.CLOUDFLARE_API_TOKEN;
    if (!cfApiToken) return;
    try {
        const identity = JSON.stringify({ token, ua: V3_UA, ci: V3_CI });
        const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_KV_NS}/values/${CF_KV_IDENTITY_KEY}`;
        const res = await fetch(url, {
            method: "PUT",
            headers: { "Authorization": `Bearer ${cfApiToken}`, "Content-Type": "application/json" },
            body: identity,
        });
        if (res.ok) { _lastPushedToken = token; console.log("[v3] Identity pushed to CF KV (token + ua + ci)"); }
        else         { console.warn("[v3] CF KV push failed:", res.status, await res.text()); }
    } catch (e) { console.warn("[v3] CF KV push error:", e.message); }
}

// ─── Token bootstrap ───────────────────────────────────────────────────────────
// The upstream API now requires a Bearer token (from x-user response header) on
// all endpoints except the homepage. Fetch it once per process start, then reuse.
async function v3EnsureToken() {
    if (v3RuntimeToken) return;
    if (!_v3InitPromise) {
        _v3InitPromise = (async () => {
            for (const base of V3_HOST_POOL) {
                const url = `${base}/wefeed-mobile-bff/tab-operating?page=1&tabId=0&version=`;
                try {
                    const ts     = Date.now();
                    const accept = "application/json";
                    const ct     = "application/json";
                    const h = {
                        "User-Agent":     V3_UA,
                        "Accept":         accept,
                        "Content-Type":   ct,
                        "Connection":     "keep-alive",
                        "X-Client-Token": v3ClientToken(ts),
                        "x-tr-signature": v3Sig("GET", accept, ct, url, null, ts),
                        "X-Client-Info":  V3_CI,
                        "X-Client-Status":"0",
                    };
                    const res   = await fetch(url, { method: "GET", headers: h });
                    const xUser = res.headers.get("x-user");
                    if (xUser) {
                        try { const p = JSON.parse(xUser); if (p.token) { v3RuntimeToken = p.token; } } catch {}
                    }
                    if (v3RuntimeToken) break;
                } catch {}
            }
            // Push freshly bootstrapped token to CF KV so the worker doesn't need
            // to call tab-operating from CF IPs (which may be geo-restricted).
            pushTokenToCfKv(v3RuntimeToken).catch(() => {});
        })();
    }
    await _v3InitPromise;
}

function v3Md5(data)       { return crypto.createHash("md5").update(data).digest("hex"); }
function v3ClientToken(ts) { return `${ts},${v3Md5(String(ts).split("").reverse().join(""))}`; }

function v3SortedQS(url) {
    const u = new URL(url);
    return [...u.searchParams.entries()]
        .sort((a,b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
        .map(([k,v]) => `${k}=${v}`).join("&");
}

function v3Canonical(method, accept, ct, url, body, ts) {
    const u  = new URL(url);
    const qs = v3SortedQS(url);
    const cu = qs ? `${u.pathname}?${qs}` : u.pathname;
    let bh = "", bl = "";
    if (body != null) {
        const buf = Buffer.from(body, "utf8");
        bh = v3Md5(buf.subarray(0, V3_SIG_BODY_MAX));
        bl = String(buf.length);
    }
    return [method.toUpperCase(), accept||"", ct||"", bl, String(ts), bh, cu].join("\n");
}

function v3Sig(method, accept, ct, url, body, ts, useAltKey = false) {
    const key = useAltKey ? V3_SECRET_ALT : V3_SECRET;
    const mac = crypto.createHmac("md5", key)
        .update(v3Canonical(method, accept, ct, url, body, ts), "utf8").digest("base64");
    return `${ts}|2|${mac}`;
}

function v3Headers(method, url, accept = "application/json", ct = "application/json", body = null, useAltKey = false) {
    const ts = Date.now();
    const h = {
        "User-Agent":     V3_UA,
        "Accept":         accept,
        "Content-Type":   ct,
        "Connection":     "keep-alive",
        "X-Client-Token": v3ClientToken(ts),
        "x-tr-signature": v3Sig(method, accept, ct, url, body, ts, useAltKey),
        "X-Client-Info":  V3_CI,
        "X-Client-Status":"0",
    };
    if (v3RuntimeToken) h["Authorization"] = `Bearer ${v3RuntimeToken}`;
    return h;
}

async function v3Fetch(method, pathAndQuery, bodyStr = null) {
    await v3EnsureToken();
    const accept = "application/json";
    const ct     = bodyStr ? "application/json; charset=utf-8" : "application/json";
    for (const base of V3_HOST_POOL) {
        const url = `${base}${pathAndQuery}`;
        try {
            let res = await fetch(url, { method, headers: v3Headers(method, url, accept, ct, bodyStr), body: bodyStr });
            const xUser = res.headers.get("x-user");
            if (xUser) {
                try {
                    const p = JSON.parse(xUser);
                    if (p.token) { v3RuntimeToken = p.token; pushTokenToCfKv(v3RuntimeToken).catch(() => {}); }
                } catch {}
            }

            // JWT expired → clear token, re-bootstrap, retry this host once
            if (res.status === 401) {
                v3RuntimeToken = null; _v3InitPromise = null;
                await v3EnsureToken();
                res = await fetch(url, { method, headers: v3Headers(method, url, accept, ct, bodyStr), body: bodyStr });
                // Signing rejected even with fresh token → try ALT secret key
                if (res.status === 401 || res.status === 403) {
                    res = await fetch(url, { method, headers: v3Headers(method, url, accept, ct, bodyStr, true), body: bodyStr });
                }
            }

            if (!V3_RETRY_CODES.has(res.status)) return res;
        } catch {}
    }
    throw new Error("All v3 hosts exhausted");
}

async function v3Get(path, params = {}) {
    const qs         = new URLSearchParams(params);
    const pathWithQs = Object.keys(params).length ? `${path}?${qs}` : path;
    const res        = await v3Fetch("GET", pathWithQs);
    const data       = await res.json();
    if (data.code !== undefined && data.code !== 0 && data.code !== 200)
        throw new Error(`v3 API error ${data.code}: ${data.msg || ""}`);
    return data.data;
}

async function v3Post(path, body) {
    const bodyStr = JSON.stringify(body);
    const res     = await v3Fetch("POST", path, bodyStr);
    const data    = await res.json();
    if (data.code !== undefined && data.code !== 0 && data.code !== 200)
        throw new Error(`v3 API error ${data.code}: ${data.msg || ""}`);
    return data.data;
}

function processApiResponse(data) {
    return data?.data || data;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────
function ok(res, results, extra = {}) {
    res.json({ status: 200, success: true, creator: "DaraTech", results, ...extra });
}

function err(res, message, status = 500) {
    res.status(status).json({ status, success: false, creator: "DaraTech", message });
}

function serveFile(filename, res) {
    const filePath = path.join(__dirname, filename);
    if (!fs.existsSync(filePath)) return err(res, `File not found: ${filename}`, 404);
    const ext = path.extname(filename);
    const contentType = ext === ".html" ? "text/html" : "application/json";
    res.setHeader("Content-Type", contentType);
    res.send(fs.readFileSync(filePath));
}

// Returns true for codecs that browsers can decode natively (H.264/AVC).
// HEVC/H.265 MP4 is not supported by Chrome or Firefox — video track is silently
// skipped while audio (AAC) still plays, giving the appearance of audio-only.
function isBrowserCompatibleCodec(codecName) {
    if (!codecName) return true;
    const c = codecName.toLowerCase();
    if (c.includes("hevc") || c.includes("h265") || c === "hvc1" || c === "hev1") return false;
    return true;
}

function normaliseItem(item) {
    const out = { ...item };
    if (item.cover?.url) out.thumbnail = item.cover.url;
    else if (item.stills?.url && !item.thumbnail) out.thumbnail = item.stills.url;
    // Friendly aliases so callers don't need to know internal field names
    const rawRating = item.imdbRatingValue ?? item.imdbRate ?? null;
    if (rawRating != null) out.rating = parseFloat(rawRating) || null;
    if (item.releaseDate)   out.year = parseInt(String(item.releaseDate)) || null;
    if (item.durationSeconds && !item.runtimeMinutes) out.runtimeMinutes = Math.round(item.durationSeconds / 60);
    out.type = item.subjectType === 2 ? "series" : "movie";

    if (item.seNum)         out.seasons = item.seNum;
    if (item.countryName)   out.country = item.countryName;
    if (item.language)      out.language = item.language;
    if (item.dubs?.length && !item.audioTracks) out.audioTracks = item.dubs;

    return out;
}

// Language dub filter — currently disabled (pass-through)
const notHindiDub = () => true;

// ─── Static pages ──────────────────────────────────────────────────────────────
app.get("/", (req, res) => serveFile("index.html", res));
app.get("/docs", (req, res) => serveFile("docs.html", res));
app.get("/changelog", (req, res) => serveFile("changelog.html", res));
app.get("/admin", (req, res) => serveFile("admin.html", res));
app.get("/admin/stats", (req, res) => serveFile("stats.html", res));

// ─── Debug: pool inspector (local dev only) ────────────────────────────────────
app.get("/debug/logs-view", (req, res) => serveFile("debug-logs.html", res));

app.get("/debug/pool", (req, res) => {
    res.json({
        host: SELECTED_HOST,
        mirrors: MIRROR_HOSTS,
        ipPool: { size: IP_POOL.length, sample: getRandomIp() },
        proxy: proxyRotator.size > 0
            ? { enabled: true, count: proxyRotator.size, note: "HTTP/HTTPS proxies loaded from PROXY_LIST — cycling round-robin" }
            : { enabled: false, note: "Set PROXY_LIST=http://proxy1:port,http://proxy2:port to enable proxy rotation" },
        relay: CF_WORKER_URL
            ? { enabled: true, url: CF_WORKER_URL, affects: ["search", "sources"] }
            : { enabled: false, note: "Set CF_WORKER_URL env var to relay geo-blocked endpoints through your deployed CF Worker" }
    });
});

// ─── Debug: request log ────────────────────────────────────────────────────────
app.get("/debug/logs", (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, MAX_REQUEST_LOGS);
    const statusFilter = req.query.status ? parseInt(req.query.status) : null;
    const logs = statusFilter
        ? requestLog.filter(l => l.status === statusFilter)
        : requestLog;
    res.json({
        total: requestLog.length,
        showing: Math.min(limit, logs.length),
        host: SELECTED_HOST,
        logs: logs.slice(0, limit)
    });
});

// ─── Sample data routes ────────────────────────────────────────────────────────
const sampleFiles = {
    "/sample-homepage-data":  "movieapi_sample_homepage.json",
    "/sample-trending-data":  "movieapi_sample_trending.json",
    "/sample-search-data":    "movieapi_sample_search.json",
    "/sample-filter-data":    "movieapi_sample_filter.json",
    "/sample-schedule-data":  "movieapi_sample_schedule.json",
    "/sample-info-data":      "movieapi_sample_info.json",
    "/sample-sources-data":   "movieapi_sample_sources.json",
    "/sample-captions-data":         "movieapi_sample_captions.json",
    "/sample-schedule-popular-data": "movieapi_sample_schedule_popular.json",
    "/sample-anime-data":            "movieapi_sample_anime.json",
    "/sample-anime-search-data":     "movieapi_sample_anime_search.json",
    "/sample-anime-info-data":       "movieapi_sample_anime_info.json",
    "/sample-anime-sources-data":    "movieapi_sample_anime_sources.json",
    "/sample-seasons-upcoming-data": "movieapi_sample_seasons_upcoming.json",
    "/sample-live-data":             "movieapi_sample_live.json",
    "/sample-live-stream-data":      "movieapi_sample_live_stream.json",
};
for (const [route, file] of Object.entries(sampleFiles)) {
    app.get(route, (req, res) => serveFile(file, res));
}

// ─── Static HTML pages ─────────────────────────────────────────────────────────
app.get("/request-key", (req, res) => {
    const file = path.join(__dirname, "request-key.html");
    if (fs.existsSync(file)) return res.sendFile(file);
    res.status(404).send("request-key.html not found");
});

app.get("/try", (req, res) => {
    const file = path.join(__dirname, "try.html");
    if (fs.existsSync(file)) return res.sendFile(file);
    res.status(404).send("try.html not found");
});

// ─── POST /anilist-proxy — relay AniList GraphQL for CF Worker (bypasses IP block) ──
app.post("/anilist-proxy", async (req, res) => {
    try {
        const { query, variables } = req.body || {};
        if (!query) return res.status(400).json({ errors: [{ message: "query is required" }] });
        const r = await fetch("https://graphql.anilist.co", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Accept": "application/json" },
            body: JSON.stringify({ query, variables })
        });
        const data = await r.json();
        res.status(r.status).json(data);
    } catch (e) {
        res.status(500).json({ errors: [{ message: "AniList proxy error: " + e.message }] });
    }
});

// ─── Changelog helpers ─────────────────────────────────────────────────────────
const CHANGELOG_FILE = path.join(__dirname, "changelog.json");
function readChangelog() {
    try { return JSON.parse(fs.readFileSync(CHANGELOG_FILE, "utf8")); }
    catch { return []; }
}
function writeChangelog(entries) {
    fs.writeFileSync(CHANGELOG_FILE, JSON.stringify(entries, null, 2));
}
function makeClId() {
    return "cl_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ─── Admin auth (local dev) ────────────────────────────────────────────────────
const LOCAL_ADMIN_SECRET = process.env.ADMIN_SECRET || "";
function checkLocalAdmin(req) {
    const auth = req.headers["authorization"] || "";
    return Boolean(LOCAL_ADMIN_SECRET) && auth === `Bearer ${LOCAL_ADMIN_SECRET}`;
}

// ─── GET /admin/api/keys — list keys from api-keys.json (local dev) ────────────
app.get("/admin/api/keys", (req, res) => {
    if (!checkLocalAdmin(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
        const raw = fs.existsSync(path.join(__dirname, "api-keys.json"))
            ? JSON.parse(fs.readFileSync(path.join(__dirname, "api-keys.json"), "utf8"))
            : {};
        res.json(raw);
    } catch { res.status(500).json({ error: "Could not read api-keys.json" }); }
});

// ─── POST /admin/api/keys — add key (local dev) ────────────────────────────────
app.post("/admin/api/keys", (req, res) => {
    if (!checkLocalAdmin(req)) return res.status(401).json({ error: "Unauthorized" });
    const { key, owner, domains } = req.body || {};
    if (!key || !owner) return res.status(400).json({ error: "key and owner are required" });
    const filePath = path.join(__dirname, "api-keys.json");
    const store = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, "utf8")) : {};
    if (store[key]) return res.status(409).json({ error: "Key already exists" });
    store[key] = { owner, domains: Array.isArray(domains) ? domains : [], createdAt: new Date().toISOString() };
    fs.writeFileSync(filePath, JSON.stringify(store, null, 2));
    res.json({ ok: true, key });
});

// ─── DELETE /admin/api/keys/:key — revoke key (local dev) ──────────────────────
app.delete("/admin/api/keys/:key", (req, res) => {
    if (!checkLocalAdmin(req)) return res.status(401).json({ error: "Unauthorized" });
    const key = decodeURIComponent(req.params.key);
    const filePath = path.join(__dirname, "api-keys.json");
    if (!fs.existsSync(filePath)) return res.json({ ok: true });
    const store = JSON.parse(fs.readFileSync(filePath, "utf8"));
    delete store[key];
    fs.writeFileSync(filePath, JSON.stringify(store, null, 2));
    res.json({ ok: true });
});

// ─── POST /admin/api/generate — generate a random key (local dev) ──────────────
app.post("/admin/api/generate", (req, res) => {
    if (!checkLocalAdmin(req)) return res.status(401).json({ error: "Unauthorized" });
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    const rand = Array.from({ length: 20 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
    res.json({ key: `runflix_${rand}` });
});

// ─── GET /api/changelog — public changelog feed ────────────────────────────────
app.get("/api/changelog", (req, res) => {
    const entries = readChangelog().sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json({ total: entries.length, results: entries });
});

// ─── GET /admin/api/changelog — list entries (admin) ──────────────────────────
app.get("/admin/api/changelog", (req, res) => {
    if (!checkLocalAdmin(req)) return res.status(401).json({ error: "Unauthorized" });
    res.json(readChangelog());
});

// ─── POST /admin/api/changelog — add entry ────────────────────────────────────
app.post("/admin/api/changelog", (req, res) => {
    if (!checkLocalAdmin(req)) return res.status(401).json({ error: "Unauthorized" });
    const { version, type, date, title, description, changes } = req.body || {};
    if (!version || !title) return res.status(400).json({ error: "version and title are required" });
    const entries = readChangelog();
    const entry = {
        id: makeClId(),
        version: version.trim(),
        type: type || "feature",
        date: date || new Date().toISOString().slice(0, 10),
        title: title.trim(),
        description: (description || "").trim(),
        changes: Array.isArray(changes) ? changes.filter(Boolean) : []
    };
    entries.unshift(entry);
    writeChangelog(entries);
    res.json({ ok: true, entry });
});

// ─── PUT /admin/api/changelog/:id — edit entry ────────────────────────────────
app.put("/admin/api/changelog/:id", (req, res) => {
    if (!checkLocalAdmin(req)) return res.status(401).json({ error: "Unauthorized" });
    const id = decodeURIComponent(req.params.id);
    const { version, type, date, title, description, changes } = req.body || {};
    if (!version || !title) return res.status(400).json({ error: "version and title are required" });
    const entries = readChangelog();
    const idx = entries.findIndex(e => e.id === id);
    if (idx === -1) return res.status(404).json({ error: "Entry not found" });
    entries[idx] = { ...entries[idx], version: version.trim(), type: type || entries[idx].type, date: date || entries[idx].date, title: title.trim(), description: (description || "").trim(), changes: Array.isArray(changes) ? changes.filter(Boolean) : entries[idx].changes };
    writeChangelog(entries);
    res.json({ ok: true, entry: entries[idx] });
});

// ─── DELETE /admin/api/changelog/:id — delete entry ──────────────────────────
app.delete("/admin/api/changelog/:id", (req, res) => {
    if (!checkLocalAdmin(req)) return res.status(401).json({ error: "Unauthorized" });
    const id = decodeURIComponent(req.params.id);
    const entries = readChangelog();
    const filtered = entries.filter(e => e.id !== id);
    if (filtered.length === entries.length) return res.status(404).json({ error: "Entry not found" });
    writeChangelog(filtered);
    res.json({ ok: true });
});

// ─── POST /admin/api/changelog/push-to-worker — seed KV from changelog.json ──
app.post("/admin/api/changelog/push-to-worker", async (req, res) => {
    if (!checkLocalAdmin(req)) return res.status(401).json({ error: "Unauthorized" });
    const workerUrl = (req.body?.worker_url || CF_WORKER_URL || "").replace(/\/$/, "");
    if (!workerUrl) {
        return res.status(400).json({ error: "No CF Worker URL configured. Set CF_WORKER_URL env var or pass worker_url in the request body." });
    }
    const workerSecret = req.body?.worker_secret || process.env.WORKER_ADMIN_SECRET || LOCAL_ADMIN_SECRET;
    const entries = readChangelog();
    try {
        const r = await fetch(`${workerUrl}/admin/api/changelog/bulk`, {
            method: "PUT",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${workerSecret}` },
            body: JSON.stringify(entries)
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) return res.status(r.status).json({ error: data.error || `Worker responded with ${r.status}` });
        res.json({ ok: true, count: entries.length, workerUrl });
    } catch (e) {
        res.status(502).json({ error: "Could not reach CF Worker: " + e.message });
    }
});

// ─── POST /api/request-key — submit key request + send email ───────────────────
app.post("/api/request-key", async (req, res) => {
    const { name, email, website, useCase } = req.body || {};
    if (!name || !useCase) return res.status(400).json({ error: "Name and use case are required" });
    const id = Date.now().toString();
    const emailSent = await sendRequestEmail({ name, email, website, useCase });
    if (!emailSent) console.warn("[api/request-key] Email could not be sent — check SMTP settings");
    res.json({ ok: true, id });
});

// ─── GET /relay-search/:query — proxies to any CF Worker URL (no quota) ────────
// Used by try.html when the user has entered a CF Worker URL in the relay config.
// Runs server-side so no API key is exposed in browser JS.
app.get("/relay-search/:query", async (req, res) => {
    const query = decodeURIComponent(req.params.query).trim();
    if (!query) return res.status(400).json({ error: "query is required" });

    const workerUrl = (req.query.worker_url || CF_WORKER_URL || "").replace(/\/$/, "");
    if (!workerUrl) return res.status(400).json({ error: "No CF Worker URL configured. Set worker_url param or CF_WORKER_URL env var." });

    try {
        const qs = new URLSearchParams({
            page: req.query.page || 1,
            perPage: req.query.perPage || 24,
            type: req.query.type || 0
        });
        const r = await fetch(`${workerUrl}/api/v3/search/${encodeURIComponent(query)}?${qs}`, {
            headers: { "Authorization": `Bearer ${CF_WORKER_API_KEY}` }
        });
        const data = await r.json();
        res.json(data);
    } catch (e) {
        res.status(500).json({ success: false, message: "Relay search failed: " + e.message });
    }
});

// ─── GET /try-search/:query — free-tier search (no API key) ─────────────────────
const freeTryQuota = new Map();

app.get("/try-search/:query", async (req, res) => {
    const query = decodeURIComponent(req.params.query).trim();
    if (!query) return res.status(400).json({ error: "query is required" });

    const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.ip || "unknown";
    const today = new Date().toISOString().slice(0, 10);
    const qKey = `${ip}:${today}`;
    const used = freeTryQuota.get(qKey) || 0;
    const DAILY_LIMIT = 50;

    if (used >= DAILY_LIMIT) {
        return res.status(429).json({
            status: 429, success: false, creator: "DaraTech",
            message: `Free tier daily limit (${DAILY_LIMIT} searches) reached. Request a full API key at /request-key.`
        });
    }

    freeTryQuota.set(qKey, used + 1);
    setTimeout(() => freeTryQuota.delete(qKey), 86400000);

    try {
        // v3 API — same as the full search endpoint, no geo-block
        const v3Data = await v3Post("/wefeed-mobile-bff/subject-api/search/v2", {
            keyword: query, page: 1, perPage: 10, subjectType: SubjectType.ALL, tabId: "All"
        });
        const items = (v3Data?.results?.[0]?.subjects || v3Data?.items || []).map(normaliseItem);
        return res.json({
            status: 200, success: true, creator: "DaraTech",
            freeTier: true,
            remaining: DAILY_LIMIT - used - 1,
            results: { items: items.slice(0, 10), query }
        });
    } catch (e) {
        res.status(500).json({ status: 500, success: false, message: "Search failed: " + e.message });
    }
});

// ─── Homepage ──────────────────────────────────────────────────────────────────
app.get("/api/v3/homepage", async (req, res) => {
    try {
        const data = await v3Get("/wefeed-mobile-bff/tab-operating", { page: 1, tabId: 0, version: "" });
        const sections = (data?.items || [])
            .filter(s => Array.isArray(s.subjects) && s.subjects.length > 0)
            .map(s => ({
                type:  s.type  || "Section",
                title: s.title || "",
                items: s.subjects.map(normaliseItem)
            }))
            .filter(s => s.items.length > 0);
        ok(res, { sections, totalSections: sections.length });
    } catch (e) {
        err(res, "Failed to fetch homepage data: " + e.message);
    }
});

// ─── Trending ──────────────────────────────────────────────────────────────────
app.get("/api/v3/trending", async (req, res) => {
    try {
        const page     = parseInt(req.query.page)    || 1;
        const perPage  = parseInt(req.query.perPage) || 30;
        const type     = parseInt(req.query.type)    || 0;

        // tab-operating only has 1 real page of data — further pages are duplicates.
        // Supplement with targeted searches instead (same pool as homepage top-up).
        const data = await v3Get("/wefeed-mobile-bff/tab-operating", { page: 1, tabId: 0, version: "" });

        let allItems = [];
        for (const s of (data?.items || [])) {
            if (!Array.isArray(s.subjects)) continue;
            for (const i of s.subjects) allItems.push({ ...i, _section: s.title || s.type });
        }

        // Deduplicate by subjectId
        const seen = new Set();
        allItems = allItems.filter(i => {
            if (!i.subjectId || seen.has(i.subjectId)) return false;
            seen.add(i.subjectId); return true;
        });

        if (type !== 0) allItems = allItems.filter(i => i.subjectType === type);
        allItems = allItems.filter(notHindiDub).map(normaliseItem);
        const offset = (page - 1) * perPage;
        const items  = allItems.slice(offset, offset + perPage);
        ok(res, { items, total: allItems.length, page, perPage, hasMore: offset + perPage < allItems.length });
    } catch (e) {
        err(res, "Failed to fetch trending data: " + e.message);
    }
});

// ─── Search ────────────────────────────────────────────────────────────────────
app.get("/api/v3/search/:query", async (req, res) => {
    try {
        const query = decodeURIComponent(req.params.query).trim();
        const page = parseInt(req.query.page) || 1;
        const perPage = parseInt(req.query.perPage) || 20;
        const subjectType = parseInt(req.query.type) || SubjectType.ALL;

        // Fetch 5 search pages in parallel — v3 caps perPage at 20, so 5×20 = up to 100 raw results.
        // This ensures queries like "demon" surface "Demon Slayer", "Demon King", etc. from later pages.
        const [r1, r2, r3, r4, r5] = await Promise.allSettled([
            v3Post("/wefeed-mobile-bff/subject-api/search/v2", { keyword: query, page: 1, perPage: 20, subjectType, tabId: "All" }),
            v3Post("/wefeed-mobile-bff/subject-api/search/v2", { keyword: query, page: 2, perPage: 20, subjectType, tabId: "All" }),
            v3Post("/wefeed-mobile-bff/subject-api/search/v2", { keyword: query, page: 3, perPage: 20, subjectType, tabId: "All" }),
            v3Post("/wefeed-mobile-bff/subject-api/search/v2", { keyword: query, page: 4, perPage: 20, subjectType, tabId: "All" }),
            v3Post("/wefeed-mobile-bff/subject-api/search/v2", { keyword: query, page: 5, perPage: 20, subjectType, tabId: "All" }),
        ]);

        let pager = {};
        const rawItems = [];
        const seen = new Set();
        for (const result of [r1, r2, r3, r4, r5]) {
            if (result.status !== "fulfilled") continue;
            const d = result.value;
            if (!Object.keys(pager).length && d?.pager) Object.assign(pager, d.pager);
            for (const item of (d?.results?.[0]?.subjects || d?.items || [])) {
                if (item.subjectId && seen.has(item.subjectId)) continue;
                if (item.subjectId) seen.add(item.subjectId);
                rawItems.push(item);
            }
        }

        // Supplement with tab-operating items whose title contains the query substring.
        // Fixes cases where the search index returns sparse results (e.g. "demon" → "Demon Slayer").
        try {
            const ql = query.toLowerCase();
            const hpData = await v3Get("/wefeed-mobile-bff/tab-operating", { page: 1, tabId: 0, version: "" });
            for (const s of (hpData?.items || [])) {
                for (const item of (s.subjects || [])) {
                    if (item.subjectId && seen.has(item.subjectId)) continue;
                    if ((item.title || "").toLowerCase().includes(ql)) {
                        if (item.subjectId) seen.add(item.subjectId);
                        rawItems.push(item);
                    }
                }
            }
        } catch {}

        let items = rawItems.map(normaliseItem).filter(notHindiDub);
        if (subjectType !== SubjectType.ALL) items = items.filter(i => i.subjectType === subjectType);

        const total = pager.total ?? items.length;
        const offset = (page - 1) * perPage;
        const pagedItems = items.slice(offset, offset + perPage);
        ok(res, { items: pagedItems, pager, query, total, hasMore: offset + perPage < items.length });
    } catch (e) {
        err(res, "Failed to perform search: " + e.message);
    }
});

// ─── Filter (platform / genre / section) ──────────────────────────────────────
app.get("/api/v3/filter", async (req, res) => {
    try {
        const platform = (req.query.platform || "").toLowerCase().trim();
        const genre    = (req.query.genre    || "").trim();
        const page     = parseInt(req.query.page) || 1;
        const perPage  = Math.min(parseInt(req.query.perPage) || 20, 20);
        const type     = parseInt(req.query.type) || SubjectType.ALL;

        if (!platform && !genre) {
            const v3Data = await v3Post("/wefeed-mobile-bff/subject-api/search/v2", {
                keyword: "trending", page, perPage, subjectType: type, tabId: "All"
            });
            const items = (v3Data?.results?.[0]?.subjects || v3Data?.items || []).map(normaliseItem);
            return ok(res, {
                items, total: items.length, page, perPage,
                filter: { platform: null, genre: null, type },
                note: "No filter provided — returning trending content"
            });
        }

        const pm = platform ? PLATFORM_MAP[platform] : null;
        if (platform && !pm) {
            const valid = Object.keys(PLATFORM_MAP).join(", ");
            return err(res, `Unknown platform "${platform}". Valid options: ${valid}`, 400);
        }

        let items = [];
        let platformLabel = pm?.label || null;

        if (pm?.mode === "section") {
            // ── Section-mode: pull from homepage, pick matching section(s) ───────
            const hp = await v3Get("/wefeed-mobile-bff/tab-operating", { page: 1, tabId: 0, version: "" });
            const sections = (hp?.items || []).filter(s => Array.isArray(s.subjects) && s.subjects.length);
            const kw = pm.keyword.toLowerCase();
            const matched = sections.filter(s => (s.title || "").toLowerCase().includes(kw));
            if (!matched.length) {
                // Fallback: search-mode if no section found
                const v3Data = await v3Post("/wefeed-mobile-bff/subject-api/search/v2", {
                    keyword: pm.keyword + (genre ? ` ${genre}` : ""), page, perPage, subjectType: type, tabId: "All"
                });
                items = (v3Data?.results?.[0]?.subjects || v3Data?.items || []).map(normaliseItem);
            } else {
                const seen = new Set();
                for (const s of matched) {
                    for (const i of s.subjects) {
                        if (!i.subjectId || seen.has(i.subjectId)) continue;
                        seen.add(i.subjectId);
                        items.push(normaliseItem(i));
                    }
                }
                const offset = (page - 1) * perPage;
                items = items.slice(offset, offset + perPage);
            }
        } else {
            // ── Search-mode: keyword search (streaming services + anime/kdrama) ──
            const kw = (pm ? pm.keyword : "") + (genre ? (pm ? ` ${genre}` : genre) : "");
            const v3Data = await v3Post("/wefeed-mobile-bff/subject-api/search/v2", {
                keyword: kw.trim(), page, perPage, subjectType: type, tabId: "All"
            });
            items = (v3Data?.results?.[0]?.subjects || v3Data?.items || []).map(normaliseItem);
            if (genre) {
                const gl = genre.toLowerCase();
                items = items.filter(i =>
                    (i.genre  || "").toLowerCase().includes(gl) ||
                    (i.title  || "").toLowerCase().includes(gl) ||
                    (i.corner || "").toLowerCase().includes(gl)
                );
            }
        }

        if (type !== SubjectType.ALL) items = items.filter(i => i.subjectType === type);

        ok(res, {
            items,
            total: items.length,
            page,
            perPage,
            filter: { platform: platformLabel, genre: genre || null, type },
            note: pm?.mode === "search"
                ? "Platform identification is keyword-based; upstream does not tag content by streaming service"
                : undefined
        });
    } catch (e) {
        err(res, "Filter failed: " + e.message);
    }
});

// ─── Schedule (anime via AniList, other genres via upstream search) ────────────
app.get("/api/v3/schedule", async (req, res) => {
    try {
        const period = (req.query.period || "daily").toLowerCase();
        const genre  = (req.query.genre  || "").toLowerCase().trim();
        const type   = parseInt(req.query.type) || SubjectType.ALL;
        const page   = parseInt(req.query.page) || 1;

        if (!["daily","weekly","monthly"].includes(period))
            return err(res, 'Invalid period. Use: daily, weekly, monthly', 400);

        const rawDate = req.query.date || new Date().toISOString().slice(0, 10);
        const startDate = new Date(rawDate + "T00:00:00Z");
        if (isNaN(startDate.getTime())) return err(res, "Invalid date. Use YYYY-MM-DD", 400);

        const endDate = new Date(startDate);
        if      (period === "weekly")  endDate.setUTCDate(endDate.getUTCDate() + 7);
        else if (period === "monthly") endDate.setUTCDate(endDate.getUTCDate() + 30);
        else                           endDate.setUTCDate(endDate.getUTCDate() + 1);

        const useJikan = genre === "anime" || genre === "" || genre === "all";

        if (useJikan) {
            try {
                // Build a map: UTC weekday number → actual date string in the requested range
                const weekdayToDate = {};
                const cur = new Date(startDate);
                while (cur < endDate) {
                    weekdayToDate[cur.getUTCDay()] = cur.toISOString().slice(0, 10);
                    cur.setUTCDate(cur.getUTCDate() + 1);
                }

                const jikan = await fetchJikanSchedule(page);
                let items = jikan.data || [];

                if (genre && genre !== "anime" && genre !== "all") {
                    const gl = genre.toLowerCase();
                    items = items.filter(item =>
                        (item.genres || []).some(g => g.name.toLowerCase().includes(gl))
                    );
                }

                const byDate = {};
                for (const item of items) {
                    const dayKey = (item.broadcast?.day || "").toLowerCase();
                    const weekdayNum = JIKAN_DAY_MAP[dayKey];
                    const date = weekdayNum !== undefined ? weekdayToDate[weekdayNum] : null;
                    if (!date) continue;
                    if (!byDate[date]) byDate[date] = [];
                    byDate[date].push(normaliseJikanItem(item, date));
                }

                const days = Object.entries(byDate)
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([date, dayItems]) => ({ date, count: dayItems.length, items: dayItems }));

                const total = days.reduce((n, d) => n + d.count, 0);

                return ok(res, {
                    schedule: days,
                    period,
                    dateRange: { from: rawDate, to: endDate.toISOString().slice(0, 10) },
                    totalEpisodes: total,
                    source: "jikan",
                    filter: { genre: genre || "anime", type: "series" },
                    pagination: jikan.pagination || {}
                });
            } catch (jikanErr) {
                console.error("Jikan failed, falling back to upstream:", jikanErr.message);
                // Fall through to upstream path below
            }
        }

        // ── General schedule: upstream search filtered by releaseDate ──────────
        const keyword = genre || "trending";
        const v3Data = await v3Post("/wefeed-mobile-bff/subject-api/search/v2", {
            keyword, page, perPage: 20, subjectType: type, tabId: "All"
        });
        let items = (v3Data?.results?.[0]?.subjects || v3Data?.items || []).map(normaliseItem);

        const startTs = startDate.getTime();
        const endTs   = endDate.getTime();
        items = items.filter(i => {
            if (!i.releaseDate) return false;
            const d = new Date(i.releaseDate).getTime();
            return !isNaN(d) && d >= startTs && d < endTs;
        });

        ok(res, {
            schedule: [{ date: rawDate, count: items.length, items }],
            period,
            dateRange: { from: rawDate, to: endDate.toISOString().slice(0, 10) },
            total: items.length,
            source: "upstream",
            filter: { genre: genre || null, type }
        });
    } catch (e) {
        err(res, "Schedule fetch failed: " + e.message);
    }
});

// ─── Schedule / Popular ────────────────────────────────────────────────────────
// Returns top currently-airing anime ranked by MAL score (via Jikan top/anime).
// ?type=tv|movie|ova|special|ona  (default: tv)
// ?genre=action                   (client-side genre filter)
// ?limit=1-25                     (default: 25)
// ?page=N                         (default: 1)
app.get("/api/v3/schedule/popular", async (req, res) => {
    try {
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 25, 1), 25);
        const page  = Math.max(parseInt(req.query.page)  || 1, 1);
        const genre = (req.query.genre || "").toLowerCase().trim();
        const type  = (req.query.type  || "tv").toLowerCase();

        const VALID_TYPES = ["tv", "movie", "ova", "special", "ona", "music", "cm", "pv", "tvspecial"];
        if (type && !VALID_TYPES.includes(type))
            return err(res, `Invalid type. Use: ${VALID_TYPES.join(", ")}`, 400);

        const params = new URLSearchParams({ filter: "airing", limit: 25, page });
        if (type) params.set("type", type);

        const jikanRes = await fetch(`https://api.jikan.moe/v4/top/anime?${params}`, {
            headers: { "Accept": "application/json" }
        });
        if (!jikanRes.ok) throw new Error(`Jikan HTTP ${jikanRes.status}`);
        const jikan = await jikanRes.json();

        let items = (jikan.data || []).map(item => normaliseJikanItem(item, null));

        if (genre) {
            items = items.filter(item =>
                item.genres.some(g => g.toLowerCase().includes(genre))
            );
        }

        items = items.slice(0, limit);

        ok(res, {
            items,
            total: items.length,
            page,
            filter: { type, genre: genre || null },
            source: "jikan",
            note: "Top currently-airing anime ranked by MAL score",
            pagination: jikan.pagination || {}
        });
    } catch (e) {
        err(res, "Popular schedule fetch failed: " + e.message);
    }
});

// ─── Anime — anime/animation filtered from homepage + trending sections ────────
// Pulls tab-operating (same source as homepage/trending) and keeps only items
// whose section title or item metadata contains "anime" or "animation".
// ?type=0|1|2     (0=all default, 1=movies, 2=series)
// ?genre=action   (client-side genre filter on results)
// ?perPage=N      (default: 20, max: 50)
// ?page=N         (default: 1)
app.get("/api/v3/anime", async (req, res) => {
    try {
        const page    = Math.max(parseInt(req.query.page)    || 1, 1);
        const perPage = Math.min(parseInt(req.query.perPage) || 20, 50);
        const genre   = (req.query.genre || "").trim().toLowerCase();
        const type    = parseInt(req.query.type) || SubjectType.ALL;
        // strict=true → only items whose corner field is exactly "Anime" (excludes generic animated films)
        const strict  = req.query.strict === "true" || req.query.strict === "1";

        // Pull homepage sections (same upstream call as /api/v3/homepage and trending)
        const data     = await v3Get("/wefeed-mobile-bff/tab-operating", { page: 1, tabId: 0, version: "" });
        const sections = (data?.items || []).filter(s => Array.isArray(s.subjects) && s.subjects.length > 0);

        const ANIME_KW = ["anime", "animation"];
        const hasAnimeKw = (str) => { const s = (str || "").toLowerCase(); return ANIME_KW.some(k => s.includes(k)); };

        const seen = new Set();
        let allItems = [];

        for (const section of sections) {
            const sectionIsAnime = hasAnimeKw(section.title) || hasAnimeKw(section.type);
            for (const item of section.subjects) {
                if (!item.subjectId || seen.has(item.subjectId)) continue;
                const itemIsAnime = hasAnimeKw(item.title) || hasAnimeKw(item.corner) || hasAnimeKw(item.genre);
                if (!sectionIsAnime && !itemIsAnime) continue;
                seen.add(item.subjectId);
                allItems.push(normaliseItem({ ...item, _section: section.title || section.type }));
            }
        }

        // Strict mode: corner must explicitly contain "anime" (drops generic animated films)
        if (strict) {
            allItems = allItems.filter(i => (i.corner || "").toLowerCase().includes("anime"));
        }

        // Type filter (1=movies, 2=series)
        if (type !== SubjectType.ALL) allItems = allItems.filter(i => i.subjectType === type);

        // Genre filter (client-side on results)
        if (genre) {
            allItems = allItems.filter(i =>
                (i.genre  || "").toLowerCase().includes(genre) ||
                (i.title  || "").toLowerCase().includes(genre) ||
                (i.corner || "").toLowerCase().includes(genre)
            );
        }

        const total  = allItems.length;
        const offset = (page - 1) * perPage;
        const items  = allItems.slice(offset, offset + perPage);

        ok(res, {
            items,
            total,
            page,
            perPage,
            hasMore: offset + perPage < total,
            filter: { genre: genre || null, type, strict },
            source: "upstream",
            note: strict
                ? "Strict mode — only items with corner=Anime (pure anime feed)"
                : "Filtered from homepage + trending sections — anime and animation content only"
        });
    } catch (e) {
        err(res, "Anime catalog fetch failed: " + e.message);
    }
});

// ─── Anime Search ─────────────────────────────────────────────────────────────
// Keyword search scoped to anime/animation content only.
// Runs "anime <query>" + "<query>" in parallel (4 pages) then filters to anime.
// ?type=0|1|2    (0=all default, 1=movies, 2=series)
// ?genre=action  (client-side genre filter on results)
// ?page=N        (default: 1)
// ?perPage=N     (default: 20, max: 50)
app.get("/api/v3/anime/search/:query", async (req, res) => {
    try {
        const query   = decodeURIComponent(req.params.query).trim();
        const page    = Math.max(parseInt(req.query.page)    || 1, 1);
        const perPage = Math.min(parseInt(req.query.perPage) || 20, 50);
        const type    = parseInt(req.query.type) || SubjectType.ALL;
        const genre   = (req.query.genre || "").trim().toLowerCase();

        const ANIME_KW = ["anime", "animation"];
        const isAnimeItem = (i) => {
            const s = `${i.title||""} ${i.corner||""} ${i.genre||""} ${i.category||""}`.toLowerCase();
            return ANIME_KW.some(k => s.includes(k));
        };

        // 4 parallel fetches: 2 pages of "anime <query>" + 2 pages of plain "<query>"
        const [r1, r2, r3, r4] = await Promise.allSettled([
            v3Post("/wefeed-mobile-bff/subject-api/search/v2", { keyword: `anime ${query}`, page: 1, perPage: 20, subjectType: SubjectType.ALL, tabId: "All" }),
            v3Post("/wefeed-mobile-bff/subject-api/search/v2", { keyword: `anime ${query}`, page: 2, perPage: 20, subjectType: SubjectType.ALL, tabId: "All" }),
            v3Post("/wefeed-mobile-bff/subject-api/search/v2", { keyword: query,            page: 1, perPage: 20, subjectType: SubjectType.ALL, tabId: "All" }),
            v3Post("/wefeed-mobile-bff/subject-api/search/v2", { keyword: query,            page: 2, perPage: 20, subjectType: SubjectType.ALL, tabId: "All" }),
        ]);

        const seen = new Set();
        const rawItems = [];
        for (const result of [r1, r2, r3, r4]) {
            if (result.status !== "fulfilled") continue;
            for (const item of (result.value?.results?.[0]?.subjects || result.value?.items || [])) {
                if (item.subjectId && seen.has(item.subjectId)) continue;
                if (item.subjectId) seen.add(item.subjectId);
                rawItems.push(item);
            }
        }

        // Supplement from tab-operating anime sections for partial title matches
        try {
            const ql = query.toLowerCase();
            const hpData = await v3Get("/wefeed-mobile-bff/tab-operating", { page: 1, tabId: 0, version: "" });
            for (const s of (hpData?.items || [])) {
                if (!ANIME_KW.some(k => (s.title || s.type || "").toLowerCase().includes(k))) continue;
                for (const item of (s.subjects || [])) {
                    if (item.subjectId && seen.has(item.subjectId)) continue;
                    if ((item.title || "").toLowerCase().includes(ql)) {
                        if (item.subjectId) seen.add(item.subjectId);
                        rawItems.push(item);
                    }
                }
            }
        } catch {}

        let items = rawItems.map(normaliseItem).filter(isAnimeItem);
        if (type !== SubjectType.ALL) items = items.filter(i => i.subjectType === type);
        if (genre) items = items.filter(i =>
            (i.genre  || "").toLowerCase().includes(genre) ||
            (i.title  || "").toLowerCase().includes(genre) ||
            (i.corner || "").toLowerCase().includes(genre)
        );

        const total  = items.length;
        const offset = (page - 1) * perPage;
        ok(res, {
            items: items.slice(offset, offset + perPage),
            total, page, perPage,
            hasMore: offset + perPage < total,
            query,
            filter: { type, genre: genre || null },
            note: "Anime-only search — results filtered to anime and animation content"
        });
    } catch (e) {
        err(res, "Anime search failed: " + e.message);
    }
});

// ─── Seasons / Upcoming ────────────────────────────────────────────────────────
// Upcoming anime from Jikan — shows announced but not yet airing.
// Use for "Coming Soon" pages on anime websites.
// ?type=tv|movie|ova|special|ona  (optional, omit for all types)
// ?genre=romance                  (client-side genre filter)
// ?page=N                         (default: 1)
app.get("/api/v3/seasons/upcoming", async (req, res) => {
    try {
        const page  = Math.max(parseInt(req.query.page) || 1, 1);
        const genre = (req.query.genre || "").toLowerCase().trim();
        const type  = (req.query.type  || "").toLowerCase();

        const VALID_TYPES = ["", "tv", "movie", "ova", "special", "ona", "music", "cm", "pv", "tvspecial"];
        if (!VALID_TYPES.includes(type))
            return err(res, "Invalid type. Use: tv, movie, ova, special, ona", 400);

        const params = new URLSearchParams({ page });
        if (type) params.set("filter", type);

        const jikanRes = await fetch(`https://api.jikan.moe/v4/seasons/upcoming?${params}`, {
            headers: { "Accept": "application/json" }
        });
        if (!jikanRes.ok) throw new Error(`Jikan HTTP ${jikanRes.status}`);
        const jikan = await jikanRes.json();

        let items = (jikan.data || []).map(item => normaliseJikanItem(item, null));

        if (genre) {
            items = items.filter(item =>
                item.genres.some(g => g.toLowerCase().includes(genre))
            );
        }

        ok(res, {
            items,
            total: items.length,
            page,
            filter: { type: type || null, genre: genre || null },
            source: "jikan",
            note: "Upcoming anime — not yet airing",
            pagination: jikan.pagination || {}
        });
    } catch (e) {
        err(res, "Upcoming season fetch failed: " + e.message);
    }
});

// ─── Helper: fetch per-season episode counts from the v3 season-info endpoint ──
// Falls back gracefully — info is still returned even if this extra call fails.
async function fetchSeasonDetails(movieId) {
    try {
        const data = await v3Get("/wefeed-mobile-bff/subject-api/season-info", { subjectId: movieId });
        const seasons = data?.seasons;
        if (Array.isArray(seasons) && seasons.length > 0) {
            return seasons.map(s => ({ season: s.se, totalEpisodes: s.maxEp || 0 }));
        }
        return null;
    } catch {
        return null;
    }
}

// ─── Info ──────────────────────────────────────────────────────────────────────
app.get("/api/v3/info/:id", async (req, res) => {
    try {
        const movieId = req.params.id;
        const [data, seasonDetails] = await Promise.all([
            v3Get("/wefeed-mobile-bff/subject-api/get", { subjectId: movieId }),
            fetchSeasonDetails(movieId)
        ]);
        if (!data) return err(res, "Subject not found", 404);
        const item = normaliseItem(data);
        if (seasonDetails) {
            item.seasonDetails = seasonDetails;
            const total = seasonDetails.reduce((n, s) => n + (s.totalEpisodes || 0), 0);
            if (total > 0) item.totalEpisodes = total;
        } else {
            // Fallback: resourceDetectors[0].totalEpisode = episodes available in a resource pack
            const epCount = data.resourceDetectors?.[0]?.totalEpisode;
            if (epCount) item.totalEpisodes = epCount;
        }
        ok(res, item);
    } catch (e) {
        err(res, "Failed to fetch movie info: " + e.message);
    }
});

// ─── Anime Info ────────────────────────────────────────────────────────────────
// Same as /info/:id but validates the title is anime/animation before returning.
// Returns 404 with a clear message if the ID belongs to a non-anime title.
app.get("/api/v3/anime/info/:id", async (req, res) => {
    try {
        const movieId = req.params.id;
        const [data, seasonDetails] = await Promise.all([
            v3Get("/wefeed-mobile-bff/subject-api/get", { subjectId: movieId }),
            fetchSeasonDetails(movieId)
        ]);
        if (!data) return err(res, "Subject not found", 404);
        const item = normaliseItem(data);
        const ANIME_KW = ["anime", "animation"];
        const hasAnimeKw = (str) => { const s = (str || "").toLowerCase(); return ANIME_KW.some(k => s.includes(k)); };
        const isAnime = hasAnimeKw(item.genre) || hasAnimeKw(item.corner) || hasAnimeKw(item.category);
        if (!isAnime) return err(res, `Title "${item.title || movieId}" is not an anime/animation title. Use /api/v3/info/${movieId} for general info.`, 404);
        if (seasonDetails) {
            item.seasonDetails = seasonDetails;
            const total = seasonDetails.reduce((n, s) => n + (s.totalEpisodes || 0), 0);
            if (total > 0) item.totalEpisodes = total;
        } else {
            const epCount = data.resourceDetectors?.[0]?.totalEpisode;
            if (epCount) item.totalEpisodes = epCount;
        }
        ok(res, item);
    } catch (e) {
        err(res, "Failed to fetch anime info: " + e.message);
    }
});

// ─── Anime Sources ─────────────────────────────────────────────────────────────
// Same as /sources/:id but validates the title is anime/animation first.
// Fetches info + resource in parallel; returns 404 if the title is not anime.
// ?season=N  ?episode=N  (for series episodes)
app.get("/api/v3/anime/sources/:id", async (req, res) => {
    try {
        const movieId = req.params.id;
        const season  = parseInt(req.query.season)  || 0;
        const episode = parseInt(req.query.episode) || 0;

        const v3Params = { subjectId: movieId };
        if (season || episode) { v3Params.se = season; v3Params.ep = episode; }

        // Fetch info + resource in parallel
        const [infoData, resourceData] = await Promise.all([
            v3Get("/wefeed-mobile-bff/subject-api/get",      { subjectId: movieId }),
            v3Get("/wefeed-mobile-bff/subject-api/resource", v3Params)
        ]);

        if (!infoData) return err(res, "Subject not found", 404);

        // Validate anime genre/corner/category
        const item = normaliseItem(infoData);
        const ANIME_KW = ["anime", "animation"];
        const hasAnimeKw = (str) => { const s = (str || "").toLowerCase(); return ANIME_KW.some(k => s.includes(k)); };
        if (!hasAnimeKw(item.genre) && !hasAnimeKw(item.corner) && !hasAnimeKw(item.category)) {
            return err(res, `Title "${item.title || movieId}" is not an anime/animation title. Use /api/v3/sources/${movieId} for general sources.`, 404);
        }

        const videoList = resourceData?.list || [];
        if (videoList.length === 0) return err(res, "No video sources found for this anime title", 404);

        const baseUrl = 'https://movieapi.runflix.name.ng';

        const rawSources = videoList.map(f => {
            const label = normaliseQualityLabel(f.resolution);
            const dl = new URLSearchParams({ url: f.resourceLink, quality: label });
            if (season || episode) { dl.set("season", season); dl.set("episode", episode); }
            const codec = f.codecName || null;
            return {
                id:                f.resourceId,
                _qualityBase:      label,
                quality:           label,
                url:               f.resourceLink,
                download_url:      `${baseUrl}/api/v3/download?${dl}`,
                stream_url:        `${baseUrl}/api/v3/stream?url=${encodeURIComponent(f.resourceLink)}`,
                size:              f.size     || 0,
                codec,
                duration:          f.duration  || 0,
                format:            String(f.resourceLink || "").includes(".m3u8") ? "hls" : "mp4",
                browserCompatible: isBrowserCompatibleCodec(codec),
                requireMemberType: f.requireMemberType || 0
            };
        });
        const sources = dedupeAndSortSources(rawSources);

        // extCaptions live per-item inside list[] — read from the first item
        const subtitles = (videoList[0]?.extCaptions || []).map(c => ({
            language:     c.lanName || c.lan,
            languageCode: c.lan,
            url:          c.url,
            size:         c.size  || 0,
            delay:        c.delay || 0
        }));

        const audioTracks = (infoData?.dubs || []).map(d => ({
            language:     d.lanName || d.lanCode,
            languageCode: d.lanCode || "",
            isOriginal:   d.original || false,
            subjectId:    d.subjectId || ""
        }));

        res.json({ status: 200, success: true, creator: "DaraTech", results: sources, subtitles, audioTracks });
    } catch (e) {
        err(res, "Failed to fetch anime sources: " + e.message);
    }
});

// ─── Quality helpers ────────────────────────────────────────────────────────────
const QUALITY_ORDER = [8640, 4320, 2160, 1440, 1080, 720, 480, 360, 240, 144];

function normaliseQualityLabel(raw) {
    const n = parseInt(String(raw || '').replace(/[^0-9]/g, '')) || 0;
    if (!n) return 'Unknown';
    if (n >= 8640) return '8K';
    if (n >= 4320) return '4K Ultra';
    if (n >= 2160) return '4K';
    if (n >= 1440) return '2K';
    if (n >= 1080) return '1080p';
    if (n >= 720)  return 'HD (720p)';
    if (n >= 480)  return '480p';
    if (n >= 360)  return '360p';
    if (n >= 240)  return '240p';
    return '144p';
}

function dedupeAndSortSources(sources) {
    // Group by quality tier, keep only the best (largest file) per tier
    const best = {};
    for (const s of sources) {
        const tier = s._qualityBase;
        if (!best[tier] || (s.size || 0) > (best[tier].size || 0)) best[tier] = s;
    }
    const out = Object.values(best).map(({ _qualityBase, ...rest }) => rest);
    out.sort((a, b) => {
        const rank = q => QUALITY_ORDER.findIndex(r => normaliseQualityLabel(r) === q);
        const ra = rank(a.quality), rb = rank(b.quality);
        return (ra === -1 ? 99 : ra) - (rb === -1 ? 99 : rb);
    });
    return out;
}

// ─── Sources ───────────────────────────────────────────────────────────────────
app.get("/api/v3/sources/:id", async (req, res) => {
    try {
        const movieId = req.params.id;
        const season = parseInt(req.query.season) || 0;
        const episode = parseInt(req.query.episode) || 0;

        // ── Primary: v3 resource endpoint (api6.aoneroom.com) ──────────────────
        // (CF_WORKER relay removed here: v3 resource endpoint handles this directly)
        // Returns direct video URLs — bypasses the 403 "invalid region" from old mirrors.
        const v3Params = { subjectId: movieId };
        if (season || episode) { v3Params.se = season; v3Params.ep = episode; }
        const v3ResourceData = await v3Get("/wefeed-mobile-bff/subject-api/resource", v3Params);
        const videoList = v3ResourceData?.list || [];

        if (videoList.length > 0) {
            const baseUrl = 'https://movieapi.runflix.name.ng';

            const rawSources = videoList.map(f => {
                const label = normaliseQualityLabel(f.resolution);
                const dl = new URLSearchParams({ url: f.resourceLink, quality: label });
                if (season || episode) { dl.set("season", season); dl.set("episode", episode); }
                const codec = f.codecName || null;
                return {
                    id:                f.resourceId,
                    _qualityBase:      label,
                    quality:           label,
                    url:               f.resourceLink,
                    download_url:      `${baseUrl}/api/v3/download?${dl}`,
                    stream_url:        `${baseUrl}/api/v3/stream?url=${encodeURIComponent(f.resourceLink)}`,
                    size:              f.size || 0,
                    codec,
                    duration:          f.duration  || 0,
                    format:            String(f.resourceLink || "").includes(".m3u8") ? "hls" : "mp4",
                    browserCompatible: isBrowserCompatibleCodec(codec),
                    requireMemberType: f.requireMemberType || 0
                };
            });
            const sources = dedupeAndSortSources(rawSources);
            // extCaptions live per-item inside list[] — read from the first item
            const subtitles = (videoList[0]?.extCaptions || []).map(c => ({
                language:     c.lanName || c.lan,
                languageCode: c.lan,
                url:          c.url,
                size:         c.size || 0,
                delay:        c.delay || 0
            }));
            // Fetch audio dubs from v3 details endpoint
            let audioTracks = [];
            try {
                const details = await v3Get("/wefeed-mobile-bff/subject-api/get", { subjectId: movieId });
                audioTracks = (details?.dubs || []).map(d => ({
                    language:     d.lanName || d.lanCode,
                    languageCode: d.lanCode || "",
                    isOriginal:   d.original || false,
                    subjectId:    d.subjectId || ""
                }));
            } catch {}
            return res.json({ status:200, success:true, creator:"DaraTech", results:sources, subtitles, audioTracks });
        }

        // ── Fallback: old h5-bff mirrors (kept as safety net) ──────────────────
        const mapSources = (files, qualityField, urlField = "url") => {
            const raw = files.map(file => {
                const label = normaliseQualityLabel(file[qualityField]);
                return { id: file.id, _qualityBase: label, quality: label, url: file[urlField] || file.url, size: file.size, format: "mp4" };
            });
            return dedupeAndSortSources(raw);
        };

        const mapAudioTracks = (tracks = []) => tracks.map(t => ({
            language: t.language || t.name || "Unknown",
            languageCode: t.languageCode || t.lang || "",
            isOriginal: t.isOriginal ?? false,
            subjectId: t.subjectId || t.id || "",
            detailPath: t.detailPath || t.path || ""
        }));

        const infoFound = await tryMirrors(
            `/wefeed-h5-bff/web/subject/detail?subjectId=${movieId}`,
            c => !!c?.subject?.detailPath
        );
        if (!infoFound) return err(res, "v3 returned no sources and could not get movie detail path");

        const movieInfo  = infoFound.content;
        const detailPath = movieInfo.subject.detailPath;
        const infoAudioTracks = mapAudioTracks(movieInfo?.subject?.audioTracks || movieInfo?.audioTracks || []);

        const fetchConfig = async (config) => {
            const params = new URLSearchParams({ subjectId: movieId, se: season, ep: episode });
            const r = await makeApiRequest(`${config.apiUrl}${params}`, {
                headers: { Referer: config.refererUrl, Origin: config.origin }
            });
            const d = await r.json();
            const c = processApiResponse(d);
            let srcs = [];
            if (config.useStreams && c?.streams) srcs = mapSources(c.streams, "resolutions");
            else if (!config.useStreams && c?.downloads) srcs = mapSources(c.downloads, "resolution");
            return { sources: srcs, captions: c?.captions || c?.subtitles || [], audioTracks: mapAudioTracks(c?.audioTracks || []) };
        };

        let sources = [], captions = [], audioTracks = [];
        const sourceMirrorUrl = `https://${infoFound.host || getNextMirror()}`;
        try {
            const r = await fetchConfig({
                refererUrl: `${sourceMirrorUrl}/spa/videoPlayPage/movies/${detailPath}?id=${movieId}&type=/movie/detail`,
                apiUrl:     `${sourceMirrorUrl}/wefeed-h5-bff/web/subject/download?`,
                origin: sourceMirrorUrl, useStreams: false
            });
            sources = r.sources; captions = r.captions;
            audioTracks = r.audioTracks.length ? r.audioTracks : infoAudioTracks;
        } catch {}

        if (sources.length === 0) {
            try {
                const r = await fetchConfig({
                    refererUrl: `https://filmboom.top/spa/videoPlayPage/movies/${detailPath}?id=${movieId}&type=/movie/detail`,
                    apiUrl:     `https://filmboom.top/wefeed-h5-bff/web/subject/play?`,
                    origin: "https://filmboom.top", useStreams: true
                });
                sources = r.sources; captions = r.captions;
                if (!audioTracks.length) audioTracks = r.audioTracks.length ? r.audioTracks : infoAudioTracks;
            } catch {}
        }

        if (sources.length === 0) return err(res, "No sources found via v3 or legacy mirrors");
        res.json({ status:200, success:true, creator:"DaraTech", usedFallback:true, results:sources, subtitles:captions, audioTracks });
    } catch (e) {
        err(res, "Failed to fetch sources: " + e.message);
    }
});

// ─── Captions ──────────────────────────────────────────────────────────────────
async function fetchCaptionsForStream(subjectId, resourceId = null) {
    // ── Primary: v3 ext-captions endpoint (no geo-block) ───────────────────────
    try {
        const params = { subjectId };
        if (resourceId) params.resourceId = resourceId;
        const v3Data = await v3Get("/wefeed-mobile-bff/subject-api/get-ext-captions", params);
        const caps = (v3Data?.extCaptions || []).map(c => ({
            language:     c.lanName || c.lan,
            languageCode: c.lan,
            url:          c.url,
            size:         c.size || 0,
            delay:        c.delay || 0
        }));
        if (caps.length > 0) return caps;
    } catch {}

    // ── Fallback: old h5-bff mirrors ────────────────────────────────────────────
    const infoFound = await tryMirrors(
        `/wefeed-h5-bff/web/subject/detail?subjectId=${subjectId}`,
        c => !!c?.subject?.detailPath
    );
    if (!infoFound) return [];
    const detailPath = infoFound.content.subject.detailPath;

    const extractCaptions = (c) => (c?.captions || c?.subtitles || []).map(sub => ({
        language:     sub.language || sub.name || "Unknown",
        languageCode: sub.languageCode || sub.lang || "",
        url:          sub.url || sub.downloadUrl || "",
        size:         sub.size || 0,
        delay:        sub.delay || 0
    }));

    const captionMirrorUrl = `https://${infoFound.host || getNextMirror()}`;
    for (const [apiUrl, refererUrl, origin] of [
        [`${captionMirrorUrl}/wefeed-h5-bff/web/subject/download?`, `${captionMirrorUrl}/spa/videoPlayPage/movies/${detailPath}?id=${subjectId}&type=/movie/detail`, captionMirrorUrl],
        [`https://filmboom.top/wefeed-h5-bff/web/subject/play?`,    `https://filmboom.top/spa/videoPlayPage/movies/${detailPath}?id=${subjectId}&type=/movie/detail`,  "https://filmboom.top"]
    ]) {
        try {
            const params = new URLSearchParams({ subjectId, se: 0, ep: 0 });
            const r = await makeApiRequest(`${apiUrl}${params}`, { headers: { Referer: refererUrl, Origin: origin } });
            const caps = extractCaptions(processApiResponse(await r.json()));
            if (caps.length > 0) return caps;
        } catch {}
    }
    return [];
}

app.get("/api/v3/captions/:subjectId/:streamId", async (req, res) => {
    try {
        const { subjectId, streamId } = req.params;
        const format = req.query.format || null;
        // streamId doubles as resourceId in the v3 ext-captions endpoint
        let captions = await fetchCaptionsForStream(subjectId, streamId || null);
        const SUBTITLE_FORMATS = ["srt", "vtt", "ass", "ssa", "sup", "sub"];
        if (format && SUBTITLE_FORMATS.includes(format.toLowerCase())) {
            captions = captions.filter(c => (c.url || "").toLowerCase().includes("." + format.toLowerCase()));
        }
        ok(res, { captions, streamId, subjectId });
    } catch (e) {
        err(res, "Failed to fetch captions: " + e.message);
    }
});


// ─── Live Channels (iptv-org) ──────────────────────────────────────────────────
const IPTV_CHANNELS_URL = "https://iptv-org.github.io/api/channels.json";
const IPTV_STREAMS_URL  = "https://iptv-org.github.io/api/streams.json";
const LIVE_CACHE_TTL_MS = 10 * 60 * 1000; // 10 min
let _liveCache = null;
let _liveCacheAt = 0;

// Verified-working supplementary streams for channels that have 0 entries in iptv-org.
// Tested server-side June 2026 — all return valid HLS manifests.
// Note: CartoonNetwork.us has NO free public stream (pay-TV). CN Arabic is the only
// publicly-accessible Cartoon Network stream available.
const SUPPLEMENTARY_STREAMS = {
    "CartoonNetworkArabic.ae": [
        { url: "https://shls-cartoon-net-prod-dub.shahid.net/out/v1/dc4aa87372374325a66be458f29eab0f/index.m3u8", httpReferrer: null, userAgent: null }
    ],
    "NickelodeonPlutoTV.us": [
        { url: "https://jmp2.uk/plu-5ca673e0d0bd6c2689c94ce3.m3u8", httpReferrer: null, userAgent: null }
    ],
    "NickelodeonTeen.fr": [
        { url: "https://jmp2.uk/plu-60f5fabf0721880007cd50e3.m3u8", httpReferrer: null, userAgent: null },
        { url: "https://jmp2.uk/plu-5f0d668b872e4400073acc68.m3u8", httpReferrer: null, userAgent: null },
        { url: "https://jmp2.uk/plu-5fab09a8749b1a00077d35d2.m3u8", httpReferrer: null, userAgent: null }
    ],
    "NickJrClub.us": [
        { url: "https://jmp2.uk/plu-6824ce95f09106f4b18f4114.m3u8", httpReferrer: null, userAgent: null },
        { url: "https://jmp2.uk/plu-67f3eb1c443f0671bc03ece8.m3u8", httpReferrer: null, userAgent: null },
        { url: "https://jmp2.uk/plu-5ddd7cb2cbb9010009b4fe32.m3u8", httpReferrer: null, userAgent: null }
    ],
    "NickJrPlutoTV.us": [
        { url: "https://jmp2.uk/plu-62bdb75c3afd1200079146a6.m3u8", httpReferrer: null, userAgent: null },
        { url: "https://jmp2.uk/plu-5ca6748a37b88b269472dad9.m3u8", httpReferrer: null, userAgent: null }
    ],
    "ToonamiAftermath.us": [
        { url: "http://api.toonamiaftermath.com:3000/est/playlist.m3u8",    httpReferrer: null, userAgent: null },
        { url: "http://api.toonamiaftermath.com:3000/movies/playlist.m3u8", httpReferrer: null, userAgent: null },
        { url: "http://api.toonamiaftermath.com:3000/radio/playlist.m3u8",  httpReferrer: null, userAgent: null }
    ],
    "Nickelodeon.fr": [
        { url: "http://151.80.18.177:86/Nickelodeon_FR/index.m3u8", httpReferrer: null, userAgent: null }
    ]
};

async function getLiveData() {
    if (_liveCache && Date.now() - _liveCacheAt < LIVE_CACHE_TTL_MS) return _liveCache;
    const [channels, streams] = await Promise.all([
        fetch(IPTV_CHANNELS_URL).then(r => r.json()),
        fetch(IPTV_STREAMS_URL).then(r => r.json())
    ]);
    // Index streams by channel id (one channel can have multiple stream URLs)
    const streamMap = {};
    for (const s of streams) {
        if (!s.channel || !s.url) continue;
        if (!streamMap[s.channel]) streamMap[s.channel] = [];
        streamMap[s.channel].push({ url: s.url, httpReferrer: s.http_referrer || null, userAgent: s.user_agent || null });
    }
    // Merge supplementary streams (prepend so verified streams are tried first)
    for (const [chId, extraStreams] of Object.entries(SUPPLEMENTARY_STREAMS)) {
        if (!streamMap[chId]) streamMap[chId] = [];
        // Prepend verified streams; avoid duplicates
        for (const s of extraStreams.reverse()) {
            if (!streamMap[chId].some(e => e.url === s.url)) {
                streamMap[chId].unshift(s);
            }
        }
    }
    _liveCache = channels
        .filter(ch => !ch.is_nsfw && !ch.closed)
        .map(ch => ({
            id: ch.id,
            name: ch.name,
            altNames: ch.alt_names || [],
            logo: ch.logo || null,
            country: ch.country || null,
            languages: ch.languages || [],
            categories: ch.categories || [],
            website: ch.website || null,
            broadcastArea: ch.broadcast_area || [],
            streams: streamMap[ch.id] || []
        }))
        .filter(ch => ch.streams.length > 0);
    _liveCacheAt = Date.now();
    return _liveCache;
}

// GET /api/v3/live — paginated channel list with optional filters
app.get("/api/v3/live", async (req, res) => {
    try {
        let channels = await getLiveData();
        const { category, country, lang, q, page = 1, limit = 50 } = req.query;
        if (q)        channels = channels.filter(c => c.name.toLowerCase().includes(q.toLowerCase()) || c.altNames.some(n => n.toLowerCase().includes(q.toLowerCase())));
        if (category) channels = channels.filter(c => c.categories.includes(category.toLowerCase()));
        if (country)  channels = channels.filter(c => (c.country || "").toLowerCase() === country.toLowerCase());
        if (lang)     channels = channels.filter(c => c.languages.includes(lang.toLowerCase()));
        const total = channels.length;
        const pageNum = Math.max(1, parseInt(page) || 1);
        const limitNum = Math.min(200, Math.max(1, parseInt(limit) || 50));
        const start = (pageNum - 1) * limitNum;
        ok(res, { total, page: pageNum, limit: limitNum, pages: Math.ceil(total / limitNum), results: channels.slice(start, start + limitNum) });
    } catch (e) { err(res, "Live channels unavailable: " + e.message); }
});

// GET /api/v3/live/categories — distinct category list
app.get("/api/v3/live/categories", async (req, res) => {
    try {
        const channels = await getLiveData();
        const catCount = {};
        for (const ch of channels) for (const cat of ch.categories) catCount[cat] = (catCount[cat] || 0) + 1;
        const categories = Object.entries(catCount).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
        ok(res, { total: categories.length, categories });
    } catch (e) { err(res, "Could not fetch categories: " + e.message); }
});

// GET /api/v3/live/search/:query — search channels by name
app.get("/api/v3/live/search/:query", async (req, res) => {
    try {
        let channels = await getLiveData();
        const q = decodeURIComponent(req.params.query).trim().toLowerCase();
        if (!q) return ok(res, { total: 0, results: [] });
        const results = channels.filter(c => c.name.toLowerCase().includes(q) || c.altNames.some(n => n.toLowerCase().includes(q))).slice(0, 100);
        ok(res, { total: results.length, query: req.params.query, results });
    } catch (e) { err(res, "Search failed: " + e.message); }
});

// GET /api/v3/live/stream/:id — single channel by exact ID
app.get("/api/v3/live/stream/:id", async (req, res) => {
    try {
        const channelId = decodeURIComponent(req.params.id).trim();
        if (!channelId) return res.status(400).json({ success: false, message: "Channel ID is required" });
        const channels = await getLiveData();
        const channel = channels.find(c => c.id === channelId);
        if (!channel) return res.status(404).json({ success: false, message: `Channel "${channelId}" not found` });
        ok(res, channel);
    } catch (e) { err(res, "Could not fetch channel: " + e.message); }
});

// GET /api/v3/live/proxy — proxy an HLS manifest through the server to bypass geo-blocks.
// The proxy rewrites all relative and absolute segment/sub-playlist URLs so every
// subsequent request also passes through this endpoint.
app.get("/api/v3/live/proxy", async (req, res) => {
    try {
        const rawUrl = req.query.url;
        if (!rawUrl) return res.status(400).json({ success: false, message: "?url= query parameter is required" });

        let targetUrl;
        try { targetUrl = new URL(rawUrl); }
        catch { return res.status(400).json({ success: false, message: "Invalid URL in ?url= parameter" }); }

        // Only allow http/https to prevent SSRF to internal resources
        if (!["http:", "https:"].includes(targetUrl.protocol)) {
            return res.status(400).json({ success: false, message: "Only http/https URLs are supported" });
        }

        const upstream = await fetch(rawUrl, {
            headers: {
                "User-Agent":  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Accept":      "*/*",
                "Origin":      targetUrl.origin,
                "Referer":     targetUrl.origin + "/"
            },
            redirect: "follow"
        });

        if (!upstream.ok) {
            return res.status(upstream.status).json({
                success: false, message: `Upstream returned HTTP ${upstream.status}`
            });
        }

        const ct = upstream.headers.get("content-type") || "";
        const body = await upstream.text();
        const isM3U = ct.includes("mpegurl") || body.includes("#EXTM3U") || rawUrl.endsWith(".m3u8") || rawUrl.endsWith(".m3u");

        res.setHeader("Access-Control-Allow-Origin", "*");

        if (isM3U) {
            // Rewrite every non-comment line so segment/sub-playlist URLs also proxy through us
            const baseUrl = rawUrl.substring(0, rawUrl.lastIndexOf("/") + 1);
            const proxyBase = `${req.protocol}://${req.get("host")}/api/v3/live/proxy?url=`;
            const rewritten = body.split("\n").map(line => {
                const t = line.trim();
                if (!t || t.startsWith("#")) return line;
                const abs = t.startsWith("http") ? t : baseUrl + t;
                return proxyBase + encodeURIComponent(abs);
            }).join("\n");
            res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
            return res.send(rewritten);
        }

        // Binary passthrough for TS segments
        const buf = Buffer.from(await (await fetch(rawUrl, { redirect: "follow" })).arrayBuffer());
        res.setHeader("Content-Type", ct || "video/mp2t");
        return res.send(buf);

    } catch (e) {
        return res.status(500).json({ success: false, message: "Proxy error: " + e.message });
    }
});

// ─── Download ──────────────────────────────────────────────────────────────────
// GET /api/v3/download?url=<encoded>&quality=360p
// Redirects the browser to the signed CDN URL so it downloads directly.
// No proxying of large video files through our server.
app.get("/api/v3/download", (req, res) => {
    const dlUrl   = req.query.url;
    const quality = req.query.quality || '';
    if (!dlUrl) return res.status(400).json({ success: false, message: "?url= parameter is required" });
    let target;
    try { target = new URL(dlUrl); } catch {
        return res.status(400).json({ success: false, message: "Invalid URL in ?url= parameter" });
    }
    if (!["http:", "https:"].includes(target.protocol)) {
        return res.status(400).json({ success: false, message: "Only http/https URLs are supported" });
    }
    // 302 redirect — browser follows it and downloads directly from CDN
    return res.redirect(302, dlUrl);
});

// ─── Stream ────────────────────────────────────────────────────────────────────
// GET /api/v3/stream?url=<encoded>
// Proxies the video through our server so the CDN's IP-signed URL is always
// fetched from the same Replit IP that generated it. Supports Range requests
// for browser seeking.
app.get("/api/v3/stream", async (req, res) => {
    const streamUrl = req.query.url;
    if (!streamUrl) return res.status(400).json({ success: false, message: "?url= parameter is required" });
    let target;
    try { target = new URL(streamUrl); } catch {
        return res.status(400).json({ success: false, message: "Invalid URL in ?url= parameter" });
    }
    if (!["http:", "https:"].includes(target.protocol)) {
        return res.status(400).json({ success: false, message: "Only http/https URLs are supported" });
    }
    try {
        const proxyHeaders = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Referer":    target.origin + "/",
            "Origin":     target.origin,
        };
        if (req.headers["range"]) proxyHeaders["Range"] = req.headers["range"];

        const upstream = await fetch(streamUrl, { headers: proxyHeaders, redirect: "follow" });
        if (!upstream.ok && upstream.status !== 206) {
            return res.status(upstream.status).json({ success: false, message: `CDN returned HTTP ${upstream.status}` });
        }

        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Content-Type",  upstream.headers.get("content-type")   || "video/mp4");
        res.setHeader("Accept-Ranges", "bytes");
        const cl = upstream.headers.get("content-length");  if (cl) res.setHeader("Content-Length", cl);
        const cr = upstream.headers.get("content-range");   if (cr) res.setHeader("Content-Range",  cr);
        res.status(upstream.status);

        // Pipe body chunk-by-chunk without buffering the whole file in memory
        const reader = upstream.body.getReader();
        const pump = async () => {
            while (true) {
                const { done, value } = await reader.read();
                if (done) { res.end(); return; }
                if (!res.write(value)) await new Promise(r => res.once("drain", r));
            }
        };
        req.on("close", () => reader.cancel());
        await pump();
    } catch (e) {
        if (!res.headersSent) res.status(500).json({ success: false, message: "Stream proxy error: " + e.message });
    }
});

// ─── ZIP builder (STORE mode, no deps) ────────────────────────────────────────
function zipCrc32(data) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) {
        c ^= data[i];
        for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (c & 1 ? 0xEDB88320 : 0);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
}
function _u16(v) { return [v & 0xFF, (v >> 8) & 0xFF]; }
function _u32(v) { return [v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF, (v >> 24) & 0xFF]; }
function buildZip(files) {
    const enc = new TextEncoder();
    const localParts = [], centralParts = [];
    let offset = 0;
    for (const { name, data } of files) {
        const nb = enc.encode(name), crc = zipCrc32(data), sz = data.length;
        const local   = new Uint8Array([0x50,0x4B,0x03,0x04,..._u16(20),..._u16(0),..._u16(0),..._u16(0),..._u16(0),..._u32(crc),..._u32(sz),..._u32(sz),..._u16(nb.length),..._u16(0),...nb]);
        const central = new Uint8Array([0x50,0x4B,0x01,0x02,..._u16(20),..._u16(20),..._u16(0),..._u16(0),..._u16(0),..._u16(0),..._u32(crc),..._u32(sz),..._u32(sz),..._u16(nb.length),..._u16(0),..._u16(0),..._u16(0),..._u16(0),..._u32(0),..._u32(offset),...nb]);
        localParts.push(local, data);
        centralParts.push(central);
        offset += local.length + sz;
    }
    const cdSz = centralParts.reduce((a,b)=>a+b.length,0);
    const eocd = new Uint8Array([0x50,0x4B,0x05,0x06,..._u16(0),..._u16(0),..._u16(files.length),..._u16(files.length),..._u32(cdSz),..._u32(offset),..._u16(0)]);
    const all = [...localParts,...centralParts,eocd];
    const total = all.reduce((a,b)=>a+b.length,0);
    const out = new Uint8Array(total); let pos=0;
    for (const p of all) { out.set(p,pos); pos+=p.length; }
    return out;
}

// ─── Manga (RosyScans) ─────────────────────────────────────────────────────────
const MANGA_SITE  = 'https://rosyscans.id';
const MANGA_PROXY = 'https://cors.caliph.my.id';
const MANGA_UA    = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36';

function mgProxied(pathOrUrl) {
    const abs = pathOrUrl.startsWith('http') ? pathOrUrl : `${MANGA_SITE}${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}`;
    return `${MANGA_PROXY}/${abs}`;
}
async function mgFetch(pathOrUrl) {
    const r = await axios.get(mgProxied(pathOrUrl), {
        headers: { 'User-Agent': MANGA_UA, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
        timeout: 15000,
        responseType: 'text',
    });
    return r.data;
}
function mgClean(v)          { return (v || '').replace(/\s+/g, ' ').trim(); }
function mgAttr(el, a)       { const v = el.attr(a); return v && v.trim() ? v.trim() : null; }
function mgImg($, el)        { const img = el.is('img') ? el : el.find('img').first(); for (const a of ['src','data-src','data-lazy-src']) { const v = img.attr(a); if (v && v.trim()) return v.trim(); } return null; }
function mgType(el, s='.limit .type') { const c = el.find(s).attr('class'); if (!c) return 'unknown'; const n = c.replace('type','').trim().toLowerCase(); return ['manga','manhwa','manhua'].includes(n) ? n : 'unknown'; }
function mgSlug(url)         { if (!url) return null; const s = url.split('/').filter(Boolean); return s.length ? s[s.length-1] : null; }
function mgInfoRow($, label) { let v = null; $('.imptdt, .infotable tr').each((_i,el) => { const row=$(el); const lbl=mgClean(row.clone().children().remove().end().text()); if (lbl.toLowerCase()!==label.toLowerCase()) return; v=mgClean(row.find('i,a,b').first().text())||null; }); return v; }

async function mgHomepage() {
    const html = await mgFetch(MANGA_SITE);
    const $ = cheerio.load(html);
    const popularToday = [];
    $('.popularslider .bsx').each((_i, el) => {
        const c = $(el);
        popularToday.push({ title: mgClean(c.find('.tt').text()), chapter: mgClean(c.find('.epxs').text())||null, url: mgAttr(c.find('a').first(),'href'), image: mgImg($,c), type: mgType(c) });
    });
    const projectUpdate = [], latestUpdates = [];
    $('.bixbox').each((_i, box) => {
        const b=$(box), sec=mgClean(b.find('.releases h2').text());
        if (sec === 'Project Update') {
            b.find('.bsx').each((_j, el) => {
                const c=$(el), chapters=[];
                c.find('.chfiv li').each((_k, ch) => { const e=$(ch); chapters.push({ chapter: mgClean(e.find('.fivchap').text()), timeUploaded: mgClean(e.find('.fivtime').text()), url: mgAttr(e.find('a').first(),'href') }); });
                projectUpdate.push({ title: mgClean(c.find('.tt a').text()), url: mgAttr(c.find('.tt a').first(),'href'), image: mgImg($,c), type: mgType(c), chapters });
            });
        }
        if (sec === 'Latest Update') {
            b.find('.uta').each((_j, el) => {
                const c=$(el), chapters=[];
                c.find('.luf ul li').each((_k, ch) => { const e=$(ch); chapters.push({ chapter: mgClean(e.find('a').text()), timeUploaded: mgClean(e.find('span').text()), url: mgAttr(e.find('a').first(),'href') }); });
                latestUpdates.push({ title: mgClean(c.find('.luf h4').text()), url: mgAttr(c.find('.luf a.series').first(),'href'), image: mgImg($,c.find('.imgu')), chapters });
            });
        }
    });
    return { popularToday, projectUpdate, latestUpdates };
}
async function mgSearch(keyword) {
    const html = await mgFetch(`${MANGA_SITE}/?s=${encodeURIComponent(keyword.trim())}`);
    const $ = cheerio.load(html);
    const results = [];
    $('.postbody .listupd .bsx').each((_i, el) => { const c=$(el); results.push({ title: mgClean(c.find('.tt').text()), url: mgAttr(c.find('a').first(),'href'), image: mgImg($,c), chapter: mgClean(c.find('.epxs').text())||null, type: mgType(c) }); });
    return results;
}
async function mgDetails(slug) {
    const mangaUrl = `${MANGA_SITE}/manga/${slug}/`;
    const html = await mgFetch(mangaUrl);
    const $ = cheerio.load(html);
    const title = mgClean($('.infox .entry-title, .postbody h1.entry-title').first().text());
    if (!title) throw new Error('Could not parse manga details');
    const synopsis = mgClean($(".entry-content[itemprop='description'] p, .entry-content p").map((_i,p)=>$(p).text()).get().join(' '))||null;
    const genres = $('.genxed a, .mgen a').map((_i,a)=>mgClean($(a).text())).get().filter(Boolean);
    const chapters = [];
    $('#chapterlist li, .eplister li, .cl li').each((_i, li) => {
        const l=$(li), link=l.find('a').first();
        const ch = mgClean(l.find('.chapternum,.lchx a').first().text()) || mgClean(link.text());
        if (!ch) return;
        chapters.push({ chapter: ch, url: (link.attr('href')||'').trim()||null, releaseDate: mgClean(l.find('.chapterdate,.dt').first().text())||null });
    });
    const related = [];
    $('.bixbox').each((_i, box) => {
        const b=$(box); if (mgClean(b.find('.releases h2').text())!=='Related Series') return;
        b.find('.bsx').each((_j, el) => { const c=$(el); related.push({ title: mgClean(c.find('.tt').text()), url: mgAttr(c.find('a').first(),'href'), image: mgImg($,c), chapter: mgClean(c.find('.epxs').text())||null, type: mgType(c) }); });
    });
    return { title, url: mangaUrl, image: mgImg($,$('.thumb img,.infoanime img').first()), synopsis, status: mgInfoRow($,'status'), author: mgInfoRow($,'author'), artist: mgInfoRow($,'artist'), type: mgType($('.infox'),'.limit .type'), genres, rating: mgClean($('.rating strong,.num,.rating .rating-prc').first().text())||null, chapters, related };
}
function mgTsReader(html) { const m = html.match(/ts_reader\.run\((\{.*?\})\);/s); if (!m) return null; try { return JSON.parse(m[1]); } catch { return null; } }
async function mgChapterImages(chapterSlug) {
    const chapterUrl = `${MANGA_SITE}/${chapterSlug}/`;
    const html = await mgFetch(chapterUrl);
    const $ = cheerio.load(html);
    const title = mgClean($('.entry-title, h1.entry-title').first().text())||null;
    let images = [];
    const payload = mgTsReader(html);
    if (payload && Array.isArray(payload.sources) && payload.sources.length) {
        const pref = payload.sources.find(s=>s.source===payload.defaultSource)||payload.sources[0];
        images = (pref && pref.images)||[];
    }
    if (!images.length) { $('#readerarea img,.reading-content img,#readerchapter img').each((_i,img)=>{ const s=mgImg($,$(img)); if(s) images.push(s); }); }
    if (!images.length) throw new Error('No page images found for this chapter');
    return { chapterUrl, title, images };
}
async function mgGenres() {
    const html = await mgFetch(MANGA_SITE);
    const $ = cheerio.load(html);
    const seen=new Set(), genres=[];
    $(".genre a,.genrez li a,a[href*='/genres/']").each((_i,el) => {
        const link=$(el), url=mgAttr(link,'href'), name=mgClean(link.text());
        if (!url||!name) return; const slug=mgSlug(url); if (!slug||seen.has(slug)) return;
        seen.add(slug); genres.push({ name, slug, url });
    });
    return genres;
}
async function mgListingPage(path, page) {
    const html = await mgFetch(`${MANGA_SITE}${path}`);
    const $ = cheerio.load(html);
    const results = [];
    $('.listupd .bsx, .bsx').each((_i, el) => { const c=$(el); results.push({ title: mgClean(c.find('.tt').text()), url: mgAttr(c.find('a').first(),'href'), image: mgImg($,c), chapter: mgClean(c.find('.epxs').text())||null, type: mgType(c) }); });
    return { page, hasNextPage: $('.hpage .r,.pagination .next,a.next.page-numbers').length>0, results };
}
const MG_STATUSES=['ongoing','completed','hiatus'], MG_TYPES=['manga','manhwa','manhua','comic','novel'], MG_ORDERS=['title','titlereverse','update','latest','popular'];
async function mgBrowse(filters={}, page=1) {
    if (filters.status && !MG_STATUSES.includes(filters.status)) throw new Error(`Invalid status. Use: ${MG_STATUSES.join(', ')}`);
    if (filters.type   && !MG_TYPES.includes(filters.type))     throw new Error(`Invalid type. Use: ${MG_TYPES.join(', ')}`);
    if (filters.order  && !MG_ORDERS.includes(filters.order))   throw new Error(`Invalid order. Use: ${MG_ORDERS.join(', ')}`);
    const params = new URLSearchParams();
    for (const s of filters.genreSlugs||[]) params.append('genre[]', s);
    if (filters.status) params.set('status', filters.status);
    if (filters.type)   params.set('type',   filters.type);
    if (filters.order)  params.set('order',  filters.order);
    const q = params.toString();
    const path = page>1 ? `/manga/page/${page}/${q?`?${q}`:''}` : `/manga/${q?`?${q}`:''}`;
    return mgListingPage(path, page);
}
function mgRes(results) { return { status: 200, success: true, creator: 'DaraTech', results }; }
function mgErr(res, e, code=502) { res.status(code).json({ status: code, success: false, creator: 'DaraTech', message: e.message||'Manga fetch failed' }); }
function mgPage(v) { const n=parseInt(v,10); return Number.isFinite(n)&&n>0?n:1; }

app.get('/api/v3/manga/home',          async (req, res) => { try { res.json(mgRes(await mgHomepage())); } catch(e) { mgErr(res, e); } });
app.get('/api/v3/manga/search',        async (req, res) => { const q=String(req.query.q||'').trim(); if (!q) return res.status(400).json({ status:400, success:false, creator:'DaraTech', message:"Query param 'q' required" }); try { res.json(mgRes(await mgSearch(q))); } catch(e) { mgErr(res, e); } });
app.get('/api/v3/manga/genres',        async (req, res) => { try { res.json(mgRes(await mgGenres())); } catch(e) { mgErr(res, e); } });
app.get('/api/v3/manga/latest',        async (req, res) => { try { res.json(mgRes(await mgListingPage(mgPage(req.query.page)>1?`/manga/page/${mgPage(req.query.page)}/?order=update`:`/manga/?order=update`, mgPage(req.query.page)))); } catch(e) { mgErr(res, e); } });
app.get('/api/v3/manga/popular',       async (req, res) => { try { res.json(mgRes(await mgListingPage(mgPage(req.query.page)>1?`/manga/page/${mgPage(req.query.page)}/?order=popular`:`/manga/?order=popular`, mgPage(req.query.page)))); } catch(e) { mgErr(res, e); } });
app.get('/api/v3/manga/genre/:slug',   async (req, res) => { const p=mgPage(req.query.page); try { res.json(mgRes(await mgListingPage(p>1?`/genres/${req.params.slug}/page/${p}/`:`/genres/${req.params.slug}/`, p))); } catch(e) { mgErr(res, e); } });
app.get('/api/v3/manga/browse',        async (req, res) => {
    const genres = req.query.genre ? (Array.isArray(req.query.genre)?req.query.genre:[req.query.genre]) : [];
    try { res.json(mgRes(await mgBrowse({ genreSlugs: genres, status: req.query.status, type: req.query.type, order: req.query.order }, mgPage(req.query.page)))); }
    catch(e) { mgErr(res, e, e.message?.startsWith('Invalid')?400:502); }
});
app.get('/api/v3/manga/details/:slug', async (req, res) => { try { res.json(mgRes(await mgDetails(req.params.slug))); } catch(e) { mgErr(res, e); } });
app.get('/api/v3/manga/chapter/:slug', async (req, res) => { try { res.json(mgRes(await mgChapterImages(req.params.slug))); } catch(e) { mgErr(res, e); } });

// Chapter single-ZIP download (must come AFTER /chapter/:slug due to Express ordering — extra segment makes it distinct)
app.get('/api/v3/manga/chapter/:slug/download', async (req, res) => {
    try {
        const { title, images } = await mgChapterImages(req.params.slug);
        if (!images.length) return mgErr(res, new Error('No pages found for this chapter'), 404);
        const capped = images.slice(0, 50);
        const fetched = await Promise.all(capped.map(async (imgUrl, i) => {
            try {
                const r = await axios.get(imgUrl, { responseType: 'arraybuffer', timeout: 15000, headers: { Referer: MANGA_SITE, 'User-Agent': MANGA_UA } });
                const ext = (imgUrl.split('.').pop()?.split('?')[0] || 'jpg').toLowerCase();
                return { name: `${String(i+1).padStart(3,'0')}.${ext}`, data: new Uint8Array(r.data) };
            } catch { return null; }
        }));
        const files = fetched.filter(Boolean);
        if (!files.length) throw new Error('Could not fetch any images for this chapter');
        const zip = buildZip(files);
        const safe = (title || req.params.slug).replace(/[^a-z0-9\-_ ]/gi,'').trim().replace(/\s+/g,'-');
        res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${safe}.zip"`, 'Content-Length': zip.length });
        res.send(Buffer.from(zip));
    } catch(e) { mgErr(res, e); }
});

// Bulk chapter range download (up to 5 chapters per request)
app.get('/api/v3/manga/download/:slug', async (req, res) => {
    try {
        const from = Math.max(1, parseInt(req.query.from || '1', 10));
        const maxTo = from + 4;
        const to   = Math.min(maxTo, parseInt(req.query.to || String(maxTo), 10));
        const { title: mangaTitle, chapters } = await mgDetails(req.params.slug);
        if (!chapters.length) throw new Error('No chapters found for this manga');
        const ascending = [...chapters].reverse();
        const selected = ascending.slice(from - 1, to);
        if (!selected.length) throw new Error(`No chapters in range ${from}–${to}`);
        const zipFiles = [];
        for (const [ci, ch] of selected.entries()) {
            const chSlug = ch.url ? ch.url.split('/').filter(Boolean).pop() : null;
            if (!chSlug) continue;
            try {
                const { images } = await mgChapterImages(chSlug);
                const fetched = await Promise.all(images.slice(0,30).map(async (imgUrl, i) => {
                    try {
                        const r = await axios.get(imgUrl, { responseType: 'arraybuffer', timeout: 15000, headers: { Referer: MANGA_SITE, 'User-Agent': MANGA_UA } });
                        const ext = (imgUrl.split('.').pop()?.split('?')[0]||'jpg').toLowerCase();
                        return { name:`chapter-${String(from+ci).padStart(3,'0')}/${String(i+1).padStart(3,'0')}.${ext}`, data: new Uint8Array(r.data) };
                    } catch { return null; }
                }));
                zipFiles.push(...fetched.filter(Boolean));
            } catch { /* skip failed chapter */ }
        }
        if (!zipFiles.length) throw new Error('Could not fetch any chapter images');
        const zip = buildZip(zipFiles);
        const safe = (mangaTitle || req.params.slug).replace(/[^a-z0-9\-_ ]/gi,'').trim().replace(/\s+/g,'-');
        res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${safe}-chapters-${from}-to-${to}.zip"`, 'Content-Length': zip.length });
        res.send(Buffer.from(zip));
    } catch(e) { mgErr(res, e); }
});

// ─── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`\n✅ RUNFLIX Movie API — Local Dev Server`);
    console.log(`   Running on http://localhost:${PORT}`);
    console.log(`   Mirrors: ${MIRROR_HOSTS.length} hosts (rotating per-request)`);
    console.log(`   IP pool: ${IP_POOL.length} X-Forwarded-For addresses (random per-request)`);
    console.log(`   Proxies: ${proxyRotator.size > 0 ? `${proxyRotator.size} loaded (PROXY_LIST)` : "none — set PROXY_LIST to enable"}`);
    console.log(`   CORS: enabled (any origin — website-ready)\n`);
    console.log(`   ── Static ──────────────────────────────────────────────`);
    console.log(`   GET /                              → Landing page`);
    console.log(`   GET /docs                          → API docs`);
    console.log(`   GET /debug/pool                    → Pool inspector`);
    console.log(`   GET /debug/logs                    → Request log (last 200 API calls)`);
    console.log(`   GET /debug/logs-view               → Live log viewer UI`);
    console.log(`\n   ── Sample data ─────────────────────────────────────────`);
    console.log(`   GET /sample-{homepage|trending|search|info|sources|captions}-data`);
    console.log(`\n   ── Core API ─────────────────────────────────────────────`);
    console.log(`   GET /api/v3/homepage               → Homepage sections (v3 tab-operating)`);
    console.log(`   GET /api/v3/trending               → Trending (all types)`);
    console.log(`   GET /api/v3/trending?type=1        → Trending movies only`);
    console.log(`   GET /api/v3/trending?type=2        → Trending series only`);
    console.log(`   GET /api/v3/search/:query          → Keyword search`);
    console.log(`   GET /api/v3/filter?platform=...    → Filter by platform/genre/region`);
    console.log(`   GET /api/v3/schedule               → Anime airing schedule (Jikan/MAL)`);
    console.log(`   GET /api/v3/schedule?genre=action  → Schedule filtered by genre`);
    console.log(`   GET /api/v3/schedule/popular       → Top airing anime by MAL score`);
    console.log(`   GET /api/v3/schedule/popular?type=movie → Top airing movies`);
    console.log(`   GET /api/v3/anime                  → Anime catalog (series + movies)`);
    console.log(`   GET /api/v3/anime?type=1           → Anime movies only`);
    console.log(`   GET /api/v3/anime?type=2           → Anime series only`);
    console.log(`   GET /api/v3/anime/search/:query    → Anime-only keyword search`);
    console.log(`   GET /api/v3/anime/info/:id         → Anime info (validates anime genre)`);
    console.log(`   GET /api/v3/anime/sources/:id      → Anime sources (validates anime genre)`);
    console.log(`   GET /api/v3/seasons/upcoming       → Upcoming anime season lineup`);
    console.log(`   GET /api/v3/info/:id               → Full title info`);
    console.log(`   GET /api/v3/sources/:id            → Stream/download links`);
    console.log(`   GET /api/v3/sources/:id?season=1&episode=3 → Episode sources`);
    console.log(`   GET /api/v3/captions/:sid/:strmId  → Subtitle tracks\n`);
});
