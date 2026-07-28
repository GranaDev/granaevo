// particulas.js — fundo animado do dashboard (decoração pura)  [O-1]
// ---------------------------------------------------------------------------
// POR QUE SAIU DO dashboard.js
//   O chunk de boot do dashboard vive no teto de 40 KB gzip. Isto aqui é
//   enfeite: 120 linhas de canvas que NÃO rodam em mobile nem para quem pediu
//   menos movimento — ou seja, boa parte dos usuários baixava o código para
//   descartá-lo no primeiro `if`.
//
//   Agora o módulo só desce quando as duas condições já foram satisfeitas
//   (desktop + sem prefers-reduced-motion), decididas ANTES do import.
//
// ZERO DEPENDÊNCIA DO ESTADO DO APP
//   Não lê transação, perfil, nem nada do dashboard. Toca um <canvas> e dois
//   listeners de window. Foi por isso que virou o primeiro candidato: extrair
//   não pode ter chance de quebrar dado do usuário.
// ---------------------------------------------------------------------------

class ParticleSystem {
    constructor() {
        this.canvas = document.getElementById('particles-canvas');
        if (!this.canvas) return;

        this.ctx          = this.canvas.getContext('2d');
        this.particles    = [];
        this.maxParticles = 50;
        this.mouse        = { x: null, y: null, radius: 150 };
        this._animFrameId = null;
        this._destroyed   = false;

        // Handlers nomeados para poder remover depois (sem memory leak)
        this._onResize    = () => this._handleResize();
        this._onMouseMove = (e) => this.handleMouse(e);

        this.resize();
        this.init();
        this.animate();

        window.addEventListener('resize',    this._onResize);
        window.addEventListener('mousemove', this._onMouseMove);
    }

    // Girar o celular para paisagem pode passar de 768px: se isso acontecer, o
    // módulo já está carregado e a animação simplesmente começa a valer.
    // O caminho inverso (voltar para retrato) limpa o canvas e para de desenhar.
    _handleResize() {
        if (window.innerWidth <= 768) {
            this.particles = [];
            if (this.ctx && this.canvas) {
                this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
            }
            return;
        }
        this.resize();
    }

    resize() {
        if (!this.canvas) return;
        this.canvas.width  = window.innerWidth;
        this.canvas.height = window.innerHeight;
    }

    init() {
        this.particles = [];
        for (let i = 0; i < this.maxParticles; i++) {
            this.particles.push(this._criarParticula());
        }
    }

    _criarParticula() {
        const w = this.canvas?.width  || window.innerWidth;
        const h = this.canvas?.height || window.innerHeight;
        return {
            x:      Math.random() * w,
            y:      Math.random() * h,
            vx:     (Math.random() - 0.5) * 0.5,
            vy:     (Math.random() - 0.5) * 0.5,
            radius: Math.random() * 2 + 1,
            alpha:  Math.random() * 0.4 + 0.1,
        };
    }

    handleMouse(e) {
        this.mouse.x = e.clientX;
        this.mouse.y = e.clientY;
    }

    _update() {
        if (!this.canvas) return;
        this.particles.forEach(p => {
            p.x += p.vx;
            p.y += p.vy;
            if (p.x < 0 || p.x > this.canvas.width)  p.vx *= -1;
            if (p.y < 0 || p.y > this.canvas.height)  p.vy *= -1;
        });
    }

    _draw() {
        if (!this.canvas || !this.ctx) return;
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.particles.forEach(p => {
            this.ctx.beginPath();
            this.ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
            this.ctx.fillStyle = `rgba(108, 99, 255, ${p.alpha})`;
            this.ctx.fill();
        });
    }

    animate() {
        if (this._destroyed) return;
        this._update();
        this._draw();
        this._animFrameId = requestAnimationFrame(() => this.animate());
    }

    /** Cleanup — evita memory leak se o sistema for destruído. */
    destroy() {
        this._destroyed = true;
        if (this._animFrameId) {
            cancelAnimationFrame(this._animFrameId);
            this._animFrameId = null;
        }
        window.removeEventListener('resize',    this._onResize);
        window.removeEventListener('mousemove', this._onMouseMove);
    }
}

let _instancia = null;

/**
 * Liga o fundo animado. Idempotente — chamar de novo não cria uma segunda
 * instância desenhando por cima da primeira.
 *
 * As guardas de desktop e de prefers-reduced-motion ficam em quem CHAMA
 * (dashboard.js), não aqui: o objetivo é não baixar o módulo, e uma checagem
 * dentro dele já seria tarde demais.
 */
export function iniciarParticulas() {
    if (_instancia) return _instancia;
    _instancia = new ParticleSystem();
    return _instancia;
}

/** Desliga e solta os listeners. */
export function pararParticulas() {
    _instancia?.destroy?.();
    _instancia = null;
}
