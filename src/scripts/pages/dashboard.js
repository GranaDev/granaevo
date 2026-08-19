// ========== IMPORTS ESSENCIAIS ==========
import { supabase, refreshSession as hybridRefresh, getValidAccessToken } from '../services/supabase-client.js?v=2';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../services/supabase-client.js?v=2';
import { dataManager } from '../modules/data-manager.js?v=8';
import AuthGuard from '../modules/auth-guard.js?v=2';
import '../modules/scroll-lock.js?v=1';
import { initErrorTracking, setUserContext } from '../modules/error-tracking.js';
import { perfMark, perfMeasure } from '../modules/perf-marks.js';
import { migrarCompra, anexarParcelas, ehParcelaAntiga, valorAbertoFatura } from '../modules/fatura-parcelas.js?v=1';
import { evaluate as evaluateConquistas, enqueueToasts as enqueueConquistaToasts, sanitizeUnlocked as sanitizeConquistas } from '../modules/achievements.js?v=2';
import { sanitizarConfigPerfil as _sanitizarConfigPerfilPuro } from '../modules/config-perfil.js';
import { aplicarMascaraMoeda, lerMoeda, definirMoeda } from '../modules/mascara-moeda.js?v=1';
import { novoId } from '../modules/registro-id.js?v=1';

// Inicializa rastreamento de erros o quanto antes (no-op sem VITE_SENTRY_DSN / fora de produção)
initErrorTracking();

// ========== CONSTANTES ==========
const IS_DEV = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

// requestIdleCallback com fallback (Safari/iOS < 16 não têm) — usado para fatiar
// trabalho não-crítico do boot e liberar a main thread mais cedo em CPU fraca.
const _idle = (fn) => (typeof window.requestIdleCallback === 'function'
    ? window.requestIdleCallback(fn, { timeout: 1200 })
    : setTimeout(fn, 1));

// ========== ESTADO GLOBAL ==========
let usuarioLogado = {
    userId: null,     
    nome: "",          
    email: "",         
    plano: "",
    perfis: []
};

let perfilAtivo = null;
let cartoesCredito = [];
let nextCartaoId = 1;
let transacoes = [];
let filtroMovAtivo = 'mes_atual';
let filtroMovMes   = null;
let filtroMovAno   = null;
let metas = [];
let contasFixas = [];
let assinaturas = [];
let nextTransId = 1;
let nextMetaId = 1;
let nextContaFixaId = 1;
let metaSelecionadaId = null;
let cartaoSelecionadoId = null;
let tipoRelatorioAtivo = 'individual';
let orcamentos = {}; // { 'Mercado': { limite: 800 }, 'Lazer': { limite: 300 }, ... }
let tiposPersonalizados = []; // tipos criados pelo usuário, ex: ['Academia em Casa', 'Delivery Especial']
let conquistasPerfil = {};    // mapa { idConquista: ISOdate } — desbloqueios do perfil ativo
let configPerfil = {};        // preferências do perfil (ex.: horasVida) — sanitizado no save
let desafiosPerfil = { ativos: [], historico: [] }; // desafios financeiros (módulo lazy desafios.js)
let _conquistasReady = false; // false durante o backfill silencioso (boot/troca de perfil)
let _effectiveUserId = null;
let _effectiveEmail  = null;
let _allProfilesData = []; // cache local de todos os perfis — fonte de verdade para o save
let _cachedAuthToken = null; // token cacheado para beforeunload (fetch+keepalive)

// Cache de cópias congeladas para window.transacoes / metas / contasFixas / cartoesCredito
// Declarado no escopo do módulo para que salvarDados() e atualizarReferenciasGlobais()
// possam invalidá-lo. Sem isso o getter retorna o array vazio do boot para sempre.
let _cache = { tx: null, mt: null, cf: null, cc: null };

// Filtro de mês do dashboard (null = mês atual)
let _dashMesFiltro = null; // { mes: '05', ano: '2026' } | null

// Estado compartilhado com módulos lazy-loaded via _ctx
let _movPaginaAtual  = 1;
let _movVisivelCache = [];
let _movDelegateSet  = false;
let _chartJsCarregado  = false;
let _chartJsCarregando = false;
let _gerandoRelatorio  = false;
let _sessionNonce = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `nonce_${Date.now()}_${Math.random().toString(36).slice(2)}`;

// ========== REFERÊNCIAS GLOBAIS ==========

let _GE_snapshot_atual = null;

const _throttledSave = (() => {
    let _ultimaChamada = 0;
    return async function() {
        const agora = Date.now();
        if (agora - _ultimaChamada < 3000) {
            _log.warn('SAVE: chamada throttled');
            return false;
        }
        _ultimaChamada = agora;
        return salvarDados();
    };
})();

// ========== FUNÇÕES UTILITÁRIAS DE SEGURANÇA (RELATÓRIOS) ==========

function sanitizeHTML(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/\x00/g, '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;')
        .replace(/\//g, '&#x2F;')
        .replace(/`/g, '&#x60;');
}

const escapeHTML = sanitizeHTML;

function sanitizeNumber(value, min = 0, max = 999999999) {
    const n = parseFloat(value);
    if (!isFinite(n)) return 0;
    if (n < min) return min;
    if (n > max) return max;
    return n;
}

function sanitizeDate(dateStr) {
    if (!dateStr || typeof dateStr !== 'string') return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
    const [y, m, d] = dateStr.split('-').map(Number);
    if (y < 2000 || y > 2100) return null;
    if (m < 1 || m > 12) return null;
    if (d < 1 || d > 31) return null;
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return null;
    return dateStr;
}

// ── Foto de perfil: limites (RF-04, 2026-07-20) ─────────────────────────────
// A regra ANTIGA rejeitava o arquivo ORIGINAL acima de 2 MB e acima de 4000 px —
// e a maioria das fotos de celular passa dos dois (4032×3024, ~3-5 MB). Resultado:
// a foto era barrada ANTES do compressor, que a deixaria em ~200 KB. Invertido:
// aceitamos uma origem generosa (o arquivo original NUNCA vai ao servidor — o
// canvas re-encoda tudo) e cobramos o limite na SAÍDA, que é o que sobe.
// A origem ainda tem teto para barrar "decode bomb" (imagem que estoura memória).
const _FOTO_ORIGEM_MAX_BYTES = 25 * 1024 * 1024;  // 25 MB de origem
const _FOTO_ORIGEM_MAX_DIM   = 12000;             // px, anti decode-bomb
const _FOTO_SAIDA_DIM        = 1440;              // px — mais nítido em telas retina
const _FOTO_SAIDA_MAX_BYTES  = 400 * 1024;        // 400 KB de saída

function _canvasParaBlob(canvas, q) {
    return new Promise((r) => canvas.toBlob(r, 'image/webp', q));
}

/**
 * Reduz e re-encoda a imagem para WebP. O re-encode pelo canvas é também a
 * defesa: descarta EXIF/GPS e qualquer payload embutido, porque só os PIXELS
 * sobrevivem — o que sai é um arquivo novo, não o do usuário.
 * Qualidade ADAPTATIVA: cai em degraus até a saída caber em _FOTO_SAIDA_MAX_BYTES,
 * então foto pesada vira arquivo leve sem precisar rejeitar nada.
 */
async function _sanitizeImageFile(file) {
    let bitmap = null;
    try {
        bitmap = await createImageBitmap(file);

        if (bitmap.width > _FOTO_ORIGEM_MAX_DIM || bitmap.height > _FOTO_ORIGEM_MAX_DIM) {
            _log.error('SANITIZE_IMG_004', 'Imagem excede a dimensão máxima de origem');
            return null;
        }

        let w = bitmap.width, h = bitmap.height;
        const MAX_DIM = _FOTO_SAIDA_DIM;
        if (w > MAX_DIM || h > MAX_DIM) {
            if (w >= h) { h = Math.round((h / w) * MAX_DIM); w = MAX_DIM; }
            else        { w = Math.round((w / h) * MAX_DIM); h = MAX_DIM; }
        }

        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(bitmap, 0, 0, w, h);
        bitmap.close();
        bitmap = null;

        // Degraus de qualidade até caber no teto de saída.
        let blob = null;
        for (const q of [0.85, 0.75, 0.65, 0.55]) {
            blob = await _canvasParaBlob(canvas, q);
            if (!blob) break;
            if (blob.size <= _FOTO_SAIDA_MAX_BYTES) break;
        }
        if (!blob) {
            _log.error('SANITIZE_IMG_001', 'canvas.toBlob retornou null — upload bloqueado');
            return null;
        }
        if (blob.size > _FOTO_SAIDA_MAX_BYTES) {
            _log.error('SANITIZE_IMG_005', 'Não foi possível comprimir abaixo do limite');
            return null;
        }
        return new File([blob], 'profile.webp', { type: 'image/webp', lastModified: Date.now() });

    } catch (err) {
        _log.error('SANITIZE_IMG_003', err);
        return null;
    } finally {
        if (bitmap) { try { bitmap.close(); } catch (_) { /* ignore */ } }
    }
}

function safeCategorias() {
    return Object.create(null);
}

function validarUserData(userData) {
    if (!userData || typeof userData !== 'object') return false;
    if (!Array.isArray(userData.profiles)) return false;
    return true;
}
// ========== FIM DAS FUNÇÕES UTILITÁRIAS ==========

(function _inicializarGE() {
    const _IS_DEV = IS_DEV;

    // ✅ CORREÇÃO: em produção __GE__ não existe — getter retorna undefined
    //    Extensões maliciosas, XSS e scripts de terceiros não conseguem
    //    enumerar userId, plano ou estado da sessão via window.__GE__
    //    Em DEV mantém apenas perfilAtivo (id/nome) para debug — sem userId
    Object.defineProperty(window, '__GE__', {
        get: () => {
            if (!_IS_DEV) return undefined;
            if (!_GE_snapshot_atual) return null;
            try {
                // ✅ DEV only: expõe apenas dados de UI não-sensíveis
                //    userId e plano removidos mesmo em DEV — use DevTools/Network para isso
                return Object.freeze({
                    perfilAtivo: _GE_snapshot_atual.perfilAtivo
                        ? Object.freeze({
                            id:   _GE_snapshot_atual.perfilAtivo.id,
                            nome: _GE_snapshot_atual.perfilAtivo.nome,
                          })
                        : null,
                    // ✅ isGuest mantido para facilitar debug de fluxo de convidados
                    isGuest: _GE_snapshot_atual.usuarioLogado?.isGuest ?? false,
                });
            } catch {
                return null;
            }
        },
        set:          () => { _log.warn('Tentativa de sobrescrita de __GE__ bloqueada'); },
        configurable: false,
        enumerable:   false,
    });

    // ✅ __GE_save__ mantido apenas em DEV — sem alteração
    if (_IS_DEV) {
        Object.defineProperty(window, '__GE_save__', {
            value:        _throttledSave,
            writable:     false,
            configurable: false,
            enumerable:   false,
        });
    }
})();

(function _inicializarWindowRefs() {
    const _def = (prop, getter) => {
        try {
            Object.defineProperty(window, prop, {
                get:          getter,
                set:          () => _log.warn(`[SEGURANÇA] Tentativa de sobrescrita de window.${prop} bloqueada`),
                configurable: false,
                enumerable:   false,
            });
        } catch (_) {}
    };

    // ✅ perfilAtivo expõe apenas id e nome (sem dados sensíveis) — prod e dev
    _def('perfilAtivo', () => perfilAtivo
        ? Object.freeze({ id: perfilAtivo.id, nome: perfilAtivo.nome })
        : null
    );

    // ✅ Arrays de dados expostos como cópias congeladas (somente leitura)
    //    Necessário para graficos.js (script não-módulo que lê window.transacoes etc.)
    //    Retorna shallow-frozen copies — código externo lê mas não muta o array original

    // _cache está no escopo do módulo — compartilhado com salvarDados() e atualizarReferenciasGlobais()
    _def('transacoes', () => {
        if (!_cache.tx) _cache.tx = Object.freeze(transacoes.map(t => Object.freeze(Object.assign({}, t))));
        return _cache.tx;
    });
    _def('metas', () => {
        if (!_cache.mt) _cache.mt = Object.freeze(metas.map(m => Object.freeze(Object.assign({}, m))));
        return _cache.mt;
    });
    _def('contasFixas', () => {
        if (!_cache.cf) _cache.cf = Object.freeze(contasFixas.map(c => Object.freeze(Object.assign({}, c))));
        return _cache.cf;
    });
    _def('cartoesCredito', () => {
        if (!_cache.cc) _cache.cc = Object.freeze(cartoesCredito.map(c => Object.freeze(Object.assign({}, c))));
        return _cache.cc;
    });

    // ✅ usuarioLogado expõe apenas plano e perfis simplificados — graficos.js precisa do plano
    _def('usuarioLogado', () => Object.freeze({
        plano:  usuarioLogado.plano,
        perfis: Object.freeze(
            (usuarioLogado.perfis || []).map(p => Object.freeze({ id: p.id, nome: p.nome }))
        ),
    }));

    // ✅ Dev-only: aliases com prefixo _dev_ para debugging no console
    if (IS_DEV) {
        _def('_dev_transacoes',  () => Object.freeze(transacoes.map(t => Object.freeze(Object.assign({}, t)))));
        _def('_dev_metas',       () => Object.freeze(metas.map(m => Object.freeze(Object.assign({}, m)))));
        _def('_dev_contasFixas', () => Object.freeze(contasFixas.map(c => Object.freeze(Object.assign({}, c)))));
    }
})();

function atualizarReferenciasGlobais() {
    _GE_snapshot_atual = Object.freeze({
        perfilAtivo: perfilAtivo
            ? Object.freeze({
                id:   perfilAtivo.id,
                nome: perfilAtivo.nome,
            })
            : null,
        usuarioLogado: Object.freeze({
            // ✅ userId mantido pois é necessário para verificações internas de sessão
            userId:  usuarioLogado.userId,
            plano:   usuarioLogado.plano,
            isGuest: usuarioLogado.isGuest,
            // ✅ perfis mantidos apenas com id e nome — sem foto ou outros metadados
            perfis:  Object.freeze(
                usuarioLogado.perfis.map(p => Object.freeze({ id: p.id, nome: p.nome }))
            ),
        }),
    });
    // Invalida cache das cópias congeladas — dados mudaram (load ou save)
    _cache.tx = null; _cache.mt = null; _cache.cf = null; _cache.cc = null;
}

// Limites por plano — aceita qualquer capitalização (Stripe guarda lowercase)
const limitesPlano = {
    "Individual": 1, "individual": 1,
    "Casal": 2,      "casal": 2,
    "Família": 4,    "familia": 4, "Família": 4,
};

// Constantes de banco — compartilhadas via _ctx com módulos lazy-loaded
const BANCO_ABREV = Object.freeze({
    'Nubank':          'NU',
    'Bradesco':        'BDC',
    'Mercado Pago':    'MP',
    'C6 Bank':         'C6',
    'Itaú':            'ITÁ',
    'Santander':       'SAN',
    'Banco do Brasil': 'BB',
    'Caixa':           'CEF',
    'Alelo':           'ALE',
});
const BANCO_COR = Object.freeze({
    'Nubank':          'linear-gradient(135deg, #5b0d8c 0%, #9b19d1 100%)',
    'Bradesco':        'linear-gradient(135deg, #c00000 0%, #e83232 100%)',
    'Mercado Pago':    'linear-gradient(135deg, #006bb3 0%, #009ee3 100%)',
    'C6 Bank':         'linear-gradient(135deg, #111114 0%, #2c2c30 100%)',
    'Itaú':            'linear-gradient(135deg, #d46000 0%, #f07800 100%)',
    'Santander':       'linear-gradient(135deg, #a80000 0%, #d40000 100%)',
    'Banco do Brasil': 'linear-gradient(135deg, #003070 0%, #005cc5 100%)',
    'Caixa':           'linear-gradient(135deg, #004f96 0%, #0074cc 100%)',
    'Alelo':           'linear-gradient(135deg, #1a6b3a 0%, #2ea862 100%)',
});
const BANCO_ICON = Object.freeze({
    'Nubank':          '/assets/icons/cards/Nubank.png',
    'Bradesco':        '/assets/icons/cards/Bradesco.png',
    'Mercado Pago':    '/assets/icons/cards/logo-mercado-pago-icone-1024.png',
    'C6 Bank':         '/assets/icons/cards/logo-c6-bank-1024.png',
    'Itaú':            '/assets/icons/cards/logo-itau-4096.png',
    'Banco do Brasil': '/assets/icons/cards/logo-banco-do-brasil-icon-4096.png',
    'Caixa':           '/assets/icons/cards/logo-caixa-economica-federal-4096.png',
    'Alelo':           '/assets/icons/cards/alelo-4096.png',
});

// [GOD6-M02] Chart.js hospedado localmente — remove cdn.jsdelivr.net do CSP.
// Arquivo: public/scripts/vendor/chart.umd.min.js (SRI verificado no download).
const _CHARTJS_SRC       = '/scripts/vendor/chart.umd.min.js';
const _CHARTJS_INTEGRITY = 'sha384-NrKB+u6Ts6AtkIhwPixiKTzgSKNblyhlk0Sohlgar9UHUBzai/sgnNNWWd291xqt';

// ========== FUNÇÕES DE FORMATAÇÃO ==========
function formatBRL(v) { 
    return 'R$ ' + Number(v).toLocaleString('pt-BR', {
        minimumFractionDigits: 2, 
        maximumFractionDigits: 2
    }); 
}

// Anima um valor monetário do valor anterior até o alvo (count-up + flash de cor).
// Respeita reduced-motion e não anima na primeira pintura nem em valores iguais.
function _animarMoeda(el, valorAlvo) {
    if (!el) return;
    const valorAnterior = Number(el.dataset.num ?? NaN);
    el.dataset.num = String(valorAlvo);

    const reduzir = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduzir || !Number.isFinite(valorAnterior) || valorAnterior === valorAlvo) {
        if (el._animMoedaId) { cancelAnimationFrame(el._animMoedaId); el._animMoedaId = null; }
        el.textContent = formatBRL(valorAlvo);
        return;
    }

    el.classList.remove('valor-subiu', 'valor-desceu');
    void el.offsetWidth; // reinicia a animação CSS
    el.classList.add(valorAlvo >= valorAnterior ? 'valor-subiu' : 'valor-desceu');

    if (el._animMoedaId) cancelAnimationFrame(el._animMoedaId);
    const inicio = performance.now();
    const dur = 600;
    const delta = valorAlvo - valorAnterior;
    const passo = (agora) => {
        const t = Math.min(1, (agora - inicio) / dur);
        const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
        el.textContent = formatBRL(valorAnterior + delta * eased);
        if (t < 1) {
            el._animMoedaId = requestAnimationFrame(passo);
        } else {
            el.textContent = formatBRL(valorAlvo);
            el._animMoedaId = null;
        }
    };
    el._animMoedaId = requestAnimationFrame(passo);
}

function agoraDataHora() {
    const d = new Date();
    const data = d.toLocaleDateString('pt-BR');
    const hora = d.toLocaleTimeString('pt-BR', {hour12: false});
    return {data, hora};
}

function isoDate() { 
    return new Date().toISOString().slice(0, 10); 
}

function yearMonthKey(dateObjOrYYYYMM) {
    if(typeof dateObjOrYYYYMM === 'string') {
        if(dateObjOrYYYYMM.length === 7) return dateObjOrYYYYMM;
        return dateObjOrYYYYMM.slice(0, 7);
    }
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
}

function dataParaISO(dataBR) {
    const partes = dataBR.split('/');
    if(partes.length !== 3) return null;
    return `${partes[2]}-${partes[1]}-${partes[0]}`;
}

function formatarDataBR(dataISO) {
    if(!dataISO) return '';
    const [y, m, d] = dataISO.split('-');
    return `${d}/${m}/${y}`;
}

function getMesNome(mes) {
    const meses = {
        '01': 'Janeiro', '02': 'Fevereiro', '03': 'Março', '04': 'Abril',
        '05': 'Maio', '06': 'Junho', '07': 'Julho', '08': 'Agosto',
        '09': 'Setembro', '10': 'Outubro', '11': 'Novembro', '12': 'Dezembro'
    };
    return meses[mes] || mes;
}

// ========== CARREGAR E SALVAR DADOS ==========
const _log = (() => {
    return {
        info:  IS_DEV ? (...a) => console.info('[GE]',  ...a) : () => {},
        warn:  IS_DEV ? (...a) => console.warn('[GE]',  ...a) : () => {},
        // Em prod, loga apenas código de erro — nunca dados do usuário
        error: (code, e) => {
            if (IS_DEV) { console.error('[GE] Erro ' + code + ':', e); }
            else         { console.error('[GE] Erro ' + code); }
        },
    };
})();

// ── Detecta se o valor salvo no banco é um path relativo ou URL completa
//    Path relativo: "df7743f0-b0fe.../1234567890.jpg"
//    URL completa:  "https://fvrhqqeofqedmhadzzqw.supabase.co/..."
function _isStoragePath(valor) {
    if (!valor || typeof valor !== 'string') return false;
    try {
        new URL(valor);
        return false; // conseguiu parsear → é URL completa
    } catch {
        return true;  // não é URL → é path relativo
    }
}

// ── Resolve foto: se for path → gera signed URL; se for URL → valida normalmennte
async function _resolverFotoPerfil(photo_url) {
    if (!photo_url) return { url: null, storagePath: null };

    if (_isStoragePath(photo_url)) {
        // ✅ Novo formato: path relativo no storage → gera signed URL
        const urlSegura = await _gerarSignedUrl(photo_url);
        return { url: urlSegura, storagePath: photo_url };
    } else {
        // ✅ Formato antigo: URL completa → valida e usa diretamente
        //    (perfis criados antes da migração para signed URL)
        const urlSegura = _sanitizeImgUrl(photo_url);
        return { url: urlSegura, storagePath: null };
    }
}

// ✅ CORREÇÃO: aceita targetUserId opcional.
//    Para titulares: targetUserId === session.user.id (sem mudança de comportamento).
//    Para convidados: targetUserId === owner_user_id (carrega perfis do dono da conta).
//    A validação da sessão JWT continua — apenas a query usa o targetUserId.
// Cache TTL de perfis: evita round-trip ao Supabase em refreshes da mesma sessão.
// Apenas metadados (id, nome) — fotos não são cacheadas (signed URLs expiram).
const _PERFIS_CACHE_KEY = 'ge_perfis_cache';
const _PERFIS_CACHE_TTL = 5 * 60 * 1000; // 5 minutos

function _lerCachePerfis(userId) {
    try {
        const raw = sessionStorage.getItem(_PERFIS_CACHE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (parsed?.userId !== userId) return null;
        if (Date.now() - (parsed?.ts || 0) > _PERFIS_CACHE_TTL) return null;
        if (!Array.isArray(parsed?.perfis)) return null;
        return parsed.perfis;
    } catch { return null; }
}

function _gravarCachePerfis(userId, perfis) {
    try {
        // Salva apenas id e nome — sem foto (signed URL expira, não faz sentido cachear)
        const payload = {
            userId,
            ts:     Date.now(),
            perfis: perfis.map(p => ({ id: p.id, nome: p.nome })),
        };
        sessionStorage.setItem(_PERFIS_CACHE_KEY, JSON.stringify(payload));
    } catch { /* sessionStorage pode estar bloqueado em modo privativo */ }
}

function invalidarCachePerfis() {
    try { sessionStorage.removeItem(_PERFIS_CACHE_KEY); } catch { /* ignore */ }
}

async function carregarPerfis(targetUserId = null) {
    try {
        const { data: { session }, error: sessionError } = await supabase.auth.getSession();

        if (sessionError || !session || !session.user || !session.user.id) {
            throw new Error('SEM_SESSAO_VALIDA');
        }

        // ✅ Se targetUserId foi fornecido (dono da conta para convidados), usa-o.
        //    Caso contrário, usa o ID do próprio usuário autenticado (titulares).
        //    A sessão JWT continua sendo validada acima — isso não abre falha de autenticação.
        const userIdSeguro = (targetUserId && typeof targetUserId === 'string' && targetUserId.length > 0)
            ? targetUserId
            : session.user.id;

        // ── Cache hit: evita round-trip ao Supabase em refreshes rápidos ─────
        // Apenas metadados (id, nome) — fotos resolvidas sempre frescos via _resolverFotoPerfil.
        const cachedPerfis = _lerCachePerfis(userIdSeguro);
        if (cachedPerfis && cachedPerfis.length > 0) {
            _log.info('[carregarPerfis] Cache hit — pulando query ao Supabase');
            // Resolve fotos frescos (signed URLs expiram — não cacheamos)
            const perfisResolvidos = await Promise.all(
                cachedPerfis.map(async (p) => {
                    // photo_url não está no cache — passa null para usar placeholder
                    const { url, storagePath } = await _resolverFotoPerfil(null);
                    return { id: p.id, nome: p.nome, foto: url, _storagePath: storagePath };
                })
            );
            usuarioLogado.perfis = perfisResolvidos;
            // Busca fotos reais em background sem bloquear a UI
            _recarregarFotosPerfisBackground(userIdSeguro);
            return { sucesso: true, perfisEncontrados: true };
        }

        const { data: perfis, error } = await supabase
            .from('profiles')
            .select('id, name, photo_url')
            .eq('user_id', userIdSeguro)
            // Perfil excluído (is_active = false) fica FORA da lista. Ele ainda
            // existe — a linha e o backup de 7 dias seguem lá para a restauração —
            // mas não é um perfil que se possa abrir. Sem este filtro o excluído
            // continua na tela de seleção e a vaga parece nunca abrir.
            .eq('is_active', true)
            .order('id', { ascending: true });

        if (error) throw error;

        if (perfis && perfis.length > 0) {
            const perfisResolvidos = await Promise.all(
                perfis.map(async (p) => {
                    const { url, storagePath } = await _resolverFotoPerfil(p.photo_url);
                    return {
                        id:           p.id,
                        nome:         _sanitizeText(p.name),
                        foto:         url,
                        _storagePath: storagePath,
                    };
                })
            );

            usuarioLogado.perfis = perfisResolvidos;
            _gravarCachePerfis(userIdSeguro, perfisResolvidos);
            iniciarRenovacaoFotos();
            return { sucesso: true, perfisEncontrados: true };
        }

        usuarioLogado.perfis = [];
        return { sucesso: true, perfisEncontrados: false };

    } catch (e) {
        _log.error('PERFIS_001', e);
        usuarioLogado.perfis = [];
        return { sucesso: false, perfisEncontrados: false };
    }
}

// Busca fotos reais em background quando servido do cache (não bloqueia UI)
async function _recarregarFotosPerfisBackground(userIdSeguro) {
    try {
        const { data: perfis, error } = await supabase
            .from('profiles')
            .select('id, name, photo_url')
            .eq('user_id', userIdSeguro)
            // Perfil excluído (is_active = false) fica FORA da lista. Ele ainda
            // existe — a linha e o backup de 7 dias seguem lá para a restauração —
            // mas não é um perfil que se possa abrir. Sem este filtro o excluído
            // continua na tela de seleção e a vaga parece nunca abrir.
            .eq('is_active', true)
            .order('id', { ascending: true });
        if (error || !perfis?.length) return;

        const perfisResolvidos = await Promise.all(
            perfis.map(async (p) => {
                const { url, storagePath } = await _resolverFotoPerfil(p.photo_url);
                return { id: p.id, nome: _sanitizeText(p.name), foto: url, _storagePath: storagePath };
            })
        );
        usuarioLogado.perfis = perfisResolvidos;
        _gravarCachePerfis(userIdSeguro, perfisResolvidos);
        atualizarTelaPerfis();
        iniciarRenovacaoFotos();

        // Atualiza foto do perfil ativo se foi carregada em background
        if (perfilAtivo) {
            const atualizado = perfisResolvidos.find(p => String(p.id) === String(perfilAtivo.id));
            if (atualizado?.foto && atualizado.foto !== perfilAtivo.foto) {
                perfilAtivo.foto          = atualizado.foto;
                perfilAtivo._storagePath  = atualizado._storagePath;
                atualizarNomeUsuario();
            }
        }
    } catch { /* background — falha silenciosa */ }
}

// ========== CARREGAR DADOS DO PERFIL (CORRIGIDA) ==========
async function carregarDadosPerfil(perfilId) {
    // Troca de perfil / boot: reseta a flag para que a 1ª avaliação faça o
    // backfill SILENCIOSO (sem toast) das conquistas já merecidas pelo perfil.
    _conquistasReady = false;
    try {
        _log.info('📦 [carregarDadosPerfil] Iniciando carregamento de dados');

        const userData = await dataManager.loadUserData();

        // ⛔ NÃO colocar aqui um `return` antecipado quando o load falha.
        // Tentativa de 2026-07-20 (RF-06) saía cedo para não zerar a tela offline —
        // e TRAVOU o app na splash: o retorno pulava `atualizarReferenciasGlobais()`
        // e o resto do boot, então o PWA abria e ficava parado na tela do ícone.
        // O guarda anti-wipe do data-manager (que usa o mesmo sinal `lastLoadOk`)
        // já protege o BANCO de ser sobrescrito com vazio; a tela mostrar zeros
        // offline é feio, mas não destrói nada — travar o app, sim.
        // Se voltarmos a isso, a saída tem de ser um estado de UI, nunca um return
        // no meio do caminho de boot, e validado em aparelho real.
        if (userData.profiles.length > 0) _allProfilesData = userData.profiles;

        // ✅ CORREÇÃO CRÍTICA: data-manager.js rejeita perfis com id inteiro (ex: id=6)
        //    ao validar o shape no loadUserData(), e como efeito colateral pode resetar
        //    o userId interno. Detectamos isso aqui e re-inicializamos antes de prosseguir,
        //    garantindo que salvarDados() encontre um dataManager.userId válido.
        if (!dataManager.userId) {
            if (_effectiveUserId && _effectiveEmail) {
                _log.warn('[carregarDadosPerfil] dataManager.userId perdido após loadUserData(). Re-inicializando...');
                try {
                    await dataManager.initialize(_effectiveUserId, _effectiveEmail);
                    _log.info('[carregarDadosPerfil] Re-inicialização concluída. userId:', !!dataManager.userId);
                } catch (reinitErr) {
                    _log.error('PERFIL_LOAD_REINIT_001', reinitErr);
                }
            } else {
                _log.warn('[carregarDadosPerfil] dataManager.userId perdido e _effectiveUserId não disponível.');
            }
        }

        // ✅ Apenas contagem — sem dados identificáveis
        _log.info('📊 [carregarDadosPerfil] Dados recebidos. Total de perfis:', userData.profiles?.length || 0);

        const perfilData = userData.profiles.find(p => String(p.id) === String(perfilId));

        if (!perfilData) {
            _log.info('[carregarDadosPerfil] Perfil sem dados salvos. Criando estrutura vazia.');
            transacoes     = [];
            metas          = [];
            contasFixas    = [];
            cartoesCredito = [];
            assinaturas    = [];
            conquistasPerfil = {};
            configPerfil     = {};
            desafiosPerfil   = { ativos: [], historico: [] };
            if (typeof _cache !== 'undefined') { _cache.tx = null; _cache.mt = null; _cache.cf = null; _cache.cc = null; }

            // ✅ nextIds mantidos apenas para cartões — cartão ainda usa ID local
            nextCartaoId = 1;

            atualizarReferenciasGlobais();
            return;
        }

        transacoes     = Array.isArray(perfilData.transacoes)     ? perfilData.transacoes     : [];
        metas          = Array.isArray(perfilData.metas)          ? perfilData.metas          : [];
        contasFixas    = Array.isArray(perfilData.contasFixas)    ? perfilData.contasFixas    : [];
        cartoesCredito = Array.isArray(perfilData.cartoesCredito) ? perfilData.cartoesCredito : [];
        assinaturas    = Array.isArray(perfilData.assinaturas)    ? perfilData.assinaturas    : [];
        orcamentos          = (perfilData.orcamentos && typeof perfilData.orcamentos === 'object' && !Array.isArray(perfilData.orcamentos))
                              ? perfilData.orcamentos : {};
        tiposPersonalizados = Array.isArray(perfilData.tiposPersonalizados)
                              ? perfilData.tiposPersonalizados.filter(t => typeof t === 'string' && t.length > 0 && t.length <= 60).slice(0, 50)
                              : [];
        // sanitizeUnlocked: só copia ids conhecidos com valor string — blinda
        // contra blob corrompido / prototype pollution vindo do servidor.
        conquistasPerfil    = sanitizeConquistas(perfilData.conquistas);
        configPerfil        = _sanitizarConfigPerfil(perfilData.config);
        desafiosPerfil      = _sanitizarDesafiosPerfil(perfilData.desafios);
        if (typeof _cache !== 'undefined') { _cache.tx = null; _cache.mt = null; _cache.cf = null; _cache.cc = null; }

        const idsCartoesNumericos = cartoesCredito
            .map(c => typeof c.id === 'number' ? c.id : parseInt(c.id, 10))
            .filter(n => Number.isInteger(n) && n > 0);

        nextCartaoId = perfilData.nextCartaoId
            || (idsCartoesNumericos.length > 0 ? Math.max(...idsCartoesNumericos) + 1 : 1);

        // Corrige faturas de cartão gravadas com vencimento 1 mês adiantado
        // (bug do ciclo fechamento→vencimento, corrigido em 07/2026)
        _repararFaturasAdiantadas();

        // Migra parcelas do modelo ANTIGO (1 compra numa fatura, contador
        // parcelaAtual) para o NOVO (1 parcela por fatura mensal). Idempotente e
        // fail-safe. Ver reestruturação 2026-07-17 e modules/fatura-parcelas.js.
        _migrarParcelasAntigas();

        // Reserva compartilhada: o que o outro membro lançou entra AQUI, antes de
        // qualquer tela ler `metas`. Sem isto o saldo da reserva só se atualizava
        // ao abrir a aba Reservas — e o refetch do tempo real repintava o número
        // velho. Ver `_sincronizarReservasCompartilhadas`.
        await _sincronizarReservasCompartilhadas();

        // ✅ Apenas contadores — sem PII
        _log.info('✅ [carregarDadosPerfil] Carregamento concluído.',
            '| Transações:', transacoes.length,
            '| Metas:', metas.length,
            '| Contas:', contasFixas.length,
            '| Cartões:', cartoesCredito.length
        );

        atualizarReferenciasGlobais();

    } catch(e) {
        _log.error('PERFIL_LOAD_001', e);
        transacoes     = [];
        metas          = [];
        contasFixas    = [];
        cartoesCredito = [];
        assinaturas    = [];
        conquistasPerfil = {};
        configPerfil     = {};
        desafiosPerfil   = { ativos: [], historico: [] };
        if (typeof _cache !== 'undefined') { _cache.tx = null; _cache.mt = null; _cache.cf = null; _cache.cc = null; }
        atualizarReferenciasGlobais();
    }
}

// ========== CONQUISTAS — AVALIAÇÃO E NÍVEIS ==========
// Monta o snapshot de estado consumido pelo engine de conquistas (achievements.js).
// O engine calcula saldo/patrimônio/mensais internamente a partir das arrays.
function _buildConquistaState() {
    const histDesafios = Array.isArray(desafiosPerfil?.historico) ? desafiosPerfil.historico : [];
    return {
        perfisCount:    Array.isArray(usuarioLogado.perfis) ? usuarioLogado.perfis.length : (perfilAtivo ? 1 : 0),
        transacoes:     Array.isArray(transacoes)     ? transacoes     : [],
        metas:          Array.isArray(metas)          ? metas          : [],
        cartoesCredito: Array.isArray(cartoesCredito) ? cartoesCredito : [],
        contasFixas:    Array.isArray(contasFixas)    ? contasFixas    : [],
        assinaturas:    Array.isArray(assinaturas)    ? assinaturas    : [],
        orcamentos:     (orcamentos && typeof orcamentos === 'object') ? orcamentos : {},
        desafiosConcluidos: histDesafios.filter(h => h && h.sucesso === true).length,
        horasVidaAtivo:     configPerfil?.horasVida?.ativo === true,
    };
}

// Avalia conquistas contra o estado atual e MUTA conquistasPerfil com os novos
// desbloqueios. Na 1ª chamada por perfil (_conquistasReady=false) faz backfill
// SILENCIOSO — usuários antigos não levam enxurrada de toasts. Depois disso,
// cada novo desbloqueio dispara o toast estilo Steam. A persistência acontece
// naturalmente: esta função roda no topo de salvarDados(), então o mapa
// atualizado entra no mesmo save. Idempotente (recomputa a partir dos dados).
function checarConquistas() {
    try {
        const state  = _buildConquistaState();
        const silent = !_conquistasReady;
        const { newly } = evaluateConquistas(state, conquistasPerfil);
        _conquistasReady = true;
        if (newly.length) {
            if (!silent) enqueueConquistaToasts(newly);
            // Re-renderiza a tela de conquistas, se estiver aberta
            if (typeof window._reRenderConquistas === 'function') {
                try { window._reRenderConquistas(); } catch { /* modal pode ter fechado */ }
            }
        }
        return newly;
    } catch (e) {
        _log.error('CONQUISTA_EVAL_001', e);
        return [];
    }
}

// ========== SALVAR DADOS ==========
// ── Validadores de schema — evitam persistência de dados corrompidos/injetados
const _validators = {
    transacao(t) {
        if (!t || typeof t !== 'object') return false;
        const cats = ['entrada', 'saida', 'reserva', 'retirada_reserva'];

        if (t.id !== undefined && t.id !== null) {
            const isIntId  = Number.isInteger(t.id) && t.id > 0;
            const isUuidId = typeof t.id === 'string' && t.id.length > 0;
            if (!isIntId && !isUuidId) return false;
        }

        if (!cats.includes(t.categoria))                                          return false;
        if (typeof t.descricao !== 'string' || t.descricao.length > 300)          return false;
        if (typeof t.valor !== 'number' || t.valor < 0 || t.valor > 99999999)     return false;
        if (typeof t.data !== 'string' || !/^\d{2}\/\d{2}\/\d{4}$/.test(t.data)) return false;
        return true;
    },
    meta(m) {
        if (!m || typeof m !== 'object') return false;

        if (m.id !== undefined && m.id !== null) {
            const isIntId  = Number.isInteger(m.id) && m.id > 0;
            const isUuidId = typeof m.id === 'string' && m.id.length > 0;
            if (!isIntId && !isUuidId) return false;
        }

        if (typeof m.descricao !== 'string' || m.descricao.length > 200)               return false;
        if (typeof m.objetivo !== 'number' || m.objetivo < 0 || m.objetivo > 99999999) return false;
        if (typeof m.saved !== 'number' || m.saved < 0)                                return false;

        // Campos opcionais — novos
        if (m.prazo !== undefined && m.prazo !== null) {
            if (typeof m.prazo !== 'string' || !/^\d{2}\/\d{4}$/.test(m.prazo)) return false;
        }
        if (m.tipoRendimento !== undefined && m.tipoRendimento !== null) {
            if (!['sem_rendimento', 'cdi', 'personalizado'].includes(m.tipoRendimento)) return false;
        }
        if (m.taxaJuros !== undefined && m.taxaJuros !== null) {
            if (typeof m.taxaJuros !== 'number' || m.taxaJuros < 0 || m.taxaJuros > 100) return false;
        }
        if (m.cdiPct !== undefined && m.cdiPct !== null) {
            if (typeof m.cdiPct !== 'number' || m.cdiPct <= 0 || m.cdiPct > 200) return false;
        }
        if (m.rendimentoPeriodo !== undefined && m.rendimentoPeriodo !== null) {
            if (!['mes', 'ano'].includes(m.rendimentoPeriodo)) return false;
        }
        if (m.aporteRecorrente !== undefined && m.aporteRecorrente !== null) {
            if (typeof m.aporteRecorrente !== 'boolean') return false;
        }
        if (m.valorAporte !== undefined && m.valorAporte !== null) {
            if (typeof m.valorAporte !== 'number' || m.valorAporte < 0 || m.valorAporte > 99999999) return false;
        }
        if (m.lastRendimento !== undefined && m.lastRendimento !== null) {
            if (typeof m.lastRendimento !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(m.lastRendimento)) return false;
        }
        return true;
    },
    contaFixa(c) {
        if (!c || typeof c !== 'object') return false;

        if (c.id !== undefined && c.id !== null) {
            const isIntId  = Number.isInteger(c.id) && c.id > 0;
            const isUuidId = typeof c.id === 'string' && c.id.length > 0;
            if (!isIntId && !isUuidId) return false;
        }

        if (typeof c.descricao !== 'string' || c.descricao.length > 200)                    return false;
        if (typeof c.valor !== 'number' || c.valor < 0 || c.valor > 99999999)               return false;
        if (typeof c.vencimento !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(c.vencimento)) return false;
        return true;
    },
    cartao(c) {
        if (!c || typeof c !== 'object') return false;

        if (c.id !== undefined && c.id !== null) {
            const isIntId  = Number.isInteger(c.id) && c.id > 0;
            const isUuidId = typeof c.id === 'string' && c.id.length > 0;
            if (!isIntId && !isUuidId) return false;
        }

        if (typeof c.nomeBanco !== 'string' || c.nomeBanco.length > 100)                        return false;
        if (typeof c.limite !== 'number' || c.limite <= 0 || c.limite > 9999999)                return false;
        if (!Number.isInteger(c.vencimentoDia) || c.vencimentoDia < 1 || c.vencimentoDia > 28) return false;
        if (c.fechamentoDia !== undefined && c.fechamentoDia !== null &&
            (!Number.isInteger(c.fechamentoDia) || c.fechamentoDia < 1 || c.fechamentoDia > 28)) return false;

        // ✅ CORREÇÃO: valida `usado` — impede valor negativo que inflaria o limite disponível
        if (c.usado !== undefined && c.usado !== null) {
            if (typeof c.usado !== 'number' || !isFinite(c.usado) || c.usado < 0 || c.usado > 9999999) return false;
        }

        return true;
    },
    assinatura(a) {
        if (!a || typeof a !== 'object') return false;

        if (a.id !== undefined && a.id !== null) {
            const isIntId  = Number.isInteger(a.id) && a.id > 0;
            const isUuidId = typeof a.id === 'string' && a.id.length > 0;
            if (!isIntId && !isUuidId) return false;
        }

        if (typeof a.nome !== 'string' || a.nome.length < 1 || a.nome.length > 60)              return false;
        if (typeof a.valor !== 'number' || !isFinite(a.valor) || a.valor <= 0 || a.valor > 99999999) return false;

        const isIntCartao  = Number.isInteger(a.cartaoId) && a.cartaoId > 0;
        const isUuidCartao = typeof a.cartaoId === 'string' && a.cartaoId.length > 0;
        if (!isIntCartao && !isUuidCartao) return false;

        if (!Number.isInteger(a.diaCobranca) || a.diaCobranca < 1 || a.diaCobranca > 28) return false;
        if (typeof a.ativa !== 'boolean')                                                return false;
        if (typeof a.criadaEm !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(a.criadaEm))   return false;

        if (a.ultimaCobranca !== undefined && a.ultimaCobranca !== null) {
            if (typeof a.ultimaCobranca !== 'string' || !/^\d{4}-\d{2}$/.test(a.ultimaCobranca)) return false;
        }
        if (a.canceladaEm !== undefined && a.canceladaEm !== null) {
            if (typeof a.canceladaEm !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(a.canceladaEm)) return false;
        }
        return true;
    },
};

// ── NOVO (Ponto 1 — Anti Prototype Pollution):
//    Retorna objeto puro contendo APENAS as chaves da whitelist.
//    Object.create(null) elimina prototype chain — __proto__ injetado é descartado.
//    Impede que campos extras (injetados via console ou extensão) cheguem ao banco.
function _sanitizeObject(obj, allowedKeys) {
    const clean = Object.create(null);
    for (const key of allowedKeys) {
        if (Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined) {
            clean[key] = obj[key];
        }
    }
    return clean;
}

// Sanitiza o objeto de orçamentos antes de persistir:
// – aceita apenas tipos válidos de saída como chaves
// – limite deve ser número finito positivo (máx 10 milhões)
const _TIPOS_SAIDA_VALIDOS = Object.freeze([
    'Mercado','Farmácia','Eletrônico','Roupas','Assinaturas','Beleza','Presente',
    'Conta fixa','Cartão','Academia','Lazer','Transporte','Shopee','Mercado Livre',
    'Ifood','Amazon','Casa','Jogos','Outros',
]);
function _sanitizarOrcamentos(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
    const clean = Object.create(null);
    for (const key of _TIPOS_SAIDA_VALIDOS) {
        if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
        const v = obj[key];
        if (!v || typeof v !== 'object') continue;
        const limite = parseFloat(v.limite);
        if (!isFinite(limite) || limite <= 0 || limite > 10_000_000) continue;
        clean[key] = { limite: parseFloat(limite.toFixed(2)) };
    }
    return clean;
}

// Sanitiza as preferências do perfil (config) antes de persistir.
// Whitelist estrita: só chaves conhecidas, só valores dentro dos limites.
// A lógica pura vive em modules/config-perfil.js (testável — ver
// tests/unit/config-perfil.test.js); aqui é só o ponto de injeção do
// _sanitizeText, mantido como wrapper para os call sites não mudarem.
function _sanitizarConfigPerfil(cfg) {
    return _sanitizarConfigPerfilPuro(cfg, _sanitizeText);
}

// Sanitiza a estrutura de desafios antes de persistir. Valida só a FORMA
// (id slug, datas ISO, booleans, caps) — a validação semântica contra o
// catálogo vive no módulo lazy desafios.js, que reavalia tudo do zero.
const _DESAFIO_ID_RE  = /^[a-z0-9_]{3,40}$/;
const _DESAFIO_ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
function _sanitizarDesafiosPerfil(raw) {
    const clean = { ativos: [], historico: [] };
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return clean;
    if (Array.isArray(raw.ativos)) {
        for (const a of raw.ativos.slice(0, 3)) {
            if (a && typeof a === 'object' &&
                typeof a.id === 'string' && _DESAFIO_ID_RE.test(a.id) &&
                typeof a.iniciadoEm === 'string' && _DESAFIO_ISO_RE.test(a.iniciadoEm)) {
                // `alvo` = meta personalizada dos desafios de teto, congelada no
                // aceite. Sem preservar aqui, o save a descartaria e o desafio
                // seria julgado com alvo 0 (falha injusta). Só forma; o catálogo
                // valida a semântica em desafios.js.
                const _alvo = Number(a.alvo);
                clean.ativos.push(Number.isFinite(_alvo) && _alvo > 0 && _alvo <= 9_999_999
                    ? { id: a.id, iniciadoEm: a.iniciadoEm, alvo: Math.round(_alvo * 100) / 100 }
                    : { id: a.id, iniciadoEm: a.iniciadoEm });
            }
        }
    }
    if (Array.isArray(raw.historico)) {
        for (const h of raw.historico.slice(-60)) {
            if (h && typeof h === 'object' &&
                typeof h.id === 'string' && _DESAFIO_ID_RE.test(h.id) &&
                typeof h.iniciadoEm === 'string' && _DESAFIO_ISO_RE.test(h.iniciadoEm) &&
                typeof h.finalizadoEm === 'string' && _DESAFIO_ISO_RE.test(h.finalizadoEm)) {
                clean.historico.push({
                    id: h.id, iniciadoEm: h.iniciadoEm,
                    finalizadoEm: h.finalizadoEm, sucesso: h.sucesso === true,
                });
            }
        }
    }
    return clean;
}

// ── NOVO (Ponto 5 — Limite de payload):
//    Teto de registros por tipo de array.
//    Bloqueia saves abusivos antes de serializar qualquer dado.
const _SAVE_LIMITS = Object.freeze({
    transacoes:    10_000,
    metas:            500,
    contasFixas:    1_000,
    cartoesCredito:    50,
    assinaturas:      100,
});

// ── NOVO (Ponto 1 — Whitelist de chaves por entidade):
//    Define EXATAMENTE quais campos chegam ao banco.
//    Campos de runtime (_processando, _storagePath, etc.) nunca passam.
const _ALLOWED_KEYS = Object.freeze({
    transacao: Object.freeze([
        'id', 'categoria', 'tipo', 'descricao', 'valor',
        'data', 'hora', 'metaId', 'contaFixaId',
        'faturaId', 'compraId', 'motivoRetirada',
    ]),
    meta: Object.freeze([
        'id', 'descricao', 'objetivo', 'saved',
        'monthly', 'historicoRetiradas',
        'prazo', 'tipoRendimento', 'taxaJuros', 'cdiPct',
        'rendimentoPeriodo', 'aporteRecorrente', 'valorAporte',
        'lastRendimento',
        // Reserva compartilhada (item 13): sem estas 3, o save descartaria a
        // marcação e a trilha, e o recurso sumiria silenciosamente no reload.
        'compartilhada', 'membros', 'movimentos',
        // Convite→aceite (v2): ids de perfil convidados ainda pendentes. Sem
        // esta chave o convite sumiria no primeiro save (allow-list).
        'convites',
        // `saiu`: esta cópia virou RECIBO — saí da reserva (ou fui tirado do
        // roster), mas a trilha dela continua sendo o que prova, para quem ficou,
        // o que eu pus e o que levei. Sem esta chave o recibo perderia a marca no
        // primeiro save e a reserva voltaria a aparecer como minha.
        'saiu',
        // Carimbo p/ reconciliar cópias da reserva entre perfis (qual é a mais nova).
        'lastUpdate',
        // `tipoReserva` (caixinha/poupança/CDB/…) e `origemExistente` eram
        // gravados por db-metas e DESCARTADOS aqui — o formulário perguntava o
        // tipo, validava a resposta e jogava fora. Detectado por
        // scripts/check-allowlist.mjs.
        'tipoReserva', 'origemExistente',
    ]),
    contaFixa: Object.freeze([
        'id', 'descricao', 'valor', 'vencimento', 'pago',
        'cartaoId', 'tipoContaFixa', 'compras',
        'totalParcelas', 'parcelaAtual',
    ]),
    cartao: Object.freeze([
        'id', 'nomeBanco', 'limite', 'vencimentoDia', 'fechamentoDia',
        'bandeiraImg', 'usado', 'congelado',
    ]),
    assinatura: Object.freeze([
        'id', 'nome', 'valor', 'cartaoId', 'diaCobranca',
        'ativa', 'criadaEm', 'ultimaCobranca', 'canceladaEm',
    ]),
});

// ── RESERVA COMPARTILHADA: recibo, convergência e relevância ────────────────
//
// Uma reserva compartilhada tem uma cópia no slot de cada membro, e NINGUÉM
// escreve o slot de outro (a razão está no topo de modules/reserva-familia.js:
// escrever cruzado apagava o aporte alheio). O que faz as cópias concordarem é
// a reconciliação, que UNE as trilhas e deriva o saldo delas.

/**
 * Esta cópia é um RECIBO? (saí da reserva, ou fui tirado do roster.)
 * Ela fica no slot para a trilha fechar a conta de quem ficou, mas não é mais
 * minha: não conta em total, patrimônio, conquistas nem lista.
 */
function _ehRecibo(m) {
    return m?.saiu === true;
}

/**
 * Ids cuja mudança me alcança: o meu, mais quem divide (ou vai dividir) uma
 * reserva comigo.
 *
 * ⚠️ `convites` entra junto, e não é detalhe. Quem eu convidei ainda não está em
 * `membros` NA MINHA CÓPIA — o aceite dele acontece no slot dele. Sem contar os
 * convidados, o primeiro aporte do recém-chegado era descartado pelo filtro do
 * tempo real, e eu só descobria que ele entrou (e que pôs dinheiro) no F5
 * seguinte. Era o último elo do "tempo real não funciona".
 *
 * Recibo (`saiu`) fica de fora: aquela reserva não é mais minha.
 */
function _perfisComReservaComigo() {
    const meu = String(perfilAtivo?.id ?? '');
    const ids = new Set(meu ? [meu] : []);
    for (const m of (Array.isArray(metas) ? metas : [])) {
        if (m?.compartilhada !== true || _ehRecibo(m)) continue;
        for (const lista of [m.membros, m.convites]) {
            if (!Array.isArray(lista)) continue;
            for (const id of lista) if (id != null) ids.add(String(id));
        }
    }
    return [...ids];
}

/**
 * Traz o que os outros membros lançaram nas reservas que divido com eles.
 *
 * ⚠️ RODA NO LOAD, não só no render da aba Reservas. Antes isto vivia dentro de
 * `renderMetasList` — um módulo LAZY. Quem estava na tela inicial (ou em
 * qualquer outra) via o total de reservas do jeito que estava na última vez que
 * abriu a lista, mesmo depois do refetch do tempo real.
 *
 * O `import()` é dinâmico de propósito: só quem TEM reserva compartilhada baixa
 * o módulo, e o bundle de boot não engorda (este arquivo vive num teto de KB).
 */
async function _sincronizarReservasCompartilhadas() {
    if (!Array.isArray(metas) || !metas.some(m => m?.compartilhada === true)) return false;
    try {
        const { reconciliarCopiaAtiva } = await import('../modules/reserva-familia.js?v=9');
        const pid = perfilAtivo?.id;
        let mudou = false;
        for (const m of metas) {
            if (m?.compartilhada === true && reconciliarCopiaAtiva(m, _allProfilesData, pid)) mudou = true;
        }
        if (mudou) salvarDados();
        return mudou;
    } catch (e) {
        // Conforto, não integridade: sem isto a aba Reservas ainda reconcilia ao
        // abrir. Falhar aqui não pode derrubar o load.
        _log.warn('[reserva] reconciliação no load falhou:', e?.message ?? e);
        return false;
    }
}

// ========== ASSINATURAS — MOTOR DE COBRANÇA RECORRENTE ==========
// Calcula a data (YYYY-MM-DD) da fatura do cartão à qual uma cobrança feita em
// `dataBase` pertence — mesma regra usada para compras parceladas no crédito
// (saida_credito), garantindo consistência entre os dois fluxos.
function _calcularFaturaParaData(cartao, dataBase) {
    const ano = dataBase.getFullYear();
    const mes = dataBase.getMonth() + 1;
    const dia = dataBase.getDate();

    const diaFechamento = cartao.fechamentoDia ?? cartao.vencimentoDia;
    const diaFatura     = cartao.vencimentoDia;

    // proxMes/proxAno = mês do FECHAMENTO do ciclo ao qual a cobrança pertence
    let proxMes, proxAno;
    if (dia >= diaFechamento) {
        proxMes = mes + 1;
        proxAno = ano;
        if (proxMes > 12) { proxMes = 1; proxAno++; }
    } else {
        proxMes = mes;
        proxAno = ano;
    }
    // Vencimento ANTES do dia de fechamento (ex.: fecha 28, vence 6) → a fatura
    // vence no mês SEGUINTE ao do fechamento; sem isso nasceria "Vencida".
    if (diaFatura < diaFechamento) {
        proxMes++;
        if (proxMes > 12) { proxMes = 1; proxAno++; }
    }
    return `${proxAno}-${String(proxMes).padStart(2, '0')}-${String(diaFatura).padStart(2, '0')}`;
}

// ── REPARO AUTOMÁTICO: faturas nascidas com vencimento 1 mês adiantado ────────
// Bug corrigido em 07/2026: para cartões cujo vencimento cai ANTES do dia de
// fechamento (ex.: fecha 28, vence 6), o cálculo antigo colocava o vencimento no
// mesmo mês do fechamento — toda fatura nascia com data no passado ("Vencida").
// Assinatura inequívoca do bug: a fatura contém compra feita NO dia do fechamento
// do próprio ciclo ou DEPOIS (impossível na regra correta — compra pós-fechamento
// pertence à fatura seguinte). Nesses casos empurra o vencimento +1 mês.
// Idempotente: após o ajuste a assinatura desaparece; faturas corretas (inclusive
// vencidas de verdade) nunca são tocadas. Roda a cada carregamento de perfil e
// persiste naturalmente no próximo salvarDados().
function _repararFaturasAdiantadas() {
    if (!Array.isArray(contasFixas) || !Array.isArray(cartoesCredito)) return;
    let reparadas = 0;

    contasFixas.forEach(conta => {
        if (!conta || conta.tipoContaFixa !== 'fatura_cartao') return;
        if (typeof conta.vencimento !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(conta.vencimento)) return;
        if (!Array.isArray(conta.compras) || conta.compras.length === 0) return;

        const cartao = cartoesCredito.find(c => String(c.id) === String(conta.cartaoId));
        if (!cartao) return;
        const diaFech = cartao.fechamentoDia;
        const diaVenc = cartao.vencimentoDia;
        if (!Number.isInteger(diaFech) || !Number.isInteger(diaVenc) || diaVenc >= diaFech) return;

        // Máx. 2 iterações por segurança (o bug adianta exatamente 1 mês)
        for (let i = 0; i < 2; i++) {
            // Fechamento do ciclo desta fatura = diaFech do mês ANTERIOR ao vencimento
            let [y, m] = conta.vencimento.split('-').map(Number);
            m--; if (m < 1) { m = 12; y--; }
            const fechamentoISO = `${y}-${String(m).padStart(2, '0')}-${String(diaFech).padStart(2, '0')}`;

            const compraForaDoCiclo = conta.compras.some(cp => {
                if (!cp || typeof cp.dataCompra !== 'string') return false;
                const iso = dataParaISO(cp.dataCompra);
                return typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(iso) && iso >= fechamentoISO;
            });
            if (!compraForaDoCiclo) break;
            conta.vencimento = _avancarMes(conta.vencimento);
            if (i === 0) reparadas++;
        }
    });

    if (reparadas > 0) {
        _log.info(`🔧 [faturas] ${reparadas} fatura(s) de cartão com vencimento adiantado corrigida(s) (+1 mês).`);
    }
}

// Migra as compras parceladas do modelo ANTIGO (1 objeto numa fatura, contador
// parcelaAtual) para o NOVO (1 parcela por fatura mensal). Roda no load, uma vez,
// idempotente. Ver modules/fatura-parcelas.js.
//
// FAIL-SAFE por design: mexe em dinheiro real de pagantes. Se QUALQUER coisa der
// errado numa compra, ela é deixada INTACTA (não migrada) em vez de corrompida —
// o try/catch por-compra garante que um dado esquisito não derruba o resto nem
// zera fatura de ninguém. O `usado` do cartão NÃO é tocado: as parcelas restantes
// somam o mesmo valor que a compra antiga representava.
function _migrarParcelasAntigas() {
    if (!Array.isArray(contasFixas) || !Array.isArray(cartoesCredito)) return;
    let migradas = 0;

    // Coleta as compras antigas ANTES de mexer (vamos remover das faturas de origem).
    const pendentes = [];
    for (const fatura of contasFixas) {
        if (fatura?.tipoContaFixa !== 'fatura_cartao' || !Array.isArray(fatura.compras)) continue;
        for (const compra of fatura.compras) {
            if (ehParcelaAntiga(compra)) pendentes.push({ fatura, compra });
        }
    }
    if (pendentes.length === 0) return;

    for (const { fatura, compra } of pendentes) {
        try {
            const cartao = cartoesCredito.find(c => String(c.id) === String(fatura.cartaoId));
            const geradas = migrarCompra(compra, cartao, fatura.vencimento);
            if (geradas === null) continue;          // não migrável → intacta

            // Remove a compra antiga da fatura de origem…
            fatura.compras = fatura.compras.filter(c => c !== compra);
            // …e distribui as parcelas novas (a 1ª volta pra ESTA fatura, mesmo venc.).
            if (geradas.length > 0 && cartao) anexarParcelas(contasFixas, cartao, geradas);
            migradas++;
        } catch (e) {
            _log.error('MIGRAR_PARCELA_001', e);
            // deixa a compra como estava — nunca corromper dado financeiro
        }
    }

    // Recalcula o valor de toda fatura de cartão (Σ das não pagas) e limpa
    // faturas que ficaram vazias após a migração.
    for (const f of contasFixas) {
        if (f?.tipoContaFixa !== 'fatura_cartao' || !Array.isArray(f.compras)) continue;
        f.valor = f.compras.reduce((s, c) => {
            if (c?.pago === true) return s;
            const v = parseFloat(c?.valorParcela);
            return s + (isFinite(v) && v > 0 ? v : 0);
        }, 0);
    }
    contasFixas = contasFixas.filter(f =>
        !(f?.tipoContaFixa === 'fatura_cartao' && Array.isArray(f.compras) && f.compras.length === 0));

    if (migradas > 0) _log.info(`🔧 [parcelas] ${migradas} compra(s) migrada(s) para o modelo por-mês.`);
}

// Gera (se ainda não gerada neste ciclo) a cobrança de UMA assinatura ativa,
// lançando-a como "compra" na fatura do cartão correspondente.
// Idempotente: não faz nada se `ultimaCobranca` já é o mês/ano atual.
function _processarCobrancaAssinatura(assinatura, cartao) {
    const hoje       = new Date();
    const chaveAtual = yearMonthKey(hoje);
    if (assinatura.ultimaCobranca === chaveAtual) return false;

    // Dia marcado da cobrança (1–28, validado na criação). Fallback defensivo.
    const diaRaw      = Number(assinatura.diaCobranca);
    const diaCobranca = (Number.isInteger(diaRaw) && diaRaw >= 1 && diaRaw <= 28) ? diaRaw : 1;

    // A 1ª cobrança (na criação, ainda sem `ultimaCobranca`) é lançada de imediato.
    // Nos meses seguintes, só cobra quando a data atual ATINGE o dia marcado —
    // evita lançar a cobrança logo no 1º dia do mês (bug: descontava na data errada).
    const primeiraCobranca = !assinatura.ultimaCobranca;
    if (!primeiraCobranca && hoje.getDate() < diaCobranca) return false;

    // Data de referência = dia marcado do mês atual (não "hoje"), garantindo que a
    // cobrança caia no ciclo de fatura correto e exiba a data certa mesmo que o
    // usuário só abra o app dias depois. Na 1ª cobrança usa a data real de criação.
    const dataRef = primeiraCobranca
        ? hoje
        : new Date(hoje.getFullYear(), hoje.getMonth(), diaCobranca);

    const dataFaturaISO = _calcularFaturaParaData(cartao, dataRef);

    const novaCompra = {
        id: novoId(),
        tipo:          'Assinatura',
        descricao:     assinatura.nome,
        valorTotal:    assinatura.valor,
        valorParcela:  assinatura.valor,
        totalParcelas: 1,
        parcelaAtual:  1,
        dataCompra:    dataRef.toLocaleDateString('pt-BR'),
        assinaturaId:  assinatura.id,
        recorrente:    true,
    };

    const faturaExistente = contasFixas.find(c =>
        c.cartaoId === cartao.id &&
        c.vencimento === dataFaturaISO &&
        c.tipoContaFixa === 'fatura_cartao'
    );

    if (faturaExistente) {
        if (!faturaExistente.compras) faturaExistente.compras = [];
        faturaExistente.compras.push(novaCompra);
        faturaExistente.valor = faturaExistente.compras.reduce((sum, c) => {
            const p = parseFloat(c.valorParcela);
            return sum + (isFinite(p) && p > 0 ? p : 0);
        }, 0);
    } else {
        contasFixas.push({
            id: novoId(),
            descricao:     `Fatura ${cartao.nomeBanco}`,
            valor:         novaCompra.valorParcela,
            vencimento:    dataFaturaISO,
            pago:          false,
            cartaoId:      cartao.id,
            tipoContaFixa: 'fatura_cartao',
            compras:       [novaCompra],
        });
    }

    cartao.usado = (cartao.usado || 0) + assinatura.valor;
    assinatura.ultimaCobranca = chaveAtual;
    return true;
}

// Roda a cada carregamento do dashboard — gera a cobrança do ciclo atual para
// cada assinatura ativa ainda não cobrada neste mês. Idempotente e O(n).
function gerarCobrancasAssinaturas() {
    if (!Array.isArray(assinaturas) || assinaturas.length === 0) return;

    let alterou = false;
    assinaturas.forEach(assinatura => {
        if (!assinatura || !assinatura.ativa) return;
        const cartao = cartoesCredito.find(c => String(c.id) === String(assinatura.cartaoId));
        if (!cartao) return;
        if (_processarCobrancaAssinatura(assinatura, cartao)) alterou = true;
    });

    if (alterou) salvarDados();
}

// ── Indicador de sincronização ─────────────────────────────────────────────
// Só exibe após o carregamento inicial estar completo (_syncReadyForDisplay = true).
// Isso evita "Salvando…" no boot e nas navegações automáticas entre seções.
let _syncHideTimer       = null;
let _syncReadyForDisplay = false; // ativado após o primeiro save manual do usuário
function _setSyncState(state) {
    // state: 'saving' | 'saved' | 'error' | 'sincronizado' | 'hidden'
    //
    // 'sincronizado' (Camada 3): a mudança veio de FORA — outra aba, outro
    // aparelho, outra pessoa da conta. Reusa o mesmo indicador de "Salvo" de
    // propósito: números mudando sozinhos na tela sem nenhum sinal é o tipo de
    // coisa que faz o usuário desconfiar do app. Um pisca discreto responde
    // "isso foi de propósito" sem interromper nada.
    const els = [
        document.getElementById('syncIndicator'),
        document.getElementById('syncIndicatorDesktop'),
    ].filter(Boolean);

    if (_syncHideTimer) { clearTimeout(_syncHideTimer); _syncHideTimer = null; }

    els.forEach(el => {
        el.className = el.id === 'syncIndicator' ? 'sync-indicator' : 'sync-indicator-desktop';
        el.removeAttribute('data-state');
        if (state !== 'hidden') {
            el.setAttribute('data-state', state);
            el.textContent =
                state === 'saving' ? '⏳ Salvando…'
                : state === 'saved' ? '✓ Salvo'
                : state === 'sincronizado' ? '↻ Atualizado'
                : '✗ Erro';
        } else {
            el.textContent = '';
        }
    });

    if (state === 'saved' || state === 'error' || state === 'sincronizado') {
        _syncHideTimer = setTimeout(() => _setSyncState('hidden'), 3000);
    }
}

// ✅ Controle interno de debounce do salvarDados
//    Declarado fora para persistir entre chamadas
let _saveDebounceTimer   = null;
let _saveDebounceResolve = null;

// 🔴 SAVE EM VOO — a segunda metade da corrida de troca de perfil (2026-07-19).
//
// O flush da troca só espera um save cujo TIMER ainda está armado. Mas quando o
// timer já disparou e o POST está NA REDE, `_saveDebounceTimer` já é null — e a
// troca seguia em frente, recarregava do servidor e re-salvava por cima do save
// que ainda estava voando. Foi assim que a viagem, salva por `salvarDadosUrgente`
// logo antes de trocar (e sem await, por design do popup), se perdia.
// Este promise fica != null enquanto um POST de save está em curso; a troca de
// perfil o aguarda antes de recarregar. Cobre TODO save, não só o de viagem.
let _saveEmVoo = null;

// 🔴 GUARDA DE TROCA DE PERFIL — corrige a perda de dados de 2026-07-18.
//
// O QUE ACONTECEU: o callback do debounce lê as globais NO MOMENTO EM QUE
// DISPARA (`transacoes`, `metas`, `perfilAtivo.id`), não quando foi agendado.
// Em `entrarNoPerfil` existe uma janela entre trocar `perfilAtivo` (o novo) e
// `carregarDadosPerfil` terminar (as arrays ainda são do ANTIGO). Um save
// armado antes da troca, disparando nessa fresta, gravava
//   { id: PERFIL_NOVO, transacoes: DADOS_DO_PERFIL_ANTIGO }
// — e o perfil de destino era sobrescrito pelos dados do outro. Foi exatamente
// isso que apagou o "Hachiiman" com os dados da "Meow".
//
// Um fix anterior (data_wipe_incident) moveu o INÍCIO do auto-save para depois
// do load, o que resolveu o save de perfil VAZIO — mas não cancelava um timer
// que já estava armado ANTES da troca. Esta guarda fecha esse caso.
let _trocandoPerfil = false;

// 🔴 CONGELAMENTO DE GRAVAÇÕES — restauração de backup (incidente 2026-07-19).
//
// Ao restaurar um snapshot, o servidor recebe os dados BONS, mas a memória do
// app ainda tem os dados ANTIGOS. Qualquer save nesse intervalo (o debounce
// pendente ou o auto-save) grava o estado velho POR CIMA do que acabou de ser
// restaurado — e o usuário vê "a restauração não funcionou".
// Foi exatamente isso: duas restaurações seguidas pareceram não ter efeito, e o
// blob no banco voltava ao tamanho corrompido segundos depois.
//
// NÃO existe função de descongelar, de propósito: o único caminho de volta é o
// reload, que recarrega o estado correto do servidor. Deixar reabrir por código
// seria criar de novo a janela que este guarda existe para fechar.
let _gravacoesCongeladas = false;
function congelarGravacoes() {
    _gravacoesCongeladas = true;
    if (_saveDebounceTimer)   { clearTimeout(_saveDebounceTimer); _saveDebounceTimer = null; }
    if (_saveDebounceResolve) { _saveDebounceResolve(false);      _saveDebounceResolve = null; }
    try { pararAutoSave(); } catch { /* autosave pode nem ter iniciado */ }
    _log.warn('SAVE: gravações CONGELADAS (restauração em curso — só o reload libera)');
}

async function salvarDados() {
    // Invalidar cache de cópias congeladas — dados foram modificados
    if (typeof _cache !== 'undefined') {
        _cache.tx = null; _cache.mt = null; _cache.cf = null; _cache.cc = null;
    }
    atualizarReferenciasGlobais();

    if (!perfilAtivo) {
        _log.error('SAVE_001', 'Nenhum perfil ativo');
        return false;
    }

    // Durante a troca de perfil, `perfilAtivo` e as arrays em memória ficam
    // TEMPORARIAMENTE dessincronizados (ver _trocandoPerfil). Gravar aqui é o
    // que sobrescrevia um perfil com os dados do outro. Recusar é seguro: quem
    // troca de perfil já descarregou o save pendente antes, e o próprio
    // entrarNoPerfil salva de novo no fim, com tudo consistente.
    if (_trocandoPerfil) {
        _log.warn('SAVE: ignorado — troca de perfil em curso (evita gravar dados cruzados)');
        return false;
    }

    // Restauração de backup em curso: a memória aqui é o estado ANTIGO, e gravar
    // desfaria o snapshot que o servidor acabou de aplicar. Só o reload libera.
    if (_gravacoesCongeladas) {
        _log.warn('SAVE: ignorado — gravações congeladas (restauração de backup)');
        return false;
    }

    // ── GUARDA DE MONTAGEM: mora no data-manager, não aqui ──────────────────
    //
    // Duas tentativas puseram uma guarda NESTE ponto, comparando a memória viva
    // com `_allProfilesData`. As duas foram NO-OP e a oscilação continuou: durante
    // o boot esse cache ainda está VAZIO, então a guarda comparava duas fontes
    // ambas vazias e se pulava sozinha — exatamente na janela que existia para
    // cobrir. Medido em produção nas duas vezes (bf20dd3 e 4b052c0).
    //
    // A guarda que funciona mede contra o `#retrato` do data-manager, que é
    // tirado dentro do `loadUserData()` e portanto já está populado antes de
    // qualquer save poder disparar. Ver `CAMPOS_QUE_NAO_ESVAZIAM` lá.
    //
    // NÃO reintroduza a checagem aqui sem resolver esse problema de ordem.

    // ✅ CORREÇÃO: data-manager.js pode resetar userId ao rejeitar perfis com id inteiro
    //    durante loadUserData(). Antes de falhar definitivamente, tentamos re-inicializar
    //    usando _effectiveUserId e _effectiveEmail persistidos no verificarLogin().
    if (!dataManager?.userId) {
        if (_effectiveUserId && _effectiveEmail) {
            _log.warn('SAVE: dataManager.userId ausente. Tentando re-inicializar antes de salvar...');
            try {
                await dataManager.initialize(_effectiveUserId, _effectiveEmail);
            } catch (reinitErr) {
                _log.error('SAVE_002_REINIT', reinitErr);
            }
        }
        if (!dataManager?.userId) {
            _log.error('SAVE_002', 'DataManager não inicializado e recuperação falhou');
            return false;
        }
        _log.info('SAVE: dataManager.userId recuperado com sucesso.');
    }

    return new Promise((resolve) => {

        if (_saveDebounceTimer) {
            clearTimeout(_saveDebounceTimer);
            if (_saveDebounceResolve) _saveDebounceResolve(false);
        }

        _saveDebounceResolve = resolve;

        // urgente = true → save imediato (orçamentos, tipos personalizados, config leve)
        // urgente = false → debounce 2s (transações em volume)
        const delay = (arguments[0] === true) ? 0 : 2_000;

        // Indicador só aparece quando o HTTP request começa (não durante debounce)
        // e apenas após o carregamento inicial terminar.
        _saveDebounceTimer = setTimeout(async () => {
            _saveDebounceTimer   = null;
            _saveDebounceResolve = null;

            // Marca o POST como "em voo" para que a troca de perfil o aguarde
            // (ver _saveEmVoo). O finally garante a limpeza mesmo nos returns
            // antecipados dos limites de payload abaixo.
            let _vooDone;
            _saveEmVoo = new Promise((r) => { _vooDone = r; });

            if (_syncReadyForDisplay) _setSyncState('saving');

            try {
                // ── 1. Filtrar itens inválidos pelo schema ──────────────────
                const transacoesValidas = transacoes.filter(_validators.transacao);
                const metasValidas      = metas.filter(_validators.meta);
                const cartoesValidos    = cartoesCredito.filter(_validators.cartao);
                const assinaturasValidas = assinaturas.filter(_validators.assinatura);

                // ✅ Remove a flag _processando antes de persistir.
                const contasValidas = contasFixas
                    .filter(_validators.contaFixa)
                    .map(c => {
                        const { _processando, ...rest } = c;
                        return rest;
                    });

                if (transacoesValidas.length !== transacoes.length   ||
                    metasValidas.length      !== metas.length         ||
                    contasFixas.filter(_validators.contaFixa).length !== contasFixas.length ||
                    cartoesValidos.length    !== cartoesCredito.length ||
                    assinaturasValidas.length !== assinaturas.length) {
                    _log.warn('SAVE: itens inválidos descartados antes de persistir');
                }

                // ── 2. Verificar limites de payload ─────────────────────────
                if (transacoesValidas.length > _SAVE_LIMITS.transacoes) {
                    _log.error('SAVE_LIMIT_001',
                        `Transações excedem o limite (${transacoesValidas.length} > ${_SAVE_LIMITS.transacoes})`);
                    resolve(false);
                    return;
                }
                if (metasValidas.length > _SAVE_LIMITS.metas) {
                    _log.error('SAVE_LIMIT_002',
                        `Metas excedem o limite (${metasValidas.length} > ${_SAVE_LIMITS.metas})`);
                    resolve(false);
                    return;
                }
                if (contasValidas.length > _SAVE_LIMITS.contasFixas) {
                    _log.error('SAVE_LIMIT_003',
                        `Contas fixas excedem o limite (${contasValidas.length} > ${_SAVE_LIMITS.contasFixas})`);
                    resolve(false);
                    return;
                }
                if (cartoesValidos.length > _SAVE_LIMITS.cartoesCredito) {
                    _log.error('SAVE_LIMIT_004',
                        `Cartões excedem o limite (${cartoesValidos.length} > ${_SAVE_LIMITS.cartoesCredito})`);
                    resolve(false);
                    return;
                }
                if (assinaturasValidas.length > _SAVE_LIMITS.assinaturas) {
                    _log.error('SAVE_LIMIT_005',
                        `Assinaturas excedem o limite (${assinaturasValidas.length} > ${_SAVE_LIMITS.assinaturas})`);
                    resolve(false);
                    return;
                }

                // ── 3. Sanitizar estrutura — whitelist de chaves ────────────
                const transacoesSanitizadas = transacoesValidas.map(t =>
                    _sanitizeObject(t, _ALLOWED_KEYS.transacao)
                );
                const metasSanitizadas = metasValidas.map(m =>
                    _sanitizeObject(m, _ALLOWED_KEYS.meta)
                );
                const contasSanitizadas = contasValidas.map(c =>
                    _sanitizeObject(c, _ALLOWED_KEYS.contaFixa)
                );
                const cartoesSanitizados = cartoesValidos.map(c =>
                    _sanitizeObject(c, _ALLOWED_KEYS.cartao)
                );
                const assinaturasSanitizadas = assinaturasValidas.map(a =>
                    _sanitizeObject(a, _ALLOWED_KEYS.assinatura)
                );

                // ── 3.5. Avaliar conquistas ANTES de montar o perfil ─────────
                //    Roda o engine (backfill silencioso na 1ª vez, toast depois)
                //    e deixa conquistasPerfil atualizado para entrar neste save.
                checarConquistas();
                // Sanitiza o mapa antes de persistir: só ids conhecidos do
                // catálogo com valor string (defesa contra blob corrompido).
                const conquistasSan = sanitizeConquistas(conquistasPerfil);

                // ── 4. Montar objeto do perfil atual ────────────────────────
                const dadosPerfil = {
                    id:             perfilAtivo.id,
                    nome:           _sanitizeText(perfilAtivo.nome),
                    foto:           _sanitizeImgUrl(perfilAtivo.foto) || null,
                    transacoes:     transacoesSanitizadas,
                    metas:          metasSanitizadas,
                    contasFixas:    contasSanitizadas,
                    cartoesCredito: cartoesSanitizados,
                    assinaturas:    assinaturasSanitizadas,
                    orcamentos:          _sanitizarOrcamentos(orcamentos),
                    tiposPersonalizados: tiposPersonalizados.filter(t => typeof t === 'string' && t.length > 0).slice(0, 50),
                    conquistas:     conquistasSan,
                    config:         _sanitizarConfigPerfil(configPerfil),
                    desafios:       _sanitizarDesafiosPerfil(desafiosPerfil),
                    nextCartaoId:   Number.isInteger(nextCartaoId) && nextCartaoId > 0 ? nextCartaoId : 1,
                    lastUpdate:     new Date().toISOString(),
                };

                // ── 5. Montar lista de perfis e salvar ──────────────────────
                //    Usa _allProfilesData (cache local) como base — sem round-trip
                //    ao servidor. Isso evita race conditions com o Redis cache e
                //    garante que os dados mais recentes em memória são preservados.
                const profilesBase = _allProfilesData.length > 0
                    ? JSON.parse(JSON.stringify(_allProfilesData)) // cópia profunda
                    : [];

                const perfilIndex = profilesBase.findIndex(
                    p => String(p.id) === String(perfilAtivo.id)
                );

                if (perfilIndex !== -1) {
                    profilesBase[perfilIndex] = dadosPerfil;
                } else {
                    profilesBase.push(dadosPerfil);
                }

                // 🔴 INVARIANTE: nunca gravar dois perfis com o MESMO id.
                // O `push` acima é a única forma de criar entrada nova, e ele só
                // deveria rodar para perfil realmente novo. Quando o cache local
                // estava dessincronizado (a corrida da troca de perfil, 2026-07-18),
                // ele empurrava uma DUPLICATA do perfil que já existia — foi assim
                // que a conta ficou com perfis repetidos.
                // Aqui a duplicata é barrada ANTES de persistir: prefere-se manter o
                // que acabou de ser montado (`dadosPerfil`, o estado em memória) e
                // descartar as cópias. Loga alto porque, se isto disparar, existe um
                // bug a montante — silenciar esconderia a causa.
                const vistos = new Set();
                const semDuplicatas = [];
                for (const p of profilesBase) {
                    const pid = String(p?.id ?? '');
                    if (!pid || vistos.has(pid)) {
                        _log.error('SAVE_DUP_001', `Perfil duplicado/sem id descartado no save: "${pid}"`);
                        continue;
                    }
                    vistos.add(pid);
                    semDuplicatas.push(p);
                }

                // Atualizar cache local imediatamente (antes do POST para refletir estado atual)
                _allProfilesData = semDuplicatas;

                const sucesso = await dataManager.saveUserData(semDuplicatas);
                if (!sucesso) _log.error('SAVE_004', 'saveUserData retornou false');
                if (_syncReadyForDisplay) _setSyncState(sucesso ? 'saved' : 'error');
                resolve(!!sucesso);

            } catch (e) {
                _log.error('SAVE_005', e);
                if (_syncReadyForDisplay) _setSyncState('error');
                resolve(false);
            } finally {
                // Save pousou (sucesso, erro ou limite): libera a troca de perfil.
                _saveEmVoo = null;
                _vooDone();
            }
        }, delay);
    });
}

// Barra de progresso HONESTA: reflete as etapas REAIS do boot (auth → perfil →
// dados), não uma animação fixa que sempre enchia até 100% em 1.4s. A largura
// inicial (10%) vem do CSS e aparece já no primeiro paint; aqui só avançamos
// conforme cada etapa de fato termina. style.width é DOM API (não viola CSP).
function _setLoaderProgress(pct, texto) {
    const bar = document.querySelector('#authLoading .loader-progress');
    if (bar) bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
    if (texto) {
        const lt = document.getElementById('loaderText');
        if (lt) lt.textContent = texto;
    }
}

async function verificarLogin() {
    const authLoading = document.getElementById('authLoading');
    const protectedContent = document.querySelector('[data-protected-content]');

    if (authLoading) authLoading.style.display = 'flex';

    // AuthGuard.protect() é a fonte de verdade: verifica sessão, token, fingerprint,
    // assinatura Cakto + Stripe + membership, e fallback para /api/check-user-access.
    // Redireciona automaticamente em caso de falha — não há lógica duplicada aqui.
    const userData = await AuthGuard.protect({
        requirePlan:     true,
        allowGuest:      true,
        guestCanUpgrade: false,
        redirectOnFail:  true,
        loadingElementId: 'authLoading',
    });

    if (!userData) return; // AuthGuard já disparou o redirect

    try {
        _log.info('[VERIFICAR LOGIN] AuthGuard OK. isGuest:', userData.isGuest);
        _setLoaderProgress(40, 'Autenticado, preparando seu perfil...');

        const { data: { session } } = await supabase.auth.getSession();
        if (!session) { window.location.href = 'login.html'; return; }

        const effectiveUserId = userData.effectiveUserId;
        const effectiveEmail  = userData.ownerEmail || userData.email;

        usuarioLogado = {
            userId:          userData.userId,
            effectiveUserId: effectiveUserId,
            nome:            userData.nome,
            email:           userData.email,
            plano:           userData.plano,
            perfis:          [],
            isGuest:         userData.isGuest,
            ownerEmail:      userData.ownerEmail || null,
        };

        _log.info('[VERIFICAR LOGIN] Usuário inicializado. isGuest:', usuarioLogado.isGuest);

        // Contexto do usuário no Sentry: pseudônimo derivado do id + plano.
        // O e-mail NÃO é passado — antes era, e a função sempre o descartou. Ler
        // `email:` aqui dava a impressão de que ele viajava pro Sentry.
        setUserContext({ id: usuarioLogado.userId, plan: usuarioLogado.plano });

        _log.info('[VERIFICAR LOGIN] Inicializando DataManager...');
        await dataManager.initialize(effectiveUserId, effectiveEmail);
        _log.info('[VERIFICAR LOGIN] DataManager inicializado');
        _setLoaderProgress(65);

        _effectiveUserId = effectiveUserId;
        _effectiveEmail  = effectiveEmail;
        _cachedAuthToken = session.access_token ?? null;

        if (!dataManager.userId) {
            _log.warn('[VERIFICAR LOGIN] dataManager.userId não definido após initialize(). Tentando re-inicialização...');
            await dataManager.initialize(effectiveUserId, effectiveEmail);

            _effectiveUserId = effectiveUserId;
            _effectiveEmail  = effectiveEmail;

            if (!dataManager.userId) {
                throw new Error(
                    'DataManager falhou ao inicializar (userId permanece nulo). ' +
                    'Verifique o método initialize() em data-manager.js: ' +
                    'userId deve ser definido independentemente de existir dados válidos no banco.'
                );
            }
        }

        _log.info('[VERIFICAR LOGIN] Carregando perfis...');
        const resultadoPerfis = await carregarPerfis(effectiveUserId);

        if (!resultadoPerfis.sucesso) {
            throw new Error("Não foi possível carregar os dados do usuário.");
        }
        _setLoaderProgress(85, 'Quase lá...');

        _log.info('[VERIFICAR LOGIN] Login completo. Verificando perfil salvo na sessão...');

        // Tenta restaurar o perfil selecionado anteriormente (sem forçar re-seleção a cada refresh)
        let perfilRestaurado = false;
        try {
            const idSalvo = sessionStorage.getItem('ge_perfil_id');
            if (idSalvo && usuarioLogado.perfis.length > 0) {
                const idx = usuarioLogado.perfis.findIndex(p => String(p.id) === String(idSalvo));
                if (idx !== -1) {
                    _log.info('[VERIFICAR LOGIN] Restaurando perfil salvo:', idSalvo);
                    perfilRestaurado = true;
                    // Mantém o MESMO loader (authLoading) visível durante o boot —
                    // só atualiza texto + progresso. silent:true evita overlay empilhado.
                    _setLoaderProgress(92, 'Carregando seus dados...');
                    await entrarNoPerfil(idx, { silent: true });
                    _setLoaderProgress(100, 'Pronto!');
                }
            }
        } catch (_) {}

        if (!perfilRestaurado) {
            mostrarSelecaoPerfis();
        }

    } catch (e) {
        _log.error('LOGIN_CRIT_001', e);
        alert(e.message);
        window.location.href = 'login.html';
    } finally {
        if (authLoading) authLoading.style.display = 'none';
        if (protectedContent) {
            protectedContent.classList.remove('js-hidden');
            protectedContent.style.display = '';
        }
    }
}

// ========== SELEÇÃO DE PERFIS ==========
function mostrarSelecaoPerfis() {
    const selecao         = document.getElementById('selecaoPerfis');
    const sidebar         = document.getElementById('sidebar');
    const mobileTopbar    = document.getElementById('mobileTopbar');
    const mobileBottomNav = document.getElementById('mobileBottomNav');

    if (!selecao) {
        console.error('❌ Elemento #selecaoPerfis não existe no HTML');
        return;
    }

    selecao.style.display = 'flex';
    if (sidebar)          sidebar.style.display         = 'none';
    if (mobileTopbar)     mobileTopbar.style.display    = 'none';
    if (mobileBottomNav)  mobileBottomNav.style.display = 'none';

    document.querySelectorAll('.page').forEach(p => {
        p.style.display = 'none';
        p.classList.remove('active');
    });

    atualizarTelaPerfis();
    solicitarPermissaoNotificacoes();
}

// ── Utilitário interno: escapa texto para uso em DOM via textContent
function _sanitizeText(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/[^\w\s\-.,!?:\/áéíóúàèìòùâêîôûãõäëïöüçñÁÉÍÓÚÀÈÌÒÙÂÊÎÔÛÃÕÄËÏÖÜÇÑ]/gi, '');
}

// ── Utilitário interno: valida URL de imagem (apenas HTTPS, domínios permitidos)
function _sanitizeImgUrl(url) {
    if (!url || typeof url !== 'string') return null;
    try {
        const parsed = new URL(url);
        const allowed = [
            'fvrhqqeofqedmhadzzqw.supabase.co',
        ];
        if (parsed.protocol !== 'https:') return null;
        if (!allowed.includes(parsed.hostname)) return null;
        return parsed.href;
    } catch {
        return null;
    }
}

// O bloco de restaurar perfil excluído virou chunk lazy (restaurar-perfil.js):
// só roda na tela de seleção, e precisa de rede de qualquer forma — se o chunk
// não vier, o usuário não vê um botão que também não funcionaria. Saiu daqui
// porque o dashboard.js estava em 37,2/38 KB e o teto não é decorativo.

function atualizarTelaPerfis() {
    const saudacaoNomeEl  = document.getElementById('saudacaoNome');
    const saudacaoPlanoEl = document.getElementById('saudacaoPlano');
    const lista           = document.getElementById('listaPerfis');

    if (!lista) return;

    // Não bloqueia o desenho da lista: é uma consulta ao servidor, e a tela de
    // perfis precisa aparecer na hora. Se o chunk não vier (offline, janela
    // pós-deploy), o bloco simplesmente não aparece — e ele exigiria rede de
    // qualquer forma.
    if (!usuarioLogado?.isGuest) {
        import('../modules/restaurar-perfil.js?v=1')
            .then((m) => {
                m.init({
                    usuarioLogado,
                    sanitizeText: _sanitizeText,
                    criarPopupDOM,
                    fecharPopup,
                    mostrarNotificacao,
                });
                return m.montarRestauracaoDePerfis();
            })
            .catch(() => { /* extra da tela: nunca derruba a seleção de perfis */ });
    }

    // ✅ textContent — nunca innerHTML com dados do usuário
    const nomeExibir = perfilAtivo ? perfilAtivo.nome : (usuarioLogado.nome || 'Usuário');
    if (saudacaoNomeEl)  saudacaoNomeEl.textContent  = _sanitizeText(nomeExibir);
    if (saudacaoPlanoEl) saudacaoPlanoEl.textContent = _sanitizeText(usuarioLogado.plano || '');

    lista.innerHTML = '';

    // Event delegation — um único listener para todos os cards de perfil
    if (!lista._perfisDelegate) {
        lista.addEventListener('click', e => {
            const btn = e.target.closest('.perfil-card');
            if (!btn) return;
            const idx = parseInt(btn.dataset.perfilIdx, 10);
            if (!isNaN(idx)) entrarNoPerfil(idx);
        });
        lista._perfisDelegate = true;
    }

    usuarioLogado.perfis.forEach((perfil, index) => {
        const btn = document.createElement('button');
        btn.className       = 'perfil-card';
        btn.type            = 'button';
        btn.dataset.perfilIdx = index;

        // ── Foto
        const fotoDiv = document.createElement('div');
        fotoDiv.className = 'perfil-foto';

        const urlSegura = _sanitizeImgUrl(perfil.foto);
        if (urlSegura) {
            const img = document.createElement('img');
            img.src = urlSegura;
            img.alt = 'Foto de perfil';
            img.onerror = function () { this.remove(); }; // Remove se falhar
            fotoDiv.appendChild(img);
        } else {
            const placeholder = document.createElement('div');
            placeholder.className = 'perfil-placeholder';
            // ✅ textContent — evita XSS com nomes maliciosos
            placeholder.textContent = _sanitizeText(perfil.nome).charAt(0).toUpperCase() || '?';
            fotoDiv.appendChild(placeholder);
        }

        // ── Nome
        const nomeDiv = document.createElement('div');
        nomeDiv.className   = 'perfil-nome';
        nomeDiv.textContent = _sanitizeText(perfil.nome); // ✅ textContent

        btn.appendChild(fotoDiv);
        btn.appendChild(nomeDiv);

        lista.appendChild(btn);
    });

    // ── Botão "Novo Perfil"
    const limiteAtingido = usuarioLogado.perfis.length >= (limitesPlano[usuarioLogado.plano] || 1);
    if (!limiteAtingido) {
        const add = document.createElement('button');
        add.className = 'perfil-card perfil-add';
        add.type      = 'button';

        const fotoDiv = document.createElement('div');
        fotoDiv.className   = 'perfil-foto';
        fotoDiv.textContent = '+';

        const label = document.createElement('div');
        label.textContent = 'Novo Perfil';

        add.appendChild(fotoDiv);
        add.appendChild(label);
        add.addEventListener('click', adicionarNovoPerfil);
        lista.appendChild(add);
    }
}


// Revela a casca do dashboard (esconde seleção de perfis, mostra sidebar/topbar/nav).
// Só altera display — idempotente e seguro de chamar cedo (boot otimista).
function _revelarShellDashboard() {
    const selecao         = document.getElementById('selecaoPerfis');
    const sidebar         = document.getElementById('sidebar');
    const mobileTopbar    = document.getElementById('mobileTopbar');
    const mobileBottomNav = document.getElementById('mobileBottomNav');

    if (selecao)          selecao.style.display         = 'none';
    if (sidebar)          sidebar.style.display         = 'flex';
    if (mobileTopbar)     mobileTopbar.style.display    = '';
    if (mobileBottomNav)  mobileBottomNav.style.display = '';
}

async function entrarNoPerfil(index, { silent = false } = {}) {
    // silent: usado no boot quando o authLoading já está visível — evita empilhar
    // um segundo overlay (sensação de "carregar duas vezes").
    const profileLoading = silent ? null : document.getElementById('profileLoading');

    if (!Number.isInteger(index) || index < 0 || index >= usuarioLogado.perfis.length) {
        _log.error('PERFIL_IDX_001', `Índice inválido: ${index}`);
        alert('Perfil não encontrado. Tente novamente.');
        return;
    }

    try {
        // Mostra o overlay imediatamente e cede ao browser para pintar antes do async
        if (profileLoading) profileLoading.classList.remove('hidden');
        await new Promise(r => requestAnimationFrame(r));
        await new Promise(r => requestAnimationFrame(r));

        // ── 🔴 ORDEM CRÍTICA — não reordenar (perda de dados de 2026-07-18/19) ──
        // 0) Espera um save JÁ EM VOO (timer disparou, POST na rede) pousar. Sem
        //    isto a troca recarregava e re-salvava por cima de um POST em curso —
        //    foi assim que a viagem, salva sem await logo antes de trocar, sumia.
        if (_saveEmVoo) {
            try { await _saveEmVoo; } catch (e) { _log.error('PERFIL_VOO_001', e); }
        }
        // 1) DESCARREGA o save pendente ENQUANTO o perfil antigo ainda é o ativo.
        //    Aqui `perfilAtivo` e as arrays ainda combinam, então esta gravação
        //    é a correta — e preserva os últimos segundos de edição do usuário
        //    em vez de descartá-los.
        if (_saveDebounceTimer) {
            try { await salvarDados(true); } catch (e) { _log.error('PERFIL_FLUSH_001', e); }
        }
        // 1b) O flush acima pode ter iniciado um novo POST — espera ele pousar
        //     também, senão a corrida reabre com um voo diferente.
        if (_saveEmVoo) {
            try { await _saveEmVoo; } catch (e) { _log.error('PERFIL_VOO_002', e); }
        }
        // 2) SÓ ENTÃO fecha a porta: daqui até o load terminar, nenhum save pode
        //    rodar, porque `perfilAtivo` (novo) e as arrays (velhas) ficam
        //    dessincronizados nesse intervalo.
        _trocandoPerfil = true;

        perfilAtivo = usuarioLogado.perfis[index];

        // Persiste a seleção — restaurada automaticamente em refreshes da sessão
        try { sessionStorage.setItem('ge_perfil_id', perfilAtivo.id); } catch (_) {}

        // Pinta os KPIs a partir do último snapshot em cache — mas NÃO revela a tela
        // ainda. Serve só como valor-base do count-up de atualizarDashboardResumo(),
        // para que, quando o dashboard finalmente abrir, os números já apareçam
        // corretos, sem flash de "R$ 0,00".
        // Reabre a janela otimista: na TROCA de perfil o render anterior já
        // fechou a trava, e sem reabrir o perfil novo nunca pintaria do cache.
        _resumoRealPintado = false;
        // Sem await de propósito — esperar a decifragem atrasaria o load de rede,
        // que é justamente o que esta pintura existe para disfarçar.
        _pintarResumoBoot(perfilAtivo.id).catch(() => { /* best-effort */ });

        // ── Carrega os dados REAIS antes de revelar a tela ───────────────────
        // O loader (authLoading no boot / profileLoading na troca de perfil) fica
        // visível até TUDO estar pronto: o dashboard só abre 100% carregado, sem
        // "pop-in" de saldo ou contas fixas aparecendo depois. iniciarAutoSave e
        // salvarDados continuam DEPOIS do load — imune ao bug de wipe
        // (ver data_wipe_incident).
        await carregarDadosPerfil(perfilAtivo.id);
        atualizarReferenciasGlobais();

        // 3) Perfil e arrays voltaram a combinar → reabre as gravações.
        //    (O `finally` desta função repete isto como rede de segurança: se o
        //    load lançar, o app não pode ficar com os saves travados para sempre.)
        _trocandoPerfil = false;

        gerarCobrancasAssinaturas();

        // Renderiza TUDO que aparece acima da dobra de forma SÍNCRONA: KPIs/saldo,
        // header de reservas e a lista de contas fixas. Antes, as contas fixas eram
        // adiadas para o idle e "apareciam" só depois da tela já visível.
        atualizarDashboardResumo();
        atualizarHeaderReservas();
        atualizarListaContasFixas();
        atualizarNomeUsuario();

        // Rótulos que dependem do config do perfil (Modo viagem / Horas de Vida)
        // têm de refletir o perfil ATUAL já aqui. Sem isto, o banner de viagem
        // mostrava a viagem do perfil ANTERIOR até o save do fim da troca disparar
        // ge:save-done — a "viagem que vazava para o outro perfil" do relato de
        // 2026-07-19. É só re-render (lê o configPerfil vivo); não toca em dados.
        document.dispatchEvent(new CustomEvent('ge:perfil-carregado'));

        // ── Agora sim: revela o dashboard já completamente carregado ──────────
        // AuthGuard JÁ validou a sessão em verificarLogin ANTES deste ponto — aqui
        // só liberamos a PINTURA, não a autorização.
        const pc = document.querySelector('[data-protected-content]');
        if (pc) { pc.classList.remove('js-hidden'); pc.style.display = ''; }
        _revelarShellDashboard();
        mostrarTela('dashboard');
        // Deep-link do assistente (A1): /dashboard#relatorios abre a aba direto.
        try {
            const alvo = (location.hash || '').replace(/^#/, '');
            const TABS_DEEPLINK = ['transacoes', 'reservas', 'cartoes', 'graficos', 'relatorios', 'configuracoes', 'calendario'];
            if (TABS_DEEPLINK.includes(alvo)) {
                mostrarTela(alvo);
                history.replaceState(null, '', location.pathname + location.search);
            }
        } catch { /* hash inválido — segue no dashboard */ }
        const al = document.getElementById('authLoading');
        if (al) al.style.display = 'none';
        if (profileLoading) profileLoading.classList.add('hidden');

        if (window.chatAssistant && typeof window.chatAssistant.onProfileSelected === 'function') {
            window.chatAssistant.onProfileSelected(Object.freeze({ ...perfilAtivo }));
        }

        iniciarAutoSave();
        ligarTempoReal();

        await salvarDados();

        // Ativa o indicador de sync somente após o save inicial de boot
        _syncReadyForDisplay = true;

        // Módulos de recurso (lazy, fora do chunk crítico): previsão de fim de
        // mês, desafios e agendador do Radar. Carregam no idle pós-boot e se
        // atualizam sozinhos via evento ge:save-done — os getters do ctx são
        // vivos, então trocas de perfil não exigem re-init.
        _bootFeatureModules();

        // Onboarding automático para novos perfis (sem dados, primeira visita)
        // Chamado APÓS mostrarTela para garantir que a UI base está visível
        _verificarOnboardingNovoPerfil();

    } catch (e) {
        _log.error('PERFIL_ENTER_001', e);
        alert('Erro ao carregar o perfil. Tente novamente.');
    } finally {
        // Rede de segurança: se o load lançou no meio da troca, a guarda ficaria
        // ligada e o app pararia de salvar em SILÊNCIO até um F5 — pior que o bug
        // original. Reabrir aqui é seguro porque, em caso de erro, o próximo save
        // legítimo só acontece depois de um novo entrarNoPerfil bem-sucedido.
        _trocandoPerfil = false;
        if (profileLoading) profileLoading.classList.add('hidden');
    }
}

// ── Módulos de recurso lazy (previsão, desafios, radar) ─────────────────────
// Carregados UMA vez por sessão, no idle após o boot — não pesam no chunk
// crítico nem competem com o carregamento inicial. Cada módulo se inscreve em
// ge:save-done e usa os getters vivos do ctx (troca de perfil já coberta).
let _featureModulesBooted = false;
function _bootFeatureModules() {
    if (_featureModulesBooted) return;
    _featureModulesBooted = true;
    const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 2_500));
    idle(() => {
        const ctx = _makeCtx();
        // Previsão de fim de mês NÃO entra aqui: mora dentro do popup "Onde foi meu
        // dinheiro?" (db-relatorios) desde 2026-07-14, para não floodar a home.
        import('../modules/desafios.js?v=1')
            .then(m => m.initDesafios(ctx))
            .catch(e => _log.error('FEAT_DESAFIOS_001', e));
        import('../modules/radar.js?v=1')
            .then(m => m.initRadar(ctx))
            .catch(e => _log.error('FEAT_RADAR_001', e));
        // Contagem real da caixa de entrada do sino. O badge já foi desenhado com
        // o número em cache; isto o corrige (e é como um convite de reserva
        // recebido com o app fechado acende o sino no próximo acesso).
        import('../modules/notificacoes-inbox.js?v=1')
            .then(m => m.atualizarContagem())
            .then(() => atualizarBadgeNotificacoes())
            .catch(e => _log.error('FEAT_INBOX_001', e));
        // Aviso proativo de assinaturas não registradas (mesmo módulo do detector
        // aberto em Cartões → Assinaturas — manter o ?v= igual nos dois imports
        // para não carregar duas instâncias do módulo).
        import('../modules/recorrencias.js?v=2')
            .then(m => m.initAvisoAssinaturas(ctx))
            .catch(e => _log.error('FEAT_ASSIN_001', e));
        // Aviso de lançamentos repetidos — app é 100% manual, duplicar é comum e
        // contamina saldo/previsão/relatórios. Só PERGUNTA; não apaga nada.
        import('../modules/duplicados.js?v=1')
            .then(m => m.initAvisoDuplicados(ctx))
            .catch(e => _log.error('FEAT_DUP_001', e));
        // Semáforo de saúde financeira REMOVIDO daqui (2026-07-14): o score já vive
        // na aba Relatórios (gauge + histórico) e o dashboard estava poluído.
    });
}

// ── Perfil: criar e trocar foto vivem em perfil-acoes.js (chunk lazy) ───────
// Duas ações que o usuário faz uma vez na vida, carregadas em todo boot até
// 2026-08-10. O chunk desce no clique do "+" ou ao escolher um arquivo de foto.
let _perfilMod = null;
let _perfilCarregando = null;
function _carregarAcoesPerfil() {
    if (_perfilMod) return Promise.resolve(_perfilMod);
    if (!_perfilCarregando) {
        _perfilCarregando = import('./perfil-acoes.js?v=1')
            .then(m => { m.init(_makeCtx()); _perfilMod = m; return m; })
            .catch(err => {
                _perfilCarregando = null;
                mostrarNotificacao('Não foi possível abrir agora. Tente de novo.', 'error');
                throw err;
            });
    }
    return _perfilCarregando;
}
function adicionarNovoPerfil()  { _carregarAcoesPerfil().then(m => m.adicionarNovoPerfil()).catch(() => {}); }
function alterarFoto(event)     { _carregarAcoesPerfil().then(m => m.alterarFoto(event)).catch(() => {}); }

function mostrarPopupLimite(msgCustom) {
    let msg = msgCustom || "";
    if (!msg) {
        if (usuarioLogado.plano === "Individual")
            msg = "Infelizmente seu plano é Individual e só permite um perfil. Atualize seu plano para adicionar mais perfis.";
        else if (usuarioLogado.plano === "Casal")
            msg = "Seu plano Casal permite apenas dois perfis. Atualize seu plano para adicionar mais perfis.";
        else
            msg = "Você atingiu a quantidade máxima de usuários do seu plano.";
    }

    criarPopupDOM((popup) => {
        const titulo = document.createElement('h3');
        titulo.textContent = '🔒 Limite do Plano';

        const texto = document.createElement('p');
        texto.textContent = msg; // ✅ textContent — nunca innerHTML com variável
        texto.style.cssText = 'margin-bottom:24px; color: var(--text-secondary); line-height:1.6;';

        const botoes = document.createElement('div');
        botoes.style.cssText = 'display:flex; gap:12px; flex-wrap:wrap;';

        const btnUpgrade = document.createElement('button');
        btnUpgrade.className = 'btn-primary';
        btnUpgrade.type = 'button';
        btnUpgrade.style.cssText = 'flex:1; min-width:150px; background:linear-gradient(135deg, #6c63ff, #5a52d5); box-shadow: 0 4px 15px rgba(108,99,255,0.4);';

        const spanUpgrade = document.createElement('span');
        spanUpgrade.style.cssText = 'display:flex; align-items:center; justify-content:center; gap:8px;';
        spanUpgrade.textContent = '⬆️ Atualizar Plano';

        btnUpgrade.appendChild(spanUpgrade);
        btnUpgrade.addEventListener('click', irParaAtualizarPlano);

        const btnFechar = document.createElement('button');
        btnFechar.className = 'btn-cancelar';
        btnFechar.type = 'button';
        btnFechar.style.cssText = 'flex:1; min-width:120px;';
        btnFechar.textContent = 'Fechar';
        btnFechar.addEventListener('click', fecharPopup);

        botoes.appendChild(btnUpgrade);
        botoes.appendChild(btnFechar);

        popup.appendChild(titulo);
        popup.appendChild(texto);
        popup.appendChild(botoes);
    });
}

// ✅ NOVA FUNÇÃO: Redireciona para página de upgrade
function irParaAtualizarPlano() {
    fecharPopup();
    window.location.href = 'atualizarplano.html';
}

// Expor globalmente
window.irParaAtualizarPlano = irParaAtualizarPlano;

// ========== NAVEGAÇÃO ENTRE TELAS ==========

// Cached once — static nav elements never change after DOM is ready
let _domPages     = null;
let _domNavBtns   = null;
let _domMobileNav = null;

// Tela atualmente ativa — fonte de verdade p/ a navegação por swipe (mobile)
let _telaAtual = 'dashboard';

function _makeCtx() {
    return Object.defineProperties({}, {
        transacoes:          { get: () => transacoes,          set: v => { transacoes = v;     if (typeof _cache !== 'undefined') _cache.tx = null; }, enumerable: true },
        metas:               { get: () => metas,               set: v => { metas = v;          if (typeof _cache !== 'undefined') _cache.mt = null; }, enumerable: true },
        cartoesCredito:      { get: () => cartoesCredito,      set: v => { cartoesCredito = v; if (typeof _cache !== 'undefined') _cache.cc = null; }, enumerable: true },
        contasFixas:         { get: () => contasFixas,         set: v => { contasFixas = v;    if (typeof _cache !== 'undefined') _cache.cf = null; }, enumerable: true },
        assinaturas:         { get: () => assinaturas,         set: v => { assinaturas = v; }, enumerable: true },
        perfilAtivo:         { get: () => perfilAtivo,         set: v => { perfilAtivo = v; },         enumerable: true },
        usuarioLogado:       { get: () => usuarioLogado,       set: v => { usuarioLogado = v; },       enumerable: true },
        filtroMovAtivo:      { get: () => filtroMovAtivo,      set: v => { filtroMovAtivo = v; },      enumerable: true },
        filtroMovMes:        { get: () => filtroMovMes,        set: v => { filtroMovMes = v; },        enumerable: true },
        filtroMovAno:        { get: () => filtroMovAno,        set: v => { filtroMovAno = v; },        enumerable: true },
        nextCartaoId:        { get: () => nextCartaoId,        set: v => { nextCartaoId = v; },        enumerable: true },
        metaSelecionadaId:   { get: () => metaSelecionadaId,   set: v => { metaSelecionadaId = v; },   enumerable: true },
        cartaoSelecionadoId: { get: () => cartaoSelecionadoId, set: v => { cartaoSelecionadoId = v; }, enumerable: true },
        tipoRelatorioAtivo:  { get: () => tipoRelatorioAtivo,  set: v => { tipoRelatorioAtivo = v; },  enumerable: true },
        orcamentos:           { get: () => orcamentos,           set: v => { orcamentos = v; },           enumerable: true },
        tiposPersonalizados:  { get: () => tiposPersonalizados,  set: v => { tiposPersonalizados = v; },  enumerable: true },
        configPerfil:         { get: () => configPerfil,         set: v => { configPerfil = _sanitizarConfigPerfil(v); },     enumerable: true },
        desafiosPerfil:       { get: () => desafiosPerfil,       set: v => { desafiosPerfil = _sanitizarDesafiosPerfil(v); }, enumerable: true },
        _movPaginaAtual:     { get: () => _movPaginaAtual,     set: v => { _movPaginaAtual = v; },     enumerable: true },
        _movVisivelCache:    { get: () => _movVisivelCache,    set: v => { _movVisivelCache = v; },    enumerable: true },
        _chartJsCarregado:   { get: () => _chartJsCarregado,   set: v => { _chartJsCarregado = v; },   enumerable: true },
        _gerandoRelatorio:   { get: () => _gerandoRelatorio,   set: v => { _gerandoRelatorio = v; },   enumerable: true },
        // Constants
        BANCO_ABREV:         { value: BANCO_ABREV,         enumerable: true },
        BANCO_COR:           { value: BANCO_COR,           enumerable: true },
        BANCO_ICON:          { value: BANCO_ICON,          enumerable: true },
        _CHARTJS_SRC:        { value: _CHARTJS_SRC,        enumerable: true },
        _CHARTJS_INTEGRITY:  { value: _CHARTJS_INTEGRITY,  enumerable: true },
        _validators:         { value: _validators,         enumerable: true },
        verificarAnomaliaGasto:     { value: (tipo, v) => _notificacaoControl.verificarAnomaliaGasto(tipo, v), enumerable: true },
        // Conquistas: avaliação + leitura do estado/desbloqueios p/ a tela de perfil
        checarConquistas:    { value: () => checarConquistas(),       enumerable: true },
        getConquistaState:   { value: () => _buildConquistaState(),   enumerable: true },
        getConquistas:       { get: () => conquistasPerfil,           enumerable: true },
        _log:                { get: () => _log,            enumerable: true },
        // Utility functions
        formatBRL:           { value: (...a) => formatBRL(...a),           enumerable: true },
        formatarDataBR:      { value: (...a) => formatarDataBR(...a),      enumerable: true },
        dataParaISO:         { value: (...a) => dataParaISO(...a),         enumerable: true },
        getMesNome:          { value: (...a) => getMesNome(...a),          enumerable: true },
        agoraDataHora:       { value: (...a) => agoraDataHora(...a),       enumerable: true },
        isoDate:             { value: (...a) => isoDate(...a),             enumerable: true },
        yearMonthKey:        { value: (...a) => yearMonthKey(...a),        enumerable: true },
        sanitizeNumber:      { value: (...a) => sanitizeNumber(...a),      enumerable: true },
        sanitizeDate:        { value: (...a) => sanitizeDate(...a),        enumerable: true },
        _sanitizeText:       { value: (...a) => _sanitizeText(...a),       enumerable: true },
        _sanitizeImgUrl:     { value: (...a) => _sanitizeImgUrl(...a),     enumerable: true },
        sanitizeHTML:        { value: (...a) => sanitizeHTML(...a),        enumerable: true },
        _aplicarEstilosCSOM: { value: (...a) => _aplicarEstilosCSOM(...a), enumerable: true },
        criarPopup:          { value: (...a) => criarPopup(...a),          enumerable: true },
        criarPopupDOM:       { value: (...a) => criarPopupDOM(...a),       enumerable: true },
        fecharPopup:         { value: (...a) => fecharPopup(...a),         enumerable: true },
        confirmarAcao:       { value: (...a) => confirmarAcao(...a),       enumerable: true },
        mostrarNotificacao:  { value: (...a) => mostrarNotificacao(...a),  enumerable: true },
        mostrarNotificacaoDesfazer: { value: (...a) => mostrarNotificacaoDesfazer(...a), enumerable: true },
        salvarDados:         { value: (...a) => salvarDados(...a),         enumerable: true },
        salvarDadosUrgente:  { value: () => salvarDados(true),            enumerable: true },
        // Reserva compartilhada (v2): db-metas precisa ler/escrever nos slots dos
        // OUTROS perfis (o blob é uma linha só, array de perfis). Expõe a fonte de
        // verdade; a lógica de propagação vive em db-metas (chunk lazy, com folga).
        allProfilesData:     { get: () => _allProfilesData,              enumerable: true },
        atualizarTudo:             { value: (...a) => atualizarTudo(...a),             enumerable: true },
        atualizarListaContasFixas: { value: (...a) => atualizarListaContasFixas(...a), enumerable: true },
        // Usado pela restauração de backup (db-configuracoes): trava as gravações
        // ANTES de pedir o snapshot ao servidor, para a memória velha não gravar
        // por cima do que foi restaurado. Sem contrapartida — só o reload libera.
        congelarGravacoes:         { value: () => congelarGravacoes(),                enumerable: true },
        // As 3 abaixo eram chamadas pelas pages lazy SEM estar no ctx — ReferenceError
        // silencioso desde o split de dashboard.js (achado por scripts/check-refs.mjs).
        atualizarHeaderReservas:   { value: (...a) => atualizarHeaderReservas(...a),   enumerable: true },
        atualizarNomeUsuario:      { value: (...a) => atualizarNomeUsuario(...a),      enumerable: true },
        rollbackArray:             { value: (...a) => rollbackArray(...a),             enumerable: true },
        // ── Consumidas por perfil-acoes.js (criar perfil / trocar foto) ────────
        limitesPlano:              { value: limitesPlano,                              enumerable: true },
        _FOTO_ORIGEM_MAX_BYTES:    { value: _FOTO_ORIGEM_MAX_BYTES,                    enumerable: true },
        _sanitizeImageFile:        { value: (...a) => _sanitizeImageFile(...a),        enumerable: true },
        _resolverFotoPerfil:       { value: (...a) => _resolverFotoPerfil(...a),       enumerable: true },
        _gerarSignedUrl:           { value: (...a) => _gerarSignedUrl(...a),           enumerable: true },
        invalidarCachePerfis:      { value: (...a) => invalidarCachePerfis(...a),      enumerable: true },
        atualizarTelaPerfis:       { value: (...a) => atualizarTelaPerfis(...a),       enumerable: true },
        atualizarReferenciasGlobais: { value: (...a) => atualizarReferenciasGlobais(...a), enumerable: true },
        _avancarMes:               { value: (...a) => _avancarMes(...a),               enumerable: true },
        // Invalida o cache de cópias congeladas (window.transacoes e cia.) por
        // CHAVE. Expõe a operação, não o objeto: um módulo lazy que recebesse
        // `_cache` poderia trocá-lo por outro e o dashboard nunca saberia.
        _invalidarCache:           { value: (...chaves) => { for (const k of chaves) if (k in _cache) _cache[k] = null; }, enumerable: true },
        _requerPerfilAtivo:        { value: (...a) => _requerPerfilAtivo(...a),        enumerable: true },
        // Único que faltava para o módulo lazy de exportação (Passo 10);
        // _validators e confirmarAcao já estão expostos acima.
        _EXPORT_MAX_REGISTROS:     { get: () => _EXPORT_MAX_REGISTROS,                  enumerable: true },
        mostrarSelecaoPerfis:      { value: (...a) => mostrarSelecaoPerfis(...a),      enumerable: true },
        // Navegação entre abas — usada por avisos proativos que levam o usuário
        // até a tela onde a ação correta existe (ex.: duplicados.js → Transações).
        mostrarTela:               { value: (...a) => mostrarTela(...a),              enumerable: true },
        validarUserData:           { value: (...a) => validarUserData(...a),           enumerable: true },
        safeCategorias:            { value: (...a) => safeCategorias(...a),            enumerable: true },
        sanitizarHTMLPopup:        { value: (...a) => sanitizarHTMLPopup(...a),        enumerable: true },
        mostrarPopupLimite:        { value: (...a) => mostrarPopupLimite(...a),        enumerable: true },
        abrirPopupPagarContaFixa:  { value: (...a) => abrirPopupPagarContaFixa(...a), enumerable: true },
        gerarCobrancasAssinaturas: { value: (...a) => gerarCobrancasAssinaturas(...a), enumerable: true },
        // Cross-section lazy calls
        atualizarMovimentacoesUI: { value: () => window._dbTransacoes?.atualizarMovimentacoesUI?.(), enumerable: true },
        renderMetasList:          { value: () => window._dbMetas?.renderMetasList?.(),               enumerable: true },
        atualizarTelaCartoes:     { value: () => window._dbCartoes?.atualizarTelaCartoes?.(),        enumerable: true },
        popularFiltrosRelatorio:  { value: () => window._dbRelatorios?.popularFiltrosRelatorio?.(),  enumerable: true },
    });
}

let _dbLoaded = { transacoes: false, metas: false, cartoes: false, graficos: false, relatorios: false, configuracoes: false, calendario: false };
// Guarda contra import() concorrente (ex.: swipe pré-carrega a vizinha enquanto o
// dedo arrasta; um vai-e-volta poderia disparar 2 imports antes do 1º resolver →
// duplo init). _dbLoading marca o que já está em voo.
let _dbLoading = { transacoes: false, metas: false, cartoes: false, graficos: false, relatorios: false, calendario: false };

// Skeleton screens — preenchem o container da aba ENQUANTO o módulo é importado
// (dynamic import()). Sem isso, no 1º acesso a área fica vazia e o conteúdo "pipoca"
// quando o chunk resolve. O render do módulo faz innerHTML='' e substitui o skeleton.
const _SKELETON_ALVOS = {
    transacoes: { id: 'listaMovimentacoes', linhas: 6, tipo: 'linha' },
    cartoes:    { id: 'cartoesGrid',        linhas: 3, tipo: 'card'  },
    reservas:   { id: 'listaMetas',         linhas: 4, tipo: 'card'  },
};

function _injetarSkeleton(tela) {
    const cfg = _SKELETON_ALVOS[tela];
    if (!cfg) return;
    const cont = document.getElementById(cfg.id);
    if (!cont) return;

    // Só roda no 1º acesso (guardado por !_dbLoaded). Limpa o placeholder
    // estático do HTML (<p class="empty-state">) que senão piscaria sob o skeleton.
    cont.innerHTML = '';

    const wrap = document.createElement('div');
    wrap.className = 'ge-skel-wrap';
    wrap.setAttribute('aria-hidden', 'true'); // decorativo; aria-busy abaixo anuncia o estado
    for (let i = 0; i < cfg.linhas; i++) {
        const item = document.createElement('div');
        item.className = `ge-skel ge-skel--${cfg.tipo}`;
        wrap.appendChild(item);
    }
    cont.setAttribute('aria-busy', 'true');
    cont.appendChild(wrap);
}

function mostrarTela(tela) {
    // Transição leve 100% CSS (.page.active → keyframe pageEnter: opacity+translateY
    // compositados na GPU). Antes usávamos document.startViewTransition(), que tira um
    // SNAPSHOT da viewport inteira a cada troca — o DOM do dashboard é enorme, então
    // isso travava em aparelhos fracos e ainda fazia crossfade para a aba VAZIA enquanto
    // o módulo era importado (conteúdo "pipocava" depois). A animação CSS é barata,
    // consistente e cobre o reflow do display:none→block. _mostrarTelaImpl já marca a
    // navegação ativa de forma síncrona no início → feedback instantâneo no clique.
    _mostrarTelaImpl(tela);
}

function _mostrarTelaImpl(tela) {
    if (!_domPages)     _domPages     = document.querySelectorAll('.page');

    _domPages.forEach(p => {
        p.classList.remove('active', 'ge-page-enter');
        p.style.display = 'none';
    });

    window.scrollTo({ top: 0, behavior: 'instant' });

    _setNavAtiva(tela);

    const pageEl = document.getElementById(tela + 'Page');
    if (pageEl) {
        pageEl.style.display = 'block';
        // ge-page-enter = opt-in do "rise" do pageEnter (só p/ navegação por
        // clique). O swipe finaliza sem essa classe → desliza sem piscar.
        pageEl.classList.add('active', 'ge-page-enter');
    }

    _telaAtual = tela;
    _carregarModuloTela(tela);
}

// Destaca o item de navegação ativo (sidebar desktop + bottom nav mobile).
// Extraído de _mostrarTelaImpl p/ ser reusado pela transição de swipe, que
// finaliza o estado canônico sem refazer o display/lazy-load.
function _setNavAtiva(tela) {
    if (!_domNavBtns)   _domNavBtns   = document.querySelectorAll('.nav-btn');
    if (!_domMobileNav) _domMobileNav = document.querySelectorAll('.mobile-nav-item');

    // `aria-current` acompanha a classe .active: a cor sozinha diz qual aba está
    // aberta para quem VÊ — no leitor de tela, sem isto, todos os itens soam
    // iguais e a pessoa perde a noção de onde está (WCAG 4.1.2).
    _domNavBtns.forEach(btn => { btn.classList.remove('active'); btn.removeAttribute('aria-current'); });
    const sidebarBtn = document.querySelector(`.nav-btn[data-page="${tela}"]`);
    if (sidebarBtn) { sidebarBtn.classList.add('active'); sidebarBtn.setAttribute('aria-current', 'page'); }

    _domMobileNav.forEach(btn => { btn.classList.remove('active'); btn.removeAttribute('aria-current'); });
    const mobileBtn = document.querySelector(`.mobile-nav-item[data-page="${tela}"]`);
    if (mobileBtn) { mobileBtn.classList.add('active'); mobileBtn.setAttribute('aria-current', 'page'); }
}

// Lazy-load + refresh do módulo de cada aba. Idempotente (guardado por
// _dbLoaded): chamar de novo numa aba já carregada só dispara o refresh de UI.
function _carregarModuloTela(tela) {
    if (tela === 'transacoes') {
        filtroMovAtivo = 'mes_atual';
        filtroMovMes   = null;
        filtroMovAno   = null;
        const container = document.getElementById('movFiltros');
        if (container) {
            container.querySelectorAll('.mov-filtro-btn').forEach(b => b.classList.remove('active'));
            const btnMesAtual = container.querySelector('[data-filtro="mes_atual"]');
            if (btnMesAtual) btnMesAtual.classList.add('active');
        }
        const periodoSel = document.getElementById('movPeriodoSelector');
        if (periodoSel) periodoSel.style.display = 'none';

        if (!_dbLoaded.transacoes && !_dbLoading.transacoes) {
            _dbLoading.transacoes = true;
            _injetarSkeleton('transacoes');
            import('./db-transacoes.js?v=9').then(m => {
                m.init(_makeCtx());
                _dbLoaded.transacoes = true;
                _dbLoading.transacoes = false;
                document.getElementById('listaMovimentacoes')?.removeAttribute('aria-busy');
            });
        } else if (_dbLoaded.transacoes) {
            window._dbTransacoes?.atualizarMovimentacoesUI?.();
        }
    }

    if (tela === 'reservas') {
        if (!_dbLoaded.metas && !_dbLoading.metas) {
            _dbLoading.metas = true;
            _injetarSkeleton('reservas');
            import('./db-metas.js?v=5').then(m => {
                m.init(_makeCtx());
                _dbLoaded.metas = true;
                _dbLoading.metas = false;
                document.getElementById('listaMetas')?.removeAttribute('aria-busy');
            });
        } else if (_dbLoaded.metas) {
            window._dbMetas?.renderMetasList?.();
        }
    }

    if (tela === 'calendario') {
        if (!_dbLoaded.calendario && !_dbLoading.calendario) {
            _dbLoading.calendario = true;
            import('./db-calendario.js?v=1').then(m => {
                m.init(_makeCtx());
                _dbLoaded.calendario = true;
                _dbLoading.calendario = false;
            });
        } else if (_dbLoaded.calendario) {
            window._dbCalendario?.render?.();
        }
    }

    if (tela === 'cartoes') {
        if (!_dbLoaded.cartoes && !_dbLoading.cartoes) {
            _dbLoading.cartoes = true;
            _injetarSkeleton('cartoes');
            import('./db-cartoes.js?v=6').then(m => {
                m.init(_makeCtx());
                _dbLoaded.cartoes = true;
                _dbLoading.cartoes = false;
                document.getElementById('cartoesGrid')?.removeAttribute('aria-busy');
            });
        } else if (_dbLoaded.cartoes) {
            window._dbCartoes?.atualizarTelaCartoes?.();
        }
    }

    if (tela === 'graficos') {
        if (!_dbLoaded.graficos && !_dbLoading.graficos) {
            _dbLoading.graficos = true;
            import('./db-graficos.js?v=4').then(m => {
                m.init(_makeCtx());
                _dbLoaded.graficos = true;
                _dbLoading.graficos = false;
            });
        } else if (_dbLoaded.graficos) {
            window._dbGraficos?.inicializarGraficos?.();
        }
    }

    if (tela === 'relatorios') {
        if (!_dbLoaded.relatorios && !_dbLoading.relatorios) {
            _dbLoading.relatorios = true;
            import('./db-relatorios.js?v=9').then(m => {
                m.init(_makeCtx());
                _dbLoaded.relatorios = true;
                _dbLoading.relatorios = false;
            });
        } else if (_dbLoaded.relatorios) {
            window._dbRelatorios?.popularFiltrosRelatorio?.();
        }
    }

    if (tela === 'configuracoes') {
        if (!_dbLoaded.configuracoes) {
            import('./db-configuracoes.js?v=8').then(m => {
                m.init(_makeCtx());
                _dbLoaded.configuracoes = true;
                if (_abrirHubAoCarregar) { _abrirHubAoCarregar = false; window.abrirPerfilHub?.(); }
            });
        } else if (_abrirHubAoCarregar) {
            _abrirHubAoCarregar = false;
            window.abrirPerfilHub?.();
        }
    }
}

// NOTA: a transição lateral de swipe (o "carrossel" das duas páginas) vive em
// swipe-nav.js — módulo lazy, mobile-only. Tirá-la daqui mantém o dashboard.js
// dentro do orçamento de bundle (eager). O módulo recebe os primitivos abaixo
// via initSwipeNav: _carregarModuloTela, _setNavAtiva e o setter de _telaAtual.

// Clicar na foto de perfil (sidebar/mobile) leva à aba Configurações e abre o
// hub de perfil (nome, foto, conquistas). O hub vive no módulo lazy de
// configurações — a flag garante que ele abra assim que o módulo carrega.
let _abrirHubAoCarregar = false;
function abrirPerfilUsuario() {
    _abrirHubAoCarregar = true;
    mostrarTela('configuracoes');
}

// ========== ATUALIZAR NOME E FOTO DO USUÁRIO ==========
function atualizarNomeUsuario() {
    const nome  = _sanitizeText(perfilAtivo?.nome || usuarioLogado.nome || 'Usuário');
    const plano = _sanitizeText(usuarioLogado.plano || 'Plano Indefinido');

    const userNameEl          = document.getElementById('userName');
    const welcomeNameEl       = document.getElementById('welcomeName');
    const userPlanEl          = document.querySelector('[data-user-plan]');

    // Sidebar
    const userPhotoEl         = document.getElementById('userPhoto');
    const userPhotoFallbackEl = document.getElementById('userPhotoFallback');

    // Mobile topbar
    const mobilePhotoEl       = document.getElementById('mobileUserPhoto');
    const mobilePhotoFbEl     = document.getElementById('mobileUserPhotoFallback');

    if (userNameEl)    userNameEl.textContent    = nome;
    if (welcomeNameEl) welcomeNameEl.textContent = nome;
    if (userPlanEl)    userPlanEl.textContent     = plano;

    // Card de perfil na aba Configurações
    const cfgNomeEl   = document.getElementById('cfgUserNome');
    const cfgPlanoEl  = document.getElementById('cfgUserPlano');
    const cfgPhotoEl  = document.getElementById('cfgUserPhoto');
    const cfgAvatarEl = document.getElementById('cfgUserAvatar');
    if (cfgNomeEl)  cfgNomeEl.textContent  = nome;
    if (cfgPlanoEl) cfgPlanoEl.textContent = plano;

    // Helper: atualiza par (img + fallback) com a mesma lógica
    const _syncFoto = (photoEl, fbEl) => {
        if (perfilAtivo?.foto) {
            const urlSegura = _sanitizeImgUrl(perfilAtivo.foto);
            if (urlSegura) {
                if (photoEl) { photoEl.src = urlSegura; photoEl.style.display = ''; }
                if (fbEl)    fbEl.style.display = 'none';
            } else {
                if (photoEl) photoEl.style.display = 'none';
                if (fbEl)    { fbEl.style.display = 'flex'; fbEl.textContent = nome.trim().charAt(0).toUpperCase() || 'U'; }
            }
        } else {
            if (photoEl) photoEl.style.display = 'none';
            if (fbEl)    { fbEl.style.display = 'flex'; fbEl.textContent = nome.trim().charAt(0).toUpperCase() || 'U'; }
        }
    };

    _syncFoto(userPhotoEl, userPhotoFallbackEl);   // sidebar
    _syncFoto(mobilePhotoEl, mobilePhotoFbEl);     // mobile topbar
    _syncFoto(cfgPhotoEl,   cfgAvatarEl);          // card de perfil em Configurações
}

// Magic bytes das extensões permitidas
//    Centraliza a lógica de URL para usar em alterarFoto e carregarPerfis
async function _gerarSignedUrl(storagePath) {
    const { data, error } = await supabase.storage
        .from('profile-photos')
        .createSignedUrl(storagePath, 3600); // expira em 1 hora

    if (error || !data?.signedUrl) {
        _log.error('SIGNED_URL_001', error);
        return null;
    }
    // ✅ A signed URL do Supabase vem do mesmo domínio — valida antes de usar
    return _sanitizeImgUrl(data.signedUrl);
}


// ✅ Renova signed URLs que estejam próximas de expirar (chame a cada 50 min via setInterval)
//    Isso resolve o tradeoff de signed URLs expirando durante a sessão do usuário
async function _renovarFotosExpiradas() {
    for (const perfil of usuarioLogado.perfis) {
        if (!perfil._storagePath) continue;
        const novaUrl = await _gerarSignedUrl(perfil._storagePath);
        if (novaUrl) {
            perfil.foto = novaUrl;
            if (perfilAtivo?.id === perfil.id) {
                perfilAtivo.foto = novaUrl;
                const userPhotoEl = document.getElementById('userPhoto');
                if (userPhotoEl) userPhotoEl.src = novaUrl;
            }
        }
    }
    atualizarReferenciasGlobais();
}

// ✅ Inicia renovação automática de signed URLs a cada 50 minutos
//    (URLs expiram em 60 min — renovamos 10 min antes)
let _renovacaoFotosInterval = null;

// Cached saldo DOM refs — populated once, reused on every transaction change
const _domSaldoEls = { entradas: null, saidas: null, saldo: null, reservas: null, hero: null };
function iniciarRenovacaoFotos() {
    if (_renovacaoFotosInterval) clearInterval(_renovacaoFotosInterval);
    _renovacaoFotosInterval = setInterval(_renovarFotosExpiradas, 50 * 60 * 1000);
}

// ========== DASHBOARD - RESUMO E CONTAS FIXAS ==========
// ========== SISTEMA DE FECHAMENTO DE MÊS — FILTRO DO DASHBOARD ==========

const _NOMES_MESES_DASH = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho',
                           'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

function _getMesAnoAtual() {
    const hoje = new Date();
    return {
        mes: String(hoje.getMonth() + 1).padStart(2, '0'),
        ano: String(hoje.getFullYear()),
    };
}

// Retorna array { mes, ano } de todos os meses com transações, mais recente primeiro
function _getMesesDisponiveis() {
    const vistos = new Set();
    transacoes.forEach(t => {
        if (t.data && /^\d{2}\/\d{2}\/\d{4}$/.test(t.data)) {
            const parts = t.data.split('/');
            vistos.add(`${parts[1]}/${parts[2]}`);
        }
    });
    // Garante o mês atual sempre presente
    const { mes: ma, ano: aa } = _getMesAnoAtual();
    vistos.add(`${ma}/${aa}`);

    return Array.from(vistos)
        .sort((a, b) => {
            const [ma2, aa2] = a.split('/').map(Number);
            const [mb, ab]   = b.split('/').map(Number);
            return ab !== aa2 ? ab - aa2 : mb - ma2;
        })
        .map(k => { const [m, a] = k.split('/'); return { mes: m, ano: a }; });
}

// Filtra transações por mes/ano (DD/MM/YYYY)
function _filtrarTransacoesMes(mes, ano) {
    const sufixo = `/${mes}/${ano}`;
    return transacoes.filter(t => typeof t.data === 'string' && t.data.endsWith(sufixo));
}

// Retorna label legível do filtro atual
function _labelMesDash(filtro) {
    if (!filtro) return 'Mês atual';
    const { mes, ano } = filtro;
    const { mes: ma, ano: aa } = _getMesAnoAtual();
    if (mes === ma && ano === aa) return 'Mês atual';
    return `${_NOMES_MESES_DASH[parseInt(mes, 10) - 1]} ${ano}`;
}

// Atualiza o label do botão (desktop + mobile)
function _atualizarLabelBtnMes() {
    const label = _labelMesDash(_dashMesFiltro);
    ['labelPeriodoDashboard', 'labelPeriodoDashMobile'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = label;
    });
}

// Abre/fecha o dropdown do seletor de mês
function _abrirSeletorMesDash(btnRef) {
    // Remove dropdown existente se for o mesmo botão
    const existente = document.getElementById('dashMesDropdown');
    if (existente) { existente.remove(); return; }

    const meses = _getMesesDisponiveis();
    const { mes: ma, ano: aa } = _getMesAnoAtual();

    const dropdown = document.createElement('div');
    dropdown.id = 'dashMesDropdown';
    dropdown.style.cssText = `
        position: absolute; z-index: 9999; min-width: 200px;
        background: #1a1d2e; border: 1px solid rgba(67,160,71,0.35);
        border-radius: 14px; box-shadow: 0 8px 32px rgba(0,0,0,0.55);
        overflow: hidden; max-height: 320px; overflow-y: auto;
    `;

    // Posiciona relativo ao botão
    const rect = btnRef.getBoundingClientRect();
    dropdown.style.top  = `${rect.bottom + window.scrollY + 6}px`;
    dropdown.style.left = `${rect.left   + window.scrollX}px`;

    function criarOpcao(label, mes, ano, isAtivo) {
        const li = document.createElement('button');
        li.type = 'button';
        li.style.cssText = `
            display: flex; align-items: center; gap: 10px; width: 100%;
            padding: 11px 16px; background: none; border: none; cursor: pointer;
            color: ${isAtivo ? '#10b981' : 'rgba(255,255,255,0.82)'};
            font-size: 0.9rem; font-weight: ${isAtivo ? '700' : '500'};
            text-align: left; transition: background 0.12s;
        `;
        li.addEventListener('mouseenter', () => { li.style.background = 'rgba(255,255,255,0.06)'; });
        li.addEventListener('mouseleave', () => { li.style.background = ''; });
        if (isAtivo) {
            const dot = document.createElement('span');
            dot.style.cssText = 'width:7px; height:7px; border-radius:50%; background:#10b981; flex-shrink:0;';
            li.appendChild(dot);
        }
        li.appendChild(document.createTextNode(label));
        li.addEventListener('click', () => {
            _dashMesFiltro = (mes === ma && ano === aa) ? null : { mes, ano };
            _atualizarLabelBtnMes();
            atualizarDashboardResumo();
            dropdown.remove();
        });
        return li;
    }

    // Opção "Mês atual" sempre no topo
    const isMesAtual = !_dashMesFiltro || (_dashMesFiltro.mes === ma && _dashMesFiltro.ano === aa);
    dropdown.appendChild(criarOpcao('Mês atual', ma, aa, isMesAtual));

    // Divisor
    const div = document.createElement('div');
    div.style.cssText = 'height:1px; background:rgba(255,255,255,0.07); margin:4px 0;';
    dropdown.appendChild(div);

    // Meses históricos (excluindo o atual)
    meses.filter(m => !(m.mes === ma && m.ano === aa)).forEach(({ mes, ano }) => {
        const lbl   = `${_NOMES_MESES_DASH[parseInt(mes, 10) - 1]} ${ano}`;
        const ativo = _dashMesFiltro?.mes === mes && _dashMesFiltro?.ano === ano;
        dropdown.appendChild(criarOpcao(lbl, mes, ano, ativo));
    });

    document.body.appendChild(dropdown);

    // Fecha ao clicar fora
    const fechar = (e) => {
        if (!dropdown.contains(e.target) && e.target !== btnRef && !btnRef.contains(e.target)) {
            dropdown.remove();
            document.removeEventListener('click', fechar, true);
        }
    };
    setTimeout(() => document.addEventListener('click', fechar, true), 0);

    // Fecha com Escape
    const fecharEsc = (e) => { if (e.key === 'Escape') { dropdown.remove(); document.removeEventListener('keydown', fecharEsc); } };
    document.addEventListener('keydown', fecharEsc);
}

// Inicializa o botão de seleção de mês (desktop + mobile)
function _initBtnPeriodoDash() {
    ['btnPeriodoDashboard', 'btnPeriodoDashMobile'].forEach(id => {
        const btn = document.getElementById(id);
        if (!btn) return;
        btn.addEventListener('click', () => _abrirSeletorMesDash(btn));
    });
    _atualizarLabelBtnMes();
}

// ── Boot otimista (display-only) ─────────────────────────────────────────────
// Guarda APENAS os KPIs já renderizados do topo (entradas/saídas/saldo/reservas),
// por usuário+perfil, para pintar o dashboard instantaneamente no próximo boot
// enquanto o load de rede ainda corre ("abriu e já está lá"). É só pintura: NUNCA
// toca nos arrays de dados nem no save path → impossível causar wipe
// (ver data_wipe_incident). O load real reconcilia logo em seguida via count-up.
// O armazenamento vive em modules/boot-cache.js e é CIFRADO (AES-GCM, chave
// não-extraível) desde 2026-07-19 — antes o saldo, as entradas e as saídas
// ficavam em CLARO no localStorage, enquanto o histórico do chat já era cifrado
// pela mesma razão. Import dinâmico de propósito: o módulo puxa a cripto do
// assistente e não pode entrar no chunk crítico do dashboard (orçamento 40 KB).
let _bootCachePromise = null;
function _bootCache() {
    if (!_bootCachePromise) _bootCachePromise = import('../modules/boot-cache.js');
    return _bootCachePromise;
}

// Trava anti-repintura. A pintura otimista virou ASSÍNCRONA (precisa decifrar),
// então sem isto ela poderia resolver DEPOIS do render real e repor números
// velhos por cima dos verdadeiros — pior que não pintar nada.
let _resumoRealPintado = false;

function _salvarResumoBoot(perfilId, kpis) {
    if (!perfilId || !_effectiveUserId) return;
    _bootCache()
        .then((m) => m.guardarKpis(_effectiveUserId, perfilId, kpis))
        .catch(() => { /* cache é best-effort: falhar aqui não afeta o app */ });
}

// Pinta os KPIs do cache (define textContent + dataset.num, que vira a base do
// count-up). Retorna true se de fato pintou algo. Respeita saldo oculto.
async function _pintarResumoBoot(perfilId) {
    if (!perfilId || !_effectiveUserId) return false;
    let dados;
    try {
        const m = await _bootCache();
        dados = await m.lerKpis(_effectiveUserId, perfilId);
    } catch (_) { return false; }
    if (!dados) return false;

    // Decifrar levou tempo e o load real pode ter chegado nesse meio-tempo.
    // Se já pintou de verdade, desistir — número velho por cima do certo é
    // exatamente o que esta feature NÃO pode causar.
    if (_resumoRealPintado) return false;

    const pares = [
        ['totalEntradas', dados.entradas],
        ['totalSaidas',   dados.saidas],
        ['totalSaldo',    dados.saldo],
        ['totalReservas', dados.reservas],
        ['heroSaldo',     dados.saldo],
    ];
    let pintou = false;
    for (const [id, val] of pares) {
        const n = Number(val);
        if (!Number.isFinite(n)) continue;
        const el = document.getElementById(id);
        if (!el) continue;
        el.dataset.num = String(n); // base p/ o count-up de atualizarDashboardResumo()
        if (id === 'heroSaldo') {
            el.dataset.valor = formatBRL(n);
            if (el.classList.contains('oculto')) continue; // não revela saldo escondido
        }
        el.textContent = formatBRL(n);
        pintou = true;
    }
    return pintou;
}

function atualizarDashboardResumo() {
    // O total reservado exibido é o `totalReservasCalc` (somado das metas, abaixo).
    let totalEntradas = 0, totalSaidas = 0;
    let corrupcaoDetectada = false;

    // ✅ Função auxiliar: converte para número, rejeita NaN e Infinity
    //    DIFERENÇA DA VERSÃO ANTERIOR: não rejeita mais negativos silenciosamente —
    //    valores negativos são logados como corrupção e zerados, mas registrados
    const toValorSeguro = (v, contexto) => {
        const n = parseFloat(v);
        if (!isFinite(n)) {
            console.warn(`[DASHBOARD] Valor não-finito detectado em ${contexto}:`, v);
            corrupcaoDetectada = true;
            return 0;
        }
        if (n < 0) {
            // ✅ Loga corrupção em vez de mascarar silenciosamente
            console.warn(`[DASHBOARD] Valor negativo suspeito em ${contexto}:`, n);
            corrupcaoDetectada = true;
            return 0;
        }
        return n;
    };

    // ── Determina o mês filtrado ──────────────────────────────────────────
    const filtroMes = _dashMesFiltro ?? _getMesAnoAtual();
    const txMes = _filtrarTransacoesMes(filtroMes.mes, filtroMes.ano);

    // Mês anterior para comparação
    let mesAnterior = parseInt(filtroMes.mes, 10) - 1;
    let anoAnterior = parseInt(filtroMes.ano, 10);
    if (mesAnterior < 1) { mesAnterior = 12; anoAnterior--; }
    const txMesAnt = _filtrarTransacoesMes(
        String(mesAnterior).padStart(2, '0'),
        String(anoAnterior)
    );

    // ── Entradas/Saídas do mês selecionado ───────────────────────────────
    txMes.forEach((t, i) => {
        const valor = toValorSeguro(t.valor, `transacao[${i}] id=${t.id}`);
        if (t.categoria === 'entrada')          totalEntradas += valor;
        else if (t.categoria === 'saida')        totalSaidas   += valor;
    });

    // ── Saldo = acumulado de TODAS as transações (não filtrado por mês) ──
    let saldoTotal = 0;
    transacoes.forEach((t, i) => {
        const valor = toValorSeguro(t.valor, `transacao[${i}] id=${t.id}`);
        if      (t.categoria === 'entrada')           saldoTotal += valor;
        else if (t.categoria === 'saida')             saldoTotal -= valor;
        else if (t.categoria === 'reserva')           saldoTotal -= valor;
        else if (t.categoria === 'retirada_reserva')  saldoTotal += valor;
    });

    // ── Entradas/Saídas do mês anterior (para %) ─────────────────────────
    let entAnt = 0, saiAnt = 0;
    txMesAnt.forEach((t, i) => {
        const valor = toValorSeguro(t.valor, `mesAnt transacao[${i}]`);
        if (t.categoria === 'entrada') entAnt += valor;
        else if (t.categoria === 'saida') saiAnt += valor;
    });

    // ── % de variação ─────────────────────────────────────────────────────
    /**
     * Formata variação percentual com ▲/▼ e define classe CSS no elemento destino.
     * @param {number} atual    - Valor do mês atual
     * @param {number} anterior - Valor do mês anterior
     * @param {HTMLElement} [el] - Elemento onde aplicar a classe de cor
     * @returns {string} Texto formatado com seta e percentual
     */
    function _pct(atual, anterior, el) {
        if (anterior === 0) {
            if (el) { el.classList.remove('pct--up', 'pct--down', 'pct--neutral'); el.classList.add('pct--neutral'); }
            return atual > 0 ? '▲ 100%' : '—';
        }
        const pct = ((atual - anterior) / anterior * 100);
        const abs = Math.abs(pct).toFixed(1);
        if (el) {
            el.classList.remove('pct--up', 'pct--down', 'pct--neutral');
            el.classList.add(pct > 0.5 ? 'pct--up' : pct < -0.5 ? 'pct--down' : 'pct--neutral');
        }
        if (pct > 0.5)  return `▲ ${abs}%`;
        if (pct < -0.5) return `▼ ${abs}%`;
        return `≈ ${abs}%`;
    }

    const saldo = saldoTotal;

    const totalReservasCalc = metas.reduce((s, m, i) => {
        if (_ehRecibo(m)) return s;
        return s + toValorSeguro(m.saved, `meta[${i}] id=${m.id}`);
    }, 0);

    // ✅ Se corrupção detectada, exibe aviso na UI (não silencia mais)
    if (corrupcaoDetectada) {
        console.error('[DASHBOARD] ⚠️ Dados corrompidos ou manipulados detectados. Verifique o console.');
        // Opcional: exibir banner de aviso na UI
        const banner = document.getElementById('bannnerCorrupcao');
        if (banner) banner.style.display = 'block';
    }

    if (!_domSaldoEls.entradas) {
        _domSaldoEls.entradas = document.getElementById('totalEntradas');
        _domSaldoEls.saidas   = document.getElementById('totalSaidas');
        _domSaldoEls.saldo    = document.getElementById('totalSaldo');
        _domSaldoEls.reservas = document.getElementById('totalReservas');
        _domSaldoEls.hero     = document.getElementById('heroSaldo');
    }
    const { entradas: entradasEl, saidas: saidasEl, saldo: saldoEl, reservas: reservasEl, hero: heroSaldoEl } = _domSaldoEls;

    if (entradasEl) _animarMoeda(entradasEl, totalEntradas);
    if (saidasEl)   _animarMoeda(saidasEl, totalSaidas);
    if (saldoEl)    _animarMoeda(saldoEl, saldo);
    if (heroSaldoEl) {
        if (!heroSaldoEl.classList.contains('oculto')) {
            _animarMoeda(heroSaldoEl, saldo);
        } else {
            // Saldo oculto: mantém a base fresca sem revelar o valor
            heroSaldoEl.dataset.num = String(saldo);
        }
        heroSaldoEl.dataset.valor = formatBRL(saldo);
    }
    if (reservasEl)  _animarMoeda(reservasEl, totalReservasCalc);

    // Snapshot display-only p/ boot otimista (não toca em arrays nem no save path)
    // Dados REAIS na tela: fecha a porta para a pintura otimista (que é async e
    // pode estar decifrando ainda) e realimenta o cache do próximo boot.
    _resumoRealPintado = true;
    if (perfilAtivo) _salvarResumoBoot(perfilAtivo.id, {
        entradas: totalEntradas, saidas: totalSaidas,
        saldo: saldo, reservas: totalReservasCalc,
    });

    // ── % variação vs mês anterior ───────────────────────────────────────
    const elPctEnt  = document.getElementById('percentEntradas');
    const elPctSai  = document.getElementById('percentSaidas');
    const elPctSld  = document.getElementById('percentSaldo');
    const nomeMesAnt = _NOMES_MESES_DASH[mesAnterior - 1];

    if (elPctEnt) elPctEnt.textContent = `${_pct(totalEntradas, entAnt, elPctEnt)} vs ${nomeMesAnt}`;
    if (elPctSai) elPctSai.textContent = `${_pct(totalSaidas,  saiAnt, elPctSai)} vs ${nomeMesAnt}`;
    if (elPctSld) { elPctSld.textContent = 'Saldo acumulado total'; elPctSld.classList.add('pct--neutral'); }

    // ── Card labels com mês quando em modo histórico ──────────────────────
    const labelEntEl = document.querySelector('#cardEntradasDashboard .card-label');
    const labelSaiEl = document.querySelector('#cardSaidasDashboard .card-label');
    const isMesAtualView = !_dashMesFiltro;
    const suffixo = isMesAtualView ? '' : ` · ${_NOMES_MESES_DASH[parseInt(filtroMes.mes,10)-1]}`;
    if (labelEntEl) labelEntEl.textContent = `Entradas${suffixo}`;
    if (labelSaiEl) labelSaiEl.textContent = `Saídas${suffixo}`;

    document.querySelector('.cards-grid[data-loading]')?.removeAttribute('data-loading');
}

// ========== SISTEMA DE NOTIFICAÇÕES DE VENCIMENTO ==========

// Solicitar permissão para notificações (executar ao carregar)
function solicitarPermissaoNotificacoes() {
    if ("Notification" in window && Notification.permission === "default") {
        Notification.requestPermission().then(permission => {
            if (permission === "granted") {
                sistemaLog.adicionar('INFO', 'Permissão de notificações concedida');
            }
        });
    }
}

// Enviar notificação nativa
function enviarNotificacaoNativa(titulo, mensagem, tipo = 'info') {
    if (!("Notification" in window) || Notification.permission !== "granted") return;

    const tiposPermitidos = ['urgente', 'alerta', 'info'];
    const tipoSeguro  = tiposPermitidos.includes(tipo) ? tipo : 'info';
    const icone       = tipoSeguro === 'urgente' ? '🚨' : tipoSeguro === 'alerta' ? '⚠️' : '💰';

    const tituloSeguro   = String(titulo   || '').replace(/\x00/g, '').trim().slice(0, 100);
    const mensagemSegura = String(mensagem || '').replace(/\x00/g, '').trim().slice(0, 250);

    if(!tituloSeguro) return;

    const tituloFinal = `${icone} ${tituloSeguro}`;
    const opcoes = {
        body: mensagemSegura,
        icon:  '/favicon.ico',
        badge: '/favicon.ico',
        vibrate: [200, 100, 200],
        requireInteraction: tipoSeguro === 'urgente',
        tag: 'granaevo-' + Date.now(),
        data: { url: '/dashboard' }   // o SW (sw-push-handler) usa isto no clique
    };

    // Chrome/Android proíbem `new Notification()` mesmo com permissão concedida
    // ("Illegal constructor. Use ServiceWorkerRegistration.showNotification()").
    // Preferimos sempre o service worker; o construtor fica só como fallback de
    // desktop, protegido por try/catch pra nunca derrubar a thread.
    if (navigator.serviceWorker) {
        navigator.serviceWorker.ready
            .then(reg => reg.showNotification(tituloFinal, opcoes))
            .catch(() => _notificacaoLegacy(tituloFinal, opcoes));
        return;
    }

    _notificacaoLegacy(tituloFinal, opcoes);
}

// Fallback via construtor Notification — só onde não há service worker (desktop
// antigo). O clique/foco é tratado aqui; via SW ele é tratado no notificationclick.
function _notificacaoLegacy(titulo, opcoes) {
    try {
        const notification = new Notification(titulo, opcoes);
        notification.onclick = () => {
            window.focus();
            mostrarTela('dashboard');
            notification.close();
        };
        setTimeout(() => notification.close(), 10000);
    } catch (_) {
        // Navegador sem suporte ao construtor e sem SW — silencioso (não crítico).
    }
}

// Verificar contas a vencer e vencidas — categorização inteligente
function verificarVencimentos() {
    if(!perfilAtivo || contasFixas.length === 0) return;

    const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
    const hojeISO = hoje.toISOString().slice(0, 10);

    const d3 = new Date(hoje); d3.setDate(hoje.getDate() + 3);
    const d3ISO = d3.toISOString().slice(0, 10);

    const d7 = new Date(hoje); d7.setDate(hoje.getDate() + 7);
    const d7ISO = d7.toISOString().slice(0, 10);

    const vencidas = [], hoje_ = [], em3Dias = [], proximos = [];

    contasFixas.forEach(conta => {
        if(conta.pago) return;
        if(typeof conta.vencimento !== 'string') return;
        if(!/^\d{4}-\d{2}-\d{2}$/.test(conta.vencimento)) return;
        const dataVenc = new Date(conta.vencimento + 'T00:00:00');
        if(isNaN(dataVenc.getTime())) return;

        if     (conta.vencimento <  hojeISO)  vencidas.push(conta);
        else if(conta.vencimento === hojeISO)  hoje_.push(conta);
        else if(conta.vencimento === d3ISO)    em3Dias.push(conta);
        else if(conta.vencimento <= d7ISO)     proximos.push(conta);
    });

    return {
        vencidas,
        hoje:    hoje_,
        em3Dias,
        proximos,
        // manter compat. com código legado que lê alertas.aVencer
        aVencer: [...hoje_, ...em3Dias, ...proximos],
        total:   vencidas.length + hoje_.length + em3Dias.length + proximos.length
    };
}

// Gera hash dos ids das notificações para detectar mudanças
function _notifHash(alertas) {
    if (!alertas || alertas.total === 0) return '';
    return [
        ...(alertas.vencidas  || []).map(c => `v:${c.id}`),
        ...(alertas.hoje      || []).map(c => `h:${c.id}`),
        ...(alertas.em3Dias   || []).map(c => `3:${c.id}`),
        ...(alertas.proximos  || []).map(c => `p:${c.id}`)
        // linha legada removida — aVencer é derivado
    ].sort().join(',');
}

// Avisos do servidor não dispensados, em cache local. O badge é desenhado no
// boot, muito antes de qualquer rede — ler o cache evita o badge piscar (ou
// mentir "0") até a contagem real chegar. Quem GRAVA a chave é
// modules/notificacoes-inbox.js (LS_COUNT); manter os dois nomes iguais.
function _inboxEmCache() {
    try {
        const n = parseInt(localStorage.getItem('ge_inbox_count') || '0', 10);
        return Number.isInteger(n) && n > 0 ? n : 0;
    } catch { return 0; }
}

// Atualiza badge (desktop) e bolinha (mobile) de notificações
function atualizarBadgeNotificacoes() {
    const alertas = verificarVencimentos();
    const total   = (alertas?.total ?? 0) + _inboxEmCache();

    // Badge sidebar desktop
    const badgeSidebar = document.getElementById('notifBadgeSidebar');
    if (badgeSidebar) {
        if (total > 0) {
            badgeSidebar.textContent   = String(total);
            badgeSidebar.style.display = 'flex';
            badgeSidebar.style.background = (alertas?.vencidas?.length ?? 0) > 0 ? '#ff4b4b' : '#ffd166';
        } else {
            badgeSidebar.style.display = 'none';
        }
    }

    // Bolinha mobile — aparece apenas quando há notificações novas (hash diferente
    // do visto). A contagem da caixa de entrada entra no hash: um aviso novo do
    // servidor precisa acender a bolinha igual a uma conta a vencer.
    const hashAtual = (alertas ? _notifHash(alertas) : '') + `|i:${_inboxEmCache()}`;
    const hashVisto = localStorage.getItem('granaevo_notif_hash_visto') ?? '';
    const temNovo   = total > 0 && hashAtual !== hashVisto;

    const dotMobile = document.getElementById('mobileNotifDot');
    if (dotMobile) {
        dotMobile.style.display = temNovo ? 'block' : 'none';
    }
}

// Mantém compatibilidade com chamadas antigas (substituída por atualizarBadgeNotificacoes)
function atualizarBadgeVencimentos() {
    atualizarBadgeNotificacoes();
}

// renderizarPainelAlertas() foi extraída para modules/painel-alertas.js (LAZY,
// Passo 10): ~168 linhas que só serviam ao clique do sino saíam no boot de todo
// mundo. O despacho para pagar/editar continua AQUI (listener delegado em
// abrirPainelNotificacoes) — o módulo só marca data-acao/data-id.

// Controle inteligente de notificações nativas — por categoria, sem spam
const _notificacaoControl = {
    _CHAVE:   'granaevo_notif_ctrl_v2',
    _sessao:  0, // notificações disparadas nesta sessão (reset a cada load)
    _MAX_SESSAO: 3,
    _get()  { try { return JSON.parse(localStorage.getItem(this._CHAVE) || '{}'); } catch { return {}; } },
    _save(d) { try { localStorage.setItem(this._CHAVE, JSON.stringify(d)); } catch {} },
    _limites: {
        vencidas:         48 * 3600000,
        hoje:             86400000,
        em3Dias:          86400000,
        proximos:         7 * 86400000,
        resumoSemanal:    7 * 86400000,
        anomaliaGasto:    48 * 3600000,
    },
    podeEnviar(tipo) {
        if (this._sessao >= this._MAX_SESSAO) return false;
        return Date.now() - (this._get()[tipo] || 0) > (this._limites[tipo] ?? 86400000);
    },
    marcar(tipo) {
        this._sessao++;
        const d = this._get(); d[tipo] = Date.now(); this._save(d);
    },
    // Notifica anomalia de gasto (chamado após salvar transação)
    verificarAnomaliaGasto(tipo, valorNovo) {
        if (!tipo || this._sessao >= this._MAX_SESSAO) return;
        if (!this.podeEnviar('anomaliaGasto')) return;
        const hoje = new Date();
        const mes  = hoje.getMonth() + 1, ano = hoje.getFullYear();
        const sufixo = `/${String(mes).padStart(2,'0')}/${ano}`;
        const txMes = (window.transacoes || []).filter(t =>
            t.tipo === tipo && typeof t.data === 'string' && t.data.endsWith(sufixo) &&
            (t.categoria === 'saida' || t.categoria === 'saida_credito')
        );
        const totalMes = txMes.reduce((s,t) => s + (parseFloat(t.valor)||0), 0);
        // Média dos 3 meses anteriores
        let media3m = 0; let mesesComDados = 0;
        for (let i = 1; i <= 3; i++) {
            let m3 = mes - i; let a3 = ano;
            if (m3 <= 0) { m3 += 12; a3--; }
            const sf3 = `/${String(m3).padStart(2,'0')}/${a3}`;
            const txAntes = (window.transacoes || []).filter(t =>
                t.tipo === tipo && typeof t.data === 'string' && t.data.endsWith(sf3)
            ).reduce((s,t) => s + (parseFloat(t.valor)||0), 0);
            if (txAntes > 0) { media3m += txAntes; mesesComDados++; }
        }
        if (mesesComDados < 2) return; // sem histórico suficiente
        const mediaReal = media3m / mesesComDados;
        if (totalMes > mediaReal * 1.5 && totalMes - mediaReal > 50) {
            mostrarNotificacao(`${tipo}: ${formatBRL(totalMes)} este mês — ${Math.round(((totalMes-mediaReal)/mediaReal)*100)}% acima da sua média`, 'warning');
            this.marcar('anomaliaGasto');
        }
    },
};

function verificacaoAutomaticaVencimentos() {
    const alertas = verificarVencimentos();
    if(!alertas) return;
    atualizarBadgeVencimentos();

    // Resumo semanal (segunda-feira, 1x/semana)
    const diaSemana = new Date().getDay(); // 0=dom, 1=seg
    if (diaSemana === 1 && _notificacaoControl.podeEnviar('resumoSemanal')) {
        const hoje = new Date();
        const mes  = hoje.getMonth()+1, ano = hoje.getFullYear();
        const sufixo = `/${String(mes).padStart(2,'0')}/${ano}`;
        const txMes  = transacoes.filter(t => typeof t.data === 'string' && t.data.endsWith(sufixo));
        const ent    = txMes.filter(t => t.categoria === 'entrada').reduce((s,t) => s+(parseFloat(t.valor)||0), 0);
        const sai    = txMes.filter(t => t.categoria === 'saida' || t.categoria === 'saida_credito').reduce((s,t) => s+(parseFloat(t.valor)||0), 0);
        if (ent + sai > 0) {
            const poup = ent > 0 ? ((ent-sai)/ent*100).toFixed(1) : 0;
            enviarNotificacaoNativa('Resumo semanal 📊', `Entradas: ${formatBRL(ent)} · Saídas: ${formatBRL(sai)} · Poupança: ${poup}%`, 'info');
            _notificacaoControl.marcar('resumoSemanal');
        }
    }

    if(alertas.vencidas.length > 0 && _notificacaoControl.podeEnviar('vencidas')) {
        const nomes = alertas.vencidas.slice(0, 2).map(c => c.descricao).join(', ');
        const extra = alertas.vencidas.length > 2 ? ` e mais ${alertas.vencidas.length - 2}` : '';
        enviarNotificacaoNativa(
            `${alertas.vencidas.length} conta(s) vencida(s)!`,
            `${nomes}${extra} — regularize para evitar juros.`,
            'urgente'
        );
        _notificacaoControl.marcar('vencidas');
    } else if(alertas.hoje.length > 0 && _notificacaoControl.podeEnviar('hoje')) {
        const nomes = alertas.hoje.slice(0, 2).map(c => c.descricao).join(', ');
        enviarNotificacaoNativa(
            `Vence hoje: ${alertas.hoje.length} conta(s)`,
            `${nomes} — não deixe para depois!`,
            'urgente'
        );
        _notificacaoControl.marcar('hoje');
    } else if(alertas.em3Dias.length > 0 && _notificacaoControl.podeEnviar('em3Dias')) {
        const nomes = alertas.em3Dias.slice(0, 2).map(c => c.descricao).join(', ');
        enviarNotificacaoNativa(
            `${alertas.em3Dias.length} conta(s) vencem em 3 dias`,
            `${nomes} — prepare o pagamento!`,
            'alerta'
        );
        _notificacaoControl.marcar('em3Dias');
    } else if(alertas.proximos.length > 0 && _notificacaoControl.podeEnviar('proximos')) {
        enviarNotificacaoNativa(
            `${alertas.proximos.length} conta(s) nos próximos 7 dias`,
            `Você tem contas a vencer esta semana. Fique atento!`,
            'info'
        );
        _notificacaoControl.marcar('proximos');
    }
}

// ========== PAINEL DE NOTIFICAÇÕES ==========

// Marca notificações como lidas e esconde a bolinha mobile
function marcarNotificacoesLidas() {
    const alertas = verificarVencimentos();
    const hash = (alertas ? _notifHash(alertas) : '') + `|i:${_inboxEmCache()}`;
    localStorage.setItem('granaevo_notif_hash_visto', hash);

    const dotMobile = document.getElementById('mobileNotifDot');
    if (dotMobile) dotMobile.style.display = 'none';
}

// Fecha o painel com animação
function fecharPainelNotificacoes() {
    const painel  = document.getElementById('notificacoesPanel');
    const overlay = document.getElementById('notificacoesOverlay');
    if (!painel) return;

    painel.classList.add('fechando');
    setTimeout(() => {
        painel.classList.add('js-hidden');
        painel.classList.remove('fechando');
        if (overlay) overlay.classList.add('js-hidden');
        document.body.style.overflow = '';
    }, 230);
}

// Renderiza e abre o painel de notificações
async function abrirPainelNotificacoes() {
    const painel  = document.getElementById('notificacoesPanel');
    const lista   = document.getElementById('notificacoesLista');
    const overlay = document.getElementById('notificacoesOverlay');
    if (!painel || !lista) return;

    // Limpa conteúdo anterior
    lista.innerHTML = '';

    const alertas = verificarVencimentos();

    // Avisos vindos do servidor (Radar, lembretes, convite de reserva). Ficavam
    // só no push do sistema: quem não viu a bolha na hora perdia o aviso. Agora
    // moram aqui, com X para dispensar. Módulo LAZY — chunk próprio.
    let inboxEl = null;
    try {
        const inbox = await import('../modules/notificacoes-inbox.js?v=1');
        inboxEl = await inbox.montarInbox({
            onAbrir: (tela) => {
                fecharPainelNotificacoes();
                if (tela) setTimeout(() => mostrarTela(tela), 260);
            },
            // Dispensar muda a contagem: sem remarcar como lido, o hash ficaria
            // defasado e a bolinha de "tem novidade" acenderia por um item que a
            // pessoa acabou de apagar, com o painel aberto na frente dela.
            onDispensar: () => { marcarNotificacoesLidas(); atualizarBadgeNotificacoes(); },
        });
    } catch { inboxEl = null; }
    if (inboxEl) lista.appendChild(inboxEl);

    if ((!alertas || alertas.total === 0) && !inboxEl) {
        // Estado vazio
        const emptyDiv = document.createElement('div');
        emptyDiv.className = 'notificacoes-empty';

        const icon = document.createElement('i');
        icon.className       = 'fas fa-bell-slash';
        icon.setAttribute('aria-hidden', 'true');

        const p = document.createElement('p');
        p.textContent = 'Nenhuma notificação por enquanto.\nSuas contas estão em dia! ✅';
        p.style.whiteSpace = 'pre-line';

        emptyDiv.appendChild(icon);
        emptyDiv.appendChild(p);
        lista.appendChild(emptyDiv);
    } else if (alertas && alertas.total > 0) {
        // Render do painel: módulo LAZY (Passo 10). Best-effort — se o chunk não
        // carregar, o painel fica sem os cards em vez de quebrar o sino inteiro.
        let painelEl = null;
        try {
            const mod = await import('../modules/painel-alertas.js?v=1');
            painelEl = mod.renderPainelAlertas(alertas, { formatBRL, formatarDataBR });
        } catch { painelEl = null; }
        if (painelEl) {
            painelEl.addEventListener('click', (e) => {
                const card = e.target.closest('[data-acao]');
                if (!card) return;

                const idRaw = card.dataset.id;
                const idNum = parseInt(idRaw, 10);
                const id    = Number.isInteger(idNum) && String(idNum) === idRaw ? idNum : idRaw;

                if (id === null || id === undefined || id === '' || id !== id) return;

                const acao = card.dataset.acao;

                if (acao === 'pagar' || acao === 'pagar-btn') {
                    e.stopPropagation();
                    fecharPainelNotificacoes();
                    setTimeout(() => abrirPopupPagarContaFixa(id), 260);
                } else if (acao === 'editar') {
                    fecharPainelNotificacoes();
                    setTimeout(() => abrirContaFixaForm(id), 260);
                }
            });
            lista.appendChild(painelEl);
        }
    }

    // Exibe painel e overlay
    painel.classList.remove('js-hidden');
    if (overlay) overlay.classList.remove('js-hidden');
    document.body.style.overflow = 'hidden';

    // Marca como lidas — bolinha desaparece
    marcarNotificacoesLidas();
}

// @keyframes pulseAlert definido em dashboard.css

function atualizarListaContasFixas() {
    const lista = document.getElementById('listaContasFixas');
    if (!lista) return;

    lista.innerHTML = '';

    if (contasFixas.length === 0) {
        const wrap = document.createElement('div');
        wrap.className = 'contas-empty-state';

        const icon = document.createElement('div');
        icon.className = 'contas-empty-icon';
        icon.innerHTML = '<svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="7" y1="15" x2="13" y2="15"/></svg>';

        const title = document.createElement('p');
        title.className = 'contas-empty-title';
        title.textContent = 'Nenhuma conta fixa cadastrada';

        const sub = document.createElement('p');
        sub.className = 'contas-empty-sub';
        sub.textContent = 'Cadastre aluguel, assinaturas e outras contas recorrentes para nunca esquecer um vencimento.';

        const btn = document.createElement('button');
        btn.className = 'btn-primary contas-empty-cta';
        btn.type = 'button';
        btn.innerHTML = '<i class="fas fa-plus" aria-hidden="true"></i> Adicionar conta fixa';
        btn.addEventListener('click', () => document.getElementById('btnNovaContaFixa')?.click());

        wrap.append(icon, title, sub, btn);
        lista.appendChild(wrap);
        return;
    }

    const hojeISO  = new Date().toISOString().slice(0, 10);
    const mesAtual = hojeISO.slice(0, 7); // 'YYYY-MM'

    // Auto-reset: ao entrar em um novo mês, zera o estado de pagamento do ciclo anterior.
    // Critério: dataPagamento registrada em mês anterior ao atual → reinicia o ciclo.
    let precisaSalvar = false;
    contasFixas.forEach(c => {
        if (c.dataPagamento && c.dataPagamento.slice(0, 7) < mesAtual) {
            c.pago = false;
            c.dataPagamento = null;
            precisaSalvar = true;
        }
    });
    if (precisaSalvar) salvarDados();

    // Colapso das faturas de cartão: o modelo novo cria UMA fatura por mês (para
    // pagar cada mês isoladamente). Mostrar todas na lista polui a tela — uma
    // compra 12× viraria 12 linhas. Aqui exibimos só a "fatura atual" de cada
    // cartão (a mais urgente a pagar); as futuras continuam nos dados e aparecem
    // ao abrir a fatura. Corrige a regressão visual do rebuild de 2026-07-17.
    const _faturasOcultas   = new Set();   // ids de faturas futuras escondidas da lista
    const _proximasFaturas  = new Map();   // id da fatura atual → nº de futuras ocultas
    {
        const _venc = f => (typeof f.vencimento === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(f.vencimento)) ? f.vencimento : '9999-99-99';
        const _aberta = f => Array.isArray(f.compras) && f.compras.some(cp => cp?.pago !== true);
        const porCartao = new Map();
        for (const f of contasFixas) {
            if (f?.tipoContaFixa !== 'fatura_cartao') continue;
            const key = String(f.cartaoId ?? f.descricao ?? f.id);
            if (!porCartao.has(key)) porCartao.set(key, []);
            porCartao.get(key).push(f);
        }
        for (const faturas of porCartao.values()) {
            if (faturas.length <= 1) continue;
            const abertas = faturas.filter(_aberta);
            let atual;
            if (abertas.length) {
                // a mais antiga em aberto — a que o usuário mais precisa pagar
                atual = abertas.reduce((a, b) => _venc(a) <= _venc(b) ? a : b);
            } else {
                // todas pagas → a próxima (>= mês atual); senão a última
                const futuras = faturas.filter(f => _venc(f).slice(0, 7) >= mesAtual);
                atual = (futuras.length ? futuras : faturas).reduce((a, b) => _venc(a) <= _venc(b) ? a : b);
            }
            for (const f of faturas) if (f !== atual) _faturasOcultas.add(f.id);
            _proximasFaturas.set(atual.id, faturas.length - 1);
        }
    }

    const containerContas = document.createElement('div');
    containerContas.className = 'contas-grid';

    contasFixas.forEach(c => {
        if (_faturasOcultas.has(c.id)) return;   // fatura futura colapsada
        const vencimentoValido = typeof c.vencimento === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(c.vencimento);

        const vencMes = vencimentoValido ? c.vencimento.slice(0, 7) : null;
        // Pago = pagou NESTE mês (dataPagamento do mês atual).
        // Retrocompatibilidade: dados sem dataPagamento mas com pago=true e vencimento futuro.
        const estaPago =
            (c.dataPagamento && c.dataPagamento.slice(0, 7) === mesAtual) ||
            (c.pago === true && !c.dataPagamento && vencMes !== null && vencMes > mesAtual);

        let status      = 'Pendente';
        let statusClass = 'status-pendente';

        if (estaPago) {
            status      = 'Pago';
            statusClass = 'status-pago';
        } else if (vencimentoValido && c.vencimento < hojeISO) {
            status      = 'Vencido';
            statusClass = 'status-vencido';
        }

        const div = document.createElement('div');
        div.className = 'conta-card';

        const header = document.createElement('div');
        header.className = 'conta-header';

        const title = document.createElement('div');
        title.className = 'conta-title';

        const statusSpan = document.createElement('span');
        statusSpan.className   = `conta-status ${statusClass}`;
        statusSpan.textContent = status;

        const info = document.createElement('div');
        info.className = 'conta-info';

        if (c.tipoContaFixa === 'fatura_cartao' && c.compras && c.compras.length > 0) {
            const totalCompras = c.compras.length;

            title.textContent = `💳 ${c.descricao}`;
            title.title       = c.descricao;   // título é cortado em 2 linhas no card

            // Classe em vez de style inline: inline não dá para afinar no
            // mobile, e era esse 1.1rem que fazia o card de fatura ficar bem
            // mais alto que o de uma conta simples ao lado.
            const divValor = document.createElement('div');
            divValor.className = 'conta-valor-destaque';
            divValor.textContent = `Valor: ${formatBRL(c.valor)}`;

            // Rótulo por mês em vez da data cheia — mais limpo, menos número.
            // A data exata de vencimento continua na tela de detalhe da fatura.
            const divVenc = document.createElement('div');
            const _mFat = /^\d{4}-\d{2}-\d{2}$/.test(c.vencimento || '')
                ? `${_NOMES_MESES_DASH[Number(c.vencimento.slice(5, 7)) - 1]}/${c.vencimento.slice(0, 4)}`
                : formatarDataBR(c.vencimento);
            divVenc.textContent = `Fatura de ${_mFat}`;

            const divCompras = document.createElement('div');
            divCompras.style.color     = 'var(--text-secondary)';
            divCompras.style.fontSize  = '0.85rem';
            divCompras.style.marginTop = '6px';
            divCompras.textContent = `📦 ${totalCompras} compra${totalCompras > 1 ? 's' : ''} nesta fatura`;

            info.appendChild(divValor);
            info.appendChild(divVenc);
            info.appendChild(divCompras);

            const nProximas = _proximasFaturas.get(c.id) || 0;
            if (nProximas > 0) {
                const divProx = document.createElement('div');
                divProx.style.color     = 'var(--text-secondary)';
                divProx.style.fontSize  = '0.8rem';
                divProx.style.marginTop = '2px';
                divProx.textContent = `🗓️ +${nProximas} fatura${nProximas > 1 ? 's' : ''} futura${nProximas > 1 ? 's' : ''}`;
                info.appendChild(divProx);
            }

            div.appendChild(header);
            div.appendChild(info);

            const actionsFatura = document.createElement('div');
            actionsFatura.className = 'conta-actions';

            if (status !== 'Pago') {
                const btnPagar = document.createElement('button');
                btnPagar.className   = 'conta-btn';
                btnPagar.textContent = 'Pagar Fatura';
                btnPagar.addEventListener('click', (e) => {
                    e.stopPropagation();
                    abrirPopupPagarContaFixa(c.id);
                });
                actionsFatura.appendChild(btnPagar);
            } else {
                const btnAntecipar = document.createElement('button');
                btnAntecipar.className   = 'conta-btn conta-btn-antecipar';
                btnAntecipar.textContent = 'Antecipar';
                btnAntecipar.addEventListener('click', (e) => {
                    e.stopPropagation();
                    abrirPopupAnteciparContaFixa(c.id);
                });
                actionsFatura.appendChild(btnAntecipar);
            }

            div.appendChild(actionsFatura);

        } else {
            const _icConta = document.createElement('i');
            _icConta.className = 'fas fa-receipt';
            _icConta.setAttribute('aria-hidden', 'true');
            _icConta.style.cssText = 'color:rgba(67,160,71,0.85); margin-right:4px; font-size:0.88em;';
            title.appendChild(_icConta);
            title.appendChild(document.createTextNode(_sanitizeText(c.descricao)));
            title.title = _sanitizeText(c.descricao);   // cortado em 2 linhas no card

            const divValor = document.createElement('div');
            divValor.textContent = `Valor: ${formatBRL(c.valor)}`;

            const divVenc = document.createElement('div');
            divVenc.textContent = `Vencimento: ${formatarDataBR(c.vencimento)}`;

            info.appendChild(divValor);
            info.appendChild(divVenc);

            if (c.totalParcelas && c.parcelaAtual) {
                const divParcela = document.createElement('div');
                divParcela.style.color     = 'var(--warning)';
                divParcela.style.fontSize  = '0.85rem';
                divParcela.style.marginTop = '4px';
                divParcela.textContent = `Parcela: ${c.parcelaAtual}/${c.totalParcelas}`;
                info.appendChild(divParcela);
            }

            div.appendChild(header);
            div.appendChild(info);

            const contaId = c.id;
            if (contaId === null || contaId === undefined || contaId === '') return;

            const actions = document.createElement('div');
            actions.className = 'conta-actions';

            if (!estaPago) {
                const btnPagar = document.createElement('button');
                btnPagar.className   = 'conta-btn';
                btnPagar.textContent = 'Pagar';
                btnPagar.addEventListener('click', (e) => {
                    e.stopPropagation();
                    abrirPopupPagarContaFixa(contaId);
                });
                actions.appendChild(btnPagar);
            } else {
                const btnAntecipar = document.createElement('button');
                btnAntecipar.className   = 'conta-btn conta-btn-antecipar';
                btnAntecipar.textContent = 'Antecipar';
                btnAntecipar.addEventListener('click', (e) => {
                    e.stopPropagation();
                    abrirPopupAnteciparContaFixa(contaId);
                });
                actions.appendChild(btnAntecipar);
            }

            div.appendChild(actions);
        }

        header.appendChild(title);
        header.appendChild(statusSpan);

        div.addEventListener('click', (e) => {
            if (e.target.tagName === 'BUTTON') return;

            if (c.tipoContaFixa === 'fatura_cartao') {
                if (!_dbLoaded.cartoes) {
                    import('./db-cartoes.js?v=6').then(m => {
                        m.init(_makeCtx());
                        _dbLoaded.cartoes = true;
                        window.abrirVisualizacaoFatura?.(c.id);
                    });
                } else {
                    window.abrirVisualizacaoFatura?.(c.id);
                }
            } else {
                abrirContaFixaView(c.id);
            }
        });

        containerContas.appendChild(div);
    });

    lista.appendChild(containerContas);
}

// ── Contas Fixas: as INTERAÇÕES vivem em db-contas-fixas.js (chunk lazy) ────
// Só `atualizarListaContasFixas` (que pinta a seção) ficou aqui — ela é quente.
// Ver e editar/pagar/antecipar só existem depois de um clique, então o chunk
// desce no primeiro clique e fica em memória. As 4 funções abaixo mantêm a
// MESMA assinatura de antes: quem chama (inclusive `_ctx` em db-cartoes.js)
// não sabe que virou assíncrono.
let _cfMod = null;
let _cfCarregando = null;
function _carregarAcoesContaFixa() {
    if (_cfMod) return Promise.resolve(_cfMod);
    if (!_cfCarregando) {
        _cfCarregando = import('./db-contas-fixas.js?v=1')
            .then(m => { m.init(_makeCtx()); _cfMod = m; return m; })
            .catch(err => {
                _cfCarregando = null;   // deixa tentar de novo no próximo clique
                mostrarNotificacao('Não foi possível abrir agora. Tente de novo.', 'error');
                throw err;
            });
    }
    return _cfCarregando;
}
function abrirContaFixaView(id)             { _carregarAcoesContaFixa().then(m => m.abrirContaFixaView(id)).catch(() => {}); }
function abrirContaFixaForm(editId = null)  { _carregarAcoesContaFixa().then(m => m.abrirContaFixaForm(editId)).catch(() => {}); }
function abrirPopupPagarContaFixa(id)       { _carregarAcoesContaFixa().then(m => m.abrirPopupPagarContaFixa(id)).catch(() => {}); }
function abrirPopupAnteciparContaFixa(id)   { _carregarAcoesContaFixa().then(m => m.abrirPopupAnteciparContaFixa(id)).catch(() => {}); }

// ✅ Rollback seguro: limpa e repopula sem substituir a referência do array
// Evita que componentes externos fiquem com referências para objetos mortos
function rollbackArray(arrayAtual, snapshotObj) {
    arrayAtual.length = 0;
    snapshotObj.forEach(item => arrayAtual.push(item));
}

// ✅ CORREÇÃO: avancarMes declarada FORA de pagarContaFixa e do bloco try.
//    Declaração de função no escopo de módulo garante hoisting correto,
//    comportamento determinístico em todos os motores JS, e acessibilidade
//    dentro do try sem depender de hoisting condicional.
function _avancarMes(vencimentoISO) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(vencimentoISO)) {
        const fallback = new Date();
        fallback.setMonth(fallback.getMonth() + 1);
        return fallback.toISOString().slice(0, 10);
    }
    let [y, m, d] = vencimentoISO.split('-').map(Number);
    m++;
    if (m > 12) { m = 1; y++; }
    return [y, String(m).padStart(2, '0'), String(d).padStart(2, '0')].join('-');
}

// ✅ Token de versão declarado fora — persiste entre chamadas
//    Incrementado a cada criarPopup(), capturado a cada fecharPopup()
//    Garante que o setTimeout de um fechamento antigo nunca limpe um popup novo
let _popupVersaoAtual = 0;

function _isMobileViewport() { return window.innerWidth < 480; }

// ── Focus-trap de modais (acessibilidade) ────────────────────────────
let _focusTrapCleanup = null;
let _focoAntesDoModal = null;

function _focaveisDentro(container) {
    const sel = 'a[href], button:not([disabled]), textarea:not([disabled]), ' +
                'input:not([disabled]):not([type="hidden"]), select:not([disabled]), ' +
                '[tabindex]:not([tabindex="-1"])';
    return Array.from(container.querySelectorAll(sel))
        .filter(el => el.offsetWidth > 0 || el.offsetHeight > 0 || el === document.activeElement);
}

function _ativarFocusTrap(dialogEl) {
    if (!dialogEl) return;
    _desativarFocusTrap(); // limpa qualquer trap pendente sem restaurar foco
    _focoAntesDoModal = document.activeElement;

    // Esconde o conteúdo de fundo de tab + leitores de tela
    const main = document.getElementById('mainContent');
    if (main) { main.setAttribute('inert', ''); main.setAttribute('aria-hidden', 'true'); }

    if (!dialogEl.hasAttribute('tabindex')) dialogEl.setAttribute('tabindex', '-1');
    const focaveis = _focaveisDentro(dialogEl);
    const alvo = focaveis[0] || dialogEl;
    requestAnimationFrame(() => { try { alvo.focus({ preventScroll: true }); } catch (_) {} });

    const onKey = (e) => {
        if (e.key !== 'Tab') return;
        const itens = _focaveisDentro(dialogEl);
        if (itens.length === 0) { e.preventDefault(); dialogEl.focus(); return; }
        const primeiro = itens[0];
        const ultimo = itens[itens.length - 1];
        if (e.shiftKey && document.activeElement === primeiro) {
            e.preventDefault(); ultimo.focus();
        } else if (!e.shiftKey && document.activeElement === ultimo) {
            e.preventDefault(); primeiro.focus();
        }
    };
    dialogEl.addEventListener('keydown', onKey);

    _focusTrapCleanup = () => {
        dialogEl.removeEventListener('keydown', onKey);
        if (main) { main.removeAttribute('inert'); main.removeAttribute('aria-hidden'); }
    };
}

function _desativarFocusTrap() {
    const restaurar = _focusTrapCleanup && _focoAntesDoModal;
    if (_focusTrapCleanup) { _focusTrapCleanup(); _focusTrapCleanup = null; }
    if (restaurar && typeof _focoAntesDoModal.focus === 'function') {
        try { _focoAntesDoModal.focus({ preventScroll: true }); } catch (_) {}
    }
    _focoAntesDoModal = null;
}

function criarPopup(html) {
    // Em mobile (< 480px) usa bottom sheet; em desktop usa modal centralizado
    if (_isMobileViewport()) {
        _criarBottomSheet(html);
        return;
    }

    const overlay   = document.getElementById('modalOverlay');
    const container = document.getElementById('modalContainer');
    if (!overlay || !container) return;

    // ✅ Garante que apenas strings são aceitas
    if (typeof html !== 'string') {
        console.error('criarPopup: html deve ser string estática. Dados do usuário devem ser inseridos via textContent após a criação do popup.');
        return;
    }

    // ✅ Avisa o desenvolvedor se detectar interpolação acidental de dados do usuário
    const padroesSuspeitos = [
        /conta\./,
        /\.descricao/,
        /\.valor/,
        /\.vencimento/,
        /formatBRL\(/,
        /formatarDataBR\(/
    ];
    if (padroesSuspeitos.some(p => p.test(html))) {
        console.warn('criarPopup: possível dado de usuário detectado no HTML. Use textContent após criarPopup() para inserir dados dinâmicos.');
    }

    // ✅ FIX #7: incrementa versão a cada abertura
    //    Qualquer setTimeout de fecharPopup anterior com versão menor será ignorado
    _popupVersaoAtual++;

    // ✅ Sanitiza via DOMParser
    const htmlSanitizado = sanitizarHTMLPopup(html);

    container.innerHTML = '';

    const box = document.createElement('div');
    box.className = 'popup';
    box.innerHTML = htmlSanitizado;
    _aplicarEstilosCSOM(box);
    container.appendChild(box);

    overlay.classList.add('active');
    overlay.onclick = () => fecharPopup();
    _ativarFocusTrap(container);
}

function fecharPopup() {
    _desativarFocusTrap();
    // Chegou aviso de tempo real enquanto o formulário estava aberto: agora que
    // não há nada sendo digitado, a atualização pode entrar.
    if (_tempoRealReaplicar) setTimeout(_tempoRealReaplicar, 350);
    // Fecha bottom sheet se estiver ativo
    const bs = document.getElementById('bottomSheetOverlay');
    if (bs && bs.classList.contains('active')) {
        bs.classList.remove('active');
        bs.onclick = null;
        const bsContent = document.getElementById('bottomSheetContent');
        // ✅ FIX: mesmo guard de versão do caminho desktop.
        //    Se um novo bottom sheet abrir durante os 300ms (ex.: fecharPopup()
        //    seguido de criarPopup() ao enviar convite), _popupVersaoAtual muda
        //    e este setTimeout NÃO limpa o conteúdo recém-criado.
        const versaoFechando = _popupVersaoAtual;
        setTimeout(() => {
            if (bsContent && _popupVersaoAtual === versaoFechando) bsContent.innerHTML = '';
        }, 300);
        return;
    }

    const overlay   = document.getElementById('modalOverlay');
    const container = document.getElementById('modalContainer');
    if(!overlay || !container) return;

    // ✅ FIX #7: captura a versão do popup que está sendo fechado agora
    //    Se um novo popup abrir durante os 300ms, _popupVersaoAtual será diferente
    //    e o setTimeout abaixo não limpará o novo conteúdo
    const versaoFechando = _popupVersaoAtual;

    overlay.classList.remove('active');
    overlay.onclick = null;

    setTimeout(() => {
        // ✅ Só limpa se nenhum novo popup foi aberto durante a animação de 300ms
        if (_popupVersaoAtual === versaoFechando) {
            container.innerHTML = '';
        }
    }, 300);
}

function _criarBottomSheet(html) {
    const overlay   = document.getElementById('bottomSheetOverlay');
    const content   = document.getElementById('bottomSheetContent');
    if (!overlay || !content) {
        // Fallback: abre modal normal se bottom sheet não existir no DOM
        const overlay2   = document.getElementById('modalOverlay');
        const container2 = document.getElementById('modalContainer');
        if (!overlay2 || !container2) return;
        _popupVersaoAtual++;
        container2.innerHTML = '';
        const box = document.createElement('div');
        box.className = 'popup';
        box.innerHTML = sanitizarHTMLPopup(html);
        _aplicarEstilosCSOM(box);
        container2.appendChild(box);
        overlay2.classList.add('active');
        overlay2.onclick = () => fecharPopup();
        _ativarFocusTrap(container2);
        hapticTap(10); // feedback tátil ao abrir o modal (mobile)
        return;
    }

    // ✅ FIX: incrementa versão a cada abertura (igual ao caminho desktop).
    //    Invalida qualquer setTimeout de fecharPopup() pendente para que ele
    //    não limpe o conteúdo deste novo bottom sheet.
    _popupVersaoAtual++;

    const htmlSanitizado = sanitizarHTMLPopup(html);
    content.innerHTML    = '';
    const box            = document.createElement('div');
    box.innerHTML        = htmlSanitizado;
    _aplicarEstilosCSOM(box);
    content.appendChild(box);

    overlay.classList.add('active');
    overlay.onclick = (e) => { if (e.target === overlay) fecharPopup(); };
    _ativarFocusTrap(document.getElementById('bottomSheetContainer'));
    hapticTap(10); // feedback tátil ao abrir o bottom sheet (mobile)
}

function sanitizarHTMLPopup(html) {
    const parser = new DOMParser();
    const doc    = parser.parseFromString(html, 'text/html');

    // ✅ Tags estruturalmente perigosas — removidas completamente
    const tagsProibidas = [
        'script', 'iframe', 'frame', 'object', 'embed', 'applet',
        'link', 'meta', 'base', 'form', 'svg', 'math',
        'template', 'slot', 'portal',  // shadow DOM / portais — vetor de bypass
    ];
    tagsProibidas.forEach(tag => {
        doc.querySelectorAll(tag).forEach(el => el.remove());
    });

    // ✅ Propriedades CSS permitidas via whitelist.
    //    Qualquer propriedade fora desta lista é removida do atributo style.
    //    Isso bloqueia: expression(), -moz-binding, propriedades de posição absoluta
    //    que poderiam sobrepor elementos, e vazamento via url() / image-set().
    const CSS_PROPS_PERMITIDAS = new Set([
        'color', 'background', 'background-color', 'font-size', 'font-weight',
        'font-family', 'font-style', 'text-align', 'text-decoration',
        'margin', 'margin-top', 'margin-bottom', 'margin-left', 'margin-right',
        'padding', 'padding-top', 'padding-bottom', 'padding-left', 'padding-right',
        'border', 'border-top', 'border-bottom', 'border-left', 'border-right',
        'border-radius', 'border-color', 'border-width', 'border-style',
        'width', 'height', 'max-width', 'min-width', 'max-height', 'min-height',
        'display', 'flex', 'flex-direction', 'flex-wrap', 'flex',
        'align-items', 'align-content', 'justify-content', 'justify-self', 'gap',
        'grid-template-columns', 'grid-template-rows', 'grid-column', 'grid-row',
        'overflow', 'overflow-x', 'overflow-y', 'white-space',
        'opacity', 'visibility', 'cursor',
        'box-shadow', 'text-shadow',
        'line-height', 'letter-spacing', 'word-break',
        'transition', 'animation',
        'position', 'top', 'right', 'bottom', 'left', 'z-index',
    ]);

    // ✅ Padrões CSS sempre perigosos — bloqueados mesmo que a propriedade seja permitida
    const CSS_PADROES_PERIGOSOS = [
        /url\s*\(/gi,           // url() — requisição externa, exfiltração de dados
        /expression\s*\(/gi,   // expression() — execução JS em IE
        /-moz-binding/gi,      // binding XBL em Firefox antigo
        /javascript\s*:/gi,    // javascript: URI em valores CSS
        /vbscript\s*:/gi,      // vbscript: URI
        /@import/gi,           // @import — carregamento de CSS externo
        /behavior\s*:/gi,      // behavior — IE HTC
        /image-set\s*\(/gi,    // image-set() — similar a url()
    ];

    doc.body.querySelectorAll('*').forEach(el => {
        const nomesAtributos = typeof el.getAttributeNames === 'function'
            ? el.getAttributeNames()
            : Array.from(el.attributes).map(a => a.name);

        nomesAtributos.forEach(nomeOriginal => {
            const nome = nomeOriginal.toLowerCase().trim();
            const val  = (el.getAttribute(nomeOriginal) || '').toLowerCase().replace(/[\s\r\n\t]/g, '');

            // ✅ Bloqueia todos os event handlers (on* = onclick, onload, onbegin, etc.)
            if (nome.startsWith('on')) {
                el.removeAttribute(nomeOriginal);
                return;
            }

            // ✅ Bloqueia URIs perigosas em qualquer atributo
            const esquemasPerigosos = ['javascript:', 'vbscript:', 'data:', 'blob:'];
            if (esquemasPerigosos.some(s => val.startsWith(s))) {
                el.removeAttribute(nomeOriginal);
                return;
            }

            // ✅ Sanitização abrangente do atributo style
            if (nome === 'style') {
                const valOriginal = el.getAttribute(nomeOriginal) || '';

                // ✅ Bloqueia padrões sempre perigosos, independente da propriedade
                let valLimpo = valOriginal;
                CSS_PADROES_PERIGOSOS.forEach(padrao => {
                    valLimpo = valLimpo.replace(padrao, '/* bloqueado */');
                });

                // ✅ Filtra propriedades CSS por whitelist
                //    Faz parse linha a linha e mantém apenas as propriedades permitidas
                const declaracoesFiltradas = valLimpo
                    .split(';')
                    .map(decl => decl.trim())
                    .filter(decl => {
                        if (!decl) return false;
                        const separador = decl.indexOf(':');
                        if (separador === -1) return false;
                        const prop = decl.slice(0, separador).trim().toLowerCase();
                        // ✅ Permite propriedades da whitelist e prefixos vendor (-webkit-, -moz-)
                        const propBase = prop.replace(/^-(?:webkit|moz|ms|o)-/, '');
                        return CSS_PROPS_PERMITIDAS.has(prop) || CSS_PROPS_PERMITIDAS.has(propBase);
                    })
                    .join('; ');

                if (declaracoesFiltradas.trim()) {
                    el.setAttribute(nomeOriginal, declaracoesFiltradas);
                } else {
                    el.removeAttribute(nomeOriginal);
                }
                return;
            }

            // ✅ Remove atributos estruturalmente perigosos
            const atributosProibidos = ['srcdoc', 'formaction', 'xlink:href', 'action'];
            if (atributosProibidos.includes(nome)) {
                el.removeAttribute(nomeOriginal);
            }
        });
    });

    return doc.body.innerHTML;
}

// ── Converte atributos style em propriedades CSSOM (não bloqueadas pela CSP style-src)
function _aplicarEstilosCSOM(container) {
    container.querySelectorAll('[style]').forEach(el => {
        const styleVal = el.getAttribute('style') || '';
        el.removeAttribute('style');
        styleVal.split(';').forEach(decl => {
            const colonIdx = decl.indexOf(':');
            if (colonIdx === -1) return;
            const prop = decl.slice(0, colonIdx).trim();
            const val  = decl.slice(colonIdx + 1).trim();
            if (!prop || !val) return;
            const camel = prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
            try { el.style[camel] = val; } catch (_) {}
        });
    });
}

// ========== POPUP VIA DOM (SEM innerHTML COM DADOS DO USUÁRIO) ==========
// ✅ Inserir APÓS a função sanitizarHTMLPopup
//    e ANTES do bloco // ========== TRANSAÇÕES ==========
//
// Por que aqui? Todas as funções utilitárias de modal ficam agrupadas:
//   criarPopup → fecharPopup → sanitizarHTMLPopup → criarPopupDOM
//
// Diferença de uso:
//   criarPopup(htmlString)    → HTML estático, sanitizado pelo sanitizarHTMLPopup
//   criarPopupDOM(callback)   → Constrói 100% via DOM API, dado do usuário
//                               nunca vira HTML — textContent direto no elemento
//
// Usado atualmente por:
//   - adicionarNovoPerfil()
//   - mostrarPopupLimite()

/**
 * Abre o modal e entrega o elemento .popup VAZIO para o caller construir via DOM.
 *
 * @param {function(HTMLDivElement): void} builderCallback

 *
  @returns {HTMLElement|null} 

 */
function criarPopupDOM(builderCallback) {
    const overlay   = document.getElementById('modalOverlay');
    const container = document.getElementById('modalContainer');

    if (!overlay || !container) {
        _log.error('POPUP_DOM_001', 'Elementos #modalOverlay ou #modalContainer não encontrados');
        return null;
    }

    if (typeof builderCallback !== 'function') {
        _log.error('POPUP_DOM_002', 'builderCallback deve ser uma função');
        return null;
    }

    // ✅ Mesmo mecanismo de versão do criarPopup
    //    Garante que fecharPopup com setTimeout não limpe um popup mais novo
    _popupVersaoAtual++;

    // ✅ Limpa container antes de montar o novo popup
    container.innerHTML = '';

    const box = document.createElement('div');
    box.className = 'popup';

    // ✅ Entrega o box VAZIO ao caller
    //    Se o callback lançar erro, desfaz tudo e não deixa modal corrompido
    try {
        builderCallback(box);
    } catch (e) {
        _log.error('POPUP_DOM_003', e);
        container.innerHTML = '';
        overlay.classList.remove('active');
        return null;
    }

    container.appendChild(box);
    overlay.classList.add('active');

    // ✅ Reutiliza fecharPopup existente — já tem controle de _popupVersaoAtual
    overlay.onclick = () => fecharPopup();

    return container;
}

function confirmarAcao(mensagem, callbackConfirmar) {
    if (typeof callbackConfirmar !== 'function') {
        _log.error('CONFIRMAR_ACAO_001', 'callbackConfirmar deve ser uma função');
        return;
    }

    criarPopupDOM((popup) => {
        const titulo = document.createElement('h3');
        titulo.textContent = 'Confirmar Ação';

        const texto = document.createElement('p');
        texto.style.cssText = 'margin: 16px 0; color: var(--text-secondary); line-height: 1.6;';
        texto.textContent = typeof mensagem === 'string' ? mensagem.slice(0, 300) : 'Confirmar esta ação?';

        const divBotoes = document.createElement('div');
        divBotoes.style.cssText = 'display: flex; gap: 12px; margin-top: 8px;';

        const btnSim = document.createElement('button');
        btnSim.className = 'btn-excluir';
        btnSim.type = 'button';
        btnSim.style.flex = '1';
        btnSim.textContent = 'Sim, confirmar';

        const btnNao = document.createElement('button');
        btnNao.className = 'btn-cancelar';
        btnNao.type = 'button';
        btnNao.style.flex = '1';
        btnNao.textContent = 'Cancelar';

        btnSim.addEventListener('click', () => {
            fecharPopup();
            try {
                callbackConfirmar();
            } catch (e) {
                _log.error('CONFIRMAR_ACAO_002', e);
            }
        });

        btnNao.addEventListener('click', fecharPopup);

        divBotoes.appendChild(btnSim);
        divBotoes.appendChild(btnNao);

        popup.appendChild(titulo);
        popup.appendChild(texto);
        popup.appendChild(divBotoes);
    });
}

window.confirmarAcao = confirmarAcao;

// Guards de segurança — compartilhados com módulos lazy-loaded via _ctx
function _requerPerfilAtivo(fn) {
    return function(...args) {
        if (!perfilAtivo || !dataManager?.userId) {
            _log.warn('[SEGURANÇA] Chamada bloqueada — sem perfil ativo ou sessão inválida.');
            return;
        }
        return fn.apply(this, args);
    };
}

function _requerNonce(fn) {
    return function(nonce, ...args) {
        if (!perfilAtivo || !dataManager?.userId) {
            _log.warn('[SEGURANÇA] Chamada bloqueada — sem perfil ativo.');
            return;
        }
        if (typeof nonce !== 'string' || nonce !== _sessionNonce) {
            _log.warn('[SEGURANÇA] Chamada bloqueada — nonce inválido ou ausente.');
            return;
        }
        return fn.apply(this, args);
    };
}

// ========== CONFIRMAR LOGOUT ==========
async function confirmarLogout_seguro() {
    criarPopup(`
        <h3>Confirmar Saída</h3>
        <div style="margin: 20px 0; color: var(--text-secondary);">Quer mesmo sair?</div>
        <button class="btn-primary" id="simLogout">Sim</button>
        <button class="btn-cancelar" id="naoLogout">Não</button>
    `);

    document.getElementById('naoLogout').addEventListener('click', fecharPopup);

    document.getElementById('simLogout').addEventListener('click', async () => {
        try {
            pararAutoSave();

            const popup = document.querySelector('.popup');
            if (popup) {
                popup.innerHTML = `
                    <h3>Salvando dados...</h3>
                    <div style="text-align:center; padding:30px;">
                        <div style="width:40px; height:40px; margin:0 auto;
                             border:4px solid rgba(16,185,129,0.3);
                             border-top-color:#10b981; border-radius:50%;
                             animation:spin 1s linear infinite;"></div>
                        <p style="margin-top:16px; color: var(--text-secondary);">Aguarde...</p>
                    </div>
                `;
            }

            if (perfilAtivo) {
                await salvarDados();
                await new Promise(r => setTimeout(r, 400));
            }

            await AuthGuard.logout('logout_voluntario');

        } catch (e) {
            _log.error('LOGOUT_001', e);
            AuthGuard.forceLogout('logout_com_erro');
        }
    });
}

window.confirmarLogout = confirmarLogout_seguro;

// ========== ATUALIZAR TUDO ==========
function atualizarTudo() {
    window._dbTransacoes?.atualizarMovimentacoesUI?.();
    atualizarDashboardResumo();
    atualizarListaContasFixas();
    window._dbMetas?.renderMetasList?.();
    window.renderMetaVisual?.();
    atualizarHeaderReservas();
    // Cartões faltavam aqui, e o tempo real chama esta função. Quem estivesse
    // PARADO na tela de cartões quando a compra chegasse de outra aba não via
    // nada mudar — o dado já estava nos arrays, só a tela ficava velha. Passava
    // meio despercebido porque a FATURA repinta junto (ela é conta fixa), então
    // o valor aparecia num canto e não no outro. Encadeado opcional igual aos
    // demais: a tela pode nem ter sido carregada ainda.
    window._dbCartoes?.atualizarTelaCartoes?.();
}

function atualizarHeaderReservas() {
    const headerTotalReservas = document.getElementById('headerTotalReservas');
    const headerQtdReservas = document.getElementById('headerQtdReservas');
    
    if(!headerTotalReservas || !headerQtdReservas) return;
    
    // Calcular total reservado (soma de todas as metas)
    const totalReservado = metas.reduce((sum, meta) => {
        if (_ehRecibo(meta)) return sum;
        return sum + Number(meta.saved || 0);
    }, 0);

    // Contar reservas ativas (metas que ainda não atingiram o objetivo)
    const reservasAtivas = metas.filter(meta => {
        if (_ehRecibo(meta)) return false;
        const saved = Number(meta.saved || 0);
        const objetivo = Number(meta.objetivo || 0);
        return saved < objetivo;
    }).length;
    
    // Atualizar valores no header
    headerTotalReservas.textContent = formatBRL(totalReservado);
    headerQtdReservas.textContent = reservasAtivas;
}

// ========== SIDEBAR TOGGLE (MOBILE) ==========
function setupSidebarToggle() {
    const sidebar   = document.getElementById('sidebar');
    const toggleBtn = document.getElementById('sidebarToggle');
    const body      = document.body;

    if (toggleBtn && sidebar) {
        toggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            sidebar.classList.toggle('open');
            if (window.innerWidth <= 768) {
                body.classList.toggle('sidebar-open', sidebar.classList.contains('open'));
            }
        });

        document.addEventListener('click', (e) => {
            if (window.innerWidth <= 768 &&
                !sidebar.contains(e.target) &&
                !toggleBtn.contains(e.target) &&
                sidebar.classList.contains('open')) {
                sidebar.classList.remove('open');
                body.classList.remove('sidebar-open');
            }
        });

        document.querySelectorAll('.nav-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                if (window.innerWidth <= 768) {
                    sidebar.classList.remove('open');
                    body.classList.remove('sidebar-open');
                }
            });
        });

        window.addEventListener('resize', () => {
            if (window.innerWidth > 768) body.classList.remove('sidebar-open');
        });
    }

    // ── Botão Configurações — mobile topbar (direito)
    const mobileSettingsBtn = document.getElementById('mobileSettingsBtn');
    if (mobileSettingsBtn) {
        mobileSettingsBtn.addEventListener('click', () => mostrarTela('configuracoes'));
    }

    // ── Botão Notificações — sidebar desktop
    const btnNotificacoes = document.getElementById('btnNotificacoes');
    if (btnNotificacoes) {
        btnNotificacoes.addEventListener('click', () => abrirPainelNotificacoes());
    }

    // ── Botão Notificações — mobile topbar (sininho)
    const mobileNotifBtn = document.getElementById('mobileNotifBtn');
    if (mobileNotifBtn) {
        mobileNotifBtn.addEventListener('click', () => abrirPainelNotificacoes());
    }

    // ── Chat — Assistente GranaEvo (página leve /assistente; mesma sessão)
    // Dois botões, um destino: a barra do mobile e a lateral do desktop. O do
    // desktop faltava — quem não usa celular não tinha como chegar no chat.
    for (const id of ['chatNavBtn', 'chatNavBtnDesktop']) {
        const btn = document.getElementById(id);
        if (btn) btn.addEventListener('click', () => { window.location.href = '/assistente'; });
    }

    // ── Fechar painel: botão X
    const btnFecharNotificacoes = document.getElementById('btnFecharNotificacoes');
    if (btnFecharNotificacoes) {
        btnFecharNotificacoes.addEventListener('click', () => fecharPainelNotificacoes());
    }

    // ── Fechar painel: clique no overlay
    const notifOverlay = document.getElementById('notificacoesOverlay');
    if (notifOverlay) {
        notifOverlay.addEventListener('click', () => fecharPainelNotificacoes());
    }

    // ── Fechar painel: tecla Escape
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            const painel = document.getElementById('notificacoesPanel');
            if (painel && painel.style.display !== 'none') fecharPainelNotificacoes();
        }
    });
}
// ========== BINDINGS DE UI ==========
function bindEventos() {
    // Navegação
    document.querySelectorAll('[data-page]').forEach(btn => {
        btn.addEventListener('click', function() {
            const page = this.getAttribute('data-page');
            hapticTap(8); // toque seco de seleção ao trocar de aba (mobile)
            mostrarTela(page);
        });
    });

    // Navegação por swipe (mobile) — módulo carregado sob demanda (custo zero no
    // desktop). Progressivo: se falhar, a navegação por toque segue intacta.
    if (window.matchMedia('(max-width: 768px)').matches) {
        import('../modules/swipe-nav.js?v=5')
            .then(m => m.initSwipeNav({
                order:        ['dashboard', 'transacoes', 'reservas', 'cartoes', 'graficos', 'relatorios'],
                getCurrent:   () => _telaAtual,
                setCurrent:   (t) => { _telaAtual = t; },
                navigate:     mostrarTela,        // fallback (reduced-motion / borda)
                loadModule:   _carregarModuloTela, // carrega/atualiza a aba alvo
                setNavActive: _setNavAtiva,        // destaca o item de nav ao finalizar
            }))
            .catch(() => { /* swipe é opcional — silencioso */ });
    }

    // Upload de foto (acionado pelo botão "Alterar foto" no hub de perfil)
    const photoUpload = document.getElementById('photoUpload');
    if(photoUpload) {
        photoUpload.addEventListener('change', alterarFoto);
    }

    // Foto de perfil (sidebar + topbar mobile) → abre o hub de perfil
    const userPhotoBtn = document.getElementById('userPhotoBtn');
    if (userPhotoBtn) {
        userPhotoBtn.addEventListener('click', abrirPerfilUsuario);
        userPhotoBtn.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); abrirPerfilUsuario(); }
        });
    }
    const mobileProfileBtn = document.getElementById('mobileProfileBtn');
    if (mobileProfileBtn) {
        mobileProfileBtn.addEventListener('click', () => { hapticTap(8); abrirPerfilUsuario(); });
    }

    // Dashboard - Nova conta fixa
    const btnNovaContaFixa = document.getElementById('btnNovaContaFixa');
    if(btnNovaContaFixa) {
        btnNovaContaFixa.addEventListener('click', () => abrirContaFixaForm());
    }
    
    // Transações — funções em db-transacoes.js (lazy), resolvidas em runtime via window
    const selectCategoria = document.getElementById('selectCategoria');
    if(selectCategoria) {
        selectCategoria.addEventListener('change', () => window.atualizarTiposDinamicos?.());
    }

    const btnLancar = document.getElementById('btnLancar');
    if(btnLancar) {
        btnLancar.addEventListener('click', () => window.lancarTransacao?.());
    }
    // bindFiltrosMovimentacoes() já é chamado no init() de db-transacoes.js
    
    // Reservas/Metas
    const btnNovaMeta = document.getElementById('btnNovaMeta');
    if(btnNovaMeta) {
        btnNovaMeta.addEventListener('click', () => window.abrirMetaForm?.());
    }

    const btnJaPossuiReserva = document.getElementById('btnJaPossuiReserva');
    if (btnJaPossuiReserva) {
        btnJaPossuiReserva.addEventListener('click', () => window.abrirFormReservaExistente?.());
    }
    
    const btnRetirar = document.getElementById('btnRetirar');
    if(btnRetirar) {
        btnRetirar.addEventListener('click', () => window.abrirRetiradaForm?.());
    }

    const btnGuardar = document.getElementById('btnGuardar');
    if(btnGuardar) {
        btnGuardar.addEventListener('click', () => window.abrirGuardarForm?.());
    }

    const btnAjustar = document.getElementById('btnAjustar');
    if(btnAjustar) {
        btnAjustar.addEventListener('click', () => window.abrirAjusteForm?.());
    }

    // Gráficos
    const btnAtualizarGraficos = document.getElementById('btnAtualizarGraficos');
    if(btnAtualizarGraficos) {
        btnAtualizarGraficos.addEventListener('click', () => window.atualizarGraficos?.());
    }

    // Relatórios
    const btnGerarRelatorio = document.getElementById('btnGerarRelatorio');
    if(btnGerarRelatorio) {
        btnGerarRelatorio.addEventListener('click', () => window.gerarRelatorio?.());
    }

    // Configurações
    // "Alterar Nome" foi movido para o hub de perfil (clique na foto) — ver db-configuracoes.js
    const btnAlterarEmail = document.getElementById('btnAlterarEmail');
    if(btnAlterarEmail) {
        btnAlterarEmail.addEventListener('click', () => window.alterarEmail?.());
    }
    
    const btnAlterarSenha = document.getElementById('btnAlterarSenha');
    if(btnAlterarSenha) {
        btnAlterarSenha.addEventListener('click', () => window.abrirAlterarSenha?.());
    }

    const btnTrocarPerfil = document.getElementById('btnTrocarPerfil');
    if(btnTrocarPerfil) {
        btnTrocarPerfil.addEventListener('click', () => window.trocarPerfil?.());
    }

    const btnComoUsar = document.getElementById('btnComoUsar');
    if(btnComoUsar) {
        btnComoUsar.addEventListener('click', async () => {
            if (window.comoUsar) { window.comoUsar(); return; }
            const { iniciarTutorial } = await import('../modules/tutorial.js');
            iniciarTutorial({
                plano:   usuarioLogado?.plano,
                isGuest: Boolean(usuarioLogado?.isGuest),
            });
        });
    }

    const btnLogout = document.getElementById('btnLogout');
    if(btnLogout) {
        btnLogout.addEventListener('click', () => window.confirmarLogout?.());
    }

    const btnGerenciarAssinatura = document.getElementById('btnGerenciarAssinatura');
    if (btnGerenciarAssinatura) {
        btnGerenciarAssinatura.addEventListener('click', () => window.gerenciarAssinatura?.());
    }

    const btnExportarJSON = document.getElementById('btnExportarJSON');
    if (btnExportarJSON) {
        btnExportarJSON.addEventListener('click', exportarDadosJSON);
    }

    const btnExportarCSV = document.getElementById('btnExportarCSV');
    if (btnExportarCSV) {
        btnExportarCSV.addEventListener('click', exportarDadosCSV);
    }

    // Toggle saldo hero mobile
    const btnToggleSaldo = document.getElementById('btnToggleSaldo');
    if (btnToggleSaldo) {
        btnToggleSaldo.addEventListener('click', () => {
            const heroSaldoEl = document.getElementById('heroSaldo');
            const icone       = btnToggleSaldo.querySelector('i');
            if (!heroSaldoEl || !icone) return;

            const estaOculto = heroSaldoEl.classList.toggle('oculto');

            ['totalEntradas', 'totalSaidas', 'totalReservas',
             'percentEntradas', 'percentSaidas', 'percentReservas'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.classList.toggle('oculto', estaOculto);
            });

            if (estaOculto) {
                icone.className = 'fas fa-eye';
            } else {
                icone.className = 'fas fa-eye-slash';
                heroSaldoEl.textContent = heroSaldoEl.dataset.valor || 'R$ 0,00';
            }
        });
    }
}

const widgetOndeFoi = document.getElementById('widgetOndeFoiDinheiro');
if (widgetOndeFoi) {
    widgetOndeFoi.addEventListener('click', () => {
        if (!_dbLoaded.relatorios) {
            import('./db-relatorios.js?v=9').then(m => {
                m.init(_makeCtx());
                _dbLoaded.relatorios = true;
                window.abrirWidgetOndeForDinheiro?.();
            });
        } else {
            window.abrirWidgetOndeForDinheiro?.();
        }
    });
    widgetOndeFoi.addEventListener('mouseover', () => {
        widgetOndeFoi.style.transform = 'translateY(-4px)';
        widgetOndeFoi.style.boxShadow = '0 8px 24px rgba(67,160,71,0.3)';
    });
    widgetOndeFoi.addEventListener('mouseout', () => {
        widgetOndeFoi.style.transform = 'translateY(0)';
        widgetOndeFoi.style.boxShadow = 'var(--shadow-sm)';
    });
}

// ========== UTILITÁRIOS ADICIONAIS ==========

// ✅ Variável única — usada por iniciarAutoSave e pararAutoSave
let autoSaveInterval = null;
let _autoSaveFailCount = 0;
const _AUTO_SAVE_MAX_FAILS = 3;

// ── TEMPO REAL (Passo 37 · Camada 1) ────────────────────────────────────────
// "Um usuário altera, outro já vê" — sem recarregar. O canal é uma CAMPAINHA:
// avisa que a conta mudou, e a tela busca pelo caminho normal.
//
// O filtro por perfil, o adiamento com formulário aberto e o diagnóstico moram
// em tempo-real.js, que é carregado SOB DEMANDA. Aqui fica só o que a página
// sabe: onde estão os dados e como repintar. Não é organização — é orçamento:
// este arquivo bateu 40,0/40 KB e reprovou o build.
let _tempoRealReaplicar = null;

// Camada 3: dar SINAL de que a tela mudou sozinha.
//
// Números mudando sem aviso nenhum é o tipo de coisa que faz o usuário
// desconfiar do app — ou pior, achar que ele mesmo digitou errado. Um pisca de
// 3 segundos responde "isso foi de propósito" sem interromper nada.
//
// E quando dá para saber QUEM, diz o nome. O aviso do canal traz os ids dos
// perfis tocados; se vier um que não é o meu, foi outra pessoa da conta mexendo
// em algo que me alcança — hoje, na prática, uma reserva compartilhada. O nome
// sai do que já está em memória: nada novo trafega pelo canal.
function _avisarSincronizado(aviso) {
    if (_syncReadyForDisplay) _setSyncState('sincronizado');

    const meu = String(perfilAtivo?.id ?? '');
    const outros = (aviso?.perfis ?? []).map(String).filter((id) => id !== meu);
    if (!outros.length) return;   // foi você, em outra aba ou aparelho

    const nome = outros
        .map((id) => (_allProfilesData || []).find((p) => String(p?.id) === id))
        .map((p) => (p?.nome || p?.name || '').trim())
        .find(Boolean);
    if (nome) mostrarNotificacao(`${nome} atualizou os dados`, 'info');
}

// Busca o estado bom no servidor e repinta. Um só lugar, usado por dois
// gatilhos: o aviso de tempo real e a recusa por versão (409).
async function _recarregarDoServidor(aviso) {
    // Save em voo pousa primeiro: recarregar no meio de um POST traz o estado de
    // ANTES dele, e a tela mostraria o dado recém-gravado como se não existisse.
    if (_saveEmVoo) { try { await _saveEmVoo; } catch { /* segue */ } }
    if (!perfilAtivo) return;
    await carregarDadosPerfil(perfilAtivo.id);
    // carregarDadosPerfil NÃO repinta: enche os arrays e termina em
    // atualizarReferenciasGlobais(). Sem a linha abaixo, o dado só aparecia no
    // F5 seguinte — foi o bug de 2026-08-07.
    atualizarTudo();
    _avisarSincronizado(aviso);
}

// 409 do servidor: este cliente tentou gravar o estado inteiro sobre uma leitura
// velha, e foi recusado. Não dá para mesclar (é justamente o caso em que as
// operações não puderam ser derivadas), então buscamos o estado bom.
//
// A troca é consciente e vale a pena: perder o último segundo de edição DESTE
// cliente é melhor que apagar em silêncio o que a outra pessoa já tinha salvo.
document.addEventListener('ge:versao-conflito', () => {
    mostrarNotificacao('Alguém atualizou estes dados. Recarregando…', 'warning');
    _recarregarDoServidor(null).catch(() => {});
});

// A fila de reenvio esvaziou: o que foi lançado offline JÁ ESTÁ no servidor.
//
// O evento existia desde o Passo 37.4 e ninguém o escutava — o mesmo padrão que
// esta auditoria encontrou o dia inteiro: o mecanismo está lá, e nada o consome.
// O efeito era pior que cosmético. Medido em 15/08: a fila drenou às 13:22:37
// (o audit log registra o blob crescendo 232 bytes), e a transação NÃO apareceu
// na tela — porque a página seguia mostrando o estado carregado no boot, de
// antes da drenagem. Da cadeira do usuário isso é indistinguível de dado
// perdido, e a reação natural — lançar de novo — cria a duplicata de verdade.
document.addEventListener('ge:fila-vazia', () => {
    mostrarNotificacao('Lançamentos feitos offline foram enviados.', 'success');
    _recarregarDoServidor(null).catch(() => {});
});

// Quem da conta está com o app aberto agora.
//
// A presença chega como IDS DE PERFIL — o nome nunca trafega pelo canal, porque
// o conteúdo da presença é escrito pelo cliente e não dá para confiar nele. Aqui
// o id vira nome pelo que já está em memória, e o texto entra por `textContent`:
// um membro adulterado só consegue afirmar ser outro perfil da própria conta, e
// nada do que ele mandar é interpretado como HTML.
function _renderPresenca(ids) {
    const el = document.getElementById('presencaConta');
    if (!el) return;
    const meu = String(perfilAtivo?.id ?? '');
    const nomes = (ids || [])
        .map(String)
        .filter((id) => id !== meu)
        .map((id) => (_allProfilesData || []).find((p) => String(p?.id) === id))
        .map((p) => (p?.nome || p?.name || '').trim())
        .filter(Boolean);

    if (!nomes.length) { el.removeAttribute('data-online'); el.textContent = ''; return; }
    el.textContent = nomes.length === 1
        ? `${nomes[0]} está online`
        : `${nomes.length} pessoas online`;
    el.setAttribute('data-online', '');
}

async function ligarTempoReal() {
    const conta = dataManager.contaId;
    // Um return silencioso é o suspeito nº 1 quando "nada acontece": deixa
    // registrado POR QUE não ligou, em vez de sumir sem deixar rastro.
    if (!conta) { try { window.__tempoReal = { estado: 'sem_conta_no_load' }; } catch {} return; }

    try {
        const { ligarNaTela } = await import('../modules/tempo-real.js?v=1');
        const r = await ligarNaTela({
            url: SUPABASE_URL, apikey: SUPABASE_ANON_KEY, conta,
            token:       () => getValidAccessToken(),
            perfilAtual: () => String(perfilAtivo?.id ?? ''),
            // Quem divide reserva comigo mexe em dinheiro MEU. Sem isto, o save
            // do outro perfil era descartado pelo filtro e a reserva só
            // atualizava no F5. Recalculado a cada aviso — o roster muda.
            perfisRelevantes: _perfisComReservaComigo,
            ocupado:     () => !!(document.getElementById('modalOverlay')?.classList.contains('active') ||
                                  document.getElementById('bottomSheetOverlay')?.classList.contains('active')),
            aoPresenca: _renderPresenca,
            recarregar:  _recarregarDoServidor,
        });
        _tempoRealReaplicar = r?.reaplicarPendente ?? null;
    } catch (e) {
        // Tempo real é conforto, não integridade: sem ele o app funciona como
        // sempre — só exige um F5 para ver o que o outro fez.
        try { window.__tempoReal = { estado: 'erro_ao_ligar', erro: String(e?.message ?? e).slice(0, 120) }; } catch {}
        _log.warn('[TEMPO-REAL] não ligou:', e?.message ?? e);
    }
}

function iniciarAutoSave() {
    if (!perfilAtivo) return;

    pararAutoSave();
    _autoSaveFailCount = 0;

    _log.info('[AUTO-SAVE] Sistema iniciado');

    autoSaveInterval = setInterval(async () => {
        if (!perfilAtivo) return;
        _log.info('[AUTO-SAVE PERIÓDICO] Executando...');
        const ok = await salvarDados();
        if (ok === false) {
            _autoSaveFailCount++;
            _log.warn(`[AUTO-SAVE] Falha ${_autoSaveFailCount}/${_AUTO_SAVE_MAX_FAILS}`);
            if (_autoSaveFailCount >= _AUTO_SAVE_MAX_FAILS) {
                _log.warn('[AUTO-SAVE] Muitas falhas consecutivas — pausando auto-save');
                pararAutoSave();
                mostrarNotificacao('Sincronização pausada. Verifique sua conexão e recarregue a página.', 'error');
            }
        } else {
            _autoSaveFailCount = 0;
        }
    }, 30_000);
}

function pararAutoSave() {
    if (autoSaveInterval) {
        clearInterval(autoSaveInterval);
        autoSaveInterval = null;
        _log.info('[AUTO-SAVE] Pausado');
    }
}

// ✅ EXPOR GLOBALMENTE
window.iniciarAutoSave = iniciarAutoSave;
window.pararAutoSave = pararAutoSave;

// ========== FORMATAÇÕES ADICIONAIS ==========

// `formatarTelefone` e `formatarCPF` foram removidas em 2026-08-18 (auditoria):
// zero referências em src/ e em todo HTML, e o app não coleta nem telefone nem
// CPF em lugar nenhum — eram sobra de um formulário que não existe. Saíram do
// `dashboard.js` de propósito: é o arquivo mais apertado do projeto (36,4 de
// 38 KB gzip), onde peso morto custa folga de orçamento.
//
// Se um dia entrar um campo de telefone/CPF, ele nasce com sanitização e
// validação SERVER-SIDE junto — formatador de tela nunca foi validação.

// Converte número para extenso (útil para cheques)
function numeroParaExtenso(numero) {
    if(numero === 0) return 'zero';
    
    const unidades = ['', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove'];
    const especiais = ['dez', 'onze', 'doze', 'treze', 'quatorze', 'quinze', 'dezesseis', 'dezessete', 'dezoito', 'dezenove'];
    const dezenas = ['', '', 'vinte', 'trinta', 'quarenta', 'cinquenta', 'sessenta', 'setenta', 'oitenta', 'noventa'];
    const centenas = ['', 'cento', 'duzentos', 'trezentos', 'quatrocentos', 'quinhentos', 'seiscentos', 'setecentos', 'oitocentos', 'novecentos'];
    
    // Implementação simplificada para números até 999
    if(numero < 10) return unidades[numero];
    if(numero < 20) return especiais[numero - 10];
    if(numero < 100) {
        const dez = Math.floor(numero / 10);
        const uni = numero % 10;
        return dezenas[dez] + (uni > 0 ? ' e ' + unidades[uni] : '');
    }
    if(numero < 1000) {
        const cen = Math.floor(numero / 100);
        const resto = numero % 100;
        if(numero === 100) return 'cem';
        return centenas[cen] + (resto > 0 ? ' e ' + numeroParaExtenso(resto) : '');
    }
    
    return numero.toString();
}

// ========== EXPORTAÇÃO DE DADOS ==========

// ✅ Limite máximo de registros por exportação
//    Impede geração de arquivo gigantesco que trave o navegador
//    Um usuário normal raramente terá mais de 5000 transações
const _EXPORT_MAX_REGISTROS = 5_000;

// ── Exportação JSON/CSV — extraída para modules/exportar-dados.js (Passo 10) ──
// Eram ~163 linhas (~7KB) carregadas EAGER no boot para uma ação que a maioria
// dos usuários nunca faz. O dashboard.js estava em 40,9KB de um orçamento de 42
// — cada feature nova exigia conferir se cabia. Agora o chunk só baixa no clique.
// A lógica não mudou; o que era global daqui entra pelo `ctx` (getters vivos).
function _exportar(qual) {
    import('../modules/exportar-dados.js?v=1')
        .then(m => qual === 'json' ? m.exportarDadosJSON(_makeCtx()) : m.exportarDadosCSV(_makeCtx()))
        .catch(e => {
            _log.error('EXPORT_LAZY_001', e);
            mostrarNotificacao('Não foi possível abrir a exportação agora. Tente novamente.', 'error');
        });
}
function exportarDadosJSON() { _exportar('json'); }
function exportarDadosCSV()  { _exportar('csv');  }

// ========== NOTIFICAÇÕES ==========

// Sistema simples de notificações — estilos em dashboard.css (classes ge-notif)
// Vibração tátil curta no mobile (no-op em desktop ou sem suporte)
function hapticTap(pattern = 12) {
    try {
        if (navigator.vibrate && window.matchMedia('(pointer: coarse)').matches) {
            navigator.vibrate(pattern);
        }
    } catch (_) { /* silencioso */ }
}
window.hapticTap = hapticTap;

// Região única de toasts (criada sob demanda) com aria-live para leitores de tela
function _toastRegion() {
    let region = document.getElementById('geToastRegion');
    if (!region) {
        region = document.createElement('div');
        region.id = 'geToastRegion';
        region.className = 'ge-toast-region';
        region.setAttribute('role', 'region');
        region.setAttribute('aria-label', 'Notificações');
        document.body.appendChild(region);
    }
    return region;
}

const _TOAST_ICONS = { success: 'fa-check', error: 'fa-xmark', warning: 'fa-triangle-exclamation', info: 'fa-circle-info' };

function mostrarNotificacao(mensagem, tipo = 'info') {
    const tipoMap = { success: 'ge-notif--success', error: 'ge-notif--error', warning: 'ge-notif--warning' };
    const region = _toastRegion();
    // Erros interrompem o leitor de tela; o resto aguarda pausa natural
    region.setAttribute('aria-live', tipo === 'error' ? 'assertive' : 'polite');

    const notif = document.createElement('div');
    notif.className = `ge-notif ${tipoMap[tipo] ?? 'ge-notif--info'}`;
    notif.setAttribute('role', tipo === 'error' ? 'alert' : 'status');

    const icon = document.createElement('i');
    icon.className = 'ge-notif__icon fas ' + (_TOAST_ICONS[tipo] ?? _TOAST_ICONS.info);
    icon.setAttribute('aria-hidden', 'true');

    const txt = document.createElement('span');
    txt.className = 'ge-notif__text';
    txt.textContent = String(mensagem ?? '').slice(0, 200);

    notif.append(icon, txt);
    region.appendChild(notif);

    // Feedback tátil: erro = padrão duplo, demais = toque curto
    hapticTap(tipo === 'error' ? [18, 40, 18] : 12);

    let encerrado = false;
    const encerrar = () => {
        if (encerrado) return;
        encerrado = true;
        notif.classList.add('ge-notif--exit');
        setTimeout(() => notif.remove(), 320);
    };
    notif.addEventListener('click', encerrar);
    setTimeout(encerrar, 3000);
}

window.mostrarNotificacao = mostrarNotificacao;

// Toast com ação "Desfazer" — para exclusões reversíveis (padrão optimistic UI).
// A exclusão JÁ foi aplicada localmente (local-first); `aoDesfazer` REVERTE o estado.
// Se o toast expirar sem ação, a exclusão simplesmente permanece (já foi salva).
function mostrarNotificacaoDesfazer(mensagem, aoDesfazer, { duracao = 6000 } = {}) {
    const region = _toastRegion();
    region.setAttribute('aria-live', 'polite');

    const notif = document.createElement('div');
    notif.className = 'ge-notif ge-notif--undo';
    notif.setAttribute('role', 'status');

    const icon = document.createElement('span');
    icon.className = 'ge-notif__icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '↺';

    const txt = document.createElement('span');
    txt.className = 'ge-notif__text';
    txt.textContent = String(mensagem ?? '').slice(0, 200);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ge-notif__action';
    btn.textContent = 'Desfazer';

    const timer = document.createElement('span');
    timer.className = 'ge-notif__timer';
    timer.setAttribute('aria-hidden', 'true');

    notif.append(icon, txt, btn, timer);
    region.appendChild(notif);
    hapticTap(12);

    // Barra de tempo restante — degrada para estática em reduced-motion
    const reduz = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!reduz) {
        timer.style.transition = `transform ${duracao}ms linear`;
        requestAnimationFrame(() => { timer.style.transform = 'scaleX(0)'; });
    }

    let encerrado = false;
    let tid = null;
    const encerrar = () => {
        if (encerrado) return;
        encerrado = true;
        if (tid) clearTimeout(tid);
        notif.classList.add('ge-notif--exit');
        setTimeout(() => notif.remove(), 320);
    };

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        encerrar();
        try { aoDesfazer?.(); } catch (err) { console.error('Falha ao desfazer:', err); }
    });

    tid = setTimeout(encerrar, duracao);
    return encerrar;
}
window.mostrarNotificacaoDesfazer = mostrarNotificacaoDesfazer;

// ========== ESTADO DE CONEXÃO (online / offline) ==========
(function initNetworkStatus() {
    let banner = null;
    let caiuAlgumaVez = false;

    function getBanner() {
        if (banner) return banner;
        banner = document.createElement('div');
        banner.id = 'geOfflineBanner';
        banner.className = 'ge-offline-banner';
        banner.setAttribute('role', 'status');
        banner.setAttribute('aria-live', 'polite');
        const ico = document.createElement('i');
        ico.setAttribute('aria-hidden', 'true');
        const txt = document.createElement('span');
        banner.append(ico, txt);
        document.body.appendChild(banner);
        return banner;
    }

    function aoFicarOffline() {
        caiuAlgumaVez = true;
        const b = getBanner();
        b.querySelector('i').className = 'fas fa-wifi';
        b.querySelector('span').textContent = 'Você está sem conexão — suas alterações podem não ser salvas.';
        b.classList.remove('ge-offline-banner--online');
        b.classList.add('ge-offline-banner--visible');
    }

    function aoFicarOnline() {
        if (!caiuAlgumaVez) return; // não anuncia "reconectado" se nunca caiu nesta sessão
        const b = getBanner();
        b.querySelector('i').className = 'fas fa-check-circle';
        b.querySelector('span').textContent = 'Conexão restabelecida.';
        b.classList.add('ge-offline-banner--online', 'ge-offline-banner--visible');
        setTimeout(() => b.classList.remove('ge-offline-banner--visible', 'ge-offline-banner--online'), 2500);
    }

    window.addEventListener('offline', aoFicarOffline);
    window.addEventListener('online',  aoFicarOnline);
    if (navigator.onLine === false) aoFicarOffline();
})();

// ========== COMMAND PALETTE (Ctrl/Cmd + K) — chunk lazy ==========
// A paleta saiu para modules/command-palette.js (O-1): ~150 linhas que só fazem
// algo quando alguém aperta Ctrl+K. Fica aqui só o atalho; o módulo desce no
// PRIMEIRO uso. Quem nunca aperta, nunca baixa.
(function () {
    let _paleta = null;
    let _carregando = false;

    document.addEventListener('keydown', async (e) => {
        if (!((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K'))) return;

        // Não abre na tela de seleção de perfil. A checagem é duplicada aqui de
        // propósito: sem ela, o módulo seria baixado só para descobrir que não
        // devia abrir.
        const sel = document.getElementById('selecaoPerfis');
        const appVisivel = !sel || sel.style.display === 'none'
                        || getComputedStyle(sel).display === 'none';
        if (!appVisivel) return;

        e.preventDefault();
        if (_carregando) return;

        if (!_paleta) {
            _carregando = true;
            try {
                _paleta = await import('../modules/command-palette.js');
                _paleta.init({ mostrarTela });
            } catch {
                _paleta = null;
                return;               // atalho falhou: o app segue normal
            } finally {
                _carregando = false;
            }
        }
        _paleta.alternar();
    });
})();

// ========== ATALHOS DE TECLADO ==========

// Adiciona suporte a atalhos de teclado
document.addEventListener('keydown', (e) => {
    // Ctrl/Cmd + S para salvar
    if((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        salvarDados();
        mostrarNotificacao('Dados salvos!', 'success');
    }

    // ESC — fecha popup/modal aberto
    if(e.key === 'Escape') {
        const overlay = document.getElementById('modalOverlay');
        if(overlay && overlay.classList.contains('active')) {
            fecharPopup();
            e.preventDefault();
            return;
        }
        // Fecha bottom-sheet se aberto (via fecharPopup → libera focus-trap/inert)
        const bs = document.getElementById('bottomSheetOverlay');
        if (bs && bs.classList.contains('active')) {
            fecharPopup();
            e.preventDefault();
            return;
        }
    }

    // Enter — confirma o botão primário do popup aberto
    // Só dispara quando o foco está dentro do modal (não em inputs externos)
    if(e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        const overlay = document.getElementById('modalOverlay');
        if(overlay && overlay.classList.contains('active')) {
            const container = document.getElementById('modalContainer');
            if (!container) return;
            // Se o foco está num textarea, não confirma (usuário quer nova linha)
            if (document.activeElement?.tagName === 'TEXTAREA') return;
            // Prioriza #confirmBtn; depois o primeiro btn-primary que não seja cancelar
            const confirmBtn = container.querySelector('#confirmBtn') ||
                               container.querySelector('.btn-primary:not(.btn-cancelar):not([data-no-enter])');
            if (confirmBtn && !confirmBtn.disabled) {
                e.preventDefault();
                confirmBtn.click();
            }
        }
    }

    // Ctrl/Cmd + K para busca rápida
    if((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        const busca = document.getElementById('movBuscaInput');
        if (busca) { busca.focus(); busca.select(); }
    }
});

// ========== VERIFICAÇÃO DE ATUALIZAÇÕES ==========

// Verifica se há nova versão (simulado - adapte conforme sua necessidade)
function verificarAtualizacoes() {
    const versaoAtual = '1.0.0';
    const ultimaVerificacao = localStorage.getItem('granaevo_ultima_verificacao');
    const hoje = isoDate();

    if (ultimaVerificacao !== hoje) {
        localStorage.setItem('granaevo_ultima_verificacao', hoje);
        // ✅ CORREÇÃO: usa _log.info (logger interno já definido no módulo)
        //    Em produção suprime automaticamente; em dev loga normalmente
        _log.info('[VERSÃO] Verificação executada. Versão atual:', versaoAtual);
    }
}

// Executa verificação ao carregar
setTimeout(verificarAtualizacoes, 3000);

// (obterEstatisticas() removida no Passo 10: 42 linhas definidas e NUNCA
// chamadas — nenhuma referência em src/, public/ ou api/, nem em window/ctx.)

// ========== CONSOLE DE DEBUG (APENAS DESENVOLVIMENTO) ==========
if (IS_DEV) {
    Object.defineProperty(window, 'debugGranaEvo', {
        value: () => {
            console.log('=== DEBUG GRANAEVO (DEV) ===');
            console.log('Perfil ID:', perfilAtivo?.id);
            console.log('Total transações:', transacoes?.length);
            console.log('Total metas:', metas?.length);
            console.log('Total contas fixas:', contasFixas?.length);
            console.log('Total cartões:', cartoesCredito?.length);
            console.log('============================');
        },
        writable:     false,
        configurable: false,
        enumerable:   false,
    });
}

// ========== LOG DE SISTEMA ==========

const sistemaLog = (() => {
    // ✅ CORREÇÃO: closure privado — logs inacessíveis externamente
    //    Antes: window.sistemaLog = sistemaLog permitia leitura e limpeza de logs por qualquer script
    //    Agora: apenas o módulo interno pode adicionar/ler logs
    const _logs   = [];
    const _maxLogs = 50;

    return {
        adicionar(tipo, mensagem) {
            const entry = {
                tipo,
                // ✅ Truncar mensagem — nunca armazenar valores financeiros ou PII
                mensagem:  String(mensagem).substring(0, 120),
                timestamp: new Date().toISOString(),
            };
            _logs.push(entry);
            if (_logs.length > _maxLogs) {
                _logs.shift();
            }
            // ✅ Sem localStorage — logs apenas em memória
        },

        // ✅ obter() mantido internamente para uso pelos módulos do próprio sistema
        //    mas NÃO exposto em window.*
        obter() {
            return [..._logs];
        },

        limpar() {
            _logs.length = 0;
        },
    };
})();


// ========== INICIALIZAÇÃO FINAL ==========

// Log de inicialização
sistemaLog.adicionar('INFO', 'Sistema GranaEvo inicializado');

// Verificação automática de vencimentos a cada 30 minutos
setInterval(() => {
    if(perfilAtivo) {
        verificacaoAutomaticaVencimentos();
    }
}, 1800000); // 30 minutos

// Verificação inicial ao carregar
setTimeout(() => {
    if(perfilAtivo) {
        verificacaoAutomaticaVencimentos();
    }
}, 5000); // 5 segundos após carregar

// ========== SISTEMA DE PARTÍCULAS OTIMIZADO (APENAS DESKTOP) ==========
// ========== FUNDO ANIMADO (decoração) — chunk lazy ==========
// O ParticleSystem saiu para modules/particulas.js (O-1): eram ~120 linhas que
// NÃO rodam em mobile nem para quem pediu menos movimento, mas viajavam no
// chunk de boot do dashboard para todo mundo. As guardas ficam AQUI, antes do
// import — o ponto é não baixar o código, e checar lá dentro seria tarde demais.
document.addEventListener('DOMContentLoaded', () => {
    if (window.innerWidth <= 768) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    // Enfeite não disputa banda com o carregamento dos dados: espera o load e
    // ainda cede a vez ao primeiro ocioso.
    const agendar = window.requestIdleCallback || ((fn) => setTimeout(fn, 500));
    window.addEventListener('load', () => {
        agendar(() => {
            import('../modules/particulas.js')
                .then(({ iniciarParticulas }) => iniciarParticulas())
                .catch(() => { /* enfeite: falhar aqui não afeta o app */ });
        });
    }, { once: true });
});

// desenharGraficoLinha / desenharTopGastos REMOVIDAS (Passo 10): eram codigo
// morto — nada as chamava e o db-metas tem a propria copia (_desenharGraficoLinha).

// ========== ONBOARDING AUTOMÁTICO PARA NOVOS USUÁRIOS ==========
// Detecta perfil sem dados na primeira visita e mostra a experiência de
// boas-vindas (módulo onboarding.js, camada própria — não usa o modalOverlay
// compartilhado, então não pode ser "engolido" por outros popups).
//
// ✅ O flag "visto" só é gravado APÓS interação real do usuário (tour/dispensa).
//    Antes, era gravado ao agendar o popup — qualquer falha de exibição fazia
//    as boas-vindas sumirem para sempre.
function _verificarOnboardingNovoPerfil() {
    try {
        if (!perfilAtivo) return;
        // v2: chave nova — a v1 era gravada antes da exibição e ficava
        // "queimada" mesmo quando o usuário nunca viu o popup
        const chaveVisto = `ge_onboard_v2_${perfilAtivo.id}`;
        if (localStorage.getItem(chaveVisto)) return; // já interagiu com as boas-vindas

        // Considera novo se não tem transações nem contas fixas
        const ehNovo = transacoes.length === 0 && contasFixas.length === 0;
        if (!ehNovo) {
            // Usuário com dados pré-existentes: marca como visto sem exibir
            localStorage.setItem(chaveVisto, '1');
            return;
        }

        // Pequeno delay para garantir que a UI terminou de renderizar
        setTimeout(async () => {
            try {
                const { mostrarBoasVindas } = await import('../modules/onboarding.js');
                mostrarBoasVindas({
                    nome:    perfilAtivo?.nome || usuarioLogado?.nome || '',
                    plano:   usuarioLogado?.plano || '',
                    isGuest: Boolean(usuarioLogado?.isGuest),
                    aoEscolher: async (escolha) => {
                        // ✅ Persiste somente aqui — após escolha explícita
                        try { localStorage.setItem(chaveVisto, '1'); } catch (_) {}
                        if (escolha === 'tour') {
                            const { iniciarTutorial } = await import('../modules/tutorial.js');
                            // Novo usuário: trilha Essencial (curta) — aponta p/ o hub ao final
                            setTimeout(() => iniciarTutorial({
                                trilha:  'essencial',
                                plano:   usuarioLogado?.plano,
                                isGuest: Boolean(usuarioLogado?.isGuest),
                            }), 120);
                        }
                    },
                });
            } catch (e) {
                _log.error('ONBOARD_001', e);
            }
        }, 700);

    } catch { /* localStorage pode estar bloqueado — falha silenciosa */ }
}

// ========== FEEDBACK DE PERÍODO SELECIONADO NOS FILTROS =========
// Aplica classe active com animação nos filtros de período para deixar claro qual está ativo
function _atualizarFeedbackPeriodo() {
    const btns = document.querySelectorAll('.mov-filtro-btn');
    btns.forEach(btn => {
        const isAtivo = btn.dataset.filtro === filtroMovAtivo;
        btn.setAttribute('aria-pressed', String(isAtivo));
    });
    // Atualiza o cabeçalho do filtro com destaque visual
    const headerLabel = document.getElementById('filtroAtivoLabel');
    if (headerLabel) {
        headerLabel.setAttribute('data-active', 'true');
        clearTimeout(headerLabel._fadeTimer);
        headerLabel._fadeTimer = setTimeout(() => headerLabel.removeAttribute('data-active'), 1200);
    }
}

// Expor globalmente para ser chamado de db-transacoes.js
window._atualizarFeedbackPeriodo = _atualizarFeedbackPeriodo;

// ========== SALVAMENTO GARANTIDO AO SAIR ==========
window.addEventListener('beforeunload', () => {
    if (!perfilAtivo || !dataManager.userId || !_cachedAuthToken) return;

    atualizarReferenciasGlobais();

    const transacoesValidas = transacoes.filter(_validators.transacao);
    const metasValidas      = metas.filter(_validators.meta);
    const contasValidas     = contasFixas.filter(_validators.contaFixa).map(c => {
        const { _processando, ...rest } = c;
        return rest;
    });
    const cartoesValidos    = cartoesCredito.filter(_validators.cartao);
    const assinaturasValidas = assinaturas.filter(_validators.assinatura);

    const dadosAtual = {
        id:             perfilAtivo.id,
        nome:           _sanitizeText(perfilAtivo.nome),
        foto:           _sanitizeImgUrl(perfilAtivo.foto) || null,
        transacoes:     transacoesValidas,
        metas:          metasValidas,
        contasFixas:    contasValidas,
        cartoesCredito: cartoesValidos,
        assinaturas:    assinaturasValidas,
        nextCartaoId:   Number.isInteger(nextCartaoId) && nextCartaoId > 0 ? nextCartaoId : 1,
        lastUpdate:     new Date().toISOString(),
    };

    // Monta lista completa de perfis com dados atuais em memória
    const profilesAtual = _allProfilesData.length > 0
        ? JSON.parse(JSON.stringify(_allProfilesData))
        : [];
    const idx = profilesAtual.findIndex(p => String(p.id) === String(perfilAtivo.id));
    if (idx !== -1) profilesAtual[idx] = dadosAtual;
    else profilesAtual.push(dadosAtual);

    // Anti-wipe: este POST cru bypassa o dataManager. Se a memória foi esvaziada
    // por um load falho, persistir aqui sobrescreveria o banco com dados vazios.
    if (dataManager.isDestructiveSave(profilesAtual)) {
        _log.warn('[beforeunload] save bloqueado pelo anti-wipe (load falho — não sobrescrever banco)');
        return;
    }

    const payload = JSON.stringify({ profiles: profilesAtual });
    if (payload.length > 4_900_000) return;

    // fetch com keepalive suporta headers — substitui sendBeacon que não suporta Authorization
    fetch('/api/user-data', {
        method:    'POST',
        keepalive: true,
        headers: {
            'Content-Type':  'application/json',
            'Authorization': `Bearer ${_cachedAuthToken}`,
        },
        body: payload,
    });
});


// ✅ Trocar de aba ou minimizar — tem tempo suficiente para async normal
// ✅ CORRIGIDO: registrado uma única vez — duplicata removida (causava double-save e race condition)
document.addEventListener('visibilitychange', () => {
    if (document.hidden && perfilAtivo) {
        _log.info('[VISIBILIDADE] Aba oculta - Salvando...');
        salvarDados();
    }
});

// ✅ Janela perde foco — salva também
// ✅ CORRIGIDO: registrado uma única vez
window.addEventListener('blur', () => {
    if (perfilAtivo) {
        _log.info('[FOCO] Janela perdeu foco - Salvando...');
        salvarDados();
    }
});

// ========== INDICADOR DE SAVE E ESTADO OFFLINE ==========
function _initSyncIndicator() {
    let _offlineMode = !navigator.onLine;
    let _clearTimer  = null;

    function _setSync(state, text, autoHideMs) {
        if (_clearTimer) { clearTimeout(_clearTimer); _clearTimer = null; }
        const els = [
            document.getElementById('syncIndicator'),
            document.getElementById('syncIndicatorDesktop'),
        ].filter(Boolean);
        for (const el of els) {
            if (state) { el.dataset.state = state; el.textContent = text; }
            else { delete el.dataset.state; el.textContent = ''; }
        }
        if (autoHideMs > 0) _clearTimer = setTimeout(() => _setSync(null, '', 0), autoHideMs);
    }

    document.addEventListener('ge:save-start', () => {
        if (_offlineMode) return;
        _setSync('saving', 'Salvando...', 0);
    });
    document.addEventListener('ge:save-done', () => {
        if (_offlineMode) return;
        _setSync('saved', 'Salvo ✓', 3_000);
    });
    document.addEventListener('ge:save-error', () => {
        if (_offlineMode) return;
        _setSync('error', 'Erro ao salvar', 5_000);
    });

    window.addEventListener('offline', () => {
        _offlineMode = true;
        _setSync('error', 'Sem conexão', 0);
    });
    window.addEventListener('online', () => {
        _offlineMode = false;
        _setSync('saved', 'Conectado ✓', 3_000);
    });

    if (_offlineMode) _setSync('error', 'Sem conexão', 0);
}

// ========== MÁSCARA MONETÁRIA ==========
// O motor da máscara vive em modules/mascara-moeda.js e é o MESMO em todos os
// campos de dinheiro do app (conta fixa, cartão, orçamento, reservas...).
// Quem lê o valor tem de usar lerMoeda() — parseFloat("1.234,56") dá 1.234.
function _initMascaraMonetaria() {
    aplicarMascaraMoeda('inputValor');
}

// ========== INICIALIZAÇÃO ==========
function _registrarFallbacksFotoPerfil() {
    // Fallback para qualquer <img> de foto de perfil que falhar ao carregar.
    // Passivo (só dispara em erro de carga) → seguro adiar para idle.
    document.querySelectorAll('#userPhoto, #mobileUserPhoto, #cfgUserPhoto').forEach(img => {
        img.addEventListener('error', function () {
            this.style.display = 'none';
            const fbId = this.id.replace('Photo', 'PhotoFallback').replace('cfgUser', 'cfgUser');
            const fb = document.getElementById(fbId) || this.nextElementSibling;
            if (fb) {
                fb.style.display = 'flex';
                const nameEl = document.getElementById('userName');
                fb.textContent = (nameEl?.textContent || 'U').trim().charAt(0).toUpperCase() || 'U';
            }
        }, { once: true });
    });
}

document.addEventListener('DOMContentLoaded', () => {
    // ── Crítico para o 1º frame: auth + eventos + controles já visíveis/clicáveis ──
    // Mantidos EAGER de propósito: adiar binding de UI clicável faria o 1º clique "morrer".
    perfMark('boot:critico');
    verificarLogin();
    bindEventos();
    setupSidebarToggle();
    _initBtnPeriodoDash();
    perfMeasure('boot:critico', '(verificarLogin+bindEventos+sidebar+btnPeriodo)');

    // ── Não-crítico: nada disso é interativo no 1º frame nem afeta o primeiro paint.
    // Vai para idle (libera a main thread mais cedo em CPU fraca):
    //   • _initSyncIndicator   — indicador passivo de sync
    //   • _initMascaraMonetaria — máscara do input de valor (form de transações, tela lazy)
    //   • fallbacks de foto     — só disparam em erro de <img>
    _idle(() => {
        perfMark('boot:idle');
        _initSyncIndicator();
        _initMascaraMonetaria();
        _registrarFallbacksFotoPerfil();
        perfMeasure('boot:idle', '(syncIndicator+mascara+fallbacksFoto)');
    });
});
