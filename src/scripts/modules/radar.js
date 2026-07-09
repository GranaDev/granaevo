// radar.js — Radar GranaEvo: agendador de notificações (lazy)
// ----------------------------------------------------------------------------
// ARQUITETURA "O CLIENTE AGENDA, O SERVIDOR SÓ DISPARA":
// Este módulo calcula, NO NAVEGADOR, os próximos eventos financeiros do usuário
// (conta vencendo, fatura fechando, assinatura renovando, orçamento estourando)
// e grava payloads prontos na tabela `radar_notifications` (RLS: só o dono).
// Um cron diário chama a edge function send-radar-push, que apenas entrega o
// que está vencido via Web Push — o servidor NUNCA interpreta dados financeiros.
//
// Anti-duplicata: dedupe_key única por (user_id, evento). Rows enviadas ficam
// na tabela (status 'sent') e o INSERT ignora conflito — o mesmo evento nunca
// notifica duas vezes, mesmo com múltiplos dispositivos/sincronizações.
//
// Segurança: INSERT/DELETE via supabase-js parametrizado sob RLS; caps de
// quantidade e tamanho no cliente + CHECK constraints e trigger de teto no DB.
// ----------------------------------------------------------------------------

import { supabase } from '../services/supabase-client.js?v=2';

let _ctx = null;
let _debounceTimer = null;
let _syncEmVoo = false;

const MAX_EVENTOS   = 40;
const HORA_DISPARO  = 8;   // 08:00 local — o cron diário roda depois disso
const THROTTLE_MS   = 10 * 60 * 1000; // mín. 10 min entre sincronizações
const LS_KEY        = 'ge_radar_last_sync';

// ── Helpers de data ───────────────────────────────────────────────────────────
function _hoje0() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
}
function _fireAt(dia) {
    const d = new Date(dia);
    d.setHours(HORA_DISPARO, 0, 0, 0);
    return d;
}
function _isoDia(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function _ymKey(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function _brl(v) {
    try { return Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }
    catch { return 'R$ ' + Math.round(Number(v) || 0); }
}
function _clampTexto(s, max) {
    return String(s || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
}
// Próxima ocorrência de um dia-do-mês (1–28) a partir de hoje.
function _proximaOcorrencia(diaDoMes, base) {
    const d = new Date(base.getFullYear(), base.getMonth(), diaDoMes);
    if (d < base) return new Date(base.getFullYear(), base.getMonth() + 1, diaDoMes);
    return d;
}

// ── Cálculo dos eventos ───────────────────────────────────────────────────────
function _computarEventos(ctx) {
    const eventos = [];
    const hoje = _hoje0();
    const limite = new Date(hoje.getTime() + 35 * 86_400_000); // janela de 35 dias
    const agora = new Date();

    const add = (dedupe, tipo, diaDisparo, title, body) => {
        const fire = _fireAt(diaDisparo);
        if (fire < new Date(agora.getTime() - 3_600_000)) return; // já passou
        if (fire > limite) return;
        eventos.push({
            dedupe_key: _clampTexto(dedupe, 120),
            tipo,
            title: _clampTexto(title, 80),
            body:  _clampTexto(body, 200),
            url:   '/dashboard',
            fire_at: fire.toISOString(),
        });
    };

    // 1) Contas fixas (e faturas de cartão, que são contas fixas) não pagas —
    //    lembrete na véspera e no dia do vencimento.
    for (const c of (ctx.contasFixas || [])) {
        if (c.pago === true) continue;
        if (typeof c.vencimento !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(c.vencimento)) continue;
        const [y, m, d] = c.vencimento.split('-').map(Number);
        const venc = new Date(y, m - 1, d);
        if (isNaN(venc.getTime()) || venc < hoje || venc > limite) continue;
        const valor = Number(c.valor);
        if (!Number.isFinite(valor) || valor <= 0) continue;
        const desc = _clampTexto(c.descricao, 40) || 'Conta';
        const idFrag = String(c.id ?? desc).slice(0, 40);

        const vespera = new Date(venc.getTime() - 86_400_000);
        add(`cf:${idFrag}:${c.vencimento}:d1`, 'conta_vence', vespera,
            `${desc} vence amanhã`,
            `${_brl(valor)} — vencimento em ${venc.toLocaleDateString('pt-BR')}. Já se programou?`);
        add(`cf:${idFrag}:${c.vencimento}:d0`, 'conta_vence', venc,
            `${desc} vence hoje`,
            `${_brl(valor)} vence hoje. Pague e marque como paga no GranaEvo.`);
    }

    // 2) Fechamento de fatura — 2 dias antes, com o valor já usado no cartão.
    for (const cartao of (ctx.cartoesCredito || [])) {
        const diaFech = Number.isInteger(cartao.fechamentoDia) ? cartao.fechamentoDia
                       : Number.isInteger(cartao.vencimentoDia) ? cartao.vencimentoDia : null;
        if (!diaFech || diaFech < 1 || diaFech > 28) continue;
        if (cartao.congelado === true) continue;
        const fech = _proximaOcorrencia(diaFech, hoje);
        const aviso = new Date(fech.getTime() - 2 * 86_400_000);
        if (aviso < hoje || fech > limite) continue;
        const usado = Number(cartao.usado);
        const nome = _clampTexto(cartao.nomeBanco, 30) || 'cartão';
        const corpo = Number.isFinite(usado) && usado > 0
            ? `Fatura parcial em ${_brl(usado)}. Compras a partir de ${fech.toLocaleDateString('pt-BR')} caem na próxima.`
            : `Compras a partir de ${fech.toLocaleDateString('pt-BR')} entram na próxima fatura.`;
        add(`fech:${String(cartao.id).slice(0, 40)}:${_ymKey(fech)}`, 'fatura_fecha', aviso,
            `Fatura do ${nome} fecha em 2 dias`, corpo);
    }

    // 3) Assinaturas ativas — renova amanhã.
    for (const a of (ctx.assinaturas || [])) {
        if (a.ativa !== true) continue;
        if (!Number.isInteger(a.diaCobranca) || a.diaCobranca < 1 || a.diaCobranca > 28) continue;
        const valor = Number(a.valor);
        if (!Number.isFinite(valor) || valor <= 0) continue;
        const cobra = _proximaOcorrencia(a.diaCobranca, hoje);
        const vespera = new Date(cobra.getTime() - 86_400_000);
        if (vespera < hoje || cobra > limite) continue;
        const nome = _clampTexto(a.nome, 40) || 'Assinatura';
        add(`ass:${String(a.id).slice(0, 40)}:${_ymKey(cobra)}`, 'assinatura_renova', vespera,
            `${nome} renova amanhã`,
            `${_brl(valor)}/mês no cartão. Ainda vale a pena? Cancele antes se não usa.`);
    }

    // 4) Orçamentos ≥ 85% — aviso na próxima manhã (1× por categoria/mês).
    const mes = hoje.getMonth(), ano = hoje.getFullYear();
    const gastoPorTipo = new Map();
    for (const t of (ctx.transacoes || [])) {
        if (t.categoria !== 'saida' && t.categoria !== 'saida_credito') continue;
        if (typeof t.data !== 'string') continue;
        let dt = null;
        if (t.data.includes('/')) {
            const p = t.data.split('/');
            if (p.length === 3) dt = new Date(+p[2], +p[1] - 1, +p[0]);
        } else if (/^\d{4}-\d{2}-\d{2}/.test(t.data)) {
            const p = t.data.split('-');
            dt = new Date(+p[0], +p[1] - 1, parseInt(p[2], 10));
        }
        if (!dt || dt.getMonth() !== mes || dt.getFullYear() !== ano) continue;
        const v = Number(t.valor);
        if (!Number.isFinite(v) || v <= 0) continue;
        gastoPorTipo.set(t.tipo, (gastoPorTipo.get(t.tipo) || 0) + v);
    }
    for (const [tipo, cfg] of Object.entries(ctx.orcamentos || {})) {
        const lim = Number(cfg?.limite);
        if (!Number.isFinite(lim) || lim <= 0) continue;
        const gasto = gastoPorTipo.get(tipo) || 0;
        const pct = (gasto / lim) * 100;
        if (pct < 85) continue;
        const amanha = new Date(hoje.getTime() + 86_400_000);
        const diaDisparo = agora.getHours() < HORA_DISPARO ? hoje : amanha;
        const rotulo = pct >= 100 ? 'estourou' : `chegou a ${Math.floor(pct)}%`;
        add(`orc:${_clampTexto(tipo, 30)}:${_ymKey(hoje)}`, 'orcamento_estouro', diaDisparo,
            `Orçamento de ${_clampTexto(tipo, 30)} ${rotulo}`,
            `${_brl(gasto)} de ${_brl(lim)} neste mês. Vale segurar os próximos gastos.`);
    }

    // Mais próximos primeiro; teto de segurança
    eventos.sort((a, b) => new Date(a.fire_at) - new Date(b.fire_at));
    return eventos.slice(0, MAX_EVENTOS);
}

// ── Sincronização com o banco (RLS: só linhas do próprio usuário) ────────────
async function _sincronizar() {
    if (!_ctx || _syncEmVoo) return;
    // Sem permissão de push = sem razão para agendar
    if (!('Notification' in window) || Notification.permission !== 'granted') return;

    try {
        const last = Number(localStorage.getItem(LS_KEY) || 0);
        if (Date.now() - last < THROTTLE_MS) return;
    } catch {}

    _syncEmVoo = true;
    try {
        const { data: { session } } = await supabase.auth.getSession();
        const uid = session?.user?.id;
        if (!uid) return;

        const eventos = _computarEventos(_ctx).map(e => ({ ...e, user_id: uid }));

        // 1) Remove agendamentos pendentes antigos (dados podem ter mudado:
        //    conta paga, assinatura cancelada…). 'sent' fica — é o dedupe.
        const del = await supabase
            .from('radar_notifications')
            .delete()
            .eq('user_id', uid)
            .eq('status', 'pending');
        if (del.error) { _log('delete', del.error); return; }

        // 2) Insere o estado atual. Conflito com dedupe_key já enviada = ignora.
        if (eventos.length > 0) {
            const ins = await supabase
                .from('radar_notifications')
                .upsert(eventos, { onConflict: 'user_id,dedupe_key', ignoreDuplicates: true });
            if (ins.error) { _log('insert', ins.error); return; }
        }

        try { localStorage.setItem(LS_KEY, String(Date.now())); } catch {}
    } catch (e) {
        _log('sync', e);
    } finally {
        _syncEmVoo = false;
    }
}

function _log(fase, err) {
    // Sem PII: só a fase e a mensagem técnica
    console.warn(`[RADAR] Falha na fase "${fase}":`, err?.message ?? err);
}

/** Boot: chamado pelo dashboard após o carregamento inicial. */
export function initRadar(ctx) {
    _ctx = ctx;
    // Primeira sincronização com folga pós-boot
    setTimeout(_sincronizar, 6_000);
    // Re-sincroniza (debounced + throttled) a cada save — dados mudaram
    document.addEventListener('ge:save-done', () => {
        clearTimeout(_debounceTimer);
        _debounceTimer = setTimeout(_sincronizar, 5_000);
    });
}
