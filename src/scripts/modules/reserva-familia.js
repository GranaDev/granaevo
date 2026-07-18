// ----------------------------------------------------------------------------
// reserva-familia.js — reserva compartilhada da conta (item 13, RECONSTRUÍDA 2026-07-18)
//
// O QUE MUDOU (reclamações C1–C4 do usuário):
// A 1ª versão morava em tabelas próprias (shared_reserves/shared_reserve_movements)
// para o convidado poder ESCREVER. Mas isso a desconectava do resto do app:
//   C2 — "não sai do saldo": a reserva não criava transação → o saldo do dashboard
//        nem sabia dela.
//   C3 — "falta informação, quero como as outras caixinhas": UI própria, fora do
//        fluxo de metas.
// A raiz: o convidado NÃO precisa de tabela para escrever. `get-user-data`/`save-
// user-data` resolvem o dono via account_members — dono e convidado compartilham
// UM único blob (uma chave, UM saldo). Logo a reserva compartilhada é só uma
// CAIXINHA NORMAL no blob (`meta` com `compartilhada:true`), que ambos veem e
// editam pelo mesmo save. Guardar/retirar já saem/voltam do saldo (C2 grátis) e
// já renderizam como caixinha (C3 grátis).
//
// O QUE ESTE MÓDULO GUARDA: a ATRIBUIÇÃO — quem colocou e quem tirou. Isso não é
// detalhe, é o recurso: sem trilha, é um número que some e vira briga. Fica em
// `meta.movimentos[]` (append-only pelo cliente). C1 = roster `meta.membros[]`
// escolhido na criação. C4 = ao dissolver, divide o saldo entre os membros
// (default = líquido de cada um) e devolve tudo ao saldo compartilhado.
//
// SALDO É UM POOL ÚNICO: como o blob é do dono, há um só saldo. "Sai do saldo de
// quem coloca" e "devolver a cada usuário" operam sobre esse saldo único — o
// "de quem" é registro de justiça, não uma carteira separada.
//
// 100% puro: sem DOM, sem rede, sem supabase. Testável.
// ----------------------------------------------------------------------------

/**
 * A feature só faz sentido em conta com mais de uma pessoa. Para quem usa
 * sozinho, uma "reserva da família" é ruído — as metas normais já servem.
 */
export function contaCompartilhada(usuarioLogado) {
    if (!usuarioLogado) return false;
    if (usuarioLogado.isGuest === true) return true;
    const p = String(usuarioLogado.plano ?? '').toLowerCase();
    return p === 'casal' || p === 'família' || p === 'familia';
}

/** Identidade do membro logado — para atribuir aporte/retirada. */
export function membroAtual(ctx) {
    return {
        id:   ctx?.usuarioLogado?.userId ?? ctx?.usuarioLogado?.effectiveUserId ?? null,
        nome: (ctx?.perfilAtivo?.nome || ctx?.usuarioLogado?.nome || 'Você').toString().trim().slice(0, 80) || 'Você',
    };
}

/** É uma caixinha compartilhada (reserva da família)? */
export function ehCompartilhada(meta) {
    return !!meta && meta.compartilhada === true;
}

/**
 * Registra um movimento de atribuição em `meta.movimentos` (MUTA a meta).
 * Chamado junto de guardar/retirar quando a caixinha é compartilhada — o
 * dinheiro em si já é movido pelo fluxo normal da meta; aqui só gravamos QUEM.
 * Ignora entrada inválida em silêncio (falha segura: nunca grava lixo).
 */
export function registrarMovimento(meta, { id, nome, tipo, valor, data, hora } = {}) {
    if (!meta) return;
    if (!Array.isArray(meta.movimentos)) meta.movimentos = [];
    const v = Number(valor);
    if (!isFinite(v) || v <= 0) return;
    if (tipo !== 'aporte' && tipo !== 'retirada') return;
    meta.movimentos.push({
        memberId:   id != null ? String(id) : null,
        memberNome: String(nome ?? 'Membro').trim().slice(0, 80) || 'Membro',
        tipo,
        valor:      Math.round(v * 100) / 100,
        data:       data ?? null,
        hora:       hora ?? null,
    });
    // Cap defensivo: trilha não pode crescer sem limite dentro do blob.
    if (meta.movimentos.length > 500) meta.movimentos = meta.movimentos.slice(-500);
}

/**
 * Quem colocou e quem tirou — o coração da feature.
 *
 * Devolve o LÍQUIDO por pessoa (aportes − retiradas), do que mais contribuiu
 * para o que menos. Só aportes esconderia quem coloca 500 e tira 400 todo mês;
 * o líquido conta a história real sem acusar ninguém — só exibe o número.
 */
export function porMembro(movimentos) {
    if (!Array.isArray(movimentos)) return [];
    const mapa = new Map();
    for (const m of movimentos) {
        const v = Number(m?.valor);
        if (!isFinite(v) || v <= 0) continue;
        if (m.tipo !== 'aporte' && m.tipo !== 'retirada') continue;
        // Agrupa por pessoa com o nome mais RECENTE que ela usou (quem trocou de
        // nome não deve virar duas pessoas).
        const chave = String(m.memberId ?? `anon:${m.memberNome}`);
        let e = mapa.get(chave);
        if (!e) { e = { id: m.memberId ?? null, nome: m.memberNome || 'Membro', aportes: 0, retiradas: 0, liquido: 0 }; mapa.set(chave, e); }
        e.nome = m.memberNome || e.nome;
        if (m.tipo === 'aporte') { e.aportes += v; e.liquido += v; }
        else                     { e.retiradas += v; e.liquido -= v; }
    }
    for (const e of mapa.values()) {
        e.aportes   = Math.round(e.aportes * 100) / 100;
        e.retiradas = Math.round(e.retiradas * 100) / 100;
        e.liquido   = Math.round(e.liquido * 100) / 100;
    }
    return [...mapa.values()].sort((a, b) => b.liquido - a.liquido);
}

/** Progresso rumo ao objetivo (0–100), ou null quando não há objetivo. */
export function progressoDe(saldo, objetivo) {
    const o = Number(objetivo);
    if (!isFinite(o) || o <= 0) return null;
    return Math.max(0, Math.min(100, (Number(saldo) / o) * 100));
}

/**
 * C4 — divisão sugerida ao dissolver a reserva.
 *
 * Devolve, para cada participante, quanto ele "leva" ao dissolver. Precisa somar
 * EXATAMENTE `saldoTotal` (o dinheiro todo volta ao saldo compartilhado, atribuído).
 *
 * Regra: cada um leva proporcional ao que LÍQUIDO contribuiu; se ninguém tem
 * líquido positivo (reserva inicial sem trilha, ou tudo já retirado), divide
 * igualmente entre o roster. O resto de centavos vai para o maior quinhão, de
 * modo que Σ === saldoTotal sempre (nunca cria nem some dinheiro).
 *
 * @param movimentos  trilha da meta
 * @param saldoTotal  meta.saved (o que há para devolver)
 * @param roster      nomes do meta.membros (fallback quando não há líquido)
 * @returns {Array<{ id, nome, valor }>}
 */
export function divisaoSugerida(movimentos, saldoTotal, roster = []) {
    const total = Math.round(Number(saldoTotal) * 100) / 100;
    if (!isFinite(total) || total <= 0) return [];

    const membros = porMembro(movimentos);
    const positivos = membros.filter(m => m.liquido > 0);
    const somaPos = positivos.reduce((s, m) => s + m.liquido, 0);

    let base;
    if (somaPos > 0) {
        base = positivos.map(m => ({ id: m.id, nome: m.nome, valor: Math.floor((m.liquido / somaPos) * total * 100) / 100 }));
    } else {
        // Sem líquido positivo → divide igual entre o roster (ou "Você" se vazio).
        const nomes = Array.isArray(roster) && roster.length ? roster : ['Você'];
        const cada = Math.floor((total / nomes.length) * 100) / 100;
        base = nomes.map(n => ({ id: null, nome: String(n).slice(0, 80) || 'Membro', valor: cada }));
    }

    // Ajuste de centavos: joga o resto no maior quinhão para Σ === total.
    const somaBase = base.reduce((s, x) => s + x.valor, 0);
    const resto = Math.round((total - somaBase) * 100) / 100;
    if (resto !== 0 && base.length) {
        let idxMaior = 0;
        for (let i = 1; i < base.length; i++) if (base[i].valor > base[idxMaior].valor) idxMaior = i;
        base[idxMaior].valor = Math.round((base[idxMaior].valor + resto) * 100) / 100;
    }
    return base;
}
