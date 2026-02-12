// ==========================================
// GRANAEVO LANDING PAGE - JAVASCRIPT
// Ultra Professional & Interactive
// CARROSSEL OTIMIZADO V2.1
// ==========================================

// ==========================================
// LOADING SCREEN
// ==========================================
window.addEventListener('load', () => {
    const loadingScreen = document.getElementById('loadingScreen');
    setTimeout(() => {
        loadingScreen.classList.add('hidden');
    }, 1500);
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

    // Close menu when clicking on a link
    navLinks.querySelectorAll('a').forEach(link => {
        link.addEventListener('click', () => {
            mobileToggle.classList.remove('active');
            navLinks.classList.remove('active');
            document.body.style.overflow = '';
        });
    });

    // Close menu when clicking outside
    document.addEventListener('click', (e) => {
        if (!navLinks.contains(e.target) && !mobileToggle.contains(e.target)) {
            mobileToggle.classList.remove('active');
            navLinks.classList.remove('active');
            document.body.style.overflow = '';
        }
    });
}

// ==========================================
// MOBILE CTA FLOATING BUTTON
// ==========================================
const mobileCTA = document.getElementById('mobileCTA');

function handleMobileCTA() {
    if (window.innerWidth <= 768 && window.scrollY > 800) {
        mobileCTA.classList.add('visible');
    } else {
        mobileCTA.classList.remove('visible');
    }
}

window.addEventListener('scroll', handleMobileCTA, { passive: true });
window.addEventListener('resize', handleMobileCTA, { passive: true });

// ==========================================
// SMOOTH SCROLL FOR ANCHOR LINKS
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
// ANIMATED COUNTER
// ==========================================
function animateCounter(element, target, duration = 2000, decimals = 0) {
    const start = 0;
    const increment = target / (duration / 16);
    let current = start;
    
    const timer = setInterval(() => {
        current += increment;
        
        if (current >= target) {
            current = target;
            clearInterval(timer);
        }
        
        element.textContent = decimals > 0 
            ? current.toFixed(decimals) 
            : Math.floor(current).toLocaleString('pt-BR');
    }, 16);
}

// ==========================================
// INTERSECTION OBSERVER FOR ANIMATIONS
// ==========================================
const observerOptions = {
    threshold: 0.1,
    rootMargin: '0px 0px -50px 0px'
};

const fadeObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            entry.target.classList.add('active');
            
            // Animate counters when visible
            if (entry.target.classList.contains('hero-stats')) {
                const counters = entry.target.querySelectorAll('.stat-value');
                counters.forEach(counter => {
                    const target = parseFloat(counter.getAttribute('data-count'));
                    const decimals = target % 1 !== 0 ? 1 : 0;
                    animateCounter(counter, target, 2000, decimals);
                });
                fadeObserver.unobserve(entry.target);
            }
        }
    });
}, observerOptions);

// Observe elements for fade-in animation
const animatedElements = document.querySelectorAll(
    '.problem-card, .feature-card, .timeline-item, .hero-stats, .solution-box'
);

animatedElements.forEach((el, index) => {
    el.classList.add('reveal');
    el.style.transitionDelay = `${index * 0.1}s`;
    fadeObserver.observe(el);
});

// ==========================================
// PARTICLES CANVAS BACKGROUND
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

        // Draw connections
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
// TILT EFFECT ON CARDS
// ==========================================
const tiltElements = document.querySelectorAll('[data-tilt]');

tiltElements.forEach(element => {
    element.addEventListener('mousemove', (e) => {
        const rect = element.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        
        const centerX = rect.width / 2;
        const centerY = rect.height / 2;
        
        const rotateX = (y - centerY) / 20;
        const rotateY = (centerX - x) / 20;
        
        element.style.transform = `perspective(1000px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) scale3d(1.02, 1.02, 1.02)`;
    });
    
    element.addEventListener('mouseleave', () => {
        element.style.transform = 'perspective(1000px) rotateX(0) rotateY(0) scale3d(1, 1, 1)';
    });
});

// ==========================================
// PARALLAX EFFECT
// ==========================================
const parallaxElements = document.querySelectorAll('[data-parallax]');

function handleParallax() {
    const scrolled = window.scrollY;
    
    parallaxElements.forEach(element => {
        const speed = parseFloat(element.getAttribute('data-parallax')) || 0.5;
        const yPos = -(scrolled * speed);
        element.style.transform = `translateY(${yPos}px)`;
    });
}

window.addEventListener('scroll', handleParallax, { passive: true });

// ==========================================
// MINI CHART IN MOCKUP
// ==========================================
const miniChartCanvas = document.getElementById('miniChart');
if (miniChartCanvas) {
    const ctx = miniChartCanvas.getContext('2d');
    const width = miniChartCanvas.width = miniChartCanvas.offsetWidth * 2;
    const height = miniChartCanvas.height = miniChartCanvas.offsetHeight * 2;
    
    ctx.scale(2, 2);
    
    const data = [30, 45, 35, 50, 40, 60, 55, 70, 65, 80, 75, 85];
    const maxData = Math.max(...data);
    const padding = 10;
    const chartWidth = width / 2 - padding * 2;
    const chartHeight = height / 2 - padding * 2;
    
    // Draw gradient
    const gradient = ctx.createLinearGradient(0, padding, 0, chartHeight + padding);
    gradient.addColorStop(0, 'rgba(16, 185, 129, 0.3)');
    gradient.addColorStop(1, 'rgba(16, 185, 129, 0)');
    
    // Draw area
    ctx.beginPath();
    ctx.moveTo(padding, chartHeight + padding);
    
    data.forEach((value, index) => {
        const x = padding + (chartWidth / (data.length - 1)) * index;
        const y = chartHeight + padding - (value / maxData) * chartHeight;
        
        if (index === 0) {
            ctx.lineTo(x, y);
        } else {
            ctx.lineTo(x, y);
        }
    });
    
    ctx.lineTo(chartWidth + padding, chartHeight + padding);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();
    
    // Draw line
    ctx.beginPath();
    data.forEach((value, index) => {
        const x = padding + (chartWidth / (data.length - 1)) * index;
        const y = chartHeight + padding - (value / maxData) * chartHeight;
        
        if (index === 0) {
            ctx.moveTo(x, y);
        } else {
            ctx.lineTo(x, y);
        }
    });
    
    ctx.strokeStyle = '#10b981';
    ctx.lineWidth = 2;
    ctx.stroke();
}

// ==========================================
// TESTIMONIALS DATA & RENDER - OTIMIZADO
// ==========================================
const testimonials = [
    {
        stars: 5,
        text: "Finalmente consegui organizar minhas finanças! Em 3 meses eliminei minhas dívidas e criei uma reserva.",
        author: "Maria Silva"
    },
    {
        stars: 5,
        text: "Agora eu e minha esposa controlamos os gastos juntos. Acabaram as brigas por dinheiro!",
        author: "João Santos"
    },
    {
        stars: 5,
        text: "Super fácil de usar! Em 2 meses economizei mais de R$ 1.000 só por ter controle.",
        author: "Ana Costa"
    },
    {
        stars: 5,
        text: "O controle de cartão é sensacional! Nunca mais fui pego de surpresa pela fatura.",
        author: "Carlos Pereira"
    },
    {
        stars: 5,
        text: "Os gráficos são incríveis! Consigo ver exatamente para onde meu dinheiro vai.",
        author: "Patricia Oliveira"
    },
    {
        stars: 5,
        text: "Perfeito para quem tem família! Cada um tem seu perfil e vemos os gastos da casa.",
        author: "Roberto Lima"
    },
    {
        stars: 5,
        text: "As metas mudaram minha vida! Guardei R$ 5.000 para minha viagem dos sonhos.",
        author: "Juliana Martins"
    },
    {
        stars: 5,
        text: "Interface linda e intuitiva! Não preciso ser expert em finanças para usar.",
        author: "Fernando Souza"
    },
    {
        stars: 5,
        text: "O controle de parcelas é perfeito! Sei exatamente quanto vou pagar mês a mês.",
        author: "Camila Rocha"
    },
    {
        stars: 5,
        text: "Depois que comecei a usar, paguei todas as dívidas e estou investindo!",
        author: "Ricardo Alves"
    },
    {
        stars: 5,
        text: "Melhor decisão financeira! Consegui convencer toda minha família a usar.",
        author: "Beatriz Fernandes"
    },
    {
        stars: 5,
        text: "Simples e eficiente! Não preciso de planilhas complicadas.",
        author: "Thiago Mendes"
    }
];

function renderTestimonials() {
    const track = document.getElementById('testimonialsTrack');
    
    if (!track) return;
    
    track.innerHTML = '';
    
    // 🔥 TRIPLICAMOS o array para um scroll mais suave e contínuo
    const tripled = [...testimonials, ...testimonials, ...testimonials];
    
    tripled.forEach((testimonial, index) => {
        const card = document.createElement('div');
        card.className = 'testimonial-card';
        
        // Adiciona atributo de identificação para evitar duplicatas visuais
        card.setAttribute('data-index', index);
        
        const stars = '★'.repeat(testimonial.stars);
        
        card.innerHTML = `
            <div class="testimonial-stars">${stars}</div>
            <div class="testimonial-text">"${testimonial.text}"</div>
            <div class="testimonial-author">— ${testimonial.author}</div>
        `;
        
        track.appendChild(card);
    });
    
    // Log para debug
    console.log(`✓ Carrossel renderizado com ${tripled.length} cards (${testimonials.length} × 3)`);
}

// Renderiza os depoimentos ao carregar
renderTestimonials();

// ==========================================
// CARROSSEL: CONTROLE DE VELOCIDADE DINÂMICO
// ==========================================
function adjustCarouselSpeed() {
    const track = document.getElementById('testimonialsTrack');
    if (!track) return;
    
    const isMobile = window.innerWidth <= 768;
    
    // Velocidades otimizadas (em segundos)
    // Mobile: velocidade bem confortável para leitura tranquila
    // Desktop: velocidade balanceada
    const speed = isMobile ? 50 : 40;
    
    // Aplica a velocidade via CSS custom property
    track.style.animationDuration = `${speed}s`;
    
    console.log(`⚡ Velocidade do carrossel: ${speed}s (${isMobile ? 'Mobile' : 'Desktop'})`);
}

// Ajusta velocidade ao carregar e ao redimensionar
window.addEventListener('load', adjustCarouselSpeed);
window.addEventListener('resize', debounce(adjustCarouselSpeed, 250));

// ==========================================
// PERFORMANCE TRACKING
// ==========================================
window.addEventListener('load', () => {
    if (window.performance) {
        const perfData = window.performance.timing;
        const pageLoadTime = perfData.loadEventEnd - perfData.navigationStart;
        console.log(`⚡ Page loaded in ${pageLoadTime}ms`);
    }
});

// ==========================================
// PREVENT SCROLL RESTORATION
// ==========================================
if ('scrollRestoration' in history) {
    history.scrollRestoration = 'manual';
}

// ==========================================
// DEBOUNCE UTILITY
// ==========================================
function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

// Optimize resize events
const optimizedResize = debounce(() => {
    handleMobileCTA();
    adjustCarouselSpeed();
}, 250);

window.addEventListener('resize', optimizedResize);

// ==========================================
// PREFETCH IMPORTANT PAGES
// ==========================================
const plansLinks = document.querySelectorAll('a[href="planos.html"]');
plansLinks.forEach(link => {
    link.addEventListener('mouseenter', () => {
        const prefetch = document.createElement('link');
        prefetch.rel = 'prefetch';
        prefetch.href = 'planos.html';
        document.head.appendChild(prefetch);
    }, { once: true });
});

// ==========================================
// ACCESSIBILITY IMPROVEMENTS
// ==========================================
if (mobileToggle) {
    mobileToggle.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            mobileToggle.click();
        }
    });
}

if (navLinks) {
    navLinks.addEventListener('keydown', (e) => {
        if (!navLinks.classList.contains('active')) return;
        
        const focusableElements = navLinks.querySelectorAll(
            'a[href], button:not([disabled])'
        );
        const firstElement = focusableElements[0];
        const lastElement = focusableElements[focusableElements.length - 1];
        
        if (e.key === 'Tab') {
            if (e.shiftKey && document.activeElement === firstElement) {
                e.preventDefault();
                lastElement.focus();
            } else if (!e.shiftKey && document.activeElement === lastElement) {
                e.preventDefault();
                firstElement.focus();
            }
        }
        
        if (e.key === 'Escape') {
            mobileToggle.classList.remove('active');
            navLinks.classList.remove('active');
            document.body.style.overflow = '';
            mobileToggle.focus();
        }
    });
}

// ==========================================
// ONLINE/OFFLINE STATUS
// ==========================================
window.addEventListener('online', () => {
    console.log('✓ Connection restored');
});

window.addEventListener('offline', () => {
    console.warn('⚠ Connection lost');
});

// ==========================================
// CONSOLE BRANDING
// ==========================================
console.log(
    '%c🚀 GranaEvo Landing Page v2.1',
    'background: #10b981; color: white; padding: 12px 24px; border-radius: 8px; font-weight: bold; font-size: 16px;'
);
console.log(
    '%c✓ Carrossel otimizado ativo',
    'color: #10b981; font-weight: bold; font-size: 14px;'
);
console.log(
    '%c✓ Performance melhorada',
    'color: #10b981; font-weight: bold; font-size: 14px;'
);

// ==========================================
// INITIALIZATION COMPLETE
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
    console.log('✓ DOM loaded and interactive');
    console.log('✓ Testimonials carousel ready');
});