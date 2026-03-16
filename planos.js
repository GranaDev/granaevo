// ==========================================
// GRANAEVO PLANOS — planos.js  v5
// ==========================================

// ==========================================
// CONFIGURAÇÕES
// ==========================================
const CONFIG = {
    purchaseNotification: {
        minInterval: 15000,
        maxInterval: 90000,
        duration: 5000
    },
    names: [
        'Maria Silva', 'João Santos', 'Ana Costa', 'Carlos Pereira',
        'Patricia Oliveira', 'Roberto Lima', 'Juliana Martins', 'Fernando Souza',
        'Camila Rocha', 'Ricardo Alves', 'Beatriz Fernandes', 'Thiago Mendes',
        'Lucas Ribeiro', 'Amanda Costa', 'Rafael Santos', 'Larissa Oliveira'
    ],
    plans: ['Individual', 'Casal', 'Família'],
    allowedRedirectDomains: ['pay.cakto.com.br'],
    planNameMap: {
        'individual': 'Individual',
        'casal': 'Casal',
        'familia': 'Família'
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
    try { parsed = new URL(url); } catch {
        console.error('[GranaEvo] URL inválida:', url); return;
    }
    if (!CONFIG.allowedRedirectDomains.includes(parsed.hostname)) {
        console.error('[GranaEvo] Domínio bloqueado:', parsed.hostname); return;
    }
    if (parsed.protocol !== 'https:') {
        console.error('[GranaEvo] Protocolo bloqueado:', parsed.protocol); return;
    }
    window.location.href = url;
}

function iniciarCheckout(rawPlanName) {
    if (checkoutLock) return;
    const normalized = CONFIG.planNameMap[rawPlanName?.toLowerCase()] ?? rawPlanName;
    if (!Object.prototype.hasOwnProperty.call(CHECKOUT_URLS, normalized)) {
        console.error('[GranaEvo] Plano desconhecido:', rawPlanName); return;
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
    const el = document.getElementById('loadingScreen');
    if (el) setTimeout(() => el.classList.add('hidden'), 1200);
});

// ==========================================
// SCROLL PROGRESS BAR
// ==========================================
const scrollProgress = document.getElementById('scrollProgress');

function updateScrollProgress() {
    if (!scrollProgress) return;
    const total = document.documentElement.scrollHeight - window.innerHeight;
    scrollProgress.style.width = total > 0
        ? `${Math.min((window.scrollY / total) * 100, 100)}%`
        : '0%';
}

window.addEventListener('scroll', updateScrollProgress, { passive: true });

// ==========================================
// HEADER SCROLL
// ==========================================
const header = document.getElementById('header');

window.addEventListener('scroll', () => {
    if (!header) return;
    header.classList.toggle('scrolled', window.scrollY > 100);
}, { passive: true });

// ==========================================
// MOBILE MENU
// ==========================================
const mobileToggle = document.getElementById('mobileToggle');
const navLinks = document.getElementById('navLinks');

if (mobileToggle && navLinks) {
    mobileToggle.addEventListener('click', () => {
        const isActive = mobileToggle.classList.toggle('active');
        navLinks.classList.toggle('active');
        document.body.style.overflow = isActive ? 'hidden' : '';
        mobileToggle.setAttribute('aria-expanded', String(isActive));
    });

    navLinks.querySelectorAll('a').forEach(link => {
        link.addEventListener('click', closeMobileMenu);
    });

    document.addEventListener('click', (e) => {
        if (navLinks.classList.contains('active') &&
            !navLinks.contains(e.target) &&
            !mobileToggle.contains(e.target)) {
            closeMobileMenu();
        }
    });
}

function closeMobileMenu() {
    mobileToggle?.classList.remove('active');
    navLinks?.classList.remove('active');
    document.body.style.overflow = '';
    mobileToggle?.setAttribute('aria-expanded', 'false');
}

// ==========================================
// CAROUSEL
//
// Arquitectura v5 — 3 princípios:
//
// 1. ZERO innerHTML / cloneNode — Trusted Types compliant.
//    Indicators criados via createElement + appendChild.
//
// 2. Event listeners adicionados UMA única vez via flag
//    `carouselInitialized`. Resize apenas reposiciona o slide,
//    não re-registra listeners (evita duplicatas).
//
// 3. Touch/swipe no #plansCarousel (wrapper com overflow:hidden),
//    NÃO no #plansTrack (que se move com translateX).
//    Tocar no track em movimento causa falsos touchstart/end.
// ==========================================
let currentSlide      = 1;  // Casal (featured) começa selecionado
let isTransitioning   = false;
let planCardsArray    = [];
let totalSlides       = 0;
let carouselReady     = false; // garante que listeners são adicionados 1x

function buildIndicators() {
    const indicators = document.getElementById('carouselIndicators');
    if (!indicators) return;

    // Remove filhos existentes SEM innerHTML (Trusted Types)
    while (indicators.firstChild) {
        indicators.removeChild(indicators.firstChild);
    }

    for (let i = 0; i < totalSlides; i++) {
        const dot = document.createElement('button');
        dot.type = 'button';
        dot.className = 'indicator-dot' + (i === currentSlide ? ' active' : '');
        dot.setAttribute('aria-label', `Ir para plano ${i + 1}`);
        dot.addEventListener('click', () => goToSlide(i));
        indicators.appendChild(dot);
    }
}

function goToSlide(index, animate = true) {
    const track = document.getElementById('plansTrack');
    if (!track || window.innerWidth >= 768) return;

    isTransitioning = true;
    currentSlide    = index;

    if (!animate) {
        // Desativa transição, posiciona, re-ativa transição após reflow
        track.style.transition = 'none';
        track.style.transform  = `translateX(${-index * 100}%)`;
        void track.offsetWidth;          // força reflow
        track.style.transition = '';
    } else {
        track.style.transform = `translateX(${-index * 100}%)`;
    }

    // Atualiza dots
    document.querySelectorAll('.indicator-dot').forEach((dot, i) => {
        dot.classList.toggle('active', i === index);
    });

    // Marca card ativo
    planCardsArray.forEach((card, i) => {
        card.classList.toggle('active-slide', i === index);
    });

    setTimeout(() => { isTransitioning = false; }, 500);
}

function initCarousel() {
    if (window.innerWidth >= 768) return;

    const track    = document.getElementById('plansTrack');
    const carousel = document.getElementById('plansCarousel');

    if (!track || !carousel) return;

    // Reconstrói indicators (pode ser chamado no resize)
    buildIndicators();

    // Garante que todos os cards estão visíveis
    // (IntersectionObserver pode ter colocado opacity:0 em cards fora da viewport)
    planCardsArray.forEach(card => {
        card.style.opacity         = '1';
        card.style.transform       = '';
        card.style.transition      = '';
        card.style.transitionDelay = '';
    });

    // Posiciona no slide inicial sem animação
    goToSlide(currentSlide, false);

    // ── Listeners: registrados apenas 1 vez ──────────────────────────
    if (carouselReady) return;
    carouselReady = true;

    // Botão prev
    const prevBtn = document.getElementById('prevBtn');
    if (prevBtn) {
        prevBtn.addEventListener('click', () => {
            if (isTransitioning || window.innerWidth >= 768) return;
            currentSlide = (currentSlide - 1 + totalSlides) % totalSlides;
            goToSlide(currentSlide);
        });
    }

    // Botão next
    const nextBtn = document.getElementById('nextBtn');
    if (nextBtn) {
        nextBtn.addEventListener('click', () => {
            if (isTransitioning || window.innerWidth >= 768) return;
            currentSlide = (currentSlide + 1) % totalSlides;
            goToSlide(currentSlide);
        });
    }

    // ── Touch/Swipe no CAROUSEL WRAPPER (não no track) ───────────────
    // Motivo: o track se move com translateX; registrar eventos nele
    // gera touchstart/end incorretos durante a animação.
    let tx = 0, ty = 0, dragging = false;

    carousel.addEventListener('touchstart', (e) => {
        tx       = e.changedTouches[0].clientX;
        ty       = e.changedTouches[0].clientY;
        dragging = true;
    }, { passive: true });

    carousel.addEventListener('touchmove', (e) => {
        if (!dragging) return;
        const dx = Math.abs(tx - e.changedTouches[0].clientX);
        const dy = Math.abs(ty - e.changedTouches[0].clientY);
        // Bloqueia scroll vertical apenas quando movimento é horizontal
        if (dx > dy && dx > 8) e.preventDefault();
    }, { passive: false });

    carousel.addEventListener('touchend', (e) => {
        if (!dragging) return;
        dragging = false;
        if (isTransitioning || window.innerWidth >= 768) return;

        const dx = tx - e.changedTouches[0].clientX;
        const dy = ty - e.changedTouches[0].clientY;

        if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 40) {
            currentSlide = dx > 0
                ? (currentSlide + 1) % totalSlides
                : (currentSlide - 1 + totalSlides) % totalSlides;
            goToSlide(currentSlide);
        }
    }, { passive: true });

    // Teclado
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

// Resize: apenas reposiciona, não re-registra listeners
let resizeTimer;
window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
        const track = document.getElementById('plansTrack');
        if (window.innerWidth >= 768) {
            // Desktop: remove transform inline
            if (track) {
                track.style.transform  = '';
                track.style.transition = '';
            }
            planCardsArray.forEach(card => {
                card.classList.remove('active-slide');
                card.style.opacity   = '';
                card.style.transform = '';
            });
        } else {
            // Mobile: reconstrói indicators e reposiciona
            buildIndicators();
            const t = document.getElementById('plansTrack');
            if (t) {
                t.style.transition = 'none';
                t.style.transform  = `translateX(${-currentSlide * 100}%)`;
                void t.offsetWidth;
                t.style.transition = '';
            }
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
            const top = target.getBoundingClientRect().top + window.scrollY - header.offsetHeight - 20;
            window.scrollTo({ top, behavior: 'smooth' });
        }
    });
});

// ==========================================
// PARTICLES CANVAS
// ==========================================
const canvas = document.getElementById('particlesCanvas');
if (canvas) {
    const ctx = canvas.getContext('2d');

    const resize = () => {
        canvas.width  = window.innerWidth;
        canvas.height = window.innerHeight;
    };
    resize();
    window.addEventListener('resize', resize, { passive: true });

    const count = window.innerWidth < 768 ? 25 : 50;
    const pts   = Array.from({ length: count }, () => ({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        r: Math.random() * 1.5 + 0.5,
        vx: (Math.random() - 0.5) * 0.35,
        vy: (Math.random() - 0.5) * 0.35,
        a: Math.random() * 0.35 + 0.1
    }));

    (function loop() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        pts.forEach(p => {
            p.x += p.vx; p.y += p.vy;
            if (p.x > canvas.width + 4)  p.x = -4;
            if (p.x < -4)                p.x = canvas.width + 4;
            if (p.y > canvas.height + 4) p.y = -4;
            if (p.y < -4)                p.y = canvas.height + 4;
            ctx.fillStyle = `rgba(16,185,129,${p.a})`;
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
            ctx.fill();
        });
        requestAnimationFrame(loop);
    })();
}

// ==========================================
// PURCHASE NOTIFICATIONS
// ==========================================
const purchaseNotification = document.getElementById('purchaseNotification');

function showPurchaseNotification() {
    if (!purchaseNotification) return;
    const name = CONFIG.names[Math.floor(Math.random() * CONFIG.names.length)];
    const plan = CONFIG.plans[Math.floor(Math.random() * CONFIG.plans.length)];

    const nameEl   = purchaseNotification.querySelector('.notification-name');
    const actionEl = purchaseNotification.querySelector('.notification-action strong');
    if (nameEl)   nameEl.textContent   = name;
    if (actionEl) actionEl.textContent = `Plano ${plan}`;

    purchaseNotification.classList.add('show');
    setTimeout(() => purchaseNotification.classList.remove('show'), CONFIG.purchaseNotification.duration);

    const next = Math.floor(Math.random() *
        (CONFIG.purchaseNotification.maxInterval - CONFIG.purchaseNotification.minInterval) +
        CONFIG.purchaseNotification.minInterval);
    setTimeout(showPurchaseNotification, next + CONFIG.purchaseNotification.duration);
}

setTimeout(showPurchaseNotification,
    Math.floor(Math.random() *
        (CONFIG.purchaseNotification.maxInterval - CONFIG.purchaseNotification.minInterval) +
        CONFIG.purchaseNotification.minInterval));

// ==========================================
// HOVER EFFECT — DESKTOP
// ==========================================
if (window.innerWidth >= 768) {
    document.querySelectorAll('.plan-card').forEach(card => {
        card.addEventListener('mouseenter', function () {
            if (!this.classList.contains('featured'))
                this.style.transform = 'translateY(-8px) scale(1.02)';
        });
        card.addEventListener('mouseleave', function () {
            if (!this.classList.contains('featured'))
                this.style.transform = '';
        });
    });
}

// ==========================================
// RIPPLE EFFECT
// ==========================================
document.querySelectorAll('.btn-plan, .btn-primary, .btn-nav').forEach(btn => {
    btn.addEventListener('click', function (e) {
        this.querySelectorAll('.btn-ripple-effect').forEach(r => r.remove());
        const rect   = this.getBoundingClientRect();
        const size   = Math.max(rect.width, rect.height);
        const ripple = document.createElement('span');
        ripple.className    = 'btn-ripple-effect';
        ripple.style.width  = `${size}px`;
        ripple.style.height = `${size}px`;
        ripple.style.left   = `${e.clientX - rect.left - size / 2}px`;
        ripple.style.top    = `${e.clientY - rect.top  - size / 2}px`;
        this.appendChild(ripple);
        setTimeout(() => ripple.remove(), 650);
    });
});

// ==========================================
// FAQ ACCORDION
// ==========================================
document.querySelectorAll('.faq-item').forEach(item => {
    const q    = item.querySelector('.faq-question');
    const ans  = item.querySelector('.faq-answer');
    const icon = q?.querySelector('svg');
    if (!q || !ans) return;

    q.addEventListener('click', () => {
        const wasActive = item.classList.contains('active');

        document.querySelectorAll('.faq-item.active').forEach(other => {
            other.classList.remove('active');
            const a = other.querySelector('.faq-answer');
            const i = other.querySelector('.faq-question svg');
            if (a) a.style.maxHeight = null;
            if (i) i.style.transform = '';
        });

        if (!wasActive) {
            item.classList.add('active');
            ans.style.maxHeight  = `${ans.scrollHeight}px`;
            if (icon) icon.style.transform = 'rotate(180deg)';
        }
    });
});

// ==========================================
// INTERSECTION OBSERVER — FADE IN
// ==========================================
const fadeObs = new IntersectionObserver((entries) => {
    entries.forEach(e => {
        if (e.isIntersecting) {
            e.target.classList.add('visible');
            fadeObs.unobserve(e.target);
        }
    });
}, { threshold: 0.1, rootMargin: '0px 0px -50px 0px' });

document.querySelectorAll('.plan-card, .benefit-card, .faq-item').forEach((el, i) => {
    // Nunca aplica fade nos plan-cards no mobile —
    // o IntersectionObserver não detecta elementos deslocados por
    // CSS transform, então cards 2 e 3 ficariam opacity:0 ao deslizar.
    if (el.classList.contains('plan-card') && window.innerWidth < 768) {
        el.style.opacity = '1';
        return;
    }
    el.style.opacity         = '0';
    el.style.transform       = 'translateY(20px)';
    el.style.transition      = 'opacity 0.6s ease, transform 0.6s ease';
    el.style.transitionDelay = `${i * 0.08}s`;
    fadeObs.observe(el);
});

// ==========================================
// ANALYTICS
// ==========================================
function trackEvent(category, action, label) {
    if (window.gtag) window.gtag('event', action, { event_category: category, event_label: label });
    if (window.fbq)  window.fbq('track', action, { category, label });
}

document.querySelectorAll('.btn-plan').forEach(btn => {
    btn.addEventListener('click', (e) => {
        const name = e.target.closest('.plan-card')?.dataset.plan;
        if (name) trackEvent('Plan', 'click', name);
    });
});

// ==========================================
// PERFORMANCE
// ==========================================
window.addEventListener('load', () => {
    const [nav] = performance?.getEntriesByType?.('navigation') ?? [];
    if (nav && Math.round(nav.duration) > 3000)
        console.warn(`[GranaEvo] Carregamento alto: ${Math.round(nav.duration)}ms`);
});

// ==========================================
// MISC
// ==========================================
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

if (mobileToggle) {
    mobileToggle.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); mobileToggle.click(); }
    });
}

document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeMobileMenu();
});

// ==========================================
// INIT — tudo dentro de DOMContentLoaded
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
    planCardsArray = Array.from(document.querySelectorAll('.plan-card'));
    totalSlides    = planCardsArray.length;

    bindCheckoutButtons();

    if (window.innerWidth < 768) initCarousel();

    setTimeout(() => { document.body.style.opacity = '1'; }, 100);
});