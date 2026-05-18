// /api/user-data-backup.js — Proxy Vercel para Edge Function user-data-backup
//
// GET  → lista últimos 5 snapshots do usuário (metadados, sem data)
// POST { action: "restore", snapshot_date: "YYYY-MM-DD" } → restaura snapshot
//
// Segurança:
//   • CORS + CSRF (Origin + Sec-Fetch-*)
//   • Rate limit: GET 10/min por IP | POST 3/hora por IP + 3/hora por userId
//   • Body mínimo (< 1 KB) — snapshot_date validado antes de encaminhar
//   • Invalida cache Redis após restauração bem-sucedida

const BACKUP_EDGE_URL      = process.env.SUPABASE_BACKUP_EDGE_URL
const SUPABASE_ANON_KEY    = process.env.SUPABASE_ANON_KEY
const ALLOWED_ORIGIN       = process.env.ALLOWED_ORIGIN
const SUPABASE_PROJECT_REF = process.env.SUPABASE_PROJECT_REF
const PROXY_SECRET         = process.env.PROXY_SECRET
const REDIS_URL            = process.env.UPSTASH_REDIS_REST_URL
const REDIS_TOKEN          = process.env.UPSTASH_REDIS_REST_TOKEN

const ALLOWED_ORIGINS = [
    process.env.ALLOWED_ORIGIN,
    'https://granaevo.com',
    'https://www.granaevo.com',
    'https://granaevo.vercel.app',
].filter(Boolean)

// GET: 10 req/min por IP | POST (restore): 3 req/hora por IP e por userId
const RL_GET_MAX    = 10
const RL_POST_MAX   = 3
const RL_GET_WIN    = 60_000       // 1 min
const RL_POST_WIN   = 3_600_000    // 1 hora
const MAX_RL_STORE  = 1_000

const rlStore = new Map()

function checkRL(key, max, windowMs) {
    const now = Date.now()
    const rec = rlStore.get(key)
    if (!rec || now - rec.t > windowMs) {
        if (!rec && rlStore.size >= MAX_RL_STORE) {
            for (const [k, r] of rlStore) {
                if (now - r.t > windowMs) rlStore.delete(k)
                if (rlStore.size < MAX_RL_STORE) break
            }
            if (rlStore.size >= MAX_RL_STORE) return false
        }
        rlStore.set(key, { n: 1, t: now })
        return true
    }
    if (rec.n >= max) return false
    rec.n++
    return true
}

export default async function handler(req, res) {
    const origin = req.headers['origin'] ?? ''

    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Referrer-Policy', 'same-origin')

    // CORS preflight
    if (req.method === 'OPTIONS') {
        if (!ALLOWED_ORIGINS.includes(origin)) return res.status(403).end()
        res.setHeader('Access-Control-Allow-Origin', origin)
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        res.setHeader('Access-Control-Max-Age', '86400')
        return res.status(204).end()
    }

    if (req.method !== 'GET' && req.method !== 'POST')
        return res.status(405).json({ error: 'Method Not Allowed' })

    if (!BACKUP_EDGE_URL || !SUPABASE_ANON_KEY || !ALLOWED_ORIGIN || !PROXY_SECRET)
        return res.status(503).json({ error: 'Serviço indisponível' })

    if ((req.headers['user-agent'] ?? '').length < 10)
        return res.status(403).json({ error: 'Forbidden' })

    // IP real
    const ip = (
        typeof req.headers['x-real-ip'] === 'string' && req.headers['x-real-ip'].trim()
            ? req.headers['x-real-ip'].trim()
            : typeof req.headers['x-forwarded-for'] === 'string'
                ? req.headers['x-forwarded-for'].split(',')[0].trim()
                : req.socket?.remoteAddress ?? 'unknown'
    )

    // CSRF — Origin + Sec-Fetch-*
    if (origin && !ALLOWED_ORIGINS.includes(origin))
        return res.status(403).json({ error: 'Forbidden' })
    const fs = req.headers['sec-fetch-site'] ?? ''
    const fm = req.headers['sec-fetch-mode'] ?? ''
    const fd = req.headers['sec-fetch-dest'] ?? ''
    if (fs && fs !== 'same-origin' && fs !== 'none') return res.status(403).json({ error: 'Forbidden' })
    if (fm && fm !== 'cors' && fm !== 'no-cors')     return res.status(403).json({ error: 'Forbidden' })
    if (fd && fd !== 'empty')                         return res.status(403).json({ error: 'Forbidden' })

    // Rate limit por IP
    const isPost   = req.method === 'POST'
    const rlMax    = isPost ? RL_POST_MAX : RL_GET_MAX
    const rlWin    = isPost ? RL_POST_WIN : RL_GET_WIN
    if (!checkRL(`ip:${ip}`, rlMax, rlWin)) {
        res.setHeader('Retry-After', isPost ? '3600' : '60')
        return res.status(429).json({ error: 'Muitas requisições. Aguarde.' })
    }

    // JWT
    const authHdr = req.headers['authorization'] ?? ''
    let token = authHdr.startsWith('Bearer ') ? authHdr.slice(7).trim() : null
    if (!token) token = extractToken(req.headers['cookie'] ?? '', SUPABASE_PROJECT_REF)
    if (!token) return res.status(401).json({ error: 'Não autenticado' })

    const userId = extractUserId(token)

    // ── GET: encaminha direto ────────────────────────────────────────────────
    if (req.method === 'GET') {
        let edgeRes
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
            })
        } catch (e) {
            const code = e.name === 'TimeoutError' || e.name === 'AbortError' ? 504 : 502
            return res.status(code).json({ error: code === 504 ? 'Gateway Timeout' : 'Bad Gateway' })
        }
        return res.status(edgeRes.status)
                  .setHeader('Content-Type', 'application/json')
                  .send(await edgeRes.text())
    }

    // ── POST: valida body antes de encaminhar ────────────────────────────────
    if (!(req.headers['content-type'] ?? '').includes('application/json'))
        return res.status(415).json({ error: 'Unsupported Media Type' })

    let raw
    try { raw = await readBody(req, 1024) }   // restore body é mínimo (~60 bytes)
    catch (e) {
        return res.status(e.message === 'TOO_LARGE' ? 413 : 400)
                  .json({ error: e.message === 'TOO_LARGE' ? 'Payload muito grande' : 'Body inválido' })
    }

    let parsed
    try { parsed = JSON.parse(raw) }
    catch { return res.status(400).json({ error: 'Body deve ser JSON válido' }) }

    if (parsed?.action !== 'restore')
        return res.status(400).json({ error: 'Ação inválida' })

    // Valida snapshot_date antes de encaminhar (não confia no frontend)
    if (typeof parsed?.snapshot_date !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(parsed.snapshot_date))
        return res.status(400).json({ error: 'snapshot_date inválido (esperado YYYY-MM-DD)' })

    // Rate limit por userId para restaurações (segunda camada — cobre IPs rotativos)
    if (userId && !checkRL(`uid:${userId}:restore`, RL_POST_MAX, RL_POST_WIN)) {
        res.setHeader('Retry-After', '3600')
        return res.status(429).json({ error: 'Limite de restaurações atingido. Aguarde 1 hora.' })
    }

    let edgeRes
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
            body: raw,
            signal: AbortSignal.timeout(15_000),
        })
    } catch (e) {
        const code = e.name === 'TimeoutError' || e.name === 'AbortError' ? 504 : 502
        return res.status(code).json({ error: code === 504 ? 'Gateway Timeout' : 'Bad Gateway' })
    }

    // Invalida cache Redis após restauração bem-sucedida
    if (edgeRes.status === 200 && userId && REDIS_URL && REDIS_TOKEN) {
        fetch(`${REDIS_URL}/del/gd:${userId}`, {
            method:  'POST',
            headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
            signal:  AbortSignal.timeout(2_000),
        }).catch(() => {})
    }

    return res.status(edgeRes.status)
              .setHeader('Content-Type', 'application/json')
              .send(await edgeRes.text())
}

// ── Utilitários ──────────────────────────────────────────────────────────────

function extractToken(cookieHeader, projectRef) {
    if (!cookieHeader) return null
    const cookies = {}
    for (const part of cookieHeader.split(';')) {
        const idx = part.indexOf('=')
        if (idx === -1) continue
        cookies[part.slice(0, idx).trim()] = part.slice(idx + 1).trim()
    }
    for (const name of [`sb-${projectRef}-auth-token`, 'sb-access-token']) {
        const raw = cookies[name]
        if (!raw) continue
        try {
            const d = JSON.parse(Buffer.from(decodeURIComponent(raw), 'base64').toString('utf8'))
            if (typeof d?.access_token === 'string') return d.access_token
        } catch {
            if (raw.split('.').length === 3) return raw
        }
    }
    return null
}

// Decode JWT sem verificar assinatura — APENAS para rate limiting por userId.
// Autenticação/autorização real: Edge Function via auth.getUser(token).
function extractUserId(token) {
    try {
        const parts = token.split('.')
        if (parts.length !== 3) return null
        const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
        return typeof p?.sub === 'string' ? p.sub : null
    } catch { return null }
}

function readBody(req, maxBytes) {
    return new Promise((resolve, reject) => {
        const chunks = []; let total = 0
        req.on('data', c => {
            total += c.length
            if (total > maxBytes) { req.destroy(); return reject(new Error('TOO_LARGE')) }
            chunks.push(c)
        })
        req.on('end',   () => resolve(Buffer.concat(chunks).toString('utf8')))
        req.on('error', e  => reject(e))
    })
}
