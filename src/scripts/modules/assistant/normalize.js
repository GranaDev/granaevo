// normalize.js — parse (local OU IA) → comando canônico validado
// ---------------------------------------------------------------------------
// Ponto único onde os dois parsers convergem. Sanitiza tudo ANTES de tocar em
// dados: valor finito e positivo, tipo dentro da lista permitida, strings
// aparadas. Defesa em profundidade — mesmo que a IA "invente" um campo, aqui é
// domado antes de virar transação.
// ---------------------------------------------------------------------------

import { TIPOS_SAIDA, TIPOS_ENTRADA } from './parser-local.js';

const MAX_VALOR = 100_000_000; // R$ 100 mi — teto sanidade (evita overflow/typo absurdo)
const CATS_VALIDAS = ['entrada', 'saida', 'saida_credito', 'reserva', 'retirada_reserva', 'assinatura'];

function clampStr(s, max = 200) {
    return typeof s === 'string' ? s.trim().slice(0, max) : null;
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
        periodo: ['hoje', 'semana', 'mes', 'mes_passado', 'ano', 'tudo'].includes(parse.periodo) ? parse.periodo : null,
        palavrasChave: Array.isArray(parse.palavras_chave)
            ? parse.palavras_chave.filter((s) => typeof s === 'string').map((s) => s.toLowerCase().slice(0, 40)).slice(0, 8)
            : [],
        consultaAlvo: ['saldo', 'entrada', 'reserva', 'gasto', 'maior_gasto', 'listar'].includes(parse.consulta_alvo) ? parse.consulta_alvo : 'gasto',
    };

    const v = Number(parse.valor);
    if (Number.isFinite(v) && v > 0 && v <= MAX_VALOR) cmd.valor = Math.round(v * 100) / 100;

    const ap = Number(parse.aporte_mensal);
    if (Number.isFinite(ap) && ap > 0 && ap <= MAX_VALOR) cmd.aporteMensal = Math.round(ap * 100) / 100;

    if (cmd.intent === 'lancar' && cmd.categoria) {
        cmd.tipo = normalizeTipo(cmd.categoria, parse.tipo);
        if (!cmd.descricao) cmd.descricao = cmd.tipo;
    }

    return cmd;
}
