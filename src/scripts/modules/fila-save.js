// fila-save.js — o save que não conseguiu sair não morre com a aba
// ---------------------------------------------------------------------------
// Passo 37.4. Última peça da concorrência, e a única que sobrou depois que o
// Lost Update morreu — esta não é integridade, é NÃO PERDER O QUE JÁ FOI FEITO.
//
// O buraco: quando o save falha (rede caiu, aparelho no elevador), a mudança
// fica só na memória e vai embora no próximo save. Se a pessoa fechar a aba
// antes disso, o lançamento some — e ela não recebeu aviso nenhum de que aquilo
// não tinha sido gravado.
//
// ── O QUE A FILA GUARDA, E POR QUE ISSO IMPORTA ─────────────────────────────
// OPERAÇÕES, nunca estado. É a mesma escolha do outbox do assistente (que guarda
// COMANDOS), e pelo mesmo motivo: estado velho reaplicado apaga o que aconteceu
// no meio do caminho; operação velha reaplicada apenas repete uma intenção.
//
// E repetir é seguro porque o 37.2b deixou toda operação idempotente POR
// CONSTRUÇÃO: `add` de id que já existe é ignorado, `edit` escreve o mesmo
// conteúdo, `rm` do que já sumiu não faz nada. Sem aquilo, esta fila seria uma
// máquina de duplicar transação.
//
// ── POR QUE localStorage E NÃO IndexedDB ────────────────────────────────────
// O conteúdo é pequeno (operações de um save, não o blob) e precisa sobreviver
// a fechar a aba — só isso. IndexedDB traria transação, versionamento e um
// caminho assíncrono a mais para errar, sem entregar nada que faça diferença
// aqui.
//
// ── CARGA SOB DEMANDA ───────────────────────────────────────────────────────
// Este módulo só é importado quando um save FALHA. O caminho feliz nunca o
// carrega, então ele não pesa no boot — que é o que permitiu fazer o 37.4 sem
// esbarrar no teto do dashboard.js (40,4/42 KB).
// ---------------------------------------------------------------------------

const MAX_LOTES  = 10;
// Operação parada há mais de um dia é lixo, não trabalho pendente: o mundo mudou
// em volta dela. Reaplicar seria ressuscitar uma intenção que a pessoa já
// esqueceu — e provavelmente já refez à mão.
const VALIDADE_MS = 24 * 60 * 60 * 1000;
const RECUO_MS = [2_000, 5_000, 15_000, 60_000, 300_000];

const _chave = (userId) => `ge_fila_save_${userId || 'anon'}`;

function _ler(userId) {
    try {
        const arr = JSON.parse(localStorage.getItem(_chave(userId)) || '[]');
        if (!Array.isArray(arr)) return [];
        const limite = Date.now() - VALIDADE_MS;
        return arr.filter((l) => l && typeof l.em === 'number' && l.em > limite).slice(-MAX_LOTES);
    } catch { return []; }
}

function _gravar(userId, arr) {
    try {
        if (!arr.length) localStorage.removeItem(_chave(userId));
        else localStorage.setItem(_chave(userId), JSON.stringify(arr.slice(-MAX_LOTES)));
    } catch { /* cota cheia: perder a fila é ruim, derrubar o app é pior */ }
}

/**
 * Guarda um lote que não conseguiu sair.
 *
 * @param {string} userId
 * @param {Array<object>} ops    operações já derivadas (formato do fio)
 * @param {string[]} tocados     ids de perfil declarados
 * @returns {number} tamanho da fila depois de guardar
 */
export function enfileirar(userId, ops, tocados) {
    if (!Array.isArray(ops) || ops.length === 0) return _ler(userId).length;
    const fila = _ler(userId);
    fila.push({ em: Date.now(), ops, tocados: Array.isArray(tocados) ? tocados : [] });
    _gravar(userId, fila);
    return Math.min(fila.length, MAX_LOTES);
}

/** Lotes pendentes, do mais antigo para o mais novo. */
export function pendentes(userId) { return _ler(userId); }

/** Quantos lotes esperam. Zero = nada a reenviar. */
export function quantos(userId) { return _ler(userId).length; }

/** Esvazia — chamado quando o reenvio dá certo, e no logout. */
export function limpar(userId) { _gravar(userId, []); }

/**
 * Reenvia os lotes pendentes, do mais antigo para o mais novo.
 *
 * A ORDEM É PARTE DA CORREÇÃO: um `add` seguido de um `rm` do mesmo registro,
 * aplicados ao contrário, deixariam o registro vivo. Por isso não há paralelismo
 * aqui — um lote por vez, na ordem em que aconteceram.
 *
 * Um lote que falha PARA a drenagem e permanece na fila com os seguintes: pular
 * para o próximo quebraria a ordem.
 *
 * @param {string} userId
 * @param {(lote: object) => Promise<boolean>} enviar  devolve true se o servidor aceitou
 * @returns {Promise<{enviados:number, restantes:number}>}
 */
export async function drenar(userId, enviar) {
    const fila = _ler(userId);
    let enviados = 0;
    for (const lote of fila) {
        let ok = false;
        try { ok = await enviar(lote) === true; } catch { ok = false; }
        if (!ok) break;
        enviados++;
    }
    const restantes = fila.slice(enviados);
    _gravar(userId, restantes);
    return { enviados, restantes: restantes.length };
}

/** Espera antes da tentativa `n` (0-based). Cresce até 5 minutos e para de crescer. */
export function recuoMs(n) {
    return RECUO_MS[Math.min(Math.max(0, n | 0), RECUO_MS.length - 1)];
}
