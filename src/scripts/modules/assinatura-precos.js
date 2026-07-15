// assinatura-precos.js — Detector de aumento de preço em cobrança recorrente
// ----------------------------------------------------------------------------
// A Netflix era R$ 39,90 e virou R$ 44,90. O app não avisava nada — e R$ 5/mês
// parece pouco justamente porque ninguém multiplica por 12. Este módulo acha o
// DEGRAU de preço numa cobrança mensal e devolve o impacto ANUAL (+R$ 60,00/ano),
// que é o número que faz o usuário decidir se ainda vale a pena.
//
// Irmão do recorrencias.js (mesmo agrupamento por descrição normalizada, mesma
// noção de "mensal" = gaps de 25–36 dias). A diferença: lá o valor PRECISA ser
// estável; aqui procuramos exatamente o contrário — dois patamares estáveis, o
// segundo mais caro.
//
// Critérios (conservadores — falso-positivo aqui é acusar aumento que não houve):
//   - categoria 'saida' ou 'saida_credito', EXCLUINDO o que o app gerou
//     (conta fixa / fatura / compra) por MARCADOR DE ORIGEM — ver nota abaixo
//   - ≥ 3 ocorrências e padrão realmente mensal (gaps de 25–36 dias)
//   - DIA DO MÊS consistente (±3): assinatura cobra sempre no mesmo dia; pedágio e
//     compras caem em dia aleatório (um pedágio reajustado não é "assinatura")
//   - DEGRAU: as N mais antigas (≥2) estáveis num valor, as seguintes estáveis
//     num valor maior, com separação estrita (toda cobrança nova > toda antiga)
//   - aumento ≥ 5% E ≥ R$ 1,00 (corta ruído de centavos e reajuste irrelevante)
//   - ainda ativa: última cobrança nos últimos 45 dias
//   - janela de 14 meses: aumento de 2 anos atrás não é notícia, é histórico
// 100% client-side, matemática pura, `hoje` injetável.
// ----------------------------------------------------------------------------

function _txDate(data) {
    if (typeof data !== 'string') return null;
    let y, m, d;
    if (data.includes('/')) {
        const p = data.split('/');
        if (p.length !== 3) return null;
        d = +p[0]; m = +p[1]; y = +p[2];
    } else if (data.includes('-')) {
        const p = data.split('-');
        if (p.length < 3) return null;
        y = +p[0]; m = +p[1]; d = parseInt(p[2], 10);
    } else return null;
    if (!y || !m || !d || m < 1 || m > 12 || d < 1 || d > 31) return null;
    return new Date(y, m - 1, d);
}

function _norm(s) {
    return String(s || '')
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/\d+/g, '')
        .replace(/[^a-z ]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 40);
}

const _MS_DIA = 86_400_000;
const _r2 = (n) => Math.round(n * 100) / 100;

/** Um lado do degrau é "estável" se a variação for de centavos (≤3% ou ≤R$0,50). */
function _estavel(vals) {
    const media = vals.reduce((s, x) => s + x, 0) / vals.length;
    const spread = Math.max(...vals) - Math.min(...vals);
    return spread <= Math.max(media * 0.03, 0.5);
}

const _media = (vals) => vals.reduce((s, x) => s + x, 0) / vals.length;

/**
 * Cobranças recorrentes que subiram de preço.
 *
 * @param {Array}  transacoes
 * @param {Date}   hoje  injetável — determinismo nos testes
 * @param {Object} opts  { minOcorrencias, pctMin, valorMin, diasAtiva, mesesJanela, max }
 * @returns [{ nome, valorAntigo, valorNovo, aumento, aumentoPct, impactoAnual, desde }]
 *          ordenado por impactoAnual desc (máx. 10).
 */
export function detectarAumentosAssinatura(transacoes, hoje = new Date(), opts = {}) {
    const {
        minOcorrencias = 3,     // 2 no preço antigo + 1 no novo: o mínimo para existir degrau
        pctMin         = 0.05,  // 5% — abaixo disso é reajuste/arredondamento, não notícia
        valorMin       = 1,     // R$ 1,00 — 20% de R$ 0,50 não merece um card
        diasAtiva      = 45,
        mesesJanela    = 14,    // só o preço atual interessa; degrau antigo é história
        max            = 10,
    } = (opts || {});

    const limite = new Date(hoje.getTime() - mesesJanela * 30.5 * _MS_DIA);
    const grupos = new Map();

    for (const t of (transacoes || [])) {
        if (!t) continue;
        if (t.categoria !== 'saida' && t.categoria !== 'saida_credito') continue;
        // Exclusão por MARCADOR DE ORIGEM (id), não por rótulo: os tipos REAIS gravados
        // são 'Conta Fixa' (F maiúsculo) e 'Pagamento Cartão' — comparar com
        // 'Conta fixa'/'Cartão' já foi causa-raiz de 2 bugs graves aqui. O id é robusto
        // a mudança de rótulo; a checagem por tipo abaixo é só reforço.
        if (t.contaFixaId != null || t.faturaId != null || t.compraId != null) continue;
        if (t.tipo === 'Conta Fixa' || t.tipo === 'Conta fixa' ||
            t.tipo === 'Pagamento Cartão' || t.tipo === 'Cartão') continue;
        const dt = _txDate(t.data);
        const v  = Number(t.valor);
        if (!dt || !Number.isFinite(v) || v <= 0) continue;
        if (dt < limite) continue;
        const key = _norm(t.descricao);
        if (key.length < 3) continue;
        if (!grupos.has(key)) grupos.set(key, []);
        grupos.get(key).push({ dt, v, descOriginal: String(t.descricao || '').slice(0, 60) });
    }

    const achados = [];

    for (const occ of grupos.values()) {
        if (occ.length < minOcorrencias) continue;

        occ.sort((a, b) => a.dt - b.dt);

        // ainda ativa? (cobrou nos últimos 45 dias)
        const ultima = occ[occ.length - 1].dt;
        if ((hoje - ultima) / _MS_DIA > diasAtiva) continue;

        // o padrão precisa ser mensal — senão "mercado toda semana" vira assinatura
        let gapsMensais = 0, gapsTotal = 0;
        for (let i = 1; i < occ.length; i++) {
            const gap = Math.round((occ[i].dt - occ[i - 1].dt) / _MS_DIA);
            if (gap < 20) continue; // mesma fatura/duplicata — ignora o par
            gapsTotal++;
            if (gap >= 25 && gap <= 36) gapsMensais++;
        }
        if (gapsTotal === 0 || gapsMensais < Math.max(1, gapsTotal - 1)) continue;

        // DIA DO MÊS consistente (±3) — mesmo discriminador do recorrencias.js.
        // Sem isto, um PEDÁGIO reajustado (valor fixo, ~1x/mês, dias aleatórios) seria
        // anunciado como "sua assinatura subiu". Assinatura cobra sempre no mesmo dia;
        // fim de semana/feriado/mês curto deslocam no máximo ~3.
        const diasMes = occ.map(o => o.dt.getDate());
        if (Math.max(...diasMes) - Math.min(...diasMes) > 3) continue;

        // Procura o degrau começando pelo split mais RECENTE possível: o que importa é
        // a última mudança de preço (o valor que o usuário paga hoje).
        // k = quantas ocorrências ficam no lado "antigo" (mínimo 2 → preço antigo provado).
        for (let k = occ.length - 1; k >= 2; k--) {
            const anteriores = occ.slice(0, k).map(o => o.v);
            const novas      = occ.slice(k).map(o => o.v);

            if (!_estavel(novas)) continue;
            // Separação estrita contra TODO o histórico anterior: nenhuma cobrança
            // antiga pode alcançar a mais barata das novas. É o que impede uma conta
            // que OSCILA entre dois valores (39,90 / 44,90 / 39,90…) de virar "aumento"
            // só porque as últimas duas calharam de ser as caras.
            if (Math.max(...anteriores) >= Math.min(...novas)) continue;

            // "Preço antigo" = a corrida estável imediatamente ANTES do degrau, não o
            // histórico inteiro: quem subiu duas vezes (30 → 35 → 44) tem que ouvir
            // 35 → 44, o que paga hoje contra o que pagava ontem.
            const antigas = [occ[k - 1].v];
            for (let i = k - 2; i >= 0 && _estavel([occ[i].v, ...antigas]); i--) {
                antigas.unshift(occ[i].v);
            }
            if (antigas.length < 2) continue; // preço antigo visto uma vez só não é preço, é evento

            const valorAntigo = _r2(_media(antigas));
            const valorNovo   = _r2(_media(novas));
            const aumento     = _r2(valorNovo - valorAntigo);
            // Subiu, mas é ruído/arredondamento — segue procurando um degrau anterior
            // que valha um card (continue, não break: 30 → 44 → 44,20 ainda vale 30 → 44).
            if (aumento < Math.max(valorAntigo * pctMin, valorMin)) continue;

            achados.push({
                nome:         occ[occ.length - 1].descOriginal,
                valorAntigo,
                valorNovo,
                aumento,
                aumentoPct:   Math.round((aumento / valorAntigo) * 1000) / 10,
                impactoAnual: _r2(aumento * 12),
                desde:        occ[k].dt, // 1ª cobrança no preço novo
            });
            break;
        }
    }

    achados.sort((a, b) => b.impactoAnual - a.impactoAnual);
    return achados.slice(0, max);
}
