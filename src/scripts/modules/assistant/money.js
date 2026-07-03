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

// ── Datas relativas (pt-BR) → "dd/mm/aaaa" ─────────────────────────────────────
/** "ontem", "anteontem", "semana passada", "dia N" → data BR; senão null. */
export function parseDataRelativa(text) {
    if (typeof text !== 'string') return null;
    const t = text.toLowerCase();
    const hoje = new Date();
    const fmt = (d) => d.toLocaleDateString('pt-BR');
    if (/\banteontem\b/.test(t)) { const d = new Date(hoje); d.setDate(d.getDate() - 2); return fmt(d); }
    if (/\bontem\b/.test(t)) { const d = new Date(hoje); d.setDate(d.getDate() - 1); return fmt(d); }
    if (/\bsemana passada\b/.test(t)) { const d = new Date(hoje); d.setDate(d.getDate() - 7); return fmt(d); }
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
