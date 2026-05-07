/**
 * GranaEvo — atualizarplano.js v4
 * Gerenciamento de assinatura Stripe mensal.
 */

import AuthGuard    from '../modules/auth-guard.js?v=2';
import { supabase } from '../services/supabase-client.js?v=2';

// ── Loading screen ────────────────────────────────────────────────
window.addEventListener('load', () => {
    const ls = document.getElementById('loadingScreen');
    if (ls) setTimeout(() => ls.classList.add('hidden'), 800);
});

const footerYearEl = document.getElementById('footerYear');
if (footerYearEl) footerYearEl.textContent = new Date().getFullYear();

// ── Header scroll ─────────────────────────────────────────────────
const header = document.getElementById('header');
window.addEventListener('scroll', () => {
    header?.classList.toggle('scrolled', window.scrollY > 10);
}, { passive: true });

// ── FAQ accordion ─────────────────────────────────────────────────
document.querySelectorAll('.faq-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const expanded = btn.getAttribute('aria-expanded') === 'true';
        const answerId = btn.getAttribute('aria-controls');
        const answer   = document.getElementById(answerId);
        btn.setAttribute('aria-expanded', String(!expanded));
        if (answer) answer.hidden = expanded;
    });
});

// ── 3D tilt on [data-tilt] elements ──────────────────────────────
function initTilt() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    document.querySelectorAll('[data-tilt]').forEach(el => {
        const MAX = 10;

        el.addEventListener('mousemove', e => {
            const r  = el.getBoundingClientRect();
            const x  = (e.clientX - r.left) / r.width  - 0.5;
            const y  = (e.clientY - r.top)  / r.height - 0.5;
            const rx = (-y * MAX).toFixed(2);
            const ry = ( x * MAX).toFixed(2);
            el.style.transform =
                `perspective(800px) rotateX(${rx}deg) rotateY(${ry}deg) scale3d(1.02,1.02,1.02)`;
        }, { passive: true });

        el.addEventListener('mouseleave', () => {
            el.style.transition = 'transform .45s cubic-bezier(.22,1,.36,1)';
            el.style.transform  = '';
            setTimeout(() => { el.style.transition = ''; }, 500);
        }, { passive: true });
    });
}

// Tilt on the 3D subscription card with a softer max
function initCardTilt() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const scene = document.getElementById('cardScene');
    const card  = document.getElementById('subCard');
    if (!scene || !card) return;

    const MAX = 14;

    scene.addEventListener('mousemove', e => {
        const r  = scene.getBoundingClientRect();
        const x  = (e.clientX - r.left) / r.width  - 0.5;
        const y  = (e.clientY - r.top)  / r.height - 0.5;
        const rx = (-y * MAX).toFixed(2);
        const ry = ( x * MAX).toFixed(2);
        card.style.transform =
            `rotateX(${rx}deg) rotateY(${ry}deg)`;
        card.style.boxShadow =
            `0 0 0 1px rgba(255,255,255,.2) inset,` +
            `0 ${8 + y * 12}px ${40 + Math.abs(y) * 40}px rgba(0,0,0,.6),` +
            `0 40px 80px rgba(67,97,238,.2)`;
    }, { passive: true });

    scene.addEventListener('mouseleave', () => {
        card.style.transition = 'transform .55s cubic-bezier(.22,1,.36,1), box-shadow .4s cubic-bezier(.22,1,.36,1)';
        card.style.transform  = '';
        card.style.boxShadow  = '';
        setTimeout(() => { card.style.transition = ''; }, 600);
    }, { passive: true });
}

initTilt();
initCardTilt();

// ── Helpers ───────────────────────────────────────────────────────
function formatDate(isoOrTs) {
    if (!isoOrTs) return '—';
    const d = typeof isoOrTs === 'number' ? new Date(isoOrTs * 1000) : new Date(isoOrTs);
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function normalizePlanName(raw) {
    const map = { individual: 'Individual', casal: 'Casal', familia: 'Família' };
    return map[(raw || '').toLowerCase()] || raw || '—';
}

// ── Auth + subscription load ──────────────────────────────────────
async function init() {
    const userData = await AuthGuard.protect({
        requirePlan:      true,
        allowGuest:       false,
        guestCanUpgrade:  false,
        redirectOnFail:   true,
        loadingElementId: 'authLoading',
    });

    if (!userData) return;

    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;

    await loadSubscription(session);
    setupPortalButton(session);
}

async function loadSubscription(session) {
    const userId    = session.user.id;
    const userEmail = (session.user.email || '').toLowerCase();

    try {
        let { data: sub } = await supabase
            .from('stripe_subscriptions')
            .select('plan_name, status, current_period_end, cancel_at_period_end, canceled_at')
            .eq('user_id', userId)
            .in('status', ['active', 'trialing', 'past_due', 'canceled'])
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();

        if (!sub && userEmail) {
            const { data: byEmail } = await supabase
                .from('stripe_subscriptions')
                .select('plan_name, status, current_period_end, cancel_at_period_end, canceled_at')
                .ilike('user_email', userEmail)
                .in('status', ['active', 'trialing', 'past_due', 'canceled'])
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle();
            sub = byEmail;
        }

        if (!sub) { renderNoSubscription(); return; }
        renderSubscription(sub);

    } catch (err) {
        console.error('[atualizarplano] Erro ao carregar assinatura:', err);
        _setBadge('badge-cancel', 'Erro ao carregar');
    }
}

// ── Render helpers ────────────────────────────────────────────────
function _setBadge(cls, text) {
    const badge   = document.getElementById('planStatusBadge');
    const badgeTxt = document.getElementById('planStatusText');
    if (badge)    badge.className = `status-badge ${cls}`;
    if (badgeTxt) badgeTxt.textContent = text;
}

function renderSubscription(sub) {
    const planNameEl      = document.getElementById('planName');
    const planTypeEl      = document.getElementById('planType');
    const nextBillingEl   = document.getElementById('nextBilling');
    const nextBillingWrap = document.getElementById('nextBillingWrap');
    const cancelWrap      = document.getElementById('cancelWrap');
    const cancelDateEl    = document.getElementById('cancelDate');

    const normalized = normalizePlanName(sub.plan_name);
    if (planNameEl) planNameEl.textContent = normalized;
    if (planTypeEl) planTypeEl.textContent = normalized;

    const statusMap = {
        active:   { text: 'Ativa',              cls: 'badge-active'  },
        trialing: { text: 'Teste gratuito',      cls: 'badge-trial'   },
        past_due: { text: 'Pgto. pendente',      cls: 'badge-warn'    },
        canceled: { text: 'Cancelada',           cls: 'badge-cancel'  },
    };
    const s = statusMap[sub.status] || { text: sub.status, cls: '' };

    if (sub.cancel_at_period_end && sub.status !== 'canceled') {
        _setBadge('badge-warn', 'Cancelamento agendado');
        if (nextBillingWrap) nextBillingWrap.hidden = true;
        if (cancelWrap)      cancelWrap.hidden      = false;
        if (cancelDateEl)    cancelDateEl.textContent = formatDate(sub.current_period_end);
    } else {
        _setBadge(s.cls, s.text);
        if (sub.status === 'canceled') {
            if (nextBillingWrap) nextBillingWrap.hidden = true;
        } else {
            if (nextBillingEl) nextBillingEl.textContent = formatDate(sub.current_period_end);
        }
    }
}

function renderNoSubscription() {
    _setBadge('badge-cancel', 'Não encontrada');
    const planNameEl = document.getElementById('planName');
    if (planNameEl) planNameEl.textContent = 'Sem assinatura';
}

// ── Portal Stripe ─────────────────────────────────────────────────
function setupPortalButton(session) {
    const btn     = document.getElementById('btnPortal');
    const btnText = document.getElementById('btnPortalText');
    if (!btn) return;

    btn.addEventListener('click', async () => {
        if (btn.disabled) return;
        btn.disabled = true;
        btn.setAttribute('aria-busy', 'true');
        if (btnText) btnText.textContent = 'Abrindo portal seguro...';

        try {
            const { data: { session: fresh } } = await supabase.auth.getSession();
            const token = fresh?.access_token || session.access_token;

            const resp = await fetch('/api/stripe', {
                method:  'POST',
                headers: {
                    'Content-Type':  'application/json',
                    'Authorization': `Bearer ${token}`,
                },
                body:   JSON.stringify({ action: 'portal' }),
                signal: AbortSignal.timeout(15_000),
            });

            if (!resp.ok) {
                const body = await resp.json().catch(() => ({}));
                throw new Error(body.error || `HTTP ${resp.status}`);
            }

            const { url } = await resp.json();
            if (!url) throw new Error('URL do portal não retornada pelo servidor.');

            window.location.href = url;

        } catch (err) {
            console.error('[atualizarplano] Erro no portal:', err);
            alert(`Não foi possível abrir o portal.\n\n${err.message}\n\nTente novamente em instantes.`);
            btn.disabled = false;
            btn.setAttribute('aria-busy', 'false');
            if (btnText) btnText.textContent = 'Abrir portal de gerenciamento';
        }
    });
}

// ── Start ─────────────────────────────────────────────────────────
init();
