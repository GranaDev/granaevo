// ----------------------------------------------------------------------------
// ciclo-fatura.js — quando a fatura fecha, e o que isso muda (item 2)
//
// Fechamento não é vencimento, e confundir os dois custa dinheiro:
//   • VENCIMENTO  = quando você PAGA. Perder = juros de cartão.
//   • FECHAMENTO  = quando a fatura para de aceitar compras. Uma compra feita
//     um dia ANTES cai na fatura que vence em ~10 dias; um dia DEPOIS, cai na
//     seguinte, que vence ~40 dias à frente. O mesmo cafezinho, ~30 dias de
//     prazo grátis de diferença. É a única alavanca de fluxo de caixa que o
//     usuário controla sem gastar menos.
//
// ── POR QUE ESTE MÓDULO EXISTE ──────────────────────────────────────────────
// A conta estava DUPLICADA e as duas cópias discordavam:
//   • radar.js (_proximaOcorrencia): correta — normaliza para meia-noite e usa
//     `<` estrito, então acerta no próprio dia do fechamento.
//   • db-cartoes.js (painel "Resumo do cartão"): usava `new Date()` COM hora e
//     `<=`, então NO DIA em que a fatura fechava exibia "Fecha em 31 dias" —
//     exatamente invertido no único dia em que a informação decide a compra.
// Uma conta, uma implementação, testada. É a mesma unificação que ritmo-metas.js
// precisou fazer com a matemática financeira das metas.
//
// 100% puro: sem DOM, sem rede, `hoje` injetável.
// ----------------------------------------------------------------------------

const _MS_DIA = 86_400_000;

/** Meia-noite de uma data — comparar datas com hora embutida é fonte de bug. */
export function meiaNoite(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
}

/**
 * Próxima ocorrência de um dia do mês, a partir de `base` (inclusive).
 *
 * "Inclusive" é a regra que importa: se hoje é dia 10 e o ciclo fecha no dia 10,
 * a próxima ocorrência é HOJE — não daqui a um mês. A versão com `<=` empurrava
 * para o mês seguinte e mentia justamente no dia decisivo.
 *
 * @returns {Date|null} null se o dia for inválido
 */
export function proximaOcorrencia(diaDoMes, base = new Date()) {
    if (!Number.isInteger(diaDoMes) || diaDoMes < 1 || diaDoMes > 31) return null;
    const b = meiaNoite(base);
    const d = new Date(b.getFullYear(), b.getMonth(), diaDoMes);
    if (d < b) return new Date(b.getFullYear(), b.getMonth() + 1, diaDoMes);
    return d;
}

/** Dia de fechamento efetivo do cartão, ou null se não dá para saber. */
export function diaFechamentoDe(cartao) {
    if (!cartao || typeof cartao !== 'object') return null;
    const d = Number.isInteger(cartao.fechamentoDia) ? cartao.fechamentoDia
            : Number.isInteger(cartao.vencimentoDia) ? cartao.vencimentoDia
            : null;
    // O app só oferece 1–28 (evita o buraco de fevereiro/meses de 30 dias).
    // Fora disso é dado legado/corrompido: melhor não afirmar nada.
    return (d !== null && d >= 1 && d <= 28) ? d : null;
}

/**
 * Dias até a fatura fechar. 0 = fecha HOJE (last call para usar esta fatura).
 * @returns {number|null}
 */
export function diasAteFechamento(cartao, hoje = new Date()) {
    const dia = diaFechamentoDe(cartao);
    if (dia === null) return null;
    const fech = proximaOcorrencia(dia, hoje);
    return Math.round((fech - meiaNoite(hoje)) / _MS_DIA);
}

/**
 * Melhor dia para comprar: o dia seguinte ao fechamento — a compra entra na
 * fatura mais distante possível, maximizando o prazo até pagar.
 *
 * A versão antiga era `(diaFechamento % 28) + 1`, que quebrava na ponta: com
 * fechamento no dia 28 dizia "melhor dia: 1" (deveria ser 29) — mandava o
 * usuário comprar no PIOR dia possível, logo depois do fechamento seguinte.
 *
 * Devolve o DIA do mês. Como o app limita o fechamento a 1–28, o dia seguinte
 * (2–29) existe em todo mês, inclusive fevereiro.
 *
 * @returns {number|null}
 */
export function melhorDiaCompra(cartao) {
    const dia = diaFechamentoDe(cartao);
    if (dia === null) return null;
    return dia + 1;
}

/**
 * Retrato do ciclo do cartão para a UI.
 *
 * @returns {{diaFechamento, fechamento:Date, diasAteFechamento:number,
 *            fechaHoje:boolean, urgente:boolean, melhorDia:number,
 *            proximaFatura:Date}|null}
 *   urgente: ≤3 dias — janela em que ainda dá para adiar uma compra grande.
 *   proximaFatura: quando começa o ciclo seguinte (= dia seguinte ao fechamento).
 */
export function analisarCiclo(cartao, hoje = new Date()) {
    const diaFechamento = diaFechamentoDe(cartao);
    if (diaFechamento === null) return null;

    const fechamento = proximaOcorrencia(diaFechamento, hoje);
    const dias = Math.round((fechamento - meiaNoite(hoje)) / _MS_DIA);

    return {
        diaFechamento,
        fechamento,
        diasAteFechamento: dias,
        fechaHoje: dias === 0,
        urgente:   dias <= 3,
        melhorDia: diaFechamento + 1,
        proximaFatura: new Date(fechamento.getTime() + _MS_DIA),
    };
}
