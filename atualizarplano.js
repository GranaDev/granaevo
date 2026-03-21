/* =============================================
   GRANAEVO - ATUALIZAR PLANO JS  v2.1
   ============================================= */

import { supabase } from './supabase-client.js?v=2';
import AuthGuard from './auth-guard.js?v=2';

// ========== [F1] TRUSTED TYPES POLICY ==========
//
// Impede que qualquer string arbitrária seja atribuída a sinks perigosos
// (innerHTML, outerHTML, document.write, eval, etc.).
// O browser só aceita objetos TrustedHTML criados por esta policy.
//
// O único uso legítimo de innerHTML neste arquivo é o parsing de SVG
// via <template> — que é inerte por definição. Todos os outros lugares
// já usam DOM API segura (textContent, createElement, appendChild,
// replaceChildren).
//
// Diretivas CSP necessárias (já no HTML):
//   require-trusted-types-for 'script'
//   trusted-types granaevo-policy
//
// Fallback: browsers sem suporte (Safari < 16) recebem null e o código
// continua funcional sem a proteção extra.
const _TrustedPolicy = (() => {
    if (typeof trustedTypes === 'undefined') return null;

    return trustedTypes.createPolicy('granaevo-policy', {
        /**
         * Única operação HTML permitida: parsing de SVG via <template>.
         * A string é validada antes de ser aceita como TrustedHTML.
         * A sanitização real ainda ocorre em _sanitizarSVG() logo após.
         */
        createHTML(input) {
            if (typeof input !== 'string') {
                throw new TypeError('[TrustedTypes] createHTML: input deve ser string');
            }
            if (!input.trim().toLowerCase().startsWith('<svg')) {
                throw new Error('[TrustedTypes] createHTML: apenas SVG permitido nesta policy');
            }
            return input;
        },

        /** Scripts inline são proibidos — nonce na CSP cobre esse caso. */
        createScript() {
            throw new Error('[TrustedTypes] createScript: operação não permitida');
        },

        /** URLs de script dinâmicas são proibidas. */
        createScriptURL() {
            throw new Error('[TrustedTypes] createScriptURL: operação não permitida');
        },
    });
})();

// ========== CONFIGURAÇÕES DE PLANOS ==========
const PLANOS_CONFIG = {
    "Individual": {
        nome: "Individual",
        preco: 19.99,
        icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="8" r="4"/>
                <path d="M6 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2"/>
              </svg>`,
        perfis: 1,
        features: [
            "1 perfil de usuário",
            "Dashboard completo",
            "Controle de cartões",
            "Metas e reservas",
            "Relatórios detalhados"
        ]
    },
    "Casal": {
        nome: "Casal",
        preco: 29.99,
        icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
                <circle cx="8.5" cy="7" r="4"/>
                <path d="M20 8v6M23 11h-6"/>
              </svg>`,
        perfis: 2,
        features: [
            "2 perfis de usuário",
            "Dashboard completo",
            "Controle de cartões",
            "Metas e reservas",
            "Relatórios detalhados",
            "Visão compartilhada"
        ]
    },
    "Família": {
        nome: "Família",
        preco: 49.99,
        icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
                <circle cx="9" cy="7" r="4"/>
                <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>
              </svg>`,
        perfis: 4,
        features: [
            "4 perfis de usuário",
            "Dashboard completo",
            "Controle de cartões",
            "Metas e reservas",
            "Relatórios detalhados",
            "Controle centralizado",
            "Análises comparativas"
        ]
    }
};

// ========== TABELA DE UPGRADES VÁLIDOS ==========
// Object.freeze() duplo: externo congela as chaves, interno congela cada entrada.
// Backend DEVE revalidar — esta tabela é apenas referência de UX.
const UPGRADES_VALIDOS = Object.freeze({
    "Individual→Casal":   Object.freeze({ de: "Individual", para: "Casal",   valor: 10.00 }),
    "Individual→Família": Object.freeze({ de: "Individual", para: "Família", valor: 30.00 }),
    "Casal→Família":      Object.freeze({ de: "Casal",      para: "Família", valor: 20.00 }),
});

function obterUpgradeValido(planoAtual, novoPlano) {
    const chave = `${planoAtual}→${novoPlano}`;
    return UPGRADES_VALIDOS[chave] || null;
}

// ========== SESSÃO DO USUÁRIO — CLOSURE PROTEGIDA ==========
//
// set() só funciona uma vez — tentativas subsequentes são ignoradas.
// get() retorna o objeto congelado.
// _usuario é inacessível externamente (escopo léxico da IIFE).
const UsuarioSessao = (() => {
    let _usuario = null;

    return Object.freeze({
        set(user) {
            if (_usuario !== null) return;
            _usuario = Object.freeze({
                nome:       user.nome,
                planoAtual: user.plano,
                userId:     user.userId,
                email:      user.email,
                isGuest:    user.isGuest,
                ownerEmail: user.ownerEmail || null,
            });
        },
        get() {
            return _usuario;
        },
    });
})();

// ========== RATE LIMIT VISUAL ==========
//
// [FIX2] O cooldown foi movido da função processarUpgrade() para o handler
// do botão confirmar dentro de criarPopupUpgrade(). Desta forma:
//   - Abrir/fechar o popup não consome o cooldown (ação local, sem risco).
//   - Apenas tentativas reais de chamar a API são throttled.
//   - UX melhorada: usuário pode inspecionar planos livremente.
const _Cooldown = (() => {
    let _ativo = false;
    const _MS  = 8000;

    return Object.freeze({
        verificarEAtivar() {
            if (_ativo) {
                _mostrarFeedback('⏳ Aguarde alguns segundos antes de tentar novamente.', 'aviso');
                return false;
            }
            _ativo = true;
            setTimeout(() => { _ativo = false; }, _MS);
            return true;
        },
        resetar() {
            _ativo = false;
        },
    });
})();

// ========== [F3] GERADOR DE JTI (JWT ID) ==========
//
// Anti-token replay: cada request sensível recebe um UUID v4 único (jti).
//
// Fluxo:
//   1. Frontend gera jti → envia no body do POST
//   2. Backend recebe jti → checa se já foi usado nesta sessão
//   3. Backend marca jti como usado → qualquer reenvio é rejeitado com 409
//
// Mesmo que um atacante intercepte um CSRF token válido, não consegue
// reutilizá-lo porque o jti associado já foi consumido.
//
// Sugestão de implementação no backend (Supabase Edge Function / Node):
//
//   const usedJtis = new Set(); // use Redis/DB em produção para persistência
//
//   if (usedJtis.has(body.jti)) {
//     return new Response(JSON.stringify({ error: 'Token já utilizado' }), { status: 409 });
//   }
//   usedJtis.add(body.jti);
//   setTimeout(() => usedJtis.delete(body.jti), 60_000); // TTL de 60s
//
// crypto.randomUUID() disponível em: Chrome 92+, Firefox 95+, Safari 15.4+, Node 14.17+
function _gerarJti() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    // Fallback seguro: 128 bits via getRandomValues (mesma entropia do UUID v4)
    const arr = new Uint8Array(16);
    crypto.getRandomValues(arr);
    arr[6] = (arr[6] & 0x0f) | 0x40; // version 4
    arr[8] = (arr[8] & 0x3f) | 0x80; // variant RFC 4122
    return [...arr].map((b, i) =>
        [4, 6, 8, 10].includes(i)
            ? `-${b.toString(16).padStart(2, '0')}`
            : b.toString(16).padStart(2, '0')
    ).join('');
}

// ========== PROTEÇÃO ANTI-CLICKJACKING ==========
(function _protegerContraClickjacking() {
    try {
        if (window.top !== window.self) {
            window.top.location.replace(window.self.location.href);
        }
    } catch {
        // iframe cross-origin: bloqueado pelo frame-ancestors 'none' na CSP
    }
})();

// ========== UTILITÁRIOS DE FEEDBACK ==========
function _mostrarFeedback(mensagem, tipo = 'erro') {
    const ESTILOS = {
        erro:  { fundo: '#ef4444', sombra: 'rgba(239,68,68,0.4)'  },
        aviso: { fundo: '#f59e0b', sombra: 'rgba(245,158,11,0.4)' },
    };

    const estilo = ESTILOS[tipo] ?? ESTILOS.erro;

    const toast = document.createElement('div');
    toast.setAttribute('role', 'alert');
    toast.setAttribute('aria-live', 'assertive');

    Object.assign(toast.style, {
        position:     'fixed',
        bottom:       '32px',
        left:         '50%',
        transform:    'translateX(-50%)',
        background:   estilo.fundo,
        color:        'white',
        padding:      '14px 28px',
        borderRadius: '12px',
        fontWeight:   '600',
        fontSize:     '0.95rem',
        zIndex:       '99999',
        boxShadow:    `0 8px 24px ${estilo.sombra}`,
        maxWidth:     '90vw',
        textAlign:    'center',
    });

    toast.textContent = mensagem;
    document.body.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity    = '0';
        toast.style.transition = 'opacity 0.3s';
        setTimeout(() => {
            if (document.body.contains(toast)) document.body.removeChild(toast);
        }, 300);
    }, 4000);
}

// ========== SANITIZAÇÃO DE SVG ==========
const _SVG_TAGS_PROIBIDAS = new Set([
    'script', 'foreignobject', 'iframe', 'embed', 'object',
    'link', 'meta', 'use', 'animate', 'set', 'image', 'pattern', 'feimage',
]);

function _sanitizarSVG(svgEl) {
    // 1ª passagem: remove tags proibidas (reversed: folha → raiz)
    Array.from(svgEl.querySelectorAll('*')).reverse().forEach(el => {
        if (_SVG_TAGS_PROIBIDAS.has(el.tagName.toLowerCase())) el.remove();
    });

    // 2ª passagem: remove atributos on* e URLs javascript:/data:
    [svgEl, ...svgEl.querySelectorAll('*')].forEach(el => {
        [...el.attributes].forEach(attr => {
            const nome  = attr.name.toLowerCase();
            const valor = attr.value.trim().toLowerCase();

            if (nome.startsWith('on')) {
                el.removeAttribute(attr.name);
                return;
            }

            if (['href', 'src', 'action', 'xlink:href', 'data'].includes(nome)) {
                if (valor.startsWith('javascript:') || valor.startsWith('data:')) {
                    el.removeAttribute(attr.name);
                }
            }
        });
    });

    return svgEl;
}

function _parsearESanitizarSVG(svgString) {
    if (typeof svgString !== 'string' || !svgString.trim()) return null;

    const template = document.createElement('template');

    // [F1] TrustedHTML via policy — rejeita strings que não comecem com <svg
    // antes mesmo do parsing. Fallback seguro para browsers sem suporte.
    try {
        template.innerHTML = _TrustedPolicy
            ? _TrustedPolicy.createHTML(svgString)
            : svgString;
    } catch (err) {
        console.warn('[TrustedTypes] SVG rejeitado pela policy:', err.message);
        return null;
    }

    const svgEl = template.content.firstElementChild;
    if (!svgEl || svgEl.tagName.toLowerCase() !== 'svg') {
        console.warn('[SEGURANÇA] SVG inválido após parsing:', svgEl?.tagName);
        return null;
    }

    return _sanitizarSVG(svgEl);
}

// ========== VALIDAÇÃO DE URL DE PAGAMENTO ==========
//
// Valida: protocolo https + hostname whitelist + pathname esperado + query length.
// Impede open redirect mesmo que a resposta do backend seja manipulada.
const _DOMINIOS_PAGAMENTO_PERMITIDOS = new Set([
    'checkout.stripe.com',
    'pay.granaevo.com',
]);

function _validarUrlPagamento(url) {
    if (!url || typeof url !== 'string') return false;
    try {
        const parsed   = new URL(url);
        const hostname = parsed.hostname.toLowerCase();

        if (parsed.protocol !== 'https:') {
            console.warn('[SEGURANÇA] URL sem HTTPS:', parsed.protocol);
            return false;
        }

        if (!_DOMINIOS_PAGAMENTO_PERMITIDOS.has(hostname)) {
            console.warn('[SEGURANÇA] Domínio não autorizado:', hostname);
            return false;
        }

        if (hostname === 'checkout.stripe.com') {
            if (!parsed.pathname.startsWith('/c/pay/')) {
                console.warn('[SEGURANÇA] Pathname inválido (Stripe):', parsed.pathname);
                return false;
            }
        }

        if (hostname === 'pay.granaevo.com') {
            if (!parsed.pathname.startsWith('/checkout/')) {
                console.warn('[SEGURANÇA] Pathname inválido (gateway):', parsed.pathname);
                return false;
            }
        }

        if (parsed.search.length > 2000) {
            console.warn('[SEGURANÇA] Query string suspeita:', parsed.search.length, 'chars');
            return false;
        }

        return true;
    } catch {
        console.warn('[SEGURANÇA] URL malformada:', url);
        return false;
    }
}

// ========== LEITURA DO CSRF TOKEN ==========
//
// Token gerado pelo servidor, injetado em <meta name="csrf-token">.
// Ausência bloqueia o request no cliente.
function _lerCsrfToken() {
    return document.querySelector('meta[name="csrf-token"]')?.content ?? null;
}

// ========== FETCH COM TIMEOUT ==========
const _FETCH_TIMEOUT_MS = 10000;

async function _fetchComTimeout(url, options = {}, timeout = _FETCH_TIMEOUT_MS) {
    const controller = new AbortController();
    const timerId    = setTimeout(() => controller.abort(), timeout);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timerId);
    }
}

// ========== FOCUS TRAP — UTILITÁRIO PARA MODAL ==========
//
// [FIX4] Garante que Tab e Shift+Tab não saiam do modal enquanto ele
// está aberto. Elementos focáveis são listados por seletor padrão WCAG.
// Quando o foco chegaria a sair do modal, redireciona para o extremo
// oposto (loop). Retorna a função de cleanup para ser chamada em
// fecharOverlay().
function _criarFocusTrap(containerEl) {
    const SELETOR_FOCAVEL = [
        'a[href]',
        'button:not([disabled])',
        'input:not([disabled])',
        'select:not([disabled])',
        'textarea:not([disabled])',
        '[tabindex]:not([tabindex="-1"])',
    ].join(', ');

    const handler = (e) => {
        if (e.key !== 'Tab') return;

        const focaveis = Array.from(containerEl.querySelectorAll(SELETOR_FOCAVEL))
            .filter(el => !el.closest('[hidden]') && el.offsetParent !== null);

        if (focaveis.length === 0) {
            e.preventDefault();
            return;
        }

        const primeiro = focaveis[0];
        const ultimo   = focaveis[focaveis.length - 1];

        if (e.shiftKey) {
            // Shift+Tab: se o foco está no primeiro elemento, vai para o último
            if (document.activeElement === primeiro) {
                e.preventDefault();
                ultimo.focus();
            }
        } else {
            // Tab: se o foco está no último elemento, volta para o primeiro
            if (document.activeElement === ultimo) {
                e.preventDefault();
                primeiro.focus();
            }
        }
    };

    containerEl.addEventListener('keydown', handler);

    // Retorna cleanup function
    return () => containerEl.removeEventListener('keydown', handler);
}

// ========== VERIFICAÇÃO DE LOGIN ==========
async function verificarLogin() {
    const authLoading = document.getElementById('loadingScreen');

    await AuthGuard.protect({
        requirePlan:      true,
        allowGuest:       true,
        guestCanUpgrade:  false,
        loadingElementId: 'loadingScreen',
        redirectOnFail:   true,

        onSuccess: async (user) => {
            UsuarioSessao.set(user);
            if (authLoading) setTimeout(() => authLoading.classList.add('hidden'), 800);

            if (UsuarioSessao.get().isGuest) {
                _exibirAvisoConvidado(UsuarioSessao.get());
                return;
            }

            inicializarPagina();
        },

        onFail: (error) => {
            console.error(`🔒 [UPGRADE PAGE] Auth falhou: ${error?.code}`);
        },
    });
}

// ========== AVISO PARA CONVIDADOS ==========
function _exibirAvisoConvidado(user) {
    const container = document.querySelector('.upgrade-container') ||
                      document.querySelector('main') ||
                      document.body;

    const aviso = document.createElement('div');
    aviso.style.cssText = `
        max-width:520px; margin:80px auto; padding:40px;
        background:linear-gradient(135deg, #1a1d3a, #0d0f1f);
        border:1px solid rgba(255,209,102,0.3); border-radius:20px;
        text-align:center; box-shadow:0 20px 60px rgba(0,0,0,0.5);
    `;

    const icone = document.createElement('div');
    icone.setAttribute('aria-hidden', 'true');
    icone.style.cssText = 'font-size:3rem; margin-bottom:16px;';
    icone.textContent = '🔒';

    const titulo = document.createElement('h2');
    titulo.style.cssText = 'color:#ffd166; font-size:1.6rem; margin-bottom:12px;';
    titulo.textContent = 'Acesso Restrito';

    const paragrafo = document.createElement('p');
    paragrafo.style.cssText = 'color:#9ca3af; line-height:1.7; margin-bottom:24px;';

    const nos = [
        document.createTextNode('Você acessa o GranaEvo como '),
        Object.assign(document.createElement('strong'), { style: 'color:white', textContent: 'convidado' }),
        document.createTextNode(' da conta de '),
        Object.assign(document.createElement('strong'), { style: 'color:#6c63ff', textContent: user.ownerEmail || 'outro usuário' }),
        document.createTextNode('.'),
        document.createElement('br'),
        document.createElement('br'),
        document.createTextNode('Apenas o '),
        Object.assign(document.createElement('strong'), { style: 'color:white', textContent: 'titular da conta' }),
        document.createTextNode(' pode gerenciar e atualizar o plano.'),
    ];
    nos.forEach(n => paragrafo.appendChild(n));

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.style.cssText = `
        padding:14px 32px; background:linear-gradient(135deg,#6c63ff,#4a42cc);
        border:none; border-radius:12px; color:white; font-size:1rem;
        font-weight:700; cursor:pointer; box-shadow:0 4px 16px rgba(108,99,255,0.4);
        font-family:inherit;
    `;
    btn.textContent = '← Voltar ao Dashboard';
    btn.addEventListener('click', () => { window.location.href = 'dashboard.html'; });

    aviso.appendChild(icone);
    aviso.appendChild(titulo);
    aviso.appendChild(paragrafo);
    aviso.appendChild(btn);

    // [FIX1] replaceChildren() em vez de innerHTML = '' + appendChild().
    // Alinha com o padrão seguro do restante do código.
    container.replaceChildren(aviso);
}

// ========== INICIALIZAÇÃO ==========
function inicializarPagina() {
    exibirPlanoAtual();
    renderizarCardsUpgrade();
    configurarFAQ();
    inicializarParticulas();
}

// ========== EXIBIR PLANO ATUAL ==========
function exibirPlanoAtual() {
    const usuario    = UsuarioSessao.get();
    const planoAtual = usuario.planoAtual;
    const config     = PLANOS_CONFIG[planoAtual];

    if (!config) {
        console.error('[UPGRADE] Plano não encontrado:', planoAtual);
        return;
    }

    const planoDisplay = document.getElementById('planoAtualDisplay');
    if (planoDisplay) {
        planoDisplay.replaceChildren();
        const wrapper  = document.createElement('strong');
        const span     = document.createElement('span');
        span.style.cssText = 'display:inline-flex; align-items:center; gap:8px; vertical-align:middle;';
        const svgEl = _parsearESanitizarSVG(config.icon);
        if (svgEl) span.appendChild(svgEl);
        const nomeSpan = document.createElement('span');
        nomeSpan.textContent = config.nome;
        span.appendChild(nomeSpan);
        wrapper.appendChild(span);
        planoDisplay.appendChild(wrapper);
    }

    const currentPlanCard = document.getElementById('currentPlanCard');
    if (currentPlanCard) {
        currentPlanCard.replaceChildren();

        const tituloDiv = document.createElement('div');
        tituloDiv.className = 'current-plan-title';
        tituloDiv.textContent = '📌 Seu Plano Atual';

        const nomeDiv = document.createElement('div');
        nomeDiv.className = 'current-plan-name';

        const svgIconCard = _parsearESanitizarSVG(config.icon);
        if (svgIconCard) {
            const iconWrapper = document.createElement('span');
            iconWrapper.className = 'plan-icon-wrapper';
            iconWrapper.appendChild(svgIconCard);
            nomeDiv.appendChild(iconWrapper);
        }
        const nomeSpan = document.createElement('span');
        nomeSpan.textContent = config.nome;
        nomeDiv.appendChild(nomeSpan);

        const featuresDiv = document.createElement('div');
        featuresDiv.className = 'current-plan-features';

        const badgePerfis = document.createElement('div');
        badgePerfis.className = 'feature-badge';
        badgePerfis.textContent = `${config.perfis} ${config.perfis === 1 ? 'perfil' : 'perfis'}`;

        const badgePreco = document.createElement('div');
        badgePreco.className = 'feature-badge';
        badgePreco.textContent = `💰 R$ ${config.preco.toFixed(2)}`;

        const badgeVitalicio = document.createElement('div');
        badgeVitalicio.className = 'feature-badge';
        badgeVitalicio.textContent = '✅ Acesso Vitalício';

        featuresDiv.appendChild(badgePerfis);
        featuresDiv.appendChild(badgePreco);
        featuresDiv.appendChild(badgeVitalicio);

        currentPlanCard.appendChild(tituloDiv);
        currentPlanCard.appendChild(nomeDiv);
        currentPlanCard.appendChild(featuresDiv);
    }
}

// ========== RENDERIZAR CARDS DE UPGRADE ==========
function renderizarCardsUpgrade() {
    const usuario    = UsuarioSessao.get();
    const planoAtual = usuario.planoAtual;
    const grid       = document.getElementById('upgradeCardsGrid');

    if (!grid) return;

    if (!PLANOS_CONFIG[planoAtual]) {
        console.error('[SEGURANÇA] Plano atual inválido:', planoAtual);
        return;
    }

    grid.replaceChildren();
    const ordenacao = ["Individual", "Casal", "Família"];

    ordenacao.forEach(nomePlano => {
        const config           = PLANOS_CONFIG[nomePlano];
        const upgradeInfo      = obterUpgradeValido(planoAtual, nomePlano);
        const isUpgrade        = upgradeInfo !== null;
        const isCurrentOrLower = !isUpgrade;
        const valorUpgrade     = isUpgrade ? upgradeInfo.valor : 0;

        const precoNovoConfig = config.preco;
        const economiaExibida = (precoNovoConfig - valorUpgrade).toFixed(2);
        const perfisDiferenca = config.perfis - PLANOS_CONFIG[planoAtual].perfis;

        const subtituloTexto = isCurrentOrLower
            ? (nomePlano === planoAtual ? 'Seu plano atual' : 'Plano inferior')
            : `Adicione ${perfisDiferenca} perfil${perfisDiferenca > 1 ? 's' : ''} extra${perfisDiferenca > 1 ? 's' : ''}`;

        const card = document.createElement('div');
        card.className = 'upgrade-card';
        card.setAttribute('role', 'listitem');
        if (isUpgrade && valorUpgrade <= 20) card.classList.add('recommended');

        if (isUpgrade && valorUpgrade <= 20) {
            const badge = document.createElement('div');
            badge.className = 'upgrade-badge';
            badge.textContent = '⭐ Recomendado';
            card.appendChild(badge);
        }

        const header = document.createElement('div');
        header.className = 'upgrade-header';

        const iconDiv = document.createElement('div');
        iconDiv.className = 'upgrade-icon';
        const svgEl = _parsearESanitizarSVG(config.icon);
        if (svgEl) iconDiv.appendChild(svgEl);

        const nameDiv = document.createElement('div');
        nameDiv.className = 'upgrade-name';
        nameDiv.textContent = config.nome;

        const subDiv = document.createElement('div');
        subDiv.className = 'upgrade-subtitle';
        subDiv.textContent = subtituloTexto;

        header.appendChild(iconDiv);
        header.appendChild(nameDiv);
        header.appendChild(subDiv);
        card.appendChild(header);

        const pricingDiv = document.createElement('div');
        pricingDiv.className = 'upgrade-pricing';

        if (isUpgrade) {
            const originalEl = document.createElement('div');
            originalEl.className = 'original-price';
            originalEl.textContent = `De: R$ ${precoNovoConfig.toFixed(2)}`;

            const priceRow = document.createElement('div');
            priceRow.className = 'upgrade-price';

            const labelEl = document.createElement('span');
            labelEl.className = 'price-label';
            labelEl.textContent = 'Pague apenas:';

            const amountEl = document.createElement('span');
            amountEl.className = 'price-amount';
            amountEl.textContent = `R$ ${valorUpgrade.toFixed(2)}`;

            priceRow.appendChild(labelEl);
            priceRow.appendChild(amountEl);

            const savingsEl = document.createElement('div');
            savingsEl.className = 'price-savings';
            savingsEl.textContent = `💎 Economize R$ ${economiaExibida}`;

            pricingDiv.appendChild(originalEl);
            pricingDiv.appendChild(priceRow);
            pricingDiv.appendChild(savingsEl);
        } else {
            const statusRow = document.createElement('div');
            statusRow.className = 'upgrade-price';
            const statusEl = document.createElement('span');
            statusEl.className = 'price-amount';
            statusEl.style.cssText = 'font-size:1.5rem; color:var(--gray);';
            statusEl.textContent = nomePlano === planoAtual ? '✅ Ativo' : '❌ Indisponível';
            statusRow.appendChild(statusEl);
            pricingDiv.appendChild(statusRow);
        }

        card.appendChild(pricingDiv);

        const featuresList = document.createElement('ul');
        featuresList.className = 'upgrade-features';

        config.features.forEach(feature => {
            const li = document.createElement('li');
            const checkSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            checkSvg.setAttribute('viewBox', '0 0 24 24');
            checkSvg.setAttribute('fill', 'none');
            checkSvg.setAttribute('aria-hidden', 'true');
            const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
            poly.setAttribute('points', '20 6 9 17 4 12');
            poly.setAttribute('stroke', 'currentColor');
            poly.setAttribute('stroke-width', '2');
            poly.setAttribute('stroke-linecap', 'round');
            checkSvg.appendChild(poly);
            li.appendChild(checkSvg);
            li.appendChild(document.createTextNode(feature));
            featuresList.appendChild(li);
        });

        card.appendChild(featuresList);

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `btn-upgrade${isCurrentOrLower ? ' disabled' : ''}`;
        if (isCurrentOrLower) {
            btn.disabled = true;
            btn.setAttribute('aria-disabled', 'true');
        }
        btn.textContent = isCurrentOrLower
            ? (nomePlano === planoAtual ? '✅ Plano Atual' : '⬇️ Downgrade Indisponível')
            : `⬆️ Fazer Upgrade por R$ ${valorUpgrade.toFixed(2)}`;

        if (isUpgrade) {
            btn.addEventListener('click', (event) => {
                if (!event.isTrusted) return;
                processarUpgrade(nomePlano, btn);
            });
        }

        card.appendChild(btn);
        grid.appendChild(card);
    });
}

// ========== PROCESSAR UPGRADE ==========
//
// [FIX2] _Cooldown removido daqui e movido para dentro do handler
// do botão confirmar em criarPopupUpgrade(). Ver comentário no módulo
// _Cooldown para justificativa completa.
function processarUpgrade(novoPlano, btnOrigem) {
    const usuario = UsuarioSessao.get();
    const config  = PLANOS_CONFIG[novoPlano];

    if (!config) {
        _mostrarFeedback('❌ Plano não encontrado.');
        return;
    }

    const upgradeInfo = obterUpgradeValido(usuario.planoAtual, novoPlano);
    if (!upgradeInfo) {
        _mostrarFeedback('❌ Este upgrade não está disponível para seu plano atual.');
        return;
    }

    criarPopupUpgrade(novoPlano, config, btnOrigem);
}

// ========== POPUP DE UPGRADE ==========
//
// btnOrigem — referência ao botão que abriu o popup, usada em [FIX5]
// para restaurar o foco quando o modal fecha.
function criarPopupUpgrade(novoPlano, config, btnOrigem) {
    const usuario           = UsuarioSessao.get();
    const upgradeConfirmado = obterUpgradeValido(usuario.planoAtual, novoPlano);

    if (!upgradeConfirmado) {
        _mostrarFeedback('❌ Upgrade inválido. Recarregue a página.');
        return;
    }

    const valorSeguro     = upgradeConfirmado.valor;
    const perfisDiferenca = config.perfis - PLANOS_CONFIG[usuario.planoAtual].perfis;

    const overlay = document.createElement('div');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', '_popupTitulo');
    overlay.style.cssText = `
        position:fixed; top:0; left:0; width:100%; height:100%;
        background:rgba(0,0,0,0.8); backdrop-filter:blur(10px);
        z-index:10000; display:flex; align-items:center; justify-content:center;
        animation:fadeIn 0.3s ease-out;
    `;

    const popup = document.createElement('div');
    popup.setAttribute('tabindex', '-1');
    popup.style.cssText = `
        background:linear-gradient(135deg, #1a1d3a 0%, #0d0f1f 100%);
        border-radius:24px; padding:40px; max-width:500px; width:90%;
        box-shadow:0 20px 60px rgba(0,0,0,0.5);
        border:1px solid rgba(108,99,255,0.3);
        animation:slideUp 0.4s ease-out;
    `;

    const innerDiv = document.createElement('div');
    innerDiv.style.textAlign = 'center';

    const iconContainer = document.createElement('div');
    iconContainer.setAttribute('aria-hidden', 'true');
    iconContainer.style.cssText = `
        width:80px; height:80px; margin:0 auto 20px;
        background:linear-gradient(135deg,var(--primary),var(--accent));
        border-radius:50%; display:flex; align-items:center;
        justify-content:center; box-shadow:0 8px 24px rgba(108,99,255,0.4);
    `;
    const svgEl = _parsearESanitizarSVG(config.icon);
    if (svgEl) iconContainer.appendChild(svgEl);
    innerDiv.appendChild(iconContainer);

    const tituloPopup = document.createElement('h2');
    tituloPopup.id = '_popupTitulo';
    tituloPopup.style.cssText = 'font-size:1.8rem; font-weight:800; color:white; margin-bottom:12px;';
    tituloPopup.textContent = '🚀 Confirmar Upgrade';
    innerDiv.appendChild(tituloPopup);

    const subtituloPopup = document.createElement('p');
    subtituloPopup.style.cssText = 'color:#9ca3af; font-size:1rem; margin-bottom:32px;';
    subtituloPopup.textContent = 'Você está prestes a evoluir seu plano';
    innerDiv.appendChild(subtituloPopup);

    // Comparação de planos
    const compCard = document.createElement('div');
    compCard.style.cssText = `
        background:rgba(255,255,255,0.05); border-radius:16px;
        padding:24px; margin-bottom:32px; text-align:left;
    `;

    const compRow = document.createElement('div');
    compRow.style.cssText = 'display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;';

    const colAtual = document.createElement('div');
    const labelAtual = document.createElement('div');
    labelAtual.style.cssText = 'font-size:0.85rem; color:#9ca3af; margin-bottom:6px;';
    labelAtual.textContent = 'Plano Atual';
    const valorAtualEl = document.createElement('div');
    valorAtualEl.style.cssText = 'font-size:1.2rem; font-weight:700; color:white;';
    valorAtualEl.textContent = usuario.planoAtual;
    colAtual.appendChild(labelAtual);
    colAtual.appendChild(valorAtualEl);

    const seta = document.createElement('div');
    seta.setAttribute('aria-hidden', 'true');
    seta.style.cssText = 'font-size:2rem; color:var(--primary);';
    seta.textContent = '→';

    const colNovo = document.createElement('div');
    const labelNovo = document.createElement('div');
    labelNovo.style.cssText = 'font-size:0.85rem; color:#9ca3af; margin-bottom:6px;';
    labelNovo.textContent = 'Novo Plano';
    const valorNovoEl = document.createElement('div');
    valorNovoEl.style.cssText = 'font-size:1.2rem; font-weight:700; color:var(--primary);';
    valorNovoEl.textContent = novoPlano;
    colNovo.appendChild(labelNovo);
    colNovo.appendChild(valorNovoEl);

    compRow.appendChild(colAtual);
    compRow.appendChild(seta);
    compRow.appendChild(colNovo);
    compCard.appendChild(compRow);

    const valorDiv = document.createElement('div');
    valorDiv.style.cssText = 'border-top:1px solid rgba(255,255,255,0.1); padding-top:16px; text-align:center;';

    const valorLabel = document.createElement('div');
    valorLabel.style.cssText = 'font-size:0.85rem; color:#9ca3af; margin-bottom:8px;';
    valorLabel.textContent = 'Valor do Upgrade';

    const valorNumero = document.createElement('div');
    valorNumero.style.cssText = `
        font-size:2.5rem; font-weight:900;
        background:linear-gradient(135deg,var(--primary),var(--accent));
        -webkit-background-clip:text; -webkit-text-fill-color:transparent;
    `;
    valorNumero.textContent = `R$ ${valorSeguro.toFixed(2)}`;

    const pagamentoInfo = document.createElement('div');
    pagamentoInfo.style.cssText = 'font-size:0.9rem; color:#10b981; margin-top:8px;';
    pagamentoInfo.textContent = '✅ Pagamento único • Acesso vitalício';

    valorDiv.appendChild(valorLabel);
    valorDiv.appendChild(valorNumero);
    valorDiv.appendChild(pagamentoInfo);
    compCard.appendChild(valorDiv);
    innerDiv.appendChild(compCard);

    // Benefícios
    const benefitsCard = document.createElement('div');
    benefitsCard.style.cssText = `
        background:rgba(108,99,255,0.1); border-radius:12px;
        padding:16px; margin-bottom:32px; text-align:left;
    `;

    const benefitsLabel = document.createElement('div');
    benefitsLabel.style.cssText = 'font-size:0.9rem; color:#9ca3af; margin-bottom:12px; text-align:center;';
    benefitsLabel.textContent = '✨ O que você ganha:';
    benefitsCard.appendChild(benefitsLabel);

    const benefitsList = document.createElement('ul');
    benefitsList.style.cssText = 'list-style:none; padding:0; margin:0;';

    const liStyle = 'display:flex; align-items:center; gap:12px; color:white; font-size:0.95rem;';
    const itens   = [
        `+${perfisDiferenca} perfil(is) extra(s)`,
        'Todos os seus dados preservados',
        'Ativação instantânea',
    ];

    itens.forEach((texto, i) => {
        const li = document.createElement('li');
        li.style.cssText = liStyle + (i < itens.length - 1 ? ' margin-bottom:10px;' : '');
        const check = document.createElement('span');
        check.setAttribute('aria-hidden', 'true');
        check.style.color = '#10b981';
        check.textContent = '✓';
        const textoSpan = document.createElement('span');
        textoSpan.textContent = texto;
        li.appendChild(check);
        li.appendChild(textoSpan);
        benefitsList.appendChild(li);
    });

    benefitsCard.appendChild(benefitsList);
    innerDiv.appendChild(benefitsCard);

    // Botões
    const botoesRow = document.createElement('div');
    botoesRow.style.cssText = 'display:flex; gap:12px;';

    const btnCancelar = document.createElement('button');
    btnCancelar.id = 'btnCancelarUpgrade';
    btnCancelar.type = 'button';
    btnCancelar.setAttribute('aria-label', 'Cancelar upgrade e fechar modal');
    btnCancelar.style.cssText = `
        flex:1; padding:16px; border-radius:12px;
        border:2px solid rgba(255,255,255,0.1);
        background:transparent; color:#9ca3af; font-size:1rem;
        font-weight:600; cursor:pointer; transition:all 0.3s; font-family:inherit;
    `;
    btnCancelar.textContent = 'Cancelar';

    const btnConfirmar = document.createElement('button');
    btnConfirmar.id = 'btnConfirmarUpgrade';
    btnConfirmar.type = 'button';
    btnConfirmar.setAttribute('aria-label', `Confirmar upgrade para o plano ${novoPlano} por R$ ${valorSeguro.toFixed(2)}`);
    btnConfirmar.style.cssText = `
        flex:1; padding:16px; border-radius:12px; border:none;
        background:linear-gradient(135deg,var(--primary),var(--accent));
        color:white; font-size:1rem; font-weight:700; cursor:pointer;
        box-shadow:0 4px 12px rgba(108,99,255,0.4); transition:all 0.3s; font-family:inherit;
    `;
    btnConfirmar.textContent = 'Prosseguir para Pagamento';

    botoesRow.appendChild(btnCancelar);
    botoesRow.appendChild(btnConfirmar);
    innerDiv.appendChild(botoesRow);

    popup.appendChild(innerDiv);
    overlay.appendChild(popup);
    document.body.appendChild(overlay);

    // [FIX4] Ativa o focus trap no popup para que Tab/Shift+Tab
    // não naveguem para elementos de fundo enquanto o modal está aberto.
    const removerFocusTrap = _criarFocusTrap(popup);

    // Foca o popup imediatamente para leitores de tela anunciarem o dialog.
    requestAnimationFrame(() => popup.focus());

    // ── [FIX3] Declaração de onKeyDown ANTES de fecharOverlay para
    //    evitar forward reference / Temporal Dead Zone. ──────────────
    //
    //    Na v2.0, fecharOverlay referenciava onKeyDown que era declarado
    //    depois, via const. Embora não quebrasse em produção (o código é
    //    síncrono e nenhum evento dispara durante a execução da função),
    //    era um code smell perigoso que podia introduzir bugs em
    //    refatorações futuras. Corrigido usando let declarado antes.
    let onKeyDown;

    // [FIX5] fecharOverlay agora restaura o foco ao btnOrigem (o botão
    // que abriu o modal). Isso é obrigatório pela WCAG 2.1 SC 2.4.3
    // e evita que o foco "se perca" na página após fechar o modal.
    const fecharOverlay = () => {
        overlay.style.opacity    = '0';
        overlay.style.transition = 'opacity 0.3s ease-out';
        removerFocusTrap();
        if (onKeyDown) document.removeEventListener('keydown', onKeyDown);
        setTimeout(() => {
            if (document.body.contains(overlay)) document.body.removeChild(overlay);
            // [FIX5] Restaura o foco ao elemento que abriu o modal
            if (btnOrigem && typeof btnOrigem.focus === 'function') {
                btnOrigem.focus();
            }
        }, 300);
    };

    btnCancelar.addEventListener('click', fecharOverlay);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) fecharOverlay(); });

    onKeyDown = (e) => { if (e.key === 'Escape') fecharOverlay(); };
    document.addEventListener('keydown', onKeyDown);

    // ── Confirmar upgrade ──
    btnConfirmar.addEventListener('click', async () => {
        if (btnConfirmar.dataset.processando === 'true') return;

        // [FIX2] Cooldown aplicado aqui — protege a chamada de API,
        // não a abertura do popup. Usuário pode inspecionar os cards
        // de upgrade sem penalidade.
        if (!_Cooldown.verificarEAtivar()) return;

        btnConfirmar.dataset.processando = 'true';
        btnConfirmar.textContent = 'Aguarde...';
        btnConfirmar.style.opacity = '0.7';
        btnConfirmar.setAttribute('aria-busy', 'true');

        try {
            const usuarioAtual = UsuarioSessao.get();

            const upgradeNoClique = obterUpgradeValido(usuarioAtual.planoAtual, novoPlano);
            if (!upgradeNoClique) {
                _mostrarFeedback('❌ Sessão inválida. Recarregue a página.');
                fecharOverlay();
                return;
            }

            // CSRF obrigatório
            const csrfToken = _lerCsrfToken();
            if (!csrfToken) {
                console.error('[SEGURANÇA] CSRF token ausente — request bloqueado no cliente.');
                _mostrarFeedback('❌ Erro de sessão. Recarregue a página e tente novamente.');
                fecharOverlay();
                return;
            }

            // [F3] jti único por request — backend deve registrar e rejeitar reenvios
            const jti = _gerarJti();

            const response = await _fetchComTimeout('/api/criar-sessao-upgrade', {
                method: 'POST',
                headers: {
                    'Content-Type':     'application/json',
                    'X-Requested-With': 'XMLHttpRequest',
                    'X-CSRF-Token':     csrfToken,
                },
                credentials: 'same-origin',
                body: JSON.stringify({
                    planoAtual: usuarioAtual.planoAtual,  // validação no backend
                    novoPlano:  upgradeNoClique.para,      // plano desejado
                    jti,                                   // anti-replay: UUID único por request
                    // ✅ SEM userId  — backend obtém via cookie de sessão
                    // ✅ SEM valor   — backend calcula com base nos planos
                }),
            });

            if (!response.ok) {
                const erro = await response.json().catch(() => ({}));
                throw new Error(erro.message || 'Falha ao iniciar upgrade');
            }

            const data = await response.json();

            if (!_validarUrlPagamento(data.checkoutUrl)) {
                throw new Error('URL de pagamento inválida ou domínio não autorizado');
            }

            fecharOverlay();
            window.location.href = data.checkoutUrl;

        } catch (error) {
            const msgErro = error.name === 'AbortError'
                ? '⏱️ A requisição demorou muito. Verifique sua conexão e tente novamente.'
                : '❌ Não foi possível iniciar o pagamento. Tente novamente.';

            console.error('[UPGRADE] Erro:', error.name, error.message);
            _mostrarFeedback(msgErro);

            btnConfirmar.dataset.processando = 'false';
            btnConfirmar.textContent = 'Prosseguir para Pagamento';
            btnConfirmar.style.opacity = '1';
            btnConfirmar.removeAttribute('aria-busy');
            _Cooldown.resetar();
        }
    });
}

// ========== FAQ ACCORDION ==========
function configurarFAQ() {
    const faqBtns = document.querySelectorAll('.faq-question-btn');

    faqBtns.forEach(btn => {
        const answerId = btn.getAttribute('aria-controls');
        const answer   = document.getElementById(answerId);
        if (!answer) return;

        btn.addEventListener('click', () => {
            const isActive = btn.getAttribute('aria-expanded') === 'true';

            faqBtns.forEach(otherBtn => {
                const otherId  = otherBtn.getAttribute('aria-controls');
                const otherAns = document.getElementById(otherId);
                otherBtn.setAttribute('aria-expanded', 'false');
                otherBtn.closest('.faq-item')?.classList.remove('active');
                if (otherAns) {
                    otherAns.hidden = true;
                    otherAns.style.maxHeight = null;
                }
            });

            if (!isActive) {
                btn.setAttribute('aria-expanded', 'true');
                btn.closest('.faq-item')?.classList.add('active');
                answer.hidden = false;
                answer.style.maxHeight = answer.scrollHeight + 'px';
            }
        });
    });
}

// ========== PARTÍCULAS ==========
function inicializarParticulas() {
    const canvas = document.getElementById('particlesCanvas');
    if (!canvas || window.innerWidth <= 768) return;

    const ctx = canvas.getContext('2d');
    let particles = [];

    const resizeCanvas = () => {
        canvas.width  = window.innerWidth;
        canvas.height = window.innerHeight;
    };

    class Particle {
        constructor() {
            this.x       = Math.random() * canvas.width;
            this.y       = Math.random() * canvas.height;
            this.size    = Math.random() * 2 + 1;
            this.speedX  = (Math.random() - 0.5) * 0.5;
            this.speedY  = (Math.random() - 0.5) * 0.5;
            this.opacity = Math.random() * 0.5 + 0.2;
        }
        update() {
            this.x += this.speedX;
            this.y += this.speedY;
            if (this.x > canvas.width)  this.x = 0;
            if (this.x < 0)             this.x = canvas.width;
            if (this.y > canvas.height) this.y = 0;
            if (this.y < 0)             this.y = canvas.height;
        }
        draw() {
            ctx.fillStyle = `rgba(108, 99, 255, ${this.opacity})`;
            ctx.beginPath();
            ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    const init = () => {
        particles = [];
        for (let i = 0; i < 50; i++) particles.push(new Particle());
    };

    const animate = () => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        particles.forEach(p => { p.update(); p.draw(); });
        requestAnimationFrame(animate);
    };

    resizeCanvas();
    init();
    animate();

    window.addEventListener('resize', () => { resizeCanvas(); init(); });
}

// ========== INICIALIZAÇÃO ==========
document.addEventListener('DOMContentLoaded', () => {
    const yearEl = document.getElementById('footerYear');
    if (yearEl) yearEl.textContent = new Date().getFullYear();

    verificarLogin();
});

// [FIX6] console.log removido.
// Na v2.0 havia: console.log('%c🚀 GranaEvo Upgrade — v2.0 (...)', ...)
// Isso expunha nome do projeto, versão e tecnologias para qualquer
// pessoa com DevTools aberto — information disclosure desnecessário.
// Se precisar de diagnóstico em desenvolvimento, use uma variável de
// ambiente: if (import.meta.env?.DEV) console.log(...);