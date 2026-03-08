/* =============================================
   GRANAEVO - ATUALIZAR PLANO JS
   ============================================= */

import { supabase } from './supabase-client.js';
import AuthGuard from './auth-guard.js';

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

// ========== TABELA DE UPGRADES VÁLIDOS (Relatório — Ponto 3) ==========
//
// Object.freeze() duplo: freeze externo congela as chaves do objeto,
// freeze interno congela cada entrada individualmente.
// Sem o freeze interno, UPGRADES_VALIDOS["Individual→Casal"].valor = 0.01
// ainda funcionaria mesmo com o freeze externo.
//
// Resultado: tabela completamente imutável — qualquer tentativa de alteração
// via console falha silenciosamente (normal) ou lança TypeError (strict).
// O backend DEVE revalidar esses valores — esta é apenas defesa em profundidade.

const UPGRADES_VALIDOS = Object.freeze({
    "Individual→Casal":   Object.freeze({ de: "Individual", para: "Casal",   valor: 10.00 }),
    "Individual→Família": Object.freeze({ de: "Individual", para: "Família", valor: 30.00 }),
    "Casal→Família":      Object.freeze({ de: "Casal",      para: "Família", valor: 20.00 }),
});

function obterUpgradeValido(planoAtual, novoPlano) {
    const chave = `${planoAtual}→${novoPlano}`;
    return UPGRADES_VALIDOS[chave] || null;
}

// ========== ESTADO GLOBAL ==========
// Congelado via Object.freeze() após o login — nenhuma propriedade
// pode ser alterada pelo console ou código externo.
let usuarioAtual = null;

// ========== RATE LIMIT VISUAL ==========
let _upgradeCooldownAtivo = false;
const _UPGRADE_COOLDOWN_MS = 8000;

function _verificarEAtivarCooldown() {
    if (_upgradeCooldownAtivo) {
        _mostrarFeedback('⏳ Aguarde alguns segundos antes de tentar novamente.', 'aviso');
        return false;
    }
    _upgradeCooldownAtivo = true;
    setTimeout(() => { _upgradeCooldownAtivo = false; }, _UPGRADE_COOLDOWN_MS);
    return true;
}

// ========== STYLE TAG ÚNICA — sem memory leak ==========
// Criada uma única vez na inicialização do módulo.
(function _injetarAnimacoes() {
    if (document.getElementById('_granaevo-popup-styles')) return;
    const style = document.createElement('style');
    style.id = '_granaevo-popup-styles';
    style.textContent = `
        @keyframes fadeIn  { from { opacity:0; } to { opacity:1; } }
        @keyframes slideUp { from { opacity:0; transform:translateY(30px); } to { opacity:1; transform:translateY(0); } }
        #btnCancelarUpgrade:hover  { background:rgba(255,255,255,0.05) !important; border-color:rgba(255,255,255,0.2) !important; }
        #btnConfirmarUpgrade:hover { transform:translateY(-2px) !important; box-shadow:0 6px 20px rgba(108,99,255,0.6) !important; }
    `;
    document.head.appendChild(style);
})();

// ========== UTILITÁRIOS DE SEGURANÇA ==========

function _sanitizeText(str) {
    if (typeof str !== 'string') return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;')
        .replace(/\//g, '&#x2F;');
}

/**
 * Exibe mensagem de feedback via toast não-bloqueante.
 * textContent — nunca innerHTML.
 */
function _mostrarFeedback(mensagem, tipo = 'erro') {
    const corFundo  = tipo === 'aviso' ? '#f59e0b' : '#ef4444';
    const corSombra = tipo === 'aviso' ? 'rgba(245,158,11,0.4)' : 'rgba(239,68,68,0.4)';

    const toast = document.createElement('div');
    toast.setAttribute('role', 'alert');
    toast.setAttribute('aria-live', 'assertive');
    toast.style.cssText = `
        position:fixed; bottom:32px; left:50%; transform:translateX(-50%);
        background:${corFundo}; color:white; padding:14px 28px;
        border-radius:12px; font-weight:600; font-size:0.95rem;
        z-index:99999; box-shadow:0 8px 24px ${corSombra};
        max-width:90vw; text-align:center;
    `;
    toast.textContent = mensagem;
    document.body.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transition = 'opacity 0.3s';
        setTimeout(() => {
            if (document.body.contains(toast)) document.body.removeChild(toast);
        }, 300);
    }, 4000);
}

// ========== SANITIZAÇÃO DE SVG — BLINDAGEM COMPLETA ==========
//
// Duas passagens:
// 1ª — remove elementos inteiros perigosos (script, foreignObject, iframe, etc.)
//      em ordem reversa (folha → raiz) para evitar órfãos no DOM.
// 2ª — remove atributos on* e URLs com protocolo javascript:/data:.

const _SVG_TAGS_PROIBIDAS = new Set([
    'script', 'foreignobject', 'iframe', 'embed',
    'object', 'link', 'meta', 'use',
]);

function _sanitizarSVG(svgEl) {
    Array.from(svgEl.querySelectorAll('*')).reverse().forEach(el => {
        if (_SVG_TAGS_PROIBIDAS.has(el.tagName.toLowerCase())) el.remove();
    });

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
    template.innerHTML = svgString;

    const svgEl = template.content.firstElementChild;
    if (!svgEl || svgEl.tagName.toLowerCase() !== 'svg') {
        console.warn('[SEGURANÇA] SVG inválido:', svgEl?.tagName);
        return null;
    }

    return _sanitizarSVG(svgEl);
}

// ========== VALIDAÇÃO DE URL DE PAGAMENTO ==========
// HTTPS + whitelist de hostname.

const _DOMINIOS_PAGAMENTO_PERMITIDOS = new Set([
    'checkout.stripe.com',
    'pay.granaevo.com',
    // Adicione aqui o domínio exato do seu gateway de pagamento
]);

function _validarUrlPagamento(url) {
    if (!url || typeof url !== 'string') return false;
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:') {
            console.warn('[SEGURANÇA] URL sem HTTPS:', parsed.protocol);
            return false;
        }
        if (!_DOMINIOS_PAGAMENTO_PERMITIDOS.has(parsed.hostname)) {
            console.warn('[SEGURANÇA] Domínio não autorizado:', parsed.hostname);
            return false;
        }
        return true;
    } catch {
        console.warn('[SEGURANÇA] URL malformada:', url);
        return false;
    }
}

// ========== VERIFICAÇÃO DE SAME-ORIGIN (Relatório — Ponto 2) ==========
//
// Proteção contra reutilização do script em domínio clonado/falso.
//
// Por que não usar .includes('granaevo') como o relatório sugeria?
// Porque "fake-granaevo.evil.com" passaria nessa checagem.
// Comparação estrita de origin é a única forma correta.
//
// ⚠️  CONFIGURE: substitua pela origin exata de produção.
//     Desenvolvimento local: 'http://localhost:5173' (ou a porta do seu dev server).
//     Adicione quantos origins legítimos forem necessários ao Set.

const _ORIGINS_PERMITIDAS = new Set([
    'https://granaevo.com',
    'https://www.granaevo.com',
    'https://app.granaevo.com',
    // 'http://localhost:5173', // descomente apenas em desenvolvimento local
]);

/**
 * Lança um erro se a página não estiver rodando em uma origin autorizada.
 * Impede que o script seja reutilizado em domínios clonados.
 */
function _verificarSameOrigin() {
    const originAtual = window.location.origin;
    if (!_ORIGINS_PERMITIDAS.has(originAtual)) {
        // Não expõe detalhes no console — dificulta reconhecimento pelo atacante
        throw new Error('Origem da aplicação não autorizada');
    }
}

// ========== FETCH COM TIMEOUT (Relatório — Ponto 4) ==========
//
// Sem timeout, um fetch preso mantém o botão desabilitado indefinidamente,
// o cooldown ativo e o usuário sem feedback.
//
// AbortController cancela a requisição após `timeout` ms.
// O clearTimeout garante que o timer não vaza caso o fetch complete antes.
//
// O erro lançado pelo abort tem error.name === 'AbortError' —
// tratado especificamente no catch do chamador para mensagem amigável.

const _FETCH_TIMEOUT_MS = 10000; // 10 segundos

/**
 * Wrapper do fetch com timeout automático via AbortController.
 *
 * @param {string} url
 * @param {RequestInit} options
 * @param {number} timeout - ms antes de abortar (padrão: 10000)
 * @returns {Promise<Response>}
 */
async function _fetchComTimeout(url, options = {}, timeout = _FETCH_TIMEOUT_MS) {
    const controller = new AbortController();
    const timerId    = setTimeout(() => controller.abort(), timeout);

    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal,
        });
        return response;
    } finally {
        // Garante limpeza do timer mesmo se fetch lançar exceção
        clearTimeout(timerId);
    }
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
            // Object.freeze() — congela o objeto de sessão após login.
            // Tentativas de alterar via console falham silenciosamente (normal)
            // ou lançam TypeError (strict mode).
            usuarioAtual = Object.freeze({
                nome:       user.nome,
                planoAtual: user.plano,
                userId:     user.userId,
                email:      user.email,
                isGuest:    user.isGuest,
                ownerEmail: user.ownerEmail || null,
            });

            if (authLoading) {
                setTimeout(() => authLoading.classList.add('hidden'), 800);
            }

            if (user.isGuest) {
                _exibirAvisoConvidado(user);
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

    // ── Monta com createElement — sem innerHTML com dados externos ──
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

    const linha1 = document.createTextNode('Você acessa o GranaEvo como ');
    const negrito1 = document.createElement('strong');
    negrito1.style.color = 'white';
    negrito1.textContent = 'convidado';
    const linha2 = document.createTextNode(' da conta de ');
    const negritoEmail = document.createElement('strong');
    negritoEmail.style.color = '#6c63ff';
    negritoEmail.textContent = user.ownerEmail || 'outro usuário'; // textContent — seguro
    const linha3 = document.createTextNode('.');
    const quebra = document.createElement('br');
    const quebra2 = document.createElement('br');
    const linha4 = document.createTextNode('Apenas o ');
    const negrito2 = document.createElement('strong');
    negrito2.style.color = 'white';
    negrito2.textContent = 'titular da conta';
    const linha5 = document.createTextNode(' pode gerenciar e atualizar o plano.');

    paragrafo.appendChild(linha1);
    paragrafo.appendChild(negrito1);
    paragrafo.appendChild(linha2);
    paragrafo.appendChild(negritoEmail);
    paragrafo.appendChild(linha3);
    paragrafo.appendChild(quebra);
    paragrafo.appendChild(quebra2);
    paragrafo.appendChild(linha4);
    paragrafo.appendChild(negrito2);
    paragrafo.appendChild(linha5);

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

    container.innerHTML = '';
    container.appendChild(aviso);
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
    const planoAtual = usuarioAtual.planoAtual;
    const config     = PLANOS_CONFIG[planoAtual];

    if (!config) {
        console.error('[UPGRADE] Plano não encontrado:', planoAtual);
        return;
    }

    // ── #planoAtualDisplay ──
    const planoDisplay = document.getElementById('planoAtualDisplay');
    if (planoDisplay) {
        planoDisplay.innerHTML = '';

        const wrapper = document.createElement('strong');
        const span    = document.createElement('span');
        span.style.cssText = 'display:inline-flex; align-items:center; gap:8px; vertical-align:middle;';

        const svgEl = _parsearESanitizarSVG(config.icon);
        if (svgEl) span.appendChild(svgEl);

        const nomeSpan = document.createElement('span');
        nomeSpan.textContent = config.nome;
        span.appendChild(nomeSpan);
        wrapper.appendChild(span);
        planoDisplay.appendChild(wrapper);
    }

    // ── #currentPlanCard — 100% createElement, zero innerHTML (Relatório — Ponto 1) ──
    const currentPlanCard = document.getElementById('currentPlanCard');
    if (currentPlanCard) {
        currentPlanCard.innerHTML = '';

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
    const planoAtual = usuarioAtual.planoAtual;
    const grid       = document.getElementById('upgradeCardsGrid');

    if (!grid) return;

    if (!PLANOS_CONFIG[planoAtual]) {
        console.error('[SEGURANÇA] Plano atual inválido:', planoAtual);
        return;
    }

    grid.innerHTML = '';
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

        // ── Card — 100% createElement, zero innerHTML (Relatório — Ponto 1) ──
        const card = document.createElement('div');
        card.className = 'upgrade-card';
        card.setAttribute('role', 'listitem');
        if (isUpgrade && valorUpgrade <= 20) card.classList.add('recommended');

        // Badge recomendado
        if (isUpgrade && valorUpgrade <= 20) {
            const badge = document.createElement('div');
            badge.className = 'upgrade-badge';
            badge.textContent = '⭐ Recomendado';
            card.appendChild(badge);
        }

        // Header
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

        // Pricing
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

        // Features
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

        // Botão
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
            btn.addEventListener('click', () => processarUpgrade(nomePlano));
        }

        card.appendChild(btn);
        grid.appendChild(card);
    });
}

// ========== PROCESSAR UPGRADE ==========
function processarUpgrade(novoPlano) {
    if (!_verificarEAtivarCooldown()) return;

    const config = PLANOS_CONFIG[novoPlano];
    if (!config) {
        _mostrarFeedback('❌ Plano não encontrado.');
        _upgradeCooldownAtivo = false;
        return;
    }

    const upgradeInfo = obterUpgradeValido(usuarioAtual.planoAtual, novoPlano);
    if (!upgradeInfo) {
        _mostrarFeedback('❌ Este upgrade não está disponível para seu plano atual.');
        _upgradeCooldownAtivo = false;
        return;
    }

    criarPopupUpgrade(novoPlano, config);
}

// ========== POPUP DE UPGRADE ==========
// 100% createElement — zero innerHTML com dados externos (Relatório — Ponto 1)
function criarPopupUpgrade(novoPlano, config) {

    const upgradeConfirmado = obterUpgradeValido(usuarioAtual.planoAtual, novoPlano);
    if (!upgradeConfirmado) {
        _mostrarFeedback('❌ Upgrade inválido. Recarregue a página.');
        _upgradeCooldownAtivo = false;
        return;
    }

    const valorSeguro     = upgradeConfirmado.valor;
    const perfisDiferenca = config.perfis - PLANOS_CONFIG[usuarioAtual.planoAtual].perfis;

    // ── Overlay ──
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

    // ── Popup container ──
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

    // Ícone SVG sanitizado
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

    // Título
    const titulo = document.createElement('h2');
    titulo.id = '_popupTitulo';
    titulo.style.cssText = 'font-size:1.8rem; font-weight:800; color:white; margin-bottom:12px;';
    titulo.textContent = '🚀 Confirmar Upgrade';
    innerDiv.appendChild(titulo);

    // Subtítulo
    const subtitulo = document.createElement('p');
    subtitulo.style.cssText = 'color:#9ca3af; font-size:1rem; margin-bottom:32px;';
    subtitulo.textContent = 'Você está prestes a evoluir seu plano';
    innerDiv.appendChild(subtitulo);

    // Card de comparação de planos
    const compCard = document.createElement('div');
    compCard.style.cssText = `
        background:rgba(255,255,255,0.05); border-radius:16px;
        padding:24px; margin-bottom:32px; text-align:left;
    `;

    const compRow = document.createElement('div');
    compRow.style.cssText = 'display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;';

    // Coluna plano atual
    const colAtual = document.createElement('div');
    const labelAtual = document.createElement('div');
    labelAtual.style.cssText = 'font-size:0.85rem; color:#9ca3af; margin-bottom:6px;';
    labelAtual.textContent = 'Plano Atual';
    const valorAtual = document.createElement('div');
    valorAtual.style.cssText = 'font-size:1.2rem; font-weight:700; color:white;';
    valorAtual.textContent = usuarioAtual.planoAtual; // textContent — seguro
    colAtual.appendChild(labelAtual);
    colAtual.appendChild(valorAtual);

    // Seta
    const seta = document.createElement('div');
    seta.setAttribute('aria-hidden', 'true');
    seta.style.cssText = 'font-size:2rem; color:var(--primary);';
    seta.textContent = '→';

    // Coluna novo plano
    const colNovo = document.createElement('div');
    const labelNovo = document.createElement('div');
    labelNovo.style.cssText = 'font-size:0.85rem; color:#9ca3af; margin-bottom:6px;';
    labelNovo.textContent = 'Novo Plano';
    const valorNovo = document.createElement('div');
    valorNovo.style.cssText = 'font-size:1.2rem; font-weight:700; color:var(--primary);';
    valorNovo.textContent = novoPlano; // textContent — seguro
    colNovo.appendChild(labelNovo);
    colNovo.appendChild(valorNovo);

    compRow.appendChild(colAtual);
    compRow.appendChild(seta);
    compRow.appendChild(colNovo);
    compCard.appendChild(compRow);

    // Valor do upgrade
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
    valorNumero.textContent = `R$ ${valorSeguro.toFixed(2)}`; // textContent — seguro

    const pagamentoInfo = document.createElement('div');
    pagamentoInfo.style.cssText = 'font-size:0.9rem; color:#10b981; margin-top:8px;';
    pagamentoInfo.textContent = '✅ Pagamento único • Acesso vitalício';

    valorDiv.appendChild(valorLabel);
    valorDiv.appendChild(valorNumero);
    valorDiv.appendChild(pagamentoInfo);
    compCard.appendChild(valorDiv);
    innerDiv.appendChild(compCard);

    // Card de benefícios
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

    const itens = [
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
        textoSpan.textContent = texto; // textContent — seguro

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

    requestAnimationFrame(() => popup.focus());

    // ── Fechar overlay ──
    const fecharOverlay = () => {
        overlay.style.opacity = '0';
        overlay.style.transition = 'opacity 0.3s ease-out';
        document.removeEventListener('keydown', onKeyDown);
        setTimeout(() => {
            if (document.body.contains(overlay)) document.body.removeChild(overlay);
        }, 300);
    };

    btnCancelar.addEventListener('click', fecharOverlay);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) fecharOverlay(); });

    const onKeyDown = (e) => { if (e.key === 'Escape') fecharOverlay(); };
    document.addEventListener('keydown', onKeyDown);

    // ── Confirmar upgrade ──
    btnConfirmar.addEventListener('click', async () => {
        if (btnConfirmar.dataset.processando === 'true') return;
        btnConfirmar.dataset.processando = 'true';
        btnConfirmar.textContent = 'Aguarde...';
        btnConfirmar.style.opacity = '0.7';
        btnConfirmar.setAttribute('aria-busy', 'true');

        try {
            // Verifica same-origin antes de qualquer requisição (Relatório — Ponto 2)
            _verificarSameOrigin();

            const upgradeNoClique = obterUpgradeValido(usuarioAtual.planoAtual, novoPlano);
            if (!upgradeNoClique) {
                _mostrarFeedback('❌ Sessão inválida. Recarregue a página.');
                fecharOverlay();
                return;
            }

            // Fetch com timeout de 10s (Relatório — Ponto 4)
            // credentials: 'same-origin' — mais restritivo que 'include'
            // X-Requested-With — header anti-CSRF reconhecido por muitos frameworks
            const response = await _fetchComTimeout('/api/criar-sessao-upgrade', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Requested-With': 'XMLHttpRequest',
                },
                credentials: 'same-origin',
                body: JSON.stringify({ novoPlano: upgradeNoClique.para }),
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
            // Mensagem amigável para timeout (AbortError)
            const msgErro = error.name === 'AbortError'
                ? '⏱️ A requisição demorou muito. Verifique sua conexão e tente novamente.'
                : '❌ Não foi possível iniciar o pagamento. Tente novamente.';

            console.error('[UPGRADE] Erro:', error.name, error.message);
            _mostrarFeedback(msgErro);

            btnConfirmar.dataset.processando = 'false';
            btnConfirmar.textContent = 'Prosseguir para Pagamento';
            btnConfirmar.style.opacity = '1';
            btnConfirmar.removeAttribute('aria-busy');
            _upgradeCooldownAtivo = false;
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
    verificarLogin();
});

console.log('%c🚀 Página de Upgrade Carregada', 'color: #6c63ff; font-size: 16px; font-weight: bold;');