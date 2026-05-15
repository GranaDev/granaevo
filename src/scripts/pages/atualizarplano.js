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

const _FIELDS = 'plan_name, status, current_period_start, current_period_end, cancel_at_period_end, canceled_at, created_at';

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
    _currentPlanSlug = (sub.plan_name || '').toLowerCase().trim();
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
let _currentPlanSlug = ''

function _openPlanModal(session) {
    const overlay = document.createElement('div')
    overlay.id = 'planModalOverlay'
    overlay.style.cssText = [
        'position:fixed', 'inset:0', 'z-index:10000',
        'background:rgba(6,8,16,0.85)', 'backdrop-filter:blur(6px)',
        'display:flex', 'align-items:center', 'justify-content:center',
        'padding:16px',
    ].join(';')

    const modal = document.createElement('div')
    modal.style.cssText = [
        'background:linear-gradient(160deg,#0d1117 0%,#111827 100%)',
        'border:1px solid rgba(16,185,129,0.2)', 'border-radius:20px',
        'padding:32px', 'max-width:520px', 'width:100%',
        'box-shadow:0 32px 64px rgba(0,0,0,0.7)',
        'max-height:90vh', 'overflow-y:auto',
    ].join(';')

    const plans = [
        { slug: 'individual', label: 'Individual', desc: 'Para uso pessoal — controle total das suas finanças.' },
        { slug: 'casal',      label: 'Casal',      desc: 'Para 2 pessoas — finanças compartilhadas com privacidade.' },
        { slug: 'familia',    label: 'Família',    desc: 'Para até 5 pessoas — visão consolidada da família.' },
    ]

    modal.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;">
        <h2 style="font-size:20px;font-weight:800;color:#f1f5f9;letter-spacing:-0.3px;">Alterar Plano</h2>
        <button id="planModalClose" style="background:none;border:none;color:#64748b;cursor:pointer;font-size:20px;padding:4px 8px;border-radius:6px;" aria-label="Fechar">✕</button>
      </div>
      <p style="font-size:14px;color:#64748b;margin-bottom:24px;line-height:1.6;">
        Selecione o plano desejado. A diferença de valor é calculada proporcionalmente (proration) ao tempo restante do ciclo e cobrada imediatamente.
      </p>
      <div id="planOptionsList" style="display:flex;flex-direction:column;gap:12px;margin-bottom:28px;"></div>
      <div style="display:flex;gap:12px;">
        <button id="planModalCancel" style="flex:1;padding:12px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:10px;color:#94a3b8;font-size:14px;font-weight:600;cursor:pointer;">Cancelar</button>
        <button id="planModalConfirm" style="flex:2;padding:12px;background:linear-gradient(135deg,#10b981,#059669);border:none;border-radius:10px;color:#fff;font-size:14px;font-weight:700;cursor:pointer;opacity:0.4;" disabled>Confirmar alteração</button>
      </div>
      <p id="planModalError" style="margin-top:12px;font-size:13px;color:#f87171;text-align:center;display:none;"></p>
    `

    const list = modal.querySelector('#planOptionsList')
    let selectedPlan = ''

    plans.forEach(p => {
        const isCurrent = p.slug === _currentPlanSlug
        const card = document.createElement('label')
        card.style.cssText = [
            'display:flex', 'align-items:flex-start', 'gap:14px', 'padding:16px 18px',
            `background:${isCurrent ? 'rgba(16,185,129,0.08)' : 'rgba(255,255,255,0.03)'}`,
            `border:1px solid ${isCurrent ? 'rgba(16,185,129,0.35)' : 'rgba(255,255,255,0.07)'}`,
            'border-radius:12px', 'cursor:pointer', 'transition:border-color .2s',
        ].join(';')

        const radio = document.createElement('input')
        radio.type    = 'radio'
        radio.name    = 'planOption'
        radio.value   = p.slug
        radio.checked = isCurrent
        radio.disabled = isCurrent
        radio.style.cssText = 'margin-top:3px;accent-color:#10b981;width:16px;height:16px;flex-shrink:0;'

        const textWrap = document.createElement('div')
        textWrap.innerHTML = `
          <div style="font-size:15px;font-weight:700;color:${isCurrent ? '#10b981' : '#e2e8f0'};margin-bottom:4px;">
            ${p.label}${isCurrent ? ' <span style="font-size:11px;font-weight:600;background:rgba(16,185,129,0.15);border:1px solid rgba(16,185,129,0.3);border-radius:50px;padding:2px 8px;color:#10b981;">Atual</span>' : ''}
          </div>
          <div style="font-size:13px;color:#64748b;line-height:1.5;">${p.desc}</div>
        `

        radio.addEventListener('change', () => {
            if (!isCurrent && radio.checked) {
                selectedPlan = p.slug
                const confirmBtn = modal.querySelector('#planModalConfirm') as HTMLButtonElement
                confirmBtn.disabled = false
                confirmBtn.style.opacity = '1'
            }
        })

        card.appendChild(radio)
        card.appendChild(textWrap)
        list!.appendChild(card)
    })

    const closeModal = () => overlay.remove()
    modal.querySelector('#planModalClose')!.addEventListener('click', closeModal)
    modal.querySelector('#planModalCancel')!.addEventListener('click', closeModal)
    overlay.addEventListener('click', e => { if (e.target === overlay) closeModal() })

    modal.querySelector('#planModalConfirm')!.addEventListener('click', async () => {
        if (!selectedPlan) return
        const confirmBtn  = modal.querySelector('#planModalConfirm') as HTMLButtonElement
        const cancelBtn   = modal.querySelector('#planModalCancel') as HTMLButtonElement
        const errorEl     = modal.querySelector('#planModalError') as HTMLElement
        confirmBtn.disabled  = true
        confirmBtn.textContent = 'Atualizando...'
        cancelBtn.disabled   = true
        errorEl.style.display = 'none'

        try {
            const { data: { session: fresh } } = await supabase.auth.getSession()
            const token = fresh?.access_token || session.access_token

            const resp = await fetch('/api/stripe', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body:    JSON.stringify({ action: 'updatePlan', newPlan: selectedPlan }),
                signal:  AbortSignal.timeout(20_000),
            })

            const data = await resp.json().catch(() => ({}))
            if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`)

            closeModal()
            _showToast(`Plano alterado para ${selectedPlan.charAt(0).toUpperCase() + selectedPlan.slice(1)} com sucesso!`, 'success')
            // Recarrega dados após 1.5s para refletir o novo plano
            setTimeout(() => loadSubscription(session), 1500)

        } catch (err: any) {
            confirmBtn.disabled  = false
            confirmBtn.textContent = 'Confirmar alteração'
            cancelBtn.disabled   = false
            errorEl.textContent    = err.message || 'Erro ao alterar plano. Tente novamente.'
            errorEl.style.display  = 'block'
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
