// ==========================================
// GRANAEVO PLANOS — planos.js
// Versão Segura v5 | AbortController Carousel Fix
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

    // Domínios permitidos para redirecionamento (whitelist)
    allowedRedirectDomains: ['pay.cakto.com.br'],

    // Normalização de data-plan → chave canônica
    planNameMap: {
        'individual': 'Individual',
        'casal':      'Casal',
        'familia':    'Família'
    }
};

// ==========================================
// CHECKOUT — REDIRECIONAMENTO SEGURO
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
    const checkoutUrl = CHECKOUT_URLS[normalized];
    checkoutLock = true;
    setTimeout(() => { checkoutLock = false; }, 2000);
    trackEvent('Plan', 'checkout_click', normalized);
    safeRedirect(checkoutUrl);
}

function bindCheckoutButtons() {
    document.querySelectorAll('.btn-plan[data-plan]').forEach(btn => {
        // Remove listener anterior clonando apenas o botão (não o track inteiro)
        const newBtn = btn.cloneNode(true);
        btn.parentNode.replaceChild(newBtn, btn);
        newBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            iniciarCheckout(newBtn.dataset.plan);
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
// CAROUSEL DE PLANOS
// ==========================================
// FIX v5:
// - AbortController substitui o clone do track — resolve o bug crítico onde
//   planCardsArray apontava para nós desconectados do DOM após cloneNode(),
//   fazendo goToSlide() manipular elementos fantasma (opacity/transform sem efeito).
// - bindCheckoutButtons() clona apenas os <button>, não o track inteiro.
// - planCardsArray é sempre reatualizado no início de initCarousel().
// - Touch: passive:true no touchstart e touchend, passive:false no touchmove
//   (necessário para e.preventDefault() funcionar no scroll horizontal).

let currentSlide         = 1; // Começa no Casal (featured)
let isTransitioning      = false;
let planCardsArray       = [];
let totalSlides          = 0;
let carouselController   = null; // AbortController para cleanup de listeners

function initCarousel() {
    const track      = document.getElementById('plansTrack');
    const indicators = document.getElementById('carouselIndicators');
    const prevBtn    = document.getElementById('prevBtn');
    const nextBtn    = document.getElementById('nextBtn');

    if (!track || window.innerWidth >= 768) return;

    // FIX v5: sempre reatualiza o array após qualquer mudança de DOM
    planCardsArray = Array.from(document.querySelectorAll('.plan-card'));
    totalSlides    = planCardsArray.length;

    // FIX v5: cancela listeners anteriores sem clonar o DOM
    if (carouselController) carouselController.abort();
    carouselController = new AbortController();
    const { signal } = carouselController;

    // Build indicators via createElement (sem innerHTML — Trusted Types safe)
    if (indicators) {
        while (indicators.firstChild) indicators.removeChild(indicators.firstChild);
        for (let i = 0; i < totalSlides; i++) {
            const dot = document.createElement('button');
            dot.className = 'indicator-dot';
            dot.setAttribute('aria-label', `Ir para plano ${i + 1}`);
            dot.setAttribute('type', 'button');
            if (i === currentSlide) dot.classList.add('active');
            dot.addEventListener('click', () => goToSlide(i), { signal });
            indicators.appendChild(dot);
        }
    }

    // FIX v5: garante visibilidade — IntersectionObserver não detecta cards
    // deslocados por CSS transform, deixando-os invisíveis ao navegar
    planCardsArray.forEach(card => {
        card.style.opacity         = '1';
        card.style.transform       = 'none';
        card.style.transition      = '';
        card.style.transitionDelay = '0s';
    });

    // Posiciona no slide inicial sem animação
    goToSlide(currentSlide, false);

    // Botões de navegação
    if (prevBtn) {
        prevBtn.addEventListener('click', () => {
            if (isTransitioning) return;
            currentSlide = (currentSlide - 1 + totalSlides) % totalSlides;
            goToSlide(currentSlide);
        }, { signal });
    }

    if (nextBtn) {
        nextBtn.addEventListener('click', () => {
            if (isTransitioning) return;
            currentSlide = (currentSlide + 1) % totalSlides;
            goToSlide(currentSlide);
        }, { signal });
    }

    // Touch / Swipe — diretamente no track (sem clone)
    let touchStartX    = 0;
    let touchStartY    = 0;
    let touchStartTime = 0;

    track.addEventListener('touchstart', (e) => {
        touchStartX    = e.changedTouches[0].clientX;
        touchStartY    = e.changedTouches[0].clientY;
        touchStartTime = Date.now();
    }, { passive: true, signal });

    track.addEventListener('touchmove', (e) => {
        const deltaX = Math.abs(touchStartX - e.changedTouches[0].clientX);
        const deltaY = Math.abs(touchStartY - e.changedTouches[0].clientY);
        // Bloqueia scroll vertical apenas quando o movimento é predominantemente horizontal
        if (deltaX > deltaY && deltaX > 8) {
            e.preventDefault();
        }
    }, { passive: false, signal });

    track.addEventListener('touchend', (e) => {
        if (isTransitioning) return;
        const endX    = e.changedTouches[0].clientX;
        const endY    = e.changedTouches[0].clientY;
        const elapsed = Date.now() - touchStartTime;
        const deltaX  = touchStartX - endX;
        const deltaY  = touchStartY - endY;

        // Threshold dinâmico: swipes rápidos precisam percorrer menos distância
        const threshold = elapsed < 350 ? 24 : 44;

        if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > threshold) {
            currentSlide = deltaX > 0
                ? (currentSlide + 1) % totalSlides
                : (currentSlide - 1 + totalSlides) % totalSlides;
            goToSlide(currentSlide);
        }
    }, { passive: true, signal });

    // Navegação por teclado (mobile)
    document.addEventListener('keydown', (e) => {
        if (window.innerWidth >= 768 || isTransitioning) return;
        if (e.key === 'ArrowLeft') {
            currentSlide = (currentSlide - 1 + totalSlides) % totalSlides;
            goToSlide(currentSlide);
        } else if (e.key === 'ArrowRight') {
            currentSlide = (currentSlide + 1) % totalSlides;
            goToSlide(currentSlide);
        }
    }, { signal });
}

function goToSlide(index, animate = true) {
    const track      = document.getElementById('plansTrack');
    const indicators = document.querySelectorAll('.indicator-dot');

    if (!track || window.innerWidth >= 768) return;

    isTransitioning = true;
    currentSlide    = index;

    if (!animate) {
        track.style.transition = 'none';
        track.style.transform  = `translateX(${-index * 100}%)`;
        // Força reflow para "congelar" posição antes de restaurar a transição
        void track.offsetWidth;
        track.style.transition = '';
    } else {
        track.style.transform = `translateX(${-index * 100}%)`;
    }

    indicators.forEach((dot, i) => {
        dot.classList.toggle('active', i === index);
    });

    // FIX v5: usa planCardsArray que agora sempre aponta para nós vivos no DOM
    planCardsArray.forEach((card, i) => {
        card.classList.toggle('active-slide', i === index);
    });

    setTimeout(() => { isTransitioning = false; }, 500);
}

// Reinicializar no resize (debounced)
let resizeTimer;
window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
        const track = document.getElementById('plansTrack');
        if (window.innerWidth < 768) {
            initCarousel();
        } else {
            // Limpa estado do carousel no desktop
            if (carouselController) carouselController.abort();
            if (track) {
                track.style.transform  = '';
                track.style.transition = '';
            }
            // FIX v5: reatualiza array antes de manipular os cards
            planCardsArray = Array.from(document.querySelectorAll('.plan-card'));
            planCardsArray.forEach(card => {
                card.classList.remove('active-slide');
                card.style.opacity         = '';
                card.style.transform       = '';
                card.style.transition      = '';
                card.style.transitionDelay = '';
            });
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
            const headerHeight   = header.offsetHeight;
            const targetPosition = target.getBoundingClientRect().top + window.scrollY - headerHeight - 20;
            window.scrollTo({ top: targetPosition, behavior: 'smooth' });
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

    const particleCount = window.innerWidth < 768 ? 20 : 45;
    const particles     = [];

    class Particle {
        constructor() { this.reset(); }
        reset() {
            this.x       = Math.random() * canvas.width;
            this.y       = Math.random() * canvas.height;
            this.size    = Math.random() * 1.5 + 0.5;
            this.speedX  = (Math.random() - 0.5) * 0.4;
            this.speedY  = (Math.random() - 0.5) * 0.4;
            this.opacity = Math.random() * 0.4 + 0.1;
        }
        update() {
            this.x += this.speedX;
            this.y += this.speedY;
            if (this.x > canvas.width + 5)  this.x = -5;
            if (this.x < -5)                this.x = canvas.width + 5;
            if (this.y > canvas.height + 5) this.y = -5;
            if (this.y < -5)                this.y = canvas.height + 5;
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

    // textContent — sem risco de XSS
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
function initDesktopHover() {
    if (window.innerWidth < 768) return;
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
document.querySelectorAll('.btn-plan, .btn-primary, .btn-nav').forEach(button => {
    button.addEventListener('click', function (e) {
        this.querySelectorAll('.btn-ripple-effect').forEach(r => r.remove());
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
        setTimeout(() => ripple.remove(), 650);
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

        document.querySelectorAll('.faq-item').forEach(other => {
            if (other !== item) {
                other.classList.remove('active');
                const otherAnswer = other.querySelector('.faq-answer');
                const otherIcon   = other.querySelector('.faq-question svg');
                if (otherAnswer) otherAnswer.style.maxHeight = null;
                if (otherIcon)   otherIcon.style.transform   = 'rotate(0deg)';
            }
        });

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

// FIX v5: plan-cards no mobile NÃO recebem opacity:0 do observer.
// Visibilidade é gerenciada exclusivamente pelo initCarousel().
document.querySelectorAll('.plan-card, .benefit-card, .faq-item').forEach((el, index) => {
    const isPlanCardMobile = el.classList.contains('plan-card') && window.innerWidth < 768;

    if (isPlanCardMobile) {
        el.style.opacity   = '1';
        el.style.transform = 'none';
        return;
    }

    el.style.opacity         = '0';
    el.style.transform       = 'translateY(20px)';
    el.style.transition      = 'opacity 0.6s ease, transform 0.6s ease';
    el.style.transitionDelay = `${index * 0.08}s`;
    fadeObserver.observe(el);
});

// ==========================================
// ANALYTICS
// ==========================================
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

document.querySelectorAll('.btn-plan').forEach(btn => {
    btn.addEventListener('click', (e) => {
        const planCard = e.target.closest('.plan-card');
        const planName = planCard?.dataset.plan;
        if (planName) trackEvent('Plan', 'click', planName);
    });
});

// ==========================================
// PERFORMANCE MONITORING
// ==========================================
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
    // Inicializa arrays com os nós reais do DOM
    planCardsArray = Array.from(document.querySelectorAll('.plan-card'));
    totalSlides    = planCardsArray.length;

    // Bind dos botões de checkout
    bindCheckoutButtons();

    // Inicia carousel no mobile
    if (window.innerWidth < 768) {
        initCarousel();
    } else {
        initDesktopHover();
    }

    setTimeout(() => {
        document.body.style.opacity = '1';
    }, 100);
});

// ==========================================
// SERVICE WORKER (OPCIONAL)
// ==========================================
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        // Descomentar quando sw.js estiver configurado
        // navigator.serviceWorker.register('/sw.js')
        //     .then(() => {})
        //     .catch(err => console.error('[GranaEvo] SW erro:', err));
    });
}