// parser-local.js — parser determinístico (regex + palavras-chave)
// ---------------------------------------------------------------------------
// PRIMEIRA camada do funil. Resolve a maioria das mensagens SEM gastar token de
// IA. Devolve um objeto com a MESMA forma do parse da IA (+ `source:'local'` e
// `confianca`). Se a confiança for baixa, o engine cai para a IA como fallback.
// Não grava nada; não vê nada além do texto.
// ---------------------------------------------------------------------------

import { parseValorBR, parseParcelas } from './money.js';

// Tipos permitidos no app (espelham db-transacoes.js).
export const TIPOS_SAIDA = ['Mercado', 'Farmácia', 'Eletrônico', 'Roupas', 'Assinaturas', 'Beleza',
    'Presente', 'Conta fixa', 'Cartão', 'Academia', 'Lazer', 'Transporte', 'Shopee', 'Mercado Livre',
    'Ifood', 'Amazon', 'Outros'];
export const TIPOS_ENTRADA = ['Salário', 'Renda Extra', 'Outros Recebimentos'];

// Normaliza: minúsculas, sem acento — para casar palavras-chave de forma robusta.
function norm(s) {
    return String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// ── Verbos → categoria (ordem importa: específicos antes de genéricos) ───────
const VERBOS = [
    { cat: 'retirada_reserva', re: /\b(tirei|resgatei|retirei|saquei|resgate|retirada)\b.*\breserv/ },
    { cat: 'retirada_reserva', re: /\bda reserva\b.*\b(tirei|resgatei|retirei|saquei)/ },
    { cat: 'reserva',          re: /\b(guardei|reservei|poupei|juntei|separei|aportei|guardar|poupar|reservar)\b/ },
    { cat: 'assinatura',       re: /\b(assinatura|assinei|mensalidade|plano mensal)\b/ },
    { cat: 'saida_credito',    re: /\b(no credito|no cartao|parcelad|parcelei|em \d+x|\d+x de)\b/ },
    { cat: 'entrada',          re: /\b(recebi|ganhei|caiu|entrou|recebimento|salario|me pagaram|pagaram|ganho|recebe?r|pix de|deposit)\b/ },
    { cat: 'saida',            re: /\b(gastei|paguei|comprei|gasto|saiu|torrei|gastar|comprar|pagar|paguei|debit)\b/ },
];

// ── Palavras-chave → {categoria, tipo} ──────────────────────────────────────
// Curado para o dia-a-dia BR. Mapeia sempre para um tipo PERMITIDO.
const KEYWORDS = [
    // Saída
    [/\b(mercado livre|meli)\b/, 'saida', 'Mercado Livre'],
    [/\b(supermercado|mercado|atacad|carrefour|hortifruti|sacolao|feira|assai|makro)\b/, 'saida', 'Mercado'],
    [/\b(farmacia|remedio|drogaria|drogasil|pacheco)\b/, 'saida', 'Farmácia'],
    [/\b(uber|99|onibus|metro|gasolina|combustivel|transporte|passagem|corrida|bilhete)\b/, 'saida', 'Transporte'],
    [/\b(ifood|delivery)\b/, 'saida', 'Ifood'],
    [/\b(shopee)\b/, 'saida', 'Shopee'],
    [/\b(amazon)\b/, 'saida', 'Amazon'],
    [/\b(academia|gym|crossfit|personal)\b/, 'saida', 'Academia'],
    [/\b(cinema|show|bar|balada|lazer|passeio|viagem|netflix|spotify|jogo|game)\b/, 'saida', 'Lazer'],
    [/\b(roupa|calca|camisa|tenis|sapato|vestido|zara|renner|riachuelo)\b/, 'saida', 'Roupas'],
    [/\b(celular|notebook|eletronico|fone|tv|monitor|carregador)\b/, 'saida', 'Eletrônico'],
    [/\b(salao|cabelo|beleza|manicure|barbearia|maquiagem)\b/, 'saida', 'Beleza'],
    [/\b(presente|gift)\b/, 'saida', 'Presente'],
    [/\b(luz|agua|energia|internet|aluguel|condominio|conta de|fatura|boleto)\b/, 'saida', 'Conta fixa'],
    // Entrada
    [/\b(salario|salário)\b/, 'entrada', 'Salário'],
    [/\b(freela|bico|extra|renda extra|venda|comissao)\b/, 'entrada', 'Renda Extra'],
];

// ── Saudações / ajuda / consulta / relatório ─────────────────────────────────
// (texto já vem normalizado: minúsculo e sem acento)
const RE_SAUDACAO  = /^(oi+|ola|opa|e ?ai|eae|eai|opa|salve|fala|coe|hey|help|bom dia|boa tarde|boa noite|blz|beleza|tudo (bem|bom|certo))\b/;
const RE_AJUDA     = /\b(ajuda|me ajuda|como funciona|como (usa|uso|te uso)|o que (voce|vc|da pra) (faz|fazer)|que comandos|comandos|nao sei usar|tutorial|dicas)\b/;
const RE_RELATORIO = /\b(relatorio|resumo|balanco|extrato|fechamento do mes|panorama|visao geral|como (estou|esta|ta|andam|estao) (as )?(minhas )?(financas|contas|grana)|minha situacao financeira)\b/;
const RE_CONSULTA  = /\b(quanto|quantos|qual|quais|total de|gastei com|tenho|quanto sobrou|quanto (ja )?(gastei|recebi)|meu saldo|minhas reservas|me mostra|mostra|como (esta|estao|esta|estao))\b/;
const RE_PROJECAO  = /\b(quanto tempo|em quanto tempo|se eu (investir|guardar|aportar|poupar)|vou levar|leva pra|daqui quanto|falta quanto pra)\b/;

// Ranking de gastos / "gráficos" → breakdown por categoria (texto)
// Sem \b no fim: "gastei" tem letra após "gast" (fronteira ficaria no meio da palavra).
const RE_GRAFICOS  = /\b(graficos?|onde (eu )?(mais )?gast|no que (eu )?(mais )?gast|em que (eu )?(mais )?gast|maior(es)? gasto|categoria que mais|onde (foi|vai|ta|esta) (o )?meu dinheiro|resumo por categoria|distribuicao (de|dos) gasto)/;
// Listar últimos lançamentos
const RE_LISTAR    = /\b(ultimas? (transac|lancament|movimenta|compra|entrada)|minhas? (transac|movimenta|ultimas)|meus? (lancament|ultimos)|o que (eu )?(lancei|gastei|registrei|paguei) hoje|extrato de hoje|lista(r)? (as )?(transac|lancament|gasto))/;
// Comparação / média / fatura / quanto falta
const RE_COMPARAR  = /\b(comparad|comparacao|gastei (muito )?mais que|gastei (muito )?menos que|mais (ou menos )?que (o )?mes passado|em rela(c|ç)ao ao mes|(vs|versus) (o )?mes|comparar com)/;
const RE_MEDIA     = /\b(media de gasto|gasto medio|em media (eu )?gast|quanto (eu )?gasto por mes|por mes em media|minha media)/;
const RE_FATURA    = /\b(minha fatura|ver (a )?fatura|fatura (do|da|em aberto|atual|deste mes|desse mes)|quanto (eu )?(vou|tenho que|preciso) pagar (de|da|do)? ?(fatura|cartao)|como (esta|ta) (a |minha )?fatura)/;
const RE_FALTA     = /\b(quanto (ainda )?falta|falta quanto|quanto (eu )?preciso (guardar|juntar)) (pra|para|pro)/;
// Desfazer por texto
const RE_DESFAZER  = /\b(desfaz|desfazer|desfa[cç]a|apaga(r)? (o |a )?ultim|cancela(r)? (isso|o ultimo|a ultima|essa|esse)|errei|foi errado|nao (era|foi) isso|remove(r)? (o )?ultim|apaga isso|cancela isso|volta atras)/;

// ── Período ──────────────────────────────────────────────────────────────────
export function detectPeriodo(t) {
    if (/\bhoje\b/.test(t)) return 'hoje';
    if (/\b(essa|esta) semana\b/.test(t)) return 'semana';
    if (/\bmes passado\b/.test(t)) return 'mes_passado';
    if (/\b(esse|este) ano|no ano\b/.test(t)) return 'ano';
    if (/\b(tudo|geral|total|sempre|desde o inicio)\b/.test(t)) return 'tudo';
    if (/\b(esse|este) mes|no mes|do mes\b/.test(t)) return 'mes';
    return null; // engine assume 'mes' por padrão em consultas
}

// Alvo da consulta: saldo, entradas, reservas, maior_gasto ou gastos.
function detectConsultaAlvo(t) {
    if (/\bsaldo\b/.test(t) || /quanto (eu )?(tenho|sobrou)/.test(t)) return 'saldo';
    if (RE_GRAFICOS.test(t)) return 'maior_gasto';
    if (/\breserv/.test(t)) return 'reserva';
    if (/\b(ganhei|recebi|recebo|entrou|entrada|entradas|salario|renda|faturei|fatur)\b/.test(t)) return 'entrada';
    return 'gasto';
}

// Verbos de lançamento — usados para dividir mensagens compostas.
const RE_VERBO_LANC = /\b(gastei|paguei|comprei|gasto|torrei|recebi|ganhei|caiu|entrou|guardei|reservei|poupei|juntei|separei|aportei|tirei|resgatei|saquei|assinei)\b/;

/**
 * Divide uma mensagem composta em cláusulas independentes de lançamento.
 * Só divide quando há ≥2 segmentos que CONTÊM valor — evita quebrar
 * "mercado e farmácia" (2º sem valor) mas quebra "gastei 300 no mercado,
 * mas ganhei 120 do pai". Conservador por design.
 * @returns {string[]} segmentos (ou [texto] se não for composto).
 */
export function splitCompound(rawText) {
    const text = String(rawText ?? '');
    // Separa por: vírgula, ponto-e-vírgula, "mas/porém/também", e " e " SÓ quando
    // seguido de um verbo de lançamento (não quebra "pão e leite").
    // Vírgula separa cláusula SÓ quando não é decimal (ex.: "28,06" não quebra;
    // "mercado, comprei" e "300, ganhei" quebram).
    const parts = text.split(/(?<!\d),\s*|,\s*(?!\d)|\s*;\s*|\s+mas\s+|\s+por[ée]m\s+|\s+tamb[ée]m\s+|\s+e\s+(?=(?:gastei|paguei|comprei|recebi|ganhei|caiu|entrou|guardei|reservei|poupei|juntei|separei|tirei|resgatei|saquei|assinei)\b)/i);
    const comValor = parts.map((s) => s.trim()).filter((s) => s && parseValorBR(s) !== null);
    return comValor.length >= 2 ? comValor : [text];
}

// Detecta uma pergunta de follow-up ("e no mês passado?", "e transporte?").
// Só conta como follow-up se for um MODIFICADOR curto (período/termo) e NÃO
// contiver por si só um gatilho de intenção (aí é uma pergunta nova).
export function parseFollowup(rawText) {
    const t = norm(rawText);
    const temIntent = /\b(quanto|qual|quais|onde|gastei|paguei|comprei|recebi|ganhei|guardei|tirei|saquei|assinei|graficos|fatura|media|saldo|relatorio|resumo|reserva|meta)\b/.test(t);
    if (temIntent) return { isFollowup: false };
    const per = detectPeriodo(t);
    const kws = extractPalavrasChave(t);
    const startsE = /^(e|entao|agora)\b/.test(t);
    const nWords = t.split(/\s+/).length;
    const curto = t.length <= 28 && nWords <= 5;
    const isFollowup = curto && (!!per || kws.length > 0) && (startsE || nWords <= 3);
    return { isFollowup, periodo: per, palavrasChave: kws };
}

// Palavras-chave para consultas (casa contra descrição/tipo/categoria depois).
export function extractPalavrasChave(t) {
    const out = [];
    for (const [re, , tipo] of KEYWORDS) {
        if (re.test(t)) out.push(tipo.toLowerCase());
    }
    // Termos soltos úteis
    for (const w of ['mercado', 'transporte', 'uber', 'ifood', 'lazer', 'farmacia', 'salario', 'reserva']) {
        if (t.includes(w) && !out.includes(w)) out.push(w);
    }
    return [...new Set(out)].slice(0, 6);
}

// Extrai nome de meta depois de "pra/para/pro" (para "quanto falta pra X").
function _extractMetaHint(t) {
    const m = t.match(/(?:pra|para|pro)\s+(?:a |o |minha |meu )?([\p{L}][\p{L}\s]{1,29})/u);
    return m ? m[1].trim() : null;
}
// Extrai nome do cartão depois de "cartao/fatura do/da".
function _extractCartaoHint(t) {
    const m = t.match(/(?:cartao|fatura)\s+(?:do |da |no |de )?([\p{L}][\p{L}\s]{1,29})/u);
    if (!m) return null;
    const h = m[1].trim();
    return /^(em aberto|atual|deste mes|desse mes)/.test(h) ? null : h;
}

/**
 * Parser local. Sempre retorna um objeto (nunca lança).
 * confianca alta (≥0.7) → engine confia; baixa → engine chama a IA.
 */
export function parseLocal(rawText) {
    const text = norm(rawText);
    const base = {
        intencao: 'desconhecido', categoria: null, valor: null, tipo: null, descricao: null,
        meta_hint: null, parcelas: null, cartao_hint: null, aporte_mensal: null,
        periodo: null, palavras_chave: [], consulta_alvo: null, confianca: 0, source: 'local',
    };
    if (!text) return base;

    // 1) Saudação / ajuda / desfazer (curtas, alta confiança)
    if (RE_SAUDACAO.test(text) && text.length <= 25) return { ...base, intencao: 'saudacao', confianca: 0.97 };
    if (RE_AJUDA.test(text)) return { ...base, intencao: 'ajuda', confianca: 0.9 };
    if (RE_DESFAZER.test(text)) return { ...base, intencao: 'desfazer', confianca: 0.9 };

    // 2) Projeção de meta ("se eu guardar X por mês…")
    if (RE_PROJECAO.test(text)) {
        return { ...base, intencao: 'projecao_meta', aporte_mensal: parseValorBR(text), palavras_chave: extractPalavrasChave(text), confianca: 0.6 };
    }

    // 2b) Comparação / média / fatura / quanto falta
    if (RE_COMPARAR.test(text)) return { ...base, intencao: 'consultar', consulta_alvo: 'comparar', confianca: 0.82 };
    if (RE_MEDIA.test(text))    return { ...base, intencao: 'consultar', consulta_alvo: 'media', confianca: 0.82 };
    if (RE_FALTA.test(text))    return { ...base, intencao: 'consultar', consulta_alvo: 'falta_meta', meta_hint: _extractMetaHint(text), confianca: 0.82 };
    if (RE_FATURA.test(text) && !/\b(gastei|paguei|comprei)\b.*\d/.test(text)) {
        return { ...base, intencao: 'consultar', consulta_alvo: 'fatura', cartao_hint: _extractCartaoHint(text), confianca: 0.82 };
    }

    // 3) Gráficos / "onde mais gastei" → ranking de gastos por categoria
    if (RE_GRAFICOS.test(text)) {
        return { ...base, intencao: 'consultar', consulta_alvo: 'maior_gasto',
                 periodo: detectPeriodo(text) || 'mes', palavras_chave: [], confianca: 0.85 };
    }

    // 3b) Listar últimos lançamentos
    if (RE_LISTAR.test(text)) {
        return { ...base, intencao: 'consultar', consulta_alvo: 'listar',
                 periodo: detectPeriodo(text) || 'mes', palavras_chave: [], confianca: 0.85 };
    }

    // 3c) Relatório
    if (RE_RELATORIO.test(text)) {
        return { ...base, intencao: 'relatorio', periodo: detectPeriodo(text) || 'mes', confianca: 0.85 };
    }

    const valor = parseValorBR(text);

    // 4) Consulta ("quanto gastei com mercado?") — sem intenção clara de lançar
    if (RE_CONSULTA.test(text) && !/\b(gastei|paguei|comprei)\b\s*(r\$\s*)?\d/.test(text)) {
        return {
            ...base, intencao: 'consultar',
            periodo: detectPeriodo(text) || 'mes',
            palavras_chave: extractPalavrasChave(text),
            consulta_alvo: detectConsultaAlvo(text),
            confianca: 0.8,
        };
    }

    // 5) Lançamento — precisa de categoria (verbo) para ser confiável
    let categoria = null;
    for (const v of VERBOS) { if (v.re.test(text)) { categoria = v.cat; break; } }

    // Sem verbo mas com valor e palavra-chave forte → assume saída (comportamento do app)
    let tipo = null, descricao = null;
    for (const [re, cat, tp] of KEYWORDS) {
        if (re.test(text)) { tipo = tp; if (!categoria) categoria = cat; descricao = tp; break; }
    }

    if (categoria && valor) {
        // Categorias que mexem em meta/cartão → engine faz handoff seguro (fase 2).
        // Aqui só reportamos o parse; o engine decide o roteamento.
        let conf = 0.7;
        if (tipo) conf = 0.9;
        // tipo padrão coerente por categoria
        if (!tipo) {
            if (categoria === 'entrada') { tipo = 'Outros Recebimentos'; descricao = descricao || 'Recebimento'; }
            else if (categoria === 'saida') { tipo = 'Outros'; descricao = descricao || 'Gasto'; }
        }
        // meta_hint: texto após "reserva do/da/para"
        let metaHint = null;
        const mm = text.match(/reserva (?:d[aeo]|para|pro|pra) ([\p{L}\s]{2,30})/u);
        if (mm) metaHint = mm[1].trim();

        return {
            ...base, intencao: 'lancar', categoria, valor, tipo,
            descricao: descricao || (tipo ?? null),
            meta_hint: metaHint, periodo: null,
            parcelas: categoria === 'saida_credito' ? parseParcelas(rawText) : null,
            palavras_chave: [], confianca: conf,
        };
    }

    // 5b) Crédito SEM valor: reconhece pra pedir o valor (sem gastar IA).
    //     O engine abre o picker de cartão/parcelas depois do valor.
    if (categoria === 'saida_credito') {
        return {
            ...base, intencao: 'lancar', categoria: 'saida_credito', valor: valor || null,
            descricao: descricao || 'Compra no crédito', tipo: tipo || 'Cartão',
            parcelas: parseParcelas(rawText), confianca: 0.75,
        };
    }

    // 6) Valor sozinho sem verbo/keyword, ou nada casou → baixa confiança (vai pra IA)
    if (valor) return { ...base, intencao: 'lancar', categoria: 'saida', valor, confianca: 0.4 };
    return base;
}
