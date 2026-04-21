// ============================================================
// /api/get-user-data.js — Proxy Vercel para Edge Function
// ============================================================
//
// Por que esse arquivo existe:
//   A URL real da Edge Function nunca é exposta no front-end.
//   Este proxy é o único ponto de entrada público e aplica:
//     1. Validação de método HTTP (só GET)
//     2. Proteção CSRF via Origin + Sec-Fetch-Site
//     3. Rate limit por IP (in-memory, melhor-esforço)
//     4. Extração segura do JWT via cookie parser robusto
//     5. Proxy para Edge Function sem vazar headers internos
//
// ⚠️  Rate limit in-memory — ver save-user-data.js para contexto.
// ============================================================

// ========== CONFIGURAÇÃO ==========
const GET_DATA_EDGE_URL    = process.env.SUPABASE_GET_DATA_EDGE_URL;
const SUPABASE_ANON_KEY    = process.env.SUPABASE_ANON_KEY;
const ALLOWED_ORIGIN       = process.env.ALLOWED_ORIGIN; // kept for env check
const SUPABASE_PROJECT_REF = process.env.SUPABASE_PROJECT_REF;

const ALLOWED_ORIGINS = [
    process.env.ALLOWED_ORIGIN,
    'https://granaevo.com',
    'https://www.granaevo.com',
    'https://granaevo.vercel.app',
].filter(Boolean);
const PROXY_SECRET         = process.env.PROXY_SECRET;
const REDIS_URL            = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN          = process.env.UPSTASH_REDIS_REST_TOKEN;

const RATE_LIMIT_MAX_IP    = 20;
const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_RATE_STORE_SIZE  = 10_000;
const CACHE_TTL_SECS       = 30;   // cache de dados por usuário — reduz invocações ~95%

// ========== CACHE REDIS ==========
async function cacheGet(userId) {
    if (!REDIS_URL || !REDIS_TOKEN) return null;
    try {
        const res = await fetch(`${REDIS_URL}/get/gd:${userId}`, {
            headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
            signal:  AbortSignal.timeout(2_000),
        });
        if (!res.ok) return null;
        const data = await res.json();
        return data?.result ?? null;
    } catch { return null; }
}

async function cacheSet(userId, value) {
    if (!REDIS_URL || !REDIS_TOKEN) return;
    try {
        await fetch(`${REDIS_URL}/set/gd:${userId}`, {
            method:  'POST',
            headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
            body:    JSON.stringify({ value, ex: CACHE_TTL_SECS }),
            signal:  AbortSignal.timeout(2_000),
        });
    } catch { /* cache miss não é crítico */ }
}

// ========== RATE LIMITER IN-MEMORY ==========
const rateLimitStore = new Map();

function checkRateLimit(key, maxCount) {
    const now    = Date.now();
    const record = rateLimitStore.get(key);

    if (!record || now - record.windowStart > RATE_LIMIT_WINDOW_MS) {
        if (!record && rateLimitStore.size >= MAX_RATE_STORE_SIZE) {
            const now2 = Date.now();
            for (const [k, r] of rateLimitStore.entries()) {
                if (now2 - r.windowStart > RATE_LIMIT_WINDOW_MS) rateLimitStore.delete(k);
                if (rateLimitStore.size < MAX_RATE_STORE_SIZE) break;
            }
            if (rateLimitStore.size >= MAX_RATE_STORE_SIZE) return false;
        }
        rateLimitStore.set(key, { count: 1, windowStart: now });
        return true;
    }

    if (record.count >= maxCount) return false;
    record.count++;
    return true;
}

setInterval(() => {
    const now = Date.now();
    for (const [key, record] of rateLimitStore.entries()) {
        if (now - record.windowStart > RATE_LIMIT_WINDOW_MS * 2) {
            rateLimitStore.delete(key);
        }
    }
}, RATE_LIMIT_WINDOW_MS * 5);

// ========== HANDLER PRINCIPAL ==========

/**
 * @param {import('@vercel/node').VercelRequest}  req
 * @param {import('@vercel/node').VercelResponse} res
 */
export default async function handler(req, res) {

    // ── 1. Método HTTP ────────────────────────────────────────
    if (req.method === 'OPTIONS') {
        const preflightOrigin = ALLOWED_ORIGINS.includes(req.headers['origin'] ?? '') ? req.headers['origin'] : ALLOWED_ORIGINS[0];
        res.setHeader('Access-Control-Allow-Origin', preflightOrigin);
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.setHeader('Access-Control-Max-Age', '86400');
        return res.status(204).end();
    }

    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    // ── 2. User-Agent mínimo ──────────────────────────────────
    const userAgent = req.headers['user-agent'] ?? '';
    if (userAgent.length < 10) {
        log('warn', 'invalid_user_agent', null, null, { userAgent });
        return res.status(403).json({ error: 'Forbidden' });
    }

    // ── 3. Variáveis de ambiente obrigatórias ─────────────────
    if (!GET_DATA_EDGE_URL || !SUPABASE_ANON_KEY || !ALLOWED_ORIGIN || !SUPABASE_PROJECT_REF || !PROXY_SECRET) {
        log('error', 'env_missing', null, null, {
            missing: [
                !GET_DATA_EDGE_URL     && 'SUPABASE_GET_DATA_EDGE_URL',
                !SUPABASE_ANON_KEY     && 'SUPABASE_ANON_KEY',
                !ALLOWED_ORIGIN        && 'ALLOWED_ORIGIN',
                !SUPABASE_PROJECT_REF  && 'SUPABASE_PROJECT_REF',
                !PROXY_SECRET          && 'PROXY_SECRET',
            ].filter(Boolean)
        });
        return res.status(503).json({ error: 'Serviço indisponível' });
    }

    // ── 4. Extrai IP real ─────────────────────────────────────
    const realIp    = req.headers['x-real-ip'];
    const forwarded = req.headers['x-forwarded-for'];
    const ip = (
        typeof realIp === 'string' && realIp.trim()
            ? realIp.trim()
            : typeof forwarded === 'string'
                ? forwarded.split(',')[0].trim()
                : req.socket?.remoteAddress ?? 'unknown'
    );

    // ── 5. Proteção CSRF — Origin + Sec-Fetch-Site ────────────
    const origin    = req.headers['origin']         ?? '';
    const fetchSite = req.headers['sec-fetch-site'] ?? '';
    const fetchMode = req.headers['sec-fetch-mode'] ?? '';
    const fetchDest = req.headers['sec-fetch-dest'] ?? '';

    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
        log('warn', 'csrf_origin_blocked', ip, null, { origin, fetchSite });
        return res.status(403).json({ error: 'Forbidden' });
    }

    if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
        log('warn', 'csrf_fetchsite_blocked', ip, null, { origin, fetchSite });
        return res.status(403).json({ error: 'Forbidden' });
    }

    if (fetchMode && fetchMode !== 'cors' && fetchMode !== 'no-cors') {
        log('warn', 'csrf_fetchmode_blocked', ip, null, { origin, fetchMode });
        return res.status(403).json({ error: 'Forbidden' });
    }

    if (fetchDest && fetchDest !== 'empty') {
        log('warn', 'csrf_fetchdest_blocked', ip, null, { origin, fetchDest });
        return res.status(403).json({ error: 'Forbidden' });
    }

    // ── 6. Rate limit por IP ──────────────────────────────────
    if (!checkRateLimit(`ip:${ip}`, RATE_LIMIT_MAX_IP)) {
        log('warn', 'rate_limit_ip', ip, null, {});
        res.setHeader('Retry-After', '60');
        return res.status(429).json({ error: 'Muitas requisições. Aguarde um momento.' });
    }

    // ── 7. Extrai JWT — Authorization header (fetch) ou cookie (fallback) ──
    const authHeaderVal = req.headers['authorization'] ?? '';
    let accessToken = authHeaderVal.startsWith('Bearer ') ? authHeaderVal.slice(7).trim() : null;
    if (!accessToken) {
        const cookieHeader = req.headers['cookie'] ?? '';
        accessToken = extractSupabaseToken(cookieHeader, SUPABASE_PROJECT_REF);
    }

    if (!accessToken) {
        log('warn', 'unauthenticated', ip, null, {});
        return res.status(401).json({ error: 'Não autenticado' });
    }

    const userId = extractUserIdFromJwt(accessToken);
    log('info', 'load_attempt', ip, userId, {});

    // ── 8. Cache Redis — evita chamar a Edge Function em reloads frequentes ──
    if (userId) {
        const cached = await cacheGet(userId);
        if (cached) {
            log('info', 'load_cache_hit', ip, userId, {});
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('Cache-Control', 'no-store');
            return res.status(200).json(JSON.parse(cached));
        }
    }

    // ── 9. Repassa para a Edge Function ──────────────────────
    let edgeResponse;
    try {
        edgeResponse = await fetch(GET_DATA_EDGE_URL, {
            method:  'GET',
            headers: {
                'Authorization':   `Bearer ${accessToken}`,
                'apikey':          SUPABASE_ANON_KEY,
                'x-forwarded-for': ip,
                'x-proxy-secret':  PROXY_SECRET,
            },
            signal: AbortSignal.timeout(15_000),
        });
    } catch (err) {
        if (err.name === 'TimeoutError' || err.name === 'AbortError') {
            log('error', 'edge_timeout', ip, userId, {});
            return res.status(504).json({ error: 'Gateway Timeout' });
        }
        log('error', 'edge_error', ip, userId, { message: err.message });
        return res.status(502).json({ error: 'Bad Gateway' });
    }

    // ── 10. Cacheia resposta bem-sucedida ─────────────────────
    const edgeBody = await edgeResponse.text();

    if (edgeResponse.status === 200 && userId) {
        cacheSet(userId, edgeBody); // fire-and-forget — não bloqueia resposta
    }

    log('info', 'load_result', ip, userId, { status: edgeResponse.status });

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Cache-Control', 'no-store');

    res.status(edgeResponse.status)
       .setHeader('Content-Type', 'application/json')
       .send(edgeBody);
}

// ========== UTILITÁRIOS (idênticos a save-user-data.js) ==========

function extractSupabaseToken(cookieHeader, projectRef) {
    if (!cookieHeader) return null;

    const cookies = {};
    for (const part of cookieHeader.split(';')) {
        const idx = part.indexOf('=');
        if (idx === -1) continue;
        cookies[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
    }

    const candidates = [
        `sb-${projectRef}-auth-token`,
        'sb-access-token',
    ];

    for (const name of candidates) {
        const raw = cookies[name];
        if (!raw) continue;

        try {
            const decoded = JSON.parse(
                Buffer.from(decodeURIComponent(raw), 'base64').toString('utf8')
            );
            if (typeof decoded?.access_token === 'string') return decoded.access_token;
        } catch {
            if (raw.split('.').length === 3) return raw;
        }
    }

    return null;
}

function extractUserIdFromJwt(token) {
    try {
        const parts = token.split('.');
        if (parts.length !== 3) return null;
        const payload = JSON.parse(
            Buffer.from(parts[1], 'base64url').toString('utf8')
        );
        return typeof payload?.sub === 'string' ? payload.sub : null;
    } catch {
        return null;
    }
}

function log(level, event, ip, userId, meta) {
    const entry = JSON.stringify({
        ts:     new Date().toISOString(),
        level,
        event,
        ip:     ip     ?? 'unknown',
        userId: userId ?? 'unauthenticated',
        ...meta,
    });

    if (level === 'error')     console.error(entry);
    else if (level === 'warn') console.warn(entry);
    else                       console.log(entry);
}
