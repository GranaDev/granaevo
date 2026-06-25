// perf-marks.js — Instrumentação leve de performance, opt-in e removível.
//
// Objetivo: medir no APARELHO REAL do usuário (celular fraco) o custo de boot e de
// render de listas longas, sem pesar nada em produção. Tudo aqui é no-op quando a flag
// está desligada — o overhead é uma comparação booleana.
//
// Como ligar (só no aparelho de teste):
//   • URL:          adicione ?perf=1   → ex.: /dashboard.html?perf=1
//   • localStorage: localStorage.perf = '1'  (persiste entre recarregamentos)
// Como desligar: remova ?perf=1 / localStorage.removeItem('perf').
//
// Saída: console (group) com fases nomeadas e contagens de nós DOM.

const _enabled = (() => {
    try {
        if (typeof window === 'undefined') return false;
        const url = new URLSearchParams(window.location.search);
        if (url.get('perf') === '1') return true;
        return window.localStorage?.getItem('perf') === '1';
    } catch {
        return false;
    }
})();

const _now = () => (typeof performance !== 'undefined' && performance.now
    ? performance.now()
    : Date.now());

const _open = new Map();   // label -> startTime

export const perfEnabled = _enabled;

// Marca o início de uma fase. Casa com perfMeasure(label).
export function perfMark(label) {
    if (!_enabled) return;
    _open.set(label, _now());
    try { performance.mark?.(`granaevo:${label}:start`); } catch {}
}

// Fecha a fase aberta por perfMark(label) e loga a duração em ms.
// Retorna a duração (ou null), útil para acumular.
export function perfMeasure(label, extra = '') {
    if (!_enabled) return null;
    const start = _open.get(label);
    if (start == null) return null;
    _open.delete(label);
    const dur = _now() - start;
    try { performance.measure?.(`granaevo:${label}`, `granaevo:${label}:start`); } catch {}
    // eslint-disable-next-line no-console
    console.log(`%c[perf] ${label}: ${dur.toFixed(1)}ms${extra ? '  ' + extra : ''}`,
        'color:#22c55e;font-weight:600');
    return dur;
}

// Mede uma função síncrona em uma chamada. Retorna o valor da função.
export function perfTime(label, fn) {
    if (!_enabled) return fn();
    perfMark(label);
    const r = fn();
    perfMeasure(label);
    return r;
}

// Loga uma contagem (ex.: nós DOM criados numa lista) — métrica estrutural determinística.
export function perfCount(label, n, extra = '') {
    if (!_enabled) return;
    // eslint-disable-next-line no-console
    console.log(`%c[perf] ${label}: ${n} nós${extra ? '  ' + extra : ''}`,
        'color:#38bdf8;font-weight:600');
}

// Conta nós descendentes de um elemento (inclui o próprio). Seguro com null.
export function perfNodeCount(el) {
    if (!_enabled || !el) return 0;
    return el.querySelectorAll('*').length;
}