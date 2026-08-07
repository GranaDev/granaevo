// registro-id.js — identidade estável de cada registro do usuário
// ---------------------------------------------------------------------------
// FUNDAÇÃO do Passo 37 (sincronizar por operação). Hoje o cliente manda o estado
// INTEIRO a cada save; quem diz "aqui estão todos os meus dados" sobrescreve
// quem salvou antes. Para o cliente poder dizer "editei ESTA transação" em vez
// de "aqui está tudo", cada registro precisa de um nome próprio que sobreviva ao
// reload. As transações não tinham nenhum — o desfazer casava por CAMPOS
// (`sameTx`) justamente porque não havia identificador.
//
// São duas origens de id, e a diferença entre elas é o coração deste arquivo:
//
//   novoId()      ALEATÓRIO — para o registro que NASCE aqui.
//                 Tem de ser aleatório: duas abas podem lançar "Café R$ 5" no
//                 mesmo minuto, e são dois cafés. Se o id viesse dos campos, os
//                 dois receberiam o mesmo e um sumiria — o bug que estamos
//                 consertando, voltando pela porta dos fundos.
//
//   backfillIds() DETERMINÍSTICO — para o registro ANTIGO, gravado antes deste
//                 código existir. Aqui a exigência se inverte: dois clientes que
//                 carregam a MESMA linha do banco têm de chegar ao MESMO id.
//                 Se cada um sorteasse o seu, o outro veria "sumiu um registro e
//                 nasceu outro" e o histórico duplicaria. Por isso o id sai de um
//                 hash dos campos, não do acaso.
//
// O par só funciona junto: o backfill roda no LOAD, então tudo que veio do banco
// já chega com id; qualquer registro sem id no momento do save nasceu nesta
// sessão, e aí o sorteio é a resposta certa.
//
// Os ids são OPACOS. Nada no app deve interpretá-los, comparar formatos ou
// derivar significado deles — o único contrato é "iguais = mesmo registro".
// ---------------------------------------------------------------------------

// Coleções que guardam registros identificáveis (arrays de objetos).
// `orcamentos` e `conquistas` são mapas chaveados por nome, não listas — a
// própria chave já é a identidade, e eles entram no diff como campos escalares.
export const COLECOES = ['transacoes', 'metas', 'cartoesCredito', 'contasFixas', 'assinaturas'];

let _seq = 0;

/**
 * Id de um registro que está nascendo agora. Aleatório, gerado no CLIENTE —
 * funciona offline e serve de chave de idempotência quando o reenvio existir.
 * Mesmo formato (UUID) que metas, cartões e contas fixas já usam.
 */
export function novoId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    // Navegador sem randomUUID (contexto inseguro, WebView antigo): o par
    // tempo+sequência garante unicidade DENTRO desta aba, e o Math.random
    // separa abas diferentes. Pior que o UUID, melhor que colidir.
    return `r_${Date.now().toString(36)}_${(_seq++).toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Serialização estável: mesmas chaves, mesma ordem, sempre. `JSON.stringify`
 * puro preserva a ordem de inserção, que muda conforme o caminho de código que
 * criou o objeto — e "é o mesmo registro?" precisa depender só do CONTEÚDO.
 *
 * Exportada porque o diff (`diff-registros.js`) tem de usar EXATAMENTE a mesma
 * definição de "mesmo conteúdo" que o id derivado usa. Duas definições que
 * divergem em um detalhe produziriam edições fantasmas a cada save.
 */
export function serializarEstavel(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
    if (Array.isArray(v)) return `[${v.map(serializarEstavel).join(',')}]`;
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${serializarEstavel(v[k])}`).join(',')}}`;
}

/**
 * cyrb53 (domínio público) — hash de 53 bits, que é o inteiro exato que o JS
 * consegue representar. Um hash de 32 bits pareceria suficiente e não é: com
 * 5.000 registros a chance de dois caírem no mesmo valor passa de 0,3% (paradoxo
 * do aniversário), e cada colisão dessas funde duas transações em uma.
 */
function _hash53(str) {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
        const ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** Id derivado do conteúdo — o mesmo registro dá o mesmo id em qualquer cliente. */
export function idDerivado(registro) {
    return _hash53(serializarEstavel(registro)).toString(36).padStart(11, '0');
}

function _colecoesDe(profile) {
    const out = [];
    if (!profile || typeof profile !== 'object') return out;
    for (const nome of COLECOES) {
        const lista = profile[nome];
        if (Array.isArray(lista)) out.push(lista);
    }
    return out;
}

/**
 * Dá id a todo registro ANTIGO que não tem. Roda UMA vez, no load, antes do
 * retrato — se rodasse depois, o perfil inteiro apareceria como "tocado" no save
 * seguinte e a proteção por perfil viraria enfeite.
 *
 * Registros idênticos em todos os campos (dois cafés de R$ 5 no mesmo minuto)
 * derivam o mesmo hash; o segundo ganha um sufixo pela POSIÇÃO no array. Também
 * é determinístico: todo cliente lê o mesmo array, na mesma ordem, do banco.
 *
 * @param {Array<object>} profiles — mutado no lugar.
 * @returns {number} quantos ids foram derivados.
 */
export function backfillIds(profiles) {
    if (!Array.isArray(profiles)) return 0;
    let n = 0;
    for (const profile of profiles) {
        for (const lista of _colecoesDe(profile)) {
            // Ids que já existem entram no conjunto ANTES de qualquer derivação:
            // um id derivado nunca pode cair em cima de um id real.
            const usados = new Set();
            for (const r of lista) if (r && r.id != null && r.id !== '') usados.add(String(r.id));

            for (const r of lista) {
                if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
                if (r.id != null && r.id !== '') continue;
                const base = idDerivado(r);
                let id = base;
                for (let k = 2; usados.has(id); k++) id = `${base}.${k}`;
                usados.add(id);
                r.id = id;
                n++;
            }
        }
    }
    return n;
}

/**
 * Rede de segurança: sorteia id para o que nasceu nesta sessão e escapou de
 * receber um na criação. Roda no save, DEPOIS do backfill do load — então tudo
 * que chega aqui sem id é novo, e sortear é o certo.
 *
 * Por que a rede existe, se os pontos de criação já carimbam: são mais de dez
 * lugares que empurram transação, e um esquecido não daria erro nenhum — só
 * voltaria a perder o dado de outra aba, em silêncio. Este é o ponto único por
 * onde todo save passa.
 *
 * @param {Array<object>} profiles — mutado no lugar.
 * @returns {number} quantos ids foram sorteados.
 */
export function carimbarNovos(profiles) {
    if (!Array.isArray(profiles)) return 0;
    let n = 0;
    for (const profile of profiles) {
        for (const lista of _colecoesDe(profile)) {
            for (const r of lista) {
                if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
                if (r.id != null && r.id !== '') continue;
                r.id = novoId();
                n++;
            }
        }
    }
    return n;
}
