// ----------------------------------------------------------------------------
// ritmo-metas.js — "você vai chegar lá no prazo que prometeu?" (item 3)
//
// A meta já aceitava um prazo (`prazo: 'MM/YYYY'`) e o form já mostrava, no
// PREVIEW, quanto seria preciso guardar por mês. Só que depois de criada a meta
// o prazo virava uma tag decorativa: "⏰ Jul/2027" e mais nada. Prazo sem ritmo
// não cobra, não orienta e não avisa quando você saiu da rota — é enfeite.
// Este módulo responde, a qualquer momento: preciso de X/mês, você faz Y/mês.
//
// ── DECISÃO DE MODELAGEM: por que o ritmo real NÃO sai de `meta.monthly` ─────
// `meta.monthly` parece a fonte óbvia (mapa 'YYYY-MM' → valor), mas ele é
// ALIMENTADO TAMBÉM PELO RENDIMENTO DIÁRIO (db-metas.js:143, aplicarRendimentos
// Diarios). Uma reserva de R$50k no CDI credita ~R$400/mês sozinha; usar
// `monthly` diria "você guarda R$400/mês" para quem não guardou NADA — o juro
// se disfarçaria de esforço e a meta pareceria saudável enquanto a pessoa parou
// de aportar. É justamente quando o alerta MAIS importa.
//
// A fonte honesta são as transações com `metaId`, que só existem por ação
// explícita do usuário:
//   • categoria 'reserva'          (tipo 'Reserva')             → aporte  (+)
//   • categoria 'retirada_reserva' (tipo 'Retirada de Reserva') → retirada(−)
// Usamos o marcador de origem (`metaId`), nunca o rótulo `tipo` — texto de
// rótulo já foi causa-raiz de bug neste projeto (ver previsao-mes/recorrencias).
//
// 100% puro: sem DOM, sem rede. `hoje` e `taxaMensal` são injetados — a taxa
// vem de `_taxaMensal(meta)` no db-metas, que depende do CDI buscado na rede e
// por isso não pode morar aqui.
// ----------------------------------------------------------------------------

/** Valor futuro com aportes mensais. FV = PV(1+r)^n + PMT·((1+r)^n − 1)/r */
export function fvComposto(pv, pmt, r, n) {
    if (r <= 0) return pv + pmt * n;
    return pv * Math.pow(1 + r, n) + pmt * ((Math.pow(1 + r, n) - 1) / r);
}

/** Em quantos meses o objetivo é atingido no ritmo atual (null = nunca/>50 anos). */
export function mesesParaMeta(pv, obj, pmt, r) {
    for (let n = 1; n <= 600; n++) {
        if (fvComposto(pv, pmt, r, n) >= obj) return n;
    }
    return null;
}

/** Aporte mensal necessário para sair de `pv` e chegar em `obj` em `n` meses. */
export function aporteNecessario(pv, obj, r, n) {
    if (n <= 0) return null;
    const fv = obj - pv * Math.pow(1 + r, n);
    if (r <= 0) return fv / n;
    const fator = Math.pow(1 + r, n) - 1;
    if (fator <= 0) return null;
    return fv * r / fator;
}

/**
 * Meses de aporte que ainda cabem até o prazo, incluindo o mês corrente.
 *
 * `prazo` é 'MM/YYYY' e significa "até o FIM daquele mês". Logo, estando em
 * Jul/2027 com prazo Jul/2027 ainda resta 1 mês (este). Em Ago/2027 → 0 (vencido).
 * Fonte única desta conta: o form de criação também chama esta função, senão o
 * preview e a tag da lista mostrariam R$/mês diferentes para a mesma meta.
 *
 * @returns {number|null} meses restantes (0 = vencido), ou null se o prazo é inválido
 */
export function mesesAtePrazo(prazo, hoje = new Date()) {
    if (typeof prazo !== 'string') return null;
    const m = /^(\d{1,2})\/(\d{4})$/.exec(prazo.trim());
    if (!m) return null;
    const mes = parseInt(m[1], 10);
    const ano = parseInt(m[2], 10);
    if (!(mes >= 1 && mes <= 12)) return null;
    const diff = (ano - hoje.getFullYear()) * 12 + (mes - (hoje.getMonth() + 1));
    return Math.max(0, diff + 1);
}

const _MESES_JANELA_PADRAO = 3;

// "DD/MM/YYYY" ou "YYYY-MM-DD" → Date (ou null). Mesmo parser dos módulos irmãos.
function _txDate(data) {
    if (typeof data !== 'string') return null;
    let y, m, d;
    if (/^\d{4}-\d{2}-\d{2}/.test(data)) {
        [y, m, d] = data.slice(0, 10).split('-').map(Number);
    } else if (/^\d{2}\/\d{2}\/\d{4}/.test(data)) {
        [d, m, y] = data.slice(0, 10).split('/').map(Number);
    } else {
        return null;
    }
    const dt = new Date(y, m - 1, d);
    return isNaN(dt.getTime()) ? null : dt;
}

/**
 * Quanto o usuário REALMENTE aportou por mês, na média da janela.
 *
 * Líquido: retiradas descontam. Quem guarda R$500 e tira R$500 todo mês tem
 * ritmo ZERO — e precisa saber disso, porque o saldo não anda.
 *
 * O denominador não é a janela fixa: uma meta criada há 10 dias com um aporte
 * de R$1.000 não faz "R$1.000/mês" — divide-se pelos meses DECORRIDOS desde o
 * primeiro aporte (piso 1, teto = janela), senão o ritmo de uma meta nova sai
 * inflado e ela parece adiantada logo antes de decepcionar.
 *
 * @returns {{real:number, aportes:number, temHistorico:boolean}}
 */
export function ritmoReal(metaId, transacoes, hoje = new Date(), janelaMeses = _MESES_JANELA_PADRAO) {
    const vazio = { real: 0, aportes: 0, temHistorico: false };
    if (!Array.isArray(transacoes) || metaId == null) return vazio;

    // Início da janela: 1º dia do mês que abre a janela (inclui o mês corrente).
    const inicio = new Date(hoje.getFullYear(), hoje.getMonth() - (janelaMeses - 1), 1);

    let liquido = 0;
    let aportes = 0;
    let primeira = null;

    for (const t of transacoes) {
        if (String(t.metaId ?? '') !== String(metaId)) continue;
        const sinal = t.categoria === 'reserva' ? 1
                    : t.categoria === 'retirada_reserva' ? -1
                    : 0;
        if (sinal === 0) continue;                 // marcador de origem, nunca o rótulo
        const dt = _txDate(t.data);
        if (!dt || dt < inicio || dt > hoje) continue;
        const v = parseFloat(t.valor);
        if (!isFinite(v) || v <= 0) continue;

        liquido += sinal * v;
        if (sinal > 0) aportes++;
        if (primeira === null || dt < primeira) primeira = dt;
    }

    if (primeira === null) return vazio;

    const mesesDecorridos = (hoje.getFullYear() - primeira.getFullYear()) * 12
                          + (hoje.getMonth() - primeira.getMonth()) + 1;
    const divisor = Math.min(janelaMeses, Math.max(1, mesesDecorridos));

    return { real: liquido / divisor, aportes, temHistorico: true };
}

/**
 * Diagnóstico de ritmo de UMA meta.
 *
 * @param {Object} meta        { objetivo, saved, prazo }
 * @param {Array}  transacoes  todas as transações do perfil
 * @param {number} taxaMensal  taxa mensal efetiva (0 = sem rendimento) — injetada
 * @param {Date}   hoje
 * @param {Object} opts        { janelaMeses, tolerancia }
 * @returns {{status:string, necessario:number, real:number, mesesRestantes:number,
 *            falta:number, gap:number}}
 *   status: 'sem_prazo' | 'concluida' | 'vencida' | 'sem_historico'
 *         | 'no_ritmo'  | 'atrasada'
 */
export function analisarRitmo(meta, transacoes, taxaMensal = 0, hoje = new Date(), opts = {}) {
    const janelaMeses = opts.janelaMeses ?? _MESES_JANELA_PADRAO;
    // 5% de folga: sem isso, R$499,90/mês contra R$500 necessários acusaria
    // "atrasada" por 10 centavos e a tag ficaria piscando entre os dois estados.
    const tolerancia  = opts.tolerancia ?? 0.95;

    const base = { status: 'sem_prazo', necessario: 0, real: 0, mesesRestantes: 0, falta: 0, gap: 0 };
    if (!meta || typeof meta !== 'object') return base;

    const objetivo = parseFloat(meta.objetivo) || 0;
    const saved    = parseFloat(meta.saved) || 0;
    const falta    = Math.max(0, objetivo - saved);

    if (objetivo <= 0) return base;
    if (falta <= 0) return { ...base, status: 'concluida', falta: 0 };
    if (!meta.prazo) return base;

    const mesesRestantes = mesesAtePrazo(meta.prazo, hoje);
    if (mesesRestantes === null) return base;                       // prazo corrompido
    if (mesesRestantes === 0) return { ...base, status: 'vencida', falta };

    const r = isFinite(taxaMensal) && taxaMensal > 0 ? taxaMensal : 0;
    const necessarioRaw = aporteNecessario(saved, objetivo, r, mesesRestantes);
    // null/≤0 ⇒ o rendimento sozinho já leva a meta ao objetivo dentro do prazo.
    const necessario = (necessarioRaw === null || necessarioRaw <= 0) ? 0 : necessarioRaw;

    const { real, temHistorico } = ritmoReal(meta.id, transacoes, hoje, janelaMeses);

    if (necessario === 0) {
        return { status: 'no_ritmo', necessario: 0, real, mesesRestantes, falta, gap: 0 };
    }
    // Sem nenhum aporte na janela não dá para falar em "ritmo": em vez de acusar
    // de atrasada uma meta recém-criada, orienta com o valor necessário.
    if (!temHistorico) {
        return { status: 'sem_historico', necessario, real: 0, mesesRestantes, falta, gap: necessario };
    }

    const status = real >= necessario * tolerancia ? 'no_ritmo' : 'atrasada';
    return { status, necessario, real, mesesRestantes, falta, gap: Math.max(0, necessario - real) };
}
