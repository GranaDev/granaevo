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
import { ipDoCliente } from './_client-ip.js'
import { verificarJWT } from './_jwt.js'
import { logger, requestIdDe } from './_logger.js'
import { timingSafeEqual } from 'node:crypto'

const PATH = '/api/user-data'

const GET_EDGE_URL         = process.env.SUPABASE_GET_DATA_EDGE_URL;
const SAVE_EDGE_URL        = process.env.SUPABASE_EDGE_URL;
const BACKUP_EDGE_URL      = process.env.SUPABASE_BACKUP_EDGE_URL;
const SUPABASE_URL         = process.env.SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY    = process.env.SUPABASE_ANON_KEY;
const ALLOWED_ORIGIN       = process.env.ALLOWED_ORIGIN;
const SUPABASE_PROJECT_REF = process.env.SUPABASE_PROJECT_REF;
const PROXY_SECRET         = process.env.PROXY_SECRET;
// UPSTASH_REDIS_* NÃO é lido aqui de propósito: o rate limit fala com o Upstash
// pelo api/_rate-limit.js, que tem a sua própria configuração. As duas constantes
// que existiam neste arquivo serviam só à invalidação de um cache inexistente.

const ALLOWED_ORIGINS = [
    process.env.ALLOWED_ORIGIN,
    'https://granaevo.com',
    'https://www.granaevo.com',
    'https://assistente.granaevo.com',
    'https://granaevo.vercel.app',
].filter(Boolean);

const RL_MAX_IP_GET      = 20;
const RL_MAX_IP_POST     = 10;
const RL_MAX_USER_POST   = 8;
const RL_RESTORE_MAX     = 3;
const RL_RESTORE_WIN_SECS = 3_600;
const MAX_BODY_BYTES     = 5_242_880;
// 20: o limite REAL por plano é 1 (individual) / 2 (casal) / 4 (família),
// imposto por `enforce_profile_limit_stripe` na tabela `profiles` — os perfis
// usáveis nascem lá, então este teto não controla plano, só evita que um save
// forjado infle o blob com perfis órfãos (abuso de armazenamento).
// Era 200 (50× o maior plano). 20 = 5× o maior plano e 10× o máximo observado
// em produção (2), folga de sobra para duplicatas/legado sem travar save real.
// MANTER EM SINCRONIA com supabase/functions/save-user-data/index.ts.
const MAX_PROFILES       = 20;
const MAX_JSON_DEPTH     = 8;
// 80: o mapa `conquistas` de um perfil guarda 1 chave por conquista
// desbloqueada — o catálogo tem ~60 ids (2026-07) e segue crescendo.
// 50 rejeitava o save de quem desbloqueou 51+ conquistas.
const MAX_KEYS_OBJ       = 80;

// checkRL usa _rate-limit.js (Redis distribuído quando disponível, in-memory fallback).
// Elimina o rlStore Map local que não persiste entre instâncias serverless da Vercel.
async function checkRL(key, max, windowSecs = 60) {
    return checkRateWindow(key, max, windowSecs);
}

// ── Handler principal ─────────────────────────────────────────
export default async function handler(req, res) {
    // Passo 27 — id de correlacao: mesma requisicao, mesmo id no proxy e na edge.
    // Ecoado na resposta para o usuario poder citar o id ao relatar um problema.
    const _rid = requestIdDe(req);
    res.setHeader('x-request-id', _rid);
    const origin = req.headers['origin'] ?? '';
    const ct     = req.headers['content-type'] ?? '';

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');

    // ── Crons: disparados pela Vercel Cron ────────────────────────────────────
    //   /api/user-data?radar=1       → edge send-radar-push (Radar: Web Push manhã)
    //   /api/user-data?cron-health=1 → edge cron-health-alert (M2) + FAN-OUT pro
    //     send-radar-push (2ª rodada do dia — Hobby só permite 2 crons, então o
    //     cron da tarde dispara os dois; a edge do radar responde 202 rápido e o
    //     dedupe por (user_id, dedupe_key) garante que nada notifica em dobro).
    // Autenticados pelo CRON_SECRET que a Vercel injeta como `Authorization: Bearer`.
    // Branch isolado, early-return, ANTES de qualquer lógica de dados/CSRF/JWT — não
    // afeta o fluxo normal. Repassa à edge function alvo com x-proxy-secret.
    const cronTargets =
        (req.query?.['cron-health'] === '1') ? ['cron-health-alert', 'send-radar-push'] :
        (req.query?.['radar'] === '1')       ? ['send-radar-push']                      : null;
    if (req.method === 'GET' && cronTargets) {
        const cronSecret = process.env.CRON_SECRET ?? '';
        const authHdr    = req.headers['authorization'] ?? '';
        const provided   = authHdr.startsWith('Bearer ') ? authHdr.slice(7).trim() : '';
        const okSecret = cronSecret && provided &&
            Buffer.byteLength(provided) === Buffer.byteLength(cronSecret) &&
            timingSafeEqual(Buffer.from(provided), Buffer.from(cronSecret));
        if (!okSecret) return res.status(401).json({ error: 'Unauthorized' });
        if (!SUPABASE_URL || !PROXY_SECRET || !SUPABASE_ANON_KEY)
            return res.status(503).json({ error: 'Serviço indisponível' });
        const fire = (fn) => fetch(`${SUPABASE_URL}/functions/v1/${fn}`, {
            method:  'POST',
            headers: {
                'Content-Type':   'application/json',
                'apikey':         SUPABASE_ANON_KEY,
                'x-proxy-secret': PROXY_SECRET,
                    'x-request-id':   _rid,
            },
            body:   '{}',
            signal: AbortSignal.timeout(12_000),
        });
        try {
            const results = await Promise.allSettled(cronTargets.map(fire));
            // O status do PRIMEIRO alvo define a resposta (compatível com o formato
            // anterior); os demais são fan-out melhor-esforço, refletidos no corpo.
            const first = results[0];
            if (first.status === 'rejected') {
                const e = first.reason;
                const code = e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 504 : 502;
                return res.status(code).json({ error: 'Gateway indisponível' });
            }
            const primaryText = await first.value.text();
            if (results.length === 1) {
                return res.status(first.value.status)
                          .setHeader('Content-Type', 'application/json')
                          .send(primaryText);
            }
            const extras = results.slice(1).map((r, i) => ({
                fn: cronTargets[i + 1],
                ok: r.status === 'fulfilled' ? r.value.ok : false,
                status: r.status === 'fulfilled' ? r.value.status : 0,
            }));
            let primary;
            try { primary = JSON.parse(primaryText); } catch { primary = { raw: true }; }
            return res.status(first.value.status).json({ primary, fanout: extras });
        } catch (e) {
            const code = e.name === 'TimeoutError' || e.name === 'AbortError' ? 504 : 502;
            return res.status(code).json({ error: 'Gateway indisponível' });
        }
    }

    // ── Ponte de eventos de segurança das Edge Functions (B-4) ───────────────
    //
    // O `_alert.js` (thresholds + e-mail via Resend + bloqueio de IP) roda na
    // Vercel. As Edge Functions rodam em Deno e não têm como importá-lo — por
    // isso `webhook_tamper` e `proxy_bypass` tinham threshold definido e ZERO
    // emissores: o alerta existia no papel e nunca dispararia.
    //
    // Esta rota é o caminho de volta. Autenticada pelo mesmo x-proxy-secret que
    // as edges já usam — e note a inversão que a torna possível: quem tenta
    // burlar manda o secret ERRADO para a edge; a edge, que conhece o CERTO,
    // reporta por aqui.
    //
    // Branch cedo, antes da exigência de JWT: um scan direto na edge não tem
    // usuário nenhum, e é justamente esse o evento que queremos ver.
    if (req.method === 'POST' && req.query?.sec === '1') {
        if (!PROXY_SECRET) return res.status(503).json({ error: 'Serviço indisponível' });
        const provided = req.headers['x-proxy-secret'] ?? '';
        const okSecret = provided &&
            Buffer.byteLength(provided) === Buffer.byteLength(PROXY_SECRET) &&
            timingSafeEqual(Buffer.from(provided), Buffer.from(PROXY_SECRET));
        if (!okSecret) return res.status(401).json({ error: 'Unauthorized' });

        const ipSec = ipDoCliente(req);
        // Teto próprio: se uma edge entrar em loop de erro, isto não pode virar
        // um amplificador de e-mail nem de escrita no Redis.
        if (!await checkRL(`secevent:${ipSec}`, 60)) return res.status(429).end();

        let rawSec = '';
        try {
            rawSec = await new Promise((resolve, reject) => {
                const chunks = []; let total = 0;
                req.on('data', c => {
                    total += c.length;
                    if (total > 2048) { req.destroy(); return reject(new Error('TOO_LARGE')); }
                    chunks.push(c);
                });
                req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
                req.on('error', reject);
            });
        } catch { return res.status(413).end(); }

        let evt;
        try { evt = JSON.parse(rawSec); } catch { return res.status(400).end(); }

        // Allow-list: só os eventos que as edges têm motivo para reportar. Sem
        // isto, quem obtivesse o proxy-secret poderia forjar qualquer evento —
        // inclusive os que BLOQUEIAM IP ao atingir o threshold.
        const PERMITIDOS = new Set(['webhook_tamper', 'proxy_bypass', 'jwt_forgery']);
        if (!PERMITIDOS.has(evt?.eventType)) return res.status(400).end();

        // Meta reconstruída do zero e truncada — nada do corpo entra inteiro no
        // e-mail de alerta.
        const meta = {
            origem: typeof evt?.origem === 'string' ? evt.origem.slice(0, 40) : 'edge',
            ip:     typeof evt?.ip === 'string' ? evt.ip.slice(0, 45) : ipSec,
            ...(typeof evt?.detalhe === 'string' ? { detalhe: evt.detalhe.slice(0, 120) } : {}),
        };

        import('./_alert.js')
            .then(({ trackSecurityEvent }) => trackSecurityEvent(evt.eventType, meta))
            .catch(() => {});
        return res.status(202).end();
    }

    // ── CSP Report handler (consolidado de csp-report.js) ─────
    // Detectado por Content-Type antes de qualquer outra lógica.
    // O vercel.json redireciona /api/csp-report → /api/user-data via rewrite.
    if (req.method === 'POST' && (ct.includes('application/csp-report') || ct.includes('application/reports+json'))) {
        if (req.method !== 'POST') return res.status(405).end();
        const ip = ipDoCliente(req);
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

    // IP real — derivação única em _client-ip.js (SEC-003). Este ponto alimenta a
    // blocklist logo abaixo, então pegar o elemento forjável do XFF significava
    // deixar o atacante escolher QUAL IP seria bloqueado.
    const ip = ipDoCliente(req);

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

    // ── ACHADO-01: identidade só DEPOIS da verificação criptográfica ─────────
    // Antes daqui o `sub` saía de um base64 decode sem verificar assinatura, e
    // virava chave de rate limit (`uid:`, `chatparse:uid:`). Como contador é
    // recurso da VÍTIMA, um `sub` forjado queimava a cota alheia. Ver api/_jwt.js.
    //
    // Conclusivamente inválido → 401 aqui mesmo (a edge daria 401 de qualquer
    // forma; adiantar poupa o salto). Inconclusivo → segue SEM identidade: valem
    // só os limites por IP, e a edge continua sendo a autoridade de autenticação.
    const veredito = await verificarJWT(token);
    if (!veredito.ok && veredito.conclusivo) {
        logger.warn('jwt_invalido', PATH, { ip, motivo: veredito.motivo });
        return res.status(401).json({ error: 'Não autenticado' });
    }
    const userId = veredito.ok ? veredito.sub : null;

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
                    'x-request-id':   _rid,
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
                    'x-request-id':   _rid,
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

    // ── POST { action:"delete-profile" | "restore-profile" | "list-deleted-profiles" }
    //
    // Exclusão de perfil com janela de 7 dias. Ver docs/exclusao-de-perfil-desenho.md
    //
    // O proxy NÃO decide nada aqui: quem confere se o requisitante é o DONO da
    // conta é a edge, contra `account_members`. Este bloco valida a FORMA do
    // profile_id, aplica rate limit e repassa — nada mais do corpo do cliente
    // atravessa.
    //
    // Rate limit por ação: excluir e restaurar mexem em dados e merecem teto
    // apertado (5/h); listar é leitura e roda a cada abertura da tela de
    // perfis, então precisa de folga (60/h) para não travar o uso normal.
    if (parsed?.action === 'delete-profile' || parsed?.action === 'restore-profile'
        || parsed?.action === 'list-deleted-profiles') {
        if (!BACKUP_EDGE_URL) return res.status(503).json({ error: 'Serviço indisponível' });

        // 20/h para mexer, 60/h para listar.
        //
        // Começou em 5/h e isso estava errado: o contador sobe ANTES da resposta,
        // então tentativa que falha (500 do servidor, 409 de limite, erro de
        // rede) consome a cota igual. Em 2026-08-15 dois bugs meus queimaram a
        // franquia do dono e o 3º clique — o que ia funcionar — levou 429.
        //
        // Um teto que pune quem recebeu erro do servidor não protege ninguém.
        // O abuso real aqui é limitado pela própria feature: dá para excluir no
        // máximo 4 perfis (o teto do maior plano) e restaurar os mesmos 4.
        // 20/h cobre erro, retentativa e teste sem chegar perto disso.
        const soLeitura = parsed.action === 'list-deleted-profiles';
        const maxHora   = soLeitura ? 60 : 20;
        const bucket    = soLeitura ? 'listperfis' : 'mexeperfil';

        if (!await checkRL(`ip:${ip}:${bucket}`, maxHora, RL_RESTORE_WIN_SECS)) {
            res.setHeader('Retry-After', '3600');
            return res.status(429).json({ error: 'Muitas tentativas. Aguarde 1 hora.' });
        }
        if (userId && !await checkRL(`uid:${userId}:${bucket}`, maxHora, RL_RESTORE_WIN_SECS)) {
            res.setHeader('Retry-After', '3600');
            return res.status(429).json({ error: 'Muitas tentativas. Aguarde 1 hora.' });
        }

        // `profile_id` é numérico e curto. Validar a forma AQUI não substitui a
        // validação da edge — é defesa em profundidade, e barra lixo antes de
        // gastar uma chamada. A edge revalida com a mesma regra.
        let corpo = { action: parsed.action };
        if (!soLeitura) {
            if (typeof parsed.profile_id !== 'string' || !/^\d{1,12}$/.test(parsed.profile_id.trim())) {
                return res.status(400).json({ error: 'profile_id inválido' });
            }
            corpo = { action: parsed.action, profile_id: parsed.profile_id.trim() };
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
                    'x-request-id':   _rid,
                },
                body: JSON.stringify(corpo),
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

    // ── POST { action:"snapshot" }: fotografa AGORA, antes de destruir ──────
    //
    // Achado de 2026-08-15: a tela de reset PROMETIA um backup ("Backup
    // automático será criado", "⏳ Salvando backup…") que nunca era criado —
    // o cliente gravava um rótulo no localStorage e chamava salvarDados(), que
    // não gera snapshot. Quem gera é o cron, uma vez por dia às 03:15 UTC.
    //
    // Rate limit próprio, mais folgado que o do restore: isto roda ANTES de uma
    // operação destrutiva e recusá-lo cancela a operação. Apertado demais, o
    // usuário fica sem conseguir resetar; frouxo demais, vira escrita livre em
    // `user_data_snapshots`. 10/hora cobre qualquer uso legítimo — reset é ação
    // rara e cada uma consome exatamente um.
    if (parsed?.action === 'snapshot') {
        if (!BACKUP_EDGE_URL) return res.status(503).json({ error: 'Serviço indisponível' });

        if (!await checkRL(`ip:${ip}:snapshot`, 10, RL_RESTORE_WIN_SECS)) {
            res.setHeader('Retry-After', '3600');
            return res.status(429).json({ error: 'Limite de backups atingido. Aguarde 1 hora.' });
        }
        if (userId && !await checkRL(`uid:${userId}:snapshot`, 10, RL_RESTORE_WIN_SECS)) {
            res.setHeader('Retry-After', '3600');
            return res.status(429).json({ error: 'Limite de backups atingido. Aguarde 1 hora.' });
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
                    'x-request-id':   _rid,
                },
                // Nada do corpo do cliente é repassado: a ação não tem parâmetro.
                // A foto é sempre de HOJE e sempre do estado atual do dono.
                body: JSON.stringify({ action: 'snapshot' }),
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

    // ── POST { action:"restore" }: restaura snapshot ──────────
    if (parsed?.action === 'restore') {
        if (!BACKUP_EDGE_URL) return res.status(503).json({ error: 'Serviço indisponível' });
        if (typeof parsed?.snapshot_date !== 'string' ||
            !/^\d{4}-\d{2}-\d{2}$/.test(parsed.snapshot_date))
            return res.status(400).json({ error: 'snapshot_date inválido (esperado YYYY-MM-DD)' });

        // profile_id (RF-09): restaura SÓ o slot deste perfil. Opcional para
        // compatibilidade — ausente = restore da conta inteira (comportamento
        // antigo). Validação de forma; a autorização real (dono do blob) é no edge.
        let profileId;
        if (parsed?.profile_id !== undefined) {
            if (typeof parsed.profile_id !== 'string' || parsed.profile_id.length === 0 || parsed.profile_id.length > 64)
                return res.status(400).json({ error: 'profile_id inválido' });
            profileId = parsed.profile_id;
        }

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
                    'x-request-id':   _rid,
                },
                body: JSON.stringify({ action: 'restore', snapshot_date: parsed.snapshot_date, ...(profileId ? { profile_id: profileId } : {}) }),
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
                    'x-request-id':   _rid,
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

    // ── POST { action:"reserve-invite-notify" }: push do convite de reserva ──
    //
    // ⚠️ POR QUE MORA AQUI E NÃO EM api/reserve-invite-notify.js (2026-07-26):
    // o plano Hobby da Vercel aceita 12 Serverless Functions por deployment. Este
    // repositório já usa as 12. Quando isto nasceu como arquivo próprio (13ª), o
    // BUILD INTEIRO passou a falhar — e a produção ficou congelada em três commits
    // atrás, sem nenhum sinal na aplicação: a rota nova respondia 404 e o convite
    // nunca notificava ninguém. Recurso novo que precise de servidor entra como
    // `action` numa rota existente, igual a push-subscribe/chat-parse/login-notify.
    //
    // Best-effort de propósito: o banner na aba Reservas é o caminho confiável do
    // convite; falhar aqui não pode quebrar a criação da reserva no cliente.
    //
    // `evento` (2026-08-17) escolhe QUAL aviso de reserva vai: `convite` (padrão,
    // compatível com o cliente antigo, que não manda o campo) ou `saida` —
    // "Fulano saiu da reserva". Um `action` só para os dois porque é a MESMA
    // rota, o mesmo rate limit e a mesma Edge; separar criaria uma 13ª função na
    // Vercel, que é o que congelou a produção em 2026-07-25.
    if (parsed?.action === 'reserve-invite-notify') {
        if (!SUPABASE_URL) return res.status(503).json({ error: 'Serviço indisponível' });

        if (!await checkRL(`resinvite:ip:${ip}`, 20)) {
            res.setHeader('Retry-After', '60');
            return res.status(429).json({ error: 'Muitas requisições. Aguarde.' });
        }

        if (typeof parsed?.reserva_id !== 'string' || parsed.reserva_id.length === 0 || parsed.reserva_id.length > 64) {
            return res.status(400).json({ error: 'reserva_id inválido' });
        }
        const reservaNome = typeof parsed?.reserva_nome === 'string' ? parsed.reserva_nome.slice(0, 60) : '';

        const evento = parsed?.evento === 'saida' ? 'saida' : 'convite';
        // Id do perfil que saiu. Só o ID viaja — o NOME quem resolve é a Edge,
        // lendo `profiles` com service_role. Aceitar o nome do cliente deixaria
        // qualquer um escrever texto arbitrário na notificação (e no push, na
        // tela de bloqueio) de outra pessoa da conta.
        const perfilId = Number.isInteger(parsed?.perfil_id) ? parsed.perfil_id
                       : /^\d{1,12}$/.test(String(parsed?.perfil_id ?? '')) ? Number(parsed.perfil_id)
                       : null;
        if (evento === 'saida' && perfilId === null) {
            return res.status(400).json({ error: 'perfil_id inválido' });
        }

        try {
            const riRes = await fetch(`${SUPABASE_URL}/functions/v1/notify-reserve-invite`, {
                method:  'POST',
                headers: {
                    'Content-Type':    'application/json',
                    'Authorization':   `Bearer ${token}`,
                    'apikey':          SUPABASE_ANON_KEY,
                    'x-forwarded-for': ip,
                    'x-proxy-secret':  PROXY_SECRET,
                    'x-request-id':   _rid,
                },
                body:   JSON.stringify({
                    reserva_id:   parsed.reserva_id,
                    reserva_nome: reservaNome,
                    evento,
                    ...(perfilId !== null ? { perfil_id: perfilId } : {}),
                }),
                signal: AbortSignal.timeout(15_000),
            });
            return res.status(riRes.status)
                      .setHeader('Content-Type', 'application/json')
                      .send(await riRes.text());
        } catch (e) {
            logger.error('gateway_error', PATH, { action: parsed.action, ip, error: e?.message });
            const code = e.name === 'TimeoutError' || e.name === 'AbortError' ? 504 : 502;
            return res.status(code).json({ error: code === 504 ? 'Gateway Timeout' : 'Bad Gateway' });
        }
    }

    // ── POST { action:"delete-account" }: exclusão de conta (LGPD art. 18, VI) ──
    // Destrutivo e irreversível → rate limit agressivo (ip + uid) + confirmação por e-mail.
    if (parsed?.action === 'delete-account') {
        if (!SUPABASE_URL) return res.status(503).json({ error: 'Serviço indisponível' });

        if (!await checkRL(`delacc:ip:${ip}`, 3, 3_600)) {
            res.setHeader('Retry-After', '3600');
            return res.status(429).json({ error: 'Muitas tentativas. Aguarde 1 hora.' });
        }
        if (userId && !await checkRL(`delacc:uid:${userId}`, 3, 3_600)) {
            res.setHeader('Retry-After', '3600');
            return res.status(429).json({ error: 'Muitas tentativas. Aguarde 1 hora.' });
        }

        if (typeof parsed?.confirmEmail !== 'string' || !parsed.confirmEmail.includes('@')) {
            return res.status(400).json({ error: 'confirmEmail obrigatório' });
        }
        // Step-up auth (Passo 25): a senha é conferida na EDGE (contra o GoTrue),
        // não aqui. O proxy só precisa repassá-la — este body é reconstruído do
        // zero, então um campo que não seja copiado explicitamente é descartado
        // no caminho e a edge receberia "senha ausente".
        if (typeof parsed?.password !== 'string' || parsed.password.length < 6) {
            return res.status(400).json({ error: 'Confirme sua senha para excluir a conta.' });
        }

        let daRes;
        try {
            daRes = await fetch(`${SUPABASE_URL}/functions/v1/delete-account`, {
                method:  'POST',
                headers: {
                    'Content-Type':    'application/json',
                    'Authorization':   `Bearer ${token}`,
                    'apikey':          SUPABASE_ANON_KEY,
                    'x-forwarded-for': ip,
                    'x-proxy-secret':  PROXY_SECRET,
                    'x-request-id':   _rid,
                },
                body:   JSON.stringify({
                    confirmEmail: parsed.confirmEmail.slice(0, 254),
                    password:     parsed.password.slice(0, 200),   // conferida na edge, nunca logada
                }),
                signal: AbortSignal.timeout(15_000),
            });
        } catch (e) {
            const code = e.name === 'TimeoutError' || e.name === 'AbortError' ? 504 : 502;
            return res.status(code).json({ error: code === 504 ? 'Gateway Timeout' : 'Bad Gateway' });
        }

        return res.status(daRes.status)
                  .setHeader('Content-Type', 'application/json')
                  .send(await daRes.text());
    }

    // ── POST { action:"login-notify" }: alerta de login em aparelho novo ──────
    // Chamado pelo login.js após autenticar. Repassa à edge notify-login com o
    // user-agent ORIGINAL (x-original-ua) — o fetch do proxy tem UA próprio.
    // Best-effort: nunca bloqueia o login; resposta sempre 200 pro cliente.
    if (parsed?.action === 'login-notify') {
        if (!SUPABASE_URL) return res.status(200).json({ ok: false });
        if (!await checkRL(`loginnotify:ip:${ip}`, 5)) {
            return res.status(200).json({ ok: false }); // silencioso — é telemetria de segurança
        }
        try {
            const nlRes = await fetch(`${SUPABASE_URL}/functions/v1/notify-login`, {
                method:  'POST',
                headers: {
                    'Content-Type':    'application/json',
                    'Authorization':   `Bearer ${token}`,
                    'apikey':          SUPABASE_ANON_KEY,
                    'x-forwarded-for': ip,
                    'x-proxy-secret':  PROXY_SECRET,
                    'x-request-id':   _rid,
                    'x-original-ua':   String(req.headers['user-agent'] ?? '').slice(0, 400),
                },
                body:   '{}',
                signal: AbortSignal.timeout(10_000),
            });
            return res.status(200).json({ ok: nlRes.ok });
        } catch {
            return res.status(200).json({ ok: false });
        }
    }

    // ── POST { action:"chat-parse" }: Assistente GranaEvo (IA como função) ──
    // Repassa o texto cru à Edge Function chat-parse (que fala com o Claude).
    // Rate limit AGRESSIVO aqui protege o orçamento de tokens: janela por IP,
    // por usuário, e um teto DIÁRIO por usuário — nenhum usuário estoura o limite.
    if (parsed?.action === 'chat-parse') {
        if (!SUPABASE_URL) return res.status(503).json({ error: 'Serviço indisponível' });

        // 1) janela por IP (15/min)  2) janela por usuário (20/min)  3) teto diário (120/dia)
        if (!await checkRL(`chatparse:ip:${ip}`, 15)) {
            res.setHeader('Retry-After', '60');
            return res.status(429).json({ error: 'Muitas mensagens. Aguarde um momento.' });
        }
        if (userId) {
            if (!await checkRL(`chatparse:uid:${userId}`, 20)) {
                res.setHeader('Retry-After', '60');
                return res.status(429).json({ error: 'Muitas mensagens. Aguarde um momento.' });
            }
            if (!await checkRL(`chatparse:uid:${userId}:day`, 120, 86_400)) {
                res.setHeader('Retry-After', '3600');
                return res.status(429).json({ error: 'Limite diário do assistente atingido. Tente novamente amanhã.' });
            }
        }

        // Validação mínima do input (o resto é revalidado na Edge Function).
        if (typeof parsed?.text !== 'string' || parsed.text.trim().length === 0 || parsed.text.length > 500) {
            return res.status(400).json({ error: 'Mensagem inválida' });
        }

        // Payload seguro — anti-mass-assignment: só campos previstos, truncados.
        const clampLabels = (v) => Array.isArray(v)
            ? v.filter(s => typeof s === 'string').slice(0, 30).map(s => s.slice(0, 40))
            : [];
        // Allow-list de campos: o corpo do cliente NUNCA é repassado inteiro.
        // C-4: `pwa_standalone` só passa se for booleano de verdade — qualquer
        // outra coisa vira `undefined` e some do JSON, em vez de viajar como
        // string e a edge ter de adivinhar o que fazer com ela.
        const safeBody = JSON.stringify({
            text:          parsed.text.slice(0, 500),
            meta_labels:   clampLabels(parsed.meta_labels),
            cartao_labels: clampLabels(parsed.cartao_labels),
            pwa_standalone: typeof parsed.pwa_standalone === 'boolean' ? parsed.pwa_standalone : undefined,
        });

        let cpRes;
        try {
            cpRes = await fetch(`${SUPABASE_URL}/functions/v1/chat-parse`, {
                method:  'POST',
                headers: {
                    'Content-Type':    'application/json',
                    'Authorization':   `Bearer ${token}`,
                    'apikey':          SUPABASE_ANON_KEY,
                    'x-forwarded-for': ip,
                    'x-proxy-secret':  PROXY_SECRET,
                    'x-request-id':   _rid,
                },
                body:   safeBody,
                signal: AbortSignal.timeout(15_000),
            });
        } catch (e) {
            const code = e.name === 'TimeoutError' || e.name === 'AbortError' ? 504 : 502;
            return res.status(code).json({ error: code === 504 ? 'Gateway Timeout' : 'Bad Gateway' });
        }

        return res.status(cpRes.status)
                  .setHeader('Content-Type', 'application/json')
                  .send(await cpRes.text());
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
                    'x-request-id':   _rid,
            },
            body:   raw,
            signal: AbortSignal.timeout(15_000),
        });
    } catch (e) {
        const code = e.name === 'TimeoutError' || e.name === 'AbortError' ? 504 : 502;
        return res.status(code).json({ error: code === 504 ? 'Gateway Timeout' : 'Bad Gateway' });
    }

    const edgeBody = await edgeRes.text();

    // ⚠️ NÃO reintroduzir aqui uma invalidação de cache `gd:<userId>` no Upstash.
    // Existiam três (restore, delete-account e este) e as três apagavam uma chave
    // que NINGUÉM escrevia e NINGUÉM lia: sobrou de um cache de leitura removido
    // há tempos. Varredura de 2026-08-13: `gd:` só aparecia em `/del/`, nunca em
    // `/set` nem `/get`. Era uma chamada HTTP externa por save — 1 comando Upstash
    // desperdiçado em cada gravação de dado do usuário.
    //
    // Se um cache de leitura voltar um dia, a invalidação volta JUNTO com ele, no
    // mesmo commit. Invalidação sem cache é só latência e cota queimada.

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

// ACHADO-01 (2026-08-12): aqui existia `extractUserId`, que decodificava o JWT
// sem verificar assinatura. A identidade agora vem de `verificarJWT` (api/_jwt.js),
// que confere a assinatura ES256 contra o JWKS antes de qualquer uso do `sub`.

function analyzeJson(root) {
    if (root === null || typeof root !== 'object') return { depth: 0, maxKeys: 0 };
    const stack = [[root, 1]];
    let maxDepth = 0, maxKeys = 0;
    while (stack.length) {
        const [node, depth] = stack.pop();
        if (depth > maxDepth) maxDepth = depth;
        // Só conta chaves de objetos — arrays têm tamanho validado pelo _SAVE_LIMITS no frontend.
        // Antes contava node.length de arrays, o que rejeitava saves com > 50 transações (400).
        if (!Array.isArray(node)) {
            const keys = Object.keys(node).length;
            if (keys > maxKeys) maxKeys = keys;
        }
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
