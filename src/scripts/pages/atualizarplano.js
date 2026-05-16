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

// 3D tilt + dynamic glare on the subscription card
function initCardTilt() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const scene = document.getElementById('cardScene');
    const card  = document.getElementById('subCard');
    const glare = document.getElementById('cardGlare');
    if (!scene || !card) return;

    const MAX = 16;

    scene.addEventListener('mousemove', e => {
        const r   = scene.getBoundingClientRect();
        const nx  = (e.clientX - r.left) / r.width;   // 0–1
        const ny  = (e.clientY - r.top)  / r.height;  // 0–1
        const rx  = (-(ny - 0.5) * MAX).toFixed(2);
        const ry  = ( (nx - 0.5) * MAX).toFixed(2);

        card.style.transform = `rotateX(${rx}deg) rotateY(${ry}deg)`;

        // Dynamic glare — radial highlight that follows mouse position on card face
        if (glare) {
            glare.style.background =
                `radial-gradient(circle at ${(nx * 100).toFixed(1)}% ${(ny * 100).toFixed(1)}%, ` +
                `rgba(255,255,255,.14) 0%, rgba(110,231,183,.06) 35%, transparent 65%)`;
        }

        // Shadow shifts with tilt to simulate real light source
        const dy = (ny - 0.5) * 18;
        card.style.boxShadow =
            `0 1px 0 rgba(110,231,183,.22) inset,` +
            `0 -1px 0 rgba(0,0,0,.35) inset,` +
            `0 ${4 + dy}px 6px rgba(0,0,0,.45),` +
            `0 ${14 + dy * 1.2}px 30px rgba(0,0,0,.55),` +
            `0 ${32 + dy * 1.5}px 64px rgba(0,0,0,.4),` +
            `0 ${18 + dy}px 48px rgba(16,185,129,.18),` +
            `0 ${52 + dy * 2}px 100px rgba(16,185,129,.1)`;
    }, { passive: true });

    scene.addEventListener('mouseleave', () => {
        card.style.transition =
            'transform .6s cubic-bezier(.22,1,.36,1), box-shadow .5s cubic-bezier(.22,1,.36,1)';
        card.style.transform  = '';
        card.style.boxShadow  = '';
        if (glare) glare.style.background = '';
        setTimeout(() => { card.style.transition = ''; }, 650);
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

function formatDateLong(isoOrTs) {
    if (!isoOrTs) return '—';
    const d = typeof isoOrTs === 'number' ? new Date(isoOrTs * 1000) : new Date(isoOrTs);
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
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

    // Load basic info from Supabase immediately, then enrich with Stripe data
    await loadSubscription(session);
    setupPortalButton(session);
    setupPlanChangeCard(session);
    loadStripeDetails(session); // async, enriches UI when ready
}

const _FIELDS = 'plan_name, status, current_period_start, current_period_end, cancel_at_period_end, canceled_at, created_at, pending_plan_name, pending_plan_effective_at';

async function loadSubscription(session) {
    const userId    = session.user.id;
    const userEmail = (session.user.email || '').toLowerCase();

    try {
        let { data: sub } = await supabase
            .from('stripe_subscriptions')
            .select(_FIELDS)
            .eq('user_id', userId)
            .in('status', ['active', 'trialing', 'past_due', 'canceled'])
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();

        if (!sub && userEmail) {
            const { data: byEmail } = await supabase
                .from('stripe_subscriptions')
                .select(_FIELDS)
                .ilike('user_email', userEmail)
                .in('status', ['active', 'trialing', 'past_due', 'canceled'])
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle();
            sub = byEmail;
        }

        if (!sub) { renderNoSubscription(); return; }
        renderSubscription(sub);
        renderDetails(sub);
        _checkCancellationNotification(sub);

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
    _currentPlanSlug           = (sub.plan_name || '').toLowerCase().trim();
    _currentPendingPlan        = (sub.pending_plan_name || '').toLowerCase().trim();
    _currentPendingEffectiveAt = sub.pending_plan_effective_at || null;

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

// ── Detail cards section ──────────────────────────────────────────
function _makeCard(label, value, cls) {
    const card = document.createElement('div');
    card.className = 'detail-card' + (cls ? ' ' + cls : '');

    const lEl = document.createElement('span');
    lEl.className = 'dc-label';
    lEl.textContent = label;

    const vEl = document.createElement('span');
    vEl.className = 'dc-value';
    vEl.textContent = value;

    card.append(lEl, vEl);
    return card;
}

function _makePeriodCard(label, start, end) {
    const card = document.createElement('div');
    card.className = 'detail-card';

    const lEl = document.createElement('span');
    lEl.className = 'dc-label';
    lEl.textContent = label;

    const vEl = document.createElement('span');
    vEl.className = 'dc-value dc-period';

    const s = document.createElement('span'); s.textContent = start;
    const sep = document.createElement('span'); sep.className = 'dc-sep'; sep.textContent = '→';
    const e = document.createElement('span'); e.textContent = end;
    vEl.append(s, sep, e);

    card.append(lEl, vEl);
    return card;
}

function renderDetails(sub) {
    const section = document.getElementById('detailsSection');
    const grid    = document.getElementById('detailsGrid');
    if (!section || !grid) return;

    grid.innerHTML = '';

    const normalized = normalizePlanName(sub.plan_name);
    const isCancelling = sub.cancel_at_period_end && sub.status !== 'canceled';
    const isCanceled   = sub.status === 'canceled';
    const isPastDue    = sub.status === 'past_due';
    const isTrial      = sub.status === 'trialing';
    const isActive     = sub.status === 'active';

    // ── Card 1: Status ────────────────────────────────────────────
    const statusMap = {
        active:   { label: 'Ativa',              cls: 'ds-green' },
        trialing: { label: 'Teste gratuito',      cls: 'ds-blue'  },
        past_due: { label: 'Pagamento pendente',  cls: 'ds-amber' },
        canceled: { label: 'Encerrada',           cls: 'ds-red'   },
    };
    const sm = statusMap[sub.status] || { label: sub.status, cls: '' };
    const statusLabel = isCancelling ? 'Cancelamento agendado' : sm.label;
    const statusCls   = isCancelling ? 'ds-amber' : sm.cls;
    grid.appendChild(_makeCard('Status', statusLabel, statusCls));

    // ── Card 2: Plano ─────────────────────────────────────────────
    grid.appendChild(_makeCard('Plano', normalized));

    // ── Card 3: Ciclo de cobrança ─────────────────────────────────
    grid.appendChild(_makeCard('Ciclo de cobrança', 'Mensal'));

    // ── Card 4: Período atual (start → end) ───────────────────────
    const periodStart = sub.current_period_start ? formatDate(sub.current_period_start) : '—';
    const periodEnd   = sub.current_period_end   ? formatDate(sub.current_period_end)   : '—';
    grid.appendChild(_makePeriodCard('Período atual', periodStart, periodEnd));

    // ── Card 5: Próxima cobrança / Acesso válido até ──────────────
    let billingLabel, billingValue, billingCls;
    if (isCancelling) {
        billingLabel = 'Acesso válido até';
        billingValue = periodEnd;
        billingCls   = 'ds-amber';
    } else if (isCanceled) {
        billingLabel = 'Acesso válido até';
        billingValue = periodEnd;
        billingCls   = 'ds-red';
    } else if (isPastDue) {
        billingLabel = 'Venceu em';
        billingValue = periodEnd;
        billingCls   = 'ds-amber';
    } else if (isTrial) {
        billingLabel = 'Teste gratuito até';
        billingValue = periodEnd;
        billingCls   = 'ds-blue';
    } else {
        billingLabel = 'Próxima cobrança';
        billingValue = isActive ? periodEnd : '—';
        billingCls   = '';
    }
    grid.appendChild(_makeCard(billingLabel, billingValue, billingCls));

    // ── Card 6: Membro desde ──────────────────────────────────────
    grid.appendChild(_makeCard('Membro desde', formatDateLong(sub.created_at)));

    section.hidden = false;
}

// ── Stripe real-time details (subscription + invoices) ───────────
function formatCurrency(amountCents, currency = 'brl') {
    return new Intl.NumberFormat('pt-BR', {
        style: 'currency', currency: currency.toUpperCase(),
        minimumFractionDigits: 2,
    }).format(amountCents / 100);
}

function _showInvoiceSkeleton() {
    const list = document.getElementById('invoicesList');
    const sec  = document.getElementById('invoicesSection');
    if (!list || !sec) return;
    list.innerHTML = '';
    for (let i = 0; i < 3; i++) {
        const row = document.createElement('div');
        row.className = 'inv-skeleton';
        const b1 = document.createElement('div');
        b1.className = 'skel-bar'; b1.style.width = '140px'; b1.style.height = '14px';
        const b2 = document.createElement('div');
        b2.className = 'skel-bar'; b2.style.width = '80px'; b2.style.height = '14px';
        b2.style.marginLeft = 'auto';
        row.append(b1, b2);
        list.appendChild(row);
    }
    sec.hidden = false;
}

async function loadStripeDetails(session) {
    _showInvoiceSkeleton();

    try {
        const { data: { session: fresh } } = await supabase.auth.getSession();
        const token = fresh?.access_token || session.access_token;

        const resp = await fetch('/api/stripe', {
            method: 'POST',
            headers: {
                'Content-Type':  'application/json',
                'Authorization': `Bearer ${token}`,
            },
            body:   JSON.stringify({ action: 'details' }),
            signal: AbortSignal.timeout(20_000),
        });

        if (!resp.ok) {
            console.warn('[atualizarplano] details HTTP', resp.status);
            _renderInvoiceEmpty();
            return;
        }

        const { subscription, invoices } = await resp.json();

        // Update "Membro desde" with real Stripe date
        _updateMemberSince(subscription);

        // Update price card if available
        _updatePriceCard(subscription);

        // Render invoice list
        _renderInvoices(invoices || []);

        // Notificação de cancelamento via Stripe direto (sem depender do webhook)
        if (subscription) _checkCancellationNotification(subscription);

    } catch (err) {
        console.error('[atualizarplano] Erro ao buscar detalhes Stripe:', err);
        _renderInvoiceEmpty();
    }
}

function _updateMemberSince(subscription) {
    if (!subscription) return;
    // Use start_date (first invoice date) or created, whichever is earlier
    const ts = subscription.start_date || subscription.created;
    if (!ts) return;
    // Find "Membro desde" card and update its value
    document.querySelectorAll('.detail-card').forEach(card => {
        const label = card.querySelector('.dc-label');
        const value = card.querySelector('.dc-value');
        if (label?.textContent === 'Membro desde' && value) {
            value.textContent = formatDateLong(ts);
        }
    });
}

function _updatePriceCard(subscription) {
    if (!subscription?.price?.unit_amount) return;
    const amount   = formatCurrency(subscription.price.unit_amount, subscription.price.currency || 'brl');
    const interval = subscription.price.interval === 'month' ? 'mês' : subscription.price.interval;
    // Update Ciclo card to show the actual price
    document.querySelectorAll('.detail-card').forEach(card => {
        const label = card.querySelector('.dc-label');
        const value = card.querySelector('.dc-value');
        if (label?.textContent === 'Ciclo de cobrança' && value) {
            value.textContent = `${amount} / ${interval}`;
        }
    });
}

function _renderInvoices(invoices) {
    const list = document.getElementById('invoicesList');
    const sec  = document.getElementById('invoicesSection');
    if (!list) return;
    list.innerHTML = '';

    if (!invoices.length) { _renderInvoiceEmpty(); return; }

    const statusMap = {
        paid:          { label: 'Pago',      cls: 'inv-paid'   },
        open:          { label: 'Pendente',  cls: 'inv-open'   },
        uncollectible: { label: 'Falhou',    cls: 'inv-failed' },
        void:          { label: 'Cancelada', cls: 'inv-failed' },
    };

    for (const inv of invoices) {
        const sm = statusMap[inv.status] || { label: inv.status, cls: '' };

        const row = document.createElement('div');
        row.className = 'inv-row';

        // Left: date + period
        const left = document.createElement('div');
        left.className = 'inv-left';

        const dateEl = document.createElement('span');
        dateEl.className = 'inv-date';
        dateEl.textContent = inv.number
            ? `${formatDate(inv.created)} · ${inv.number}`
            : formatDate(inv.created);
        left.appendChild(dateEl);

        if (inv.period_start && inv.period_end) {
            const period = document.createElement('span');
            period.className = 'inv-period';
            const s = document.createElement('span'); s.textContent = formatDate(inv.period_start);
            const sep = document.createElement('span'); sep.className = 'inv-period-sep'; sep.textContent = '→';
            const e = document.createElement('span'); e.textContent = formatDate(inv.period_end);
            period.append(s, sep, e);
            left.appendChild(period);
        }

        row.appendChild(left);

        // Amount
        const amtEl = document.createElement('span');
        amtEl.className = 'inv-amount';
        const paid = inv.amount_paid > 0 ? inv.amount_paid : inv.amount_due;
        amtEl.textContent = formatCurrency(paid || 0, inv.currency || 'brl');
        row.appendChild(amtEl);

        // Status badge
        const badge = document.createElement('span');
        badge.className = `inv-badge ${sm.cls}`;
        badge.textContent = sm.label;
        row.appendChild(badge);

        // PDF link
        const pdfUrl = inv.invoice_pdf || inv.hosted_invoice_url;
        if (pdfUrl) {
            const a = document.createElement('a');
            a.className = 'inv-pdf';
            a.href    = pdfUrl;
            a.target  = '_blank';
            a.rel     = 'noopener noreferrer';
            a.setAttribute('aria-label', `Baixar fatura ${inv.number || formatDate(inv.created)}`);
            a.innerHTML = `<svg viewBox="0 0 16 16" fill="none"><path d="M3 12l2-2m0 0l3 3 5-7M5 10V4M3 14h10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
            row.appendChild(a);
        } else {
            const placeholder = document.createElement('div');
            placeholder.style.width = '34px';
            row.appendChild(placeholder);
        }

        list.appendChild(row);
    }

    if (sec) sec.hidden = false;
}

function _renderInvoiceEmpty() {
    const list = document.getElementById('invoicesList');
    const sec  = document.getElementById('invoicesSection');
    if (!list) return;
    list.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'inv-empty';
    empty.textContent = 'Nenhuma fatura encontrada.';
    list.appendChild(empty);
    if (sec) sec.hidden = false;
}

// ── Notificação de cancelamento ───────────────────────────────────
// sub pode vir do banco (ISO string) ou do Stripe direto (Unix timestamp em segundos)
function _checkCancellationNotification(sub) {
    if (!sub) return
    const isCancelling = sub.cancel_at_period_end && sub.status !== 'canceled'
    const isCanceled   = sub.status === 'canceled'
    if (!isCancelling && !isCanceled) return

    // Converte Unix timestamp (Stripe) ou ISO string (banco) para Date
    const rawEnd = sub.current_period_end
    let periodEndDate = null
    if (rawEnd) {
        periodEndDate = typeof rawEnd === 'number'
            ? new Date(rawEnd * 1000)   // Stripe retorna segundos
            : new Date(rawEnd)          // Supabase retorna ISO string
    }

    const periodEndFmt = periodEndDate
        ? periodEndDate.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' })
        : null

    // Chave única por estado + data de vencimento — evita mostrar mais de uma vez
    const storageKey = `ge_cancel_notif_${sub.status}_${periodEndDate?.toISOString().slice(0, 10) ?? 'nd'}`
    if (localStorage.getItem(storageKey)) return
    localStorage.setItem(storageKey, '1')

    const msg = isCancelling
        ? `Cancelamento agendado — acesso garantido até ${periodEndFmt ?? 'o fim do ciclo'}.`
        : `Assinatura encerrada${periodEndFmt ? ` em ${periodEndFmt}` : ''}.`

    _showToast(msg, isCanceled ? 'error' : 'warning')
}

function _showToast(msg, type = 'info') {
    const colors = {
        info:    'linear-gradient(135deg,#1e3a5f,#1e4080)',
        success: 'linear-gradient(135deg,#064e35,#065f46)',
        warning: 'linear-gradient(135deg,#78350f,#92400e)',
        error:   'linear-gradient(135deg,#7f1d1d,#991b1b)',
    }
    const el = document.createElement('div')
    el.style.cssText = [
        'position:fixed', 'bottom:24px', 'right:24px', 'z-index:9999',
        'max-width:380px', 'padding:14px 20px', 'border-radius:12px',
        `background:${colors[type] ?? colors.info}`,
        'color:#f1f5f9', 'font-size:14px', 'font-weight:500',
        'box-shadow:0 8px 32px rgba(0,0,0,0.5)',
        'border:1px solid rgba(255,255,255,0.1)',
        'line-height:1.5', 'transition:opacity .3s ease',
    ].join(';')
    el.textContent = msg
    document.body.appendChild(el)
    setTimeout(() => {
        el.style.opacity = '0'
        setTimeout(() => el.remove(), 320)
    }, 5000)
}

// ── Modal alterar plano ───────────────────────────────────────────
let _currentPlanSlug             = ''
let _currentPendingPlan          = ''
let _currentPendingEffectiveAt   = null

// ── Helpers do modal ──────────────────────────────────────────────
function _fmtMoney(cents, currency = 'brl') {
    return new Intl.NumberFormat('pt-BR', {
        style: 'currency', currency: currency.toUpperCase(),
        minimumFractionDigits: 2,
    }).format(cents / 100)
}

function _fmtDateFromTs(unixTs) {
    if (!unixTs) return '—'
    return new Date(unixTs * 1000).toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' })
}

function _fmtDateFromISO(iso) {
    if (!iso) return '—'
    return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' })
}

function _planLabel(slug) {
    return { individual: 'Individual', casal: 'Casal', familia: 'Família' }[slug] || slug
}

// ── Modal principal de alteração de plano ─────────────────────────
function _openPlanModal(session) {
    const overlay = document.createElement('div')
    overlay.id = 'planModalOverlay'
    overlay.style.cssText = [
        'position:fixed', 'inset:0', 'z-index:10000',
        'background:rgba(6,8,16,0.88)', 'backdrop-filter:blur(8px)',
        'display:flex', 'align-items:center', 'justify-content:center',
        'padding:16px',
    ].join(';')

    const modal = document.createElement('div')
    modal.style.cssText = [
        'background:linear-gradient(160deg,#0d1117 0%,#111827 100%)',
        'border:1px solid rgba(16,185,129,0.2)', 'border-radius:20px',
        'padding:32px', 'max-width:540px', 'width:100%',
        'box-shadow:0 32px 80px rgba(0,0,0,0.8)',
        'max-height:92vh', 'overflow-y:auto',
    ].join(';')

    const plans = [
        {
            slug:    'individual',
            label:   'Individual',
            price:   1999,
            tagline: '1 perfil',
            desc:    'Para uso pessoal — controle total das suas finanças.',
            icon:    `<svg viewBox="0 0 24 24" fill="none" style="width:20px;height:20px;flex-shrink:0;"><circle cx="12" cy="8" r="4" stroke="currentColor" stroke-width="1.8"/><path d="M6 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
        },
        {
            slug:    'casal',
            label:   'Casal',
            price:   3499,
            tagline: '2 perfis',
            desc:    'Finanças compartilhadas com privacidade para o casal.',
            icon:    `<svg viewBox="0 0 24 24" fill="none" style="width:20px;height:20px;flex-shrink:0;"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="9" cy="7" r="4" stroke="currentColor" stroke-width="1.8"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
        },
        {
            slug:    'familia',
            label:   'Família',
            price:   5499,
            tagline: 'Até 5 perfis',
            desc:    'Visão consolidada de toda a família em um só lugar.',
            icon:    `<svg viewBox="0 0 24 24" fill="none" style="width:20px;height:20px;flex-shrink:0;"><circle cx="9" cy="7" r="4" stroke="currentColor" stroke-width="1.8"/><path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2M16 3.13a4 4 0 0 1 0 7.75M21 21v-2a4 4 0 0 0-3-3.85" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
        },
    ]

    // Aviso de downgrade agendado (se houver)
    const pendingNoticeHtml = _currentPendingPlan
        ? `<div style="background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.3);border-radius:12px;padding:14px 16px;margin-bottom:20px;display:flex;gap:10px;align-items:flex-start;">
            <span style="font-size:18px;flex-shrink:0;">⏳</span>
            <div>
              <div style="font-size:13px;font-weight:700;color:#fbbf24;margin-bottom:3px;">Alteração agendada</div>
              <div style="font-size:13px;color:#94a3b8;line-height:1.5;">
                Seu plano será alterado para <strong style="color:#f1f5f9;">${_planLabel(_currentPendingPlan)}</strong>
                em <strong style="color:#f1f5f9;">${_fmtDateFromISO(_currentPendingEffectiveAt)}</strong>.
                Você continua com acesso ao plano atual até essa data.
              </div>
            </div>
          </div>`
        : ''

    modal.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
        <h2 style="font-size:20px;font-weight:800;color:#f1f5f9;letter-spacing:-0.3px;margin:0;">Alterar Plano</h2>
        <button id="planModalClose" style="background:none;border:none;color:#64748b;cursor:pointer;font-size:20px;padding:4px 8px;border-radius:6px;line-height:1;" aria-label="Fechar">✕</button>
      </div>
      ${pendingNoticeHtml}
      <div id="planOptionsList" style="display:flex;flex-direction:column;gap:10px;margin-bottom:20px;"></div>
      <div id="planPreviewBox" style="display:none;border-radius:12px;padding:16px 18px;margin-bottom:20px;"></div>
      <div style="display:flex;gap:12px;">
        <button id="planModalCancel" style="flex:1;padding:13px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:10px;color:#94a3b8;font-size:14px;font-weight:600;cursor:pointer;">Cancelar</button>
        <button id="planModalConfirm" style="flex:2;padding:13px;background:linear-gradient(135deg,#10b981,#059669);border:none;border-radius:10px;color:#fff;font-size:14px;font-weight:700;cursor:pointer;opacity:0.4;transition:opacity .2s;" disabled>Selecione um plano</button>
      </div>
      <p id="planModalError" style="margin-top:12px;font-size:13px;color:#f87171;text-align:center;display:none;"></p>
    `

    const list        = modal.querySelector('#planOptionsList')
    const previewBox  = modal.querySelector('#planPreviewBox')
    const confirmBtn  = modal.querySelector('#planModalConfirm')
    const cancelBtn   = modal.querySelector('#planModalCancel')
    const errorEl     = modal.querySelector('#planModalError')

    let selectedPlan   = ''
    let previewData    = null
    let previewLoading = false

    // ── Renderiza o preview de valor ──────────────────────────────
    function _renderPreview(data) {
        previewData = data
        previewBox.innerHTML = ''
        previewBox.style.display = 'block'

        if (data.type === 'upgrade') {
            const amountDue = data.amountDue ?? 0
            const newMonthly = data.newPlanUnitAmount ?? 0
            const currency   = data.currency ?? 'brl'
            const renewal    = _fmtDateFromTs(data.periodEnd)

            previewBox.style.background = 'rgba(16,185,129,0.06)'
            previewBox.style.border     = '1px solid rgba(16,185,129,0.25)'
            previewBox.innerHTML = `
              <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:#10b981;margin-bottom:10px;">Resumo do upgrade</div>
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                <span style="font-size:13px;color:#94a3b8;">Cobrado agora (proporcional):</span>
                <span style="font-size:16px;font-weight:800;color:#f1f5f9;">${_fmtMoney(amountDue, currency)}</span>
              </div>
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
                <span style="font-size:13px;color:#94a3b8;">Próxima renovação (${renewal}):</span>
                <span style="font-size:14px;font-weight:700;color:#f1f5f9;">${_fmtMoney(newMonthly, currency)}<span style="font-size:12px;font-weight:400;color:#64748b;">/mês</span></span>
              </div>
              <div style="margin-top:10px;padding-top:10px;border-top:1px solid rgba(255,255,255,0.06);font-size:12px;color:#64748b;line-height:1.5;">
                O valor proporcional é calculado automaticamente pelo Stripe com base nos dias restantes do seu ciclo atual. A cobrança é realizada imediatamente no cartão cadastrado.
              </div>
            `
            confirmBtn.disabled    = false
            confirmBtn.style.opacity = '1'
            confirmBtn.textContent = amountDue > 0
                ? `Confirmar e pagar ${_fmtMoney(amountDue, currency)}`
                : 'Confirmar upgrade'

        } else if (data.type === 'downgrade') {
            const newMonthly  = data.newPlanUnitAmount ?? 0
            const currency    = data.currency ?? 'brl'
            const effectiveAt = _fmtDateFromTs(data.periodEnd)

            previewBox.style.background = 'rgba(245,158,11,0.06)'
            previewBox.style.border     = '1px solid rgba(245,158,11,0.25)'
            previewBox.innerHTML = `
              <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:#fbbf24;margin-bottom:10px;">Resumo do downgrade</div>
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                <span style="font-size:13px;color:#94a3b8;">Sem cobrança imediata</span>
                <span style="font-size:16px;font-weight:800;color:#f1f5f9;">R$ 0,00</span>
              </div>
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
                <span style="font-size:13px;color:#94a3b8;">Novo valor a partir de ${effectiveAt}:</span>
                <span style="font-size:14px;font-weight:700;color:#f1f5f9;">${_fmtMoney(newMonthly, currency)}<span style="font-size:12px;font-weight:400;color:#64748b;">/mês</span></span>
              </div>
              <div style="margin-top:10px;padding-top:10px;border-top:1px solid rgba(255,255,255,0.06);font-size:12px;color:#64748b;line-height:1.5;">
                Você continua com todos os benefícios do plano atual até <strong style="color:#94a3b8;">${effectiveAt}</strong>. Nenhum valor é cobrado ou estornado agora.
              </div>
            `
            confirmBtn.disabled    = false
            confirmBtn.style.opacity = '1'
            confirmBtn.textContent = `Agendar para ${effectiveAt}`

        } else if (data.type === 'cancel_pending') {
            previewBox.style.background = 'rgba(99,102,241,0.06)'
            previewBox.style.border     = '1px solid rgba(99,102,241,0.25)'
            previewBox.innerHTML = `
              <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:#818cf8;margin-bottom:10px;">Cancelar alteração agendada</div>
              <div style="font-size:13px;color:#94a3b8;line-height:1.6;">
                O downgrade para <strong style="color:#f1f5f9;">${_planLabel(data.pendingPlan)}</strong> será cancelado.
                Você permanecerá no plano <strong style="color:#10b981;">${_planLabel(data.currentPlan)}</strong> normalmente.
              </div>
            `
            confirmBtn.disabled    = false
            confirmBtn.style.opacity = '1'
            confirmBtn.textContent = 'Cancelar alteração agendada'
            confirmBtn.style.background = 'linear-gradient(135deg,#6366f1,#4f46e5)'

        } else if (data.type === 'already_scheduled') {
            const effectiveAt = _fmtDateFromISO(data.pendingEffectiveAt)
            previewBox.style.background = 'rgba(255,255,255,0.03)'
            previewBox.style.border     = '1px solid rgba(255,255,255,0.07)'
            previewBox.innerHTML = `
              <div style="font-size:13px;color:#64748b;line-height:1.6;">
                Este plano já está agendado para entrar em vigor em <strong style="color:#94a3b8;">${effectiveAt}</strong>.
                Nenhuma ação adicional é necessária.
              </div>
            `
            confirmBtn.disabled    = true
            confirmBtn.style.opacity = '0.3'
            confirmBtn.textContent = 'Já agendado'
        }
    }

    function _showPreviewLoading() {
        previewBox.style.display    = 'block'
        previewBox.style.background = 'rgba(255,255,255,0.03)'
        previewBox.style.border     = '1px solid rgba(255,255,255,0.07)'
        previewBox.innerHTML = `
          <div style="display:flex;align-items:center;gap:10px;color:#64748b;font-size:13px;">
            <div style="width:14px;height:14px;border:2px solid #10b981;border-top-color:transparent;border-radius:50%;animation:spin .7s linear infinite;flex-shrink:0;"></div>
            Calculando valor proporcional...
          </div>
        `
        if (!document.getElementById('planModalSpinStyle')) {
            const st = document.createElement('style')
            st.id = 'planModalSpinStyle'
            st.textContent = '@keyframes spin{to{transform:rotate(360deg)}}'
            document.head.appendChild(st)
        }
        confirmBtn.disabled    = true
        confirmBtn.style.opacity = '0.4'
        confirmBtn.textContent = 'Calculando...'
    }

    function _hidePreview() {
        previewBox.style.display = 'none'
        previewBox.innerHTML     = ''
        previewData = null
        confirmBtn.disabled    = true
        confirmBtn.style.opacity = '0.4'
        confirmBtn.textContent = 'Selecione um plano'
        confirmBtn.style.background = 'linear-gradient(135deg,#10b981,#059669)'
    }

    async function _fetchPreview(slug) {
        previewLoading = true
        _showPreviewLoading()
        errorEl.style.display = 'none'
        try {
            const { data: { session: fresh } } = await supabase.auth.getSession()
            const token = fresh?.access_token || session.access_token
            const resp = await fetch('/api/stripe', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body:    JSON.stringify({ action: 'previewPlan', newPlan: slug }),
                signal:  AbortSignal.timeout(20_000),
            })
            const data = await resp.json().catch(() => ({}))
            if (!resp.ok) throw new Error(data.error || `Erro ${resp.status}`)
            _renderPreview(data)
        } catch (err) {
            // Preview falhou: ainda permite confirmar mas avisa
            previewBox.style.display    = 'block'
            previewBox.style.background = 'rgba(248,113,113,0.05)'
            previewBox.style.border     = '1px solid rgba(248,113,113,0.2)'
            previewBox.innerHTML = `<div style="font-size:13px;color:#f87171;line-height:1.5;">Não foi possível calcular o valor exato agora. Você pode confirmar assim mesmo — o Stripe calculará e cobrará o valor correto automaticamente.</div>`
            confirmBtn.disabled    = false
            confirmBtn.style.opacity = '1'
            confirmBtn.textContent = 'Confirmar alteração'
        } finally {
            previewLoading = false
        }
    }

    // ── Renderiza opções de plano ─────────────────────────────────
    const PLAN_RANK_MODAL = { individual: 1, casal: 2, familia: 3 }
    const curRank = PLAN_RANK_MODAL[_currentPlanSlug] ?? 0

    plans.forEach(p => {
        const isCurrent    = p.slug === _currentPlanSlug
        const isPending    = p.slug === _currentPendingPlan && _currentPendingPlan !== ''
        const isSelectable = !isCurrent || (_currentPendingPlan !== '' && isCurrent)
        const pRank        = PLAN_RANK_MODAL[p.slug] ?? 0
        const isUpgrade    = pRank > curRank
        const isDowngrade  = pRank < curRank

        // Cores por estado
        let borderColor, bgColor, nameColor, priceColor
        if (isCurrent) {
            borderColor = 'rgba(16,185,129,0.35)'; bgColor = 'rgba(16,185,129,0.06)';
            nameColor   = '#10b981';                priceColor = '#10b981'
        } else if (isPending) {
            borderColor = 'rgba(245,158,11,0.3)';  bgColor = 'rgba(245,158,11,0.05)';
            nameColor   = '#fbbf24';                priceColor = '#fbbf24'
        } else if (isUpgrade) {
            borderColor = 'rgba(255,255,255,0.09)'; bgColor = 'rgba(255,255,255,0.03)';
            nameColor   = '#e2e8f0';                priceColor = '#34d399'
        } else {
            borderColor = 'rgba(255,255,255,0.09)'; bgColor = 'rgba(255,255,255,0.03)';
            nameColor   = '#e2e8f0';                priceColor = '#94a3b8'
        }

        const card = document.createElement('label')
        card.style.cssText = [
            'display:flex', 'align-items:center', 'gap:12px', 'padding:14px 16px',
            `background:${bgColor}`,
            `border:1px solid ${borderColor}`,
            'border-radius:14px',
            `cursor:${isSelectable ? 'pointer' : 'default'}`,
            'transition:border-color .2s, background .2s',
            'position:relative',
        ].join(';')

        // Hover highlight para cards seleccionáveis
        if (isSelectable && !isCurrent) {
            card.addEventListener('mouseenter', () => {
                card.style.borderColor = 'rgba(16,185,129,0.4)'
                card.style.background  = 'rgba(16,185,129,0.05)'
            })
            card.addEventListener('mouseleave', () => {
                const isChecked = card.querySelector('input[type=radio]')?.checked
                if (!isChecked) {
                    card.style.borderColor = borderColor
                    card.style.background  = bgColor
                }
            })
        }

        const radio = document.createElement('input')
        radio.type    = 'radio'
        radio.name    = 'planOption'
        radio.value   = p.slug
        radio.disabled = !isSelectable
        radio.style.cssText = 'accent-color:#10b981;width:17px;height:17px;flex-shrink:0;cursor:inherit;'

        // Badges
        let badgeHtml = ''
        if (isCurrent) {
            badgeHtml += '<span style="font-size:10px;font-weight:700;background:rgba(16,185,129,0.18);border:1px solid rgba(16,185,129,0.35);border-radius:50px;padding:2px 8px;color:#10b981;letter-spacing:.3px;">ATUAL</span>'
        }
        if (isPending) {
            badgeHtml += '<span style="font-size:10px;font-weight:700;background:rgba(245,158,11,0.18);border:1px solid rgba(245,158,11,0.35);border-radius:50px;padding:2px 8px;color:#fbbf24;letter-spacing:.3px;">AGENDADO</span>'
        }
        if (isUpgrade && !isCurrent && !isPending) {
            badgeHtml += '<span style="font-size:10px;font-weight:700;background:rgba(52,211,153,0.12);border:1px solid rgba(52,211,153,0.25);border-radius:50px;padding:2px 8px;color:#34d399;letter-spacing:.3px;">UPGRADE</span>'
        }

        // Ícone do plano
        const iconWrap = document.createElement('div')
        iconWrap.style.cssText = [
            `color:${nameColor}`,
            'flex-shrink:0',
            'opacity:.85',
        ].join(';')
        iconWrap.innerHTML = p.icon

        // Texto central
        const textWrap = document.createElement('div')
        textWrap.style.cssText = 'flex:1;min-width:0;'
        textWrap.innerHTML = `
          <div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-bottom:3px;">
            <span style="font-size:15px;font-weight:800;color:${nameColor};letter-spacing:-.2px;">${p.label}</span>
            <span style="font-size:11px;color:#475569;font-weight:500;">${p.tagline}</span>
            ${badgeHtml}
          </div>
          <div style="font-size:12px;color:#475569;line-height:1.5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${p.desc}</div>
        `

        // Preço (lado direito)
        const priceWrap = document.createElement('div')
        priceWrap.style.cssText = 'text-align:right;flex-shrink:0;'
        priceWrap.innerHTML = `
          <div style="font-size:16px;font-weight:800;color:${priceColor};letter-spacing:-.5px;line-height:1.1;">${_fmtMoney(p.price, 'brl')}</div>
          <div style="font-size:10px;color:#475569;font-weight:500;margin-top:2px;">/mês</div>
        `

        radio.addEventListener('change', () => {
            if (!radio.checked) return
            selectedPlan = p.slug
            // Atualiza borda do card selecionado
            list.querySelectorAll('label').forEach(lbl => {
                lbl.style.borderColor = ''
                lbl.style.background  = ''
            })
            card.style.borderColor = 'rgba(16,185,129,0.55)'
            card.style.background  = 'rgba(16,185,129,0.08)'
            _fetchPreview(p.slug)
        })

        card.appendChild(radio)
        card.appendChild(iconWrap)
        card.appendChild(textWrap)
        card.appendChild(priceWrap)
        list.appendChild(card)
    })

    const closeModal = () => overlay.remove()
    modal.querySelector('#planModalClose').addEventListener('click', closeModal)
    cancelBtn.addEventListener('click', closeModal)
    overlay.addEventListener('click', e => { if (e.target === overlay) closeModal() })

    // ── Confirmar ─────────────────────────────────────────────────
    confirmBtn.addEventListener('click', async () => {
        if (!selectedPlan || confirmBtn.disabled) return

        const planToSend = (previewData?.type === 'cancel_pending') ? _currentPlanSlug : selectedPlan

        const prevText = confirmBtn.textContent
        confirmBtn.disabled    = true
        confirmBtn.textContent = 'Processando...'
        cancelBtn.disabled     = true
        errorEl.style.display  = 'none'

        try {
            const { data: { session: fresh } } = await supabase.auth.getSession()
            const token = fresh?.access_token || session.access_token

            const resp = await fetch('/api/stripe', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body:    JSON.stringify({ action: 'updatePlan', newPlan: planToSend }),
                signal:  AbortSignal.timeout(25_000),
            })

            const resBody = await resp.json().catch(() => ({}))
            if (!resp.ok) {
                const msg = resBody.error || `Erro ${resp.status}`
                const isPaymentFail = resp.status === 402 || resBody.code === 'payment_failed'
                throw Object.assign(new Error(msg), { isPaymentFail })
            }

            closeModal()

            if (resBody.action === 'cancelled_pending') {
                _showToast(`Alteração agendada cancelada. Você permanece no plano ${_planLabel(_currentPlanSlug)}.`, 'info')
            } else if (resBody.action === 'downgrade_scheduled') {
                const effectiveAt = resBody.effectiveAt ? _fmtDateFromISO(resBody.effectiveAt) : '—'
                _showToast(`Plano ${_planLabel(planToSend)} agendado para ${effectiveAt}. Sem cobrança agora.`, 'info')
            } else {
                _showToast(`Plano alterado para ${_planLabel(planToSend)} com sucesso!`, 'success')
            }

            setTimeout(() => loadSubscription(session), 1500)

        } catch (err) {
            confirmBtn.disabled    = false
            confirmBtn.textContent = prevText
            cancelBtn.disabled     = false
            if (err.isPaymentFail) {
                errorEl.innerHTML = `<strong>Pagamento recusado.</strong> ${err.message}`
                errorEl.style.color = '#f87171'
            } else {
                errorEl.textContent = err.message || 'Erro ao alterar plano. Tente novamente.'
            }
            errorEl.style.display = 'block'
        }
    })

    overlay.appendChild(modal)
    document.body.appendChild(overlay)
}

function setupPlanChangeCard(session) {
    // Wire no card "Alterar Plano" (3º card no action-grid)
    const grid = document.getElementById('actionGrid')
    if (!grid) return
    const cards = grid.querySelectorAll('.action-card')
    cards.forEach(card => {
        const title = card.querySelector('.ac-title')
        if (title?.textContent?.trim() === 'Alterar Plano') {
            card.style.cursor = 'pointer'
            card.addEventListener('click', () => _openPlanModal(session))
        }
    })
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
