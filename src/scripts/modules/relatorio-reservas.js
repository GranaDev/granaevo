// relatorio-reservas.js — as reservas da CONTA, com a compartilhada contada UMA vez
// ---------------------------------------------------------------------------
// POR QUE ESTE MÓDULO EXISTE
//
// Uma reserva compartilhada tem uma cópia no slot de CADA membro. Isso está
// certo e é o que faz a feature funcionar (ver modules/reserva-familia.js), mas
// cria uma armadilha para qualquer número CONSOLIDADO da conta: somar
// `meta.saved` de todos os perfis conta o mesmo cofre duas, três, quatro vezes.
//
// Um cofre de R$ 200 dividido entre duas pessoas aparece como R$ 200 na tela de
// cada uma — e isso é verdade, é o mesmo cofre. Mas "as reservas da família"
// não são R$ 400. São R$ 200.
//
// Aqui a regra mora num lugar só, pura e testável, e as duas telas que precisam
// dela (Relatórios e Gráficos) consomem a MESMA conta. Duas implementações da
// mesma regra divergem com o tempo — foi assim que o modelo antigo e o novo de
// fatura passaram a coexistir neste app e a fatura exibiu valor errado.
//
// 100% puro: sem DOM, sem rede. O chamador é que pinta.
// ---------------------------------------------------------------------------

import { unirMovimentos, saldoDeMovimentos, porMembro } from './reserva-familia.js?v=9';

const _num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
};

/**
 * Consolida as reservas de todos os perfis da conta.
 *
 * @param {Array} profiles  perfis do blob (cada um com `metas`)
 * @returns {{
 *   total: number,
 *   totalCompartilhado: number,
 *   reservas: Array<{
 *     id: string, descricao: string, saved: number, objetivo: number,
 *     compartilhada: boolean, perfis: string[],
 *     membros: Array<{nome: string, liquido: number, sistema: boolean}>,
 *   }>
 * }}
 */
export function consolidarReservas(profiles) {
    const lista = Array.isArray(profiles) ? profiles : [];

    // ── Compartilhadas: agrupa as cópias por id da reserva ──────────────────
    // A chave é o id, não o par (perfil, id): é o MESMO cofre visto de vários
    // slots. É este agrupamento que impede a contagem em dobro.
    const compartilhadas = new Map();
    const privadas = [];

    for (const p of lista) {
        const nomePerfil = String(p?.nome ?? p?.name ?? '').trim() || 'Perfil';
        for (const m of (Array.isArray(p?.metas) ? p.metas : [])) {
            if (!m || typeof m !== 'object') continue;
            // Recibo: reserva de que este perfil já saiu. O dinheiro dele já
            // voltou por uma transação de retirada — a cópia só existe para a
            // trilha fechar a conta de quem ficou. Não é reserva de ninguém.
            if (m.saiu === true) continue;

            if (m.compartilhada === true && m.id != null) {
                const rid = String(m.id);
                const e = compartilhadas.get(rid) ?? { copias: [], perfis: [] };
                e.copias.push(m);
                if (!e.perfis.includes(nomePerfil)) e.perfis.push(nomePerfil);
                compartilhadas.set(rid, e);
                continue;
            }
            privadas.push({
                id:            m.id != null ? String(m.id) : '',
                descricao:     String(m.descricao ?? '').trim() || 'Reserva',
                saved:         Math.round(_num(m.saved) * 100) / 100,
                objetivo:      Math.round(_num(m.objetivo) * 100) / 100,
                compartilhada: false,
                perfis:        [nomePerfil],
                membros:       [],
            });
        }
    }

    const reservas = [];
    let totalCompartilhado = 0;

    for (const [rid, { copias, perfis }] of compartilhadas) {
        // O saldo sai da UNIÃO das trilhas, não da soma dos `saved`. É a mesma
        // fonte que a tela da reserva usa, então os dois números batem sempre.
        // Sem trilha (reserva antiga ainda não migrada), cai no MAIOR `saved`
        // entre as cópias — nunca na soma, que inventaria dinheiro.
        const trilha   = unirMovimentos(...copias.map(c => c.movimentos));
        const derivado = saldoDeMovimentos(trilha);
        const saved = derivado !== null
            ? derivado
            : Math.max(0, ...copias.map(c => Math.round(_num(c.saved) * 100) / 100));

        // Objetivo/descrição: da cópia mais recente, que é a regra declarativa
        // já usada pela reconciliação.
        const recente = copias.reduce((a, b) =>
            String(b?.lastUpdate ?? '') > String(a?.lastUpdate ?? '') ? b : a, copias[0]);

        totalCompartilhado += saved;
        reservas.push({
            id:            rid,
            descricao:     String(recente?.descricao ?? '').trim() || 'Reserva',
            saved,
            objetivo:      Math.round(_num(recente?.objetivo) * 100) / 100,
            compartilhada: true,
            perfis,
            membros:       porMembro(trilha).map(m => ({
                nome: m.nome, liquido: m.liquido, sistema: m.sistema === true,
            })),
        });
    }

    reservas.push(...privadas);
    reservas.sort((a, b) => b.saved - a.saved);

    const total = Math.round(reservas.reduce((s, r) => s + r.saved, 0) * 100) / 100;
    return {
        total,
        totalCompartilhado: Math.round(totalCompartilhado * 100) / 100,
        reservas,
    };
}
