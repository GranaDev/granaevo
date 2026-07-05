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

const APLICAVEIS_V1 = ['entrada', 'saida', 'reserva'];

// O NOME da meta mora em `descricao` no app (não em `nome`) — priorizar isso.
function metaNome(m) {
    return String(m?.descricao ?? m?.nome ?? m?.name ?? m?.titulo ?? '').trim();
}
function _norm(s) {
    return String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
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

function uuid(prefix) {
    return (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

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
    const hoje = new Date();
    const diaHoje = hoje.getDate();
    const diaFechamento = cartao.fechamentoDia ?? cartao.vencimentoDia;
    const diaFatura = cartao.vencimentoDia;

    let proxMes = hoje.getMonth() + 1;
    let proxAno = hoje.getFullYear();
    if (diaHoje >= diaFechamento) { proxMes += 1; if (proxMes > 12) { proxMes = 1; proxAno += 1; } }
    const dataFaturaISO = `${proxAno}-${String(proxMes).padStart(2, '0')}-${String(diaFatura).padStart(2, '0')}`;

    const valorParcela = Number((valor / p).toFixed(2));
    const compra = {
        id: uuid('compra'),
        tipo: tipo || 'Cartão',
        descricao: descricao || 'Compra no crédito',
        valorTotal: valor,
        valorParcela,
        totalParcelas: p,
        parcelaAtual: 1,
        dataCompra: dh.data,
    };

    const fatura = profile.contasFixas.find((c) =>
        c.cartaoId === cartao.id && c.vencimento === dataFaturaISO && c.tipoContaFixa === 'fatura_cartao');

    let faturaId, wasNew = false;
    if (fatura) {
        if (!Array.isArray(fatura.compras)) fatura.compras = [];
        fatura.compras.push(compra);
        fatura.valor = somaParcelas(fatura.compras);
        faturaId = fatura.id;
    } else {
        const nova = {
            id: uuid('fatura'),
            descricao: `Fatura ${cartao.nomeBanco}`,
            valor: valorParcela,
            vencimento: dataFaturaISO,
            pago: false,
            cartaoId: cartao.id,
            tipoContaFixa: 'fatura_cartao',
            compras: [compra],
        };
        profile.contasFixas.push(nova);
        faturaId = nova.id;
        wasNew = true;
    }
    cartao.usado = (Number(cartao.usado) || 0) + valor;

    return {
        ok: true, compra, valorParcela, parcelas: p,
        cardNome: cartao.nomeBanco || cartao.nome || 'Cartão',
        snapshot: { compraId: compra.id, faturaId, wasNew, cardId: String(cartao.id), valor },
    };
}

/** Desfaz uma compra no crédito (à prova de reload — usa ids). */
export function undoCredito(profile, snap) {
    if (!profile || !snap) return false;
    const contas = Array.isArray(profile.contasFixas) ? profile.contasFixas : [];
    const fatIdx = contas.findIndex((c) => String(c.id) === String(snap.faturaId));
    if (fatIdx === -1) return false;

    if (snap.wasNew) {
        contas.splice(fatIdx, 1); // fatura criada por esta compra → some inteira
    } else {
        const fat = contas[fatIdx];
        if (Array.isArray(fat.compras)) {
            const i = fat.compras.findIndex((c) => c.id === snap.compraId);
            if (i !== -1) fat.compras.splice(i, 1);
            fat.valor = somaParcelas(fat.compras);
        }
    }
    const cartao = (Array.isArray(profile.cartoesCredito) ? profile.cartoesCredito : [])
        .find((c) => String(c.id) === String(snap.cardId));
    if (cartao) cartao.usado = Math.max(0, (Number(cartao.usado) || 0) - Number(snap.valor || 0));
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
