// money.js — parse/format de valores em português (BR)
// Sem dependências. Usado pelo parser local e pelos templates.

/**
 * Extrai o primeiro valor monetário de um texto livre em PT-BR.
 * Suporta: "R$ 1.234,56", "1234,56", "40", "40 pila/conto/reais", "1,5k", "2k".
 * @returns {number|null} valor positivo em reais, ou null se não achar.
 */
function _parseNum(raw, suffix) {
    let num;
    if (raw.includes('.') && raw.includes(',')) {
        // 1.234,56 → ponto=milhar, vírgula=decimal
        num = parseFloat(raw.replace(/\./g, '').replace(',', '.'));
    } else if (raw.includes(',')) {
        // 1,5 → decimal
        num = parseFloat(raw.replace(',', '.'));
    } else if (raw.includes('.')) {
        // 1.500 (3 casas após ponto) → milhar; 1.5 → decimal
        num = /\.\d{3}\b/.test(raw) ? parseFloat(raw.replace(/\./g, '')) : parseFloat(raw);
    } else {
        num = parseFloat(raw);
    }
    if (!Number.isFinite(num)) return null;
    if (suffix) num *= 1000; // "1,5k" / "2 mil"
    num = Math.round(num * 100) / 100;
    return num > 0 ? num : null;
}

export function parseValorBR(text) {
    if (typeof text !== 'string') return null;
    const s = text.toLowerCase();

    // Token numérico (com separadores) opcionalmente seguido de "k"/"mil".
    // Ex.: 1.234,56 | 1234,56 | 1.500 | 40 | 1,5k | 2 mil
    const re = /(?:r\$\s*)?(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)\s*(k\b|mil\b)?/g;
    let m;
    while ((m = re.exec(s)) !== null) {
        // Ignora número de PARCELAS ("3x", "em 1x") — não é valor monetário.
        if (!m[2] && s[re.lastIndex] === 'x') continue;
        const num = _parseNum(m[1], m[2]);
        if (num !== null) return num; // primeiro token monetário válido
    }
    return null;
}

/**
 * Aritmética simples de quantidade × preço unitário:
 *   "2 cafés de 8" = 16 · "3 pães a 2,50" = 7,5 · "4 cervejas por 6" = 24.
 * Conservador: exige um substantivo entre a quantidade e o conector,
 * quantidade 2..99, ignora palavras de moeda como "substantivo".
 * @returns {number|null}
 */
export function parseAritmetica(text) {
    if (typeof text !== 'string') return null;
    const t = text.toLowerCase();
    const m = t.match(/\b([2-9]|[1-9]\d)\s+([\p{L}][\p{L}\s]{1,20}?)\s+(?:de|a|por|vezes)\s+(?:r\$\s*)?(\d+(?:[.,]\d{1,2})?)\b/u);
    if (!m) return null;
    const noun = m[2].trim();
    if (/\b(reais?|pila|pilas|conto|contos|mango|mangos|pau|paus)\b/.test(noun)) return null;
    const qtd = parseInt(m[1], 10);
    const unit = _parseNum(m[3], null);
    if (unit === null || qtd < 2 || qtd > 99) return null;
    const total = Math.round(qtd * unit * 100) / 100;
    return total > 0 && total <= 100_000_000 ? total : null;
}

/** Extrai o nº de parcelas de "em Nx" / "Nx" (1..420), senão null. */
export function parseParcelas(text) {
    if (typeof text !== 'string') return null;
    const m = text.toLowerCase().match(/\b(\d{1,3})\s*x\b/);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    return n >= 1 && n <= 420 ? n : null;
}

// ── Números por extenso (pt-BR) ────────────────────────────────────────────────
const _UNI = { zero: 0, um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10, onze: 11, doze: 12, treze: 13, quatorze: 14, catorze: 14, quinze: 15, dezesseis: 16, dezessete: 17, dezoito: 18, dezenove: 19 };
const _DEZ = { vinte: 20, trinta: 30, quarenta: 40, cinquenta: 50, sessenta: 60, setenta: 70, oitenta: 80, noventa: 90 };
const _CEM = { cem: 100, cento: 100, duzentos: 200, trezentos: 300, quatrocentos: 400, quinhentos: 500, seiscentos: 600, setecentos: 700, oitocentos: 800, novecentos: 900 };

/**
 * Interpreta valores por extenso: "cinquenta reais"=50, "mil e duzentos"=1200.
 * Conservador: um número "fraco" (só unidade, ex. "um") só conta se houver
 * palavra de moeda (reais/pila/conto) — evita virar valor um "um café".
 */
export function parseExtenso(text) {
    if (typeof text !== 'string') return null;
    const t = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const hasMoeda = /\b(reais|real|pila|pilas|conto|contos|mango|mangos|pau|paus)\b/.test(t);
    let total = 0, current = 0, found = false, strong = false;
    for (const w of t.split(/\s+/)) {
        if (!w || w === 'e' || w === 'de') continue;
        if (w in _UNI) { current += _UNI[w]; found = true; }
        else if (w in _DEZ) { current += _DEZ[w]; found = true; strong = true; }
        else if (w in _CEM) { current += _CEM[w]; found = true; strong = true; }
        else if (w === 'mil') { current = (current || 1) * 1000; total += current; current = 0; found = true; strong = true; }
        else if (w === 'milhao' || w === 'milhoes') { current = (current || 1) * 1e6; total += current; current = 0; found = true; strong = true; }
    }
    total += current;
    if (!found || total <= 0) return null;
    if (!strong && !hasMoeda) return null;
    return total;
}

// ── Meses nomeados (pt-BR) → "YYYY-MM" ─────────────────────────────────────────
// Usado pelas consultas/relatórios ("relatório de maio"). Nomes completos +
// abreviações de 3 letras (bounded por \b — não casa "janta"/"mercado"/"mais").
const _MESES = ['janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho',
    'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const _MESES_ABBR = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

function _normNoAcc(s) {
    return String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * Detecta um mês nomeado no texto e devolve a ocorrência mais recente no
 * passado (ou o mês atual) como "YYYY-MM". Ex.: em julho/2026, "maio"→2026-05,
 * "dezembro"→2025-12 (dez ainda não aconteceu este ano). Senão null.
 */
export function parseMesNomeado(text) {
    const t = _normNoAcc(text);
    let idx = -1;
    for (let i = 0; i < 12; i++) {
        if (new RegExp(`\\b${_MESES[i]}\\b`).test(t)) { idx = i; break; }
    }
    if (idx === -1) {
        for (let i = 0; i < 12; i++) {
            if (new RegExp(`\\b${_MESES_ABBR[i]}\\b`).test(t)) { idx = i; break; }
        }
    }
    if (idx === -1) return null;
    const hoje = new Date();
    let ano = hoje.getFullYear();
    if (idx > hoje.getMonth()) ano -= 1; // mês ainda não chegou este ano → ano passado
    return `${ano}-${String(idx + 1).padStart(2, '0')}`;
}

/** Rótulo amigável de um "YYYY-MM": "maio" (ano atual) ou "maio de 2025". */
export function mesLabel(ym) {
    if (typeof ym !== 'string') return '';
    const m = ym.match(/^(\d{4})-(\d{2})$/);
    if (!m) return '';
    const ano = Number(m[1]);
    const nomes = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
        'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
    const nome = nomes[Number(m[2]) - 1] || '';
    if (!nome) return '';
    return ano === new Date().getFullYear() ? nome : `${nome} de ${ano}`;
}

// ── Datas relativas (pt-BR) → "dd/mm/aaaa" ─────────────────────────────────────
const _DIAS_SEMANA = { domingo: 0, segunda: 1, terca: 2, quarta: 3, quinta: 4, sexta: 5, sabado: 6 };

/** "ontem", "anteontem", "semana passada/retrasada", "terça passada", "dia N" → data BR; senão null. */
export function parseDataRelativa(text) {
    if (typeof text !== 'string') return null;
    const t = text.toLowerCase();
    const tn = _normNoAcc(text); // sem acento p/ dias da semana ("terça"→"terca")
    const hoje = new Date();
    const fmt = (d) => d.toLocaleDateString('pt-BR');
    if (/\banteontem\b/.test(tn)) { const d = new Date(hoje); d.setDate(d.getDate() - 2); return fmt(d); }
    if (/\bontem\b/.test(tn)) { const d = new Date(hoje); d.setDate(d.getDate() - 1); return fmt(d); }
    if (/\bsemana retrasada\b/.test(tn)) { const d = new Date(hoje); d.setDate(d.getDate() - 14); return fmt(d); }
    if (/\bsemana passada\b/.test(tn)) { const d = new Date(hoje); d.setDate(d.getDate() - 7); return fmt(d); }

    // Dia da semana + "passad[ao]" ("terça passada", "sábado passado", "segunda-feira passada").
    const mSem = tn.match(/\b(domingo|segunda|terca|quarta|quinta|sexta|sabado)(?:-?\s*feira)?\s+passad[ao]\b/);
    if (mSem) {
        const alvo = _DIAS_SEMANA[mSem[1]];
        const diff = (hoje.getDay() - alvo + 7) % 7;
        const d = new Date(hoje);
        d.setDate(d.getDate() - (diff === 0 ? 7 : diff)); // "passada" = estritamente antes de hoje
        return fmt(d);
    }

    // Data absoluta com barra/traço: "dia 5/6", "05/06", "3/5/2026" → dd/mm/aaaa.
    // Exige dia E mês (tem separador) para não capturar números soltos.
    const mAbs = t.match(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/);
    if (mAbs) {
        const dia = parseInt(mAbs[1], 10);
        const mes = parseInt(mAbs[2], 10);
        let ano = mAbs[3] ? parseInt(mAbs[3], 10) : hoje.getFullYear();
        if (ano < 100) ano += 2000;
        if (dia >= 1 && dia <= 31 && mes >= 1 && mes <= 12 && ano >= 2000 && ano <= 2100) {
            const d = new Date(ano, mes - 1, dia);
            if (!Number.isNaN(d.getTime()) && d.getDate() === dia && d.getMonth() === mes - 1) return fmt(d);
        }
    }

    const mDia = t.match(/\bdia (\d{1,2})\b/);
    if (mDia) {
        const dia = parseInt(mDia[1], 10);
        if (dia >= 1 && dia <= 31) {
            const d = new Date(hoje.getFullYear(), hoje.getMonth(), dia);
            if (!Number.isNaN(d.getTime()) && d.getDate() === dia) return fmt(d);
        }
    }
    return null;
}

// ── Datas FUTURAS (pt-BR) → "YYYY-MM-DD" (para lembretes do Radar) ─────────────
// Diferente de parseDataRelativa (que olha pro passado, p/ lançamentos), aqui
// tudo resolve pra frente: "dia 5" = a PRÓXIMA ocorrência do dia 5.
export function parseDataFutura(text) {
    if (typeof text !== 'string') return null;
    const t = text.toLowerCase();
    const tn = _normNoAcc(text);
    const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
    const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    if (/\bdepois de amanha\b/.test(tn)) { const d = new Date(hoje); d.setDate(d.getDate() + 2); return iso(d); }
    if (/\bamanha\b/.test(tn)) { const d = new Date(hoje); d.setDate(d.getDate() + 1); return iso(d); }
    if (/\bhoje\b/.test(tn)) return iso(hoje);

    // "daqui (a) N dias" / "em N dias"
    const mDias = tn.match(/\b(?:daqui a?|em)\s+(\d{1,2})\s+dias?\b/);
    if (mDias) { const n = parseInt(mDias[1], 10); if (n >= 1 && n <= 60) { const d = new Date(hoje); d.setDate(d.getDate() + n); return iso(d); } }

    // "na sexta" / "sexta que vem" / "próxima terça" → próxima ocorrência (nunca hoje)
    const mSem = tn.match(/\b(?:na |no |proxim[ao] )?(domingo|segunda|terca|quarta|quinta|sexta|sabado)(?:-?\s*feira)?(?: que vem)?\b/);
    if (mSem && !/\bpassad[ao]\b/.test(tn)) {
        const alvo = _DIAS_SEMANA[mSem[1]];
        let diff = (alvo - hoje.getDay() + 7) % 7;
        if (diff === 0) diff = 7;
        const d = new Date(hoje); d.setDate(d.getDate() + diff);
        return iso(d);
    }

    // Data absoluta "5/8" ou "05/08/2026" → só se for futura (até 60 dias)
    const mAbs = t.match(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/);
    if (mAbs) {
        const dia = parseInt(mAbs[1], 10), mes = parseInt(mAbs[2], 10);
        let ano = mAbs[3] ? parseInt(mAbs[3], 10) : hoje.getFullYear();
        if (ano < 100) ano += 2000;
        if (dia >= 1 && dia <= 31 && mes >= 1 && mes <= 12 && ano >= 2000 && ano <= 2100) {
            let d = new Date(ano, mes - 1, dia);
            if (!mAbs[3] && d < hoje) d = new Date(ano + 1, mes - 1, dia); // sem ano e já passou → ano que vem
            if (!Number.isNaN(d.getTime()) && d.getDate() === dia && d >= hoje) return iso(d);
        }
        return null;
    }

    // "dia N" → próxima ocorrência (este mês se ainda não passou, senão o próximo)
    const mDia = tn.match(/\bdia (\d{1,2})\b/);
    if (mDia) {
        const dia = parseInt(mDia[1], 10);
        if (dia >= 1 && dia <= 31) {
            let d = new Date(hoje.getFullYear(), hoje.getMonth(), dia);
            if (d < hoje || d.getDate() !== dia) d = new Date(hoje.getFullYear(), hoje.getMonth() + 1, dia);
            if (!Number.isNaN(d.getTime()) && d.getDate() === dia) return iso(d);
        }
    }
    return null;
}

/** Formata número como moeda BRL. */
export function formatBRL(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return 'R$ 0,00';
    return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

/** Data/hora no formato idêntico ao app (dd/mm/aaaa · HH:MM:SS). */
export function agoraDataHora() {
    const d = new Date();
    return {
        data: d.toLocaleDateString('pt-BR'),
        hora: d.toLocaleTimeString('pt-BR', { hour12: false }),
    };
}

/** Chave ano-mês "YYYY-MM" (igual ao dashboard). */
export function yearMonthKey(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
}

/** Converte "dd/mm/aaaa" → Date (para filtros de período). */
export function brDateToObj(dataBR) {
    if (typeof dataBR !== 'string') return null;
    const p = dataBR.split('/');
    if (p.length !== 3) return null;
    const d = new Date(Number(p[2]), Number(p[1]) - 1, Number(p[0]));
    return Number.isNaN(d.getTime()) ? null : d;
}
