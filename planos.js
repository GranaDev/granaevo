import { supabase } from './supabase-client.js';

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
        'Patricia Oliveira', 'Roberto Lima', 'Juliana Martins',
        'Fernando Souza', 'Camila Rocha', 'Ricardo Alves',
        'Beatriz Fernandes', 'Thiago Mendes', 'Lucas Ribeiro',
        'Amanda Costa', 'Rafael Santos', 'Larissa Oliveira'
    ],
    plans: ['Individual', 'Casal', 'Família']
};

// ==========================================
// LOADING SCREEN
// ==========================================
window.addEventListener('load', () => {
    const loadingScreen = document.getElementById('loadingScreen');
    setTimeout(() => {
        loadingScreen.classList.add('hidden');
    }, 1200);
});

// ==========================================
// SCROLL PROGRESS BAR
// ==========================================
const scrollProgress = document.getElementById('scrollProgress');

function updateScrollProgress() {
    const windowHeight = window.innerHeight;
    const documentHeight = document.documentElement.scrollHeight - windowHeight;
    const scrolled = window.scrollY;
    const progress = (scrolled / documentHeight) * 100;
    
    if (scrollProgress) {
        scrollProgress.style.width = `${Math.min(progress, 100)}%`;
    }
}

window.addEventListener('scroll', updateScrollProgress, { passive: true });

// ==========================================
// HEADER SCROLL EFFECT
// ==========================================
const header = document.getElementById('header');
let lastScroll = 0;

function handleHeaderScroll() {
    const currentScroll = window.scrollY;
    
    if (currentScroll > 100) {
        header.classList.add('scrolled');
    } else {
        header.classList.remove('scrolled');
    }
    
    lastScroll = currentScroll;
}

window.addEventListener('scroll', handleHeaderScroll, { passive: true });

// ==========================================
// MOBILE MENU TOGGLE
// ==========================================
const mobileToggle = document.getElementById('mobileToggle');
const navLinks = document.getElementById('navLinks');

if (mobileToggle && navLinks) {
    mobileToggle.addEventListener('click', () => {
        const isActive = mobileToggle.classList.toggle('active');
        navLinks.classList.toggle('active');
        document.body.style.overflow = isActive ? 'hidden' : '';
        mobileToggle.setAttribute('aria-expanded', isActive);
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
// CAROUSEL DE PLANOS - OTIMIZADO
// ==========================================
let currentSlide = 1; // Começa no plano Casal (featured)
const planCardsArray = Array.from(document.querySelectorAll('.plan-card'));
const totalSlides = planCardsArray.length;
let isTransitioning = false;

function initCarousel() {
    const track = document.getElementById('plansTrack');
    const indicators = document.getElementById('carouselIndicators');
    const prevBtn = document.getElementById('prevBtn');
    const nextBtn = document.getElementById('nextBtn');
    
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
    
    // Touch/Swipe support - MELHORADO
    let touchStartX = 0;
    let touchEndX = 0;
    let touchStartY = 0;
    let touchEndY = 0;
    let isDragging = false;
    
    track.addEventListener('touchstart', (e) => {
        touchStartX = e.changedTouches[0].screenX;
        touchStartY = e.changedTouches[0].screenY;
        isDragging = true;
    }, { passive: true });
    
    track.addEventListener('touchmove', (e) => {
        if (!isDragging) return;
        
        touchEndX = e.changedTouches[0].screenX;
        touchEndY = e.changedTouches[0].screenY;
        
        const deltaX = touchStartX - touchEndX;
        const deltaY = touchStartY - touchEndY;
        
        // Previne scroll vertical se o swipe for mais horizontal
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
        
        // Só processa swipe se o movimento horizontal for maior que o vertical
        if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > swipeThreshold) {
            if (isTransitioning) return;
            
            if (deltaX > 0) {
                // Swipe left - próximo
                currentSlide = (currentSlide + 1) % totalSlides;
            } else {
                // Swipe right - anterior
                currentSlide = (currentSlide - 1 + totalSlides) % totalSlides;
            }
            goToSlide(currentSlide);
        }
    }
    
    // Keyboard navigation
    document.addEventListener('keydown', (e) => {
        if (window.innerWidth >= 768) return;
        
        if (e.key === 'ArrowLeft') {
            if (isTransitioning) return;
            currentSlide = (currentSlide - 1 + totalSlides) % totalSlides;
            goToSlide(currentSlide);
        } else if (e.key === 'ArrowRight') {
            if (isTransitioning) return;
            currentSlide = (currentSlide + 1) % totalSlides;
            goToSlide(currentSlide);
        }
    });
}

function goToSlide(index, animate = true) {
    const track = document.getElementById('plansTrack');
    const indicators = document.querySelectorAll('.indicator-dot');
    
    if (!track || window.innerWidth >= 768) return;
    
    isTransitioning = true;
    currentSlide = index;
    
    // Atualizar transform
    const offset = -index * 100;
    if (!animate) {
        track.style.transition = 'none';
    }
    track.style.transform = `translateX(${offset}%)`;
    
    // Restaurar transição
    if (!animate) {
        setTimeout(() => {
            track.style.transition = '';
        }, 50);
    }
    
    // Atualizar indicadores
    indicators.forEach((dot, i) => {
        dot.classList.toggle('active', i === index);
    });
    
    // Atualizar cards
    planCardsArray.forEach((card, i) => {
        card.classList.toggle('active-slide', i === index);
    });
    
    setTimeout(() => {
        isTransitioning = false;
    }, 500);
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
            // Resetar em desktop
            const track = document.getElementById('plansTrack');
            if (track) {
                track.style.transform = 'translateX(0)';
            }
            planCardsArray.forEach(card => {
                card.classList.remove('active-slide');
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
        
        if (href === '#' || href.length === 1) return;
        
        e.preventDefault();
        const target = document.querySelector(href);
        
        if (target) {
            const headerHeight = header.offsetHeight;
            const targetPosition = target.offsetTop - headerHeight - 20;
            
            window.scrollTo({
                top: targetPosition,
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
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
    }
    
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
    
    const particles = [];
    const particleCount = window.innerWidth < 768 ? 30 : 50;
    
    class Particle {
        constructor() {
            this.x = Math.random() * canvas.width;
            this.y = Math.random() * canvas.height;
            this.size = Math.random() * 2 + 1;
            this.speedX = Math.random() * 0.5 - 0.25;
            this.speedY = Math.random() * 0.5 - 0.25;
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
        
        particles.forEach(particle => {
            particle.update();
            particle.draw();
        });
        
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
    
    const nameElement = purchaseNotification.querySelector('.notification-name');
    const actionElement = purchaseNotification.querySelector('.notification-action strong');
    
    if (nameElement) nameElement.textContent = randomName;
    if (actionElement) actionElement.textContent = `Plano ${randomPlan}`;
    
    purchaseNotification.classList.add('show');
    
    setTimeout(() => {
        purchaseNotification.classList.remove('show');
    }, CONFIG.purchaseNotification.duration);
    
    const nextInterval = getRandomInterval();
    setTimeout(showPurchaseNotification, nextInterval + CONFIG.purchaseNotification.duration);
}

// Iniciar notificações
setTimeout(() => {
    showPurchaseNotification();
}, getRandomInterval());

// ==========================================
// PLAN CARDS HOVER EFFECT (DESKTOP)
// ==========================================
const planCards = document.querySelectorAll('.plan-card');

planCards.forEach(card => {
    if (window.innerWidth >= 768) {
        card.addEventListener('mouseenter', function() {
            if (!this.classList.contains('featured')) {
                this.style.transform = 'translateY(-8px) scale(1.02)';
            }
        });
        
        card.addEventListener('mouseleave', function() {
            if (!this.classList.contains('featured')) {
                this.style.transform = '';
            }
        });
    }
});

// ==========================================
// BUTTON RIPPLE EFFECT
// ==========================================
const buttons = document.querySelectorAll('.btn-plan, .btn-primary, .btn-nav');

buttons.forEach(button => {
    button.addEventListener('click', function(e) {
        const ripple = document.createElement('span');
        const rect = this.getBoundingClientRect();
        const size = Math.max(rect.width, rect.height);
        const x = e.clientX - rect.left - size / 2;
        const y = e.clientY - rect.top - size / 2;
        
        ripple.style.cssText = `
            position: absolute;
            width: ${size}px;
            height: ${size}px;
            border-radius: 50%;
            background: rgba(255, 255, 255, 0.3);
            left: ${x}px;
            top: ${y}px;
            pointer-events: none;
            animation: ripple 0.6s ease-out;
        `;
        
        this.style.position = 'relative';
        this.style.overflow = 'hidden';
        this.appendChild(ripple);
        
        setTimeout(() => ripple.remove(), 600);
    });
});

const rippleStyle = document.createElement('style');
rippleStyle.textContent = `
    @keyframes ripple {
        to {
            transform: scale(2.5);
            opacity: 0;
        }
    }
`;
document.head.appendChild(rippleStyle);

// ==========================================
// FAQ ACCORDION
// ==========================================
const faqItems = document.querySelectorAll('.faq-item');

faqItems.forEach(item => {
    const question = item.querySelector('.faq-question');
    const answer = item.querySelector('.faq-answer');
    const icon = question.querySelector('svg');
    
    question.addEventListener('click', () => {
        const isActive = item.classList.contains('active');
        
        // Fechar todos os outros
        faqItems.forEach(otherItem => {
            if (otherItem !== item) {
                otherItem.classList.remove('active');
                const otherAnswer = otherItem.querySelector('.faq-answer');
                const otherIcon = otherItem.querySelector('.faq-question svg');
                otherAnswer.style.maxHeight = null;
                otherIcon.style.transform = 'rotate(0deg)';
            }
        });
        
        // Toggle o atual
        if (!isActive) {
            item.classList.add('active');
            answer.style.maxHeight = answer.scrollHeight + 'px';
            icon.style.transform = 'rotate(180deg)';
        } else {
            item.classList.remove('active');
            answer.style.maxHeight = null;
            icon.style.transform = 'rotate(0deg)';
        }
    });
});

// ==========================================
// INTERSECTION OBSERVER
// ==========================================
const observerOptions = {
    threshold: 0.1,
    rootMargin: '0px 0px -50px 0px'
};

const fadeObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            entry.target.classList.add('visible');
        }
    });
}, observerOptions);

const animatedElements = document.querySelectorAll(
    '.plan-card, .benefit-card, .faq-item'
);

animatedElements.forEach((el, index) => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(20px)';
    el.style.transition = 'opacity 0.6s ease, transform 0.6s ease';
    el.style.transitionDelay = `${index * 0.1}s`;
    fadeObserver.observe(el);
});

// ==========================================
// CHECKOUT - REDIRECIONAR PARA CAKTO
// ==========================================
async function iniciarCheckout(planName) {
    const checkoutUrls = {
        'Individual': 'https://pay.cakto.com.br/figw38w_731973',
        'Casal': 'https://pay.cakto.com.br/rmq8b33_731974',
        'Família': 'https://pay.cakto.com.br/4x7ii5i_731976'
    };

    const checkoutUrl = checkoutUrls[planName];

    if (!checkoutUrl) {
        alert('Checkout ainda não configurado. Por favor, tente novamente mais tarde.');
        console.error('URL de checkout não encontrada para o plano:', planName);
        return;
    }

    // Tracking
    trackEvent('Plan', 'checkout_click', planName);
    
    // Redirecionar
    window.location.href = checkoutUrl;
}

window.iniciarCheckout = iniciarCheckout;

// ==========================================
// TRACK INTERACTIONS
// ==========================================
function trackEvent(category, action, label) {
    console.log(`📊 Event: ${category} - ${action} - ${label}`);
    
    // Google Analytics
    if (window.gtag) {
        gtag('event', action, {
            'event_category': category,
            'event_label': label
        });
    }
    
    // Facebook Pixel
    if (window.fbq) {
        fbq('track', action, {
            category: category,
            label: label
        });
    }
}

// Track plan clicks
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
window.addEventListener('load', () => {
    if (window.performance) {
        const perfData = window.performance.timing;
        const pageLoadTime = perfData.loadEventEnd - perfData.navigationStart;
        console.log(`⚡ Página carregada em ${pageLoadTime}ms`);
        
        // Track performance
        if (pageLoadTime > 3000) {
            console.warn('⚠️ Tempo de carregamento alto');
        }
    }
});

// Disable scroll restoration
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
        mobileToggle.classList.remove('active');
        navLinks.classList.remove('active');
        document.body.style.overflow = '';
        mobileToggle.setAttribute('aria-expanded', 'false');
    }
});

// ==========================================
// ONLINE/OFFLINE STATUS
// ==========================================
window.addEventListener('online', () => {
    console.log('✔ Conexão restaurada');
});

window.addEventListener('offline', () => {
    console.warn('⚠ Conexão perdida');
});

// ==========================================
// CONSOLE BRANDING
// ==========================================
console.log(
    '%c🚀 GranaEvo Planos',
    'background: #10b981; color: white; padding: 12px 24px; border-radius: 8px; font-weight: bold; font-size: 16px;'
);
console.log(
    '%c✔ Sistema Ultra Otimizado Ativo',
    'color: #10b981; font-weight: bold; font-size: 14px;'
);

// ==========================================
// INITIALIZATION
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
    console.log('✔ DOM carregado');
    
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
        // Descomentar quando tiver service worker
        // navigator.serviceWorker.register('/sw.js')
        //     .then(reg => console.log('✔ Service Worker registrado'))
        //     .catch(err => console.error('❌ Service Worker erro:', err));
    });
}