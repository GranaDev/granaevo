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

import { PALAVRAS_NUMERO } from './money.js';

const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// ── Valor escrito por EXTENSO ───────────────────────────────────────────────
// A regex de valor só via dígitos, então "gastei quarenta reais no jogo" gravava
// "Quarenta reais no jogo": o valor aparecia duas vezes na tela do usuário, uma
// no campo de valor e outra dentro do nome da transação.
//
// A lista vem do money.js — é a MESMA que decide quanto vale a frase. Duas
// listas divergiriam, e foi exatamente assim que "Jogos" sumiu do prompt da IA.
//
// Aplicada sobre o texto SEM acento (o `norm` já rodou), porque é assim que o
// parseExtenso lê. Só remove quando a palavra está isolada.
const RE_EXTENSO = new RegExp(`\\b(?:${PALAVRAS_NUMERO.join('|')})\\b`, 'gi');

// A palavra de moeda sozinha, que sobra quando o número saiu. `RE_VALOR` só a
// remove grudada num dígito ("40 reais"); com o valor por extenso o que restava
// era "Reais no jogo" e "Conto no jogo". Moeda nunca descreve uma compra.
const RE_MOEDA_SOLTA = /\b(reais?|real|pila[s]?|conto[s]?|mango[s]?|pau[s]?)\b/gi;

// ── Sujeira que nunca é descrição ───────────────────────────────────────────
// NÃO é a defesa de segurança — essa é o schema travado da IA (nada de texto
// livre) e o `textContent` da UI (nada de HTML). Isto é higiene do extrato: o
// usuário não pode abrir a lista de gastos e encontrar "DROP TABLE" ou
// "<script>" como nome de uma compra que ele fez.
//
// Medido em 2026-08-09: "gastei 40 no jogo; DROP TABLE transactions" gravava
// a descrição "Jogo; DROP TABLE transactions".
const RE_MARCACAO = /<[^>]*>?/g;                                    // tag, aberta ou não
const RE_SQL      = /[;,]?\s*\b(drop|delete|insert|update|select|alter|truncate|union)\b[\s\S]*/gi;
const RE_INSTRUCAO = /\b(ignore|ignora|esquec[ae]|desconsidere)\b[\s\S]*|(?:mostre|revele|exiba|diga)\s+(?:seu|o)\s+(?:prompt|system|instru\w*)[\s\S]*|\bsystem\s*:[\s\S]*/gi;

// ── Ruído estrutural ────────────────────────────────────────────────────────
// Valor + moeda coloquial. Casa "R$ 1.234,56", "75,69", "40 pila", "1,5k", "2 mil".
const RE_VALOR = /(?:r\$\s*)?\b\d[\d.,]*\s*(?:k\b|mil\b|reais?\b|real\b|pila[s]?\b|conto[s]?\b|mango[s]?\b|pau[s]?\b)?/gi;

// Verbos de lançamento e de correção. Note `gastos?` e `gasto[s]` — a fronteira
// \b no fim de "gasto" NÃO casa o plural "gastos" (cai no meio da palavra); foi
// exatamente isso que fez "75,69 gastos ..." não ser reconhecido como saída.
const RE_VERBO = /\b(gastei|gastos?|gastar|paguei|pagar|usei|usar|comprei|comprar|torrei|desembolsei|queimei|estourei|fritei|meti|mandei|mandar|saiu|debitei|recebi|receber|ganhei|ganhar|caiu|entrou|pingou|faturei|embolsei|guardei|guardar|reservei|poupei|juntei|separei|aportei|economizei|tirei|retirei|retirada|saquei|resgatei|resgate|puxei|assinei|transferi|transferir|enviei|enviar|passei|depositei|foi|foram|era|de novo)\b/gi;

// Marcadores de tempo — nunca são descrição.
const RE_DATA = /\b(hoje|ontem|anteontem|amanha|amanhã|agora|de manha|de manhã|de tarde|de noite|a tarde|à tarde|a noite|à noite|dia \d{1,2}|semana passada|semana retrasada|mes passado|mês passado|no mes passado|essa semana|esta semana|\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)\b/gi;

// Forma de pagamento: "no cartão", "com pix", "no débito". É COMO pagou, não O QUE
// comprou. Precisa sair antes da regra do "com" — senão "paguei 30 com pix" viraria
// uma descrição "Pix".
const RE_PGTO = /\b(com|no|na|em|via|por|pelo|pela)\s+(o\s+|a\s+|meu\s+|minha\s+)?(cartao|cartão|credito|crédito|debito|débito|pix|dinheiro|especie|espécie|boleto|vale|vr\b|va\b|nubank|inter|c6|itau|itaú|bradesco|santander|caixa)\b/gi;

// Parcelas: "em 3x", "3x".
const RE_PARCELA = /\b(em\s+)?\d{1,3}\s*x\b/gi;

// Pronomes que apontam para algo dito ANTES — nunca descrevem nada sozinhos.
//
// Medido em 2026-08-07 com o corpus real do dono: "e gastei ele no mercado"
// gravava a descrição **"Ele no Mercado"**, e "gastei 30 nisso" gravava
// **"Nisso"**. No extrato do fim do mês isso é pior que rótulo repetido — é
// ruído que não diz nada nem para quem escreveu.
//
// Sai como RUÍDO, não como aparo de borda: em "usei isso pra pagar o boleto" o
// pronome está no MEIO, e a limpeza de bordas nunca o alcançaria (o resultado
// era "Usei isso o boleto").
//
// Conservador de propósito: só as formas que não carregam informação. "dele"/
// "dela" ficam de fora — "presente dela" é uma descrição legítima.
const RE_PRONOME = /\b(ele|ela|eles|elas|isso|isto|aquilo|nisso|nisto|naquilo|nele|nela|neles|nelas|disso|disto|daquilo|o\s+mesmo|a\s+mesma)\b/gi;

// Preposições/artigos que não podem abrir nem fechar uma descrição.
const STOP_EDGE = new Set([
    'de', 'do', 'da', 'das', 'dos', 'na', 'no', 'nas', 'nos', 'em', 'pra', 'para', 'pro', 'pros',
    'com', 'por', 'pelo', 'pela', 'o', 'a', 'os', 'as', 'um', 'uma', 'uns', 'umas',
    // Contrações de em+um. Faltavam, e o resultado aparecia no extrato do
    // usuário: "gastei 50 num paflon" gravava a descrição **"Num paflon"**.
    // Relatado em 2026-08-04. "em uma tomada" já saía limpo ("Tomada") porque
    // ali são duas palavras, e as duas estavam na lista — a contração não.
    'num', 'numa', 'nuns', 'numas', 'dum', 'duma', 'duns', 'dumas',
    'meu', 'minha', 'meus', 'minhas', 'e', 'que', 'foi', 'ai', 'ali', 'aqui', 'la', 'mais',
    'menos', 'so', 'tudo', 'ja', 'aí', 'lá', 'já', 'só',
]);

// Preposições que sobram ÓRFÃS quando o valor é removido do meio da frase:
// "fone de ouvido |por| |120| na amazon" → "... ouvido por na amazon".
const PREP = new Set(['de', 'do', 'da', 'na', 'no', 'em', 'pra', 'para', 'pro', 'com', 'por', 'a', 'o', 'pelo', 'pela', 'num', 'numa', 'dum', 'duma']);

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

// Tira só o ruído estrutural, preservando TODO o resto (inclusive a loja).
// Ordem importa: parcela e forma de pagamento ANTES do valor — ambas contêm
// números/preposições que a regex de valor comeria pela metade.
function limparRuido(rawText) {
    return String(rawText ?? '')
        // Sujeira PRIMEIRO: uma tag pode conter dígito (`alert(1)`) e a regex de
        // valor comeria o miolo dela, deixando "<script>alert( )</script>".
        .replace(RE_MARCACAO, ' ')
        .replace(RE_SQL, ' ')
        .replace(RE_INSTRUCAO, ' ')
        .replace(RE_PARCELA, ' ')
        .replace(RE_PGTO, ' ')
        .replace(RE_VALOR, ' ')
        .replace(RE_EXTENSO, ' ')
        .replace(RE_MOEDA_SOLTA, ' ')
        .replace(RE_VERBO, ' ')
        .replace(RE_PRONOME, ' ')
        .replace(RE_DATA, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

/**
 * Corta a frase na fronteira entre DUAS ORAÇÕES de lançamento.
 *
 * "Retirei 50 da reserva de emergência E GASTEI num jogo" são dois eventos, e a
 * descrição saía costurada: **"Reserva de emergencia e num jogo"** — origem
 * grudada em destino, sem sentido em nenhum dos dois lançamentos.
 *
 * O corte é feito ANTES de remover os verbos, porque é o segundo verbo que
 * revela a fronteira; depois da limpeza ela some e sobra só um " e " inocente.
 *
 * @param {'primeira'|'ultima'} qual  qual oração interessa a quem perguntou
 */
function recortarOracao(rawText, qual) {
    const t = String(rawText ?? '');
    // " e " (ou vírgula) seguido, em até 3 palavras, de outro verbo de lançamento.
    const re = /\s(?:,|e|entao|então|dai|daí|depois)\s+(?=(?:\w+\s+){0,2}?(?:gastei|gasto|gastos|paguei|comprei|torrei|usei|meti|mandei|guardei|reservei|poupei|juntei|separei|recebi|ganhei|tirei|retirei|saquei|resgatei)\b)/i;
    const m = t.match(re);
    if (!m || m.index == null) return t;
    return qual === 'ultima' ? t.slice(m.index + m[0].length) : t.slice(0, m.index);
}

/**
 * Extrai a descrição real de uma frase de lançamento.
 *
 * @param   {string} rawText  a mensagem crua do usuário
 * @returns {{descricao: string|null, fonte: 'com'|'resto'|'nenhuma'}}
 *          descricao=null → nada sobrou além de valor/verbo; o chamador deve
 *          cair no rótulo do tipo (comportamento antigo, ainda correto p/
 *          "gastei 50" ou "guardei 200").
 */
export function extractDescricao(rawText, opcoes) {
    // Por padrão descreve a PRIMEIRA oração. Numa frase com dois lançamentos, é
    // ela o evento principal — o segundo tem quem o descreva (o
    // parseRetiradaComUso já extrai o `uso` do próprio trecho de destino, e o
    // splitCompound já separa "gastei X e paguei Y" em dois comandos).
    // `oracao: 'ultima'` fica disponível para quem precisar do outro lado.
    const s = limparRuido(recortarOracao(rawText, opcoes?.oracao ?? 'primeira'));
    if (!s) return { descricao: null, fonte: 'nenhuma' };

    // Cláusula "com <item>" — o sinal mais forte que existe. O comerciante já
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
