/* ==========================================
   GRANAEVO - TERMOS DE USO
   termos.js — Script externo seguro
   ========================================== */

'use strict';

/* ------------------------------------------
   1. LOADING SCREEN
   ------------------------------------------ */
window.addEventListener('load', () => {
    const loadingScreen = document.getElementById('loadingScreen');
    if (!loadingScreen) return;

    setTimeout(() => {
        loadingScreen.classList.add('hidden');
    }, 1000);
});


/* ------------------------------------------
   2. PARTICLES CANVAS
   ------------------------------------------ */
(function initParticles() {
    const canvas = document.getElementById('particlesCanvas');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let particles = [];
    let animationId = null;

    /* Resize com debounce para evitar CPU abuse */
    let resizeTimer = null;
    function onResize() {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            resizeCanvas();
            initParticleList();
        }, 150);
    }

    function resizeCanvas() {
        canvas.width = window.innerWidth;
        canvas.height = document.documentElement.scrollHeight;
    }

    function Particle() {
        this.x = Math.random() * canvas.width;
        this.y = Math.random() * canvas.height;
        this.size = Math.random() * 2 + 1;
        this.speedX = (Math.random() - 0.5) * 0.5;
        this.speedY = (Math.random() - 0.5) * 0.5;
        this.opacity = Math.random() * 0.5 + 0.2;
    }

    Particle.prototype.update = function () {
        this.x += this.speedX;
        this.y += this.speedY;

        if (this.x > canvas.width)  this.x = 0;
        if (this.x < 0)             this.x = canvas.width;
        if (this.y > canvas.height) this.y = 0;
        if (this.y < 0)             this.y = canvas.height;
    };

    Particle.prototype.draw = function () {
        ctx.fillStyle = 'rgba(16, 185, 129, ' + this.opacity + ')';
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
        ctx.fill();
    };

    function initParticleList() {
        particles = [];
        const count = window.innerWidth < 768 ? 30 : 60;
        for (let i = 0; i < count; i++) {
            particles.push(new Particle());
        }
    }

    function animate() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        for (let i = 0; i < particles.length; i++) {
            particles[i].update();
            particles[i].draw();
        }
        animationId = requestAnimationFrame(animate);
    }

    /* Init */
    resizeCanvas();
    initParticleList();
    animate();

    window.addEventListener('resize', onResize);

    /* Pausa animação quando aba fica invisível — economiza CPU */
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            cancelAnimationFrame(animationId);
        } else {
            animate();
        }
    });
}());


/* ------------------------------------------
   3. SMOOTH SCROLL PARA ÂNCORAS
   FIX: Validação do href antes de usar como seletor
   — Previne erros DOM e possível injeção futura
   ------------------------------------------ */
(function initSmoothScroll() {
    document.querySelectorAll('a[href^="#"]').forEach(function (anchor) {
        anchor.addEventListener('click', function (e) {
            const raw = this.getAttribute('href');

            /* Segurança: aceita apenas formato #id simples (letras, números, hífen, underscore) */
            if (!raw || !/^#[a-zA-Z0-9_-]+$/.test(raw)) return;

            const target = document.querySelector(raw);
            if (!target) return;

            e.preventDefault();
            target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
    });
}());