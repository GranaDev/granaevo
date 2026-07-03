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

    const hoje = new Date();
    const ymAtual = yearMonthKey(hoje);
    const ymPassado = yearMonthKey(new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1));

    return arr.filter((t) => {
        const d = brDateToObj(t?.data);
        if (!d) return periodo === 'tudo';
        switch (periodo) {
            case 'hoje':        return d.toDateString() === hoje.toDateString();
            case 'semana':      return (hoje - d) <= 7 * 864e5 && d <= hoje;
            case 'mes':         return yearMonthKey(d) === ymAtual;
            case 'mes_passado': return yearMonthKey(d) === ymPassado;
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
