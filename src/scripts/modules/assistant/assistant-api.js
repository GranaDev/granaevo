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

/**
 * Estrutura uma mensagem via IA (fallback do parser local).
 * @param {string} text  Texto cru do usuário.
 * @param {{metaLabels?:string[], cartaoLabels?:string[]}} [ctx]  SÓ rótulos — nada financeiro.
 * @returns {Promise<{ok:true, parse:object} | {ok:false, reason:'rate'|'auth'|'net'|'noparse'}>}
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
            }),
            signal: controller.signal,
        });
    } catch {
        return { ok: false, reason: 'net' };
    } finally {
        clearTimeout(timer);
    }

    if (resp.status === 429) return { ok: false, reason: 'rate' };
    if (!resp.ok)            return { ok: false, reason: 'net' };

    let data;
    try { data = await resp.json(); } catch { return { ok: false, reason: 'net' }; }

    if (!data?.ok || !data.parse || typeof data.parse !== 'object') {
        return { ok: false, reason: 'noparse' };
    }
    return { ok: true, parse: data.parse };
}
