// query.js — consultas e relatórios sobre o perfil (100% local)
// ---------------------------------------------------------------------------
// A IA NUNCA roda aqui. Toda soma/filtro acontece no cliente, sobre transacoes[]
// já carregadas. A IA (quando usada) só devolveu intenção + palavras-chave;
// os R$ nunca saem do dispositivo por causa de uma consulta.
// ---------------------------------------------------------------------------

import { brDateToObj, yearMonthKey } from './money.js';

function norm(s) {
    return String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Filtra transações por período. */
export function filterByPeriodo(transacoes, periodo) {
    const arr = Array.isArray(transacoes) ? transacoes : [];
    if (!periodo || periodo === 'tudo') return arr;

    // A3: mês nomeado — "mes:YYYY-MM" casa exatamente aquele ano-mês.
    if (typeof periodo === 'string' && periodo.startsWith('mes:')) {
        const ym = periodo.slice(4);
        return arr.filter((t) => { const d = brDateToObj(t?.data); return d && yearMonthKey(d) === ym; });
    }

    const hoje = new Date();
    const ymAtual = yearMonthKey(hoje);
    const ymPassado = yearMonthKey(new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1));
    const ymTrimestre = [
        ymAtual,
        ymPassado,
        yearMonthKey(new Date(hoje.getFullYear(), hoje.getMonth() - 2, 1)),
    ];

    return arr.filter((t) => {
        const d = brDateToObj(t?.data);
        if (!d) return periodo === 'tudo';
        switch (periodo) {
            case 'hoje':        return d.toDateString() === hoje.toDateString();
            case 'semana':      return (hoje - d) <= 7 * 864e5 && d <= hoje;
            case 'mes':         return yearMonthKey(d) === ymAtual;
            case 'mes_passado': return yearMonthKey(d) === ymPassado;
            case 'trimestre':   return ymTrimestre.includes(yearMonthKey(d));
            case 'ano':         return d.getFullYear() === hoje.getFullYear();
            default:            return true;
        }
    });
}

function matchTermos(t, termos) {
    if (!termos.length) return true;
    const alvo = norm(`${t.descricao} ${t.tipo} ${t.categoria}`);
    return termos.some((k) => alvo.includes(norm(k)));
}

/**
 * Consulta agregada de gastos por palavras-chave e período.
 * Considera apenas SAÍDAS (o caso "quanto gastei com X").
 */
export function consultarGastos(profile, cmd) {
    const txs = filterByPeriodo(profile?.transacoes, cmd.periodo || 'mes')
        .filter((t) => t.categoria === 'saida' && matchTermos(t, cmd.palavrasChave));

    let total = 0;
    const porTipo = {};
    for (const t of txs) {
        const v = Number(t.valor) || 0;
        total += v;
        porTipo[t.tipo || 'Outros'] = (porTipo[t.tipo || 'Outros'] || 0) + v;
    }
    total = Math.round(total * 100) / 100;

    return {
        total, count: txs.length,
        periodo: cmd.periodo || 'mes',
        termos: cmd.palavrasChave,
        porTipo,
    };
}

/**
 * Consulta agregada de ENTRADAS por palavras-chave e período.
 * ("quanto ganhei/recebi de X")
 */
export function consultarEntradas(profile, cmd) {
    const txs = filterByPeriodo(profile?.transacoes, cmd.periodo || 'mes')
        .filter((t) => t.categoria === 'entrada' && matchTermos(t, cmd.palavrasChave));
    let total = 0;
    const porTipo = {};
    for (const t of txs) {
        const v = Number(t.valor) || 0;
        total += v;
        porTipo[t.tipo || 'Outros'] = (porTipo[t.tipo || 'Outros'] || 0) + v;
    }
    return { total: Math.round(total * 100) / 100, count: txs.length, periodo: cmd.periodo || 'mes', termos: cmd.palavrasChave, porTipo };
}

/**
 * Saldo ATUAL (todo o histórico) — mesma fórmula do dashboard:
 * entrada +, saida −, reserva −, retirada_reserva +.
 */
export function saldoAtual(profile) {
    const txs = Array.isArray(profile?.transacoes) ? profile.transacoes : [];
    let s = 0;
    for (const t of txs) {
        const v = Number(t.valor) || 0;
        if (t.categoria === 'entrada') s += v;
        else if (t.categoria === 'saida') s -= v;
        else if (t.categoria === 'reserva') s -= v;
        else if (t.categoria === 'retirada_reserva') s += v;
    }
    return Math.round(s * 100) / 100;
}

/**
 * Ranking de gastos por categoria no período ("onde mais gastei" / gráficos).
 * @returns {{periodo, total, count, ranking:[{tipo,valor,pct}]}}
 */
export function maioresGastos(profile, periodo = 'mes') {
    const txs = filterByPeriodo(profile?.transacoes, periodo).filter((t) => t.categoria === 'saida');
    const porTipo = {};
    let total = 0;
    for (const t of txs) {
        const v = Number(t.valor) || 0;
        porTipo[t.tipo || 'Outros'] = (porTipo[t.tipo || 'Outros'] || 0) + v;
        total += v;
    }
    total = Math.round(total * 100) / 100;
    const ranking = Object.entries(porTipo)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([tipo, valor]) => ({
            tipo,
            valor: Math.round(valor * 100) / 100,
            pct: total > 0 ? Math.round((valor / total) * 100) : 0,
        }));
    return { periodo, total, count: txs.length, ranking };
}

/** Últimos N lançamentos (mais recentes primeiro). */
export function ultimasTransacoes(profile, n = 8) {
    const arr = Array.isArray(profile?.transacoes) ? profile.transacoes : [];
    return arr.slice(-n).reverse().map((t) => ({
        categoria: t.categoria,
        tipo: t.tipo,
        descricao: t.descricao,
        valor: Math.round((Number(t.valor) || 0) * 100) / 100,
        data: t.data,
    }));
}

function _ymOf(data) { const d = brDateToObj(data); return d ? yearMonthKey(d) : null; }

/** Compara gastos deste mês vs. mês passado. */
export function compararMes(profile) {
    const hoje = new Date();
    const ymA = yearMonthKey(hoje);
    const ymP = yearMonthKey(new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1));
    const txs = Array.isArray(profile?.transacoes) ? profile.transacoes : [];
    const sum = (ym) => txs.filter((t) => t.categoria === 'saida' && _ymOf(t.data) === ym)
        .reduce((s, t) => s + (Number(t.valor) || 0), 0);
    const atual = Math.round(sum(ymA) * 100) / 100;
    const passado = Math.round(sum(ymP) * 100) / 100;
    const dif = Math.round((atual - passado) * 100) / 100;
    const pct = passado > 0 ? Math.round((dif / passado) * 100) : null;
    return { atual, passado, dif, pct };
}

/** Média de gastos por mês (sobre os meses com movimentação). */
export function mediaMensal(profile) {
    const txs = (Array.isArray(profile?.transacoes) ? profile.transacoes : []).filter((t) => t.categoria === 'saida');
    const porMes = {};
    for (const t of txs) { const ym = _ymOf(t.data); if (!ym) continue; porMes[ym] = (porMes[ym] || 0) + (Number(t.valor) || 0); }
    const meses = Object.keys(porMes).length;
    const total = Object.values(porMes).reduce((s, v) => s + v, 0);
    return { media: meses > 0 ? Math.round((total / meses) * 100) / 100 : 0, meses };
}

/** Fatura(s) de cartão em aberto (opcionalmente de um cartão específico). */
export function faturaCartao(profile, cartaoHint) {
    const contas = (Array.isArray(profile?.contasFixas) ? profile.contasFixas : [])
        .filter((c) => c.tipoContaFixa === 'fatura_cartao' && !c.pago);
    const cards = Array.isArray(profile?.cartoesCredito) ? profile.cartoesCredito : [];
    const nomeCartao = (id) => { const c = cards.find((x) => String(x.id) === String(id)); return c ? (c.nomeBanco || c.nome || 'Cartão') : 'Cartão'; };

    let filtradas = contas;
    if (cartaoHint) {
        const h = norm(cartaoHint);
        const match = cards.find((c) => norm(c.nomeBanco || c.nome || '').includes(h));
        if (match) filtradas = contas.filter((c) => String(c.cartaoId) === String(match.id));
    }
    const porCartao = {};
    let total = 0;
    for (const f of filtradas) { const v = Number(f.valor) || 0; total += v; const nm = nomeCartao(f.cartaoId); porCartao[nm] = (porCartao[nm] || 0) + v; }
    return {
        total: Math.round(total * 100) / 100,
        itens: Object.entries(porCartao).map(([nome, valor]) => ({ nome, valor: Math.round(valor * 100) / 100 })),
        count: filtradas.length,
    };
}

/** Quanto falta pra completar uma meta. */
export function faltaMeta(profile, metaHint) {
    const metas = Array.isArray(profile?.metas) ? profile.metas : [];
    if (!metas.length) return { ok: false, reason: 'sem_meta' };
    let meta = null;
    if (metaHint) {
        const h = norm(metaHint);
        if (/emergenc/.test(h)) meta = metas.find((m) => String(m.id) === 'emergency' || /emergenc/.test(norm(_metaNome(m))));
        if (!meta) meta = metas.find((m) => norm(_metaNome(m)).includes(h));
    }
    if (!meta) { const ne = metas.filter((m) => String(m.id) !== 'emergency'); if (ne.length === 1) meta = ne[0]; }
    if (!meta) return { ok: false, reason: 'ambigua', opcoes: metas.map(_metaNome) };
    const alvo = _metaAlvo(meta);
    const saved = Number(meta.saved || 0);
    if (!(alvo > 0)) return { ok: false, reason: 'sem_alvo', nome: _metaNome(meta), saved: Math.round(saved * 100) / 100 };
    const faltam = Math.max(0, alvo - saved);
    return {
        ok: true, nome: _metaNome(meta),
        saved: Math.round(saved * 100) / 100, alvo: Math.round(alvo * 100) / 100,
        faltam: Math.round(faltam * 100) / 100, pct: Math.min(100, Math.round((saved / alvo) * 100)),
    };
}

/** Relatório do período: entradas, saídas, reservas, saldo. */
export function relatorio(profile, periodo = 'mes') {
    const txs = filterByPeriodo(profile?.transacoes, periodo);
    let entradas = 0, saidas = 0, reservas = 0, retiradas = 0;
    const porCategoria = {};

    for (const t of txs) {
        const v = Number(t.valor) || 0;
        if (t.categoria === 'entrada') entradas += v;
        else if (t.categoria === 'saida') { saidas += v; porCategoria[t.tipo || 'Outros'] = (porCategoria[t.tipo || 'Outros'] || 0) + v; }
        else if (t.categoria === 'reserva') reservas += v;
        else if (t.categoria === 'retirada_reserva') retiradas += v;
    }

    const topGastos = Object.entries(porCategoria).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const round = (n) => Math.round(n * 100) / 100;

    return {
        periodo,
        entradas: round(entradas),
        saidas: round(saidas),
        reservas: round(reservas),
        retiradas: round(retiradas),
        saldoPeriodo: round(entradas - saidas - reservas + retiradas),
        topGastos: topGastos.map(([tipo, valor]) => ({ tipo, valor: round(valor) })),
        count: txs.length,
    };
}

// Nome e alvo da meta moram em `descricao` e `objetivo` no app.
function _metaNome(m) {
    return String(m?.descricao ?? m?.nome ?? m?.name ?? m?.titulo ?? (String(m?.id) === 'emergency' ? 'Reserva de Emergência' : 'Meta')).trim();
}
function _metaAlvo(m) {
    return Number(m?.objetivo ?? m?.target ?? m?.alvo ?? m?.meta ?? 0);
}

/** Situação das reservas/metas. */
export function statusReservas(profile) {
    const metas = Array.isArray(profile?.metas) ? profile.metas : [];
    return metas.map((m) => {
        const saved = Number(m.saved || 0);
        const alvo = _metaAlvo(m);
        const pct = alvo > 0 ? Math.min(100, Math.round((saved / alvo) * 100)) : null;
        return { nome: _metaNome(m), saved: Math.round(saved * 100) / 100, alvo: Math.round(alvo * 100) / 100, pct };
    });
}

/**
 * Projeção: em quantos meses uma meta é atingida aportando `aporteMensal`.
 * @returns {{ok:true, nome, faltam, meses, aporte} | {ok:false, reason}}
 */
export function projecaoMeta(profile, cmd) {
    const metas = Array.isArray(profile?.metas) ? profile.metas : [];
    if (!metas.length) return { ok: false, reason: 'sem_meta' };
    if (!(cmd.aporteMensal > 0)) return { ok: false, reason: 'sem_aporte' };

    let meta = null;
    if (cmd.metaHint) {
        const h = norm(cmd.metaHint);
        if (/emergenc/.test(h)) meta = metas.find((m) => String(m.id) === 'emergency' || /emergenc/.test(norm(_metaNome(m))));
        if (!meta) meta = metas.find((m) => norm(_metaNome(m)).includes(h));
    }
    if (!meta) meta = metas.find((m) => String(m.id) !== 'emergency') || metas[0];

    const alvo = _metaAlvo(meta);
    if (!(alvo > 0)) return { ok: false, reason: 'sem_alvo' };

    const faltam = Math.max(0, alvo - Number(meta.saved || 0));
    const meses = Math.ceil(faltam / cmd.aporteMensal);
    return {
        ok: true,
        nome: _metaNome(meta),
        faltam: Math.round(faltam * 100) / 100,
        meses,
        aporte: cmd.aporteMensal,
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// MOTORES DE INSIGHT (proatividade) — 100% local. A IA nunca vê nada disto.
// Cada função é pura, defensiva e barata; o engine decide QUANDO surfacar.
// ═══════════════════════════════════════════════════════════════════════════

const _round = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** C23: quantas vezes (e quanto) do MESMO tipo já houve neste mês. */
export function contarPorTipoMes(profile, tipo, categoria = 'saida') {
    const ym = yearMonthKey(new Date());
    const txs = (Array.isArray(profile?.transacoes) ? profile.transacoes : [])
        .filter((t) => t.categoria === categoria && (t.tipo || 'Outros') === (tipo || 'Outros') && _ymOf(t.data) === ym);
    const total = txs.reduce((s, t) => s + (Number(t.valor) || 0), 0);
    return { tipo: tipo || 'Outros', count: txs.length, total: _round(total) };
}

/** B22: quanto ainda dá pra gastar este mês = média mensal − já gasto no mês. */
export function orcamentoRestante(profile) {
    const { media, meses } = mediaMensal(profile);
    const ym = yearMonthKey(new Date());
    const gastoMes = (Array.isArray(profile?.transacoes) ? profile.transacoes : [])
        .filter((t) => t.categoria === 'saida' && _ymOf(t.data) === ym)
        .reduce((s, t) => s + (Number(t.valor) || 0), 0);
    return { temHistorico: meses >= 2, media: _round(media), gastoMes: _round(gastoMes), restante: _round(media - gastoMes) };
}

/** C24: este tipo já passou (bem) da média histórica mensal dele? (alerta suave) */
export function alertaOrcamento(profile, tipo) {
    if (!tipo) return { alerta: false };
    const txs = (Array.isArray(profile?.transacoes) ? profile.transacoes : [])
        .filter((t) => t.categoria === 'saida' && (t.tipo || 'Outros') === tipo);
    const porMes = {};
    for (const t of txs) { const ym = _ymOf(t.data); if (ym) porMes[ym] = (porMes[ym] || 0) + (Number(t.valor) || 0); }
    const ymAtual = yearMonthKey(new Date());
    const atual = porMes[ymAtual] || 0;
    const anteriores = Object.entries(porMes).filter(([ym]) => ym !== ymAtual).map(([, v]) => v);
    if (anteriores.length < 2 || atual <= 0) return { alerta: false };
    const media = anteriores.reduce((s, v) => s + v, 0) / anteriores.length;
    const alerta = atual > media * 1.3 && (atual - media) > 20; // 30% acima E diferença material
    return { alerta, tipo, atual: _round(atual), media: _round(media), pct: media > 0 ? Math.round(((atual - media) / media) * 100) : 0 };
}

/** C25: resumo do dia (ontem + saldo do mês) para o 1º acesso do dia. */
export function resumoDoDia(profile) {
    const txs = Array.isArray(profile?.transacoes) ? profile.transacoes : [];
    const hoje = new Date();
    const ontem = new Date(hoje); ontem.setDate(ontem.getDate() - 1);
    const sameDay = (data, ref) => { const d = brDateToObj(data); return d && d.toDateString() === ref.toDateString(); };
    const ontemTxs = txs.filter((t) => t.categoria === 'saida' && sameDay(t.data, ontem));
    const ontemTotal = ontemTxs.reduce((s, t) => s + (Number(t.valor) || 0), 0);
    const rel = relatorio(profile, 'mes');
    return { ontemTotal: _round(ontemTotal), ontemCount: ontemTxs.length, saldoMes: rel.saldoPeriodo, gastoMes: rel.saidas, temMovimento: rel.count > 0 };
}

/** C29: dia da semana com maior gasto médio no trimestre (curiosidade leve). */
export function diaMaisCaro(profile) {
    const DIAS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
    const txs = filterByPeriodo(profile?.transacoes, 'trimestre').filter((t) => t.categoria === 'saida');
    if (txs.length < 5) return { ok: false };
    const soma = new Array(7).fill(0), cont = new Array(7).fill(0);
    for (const t of txs) { const d = brDateToObj(t.data); if (!d) continue; soma[d.getDay()] += (Number(t.valor) || 0); cont[d.getDay()]++; }
    let melhor = -1, maxMedia = -1;
    for (let i = 0; i < 7; i++) { if (!cont[i]) continue; const m = soma[i] / cont[i]; if (m > maxMedia) { maxMedia = m; melhor = i; } }
    return melhor < 0 ? { ok: false } : { ok: true, dia: DIAS[melhor], media: _round(maxMedia), total: _round(soma[melhor]) };
}

/** C27: assinaturas/recorrências (mesmo nome+valor em ≥2 meses, ou categoria assinatura). */
export function assinaturasRecorrentes(profile) {
    const txs = (Array.isArray(profile?.transacoes) ? profile.transacoes : [])
        .filter((t) => t.categoria === 'assinatura' || t.categoria === 'saida');
    const grupos = {};
    for (const t of txs) {
        const nome = String(t.descricao || t.tipo || '').trim();
        const val = Math.round(Number(t.valor) || 0);
        const ym = _ymOf(t.data);
        if (!nome || val <= 0 || !ym) continue;
        const key = `${nome.toLowerCase()}|${val}`;
        (grupos[key] = grupos[key] || { nome, valor: Number(t.valor) || 0, meses: new Set() }).meses.add(ym);
    }
    return Object.values(grupos)
        .filter((g) => g.meses.size >= 2)
        .map((g) => ({ nome: g.nome, valor: _round(g.valor), meses: g.meses.size }))
        .sort((a, b) => b.meses - a.meses)
        .slice(0, 5);
}

/** C30: metas com saldo mas sem aporte há mais de `dias` (reserva parada). */
export function metasParadas(profile, dias = 20) {
    const metas = Array.isArray(profile?.metas) ? profile.metas : [];
    const txs = Array.isArray(profile?.transacoes) ? profile.transacoes : [];
    const hoje = new Date();
    const out = [];
    for (const m of metas) {
        const saved = Number(m.saved || 0);
        if (saved <= 0) continue;
        const aportes = txs.filter((t) => t.categoria === 'reserva' && String(t.metaId) === String(m.id))
            .map((t) => brDateToObj(t.data)).filter(Boolean).sort((a, b) => b - a);
        if (!aportes.length) continue; // sem histórico de aporte rastreável
        const diasParado = Math.floor((hoje - aportes[0]) / 864e5);
        if (diasParado > dias) out.push({ nome: _metaNome(m), saved: _round(saved), diasParado });
    }
    return out.sort((a, b) => b.diasParado - a.diasParado).slice(0, 3);
}

/** A7: streak de dias consecutivos com ≥1 lançamento (só "vivo" se lançou hoje/ontem). */
export function streakDias(profile) {
    const txs = Array.isArray(profile?.transacoes) ? profile.transacoes : [];
    const dias = new Set();
    for (const t of txs) { const d = brDateToObj(t.data); if (d) { d.setHours(0, 0, 0, 0); dias.add(d.toDateString()); } }
    if (!dias.size) return 0;
    const cursor = new Date(); cursor.setHours(0, 0, 0, 0);
    if (!dias.has(cursor.toDateString())) { cursor.setDate(cursor.getDate() - 1); if (!dias.has(cursor.toDateString())) return 0; }
    let streak = 0;
    while (dias.has(cursor.toDateString())) { streak++; cursor.setDate(cursor.getDate() - 1); }
    return streak;
}

/** C31: dados agregados para a narrativa "explique meu mês". */
export function narrativaMes(profile) {
    return {
        rel: relatorio(profile, 'mes'),
        comp: compararMes(profile),
        top: maioresGastos(profile, 'mes'),
        saldo: saldoAtual(profile),
        orcamento: orcamentoRestante(profile),
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// PROATIVIDADE — insights de abertura / marcos (Bloco C) — 100% local.
// ═══════════════════════════════════════════════════════════════════════════

/** "YYYY-MM-DD" (ISO, meia-noite local) → Date, senão null. */
function _isoToDate(iso) {
    if (typeof iso !== 'string') return null;
    const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return Number.isNaN(d.getTime()) ? null : d;
}
function _diasAte(d) {
    const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
    const alvo = new Date(d); alvo.setHours(0, 0, 0, 0);
    return Math.round((alvo - hoje) / 864e5);
}

/** C21: fatura de cartão vencendo em ≤ `dias` (ou já vencida). Só a mais próxima. */
export function faturaVencendo(profile, dias = 6) {
    const contas = (Array.isArray(profile?.contasFixas) ? profile.contasFixas : [])
        .filter((c) => c.tipoContaFixa === 'fatura_cartao' && !c.pago && Number(c.valor) > 0);
    if (!contas.length) return { ok: false };
    const cards = Array.isArray(profile?.cartoesCredito) ? profile.cartoesCredito : [];
    const nomeCartao = (id) => { const c = cards.find((x) => String(x.id) === String(id)); return c ? (c.nomeBanco || c.nome || 'cartão') : 'cartão'; };
    let melhor = null;
    for (const c of contas) {
        const d = _isoToDate(c.vencimento);
        if (!d) continue;
        const diff = _diasAte(d);
        if (diff > dias) continue; // ainda longe
        if (!melhor || diff < melhor.dias) melhor = { dias: diff, valor: _round(c.valor), nome: nomeCartao(c.cartaoId), vencida: diff < 0 };
    }
    return melhor ? { ok: true, ...melhor } : { ok: false };
}

/** C22: dia provável de salário (recorrente) e se ainda não caiu este mês. */
export function salarioProvavel(profile) {
    const txs = (Array.isArray(profile?.transacoes) ? profile.transacoes : [])
        .filter((t) => t.categoria === 'entrada' && /sal[aá]rio/i.test(String(t.tipo || t.descricao || '')));
    if (txs.length < 2) return { ok: false };
    // Dia do mês mais frequente entre os salários registrados.
    const cont = {};
    for (const t of txs) { const d = brDateToObj(t.data); if (d) { const dia = d.getDate(); cont[dia] = (cont[dia] || 0) + 1; } }
    const entradas = Object.entries(cont).sort((a, b) => b[1] - a[1]);
    if (!entradas.length || entradas[0][1] < 2) return { ok: false }; // sem recorrência clara
    const dia = Number(entradas[0][0]);
    const hoje = new Date();
    const ym = yearMonthKey(hoje);
    const caiuEsteMes = txs.some((t) => _ymOf(t.data) === ym);
    const perto = Math.abs(hoje.getDate() - dia) <= 1;
    return { ok: true, dia, caiuEsteMes, perto };
}

/** C23: dias restantes até o fim do mês + se houve movimento no mês. */
export function fimDeMes(profile) {
    const hoje = new Date();
    const ultimoDia = new Date(hoje.getFullYear(), hoje.getMonth() + 1, 0).getDate();
    const diasRestantes = ultimoDia - hoje.getDate();
    const rel = relatorio(profile, 'mes');
    return { diasRestantes, temMovimento: rel.count > 0, saldoMes: rel.saldoPeriodo };
}

/** Patrimônio guardado (soma de metas.saved). */
export function totalReservado(profile) {
    return _round((Array.isArray(profile?.metas) ? profile.metas : []).reduce((s, m) => s + Math.max(0, Number(m.saved) || 0), 0));
}

const _MARCOS_RESERVA = [1000, 5000, 10000, 25000, 50000, 100000];
/** C24: marco de reserva cruzado AGORA por um aporte de `txValor`. null se nenhum. */
export function marcoReserva(profile, txValor) {
    const agora = totalReservado(profile);
    const antes = agora - (Number(txValor) || 0);
    for (let i = _MARCOS_RESERVA.length - 1; i >= 0; i--) {
        const T = _MARCOS_RESERVA[i];
        if (agora >= T && antes < T) return { marco: T, total: agora };
    }
    return null;
}

const _MARCOS_COUNT = [50, 100, 250, 500, 1000];
/** C24: marco de contagem de lançamentos (chamado logo após inserir). null se nenhum. */
export function marcoContagem(profile) {
    const n = (Array.isArray(profile?.transacoes) ? profile.transacoes : []).length;
    return _MARCOS_COUNT.includes(n) ? { marco: n } : null;
}

/** C26: total de conquistas desbloqueadas (mapa {id: ISOdate} em profile.conquistas). */
export function conquistasResumo(profile) {
    const c = profile?.conquistas;
    const total = c && typeof c === 'object' ? Object.keys(c).length : 0;
    return { total };
}
/** C26: quantas conquistas foram desbloqueadas HOJE (para insight de abertura). */
export function conquistasHoje(profile) {
    const c = profile?.conquistas;
    if (!c || typeof c !== 'object') return 0;
    const hojeISO = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
    let n = 0;
    for (const v of Object.values(c)) { if (typeof v === 'string' && v.slice(0, 10) === hojeISO) n++; }
    return n;
}
