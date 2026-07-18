// tx-builder.js — monta e aplica um lançamento, com desfazer reversível
// ---------------------------------------------------------------------------
// Produz uma transação IDÊNTICA ao schema do app: {categoria,tipo,descricao,
// valor,data,hora,metaId}. NÃO toca em profile.balance (o saldo é sempre
// recalculado a partir de transacoes[] — ver dashboard.js). Reserva atualiza
// meta.saved e meta.monthly exatamente como db-transacoes.js.
//
// V1 aplica entrada/saida/reserva. retirada_reserva/saida_credito/assinatura
// envolvem mecânica de meta/cartão sutil → o engine faz HANDOFF seguro (abre a
// tela certa) em vez de gravar às cegas — decisão de integridade de dados.
// ---------------------------------------------------------------------------

import { agoraDataHora, yearMonthKey, brDateToObj } from './money.js';
// Motor de parcelamento COMPARTILHADO com a tela de Transações — o assistente
// não pode ter a sua própria versão da regra de fatura (foi assim que o modelo
// antigo e o novo passaram a coexistir e a fatura exibiu valor errado).
import { gerarParcelas, anexarParcelas, valorAbertoFatura, paraISO } from '../fatura-parcelas.js?v=1';

const APLICAVEIS_V1 = ['entrada', 'saida', 'reserva'];

// O NOME da meta mora em `descricao` no app (não em `nome`) — priorizar isso.
function metaNome(m) {
    return String(m?.descricao ?? m?.nome ?? m?.name ?? m?.titulo ?? '').trim();
}
function _norm(s) {
    return String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

// Distância de Levenshtein (para fuzzy match tolerante a typos — B21).
function _lev(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        }
        prev = cur;
    }
    return prev[b.length];
}

/** Resolve a meta a partir do hint (nome) contra profile.metas. */
export function resolveMeta(profile, hint) {
    const metas = Array.isArray(profile?.metas) ? profile.metas : [];
    if (metas.length === 0) return { status: 'none' };

    if (hint) {
        const h = _norm(hint);
        // "emergência" → a meta especial (id 'emergency' ou nome com "emergenc").
        if (/emergenc/.test(h)) {
            const emg = metas.find((m) => String(m.id) === 'emergency' || /emergenc/.test(_norm(metaNome(m))));
            if (emg) return { status: 'ok', meta: emg };
        }
        const exato = metas.find((m) => _norm(metaNome(m)) === h);
        if (exato) return { status: 'ok', meta: exato };
        const contendo = metas.filter((m) => {
            const n = _norm(metaNome(m));
            return n && (n.includes(h) || h.includes(n));
        });
        if (contendo.length === 1) return { status: 'ok', meta: contendo[0] };
        if (contendo.length > 1) return { status: 'ambiguous', opcoes: contendo.map(metaNome) };

        // Fuzzy (B21): melhor match por distância de edição, tolerante a typos
        // ("emergencya", "reserva emergenca"). Só aceita se estiver perto o bastante.
        let best = null, bestD = Infinity;
        for (const m of metas) {
            const n = _norm(metaNome(m));
            if (!n) continue;
            const d = _lev(h, n);
            if (d < bestD) { bestD = d; best = m; }
        }
        if (best) {
            const alvo = _norm(metaNome(best));
            const limite = Math.max(2, Math.floor(alvo.length * 0.34));
            if (bestD <= limite) return { status: 'ok', meta: best };
        }
    }

    // Sem hint: se só existe uma meta (fora a de emergência), usa ela.
    const naoEmergencia = metas.filter((m) => String(m.id) !== 'emergency');
    if (naoEmergencia.length === 1) return { status: 'ok', meta: naoEmergencia[0] };
    if (metas.length === 1) return { status: 'ok', meta: metas[0] };

    return { status: 'choose', opcoes: metas.map(metaNome).filter(Boolean) };
}

/** Monta o objeto de transação puro (sem efeitos). */
export function buildTransaction(cmd, metaId = null) {
    const dh = agoraDataHora();
    const data = (typeof cmd.dataOverride === 'string' && /^\d{2}\/\d{2}\/\d{4}$/.test(cmd.dataOverride))
        ? cmd.dataOverride : dh.data;
    return {
        categoria: cmd.categoria,
        tipo:      cmd.categoria === 'reserva' ? 'Reserva' : cmd.tipo,
        descricao: cmd.descricao || cmd.tipo || '',
        valor:     cmd.valor,
        data,
        hora:      dh.hora,
        metaId,
    };
}

/**
 * Aplica o lançamento ao perfil (mutação in-place).
 * O desfazer é feito por `undoLancamento` (match por campos, à prova de reload).
 * @returns {{ok:true, transaction, meta?} | {ok:false, reason, ...}}
 */
export function applyLancamento(profile, cmd) {
    if (!profile || typeof profile !== 'object') return { ok: false, reason: 'no_profile' };
    if (!APLICAVEIS_V1.includes(cmd.categoria)) {
        return { ok: false, reason: 'handoff', categoria: cmd.categoria };
    }
    if (!(cmd.valor > 0)) return { ok: false, reason: 'sem_valor' };

    if (!Array.isArray(profile.transacoes)) profile.transacoes = [];

    // ── Reserva: resolve meta + atualiza saved/monthly ───────────────────────
    if (cmd.categoria === 'reserva') {
        const r = resolveMeta(profile, cmd.metaHint);
        if (r.status !== 'ok') return { ok: false, reason: 'meta', metaStatus: r.status, opcoes: r.opcoes || [] };

        const meta = r.meta;
        const ym = yearMonthKey();
        const t = buildTransaction(cmd, String(meta.id));
        profile.transacoes.push(t);

        meta.saved = Number((Number(meta.saved || 0) + cmd.valor).toFixed(2));
        meta.monthly = meta.monthly || {};
        meta.monthly[ym] = Number((Number(meta.monthly[ym] || 0) + cmd.valor).toFixed(2));

        return { ok: true, transaction: t, meta: metaNome(meta) };
    }

    // ── Entrada / Saída ──────────────────────────────────────────────────────
    const t = buildTransaction(cmd, null);
    profile.transacoes.push(t);
    return { ok: true, transaction: t };
}

/**
 * Retirada de reserva — RÉPLICA FIEL de db-metas.js: valida disponível,
 * cria transação retirada_reserva (com metaId), decrementa meta.saved e
 * monthly, registra historicoRetiradas. O valor volta ao saldo (fórmula).
 * @returns {{ok:true, transaction, meta} | {ok:false, reason, ...}}
 */
export function applyRetirada(profile, cmd) {
    if (!profile || typeof profile !== 'object') return { ok: false, reason: 'no_profile' };
    if (!(cmd.valor > 0)) return { ok: false, reason: 'sem_valor' };

    // Meta pode vir por id (escolhida no picker) ou por hint (nome).
    let meta;
    if (cmd.metaId) {
        meta = (Array.isArray(profile.metas) ? profile.metas : []).find((m) => String(m.id) === String(cmd.metaId));
        if (!meta) return { ok: false, reason: 'meta', metaStatus: 'none', opcoes: [] };
    } else {
        const r = resolveMeta(profile, cmd.metaHint);
        if (r.status !== 'ok') return { ok: false, reason: 'meta', metaStatus: r.status, opcoes: r.opcoes || [] };
        meta = r.meta;
    }
    const disponivel = Number(meta.saved || 0);
    if (disponivel <= 0) return { ok: false, reason: 'reserva_vazia', meta: metaNome(meta) };
    if (cmd.valor > disponivel) return { ok: false, reason: 'excede', meta: metaNome(meta), disponivel };

    if (!Array.isArray(profile.transacoes)) profile.transacoes = [];
    const dh = agoraDataHora();
    const ym = yearMonthKey();
    const t = {
        categoria: 'retirada_reserva',
        tipo: 'Retirada de Reserva',
        descricao: `Retirada: ${metaNome(meta)}`,
        valor: cmd.valor,
        data: dh.data,
        hora: dh.hora,
        metaId: meta.id,
        motivoRetirada: 'Outro',
    };
    profile.transacoes.push(t);

    meta.saved = Number((disponivel - cmd.valor).toFixed(2));
    meta.monthly = meta.monthly || {};
    meta.monthly[ym] = Number((Number(meta.monthly[ym] || 0) - cmd.valor).toFixed(2));
    if (meta.monthly[ym] < 0) meta.monthly[ym] = 0;

    if (!Array.isArray(meta.historicoRetiradas)) meta.historicoRetiradas = [];
    meta.historicoRetiradas.push({
        data: dh.data, valor: cmd.valor, motivo: 'Outro',
        saldoAnterior: disponivel, saldoPosterior: meta.saved,
    });

    return { ok: true, transaction: t, meta: metaNome(meta) };
}

// (uuid() foi removida: os ids de compra/fatura agora nascem em
// fatura-parcelas.js, junto com as parcelas.)

function somaParcelas(compras) {
    return (Array.isArray(compras) ? compras : []).reduce((s, c) => {
        const p = parseFloat(c.valorParcela);
        return s + (Number.isFinite(p) && p > 0 ? p : 0);
    }, 0);
}

/**
 * Compra no crédito — RÉPLICA FIEL de db-transacoes.js (saida_credito):
 * cria a `compra`, atribui ao ciclo de fatura correto (fechamentoDia), cria/atualiza
 * a fatura em contasFixas e incrementa cartao.usado. Reversível via undoCredito.
 * @returns {{ok:true, compra, valorParcela, parcelas, cardNome, snapshot} | {ok:false, reason}}
 */
export function applyCredito(profile, { valor, descricao, tipo, cardId, parcelas }) {
    if (!profile || typeof profile !== 'object') return { ok: false, reason: 'no_profile' };
    if (!(valor > 0)) return { ok: false, reason: 'sem_valor' };
    const p = Number(parcelas);
    if (!Number.isInteger(p) || p < 1 || p > 420) return { ok: false, reason: 'parcelas' };

    const cards = Array.isArray(profile.cartoesCredito) ? profile.cartoesCredito : [];
    const cartao = cards.find((c) => String(c.id) === String(cardId));
    if (!cartao) return { ok: false, reason: 'no_card' };
    if (cartao.congelado) return { ok: false, reason: 'frozen' };
    if (!Array.isArray(profile.contasFixas)) profile.contasFixas = [];

    const dh = agoraDataHora();

    // Usa o MESMO motor da tela de Transações (fatura-parcelas.js): uma compra
    // Nx vira N parcelas, cada uma na fatura do seu mês. Antes daqui o assistente
    // criava o formato ANTIGO (uma compra só, com contador parcelaAtual) — a
    // migração do dashboard consertava no load seguinte, mas até lá a fatura
    // exibia valor errado. Duas fontes de verdade para dinheiro é como o bug do
    // parcelamento nasceu; agora é uma só.
    const dataCompraISO = paraISO(dh.data) || new Date().toISOString().slice(0, 10);
    const geradas = gerarParcelas({
        cartao,
        tipo: tipo || 'Cartão',
        descricao: descricao || 'Compra no crédito',
        valorTotal: valor,
        parcelas: p,
        dataCompraISO,
    });
    if (geradas.length === 0) return { ok: false, reason: 'ciclo_invalido' };

    const idsFaturasAntes = new Set(profile.contasFixas.map((c) => String(c.id)));
    anexarParcelas(profile.contasFixas, cartao, geradas);
    cartao.usado = (Number(cartao.usado) || 0) + valor;

    const compraOrigemId = geradas[0].parcela.compraOrigemId;
    const valorParcela = geradas[0].parcela.valorParcela;
    // Faturas que NASCERAM desta compra — o undo remove essas inteiras.
    const faturasNovas = profile.contasFixas
        .filter((c) => !idsFaturasAntes.has(String(c.id)))
        .map((c) => String(c.id));

    return {
        ok: true, compra: geradas[0].parcela, valorParcela, parcelas: p,
        cardNome: cartao.nomeBanco || cartao.nome || 'Cartão',
        snapshot: { compraOrigemId, faturasNovas, cardId: String(cartao.id), valor },
    };
}

/**
 * Desfaz uma compra no crédito (à prova de reload — usa ids).
 * No modelo novo a compra está espalhada por N faturas mensais, então o undo
 * varre por `compraOrigemId` em vez de mexer numa fatura só.
 */
export function undoCredito(profile, snap) {
    if (!profile || !snap) return false;
    const contas = Array.isArray(profile.contasFixas) ? profile.contasFixas : [];

    // Compat: snapshots gravados ANTES desta mudança (compraId + faturaId).
    if (!snap.compraOrigemId) {
        const fatIdx = contas.findIndex((c) => String(c.id) === String(snap.faturaId));
        if (fatIdx === -1) return false;
        if (snap.wasNew) {
            contas.splice(fatIdx, 1);
        } else {
            const fat = contas[fatIdx];
            if (Array.isArray(fat.compras)) {
                const i = fat.compras.findIndex((c) => c.id === snap.compraId);
                if (i !== -1) fat.compras.splice(i, 1);
                fat.valor = somaParcelas(fat.compras);
            }
        }
    } else {
        const alvo = String(snap.compraOrigemId);
        let achou = false;
        for (const c of contas) {
            if (c?.tipoContaFixa !== 'fatura_cartao' || !Array.isArray(c.compras)) continue;
            const antes = c.compras.length;
            c.compras = c.compras.filter((cp) => String(cp?.compraOrigemId ?? '') !== alvo);
            if (c.compras.length !== antes) { achou = true; c.valor = valorAbertoFatura(c); }
        }
        if (!achou) return false;
        // Remove as faturas que só existiam por causa desta compra (e ficaram vazias).
        const novas = new Set((snap.faturasNovas || []).map(String));
        for (let i = contas.length - 1; i >= 0; i--) {
            const c = contas[i];
            if (novas.has(String(c?.id)) && Array.isArray(c.compras) && c.compras.length === 0) {
                contas.splice(i, 1);
            }
        }
    }

    const cartao = (Array.isArray(profile.cartoesCredito) ? profile.cartoesCredito : [])
        .find((c) => String(c.id) === String(snap.cardId));
    if (cartao) cartao.usado = Math.max(0, (Number(cartao.usado) || 0) - Number(snap.valor || 0));
    return true;
}

// ── Pagar conta fixa ("paguei a conta de luz") ────────────────────────────────
// RÉPLICA FIEL do caminho "CONTA RECORRENTE (sem parcelas)" de pagarContaFixa
// do dashboard.js: cria a transação de saída (tipo 'Conta Fixa', contaFixaId),
// avança o vencimento 1 mês, marca pago + dataPagamento.
// Faturas de cartão e contas parceladas mexem em compras/cartao.usado →
// HANDOFF pra tela de Contas (integridade > conveniência).

function _avancarMesISO(vencimentoISO) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(vencimentoISO))) {
        const f = new Date(); f.setMonth(f.getMonth() + 1);
        return f.toISOString().slice(0, 10);
    }
    let [y, m, d] = vencimentoISO.split('-').map(Number);
    m++;
    if (m > 12) { m = 1; y++; }
    return [y, String(m).padStart(2, '0'), String(d).padStart(2, '0')].join('-');
}

/**
 * Resolve a conta fixa em aberto a partir do hint (nome). Só contas NÃO pagas.
 * @returns {{status:'ok',conta}|{status:'ambiguous'|'choose',opcoes}|{status:'none'}|{status:'handoff',conta}}
 */
export function resolveContaFixa(profile, hint) {
    const abertas = (Array.isArray(profile?.contasFixas) ? profile.contasFixas : [])
        .filter((c) => c && c.pago !== true);
    if (!abertas.length) return { status: 'none' };

    const simples = (c) => c.tipoContaFixa !== 'fatura_cartao' && !(c.cartaoId && c.totalParcelas);
    let candidatas = abertas;
    if (hint) {
        const h = _norm(hint);
        const porNome = abertas.filter((c) => {
            const n = _norm(c.descricao);
            return n && (n.includes(h) || h.includes(n));
        });
        if (porNome.length === 1) {
            return simples(porNome[0]) ? { status: 'ok', conta: porNome[0] } : { status: 'handoff', conta: porNome[0] };
        }
        if (porNome.length > 1) return { status: 'ambiguous', opcoes: porNome.map((c) => String(c.descricao || 'Conta')) };
        // Fuzzy tolerante a typo (mesmo critério do resolveMeta)
        let best = null, bestD = Infinity;
        for (const c of abertas) {
            const n = _norm(c.descricao);
            if (!n) continue;
            const d = _lev(h, n);
            if (d < bestD) { bestD = d; best = c; }
        }
        if (best) {
            const alvo = _norm(best.descricao);
            if (bestD <= Math.max(2, Math.floor(alvo.length * 0.34))) {
                return simples(best) ? { status: 'ok', conta: best } : { status: 'handoff', conta: best };
            }
        }
        return { status: 'none' };
    }
    const soSimples = candidatas.filter(simples);
    if (soSimples.length === 1) return { status: 'ok', conta: soSimples[0] };
    if (candidatas.length === 0) return { status: 'none' };
    return { status: 'choose', opcoes: candidatas.map((c) => String(c.descricao || 'Conta')) };
}

/**
 * Aplica o pagamento de uma conta fixa SIMPLES (recorrente, sem cartão).
 * @returns {{ok:true, transaction, snapshot, conta} | {ok:false, reason}}
 */
export function applyPagamentoConta(profile, conta, valorOpcional) {
    if (!profile || !conta) return { ok: false, reason: 'no_profile' };
    if (conta.pago === true) return { ok: false, reason: 'ja_paga' };
    if (conta.tipoContaFixa === 'fatura_cartao' || (conta.cartaoId && conta.totalParcelas)) {
        return { ok: false, reason: 'handoff' };
    }
    const valor = Number(valorOpcional) > 0 ? Number(valorOpcional) : Number(conta.valor);
    if (!Number.isFinite(valor) || valor <= 0 || valor > 9_999_999) return { ok: false, reason: 'sem_valor' };

    if (!Array.isArray(profile.transacoes)) profile.transacoes = [];
    const dh = agoraDataHora();
    const desc = String(conta.descricao || 'Conta').slice(0, 100);
    const t = {
        categoria: 'saida',
        tipo: 'Conta Fixa',
        descricao: `${desc} (pagamento mensal)`,
        valor: Number(valor.toFixed(2)),
        data: dh.data,
        hora: dh.hora,
        contaFixaId: conta.id,
    };
    profile.transacoes.push(t);

    const snapshot = { contaId: conta.id, vencimento: conta.vencimento, pago: conta.pago === true, dataPagamento: conta.dataPagamento ?? null };
    conta.vencimento = _avancarMesISO(conta.vencimento);
    conta.pago = true;
    conta.dataPagamento = new Date().toISOString().slice(0, 10);

    return { ok: true, transaction: t, snapshot, conta: desc };
}

/** Desfaz o pagamento: remove a transação e restaura vencimento/pago (por id). */
export function undoPagamentoConta(profile, txSnap, snapshot) {
    if (!profile || !snapshot) return false;
    // Remove a transação do pagamento (match por campos, à prova de reload).
    let removed = false;
    if (Array.isArray(profile.transacoes)) {
        for (let i = profile.transacoes.length - 1; i >= 0; i--) {
            const a = profile.transacoes[i];
            if (a && a.categoria === 'saida' && a.tipo === 'Conta Fixa' &&
                a.descricao === txSnap.descricao && Number(a.valor) === Number(txSnap.valor) &&
                a.data === txSnap.data && a.hora === txSnap.hora) {
                profile.transacoes.splice(i, 1); removed = true; break;
            }
        }
    }
    const conta = (Array.isArray(profile.contasFixas) ? profile.contasFixas : [])
        .find((c) => String(c?.id) === String(snapshot.contaId));
    if (conta) {
        conta.vencimento = snapshot.vencimento;
        conta.pago = snapshot.pago;
        if (snapshot.dataPagamento === null) delete conta.dataPagamento;
        else conta.dataPagamento = snapshot.dataPagamento;
        return true;
    }
    return removed;
}

// ── Orçamento por categoria ("põe 600 de orçamento pra mercado") ──────────────
// Mesma forma do dashboard: profile.orcamentos = { 'Mercado': { limite: 600 } }.
/**
 * @returns {{ok:true, tipo, limite, anterior:number|null} | {ok:false, reason}}
 */
export function applyOrcamento(profile, tipo, limite) {
    if (!profile || typeof profile !== 'object') return { ok: false, reason: 'no_profile' };
    const v = Number(limite);
    if (!tipo) return { ok: false, reason: 'sem_tipo' };
    if (!Number.isFinite(v) || v <= 0 || v > 10_000_000) return { ok: false, reason: 'sem_valor' };
    if (!profile.orcamentos || typeof profile.orcamentos !== 'object' || Array.isArray(profile.orcamentos)) {
        profile.orcamentos = {};
    }
    const anterior = Number(profile.orcamentos[tipo]?.limite);
    profile.orcamentos[tipo] = { limite: Number(v.toFixed(2)) };
    return { ok: true, tipo, limite: Number(v.toFixed(2)), anterior: Number.isFinite(anterior) ? anterior : null };
}

/** Desfaz a definição de orçamento (restaura o limite anterior ou remove). */
export function undoOrcamento(profile, tipo, anterior) {
    if (!profile?.orcamentos || typeof profile.orcamentos !== 'object') return false;
    if (anterior === null || anterior === undefined) delete profile.orcamentos[tipo];
    else profile.orcamentos[tipo] = { limite: Number(anterior) };
    return true;
}

// Igualdade de transação por campos (à prova de reload — refs mudam no re-parse).
function sameTx(a, b) {
    return a && b &&
        a.categoria === b.categoria && a.tipo === b.tipo && a.descricao === b.descricao &&
        Number(a.valor) === Number(b.valor) && a.data === b.data && a.hora === b.hora &&
        String(a.metaId ?? '') === String(b.metaId ?? '');
}

/**
 * Desfaz um lançamento removendo a ÚLTIMA transação que casa com `tx` (por campos)
 * e revertendo a meta quando for reserva. Funciona mesmo após um reload dos dados.
 * @returns {boolean} true se removeu algo.
 */
export function undoLancamento(profile, tx) {
    if (!profile || !Array.isArray(profile.transacoes) || !tx) return false;
    let idx = -1;
    for (let i = profile.transacoes.length - 1; i >= 0; i--) {
        if (sameTx(profile.transacoes[i], tx)) { idx = i; break; }
    }
    if (idx === -1) return false;
    profile.transacoes.splice(idx, 1);

    // Reverte a meta (reserva subtrai o que foi guardado; retirada devolve)
    if ((tx.categoria === 'reserva' || tx.categoria === 'retirada_reserva') && tx.metaId) {
        const meta = (Array.isArray(profile.metas) ? profile.metas : []).find((m) => String(m.id) === String(tx.metaId));
        if (meta) {
            const valor = Number(tx.valor) || 0;
            const sinal = tx.categoria === 'reserva' ? -1 : +1; // desfazer reserva = tira; desfazer retirada = devolve
            const d = brDateToObj(tx.data) || new Date();
            const ym = yearMonthKey(d);
            meta.saved = Number(Math.max(0, Number(meta.saved || 0) + sinal * valor).toFixed(2));
            meta.monthly = meta.monthly || {};
            const novo = Number((Number(meta.monthly[ym] || 0) + sinal * valor).toFixed(2));
            if (novo > 0) meta.monthly[ym] = novo; else delete meta.monthly[ym];
            // Remove a última entrada de histórico da retirada desfeita.
            if (tx.categoria === 'retirada_reserva' && Array.isArray(meta.historicoRetiradas)) {
                for (let i = meta.historicoRetiradas.length - 1; i >= 0; i--) {
                    if (Number(meta.historicoRetiradas[i]?.valor) === valor && meta.historicoRetiradas[i]?.data === tx.data) {
                        meta.historicoRetiradas.splice(i, 1); break;
                    }
                }
            }
        }
    }
    return true;
}
