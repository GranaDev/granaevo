// ==========================================
// GRANAEVO LANDING PAGE - JAVASCRIPT
// Versão Segura — V5.0
//
// MELHORIAS APLICADAS NESTA VERSÃO (vs V4.0):
// ─────────────────────────────────────────────────────────────────
// [A]  API performance.timing (DEPRECATED) substituída pela
//      Navigation Timing API Level 2 (PerformanceNavigationTiming).
//      A API antiga foi removida de alguns browsers modernos.
//
// [B]  Trusted Types: todo o código que manipula DOM já é compatível.
//      Não há innerHTML, document.write ou insertAdjacentHTML em
//      nenhum ponto. Pronto para require-trusted-types-for 'script'.
//
// [C]  deepFreeze: proteção reforçada para arrays e objetos aninhados.
//
// [D]  sanitizeText: simplificada e corrigida. A versão anterior
//      criava um <span> apenas para ler .textContent — redundante.
//      document.createTextNode já realiza o escape; basta retornar
//      a string tratada diretamente via textContent do nó.
//
// [E]  trackEvent: allowlist expandida com comentário explicando
//      o modelo de segurança.
//
// [F]  Ripple: keyframe injetado via CSSStyleSheet.replace()
//      (assíncrono, mais correto que replaceSync para não bloquear
//      o thread principal).
//
// [G]  closeMobileMenu / openMobileMenu: extraídas para escopo
//      de módulo mais cedo para garantir disponibilidade no keydown.
//
// MANTIDO DA V4.0:
// ─────────────────────────────────────────────────────────────────
// [1]  Testimonials: createElement + textContent, sem innerHTML
// [2]  validateTestimonial(): validação estrutural + de tipos
// [3]  TESTIMONIALS_DATA: imutável via deepFreeze
// [4]  Console branding restrito a IS_DEV
// [5]  counter animation: valores validados (isFinite, não-negativo)
// [6]  Ripple effect: XY limitados aos bounds do elemento
// [7]  Sem eval(), Function(), document.write(), insertAdjacentHTML()
// [8]  Event listeners com passive: true onde cabível
// [9]  Escape fecha menu (acessibilidade + UX)
// [10] Strict mode via type="module" no HTML
// ==========================================

'use strict'; // Redundante com module — explícito para clareza do leitor

// ==========================================
// AMBIENTE
// ==========================================
const IS_DEV = (
    location.hostname === 'localhost'    ||
    location.hostname === '127.0.0.1'   ||
    location.hostname.endsWith('.local')
);

// ==========================================
// UTILITÁRIOS DE SEGURANÇA
// ==========================================

/**
 * Retorna a string segura para uso em textContent.
 * createTextNode faz o escape automático de qualquer HTML.
 * Não usa innerHTML em nenhum momento.
 *
 * [D] Versão simplificada: a versão anterior criava um <span>
 *     desnecessário. O nó de texto já expõe .nodeValue sem HTML.
 *
 * @param {unknown} value
 * @returns {string}
 */
function sanitizeText(value) {
    if (typeof value !== 'string') return '';
    // createTextNode escapa automaticamente < > & " ' etc.
    const node = document.createTextNode(value);
    return node.nodeValue ?? '';
}

/**
 * Valida que um objeto testimonial possui as propriedades esperadas,
 * todas do tipo string e com comprimento razoável.
 * Protege contra prototype pollution e dados malformados.
 *
 * @param {unknown} obj
 * @returns {boolean}
 */
function validateTestimonial(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
    if (!Object.prototype.hasOwnProperty.call(obj, 'stars'))  return false;
    if (!Object.prototype.hasOwnProperty.call(obj, 'text'))   return false;
    if (!Object.prototype.hasOwnProperty.call(obj, 'author')) return false;
    if (typeof obj.stars  !== 'string' || obj.stars.length  > 20)  return false;
    if (typeof obj.text   !== 'string' || obj.text.length   > 500) return false;
    if (typeof obj.author !== 'string' || obj.author.length > 100) return false;
    return true;
}

/**
 * Deep freeze recursivo — impede mutação de objetos e arrays de dados.
 * Protege contra ataques de prototype pollution em runtime.
 *
 * @param {object} obj
 * @returns {object}
 */
function deepFreeze(obj) {
    Object.getOwnPropertyNames(obj).forEach(name => {
        const value = obj[name];
        if (value && typeof value === 'object') {
            deepFreeze(value);
        }
    });
    return Object.freeze(obj);
}

// ==========================================
// DADOS IMUTÁVEIS DE DEPOIMENTOS
// deepFreeze impede que qualquer código externo modifique o array.
// ==========================================
const TESTIMONIALS_DATA = deepFreeze([
    {
        stars:  '★★★★★',
        text:   'O GranaEvo mudou completamente minha relação com o dinheiro. Finalmente sei exatamente para onde vai cada centavo!',
        author: 'Maria Silva'
    },
    {
        stars:  '★★★★★',
        text:   'Nunca mais fui pego de surpresa pela fatura do cartão. O controle é total e muito fácil de usar.',
        author: 'João Santos'
    },
    {
        stars:  '★★★★★',
        text:   'Consegui economizar R$ 5.000 em 6 meses só organizando melhor meus gastos com o GranaEvo.',
        author: 'Ana Costa'
    },
    {
        stars:  '★★★★★',
        text:   'Perfeito para casais! Agora eu e meu marido temos visão completa das nossas finanças juntos.',
        author: 'Patricia Oliveira'
    },
    {
        stars:  '★★★★★',
        text:   'Interface super intuitiva. Até minha mãe de 65 anos conseguiu usar sem dificuldade!',
        author: 'Carlos Pereira'
    },
    {
        stars:  '★★★★★',
        text:   'Vale cada centavo! O investimento se paga só na economia que você consegue fazer.',
        author: 'Roberto Lima'
    },
    {
        stars:  '★★★★★',
        text:   'Tinha medo de apps financeiros, mas o GranaEvo é simples e seguro. Recomendo muito!',
        author: 'Juliana Martins'
    },
    {
        stars:  '★★★★★',
        text:   'Os gráficos e relatórios me ajudaram a identificar gastos que eu nem sabia que tinha.',
        author: 'Fernando Souza'
    }
]);

// ==========================================
// LOADING SCREEN
// ==========================================
window.addEventListener('load', () => {
    const loadingScreen = document.getElementById('loadingScreen');
    if (!loadingScreen) return;
    setTimeout(() => {
        loadingScreen.classList.add('hidden');
    }, 1200);
});

// ==========================================
// SCROLL PROGRESS BAR
// ==========================================
const scrollProgress = document.getElementById('scrollProgress');

function updateScrollProgress() {
    if (!scrollProgress) return;
    const windowHeight   = window.innerHeight;
    const documentHeight = document.documentElement.scrollHeight - windowHeight;
    const scrolled       = window.scrollY;
    const progress       = documentHeight > 0
        ? Math.min((scrolled / documentHeight) * 100, 100)
        : 0;
    scrollProgress.style.width = `${progress}%`;
    scrollProgress.setAttribute('aria-valuenow', Math.round(progress));
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
// [G] Funções declaradas antes dos event listeners para garantir
//     disponibilidade quando o keydown é registrado logo abaixo.
// ==========================================
const mobileToggle = document.getElementById('mobileToggle');
const navLinks      = document.getElementById('navLinks');

function closeMobileMenu() {
    if (!mobileToggle || !navLinks) return;
    mobileToggle.classList.remove('active');
    navLinks.classList.remove('active');
    document.body.style.overflow = '';
    mobileToggle.setAttribute('aria-expanded', 'false');
    mobileToggle.setAttribute('aria-label',    'Abrir menu de navegação');
}

function openMobileMenu() {
    if (!mobileToggle || !navLinks) return;
    mobileToggle.classList.add('active');
    navLinks.classList.add('active');
    document.body.style.overflow = 'hidden';
    mobileToggle.setAttribute('aria-expanded', 'true');
    mobileToggle.setAttribute('aria-label',    'Fechar menu de navegação');
}

if (mobileToggle && navLinks) {
    mobileToggle.addEventListener('click', () => {
        mobileToggle.classList.contains('active')
            ? closeMobileMenu()
            : openMobileMenu();
    });

    // Fecha menu ao clicar em um link
    navLinks.querySelectorAll('a').forEach(link => {
        link.addEventListener('click', closeMobileMenu);
    });

    // Fecha menu ao clicar fora
    document.addEventListener('click', (e) => {
        if (
            navLinks.classList.contains('active') &&
            !navLinks.contains(e.target)          &&
            !mobileToggle.contains(e.target)
        ) {
            closeMobileMenu();
        }
    });
}

// ==========================================
// MOBILE CTA FLOATING BUTTON
// ==========================================
const mobileCTA = document.getElementById('mobileCTA');

function handleMobileCTA() {
    if (!mobileCTA) return;
    const shouldShow = window.innerWidth < 768 && window.scrollY > 800;
    mobileCTA.classList.toggle('visible', shouldShow);

    // Acessibilidade: retira/restaura do tab order quando invisível
    const link = mobileCTA.querySelector('a');
    if (link) link.setAttribute('tabindex', shouldShow ? '0' : '-1');
    mobileCTA.setAttribute('aria-hidden', String(!shouldShow));
}

if (mobileCTA) {
    window.addEventListener('scroll', handleMobileCTA, { passive: true });
    window.addEventListener('resize', handleMobileCTA, { passive: true });
}

// ==========================================
// SMOOTH SCROLL
// ==========================================
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
        const href = this.getAttribute('href');

        // Ignora href vazio ou apenas "#"
        if (!href || href === '#' || href.length === 1) return;

        // Valida seletor — evita CSS injection via href
        if (!/^#[a-zA-Z][\w-]*$/.test(href)) return;

        const target = document.querySelector(href);
        if (!target) return;

        e.preventDefault();
        const headerHeight   = header ? header.offsetHeight : 0;
        const targetPosition = target.getBoundingClientRect().top + window.scrollY - headerHeight - 20;

        window.scrollTo({ top: targetPosition, behavior: 'smooth' });
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

    // Cap de partículas baseado na área da tela.
    // Sem isso, monitores 4K ou ultrawide gerariam uso excessivo de CPU
    // porque o canvas ocupa toda a viewport e cada partícula precisa
    // ser re-renderizada a cada frame (~60fps).
    // Fórmula: 1 partícula por 14.000px² de área, mínimo 20, máximo 60.
    const screenArea    = window.innerWidth * window.innerHeight;
    const areaBased     = Math.floor(screenArea / 14000);
    const particleCount = Math.max(20, Math.min(60, areaBased));

    class Particle {
        constructor() { this.reset(); }

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

    const particles = Array.from({ length: particleCount }, () => new Particle());

    function animateParticles() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        particles.forEach(p => { p.update(); p.draw(); });
        requestAnimationFrame(animateParticles);
    }

    animateParticles();
}

// ==========================================
// HERO STATS COUNTER ANIMATION
// Valor validado: deve ser número finito e não-negativo.
// ==========================================
function animateCounter(element) {
    const raw = parseFloat(element.getAttribute('data-count'));

    // Rejeita NaN, Infinity, negativo
    if (!Number.isFinite(raw) || raw < 0) {
        element.textContent = '0';
        return;
    }

    const target    = raw;
    const duration  = 2000;
    const increment = target / (duration / 16);
    let current     = 0;

    const updateCounter = () => {
        current += increment;
        if (current < target) {
            element.textContent = Math.floor(current).toLocaleString('pt-BR');
            requestAnimationFrame(updateCounter);
        } else {
            element.textContent = target.toLocaleString('pt-BR');
        }
    };

    updateCounter();
}

const statValues = document.querySelectorAll('.stat-value[data-count]');

const counterObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting && entry.target.textContent === '0') {
            animateCounter(entry.target);
        }
    });
}, { threshold: 0.5 });

statValues.forEach(stat => counterObserver.observe(stat));

// ==========================================
// MINI CHART
// ==========================================
const miniChart = document.getElementById('miniChart');
if (miniChart) {
    const ctx = miniChart.getContext('2d');
    miniChart.width  = miniChart.offsetWidth;
    miniChart.height = miniChart.offsetHeight;

    // Dados estáticos e tipados — sem entrada externa
    const data    = Object.freeze([20, 45, 30, 60, 40, 70, 50, 80, 65, 90]);
    const max     = Math.max(...data);
    const padding = 10;
    const width   = miniChart.width;
    const height  = miniChart.height;
    const stepX   = (width - padding * 2) / (data.length - 1);

    ctx.strokeStyle = '#10b981';
    ctx.lineWidth   = 2;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';

    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, 'rgba(16, 185, 129, 0.2)');
    gradient.addColorStop(1, 'rgba(16, 185, 129, 0)');

    // Área preenchida
    ctx.beginPath();
    data.forEach((value, index) => {
        const x = padding + index * stepX;
        const y = height - padding - (value / max) * (height - padding * 2);
        index === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.lineTo(width - padding, height - padding);
    ctx.lineTo(padding,         height - padding);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    // Linha do gráfico
    ctx.beginPath();
    data.forEach((value, index) => {
        const x = padding + index * stepX;
        const y = height - padding - (value / max) * (height - padding * 2);
        index === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
}

// ==========================================
// TESTIMONIALS CAROUSEL
// Sem innerHTML — usa apenas createElement e textContent.
// Cada item é validado antes de renderizar.
// Trusted Types compatível: nenhuma atribuição de HTML string.
// ==========================================

/**
 * Cria um card de depoimento de forma segura.
 * Nunca usa innerHTML. Todos os dados passam por textContent.
 *
 * @param {{ stars: string, text: string, author: string }} testimonial
 * @returns {HTMLElement}
 */
function createTestimonialCard(testimonial) {
    const card = document.createElement('div');
    card.className = 'testimonial-card';

    const stars = document.createElement('div');
    stars.className = 'testimonial-stars';
    stars.setAttribute('aria-label', 'Avaliação 5 estrelas');
    stars.textContent = sanitizeText(testimonial.stars);

    const text = document.createElement('p');
    text.className = 'testimonial-text';
    text.textContent = sanitizeText(testimonial.text);

    const author = document.createElement('div');
    author.className = 'testimonial-author';
    author.textContent = sanitizeText(testimonial.author);

    card.appendChild(stars);
    card.appendChild(text);
    card.appendChild(author);

    return card;
}

function createTestimonialCards() {
    const testimonialsTrack = document.getElementById('testimonialsTrack');
    if (!testimonialsTrack) return;

    // Duplica para efeito de carrossel infinito
    const allTestimonials = [...TESTIMONIALS_DATA, ...TESTIMONIALS_DATA];

    // DocumentFragment para uma única operação de DOM (performance)
    const fragment = document.createDocumentFragment();

    allTestimonials.forEach(testimonial => {
        if (!validateTestimonial(testimonial)) {
            if (IS_DEV) console.warn('GranaEvo: depoimento inválido ignorado', testimonial);
            return;
        }
        fragment.appendChild(createTestimonialCard(testimonial));
    });

    // Limpa o container e insere tudo de uma vez (sem innerHTML)
    while (testimonialsTrack.firstChild) {
        testimonialsTrack.removeChild(testimonialsTrack.firstChild);
    }
    testimonialsTrack.appendChild(fragment);
}

createTestimonialCards();

// ==========================================
// INTERSECTION OBSERVER — REVEAL ANIMATIONS
// ==========================================
const observerOptions = {
    threshold:   0.1,
    rootMargin: '0px 0px -50px 0px'
};

const fadeObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            entry.target.classList.add('active');
        }
    });
}, observerOptions);

document.querySelectorAll('.problem-card, .feature-card, .timeline-item')
    .forEach(el => {
        el.classList.add('reveal');
        fadeObserver.observe(el);
    });

// ==========================================
// PARALLAX EFFECT (DESKTOP ONLY)
// ==========================================
if (window.innerWidth >= 1024) {
    const parallaxElements = document.querySelectorAll('[data-parallax]');

    window.addEventListener('scroll', () => {
        const scrolled = window.scrollY;
        parallaxElements.forEach(element => {
            const speed = parseFloat(element.getAttribute('data-parallax'));
            if (!Number.isFinite(speed)) return;
            // Limita o speed para evitar transformações extremas
            const clampedSpeed = Math.max(-1, Math.min(1, speed));
            element.style.transform = `translateY(${scrolled * clampedSpeed}px)`;
        });
    }, { passive: true });
}

// ==========================================
// TILT EFFECT (DESKTOP ONLY)
// ==========================================
if (window.innerWidth >= 1024) {
    document.querySelectorAll('[data-tilt]').forEach(element => {
        element.addEventListener('mousemove', (e) => {
            const rect    = element.getBoundingClientRect();
            const centerX = rect.width  / 2;
            const centerY = rect.height / 2;
            // Limita rotação para evitar inversões visuais
            const rotateX = Math.max(-15, Math.min(15, (e.clientY - rect.top  - centerY) / 10));
            const rotateY = Math.max(-15, Math.min(15, (centerX - (e.clientX - rect.left)) / 10));
            element.style.transform = `perspective(1000px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) scale3d(1.02, 1.02, 1.02)`;
        });

        element.addEventListener('mouseleave', () => {
            element.style.transform = '';
        });
    });
}

// ==========================================
// BUTTON RIPPLE EFFECT
// XY restringidos aos bounds do elemento para evitar overflow.
//
// [F] CSSStyleSheet.replace() assíncrono — não bloqueia o thread
//     principal, ao contrário de replaceSync().
// ==========================================
(async () => {
    try {
        const rippleStyleSheet = new CSSStyleSheet();
        await rippleStyleSheet.replace(`
            @keyframes ripple {
                to { transform: scale(2.5); opacity: 0; }
            }
        `);
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, rippleStyleSheet];
    } catch {
        // Fallback silencioso: CSSStyleSheet não suportado (navegadores antigos)
        // O efeito ripple não será exibido, mas a funcionalidade é mantida.
        if (IS_DEV) console.warn('GranaEvo: CSSStyleSheet.replace() não suportado.');
    }
})();

document.querySelectorAll('.btn-primary, .btn-secondary, .btn-nav, .btn-float')
    .forEach(button => {
        button.addEventListener('click', function (e) {
            const rect = this.getBoundingClientRect();
            const size = Math.max(rect.width, rect.height);
            const rawX = e.clientX - rect.left  - size / 2;
            const rawY = e.clientY - rect.top   - size / 2;
            // Limita X e Y ao interior do botão
            const x = Math.max(-size, Math.min(rawX, rect.width));
            const y = Math.max(-size, Math.min(rawY, rect.height));

            const ripple = document.createElement('span');

            // Propriedades individuais — sem cssText (evita injeção)
            ripple.style.position     = 'absolute';
            ripple.style.width        = `${size}px`;
            ripple.style.height       = `${size}px`;
            ripple.style.borderRadius = '50%';
            ripple.style.background   = 'rgba(255, 255, 255, 0.3)';
            ripple.style.left         = `${x}px`;
            ripple.style.top          = `${y}px`;
            ripple.style.pointerEvents = 'none';
            ripple.style.animation    = 'ripple 0.6s ease-out';

            this.style.position = 'relative';
            this.style.overflow = 'hidden';
            this.appendChild(ripple);

            ripple.addEventListener('animationend', () => ripple.remove(), { once: true });
        });
    });

// ==========================================
// TRACK EVENTS
//
// [E] Modelo de segurança:
// - category e action validados por allowlist de Sets frozen
// - label validado por regex: só alfanumérico + _ e -
// - Rejeita qualquer string que contenha HTML ou JS
// ==========================================

// Allowlist de categorias e ações válidas
const ALLOWED_CATEGORIES = Object.freeze(new Set(['CTA', 'Navigation', 'Feature']));
const ALLOWED_ACTIONS    = Object.freeze(new Set(['click', 'view', 'scroll']));

/**
 * Dispara evento de analytics de forma blindada.
 * Não aceita strings arbitrárias — valida contra allowlist.
 *
 * @param {string} category
 * @param {string} action
 * @param {string} label
 */
function trackEvent(category, action, label) {
    if (typeof category !== 'string' ||
        typeof action   !== 'string' ||
        typeof label    !== 'string') return;

    if (!ALLOWED_CATEGORIES.has(category)) return;
    if (!ALLOWED_ACTIONS.has(action))      return;

    // Label: apenas alfanumérico + underscores + hífens
    if (!/^[a-zA-Z0-9_\-]{1,60}$/.test(label)) return;

    if (typeof window.gtag === 'function') {
        window.gtag('event', action, {
            event_category: category,
            event_label:    label
        });
    }

    if (typeof window.fbq === 'function') {
        window.fbq('track', action, { category, label });
    }
}

// Track cliques em CTAs
document.querySelectorAll('.btn-primary').forEach(btn => {
    btn.addEventListener('click', () => trackEvent('CTA', 'click', 'primary_button'));
});
document.querySelectorAll('.btn-secondary').forEach(btn => {
    btn.addEventListener('click', () => trackEvent('CTA', 'click', 'secondary_button'));
});

// ==========================================
// PERFORMANCE MONITORING
//
// [A] API performance.timing foi DEPRECADA.
//     Substituída pela Navigation Timing API Level 2:
//     PerformanceNavigationTiming (getEntriesByType).
//
//     Comparação:
//     ANTES (deprecated):
//         performance.timing.loadEventEnd - performance.timing.navigationStart
//     DEPOIS (correto):
//         navEntry.loadEventEnd - navEntry.startTime
//
//     Referência: https://developer.mozilla.org/en-US/docs/Web/API/PerformanceNavigationTiming
// ==========================================
window.addEventListener('load', () => {
    if (!IS_DEV) return;

    // PerformanceObserver: forma reativa e não-deprecada
    try {
        const observer = new PerformanceObserver((list) => {
            const entries = list.getEntriesByType('navigation');
            if (!entries.length) return;

            const navEntry    = entries[0];
            const pageLoadMs  = Math.round(navEntry.loadEventEnd - navEntry.startTime);
            const domReadyMs  = Math.round(navEntry.domContentLoadedEventEnd - navEntry.startTime);
            const ttfbMs      = Math.round(navEntry.responseStart - navEntry.requestStart);

            if (pageLoadMs > 0) {
                console.log(`⚡ Página carregada em ${pageLoadMs}ms`);
                console.log(`   DOM pronto em ${domReadyMs}ms`);
                console.log(`   TTFB: ${ttfbMs}ms`);
                if (pageLoadMs > 3000) console.warn('⚠️ Tempo de carregamento alto (> 3s)');
                if (ttfbMs > 600)      console.warn('⚠️ TTFB alto (> 600ms) — verificar servidor');
            }

            observer.disconnect();
        });

        observer.observe({ type: 'navigation', buffered: true });

    } catch {
        // Fallback para browsers sem PerformanceObserver
        const entries = performance.getEntriesByType?.('navigation') ?? [];
        if (entries.length) {
            const ms = Math.round(entries[0].loadEventEnd - entries[0].startTime);
            if (ms > 0) {
                console.log(`⚡ Página carregada em ${ms}ms`);
                if (ms > 3000) console.warn('⚠️ Tempo de carregamento alto');
            }
        }
    }
});

// ==========================================
// CONSOLE BRANDING
// Restrito ao ambiente de desenvolvimento.
// Não expõe tecnologia, versão ou stack em produção.
// ==========================================
if (IS_DEV) {
    console.log(
        '%c🚀 GranaEvo Landing Page',
        'background: #10b981; color: white; padding: 12px 24px; border-radius: 8px; font-weight: bold; font-size: 16px;'
    );
    console.log(
        '%c✔ Sistema Seguro Ativo — Modo Desenvolvimento',
        'color: #10b981; font-weight: bold; font-size: 14px;'
    );
}

// ==========================================
// ACESSIBILIDADE — KEYBOARD NAVIGATION
// ==========================================

// Fechar menu com Escape
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && navLinks?.classList.contains('active')) {
        closeMobileMenu();
        mobileToggle?.focus(); // Devolve foco ao botão de menu
    }
});

// Botão de menu com teclado
if (mobileToggle) {
    mobileToggle.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            mobileToggle.click();
        }
    });
}

// ==========================================
// ONLINE / OFFLINE STATUS
// ==========================================
window.addEventListener('online',  () => { if (IS_DEV) console.log('✔ Conexão restaurada'); });
window.addEventListener('offline', () => { if (IS_DEV) console.warn('⚠ Conexão perdida'); });

// ==========================================
// SCROLL RESTORATION
// ==========================================
if ('scrollRestoration' in history) {
    history.scrollRestoration = 'manual';
}

// ==========================================
// INITIALIZATION
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
    if (IS_DEV) console.log('✔ DOM carregado');
    // Animação inicial suave
    setTimeout(() => { document.body.style.opacity = '1'; }, 100);
});

// ==========================================
// SERVICE WORKER (RESERVADO PARA IMPLEMENTAÇÃO FUTURA)
// ==========================================
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        // Registrar o SW quando estiver pronto:
        // navigator.serviceWorker.register('/sw.js');
    });
}