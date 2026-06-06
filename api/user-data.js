// /api/user-data.js — Proxy unificado: GET (carregar) + POST (salvar) + backup + push
// Consolida múltiplas operações em uma única Serverless Function
// para respeitar o limite de 12 funções do plano Hobby da Vercel.
//
// Rotas de backup:
//   GET  ?backup=1                               → lista snapshots
//   POST { action:"restore", snapshot_date }     → restaura snapshot
//
// Rotas de push notifications:
//   POST { action:"push-subscribe", endpoint, p256dh, auth, userAgent? }
//   POST { action:"push-unsubscribe", endpoint }

import { checkRate, checkRateWindow, isIPBlocked } from './_rate-limit.js'
import { logger } from './_logger.js'

const PATH = '/api/user-data'

const GET_EDGE_URL         = process.env.SUPABASE_GET_DATA_EDGE_URL;
const SAVE_EDGE_URL        = process.env.SUPABASE_EDGE_URL;
const BACKUP_EDGE_URL      = process.env.SUPABASE_BACKUP_EDGE_URL;
const SUPABASE_URL         = process.env.SUPABASE_URL ?? '';
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

const RL_MAX_IP_GET      = 20;
const RL_MAX_IP_POST     = 10;
const RL_MAX_USER_POST   = 8;
const RL_RESTORE_MAX     = 3;
const RL_RESTORE_WIN_SECS = 3_600;
const MAX_BODY_BYTES     = 5_242_880;
const MAX_PROFILES       = 200;
const MAX_JSON_DEPTH     = 8;
const MAX_KEYS_OBJ       = 50;

// checkRL usa _rate-limit.js (Redis distribuído quando disponível, in-memory fallback).
// Elimina o rlStore Map local que não persiste entre instâncias serverless da Vercel.
async function checkRL(key, max, windowSecs = 60) {
    return checkRateWindow(key, max, windowSecs);
}

// ── Handler principal ─────────────────────────────────────────
export default async function handler(req, res) {
    const origin = req.headers['origin'] ?? '';
    const ct     = req.headers['content-type'] ?? '';

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');

    // ── CSP Report handler (consolidado de csp-report.js) ─────
    // Detectado por Content-Type antes de qualquer outra lógica.
    // O vercel.json redireciona /api/csp-report → /api/user-data via rewrite.
    if (req.method === 'POST' && (ct.includes('application/csp-report') || ct.includes('application/reports+json'))) {
        if (req.method !== 'POST') return res.status(405).end();
        const ip = (req.headers['x-real-ip'] ?? req.headers['x-forwarded-for'] ?? 'unknown')
            .toString().split(',')[0].trim();
        if (!await checkRL(`csp-report:${ip}`, 30)) return res.status(429).end();
        let raw = '';
        try {
            raw = await new Promise((resolve, reject) => {
                const chunks = []; let total = 0;
                req.on('data', chunk => {
                    total += chunk.length;
                    if (total > 4096) { req.destroy(); return reject(new Error('TOO_LARGE')); }
                    chunks.push(chunk);
                });
                req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
                req.on('error', reject);
            });
        } catch { return res.status(413).end(); }
        let report;
        try { const parsed = JSON.parse(raw); report = parsed['csp-report'] ?? parsed; }
        catch { return res.status(400).end(); }
        logger.warn('csp_violation', PATH, {
            blocked_uri:  report['blocked-uri']        ?? report.blockedURI        ?? 'unknown',
            violated:     report['violated-directive']  ?? report.violatedDirective  ?? 'unknown',
            effective:    report['effective-directive'] ?? report.effectiveDirective ?? 'unknown',
            document_uri: report['document-uri']        ?? report.documentURI        ?? 'unknown',
            ip,
        });
        return res.status(204).end();
    }

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

    // Blocklist persistente — IPs bloqueados por atingirem thresholds de ataque
    if (await isIPBlocked(ip)) {
        logger.warn('ip_blocked', PATH, { ip });
        return res.status(403).json({ error: 'Forbidden' });
    }

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
    if (!await checkRL(`ip:${ip}`, rlMax)) {
        res.setHeader('Retry-After', '60');
        return res.status(429).json({ error: 'Muitas requisições. Aguarde um momento.' });
    }

    // JWT
    const authHdr = req.headers['authorization'] ?? '';
    let token = authHdr.startsWith('Bearer ') ? authHdr.slice(7).trim() : null;
    if (!token) token = extractToken(req.headers['cookie'] ?? '', SUPABASE_PROJECT_REF);
    if (!token) return res.status(401).json({ error: 'Não autenticado' });

    const userId = extractUserId(token);

    // ── GET ?backup=1: lista snapshots (metadados) ───────────────
    if (req.method === 'GET' && req.query?.backup === '1') {
        if (!BACKUP_EDGE_URL) return res.status(503).json({ error: 'Serviço indisponível' });
        let edgeRes;
        try {
            edgeRes = await fetch(BACKUP_EDGE_URL, {
                method: 'GET',
                headers: {
                    'Authorization':   `Bearer ${token}`,
                    'apikey':          SUPABASE_ANON_KEY,
                    'x-forwarded-for': ip,
                    'x-proxy-secret':  PROXY_SECRET,
                },
                signal: AbortSignal.timeout(10_000),
            });
        } catch (e) {
            const code = e.name === 'TimeoutError' || e.name === 'AbortError' ? 504 : 502;
            return res.status(code).json({ error: code === 504 ? 'Gateway Timeout' : 'Bad Gateway' });
        }
        return res.status(edgeRes.status)
                  .setHeader('Content-Type', 'application/json')
                  .send(await edgeRes.text());
    }

    // ── GET: encaminha direto (carregar dados) ────────────────
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

    // ── POST { action:"restore" }: restaura snapshot ──────────
    if (parsed?.action === 'restore') {
        if (!BACKUP_EDGE_URL) return res.status(503).json({ error: 'Serviço indisponível' });
        if (typeof parsed?.snapshot_date !== 'string' ||
            !/^\d{4}-\d{2}-\d{2}$/.test(parsed.snapshot_date))
            return res.status(400).json({ error: 'snapshot_date inválido (esperado YYYY-MM-DD)' });

        if (!await checkRL(`ip:${ip}:restore`, RL_RESTORE_MAX, RL_RESTORE_WIN_SECS)) {
            res.setHeader('Retry-After', '3600');
            return res.status(429).json({ error: 'Limite de restaurações atingido. Aguarde 1 hora.' });
        }
        if (userId && !await checkRL(`uid:${userId}:restore`, RL_RESTORE_MAX, RL_RESTORE_WIN_SECS)) {
            res.setHeader('Retry-After', '3600');
            return res.status(429).json({ error: 'Limite de restaurações atingido. Aguarde 1 hora.' });
        }

        let edgeRes;
        try {
            edgeRes = await fetch(BACKUP_EDGE_URL, {
                method: 'POST',
                headers: {
                    'Content-Type':    'application/json',
                    'Authorization':   `Bearer ${token}`,
                    'apikey':          SUPABASE_ANON_KEY,
                    'x-forwarded-for': ip,
                    'x-proxy-secret':  PROXY_SECRET,
                },
                body: JSON.stringify({ action: 'restore', snapshot_date: parsed.snapshot_date }),
                signal: AbortSignal.timeout(15_000),
            });
        } catch (e) {
            const code = e.name === 'TimeoutError' || e.name === 'AbortError' ? 504 : 502;
            return res.status(code).json({ error: code === 504 ? 'Gateway Timeout' : 'Bad Gateway' });
        }

        if (edgeRes.status === 200 && userId && REDIS_URL && REDIS_TOKEN) {
            fetch(`${REDIS_URL}/del/gd:${userId}`, {
                method:  'POST',
                headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
                signal:  AbortSignal.timeout(2_000),
            }).catch(() => {});
        }

        return res.status(edgeRes.status)
                  .setHeader('Content-Type', 'application/json')
                  .send(await edgeRes.text());
    }

    // ── POST { action:"push-subscribe" | "push-unsubscribe" } ──
    if (parsed?.action === 'push-subscribe' || parsed?.action === 'push-unsubscribe') {
        const isSubscribe = parsed.action === 'push-subscribe'
        const efName      = isSubscribe ? 'save-push-subscription' : 'delete-push-subscription'
        const efUrl       = `${SUPABASE_URL}/functions/v1/${efName}`

        if (!SUPABASE_URL) return res.status(503).json({ error: 'Serviço indisponível' })

        // Rate limit específico para push (mais restritivo — operação de baixa frequência)
        if (!await checkRL(`push:${ip}`, 10)) {
            res.setHeader('Retry-After', '60')
            return res.status(429).json({ error: 'Muitas requisições. Aguarde.' })
        }

        // Validação dos campos obrigatórios
        if (typeof parsed?.endpoint !== 'string' || !parsed.endpoint.startsWith('https://')) {
            return res.status(400).json({ error: 'endpoint inválido' })
        }
        if (isSubscribe) {
            if (typeof parsed.p256dh !== 'string' || parsed.p256dh.length < 10)
                return res.status(400).json({ error: 'p256dh inválido' })
            if (typeof parsed.auth !== 'string' || parsed.auth.length < 10)
                return res.status(400).json({ error: 'auth inválido' })
        }

        // Payload seguro — anti-mass-assignment
        const safePayload = isSubscribe
            ? {
                endpoint:  parsed.endpoint.slice(0, 512),
                p256dh:    parsed.p256dh.slice(0, 256),
                auth:      parsed.auth.slice(0, 64),
                userAgent: typeof parsed.userAgent === 'string' ? parsed.userAgent.slice(0, 256) : undefined,
              }
            : { endpoint: parsed.endpoint.slice(0, 512) }

        let efRes
        try {
            efRes = await fetch(efUrl, {
                method:  'POST',
                headers: {
                    'Content-Type':    'application/json',
                    'Authorization':   `Bearer ${token}`,
                    'apikey':          SUPABASE_ANON_KEY,
                    'x-forwarded-for': ip,
                    'x-proxy-secret':  PROXY_SECRET,
                },
                body:   JSON.stringify(safePayload),
                signal: AbortSignal.timeout(10_000),
            })
        } catch (e) {
            const code = e.name === 'TimeoutError' || e.name === 'AbortError' ? 504 : 502
            logger.error('gateway_error', PATH, { action: parsed.action, ip, error: e?.message })
            return res.status(code).json({ error: code === 504 ? 'Gateway Timeout' : 'Bad Gateway' })
        }

        return res.status(efRes.status)
                  .setHeader('Content-Type', 'application/json')
                  .send(await efRes.text())
    }

    // ── POST (salvar dados): valida profiles ──────────────────
    const { depth, maxKeys } = analyzeJson(parsed);
    if (depth > MAX_JSON_DEPTH)   return res.status(400).json({ error: 'JSON muito profundo' });
    if (maxKeys > MAX_KEYS_OBJ)   return res.status(400).json({ error: 'JSON com muitas chaves' });

    if (!Array.isArray(parsed?.profiles))
        return res.status(400).json({ error: 'Payload inválido: profiles deve ser um array' });
    if (parsed.profiles.length > MAX_PROFILES)
        return res.status(400).json({ error: `Limite de ${MAX_PROFILES} perfis excedido` });

    // Rate limit por userId (segunda camada — cobre IPs rotativos)
    if (userId && !await checkRL(`uid:${userId}`, RL_MAX_USER_POST)) {
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
