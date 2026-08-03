// assistant-api.js — ponte cliente ↔ IA (regra de ouro: IA como função)
// ---------------------------------------------------------------------------
// Único ponto do cliente que fala com a IA. Enforce da regra de ouro NO CLIENTE:
// a assinatura só aceita TEXTO + RÓTULOS (nomes de metas/cartões). É impossível,
// por construção, um chamador vazar valores/saldos/transações para a IA — não há
// parâmetro para isso. Defesa em profundidade: o proxy e a Edge Function repetem
// a validação. A IA nunca devolve texto exibível — só o objeto `parse`.
// ---------------------------------------------------------------------------

import { getValidAccessToken } from '../../services/supabase-client.js?v=2';

const ENDPOINT     = '/api/user-data';
const MAX_TEXT     = 500;
const MAX_LABELS   = 30;
const LABEL_CHARS  = 40;
const TIMEOUT_MS   = 15_000;

// Só letras/nº/espaço/hífen — rótulos são nomes que o próprio usuário digitou.
// Remove qualquer coisa que pareça payload (chaves, aspas, cifrão em excesso).
function _clampLabels(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const v of list) {
        if (typeof v !== 'string') continue;
        const clean = v.replace(/[^\p{L}\p{N}\s\-.]/gu, '').trim().slice(0, LABEL_CHARS);
        if (clean) out.push(clean);
        if (out.length >= MAX_LABELS) break;
    }
    return out;
}

// ── C-4: sinal de instalação do PWA, UMA vez por sessão ─────────────────────
// Responde "vale investir mais no PWA do assistente?" — que hoje não tem
// resposta: o install.js sabe detectar instalação, mas ninguém contava.
//
// O que sobe é UM BOOLEANO, e o servidor grava num contador por DIA, sem
// user_id, sem aparelho, sem IP. Não dá para reconstruir quem abriu o quê, então
// não é dado pessoal — e por isso não reabre a declaração de LGPD.
//
// `sessionStorage` e não `localStorage`: a pergunta é "quantas SESSÕES vêm de um
// app instalado". Com localStorage o sinal iria uma vez na vida e a série
// temporal (que é o que mostra se está crescendo) nunca se formaria.
const PWA_PING_KEY = 'ge_pwa_ping';

function _ehStandalone() {
    try {
        return window.matchMedia?.('(display-mode: standalone)').matches === true
            || window.navigator?.standalone === true;
    } catch { return false; }
}

/** true na primeira chamada da sessão; false nas seguintes. Marca ao ser lido. */
function _pwaPingPendente() {
    try {
        if (sessionStorage.getItem(PWA_PING_KEY)) return false;
        sessionStorage.setItem(PWA_PING_KEY, '1');
        return true;
    } catch {
        return false; // modo privado: telemetria é o primeiro a ser sacrificado
    }
}

/**
 * Estrutura uma mensagem via IA (fallback do parser local).
 * @param {string} text  Texto cru do usuário.
 * @param {{metaLabels?:string[], cartaoLabels?:string[]}} [ctx]  SÓ rótulos — nada financeiro.
 * @returns {Promise<{ok:true, parse:object} | {ok:false, reason:'rate'|'rate_day'|'auth'|'net'|'noparse'}>}
 */
export async function parseWithAI(text, ctx = {}) {
    const clean = typeof text === 'string' ? text.trim() : '';
    if (!clean || clean.length > MAX_TEXT) return { ok: false, reason: 'noparse' };

    const token = await getValidAccessToken();
    if (!token) return { ok: false, reason: 'auth' };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let resp;
    try {
        resp = await fetch(ENDPOINT, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({
                action:        'chat-parse',
                text:          clean.slice(0, MAX_TEXT),
                meta_labels:   _clampLabels(ctx.metaLabels),
                cartao_labels: _clampLabels(ctx.cartaoLabels),
                // C-4 — vai UMA vez por sessão (undefined nas demais some do JSON).
                ...(_pwaPingPendente() ? { pwa_standalone: _ehStandalone() } : {}),
            }),
            signal: controller.signal,
        });
    } catch {
        return { ok: false, reason: 'net' };
    } finally {
        clearTimeout(timer);
    }

    if (resp.status === 429) {
        // E46: o proxy usa "amanhã/diário" só no teto por DIA → mensagem específica.
        let daily = false;
        try { const j = await resp.json(); daily = /amanh|di[aá]ri/i.test(String(j?.error ?? '')); } catch { /* corpo ausente */ }
        return { ok: false, reason: daily ? 'rate_day' : 'rate' };
    }
    if (!resp.ok)            return { ok: false, reason: 'net' };

    let data;
    try { data = await resp.json(); } catch { return { ok: false, reason: 'net' }; }

    if (!data?.ok || !data.parse || typeof data.parse !== 'object') {
        return { ok: false, reason: 'noparse' };
    }
    return { ok: true, parse: data.parse };
}
