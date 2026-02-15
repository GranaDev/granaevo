// ==========================================
// GRANAEVO LANDING PAGE - JAVASCRIPT
// Ultra Otimizado - V3.0
// ==========================================

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
// MOBILE CTA FLOATING BUTTON
// ==========================================
const mobileCTA = document.getElementById('mobileCTA');

function handleMobileCTA() {
    if (window.innerWidth < 768 && window.scrollY > 800) {
        mobileCTA.classList.add('visible');
    } else {
        mobileCTA.classList.remove('visible');
    }
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
// HERO STATS COUNTER ANIMATION
// ==========================================
function animateCounter(element) {
    const target = parseFloat(element.getAttribute('data-count'));
    const duration = 2000;
    const increment = target / (duration / 16);
    let current = 0;
    
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

// Animate counters when visible
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
    miniChart.width = miniChart.offsetWidth;
    miniChart.height = miniChart.offsetHeight;
    
    const data = [20, 45, 30, 60, 40, 70, 50, 80, 65, 90];
    const max = Math.max(...data);
    const padding = 10;
    const width = miniChart.width;
    const height = miniChart.height;
    const stepX = (width - padding * 2) / (data.length - 1);
    
    ctx.strokeStyle = '#10b981';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    
    // Draw gradient
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, 'rgba(16, 185, 129, 0.2)');
    gradient.addColorStop(1, 'rgba(16, 185, 129, 0)');
    
    ctx.beginPath();
    ctx.moveTo(padding, height - padding);
    
    data.forEach((value, index) => {
        const x = padding + index * stepX;
        const y = height - padding - (value / max) * (height - padding * 2);
        
        if (index === 0) {
            ctx.moveTo(x, y);
        } else {
            ctx.lineTo(x, y);
        }
    });
    
    ctx.lineTo(width - padding, height - padding);
    ctx.lineTo(padding, height - padding);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();
    
    // Draw line
    ctx.beginPath();
    data.forEach((value, index) => {
        const x = padding + index * stepX;
        const y = height - padding - (value / max) * (height - padding * 2);
        
        if (index === 0) {
            ctx.moveTo(x, y);
        } else {
            ctx.lineTo(x, y);
        }
    });
    ctx.stroke();
}

// ==========================================
// TESTIMONIALS CAROUSEL
// ==========================================
const testimonialsTrack = document.getElementById('testimonialsTrack');

const testimonials = [
    {
        stars: '★★★★★',
        text: 'O GranaEvo mudou completamente minha relação com o dinheiro. Finalmente sei exatamente para onde vai cada centavo!',
        author: 'Maria Silva'
    },
    {
        stars: '★★★★★',
        text: 'Nunca mais fui pego de surpresa pela fatura do cartão. O controle é total e muito fácil de usar.',
        author: 'João Santos'
    },
    {
        stars: '★★★★★',
        text: 'Consegui economizar R$ 5.000 em 6 meses só organizando melhor meus gastos com o GranaEvo.',
        author: 'Ana Costa'
    },
    {
        stars: '★★★★★',
        text: 'Perfeito para casais! Agora eu e meu marido temos visão completa das nossas finanças juntos.',
        author: 'Patricia Oliveira'
    },
    {
        stars: '★★★★★',
        text: 'Interface super intuitiva. Até minha mãe de 65 anos conseguiu usar sem dificuldade!',
        author: 'Carlos Pereira'
    },
    {
        stars: '★★★★★',
        text: 'Vale cada centavo! O investimento se paga só na economia que você consegue fazer.',
        author: 'Roberto Lima'
    },
    {
        stars: '★★★★★',
        text: 'Tinha medo de apps financeiros, mas o GranaEvo é simples e seguro. Recomendo muito!',
        author: 'Juliana Martins'
    },
    {
        stars: '★★★★★',
        text: 'Os gráficos e relatórios me ajudaram a identificar gastos que eu nem sabia que tinha.',
        author: 'Fernando Souza'
    }
];

function createTestimonialCards() {
    if (!testimonialsTrack) return;
    
    // Duplicar para efeito infinito
    const allTestimonials = [...testimonials, ...testimonials];
    
    testimonialsTrack.innerHTML = allTestimonials.map(testimonial => `
        <div class="testimonial-card">
            <div class="testimonial-stars">${testimonial.stars}</div>
            <p class="testimonial-text">${testimonial.text}</p>
            <div class="testimonial-author">${testimonial.author}</div>
        </div>
    `).join('');
}

createTestimonialCards();

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
            entry.target.classList.add('active');
        }
    });
}, observerOptions);

const animatedElements = document.querySelectorAll(
    '.problem-card, .feature-card, .timeline-item'
);

animatedElements.forEach((el, index) => {
    el.classList.add('reveal');
    fadeObserver.observe(el);
});

// ==========================================
// PARALLAX EFFECT (DESKTOP)
// ==========================================
if (window.innerWidth >= 1024) {
    const parallaxElements = document.querySelectorAll('[data-parallax]');
    
    window.addEventListener('scroll', () => {
        const scrolled = window.scrollY;
        
        parallaxElements.forEach(element => {
            const speed = parseFloat(element.getAttribute('data-parallax'));
            const offset = scrolled * speed;
            element.style.transform = `translateY(${offset}px)`;
        });
    }, { passive: true });
}

// ==========================================
// TILT EFFECT (DESKTOP)
// ==========================================
if (window.innerWidth >= 1024) {
    const tiltElements = document.querySelectorAll('[data-tilt]');
    
    tiltElements.forEach(element => {
        element.addEventListener('mousemove', (e) => {
            const rect = element.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            
            const centerX = rect.width / 2;
            const centerY = rect.height / 2;
            
            const rotateX = (y - centerY) / 10;
            const rotateY = (centerX - x) / 10;
            
            element.style.transform = `perspective(1000px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) scale3d(1.02, 1.02, 1.02)`;
        });
        
        element.addEventListener('mouseleave', () => {
            element.style.transform = '';
        });
    });
}

// ==========================================
// BUTTON RIPPLE EFFECT
// ==========================================
const buttons = document.querySelectorAll('.btn-primary, .btn-secondary, .btn-nav, .btn-float');

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

// Track CTA clicks
document.querySelectorAll('.btn-primary').forEach(btn => {
    btn.addEventListener('click', () => {
        trackEvent('CTA', 'click', 'primary_button');
    });
});

document.querySelectorAll('.btn-secondary').forEach(btn => {
    btn.addEventListener('click', () => {
        trackEvent('CTA', 'click', 'secondary_button');
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
    '%c🚀 GranaEvo Landing Page',
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