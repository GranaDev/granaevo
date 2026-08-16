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
    // Preserva convites pendentes que NÃO estavam no roster: o form de EDIÇÃO
    // lista só membros (db-metas.js:575), então não devemos apagar convites que
    // ele nem mostra. Sem isto, qualquer edição zerava os convites em voo.
    for (const id of jaConvites) {
        if (id !== criador && !membros.includes(id) && !convites.includes(id)) convites.push(id);
    }
    return { membros: membros.slice(0, 12), convites: convites.slice(0, 12) };
}

// ----------------------------------------------------------------------------
// PROPAGAÇÃO ENTRE PERFIS (o que faz a reserva aparecer em OUTRO perfil).
//
// Cada perfil tem seu PRÓPRIO array de `metas` no blob — uma reserva criada no
// perfil A não aparece no perfil B sozinha. Para o convite→aceite funcionar, a
// reserva compartilhada ganha uma CÓPIA no slot de cada perfil participante
// (membros ∪ convites). A meta inteira é estado COMPARTILHADO: o dinheiro real
// são as transações (array à parte, com metaId), que ficam com quem contribuiu —
// a meta em si (saved/movimentos/objetivo/…) é a mesma para todos. Por isso
// propagamos a meta inteira, sem tocar em transações.
// ----------------------------------------------------------------------------

/**
 * Garante a cópia de UMA reserva compartilhada em cada perfil MEMBRO (aceito) e a
 * remove de quem não é mais membro. Os CONVIDADOS pendentes NÃO recebem cópia —
 * senão a reserva contaria no total/patrimônio deles antes de aceitarem; o
 * convite é descoberto varrendo a lista `convites` das cópias dos membros.
 * MUTA `profiles` (o array de perfis do blob). `cloneFn` injeta o clone (default
 * deep-clone) — testável. Retorna profiles.
 */
export function sincronizarReservaEmPerfis(profiles, reserva, cloneFn) {
    if (!Array.isArray(profiles) || !ehCompartilhada(reserva) || reserva.id == null) return profiles;
    const clone = typeof cloneFn === 'function' ? cloneFn : (x) => JSON.parse(JSON.stringify(x));
    const rid = String(reserva.id);
    const participantes = new Set(Array.isArray(reserva.membros) ? reserva.membros.map(String) : []);
    for (const p of profiles) {
        if (!p || typeof p !== 'object') continue;
        if (!Array.isArray(p.metas)) p.metas = [];
        const idx = p.metas.findIndex(m => m && String(m.id) === rid);
        if (participantes.has(String(p.id))) {
            const copia = clone(reserva);          // cópia independente (sem alias)
            if (idx === -1) p.metas.push(copia);
            else p.metas[idx] = copia;
        } else if (idx !== -1) {
            p.metas.splice(idx, 1);                 // não participa → remove a cópia
        }
    }
    return profiles;
}

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
// `saved` e `movimentos` foram retirados desta lista em 2026-08-16. Eles são
// ACUMULADORES: a trilha se une e o saldo sai dela. Copiar um acumulador da
// "cópia vencedora" era o que fazia um aporte apagar o outro. `CAMPOS_SINC`
// continua completo porque a PROPAGAÇÃO (que empurra o estado inteiro para as
// outras cópias) precisa levar tudo — quem não pode escolher um lado é a
// RECONCILIAÇÃO, que junta o que voltou divergente.
const CAMPOS_DECLARATIVOS = CAMPOS_SINC.filter(k => k !== 'saved' && k !== 'movimentos');

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
 * desconta do saldo, registra a retirada na trilha e remove o perfil do roster.
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
    marcarReservaAtualizada(meta);

    return { ok: true, valor: v, ultimo };
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
 * Reconcilia UMA reserva ativa contra as cópias nos perfis: se existe uma cópia
 * mais recente (por lastUpdate), traz os campos compartilhados para a meta ativa.
 * MUTA `metaAtiva`. Retorna true se mudou algo. É o que faz o perfil B ver o
 * saldo que o perfil A depositou, sem depender da propagação em memória.
 */
export function reconciliarCopiaAtiva(metaAtiva, profiles) {
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
    // união como zero e apagaria dinheiro real.
    // Todas as cópias sem trilha migram com o MESMO valor — o maior entre elas.
    // Valores diferentes gerariam entradas de legado divergentes disputando o
    // mesmo `mid`, e a união escolheria por ordem de array (o sorteio de novo).
    const legado = saldoLegadoMaisCompleto([metaAtiva, ...outras]);
    if (migrarSaldoLegado(metaAtiva, legado)) mudou = true;
    for (const o of outras) migrarSaldoLegado(o, legado);

    const unida = unirMovimentos(metaAtiva.movimentos, ...outras.map(o => o.movimentos));
    if (JSON.stringify(unida) !== JSON.stringify(metaAtiva.movimentos ?? [])) {
        metaAtiva.movimentos = unida;
        mudou = true;
    }

    // ── 2. O SALDO É DERIVADO DA TRILHA ─────────────────────────────────────
    // Deixa de ser um número que as cópias disputam. Duas pessoas aportando ao
    // mesmo tempo agora SOMAM — antes uma vencia e a outra sumia.
    const derivado = saldoDeMovimentos(unida);
    if (derivado !== null && Number(metaAtiva.saved || 0) !== derivado) {
        metaAtiva.saved = derivado;
        mudou = true;
    }

    // ── 3. Os demais campos ainda seguem a cópia mais recente ───────────────
    // Objetivo, prazo, roster e afins são declarações, não acumuladores: para
    // eles "o último que falou" continua sendo a regra certa. `saved` e
    // `movimentos` saíram daqui — são derivados/unidos acima.
    const recente = copiaMaisRecente(profiles, metaAtiva.id);
    if (recente && recente !== metaAtiva &&
        String(recente.lastUpdate || '') > String(metaAtiva.lastUpdate || '')) {
        const clone = JSON.parse(JSON.stringify(recente));
        for (const k of CAMPOS_DECLARATIVOS) if (k in clone) { metaAtiva[k] = clone[k]; mudou = true; }
    }

    return mudou;
}

/**
 * Remove uma reserva (por id) das cópias de TODOS os perfis do array — usado ao
 * excluir/dissolver a reserva. MUTA `profiles`. Retorna profiles.
 */
export function removerReservaDePerfis(profiles, reservaId) {
    if (!Array.isArray(profiles) || reservaId == null) return profiles;
    const rid = String(reservaId);
    for (const p of profiles) {
        if (!p || !Array.isArray(p.metas)) continue;
        const idx = p.metas.findIndex(m => m && String(m.id) === rid);
        if (idx !== -1) p.metas.splice(idx, 1);
    }
    return profiles;
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
        // `mid` é o que torna a trilha UNÍVEL entre cópias (2026-08-16). Sem um
        // id por movimento, unir duas listas ou duplicaria tudo, ou obrigaria a
        // comparar campo a campo — e dois aportes iguais no mesmo minuto são
        // indistinguíveis assim. Com `mid`, união é `dedupe por chave`.
        mid:        _novoMid(),
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
    // Cap defensivo: trilha não pode crescer sem limite dentro do blob.
    if (meta.movimentos.length > 500) meta.movimentos = meta.movimentos.slice(-500);
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
                ? `id:${m.mid}`
                : `legado:${m.memberId ?? ''}:${m.tipo}:${m.valor}:${m.data ?? ''}:${m.hora ?? ''}`;
            if (!mapa.has(chave)) mapa.set(chave, m);
        }
    }
    return [...mapa.values()].sort((a, b) => {
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
