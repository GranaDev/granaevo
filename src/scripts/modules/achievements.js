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
// Toda renderização usa DOM seguro (textContent / sem innerHTML com dado
// dinâmico). Os textos das conquistas são estáticos definidos aqui.
// ----------------------------------------------------------------------------

// ===================== RARIDADES (define XP) =====================
export const RARITY = Object.freeze({
    comum:    { xp: 10,  label: 'Comum',    cls: 'ach-r-comum'    },
    raro:     { xp: 25,  label: 'Raro',     cls: 'ach-r-raro'     },
    epico:    { xp: 50,  label: 'Épico',    cls: 'ach-r-epico'    },
    lendario: { xp: 100, label: 'Lendário', cls: 'ach-r-lendario' },
    oculta:   { xp: 40,  label: 'Secreta',  cls: 'ach-r-oculta'   },
});

// ===================== ESCADA DE NÍVEIS / TÍTULOS =====================
// Títulos descontraídos, ganhos por XP acumulado. Max alcançável (~895 XP)
// chega a "Lenda das Finanças".
export const LEVELS = Object.freeze([
    { nivel: 1, titulo: 'Iniciante',          xp: 0   },
    { nivel: 2, titulo: 'Pé-de-Meia',         xp: 40  },
    { nivel: 3, titulo: 'Poupador',           xp: 100 },
    { nivel: 4, titulo: 'Economista',         xp: 190 },
    { nivel: 5, titulo: 'Investidor',         xp: 320 },
    { nivel: 6, titulo: 'Estrategista',       xp: 480 },
    { nivel: 7, titulo: 'Magnata',            xp: 660 },
    { nivel: 8, titulo: 'Lenda das Finanças', xp: 850 },
]);

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
// O caminho de avaliação (check) roda a cada save; estas evitam reconstruir
// o agrupamento mensal várias vezes por avaliação.
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

// Formatação BRL de fallback (a UI passa a do dashboard quando disponível).
function _brl(v) {
    try { return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }
    catch { return 'R$ ' + Math.round(v); }
}

// ===================== CATÁLOGO (~28 conquistas) =====================
// Cada item: { id, titulo, desc, icon, rarity, hidden?, check(state,ctx), progresso?(state)->{atual,alvo,fmt?} }
export const ACHIEVEMENTS = Object.freeze([
    // ---- Primeiros passos (comum) ----
    { id: 'primeiro_perfil',    titulo: 'Primeiro Passo',    desc: 'Criou seu primeiro perfil no GranaEvo.',                icon: '🏦', rarity: 'comum',
      check: (s) => s.perfisCount >= 1 },
    { id: 'primeira_transacao', titulo: 'Mãos à Obra',       desc: 'Registrou sua primeira transação.',                     icon: '📝', rarity: 'comum',
      check: (s) => s.transacoes.length >= 1 },
    { id: 'primeira_entrada',   titulo: 'Primeiro Trocado',  desc: 'Registrou sua primeira entrada de dinheiro.',           icon: '💵', rarity: 'comum',
      check: (s) => s.transacoes.some(t => t.categoria === 'entrada') },
    { id: 'primeiro_cartao',    titulo: 'Plástico na Mesa',  desc: 'Cadastrou seu primeiro cartão de crédito.',             icon: '💳', rarity: 'comum',
      check: (s) => s.cartoesCredito.length >= 1 },
    { id: 'primeira_reserva',   titulo: 'Sonhador',          desc: 'Criou sua primeira meta / reserva.',                    icon: '🎯', rarity: 'comum',
      check: (s) => s.metas.length >= 1 },
    { id: 'primeira_conta',     titulo: 'Contas em Dia',     desc: 'Cadastrou sua primeira conta fixa.',                    icon: '📅', rarity: 'comum',
      check: (s) => s.contasFixas.length >= 1 },

    // ---- Patrimônio (escala comum → lendário) ----
    { id: 'patrimonio_1k',   titulo: 'Primeiro Mil',     desc: 'Acumulou R$ 1.000 de patrimônio (saldo + reservas).',  icon: '🪙', rarity: 'comum',
      check: (s, ctx) => ctx.m.patrimonio >= 1000,    progresso: (s) => ({ atual: _patrimonio(s), alvo: 1000,    fmt: _brl }) },
    { id: 'patrimonio_10k',  titulo: 'Cinco Dígitos',    desc: 'Alcançou R$ 10.000 de patrimônio.',                    icon: '💰', rarity: 'raro',
      check: (s, ctx) => ctx.m.patrimonio >= 10000,   progresso: (s) => ({ atual: _patrimonio(s), alvo: 10000,   fmt: _brl }) },
    { id: 'patrimonio_50k',  titulo: 'Meio Caminho',     desc: 'Alcançou R$ 50.000 de patrimônio.',                    icon: '🏆', rarity: 'epico',
      check: (s, ctx) => ctx.m.patrimonio >= 50000,   progresso: (s) => ({ atual: _patrimonio(s), alvo: 50000,   fmt: _brl }) },
    { id: 'patrimonio_100k', titulo: 'Seis Dígitos',     desc: 'Alcançou R$ 100.000 de patrimônio.',                   icon: '👑', rarity: 'epico',
      check: (s, ctx) => ctx.m.patrimonio >= 100000,  progresso: (s) => ({ atual: _patrimonio(s), alvo: 100000,  fmt: _brl }) },
    { id: 'patrimonio_500k', titulo: 'Quase Milionário', desc: 'Alcançou R$ 500.000 de patrimônio.',                   icon: '💎', rarity: 'lendario',
      check: (s, ctx) => ctx.m.patrimonio >= 500000,  progresso: (s) => ({ atual: _patrimonio(s), alvo: 500000,  fmt: _brl }) },
    { id: 'patrimonio_1m',   titulo: 'Primeiro Milhão',  desc: 'Alcançou R$ 1.000.000 de patrimônio. Lenda!',          icon: '🦄', rarity: 'lendario',
      check: (s, ctx) => ctx.m.patrimonio >= 1000000, progresso: (s) => ({ atual: _patrimonio(s), alvo: 1000000, fmt: _brl }) },

    // ---- Reservas / metas ----
    { id: 'reserva_5k',         titulo: 'Colchão de Segurança', desc: 'Juntou R$ 5.000 somando todas as reservas.',         icon: '🛡️', rarity: 'raro',
      check: (s, ctx) => ctx.m.reservado >= 5000, progresso: (s) => ({ atual: _reservado(s.metas), alvo: 5000, fmt: _brl }) },
    { id: 'meta_concluida',     titulo: 'Objetivo Alcançado',   desc: 'Concluiu uma meta (juntou 100% do objetivo).',       icon: '✅', rarity: 'raro',
      check: (s) => s.metas.some(m => _num(m.objetivo) > 0 && _num(m.saved) >= _num(m.objetivo)) },
    { id: 'tres_metas',         titulo: 'Multi-Metas',          desc: 'Mantém 3 reservas ativas ao mesmo tempo.',           icon: '🎲', rarity: 'raro',
      check: (s) => s.metas.length >= 3, progresso: (s) => ({ atual: s.metas.length, alvo: 3 }) },
    { id: 'reserva_emergencia', titulo: 'Blindado',             desc: 'Suas reservas cobrem 3x seu gasto mensal médio.',    icon: '🧯', rarity: 'epico',
      check: (s, ctx) => ctx.m.gastoMedio > 0 && ctx.m.reservado >= 3 * ctx.m.gastoMedio },

    // ---- Hábito / consistência ----
    { id: 'dez_transacoes', titulo: 'Contador',          desc: 'Registrou 10 transações.',                          icon: '📊', rarity: 'comum',
      check: (s) => s.transacoes.length >= 10,  progresso: (s) => ({ atual: s.transacoes.length, alvo: 10 }) },
    { id: 'cem_transacoes', titulo: 'Maratonista',       desc: 'Registrou 100 transações. Que disciplina!',         icon: '📚', rarity: 'epico',
      check: (s) => s.transacoes.length >= 100, progresso: (s) => ({ atual: s.transacoes.length, alvo: 100 }) },
    { id: 'mes_positivo',   titulo: 'No Azul',           desc: 'Fechou um mês com entradas maiores que saídas.',    icon: '📈', rarity: 'raro',
      check: (s, ctx) => _temMesPositivoMap(ctx.m.mensal) },
    { id: 'economia_30',    titulo: 'Economia de Mestre',desc: 'Economizou 30% da sua renda em um mês.',            icon: '✂️', rarity: 'epico',
      check: (s, ctx) => _temMesEconomiaMap(ctx.m.mensal, 0.30) },
    { id: 'tres_meses',     titulo: 'Disciplina',        desc: 'Registrou movimentações em 3 meses diferentes.',    icon: '🔥', rarity: 'raro',
      check: (s, ctx) => ctx.m.mesesAtivos >= 3, progresso: (s) => ({ atual: _mesesAtivos(s.transacoes), alvo: 3 }) },
    { id: 'seis_meses',     titulo: 'Veterano',          desc: 'Acompanhou suas finanças por 6 meses diferentes.',  icon: '🗓️', rarity: 'epico',
      check: (s, ctx) => ctx.m.mesesAtivos >= 6, progresso: (s) => ({ atual: _mesesAtivos(s.transacoes), alvo: 6 }) },

    // ---- Organização ----
    { id: 'tres_cartoes',        titulo: 'Carteira Cheia', desc: 'Cadastrou 3 cartões de crédito.',                  icon: '💼', rarity: 'raro',
      check: (s) => s.cartoesCredito.length >= 3, progresso: (s) => ({ atual: s.cartoesCredito.length, alvo: 3 }) },
    { id: 'orcamento_definido',  titulo: 'Planejador',     desc: 'Definiu um orçamento para alguma categoria.',      icon: '🎚️', rarity: 'comum',
      check: (s) => _orcamentosDefinidos(s.orcamentos) >= 1 },
    { id: 'primeira_assinatura', titulo: 'Vida Recorrente',desc: 'Cadastrou uma assinatura recorrente.',             icon: '🔁', rarity: 'comum',
      check: (s) => (s.assinaturas || []).length >= 1 },

    // ---- Ocultas / secretas (🥚) ----
    { id: 'coruja',       titulo: 'Coruja Financeira', desc: 'Registrou uma transação na madrugada (0h–4h).',    icon: '🦉', rarity: 'oculta', hidden: true,
      check: (s) => s.transacoes.some(t => { const h = _horaInt(t.hora); return h !== null && h < 4; }) },
    { id: 'dedicado',     titulo: 'Dedicação Total',   desc: 'Registrou 250 transações. Você vive o GranaEvo!',  icon: '💪', rarity: 'oculta', hidden: true,
      check: (s) => s.transacoes.length >= 250 },
    { id: 'colecionador', titulo: 'Colecionador',      desc: 'Desbloqueou 20 conquistas. Caçador nato!',         icon: '🏅', rarity: 'oculta', hidden: true,
      check: (s, ctx) => ctx.unlockedCount >= 20 },
]);

const _BY_ID = Object.freeze(Object.fromEntries(ACHIEVEMENTS.map(a => [a.id, a])));
export function getById(id) {
    // hasOwnProperty: nunca resolve para Object.prototype via chave maliciosa (__proto__).
    return Object.prototype.hasOwnProperty.call(_BY_ID, id) ? _BY_ID[id] : null;
}

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
 * Usa ponto-fixo (até 2 passes) p/ meta-conquistas como "Colecionador".
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

    for (let pass = 0; pass < 2; pass++) {
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

/** Soma de XP + nível/título derivados do mapa de desbloqueios.
 *  Itera o CATÁLOGO (ids confiáveis), nunca as chaves do mapa do cliente. */
export function computeLevel(unlocked) {
    unlocked = unlocked && typeof unlocked === 'object' ? unlocked : {};
    let xp = 0;
    for (const a of ACHIEVEMENTS) {
        if (unlocked[a.id]) xp += RARITY[a.rarity].xp;
    }
    let lvl = LEVELS[0], next = null;
    for (let i = 0; i < LEVELS.length; i++) {
        if (xp >= LEVELS[i].xp) { lvl = LEVELS[i]; next = LEVELS[i + 1] || null; }
    }
    const base = lvl.xp;
    const ceil = next ? next.xp : lvl.xp;
    const pct  = next ? Math.min(100, Math.round(((xp - base) / (ceil - base)) * 100)) : 100;
    return {
        xp,
        nivel: lvl.nivel,
        titulo: lvl.titulo,
        proxTitulo: next ? next.titulo : null,
        xpFalta: next ? (ceil - xp) : 0,
        pct,
    };
}

// ===================== TOAST ESTILO STEAM =====================
let _toastHost = null;
let _toastQueue = [];
let _toastActive = false;

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

function _drenarFila() {
    if (_toastActive) return;
    const a = _toastQueue.shift();
    if (!a) return;
    _toastActive = true;

    const host = _ensureHost();
    const card = document.createElement('div');
    card.className = `ach-toast ${RARITY[a.rarity].cls}`;

    const ic = document.createElement('div');
    ic.className = 'ach-toast__icon';
    ic.textContent = a.icon;

    const body = document.createElement('div');
    body.className = 'ach-toast__body';

    const kicker = document.createElement('div');
    kicker.className = 'ach-toast__kicker';
    kicker.textContent = 'Conquista desbloqueada';

    const titulo = document.createElement('div');
    titulo.className = 'ach-toast__title';
    titulo.textContent = a.titulo;

    const desc = document.createElement('div');
    desc.className = 'ach-toast__desc';
    desc.textContent = a.desc;

    body.append(kicker, titulo, desc);
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
// para não pesar no chunk principal (este módulo é importado pelo dashboard.js).
