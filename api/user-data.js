// /api/user-data.js — Proxy unificado: GET (carregar) + POST (salvar)
// Consolida get-user-data.js + save-user-data.js em uma única Serverless Function
// para respeitar o limite de 12 funções do plano Hobby da Vercel.

const GET_EDGE_URL         = process.env.SUPABASE_GET_DATA_EDGE_URL;
const SAVE_EDGE_URL        = process.env.SUPABASE_EDGE_URL;
const SUPABASE_ANON_KEY    = process.env.SUPABASE_ANON_KEY;
const ALLOWED_ORIGIN       = process.env.ALLOWED_ORIGIN;
const SUPABASE_PROJECT_REF = process.env.SUPABASE_PROJECT_REF;
const PROXY_SECRET         = process.env.PROXY_SECRET;
const REDIS_URL            = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN          = process.env.UPSTASH_REDIS_REST_TOKEN;

const ALLOWED_ORIGINS = [
    process.env.ALLOWED_ORIGIN,
    'https://granaevo.com',
    'https://www.granaevo.com',
    'https://granaevo.vercel.app',
].filter(Boolean);

const RL_MAX_IP_GET    = 20;
const RL_MAX_IP_POST   = 10;
const RL_MAX_USER_POST = 8;
const RL_WINDOW_MS     = 60_000;
const MAX_STORE_SIZE   = 10_000;
const MAX_BODY_BYTES   = 5_242_880;
const MAX_PROFILES     = 200;
const MAX_JSON_DEPTH   = 8;
const MAX_KEYS_OBJ     = 50;

// ── Rate limit store compartilhado ───────────────────────────
const rlStore = new Map();

function checkRL(key, max) {
    const now = Date.now();
    const rec = rlStore.get(key);
    if (!rec || now - rec.t > RL_WINDOW_MS) {
        if (!rec && rlStore.size >= MAX_STORE_SIZE) {
            for (const [k, r] of rlStore) {
                if (now - r.t > RL_WINDOW_MS) rlStore.delete(k);
                if (rlStore.size < MAX_STORE_SIZE) break;
            }
            if (rlStore.size >= MAX_STORE_SIZE) return false;
        }
        rlStore.set(key, { n: 1, t: now });
        return true;
    }
    if (rec.n >= max) return false;
    rec.n++;
    return true;
}

setInterval(() => {
    const now = Date.now();
    for (const [k, r] of rlStore) if (now - r.t > RL_WINDOW_MS * 2) rlStore.delete(k);
}, RL_WINDOW_MS * 5);

// ── Handler principal ─────────────────────────────────────────
export default async function handler(req, res) {
    const origin = req.headers['origin'] ?? '';

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');

    // CORS preflight
    if (req.method === 'OPTIONS') {
        if (!ALLOWED_ORIGINS.includes(origin)) return res.status(403).end();
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.setHeader('Access-Control-Max-Age', '86400');
        return res.status(204).end();
    }

    if (req.method !== 'GET' && req.method !== 'POST')
        return res.status(405).json({ error: 'Method Not Allowed' });

    // Env vars
    const edgeUrl = req.method === 'GET' ? GET_EDGE_URL : SAVE_EDGE_URL;
    if (!edgeUrl || !SUPABASE_ANON_KEY || !ALLOWED_ORIGIN || !SUPABASE_PROJECT_REF || !PROXY_SECRET)
        return res.status(503).json({ error: 'Serviço indisponível' });

    // User-Agent mínimo
    if ((req.headers['user-agent'] ?? '').length < 10)
        return res.status(403).json({ error: 'Forbidden' });

    // IP real
    const ip = (
        typeof req.headers['x-real-ip'] === 'string' && req.headers['x-real-ip'].trim()
            ? req.headers['x-real-ip'].trim()
            : typeof req.headers['x-forwarded-for'] === 'string'
                ? req.headers['x-forwarded-for'].split(',')[0].trim()
                : req.socket?.remoteAddress ?? 'unknown'
    );

    // CSRF — Origin + Sec-Fetch-*
    if (origin && !ALLOWED_ORIGINS.includes(origin))
        return res.status(403).json({ error: 'Forbidden' });
    const fs = req.headers['sec-fetch-site'] ?? '';
    const fm = req.headers['sec-fetch-mode'] ?? '';
    const fd = req.headers['sec-fetch-dest'] ?? '';
    if (fs && fs !== 'same-origin' && fs !== 'none') return res.status(403).json({ error: 'Forbidden' });
    if (fm && fm !== 'cors' && fm !== 'no-cors')     return res.status(403).json({ error: 'Forbidden' });
    if (fd && fd !== 'empty')                         return res.status(403).json({ error: 'Forbidden' });

    // Rate limit IP
    const rlMax = req.method === 'GET' ? RL_MAX_IP_GET : RL_MAX_IP_POST;
    if (!checkRL(`ip:${ip}`, rlMax)) {
        res.setHeader('Retry-After', '60');
        return res.status(429).json({ error: 'Muitas requisições. Aguarde um momento.' });
    }

    // JWT
    const authHdr = req.headers['authorization'] ?? '';
    let token = authHdr.startsWith('Bearer ') ? authHdr.slice(7).trim() : null;
    if (!token) token = extractToken(req.headers['cookie'] ?? '', SUPABASE_PROJECT_REF);
    if (!token) return res.status(401).json({ error: 'Não autenticado' });

    const userId = extractUserId(token);

    // ── GET: encaminha direto ─────────────────────────────────
    if (req.method === 'GET') {
        let edgeRes;
        try {
            edgeRes = await fetch(edgeUrl, {
                method: 'GET',
                headers: {
                    'Authorization':   `Bearer ${token}`,
                    'apikey':          SUPABASE_ANON_KEY,
                    'x-forwarded-for': ip,
                    'x-proxy-secret':  PROXY_SECRET,
                },
                signal: AbortSignal.timeout(15_000),
            });
        } catch (e) {
            const code = e.name === 'TimeoutError' || e.name === 'AbortError' ? 504 : 502;
            return res.status(code).json({ error: code === 504 ? 'Gateway Timeout' : 'Bad Gateway' });
        }
        return res.status(edgeRes.status)
                  .setHeader('Content-Type', 'application/json')
                  .send(await edgeRes.text());
    }

    // ── POST: valida body, repassa ────────────────────────────
    if (!(req.headers['content-type'] ?? '').includes('application/json'))
        return res.status(415).json({ error: 'Unsupported Media Type' });

    let raw;
    try { raw = await readBody(req, MAX_BODY_BYTES); }
    catch (e) {
        return res.status(e.message === 'TOO_LARGE' ? 413 : 400)
                  .json({ error: e.message === 'TOO_LARGE' ? 'Payload excede limite' : 'Body inválido' });
    }

    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { return res.status(400).json({ error: 'Body deve ser JSON válido' }); }

    const { depth, maxKeys } = analyzeJson(parsed);
    if (depth > MAX_JSON_DEPTH)   return res.status(400).json({ error: 'JSON muito profundo' });
    if (maxKeys > MAX_KEYS_OBJ)   return res.status(400).json({ error: 'JSON com muitas chaves' });

    if (!Array.isArray(parsed?.profiles))
        return res.status(400).json({ error: 'Payload inválido: profiles deve ser um array' });
    if (parsed.profiles.length > MAX_PROFILES)
        return res.status(400).json({ error: `Limite de ${MAX_PROFILES} perfis excedido` });

    // Rate limit por userId (segunda camada — cobre IPs rotativos)
    if (userId && !checkRL(`uid:${userId}`, RL_MAX_USER_POST)) {
        res.setHeader('Retry-After', '60');
        return res.status(429).json({ error: 'Muitas requisições. Aguarde um momento.' });
    }

    let edgeRes;
    try {
        edgeRes = await fetch(edgeUrl, {
            method: 'POST',
            headers: {
                'Content-Type':    'application/json',
                'Authorization':   `Bearer ${token}`,
                'apikey':          SUPABASE_ANON_KEY,
                'x-forwarded-for': ip,
                'x-proxy-secret':  PROXY_SECRET,
            },
            body:   raw,
            signal: AbortSignal.timeout(15_000),
        });
    } catch (e) {
        const code = e.name === 'TimeoutError' || e.name === 'AbortError' ? 504 : 502;
        return res.status(code).json({ error: code === 504 ? 'Gateway Timeout' : 'Bad Gateway' });
    }

    const edgeBody = await edgeRes.text();

    // Invalida cache Redis após save bem-sucedido
    if (edgeRes.status === 200 && userId && REDIS_URL && REDIS_TOKEN) {
        fetch(`${REDIS_URL}/del/gd:${userId}`, {
            method:  'POST',
            headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
            signal:  AbortSignal.timeout(2_000),
        }).catch(() => {});
    }

    return res.status(edgeRes.status)
              .setHeader('Content-Type', 'application/json')
              .send(edgeBody);
}

// ── Utilitários ───────────────────────────────────────────────

function extractToken(cookieHeader, projectRef) {
    if (!cookieHeader) return null;
    const cookies = {};
    for (const part of cookieHeader.split(';')) {
        const idx = part.indexOf('=');
        if (idx === -1) continue;
        cookies[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
    }
    for (const name of [`sb-${projectRef}-auth-token`, 'sb-access-token']) {
        const raw = cookies[name];
        if (!raw) continue;
        try {
            const d = JSON.parse(Buffer.from(decodeURIComponent(raw), 'base64').toString('utf8'));
            if (typeof d?.access_token === 'string') return d.access_token;
        } catch {
            if (raw.split('.').length === 3) return raw;
        }
    }
    return null;
}

// Decodifica JWT sem verificar assinatura — APENAS para rate limiting por userId.
// Nunca usar para autenticação/autorização. Auth real: Edge Function via auth.getUser(token).
function extractUserId(token) {
    try {
        const parts = token.split('.');
        if (parts.length !== 3) return null;
        const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        return typeof p?.sub === 'string' ? p.sub : null;
    } catch { return null; }
}

function analyzeJson(root) {
    if (root === null || typeof root !== 'object') return { depth: 0, maxKeys: 0 };
    const stack = [[root, 1]];
    let maxDepth = 0, maxKeys = 0;
    while (stack.length) {
        const [node, depth] = stack.pop();
        if (depth > maxDepth) maxDepth = depth;
        const keys = Array.isArray(node) ? node.length : Object.keys(node).length;
        if (keys > maxKeys) maxKeys = keys;
        for (const child of (Array.isArray(node) ? node : Object.values(node))) {
            if (child !== null && typeof child === 'object') stack.push([child, depth + 1]);
        }
    }
    return { depth: maxDepth, maxKeys };
}

function readBody(req, maxBytes) {
    return new Promise((resolve, reject) => {
        const chunks = []; let total = 0;
        req.on('data', c => {
            total += c.length;
            if (total > maxBytes) { req.destroy(); return reject(new Error('TOO_LARGE')); }
            chunks.push(c);
        });
        req.on('end',   () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', e  => reject(e));
    });
}
