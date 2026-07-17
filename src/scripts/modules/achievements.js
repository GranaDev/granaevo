// achievements.js — Sistema de Conquistas, Níveis e Títulos (por perfil)
// ----------------------------------------------------------------------------
// Engine PURO: todas as funções de avaliação recebem `state` (dados do perfil
// em memória) e o mapa `unlocked` ({ id: ISOdate }). Nada é validado no
// servidor porque conquistas são cosméticas e privadas do próprio usuário
// (mesmo blob user_data.data_json já protegido por RLS) — não há comparação
// entre usuários, logo zero superfície de segurança nova.
//
// Persistência: o mapa de desbloqueios mora em `perfilData.conquistas` no
// próprio perfil (ver dashboard.js). Nível e título são SEMPRE derivados do
// XP somado das conquistas — nada redundante é salvo.
//
// ── ARQUITETURA DE BUNDLE (importante) ──────────────────────────────────────
// Este módulo é importado ESTATICAMENTE pelo dashboard.js (chunk crítico, com
// orçamento gzip apertado). Por isso aqui mora SÓ o que é necessário para
// AVALIAR a cada save: id, raridade, flag `hidden` e o predicado `check`.
// Toda a APRESENTAÇÃO (título, descrição, ícone, categoria, barra de progresso)
// vive em achievements-catalog.js, carregado SOB DEMANDA (só na tela de
// Configurações e — via import() — quando um toast precisa renderizar).
// Manter os textos longos em PT-BR fora do chunk crítico é o que segura o
// orçamento mesmo com o catálogo crescendo.
// ----------------------------------------------------------------------------

// ===================== RARIDADES (define XP) =====================
export const RARITY = Object.freeze({
    comum:    { xp: 10,  label: 'Comum',    cls: 'ach-r-comum'    },
    raro:     { xp: 25,  label: 'Raro',     cls: 'ach-r-raro'     },
    epico:    { xp: 50,  label: 'Épico',    cls: 'ach-r-epico'    },
    lendario: { xp: 100, label: 'Lendário', cls: 'ach-r-lendario' },
    oculta:   { xp: 40,  label: 'Secreta',  cls: 'ach-r-oculta'   },
});

// A ESCADA DE NÍVEIS (LEVELS) e a derivação de nível/XP (computeLevel) vivem em
// achievements-catalog.js (lazy): só são lidas na tela de Configurações, nunca
// no dashboard em si — mantê-las fora do chunk crítico economiza orçamento.

// ===================== HELPERS DE MÉTRICA =====================
function _num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

// Mirror EXATO do cálculo de saldo do dashboard (entrada+/saida-/reserva-/retirada+).
function _saldo(transacoes) {
    let s = 0;
    for (const t of transacoes) {
        const v = Math.abs(_num(t.valor));
        if      (t.categoria === 'entrada')          s += v;
        else if (t.categoria === 'saida')            s -= v;
        else if (t.categoria === 'reserva')          s -= v;
        else if (t.categoria === 'retirada_reserva') s += v;
    }
    return s;
}
function _reservado(metas) {
    return metas.reduce((s, m) => s + Math.max(0, _num(m.saved)), 0);
}
// Patrimônio = saldo em conta + total reservado em metas.
function _patrimonio(state) {
    return _saldo(state.transacoes) + _reservado(state.metas);
}

// Normaliza t.data ("DD/MM/YYYY" pt-BR OU "YYYY-MM-DD" ISO) → "YYYY-MM".
function _mesKey(data) {
    if (typeof data !== 'string') return null;
    if (data.includes('/')) {
        const p = data.split('/');
        if (p.length === 3) return `${p[2]}-${p[1].padStart(2, '0')}`;
    }
    if (data.includes('-') && data.length >= 7) return data.slice(0, 7);
    return null;
}
// Decompõe t.data em { d, m, y } numéricos (aceita os dois formatos), ou null.
function _ymd(data) {
    if (typeof data !== 'string') return null;
    if (data.includes('/')) {
        const p = data.split('/');
        if (p.length === 3) return { d: +p[0], m: +p[1], y: +p[2] };
    }
    if (data.includes('-')) {
        const p = data.split('-');
        if (p.length >= 3) return { y: +p[0], m: +p[1], d: parseInt(p[2], 10) };
    }
    return null;
}
function _ehFimDeSemana(data) {
    const o = _ymd(data);
    if (!o || !o.y || !o.m || !o.d) return false;
    const wd = new Date(o.y, o.m - 1, o.d).getDay();
    return wd === 0 || wd === 6;
}
// Agrupa transações por mês: { ent, sai, n } (sai inclui saída no crédito).
function _porMes(transacoes) {
    const m = new Map();
    for (const t of transacoes) {
        const k = _mesKey(t.data);
        if (!k) continue;
        if (!m.has(k)) m.set(k, { ent: 0, sai: 0, n: 0 });
        const o = m.get(k);
        o.n++;
        const v = Math.abs(_num(t.valor));
        if      (t.categoria === 'entrada')                                   o.ent += v;
        else if (t.categoria === 'saida' || t.categoria === 'saida_credito')  o.sai += v;
    }
    return m;
}
// Nº de meses com alguma movimentação (usado no caminho de render/progresso).
function _mesesAtivos(transacoes) { return _porMes(transacoes).size; }
// ── Variantes que recebem o Map já agrupado (memoizado por avaliação) ──
function _gastoMedioMap(m) {
    const meses = [...m.values()].filter(o => o.sai > 0);
    if (meses.length === 0) return 0;
    return meses.reduce((s, o) => s + o.sai, 0) / meses.length;
}
function _temMesEconomiaMap(m, ratio) {
    for (const o of m.values()) {
        if (o.ent > 0 && (o.ent - o.sai) / o.ent >= ratio) return true;
    }
    return false;
}
function _temMesPositivoMap(m) {
    for (const o of m.values()) {
        if (o.ent > 0 && o.ent > o.sai) return true;
    }
    return false;
}
function _contaMesesPositivosMap(m) {
    let n = 0;
    for (const o of m.values()) if (o.ent > 0 && o.ent > o.sai) n++;
    return n;
}
// Hora "HH:MM:SS" → hora inteira, ou null.
function _horaInt(hora) {
    if (typeof hora !== 'string') return null;
    const h = parseInt(hora.slice(0, 2), 10);
    return Number.isInteger(h) && h >= 0 && h < 24 ? h : null;
}
function _orcamentosDefinidos(orcamentos) {
    if (!orcamentos || typeof orcamentos !== 'object') return 0;
    return Object.values(orcamentos).filter(v => _num(v) > 0).length;
}
function _metasConcluidas(metas) {
    return metas.filter(m => _num(m.objetivo) > 0 && _num(m.saved) >= _num(m.objetivo)).length;
}

// ── Métricas públicas para o catálogo de apresentação (barras de progresso) ──
// O catálogo (lazy) importa estas para suas funções `progresso(state)`. Manter
// uma única fonte de verdade evita divergência com os predicados `check`.
export const metrics = Object.freeze({
    patrimonio:   (s) => _patrimonio(s),
    reservado:    (s) => _reservado(s.metas),
    mesesAtivos:  (s) => _mesesAtivos(s.transacoes),
});

// ===================== CATÁLOGO (avaliação) =====================
// Cada item: { id, rarity, hidden?, check(state, ctx) }.
// A APRESENTAÇÃO (título/descrição/ícone/categoria/progresso) está em
// achievements-catalog.js — casada por `id`. Ao adicionar uma conquista aqui,
// adicione a entrada correspondente lá.
export const ACHIEVEMENTS = Object.freeze([
    // ---- Primeiros passos (comum) ----
    { id: 'primeiro_perfil',     rarity: 'comum', check: (s) => s.perfisCount >= 1 },
    { id: 'primeira_transacao',  rarity: 'comum', check: (s) => s.transacoes.length >= 1 },
    { id: 'primeira_entrada',    rarity: 'comum', check: (s) => s.transacoes.some(t => t.categoria === 'entrada') },
    { id: 'primeira_saida',      rarity: 'comum', check: (s) => s.transacoes.some(t => t.categoria === 'saida') },
    { id: 'primeiro_cartao',     rarity: 'comum', check: (s) => s.cartoesCredito.length >= 1 },
    { id: 'primeira_reserva',    rarity: 'comum', check: (s) => s.metas.length >= 1 },
    { id: 'primeira_conta',      rarity: 'comum', check: (s) => s.contasFixas.length >= 1 },
    { id: 'primeira_assinatura', rarity: 'comum', check: (s) => (s.assinaturas || []).length >= 1 },
    { id: 'orcamento_definido',  rarity: 'comum', check: (s) => _orcamentosDefinidos(s.orcamentos) >= 1 },
    { id: 'quebrou_cofre',       rarity: 'comum', check: (s) => s.transacoes.some(t => t.categoria === 'retirada_reserva') },

    // ---- Patrimônio (escala comum → lendário) ----
    { id: 'patrimonio_1k',   rarity: 'comum',    check: (s, ctx) => ctx.m.patrimonio >= 1000 },
    { id: 'patrimonio_10k',  rarity: 'raro',     check: (s, ctx) => ctx.m.patrimonio >= 10000 },
    { id: 'patrimonio_50k',  rarity: 'epico',    check: (s, ctx) => ctx.m.patrimonio >= 50000 },
    { id: 'patrimonio_100k', rarity: 'epico',    check: (s, ctx) => ctx.m.patrimonio >= 100000 },
    { id: 'patrimonio_250k', rarity: 'epico',    check: (s, ctx) => ctx.m.patrimonio >= 250000 },
    { id: 'patrimonio_500k', rarity: 'lendario', check: (s, ctx) => ctx.m.patrimonio >= 500000 },
    { id: 'patrimonio_1m',   rarity: 'lendario', check: (s, ctx) => ctx.m.patrimonio >= 1000000 },

    // ---- Reservas / metas ----
    { id: 'reserva_5k',            rarity: 'raro',  check: (s, ctx) => ctx.m.reservado >= 5000 },
    { id: 'reserva_20k',           rarity: 'epico', check: (s, ctx) => ctx.m.reservado >= 20000 },
    { id: 'meta_concluida',        rarity: 'raro',  check: (s) => _metasConcluidas(s.metas) >= 1 },
    { id: 'duas_metas_concluidas', rarity: 'epico', check: (s) => _metasConcluidas(s.metas) >= 2 },
    { id: 'meta_grande',           rarity: 'epico', check: (s) => s.metas.some(m => _num(m.objetivo) >= 10000 && _num(m.saved) >= _num(m.objetivo)) },
    { id: 'tres_metas',            rarity: 'raro',  check: (s) => s.metas.length >= 3 },
    { id: 'cinco_metas',           rarity: 'epico', check: (s) => s.metas.length >= 5 },
    { id: 'reserva_emergencia',    rarity: 'epico', check: (s, ctx) => ctx.m.gastoMedio > 0 && ctx.m.reservado >= 3 * ctx.m.gastoMedio },

    // ---- Hábito / consistência ----
    { id: 'dez_transacoes',        rarity: 'comum',    check: (s) => s.transacoes.length >= 10 },
    { id: 'vinte_cinco_transacoes',rarity: 'comum',    check: (s) => s.transacoes.length >= 25 },
    { id: 'cinquenta_transacoes',  rarity: 'raro',     check: (s) => s.transacoes.length >= 50 },
    { id: 'cem_transacoes',        rarity: 'epico',    check: (s) => s.transacoes.length >= 100 },
    { id: 'mes_positivo',          rarity: 'raro',     check: (s, ctx) => _temMesPositivoMap(ctx.m.mensal) },
    { id: 'tres_meses_positivos',  rarity: 'epico',    check: (s, ctx) => _contaMesesPositivosMap(ctx.m.mensal) >= 3 },
    { id: 'economia_30',           rarity: 'epico',    check: (s, ctx) => _temMesEconomiaMap(ctx.m.mensal, 0.30) },
    { id: 'economia_50',           rarity: 'lendario', check: (s, ctx) => _temMesEconomiaMap(ctx.m.mensal, 0.50) },
    { id: 'tres_meses',            rarity: 'raro',     check: (s, ctx) => ctx.m.mesesAtivos >= 3 },
    { id: 'seis_meses',            rarity: 'epico',    check: (s, ctx) => ctx.m.mesesAtivos >= 6 },
    { id: 'doze_meses',            rarity: 'lendario', check: (s, ctx) => ctx.m.mesesAtivos >= 12 },

    // ---- Organização ----
    { id: 'tres_cartoes',     rarity: 'raro',  check: (s) => s.cartoesCredito.length >= 3 },
    { id: 'cinco_cartoes',    rarity: 'epico', check: (s) => s.cartoesCredito.length >= 5 },
    { id: 'tres_contas',      rarity: 'raro',  check: (s) => s.contasFixas.length >= 3 },
    { id: 'cinco_contas',     rarity: 'epico', check: (s) => s.contasFixas.length >= 5 },
    { id: 'tres_assinaturas', rarity: 'raro',  check: (s) => (s.assinaturas || []).length >= 3 },
    { id: 'orcamento_3',      rarity: 'raro',  check: (s) => _orcamentosDefinidos(s.orcamentos) >= 3 },
    { id: 'orcamento_5',      rarity: 'epico', check: (s) => _orcamentosDefinidos(s.orcamentos) >= 5 },
    { id: 'orcamento_10',     rarity: 'epico', check: (s) => _orcamentosDefinidos(s.orcamentos) >= 10 },

    // ---- Desafios (alimentadas por perfilData.desafios via state) ----
    { id: 'primeiro_desafio', rarity: 'raro',     check: (s) => _num(s.desafiosConcluidos) >= 1 },
    { id: 'tres_desafios',    rarity: 'epico',    check: (s) => _num(s.desafiosConcluidos) >= 3 },
    { id: 'dez_desafios',     rarity: 'lendario', check: (s) => _num(s.desafiosConcluidos) >= 10 },

    // ---- Hábito extra ----
    { id: 'duzentas_transacoes',  rarity: 'epico',    check: (s) => s.transacoes.length >= 200 },
    { id: 'seis_meses_positivos', rarity: 'lendario', check: (s, ctx) => _contaMesesPositivosMap(ctx.m.mensal) >= 6 },

    // ---- Ocultas / secretas (🥚) ----
    { id: 'consciente',    rarity: 'oculta', hidden: true, check: (s) => s.horasVidaAtivo === true },
    { id: 'economia_70',   rarity: 'oculta', hidden: true, check: (s, ctx) => _temMesEconomiaMap(ctx.m.mensal, 0.70) },
    { id: 'coruja',        rarity: 'oculta', hidden: true, check: (s) => s.transacoes.some(t => { const h = _horaInt(t.hora); return h !== null && h < 4; }) },
    { id: 'madrugador',    rarity: 'oculta', hidden: true, check: (s) => s.transacoes.some(t => { const h = _horaInt(t.hora); return h !== null && h >= 5 && h < 8; }) },
    { id: 'ano_novo',      rarity: 'oculta', hidden: true, check: (s) => s.transacoes.some(t => { const o = _ymd(t.data); return !!o && o.d === 1 && o.m === 1; }) },
    { id: 'fim_de_semana', rarity: 'oculta', hidden: true, check: (s) => s.transacoes.some(t => _ehFimDeSemana(t.data)) },
    { id: 'dedicado',      rarity: 'oculta', hidden: true, check: (s) => s.transacoes.length >= 250 },
    { id: 'quinhentas',    rarity: 'oculta', hidden: true, check: (s) => s.transacoes.length >= 500 },
    { id: 'colecionador',  rarity: 'oculta', hidden: true, check: (s, ctx) => ctx.unlockedCount >= 20 },
    { id: 'cacador',       rarity: 'oculta', hidden: true, check: (s, ctx) => ctx.unlockedCount >= 35 },

    // ---- Grande final (lendária secreta): tudo menos ela mesma ----
    { id: 'perfeccionista', rarity: 'lendario', hidden: true, check: (s, ctx) => ctx.unlockedCount >= ACHIEVEMENTS.length - 1 },
]);

/**
 * Devolve um mapa LIMPO de desbloqueios — copia APENAS ids conhecidos do
 * catálogo com valor string. Nunca itera chaves não-confiáveis do input
 * (defesa contra prototype pollution / blob corrompido). Usado na hidratação
 * e antes de persistir.
 */
export function sanitizeUnlocked(map) {
    const clean = {};
    if (!map || typeof map !== 'object') return clean;
    for (const a of ACHIEVEMENTS) {
        const v = map[a.id];
        if (typeof v === 'string' && v.length <= 40) clean[a.id] = v;
    }
    return clean;
}

// ===================== ENGINE DE AVALIAÇÃO =====================
/**
 * Avalia o estado contra o catálogo e MUTA `unlocked` com os novos desbloqueios.
 * Usa ponto-fixo (até 4 passes) p/ meta-conquistas encadeadas: ex.
 * base → "Colecionador"/"Caçador" (dependem de contagem) → "Perfeccionista"
 * (depende destas). `ctx.unlockedCount` é fixo por pass, então cada nível da
 * cadeia precisa de um pass; o loop para sozimo quando nada muda (early-out).
 * Memoiza (1 vez por avaliação) saldo/patrimônio/agrupamento mensal — evita
 * reconstruí-los em cada predicado a cada save.
 * @returns {{ unlocked: Object, newly: Array }}
 */
export function evaluate(state, unlocked) {
    unlocked = unlocked && typeof unlocked === 'object' ? unlocked : {};
    const newly = [];

    // Early-out: tudo já desbloqueado → nada a recomputar.
    let jaFeitas = 0;
    for (const a of ACHIEVEMENTS) if (unlocked[a.id]) jaFeitas++;
    if (jaFeitas >= ACHIEVEMENTS.length) return { unlocked, newly };

    // Memo de métricas caras (estáveis durante toda a avaliação).
    const mensal = _porMes(state.transacoes);
    const memo = {
        mensal,
        patrimonio:  _patrimonio(state),
        reservado:   _reservado(state.metas),
        mesesAtivos: mensal.size,
        gastoMedio:  _gastoMedioMap(mensal),
    };

    for (let pass = 0; pass < 4; pass++) {
        const ctx = { unlockedCount: Object.keys(unlocked).length, m: memo };
        let changed = false;
        for (const a of ACHIEVEMENTS) {
            if (unlocked[a.id]) continue;
            let ok = false;
            try { ok = !!a.check(state, ctx); } catch { ok = false; }
            if (ok) {
                unlocked[a.id] = new Date().toISOString();
                newly.push(a);
                changed = true;
            }
        }
        if (!changed) break;
    }
    return { unlocked, newly };
}

// computeLevel (derivação de nível/XP) vive em achievements-catalog.js (lazy).

// ===================== TOAST ESTILO STEAM =====================
// A apresentação (título/desc/ícone) NÃO está neste chunk — é buscada sob
// demanda em achievements-catalog.js na 1ª vez que um toast precisa renderizar.
// Toasts são eventos raros e não-críticos de latência, então o import() lazy
// é aceitável e mantém os textos longos fora do chunk crítico do dashboard.
let _toastHost = null;
let _toastQueue = [];
let _toastActive = false;
let _catalogPromise = null;

function _loadCatalog() {
    if (!_catalogPromise) {
        _catalogPromise = import('./achievements-catalog.js?v=1').catch(() => null);
    }
    return _catalogPromise;
}

function _ensureHost() {
    if (_toastHost && document.body.contains(_toastHost)) return _toastHost;
    _toastHost = document.createElement('div');
    _toastHost.className = 'ach-toast-host';
    _toastHost.setAttribute('role', 'status');
    _toastHost.setAttribute('aria-live', 'polite');
    document.body.appendChild(_toastHost);
    return _toastHost;
}

function _vibrar() {
    try { if (navigator.vibrate) navigator.vibrate([14, 40, 14]); } catch {}
}

async function _drenarFila() {
    if (_toastActive) return;
    const a = _toastQueue.shift();
    if (!a) return;
    _toastActive = true;

    // Resolve a apresentação sob demanda (cache via _catalogPromise).
    let p = null;
    try { p = (await _loadCatalog())?.getPresent?.(a.id) || null; } catch { p = null; }
    const titulo = p?.titulo || 'Conquista desbloqueada';
    const desc   = p?.desc   || '';
    const icon   = p?.icon   || 'fa-trophy';

    const host = _ensureHost();
    const card = document.createElement('div');
    card.className = `ach-toast ${RARITY[a.rarity]?.cls || 'ach-r-comum'}`;

    const ic = document.createElement('div');
    ic.className = 'ach-toast__icon';
    const _icel = document.createElement('i');
    _icel.className = 'fas ' + (/^fa-[a-z0-9-]+$/.test(icon) ? icon : 'fa-trophy');
    _icel.setAttribute('aria-hidden', 'true');
    ic.appendChild(_icel);

    const body = document.createElement('div');
    body.className = 'ach-toast__body';

    const kicker = document.createElement('div');
    kicker.className = 'ach-toast__kicker';
    kicker.textContent = 'Conquista desbloqueada';

    const tituloEl = document.createElement('div');
    tituloEl.className = 'ach-toast__title';
    tituloEl.textContent = titulo;

    const descEl = document.createElement('div');
    descEl.className = 'ach-toast__desc';
    descEl.textContent = desc;

    body.append(kicker, tituloEl, descEl);
    card.append(ic, body);
    host.appendChild(card);

    _vibrar();

    // Anima entrada no próximo frame
    requestAnimationFrame(() => card.classList.add('is-in'));

    const reduz = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    const dur = reduz ? 3200 : 4600;

    const sair = () => {
        card.classList.remove('is-in');
        card.classList.add('is-out');
        setTimeout(() => {
            card.remove();
            _toastActive = false;
            _drenarFila();
        }, reduz ? 60 : 360);
    };

    const timer = setTimeout(sair, dur);
    card.addEventListener('click', () => { clearTimeout(timer); sair(); });
}

/** Enfileira toasts para uma lista de conquistas (objetos do catálogo). */
export function enqueueToasts(lista) {
    if (!Array.isArray(lista) || lista.length === 0) return;
    _toastQueue.push(...lista);
    _drenarFila();
}

// A renderização da TELA de conquistas (grid + hero) vive em achievements-ui.js
// e a apresentação (textos) em achievements-catalog.js — ambos fora do chunk
// crítico do dashboard.
