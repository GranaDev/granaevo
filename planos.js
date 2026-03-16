// ==========================================
// GRANAEVO PLANOS — planos.js
// ==========================================
// FIXES APLICADOS:
// ✅ indicators.innerHTML = '' substituído por removeChild loop
//    (innerHTML é um TrustedHTML sink — bloqueado pelo require-trusted-types-for)
// ✅ Carousel mobile completamente reescrito e funcional
// ✅ trusted-types removido do meta CSP — fix em planos.html
// ✅ frame-ancestors removido do meta CSP — fix em planos.html
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
        'Maria Silva',       'João Santos',       'Ana Costa',         'Carlos Pereira',
        'Patricia Oliveira', 'Roberto Lima',      'Juliana Martins',   'Fernando Souza',
        'Camila Rocha',      'Ricardo Alves',     'Beatriz Fernandes', 'Thiago Mendes',
        'Lucas Ribeiro',     'Amanda Costa',      'Rafael Santos',     'Larissa Oliveira'
    ],
    plans: ['Individual', 'Casal', 'Família'],
    allowedRedirectDomains: ['pay.cakto.com.br'],
    planNameMap: {
        'individual': 'Individual',
        'casal':      'Casal',
        'familia':    'Família'
    }
};

// ==========================================
// CHECKOUT
// ==========================================
const CHECKOUT_URLS = Object.freeze({
    'Individual': 'https://pay.cakto.com.br/figw38w_731973',
    'Casal':      'https://pay.cakto.com.br/rmq8b33_731974',
    'Família':    'https://pay.cakto.com.br/4x7ii5i_731976'
});

let checkoutLock = false;

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

function iniciarCheckout(rawPlanName) {
    if (checkoutLock) {
        console.warn('[GranaEvo] Checkout bloqueado — aguarde antes de tentar novamente.');
        return;
    }
    const normalized = CONFIG.planNameMap[rawPlanName?.toLowerCase()] ?? rawPlanName;
    if (!Object.prototype.hasOwnProperty.call(CHECKOUT_URLS, normalized)) {
        console.error('[GranaEvo] Plano desconhecido bloqueado:', rawPlanName);
        return;
    }
    checkoutLock = true;
    setTimeout(() => { checkoutLock = false; }, 2000);
    trackEvent('Plan', 'checkout_click', normalized);
    safeRedirect(CHECKOUT_URLS[normalized]);
}

function bindCheckoutButtons() {
    document.querySelectorAll('.btn-plan[data-plan]').forEach(btn => {
        btn.addEventListener('click', () => iniciarCheckout(btn.dataset.plan));
    });
}

// ==========================================
// LOADING SCREEN
// ==========================================
window.addEventListener('load', () => {
    const loadingScreen = document.getElementById('loadingScreen');
    if (loadingScreen) {
        setTimeout(() => loadingScreen.classList.add('hidden'), 1200);
    }
});

// ==========================================
// SCROLL PROGRESS BAR
// ==========================================
const scrollProgress = document.getElementById('scrollProgress');

function updateScrollProgress() {
    const documentHeight = document.documentElement.scrollHeight - window.innerHeight;
    const progress       = documentHeight > 0 ? (window.scrollY / documentHeight) * 100 : 0;
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
    header.classList.toggle('scrolled', window.scrollY > 100);
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

    navLinks.querySelectorAll('a').forEach(link => {
        link.addEventListener('click', () => {
            mobileToggle.classList.remove('active');
            navLinks.classList.remove('active');
            document.body.style.overflow = '';
            mobileToggle.setAttribute('aria-expanded', 'false');
        });
    });

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
// CAROUSEL DE PLANOS — REESCRITO
// ✅ FIX: indicators.innerHTML = '' removido
//    Substituído por loop removeChild — sem TrustedHTML sink
// ✅ FIX: Swipe e botões agora funcionam corretamente no mobile
// ==========================================
let currentSlide    = 1; // Começa no Casal (featured)
let isTransitioning = false;
let carouselInited  = false;

const planCardsArray = Array.from(document.querySelectorAll('.plan-card'));
const totalSlides    = planCardsArray.length;

function clearIndicators(container) {
    // ✅ Sem innerHTML — usa removeChild para evitar TrustedHTML sink
    while (container.firstChild) {
        container.removeChild(container.firstChild);
    }
}

function createIndicatorDot(index) {
    const dot = document.createElement('button');
    dot.className = 'indicator-dot';
    dot.type      = 'button';
    dot.setAttribute('aria-label', `Plano ${index + 1} de ${totalSlides}`);
    dot.setAttribute('role', 'tab');
    if (index === currentSlide) {
        dot.classList.add('active');
        dot.setAttribute('aria-selected', 'true');
    } else {
        dot.setAttribute('aria-selected', 'false');
    }
    dot.addEventListener('click', () => goToSlide(index));
    return dot;
}

function goToSlide(index, animate = true) {
    const track      = document.getElementById('plansTrack');
    const indicators = document.getElementById('carouselIndicators');

    if (!track) return;

    isTransitioning = true;
    currentSlide    = index;

    if (!animate) {
        track.style.transition = 'none';
        // Forçar reflow antes de restaurar transition
        void track.offsetHeight;
    }

    track.style.transform = `translateX(${-index * 100}%)`;

    if (!animate) {
        setTimeout(() => { track.style.transition = ''; }, 50);
    }

    // Atualizar indicadores
    if (indicators) {
        indicators.querySelectorAll('.indicator-dot').forEach((dot, i) => {
            const isActive = i === index;
            dot.classList.toggle('active', isActive);
            dot.setAttribute('aria-selected', String(isActive));
        });
    }

    setTimeout(() => { isTransitioning = false; }, 500);
}

function initCarousel() {
    const track      = document.getElementById('plansTrack');
    const indicators = document.getElementById('carouselIndicators');
    const prevBtn    = document.getElementById('prevBtn');
    const nextBtn    = document.getElementById('nextBtn');

    if (!track) return;

    // Somente mobile
    if (window.innerWidth >= 768) {
        track.style.transform = 'translateX(0)';
        return;
    }

    // ✅ Limpar indicadores sem innerHTML
    if (indicators) {
        clearIndicators(indicators);
        for (let i = 0; i < totalSlides; i++) {
            indicators.appendChild(createIndicatorDot(i));
        }
    }

    // Ir para slide inicial sem animação
    goToSlide(currentSlide, false);

    // Evitar re-bind de eventos duplicados
    if (carouselInited) return;
    carouselInited = true;

    // Botões prev/next
    if (prevBtn) {
        prevBtn.addEventListener('click', () => {
            if (isTransitioning) return;
            goToSlide((currentSlide - 1 + totalSlides) % totalSlides);
        });
    }

    if (nextBtn) {
        nextBtn.addEventListener('click', () => {
            if (isTransitioning) return;
            goToSlide((currentSlide + 1) % totalSlides);
        });
    }

    // Touch / Swipe
    let touchStartX = 0;
    let touchStartY = 0;
    let isSwiping   = false;

    track.addEventListener('touchstart', (e) => {
        touchStartX = e.changedTouches[0].clientX;
        touchStartY = e.changedTouches[0].clientY;
        isSwiping   = true;
    }, { passive: true });

    track.addEventListener('touchmove', (e) => {
        if (!isSwiping) return;
        const deltaX = Math.abs(e.changedTouches[0].clientX - touchStartX);
        const deltaY = Math.abs(e.changedTouches[0].clientY - touchStartY);
        // Só previne scroll vertical se for claramente um swipe horizontal
        if (deltaX > deltaY && deltaX > 10) {
            e.preventDefault();
        }
    }, { passive: false });

    track.addEventListener('touchend', (e) => {
        if (!isSwiping) return;
        isSwiping = false;

        const deltaX = touchStartX - e.changedTouches[0].clientX;
        const deltaY = touchStartY - e.changedTouches[0].clientY;

        // Só faz swipe se movimento horizontal for dominante e > 50px
        if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > 50) {
            if (isTransitioning) return;
            if (deltaX > 0) {
                goToSlide((currentSlide + 1) % totalSlides);
            } else {
                goToSlide((currentSlide - 1 + totalSlides) % totalSlides);
            }
        }
    }, { passive: true });

    // Teclado
    document.addEventListener('keydown', (e) => {
        if (window.innerWidth >= 768 || isTransitioning) return;
        if (e.key === 'ArrowLeft')  goToSlide((currentSlide - 1 + totalSlides) % totalSlides);
        if (e.key === 'ArrowRight') goToSlide((currentSlide + 1) % totalSlides);
    });
}

// Inicializar
document.addEventListener('DOMContentLoaded', () => {
    initCarousel();
});

// Reinicializar no resize
let resizeTimer;
window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
        const track = document.getElementById('plansTrack');
        if (window.innerWidth >= 768) {
            if (track) track.style.transform = 'translateX(0)';
        } else {
            initCarousel();
        }
    }, 250);
});

// ==========================================
// SMOOTH SCROLL
// ==========================================
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
        const href = this.getAttribute('href');
        if (!href || !/^#[a-zA-Z0-9_-]+$/.test(href)) return;
        e.preventDefault();
        const target = document.querySelector(href);
        if (target && header) {
            window.scrollTo({
                top:      target.offsetTop - header.offsetHeight - 20,
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
    window.addEventListener('resize', resizeCanvas, { passive: true });

    const particleCount = window.innerWidth < 768 ? 30 : 50;
    const particles     = [];

    class Particle {
        constructor() {
            this.reset();
        }
        reset() {
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

    for (let i = 0; i < particleCount; i++) particles.push(new Particle());

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

function showPurchaseNotification() {
    if (!purchaseNotification) return;

    const randomName = CONFIG.names[Math.floor(Math.random() * CONFIG.names.length)];
    const randomPlan = CONFIG.plans[Math.floor(Math.random() * CONFIG.plans.length)];

    const nameEl   = purchaseNotification.querySelector('.notification-name');
    const actionEl = purchaseNotification.querySelector('.notification-action strong');

    // ✅ textContent — sem risco de XSS, sem TrustedHTML sink
    if (nameEl)   nameEl.textContent   = randomName;
    if (actionEl) actionEl.textContent = `Plano ${randomPlan}`;

    purchaseNotification.classList.add('show');

    setTimeout(() => {
        purchaseNotification.classList.remove('show');
        const next = Math.floor(Math.random() * (CONFIG.purchaseNotification.maxInterval - CONFIG.purchaseNotification.minInterval) + CONFIG.purchaseNotification.minInterval);
        setTimeout(showPurchaseNotification, next);
    }, CONFIG.purchaseNotification.duration);
}

setTimeout(() => {
    showPurchaseNotification();
}, Math.floor(Math.random() * (CONFIG.purchaseNotification.maxInterval - CONFIG.purchaseNotification.minInterval) + CONFIG.purchaseNotification.minInterval));

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
// ✅ Apenas valores dinâmicos (posição/tamanho) são definidos inline.
//    A animação e estilos estáticos estão em planos.css (.btn-ripple-effect).
document.querySelectorAll('.btn-plan, .btn-primary, .btn-nav').forEach(button => {
    button.addEventListener('click', function (e) {
        const ripple = document.createElement('span');
        const rect   = this.getBoundingClientRect();
        const size   = Math.max(rect.width, rect.height);
        const x      = e.clientX - rect.left - size / 2;
        const y      = e.clientY - rect.top  - size / 2;

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
                if (otherIcon)   otherIcon.style.transform   = '';
                other.querySelector('.faq-question')?.setAttribute('aria-expanded', 'false');
            }
        });

        if (!isActive) {
            item.classList.add('active');
            answer.style.maxHeight = `${answer.scrollHeight}px`;
            if (icon) icon.style.transform = 'rotate(180deg)';
            question.setAttribute('aria-expanded', 'true');
        } else {
            item.classList.remove('active');
            answer.style.maxHeight = null;
            if (icon) icon.style.transform = '';
            question.setAttribute('aria-expanded', 'false');
        }
    });
});

// ==========================================
// INTERSECTION OBSERVER — FADE IN
// ==========================================
const fadeObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            entry.target.classList.add('visible');
            fadeObserver.unobserve(entry.target);
        }
    });
}, { threshold: 0.1, rootMargin: '0px 0px -50px 0px' });

document.querySelectorAll('.plan-card, .benefit-card, .faq-item').forEach((el, index) => {
    el.style.opacity         = '0';
    el.style.transform       = 'translateY(20px)';
    el.style.transition      = `opacity 0.6s ease ${index * 0.1}s, transform 0.6s ease ${index * 0.1}s`;
    fadeObserver.observe(el);
});

// ==========================================
// TRACK INTERACTIONS
// ==========================================
function trackEvent(category, action, label) {
    if (window.gtag) {
        window.gtag('event', action, { event_category: category, event_label: label });
    }
    if (window.fbq) {
        window.fbq('track', action, { category, label });
    }
}

document.querySelectorAll('.btn-plan').forEach(btn => {
    btn.addEventListener('click', (e) => {
        const planName = e.currentTarget.closest('.plan-card')?.dataset.plan;
        if (planName) trackEvent('Plan', 'click', planName);
    });
});

// ==========================================
// PERFORMANCE MONITORING
// ==========================================
window.addEventListener('load', () => {
    if (!window.performance) return;
    const [navEntry] = performance.getEntriesByType('navigation');
    if (navEntry && navEntry.duration > 3000) {
        console.warn(`[GranaEvo] Tempo de carregamento alto: ${Math.round(navEntry.duration)}ms`);
    }
});

// ==========================================
// SCROLL RESTORATION
// ==========================================
if ('scrollRestoration' in history) {
    history.scrollRestoration = 'manual';
}

// ==========================================
// ACCESSIBILITY — KEYBOARD NAV
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
    bindCheckoutButtons();
});