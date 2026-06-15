// ==========================================
// GRANAEVO PLANOS — planos.js
// Versão Segura v6 | Stripe Checkout
// ==========================================

import { supabase, loginWithPassword } from '../services/supabase-client.js?v=2';

// ==========================================
// MODAL DE CADASTRO PRÉ-CHECKOUT
// Novo fluxo: usuário cria conta aqui mesmo, depois paga no Stripe.
// Elimina a necessidade do "Primeiro Acesso" para novos usuários Stripe.
// ==========================================

const PLAN_LABELS = {
    individual: { name: 'Individual', price: 'R$19,99/mês' },
    casal:      { name: 'Casal',      price: 'R$34,99/mês' },
    familia:    { name: 'Família',    price: 'R$54,99/mês' },
};

let _pendingPlan = null; // plano aguardando cadastro

const SignupModal = (() => {
    const modal       = () => document.getElementById('signupModal');
    const backdrop    = () => document.getElementById('signupModalBackdrop');
    const form        = () => document.getElementById('signupForm');
    const emailInput  = () => document.getElementById('signupEmail');
    const pwdInput    = () => document.getElementById('signupPassword');
    const confInput   = () => document.getElementById('signupConfirmPassword');
    const submitBtn   = () => document.getElementById('signupSubmitBtn');
    const alertBox    = () => document.getElementById('signupAlert');
    const alertMsg    = () => document.getElementById('signupAlertMsg');
    const pwdError    = () => document.getElementById('signupPwdError');
    const planBadge   = () => document.getElementById('signupPlanBadge');
    const toggleBtn   = () => document.getElementById('signupTogglePwd');
    const closeBtn    = () => document.getElementById('signupModalClose');

    function showAlert(type, msg) {
        const box = alertBox();
        if (!box) return;
        box.className = `signup-alert show-${type}`;
        const m = alertMsg();
        if (m) m.textContent = msg;
    }

    function hideAlert() {
        const box = alertBox();
        if (box) box.className = 'signup-alert';
    }

    function showPwdError(msg) {
        const el = pwdError();
        if (!el) return;
        el.textContent = msg;
        el.classList.toggle('show', !!msg);
    }

    function setLoading(loading) {
        const btn = submitBtn();
        if (!btn) return;
        btn.disabled = loading;
        const span = btn.querySelector('.btn-text');
        if (span) span.textContent = loading ? 'Aguarde...' : 'Continuar para pagamento';
    }

    function open(plan) {
        _pendingPlan = plan;
        const m = modal();
        if (!m) return;
        // Atualiza badge do plano
        const badge = planBadge();
        if (badge && PLAN_LABELS[plan]) {
            badge.textContent = `${PLAN_LABELS[plan].name} · ${PLAN_LABELS[plan].price}`;
        }
        hideAlert();
        showPwdError('');
        const f = form();
        if (f) f.reset();
        m.classList.add('open');
        m.setAttribute('aria-hidden', 'false');
        setTimeout(() => emailInput()?.focus(), 100);
    }

    function close() {
        const m = modal();
        if (!m) return;
        m.classList.remove('open');
        m.setAttribute('aria-hidden', 'true');
        _pendingPlan = null;
    }

    // Avalia força da senha com base nos 4 requisitos obrigatórios
    // Mínimo: 10 chars — consistente com o reset de senha em login.js
    function _checkStrength(password) {
        const hasMin   = password.length >= 10;
        const hasUpper = /[A-Z]/.test(password);
        const hasNum   = /[0-9]/.test(password);
        const hasSpec  = /[^A-Za-z0-9]/.test(password);
        const met      = [hasMin, hasUpper, hasNum].filter(Boolean).length;

        if (!password) return { level: 0, label: '', hasMin, hasUpper, hasNum, hasSpec };
        if (met === 3 && hasSpec && password.length >= 12) return { level: 4, label: 'Senha muito forte', hasMin, hasUpper, hasNum, hasSpec };
        if (met === 3 && password.length >= 12) return { level: 3, label: 'Senha forte',  hasMin, hasUpper, hasNum, hasSpec };
        if (met === 3)                           return { level: 2, label: 'Senha média',  hasMin, hasUpper, hasNum, hasSpec };
        if (met >= 1)                            return { level: 1, label: 'Senha fraca',  hasMin, hasUpper, hasNum, hasSpec };
        return                                          { level: 0, label: 'Muito fraca',  hasMin, hasUpper, hasNum, hasSpec };
    }

    function _updateStrengthBar(password) {
        const fill     = document.getElementById('signupStrengthFill');
        const text     = document.getElementById('signupStrengthText');
        const reqMin   = document.getElementById('reqMin');
        const reqUpper = document.getElementById('reqUpper');
        const reqNum   = document.getElementById('reqNum');
        const reqSpec  = document.getElementById('reqSpec');
        if (!fill || !text) return;

        const { level, label, hasMin, hasUpper, hasNum, hasSpec } = _checkStrength(password);

        fill.className = 'signup-strength-fill' + (
            level === 4 ? ' signup-str-vstrong' :
            level === 3 ? ' signup-str-strong'  :
            level === 2 ? ' signup-str-medium'  :
            level === 1 ? ' signup-str-weak'    : ''
        );
        text.textContent = label;

        // Atualiza indicadores de requisitos
        reqMin?.classList.toggle('met',   hasMin);
        reqUpper?.classList.toggle('met', hasUpper);
        reqNum?.classList.toggle('met',   hasNum);
        reqSpec?.classList.toggle('met',  hasSpec);
    }

    function init() {
        // Fecha ao clicar no backdrop
        backdrop()?.addEventListener('click', close);
        closeBtn()?.addEventListener('click', close);

        // Toggle visibilidade da senha — mantém foco e cursor no input
        toggleBtn()?.addEventListener('click', () => {
            const p = pwdInput();
            if (!p) return;
            const pos = p.selectionStart;
            p.type = p.type === 'password' ? 'text' : 'password';
            // Restaura posição do cursor após troca de tipo
            requestAnimationFrame(() => { try { p.setSelectionRange(pos, pos); } catch {} });
        });

        // Barra de força em tempo real
        pwdInput()?.addEventListener('input', () => {
            _updateStrengthBar(pwdInput()?.value || '');
        });

        // Valida confirmação inline
        confInput()?.addEventListener('input', () => {
            const pwd  = pwdInput()?.value || '';
            const conf = confInput()?.value || '';
            if (conf && conf !== pwd) showPwdError('As senhas não coincidem.');
            else showPwdError('');
        });

        // Fecha com Escape
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && modal()?.classList.contains('open')) close();
        });

        // Limpa barra ao abrir (reset do form)
        const origOpen = open;

        // Submit do formulário
        form()?.addEventListener('submit', async (e) => {
            e.preventDefault();
            hideAlert();
            showPwdError('');

            const email    = (emailInput()?.value || '').trim().toLowerCase();
            const password = pwdInput()?.value || '';
            const confirm  = confInput()?.value || '';

            // Verificação de honeypot no browser (campos ocultos)
            const hpEmail = document.getElementById('_ge_hp_email')?.value || '';
            const hpUrl   = document.getElementById('_ge_hp_url')?.value   || '';
            if (hpEmail || hpUrl) {
                setLoading(false);
                return;
            }

            // Validação de email
            if (!email || !/^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
                showAlert('error', 'Digite um email válido.');
                emailInput()?.focus();
                return;
            }

            // Validação de senha — requisitos obrigatórios
            if (password.length < 10) {
                showAlert('error', 'A senha deve ter no mínimo 10 caracteres.');
                pwdInput()?.focus();
                return;
            }
            if (!/[A-Z]/.test(password)) {
                showAlert('error', 'A senha deve ter pelo menos uma letra maiúscula.');
                pwdInput()?.focus();
                return;
            }
            if (!/[0-9]/.test(password)) {
                showAlert('error', 'A senha deve ter pelo menos um número.');
                pwdInput()?.focus();
                return;
            }
            if (password !== confirm) {
                showPwdError('As senhas não coincidem.');
                confInput()?.focus();
                return;
            }

            setLoading(true);

            try {
                // 1. Cria conta via proxy server-side (rate-limited, com honeypot e validações)
                let createRes;
                try {
                    createRes = await fetch('/api/create-account', {
                        method:  'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body:    JSON.stringify({
                            email,
                            password,
                            plan: _pendingPlan || 'individual',
                            _hp_email: '',
                            _hp_url:   '',
                        }),
                    });
                } catch {
                    throw new Error('NETWORK');
                }

                if (createRes.status === 409) {
                    // Email já cadastrado
                    showAlert('error', 'Este email já está cadastrado. Faça login para continuar.');
                    return;
                }

                if (createRes.status === 429) {
                    showAlert('error', 'Muitas tentativas. Aguarde antes de tentar novamente.');
                    return;
                }

                if (!createRes.ok) {
                    throw new Error('CREATE_FAILED');
                }

                // 2. Login server-side (conta já confirmada pelo proxy).
                //    O refresh token vai para cookie HttpOnly; o access para a memória.
                await loginWithPassword(email, password, false);
                const { data: { session } } = await supabase.auth.getSession();
                if (!session?.access_token) {
                    throw new Error('Sessão não estabelecida após cadastro.');
                }

                // 3. Fecha modal e inicia checkout com JWT
                close();
                await _checkoutComSessao(session, _pendingPlan || 'individual');

            } catch {
                showAlert('error', 'Erro ao criar conta. Verifique sua conexão e tente novamente.');
            } finally {
                setLoading(false);
            }
        });
    }

    return { open, close, init };
})();

// Inicia checkout aproveitando sessão já existente (JWT no header)
async function _checkoutComSessao(session, plan) {
    const btn     = document.querySelector(`.btn-plan[data-plan="${plan}"]`);
    const btnText = btn?.querySelector('.btn-text');
    if (btnText) btnText.textContent = 'Aguarde...';
    if (btn)    btn.disabled = true;

    try {
        const headers = {
            'Content-Type':  'application/json',
            'Authorization': `Bearer ${session.access_token}`,
        };
        const body = {
            action: 'checkout',
            plan,
            email: session.user?.email || '',
        };
        const res  = await fetch('/api/stripe', { method: 'POST', headers, body: JSON.stringify(body) });
        const data = await res.json();
        if (!res.ok || !data.url) throw new Error(data.error ?? 'URL não retornada');
        safeRedirect(data.url);
    } catch {
        if (btnText) btnText.textContent = 'Começar Agora';
        if (btn)    btn.disabled = false;
        alert('Não foi possível iniciar o pagamento. Tente novamente em instantes.');
    }
}

// ==========================================
// CONFIGURAÇÕES
// ==========================================
const CONFIG = {
    // Domínios permitidos para redirecionamento (whitelist)
    allowedRedirectDomains: ['checkout.stripe.com'],

    // Normalização de data-plan → chave canônica
    planNameMap: {
        'individual': 'individual',
        'casal':      'casal',
        'familia':    'familia'
    }
};

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

async function iniciarCheckout(rawPlanName) {
    if (checkoutLock) {
        console.warn('[GranaEvo] Checkout bloqueado — aguarde antes de tentar novamente.');
        return;
    }

    const plan = CONFIG.planNameMap[rawPlanName?.toLowerCase()];
    if (!plan) {
        console.error('[GranaEvo] Plano desconhecido bloqueado:', rawPlanName);
        return;
    }

    checkoutLock = true;
    setTimeout(() => { checkoutLock = false; }, 3000);
    trackEvent('Plan', 'checkout_click', plan);

    try {
        // Verifica se usuário já está logado
        const { data: { session } } = await supabase.auth.getSession().catch(() => ({ data: {} }));

        if (session?.access_token) {
            // Já logado → checkout direto sem modal
            await _checkoutComSessao(session, plan);
        } else {
            // Não logado → abre modal para criar conta primeiro
            checkoutLock = false;
            SignupModal.open(plan);
        }
    } catch {
        checkoutLock = false;
        alert('Não foi possível iniciar o pagamento. Tente novamente em instantes.');
    }
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

// v6: Resize handler — CSS scroll-snap needs no re-init
let resizeTimer;
window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
        const track = document.getElementById('plansTrack');
        // Clear any leftover JS carousel transforms
        if (track) {
            track.style.transform  = '';
            track.style.transition = '';
        }
        planCardsArray = Array.from(document.querySelectorAll('.plan-card'));
        planCardsArray.forEach(card => {
            card.classList.remove('active-slide');
            // Don't clear transform — managed by initPlanCardTilt
        });
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
// v6: SCROLL REVEAL via IntersectionObserver
// ==========================================
function initScrollAnimations() {
    const targets = document.querySelectorAll('[data-reveal]');
    if (!targets.length) return;

    const io = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('is-revealed');
                io.unobserve(entry.target);
            }
        });
    }, { threshold: 0.08, rootMargin: '0px 0px -24px 0px' });

    targets.forEach(el => io.observe(el));
}

// ==========================================
// v7: SPOTLIGHT — mouse-following radial gradient
// Uses CSS custom props (CSSOM, CSP-safe)
// ==========================================
function initSpotlight() {
    document.querySelectorAll('.plan-card').forEach(card => {
        card.addEventListener('mousemove', e => {
            const r = card.getBoundingClientRect();
            card.style.setProperty('--mx', `${(e.clientX - r.left).toFixed(0)}px`);
            card.style.setProperty('--my', `${(e.clientY - r.top).toFixed(0)}px`);
        }, { passive: true });
    });
}

// ==========================================
// v7: 3D CARD TILT — perspective + dynamic shadow
// ==========================================
function initPlanCardTilt() {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) { initDesktopHover(); return; }

    document.querySelectorAll('.plan-card').forEach(card => {
        const MAX        = 8;
        const isFeatured = card.classList.contains('featured');

        card.addEventListener('mousemove', e => {
            if (window.innerWidth < 768) return;
            const r   = card.getBoundingClientRect();
            const nx  = (e.clientX - r.left) / r.width  - 0.5;
            const ny  = (e.clientY - r.top)  / r.height - 0.5;
            const rx  = (-ny * MAX).toFixed(2);
            const ry  = ( nx * MAX).toFixed(2);
            const sc  = isFeatured ? 1.06 : 1.03;
            const dy  = (ny * 12).toFixed(0);

            card.style.transform =
                `perspective(1000px) rotateX(${rx}deg) rotateY(${ry}deg) ` +
                `translateY(-10px) scale(${sc})`;

            if (!isFeatured) {
                card.style.boxShadow =
                    `0 ${14 + Number(dy)}px 40px rgba(0,0,0,.4),` +
                    `0 0 0 1px rgba(16,185,129,.16)`;
            }
        }, { passive: true });

        card.addEventListener('mouseleave', () => {
            if (window.innerWidth < 768) return;
            card.style.transition = 'transform .5s cubic-bezier(.22,1,.36,1), box-shadow .4s ease';
            card.style.transform  = isFeatured ? 'scale(1.04) translateY(-4px)' : '';
            card.style.boxShadow  = '';
            setTimeout(() => { card.style.transition = ''; }, 550);
        }, { passive: true });
    });
}

// ==========================================
// v7: PRICE COUNTER — count up on first reveal
// ==========================================
function initPriceCounters() {
    const cards = document.querySelectorAll('.plan-card');
    const countered = new WeakSet();

    const io = new IntersectionObserver(entries => {
        entries.forEach(entry => {
            if (!entry.isIntersecting || countered.has(entry.target)) return;
            const amountEl = entry.target.querySelector('.amount');
            if (!amountEl) return;
            const target = parseInt(amountEl.textContent, 10);
            if (!target) return;
            countered.add(entry.target);
            const start = performance.now();
            const dur   = 700;
            function tick(now) {
                const p = Math.min((now - start) / dur, 1);
                const v = Math.round(p < 0.5
                    ? 4 * p * p * p
                    : 1 - Math.pow(-2 * p + 2, 3) / 2  // ease-in-out cubic
                    ) * target;
                amountEl.textContent = Math.round(p < 0.5
                    ? target * (4 * p * p * p)
                    : target * (1 - Math.pow(-2 * p + 2, 3) / 2));
                if (p < 1) requestAnimationFrame(tick);
                else amountEl.textContent = target;
            }
            requestAnimationFrame(tick);
        });
    }, { threshold: 0.3 });

    cards.forEach(c => io.observe(c));
}

// ==========================================
// v6: PARALLAX on hero background orbs
// ==========================================
function initParallax() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const orb1 = document.querySelector('.glow-orb-1');
    const orb2 = document.querySelector('.glow-orb-2');
    const orb3 = document.querySelector('.glow-orb-3');
    let ticking = false;

    window.addEventListener('scroll', () => {
        if (ticking) return;
        requestAnimationFrame(() => {
            const sy = window.scrollY;
            if (orb1) orb1.style.transform = `translateY(${(sy * 0.22).toFixed(1)}px)`;
            if (orb2) orb2.style.transform = `translateY(${(-sy * 0.16).toFixed(1)}px)`;
            if (orb3) orb3.style.transform = `translateY(${(sy * 0.10).toFixed(1)}px)`;
            ticking = false;
        });
        ticking = true;
    }, { passive: true });
}

// ==========================================
// SCROLL INICIAL — FEATURED CARD NO MOBILE
// Garante que o card "Casal" (featured) fique
// visível no centro ao carregar a página.
// ==========================================
function scrollToFeaturedCard() {
    if (window.innerWidth >= 768) return;
    const carousel = document.getElementById('plansCarousel');
    const featured = document.querySelector('.plan-card.featured');
    if (!carousel || !featured) return;
    // Scroll suave até o card featured
    const scrollLeft = featured.offsetLeft - (carousel.clientWidth - featured.offsetWidth) / 2;
    carousel.scrollLeft = Math.max(0, scrollLeft);
}

// ==========================================
// INITIALIZATION
// ==========================================
document.addEventListener('DOMContentLoaded', async () => {
    planCardsArray = Array.from(document.querySelectorAll('.plan-card'));
    totalSlides    = planCardsArray.length;

    SignupModal.init();
    bindCheckoutButtons();

    // v7: all new effects
    initSpotlight();
    initPlanCardTilt();
    initPriceCounters();
    initScrollAnimations();
    initParallax();

    setTimeout(() => {
        document.body.style.opacity = '1';
        scrollToFeaturedCard();
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