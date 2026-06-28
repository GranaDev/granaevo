/* ═══════════════════════════════════════════════════════════════
   GRANAEVO — LOGIN VISUAL
   Telefone 3D do lado esquerdo: inclinação pelo mouse + troca
   automática das telas (Dashboard → Cartões → Reservas → Relatórios)
   com nav, indicadores e legenda sincronizados.

   Puramente decorativo (financial-side é aria-hidden). Nenhuma
   manipulação de dados; sem innerHTML (compatível com Trusted Types).
   ═══════════════════════════════════════════════════════════════ */

(function initLoginVisual() {
    'use strict';

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // ───────────────────────────────────────────────────────────
    //  INCLINAÇÃO 3D — segue o mouse (igual à landing)
    // ───────────────────────────────────────────────────────────
    (function initPhoneTilt() {
        if (reduceMotion) return;

        const wrapper = document.getElementById('phone3DWrapper');
        const device  = document.getElementById('phone3DDevice');
        if (!wrapper || !device) return;

        const BASE_X = 8;    // ângulos base do keyframe phone-float-login
        const BASE_Y = -26;  // telefone mais de lado (ver login.css)
        const RANGE  = 11;   // desvio máximo, em graus

        let rafId = null;
        let targetX = BASE_X, targetY = BASE_Y;
        let currentX = BASE_X, currentY = BASE_Y;

        const lerp = (a, b, t) => a + (b - a) * t;

        function animate() {
            currentX = lerp(currentX, targetX, 0.08);
            currentY = lerp(currentY, targetY, 0.08);
            device.style.transform = `rotateX(${currentX.toFixed(2)}deg) rotateY(${currentY.toFixed(2)}deg)`;
            rafId = requestAnimationFrame(animate);
        }

        wrapper.addEventListener('mouseenter', () => {
            device.style.animation = 'none'; // pausa o float ao interagir
            animate();
        }, { passive: true });

        wrapper.addEventListener('mousemove', (e) => {
            const rect = wrapper.getBoundingClientRect();
            const nx = (e.clientX - rect.left) / rect.width  - 0.5;
            const ny = (e.clientY - rect.top)  / rect.height - 0.5;
            targetY = BASE_Y + nx * RANGE * 2;
            targetX = BASE_X - ny * RANGE;
        }, { passive: true });

        wrapper.addEventListener('mouseleave', () => {
            if (rafId) cancelAnimationFrame(rafId);
            rafId = null;
            device.style.animation = '';   // retoma o float
            device.style.transform = '';
            currentX = BASE_X; currentY = BASE_Y;
            targetX = BASE_X;  targetY = BASE_Y;
        }, { passive: true });
    }());

    // ───────────────────────────────────────────────────────────
    //  TROCA AUTOMÁTICA DAS TELAS
    // ───────────────────────────────────────────────────────────
    (function initScreenCycle() {
        const stack   = document.getElementById('phoneScreens');
        const wrapper = document.getElementById('phone3DWrapper');
        const caption = document.getElementById('phoneCaption');
        const dotsBox = document.getElementById('phoneDots');
        const navBox  = document.getElementById('phoneNav');
        if (!stack) return;

        const screens = Array.from(stack.querySelectorAll('.phone-screen'));
        const dots    = dotsBox ? Array.from(dotsBox.querySelectorAll('.phone-dot')) : [];
        const navItems = navBox ? Array.from(navBox.querySelectorAll('.pui-nav-it')) : [];
        if (screens.length < 2) return;

        const CAPTIONS = [
            'Sua vida financeira, num só lugar',
            'Todos os seus cartões sob controle',
            'Metas e reservas que crescem com você',
            'Relatórios automáticos e inteligentes',
        ];

        const INTERVAL = 4200;
        let index = 0;
        let timer = null;
        let paused = false;

        // Guarda o tamanho-alvo das barras p/ animá-las "crescendo" ao entrar.
        const bars = Array.from(stack.querySelectorAll('.pbar-fill, .prep-bar-fill'));
        bars.forEach((bar) => {
            const isV = bar.classList.contains('prep-bar-fill');
            bar.dataset.target = isV ? (bar.style.height || '0%') : (bar.style.width || '0%');
            bar.dataset.axis = isV ? 'height' : 'width';
        });

        function growBars(screen) {
            if (reduceMotion) return;
            screen.querySelectorAll('.pbar-fill, .prep-bar-fill').forEach((bar) => {
                const axis = bar.dataset.axis;
                const target = bar.dataset.target;
                if (!axis || !target) return;
                bar.style.transition = 'none';
                bar.style[axis] = '0%';
                // força reflow e então anima até o alvo
                void bar.offsetWidth;
                bar.style.transition = `${axis} 0.9s cubic-bezier(0.22, 1, 0.36, 1)`;
                bar.style[axis] = target;
            });
        }

        function show(next) {
            if (next === index) return;
            const current = screens[index];
            const target  = screens[next];

            current.classList.remove('is-active');
            current.classList.add('is-leaving');
            // limpa a marca de saída quando a transição relaxa
            window.setTimeout(() => current.classList.remove('is-leaving'), 600);

            target.classList.add('is-active');
            growBars(target);

            // indicadores
            dots.forEach((d, i) => d.classList.toggle('is-active', i === next));

            // bottom nav (data-nav casa com o índice da tela)
            navItems.forEach((it) => {
                it.classList.toggle('pui-nav-on', it.dataset.nav === String(next));
            });

            // legenda com fade
            if (caption && CAPTIONS[next]) {
                caption.classList.add('is-swapping');
                window.setTimeout(() => {
                    caption.textContent = CAPTIONS[next];
                    caption.classList.remove('is-swapping');
                }, 280);
            }

            index = next;
        }

        function tick() {
            if (paused) return;
            show((index + 1) % screens.length);
        }

        function start() {
            if (timer) return;
            timer = window.setInterval(tick, INTERVAL);
        }
        function stop() {
            if (timer) { window.clearInterval(timer); timer = null; }
        }

        // Pausa enquanto o usuário observa o telefone (mas o tilt continua)
        if (wrapper) {
            wrapper.addEventListener('mouseenter', () => { paused = true; }, { passive: true });
            wrapper.addEventListener('mouseleave', () => { paused = false; }, { passive: true });
        }

        // Clique nos indicadores → vai direto pra tela
        dots.forEach((dot, i) => {
            dot.addEventListener('click', () => { show(i); }, { passive: true });
        });

        // Economiza CPU quando a aba não está visível
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) stop(); else start();
        });

        growBars(screens[0]);
        start();
    }());
}());
