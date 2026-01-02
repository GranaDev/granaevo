/* =============================================
   GRANAEVO - ATUALIZAR PLANO JS
   Sistema de Upgrade com Proteção de Login
   ============================================= */

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
function verificarLogin() {
    const authLoading = document.getElementById('loadingScreen');
    const session = AuthGuard.getUserData();
    
    if (!session) {
        if(authLoading) authLoading.style.display = 'none';
        alert('⚠️ Você precisa estar logado para atualizar seu plano!');
        window.location.href = 'login.html';
        return;
    }
    
    usuarioAtual = {
        nome: session.name,
        planoAtual: session.plan
    };
    
    if(authLoading) {
        setTimeout(() => {
            authLoading.classList.add('hidden');
        }, 1000);
    }
    
    inicializarPagina();
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
    
    if(!config) {
        console.error('Plano não encontrado:', planoAtual);
        return;
    }
    
    // Atualizar display do plano
    const planoDisplay = document.getElementById('planoAtualDisplay');
    if(planoDisplay) {
        planoDisplay.innerHTML = `<strong><span style="display:inline-flex; align-items:center; gap:8px; vertical-align:middle;">${config.icon} <span>${config.nome}</span></span></strong>`;
    }
    
    // Renderizar card do plano atual
    const currentPlanCard = document.getElementById('currentPlanCard');
    if(currentPlanCard) {
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
    
    if(!grid) return;
    
    grid.innerHTML = '';
    
    // Ordem dos planos
    const ordenacao = ["Individual", "Casal", "Família"];
    
    ordenacao.forEach(nomePlano => {
        const config = PLANOS_CONFIG[nomePlano];
        
        // Calcular se é upgrade ou não
        const isUpgrade = config.preco > precoAtual;
        const diferencaPreco = Math.max(0, config.preco - precoAtual);
        const economia = config.preco - diferencaPreco;
        
        // Card de upgrade
        const card = document.createElement('div');
        card.className = 'upgrade-card';
        
        // Adicionar badge "Recomendado" para o próximo plano
        if(isUpgrade && diferencaPreco <= 20) {
            card.classList.add('recommended');
            card.innerHTML += `<div class="upgrade-badge">⭐ Recomendado</div>`;
        }
        
        // Desabilitar se for o plano atual ou inferior
        const isCurrentOrLower = config.preco <= precoAtual;
        
        card.innerHTML += `
            <div class="upgrade-header">
                <div class="upgrade-icon">${config.icon}</div>
                <div class="upgrade-name">${config.nome}</div>
                <div class="upgrade-subtitle">
                    ${isCurrentOrLower ? 
                        (config.nome === planoAtual ? 'Seu plano atual' : 'Plano inferior') : 
                        `Adicione ${config.perfis - PLANOS_CONFIG[planoAtual].perfis} perfil${config.perfis - PLANOS_CONFIG[planoAtual].perfis > 1 ? 's' : ''} extra${config.perfis - PLANOS_CONFIG[planoAtual].perfis > 1 ? 's' : ''}`}
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
                    onclick="processarUpgrade('${nomePlano}', ${diferencaPreco.toFixed(2)})">
                ${isCurrentOrLower ? 
                    (config.nome === planoAtual ? '✅ Plano Atual' : '⬇️ Downgrade Indisponível') : 
                    `⬆️ Fazer Upgrade por R$ ${diferencaPreco.toFixed(2)}`}
            </button>
        `;
        
        grid.appendChild(card);
    });
}

// ========== PROCESSAR UPGRADE ==========
function processarUpgrade(novoPlano, valorPagar) {
    const config = PLANOS_CONFIG[novoPlano];
    
    if(!config) {
        alert('❌ Erro: Plano não encontrado!');
        return;
    }
    
    // ✅ CRIAR POP-UP ESTILIZADO
    criarPopupUpgrade(novoPlano, valorPagar, config);
}

// ✅ ADICIONAR ESTA NOVA FUNÇÃO LOGO APÓS processarUpgrade():
function criarPopupUpgrade(novoPlano, valorPagar, config) {
    // Criar overlay
    const overlay = document.createElement('div');
    overlay.className = 'popup-overlay';
    overlay.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.8);
        backdrop-filter: blur(10px);
        z-index: 10000;
        display: flex;
        align-items: center;
        justify-content: center;
        animation: fadeIn 0.3s ease-out;
    `;
    
    // Criar container do popup
    const popup = document.createElement('div');
    popup.className = 'upgrade-popup';
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
            <!-- Ícone do Plano -->
            <div style="width: 80px; height: 80px; margin: 0 auto 20px; background: linear-gradient(135deg, var(--primary), var(--secondary)); border-radius: 50%; display: flex; align-items: center; justify-content: center; box-shadow: 0 8px 24px rgba(108, 99, 255, 0.4);">
                ${config.icon}
            </div>
            
            <!-- Título -->
            <h2 style="font-size: 1.8rem; font-weight: 800; color: white; margin-bottom: 12px;">
                🚀 Confirmar Upgrade
            </h2>
            
            <!-- Subtítulo -->
            <p style="color: var(--gray); font-size: 1rem; margin-bottom: 32px;">
                Você está prestes a evoluir seu plano
            </p>
            
            <!-- Comparação de Planos -->
            <div style="background: rgba(255, 255, 255, 0.05); border-radius: 16px; padding: 24px; margin-bottom: 32px; text-align: left;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
                    <div>
                        <div style="font-size: 0.85rem; color: var(--gray); margin-bottom: 6px;">Plano Atual</div>
                        <div style="font-size: 1.2rem; font-weight: 700; color: white;">${usuarioAtual.planoAtual}</div>
                    </div>
                    <div style="font-size: 2rem; color: var(--primary);">→</div>
                    <div>
                        <div style="font-size: 0.85rem; color: var(--gray); margin-bottom: 6px;">Novo Plano</div>
                        <div style="font-size: 1.2rem; font-weight: 700; color: var(--primary);">${novoPlano}</div>
                    </div>
                </div>
                
                <!-- Valor a Pagar -->
                <div style="border-top: 1px solid rgba(255, 255, 255, 0.1); padding-top: 16px; text-align: center;">
                    <div style="font-size: 0.85rem; color: var(--gray); margin-bottom: 8px;">Valor do Upgrade</div>
                    <div style="font-size: 2.5rem; font-weight: 900; background: linear-gradient(135deg, var(--primary), var(--secondary)); -webkit-background-clip: text; -webkit-text-fill-color: transparent;">
                        R$ ${valorPagar.toFixed(2)}
                    </div>
                    <div style="font-size: 0.9rem; color: var(--success); margin-top: 8px;">
                        ✅ Pagamento único • Acesso vitalício
                    </div>
                </div>
            </div>
            
            <!-- Benefícios -->
            <div style="background: rgba(108, 99, 255, 0.1); border-radius: 12px; padding: 16px; margin-bottom: 32px; text-align: left;">
                <div style="font-size: 0.9rem; color: var(--gray); margin-bottom: 12px; text-align: center;">✨ O que você ganha:</div>
                <ul style="list-style: none; padding: 0; margin: 0;">
                    <li style="display: flex; align-items: center; gap: 12px; margin-bottom: 10px; color: white; font-size: 0.95rem;">
                        <span style="color: var(--success); font-size: 1.2rem;">✓</span>
                        <span>+${config.perfis - PLANOS_CONFIG[usuarioAtual.planoAtual].perfis} perfil(is) extra(s)</span>
                    </li>
                    <li style="display: flex; align-items: center; gap: 12px; margin-bottom: 10px; color: white; font-size: 0.95rem;">
                        <span style="color: var(--success); font-size: 1.2rem;">✓</span>
                        <span>Todos os seus dados preservados</span>
                    </li>
                    <li style="display: flex; align-items: center; gap: 12px; color: white; font-size: 0.95rem;">
                        <span style="color: var(--success); font-size: 1.2rem;">✓</span>
                        <span>Ativação instantânea</span>
                    </li>
                </ul>
            </div>
            
            <!-- Botões -->
            <div style="display: flex; gap: 12px; margin-top: 32px;">
                <button id="btnCancelarUpgrade" style="flex: 1; padding: 16px; border-radius: 12px; border: 2px solid rgba(255, 255, 255, 0.1); background: transparent; color: var(--gray); font-size: 1rem; font-weight: 600; cursor: pointer; transition: all 0.3s;">
                    Cancelar
                </button>
                <button id="btnConfirmarUpgrade" style="flex: 1; padding: 16px; border-radius: 12px; border: none; background: linear-gradient(135deg, var(--primary), var(--secondary)); color: white; font-size: 1rem; font-weight: 700; cursor: pointer; box-shadow: 0 4px 12px rgba(108, 99, 255, 0.4); transition: all 0.3s;">
                    Prosseguir para Pagamento
                </button>
            </div>
        </div>
    `;
    
    overlay.appendChild(popup);
    document.body.appendChild(overlay);
    
    // ✅ Adicionar animações CSS
    const style = document.createElement('style');
    style.textContent = `
        @keyframes fadeIn {
            from { opacity: 0; }
            to { opacity: 1; }
        }
        
        @keyframes slideUp {
            from {
                opacity: 0;
                transform: translateY(30px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }
        
        #btnCancelarUpgrade:hover {
            background: rgba(255, 255, 255, 0.05);
            border-color: rgba(255, 255, 255, 0.2);
        }
        
        #btnConfirmarUpgrade:hover {
            transform: translateY(-2px);
            box-shadow: 0 6px 20px rgba(108, 99, 255, 0.6);
        }
    `;
    document.head.appendChild(style);
    
    // ✅ Event Listeners
    document.getElementById('btnCancelarUpgrade').onclick = () => {
        overlay.style.animation = 'fadeOut 0.3s ease-out';
        setTimeout(() => document.body.removeChild(overlay), 300);
    };
    
    document.getElementById('btnConfirmarUpgrade').onclick = () => {
        document.body.removeChild(overlay);
        
        // ✅ REDIRECIONAR PARA PÁGINA DE PAGAMENTO (DEIXAR EM BRANCO PARA VOCÊ CONFIGURAR)
        const URL_PAGAMENTO = ''; // ⬅️ DIGITE AQUI A URL DA SUA PÁGINA DE PAGAMENTO
        
        if(URL_PAGAMENTO) {
            // Salvar dados do upgrade no sessionStorage para uso na página de pagamento
            sessionStorage.setItem('upgrade_pendente', JSON.stringify({
                planoAtual: usuarioAtual.planoAtual,
                novoPlano: novoPlano,
                valorPagar: valorPagar,
                timestamp: Date.now()
            }));
            
            window.location.href = URL_PAGAMENTO;
        } else {
            alert('⚠️ Configure a URL de pagamento na variável URL_PAGAMENTO');
        }
    };
}

// ========== LOADING DE PAGAMENTO ==========
function mostrarLoadingPagamento() {
    const loading = document.getElementById('loadingScreen');
    if(loading) {
        loading.classList.remove('hidden');
        loading.style.display = 'flex';
        
        const loaderIcon = loading.querySelector('.loader-icon svg');
        if(loaderIcon) {
            loaderIcon.innerHTML = `
                <path d="M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48l2.83-2.83" 
                      stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            `;
        }
    }
}

// ========== FAQ ACCORDION ==========
function configurarFAQ() {
    const faqItems = document.querySelectorAll('.faq-item');
    
    faqItems.forEach(item => {
        const question = item.querySelector('.faq-question');
        const answer = item.querySelector('.faq-answer');
        
        question.addEventListener('click', () => {
            const isActive = item.classList.contains('active');
            
            // Fecha todos
            faqItems.forEach(otherItem => {
                otherItem.classList.remove('active');
                const otherAnswer = otherItem.querySelector('.faq-answer');
                otherAnswer.style.maxHeight = null;
            });
            
            // Abre o clicado se não estava ativo
            if(!isActive) {
                item.classList.add('active');
                answer.style.maxHeight = answer.scrollHeight + 'px';
            }
        });
    });
}

// ========== PARTÍCULAS (OPCIONAL) ==========
function inicializarParticulas() {
    // Sistema de partículas similar ao planos.js
    const canvas = document.getElementById('particlesCanvas');
    if (!canvas || window.innerWidth <= 768) return;
    
    const ctx = canvas.getContext('2d');
    let particles = [];

    function resizeCanvas() {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
    }

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

            if (this.x > canvas.width) this.x = 0;
            if (this.x < 0) this.x = canvas.width;
            if (this.y > canvas.height) this.y = 0;
            if (this.y < 0) this.y = canvas.height;
        }

        draw() {
            ctx.fillStyle = `rgba(108, 99, 255, ${this.opacity})`;
            ctx.beginPath();
            ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    function init() {
        particles = [];
        const particleCount = 50;
        
        for (let i = 0; i < particleCount; i++) {
            particles.push(new Particle());
        }
    }

    function animate() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        
        particles.forEach(particle => {
            particle.update();
            particle.draw();
        });

        requestAnimationFrame(animate);
    }

    resizeCanvas();
    init();
    animate();

    window.addEventListener('resize', () => {
        resizeCanvas();
        init();
    });
}

// ========== INICIALIZAÇÃO ==========
document.addEventListener('DOMContentLoaded', () => {
    verificarLogin();
});

// ========== EXPOR FUNÇÕES GLOBALMENTE ==========
window.processarUpgrade = processarUpgrade;

console.log('%c🚀 Página de Upgrade Carregada', 'color: #6c63ff; font-size: 16px; font-weight: bold;');