// ----------------------------------------------------------------------------
// fatura-parcelas.js — motor do parcelamento de cartão (reestruturação, 2026-07-17)
//
// O PROBLEMA QUE ISTO CONSERTA (relatado pelo usuário):
// O modelo antigo guardava uma compra 5×150 como UM objeto numa ÚNICA fatura,
// com um contador `parcelaAtual`. As outras 4 parcelas não existiam — eram só um
// número. "Pagar" fazia `parcelaAtual++` e mantinha a compra na mesma fatura, então
// o valor não caía e "puxava a próxima parcela". Excluir a transação não revertia
// o contador. Tudo morava num mês só.
//
// O MODELO NOVO (como um banco de verdade):
// Uma compra 5×150 vira 5 PARCELAS, uma em cada fatura mensal. Cada parcela é
// paga independentemente; pagar a de janeiro baixa a fatura de janeiro e não
// mexe na de fevereiro. As 5 compartilham um `compraOrigemId` para que excluir a
// compra encontre e reverta todas.
//
// FORMATO da parcela (dentro de fatura.compras[]):
//   { id, compraOrigemId, tipo, descricao, valorTotal, valorParcela,
//     numeroParcela, totalParcelas, dataCompra, pago, pagoEm }
//   fatura.valor = Σ das parcelas NÃO pagas (por isso pagar diminui de verdade).
//
// COMPATIBILIDADE: o modelo antigo tinha `parcelaAtual` e NÃO tinha
// `numeroParcela`. `ehParcelaAntiga()` distingue os dois, e `migrarCompra()`
// converte — usado pela migração idempotente no load (mesmo padrão do
// _repararFaturasAdiantadas). Os dados são cifrados no cliente, então a migração
// TEM que ser client-side.
//
// 100% puro: sem DOM, sem rede, `hoje` injetável.
// ----------------------------------------------------------------------------

import { diaFechamentoDe } from './ciclo-fatura.js?v=1';

const _ISO = /^\d{4}-\d{2}-\d{2}$/;

/** 'DD/MM/YYYY' ou 'YYYY-MM-DD' → 'YYYY-MM-DD' (ou null). */
export function paraISO(data) {
    if (typeof data !== 'string') return null;
    if (_ISO.test(data.slice(0, 10))) return data.slice(0, 10);
    const m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(data);
    return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

/** Soma `n` meses a um 'YYYY-MM-DD', fixando o dia (clamp no fim do mês). */
export function somaMesesISO(iso, n) {
    if (!_ISO.test(iso)) return null;
    let [y, m, d] = iso.split('-').map(Number);
    const total = (y * 12 + (m - 1)) + n;
    y = Math.floor(total / 12);
    m = (total % 12) + 1;
    // Dia pode não existir no mês destino (ex.: 31 em fevereiro) → clamp.
    const ultimoDia = new Date(y, m, 0).getDate();
    d = Math.min(d, ultimoDia);
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Vencimento da fatura da 1ª parcela de uma compra — a mesma regra de ciclo que
 * o app já usava: se comprou no dia do fechamento ou depois, cai no próximo
 * ciclo; e se o cartão vence ANTES de fechar (ex.: fecha 28, vence 6), o
 * vencimento é no mês seguinte ao fechamento.
 *
 * @returns {string|null} 'YYYY-MM-DD'
 */
export function baseVencimentoISO(cartao, dataCompraISO) {
    const diaFech = diaFechamentoDe(cartao);            // 1–28 ou null
    const diaVenc = Number(cartao?.vencimentoDia);
    if (!diaFech || !Number.isInteger(diaVenc) || diaVenc < 1 || diaVenc > 31) return null;
    if (!_ISO.test(dataCompraISO)) return null;

    let [ano, mes, dia] = dataCompraISO.split('-').map(Number);

    // Compra no dia do fechamento (ou depois) → próximo ciclo.
    if (dia >= diaFech) { mes++; if (mes > 12) { mes = 1; ano++; } }

    // Vencimento antes do fechamento → cai no mês seguinte ao do fechamento.
    if (diaVenc < diaFech) { mes++; if (mes > 12) { mes = 1; ano++; } }

    const ultimoDia = new Date(ano, mes, 0).getDate();
    const d = Math.min(diaVenc, ultimoDia);
    return `${ano}-${String(mes).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

let _seq = 0;
function _novoId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return `p_${Date.now()}_${(_seq++).toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Gera as N parcelas de uma compra parcelada, uma por mês.
 *
 * @returns {Array<{ vencimentoISO: string, parcela: object }>} — o chamador anexa
 *          cada parcela à fatura do seu vencimento (criando a fatura se faltar).
 *          Vazio se os dados forem inválidos (falha segura: não cria dado quebrado).
 */
export function gerarParcelas({ cartao, tipo, descricao, valorTotal, parcelas, dataCompraISO, compraOrigemId }) {
    const n = Number(parcelas);
    const total = Number(valorTotal);
    if (!Number.isInteger(n) || n < 1 || n > 60) return [];
    if (!isFinite(total) || total <= 0) return [];
    const baseISO = baseVencimentoISO(cartao, dataCompraISO);
    if (!baseISO) return [];

    const origem = compraOrigemId || _novoId();
    // Arredonda a parcela; a 1ª absorve o resto de centavos para Σ === total.
    const valorParcela = Number((total / n).toFixed(2));
    const resto = Number((total - valorParcela * n).toFixed(2));

    const out = [];
    for (let k = 1; k <= n; k++) {
        out.push({
            vencimentoISO: somaMesesISO(baseISO, k - 1),
            parcela: {
                id:             _novoId(),
                compraOrigemId: origem,
                tipo:           String(tipo ?? '').slice(0, 100),
                descricao:      String(descricao ?? '').slice(0, 200),
                valorTotal:     Number(total.toFixed(2)),
                valorParcela:   k === 1 ? Number((valorParcela + resto).toFixed(2)) : valorParcela,
                numeroParcela:  k,
                totalParcelas:  n,
                dataCompra:     dataCompraISO,
                pago:           false,
                pagoEm:         null,
            },
        });
    }
    return out;
}

/** Σ das parcelas NÃO pagas de uma fatura — é o `fatura.valor` real. */
export function valorAbertoFatura(fatura) {
    if (!fatura || !Array.isArray(fatura.compras)) return 0;
    let s = 0;
    for (const c of fatura.compras) {
        if (c && c.pago === true) continue;
        const v = parseFloat(c?.valorParcela);
        if (isFinite(v) && v > 0) s += v;
    }
    return Number(s.toFixed(2));
}

/** Todas as parcelas de uma compra (por compraOrigemId), com a fatura de cada. */
export function parcelasDaCompra(contasFixas, compraOrigemId) {
    const out = [];
    if (!Array.isArray(contasFixas) || !compraOrigemId) return out;
    for (const f of contasFixas) {
        if (f?.tipoContaFixa !== 'fatura_cartao' || !Array.isArray(f.compras)) continue;
        for (const c of f.compras) {
            if (String(c?.compraOrigemId ?? '') === String(compraOrigemId)) out.push({ fatura: f, parcela: c });
        }
    }
    return out.sort((a, b) => (a.parcela.numeroParcela || 0) - (b.parcela.numeroParcela || 0));
}

/**
 * Anexa parcelas geradas às faturas mensais certas — cria a fatura do mês se
 * ainda não existe. MUTA `contasFixas` (é o array vivo do app).
 *
 * Compartilhado entre a criação de compra e a migração: os dois precisam
 * distribuir parcelas por mês exatamente da mesma forma.
 *
 * @param contasFixas  array vivo (mutado)
 * @param cartao       { id, nomeBanco }
 * @param geradas      saída de gerarParcelas()/migrarCompra()
 */
export function anexarParcelas(contasFixas, cartao, geradas) {
    if (!Array.isArray(contasFixas) || !cartao || !Array.isArray(geradas)) return;
    for (const { vencimentoISO, parcela } of geradas) {
        if (!_ISO.test(vencimentoISO || '') || !parcela) continue;

        let fatura = contasFixas.find(f =>
            f?.tipoContaFixa === 'fatura_cartao' &&
            String(f.cartaoId) === String(cartao.id) &&
            f.vencimento === vencimentoISO);

        if (!fatura) {
            fatura = {
                id: _novoId(),
                descricao:     `Fatura ${cartao.nomeBanco || 'cartão'}`,
                valor:         0,
                vencimento:    vencimentoISO,
                pago:          false,
                cartaoId:      cartao.id,
                tipoContaFixa: 'fatura_cartao',
                compras:       [],
            };
            contasFixas.push(fatura);
        }
        if (!Array.isArray(fatura.compras)) fatura.compras = [];
        // Idempotência: não duplica a mesma parcela (mesmo id).
        if (!fatura.compras.some(c => c.id === parcela.id)) fatura.compras.push(parcela);
        fatura.valor = valorAbertoFatura(fatura);
    }
}

// ─────────────────────────── Migração do modelo antigo ───────────────────────

/** É uma compra do formato ANTIGO (contador parcelaAtual, sem numeroParcela)? */
export function ehParcelaAntiga(compra) {
    return !!compra
        && compra.numeroParcela == null
        && (typeof compra.parcelaAtual === 'number' || typeof compra.totalParcelas === 'number');
}

/**
 * Converte UMA compra antiga (que morava numa fatura só) nas parcelas RESTANTES
 * distribuídas por mês. As já pagas (1 .. parcelaAtual-1) não voltam — elas já
 * saíram como transação. A fatura de origem fica só com a parcela ATUAL; as
 * futuras vão para os meses seguintes.
 *
 * @param compra   objeto antigo
 * @param cartao   para recomputar o vencimento; se ausente, usa a data da fatura
 * @param venctoFaturaISO  vencimento da fatura onde a compra mora hoje
 * @returns {Array<{ vencimentoISO, parcela }>} — a parcela [0] fica na fatura
 *          atual (mesmo vencimento); as demais vão para os meses seguintes.
 *          Vazio se a compra já estava quitada (nada a migrar).
 */
export function migrarCompra(compra, cartao, venctoFaturaISO) {
    if (!ehParcelaAntiga(compra)) return null;   // já é nova ou não é parcela

    const total   = Number(compra.totalParcelas) || 1;
    const atual   = Number(compra.parcelaAtual)  || 1;
    const valorP  = Number(compra.valorParcela)  || 0;
    const origem  = compra.compraOrigemId || _novoId();

    // Quitada (contador passou do total): nada a distribuir.
    if (atual > total || valorP <= 0) return [];

    // Vencimento da parcela ATUAL: preferimos manter o vencimento onde a fatura
    // já está (não recomputar do zero — evita mover uma fatura que o usuário já
    // vê). As futuras são +1, +2 … meses a partir daí.
    const baseISO = _ISO.test(venctoFaturaISO || '')
        ? venctoFaturaISO
        : baseVencimentoISO(cartao, paraISO(compra.dataCompra) || '');
    if (!baseISO) return null;

    const out = [];
    for (let k = atual; k <= total; k++) {
        out.push({
            vencimentoISO: somaMesesISO(baseISO, k - atual),
            parcela: {
                id:             _novoId(),
                compraOrigemId: origem,
                tipo:           String(compra.tipo ?? '').slice(0, 100),
                descricao:      String(compra.descricao ?? '').slice(0, 200),
                valorTotal:     Number(compra.valorTotal) || Number((valorP * total).toFixed(2)),
                valorParcela:   Number(valorP.toFixed(2)),
                numeroParcela:  k,
                totalParcelas:  total,
                dataCompra:     paraISO(compra.dataCompra) || baseISO,
                pago:           false,
                pagoEm:         null,
            },
        });
    }
    return out;
}
