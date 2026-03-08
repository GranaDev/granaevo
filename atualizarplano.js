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

// ========== ESTADO GLOBAL ==========
// Declarado como let para permitir a atribuição inicial via Object.freeze().
// Após o login, o objeto é congelado — nenhuma propriedade pode ser alterada
// pelo console ou por código externo (Relatório — Ponto 3).
let usuarioAtual = null;

// ========== RATE LIMIT VISUAL ==========
// Primeira barreira contra spam de requisições ao endpoint de pagamento.
// O backend DEVE ter seu próprio rate limit — este é apenas UX + redução de ruído.
let _upgradeCooldownAtivo = false;
const _UPGRADE_COOLDOWN_MS = 8000;

function _verificarEAtivarCooldown() {
    if (_upgradeCooldownAtivo) {
        _mostrarErro('⏳ Aguarde alguns segundos antes de tentar novamente.', 'aviso');
        return false;
    }
    _upgradeCooldownAtivo = true;
    setTimeout(() => { _upgradeCooldownAtivo = false; }, _UPGRADE_COOLDOWN_MS);
    return true;
}

// ========== STYLE TAG ÚNICA PARA ANIMAÇÕES (Relatório — Ponto 4) ==========
// Criada uma única vez na inicialização do módulo — evita acúmulo de <style>
// no <head> a cada abertura de popup (memory leak de DOM nodes).
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

/**
 * Sanitiza texto removendo caracteres especiais HTML.
 * Usar quando innerHTML for inevitável com dados externos.
 */
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
 * Exibe mensagem de feedback ao usuário via toast não-bloqueante.
 * Usa textContent — nunca innerHTML.
 */
function _mostrarErro(mensagem, tipo = 'erro') {
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

// ========== SANITIZAÇÃO DE SVG — BLINDAGEM COMPLETA (Relatório — Ponto 1) ==========
//
// Versão anterior removia apenas atributos perigosos (on*, href javascript:).
// Esta versão também remove ELEMENTOS inteiros que podem conter HTML arbitrário:
//
//   <foreignObject> — permite embedar HTML dentro do SVG (vetor XSS clássico)
//   <script>        — execução de JS direta
//   <iframe>        — carregamento de página externa
//   <embed>         — conteúdo externo
//   <object>        — idem
//   <link>          — importação de CSS externo / preload
//   <meta>          — redefinição de charset, refresh etc.
//   <use>           — pode referenciar recursos externos via xlink:href
//
// Remoção feita ANTES da varredura de atributos, em ordem reversa (folha → raiz)
// para não deixar órfãos ao remover um pai antes dos filhos.

/** Tags cujos elementos são removidos completamente do SVG */
const _SVG_TAGS_PROIBIDAS = new Set([
    'script', 'foreignobject', 'iframe', 'embed',
    'object', 'link', 'meta', 'use',
]);

/**
 * Remove elementos proibidos e atributos perigosos de um SVG já parseado.
 * Opera in-place — retorna o mesmo elemento limpo.
 *
 * @param {SVGElement} svgEl
 * @returns {SVGElement}
 */
function _sanitizarSVG(svgEl) {
    // 1ª passagem: remove tags proibidas (reversed para remover folhas antes de pais)
    Array.from(svgEl.querySelectorAll('*')).reverse().forEach(el => {
        if (_SVG_TAGS_PROIBIDAS.has(el.tagName.toLowerCase())) el.remove();
    });

    // 2ª passagem: remove atributos perigosos do SVG raiz e filhos restantes
    [svgEl, ...svgEl.querySelectorAll('*')].forEach(el => {
        // Converte para array — NamedNodeMap é live, skip ao remover sem conversão
        [...el.attributes].forEach(attr => {
            const nome  = attr.name.toLowerCase();
            const valor = attr.value.trim().toLowerCase();

            // Qualquer atributo de evento (on*)
            if (nome.startsWith('on')) {
                el.removeAttribute(attr.name);
                return;
            }

            // Atributos que aceitam URLs — bloqueia protocolos perigosos
            if (['href', 'src', 'action', 'xlink:href', 'data'].includes(nome)) {
                if (valor.startsWith('javascript:') || valor.startsWith('data:')) {
                    el.removeAttribute(attr.name);
                }
            }
        });
    });

    return svgEl;
}

/**
 * Parseia uma string SVG, valida a tag raiz, sanitiza e retorna o elemento DOM.
 * Retorna null se a string não for um SVG válido.
 *
 * @param {string} svgString
 * @returns {SVGElement|null}
 */
function _parsearESanitizarSVG(svgString) {
    if (typeof svgString !== 'string' || !svgString.trim()) return null;

    const template = document.createElement('template');
    template.innerHTML = svgString; // parsing via template (inerte — não executa scripts)

    const svgEl = template.content.firstElementChild;

    if (!svgEl || svgEl.tagName.toLowerCase() !== 'svg') {
        console.warn('[SEGURANÇA] SVG inválido ou elemento raiz inesperado:', svgEl?.tagName);
        return null;
    }

    return _sanitizarSVG(svgEl);
}

// ========== VALIDAÇÃO DE URL DE PAGAMENTO (Relatório — Ponto 2) ==========
//
// Versão anterior verificava apenas parsed.protocol === 'https:'.
// Esta versão também verifica o hostname contra uma whitelist de domínios
// autorizados — impede redirecionamento para domínios maliciosos mesmo que
// usem HTTPS (https://evil-payments.com passaria na versão anterior).
//
// ⚠️  CONFIGURE: adicione aqui o domínio exato do seu gateway de pagamento.
//     Exemplos: "checkout.stripe.com", "pay.mercadopago.com"

const _DOMINIOS_PAGAMENTO_PERMITIDOS = new Set([
    'checkout.stripe.com',
    'pay.granaevo.com',
    // Adicione aqui outros domínios autorizados do seu gateway de pagamento
]);

/**
 * Valida se uma URL de checkout é segura: exige HTTPS + hostname na whitelist.
 *
 * @param {string} url
 * @returns {boolean}
 */
function _validarUrlPagamento(url) {
    if (!url || typeof url !== 'string') return false;
    try {
        const parsed = new URL(url);

        if (parsed.protocol !== 'https:') {
            console.warn('[SEGURANÇA] URL de pagamento não usa HTTPS:', parsed.protocol);
            return false;
        }

        if (!_DOMINIOS_PAGAMENTO_PERMITIDOS.has(parsed.hostname)) {
            console.warn('[SEGURANÇA] Domínio de pagamento não permitido:', parsed.hostname);
            return false;
        }

        return true;
    } catch {
        console.warn('[SEGURANÇA] URL de pagamento malformada:', url);
        return false;
    }
}

// ========== VERIFICAÇÃO DE LOGIN ==========
async function verificarLogin() {
    const authLoading = document.getElementById('loadingScreen');

    const userData = await AuthGuard.protect({
        requirePlan:      true,
        allowGuest:       true,
        guestCanUpgrade:  false,
        loadingElementId: 'loadingScreen',
        redirectOnFail:   true,

        onSuccess: async (user) => {

            // ── Object.freeze() (Relatório — Ponto 3) ──────────────────────
            // Congela o objeto após a atribuição inicial.
            // Tentativas de alterar via console (usuarioAtual.planoAtual = "X")
            // falham silenciosamente em modo normal e lançam TypeError em strict.
            // O backend continua sendo a barreira definitiva, mas isso impede
            // manipulação de UI sem nenhum custo de performance.
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

    return userData;
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

    aviso.innerHTML = `
        <div style="font-size:3rem; margin-bottom:16px;" aria-hidden="true">🔒</div>
        <h2 style="color:#ffd166; font-size:1.6rem; margin-bottom:12px;">Acesso Restrito</h2>
        <p style="color:#9ca3af; line-height:1.7; margin-bottom:24px;">
            Você acessa o GranaEvo como <strong style="color:white;">convidado</strong>
            da conta de <strong id="_avisoOwnerEmail" style="color:#6c63ff;"></strong>.
            <br><br>
            Apenas o <strong style="color:white;">titular da conta</strong> pode
            gerenciar e atualizar o plano.
        </p>
        <button id="_btnVoltarDashboard" type="button"
                style="padding:14px 32px; background:linear-gradient(135deg,#6c63ff,#4a42cc);
                       border:none; border-radius:12px; color:white; font-size:1rem;
                       font-weight:700; cursor:pointer; box-shadow:0 4px 16px rgba(108,99,255,0.4);">
            ← Voltar ao Dashboard
        </button>
    `;

    aviso.querySelector('#_avisoOwnerEmail').textContent =
        user.ownerEmail || 'outro usuário';

    aviso.querySelector('#_btnVoltarDashboard')
         .addEventListener('click', () => { window.location.href = 'dashboard.html'; });

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

    // ── #currentPlanCard ──
    const currentPlanCard = document.getElementById('currentPlanCard');
    if (currentPlanCard) {
        currentPlanCard.innerHTML = `
            <div class="current-plan-title">📌 Seu Plano Atual</div>
            <div class="current-plan-name" id="_cardPlanNome"></div>
            <div class="current-plan-features">
                <div class="feature-badge" id="_cardPlanPerfis"></div>
                <div class="feature-badge" id="_cardPlanPreco"></div>
                <div class="feature-badge">✅ Acesso Vitalício</div>
            </div>
        `;

        const cardNome    = currentPlanCard.querySelector('#_cardPlanNome');
        const svgIconCard = _parsearESanitizarSVG(config.icon);
        if (svgIconCard) {
            const iconWrapper = document.createElement('span');
            iconWrapper.className = 'plan-icon-wrapper';
            iconWrapper.appendChild(svgIconCard);
            cardNome.appendChild(iconWrapper);
        }
        const nomeNode = document.createElement('span');
        nomeNode.textContent = config.nome;
        cardNome.appendChild(nomeNode);

        currentPlanCard.querySelector('#_cardPlanPerfis').textContent =
            `${config.perfis} ${config.perfis === 1 ? 'perfil' : 'perfis'}`;

        currentPlanCard.querySelector('#_cardPlanPreco').textContent =
            `💰 R$ ${config.preco.toFixed(2)}`;
    }
}

// ========== TABELA DE UPGRADES VÁLIDOS ==========
// Fonte da verdade no cliente — backend DEVE revalidar esses valores.
const UPGRADES_VALIDOS = {
    "Individual→Casal":   { de: "Individual", para: "Casal",   valor: 10.00 },
    "Individual→Família": { de: "Individual", para: "Família", valor: 30.00 },
    "Casal→Família":      { de: "Casal",      para: "Família", valor: 20.00 },
};

function obterUpgradeValido(planoAtual, novoPlano) {
    const chave = `${planoAtual}→${novoPlano}`;
    return UPGRADES_VALIDOS[chave] || null;
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

        const card = document.createElement('div');
        card.className = 'upgrade-card';
        card.setAttribute('role', 'listitem');
        if (isUpgrade && valorUpgrade <= 20) card.classList.add('recommended');

        // Slug seguro para IDs internos
        const idSlug = nomePlano.replace(/[^a-zA-Z0-9]/g, '_');

        // HTML estrutural estático — zero interpolação de dados externos
        card.innerHTML = `
            <div class="upgrade-header">
                <div class="upgrade-icon"     id="_icon_${idSlug}"></div>
                <div class="upgrade-name"     id="_nome_${idSlug}"></div>
                <div class="upgrade-subtitle" id="_sub_${idSlug}"></div>
            </div>
            <div class="upgrade-pricing"  id="_pricing_${idSlug}"></div>
            <ul  class="upgrade-features" id="_feats_${idSlug}"></ul>
            <button class="btn-upgrade ${isCurrentOrLower ? 'disabled' : ''}"
                    type="button"
                    ${isCurrentOrLower ? 'disabled aria-disabled="true"' : ''}
                    id="_btn_${idSlug}">
            </button>
        `;

        if (isUpgrade && valorUpgrade <= 20) {
            const badge = document.createElement('div');
            badge.className = 'upgrade-badge';
            badge.textContent = '⭐ Recomendado';
            card.insertBefore(badge, card.firstChild);
        }

        // Ícone SVG sanitizado (tags + atributos perigosos removidos)
        const iconSlot = card.querySelector(`#_icon_${idSlug}`);
        const svgEl    = _parsearESanitizarSVG(config.icon);
        if (svgEl && iconSlot) iconSlot.appendChild(svgEl);

        // Textos via textContent
        card.querySelector(`#_nome_${idSlug}`).textContent = config.nome;
        card.querySelector(`#_sub_${idSlug}`).textContent  = subtituloTexto;

        // Pricing via createElement + textContent
        const pricingSlot = card.querySelector(`#_pricing_${idSlug}`);
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

            pricingSlot.appendChild(originalEl);
            pricingSlot.appendChild(priceRow);
            pricingSlot.appendChild(savingsEl);
        } else {
            const statusEl = document.createElement('div');
            statusEl.className = 'upgrade-price';
            const amountEl = document.createElement('span');
            amountEl.className = 'price-amount';
            amountEl.style.cssText = 'font-size:1.5rem; color:var(--gray);';
            amountEl.textContent = nomePlano === planoAtual ? '✅ Ativo' : '❌ Indisponível';
            statusEl.appendChild(amountEl);
            pricingSlot.appendChild(statusEl);
        }

        // Features: cada <li> via createElement + textContent
        const featsSlot = card.querySelector(`#_feats_${idSlug}`);
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
            featsSlot.appendChild(li);
        });

        // Botão: textContent
        const btn = card.querySelector(`#_btn_${idSlug}`);
        btn.textContent = isCurrentOrLower
            ? (nomePlano === planoAtual ? '✅ Plano Atual' : '⬇️ Downgrade Indisponível')
            : `⬆️ Fazer Upgrade por R$ ${valorUpgrade.toFixed(2)}`;

        if (isUpgrade) {
            btn.addEventListener('click', () => processarUpgrade(nomePlano));
        }

        grid.appendChild(card);
    });
}

// ========== PROCESSAR UPGRADE ==========
function processarUpgrade(novoPlano) {
    if (!_verificarEAtivarCooldown()) return;

    const config = PLANOS_CONFIG[novoPlano];
    if (!config) {
        _mostrarErro('❌ Plano não encontrado.');
        _upgradeCooldownAtivo = false;
        return;
    }

    const upgradeInfo = obterUpgradeValido(usuarioAtual.planoAtual, novoPlano);
    if (!upgradeInfo) {
        _mostrarErro('❌ Este upgrade não está disponível para seu plano atual.');
        _upgradeCooldownAtivo = false;
        return;
    }

    criarPopupUpgrade(novoPlano, config);
}

// ========== POPUP DE UPGRADE ==========
function criarPopupUpgrade(novoPlano, config) {

    const upgradeConfirmado = obterUpgradeValido(usuarioAtual.planoAtual, novoPlano);
    if (!upgradeConfirmado) {
        _mostrarErro('❌ Upgrade inválido. Recarregue a página.');
        _upgradeCooldownAtivo = false;
        return;
    }

    const valorSeguro     = upgradeConfirmado.valor;
    const perfisDiferenca = config.perfis - PLANOS_CONFIG[usuarioAtual.planoAtual].perfis;

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
        animation:slideUp 0.4s ease-out; position:relative;
    `;

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

    // HTML estrutural estático — zero dados dinâmicos interpolados
    popup.innerHTML = `
        <div style="text-align:center;">
            <div id="_popupIconSlot"></div>
            <h2 id="_popupTitulo" style="font-size:1.8rem; font-weight:800; color:white; margin-bottom:12px;">🚀 Confirmar Upgrade</h2>
            <p style="color:#9ca3af; font-size:1rem; margin-bottom:32px;">Você está prestes a evoluir seu plano</p>
            <div style="background:rgba(255,255,255,0.05); border-radius:16px; padding:24px; margin-bottom:32px; text-align:left;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
                    <div>
                        <div style="font-size:0.85rem; color:#9ca3af; margin-bottom:6px;">Plano Atual</div>
                        <div id="_popupPlanoAtual" style="font-size:1.2rem; font-weight:700; color:white;"></div>
                    </div>
                    <div style="font-size:2rem; color:var(--primary);" aria-hidden="true">→</div>
                    <div>
                        <div style="font-size:0.85rem; color:#9ca3af; margin-bottom:6px;">Novo Plano</div>
                        <div id="_popupNovoPlano" style="font-size:1.2rem; font-weight:700; color:var(--primary);"></div>
                    </div>
                </div>
                <div style="border-top:1px solid rgba(255,255,255,0.1); padding-top:16px; text-align:center;">
                    <div style="font-size:0.85rem; color:#9ca3af; margin-bottom:8px;">Valor do Upgrade</div>
                    <div id="_popupValor" style="font-size:2.5rem; font-weight:900; background:linear-gradient(135deg,var(--primary),var(--accent)); -webkit-background-clip:text; -webkit-text-fill-color:transparent;"></div>
                    <div style="font-size:0.9rem; color:#10b981; margin-top:8px;">✅ Pagamento único • Acesso vitalício</div>
                </div>
            </div>
            <div style="background:rgba(108,99,255,0.1); border-radius:12px; padding:16px; margin-bottom:32px; text-align:left;">
                <div style="font-size:0.9rem; color:#9ca3af; margin-bottom:12px; text-align:center;">✨ O que você ganha:</div>
                <ul style="list-style:none; padding:0; margin:0;">
                    <li style="display:flex; align-items:center; gap:12px; margin-bottom:10px; color:white; font-size:0.95rem;">
                        <span style="color:#10b981;" aria-hidden="true">✓</span>
                        <span id="_popupPerfilExtra"></span>
                    </li>
                    <li style="display:flex; align-items:center; gap:12px; margin-bottom:10px; color:white; font-size:0.95rem;">
                        <span style="color:#10b981;" aria-hidden="true">✓</span>
                        <span>Todos os seus dados preservados</span>
                    </li>
                    <li style="display:flex; align-items:center; gap:12px; color:white; font-size:0.95rem;">
                        <span style="color:#10b981;" aria-hidden="true">✓</span>
                        <span>Ativação instantânea</span>
                    </li>
                </ul>
            </div>
            <div style="display:flex; gap:12px;">
                <button id="btnCancelarUpgrade" type="button"
                        style="flex:1; padding:16px; border-radius:12px;
                               border:2px solid rgba(255,255,255,0.1);
                               background:transparent; color:#9ca3af; font-size:1rem;
                               font-weight:600; cursor:pointer; transition:all 0.3s;">
                    Cancelar
                </button>
                <button id="btnConfirmarUpgrade" type="button"
                        style="flex:1; padding:16px; border-radius:12px; border:none;
                               background:linear-gradient(135deg,var(--primary),var(--accent));
                               color:white; font-size:1rem; font-weight:700; cursor:pointer;
                               box-shadow:0 4px 12px rgba(108,99,255,0.4); transition:all 0.3s;">
                    Prosseguir para Pagamento
                </button>
            </div>
        </div>
    `;

    popup.querySelector('#_popupIconSlot').appendChild(iconContainer);

    // Dados dinâmicos via textContent — zero XSS
    popup.querySelector('#_popupPlanoAtual').textContent  = usuarioAtual.planoAtual;
    popup.querySelector('#_popupNovoPlano').textContent   = novoPlano;
    popup.querySelector('#_popupValor').textContent       = `R$ ${valorSeguro.toFixed(2)}`;
    popup.querySelector('#_popupPerfilExtra').textContent = `+${perfisDiferenca} perfil(is) extra(s)`;

    overlay.appendChild(popup);
    document.body.appendChild(overlay);

    requestAnimationFrame(() => popup.focus());

    const fecharOverlay = () => {
        overlay.style.opacity = '0';
        overlay.style.transition = 'opacity 0.3s ease-out';
        document.removeEventListener('keydown', onKeyDown);
        setTimeout(() => {
            if (document.body.contains(overlay)) document.body.removeChild(overlay);
        }, 300);
    };

    popup.querySelector('#btnCancelarUpgrade').addEventListener('click', fecharOverlay);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) fecharOverlay(); });

    const onKeyDown = (e) => { if (e.key === 'Escape') fecharOverlay(); };
    document.addEventListener('keydown', onKeyDown);

    popup.querySelector('#btnConfirmarUpgrade').addEventListener('click', async () => {
        const btnConfirmar = popup.querySelector('#btnConfirmarUpgrade');

        if (btnConfirmar.dataset.processando === 'true') return;
        btnConfirmar.dataset.processando = 'true';
        btnConfirmar.textContent = 'Aguarde...';
        btnConfirmar.style.opacity = '0.7';
        btnConfirmar.setAttribute('aria-busy', 'true');

        try {
            const upgradeNoClique = obterUpgradeValido(usuarioAtual.planoAtual, novoPlano);
            if (!upgradeNoClique) {
                _mostrarErro('❌ Sessão inválida. Recarregue a página.');
                if (document.body.contains(overlay)) document.body.removeChild(overlay);
                return;
            }

            // Frontend envia APENAS o nome do plano — backend decide tudo mais
            const response = await fetch('/api/criar-sessao-upgrade', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ novoPlano: upgradeNoClique.para })
            });

            if (!response.ok) {
                const erro = await response.json().catch(() => ({}));
                throw new Error(erro.message || 'Falha ao iniciar upgrade');
            }

            const data = await response.json();

            // Valida HTTPS + hostname na whitelist (Relatório — Ponto 2)
            if (!_validarUrlPagamento(data.checkoutUrl)) {
                throw new Error('URL de pagamento inválida ou domínio não autorizado');
            }

            if (document.body.contains(overlay)) document.body.removeChild(overlay);
            document.removeEventListener('keydown', onKeyDown);

            window.location.href = data.checkoutUrl;

        } catch (error) {
            console.error('[UPGRADE] Erro ao iniciar pagamento:', error);
            _mostrarErro('❌ Não foi possível iniciar o pagamento. Tente novamente.');
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