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
//
// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║ 🔴 INVARIANTE (2026-08-17) — NINGUÉM ESCREVE NO SLOT DE OUTRO PERFIL.     ║
// ║                                                                           ║
// ║ Até aqui existia `sincronizarReservaEmPerfis`: ao aportar, o cliente      ║
// ║ copiava a SUA versão da reserva para dentro do slot de cada outro membro. ║
// ║ Como o delta save manda `{op:'edit', r: <registro inteiro>}`, o servidor  ║
// ║ SUBSTITUÍA o registro do outro — inclusive a trilha dele.                 ║
// ║                                                                           ║
// ║ Medido (tests/unit/reserva-compartilhada-e2e.test.js, com os módulos      ║
// ║ reais e o aplicador do servidor):                                         ║
// ║   A guarda 100 → slot A {100, [A:100]}                                    ║
// ║   B guarda 100 → B propaga a visão DELE para o slot de A                  ║
// ║                → slot A {100, [B:100]}   ← os 100 de A morreram no banco  ║
// ║ Não é conflito de escrita simultânea: basta o outro não ter recarregado.  ║
// ║                                                                           ║
// ║ AGORA: cada perfil escreve só a PRÓPRIA cópia. A trilha é append-only e   ║
// ║ se UNE por `mid` (`reconciliarCopiaAtiva`), então cada cópia converge      ║
// ║ para o mesmo conjunto sem que ninguém precise sobrescrever ninguém.        ║
// ║ Dois aportes simultâneos SOMAM em vez de um apagar o outro.               ║
// ║                                                                           ║
// ║ ⚠️ Não reintroduza escrita cruzada "só para o outro ver mais rápido".     ║
// ║ Quem faz o outro ver é a campainha (tempo-real) + a reconciliação.        ║
// ╚═══════════════════════════════════════════════════════════════════════════╝
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

/**
 * Identidade de quem lança — atribuído ao PERFIL ativo (não ao login).
 *
 * A reserva da família trata cada PERFIL como uma pessoa: os `membros` são ids de
 * perfil e a dissolução devolve a cada PERFIL a sua parte. Antes o id era o do
 * login (userId), então dois perfis do mesmo login colapsavam numa pessoa só e a
 * dissolução mandava tudo pro perfil que dissolveu. Alinhar ao id de perfil faz a
 * trilha e a divisão baterem com `membros` e com o crédito por perfil.
 */
export function membroAtual(ctx) {
    return {
        id:   ctx?.perfilAtivo?.id != null ? String(ctx.perfilAtivo.id) : null,
        nome: (ctx?.perfilAtivo?.nome || ctx?.usuarioLogado?.nome || 'Você').toString().trim().slice(0, 80) || 'Você',
    };
}

/** É uma caixinha compartilhada (reserva da família)? */
export function ehCompartilhada(meta) {
    return !!meta && meta.compartilhada === true;
}

/**
 * Este perfil participa da reserva?
 *
 * `meta.membros` guarda IDS DE PERFIL desde 2026-07-19. Antes disso guardava
 * NOMES digitados à mão — e essas reservas antigas continuam visíveis para
 * todos, de propósito: transformar dado legado em regra de acesso faria uma
 * reserva existente sumir da tela de alguém sem aviso. Perder de vista o próprio
 * dinheiro é pior do que ver uma reserva a mais.
 *
 * ⚠️ Isto é ORGANIZAÇÃO DE TELA, não sigilo. Dono e convidado compartilham um
 * único blob: quem exporta os dados enxerga tudo, participando ou não.
 */
export function perfilParticipa(meta, perfilId) {
    if (!ehCompartilhada(meta)) return true;              // não é compartilhada → todos veem
    // Saí da reserva: a cópia continua no meu slot como RECIBO (a trilha dela é
    // o que prova, para quem ficou, o que eu pus e o que levei), mas ela não é
    // mais minha — não aparece na lista nem conta no meu total. Ver `sairDaReserva`.
    if (meta.saiu === true) return false;
    const membros = meta.membros;
    if (!Array.isArray(membros) || membros.length === 0) return true;

    const pid = String(perfilId ?? '');
    if (!pid) return true;                                 // sem perfil ativo → não esconde nada

    // Roster legado (nomes) → não filtra. Um id de perfil é sempre uuid ou
    // inteiro; se NENHUM item se parece com um id, é lista de nomes antiga.
    const pareceId = (v) => /^[0-9a-f-]{16,}$/i.test(String(v)) || /^\d+$/.test(String(v));
    if (!membros.some(pareceId)) return true;

    return membros.map(String).includes(pid);
}

// ----------------------------------------------------------------------------
// CONVITE → ACEITE (v2, intra-conta). O criador entra ACEITO em `meta.membros`;
// os demais convidados ficam PENDENTES em `meta.convites` (ids de perfil) até
// aceitarem. Como dono e convidado compartilham UM blob, o convite não precisa
// de tabela nem edge: ele "chega" quando a pessoa entra no perfil convidado, e
// aceitar/recusar é um save normal. Enquanto pendente, o perfil NÃO participa
// (perfilParticipa=false → não contribui), só vê o convite para decidir.
// ----------------------------------------------------------------------------

/** Ids de perfil convidados que ainda não aceitaram. */
export function convitesPendentes(meta) {
    if (!ehCompartilhada(meta) || !Array.isArray(meta.convites)) return [];
    return meta.convites.map(String).filter(Boolean);
}

/** Este perfil tem um convite pendente nesta reserva? */
export function temConvitePendente(meta, perfilId) {
    const pid = String(perfilId ?? '');
    if (!pid) return false;
    return convitesPendentes(meta).includes(pid);
}

/** Quantas reservas têm convite pendente para este perfil (para badge). */
export function contarConvitesPendentes(metas, perfilId) {
    if (!Array.isArray(metas)) return 0;
    return metas.reduce((n, m) => n + (temConvitePendente(m, perfilId) ? 1 : 0), 0);
}

/**
 * Aceitar: move o perfil de `convites` → `membros`. MUTA a meta. true se mudou.
 * Idempotente: aceitar de novo (já membro) não duplica.
 */
export function aceitarConvite(meta, perfilId) {
    const pid = String(perfilId ?? '');
    if (!pid || !ehCompartilhada(meta) || !Array.isArray(meta.convites)) return false;
    const idx = meta.convites.map(String).indexOf(pid);
    if (idx === -1) return false;
    meta.convites.splice(idx, 1);
    if (!Array.isArray(meta.membros)) meta.membros = [];
    if (!meta.membros.map(String).includes(pid)) meta.membros.push(pid);
    return true;
}

/** Recusar: remove o perfil de `convites` (não vira membro). MUTA. true se mudou. */
export function recusarConvite(meta, perfilId) {
    const pid = String(perfilId ?? '');
    if (!pid || !Array.isArray(meta?.convites)) return false;
    const idx = meta.convites.map(String).indexOf(pid);
    if (idx === -1) return false;
    meta.convites.splice(idx, 1);
    return true;
}

/**
 * Monta `{ membros, convites }` a partir do roster escolhido na criação/edição.
 * O criador entra ACEITO; os demais viram PENDENTES — exceto quem JÁ era membro
 * (edição não re-convida quem já aceitou). Puro.
 *
 * @param rosterIds  ids de perfil marcados no formulário (inclui o criador)
 * @param criadorId  id do perfil ativo que está criando/editando
 * @param metaAtual  a meta sendo editada (para preservar membros já aceitos)
 */
export function montarRosterConvite(rosterIds, criadorId, metaAtual = {}) {
    const criador = String(criadorId ?? '');
    // Filtra nullish ANTES de String() — senão null/undefined viram 'null'/'undefined'.
    const roster  = [...new Set(
        (Array.isArray(rosterIds) ? rosterIds : [])
            .filter(v => v != null && v !== '')
            .map(String),
    )];
    const jaMembros  = new Set((Array.isArray(metaAtual?.membros)  ? metaAtual.membros  : []).map(String));
    const jaConvites = new Set((Array.isArray(metaAtual?.convites) ? metaAtual.convites : []).map(String));
    const membros = [];
    const convites = [];
    if (criador) membros.push(criador);
    for (const id of roster) {
        if (id === criador) continue;
        if (jaMembros.has(id)) membros.push(id);   // já aceitou antes → continua membro
        else convites.push(id);                     // novo no roster → convite pendente
    }
    // ⚠️ QUEM JÁ ACEITOU NÃO SAI DAQUI POR EDIÇÃO DE OUTRA PESSOA.
    // Desmarcar alguém no formulário tirava o membro do roster — e a cópia dele
    // então sumia da tela dele, com o dinheiro que ele tinha posto lá dentro,
    // sem transação de volta e sem aviso. Sair da reserva é ato individual
    // (`sairDaReserva`), que devolve o valor a quem sai. Aqui o formulário só
    // CONVIDA.
    for (const id of jaMembros) {
        if (id !== criador && !membros.includes(id)) membros.push(id);
    }
    // Preserva convites pendentes que NÃO estavam no roster: o form de EDIÇÃO
    // lista só membros (db-metas.js:575), então não devemos apagar convites que
    // ele nem mostra. Sem isto, qualquer edição zerava os convites em voo.
    for (const id of jaConvites) {
        if (id !== criador && !membros.includes(id) && !convites.includes(id)) convites.push(id);
    }
    return { membros: membros.slice(0, 12), convites: convites.slice(0, 12) };
}

// ----------------------------------------------------------------------------
// COMO A RESERVA CHEGA AO OUTRO PERFIL (sem escrita cruzada).
//
// Cada perfil tem seu PRÓPRIO array de `metas` no blob. A cópia no slot de um
// membro nasce quando ELE aceita o convite (`aceitarConvite` grava no próprio
// slot) e morre quando ELE sai (`sairDaReserva`). Ninguém cria nem apaga a cópia
// de outra pessoa — ver a INVARIANTE no topo do arquivo.
//
// Depois disso, as cópias conversam por CONVERGÊNCIA, não por cópia:
//   • a trilha (`movimentos`) se UNE por `mid` — append-only, nunca sobrescrita;
//   • o saldo é DERIVADO dessa união, então ele é a soma do que todos puseram;
//   • os campos declarativos (objetivo, prazo, roster) seguem o `lastUpdate`
//     mais novo, porque decisão não é acumulador.
// Tudo isso vive em `reconciliarCopiaAtiva`, que roda ao carregar e ao renderizar.
// ----------------------------------------------------------------------------

// Campos COMPARTILHADOS de uma reserva (iguais em toda cópia). As transações
// (dinheiro) ficam à parte, com metaId, e não entram aqui.
const CAMPOS_SINC = [
    'saved', 'monthly', 'historicoRetiradas', 'objetivo', 'descricao', 'prazo',
    'tipoRendimento', 'taxaJuros', 'cdiPct', 'rendimentoPeriodo', 'aporteRecorrente',
    'valorAporte', 'lastRendimento', 'membros', 'movimentos', 'convites',
    'tipoReserva', 'origemExistente', 'lastUpdate',
];

// Campos DECLARATIVOS: o último que falou vence, e isso está certo — objetivo,
// prazo e roster são decisões, não acumuladores.
//
// `saved` e `movimentos` estão FORA desta lista, e é a diferença que faz a
// feature funcionar. Eles são ACUMULADORES: a trilha se une e o saldo sai dela.
// Copiar um acumulador da "cópia vencedora" é o que fazia um aporte apagar o
// outro. `monthly` e `historicoRetiradas` seguem juntos por serem históricos
// por cópia — quem manda no dinheiro é `movimentos`.
const CAMPOS_DECLARATIVOS = CAMPOS_SINC.filter(
    k => k !== 'saved' && k !== 'movimentos' && k !== 'monthly' && k !== 'historicoRetiradas');

// ── SAIR DA RESERVA (substitui a dissolução em bloco) ───────────────────────
// A dissolução dividia o bolo entre TODOS de uma vez e dependia de cada perfil
// abrir o app para reclamar a parte dele. Errado por dois motivos: quem clica
// decidia quanto o OUTRO leva, e a reserva morria para os dois mesmo quando só
// uma pessoa queria sair. Agora a operação é individual e local: eu retiro o que
// é meu, saio do roster, e a reserva continua viva para quem ficou — reduzida
// exatamente pelo que levei. Quando o ÚLTIMO membro sai, ela acaba.

/**
 * Quanto ESTE perfil tem depositado na reserva (aportes − retiradas dele).
 * É o valor que a tela oferece de volta ao sair. Nunca negativo, nunca maior
 * que o saldo atual da reserva (se outro já retirou, não há o que devolver).
 */
export function depositoLiquidoDe(meta, perfilId) {
    const pid = String(perfilId ?? '');
    if (!meta || !pid) return 0;
    const saldo = Math.round(Number(meta.saved || 0) * 100) / 100;
    if (!isFinite(saldo) || saldo <= 0) return 0;
    const eu = porMembro(meta.movimentos).find(m => String(m.id ?? '') === pid);
    const liquido = eu ? Number(eu.liquido) : 0;
    if (!isFinite(liquido) || liquido <= 0) return 0;
    return Math.min(Math.round(liquido * 100) / 100, saldo);
}

/** Este perfil é o último membro? (então sair encerra a reserva) */
export function ehUltimoMembro(meta, perfilId) {
    const pid = String(perfilId ?? '');
    if (!ehCompartilhada(meta) || !pid) return false;
    const membros = Array.isArray(meta.membros) ? meta.membros.map(String) : [];
    return membros.length <= 1 && (membros.length === 0 || membros[0] === pid);
}

/**
 * Tira ESTE perfil da reserva levando `valor` de volta. MUTA a meta:
 * desconta do saldo, registra a retirada na trilha, sai do roster e marca a
 * cópia como RECIBO (`saiu`).
 *
 * ⚠️ POR QUE A CÓPIA NÃO É APAGADA. A trilha desta cópia é a única prova, para
 * quem ficou, de que eu pus R$ X e levei R$ Y. Apagá-la some com as duas pontas:
 * quem já tinha absorvido meus aportes ficaria com dinheiro a mais na conta, e
 * quem não tinha, a menos. Como recibo, ela é lida pela união (a soma bate) e
 * ignorada por tudo o que é meu (`perfilParticipa` devolve false).
 *
 * O `valor` é escolhido na tela (default = o que ele depositou; "Outro valor"
 * cobre rendimento). Teto = saldo da reserva: ninguém pode sacar dinheiro que a
 * reserva não tem. Último membro leva TUDO — senão sobraria dinheiro preso numa
 * reserva sem dono.
 *
 * @returns {{ok:boolean, valor:number, ultimo:boolean, erro?:string}}
 */
export function sairDaReserva(meta, perfilId, valor, nome) {
    const pid = String(perfilId ?? '');
    if (!ehCompartilhada(meta) || !pid) return { ok: false, valor: 0, ultimo: false, erro: 'reserva inválida' };

    const saldo = Math.round(Number(meta.saved || 0) * 100) / 100;
    const ultimo = ehUltimoMembro(meta, pid);
    let v = Math.round(Number(valor) * 100) / 100;
    if (!isFinite(v) || v < 0) return { ok: false, valor: 0, ultimo, erro: 'valor inválido' };
    if (v > saldo) return { ok: false, valor: 0, ultimo, erro: 'valor maior que o saldo da reserva' };
    if (ultimo) v = Math.max(saldo, 0);   // fecha a reserva zerada, sem dinheiro órfão

    meta.saved = Math.round((saldo - v) * 100) / 100;
    if (meta.saved < 0) meta.saved = 0;
    if (v > 0) registrarMovimento(meta, { id: pid, nome, tipo: 'retirada', valor: v });

    if (Array.isArray(meta.membros)) meta.membros = meta.membros.map(String).filter(id => id !== pid);
    if (Array.isArray(meta.convites)) meta.convites = meta.convites.map(String).filter(id => id !== pid);
    meta.saiu = true;                     // vira recibo (ver o bloco acima)
    marcarReservaAtualizada(meta);

    return { ok: true, valor: v, ultimo };
}

/**
 * Quem mais está dentro desta reserva, além de mim? (ids de perfil)
 *
 * É a pergunta que decide se posso DESPARTILHAR: desmarcar "compartilhada"
 * transformaria um cofre de duas pessoas no cofre de UMA — com o dinheiro da
 * outra dentro, sem devolver nada e sem avisar.
 *
 * Devolver automaticamente não é possível por desenho: o dinheiro só volta para
 * alguém por uma transação NO SLOT DELE, e ninguém escreve no slot de ninguém
 * (a INVARIANTE do topo). Fazer isso exigiria uma "parte a reclamar" que o app
 * do outro materializa depois — a dissolução em bloco que este produto já
 * testou e descartou, porque quem clicava decidia quanto o OUTRO levava.
 *
 * Então a saída continua individual: cada um sai pela própria tela e recebe a
 * parte dele na hora (`sairDaReserva`). Enquanto houver outro membro, a tela
 * recusa — e é para isso que esta função existe.
 */
export function outrosMembros(meta, perfilId) {
    if (!ehCompartilhada(meta)) return [];
    const pid = String(perfilId ?? '');
    return (Array.isArray(meta.membros) ? meta.membros : [])
        .filter(id => id != null && id !== '')
        .map(String)
        .filter(id => id !== pid);
}

/** Posso deixar de compartilhar esta reserva? (só quando estou sozinho nela) */
export function podeDespartilhar(meta, perfilId) {
    return outrosMembros(meta, perfilId).length === 0;
}

/** Carimba a reserva como atualizada AGORA (para reconciliar entre cópias). MUTA. */
export function marcarReservaAtualizada(meta) {
    if (meta && typeof meta === 'object') meta.lastUpdate = new Date().toISOString();
    return meta;
}

/**
 * A cópia MAIS RECENTE (maior `lastUpdate`) de uma reserva por id, varrendo todos
 * os perfis. É a "verdade" quando as cópias divergem — e como o slot de quem
 * escreveu SEMPRE persiste certo (o save reconstrói o slot ativo), a cópia mais
 * nova está sempre no slot de quem mexeu por último. Pura. Retorna a meta ou null.
 */
export function copiaMaisRecente(profiles, reservaId) {
    if (!Array.isArray(profiles) || reservaId == null) return null;
    const rid = String(reservaId);
    let melhor = null;
    for (const p of profiles) {
        for (const m of (Array.isArray(p?.metas) ? p.metas : [])) {
            if (m && String(m.id) === rid &&
                (!melhor || String(m.lastUpdate || '') > String(melhor.lastUpdate || ''))) {
                melhor = m;
            }
        }
    }
    return melhor;
}

/**
 * Reconcilia UMA reserva ativa contra as cópias nos perfis: une a trilha, deriva
 * o saldo dela e adota os campos declarativos da cópia mais nova.
 * MUTA `metaAtiva` — e **somente** `metaAtiva`. Retorna true se mudou algo.
 *
 * É o que faz o perfil B ver o que o perfil A depositou. Repare que ele lê as
 * outras cópias e não escreve NENHUMA delas: é a INVARIANTE do topo do arquivo.
 */
export function reconciliarCopiaAtiva(metaAtiva, profiles, perfilAtivoId) {
    if (!ehCompartilhada(metaAtiva) || metaAtiva.id == null) return false;
    if (!Array.isArray(profiles)) return false;

    const rid = String(metaAtiva.id);
    const outras = [];
    for (const p of profiles) {
        for (const m of (Array.isArray(p?.metas) ? p.metas : [])) {
            if (m && m !== metaAtiva && String(m.id) === rid) outras.push(m);
        }
    }

    let mudou = false;

    // ── 1. A TRILHA SE UNE, NUNCA SE SOBRESCREVE ────────────────────────────
    // Antes `movimentos` vinha em CAMPOS_SINC e era substituído pela cópia
    // "vencedora". Como o desempate por `lastUpdate` sorteava (os carimbos
    // empatavam), a trilha de quem tinha acabado de aportar era apagada — o
    // "Quem colocou" vazio saía daí.
    //
    // Migra o legado ANTES de unir: uma cópia com saldo e sem trilha entraria na
    // união como zero e apagaria dinheiro real. O `mid` do legado é determinístico
    // por reserva, então a entrada de abertura que CADA cópia cria na sua própria
    // sessão colapsa numa só na união.
    //
    // ⚠️ Só a cópia ATIVA é migrada. Migrar as outras aqui seria escrever no slot
    // alheio — e o delta save mandaria o registro INTEIRO da minha visão por cima
    // do que aquele perfil tem gravado. Ler o valor delas basta: é o que
    // `saldoLegadoMaisCompleto` faz.
    const legado = saldoLegadoMaisCompleto([metaAtiva, ...outras]);
    if (migrarSaldoLegado(metaAtiva, legado)) mudou = true;

    // ── 1b. CONSERTO LOCAL: dinheiro MEU que a MINHA trilha não explica ─────
    //
    // Acontece quando algum caminho mexeu em `meta.saved` sem registrar o
    // movimento — hoje isso é um cliente com bundle velho em cache (todos os
    // caminhos desta versão registram). Sem este passo, derivar o saldo apagaria
    // aquele valor da tela.
    //
    // ⚠️ A conferência é contra a MINHA trilha, nunca contra a união. Contra a
    // união, a retirada legítima do outro membro (que a união conhece e a minha
    // cópia ainda não) pareceria "dinheiro sem explicação" e viraria ajuste — o
    // saldo compartilhado nunca conseguiria DESCER. Foi assim que a saída de um
    // membro deixava o outro com o dinheiro na tela.
    if (repararSaldoLocal(metaAtiva)) mudou = true;

    const unida = unirMovimentos(metaAtiva.movimentos, ...outras.map(o => o.movimentos));
    if (JSON.stringify(unida) !== JSON.stringify(metaAtiva.movimentos ?? [])) {
        metaAtiva.movimentos = unida;
        mudou = true;
    }

    // ── 2. O SALDO É A TRILHA ───────────────────────────────────────────────
    //
    // Depois do conserto local acima, tudo o que é meu já está explicado na
    // trilha. O saldo então é, exatamente, a soma da união — para cima quando
    // alguém aporta, para baixo quando alguém retira ou sai da reserva.
    //
    // Derivar nos dois sentidos é o que faz as cópias CONVERGIREM: enquanto o
    // saldo só podia subir, a retirada do outro membro nunca chegava, e cada
    // cópia acumulava um número diferente sem que ninguém errasse nada.
    const derivado = saldoDeMovimentos(unida);
    const atual = Math.round(Number(metaAtiva.saved || 0) * 100) / 100;
    if (derivado !== null && derivado !== atual) {
        metaAtiva.saved = derivado;
        mudou = true;
    }

    // ── 3. Os demais campos ainda seguem a cópia mais recente ───────────────
    // Objetivo, prazo, roster e afins são declarações, não acumuladores: para
    // eles "o último que falou" continua sendo a regra certa. `saved`,
    // `movimentos` e `monthly` saíram daqui — são derivados/unidos acima.
    const pid = String(perfilAtivoId ?? '');
    const euEraMembro = !!pid && Array.isArray(metaAtiva.membros) &&
                        metaAtiva.membros.map(String).includes(pid);

    const recente = copiaMaisRecente(profiles, metaAtiva.id);
    if (recente && recente !== metaAtiva &&
        String(recente.lastUpdate || '') > String(metaAtiva.lastUpdate || '')) {
        const clone = JSON.parse(JSON.stringify(recente));
        for (const k of CAMPOS_DECLARATIVOS) if (k in clone) { metaAtiva[k] = clone[k]; mudou = true; }
    }

    // ── 3b. SÓ EU DIGO QUE EU SAÍ ───────────────────────────────────────────
    //
    // 🔴 BUG MEDIDO na simulação de ponta a ponta: o perfil B aceitava o convite
    // (entrava em `membros` na cópia DELE) e, no aporte seguinte do perfil A —
    // que ainda não tinha recarregado e por isso listava B como convite pendente
    // — o carimbo de A ficava mais novo. A reconciliação de B então adotava o
    // roster velho de A, B saía de `membros` e a reserva sumia da tela de B,
    // levando junto a trilha dele.
    //
    // O roster tem dois donos e não pode ser um bloco de "último que falou":
    // quem convida declara os CONVITES; quem aceita declara a PRÓPRIA entrada.
    // Aqui reafirmamos a segunda parte — a saída continua sendo ato explícito
    // meu (`sairDaReserva`, que marca `saiu`).
    if (euEraMembro && metaAtiva.saiu !== true) {
        if (!Array.isArray(metaAtiva.membros)) metaAtiva.membros = [];
        if (!metaAtiva.membros.map(String).includes(pid)) {
            metaAtiva.membros = [...metaAtiva.membros.map(String), pid];
            mudou = true;
        }
        if (Array.isArray(metaAtiva.convites) && metaAtiva.convites.map(String).includes(pid)) {
            metaAtiva.convites = metaAtiva.convites.map(String).filter(x => x !== pid);
            mudou = true;
        }
    }

    // ── 4. O gráfico mensal também é da RESERVA, não de quem abriu a tela ───
    // `monthly` alimenta o gráfico de linha. Sem propagação ele ficaria só com o
    // que ESTE perfil guardou, e o gráfico contaria uma história menor que o
    // saldo logo acima dele. Derivar da trilha unida resolve sem sincronizar
    // nada: mesma fonte, mesmo número.
    //
    // Os meses ANTERIORES à trilha (reserva legada) são preservados — a migração
    // cria uma única entrada de abertura, sem mês, e sobrescrever apagaria o
    // histórico do gráfico de quem já usava a reserva.
    if (aplicarMensalDaTrilha(metaAtiva, unida)) mudou = true;

    return mudou;
}

/**
 * Fecha a conta ENTRE A MINHA TRILHA E O MEU SALDO, sem olhar as outras cópias.
 *
 * Se a minha trilha explica MENOS do que o meu `saved`, existe dinheiro que
 * entrou aqui sem passar pelo registro — na prática, uma aba com bundle antigo
 * em cache de Service Worker, de uma versão em que nem todo caminho registrava.
 * Em vez de deixar a derivação apagar esse valor da tela, ele vira um lançamento
 * de ajuste: a trilha passa a explicar o saldo e o dinheiro não some.
 *
 * O caso contrário (trilha explicando MAIS) não faz nada: é o meu próprio saldo
 * ainda não atualizado, e a derivação da união resolve logo depois.
 *
 * `mid` determinístico pelo conteúdo: reconciliar duas vezes não empilha ajuste.
 * MUTA. Retorna true se lançou.
 */
export function repararSaldoLocal(meta) {
    if (!meta || typeof meta !== 'object') return false;
    const minha = Array.isArray(meta.movimentos) ? meta.movimentos : [];
    const derivado = saldoDeMovimentos(minha);
    if (derivado === null) return false;                 // sem trilha: ver migrarSaldoLegado
    const atual = Math.round(Number(meta.saved || 0) * 100) / 100;
    const falta = Math.round((atual - derivado) * 100) / 100;
    if (falta <= 0) return false;

    const mid = `ajuste:${String(meta.id ?? '')}:${falta}:${minha.length}`;
    if (minha.some(m => m?.mid === mid)) return false;
    meta.movimentos = [...minha, {
        mid, memberId: null, memberNome: 'Ajuste',
        tipo: 'aporte', valor: falta, data: null, hora: null,
        em: Date.now(),
    }];
    return true;
}

/**
 * Recalcula `meta.monthly` a partir da trilha, preservando os meses que só o
 * histórico antigo conhece. MUTA. Retorna true se mudou.
 */
export function aplicarMensalDaTrilha(meta, movimentos) {
    const derivado = mensalDeMovimentos(movimentos ?? meta?.movimentos);
    if (!derivado) return false;
    const atual = (meta.monthly && typeof meta.monthly === 'object' && !Array.isArray(meta.monthly))
        ? meta.monthly : {};
    const novo = { ...atual, ...derivado };
    if (JSON.stringify(novo) === JSON.stringify(atual)) return false;
    meta.monthly = novo;
    return true;
}

/**
 * `{ 'YYYY-MM': quanto a reserva cresceu no mês }` a partir da trilha.
 * Negativo vira 0 — mesma regra que a tela de retirada sempre aplicou, para o
 * gráfico não desenhar barra negativa. Null quando não há trilha datável.
 */
export function mensalDeMovimentos(movimentos) {
    if (!Array.isArray(movimentos) || movimentos.length === 0) return null;
    const out = {};
    let algum = false;
    for (const m of movimentos) {
        const ym = mesDoMovimento(m);
        if (!ym) continue;                       // abertura do legado não tem mês
        const v = Number(m?.valor);
        if (!isFinite(v) || v <= 0) continue;
        if (m.tipo !== 'aporte' && m.tipo !== 'retirada') continue;
        algum = true;
        out[ym] = Math.round(((out[ym] || 0) + (m.tipo === 'aporte' ? v : -v)) * 100) / 100;
    }
    if (!algum) return null;
    for (const k of Object.keys(out)) if (out[k] < 0) out[k] = 0;
    return out;
}

/**
 * Mês (`YYYY-MM`) de um movimento. Prefere `data` (dd/mm/aaaa, o rótulo que o
 * usuário vê); cai para `em` (epoch), que existe desde 2026-08-16. Null quando
 * nenhum dos dois serve — é o caso da entrada de abertura do legado, que
 * representa "o que já estava lá" e não pertence a mês nenhum.
 */
export function mesDoMovimento(m) {
    const data = String(m?.data ?? '');
    const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(data);
    if (br) return `${br[3]}-${br[2]}`;
    const iso = /^(\d{4})-(\d{2})-\d{2}/.exec(data);
    if (iso) return `${iso[1]}-${iso[2]}`;
    const em = Number(m?.em);
    if (isFinite(em) && em > 0) {
        const d = new Date(em);
        if (!isNaN(d.getTime())) {
            return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        }
    }
    return null;
}

/**
 * Teto de lançamentos por reserva compartilhada.
 *
 * ⚠️ ANTES daqui saía um `slice(-500)`: a trilha era CORTADA em silêncio quando
 * passava do teto. Com o saldo derivado da trilha, cortar o começo dela é apagar
 * dinheiro — e apagar em silêncio, que é o pior jeito. Agora o teto BARRA
 * aportes novos (com aviso na tela) e nunca remove o que já foi lançado.
 *
 * Retiradas nunca são barradas: elas ENCOLHEM a reserva, e trancar a saída do
 * dinheiro de alguém por causa de um limite técnico seria indefensável.
 *
 * 500 lançamentos é ~40 anos de um depósito por mês; ninguém esbarra nisso na
 * prática. O número existe para o blob não crescer sem limite.
 */
export const LIMITE_APORTES = 500;

/** A trilha já não aceita novos aportes? (a tela avisa antes de mexer no saldo) */
export function trilhaCheia(meta) {
    return Array.isArray(meta?.movimentos) && meta.movimentos.length >= LIMITE_APORTES;
}

/**
 * Registra um movimento de atribuição em `meta.movimentos` (MUTA a meta).
 * Chamado junto de guardar/retirar quando a caixinha é compartilhada — o
 * dinheiro em si já é movido pelo fluxo normal da meta; aqui só gravamos QUEM.
 * Ignora entrada inválida em silêncio (falha segura: nunca grava lixo).
 *
 * @param {string} [mid] chave determinística, para lançamento de SISTEMA que
 *   duas cópias podem gerar sozinhas (rendimento do dia, abertura do legado).
 *   Mesmo `mid` = mesmo lançamento, e a união conta uma vez só. Movimento de
 *   pessoa nunca passa `mid` — ali cada clique é um evento distinto.
 * @returns {boolean} true se entrou na trilha.
 */
export function registrarMovimento(meta, { id, nome, tipo, valor, data, hora, mid } = {}) {
    if (!meta) return false;
    if (!Array.isArray(meta.movimentos)) meta.movimentos = [];
    const v = Number(valor);
    if (!isFinite(v) || v <= 0) return false;
    if (tipo !== 'aporte' && tipo !== 'retirada') return false;
    // Idempotência do lançamento de sistema: rodar duas vezes no mesmo dia (dois
    // renders, dois aparelhos) não pode creditar rendimento duas vezes.
    if (mid && meta.movimentos.some(m => m?.mid === mid)) return false;
    if (tipo === 'aporte' && meta.movimentos.length >= LIMITE_APORTES) return false;
    meta.movimentos.push({
        // `mid` é o que torna a trilha UNÍVEL entre cópias (2026-08-16). Sem um
        // id por movimento, unir duas listas ou duplicaria tudo, ou obrigaria a
        // comparar campo a campo — e dois aportes iguais no mesmo minuto são
        // indistinguíveis assim. Com `mid`, união é `dedupe por chave`.
        mid:        mid || _novoMid(),
        memberId:   id != null ? String(id) : null,
        memberNome: String(nome ?? 'Membro').trim().slice(0, 80) || 'Membro',
        tipo,
        valor:      Math.round(v * 100) / 100,
        data:       data ?? null,
        hora:       hora ?? null,
        // Ordena a trilha entre cópias sem depender do relógio de `data`/`hora`,
        // que são só rótulos de exibição.
        em:         Date.now(),
    });
    return true;
}

/**
 * Chave de dedupe de um `mid`.
 *
 * Para lançamento de PESSOA, é o próprio id — cada clique é um evento distinto e
 * dois aportes de R$100 no mesmo minuto são dois aportes.
 *
 * Para os dois lançamentos de REPARO — `legado:<reserva>` (abertura de saldo
 * antigo) e `ajuste:<reserva>:<falta>:<n>` (dinheiro que a trilha não explicava)
 * — a chave é só `<tipo>:<reserva>`. Eles descrevem o MESMO buraco visto de
 * cópias diferentes; se o valor entrasse na chave, cada cópia traria o seu e a
 * união somaria reparos concorrentes, inventando dinheiro numa reserva de
 * família. O `rend:<reserva>:<dia>` NÃO colapsa: cada dia é um crédito real.
 */
function _chaveDeUniao(mid) {
    const s = String(mid);
    for (const tipo of ['legado', 'ajuste']) {
        if (!s.startsWith(tipo + ':')) continue;
        const partes = s.split(':');
        return `${tipo}:${partes[1] ?? ''}`;
    }
    return `id:${s}`;
}

/** Id de movimento. `randomUUID` quando existe; senão, aleatório + tempo. */
function _novoMid() {
    try {
        if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    } catch { /* ambiente sem crypto: cai no fallback */ }
    return `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// A TRILHA É A FONTE DA VERDADE (2026-08-16)
//
// ACHADO, medido em produção: duas cópias da mesma reserva com saldos
// diferentes (500 e 1000) e `lastUpdate` IDÊNTICO ao milissegundo. O desempate
// por hora virava sorteio pela ordem do array, e a reconciliação trazia a cópia
// errada. Pior: `movimentos` estava em CAMPOS_SINC, então a reconciliação
// SOBRESCREVIA a trilha — por isso "Quem colocou" ficava vazio mesmo para quem
// tinha acabado de aportar.
//
// A raiz é o modelo: comparar saldos entre cópias pressupõe que uma delas está
// certa. Numa reserva compartilhada não está — cada uma viu uma parte. O saldo
// não é um número a ser disputado, é a SOMA do que cada um pôs.
//
// Agora: os movimentos se UNEM (nunca se sobrescrevem) e o saldo é DERIVADO
// deles. Duas escritas simultâneas passam a somar em vez de uma vencer.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * União de trilhas, sem duplicar. Dedupe por `mid`.
 *
 * Movimento sem `mid` é legado (gravado antes de 2026-08-16): recebe uma chave
 * derivada do conteúdo, para que a mesma entrada vinda de duas cópias não conte
 * duas vezes. Não é perfeito — dois aportes idênticos no mesmo segundo colapsam
 * em um — mas é o mais seguro possível sem id, e só afeta dado antigo.
 *
 * PURA. Ordena por `em` (e depois por `mid`) para a lista ficar estável entre
 * perfis: mesma entrada, mesma ordem, em qualquer aparelho.
 */
export function unirMovimentos(...listas) {
    const mapa = new Map();
    for (const lista of listas) {
        if (!Array.isArray(lista)) continue;
        for (const m of lista) {
            if (!m || typeof m !== 'object') continue;
            const chave = m.mid
                ? _chaveDeUniao(m.mid)
                : `legado:${m.memberId ?? ''}:${m.tipo}:${m.valor}:${m.data ?? ''}:${m.hora ?? ''}`;
            const jaTem = mapa.get(chave);
            if (jaTem === undefined) { mapa.set(chave, m); continue; }
            // Colisão de REPARO (abertura do legado, ajuste): duas cópias
            // consertaram o MESMO buraco cada uma por si, com valores diferentes
            // — herança da propagação antiga, que as deixava divergentes. Somar
            // as duas inventaria dinheiro; ficar com a primeira seria sortear
            // pela ordem do array. Fica a MAIOR, que é o acumulado que de fato
            // existiu (mesma razão de `saldoLegadoMaisCompleto`).
            //
            // Colapsar aqui é seguro porque o reparo se refaz sozinho: se a
            // maior não cobrir tudo, `repararSaldoLocal` lança a diferença que
            // faltar na próxima reconciliação. Perder é temporário; inventar, não.
            if (Number(m.valor) > Number(jaTem.valor)) mapa.set(chave, m);
        }
    }
    // Cópia rasa de cada lançamento (são objetos planos). Sem isto, a trilha da
    // minha cópia passaria a apontar para os OBJETOS que vivem no slot do outro
    // perfil — e qualquer mutação futura num deles escreveria no slot alheio pela
    // porta dos fundos, que é exatamente a classe de defeito que esta mudança
    // veio eliminar. Custa um objeto por lançamento, uma vez por reconciliação.
    return [...mapa.values()].map((m) => ({ ...m })).sort((a, b) => {
        const ea = Number(a?.em ?? 0), eb = Number(b?.em ?? 0);
        if (ea !== eb) return ea - eb;
        return String(a?.mid ?? '').localeCompare(String(b?.mid ?? ''));
    });
}

/**
 * Saldo derivado da trilha: aportes − retiradas.
 *
 * ⚠️ `null` quando NÃO há trilha — e o chamador precisa tratar isso. Reserva
 * criada antes de 2026-08-16 tem `saved` sem nenhum movimento; devolver 0 ali
 * ZERARIA o dinheiro de quem já usava a feature. Ver `migrarSaldoLegado`.
 */
export function saldoDeMovimentos(movimentos) {
    if (!Array.isArray(movimentos) || movimentos.length === 0) return null;
    let total = 0;
    for (const m of movimentos) {
        const v = Number(m?.valor);
        if (!isFinite(v) || v <= 0) continue;
        if (m.tipo === 'aporte')        total += v;
        else if (m.tipo === 'retirada') total -= v;
    }
    return Math.round(total * 100) / 100;
}

/**
 * Reserva antiga (saldo sem trilha) ganha UM movimento de abertura, para entrar
 * no modelo novo sem perder um centavo.
 *
 * O `mid` é DETERMINÍSTICO (`legado:<id da reserva>`): se dois perfis migrarem a
 * mesma reserva ao mesmo tempo, a união reconhece as duas entradas como a mesma
 * e o saldo não dobra. É a diferença entre migrar e duplicar dinheiro.
 *
 * MUTA a meta. Retorna true se migrou.
 */
export function migrarSaldoLegado(meta, saldoForcado) {
    if (!meta || typeof meta !== 'object') return false;
    if (Array.isArray(meta.movimentos) && meta.movimentos.length > 0) return false;
    const saldo = Math.round(Number(saldoForcado ?? meta.saved ?? 0) * 100) / 100;
    if (!isFinite(saldo) || saldo <= 0) return false;

    meta.movimentos = [{
        mid:        `legado:${String(meta.id ?? '')}`,
        memberId:   null,
        memberNome: 'Saldo anterior',
        tipo:       'aporte',
        valor:      saldo,
        data:       null,
        hora:       null,
        em:         0,        // sempre primeiro na ordem: é o ponto de partida
    }];
    return true;
}

/**
 * O saldo legado a adotar quando as cópias divergem SEM trilha.
 *
 * É o MAIOR, e o motivo importa: sem trilha não dá para saber quais aportes são
 * independentes. No caso medido em 2026-08-16 — B com 500, A com 1000 — os 500
 * de B já estavam DENTRO dos 1000 de A (A viu o depósito de B antes de aportar).
 * Somar daria 1500 e inventaria dinheiro; pegar o primeiro daria 500 e apagaria
 * o aporte de A. O maior é o único que representa o acumulado real.
 *
 * A partir da migração isto deixa de importar: com trilha, aportes somam de
 * verdade porque cada um tem `mid` próprio.
 */
export function saldoLegadoMaisCompleto(metas) {
    let maior = 0;
    for (const m of metas) {
        if (!m || (Array.isArray(m.movimentos) && m.movimentos.length > 0)) continue;
        const v = Math.round(Number(m.saved || 0) * 100) / 100;
        if (isFinite(v) && v > maior) maior = v;
    }
    return maior;
}

/**
 * Quem colocou e quem tirou — o coração da feature.
 *
 * Devolve o LÍQUIDO por pessoa (aportes − retiradas), do que mais contribuiu
 * para o que menos. Só aportes esconderia quem coloca 500 e tira 400 todo mês;
 * o líquido conta a história real sem acusar ninguém — só exibe o número.
 *
 * `sistema: true` marca as linhas que NÃO são de uma pessoa: a abertura do saldo
 * legado e o ajuste de reconciliação. Elas entram na conta (é dinheiro real),
 * mas a tela precisa saber separá-las — "Saldo anterior" listado como se fosse
 * um membro da família foi reclamação explícita do dono.
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
        if (!e) {
            e = { id: m.memberId ?? null, nome: m.memberNome || 'Membro',
                  aportes: 0, retiradas: 0, liquido: 0, sistema: m.memberId == null };
            mapa.set(chave, e);
        }
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

// ═══════════════════════════════════════════════════════════════════════════
// EXTRATO POR MÊS — o que a tela mostra no lugar de um número solto
//
// O card antigo dizia só "Fulano: R$ 300" (o líquido acumulado desde sempre).
// Não respondia "quando", não respondia "quanto foi cada depósito", e misturava
// as linhas de sistema com as pessoas. Estas funções são puras e devolvem o
// material do card novo: os meses que existem, e o que aconteceu em cada um.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Meses com movimento, do mais recente para o mais antigo (`['2026-08', …]`).
 * A abertura do legado não tem mês e não vira opção — ela aparece no total.
 */
export function mesesComMovimento(movimentos) {
    if (!Array.isArray(movimentos)) return [];
    const meses = new Set();
    for (const m of movimentos) {
        const ym = mesDoMovimento(m);
        if (ym) meses.add(ym);
    }
    return [...meses].sort().reverse();
}

/**
 * Lançamentos de um mês (`YYYY-MM`), do mais recente para o mais antigo.
 * `null`/vazio devolve a trilha inteira — é o modo "Tudo" do seletor.
 */
export function movimentosDoMes(movimentos, ym) {
    if (!Array.isArray(movimentos)) return [];
    const lista = ym
        ? movimentos.filter(m => mesDoMovimento(m) === ym)
        : movimentos.slice();
    return lista
        .filter(m => m && (m.tipo === 'aporte' || m.tipo === 'retirada') && Number(m.valor) > 0)
        .sort((a, b) => {
            const ea = Number(a?.em ?? 0), eb = Number(b?.em ?? 0);
            if (ea !== eb) return eb - ea;
            return String(b?.mid ?? '').localeCompare(String(a?.mid ?? ''));
        });
}

/** `'2026-08'` → `'Agosto de 2026'`. Fora do padrão, devolve a própria chave. */
export function rotuloMes(ym) {
    const m = /^(\d{4})-(\d{2})$/.exec(String(ym ?? ''));
    if (!m) return String(ym ?? '');
    const nomes = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
                   'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
    const i = Number(m[2]) - 1;
    return `${nomes[i] ?? m[2]} de ${m[1]}`;
}

/** Progresso rumo ao objetivo (0–100), ou null quando não há objetivo. */
export function progressoDe(saldo, objetivo) {
    const o = Number(objetivo);
    if (!isFinite(o) || o <= 0) return null;
    return Math.max(0, Math.min(100, (Number(saldo) / o) * 100));
}
