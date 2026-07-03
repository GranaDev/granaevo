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

function metaNome(m) {
    return String(m?.nome ?? m?.name ?? m?.titulo ?? m?.descricao ?? '').trim();
}

/** Resolve a meta a partir do hint (nome) contra profile.metas. */
export function resolveMeta(profile, hint) {
    const metas = Array.isArray(profile?.metas) ? profile.metas : [];
    if (metas.length === 0) return { status: 'none' };

    if (hint) {
        const h = hint.toLowerCase();
        const exato = metas.find((m) => metaNome(m).toLowerCase() === h);
        if (exato) return { status: 'ok', meta: exato };
        const contendo = metas.filter((m) => {
            const n = metaNome(m).toLowerCase();
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
    return {
        categoria: cmd.categoria,
        tipo:      cmd.categoria === 'reserva' ? 'Reserva' : cmd.tipo,
        descricao: cmd.descricao || cmd.tipo || '',
        valor:     cmd.valor,
        data:      dh.data,
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

    // Reverte a meta (reserva)
    if (tx.categoria === 'reserva' && tx.metaId) {
        const meta = (Array.isArray(profile.metas) ? profile.metas : []).find((m) => String(m.id) === String(tx.metaId));
        if (meta) {
            const valor = Number(tx.valor) || 0;
            const d = brDateToObj(tx.data) || new Date();
            const ym = yearMonthKey(d);
            meta.saved = Number(Math.max(0, Number(meta.saved || 0) - valor).toFixed(2));
            if (meta.monthly && Object.prototype.hasOwnProperty.call(meta.monthly, ym)) {
                const novo = Number((Number(meta.monthly[ym]) - valor).toFixed(2));
                if (novo > 0) meta.monthly[ym] = novo; else delete meta.monthly[ym];
            }
        }
    }
    return true;
}
