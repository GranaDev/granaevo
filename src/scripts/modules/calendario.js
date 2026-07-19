// ----------------------------------------------------------------------------
// calendario.js — eventos financeiros de um mês, por dia (Passo 11)
//
// O QUE ISTO RESOLVE: os dados de vencimento já existiam, mas espalhados por
// telas diferentes — contas fixas numa, faturas noutra, assinaturas noutra. Não
// havia lugar nenhum que respondesse "o que cai neste mês, e em que dia?".
// Este módulo junta tudo num índice por data; a tela só desenha.
//
// NÃO INVENTA DADO: só reorganiza o que o usuário já registrou. Nada aqui
// projeta, estima ou adivinha — quem faz previsão é previsao-mes.js, e o
// calendário mostra fatos (o que está lançado e o que vence).
//
// 100% puro: sem DOM, sem rede, sem estado. Datas tratadas como STRING
// 'YYYY-MM-DD' de ponta a ponta — criar Date para comparar dia é a origem
// clássica de erro de fuso (o dia "pula" dependendo do horário e do timezone).
// ----------------------------------------------------------------------------

const _ISO = /^\d{4}-\d{2}-\d{2}$/;

/** 'DD/MM/AAAA' (formato das transações) ou ISO → 'YYYY-MM-DD', senão null. */
export function paraISO(data) {
    if (typeof data !== 'string') return null;
    if (_ISO.test(data.slice(0, 10))) return data.slice(0, 10);
    const m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(data);
    return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

/** Nº de dias do mês (mes: 1–12). */
export function diasNoMes(ano, mes) {
    return new Date(ano, mes, 0).getDate();
}

/** Dia da semana do dia 1 (0=domingo) — usado para alinhar a grade. */
export function primeiroDiaSemana(ano, mes) {
    return new Date(ano, mes - 1, 1).getDay();
}

const _num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/**
 * Índice de eventos do mês, por data.
 *
 * TIPOS (a ordem importa: é a prioridade de exibição no marcador do dia)
 *   'fatura'     — fatura de cartão vencendo (o que mais dói esquecer)
 *   'conta'      — conta fixa vencendo
 *   'assinatura' — cobrança recorrente prevista para o dia
 *   'entrada'    — dinheiro que entrou
 *   'saida'      — dinheiro que saiu
 *
 * @returns {Map<string, Array<{tipo, titulo, valor, pago?}>>} chave 'YYYY-MM-DD'
 */
export function eventosDoMes(dados, ano, mes) {
    // Desestruturar direto no parâmetro quebraria com `null`: o valor padrão de
    // desestruturação só cobre `undefined`. Quem chama isto vem de estado de app
    // que pode estar meio carregado — estourar aqui derrubaria a tela inteira.
    const { contasFixas = [], transacoes = [], assinaturas = [] } = (dados && typeof dados === 'object') ? dados : {};
    const mapa = new Map();
    const a = Number(ano), m = Number(mes);
    if (!Number.isInteger(a) || !Number.isInteger(m) || m < 1 || m > 12) return mapa;

    const prefixo = `${a}-${String(m).padStart(2, '0')}`;
    const add = (iso, ev) => {
        if (!iso || !iso.startsWith(prefixo)) return;
        if (!mapa.has(iso)) mapa.set(iso, []);
        mapa.get(iso).push(ev);
    };

    // ── Contas fixas e faturas de cartão ────────────────────────────────────
    for (const c of (Array.isArray(contasFixas) ? contasFixas : [])) {
        if (!c || !_ISO.test(String(c.vencimento || ''))) continue;
        const ehFatura = c.tipoContaFixa === 'fatura_cartao';
        add(c.vencimento, {
            tipo:   ehFatura ? 'fatura' : 'conta',
            titulo: String(c.descricao || (ehFatura ? 'Fatura' : 'Conta fixa')).slice(0, 60),
            valor:  _num(c.valor),
            pago:   c.pago === true,
        });
    }

    // ── Assinaturas: dia fixo de cobrança ───────────────────────────────────
    // `diaCobranca` pode não existir no mês (31 em fevereiro) → cai no último
    // dia, que é como a cobrança realmente acontece.
    const ultimo = diasNoMes(a, m);
    for (const s of (Array.isArray(assinaturas) ? assinaturas : [])) {
        if (!s || s.ativa === false) continue;
        const dia = Number(s.diaCobranca);
        if (!Number.isInteger(dia) || dia < 1 || dia > 31) continue;
        const diaReal = Math.min(dia, ultimo);
        add(`${prefixo}-${String(diaReal).padStart(2, '0')}`, {
            tipo:   'assinatura',
            titulo: String(s.nome || 'Assinatura').slice(0, 60),
            valor:  _num(s.valor),
        });
    }

    // ── Transações do mês ───────────────────────────────────────────────────
    for (const t of (Array.isArray(transacoes) ? transacoes : [])) {
        if (!t) continue;
        const iso = paraISO(t.data);
        if (!iso) continue;
        const ehEntrada = t.categoria === 'entrada';
        const ehSaida   = t.categoria === 'saida' || t.categoria === 'saida_credito';
        if (!ehEntrada && !ehSaida) continue;   // reserva/retirada não são "gasto do dia"
        add(iso, {
            tipo:   ehEntrada ? 'entrada' : 'saida',
            titulo: String(t.descricao || t.tipo || '—').slice(0, 60),
            valor:  Math.abs(_num(t.valor)),
        });
    }

    return mapa;
}

/**
 * Resumo de um dia — o que o marcador na grade precisa saber.
 * `tipos` sai ORDENADO por prioridade (fatura primeiro), porque o marcador
 * mostra poucos pontinhos e o que importa é não esconder o vencimento.
 */
export const PRIORIDADE = Object.freeze(['fatura', 'conta', 'assinatura', 'entrada', 'saida']);

export function resumoDoDia(eventos) {
    const lista = Array.isArray(eventos) ? eventos : [];
    const tipos = [];
    let entrou = 0, saiu = 0, aVencer = 0;

    for (const tp of PRIORIDADE) {
        if (lista.some(e => e && e.tipo === tp)) tipos.push(tp);
    }
    for (const e of lista) {
        if (!e) continue;
        if (e.tipo === 'entrada') entrou += _num(e.valor);
        else if (e.tipo === 'saida') saiu += _num(e.valor);
        else if ((e.tipo === 'fatura' || e.tipo === 'conta') && e.pago !== true) aVencer += _num(e.valor);
    }
    return {
        tipos,
        total:   lista.length,
        entrou:  Math.round(entrou * 100) / 100,
        saiu:    Math.round(saiu * 100) / 100,
        aVencer: Math.round(aVencer * 100) / 100,
    };
}

/** Totais do mês inteiro — cabeçalho da tela. */
export function totaisDoMes(mapa) {
    let entrou = 0, saiu = 0, aVencer = 0, dias = 0;
    for (const lista of (mapa instanceof Map ? mapa.values() : [])) {
        const r = resumoDoDia(lista);
        entrou += r.entrou; saiu += r.saiu; aVencer += r.aVencer;
        if (r.total > 0) dias++;
    }
    return {
        entrou:  Math.round(entrou * 100) / 100,
        saiu:    Math.round(saiu * 100) / 100,
        aVencer: Math.round(aVencer * 100) / 100,
        diasComEvento: dias,
    };
}
