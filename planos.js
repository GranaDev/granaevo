// ==========================================
// GRANAEVO PLANOS — planos.js
// ==========================================
// SEGURANÇA:
// ✅ ZERO innerHTML/outerHTML/insertAdjacentHTML/document.write
//    Todo DOM via createElement + textContent + appendChild
//    Compatível com require-trusted-types-for 'script'
// ✅ Checkout com whitelist de domínios + debounce anti-flood
// ✅ Smooth scroll com validação de seletor CSS
// ==========================================

'use strict';

// ==========================================
// CONFIGURAÇÕES
// ==========================================
const CONFIG = Object.freeze({
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
});

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
        console.error('[GranaEvo] URL inválida bloqueada:', url);
        return;
    }
    if (!CONFIG.allowedRedirectDomains.includes(parsed.hostname)) {
        console.error('[GranaEvo] Domínio não autorizado:', parsed.hostname);
        return;
    }
    if (parsed.protocol !== 'https:') {
        console.error('[GranaEvo] Protocolo não é HTTPS:', parsed.protocol);
        return;
    }
    window.location.href = url;
}

function iniciarCheckout(rawPlanName) {
    if (checkoutLock) return;
    const normalized = CONFIG.planNameMap[rawPlanName?.toLowerCase()] ?? rawPlanName;
    if (!Object.prototype.hasOwnProperty.call(CHECKOUT_URLS, normalized)) {
        console.error('[GranaEvo] Plano desconhecido:', rawPlanName);
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
    const el = document.getElementById('loadingScreen');
    if (el) setTimeout(() => el.classList.add('hidden'), 1200);
});

// ==========================================
// SCROLL PROGRESS
// ==========================================
const scrollProgressEl = document.getElementById('scrollProgress');
window.addEventListener('scroll', () => {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    if (scrollProgressEl && max > 0) {
        scrollProgressEl.style.width = `${Math.min((window.scrollY / max) * 100, 100)}%`;
    }
}, { passive: true });

// ==========================================
// HEADER SCROLL
// ==========================================
const header = document.getElementById('header');
window.addEventListener('scroll', () => {
    if (header) header.classList.toggle('scrolled', window.scrollY > 100);
}, { passive: true });

// ==========================================
// MOBILE MENU
// ==========================================
const mobileToggle = document.getElementById('mobileToggle');
const navLinks     = document.getElementById('navLinks');

function closeMobileMenu() {
    mobileToggle?.classList.remove('active');
    navLinks?.classList.remove('active');
    document.body.style.overflow = '';
    mobileToggle?.setAttribute('aria-expanded', 'false');
}

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
        if (!navLinks.contains(e.target) && !mobileToggle.contains(e.target)) {
            closeMobileMenu();
        }
    });
}

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && navLinks?.classList.contains('active')) closeMobileMenu();
});

// ==========================================
// CAROUSEL MOBILE
// ==========================================
// ✅ ZERO innerHTML — todos os nós criados via createElement
// ✅ Swipe: detecta horizontal vs vertical antes de agir
// ✅ Botões prev/next funcionais
// ✅ overflow:hidden e larguras aplicados via JS
// ==========================================

const planCards    = Array.from(document.querySelectorAll('.plan-card'));
const totalSlides  = planCards.length;
let currentSlide   = 1;   // inicia no Casal (featured)
let transitioning  = false;
let eventsAttached = false;
let swipeStartX    = 0;
let swipeStartY    = 0;

function updateDots(index) {
    document.querySelectorAll('.indicator-dot').forEach((dot, i) => {
        const active = i === index;
        dot.classList.toggle('active', active);
        dot.setAttribute('aria-selected', String(active));
    });
}

function goToSlide(index, animated) {
    if (animated === undefined) animated = true;

    const track    = document.getElementById('plansTrack');
    const carousel = document.getElementById('plansCarousel');
    if (!track || !carousel) return;

    transitioning = true;
    currentSlide  = ((index % totalSlides) + totalSlides) % totalSlides;

    const offset = currentSlide * carousel.offsetWidth;

    if (!animated) {
        track.style.transition = 'none';
        void track.offsetHeight;
    }

    track.style.transform = `translateX(-${offset}px)`;

    if (!animated) {
        requestAnimationFrame(() => requestAnimationFrame(() => {
            track.style.transition = '';
        }));
    }

    updateDots(currentSlide);
    setTimeout(() => { transitioning = false; }, 450);
}

function buildIndicators() {
    const container = document.getElementById('carouselIndicators');
    if (!container) return;

    // ✅ Limpar sem innerHTML
    while (container.firstChild) container.removeChild(container.firstChild);

    for (let i = 0; i < totalSlides; i++) {
        const dot = document.createElement('button');
        dot.type      = 'button';
        dot.className = 'indicator-dot' + (i === currentSlide ? ' active' : '');
        dot.setAttribute('aria-label',    `Plano ${i + 1} de ${totalSlides}`);
        dot.setAttribute('aria-selected', String(i === currentSlide));
        dot.setAttribute('role',          'tab');
        dot.addEventListener('click', () => {
            if (!transitioning) goToSlide(i);
        });
        container.appendChild(dot);
    }
}

function setupCarousel() {
    const track    = document.getElementById('plansTrack');
    const carousel = document.getElementById('plansCarousel');
    if (!track || !carousel) return;

    // Aplicar overflow e remover gap via JS (sem tocar no CSS file)
    carousel.style.overflow = 'hidden';
    track.style.gap         = '0';
    track.style.transition  = 'transform 0.45s cubic-bezier(0.4, 0, 0.2, 1)';

    // Forçar cada card a ter a largura exata do container
    const cardWidth = carousel.offsetWidth;
    planCards.forEach(card => {
        card.style.minWidth = `${cardWidth}px`;
        card.style.maxWidth = `${cardWidth}px`;
        card.style.width    = `${cardWidth}px`;
    });

    buildIndicators();
    goToSlide(currentSlide, false);

    if (eventsAttached) return;
    eventsAttached = true;

    // Prev / Next
    const prevBtn = document.getElementById('prevBtn');
    const nextBtn = document.getElementById('nextBtn');

    if (prevBtn) {
        prevBtn.addEventListener('click', () => {
            if (!transitioning) goToSlide(currentSlide - 1);
        });
    }
    if (nextBtn) {
        nextBtn.addEventListener('click', () => {
            if (!transitioning) goToSlide(currentSlide + 1);
        });
    }

    // Touch / Swipe
    track.addEventListener('touchstart', (e) => {
        swipeStartX = e.changedTouches[0].clientX;
        swipeStartY = e.changedTouches[0].clientY;
    }, { passive: true });

    track.addEventListener('touchmove', (e) => {
        const dx = Math.abs(e.changedTouches[0].clientX - swipeStartX);
        const dy = Math.abs(e.changedTouches[0].clientY - swipeStartY);
        if (dx > dy && dx > 8) e.preventDefault();
    }, { passive: false });

    track.addEventListener('touchend', (e) => {
        const dx = swipeStartX - e.changedTouches[0].clientX;
        const dy = swipeStartY - e.changedTouches[0].clientY;
        if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 40 && !transitioning) {
            goToSlide(dx > 0 ? currentSlide + 1 : currentSlide - 1);
        }
    }, { passive: true });

    // Teclado
    document.addEventListener('keydown', (e) => {
        if (window.innerWidth >= 768 || transitioning) return;
        if (e.key === 'ArrowLeft')  goToSlide(currentSlide - 1);
        if (e.key === 'ArrowRight') goToSlide(currentSlide + 1);
    });
}

function teardownCarousel() {
    const track    = document.getElementById('plansTrack');
    const carousel = document.getElementById('plansCarousel');
    if (carousel) carousel.style.overflow = '';
    if (track) {
        track.style.transform  = 'translateX(0)';
        track.style.gap        = '';
        track.style.transition = '';
    }
    planCards.forEach(card => {
        card.style.minWidth = '';
        card.style.maxWidth = '';
        card.style.width    = '';
    });
}

// Inicializar
document.addEventListener('DOMContentLoaded', () => {
    if (window.innerWidth < 768) setupCarousel();
    bindCheckoutButtons();
});

let resizeDebounce;
window.addEventListener('resize', () => {
    clearTimeout(resizeDebounce);
    resizeDebounce = setTimeout(() => {
        if (window.innerWidth < 768) {
            eventsAttached = false; // permite re-bind no resize
            setupCarousel();
        } else {
            teardownCarousel();
        }
    }, 250);
}, { passive: true });

// ==========================================
// SMOOTH SCROLL
// ==========================================
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
        const href = this.getAttribute('href');
        if (!href || !/^#[a-zA-Z0-9_-]+$/.test(href)) return;
        e.preventDefault();
        const target = document.querySelector(href);
        if (target) {
            window.scrollTo({
                top:      target.offsetTop - (header?.offsetHeight ?? 0) - 20,
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

    const count     = window.innerWidth < 768 ? 30 : 50;
    const particles = Array.from({ length: count }, () => ({
        x:       Math.random() * canvas.width,
        y:       Math.random() * canvas.height,
        size:    Math.random() * 2 + 1,
        speedX:  Math.random() * 0.5 - 0.25,
        speedY:  Math.random() * 0.5 - 0.25,
        opacity: Math.random() * 0.5 + 0.2
    }));

    (function animateParticles() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        particles.forEach(p => {
            p.x += p.speedX;
            p.y += p.speedY;
            if (p.x > canvas.width)  p.x = 0;
            if (p.x < 0)             p.x = canvas.width;
            if (p.y > canvas.height) p.y = 0;
            if (p.y < 0)             p.y = canvas.height;
            ctx.fillStyle = `rgba(16, 185, 129, ${p.opacity})`;
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
            ctx.fill();
        });
        requestAnimationFrame(animateParticles);
    })();
}

// ==========================================
// PURCHASE NOTIFICATIONS
// ==========================================
const notificationEl = document.getElementById('purchaseNotification');

function randomInterval() {
    return Math.floor(
        Math.random() * (CONFIG.purchaseNotification.maxInterval - CONFIG.purchaseNotification.minInterval)
        + CONFIG.purchaseNotification.minInterval
    );
}

function showNotification() {
    if (!notificationEl) return;

    const nameEl   = notificationEl.querySelector('.notification-name');
    const actionEl = notificationEl.querySelector('.notification-action strong');

    // ✅ textContent — sem innerHTML
    if (nameEl)   nameEl.textContent   = CONFIG.names[Math.floor(Math.random() * CONFIG.names.length)];
    if (actionEl) actionEl.textContent = `Plano ${CONFIG.plans[Math.floor(Math.random() * CONFIG.plans.length)]}`;

    notificationEl.classList.add('show');
    setTimeout(() => {
        notificationEl.classList.remove('show');
        setTimeout(showNotification, randomInterval());
    }, CONFIG.purchaseNotification.duration);
}

setTimeout(showNotification, randomInterval());

// ==========================================
// HOVER CARDS (DESKTOP)
// ==========================================
if (window.innerWidth >= 768) {
    planCards.forEach(card => {
        if (card.classList.contains('featured')) return;
        card.addEventListener('mouseenter', () => { card.style.transform = 'translateY(-8px) scale(1.02)'; });
        card.addEventListener('mouseleave', () => { card.style.transform = ''; });
    });
}

// ==========================================
// BUTTON RIPPLE EFFECT
// ==========================================
// ✅ Apenas posição/tamanho inline — animação está em planos.css
document.querySelectorAll('.btn-plan, .btn-primary, .btn-nav').forEach(btn => {
    btn.addEventListener('click', function (e) {
        const rect   = this.getBoundingClientRect();
        const size   = Math.max(rect.width, rect.height);
        const ripple = document.createElement('span');
        ripple.className    = 'btn-ripple-effect';
        ripple.style.width  = `${size}px`;
        ripple.style.height = `${size}px`;
        ripple.style.left   = `${e.clientX - rect.left - size / 2}px`;
        ripple.style.top    = `${e.clientY - rect.top  - size / 2}px`;
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
        const isOpen = item.classList.contains('active');

        document.querySelectorAll('.faq-item').forEach(other => {
            other.classList.remove('active');
            const a = other.querySelector('.faq-answer');
            const i = other.querySelector('.faq-question svg');
            const q = other.querySelector('.faq-question');
            if (a) a.style.maxHeight = null;
            if (i) i.style.transform = '';
            if (q) q.setAttribute('aria-expanded', 'false');
        });

        if (!isOpen) {
            item.classList.add('active');
            answer.style.maxHeight = `${answer.scrollHeight}px`;
            if (icon) icon.style.transform = 'rotate(180deg)';
            question.setAttribute('aria-expanded', 'true');
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

document.querySelectorAll('.plan-card, .benefit-card, .faq-item').forEach((el, i) => {
    el.style.opacity    = '0';
    el.style.transform  = 'translateY(20px)';
    el.style.transition = `opacity 0.6s ease ${i * 0.1}s, transform 0.6s ease ${i * 0.1}s`;
    fadeObserver.observe(el);
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
        const plan = e.currentTarget.closest('.plan-card')?.dataset.plan;
        if (plan) trackEvent('Plan', 'click', plan);
    });
});

// ==========================================
// PERFORMANCE
// ==========================================
window.addEventListener('load', () => {
    const [nav] = performance?.getEntriesByType?.('navigation') ?? [];
    if (nav?.duration > 3000) console.warn(`[GranaEvo] Carregamento alto: ${Math.round(nav.duration)}ms`);
});

// ==========================================
// SCROLL RESTORATION
// ==========================================
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';