// categorizacao.js — Categorização automática APRENDIDA do histórico do usuário
// ----------------------------------------------------------------------------
// O app é 100% lançamento manual: o atrito mora em escolher categoria + tipo
// dezenas de vezes por mês. Existe hoje o `_autoCategorizar` (db-transacoes.js),
// uma lista FIXA de regex ("mercado|extra|carrefour" → Mercado) usada só na
// importação de extrato. Ela não sabe nada sobre ESTE usuário: quem lança
// "mercado" e sempre classifica como 'Feira' continua corrigindo o app para
// sempre.
//
// Aqui a fonte da verdade é o próprio histórico: se ele usou 'Mercado' nas
// últimas 8 vezes que escreveu "mercado extra", é isso que o app sugere — e a
// sugestão melhora sozinha conforme ele usa o app.
//
// COMO FUNCIONA (Naive Bayes enxuto, com decaimento):
//   1. descrição → tokens (mesma normalização da dedup de importação e do
//      duplicados.js: minúscula, sem acento, palavras ≥3 chars)
//   2. cada token vira um voto ponderado nos (categoria,tipo) com que já apareceu
//   3. votos velhos pesam menos (meia-vida de 180 dias) — quem mudou de hábito
//      em março não deve ser assombrado pelo hábito de janeiro do ano passado
//   4. tokens genéricos pesam menos (IDF): "compra"/"pagamento" aparecem em tudo
//      e não discriminam nada; "ipiranga" aparece em 4 lançamentos e vale ouro.
//      É o IDF que dispensa lista de stopword — o próprio histórico diz o que é
//      palavra vazia PARA ESTE USUÁRIO.
//
// CONSERVADOR POR PROJETO: sugestão errada é PIOR que nenhuma. O usuário confia,
// aceita e grava errado — e aí o erro contamina saldo, relatório e meta, igual a
// um duplicado. Por isso, na dúvida, `null`. Três travas:
//   - evidência mínima: 1 ocorrência é evento, não padrão (mesma régua do
//     recorrencias.js, onde 2 ocorrências geraram falso positivo em prod)
//   - pureza: o tipo vencedor precisa dominar os votos, não só ganhar por pouco
//   - limiar de confiança configurável pelo chamador
//
// 100% puro: sem DOM, sem rede, `hoje` injetável.
// ----------------------------------------------------------------------------

const _MS_DIA = 86_400_000;

// As 5 categorias reais gravadas pelo app. Qualquer outra coisa é lixo/legado e
// não entra no modelo — aprender de dado corrompido é pior que não aprender.
const _CATEGORIAS = new Set(['entrada', 'saida', 'saida_credito', 'reserva', 'retirada_reserva']);

// "DD/MM/YYYY" ou "YYYY-MM-DD" → Date (ou null). Mesmo parser dos módulos irmãos.
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

// Mesma tokenização da dedup de importação (db-transacoes.js) e do duplicados.js
// — com UMA diferença deliberada: tokens puramente numéricos são descartados.
// Lá o número é inofensivo; aqui ele é veneno: "uber 25" e "mercado 25" nada têm
// em comum, mas "25" é raro no histórico → IDF alto → viraria a "prova" mais forte
// da sugestão. Números não carregam significado de categoria. "99pop" (misto) fica.
function _tokens(str) {
    return String(str || '')
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\w\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length >= 3 && !/^\d+$/.test(w))
        .map(w => w.slice(0, 30));
}

const _r3 = (n) => Math.round(n * 1000) / 1000;

/**
 * Treina o índice token → (categoria,tipo) a partir do histórico do usuário.
 *
 * @param {Array}  transacoes  [{ categoria, tipo, descricao, valor, data }]
 * @param {Date}   hoje        injetável — determinismo nos testes
 * @param {Object} opts        { meiaVidaDias, mesesJanela, maxTransacoes }
 * @returns {Object} modelo opaco (passe para sugerirCategoria). Nunca lança.
 */
export function construirModelo(transacoes, hoje = new Date(), opts = {}) {
    const {
        meiaVidaDias  = 180,   // ~6 meses: hábito de 6 meses atrás vale metade do de hoje
        mesesJanela   = 24,    // além de 2 anos o vocabulário é de outra vida
        maxTransacoes = 1500,  // teto de memória; mantém as MAIS RECENTES
    } = (opts || {});

    const modelo = { n: 0, df: new Map(), idx: new Map(), rotulos: new Map() };
    if (!Array.isArray(transacoes) || transacoes.length === 0) return modelo;

    const ref = (hoje instanceof Date && !Number.isNaN(hoje.getTime())) ? hoje : new Date();
    const limite = new Date(ref.getTime() - mesesJanela * 30.5 * _MS_DIA);

    const uteis = [];
    for (const t of transacoes) {
        if (!t || typeof t !== 'object') continue;
        // Gerados pelo app (conta fixa / fatura / compra parcelada) NÃO são decisão
        // do usuário: são replays de UMA decisão. Uma conta fixa de aluguel injeta 12
        // cópias idênticas por ano e sozinha empurraria qualquer sugestão para
        // 'Conta Fixa' com "baseado em 12 vezes" — evidência inflada a partir de um
        // único clique. Exclusão por MARCADOR DE ORIGEM (id), igual duplicados.js e
        // previsao-mes.js: robusto a mudança de rótulo.
        if (t.contaFixaId != null || t.faturaId != null || t.compraId != null) continue;
        if (!_CATEGORIAS.has(t.categoria)) continue;
        const tipo = typeof t.tipo === 'string' ? t.tipo.trim() : '';
        if (!tipo) continue;
        const dt = _txDate(t.data);
        if (!dt || dt < limite) continue;
        const toks = [...new Set(_tokens(t.descricao))];
        if (toks.length === 0) continue;
        uteis.push({ dt, tipo, categoria: t.categoria, toks });
    }
    if (uteis.length === 0) return modelo;

    uteis.sort((a, b) => b.dt - a.dt); // recentes primeiro: o corte descarta o passado
    const usadas = uteis.slice(0, maxTransacoes);

    let id = 0;
    for (const u of usadas) {
        // Decaimento exponencial. Lançamento futuro (agendado) não vale MAIS que hoje → clamp.
        const idade = Math.max(0, (ref - u.dt) / _MS_DIA);
        const peso  = Math.pow(0.5, idade / meiaVidaDias);

        // Agrupa por tipo case-insensitive: 'Mercado' e 'mercado' são o MESMO tipo.
        // Caixa em texto livre já foi causa-raiz de bug neste projeto — não repetir.
        const tipoKey = u.tipo.toLowerCase();
        // Chave do par (categoria,tipo). JSON em vez de concatenar com separador:
        // `tipo` é texto livre do usuário e pode conter qualquer caractere, então
        // nenhum separador é seguro contra colisão de chave.
        const pairKey = JSON.stringify([u.categoria, tipoKey]);

        let rot = modelo.rotulos.get(tipoKey);
        if (!rot) { rot = new Map(); modelo.rotulos.set(tipoKey, rot); }
        rot.set(u.tipo, (rot.get(u.tipo) || 0) + 1);

        for (const tk of u.toks) {
            modelo.df.set(tk, (modelo.df.get(tk) || 0) + 1);
            let m = modelo.idx.get(tk);
            if (!m) { m = new Map(); modelo.idx.set(tk, m); }
            let rec = m.get(pairKey);
            if (!rec) { rec = { peso: 0, ids: new Set(), tipoKey, categoria: u.categoria }; m.set(pairKey, rec); }
            rec.peso += peso;
            rec.ids.add(id);
        }
        id++;
    }
    modelo.n = usadas.length;
    return modelo;
}

/**
 * Sugere (categoria,tipo) para uma descrição — ou null quando não há convicção.
 *
 * @param {Object} modelo     de construirModelo()
 * @param {string} descricao  o que o usuário está digitando
 * @param {Object} opts       { limiar, minEvidencia }
 * @returns {{categoria,tipo,confianca,confiancaCategoria,baseadoEm}|null}
 *   confianca          0–1, sobre o TIPO sugerido (o que reduz o atrito)
 *   confiancaCategoria 0–1, sobre a categoria — ver nota abaixo
 *   baseadoEm          nº de lançamentos DISTINTOS que sustentam a sugestão
 *                      ("você usou 'Mercado' nas últimas 8 vezes")
 */
export function sugerirCategoria(modelo, descricao, opts = {}) {
    const { limiar = 0.6, minEvidencia = 2 } = (opts || {});
    if (!modelo || !(modelo.idx instanceof Map) || !(modelo.n > 0)) return null;

    const toks = [...new Set(_tokens(descricao))];
    if (toks.length === 0) return null;

    // Vota no TIPO (não no par categoria+tipo). Se o usuário compra mercado ora no
    // débito ora no crédito, o par racha a evidência em (saida,Mercado) e
    // (saida_credito,Mercado) e mataria a confiança de um tipo que é 100% certo.
    // O tipo é a pergunta difícil; a categoria se decide DENTRO do tipo vencedor.
    const porTipo = new Map(); // tipoKey → { peso, ids:Set, cats:Map<categoria,peso> }

    for (const tk of toks) {
        const m = modelo.idx.get(tk);
        if (!m) continue;
        const df  = modelo.df.get(tk) || 1;
        // IDF suavizado (estilo BM25). O log(N/df) clássico zera quando o token está
        // em TODAS as transações — o que é certo para "pagamento", mas mata o usuário
        // novo, cujas 3 transações são todas "Mercado Extra" (df = N → tudo zero →
        // nenhuma sugestão jamais). O +1/+0.5 mantém o idf sempre > 0: some para quem
        // tem histórico, sobrevive para quem tem 3 lançamentos.
        const idf = Math.log((modelo.n + 1) / (df + 0.5));
        if (!(idf > 0)) continue;
        for (const rec of m.values()) {
            let g = porTipo.get(rec.tipoKey);
            if (!g) { g = { peso: 0, ids: new Set(), cats: new Map() }; porTipo.set(rec.tipoKey, g); }
            const p = idf * rec.peso;
            g.peso += p;
            // Set → a MESMA transação casada por 2 tokens conta 1 vez em baseadoEm
            // (senão "mercado extra" reportaria "6 vezes" para 3 lançamentos).
            for (const i of rec.ids) g.ids.add(i);
            g.cats.set(rec.categoria, (g.cats.get(rec.categoria) || 0) + p);
        }
    }
    if (porTipo.size === 0) return null; // nenhuma palavra conhecida → não chuta

    let total = 0;
    for (const g of porTipo.values()) total += g.peso;
    if (!(total > 0)) return null;

    let topKey = null, top = null;
    for (const [k, g] of porTipo) if (!top || g.peso > top.peso) { topKey = k; top = g; }

    const baseadoEm = top.ids.size;
    if (baseadoEm < minEvidencia) return null; // 1 vez é evento, não padrão

    // Confiança = PUREZA × VOLUME.
    //   pureza (share): o tipo vencedor levou quanto dos votos? 50/50 → 0.5 → cai fora
    //   volume (saturação ev/(ev+1)): 2 provas → 0.67, 3 → 0.75, 8 → 0.89
    // As duas precisam existir: puro-mas-raro é sorte, farto-mas-dividido é dúvida.
    const pureza = top.peso / total;
    const confianca = pureza * (baseadoEm / (baseadoEm + 1));
    if (confianca < limiar) return null;

    // Categoria dominante DENTRO do tipo vencedor. Confusão perigosa (entrada × saida)
    // na prática nunca compartilha tipo — 'Salário' é sempre entrada. O que racha um
    // tipo é débito × crédito ('Mercado'), ambos gastos, e aí o chamador decide: usar
    // confiancaCategoria para pré-marcar o rádio, ou preencher só o tipo.
    let categoria = null, catPeso = -1;
    for (const [k, p] of top.cats) if (p > catPeso) { categoria = k; catPeso = p; }

    // Devolve a grafia ORIGINAL mais usada ('Farmácia', não 'farmacia'). Empate →
    // a primeira vista, e como o histórico foi ordenado por data desc, a mais recente.
    let tipo = topKey, maisUsada = -1;
    const rot = modelo.rotulos.get(topKey);
    if (rot) for (const [label, c] of rot) if (c > maisUsada) { maisUsada = c; tipo = label; }

    return {
        categoria,
        tipo,
        confianca: _r3(confianca),
        confiancaCategoria: _r3(catPeso / top.peso),
        baseadoEm,
    };
}
