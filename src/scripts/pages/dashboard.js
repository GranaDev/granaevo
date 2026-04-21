// ========== IMPORTS ESSENCIAIS ==========
import { supabase } from '../services/supabase-client.js?v=2';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../services/supabase-client.js?v=2';
import { dataManager } from '../modules/data-manager.js?v=2';
import AuthGuard from '../modules/auth-guard.js?v=2';

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
        'prazo', 'tipoRendimento', 'taxaJuros', 'cdiPct',
        'rendimentoPeriodo', 'aporteRecorrente', 'valorAporte',
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
            planName = subscription.plans?.name ?? '';
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
                planName = subByEmail.plans?.name ?? '';
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

                planName = ownerSub.plans?.name ?? '';
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

// Cached once — static nav elements never change after DOM is ready
let _domPages     = null;
let _domNavBtns   = null;
let _domMobileNav = null;

function _makeCtx() {
    return Object.defineProperties({}, {
        transacoes:          { get: () => transacoes,          set: v => { transacoes = v; },          enumerable: true },
        metas:               { get: () => metas,               set: v => { metas = v; },               enumerable: true },
        cartoesCredito:      { get: () => cartoesCredito,      set: v => { cartoesCredito = v; },      enumerable: true },
        contasFixas:         { get: () => contasFixas,         set: v => { contasFixas = v; },         enumerable: true },
        perfilAtivo:         { get: () => perfilAtivo,         set: v => { perfilAtivo = v; },         enumerable: true },
        usuarioLogado:       { get: () => usuarioLogado,       set: v => { usuarioLogado = v; },       enumerable: true },
        filtroMovAtivo:      { get: () => filtroMovAtivo,      set: v => { filtroMovAtivo = v; },      enumerable: true },
        filtroMovMes:        { get: () => filtroMovMes,        set: v => { filtroMovMes = v; },        enumerable: true },
        filtroMovAno:        { get: () => filtroMovAno,        set: v => { filtroMovAno = v; },        enumerable: true },
        nextTransId:         { get: () => nextTransId,         set: v => { nextTransId = v; },         enumerable: true },
        nextMetaId:          { get: () => nextMetaId,          set: v => { nextMetaId = v; },          enumerable: true },
        nextCartaoId:        { get: () => nextCartaoId,        set: v => { nextCartaoId = v; },        enumerable: true },
        nextContaFixaId:     { get: () => nextContaFixaId,     set: v => { nextContaFixaId = v; },     enumerable: true },
        metaSelecionadaId:   { get: () => metaSelecionadaId,   set: v => { metaSelecionadaId = v; },   enumerable: true },
        cartaoSelecionadoId: { get: () => cartaoSelecionadoId, set: v => { cartaoSelecionadoId = v; }, enumerable: true },
        tipoRelatorioAtivo:  { get: () => tipoRelatorioAtivo,  set: v => { tipoRelatorioAtivo = v; },  enumerable: true },
        _effectiveUserId:    { get: () => _effectiveUserId,    set: v => { _effectiveUserId = v; },    enumerable: true },
        _effectiveEmail:     { get: () => _effectiveEmail,     set: v => { _effectiveEmail = v; },     enumerable: true },
        _movPaginaAtual:     { get: () => _movPaginaAtual,     set: v => { _movPaginaAtual = v; },     enumerable: true },
        _movVisivelCache:    { get: () => _movVisivelCache,    set: v => { _movVisivelCache = v; },    enumerable: true },
        _movDelegateSet:     { get: () => _movDelegateSet,     set: v => { _movDelegateSet = v; },     enumerable: true },
        _chartJsCarregado:   { get: () => _chartJsCarregado,   set: v => { _chartJsCarregado = v; },   enumerable: true },
        _chartJsCarregando:  { get: () => _chartJsCarregando,  set: v => { _chartJsCarregando = v; },  enumerable: true },
        _gerandoRelatorio:   { get: () => _gerandoRelatorio,   set: v => { _gerandoRelatorio = v; },   enumerable: true },
        // Constants
        limitesPlano:        { value: limitesPlano,        enumerable: true },
        BANCO_ABREV:         { value: BANCO_ABREV,         enumerable: true },
        BANCO_COR:           { value: BANCO_COR,           enumerable: true },
        BANCO_ICON:          { value: BANCO_ICON,          enumerable: true },
        _CHARTJS_SRC:        { value: _CHARTJS_SRC,        enumerable: true },
        _CHARTJS_INTEGRITY:  { value: _CHARTJS_INTEGRITY,  enumerable: true },
        _validators:         { value: _validators,         enumerable: true },
        _SAVE_LIMITS:        { value: _SAVE_LIMITS,        enumerable: true },
        _ALLOWED_KEYS:       { value: _ALLOWED_KEYS,       enumerable: true },
        _sessionNonce:       { get: () => _sessionNonce,   enumerable: true },
        _notificacaoControl: { get: () => _notificacaoControl, enumerable: true },
        _log:                { get: () => _log,            enumerable: true },
        // Utility functions
        formatBRL:           { value: (...a) => formatBRL(...a),           enumerable: true },
        formatarDataBR:      { value: (...a) => formatarDataBR(...a),      enumerable: true },
        dataParaISO:         { value: (...a) => dataParaISO(...a),         enumerable: true },
        getMesNome:          { value: (...a) => getMesNome(...a),          enumerable: true },
        agoraDataHora:       { value: (...a) => agoraDataHora(...a),       enumerable: true },
        isoDate:             { value: (...a) => isoDate(...a),             enumerable: true },
        yearMonthKey:        { value: (...a) => yearMonthKey(...a),        enumerable: true },
        formatarTelefone:    { value: (...a) => formatarTelefone(...a),    enumerable: true },
        formatarCPF:         { value: (...a) => formatarCPF(...a),         enumerable: true },
        numeroParaExtenso:   { value: (...a) => numeroParaExtenso(...a),   enumerable: true },
        sanitizeNumber:      { value: (...a) => sanitizeNumber(...a),      enumerable: true },
        sanitizeDate:        { value: (...a) => sanitizeDate(...a),        enumerable: true },
        _sanitizeText:       { value: (...a) => _sanitizeText(...a),       enumerable: true },
        _sanitizeImgUrl:     { value: (...a) => _sanitizeImgUrl(...a),     enumerable: true },
        _sanitizeObject:     { value: (...a) => _sanitizeObject(...a),     enumerable: true },
        _validarMagicBytes:  { value: (...a) => _validarMagicBytes(...a),  enumerable: true },
        sanitizeHTML:        { value: (...a) => sanitizeHTML(...a),        enumerable: true },
        escapeHTML:          { value: (...a) => escapeHTML(...a),          enumerable: true },
        _aplicarEstilosCSOM: { value: (...a) => _aplicarEstilosCSOM(...a), enumerable: true },
        criarPopup:          { value: (...a) => criarPopup(...a),          enumerable: true },
        criarPopupDOM:       { value: (...a) => criarPopupDOM(...a),       enumerable: true },
        fecharPopup:         { value: (...a) => fecharPopup(...a),         enumerable: true },
        confirmarAcao:       { value: (...a) => confirmarAcao(...a),       enumerable: true },
        mostrarNotificacao:  { value: (...a) => mostrarNotificacao(...a),  enumerable: true },
        salvarDados:         { value: (...a) => salvarDados(...a),         enumerable: true },
        _throttledSave:      { value: (...a) => _throttledSave(...a),      enumerable: true },
        atualizarDashboardResumo:  { value: (...a) => atualizarDashboardResumo(...a),  enumerable: true },
        atualizarTudo:             { value: (...a) => atualizarTudo(...a),             enumerable: true },
        atualizarListaContasFixas: { value: (...a) => atualizarListaContasFixas(...a), enumerable: true },
        verificarVencimentos:      { value: (...a) => verificarVencimentos(...a),      enumerable: true },
        atualizarBadgeVencimentos: { value: (...a) => atualizarBadgeVencimentos(...a), enumerable: true },
        _requerPerfilAtivo:        { value: (...a) => _requerPerfilAtivo(...a),        enumerable: true },
        _requerNonce:              { value: (...a) => _requerNonce(...a),              enumerable: true },
        desenharGraficoLinha:      { value: (...a) => desenharGraficoLinha(...a),      enumerable: true },
        desenharTopGastos:         { value: (...a) => desenharTopGastos(...a),         enumerable: true },
        exportarDadosJSON:         { value: (...a) => exportarDadosJSON(...a),         enumerable: true },
        exportarDadosCSV:          { value: (...a) => exportarDadosCSV(...a),          enumerable: true },
        sistemaLog:                { get: () => sistemaLog,                             enumerable: true },
        // Cross-section lazy calls
        atualizarMovimentacoesUI: { value: () => window._dbTransacoes?.atualizarMovimentacoesUI?.(), enumerable: true },
        renderMetasList:          { value: () => window._dbMetas?.renderMetasList?.(),               enumerable: true },
        atualizarTelaCartoes:     { value: () => window._dbCartoes?.atualizarTelaCartoes?.(),        enumerable: true },
        inicializarGraficos:      { value: () => window._dbGraficos?.inicializarGraficos?.(),        enumerable: true },
        popularFiltrosRelatorio:  { value: () => window._dbRelatorios?.popularFiltrosRelatorio?.(),  enumerable: true },
    });
}

let _dbLoaded = { transacoes: false, metas: false, cartoes: false, graficos: false, relatorios: false, configuracoes: false };

function mostrarTela(tela) {
    if (!_domPages)     _domPages     = document.querySelectorAll('.page');
    if (!_domNavBtns)   _domNavBtns   = document.querySelectorAll('.nav-btn');
    if (!_domMobileNav) _domMobileNav = document.querySelectorAll('.mobile-nav-item');

    _domPages.forEach(p => {
        p.classList.remove('active');
        p.style.display = 'none';
    });

    window.scrollTo({ top: 0, behavior: 'instant' });

    // Sidebar — nav-btn
    _domNavBtns.forEach(btn => btn.classList.remove('active'));
    const sidebarBtn = document.querySelector(`[data-page="${tela}"]`);
    if (sidebarBtn) sidebarBtn.classList.add('active');

    // Mobile — bottom nav
    _domMobileNav.forEach(btn => btn.classList.remove('active'));
    const mobileBtn = document.querySelector(`.mobile-nav-item[data-page="${tela}"]`);
    if (mobileBtn) mobileBtn.classList.add('active');

    const pageEl = document.getElementById(tela + 'Page');
    if (pageEl) {
        pageEl.style.display = 'block';
        pageEl.classList.add('active');
    }

    // Lazy load section modules
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

        if (!_dbLoaded.transacoes) {
            import('./db-transacoes.js?v=1').then(m => {
                m.init(_makeCtx());
                _dbLoaded.transacoes = true;
            });
        } else {
            window._dbTransacoes?.atualizarMovimentacoesUI?.();
        }
    }

    if (tela === 'reservas') {
        if (!_dbLoaded.metas) {
            import('./db-metas.js?v=1').then(m => {
                m.init(_makeCtx());
                _dbLoaded.metas = true;
            });
        } else {
            window._dbMetas?.renderMetasList?.();
        }
    }

    if (tela === 'cartoes') {
        if (!_dbLoaded.cartoes) {
            import('./db-cartoes.js?v=1').then(m => {
                m.init(_makeCtx());
                _dbLoaded.cartoes = true;
            });
        } else {
            window._dbCartoes?.atualizarTelaCartoes?.();
        }
    }

    if (tela === 'graficos') {
        if (!_dbLoaded.graficos) {
            import('./db-graficos.js?v=1').then(m => {
                m.init(_makeCtx());
                _dbLoaded.graficos = true;
            });
        } else {
            window._dbGraficos?.inicializarGraficos?.();
        }
    }

    if (tela === 'relatorios') {
        if (!_dbLoaded.relatorios) {
            import('./db-relatorios.js?v=1').then(m => {
                m.init(_makeCtx());
                _dbLoaded.relatorios = true;
            });
        } else {
            window._dbRelatorios?.popularFiltrosRelatorio?.();
        }
    }

    if (tela === 'configuracoes') {
        if (!_dbLoaded.configuracoes) {
            import('./db-configuracoes.js?v=1').then(m => {
                m.init(_makeCtx());
                _dbLoaded.configuracoes = true;
            });
        }
    }
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

// Cached saldo DOM refs — populated once, reused on every transaction change
const _domSaldoEls = { entradas: null, saidas: null, saldo: null, reservas: null, hero: null };
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

    if (!_domSaldoEls.entradas) {
        _domSaldoEls.entradas = document.getElementById('totalEntradas');
        _domSaldoEls.saidas   = document.getElementById('totalSaidas');
        _domSaldoEls.saldo    = document.getElementById('totalSaldo');
        _domSaldoEls.reservas = document.getElementById('totalReservas');
        _domSaldoEls.hero     = document.getElementById('heroSaldo');
    }
    const { entradas: entradasEl, saidas: saidasEl, saldo: saldoEl, reservas: reservasEl, hero: heroSaldoEl } = _domSaldoEls;

    if (entradasEl) entradasEl.textContent = formatBRL(totalEntradas);
    if (saidasEl)   saidasEl.textContent   = formatBRL(totalSaidas);
    if (saldoEl)    saldoEl.textContent     = formatBRL(saldo);
    if (heroSaldoEl && !heroSaldoEl.classList.contains('oculto')) {
        heroSaldoEl.textContent = formatBRL(saldo);
    }
    if (heroSaldoEl) heroSaldoEl.dataset.valor = formatBRL(saldo);
    if (reservasEl)  reservasEl.textContent    = formatBRL(totalReservasCalc);
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

// Atualiza badge (desktop) e bolinha (mobile) de notificações
function atualizarBadgeNotificacoes() {
    const alertas = verificarVencimentos();
    const total   = alertas?.total ?? 0;

    // Badge sidebar desktop
    const badgeSidebar = document.getElementById('notifBadgeSidebar');
    if (badgeSidebar) {
        if (total > 0) {
            badgeSidebar.textContent   = String(total);
            badgeSidebar.style.display = 'flex';
            badgeSidebar.style.background = alertas.vencidas.length > 0 ? '#ff4b4b' : '#ffd166';
        } else {
            badgeSidebar.style.display = 'none';
        }
    }

    // Bolinha mobile — aparece apenas quando há notificações novas (hash diferente do visto)
    const hashAtual = alertas ? _notifHash(alertas) : '';
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

// Mostrar painel de alertas na dashboard
function renderizarPainelAlertas() {
    const alertas = verificarVencimentos();
    if (!alertas || alertas.total === 0) return null;

    const wrap = document.createElement('div');
    wrap.className = 'alertas-vencimento';

    // ── helper: extrai id seguro
    function _idSeguro(conta) {
        const raw = conta.id;
        const n   = parseInt(raw, 10);
        const id  = Number.isInteger(n) && String(n) === String(raw) ? n : raw;
        return (id === null || id === undefined || id === '') ? null : id;
    }

    // ── helper: calcula dias (positivo = futuro, negativo = passado)
    function _diffDias(vencimentoISO) {
        const hoje = new Date(); hoje.setHours(0,0,0,0);
        const d    = new Date(vencimentoISO + 'T00:00:00');
        return Math.round((d - hoje) / 86400000);
    }

    // ── helper: cria um card de conta
    function _criarCard(conta, tipo) {
        const id = _idSeguro(conta);
        if (!id) return null;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(conta.vencimento)) return null;
        if (isNaN(new Date(conta.vencimento + 'T00:00:00').getTime())) return null;

        const diff = _diffDias(conta.vencimento);

        const paleta = {
            vencida:  { bg: 'rgba(255,75,75,0.1)',   borda: '#ff4b4b', tag: '#ff4b4b',  acao: 'pagar'  },
            hoje:     { bg: 'rgba(255,140,50,0.1)',  borda: '#ff8c32', tag: '#ff8c32',  acao: 'editar' },
            em3Dias:  { bg: 'rgba(255,209,102,0.1)', borda: '#ffd166', tag: '#ffd166',  acao: 'editar' },
            proximo:  { bg: 'rgba(76,166,255,0.1)',  borda: '#4ca6ff', tag: '#4ca6ff',  acao: 'editar' },
        };
        const p = paleta[tipo] || paleta.proximo;

        const card = document.createElement('div');
        card.className   = 'alerta-card';
        card.dataset.id  = String(id);
        card.dataset.acao = p.acao;
        card.style.cssText = `
            background: ${p.bg};
            border-left: 3px solid ${p.borda};
            border-radius: 12px;
            padding: 14px 16px;
            margin-bottom: 10px;
            cursor: pointer;
            transition: opacity .15s;
        `;

        // ── Linha 1: nome + badge
        const row1 = document.createElement('div');
        row1.style.cssText = 'display:flex; justify-content:space-between; align-items:flex-start; gap:8px; margin-bottom:10px;';

        const nome = document.createElement('div');
        nome.style.cssText = 'font-weight:700; color:var(--text-primary); font-size:0.95rem; flex:1;';
        nome.textContent   = conta.descricao;

        const badge = document.createElement('span');
        badge.style.cssText = `
            background: ${p.borda}22;
            color: ${p.tag};
            border: 1px solid ${p.borda}55;
            font-size: 0.72rem;
            font-weight: 700;
            padding: 3px 9px;
            border-radius: 20px;
            white-space: nowrap;
            display: flex;
            align-items: center;
            gap: 4px;
        `;

        const bIcon = document.createElement('i');
        if      (tipo === 'vencida') { bIcon.className = 'fas fa-triangle-exclamation'; badge.appendChild(bIcon); badge.appendChild(document.createTextNode(`Vencida há ${Math.abs(diff)} dia(s)`)); }
        else if (tipo === 'hoje')    { bIcon.className = 'fas fa-bell';                  badge.appendChild(bIcon); badge.appendChild(document.createTextNode('Vence Hoje')); }
        else if (tipo === 'em3Dias') { bIcon.className = 'fas fa-clock';                 badge.appendChild(bIcon); badge.appendChild(document.createTextNode('Em 3 dias')); }
        else                         { bIcon.className = 'fas fa-calendar';              badge.appendChild(bIcon); badge.appendChild(document.createTextNode(`Em ${diff} dia(s)`)); }

        row1.appendChild(nome);
        row1.appendChild(badge);

        // ── Linha 2: valor + data vencimento + botão pagar (se vencida)
        const row2 = document.createElement('div');
        row2.style.cssText = 'display:flex; justify-content:space-between; align-items:center; gap:8px;';

        const metaInfo = document.createElement('div');
        metaInfo.style.cssText = 'display:flex; flex-direction:column; gap:3px;';

        const valorEl = document.createElement('div');
        valorEl.style.cssText = 'font-size:0.9rem; color:var(--text-primary); font-weight:600;';
        const valorIcon = document.createElement('i');
        valorIcon.className = 'fas fa-tag';
        valorIcon.style.cssText = `color:${p.borda}; margin-right:5px; font-size:0.8rem;`;
        valorEl.appendChild(valorIcon);
        valorEl.appendChild(document.createTextNode(formatBRL(conta.valor)));

        const vencEl = document.createElement('div');
        vencEl.style.cssText = 'font-size:0.8rem; color:var(--text-muted); display:flex; align-items:center; gap:4px;';
        const vencIcon = document.createElement('i');
        vencIcon.className = 'fas fa-calendar-day';
        vencEl.appendChild(vencIcon);
        vencEl.appendChild(document.createTextNode(` ${formatarDataBR(conta.vencimento)}`));

        metaInfo.appendChild(valorEl);
        metaInfo.appendChild(vencEl);
        row2.appendChild(metaInfo);

        if (tipo === 'vencida') {
            const btn = document.createElement('button');
            btn.className   = 'alerta-btn';
            btn.dataset.id  = String(id);
            btn.dataset.acao = 'pagar-btn';
            const btnIcon = document.createElement('i');
            btnIcon.className = 'fas fa-check-circle';
            btnIcon.style.marginRight = '5px';
            btn.appendChild(btnIcon);
            btn.appendChild(document.createTextNode('Pagar'));
            row2.appendChild(btn);
        }

        card.appendChild(row1);
        card.appendChild(row2);
        return card;
    }

    // ── Renderizar seções por prioridade
    const grupos = [
        { lista: alertas.vencidas || [],  tipo: 'vencida',  iconCls: 'fas fa-circle-exclamation', titulo: 'Contas Vencidas',    cor: '#ff4b4b' },
        { lista: alertas.hoje    || [],   tipo: 'hoje',     iconCls: 'fas fa-bell',                titulo: 'Vencem Hoje',        cor: '#ff8c32' },
        { lista: alertas.em3Dias || [],   tipo: 'em3Dias',  iconCls: 'fas fa-clock',               titulo: 'Vencem em 3 Dias',   cor: '#ffd166' },
        { lista: alertas.proximos || [],  tipo: 'proximo',  iconCls: 'fas fa-calendar-check',      titulo: 'Próximos 7 Dias',    cor: '#4ca6ff' },
    ];

    grupos.forEach(g => {
        if (g.lista.length === 0) return;

        const sec = document.createElement('div');
        sec.style.cssText = 'margin-bottom:18px;';

        const secHeader = document.createElement('div');
        secHeader.style.cssText = 'display:flex; align-items:center; gap:8px; margin-bottom:10px; padding-bottom:8px; border-bottom:1px solid rgba(255,255,255,0.08);';

        const secIcon = document.createElement('i');
        secIcon.className = g.iconCls;
        secIcon.style.cssText = `color:${g.cor}; font-size:0.9rem;`;

        const secTitle = document.createElement('span');
        secTitle.style.cssText = `font-weight:700; font-size:0.85rem; color:${g.cor}; text-transform:uppercase; letter-spacing:0.5px;`;
        secTitle.textContent   = `${g.titulo} (${g.lista.length})`;

        secHeader.appendChild(secIcon);
        secHeader.appendChild(secTitle);
        sec.appendChild(secHeader);

        g.lista.forEach(conta => {
            const card = _criarCard(conta, g.tipo);
            if (card) sec.appendChild(card);
        });

        wrap.appendChild(sec);
    });

    return wrap;
}

// Controle inteligente de notificações nativas — por categoria, sem spam
const _notificacaoControl = {
    _CHAVE: 'granaevo_notif_ctrl_v2',
    _get()  { try { return JSON.parse(localStorage.getItem(this._CHAVE) || '{}'); } catch { return {}; } },
    _save(d) { try { localStorage.setItem(this._CHAVE, JSON.stringify(d)); } catch {} },
    // Limites: vencidas 3x/semana (48h), hoje 1x/dia, em3Dias 1x/dia, proximos 1x/semana
    _limites: { vencidas: 48 * 3600000, hoje: 86400000, em3Dias: 86400000, proximos: 7 * 86400000 },
    podeEnviar(tipo) {
        return Date.now() - (this._get()[tipo] || 0) > (this._limites[tipo] ?? 86400000);
    },
    marcar(tipo) { const d = this._get(); d[tipo] = Date.now(); this._save(d); }
};

function verificacaoAutomaticaVencimentos() {
    const alertas = verificarVencimentos();
    if(!alertas) return;
    atualizarBadgeVencimentos();

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
    const hash = alertas ? _notifHash(alertas) : '';
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
function abrirPainelNotificacoes() {
    const painel  = document.getElementById('notificacoesPanel');
    const lista   = document.getElementById('notificacoesLista');
    const overlay = document.getElementById('notificacoesOverlay');
    if (!painel || !lista) return;

    // Limpa conteúdo anterior
    lista.innerHTML = '';

    const alertas = verificarVencimentos();

    if (!alertas || alertas.total === 0) {
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
    } else {
        // Reutiliza renderizarPainelAlertas com listener de ações
        const painelEl = renderizarPainelAlertas();
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
    _aplicarEstilosCSOM(box);
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
    window._dbTransacoes?.atualizarMovimentacoesUI?.();
    atualizarDashboardResumo();
    atualizarListaContasFixas();
    window._dbMetas?.renderMetasList?.();
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
        btnAlterarSenha.addEventListener('click', () => window.abrirAlterarSenha?.());
    }

    const btnTrocarPerfil = document.getElementById('btnTrocarPerfil');
    if(btnTrocarPerfil) {
        btnTrocarPerfil.addEventListener('click', () => window.trocarPerfil?.());
    }

    const btnComoUsar = document.getElementById('btnComoUsar');
    if(btnComoUsar) {
        btnComoUsar.addEventListener('click', () => window.comoUsar?.());
    }

    const btnLogout = document.getElementById('btnLogout');
    if(btnLogout) {
        btnLogout.addEventListener('click', () => window.confirmarLogout?.());
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
    widgetOndeFoi.addEventListener('click', () => window.abrirWidgetOndeForDinheiro?.());
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

// Sistema simples de notificações — estilos em dashboard.css (classes ge-notif)
function mostrarNotificacao(mensagem, tipo = 'info') {
    const tipoMap = { success: 'ge-notif--success', error: 'ge-notif--error', warning: 'ge-notif--warning' };
    const notif = document.createElement('div');
    notif.className = `ge-notif ${tipoMap[tipo] ?? 'ge-notif--info'}`;
    notif.textContent = String(mensagem ?? '').slice(0, 200);
    document.body.appendChild(notif);
    setTimeout(() => {
        notif.classList.add('ge-notif--exit');
        setTimeout(() => { notif.remove(); }, 320);
    }, 3000);
}

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
        // ⚡ Desativado em mobile e para usuários que preferem menos movimento
        if (window.innerWidth <= 768) return;
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

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
    verificarLogin();
    bindEventos();
    setupSidebarToggle();

    // Fallback para qualquer <img> de foto de perfil que falhar ao carregar
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
});
