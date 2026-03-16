// ==========================================
// GRANAEVO PLANOS — planos.js
// Versão Segura v2 | Todos os fixes aplicados
// ==========================================

// ==========================================
// CONFIGURAÇÕES
// ==========================================
const CONFIG = {
    purchaseNotification: {
        minInterval: 15000,
        maxInterval: 90000,
        duration:    5000
    },
    names: [
        'Maria Silva',    'João Santos',      'Ana Costa',        'Carlos Pereira',
        'Patricia Oliveira', 'Roberto Lima',  'Juliana Martins',  'Fernando Souza',
        'Camila Rocha',   'Ricardo Alves',    'Beatriz Fernandes','Thiago Mendes',
        'Lucas Ribeiro',  'Amanda Costa',     'Rafael Santos',    'Larissa Oliveira'
    ],
    plans: ['Individual', 'Casal', 'Família'],

    // ✅ FIX #4 — Domínios permitidos para redirecionamento (whitelist).
    // Qualquer URL fora desta lista é bloqueada em safeRedirect(),
    // prevenindo Open Redirect e phishing mesmo em cenários de XSS futuro.
    allowedRedirectDomains: ['pay.cakto.com.br'],

    // ✅ FIX EXTRA #5 — Normalização de data-plan → chave canônica.
    // O HTML usa data-plan em lowercase ("individual", "casal", "familia").
    // O checkoutUrls usa as chaves com acentuação e capitalização corretas.
    planNameMap: {
        'individual': 'Individual',
        'casal':      'Casal',
        'familia':    'Família'
    }
};

// ==========================================
// CHECKOUT — REDIRECIONAMENTO SEGURO
// ==========================================

// URLs fixas e imutáveis. Nunca construa esta URL a partir de input do usuário.
// Object.freeze() impede que qualquer outro script modifique as chaves/valores em runtime.
const CHECKOUT_URLS = Object.freeze({
    'Individual': 'https://pay.cakto.com.br/figw38w_731973',
    'Casal':      'https://pay.cakto.com.br/rmq8b33_731974',
    'Família':    'https://pay.cakto.com.br/4x7ii5i_731976'
});

// ✅ FIX NOVO #10 — Debounce de checkout.
// Impede que um bot ou clique rápido repetido dispare múltiplos
// redirecionamentos / eventos de analytics em sequência.
// O lock é liberado após 2 segundos, protegendo sem prejudicar UX.
let checkoutLock = false;

// ✅ FIX #4 — Safe Redirect:
// Valida domínio e protocolo antes de qualquer redirecionamento.
function safeRedirect(url) {
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        console.error('[GranaEvo] URL inválida bloqueada:', url);
        return;
    }

    if (!CONFIG.allowedRedirectDomains.includes(parsed.hostname)) {
        console.error('[GranaEvo] Redirecionamento bloqueado — domínio não autorizado:', parsed.hostname);
        return;
    }

    if (parsed.protocol !== 'https:') {
        console.error('[GranaEvo] Redirecionamento bloqueado — protocolo não é HTTPS:', parsed.protocol);
        return;
    }

    window.location.href = url;
}

// ✅ FIX #2 — Função estritamente interna ao módulo ES (type="module").
// Não existe mais window.iniciarCheckout.
// ✅ FIX EXTRA #5 — Normaliza o nome do plano antes de qualquer validação.
// ✅ FIX #4 — Usa safeRedirect em vez de window.location.href direto.
// ✅ FIX NOVO #10 — Protegido por checkoutLock para evitar flood de cliques.
function iniciarCheckout(rawPlanName) {
    // Debounce — rejeita chamadas repetidas dentro de 2 segundos
    if (checkoutLock) {
        console.warn('[GranaEvo] Checkout bloqueado — aguarde antes de tentar novamente.');
        return;
    }

    // Normaliza: "individual" → "Individual", "familia" → "Família", etc.
    const normalized = CONFIG.planNameMap[rawPlanName?.toLowerCase()] ?? rawPlanName;

    // Whitelist explícita — rejeita qualquer valor não mapeado
    if (!Object.prototype.hasOwnProperty.call(CHECKOUT_URLS, normalized)) {
        console.error('[GranaEvo] Plano desconhecido bloqueado:', rawPlanName);
        return;
    }

    const checkoutUrl = CHECKOUT_URLS[normalized];

    // Ativa lock antes do redirect — libera após 2s caso o redirect falhe
    checkoutLock = true;
    setTimeout(() => { checkoutLock = false; }, 2000);

    trackEvent('Plan', 'checkout_click', normalized);

    safeRedirect(checkoutUrl);
}

// ✅ FIX #2 — Bind via event listeners (sem onclick inline no HTML).
function bindCheckoutButtons() {
    document.querySelectorAll('.btn-plan[data-plan]').forEach(btn => {
        btn.addEventListener('click', () => {
            iniciarCheckout(btn.dataset.plan);
        });
    });
}

// ==========================================
// LOADING SCREEN
// ==========================================
window.addEventListener('load', () => {
    const loadingScreen = document.getElementById('loadingScreen');
    if (loadingScreen) {
        setTimeout(() => {
            loadingScreen.classList.add('hidden');
        }, 1200);
    }
});

// ==========================================
// SCROLL PROGRESS BAR
// ==========================================
const scrollProgress = document.getElementById('scrollProgress');

function updateScrollProgress() {
    const windowHeight   = window.innerHeight;
    const documentHeight = document.documentElement.scrollHeight - windowHeight;
    const scrolled       = window.scrollY;
    const progress       = documentHeight > 0 ? (scrolled / documentHeight) * 100 : 0;

    if (scrollProgress) {
        scrollProgress.style.width = `${Math.min(progress, 100)}%`;
    }
}

window.addEventListener('scroll', updateScrollProgress, { passive: true });

// ==========================================
// HEADER SCROLL EFFECT
// ==========================================
const header = document.getElementById('header');

function handleHeaderScroll() {
    if (!header) return;
    if (window.scrollY > 100) {
        header.classList.add('scrolled');
    } else {
        header.classList.remove('scrolled');
    }
}

window.addEventListener('scroll', handleHeaderScroll, { passive: true });

// ==========================================
// MOBILE MENU TOGGLE
// ==========================================
const mobileToggle = document.getElementById('mobileToggle');
const navLinks     = document.getElementById('navLinks');

if (mobileToggle && navLinks) {
    mobileToggle.addEventListener('click', () => {
        const isActive = mobileToggle.classList.toggle('active');
        navLinks.classList.toggle('active');
        document.body.style.overflow = isActive ? 'hidden' : '';
        mobileToggle.setAttribute('aria-expanded', String(isActive));
    });

    // Fechar menu ao clicar em um link
    navLinks.querySelectorAll('a').forEach(link => {
        link.addEventListener('click', () => {
            mobileToggle.classList.remove('active');
            navLinks.classList.remove('active');
            document.body.style.overflow = '';
            mobileToggle.setAttribute('aria-expanded', 'false');
        });
    });

    // Fechar menu ao clicar fora
    document.addEventListener('click', (e) => {
        if (!navLinks.contains(e.target) && !mobileToggle.contains(e.target)) {
            mobileToggle.classList.remove('active');
            navLinks.classList.remove('active');
            document.body.style.overflow = '';
            mobileToggle.setAttribute('aria-expanded', 'false');
        }
    });
}

// ==========================================
// CAROUSEL DE PLANOS — OTIMIZADO
// ==========================================
let currentSlide     = 1; // Começa no plano Casal (featured)
const planCardsArray = Array.from(document.querySelectorAll('.plan-card'));
const totalSlides    = planCardsArray.length;
let isTransitioning  = false;

function initCarousel() {
    const track      = document.getElementById('plansTrack');
    const indicators = document.getElementById('carouselIndicators');
    const prevBtn    = document.getElementById('prevBtn');
    const nextBtn    = document.getElementById('nextBtn');

    if (!track || window.innerWidth >= 768) return;

    // Criar indicadores
    if (indicators) {
        indicators.innerHTML = '';
        for (let i = 0; i < totalSlides; i++) {
            const dot = document.createElement('button');
            dot.className = 'indicator-dot';
            dot.setAttribute('aria-label', `Ir para plano ${i + 1}`);
            if (i === currentSlide) dot.classList.add('active');
            dot.addEventListener('click', () => goToSlide(i));
            indicators.appendChild(dot);
        }
    }

    // Navegar para o slide inicial
    goToSlide(currentSlide, false);

    // Event listeners dos botões
    if (prevBtn) {
        prevBtn.addEventListener('click', () => {
            if (isTransitioning) return;
            currentSlide = (currentSlide - 1 + totalSlides) % totalSlides;
            goToSlide(currentSlide);
        });
    }

    if (nextBtn) {
        nextBtn.addEventListener('click', () => {
            if (isTransitioning) return;
            currentSlide = (currentSlide + 1) % totalSlides;
            goToSlide(currentSlide);
        });
    }

    // Touch/Swipe support
    let touchStartX = 0;
    let touchEndX   = 0;
    let touchStartY = 0;
    let touchEndY   = 0;
    let isDragging  = false;

    track.addEventListener('touchstart', (e) => {
        touchStartX = e.changedTouches[0].screenX;
        touchStartY = e.changedTouches[0].screenY;
        isDragging  = true;
    }, { passive: true });

    track.addEventListener('touchmove', (e) => {
        if (!isDragging) return;
        touchEndX = e.changedTouches[0].screenX;
        touchEndY = e.changedTouches[0].screenY;
        const deltaX = touchStartX - touchEndX;
        const deltaY = touchStartY - touchEndY;
        if (Math.abs(deltaX) > Math.abs(deltaY)) {
            e.preventDefault();
        }
    }, { passive: false });

    track.addEventListener('touchend', (e) => {
        if (!isDragging) return;
        touchEndX = e.changedTouches[0].screenX;
        touchEndY = e.changedTouches[0].screenY;
        handleSwipe();
        isDragging = false;
    }, { passive: true });

    function handleSwipe() {
        const swipeThreshold = 50;
        const deltaX = touchStartX - touchEndX;
        const deltaY = touchStartY - touchEndY;

        if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > swipeThreshold) {
            if (isTransitioning) return;
            currentSlide = deltaX > 0
                ? (currentSlide + 1) % totalSlides
                : (currentSlide - 1 + totalSlides) % totalSlides;
            goToSlide(currentSlide);
        }
    }

    // Keyboard navigation
    document.addEventListener('keydown', (e) => {
        if (window.innerWidth >= 768 || isTransitioning) return;

        if (e.key === 'ArrowLeft') {
            currentSlide = (currentSlide - 1 + totalSlides) % totalSlides;
            goToSlide(currentSlide);
        } else if (e.key === 'ArrowRight') {
            currentSlide = (currentSlide + 1) % totalSlides;
            goToSlide(currentSlide);
        }
    });
}

function goToSlide(index, animate = true) {
    const track      = document.getElementById('plansTrack');
    const indicators = document.querySelectorAll('.indicator-dot');

    if (!track || window.innerWidth >= 768) return;

    isTransitioning = true;
    currentSlide    = index;

    if (!animate) {
        track.style.transition = 'none';
    }
    track.style.transform = `translateX(${-index * 100}%)`;

    if (!animate) {
        setTimeout(() => { track.style.transition = ''; }, 50);
    }

    indicators.forEach((dot, i) => {
        dot.classList.toggle('active', i === index);
    });

    planCardsArray.forEach((card, i) => {
        card.classList.toggle('active-slide', i === index);
    });

    setTimeout(() => { isTransitioning = false; }, 500);
}

// Inicializar carousel
if (window.innerWidth < 768) {
    initCarousel();
}

// Reinicializar no resize
let resizeTimer;
window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
        if (window.innerWidth < 768) {
            initCarousel();
        } else {
            const track = document.getElementById('plansTrack');
            if (track) track.style.transform = 'translateX(0)';
            planCardsArray.forEach(card => card.classList.remove('active-slide'));
        }
    }, 250);
});

// ==========================================
// SMOOTH SCROLL
// ==========================================
// ✅ FIX NOVO — Validação estrita do seletor CSS antes de querySelector.
// O relatório apontou document.querySelector(href) como ponto de atenção.
// Mesmo com href iniciando em '#', seletores inválidos como "#a:not(b" ou
// "#foo, body" poderiam lançar exceção ou selecionar elementos não-intencionais.
// A regex /^#[a-zA-Z0-9_-]+$/ garante que apenas IDs simples e seguros são aceitos.
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
        const href = this.getAttribute('href');

        // Rejeita hrefs vazios, somente '#', ou seletores CSS complexos/inválidos
        if (!href || !/^#[a-zA-Z0-9_-]+$/.test(href)) return;

        e.preventDefault();
        const target = document.querySelector(href);

        if (target && header) {
            const headerHeight   = header.offsetHeight;
            const targetPosition = target.offsetTop - headerHeight - 20;

            window.scrollTo({
                top:      targetPosition,
                behavior: 'smooth'
            });
        }
    });
});

// ==========================================
// PARTICLES CANVAS
// ==========================================
const canvas = document.getElementById('particlesCanvas');
if (canvas) {
    const ctx = canvas.getContext('2d');

    function resizeCanvas() {
        canvas.width  = window.innerWidth;
        canvas.height = window.innerHeight;
    }

    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    const particleCount = window.innerWidth < 768 ? 30 : 50;
    const particles     = [];

    class Particle {
        constructor() {
            this.x       = Math.random() * canvas.width;
            this.y       = Math.random() * canvas.height;
            this.size    = Math.random() * 2 + 1;
            this.speedX  = Math.random() * 0.5 - 0.25;
            this.speedY  = Math.random() * 0.5 - 0.25;
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
            ctx.fillStyle = `rgba(16, 185, 129, ${this.opacity})`;
            ctx.beginPath();
            ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    for (let i = 0; i < particleCount; i++) {
        particles.push(new Particle());
    }

    function animateParticles() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        particles.forEach(p => { p.update(); p.draw(); });
        requestAnimationFrame(animateParticles);
    }

    animateParticles();
}

// ==========================================
// PURCHASE NOTIFICATIONS
// ==========================================
const purchaseNotification = document.getElementById('purchaseNotification');

function getRandomInterval() {
    const { minInterval, maxInterval } = CONFIG.purchaseNotification;
    return Math.floor(Math.random() * (maxInterval - minInterval) + minInterval);
}

function showPurchaseNotification() {
    if (!purchaseNotification) return;

    const randomName = CONFIG.names[Math.floor(Math.random() * CONFIG.names.length)];
    const randomPlan = CONFIG.plans[Math.floor(Math.random() * CONFIG.plans.length)];

    const nameElement   = purchaseNotification.querySelector('.notification-name');
    const actionElement = purchaseNotification.querySelector('.notification-action strong');

    // ✅ textContent — sem risco de XSS via innerHTML
    if (nameElement)   nameElement.textContent   = randomName;
    if (actionElement) actionElement.textContent = `Plano ${randomPlan}`;

    purchaseNotification.classList.add('show');

    setTimeout(() => {
        purchaseNotification.classList.remove('show');
    }, CONFIG.purchaseNotification.duration);

    setTimeout(showPurchaseNotification, getRandomInterval() + CONFIG.purchaseNotification.duration);
}

setTimeout(showPurchaseNotification, getRandomInterval());

// ==========================================
// PLAN CARDS HOVER EFFECT (DESKTOP)
// ==========================================
if (window.innerWidth >= 768) {
    document.querySelectorAll('.plan-card').forEach(card => {
        card.addEventListener('mouseenter', function () {
            if (!this.classList.contains('featured')) {
                this.style.transform = 'translateY(-8px) scale(1.02)';
            }
        });
        card.addEventListener('mouseleave', function () {
            if (!this.classList.contains('featured')) {
                this.style.transform = '';
            }
        });
    });
}

// ==========================================
// BUTTON RIPPLE EFFECT
// ==========================================
// ✅ FIX #1 — Remoção do document.createElement('style') com @keyframes ripple.
// Criar um elemento <style> via JS exigia 'unsafe-inline' em style-src na CSP,
// o que abria vetor para CSS injection e bypass parcial de CSP.
//
// MIGRAÇÃO NECESSÁRIA — adicione o seguinte bloco ao final de planos.css:
//
//   /* --- Ripple Effect --- */
//   .btn-plan,
//   .btn-primary,
//   .btn-nav {
//       position: relative;
//       overflow: hidden;
//   }
//   .btn-ripple-effect {
//       position: absolute;
//       border-radius: 50%;
//       background: rgba(255, 255, 255, 0.3);
//       pointer-events: none;
//       animation: ripple 0.6s ease-out forwards;
//       transform: scale(0);
//   }
//   @keyframes ripple {
//       to {
//           transform: scale(2.5);
//           opacity: 0;
//       }
//   }
//   /* ---------------------- */
//
// Com este CSS no arquivo externo, o JS abaixo define apenas os valores dinâmicos
// (tamanho e posição do clique), que são propriedades de elemento — não <style>.
// Propriedades de elemento definidas por JS NÃO são cobertas por style-src,
// portanto 'unsafe-inline' pode ser removido da CSP com segurança.

document.querySelectorAll('.btn-plan, .btn-primary, .btn-nav').forEach(button => {
    button.addEventListener('click', function (e) {
        const ripple = document.createElement('span');
        const rect   = this.getBoundingClientRect();
        const size   = Math.max(rect.width, rect.height);
        const x      = e.clientX - rect.left - size / 2;
        const y      = e.clientY - rect.top  - size / 2;

        // Apenas valores dinâmicos (tamanho/posição) são definidos inline via JS.
        // A animação, border-radius e background vêm da classe CSS acima.
        ripple.className    = 'btn-ripple-effect';
        ripple.style.width  = `${size}px`;
        ripple.style.height = `${size}px`;
        ripple.style.left   = `${x}px`;
        ripple.style.top    = `${y}px`;

        this.appendChild(ripple);
        setTimeout(() => ripple.remove(), 600);
    });
});

// ==========================================
// FAQ ACCORDION
// ==========================================
document.querySelectorAll('.faq-item').forEach(item => {
    const question = item.querySelector('.faq-question');
    const answer   = item.querySelector('.faq-answer');
    const icon     = question?.querySelector('svg');

    if (!question || !answer) return;

    question.addEventListener('click', () => {
        const isActive = item.classList.contains('active');

        // Fechar todos os outros
        document.querySelectorAll('.faq-item').forEach(other => {
            if (other !== item) {
                other.classList.remove('active');
                const otherAnswer = other.querySelector('.faq-answer');
                const otherIcon   = other.querySelector('.faq-question svg');
                if (otherAnswer) otherAnswer.style.maxHeight = null;
                if (otherIcon)   otherIcon.style.transform   = 'rotate(0deg)';
            }
        });

        // Toggle o atual
        if (!isActive) {
            item.classList.add('active');
            answer.style.maxHeight = `${answer.scrollHeight}px`;
            if (icon) icon.style.transform = 'rotate(180deg)';
        } else {
            item.classList.remove('active');
            answer.style.maxHeight = null;
            if (icon) icon.style.transform = 'rotate(0deg)';
        }
    });
});

// ==========================================
// INTERSECTION OBSERVER — FADE IN
// ==========================================
const observerOptions = {
    threshold:  0.1,
    rootMargin: '0px 0px -50px 0px'
};

const fadeObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            entry.target.classList.add('visible');
            fadeObserver.unobserve(entry.target);
        }
    });
}, observerOptions);

document.querySelectorAll('.plan-card, .benefit-card, .faq-item').forEach((el, index) => {
    el.style.opacity         = '0';
    el.style.transform       = 'translateY(20px)';
    el.style.transition      = 'opacity 0.6s ease, transform 0.6s ease';
    el.style.transitionDelay = `${index * 0.1}s`;
    fadeObserver.observe(el);
});

// ==========================================
// TRACK INTERACTIONS
// ==========================================
// ✅ FIX EXTRA #6 — console.log removido de produção.
function trackEvent(category, action, label) {
    if (window.gtag) {
        window.gtag('event', action, {
            event_category: category,
            event_label:    label
        });
    }

    if (window.fbq) {
        window.fbq('track', action, { category, label });
    }
}

// Track cliques nos botões de plano
document.querySelectorAll('.btn-plan').forEach(btn => {
    btn.addEventListener('click', (e) => {
        const planCard = e.target.closest('.plan-card');
        const planName = planCard?.dataset.plan;
        if (planName) {
            trackEvent('Plan', 'click', planName);
        }
    });
});

// ==========================================
// PERFORMANCE MONITORING
// ==========================================
// ✅ FIX EXTRA #7 — PerformanceNavigationTiming (substitui window.performance.timing depreciado)
window.addEventListener('load', () => {
    if (!window.performance) return;

    const [navEntry] = performance.getEntriesByType('navigation');
    if (navEntry) {
        const pageLoadTime = Math.round(navEntry.duration);
        if (pageLoadTime > 3000) {
            console.warn(`[GranaEvo] Tempo de carregamento alto: ${pageLoadTime}ms`);
        }
    }
});

// ==========================================
// ONLINE / OFFLINE STATUS
// ==========================================
window.addEventListener('online',  () => {
    // Reconectar lógica aqui se necessário
});
window.addEventListener('offline', () => {
    // Notificar o usuário se necessário
});

// ==========================================
// SCROLL RESTORATION
// ==========================================
if ('scrollRestoration' in history) {
    history.scrollRestoration = 'manual';
}

// ==========================================
// ACCESSIBILITY
// ==========================================
if (mobileToggle) {
    mobileToggle.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            mobileToggle.click();
        }
    });
}

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && navLinks?.classList.contains('active')) {
        mobileToggle?.classList.remove('active');
        navLinks.classList.remove('active');
        document.body.style.overflow = '';
        mobileToggle?.setAttribute('aria-expanded', 'false');
    }
});

// ==========================================
// INITIALIZATION
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
    // ✅ FIX #2 — Bind dos botões de checkout sem onclick inline e sem global
    bindCheckoutButtons();

    // Animação inicial suave
    setTimeout(() => {
        document.body.style.opacity = '1';
    }, 100);
});

// ==========================================
// SERVICE WORKER (OPCIONAL)
// ==========================================
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        // Descomentar quando tiver service worker configurado
        // Atenção: implementar cache validation para evitar cache poisoning
        // navigator.serviceWorker.register('/sw.js')
        //     .then(reg => console.log('[GranaEvo] Service Worker registrado'))
        //     .catch(err => console.error('[GranaEvo] Service Worker erro:', err));
    });
}