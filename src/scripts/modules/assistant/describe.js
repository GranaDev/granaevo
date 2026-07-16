// describe.js — extrai a DESCRIÇÃO real da frase do usuário
// ---------------------------------------------------------------------------
// O buraco que este módulo tapa: até aqui o parser nunca leu o texto livre. A
// keyword casava ("shopee"), definia o tipo e ESCREVIA POR CIMA da descrição
// com o próprio rótulo (parser-local:423 → `descricao = tp`). Resultado: toda
// transação lançada pelo chat nascia com `descricao === tipo`, e "75,69 gastos
// na shopee com fita de led e tinta branca" virava uma linha escrita "Shopee".
// No fim do mês o extrato é uma coluna de rótulos repetidos — o oposto de
// "saiba para onde vai seu dinheiro".
//
// A INVERSÃO que isto corrige: no dashboard a descrição é a FONTE e a categoria
// é derivada dela (`_autoCatComAprendizado(descricao)`, db-transacoes.js:181).
// No chat a seta apontava ao contrário. Com a descrição de volta, o chat pode
// usar o MESMO cérebro do app (categorizacao.js) — ver engine.#sugerirDoHistorico.
//
// ESTRATÉGIA: não tentar "entender" a frase. Remover o que é ruído ESTRUTURAL
// (valor, verbo, data, parcela, forma de pagamento) e assumir que o que sobra
// É a descrição. Conservador: na dúvida devolve null e o chamador cai no rótulo
// (comportamento antigo) — nunca inventa texto.
//
// 100% local, puro, sem DOM/rede. Zero token de IA. Testes: tests/unit/assistente-descricao.test.js
// ---------------------------------------------------------------------------

const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// ── Ruído estrutural ────────────────────────────────────────────────────────
// Valor + moeda coloquial. Casa "R$ 1.234,56", "75,69", "40 pila", "1,5k", "2 mil".
const RE_VALOR = /(?:r\$\s*)?\b\d[\d.,]*\s*(?:k\b|mil\b|reais?\b|real\b|pila[s]?\b|conto[s]?\b|mango[s]?\b|pau[s]?\b)?/gi;

// Verbos de lançamento e de correção. Note `gastos?` e `gasto[s]` — a fronteira
// \b no fim de "gasto" NÃO casa o plural "gastos" (cai no meio da palavra); foi
// exatamente isso que fez "75,69 gastos ..." não ser reconhecido como saída.
const RE_VERBO = /\b(gastei|gastos?|gastar|paguei|pagar|comprei|comprar|torrei|desembolsei|queimei|estourei|fritei|meti|mandei|saiu|debitei|recebi|receber|ganhei|ganhar|caiu|entrou|pingou|faturei|embolsei|guardei|guardar|reservei|poupei|juntei|separei|aportei|economizei|tirei|retirei|retirada|saquei|resgatei|resgate|puxei|assinei|foi|foram|era|de novo)\b/gi;

// Marcadores de tempo — nunca são descrição.
const RE_DATA = /\b(hoje|ontem|anteontem|amanha|amanhã|agora|de manha|de manhã|de tarde|de noite|a tarde|à tarde|a noite|à noite|dia \d{1,2}|semana passada|semana retrasada|mes passado|mês passado|no mes passado|essa semana|esta semana|\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)\b/gi;

// Forma de pagamento: "no cartão", "com pix", "no débito". É COMO pagou, não O QUE
// comprou. Precisa sair antes da regra do "com" — senão "paguei 30 com pix" viraria
// uma descrição "Pix".
const RE_PGTO = /\b(com|no|na|em|via|por|pelo|pela)\s+(o\s+|a\s+|meu\s+|minha\s+)?(cartao|cartão|credito|crédito|debito|débito|pix|dinheiro|especie|espécie|boleto|vale|vr\b|va\b|nubank|inter|c6|itau|itaú|bradesco|santander|caixa)\b/gi;

// Parcelas: "em 3x", "3x".
const RE_PARCELA = /\b(em\s+)?\d{1,3}\s*x\b/gi;

// Preposições/artigos que não podem abrir nem fechar uma descrição.
const STOP_EDGE = new Set([
    'de', 'do', 'da', 'das', 'dos', 'na', 'no', 'nas', 'nos', 'em', 'pra', 'para', 'pro', 'pros',
    'com', 'por', 'pelo', 'pela', 'o', 'a', 'os', 'as', 'um', 'uma', 'uns', 'umas',
    'meu', 'minha', 'meus', 'minhas', 'e', 'que', 'foi', 'ai', 'ali', 'aqui', 'la', 'mais',
    'menos', 'so', 'tudo', 'ja', 'aí', 'lá', 'já', 'só',
]);

// Preposições que sobram ÓRFÃS quando o valor é removido do meio da frase:
// "fone de ouvido |por| |120| na amazon" → "... ouvido por na amazon".
const PREP = new Set(['de', 'do', 'da', 'na', 'no', 'em', 'pra', 'para', 'pro', 'com', 'por', 'a', 'o', 'pelo', 'pela']);

function limparBordas(s) {
    let toks = String(s).split(/\s+/).filter(Boolean);
    // Colapsa preposições consecutivas (resíduo da remoção de valor/verbo).
    toks = toks.filter((tk, i) => !(PREP.has(norm(tk)) && toks[i + 1] && PREP.has(norm(toks[i + 1]))));
    while (toks.length && STOP_EDGE.has(norm(toks[0]))) toks.shift();
    while (toks.length && STOP_EDGE.has(norm(toks[toks.length - 1]))) toks.pop();
    return toks.join(' ');
}

// Primeira letra maiúscula, resto como o usuário escreveu (não mexe em acento
// nem em nome próprio: "tenis nike" → "Tenis nike").
function capitalizar(s) {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

const MAX_DESC = 80; // descrição é rótulo, não redação. normalize.js reclampa em 120.

/**
 * Extrai a descrição real de uma frase de lançamento.
 *
 * @param   {string} rawText  a mensagem crua do usuário
 * @returns {{descricao: string|null, fonte: 'com'|'resto'|'nenhuma'}}
 *          descricao=null → nada sobrou além de valor/verbo; o chamador deve
 *          cair no rótulo do tipo (comportamento antigo, ainda correto p/
 *          "gastei 50" ou "guardei 200").
 */
// Tira só o ruído estrutural, preservando TODO o resto (inclusive a loja).
// Ordem importa: parcela e forma de pagamento ANTES do valor — ambas contêm
// números/preposições que a regex de valor comeria pela metade.
function limparRuido(rawText) {
    return String(rawText ?? '')
        .replace(RE_PARCELA, ' ')
        .replace(RE_PGTO, ' ')
        .replace(RE_VALOR, ' ')
        .replace(RE_VERBO, ' ')
        .replace(RE_DATA, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

export function extractDescricao(rawText) {
    const s = limparRuido(rawText);
    if (!s) return { descricao: null, fonte: 'nenhuma' };

    // 2) Cláusula "com <item>" — o sinal mais forte que existe. O comerciante já
    //    foi capturado no tipo pela keyword, então "na shopee com fita de led e
    //    tinta branca" entrega o item puro: exatamente o que o usuário quer ver
    //    no extrato. (Casos "com pix"/"com cartão" já saíram no passo 1.)
    const mCom = s.match(/\bcom\s+(.{2,80})$/i);
    if (mCom) {
        const item = limparBordas(mCom[1]);
        if (item.length >= 2) {
            return { descricao: capitalizar(item).slice(0, MAX_DESC), fonte: 'com' };
        }
    }

    // 3) Sem cláusula "com": o resto limpo JÁ É a descrição. O comerciante fica
    //    dentro dela de propósito — "Uber pro aeroporto" e "Gasolina no posto"
    //    são descrições melhores que "Uber" e "Gasolina" sozinhos.
    const resto = limparBordas(s);
    if (resto.length >= 2) {
        return { descricao: capitalizar(resto).slice(0, MAX_DESC), fonte: 'resto' };
    }

    // 4) Só havia valor e verbo ("gastei 50") → sem descrição. Chamador usa o tipo.
    return { descricao: null, fonte: 'nenhuma' };
}

/**
 * Texto para o MODELO APRENDIDO (categorizacao.js) — não para o humano.
 *
 * A diferença importa e custou um bug: `extractDescricao` corta a loja quando há
 * cláusula "com" ("na kalunga com um caderno" → "Caderno"), porque é isso que o
 * usuário quer LER no extrato. Só que a loja é o sinal MAIS FORTE pro
 * classificador: com "caderno" sozinho (1 ocorrência no histórico) ele não
 * atinge a evidência mínima e devolve null — e o chat ia gastar token com a IA
 * pra descobrir algo que o próprio histórico já sabia.
 *
 * Aqui devolvemos tudo que sobrou do ruído, loja inclusa ("kalunga com um
 * caderno"). O IDF do modelo já sabe descartar palavra vazia sozinho.
 * @returns {string|null}
 */
export function textoParaModelo(rawText) {
    return limparBordas(limparRuido(rawText)) || null;
}

/**
 * Quantas palavras de CONTEÚDO a frase tem além do ruído estrutural. Alimenta a
 * `completude` do parser (engine): intenção certa + conteúdo não lido = vale
 * perguntar pra IA. É o que destrava a IA nas mensagens ricas, que hoje ela
 * nunca vê porque a confiança local de 0.9 veta a chamada.
 * @returns {number}
 */
export function contarPalavrasConteudo(rawText) {
    const r = extractDescricao(rawText);
    if (!r.descricao) return 0;
    return r.descricao.split(/\s+/).filter((w) => !STOP_EDGE.has(norm(w))).length;
}
