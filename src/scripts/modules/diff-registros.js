// diff-registros.js — de "aqui está o estado inteiro" para "isto foi o que eu fiz"
// ---------------------------------------------------------------------------
// Passo 37.1a. Recebe a coleção como ela estava (o retrato do último load/save)
// e como está agora, e devolve as OPERAÇÕES que explicam a diferença.
//
// Por que isto derruba o Lost Update: um save que diz "adicionei a transação X"
// não fala nada sobre as outras, então não pode apagá-las. O save de hoje diz
// "estas são todas as minhas transações" — e quem diz isso sobrescreve quem
// salvou antes, mesmo sem ter tocado em nada dele.
//
// ── O FORMATO É UMA LISTA PLANA, E ISSO NÃO É ESTILO ─────────────────────────
//
// `[{ op:'rm'|'edit'|'add', id?, r?, apos? }]`, na ordem de aplicação.
//
// O proxy (`api/user-data.js`) rejeita corpo com mais de 8 níveis de aninhamento
// — e o payload de hoje JÁ chega a 7 (profiles → perfil → contasFixas → conta →
// compras → compra). Agrupar as operações por perfil e por coleção, no formato
// `{perfil: {colecao: {add: [{apos, registro}]}}}`, dava 9: todo save com fatura
// de cartão voltaria 400, em produção, para todo mundo.
//
// A lista plana chega a 6. O `p`/`c` repetido em cada operação custa alguns bytes
// e devolve dois níveis de margem. E há um segundo motivo, além do teto: o mesmo
// proxy recusa objeto com mais de 80 chaves, então qualquer mapa indexado por id
// (âncoras, por exemplo) quebraria em uma importação de extrato com 100 linhas.
// Lista não conta chaves.
//
// ── POR QUE O `add` CARREGA POSIÇÃO ──────────────────────────────────────────
//
// A ordem do array É visível: a tela de Transações mostra
// `filtrarTransacoesParaUI().reverse()` — a lista é a ordem de inserção, de trás
// para a frente. Não há ordenação por data.
//
// Quase tudo no app usa `push`, e para esses o fim do array serve. Mas o
// desfazer de uma exclusão reinsere no MEIO (`splice(pos, 0, t)` em
// db-transacoes). Se o servidor sempre anexasse no fim, desfazer uma exclusão
// devolveria a transação para o topo da lista no próximo reload — visível, e do
// tipo que rende "por que ela pulou de lugar?".
//
// Por isso cada `add` leva `apos`: o id do registro que vem imediatamente antes
// dele, ou `null` quando ele é o primeiro. Quem aplica insere depois daquele id;
// se não achar (outro cliente removeu esse vizinho), anexa no fim. Vários `add`
// seguidos funcionam porque as operações são aplicadas NA ORDEM em que vêm.
//
// ── O QUE ESTE MÓDULO NÃO PROMETE ────────────────────────────────────────────
//
// REORDENAR. Mover um registro que já existia sai como "nada mudou". Nada no app
// reordena coleção hoje; se alguma tela passar a fazer isso e quiser gravar a
// ordem, vai precisar de uma operação própria.
//
// CERTEZA A QUALQUER CUSTO. Quando o diff não consegue afirmar o que aconteceu
// — registro sem id, dois registros com o MESMO id — ele **recusa** em vez de
// chutar: `{ok:false, motivo}`. Chutar aqui apaga dado do usuário. O chamador
// cai no save de estado inteiro, que é o comportamento de hoje: pior para
// concorrência, mas conhecido.
// ---------------------------------------------------------------------------

import { serializarEstavel } from './registro-id.js?v=1';

/**
 * Conteúdo do registro, sem o `id`. O id é a CHAVE — comparar identidade dentro
 * do conteúdo é redundante e dá falso positivo: as metas antigas têm id inteiro
 * e as novas têm UUID, então um `1` que virasse `'1'` em algum caminho marcaria
 * o registro como editado em TODO save. Um edit por save vira um conflito por
 * save quando o 37.3 (versão) chegar.
 */
function conteudo(registro) {
    const { id: _ignorado, ...resto } = registro;
    return serializarEstavel(resto);
}

/**
 * Indexa uma lista por id, recusando o que não dá para identificar.
 * @returns {{ok:true, mapa:Map<string,object>} | {ok:false, motivo:string}}
 */
function indexar(lista) {
    const mapa = new Map();
    for (const r of lista) {
        if (!r || typeof r !== 'object' || Array.isArray(r)) return { ok: false, motivo: 'registro_invalido' };
        if (r.id == null || r.id === '') return { ok: false, motivo: 'sem_id' };
        const id = String(r.id);
        // Dois registros com o mesmo id: não há como dizer qual foi editado e
        // qual foi removido. Acontece se um `structuredClone` for gravado duas
        // vezes, ou se um backfill rodar sobre dado já carimbado.
        if (mapa.has(id)) return { ok: false, motivo: 'id_duplicado' };
        mapa.set(id, r);
    }
    return { ok: true, mapa };
}

/**
 * Operações que transformam `antes` em `depois`, na ordem de aplicação
 * (remoções → edições → inserções).
 *
 * A ordem não é arbitrária: o `apos` de cada inserção foi calculado sobre o
 * estado FINAL, onde o que foi removido já não existe. Inserir antes de remover
 * faria a âncora cair no lugar errado.
 *
 * @param {Array<object>} antes  — a coleção como o servidor a entregou.
 * @param {Array<object>} depois — a coleção como está agora, na memória da tela.
 * @returns {{ok:true, ops:Array<object>} | {ok:false, motivo:string}}
 */
export function diffColecao(antes, depois) {
    // Coleção que não existia e continua não existindo: nada a fazer. Distinguir
    // `undefined` de `[]` aqui só geraria operações vazias.
    if (antes == null && depois == null) return { ok: true, ops: [] };
    const a = antes == null ? [] : antes;
    const d = depois == null ? [] : depois;
    if (!Array.isArray(a) || !Array.isArray(d)) return { ok: false, motivo: 'nao_e_lista' };

    const iA = indexar(a);
    if (!iA.ok) return iA;
    const iD = indexar(d);
    if (!iD.ok) return iD;

    const remocoes = [];
    const edicoes = [];
    const insercoes = [];

    // Percorre `depois` na ORDEM do array — é dela que sai o `apos` de cada
    // registro novo, e é ela que o servidor vai reproduzir.
    for (let i = 0; i < d.length; i++) {
        const novo = d[i];
        const id = String(novo.id);
        const velho = iA.mapa.get(id);
        if (velho === undefined) {
            insercoes.push({ op: 'add', apos: i > 0 ? String(d[i - 1].id) : null, r: novo });
            continue;
        }
        if (conteudo(velho) !== conteudo(novo)) edicoes.push({ op: 'edit', id, r: novo });
    }
    for (const id of iA.mapa.keys()) {
        if (!iD.mapa.has(id)) remocoes.push({ op: 'rm', id });
    }

    return { ok: true, ops: [...remocoes, ...edicoes, ...insercoes] };
}

/**
 * Aplica as operações a uma coleção e devolve a NOVA lista (não muta a entrada).
 *
 * Existe por dois motivos. O imediato é a fase de sombra (37.1b): aplicar as
 * operações sobre o retrato e conferir que o resultado é idêntico ao estado
 * atual PROVA que a derivação está certa, antes de o servidor passar a confiar
 * nela. O segundo é ser o espelho exato do que a Edge Function vai fazer em
 * 37.2a — as duas pontas precisam concordar em cada detalhe, inclusive na ordem.
 */
export function aplicarOperacoes(lista, ops) {
    const lista0 = Array.isArray(lista) ? lista : [];
    const operacoes = Array.isArray(ops) ? ops : (ops?.ok === true ? ops.ops : null);
    if (!operacoes) return lista0.slice();

    let saida = lista0.slice();
    for (const o of operacoes) {
        if (o?.op === 'rm') {
            saida = saida.filter((r) => String(r?.id) !== String(o.id));
        } else if (o?.op === 'edit') {
            const alvo = String(o.id);
            saida = saida.map((r) => (String(r?.id) === alvo ? o.r : r));
        } else if (o?.op === 'add') {
            if (o.apos == null) { saida.unshift(o.r); continue; }
            const i = saida.findIndex((r) => String(r?.id) === String(o.apos));
            // Âncora sumiu (outro cliente removeu o vizinho): anexa no fim. Perde
            // a posição exata, nunca o registro — que é a troca certa.
            if (i === -1) saida.push(o.r);
            else saida.splice(i + 1, 0, o.r);
        }
    }
    return saida;
}

/**
 * 37.1d — o que sobra do perfil quando as coleções saem: nome, foto, config,
 * `orcamentos`, `conquistas`, saldo. Nada disso é lista de registros, então não
 * tem id nem posição; a própria CHAVE é a identidade.
 *
 * Granularidade: um `set` por chave de primeiro nível, com o valor inteiro. É a
 * escolha que serve à concorrência — duas pessoas mexendo em campos DIFERENTES
 * do mesmo perfil não se atropelam. Mandar "o resto todo" como um bloco só
 * traria de volta exatamente o problema que este passo existe para resolver.
 *
 * `unset` é operação própria, e não `set` com `null`: o app apaga campo de
 * verdade (o allowlist do save descarta o que virou `undefined`), e confundir
 * "campo removido" com "campo vale null" gravaria null onde havia ausência.
 *
 * @param {object} antes
 * @param {object} depois
 * @param {string[]} ignorar — chaves que viajam por outro caminho (as coleções).
 * @returns {{ok:true, ops:Array<object>} | {ok:false, motivo:string}}
 */
export function diffCampos(antes, depois, ignorar = []) {
    const a = antes && typeof antes === 'object' && !Array.isArray(antes) ? antes : null;
    const d = depois && typeof depois === 'object' && !Array.isArray(depois) ? depois : null;
    if (a === null || d === null) return { ok: false, motivo: 'nao_e_objeto' };

    const fora = new Set([...ignorar, 'id']);   // `id` é a chave do perfil
    const ops = [];

    for (const k of Object.keys(d)) {
        if (fora.has(k)) continue;
        if (!(k in a) || serializarEstavel(a[k]) !== serializarEstavel(d[k])) {
            ops.push({ op: 'set', k, v: d[k] });
        }
    }
    for (const k of Object.keys(a)) {
        if (fora.has(k) || k in d) continue;
        ops.push({ op: 'unset', k });
    }
    return { ok: true, ops };
}

/**
 * Aplica `set`/`unset` a um objeto e devolve um NOVO objeto. Operações de
 * coleção (`add`/`edit`/`rm`) são ignoradas aqui — cada uma tem o seu aplicador,
 * e a lista do fio mistura os dois tipos.
 */
export function aplicarCampos(obj, ops) {
    const operacoes = Array.isArray(ops) ? ops : (ops?.ok === true ? ops.ops : null);
    const saida = { ...(obj && typeof obj === 'object' ? obj : {}) };
    if (!operacoes) return saida;
    for (const o of operacoes) {
        if (o?.op === 'set') saida[o.k] = o.v;
        else if (o?.op === 'unset') delete saida[o.k];
    }
    return saida;
}

/** true quando o diff não descreve mudança nenhuma. */
export function diffVazio(d) {
    return !!d && d.ok === true && d.ops.length === 0;
}

/** Quantas operações o diff carrega (para telemetria e para o teto de payload). */
export function contarOperacoes(d) {
    return !d || d.ok !== true ? 0 : d.ops.length;
}

/** Só as operações de um tipo — para os testes e para a telemetria. */
export function operacoesDe(d, tipo) {
    return !d || d.ok !== true ? [] : d.ops.filter((o) => o.op === tipo);
}

/**
 * Carimba perfil e coleção em cada operação, para ela viajar sozinha na lista
 * plana do payload. Feito aqui, e não em `diffColecao`, porque o diff é por
 * coleção e não tem por que saber de qual perfil ele veio.
 */
export function comEndereco(ops, perfilId, colecao) {
    // `set`/`unset` são do perfil, não de uma coleção — mandar `c: null` só
    // gastaria bytes e convidaria quem aplica a tratar null como nome de coleção.
    return colecao == null
        ? ops.map((o) => ({ p: String(perfilId), ...o }))
        : ops.map((o) => ({ p: String(perfilId), c: colecao, ...o }));
}
