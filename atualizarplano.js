/* =============================================
   GRANAEVO - ATUALIZAR PLANO JS
   AuthGuard removido temporariamente.
   Sessão lida diretamente via Supabase.
   ============================================= */

import { supabase } from './supabase-client.js';

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

let usuarioAtual = null;

// ========== VERIFICAÇÃO DE LOGIN ==========
// Lê a sessão diretamente do Supabase — sem depender do AuthGuard
async function verificarLogin() {
    const authLoading = document.getElementById('loadingScreen');

    try {
        const { data: { session }, error } = await supabase.auth.getSession();

        if (error || !session || !session.user) {
            if (authLoading) authLoading.style.display = 'none';
            alert('⚠️ Você precisa estar logado para atualizar seu plano!');
            window.location.href = 'login.html';
            return;
        }

        const user = session.user;

        // ⚠️ Ajuste o campo do plano conforme o que você salva no Supabase.
        // Exemplos comuns: user.user_metadata.plan | user.app_metadata.plan
        const plano = user.user_metadata?.plan || 'Individual';

        usuarioAtual = {
            nome: user.user_metadata?.name || user.email,
            planoAtual: plano,
            userId: user.id,
            email: user.email
        };

        if (authLoading) {
            setTimeout(() => authLoading.classList.add('hidden'), 1000);
        }

        inicializarPagina();

    } catch (e) {
        console.error('❌ Erro ao verificar sessão:', e);
        if (authLoading) authLoading.style.display = 'none';
        alert('❌ Erro ao verificar autenticação. Faça login novamente.');
        window.location.href = 'login.html';
    }
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
    const config = PLANOS_CONFIG[planoAtual];

    if (!config) {
        console.error('Plano não encontrado:', planoAtual);
        return;
    }

    const planoDisplay = document.getElementById('planoAtualDisplay');
    if (planoDisplay) {
        planoDisplay.innerHTML = `<strong><span style="display:inline-flex; align-items:center; gap:8px; vertical-align:middle;">${config.icon} <span>${config.nome}</span></span></strong>`;
    }

    const currentPlanCard = document.getElementById('currentPlanCard');
    if (currentPlanCard) {
        currentPlanCard.innerHTML = `
            <div class="current-plan-title">📌 Seu Plano Atual</div>
            <div class="current-plan-name">
                <span class="plan-icon-wrapper">${config.icon}</span>
                <span>${config.nome}</span>
            </div>
            <div class="current-plan-features">
                <div class="feature-badge">
                    <svg viewBox="0 0 24 24" fill="none" style="width:16px; height:16px; stroke:currentColor;">
                        <circle cx="12" cy="8" r="4" stroke="currentColor" stroke-width="2"/>
                        <path d="M6 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2" stroke="currentColor" stroke-width="2"/>
                    </svg>
                    ${config.perfis} ${config.perfis === 1 ? 'perfil' : 'perfis'}
                </div>
                <div class="feature-badge">
                    💰 R$ ${config.preco.toFixed(2)}
                </div>
                <div class="feature-badge">
                    ✅ Acesso Vitalício
                </div>
            </div>
        `;
    }
}

// ========== RENDERIZAR CARDS DE UPGRADE ==========
function renderizarCardsUpgrade() {
    const planoAtual = usuarioAtual.planoAtual;
    const precoAtual = PLANOS_CONFIG[planoAtual].preco;
    const grid = document.getElementById('upgradeCardsGrid');

    if (!grid) return;

    grid.innerHTML = '';

    const ordenacao = ["Individual", "Casal", "Família"];

    ordenacao.forEach(nomePlano => {
        const config = PLANOS_CONFIG[nomePlano];

        const isUpgrade = config.preco > precoAtual;
        const diferencaPreco = Math.max(0, config.preco - precoAtual);
        const economia = config.preco - diferencaPreco;
        const isCurrentOrLower = config.preco <= precoAtual;

        const card = document.createElement('div');
        card.className = 'upgrade-card';

        let badgeHTML = '';
        if (isUpgrade && diferencaPreco <= 20) {
            card.classList.add('recommended');
            badgeHTML = `<div class="upgrade-badge">⭐ Recomendado</div>`;
        }

        card.innerHTML = `
            ${badgeHTML}
            <div class="upgrade-header">
                <div class="upgrade-icon">${config.icon}</div>
                <div class="upgrade-name">${config.nome}</div>
                <div class="upgrade-subtitle">
                    ${isCurrentOrLower
                        ? (config.nome === planoAtual ? 'Seu plano atual' : 'Plano inferior')
                        : `Adicione ${config.perfis - PLANOS_CONFIG[planoAtual].perfis} perfil${config.perfis - PLANOS_CONFIG[planoAtual].perfis > 1 ? 's' : ''} extra${config.perfis - PLANOS_CONFIG[planoAtual].perfis > 1 ? 's' : ''}`}
                </div>
            </div>

            <div class="upgrade-pricing">
                ${isUpgrade ? `
                    <div class="original-price">De: R$ ${config.preco.toFixed(2)}</div>
                    <div class="upgrade-price">
                        <span class="price-label">Pague apenas:</span>
                        <span class="price-amount">R$ ${diferencaPreco.toFixed(2)}</span>
                    </div>
                    <div class="price-savings">💎 Economize R$ ${economia.toFixed(2)}</div>
                ` : `
                    <div class="upgrade-price">
                        <span class="price-amount" style="font-size:1.5rem; color:var(--gray);">
                            ${isCurrentOrLower && config.nome === planoAtual ? '✅ Ativo' : '❌ Indisponível'}
                        </span>
                    </div>
                `}
            </div>

            <ul class="upgrade-features">
                ${config.features.map(feature => `
                    <li>
                        <svg viewBox="0 0 24 24" fill="none">
                            <polyline points="20 6 9 17 4 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                        </svg>
                        ${feature}
                    </li>
                `).join('')}
            </ul>

            <button class="btn-upgrade ${isCurrentOrLower ? 'disabled' : ''}"
                    ${isCurrentOrLower ? 'disabled' : ''}
                    data-plano="${nomePlano}"
                    data-valor="${diferencaPreco.toFixed(2)}">
                ${isCurrentOrLower
                    ? (config.nome === planoAtual ? '✅ Plano Atual' : '⬇️ Downgrade Indisponível')
                    : `⬆️ Fazer Upgrade por R$ ${diferencaPreco.toFixed(2)}`}
            </button>
        `;

        if (!isCurrentOrLower) {
            const btn = card.querySelector('.btn-upgrade');
            btn.addEventListener('click', () => {
                processarUpgrade(nomePlano, parseFloat(diferencaPreco.toFixed(2)));
            });
        }

        grid.appendChild(card);
    });
}

// ========== PROCESSAR UPGRADE ==========
function processarUpgrade(novoPlano, valorPagar) {
    const config = PLANOS_CONFIG[novoPlano];

    if (!config) {
        alert('❌ Erro: Plano não encontrado!');
        return;
    }

    criarPopupUpgrade(novoPlano, valorPagar, config);
}

// ========== POPUP DE UPGRADE ==========
function criarPopupUpgrade(novoPlano, valorPagar, config) {
    const overlay = document.createElement('div');
    overlay.style.cssText = `
        position: fixed;
        top: 0; left: 0;
        width: 100%; height: 100%;
        background: rgba(0, 0, 0, 0.8);
        backdrop-filter: blur(10px);
        z-index: 10000;
        display: flex;
        align-items: center;
        justify-content: center;
        animation: fadeIn 0.3s ease-out;
    `;

    const popup = document.createElement('div');
    popup.style.cssText = `
        background: linear-gradient(135deg, #1a1d3a 0%, #0d0f1f 100%);
        border-radius: 24px;
        padding: 40px;
        max-width: 500px;
        width: 90%;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
        border: 1px solid rgba(108, 99, 255, 0.3);
        animation: slideUp 0.4s ease-out;
        position: relative;
    `;

    popup.innerHTML = `
        <div style="text-align: center;">
            <div style="width:80px; height:80px; margin:0 auto 20px; background:linear-gradient(135deg,var(--primary),var(--accent)); border-radius:50%; display:flex; align-items:center; justify-content:center; box-shadow:0 8px 24px rgba(108,99,255,0.4);">
                ${config.icon}
            </div>
            <h2 style="font-size:1.8rem; font-weight:800; color:white; margin-bottom:12px;">🚀 Confirmar Upgrade</h2>
            <p style="color:#9ca3af; font-size:1rem; margin-bottom:32px;">Você está prestes a evoluir seu plano</p>

            <div style="background:rgba(255,255,255,0.05); border-radius:16px; padding:24px; margin-bottom:32px; text-align:left;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
                    <div>
                        <div style="font-size:0.85rem; color:#9ca3af; margin-bottom:6px;">Plano Atual</div>
                        <div style="font-size:1.2rem; font-weight:700; color:white;">${usuarioAtual.planoAtual}</div>
                    </div>
                    <div style="font-size:2rem; color:var(--primary);">→</div>
                    <div>
                        <div style="font-size:0.85rem; color:#9ca3af; margin-bottom:6px;">Novo Plano</div>
                        <div style="font-size:1.2rem; font-weight:700; color:var(--primary);">${novoPlano}</div>
                    </div>
                </div>
                <div style="border-top:1px solid rgba(255,255,255,0.1); padding-top:16px; text-align:center;">
                    <div style="font-size:0.85rem; color:#9ca3af; margin-bottom:8px;">Valor do Upgrade</div>
                    <div style="font-size:2.5rem; font-weight:900; background:linear-gradient(135deg,var(--primary),var(--accent)); -webkit-background-clip:text; -webkit-text-fill-color:transparent;">
                        R$ ${valorPagar.toFixed(2)}
                    </div>
                    <div style="font-size:0.9rem; color:#10b981; margin-top:8px;">✅ Pagamento único • Acesso vitalício</div>
                </div>
            </div>

            <div style="background:rgba(108,99,255,0.1); border-radius:12px; padding:16px; margin-bottom:32px; text-align:left;">
                <div style="font-size:0.9rem; color:#9ca3af; margin-bottom:12px; text-align:center;">✨ O que você ganha:</div>
                <ul style="list-style:none; padding:0; margin:0;">
                    <li style="display:flex; align-items:center; gap:12px; margin-bottom:10px; color:white; font-size:0.95rem;">
                        <span style="color:#10b981;">✓</span>
                        <span>+${config.perfis - PLANOS_CONFIG[usuarioAtual.planoAtual].perfis} perfil(is) extra(s)</span>
                    </li>
                    <li style="display:flex; align-items:center; gap:12px; margin-bottom:10px; color:white; font-size:0.95rem;">
                        <span style="color:#10b981;">✓</span>
                        <span>Todos os seus dados preservados</span>
                    </li>
                    <li style="display:flex; align-items:center; gap:12px; color:white; font-size:0.95rem;">
                        <span style="color:#10b981;">✓</span>
                        <span>Ativação instantânea</span>
                    </li>
                </ul>
            </div>

            <div style="display:flex; gap:12px;">
                <button id="btnCancelarUpgrade" style="flex:1; padding:16px; border-radius:12px; border:2px solid rgba(255,255,255,0.1); background:transparent; color:#9ca3af; font-size:1rem; font-weight:600; cursor:pointer; transition:all 0.3s;">
                    Cancelar
                </button>
                <button id="btnConfirmarUpgrade" style="flex:1; padding:16px; border-radius:12px; border:none; background:linear-gradient(135deg,var(--primary),var(--accent)); color:white; font-size:1rem; font-weight:700; cursor:pointer; box-shadow:0 4px 12px rgba(108,99,255,0.4); transition:all 0.3s;">
                    Prosseguir para Pagamento
                </button>
            </div>
        </div>
    `;

    overlay.appendChild(popup);
    document.body.appendChild(overlay);

    const style = document.createElement('style');
    style.textContent = `
        @keyframes fadeIn { from { opacity:0; } to { opacity:1; } }
        @keyframes slideUp { from { opacity:0; transform:translateY(30px); } to { opacity:1; transform:translateY(0); } }
        #btnCancelarUpgrade:hover { background:rgba(255,255,255,0.05); border-color:rgba(255,255,255,0.2); }
        #btnConfirmarUpgrade:hover { transform:translateY(-2px); box-shadow:0 6px 20px rgba(108,99,255,0.6); }
    `;
    document.head.appendChild(style);

    const fecharOverlay = () => {
        overlay.style.opacity = '0';
        overlay.style.transition = 'opacity 0.3s ease-out';
        setTimeout(() => document.body.removeChild(overlay), 300);
    };

    document.getElementById('btnCancelarUpgrade').addEventListener('click', fecharOverlay);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) fecharOverlay(); });

    document.getElementById('btnConfirmarUpgrade').addEventListener('click', () => {
        document.body.removeChild(overlay);

        // ⬅️ CONFIGURE A URL DA SUA PÁGINA DE PAGAMENTO AQUI
        const URL_PAGAMENTO = '';

        if (URL_PAGAMENTO) {
            sessionStorage.setItem('upgrade_pendente', JSON.stringify({
                planoAtual: usuarioAtual.planoAtual,
                novoPlano,
                valorPagar,
                userId: usuarioAtual.userId,
                timestamp: Date.now()
            }));
            window.location.href = URL_PAGAMENTO;
        } else {
            alert('⚠️ Configure a URL de pagamento na variável URL_PAGAMENTO');
        }
    });
}

// ========== FAQ ACCORDION ==========
function configurarFAQ() {
    const faqItems = document.querySelectorAll('.faq-item');

    faqItems.forEach(item => {
        const question = item.querySelector('.faq-question');
        const answer = item.querySelector('.faq-answer');

        question.addEventListener('click', () => {
            const isActive = item.classList.contains('active');

            faqItems.forEach(otherItem => {
                otherItem.classList.remove('active');
                otherItem.querySelector('.faq-answer').style.maxHeight = null;
            });

            if (!isActive) {
                item.classList.add('active');
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
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
    };

    class Particle {
        constructor() {
            this.x = Math.random() * canvas.width;
            this.y = Math.random() * canvas.height;
            this.size = Math.random() * 2 + 1;
            this.speedX = (Math.random() - 0.5) * 0.5;
            this.speedY = (Math.random() - 0.5) * 0.5;
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