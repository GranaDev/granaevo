// patrimonio.js — "Previsão de patrimônio (1/5/10 anos)" — motor puro
// ----------------------------------------------------------------------------
// Projeta onde o usuário chega no ritmo ATUAL:
//
//   patrimônio hoje = saldo em conta + total reservado em metas
//   poupança mensal = média de (entradas − saídas) nos últimos N meses COMPLETOS
//   projeção(n)     = P·(1+i)^n + PMT·(((1+i)^n − 1)/i)      [i > 0]
//                   = P + PMT·n                              [i = 0]
//
// 100% client-side, matemática pura — nenhum dado sai do navegador.
// `hoje` é injetável (testes + determinismo), igual a score-financeiro.js.
//
// ── DECISÃO DE MODELAGEM: por que NÃO excluímos o marcador de origem ────────
// Os módulos irmãos (previsao-mes, recorrencias, duplicados, assinatura-precos)
// pulam transações com `contaFixaId/faturaId/compraId`. Aqui isso seria um BUG,
// e a razão é a diferença entre os dois cálculos:
//
//   • previsao-mes usa o marcador para estimar o GASTO VARIÁVEL médio/dia, e
//     contabiliza as fixas/faturas SEPARADAMENTE (contasAPagar). Sem a exclusão
//     ele contaria o aluguel DUAS vezes. A exclusão evita double-count.
//   • aqui a poupança mensal é um FLUXO LÍQUIDO. Não há contabilização separada
//     de nada: excluir aluguel e fatura apagaria as maiores despesas reais do
//     usuário e inflaria a poupança — exatamente o otimismo forçado que este
//     motor deve evitar. Essas transações são saídas REAIS de dinheiro, criadas
//     no PAGAMENTO (dashboard.js `saida`+contaFixaId; db-cartoes.js
//     `saida`+faturaId), e já reduzem o saldo.
//
// A coerência exigida é aritmética: `patrimonioHoje` deriva do saldo, que INCLUI
// essas saídas. Se o estoque as inclui e o fluxo não, o ponto de partida e a
// taxa de crescimento discordam sobre o que é dinheiro. Com a regra abaixo vale
// a identidade: Σ(poupança mensal) = variação do patrimônio no período.
//
// O double-count real neste módulo é OUTRO: 'saida_credito' (compra no cartão)
// NÃO entra, porque o dinheiro só sai de fato no pagamento da fatura, que já é
// uma 'saida'. Contar os dois cobraria a mesma compra duas vezes.
// ----------------------------------------------------------------------------

// ── Datas ─────────────────────────────────────────────────────────────────────
// t.data chega como "DD/MM/YYYY" (padrão do app) ou "YYYY-MM-DD" (legado/import).
// Mesma tolerância de previsao-mes.js (_txDate).
function _txDate(data) {
    if (typeof data !== 'string') return null;
    let y, m, d;
    if (data.includes('/')) {
        const p = data.split('/');
        if (p.length !== 3) return null;
        d = +p[0]; m = +p[1]; y = +p[2];
    } else if (data.includes('-')) {
        const p = data.split('-');
        if (p.length < 3) return null;
        y = +p[0]; m = +p[1]; d = parseInt(p[2], 10);
    } else return null;
    if (!y || !m || !d || m < 1 || m > 12 || d < 1 || d > 31) return null;
    return new Date(y, m - 1, d);
}

function _valSeguro(v) {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Índice ordinal absoluto do mês — permite comparar/subtrair meses sem drama. */
function _mesIdx(d) {
    return d.getFullYear() * 12 + d.getMonth();
}

/**
 * Patrimônio de hoje = saldo em conta + total guardado em metas.
 * Mirror do saldo do dashboard (entrada+ / saida− / reserva− / retirada+) somado
 * ao `meta.saved`. Aportar numa reserva é transferência interna: sai do saldo e
 * entra no reservado → patrimônio não muda. Exportado p/ reuso e teste.
 */
export function calcularPatrimonioHoje(ctx) {
    let saldo = 0;
    for (const t of (ctx?.transacoes || [])) {
        const v = _valSeguro(t.valor);
        if      (t.categoria === 'entrada')          saldo += v;
        else if (t.categoria === 'saida')            saldo -= v;
        else if (t.categoria === 'reserva')          saldo -= v;
        else if (t.categoria === 'retirada_reserva') saldo += v;
    }
    let reservado = 0;
    for (const m of (ctx?.metas || [])) {
        reservado += Math.max(0, _valSeguro(m?.saved));
    }
    return { patrimonioHoje: saldo + reservado, saldo, reservado };
}

/**
 * Poupança mensal observada = média de (entradas − saídas) por mês.
 *
 * Regras:
 *  • Só meses COMPLETOS. O mês corrente está pela metade e distorce (o salário
 *    já caiu mas as contas ainda não venceram, ou vice-versa).
 *  • 'reserva'/'retirada_reserva' NÃO entram: são transferências internas, não
 *    mudam o patrimônio (já refletidas em `saved`).
 *  • 'saida_credito' NÃO entra: o dinheiro sai no pagamento da fatura, que já é
 *    uma 'saida'. Contar os dois = cobrar a compra duas vezes.
 *  • Denominador ADAPTATIVO (análogo em meses ao piso/teto de dias de
 *    previsao-mes.js): meses realmente cobertos entre a 1ª transação da janela e
 *    o último mês completo, com piso 1 e teto `mesesJanela`. Dividir os 2 meses
 *    de um usuário novo por 6 subestimaria a poupança dele em 3×.
 *  • Meses SEM transação dentro do histórico contam no denominador — mês parado
 *    é mês de poupança zero, pulá-lo inflaria a média.
 */
function _poupancaMensal(transacoes, hoje, mesesJanela) {
    const mesAtualIdx      = _mesIdx(hoje);
    const ultimoCompletoIdx = mesAtualIdx - 1;              // mês passado
    const primeiroJanelaIdx = mesAtualIdx - mesesJanela;    // N meses completos atrás

    let liquido = 0;
    let primeiroTxIdx = null;

    for (const t of (transacoes || [])) {
        if (t.categoria !== 'entrada' && t.categoria !== 'saida') continue;
        const dt = _txDate(t.data);
        if (!dt) continue;
        const idx = _mesIdx(dt);
        if (idx < primeiroJanelaIdx || idx > ultimoCompletoIdx) continue;

        const v = _valSeguro(t.valor);
        if (t.categoria === 'entrada') liquido += v;
        else                           liquido -= v;

        if (primeiroTxIdx === null || idx < primeiroTxIdx) primeiroTxIdx = idx;
    }

    // Nenhum histórico completo → não inventa ritmo.
    if (primeiroTxIdx === null) return { poupancaMensal: 0, mesesObservados: 0, liquido: 0 };

    const mesesObservados = Math.min(
        mesesJanela,
        Math.max(1, ultimoCompletoIdx - primeiroTxIdx + 1)
    );
    return { poupancaMensal: liquido / mesesObservados, mesesObservados, liquido };
}

/**
 * Juros compostos com aporte mensal (série postecipada).
 *   i > 0 → P·(1+i)^n + PMT·(((1+i)^n − 1)/i)
 *   i = 0 → P + PMT·n   (o termo da série tende a n quando i→0; sem ele seria 0/0)
 * Aporte negativo projeta queda — honestamente, sem piso em zero (dá pra ficar
 * no vermelho). Exportado p/ teste direto da fórmula.
 */
export function projetarValor(principal, aporteMensal, taxaMensal, meses) {
    const P = Number(principal)   || 0;
    const PMT = Number(aporteMensal) || 0;
    const n = Number(meses);
    if (!Number.isFinite(n) || n <= 0) return P;

    const i = Number(taxaMensal);
    // Tolerância (não `=== 0`): i minúsculo faz (1+i)^n−1 arredondar pra 0 e a
    // divisão devolver 0 em vez de ~n. NaN também cai aqui (NaN > x é false).
    if (!(Math.abs(i) > 1e-9)) return P + PMT * n;

    const fator = Math.pow(1 + i, n);
    return P * fator + PMT * ((fator - 1) / i);
}

function _taxaSegura(v) {
    const n = Number(v);
    // > −1: não dá pra perder mais que 100% ao mês.
    return Number.isFinite(n) && n > -1 ? n : 0;
}

/**
 * Projeção de patrimônio no ritmo atual.
 *
 * @param {Object} ctx   { transacoes: [], metas: [] }
 * @param {Date}   hoje  injetável (default new Date())
 * @param {Object} opts  { taxaMensal = 0, anos = [1,5,10], mesesJanela = 6 }
 * @returns {{ patrimonioHoje:number, saldo:number, reservado:number,
 *             poupancaMensal:number, mesesObservados:number, taxaMensal:number,
 *             projecoes: Array<{anos:number, meses:number, valor:number, semRendimento:number}> }}
 */
export function projetarPatrimonio(ctx, hoje = new Date(), opts = {}) {
    const o = opts || {};
    const taxaMensal = _taxaSegura(o.taxaMensal);

    const janelaRaw = Number(o.mesesJanela);
    const mesesJanela = Number.isFinite(janelaRaw) && janelaRaw >= 1
        ? Math.floor(janelaRaw)
        : 6;

    const anos = (Array.isArray(o.anos) ? o.anos : [1, 5, 10])
        .map(Number)
        .filter(a => Number.isFinite(a) && a > 0);

    const { patrimonioHoje, saldo, reservado } = calcularPatrimonioHoje(ctx);
    const { poupancaMensal, mesesObservados } =
        _poupancaMensal(ctx?.transacoes, hoje, mesesJanela);

    const projecoes = anos.map(a => {
        const meses = Math.round(a * 12);
        return {
            anos: a,
            meses,
            valor:         projetarValor(patrimonioHoje, poupancaMensal, taxaMensal, meses),
            // Baseline sem rendimento — o "quanto o juro te deu" é a diferença.
            semRendimento: projetarValor(patrimonioHoje, poupancaMensal, 0, meses),
        };
    });

    return {
        patrimonioHoje, saldo, reservado,
        poupancaMensal, mesesObservados,
        taxaMensal,
        projecoes,
    };
}
