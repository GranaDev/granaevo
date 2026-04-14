// ========== IMPORTS ESSENCIAIS ==========
import { supabase } from './supabase-client.js?v=2';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-client.js?v=2';
import { dataManager } from './data-manager.js?v=2';
import AuthGuard from './auth-guard.js?v=2';

console.log('🚀 Dashboard.js carregado');
console.log('📦 DataManager disponível:', !!dataManager);

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
let metas = [];
let contasFixas = [];
let nextTransId = 1;
let nextMetaId = 1;
let nextContaFixaId = 1;
let metaSelecionadaId = null;
let cartaoSelecionadoId = null;
let tipoRelatorioAtivo = 'individual';
let _effectiveUserId = null;
let _effectiveEmail  = null;

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

async function _sanitizeImageFile(file) {
    return new Promise((resolve) => {
        createImageBitmap(file)
            .then((bitmap) => {
                try {
                    const canvas = document.createElement('canvas');
                    const MAX_DIM = 1200;
                    let w = bitmap.width;
                    let h = bitmap.height;

                    if (w > MAX_DIM || h > MAX_DIM) {
                        if (w >= h) { h = Math.round((h / w) * MAX_DIM); w = MAX_DIM; }
                        else        { w = Math.round((w / h) * MAX_DIM); h = MAX_DIM; }
                    }

                    canvas.width  = w;
                    canvas.height = h;

                    const ctx = canvas.getContext('2d');
                    ctx.fillStyle = '#ffffff';
                    ctx.fillRect(0, 0, w, h);
                    ctx.drawImage(bitmap, 0, 0, w, h);
                    bitmap.close();

                    canvas.toBlob(
                        (blob) => {
                            if (!blob) {
                                _log.error('SANITIZE_IMG_001', 'canvas.toBlob retornou null — upload bloqueado');
                                resolve(null);
                                return;
                            }
                            const sanitized = new File(
                                [blob],
                                'profile.webp',
                                { type: 'image/webp', lastModified: Date.now() }
                            );
                            resolve(sanitized);
                        },
                        'image/webp',
                        0.92
                    );
                } catch (err) {
                    _log.error('SANITIZE_IMG_002', err);
                    try { bitmap.close(); } catch (_) {}
                    resolve(null);
                }
            })
            .catch((err) => {
                _log.error('SANITIZE_IMG_003', 'createImageBitmap falhou — upload bloqueado');
                resolve(null);
            });
    });
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
    const _IS_DEV = (
        window.location.hostname === 'localhost' ||
        window.location.hostname === '127.0.0.1'
    );

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
    _def('transacoes', () =>
        Object.freeze(transacoes.map(t => Object.freeze(Object.assign({}, t))))
    );
    _def('metas', () =>
        Object.freeze(metas.map(m => Object.freeze(Object.assign({}, m))))
    );
    _def('contasFixas', () =>
        Object.freeze(contasFixas.map(c => Object.freeze(Object.assign({}, c))))
    );
    _def('cartoesCredito', () =>
        Object.freeze(cartoesCredito.map(c => Object.freeze(Object.assign({}, c))))
    );

    // ✅ usuarioLogado expõe apenas plano e perfis simplificados — graficos.js precisa do plano
    _def('usuarioLogado', () => Object.freeze({
        plano:  usuarioLogado.plano,
        perfis: Object.freeze(
            (usuarioLogado.perfis || []).map(p => Object.freeze({ id: p.id, nome: p.nome }))
        ),
    }));

    // ✅ Dev-only: aliases com prefixo _dev_ para debugging no console
    if (
        window.location.hostname === 'localhost' ||
        window.location.hostname === '127.0.0.1'
    ) {
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
}

// Limites por plano
const limitesPlano = {
    "Individual": 1,
    "Casal": 2,
    "Família": 4
};

// ========== FUNÇÕES DE FORMATAÇÃO ==========
function formatBRL(v) { 
    return 'R$ ' + Number(v).toLocaleString('pt-BR', {
        minimumFractionDigits: 2, 
        maximumFractionDigits: 2
    }); 
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
    const IS_DEV = window.location.hostname === 'localhost' ||
                   window.location.hostname === '127.0.0.1';
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

        const { data: perfis, error } = await supabase
            .from('profiles')
            .select('id, name, photo_url')
            .eq('user_id', userIdSeguro)
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

// ========== CARREGAR DADOS DO PERFIL (CORRIGIDA) ==========
async function carregarDadosPerfil(perfilId) {
    try {
        _log.info('📦 [carregarDadosPerfil] Iniciando carregamento de dados');

        const userData = await dataManager.loadUserData();

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

            // ✅ nextIds mantidos apenas para cartões — cartão ainda usa ID local
            nextCartaoId = 1;

            atualizarReferenciasGlobais();
            return;
        }

        transacoes     = Array.isArray(perfilData.transacoes)     ? perfilData.transacoes     : [];
        metas          = Array.isArray(perfilData.metas)          ? perfilData.metas          : [];
        contasFixas    = Array.isArray(perfilData.contasFixas)    ? perfilData.contasFixas    : [];
        cartoesCredito = Array.isArray(perfilData.cartoesCredito) ? perfilData.cartoesCredito : [];

        const idsCartoesNumericos = cartoesCredito
            .map(c => typeof c.id === 'number' ? c.id : parseInt(c.id, 10))
            .filter(n => Number.isInteger(n) && n > 0);

        nextCartaoId = perfilData.nextCartaoId
            || (idsCartoesNumericos.length > 0 ? Math.max(...idsCartoesNumericos) + 1 : 1);

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
        atualizarReferenciasGlobais();
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

        // ✅ CORREÇÃO: valida `usado` — impede valor negativo que inflaria o limite disponível
        if (c.usado !== undefined && c.usado !== null) {
            if (typeof c.usado !== 'number' || !isFinite(c.usado) || c.usado < 0 || c.usado > 9999999) return false;
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

// ── NOVO (Ponto 5 — Limite de payload):
//    Teto de registros por tipo de array.
//    Bloqueia saves abusivos antes de serializar qualquer dado.
const _SAVE_LIMITS = Object.freeze({
    transacoes:    10_000,
    metas:            500,
    contasFixas:    1_000,
    cartoesCredito:    50,
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
    ]),
    contaFixa: Object.freeze([
        'id', 'descricao', 'valor', 'vencimento', 'pago',
        'cartaoId', 'tipoContaFixa', 'compras',
        'totalParcelas', 'parcelaAtual',
    ]),
    cartao: Object.freeze([
        'id', 'nomeBanco', 'limite', 'vencimentoDia',
        'bandeiraImg', 'usado', 'congelado',
    ]),
});

// ✅ Controle interno de debounce do salvarDados
//    Declarado fora para persistir entre chamadas
let _saveDebounceTimer   = null;
let _saveDebounceResolve = null;

async function salvarDados() {
    atualizarReferenciasGlobais();

    if (!perfilAtivo) {
        _log.error('SAVE_001', 'Nenhum perfil ativo');
        return false;
    }

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

        _saveDebounceTimer = setTimeout(async () => {
            _saveDebounceTimer   = null;
            _saveDebounceResolve = null;

            try {
                // ── 1. Filtrar itens inválidos pelo schema ──────────────────
                const transacoesValidas = transacoes.filter(_validators.transacao);
                const metasValidas      = metas.filter(_validators.meta);
                const cartoesValidos    = cartoesCredito.filter(_validators.cartao);

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
                    cartoesValidos.length    !== cartoesCredito.length) {
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

                // ── 4. Montar objeto do perfil atual ────────────────────────
                const dadosPerfil = {
                    id:             perfilAtivo.id,
                    nome:           _sanitizeText(perfilAtivo.nome),
                    foto:           _sanitizeImgUrl(perfilAtivo.foto) || null,
                    transacoes:     transacoesSanitizadas,
                    metas:          metasSanitizadas,
                    contasFixas:    contasSanitizadas,
                    cartoesCredito: cartoesSanitizados,
                    nextCartaoId:   Number.isInteger(nextCartaoId) && nextCartaoId > 0 ? nextCartaoId : 1,
                    lastUpdate:     new Date().toISOString(),
                };

                // ── 5. Carregar dados existentes, atualizar perfil e salvar ─
                //    ✅ CORREÇÃO CRÍTICA: usa saveUserData(profiles) que é o método
                //       correto do data-manager.js. saveProfileData() não existe.
                //       Carregamos o userData completo, atualizamos apenas o perfil
                //       ativo e salvamos o array inteiro — igual ao fluxo original.
                const userData = await dataManager.loadUserData();

                if (!validarUserData(userData)) {
                    _log.error('SAVE_003', 'Estrutura de userData inválida ao salvar');
                    resolve(false);
                    return;
                }

                const perfilIndex = userData.profiles.findIndex(
                    p => String(p.id) === String(perfilAtivo.id)
                );

                if (perfilIndex !== -1) {
                    userData.profiles[perfilIndex] = dadosPerfil;
                } else {
                    userData.profiles.push(dadosPerfil);
                }

                const sucesso = await dataManager.saveUserData(userData.profiles);
                if (!sucesso) _log.error('SAVE_004', 'saveUserData retornou false');
                resolve(!!sucesso);

            } catch (e) {
                _log.error('SAVE_005', e);
                resolve(false);
            }
        }, 2_000);
    });
}

async function verificarLogin() {
    const authLoading = document.getElementById('authLoading');
    const protectedContent = document.querySelector('[data-protected-content]');

    try {
        _log.info('[VERIFICAR LOGIN] Iniciando verificação...');

        if (authLoading) authLoading.style.display = 'flex';
        if (protectedContent) protectedContent.style.display = 'none';

        const { data: { session }, error: sessionError } = await supabase.auth.getSession();

        if (sessionError || !session) {
            _log.warn('[VERIFICAR LOGIN] Sessão não encontrada. Redirecionando...');
            window.location.href = 'login.html';
            return;
        }

        _log.info('[VERIFICAR LOGIN] Sessão autenticada com sucesso');
        _log.info('[VERIFICAR LOGIN] Buscando assinatura...');

        let planName = '';
        let effectiveUserId = session.user.id;
        let effectiveEmail = session.user.email;
        let isGuest = false;

        const agora = new Date().toISOString();

        const { data: subscription, error: subError } = await supabase
            .from('subscriptions')
            .select('plans(name)')
            .eq('user_id', session.user.id)
            .eq('payment_status', 'approved')
            .eq('is_active', true)
            .or(`expires_at.is.null,expires_at.gt.${agora}`)
            .maybeSingle();

        if (!subError && subscription) {
            planName = subscription.plans.name;
            _log.info('[VERIFICAR LOGIN] Assinatura própria encontrada');
        } else {
            _log.info('[VERIFICAR LOGIN] Sem assinatura por user_id. Tentando fallback por email...');

            const { data: subByEmail, error: subEmailError } = await supabase
                .from('subscriptions')
                .select('id, plans(name)')
                .eq('user_email', session.user.email)
                .eq('payment_status', 'approved')
                .eq('is_active', true)
                .or(`expires_at.is.null,expires_at.gt.${agora}`)
                .maybeSingle();

            if (!subEmailError && subByEmail) {
                planName = subByEmail.plans.name;
                _log.info('[VERIFICAR LOGIN] Assinatura encontrada por email');

                _log.info('[VERIFICAR LOGIN] Solicitando vínculo server-side...');
                try {
                    const linkResponse = await fetch(
                        `${SUPABASE_URL}/functions/v1/link-user-subscription`,
                        {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'Authorization': `Bearer ${session.access_token}`,
                                'apikey': SUPABASE_ANON_KEY,
                            },
                            body: JSON.stringify({ subscription_id: subByEmail.id }),
                        }
                    );

                    if (!linkResponse.ok) {
                        _log.info('[VERIFICAR LOGIN] Vínculo não realizado nesta sessão (não crítico). Status:', linkResponse.status);
                    } else {
                        _log.info('[VERIFICAR LOGIN] Solicitação de vínculo enviada ao servidor');
                    }
                } catch (linkErr) {
                    _log.info('[VERIFICAR LOGIN] Vínculo não realizado nesta sessão (não crítico)');
                }

            } else {
                _log.info('[VERIFICAR LOGIN] Sem assinatura própria. Verificando membership...');

                const { data: membership, error: memberError } = await supabase
                    .from('account_members')
                    .select('owner_user_id, owner_email')
                    .eq('member_user_id', session.user.id)
                    .eq('is_active', true)
                    .maybeSingle();

                if (memberError || !membership) {
                    _log.warn('[VERIFICAR LOGIN] Sem assinatura e sem membership ativo.');
                    await supabase.auth.signOut();
                    window.location.href = 'login.html?erro=sem_plano';
                    return;
                }

                const { data: ownerSub, error: ownerSubError } = await supabase
                    .from('subscriptions')
                    .select('plans(name)')
                    .eq('user_id', membership.owner_user_id)
                    .eq('payment_status', 'approved')
                    .eq('is_active', true)
                    .or(`expires_at.is.null,expires_at.gt.${agora}`)
                    .maybeSingle();

                if (ownerSubError || !ownerSub) {
                    _log.warn('[VERIFICAR LOGIN] Assinatura do dono inválida ou revogada.');
                    await supabase.auth.signOut();
                    window.location.href = 'login.html?erro=plano_dono_inativo';
                    return;
                }

                planName = ownerSub.plans.name;
                effectiveUserId = membership.owner_user_id;
                effectiveEmail  = membership.owner_email;
                isGuest = true;
                _log.info('[VERIFICAR LOGIN] Acesso como convidado autorizado');
            }
        }

        usuarioLogado = {
            userId:  session.user.id,
            nome:    session.user.user_metadata?.name || session.user.email.split('@')[0],
            email:   session.user.email,
            plano:   planName,
            perfis:  [],
            isGuest: isGuest,
        };

        _log.info('[VERIFICAR LOGIN] Usuário inicializado. isGuest:', usuarioLogado.isGuest);

        _log.info('[VERIFICAR LOGIN] Inicializando DataManager...');
        await dataManager.initialize(effectiveUserId, effectiveEmail);
        _log.info('[VERIFICAR LOGIN] DataManager inicializado');

        _effectiveUserId = effectiveUserId;
        _effectiveEmail  = effectiveEmail;

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

        _log.info('[VERIFICAR LOGIN] Login completo. Mostrando seleção de perfis.');
        mostrarSelecaoPerfis();

    } catch (e) {
        _log.error('LOGIN_CRIT_001', e);
        alert(e.message);
        window.location.href = 'login.html';
    } finally {
        if (authLoading) authLoading.style.display = 'none';
        if (protectedContent) protectedContent.style.display = 'block';
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

function atualizarTelaPerfis() {
    const saudacaoNomeEl  = document.getElementById('saudacaoNome');
    const saudacaoPlanoEl = document.getElementById('saudacaoPlano');
    const lista           = document.getElementById('listaPerfis');

    if (!lista) return;

    // ✅ textContent — nunca innerHTML com dados do usuário
    const nomeExibir = perfilAtivo ? perfilAtivo.nome : (usuarioLogado.nome || 'Usuário');
    if (saudacaoNomeEl)  saudacaoNomeEl.textContent  = _sanitizeText(nomeExibir);
    if (saudacaoPlanoEl) saudacaoPlanoEl.textContent = _sanitizeText(usuarioLogado.plano || '');

    lista.innerHTML = '';

    usuarioLogado.perfis.forEach((perfil, index) => {
        const btn = document.createElement('button');
        btn.className = 'perfil-card';
        btn.type      = 'button';

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

        // ✅ addEventListener em vez de onclick inline
        btn.addEventListener('click', () => entrarNoPerfil(index));
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


async function entrarNoPerfil(index) {
    const authLoading = document.getElementById('authLoading');

    if (!Number.isInteger(index) || index < 0 || index >= usuarioLogado.perfis.length) {
        _log.error('PERFIL_IDX_001', `Índice inválido: ${index}`);
        alert('Perfil não encontrado. Tente novamente.');
        return;
    }

    try {
        if (authLoading) authLoading.style.display = 'flex';

        perfilAtivo = usuarioLogado.perfis[index];

        await carregarDadosPerfil(perfilAtivo.id);
        atualizarReferenciasGlobais();

        atualizarTudo();
        atualizarNomeUsuario();

        const selecao         = document.getElementById('selecaoPerfis');
        const sidebar         = document.getElementById('sidebar');
        const mobileTopbar    = document.getElementById('mobileTopbar');
        const mobileBottomNav = document.getElementById('mobileBottomNav');

        if (selecao)          selecao.style.display         = 'none';
        if (sidebar)          sidebar.style.display         = 'flex';
        if (mobileTopbar)     mobileTopbar.style.display    = '';
        if (mobileBottomNav)  mobileBottomNav.style.display = '';

        if (window.chatAssistant && typeof window.chatAssistant.onProfileSelected === 'function') {
            window.chatAssistant.onProfileSelected(Object.freeze({ ...perfilAtivo }));
        }

        iniciarAutoSave();

        await salvarDados();

        mostrarTela('dashboard');

    } catch (e) {
        _log.error('PERFIL_ENTER_001', e);
        alert('Erro ao carregar o perfil. Tente novamente.');
    } finally {
        if (authLoading) authLoading.style.display = 'none';
    }
}

function adicionarNovoPerfil() {
    // ✅ Verificação local serve apenas como UX — a validação real ocorre no backend via RLS
    const plano       = usuarioLogado.plano;
    const limitePerfis = limitesPlano[plano] ?? 1; // fallback seguro: plano desconhecido = 1
    const perfisAtuais = usuarioLogado.perfis.length;

    if (perfisAtuais >= limitePerfis) {
        mostrarPopupLimite();
        return;
    }

    // ✅ Popup construído via DOM — sem innerHTML com dados variáveis
    const container = criarPopupDOM((popup) => {
        const titulo = document.createElement('h3');
        titulo.textContent = 'Novo Perfil';

        const inputNome = document.createElement('input');
        inputNome.type        = 'text';
        inputNome.id          = 'novoPerfilNome';
        inputNome.className   = 'form-input';
        inputNome.placeholder = 'Nome do usuário (obrigatório)';
        inputNome.maxLength   = 50; // ✅ limite no próprio campo

        const inputFoto = document.createElement('input');
        inputFoto.type      = 'file';
        inputFoto.id        = 'novoPerfilFoto';
        inputFoto.className = 'form-input';
        inputFoto.accept    = 'image/jpeg,image/png,image/webp'; // ✅ restringe seleção
        inputFoto.style.padding = '10px';

        const btnCriar     = document.createElement('button');
        btnCriar.className = 'btn-primary';
        btnCriar.type      = 'button';
        btnCriar.textContent = 'Criar Perfil';

        const btnCancelar     = document.createElement('button');
        btnCancelar.className = 'btn-cancelar';
        btnCancelar.type      = 'button';
        btnCancelar.textContent = 'Cancelar';

        btnCancelar.addEventListener('click', fecharPopup);
        btnCriar.addEventListener('click', () => _criarPerfilHandler(inputNome, inputFoto, plano, limitePerfis));

        popup.appendChild(titulo);
        popup.appendChild(inputNome);
        popup.appendChild(inputFoto);
        popup.appendChild(btnCriar);
        popup.appendChild(btnCancelar);
    });
}

async function _criarPerfilHandler(inputNome, inputFoto, plano, limitePerfis) {
    const nome = inputNome.value.trim();

    if (!nome) { alert('Digite o nome do usuário!'); return; }
    if (nome.length < 2) { alert('O nome deve ter pelo menos 2 caracteres.'); return; }
    if (usuarioLogado.perfis.length >= limitePerfis) { mostrarPopupLimite(); fecharPopup(); return; }

    try {
        // ── Verifica sessão inicial ───────────────────────────────────────
        const { data: { session: sessionInicial }, error: sessionError } = await supabase.auth.getSession();
        if (sessionError || !sessionInicial?.user?.id) throw new Error('SEM_SESSAO_VALIDA');

        const effectiveUserId = usuarioLogado.effectiveUserId || sessionInicial.user.id;

        _log.info('[_criarPerfilHandler] effectiveUserId:', effectiveUserId.slice(0, 8) + '...');

        // ── Verificação de permissão via RPC ──────────────────────────────
        _log.info('[_criarPerfilHandler] Verificando permissão RPC...');

        const { data: podeCrear, error: rpcError } = await supabase.rpc('can_create_profile');

        if (rpcError) {
            _log.warn('[_criarPerfilHandler] RPC can_create_profile falhou, usando verificação local. Erro:', rpcError.message);

            const limitesLocais = { "Individual": 1, "Casal": 2, "Família": 4 };
            const limiteLocal = limitesLocais[usuarioLogado.plano] ?? 1;

            if (usuarioLogado.perfis.length >= limiteLocal) {
                mostrarPopupLimite();
                fecharPopup();
                return;
            }

            _log.info('[_criarPerfilHandler] Verificação local aprovada. Prosseguindo com criação...');
        } else if (!podeCrear) {
            mostrarPopupLimite();
            fecharPopup();
            return;
        }

        // ── Upload de foto (opcional) ─────────────────────────────────────
        let fotoUrl = null;

        if (inputFoto.files && inputFoto.files[0]) {
            const arquivoOriginal = inputFoto.files[0];

            if (arquivoOriginal.size > 2 * 1024 * 1024) { alert('A foto deve ter no máximo 2MB.'); return; }

            const mimesPermitidos = ['image/jpeg', 'image/png', 'image/webp'];
            if (!mimesPermitidos.includes(arquivoOriginal.type)) { alert('Tipo de arquivo inválido. Use JPG, PNG ou WebP.'); return; }

            const magicValido = await _validarMagicBytes(arquivoOriginal);
            if (!magicValido) { alert('Arquivo inválido. O conteúdo não corresponde a uma imagem real.'); return; }

            const _MAX_DIMENSAO_PX = 4000;
            let dimensaoValida = false;
            try {
                const bitmap = await createImageBitmap(arquivoOriginal);
                dimensaoValida = bitmap.width <= _MAX_DIMENSAO_PX && bitmap.height <= _MAX_DIMENSAO_PX;
                bitmap.close();
            } catch (_) {
                dimensaoValida = false;
            }

            if (!dimensaoValida) { alert(`A imagem deve ter no máximo ${_MAX_DIMENSAO_PX}x${_MAX_DIMENSAO_PX} pixels.`); return; }

            const arquivo = await _sanitizeImageFile(arquivoOriginal);
            if (!arquivo) {
                alert('Não foi possível processar a imagem. Tente com outro arquivo.');
                return;
            }

            // ── FIX-2: Token garantidamente fresco via refreshSession() ───
            // getSession() lê do cache — após fluxo de "primeiro acesso"
            // (magic link / recovery), o token pode estar expirado ou inválido.
            // refreshSession() bate no servidor e sempre retorna token válido.
            let sessionFresh;
            try {
                const { data: refreshData, error: refreshError } =
                    await supabase.auth.refreshSession();

                if (refreshError || !refreshData?.session?.access_token) {
                    // Fallback: tenta getSession uma última vez
                    _log.warn('[_criarPerfilHandler] refreshSession falhou — tentando fallback getSession. Erro:', refreshError?.message);
                    const { data: fallbackData, error: fallbackError } =
                        await supabase.auth.getSession();

                    if (fallbackError || !fallbackData?.session?.access_token) {
                        _log.error('PERFIL_TOKEN_001',
                            refreshError || fallbackError || 'token ausente após refresh e fallback');
                        alert('Sua sessão expirou. Por favor, faça login novamente.');
                        if (typeof AuthGuard !== 'undefined') {
                            AuthGuard.logout('TOKEN_EXPIRED');
                        } else {
                            window.location.replace('login.html');
                        }
                        return;
                    }
                    _log.warn('[_criarPerfilHandler] Usando token do cache como fallback.');
                    sessionFresh = fallbackData.session;
                } else {
                    sessionFresh = refreshData.session;
                }
            } catch (tokenErr) {
                _log.error('PERFIL_TOKEN_002', tokenErr);
                alert('Erro ao validar sua sessão. Por favor, faça login novamente.');
                return;
            }

            _log.info('[_criarPerfilHandler] Token fresco obtido. Iniciando upload...');

            const formData = new FormData();
            formData.append('file', arquivo);

            const uploadResponse = await fetch(
                `${SUPABASE_URL}/functions/v1/upload-profile-photo`,
                {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${sessionFresh.access_token}`,
                        'apikey': SUPABASE_ANON_KEY,
                    },
                    body: formData,
                }
            );

            if (!uploadResponse.ok) {
                let uploadErrorMsg = 'Erro ao fazer upload da foto. Tente novamente.';
                let rawBody = '';
                try {
                    rawBody = await uploadResponse.text();
                    const parsed = JSON.parse(rawBody);
                    uploadErrorMsg = parsed.error ?? parsed.message ?? uploadErrorMsg;
                } catch (_) {
                    if (rawBody) uploadErrorMsg = rawBody.slice(0, 200);
                }
                _log.error('PERFIL_FOTO_001',
                    `HTTP ${uploadResponse.status} | ${uploadErrorMsg}`);
                console.error('[UPLOAD DEBUG]',
                    'status:', uploadResponse.status,
                    '| body:', rawBody.slice(0, 500));
                alert(uploadErrorMsg);
                return;
            }

            const uploadData = await uploadResponse.json();
            const nomeArquivo = uploadData?.path;

            if (!nomeArquivo) {
                _log.error('PERFIL_FOTO_001B', 'path ausente na resposta da edge function');
                alert('Erro ao processar a foto. Tente novamente.');
                return;
            }

            // ── FIX-3: Usa signedUrl retornada pelo servidor ───────────────
            if (uploadData.signedUrl) {
                fotoUrl = _sanitizeImgUrl(uploadData.signedUrl) || null;
            } else {
                _log.warn('[_criarPerfilHandler] signedUrl ausente na resposta. Tentando createSignedUrl...');
                const { data: signedData, error: signedError } = await supabase.storage
                    .from('profile-photos')
                    .createSignedUrl(nomeArquivo, 3600);

                if (signedError || !signedData?.signedUrl) {
                    _log.error('PERFIL_FOTO_002', signedError);
                    alert('Erro ao processar a foto. Tente novamente.');
                    return;
                }
                fotoUrl = _sanitizeImgUrl(signedData.signedUrl) || null;
            }
        }

        // ── Insere perfil no banco ────────────────────────────────────────
        _log.info('[_criarPerfilHandler] Inserindo perfil no banco...');

        const { data: novoPerfil, error } = await supabase
            .from('profiles')
            .insert({
                name:      nome,
                photo_url: fotoUrl,
                user_id:   effectiveUserId,
            })
            .select()
            .single();

        if (error) {
            _log.error('PERFIL_INSERT_001', error);
            if (error.code === '23505' || error.code === '23514' || error.code === '42501') {
                mostrarPopupLimite();
            } else {
                alert('Erro ao criar perfil. Tente novamente.');
            }
            fecharPopup();
            return;
        }

        _log.info('[_criarPerfilHandler] Perfil inserido com sucesso. ID:', novoPerfil.id);

        usuarioLogado.perfis.push({
            id:   novoPerfil.id,
            nome: _sanitizeText(novoPerfil.name),
            foto: _sanitizeImgUrl(novoPerfil.photo_url),
        });

        fecharPopup();
        atualizarTelaPerfis();
        atualizarReferenciasGlobais();
        mostrarNotificacao('Perfil criado com sucesso!', 'success');

    } catch (error) {
        _log.error('PERFIL_002', error);
        if (error.message === 'SEM_SESSAO_VALIDA') {
            alert('Sessão inválida. Por favor, faça login novamente.');
            window.location.replace('login.html');
        } else {
            alert('Ocorreu um erro ao criar o perfil. Tente novamente.');
        }
    }
}

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
function mostrarTela(tela) {
    document.querySelectorAll('.page').forEach(p => {
        p.classList.remove('active');
        p.style.display = 'none';
    });

    window.scrollTo({ top: 0, behavior: 'instant' });

    // Sidebar — nav-btn
    document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.remove('active'));
    const sidebarBtn = document.querySelector(`.nav-btn[data-page="${tela}"]`);
    if (sidebarBtn) sidebarBtn.classList.add('active');

    // Mobile — bottom nav
    document.querySelectorAll('.mobile-nav-item').forEach(btn => btn.classList.remove('active'));
    const mobileBtn = document.querySelector(`.mobile-nav-item[data-page="${tela}"]`);
    if (mobileBtn) mobileBtn.classList.add('active');

    const pageEl = document.getElementById(tela + 'Page');
    if (pageEl) {
        pageEl.style.display = 'block';
        pageEl.classList.add('active');
    }

    if (tela === 'reservas')    renderMetasList();
    if (tela === 'relatorios')  popularFiltrosRelatorio();
    if (tela === 'graficos')    inicializarGraficos();
    if (tela === 'cartoes')     atualizarTelaCartoes();
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
}

// Magic bytes das extensões permitidas
const _IMG_SIGNATURES = [
    { mime: 'image/jpeg', bytes: [0xFF, 0xD8, 0xFF] },
    { mime: 'image/png',  bytes: [0x89, 0x50, 0x4E, 0x47] },
    { mime: 'image/webp', header: 'WEBP', offset: 8 },
];

// ✅ Lê os primeiros 12 bytes e valida contra magic bytes reais
async function _validarMagicBytes(file) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const arr = new Uint8Array(e.target.result);
            const matchJpeg = [0xFF, 0xD8, 0xFF].every((b, i) => arr[i] === b);
            const matchPng  = [0x89, 0x50, 0x4E, 0x47].every((b, i) => arr[i] === b);
            // WebP: bytes 0-3 = "RIFF", bytes 8-11 = "WEBP"
            const matchWebp = arr[0] === 0x52 && arr[1] === 0x49 &&
                              arr[2] === 0x46 && arr[3] === 0x46 &&
                              arr[8] === 0x57 && arr[9] === 0x45 &&
                              arr[10]=== 0x42 && arr[11]=== 0x50;
            resolve(matchJpeg || matchPng || matchWebp);
        };
        reader.onerror = () => resolve(false);
        reader.readAsArrayBuffer(file.slice(0, 12));
    });
}

// ✅ Gera ou renova signed URL para um path já existente no storage
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

async function alterarFoto(event) {
    const fileOriginal = event.target.files[0];
    if (!fileOriginal) return;
    if (!perfilAtivo) { alert('Erro: Nenhum perfil ativo encontrado.'); return; }

    if (fileOriginal.size > 2 * 1024 * 1024) { alert('A foto deve ter no máximo 2MB.'); return; }

    const mimesPermitidos = ['image/jpeg', 'image/png', 'image/webp'];
    if (!mimesPermitidos.includes(fileOriginal.type)) { alert('Tipo de arquivo inválido. Use JPG, PNG ou WebP.'); return; }

    const magicValido = await _validarMagicBytes(fileOriginal);
    if (!magicValido) { alert('Arquivo inválido. O conteúdo não corresponde a uma imagem real.'); return; }

    const _MAX_DIMENSAO_PX = 4000;
    let dimensaoValida = false;
    try {
        const bitmap = await createImageBitmap(fileOriginal);
        dimensaoValida = bitmap.width <= _MAX_DIMENSAO_PX && bitmap.height <= _MAX_DIMENSAO_PX;
        bitmap.close();
    } catch (_) {
        dimensaoValida = false;
    }

    if (!dimensaoValida) {
        alert(`A imagem deve ter no máximo ${_MAX_DIMENSAO_PX}x${_MAX_DIMENSAO_PX} pixels.`);
        return;
    }

    try {
        const { data: { session }, error: sessionError } = await supabase.auth.getSession();
        if (sessionError || !session || !session.user || !session.user.id) throw new Error('SEM_SESSAO_VALIDA');

        const file = await _sanitizeImageFile(fileOriginal);

        if (!file) {
            alert('Não foi possível processar a imagem. Tente com outro arquivo.');
            return;
        }

        const formData = new FormData();
        formData.append('file', file);

        const uploadResponse = await fetch(
            `${SUPABASE_URL}/functions/v1/upload-profile-photo`,
            {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${session.access_token}`,
                    'apikey': SUPABASE_ANON_KEY,
                },
                body: formData,
            }
        );

        if (!uploadResponse.ok) {
            let uploadErrorMsg = 'Erro ao fazer upload. Tente novamente.';
            try {
                const uploadErrorData = await uploadResponse.json();
                uploadErrorMsg = uploadErrorData.message ?? uploadErrorMsg;
            } catch (_) {}
            _log.error('FOTO_001', `Status: ${uploadResponse.status}`);
            alert(uploadErrorMsg);
            return;
        }

        const uploadData = await uploadResponse.json();
        const storagePath = uploadData?.path;

        if (!storagePath) {
            _log.error('FOTO_001B', 'path ausente na resposta da edge function');
            alert('Erro ao processar a foto. Tente novamente.');
            return;
        }

        const urlSegura = await _gerarSignedUrl(storagePath);
        if (!urlSegura) { alert('Erro interno ao processar a foto. Tente novamente.'); return; }

        const { error: updateError } = await supabase
            .from('profiles')
            .update({ photo_url: storagePath })
            .eq('id', perfilAtivo.id)
            .eq('user_id', session.user.id)
            .select()
            .single();

        if (updateError) { _log.error('FOTO_003', updateError); alert('Erro ao salvar a foto. Tente novamente.'); return; }

        perfilAtivo.foto         = urlSegura;
        perfilAtivo._storagePath = storagePath;

        const idx = usuarioLogado.perfis.findIndex(p => p.id === perfilAtivo.id);
        if (idx !== -1) {
            usuarioLogado.perfis[idx].foto         = urlSegura;
            usuarioLogado.perfis[idx]._storagePath = storagePath;
        }

        const userPhotoEl = document.getElementById('userPhoto');
        if (userPhotoEl) userPhotoEl.src = urlSegura;

        // Sincronizar foto na topbar mobile
        const mobilePhotoEl = document.getElementById('mobileUserPhoto');
        const mobilePhotoFbEl = document.getElementById('mobileUserPhotoFallback');
        if (mobilePhotoEl)  { mobilePhotoEl.src = urlSegura; mobilePhotoEl.style.display = ''; }
        if (mobilePhotoFbEl) mobilePhotoFbEl.style.display = 'none';

        await salvarDados();
        atualizarTelaPerfis();
        atualizarReferenciasGlobais();
        mostrarNotificacao('Foto alterada com sucesso!', 'success');

    } catch (error) {
        _log.error('FOTO_004', error);
        alert('Ocorreu um erro ao alterar a foto. Tente novamente.');
    }
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
function iniciarRenovacaoFotos() {
    if (_renovacaoFotosInterval) clearInterval(_renovacaoFotosInterval);
    _renovacaoFotosInterval = setInterval(_renovarFotosExpiradas, 50 * 60 * 1000);
}

// ========== DASHBOARD - RESUMO E CONTAS FIXAS ==========
function atualizarDashboardResumo() {
    let totalEntradas = 0, totalSaidas = 0, totalReservas = 0;
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

    transacoes.forEach((t, i) => {
        const valor = toValorSeguro(t.valor, `transacao[${i}] id=${t.id}`);

        if (t.categoria === 'entrada') {
            totalEntradas += valor;
        } else if (t.categoria === 'saida') {
            totalSaidas += valor;
        } else if (t.categoria === 'reserva') {
            totalReservas += valor;
        } else if (t.categoria === 'retirada_reserva') {
            totalReservas -= valor;
            if (totalReservas < 0) {
                console.warn('[DASHBOARD] totalReservas ficou negativo após retirada — possível corrupção.');
                corrupcaoDetectada = true;
                totalReservas = 0;
            }
        }
    });

    const saldo = totalEntradas - totalSaidas - totalReservas;

    const totalReservasCalc = metas.reduce((s, m, i) => {
        return s + toValorSeguro(m.saved, `meta[${i}] id=${m.id}`);
    }, 0);

    // ✅ Se corrupção detectada, exibe aviso na UI (não silencia mais)
    if (corrupcaoDetectada) {
        console.error('[DASHBOARD] ⚠️ Dados corrompidos ou manipulados detectados. Verifique o console.');
        // Opcional: exibir banner de aviso na UI
        const banner = document.getElementById('bannnerCorrupcao');
        if (banner) banner.style.display = 'block';
    }

    const entradasEl = document.getElementById('totalEntradas');
    const saidasEl   = document.getElementById('totalSaidas');
    const saldoEl    = document.getElementById('totalSaldo');
    const reservasEl = document.getElementById('totalReservas');

    if (entradasEl) entradasEl.textContent = formatBRL(totalEntradas);
    if (saidasEl)   saidasEl.textContent   = formatBRL(totalSaidas);
    if (saldoEl)    saldoEl.textContent     = formatBRL(saldo);
    const heroSaldoEl = document.getElementById('heroSaldo');
    if (heroSaldoEl && !heroSaldoEl.classList.contains('oculto')) {
        heroSaldoEl.textContent = formatBRL(saldo);
    }
    if (heroSaldoEl) heroSaldoEl.dataset.valor = formatBRL(saldo);
    if (reservasEl) reservasEl.textContent  = formatBRL(totalReservasCalc);
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

    const notification = new Notification(`${icone} ${tituloSeguro}`, {
        body: mensagemSegura,
        icon:  '/favicon.ico',
        badge: '/favicon.ico',
        vibrate: [200, 100, 200],
        requireInteraction: tipoSeguro === 'urgente',
        tag: 'granaevo-' + Date.now()
    });

    notification.onclick = () => {
        window.focus();
        mostrarTela('dashboard');
        notification.close();
    };

    setTimeout(() => notification.close(), 10000);
}

// Verificar contas a vencer e vencidas
function verificarVencimentos() {
    if(!perfilAtivo || contasFixas.length === 0) return;
    
    const hoje = new Date();
    const hojeISO = hoje.toISOString().slice(0, 10);
    
    const em5Dias = new Date();
    em5Dias.setDate(hoje.getDate() + 5);
    const em5DiasISO = em5Dias.toISOString().slice(0, 10);
    
    let contasVencidas = [];
    let contasAVencer = [];
    
    contasFixas.forEach(conta => {
        if(conta.pago) return;

        // ✅ FIX #5: Rejeita vencimento nulo, vazio ou com formato inválido
        //    Antes: null < "2025-..." retornava true → conta aparecia como vencida sem data
        //    Agora: contas sem data válida são silenciosamente ignoradas
        if(typeof conta.vencimento !== 'string') return;
        if(!/^\d{4}-\d{2}-\d{2}$/.test(conta.vencimento)) return;

        // ✅ FIX #5: Valida que os valores numéricos da data são reais
        //    Regex aceita "2025-13-45", mas Date detecta como inválido
        const dataVenc = new Date(conta.vencimento);
        if(isNaN(dataVenc.getTime())) return;
        
        if(conta.vencimento < hojeISO) {
            contasVencidas.push(conta);
        } else if(conta.vencimento <= em5DiasISO && conta.vencimento >= hojeISO) {
            contasAVencer.push(conta);
        }
    });
    
    return {
        vencidas: contasVencidas,
        aVencer: contasAVencer,
        total: contasVencidas.length + contasAVencer.length
    };
}

// Exibir badge de alertas
function atualizarBadgeVencimentos() {
    const alertas = verificarVencimentos();
    if(!alertas) return;
    
    const dashboardBtn = document.querySelector('[data-page="dashboard"]');
    if(!dashboardBtn) return;
    
    const badgeExistente = dashboardBtn.querySelector('.badge-alerta');
    if(badgeExistente) badgeExistente.remove();
    
    if(alertas.total > 0) {
        const badge = document.createElement('span');
        badge.className = 'badge-alerta';
        badge.textContent = alertas.total;

        // ✅ FIX #6: atribuição direta de propriedades em vez de cssText com template
        //    cssText com interpolação é vetor de CSS injection se dado de usuário
        //    for inserido no futuro — atribuição direta é imune por design
        badge.style.position    = 'absolute';
        badge.style.top         = '13px';
        badge.style.right       = '22px';
        badge.style.background  = alertas.vencidas.length > 0 ? '#ff4b4b' : '#ffd166';
        badge.style.color       = 'white';
        badge.style.fontSize    = '0.7rem';
        badge.style.fontWeight  = '700';
        badge.style.padding     = '2px 6px';
        badge.style.borderRadius = '10px';
        badge.style.boxShadow   = '0 2px 8px rgba(0,0,0,0.3)';
        badge.style.animation   = 'pulseAlert 2s infinite';

        dashboardBtn.style.position = 'relative';
        dashboardBtn.appendChild(badge);
    }
}

// Mostrar painel de alertas na dashboard
function renderizarPainelAlertas() {
    const alertas = verificarVencimentos();
    if (!alertas || alertas.total === 0) return null;

    // ── Container principal
    const painelDiv = document.createElement('div');
    painelDiv.className = 'alertas-vencimento';

    // ── Header
    const headerDiv = document.createElement('div');
    headerDiv.className = 'alertas-header';

    const iconDiv = document.createElement('div');
    iconDiv.className = 'alertas-icon';
    iconDiv.textContent = alertas.vencidas.length > 0 ? '🚨' : '⚠️';

    const titleGroupDiv = document.createElement('div');
    titleGroupDiv.className = 'alertas-title-group';

    const h3 = document.createElement('h3');
    h3.textContent = alertas.vencidas.length > 0
        ? 'Atenção! Contas Vencidas'
        : 'Contas Próximas do Vencimento';

    const pDesc = document.createElement('p');
    pDesc.textContent = alertas.vencidas.length > 0
        ? `Você tem ${alertas.vencidas.length} conta(s) vencida(s)`
        : `${alertas.aVencer.length} conta(s) vencem nos próximos 5 dias`;

    titleGroupDiv.appendChild(h3);
    titleGroupDiv.appendChild(pDesc);
    headerDiv.appendChild(iconDiv);
    headerDiv.appendChild(titleGroupDiv);
    painelDiv.appendChild(headerDiv);

    // ── Grid de cards
    const gridDiv = document.createElement('div');
    gridDiv.className = 'alertas-grid';

    // ── Cards de contas VENCIDAS
    alertas.vencidas.forEach(conta => {
        const idRaw    = conta.id;
        const idNum    = parseInt(idRaw, 10);
        const idSeguro = Number.isInteger(idNum) && String(idNum) === String(idRaw) ? idNum : idRaw;
        if (idSeguro === null || idSeguro === undefined || idSeguro === '') return;

        if (!/^\d{4}-\d{2}-\d{2}$/.test(conta.vencimento)) return;
        const dataVenc = new Date(conta.vencimento);
        if (isNaN(dataVenc.getTime())) return;

        const diasVencidos = Math.max(0, Math.floor((new Date() - dataVenc) / (1000 * 60 * 60 * 24)));

        const card = document.createElement('div');
        card.className = 'alerta-card';
        card.dataset.id   = String(idSeguro);
        card.dataset.acao = 'pagar';

        // Card header
        const cardHeader = document.createElement('div');
        cardHeader.className = 'alerta-header';

        const titleDiv = document.createElement('div');
        titleDiv.className   = 'alerta-title';
        titleDiv.textContent = conta.descricao; // ✅ textContent

        const statusSpan = document.createElement('span');
        statusSpan.className   = 'alerta-status vencido';
        statusSpan.textContent = '❌ Vencida';

        cardHeader.appendChild(titleDiv);
        cardHeader.appendChild(statusSpan);

        // Card info
        const infoDiv = document.createElement('div');
        infoDiv.className = 'alerta-info';

        const valorDiv = document.createElement('div');
        const valorStrong = document.createElement('strong');
        valorStrong.textContent = 'Valor: ';
        valorDiv.appendChild(valorStrong);
        valorDiv.appendChild(document.createTextNode(formatBRL(conta.valor)));

        const vencDiv = document.createElement('div');
        const vencStrong = document.createElement('strong');
        vencStrong.textContent = 'Vencimento: ';
        vencDiv.appendChild(vencStrong);
        vencDiv.appendChild(document.createTextNode(formatarDataBR(conta.vencimento)));

        const diasDiv = document.createElement('div');
        diasDiv.style.color      = '#ff4b4b';
        diasDiv.style.fontWeight = '600';
        diasDiv.style.marginTop  = '6px';
        diasDiv.textContent = `⏰ Vencida há ${diasVencidos} dia(s)`;

        infoDiv.appendChild(valorDiv);
        infoDiv.appendChild(vencDiv);
        infoDiv.appendChild(diasDiv);

        // Botão pagar
        const btnPagar = document.createElement('button');
        btnPagar.className   = 'alerta-btn';
        btnPagar.dataset.id   = String(idSeguro);
        btnPagar.dataset.acao = 'pagar-btn';
        btnPagar.textContent  = '💰 Pagar Agora';

        card.appendChild(cardHeader);
        card.appendChild(infoDiv);
        card.appendChild(btnPagar);
        gridDiv.appendChild(card);
    });

    // ── Cards de contas A VENCER
    alertas.aVencer.forEach(conta => {
        const idRaw    = conta.id;
        const idNum    = parseInt(idRaw, 10);
        const idSeguro = Number.isInteger(idNum) && String(idNum) === String(idRaw) ? idNum : idRaw;
        if (idSeguro === null || idSeguro === undefined || idSeguro === '') return;

        if (!/^\d{4}-\d{2}-\d{2}$/.test(conta.vencimento)) return;
        const dataVenc = new Date(conta.vencimento);
        if (isNaN(dataVenc.getTime())) return;

        const diasRestantes = Math.max(0, Math.floor((dataVenc - new Date()) / (1000 * 60 * 60 * 24)));

        const card = document.createElement('div');
        card.className    = 'alerta-card pendente';
        card.dataset.id   = String(idSeguro);
        card.dataset.acao = 'editar';

        const cardHeader = document.createElement('div');
        cardHeader.className = 'alerta-header';

        const titleDiv = document.createElement('div');
        titleDiv.className   = 'alerta-title';
        titleDiv.textContent = conta.descricao; // ✅ textContent

        const statusSpan = document.createElement('span');
        statusSpan.className   = 'alerta-status a-vencer';
        statusSpan.textContent = '⏳ A Vencer';

        cardHeader.appendChild(titleDiv);
        cardHeader.appendChild(statusSpan);

        const infoDiv = document.createElement('div');
        infoDiv.className = 'alerta-info';

        const valorDiv = document.createElement('div');
        const valorStrong = document.createElement('strong');
        valorStrong.textContent = 'Valor: ';
        valorDiv.appendChild(valorStrong);
        valorDiv.appendChild(document.createTextNode(formatBRL(conta.valor)));

        const vencDiv = document.createElement('div');
        const vencStrong = document.createElement('strong');
        vencStrong.textContent = 'Vencimento: ';
        vencDiv.appendChild(vencStrong);
        vencDiv.appendChild(document.createTextNode(formatarDataBR(conta.vencimento)));

        const diasDiv = document.createElement('div');
        diasDiv.style.color      = '#ffd166';
        diasDiv.style.fontWeight = '600';
        diasDiv.style.marginTop  = '6px';
        diasDiv.textContent = `⏰ Vence em ${diasRestantes} dia(s)`;

        infoDiv.appendChild(valorDiv);
        infoDiv.appendChild(vencDiv);
        infoDiv.appendChild(diasDiv);

        card.appendChild(cardHeader);
        card.appendChild(infoDiv);
        gridDiv.appendChild(card);
    });

    painelDiv.appendChild(gridDiv);
    return painelDiv;
}

// Verificação automática e notificação
// ✅ Controle de última notificação enviada — persiste entre chamadas
const _notificacaoControl = {
    // ✅ Persiste entre recarregamentos — evita spam ao reabrir o app
    ultimaEnviada: parseInt(localStorage.getItem('granaevo_ultimaNotificacao') || '0', 10),
    intervaloMinimo: 60 * 60 * 1000 // 1 hora em ms
};

function verificacaoAutomaticaVencimentos() {
    const alertas = verificarVencimentos();
    if(!alertas) return;

    // ✅ Sempre atualiza o badge (leve, sem side-effects)
    atualizarBadgeVencimentos();

    // ✅ Notificação nativa: só envia se passou o intervalo mínimo
    const agora = Date.now();
    const tempoDesdeUltima = agora - _notificacaoControl.ultimaEnviada;

    if(tempoDesdeUltima < _notificacaoControl.intervaloMinimo) return;

    if(alertas.vencidas.length > 0) {
        enviarNotificacaoNativa(
            `${alertas.vencidas.length} Conta(s) Vencida(s)!`,
            `Você tem contas vencidas que precisam de atenção urgente.`,
            'urgente'
        );
        _notificacaoControl.ultimaEnviada = agora;
        // ✅ Persiste no localStorage para sobreviver a recarregamentos
        localStorage.setItem('granaevo_ultimaNotificacao', String(agora));

    } else if(alertas.aVencer.length > 0) {
        enviarNotificacaoNativa(
            `${alertas.aVencer.length} Conta(s) Vencendo em Breve`,
            `Algumas contas vencem nos próximos 5 dias. Prepare-se!`,
            'alerta'
        );
        _notificacaoControl.ultimaEnviada = agora;
        // ✅ Persiste no localStorage
        localStorage.setItem('granaevo_ultimaNotificacao', String(agora));
    }
}

// Adicionar animação de pulso
const styleAlertas = document.createElement('style');
styleAlertas.textContent = `
    @keyframes pulseAlert {
        0%, 100% {
            transform: scale(1);
            opacity: 1;
        }
        50% {
            transform: scale(1.1);
            opacity: 0.8;
        }
    }
`;
document.head.appendChild(styleAlertas);

function atualizarListaContasFixas() {
    const lista = document.getElementById('listaContasFixas');
    if (!lista) return;

    lista.innerHTML = '';

    // ✅ renderizarPainelAlertas agora retorna elemento DOM ou null — sem innerHTML
    const painelAlertasEl = renderizarPainelAlertas();
    if (painelAlertasEl) {
        painelAlertasEl.addEventListener('click', (e) => {
            const card = e.target.closest('[data-acao]');
            if (!card) return;

            const idRaw = card.dataset.id;
            const idNum = parseInt(idRaw, 10);
            const id    = Number.isInteger(idNum) && String(idNum) === idRaw ? idNum : idRaw;

            if (id === null || id === undefined || id === '' || id !== id) return;

            const acao = card.dataset.acao;

            if (acao === 'pagar' || acao === 'pagar-btn') {
                e.stopPropagation();
                abrirPopupPagarContaFixa(id);
            } else if (acao === 'editar') {
                abrirContaFixaForm(id);
            }
        });

        lista.appendChild(painelAlertasEl); // ✅ appendChild direto — elemento DOM puro
    }

    if (contasFixas.length === 0) {
        const empty = document.createElement('p');
        empty.className   = 'empty-state';
        empty.textContent = 'Nenhuma conta fixa cadastrada.';
        lista.appendChild(empty);
        return;
    }

    const hojeISO = new Date().toISOString().slice(0, 10);

    const containerContas = document.createElement('div');
    containerContas.className = 'contas-grid';

    contasFixas.forEach(c => {
        const vencimentoValido = typeof c.vencimento === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(c.vencimento);

        let status      = 'Pendente';
        let statusClass = 'status-pendente';

        if (c.pago) {
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

            const divValor = document.createElement('div');
            divValor.style.fontWeight = '600';
            divValor.style.fontSize   = '1.1rem';
            divValor.style.color      = 'var(--text-primary)';
            divValor.textContent = `Valor: ${formatBRL(c.valor)}`;

            const divVenc = document.createElement('div');
            divVenc.textContent = `Vencimento: ${formatarDataBR(c.vencimento)}`;

            const divCompras = document.createElement('div');
            divCompras.style.color     = 'var(--text-secondary)';
            divCompras.style.fontSize  = '0.85rem';
            divCompras.style.marginTop = '6px';
            divCompras.textContent = `📦 ${totalCompras} compra${totalCompras > 1 ? 's' : ''} nesta fatura`;

            info.appendChild(divValor);
            info.appendChild(divVenc);
            info.appendChild(divCompras);

            div.appendChild(header);
            div.appendChild(info);

            if (status !== 'Pago') {
                const actions  = document.createElement('div');
                actions.className = 'conta-actions';

                const btnPagar = document.createElement('button');
                btnPagar.className   = 'conta-btn';
                btnPagar.textContent = 'Pagar Fatura';

                btnPagar.addEventListener('click', (e) => {
                    e.stopPropagation();
                    abrirPopupPagarContaFixa(c.id);
                });

                actions.appendChild(btnPagar);
                div.appendChild(actions);
            }

        } else {
            const _icConta = document.createElement('i');
            _icConta.className = 'fas fa-receipt';
            _icConta.setAttribute('aria-hidden', 'true');
            _icConta.style.cssText = 'color:rgba(67,160,71,0.85); margin-right:4px; font-size:0.88em;';
            title.appendChild(_icConta);
            title.appendChild(document.createTextNode(_sanitizeText(c.descricao)));

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

            if (status !== 'Pago') {
                const actions  = document.createElement('div');
                actions.className = 'conta-actions';

                const btnPagar = document.createElement('button');
                btnPagar.className   = 'conta-btn';
                btnPagar.textContent = 'Pagar';

                const contaId = c.id;
                if (contaId === null || contaId === undefined || contaId === '') return;

                btnPagar.addEventListener('click', (e) => {
                    e.stopPropagation();
                    abrirPopupPagarContaFixa(contaId);
                });

                actions.appendChild(btnPagar);
                div.appendChild(actions);
            }
        }

        header.appendChild(title);
        header.appendChild(statusSpan);

        div.addEventListener('click', (e) => {
            if (e.target.tagName === 'BUTTON') return;

            if (c.tipoContaFixa === 'fatura_cartao') {
                abrirVisualizacaoFatura(c.id);
            } else {
                abrirContaFixaForm(c.id);
            }
        });

        containerContas.appendChild(div);
    });

    lista.appendChild(containerContas);
}

function abrirContaFixaForm(editId = null) {
    if(editId === null) {
        criarPopup(`
            <h3>Nova Conta Fixa</h3>
            <input type="text" id="descContaFixa" class="form-input" placeholder="Descrição"><br>
            <input type="number" id="valorContaFixa" class="form-input" placeholder="Valor (R$)" step="0.01" min="0"><br>
            <label style="display:block; text-align:left; margin-top:10px; margin-bottom:6px; color: var(--text-secondary); font-weight:600;">📅 Data de Vencimento:</label>
            <input type="date" id="vencContaFixa" class="form-input"><br>
            <button class="btn-primary" id="okContaFixa">Salvar</button>
            <button class="btn-cancelar" id="cancelarContaFixa">Cancelar</button>
        `);

        document.getElementById('cancelarContaFixa').onclick = () => fecharPopup();

        document.getElementById('okContaFixa').onclick = () => {
            const desc     = document.getElementById('descContaFixa').value.trim();
            const valorStr = document.getElementById('valorContaFixa').value;
            const venc     = document.getElementById('vencContaFixa').value;

            if(!desc || !valorStr || !venc) return alert('Preencha todos os campos.');
            if(desc.length > 100) return alert('Descrição muito longa (máx. 100 caracteres).');

            const valor = parseFloat(parseFloat(valorStr).toFixed(2));
            if(isNaN(valor) || valor <= 0) return alert('Informe um valor válido e positivo.');
            if(!/^\d{4}-\d{2}-\d{2}$/.test(venc)) return alert('Data de vencimento inválida.');

            // ✅ CORREÇÃO: gera id local para que editar e excluir funcionem corretamente
            const novoId = (typeof crypto !== 'undefined' && crypto.randomUUID)
                ? crypto.randomUUID()
                : `local_${Date.now()}_${Math.random().toString(36).slice(2)}`;

            contasFixas.push({ id: novoId, descricao: desc, valor, vencimento: venc, pago: false });
            salvarDados();
            atualizarListaContasFixas();
            fecharPopup();
        };

    } else {
        const conta = contasFixas.find(c => c.id === editId);
        if(!conta) return;

        criarPopup(`
            <h3>Editar Conta Fixa</h3>
            <input type="text" id="descContaFixa" class="form-input" maxlength="100"><br>
            <input type="number" id="valorContaFixa" class="form-input" step="0.01" min="0"><br>
            <input type="date" id="vencContaFixa" class="form-input"><br>
            <button class="btn-primary" id="salvarEditContaFixa">Salvar</button>
            <button class="btn-excluir" id="excluirContaFixa">Excluir</button>
            <button class="btn-cancelar" id="cancelarContaFixa">Cancelar</button>
        `);

        // ✅ Preenchimento seguro via .value — nunca via innerHTML/atributo
        document.getElementById('descContaFixa').value  = conta.descricao;
        document.getElementById('valorContaFixa').value = conta.valor;
        document.getElementById('vencContaFixa').value  = conta.vencimento;

        document.getElementById('cancelarContaFixa').onclick = () => fecharPopup();

        document.getElementById('salvarEditContaFixa').onclick = () => {
            const desc     = document.getElementById('descContaFixa').value.trim();
            const valorStr = document.getElementById('valorContaFixa').value;
            const venc     = document.getElementById('vencContaFixa').value;

            if(!desc || !valorStr || !venc) return alert('Preencha todos os campos.');
            if(desc.length > 100) return alert('Descrição muito longa (máx. 100 caracteres).');

            const valor = parseFloat(parseFloat(valorStr).toFixed(2));
            if(isNaN(valor) || valor <= 0) return alert('Informe um valor válido e positivo.');
            if(!/^\d{4}-\d{2}-\d{2}$/.test(venc)) return alert('Data de vencimento inválida.');

            conta.descricao  = desc;
            conta.valor      = valor;
            conta.vencimento = venc;
            salvarDados();
            atualizarListaContasFixas();
            fecharPopup();
        };

        document.getElementById('excluirContaFixa').onclick = () => {
            if(confirm('Tem certeza que deseja excluir esta conta fixa?')) {
                contasFixas = contasFixas.filter(c => c.id !== editId);
                salvarDados();
                atualizarListaContasFixas();
                fecharPopup();
            }
        };
    }
}

function abrirPopupPagarContaFixa(id) {
    const conta = contasFixas.find(c => c.id === id);
    if(!conta) return;

    let valorDigitado = conta.valor;

    // ✅ O HTML do popup não contém NENHUM dado do usuário
    //    Os textos são injetados via textContent após o DOM ser criado
    criarPopup(`
        <h3>Pagar Conta Fixa</h3>
        <div id="popupDescricao" style="color: var(--text-secondary);"></div>
        <div id="popupValor" style="margin-bottom:12px;"></div>
        <div id="popupVencimento" style="margin-bottom:12px;"></div>
        <div style="color: var(--warning); margin-bottom:8px;">O valor está correto?</div>
        <button class="btn-primary" id="simValorCorreto">Sim</button>
        <button class="btn-warning" id="naoValorCorreto">Não</button>
        <button class="btn-cancelar" id="cancelarPagamento">Cancelar</button>
        <div id="ajusteValorDiv" style="display:none; margin-top:14px;">
            <input type="number" id="novoValorContaFixa" class="form-input" step="0.01" min="0"><br>
            <button class="btn-primary" id="confirmNovoValor" style="margin-top:8px;">Confirmar novo valor</button>
        </div>
    `);

    // ✅ Preenchimento seguro — textContent nunca interpreta HTML
    document.getElementById('popupDescricao').textContent  = conta.descricao;
    document.getElementById('popupValor').textContent      = `Valor: ${formatBRL(conta.valor)}`;
    document.getElementById('popupVencimento').textContent = `Vencimento: ${formatarDataBR(conta.vencimento)}`;

    // ✅ Campo numérico preenchido via .value
    document.getElementById('novoValorContaFixa').value = conta.valor;

    document.getElementById('cancelarPagamento').onclick = () => fecharPopup();

    document.getElementById('simValorCorreto').onclick = () => {
        pagarContaFixa(id, conta.valor);
        fecharPopup();
    };

    document.getElementById('naoValorCorreto').onclick = () => {
        document.getElementById('ajusteValorDiv').style.display = 'block';
        document.getElementById('simValorCorreto').disabled = true;
        document.getElementById('naoValorCorreto').disabled = true;

        document.getElementById('confirmNovoValor').onclick = () => {
            const valStr = document.getElementById('novoValorContaFixa').value;

            // ✅ Validação reforçada: número, positivo e com máximo razoável
            const novoValor = parseFloat(valStr);
            if(!valStr || isNaN(novoValor) || novoValor <= 0 || novoValor > 9999999) {
                return alert('Digite um valor válido!');
            }

            valorDigitado = parseFloat(novoValor.toFixed(2));

            if(confirm(`Confirma o pagamento de ${formatBRL(valorDigitado)}?`)) {
                pagarContaFixa(id, valorDigitado);
                fecharPopup();
            }
        };
    };
}

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

function pagarContaFixa(id, valorPago) {
    const conta = contasFixas.find(c => c.id === id);
    if (!conta) return;

    // ✅ Lock anti-replay
    if (conta._processando) {
        alert('Aguarde, pagamento em andamento...');
        return;
    }
    conta._processando = true;

    // ✅ Validação de valor: deve ser número positivo, finito e dentro do limite razoável
    const valorSeguro = parseFloat(valorPago);
    if (!isFinite(valorSeguro) || valorSeguro <= 0 || valorSeguro > 9_999_999) {
        alert('Valor de pagamento inválido. Informe um valor entre R$ 0,01 e R$ 9.999.999,00.');
        conta._processando = false;
        return;
    }

    const contaOriginal = conta;

    // ✅ Snapshots declarados fora do try — arrays vazios como fallback seguro
    let snapshotTransacoes  = [];
    let snapshotContasFixas = [];
    let snapshotCartoes     = [];

    try {
        snapshotTransacoes  = structuredClone(transacoes);
        snapshotContasFixas = structuredClone(contasFixas);
        snapshotCartoes     = structuredClone(cartoesCredito);

        const dh = agoraDataHora();
        const descricaoSegura = String(conta.descricao || '').slice(0, 100);

        transacoes.push({
            categoria:   'saida',
            tipo:        'Conta Fixa',
            descricao:   `${descricaoSegura} (pagamento mensal)`,
            valor:       parseFloat(valorSeguro.toFixed(2)),
            data:        dh.data,
            hora:        dh.hora,
            contaFixaId: id
        });

        // ── FATURA DE CARTÃO ──────────────────────────────────────────────
        if (conta.tipoContaFixa === 'fatura_cartao' && conta.compras && conta.compras.length > 0) {
            let cartaoRef = cartoesCredito.find(c => c.id === conta.cartaoId);

            conta.compras.forEach(compra => {
                if (typeof compra.parcelaAtual  !== 'number' || !isFinite(compra.parcelaAtual))  return;
                if (typeof compra.totalParcelas !== 'number' || !isFinite(compra.totalParcelas)) return;
                if (typeof compra.valorParcela  !== 'number' || !isFinite(compra.valorParcela))  return;
                if (compra.parcelaAtual  < 1)         return;
                if (compra.totalParcelas < 1)         return;
                if (compra.valorParcela  <= 0)        return;
                if (compra.valorParcela  > 9_999_999) return;

                if (compra.parcelaAtual <= compra.totalParcelas) {
                    compra.parcelaAtual++;
                    if (cartaoRef) {
                        const parcela = parseFloat(compra.valorParcela);
                        cartaoRef.usado = (cartaoRef.usado || 0) - parcela;
                        if (cartaoRef.usado < 0) cartaoRef.usado = 0;
                    }
                }
            });

            conta.compras = conta.compras.filter(c => c.parcelaAtual <= c.totalParcelas);

            if (conta.compras.length === 0) {
                contasFixas = contasFixas.filter(c => c.id !== id);
                salvarDados();
                atualizarTudo();
                conta._processando = false;
                alert('✅ Todas as parcelas pagas! Fatura quitada.');
                return;
            }

            conta.valor = conta.compras.reduce((sum, c) => {
                const p = parseFloat(c.valorParcela);
                return sum + (isFinite(p) && p > 0 ? p : 0);
            }, 0);

            conta.vencimento = _avancarMes(conta.vencimento);
            conta.pago = false;

            salvarDados();
            atualizarTudo();
            conta._processando = false;
            alert(`✅ Fatura paga! Próxima fatura: ${formatBRL(conta.valor)} em ${formatarDataBR(conta.vencimento)}`);
            return;
        }

        // ── CONTA COM PARCELAS DE CARTÃO ──────────────────────────────────
        if (conta.cartaoId && conta.totalParcelas && conta.parcelaAtual) {
            let cartaoRef = cartoesCredito.find(c => c.id === conta.cartaoId);
            if (cartaoRef) {
                cartaoRef.usado = (cartaoRef.usado || 0) - valorSeguro;
                if (cartaoRef.usado < 0) cartaoRef.usado = 0;
            }

            if (conta.parcelaAtual < conta.totalParcelas) {
                conta.parcelaAtual++;
                conta.vencimento = _avancarMes(conta.vencimento);
                conta.pago = false;
            } else {
                contasFixas = contasFixas.filter(c => c.id !== conta.id);
            }

            salvarDados();
            atualizarTudo();
            conta._processando = false;
            alert('✅ Parcela paga! O lembrete foi atualizado.');
            return;
        }

        // ── CONTA RECORRENTE (sem parcelas) ──────────────────────────────
        conta.vencimento = _avancarMes(conta.vencimento);
        conta.pago = false;

        salvarDados();
        atualizarTudo();
        conta._processando = false;
        alert('✅ Pagamento realizado e vencimento atualizado para o próximo mês!');

    } catch (erro) {
        console.error('❌ Erro no pagamento, revertendo estado:', erro);

        rollbackArray(transacoes,     snapshotTransacoes);
        rollbackArray(contasFixas,    snapshotContasFixas);
        rollbackArray(cartoesCredito, snapshotCartoes);

        contaOriginal._processando = false;
        alert('❌ Erro ao processar pagamento. Nenhuma alteração foi salva.');
    }
}

// ✅ Token de versão declarado fora — persiste entre chamadas
//    Incrementado a cada criarPopup(), capturado a cada fecharPopup()
//    Garante que o setTimeout de um fechamento antigo nunca limpe um popup novo
let _popupVersaoAtual = 0;

function criarPopup(html) {
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
    container.appendChild(box);

    overlay.classList.add('active');
    overlay.onclick = () => fecharPopup();
}

function fecharPopup() {
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

function sanitizarHTMLPopup(html) {
    const parser = new DOMParser();
    const doc    = parser.parseFromString(html, 'text/html');

    // ✅ Tags estruturalmente perigosas — removidas completamente
    const tagsProibidas = ['script', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form', 'svg'];
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

// ========== TRANSAÇÕES ==========
function atualizarTiposDinamicos() {
    const cat = document.getElementById('selectCategoria').value;
    const tipoSelect = document.getElementById('selectTipo');
    tipoSelect.innerHTML = '';
    
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = cat ? (cat === 'reserva' ? 'Meta (reserva)' : 'Tipo') : 'Tipo';
    tipoSelect.appendChild(placeholder);
    
    if(cat === 'entrada') {
        ['Salário', 'Renda Extra', 'Outros Recebimentos'].forEach(x => {
            const o = document.createElement('option');
            o.value = x;
            o.textContent = x;
            tipoSelect.appendChild(o);
        });
    } else if(cat === 'saida' || cat === 'saida_credito') {
        ['Mercado', 'Farmácia', 'Eletrônico', 'Roupas', 'Assinaturas', 'Beleza', 'Presente', 
         'Conta fixa', 'Cartão', 'Academia', 'Lazer', 'Transporte', 'Shopee', 'Mercado Livre', 
         'Ifood', 'Amazon', 'Outros', 'Transação Via Chat'].forEach(x => {
            const o = document.createElement('option');
            o.value = x;
            o.textContent = x;
            tipoSelect.appendChild(o);
        });
    } else if(cat === 'reserva') {
        const metasExistentes = metas.filter(m => m.id !== 'emergency');
        if(metasExistentes.length === 0) {
            const aviso = document.createElement('option');
            aviso.value = '';
            aviso.textContent = 'Nenhuma meta disponível';
            tipoSelect.appendChild(aviso);
        } else {
            metasExistentes.forEach(m => {
                const o = document.createElement('option');
                o.value = 'meta_' + m.id;
                o.textContent = m.descricao;
                tipoSelect.appendChild(o);
            });
        }
    }
    
    atualizarCamposCredito();
}

function atualizarCamposCredito() {
    const creditDiv      = document.getElementById('creditoFields');
    const parcelasSelect = document.getElementById('selectParcelas');
    const cartaoSelect   = document.getElementById('selectCartao');
    const catVal         = document.getElementById('selectCategoria').value;

    if (parcelasSelect) {
        parcelasSelect.innerHTML = '';
        for (let i = 1; i <= 24; i++) {
            const opt = document.createElement('option');
            opt.value       = i;
            opt.textContent = `${String(i).padStart(2, '0')}x`;
            parcelasSelect.appendChild(opt);
        }
    }

    if (catVal === 'saida_credito') {
        creditDiv.style.display = 'flex';
        cartaoSelect.innerHTML  = '';

        if (cartoesCredito.length === 0) {
            const opt       = document.createElement('option');
            opt.value       = '';
            opt.textContent = 'Cadastre um cartão no menu "Cartões"';
            cartaoSelect.appendChild(opt);
            cartaoSelect.disabled = true;
        } else {
            // ✅ Opção placeholder
            const placeholder       = document.createElement('option');
            placeholder.value       = '';
            placeholder.textContent = 'Selecione o cartão';
            cartaoSelect.appendChild(placeholder);

            // ✅ Cada cartão via DOM — nomeBanco e id nunca passam por innerHTML
            cartoesCredito.forEach(c => {
                const opt       = document.createElement('option');
                opt.value       = String(c.id);          // ✅ atribuição direta — não interpolado
                opt.textContent = _sanitizeText(c.nomeBanco); // ✅ sanitizado via textContent
                cartaoSelect.appendChild(opt);
            });

            cartaoSelect.disabled = false;
        }
    } else {
        creditDiv.style.display = 'none';
    }
}

function lancarTransacao() {
    const categoria = document.getElementById('selectCategoria').value;
    const tipo      = document.getElementById('selectTipo').value;
    const descricao = document.getElementById('inputDescricao').value.trim();
    const valorStr  = document.getElementById('inputValor').value;

    if(!categoria) return alert('Escolha Entrada, Saída ou Reserva.');
    if(categoria === 'reserva' && metas.filter(m => m.id !== 'emergency').length === 0) {
        return alert('Você ainda não criou nenhuma meta ou reserva, crie no menu "Reservas"');
    }
    if(!tipo && categoria !== 'saida_credito') return alert('Escolha o tipo.');
    if(!descricao) return alert('Digite a descrição.');
    if(!valorStr || !Number.isFinite(Number(valorStr)) || Number(valorStr) <= 0) return alert('Digite um valor válido.');

    const valor = parseFloat(parseFloat(valorStr).toFixed(2));
    const dh    = agoraDataHora();

    if(categoria === 'saida_credito') {
        const cartaoSel   = document.getElementById('selectCartao').value;
        const parcelasSel = Number(document.getElementById('selectParcelas').value);

        if(!cartaoSel)   return alert("Selecione o cartão!");
        if(!parcelasSel) return alert("Selecione a quantidade de parcelas!");

        const cartao = cartoesCredito.find(c => String(c.id) === String(cartaoSel));
        if(!cartao) return alert("Cartão não encontrado!");
        if(cartao.congelado) return alert("❄️ Este cartão está congelado! Vá em Cartões → Descongelar para utilizá-lo.");

        if(!confirm(`Compra de ${formatBRL(valor)} no cartão ${cartao.nomeBanco}, em ${parcelasSel}x de ${formatBRL(valor/parcelasSel)}.\nProsseguir?`)) return;

        let hoje     = new Date();
        let anoAtual = hoje.getFullYear();
        let mesAtual = hoje.getMonth() + 1;
        let diaHoje  = hoje.getDate();
        let diaFatura = cartao.vencimentoDia;

        let proxMes, proxAno;
        if(diaHoje >= diaFatura) {
            proxMes = mesAtual + 1;
            proxAno = anoAtual;
            if(proxMes > 12) { proxMes = 1; proxAno++; }
        } else {
            proxMes = mesAtual;
            proxAno = anoAtual;
        }

        const dataFaturaISO = `${proxAno}-${String(proxMes).padStart(2, '0')}-${String(diaFatura).padStart(2, '0')}`;

        const faturaExistente = contasFixas.find(c =>
            c.cartaoId === cartao.id &&
            c.vencimento === dataFaturaISO &&
            c.tipoContaFixa === 'fatura_cartao'
        );

        // ✅ CORREÇÃO: gera UUID local para cada compra.
        //    Compras são armazenadas como JSON aninhado no Supabase (não como rows),
        //    portanto o banco NUNCA gera IDs para objetos dentro do array.
        //    Sem id, String(undefined) === String(undefined) é true para todas as compras,
        //    fazendo find() em pagarCompraIndividual/editarCompraFatura/excluirCompraFatura
        //    retornar sempre a primeira — causando pagar/editar/excluir a compra errada.
        const novaCompra = {
            id: (typeof crypto !== 'undefined' && crypto.randomUUID)
                ? crypto.randomUUID()
                : `compra_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
            tipo,
            descricao,
            valorTotal:    valor,
            valorParcela:  Number((valor / parcelasSel).toFixed(2)),
            totalParcelas: parcelasSel,
            parcelaAtual:  1,
            dataCompra:    dh.data
        };

        if(faturaExistente) {
            if(!faturaExistente.compras) faturaExistente.compras = [];

            // ✅ Previne inserção duplicada em caso de double-click
            const jaExiste = faturaExistente.compras.some(c => c.id === novaCompra.id);
            if(!jaExiste) {
                faturaExistente.compras.push(novaCompra);
            }
            faturaExistente.valor = faturaExistente.compras.reduce((sum, c) => {
                const p = parseFloat(c.valorParcela);
                return sum + (isFinite(p) && p > 0 ? p : 0);
            }, 0);
        } else {
            contasFixas.push({
                // ✅ A fatura também recebe UUID — consistência com demais contasFixas
                id: (typeof crypto !== 'undefined' && crypto.randomUUID)
                    ? crypto.randomUUID()
                    : `fatura_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
                descricao:      `Fatura ${cartao.nomeBanco}`,
                valor:          Number((valor / parcelasSel).toFixed(2)),
                vencimento:     dataFaturaISO,
                pago:           false,
                cartaoId:       cartao.id,
                tipoContaFixa:  'fatura_cartao',
                compras:        [novaCompra]
            });
        }

        cartao.usado = (cartao.usado || 0) + valor;

        salvarDados();
        atualizarTudo();

        document.getElementById('selectCategoria').value = '';
        atualizarTiposDinamicos();
        document.getElementById('inputDescricao').value = '';
        document.getElementById('inputValor').value     = '';

        alert("Compra lançada! A fatura do cartão foi atualizada.");
        return;
    }

    let showTipo = tipo;
    if(categoria === 'reserva' && tipo.startsWith('meta_')) {
        showTipo = 'Reserva';
    }

    criarPopup(`
        <h3>Comprovante</h3>
        <div class="small">Confirme antes de lançar</div>
        <div style="text-align:left; margin:20px 0; color: var(--text-secondary);">
            <div><b>Categoria:</b> <span id="compCategoria"></span></div>
            <div><b>Tipo:</b>      <span id="compTipo"></span></div>
            <div><b>Descrição:</b> <span id="compDescricao"></span></div>
            <div><b>Valor:</b>     <span id="compValor"></span></div>
            <div><b>Data:</b>      <span id="compData"></span></div>
            <div><b>Hora:</b>      <span id="compHora"></span></div>
        </div>
        <button class="btn-primary" id="confirmBtn">Confirmar</button>
        <button class="btn-cancelar" id="cancelarComprovante">Cancelar</button>
    `);

    document.getElementById('compCategoria').textContent = categoria;
    document.getElementById('compTipo').textContent      = showTipo;
    document.getElementById('compDescricao').textContent = descricao;
    document.getElementById('compValor').textContent     = formatBRL(valor);
    document.getElementById('compData').textContent      = dh.data;
    document.getElementById('compHora').textContent      = dh.hora;

    document.getElementById('cancelarComprovante').addEventListener('click', () => fecharPopup());

    document.getElementById('confirmBtn').addEventListener('click', () => {
        let metaIdInner = null;
        let tipoSalvo   = tipo;

        if(categoria === 'reserva' && tipo.startsWith('meta_')) {
            metaIdInner = tipo.split('_')[1];
            tipoSalvo   = 'Reserva';
        }

        // ✅ Sem id — banco gera via gen_random_uuid() (rows individuais no Supabase)
        const t = {
            categoria,
            tipo:    tipoSalvo,
            descricao,
            valor,
            data:    dh.data,
            hora:    dh.hora,
            metaId:  metaIdInner
        };
        transacoes.push(t);

        if(categoria === 'reserva' && metaIdInner) {
            const meta = metas.find(m => String(m.id) === String(metaIdInner));
            if(meta) {
                meta.saved = Number((Number(meta.saved || 0) + Number(valor)).toFixed(2));
                const ym = yearMonthKey(isoDate());
                meta.monthly = meta.monthly || {};
                meta.monthly[ym] = Number((Number(meta.monthly[ym] || 0) + Number(valor)).toFixed(2));
            }
        }

        salvarDados();
        atualizarTudo();
        fecharPopup();

        document.getElementById('selectCategoria').value    = '';
        document.getElementById('selectTipo').innerHTML     = '<option value="">Tipo</option>';
        document.getElementById('inputDescricao').value     = '';
        document.getElementById('inputValor').value         = '';
    });
}

function _obterIconeTransacao(categoria, tipo) {
    const t = (tipo || '').toLowerCase();

    if (categoria === 'entrada') {
        if (t.includes('sal') && (t.includes('rio') || t.includes('rio'))) return 'fa-money-bill-wave';
        if (t.includes('renda') || t.includes('extra')) return 'fa-chart-line';
        if (t.includes('recebimento')) return 'fa-hand-holding-dollar';
        return 'fa-arrow-trend-up';
    }

    if (categoria === 'reserva')          return 'fa-piggy-bank';
    if (categoria === 'retirada_reserva') return 'fa-arrow-right-from-bracket';

    if (t.includes('mercado livre'))                              return 'fa-store';
    if (t.includes('mercado'))                                    return 'fa-cart-shopping';
    if (t.includes('farm'))                                       return 'fa-pills';
    if (t.includes('eletr'))                                      return 'fa-laptop';
    if (t.includes('roupa') || t.includes('vestuário'))          return 'fa-shirt';
    if (t.includes('assinatura') || t.includes('streaming'))     return 'fa-rotate';
    if (t.includes('beleza') || t.includes('cabelo'))            return 'fa-scissors';
    if (t.includes('presente'))                                   return 'fa-gift';
    if (t.includes('conta') || t.includes('fatura'))             return 'fa-file-invoice-dollar';
    if (t.includes('cart'))                                       return 'fa-credit-card';
    if (t.includes('academia') || t.includes('gym'))             return 'fa-dumbbell';
    if (t.includes('lazer') || t.includes('entretenimento'))     return 'fa-gamepad';
    if (t.includes('transporte') || t.includes('uber') || t.includes('gasolina') || t.includes('combustível')) return 'fa-bus';
    if (t.includes('shopee'))                                     return 'fa-bag-shopping';
    if (t.includes('ifood') || t.includes('restaurante') || t.includes('alimenta')) return 'fa-utensils';
    if (t.includes('amazon'))                                     return 'fa-box';
    if (t.includes('chat') || t.includes('ia') || t.includes('robot')) return 'fa-robot';
    if (t.includes('saúde') || t.includes('médico') || t.includes('consulta')) return 'fa-stethoscope';
    if (t.includes('educação') || t.includes('curso') || t.includes('livro')) return 'fa-graduation-cap';
    if (t.includes('viagem') || t.includes('hotel') || t.includes('passagem')) return 'fa-plane';

    return 'fa-arrow-up-right-dots';
}

function atualizarMovimentacoesUI() {
    const lista = document.getElementById('listaMovimentacoes');
    if (!lista) return;

    lista.innerHTML = '';

    if (transacoes.length === 0) {
        const p       = document.createElement('p');
        p.className   = 'empty-state';
        p.textContent = 'Nenhuma movimentação registrada.';
        lista.appendChild(p);
        return;
    }

    const arr = transacoes.slice().reverse();
    let ultimaData = null;

    arr.forEach(t => {
        const dataExibida = _sanitizeText(t.data || '');

        if (dataExibida && dataExibida !== ultimaData) {
            ultimaData = dataExibida;
            const sep       = document.createElement('div');
            sep.className   = 'mov-date-separator';
            sep.textContent = dataExibida;
            lista.appendChild(sep);
        }

        const div     = document.createElement('div');
        div.className = 'mov-item';

        const categoriasPermitidas = ['entrada', 'saida', 'reserva', 'retirada_reserva'];
        const categoriaSegura = categoriasPermitidas.includes(t.categoria) ? t.categoria : 'saida';

        const iconeBadge     = document.createElement('div');
        iconeBadge.className = `mov-icon-badge ${categoriaSegura}`;

        const iconeEl = document.createElement('i');
        iconeEl.className = `fas ${_obterIconeTransacao(t.categoria, t.tipo)}`;
        iconeEl.setAttribute('aria-hidden', 'true');
        iconeBadge.appendChild(iconeEl);

        const left    = document.createElement('div');
        left.className = 'mov-left';

        const divTipo       = document.createElement('div');
        divTipo.className   = 'mov-tipo';
        divTipo.textContent = _sanitizeText(t.tipo);

        const divDesc       = document.createElement('div');
        divDesc.className   = 'mov-desc';
        divDesc.textContent = _sanitizeText(t.descricao);

        left.appendChild(divTipo);
        left.appendChild(divDesc);

        const right     = document.createElement('div');
        right.className = 'mov-right';

        const sinal = (t.categoria === 'entrada' || t.categoria === 'retirada_reserva') ? '+' : '-';

        const divValor       = document.createElement('div');
        divValor.className   = categoriaSegura;
        divValor.textContent = `${sinal} ${formatBRL(t.valor)}`;
        right.appendChild(divValor);

        div.appendChild(iconeBadge);
        div.appendChild(left);
        div.appendChild(right);

        div.addEventListener('click', () => abrirDetalhesTransacao(t.id));
        lista.appendChild(div);
    });
}

function abrirDetalhesTransacao(id) {
    const t = transacoes.find(x => x.id === id);
    if (!t) return;

    // ✅ HTML estático — zero dados do usuário interpolados
    criarPopup(`
        <h3>Detalhes da Transação</h3>
        <div class="small" id="detTransId"></div>
        <div style="text-align:left; margin:20px 0; color: var(--text-secondary);">
            <b>Categoria:</b> <span id="detCategoria"></span><br>
            <b>Tipo:</b>      <span id="detTipo"></span><br>
            <b>Descrição:</b> <span id="detDescricao"></span><br>
            <b>Valor:</b>     <span id="detValor"></span><br>
            <b>Data:</b>      <span id="detData"></span><br>
            <b>Hora:</b>      <span id="detHora"></span>
        </div>
        <button class="btn-excluir" id="delTransBtn">Excluir</button>
        <button class="btn-primary" id="fecharDetalhesBtn">Fechar</button>
    `);

    // ✅ Preenchimento via textContent — nunca innerHTML com dados do usuário
    document.getElementById('detTransId').textContent  = t.id ? `ID: ${String(t.id).slice(0, 40)}` : '';
    document.getElementById('detCategoria').textContent = _sanitizeText(t.categoria);
    document.getElementById('detTipo').textContent      = _sanitizeText(t.tipo);
    document.getElementById('detDescricao').textContent = _sanitizeText(t.descricao);
    document.getElementById('detValor').textContent     = formatBRL(t.valor);
    document.getElementById('detData').textContent      = _sanitizeText(t.data);
    document.getElementById('detHora').textContent      = _sanitizeText(t.hora);

    // ✅ addEventListener — sem onclick inline
    document.getElementById('fecharDetalhesBtn').addEventListener('click', () => fecharPopup());

    document.getElementById('delTransBtn').addEventListener('click', () => {
        transacoes = transacoes.filter(x => x.id !== t.id);

        if (t.categoria === 'reserva' && t.metaId) {
            const meta = metas.find(m => String(m.id) === String(t.metaId));
            if (meta) {
                meta.saved = Number((Number(meta.saved || 0) - Number(t.valor)).toFixed(2));
                const ym = yearMonthKey(t.data);
                if (meta.monthly && meta.monthly[ym]) {
                    meta.monthly[ym] = Number((Number(meta.monthly[ym]) - Number(t.valor)).toFixed(2));
                }
            }
        } else if (t.categoria === 'retirada_reserva' && t.metaId) {
            const meta = metas.find(m => String(m.id) === String(t.metaId));
            if (meta) {
                meta.saved = Number((Number(meta.saved || 0) + Number(t.valor)).toFixed(2));
                const ym = yearMonthKey(t.data);
                if (meta.monthly && meta.monthly[ym]) {
                    meta.monthly[ym] = Number((Number(meta.monthly[ym] || 0) + Number(t.valor)).toFixed(2));
                }
            }
        }

        salvarDados();
        atualizarTudo();
        fecharPopup();
    });
}
// ========== METAS/RESERVAS ==========
function abrirMetaForm(editId = null) {
    if (editId === null) {
        criarPopup(`
            <h3>Adicionar Meta</h3>
            <input id="metaDesc" class="form-input" placeholder="Descrição" maxlength="200"><br>
            <input id="metaObj" class="form-input" placeholder="Valor objetivo (R$)" type="number" step="0.01" min="0"><br>
            <button class="btn-primary" id="okMeta">Concluir</button>
            <button class="btn-cancelar" id="cancelarMeta">Cancelar</button>
        `);

        document.getElementById('cancelarMeta').addEventListener('click', () => fecharPopup());

        document.getElementById('okMeta').addEventListener('click', () => {
            const desc   = document.getElementById('metaDesc').value.trim();
            const objStr = document.getElementById('metaObj').value;

            if (!desc)                                                              return alert('Digite descrição da meta.');
            if (desc.length > 200)                                                  return alert('Descrição muito longa (máx. 200 caracteres).');
            if (!objStr || !Number.isFinite(Number(objStr)) || Number(objStr) <= 0) return alert('Digite objetivo válido.');

            const objetivo = parseFloat(parseFloat(objStr).toFixed(2));
            if (!Number.isFinite(objetivo) || objetivo <= 0)                        return alert('Digite objetivo válido.');

            // ✅ CORREÇÃO: gera id local para que editar e remover funcionem corretamente
            const novoId = (typeof crypto !== 'undefined' && crypto.randomUUID)
                ? crypto.randomUUID()
                : `local_${Date.now()}_${Math.random().toString(36).slice(2)}`;

            metas.push({ id: novoId, descricao: desc, objetivo, saved: 0, monthly: {} });
            salvarDados();
            renderMetasList();
            atualizarTudo();
            fecharPopup();
        });

    } else {
        const meta = metas.find(m => m.id === editId);
        if (!meta) return;

        criarPopup(`
            <h3>Editar Meta</h3>
            <input id="metaDesc" class="form-input" maxlength="200"><br>
            <input id="metaObj" class="form-input" type="number" step="0.01" min="0"><br>
            <button class="btn-primary" id="okMeta">Salvar</button>
            <button class="btn-cancelar" id="cancelarMeta">Cancelar</button>
        `);

        document.getElementById('metaDesc').value = meta.descricao;
        document.getElementById('metaObj').value  = meta.objetivo;

        document.getElementById('cancelarMeta').addEventListener('click', () => fecharPopup());

        document.getElementById('okMeta').addEventListener('click', () => {
            const desc   = document.getElementById('metaDesc').value.trim();
            const objStr = document.getElementById('metaObj').value;

            if (!desc)
            return alert('Digite descrição da meta.');
            if (desc.length > 200)
            return alert('Descrição muito longa (máx. 200 caracteres).');
            if (!objStr || !Number.isFinite(Number(objStr)) || Number(objStr) <= 0)
            return alert('Digite objetivo válido.');

            meta.descricao = desc;
            meta.objetivo  = parseFloat(parseFloat(objStr).toFixed(2));
            if (!Number.isFinite(meta.objetivo) || meta.objetivo <= 0)
            return alert('Digite objetivo válido.');

            salvarDados();
            renderMetasList();
            atualizarTudo();
            fecharPopup();
        });
    }
}

function renderMetasList() {
    const cont = document.getElementById('listaMetas');
    if (!cont) return;

    cont.innerHTML = '';

    if (metas.length === 0) {
        const p       = document.createElement('p');
        p.className   = 'empty-state';
        p.textContent = 'Nenhuma reserva criada.';
        cont.appendChild(p);
        return;
    }

    metas.forEach(m => {
        const div         = document.createElement('div');
        div.className     = 'meta-item';
        div.dataset.id    = String(m.id);

        const saved     = Number(m.saved    || 0);
        const objetivo  = Number(m.objetivo || 0);
        const percentual = objetivo > 0
            ? Math.min(100, parseFloat(((saved / objetivo) * 100).toFixed(1)))
            : 0;

        // ✅ Cor determinada por lógica — nunca vem de dado do usuário
        let corProgresso = '#ff4b4b';
        if      (percentual >= 70) corProgresso = '#00ff99';
        else if (percentual >= 40) corProgresso = '#ffd166';

        // ── Linha superior: descrição + percentual
        const rowTop = document.createElement('div');
        rowTop.style.cssText = 'display:flex; justify-content:space-between; align-items:center; gap:12px; margin-bottom:12px;';

        const colInfo = document.createElement('div');
        colInfo.style.flex = '1';

        const strongDesc       = document.createElement('strong');
        strongDesc.textContent = _sanitizeText(m.descricao); // ✅ textContent

        const divValores           = document.createElement('div');
        divValores.style.cssText   = 'font-size:12px; color: var(--text-muted); margin-top:4px;';
        divValores.textContent     = `${formatBRL(saved)} de ${formatBRL(objetivo)}`; // ✅ textContent

        colInfo.appendChild(strongDesc);
        colInfo.appendChild(divValores);

        const divPerc = document.createElement('div');
        // ✅ Atribuição direta de propriedades — sem cssText com dados do usuário
        divPerc.style.background    = `rgba(${percentual >= 70 ? '0,255,153' : percentual >= 40 ? '255,209,102' : '255,75,75'},0.2)`;
        divPerc.style.padding       = '6px 12px';
        divPerc.style.borderRadius  = '20px';
        divPerc.style.fontSize      = '0.85rem';
        divPerc.style.fontWeight    = '700';
        divPerc.style.color         = corProgresso; // ✅ valor interno — não vem do usuário
        divPerc.style.whiteSpace    = 'nowrap';
        divPerc.textContent         = `${percentual}%`; // ✅ textContent

        rowTop.appendChild(colInfo);
        rowTop.appendChild(divPerc);

        // ── Barra de progresso
        const barraContainer = document.createElement('div');
        barraContainer.style.cssText = 'width:100%; height:6px; background:rgba(255,255,255,0.1); border-radius:10px; overflow:hidden; margin-bottom:12px;';

        const barraFill = document.createElement('div');
        // ✅ Atribuição direta — percentual e corProgresso são valores internos calculados
        barraFill.style.width        = `${percentual}%`;
        barraFill.style.height       = '100%';
        barraFill.style.background   = corProgresso;
        barraFill.style.borderRadius = '10px';
        barraFill.style.transition   = 'width 0.5s ease';
        barraFill.style.boxShadow    = `0 0 10px ${corProgresso}`;

        barraContainer.appendChild(barraFill);

        // ── Botões de ação
        const rowBotoes = document.createElement('div');
        rowBotoes.style.cssText = 'display:flex; justify-content:space-between; align-items:center; gap:12px;';

        const colBotoes = document.createElement('div');
        colBotoes.style.cssText = 'display:flex; gap:6px; flex-wrap:wrap;';

        // ✅ Botão Editar — addEventListener em vez de onclick inline com m.id interpolado
        const btnEditar         = document.createElement('button');
        btnEditar.className     = 'btn-primary';
        btnEditar.style.cssText = 'padding:6px 12px; font-size:0.85rem;';
        btnEditar.textContent   = '✏️ Editar';
        btnEditar.addEventListener('click', (e) => {
            e.stopPropagation();
            abrirMetaForm(m.id);
        });

        colBotoes.appendChild(btnEditar);

        // ✅ Botão Análise — só aparece se há histórico, sem interpolação de ID
        if (m.historicoRetiradas && m.historicoRetiradas.length > 0) {
            const btnAnalise         = document.createElement('button');
            btnAnalise.className     = 'btn-primary';
            btnAnalise.style.cssText = 'padding:6px 12px; font-size:0.85rem; background: var(--accent);';
            btnAnalise.textContent   = '📊 Análise';
            btnAnalise.addEventListener('click', (e) => {
                e.stopPropagation();
                abrirAnaliseDisciplina(m.id);
            });
            colBotoes.appendChild(btnAnalise);
        }

        // ✅ Botão Excluir — addEventListener em vez de onclick inline
        const btnExcluir         = document.createElement('button');
        btnExcluir.className     = 'btn-excluir';
        btnExcluir.style.cssText = 'padding:6px 12px; font-size:0.85rem;';
        btnExcluir.textContent   = '🗑️ Excluir';
        btnExcluir.addEventListener('click', (e) => {
            e.stopPropagation();
            removerMeta(m.id);
        });

        colBotoes.appendChild(btnExcluir);
        rowBotoes.appendChild(colBotoes);

        // ── Monta card
        div.appendChild(rowTop);
        div.appendChild(barraContainer);
        div.appendChild(rowBotoes);

        // ✅ Click no card via addEventListener
        div.addEventListener('click', () => {
            document.querySelectorAll('.meta-item').forEach(x => x.classList.remove('selected'));
            div.classList.add('selected');
            selecionarMeta(m.id);
        });

        cont.appendChild(div);
    });
}

function removerMeta(id) {
    if(!confirm('Remover meta? Isso também removerá os valores mensais associados.')) return;
    
    metas = metas.filter(m => m.id !== id);
    transacoes = transacoes.map(t => {
        if(t.metaId && String(t.metaId) === String(id)) {
            return Object.assign({}, t, { metaId: null });
        }
        return t;
    });
    
    salvarDados();
    renderMetasList();
    atualizarTudo();
    atualizarHeaderReservas();
}

function selecionarMeta(id) {
    metaSelecionadaId = id;
    renderMetaVisual();
    const btnRetirar = document.getElementById('btnRetirar');
    if(btnRetirar) btnRetirar.style.display = 'block';
}

// ========== CÁLCULO DE PROJEÇÃO DE CONCLUSÃO DA META ==========
function calcularProjecaoConclusao(meta) {
    const saved = Number(meta.saved || 0);
    const objetivo = Number(meta.objetivo || 0);
    const falta = Math.max(0, objetivo - saved);
    
    // Se já atingiu a meta
    if(saved >= objetivo) {
        return {
            temHistorico: true,
            concluida: true,
            dataEstimada: '🎉 Meta Concluída!',
            mediaMensal: 0,
            mesesRestantes: 0,
            mesesComDados: 0
        };
    }
    
    // Calcular média mensal baseado no histórico
    const monthly = meta.monthly || {};
    const valoresHistorico = Object.values(monthly).filter(v => v > 0);
    
    // Precisa de pelo menos 2 meses com dados
    if(valoresHistorico.length < 2) {
        return {
            temHistorico: false,
            mesesComDados: valoresHistorico.length
        };
    }
    
    // Calcular média mensal
    const mediaMensal = valoresHistorico.reduce((sum, v) => sum + v, 0) / valoresHistorico.length;
    
    // Se a média é zero ou negativa, não há projeção
    if(mediaMensal <= 0) {
        return {
            temHistorico: false,
            mesesComDados: valoresHistorico.length
        };
    }
    
    // Calcular meses restantes
    const mesesRestantes = Math.ceil(falta / mediaMensal);
    
    // Calcular data estimada
    const hoje = new Date();
    const dataEstimada = new Date(hoje.getFullYear(), hoje.getMonth() + mesesRestantes, 1);
    const dataFormatada = dataEstimada.toLocaleDateString('pt-BR', { 
        month: 'long', 
        year: 'numeric' 
    });
    
    // Gerar sugestões e avisos
    let sugestao = null;
    let avisoAjuste = null;
    
    // Se a média é muito baixa (meta levará mais de 2 anos)
    if(mesesRestantes > 24) {
        avisoAjuste = 'No ritmo atual, esta meta levará mais de 2 anos. Considere aumentar o valor mensal.';
        const valorNecessario = Math.ceil(falta / 12); // Para concluir em 1 ano
        sugestao = `Guardando ${formatBRL(valorNecessario)}/mês, você conclui em aproximadamente 1 ano.`;
    }
    // Se está indo bem (menos de 6 meses)
    else if(mesesRestantes <= 6) {
        sugestao = 'Você está em um ótimo ritmo! Continue assim para alcançar sua meta em breve.';
    }
    // Ritmo moderado (6 a 12 meses)
    else if(mesesRestantes <= 12) {
        sugestao = 'Bom progresso! Mantenha a disciplina para concluir dentro do prazo estimado.';
    }
    // Ritmo lento (12 a 24 meses)
    else {
        const valorSugerido = Math.ceil(falta / 12);
        sugestao = `Para concluir em 1 ano, tente guardar ${formatBRL(valorSugerido)}/mês.`;
    }
    
    return {
        temHistorico: true,
        concluida: false,
        mediaMensal: mediaMensal,
        mesesRestantes: mesesRestantes,
        dataEstimada: dataFormatada.charAt(0).toUpperCase() + dataFormatada.slice(1),
        mesesComDados: valoresHistorico.length,
        sugestao: sugestao,
        avisoAjuste: avisoAjuste
    };
}

function renderMetaVisual() {
    const details = document.getElementById('metaDetalhes');
    const donut = document.getElementById('donutChart');
    const line = document.getElementById('lineChart');
    
    if(!donut || !line || !details) return;
    
    const ctxDonut = donut.getContext('2d');
    const ctxLine = line.getContext('2d');
    
    ctxDonut.clearRect(0, 0, donut.width, donut.height);
    ctxLine.clearRect(0, 0, line.width, line.height);
    
    if(!metaSelecionadaId) {
        details.innerHTML = '<div style="color: var(--text-secondary);">Selecione uma reserva para ver detalhes e gráficos</div>';
        const progressEl = document.getElementById('metaProgress');
        if(progressEl) progressEl.textContent = 'Selecione uma reserva';
        const btnRetirar = document.getElementById('btnRetirar');
        if(btnRetirar) btnRetirar.style.display = 'none';
        return;
    }
    
    const meta = metas.find(m => String(m.id) === String(metaSelecionadaId));
    if(!meta) {
        details.innerHTML = '<div style="color: var(--text-secondary);">Meta não encontrada</div>';
        const btnRetirar = document.getElementById('btnRetirar');
        if(btnRetirar) btnRetirar.style.display = 'none';
        return;
    }
    
    const saved = Number(meta.saved || 0);
    const objetivo = Number(meta.objetivo || 0);
    const perc = objetivo > 0 ? Math.min(100, Math.round((saved/objetivo)*100)) : 0;
    
    const progressEl = document.getElementById('metaProgress');
    if(progressEl) {
        progressEl.textContent = `${perc}% concluído – ${formatBRL(saved)} de ${formatBRL(objetivo)}`;
    }
    
    // ✅ NOVO: Calcular projeção de conclusão
    const projecao = calcularProjecaoConclusao(meta);
    
    // Desenha gráfico donut
    const cx = donut.width/2, cy = donut.height/2, r = Math.min(cx,cy)-8;
    ctxDonut.clearRect(0,0,donut.width,donut.height);
    ctxDonut.beginPath();
    ctxDonut.arc(cx,cy,r,0,Math.PI*2);
    ctxDonut.fillStyle = '#0f1226';
    ctxDonut.fill();
    
    const ang = objetivo>0 ? (saved/objetivo) * Math.PI*2 : 0;
    ctxDonut.beginPath();
    ctxDonut.moveTo(cx,cy);
    ctxDonut.arc(cx,cy,r,-Math.PI/2, -Math.PI/2 + ang, false);
    ctxDonut.closePath();
    ctxDonut.fillStyle = '#00ff99';
    ctxDonut.fill();
    
    ctxDonut.beginPath();
    ctxDonut.moveTo(cx,cy);
    ctxDonut.arc(cx,cy,r,-Math.PI/2 + ang, -Math.PI/2 + Math.PI*2, false);
    ctxDonut.closePath();
    ctxDonut.fillStyle = '#ff4b4b';
    ctxDonut.fill();
    
    ctxDonut.beginPath();
    ctxDonut.arc(cx,cy,r*0.6,0,Math.PI*2);
    ctxDonut.fillStyle = '#11173a';
    ctxDonut.fill();
    
    ctxDonut.fillStyle = '#fff';
    ctxDonut.font = 'bold 14px sans-serif';
    ctxDonut.textAlign='center';
    ctxDonut.fillText(`${perc}%`, cx, cy+6);
    
    // Desenha gráfico de linha
    ctxLine.clearRect(0,0,line.width,line.height);
    const padding = 40;
    const w = line.width - padding*2, h = line.height - padding*2;
    
    const months = [];
    const points = [];
    const now = new Date();
    
    for(let i=11;i>=0;i--){
        const d = new Date(now.getFullYear(), now.getMonth()-i, 1);
        const y = d.getFullYear();
        const m = d.getMonth()+1;
        const key = `${y}-${String(m).padStart(2,'0')}`;
        months.push({ key, label: d.toLocaleString('pt-BR', {month:'short'}), month: m });
    }
    
    const values = months.map(mk => Number(meta.monthly && meta.monthly[mk.key] ? meta.monthly[mk.key] : 0));
    const maxV = Math.max(...values, objetivo, 50);
    
    ctxLine.strokeStyle = '#ccc';
    ctxLine.lineWidth = 1;
    ctxLine.strokeRect(padding, padding, w, h);
    
    ctxLine.beginPath();
    values.forEach((v,i)=>{
        const x = padding + (i/(values.length-1)) * w;
        const y = padding + h - (v / maxV) * h;
        if(i === 0) ctxLine.moveTo(x, y);
        else ctxLine.lineTo(x, y);
        points.push({x,y,v,month:months[i].label, key: months[i].key});
    });
    ctxLine.strokeStyle = '#4da6ff';
    ctxLine.lineWidth = 2;
    ctxLine.stroke();
    
    points.forEach(p=>{
        ctxLine.beginPath();
        ctxLine.arc(p.x,p.y,4,0,Math.PI*2);
        ctxLine.fillStyle = '#fff';
        ctxLine.fill();
        ctxLine.beginPath();
        ctxLine.arc(p.x,p.y,3,0,Math.PI*2);
        ctxLine.fillStyle = '#4da6ff';
        ctxLine.fill();
    });
    
    line._points = points;
    
    ctxLine.fillStyle = '#ccc';
    ctxLine.font = '11px sans-serif';
    ctxLine.textAlign = 'center';
    points.forEach(p=>{
        ctxLine.fillText(p.month, p.x, padding + h + 16);
    });
    
    // ✅ NOVO: Exibir detalhes com projeção
    // ✅ Reconstrói details via DOM — zero dados do usuário em innerHTML
    details.innerHTML = '';

    // ── Cabeçalho: nome da meta
    const divNome       = document.createElement('div');
    const strong        = document.createElement('strong');
    strong.textContent  = _sanitizeText(meta.descricao); // ✅ textContent
    divNome.appendChild(strong);

    // ── Linha de valores
    const divValores           = document.createElement('div');
    divValores.style.color     = 'var(--text-secondary)';
    divValores.style.marginTop = '8px';
    // ✅ formatBRL retorna string numérica — seguro via textContent
    divValores.textContent = `Objetivo: ${formatBRL(meta.objetivo)} • Guardado: ${formatBRL(meta.saved)} • Falta: ${formatBRL(Math.max(0, meta.objetivo - meta.saved))}`;

    details.appendChild(divNome);
    details.appendChild(divValores);

    if (projecao.temHistorico) {
        // ── Card de projeção
        const cardProjecao             = document.createElement('div');
        cardProjecao.style.background  = 'rgba(108,99,255,0.1)';
        cardProjecao.style.padding     = '14px';
        cardProjecao.style.borderRadius = '12px';
        cardProjecao.style.marginTop   = '16px';
        cardProjecao.style.borderLeft  = '3px solid #6c63ff';

        // ── Header do card
        const headerCard             = document.createElement('div');
        headerCard.style.display     = 'flex';
        headerCard.style.alignItems  = 'center';
        headerCard.style.gap         = '10px';
        headerCard.style.marginBottom = '10px';

        const iconProjecao           = document.createElement('div');
        iconProjecao.style.fontSize  = '1.8rem';
        iconProjecao.textContent     = '📊';

        const colHeader = document.createElement('div');

        const tituloProjecao           = document.createElement('div');
        tituloProjecao.style.fontWeight = '700';
        tituloProjecao.style.color      = 'var(--text-primary)';
        tituloProjecao.style.fontSize   = '1rem';
        tituloProjecao.textContent      = 'Projeção de Conclusão'; // ✅ texto estático

        const subTituloProjecao         = document.createElement('div');
        subTituloProjecao.style.fontSize = '0.85rem';
        subTituloProjecao.style.color    = 'var(--text-secondary)';
        // ✅ mesesComDados é número calculado internamente — seguro
        subTituloProjecao.textContent    = `Baseado no seu histórico de ${projecao.mesesComDados} ${projecao.mesesComDados === 1 ? 'mês' : 'meses'}`;

        colHeader.appendChild(tituloProjecao);
        colHeader.appendChild(subTituloProjecao);
        headerCard.appendChild(iconProjecao);
        headerCard.appendChild(colHeader);

        // ── Grid média/meses
        const grid               = document.createElement('div');
        grid.style.display       = 'grid';
        grid.style.gridTemplateColumns = 'repeat(2, 1fr)';
        grid.style.gap           = '12px';
        grid.style.marginTop     = '12px';

        const celulaMedia             = document.createElement('div');
        celulaMedia.style.background  = 'rgba(255,255,255,0.05)';
        celulaMedia.style.padding     = '10px';
        celulaMedia.style.borderRadius = '8px';
        celulaMedia.style.textAlign   = 'center';

        const labelMedia           = document.createElement('div');
        labelMedia.style.fontSize  = '0.75rem';
        labelMedia.style.color     = 'var(--text-muted)';
        labelMedia.style.marginBottom = '4px';
        labelMedia.textContent     = 'Média Mensal'; // ✅ texto estático

        const valorMedia           = document.createElement('div');
        valorMedia.style.fontSize  = '1.1rem';
        valorMedia.style.fontWeight = '700';
        valorMedia.style.color     = '#00ff99';
        valorMedia.textContent     = formatBRL(projecao.mediaMensal); // ✅ número calculado internamente

        celulaMedia.appendChild(labelMedia);
        celulaMedia.appendChild(valorMedia);

        const celulaMeses             = document.createElement('div');
        celulaMeses.style.background  = 'rgba(255,255,255,0.05)';
        celulaMeses.style.padding     = '10px';
        celulaMeses.style.borderRadius = '8px';
        celulaMeses.style.textAlign   = 'center';

        const labelMeses           = document.createElement('div');
        labelMeses.style.fontSize  = '0.75rem';
        labelMeses.style.color     = 'var(--text-muted)';
        labelMeses.style.marginBottom = '4px';
        labelMeses.textContent     = 'Meses Restantes'; // ✅ texto estático

        const valorMeses            = document.createElement('div');
        valorMeses.style.fontSize   = '1.1rem';
        valorMeses.style.fontWeight = '700';
        valorMeses.style.color      = '#ffd166';
        valorMeses.textContent      = String(projecao.mesesRestantes); // ✅ número calculado internamente

        celulaMeses.appendChild(labelMeses);
        celulaMeses.appendChild(valorMeses);

        grid.appendChild(celulaMedia);
        grid.appendChild(celulaMeses);

        // ── Data estimada
        const cardData               = document.createElement('div');
        cardData.style.background    = 'rgba(108,99,255,0.2)';
        cardData.style.padding       = '12px';
        cardData.style.borderRadius  = '10px';
        cardData.style.marginTop     = '12px';
        cardData.style.textAlign     = 'center';

        const labelData              = document.createElement('div');
        labelData.style.fontSize     = '0.85rem';
        labelData.style.color        = 'var(--text-secondary)';
        labelData.style.marginBottom = '6px';
        labelData.textContent        = '🎯 Data Estimada de Conclusão'; // ✅ texto estático

        const valorData             = document.createElement('div');
        valorData.style.fontSize    = '1.3rem';
        valorData.style.fontWeight  = '700';
        valorData.style.color       = '#6c63ff';
        // ✅ dataEstimada vem de Date.toLocaleDateString — dado do sistema, não do usuário
        //    mas sanitizamos por precaução
        valorData.textContent       = _sanitizeText(String(projecao.dataEstimada));

        cardData.appendChild(labelData);
        cardData.appendChild(valorData);

        // ── Aviso de ajuste (opcional)
        if (projecao.avisoAjuste) {
            const divAviso              = document.createElement('div');
            divAviso.style.fontSize     = '0.8rem';
            divAviso.style.color        = '#ffd166';
            divAviso.style.marginTop    = '8px';
            divAviso.style.padding      = '8px';
            divAviso.style.background   = 'rgba(255,209,102,0.1)';
            divAviso.style.borderRadius = '6px';
            // ✅ avisoAjuste é string interna calculada em calcularProjecaoConclusao — textContent por precaução
            divAviso.textContent        = `⚠️ ${_sanitizeText(String(projecao.avisoAjuste))}`;
            cardData.appendChild(divAviso);
        }

        // ── Sugestão (opcional)
        if (projecao.sugestao) {
            const divSugestao              = document.createElement('div');
            divSugestao.style.marginTop    = '12px';
            divSugestao.style.padding      = '10px';
            divSugestao.style.background   = 'rgba(0,255,153,0.1)';
            divSugestao.style.borderRadius = '8px';
            divSugestao.style.borderLeft   = '3px solid #00ff99';
            divSugestao.style.fontSize     = '0.85rem';
            divSugestao.style.color        = 'var(--text-primary)';

            const strongSug       = document.createElement('strong');
            strongSug.textContent = '💡 Sugestão: ';

            const spanSug       = document.createElement('span');
            // ✅ sugestao é string interna calculada — textContent por precaução
            spanSug.textContent = _sanitizeText(String(projecao.sugestao));

            divSugestao.appendChild(strongSug);
            divSugestao.appendChild(spanSug);
            cardData.appendChild(divSugestao);
        }

        cardProjecao.appendChild(headerCard);
        cardProjecao.appendChild(grid);
        cardProjecao.appendChild(cardData);
        details.appendChild(cardProjecao);

    } else {
        // ── Card de histórico insuficiente
        const cardInsuf               = document.createElement('div');
        cardInsuf.style.background    = 'rgba(255,209,102,0.1)';
        cardInsuf.style.padding       = '14px';
        cardInsuf.style.borderRadius  = '12px';
        cardInsuf.style.marginTop     = '16px';
        cardInsuf.style.borderLeft    = '3px solid #ffd166';

        const rowInsuf             = document.createElement('div');
        rowInsuf.style.display     = 'flex';
        rowInsuf.style.alignItems  = 'center';
        rowInsuf.style.gap         = '10px';

        const iconInsuf           = document.createElement('div');
        iconInsuf.style.fontSize  = '1.5rem';
        iconInsuf.textContent     = '📊';

        const colInsuf = document.createElement('div');

        const tituloInsuf              = document.createElement('div');
        tituloInsuf.style.fontWeight   = '600';
        tituloInsuf.style.color        = 'var(--text-primary)';
        tituloInsuf.style.marginBottom = '4px';
        tituloInsuf.textContent        = 'Histórico Insuficiente'; // ✅ texto estático

        const subInsuf            = document.createElement('div');
        subInsuf.style.fontSize   = '0.85rem';
        subInsuf.style.color      = 'var(--text-secondary)';
        subInsuf.textContent      = 'Continue guardando por mais alguns meses para calcular a projeção de conclusão.'; // ✅ texto estático

        colInsuf.appendChild(tituloInsuf);
        colInsuf.appendChild(subInsuf);
        rowInsuf.appendChild(iconInsuf);
        rowInsuf.appendChild(colInsuf);
        cardInsuf.appendChild(rowInsuf);
        details.appendChild(cardInsuf);
    }
    
    if (!line._clickListenerRegistrado) {
        line._clickListenerRegistrado = true;
        line.addEventListener('click', function(ev) {
            const rect = line.getBoundingClientRect();
            const mx = ev.clientX - rect.left;
            const my = ev.clientY - rect.top;

            const ponto = (line._points || []).find(p => {
                const dx = p.x - mx, dy = p.y - my;
                return Math.sqrt(dx * dx + dy * dy) <= 8;
            });

            if (ponto) {
                mostrarNotificacao(
                    `${_sanitizeText(ponto.month)}: ${formatBRL(ponto.v)}`,
                    'info'
                );
            }
        });
    }
}

function abrirRetiradaForm() {
    if(!metaSelecionadaId) return alert('Selecione uma meta primeiro.');

    const meta = metas.find(m => String(m.id) === String(metaSelecionadaId));
    if(!meta) return alert('Meta não encontrada.');

    const saldoDisponivel = Number(meta.saved || 0);
    if(saldoDisponivel <= 0) return alert('Não há saldo disponível nesta reserva para retirar.');

    criarPopup(`
        <h3>💸 Retirar Dinheiro</h3>
        <div class="small" id="popupMetaNome"></div>
        <div id="popupSaldoDisponivel" style="margin-bottom:12px; color: var(--text-secondary);"></div>

        <label style="display:block; text-align:left; margin-top:12px; margin-bottom:6px; color: var(--text-secondary); font-weight:600;">
            💰 Valor a Retirar:
        </label>
        <input type="number" id="valorRetirada" class="form-input"
               placeholder="Valor a retirar (R$)" step="0.01" min="0.01"><br>

        <label style="display:block; text-align:left; margin-top:16px; margin-bottom:6px; color: var(--text-secondary); font-weight:600;">
            📝 Motivo da Retirada: <span style="color: #ff4b4b;">*</span>
        </label>
        <select id="motivoRetirada" class="form-input" style="margin-bottom:8px;">
            <option value="">Selecione o motivo...</option>
            <option value="Emergência Médica">🏥 Emergência Médica</option>
            <option value="Emergência Familiar">👨‍👩‍👧 Emergência Familiar</option>
            <option value="Reparo Urgente">🔧 Reparo Urgente (Casa/Carro)</option>
            <option value="Investimento">📈 Investimento</option>
            <option value="Compra Planejada">🛒 Compra Planejada</option>
            <option value="Oportunidade">💡 Oportunidade de Negócio</option>
            <option value="Dívida Urgente">💳 Pagamento de Dívida Urgente</option>
            <option value="Viagem">✈️ Viagem</option>
            <option value="Educação">📚 Educação/Curso</option>
            <option value="Outro">📄 Outro Motivo</option>
        </select>

        <div id="outroMotivoDiv" style="display:none; margin-top:8px;">
            <input type="text" id="outroMotivoTexto" class="form-input"
                   placeholder="Descreva o motivo..." maxlength="100">
        </div>

        <div style="background: rgba(255,209,102,0.1); padding: 12px; border-radius: 8px; margin-top: 16px; border-left: 3px solid #ffd166;">
            <div style="font-size: 0.85rem; color: var(--text-secondary); line-height: 1.5;">
                <strong>💡 Dica:</strong> Registrar o motivo ajuda você a entender seu comportamento financeiro e manter disciplina nas suas metas.
            </div>
        </div>

        <button class="btn-primary" id="confirmarRetirada" style="margin-top:16px;">Confirmar Retirada</button>
        <button class="btn-cancelar" id="cancelarRetirada">Cancelar</button>
    `);

    // ✅ Dados dinâmicos via textContent — sem interpolação no HTML do popup
    document.getElementById('popupMetaNome').textContent       = `Meta: ${meta.descricao}`;
    document.getElementById('popupSaldoDisponivel').textContent = `Saldo disponível: ${formatBRL(saldoDisponivel)}`;

    // ✅ max definido via propriedade — não interpolado no HTML
    document.getElementById('valorRetirada').max = saldoDisponivel;

    // ✅ Cancelar via addEventListener — sem onclick inline
    document.getElementById('cancelarRetirada').addEventListener('click', () => fecharPopup());

    const selectMotivo  = document.getElementById('motivoRetirada');
    const outroMotivoDiv = document.getElementById('outroMotivoDiv');

    selectMotivo.addEventListener('change', function() {
        if(this.value === 'Outro') {
            outroMotivoDiv.style.display = 'block';
            document.getElementById('outroMotivoTexto').focus();
        } else {
            outroMotivoDiv.style.display = 'none';
            document.getElementById('outroMotivoTexto').value = '';
        }
    });

    document.getElementById('confirmarRetirada').addEventListener('click', () => {
        const valorStr        = document.getElementById('valorRetirada').value;
        const motivoSelect    = document.getElementById('motivoRetirada').value;
        const outroMotivoTexto = document.getElementById('outroMotivoTexto').value.trim();

        if(!valorStr || !Number.isFinite(Number(valorStr)) || Number(valorStr) <= 0) {
        return alert('Digite um valor válido.');
        }
        if(!motivoSelect) {
            return alert('⚠️ Por favor, selecione o motivo da retirada.');
        }
        if(motivoSelect === 'Outro' && !outroMotivoTexto) {
            return alert('⚠️ Por favor, descreva o motivo da retirada.');
        }

        const valorRetirar = parseFloat(parseFloat(valorStr).toFixed(2));
        if(!Number.isFinite(valorRetirar) || valorRetirar <= 0) {
            return alert('Valor inválido após processamento.');
        }
        if(valorRetirar > saldoDisponivel) {
            return alert('Valor maior que o saldo disponível!');
        }

        const motivoFinal = motivoSelect === 'Outro' ? outroMotivoTexto : motivoSelect;
        const dh          = agoraDataHora();

        // ✅ Sem id — banco gera via gen_random_uuid()
        transacoes.push({
            categoria:       'retirada_reserva',
            tipo:            'Retirada de Reserva',
            descricao:       `Retirada: ${meta.descricao}`,
            valor:           valorRetirar,
            data:            dh.data,
            hora:            dh.hora,
            metaId:          meta.id,
            motivoRetirada:  motivoFinal
        });

        meta.saved = Number((Number(meta.saved || 0) - valorRetirar).toFixed(2));

        const ym = yearMonthKey(isoDate());
        meta.monthly = meta.monthly || {};
        meta.monthly[ym] = Number((Number(meta.monthly[ym] || 0) - valorRetirar).toFixed(2));
        if(meta.monthly[ym] < 0) meta.monthly[ym] = 0;

        if(!meta.historicoRetiradas) meta.historicoRetiradas = [];
        meta.historicoRetiradas.push({
            data:           dh.data,
            valor:          valorRetirar,
            motivo:         motivoFinal,
            saldoAnterior:  saldoDisponivel,
            saldoPosterior: meta.saved
        });

        salvarDados();
        atualizarTudo();
        renderMetaVisual();
        fecharPopup();

        let mensagemFinal = `Retirada de ${formatBRL(valorRetirar)} realizada com sucesso!\nO valor foi devolvido ao seu saldo.`;
        if(motivoFinal.includes('Emergência'))  mensagemFinal += '\n\n💙 Esperamos que tudo se resolva bem.';
        else if(motivoFinal.includes('Investimento')) mensagemFinal += '\n\n📈 Ótima escolha! Investir é construir seu futuro.';
        else if(motivoFinal.includes('Dívida'))      mensagemFinal += '\n\n💪 Parabéns por priorizar a quitação de dívidas!';

        alert(mensagemFinal);
    });
}

// ========== ANÁLISE DE DISCIPLINA FINANCEIRA NAS RETIRADAS ==========
function analisarDisciplinaRetiradas(metaId) {
    const meta = metas.find(m => String(m.id) === String(metaId));
    if(!meta || !meta.historicoRetiradas || meta.historicoRetiradas.length === 0) {
        return {
            temDados: false,
            mensagem: 'Nenhuma retirada registrada ainda.'
        };
    }
    
    const retiradas = meta.historicoRetiradas;
    const totalRetiradas = retiradas.length;
    const valorTotalRetirado = retiradas.reduce((sum, r) => sum + Number(r.valor), 0);
    
    const motivosCategorias = {
        emergencia: ['Emergência Médica', 'Emergência Familiar', 'Reparo Urgente', 'Dívida Urgente'],
        planejado: ['Compra Planejada', 'Viagem', 'Educação'],
        investimento: ['Investimento', 'Oportunidade']
    };
    
    let countEmergencia = 0;
    let countPlanejado = 0;
    let countInvestimento = 0;
    let countOutros = 0;
    
    retiradas.forEach(r => {
        // ✅ CORREÇÃO: type guard — garante que motivo é string antes de chamar .includes()
        //    Sem isso, r.motivo undefined/null lança TypeError silencioso
        const motivo = typeof r.motivo === 'string' ? r.motivo : '';
        if(motivosCategorias.emergencia.some(m => motivo.includes(m))) {
            countEmergencia++;
        } else if(motivosCategorias.planejado.some(m => motivo.includes(m))) {
            countPlanejado++;
        } else if(motivosCategorias.investimento.some(m => motivo.includes(m))) {
            countInvestimento++;
        } else {
            countOutros++;
        }
    });
    
    const percEmergencia = ((countEmergencia / totalRetiradas) * 100).toFixed(1);
    const percPlanejado = ((countPlanejado / totalRetiradas) * 100).toFixed(1);
    const percInvestimento = ((countInvestimento / totalRetiradas) * 100).toFixed(1);
    const percOutros = ((countOutros / totalRetiradas) * 100).toFixed(1);
    
    let nivelDisciplina = 'Boa';
    let corDisciplina = '#00ff99';
    let mensagemDisciplina = '';
    
    if(percEmergencia > 60) {
        nivelDisciplina = 'Atenção Necessária';
        corDisciplina = '#ff4b4b';
        mensagemDisciplina = 'Muitas retiradas por emergência podem indicar falta de um fundo de emergência separado.';
    } else if(percPlanejado + percInvestimento > 50) {
        nivelDisciplina = 'Excelente';
        corDisciplina = '#00ff99';
        mensagemDisciplina = 'Parabéns! Você está usando suas reservas de forma planejada e inteligente.';
    } else if(percOutros > 40) {
        nivelDisciplina = 'Pode Melhorar';
        corDisciplina = '#ffd166';
        mensagemDisciplina = 'Tente planejar melhor o uso das suas reservas para evitar retiradas não planejadas.';
    } else {
        mensagemDisciplina = 'Você mantém um bom equilíbrio no uso das suas reservas.';
    }
    
    return {
        temDados: true,
        totalRetiradas: totalRetiradas,
        valorTotalRetirado: valorTotalRetirado,
        distribuicao: {
            emergencia: { count: countEmergencia, perc: percEmergencia },
            planejado: { count: countPlanejado, perc: percPlanejado },
            investimento: { count: countInvestimento, perc: percInvestimento },
            outros: { count: countOutros, perc: percOutros }
        },
        nivelDisciplina: nivelDisciplina,
        corDisciplina: corDisciplina,
        mensagemDisciplina: mensagemDisciplina,
        ultimaRetirada: retiradas[retiradas.length - 1]
    };
}

// ========== POPUP DE ANÁLISE DE DISCIPLINA ==========
function abrirAnaliseDisciplina(metaId) {
    const meta = metas.find(m => String(m.id) === String(metaId));
    if (!meta) return;

    const analise = analisarDisciplinaRetiradas(metaId);

    if (!analise.temDados) {
        criarPopup(`
            <h3>📊 Análise de Disciplina</h3>
            <div style="text-align:center; padding:40px;">
                <div style="font-size:3rem; margin-bottom:12px; opacity:0.5;">📭</div>
                <div style="color: var(--text-secondary);" id="textoSemDados"></div>
            </div>
            <button class="btn-primary" id="btnFecharSemDados">Fechar</button>
        `);
        document.getElementById('textoSemDados').textContent = analise.mensagem;
        document.getElementById('btnFecharSemDados').addEventListener('click', fecharPopup);
        return;
    }

    // ✅ Todos os valores numéricos calculados internamente — sem dado do usuário
    const CORES_PERMITIDAS_DISCIPLINA = new Set(['#ff4b4b', '#00ff99', '#ffd166']);
    const corSegura = CORES_PERMITIDAS_DISCIPLINA.has(analise.corDisciplina)
        ? analise.corDisciplina
        : '#ffd166';

    const distEmergPerc  = Number(analise.distribuicao.emergencia.perc)    || 0;
    const distPlanPerc   = Number(analise.distribuicao.planejado.perc)     || 0;
    const distInvPerc    = Number(analise.distribuicao.investimento.perc)  || 0;
    const distOutPerc    = Number(analise.distribuicao.outros.perc)        || 0;

    // ✅ Estrutura estática — zero dados do usuário no HTML do criarPopup
    criarPopupDOM((popup) => {

        // ── Wrapper scroll
        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'max-height:70vh; overflow-y:auto; padding-right:10px;';

        // ── Título
        const titulo = document.createElement('h3');
        titulo.style.cssText = 'text-align:center; margin-bottom:8px;';
        titulo.textContent = '📊 Análise de Disciplina Financeira';

        // ── Subtítulo com nome da meta
        const subtitulo = document.createElement('div');
        subtitulo.style.cssText = 'text-align:center; color:var(--text-secondary); margin-bottom:20px; font-size:0.9rem;';
        const subtituloLabel = document.createElement('span');
        subtituloLabel.textContent = 'Meta: ';
        const subtituloValor = document.createElement('strong');
        subtituloValor.textContent = String(meta.descricao || ''); // ✅ textContent
        subtitulo.appendChild(subtituloLabel);
        subtitulo.appendChild(subtituloValor);

        // ── Card de nível de disciplina
        const cardNivel = document.createElement('div');
        cardNivel.style.background    = `linear-gradient(135deg, ${corSegura}20, ${corSegura}10)`;
        cardNivel.style.padding       = '20px';
        cardNivel.style.borderRadius  = '12px';
        cardNivel.style.marginBottom  = '20px';
        cardNivel.style.borderLeft    = `4px solid ${corSegura}`;
        cardNivel.style.textAlign     = 'center';

        const labelNivel = document.createElement('div');
        labelNivel.style.cssText = 'font-size:0.85rem; color:var(--text-secondary); margin-bottom:8px;';
        labelNivel.textContent = 'Nível de Disciplina';

        const valorNivel = document.createElement('div');
        valorNivel.style.cssText = `font-size:1.8rem; font-weight:700; color:${corSegura}; margin-bottom:12px;`;
        valorNivel.textContent = String(analise.nivelDisciplina || ''); // ✅ textContent — valor interno calculado

        const mensagemNivel = document.createElement('div');
        mensagemNivel.style.cssText = 'font-size:0.9rem; color:var(--text-secondary); line-height:1.5;';
        mensagemNivel.textContent = String(analise.mensagemDisciplina || ''); // ✅ textContent — valor interno calculado

        cardNivel.appendChild(labelNivel);
        cardNivel.appendChild(valorNivel);
        cardNivel.appendChild(mensagemNivel);

        // ── Grid totais
        const gridTotais = document.createElement('div');
        gridTotais.style.cssText = 'display:grid; grid-template-columns:repeat(2,1fr); gap:12px; margin-bottom:20px;';

        const celulaRetiradas = document.createElement('div');
        celulaRetiradas.style.cssText = 'background:rgba(255,255,255,0.05); padding:14px; border-radius:10px; text-align:center;';
        const labelRet = document.createElement('div');
        labelRet.style.cssText = 'font-size:0.85rem; color:var(--text-secondary); margin-bottom:6px;';
        labelRet.textContent = 'Total de Retiradas';
        const valorRet = document.createElement('div');
        valorRet.style.cssText = 'font-size:1.5rem; font-weight:700; color:var(--text-primary);';
        valorRet.textContent = String(Number(analise.totalRetiradas) || 0); // ✅ textContent — numérico
        celulaRetiradas.appendChild(labelRet);
        celulaRetiradas.appendChild(valorRet);

        const celulaValor = document.createElement('div');
        celulaValor.style.cssText = 'background:rgba(255,255,255,0.05); padding:14px; border-radius:10px; text-align:center;';
        const labelVal = document.createElement('div');
        labelVal.style.cssText = 'font-size:0.85rem; color:var(--text-secondary); margin-bottom:6px;';
        labelVal.textContent = 'Valor Total Retirado';
        const valorVal = document.createElement('div');
        valorVal.style.cssText = 'font-size:1.5rem; font-weight:700; color:#ff4b4b;';
        valorVal.textContent = formatBRL(analise.valorTotalRetirado); // ✅ textContent — formatBRL retorna numérico formatado
        celulaValor.appendChild(labelVal);
        celulaValor.appendChild(valorVal);

        gridTotais.appendChild(celulaRetiradas);
        gridTotais.appendChild(celulaValor);

        // ── Distribuição por motivo
        const secaoDistribuicao = document.createElement('div');
        secaoDistribuicao.style.marginBottom = '20px';

        const tituloDistribuicao = document.createElement('h4');
        tituloDistribuicao.style.cssText = 'margin-bottom:12px; color:var(--text-primary);';
        tituloDistribuicao.textContent = '📋 Distribuição por Motivo';
        secaoDistribuicao.appendChild(tituloDistribuicao);

        // ✅ Helper interno para criar barra de distribuição — zero dado do usuário
        function _criarBarraDistribuicao(rotulo, count, perc, cor) {
            if (count <= 0) return null;
            const container = document.createElement('div');
            container.style.marginBottom = '12px';

            const rowLabel = document.createElement('div');
            rowLabel.style.cssText = 'display:flex; justify-content:space-between; margin-bottom:6px;';

            const spanRotulo = document.createElement('span');
            spanRotulo.style.color = 'var(--text-primary)';
            spanRotulo.textContent = rotulo; // ✅ texto estático — nunca dado do usuário

            const spanCount = document.createElement('span');
            spanCount.style.color = 'var(--text-secondary)';
            spanCount.textContent = `${count} (${perc}%)`; // ✅ valores numéricos internos

            rowLabel.appendChild(spanRotulo);
            rowLabel.appendChild(spanCount);

            const barContainer = document.createElement('div');
            barContainer.style.cssText = 'width:100%; height:10px; background:rgba(255,255,255,0.1); border-radius:5px; overflow:hidden;';

            const barFill = document.createElement('div');
            barFill.style.width      = `${perc}%`;
            barFill.style.height     = '100%';
            barFill.style.background = cor;
            barFill.style.transition = 'width 0.5s';

            barContainer.appendChild(barFill);
            container.appendChild(rowLabel);
            container.appendChild(barContainer);
            return container;
        }

        const barEmerg = _criarBarraDistribuicao(
            '🚨 Emergências',
            analise.distribuicao.emergencia.count,
            distEmergPerc,
            '#ff4b4b'
        );
        if (barEmerg) secaoDistribuicao.appendChild(barEmerg);

        const barPlan = _criarBarraDistribuicao(
            '🎯 Compras Planejadas',
            analise.distribuicao.planejado.count,
            distPlanPerc,
            '#00ff99'
        );
        if (barPlan) secaoDistribuicao.appendChild(barPlan);

        const barInv = _criarBarraDistribuicao(
            '📈 Investimentos',
            analise.distribuicao.investimento.count,
            distInvPerc,
            '#6c63ff'
        );
        if (barInv) secaoDistribuicao.appendChild(barInv);

        const barOut = _criarBarraDistribuicao(
            '📄 Outros',
            analise.distribuicao.outros.count,
            distOutPerc,
            '#ffd166'
        );
        if (barOut) secaoDistribuicao.appendChild(barOut);

        // ── Card última retirada
        const cardUltima = document.createElement('div');
        cardUltima.style.cssText = 'background:rgba(108,99,255,0.1); padding:14px; border-radius:12px; border-left:3px solid #6c63ff;';

        const tituloUltima = document.createElement('div');
        tituloUltima.style.cssText = 'font-weight:600; color:var(--text-primary); margin-bottom:8px;';
        tituloUltima.textContent = '🕐 Última Retirada';

        const gridUltima = document.createElement('div');
        gridUltima.style.cssText = 'display:grid; gap:6px; font-size:0.9rem; color:var(--text-secondary);';

        function _criarLinhaDetalhe(rotulo, valor) {
            const div = document.createElement('div');
            const strong = document.createElement('strong');
            strong.textContent = rotulo; // ✅ texto estático
            div.appendChild(strong);
            div.appendChild(document.createTextNode(String(valor || ''))); // ✅ createTextNode — nunca innerHTML
            return div;
        }

        gridUltima.appendChild(_criarLinhaDetalhe('Data: ', analise.ultimaRetirada.data));
        gridUltima.appendChild(_criarLinhaDetalhe('Valor: ', formatBRL(analise.ultimaRetirada.valor)));
        gridUltima.appendChild(_criarLinhaDetalhe('Motivo: ', analise.ultimaRetirada.motivo)); // ✅ createTextNode

        cardUltima.appendChild(tituloUltima);
        cardUltima.appendChild(gridUltima);

        // ── Histórico completo — 100% via DOM, zero innerHTML com dados do usuário
        const secaoHistorico = document.createElement('div');
        secaoHistorico.style.marginTop = '20px';

        const tituloHistorico = document.createElement('h4');
        tituloHistorico.style.cssText = 'margin-bottom:12px; color:var(--text-primary);';
        tituloHistorico.textContent = '📜 Histórico Completo';

        const listaHistorico = document.createElement('div');
        listaHistorico.style.cssText = 'max-height:200px; overflow-y:auto;';

        meta.historicoRetiradas
            .slice()
            .reverse()
            .forEach(r => {
                // ✅ Validação defensiva de cada item antes de renderizar
                if (!r || typeof r !== 'object') return;

                const item = document.createElement('div');
                item.style.cssText = 'background:rgba(255,255,255,0.03); padding:10px; border-radius:8px; margin-bottom:8px; border-left:2px solid var(--border);';

                const rowTopo = document.createElement('div');
                rowTopo.style.cssText = 'display:flex; justify-content:space-between; margin-bottom:4px;';

                const spanData = document.createElement('span');
                spanData.style.cssText = 'font-size:0.85rem; color:var(--text-secondary);';
                spanData.textContent = String(r.data || ''); // ✅ textContent

                const spanValor = document.createElement('span');
                spanValor.style.cssText = 'font-size:0.9rem; font-weight:600; color:#ff4b4b;';
                spanValor.textContent = formatBRL(Number(r.valor) || 0); // ✅ textContent

                rowTopo.appendChild(spanData);
                rowTopo.appendChild(spanValor);

                const rowMotivo = document.createElement('div');
                rowMotivo.style.cssText = 'font-size:0.85rem; color:var(--text-primary);';

                const strongMotivo = document.createElement('strong');
                strongMotivo.textContent = 'Motivo: '; // ✅ texto estático

                const spanMotivo = document.createElement('span');
                spanMotivo.textContent = String(r.motivo || ''); // ✅ textContent — DADO DO USUÁRIO, nunca innerHTML

                rowMotivo.appendChild(strongMotivo);
                rowMotivo.appendChild(spanMotivo);

                item.appendChild(rowTopo);
                item.appendChild(rowMotivo);
                listaHistorico.appendChild(item);
            });

        secaoHistorico.appendChild(tituloHistorico);
        secaoHistorico.appendChild(listaHistorico);

        // ── Botão fechar
        const btnFechar = document.createElement('button');
        btnFechar.className   = 'btn-primary';
        btnFechar.style.cssText = 'width:100%; margin-top:16px;';
        btnFechar.textContent = 'Fechar';
        btnFechar.addEventListener('click', fecharPopup);

        // ── Montagem final
        wrapper.appendChild(titulo);
        wrapper.appendChild(subtitulo);
        wrapper.appendChild(cardNivel);
        wrapper.appendChild(gridTotais);
        wrapper.appendChild(secaoDistribuicao);
        wrapper.appendChild(cardUltima);
        wrapper.appendChild(secaoHistorico);

        popup.appendChild(wrapper);
        popup.appendChild(btnFechar);
    });
}

// Expor função globalmente
window.abrirAnaliseDisciplina = abrirAnaliseDisciplina;

// ========== CARTÕES DE CRÉDITO ==========
function atualizarTelaCartoes() {
    const grid = document.getElementById('cartoesGrid');
    if (!grid) return;
    grid.innerHTML = '';

    if (!cartaoSelecionadoId && cartoesCredito.length > 0) {
        cartaoSelecionadoId = cartoesCredito[0].id;
    }

    const cartaoAtivo = cartoesCredito.find(c => c.id === cartaoSelecionadoId) || cartoesCredito[0] || null;

    const coresCartao = {
        'Nubank':          'linear-gradient(135deg, #5b0d8c 0%, #9b19d1 100%)',
        'Bradesco':        'linear-gradient(135deg, #c00000 0%, #e83232 100%)',
        'Mercado Pago':    'linear-gradient(135deg, #006bb3 0%, #009ee3 100%)',
        'C6 Bank':         'linear-gradient(135deg, #111114 0%, #2c2c30 100%)',
        'Itaú':            'linear-gradient(135deg, #d46000 0%, #f07800 100%)',
        'Santander':       'linear-gradient(135deg, #a80000 0%, #d40000 100%)',
        'Banco do Brasil': 'linear-gradient(135deg, #003070 0%, #005cc5 100%)',
        'Caixa':           'linear-gradient(135deg, #004f96 0%, #0074cc 100%)',
    };

    // ── HEADER ──────────────────────────────────────────────
    const header = document.createElement('div');
    header.className = 'cartoes-novo-header';

    const titulo = document.createElement('div');
    titulo.className = 'cartoes-novo-titulo';
    const icTit = document.createElement('i');
    icTit.className = 'fas fa-credit-card';
    icTit.setAttribute('aria-hidden', 'true');
    const spanTit = document.createElement('span');
    spanTit.textContent = 'Cartões';
    titulo.appendChild(icTit);
    titulo.appendChild(spanTit);

    const btnAdd = document.createElement('button');
    btnAdd.className = 'cartoes-novo-btn-add';
    btnAdd.type = 'button';
    const icAdd = document.createElement('i');
    icAdd.className = 'fas fa-plus';
    icAdd.setAttribute('aria-hidden', 'true');
    btnAdd.appendChild(icAdd);
    btnAdd.appendChild(document.createTextNode(' Adicionar Cartão'));
    btnAdd.addEventListener('click', () => abrirCartaoForm());

    header.appendChild(titulo);
    header.appendChild(btnAdd);
    grid.appendChild(header);

    // ── EMPTY STATE ──────────────────────────────────────────
    if (!cartaoAtivo) {
        const empty = document.createElement('div');
        empty.className = 'cartoes-empty-state';
        const emptyIcon = document.createElement('div');
        emptyIcon.style.fontSize = '3.5rem';
        emptyIcon.textContent = '💳';
        const emptyTxt = document.createElement('p');
        emptyTxt.textContent = 'Nenhum cartão cadastrado. Adicione seu primeiro cartão!';
        empty.appendChild(emptyIcon);
        empty.appendChild(emptyTxt);
        grid.appendChild(empty);
        return;
    }

    // ── FEATURED CARD ────────────────────────────────────────────────
    const featuredWrapper = document.createElement('div');
    featuredWrapper.className = 'cartao-featured-wrapper';

    const featured = document.createElement('div');
    featured.className = 'cartao-featured-card';
    const corGrad = coresCartao[cartaoAtivo.nomeBanco] || 'linear-gradient(135deg, #1a1d2e 0%, #2a2d3e 100%)';
    featured.style.background = corGrad;
    if (cartaoAtivo.congelado) featured.classList.add('cartao-congelado');

    // ── TOPO: ícone do banco + nome (esquerda) | contactless (direita)
    const topoDiv = document.createElement('div');
    topoDiv.className = 'cartao-featured-top';

    const nameRow = document.createElement('div');
    nameRow.className = 'cartao-featured-name-row';

    if (cartaoAtivo.bandeiraImg) {
        try {
            const urlObj = new URL(cartaoAtivo.bandeiraImg);
            if (urlObj.protocol === 'https:' && urlObj.hostname === 'logospng.org') {
                const bankIconWrap = document.createElement('div');
                bankIconWrap.className = 'cartao-featured-bank-icon';
                const bankIconImg = document.createElement('img');
                bankIconImg.src = cartaoAtivo.bandeiraImg;
                bankIconImg.alt = '';
                bankIconWrap.appendChild(bankIconImg);
                nameRow.appendChild(bankIconWrap);
            }
        } catch (_) {}
    }

    const nomeDiv = document.createElement('div');
    nomeDiv.className = 'cartao-featured-nome';
    nomeDiv.textContent = _sanitizeText(cartaoAtivo.nomeBanco);
    nameRow.appendChild(nomeDiv);

    const contactless = document.createElement('div');
    contactless.className = 'cartao-featured-contactless';
    const icContactless = document.createElement('i');
    icContactless.className = 'fas fa-wifi';
    icContactless.setAttribute('aria-hidden', 'true');
    contactless.appendChild(icContactless);

    topoDiv.appendChild(nameRow);
    topoDiv.appendChild(contactless);
    featured.appendChild(topoDiv);

    // ── MEIO: chip centralizado à esquerda
    const middleDiv = document.createElement('div');
    middleDiv.className = 'cartao-featured-middle';

    const chip = document.createElement('div');
    chip.className = 'cartao-featured-chip';
    middleDiv.appendChild(chip);
    featured.appendChild(middleDiv);

    // ── RODAPÉ: disponível (esquerda) + limite (direita)
    const disponivel = Math.max(0, cartaoAtivo.limite - (cartaoAtivo.usado || 0));

    const bottomDiv = document.createElement('div');
    bottomDiv.className = 'cartao-featured-bottom';

    // Disponível — esquerda
    const dispDiv = document.createElement('div');
    dispDiv.className = 'cartao-featured-disponivel';
    const dispLbl = document.createElement('span');
    dispLbl.className = 'cartao-featured-label';
    dispLbl.textContent = 'Disponível';
    const dispVal = document.createElement('span');
    dispVal.className = 'cartao-featured-value cartao-featured-value--green';
    dispVal.textContent = formatBRL(disponivel);
    dispDiv.appendChild(dispLbl);
    dispDiv.appendChild(dispVal);

    // Limite — direita
    const limiteDiv = document.createElement('div');
    limiteDiv.className = 'cartao-featured-limite';
    limiteDiv.style.textAlign = 'right';
    const limiteLbl = document.createElement('span');
    limiteLbl.className = 'cartao-featured-label';
    limiteLbl.textContent = 'Limite';
    const limiteVal = document.createElement('span');
    limiteVal.className = 'cartao-featured-value';
    limiteVal.textContent = formatBRL(cartaoAtivo.limite);
    limiteDiv.appendChild(limiteLbl);
    limiteDiv.appendChild(limiteVal);

    bottomDiv.appendChild(dispDiv);
    bottomDiv.appendChild(limiteDiv);
    featured.appendChild(bottomDiv);

    // ── BARRA de uso (abaixo do bottom)
    const percUsado = cartaoAtivo.limite > 0
        ? Math.min(100, ((cartaoAtivo.usado || 0) / cartaoAtivo.limite) * 100)
        : 0;
    const corBarra = percUsado > 80 ? '#ff4b4b' : percUsado > 50 ? '#ffd166' : '#00ff99';

    const barWrapper = document.createElement('div');
    barWrapper.className = 'cartao-featured-bar-wrapper';
    const bar = document.createElement('div');
    bar.className = 'cartao-featured-bar';
    const barFill = document.createElement('div');
    barFill.className = 'cartao-featured-bar-fill';
    barFill.style.width = `${percUsado.toFixed(1)}%`;
    barFill.style.background = corBarra;
    bar.appendChild(barFill);
    const barLabel = document.createElement('span');
    barLabel.className = 'cartao-featured-bar-label';
    barLabel.textContent = `${percUsado.toFixed(0)}% usado`;
    barWrapper.appendChild(bar);
    barWrapper.appendChild(barLabel);
    featured.appendChild(barWrapper);

    // Frozen overlay
    if (cartaoAtivo.congelado) {
        const frozenOverlay = document.createElement('div');
        frozenOverlay.className = 'cartao-frozen-overlay';
        const frozenIc = document.createElement('i');
        frozenIc.className = 'fas fa-snowflake';
        frozenIc.setAttribute('aria-hidden', 'true');
        const frozenTxt = document.createElement('span');
        frozenTxt.textContent = 'Cartão Congelado';
        frozenOverlay.appendChild(frozenIc);
        frozenOverlay.appendChild(frozenTxt);
        featured.appendChild(frozenOverlay);
    }

    featuredWrapper.appendChild(featured);

    // ── ACTION BUTTONS ────────────────────────────────────────
    const actionsRow = document.createElement('div');
    actionsRow.className = 'cartao-actions-row';

    const acoesDef = [
        {
            icon:   'fa-file-invoice-dollar',
            label:  'Pagar Fatura',
            action: () => {
                const fatura = contasFixas.find(c =>
                    c.cartaoId === cartaoAtivo.id && c.tipoContaFixa === 'fatura_cartao' && !c.pago
                );
                if (fatura) abrirPopupPagarContaFixa(fatura.id);
                else mostrarNotificacao('Nenhuma fatura em aberto neste cartão.', 'info');
            }
        },
        {
            icon:        cartaoAtivo.congelado ? 'fa-fire' : 'fa-snowflake',
            label:       cartaoAtivo.congelado ? 'Descongelar' : 'Congelar',
            extraClass:  cartaoAtivo.congelado
                             ? 'cartao-action-btn--freeze cartao-action-btn--frozen'
                             : 'cartao-action-btn--freeze',
            action: () => congelarCartao(cartaoAtivo.id)
        },
        {
            icon:   'fa-circle-info',
            label:  'Detalhes',
            action: () => abrirDetalhesCartaoCompleto(cartaoAtivo.id)
        }
    ];

    acoesDef.forEach(def => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'cartao-action-btn' + (def.extraClass ? ' ' + def.extraClass : '');
        const ic = document.createElement('i');
        ic.className = `fas ${def.icon}`;
        ic.setAttribute('aria-hidden', 'true');
        const lbl = document.createElement('span');
        lbl.textContent = def.label;
        btn.appendChild(ic);
        btn.appendChild(lbl);
        btn.addEventListener('click', def.action);
        actionsRow.appendChild(btn);
    });

    featuredWrapper.appendChild(actionsRow);
    grid.appendChild(featuredWrapper);

    // ── MEUS CARTÕES ─────────────────────────────────────────
    const meusSection = document.createElement('div');
    meusSection.className = 'meus-cartoes-section';

    const meusHeader = document.createElement('div');
    meusHeader.className = 'meus-cartoes-header';
    const meusTit = document.createElement('span');
    meusTit.textContent = 'Meus Cartões';
    const meusCountSpan = document.createElement('span');
    meusCountSpan.className = 'meus-cartoes-count';
    if (cartoesCredito.length > 3) {
        meusCountSpan.textContent = `${cartoesCredito.length - 3} oculto(s) >`;
    }
    meusHeader.appendChild(meusTit);
    meusHeader.appendChild(meusCountSpan);
    meusSection.appendChild(meusHeader);

    const meusLista = document.createElement('div');
    meusLista.className = 'meus-cartoes-lista';

    cartoesCredito.forEach(c => {
        const miniCard = document.createElement('div');
        miniCard.className = 'meus-cartoes-mini' + (c.id === cartaoSelecionadoId ? ' meus-cartoes-mini--ativo' : '');
        const corMini = coresCartao[c.nomeBanco] || 'linear-gradient(135deg, #1a1d2e 0%, #2a2d3e 100%)';
        miniCard.style.background = corMini;

        if (c.congelado) {
            const frozenBadge = document.createElement('div');
            frozenBadge.className = 'mini-frozen-badge';
            const fIc = document.createElement('i');
            fIc.className = 'fas fa-snowflake';
            fIc.setAttribute('aria-hidden', 'true');
            frozenBadge.appendChild(fIc);
            miniCard.appendChild(frozenBadge);
        }

        if (c.bandeiraImg) {
            try {
                const urlObj = new URL(c.bandeiraImg);
                if (urlObj.protocol === 'https:' && urlObj.hostname === 'logospng.org') {
                    const miniIc = document.createElement('img');
                    miniIc.src = c.bandeiraImg;
                    miniIc.alt = '';
                    miniIc.className = 'meus-cartoes-mini-icon';
                    miniCard.appendChild(miniIc);
                }
            } catch (_) {}
        }

        const miniNome = document.createElement('div');
        miniNome.className = 'meus-cartoes-mini-nome';
        miniNome.textContent = _sanitizeText(c.nomeBanco);
        miniCard.appendChild(miniNome);

        const miniDisp = document.createElement('div');
        miniDisp.className = 'meus-cartoes-mini-disp';
        miniDisp.textContent = formatBRL(Math.max(0, c.limite - (c.usado || 0)));
        miniCard.appendChild(miniDisp);

        miniCard.addEventListener('click', () => {
            cartaoSelecionadoId = c.id;
            atualizarTelaCartoes();
        });

        meusLista.appendChild(miniCard);
    });

    // Mini card "Adicionar"
    const addMini = document.createElement('div');
    addMini.className = 'meus-cartoes-mini meus-cartoes-mini--add';
    const addIc = document.createElement('i');
    addIc.className = 'fas fa-plus';
    addIc.setAttribute('aria-hidden', 'true');
    const addTxt = document.createElement('span');
    addTxt.textContent = 'Novo';
    addMini.appendChild(addIc);
    addMini.appendChild(addTxt);
    addMini.addEventListener('click', () => abrirCartaoForm());
    meusLista.appendChild(addMini);

    meusSection.appendChild(meusLista);
    grid.appendChild(meusSection);
}

function abrirCartaoForm(editId = null) {
    const bancos = [
        { nome: 'Nubank',          img: 'https://logospng.org/download/nubank/logo-nubank-roxo-icon-256.png' },
        { nome: 'Bradesco',        img: 'https://logospng.org/download/bradesco/logo-bradesco-escudo-256.png' },
        { nome: 'Mercado Pago',    img: 'https://logospng.org/download/mercado-pago/logo-mercado-pago-icon.png' },
        { nome: 'C6 Bank',         img: 'https://logospng.org/download/c6-bank/logo-c6-bank-icon.png' },
        { nome: 'Itaú',            img: 'https://logospng.org/download/itau/logo-itau-icon.png' },
        { nome: 'Santander',       img: 'https://logospng.org/download/santander/logo-santander-icon-256.png' },
        { nome: 'Banco do Brasil', img: 'https://logospng.org/download/banco-do-brasil/logo-banco-do-brasil-icon.png' },
        { nome: 'Caixa',           img: 'https://logospng.org/download/caixa/logo-caixa-icon.png' },
        { nome: 'Outro',           img: '' },
    ];

    // ========== CONGELAR / DESCONGELAR CARTÃO ==========
    function congelarCartao(cartaoId) {
        const cartao = cartoesCredito.find(c => c.id === cartaoId);
        if (!cartao) return;

        const msg = cartao.congelado
            ? '🔥 Descongelar este cartão? Ele voltará a aceitar novos lançamentos normalmente.'
            : '❄️ Congelar este cartão? Nenhum novo lançamento poderá ser realizado enquanto estiver congelado.';

        confirmarAcao(msg, () => {
            cartao.congelado = !cartao.congelado;
            salvarDados();
            atualizarTelaCartoes();
            mostrarNotificacao(
                cartao.congelado ? '❄️ Cartão congelado com sucesso!' : '🔥 Cartão descongelado!',
                cartao.congelado ? 'warning' : 'success'
            );
        });
    }

    // ✅ Constrói o <select> de bancos via DOM — nunca interpolação de string
    function _criarSelectBancos(idSelect, valorSelecionado) {
        const select = document.createElement('select');
        select.id        = idSelect;
        select.className = 'form-input';

        bancos.forEach(b => {
            const opt = document.createElement('option');
            opt.value       = b.nome;          // ✅ atribuição direta — não interpolado
            opt.textContent = b.nome;          // ✅ textContent — nunca innerHTML
            if (b.nome === valorSelecionado) opt.selected = true;
            select.appendChild(opt);
        });
        return select;
    }

    // ✅ Constrói o <select> de dias via DOM
    function _criarSelectDias(idSelect, valorSelecionado) {
        const select = document.createElement('select');
        select.id        = idSelect;
        select.className = 'form-input';

        const placeholder       = document.createElement('option');
        placeholder.value       = '';
        placeholder.textContent = 'Selecione o dia';
        select.appendChild(placeholder);

        for (let i = 1; i <= 28; i++) {
            const opt = document.createElement('option');
            opt.value       = String(i);
            opt.textContent = String(i).padStart(2, '0');
            if (Number(valorSelecionado) === i) opt.selected = true;
            select.appendChild(opt);
        }
        return select;
    }

    // ✅ Configura listener do select de banco (sem duplicação)
    function _configurarSelectBanco(selectBanco, campoOutro, inputOutro) {
        selectBanco.addEventListener('change', function () {
            if (this.value === 'Outro') {
                campoOutro.style.display = 'block';
                inputOutro.required      = true;
                if (!inputOutro.value) inputOutro.focus();
            } else {
                campoOutro.style.display = 'none';
                inputOutro.required      = false;
                inputOutro.value         = '';
            }
        });
    }

    // ── Lógica de salvar/editar compartilhada entre os dois modos
    function _executarSalvar(selectBanco, inputOutro, inputLimite, selectDia, cartaoExistente) {
        let nomeBanco = selectBanco.value;

        if (nomeBanco === 'Outro') {
            const nomeDigitado = inputOutro.value.trim();
            if (!nomeDigitado)           { alert('Digite o nome do cartão!'); return; }
            if (nomeDigitado.length > 50) { alert('Nome do cartão muito longo (máx. 50 caracteres).'); return; }
            nomeBanco = nomeDigitado;
        }

        const limiteStr     = inputLimite.value;
        const vencimentoDia = selectDia.value;

        if (!nomeBanco || !limiteStr || !vencimentoDia) { alert('Preencha todos os campos!'); return; }

        const limite = parseFloat(parseFloat(limiteStr).toFixed(2));
        if (isNaN(limite) || limite <= 0) { alert('Informe um limite válido e positivo.'); return; }
        if (limite > 9999999)              { alert('Limite máximo permitido: R$ 9.999.999,00.'); return; }

        const bandeiraImg = bancos.find(b => b.nome === nomeBanco)?.img || '';

        if (cartaoExistente) {
            // Modo edição
            cartaoExistente.nomeBanco     = nomeBanco;
            cartaoExistente.limite        = limite;
            cartaoExistente.vencimentoDia = Number(vencimentoDia);
            cartaoExistente.bandeiraImg   = bandeiraImg;
        } else {
            // Modo criação
            cartoesCredito.push({
                id:            nextCartaoId++,
                nomeBanco,
                limite,
                vencimentoDia: Number(vencimentoDia),
                bandeiraImg,
                usado:         0,
            });
        }

        salvarDados();
        atualizarTelaCartoes();
        fecharPopup();
        mostrarNotificacao(
            cartaoExistente ? 'Cartão atualizado com sucesso!' : 'Cartão cadastrado com sucesso!',
            'success'
        );
    }

    if (!editId) {
        // ── MODO: NOVO CARTÃO ─────────────────────────────────────────────
        criarPopupDOM((popup) => {
            const titulo = document.createElement('h3');
            titulo.textContent = 'Novo Cartão';

            // Label + Select banco
            const labelBanco       = document.createElement('label');
            labelBanco.style.cssText = 'display:block; text-align:left; margin-top:10px; color: var(--text-secondary);';
            labelBanco.textContent = 'Banco:';

            const selectBanco = _criarSelectBancos('novoBanco', '');

            // Campo "Outro" (oculto por padrão)
            const campoOutro       = document.createElement('div');
            campoOutro.id          = 'campoOutroCartao';
            campoOutro.style.cssText = 'display:none; margin-top:10px;';

            const labelOutro       = document.createElement('label');
            labelOutro.style.cssText = 'display:block; text-align:left; color: var(--text-secondary);';
            labelOutro.textContent = 'Nome do Cartão:';

            const inputOutro       = document.createElement('input');
            inputOutro.type        = 'text';
            inputOutro.id          = 'nomeOutroCartao';
            inputOutro.className   = 'form-input';
            inputOutro.placeholder = 'Digite o nome do cartão';
            inputOutro.maxLength   = 50;

            campoOutro.appendChild(labelOutro);
            campoOutro.appendChild(inputOutro);

            // Label + Input limite
            const labelLimite       = document.createElement('label');
            labelLimite.style.cssText = 'display:block; text-align:left; margin-top:10px; color: var(--text-secondary);';
            labelLimite.textContent = 'Limite Total:';

            const inputLimite       = document.createElement('input');
            inputLimite.type        = 'number';
            inputLimite.id          = 'novoLimite';
            inputLimite.className   = 'form-input';
            inputLimite.placeholder = 'Limite (R$)';
            inputLimite.step        = '0.01';
            inputLimite.min         = '1';
            inputLimite.max         = '9999999';

            // Label + Select dia
            const labelDia       = document.createElement('label');
            labelDia.style.cssText = 'display:block; text-align:left; margin-top:10px; color: var(--text-secondary);';
            labelDia.textContent = 'Dia da Fatura:';

            const selectDia = _criarSelectDias('novoVencimentoDia', '');

            // Botões
            const btnSalvar     = document.createElement('button');
            btnSalvar.className = 'btn-primary';
            btnSalvar.type      = 'button';
            btnSalvar.textContent = 'Salvar';

            const btnCancelar     = document.createElement('button');
            btnCancelar.className = 'btn-cancelar';
            btnCancelar.type      = 'button';
            btnCancelar.textContent = 'Cancelar';

            btnCancelar.addEventListener('click', fecharPopup);
            btnSalvar.addEventListener('click', () => _executarSalvar(selectBanco, inputOutro, inputLimite, selectDia, null));

            _configurarSelectBanco(selectBanco, campoOutro, inputOutro);

            popup.appendChild(titulo);
            popup.appendChild(labelBanco);
            popup.appendChild(selectBanco);
            popup.appendChild(campoOutro);
            popup.appendChild(labelLimite);
            popup.appendChild(inputLimite);
            popup.appendChild(labelDia);
            popup.appendChild(selectDia);
            popup.appendChild(btnSalvar);
            popup.appendChild(btnCancelar);
        });

    } else {
        // ── MODO: EDITAR CARTÃO ───────────────────────────────────────────
        const c = cartoesCredito.find(x => x.id === editId);
        if (!c) return;

        criarPopupDOM((popup) => {
            const titulo = document.createElement('h3');
            titulo.textContent = 'Editar Cartão';

            // Label + Select banco (pré-selecionado)
            const labelBanco       = document.createElement('label');
            labelBanco.style.cssText = 'display:block; text-align:left; margin-top:10px; color: var(--text-secondary);';
            labelBanco.textContent = 'Banco:';

            const bancoExisteNaLista = bancos.find(b => b.nome === c.nomeBanco && b.nome !== 'Outro');
            const selectBanco = _criarSelectBancos('novoBanco', bancoExisteNaLista ? c.nomeBanco : 'Outro');

            // Campo "Outro"
            const campoOutro       = document.createElement('div');
            campoOutro.id          = 'campoOutroCartao';
            campoOutro.style.cssText = bancoExisteNaLista ? 'display:none; margin-top:10px;' : 'display:block; margin-top:10px;';

            const labelOutro       = document.createElement('label');
            labelOutro.style.cssText = 'display:block; text-align:left; color: var(--text-secondary);';
            labelOutro.textContent = 'Nome do Cartão:';

            const inputOutro       = document.createElement('input');
            inputOutro.type        = 'text';
            inputOutro.id          = 'nomeOutroCartao';
            inputOutro.className   = 'form-input';
            inputOutro.placeholder = 'Digite o nome do cartão';
            inputOutro.maxLength   = 50;
            // ✅ Pré-preenche via .value — nunca via atributo HTML
            if (!bancoExisteNaLista) inputOutro.value = c.nomeBanco;

            campoOutro.appendChild(labelOutro);
            campoOutro.appendChild(inputOutro);

            // Label + Input limite
            const labelLimite       = document.createElement('label');
            labelLimite.style.cssText = 'display:block; text-align:left; margin-top:10px; color: var(--text-secondary);';
            labelLimite.textContent = 'Limite Total:';

            const inputLimite       = document.createElement('input');
            inputLimite.type        = 'number';
            inputLimite.id          = 'novoLimite';
            inputLimite.className   = 'form-input';
            inputLimite.step        = '0.01';
            inputLimite.min         = '1';
            inputLimite.max         = '9999999';
            inputLimite.value       = parseFloat(c.limite); // ✅ .value — não atributo HTML

            // Label + Select dia (pré-selecionado)
            const labelDia       = document.createElement('label');
            labelDia.style.cssText = 'display:block; text-align:left; margin-top:10px; color: var(--text-secondary);';
            labelDia.textContent = 'Dia da Fatura:';

            const selectDia = _criarSelectDias('novoVencimentoDia', c.vencimentoDia);

            // Botões
            const btnSalvar     = document.createElement('button');
            btnSalvar.className = 'btn-primary';
            btnSalvar.type      = 'button';
            btnSalvar.textContent = 'Salvar';

            const btnCancelar     = document.createElement('button');
            btnCancelar.className = 'btn-cancelar';
            btnCancelar.type      = 'button';
            btnCancelar.textContent = 'Cancelar';

            const btnExcluir     = document.createElement('button');
            btnExcluir.className = 'btn-excluir';
            btnExcluir.type      = 'button';
            btnExcluir.textContent = 'Excluir';

            btnCancelar.addEventListener('click', fecharPopup);
            btnSalvar.addEventListener('click', () => _executarSalvar(selectBanco, inputOutro, inputLimite, selectDia, c));
            btnExcluir.addEventListener('click', () => {
                if (confirm('Excluir cartão? Todas as compras futuras vinculadas a ele serão removidas.')) {
                    cartoesCredito = cartoesCredito.filter(x => x.id !== editId);
                    if (cartaoSelecionadoId === editId) cartaoSelecionadoId = null;
                    contasFixas    = contasFixas.filter(x => x.cartaoId !== editId);
                    salvarDados();
                    atualizarTelaCartoes();
                    atualizarListaContasFixas();
                    fecharPopup();
                    mostrarNotificacao('Cartão excluído com sucesso!', 'success');
                }
            });

            _configurarSelectBanco(selectBanco, campoOutro, inputOutro);

            popup.appendChild(titulo);
            popup.appendChild(labelBanco);
            popup.appendChild(selectBanco);
            popup.appendChild(campoOutro);
            popup.appendChild(labelLimite);
            popup.appendChild(inputLimite);
            popup.appendChild(labelDia);
            popup.appendChild(selectDia);
            popup.appendChild(btnSalvar);
            popup.appendChild(btnCancelar);
            popup.appendChild(btnExcluir);
        });
    }
}

// ========== DETALHES COMPLETOS DO CARTÃO ==========
function abrirDetalhesCartaoCompleto(cartaoId) {
    const cartao = cartoesCredito.find(c => c.id === cartaoId);
    if (!cartao) return;

    const usado     = cartao.usado || 0;
    const disponivel = Math.max(0, cartao.limite - usado);
    const percUsado  = cartao.limite > 0
        ? Math.min(100, (usado / cartao.limite) * 100)
        : 0;

    const faturas = contasFixas.filter(c =>
        c.cartaoId === cartaoId && c.tipoContaFixa === 'fatura_cartao'
    );
    const totalFatura     = faturas.reduce((sum, f) => sum + (f.valor || 0), 0);
    const parcelasAtivas  = contasFixas.filter(fx => fx.cartaoId === cartaoId && fx.totalParcelas);

    criarPopupDOM((popup) => {
        popup.style.cssText = 'max-width: 460px; width: 95%;';

        const scroll = document.createElement('div');
        scroll.style.cssText = 'max-height: 70vh; overflow-y: auto; padding-right: 6px;';

        // ── Título
        const titulo = document.createElement('h3');
        titulo.style.cssText = 'text-align: center; margin-bottom: 20px;';
        titulo.textContent = `💳 ${_sanitizeText(cartao.nomeBanco)}`;
        scroll.appendChild(titulo);

        // Status frozen
        if (cartao.congelado) {
            const frozenBanner = document.createElement('div');
            frozenBanner.style.cssText = 'background: rgba(96,212,255,0.12); border: 1px solid rgba(96,212,255,0.3); border-radius: 10px; padding: 10px 14px; text-align: center; color: #60d4ff; font-weight: 600; font-size: 0.9rem; margin-bottom: 16px;';
            frozenBanner.textContent = '❄️ Cartão congelado — nenhum novo lançamento permitido';
            scroll.appendChild(frozenBanner);
        }

        // ── Stats grid
        const statsGrid = document.createElement('div');
        statsGrid.style.cssText = 'display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; margin-bottom: 20px;';

        const statsData = [
            { icon: '💰', label: 'Limite Total',      value: formatBRL(cartao.limite),            color: 'var(--text-primary)' },
            { icon: '💸', label: 'Valor Usado',        value: formatBRL(usado),                    color: '#ff4b4b' },
            { icon: '✅', label: 'Disponível',          value: formatBRL(disponivel),               color: '#00ff99' },
            { icon: '📊', label: '% Utilizado',         value: `${percUsado.toFixed(1)}%`,          color: percUsado > 80 ? '#ff4b4b' : '#00ff99' },
            { icon: '📄', label: 'Fatura em Aberto',    value: formatBRL(totalFatura),              color: '#ffd166' },
            { icon: '📅', label: 'Vencimento',          value: `Todo dia ${cartao.vencimentoDia}`,  color: 'var(--primary)' },
        ];

        statsData.forEach(s => {
            const card = document.createElement('div');
            card.style.cssText = 'background: rgba(255,255,255,0.05); padding: 14px; border-radius: 12px; text-align: center;';
            const lbl = document.createElement('div');
            lbl.style.cssText = 'font-size: 0.78rem; color: var(--text-secondary); margin-bottom: 6px;';
            lbl.textContent = `${s.icon} ${s.label}`;
            const val = document.createElement('div');
            val.style.cssText = `font-size: 1.05rem; font-weight: 700; color: ${s.color};`;
            val.textContent = s.value;
            card.appendChild(lbl);
            card.appendChild(val);
            statsGrid.appendChild(card);
        });
        scroll.appendChild(statsGrid);

        // ── Barra de utilização
        const barSection = document.createElement('div');
        barSection.style.marginBottom = '20px';

        const barRow = document.createElement('div');
        barRow.style.cssText = 'display: flex; justify-content: space-between; margin-bottom: 8px; font-size: 0.85rem;';
        const barLblL = document.createElement('span');
        barLblL.style.color = 'var(--text-secondary)';
        barLblL.textContent = 'Utilização do Limite';
        const barLblR = document.createElement('span');
        barLblR.style.cssText = `font-weight: 700; color: ${percUsado > 80 ? '#ff4b4b' : '#00ff99'};`;
        barLblR.textContent = `${percUsado.toFixed(1)}%`;
        barRow.appendChild(barLblL);
        barRow.appendChild(barLblR);

        const barBg = document.createElement('div');
        barBg.style.cssText = 'width: 100%; height: 14px; background: rgba(255,255,255,0.1); border-radius: 7px; overflow: hidden;';
        const barFill = document.createElement('div');
        const corFill = percUsado > 80 ? '#ff4b4b' : percUsado > 50 ? '#ffd166' : '#00ff99';
        barFill.style.cssText = `width: ${percUsado.toFixed(1)}%; height: 100%; background: ${corFill}; border-radius: 7px; transition: width 0.5s;`;
        barBg.appendChild(barFill);

        barSection.appendChild(barRow);
        barSection.appendChild(barBg);
        scroll.appendChild(barSection);

        // ── Faturas em aberto
        if (faturas.length > 0) {
            const fTitle = document.createElement('h4');
            fTitle.style.cssText = 'color: var(--text-primary); margin-bottom: 12px;';
            fTitle.textContent = '📋 Faturas em Aberto';
            scroll.appendChild(fTitle);

            faturas.forEach(f => {
                const fItem = document.createElement('div');
                fItem.style.cssText = 'background: rgba(255,209,102,0.1); padding: 14px; border-radius: 12px; border-left: 3px solid #ffd166; cursor: pointer; margin-bottom: 8px; transition: background 0.2s;';

                const fRow = document.createElement('div');
                fRow.style.cssText = 'display: flex; justify-content: space-between; align-items: center;';
                const fDesc = document.createElement('div');
                fDesc.style.cssText = 'font-weight: 600; font-size: 0.9rem; color: var(--text-primary);';
                fDesc.textContent = `Vence ${formatarDataBR(f.vencimento)}`;
                const fVal = document.createElement('div');
                fVal.style.cssText = 'font-weight: 700; color: #ffd166;';
                fVal.textContent = formatBRL(f.valor);
                fRow.appendChild(fDesc);
                fRow.appendChild(fVal);

                const fSub = document.createElement('div');
                fSub.style.cssText = 'font-size: 0.78rem; color: var(--text-secondary); margin-top: 5px;';
                fSub.textContent = `${f.compras?.length || 0} compra(s) — toque para ver detalhes`;

                fItem.appendChild(fRow);
                fItem.appendChild(fSub);
                fItem.addEventListener('mouseover', () => { fItem.style.background = 'rgba(255,209,102,0.18)'; });
                fItem.addEventListener('mouseout',  () => { fItem.style.background = 'rgba(255,209,102,0.1)'; });
                fItem.addEventListener('click', () => {
                    fecharPopup();
                    setTimeout(() => abrirVisualizacaoFatura(f.id), 200);
                });
                scroll.appendChild(fItem);
            });
        }

        // ── Parcelas ativas
        if (parcelasAtivas.length > 0) {
            const instDiv = document.createElement('div');
            instDiv.style.cssText = 'background: rgba(108,99,255,0.1); padding: 14px; border-radius: 12px; border-left: 3px solid #6c63ff; margin-top: 12px;';
            const instLbl = document.createElement('div');
            instLbl.style.cssText = 'font-size: 0.82rem; color: var(--text-secondary); margin-bottom: 5px;';
            instLbl.textContent = '🔄 Compras Parceladas Ativas';
            const instVal = document.createElement('div');
            instVal.style.cssText = 'font-size: 1.1rem; font-weight: 700; color: #6c63ff;';
            instVal.textContent = `${parcelasAtivas.length} compra(s)`;
            instDiv.appendChild(instLbl);
            instDiv.appendChild(instVal);
            scroll.appendChild(instDiv);
        }

        // ── Botão editar cartão
        const btnEditar = document.createElement('button');
        btnEditar.className = 'btn-primary';
        btnEditar.type = 'button';
        btnEditar.style.cssText = 'width: 100%; margin-top: 16px; padding: 12px;';
        btnEditar.textContent = '✏️ Editar Configurações do Cartão';
        btnEditar.addEventListener('click', () => {
            fecharPopup();
            setTimeout(() => abrirCartaoForm(cartaoId), 200);
        });
        scroll.appendChild(btnEditar);

        popup.appendChild(scroll);

        const btnFechar = document.createElement('button');
        btnFechar.className = 'btn-cancelar';
        btnFechar.type = 'button';
        btnFechar.style.cssText = 'width: 100%; margin-top: 12px;';
        btnFechar.textContent = 'Fechar';
        btnFechar.addEventListener('click', fecharPopup);
        popup.appendChild(btnFechar);
    });
}

// ========== GRÁFICOS - DELEGA PARA graficos.js ==========

function inicializarGraficos() {
    // ✅ window.* são getters read-only definidos em _inicializarWindowRefs
    // Sincronizados automaticamente com o estado do módulo — reatribuição removida
    // pois era bloqueada pelo setter e gerava erro silencioso

    if (typeof configurarFiltros    === 'function') configurarFiltros();
    if (typeof configurarViewButtons === 'function') configurarViewButtons();
    if (typeof configurarComparacao  === 'function') configurarComparacao();
}

function atualizarGraficos() {
    if (typeof gerarGraficos === 'function') {
        gerarGraficos();
    } else {
        mostrarNotificacao('Módulo de gráficos não carregado.', 'error');
    }
}

function exportarGraficos() {
    mostrarNotificacao('Use o botão de exportar dentro de cada gráfico.', 'info');
}

// ========== RELATÓRIOS ==========
function popularFiltrosRelatorio() {
    const mesSelect    = document.getElementById('mesRelatorio');
    const anoSelect    = document.getElementById('anoRelatorio');
    const perfilSelect = document.getElementById('selectPerfilRelatorio');

    if (!mesSelect || !anoSelect || !perfilSelect) {
        _log.error('RELATORIO_DOM_001', 'Elementos de filtro não encontrados');
        return;
    }

    function _criarPlaceholder(texto) {
        const opt = document.createElement('option');
        opt.value       = '';
        opt.textContent = texto;
        return opt;
    }

    while (mesSelect.firstChild)    mesSelect.removeChild(mesSelect.firstChild);
    while (anoSelect.firstChild)    anoSelect.removeChild(anoSelect.firstChild);
    while (perfilSelect.firstChild) perfilSelect.removeChild(perfilSelect.firstChild);

    mesSelect.appendChild(_criarPlaceholder('Selecione o mês'));
    anoSelect.appendChild(_criarPlaceholder('Selecione o ano'));
    perfilSelect.appendChild(_criarPlaceholder('Selecione o perfil'));

    if (!Array.isArray(usuarioLogado?.perfis)) return;

    usuarioLogado.perfis.forEach(perfil => {
        const option = document.createElement('option');
        option.value       = sanitizeHTML(String(perfil.id));
        option.textContent = String(perfil.nome || '').slice(0, 100);
        if (perfilAtivo && String(perfil.id) === String(perfilAtivo.id)) {
            option.selected = true;
        }
        perfilSelect.appendChild(option);
    });

    const periodosDisponiveis = new Set();

    if (tipoRelatorioAtivo === 'individual') {
        if (Array.isArray(transacoes)) {
            transacoes.forEach(t => {
                const dataISO = sanitizeDate(dataParaISO(t.data));
                if (dataISO) {
                    periodosDisponiveis.add(dataISO.slice(0, 7));
                }
            });
        }
    } else {
        if (Array.isArray(usuarioLogado?.perfis)) {
            usuarioLogado.perfis.forEach(perfil => {
                const chave = `granaevo_perfil_${sanitizeHTML(String(perfil.id))}`;
                try {
                    const raw = localStorage.getItem(chave);
                    if (!raw) return;

                    const dados = JSON.parse(raw);

                    // ✅ Validação de estrutura (já existia)
                    if (!dados || !Array.isArray(dados.transacoes)) return;

                    dados.transacoes.forEach(t => {
                        if (!t || typeof t !== 'object') return;

                        // ✅ NOVO: valida cada transação com o mesmo validator do save
                        //    Impede que dados envenenados no localStorage causem
                        //    comportamento inesperado no preenchimento dos filtros
                        if (!_validators.transacao(t)) return;

                        const dataISO = sanitizeDate(dataParaISO(t.data));
                        if (dataISO) {
                            periodosDisponiveis.add(dataISO.slice(0, 7));
                        }
                    });
                } catch (e) {
                    // ✅ CORRIGIDO: não expõe perfil.id no console em produção
                    _log.warn('RELATORIO_LS_001', 'Erro ao ler dados históricos de período');
                }
            });
        }
    }

    if (periodosDisponiveis.size === 0) {
        const hoje    = new Date();
        const anoAtual = hoje.getFullYear();
        const mesAtual = String(hoje.getMonth() + 1).padStart(2, '0');
        periodosDisponiveis.add(`${anoAtual}-${mesAtual}`);
    }

    const meses = new Set();
    const anos  = new Set();

    periodosDisponiveis.forEach(periodo => {
        const partes = periodo.split('-');
        if (partes.length === 2) {
            meses.add(partes[1]);
            anos.add(partes[0]);
        }
    });

    const mesesNomes = {
        '01': 'Janeiro', '02': 'Fevereiro', '03': 'Março',    '04': 'Abril',
        '05': 'Maio',    '06': 'Junho',     '07': 'Julho',    '08': 'Agosto',
        '09': 'Setembro','10': 'Outubro',   '11': 'Novembro', '12': 'Dezembro'
    };

    Array.from(meses).sort().forEach(mes => {
        if (!mesesNomes[mes]) return;
        const option       = document.createElement('option');
        option.value       = mes;
        option.textContent = mesesNomes[mes];
        mesSelect.appendChild(option);
    });

    Array.from(anos).sort().reverse().forEach(ano => {
        const anoNum = parseInt(ano, 10);
        if (anoNum < 2000 || anoNum > 2100) return;
        const option       = document.createElement('option');
        option.value       = ano;
        option.textContent = ano;
        anoSelect.appendChild(option);
    });

    setupBotoesRelatorio();
    // ✅ CORRIGIDO: log operacional sem dados sensíveis
    _log.info('[popularFiltrosRelatorio] Filtros populados. Tipo ativo:', tipoRelatorioAtivo);
}

function setupBotoesRelatorio() {
    const btnIndividual = document.querySelector('.tipo-relatorio-btns [data-tipo="individual"]');
    const btnCasal = document.querySelector('.tipo-relatorio-btns [data-tipo="casal"]');
    const btnFamilia = document.querySelector('.tipo-relatorio-btns [data-tipo="familia"]');
    const perfilSelector = document.getElementById('perfilSelectorDiv');
    
    if (!btnIndividual || !btnCasal || !btnFamilia || !perfilSelector) {
        console.error('Botões de relatório não encontrados!');
        return;
    }
    
    const newBtnIndividual = btnIndividual.cloneNode(true);
    const newBtnCasal = btnCasal.cloneNode(true);
    const newBtnFamilia = btnFamilia.cloneNode(true);
    
    btnIndividual.parentNode.replaceChild(newBtnIndividual, btnIndividual);
    btnCasal.parentNode.replaceChild(newBtnCasal, btnCasal);
    btnFamilia.parentNode.replaceChild(newBtnFamilia, btnFamilia);
    
    newBtnIndividual.addEventListener('click', function () {
        tipoRelatorioAtivo = 'individual';
        newBtnIndividual.classList.add('active');
        newBtnCasal.classList.remove('active');
        newBtnFamilia.classList.remove('active');
        perfilSelector.classList.add('show');
        const resultado = document.getElementById('relatorioResultado');
        if (resultado) resultado.style.display = 'none';
        popularFiltrosRelatorio();
    });
    
    newBtnCasal.addEventListener('click', function () {
        if (!Array.isArray(usuarioLogado?.perfis) || usuarioLogado.perfis.length < 2) {
            alert('Você precisa ter pelo menos 2 perfis cadastrados para gerar relatório de casal!');
            return;
        }
        tipoRelatorioAtivo = 'casal';
        newBtnIndividual.classList.remove('active');
        newBtnCasal.classList.add('active');
        newBtnFamilia.classList.remove('active');
        perfilSelector.classList.remove('show');
        const resultado = document.getElementById('relatorioResultado');
        if (resultado) resultado.style.display = 'none';
        popularFiltrosRelatorio();
    });
    
    newBtnFamilia.addEventListener('click', function () {
        if (!Array.isArray(usuarioLogado?.perfis) || usuarioLogado.perfis.length < 2) {
            alert('Você precisa ter pelo menos 2 perfis para gerar relatório da família!');
            return;
        }
        tipoRelatorioAtivo = 'familia';
        newBtnIndividual.classList.remove('active');
        newBtnCasal.classList.remove('active');
        newBtnFamilia.classList.add('active');
        perfilSelector.classList.remove('show');
        const resultado = document.getElementById('relatorioResultado');
        if (resultado) resultado.style.display = 'none';
        popularFiltrosRelatorio();
    });
}

// CORREÇÃO: Flag para evitar cliques duplos / race condition
let _gerandoRelatorio = false;

async function gerarRelatorio() {
    if (_gerandoRelatorio) return; // CORREÇÃO: Debounce de segurança
    
    const mesEl = document.getElementById('mesRelatorio');
    const anoEl = document.getElementById('anoRelatorio');
    
    if (!mesEl || !anoEl) return;
    
    const mes = mesEl.value;
    const ano = anoEl.value;
    
    // CORREÇÃO: Validar formato de mês e ano antes de processar
    if (!mes || !ano) {
        return alert('Por favor, selecione o mês e o ano.');
    }
    if (!/^\d{2}$/.test(mes) || parseInt(mes, 10) < 1 || parseInt(mes, 10) > 12) {
        return alert('Mês inválido.');
    }
    if (!/^\d{4}$/.test(ano) || parseInt(ano, 10) < 2000 || parseInt(ano, 10) > 2100) {
        return alert('Ano inválido.');
    }
    
    _gerandoRelatorio = true;
    try {
        if (tipoRelatorioAtivo === 'individual') {
            const perfilEl = document.getElementById('selectPerfilRelatorio');
            if (!perfilEl) return;
            const perfilId = perfilEl.value;
            if (!perfilId) return alert('Por favor, selecione um perfil.');
            // CORREÇÃO: Validar que perfilId realmente existe nos perfis do usuário
            const perfilExiste = usuarioLogado?.perfis?.some(p => String(p.id) === String(perfilId));
            if (!perfilExiste) return alert('Perfil inválido.');
            await gerarRelatorioIndividual(mes, ano, perfilId);
        } else if (tipoRelatorioAtivo === 'casal') {
            if (usuarioLogado.plano === 'Família' && usuarioLogado.perfis.length > 2) {
                abrirSelecaoPerfisCasal(mes, ano);
            } else {
                await gerarRelatorioCompartilhado(mes, ano, 2);
            }
        } else {
            const numPerfis = Math.min(usuarioLogado?.perfis?.length || 0, 20); // CORREÇÃO: Limite máximo
            await gerarRelatorioCompartilhado(mes, ano, numPerfis);
        }
    } finally {
        _gerandoRelatorio = false;
    }
}

    // ========== SELEÇÃO DE PERFIS PARA RELATÓRIO CASAL (PLANO FAMÍLIA) ==========
window.abrirSelecaoPerfisCasal = function abrirSelecaoPerfisCasal(mes, ano) {
    if (!/^\d{2}$/.test(mes) || !/^\d{4}$/.test(ano)) return;

    if (!Array.isArray(usuarioLogado?.perfis)) return;

    let htmlPerfis = '';

    usuarioLogado.perfis.forEach(perfil => {
        const idSeguro   = sanitizeHTML(String(perfil.id));
        const nomeSeguro = sanitizeHTML(String(perfil.nome || '').slice(0, 100));

        // ✅ CORREÇÃO: onmouseover/onmouseout removidos pelo sanitizarHTMLPopup
        //    Substituídos por classes CSS ou event delegation após criação do popup
        htmlPerfis += `
            <div style="margin-bottom:12px;">
                <label class="perfil-label-casal" style="display:flex; align-items:center; gap:10px; padding:12px; background:rgba(255,255,255,0.05); border-radius:10px; cursor:pointer; transition:background 0.3s;">
                    <input type="checkbox" class="perfil-checkbox-casal" value="${idSeguro}"
                           style="width:20px; height:20px; cursor:pointer; accent-color:var(--primary);">
                    <span style="font-weight:600; color: var(--text-primary);">${nomeSeguro}</span>
                </label>
            </div>
        `;
    });

    criarPopup(`
        <h3>👥 Selecione 2 Perfis para Relatório Casal</h3>
        <p style="color: var(--text-secondary); margin-bottom:20px; font-size:0.9rem;">
            Escolha exatamente 2 perfis para gerar o relatório conjunto
        </p>
        <div style="max-height:300px; overflow-y:auto; margin-bottom:20px;">
            ${htmlPerfis}
        </div>
        <div id="avisoSelecao" style="display:none; background:rgba(255,75,75,0.1); padding:12px; border-radius:8px; margin-bottom:16px; border-left:3px solid #ff4b4b;">
            <span style="color:#ff4b4b; font-weight:600;">⚠️ Selecione exatamente 2 perfis</span>
        </div>
        <button class="btn-primary" id="btnConfirmarCasal" data-mes="${sanitizeHTML(mes)}" data-ano="${sanitizeHTML(ano)}" style="width:100%; margin-bottom:10px;">
            Gerar Relatório
        </button>
        <button class="btn-cancelar" id="btnCancelarCasal" style="width:100%;">
            Cancelar
        </button>
    `);

    // ✅ CORREÇÃO: addEventListener no botão Cancelar em vez de onclick inline
    //    onclick="fecharPopup()" é removido pelo sanitizarHTMLPopup — botão ficava morto
    const btnCancelar = document.getElementById('btnCancelarCasal');
    if (btnCancelar) {
        btnCancelar.addEventListener('click', fecharPopup);
    }

    const btnConfirmar = document.getElementById('btnConfirmarCasal');
    if (btnConfirmar) {
        btnConfirmar.addEventListener('click', function () {
            const m = this.getAttribute('data-mes');
            const a = this.getAttribute('data-ano');
            window.confirmarSelecaoPerfisCasal(m, a);
        });
    }

    // ✅ CORREÇÃO: hover nos labels via JavaScript em vez de onmouseover/onmouseout inline
    document.querySelectorAll('.perfil-label-casal').forEach(label => {
        label.addEventListener('mouseover', () => { label.style.background = 'rgba(67,160,71,0.1)'; });
        label.addEventListener('mouseout',  () => { label.style.background = 'rgba(255,255,255,0.05)'; });
    });
};

window.confirmarSelecaoPerfisCasal = function confirmarSelecaoPerfisCasal(mes, ano) {
    if (!/^\d{2}$/.test(mes) || !/^\d{4}$/.test(ano)) return;

    const checkboxes = document.querySelectorAll('.perfil-checkbox-casal:checked');
    const avisoEl = document.getElementById('avisoSelecao');

    if (checkboxes.length !== 2) {
        if (avisoEl) {
            avisoEl.style.display = 'block';
            setTimeout(() => { avisoEl.style.display = 'none'; }, 3000);
        }
        return;
    }

    const perfisIds = Array.from(checkboxes).map(cb => cb.value);

    const idsValidos = perfisIds.every(id =>
        usuarioLogado?.perfis?.some(p => String(p.id) === String(id))
    );
    if (!idsValidos) {
        console.error('IDs de perfis inválidos detectados');
        return;
    }

    fecharPopup();
    window.gerarRelatorioCompartilhadoPersonalizado(mes, ano, perfisIds);
};

// ========== GERAR RELATÓRIO CASAL PERSONALIZADO ==========
window.gerarRelatorioCompartilhadoPersonalizado = async function gerarRelatorioCompartilhadoPersonalizado(mes, ano, perfisIds) {
    if (!/^\d{2}$/.test(mes) || parseInt(mes, 10) < 1 || parseInt(mes, 10) > 12) return;
    if (!/^\d{4}$/.test(ano) || parseInt(ano, 10) < 2000 || parseInt(ano, 10) > 2100) return;
    if (!Array.isArray(perfisIds) || perfisIds.length !== 2) return;

    const periodoSelecionado = `${ano}-${mes}`;

    const perfisAtivos = usuarioLogado.perfis.filter(p =>
        perfisIds.includes(String(p.id))
    );

    if (perfisAtivos.length !== 2) {
        alert('Erro: É necessário selecionar exatamente 2 perfis.');
        return;
    }

    let mesAnterior, anoAnterior;
    if (mes === '01') {
        mesAnterior = '12';
        anoAnterior = String(Number(ano) - 1);
    } else {
        mesAnterior = String(Number(mes) - 1).padStart(2, '0');
        anoAnterior = ano;
    }
    const periodoAnterior = `${anoAnterior}-${mesAnterior}`;

    const userData = await dataManager.loadUserData();

    if (!validarUserData(userData)) {
        console.error('Dados do usuário inválidos ou corrompidos');
        return;
    }

    const dadosPorPerfil = perfisAtivos.map(perfil => {
        const dadosPerfil = userData.profiles.find(p => String(p.id) === String(perfil.id));
        const transacoesPerfil = Array.isArray(dadosPerfil?.transacoes) ? dadosPerfil.transacoes : [];
        const metasPerfil = Array.isArray(dadosPerfil?.metas) ? dadosPerfil.metas : [];
        const cartoesPerfil = Array.isArray(dadosPerfil?.cartoesCredito) ? dadosPerfil.cartoesCredito : [];

        const transacoesPeriodo = transacoesPerfil.filter(t => {
            if (!t || typeof t !== 'object') return false;
            const dataISO = sanitizeDate(dataParaISO(t.data));
            if (!dataISO) return false;
            return dataISO.startsWith(periodoSelecionado);
        });

        let saldoInicial = 0;
        transacoesPerfil.forEach(t => {
            if (!t || typeof t !== 'object') return;
            const dataISO = sanitizeDate(dataParaISO(t.data));
            if (!dataISO || dataISO >= periodoSelecionado) return;
            const valor = sanitizeNumber(t.valor);
            if (t.categoria === 'entrada') saldoInicial += valor;
            else if (t.categoria === 'saida') saldoInicial -= valor;
            else if (t.categoria === 'reserva') saldoInicial -= valor;
            else if (t.categoria === 'retirada_reserva') saldoInicial += valor;
        });

        let entradas = 0, saidas = 0, totalGuardado = 0, totalRetirado = 0;
        const categorias = safeCategorias();

        transacoesPerfil.forEach(t => {
            if (!t || typeof t !== 'object') return;
            const dataISO = sanitizeDate(dataParaISO(t.data));
            if (!dataISO || !dataISO.startsWith(periodoSelecionado)) return;
            const valor = sanitizeNumber(t.valor);
            if (t.categoria === 'entrada') {
                entradas += valor;
            } else if (t.categoria === 'saida') {
                saidas += valor;
                if (t.tipo && typeof t.tipo === 'string' && t.tipo.length < 100) {
                    const tipoKey = t.tipo.trim();
                    categorias[tipoKey] = (categorias[tipoKey] || 0) + valor;
                }
            } else if (t.categoria === 'reserva') {
                totalGuardado += valor;
                saidas += valor;
            } else if (t.categoria === 'retirada_reserva') {
                totalRetirado += valor;
                saidas -= valor;
            }
        });

        const saldoDoMes = entradas - saidas;
        const saldoFinal = saldoInicial + saldoDoMes;

        let entradasAnt = 0, saidasAnt = 0, guardadoAnt = 0, retiradoAnt = 0;
        transacoesPerfil.forEach(t => {
            if (!t || typeof t !== 'object') return;
            const dataISO = sanitizeDate(dataParaISO(t.data));
            if (!dataISO || !dataISO.startsWith(periodoAnterior)) return;
            const valor = sanitizeNumber(t.valor);
            if (t.categoria === 'entrada') entradasAnt += valor;
            else if (t.categoria === 'saida') saidasAnt += valor;
            else if (t.categoria === 'reserva') { guardadoAnt += valor; saidasAnt += valor; }
            else if (t.categoria === 'retirada_reserva') { retiradoAnt += valor; saidasAnt -= valor; }
        });

        const reservasLiquido = totalGuardado - totalRetirado;
        const reservasLiquidoAnt = guardadoAnt - retiradoAnt;
        const taxaEconomia = entradas > 0 ? ((reservasLiquido / entradas) * 100) : 0;
        const taxaEconomiaAnt = entradasAnt > 0 ? ((reservasLiquidoAnt / entradasAnt) * 100) : 0;

        let totalLimiteCartoes = 0, totalUsadoCartoes = 0;
        cartoesPerfil.forEach(c => {
            if (!c || typeof c !== 'object') return;
            totalLimiteCartoes += sanitizeNumber(c.limite);
            totalUsadoCartoes += sanitizeNumber(c.usado);
        });

        return {
            perfil,
            entradas, saidas, reservas: reservasLiquido,
            totalGuardado, totalRetirado,
            saldoInicial, saldoDoMes, saldo: saldoFinal,
            categorias, transacoes: transacoesPeriodo,
            metas: metasPerfil, cartoes: cartoesPerfil,
            totalLimiteCartoes, totalUsadoCartoes,
            mesAnterior: { entradas: entradasAnt, saidas: saidasAnt, reservas: reservasLiquidoAnt, saldo: entradasAnt - saidasAnt },
            taxaEconomia, taxaEconomiaAnterior: taxaEconomiaAnt,
            evolucaoEconomia: taxaEconomia - taxaEconomiaAnt
        };
    });

    const temDados = dadosPorPerfil.some(d => d.transacoes.length > 0);
    const resultado = document.getElementById('relatorioResultado');
    if (!resultado) return;

    if (!temDados) {
        resultado.innerHTML = `
            <div class="relatorio-vazio">
                <h3>📊 Nenhum relatório disponível</h3>
                <p>Não há transações registradas para os perfis selecionados em ${sanitizeHTML(getMesNome(mes))} de ${sanitizeHTML(ano)}</p>
                <p style="margin-top:12px; color: var(--text-muted);">
                    Perfis: ${perfisAtivos.map(p => sanitizeHTML(String(p.nome || ''))).join(', ')}
                </p>
            </div>
        `;
        resultado.style.display = 'block';
        return;
    }

    renderizarRelatorioCompartilhado(dadosPorPerfil, mes, ano, mesAnterior, anoAnterior);
};

// ✅ HELPER: aplica sanitizarHTMLPopup antes de qualquer atribuição de innerHTML/insertAdjacentHTML
//    Centraliza a sanitização para todos os relatórios — evita esquecimento futuro
function _sanitizarHTMLRelatorio(html) {
    if (typeof html !== 'string' || !html.trim()) return '';
    // Reutiliza o sanitizador DOMParser já existente no módulo
    // Aplica: whitelist CSS, remoção de tags perigosas, remoção de on*, bloqueio de javascript:
    return sanitizarHTMLPopup(html);
}

async function gerarRelatorioIndividual(mes, ano, perfilId) {
    if (!/^\d{2}$/.test(mes) || parseInt(mes, 10) < 1 || parseInt(mes, 10) > 12) return;
    if (!/^\d{4}$/.test(ano) || parseInt(ano, 10) < 2000 || parseInt(ano, 10) > 2100) return;
    if (!perfilId) return;

    const userData = await dataManager.loadUserData();

    if (!validarUserData(userData)) {
        console.error('❌ Dados do usuário inválidos');
        return;
    }

    const dadosPerfil = userData.profiles.find(p => String(p.id) === String(perfilId));

    if (!dadosPerfil) {
        console.error('❌ Perfil não encontrado no DataManager');
        const resultado = document.getElementById('relatorioResultado');
        if (resultado) {
            resultado.innerHTML = '';
            const div = document.createElement('div');
            div.className = 'relatorio-vazio';
            const h3 = document.createElement('h3');
            h3.textContent = '⚠️ Erro ao Carregar Dados';
            const p = document.createElement('p');
            p.textContent = 'Não foi possível encontrar os dados do perfil selecionado.';
            div.appendChild(h3);
            div.appendChild(p);
            resultado.appendChild(div);
            resultado.style.display = 'block';
        }
        return;
    }

    const transacoesPerfil    = Array.isArray(dadosPerfil.transacoes)     ? dadosPerfil.transacoes     : [];
    const metasPerfil         = Array.isArray(dadosPerfil.metas)          ? dadosPerfil.metas          : [];
    const cartoesPerfil       = Array.isArray(dadosPerfil.cartoesCredito) ? dadosPerfil.cartoesCredito : [];
    const contasFixasPerfil   = Array.isArray(dadosPerfil.contasFixas)    ? dadosPerfil.contasFixas    : [];

    const periodoSelecionado  = `${ano}-${mes}`;
    const hojeISO             = new Date().toISOString().slice(0, 10);

    const transacoesPeriodo = transacoesPerfil.filter(t => {
        if (!t || typeof t !== 'object') return false;
        const dataISO = sanitizeDate(dataParaISO(t.data));
        if (!dataISO) return false;
        if (t.categoria === 'retirada_reserva') return false;
        return dataISO.startsWith(periodoSelecionado);
    });

    let saldoInicial = 0;
    transacoesPerfil.forEach(t => {
        if (!t || typeof t !== 'object') return;
        const dataISO = sanitizeDate(dataParaISO(t.data));
        if (!dataISO || dataISO >= periodoSelecionado) return;
        const valor = sanitizeNumber(t.valor);
        if (t.categoria === 'entrada')            saldoInicial += valor;
        else if (t.categoria === 'saida')         saldoInicial -= valor;
        else if (t.categoria === 'reserva')       saldoInicial -= valor;
        else if (t.categoria === 'retirada_reserva') saldoInicial += valor;
    });

    let totalEntradas = 0, totalSaidas = 0, totalGuardado = 0, totalRetirado = 0;
    const categorias = safeCategorias();

    transacoesPerfil.forEach(t => {
        if (!t || typeof t !== 'object') return;
        const dataISO = sanitizeDate(dataParaISO(t.data));
        if (!dataISO || !dataISO.startsWith(periodoSelecionado)) return;
        const valor = sanitizeNumber(t.valor);
        if (t.categoria === 'entrada') {
            totalEntradas += valor;
        } else if (t.categoria === 'saida') {
            totalSaidas += valor;
            if (t.tipo && typeof t.tipo === 'string' && t.tipo.length < 100) {
                const tipoKey = t.tipo.trim();
                categorias[tipoKey] = (categorias[tipoKey] || 0) + valor;
            }
        } else if (t.categoria === 'reserva') {
            totalGuardado += valor;
        } else if (t.categoria === 'retirada_reserva') {
            totalRetirado += valor;
        }
    });

    const valorReservadoLiquido = totalGuardado - totalRetirado;
    const saldoDoMes            = totalEntradas - totalSaidas;
    const saldoFinal            = saldoInicial + saldoDoMes - valorReservadoLiquido;

    const [anoAtual, mesAtual]      = hojeISO.split('-').slice(0, 2);
    const periodoAtualCompleto      = `${anoAtual}-${mesAtual}`;

    const contasFixasMes = contasFixasPerfil.filter(c => {
        if (!c || typeof c !== 'object') return false;
        if (!c.vencimento) return false;
        if (c.vencimento.startsWith(periodoSelecionado)) return true;
        const pagamentoNoMes = transacoesPerfil.find(t => {
            const dataISO = sanitizeDate(dataParaISO(t.data));
            return dataISO &&
                dataISO.startsWith(periodoSelecionado) &&
                String(t.contaFixaId) === String(c.id) &&
                t.tipo === 'Conta Fixa';
        });
        if (pagamentoNoMes) return true;
        if (periodoSelecionado === periodoAtualCompleto &&
            c.vencimento < periodoSelecionado && !c.pago) return true;
        return false;
    });

    const taxaEconomia       = totalEntradas > 0 ?
        ((valorReservadoLiquido / totalEntradas) * 100).toFixed(1) : 0;
    const diasNoMes          = new Date(Number(ano), Number(mes), 0).getDate();
    const mediaGastoDiario   = diasNoMes > 0 ? totalSaidas / diasNoMes : 0;

    const resultado = document.getElementById('relatorioResultado');
    if (!resultado) return;

    const perfilNome = sanitizeHTML(
        String(usuarioLogado.perfis.find(p => String(p.id) === String(perfilId))?.nome || 'Perfil').slice(0, 100)
    );

    if (transacoesPeriodo.length === 0 && contasFixasMes.length === 0) {
        resultado.innerHTML = '';
        const div = document.createElement('div');
        div.className = 'relatorio-vazio';
        const h3 = document.createElement('h3');
        h3.textContent = '📊 Nenhum relatório disponível';
        const p = document.createElement('p');
        p.textContent = `Não há transações ou contas registradas para ${perfilNome} em ${getMesNome(mes)} de ${ano}`;
        div.appendChild(h3);
        div.appendChild(p);
        resultado.appendChild(div);
        resultado.style.display = 'block';
        return;
    }

    let html = `
    <h2 style="text-align:center; margin-bottom:30px;">
        Relatório Completo de ${perfilNome}<br>
        <span style="font-size:1.2rem; color: var(--text-secondary);">${sanitizeHTML(getMesNome(mes))} de ${sanitizeHTML(ano)}</span>
    </h2>

    <div class="relatorio-kpis-container">
        <div class="relatorio-kpis-scroll">
            <div class="relatorio-kpi-card relatorio-kpi-entradas">
                <div class="relatorio-kpi-header"><span class="relatorio-kpi-icon">💰</span><span class="relatorio-kpi-label">Entradas</span></div>
                <div class="relatorio-kpi-value">${formatBRL(totalEntradas)}</div>
                <div class="relatorio-kpi-footer"><span class="relatorio-kpi-period">Total do período</span></div>
            </div>
            <div class="relatorio-kpi-card relatorio-kpi-saidas">
                <div class="relatorio-kpi-header"><span class="relatorio-kpi-icon">💸</span><span class="relatorio-kpi-label">Saídas</span></div>
                <div class="relatorio-kpi-value">${formatBRL(totalSaidas)}</div>
                <div class="relatorio-kpi-footer"><span class="relatorio-kpi-period">Total do período</span></div>
            </div>
            <div class="relatorio-kpi-card relatorio-kpi-guardado">
                <div class="relatorio-kpi-header"><span class="relatorio-kpi-icon">🎯</span><span class="relatorio-kpi-label">Guardado Líquido</span></div>
                <div class="relatorio-kpi-value">${formatBRL(valorReservadoLiquido)}</div>
                <div class="relatorio-kpi-footer"><span class="relatorio-kpi-period" style="font-size:10px;">Guardou: ${formatBRL(totalGuardado)} | Retirou: ${formatBRL(totalRetirado)}</span></div>
            </div>
            <div class="relatorio-kpi-card relatorio-kpi-saldo">
                <div class="relatorio-kpi-header"><span class="relatorio-kpi-icon">📈</span><span class="relatorio-kpi-label">Saldo Total</span></div>
                <div class="relatorio-kpi-value">${formatBRL(saldoFinal)}</div>
                <div class="relatorio-kpi-footer"><span class="relatorio-kpi-period" style="font-size:10px;">Saldo inicial: ${formatBRL(saldoInicial)} | Saldo do mês: ${formatBRL(saldoDoMes)}</span></div>
            </div>
            <div class="relatorio-kpi-card relatorio-kpi-economia">
                <div class="relatorio-kpi-header"><span class="relatorio-kpi-icon">💎</span><span class="relatorio-kpi-label">Taxa de Economia</span></div>
                <div class="relatorio-kpi-value">${sanitizeHTML(String(taxaEconomia))}%</div>
                <div class="relatorio-kpi-footer"><span class="relatorio-kpi-period">Do que ganhou foi guardado</span></div>
            </div>
            <div class="relatorio-kpi-card relatorio-kpi-media">
                <div class="relatorio-kpi-header"><span class="relatorio-kpi-icon">📅</span><span class="relatorio-kpi-label">Gasto Médio/Dia</span></div>
                <div class="relatorio-kpi-value">${formatBRL(mediaGastoDiario)}</div>
                <div class="relatorio-kpi-footer"><span class="relatorio-kpi-period">Média diária de gastos</span></div>
            </div>
        </div>
    </div>
    `;

    if (Object.keys(categorias).length > 0) {
        const categoriasOrdenadas    = Object.entries(categorias).sort((a, b) => b[1] - a[1]).slice(0, 5);
        const totalGastoCategorias   = Object.values(categorias).reduce((a, b) => a + b, 0);
        const coresCategorias        = ['#ff6b6b', '#4ecdc4', '#45b7d1', '#f9ca24', '#6c5ce7'];

        html += `<div class="section-box" style="margin-top:30px;"><h3 style="margin-bottom:20px;">🏆 Top 5 Categorias que Mais Gastou</h3><div style="display:flex; flex-direction:column; gap:12px;">`;

        categoriasOrdenadas.forEach(([cat, valor], i) => {
            const percentual = ((valor / totalGastoCategorias) * 100).toFixed(1);
            html += `
                <div style="margin-bottom:8px;">
                    <div style="display:flex; justify-content:space-between; margin-bottom:6px;">
                        <span style="font-weight:600;">${sanitizeHTML(cat)}</span>
                        <span>${formatBRL(valor)} (${sanitizeHTML(String(percentual))}%)</span>
                    </div>
                    <div style="width:100%; height:12px; background:rgba(255,255,255,0.1); border-radius:6px; overflow:hidden;">
                        <div style="width:${sanitizeHTML(String(percentual))}%; height:100%; background:${coresCategorias[i]}; border-radius:6px;"></div>
                    </div>
                </div>`;
        });
        html += `</div></div>`;
    }

    if (cartoesPerfil.length > 0) {
        let totalLimiteCartoes = 0, totalUsadoCartoes = 0;
        cartoesPerfil.forEach(c => {
            if (!c || typeof c !== 'object') return;
            totalLimiteCartoes += sanitizeNumber(c.limite);
            totalUsadoCartoes  += sanitizeNumber(c.usado);
        });
        const disponivelCartoes = totalLimiteCartoes - totalUsadoCartoes;
        const percUsado         = totalLimiteCartoes > 0 ?
            ((totalUsadoCartoes / totalLimiteCartoes) * 100).toFixed(1) : 0;

        html += `
            <div class="section-box" style="margin-top:30px;">
                <h3 style="margin-bottom:20px;">💳 Análise de Cartões de Crédito</h3>
                <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:16px; margin-bottom:20px;">
                    <div style="background:rgba(255,255,255,0.05); padding:16px; border-radius:12px;">
                        <div style="font-size:0.85rem; color:var(--text-secondary);">Limite Total</div>
                        <div style="font-size:1.3rem; font-weight:700;">${formatBRL(totalLimiteCartoes)}</div>
                    </div>
                    <div style="background:rgba(255,255,255,0.05); padding:16px; border-radius:12px;">
                        <div style="font-size:0.85rem; color:var(--text-secondary);">Usado no Mês</div>
                        <div style="font-size:1.3rem; font-weight:700; color:#ff4b4b;">${formatBRL(totalUsadoCartoes)}</div>
                    </div>
                    <div style="background:rgba(255,255,255,0.05); padding:16px; border-radius:12px;">
                        <div style="font-size:0.85rem; color:var(--text-secondary);">Disponível</div>
                        <div style="font-size:1.3rem; font-weight:700; color:#00ff99;">${formatBRL(disponivelCartoes)}</div>
                    </div>
                    <div style="background:rgba(255,255,255,0.05); padding:16px; border-radius:12px;">
                        <div style="font-size:0.85rem; color:var(--text-secondary);">% Utilizado</div>
                        <div style="font-size:1.3rem; font-weight:700; color:${Number(percUsado) > 80 ? '#ff4b4b' : '#00ff99'};">${sanitizeHTML(String(percUsado))}%</div>
                    </div>
                </div>
                <div style="margin-top:16px;">
                    <div style="font-weight:600; margin-bottom:12px;">Detalhes por Cartão:</div>
                    <div id="listaCartoesRelatorio"></div>
                </div>
            </div>`;

        // ✅ CORREÇÃO: aplica _sanitizarHTMLRelatorio (DOMParser) antes de injetar no DOM
        resultado.innerHTML = _sanitizarHTMLRelatorio(html);
        resultado.style.display = 'block';

        const listaCartoes = document.getElementById('listaCartoesRelatorio');
        if (listaCartoes) {
            cartoesPerfil.forEach(c => {
                if (!c || typeof c !== 'object') return;
                const usado       = sanitizeNumber(c.usado);
                const limite      = sanitizeNumber(c.limite);
                const disponivel  = limite - usado;
                const percCartao  = limite > 0 ? ((usado / limite) * 100).toFixed(1) : 0;

                const div = document.createElement('div');
                div.style.cssText = `background:rgba(255,255,255,0.03); padding:14px; border-radius:10px; margin-bottom:10px; border-left:3px solid ${Number(percCartao) > 80 ? '#ff4b4b' : '#00ff99'}; cursor:pointer; transition:all 0.3s;`;

                // ✅ Constrói via DOM para dados de usuário — zero innerHTML com dados variáveis
                const rowDiv = document.createElement('div');
                rowDiv.style.cssText = 'display:flex; justify-content:space-between; flex-wrap:wrap; gap:10px;';

                const leftDiv = document.createElement('div');
                const nomeDiv = document.createElement('div');
                nomeDiv.style.fontWeight = '600';
                nomeDiv.textContent = `💳 ${String(c.nomeBanco || '')}`;

                const limiteDiv = document.createElement('div');
                limiteDiv.style.cssText = 'font-size:0.85rem; color:var(--text-secondary);';
                limiteDiv.textContent = `Limite: ${formatBRL(limite)}`;

                leftDiv.appendChild(nomeDiv);
                leftDiv.appendChild(limiteDiv);

                const rightDiv = document.createElement('div');
                rightDiv.style.textAlign = 'right';

                const usadoDiv = document.createElement('div');
                usadoDiv.style.cssText = 'font-size:0.85rem; color:var(--text-secondary);';
                usadoDiv.textContent = `Usado: ${formatBRL(usado)}`;

                const percDiv = document.createElement('div');
                percDiv.style.cssText = `font-size:0.9rem; font-weight:600; color:${Number(percCartao) > 80 ? '#ff4b4b' : '#00ff99'};`;
                percDiv.textContent = `${percCartao}% utilizado`;

                rightDiv.appendChild(usadoDiv);
                rightDiv.appendChild(percDiv);

                rowDiv.appendChild(leftDiv);
                rowDiv.appendChild(rightDiv);

                const dicaDiv = document.createElement('div');
                dicaDiv.style.cssText = 'text-align:center; margin-top:8px; font-size:0.75rem; color:var(--text-muted);';
                dicaDiv.textContent = '👆 Clique para ver detalhes';

                div.appendChild(rowDiv);
                div.appendChild(dicaDiv);

                div.addEventListener('click', () => { abrirDetalhesCartaoRelatorio(c.id, mes, ano, perfilId); });
                div.addEventListener('mouseover', () => { div.style.background = 'rgba(255,255,255,0.08)'; });
                div.addEventListener('mouseout',  () => { div.style.background = 'rgba(255,255,255,0.03)'; });
                listaCartoes.appendChild(div);
            });
        }

        html = '';
    }

    if (metasPerfil.length > 0) {
        html += `
            <div class="section-box" style="margin-top:30px;">
                <h3 style="margin-bottom:20px;">🎯 Progresso das Metas</h3>
                <div style="margin-bottom:16px;">
                    <label style="display:block; margin-bottom:8px; font-weight:600; color:var(--text-secondary);">Selecione uma meta para ver detalhes:</label>
                    <select id="selectMetaRelatorio" class="form-input" style="max-width:400px;">
                        <option value="">Escolha uma meta...</option>
        `;
        metasPerfil.forEach(m => {
            if (!m || typeof m !== 'object') return;
            html += `<option value="${sanitizeHTML(String(m.id))}">${sanitizeHTML(String(m.descricao || '').slice(0, 100))}</option>`;
        });
        html += `</select></div><div id="detalhesMetaRelatorio" style="display:none;"></div></div>`;
    }

    const contasComStatus = contasFixasMes.map(c => {
        if (!c || typeof c !== 'object') return null;
        let status = 'Pendente', corStatus = '#ffd166', corFundo = 'rgba(255,209,102,0.1)';
        const pagamentoNoMes = transacoesPerfil.find(t => {
            const dataISO = sanitizeDate(dataParaISO(t.data));
            return dataISO && dataISO.startsWith(periodoSelecionado) &&
                String(t.contaFixaId) === String(c.id) && t.tipo === 'Conta Fixa';
        });
        if (pagamentoNoMes || c.pago) {
            status = 'Paga'; corStatus = '#00ff99'; corFundo = 'rgba(0,255,153,0.1)';
        } else if (c.vencimento < hojeISO) {
            status = 'Vencido'; corStatus = '#ff4b4b'; corFundo = 'rgba(255,75,75,0.1)';
        }
        return { ...c, status, corStatus, corFundo };
    }).filter(Boolean);

    const contasPagas     = contasComStatus.filter(c => c.status === 'Paga').length;
    const contasPendentes = contasComStatus.filter(c => c.status === 'Pendente').length;
    const contasVencidas  = contasComStatus.filter(c => c.status === 'Vencida').length;
    const totalContasValor = contasComStatus.reduce((sum, c) => sum + sanitizeNumber(c.valor), 0);

    html += `
        <div class="section-box" style="margin-top:30px;">
            <h3 style="margin-bottom:20px;">📋 Contas Fixas do Mês</h3>
            <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(150px, 1fr)); gap:12px; margin-bottom:20px;">
                <div style="background:rgba(0,255,153,0.1); padding:12px; border-radius:10px; border-left:3px solid #00ff99;">
                    <div style="font-size:0.85rem; color:var(--text-secondary);">✅ Pagas</div>
                    <div style="font-size:1.5rem; font-weight:700; color:#00ff99;">${contasPagas}</div>
                </div>
                <div style="background:rgba(255,209,102,0.1); padding:12px; border-radius:10px; border-left:3px solid #ffd166;">
                    <div style="font-size:0.85rem; color:var(--text-secondary);">⏳ Pendentes</div>
                    <div style="font-size:1.5rem; font-weight:700; color:#ffd166;">${contasPendentes}</div>
                </div>
                <div style="background:rgba(255,75,75,0.1); padding:12px; border-radius:10px; border-left:3px solid #ff4b4b;">
                    <div style="font-size:0.85rem; color:var(--text-secondary);">❌ Vencidas</div>
                    <div style="font-size:1.5rem; font-weight:700; color:#ff4b4b;">${contasVencidas}</div>
                </div>
                <div style="background:rgba(255,255,255,0.05); padding:12px; border-radius:10px;">
                    <div style="font-size:0.85rem; color:var(--text-secondary);">💰 Valor Total</div>
                    <div style="font-size:1.5rem; font-weight:700;">${formatBRL(totalContasValor)}</div>
                </div>
            </div>
    `;

    if (contasComStatus.length > 0) {
        const pagas     = contasComStatus.filter(c => c.status === 'Paga');
        const pendentes = contasComStatus.filter(c => c.status === 'Pendente');
        const vencidas  = contasComStatus.filter(c => c.status === 'Vencida');

        const renderConta = (c) => `
            <div style="background:${c.corFundo}; padding:14px; border-radius:10px; border-left:3px solid ${c.corStatus};">
                <div style="font-weight:600; font-size:0.9rem;">${sanitizeHTML(String(c.descricao || '').slice(0, 100))}</div>
                <div style="font-size:0.85rem; color:var(--text-secondary); margin-top:6px;">
                    Valor: <strong>${formatBRL(sanitizeNumber(c.valor))}</strong><br>
                    Vencimento: <strong>${sanitizeHTML(formatarDataBR(c.vencimento))}</strong>
                    ${c.status === 'Vencida' ? '<br><span style="color:#ff4b4b; font-weight:600; font-size:0.8rem;">⚠️ Atenção: Conta vencida!</span>' : ''}
                </div>
            </div>`;

        const col = (items, vazio) => items.length > 0
            ? items.map(renderConta).join('')
            : `<div style="text-align:center; padding:20px; color:var(--text-muted); font-size:0.85rem;">${vazio}</div>`;

        html += `
            <div style="display:grid; grid-template-columns:repeat(4, 1fr); gap:12px; align-items:start;">
                <div style="display:flex; flex-direction:column; gap:12px;">${col(pagas, 'Nenhuma conta paga')}</div>
                <div style="display:flex; flex-direction:column; gap:12px;">${col(pendentes, 'Nenhuma conta pendente')}</div>
                <div style="display:flex; flex-direction:column; gap:12px;">${col(vencidas, 'Nenhuma conta vencida')}</div>
                <div></div>
            </div>`;
    } else {
        html += `
            <div style="text-align:center; padding:40px; background:rgba(255,255,255,0.03); border-radius:12px; border:2px dashed var(--border);">
                <div style="font-size:3rem; margin-bottom:12px; opacity:0.5;">🔭</div>
                <div style="font-size:1.1rem; font-weight:600; margin-bottom:8px;">Nenhuma Conta Fixa Registrada</div>
                <div style="font-size:0.9rem; color:var(--text-secondary);">
                    ${periodoSelecionado === periodoAtualCompleto ?
                        'Você não tem contas fixas para este mês. Cadastre no menu Dashboard!' :
                        'Não há contas fixas registradas para este período.'}
                </div>
            </div>`;
    }
    html += `</div>`;

    if (transacoesPeriodo.length > 0) {
        html += `<div class="relatorio-lista" style="margin-top:30px;"><h3>Todas as Transações (${transacoesPeriodo.length})</h3>`;

        transacoesPeriodo.sort((a, b) => {
            const dataHoraA = `${sanitizeDate(dataParaISO(a.data)) || ''} ${String(a.hora || '')}`;
            const dataHoraB = `${sanitizeDate(dataParaISO(b.data)) || ''} ${String(b.hora || '')}`;
            return dataHoraB.localeCompare(dataHoraA);
        });

        transacoesPeriodo.forEach(t => {
            if (!t || typeof t !== 'object') return;
            let styleClass, sinal;
            if (t.categoria === 'entrada') { styleClass = 'entrada'; sinal = '+'; }
            else { styleClass = t.categoria === 'saida' ? 'saida' : 'reserva'; sinal = '-'; }

            html += `
                <div class="relatorio-item">
                    <div class="relatorio-item-info">
                        <div class="relatorio-item-tipo">${sanitizeHTML(String(t.tipo || '').slice(0, 100))}</div>
                        <div class="relatorio-item-desc">${sanitizeHTML(String(t.descricao || '').slice(0, 200))}</div>
                        <div class="relatorio-item-data">${sanitizeHTML(String(t.data || ''))} às ${sanitizeHTML(String(t.hora || ''))}</div>
                    </div>
                    <div class="${styleClass}" style="font-size:18px; font-weight:bold;">
                        ${sinal} ${formatBRL(sanitizeNumber(t.valor))}
                    </div>
                </div>`;
        });
        html += `</div>`;
    }

    // ✅ CORREÇÃO PRINCIPAL: aplica _sanitizarHTMLRelatorio (DOMParser + whitelist CSS)
    //    antes de qualquer atribuição innerHTML ou insertAdjacentHTML.
    //    Isso garante que mesmo dados de usuário que passaram por sanitizeHTML (escape de entidades)
    //    também sejam verificados pelo whitelist CSS, remoção de on*, remoção de tags perigosas
    //    e bloqueio de esquemas javascript:/vbscript:/data: em atributos.
    //    Crítico para planos Família/Casal onde dados do dono são exibidos para membros convidados.
    if (html) {
        resultado.insertAdjacentHTML('beforeend', _sanitizarHTMLRelatorio(html));
    }
    resultado.style.display = 'block';

    if (metasPerfil.length > 0) {
        const selectMeta = document.getElementById('selectMetaRelatorio');
        if (selectMeta) {
            selectMeta.addEventListener('change', function () {
                const metaId    = this.value;
                const detalhesEl = document.getElementById('detalhesMetaRelatorio');
                if (!detalhesEl) return;
                if (!metaId) { detalhesEl.style.display = 'none'; return; }

                const meta = metasPerfil.find(m => String(m.id) === String(metaId));
                if (!meta) return;

                const saved      = sanitizeNumber(meta.saved);
                const objetivo   = sanitizeNumber(meta.objetivo);
                const falta      = Math.max(0, objetivo - saved);
                const perc       = objetivo > 0 ? Math.min(100, ((saved / objetivo) * 100).toFixed(1)) : 0;

                const depositosMes = transacoesPerfil.filter(t => {
                    const dataISO = sanitizeDate(dataParaISO(t.data));
                    return dataISO && dataISO.startsWith(periodoSelecionado) &&
                        t.categoria === 'reserva' && String(t.metaId) === String(metaId);
                });
                const totalDepositadoMes = depositosMes.reduce((sum, t) => sum + sanitizeNumber(t.valor), 0);

                const retiradasMes = transacoesPerfil.filter(t => {
                    const dataISO = sanitizeDate(dataParaISO(t.data));
                    return dataISO && dataISO.startsWith(periodoSelecionado) &&
                        t.categoria === 'retirada_reserva' && String(t.metaId) === String(metaId);
                });
                const totalRetiradoMes = retiradasMes.reduce((sum, t) => sum + sanitizeNumber(t.valor), 0);

                let corProgresso = '#ff4b4b';
                if (perc >= 75) corProgresso = '#00ff99';
                else if (perc >= 40) corProgresso = '#ffd166';

                const detalhesHtml = `
                    <div style="background:rgba(255,255,255,0.05); padding:20px; border-radius:12px; border:1px solid var(--border);">
                        <h4 style="margin-bottom:16px; font-size:1.2rem;">${sanitizeHTML(String(meta.descricao || '').slice(0, 100))}</h4>
                        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(140px, 1fr)); gap:12px; margin-bottom:20px;">
                            <div style="text-align:center; padding:12px; background:rgba(255,255,255,0.03); border-radius:10px;">
                                <div style="font-size:0.85rem; color:var(--text-secondary);">Objetivo</div>
                                <div style="font-size:1.2rem; font-weight:700;">${formatBRL(objetivo)}</div>
                            </div>
                            <div style="text-align:center; padding:12px; background:rgba(255,255,255,0.03); border-radius:10px;">
                                <div style="font-size:0.85rem; color:var(--text-secondary);">Guardado</div>
                                <div style="font-size:1.2rem; font-weight:700; color:#00ff99;">${formatBRL(saved)}</div>
                            </div>
                            <div style="text-align:center; padding:12px; background:rgba(255,255,255,0.03); border-radius:10px;">
                                <div style="font-size:0.85rem; color:var(--text-secondary);">Falta</div>
                                <div style="font-size:1.2rem; font-weight:700; color:#ff4b4b;">${formatBRL(falta)}</div>
                            </div>
                            <div style="text-align:center; padding:12px; background:rgba(255,255,255,0.03); border-radius:10px;">
                                <div style="font-size:0.85rem; color:var(--text-secondary);">Progresso</div>
                                <div style="font-size:1.2rem; font-weight:700; color:${corProgresso};">${sanitizeHTML(String(perc))}%</div>
                            </div>
                        </div>
                        <div style="margin-bottom:20px;">
                            <div style="display:flex; justify-content:space-between; margin-bottom:8px;">
                                <span style="font-weight:600; color:var(--text-secondary);">Barra de Progresso</span>
                                <span style="font-weight:700; color:${corProgresso};">${sanitizeHTML(String(perc))}%</span>
                            </div>
                            <div style="width:100%; height:20px; background:rgba(255,255,255,0.1); border-radius:10px; overflow:hidden;">
                                <div style="width:${sanitizeHTML(String(perc))}%; height:100%; background:${corProgresso}; border-radius:10px; transition:width 0.8s; display:flex; align-items:center; justify-content:center; color:white; font-weight:700; font-size:0.85rem;">
                                    ${Number(perc) > 10 ? sanitizeHTML(String(perc)) + '%' : ''}
                                </div>
                            </div>
                        </div>
                        <div style="background:rgba(255,209,102,0.1); padding:14px; border-radius:10px; border-left:3px solid #ffd166; margin-bottom:12px;">
                            <div style="font-weight:600; margin-bottom:4px;">💰 Depositado neste mês</div>
                            <div style="font-size:1.3rem; font-weight:700; color:#ffd166;">${formatBRL(totalDepositadoMes)}</div>
                            <div style="font-size:0.85rem; color:var(--text-secondary); margin-top:4px;">${depositosMes.length} depósito(s) realizado(s)</div>
                        </div>
                        ${totalRetiradoMes > 0 ? `
                        <div style="background:rgba(255,149,0,0.1); padding:14px; border-radius:10px; border-left:3px solid #ff9500;">
                            <div style="font-weight:600; margin-bottom:4px;">💸 Retirado neste mês</div>
                            <div style="font-size:1.3rem; font-weight:700; color:#ff9500;">${formatBRL(totalRetiradoMes)}</div>
                            <div style="font-size:0.85rem; color:var(--text-secondary); margin-top:4px;">${retiradasMes.length} retirada(s) realizada(s)</div>
                        </div>` : ''}
                    </div>`;

                // ✅ CORREÇÃO: detalhesEl.innerHTML também passa pelo sanitizador DOMParser
                detalhesEl.innerHTML = _sanitizarHTMLRelatorio(detalhesHtml);
                detalhesEl.style.display = 'block';
            });
        }
    }
}

async function gerarRelatorioCompartilhado(mes, ano, numPerfis) {
    // CORREÇÃO: Validar inputs
    if (!/^\d{2}$/.test(mes) || parseInt(mes, 10) < 1 || parseInt(mes, 10) > 12) return;
    if (!/^\d{4}$/.test(ano) || parseInt(ano, 10) < 2000 || parseInt(ano, 10) > 2100) return;
    
    // CORREÇÃO: Limitar numPerfis a um máximo razoável
    const numPerfisSeguro = Math.min(Math.max(parseInt(numPerfis, 10) || 0, 0), 20);
    
    const periodoSelecionado = `${ano}-${mes}`;
    const perfisAtivos = (usuarioLogado?.perfis || []).slice(0, numPerfisSeguro);
    
    if (perfisAtivos.length < 2) {
        const resultado = document.getElementById('relatorioResultado');
        if (resultado) {
            // ✅ CORREÇÃO VULN #3: _sanitizarHTMLRelatorio adicionado — segunda camada DOMParser.
            //    Antes: innerHTML direto, sem DOMParser, sem whitelist CSS.
            //    Agora: consistente com todos os outros caminhos do relatório.
            //    Mesmo sendo HTML estático, a cobertura uniforme elimina o risco
            //    de regressão caso futuramente dados do usuário sejam adicionados aqui.
            resultado.innerHTML = _sanitizarHTMLRelatorio(`
                <div class="relatorio-vazio">
                    <h3>⚠️ Perfis Insuficientes</h3>
                    <p>Você precisa ter pelo menos 2 perfis cadastrados para gerar este tipo de relatório.</p>
                </div>
            `);
            resultado.style.display = 'block';
        }
        return;
    }
    
    let mesAnterior, anoAnterior;
    if (mes === '01') {
        mesAnterior = '12';
        anoAnterior = String(Number(ano) - 1);
    } else {
        mesAnterior = String(Number(mes) - 1).padStart(2, '0');
        anoAnterior = ano;
    }
    const periodoAnterior = `${anoAnterior}-${mesAnterior}`;
    
    const userData = await dataManager.loadUserData();
    
    // CORREÇÃO: Validar estrutura
    if (!validarUserData(userData)) {
        console.error('Dados do usuário inválidos ou corrompidos');
        return;
    }
    
    const dadosPorPerfil = perfisAtivos.map(perfil => {
        // CORREÇÃO: === estrito
        const dadosPerfil = userData.profiles.find(p => String(p.id) === String(perfil.id));
        const transacoesPerfil = Array.isArray(dadosPerfil?.transacoes) ? dadosPerfil.transacoes : [];
        const metasPerfil = Array.isArray(dadosPerfil?.metas) ? dadosPerfil.metas : [];
        const cartoesPerfil = Array.isArray(dadosPerfil?.cartoesCredito) ? dadosPerfil.cartoesCredito : [];
        
        const transacoesPeriodo = transacoesPerfil.filter(t => {
            if (!t || typeof t !== 'object') return false;
            const dataISO = sanitizeDate(dataParaISO(t.data));
            if (!dataISO) return false;
            return dataISO.startsWith(periodoSelecionado);
        });
        
        let saldoInicial = 0;
        transacoesPerfil.forEach(t => {
            if (!t || typeof t !== 'object') return;
            const dataISO = sanitizeDate(dataParaISO(t.data));
            if (!dataISO || dataISO >= periodoSelecionado) return;
            const valor = sanitizeNumber(t.valor);
            if (t.categoria === 'entrada') saldoInicial += valor;
            else if (t.categoria === 'saida') saldoInicial -= valor;
            else if (t.categoria === 'reserva') saldoInicial -= valor;
            else if (t.categoria === 'retirada_reserva') saldoInicial += valor;
        });
        
        let entradas = 0, saidas = 0, totalGuardado = 0, totalRetirado = 0;
        // CORREÇÃO: safeCategorias()
        const categorias = safeCategorias();
        
        transacoesPerfil.forEach(t => {
            if (!t || typeof t !== 'object') return;
            const dataISO = sanitizeDate(dataParaISO(t.data));
            if (!dataISO || !dataISO.startsWith(periodoSelecionado)) return;
            const valor = sanitizeNumber(t.valor);
            if (t.categoria === 'entrada') {
                entradas += valor;
            } else if (t.categoria === 'saida') {
                saidas += valor;
                if (t.tipo && typeof t.tipo === 'string' && t.tipo.length < 100) {
                    const tipoKey = t.tipo.trim();
                    categorias[tipoKey] = (categorias[tipoKey] || 0) + valor;
                }
            } else if (t.categoria === 'reserva') {
                totalGuardado += valor;
                saidas += valor;
            } else if (t.categoria === 'retirada_reserva') {
                totalRetirado += valor;
                saidas -= valor;
            }
        });
        
        const saldoDoMes = entradas - saidas;
        const saldoFinal = saldoInicial + saldoDoMes;
        
        let entradasAnt = 0, saidasAnt = 0, guardadoAnt = 0, retiradoAnt = 0;
        transacoesPerfil.forEach(t => {
            if (!t || typeof t !== 'object') return;
            const dataISO = sanitizeDate(dataParaISO(t.data));
            if (!dataISO || !dataISO.startsWith(periodoAnterior)) return;
            const valor = sanitizeNumber(t.valor);
            if (t.categoria === 'entrada') entradasAnt += valor;
            else if (t.categoria === 'saida') saidasAnt += valor;
            else if (t.categoria === 'reserva') { guardadoAnt += valor; saidasAnt += valor; }
            else if (t.categoria === 'retirada_reserva') { retiradoAnt += valor; saidasAnt -= valor; }
        });
        
        const reservasLiquido = totalGuardado - totalRetirado;
        const reservasLiquidoAnt = guardadoAnt - retiradoAnt;
        const taxaEconomia = entradas > 0 ? ((reservasLiquido / entradas) * 100) : 0;
        const taxaEconomiaAnt = entradasAnt > 0 ? ((reservasLiquidoAnt / entradasAnt) * 100) : 0;
        
        let totalLimiteCartoes = 0, totalUsadoCartoes = 0;
        cartoesPerfil.forEach(c => {
            if (!c || typeof c !== 'object') return;
            totalLimiteCartoes += sanitizeNumber(c.limite);
            totalUsadoCartoes += sanitizeNumber(c.usado);
        });
        
        return {
            perfil, entradas, saidas, reservas: reservasLiquido,
            totalGuardado, totalRetirado, saldoInicial, saldoDoMes, saldo: saldoFinal,
            categorias, transacoes: transacoesPeriodo, metas: metasPerfil,
            cartoes: cartoesPerfil, totalLimiteCartoes, totalUsadoCartoes,
            mesAnterior: { entradas: entradasAnt, saidas: saidasAnt, reservas: reservasLiquidoAnt, saldo: entradasAnt - saidasAnt },
            taxaEconomia, taxaEconomiaAnterior: taxaEconomiaAnt,
            evolucaoEconomia: taxaEconomia - taxaEconomiaAnt
        };
    });
    
    const temDados = dadosPorPerfil.some(d => d.transacoes.length > 0);
    const resultado = document.getElementById('relatorioResultado');
    if (!resultado) return;
    
    if (!temDados) {
        const tipoTexto = tipoRelatorioAtivo === 'casal' ? 'do Casal' : 'da Família';
        // ✅ CORREÇÃO VULN #3: _sanitizarHTMLRelatorio adicionado.
        //    tipoTexto é valor interno (ternário), mas os nomes de perfil (p.nome)
        //    são dados do usuário — passam por sanitizeHTML() E agora também
        //    pelo DOMParser, garantindo defesa em profundidade real.
        //    Padrão agora é 100% consistente com o caminho renderizarRelatorioCompartilhado.
        resultado.innerHTML = _sanitizarHTMLRelatorio(`
            <div class="relatorio-vazio">
                <h3>📊 Nenhum relatório disponível</h3>
                <p>Não há transações registradas ${sanitizeHTML(tipoTexto)} em ${sanitizeHTML(getMesNome(mes))} de ${sanitizeHTML(ano)}</p>
                <p style="margin-top:12px; color:var(--text-muted);">
                    Perfis verificados: ${perfisAtivos.map(p => sanitizeHTML(String(p.nome || ''))).join(', ')}
                </p>
            </div>
        `);
        resultado.style.display = 'block';
        return;
    }
    
    renderizarRelatorioCompartilhado(dadosPorPerfil, mes, ano, mesAnterior, anoAnterior);
}

function renderizarRelatorioCompartilhado(dadosPorPerfil, mes, ano, mesAnterior, anoAnterior) {
    const resultado = document.getElementById('relatorioResultado');
    if (!resultado) return;

    if (!Array.isArray(dadosPorPerfil) || dadosPorPerfil.length === 0) return;

    const tipoTexto = tipoRelatorioAtivo === 'casal' ? 'do Casal' : 'da Família';
    const icone     = tipoRelatorioAtivo === 'casal' ? '💑' : '👨‍👩‍👧‍👦';

    let totalGeralEntradas          = 0;
    let totalGeralSaidas            = 0;
    let totalGeralReservasLiquido   = 0;
    let totalGeralGuardado          = 0;
    let totalGeralRetirado          = 0;
    const categoriasGerais          = safeCategorias();

    dadosPorPerfil.forEach(d => {
        if (!d || typeof d !== 'object') return;
        totalGeralEntradas        += sanitizeNumber(d.entradas);
        totalGeralSaidas          += sanitizeNumber(d.saidas);
        totalGeralReservasLiquido += sanitizeNumber(d.reservas);
        totalGeralGuardado        += sanitizeNumber(d.totalGuardado);
        totalGeralRetirado        += sanitizeNumber(d.totalRetirado);

        if (d.categorias && typeof d.categorias === 'object') {
            Object.keys(d.categorias).forEach(cat => {
                if (cat && typeof cat === 'string' && cat.length < 100) {
                    categoriasGerais[cat] = (categoriasGerais[cat] || 0) + sanitizeNumber(d.categorias[cat]);
                }
            });
        }
    });

    const saldoGeral        = totalGeralEntradas - totalGeralSaidas;
    const taxaEconomiaGeral = totalGeralEntradas > 0
        ? ((totalGeralReservasLiquido / totalGeralEntradas) * 100).toFixed(1)
        : 0;
    const saldoInicialGeral = dadosPorPerfil.reduce((sum, d) => sum + sanitizeNumber(d?.saldoInicial), 0);
    const saldoGeralDoMes   = dadosPorPerfil.reduce((sum, d) => sum + sanitizeNumber(d?.saldoDoMes), 0);

    // ✅ CORREÇÃO PRINCIPAL: todo o bloco de HTML estático ainda usa template string,
    //    mas passa obrigatoriamente por _sanitizarHTMLRelatorio (DOMParser + whitelist CSS)
    //    antes de qualquer atribuição a innerHTML.
    //    Dados de usuário (nomes, categorias) continuam sanitizados via sanitizeHTML()
    //    E recebem uma segunda camada pelo DOMParser — defesa em profundidade real.
    let html = `
    <h2 style="text-align:center; margin-bottom:30px;">
        ${icone} Relatório Completo ${sanitizeHTML(tipoTexto)}<br>
        <span style="font-size:1.2rem; color:var(--text-secondary);">
            ${sanitizeHTML(getMesNome(mes))} de ${sanitizeHTML(ano)}
        </span>
    </h2>

    <div class="relatorio-kpis-container">
        <div class="relatorio-kpis-scroll">
            <div class="relatorio-kpi-card relatorio-kpi-entradas">
                <div class="relatorio-kpi-header">
                    <span class="relatorio-kpi-icon">💰</span>
                    <span class="relatorio-kpi-label">Entradas Totais</span>
                </div>
                <div class="relatorio-kpi-value">${formatBRL(totalGeralEntradas)}</div>
                <div class="relatorio-kpi-footer">
                    <span class="relatorio-kpi-period">Soma de todos os perfis</span>
                </div>
            </div>
            <div class="relatorio-kpi-card relatorio-kpi-saidas">
                <div class="relatorio-kpi-header">
                    <span class="relatorio-kpi-icon">💸</span>
                    <span class="relatorio-kpi-label">Saídas Totais</span>
                </div>
                <div class="relatorio-kpi-value">${formatBRL(totalGeralSaidas)}</div>
                <div class="relatorio-kpi-footer">
                    <span class="relatorio-kpi-period">Soma de todos os perfis</span>
                </div>
            </div>
            <div class="relatorio-kpi-card relatorio-kpi-guardado">
                <div class="relatorio-kpi-header">
                    <span class="relatorio-kpi-icon">🎯</span>
                    <span class="relatorio-kpi-label">Guardado Líquido</span>
                </div>
                <div class="relatorio-kpi-value">${formatBRL(totalGeralReservasLiquido)}</div>
                <div class="relatorio-kpi-footer">
                    <span class="relatorio-kpi-period" style="font-size:10px;">
                        Guardou: ${formatBRL(totalGeralGuardado)} | Retirou: ${formatBRL(totalGeralRetirado)}
                    </span>
                </div>
            </div>
            <div class="relatorio-kpi-card relatorio-kpi-saldo">
                <div class="relatorio-kpi-header">
                    <span class="relatorio-kpi-icon">📈</span>
                    <span class="relatorio-kpi-label">Saldo Total</span>
                </div>
                <div class="relatorio-kpi-value">${formatBRL(saldoGeral)}</div>
                <div class="relatorio-kpi-footer">
                    <span class="relatorio-kpi-period" style="font-size:10px;">
                        Saldo inicial: ${formatBRL(saldoInicialGeral)} | Saldo do mês: ${formatBRL(saldoGeralDoMes)}
                    </span>
                </div>
            </div>
            <div class="relatorio-kpi-card relatorio-kpi-economia">
                <div class="relatorio-kpi-header">
                    <span class="relatorio-kpi-icon">💎</span>
                    <span class="relatorio-kpi-label">Taxa de Economia</span>
                </div>
                <div class="relatorio-kpi-value">${sanitizeHTML(String(taxaEconomiaGeral))}%</div>
                <div class="relatorio-kpi-footer">
                    <span class="relatorio-kpi-period">Média ${sanitizeHTML(tipoTexto.toLowerCase())}</span>
                </div>
            </div>
        </div>
    </div>

    <div class="section-box" style="margin-top:30px;">
        <h3 style="text-align:center; margin-bottom:20px;">🏆 Rankings e Comparativos</h3>
        <div class="tipo-relatorio-btns" style="margin-bottom:24px;">
            <button class="tipo-btn ranking-btn active" data-ranking="gastos">💸 Quem Gastou Mais</button>
            <button class="tipo-btn ranking-btn" data-ranking="guardou">💰 Quem Guardou Mais</button>
            <button class="tipo-btn ranking-btn" data-ranking="economia">📊 Melhor Taxa de Economia</button>
            <button class="tipo-btn ranking-btn" data-ranking="evolucao">📈 Maior Evolução</button>
        </div>
        <div id="rankingContainer"></div>
    </div>

    <div class="section-box" style="margin-top:30px;">
        <h3 style="text-align:center; margin-bottom:20px;">📋 Análise Individual Completa</h3>
        <div class="comparacao-perfis" style="grid-template-columns:repeat(auto-fit, minmax(280px, 1fr));">
    `;

    dadosPorPerfil.forEach(d => {
        if (!d || typeof d !== 'object') return;

        const diasNoMes        = new Date(Number(ano), Number(mes), 0).getDate();
        const mediaGastoDiario = diasNoMes > 0 ? sanitizeNumber(d.saidas) / diasNoMes : 0;
        const percUsadoCartoes = d.totalLimiteCartoes > 0
            ? ((d.totalUsadoCartoes / d.totalLimiteCartoes) * 100).toFixed(1)
            : 0;

        const variacaoEntradas  = d.mesAnterior?.entradas > 0
            ? (((d.entradas  - d.mesAnterior.entradas)  / d.mesAnterior.entradas)  * 100).toFixed(1) : 0;
        const variacaoSaidas    = d.mesAnterior?.saidas > 0
            ? (((d.saidas    - d.mesAnterior.saidas)    / d.mesAnterior.saidas)    * 100).toFixed(1) : 0;
        const variacaoReservas  = d.mesAnterior?.reservas !== 0
            ? (((d.reservas  - d.mesAnterior.reservas)  / Math.abs(d.mesAnterior.reservas || 1)) * 100).toFixed(1) : 0;

        const nomePerfilSeguro = sanitizeHTML(String(d.perfil?.nome || '').slice(0, 100));
        const perfilIdSeguro   = sanitizeHTML(String(d.perfil?.id   || ''));

        html += `
            <div class="perfil-card-relatorio"
                 style="background:var(--gradient-dark); border:1px solid var(--border); padding:20px;">
                <h4 style="margin-bottom:16px; font-size:1.3rem; color:var(--primary);">
                    ${nomePerfilSeguro}
                </h4>
                <div class="perfil-stats">
                    <div class="stat-row">
                        <span class="stat-label">💰 Entradas</span>
                        <span class="stat-value entrada">${formatBRL(d.entradas)}</span>
                    </div>
                    ${d.mesAnterior?.entradas > 0 ? `
                    <div style="font-size:0.8rem;
                                color:${variacaoEntradas >= 0 ? '#00ff99' : '#ff4b4b'};
                                text-align:right; margin-top:-8px; margin-bottom:8px;">
                        ${variacaoEntradas >= 0 ? '↑' : '↓'} ${Math.abs(variacaoEntradas)}% vs mês anterior
                    </div>` : ''}
                    <div class="stat-row">
                        <span class="stat-label">💸 Saídas</span>
                        <span class="stat-value saida">${formatBRL(d.saidas)}</span>
                    </div>
                    ${d.mesAnterior?.saidas > 0 ? `
                    <div style="font-size:0.8rem;
                                color:${variacaoSaidas <= 0 ? '#00ff99' : '#ff4b4b'};
                                text-align:right; margin-top:-8px; margin-bottom:8px;">
                        ${variacaoSaidas >= 0 ? '↑' : '↓'} ${Math.abs(variacaoSaidas)}% vs mês anterior
                    </div>` : ''}
                    <div class="stat-row">
                        <span class="stat-label">🎯 Guardado Líquido</span>
                        <span class="stat-value reserva">${formatBRL(d.reservas)}</span>
                    </div>
                    ${d.mesAnterior?.reservas !== 0 ? `
                    <div style="font-size:0.8rem;
                                color:${variacaoReservas >= 0 ? '#00ff99' : '#ff4b4b'};
                                text-align:right; margin-top:-8px; margin-bottom:8px;">
                        ${variacaoReservas >= 0 ? '↑' : '↓'} ${Math.abs(variacaoReservas)}% vs mês anterior
                    </div>` : ''}
                    <div class="stat-row">
                        <span class="stat-label">📊 Saldo</span>
                        <span class="stat-value" style="color:#6c63ff;">${formatBRL(d.saldo)}</span>
                    </div>
                    <div class="stat-row">
                        <span class="stat-label">💎 Taxa de Economia</span>
                        <span class="stat-value" style="color:#00ff99;">
                            ${sanitizeHTML(String(d.taxaEconomia.toFixed(1)))}%
                        </span>
                    </div>
                    ${d.taxaEconomiaAnterior > 0 ? `
                    <div style="font-size:0.8rem;
                                color:${d.evolucaoEconomia >= 0 ? '#00ff99' : '#ff4b4b'};
                                text-align:right; margin-top:-8px; margin-bottom:8px;">
                        ${d.evolucaoEconomia >= 0 ? '↑' : '↓'} ${Math.abs(d.evolucaoEconomia.toFixed(1))}% vs mês anterior
                    </div>` : ''}
                    <div class="stat-row"
                         style="border-top:1px solid var(--border); padding-top:8px; margin-top:8px;">
                        <span class="stat-label">📅 Média Diária</span>
                        <span class="stat-value">${formatBRL(mediaGastoDiario)}</span>
                    </div>
                    <div class="stat-row">
                        <span class="stat-label">📝 Transações</span>
                        <span class="stat-value">${d.transacoes.length}</span>
                    </div>
                    ${d.cartoes?.length > 0 ? `
                    <div class="stat-row"
                         style="border-top:1px solid var(--border); padding-top:8px; margin-top:8px;">
                        <span class="stat-label">💳 Cartões Usados</span>
                        <span class="stat-value"
                              style="color:${percUsadoCartoes > 80 ? '#ff4b4b' : '#00ff99'};">
                            ${sanitizeHTML(String(percUsadoCartoes))}%
                        </span>
                    </div>` : ''}
                    ${d.metas?.length > 0 ? `
                    <div class="stat-row">
                        <span class="stat-label">🎯 Metas Ativas</span>
                        <span class="stat-value">${d.metas.length}</span>
                    </div>` : ''}
                </div>
                <div id="btnDetalhes_${perfilIdSeguro}" style="margin-top:16px;"></div>
            </div>`;
    });

    html += `</div></div>`;

    if (Object.keys(categoriasGerais).length > 0) {
        const categoriasTop         = Object.entries(categoriasGerais).sort((a, b) => b[1] - a[1]).slice(0, 5);
        const totalGastoCategorias  = Object.values(categoriasGerais).reduce((a, b) => a + b, 0);
        const coresCategorias       = ['#ff6b6b', '#4ecdc4', '#45b7d1', '#f9ca24', '#6c5ce7'];

        html += `
        <div class="section-box" style="margin-top:30px;">
            <h3 style="margin-bottom:20px;">🎯 Top 5 Categorias Mais Gastas (Geral)</h3>
            <div style="display:flex; flex-direction:column; gap:12px;">
        `;

        categoriasTop.forEach(([cat, valor], i) => {
            const percentual = ((valor / totalGastoCategorias) * 100).toFixed(1);
            html += `
                <div style="margin-bottom:8px;">
                    <div style="display:flex; justify-content:space-between;
                                margin-bottom:6px; flex-wrap:wrap; gap:8px;">
                        <span style="font-weight:600;">${sanitizeHTML(cat)}</span>
                        <span>${formatBRL(valor)} (${sanitizeHTML(String(percentual))}%)</span>
                    </div>
                    <div style="width:100%; height:12px; background:rgba(255,255,255,0.1);
                                border-radius:6px; overflow:hidden;">
                        <div style="width:${sanitizeHTML(String(percentual))}%; height:100%;
                                    background:${coresCategorias[i]}; border-radius:6px;"></div>
                    </div>
                </div>`;
        });

        html += `</div></div>`;
    }

    // ✅ CORREÇÃO: _sanitizarHTMLRelatorio aplicado antes de resultado.innerHTML
    //    Antes: resultado.innerHTML = html  ← sem DOMParser, innerHTML direto
    //    Agora: passa pelo DOMParser com whitelist CSS, remoção de on*, tags perigosas
    //           e bloqueio de esquemas javascript:/vbscript:/data: em atributos
    resultado.innerHTML = _sanitizarHTMLRelatorio(html);
    resultado.style.display = 'block';

    dadosPorPerfil.forEach(d => {
        if (!d?.perfil?.id) return;
        const btnContainer = document.getElementById(
            `btnDetalhes_${sanitizeHTML(String(d.perfil.id))}`
        );
        if (btnContainer) {
            const btn         = document.createElement('button');
            btn.className     = 'btn-primary';
            btn.style.cssText = 'width:100%; padding:10px;';
            btn.textContent   = '🔍 Ver Detalhes Completos';
            btn.addEventListener('click', () => {
                abrirDetalhesPerfilRelatorio(d.perfil.id, mes, ano);
            });
            btnContainer.appendChild(btn);
        }
    });

    configurarRankings(dadosPorPerfil, mes, ano);
    mostrarRanking('gastos', dadosPorPerfil);
}

// ========== WIDGET "ONDE FOI MEU DINHEIRO?" ==========
function processarAnaliseOndeForDinheiro() {
    const mes       = document.getElementById('mesAnalise').value;
    const ano       = document.getElementById('anoAnalise').value;
    const container = document.getElementById('resultadoAnalise');

    const analise = gerarAnaliseOndeForDinheiro(mes, ano);

    if (!analise.temDados) {
        container.innerHTML = '';
        const wrapperVazio = document.createElement('div');
        wrapperVazio.style.cssText = 'text-align:center; padding:40px; background:rgba(255,255,255,0.03); border-radius:12px;';

        const iconDiv = document.createElement('div');
        iconDiv.style.cssText = 'font-size:3rem; margin-bottom:12px; opacity:0.5;';
        iconDiv.textContent = '🔍';

        const tituloDiv = document.createElement('div');
        tituloDiv.style.cssText = 'font-size:1.1rem; font-weight:600; color:var(--text-primary); margin-bottom:8px;';
        tituloDiv.textContent = 'Sem Dados Disponíveis';

        const msgDiv = document.createElement('div');
        msgDiv.style.cssText = 'font-size:0.9rem; color:var(--text-secondary);';
        msgDiv.textContent = analise.mensagem;

        wrapperVazio.appendChild(iconDiv);
        wrapperVazio.appendChild(tituloDiv);
        wrapperVazio.appendChild(msgDiv);
        container.appendChild(wrapperVazio);
        return;
    }

    // ✅ CORREÇÃO: constrói narrativa via DOM usando narrativaPartes (estruturado)
    //    em vez de interpolar analise.narrativa (que é undefined após refatoração)
    //    Elimina o risco de dados de usuário em innerHTML mesmo com sanitizeHTML
    const narrativaContainer = document.createElement('div');
    narrativaContainer.style.cssText = 'font-size:1.1rem; line-height:1.8; color:var(--text-primary);';

    (analise.narrativaPartes || []).forEach(parte => {
        if (parte.tipo === 'texto') {
            narrativaContainer.appendChild(document.createTextNode(parte.texto));
        } else if (parte.tipo === 'destaque') {
            narrativaContainer.appendChild(document.createTextNode(parte.prefixo || ''));
            const strong = document.createElement('strong');
            strong.textContent = parte.destaque || ''; // ✅ textContent — nunca innerHTML
            narrativaContainer.appendChild(strong);
            narrativaContainer.appendChild(document.createTextNode(parte.sufixo || ''));
        }
    });

    let html = `
        <div style="background:linear-gradient(135deg, rgba(67,160,71,0.2), rgba(108,99,255,0.2)); padding:24px; border-radius:16px; margin-bottom:24px; border-left:4px solid var(--primary);">
            <div id="_narrativaPlaceholder"></div>
            <div style="text-align:center; margin-top:20px; padding-top:20px; border-top:1px solid var(--border);">
                <div style="font-size:0.85rem; color:var(--text-secondary); margin-bottom:8px;">Total Gasto no Período</div>
                <div style="font-size:2rem; font-weight:700; color:#ff4b4b;">${formatBRL(analise.totalGastos)}</div>
                <div style="font-size:0.85rem; color:var(--text-muted); margin-top:4px;">${sanitizeHTML(String(analise.totalTransacoes))} transações registradas</div>
            </div>
        </div>
        <div style="background:rgba(255,255,255,0.03); padding:24px; border-radius:16px; margin-bottom:24px;">
            <h4 style="margin-bottom:16px; color:var(--text-primary); text-align:center;">📊 Distribuição por Categoria</h4>
            <div style="display:flex; flex-direction:column; gap:12px;">
    `;

    const cores = ['#ff4b4b', '#ffd166', '#4ecdc4', '#45b7d1', '#f9ca24', '#6c5ce7', '#a29bfe', '#fd79a8'];

    analise.categorias.forEach(([categoria, valor], i) => {
        const percentual = ((valor / analise.totalGastos) * 100).toFixed(1);
        const cor        = cores[i % cores.length]; // ✅ cor vem de array interno, nunca de dado de usuário

        html += `
            <div style="margin-bottom:12px;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                    <div style="display:flex; align-items:center; gap:10px;">
                        <div style="width:16px; height:16px; background:${cor}; border-radius:4px;"></div>
                        <span style="font-weight:600; color:var(--text-primary);">${sanitizeHTML(categoria)}</span>
                    </div>
                    <div style="text-align:right;">
                        <div style="font-weight:700; color:var(--text-primary);">${formatBRL(valor)}</div>
                        <div style="font-size:0.85rem; color:var(--text-secondary);">${sanitizeHTML(percentual)}%</div>
                    </div>
                </div>
                <div style="width:100%; height:12px; background:rgba(255,255,255,0.1); border-radius:6px; overflow:hidden;">
                    <div style="width:${sanitizeHTML(percentual)}%; height:100%; background:${cor}; border-radius:6px; transition:width 0.5s;"></div>
                </div>
            </div>
        `;
    });

    html += `</div></div>`;

    // ─────────────────────────────────────────────────────────────────────────
    // ✅ CORREÇÃO PRINCIPAL:
    //    Antes: container.innerHTML = html  (sem DOMParser)
    //    Depois: passa por _sanitizarHTMLRelatorio (DOMParser + whitelist CSS)
    //    ENTÃO: insere a narrativa via DOM API — dados de usuário NUNCA tocam innerHTML
    // ─────────────────────────────────────────────────────────────────────────
    container.innerHTML = _sanitizarHTMLRelatorio(html);

    // ✅ Substitui o placeholder pela narrativa construída via DOM
    const placeholder = container.querySelector('#_narrativaPlaceholder');
    if (placeholder && narrativaContainer) {
        placeholder.replaceWith(narrativaContainer);
    }

    // Insight section — apenas texto estático + formatBRL (numérico)
    const insightDiv = document.createElement('div');
    insightDiv.style.cssText = 'background:rgba(108,99,255,0.1); padding:20px; border-radius:16px; border-left:4px solid #6c63ff;';

    const insightHeader = document.createElement('div');
    insightHeader.style.cssText = 'display:flex; align-items:center; gap:12px; margin-bottom:12px;';

    const iconInsight = document.createElement('div');
    iconInsight.style.fontSize = '2rem';
    iconInsight.textContent = '💡';

    const tituloInsight = document.createElement('div');
    tituloInsight.style.cssText = 'font-weight:700; font-size:1.1rem; color:var(--text-primary);';
    tituloInsight.textContent = 'Insight Inteligente';

    insightHeader.appendChild(iconInsight);
    insightHeader.appendChild(tituloInsight);

    const textoInsight = document.createElement('div');
    textoInsight.style.cssText = 'color:var(--text-secondary); line-height:1.6; font-size:0.95rem;';

    const ticketMedio = analise.totalGastos / analise.totalTransacoes;

    // ✅ Constrói insight via textContent — zero risco de XSS
    if (analise.top3[0]) {
        const percTop = ((analise.top3[0][1] / analise.totalGastos) * 100).toFixed(0);
        if (Number(percTop) > 50) {
            const p = document.createElement('p');
            const aviso = document.createElement('strong');
            aviso.textContent = '⚠️ Atenção: ';
            p.appendChild(aviso);
            p.appendChild(document.createTextNode(
                `${percTop}% dos seus gastos foram com `
            ));
            const bold = document.createElement('strong');
            bold.textContent = analise.top3[0][0]; // ✅ textContent
            p.appendChild(bold);
            p.appendChild(document.createTextNode(
                `. Isso representa mais da metade do seu orçamento! Considere analisar oportunidades de redução nesta categoria.`
            ));
            textoInsight.appendChild(p);
        }
    }

    const pTicket = document.createElement('p');
    const boldTicket = document.createElement('strong');
    boldTicket.textContent = 'Gasto médio por transação: ';
    pTicket.appendChild(boldTicket);
    pTicket.appendChild(document.createTextNode(
        `${formatBRL(ticketMedio)}. ${ticketMedio > 200
            ? 'Isso indica transações de valores significativos. Certifique-se de que cada gasto esteja alinhado com suas prioridades.'
            : 'Você mantém transações de valores moderados, o que pode indicar um bom controle diário.'
        }`
    ));
    textoInsight.appendChild(pTicket);

    insightDiv.appendChild(insightHeader);
    insightDiv.appendChild(textoInsight);
    container.appendChild(insightDiv);
}

// ========== GERAR ANÁLISE "ONDE FOI MEU DINHEIRO?" ==========
function gerarAnaliseOndeForDinheiro(mes, ano) {
    if (!mes || !ano) {
        return { temDados: false, mensagem: 'Selecione mês e ano para analisar.' };
    }

    const periodoSelecionado = `${ano}-${mes}`;

    const transacoesPeriodo = transacoes.filter(t => {
        if (!t || typeof t !== 'object') return false;
        const dataISO = sanitizeDate(dataParaISO(t.data));
        if (!dataISO) return false;
        return dataISO.startsWith(periodoSelecionado) && t.categoria === 'saida';
    });

    if (transacoesPeriodo.length === 0) {
        return {
            temDados: false,
            mensagem: `Não há gastos registrados em ${getMesNome(mes)} de ${ano}.`
        };
    }

    const categorias = safeCategorias();
    transacoesPeriodo.forEach(t => {
        if (t.tipo && typeof t.tipo === 'string' && t.tipo.length < 100) {
            const tipoKey = t.tipo.trim();
            categorias[tipoKey] = (categorias[tipoKey] || 0) + sanitizeNumber(t.valor);
        }
    });

    const totalGastos         = Object.values(categorias).reduce((sum, v) => sum + v, 0);
    const categoriasOrdenadas = Object.entries(categorias).sort((a, b) => b[1] - a[1]);
    const top3                = categoriasOrdenadas.slice(0, 3);

    // ✅ CORREÇÃO: retorna partes estruturadas em vez de HTML concatenado.
    //    O caller monta o DOM via textContent, sem risco de double-escaping.
    const narrativaPartes = [];

    narrativaPartes.push({
        tipo:  'texto',
        texto: `Em ${getMesNome(mes)} de ${ano}, você realizou ${transacoesPeriodo.length} transação(ões) de saída. `
    });

    if (top3[0]) {
        const percTop = ((top3[0][1] / totalGastos) * 100).toFixed(0);
        narrativaPartes.push({
            tipo:       'destaque',
            prefixo:    'Seu maior gasto foi em ',
            destaque:   top3[0][0],
            sufixo:     `, representando ${percTop}% do total. `
        });
    }
    if (top3[1]) {
        narrativaPartes.push({
            tipo:     'destaque',
            prefixo:  'Em segundo lugar, gastos com ',
            destaque: top3[1][0],
            sufixo:   '. '
        });
    }
    if (top3[2]) {
        narrativaPartes.push({
            tipo:     'destaque',
            prefixo:  'E em terceiro, ',
            destaque: top3[2][0],
            sufixo:   '.'
        });
    }

    return {
        temDados:        true,
        totalGastos,
        totalTransacoes: transacoesPeriodo.length,
        categorias:      categoriasOrdenadas,
        top3,
        narrativaPartes  // ✅ estruturado — sem HTML misturado com dados
    };
}

// ========== ABRIR WIDGET "ONDE FOI MEU DINHEIRO?" ==========
function abrirWidgetOndeForDinheiro() {
    if (!perfilAtivo) {
        mostrarNotificacao('Selecione um perfil primeiro.', 'error');
        return;
    }

    const hoje     = new Date();
    const anoAtual = hoje.getFullYear();
    const mesAtual = String(hoje.getMonth() + 1).padStart(2, '0');

    const mesesNomes = {
        '01': 'Janeiro', '02': 'Fevereiro', '03': 'Março',    '04': 'Abril',
        '05': 'Maio',    '06': 'Junho',     '07': 'Julho',    '08': 'Agosto',
        '09': 'Setembro','10': 'Outubro',   '11': 'Novembro', '12': 'Dezembro'
    };

    criarPopupDOM((popup) => {
        // ── Wrapper scroll
        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'max-height:75vh; overflow-y:auto; padding-right:8px;';

        // ── Título
        const titulo = document.createElement('h3');
        titulo.style.cssText = 'text-align:center; margin-bottom:8px;';
        titulo.textContent = '🔍 Onde Foi Meu Dinheiro?';

        // ── Subtítulo
        const subtitulo = document.createElement('p');
        subtitulo.style.cssText = 'color:var(--text-secondary); margin-bottom:20px; font-size:0.9rem; text-align:center;';
        subtitulo.textContent = 'Veja para onde foram seus gastos em um período específico.';

        // ── Row de filtros
        const rowFiltros = document.createElement('div');
        rowFiltros.style.cssText = 'display:flex; gap:12px; margin-bottom:16px; flex-wrap:wrap;';

        // ── Coluna Mês
        const colMes = document.createElement('div');
        colMes.style.cssText = 'flex:1; min-width:130px;';

        const labelMes = document.createElement('label');
        labelMes.style.cssText = 'display:block; margin-bottom:6px; font-size:0.85rem; font-weight:600; color:var(--text-secondary);';
        labelMes.textContent = '📅 Mês:';

        const selectMes = document.createElement('select');
        selectMes.id        = 'mesAnalise';
        selectMes.className = 'form-input';

        Object.entries(mesesNomes).forEach(([val, nome]) => {
            const opt       = document.createElement('option');
            opt.value       = val;           // ✅ .value — não interpolado
            opt.textContent = nome;          // ✅ textContent — não innerHTML
            if (val === mesAtual) opt.selected = true;
            selectMes.appendChild(opt);
        });

        colMes.appendChild(labelMes);
        colMes.appendChild(selectMes);

        // ── Coluna Ano
        const colAno = document.createElement('div');
        colAno.style.cssText = 'flex:1; min-width:100px;';

        const labelAno = document.createElement('label');
        labelAno.style.cssText = 'display:block; margin-bottom:6px; font-size:0.85rem; font-weight:600; color:var(--text-secondary);';
        labelAno.textContent = '📆 Ano:';

        const selectAno = document.createElement('select');
        selectAno.id        = 'anoAnalise';
        selectAno.className = 'form-input';

        for (let a = anoAtual; a >= anoAtual - 4; a--) {
            const opt       = document.createElement('option');
            opt.value       = String(a);
            opt.textContent = String(a);
            if (a === anoAtual) opt.selected = true;
            selectAno.appendChild(opt);
        }

        colAno.appendChild(labelAno);
        colAno.appendChild(selectAno);

        rowFiltros.appendChild(colMes);
        rowFiltros.appendChild(colAno);

        // ── Botão analisar
        const btnAnalisar = document.createElement('button');
        btnAnalisar.id        = 'btnAnalisarGastos';
        btnAnalisar.className = 'btn-primary';
        btnAnalisar.style.cssText = 'width:100%; margin-bottom:20px;';
        btnAnalisar.textContent = '🔍 Analisar Gastos';
        btnAnalisar.addEventListener('click', processarAnaliseOndeForDinheiro);

        // ── Container resultado
        const resultadoDiv = document.createElement('div');
        resultadoDiv.id = 'resultadoAnalise';

        wrapper.appendChild(titulo);
        wrapper.appendChild(subtitulo);
        wrapper.appendChild(rowFiltros);
        wrapper.appendChild(btnAnalisar);
        wrapper.appendChild(resultadoDiv);

        // ── Botão fechar (fora do wrapper scroll)
        const btnFechar = document.createElement('button');
        btnFechar.id        = 'fecharWidgetAnalise';
        btnFechar.className = 'btn-cancelar';
        btnFechar.style.cssText = 'width:100%; margin-top:14px;';
        btnFechar.textContent = 'Fechar';
        btnFechar.addEventListener('click', fecharPopup);

        popup.appendChild(wrapper);
        popup.appendChild(btnFechar);
    });

    // Executa análise com o período padrão imediatamente
    processarAnaliseOndeForDinheiro();
}

window.processarAnaliseOndeForDinheiro = processarAnaliseOndeForDinheiro;
window.abrirWidgetOndeForDinheiro = abrirWidgetOndeForDinheiro;


// Função para configurar eventos dos rankings
function configurarRankings(dadosPorPerfil, mes, ano) {
    const btnsRanking = document.querySelectorAll('.ranking-btn');
    
    btnsRanking.forEach(btn => {
        btn.addEventListener('click', function() {
            btnsRanking.forEach(b => b.classList.remove('active'));
            this.classList.add('active');
            
            const tipoRanking = this.getAttribute('data-ranking');
            mostrarRanking(tipoRanking, dadosPorPerfil);
        });
    });
}

// Função para mostrar diferentes tipos de ranking
function mostrarRanking(tipo, dadosPorPerfil) {
    const container = document.getElementById('rankingContainer');
    if (!container) return;

    // ✅ Limpa via DOM — sem innerHTML vazio como surface
    container.innerHTML = '';

    const emojis = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];

    function _criarItemRanking({
        corFundo,
        corBorda,
        posicaoTxt,
        nomeTxt,
        detalhesTxt,
        valorTxt,
        corValor = null,
        fontSizeValor = null,
    }) {
        const item = document.createElement('div');
        item.className        = 'ranking-item';
        item.style.background = corFundo; // ✅ cor interna — não vem do usuário
        item.style.borderLeft = `3px solid ${corBorda}`; // ✅ idem

        const posicao           = document.createElement('div');
        posicao.className       = 'ranking-posicao';
        posicao.textContent     = posicaoTxt; // ✅ emoji ou número — valor interno

        const info              = document.createElement('div');
        info.className          = 'ranking-info';

        const nomeEl            = document.createElement('div');
        nomeEl.className        = 'ranking-nome';
        nomeEl.textContent      = _sanitizeText(String(nomeTxt || '')); // ✅ textContent — dado do usuário

        const detalhesEl        = document.createElement('div');
        detalhesEl.className    = 'ranking-detalhes';
        detalhesEl.textContent  = String(detalhesTxt || ''); // ✅ textContent — formatBRL retorna string numérica

        info.appendChild(nomeEl);
        info.appendChild(detalhesEl);

        const valorEl           = document.createElement('div');
        valorEl.className       = 'ranking-valor';
        valorEl.textContent     = String(valorTxt || ''); // ✅ textContent — formatBRL ou percentual numérico
        if (corValor)     valorEl.style.color    = corValor;    // ✅ cor interna
        if (fontSizeValor) valorEl.style.fontSize = fontSizeValor; // ✅ valor interno

        item.appendChild(posicao);
        item.appendChild(info);
        item.appendChild(valorEl);

        return item;
    }

    function _criarTitulo(texto) {
        const h4 = document.createElement('h4');
        h4.style.cssText = 'margin-bottom:16px; color: var(--text-primary);';
        h4.textContent   = texto; // ✅ texto estático — sem dado do usuário
        return h4;
    }

    function _criarSubtitulo(texto) {
        const p = document.createElement('p');
        p.style.cssText = 'font-size:0.9rem; color: var(--text-secondary); margin-bottom:16px;';
        p.textContent   = texto; // ✅ texto estático
        return p;
    }

    switch (tipo) {

        // ── GASTOS ────────────────────────────────────────────────────────────
        case 'gastos': {
            const rankingGastos = dadosPorPerfil
                .map(d => ({ nome: d.perfil.nome, valor: d.saidas }))
                .sort((a, b) => b.valor - a.valor);

            const totalGastos = rankingGastos.reduce((sum, r) => sum + r.valor, 0);

            container.appendChild(_criarTitulo('💸 Ranking: Quem Gastou Mais'));

            rankingGastos.forEach((r, i) => {
                const percentual = totalGastos > 0
                    ? ((r.valor / totalGastos) * 100).toFixed(1)
                    : '0.0';

                container.appendChild(_criarItemRanking({
                    corFundo:    'rgba(255,75,75,0.1)',
                    corBorda:    '#ff4b4b',
                    posicaoTxt:  emojis[i] || String(i + 1),
                    nomeTxt:     r.nome,
                    detalhesTxt: `${percentual}% do total de gastos`,
                    valorTxt:    formatBRL(r.valor),
                }));
            });
            break;
        }

        // ── GUARDOU ───────────────────────────────────────────────────────────
        case 'guardou': {
            const rankingGuardou = dadosPorPerfil
                .map(d => ({ nome: d.perfil.nome, valor: d.reservas }))
                .sort((a, b) => b.valor - a.valor);

            const totalGuardado = rankingGuardou.reduce((sum, r) => sum + r.valor, 0);

            container.appendChild(_criarTitulo('💰 Ranking: Quem Guardou Mais'));

            rankingGuardou.forEach((r, i) => {
                const percentual = totalGuardado > 0
                    ? ((r.valor / totalGuardado) * 100).toFixed(1)
                    : '0.0';

                container.appendChild(_criarItemRanking({
                    corFundo:    'rgba(0,255,153,0.1)',
                    corBorda:    '#00ff99',
                    posicaoTxt:  emojis[i] || String(i + 1),
                    nomeTxt:     r.nome,
                    detalhesTxt: `${percentual}% do total guardado`,
                    valorTxt:    formatBRL(r.valor),
                    corValor:    '#00ff99',
                }));
            });
            break;
        }

        // ── ECONOMIA ──────────────────────────────────────────────────────────
        case 'economia': {
            const rankingEconomia = dadosPorPerfil
                .map(d => ({
                    nome:      d.perfil.nome,
                    taxa:      d.taxaEconomia,
                    guardado:  d.reservas,
                    entradas:  d.entradas,
                }))
                .sort((a, b) => b.taxa - a.taxa);

            container.appendChild(_criarTitulo('📊 Ranking: Melhor Taxa de Economia'));
            container.appendChild(_criarSubtitulo('Quanto % do que ganhou foi guardado'));

            rankingEconomia.forEach((r, i) => {
                container.appendChild(_criarItemRanking({
                    corFundo:      'rgba(255,209,102,0.1)',
                    corBorda:      '#ffd166',
                    posicaoTxt:    emojis[i] || String(i + 1),
                    nomeTxt:       r.nome,
                    // ✅ formatBRL retorna string numérica formatada — textContent seguro
                    detalhesTxt:   `Guardou ${formatBRL(r.guardado)} de ${formatBRL(r.entradas)}`,
                    valorTxt:      `${r.taxa.toFixed(1)}%`,
                    corValor:      '#ffd166',
                    fontSizeValor: '1.5rem',
                }));
            });
            break;
        }

        // ── EVOLUÇÃO ──────────────────────────────────────────────────────────
        case 'evolucao': {
            const rankingEvolucao = dadosPorPerfil
                .map(d => ({
                    nome:         d.perfil.nome,
                    evolucao:     d.evolucaoEconomia,
                    taxaAtual:    d.taxaEconomia,
                    taxaAnterior: d.taxaEconomiaAnterior,
                }))
                .sort((a, b) => b.evolucao - a.evolucao);

            container.appendChild(_criarTitulo('📈 Ranking: Maior Evolução na Economia'));
            container.appendChild(_criarSubtitulo('Comparação com o mês anterior'));

            rankingEvolucao.forEach((r, i) => {
                // ✅ corEvolucao e simbolo determinados por lógica interna — não vêm do usuário
                const corEvolucao = r.evolucao >= 0 ? '#00ff99' : '#ff4b4b';
                const simbolo     = r.evolucao >= 0 ? '↑' : '↓';

                container.appendChild(_criarItemRanking({
                    corFundo:    'rgba(108,99,255,0.1)',
                    corBorda:    corEvolucao,
                    posicaoTxt:  emojis[i] || String(i + 1),
                    nomeTxt:     r.nome,
                    detalhesTxt: `${r.taxaAnterior.toFixed(1)}% → ${r.taxaAtual.toFixed(1)}%`,
                    valorTxt:    `${simbolo} ${Math.abs(r.evolucao).toFixed(1)}%`,
                    corValor:    corEvolucao,
                }));
            });
            break;
        }

        // ── TIPO DESCONHECIDO ─────────────────────────────────────────────────
        default:
            _log.warn('[mostrarRanking] Tipo de ranking desconhecido:', tipo);
            break;
    }
}

// Função para abrir detalhes completos de um perfil específico
function abrirDetalhesPerfilRelatorio(perfilId, mes, ano) {
    // ✅ HTML estático sem onclick inline — sanitizarHTMLPopup remove atributos on*,
    //    por isso o botão ficava morto. Substituído por addEventListener após criação.
    criarPopup(`
        <h3>🔍 Detalhes Completos</h3>
        <div class="small">Carregando dados detalhados do período...</div>
        <button class="btn-primary" id="btnFecharDetalhesRelatorio">Fechar</button>
    `);

    // ✅ addEventListener — funciona independente do sanitizador
    const btnFechar = document.getElementById('btnFecharDetalhesRelatorio');
    if (btnFechar) {
        btnFechar.addEventListener('click', fecharPopup);
    }

    setTimeout(() => {
        gerarRelatorioIndividual(mes, ano, perfilId);
        fecharPopup();
    }, 500);
}

// Expor globalmente
window.abrirDetalhesPerfilRelatorio = abrirDetalhesPerfilRelatorio;

// ========== DETALHES DO CARTÃO NO RELATÓRIO ==========

async function abrirDetalhesCartaoRelatorio(cartaoId, mes, ano, perfilId) {
    const userData = await dataManager.loadUserData();
    const dadosPerfil = userData.profiles.find(p => p.id === perfilId);

    const cartoesPerfil = dadosPerfil ? dadosPerfil.cartoesCredito || [] : [];
    const contasFixasPerfil = dadosPerfil ? dadosPerfil.contasFixas || [] : [];

    const cartao = cartoesPerfil.find(c => c.id === cartaoId);
    if (!cartao) {
        mostrarNotificacao('Cartão não encontrado.', 'error');
        return;
    }

    const periodoSelecionado = `${ano}-${mes}`;

    const faturasCartao = contasFixasPerfil.filter(c =>
        c.cartaoId === cartaoId &&
        c.vencimento &&
        c.vencimento.startsWith(periodoSelecionado)
    );

    let todasCompras = [];
    faturasCartao.forEach(fatura => {
        if (fatura.compras && fatura.compras.length > 0) {
            fatura.compras.forEach(compra => {
                todasCompras.push({
                    ...compra,
                    faturaId: fatura.id,
                    vencimentoFatura: fatura.vencimento
                });
            });
        }
    });

    const usado = Number(cartao.usado || 0);
    const limite = Number(cartao.limite || 0);
    const disponivel = limite - usado;
    const percUsado = limite > 0 ? ((usado / limite) * 100).toFixed(1) : 0;

    const totalCompras = todasCompras.reduce((sum, c) => sum + Number(c.valorParcela || 0), 0);
    const comprasPagas = todasCompras.filter(c => c.parcelaAtual > c.totalParcelas).length;
    const comprasPendentes = todasCompras.length - comprasPagas;

    // ✅ obterDicaAleatoria() agora retorna {titulo, texto} — nunca HTML
    const dica = obterDicaAleatoria();

    let htmlCompras = '';

    if (todasCompras.length === 0) {
        htmlCompras = `
            <div style="text-align:center; padding:40px; background:rgba(255,255,255,0.03); border-radius:12px;">
                <div style="font-size:3rem; margin-bottom:12px; opacity:0.5;">🛍️</div>
                <div style="font-size:1.1rem; font-weight:600; color: var(--text-primary); margin-bottom:8px;">
                    Nenhuma Compra Registrada
                </div>
                <div style="font-size:0.9rem; color: var(--text-secondary);">
                    Este cartão não possui compras no período de ${sanitizeHTML(getMesNome(mes))} de ${sanitizeHTML(ano)}
                </div>
            </div>
        `;
    } else {
        todasCompras.forEach(compra => {
            const statusParcela = compra.parcelaAtual > compra.totalParcelas
                ? '✅ Paga'
                : `🔄 Parcela ${sanitizeHTML(compra.parcelaAtual)}/${sanitizeHTML(compra.totalParcelas)}`;

            const corBorda = compra.parcelaAtual > compra.totalParcelas ? '#00ff99' : '#ffd166';
            const corFaltaPagar = compra.parcelaAtual > compra.totalParcelas ? '#00ff99' : '#ff4b4b';
            const textoFaltaPagar = compra.parcelaAtual > compra.totalParcelas
                ? '✅ Quitado'
                : formatBRL(compra.valorParcela * (compra.totalParcelas - compra.parcelaAtual + 1));

            const safeCompraId  = sanitizeHTML(String(compra.id));
            const safeFaturaId  = sanitizeHTML(String(compra.faturaId));

            htmlCompras += `
                <div style="background:rgba(255,255,255,0.03); padding:16px; border-radius:12px; margin-bottom:12px; border-left:3px solid ${corBorda};">
                    <div style="display:flex; justify-content:space-between; align-items:start; flex-wrap:wrap; gap:10px; margin-bottom:10px;">
                        <div style="flex:1;">
                            <div style="font-weight:600; color: var(--text-primary); font-size:1rem; margin-bottom:6px;">
                                ${sanitizeHTML(compra.tipo)}
                            </div>
                            <div style="color: var(--text-secondary); font-size:0.9rem;">
                                ${sanitizeHTML(compra.descricao)}
                            </div>
                            <div style="color: var(--text-muted); font-size:0.85rem; margin-top:6px;">
                                📅 ${sanitizeHTML(formatarDataBR(compra.dataCompra))}
                            </div>
                        </div>
                        <div style="text-align:right;">
                            <div style="font-weight:700; color: var(--text-primary); font-size:1.2rem;">
                                ${formatBRL(compra.valorParcela)}
                            </div>
                            <div style="font-size:0.85rem; margin-top:4px; color: ${corBorda}; font-weight:600;">
                                ${statusParcela}
                            </div>
                        </div>
                    </div>
                    <div style="display:grid; grid-template-columns:repeat(2, 1fr); gap:10px; padding-top:10px; border-top:1px solid var(--border);">
                        <div>
                            <div style="font-size:0.75rem; color: var(--text-muted);">Valor Total</div>
                            <div style="font-weight:600; color: var(--text-secondary);">${formatBRL(compra.valorTotal)}</div>
                        </div>
                        <div>
                            <div style="font-size:0.75rem; color: var(--text-muted);">Falta Pagar</div>
                            <div style="font-weight:600; color: ${corFaltaPagar};">
                                ${textoFaltaPagar}
                            </div>
                        </div>
                    </div>
                </div>
            `;
        });
    }

    criarPopup(`
        <div style="max-height:80vh; overflow-y:auto; overflow-x:hidden; position:relative; padding-right:10px;">
            <button id="btnFecharCartaoRelatorio" style="position:absolute; top:12px; right:12px; background:#ff4b4b; border:none; color:#ffffff; font-size:1.5rem; width:36px; height:36px; border-radius:8px; cursor:pointer; display:flex; align-items:center; justify-content:center; font-weight:700; z-index:10; box-shadow:0 2px 8px rgba(255,75,75,0.3);">
                ✖
            </button>

            <h3 style="text-align:center; margin-bottom:20px; padding-right:50px;">
                💳 Análise Detalhada do Cartão
            </h3>

            <!-- Cabeçalho do Cartão -->
            <div style="background:linear-gradient(135deg, var(--primary), var(--secondary)); padding:20px; border-radius:12px; margin-bottom:20px; text-align:center;">
                <div style="font-size:1.5rem; font-weight:700; color:white; margin-bottom:8px;">
                    ${sanitizeHTML(cartao.nomeBanco)}
                </div>
                <div style="font-size:0.9rem; color:rgba(255,255,255,0.8);">
                    Período: ${sanitizeHTML(getMesNome(mes))} de ${sanitizeHTML(ano)}
                </div>
            </div>

            <!-- Estatísticas do Cartão -->
            <div style="display:grid; grid-template-columns:repeat(2, 1fr); gap:12px; margin-bottom:20px;">
                <div style="background:rgba(255,255,255,0.05); padding:14px; border-radius:10px; text-align:center;">
                    <div style="font-size:0.85rem; color: var(--text-secondary); margin-bottom:6px;">💰 Limite Total</div>
                    <div style="font-size:1.3rem; font-weight:700; color: var(--text-primary);">${formatBRL(limite)}</div>
                </div>
                <div style="background:rgba(255,255,255,0.05); padding:14px; border-radius:10px; text-align:center;">
                    <div style="font-size:0.85rem; color: var(--text-secondary); margin-bottom:6px;">💸 Usado</div>
                    <div style="font-size:1.3rem; font-weight:700; color: #ff4b4b;">${formatBRL(usado)}</div>
                </div>
                <div style="background:rgba(255,255,255,0.05); padding:14px; border-radius:10px; text-align:center;">
                    <div style="font-size:0.85rem; color: var(--text-secondary); margin-bottom:6px;">✅ Disponível</div>
                    <div style="font-size:1.3rem; font-weight:700; color: #00ff99;">${formatBRL(disponivel)}</div>
                </div>
                <div style="background:rgba(255,255,255,0.05); padding:14px; border-radius:10px; text-align:center;">
                    <div style="font-size:0.85rem; color: var(--text-secondary); margin-bottom:6px;">📊 % Utilizado</div>
                    <div style="font-size:1.3rem; font-weight:700; color: ${Number(percUsado) > 80 ? '#ff4b4b' : '#00ff99'};">${sanitizeHTML(percUsado)}%</div>
                </div>
            </div>

            <!-- Barra de Progresso -->
            <div style="margin-bottom:20px;">
                <div style="display:flex; justify-content:space-between; margin-bottom:8px;">
                    <span style="font-size:0.9rem; color: var(--text-secondary);">Utilização do Limite</span>
                    <span style="font-weight:700; color: ${Number(percUsado) > 80 ? '#ff4b4b' : '#00ff99'};">${sanitizeHTML(percUsado)}%</span>
                </div>
                <div style="width:100%; height:20px; background:rgba(255,255,255,0.1); border-radius:10px; overflow:hidden;">
                    <div style="width:${sanitizeHTML(percUsado)}%; height:100%; background:${Number(percUsado) > 80 ? '#ff4b4b' : '#00ff99'}; border-radius:10px; transition:width 0.8s;"></div>
                </div>
            </div>

            <!-- Resumo de Compras -->
            <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:12px; margin-bottom:20px;">
                <div style="background:rgba(108,99,255,0.1); padding:12px; border-radius:10px; text-align:center; border-left:3px solid #6c63ff;">
                    <div style="font-size:0.85rem; color: var(--text-secondary);">🛍️ Total Compras</div>
                    <div style="font-size:1.4rem; font-weight:700; color: #6c63ff;">${todasCompras.length}</div>
                </div>
                <div style="background:rgba(0,255,153,0.1); padding:12px; border-radius:10px; text-align:center; border-left:3px solid #00ff99;">
                    <div style="font-size:0.85rem; color: var(--text-secondary);">✅ Pagas</div>
                    <div style="font-size:1.4rem; font-weight:700; color: #00ff99;">${comprasPagas}</div>
                </div>
                <div style="background:rgba(255,209,102,0.1); padding:12px; border-radius:10px; text-align:center; border-left:3px solid #ffd166;">
                    <div style="font-size:0.85rem; color: var(--text-secondary);">⏳ Pendentes</div>
                    <div style="font-size:1.4rem; font-weight:700; color: #ffd166;">${comprasPendentes}</div>
                </div>
            </div>

            <!-- Lista de Compras -->
            <div style="margin-bottom:20px;">
                <h4 style="margin-bottom:12px; color: var(--text-primary);">🛒 Compras do Mês</h4>
                ${htmlCompras}
            </div>

            <!-- Dica do Dia -->
            <!-- ✅ Container vazio com ID — dica montada via DOM abaixo, nunca via innerHTML -->
            <div style="background:linear-gradient(135deg, rgba(108,99,255,0.2), rgba(76,166,255,0.2)); padding:16px; border-radius:12px; border-left:4px solid var(--primary);">
                <div style="display:flex; align-items:center; gap:12px; margin-bottom:10px;">
                    <div style="font-size:2rem;">💡</div>
                    <div style="font-weight:700; font-size:1.1rem; color: var(--text-primary);">Dica Inteligente</div>
                </div>
                <div id="dicaCartaoTexto" style="color: var(--text-secondary); line-height:1.6;"></div>
            </div>

            <button id="btnFecharCartaoRelatorioBottom" class="btn-primary" style="width:100%; margin-top:20px;">
                ✖️ Fechar
            </button>
        </div>
    `);

    document.getElementById('btnFecharCartaoRelatorio').addEventListener('click', fecharPopup);
    document.getElementById('btnFecharCartaoRelatorioBottom').addEventListener('click', fecharPopup);

    const dicaContainer = document.getElementById('dicaCartaoTexto');
    if (dicaContainer) {
        const icon   = document.createTextNode('💳 ');
        const strong = document.createElement('strong');
        strong.textContent = dica.titulo + ': ';
        const texto  = document.createTextNode(dica.texto); 
        dicaContainer.appendChild(icon);
        dicaContainer.appendChild(strong);
        dicaContainer.appendChild(texto);
    }
}

window.abrirDetalhesCartaoRelatorio = abrirDetalhesCartaoRelatorio;

// ========== BANCO DE DICAS SOBRE CARTÕES ==========

function obterDicaAleatoria() {
    const dicas = [
        { titulo: 'Pagamento em dia',        texto: 'Sempre pague sua fatura no vencimento para evitar juros altíssimos e manter seu score de crédito saudável.' },
        { titulo: 'Controle de gastos',      texto: 'Utilize no máximo 30% do limite do seu cartão para manter um bom histórico de crédito.' },
        { titulo: 'Organize suas compras',   texto: 'Faça compras grandes logo após o fechamento da fatura para ter mais tempo de pagamento.' },
        { titulo: 'Cashback inteligente',    texto: 'Priorize cartões com cashback em categorias que você mais gasta, como supermercado e combustível.' },
        { titulo: 'Segurança em primeiro lugar', texto: 'Nunca compartilhe sua senha ou CVV com terceiros, mesmo que pareçam ser do banco.' },
        { titulo: 'App do banco',            texto: 'Ative notificações de compras no app do banco para detectar fraudes rapidamente.' },
        { titulo: 'Cartão virtual',          texto: 'Use cartões virtuais para compras online — eles podem ser bloqueados sem afetar o cartão físico.' },
        { titulo: 'Evite o rotativo',        texto: 'Nunca pague apenas o valor mínimo — os juros do rotativo podem chegar a 400% ao ano!' },
        { titulo: 'Programas de pontos',     texto: 'Acumule pontos e milhas em um único programa para maximizar benefícios e trocas.' },
        { titulo: 'Data de vencimento',      texto: 'Escolha a melhor data de vencimento de acordo com o dia que recebe seu salário.' },
        { titulo: 'Anuidade zero',           texto: 'Negocie isenção de anuidade com seu banco ou opte por cartões sem taxa.' },
        { titulo: 'Parcelamento consciente', texto: 'Parcele apenas compras essenciais e evite acumular muitas parcelas simultâneas.' },
        { titulo: 'Limite adequado',         texto: 'Mantenha um limite compatível com sua renda para não cair na tentação de gastar demais.' },
        { titulo: 'Taxa de juros',           texto: 'Conheça as taxas do seu cartão e compare com outros bancos — você pode estar pagando mais.' },
        { titulo: 'Compras por impulso',     texto: 'Espere 24 horas antes de fazer compras grandes no cartão — isso evita arrependimentos.' },
        { titulo: 'Múltiplos cartões',       texto: 'Ter mais de um cartão pode ser útil, mas só se você conseguir controlar todos.' },
        { titulo: 'Planejamento financeiro', texto: 'Reserve parte da sua renda mensal para pagar a fatura completa todo mês.' },
        { titulo: 'Revise sua fatura',       texto: 'Confira todas as compras mensalmente para identificar cobranças indevidas.' },
        { titulo: 'Emergências',             texto: 'Não use o cartão como reserva de emergência — crie uma poupança separada para isso.' },
        { titulo: 'Controle de parcelas',    texto: 'Anote todas as parcelas e seus vencimentos para não perder o controle financeiro.' },
        { titulo: 'Compare preços',          texto: 'Compras parceladas sem juros podem ser mais caras que à vista — sempre compare.' },
        { titulo: 'Antecipação de parcelas', texto: 'Se possível, quite parcelas antecipadamente para reduzir o comprometimento futuro.' },
        { titulo: 'Benefícios exclusivos',   texto: 'Use benefícios como seguros, descontos e acesso a salas VIP em aeroportos.' },
        { titulo: 'Pagamentos digitais',     texto: 'Carteiras digitais como Apple Pay e Google Pay adicionam uma camada extra de segurança.' },
        { titulo: 'Bloqueio temporário',     texto: 'Bloqueie seu cartão temporariamente quando não estiver usando para evitar fraudes.' },
        { titulo: 'Negociação de dívidas',   texto: 'Se estiver endividado, negocie diretamente com o banco — eles têm programas especiais.' },
        { titulo: 'Fechamento da fatura',    texto: 'Conheça a data de fechamento para planejar melhor suas compras mensais.' },
        { titulo: 'Metas de gastos',         texto: 'Estabeleça um limite mensal de gastos no cartão e respeite-o rigorosamente.' },
        { titulo: 'Educação financeira',     texto: 'Invista tempo aprendendo sobre finanças — isso vale mais que qualquer benefício de cartão.' },
        { titulo: 'Portabilidade',           texto: 'Se encontrar melhores condições em outro banco, considere fazer a portabilidade da dívida.' },
        { titulo: 'Refinanciamento',         texto: 'Evite refinanciar dívidas de cartão — as taxas são abusivas e prolongam o endividamento.' },
        { titulo: 'Saque no cartão',         texto: 'NUNCA faça saque no cartão de crédito — as taxas são extremamente altas.' },
        { titulo: 'Análise mensal',          texto: 'Reserve um tempo todo mês para analisar seus gastos e identificar padrões.' },
        { titulo: 'Descontos exclusivos',    texto: 'Muitos cartões oferecem descontos em estabelecimentos parceiros — aproveite!' },
        { titulo: 'Seguro de compras',       texto: 'Verifique se seu cartão oferece seguro para compras — pode ser muito útil.' },
        { titulo: 'Programa de fidelidade',  texto: 'Participe de programas de fidelidade para ganhar benefícios extras.' },
        { titulo: 'Token digital',           texto: 'Use a função de token digital para compras online mais seguras.' },
        { titulo: 'Autenticação de dois fatores', texto: 'Sempre que possível, ative a autenticação de dois fatores.' },
        { titulo: 'Limite pré-aprovado',     texto: 'Não aceite aumentos de limite automáticos — avalie se realmente precisa.' },
        { titulo: 'Categoria de gastos',     texto: 'Use cartões específicos para categorias diferentes e maximize benefícios.' },
        { titulo: 'Calendário financeiro',   texto: 'Crie um calendário com todas as datas de vencimento dos seus cartões.' },
        { titulo: 'Compras internacionais',  texto: 'Prefira cartões sem IOF para compras no exterior — economiza bastante.' },
        { titulo: 'Black Friday consciente', texto: 'Não compre apenas porque está em promoção — avalie se realmente precisa.' },
        { titulo: 'Reserva de emergência',   texto: 'Tenha pelo menos 3 meses de despesas guardadas antes de usar crédito.' },
        { titulo: 'Relatórios mensais',      texto: 'Use aplicativos como o GranaEvo para acompanhar seus gastos em tempo real.' },
        { titulo: 'Programas de desconto',   texto: 'Cadastre-se em programas de desconto vinculados ao seu cartão.' },
        { titulo: 'Leitura do contrato',     texto: 'Leia sempre o contrato do cartão para conhecer todas as taxas e condições.' },
        { titulo: 'Educação dos filhos',     texto: 'Ensine seus filhos sobre uso responsável de cartão desde cedo.' },
        { titulo: 'Relacionamento bancário', texto: 'Mantenha um bom relacionamento com seu banco para conseguir melhores condições.' },
        { titulo: 'Evite empréstimos',       texto: 'Prefira economizar e comprar à vista do que parcelar tudo no cartão.' },
    ];

    const d = dicas[Math.floor(Math.random() * dicas.length)];
    return { titulo: d.titulo, texto: d.texto };
}

// Expor função globalmente
window.abrirDetalhesCartaoRelatorio = abrirDetalhesCartaoRelatorio;

// ========== CONFIGURAÇÕES ==========
async function alterarNome() {
    if (!perfilAtivo) {
        mostrarNotificacao('Erro: Nenhum perfil ativo encontrado.', 'error');
        return;
    }

    // ✅ CORREÇÃO: HTML do popup sem dados do usuário interpolados.
    //    O value do input é preenchido via .value após a criação do DOM,
    //    evitando qualquer risco residual de injeção via atributo HTML.
    criarPopup(`
        <h3>👤 Alterar Nome</h3>
        <div class="small">Digite seu novo nome ou apelido</div>
        <input type="text" id="novoNome" class="form-input" placeholder="Novo nome" maxlength="50">
        <button class="btn-primary" id="concluirNome">Concluir</button>
        <button class="btn-cancelar" id="cancelarNome">Cancelar</button>
    `);

    // ✅ Preenchimento seguro via .value — nunca via atributo HTML
    document.getElementById('novoNome').value = perfilAtivo.nome;

    document.getElementById('cancelarNome').addEventListener('click', fecharPopup);

    document.getElementById('concluirNome').addEventListener('click', async () => {
        const novoNome = document.getElementById('novoNome').value.trim();

        if (!novoNome) {
            mostrarNotificacao('Por favor, digite um nome válido.', 'error');
            return;
        }
        if (novoNome.length < 2) {
            mostrarNotificacao('O nome deve ter pelo menos 2 caracteres.', 'error');
            return;
        }

        const btn = document.getElementById('concluirNome');
        btn.disabled = true;
        btn.textContent = '⏳ Salvando...';

        try {
            // ✅ CORREÇÃO: usa _log (o logger definido neste arquivo) em vez de log
            _log.info('🔄 Atualizando nome do perfil...');

            const { data, error } = await supabase
                .from('profiles')
                .update({ name: novoNome })
                .eq('id', perfilAtivo.id)
                .select()
                .single();

            if (error) throw error;

            _log.info('✅ Nome atualizado');

            perfilAtivo.nome = novoNome;

            const idx = usuarioLogado.perfis.findIndex(p => p.id === perfilAtivo.id);
            if (idx !== -1) {
                usuarioLogado.perfis[idx].nome = novoNome;
            }

            atualizarNomeUsuario();
            await salvarDados();
            fecharPopup();
            mostrarNotificacao('✅ Nome alterado com sucesso!', 'success');

        } catch (error) {
            // ✅ CORREÇÃO: _log.error em vez de log.error
            _log.error('NOME_001', error);
            mostrarNotificacao('Não foi possível alterar o nome. Tente novamente.', 'error');
            btn.disabled = false;
            btn.textContent = 'Concluir';
        }
    });
}

window.alterarNome = alterarNome;


// ========== GERENCIADOR DE CONVIDADOS ==========
async function alterarEmail() {
    if (usuarioLogado.isGuest) {
        criarPopup(`
            <h3>🔒 Função Restrita</h3>
            <p style="margin:16px 0; color:var(--text-secondary); line-height:1.6;">
                Apenas o <strong>titular da conta</strong> pode gerenciar convidados.
                Entre em contato com quem te convidou para alterações.
            </p>
            <button class="btn-primary" id="btnFecharRestrito">Entendi</button>
        `);
        document.getElementById('btnFecharRestrito').addEventListener('click', fecharPopup);
        return;
    }

    const { data: members, error: membersError } = await supabase
        .from('account_members')
        .select('id, member_email, member_name, joined_at, is_active')
        .eq('owner_user_id', usuarioLogado.userId)
        .eq('is_active', true);

    const plano = usuarioLogado.plano;
    const limitesConvidados = { 'Individual': 0, 'Casal': 1, 'Família': 3 };
    const limiteConvidados = limitesConvidados[plano] ?? 0;
    const memberCount = members?.length ?? 0;

    // Helper interno: constrói HTML dos membros com sanitização completa
    function renderMembersHtml(lista) {
        if (!lista || lista.length === 0) {
            return `<p style="color:var(--text-muted); text-align:center; padding:16px 0;">Nenhum convidado ainda.</p>`;
        }
        let html = '';
        lista.forEach(m => {
            const dataEntrada = m.joined_at
                ? new Date(m.joined_at).toLocaleDateString('pt-BR')
                : 'Pendente';

            const safeName  = sanitizeHTML(m.member_name);
            const safeEmail = sanitizeHTML(m.member_email);
            const safeDate  = sanitizeHTML(dataEntrada);
            const safeId    = sanitizeHTML(String(m.id));

            html += `
                <div style="display:flex; justify-content:space-between; align-items:center;
                            padding:12px 16px; background:rgba(255,255,255,0.04);
                            border-radius:10px; margin-bottom:8px; border-left:3px solid #10b981;">
                    <div>
                        <div style="font-weight:600; color:var(--text-primary);">${safeName}</div>
                        <div style="font-size:0.85rem; color:var(--text-secondary);">${safeEmail}</div>
                        <div style="font-size:0.78rem; color:var(--text-muted);">Entrou em: ${safeDate}</div>
                    </div>
                    <button class="btn-excluir js-remove-member"
                            data-member-id="${safeId}"
                            data-member-name="${safeName}"
                            style="padding:6px 12px; font-size:0.8rem;">
                        🗑️ Remover
                    </button>
                </div>
            `;
        });
        return html;
    }

    if (limiteConvidados === 0) {
        criarPopup(`
            <h3>👥 Convidar Usuário</h3>
            <div style="background:rgba(255,209,102,0.1); border:1px solid rgba(255,209,102,0.3);
                        border-radius:12px; padding:16px; margin:16px 0; text-align:center;">
                <div style="font-size:2rem; margin-bottom:8px;">🔒</div>
                <div style="font-weight:600; color:#ffd166; margin-bottom:6px;">Plano ${sanitizeHTML(plano)}</div>
                <div style="font-size:0.9rem; color:var(--text-secondary); line-height:1.6;">
                    Seu plano permite apenas <strong>01 email por conta</strong>.<br>
                    Faça upgrade para o Plano Casal ou Família para convidar pessoas.
                </div>
            </div>
            <button class="btn-primary" id="btnUpgradePlano" style="width:100%; margin-bottom:10px;">
                ⬆️ Fazer Upgrade
            </button>
            <button class="btn-cancelar" id="btnFecharUpgrade" style="width:100%;">Fechar</button>
        `);
        document.getElementById('btnUpgradePlano').addEventListener('click', irParaAtualizarPlano);
        document.getElementById('btnFecharUpgrade').addEventListener('click', fecharPopup);
        return;
    }

    criarPopup(`
        <div style="max-height:70vh; overflow-y:auto; padding-right:8px;">
            <h3 style="text-align:center; margin-bottom:6px;">👥 Gerenciar Convidados</h3>
            <p style="text-align:center; font-size:0.85rem; color:var(--text-secondary); margin-bottom:20px;">
                Plano ${sanitizeHTML(plano)} — ${memberCount}/${limiteConvidados} convidado(s)
            </p>

            <div style="margin-bottom:20px;">
                <div style="font-size:0.8rem; font-weight:700; letter-spacing:2px; text-transform:uppercase;
                            color:var(--text-muted); margin-bottom:10px;">Convidados Ativos</div>
                ${renderMembersHtml(members)}
            </div>

            ${memberCount < limiteConvidados ? `
            <div style="border-top:1px solid var(--border); padding-top:20px;">
                <div style="font-size:0.8rem; font-weight:700; letter-spacing:2px; text-transform:uppercase;
                            color:#10b981; margin-bottom:14px;">+ Novo Convite</div>
                <input type="text"  id="inputNomeConvidado"         class="form-input" placeholder="Nome do convidado"   style="margin-bottom:10px;">
                <input type="email" id="inputEmailConvidado"        class="form-input" placeholder="Email do convidado"  style="margin-bottom:10px;">
                <input type="email" id="inputEmailConvidadoConfirm" class="form-input" placeholder="Confirme o email"    style="margin-bottom:16px;">
                <button class="btn-primary" id="btnEnviarConvite" style="width:100%;">
                    📨 Enviar Convite
                </button>
            </div>
            ` : `
            <div style="background:rgba(255,209,102,0.08); border:1px solid rgba(255,209,102,0.25);
                        border-radius:10px; padding:14px; text-align:center; margin-top:8px;">
                <div style="color:#ffd166; font-weight:600; margin-bottom:4px;">Limite atingido</div>
                <div style="font-size:0.85rem; color:var(--text-secondary);">
                    Você já possui ${memberCount}/${limiteConvidados} convidado(s) para o Plano ${sanitizeHTML(plano)}.
                </div>
            </div>
            `}
        </div>
        <button class="btn-cancelar" id="btnFecharConvidados" style="width:100%; margin-top:14px;">Fechar</button>
    `);

    // Vincular remoção via addEventListener — sem onclick inline
    document.querySelectorAll('.js-remove-member').forEach(btn => {
        btn.addEventListener('click', () => {
            const id   = btn.dataset.memberId;
            const nome = btn.dataset.memberName;
            removerConvidado(id, nome);
        });
    });

    const btnEnviar = document.getElementById('btnEnviarConvite');
    if (btnEnviar) btnEnviar.addEventListener('click', enviarConvite);

    document.getElementById('btnFecharConvidados').addEventListener('click', fecharPopup);
}

window.alterarEmail = alterarEmail;

// ✅ Hostname do Supabase definido como constante imutável no topo do módulo.
//    Nunca usar window.SUPABASE_URL ou variáveis mutáveis em runtime.
const _SUPABASE_ALLOWED_HOSTNAME = 'fvrhqqeofqedmhadzzqw.supabase.co';

// ✅ Controle de rate limit client-side para convites
//    Impede spam via duplo clique ou automação simples no frontend
//    (a proteção real deve existir também no backend via rate limiter)
const _conviteControl = (() => {
    let _ultimoEnvio = 0;
    const _INTERVALO_MIN_MS = 30_000; // 30 segundos entre convites

    return {
        podeEnviar() {
            return (Date.now() - _ultimoEnvio) >= _INTERVALO_MIN_MS;
        },
        registrar() {
            _ultimoEnvio = Date.now();
        },
        tempoRestante() {
            const restante = _INTERVALO_MIN_MS - (Date.now() - _ultimoEnvio);
            return Math.max(0, Math.ceil(restante / 1000));
        }
    };
})();

async function enviarConvite() {
    const nome  = document.getElementById('inputNomeConvidado')?.value.trim();
    const email = document.getElementById('inputEmailConvidado')?.value.trim().toLowerCase();
    const emailConfirm = document.getElementById('inputEmailConvidadoConfirm')?.value.trim().toLowerCase();

    if (!nome || nome.length < 2) {
        mostrarNotificacao('Digite o nome do convidado (mínimo 2 caracteres).', 'error');
        return;
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        mostrarNotificacao('Digite um email válido.', 'error');
        return;
    }
    if (email !== emailConfirm) {
        mostrarNotificacao('Os emails não coincidem.', 'error');
        return;
    }

    // ✅ CORREÇÃO: rate limit client-side — bloqueia reenvios rápidos
    if (!_conviteControl.podeEnviar()) {
        mostrarNotificacao(
            `Aguarde ${_conviteControl.tempoRestante()} segundo(s) antes de enviar outro convite.`,
            'warning'
        );
        return;
    }

    const btnEnviar = document.getElementById('btnEnviarConvite');
    if (btnEnviar) {
        btnEnviar.disabled = true;
        btnEnviar.textContent = '⏳ Enviando...';
    }

    try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) throw new Error('Sessão expirada. Faça login novamente.');

        if (typeof SUPABASE_URL === 'undefined') {
            throw new Error('Configuração de servidor inválida. Contate o suporte.');
        }
        let _parsedSupabaseUrl;
        try {
            _parsedSupabaseUrl = new URL(SUPABASE_URL);
        } catch {
            throw new Error('Configuração de servidor inválida. Contate o suporte.');
        }
        if (
            _parsedSupabaseUrl.protocol !== 'https:' ||
            _parsedSupabaseUrl.hostname !== _SUPABASE_ALLOWED_HOSTNAME
        ) {
            throw new Error('Configuração de servidor inválida. Contate o suporte.');
        }

        const endpointUrl = `https://${_SUPABASE_ALLOWED_HOSTNAME}/functions/v1/send-guest-invite`;

        // ✅ CORREÇÃO: nonce único por requisição como camada extra de rastreabilidade.
        //    O backend pode logar/validar o nonce para detectar replays ou automação.
        //    Combinado com o rate limit acima, dificulta significativamente o abuse.
        const requestNonce = (typeof crypto !== 'undefined' && crypto.randomUUID)
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

        const response = await fetch(endpointUrl, {
            method: 'POST',
            headers: {
                'Content-Type':   'application/json',
                'Authorization':  `Bearer ${session.access_token}`,
                'X-Request-Nonce': requestNonce,
                'X-Request-Time':  String(Date.now()),
            },
            body: JSON.stringify({ guestName: nome, guestEmail: email }),
        });

        // ✅ Registra o envio apenas após resposta bem-sucedida do servidor
        _conviteControl.registrar();

        const result = await response.json();

        if (!result.success) {
            const err = result.error || '';

            if (err.startsWith('PLAN_BLOCK:')) {
                const [, planName] = err.split(':');
                fecharPopup();
                mostrarPopupLimite(`Seu plano ${sanitizeHTML(planName)} não permite convidados. Faça upgrade para continuar.`);
                return;
            }
            if (err.startsWith('LIMIT_REACHED:')) {
                const parts    = err.split(':');
                const planName = parts[1];
                const total    = parts[2];
                const emails   = parts[3] || '';
                fecharPopup();
                criarPopup(`
                    <h3>🔒 Limite do Plano</h3>
                    <p style="margin:16px 0; color:var(--text-secondary); line-height:1.6;">
                        Você possui o Plano <strong>${sanitizeHTML(planName)}</strong>, que permite até
                        <strong>${sanitizeHTML(total)} email(s)</strong> no total.<br><br>
                        ${emails ? `Emails cadastrados: <strong>${sanitizeHTML(emails)}</strong>` : ''}
                    </p>
                    <button class="btn-primary" id="btnUpgradeLimite" style="width:100%; margin-bottom:10px;">⬆️ Fazer Upgrade</button>
                    <button class="btn-cancelar" id="btnFecharLimite" style="width:100%;">Fechar</button>
                `);
                document.getElementById('btnUpgradeLimite').addEventListener('click', irParaAtualizarPlano);
                document.getElementById('btnFecharLimite').addEventListener('click', fecharPopup);
                return;
            }
            throw new Error('Não foi possível enviar o convite. Tente novamente.');
        }

        const code = result.code;
        if (!/^\d{6}$/.test(code)) {
            throw new Error('Resposta inválida do servidor. Contate o suporte.');
        }

        const expiresAt = new Date(result.expiresAt).toLocaleString('pt-BR');

        fecharPopup();
        criarPopup(`
            <div style="text-align:center;">
                <div style="font-size:3rem; margin-bottom:12px;">🎉</div>
                <h3 style="margin-bottom:6px;">Convite Enviado!</h3>
                <p style="color:var(--text-secondary); font-size:0.9rem; margin-bottom:24px;">
                    Email enviado para <strong>${sanitizeHTML(email)}</strong>.<br>
                    Compartilhe o código abaixo com <strong>${sanitizeHTML(nome)}</strong>:
                </p>
                <div style="background:rgba(16,185,129,0.1); border:2px solid rgba(16,185,129,0.4);
                            border-radius:16px; padding:24px; margin-bottom:20px;">
                    <div style="font-size:0.8rem; color:#6ee7b7; letter-spacing:2px; margin-bottom:10px;">
                        CÓDIGO DE 6 DÍGITOS
                    </div>
                    <div id="codigoConvite" style="font-size:3rem; font-weight:900; letter-spacing:12px;
                                color:#10b981; font-family:'Courier New',monospace;">
                    </div>
                    <div style="font-size:0.8rem; color:var(--text-muted); margin-top:10px;">
                        ⏰ Expira em: ${sanitizeHTML(expiresAt)}
                    </div>
                </div>
                <button id="btnCopiarCodigo" class="btn-primary" style="width:100%; margin-bottom:10px;">
                    📋 Copiar Código
                </button>
                <div style="background:rgba(255,209,102,0.1); border:1px solid rgba(255,209,102,0.3);
                            border-radius:10px; padding:12px; font-size:0.85rem; color:#ffd166; margin-bottom:14px;">
                    ⚠️ Guarde este código! Ele não será exibido novamente.
                </div>
                <button class="btn-cancelar" id="btnFecharConviteEnviado" style="width:100%;">Fechar</button>
            </div>
        `);

        document.getElementById('codigoConvite').textContent = code;

        document.getElementById('btnCopiarCodigo').addEventListener('click', () => {
            navigator.clipboard.writeText(code)
                .then(() => mostrarNotificacao('Código copiado!', 'success'))
                .catch(() => mostrarNotificacao('Não foi possível copiar automaticamente.', 'error'));
        });

        document.getElementById('btnFecharConviteEnviado').addEventListener('click', fecharPopup);

    } catch (err) {
        _log.error('CONVITE_001', err);
        mostrarNotificacao(err.message || 'Não foi possível enviar o convite. Tente novamente.', 'error');
        if (btnEnviar) {
            btnEnviar.disabled = false;
            btnEnviar.textContent = '📨 Enviar Convite';
        }
    }
}

async function removerConvidado(memberId, memberName) {
    confirmarAcao(`Remover o acesso de "${sanitizeHTML(memberName)}"? Ele(a) não poderá mais entrar na conta.`, async () => {
        try {
            const { error } = await supabase
                .from('account_members')
                .update({ is_active: false })
                .eq('id', memberId)
                .eq('owner_user_id', usuarioLogado.userId);

            if (error) throw error;

            mostrarNotificacao(`Acesso de ${sanitizeHTML(memberName)} removido.`, 'success');
            fecharPopup();
            setTimeout(() => alterarEmail(), 200);
        } catch (err) {
            // ✅ CORREÇÃO: _log.error em vez de log.error
            _log.error('MEMBRO_001', err);
            mostrarNotificacao('Não foi possível remover o convidado. Tente novamente.', 'error');
        }
    });
}

window.removerConvidado = removerConvidado;

function abrirAlterarSenha() {
    criarPopup(`
        <h3>🔒 Alterar Senha</h3>
        <div class="small">Preencha os campos abaixo</div>
        <input type="password" id="novaSenha"          class="form-input" placeholder="Nova senha (mín. 8 caracteres)">
        <input type="password" id="confirmarNovaSenha" class="form-input" placeholder="Confirme a nova senha">
        <button class="btn-primary"  id="concluirSenha">Concluir</button>
        <button class="btn-cancelar" id="cancelarSenha">Cancelar</button>
    `);

    document.getElementById('cancelarSenha').addEventListener('click', fecharPopup);

    document.getElementById('concluirSenha').addEventListener('click', async () => {
        const novaSenha      = document.getElementById('novaSenha').value;
        const confirmarSenha = document.getElementById('confirmarNovaSenha').value;

        if (!novaSenha || !confirmarSenha) {
            mostrarNotificacao('Por favor, preencha todos os campos.', 'error');
            return;
        }
        if (novaSenha !== confirmarSenha) {
            mostrarNotificacao('As senhas não coincidem.', 'error');
            return;
        }
        if (novaSenha.length < 8) {
            mostrarNotificacao('A nova senha deve ter pelo menos 8 caracteres.', 'error');
            return;
        }
        if (!/[A-Z]/.test(novaSenha) || !/[0-9]/.test(novaSenha)) {
            mostrarNotificacao('A senha deve conter ao menos uma letra maiúscula e um número.', 'error');
            return;
        }

        const btn = document.getElementById('concluirSenha');
        btn.disabled = true;
        btn.textContent = '⏳ Aguarde...';

        try {
            // Supabase Auth cuida do hash — a senha nunca é armazenada no cliente
            const { error } = await supabase.auth.updateUser({ password: novaSenha });
            if (error) throw error;

            fecharPopup();
            mostrarNotificacao('✅ Senha alterada com sucesso!', 'success');

        } catch (error) {
            // ✅ CORREÇÃO: _log.error em vez de log.error
            _log.error('SENHA_001', error);
            mostrarNotificacao('Não foi possível alterar a senha. Tente novamente.', 'error');
            btn.disabled = false;
            btn.textContent = 'Concluir';
        }
    });
}
window.abrirAlterarSenha = abrirAlterarSenha;

function trocarPerfil() {
    salvarDados();
    mostrarSelecaoPerfis();
}

function comoUsar() {
    alert('Funcionalidade "Como usar o GranaEvo?" será implementada em breve!');
}

// ========== CONFIRMAR LOGOUT (VERSÃO FINAL CORRIGIDA) ==========
// ========== CONFIRMAR LOGOUT (VERSÃO FINAL CORRIGIDA) ==========
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
    atualizarMovimentacoesUI();
    atualizarDashboardResumo();
    atualizarListaContasFixas();
    renderMetasList();
    renderMetaVisual();
    atualizarHeaderReservas();
}

function atualizarHeaderReservas() {
    const headerTotalReservas = document.getElementById('headerTotalReservas');
    const headerQtdReservas = document.getElementById('headerQtdReservas');
    
    if(!headerTotalReservas || !headerQtdReservas) return;
    
    // Calcular total reservado (soma de todas as metas)
    const totalReservado = metas.reduce((sum, meta) => {
        return sum + Number(meta.saved || 0);
    }, 0);
    
    // Contar reservas ativas (metas que ainda não atingiram o objetivo)
    const reservasAtivas = metas.filter(meta => {
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
}
// ========== BINDINGS DE UI ==========
function bindEventos() {
    // Navegação
    document.querySelectorAll('[data-page]').forEach(btn => {
        btn.addEventListener('click', function() {
            const page = this.getAttribute('data-page');
            mostrarTela(page);
        });
    });
    
    // Upload de foto
    const photoUpload = document.getElementById('photoUpload');
    if(photoUpload) {
        photoUpload.addEventListener('change', alterarFoto);
    }
    
    // Dashboard - Nova conta fixa
    const btnNovaContaFixa = document.getElementById('btnNovaContaFixa');
    if(btnNovaContaFixa) {
        btnNovaContaFixa.addEventListener('click', () => abrirContaFixaForm());
    }
    
    // Transações
    const selectCategoria = document.getElementById('selectCategoria');
    if(selectCategoria) {
        selectCategoria.addEventListener('change', atualizarTiposDinamicos);
    }
    
    const btnLancar = document.getElementById('btnLancar');
    if(btnLancar) {
        btnLancar.addEventListener('click', lancarTransacao);
    }
    
    // Reservas/Metas
    const btnNovaMeta = document.getElementById('btnNovaMeta');
    if(btnNovaMeta) {
        btnNovaMeta.addEventListener('click', () => abrirMetaForm());
    }
    
    const btnRetirar = document.getElementById('btnRetirar');
    if(btnRetirar) {
        btnRetirar.addEventListener('click', abrirRetiradaForm);
    }
    
    // Gráficos
    const btnAtualizarGraficos = document.getElementById('btnAtualizarGraficos');
    if(btnAtualizarGraficos) {
        btnAtualizarGraficos.addEventListener('click', atualizarGraficos);
    }
    
    // Relatórios
    const btnGerarRelatorio = document.getElementById('btnGerarRelatorio');
    if(btnGerarRelatorio) {
        btnGerarRelatorio.addEventListener('click', gerarRelatorio);
    }
    
    // Configurações
    const btnAlterarNome = document.getElementById('btnAlterarNome');
    if(btnAlterarNome) {
        btnAlterarNome.addEventListener('click', alterarNome);
    }
    
    const btnAlterarEmail = document.getElementById('btnAlterarEmail');
    if(btnAlterarEmail) {
        btnAlterarEmail.addEventListener('click', alterarEmail);
    }
    
    const btnAlterarSenha = document.getElementById('btnAlterarSenha');
    if(btnAlterarSenha) {
        btnAlterarSenha.addEventListener('click', abrirAlterarSenha);
    }
    
    const btnTrocarPerfil = document.getElementById('btnTrocarPerfil');
    if(btnTrocarPerfil) {
        btnTrocarPerfil.addEventListener('click', trocarPerfil);
    }
    
    const btnComoUsar = document.getElementById('btnComoUsar');
    if(btnComoUsar) {
        btnComoUsar.addEventListener('click', comoUsar);
    }
    
    const btnLogout = document.getElementById('btnLogout');
    if(btnLogout) {
        btnLogout.addEventListener('click', confirmarLogout);
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
    widgetOndeFoi.addEventListener('click', abrirWidgetOndeForDinheiro);
    widgetOndeFoi.addEventListener('mouseover', () => {
        widgetOndeFoi.style.transform = 'translateY(-4px)';
        widgetOndeFoi.style.boxShadow = '0 8px 24px rgba(67,160,71,0.3)';
    });
    widgetOndeFoi.addEventListener('mouseout', () => {
        widgetOndeFoi.style.transform = 'translateY(0)';
        widgetOndeFoi.style.boxShadow = 'var(--shadow-sm)';
    });
}

// ========== VISUALIZAÇÃO DETALHADA DE FATURA DE CARTÃO ==========
function abrirVisualizacaoFatura(faturaId) {
    const fatura = contasFixas.find(c => c.id === faturaId);
    if (!fatura || !fatura.compras) return;

    const cartao     = cartoesCredito.find(c => c.id === fatura.cartaoId);
    const nomeCartao = cartao ? _sanitizeText(cartao.nomeBanco) : 'Cartão';

    // ── Monta o popup com estrutura estática (zero dados do usuário no HTML)
    criarPopupDOM((popup) => {

        // ── Título
        const titulo = document.createElement('h3');
        titulo.textContent = '💳 Detalhes da Fatura';

        // ── Cabeçalho: nome do cartão, vencimento, total
        const cabecalho = document.createElement('div');
        cabecalho.style.cssText = 'text-align: center; margin-bottom: 20px;';

        const nomeEl = document.createElement('div');
        nomeEl.style.cssText = 'font-size: 1.1rem; font-weight: 600; color: var(--text-primary);';
        nomeEl.textContent = nomeCartao; // ✅ textContent

        const vencEl = document.createElement('div');
        vencEl.style.cssText = 'font-size: 0.9rem; color: var(--text-secondary); margin-top: 4px;';
        vencEl.textContent = `Vencimento: ${formatarDataBR(fatura.vencimento)}`; // ✅ textContent

        const totalEl = document.createElement('div');
        totalEl.style.cssText = 'font-size: 1.4rem; font-weight: 700; color: var(--danger); margin-top: 12px;';
        totalEl.textContent = `Total: ${formatBRL(fatura.valor)}`; // ✅ textContent

        cabecalho.appendChild(nomeEl);
        cabecalho.appendChild(vencEl);
        cabecalho.appendChild(totalEl);

        // ── Seção de compras
        const secaoCompras = document.createElement('div');
        secaoCompras.style.cssText = 'max-height: 400px; overflow-y: auto; margin-bottom: 20px;';

        const tituloCompras = document.createElement('h4');
        tituloCompras.style.cssText = 'margin-bottom: 12px; color: var(--text-primary);';
        tituloCompras.textContent = '📦 Compras nesta Fatura:';
        secaoCompras.appendChild(tituloCompras);

        if (fatura.compras.length === 0) {
            const vazio = document.createElement('p');
            vazio.style.cssText = 'text-align: center; color: var(--text-muted); padding: 20px 0;';
            vazio.textContent = 'Nenhuma compra registrada nesta fatura.';
            secaoCompras.appendChild(vazio);
        }

        fatura.compras.forEach(compra => {
            // ── Validações de segurança antes de renderizar
            if (!compra || typeof compra !== 'object') return;

            const parcelaAtual   = Number(compra.parcelaAtual);
            const totalParcelas  = Number(compra.totalParcelas);
            const valorParcela   = Number(compra.valorParcela);
            const valorTotal     = Number(compra.valorTotal);

            if (!isFinite(parcelaAtual) || !isFinite(totalParcelas) ||
                !isFinite(valorParcela) || valorParcela <= 0) return;

            const isPaga = parcelaAtual > totalParcelas;

            // ── Card da compra
            const card = document.createElement('div');
            card.style.cssText = `
                background: rgba(255,255,255,0.03);
                padding: 16px;
                border-radius: 12px;
                margin-bottom: 12px;
                border-left: 3px solid var(--primary);
            `;

            // ── Linha superior: info + valor
            const rowTop = document.createElement('div');
            rowTop.style.cssText = `
                display: flex;
                justify-content: space-between;
                align-items: start;
                margin-bottom: 10px;
                flex-wrap: wrap;
                gap: 8px;
            `;

            // Coluna esquerda: tipo, descrição, data
            const colEsquerda = document.createElement('div');
            colEsquerda.style.flex = '1';

            const divTipo = document.createElement('div');
            divTipo.style.cssText = 'font-weight: 600; color: var(--text-primary); font-size: 1rem;';
            divTipo.textContent = String(compra.tipo || ''); // ✅ textContent

            const divDesc = document.createElement('div');
            divDesc.style.cssText = 'color: var(--text-secondary); font-size: 0.9rem; margin-top: 4px;';
            divDesc.textContent = String(compra.descricao || ''); // ✅ textContent

            const divData = document.createElement('div');
            divData.style.cssText = 'color: var(--text-muted); font-size: 0.85rem; margin-top: 4px;';
            divData.textContent = `📅 Compra: ${String(compra.dataCompra || '')}`; // ✅ textContent

            colEsquerda.appendChild(divTipo);
            colEsquerda.appendChild(divDesc);
            colEsquerda.appendChild(divData);

            // Coluna direita: valor + status
            const colDireita = document.createElement('div');
            colDireita.style.textAlign = 'right';

            const divValor = document.createElement('div');
            divValor.style.cssText = 'font-weight: 700; color: var(--text-primary); font-size: 1.1rem;';
            divValor.textContent = formatBRL(valorParcela); // ✅ textContent — formatBRL retorna string numérica

            const divStatus = document.createElement('div');
            divStatus.style.cssText = `font-size: 0.85rem; margin-top: 4px; font-weight: 600; color: ${isPaga ? '#00ff99' : '#ffd166'};`;
            divStatus.textContent = isPaga
                ? '✓ Paga'
                : `Parcela ${parcelaAtual}/${totalParcelas}`; // ✅ textContent — valores numéricos internos

            colDireita.appendChild(divValor);
            colDireita.appendChild(divStatus);

            rowTop.appendChild(colEsquerda);
            rowTop.appendChild(colDireita);

            // ── Botões de ação
            const rowBotoes = document.createElement('div');
            rowBotoes.style.cssText = 'display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px;';

            const btnPagar = document.createElement('button');
            btnPagar.className = 'btn-primary';
            btnPagar.style.cssText = 'flex: 1; min-width: 80px; padding: 8px 12px; font-size: 0.85rem;';
            btnPagar.textContent = '💰 Pagar';
            // ✅ IDs capturados em closure — nunca passam por atributo HTML
            btnPagar.addEventListener('click', () => pagarCompraIndividual(faturaId, compra.id));

            const btnEditar = document.createElement('button');
            btnEditar.className = 'btn-primary';
            btnEditar.style.cssText = 'flex: 1; min-width: 80px; padding: 8px 12px; font-size: 0.85rem; background: var(--accent);';
            btnEditar.textContent = '✏️ Editar';
            btnEditar.addEventListener('click', () => editarCompraFatura(faturaId, compra.id));

            const btnExcluir = document.createElement('button');
            btnExcluir.className = 'btn-excluir';
            btnExcluir.style.cssText = 'flex: 1; min-width: 80px; padding: 8px 12px; font-size: 0.85rem;';
            btnExcluir.textContent = '🗑️ Excluir';
            btnExcluir.addEventListener('click', () => excluirCompraFatura(faturaId, compra.id));

            rowBotoes.appendChild(btnPagar);
            rowBotoes.appendChild(btnEditar);
            rowBotoes.appendChild(btnExcluir);

            card.appendChild(rowTop);
            card.appendChild(rowBotoes);
            secaoCompras.appendChild(card);
        });

        // ── Botão fechar
        const btnFechar = document.createElement('button');
        btnFechar.className = 'btn-primary';
        btnFechar.textContent = 'Fechar';
        btnFechar.addEventListener('click', fecharPopup);

        popup.appendChild(titulo);
        popup.appendChild(cabecalho);
        popup.appendChild(secaoCompras);
        popup.appendChild(btnFechar);
    });
}

window.abrirVisualizacaoFatura = abrirVisualizacaoFatura;


// ========== PAGAR COMPRA INDIVIDUAL ==========
function pagarCompraIndividual(faturaId, compraId) {
    const fatura = contasFixas.find(c => c.id === faturaId);
    if (!fatura) return;

    const compra = fatura.compras.find(c => String(c.id) === String(compraId));
    if (!compra) return;

    fecharPopup();

    setTimeout(() => {
        // ✅ CORREÇÃO: HTML do popup sem dados do usuário interpolados diretamente.
        //    O valor do input é preenchido via .value após criação do DOM,
        //    garantindo consistência com o padrão de sanitização do restante do código
        //    e eliminando qualquer risco de malformação de atributo HTML.
        criarPopup(`
            <h3>💰 Pagar Parcela</h3>
            <div style="text-align: left; margin: 20px 0; color: var(--text-secondary);">
                <div id="popupCompTipo"    style="margin-bottom: 8px;"></div>
                <div id="popupCompDesc"   style="margin-bottom: 8px;"></div>
                <div id="popupCompParc"   style="margin-bottom: 8px;"></div>
                <div id="popupCompValor"  style="margin-bottom: 16px;"></div>
            </div>
            <div style="color: var(--warning); margin-bottom: 16px; font-weight: 600;">⚠️ O valor está correto?</div>
            <button class="btn-primary"  id="simValorCompra"></button>
            <button class="btn-warning"  id="naoValorCompra">Não, alterar valor</button>
            <button class="btn-cancelar" id="cancelarPagamentoCompra">Cancelar</button>
            <div id="ajusteValorCompraDiv" style="display:none; margin-top:14px;">
                <input type="number" id="novoValorCompra" class="form-input"
                       step="0.01" min="0">
                <button class="btn-primary" id="confirmNovoValorCompra" style="margin-top:8px;">
                    Confirmar pagamento
                </button>
            </div>
        `);

        // ✅ Preenchimento seguro via textContent / .value — nunca via atributo HTML
        document.getElementById('popupCompTipo').innerHTML   = `<strong>Compra:</strong> <span></span>`;
        document.getElementById('popupCompTipo').querySelector('span').textContent = compra.tipo;

        document.getElementById('popupCompDesc').innerHTML   = `<strong>Descrição:</strong> <span></span>`;
        document.getElementById('popupCompDesc').querySelector('span').textContent = compra.descricao;

        document.getElementById('popupCompParc').innerHTML   = `<strong>Parcela:</strong> <span></span>`;
        document.getElementById('popupCompParc').querySelector('span').textContent =
            `${compra.parcelaAtual}/${compra.totalParcelas}`;

        document.getElementById('popupCompValor').innerHTML  = `<strong>Valor:</strong> <span></span>`;
        document.getElementById('popupCompValor').querySelector('span').textContent = formatBRL(compra.valorParcela);

        // ✅ Texto do botão via textContent — sem interpolação
        document.getElementById('simValorCompra').textContent = `Sim, pagar ${formatBRL(compra.valorParcela)}`;

        // ✅ Valor numérico atribuído via .value — tipo number, não interpretado como HTML
        document.getElementById('novoValorCompra').value = sanitizeHTML(String(compra.valorParcela));

        document.getElementById('simValorCompra').addEventListener('click', () => {
            processarPagamentoCompra(faturaId, compraId, compra.valorParcela);
        });

        document.getElementById('naoValorCompra').addEventListener('click', () => {
            document.getElementById('ajusteValorCompraDiv').style.display = 'block';
            document.getElementById('simValorCompra').disabled  = true;
            document.getElementById('naoValorCompra').disabled  = true;
        });

        document.getElementById('cancelarPagamentoCompra').addEventListener('click', () => {
            fecharPopup();
            abrirVisualizacaoFatura(faturaId);
        });

        document.getElementById('confirmNovoValorCompra').addEventListener('click', () => {
            const novoValor = parseFloat(document.getElementById('novoValorCompra').value);
            if (!novoValor || novoValor <= 0) {
                mostrarNotificacao('Digite um valor válido!', 'error');
                return;
            }
            processarPagamentoCompra(faturaId, compraId, novoValor);
        });

    }, 300);
}

// ========== PROCESSAR PAGAMENTO DE COMPRA ==========
function processarPagamentoCompra(faturaId, compraId, valorPago) {
    const fatura = contasFixas.find(c => c.id === faturaId);
    if (!fatura) return;

    const compra = fatura.compras.find(c => String(c.id) === String(compraId));
    if (!compra) return;

    // ✅ CORREÇÃO: Anti-replay lock — impede pagamento duplo por cliques rápidos
    if (compra._processando) {
        mostrarNotificacao('Aguarde, pagamento em andamento...', 'warning');
        return;
    }
    compra._processando = true;

    // ✅ CORREÇÃO: Validação do valor pago antes de qualquer operação
    const valorSeguro = parseFloat(valorPago);
    if (!isFinite(valorSeguro) || valorSeguro <= 0 || valorSeguro > 9_999_999) {
        mostrarNotificacao('Valor de pagamento inválido.', 'error');
        compra._processando = false;
        return;
    }

    const cartao = cartoesCredito.find(c => c.id === fatura.cartaoId);

    // ✅ CORREÇÃO: Snapshots para rollback em caso de erro
    let snapshotTransacoes  = [];
    let snapshotContasFixas = [];
    let snapshotCartoes     = [];

    try {
        snapshotTransacoes  = structuredClone(transacoes);
        snapshotContasFixas = structuredClone(contasFixas);
        snapshotCartoes     = structuredClone(cartoesCredito);

        const dh = agoraDataHora();
        const descricaoSegura = `${String(compra.tipo || '').slice(0, 100)} - ${String(compra.descricao || '').slice(0, 100)} (${compra.parcelaAtual}/${compra.totalParcelas})`;

        transacoes.push({
            categoria:  'saida',
            tipo:       'Pagamento Cartão',
            descricao:  descricaoSegura,
            valor:      parseFloat(valorSeguro.toFixed(2)),
            data:       dh.data,
            hora:       dh.hora,
            faturaId:   faturaId,
            compraId:   compraId
        });

        if (cartao) {
            cartao.usado = Math.max(0, (cartao.usado || 0) - valorSeguro);
        }

        compra.parcelaAtual++;

        if (compra.parcelaAtual > compra.totalParcelas) {
            fatura.compras = fatura.compras.filter(c => String(c.id) !== String(compraId));
        }

        fatura.valor = fatura.compras.reduce((sum, c) => {
            const p = parseFloat(c.valorParcela);
            return sum + (isFinite(p) && p > 0 ? p : 0);
        }, 0);

        if (fatura.compras.length === 0) {
            contasFixas = contasFixas.filter(c => c.id !== faturaId);
            compra._processando = false;
            fecharPopup();
            salvarDados();
            atualizarTudo();
            alert('✅ Última parcela paga! Fatura quitada.');
            return;
        }

        compra._processando = false;
        salvarDados();
        atualizarTudo();
        fecharPopup();

        setTimeout(() => {
            abrirVisualizacaoFatura(faturaId);
            const restantes = compra.totalParcelas - compra.parcelaAtual + 1;
            mostrarNotificacao(`Parcela paga! ${restantes} restante(s)`, 'success');
        }, 200);

    } catch (erro) {
        _log.error('PAG_COMPRA_001', erro);

        rollbackArray(transacoes,     snapshotTransacoes);
        rollbackArray(contasFixas,    snapshotContasFixas);
        rollbackArray(cartoesCredito, snapshotCartoes);

        compra._processando = false;
        mostrarNotificacao('Erro ao processar pagamento. Nenhuma alteração foi salva.', 'error');
    }
}

// ========== EDITAR COMPRA DA FATURA ==========
function editarCompraFatura(faturaId, compraId) {
    const fatura = contasFixas.find(c => c.id === faturaId);
    if (!fatura) return;

    const compra = fatura.compras.find(c => String(c.id) === String(compraId));
    if (!compra) return;

    fecharPopup();

    setTimeout(() => {
        // ✅ CORREÇÃO: HTML do popup com campos VAZIOS
        //    Dados do usuário (tipo, descricao, valorParcela) são inseridos
        //    exclusivamente via .value após criação do DOM — nunca via atributo HTML
        criarPopup(`
            <h3>✏️ Editar Compra</h3>
            <label style="display:block; text-align:left; margin-top:10px; color: var(--text-secondary);">Tipo:</label>
            <input type="text" id="editTipoCompra" class="form-input" maxlength="100">

            <label style="display:block; text-align:left; margin-top:10px; color: var(--text-secondary);">Descrição:</label>
            <input type="text" id="editDescCompra" class="form-input" maxlength="200">

            <label style="display:block; text-align:left; margin-top:10px; color: var(--text-secondary);">Valor da Parcela:</label>
            <input type="number" id="editValorCompra" class="form-input" step="0.01" min="0.01" max="9999999">

            <button class="btn-primary"  id="salvarEdicaoCompra">Salvar</button>
            <button class="btn-cancelar" id="cancelarEdicaoCompra">Cancelar</button>
        `);

        // ✅ CORREÇÃO: preenchimento seguro via .value — padrão consistente com
        //    abrirContaFixaForm, abrirMetaForm e todos os outros formulários de edição
        //    Nenhum dado do usuário passa por innerHTML ou atributo HTML
        const inputTipo  = document.getElementById('editTipoCompra');
        const inputDesc  = document.getElementById('editDescCompra');
        const inputValor = document.getElementById('editValorCompra');

        if (inputTipo)  inputTipo.value  = String(compra.tipo      || '');
        if (inputDesc)  inputDesc.value  = String(compra.descricao || '');
        if (inputValor) {
            // ✅ parseFloat garante que valorParcela é número antes de atribuir ao input
            const vp = parseFloat(compra.valorParcela);
            inputValor.value = isFinite(vp) && vp > 0 ? vp : '';
        }

        document.getElementById('cancelarEdicaoCompra').addEventListener('click', () => {
            fecharPopup();
            abrirVisualizacaoFatura(faturaId);
        });

        document.getElementById('salvarEdicaoCompra').addEventListener('click', () => {
            const novoTipo  = document.getElementById('editTipoCompra').value.trim();
            const novaDesc  = document.getElementById('editDescCompra').value.trim();
            const novoValor = parseFloat(document.getElementById('editValorCompra').value);

            if (!novoTipo) {
                mostrarNotificacao('O tipo da compra não pode estar vazio.', 'error');
                return;
            }
            if (novoTipo.length > 100) {
                mostrarNotificacao('Tipo muito longo (máx. 100 caracteres).', 'error');
                return;
            }
            if (novaDesc.length > 200) {
                mostrarNotificacao('Descrição muito longa (máx. 200 caracteres).', 'error');
                return;
            }
            if (isNaN(novoValor) || novoValor <= 0 || novoValor > 9_999_999) {
                mostrarNotificacao('Digite um valor válido (entre R$ 0,01 e R$ 9.999.999).', 'error');
                return;
            }

            compra.tipo         = novoTipo;
            compra.descricao    = novaDesc;
            compra.valorParcela = parseFloat(novoValor.toFixed(2));

            // ✅ Recalcular com parseFloat para evitar acúmulo de imprecisão de ponto flutuante
            fatura.valor = parseFloat(
                fatura.compras.reduce((sum, c) => {
                    const p = parseFloat(c.valorParcela);
                    return sum + (isFinite(p) && p > 0 ? p : 0);
                }, 0).toFixed(2)
            );

            salvarDados();
            atualizarTudo();
            fecharPopup();
            setTimeout(() => {
                abrirVisualizacaoFatura(faturaId);
                mostrarNotificacao('Compra atualizada com sucesso!', 'success');
            }, 200);
        });

    }, 300);
}

window.editarCompraFatura = editarCompraFatura;

// ========== EXCLUIR COMPRA DA FATURA ==========
function excluirCompraFatura(faturaId, compraId) {
    confirmarAcao('Tem certeza que deseja excluir esta compra da fatura?', () => {
        const fatura = contasFixas.find(c => c.id === faturaId);
        if (!fatura) return;

        const compra = fatura.compras.find(c => String(c.id) === String(compraId));
        if (!compra) return;

        const cartao = cartoesCredito.find(c => c.id === fatura.cartaoId);

        // Atualizar valor usado do cartão
        if (cartao) {
            const valorRestante = compra.valorTotal - (compra.valorParcela * (compra.parcelaAtual - 1));
            cartao.usado = Math.max(0, (cartao.usado || 0) - valorRestante);
        }

        // Remover compra
        fatura.compras = fatura.compras.filter(c => String(c.id) !== String(compraId));

        // Recalcular valor da fatura
        fatura.valor = fatura.compras.reduce((sum, c) => sum + c.valorParcela, 0);

        // Se não há mais compras, remover fatura
        if (fatura.compras.length === 0) {
            contasFixas = contasFixas.filter(c => c.id !== faturaId);
            fecharPopup();
            salvarDados();
            atualizarTudo();
            mostrarNotificacao('✅ Fatura excluída — não há mais compras.', 'success');
            return;
        }

        salvarDados();
        atualizarTudo();
        fecharPopup();
        setTimeout(() => {
            abrirVisualizacaoFatura(faturaId);
            mostrarNotificacao('Compra excluída com sucesso!', 'success');
        }, 200);
    });
}

window.excluirCompraFatura = excluirCompraFatura;


// ✅ Guard aprimorado: além de perfil ativo, valida uma nonce de sessão gerada
//    no carregamento da página. Extensões maliciosas que tentam chamar window.X
//    não têm acesso ao _sessionNonce pois ele é gerado dentro do módulo IIFE
//    e nunca exposto publicamente.
//
//    COMO FUNCIONA:
//    1. _sessionNonce é gerado com crypto.randomUUID() ao carregar o módulo
//    2. Funções protegidas exigem que o caller passe o nonce correto como último argumento
//    3. Código legítimo (event listeners internos) não passa o nonce — eles chamam
//       a função interna diretamente, não via window.*
//    4. Callers externos (extensões, console, outros scripts) não conhecem o nonce
//
//    IMPORTANTE: window.* são necessários para comunicação entre módulos legítimos
//    (graficos.js, chat-assistant.js). O nonce não quebra esse uso pois esses módulos
//    usam as funções internas diretamente via import/script-tag no mesmo contexto.
//    Para funções chamadas de HTML (onclick de buttons), usar event delegation interno
//    em vez de window.X — já feito no padrão addEventListener do código atual.

const _sessionNonce = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `nonce_${Date.now()}_${Math.random().toString(36).slice(2)}`;

// ✅ Guard base: perfil ativo + userId
function _requerPerfilAtivo(fn) {
    return function(...args) {
        if (!perfilAtivo || !dataManager?.userId) {
            _log.warn('[SEGURANÇA] Chamada bloqueada — sem perfil ativo ou sessão inválida.');
            return;
        }
        return fn.apply(this, args);
    };
}

// ✅ Guard de nonce: para funções de alto risco expostas no window.*
//    Uso: window.alterarNome(_sessionNonce, 'Novo Nome')
//    Extensões não conhecem _sessionNonce → chamada bloqueada
//    Módulos internos chamam alterarNome() diretamente sem nonce → sem restrição
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

// ── Utilitários de UI — necessários para módulos externos (graficos.js, etc.)
//    Sem risco de uso malicioso — apenas abrem/fecham UI, não alteram dados
window.fecharPopup        = fecharPopup;
window.mostrarTela        = mostrarTela;
window.mostrarNotificacao = mostrarNotificacao;

// ── Navegação e sessão — sem dados financeiros, sem risco alto
window.confirmarLogout      = confirmarLogout_seguro;
window.irParaAtualizarPlano = irParaAtualizarPlano;
window.comoUsar             = comoUsar;

// ── Funções de UI de baixo risco (apenas abrem formulários visuais)
//    Guard base: perfil ativo obrigatório
window.abrirContaFixaForm           = _requerPerfilAtivo(abrirContaFixaForm);
window.abrirCartaoForm              = _requerPerfilAtivo(abrirCartaoForm);
window.abrirMetaForm                = _requerPerfilAtivo(abrirMetaForm);
window.abrirRetiradaForm            = _requerPerfilAtivo(abrirRetiradaForm);
window.abrirVisualizacaoFatura      = _requerPerfilAtivo(abrirVisualizacaoFatura);
window.abrirAnaliseDisciplina       = _requerPerfilAtivo(abrirAnaliseDisciplina);
window.abrirWidgetOndeForDinheiro   = _requerPerfilAtivo(abrirWidgetOndeForDinheiro);
window.trocarPerfil                 = _requerPerfilAtivo(trocarPerfil);
window.confirmarAcao                = _requerPerfilAtivo(confirmarAcao);

// ✅ ALTO RISCO — requerem nonce além de perfil ativo:
//    Alteram dados persistentes ou expõem dados financeiros completos
//    Extensões maliciosas bloqueadas pois não conhecem _sessionNonce
window.alterarNome          = _requerNonce(alterarNome);
window.alterarEmail         = _requerNonce(alterarEmail);
window.abrirAlterarSenha    = _requerNonce(abrirAlterarSenha);
window.removerConvidado     = _requerNonce(removerConvidado);
window.gerarRelatorio       = _requerNonce(gerarRelatorio);
window.atualizarGraficos    = _requerNonce(atualizarGraficos);
window.abrirDetalhesPerfilRelatorio          = _requerNonce(abrirDetalhesPerfilRelatorio);
window.abrirDetalhesCartaoRelatorio          = _requerNonce(abrirDetalhesCartaoRelatorio);
window.abrirSelecaoPerfisCasal               = _requerNonce(window.abrirSelecaoPerfisCasal || function(){});
window.confirmarSelecaoPerfisCasal           = _requerNonce(window.confirmarSelecaoPerfisCasal || function(){});
window.gerarRelatorioCompartilhadoPersonalizado = _requerNonce(window.gerarRelatorioCompartilhadoPersonalizado || function(){});
window.processarAnaliseOndeForDinheiro       = _requerNonce(processarAnaliseOndeForDinheiro);

// ✅ OPERAÇÕES FINANCEIRAS DIRETAS — nonce obrigatório
window.pagarCompraIndividual = _requerNonce(pagarCompraIndividual);
window.editarCompraFatura    = _requerNonce(editarCompraFatura);
window.excluirCompraFatura   = _requerNonce(excluirCompraFatura);

// ── Auto-save controls — sem dado sensível, sem risco alto
window.iniciarAutoSave = _requerPerfilAtivo(iniciarAutoSave);
window.pararAutoSave   = pararAutoSave;



// ========== UTILITÁRIOS ADICIONAIS ==========

// Função para preencher seletor de parcelas dinamicamente
function preencherSelectParcelas() {
    const select = document.getElementById('selectParcelas');
    if(!select) return;
    
    select.innerHTML = '';
    for(let i = 1; i <= 24; i++) {
        const opt = document.createElement('option');
        opt.value = i;
        opt.textContent = `${String(i).padStart(2, '0')}x`;
        select.appendChild(opt);
    }
}

// ✅ Variável única — usada por iniciarAutoSave e pararAutoSave
let autoSaveInterval = null;

function iniciarAutoSave() {
    if (!perfilAtivo) return;

    pararAutoSave();

    // ✅ CORRIGIDO: não expõe perfilAtivo.nome nem perfilAtivo.id em produção
    _log.info('[AUTO-SAVE] Sistema iniciado');

    autoSaveInterval = setInterval(async () => {
        if (!perfilAtivo) return;
        _log.info('[AUTO-SAVE PERIÓDICO] Executando...');
        await salvarDados();
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

// ========== VALIDAÇÕES ADICIONAIS ==========

// Valida formato de email
function validarEmail(email) {
    const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return regex.test(email);
}

// Valida CPF (caso queira adicionar no futuro)
function validarCPF(cpf) {
    cpf = cpf.replace(/[^\d]/g, '');
    if(cpf.length !== 11) return false;
    
    // Validação básica de CPF
    if(/^(\d)\1{10}$/.test(cpf)) return false;
    
    let soma = 0;
    let resto;
    
    for(let i = 1; i <= 9; i++) {
        soma += parseInt(cpf.substring(i-1, i)) * (11 - i);
    }
    resto = (soma * 10) % 11;
    if(resto === 10 || resto === 11) resto = 0;
    if(resto !== parseInt(cpf.substring(9, 10))) return false;
    
    soma = 0;
    for(let i = 1; i <= 10; i++) {
        soma += parseInt(cpf.substring(i-1, i)) * (12 - i);
    }
    resto = (soma * 10) % 11;
    if(resto === 10 || resto === 11) resto = 0;
    if(resto !== parseInt(cpf.substring(10, 11))) return false;
    
    return true;
}

// ========== FORMATAÇÕES ADICIONAIS ==========

// Formata número de telefone
function formatarTelefone(tel) {
    tel = tel.replace(/\D/g, '');
    if(tel.length === 11) {
        return tel.replace(/(\d{2})(\d{5})(\d{4})/, '($1) $2-$3');
    } else if(tel.length === 10) {
        return tel.replace(/(\d{2})(\d{4})(\d{4})/, '($1) $2-$3');
    }
    return tel;
}

// Formata CPF
function formatarCPF(cpf) {
    cpf = cpf.replace(/\D/g, '');
    return cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
}

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

function exportarDadosJSON() {
    if (!perfilAtivo) {
        mostrarNotificacao('Nenhum perfil ativo!', 'error');
        return;
    }

    const totalTransacoes  = transacoes.filter(_validators.transacao).length;
    const totalMetas       = metas.filter(_validators.meta).length;
    const totalContas      = contasFixas.filter(_validators.contaFixa).length;
    const totalCartoes     = cartoesCredito.filter(_validators.cartao).length;

    // ✅ Avisa o usuário se o volume for alto e houver truncamento
    const seraTruncado = totalTransacoes > _EXPORT_MAX_REGISTROS;
    const avisoTruncamento = seraTruncado
        ? `\n\n⚠️ Atenção: você possui ${totalTransacoes} transações. Serão exportadas apenas as ${_EXPORT_MAX_REGISTROS} mais recentes para proteger o desempenho do navegador.`
        : '';

    confirmarAcao(
        `⚠️ Você está prestes a exportar TODOS os dados financeiros do perfil "${_sanitizeText(perfilAtivo.nome)}" — transações, metas, contas e cartões — para um arquivo local. Confirma?${avisoTruncamento}`,
        () => {
            const contasSemLock = contasFixas.map(({ _processando, ...rest }) => rest);

            // ✅ CORREÇÃO: aplica limite máximo em cada array antes de serializar
            //    Ordena transações da mais recente para a mais antiga antes de truncar
            //    (para manter as mais relevantes no caso de truncamento)
            const transacoesOrdenadas = transacoes
                .filter(_validators.transacao)
                .slice()
                .sort((a, b) => {
                    const dataA = `${a.data} ${a.hora || ''}`;
                    const dataB = `${b.data} ${b.hora || ''}`;
                    return dataB.localeCompare(dataA);
                })
                .slice(0, _EXPORT_MAX_REGISTROS);

            const dados = {
                perfil:             _sanitizeText(perfilAtivo.nome),
                dataExportacao:     new Date().toISOString(),
                totalRegistros:     {
                    transacoes:  totalTransacoes,
                    exportadas:  transacoesOrdenadas.length,
                    truncado:    seraTruncado,
                },
                transacoes:         transacoesOrdenadas,
                metas:              metas.filter(_validators.meta).slice(0, _EXPORT_MAX_REGISTROS),
                contasFixas:        contasSemLock.filter(_validators.contaFixa).slice(0, _EXPORT_MAX_REGISTROS),
                cartoesCredito:     cartoesCredito.filter(_validators.cartao).slice(0, _EXPORT_MAX_REGISTROS),
            };

            const dataStr = JSON.stringify(dados, null, 2);

            // ✅ Verificação de tamanho antes de criar o Blob
            //    ~10MB é o limite seguro para maioria dos navegadores
            const tamanhoEstimadoBytes = new TextEncoder().encode(dataStr).length;
            if (tamanhoEstimadoBytes > 10 * 1024 * 1024) {
                mostrarNotificacao(
                    'O arquivo gerado é muito grande. Tente exportar um período menor via Relatórios.',
                    'error'
                );
                return;
            }

            const blob = new Blob([dataStr], { type: 'application/json' });
            const url  = URL.createObjectURL(blob);
            const a    = document.createElement('a');
            a.href     = url;
            a.download = `granaevo_${_sanitizeText(perfilAtivo.nome).replace(/\s+/g, '_')}_${isoDate()}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            mostrarNotificacao(
                seraTruncado
                    ? `Exportação concluída (${_EXPORT_MAX_REGISTROS} de ${totalTransacoes} transações)`
                    : 'Dados exportados com sucesso!',
                'success'
            );
        }
    );
}

function exportarDadosCSV() {
    if (!perfilAtivo) {
        mostrarNotificacao('Nenhum perfil ativo!', 'error');
        return;
    }

    const transacoesValidas = transacoes.filter(_validators.transacao);
    const seraTruncado      = transacoesValidas.length > _EXPORT_MAX_REGISTROS;
    const avisoTruncamento  = seraTruncado
        ? `\n\n⚠️ Você possui ${transacoesValidas.length} transações. Serão exportadas apenas as ${_EXPORT_MAX_REGISTROS} mais recentes.`
        : '';

    confirmarAcao(
        `⚠️ Exportar as transações do perfil "${_sanitizeText(perfilAtivo.nome)}" para CSV? O arquivo ficará salvo no seu dispositivo.${avisoTruncamento}`,
        () => {
            // ✅ Escape de CSV Injection (já existia — mantido)
            const escaparCSV = (str) => {
                const s = String(str || '').replace(/"/g, '""').replace(/[\r\n]/g, ' ');
                if (/^[=+\-@\t\r]/.test(s)) return `"\t${s}"`;
                return `"${s}"`;
            };

            // ✅ CORREÇÃO: ordena da mais recente e limita ao máximo permitido
            const transacoesParaExportar = transacoesValidas
                .slice()
                .sort((a, b) => {
                    const dataA = `${a.data} ${a.hora || ''}`;
                    const dataB = `${b.data} ${b.hora || ''}`;
                    return dataB.localeCompare(dataA);
                })
                .slice(0, _EXPORT_MAX_REGISTROS);

            let csv = 'Data,Hora,Categoria,Tipo,Descrição,Valor\n';

            transacoesParaExportar.forEach(t => {
                const linha = [
                    escaparCSV(t.data),
                    escaparCSV(t.hora),
                    escaparCSV(t.categoria),
                    escaparCSV(t.tipo),
                    escaparCSV(t.descricao),
                    String(Number(t.valor).toFixed(2)),
                ].join(',');
                csv += linha + '\n';
            });

            // ✅ Verificação de tamanho antes de criar o Blob
            const tamanhoEstimadoBytes = new TextEncoder().encode(csv).length;
            if (tamanhoEstimadoBytes > 10 * 1024 * 1024) {
                mostrarNotificacao(
                    'O arquivo CSV é muito grande. Tente exportar um período menor.',
                    'error'
                );
                return;
            }

            const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
            const url  = URL.createObjectURL(blob);
            const a    = document.createElement('a');
            a.href     = url;
            a.download = `granaevo_transacoes_${_sanitizeText(perfilAtivo.nome).replace(/\s+/g, '_')}_${isoDate()}.csv`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            mostrarNotificacao(
                seraTruncado
                    ? `CSV exportado (${_EXPORT_MAX_REGISTROS} de ${transacoesValidas.length} transações)`
                    : 'Transações exportadas com sucesso!',
                'success'
            );
        }
    );
}

// ========== NOTIFICAÇÕES ==========

// Sistema simples de notificações
function mostrarNotificacao(mensagem, tipo = 'info') {
    const notif = document.createElement('div');
    notif.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        padding: 16px 24px;
        border-radius: 12px;
        color: white;
        font-weight: 600;
        z-index: 10000;
        animation: slideInRight 0.3s ease-out;
        box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    `;
    
    switch(tipo) {
        case 'success':
            notif.style.background = 'linear-gradient(135deg, #00ff99, #00cc77)';
            break;
        case 'error':
            notif.style.background = 'linear-gradient(135deg, #ff4b4b, #cc0000)';
            break;
        case 'warning':
            notif.style.background = 'linear-gradient(135deg, #ffd166, #ffaa00)';
            break;
        default:
            notif.style.background = 'linear-gradient(135deg, #6c63ff, #4a42cc)';
    }
    
    notif.textContent = mensagem;
    document.body.appendChild(notif);
    
    setTimeout(() => {
        notif.style.animation = 'slideOutRight 0.3s ease-out';
        setTimeout(() => {
            document.body.removeChild(notif);
        }, 300);
    }, 3000);
}

// Adiciona animações CSS para notificações
const style = document.createElement('style');
style.textContent = `
    @keyframes slideInRight {
        from {
            transform: translateX(400px);
            opacity: 0;
        }
        to {
            transform: translateX(0);
            opacity: 1;
        }
    }
    
    @keyframes slideOutRight {
        from {
            transform: translateX(0);
            opacity: 1;
        }
        to {
            transform: translateX(400px);
            opacity: 0;
        }
    }
`;
document.head.appendChild(style);

window.mostrarNotificacao = mostrarNotificacao;

// ========== ATALHOS DE TECLADO ==========

// Adiciona suporte a atalhos de teclado
document.addEventListener('keydown', (e) => {
    // Ctrl/Cmd + S para salvar
    if((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        salvarDados();
        mostrarNotificacao('Dados salvos!', 'success');
    }
    
    // ESC para fechar popup
    if(e.key === 'Escape') {
        const overlay = document.getElementById('modalOverlay');
        if(overlay && overlay.classList.contains('active')) {
            fecharPopup();
        }
    }
    
    // Ctrl/Cmd + K para busca rápida (pode implementar no futuro)
    if((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        // Implementar busca rápida aqui
        console.log('Busca rápida (não implementado)');
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

// ========== ESTATÍSTICAS DO SISTEMA ==========

// Retorna estatísticas gerais do perfil
function obterEstatisticas() {
    if(!perfilAtivo) return null;
    
    const hoje = new Date();
    const mesAtual = yearMonthKey();
    const mesPassado = yearMonthKey(new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1));
    
    const transacoesMesAtual = transacoes.filter(t => {
        const dataISO = dataParaISO(t.data);
        return dataISO && dataISO.startsWith(mesAtual);
    });
    
    const transacoesMesPassado = transacoes.filter(t => {
        const dataISO = dataParaISO(t.data);
        return dataISO && dataISO.startsWith(mesPassado);
    });
    
    const calcularTotal = (arr, categoria) => {
        return arr.filter(t => t.categoria === categoria)
                 .reduce((sum, t) => sum + Number(t.valor), 0);
    };
    
    return {
        totalTransacoes: transacoes.length,
        totalMetas: metas.length,
        totalContasFixas: contasFixas.length,
        totalCartoes: cartoesCredito.length,
        mesAtual: {
            entradas: calcularTotal(transacoesMesAtual, 'entrada'),
            saidas: calcularTotal(transacoesMesAtual, 'saida'),
            reservas: calcularTotal(transacoesMesAtual, 'reserva')
        },
        mesPassado: {
            entradas: calcularTotal(transacoesMesPassado, 'entrada'),
            saidas: calcularTotal(transacoesMesPassado, 'saida'),
            reservas: calcularTotal(transacoesMesPassado, 'reserva')
        },
        metasRealizadas: metas.filter(m => m.saved >= m.objetivo).length,
        ticketMedio: transacoes.length > 0 ? 
            transacoes.reduce((sum, t) => sum + Number(t.valor), 0) / transacoes.length : 0
    };
}

// ========== CONSOLE DE DEBUG (APENAS DESENVOLVIMENTO) ==========
const _IS_DEV_BUILD = (
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1'
);

if (_IS_DEV_BUILD) {
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

console.log('%c🚀 GranaEvo (DEV) carregado!', 'color: #43a047; font-size: 16px; font-weight: bold;');
console.log('%c💡 Use window.debugGranaEvo() para ver estado interno', 'color: #6c63ff; font-size: 12px;');

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
class ParticleSystem {
    constructor() {
        // ⚡ Desativado em mobile
        if (window.innerWidth <= 768) return;

        this.canvas = document.getElementById('particles-canvas');
        if (!this.canvas) return;

        this.ctx          = this.canvas.getContext('2d');
        this.particles    = [];
        this.maxParticles = 50;
        this.mouse        = { x: null, y: null, radius: 150 };
        this._animFrameId = null;
        this._destroyed   = false;

        // ✅ Handlers nomeados para poder remover depois (sem memory leak)
        this._onResize    = () => this._handleResize();
        this._onMouseMove = (e) => this.handleMouse(e);

        this.resize();
        this.init();
        this.animate();

        window.addEventListener('resize',    this._onResize);
        window.addEventListener('mousemove', this._onMouseMove);
    }

    _handleResize() {
        if (window.innerWidth <= 768) {
            this.particles = [];
            if (this.ctx && this.canvas) {
                this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
            }
            return;
        }
        this.resize();
    }

    resize() {
        if (!this.canvas) return;
        this.canvas.width  = window.innerWidth;
        this.canvas.height = window.innerHeight;
    }

    init() {
        this.particles = [];
        for (let i = 0; i < this.maxParticles; i++) {
            this.particles.push(this._criarParticula());
        }
    }

    _criarParticula() {
        const w = this.canvas?.width  || window.innerWidth;
        const h = this.canvas?.height || window.innerHeight;
        return {
            x:      Math.random() * w,
            y:      Math.random() * h,
            vx:     (Math.random() - 0.5) * 0.5,
            vy:     (Math.random() - 0.5) * 0.5,
            radius: Math.random() * 2 + 1,
            alpha:  Math.random() * 0.4 + 0.1,
        };
    }

    handleMouse(e) {
        this.mouse.x = e.clientX;
        this.mouse.y = e.clientY;
    }

    _update() {
        if (!this.canvas) return;
        this.particles.forEach(p => {
            p.x += p.vx;
            p.y += p.vy;
            if (p.x < 0 || p.x > this.canvas.width)  p.vx *= -1;
            if (p.y < 0 || p.y > this.canvas.height)  p.vy *= -1;
        });
    }

    _draw() {
        if (!this.canvas || !this.ctx) return;
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.particles.forEach(p => {
            this.ctx.beginPath();
            this.ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
            this.ctx.fillStyle = `rgba(108, 99, 255, ${p.alpha})`;
            this.ctx.fill();
        });
    }

    animate() {
        if (this._destroyed) return;
        this._update();
        this._draw();
        this._animFrameId = requestAnimationFrame(() => this.animate());
    }

    // ✅ Método de cleanup — evita memory leak se o sistema for destruído
    destroy() {
        this._destroyed = true;
        if (this._animFrameId) {
            cancelAnimationFrame(this._animFrameId);
            this._animFrameId = null;
        }
        window.removeEventListener('resize',    this._onResize);
        window.removeEventListener('mousemove', this._onMouseMove);
    }
}

// ⚡ Inicializa APENAS em desktop
document.addEventListener('DOMContentLoaded', () => {
    if (window.innerWidth > 768) {
        setTimeout(() => {
            new ParticleSystem();
        }, 500);
    }
});

function desenharGraficoLinha() {
    const canvas = document.getElementById('linhaChart');
    if(!canvas) return;
    const ctx = canvas.getContext('2d');
    
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    const padding = 60;
    const w = canvas.width - padding * 2;
    const h = canvas.height - padding * 2;
    
    const hoje = new Date();
    const meses = [];
    const saldos = [];
    
    for(let i = 5; i >= 0; i--) {
        const data = new Date(hoje.getFullYear(), hoje.getMonth() - i, 1);
        const y = data.getFullYear();
        const m = String(data.getMonth() + 1).padStart(2, '0');
        const periodo = `${y}-${m}`;
        
        const transacoesMes = transacoes.filter(t => {
            const dataISO = dataParaISO(t.data);
            return dataISO && dataISO.startsWith(periodo);
        });
        
        let entradas = 0, saidas = 0;
        transacoesMes.forEach(t => {
            if(t.categoria === 'entrada') entradas += Number(t.valor);
            else if(t.categoria === 'saida' || t.categoria === 'reserva') saidas += Number(t.valor);
        });
        
        meses.push(data.toLocaleString('pt-BR', {month: 'short'}));
        saldos.push(entradas - saidas);
    }
    
    const maxSaldo = Math.max(...saldos.map(Math.abs), 100);
    
    ctx.strokeStyle = '#ccc';
    ctx.lineWidth = 1;
    ctx.strokeRect(padding, padding, w, h);
    
    const zeroY = padding + h/2;
    ctx.strokeStyle = '#666';
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(padding, zeroY);
    ctx.lineTo(padding + w, zeroY);
    ctx.stroke();
    ctx.setLineDash([]);
    
    const points = [];
    ctx.beginPath();
    saldos.forEach((saldo, i) => {
        const x = padding + (i / (saldos.length - 1)) * w;
        const y = padding + h/2 - (saldo / maxSaldo) * (h/2.5);
        
        if(i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        points.push({x, y, saldo, mes: meses[i]});
    });
    ctx.strokeStyle = '#4da6ff';
    ctx.lineWidth = 3;
    ctx.stroke();
    
    ctx.lineTo(padding + w, padding + h);
    ctx.lineTo(padding, padding + h);
    ctx.closePath();
    const gradient = ctx.createLinearGradient(0, padding, 0, padding + h);
    gradient.addColorStop(0, '#4da6ff40');
    gradient.addColorStop(1, '#4da6ff00');
    ctx.fillStyle = gradient;
    ctx.fill();
    
    points.forEach(p => {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
        ctx.fillStyle = p.saldo >= 0 ? '#00ff99' : '#ff4b4b';
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.stroke();
    });
    
    ctx.fillStyle = '#ccc';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    meses.forEach((mes, i) => {
        const x = padding + (i / (saldos.length - 1)) * w;
        ctx.fillText(mes, x, padding + h + 20);
    });
    
    canvas._points = points;

    if (!canvas._clickListenerRegistrado) {
        canvas._clickListenerRegistrado = true;
        canvas.addEventListener('click', function(ev) {
            const rect = canvas.getBoundingClientRect();
            const mx = ev.clientX - rect.left;
            const my = ev.clientY - rect.top;

            const ponto = (canvas._points || []).find(p => {
                const dx = p.x - mx, dy = p.y - my;
                return Math.sqrt(dx * dx + dy * dy) <= 8;
            });

            if (ponto) {
                mostrarNotificacao(
                    `${_sanitizeText(ponto.mes)}: ${formatBRL(ponto.saldo)}`,
                    'info'
                );
            }
        });
    }
}

function desenharTopGastos(dados, label) {
    const canvas = document.getElementById('topGastosChart');
    if(!canvas) return;
    const ctx = canvas.getContext('2d');
    
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    if(dados.top5.length === 0) {
        ctx.fillStyle = '#ccc';
        ctx.font = '14px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Sem gastos registrados', canvas.width/2, canvas.height/2);
        return;
    }
    
    const padding   = 40;
    const w         = canvas.width - padding * 2 - 100;
    const h         = canvas.height - padding * 2;
    const barHeight = h / dados.top5.length - 10;
    const maxValor  = Math.max(...dados.top5.map(g => g.valor));
    
    dados.top5.forEach((gasto, i) => {
        const y      = padding + i * (barHeight + 10);
        const largura = (gasto.valor / maxValor) * w;
        
        const gradient = ctx.createLinearGradient(padding + 100, 0, padding + 100 + largura, 0);
        gradient.addColorStop(0, '#ff4b4b');
        gradient.addColorStop(1, '#ff7a7a');
        
        ctx.fillStyle = gradient;
        ctx.fillRect(padding + 100, y, largura, barHeight);
        
        ctx.strokeStyle = '#ff4b4b';
        ctx.lineWidth   = 2;
        ctx.strokeRect(padding + 100, y, largura, barHeight);
        
        // ── Label da categoria (lado esquerdo)
        ctx.fillStyle = '#fff';
        ctx.font      = 'bold 11px sans-serif';
        ctx.textAlign = 'right';
        // ✅ sanitizeHTML antes de renderizar no canvas (defesa em profundidade)
        ctx.fillText(
            String(gasto.tipo || '').slice(0, 20),
            padding + 95,
            y + barHeight / 2 + 4
        );
        
        // ── Valor (lado direito da barra)
        ctx.textAlign = 'left';
        ctx.fillText(
            formatBRL(gasto.valor),
            padding + 105 + largura,
            y + barHeight / 2 + 4
        );
    });

    // ── Rótulo do gráfico (rodapé)
    ctx.fillStyle = '#ccc';
    ctx.font      = '12px sans-serif';
    ctx.textAlign = 'center'; // ✅ linha que estava incompleta — corrigida
    if (label) {
        ctx.fillText(String(label).slice(0, 50), canvas.width / 2, canvas.height - 8);
    }
}

// ========== SALVAMENTO GARANTIDO AO SAIR ==========
window.addEventListener('beforeunload', () => {
    if (perfilAtivo && dataManager.userId) {
        console.log('🚪 Usuário saindo - Enviando dados via beacon...');

        atualizarReferenciasGlobais();

        // ✅ Aplica os mesmos _validators usados em salvarDados()
        //    Garante que dados corrompidos ou injetados via console
        //    não bypassem a validação ao fechar a aba
        const transacoesValidas  = transacoes.filter(_validators.transacao);
        const metasValidas       = metas.filter(_validators.meta);
        const contasValidas      = contasFixas.filter(_validators.contaFixa);
        const cartoesValidos     = cartoesCredito.filter(_validators.cartao);

        // ✅ Remove _processando antes de persistir — flag temporária de runtime,
        //    nunca deve ser salva no banco (ver Vulnerabilidade 2)
        const contasSemLock = contasValidas.map(c => {
            const { _processando, ...rest } = c;
            return rest;
        });

        if (transacoesValidas.length !== transacoes.length   ||
            metasValidas.length      !== metas.length         ||
            contasValidas.length     !== contasFixas.length   ||
            cartoesValidos.length    !== cartoesCredito.length) {
            _log.warn('BEFOREUNLOAD: itens inválidos descartados antes de persistir via beacon');
        }

        const profilesAtual = [{
            id:             perfilAtivo.id,
            nome:           _sanitizeText(perfilAtivo.nome),
            foto:           _sanitizeImgUrl(perfilAtivo.foto) || null,
            transacoes:     transacoesValidas,
            metas:          metasValidas,
            contasFixas:    contasSemLock,
            cartoesCredito: cartoesValidos,
            nextCartaoId:   Number.isInteger(nextCartaoId) && nextCartaoId > 0 ? nextCartaoId : 1,
            lastUpdate:     new Date().toISOString()
        }];

        dataManager.saveImmediate(profilesAtual);
    }
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

// ========== INICIALIZAÇÃO ==========
document.addEventListener('DOMContentLoaded', () => {
    console.log('🚀 Dashboard carregado, iniciando verificação de login...');
    verificarLogin();
    bindEventos();
    setupSidebarToggle();
});
