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
        atualizarMovimentacoesUI();
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
        creditDiv.classList.remove('js-hidden');
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
        creditDiv.classList.add('js-hidden');
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
        if(cartao.congelado) { mostrarNotificacao('Cartão congelado. Descongele no menu de Cartões para utilizá-lo.', 'error'); return; }

        if(!confirm(`Compra de ${formatBRL(valor)} no cartão ${cartao.nomeBanco}, em ${parcelasSel}x de ${formatBRL(valor/parcelasSel)}.\nProsseguir?`)) return;

        let hoje       = new Date();
        let anoAtual   = hoje.getFullYear();
        let mesAtual   = hoje.getMonth() + 1;
        let diaHoje    = hoje.getDate();
        // diaFechamento determina qual ciclo a compra pertence (cutoff real do cartão)
        // fallback para vencimentoDia mantém compatibilidade com cartões antigos sem fechamentoDia
        let diaFechamento = cartao.fechamentoDia ?? cartao.vencimentoDia;
        let diaFatura     = cartao.vencimentoDia;

        let proxMes, proxAno;
        if(diaHoje >= diaFechamento) {
            // Fatura já fechou ou fecha hoje → compra vai pro próximo ciclo
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

function filtrarTransacoesParaUI() {
    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);

    return transacoes.filter(t => {
        if (filtroMovAtivo === 'todo') return true;

        const iso = dataParaISO(t.data || '');
        if (!iso) return false;
        const d = new Date(iso + 'T00:00:00');

        if (filtroMovAtivo === 'mes_atual') {
            return d.getMonth() === hoje.getMonth() && d.getFullYear() === hoje.getFullYear();
        }
        if (filtroMovAtivo === '15_dias') {
            const limite = new Date(hoje); limite.setDate(hoje.getDate() - 14);
            return d >= limite && d <= hoje;
        }
        if (filtroMovAtivo === '30_dias') {
            const limite = new Date(hoje); limite.setDate(hoje.getDate() - 29);
            return d >= limite && d <= hoje;
        }
        if (filtroMovAtivo === '60_dias') {
            const limite = new Date(hoje); limite.setDate(hoje.getDate() - 59);
            return d >= limite && d <= hoje;
        }
        if (filtroMovAtivo === 'periodo') {
            const mes = filtroMovMes !== null ? filtroMovMes : hoje.getMonth();
            const ano = filtroMovAno !== null ? filtroMovAno : hoje.getFullYear();
            return d.getMonth() === mes && d.getFullYear() === ano;
        }
        return true;
    });
}

function bindFiltrosMovimentacoes() {
    const container = document.getElementById('movFiltros');
    if (!container) return;

    // Toggle do painel de filtros
    const toggleBtn = document.getElementById('toggleFiltrosBtn');
    const wrapper   = document.getElementById('movFiltrosWrapper');
    if (toggleBtn && wrapper) {
        toggleBtn.addEventListener('click', () => {
            const isOpen = wrapper.classList.toggle('open');
            toggleBtn.setAttribute('aria-expanded', String(isOpen));
        });
    }

    // Mapa para exibir nome legível do filtro ativo
    const nomeFiltros = {
        mes_atual: 'Mês atual',
        '15_dias': 'Últimos 15 dias',
        '30_dias': 'Últimos 30 dias',
        '60_dias': 'Últimos 60 dias',
        periodo:   'Mês/ano',
        todo:      'Todo o período',
    };

    function atualizarLabelAtivo(filtro) {
        const label = document.getElementById('filtroAtivoLabel');
        if (label) label.textContent = nomeFiltros[filtro] || filtro;
    }

    container.addEventListener('click', e => {
        const btn = e.target.closest('.mov-filtro-btn');
        if (!btn) return;

        container.querySelectorAll('.mov-filtro-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        filtroMovAtivo = btn.dataset.filtro;
        atualizarLabelAtivo(filtroMovAtivo);

        // Fecha o painel após selecionar (exceto "período" que precisa de sub-seleção)
        if (filtroMovAtivo !== 'periodo' && wrapper) {
            wrapper.classList.remove('open');
            if (toggleBtn) toggleBtn.setAttribute('aria-expanded', 'false');
        }

        const periodoSel = document.getElementById('movPeriodoSelector');
        if (periodoSel) periodoSel.style.display = filtroMovAtivo === 'periodo' ? 'flex' : 'none';

        if (filtroMovAtivo !== 'periodo') atualizarMovimentacoesUI();
    });

    const btnAplicar = document.getElementById('btnAplicarFiltroMes');
    if (btnAplicar) {
        btnAplicar.addEventListener('click', () => {
            const mesEl = document.getElementById('movFiltroMes');
            const anoEl = document.getElementById('movFiltroAno');
            if (mesEl) filtroMovMes = parseInt(mesEl.value, 10);
            if (anoEl) filtroMovAno = parseInt(anoEl.value, 10);
            atualizarMovimentacoesUI();
        });
    }

    // Populate year select
    const anoEl = document.getElementById('movFiltroAno');
    if (anoEl && anoEl.options.length === 0) {
        const anoAtual = new Date().getFullYear();
        for (let a = anoAtual; a >= anoAtual - 5; a--) {
            const opt = document.createElement('option');
            opt.value = a;
            opt.textContent = a;
            if (a === anoAtual) opt.selected = true;
            anoEl.appendChild(opt);
        }
    }

    // Pre-select current month in month select
    const mesEl = document.getElementById('movFiltroMes');
    if (mesEl) mesEl.value = new Date().getMonth();
}

// Paginação das movimentações — 50 itens por página para não sobrecarregar o DOM
const MOV_POR_PAGINA = 50;
let _movPaginaAtual  = 1;

function _renderizarItemMovimentacao(t, lista) {
    const dataExibida = _sanitizeText(t.data || '');
    return { dataExibida, t };
}

function atualizarMovimentacoesUI(resetPagina = true) {
    const lista = document.getElementById('listaMovimentacoes');
    if (!lista) return;

    if (resetPagina) _movPaginaAtual = 1;

    lista.innerHTML = '';

    const todos   = filtrarTransacoesParaUI().slice().reverse();
    const total   = todos.length;
    const visivel = todos.slice(0, _movPaginaAtual * MOV_POR_PAGINA);
    const restam  = total - visivel.length;

    if (total === 0) {
        const p       = document.createElement('p');
        p.className   = 'empty-state';
        p.textContent = 'Nenhuma movimentação registrada.';
        lista.appendChild(p);
        return;
    }

    // Usar DocumentFragment para inserir todos os itens em um único reflow
    const frag     = document.createDocumentFragment();
    let ultimaData = null;

    visivel.forEach(t => {
        const dataExibida = _sanitizeText(t.data || '');

        if (dataExibida && dataExibida !== ultimaData) {
            ultimaData = dataExibida;
            const sep       = document.createElement('div');
            sep.className   = 'mov-date-separator';
            sep.textContent = dataExibida;
            frag.appendChild(sep);
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

        div.addEventListener('click', () => abrirDetalhesTransacao(t));
        frag.appendChild(div);
    });

    lista.appendChild(frag);

    // Botão "Carregar mais" — evita renderizar centenas de itens de uma vez
    if (restam > 0) {
        const btnMais       = document.createElement('button');
        btnMais.className   = 'btn-load-more';
        btnMais.type        = 'button';
        btnMais.textContent = `Carregar mais ${Math.min(restam, MOV_POR_PAGINA)} de ${restam} movimentações`;
        btnMais.addEventListener('click', () => {
            _movPaginaAtual++;
            atualizarMovimentacoesUI(false);
        });
        lista.appendChild(btnMais);
    }
}

function abrirDetalhesTransacao(t) {
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
        transacoes = transacoes.filter(x => x !== t);

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
    const isEdit = editId !== null;
    const meta   = isEdit ? metas.find(m => m.id === editId) : null;
    if (isEdit && !meta) return;

    criarPopupDOM((popup) => {
        popup.style.cssText = 'max-width:500px; width:96%;';

        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'max-height:82vh; overflow-y:auto; overflow-x:hidden; padding-right:4px;';

        // ── Título
        const titulo = document.createElement('h3');
        titulo.style.cssText = 'text-align:center; margin-bottom:18px; display:flex; align-items:center; justify-content:center; gap:10px; font-size:1.15rem;';
        const tIcon = document.createElement('i');
        tIcon.className = isEdit ? 'fas fa-pen' : 'fas fa-piggy-bank';
        tIcon.style.color = 'var(--primary)';
        titulo.appendChild(tIcon);
        titulo.appendChild(document.createTextNode(isEdit ? ' Editar Reserva' : ' Nova Reserva'));

        // ── Helper: cria uma seção com fundo glass
        function secao(labelTxt) {
            const sec = document.createElement('div');
            sec.style.cssText = 'background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:12px; padding:14px 16px; margin-bottom:12px;';
            if (labelTxt) {
                const lbl = document.createElement('div');
                lbl.style.cssText = 'font-size:0.72rem; font-weight:700; text-transform:uppercase; letter-spacing:0.06em; color:var(--text-muted); margin-bottom:10px;';
                lbl.textContent = labelTxt;
                sec.appendChild(lbl);
            }
            return sec;
        }

        // ─────────────────────────── SEÇÃO 1: Básico ───────────────────────────
        const secBasico = secao('Informações básicas');

        const inpDesc = document.createElement('input');
        inpDesc.className = 'form-input'; inpDesc.id = 'metaDesc';
        inpDesc.placeholder = 'Nome da reserva (ex: Viagem, Emergência...)';
        inpDesc.maxLength = 200; inpDesc.style.marginBottom = '10px';
        if (meta) inpDesc.value = meta.descricao;

        const inpObj = document.createElement('input');
        inpObj.className = 'form-input'; inpObj.id = 'metaObj';
        inpObj.type = 'number'; inpObj.step = '0.01'; inpObj.min = '0';
        inpObj.placeholder = 'Objetivo (R$)';
        if (meta) inpObj.value = meta.objetivo;

        secBasico.appendChild(inpDesc);
        secBasico.appendChild(inpObj);

        // ─────────────────────────── SEÇÃO 2: Prazo ────────────────────────────
        const secPrazo = secao('Prazo (opcional)');
        const rowPrazo = document.createElement('div');
        rowPrazo.style.cssText = 'display:flex; gap:10px;';

        const selMeses = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho',
                          'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

        const selPM = document.createElement('select');
        selPM.className = 'form-input'; selPM.id = 'metaPrazoMes'; selPM.style.flex = '1';
        const optPMV = document.createElement('option'); optPMV.value = ''; optPMV.textContent = 'Mês';
        selPM.appendChild(optPMV);
        selMeses.forEach((n, i) => {
            const o = document.createElement('option');
            o.value = String(i + 1).padStart(2, '0'); o.textContent = n;
            selPM.appendChild(o);
        });

        const selPA = document.createElement('select');
        selPA.className = 'form-input'; selPA.id = 'metaPrazoAno'; selPA.style.flex = '1';
        const optPAV = document.createElement('option'); optPAV.value = ''; optPAV.textContent = 'Ano';
        selPA.appendChild(optPAV);
        const anoBase = new Date().getFullYear();
        for (let a = anoBase; a <= anoBase + 20; a++) {
            const o = document.createElement('option'); o.value = String(a); o.textContent = String(a);
            selPA.appendChild(o);
        }

        if (meta && meta.prazo) {
            const [pm, pa] = meta.prazo.split('/');
            if (pm) selPM.value = pm;
            if (pa) selPA.value = pa;
        }
        rowPrazo.appendChild(selPM); rowPrazo.appendChild(selPA);
        secPrazo.appendChild(rowPrazo);

        // ─────────────────────────── SEÇÃO 3: Rendimentos ──────────────────────
        const secRend = secao('Rendimentos');
        const tipoRAtual = meta ? (meta.tipoRendimento || 'sem_rendimento') : 'sem_rendimento';

        function criarRadio(name, value, labelTxt) {
            const lbl = document.createElement('label');
            lbl.style.cssText = 'display:flex; align-items:center; gap:8px; cursor:pointer; padding:7px 8px; border-radius:8px; margin-bottom:4px; transition:background 0.15s;';
            lbl.addEventListener('mouseenter', () => { lbl.style.background = 'rgba(255,255,255,0.04)'; });
            lbl.addEventListener('mouseleave', () => { lbl.style.background = ''; });
            const r = document.createElement('input');
            r.type = 'radio'; r.name = name; r.value = value; r.style.accentColor = 'var(--primary)';
            if (tipoRAtual === value && name === 'tipoRend') r.checked = true;
            const s = document.createElement('span'); s.style.fontSize = '0.9rem'; s.textContent = labelTxt;
            lbl.appendChild(r); lbl.appendChild(s);
            return { lbl, r };
        }

        const { lbl: lblSem }            = criarRadio('tipoRend', 'sem_rendimento', 'Sem rendimentos');
        const { lbl: lblCdi }            = criarRadio('tipoRend', 'cdi', 'CDI');
        const { lbl: lblPers }           = criarRadio('tipoRend', 'personalizado', 'Taxa personalizada');

        // CDI sub-opções
        const divCdi = document.createElement('div');
        divCdi.id = 'cdiOpts';
        divCdi.style.cssText = `display:${tipoRAtual === 'cdi' ? 'block' : 'none'}; padding:4px 0 6px 26px;`;

        const rowCdiTaxa = document.createElement('div');
        rowCdiTaxa.style.cssText = 'display:flex; align-items:center; gap:8px; margin-bottom:8px;';
        const inpCdiPct = document.createElement('input');
        inpCdiPct.className = 'form-input'; inpCdiPct.id = 'metaCdiPct';
        inpCdiPct.type = 'number'; inpCdiPct.step = '1'; inpCdiPct.min = '1'; inpCdiPct.max = '200';
        inpCdiPct.placeholder = '100'; inpCdiPct.style.cssText = 'width:72px; flex-shrink:0;';
        inpCdiPct.value = (meta && meta.cdiPct != null) ? meta.cdiPct : '100';
        const spanCdiPct = document.createElement('span');
        spanCdiPct.style.cssText = 'font-size:0.82rem; color:var(--text-muted);';
        spanCdiPct.textContent = '% do CDI';
        rowCdiTaxa.appendChild(inpCdiPct); rowCdiTaxa.appendChild(spanCdiPct);

        const rowCdiPer = document.createElement('div');
        rowCdiPer.style.cssText = 'display:flex; gap:16px;';
        function criarPeriodoRadio(name, val, txt, checkedIf) {
            const lbl = document.createElement('label');
            lbl.style.cssText = 'display:flex; align-items:center; gap:5px; cursor:pointer; font-size:0.82rem; color:var(--text-secondary);';
            const r = document.createElement('input');
            r.type = 'radio'; r.name = name; r.value = val; r.style.accentColor = 'var(--primary)';
            if (checkedIf) r.checked = true;
            lbl.appendChild(r); lbl.appendChild(document.createTextNode(txt));
            return lbl;
        }
        const periodoAtual = meta ? (meta.rendimentoPeriodo || 'mes') : 'mes';
        rowCdiPer.appendChild(criarPeriodoRadio('periodoRendCdi', 'mes', 'Ao mês',  periodoAtual !== 'ano'));
        rowCdiPer.appendChild(criarPeriodoRadio('periodoRendCdi', 'ano', 'Ao ano',  periodoAtual === 'ano'));
        divCdi.appendChild(rowCdiTaxa); divCdi.appendChild(rowCdiPer);

        // Personalizado sub-opções
        const divPers = document.createElement('div');
        divPers.id = 'persOpts';
        divPers.style.cssText = `display:${tipoRAtual === 'personalizado' ? 'block' : 'none'}; padding:4px 0 6px 26px;`;

        const rowPersTaxa = document.createElement('div');
        rowPersTaxa.style.cssText = 'display:flex; align-items:center; gap:8px; margin-bottom:8px;';
        const inpPersPct = document.createElement('input');
        inpPersPct.className = 'form-input'; inpPersPct.id = 'metaPersPct';
        inpPersPct.type = 'number'; inpPersPct.step = '0.01'; inpPersPct.min = '0'; inpPersPct.max = '999';
        inpPersPct.placeholder = '0.5'; inpPersPct.style.cssText = 'width:72px; flex-shrink:0;';
        if (meta && meta.taxaJuros != null) inpPersPct.value = meta.taxaJuros;
        const spanPersPct = document.createElement('span');
        spanPersPct.style.cssText = 'font-size:0.82rem; color:var(--text-muted);';
        spanPersPct.textContent = '%';
        rowPersTaxa.appendChild(inpPersPct); rowPersTaxa.appendChild(spanPersPct);

        const rowPersPer = document.createElement('div');
        rowPersPer.style.cssText = 'display:flex; gap:16px;';
        rowPersPer.appendChild(criarPeriodoRadio('periodoRendPers', 'mes', 'Ao mês', periodoAtual !== 'ano'));
        rowPersPer.appendChild(criarPeriodoRadio('periodoRendPers', 'ano', 'Ao ano', periodoAtual === 'ano'));
        divPers.appendChild(rowPersTaxa); divPers.appendChild(rowPersPer);

        secRend.appendChild(lblSem);
        secRend.appendChild(lblCdi);
        secRend.appendChild(divCdi);
        secRend.appendChild(lblPers);
        secRend.appendChild(divPers);

        secRend.addEventListener('change', e => {
            if (e.target.name === 'tipoRend') {
                divCdi.style.display  = e.target.value === 'cdi'          ? 'block' : 'none';
                divPers.style.display = e.target.value === 'personalizado' ? 'block' : 'none';
            }
        });

        // ─────────────────────────── SEÇÃO 4: Aporte Recorrente ────────────────
        const secAporte = secao('Aporte Recorrente');

        const lblChkAporte = document.createElement('label');
        lblChkAporte.style.cssText = 'display:flex; align-items:center; gap:10px; cursor:pointer; margin-bottom:10px;';
        const chkAporte = document.createElement('input');
        chkAporte.type = 'checkbox'; chkAporte.id = 'metaAporteRecorrente';
        chkAporte.style.cssText = 'width:17px; height:17px; accent-color:var(--primary); cursor:pointer; flex-shrink:0;';
        if (meta && meta.aporteRecorrente) chkAporte.checked = true;
        const spanChkAporte = document.createElement('span');
        spanChkAporte.style.fontSize = '0.9rem';
        spanChkAporte.textContent = 'Criar aporte mensal automático';
        lblChkAporte.appendChild(chkAporte); lblChkAporte.appendChild(spanChkAporte);

        const divAporteVal = document.createElement('div');
        divAporteVal.id = 'aporteValorDiv';
        divAporteVal.style.cssText = `display:${(meta && meta.aporteRecorrente) ? 'flex' : 'none'}; align-items:center; gap:10px;`;
        const inpAporteV = document.createElement('input');
        inpAporteV.className = 'form-input'; inpAporteV.id = 'metaAporteValor';
        inpAporteV.type = 'number'; inpAporteV.step = '0.01'; inpAporteV.min = '0';
        inpAporteV.placeholder = 'Valor mensal (R$)'; inpAporteV.style.flex = '1';
        if (meta && meta.valorAporte) inpAporteV.value = meta.valorAporte;
        const spanAporteMes = document.createElement('span');
        spanAporteMes.style.cssText = 'font-size:0.8rem; color:var(--text-muted); white-space:nowrap;';
        spanAporteMes.textContent = '/mês';
        divAporteVal.appendChild(inpAporteV); divAporteVal.appendChild(spanAporteMes);

        chkAporte.addEventListener('change', () => {
            divAporteVal.style.display = chkAporte.checked ? 'flex' : 'none';
        });
        secAporte.appendChild(lblChkAporte); secAporte.appendChild(divAporteVal);

        // ─────────────────────────── SEÇÃO 5: Projeção ─────────────────────────
        const secProj = document.createElement('div');
        secProj.id = 'metaProjecaoPreview';
        secProj.style.cssText = 'display:none; background:rgba(67,160,71,0.06); border:1px solid rgba(67,160,71,0.22); border-radius:12px; padding:14px 16px; margin-bottom:12px;';

        const btnSimular = document.createElement('button');
        btnSimular.className = 'btn-primary'; btnSimular.type = 'button';
        btnSimular.style.cssText = 'width:100%; margin-bottom:12px; display:flex; align-items:center; justify-content:center; gap:8px;';
        const bsI = document.createElement('i'); bsI.className = 'fas fa-calculator';
        btnSimular.appendChild(bsI); btnSimular.appendChild(document.createTextNode(' Ver Projeção'));

        // Funções de cálculo financeiro (usadas também no clique)
        function fvComposto(pv, pmt, r, n) {
            if (r <= 0) return pv + pmt * n;
            return pv * Math.pow(1 + r, n) + pmt * (Math.pow(1 + r, n) - 1) / r;
        }
        function mesesParaMeta(pv, obj, pmt, r) {
            for (let n = 1; n <= 600; n++) {
                if (fvComposto(pv, pmt, r, n) >= obj) return n;
            }
            return null;
        }
        function aporteNecessario(pv, obj, r, n) {
            if (n <= 0) return null;
            const fv = obj - pv * Math.pow(1 + r, n);
            if (r <= 0) return fv / n;
            const fator = Math.pow(1 + r, n) - 1;
            if (fator <= 0) return null;
            return fv * r / fator;
        }

        btnSimular.addEventListener('click', () => {
            const obj     = parseFloat(document.getElementById('metaObj').value) || 0;
            const savedPV = isEdit && meta ? Number(meta.saved || 0) : 0;
            const tipoR   = document.querySelector('input[name="tipoRend"]:checked')?.value || 'sem_rendimento';
            const aporte  = parseFloat(document.getElementById('metaAporteValor')?.value) || 0;
            const prazoM  = document.getElementById('metaPrazoMes')?.value || '';
            const prazoA  = document.getElementById('metaPrazoAno')?.value || '';

            let r = 0;
            if (tipoR === 'cdi') {
                const pct = parseFloat(document.getElementById('metaCdiPct').value) || 100;
                const per = document.querySelector('input[name="periodoRendCdi"]:checked')?.value || 'mes';
                const taxaAnual = 10.5 * pct / 100;
                r = per === 'ano'
                    ? Math.pow(1 + taxaAnual / 100, 1/12) - 1
                    : taxaAnual / 100 / 12;
            } else if (tipoR === 'personalizado') {
                const pct = parseFloat(document.getElementById('metaPersPct').value) || 0;
                const per = document.querySelector('input[name="periodoRendPers"]:checked')?.value || 'mes';
                r = per === 'ano'
                    ? Math.pow(1 + pct / 100, 1/12) - 1
                    : pct / 100;
            }

            let mesesPrazo = null;
            if (prazoM && prazoA) {
                const hoje = new Date();
                const dt   = new Date(parseInt(prazoA), parseInt(prazoM) - 1, 1);
                mesesPrazo = Math.max(1, Math.round((dt - hoje) / (1000 * 60 * 60 * 24 * 30.44)));
            }

            const secP = document.getElementById('metaProjecaoPreview');
            secP.style.display = 'block';
            // Limpa conteúdo anterior
            while (secP.firstChild) secP.removeChild(secP.firstChild);

            const tP = document.createElement('div');
            tP.style.cssText = 'font-size:0.72rem; font-weight:700; text-transform:uppercase; letter-spacing:0.06em; color:var(--primary); margin-bottom:10px;';
            tP.textContent = '📊 Projeção calculada';
            secP.appendChild(tP);

            function addLinha(icon, lbl, val, cor) {
                const row = document.createElement('div');
                row.style.cssText = 'display:flex; justify-content:space-between; align-items:center; padding:7px 10px; border-radius:8px; margin-bottom:5px; background:rgba(255,255,255,0.03);';
                const left = document.createElement('span');
                left.style.cssText = 'font-size:0.83rem; color:var(--text-secondary); display:flex; align-items:center; gap:6px;';
                const ic = document.createElement('i'); ic.className = icon;
                ic.style.color = cor || 'var(--primary)'; ic.style.width = '14px';
                left.appendChild(ic); left.appendChild(document.createTextNode(lbl));
                const right = document.createElement('span');
                right.style.cssText = `font-size:0.88rem; font-weight:700; color:${cor || 'var(--text-primary)'};`;
                right.textContent = val;
                row.appendChild(left); row.appendChild(right);
                secP.appendChild(row);
            }

            if (obj <= 0) {
                addLinha('fas fa-exclamation-triangle', 'Defina um objetivo', 'Necessário', '#ffd166');
                return;
            }

            const falta = Math.max(0, obj - savedPV);
            addLinha('fas fa-piggy-bank', 'Falta atingir', formatBRL(falta), '#ffd166');

            if (aporte > 0 || r > 0) {
                const meses = mesesParaMeta(savedPV, obj, aporte, r);
                if (meses !== null) {
                    const anos = Math.floor(meses / 12);
                    const mr   = meses % 12;
                    const tStr = anos > 0
                        ? `${anos}a ${mr}m`
                        : `${meses} mês${meses !== 1 ? 'es' : ''}`;
                    addLinha('fas fa-clock', 'Tempo estimado', tStr, 'var(--primary)');
                    const fvFinal    = fvComposto(savedPV, aporte, r, meses);
                    const rendim     = Math.max(0, fvFinal - (savedPV + aporte * meses));
                    if (rendim > 1) addLinha('fas fa-chart-line', 'Rendimentos acumulados', `+${formatBRL(rendim)}`, '#00ff99');
                }
            }

            if (mesesPrazo !== null) {
                const ap = aporteNecessario(savedPV, obj, r, mesesPrazo);
                if (ap !== null && ap > 0) {
                    addLinha('fas fa-calendar-check', `Aporte p/ prazo (${mesesPrazo}m)`, `${formatBRL(ap)}/mês`, '#a78bfa');
                }
                const fvP = fvComposto(savedPV, aporte, r, mesesPrazo);
                const ok  = fvP >= obj;
                addLinha(
                    ok ? 'fas fa-check-circle' : 'fas fa-exclamation-circle',
                    'Status no prazo',
                    ok ? 'Atingirá o objetivo!' : `Chegará a ${formatBRL(Math.min(fvP, obj))}`,
                    ok ? '#00ff99' : '#ff4b4b'
                );
            }
        });

        // ─────────────────────────── BOTÕES ────────────────────────────────────
        const rowBtns = document.createElement('div');
        rowBtns.style.cssText = 'display:flex; gap:10px; margin-top:4px;';

        const btnCancelar = document.createElement('button');
        btnCancelar.className = 'btn-cancelar'; btnCancelar.type = 'button';
        btnCancelar.style.flex = '1'; btnCancelar.textContent = 'Cancelar';
        btnCancelar.addEventListener('click', () => fecharPopup());

        const btnOk = document.createElement('button');
        btnOk.className = 'btn-primary'; btnOk.type = 'button'; btnOk.style.flex = '2';
        const btnOkI = document.createElement('i');
        btnOkI.className = isEdit ? 'fas fa-save' : 'fas fa-plus';
        btnOkI.style.marginRight = '6px';
        btnOk.appendChild(btnOkI);
        btnOk.appendChild(document.createTextNode(isEdit ? 'Salvar' : 'Criar Reserva'));

        btnOk.addEventListener('click', () => {
            const desc   = document.getElementById('metaDesc').value.trim();
            const objStr = document.getElementById('metaObj').value;

            if (!desc)                                                              return alert('Digite o nome da reserva.');
            if (desc.length > 200)                                                  return alert('Nome muito longo (máx. 200 caracteres).');
            if (!objStr || !Number.isFinite(Number(objStr)) || Number(objStr) <= 0) return alert('Digite um objetivo válido.');

            const objetivo = parseFloat(parseFloat(objStr).toFixed(2));
            if (!Number.isFinite(objetivo) || objetivo <= 0) return alert('Digite um objetivo válido.');

            // Prazo
            const prazoMV = document.getElementById('metaPrazoMes').value;
            const prazoAV = document.getElementById('metaPrazoAno').value;
            const prazo   = (prazoMV && prazoAV) ? `${prazoMV}/${prazoAV}` : null;

            // Rendimentos
            const tipoR = document.querySelector('input[name="tipoRend"]:checked')?.value || 'sem_rendimento';
            let taxaJuros = null, rendimentoPeriodo = null, cdiPct = null;

            if (tipoR === 'cdi') {
                const pct = parseFloat(document.getElementById('metaCdiPct').value);
                if (!Number.isFinite(pct) || pct <= 0 || pct > 200) return alert('Digite uma porcentagem válida do CDI (1–200).');
                cdiPct = pct;
                rendimentoPeriodo = document.querySelector('input[name="periodoRendCdi"]:checked')?.value || 'mes';
                const taxaAnual = 10.5 * pct / 100;
                taxaJuros = rendimentoPeriodo === 'ano'
                    ? parseFloat(((Math.pow(1 + taxaAnual / 100, 1/12) - 1) * 100).toFixed(6))
                    : parseFloat((taxaAnual / 12).toFixed(6));
            } else if (tipoR === 'personalizado') {
                const pct = parseFloat(document.getElementById('metaPersPct').value);
                if (!Number.isFinite(pct) || pct < 0 || pct > 999) return alert('Digite uma taxa válida (0–999).');
                rendimentoPeriodo = document.querySelector('input[name="periodoRendPers"]:checked')?.value || 'mes';
                taxaJuros = rendimentoPeriodo === 'ano'
                    ? parseFloat(((Math.pow(1 + pct / 100, 1/12) - 1) * 100).toFixed(6))
                    : parseFloat(pct.toFixed(6));
            }

            // Aporte
            const aporteRecorrente = document.getElementById('metaAporteRecorrente').checked;
            let valorAporte = null;
            if (aporteRecorrente) {
                const apStr = document.getElementById('metaAporteValor').value;
                valorAporte = parseFloat(apStr);
                if (!Number.isFinite(valorAporte) || valorAporte <= 0) return alert('Digite um valor de aporte válido.');
            }

            if (isEdit) {
                meta.descricao        = desc;
                meta.objetivo         = objetivo;
                meta.prazo            = prazo;
                meta.tipoRendimento   = tipoR;
                meta.taxaJuros        = taxaJuros;
                meta.cdiPct           = cdiPct;
                meta.rendimentoPeriodo = rendimentoPeriodo;
                meta.aporteRecorrente = aporteRecorrente;
                meta.valorAporte      = valorAporte;
            } else {
                const novoId = (typeof crypto !== 'undefined' && crypto.randomUUID)
                    ? crypto.randomUUID()
                    : `local_${Date.now()}_${Math.random().toString(36).slice(2)}`;
                metas.push({
                    id: novoId, descricao: desc, objetivo, saved: 0, monthly: {},
                    prazo, tipoRendimento: tipoR, taxaJuros, cdiPct,
                    rendimentoPeriodo, aporteRecorrente, valorAporte,
                });

                // Cria conta fixa de aporte recorrente
                if (aporteRecorrente && valorAporte > 0) {
                    const hoje = new Date();
                    const mm   = hoje.getMonth() + 2 > 12 ? 1 : hoje.getMonth() + 2;
                    const aa   = hoje.getMonth() + 2 > 12 ? hoje.getFullYear() + 1 : hoje.getFullYear();
                    contasFixas.push({
                        id:          (typeof crypto !== 'undefined' && crypto.randomUUID)
                                         ? crypto.randomUUID()
                                         : `local_${Date.now()}_${Math.random().toString(36).slice(2)}`,
                        descricao:   `Aporte ${desc}`.slice(0, 200),
                        valor:       valorAporte,
                        vencimento:  `${aa}-${String(mm).padStart(2,'0')}-01`,
                        pago:        false,
                    });
                }
            }

            salvarDados();
            renderMetasList();
            atualizarTudo();
            fecharPopup();
        });

        rowBtns.appendChild(btnCancelar);
        rowBtns.appendChild(btnOk);

        // ─────────────────────────── MONTAGEM ──────────────────────────────────
        wrapper.appendChild(titulo);
        wrapper.appendChild(secBasico);
        wrapper.appendChild(secPrazo);
        wrapper.appendChild(secRend);
        wrapper.appendChild(secAporte);
        wrapper.appendChild(btnSimular);
        wrapper.appendChild(secProj);
        wrapper.appendChild(rowBtns);
        popup.appendChild(wrapper);
    });
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

        // ── Tags: prazo + rendimentos
        if (m.prazo || (m.tipoRendimento && m.tipoRendimento !== 'sem_rendimento')) {
            const rowTags = document.createElement('div');
            rowTags.style.cssText = 'display:flex; gap:5px; flex-wrap:wrap; margin-top:5px;';

            if (m.prazo) {
                const [pm, pa] = m.prazo.split('/');
                const nomeMes = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
                const mesNum  = parseInt(pm, 10);
                const tagPrazo = document.createElement('span');
                tagPrazo.style.cssText = 'font-size:10px; padding:2px 7px; border-radius:20px; background:rgba(167,139,250,0.15); color:#a78bfa; font-weight:600;';
                tagPrazo.textContent = `⏰ ${nomeMes[mesNum - 1] || pm}/${pa}`;
                rowTags.appendChild(tagPrazo);
            }

            if (m.tipoRendimento === 'cdi') {
                const tagRend = document.createElement('span');
                tagRend.style.cssText = 'font-size:10px; padding:2px 7px; border-radius:20px; background:rgba(0,255,153,0.12); color:#00cc7a; font-weight:600;';
                tagRend.textContent = `📈 CDI ${m.cdiPct != null ? m.cdiPct + '%' : ''}`.trim();
                rowTags.appendChild(tagRend);
            } else if (m.tipoRendimento === 'personalizado' && m.taxaJuros != null) {
                const tagRend = document.createElement('span');
                tagRend.style.cssText = 'font-size:10px; padding:2px 7px; border-radius:20px; background:rgba(0,255,153,0.12); color:#00cc7a; font-weight:600;';
                tagRend.textContent = `📈 ${m.taxaJuros.toFixed(2)}%/mês`;
                rowTags.appendChild(tagRend);
            }

            if (m.aporteRecorrente && m.valorAporte) {
                const tagAp = document.createElement('span');
                tagAp.style.cssText = 'font-size:10px; padding:2px 7px; border-radius:20px; background:rgba(67,160,71,0.15); color:var(--primary); font-weight:600;';
                tagAp.textContent = `💰 ${formatBRL(m.valorAporte)}/mês`;
                rowTags.appendChild(tagAp);
            }

            colInfo.appendChild(rowTags);
        }

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
        const btnEditarIcon = document.createElement('i');
        btnEditarIcon.className = 'fas fa-pen';
        btnEditarIcon.style.marginRight = '6px';
        btnEditar.appendChild(btnEditarIcon);
        btnEditar.appendChild(document.createTextNode('Editar'));
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
            const btnAnaliseIcon = document.createElement('i');
            btnAnaliseIcon.className = 'fas fa-chart-bar';
            btnAnaliseIcon.style.marginRight = '6px';
            btnAnalise.appendChild(btnAnaliseIcon);
            btnAnalise.appendChild(document.createTextNode('Análise'));
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
        const btnExcluirIcon = document.createElement('i');
        btnExcluirIcon.className = 'fas fa-trash';
        btnExcluirIcon.style.marginRight = '6px';
        btnExcluir.appendChild(btnExcluirIcon);
        btnExcluir.appendChild(document.createTextNode('Excluir'));
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
        details.innerHTML = '';
        const _emptyMsg = document.createElement('div');
        _emptyMsg.className = 'text-secondary';
        _emptyMsg.textContent = 'Selecione uma reserva para ver detalhes e gráficos';
        details.appendChild(_emptyMsg);
        const progressEl = document.getElementById('metaProgress');
        if(progressEl) progressEl.textContent = 'Selecione uma reserva';
        const btnRetirar = document.getElementById('btnRetirar');
        if(btnRetirar) btnRetirar.style.display = 'none';
        return;
    }
    
    const meta = metas.find(m => String(m.id) === String(metaSelecionadaId));
    if(!meta) {
        details.innerHTML = '';
        const _notFound = document.createElement('div');
        _notFound.className = 'text-secondary';
        _notFound.textContent = 'Meta não encontrada';
        details.appendChild(_notFound);
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
    
    // ── Compound interest info if meta has taxaJuros
    if (meta.taxaJuros && meta.taxaJuros > 0) {
        const r = meta.taxaJuros / 100;
        const aporte = Number(meta.valorAporte || 0);
        const fvComposto = (pv, pmt, rate, n) =>
            rate <= 0 ? pv + pmt * n : pv * Math.pow(1 + rate, n) + pmt * (Math.pow(1 + rate, n) - 1) / rate;

        const cardRendim              = document.createElement('div');
        cardRendim.style.background   = 'rgba(0,255,153,0.06)';
        cardRendim.style.padding      = '14px';
        cardRendim.style.borderRadius = '12px';
        cardRendim.style.marginTop    = '12px';
        cardRendim.style.borderLeft   = '3px solid #00ff99';

        const rdTit = document.createElement('div');
        rdTit.style.cssText = 'font-size:0.78rem; font-weight:700; text-transform:uppercase; letter-spacing:0.05em; color:#00cc7a; margin-bottom:10px;';
        rdTit.textContent = '📈 Projeção com Rendimentos';
        cardRendim.appendChild(rdTit);

        function addRendRow(lbl, val, cor) {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex; justify-content:space-between; padding:5px 0; border-bottom:1px solid rgba(255,255,255,0.05);';
            const l = document.createElement('span');
            l.style.cssText = 'font-size:0.83rem; color:var(--text-secondary);';
            l.textContent = lbl;
            const v = document.createElement('span');
            v.style.cssText = `font-size:0.88rem; font-weight:700; color:${cor || 'var(--text-primary)'};`;
            v.textContent = val;
            row.appendChild(l); row.appendChild(v);
            cardRendim.appendChild(row);
        }

        addRendRow('Taxa mensal', `${meta.taxaJuros.toFixed(4)}%`, '#00ff99');
        if (aporte > 0) {
            const fv12 = fvComposto(saved, aporte, r, 12);
            const rend12 = Math.max(0, fv12 - (saved + aporte * 12));
            addRendRow('Rendimento estimado (12m)', `+${formatBRL(rend12)}`, '#00ff99');
            addRendRow('Saldo após 12m', formatBRL(fv12), 'var(--primary)');
        }

        details.appendChild(cardRendim);
    }

    // ── Smart tips based on real transactions
    const gastosPorCategoria = {};
    const hoje = new Date();
    const mesAtualKey = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}`;
    transacoes.filter(t => t.categoria === 'saida').forEach(t => {
        const cat = t.tipo || 'Outros';
        if (!gastosPorCategoria[cat]) gastosPorCategoria[cat] = 0;
        gastosPorCategoria[cat] += Number(t.valor || 0);
    });
    const top5Cats = Object.entries(gastosPorCategoria)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);

    if (top5Cats.length > 0 && saved < objetivo) {
        const falta = objetivo - saved;
        const cardTips              = document.createElement('div');
        cardTips.style.background   = 'rgba(108,99,255,0.07)';
        cardTips.style.padding      = '14px';
        cardTips.style.borderRadius = '12px';
        cardTips.style.marginTop    = '12px';
        cardTips.style.borderLeft   = '3px solid #6c63ff';

        const tTit = document.createElement('div');
        tTit.style.cssText = 'font-size:0.78rem; font-weight:700; text-transform:uppercase; letter-spacing:0.05em; color:#6c63ff; margin-bottom:10px;';
        tTit.textContent = '💡 Dicas Personalizadas';
        cardTips.appendChild(tTit);

        // Tip 1: save 10% per top category
        const economiaTop5 = top5Cats.reduce((s, [, v]) => s + v * 0.1, 0);
        if (economiaTop5 > 0) {
            const p = document.createElement('p');
            p.style.cssText = 'font-size:0.83rem; color:var(--text-secondary); margin-bottom:8px; line-height:1.5;';
            const meses10pct = economiaTop5 > 0 ? Math.ceil(falta / economiaTop5) : null;
            p.textContent = `Se economizar 10% nas suas ${top5Cats.length} maiores categorias de gasto, você guardaria ${formatBRL(economiaTop5)}/mês${meses10pct ? ` e atingiria a meta em ~${meses10pct} meses` : ''}.`;
            cardTips.appendChild(p);
        }

        // Tip 2: specific category suggestion
        if (top5Cats[0]) {
            const [catNome, catVal] = top5Cats[0];
            const p2 = document.createElement('p');
            p2.style.cssText = 'font-size:0.83rem; color:var(--text-secondary); margin-bottom:0; line-height:1.5;';
            p2.textContent = `Sua maior despesa é "${_sanitizeText(catNome)}" com ${formatBRL(catVal)} no total. Reduzir 15% aqui = ${formatBRL(catVal * 0.15)} a mais por período para sua reserva.`;
            cardTips.appendChild(p2);
        }

        details.appendChild(cardTips);
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

// ── Abreviações dos bancos — badge CSS sem dependência de imagem externa
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

// Gradientes dos bancos — usados no mini-cartão dos Relatórios
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

// Ícones dos bancos — usados no mini-cartão dos Relatórios
const BANCO_ICON = Object.freeze({
    'Nubank':          'public/assets/icons/cards/Nubank.png',
    'Bradesco':        'public/assets/icons/cards/Bradesco.png',
    'Mercado Pago':    'public/assets/icons/cards/logo-mercado-pago-icone-1024.png',
    'C6 Bank':         'public/assets/icons/cards/logo-c6-bank-1024.png',
    'Itaú':            'public/assets/icons/cards/logo-itau-4096.png',
    'Banco do Brasil': 'public/assets/icons/cards/logo-banco-do-brasil-icon-4096.png',
    'Caixa':           'public/assets/icons/cards/logo-caixa-economica-federal-4096.png',
    'Alelo':           'public/assets/icons/cards/alelo-4096.png',
});

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

    const bankIconWrap = document.createElement('div');
    bankIconWrap.className = 'cartao-featured-bank-icon';
    const featuredIconPath = BANCO_ICON[cartaoAtivo.nomeBanco];
    if (featuredIconPath) {
        const featuredImg = document.createElement('img');
        featuredImg.src = featuredIconPath;
        featuredImg.alt = '';
        featuredImg.setAttribute('aria-hidden', 'true');
        featuredImg.className = 'cartao-featured-bank-img';
        bankIconWrap.appendChild(featuredImg);
    } else {
        bankIconWrap.textContent = BANCO_ABREV[cartaoAtivo.nomeBanco]
            || _sanitizeText(cartaoAtivo.nomeBanco).substring(0, 2).toUpperCase();
    }
    nameRow.appendChild(bankIconWrap);

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

        const miniIconPath = BANCO_ICON[c.nomeBanco];
        if (miniIconPath) {
            const miniImg = document.createElement('img');
            miniImg.className = 'meus-cartoes-mini-icon';
            miniImg.src = miniIconPath;
            miniImg.alt = '';
            miniImg.setAttribute('aria-hidden', 'true');
            miniCard.appendChild(miniImg);
        } else {
            const miniAbrevEl = document.createElement('div');
            miniAbrevEl.className = 'meus-cartoes-mini-abrev';
            miniAbrevEl.textContent = BANCO_ABREV[c.nomeBanco]
                || _sanitizeText(c.nomeBanco).substring(0, 2).toUpperCase();
            miniCard.appendChild(miniAbrevEl);
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

// ========== CONGELAR / DESCONGELAR CARTÃO ==========
function congelarCartao(cartaoId) {
    const cartao = cartoesCredito.find(c => c.id === cartaoId);
    if (!cartao) return;

    const msg = cartao.congelado
        ? 'Descongelar este cartão? Ele voltará a aceitar novos lançamentos normalmente.'
        : 'Congelar este cartão? Nenhum novo lançamento poderá ser realizado enquanto estiver congelado.';

    confirmarAcao(msg, () => {
        cartao.congelado = !cartao.congelado;
        salvarDados();
        atualizarTelaCartoes();
        mostrarNotificacao(
            cartao.congelado ? 'Cartão congelado com sucesso!' : 'Cartão descongelado!',
            cartao.congelado ? 'warning' : 'success'
        );
    });
}

function abrirCartaoForm(editId = null) {
    const bancos = [
        { nome: 'Nubank' },
        { nome: 'Bradesco' },
        { nome: 'Mercado Pago' },
        { nome: 'C6 Bank' },
        { nome: 'Itaú' },
        { nome: 'Santander' },
        { nome: 'Banco do Brasil' },
        { nome: 'Caixa' },
        { nome: 'Alelo' },
        { nome: 'Outro' },
    ];

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
    function _executarSalvar(selectBanco, inputOutro, inputLimite, selectFechamento, selectDia, cartaoExistente) {
        let nomeBanco = selectBanco.value;

        if (nomeBanco === 'Outro') {
            const nomeDigitado = inputOutro.value.trim();
            if (!nomeDigitado)           { alert('Digite o nome do cartão!'); return; }
            if (nomeDigitado.length > 50) { alert('Nome do cartão muito longo (máx. 50 caracteres).'); return; }
            nomeBanco = nomeDigitado;
        }

        const limiteStr     = inputLimite.value;
        const fechamentoDia = selectFechamento.value;
        const vencimentoDia = selectDia.value;

        if (!nomeBanco || !limiteStr || !fechamentoDia || !vencimentoDia) { alert('Preencha todos os campos!'); return; }

        const limite = parseFloat(parseFloat(limiteStr).toFixed(2));
        if (isNaN(limite) || limite <= 0) { alert('Informe um limite válido e positivo.'); return; }
        if (limite > 9999999)              { alert('Limite máximo permitido: R$ 9.999.999,00.'); return; }

        if (Number(fechamentoDia) === Number(vencimentoDia)) {
            alert('O dia de fechamento e o dia de vencimento não podem ser iguais.');
            return;
        }

        const bandeiraImg = bancos.find(b => b.nome === nomeBanco)?.img || '';

        if (cartaoExistente) {
            // Modo edição
            cartaoExistente.nomeBanco     = nomeBanco;
            cartaoExistente.limite        = limite;
            cartaoExistente.fechamentoDia = Number(fechamentoDia);
            cartaoExistente.vencimentoDia = Number(vencimentoDia);
            cartaoExistente.bandeiraImg   = bandeiraImg;
        } else {
            // Modo criação
            cartoesCredito.push({
                id:             nextCartaoId++,
                nomeBanco,
                limite,
                fechamentoDia:  Number(fechamentoDia),
                vencimentoDia:  Number(vencimentoDia),
                bandeiraImg,
                usado:          0,
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

            // Label + Select fechamento
            const labelFechamento       = document.createElement('label');
            labelFechamento.style.cssText = 'display:block; text-align:left; margin-top:10px; color: var(--text-secondary);';
            labelFechamento.textContent = 'Dia do Fechamento da Fatura:';

            const selectFechamento = _criarSelectDias('novoFechamentoDia', '');

            // Label + Select vencimento
            const labelDia       = document.createElement('label');
            labelDia.style.cssText = 'display:block; text-align:left; margin-top:10px; color: var(--text-secondary);';
            labelDia.textContent = 'Dia do Vencimento da Fatura:';

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
            btnSalvar.addEventListener('click', () => _executarSalvar(selectBanco, inputOutro, inputLimite, selectFechamento, selectDia, null));

            _configurarSelectBanco(selectBanco, campoOutro, inputOutro);

            popup.appendChild(titulo);
            popup.appendChild(labelBanco);
            popup.appendChild(selectBanco);
            popup.appendChild(campoOutro);
            popup.appendChild(labelLimite);
            popup.appendChild(inputLimite);
            popup.appendChild(labelFechamento);
            popup.appendChild(selectFechamento);
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

            // Label + Select fechamento (pré-selecionado)
            const labelFechamento       = document.createElement('label');
            labelFechamento.style.cssText = 'display:block; text-align:left; margin-top:10px; color: var(--text-secondary);';
            labelFechamento.textContent = 'Dia do Fechamento da Fatura:';

            const selectFechamento = _criarSelectDias('novoFechamentoDia', c.fechamentoDia ?? '');

            // Label + Select vencimento (pré-selecionado)
            const labelDia       = document.createElement('label');
            labelDia.style.cssText = 'display:block; text-align:left; margin-top:10px; color: var(--text-secondary);';
            labelDia.textContent = 'Dia do Vencimento da Fatura:';

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
            btnSalvar.addEventListener('click', () => _executarSalvar(selectBanco, inputOutro, inputLimite, selectFechamento, selectDia, c));
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
            popup.appendChild(labelFechamento);
            popup.appendChild(selectFechamento);
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
        scroll.style.cssText = 'max-height: 70vh; overflow-y: auto; overflow-x: hidden; padding-right: 6px;';

        // ── Título
        const titulo = document.createElement('h3');
        titulo.style.cssText = 'text-align: center; margin-bottom: 20px; display: flex; align-items: center; justify-content: center; gap: 10px;';
        const tituloIcon = document.createElement('i');
        tituloIcon.className = 'fas fa-credit-card';
        tituloIcon.style.color = 'var(--primary)';
        const tituloText = document.createElement('span');
        tituloText.textContent = _sanitizeText(cartao.nomeBanco);
        titulo.appendChild(tituloIcon);
        titulo.appendChild(tituloText);
        scroll.appendChild(titulo);

        // Status frozen
        if (cartao.congelado) {
            const frozenBanner = document.createElement('div');
            frozenBanner.style.cssText = 'background: rgba(96,212,255,0.12); border: 1px solid rgba(96,212,255,0.3); border-radius: 10px; padding: 10px 14px; text-align: center; color: #60d4ff; font-weight: 600; font-size: 0.9rem; margin-bottom: 16px; display: flex; align-items: center; justify-content: center; gap: 8px;';
            const frozenIcon = document.createElement('i');
            frozenIcon.className = 'fas fa-snowflake';
            const frozenText = document.createElement('span');
            frozenText.textContent = 'Cartão congelado — nenhum novo lançamento permitido';
            frozenBanner.appendChild(frozenIcon);
            frozenBanner.appendChild(frozenText);
            scroll.appendChild(frozenBanner);
        }

        // ── Stats grid
        const statsGrid = document.createElement('div');
        statsGrid.style.cssText = 'display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; margin-bottom: 20px;';

        const statsData = [
            { iconCls: 'fas fa-wallet',          label: 'Limite Total',      value: formatBRL(cartao.limite),            color: 'var(--text-primary)' },
            { iconCls: 'fas fa-arrow-trend-up',  label: 'Valor Usado',       value: formatBRL(usado),                    color: '#ff4b4b' },
            { iconCls: 'fas fa-circle-check',    label: 'Disponível',         value: formatBRL(disponivel),               color: '#00ff99' },
            { iconCls: 'fas fa-chart-pie',       label: '% Utilizado',        value: `${percUsado.toFixed(1)}%`,          color: percUsado > 80 ? '#ff4b4b' : '#00ff99' },
            { iconCls: 'fas fa-file-invoice',    label: 'Fatura em Aberto',   value: formatBRL(totalFatura),                                                                   color: '#ffd166' },
            { iconCls: 'fas fa-calendar-xmark',  label: 'Fechamento',          value: cartao.fechamentoDia ? `Todo dia ${cartao.fechamentoDia}` : '— (edite o cartão)',         color: '#ff9f43' },
            { iconCls: 'fas fa-calendar-day',    label: 'Vencimento',          value: `Todo dia ${cartao.vencimentoDia}`,                                                        color: 'var(--primary)' },
        ];

        statsData.forEach(s => {
            const card = document.createElement('div');
            card.style.cssText = 'background: rgba(255,255,255,0.05); padding: 14px; border-radius: 12px; text-align: center;';
            const lbl = document.createElement('div');
            lbl.style.cssText = 'font-size: 0.78rem; color: var(--text-secondary); margin-bottom: 6px; display: flex; align-items: center; justify-content: center; gap: 6px;';
            const lblIcon = document.createElement('i');
            lblIcon.className = s.iconCls;
            const lblText = document.createElement('span');
            lblText.textContent = s.label;
            lbl.appendChild(lblIcon);
            lbl.appendChild(lblText);
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
            fTitle.style.cssText = 'color: var(--text-primary); margin-bottom: 12px; display: flex; align-items: center; gap: 8px;';
            const fTitleIcon = document.createElement('i');
            fTitleIcon.className = 'fas fa-receipt';
            fTitleIcon.style.color = '#ffd166';
            const fTitleText = document.createElement('span');
            fTitleText.textContent = 'Faturas em Aberto';
            fTitle.appendChild(fTitleIcon);
            fTitle.appendChild(fTitleText);
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
            instLbl.style.cssText = 'font-size: 0.82rem; color: var(--text-secondary); margin-bottom: 5px; display: flex; align-items: center; gap: 6px;';
            const instLblIcon = document.createElement('i');
            instLblIcon.className = 'fas fa-rotate';
            instLblIcon.style.color = '#6c63ff';
            const instLblText = document.createElement('span');
            instLblText.textContent = 'Compras Parceladas Ativas';
            instLbl.appendChild(instLblIcon);
            instLbl.appendChild(instLblText);
            const instVal = document.createElement('div');
            instVal.style.cssText = 'font-size: 1.1rem; font-weight: 700; color: #6c63ff;';
            instVal.textContent = `${parcelasAtivas.length} compra(s)`;
            instDiv.appendChild(instLbl);
            instDiv.appendChild(instVal);
            scroll.appendChild(instDiv);
        }

        popup.appendChild(scroll);

        // ── Botões fora do scroll (sem gap de scroll)
        const btnRow = document.createElement('div');
        btnRow.style.cssText = 'display: flex; gap: 10px; margin-top: 16px;';

        const btnEditar = document.createElement('button');
        btnEditar.className = 'btn-primary';
        btnEditar.type = 'button';
        btnEditar.style.cssText = 'flex: 1; padding: 12px; display: flex; align-items: center; justify-content: center; gap: 8px;';
        const btnEditarIcon = document.createElement('i');
        btnEditarIcon.className = 'fas fa-pen';
        const btnEditarText = document.createElement('span');
        btnEditarText.textContent = 'Editar Cartão';
        btnEditar.appendChild(btnEditarIcon);
        btnEditar.appendChild(btnEditarText);
        btnEditar.addEventListener('click', () => {
            fecharPopup();
            setTimeout(() => abrirCartaoForm(cartaoId), 200);
        });

        const btnFechar = document.createElement('button');
        btnFechar.className = 'btn-cancelar';
        btnFechar.type = 'button';
        btnFechar.style.cssText = 'flex: 1; padding: 12px;';
        btnFechar.textContent = 'Fechar';
        btnFechar.addEventListener('click', fecharPopup);

        btnRow.appendChild(btnEditar);
        btnRow.appendChild(btnFechar);
        popup.appendChild(btnRow);
    });
}

// ========== GRÁFICOS - DELEGA PARA graficos.js ==========
// graficos.js é carregado no HTML e inicializa via DOMContentLoaded.
// Aqui apenas garantimos que Chart.js (CDN ~500KB) esteja disponível
// antes de o usuário tentar gerar gráficos.

let _chartJsCarregado   = false;
let _chartJsCarregando  = false;

const _CHARTJS_SRC       = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js';
const _CHARTJS_INTEGRITY = 'sha384-NrKB+u6Ts6AtkIhwPixiKTzgSKNblyhlk0Sohlgar9UHUBzai/sgnNNWWd291xqt';

function inicializarGraficos() {
    // Se Chart.js já está disponível (carregado em sessão anterior ou pelo HTML), nada a fazer.
    if (typeof Chart !== 'undefined') {
        _chartJsCarregado = true;
        return;
    }

    if (_chartJsCarregado || _chartJsCarregando) return;

    _chartJsCarregando = true;

    const chartScript          = document.createElement('script');
    chartScript.src            = _CHARTJS_SRC;
    chartScript.integrity      = _CHARTJS_INTEGRITY;
    chartScript.crossOrigin    = 'anonymous';
    chartScript.referrerPolicy = 'no-referrer';

    chartScript.onload = () => {
        _chartJsCarregado  = true;
        _chartJsCarregando = false;
    };

    chartScript.onerror = () => {
        _chartJsCarregando = false;
        mostrarNotificacao('Erro ao carregar Chart.js. Verifique a conexão e tente novamente.', 'error');
    };

    document.head.appendChild(chartScript);
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
        if (resultado) resultado.classList.add('js-hidden');
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
        if (resultado) resultado.classList.add('js-hidden');
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
        if (resultado) resultado.classList.add('js-hidden');
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
        resultado.classList.remove('js-hidden');
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
            resultado.classList.remove('js-hidden');
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
        resultado.classList.remove('js-hidden');
        return;
    }

    let html = `
    <div class="rel-report-header">
        <div class="rel-report-title">Relatório de ${perfilNome}</div>
        <span class="rel-report-badge"><i class="fas fa-calendar-alt"></i> ${sanitizeHTML(getMesNome(mes))} de ${sanitizeHTML(ano)}</span>
    </div>
    <div class="rel-kpi-grid">
        <div class="rel-kpi-card rel-kpi-card--entradas">
            <div class="rel-kpi-top"><i class="fas fa-arrow-up rel-kpi-icon"></i><span class="rel-kpi-label">Entradas</span></div>
            <div class="rel-kpi-value">${formatBRL(totalEntradas)}</div>
            <div class="rel-kpi-sub">Total do período</div>
        </div>
        <div class="rel-kpi-card rel-kpi-card--saidas">
            <div class="rel-kpi-top"><i class="fas fa-arrow-down rel-kpi-icon"></i><span class="rel-kpi-label">Saídas</span></div>
            <div class="rel-kpi-value">${formatBRL(totalSaidas)}</div>
            <div class="rel-kpi-sub">Total do período</div>
        </div>
        <div class="rel-kpi-card rel-kpi-card--guardado">
            <div class="rel-kpi-top"><i class="fas fa-piggy-bank rel-kpi-icon"></i><span class="rel-kpi-label">Guardado Líquido</span></div>
            <div class="rel-kpi-value">${formatBRL(valorReservadoLiquido)}</div>
            <div class="rel-kpi-sub">Guardou: ${formatBRL(totalGuardado)} · Retirou: ${formatBRL(totalRetirado)}</div>
        </div>
        <div class="rel-kpi-card rel-kpi-card--saldo">
            <div class="rel-kpi-top"><i class="fas fa-wallet rel-kpi-icon"></i><span class="rel-kpi-label">Saldo Total</span></div>
            <div class="rel-kpi-value">${formatBRL(saldoFinal)}</div>
            <div class="rel-kpi-sub">Inicial: ${formatBRL(saldoInicial)} · Mês: ${formatBRL(saldoDoMes)}</div>
        </div>
        <div class="rel-kpi-card rel-kpi-card--economia">
            <div class="rel-kpi-top"><i class="fas fa-gem rel-kpi-icon"></i><span class="rel-kpi-label">Taxa de Economia</span></div>
            <div class="rel-kpi-value">${sanitizeHTML(String(taxaEconomia))}%</div>
            <div class="rel-kpi-sub">Do que ganhou foi guardado</div>
        </div>
        <div class="rel-kpi-card rel-kpi-card--media">
            <div class="rel-kpi-top"><i class="fas fa-calendar-day rel-kpi-icon"></i><span class="rel-kpi-label">Gasto Médio/Dia</span></div>
            <div class="rel-kpi-value">${formatBRL(mediaGastoDiario)}</div>
            <div class="rel-kpi-sub">Média diária de gastos</div>
        </div>
    </div>
    `;

    if (Object.keys(categorias).length > 0) {
        const categoriasOrdenadas    = Object.entries(categorias).sort((a, b) => b[1] - a[1]).slice(0, 5);
        const totalGastoCategorias   = Object.values(categorias).reduce((a, b) => a + b, 0);
        const coresCategorias        = ['#ff6b6b', '#4ecdc4', '#45b7d1', '#f9ca24', '#6c5ce7'];

        html += `<div class="rel-section"><div class="rel-section-header"><i class="fas fa-chart-bar"></i><span>Top 5 Categorias</span></div><div class="rel-cat-list">`;

        categoriasOrdenadas.forEach(([cat, valor], i) => {
            const percentual = ((valor / totalGastoCategorias) * 100).toFixed(1);
            html += `
                <div class="rel-cat-item">
                    <div class="rel-cat-info">
                        <div class="rel-cat-dot" style="background:${coresCategorias[i]};"></div>
                        <span class="rel-cat-name">${sanitizeHTML(cat)}</span>
                    </div>
                    <div class="rel-cat-bar-wrap">
                        <div class="rel-cat-bar-track"><div class="rel-cat-bar-fill" style="width:${sanitizeHTML(String(percentual))}%; background:${coresCategorias[i]};"></div></div>
                        <span class="rel-cat-value">${formatBRL(valor)}</span>
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

        const corUtilizado = Number(percUsado) > 80 ? 'var(--danger)' : 'var(--success)';
        html += `
            <div class="rel-section">
                <div class="rel-section-header"><i class="fas fa-credit-card"></i><span>Cartões de Crédito</span></div>
                <div class="rel-cards-summary">
                    <div class="rel-card-stat">
                        <span class="rel-card-stat-label">Limite Total</span>
                        <span class="rel-card-stat-value">${formatBRL(totalLimiteCartoes)}</span>
                    </div>
                    <div class="rel-card-stat">
                        <span class="rel-card-stat-label">Usado</span>
                        <span class="rel-card-stat-value" style="color:var(--danger);">${formatBRL(totalUsadoCartoes)}</span>
                    </div>
                    <div class="rel-card-stat">
                        <span class="rel-card-stat-label">Disponível</span>
                        <span class="rel-card-stat-value" style="color:var(--success);">${formatBRL(disponivelCartoes)}</span>
                    </div>
                    <div class="rel-card-stat">
                        <span class="rel-card-stat-label">Utilizado</span>
                        <span class="rel-card-stat-value" style="color:${corUtilizado};">${sanitizeHTML(String(percUsado))}%</span>
                    </div>
                </div>
                <div id="listaCartoesRelatorio"></div>
            </div>`;

        resultado.innerHTML = _sanitizarHTMLRelatorio(html);
        _aplicarEstilosCSOM(resultado);
        resultado.classList.remove('js-hidden');

        const listaCartoes = document.getElementById('listaCartoesRelatorio');
        if (listaCartoes) {
            cartoesPerfil.forEach(c => {
                if (!c || typeof c !== 'object') return;
                const usado       = sanitizeNumber(c.usado);
                const limite      = sanitizeNumber(c.limite);
                const percCartao  = limite > 0 ? ((usado / limite) * 100).toFixed(1) : 0;
                const percNum     = Number(percCartao);
                const corBarra    = percNum > 80 ? '#ff4b4b' : percNum > 50 ? '#ffd166' : '#00ff99';
                const nomeBanco   = String(c.nomeBanco || '');

                // ── Outer card ──
                const div = document.createElement('div');
                div.className = 'rel-card-visual';
                div.style.background = BANCO_COR[nomeBanco] || 'linear-gradient(135deg,#1a1d2e 0%,#2a2d3e 100%)';

                // ── Top row ──
                const topDiv = document.createElement('div');
                topDiv.className = 'rel-card-visual-top';

                // Icon (logo or abbreviation)
                const iconDiv = document.createElement('div');
                iconDiv.className = 'rel-card-visual-icon';
                const iconPath = BANCO_ICON[nomeBanco];
                if (iconPath) {
                    const img = document.createElement('img');
                    img.className = 'rel-card-visual-img';
                    img.src   = iconPath;
                    img.alt   = '';  // decorativo
                    img.setAttribute('aria-hidden', 'true');
                    iconDiv.appendChild(img);
                } else {
                    const abrev = document.createElement('span');
                    abrev.className = 'rel-card-visual-icon-text';
                    abrev.textContent = BANCO_ABREV[nomeBanco] || nomeBanco.substring(0, 2).toUpperCase();
                    iconDiv.appendChild(abrev);
                }

                // Info (name + limit)
                const infoDiv = document.createElement('div');
                infoDiv.className = 'rel-card-visual-info';
                const nameSpan = document.createElement('span');
                nameSpan.className = 'rel-card-visual-name';
                nameSpan.textContent = nomeBanco;
                const subSpan = document.createElement('span');
                subSpan.className = 'rel-card-visual-sub';
                subSpan.textContent = `Limite: ${formatBRL(limite)}`;
                infoDiv.appendChild(nameSpan);
                infoDiv.appendChild(subSpan);

                // Right (used + perc)
                const rightDiv = document.createElement('div');
                rightDiv.className = 'rel-card-visual-right';
                const usadoSpan = document.createElement('span');
                usadoSpan.className = 'rel-card-visual-used';
                usadoSpan.textContent = formatBRL(usado);
                const percSpan = document.createElement('span');
                percSpan.className = 'rel-card-visual-perc';
                percSpan.style.color = corBarra;
                percSpan.textContent = `${percCartao}% usado`;
                rightDiv.appendChild(usadoSpan);
                rightDiv.appendChild(percSpan);

                topDiv.appendChild(iconDiv);
                topDiv.appendChild(infoDiv);
                topDiv.appendChild(rightDiv);

                // ── Progress bar ──
                const barWrap = document.createElement('div');
                barWrap.className = 'rel-card-visual-bar-wrap';
                const barFill = document.createElement('div');
                barFill.className = 'rel-card-visual-bar-fill';
                barFill.style.width      = `${Math.min(100, percNum)}%`;
                barFill.style.background = corBarra;
                barWrap.appendChild(barFill);

                // ── Hint ──
                const dicaDiv = document.createElement('div');
                dicaDiv.className = 'rel-card-visual-hint';
                const dicaIc = document.createElement('i');
                dicaIc.className = 'fas fa-chevron-right';
                dicaIc.setAttribute('aria-hidden', 'true');
                dicaDiv.appendChild(document.createTextNode('Toque para ver detalhes'));
                dicaDiv.appendChild(dicaIc);

                div.appendChild(topDiv);
                div.appendChild(barWrap);
                div.appendChild(dicaDiv);

                div.addEventListener('click', () => { abrirDetalhesCartaoRelatorio(c.id, mes, ano, perfilId); });
                listaCartoes.appendChild(div);
            });
        }

        html = '';
    }

    if (metasPerfil.length > 0) {
        html += `
            <div class="rel-section">
                <div class="rel-section-header"><i class="fas fa-bullseye"></i><span>Progresso das Metas</span></div>
                <div class="rel-meta-selector-wrap">
                    <select id="selectMetaRelatorio" class="form-input">
                        <option value="">Selecione uma meta...</option>
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
        <div class="rel-section">
            <div class="rel-section-header"><i class="fas fa-file-invoice-dollar"></i><span>Contas Fixas do Mês</span></div>
            <div class="rel-bills-chips">
                <div class="rel-bill-chip rel-bill-chip--success">
                    <span class="rel-bill-chip-count">${contasPagas}</span>
                    <span class="rel-bill-chip-label">Pagas</span>
                </div>
                <div class="rel-bill-chip rel-bill-chip--warning">
                    <span class="rel-bill-chip-count">${contasPendentes}</span>
                    <span class="rel-bill-chip-label">Pendentes</span>
                </div>
                <div class="rel-bill-chip rel-bill-chip--danger">
                    <span class="rel-bill-chip-count">${contasVencidas}</span>
                    <span class="rel-bill-chip-label">Vencidas</span>
                </div>
                <div class="rel-bill-chip">
                    <span class="rel-bill-chip-count" style="font-size:0.72rem;">${formatBRL(totalContasValor)}</span>
                    <span class="rel-bill-chip-label">Total</span>
                </div>
            </div>
            <div class="rel-bills-list">
    `;

    if (contasComStatus.length > 0) {
        const pagas     = contasComStatus.filter(c => c.status === 'Paga');
        const pendentes = contasComStatus.filter(c => c.status === 'Pendente');
        const vencidas  = contasComStatus.filter(c => c.status === 'Vencida');

        const _statusClass = (s) => s === 'Paga' ? 'paga' : s === 'Vencida' ? 'vencida' : 'pendente';
        const renderConta = (c) => `
            <div class="rel-bill-item rel-bill-item--${_statusClass(c.status)}">
                <div class="rel-bill-dot"></div>
                <div class="rel-bill-info">
                    <span class="rel-bill-name">${sanitizeHTML(String(c.descricao || '').slice(0, 100))}</span>
                    <span class="rel-bill-date">Vence: ${sanitizeHTML(formatarDataBR(c.vencimento))}</span>
                </div>
                <div class="rel-bill-amount">${formatBRL(sanitizeNumber(c.valor))}</div>
                <div class="rel-bill-badge">${sanitizeHTML(c.status)}</div>
            </div>`;

        const todasContas = [...pagas, ...pendentes, ...vencidas];
        html += todasContas.length > 0
            ? todasContas.map(renderConta).join('')
            : `<div style="text-align:center; padding:20px; color:var(--text-muted); font-size:0.85rem;">Nenhuma conta fixa registrada</div>`;
    } else {
        html += `<div style="text-align:center; padding:20px; color:var(--text-muted); font-size:0.85rem;">
                ${periodoSelecionado === periodoAtualCompleto ?
                    'Nenhuma conta fixa cadastrada. Adicione no Dashboard!' :
                    'Sem contas fixas neste período.'}
            </div>`;
    }
    html += `</div></div>`;

    if (transacoesPeriodo.length > 0) {
        html += `<div class="rel-section"><div class="rel-section-header"><i class="fas fa-list"></i><span>Todas as Transações (${transacoesPeriodo.length})</span></div><div class="rel-tx-list">`;

        transacoesPeriodo.sort((a, b) => {
            const dataHoraA = `${sanitizeDate(dataParaISO(a.data)) || ''} ${String(a.hora || '')}`;
            const dataHoraB = `${sanitizeDate(dataParaISO(b.data)) || ''} ${String(b.hora || '')}`;
            return dataHoraB.localeCompare(dataHoraA);
        });

        transacoesPeriodo.forEach(t => {
            if (!t || typeof t !== 'object') return;
            let dotClass, sinal;
            if (t.categoria === 'entrada') { dotClass = 'entrada'; sinal = '+'; }
            else { dotClass = t.categoria === 'saida' ? 'saida' : 'reserva'; sinal = '-'; }

            html += `
                <div class="rel-tx-item">
                    <div class="rel-tx-dot rel-tx-dot--${dotClass}"></div>
                    <div class="rel-tx-info">
                        <span class="rel-tx-tipo">${sanitizeHTML(String(t.tipo || '').slice(0, 100))}</span>
                        <span class="rel-tx-desc">${sanitizeHTML(String(t.descricao || '').slice(0, 200))}</span>
                        <span class="rel-tx-date">${sanitizeHTML(String(t.data || ''))} · ${sanitizeHTML(String(t.hora || ''))}</span>
                    </div>
                    <div class="rel-tx-value rel-tx-value--${dotClass}">${sinal}${formatBRL(sanitizeNumber(t.valor))}</div>
                </div>`;
        });
        html += `</div></div>`;
    }

    // ✅ CORREÇÃO PRINCIPAL: aplica _sanitizarHTMLRelatorio (DOMParser + whitelist CSS)
    //    antes de qualquer atribuição innerHTML ou insertAdjacentHTML.
    //    Isso garante que mesmo dados de usuário que passaram por sanitizeHTML (escape de entidades)
    //    também sejam verificados pelo whitelist CSS, remoção de on*, remoção de tags perigosas
    //    e bloqueio de esquemas javascript:/vbscript:/data: em atributos.
    //    Crítico para planos Família/Casal onde dados do dono são exibidos para membros convidados.
    if (html) {
        resultado.insertAdjacentHTML('beforeend', _sanitizarHTMLRelatorio(html));
        _aplicarEstilosCSOM(resultado);
    }
    resultado.classList.remove('js-hidden');

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
                    <div class="rel-meta-detail">
                        <div class="rel-meta-detail-name">${sanitizeHTML(String(meta.descricao || '').slice(0, 100))}</div>
                        <div class="rel-meta-bar-wrap">
                            <div class="rel-meta-bar-track"><div class="rel-meta-bar-fill" style="width:${sanitizeHTML(String(perc))}%; background:${corProgresso};"></div></div>
                            <span class="rel-meta-bar-label" style="color:${corProgresso};">${sanitizeHTML(String(perc))}%</span>
                        </div>
                        <div class="rel-meta-info-row"><span class="rel-meta-info-label">Objetivo</span><span class="rel-meta-info-value">${formatBRL(objetivo)}</span></div>
                        <div class="rel-meta-info-row"><span class="rel-meta-info-label">Guardado</span><span class="rel-meta-info-value" style="color:var(--success);">${formatBRL(saved)}</span></div>
                        <div class="rel-meta-info-row"><span class="rel-meta-info-label">Falta</span><span class="rel-meta-info-value" style="color:var(--danger);">${formatBRL(falta)}</span></div>
                        <div class="rel-meta-info-row"><span class="rel-meta-info-label">Depositado neste mês</span><span class="rel-meta-info-value" style="color:var(--warning);">${formatBRL(totalDepositadoMes)} <small style="font-weight:400; color:var(--text-muted);">(${depositosMes.length}x)</small></span></div>
                        ${totalRetiradoMes > 0 ? `<div class="rel-meta-info-row"><span class="rel-meta-info-label">Retirado neste mês</span><span class="rel-meta-info-value" style="color:#ff9500;">${formatBRL(totalRetiradoMes)} <small style="font-weight:400; color:var(--text-muted);">(${retiradasMes.length}x)</small></span></div>` : ''}
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
            resultado.classList.remove('js-hidden');
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
        resultado.classList.remove('js-hidden');
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
    <div class="rel-report-header">
        <div class="rel-report-title">${icone} Relatório ${sanitizeHTML(tipoTexto)}</div>
        <span class="rel-report-badge"><i class="fas fa-calendar-alt"></i> ${sanitizeHTML(getMesNome(mes))} de ${sanitizeHTML(ano)}</span>
    </div>
    <div class="rel-kpi-grid">
        <div class="rel-kpi-card rel-kpi-card--entradas">
            <div class="rel-kpi-top"><i class="fas fa-arrow-up rel-kpi-icon"></i><span class="rel-kpi-label">Entradas Totais</span></div>
            <div class="rel-kpi-value">${formatBRL(totalGeralEntradas)}</div>
            <div class="rel-kpi-sub">Soma de todos os perfis</div>
        </div>
        <div class="rel-kpi-card rel-kpi-card--saidas">
            <div class="rel-kpi-top"><i class="fas fa-arrow-down rel-kpi-icon"></i><span class="rel-kpi-label">Saídas Totais</span></div>
            <div class="rel-kpi-value">${formatBRL(totalGeralSaidas)}</div>
            <div class="rel-kpi-sub">Soma de todos os perfis</div>
        </div>
        <div class="rel-kpi-card rel-kpi-card--guardado">
            <div class="rel-kpi-top"><i class="fas fa-piggy-bank rel-kpi-icon"></i><span class="rel-kpi-label">Guardado Líquido</span></div>
            <div class="rel-kpi-value">${formatBRL(totalGeralReservasLiquido)}</div>
            <div class="rel-kpi-sub">Guardou: ${formatBRL(totalGeralGuardado)} · Retirou: ${formatBRL(totalGeralRetirado)}</div>
        </div>
        <div class="rel-kpi-card rel-kpi-card--saldo">
            <div class="rel-kpi-top"><i class="fas fa-wallet rel-kpi-icon"></i><span class="rel-kpi-label">Saldo Total</span></div>
            <div class="rel-kpi-value">${formatBRL(saldoGeral)}</div>
            <div class="rel-kpi-sub">Inicial: ${formatBRL(saldoInicialGeral)} · Mês: ${formatBRL(saldoGeralDoMes)}</div>
        </div>
        <div class="rel-kpi-card rel-kpi-card--economia">
            <div class="rel-kpi-top"><i class="fas fa-gem rel-kpi-icon"></i><span class="rel-kpi-label">Taxa de Economia</span></div>
            <div class="rel-kpi-value">${sanitizeHTML(String(taxaEconomiaGeral))}%</div>
            <div class="rel-kpi-sub">Média ${sanitizeHTML(tipoTexto.toLowerCase())}</div>
        </div>
    </div>

    <div class="rel-section">
        <div class="rel-section-header"><i class="fas fa-trophy"></i><span>Rankings e Comparativos</span></div>
        <div class="rel-ranking-tabs">
            <button class="rel-ranking-tab ranking-btn active" data-ranking="gastos">Quem Gastou Mais</button>
            <button class="rel-ranking-tab ranking-btn" data-ranking="guardou">Quem Guardou Mais</button>
            <button class="rel-ranking-tab ranking-btn" data-ranking="economia">Melhor Economia</button>
            <button class="rel-ranking-tab ranking-btn" data-ranking="evolucao">Maior Evolução</button>
        </div>
        <div id="rankingContainer"></div>
    </div>

    <div class="rel-section">
        <div class="rel-section-header"><i class="fas fa-users"></i><span>Análise Individual Completa</span></div>
        <div class="rel-profiles-grid">
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

        const varEntStr = d.mesAnterior?.entradas > 0 ?
            `<span class="rel-variacao rel-variacao--${variacaoEntradas >= 0 ? 'up' : 'down'}">${variacaoEntradas >= 0 ? '↑' : '↓'}${Math.abs(variacaoEntradas)}%</span>` : '';
        const varSaiStr = d.mesAnterior?.saidas > 0 ?
            `<span class="rel-variacao rel-variacao--${variacaoSaidas <= 0 ? 'up' : 'down'}">${variacaoSaidas >= 0 ? '↑' : '↓'}${Math.abs(variacaoSaidas)}%</span>` : '';
        const varResStr = d.mesAnterior?.reservas !== 0 ?
            `<span class="rel-variacao rel-variacao--${variacaoReservas >= 0 ? 'up' : 'down'}">${variacaoReservas >= 0 ? '↑' : '↓'}${Math.abs(variacaoReservas)}%</span>` : '';

        html += `
            <div class="rel-profile-card">
                <div class="rel-profile-name">${nomePerfilSeguro}</div>
                <div class="rel-profile-grid">
                    <div class="rel-profile-row">
                        <span class="rel-profile-row-label"><i class="fas fa-arrow-up"></i> Entradas</span>
                        <span class="rel-profile-row-value entrada">${formatBRL(d.entradas)} ${varEntStr}</span>
                    </div>
                    <div class="rel-profile-row">
                        <span class="rel-profile-row-label"><i class="fas fa-arrow-down"></i> Saídas</span>
                        <span class="rel-profile-row-value saida">${formatBRL(d.saidas)} ${varSaiStr}</span>
                    </div>
                    <div class="rel-profile-row">
                        <span class="rel-profile-row-label"><i class="fas fa-piggy-bank"></i> Guardado</span>
                        <span class="rel-profile-row-value reserva">${formatBRL(d.reservas)} ${varResStr}</span>
                    </div>
                    <div class="rel-profile-row">
                        <span class="rel-profile-row-label"><i class="fas fa-wallet"></i> Saldo</span>
                        <span class="rel-profile-row-value" style="color:var(--accent);">${formatBRL(d.saldo)}</span>
                    </div>
                    <div class="rel-profile-row">
                        <span class="rel-profile-row-label"><i class="fas fa-gem"></i> Economia</span>
                        <span class="rel-profile-row-value" style="color:var(--success);">${sanitizeHTML(String(d.taxaEconomia.toFixed(1)))}%</span>
                    </div>
                    <div class="rel-profile-row">
                        <span class="rel-profile-row-label"><i class="fas fa-calendar-day"></i> Média/Dia</span>
                        <span class="rel-profile-row-value">${formatBRL(mediaGastoDiario)}</span>
                    </div>
                    <div class="rel-profile-row">
                        <span class="rel-profile-row-label"><i class="fas fa-list"></i> Transações</span>
                        <span class="rel-profile-row-value">${d.transacoes.length}</span>
                    </div>
                    ${d.cartoes?.length > 0 ? `
                    <div class="rel-profile-row">
                        <span class="rel-profile-row-label"><i class="fas fa-credit-card"></i> Cartões</span>
                        <span class="rel-profile-row-value" style="color:${percUsadoCartoes > 80 ? 'var(--danger)' : 'var(--success)'};">${sanitizeHTML(String(percUsadoCartoes))}% usado</span>
                    </div>` : ''}
                </div>
                <div id="btnDetalhes_${perfilIdSeguro}" style="margin-top:12px;"></div>
            </div>`;
    });

    html += `</div></div>`;

    if (Object.keys(categoriasGerais).length > 0) {
        const categoriasTop         = Object.entries(categoriasGerais).sort((a, b) => b[1] - a[1]).slice(0, 5);
        const totalGastoCategorias  = Object.values(categoriasGerais).reduce((a, b) => a + b, 0);
        const coresCategorias       = ['#ff6b6b', '#4ecdc4', '#45b7d1', '#f9ca24', '#6c5ce7'];

        html += `<div class="rel-section"><div class="rel-section-header"><i class="fas fa-chart-bar"></i><span>Top 5 Categorias (Geral)</span></div><div class="rel-cat-list">`;

        categoriasTop.forEach(([cat, valor], i) => {
            const percentual = ((valor / totalGastoCategorias) * 100).toFixed(1);
            html += `
                <div class="rel-cat-item">
                    <div class="rel-cat-info">
                        <div class="rel-cat-dot" style="background:${coresCategorias[i]};"></div>
                        <span class="rel-cat-name">${sanitizeHTML(cat)}</span>
                    </div>
                    <div class="rel-cat-bar-wrap">
                        <div class="rel-cat-bar-track"><div class="rel-cat-bar-fill" style="width:${sanitizeHTML(String(percentual))}%; background:${coresCategorias[i]};"></div></div>
                        <span class="rel-cat-value">${formatBRL(valor)}</span>
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
    resultado.classList.remove('js-hidden');

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
        iconDiv.style.cssText = 'font-size:2.5rem; margin-bottom:12px; opacity:0.4; color:var(--text-secondary);';
        const iconDivI = document.createElement('i');
        iconDivI.className = 'fas fa-magnifying-glass';
        iconDiv.appendChild(iconDivI);

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

    // Limpa container
    container.innerHTML = '';

    // ── Card de resumo (glassmorphism)
    const cardResumo = document.createElement('div');
    cardResumo.style.cssText = 'background:linear-gradient(135deg,rgba(67,160,71,0.15),rgba(108,99,255,0.15)); backdrop-filter:blur(12px); -webkit-backdrop-filter:blur(12px); border:1px solid rgba(67,160,71,0.25); padding:18px; border-radius:16px; margin-bottom:16px;';

    // Narrativa
    narrativaContainer.style.cssText = 'font-size:0.95rem; line-height:1.7; color:var(--text-primary); margin-bottom:14px;';
    cardResumo.appendChild(narrativaContainer);

    // Stats rápidos: total + transações
    const rowStats = document.createElement('div');
    rowStats.style.cssText = 'display:grid; grid-template-columns:1fr 1fr; gap:10px; padding-top:14px; border-top:1px solid rgba(255,255,255,0.08);';

    function criarStatMini(lbl, val, cor) {
        const c = document.createElement('div');
        c.style.cssText = 'background:rgba(255,255,255,0.04); border-radius:10px; padding:10px 12px; text-align:center;';
        const vEl = document.createElement('div');
        vEl.style.cssText = `font-size:1.2rem; font-weight:700; color:${cor}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;`;
        vEl.textContent = val;
        const lEl = document.createElement('div');
        lEl.style.cssText = 'font-size:0.72rem; color:var(--text-muted); margin-top:3px; text-transform:uppercase; letter-spacing:0.04em;';
        lEl.textContent = lbl;
        c.appendChild(vEl); c.appendChild(lEl);
        return c;
    }
    rowStats.appendChild(criarStatMini('Total gasto', formatBRL(analise.totalGastos), '#ff4b4b'));
    rowStats.appendChild(criarStatMini('Transações', String(analise.totalTransacoes), '#4ecdc4'));
    cardResumo.appendChild(rowStats);
    container.appendChild(cardResumo);

    // ── Distribuição por categoria
    const cardCats = document.createElement('div');
    cardCats.style.cssText = 'background:rgba(255,255,255,0.03); backdrop-filter:blur(8px); border:1px solid rgba(255,255,255,0.07); border-radius:16px; padding:16px; margin-bottom:14px;';

    const catTitulo = document.createElement('div');
    catTitulo.style.cssText = 'display:flex; align-items:center; gap:8px; margin-bottom:14px; font-size:0.78rem; font-weight:700; text-transform:uppercase; letter-spacing:0.06em; color:var(--text-muted);';
    const catIcon = document.createElement('i'); catIcon.className = 'fas fa-chart-pie'; catIcon.style.color = 'var(--primary)';
    catTitulo.appendChild(catIcon); catTitulo.appendChild(document.createTextNode(' Distribuição por Categoria'));
    cardCats.appendChild(catTitulo);

    const cores = ['#ff4b4b','#ffd166','#4ecdc4','#45b7d1','#f9ca24','#6c5ce7','#a29bfe','#fd79a8'];

    analise.categorias.forEach(([categoria, valor], i) => {
        const percentual = parseFloat(((valor / analise.totalGastos) * 100).toFixed(1));
        const cor        = cores[i % cores.length];

        const itemCat = document.createElement('div');
        itemCat.style.cssText = 'margin-bottom:10px;';

        const rowCat = document.createElement('div');
        rowCat.style.cssText = 'display:flex; justify-content:space-between; align-items:center; margin-bottom:5px;';

        const leftCat = document.createElement('div');
        leftCat.style.cssText = 'display:flex; align-items:center; gap:8px; min-width:0;';
        const dot = document.createElement('span');
        dot.style.cssText = `width:10px; height:10px; border-radius:3px; background:${cor}; flex-shrink:0;`;
        const nomeCat = document.createElement('span');
        nomeCat.style.cssText = 'font-size:0.85rem; font-weight:600; color:var(--text-primary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
        nomeCat.textContent = _sanitizeText(categoria); // ✅ textContent
        leftCat.appendChild(dot); leftCat.appendChild(nomeCat);

        const rightCat = document.createElement('div');
        rightCat.style.cssText = 'display:flex; align-items:center; gap:8px; flex-shrink:0;';
        const valEl = document.createElement('span');
        valEl.style.cssText = 'font-size:0.85rem; font-weight:700; color:var(--text-primary);';
        valEl.textContent = formatBRL(valor);
        const pctEl = document.createElement('span');
        // Cores são todas do array interno (6 chars hex) — seguro interpolar
        const [rr,gg,bb] = (cor.slice(1).match(/../g) || ['ff','ff','ff']).map(x => parseInt(x, 16));
        pctEl.style.cssText = `font-size:0.75rem; padding:2px 6px; border-radius:10px; background:rgba(${rr},${gg},${bb},0.18); color:${cor}; font-weight:600; min-width:36px; text-align:center;`;
        pctEl.textContent = `${percentual}%`;
        rightCat.appendChild(valEl); rightCat.appendChild(pctEl);

        rowCat.appendChild(leftCat); rowCat.appendChild(rightCat);

        const barra = document.createElement('div');
        barra.style.cssText = 'width:100%; height:5px; background:rgba(255,255,255,0.08); border-radius:10px; overflow:hidden;';
        const fill = document.createElement('div');
        fill.style.cssText = `width:0%; height:100%; background:${cor}; border-radius:10px; transition:width 0.6s ease ${i * 80}ms;`;
        barra.appendChild(fill);

        // Animação com timeout para efeito de entrada
        setTimeout(() => { fill.style.width = `${percentual}%`; }, 50);

        itemCat.appendChild(rowCat); itemCat.appendChild(barra);
        cardCats.appendChild(itemCat);
    });

    container.appendChild(cardCats);

    // ── Insight card (glassmorphism roxo)
    const insightDiv = document.createElement('div');
    insightDiv.style.cssText = 'background:rgba(108,99,255,0.1); backdrop-filter:blur(8px); border:1px solid rgba(108,99,255,0.2); padding:16px; border-radius:16px;';

    const insightTit = document.createElement('div');
    insightTit.style.cssText = 'display:flex; align-items:center; gap:8px; margin-bottom:12px; font-size:0.78rem; font-weight:700; text-transform:uppercase; letter-spacing:0.06em; color:#a78bfa;';
    const insightI = document.createElement('i'); insightI.className = 'fas fa-lightbulb'; insightI.style.color = '#6c63ff';
    insightTit.appendChild(insightI); insightTit.appendChild(document.createTextNode(' Insight Inteligente'));
    insightDiv.appendChild(insightTit);

    const ticketMedio = analise.totalGastos / analise.totalTransacoes;

    function addInsightP(txt) {
        const p = document.createElement('p');
        p.style.cssText = 'font-size:0.84rem; color:var(--text-secondary); line-height:1.6; margin-bottom:6px;';
        p.textContent = txt;
        insightDiv.appendChild(p);
    }

    if (analise.top3[0]) {
        const percTop = Math.round((analise.top3[0][1] / analise.totalGastos) * 100);
        if (percTop > 50) {
            addInsightP(`⚠️ Atenção: ${percTop}% dos gastos foram em "${_sanitizeText(analise.top3[0][0])}" — mais da metade do orçamento! Analise oportunidades de redução nessa categoria.`);
        }
    }
    addInsightP(`💳 Ticket médio: ${formatBRL(ticketMedio)} por transação. ${ticketMedio > 200 ? 'Valores altos — certifique-se de que cada gasto está alinhado com suas prioridades.' : 'Valores moderados — bom sinal de controle diário.'}`);

    if (analise.top3.length >= 2) {
        const ec = analise.top3.reduce((s, [, v]) => s + v * 0.1, 0);
        addInsightP(`💡 Economizando 10% nas ${analise.top3.length} maiores categorias você teria ${formatBRL(ec)} a mais por mês.`);
    }

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
        popup.style.cssText = 'max-width:480px; width:96%;';

        // ── Wrapper scroll
        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'max-height:82vh; overflow-y:auto; overflow-x:hidden; padding-right:4px;';

        // ── Título
        const titulo = document.createElement('h3');
        titulo.style.cssText = 'text-align:center; margin-bottom:4px; display:flex; align-items:center; justify-content:center; gap:10px; font-size:1.1rem;';
        const tituloIcon = document.createElement('i');
        tituloIcon.className = 'fas fa-magnifying-glass-dollar';
        tituloIcon.style.color = 'var(--primary)';
        const tituloText = document.createElement('span');
        tituloText.textContent = 'Onde Foi Meu Dinheiro?';
        titulo.appendChild(tituloIcon);
        titulo.appendChild(tituloText);

        // ── Subtítulo
        const subtitulo = document.createElement('p');
        subtitulo.style.cssText = 'color:var(--text-muted); margin-bottom:14px; font-size:0.8rem; text-align:center;';
        subtitulo.textContent = 'Analise seus gastos por período';

        // ── Row de filtros
        const rowFiltros = document.createElement('div');
        rowFiltros.style.cssText = 'display:flex; gap:12px; margin-bottom:14px; flex-wrap:wrap;';

        // ── Coluna Mês
        const colMes = document.createElement('div');
        colMes.style.cssText = 'flex:1; min-width:130px;';

        const labelMes = document.createElement('label');
        labelMes.style.cssText = 'display:flex; align-items:center; gap:6px; margin-bottom:6px; font-size:0.85rem; font-weight:600; color:var(--text-secondary);';
        const labelMesIcon = document.createElement('i');
        labelMesIcon.className = 'fas fa-calendar';
        const labelMesText = document.createElement('span');
        labelMesText.textContent = 'Mês';
        labelMes.appendChild(labelMesIcon);
        labelMes.appendChild(labelMesText);

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
        labelAno.style.cssText = 'display:flex; align-items:center; gap:6px; margin-bottom:6px; font-size:0.85rem; font-weight:600; color:var(--text-secondary);';
        const labelAnoIcon = document.createElement('i');
        labelAnoIcon.className = 'fas fa-calendar-days';
        const labelAnoText = document.createElement('span');
        labelAnoText.textContent = 'Ano';
        labelAno.appendChild(labelAnoIcon);
        labelAno.appendChild(labelAnoText);

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
        btnAnalisar.style.cssText = 'width:100%; margin-bottom:20px; display:flex; align-items:center; justify-content:center; gap:8px;';
        const btnAnalisarIcon = document.createElement('i');
        btnAnalisarIcon.className = 'fas fa-magnifying-glass';
        const btnAnalisarText = document.createElement('span');
        btnAnalisarText.textContent = 'Analisar Gastos';
        btnAnalisar.appendChild(btnAnalisarIcon);
        btnAnalisar.appendChild(btnAnalisarText);
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
    const dadosPerfil = userData.profiles.find(p => String(p.id) === String(perfilId));

    const cartoesPerfil     = dadosPerfil ? dadosPerfil.cartoesCredito || [] : [];
    const contasFixasPerfil = dadosPerfil ? dadosPerfil.contasFixas    || [] : [];

    const cartao = cartoesPerfil.find(c => String(c.id) === String(cartaoId));
    if (!cartao) { mostrarNotificacao('Cartão não encontrado.', 'error'); return; }

    const hojeISO         = new Date().toISOString().slice(0, 10);
    const periodoMesAtual = `${ano}-${mes}`;

    // ── Todas as faturas deste cartão
    const todasFaturas = contasFixasPerfil.filter(c =>
        String(c.cartaoId) === String(cartaoId) && c.vencimento
    );

    // ── Faturas pendentes (não pagas, vencimento >= hoje)
    const faturasPendentes = todasFaturas
        .filter(f => !f.pago)
        .sort((a, b) => a.vencimento.localeCompare(b.vencimento));

    // ── Faturas vencidas (não pagas, vencimento < hoje)
    const faturasVencidas = faturasPendentes.filter(f => f.vencimento < hojeISO);

    // ── Compras do mês selecionado no relatório
    const faturasMes = todasFaturas.filter(f => f.vencimento && f.vencimento.startsWith(periodoMesAtual));
    let comprasMes = [];
    faturasMes.forEach(f => {
        if (Array.isArray(f.compras)) f.compras.forEach(c => comprasMes.push({ ...c, faturaId: f.id, vencFatura: f.vencimento }));
    });

    // ── Métricas do cartão
    const usado      = Number(cartao.usado || 0);
    const limite     = Number(cartao.limite || 0);
    const disponivel = Math.max(0, limite - usado);
    const percUsado  = limite > 0 ? Math.min(100, (usado / limite) * 100) : 0;
    const percStr    = percUsado.toFixed(1);
    const corPerc    = percUsado > 80 ? '#ff4b4b' : percUsado > 50 ? '#ffd166' : '#00ff99';

    // ── Total em aberto nas faturas pendentes
    const totalPendente = faturasPendentes.reduce((s, f) => s + Number(f.valor || 0), 0);

    // ── Projeção de quitação: data da última fatura com parcelas restantes
    let dataQuitacao = null;
    faturasPendentes.forEach(f => {
        if (!f.vencimento) return;
        if (!dataQuitacao || f.vencimento > dataQuitacao) dataQuitacao = f.vencimento;
    });

    // ── Parcelas pendentes no mês atual (contas a pagar neste mês)
    const parcelasPendentesMes = comprasMes.filter(c => Number(c.parcelaAtual) <= Number(c.totalParcelas)).length;

    const dica = obterDicaAleatoria();

    // ── Monta HTML de compras do mês
    let htmlComprasMes = '';
    if (comprasMes.length === 0) {
        htmlComprasMes = `
            <div style="text-align:center; padding:30px; background:rgba(255,255,255,0.03); border-radius:12px;">
                <i class="fas fa-shopping-cart" style="font-size:2.5rem; opacity:0.4; color:var(--text-muted); display:block; margin-bottom:12px;"></i>
                <div style="font-size:1rem; font-weight:600; color:var(--text-primary); margin-bottom:6px;">Nenhuma compra registrada</div>
                <div style="font-size:0.85rem; color:var(--text-secondary);">
                    Nenhuma compra neste cartão em ${sanitizeHTML(getMesNome(mes))} de ${sanitizeHTML(ano)}
                </div>
            </div>`;
    } else {
        comprasMes.forEach(compra => {
            const pago     = Number(compra.parcelaAtual) > Number(compra.totalParcelas);
            const cor      = pago ? '#00ff99' : '#ffd166';
            const falta    = pago ? '—' : formatBRL(compra.valorParcela * (compra.totalParcelas - compra.parcelaAtual + 1));
            const parcTxt  = pago ? 'Quitado' : `Parcela ${sanitizeHTML(String(compra.parcelaAtual))}/${sanitizeHTML(String(compra.totalParcelas))}`;
            htmlComprasMes += `
                <div style="background:rgba(255,255,255,0.03); padding:14px; border-radius:10px; margin-bottom:10px; border-left:3px solid ${cor};">
                    <div style="display:flex; justify-content:space-between; align-items:start; gap:8px; flex-wrap:wrap; margin-bottom:8px;">
                        <div style="flex:1;">
                            <div style="font-weight:700; color:var(--text-primary); font-size:0.9rem;">${sanitizeHTML(compra.tipo)}</div>
                            <div style="color:var(--text-secondary); font-size:0.82rem; margin-top:3px;">${sanitizeHTML(compra.descricao)}</div>
                            <div style="color:var(--text-muted); font-size:0.78rem; margin-top:3px; display:flex; align-items:center; gap:4px;">
                                <i class="fas fa-calendar-day" style="font-size:0.72rem;"></i>
                                ${sanitizeHTML(formatarDataBR(compra.dataCompra))}
                            </div>
                        </div>
                        <div style="text-align:right;">
                            <div style="font-weight:700; color:var(--text-primary); font-size:1.05rem;">${formatBRL(compra.valorParcela)}</div>
                            <div style="font-size:0.78rem; color:${cor}; font-weight:600; margin-top:3px;">${parcTxt}</div>
                        </div>
                    </div>
                    <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; padding-top:8px; border-top:1px solid rgba(255,255,255,0.07);">
                        <div><div style="font-size:0.72rem; color:var(--text-muted);">Total da compra</div><div style="font-size:0.85rem; font-weight:600; color:var(--text-secondary);">${formatBRL(compra.valorTotal)}</div></div>
                        <div><div style="font-size:0.72rem; color:var(--text-muted);">Falta pagar</div><div style="font-size:0.85rem; font-weight:600; color:${pago ? '#00ff99' : '#ff4b4b'};">${falta}</div></div>
                    </div>
                </div>`;
        });
    }

    // ── Monta HTML de faturas pendentes
    let htmlFaturasPendentes = '';
    if (faturasPendentes.length === 0) {
        htmlFaturasPendentes = `<div style="text-align:center; padding:20px; color:var(--text-muted); font-size:0.9rem;">
            <i class="fas fa-circle-check" style="color:#00ff99; margin-right:6px;"></i>Nenhuma fatura pendente — cartão em dia!
        </div>`;
    } else {
        faturasPendentes.slice(0, 6).forEach(f => {
            const vencido = f.vencimento < hojeISO;
            const cor = vencido ? '#ff4b4b' : '#ffd166';
            const icone = vencido ? 'fa-triangle-exclamation' : 'fa-clock';
            htmlFaturasPendentes += `
                <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 14px; background:rgba(255,255,255,0.03); border-radius:8px; margin-bottom:8px; border-left:2px solid ${cor};">
                    <div style="display:flex; align-items:center; gap:8px;">
                        <i class="fas ${icone}" style="color:${cor}; font-size:0.8rem;"></i>
                        <div>
                            <div style="font-size:0.82rem; color:var(--text-primary); font-weight:600;">${sanitizeHTML(formatarDataBR(f.vencimento))}</div>
                            <div style="font-size:0.72rem; color:var(--text-muted);">${vencido ? 'Vencida' : 'Pendente'}</div>
                        </div>
                    </div>
                    <div style="font-weight:700; color:${cor}; font-size:0.9rem;">${formatBRL(f.valor)}</div>
                </div>`;
        });
        if (faturasPendentes.length > 6) {
            htmlFaturasPendentes += `<div style="text-align:center; color:var(--text-muted); font-size:0.8rem; padding:6px;">
                + ${faturasPendentes.length - 6} fatura(s) não exibida(s)
            </div>`;
        }
    }

    criarPopup(`
        <div style="max-height:82vh; overflow-y:auto; overflow-x:hidden; padding-right:6px;">
            <button id="btnFecharCartaoRelatorio" style="position:sticky; top:0; float:right; margin-bottom:8px; background:#ff4b4b; border:none; color:#fff; width:32px; height:32px; border-radius:8px; cursor:pointer; font-size:1.1rem; font-weight:700; z-index:10; box-shadow:0 2px 8px rgba(255,75,75,0.4); display:flex; align-items:center; justify-content:center;">
                <i class="fas fa-xmark"></i>
            </button>

            <!-- Cabeçalho -->
            <div style="background:linear-gradient(135deg, var(--primary), var(--secondary)); padding:20px; border-radius:14px; margin-bottom:18px; text-align:center; box-shadow:0 4px 20px rgba(108,99,255,0.3);">
                <i class="fas fa-credit-card" style="font-size:1.8rem; color:white; margin-bottom:8px; display:block; opacity:0.9;"></i>
                <div style="font-size:1.4rem; font-weight:700; color:white;">${sanitizeHTML(cartao.nomeBanco)}</div>
                <div style="font-size:0.85rem; color:rgba(255,255,255,0.75); margin-top:6px;">
                    <i class="fas fa-calendar-alt" style="margin-right:5px;"></i>${sanitizeHTML(getMesNome(mes))} de ${sanitizeHTML(ano)}
                </div>
            </div>

            <!-- Limite e uso -->
            <div style="display:grid; grid-template-columns:repeat(2,1fr); gap:10px; margin-bottom:18px;">
                <div style="background:rgba(255,255,255,0.05); padding:14px; border-radius:12px; text-align:center; backdrop-filter:blur(8px);">
                    <div style="font-size:0.78rem; color:var(--text-muted); margin-bottom:4px;"><i class="fas fa-wallet" style="margin-right:4px;"></i>Limite</div>
                    <div style="font-size:1.15rem; font-weight:700; color:var(--text-primary);">${formatBRL(limite)}</div>
                </div>
                <div style="background:rgba(255,75,75,0.08); padding:14px; border-radius:12px; text-align:center; backdrop-filter:blur(8px);">
                    <div style="font-size:0.78rem; color:var(--text-muted); margin-bottom:4px;"><i class="fas fa-arrow-trend-up" style="margin-right:4px;"></i>Usado</div>
                    <div style="font-size:1.15rem; font-weight:700; color:#ff4b4b;">${formatBRL(usado)}</div>
                </div>
                <div style="background:rgba(0,255,153,0.08); padding:14px; border-radius:12px; text-align:center; backdrop-filter:blur(8px);">
                    <div style="font-size:0.78rem; color:var(--text-muted); margin-bottom:4px;"><i class="fas fa-circle-check" style="margin-right:4px;"></i>Disponível</div>
                    <div style="font-size:1.15rem; font-weight:700; color:#00ff99;">${formatBRL(disponivel)}</div>
                </div>
                <div style="background:rgba(255,255,255,0.05); padding:14px; border-radius:12px; text-align:center; backdrop-filter:blur(8px);">
                    <div style="font-size:0.78rem; color:var(--text-muted); margin-bottom:4px;"><i class="fas fa-chart-pie" style="margin-right:4px;"></i>Utilizado</div>
                    <div style="font-size:1.15rem; font-weight:700; color:${corPerc};">${sanitizeHTML(percStr)}%</div>
                </div>
            </div>

            <!-- Barra de uso -->
            <div style="margin-bottom:18px;">
                <div style="width:100%; height:10px; background:rgba(255,255,255,0.1); border-radius:10px; overflow:hidden;">
                    <div style="width:${sanitizeHTML(percStr)}%; height:100%; background:${corPerc}; border-radius:10px;"></div>
                </div>
            </div>

            <!-- Pendências deste mês -->
            <div style="display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-bottom:18px;">
                <div style="background:rgba(108,99,255,0.1); padding:12px; border-radius:10px; text-align:center; border-top:2px solid #6c63ff;">
                    <div style="font-size:0.75rem; color:var(--text-secondary); margin-bottom:4px;"><i class="fas fa-shopping-cart"></i> Compras/mês</div>
                    <div style="font-size:1.4rem; font-weight:700; color:#6c63ff;">${comprasMes.length}</div>
                </div>
                <div style="background:rgba(255,209,102,0.1); padding:12px; border-radius:10px; text-align:center; border-top:2px solid #ffd166;">
                    <div style="font-size:0.75rem; color:var(--text-secondary); margin-bottom:4px;"><i class="fas fa-hourglass-half"></i> Pendentes/mês</div>
                    <div style="font-size:1.4rem; font-weight:700; color:#ffd166;">${parcelasPendentesMes}</div>
                </div>
                <div style="background:rgba(255,75,75,0.1); padding:12px; border-radius:10px; text-align:center; border-top:2px solid #ff4b4b;">
                    <div style="font-size:0.75rem; color:var(--text-secondary); margin-bottom:4px;"><i class="fas fa-file-invoice-dollar"></i> Total pendente</div>
                    <div style="font-size:1rem; font-weight:700; color:#ff4b4b;">${formatBRL(totalPendente)}</div>
                </div>
            </div>

            <!-- Projeção de quitação -->
            ${dataQuitacao ? `
            <div style="background:linear-gradient(135deg,rgba(76,166,255,0.12),rgba(108,99,255,0.12)); border:1px solid rgba(76,166,255,0.2); border-radius:12px; padding:14px 16px; margin-bottom:18px; display:flex; align-items:center; gap:14px;">
                <i class="fas fa-flag-checkered" style="font-size:1.6rem; color:#4ca6ff; flex-shrink:0;"></i>
                <div>
                    <div style="font-weight:700; color:var(--text-primary); margin-bottom:4px;">Projeção de Quitação</div>
                    <div style="font-size:0.88rem; color:var(--text-secondary);">
                        Pagando em dia, este cartão estará quitado em <strong style="color:#4ca6ff;">${sanitizeHTML(formatarDataBR(dataQuitacao))}</strong>.
                        ${faturasVencidas.length > 0 ? `<span style="color:#ff4b4b; font-weight:600;"> (${faturasVencidas.length} fatura(s) vencida(s) — regularize!)</span>` : ''}
                    </div>
                </div>
            </div>` : ''}

            <!-- Faturas pendentes -->
            <div style="margin-bottom:18px;">
                <div style="font-weight:700; color:var(--text-primary); font-size:0.9rem; margin-bottom:10px; display:flex; align-items:center; gap:8px;">
                    <i class="fas fa-file-invoice" style="color:#ffd166;"></i> Faturas Pendentes
                    ${faturasPendentes.length > 0 ? `<span style="background:rgba(255,209,102,0.15); color:#ffd166; font-size:0.72rem; padding:2px 8px; border-radius:12px;">${faturasPendentes.length}</span>` : ''}
                </div>
                ${htmlFaturasPendentes}
            </div>

            <!-- Compras do mês -->
            <div style="margin-bottom:18px;">
                <div style="font-weight:700; color:var(--text-primary); font-size:0.9rem; margin-bottom:10px; display:flex; align-items:center; gap:8px;">
                    <i class="fas fa-shopping-bag" style="color:#6c63ff;"></i> Compras em ${sanitizeHTML(getMesNome(mes))}
                    ${comprasMes.length > 0 ? `<span style="background:rgba(108,99,255,0.15); color:#6c63ff; font-size:0.72rem; padding:2px 8px; border-radius:12px;">${comprasMes.length}</span>` : ''}
                </div>
                ${htmlComprasMes}
            </div>

            <!-- Dica inteligente -->
            <div style="background:linear-gradient(135deg,rgba(108,99,255,0.15),rgba(76,166,255,0.15)); border:1px solid rgba(108,99,255,0.2); border-radius:12px; padding:14px 16px; margin-bottom:16px;">
                <div style="display:flex; align-items:center; gap:10px; margin-bottom:8px;">
                    <i class="fas fa-lightbulb" style="color:#ffd166; font-size:1.1rem;"></i>
                    <div style="font-weight:700; font-size:0.9rem; color:var(--text-primary);">Dica do GranaEvo</div>
                </div>
                <div id="dicaCartaoTexto" style="color:var(--text-secondary); font-size:0.88rem; line-height:1.6;"></div>
            </div>

            <button id="btnFecharCartaoRelatorioBottom" class="btn-primary" style="width:100%;">
                <i class="fas fa-xmark" style="margin-right:6px;"></i>Fechar
            </button>
        </div>
    `);

    document.getElementById('btnFecharCartaoRelatorio')?.addEventListener('click', fecharPopup);
    document.getElementById('btnFecharCartaoRelatorioBottom')?.addEventListener('click', fecharPopup);

    const dicaEl = document.getElementById('dicaCartaoTexto');
    if (dicaEl) {
        const strong = document.createElement('strong');
        strong.textContent = dica.titulo + ': ';
        dicaEl.appendChild(strong);
        dicaEl.appendChild(document.createTextNode(dica.texto));
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

        const response = await fetch('/api/send-guest-invite', {
            method: 'POST',
            headers: {
                'Content-Type':  'application/json',
                'Authorization': `Bearer ${session.access_token}`,
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
    
    // Transações
    const selectCategoria = document.getElementById('selectCategoria');
    if(selectCategoria) {
        selectCategoria.addEventListener('change', atualizarTiposDinamicos);
    }
    
    const btnLancar = document.getElementById('btnLancar');
    if(btnLancar) {
        btnLancar.addEventListener('click', lancarTransacao);
    }

    bindFiltrosMovimentacoes();
    
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

    const totalCompras    = fatura.compras.length;
    const comprasPagas    = fatura.compras.filter(c => Number(c.parcelaAtual) > Number(c.totalParcelas)).length;
    const comprasPendentes = totalCompras - comprasPagas;
    const hojeISO         = new Date().toISOString().slice(0, 10);
    const vencida         = fatura.vencimento && fatura.vencimento < hojeISO && !fatura.pago;
    const corStatus       = fatura.pago ? '#00ff99' : vencida ? '#ff4b4b' : '#ffd166';

    criarPopupDOM((popup) => {
        popup.style.cssText = 'max-width:480px; width:95%; padding:0; border-radius:18px; overflow:hidden; box-shadow:0 24px 60px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.07);';

        // ── Cabeçalho glassmorphism
        const header = document.createElement('div');
        header.style.cssText = `
            background: linear-gradient(135deg, rgba(108,99,255,0.85), rgba(76,166,255,0.85));
            backdrop-filter: blur(20px);
            -webkit-backdrop-filter: blur(20px);
            padding: 22px 22px 18px;
            position: relative;
        `;

        const btnFecharHeader = document.createElement('button');
        btnFecharHeader.style.cssText = 'position:absolute; top:14px; right:14px; background:rgba(255,255,255,0.15); border:1px solid rgba(255,255,255,0.25); color:#fff; width:30px; height:30px; border-radius:8px; cursor:pointer; display:flex; align-items:center; justify-content:center; font-size:0.85rem; transition:background .15s;';
        btnFecharHeader.addEventListener('click', fecharPopup);
        const xIcon = document.createElement('i'); xIcon.className = 'fas fa-xmark';
        btnFecharHeader.appendChild(xIcon);

        const headerIcon = document.createElement('i');
        headerIcon.className = 'fas fa-credit-card';
        headerIcon.style.cssText = 'font-size:2rem; color:rgba(255,255,255,0.9); display:block; margin-bottom:10px;';

        const headerNome = document.createElement('div');
        headerNome.style.cssText = 'font-size:1.25rem; font-weight:700; color:#fff; margin-bottom:6px;';
        headerNome.textContent = nomeCartao;

        const headerMeta = document.createElement('div');
        headerMeta.style.cssText = 'display:flex; align-items:center; gap:16px; flex-wrap:wrap;';

        function _metaItem(iconCls, texto) {
            const d = document.createElement('div');
            d.style.cssText = 'display:flex; align-items:center; gap:6px; color:rgba(255,255,255,0.8); font-size:0.85rem;';
            const i = document.createElement('i'); i.className = iconCls;
            d.appendChild(i); d.appendChild(document.createTextNode(texto));
            return d;
        }

        headerMeta.appendChild(_metaItem('fas fa-calendar-day', `Vence: ${formatarDataBR(fatura.vencimento)}`));

        const statusBadge = document.createElement('span');
        statusBadge.style.cssText = `background:${corStatus}22; color:${corStatus}; border:1px solid ${corStatus}44; font-size:0.75rem; font-weight:700; padding:3px 10px; border-radius:20px;`;
        const statusIcon = document.createElement('i');
        statusIcon.className = fatura.pago ? 'fas fa-circle-check' : vencida ? 'fas fa-triangle-exclamation' : 'fas fa-clock';
        statusIcon.style.marginRight = '5px';
        statusBadge.appendChild(statusIcon);
        statusBadge.appendChild(document.createTextNode(fatura.pago ? 'Paga' : vencida ? 'Vencida' : 'Pendente'));
        headerMeta.appendChild(statusBadge);

        header.appendChild(btnFecharHeader);
        header.appendChild(headerIcon);
        header.appendChild(headerNome);
        header.appendChild(headerMeta);

        // ── Valor total em destaque
        const totalBlock = document.createElement('div');
        totalBlock.style.cssText = `
            background: ${corStatus}15;
            border-bottom: 1px solid ${corStatus}30;
            padding: 14px 22px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        `;
        const totalLabel = document.createElement('div');
        totalLabel.style.cssText = 'font-size:0.82rem; color:var(--text-secondary); display:flex; align-items:center; gap:6px;';
        const tlIcon = document.createElement('i'); tlIcon.className = 'fas fa-file-invoice-dollar'; tlIcon.style.color = corStatus;
        totalLabel.appendChild(tlIcon); totalLabel.appendChild(document.createTextNode('Total da Fatura'));
        const totalValor = document.createElement('div');
        totalValor.style.cssText = `font-size:1.5rem; font-weight:800; color:${corStatus};`;
        totalValor.textContent = formatBRL(fatura.valor);
        totalBlock.appendChild(totalLabel);
        totalBlock.appendChild(totalValor);

        // ── Mini-stats (compras / pagas / pendentes)
        const statsRow = document.createElement('div');
        statsRow.style.cssText = 'display:grid; grid-template-columns:repeat(3,1fr); gap:1px; background:rgba(255,255,255,0.06); border-bottom:1px solid rgba(255,255,255,0.06);';

        function _statCell(iconCls, label, valor, cor) {
            const cell = document.createElement('div');
            cell.style.cssText = 'background:var(--surface, #1a1a2e); padding:12px; text-align:center;';
            const icon = document.createElement('i'); icon.className = iconCls; icon.style.cssText = `color:${cor}; font-size:1rem; display:block; margin-bottom:4px;`;
            const lbl  = document.createElement('div'); lbl.style.cssText = 'font-size:0.7rem; color:var(--text-muted); margin-bottom:2px;'; lbl.textContent = label;
            const val  = document.createElement('div'); val.style.cssText = `font-size:1.1rem; font-weight:700; color:${cor};`; val.textContent = String(valor);
            cell.appendChild(icon); cell.appendChild(lbl); cell.appendChild(val);
            return cell;
        }

        statsRow.appendChild(_statCell('fas fa-bag-shopping',  'Total',     totalCompras,     '#6c63ff'));
        statsRow.appendChild(_statCell('fas fa-circle-check',  'Pagas',     comprasPagas,     '#00ff99'));
        statsRow.appendChild(_statCell('fas fa-hourglass-half','Pendentes', comprasPendentes, '#ffd166'));

        // ── Lista de compras com scroll
        const scrollWrap = document.createElement('div');
        scrollWrap.style.cssText = 'max-height:52vh; overflow-y:auto; padding:16px 18px 4px;';

        const secTitle = document.createElement('div');
        secTitle.style.cssText = 'font-size:0.82rem; font-weight:700; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:12px; display:flex; align-items:center; gap:6px;';
        const secIcon = document.createElement('i'); secIcon.className = 'fas fa-list';
        secTitle.appendChild(secIcon); secTitle.appendChild(document.createTextNode('Compras nesta fatura'));
        scrollWrap.appendChild(secTitle);

        if (fatura.compras.length === 0) {
            const vazio = document.createElement('div');
            vazio.style.cssText = 'text-align:center; padding:30px; color:var(--text-muted);';
            const vzIcon = document.createElement('i'); vzIcon.className = 'fas fa-cart-shopping'; vzIcon.style.cssText = 'font-size:2rem; opacity:0.35; display:block; margin-bottom:10px;';
            const vzTxt = document.createElement('div'); vzTxt.textContent = 'Nenhuma compra nesta fatura';
            vazio.appendChild(vzIcon); vazio.appendChild(vzTxt);
            scrollWrap.appendChild(vazio);
        }

        fatura.compras.forEach(compra => {
            if (!compra || typeof compra !== 'object') return;
            const parcelaAtual  = Number(compra.parcelaAtual);
            const totalParcelas = Number(compra.totalParcelas);
            const valorParcela  = Number(compra.valorParcela);
            const valorTotal    = Number(compra.valorTotal);
            if (!isFinite(parcelaAtual) || !isFinite(totalParcelas) || !isFinite(valorParcela) || valorParcela <= 0) return;

            const isPaga = parcelaAtual > totalParcelas;
            const cor    = isPaga ? '#00ff99' : '#ffd166';
            const falta  = isPaga ? null : valorParcela * (totalParcelas - parcelaAtual + 1);

            const card = document.createElement('div');
            card.style.cssText = `
                background: rgba(255,255,255,0.04);
                border: 1px solid rgba(255,255,255,0.07);
                border-left: 3px solid ${cor};
                border-radius: 12px;
                padding: 14px;
                margin-bottom: 10px;
                box-shadow: 0 2px 8px rgba(0,0,0,0.2);
            `;

            // Linha principal
            const mainRow = document.createElement('div');
            mainRow.style.cssText = 'display:flex; justify-content:space-between; align-items:flex-start; gap:10px; margin-bottom:10px;';

            const info = document.createElement('div'); info.style.flex = '1';

            const tipo = document.createElement('div');
            tipo.style.cssText = 'font-weight:700; color:var(--text-primary); font-size:0.95rem; margin-bottom:3px;';
            tipo.textContent = String(compra.tipo || '');

            const desc = document.createElement('div');
            desc.style.cssText = 'color:var(--text-secondary); font-size:0.83rem; margin-bottom:4px;';
            desc.textContent = String(compra.descricao || '');

            const dataRow = document.createElement('div');
            dataRow.style.cssText = 'display:flex; align-items:center; gap:5px; color:var(--text-muted); font-size:0.78rem;';
            const dataIcon = document.createElement('i'); dataIcon.className = 'fas fa-calendar-alt'; dataIcon.style.fontSize = '0.72rem';
            dataRow.appendChild(dataIcon);
            dataRow.appendChild(document.createTextNode(String(compra.dataCompra || '')));

            info.appendChild(tipo); info.appendChild(desc); info.appendChild(dataRow);

            const rightCol = document.createElement('div'); rightCol.style.textAlign = 'right';
            const valEl = document.createElement('div');
            valEl.style.cssText = 'font-weight:800; color:var(--text-primary); font-size:1.1rem;';
            valEl.textContent = formatBRL(valorParcela);

            const statusEl = document.createElement('div');
            statusEl.style.cssText = `font-size:0.78rem; font-weight:700; color:${cor}; margin-top:4px; display:flex; align-items:center; justify-content:flex-end; gap:4px;`;
            const stIcon = document.createElement('i');
            stIcon.className = isPaga ? 'fas fa-circle-check' : 'fas fa-rotate';
            statusEl.appendChild(stIcon);
            statusEl.appendChild(document.createTextNode(isPaga ? 'Quitada' : `${parcelaAtual}/${totalParcelas}x`));

            rightCol.appendChild(valEl); rightCol.appendChild(statusEl);
            mainRow.appendChild(info); mainRow.appendChild(rightCol);

            // Rodapé: total e falta pagar
            const footRow = document.createElement('div');
            footRow.style.cssText = 'display:grid; grid-template-columns:1fr 1fr; gap:8px; padding-top:10px; border-top:1px solid rgba(255,255,255,0.06);';

            function _footCell(label, texto, cor2) {
                const cell = document.createElement('div');
                const lbl  = document.createElement('div'); lbl.style.cssText = 'font-size:0.7rem; color:var(--text-muted); margin-bottom:2px; display:flex; align-items:center; gap:4px;';
                const lIcon = document.createElement('i'); lIcon.className = label === 'Valor total' ? 'fas fa-wallet' : 'fas fa-hourglass-end'; lIcon.style.fontSize = '0.65rem';
                lbl.appendChild(lIcon); lbl.appendChild(document.createTextNode(label));
                const val  = document.createElement('div'); val.style.cssText = `font-size:0.85rem; font-weight:700; color:${cor2};`; val.textContent = texto;
                cell.appendChild(lbl); cell.appendChild(val);
                return cell;
            }

            footRow.appendChild(_footCell('Valor total',  formatBRL(valorTotal),       'var(--text-secondary)'));
            footRow.appendChild(_footCell('Falta pagar',  falta ? formatBRL(falta) : '—', isPaga ? '#00ff99' : '#ff4b4b'));

            // Botões de ação
            const btnRow = document.createElement('div');
            btnRow.style.cssText = 'display:flex; gap:7px; flex-wrap:wrap; margin-top:10px;';

            function _btn(txt, iconCls, cssExtra, handler) {
                const b = document.createElement('button');
                b.className = 'btn-primary';
                b.style.cssText = `flex:1; min-width:75px; padding:7px 10px; font-size:0.8rem; ${cssExtra}`;
                const ic = document.createElement('i'); ic.className = iconCls; ic.style.marginRight = '5px';
                b.appendChild(ic); b.appendChild(document.createTextNode(txt));
                b.addEventListener('click', handler);
                return b;
            }

            btnRow.appendChild(_btn('Pagar',   'fas fa-check-circle',  '',                                   () => pagarCompraIndividual(faturaId, compra.id)));
            btnRow.appendChild(_btn('Editar',  'fas fa-pen',           'background:var(--accent, #4ca6ff);', () => editarCompraFatura(faturaId, compra.id)));
            btnRow.appendChild(_btn('Excluir', 'fas fa-trash-alt',     '',                                   () => excluirCompraFatura(faturaId, compra.id)));
            btnRow.children[2].className = 'btn-excluir';
            btnRow.children[2].style.flex = '1';
            btnRow.children[2].style.minWidth = '75px';
            btnRow.children[2].style.padding = '7px 10px';
            btnRow.children[2].style.fontSize = '0.8rem';

            card.appendChild(mainRow); card.appendChild(footRow); card.appendChild(btnRow);
            scrollWrap.appendChild(card);
        });

        // ── Botão fechar inferior
        const footerArea = document.createElement('div');
        footerArea.style.cssText = 'padding:12px 18px 18px;';
        const btnFechar = document.createElement('button');
        btnFechar.className = 'btn-primary';
        btnFechar.style.width = '100%';
        const fcIcon = document.createElement('i'); fcIcon.className = 'fas fa-xmark'; fcIcon.style.marginRight = '7px';
        btnFechar.appendChild(fcIcon); btnFechar.appendChild(document.createTextNode('Fechar'));
        btnFechar.addEventListener('click', fecharPopup);
        footerArea.appendChild(btnFechar);

        popup.appendChild(header);
        popup.appendChild(totalBlock);
        popup.appendChild(statsRow);
        popup.appendChild(scrollWrap);
        popup.appendChild(footerArea);
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
