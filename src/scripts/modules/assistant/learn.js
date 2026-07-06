// learn.js — aprendizado de comerciantes (B12)
// ---------------------------------------------------------------------------
// Quando a IA resolve um estabelecimento que o parser local não conhecia
// (ex.: "gastei 30 na Kalunga"), guardamos localmente o mapa termo→{categoria,
// tipo}. Da 2ª vez em diante o parser resolve SOZINHO — zero token pra sempre.
// Espelha o espírito do _autoCatComAprendizado do dashboard, mas isolado e
// device-local (nada vai pro servidor; nenhum VALOR é guardado aqui, só rótulos).
//
// Fonte da verdade = Map em memória (testável em Node). Persistência oportunista
// em localStorage, guardada por try/catch. Limpo no logout / opt-out de histórico.
// ---------------------------------------------------------------------------

const MAX = 80;               // teto de termos aprendidos (LRU por recência)
const KEY = 'ge_learn_merchants';
let _map = null;

function _norm(s) {
    return String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

function _load() {
    if (_map) return _map;
    _map = new Map();
    try {
        const raw = JSON.parse(localStorage.getItem(KEY) || '[]');
        if (Array.isArray(raw)) {
            for (const pair of raw) {
                if (Array.isArray(pair) && typeof pair[0] === 'string' && pair[1] && typeof pair[1] === 'object') {
                    _map.set(pair[0], { categoria: pair[1].categoria, tipo: pair[1].tipo, descricao: pair[1].descricao });
                }
            }
        }
    } catch { /* sem localStorage (ou corrompido) → começa vazio */ }
    return _map;
}

function _save() {
    try { localStorage.setItem(KEY, JSON.stringify([..._map.entries()].slice(-MAX))); } catch { /* ignore */ }
}

// Palavras que NUNCA são comerciante (preposições, verbos de lançamento, moeda).
const STOP = new Set([
    'de', 'do', 'da', 'na', 'no', 'em', 'pra', 'para', 'com', 'o', 'a', 'os', 'as', 'um', 'uma',
    'meu', 'minha', 'pro', 'hoje', 'ontem', 'reais', 'real', 'pila', 'conto', 'r', 'que', 'foi',
    'gastei', 'paguei', 'comprei', 'recebi', 'ganhei', 'guardei', 'reservei', 'poupei', 'juntei',
    'gasto', 'torrei', 'caiu', 'entrou', 'saquei', 'tirei', 'resgatei', 'assinei', 'mais', 'menos',
]);

/**
 * Extrai o termo-comerciante candidato do texto: a palavra após uma preposição
 * (na/no/em/da/do/de/pra/para/com); se não houver, o token significativo mais
 * longo. Números e cifrões são removidos antes. Retorna null se nada servir.
 */
export function merchantKey(text) {
    const t = _norm(text).replace(/r\$\s*/g, ' ').replace(/\d[\d.,]*\s*(k|mil)?\b/g, ' ');
    const m = t.match(/\b(?:na|no|em|da|do|de|pra|para|com)\s+([a-z][a-z]{2,20})/);
    let cand = m ? m[1] : null;
    if (!cand) {
        const toks = t.split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w));
        cand = toks.sort((x, y) => y.length - x.length)[0] || null;
    }
    return cand && !STOP.has(cand) ? cand : null;
}

/** Consulta o aprendizado para um texto. Retorna {categoria,tipo,descricao} ou null. */
export function applyLearned(text) {
    const key = merchantKey(text);
    if (!key) return null;
    const hit = _load().get(key);
    return hit && hit.categoria && hit.tipo ? { categoria: hit.categoria, tipo: hit.tipo, descricao: hit.descricao || hit.tipo } : null;
}

/**
 * Aprende com um lançamento que a IA resolveu (chamar SÓ quando o parser local
 * não sabia — senão é redundante). Guarda termo→{categoria,tipo,descricao}.
 */
export function learnMerchant(text, categoria, tipo, descricao) {
    if (!categoria || !tipo) return;
    const key = merchantKey(text);
    if (!key) return;
    const map = _load();
    map.delete(key);                 // move-to-end (recência p/ LRU)
    map.set(key, { categoria, tipo, descricao: descricao || tipo });
    while (map.size > MAX) map.delete(map.keys().next().value);
    _save();
}

/** Limpa tudo (logout / opt-out de histórico). */
export function clearLearned() {
    _map = new Map();
    try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}
