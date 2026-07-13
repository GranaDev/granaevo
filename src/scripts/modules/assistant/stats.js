// stats.js — telemetria LOCAL do funil de entendimento (zero conteúdo)
// ---------------------------------------------------------------------------
// Conta APENAS agregados anônimos no aparelho: quantas mensagens o parser
// local resolveu sozinho, quantas precisaram da IA e quantas a IA também não
// entendeu. NUNCA guarda texto, valor ou qualquer conteúdo — só contadores.
// Uso: decidir quais padrões novos ensinar ao parser local (menos token de IA)
// e mostrar o selo "% entendido no aparelho" nas configurações.
// ---------------------------------------------------------------------------

const KEY = 'ge_asst_stats_v1';
let _s = null;

function _load() {
    if (_s) return _s;
    _s = { local: 0, ia_ok: 0, ia_fail: 0, offline: 0 };
    try {
        const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
        if (raw && typeof raw === 'object') {
            for (const k of Object.keys(_s)) {
                const v = Number(raw[k]);
                if (Number.isFinite(v) && v >= 0) _s[k] = Math.floor(v);
            }
        }
    } catch { /* começa zerado */ }
    return _s;
}

function _save() {
    try { localStorage.setItem(KEY, JSON.stringify(_s)); } catch { /* ignore */ }
}

/** Incrementa um contador: 'local' | 'ia_ok' | 'ia_fail' | 'offline'. */
export function bump(kind) {
    const s = _load();
    if (kind in s) { s[kind]++; _save(); }
}

/** Snapshot dos contadores + % resolvido localmente (para as Configurações). */
export function snapshot() {
    const s = _load();
    const total = s.local + s.ia_ok + s.ia_fail;
    return { ...s, total, pctLocal: total > 0 ? Math.round((s.local / total) * 100) : null };
}

/** Zera tudo (logout). */
export function clearStats() {
    _s = { local: 0, ia_ok: 0, ia_fail: 0, offline: 0 };
    try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}
