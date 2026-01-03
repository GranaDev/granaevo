import { supabase } from './supabase-client.js';

// ==========================================
// CAROUSEL DE PLANOS (MOBILE)
// ==========================================
let currentSlide = 1; // Começa no plano Casal (index 1)
const planCardsArray = Array.from(document.querySelectorAll('.plan-card'));
const totalSlides = planCardsArray.length;

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
    
    // Navegar para o slide inicial (Casal)
    goToSlide(currentSlide);
    
    // Event listeners dos botões
    if (prevBtn) {
        prevBtn.addEventListener('click', () => {
            currentSlide = (currentSlide - 1 + totalSlides) % totalSlides;
            goToSlide(currentSlide);
        });
    }
    
    if (nextBtn) {
        nextBtn.addEventListener('click', () => {
            currentSlide = (currentSlide + 1) % totalSlides;
            goToSlide(currentSlide);
        });
    }
    
    // Touch/Swipe support
    let touchStartX = 0;
    let touchEndX = 0;
    
    track.addEventListener('touchstart', (e) => {
        touchStartX = e.changedTouches[0].screenX;
    }, { passive: true });
    
    track.addEventListener('touchend', (e) => {
        touchEndX = e.changedTouches[0].screenX;
        handleSwipe();
    }, { passive: true });
    
    function handleSwipe() {
        const swipeThreshold = 50;
        const diff = touchStartX - touchEndX;
        
        if (Math.abs(diff) > swipeThreshold) {
            if (diff > 0) {
                // Swipe left - próximo
                currentSlide = (currentSlide + 1) % totalSlides;
            } else {
                // Swipe right - anterior
                currentSlide = (currentSlide - 1 + totalSlides) % totalSlides;
            }
            goToSlide(currentSlide);
        }
    }
}

function goToSlide(index) {
    const track = document.getElementById('plansTrack');
    const indicators = document.querySelectorAll('.indicator-dot');
    
    if (!track || window.innerWidth >= 768) return;
    
    currentSlide = index;
    
    // Atualizar transform
    const offset = -index * 100;
    track.style.transform = `translateX(${offset}%)`;
    
    // Atualizar indicadores
    indicators.forEach((dot, i) => {
        dot.classList.toggle('active', i === index);
    });
    
    // Atualizar cards - dar destaque ao ativo
    planCardsArray.forEach((card, i) => {
        if (i === index) {
            card.classList.add('active-slide');
        } else {
            card.classList.remove('active-slide');
        }
    });
}

// Inicializar carousel no load
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
// GRANAEVO PLANOS - JAVASCRIPT PREMIUM
// Microinterações e Conversão Otimizada
// ==========================================

// ==========================================
// CONFIGURAÇÕES
// ==========================================
const CONFIG = {
    purchaseNotification: {
        minInterval: 15000,  // 15 segundos
        maxInterval: 90000,  // 1.5 minutos
        duration: 5000       // 5 segundos de exibição
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
    }, 1000);
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
        scrollProgress.style.width = `${progress}%`;
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
        mobileToggle.classList.toggle('active');
        navLinks.classList.toggle('active');
        document.body.style.overflow = navLinks.classList.contains('active') ? 'hidden' : '';
    });

    navLinks.querySelectorAll('a').forEach(link => {
        link.addEventListener('click', () => {
            mobileToggle.classList.remove('active');
            navLinks.classList.remove('active');
            document.body.style.overflow = '';
        });
    });

    document.addEventListener('click', (e) => {
        if (!navLinks.contains(e.target) && !mobileToggle.contains(e.target)) {
            mobileToggle.classList.remove('active');
            navLinks.classList.remove('active');
            document.body.style.overflow = '';
        }
    });
}

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
    let particles = [];
    let animationId;

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
            ctx.fillStyle = `rgba(16, 185, 129, ${this.opacity})`;
            ctx.beginPath();
            ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    function init() {
        particles = [];
        const particleCount = window.innerWidth < 768 ? 50 : 100;
        
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

        particles.forEach((particleA, indexA) => {
            particles.slice(indexA + 1).forEach(particleB => {
                const dx = particleA.x - particleB.x;
                const dy = particleA.y - particleB.y;
                const distance = Math.sqrt(dx * dx + dy * dy);

                if (distance < 120) {
                    ctx.strokeStyle = `rgba(16, 185, 129, ${0.15 * (1 - distance / 120)})`;
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    ctx.moveTo(particleA.x, particleA.y);
                    ctx.lineTo(particleB.x, particleB.y);
                    ctx.stroke();
                }
            });
        });

        animationId = requestAnimationFrame(animate);
    }

    resizeCanvas();
    init();
    animate();

    window.addEventListener('resize', () => {
        resizeCanvas();
        init();
    });
}

// ==========================================
// PURCHASE NOTIFICATIONS
// ==========================================
function getRandomInterval() {
    const min = CONFIG.purchaseNotification.minInterval;
    const max = CONFIG.purchaseNotification.maxInterval;
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function getRandomName() {
    return CONFIG.names[Math.floor(Math.random() * CONFIG.names.length)];
}

function getRandomPlan() {
    return CONFIG.plans[Math.floor(Math.random() * CONFIG.plans.length)];
}

function showPurchaseNotification() {
    const notification = document.getElementById('purchaseNotification');
    const nameElement = notification.querySelector('.notification-name');
    const planElement = notification.querySelector('.notification-action strong');
    
    const name = getRandomName();
    const plan = getRandomPlan();
    
    nameElement.textContent = name;
    planElement.textContent = `plano ${plan}`;
    
    notification.classList.add('show');
    
    setTimeout(() => {
        notification.classList.remove('show');
    }, CONFIG.purchaseNotification.duration);
    
    const nextInterval = getRandomInterval();
    setTimeout(showPurchaseNotification, nextInterval + CONFIG.purchaseNotification.duration);
}

setTimeout(() => {
    showPurchaseNotification();
}, getRandomInterval());

// ==========================================
// PLAN CARDS HOVER EFFECT
// ==========================================
const planCards = document.querySelectorAll('.plan-card');

planCards.forEach(card => {
    card.addEventListener('mouseenter', function() {
        this.style.transform = 'translateY(-12px) scale(1.02)';
    });
    
    card.addEventListener('mouseleave', function() {
        if (!this.classList.contains('featured')) {
            this.style.transform = 'translateY(0) scale(1)';
        }
    });
});

// ==========================================
// BUTTON RIPPLE EFFECT
// ==========================================
const buttons = document.querySelectorAll('.btn-plan, .btn-primary');

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
            background: rgba(255, 255, 255, 0.4);
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
        
        faqItems.forEach(otherItem => {
            otherItem.classList.remove('active');
            const otherAnswer = otherItem.querySelector('.faq-answer');
            const otherIcon = otherItem.querySelector('.faq-question svg');
            otherAnswer.style.maxHeight = null;
            otherIcon.style.transform = 'rotate(0deg)';
        });
        
        if (!isActive) {
            item.classList.add('active');
            answer.style.maxHeight = answer.scrollHeight + 'px';
            icon.style.transform = 'rotate(180deg)';
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
    el.style.transitionDelay = `${index * 0.1}s`;
    fadeObserver.observe(el);
});

// ==========================================
// TRACK INTERACTIONS
// ==========================================
function trackEvent(category, action, label) {
    console.log(`Event: ${category} - ${action} - ${label}`);
    // Integrar com Google Analytics aqui
}

document.querySelectorAll('.btn-plan').forEach(btn => {
    btn.addEventListener('click', (e) => {
        const planCard = e.target.closest('.plan-card');
        const planName = planCard.dataset.plan;
        trackEvent('Plan', 'click', planName);
    });
});

// ==========================================
// PERFORMANCE
// ==========================================
window.addEventListener('load', () => {
    if (window.performance) {
        const perfData = window.performance.timing;
        const pageLoadTime = perfData.loadEventEnd - perfData.navigationStart;
        console.log(`⚡ Página carregada em ${pageLoadTime}ms`);
    }
});

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
    '%c✔ Sistema de conversão ativo',
    'color: #10b981; font-weight: bold; font-size: 14px;'
);

// ==========================================
// SCROLL TO PLANS
// ==========================================
const plansSection = document.querySelector('.plans-section');
if (plansSection) {
    plansSection.id = 'plans';
}

// ==========================================
// INITIALIZATION
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
    console.log('✔ DOM carregado');
    
    // Adicionar animação inicial aos cards
    setTimeout(() => {
        planCards.forEach((card, index) => {
            setTimeout(() => {
                card.style.opacity = '1';
                card.style.transform = 'translateY(0)';
            }, index * 100);
        });
    }, 500);
});

// ==========================================
// CHECKOUT - REDIRECIONAR PARA MERCADO PAGO
// ==========================================
async function iniciarCheckout(planName) {
    // Verificar se usuário está logado
    const { data: { session } } = await supabase.auth.getSession();
    
    if (!session) {
        // Se não estiver logado, mostrar popup para criar conta
        const confirmar = confirm(
            '⚠️ Você precisa criar uma conta primeiro.\n\n' +
            'Clique OK para se cadastrar ou Cancelar para fazer login.'
        );
        
        if (confirmar) {
            // Redirecionar para cadastro
            localStorage.setItem('plano_selecionado', planName);
            window.location.href = 'cadastro.html';
        } else {
            window.location.href = 'login.html';
        }
        return;
    }
    
    // Se já estiver logado, ir direto para checkout
    window.location.href = `checkout.html?plan=${planName}`;
}

window.iniciarCheckout = iniciarCheckout;