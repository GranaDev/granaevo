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
//
// PRIVACIDADE (regra): os payloads NUNCA contêm valores em R$ — nem no banco
// (title/body ficam em claro na tabela) nem na notificação (aparece na tela
// bloqueada do celular). Só nomes/datas/percentuais; os valores o usuário vê
// ao abrir o app. Não reintroduzir _brl() aqui.
// ----------------------------------------------------------------------------

import { supabase } from '../services/supabase-client.js?v=2';
import { proximaOcorrencia, meiaNoite } from './ciclo-fatura.js?v=1';

let _ctx = null;
let _debounceTimer = null;
let _syncEmVoo = false;

const MAX_EVENTOS   = 40;
const HORA_DISPARO  = 8;   // 08:00 local — o cron da manhã roda depois disso
const HORA_TARDE    = 15;  // 15:00 local — 2ª rodada (fan-out do cron-health 18:00 UTC)
const HORA_RESUMO   = 19;  // 19:00 domingo — resumo semanal (RF-03) cai na janela da manhã seguinte
const THROTTLE_MS   = 10 * 60 * 1000; // mín. 10 min entre sincronizações
const LS_KEY        = 'ge_radar_last_sync';
const LS_METAS      = 'ge_radar_metas_';   // + uid: metas já batidas (semeia sem avisar as antigas)

// ── Helpers de data ───────────────────────────────────────────────────────────
// _hoje0 e _proximaOcorrencia mudaram-se para modules/ciclo-fatura.js (meiaNoite
// e proximaOcorrencia). A conta do fechamento estava duplicada aqui e no painel
// do db-cartoes — e as cópias DIVERGIAM: a de lá usava `<=` contra um Date com
// hora e errava justamente no dia do fechamento. Uma conta, uma implementação.
function _fireAt(dia) {
    const d = new Date(dia);
    d.setHours(HORA_DISPARO, 0, 0, 0);
    return d;
}
// Próxima janela de entrega a partir de agora (manhã 08h → tarde 15h → manhã seguinte).
// Usada por eventos "assim que possível" (marco de meta, orçamento).
function _proximaJanela(hoje, agora) {
    const h = agora.getHours();
    if (h < HORA_DISPARO) return _fireAt(hoje);
    if (h < HORA_TARDE) { const d = new Date(hoje); d.setHours(HORA_TARDE, 0, 0, 0); return d; }
    return _fireAt(new Date(hoje.getTime() + 86_400_000));
}
function _ymKey(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function _clampTexto(s, max) {
    return String(s || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
}

// ── Cálculo dos eventos ───────────────────────────────────────────────────────
function _computarEventos(ctx, uid) {
    const eventos = [];
    const hoje = meiaNoite(new Date());
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

        // D-3: folga pra se programar (contas maiores agradecem). O silêncio
        // inteligente do envio agrupa vários no mesmo dia em 1 push só.
        const tresDias = new Date(venc.getTime() - 3 * 86_400_000);
        add(`cf:${idFrag}:${c.vencimento}:d3`, 'conta_vence', tresDias,
            `${desc} vence em 3 dias`,
            `Vence em ${venc.toLocaleDateString('pt-BR')}. Programe-se — o valor está no app.`);
        const vespera = new Date(venc.getTime() - 86_400_000);
        add(`cf:${idFrag}:${c.vencimento}:d1`, 'conta_vence', vespera,
            `${desc} vence amanhã`,
            `Vencimento em ${venc.toLocaleDateString('pt-BR')}. O valor está no app — já se programou?`);
        add(`cf:${idFrag}:${c.vencimento}:d0`, 'conta_vence', venc,
            `${desc} vence hoje`,
            `Vence hoje. Pague e marque como paga no GranaEvo.`);
    }

    // 2) Fechamento de fatura — 2 dias antes, com o valor já usado no cartão.
    for (const cartao of (ctx.cartoesCredito || [])) {
        const diaFech = Number.isInteger(cartao.fechamentoDia) ? cartao.fechamentoDia
                       : Number.isInteger(cartao.vencimentoDia) ? cartao.vencimentoDia : null;
        if (!diaFech || diaFech < 1 || diaFech > 28) continue;
        if (cartao.congelado === true) continue;
        const fech = proximaOcorrencia(diaFech, hoje);
        const aviso = new Date(fech.getTime() - 2 * 86_400_000);
        if (aviso < hoje || fech > limite) continue;
        const nome = _clampTexto(cartao.nomeBanco, 30) || 'cartão';
        add(`fech:${String(cartao.id).slice(0, 40)}:${_ymKey(fech)}`, 'fatura_fecha', aviso,
            `Fatura do ${nome} fecha em 2 dias`,
            `Compras a partir de ${fech.toLocaleDateString('pt-BR')} entram na próxima fatura. Veja o valor parcial no app.`);
    }

    // 3) Assinaturas ativas — renova amanhã.
    for (const a of (ctx.assinaturas || [])) {
        if (a.ativa !== true) continue;
        if (!Number.isInteger(a.diaCobranca) || a.diaCobranca < 1 || a.diaCobranca > 28) continue;
        const valor = Number(a.valor);
        if (!Number.isFinite(valor) || valor <= 0) continue;
        const cobra = proximaOcorrencia(a.diaCobranca, hoje);
        const vespera = new Date(cobra.getTime() - 86_400_000);
        if (vespera < hoje || cobra > limite) continue;
        const nome = _clampTexto(a.nome, 40) || 'Assinatura';
        add(`ass:${String(a.id).slice(0, 40)}:${_ymKey(cobra)}`, 'assinatura_renova', vespera,
            `${nome} renova amanhã`,
            `Cobrança mensal no cartão. Ainda vale a pena? Cancele antes se não usa.`);
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
        // Próxima janela de entrega: manhã (08h) → tarde (15h) → manhã seguinte.
        // Com a 2ª rodada do cron, um estouro ao meio-dia avisa às 15h do MESMO dia.
        const amanha = new Date(hoje.getTime() + 86_400_000);
        let fireOrc;
        if (agora.getHours() < HORA_DISPARO)     fireOrc = _fireAt(hoje);
        else if (agora.getHours() < HORA_TARDE) { fireOrc = new Date(hoje); fireOrc.setHours(HORA_TARDE, 0, 0, 0); }
        else                                     fireOrc = _fireAt(amanha);
        const rotulo = pct >= 100 ? 'estourou' : `chegou a ${Math.floor(pct)}%`;
        eventos.push({
            dedupe_key: _clampTexto(`orc:${_clampTexto(tipo, 30)}:${_ymKey(hoje)}`, 120),
            tipo: 'orcamento_estouro',
            title: _clampTexto(`Orçamento de ${_clampTexto(tipo, 30)} ${rotulo}`, 80),
            body:  _clampTexto(`Você usou ${Math.floor(pct)}% do limite deste mês. Vale segurar os próximos gastos.`, 200),
            url:   '/dashboard',
            fire_at: fireOrc.toISOString(),
        });
    }

    // 5) Marco (RF-03): meta batida (100%). SEMEIA silenciosamente as já batidas
    //    na 1ª vez — não avisa conquista antiga; só notifica quem cruzar daqui pra
    //    frente. Mesmo padrão do confete (celebracao.js). Estado por usuário.
    if (uid) {
        try {
            const chave = LS_METAS + uid;
            const bruto = (() => { try { return localStorage.getItem(chave); } catch { return null; } })();
            const vistas = new Set(bruto ? JSON.parse(bruto) : []);
            const primeiraVez = bruto === null;
            const batidasAgora = [];
            for (const m of (ctx.metas || [])) {
                if (!m || typeof m !== 'object') continue;
                const objetivo = Number(m.objetivo), saved = Number(m.saved);
                if (!Number.isFinite(objetivo) || objetivo <= 0 || !Number.isFinite(saved)) continue;
                const id = String(m.id ?? m.descricao ?? '').slice(0, 40);
                if (!id || saved + 0.005 < objetivo) continue;
                batidasAgora.push(id);
                if (!primeiraVez && !vistas.has(id)) {
                    const nome = _clampTexto(m.descricao, 40) || 'sua meta';
                    eventos.push({
                        dedupe_key: _clampTexto(`meta:${id}:done`, 120),
                        tipo: 'meta_batida',
                        title: _clampTexto('Meta batida!', 80),
                        body:  _clampTexto(`Você concluiu "${nome}". Parabéns — objetivo alcançado!`, 200),
                        url:   '/dashboard',
                        fire_at: _proximaJanela(hoje, agora).toISOString(),
                    });
                }
            }
            try { localStorage.setItem(chave, JSON.stringify(batidasAgora.slice(0, 100))); } catch {}
        } catch (e) { _log('metas', e); }
    }

    // 6) Resumo semanal (RF-03): domingo à noite, quantas contas vencem na semana
    //    seguinte. PRIVACIDADE: sem R$ — só a contagem; o usuário abre pra ver.
    {
        const diasAteDomingo = (7 - hoje.getDay()) % 7;      // 0 se hoje já é domingo
        const domingo = new Date(hoje.getTime() + diasAteDomingo * 86_400_000);
        const fimSemana = new Date(domingo.getTime() + 7 * 86_400_000);
        let nContas = 0;
        for (const c of (ctx.contasFixas || [])) {
            if (c.pago === true || typeof c.vencimento !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(c.vencimento)) continue;
            const [yy, mm, dd] = c.vencimento.split('-').map(Number);
            const v = new Date(yy, mm - 1, dd);
            if (v >= domingo && v < fimSemana) nContas++;
        }
        if (nContas > 0) {
            const fireResumo = new Date(domingo); fireResumo.setHours(HORA_RESUMO, 0, 0, 0);
            if (fireResumo >= new Date(agora.getTime() - 3_600_000) && fireResumo <= limite) {
                const plural = nContas > 1;
                eventos.push({
                    dedupe_key: _clampTexto(`resumo:${_ymKey(domingo)}:${domingo.getDate()}`, 120),
                    tipo: 'resumo_semanal',
                    title: _clampTexto('Sua semana no GranaEvo', 80),
                    body:  _clampTexto(`${nContas} conta${plural ? 's' : ''} vence${plural ? 'm' : ''} na próxima semana. Abra pra ver os valores e se programar.`, 200),
                    url:   '/dashboard',
                    fire_at: fireResumo.toISOString(),
                });
            }
        }
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

        const eventos = _computarEventos(_ctx, uid).map(e => ({ ...e, user_id: uid }));

        // 1) Remove agendamentos pendentes antigos (dados podem ter mudado:
        //    conta paga, assinatura cancelada…). 'sent' fica — é o dedupe.
        //
        // 🔴 SÓ OS TIPOS DO PRÓPRIO RADAR (bug encontrado em 2026-07-21).
        // Este delete era por `status='pending'` e mais nada — então varria TUDO,
        // inclusive os LEMBRETES que o usuário cria no calendário/chat (tipo
        // 'lembrete'), que o Radar não calcula e portanto não reinsere no passo 2.
        // Efeito: bastava ABRIR O APP para todos os lembretes do usuário sumirem,
        // e nenhum chegava a sobreviver até a data de disparo. Foi exatamente isso
        // que apagou o lembrete de teste minutos depois de ele ser criado.
        // A lista é explícita de propósito: tipo novo do Radar precisa ser incluído
        // aqui de forma consciente, e nada que não seja do Radar entra por descuido.
        // 'resumo_semanal' entra (recalcula a contagem a cada sync). 'meta_batida'
        // fica FORA: é one-shot — deletá-lo antes de disparar perderia o aviso, e a
        // semeadura por localStorage não o reinsere. 'lembrete' (do usuário) nunca entra.
        const del = await supabase
            .from('radar_notifications')
            .delete()
            .eq('user_id', uid)
            .eq('status', 'pending')
            .in('tipo', ['conta_vence', 'fatura_fecha', 'assinatura_renova', 'orcamento_estouro', 'resumo_semanal']);
        if (del.error) { _log('delete', del.error); return; }

        // 2) Insere o estado atual. Conflito com dedupe_key já enviada = ignora.
        //    SPLIT PROPOSITAL: os tipos do RF-03 (resumo_semanal/meta_batida) só
        //    passam se a migration 20260724000000 (novo CHECK de tipo) já estiver
        //    aplicada. Num upsert separado, se ela ainda NÃO foi aplicada, só o
        //    RF-03 falha (logado) — os avisos principais (conta_vence, fatura…)
        //    continuam sendo agendados. Zero regressão na ordem migration→deploy.
        const RF03 = new Set(['resumo_semanal', 'meta_batida']);
        const legados = eventos.filter(e => !RF03.has(e.tipo));
        const novos   = eventos.filter(e => RF03.has(e.tipo));
        const upsert  = (linhas) => supabase
            .from('radar_notifications')
            .upsert(linhas, { onConflict: 'user_id,dedupe_key', ignoreDuplicates: true });
        if (legados.length > 0) {
            const ins = await upsert(legados);
            if (ins.error) { _log('insert', ins.error); return; }
        }
        if (novos.length > 0) {
            const ins2 = await upsert(novos);
            if (ins2.error) _log('insert-rf03', ins2.error);  // não derruba os principais
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
