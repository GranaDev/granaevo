// ----------------------------------------------------------------------------
// insights.js — proatividade e micro-lição do assistente (Passo 29)
//
// O QUE FALTAVA (o resto do Passo 29 já existia):
//   ✔ memória de sessão cifrada — já feita (assistente.js: AES-GCM + IndexedDB)
//   ✔ proatividade de abertura   — já rica (engine.aberturaInsights: fatura
//     vencendo, resumo do dia, salário, fim de mês, metas paradas…)
//   ✘ detector de assinatura no CHAT — o motor existia (modules/recorrencias.js)
//     mas só era usado pela tela; o chat só respondia se PERGUNTASSEM
//   ✘ micro-lição comparativa — "32% em delivery, sua média é 12%"
// Este módulo fecha os dois que faltavam.
//
// ── A REGRA DE OURO NÃO É QUEBRADA ──────────────────────────────────────────
// "IA como função": o Haiku só interpreta texto; NUNCA vê valores nem escreve
// resposta. Tudo aqui é derivado NO CLIENTE, a partir das transações que já
// estão na memória, e vira frase pelo nosso próprio código. Nenhum número deste
// arquivo chega perto de uma chamada de rede.
//
// ── POR QUE COMPARAR COM A PRÓPRIA PESSOA ───────────────────────────────────
// "Você gastou R$ 400 em delivery" é um dado; não diz se é muito. "32% do seu
// mês, sendo que sua média é 12%" é um julgamento que a própria história da
// pessoa sustenta — sem comparar com estranho nenhum e sem meta arbitrária.
// Por isso a base é sempre a média DELA nos meses fechados.
//
// 100% puro: sem DOM, sem rede, `hoje` injetável.
// ----------------------------------------------------------------------------

import { detectarAssinaturasEsquecidas } from '../recorrencias.js?v=1';

/** Desvio mínimo (em pontos percentuais) para valer uma micro-lição. */
const DESVIO_MIN_PP = 8;

/** Gasto mínimo no mês p/ o alerta não disparar com trocado. */
const GASTO_MIN = 80;

const _num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

function _ym(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }

/** 'DD/MM/AAAA' ou ISO → Date (meia-noite local), ou null. */
function _data(s) {
    if (typeof s !== 'string') return null;
    let m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(s);
    if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
    m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
    return null;
}

const _ehSaida = (t) => t && (t.categoria === 'saida' || t.categoria === 'saida_credito');

/**
 * Micro-lição: em que a pessoa está fora do PRÓPRIO padrão neste mês.
 *
 * Compara a fatia (%) de cada tipo no mês corrente com a fatia média dela nos
 * meses FECHADOS. O mês corrente entra só como numerador — nunca na média, que
 * ficaria contaminada pelo mês parcial (o mesmo cuidado de `mediaMensal`).
 *
 * Exige ao menos 2 meses fechados: com 1 só, "média" é uma amostra, e acusar
 * alguém de fugir do padrão com base em um mês é chute com cara de dado.
 *
 * @returns {{ tipo, pctAtual, pctMedia, gastoAtual, meses }|null}
 *   null quando não há desvio digno de nota — resposta legítima e comum.
 */
export function microLicao(transacoes, hoje = new Date()) {
    if (!Array.isArray(transacoes) || transacoes.length === 0) return null;
    const ymAtual = _ym(hoje);

    const mesAtual = new Map();   // tipo → total no mês corrente
    const fechados = new Map();   // ym → Map(tipo → total)
    let totalAtual = 0;

    for (const t of transacoes) {
        if (!_ehSaida(t)) continue;
        const d = _data(t.data);
        if (!d) continue;
        const v = Math.abs(_num(t.valor));
        if (v <= 0) continue;
        const tipo = String(t.tipo || 'Outros');
        const ym = _ym(d);

        if (ym === ymAtual) {
            mesAtual.set(tipo, (mesAtual.get(tipo) || 0) + v);
            totalAtual += v;
        } else if (ym < ymAtual) {
            if (!fechados.has(ym)) fechados.set(ym, new Map());
            const mm = fechados.get(ym);
            mm.set(tipo, (mm.get(tipo) || 0) + v);
        }
    }

    if (totalAtual < GASTO_MIN || fechados.size < 2) return null;

    // Fatia média por tipo: média das FATIAS de cada mês (não fatia dos totais).
    // Assim um mês atípico de gasto alto não domina a referência.
    const somaPct = new Map();
    for (const mm of fechados.values()) {
        let totalMes = 0;
        for (const v of mm.values()) totalMes += v;
        if (totalMes <= 0) continue;
        for (const [tipo, v] of mm) {
            somaPct.set(tipo, (somaPct.get(tipo) || 0) + (v / totalMes) * 100);
        }
    }

    let melhor = null;
    for (const [tipo, gasto] of mesAtual) {
        const pctAtual = (gasto / totalAtual) * 100;
        const pctMedia = (somaPct.get(tipo) || 0) / fechados.size;
        const desvio = pctAtual - pctMedia;
        if (desvio < DESVIO_MIN_PP) continue;
        if (!melhor || desvio > melhor._desvio) {
            melhor = {
                tipo,
                pctAtual:   Math.round(pctAtual),
                pctMedia:   Math.round(pctMedia),
                gastoAtual: Math.round(gasto * 100) / 100,
                meses:      fechados.size,
                _desvio:    desvio,
            };
        }
    }
    if (!melhor) return null;
    delete melhor._desvio;
    return melhor;
}

/**
 * Proatividade: cobrança que se repete e NÃO está cadastrada como assinatura.
 *
 * Só reaproveita o motor já testado (`recorrencias.js`) — a novidade é trazê-lo
 * para o chat. Antes, o usuário só descobria se fosse até a tela e perguntasse;
 * uma cobrança esquecida é justamente a que ninguém vai procurar.
 *
 * @returns {{ nome, valorMensal, valorAnual, ocorrencias }|null} a mais cara
 */
export function assinaturaNaoCadastrada(transacoes, assinaturas, hoje = new Date()) {
    let achados = [];
    try {
        achados = detectarAssinaturasEsquecidas(transacoes, assinaturas, hoje) || [];
    } catch { return null; }
    if (achados.length === 0) return null;
    const a = achados[0];   // o motor já ordena por valor mensal desc
    if (!a || _num(a.valorMensal) <= 0) return null;
    return {
        nome:        String(a.nome || '').slice(0, 60),
        valorMensal: _num(a.valorMensal),
        valorAnual:  _num(a.valorAnual),
        ocorrencias: _num(a.ocorrencias),
    };
}
