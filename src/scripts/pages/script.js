// ==========================================
// GRANAEVO LANDING PAGE — V6.0
// Seguro · Trusted Types · GSAP + ScrollTrigger
// ==========================================

'use strict';

import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

// ==========================================
// AMBIENTE
// ==========================================
const IS_DEV = (
    location.hostname === 'localhost' ||
    location.hostname === '127.0.0.1' ||
    location.hostname.endsWith('.local')
);

// ==========================================
// UTILITÁRIOS
// ==========================================
function sanitizeText(value) {
    if (typeof value !== 'string') return '';
    const node = document.createTextNode(value);
    return node.nodeValue ?? '';
}

function deepFreeze(obj) {
    if (obj === null || typeof obj !== 'object') return obj;
    Object.getOwnPropertyNames(obj).forEach(name => deepFreeze(obj[name]));
    return Object.freeze(obj);
}

// ==========================================
// DADOS — DEPOIMENTOS (imutável)
// ==========================================
const TESTIMONIALS = deepFreeze([
    { name: 'Ana Lima', role: 'Designer · São Paulo', stars: 5, text: 'Finalmente entendo para onde meu dinheiro vai. O GranaEvo transformou minha relação com as finanças.' },
    { name: 'Carlos Mendes', role: 'Dev · Belo Horizonte', stars: 5, text: 'Uso há 8 meses. A funcionalidade de cartões é simplesmente perfeita — nunca mais fatura surpresa.' },
    { name: 'Juliana Costa', role: 'Professora · Curitiba', stars: 5, text: 'Consegui juntar para a viagem dos sonhos em 10 meses usando as metas do GranaEvo. Incrível.' },
    { name: 'Pedro Alves', role: 'Empreendedor · RJ', stars: 5, text: 'Controlo as finanças do negócio e da família no mesmo app. Praticidade que não existia antes.' },
    { name: 'Marina Santos', role: 'Advogada · Brasília', stars: 5, text: 'O dashboard me deu a visão que eu precisava. Reduz meus gastos supérfluos em 30% no primeiro mês.' },
    { name: 'Lucas Ferreira', role: 'Engenheiro · Floripa', stars: 5, text: 'Interface linda, rápida e muito intuitiva. Melhor app de finanças que usei até hoje.' },
    { name: 'Beatriz Rocha', role: 'Enfermeira · Salvador', stars: 5, text: 'Usei vários apps de finanças e o GranaEvo é diferente. Simples, visual e muito completo.' },
    { name: 'Thiago Nunes', role: 'Contador · Porto Alegre', stars: 5, text: 'Recomendo para todos os meus clientes. A organização por categorias é excelente.' },
]);

function validateTestimonial(t) {
    return (
        t && typeof t === 'object' &&
        typeof t.name === 'string' && t.name.length > 0 && t.name.length <= 60 &&
        typeof t.role === 'string' && t.role.length > 0 &&
        typeof t.text === 'string' && t.text.length > 0 && t.text.length <= 300 &&
        typeof t.stars === 'number' && t.stars >= 1 && t.stars <= 5 && Number.isInteger(t.stars)
    );
}

// ==========================================
// LOADING SCREEN
// ==========================================
function initLoadingScreen() {
    const screen = document.getElementById('loadingScreen');
    if (!screen) return;

    const hide = () => {
        screen.classList.add('hidden');
    };

    if (document.readyState === 'complete') {
        setTimeout(hide, 400);
    } else {
        window.addEventListener('load', () => setTimeout(hide, 400), { once: true });
    }
}

// ==========================================
// SCROLL PROGRESS
// ==========================================
function initScrollProgress() {
    const bar = document.getElementById('scrollProgress');
    if (!bar) return;

    const update = () => {
        const scrolled = window.scrollY;
        const total = document.documentElement.scrollHeight - window.innerHeight;
        const pct = total > 0 ? Math.round((scrolled / total) * 100) : 0;
        bar.style.width = pct + '%';
        bar.setAttribute('aria-valuenow', pct);
    };

    window.addEventListener('scroll', update, { passive: true });
    update();
}

// ==========================================
// HEADER SCROLL
// ==========================================
function initHeader() {
    const header = document.getElementById('header');
    if (!header) return;

    const update = () => {
        if (window.scrollY > 40) {
            header.classList.add('scrolled');
        } else {
            header.classList.remove('scrolled');
        }
    };

    window.addEventListener('scroll', update, { passive: true });
    update();
}

// ==========================================
// MOBILE MENU
// ==========================================
function openMobileMenu(toggle, navLinks) {
    toggle.setAttribute('aria-expanded', 'true');
    navLinks.classList.add('open');
    document.body.style.overflow = 'hidden';
}

function closeMobileMenu(toggle, navLinks) {
    toggle.setAttribute('aria-expanded', 'false');
    navLinks.classList.remove('open');
    document.body.style.overflow = '';
}

function initMobileMenu() {
    const toggle = document.getElementById('mobileToggle');
    const navLinks = document.getElementById('navLinks');
    if (!toggle || !navLinks) return;

    toggle.addEventListener('click', () => {
        const expanded = toggle.getAttribute('aria-expanded') === 'true';
        if (expanded) {
            closeMobileMenu(toggle, navLinks);
        } else {
            openMobileMenu(toggle, navLinks);
        }
    });

    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') closeMobileMenu(toggle, navLinks);
    });

    navLinks.querySelectorAll('a').forEach(link => {
        link.addEventListener('click', () => closeMobileMenu(toggle, navLinks));
    });

    window.addEventListener('resize', () => {
        if (window.innerWidth >= 900) closeMobileMenu(toggle, navLinks);
    }, { passive: true });
}

// ==========================================
// PARTÍCULAS (Canvas 2D)
// ==========================================
function initParticles() {
    const canvas = document.getElementById('particlesCanvas');
    if (!canvas || !canvas.getContext) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let W = 0, H = 0;
    const particles = [];
    const COUNT = window.innerWidth < 600 ? 40 : 70;
    let animId = null;

    function resize() {
        W = canvas.width = window.innerWidth;
        H = canvas.height = window.innerHeight;
    }

    function createParticle() {
        return {
            x: Math.random() * W,
            y: Math.random() * H,
            r: Math.random() * 1.5 + 0.3,
            vx: (Math.random() - 0.5) * 0.25,
            vy: (Math.random() - 0.5) * 0.25,
            opacity: Math.random() * 0.4 + 0.1,
        };
    }

    function init() {
        particles.length = 0;
        for (let i = 0; i < COUNT; i++) {
            particles.push(createParticle());
        }
    }

    function draw() {
        ctx.clearRect(0, 0, W, H);

        particles.forEach(p => {
            p.x += p.vx;
            p.y += p.vy;

            if (p.x < 0) p.x = W;
            if (p.x > W) p.x = 0;
            if (p.y < 0) p.y = H;
            if (p.y > H) p.y = 0;

            ctx.beginPath();
            ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(0, 229, 160, ${p.opacity})`;
            ctx.fill();
        });

        // Draw subtle connections
        for (let i = 0; i < particles.length; i++) {
            for (let j = i + 1; j < particles.length; j++) {
                const dx = particles[i].x - particles[j].x;
                const dy = particles[i].y - particles[j].y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist < 100) {
                    ctx.beginPath();
                    ctx.moveTo(particles[i].x, particles[i].y);
                    ctx.lineTo(particles[j].x, particles[j].y);
                    ctx.strokeStyle = `rgba(0, 229, 160, ${(1 - dist / 100) * 0.06})`;
                    ctx.lineWidth = 0.5;
                    ctx.stroke();
                }
            }
        }

        animId = requestAnimationFrame(draw);
    }

    resize();
    init();
    draw();

    let resizeTimer;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            resize();
            init();
        }, 200);
    }, { passive: true });
}

// ==========================================
// HERO ENTRANCE ANIMATIONS
// ==========================================
function initHeroAnimations() {
    const badge = document.getElementById('heroBadge');
    const title = document.querySelector('.hero-title');
    const desc = document.querySelector('.hero-desc');
    const actions = document.querySelector('.hero-actions');
    const stats = document.querySelector('.hero-stats');
    const phoneWrap = document.getElementById('phoneWrap');

    const delay = 0.3;

    if (badge) {
        setTimeout(() => badge.classList.add('visible'), (delay) * 1000);
    }
    if (title) {
        setTimeout(() => title.classList.add('visible'), (delay + 0.15) * 1000);
    }
    if (desc) {
        setTimeout(() => desc.classList.add('visible'), (delay + 0.1) * 1000);
    }
    if (actions) {
        setTimeout(() => actions.classList.add('visible'), (delay + 0.2) * 1000);
    }
    if (stats) {
        setTimeout(() => stats.classList.add('visible'), (delay + 0.3) * 1000);
    }
    if (phoneWrap) {
        phoneWrap.closest('.hero-visual')?.classList && setTimeout(() => {
            phoneWrap.closest('.hero-visual').classList.add('visible');
        }, (delay + 0.1) * 1000);
    }

    // Float badges
    const fb1 = document.querySelector('.fb-1');
    const fb2 = document.querySelector('.fb-2');
    const fb3 = document.querySelector('.fb-3');

    if (fb1) setTimeout(() => fb1.classList.add('visible'), (delay + 0.5) * 1000);
    if (fb2) setTimeout(() => fb2.classList.add('visible'), (delay + 0.65) * 1000);
    if (fb3) setTimeout(() => fb3.classList.add('visible'), (delay + 0.8) * 1000);
}

// ==========================================
// SCROLL REVEALS
// ==========================================
function initScrollReveals() {
    const reveals = document.querySelectorAll('.reveal');
    if (!reveals.length) return;

    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('visible');
                observer.unobserve(entry.target);
            }
        });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });

    reveals.forEach(el => observer.observe(el));
}

// ==========================================
// COUNTER ANIMATION
// ==========================================
function animateCounter(el) {
    const target = parseFloat(el.dataset.target);
    if (!isFinite(target) || target < 0) return;

    const isDecimal = el.dataset.decimal !== undefined;
    const prefix = sanitizeText(el.dataset.prefix ?? '');
    const suffix = sanitizeText(el.dataset.suffix ?? '');
    const duration = 2000;
    let start = null;

    const step = (timestamp) => {
        if (!start) start = timestamp;
        const elapsed = timestamp - start;
        const progress = Math.min(elapsed / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3);
        const value = eased * target;

        if (isDecimal) {
            el.textContent = prefix + value.toFixed(1) + suffix;
        } else {
            el.textContent = prefix + Math.floor(value).toLocaleString('pt-BR') + suffix;
        }

        if (progress < 1) requestAnimationFrame(step);
    };

    requestAnimationFrame(step);
}

function initCounters() {
    const counters = document.querySelectorAll('.counter');
    if (!counters.length) return;

    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                animateCounter(entry.target);
                observer.unobserve(entry.target);
            }
        });
    }, { threshold: 0.5 });

    counters.forEach(el => observer.observe(el));
}

// ==========================================
// HERO STATS COUNTER (disparo imediato após carga)
// ==========================================
function initHeroCounters() {
    const hstats = document.querySelectorAll('.hstat-num');
    if (!hstats.length) return;

    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const el = entry.target;
                const target = parseFloat(el.dataset.count);
                if (!isFinite(target)) return;

                const isDecimal = el.dataset.decimal !== undefined;
                const duration = 1600;
                let start = null;

                const step = (timestamp) => {
                    if (!start) start = timestamp;
                    const progress = Math.min((timestamp - start) / duration, 1);
                    const eased = 1 - Math.pow(1 - progress, 3);
                    const value = eased * target;
                    el.textContent = isDecimal ? value.toFixed(1) : Math.floor(value).toLocaleString('pt-BR');
                    if (progress < 1) requestAnimationFrame(step);
                };

                requestAnimationFrame(step);
                observer.unobserve(el);
            }
        });
    }, { threshold: 0.7 });

    hstats.forEach(el => observer.observe(el));
}

// ==========================================
// 3D TILT — BENTO CARDS
// ==========================================
function initTiltEffect() {
    const cards = document.querySelectorAll('.bento-card, .step-card');
    const isTouchDevice = window.matchMedia('(hover: none)').matches;
    if (isTouchDevice) return;

    cards.forEach(card => {
        card.addEventListener('mousemove', e => {
            const rect = card.getBoundingClientRect();
            const x = (e.clientX - rect.left) / rect.width - 0.5;
            const y = (e.clientY - rect.top) / rect.height - 0.5;

            gsap.to(card, {
                duration: 0.4,
                rotationY: x * 6,
                rotationX: -y * 6,
                transformPerspective: 800,
                transformOrigin: 'center center',
                ease: 'power2.out',
            });

            card.style.setProperty('--mx', `${(x + 0.5) * 100}%`);
            card.style.setProperty('--my', `${(y + 0.5) * 100}%`);
        }, { passive: true });

        card.addEventListener('mouseleave', () => {
            gsap.to(card, {
                duration: 0.5,
                rotationY: 0,
                rotationX: 0,
                ease: 'elastic.out(1, 0.5)',
            });
        });
    });
}

// ==========================================
// WALLET HOVER — CARDS FLY OUT
// ==========================================
function initWalletEffect() {
    const walletBody = document.getElementById('walletBody');
    if (!walletBody) return;

    const isTouchDevice = window.matchMedia('(hover: none)').matches;
    const c1 = walletBody.querySelector('.wc1');
    const c2 = walletBody.querySelector('.wc2');
    const c3 = walletBody.querySelector('.wc3');
    const hint = walletBody.closest('.wallet-wrap')?.querySelector('.wallet-hint');

    if (!c1 || !c2 || !c3) return;

    walletBody.addEventListener('mouseenter', () => {
        if (hint) gsap.to(hint, { opacity: 0, duration: 0.2 });

        gsap.to(c1, { x: -110, y: -80, rotation: -25, duration: 0.65, ease: 'back.out(1.8)' });
        gsap.to(c2, { x: 0, y: -110, rotation: 0, duration: 0.65, ease: 'back.out(1.8)', delay: 0.06 });
        gsap.to(c3, { x: 110, y: -80, rotation: 25, duration: 0.65, ease: 'back.out(1.8)', delay: 0.12 });

        // Glow on wallet
        gsap.to(walletBody, {
            boxShadow: '0 32px 80px rgba(0,0,0,0.7), 0 0 50px rgba(0,229,160,0.12), inset 0 1px 0 rgba(0,229,160,0.1)',
            duration: 0.3,
        });
    });

    walletBody.addEventListener('mouseleave', () => {
        if (hint) gsap.to(hint, { opacity: 1, duration: 0.3, delay: 0.3 });

        gsap.to(c1, { x: 0, y: 0, rotation: 0, duration: 0.55, ease: 'power3.inOut' });
        gsap.to(c2, { x: 0, y: -6, rotation: -3, duration: 0.55, ease: 'power3.inOut', delay: 0.04 });
        gsap.to(c3, { x: 0, y: -12, rotation: 3, duration: 0.55, ease: 'power3.inOut', delay: 0.08 });

        gsap.to(walletBody, {
            boxShadow: '0 24px 60px rgba(0,0,0,0.6), 0 0 0 1px rgba(0,229,160,0.04), inset 0 1px 0 rgba(0,229,160,0.08)',
            duration: 0.4,
        });
    });

    // Touch: tap to toggle
    if (isTouchDevice) {
        let open = false;
        walletBody.addEventListener('click', () => {
            open = !open;
            if (open) {
                if (hint) gsap.to(hint, { opacity: 0, duration: 0.2 });
                gsap.to(c1, { x: -100, y: -70, rotation: -25, duration: 0.65, ease: 'back.out(1.8)' });
                gsap.to(c2, { x: 0, y: -100, rotation: 0, duration: 0.65, ease: 'back.out(1.8)', delay: 0.06 });
                gsap.to(c3, { x: 100, y: -70, rotation: 25, duration: 0.65, ease: 'back.out(1.8)', delay: 0.12 });
            } else {
                if (hint) gsap.to(hint, { opacity: 1, duration: 0.3 });
                gsap.to(c1, { x: 0, y: 0, rotation: 0, duration: 0.55, ease: 'power3.inOut' });
                gsap.to(c2, { x: 0, y: -6, rotation: -3, duration: 0.55, ease: 'power3.inOut', delay: 0.04 });
                gsap.to(c3, { x: 0, y: -12, rotation: 3, duration: 0.55, ease: 'power3.inOut', delay: 0.08 });
            }
        });
    }
}

// ==========================================
// COIN → PIGGY — GSAP SCROLL
// ==========================================
function initPiggyAnimation() {
    const section = document.getElementById('piggy-section');
    const coin = document.getElementById('piggyCoin');
    const bank = document.getElementById('piggyBank');
    const tl = document.getElementById('piggyTL');
    const tr = document.getElementById('piggyTR');
    const slot = document.getElementById('coinSlot');

    if (!section || !coin || !bank) return;

    // Initial states
    gsap.set(coin, { y: -80, opacity: 0, scale: 0.6 });
    gsap.set(tl, { opacity: 0, x: -30 });
    gsap.set(tr, { opacity: 0, x: 30 });
    gsap.set(bank, { scale: 1 });

    const timeline = gsap.timeline({
        scrollTrigger: {
            trigger: section,
            start: 'top top',
            end: 'bottom bottom',
            scrub: 1.8,
            pin: false,
        },
    });

    timeline
        // Coin appears and falls
        .to(coin, { opacity: 1, scale: 1, y: 0, duration: 0.2, ease: 'power2.out' })
        .to(coin, { y: 160, duration: 0.45, ease: 'none' }, '-=0.05')
        // Side texts fade in during fall
        .to(tl, { opacity: 1, x: 0, duration: 0.2 }, 0.2)
        .to(tr, { opacity: 1, x: 0, duration: 0.2 }, 0.2)
        // Coin enters slot (shrinks + fades)
        .to(coin, { y: 190, scale: 0.05, opacity: 0, duration: 0.12, ease: 'power2.in' }, '-=0.08')
        // Piggy bounces
        .to(bank, { scale: 1.07, duration: 0.06, ease: 'power2.out' }, '-=0.02')
        .to(bank, { scale: 1, duration: 0.12, ease: 'elastic.out(1.5, 0.4)' })
        // Slot glows
        .to(slot ?? {}, { attr: { opacity: 0.9 }, duration: 0.1 }, '-=0.1')
        .to(slot ?? {}, { attr: { opacity: 0.25 }, duration: 0.2 });
}

// ==========================================
// DEPOIMENTOS — CARROSSEL
// ==========================================
function initTestimonials() {
    const track = document.getElementById('testimonialsTrack');
    if (!track) return;

    // Double the array for seamless loop
    const allTestimonials = [...TESTIMONIALS, ...TESTIMONIALS];

    allTestimonials.forEach(t => {
        if (!validateTestimonial(t)) return;

        const card = document.createElement('div');
        card.className = 'testimonial-card';

        const stars = document.createElement('div');
        stars.className = 'testimonial-stars';
        stars.textContent = '★'.repeat(t.stars);

        const text = document.createElement('p');
        text.className = 'testimonial-text';
        text.textContent = sanitizeText(`"${t.text}"`);

        const author = document.createElement('div');
        author.className = 'testimonial-author';

        const avatar = document.createElement('div');
        avatar.className = 'testimonial-avatar';
        avatar.textContent = sanitizeText(t.name.charAt(0));

        const info = document.createElement('div');

        const name = document.createElement('div');
        name.className = 'testimonial-name';
        name.textContent = sanitizeText(t.name);

        const role = document.createElement('div');
        role.className = 'testimonial-role';
        role.textContent = sanitizeText(t.role);

        info.appendChild(name);
        info.appendChild(role);
        author.appendChild(avatar);
        author.appendChild(info);

        card.appendChild(stars);
        card.appendChild(text);
        card.appendChild(author);

        track.appendChild(card);
    });
}

// ==========================================
// MOBILE CTA VISIBILITY
// ==========================================
function initMobileCTA() {
    const cta = document.getElementById('mobileCTA');
    if (!cta) return;

    const heroSection = document.getElementById('hero');

    const update = () => {
        if (!heroSection) {
            cta.setAttribute('aria-hidden', 'false');
            return;
        }
        const heroBottom = heroSection.getBoundingClientRect().bottom;
        if (heroBottom < 0) {
            cta.setAttribute('aria-hidden', 'false');
        } else {
            cta.setAttribute('aria-hidden', 'true');
        }
    };

    window.addEventListener('scroll', update, { passive: true });
    update();
}

// ==========================================
// PROBLEM CARDS — MOUSE TRACKING
// ==========================================
function initProblemCards() {
    const cards = document.querySelectorAll('.problem-card');
    const isTouchDevice = window.matchMedia('(hover: none)').matches;
    if (isTouchDevice) return;

    cards.forEach(card => {
        card.addEventListener('mousemove', e => {
            const rect = card.getBoundingClientRect();
            const x = ((e.clientX - rect.left) / rect.width) * 100;
            const y = ((e.clientY - rect.top) / rect.height) * 100;
            card.style.setProperty('--mx', `${x}%`);
            card.style.setProperty('--my', `${y}%`);
        }, { passive: true });
    });
}

// ==========================================
// PERFORMANCE TRACKING (dev only)
// ==========================================
function trackPerformance() {
    if (!IS_DEV) return;
    try {
        const nav = performance.getEntriesByType('navigation')[0];
        if (nav && nav.loadEventEnd > 0) {
            const load = Math.round(nav.loadEventEnd - nav.fetchStart);
            console.info(`%c GranaEvo LP %c loaded in ${load}ms`, 'background:#00e5a0;color:#040c08;font-weight:800;padding:2px 8px;border-radius:4px', 'color:#00e5a0');
        }
    } catch (_) { /* ignore */ }
}

// ==========================================
// INIT
// ==========================================
function init() {
    initLoadingScreen();
    initScrollProgress();
    initHeader();
    initMobileMenu();
    initParticles();
    initHeroAnimations();
    initScrollReveals();
    initHeroCounters();
    initCounters();
    initTiltEffect();
    initWalletEffect();
    initPiggyAnimation();
    initTestimonials();
    initMobileCTA();
    initProblemCards();
    trackPerformance();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
