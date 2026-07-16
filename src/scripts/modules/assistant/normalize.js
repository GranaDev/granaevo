// normalize.js — parse (local OU IA) → comando canônico validado
// ---------------------------------------------------------------------------
// Ponto único onde os dois parsers convergem. Sanitiza tudo ANTES de tocar em
// dados: valor finito e positivo, tipo dentro da lista permitida, strings
// aparadas. Defesa em profundidade — mesmo que a IA "invente" um campo, aqui é
// domado antes de virar transação.
// ---------------------------------------------------------------------------

import { TIPOS_SAIDA, TIPOS_ENTRADA, ORCAMENTO_TIPOS } from './parser-local.js';

const MAX_VALOR = 100_000_000; // R$ 100 mi — teto sanidade (evita overflow/typo absurdo)
const CATS_VALIDAS = ['entrada', 'saida', 'saida_credito', 'reserva', 'retirada_reserva', 'assinatura'];
const PERIODOS_FIXOS = ['hoje', 'semana', 'mes', 'mes_passado', 'trimestre', 'ano', 'tudo'];

// Período válido: um dos fixos OU "mes:YYYY-MM" (mês nomeado — A3, só do parser local).
function normalizePeriodo(p) {
    if (PERIODOS_FIXOS.includes(p)) return p;
    if (typeof p === 'string' && /^mes:\d{4}-\d{2}$/.test(p)) return p;
    return null;
}

// Tokens de formatação do ui.js: `*negrito*` e o token de ícone de chaves
// duplas. A descrição deixou de ser um rótulo de lista fechada e passou a ser
// TEXTO LIVRE do usuário (describe.js) — e phrases.js interpola ela dentro dos
// templates, inclusive DENTRO de um `*...*` (offlineEnfileirado). Sem neutralizar:
//   • um "*" na descrição racha o pareamento do negrito e quebra a mensagem;
//   • um token de ícone digitado pelo usuário vira ícone na fala do assistente.
// NB: não escreva um token de ícone literal aqui — o scanner do build-fa-subset
// varre src/ como TEXTO e puxaria esse ícone pra dentro da fonte de produção.
// Não é XSS (ui.js só usa createTextNode/createElement e faIcon tem whitelist),
// mas num perfil casal/família a descrição de um membro é renderizada na tela
// do outro. Neutralizar aqui: ponto único onde local e IA convergem.
function stripTemplateTokens(s) {
    return s.replace(/\*/g, '').replace(/\{\{/g, '(').replace(/\}\}/g, ')');
}

function clampStr(s, max = 200) {
    if (typeof s !== 'string') return null;
    return stripTemplateTokens(s).trim().slice(0, max);
}

function normalizeTipo(categoria, tipo) {
    const lista = (categoria === 'entrada' || categoria === 'retirada_reserva') ? TIPOS_ENTRADA : TIPOS_SAIDA;
    if (typeof tipo === 'string' && tipo.trim()) {
        const alvo = tipo.trim().toLowerCase();
        const match = lista.find((t) => t.toLowerCase() === alvo);
        if (match) return match;
        // Match aproximado (contém)
        const aprox = lista.find((t) => t.toLowerCase().includes(alvo) || alvo.includes(t.toLowerCase()));
        if (aprox) return aprox;
    }
    // Padrão coerente por categoria
    if (categoria === 'entrada' || categoria === 'retirada_reserva') return 'Outros Recebimentos';
    if (categoria === 'reserva') return 'Reserva';
    return 'Outros';
}

/** Converte um parse cru (local/IA) em comando canônico seguro. */
export function toCommand(parse) {
    if (!parse || typeof parse !== 'object') {
        return { intent: 'desconhecido', confianca: 0, source: 'none' };
    }

    const intent = typeof parse.intencao === 'string' ? parse.intencao : 'desconhecido';
    const confianca = Number.isFinite(parse.confianca) ? Math.max(0, Math.min(1, parse.confianca)) : 0;
    const source = parse.source === 'ia' || parse.source === 'local' ? parse.source : 'ia';

    const cmd = {
        intent, confianca, source,
        categoria: CATS_VALIDAS.includes(parse.categoria) ? parse.categoria : null,
        valor: null,
        tipo: null,
        descricao: clampStr(parse.descricao, 120),
        metaHint: clampStr(parse.meta_hint, 60),
        parcelas: Number.isInteger(parse.parcelas) && parse.parcelas > 0 && parse.parcelas <= 420 ? parse.parcelas : null,
        cartaoHint: clampStr(parse.cartao_hint, 60),
        aporteMensal: null,
        periodo: normalizePeriodo(parse.periodo),
        palavrasChave: Array.isArray(parse.palavras_chave)
            ? parse.palavras_chave.filter((s) => typeof s === 'string').map((s) => s.toLowerCase().slice(0, 40)).slice(0, 8)
            : [],
        consultaAlvo: ['saldo', 'entrada', 'reserva', 'gasto', 'maior_gasto', 'listar', 'comparar', 'media', 'fatura', 'falta_meta', 'orcamento', 'assinaturas', 'narrativa', 'curiosidade', 'conquistas'].includes(parse.consulta_alvo) ? parse.consulta_alvo : 'gasto',
        dataOverride: typeof parse.data_override === 'string' && /^\d{2}\/\d{2}\/\d{4}$/.test(parse.data_override) ? parse.data_override : null,
        // pagar_conta / definir_orcamento / lembrete (locais ou via IA)
        contaHint: clampStr(parse.conta_hint, 60),
        lembreteTexto: clampStr(parse.lembrete_texto, 120),
        lembreteData: typeof parse.lembrete_data === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parse.lembrete_data) ? parse.lembrete_data : null,
    };

    const v = Number(parse.valor);
    if (Number.isFinite(v) && v > 0 && v <= MAX_VALOR) cmd.valor = Math.round(v * 100) / 100;

    const ap = Number(parse.aporte_mensal);
    if (Number.isFinite(ap) && ap > 0 && ap <= MAX_VALOR) cmd.aporteMensal = Math.round(ap * 100) / 100;

    if (cmd.intent === 'lancar' && cmd.categoria) {
        cmd.tipo = normalizeTipo(cmd.categoria, parse.tipo);
        if (!cmd.descricao) cmd.descricao = cmd.tipo;
    }

    // Orçamento: o tipo tem que estar na whitelist do dashboard (senão o
    // _sanitizarOrcamentos descartaria a chave no próximo save de lá).
    if (cmd.intent === 'definir_orcamento') {
        const alvo = String(parse.tipo ?? '').trim().toLowerCase();
        cmd.tipo = ORCAMENTO_TIPOS.find((t) => t.toLowerCase() === alvo) || null;
    }

    return cmd;
}
