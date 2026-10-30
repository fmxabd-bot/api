// Cloudflare Worker for MovieBox API with full streaming support and resumable downloads, does not rely on official moviebox known direct db(h5.aoneroom.com) api host
import * as cheerio from 'cheerio';

// Allowed origins - only these will be allowed
const ALLOWED_ORIGINS = [
    "https://runflix.name.ng",
    "https://*.runconnect.name.ng",
    "https://*.runflix.name.ng",
    "https://movieapi.runflix.name.ng",
    // Development — Replit preview domains for internal relay & testing
    "https://*.replit.dev",
    "https://*.repl.co",
    // CF Worker's own domain — allows server-side relay calls (no Origin header)
    // checkOrigin() matches request hostname against this list when Origin is absent
    "https://*.workers.dev",
];

// Changelog fallback — used when KV is empty so changelog always shows on production
const CHANGELOG_FALLBACK = [{"id":"cl_017","version":"v1.6.1","date":"2026-07-23","type":"improvement","title":"Manga chain map, endpoint badge, and integration steps updated","description":"Documentation completeness pass after manga launch: overview stats badge corrected, integration chain map updated with a Manga row, and quick integration steps expanded.","changes":["Overview stats badge updated from 15 \u2192 26 Endpoints","Integration chain map: Manga row added (Home \u2192 Search / Browse \u2192 Details \u2192 Chapter \u2192 Download, fuchsia theme)","Quick integration steps header updated from 15 \u2192 20 steps","All nav dropdowns and mobile nav include Manga link"]},{"id":"cl_016","version":"v1.6.0","date":"2026-07-23","type":"feature","title":"Manga API \u2014 RosyScans scraper with ZIP download support","description":"11 new manga endpoints backed by the RosyScans source. Supports browsing, searching by genre, reading chapter image URLs, and downloading chapters or chapter ranges as ZIP archives \u2014 no external dependencies, pure-JS ZIP builder.","changes":["GET /api/v3/manga/home \u2014 homepage listings","GET /api/v3/manga/search?q= \u2014 keyword search","GET /api/v3/manga/genres \u2014 available genre list","GET /api/v3/manga/popular?page= \u2014 popular manga paginated","GET /api/v3/manga/latest?page= \u2014 latest updates paginated","GET /api/v3/manga/genre/:slug?page= \u2014 browse by genre","GET /api/v3/manga/browse \u2014 filtered browse (type, status, genre, order, page)","GET /api/v3/manga/details/:slug \u2014 title metadata + chapter list","GET /api/v3/manga/chapter/:slug \u2014 chapter page image URLs","GET /api/v3/manga/chapter/:slug/download \u2014 single chapter as ZIP (max 30 pages CF / 50 local)","GET /api/v3/manga/download/:slug?from=&to= \u2014 chapter-range ZIP with subfolders (max 3 chapters CF / 5 local)","Pure-JS ZIP builder (CRC-32 + STORE mode) \u2014 no external dependency","6 sample JSON files added","Full manga section added to /docs","Endpoint count updated 15 \u2192 26"]},{"id":"cl_014","version":"v1.5.3","date":"2026-06-20","type":"fix","title":"Live TV \u2014 full 9000+ channel load, instant stream playback, export report","description":"Three fixes for the Live Channel Tester: rate limit raised so all channels load, channel clicks now play instantly using already-loaded stream data, and a CSV export button lets you download the full test report.","changes":["Rate limit raised from 60 to 300 req/min so all 9000+ channels load without being blocked","Channel clicks now use streams embedded in the loaded list \u2014 no extra API call, no rate-limit impact","Export Report button downloads a CSV with ID, name, country, categories, languages, status, stream count, and first stream URL","Page fetch limit raised from 50 to 200 channels per request \u2014 only ~47 pages needed for the full list"]},{"id":"cl_013","version":"v1.5.2","date":"2026-06-19","type":"feature","title":"Live TV stream by ID \u2014 single-channel lookup endpoint","description":"New endpoint to fetch a single live TV channel and its stream URLs by channel ID. Ideal for just-in-time player integrations that load only the selected channel.","changes":["GET /api/v3/live/stream/:id \u2014 returns one channel with its HLS streams by exact channel ID","Sample data available at /sample-live-stream-data","Endpoint count updated to 15","Docs updated with new sub-route, cURL / JS examples, and Quick Integration step 12"]},{"id":"cl_012","version":"v1.5.1","date":"2026-06-19","type":"improvement","title":"Documentation overhaul \u2014 Live TV section and endpoint count","description":"Full documentation pass: Live TV channels documented with parameter table, cURL/JS examples, and inline sample response. Endpoint count updated.","changes":["Live TV endpoint section added to /docs with sub-routes, parameter table, and code tabs","Live TV added to docs sidebar and navigation","Node.js and Python quick integration examples updated with Live TV functions","Endpoint count updated across index and docs"]},{"id":"cl_011","version":"v1.5.0","date":"2026-06-19","type":"feature","title":"Live TV channels API \u2014 8,000+ global channels with HLS streams","description":"Three new live TV endpoints added. Returns channels with active HLS streams, filtered to exclude NSFW and closed entries. Channels include Nickelodeon, Disney Junior, Al Jazeera, BBC World News, Yoruba TV, and thousands more across 200+ countries.","changes":["GET /api/v3/live \u2014 paginated channel list; filters: ?category, ?country, ?lang, ?q, ?page, ?limit","GET /api/v3/live/categories \u2014 category slugs with channel counts (general, news, kids, sports\u2026)","GET /api/v3/live/search/:query \u2014 search channels by name, up to 100 results","Each channel includes id, name, logo, country, languages, categories, and HLS stream URLs"]},{"id":"cl_010","version":"v1.4.0","date":"2026-06-18","type":"feature","title":"Public changelog page","description":"A public changelog is now live, showing all API updates in a filterable timeline.","changes":["New public page at /changelog \u2014 dark timeline UI with type filter buttons","GET /api/changelog \u2014 public feed (no API key required)","Changelog link added to main navigation"]},{"id":"cl_008","version":"v1.3.0","date":"2026-06-18","type":"fix","title":"Episode count now uses real per-season data","description":"Series info responses now return accurate total episode counts derived from per-season data.","changes":["totalEpisodes now sums actual per-season episode counts","seasonDetails array added to series info responses","Fix applied to /api/v3/info/:id and /api/v3/anime/info/:id"]},{"id":"cl_007","version":"v1.3.0","date":"2026-06-18","type":"fix","title":"Video blank / audio-only bug \u2014 HEVC sources now flagged","description":"Sources now expose a browserCompatible field so consumers can detect HEVC/H.265 encoded files that Chrome and Firefox cannot play.","changes":["All source objects now include browserCompatible: false for HEVC/H.265 codecs","Affected codec identifiers: hevc, h265, hvc1, hev1","Use an HLS proxy or transcoder for browser-compatible playback"]},{"id":"cl_006","version":"v1.2.1","date":"2026-06-12","type":"improvement","title":"Captions endpoint \u2014 multi-format filtering","description":"The /api/v3/captions endpoint now supports a format query parameter so consumers can request only SRT, VTT, ASS, or other specific subtitle formats.","changes":["Added ?format=srt / ?format=vtt / ?format=ass query parameter support","Supported formats: srt, vtt, ass, ssa, sup, sub","Unrecognised format values return all tracks (safe fallback)"]},{"id":"cl_005","version":"v1.2.0","date":"2026-06-10","type":"feature","title":"Anime-specific endpoints with genre validation","description":"Dedicated anime routes added across search, info, and sources. Each endpoint validates that the returned title is actually an anime genre before responding.","changes":["GET /api/v3/anime \u2014 paginated anime catalog (series + movies)","GET /api/v3/anime/search/:query \u2014 keyword search filtered to anime genre","GET /api/v3/anime/info/:id \u2014 full info with anime genre validation","GET /api/v3/anime/sources/:id \u2014 episode sources with genre validation","GET /api/v3/seasons/upcoming \u2014 upcoming anime season lineup from AniList/MAL"]},{"id":"cl_004","version":"v1.2.0","date":"2026-06-10","type":"feature","title":"Anime schedule endpoints (Jikan / MAL)","description":"Anime airing schedule routes added using the Jikan API. Returns currently airing anime with episode air dates, sorted by MAL score.","changes":["GET /api/v3/schedule \u2014 weekly airing schedule grouped by day","GET /api/v3/schedule/popular \u2014 top airing anime ranked by MAL score","Responses include MAL score, episode count, genres, and thumbnail"]},{"id":"cl_003","version":"v1.1.1","date":"2026-06-01","type":"improvement","title":"Source normalisation \u2014 quality labels + audio tracks","description":"Source responses now include consistent quality labels, language tags, and audio track information across all endpoints.","changes":["quality field normalised to 1080p / 720p / 480p / 360p labels","audioTracks array exposed from upstream dub data","runtimeMinutes derived from durationSeconds when not already present"]},{"id":"cl_002","version":"v1.1.0","date":"2026-05-20","type":"feature","title":"Cloudflare Worker relay + v3 signed requests","description":"Added a Cloudflare Worker relay layer to bypass upstream geo-blocking.","changes":["CF Worker relay deployed \u2014 routes geo-blocked requests through Cloudflare edge","V3 request signing implemented for relay authentication","Improved resilience via mirror host rotation"]},{"id":"cl_001","version":"v1.0.0","date":"2026-05-01","type":"feature","title":"Initial API release","description":"RUNFLIX Movie API launched with core endpoints for homepage, trending, search, filter, info, sources, and captions.","changes":["GET /api/v3/homepage \u2014 homepage sections by tab","GET /api/v3/trending \u2014 trending movies and series","GET /api/v3/search/:query \u2014 keyword search","GET /api/v3/filter \u2014 filter by platform, genre, region","GET /api/v3/info/:id \u2014 full title metadata","GET /api/v3/sources/:id \u2014 stream and download links with quality labels","GET /api/v3/captions/:sid/:streamId \u2014 subtitle tracks","API key authentication \u2014 Bearer token required on all endpoints","Documentation at /docs, interactive try at /try"]}];

// API Keys mapped to their authorized domains
// Each key only works from its registered domain - prevents stolen key abuse
const API_KEY_MAP = {
    "runflix_.....": { owner: "DaraTech", domains: ["runflix.name.ng"] },
    // Internal relay key — used by the Replit local server to proxy geo-blocked endpoints
    // through the CF Worker edge IPs. Works from server-side (no Origin) and *.workers.dev,
    // *.replit.dev origins. Rotate this key if compromised.
    "runflix_relay_dev_key_2025": { owner: "relay-internal", domains: [] },
};

// Keep a flat list for backward-compatible key existence checks
const API_KEYS = Object.keys(API_KEY_MAP);

// In-memory cache for KV key lookups (30s TTL per isolate — reduces KV reads)
const kvKeyCache = new Map();
const KV_CACHE_TTL_MS = 30_000;

// Blocked patterns
const BLOCKED_PATTERNS = [
    /localhost/i,
    /127\.0\.0\.1/i,
    /0\.0\.0\.0/i,
    /\.vercel\.app$/i,
    /\.onrender\.com$/i,
    /\.koyeb\.app$/i,
    /\.railway\.app$/i,
    /\.railway\.com$/i,
    /^(\d{1,3}\.){3}\d{1,3}(:\d+)?$/i, // IP addresses with or without ports
    /^\[?[0-9a-fA-F:]+\]?(:\d+)?$/i, // IPv6 addresses
    /^\d+\.\d+\.\d+\.\d+$/i // Simple IP pattern
];

const MIRROR_HOSTS = [
    "h5-api.aoneroom.com",
    "fmoviesunblocked.net",
    "netnaija.film",
    "filmboom.top"
];

// ─── IP rotation pool ──────────────────────────────────────────────────────────
// Rotated per-request via X-Forwarded-For / X-Real-IP to vary the apparent
// source IP seen by upstream mirrors, reducing per-IP rate-limit exposure.
const IP_POOL = [
    "1.1.1.1",         "1.0.0.1",
    "8.8.8.8",         "8.8.4.4",
    "9.9.9.9",         "149.112.112.112",
    "208.67.222.222",  "208.67.220.220",
    "185.228.168.9",   "185.228.169.9",
    "176.103.130.130", "176.103.130.131",
    "94.140.14.14",    "94.140.15.15",
    "77.88.8.1",       "77.88.8.8",
    "195.46.39.39",    "195.46.39.40",
    "216.146.35.35",   "216.146.36.36",
    "45.90.28.0",      "45.90.30.0"
];

function getRandomIp() {
    return IP_POOL[Math.floor(Math.random() * IP_POOL.length)];
}

function getRandomHost() {
    return MIRROR_HOSTS[Math.floor(Math.random() * MIRROR_HOSTS.length)];
}

// Single host kept for reference; actual requests use getRandomHost() per call
const SELECTED_HOST = getRandomHost();
const HOST_URL = `https://${SELECTED_HOST}`;

// Base headers — Host, Referer, and IP headers are overridden per-request
const DEFAULT_HEADERS = {
    'X-Client-Info': '{"timezone":"Africa/Nairobi"}',
    'Accept-Language': 'en-US,en;q=0.5',
    'Accept': 'application/json',
    'User-Agent': 'okhttp/4.12.0',
    'Connection': 'keep-alive'
};

const SubjectType = {
    ALL: 0,
    MOVIES: 1,
    TV_SERIES: 2,
    MUSIC: 6
};

// ─── Platform / section filter map ────────────────────────────────────────────
const PLATFORM_MAP = {
    netflix:    { label: "Netflix",       mode: "search",  keyword: "Netflix" },
    prime:      { label: "Amazon Prime",  mode: "search",  keyword: "Amazon Prime" },
    apple:      { label: "Apple TV+",     mode: "search",  keyword: "Apple TV" },
    disney:     { label: "Disney+",       mode: "search",  keyword: "Disney" },
    hbo:        { label: "HBO Max",       mode: "search",  keyword: "HBO" },
    hulu:       { label: "Hulu",          mode: "search",  keyword: "Hulu" },
    paramount:  { label: "Paramount+",   mode: "search",  keyword: "Paramount" },
    peacock:    { label: "Peacock",       mode: "search",  keyword: "Peacock" },
    bollywood:  { label: "Bollywood",    mode: "section", keyword: "bollywood" },
    south:      { label: "South Indian", mode: "section", keyword: "south indian" },
    hollywood:  { label: "Hollywood",    mode: "section", keyword: "hollywood" },
    asian:      { label: "Asian",        mode: "section", keyword: "asian" },
    anime:      { label: "Anime",        mode: "search",  keyword: "Anime" },
    kdrama:     { label: "K-Drama",      mode: "search",  keyword: "Korean drama" },
    trending:   { label: "Trending",     mode: "section", keyword: "trending" },
    cinema:     { label: "Cinema",       mode: "section", keyword: "cinema" },
};

// ─── Jikan (MAL) anime schedule ────────────────────────────────────────────────
// Jikan is a public MAL REST API — no auth, no IP blocks, CF Worker compatible.
// Schedule endpoint: GET https://api.jikan.moe/v4/schedules?page=N
// Returns all currently airing anime with broadcast.day (e.g. "Mondays").

const JIKAN_DAY_MAP = {
    mondays: 1, tuesdays: 2, wednesdays: 3, thursdays: 4,
    fridays: 5, saturdays: 6, sundays: 0
};

async function fetchJikanSchedule(page = 1) {
    const res = await fetch(`https://api.jikan.moe/v4/schedules?page=${page}`, {
        headers: { 'Accept': 'application/json' }
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
        description:   (item.synopsis || '').slice(0, 300),
        url:           item.url,
        broadcastDay:  item.broadcast?.day || null,
        broadcastTime: item.broadcast?.time || null,
        airingDate:    date || null,
        source:        'jikan'
    };
}

// ─── CF Cache API helper ────────────────────────────────────────────────────────
// Wraps a response-producing fn with Cloudflare edge caching.
// ttl is in seconds; 0 = no cache.
async function withCache(cacheKey, ttl, fn) {
    if (!ttl) return fn();
    const cache = caches.default;
    const cacheUrl = `https://runflix.cache.internal/${encodeURIComponent(cacheKey)}`;
    const cacheReq = new Request(cacheUrl);
    try {
        const hit = await cache.match(cacheReq);
        if (hit) {
            const headers = new Headers(hit.headers);
            headers.set('X-Cache', 'HIT');
            return new Response(hit.body, { status: hit.status, headers });
        }
    } catch {}
    const response = await fn();
    // Only cache successful responses — never persist errors to the edge cache.
    try {
        if (response.status === 200) {
            const clone = response.clone();
            const headers = new Headers(clone.headers);
            headers.set('Cache-Control', `public, max-age=${ttl}`);
            headers.set('X-Cache', 'MISS');
            await cache.put(cacheReq, new Response(clone.body, { status: clone.status, headers }));
        }
    } catch {}
    return response;
}

// ─── Request log buffer (isolate-scoped — resets on cold start) ───────────────
const MAX_REQUEST_LOGS = 200;
const requestLog = [];

// ─── Pure-JS MD5 (Web Crypto lacks MD5 — needed for v3 HMAC-MD5 signing) ──────
function _md5(bytes) {
    function add(a,b){return(a+b)|0;}
    function rol(n,s){return n<<s|n>>>32-s;}
    const orig = bytes.length * 8;
    const buf = [...bytes, 0x80];
    while ((buf.length + 8) % 64 !== 0) buf.push(0);
    buf.push(orig&255,(orig>>8)&255,(orig>>16)&255,(orig>>24)&255,0,0,0,0);
    let h0=0x67452301,h1=0xEFCDAB89,h2=0x98BADCFE,h3=0x10325476;
    const K=[0xd76aa478,0xe8c7b756,0x242070db,0xc1bdceee,0xf57c0faf,0x4787c62a,0xa8304613,0xfd469501,
             0x698098d8,0x8b44f7af,0xffff5bb1,0x895cd7be,0x6b901122,0xfd987193,0xa679438e,0x49b40821,
             0xf61e2562,0xc040b340,0x265e5a51,0xe9b6c7aa,0xd62f105d,0x02441453,0xd8a1e681,0xe7d3fbc8,
             0x21e1cde6,0xc33707d6,0xf4d50d87,0x455a14ed,0xa9e3e905,0xfcefa3f8,0x676f02d9,0x8d2a4c8a,
             0xfffa3942,0x8771f681,0x6d9d6122,0xfde5380c,0xa4beea44,0x4bdecfa9,0xf6bb4b60,0xbebfbc70,
             0x289b7ec6,0xeaa127fa,0xd4ef3085,0x04881d05,0xd9d4d039,0xe6db99e5,0x1fa27cf8,0xc4ac5665,
             0xf4292244,0x432aff97,0xab9423a7,0xfc93a039,0x655b59c3,0x8f0ccc92,0xffeff47d,0x85845dd1,
             0x6fa87e4f,0xfe2ce6e0,0xa3014314,0x4e0811a1,0xf7537e82,0xbd3af235,0x2ad7d2bb,0xeb86d391];
    const S=[7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,
             5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,
             4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,
             6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
    for (let i=0;i<buf.length;i+=64) {
        const M=Array.from({length:16},(_,j)=>buf[i+4*j]|buf[i+4*j+1]<<8|buf[i+4*j+2]<<16|buf[i+4*j+3]<<24);
        let a=h0,b=h1,c=h2,d=h3;
        for (let j=0;j<64;j++) {
            let F,g;
            if      (j<16){F=b&c|~b&d;g=j;}
            else if (j<32){F=d&b|~d&c;g=(5*j+1)%16;}
            else if (j<48){F=b^c^d;   g=(3*j+5)%16;}
            else          {F=c^(b|~d);g=7*j%16;}
            const tmp=d;d=c;c=b;
            b=add(rol(add(add(a,F),add(M[g],K[j])),S[j]),b);
            a=tmp;
        }
        h0=add(h0,a);h1=add(h1,b);h2=add(h2,c);h3=add(h3,d);
    }
    const le=v=>[v&255,v>>8&255,v>>16&255,v>>24&255];
    return [...le(h0),...le(h1),...le(h2),...le(h3)];
}
function md5Hex(input) {
    const bytes = typeof input==='string'
        ? [...new TextEncoder().encode(input)]
        : (ArrayBuffer.isView(input) ? [...new Uint8Array(input.buffer)] : [...input]);
    return _md5(bytes).map(b=>b.toString(16).padStart(2,'0')).join('');
}
function hmacMd5B64(keyBytes, msgStr) {
    const BLOCK=64;
    let key = keyBytes.length>BLOCK ? _md5(keyBytes) : [...keyBytes];
    while (key.length<BLOCK) key.push(0);
    const ipad=key.map(b=>b^0x36), opad=key.map(b=>b^0x5c);
    const msg=[...new TextEncoder().encode(msgStr)];
    return btoa(String.fromCharCode(..._md5([...opad,..._md5([...ipad,...msg])])));
}

// ─── V3 API (api6.aoneroom.com) — signed requests ─────────────────────────────
const V3_SECRET_BYTES     = [...atob("76iRl07s0xSN9jqmEWAt79EBJZulIQIsV64FZr2O")].map(c=>c.charCodeAt(0));
const V3_SECRET_ALT_BYTES = [...atob("Xqn2nnO41/L92o1iuXhSLHTbXvY4Z5ZZ62m8mSLA")].map(c=>c.charCodeAt(0));
const V3_SIG_BODY_MAX = 102400;
const V3_RETRY = new Set([403,407,429,500,502,503,504]);
const V3_HOSTS = [
    "https://api6.aoneroom.com","https://api5.aoneroom.com",
    "https://api4.aoneroom.com","https://api4sg.aoneroom.com",
    "https://api3.aoneroom.com","https://api6sg.aoneroom.com",
    "https://api.inmoviebox.com"
];

// Random Android fingerprint so each isolate looks like a distinct device
const _v3DevId   = Array.from({length:16},()=>Math.floor(Math.random()*16).toString(16)).join('');
const _v3Gaid    = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{const r=Math.random()*16|0;return(c==='x'?r:r&3|8).toString(16);});
// let so v3EnsureToken can override with the identity stored in KV (bootstrapped
// by the local server on Replit IPs, which the upstream binds the token to).
let V3_UA  = 'com.community.oneroom/50020042 (Linux; U; Android 11; en_US; 23078RKD5C; Build/RP1A.200720.011; Cronet/135.0.7012.3)';
let V3_CI  = JSON.stringify({package_name:'com.community.oneroom',version_name:'3.0.03.0529.03',version_code:50020042,os:'android',os_version:'11',install_ch:'ps',device_id:_v3DevId,install_store:'ps',gaid:_v3Gaid,brand:'Redmi',model:'23078RKD5C',system_language:'en',net:'NETWORK_WIFI',region:'US',timezone:'Asia/Kolkata',sp_code:'40401','X-Play-Mode':'2'});
let v3RuntimeToken = null;
let _v3InitPromise  = null;
// Set per-request in the main fetch handler so v3EnsureToken can access KV.
let _workerEnv = null;

// ─── Token bootstrap ───────────────────────────────────────────────────────────
// The upstream API now returns HTTP 441 "miss token" on all endpoints except the
// homepage. Call tab-operating first (no auth required) to grab the x-user JWT,
// then use it as Bearer on every subsequent request.
// CF Worker IPs may be blocked from tab-operating GET — so we read the token
// from KV first (written by the local server which runs on Replit IPs).
async function v3EnsureToken() {
    if (v3RuntimeToken) return;
    if (!_v3InitPromise) {
        _v3InitPromise = (async () => {
            // 1. Try KV first — local server writes { token, ua, ci } after bootstrapping.
            //    The upstream binds the token to the device identity used at bootstrap time,
            //    so we must use the SAME ua/ci that the local server used.
            if (_workerEnv?.KV_STORE) {
                try {
                    const stored = await _workerEnv.KV_STORE.get('v3_identity', { type: 'json' });
                    if (stored?.token) {
                        v3RuntimeToken = stored.token;
                        if (stored.ua) V3_UA = stored.ua;
                        if (stored.ci) V3_CI = stored.ci;
                        return;
                    }
                } catch {}
            }
            // 2. Fall back to tab-operating (works when CF IPs are not geo-restricted)
            for (const base of V3_HOSTS) {
                const url = `${base}/wefeed-mobile-bff/tab-operating?page=1&tabId=0&version=`;
                try {
                    const res   = await fetch(url, { method: 'GET', headers: v3Headers('GET', url) });
                    const xUser = res.headers.get('x-user');
                    if (xUser) {
                        try { const p = JSON.parse(xUser); if (p.token) v3RuntimeToken = p.token; } catch {}
                    }
                    if (v3RuntimeToken) break;
                } catch {}
            }
            // 3. Store identity in KV so future cold starts use the same device fingerprint
            if (v3RuntimeToken && _workerEnv?.KV_STORE) {
                try {
                    await _workerEnv.KV_STORE.put('v3_identity', JSON.stringify({ token: v3RuntimeToken, ua: V3_UA, ci: V3_CI }), { expirationTtl: 3600 });
                } catch {}
            }
        })();
    }
    await _v3InitPromise;
}

function v3ClientToken(ts) {
    return `${ts},${md5Hex(String(ts).split('').reverse().join(''))}`;
}
function v3SortedQS(urlStr) {
    const u = new URL(urlStr);
    return [...u.searchParams.entries()].sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0).map(([k,v])=>`${k}=${v}`).join('&');
}
function v3Sig(method, urlStr, bodyStr, ts, useAltKey=false) {
    const accept = 'application/json';
    const ct = bodyStr ? 'application/json; charset=utf-8' : 'application/json';
    const u = new URL(urlStr);
    const qs = v3SortedQS(urlStr);
    const cu = qs ? `${u.pathname}?${qs}` : u.pathname;
    let bh='', bl='';
    if (bodyStr != null) {
        const enc = new TextEncoder().encode(bodyStr);
        bh = md5Hex(enc.subarray(0, V3_SIG_BODY_MAX));
        bl = String(enc.length);
    }
    const canonical = [method.toUpperCase(), accept, ct, bl, String(ts), bh, cu].join('\n');
    return `${ts}|2|${hmacMd5B64(useAltKey ? V3_SECRET_ALT_BYTES : V3_SECRET_BYTES, canonical)}`;
}
function v3Headers(method, urlStr, bodyStr=null, useAltKey=false) {
    const ts = Date.now();
    const ct = bodyStr ? 'application/json; charset=utf-8' : 'application/json';
    const h = {
        'User-Agent': V3_UA,
        'Accept': 'application/json',
        'Content-Type': ct,
        'Connection': 'keep-alive',
        'X-Client-Token': v3ClientToken(ts),
        'x-tr-signature': v3Sig(method, urlStr, bodyStr, ts, useAltKey),
        'X-Client-Info': V3_CI,
        'X-Client-Status': '0'
    };
    if (v3RuntimeToken) h['Authorization'] = `Bearer ${v3RuntimeToken}`;
    return h;
}
async function v3Fetch(method, pathAndQuery, bodyStr=null) {
    // Legacy routes call their configured upstream directly. Current MovieBox
    // catalog and media requests are handled by MovieAPI's Railway relay.
    await v3EnsureToken();
    let lastErr;
    for (const base of V3_HOSTS) {
        const url = `${base}${pathAndQuery}`;
        try {
            let res = await fetch(url, { method, headers: v3Headers(method, url, bodyStr), body: bodyStr || undefined });
            const xUser = res.headers.get('x-user');
            if (xUser) {
                try {
                    const p = JSON.parse(xUser);
                    if (p.token) {
                        v3RuntimeToken = p.token;
                        // Persist refreshed token to KV for future cold starts
                        if (_workerEnv?.KV_STORE) {
                            _workerEnv.KV_STORE.put('v3_runtime_token', v3RuntimeToken, { expirationTtl: 3600 }).catch(() => {});
                        }
                    }
                } catch {}
            }

            // JWT expired → clear token, re-bootstrap, retry this host once
            if (res.status === 401) {
                v3RuntimeToken = null; _v3InitPromise = null;
                await v3EnsureToken();
                res = await fetch(url, { method, headers: v3Headers(method, url, bodyStr), body: bodyStr || undefined });
                // Signing rejected even with fresh token → try ALT secret key
                if (res.status === 401 || res.status === 403) {
                    res = await fetch(url, { method, headers: v3Headers(method, url, bodyStr, true), body: bodyStr || undefined });
                }
            }

            if (!V3_RETRY.has(res.status)) return res;
            lastErr = new Error(`HTTP ${res.status} from ${base}`);
        } catch(e) { lastErr = e; }
    }
    throw lastErr || new Error('All v3 hosts exhausted');
}
async function v3Get(path, params={}) {
    const qs = new URLSearchParams(params);
    const pq = Object.keys(params).length ? `${path}?${qs}` : path;
    const res = await v3Fetch('GET', pq);
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json') && !ct.includes('text/json')) {
        // Upstream returned non-JSON (HTML error page, redirect, etc.)
        const preview = await res.text().then(t => t.slice(0, 120)).catch(() => '');
        throw new Error(`Upstream returned non-JSON (${res.status}): ${preview.replace(/\s+/g,' ')}`);
    }
    const json = await res.json();
    if (json.code !== undefined && json.code !== 0 && json.code !== 200) throw new Error(`v3: ${json.msg||json.code}`);
    return json.data;
}
async function v3Post(path, body) {
    const bodyStr = JSON.stringify(body);
    const res = await v3Fetch('POST', path, bodyStr);
    const json = await res.json();
    if (json.code !== undefined && json.code !== 0 && json.code !== 200) throw new Error(`v3: ${json.msg||json.code}`);
    return json.data;
}
// Returns true for codecs that browsers can decode natively (H.264/AVC).
// HEVC/H.265 MP4 is not supported by Chrome or Firefox — video track is silently
// skipped while audio (AAC) still plays, giving the appearance of audio-only.
function isBrowserCompatibleCodec(codecName) {
    if (!codecName) return true;
    const c = codecName.toLowerCase();
    if (c.includes('hevc') || c.includes('h265') || c === 'hvc1' || c === 'hev1') return false;
    return true;
}

function normaliseItemW(item) {
    const out = {...item};
    if (item.cover?.url)  out.thumbnail = item.cover.url;
    if (item.stills?.url && !out.thumbnail) out.thumbnail = item.stills.url;
    const rawRating = item.imdbRatingValue ?? item.imdbRate ?? null;
    if (rawRating != null) out.rating = parseFloat(rawRating) || null;
    if (item.releaseDate)   out.year = parseInt(String(item.releaseDate)) || null;
    if (item.durationSeconds) out.runtimeMinutes = Math.round(item.durationSeconds / 60);
    out.type = item.subjectType === 2 ? "series" : "movie";
    if (item.seNum)         out.seasons = item.seNum;
    if (item.countryName)   out.country = item.countryName;
    if (item.language)      out.language = item.language;
    if (item.dubs?.length && !item.audioTracks) out.audioTracks = item.dubs;

    return out;
}

// Language dub filter — currently disabled (pass-through)
const notHindiDub = () => true;

let cookieCache = null;
let cookieCacheTime = 0;
const COOKIE_CACHE_DURATION = 3600000; // 1 hour

// Helper function to extract hostname from URL
function extractHostname(url) {
    try {
        // Remove protocol if present
        let hostname = url.replace(/^(https?:\/\/)?(www\.)?/, '');
        // Remove port if present
        hostname = hostname.split(':')[0];
        // Remove path and query
        hostname = hostname.split('/')[0];
        return hostname.toLowerCase();
    } catch (e) {
        return null;
    }
}

// Check if origin is allowed
function isOriginAllowed(origin) {
    if (!origin) return false;
    
    // Check if origin matches exactly
    for (const allowed of ALLOWED_ORIGINS) {
        if (allowed === origin) {
            return true;
        }
    }
    
    // Check for wildcard patterns (escape dots FIRST, then replace * with .*)
    for (const allowed of ALLOWED_ORIGINS) {
        if (allowed.includes('*')) {
            const pattern = allowed.replace(/\./g, '\\.').replace(/\*/g, '.*');
            const regex = new RegExp(`^${pattern}$`);
            if (regex.test(origin)) {
                return true;
            }
        }
    }
    
    return false;
}

// Check if hostname is blocked
function isHostnameBlocked(hostname) {
    if (!hostname) return false;
    
    // Check against blocked patterns
    for (const pattern of BLOCKED_PATTERNS) {
        if (pattern.test(hostname)) {
            return true;
        }
    }
    
    return false;
}

// Main origin check function
function checkOrigin(request) {
    const origin = request.headers.get('origin');
    const referer = request.headers.get('referer');
    const url = new URL(request.url);
    
    // Extract hostnames for checking
    let originHostname = origin ? extractHostname(origin) : null;
    let refererHostname = referer ? extractHostname(referer) : null;
    let requestHostname = url.hostname.toLowerCase();
    
    console.log(`Checking: origin=${originHostname}, referer=${refererHostname}, request=${requestHostname}`);
    
    // Check if request hostname itself is blocked
    if (isHostnameBlocked(requestHostname)) {
        console.log(`Blocked: Request hostname "${requestHostname}" is blocked`);
        return false;
    }
    
    // First check if request is from allowed hostname directly
    for (const allowed of ALLOWED_ORIGINS) {
        if (allowed.includes('*')) {
            const pattern = allowed.replace(/\./g, '\\.').replace(/\*/g, '.*');
            const regex = new RegExp(`^${pattern}$`);
            const requestOrigin = `https://${requestHostname}`;
            if (regex.test(requestOrigin)) {
                console.log(`Allowed: Request hostname "${requestHostname}" matches pattern "${allowed}"`);
                return true;
            }
        } else if (allowed === `https://${requestHostname}`) {
            console.log(`Allowed: Request hostname "${requestHostname}" exactly matches allowed origin`);
            return true;
        }
    }
    
    // If origin is present, check it
    if (origin) {
        if (isOriginAllowed(origin)) {
            console.log(`Allowed: Origin "${origin}" is in allowed list`);
            return true;
        }
        if (isHostnameBlocked(originHostname)) {
            console.log(`Blocked: Origin "${origin}" is blocked`);
            return false;
        }
    }
    
    // If referer is present, check it
    if (referer) {
        const refererOrigin = referer.split('/').slice(0, 3).join('/');
        if (isOriginAllowed(refererOrigin)) {
            console.log(`Allowed: Referer origin "${refererOrigin}" is in allowed list`);
            return true;
        }
        if (isHostnameBlocked(refererHostname)) {
            console.log(`Blocked: Referer hostname "${refererHostname}" is blocked`);
            return false;
        }
    }
    
    // If no origin or referer, allow if request hostname matches allowed patterns
    if (!origin && !referer) {
        for (const allowed of ALLOWED_ORIGINS) {
            if (allowed.includes('*')) {
                const pattern = allowed.replace(/\./g, '\\.').replace(/\*/g, '.*');
                const regex = new RegExp(`^${pattern}$`);
                const requestOrigin = `https://${requestHostname}`;
                if (regex.test(requestOrigin)) {
                    console.log(`Allowed: No origin/referer but hostname "${requestHostname}" matches pattern "${allowed}"`);
                    return true;
                }
            } else if (allowed === `https://${requestHostname}`) {
                console.log(`Allowed: No origin/referer but hostname "${requestHostname}" exactly matches allowed origin`);
                return true;
            }
        }
    }
    
    // Default: block if nothing matched
    console.log(`Blocked: No allowed origin found for request`);
    return false;
}

// Check if a hostname matches a domain entry (supports wildcard subdomains)
function domainMatches(hostname, allowedDomain) {
    if (allowedDomain.startsWith("*.")) {
        const base = allowedDomain.slice(2);
        return hostname === base || hostname.endsWith("." + base);
    }
    return hostname === allowedDomain;
}

// Block known scraper / bot user-agents
function isScraperUserAgent(request) {
    const ua = (request.headers.get("user-agent") || "").toLowerCase();
    const scraperPatterns = [
        "curl/", "python-requests", "python/", "python3",
        "go-http-client", "java/", "httpie", "wget/",
        "libwww-perl", "scrapy", "node-fetch", "got/",
        "undici", "aiohttp", "httpx", "okhttp/",
        "php/", "ruby/", "perl/", "dart/"
    ];
    return scraperPatterns.some(p => ua.includes(p));
}

// KV-based rate limiting: max 300 requests per API key per minute
// Live channel endpoints are bulk-paged (9000+ channels), so the limit is high
async function checkRateLimit(request, env) {
    const key = extractRequestApiKey(request);
    if (!key) return true;
    if (!env || !env.KV_STORE) return true;
    const windowKey = `ratelimit:${key}:${Math.floor(Date.now() / 60000)}`;
    try {
        const current = await env.KV_STORE.get(windowKey);
        const count = current ? parseInt(current) : 0;
        if (count >= 300) return false;
        await env.KV_STORE.put(windowKey, String(count + 1), { expirationTtl: 120 });
        return true;
    } catch (e) {
        return true;
    }
}

// Extract API key from request — checks Authorization header first, then ?apikey= / ?key= query params
function extractRequestApiKey(request) {
    const authHeader = request.headers.get("Authorization") || "";
    if (authHeader.startsWith("Bearer ")) {
        const k = authHeader.substring(7).trim();
        if (k) return k;
    }
    const u = new URL(request.url);
    return (u.searchParams.get("apikey") || u.searchParams.get("key") || "").trim() || null;
}

// API key authorization — validates key, blocks scrapers, enforces domain rules.
// Checks KV first (live issued keys), falls back to hardcoded API_KEY_MAP.
async function checkApiKey(request, env) {
    const providedKey = extractRequestApiKey(request);
    if (!providedKey) return false;

    // --- KV lookup with short-lived in-memory cache ---
    let keyData = null;
    if (env?.KV_STORE) {
        const cached = kvKeyCache.get(providedKey);
        if (cached && Date.now() < cached.expiresAt) {
            keyData = cached.data;
        } else {
            try {
                keyData = await env.KV_STORE.get(`apikey:${providedKey}`, { type: 'json' });
                kvKeyCache.set(providedKey, { data: keyData, expiresAt: Date.now() + KV_CACHE_TTL_MS });
            } catch (_) { /* KV error — fall through to hardcoded map */ }
        }
    }

    // --- Fallback: hardcoded API_KEY_MAP (existing keys still work) ---
    if (!keyData) keyData = API_KEY_MAP[providedKey];
    if (!keyData) return false;

    const origin = request.headers.get("origin");
    const referer = request.headers.get("referer");

    // === Case 1: Origin or Referer is present (browser-style call) ===
    if (origin || referer) {
        // Block scraper/bot UAs only here — this is someone impersonating a
        // browser hit (leaked-key scraping), not a legitimate backend caller.
        if (isScraperUserAgent(request)) return false;

        const rawOrigin = origin || referer.split("/").slice(0, 3).join("/");
        const requestingHostname = extractHostname(rawOrigin);

        // If origin is already in ALLOWED_ORIGINS → allow (covers all whitelisted clients)
        if (isOriginAllowed(rawOrigin)) return true;

        // Origin NOT in whitelist → strict domain check for this key
        if (keyData.domains && keyData.domains.length > 0) {
            return keyData.domains.some(d => domainMatches(requestingHostname, d));
        }

        // Unknown origin + no domain mapping → block
        return false;
    }

    // === Case 2: No Origin and no Referer (server-side call, e.g. a bot backend,
    // Supabase Edge Functions, cron job, etc.) ===
    // These callers never send a browser UA by nature (axios/undici/node-fetch/
    // Python/Go/etc. are all normal here), so the scraper-UA block does not apply.
    // A valid API key + the rate limiter (300 req/min) are the protection for this path.
    return true;
}

// Admin password check — requires ADMIN_SECRET Worker secret to be set
function checkAdminAuth(request, env) {
    if (!env?.ADMIN_SECRET) return false;
    const auth = request.headers.get('Authorization');
    if (!auth?.startsWith('Bearer ')) return false;
    return auth.slice(7).trim() === env.ADMIN_SECRET;
}

function createPermissionDeniedResponse(request) {
    const origin = request.headers.get('origin');
    
    // ALWAYS include CORS headers for the error response so browser can see it
    const corsHeaders = {
        'Access-Control-Allow-Origin': origin || '*', // Allow the requesting origin or any
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Origin, X-Requested-With, Content-Type, Accept, Authorization, Range'
    };
    
    return new Response(
        JSON.stringify({
            status: 403,
            success: false,
            creator: "DaraTech",
            message: "Permission Denied, Unauthorized Access. Please Request for Access via: https://wa.me/message/OCSOK3IUFPWWA1"
        }, null, 2),
        {
            status: 403,
            headers: {
                'Content-Type': 'application/json',
                ...corsHeaders
            }
        }
    );
}

function createApiKeyRequiredResponse(request) {
    const origin = request.headers.get('origin');
    
    const corsHeaders = {
        'Access-Control-Allow-Origin': origin || '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Origin, X-Requested-With, Content-Type, Accept, Authorization, Range'
    };
    
    return new Response(
        JSON.stringify({
            status: 403,
            success: false,
            creator: "DaraTech",
            message: "API Key Required. Please provide a valid Bearer token in Authorization header. Purchase one via: https://wa.me/message/OCSOK3IUFPWWA1"
        }, null, 2),
        {
            status: 403,
            headers: {
                'Content-Type': 'application/json',
                ...corsHeaders
            }
        }
    );
}

function processApiResponse(data) {
    if (data && data.data) {
        return data.data;
    }
    return data;
}

async function getCookies() {
    const now = Date.now();
    if (cookieCache && (now - cookieCacheTime) < COOKIE_CACHE_DURATION) {
        return cookieCache;
    }

    try {
        const cookieHost = getRandomHost();
        const rotatedIp = getRandomIp();
        const response = await fetch(`https://${cookieHost}/wefeed-h5-bff/app/get-latest-app-pkgs?app_name=moviebox`, {
            headers: {
                ...DEFAULT_HEADERS,
                Host: cookieHost,
                Referer: `https://${cookieHost}`,
                'X-Forwarded-For': rotatedIp,
                'CF-Connecting-IP': rotatedIp,
                'X-Real-IP': rotatedIp
            }
        });

        let setCookieHeaders = [];
        if (typeof response.headers.getSetCookie === 'function') {
            setCookieHeaders = response.headers.getSetCookie();
        } else {
            const allHeaders = [...response.headers];
            setCookieHeaders = allHeaders
                .filter(([key]) => key.toLowerCase() === 'set-cookie')
                .map(([, value]) => value);
        }
        
        if (setCookieHeaders.length > 0) {
            const cookies = setCookieHeaders.map(cookie => {
                const parts = cookie.split(';');
                return parts[0].trim();
            }).join('; ');
            
            cookieCache = cookies;
            cookieCacheTime = now;
        }
        
        return cookieCache;
    } catch (error) {
        console.error('Failed to get cookies:', error.message);
        return null;
    }
}

async function makeApiRequest(url, options = {}) {
    const cookies = await getCookies();
    // Derive Host from target URL so the header always matches
    const targetHost = new URL(url).hostname;
    const rotatedIp = getRandomIp();
    const headers = {
        ...DEFAULT_HEADERS,
        Host: targetHost,
        Referer: `https://${targetHost}`,
        'X-Forwarded-For': rotatedIp,
        'CF-Connecting-IP': rotatedIp,
        'X-Real-IP': rotatedIp,
        ...options.headers
    };
    if (cookies) {
        headers['Cookie'] = cookies;
    }
    
    const response = await fetch(url, {
        ...options,
        headers
    });
    
    return response;
}

function corsHeaders(request) {
    const origin = request.headers.get('origin');
    const url = new URL(request.url);
    const headers = {
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Origin, X-Requested-With, Content-Type, Accept, Authorization, Range'
    };
    
    if (origin && isOriginAllowed(origin)) {
        headers['Access-Control-Allow-Origin'] = origin;
    } else {
        // For allowed hostnames, allow their origin
        const requestOrigin = `https://${url.hostname}`;
        if (isOriginAllowed(requestOrigin)) {
            headers['Access-Control-Allow-Origin'] = requestOrigin;
        } else if (origin) {
            // If origin exists but not allowed, still allow it for error responses
            headers['Access-Control-Allow-Origin'] = origin;
        } else {
            // No origin header, allow any for direct browser access
            headers['Access-Control-Allow-Origin'] = '*';
        }
    }
    
    return headers;
}

function createJsonResponse(data, status = 200, success = true, request) {
    return new Response(JSON.stringify(data, null, 2), {
        status,
        headers: {
            'Content-Type': 'application/json',
            ...corsHeaders(request)
        }
    });
}

function createSuccessResponse(results, message = 'Success', request) {
    return createJsonResponse({
        status: 200,
        success: true,
        creator: 'DaraTech',
        results: results
    }, 200, true, request);
}

function createErrorResponse(message, status = 500, request) {
    return createJsonResponse({
        status: status,
        success: false,
        creator: 'DaraTech',
        message: message
    }, status, false, request);
}

async function handleHomepage(request) {
    try {
        const data = await v3Get('/wefeed-mobile-bff/tab-operating', { page: 1, tabId: 0, version: '' });
        const sections = (data?.items || [])
            .filter(s => Array.isArray(s.subjects) && s.subjects.length > 0)
            .map(s => ({
                type:  s.type  || 'Section',
                title: s.title || '',
                items: s.subjects.map(normaliseItemW)
            }))
            .filter(s => s.items.length > 0);
        return createSuccessResponse({ sections, totalSections: sections.length }, 'Homepage data retrieved successfully', request);
    } catch (error) {
        return createErrorResponse('Failed to fetch homepage data: ' + error.message, 500, request);
    }
}

async function handleTrending(url, request) {
    try {
        const urlObj = new URL(url);
        const page    = parseInt(urlObj.searchParams.get('page'))    || 1;
        const perPage = parseInt(urlObj.searchParams.get('perPage')) || 30;
        const type    = parseInt(urlObj.searchParams.get('type'))    || 0;

        // tab-operating only has 1 real page of unique data — extra pages are duplicates.
        const data = await v3Get('/wefeed-mobile-bff/tab-operating', { page: 1, tabId: 0, version: '' });

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
        allItems = allItems.filter(notHindiDub).map(normaliseItemW);
        const offset = (page - 1) * perPage;
        const items  = allItems.slice(offset, offset + perPage);
        return createSuccessResponse(
            { items, total: allItems.length, page, perPage, hasMore: offset + perPage < allItems.length },
            'Trending data retrieved successfully', request
        );
    } catch (error) {
        return createErrorResponse('Failed to fetch trending data', 500, request);
    }
}

async function handleSearch(query, url, request) {
    try {
        const urlObj = new URL(url);
        const page = parseInt(urlObj.searchParams.get('page')) || 1;
        const perPage = Math.min(parseInt(urlObj.searchParams.get('perPage')) || 20, 20);
        const subjectType = parseInt(urlObj.searchParams.get('type')) || SubjectType.ALL;

        // Fetch 5 search pages in parallel — v3 caps perPage at 20, so 5×20 = up to 100 raw results.
        // This ensures queries like "demon" surface "Demon Slayer", "Demon King", etc. from later pages.
        const [r1, r2, r3, r4, r5] = await Promise.allSettled([
            v3Post('/wefeed-mobile-bff/subject-api/search/v2', { keyword: query, page: 1, perPage: 20, subjectType, tabId: 'All' }),
            v3Post('/wefeed-mobile-bff/subject-api/search/v2', { keyword: query, page: 2, perPage: 20, subjectType, tabId: 'All' }),
            v3Post('/wefeed-mobile-bff/subject-api/search/v2', { keyword: query, page: 3, perPage: 20, subjectType, tabId: 'All' }),
            v3Post('/wefeed-mobile-bff/subject-api/search/v2', { keyword: query, page: 4, perPage: 20, subjectType, tabId: 'All' }),
            v3Post('/wefeed-mobile-bff/subject-api/search/v2', { keyword: query, page: 5, perPage: 20, subjectType, tabId: 'All' }),
        ]);

        let pager = {};
        const rawItems = [];
        const seen = new Set();
        for (const result of [r1, r2, r3, r4, r5]) {
            if (result.status !== 'fulfilled') continue;
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
            const hpData = await v3Get('/wefeed-mobile-bff/tab-operating', { page: 1, tabId: 0, version: '' });
            for (const s of (hpData?.items || [])) {
                for (const item of (s.subjects || [])) {
                    if (item.subjectId && seen.has(item.subjectId)) continue;
                    if ((item.title || '').toLowerCase().includes(ql)) {
                        if (item.subjectId) seen.add(item.subjectId);
                        rawItems.push(item);
                    }
                }
            }
        } catch {}

        let items = rawItems.map(normaliseItemW).filter(notHindiDub);
        if (subjectType !== SubjectType.ALL) items = items.filter(i => i.subjectType === subjectType);

        const total = pager.total ?? items.length;
        const offset = (page - 1) * perPage;
        const pagedItems = items.slice(offset, offset + perPage);
        return createSuccessResponse({ items: pagedItems, pager, query, total, hasMore: offset + perPage < items.length }, 'Search results retrieved successfully', request);
    } catch (error) {
        return createErrorResponse('Failed to perform search: ' + error.message, 500, request);
    }
}

// Fetch per-season episode counts from the v3 season-info endpoint.
// Returns null on failure so callers can fall back gracefully.
async function fetchSeasonDetails(movieId) {
    try {
        const data = await v3Get('/wefeed-mobile-bff/subject-api/season-info', { subjectId: movieId });
        const seasons = data?.seasons;
        if (Array.isArray(seasons) && seasons.length > 0) {
            return seasons.map(s => ({ season: s.se, totalEpisodes: s.maxEp || 0 }));
        }
        return null;
    } catch {
        return null;
    }
}

async function handleInfo(movieId, request) {
    try {
        const [data, seasonDetails] = await Promise.all([
            v3Get('/wefeed-mobile-bff/subject-api/get', { subjectId: movieId }),
            fetchSeasonDetails(movieId)
        ]);
        if (!data) return createErrorResponse('Subject not found', 404, request);
        const item = normaliseItemW(data);
        if (seasonDetails) {
            item.seasonDetails = seasonDetails;
            const total = seasonDetails.reduce((n, s) => n + (s.totalEpisodes || 0), 0);
            if (total > 0) item.totalEpisodes = total;
        } else {
            const epCount = data.resourceDetectors?.[0]?.totalEpisode;
            if (epCount) item.totalEpisodes = epCount;
        }
        return createSuccessResponse(item, 'Movie info retrieved successfully', request);
    } catch (error) {
        return createErrorResponse('Failed to fetch movie info: ' + error.message, 500, request);
    }
}

async function handleAnimeInfo(movieId, request) {
    try {
        const [data, seasonDetails] = await Promise.all([
            v3Get('/wefeed-mobile-bff/subject-api/get', { subjectId: movieId }),
            fetchSeasonDetails(movieId)
        ]);
        if (!data) return createErrorResponse('Subject not found', 404, request);
        const item = normaliseItemW(data);
        const ANIME_KW = ['anime', 'animation'];
        const hasAnimeKw = (str) => { const s = (str || '').toLowerCase(); return ANIME_KW.some(k => s.includes(k)); };
        const isAnime = hasAnimeKw(item.genre) || hasAnimeKw(item.corner) || hasAnimeKw(item.category);
        if (!isAnime) return createErrorResponse(`Title "${item.title || movieId}" is not an anime/animation title. Use /api/v3/info/${movieId} for general info.`, 404, request);
        if (seasonDetails) {
            item.seasonDetails = seasonDetails;
            const total = seasonDetails.reduce((n, s) => n + (s.totalEpisodes || 0), 0);
            if (total > 0) item.totalEpisodes = total;
        } else {
            const epCount = data.resourceDetectors?.[0]?.totalEpisode;
            if (epCount) item.totalEpisodes = epCount;
        }
        return createSuccessResponse(item, 'Anime info retrieved successfully', request);
    } catch (error) {
        return createErrorResponse('Failed to fetch anime info: ' + error.message, 500, request);
    }
}

async function handleFilter(url, request) {
    try {
        const urlObj   = new URL(url);
        const platform = (urlObj.searchParams.get('platform') || '').toLowerCase().trim();
        const genre    = (urlObj.searchParams.get('genre')    || '').trim();
        const page     = parseInt(urlObj.searchParams.get('page'))    || 1;
        const perPage  = Math.min(parseInt(urlObj.searchParams.get('perPage')) || 20, 20);
        const type     = parseInt(urlObj.searchParams.get('type'))    || SubjectType.ALL;

        // No platform/genre → return trending content as default
        if (!platform && !genre) {
            const v3Data = await v3Post('/wefeed-mobile-bff/subject-api/search/v2', {
                keyword: 'trending', page, perPage, subjectType: type, tabId: 'All'
            });
            const items = (v3Data?.results?.[0]?.subjects || v3Data?.items || []).map(normaliseItemW);
            return createSuccessResponse({
                items,
                total: items.length,
                page,
                perPage,
                filter: { platform: null, genre: null, type },
                note: 'No filter provided — returning trending content'
            }, 'Filter results retrieved successfully', request);
        }

        const pm = platform ? PLATFORM_MAP[platform] : null;
        if (platform && !pm) {
            const valid = Object.keys(PLATFORM_MAP).join(', ');
            return createErrorResponse(`Unknown platform "${platform}". Valid options: ${valid}`, 400, request);
        }

        let items = [];
        const platformLabel = pm?.label || null;

        if (pm?.mode === 'section') {
            const hp = await v3Get('/wefeed-mobile-bff/tab-operating', { page: 1, tabId: 0, version: '' });
            const sections = (hp?.items || []).filter(s => Array.isArray(s.subjects) && s.subjects.length);
            const kw = pm.keyword.toLowerCase();
            const matched = sections.filter(s => (s.title || '').toLowerCase().includes(kw));
            if (!matched.length) {
                const v3Data = await v3Post('/wefeed-mobile-bff/subject-api/search/v2', {
                    keyword: pm.keyword + (genre ? ` ${genre}` : ''), page, perPage, subjectType: type, tabId: 'All'
                });
                items = (v3Data?.results?.[0]?.subjects || v3Data?.items || []).map(normaliseItemW);
            } else {
                const seen = new Set();
                for (const s of matched) {
                    for (const i of s.subjects) {
                        if (!i.subjectId || seen.has(i.subjectId)) continue;
                        seen.add(i.subjectId);
                        items.push(normaliseItemW(i));
                    }
                }
                const offset = (page - 1) * perPage;
                items = items.slice(offset, offset + perPage);
            }
        } else {
            const kw = (pm ? pm.keyword : '') + (genre ? (pm ? ` ${genre}` : genre) : '');
            const v3Data = await v3Post('/wefeed-mobile-bff/subject-api/search/v2', {
                keyword: kw.trim(), page, perPage, subjectType: type, tabId: 'All'
            });
            items = (v3Data?.results?.[0]?.subjects || v3Data?.items || []).map(normaliseItemW);
            if (genre) {
                const gl = genre.toLowerCase();
                items = items.filter(i =>
                    (i.genre  || '').toLowerCase().includes(gl) ||
                    (i.title  || '').toLowerCase().includes(gl) ||
                    (i.corner || '').toLowerCase().includes(gl)
                );
            }
        }

        if (type !== SubjectType.ALL) items = items.filter(i => i.subjectType === type);

        return createSuccessResponse({
            items,
            total: items.length,
            page,
            perPage,
            filter: { platform: platformLabel, genre: genre || null, type },
            note: pm?.mode === 'search'
                ? 'Platform identification is keyword-based; upstream does not tag content by streaming service'
                : undefined
        }, 'Filter results retrieved successfully', request);
    } catch (error) {
        return createErrorResponse('Filter failed: ' + error.message, 500, request);
    }
}

async function handleSchedule(url, request, env) {
    try {
        const urlObj = new URL(url);
        const period = (urlObj.searchParams.get('period') || 'daily').toLowerCase();
        const genre  = (urlObj.searchParams.get('genre')  || '').toLowerCase().trim();
        const type   = parseInt(urlObj.searchParams.get('type')) || SubjectType.ALL;
        const page   = parseInt(urlObj.searchParams.get('page')) || 1;

        if (!['daily','weekly','monthly'].includes(period))
            return createErrorResponse('Invalid period. Use: daily, weekly, monthly', 400, request);

        const rawDate   = urlObj.searchParams.get('date') || new Date().toISOString().slice(0, 10);
        const startDate = new Date(rawDate + 'T00:00:00Z');
        if (isNaN(startDate.getTime()))
            return createErrorResponse('Invalid date. Use YYYY-MM-DD', 400, request);

        const endDate = new Date(startDate);
        if      (period === 'weekly')  endDate.setUTCDate(endDate.getUTCDate() + 7);
        else if (period === 'monthly') endDate.setUTCDate(endDate.getUTCDate() + 30);
        else                           endDate.setUTCDate(endDate.getUTCDate() + 1);

        const useJikan = genre === 'anime' || genre === '' || genre === 'all';

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

                // Filter by genre if specified
                if (genre && genre !== 'anime' && genre !== 'all') {
                    const gl = genre.toLowerCase();
                    items = items.filter(item =>
                        (item.genres || []).some(g => g.name.toLowerCase().includes(gl))
                    );
                }

                // Group by actual date in range using broadcast day
                const byDate = {};
                for (const item of items) {
                    const dayKey = (item.broadcast?.day || '').toLowerCase();
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

                return createSuccessResponse({
                    schedule: days,
                    period,
                    dateRange: { from: rawDate, to: endDate.toISOString().slice(0, 10) },
                    totalEpisodes: total,
                    source: 'jikan',
                    filter: { genre: genre || 'anime', type: 'series' },
                    pagination: jikan.pagination || {}
                }, 'Schedule retrieved successfully', request);
            } catch (jikanErr) {
                console.error('Jikan failed, falling back to upstream:', jikanErr.message);
                // Fall through to upstream path below
            }
        }

        // General schedule via upstream search + releaseDate filter
        const keyword = genre || 'trending';
        const v3Data  = await v3Post('/wefeed-mobile-bff/subject-api/search/v2', {
            keyword, page, perPage: 20, subjectType: type, tabId: 'All'
        });
        let items = (v3Data?.results?.[0]?.subjects || v3Data?.items || []).map(normaliseItemW);

        const startTs = startDate.getTime();
        const endTs   = endDate.getTime();
        items = items.filter(i => {
            if (!i.releaseDate) return false;
            const d = new Date(i.releaseDate).getTime();
            return !isNaN(d) && d >= startTs && d < endTs;
        });

        return createSuccessResponse({
            schedule: [{ date: rawDate, count: items.length, items }],
            period,
            dateRange: { from: rawDate, to: endDate.toISOString().slice(0, 10) },
            total: items.length,
            source: 'upstream',
            filter: { genre: genre || null, type }
        }, 'Schedule retrieved successfully', request);
    } catch (error) {
        return createErrorResponse('Schedule fetch failed: ' + error.message, 500, request);
    }
}

// ─── Schedule / Popular ────────────────────────────────────────────────────────
// Top currently-airing anime ranked by MAL score via Jikan /top/anime?filter=airing.
// ?type=tv|movie|ova|special|ona  (default: tv)
// ?genre=action                   (client-side genre filter)
// ?limit=1-25                     (default: 25)
// ?page=N                         (default: 1)
async function handleSchedulePopular(url, request) {
    try {
        const urlObj = new URL(url);
        const limit  = Math.min(Math.max(parseInt(urlObj.searchParams.get('limit')) || 25, 1), 25);
        const page   = Math.max(parseInt(urlObj.searchParams.get('page')) || 1, 1);
        const genre  = (urlObj.searchParams.get('genre') || '').toLowerCase().trim();
        const type   = (urlObj.searchParams.get('type')  || 'tv').toLowerCase();

        const VALID_TYPES = ['tv', 'movie', 'ova', 'special', 'ona', 'music', 'cm', 'pv', 'tvspecial'];
        if (type && !VALID_TYPES.includes(type))
            return createErrorResponse(`Invalid type. Use: ${VALID_TYPES.join(', ')}`, 400, request);

        const params = new URLSearchParams({ filter: 'airing', limit: 25, page });
        if (type) params.set('type', type);

        const jikanRes = await fetch(`https://api.jikan.moe/v4/top/anime?${params}`, {
            headers: { 'Accept': 'application/json' }
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

        return createSuccessResponse({
            items,
            total: items.length,
            page,
            filter: { type, genre: genre || null },
            source: 'jikan',
            note: 'Top currently-airing anime ranked by MAL score',
            pagination: jikan.pagination || {}
        }, 'Popular schedule retrieved successfully', request);
    } catch (error) {
        return createErrorResponse('Popular schedule fetch failed: ' + error.message, 500, request);
    }
}

// ─── Anime — anime-only catalog (series + movies via upstream host) ──────────
async function handleAnime(url, request) {
    try {
        const urlObj  = new URL(url);
        const page    = Math.max(parseInt(urlObj.searchParams.get('page'))    || 1, 1);
        const perPage = Math.min(parseInt(urlObj.searchParams.get('perPage')) || 20, 50);
        const genre   = (urlObj.searchParams.get('genre') || '').trim().toLowerCase();
        const type    = parseInt(urlObj.searchParams.get('type'))    || SubjectType.ALL;
        // strict=true → only items whose corner field is exactly "Anime" (excludes generic animated films)
        const strict  = urlObj.searchParams.get('strict') === 'true' || urlObj.searchParams.get('strict') === '1';

        // Pull homepage sections (same upstream call as /api/v3/homepage and trending)
        const data     = await v3Get('/wefeed-mobile-bff/tab-operating', { page: 1, tabId: 0, version: '' });
        const sections = (data?.items || []).filter(s => Array.isArray(s.subjects) && s.subjects.length > 0);

        const ANIME_KW = ['anime', 'animation'];
        const hasAnimeKw = (str) => { const s = (str || '').toLowerCase(); return ANIME_KW.some(k => s.includes(k)); };

        const seen = new Set();
        let allItems = [];

        for (const section of sections) {
            const sectionIsAnime = hasAnimeKw(section.title) || hasAnimeKw(section.type);
            for (const item of section.subjects) {
                if (!item.subjectId || seen.has(item.subjectId)) continue;
                const itemIsAnime = hasAnimeKw(item.title) || hasAnimeKw(item.corner) || hasAnimeKw(item.genre);
                if (!sectionIsAnime && !itemIsAnime) continue;
                seen.add(item.subjectId);
                allItems.push(normaliseItemW({ ...item, _section: section.title || section.type }));
            }
        }

        // Strict mode: corner must explicitly contain "anime" (drops generic animated films)
        if (strict) {
            allItems = allItems.filter(i => (i.corner || '').toLowerCase().includes('anime'));
        }

        // Type filter (1=movies, 2=series)
        if (type !== SubjectType.ALL) allItems = allItems.filter(i => i.subjectType === type);

        // Genre filter (client-side on results)
        if (genre) {
            allItems = allItems.filter(i =>
                (i.genre  || '').toLowerCase().includes(genre) ||
                (i.title  || '').toLowerCase().includes(genre) ||
                (i.corner || '').toLowerCase().includes(genre)
            );
        }

        const total  = allItems.length;
        const offset = (page - 1) * perPage;
        const items  = allItems.slice(offset, offset + perPage);

        return createSuccessResponse({
            items,
            total,
            page,
            perPage,
            hasMore: offset + perPage < total,
            filter: { genre: genre || null, type, strict },
            source: 'upstream',
            note: strict
                ? 'Strict mode — only items with corner=Anime (pure anime feed)'
                : 'Filtered from homepage + trending sections — anime and animation content only'
        }, 'Anime catalog retrieved successfully', request);
    } catch (error) {
        return createErrorResponse('Anime catalog fetch failed: ' + error.message, 500, request);
    }
}

// ─── Anime Search ─────────────────────────────────────────────────────────────
async function handleAnimeSearch(query, url, request) {
    try {
        const urlObj  = new URL(url);
        const page    = Math.max(parseInt(urlObj.searchParams.get('page'))    || 1, 1);
        const perPage = Math.min(parseInt(urlObj.searchParams.get('perPage')) || 20, 50);
        const type    = parseInt(urlObj.searchParams.get('type')) || 0;
        const genre   = (urlObj.searchParams.get('genre') || '').toLowerCase().trim();

        const ANIME_KW = ['anime', 'animation'];
        const isAnimeItem = (i) => {
            const s = `${i.title||''} ${i.corner||''} ${i.genre||''} ${i.category||''}`.toLowerCase();
            return ANIME_KW.some(k => s.includes(k));
        };

        // 4 parallel fetches: 2 pages of "anime <query>" + 2 pages of plain "<query>"
        const [r1, r2, r3, r4] = await Promise.allSettled([
            v3Post('/wefeed-mobile-bff/subject-api/search/v2', { keyword: `anime ${query}`, page: 1, perPage: 20, subjectType: 0, tabId: 'All' }),
            v3Post('/wefeed-mobile-bff/subject-api/search/v2', { keyword: `anime ${query}`, page: 2, perPage: 20, subjectType: 0, tabId: 'All' }),
            v3Post('/wefeed-mobile-bff/subject-api/search/v2', { keyword: query,            page: 1, perPage: 20, subjectType: 0, tabId: 'All' }),
            v3Post('/wefeed-mobile-bff/subject-api/search/v2', { keyword: query,            page: 2, perPage: 20, subjectType: 0, tabId: 'All' }),
        ]);

        const seen = new Set();
        const rawItems = [];
        for (const result of [r1, r2, r3, r4]) {
            if (result.status !== 'fulfilled') continue;
            for (const item of (result.value?.results?.[0]?.subjects || result.value?.items || [])) {
                if (item.subjectId && seen.has(item.subjectId)) continue;
                if (item.subjectId) seen.add(item.subjectId);
                rawItems.push(item);
            }
        }

        // Supplement from tab-operating anime sections for partial title matches
        try {
            const ql = query.toLowerCase();
            const hpData = await v3Get('/wefeed-mobile-bff/tab-operating', { page: 1, tabId: 0, version: '' });
            for (const s of (hpData?.items || [])) {
                if (!ANIME_KW.some(k => (s.title || s.type || '').toLowerCase().includes(k))) continue;
                for (const item of (s.subjects || [])) {
                    if (item.subjectId && seen.has(item.subjectId)) continue;
                    if ((item.title || '').toLowerCase().includes(ql)) {
                        if (item.subjectId) seen.add(item.subjectId);
                        rawItems.push(item);
                    }
                }
            }
        } catch {}

        let items = rawItems.map(normaliseItemW).filter(isAnimeItem);
        if (type !== 0) items = items.filter(i => i.subjectType === type);
        if (genre) items = items.filter(i =>
            (i.genre  || '').toLowerCase().includes(genre) ||
            (i.title  || '').toLowerCase().includes(genre) ||
            (i.corner || '').toLowerCase().includes(genre)
        );

        const total  = items.length;
        const offset = (page - 1) * perPage;
        return createSuccessResponse({
            items: items.slice(offset, offset + perPage),
            total, page, perPage,
            hasMore: offset + perPage < total,
            query,
            filter: { type, genre: genre || null },
            note: 'Anime-only search — results filtered to anime and animation content'
        }, 'Anime search completed', request);
    } catch (error) {
        return createErrorResponse('Anime search failed: ' + error.message, 500, request);
    }
}

// ─── Seasons / Upcoming ────────────────────────────────────────────────────────
async function handleSeasonsUpcoming(url, request) {
    try {
        const urlObj = new URL(url);
        const page  = Math.max(parseInt(urlObj.searchParams.get('page')) || 1, 1);
        const genre = (urlObj.searchParams.get('genre') || '').toLowerCase().trim();
        const type  = (urlObj.searchParams.get('type')  || '').toLowerCase();

        const VALID_TYPES = ['', 'tv', 'movie', 'ova', 'special', 'ona', 'music', 'cm', 'pv', 'tvspecial'];
        if (!VALID_TYPES.includes(type))
            return createErrorResponse('Invalid type. Use: tv, movie, ova, special, ona', 400, request);

        const params = new URLSearchParams({ page });
        if (type) params.set('filter', type);

        const jikanRes = await fetch(`https://api.jikan.moe/v4/seasons/upcoming?${params}`, {
            headers: { 'Accept': 'application/json' }
        });
        if (!jikanRes.ok) throw new Error(`Jikan HTTP ${jikanRes.status}`);
        const jikan = await jikanRes.json();

        let items = (jikan.data || []).map(item => normaliseJikanItem(item, null));

        if (genre) {
            items = items.filter(item =>
                item.genres.some(g => g.toLowerCase().includes(genre))
            );
        }

        return createSuccessResponse({
            items,
            total: items.length,
            page,
            filter: { type: type || null, genre: genre || null },
            source: 'jikan',
            note: 'Upcoming anime — not yet airing',
            pagination: jikan.pagination || {}
        }, 'Upcoming season retrieved successfully', request);
    } catch (error) {
        return createErrorResponse('Upcoming season fetch failed: ' + error.message, 500, request);
    }
}

async function handleCaptions(subjectId, resourceId, url, request) {
    try {
        const urlObj = new URL(url);
        const format = urlObj.searchParams.get('format') || null;

        const params = { subjectId };
        if (resourceId) params.resourceId = resourceId;
        const v3Data = await v3Get('/wefeed-mobile-bff/subject-api/get-ext-captions', params);
        let captions = (v3Data?.extCaptions || []).map(c => ({
            language:     c.lanName || c.lan || 'Unknown',
            languageCode: c.lan || '',
            url:          c.url || '',
            size:         c.size || 0,
            delay:        c.delay || 0
        }));

        const SUBTITLE_FORMATS = ['srt', 'vtt', 'ass', 'ssa', 'sup', 'sub'];
        if (format && SUBTITLE_FORMATS.includes(format.toLowerCase())) {
            captions = captions.filter(c =>
                (c.url || '').toLowerCase().includes('.' + format.toLowerCase())
            );
        }

        return createSuccessResponse({ captions }, 'Captions retrieved successfully', request);
    } catch (error) {
        return createErrorResponse('Failed to fetch captions: ' + error.message, 500, request);
    }
}

/*
async function handleSources(movieId, url, request) {
    try {
        const urlObj = new URL(url);
        const season = parseInt(urlObj.searchParams.get('season')) || 0;
        const episode = parseInt(urlObj.searchParams.get('episode')) || 0;
        
        const infoParams = new URLSearchParams({ subjectId: movieId });
        const infoResponse = await makeApiRequest(`${HOST_URL}/wefeed-h5-bff/web/subject/detail?${infoParams}`);
        const infoData = await infoResponse.json();
        const movieInfo = processApiResponse(infoData);
        
        const detailPath = movieInfo?.subject?.detailPath;
        if (!detailPath) {
            return createErrorResponse('Could not get movie detail path', 500, request);
        }
         const refererUrl = `https://filmboom.top/spa/videoPlayPage/movies/${detailPath}?id=${movieId}&type=/movie/detail`; 
        // const refererUrl = `https://fmoviesunblocked.net/spa/videoPlayPage/movies/${detailPath}?id=${movieId}&type=/movie/detail`;
        
        const params = new URLSearchParams({
            subjectId: movieId,
            se: season,
            ep: episode
        });
         const response = await makeApiRequest(`https://filmboom.top/wefeed-h5-bff/web/subject/download?${params}`, {
         // const response = await makeApiRequest(`${HOST_URL}/wefeed-h5-bff/web/subject/download?${params}`, {

          
            headers: {
                'Referer': refererUrl,
                'Origin': 'https://filmboom.top'
             // 'Origin': 'https://fmoviesunblocked.net'
                  
            }
        });
        
        const data = await response.json();
        const content = processApiResponse(data);
        
        let sources = [];
        let captions = [];
        
         if (content && content.streams) {
    //   if (content && content.downloads) {
       
            const title = movieInfo?.subject?.title || 'video';
            const isEpisode = season > 0 && episode > 0;
            
            const protocol = request.headers.get('x-forwarded-proto') || 'https';
            const host = request.headers.get('host');
            const baseUrl = `${protocol}://${host}`;
            
           sources = content.streams.map(file => {
           // sources = content.downloads.map(file => {
                const downloadParams = new URLSearchParams({
                    url: file.url,
                    title: title,
                    quality: file.resolutions || 'Unknown'
                   // quality: file.resolution || 'Unknown'
                    
                });
                
                if (isEpisode) {
                    downloadParams.append('season', season);
                    downloadParams.append('episode', episode);
                }
                
                return {
                    id: file.id,
                    // quality: `${file.resolution}p` || 'Unknown',
                    quality: `${file.resolutions}p` || 'Unknown',
                    download_url: `${baseUrl}/api/v3/download?${downloadParams.toString()}`,
                    stream_url: `${baseUrl}/api/v3/stream?url=${encodeURIComponent(file.url)}`,
                    size: file.size,
                    format: 'mp4'
                };
            });
        }
        
        if (content && content.captions) {
            captions = content.captions;
        }
        
        return new Response(JSON.stringify({
            status: 200,
            success: true,
            creator: 'DaraTech',
            results: sources,
            subtitles: captions
        }, null, 2), {
            headers: {
                'Content-Type': 'application/json',
                ...corsHeaders(request)
            }
        });
        
    } catch (error) {
        return createErrorResponse('Failed to fetch sources', 500, request);
    }
}
*/

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

async function handleSources(movieId, url, request) {
    try {
        const urlObj = new URL(url);
        const season = parseInt(urlObj.searchParams.get('season')) || 0;
        const episode = parseInt(urlObj.searchParams.get('episode')) || 0;

        const protocol = request.headers.get('x-forwarded-proto') || 'https';
        const host = request.headers.get('host');
        const baseUrl = `${protocol}://${host}`;

        // ── Primary: v3 resource endpoint ────────────────────────────────────
        try {
            const params = { subjectId: movieId };
            if (season || episode) { params.se = season; params.ep = episode; }
            const v3Data = await v3Get('/wefeed-mobile-bff/subject-api/resource', params);
            const videoList = v3Data?.list || [];

            if (videoList.length > 0) {
                const rawSources = videoList.map(f => {
                    const label = normaliseQualityLabel(f.resolution);
                    const dl = new URLSearchParams({ url: f.resourceLink, quality: label });
                    if (season || episode) { dl.set('season', season); dl.set('episode', episode); }
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
                        duration:          f.duration || 0,
                        format:            String(f.resourceLink || '').includes('.m3u8') ? 'hls' : 'mp4',
                        browserCompatible: isBrowserCompatibleCodec(codec),
                        requireMemberType: f.requireMemberType || 0
                    };
                });
                const sources = dedupeAndSortSources(rawSources);

                // extCaptions live per-item inside list[] — read from the first item
                const subtitles = (videoList[0]?.extCaptions || []).map(c => ({
                    language:     c.lanName || c.lan || 'Unknown',
                    languageCode: c.lan || '',
                    url:          c.url || '',
                    size:         c.size || 0,
                    delay:        c.delay || 0
                }));

                // Fetch audio dubs from v3 details
                let audioTracks = [];
                try {
                    const details = await v3Get('/wefeed-mobile-bff/subject-api/get', { subjectId: movieId });
                    audioTracks = (details?.dubs || []).map(d => ({
                        language:     d.lanName || d.lanCode || 'Unknown',
                        languageCode: d.lanCode || '',
                        isOriginal:   d.original || false,
                        subjectId:    d.subjectId || ''
                    }));
                } catch {}

                return new Response(JSON.stringify({
                    status: 200, success: true, creator: 'DaraTech',
                    results: sources, subtitles, audioTracks
                }, null, 2), { headers: { 'Content-Type': 'application/json', ...corsHeaders(request) } });
            }
        } catch (v3Err) {
            console.error('v3 sources failed:', v3Err.message);
        }

        return createErrorResponse('No video sources found for this title', 404, request);

    } catch (error) {
        return createErrorResponse('Failed to fetch sources: ' + error.message, 500, request);
    }
}


async function handleAnimeSources(movieId, url, request) {
    try {
        const urlObj  = new URL(url);
        const season  = parseInt(urlObj.searchParams.get('season'))  || 0;
        const episode = parseInt(urlObj.searchParams.get('episode')) || 0;

        const protocol = request.headers.get('x-forwarded-proto') || 'https';
        const host     = request.headers.get('host');
        const baseUrl  = `${protocol}://${host}`;

        const v3Params = { subjectId: movieId };
        if (season || episode) { v3Params.se = season; v3Params.ep = episode; }

        const [infoData, v3Data] = await Promise.all([
            v3Get('/wefeed-mobile-bff/subject-api/get',      { subjectId: movieId }),
            v3Get('/wefeed-mobile-bff/subject-api/resource', v3Params)
        ]);

        if (!infoData) return createErrorResponse('Subject not found', 404, request);

        const item = normaliseItemW(infoData);
        const ANIME_KW = ['anime', 'animation'];
        const hasAnimeKw = (str) => { const s = (str || '').toLowerCase(); return ANIME_KW.some(k => s.includes(k)); };
        if (!hasAnimeKw(item.genre) && !hasAnimeKw(item.corner) && !hasAnimeKw(item.category)) {
            return createErrorResponse(`Title "${item.title || movieId}" is not an anime/animation title. Use /api/v3/sources/${movieId} for general sources.`, 404, request);
        }

        const videoList = v3Data?.list || [];
        if (videoList.length === 0) return createErrorResponse('No video sources found for this anime title', 404, request);

        const rawSources = videoList.map(f => {
            const label = normaliseQualityLabel(f.resolution);
            const dl = new URLSearchParams({ url: f.resourceLink, quality: label });
            if (season || episode) { dl.set('season', season); dl.set('episode', episode); }
            const codec = f.codecName || null;
            return {
                id:                f.resourceId,
                _qualityBase:      label,
                quality:           label,
                url:               f.resourceLink,
                download_url:      `${baseUrl}/api/v3/download?${dl}`,
                stream_url:        `${baseUrl}/api/v3/stream?url=${encodeURIComponent(f.resourceLink)}`,
                size:              f.size      || 0,
                codec,
                duration:          f.duration  || 0,
                format:            String(f.resourceLink || '').includes('.m3u8') ? 'hls' : 'mp4',
                browserCompatible: isBrowserCompatibleCodec(codec),
                requireMemberType: f.requireMemberType || 0
            };
        });
        const sources = dedupeAndSortSources(rawSources);

        // extCaptions live per-item inside list[] — read from the first item
        const subtitles = (videoList[0]?.extCaptions || []).map(c => ({
            language:     c.lanName || c.lan || 'Unknown',
            languageCode: c.lan || '',
            url:          c.url || '',
            size:         c.size || 0,
            delay:        c.delay || 0
        }));

        const audioTracks = (infoData?.dubs || []).map(d => ({
            language:     d.lanName || d.lanCode || 'Unknown',
            languageCode: d.lanCode || '',
            isOriginal:   d.original || false,
            subjectId:    d.subjectId || ''
        }));

        return createSuccessResponse({ sources, subtitles, audioTracks }, 'Anime sources retrieved successfully', request);
    } catch (error) {
        return createErrorResponse('Failed to fetch anime sources: ' + error.message, 500, request);
    }
}

// ─── SMTP email notification via cloudflare:sockets ────────────────────────────
async function sendSmtpNotification(env, data) {
    if (!env?.SMTP_PASS) return false;
    const enc = new TextEncoder();
    const dec = new TextDecoder();
    const smtp = {
        host: 'mail.runflix.name.ng',
        port: 587,
        user: 'support@runflix.name.ng',
        to: 'adtelecom.info@gmail.com'
    };
    try {
        const { connect } = await import('cloudflare:sockets');
        const socket = connect({ hostname: smtp.host, port: smtp.port });
        const reader = socket.readable.getReader();
        const writer = socket.writable.getWriter();
        let buf = '';

        const readSMTP = async (src) => {
            while (true) {
                const { value } = await src.read();
                buf += dec.decode(value);
                const lines = buf.split('\r\n');
                for (let i = 0; i < lines.length - 1; i++) {
                    if (/^\d{3} /.test(lines[i])) {
                        buf = lines.slice(i + 1).join('\r\n');
                        return lines[i];
                    }
                }
            }
        };
        const writeSMTP = async (w, line) => { await w.write(enc.encode(line + '\r\n')); };

        await readSMTP(reader);
        await writeSMTP(writer, 'EHLO worker.runflix.name.ng');
        await readSMTP(reader);
        await writeSMTP(writer, 'STARTTLS');
        await readSMTP(reader);
        reader.releaseLock();
        writer.releaseLock();

        const tls = socket.startTls();
        const tr = tls.readable.getReader();
        const tw = tls.writable.getWriter();
        buf = '';
        const tlsRead = () => readSMTP(tr);
        const tlsWrite = (line) => writeSMTP(tw, line);

        await tlsWrite('EHLO worker.runflix.name.ng');
        await tlsRead();
        await tlsWrite('AUTH LOGIN');
        await tlsRead();
        await tlsWrite(btoa(smtp.user));
        await tlsRead();
        await tlsWrite(btoa(env.SMTP_PASS));
        const auth = await tlsRead();
        if (!auth.startsWith('235')) throw new Error('Auth: ' + auth);

        await tlsWrite(`MAIL FROM:<${smtp.user}>`);
        await tlsRead();
        await tlsWrite(`RCPT TO:<${smtp.to}>`);
        await tlsRead();
        await tlsWrite('DATA');
        await tlsRead();

        const lines = [
            `From: RUNFLIX API <${smtp.user}>`,
            `To: RunFlix Entertainment <${smtp.to}>`,
            `Subject: New API Key Request — ${data.name}`,
            `MIME-Version: 1.0`,
            `Content-Type: text/plain; charset=UTF-8`,
            ``,
            `New API key request received:`,
            ``,
            `Name:     ${data.name}`,
            `Email:    ${data.email || '—'}`,
            `Website:  ${data.website || '—'}`,
            `Use Case: ${data.useCase}`,
            ``,
            `Review at: https://movieapi.runflix.name.ng/admin/stats`,
            `.`
        ].join('\r\n');

        await tw.write(enc.encode(lines + '\r\n'));
        await tlsRead();
        await tlsWrite('QUIT');
        tr.releaseLock();
        tw.releaseLock();
        try { await tls.close(); } catch {}
        return true;
    } catch (e) {
        console.error('SMTP error:', e.message);
        return false;
    }
}

// Function to serve static files from KV store
async function serveFile(filename, contentType, request, env) {
    // Allow access without origin check for direct visits
    // But still check if someone is trying to access from blocked origin
    const origin = request.headers.get('origin');
    const referer = request.headers.get('referer');
    
    // If origin or referer is present and blocked, deny access
    if (origin || referer) {
        const originHostname = origin ? extractHostname(origin) : null;
        const refererHostname = referer ? extractHostname(referer) : null;
        
        if ((originHostname && isHostnameBlocked(originHostname)) || 
            (refererHostname && isHostnameBlocked(refererHostname))) {
            return createPermissionDeniedResponse(request);
        }
    }
    
    try {
        // Try static assets binding first (bundled at deploy, no KV writes needed)
        if (env.ASSETS) {
            const assetUrl = new URL(request.url);
            assetUrl.pathname = '/' + filename;
            const assetRes = await env.ASSETS.fetch(new Request(assetUrl.toString(), { headers: request.headers }));
            if (assetRes.ok) {
                const body = await assetRes.text();
                return new Response(body, {
                    status: 200,
                    headers: { 'Content-Type': contentType, ...corsHeaders(request) }
                });
            }
        }

        // Fall back to KV store
        const content = await env.KV_STORE.get(filename, { type: 'text' });
        
        if (!content) {
            // Fallback response for HTML
            if (contentType === 'text/html') {
                return new Response(`
                    <!DOCTYPE html>
                    <html>
                    <head>
                        <title>Movie API</title>
                        <style>
                            body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
                            h1 { color: #333; }
                            pre { background: #f5f5f5; padding: 10px; border-radius: 5px; }
                        </style>
                    </head>
                    <body>
                        <h1>?? Movie API</h1>
                        <p>API is running successfully!</p>
                        <p>File <strong>${filename}</strong> was not found in KV store.</p>
                        <p>Please upload it using:</p>
                        <pre>wrangler kv:key put --binding=KV_STORE "${filename}" --path ./${filename}</pre>
                        
                        <h2>?? Available Endpoints:</h2>
                        <ul>
                            <li><a href="/">Homepage</a></li>
                            <li><a href="/docs">Documentation</a></li>
                            <li><a href="/sample-homepage-data">Sample Homepage Data</a></li>
                            <li><a href="/sample-trending-data">Sample Trending Data</a></li>
                            <li><a href="/sample-search-data">Sample Search Data</a></li>
                            <li><a href="/sample-filter-data">Sample Filter Data</a></li>
                            <li><a href="/sample-schedule-data">Sample Schedule Data</a></li>
                            <li><a href="/sample-info-data">Sample Info Data</a></li>
                            <li><a href="/sample-sources-data">Sample Sources Data</a></li>
                        </ul>
                    </body>
                    </html>
                `, {
                    status: 404,
                    headers: {
                        'Content-Type': 'text/html',
                        ...corsHeaders(request)
                    }
                });
            }
            
            // Fallback response for JSON
            return new Response(JSON.stringify({
                status: 404,
                success: false,
                creator: 'DaraTech',
                message: `File ${filename} not found in KV store. Please upload it using: wrangler kv:key put --binding=KV_STORE "${filename}" --path ./${filename}`
            }), {
                status: 404,
                headers: {
                    'Content-Type': 'application/json',
                    ...corsHeaders(request)
                }
            });
        }
        
        return new Response(content, {
            headers: {
                'Content-Type': contentType,
                'Cache-Control': 'public, max-age=3600',
                ...corsHeaders(request)
            }
        });
    } catch (error) {
        console.error(`Error serving ${filename}:`, error);
        
        // Error response
        if (contentType === 'text/html') {
            return new Response(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Error - Movie API</title>
                </head>
                <body>
                    <h1>Error Loading ${filename}</h1>
                    <p>${error.message}</p>
                </body>
                </html>
            `, {
                status: 500,
                headers: {
                    'Content-Type': 'text/html',
                    ...corsHeaders(request)
                }
            });
        }
        
        return new Response(JSON.stringify({
            status: 500,
            success: false,
            creator: 'DaraTech',
            message: `Error loading ${filename}: ${error.message}`
        }), {
            status: 500,
            headers: {
                'Content-Type': 'application/json',
                ...corsHeaders(request)
            }
        });
    }
}

// ─── Minimal STORE-mode ZIP builder (no deps, works in CF Workers) ─────────────
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
    // files: [{name: string, data: Uint8Array}]
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

// ─── Manga (RosyScans) scraper ─────────────────────────────────────────────────
const MANGA_SITE  = 'https://rosyscans.id';
const MANGA_PROXY = 'https://cors.caliph.my.id';
const MANGA_UA    = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36';

function mgProxied(pathOrUrl) {
    const abs = pathOrUrl.startsWith('http') ? pathOrUrl : `${MANGA_SITE}${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}`;
    return `${MANGA_PROXY}/${abs}`;
}
async function mgFetch(pathOrUrl) {
    const res = await fetch(mgProxied(pathOrUrl), {
        headers: { 'User-Agent': MANGA_UA, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
    });
    if (!res.ok) throw new Error(`Manga fetch HTTP ${res.status}`);
    return res.text();
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
function mgPage(v) { const n=parseInt(v,10); return Number.isFinite(n)&&n>0?n:1; }
function mgJsonRes(data, request) { return createJsonResponse({ status:200, success:true, creator:'DaraTech', results:data }, 200, false, request); }
function mgErrRes(e, request, code=502) { return createJsonResponse({ status:code, success:false, creator:'DaraTech', message: e.message||'Manga fetch failed' }, code, false, request); }

export default {
    async fetch(request, env, ctx) {
        // Make env available to v3EnsureToken (KV token read/write) and other helpers.
        _workerEnv = env;
        const url = new URL(request.url);
        const start = Date.now();
        const resp = await handleFetchInner(request, env, ctx, url);
        if (url.pathname.startsWith('/api/')) {
            requestLog.unshift({
                ts: new Date().toISOString(),
                method: request.method,
                path: url.pathname + url.search,
                status: resp.status,
                ms: Date.now() - start
            });
            if (requestLog.length > MAX_REQUEST_LOGS) requestLog.pop();
        }
        return resp;
    }
};

async function handleFetchInner(request, env, ctx, url) {
    if (request.method === 'OPTIONS') {
        // Always allow OPTIONS preflight with proper CORS headers
        const origin = request.headers.get('origin');
        const headers = {
            'Access-Control-Allow-Origin': origin || '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Origin, X-Requested-With, Content-Type, Accept, Authorization, Range',
            'Access-Control-Max-Age': '86400'
        };
        return new Response(null, { headers });
    }

    // Check origin for API requests (exclude homepage, docs, admin, request-key, try pages, and sample files)
    if (url.pathname !== '/' &&
        url.pathname !== '/docs' &&
        url.pathname !== '/changelog' &&
        url.pathname !== '/request-key' &&
        url.pathname !== '/try' &&
        !url.pathname.startsWith('/admin') &&
        !url.pathname.startsWith('/api/changelog') &&
        !url.pathname.startsWith('/api/request-key') &&
        !url.pathname.startsWith('/try-search/') &&
        !url.pathname.startsWith('/try-trending/') &&
        !url.pathname.startsWith('/sample-') &&
        !url.pathname.startsWith('/api/v3/manga') && !checkOrigin(request)) {
        return createPermissionDeniedResponse(request);
    }

    // ── Live channels source URLs ────────────────────────────────────────────────
    const IPTV_CHANNELS_URL = 'https://iptv-org.github.io/api/channels.json';
    const IPTV_STREAMS_URL  = 'https://iptv-org.github.io/api/streams.json';

    try {
        // Serve homepage
        if (url.pathname === '/') {
            return await serveFile('index.html', 'text/html', request, env);
        }

        if (url.pathname === '/google2917089f3d6caa19.html') {
            return await serveFile('google2917089f3d6caa19.html', 'text/html', request, env);
        }

        // Serve documentation
        if (url.pathname === '/docs') {
            return await serveFile('docs.html', 'text/html', request, env);
        }

        // Search engines should only crawl the public product and documentation pages.
        if (url.pathname === '/robots.txt') {
            return await serveFile('robots.txt', 'text/plain; charset=utf-8', request, env);
        }

        if (url.pathname === '/sitemap.xml') {
            return await serveFile('sitemap.xml', 'application/xml; charset=utf-8', request, env);
        }

        // Serve changelog page
        if (url.pathname === '/changelog') {
            return await serveFile('changelog.html', 'text/html', request, env);
        }

        // GET /api/changelog — public changelog feed
        if (url.pathname === '/api/changelog' && request.method === 'GET') {
            const raw = await env.KV_STORE.get('changelog', { type: 'json' });
            let entries = Array.isArray(raw) && raw.length > 0 ? raw : CHANGELOG_FALLBACK;
            entries = [...entries].sort((a, b) => new Date(b.date) - new Date(a.date));
            return createJsonResponse({ total: entries.length, results: entries }, 200, false, request);
        }

        // ─── Admin panel ────────────────────────────────────────────────────────────
        if (url.pathname === '/admin') {
            return await serveFile('admin.html', 'text/html', request, env);
        }

        if (url.pathname === '/admin/stats') {
            return await serveFile('stats.html', 'text/html', request, env);
        }

        if (url.pathname === '/request-key') {
            return await serveFile('request-key.html', 'text/html', request, env);
        }

        if (url.pathname === '/try') {
            return await serveFile('try.html', 'text/html', request, env);
        }

        if (url.pathname.startsWith('/admin/api/')) {
            // All /admin/api/* routes require valid ADMIN_SECRET bearer token
            if (!checkAdminAuth(request, env)) {
                return createJsonResponse({ status: 401, success: false, message: 'Unauthorized — check admin password' }, 401, false, request);
            }

            // POST /admin/api/generate — generate a new random key string
            if (url.pathname === '/admin/api/generate' && request.method === 'POST') {
                const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
                const rand = Array.from({ length: 20 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
                return createJsonResponse({ key: `runflix_${rand}` }, 200, false, request);
            }

            // GET /admin/api/keys — list all keys from KV
            if (url.pathname === '/admin/api/keys' && request.method === 'GET') {
                const listing = await env.KV_STORE.list({ prefix: 'apikey:' });
                const entries = await Promise.all(
                    listing.keys
                        .filter(k => !k.name.endsWith('__ping__'))
                        .map(async ({ name }) => {
                            const data = await env.KV_STORE.get(name, { type: 'json' });
                            return [name.slice('apikey:'.length), data];
                        })
                );
                const result = Object.fromEntries(entries.filter(([, v]) => v !== null));
                return createJsonResponse(result, 200, false, request);
            }

            // POST /admin/api/keys — add a new key
            if (url.pathname === '/admin/api/keys' && request.method === 'POST') {
                const body = await request.json().catch(() => ({}));
                const { key, owner, domains } = body;
                if (!key || !owner) {
                    return createJsonResponse({ error: 'key and owner are required' }, 400, false, request);
                }
                const existing = await env.KV_STORE.get(`apikey:${key}`);
                if (existing) {
                    return createJsonResponse({ error: 'Key already exists' }, 409, false, request);
                }
                const entry = {
                    owner: owner.trim(),
                    domains: Array.isArray(domains) ? domains : String(domains || '').split(',').map(d => d.trim()).filter(Boolean),
                    createdAt: new Date().toISOString()
                };
                await env.KV_STORE.put(`apikey:${key}`, JSON.stringify(entry));
                kvKeyCache.delete(key); // bust the 30s in-memory cache
                return createJsonResponse({ ok: true, key }, 200, false, request);
            }

            // DELETE /admin/api/keys/:key — revoke a key
            if (url.pathname.startsWith('/admin/api/keys/') && request.method === 'DELETE') {
                const key = decodeURIComponent(url.pathname.slice('/admin/api/keys/'.length));
                await env.KV_STORE.delete(`apikey:${key}`);
                kvKeyCache.delete(key);
                return createJsonResponse({ ok: true }, 200, false, request);
            }

            // GET /admin/api/stats — per-key request counts
            if (url.pathname === '/admin/api/stats' && request.method === 'GET') {
                // Get all keys to attach owner names to stats
                const [statsListing, keysListing] = await Promise.all([
                    env.KV_STORE.list({ prefix: 'statskey:' }),
                    env.KV_STORE.list({ prefix: 'apikey:' })
                ]);
                const keyMeta = {};
                await Promise.all(keysListing.keys.map(async ({ name }) => {
                    const data = await env.KV_STORE.get(name, { type: 'json' });
                    if (data) keyMeta[name.slice('apikey:'.length)] = data;
                }));
                const entries = await Promise.all(statsListing.keys.map(async ({ name }) => {
                    const key = name.slice('statskey:'.length);
                    const data = await env.KV_STORE.get(name, { type: 'json' });
                    return [key, { ...(data || {}), owner: keyMeta[key]?.owner || null }];
                }));
                return createJsonResponse(Object.fromEntries(entries.filter(([, v]) => v !== null)), 200, false, request);
            }

            // GET /admin/api/requests — list pending key requests
            if (url.pathname === '/admin/api/requests' && request.method === 'GET') {
                const listing = await env.KV_STORE.list({ prefix: 'keyrequest:' });
                const entries = await Promise.all(listing.keys.map(async ({ name }) => {
                    return await env.KV_STORE.get(name, { type: 'json' });
                }));
                const sorted = entries.filter(Boolean).sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
                return createJsonResponse(sorted, 200, false, request);
            }

            // DELETE /admin/api/requests?id=xxx — dismiss a request
            if (url.pathname === '/admin/api/requests' && request.method === 'DELETE') {
                const id = url.searchParams.get('id');
                if (id) {
                    await env.KV_STORE.delete(`keyrequest:${id}`);
                    return createJsonResponse({ ok: true }, 200, false, request);
                }
                return createJsonResponse({ error: 'id param required' }, 400, false, request);
            }

            // ── Changelog CRUD ────────────────────────────────────────────────────

            // PUT /admin/api/changelog/bulk — replace all entries at once (seed from local)
            if (url.pathname === '/admin/api/changelog/bulk' && request.method === 'PUT') {
                const body = await request.json().catch(() => null);
                if (!Array.isArray(body)) {
                    return createJsonResponse({ error: 'Expected a JSON array of entries' }, 400, false, request);
                }
                await env.KV_STORE.put('changelog', JSON.stringify(body));
                return createJsonResponse({ ok: true, count: body.length }, 200, false, request);
            }

            // GET /admin/api/changelog — list all entries
            if (url.pathname === '/admin/api/changelog' && request.method === 'GET') {
                const entries = (await env.KV_STORE.get('changelog', { type: 'json' })) || [];
                return createJsonResponse(Array.isArray(entries) ? entries : [], 200, false, request);
            }

            // POST /admin/api/changelog — add new entry
            if (url.pathname === '/admin/api/changelog' && request.method === 'POST') {
                const body = await request.json().catch(() => ({}));
                const { version, type, date, title, description, changes } = body;
                if (!version || !title) {
                    return createJsonResponse({ error: 'version and title are required' }, 400, false, request);
                }
                const existing = (await env.KV_STORE.get('changelog', { type: 'json' })) || [];
                const entry = {
                    id: 'cl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
                    version: version.trim(),
                    type: type || 'feature',
                    date: date || new Date().toISOString().slice(0, 10),
                    title: title.trim(),
                    description: (description || '').trim(),
                    changes: Array.isArray(changes) ? changes.filter(Boolean) : []
                };
                const updated = [entry, ...existing];
                await env.KV_STORE.put('changelog', JSON.stringify(updated));
                return createJsonResponse({ ok: true, entry }, 200, false, request);
            }

            // PUT /admin/api/changelog/:id — edit entry
            if (url.pathname.startsWith('/admin/api/changelog/') && request.method === 'PUT') {
                const id = decodeURIComponent(url.pathname.slice('/admin/api/changelog/'.length));
                const body = await request.json().catch(() => ({}));
                const { version, type, date, title, description, changes } = body;
                if (!version || !title) {
                    return createJsonResponse({ error: 'version and title are required' }, 400, false, request);
                }
                const existing = (await env.KV_STORE.get('changelog', { type: 'json' })) || [];
                const idx = existing.findIndex(e => e.id === id);
                if (idx === -1) return createJsonResponse({ error: 'Entry not found' }, 404, false, request);
                existing[idx] = {
                    ...existing[idx],
                    version: version.trim(), type: type || existing[idx].type,
                    date: date || existing[idx].date, title: title.trim(),
                    description: (description || '').trim(),
                    changes: Array.isArray(changes) ? changes.filter(Boolean) : existing[idx].changes
                };
                await env.KV_STORE.put('changelog', JSON.stringify(existing));
                return createJsonResponse({ ok: true, entry: existing[idx] }, 200, false, request);
            }

            // DELETE /admin/api/changelog/:id — remove entry
            if (url.pathname.startsWith('/admin/api/changelog/') && request.method === 'DELETE') {
                const id = decodeURIComponent(url.pathname.slice('/admin/api/changelog/'.length));
                const existing = (await env.KV_STORE.get('changelog', { type: 'json' })) || [];
                const filtered = existing.filter(e => e.id !== id);
                if (filtered.length === existing.length) {
                    return createJsonResponse({ error: 'Entry not found' }, 404, false, request);
                }
                await env.KV_STORE.put('changelog', JSON.stringify(filtered));
                return createJsonResponse({ ok: true }, 200, false, request);
            }

            return createJsonResponse({ error: 'Unknown admin route' }, 404, false, request);
        }
        // ────────────────────────────────────────────────────────────────────────────

        // POST /api/request-key — public form submission (WhatsApp notification)
        if (url.pathname === '/api/request-key' && request.method === 'POST') {
            const body = await request.json().catch(() => ({}));
            const { name, email, website, useCase } = body;
            if (!name || !useCase) {
                return createJsonResponse({ error: 'Name and use case are required' }, 400, false, request);
            }
            const id = Date.now().toString();
            await env.KV_STORE.put(`keyrequest:${id}`, JSON.stringify({
                id, name, email: email || '', website: website || '', useCase,
                submittedAt: new Date().toISOString(),
                status: 'pending'
            }));
            const ownerWa = (env.OWNER_WHATSAPP || '2348100785677').replace(/\D/g, '');
            const msg = `*New RUNFLIX API Key Request*\n\nName: ${name}\nEmail: ${email || '—'}\nWebsite: ${website || '—'}\nUse Case: ${useCase}`;
            const whatsappUrl = `https://wa.me/${ownerWa}?text=${encodeURIComponent(msg)}`;
            ctx.waitUntil(sendSmtpNotification(env, { name, email, website, useCase }));
            return createJsonResponse({ ok: true, id, whatsappUrl }, 200, false, request);
        }

        // GET /try-search/:query — free-tier search (no API key, 10/day per IP via KV)
        if (url.pathname.startsWith('/try-search/') && request.method === 'GET') {
            const query = decodeURIComponent(url.pathname.slice('/try-search/'.length)).trim();
            if (!query) return createJsonResponse({ error: 'query is required' }, 400, false, request);

            const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';
            const today = new Date().toISOString().slice(0, 10);
            const kvKey = `freetry:${ip}:${today}`;
            const used = parseInt((await env.KV_STORE.get(kvKey)) || '0', 10);
            const DAILY_LIMIT = 50;

            if (used >= DAILY_LIMIT) {
                return createJsonResponse({
                    status: 429,
                    success: false,
                    creator: 'DaraTech',
                    message: `Free tier daily limit (${DAILY_LIMIT} searches) reached. Request a full API key at /request-key.`
                }, 429, false, request);
            }

            const searchResult = await handleSearch(query, request.url, request);
            ctx.waitUntil(env.KV_STORE.put(kvKey, String(used + 1), { expirationTtl: 86400 }));
            const data = await searchResult.json();
            const items = data?.results?.items || data?.results || [];
            return createJsonResponse({
                status: 200,
                success: true,
                creator: 'DaraTech',
                freeTier: true,
                remaining: DAILY_LIMIT - used - 1,
                results: { items: items.slice(0, 10) }
            }, 200, false, request);
        }

        // GET /try-trending/ — free-tier trending browse (no quota, used for try page initial load)
        if (url.pathname === '/try-trending/' && request.method === 'GET') {
            try {
                const page = parseInt(url.searchParams.get('page')) || 0;
                const trendMirrorUrl = `https://${getRandomHost()}`;
                const resp = await makeApiRequest(`${trendMirrorUrl}/wefeed-h5-bff/web/subject/trending?page=${page}&perPage=20&uid=5591179548772780352`);
                const data = await resp.json();
                let content = processApiResponse(data);
                if (content?.subjectList && !content?.items) content.items = content.subjectList;
                const items = (content?.items || []).map(item => {
                    if (item.cover?.url) item.thumbnail = item.cover.url;
                    if (item.stills?.url && !item.thumbnail) item.thumbnail = item.stills.url;
                    return item;
                });
                return createJsonResponse({ status: 200, success: true, creator: 'DaraTech', results: { items } }, 200, false, request);
            } catch (e) {
                return createJsonResponse({ status: 500, success: false, creator: 'DaraTech', message: 'Failed to fetch trending' }, 500, false, request);
            }
        }

        // Serve sample JSON files
        if (url.pathname === '/sample-homepage-data') {
            return await serveFile('movieapi_sample_homepage.json', 'application/json', request, env);
        }

        if (url.pathname === '/sample-trending-data') {
            return await serveFile('movieapi_sample_trending.json', 'application/json', request, env);
        }

        if (url.pathname === '/sample-search-data') {
            return await serveFile('movieapi_sample_search.json', 'application/json', request, env);
        }

        if (url.pathname === '/sample-info-data') {
            return await serveFile('movieapi_sample_info.json', 'application/json', request, env);
        }

        if (url.pathname === '/sample-sources-data') {
            return await serveFile('movieapi_sample_sources.json', 'application/json', request, env);
        }

        if (url.pathname === '/sample-filter-data') {
            return await serveFile('movieapi_sample_filter.json', 'application/json', request, env);
        }

        if (url.pathname === '/sample-schedule-data') {
            return await serveFile('movieapi_sample_schedule.json', 'application/json', request, env);
        }

        if (url.pathname === '/sample-captions-data') {
            return await serveFile('movieapi_sample_captions.json', 'application/json', request, env);
        }

        if (url.pathname === '/sample-schedule-popular-data') {
            return await serveFile('movieapi_sample_schedule_popular.json', 'application/json', request, env);
        }

        if (url.pathname === '/sample-anime-data') {
            return await serveFile('movieapi_sample_anime.json', 'application/json', request, env);
        }

        if (url.pathname === '/sample-anime-search-data') {
            return await serveFile('movieapi_sample_anime_search.json', 'application/json', request, env);
        }

        if (url.pathname === '/sample-anime-info-data') {
            return await serveFile('movieapi_sample_anime_info.json', 'application/json', request, env);
        }

        if (url.pathname === '/sample-anime-sources-data') {
            return await serveFile('movieapi_sample_anime_sources.json', 'application/json', request, env);
        }

        if (url.pathname === '/sample-seasons-upcoming-data') {
            return await serveFile('movieapi_sample_seasons_upcoming.json', 'application/json', request, env);
        }

        if (url.pathname === '/sample-live-data') {
            return await serveFile('movieapi_sample_live.json', 'application/json', request, env);
        }

        if (url.pathname === '/sample-live-stream-data') {
            return await serveFile('movieapi_sample_live_stream.json', 'application/json', request, env);
        }

        if (url.pathname === '/sample-manga-home-data') {
            return await serveFile('movieapi_sample_manga_home.json', 'application/json', request, env);
        }
        if (url.pathname === '/sample-manga-search-data') {
            return await serveFile('movieapi_sample_manga_search.json', 'application/json', request, env);
        }
        if (url.pathname === '/sample-manga-genres-data') {
            return await serveFile('movieapi_sample_manga_genres.json', 'application/json', request, env);
        }
        if (url.pathname === '/sample-manga-popular-data') {
            return await serveFile('movieapi_sample_manga_popular.json', 'application/json', request, env);
        }
        if (url.pathname === '/sample-manga-details-data') {
            return await serveFile('movieapi_sample_manga_details.json', 'application/json', request, env);
        }
        if (url.pathname === '/sample-manga-chapter-data') {
            return await serveFile('movieapi_sample_manga_chapter.json', 'application/json', request, env);
        }

        // API endpoints that require API key authorization
        const apiKeyRequiredPaths = [
            '/api/v3/homepage',
            '/api/v3/trending',
            '/api/v3/search',
            '/api/v3/info',
            '/api/v3/sources',
            '/api/v3/captions',
            '/api/v3/filter',
            '/api/v3/schedule',
            '/api/v3/anime',
            '/api/v3/seasons',
            '/api/v3/live',
            '/api/v3/manga',
        ];

        // All v3 routes are authenticated and quota-checked by runtime-worker.js.
        const requiresApiKey = false;

        // Requests from whitelisted origins (runflix.name.ng and subdomains) bypass API key requirement.
        // This lets the main site call the API without embedding a key in client-side code.
        const fromAllowedOrigin = (() => {
            const origin = request.headers.get('origin');
            const referer = request.headers.get('referer');
            if (origin && isOriginAllowed(origin)) return true;
            if (referer) {
                const refOrigin = referer.split('/').slice(0, 3).join('/');
                if (isOriginAllowed(refOrigin)) return true;
            }
            return false;
        })();

        if (requiresApiKey && !fromAllowedOrigin && !await checkApiKey(request, env)) {
            return createApiKeyRequiredResponse(request);
        }

        // Track per-key usage stats non-blocking (best-effort, won't delay response)
        if (requiresApiKey) {
            const trackKey = extractRequestApiKey(request) || null;
            if (trackKey) {
                ctx.waitUntil((async () => {
                    try {
                        const sk = `statskey:${trackKey}`;
                        const prev = await env.KV_STORE.get(sk, { type: 'json' }) || { total: 0 };
                        await env.KV_STORE.put(sk, JSON.stringify({
                            total: (prev.total || 0) + 1,
                            lastSeen: new Date().toISOString()
                        }));
                    } catch (_) {}
                })());
            }
        }

        // Rate limit check (300 req/min per key)
        if (requiresApiKey) {
            const allowed = await checkRateLimit(request, env);
            if (!allowed) {
                return createJsonResponse({
                    status: 429,
                    success: false,
                    creator: 'DaraTech',
                    message: 'Rate limit exceeded. Max 300 requests per minute per API key.'
                }, 429, false, request);
            }
        }

        // API endpoint handlers
        if (url.pathname === '/api/v3/homepage') {
            return await handleHomepage(request);
        }

        if (url.pathname === '/api/v3/trending') {
            return await handleTrending(request.url, request);
        }

        if (url.pathname.startsWith('/api/v3/search/')) {
            const query = url.pathname.split('/api/v3/search/')[1];
            return await handleSearch(decodeURIComponent(query), request.url, request);
        }

        if (url.pathname === '/api/v3/filter') {
            const ck = `filter:${url.search}`;
            return await withCache(ck, 900, () => handleFilter(request.url, request));
        }

        if (url.pathname === '/api/v3/schedule/popular') {
            const ck = `schedule:popular:${url.search}`;
            return await withCache(ck, 3600, () => handleSchedulePopular(request.url, request));
        }

        if (url.pathname === '/api/v3/schedule') {
            const ck = `schedule:${url.search}`;
            return await withCache(ck, 3600, () => handleSchedule(request.url, request, env));
        }

        if (url.pathname.startsWith('/api/v3/anime/search/')) {
            const query = url.pathname.split('/api/v3/anime/search/')[1];
            const ck = `anime:search:${decodeURIComponent(query)}:${url.search}`;
            return await withCache(ck, 900, () => handleAnimeSearch(decodeURIComponent(query), request.url, request));
        }

        if (url.pathname === '/api/v3/anime') {
            const ck = `anime:${url.search}`;
            return await withCache(ck, 1800, () => handleAnime(request.url, request));
        }

        if (url.pathname === '/api/v3/seasons/upcoming') {
            const ck = `seasons:upcoming:${url.search}`;
            return await withCache(ck, 3600, () => handleSeasonsUpcoming(request.url, request));
        }

        if (url.pathname.startsWith('/api/v3/anime/sources/')) {
            const movieId = url.pathname.split('/api/v3/anime/sources/')[1];
            return await handleAnimeSources(movieId, request.url, request);
        }

        if (url.pathname.startsWith('/api/v3/anime/info/')) {
            const movieId = url.pathname.split('/api/v3/anime/info/')[1];
            return await handleAnimeInfo(movieId, request);
        }

        if (url.pathname.startsWith('/api/v3/info/')) {
            const movieId = url.pathname.split('/api/v3/info/')[1];
            return await handleInfo(movieId, request);
        }

        if (url.pathname.startsWith('/api/v3/sources/')) {
            const movieId = url.pathname.split('/api/v3/sources/')[1];
            return await handleSources(movieId, request.url, request);
        }

        if (url.pathname.startsWith('/api/v3/captions/')) {
            const parts = url.pathname.split('/api/v3/captions/')[1].split('/');
            const subjectId = parts[0];
            const streamId = parts[1];
            if (!subjectId || !streamId) {
                return createErrorResponse('subjectId and streamId are required. Use /api/v3/captions/{subjectId}/{streamId}', 400, request);
            }
            return await handleCaptions(subjectId, streamId, request.url, request);
        }

        // ── Live channels (iptv-org) ────────────────────────────────────────────
        if (url.pathname.startsWith('/api/v3/live')) {

            // Verified-working supplementary streams — tested server-side June 2026.
            // CartoonNetwork.us has NO free public stream (it is pay-TV).
            // CartoonNetworkArabic.ae is the only publicly-accessible Cartoon Network stream.
            const SUPPLEMENTARY_STREAMS_W = {
                'CartoonNetworkArabic.ae': [
                    { url: 'https://shls-cartoon-net-prod-dub.shahid.net/out/v1/dc4aa87372374325a66be458f29eab0f/index.m3u8', httpReferrer: null, userAgent: null }
                ],
                'NickelodeonPlutoTV.us': [
                    { url: 'https://jmp2.uk/plu-5ca673e0d0bd6c2689c94ce3.m3u8', httpReferrer: null, userAgent: null }
                ],
                'NickelodeonTeen.fr': [
                    { url: 'https://jmp2.uk/plu-60f5fabf0721880007cd50e3.m3u8', httpReferrer: null, userAgent: null },
                    { url: 'https://jmp2.uk/plu-5f0d668b872e4400073acc68.m3u8', httpReferrer: null, userAgent: null },
                    { url: 'https://jmp2.uk/plu-5fab09a8749b1a00077d35d2.m3u8', httpReferrer: null, userAgent: null }
                ],
                'NickJrClub.us': [
                    { url: 'https://jmp2.uk/plu-6824ce95f09106f4b18f4114.m3u8', httpReferrer: null, userAgent: null },
                    { url: 'https://jmp2.uk/plu-67f3eb1c443f0671bc03ece8.m3u8', httpReferrer: null, userAgent: null },
                    { url: 'https://jmp2.uk/plu-5ddd7cb2cbb9010009b4fe32.m3u8', httpReferrer: null, userAgent: null }
                ],
                'NickJrPlutoTV.us': [
                    { url: 'https://jmp2.uk/plu-62bdb75c3afd1200079146a6.m3u8', httpReferrer: null, userAgent: null },
                    { url: 'https://jmp2.uk/plu-5ca6748a37b88b269472dad9.m3u8', httpReferrer: null, userAgent: null }
                ],
                'ToonamiAftermath.us': [
                    { url: 'http://api.toonamiaftermath.com:3000/est/playlist.m3u8',    httpReferrer: null, userAgent: null },
                    { url: 'http://api.toonamiaftermath.com:3000/movies/playlist.m3u8', httpReferrer: null, userAgent: null },
                    { url: 'http://api.toonamiaftermath.com:3000/radio/playlist.m3u8',  httpReferrer: null, userAgent: null }
                ],
                'Nickelodeon.fr': [
                    { url: 'http://151.80.18.177:86/Nickelodeon_FR/index.m3u8', httpReferrer: null, userAgent: null }
                ]
            };

            const getLiveW = async () => {
                // L1: Cloudflare Cache API — cached processed result (6 h TTL, per-datacenter)
                const cacheKey = new Request('https://cache.internal/runflix-live-channels-v3');
                const cfCache  = caches.default;
                const hit = await cfCache.match(cacheKey);
                if (hit) return hit.json();

                // L2: fetch raw data — ask CF edge to also cache upstream responses for 6 h
                const fetchOpts = { cf: { cacheEverything: true, cacheTtl: 21600 } };
                const [channels, streams] = await Promise.all([
                    fetch(IPTV_CHANNELS_URL, fetchOpts).then(r => r.json()),
                    fetch(IPTV_STREAMS_URL,  fetchOpts).then(r => r.json())
                ]);

                // Build stream map
                const streamMap = {};
                for (const s of streams) {
                    if (!s.channel || !s.url) continue;
                    if (!streamMap[s.channel]) streamMap[s.channel] = [];
                    streamMap[s.channel].push({ url: s.url, httpReferrer: s.http_referrer || null, userAgent: s.user_agent || null });
                }

                // Merge supplementary streams (prepend verified streams, skip duplicates)
                for (const [chId, extras] of Object.entries(SUPPLEMENTARY_STREAMS_W)) {
                    if (!streamMap[chId]) streamMap[chId] = [];
                    for (const s of [...extras].reverse()) {
                        if (!streamMap[chId].some(e => e.url === s.url)) streamMap[chId].unshift(s);
                    }
                }

                const result = channels
                    .filter(ch => !ch.is_nsfw && !ch.closed)
                    .map(ch => ({
                        id: ch.id, name: ch.name, altNames: ch.alt_names || [],
                        logo: ch.logo || null, country: ch.country || null,
                        languages: ch.languages || [], categories: ch.categories || [],
                        website: ch.website || null, broadcastArea: ch.broadcast_area || [],
                        streams: streamMap[ch.id] || []
                    }))
                    .filter(ch => ch.streams.length > 0);

                // Store processed result in Cache API for 6 hours (background, non-blocking)
                ctx.waitUntil(cfCache.put(cacheKey, new Response(JSON.stringify(result), {
                    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=21600' }
                })));

                return result;
            };

            // GET /api/v3/live/stream/:id
            if (url.pathname.startsWith('/api/v3/live/stream/')) {
                const channelId = decodeURIComponent(url.pathname.slice('/api/v3/live/stream/'.length)).trim();
                if (!channelId) return createErrorResponse('Channel ID is required', 400, request);
                const channels = await getLiveW();
                const channel = channels.find(c => c.id === channelId);
                if (!channel) return createErrorResponse(`Channel "${channelId}" not found`, 404, request);
                return createSuccessResponse(channel, 'Live channel stream', request);
            }

            // GET /api/v3/live/categories
            if (url.pathname === '/api/v3/live/categories') {
                const channels = await getLiveW();
                const catCount = {};
                for (const ch of channels) for (const cat of ch.categories) catCount[cat] = (catCount[cat] || 0) + 1;
                const categories = Object.entries(catCount).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
                return createSuccessResponse({ total: categories.length, categories }, 'Live channel categories', request);
            }

            // GET /api/v3/live/search/:query
            if (url.pathname.startsWith('/api/v3/live/search/')) {
                const q = decodeURIComponent(url.pathname.slice('/api/v3/live/search/'.length)).trim().toLowerCase();
                const channels = await getLiveW();
                const results = channels.filter(c => c.name.toLowerCase().includes(q) || c.altNames.some(n => n.toLowerCase().includes(q))).slice(0, 100);
                return createSuccessResponse({ total: results.length, query: q, results }, 'Live channel search', request);
            }

            // GET /api/v3/live — paginated list with filters
            if (url.pathname === '/api/v3/live') {
                let channels = await getLiveW();
                const q        = url.searchParams.get('q');
                const category = url.searchParams.get('category');
                const country  = url.searchParams.get('country');
                const lang     = url.searchParams.get('lang');
                const pageNum  = Math.max(1, parseInt(url.searchParams.get('page')) || 1);
                const limitNum = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit')) || 50));
                if (q)        channels = channels.filter(c => c.name.toLowerCase().includes(q.toLowerCase()) || c.altNames.some(n => n.toLowerCase().includes(q.toLowerCase())));
                if (category) channels = channels.filter(c => c.categories.includes(category.toLowerCase()));
                if (country)  channels = channels.filter(c => (c.country || '').toLowerCase() === country.toLowerCase());
                if (lang)     channels = channels.filter(c => c.languages.includes(lang.toLowerCase()));
                const total = channels.length;
                const start = (pageNum - 1) * limitNum;
                return createSuccessResponse({ total, page: pageNum, limit: limitNum, pages: Math.ceil(total / limitNum), results: channels.slice(start, start + limitNum) }, 'Live channels', request);
            }
        }

        // ── HLS Geo-proxy — bypass regional stream blocks ──────────────────────
        // GET /api/v3/live/proxy?url=ENCODED_URL
        // Fetches the HLS manifest from Cloudflare's edge (globally distributed),
        // rewrites all segment/sub-playlist URLs to also go through this proxy,
        // and returns the rewritten manifest. TS segments are piped as-is.
        if (url.pathname === '/api/v3/live/proxy') {
            const rawUrl = url.searchParams.get('url');
            if (!rawUrl) return createErrorResponse('?url= query parameter is required', 400, request);

            let targetUrl;
            try { targetUrl = new URL(rawUrl); }
            catch { return createErrorResponse('Invalid URL in ?url= parameter', 400, request); }

            if (!['http:', 'https:'].includes(targetUrl.protocol)) {
                return createErrorResponse('Only http/https URLs are supported', 400, request);
            }

            try {
                const upstream = await fetch(rawUrl, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Accept':     '*/*',
                        'Origin':     targetUrl.origin,
                        'Referer':    targetUrl.origin + '/'
                    },
                    redirect: 'follow'
                });

                if (!upstream.ok) {
                    return createErrorResponse(`Upstream returned HTTP ${upstream.status}`, upstream.status, request);
                }

                const ct   = upstream.headers.get('content-type') || '';
                const body = await upstream.text();
                const isM3U = ct.includes('mpegurl') || body.includes('#EXTM3U') || rawUrl.endsWith('.m3u8') || rawUrl.endsWith('.m3u');

                const corsHeaders = { 'Access-Control-Allow-Origin': '*' };

                if (isM3U) {
                    const baseUrl   = rawUrl.substring(0, rawUrl.lastIndexOf('/') + 1);
                    const proxyBase = `${url.origin}/api/v3/live/proxy?url=`;
                    const rewritten = body.split('\n').map(line => {
                        const t = line.trim();
                        if (!t || t.startsWith('#')) return line;
                        const abs = t.startsWith('http') ? t : baseUrl + t;
                        return proxyBase + encodeURIComponent(abs);
                    }).join('\n');
                    return new Response(rewritten, {
                        headers: { 'Content-Type': 'application/vnd.apple.mpegurl', ...corsHeaders }
                    });
                }

                // Binary passthrough for TS segments / key files
                const segUpstream = await fetch(rawUrl, { redirect: 'follow' });
                const buf = await segUpstream.arrayBuffer();
                return new Response(buf, {
                    headers: { 'Content-Type': ct || 'video/mp2t', ...corsHeaders }
                });

            } catch (e) {
                return createErrorResponse('Proxy error: ' + e.message, 500, request);
            }
        }

        // ── Download redirect ───────────────────────────────────────────────────
        // GET /api/v3/download?url=<encoded>&quality=360p
        // Redirects browser to the signed CDN URL for direct downloading.
        if (url.pathname === '/api/v3/download') {
            const dlUrl = url.searchParams.get('url');
            if (!dlUrl) return createErrorResponse('?url= parameter is required', 400, request);
            let target;
            try { target = new URL(dlUrl); } catch { return createErrorResponse('Invalid URL in ?url= parameter', 400, request); }
            if (!['http:', 'https:'].includes(target.protocol)) {
                return createErrorResponse('Only http/https URLs are supported', 400, request);
            }
            return Response.redirect(dlUrl, 302);
        }

        // ── Manga (RosyScans) endpoints ────────────────────────────────────────────
        if (url.pathname.startsWith('/api/v3/manga/') || url.pathname === '/api/v3/manga') {
            try {
                const p = url.pathname.replace(/\/+$/, '') || '/';

                if (p === '/api/v3/manga/home')
                    return mgJsonRes(await mgHomepage(), request);

                if (p === '/api/v3/manga/search') {
                    const q = url.searchParams.get('q')?.trim();
                    if (!q) return createJsonResponse({ status:400, success:false, creator:'DaraTech', message:"Query param 'q' required" }, 400, false, request);
                    return mgJsonRes(await mgSearch(q), request);
                }

                if (p === '/api/v3/manga/genres')
                    return mgJsonRes(await mgGenres(), request);

                if (p === '/api/v3/manga/latest') {
                    const pg = mgPage(url.searchParams.get('page'));
                    return mgJsonRes(await mgListingPage(pg>1?`/manga/page/${pg}/?order=update`:`/manga/?order=update`, pg), request);
                }

                if (p === '/api/v3/manga/popular') {
                    const pg = mgPage(url.searchParams.get('page'));
                    return mgJsonRes(await mgListingPage(pg>1?`/manga/page/${pg}/?order=popular`:`/manga/?order=popular`, pg), request);
                }

                const genreMatch = p.match(/^\/api\/v3\/manga\/genre\/([^/]+)$/);
                if (genreMatch) {
                    const pg = mgPage(url.searchParams.get('page'));
                    const slug = decodeURIComponent(genreMatch[1]);
                    return mgJsonRes(await mgListingPage(pg>1?`/genres/${slug}/page/${pg}/`:`/genres/${slug}/`, pg), request);
                }

                if (p === '/api/v3/manga/browse') {
                    const genreParam = url.searchParams.getAll('genre');
                    const pg = mgPage(url.searchParams.get('page'));
                    return mgJsonRes(await mgBrowse({ genreSlugs: genreParam, status: url.searchParams.get('status')||undefined, type: url.searchParams.get('type')||undefined, order: url.searchParams.get('order')||undefined }, pg), request);
                }

                const detailsMatch = p.match(/^\/api\/v3\/manga\/details\/([^/]+)$/);
                if (detailsMatch)
                    return mgJsonRes(await mgDetails(decodeURIComponent(detailsMatch[1])), request);

                // Chapter ZIP download (must be checked BEFORE general chapter route)
                const chapterDlMatch = p.match(/^\/api\/v3\/manga\/chapter\/(.+)\/download$/);
                if (chapterDlMatch) {
                    const slug = decodeURIComponent(chapterDlMatch[1]);
                    const { title, images } = await mgChapterImages(slug);
                    if (!images.length) throw new Error('No pages found for this chapter');
                    const imgList = images.slice(0, 30);
                    const fetched = await Promise.all(imgList.map(async (imgUrl, i) => {
                        try {
                            const r = await fetch(imgUrl, { headers: { Referer: MANGA_SITE, 'User-Agent': MANGA_UA } });
                            if (!r.ok) return null;
                            const ext = (imgUrl.split('.').pop()?.split('?')[0] || 'jpg').toLowerCase();
                            return { name: `${String(i+1).padStart(3,'0')}.${ext}`, data: new Uint8Array(await r.arrayBuffer()) };
                        } catch { return null; }
                    }));
                    const files = fetched.filter(Boolean);
                    if (!files.length) throw new Error('Could not fetch any images for this chapter');
                    const zip = buildZip(files);
                    const safe = (title||slug).replace(/[^a-z0-9\-_ ]/gi,'').trim().replace(/\s+/g,'-');
                    return new Response(zip, { status:200, headers: { 'Content-Type':'application/zip', 'Content-Disposition':`attachment; filename="${safe}.zip"`, 'Content-Length':String(zip.length), 'Access-Control-Allow-Origin':'*' } });
                }

                // Chapter page images (general)
                const chapterMatch = p.match(/^\/api\/v3\/manga\/chapter\/(.+)$/);
                if (chapterMatch)
                    return mgJsonRes(await mgChapterImages(decodeURIComponent(chapterMatch[1])), request);

                // Bulk manga download — up to 3 chapters per CF request; paginate with ?from=&to=
                const mangaDlMatch = p.match(/^\/api\/v3\/manga\/download\/([^/]+)$/);
                if (mangaDlMatch) {
                    const mSlug = decodeURIComponent(mangaDlMatch[1]);
                    const from = Math.max(1, parseInt(url.searchParams.get('from')||'1', 10));
                    const maxTo = from + 2;
                    const to   = Math.min(maxTo, parseInt(url.searchParams.get('to')||String(maxTo), 10));
                    const { title: mTitle, chapters } = await mgDetails(mSlug);
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
                            const got = await Promise.all(images.slice(0,25).map(async (imgUrl, i) => {
                                try {
                                    const r = await fetch(imgUrl, { headers: { Referer: MANGA_SITE, 'User-Agent': MANGA_UA } });
                                    if (!r.ok) return null;
                                    const ext = (imgUrl.split('.').pop()?.split('?')[0]||'jpg').toLowerCase();
                                    return { name:`chapter-${String(from+ci).padStart(3,'0')}/${String(i+1).padStart(3,'0')}.${ext}`, data: new Uint8Array(await r.arrayBuffer()) };
                                } catch { return null; }
                            }));
                            zipFiles.push(...got.filter(Boolean));
                        } catch { /* skip failed chapter */ }
                    }
                    if (!zipFiles.length) throw new Error('Could not fetch any chapter images');
                    const zip = buildZip(zipFiles);
                    const safe = (mTitle||mSlug).replace(/[^a-z0-9\-_ ]/gi,'').trim().replace(/\s+/g,'-');
                    return new Response(zip, { status:200, headers: { 'Content-Type':'application/zip', 'Content-Disposition':`attachment; filename="${safe}-chapters-${from}-to-${to}.zip"`, 'Content-Length':String(zip.length), 'Access-Control-Allow-Origin':'*' } });
                }

            } catch (e) {
                return mgErrRes(e, request, e.message?.startsWith('Invalid') ? 400 : 502);
            }
        }

        return createErrorResponse('Endpoint not found', 404, request);

    } catch (error) {
        console.error('Unhandled error:', error);
        return createErrorResponse('Internal server error', 500, request);
    }
}
