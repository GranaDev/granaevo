// ============================================================
// /api/save-user-data.js — Proxy Vercel para Edge Function
// ============================================================
//
// Por que esse arquivo existe:
//   A URL real da Edge Function nunca é exposta no front-end.
//   Este proxy é o único ponto de entrada público e aplica:
//     1. Validação de método HTTP (só POST)
//     2. Proteção CSRF via Origin + Sec-Fetch-Site
//     3. Rate limit por IP  (in-memory, melhor-esforço)
//     4. Rate limit por userId (segunda camada, pós-autenticação)
//     5. Extração segura do JWT via cookie parser robusto
//     6. Leitura de body com limite de tamanho
//     7. Validação de JSON + profundidade máxima (anti CPU-spike)
//     8. Validação estrutural do payload (profiles)
//     9. Logging estruturado para detecção de ataques
//    10. Proxy para Edge Function sem vazar headers internos
//
// ⚠️  Rate limit in-memory — limitação conhecida:
//   Cada instância serverless da Vercel tem seu próprio Map.
//   Em scaling horizontal, o limite efetivo é N × RATE_LIMIT_MAX.
//   Para rate limit global real, migre para Vercel KV:
//   https://vercel.com/docs/storage/vercel-kv
// ============================================================

// ========== CONFIGURAÇÃO (via env vars — nunca hardcoded) ==========
const EDGE_FUNCTION_URL    = process.env.SUPABASE_EDGE_URL;
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

const RATE_LIMIT_MAX_IP    = 10;      // requests por IP por janela
const RATE_LIMIT_MAX_USER  = 8;       // requests por userId por janela (mais restritivo)
const RATE_LIMIT_WINDOW_MS = 60_000;  // janela de 60 segundos
const MAX_BODY_BYTES       = 5_242_880; // 5MB — sendBeacon usa ≤60KB, fetch regular pode usar até 4.9MB
const MAX_PROFILES_PROXY   = 200;     // espelha MAX_PROFILES do front-end
const MAX_JSON_DEPTH       = 8;       // profundidade máxima do JSON (anti stack-overflow)
const MAX_KEYS_PER_OBJECT  = 50;      // máximo de chaves por objeto JSON (anti GC-pressure)
const MAX_RATE_STORE_SIZE  = 10_000;  // cap do Map de rate limit (anti memory churn)

// ========== RATE LIMITER IN-MEMORY (dupla camada: IP + userId) ==========

// Map<key, { count: number, windowStart: number }>
const rateLimitStore = new Map();

/**
 * Verifica e incrementa o contador de rate limit para uma chave.
 * Retorna true se dentro do limite, false se excedeu.
 *
 * @param {string} key       IP ou userId
 * @param {number} maxCount  Limite máximo de requests na janela
 * @returns {boolean}
 */
function checkRateLimit(key, maxCount) {
    const now    = Date.now();
    const record = rateLimitStore.get(key);

    if (!record || now - record.windowStart > RATE_LIMIT_WINDOW_MS) {
        // ✅ FIX: Cap no tamanho do Map — impede crescimento ilimitado via IP spoofing.
        //    Se o Map já atingiu o limite, limpa entradas expiradas antes de inserir.
        //    Em último caso (Map cheio e nada expirado), rejeita o novo IP.
        if (!record && rateLimitStore.size >= MAX_RATE_STORE_SIZE) {
            const now2 = Date.now();
            for (const [k, r] of rateLimitStore.entries()) {
                if (now2 - r.windowStart > RATE_LIMIT_WINDOW_MS) rateLimitStore.delete(k);
                if (rateLimitStore.size < MAX_RATE_STORE_SIZE) break;
            }
            if (rateLimitStore.size >= MAX_RATE_STORE_SIZE) return false; // rejeita
        }
        rateLimitStore.set(key, { count: 1, windowStart: now });
        return true;
    }

    if (record.count >= maxCount) return false;

    record.count++;
    return true;
}

// Limpeza periódica — evita memory leak em instâncias de longa duração
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
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.setHeader('Access-Control-Max-Age', '86400');
        return res.status(204).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    // ── 2. Content-Type ───────────────────────────────────────
    // Exige application/json — rejeita text/plain, form-data, etc.
    // sendBeacon e fetch() do front-end sempre enviam application/json.
    const contentType = req.headers['content-type'] ?? '';
    if (!contentType.includes('application/json')) {
        log('warn', 'invalid_content_type', null, null, { contentType });
        return res.status(415).json({ error: 'Unsupported Media Type' });
    }

    // ── 3. User-Agent mínimo ──────────────────────────────────
    // Bots simples e scripts curl sem configuração enviam UA vazio ou muito curto.
    // Não bloqueia ataques sofisticados (UA pode ser forjado), mas aumenta o
    // custo do ataque: exige que o script configure um UA realista.
    // Mínimo de 10 chars filtra 'curl/7.x', '', '-', etc.
    const userAgent = req.headers['user-agent'] ?? '';
    if (userAgent.length < 10) {
        log('warn', 'invalid_user_agent', null, null, { userAgent });
        return res.status(403).json({ error: 'Forbidden' });
    }

    // ── 4. Variáveis de ambiente obrigatórias ─────────────────
    if (!EDGE_FUNCTION_URL || !SUPABASE_ANON_KEY || !ALLOWED_ORIGIN || !SUPABASE_PROJECT_REF || !PROXY_SECRET) {
        log('error', 'env_missing', null, null, {
            missing: [
                !EDGE_FUNCTION_URL      && 'SUPABASE_EDGE_URL',
                !SUPABASE_ANON_KEY      && 'SUPABASE_ANON_KEY',
                !ALLOWED_ORIGIN         && 'ALLOWED_ORIGIN',
                !SUPABASE_PROJECT_REF   && 'SUPABASE_PROJECT_REF',
                !PROXY_SECRET           && 'PROXY_SECRET',
            ].filter(Boolean)
        });
        return res.status(503).json({ error: 'Serviço indisponível' });
    }

    // ── 5. Extrai IP real ─────────────────────────────────────
    // ✅ FIX: Prioriza x-real-ip (injetado pela Vercel, não falsificável pelo cliente)
    //    sobre x-forwarded-for (pode ser forjado com header extra pelo cliente).
    //    Fallback para socket.remoteAddress como último recurso.
    const realIp     = req.headers['x-real-ip'];
    const forwarded  = req.headers['x-forwarded-for'];
    const ip = (
        typeof realIp === 'string' && realIp.trim()
            ? realIp.trim()
            : typeof forwarded === 'string'
                ? forwarded.split(',')[0].trim()
                : req.socket?.remoteAddress ?? 'unknown'
    );

    // ── 6. Proteção CSRF — Origin + Sec-Fetch-Site ────────────
    //
    //    Por que Origin E Sec-Fetch-Site?
    //    - Origin: presente em todos os browsers modernos para requests cross-origin.
    //      Bloqueia formulários HTML de outros domínios e bots básicos.
    //    - Sec-Fetch-Site: header de metadados de fetch, mais difícil de forjar.
    //      Browsers enviam automaticamente; ferramentas como curl não enviam.
    //    - Juntos formam defesa em camadas: um bot precisa forjar AMBOS.
    //
    //    Nota: sendBeacon e fetch do mesmo domínio enviam Origin corretamente.
    const origin    = req.headers['origin']          ?? '';
    const fetchSite = req.headers['sec-fetch-site']  ?? '';
    const fetchMode = req.headers['sec-fetch-mode']  ?? '';
    const fetchDest = req.headers['sec-fetch-dest']  ?? '';

    // ✅ Bloco CSRF em camadas — um bot precisa forjar TODOS os headers simultaneamente:
    //
    //  1. Origin: presente em todos os browsers para requests cross-origin.
    //     curl sem -H 'Origin: ...' envia sem Origin — bloqueado aqui.
    if (!ALLOWED_ORIGINS.includes(origin)) {
        log('warn', 'csrf_origin_blocked', ip, null, { origin, fetchSite, fetchMode, fetchDest });
        return res.status(403).json({ error: 'Forbidden' });
    }

    //  2. Sec-Fetch-Site: 'same-origin' para fetch/beacon do mesmo domínio.
    //     Presente apenas em browsers reais — curl/axios não enviam por padrão.
    if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
        log('warn', 'csrf_fetchsite_blocked', ip, null, { origin, fetchSite, fetchMode, fetchDest });
        return res.status(403).json({ error: 'Forbidden' });
    }

    //  3. Sec-Fetch-Mode: fetch() e sendBeacon() enviam 'cors' ou 'no-cors'.
    //     Formulários HTML enviam 'navigate' — bloqueado aqui.
    //     Header ausente ('' ) é aceito para compatibilidade com browsers mais antigos.
    if (fetchMode && fetchMode !== 'cors' && fetchMode !== 'no-cors') {
        log('warn', 'csrf_fetchmode_blocked', ip, null, { origin, fetchSite, fetchMode, fetchDest });
        return res.status(403).json({ error: 'Forbidden' });
    }

    //  4. Sec-Fetch-Dest: fetch() e sendBeacon() enviam 'empty'.
    //     Qualquer outro valor (document, iframe, image, etc.) é suspeito.
    //     Header ausente ('') é aceito para compatibilidade.
    if (fetchDest && fetchDest !== 'empty') {
        log('warn', 'csrf_fetchdest_blocked', ip, null, { origin, fetchSite, fetchMode, fetchDest });
        return res.status(403).json({ error: 'Forbidden' });
    }

    // ── 7. Rate limit por IP (primeira camada) ────────────────
    if (!checkRateLimit(`ip:${ip}`, RATE_LIMIT_MAX_IP)) {
        log('warn', 'rate_limit_ip', ip, null, {});
        res.setHeader('Retry-After', '60');
        return res.status(429).json({ error: 'Muitas requisições. Aguarde um momento.' });
    }

    // ── 8. Extrai JWT do cookie de sessão ─────────────────────
    //    Autenticação exclusivamente via cookie — nunca via body.
    const cookieHeader = req.headers['cookie'] ?? '';
    const accessToken  = extractSupabaseToken(cookieHeader, SUPABASE_PROJECT_REF);

    if (!accessToken) {
        log('warn', 'unauthenticated', ip, null, {});
        return res.status(401).json({ error: 'Não autenticado' });
    }

    // ── 9. Lê body com limite de tamanho ──────────────────────
    let rawBody;
    try {
        rawBody = await readBody(req, MAX_BODY_BYTES);
    } catch (err) {
        if (err.message === 'TOO_LARGE') {
            log('warn', 'body_too_large', ip, null, {});
            return res.status(413).json({ error: 'Payload excede limite permitido' });
        }
        log('error', 'body_read_error', ip, null, { message: err.message });
        return res.status(400).json({ error: 'Body inválido' });
    }

    // ── 10. Valida JSON + profundidade máxima ──────────────────
    //
    //    JSON aninhado profundamente (ex: 1000 níveis) é sintaticamente válido
    //    mas causa CPU spike no JSON.parse — o Node.js não tem proteção nativa.
    let parsed;
    try {
        parsed = JSON.parse(rawBody);
    } catch {
        log('warn', 'invalid_json', ip, null, {});
        return res.status(400).json({ error: 'Body deve ser JSON válido' });
    }

    // ✅ FIX: analyzeJson é iterativa — sem risco de stack overflow.
    //    Valida depth E maxKeys em uma única passagem O(n).
    const { depth: jsonDepthVal, maxKeys: jsonMaxKeys } = analyzeJson(parsed);

    if (jsonDepthVal > MAX_JSON_DEPTH) {
        log('warn', 'json_too_deep', ip, null, { depth: jsonDepthVal });
        return res.status(400).json({ error: 'Estrutura JSON excede profundidade máxima permitida' });
    }

    if (jsonMaxKeys > MAX_KEYS_PER_OBJECT) {
        log('warn', 'json_too_many_keys', ip, null, { maxKeys: jsonMaxKeys });
        return res.status(400).json({ error: 'Objeto JSON excede número máximo de chaves permitidas' });
    }

    // ── 11. Validação estrutural do payload ────────────────────
    //    Defesa em profundidade — o front-end pode ser contornado.
    if (!Array.isArray(parsed?.profiles)) {
        log('warn', 'invalid_payload_structure', ip, null, {});
        return res.status(400).json({ error: 'Payload inválido: profiles deve ser um array' });
    }

    if (parsed.profiles.length > MAX_PROFILES_PROXY) {
        log('warn', 'profiles_limit_exceeded', ip, null, { count: parsed.profiles.length });
        return res.status(400).json({ error: `Número de perfis excede o limite de ${MAX_PROFILES_PROXY}` });
    }

    // ── 12. Extrai userId do JWT para rate limit por usuário ──
    //     Decodifica apenas o payload (sem verificar assinatura).
    //     Usado SOMENTE para rate limiting, nunca para autorização.
    const userId = extractUserIdFromJwt(accessToken);

    // ── 13. Rate limit por userId (segunda camada) ────────────
    //    Cobre ataques com múltiplos IPs (botnet, proxies rotativos).
    if (userId && !checkRateLimit(`uid:${userId}`, RATE_LIMIT_MAX_USER)) {
        log('warn', 'rate_limit_user', ip, userId, {});
        res.setHeader('Retry-After', '60');
        return res.status(429).json({ error: 'Muitas requisições. Aguarde um momento.' });
    }

    // ── 14. Log da requisição legítima ────────────────────────
    log('info', 'save_attempt', ip, userId, { profiles: parsed.profiles.length });

    // ── 15. Repassa para a Edge Function ──────────────────────
    let edgeResponse;
    try {
        edgeResponse = await fetch(EDGE_FUNCTION_URL, {
            method:  'POST',
            headers: {
                'Content-Type':    'application/json',
                'Authorization':   `Bearer ${accessToken}`,
                'apikey':          SUPABASE_ANON_KEY,
                'x-forwarded-for': ip,
                'x-proxy-secret':  PROXY_SECRET,
            },
            body:   rawBody,
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

    // ── 16. Retorna resposta ──────────────────────────────────
    //    Repassa apenas status e body — nunca headers internos do Supabase.
    const edgeBody = await edgeResponse.text();

    log('info', 'save_result', ip, userId, { status: edgeResponse.status });

    // Invalida cache Redis após save bem-sucedido — dados atualizados no próximo GET
    if (edgeResponse.status === 200 && userId && REDIS_URL && REDIS_TOKEN) {
        fetch(`${REDIS_URL}/del/gd:${userId}`, {
            method:  'POST',
            headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
            signal:  AbortSignal.timeout(2_000),
        }).catch(() => {/* fire-and-forget */});
    }

    // Headers defensivos na resposta — boas práticas mesmo em endpoints de API
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Cache-Control', 'no-store');

    res.status(edgeResponse.status)
       .setHeader('Content-Type', 'application/json')
       .send(edgeBody);
}

// ========== UTILITÁRIOS ==========

/**
 * Cookie parser robusto.
 * Usa indexOf('=') ao invés de split('=') para suportar valores
 * com '=' no meio (ex: base64 com padding '==').
 *
 * @param {string} cookieHeader   Header Cookie completo
 * @param {string} projectRef     Project ref do Supabase (de env var)
 * @returns {string|null}         Access token JWT ou null
 */
function extractSupabaseToken(cookieHeader, projectRef) {
    if (!cookieHeader) return null;

    const cookies = {};
    for (const part of cookieHeader.split(';')) {
        const idx = part.indexOf('=');
        if (idx === -1) continue;
        cookies[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
    }

    // SDK v2: sb-<project-ref>-auth-token (JSON em base64)
    // SDK v1: sb-access-token (JWT direto)
    const candidates = [
        `sb-${projectRef}-auth-token`,
        'sb-access-token',
    ];

    for (const name of candidates) {
        const raw = cookies[name];
        if (!raw) continue;

        // Tenta decodificar JSON base64 (SDK v2)
        try {
            const decoded = JSON.parse(
                Buffer.from(decodeURIComponent(raw), 'base64').toString('utf8')
            );
            if (typeof decoded?.access_token === 'string') return decoded.access_token;
        } catch {
            // JWT direto (SDK v1): 3 segmentos separados por '.'
            if (raw.split('.').length === 3) return raw;
        }
    }

    return null;
}

/**
 * Decodifica o payload do JWT sem verificar a assinatura.
 * Usado APENAS para rate limiting — nunca para autorização.
 *
 * @param {string} token  JWT no formato header.payload.signature
 * @returns {string|null} userId (claim "sub") ou null se falhar
 */
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

/**
 * Calcula a profundidade e o número máximo de chaves de um JSON.
 *
 * ✅ FIX: Versão ITERATIVA — a versão recursiva causava RangeError:
 *    Maximum call stack size exceeded com JSON de profundidade >= ~10.000.
 *    A versão iterativa usa uma stack explícita em heap (ilimitado)
 *    e nunca estoura a call stack do Node.js.
 *
 * Retorna { depth, maxKeys } para checar ambas as métricas em uma passagem.
 *
 * @param {unknown} root  Valor já parseado por JSON.parse
 * @returns {{ depth: number, maxKeys: number }}
 */
function analyzeJson(root) {
    if (root === null || typeof root !== 'object') return { depth: 0, maxKeys: 0 };

    // Stack: [valor, profundidadeAtual]
    const stack   = [[root, 1]];
    let maxDepth  = 0;
    let maxKeys   = 0;

    while (stack.length > 0) {
        const [node, depth] = stack.pop();

        if (depth > maxDepth) maxDepth = depth;

        const entries = Array.isArray(node) ? node : Object.values(node);
        const keyCount = Array.isArray(node) ? node.length : Object.keys(node).length;

        if (keyCount > maxKeys) maxKeys = keyCount;

        for (const child of entries) {
            if (child !== null && typeof child === 'object') {
                stack.push([child, depth + 1]);
            }
        }
    }

    return { depth: maxDepth, maxKeys };
}

/**
 * Lê o body com limite de tamanho.
 * Lança Error('TOO_LARGE') se exceder maxBytes.
 *
 * @param {import('@vercel/node').VercelRequest} req
 * @param {number} maxBytes
 * @returns {Promise<string>}
 */
function readBody(req, maxBytes) {
    return new Promise((resolve, reject) => {
        const chunks   = [];
        let totalBytes = 0;

        req.on('data', (chunk) => {
            totalBytes += chunk.length;
            if (totalBytes > maxBytes) {
                req.destroy();
                return reject(new Error('TOO_LARGE'));
            }
            chunks.push(chunk);
        });

        req.on('end',   ()    => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', (err) => reject(err));
    });
}

/**
 * Logging estruturado em JSON.
 * Nunca loga JWT, cookies ou dados sensíveis além do userId.
 * Formato ingerível por Vercel Logs, Datadog, Grafana, etc.
 *
 * @param {'info'|'warn'|'error'} level
 * @param {string}      event   Identificador do evento (snake_case)
 * @param {string|null} ip
 * @param {string|null} userId
 * @param {object}      meta    Dados adicionais do evento
 */
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