// diff-registros.js — de "aqui está o estado inteiro" para "isto foi o que eu fiz"
// ---------------------------------------------------------------------------
// Passo 37.1a. Recebe a coleção como ela estava (o retrato do último load/save)
// e como está agora, e devolve as OPERAÇÕES que explicam a diferença:
// `{add, edit, remove}`, casadas por `id`.
//
// Por que isto derruba o Lost Update: um save que diz "adicionei a transação X"
// não fala nada sobre as outras, então não pode apagá-las. O save de hoje diz
// "estas são todas as minhas transações" — e quem diz isso sobrescreve quem
// salvou antes, mesmo sem ter tocado em nada dele.
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
// dele, ou `null` quando ele é o primeiro. O servidor insere depois daquele id;
// se não achar (outro cliente removeu esse vizinho), anexa no fim. Vários `add`
// seguidos funcionam porque são aplicados NA ORDEM em que vêm.
//
// ── O QUE ESTE MÓDULO NÃO PROMETE ────────────────────────────────────────────
//
// REORDENAÇÃO. Mover um registro existente de lugar sai como "nada mudou".
// Nada no app reordena coleção hoje; se alguma tela passar a fazer isso e quiser
// gravar a ordem, vai precisar de uma operação própria.
//
// CERTEZA A QUALQUER CUSTO. Quando o diff não consegue afirmar o que aconteceu
// — registro sem id, dois registros com o MESMO id — ele **recusa** em vez de
// chutar: `{ok:false, motivo}`. Chutar aqui apaga dado do usuário. O chamador
// cai no save de estado inteiro, que é o comportamento de hoje: pior para
// concorrência, mas conhecido.
// ---------------------------------------------------------------------------

import { serializarEstavel } from './registro-id.js?v=1';

const VAZIO = Object.freeze({ add: [], edit: [], remove: [] });

/**
 * Conteúdo do registro, sem o `id`. O id é a CHAVE — comparar identidade dentro
 * do conteúdo é redundante e dá falso positivo: as metas antigas têm id inteiro
 * e as novas têm UUID, então um `1` que virou `'1'` em algum caminho marcaria o
 * registro como editado em TODO save. Um edit por save vira um conflito por save
 * quando o 37.3 (versão) chegar.
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
 * Operações que transformam `antes` em `depois`.
 *
 * @param {Array<object>} antes  — a coleção como o servidor a entregou.
 * @param {Array<object>} depois — a coleção como está agora, na memória da tela.
 * @returns {{ok:true, add:Array<{apos:string|null, registro:object}>,
 *            edit:object[], remove:string[]}
 *          |{ok:false, motivo:string}}
 */
export function diffColecao(antes, depois) {
    // Coleção que não existia e continua não existindo: nada a fazer. Distinguir
    // `undefined` de `[]` aqui só geraria operações vazias.
    if (antes == null && depois == null) return { ok: true, ...VAZIO };
    const a = antes == null ? [] : antes;
    const d = depois == null ? [] : depois;
    if (!Array.isArray(a) || !Array.isArray(d)) return { ok: false, motivo: 'nao_e_lista' };

    const iA = indexar(a);
    if (!iA.ok) return iA;
    const iD = indexar(d);
    if (!iD.ok) return iD;

    const add = [];
    const edit = [];
    const remove = [];

    // Percorre `depois` na ORDEM do array — é dela que sai o `apos` de cada
    // registro novo, e é ela que o servidor vai reproduzir.
    for (let i = 0; i < d.length; i++) {
        const novo = d[i];
        const id = String(novo.id);
        const velho = iA.mapa.get(id);
        if (velho === undefined) {
            const anterior = i > 0 ? String(d[i - 1].id) : null;
            add.push({ apos: anterior, registro: novo });
            continue;
        }
        // Mesma definição de "mesmo conteúdo" que o id derivado usa. Comparar com
        // `JSON.stringify` cru marcaria como editado todo registro cujas chaves
        // trocassem de ordem — e a ordem muda conforme o caminho de código.
        if (conteudo(velho) !== conteudo(novo)) edit.push(novo);
    }
    for (const id of iA.mapa.keys()) {
        if (!iD.mapa.has(id)) remove.push(id);
    }

    return { ok: true, add, edit, remove };
}

/**
 * Aplica as operações a uma coleção e devolve a NOVA lista (não muta a entrada).
 *
 * Existe por dois motivos. O imediato é a fase de sombra (37.1b): aplicar o diff
 * sobre o retrato e conferir que o resultado é idêntico ao estado atual PROVA
 * que a derivação está certa, antes de o servidor passar a confiar nela. O
 * segundo é ser o espelho exato do que a Edge Function vai fazer em 37.2a — as
 * duas pontas precisam concordar em cada detalhe, inclusive na ordem.
 *
 * A ordem de aplicação é remove → edit → add, e não é arbitrária: o `apos` de
 * cada add foi calculado sobre o estado FINAL, onde o que foi removido já não
 * existe. Aplicar os adds antes dos removes faria a âncora cair no lugar errado.
 */
export function aplicarOperacoes(lista, ops) {
    if (!ops || ops.ok !== true) return Array.isArray(lista) ? lista.slice() : [];
    const paraRemover = new Set(ops.remove.map(String));
    let saida = (Array.isArray(lista) ? lista : []).filter((r) => !paraRemover.has(String(r?.id)));

    const editados = new Map(ops.edit.map((r) => [String(r.id), r]));
    if (editados.size) saida = saida.map((r) => editados.get(String(r?.id)) ?? r);

    for (const { apos, registro } of ops.add) {
        if (apos == null) { saida.unshift(registro); continue; }
        const i = saida.findIndex((r) => String(r?.id) === String(apos));
        // Âncora sumiu (outro cliente removeu o vizinho): anexa no fim. Perde a
        // posição exata, nunca o registro — que é a troca certa.
        if (i === -1) saida.push(registro);
        else saida.splice(i + 1, 0, registro);
    }
    return saida;
}

/** true quando o diff não descreve mudança nenhuma. */
export function diffVazio(d) {
    return !!d && d.ok === true && d.add.length === 0 && d.edit.length === 0 && d.remove.length === 0;
}

/** Quantas operações o diff carrega (para telemetria e para o teto de payload). */
export function contarOperacoes(d) {
    return !d || d.ok !== true ? 0 : d.add.length + d.edit.length + d.remove.length;
}
