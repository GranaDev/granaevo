// ui.js — controlador de DOM do chat (renderização SEGURA por construção)
// ---------------------------------------------------------------------------
// Nunca usa innerHTML com conteúdo dinâmico. Texto do usuário e das frases é
// inserido via textContent (XSS-proof); só o *negrito* controlado das frases
// vira <strong>, construído com createElement — nada de HTML cru.
// ---------------------------------------------------------------------------

let els = null;

export function mountUI() {
    els = {
        messages: document.getElementById('geMessages'),
        input:    document.getElementById('geInput'),
        send:     document.getElementById('geSend'),
        quick:    document.getElementById('geQuick'),
        mic:      document.getElementById('geMic'),
    };
    return els;
}

/** D39: vibração sutil (respeita prefers-reduced-motion; no-op se não suportado). */
export function haptic(ms = 12) {
    try {
        if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
        navigator.vibrate?.(ms);
    } catch { /* ignore */ }
}

/** D32/D33/D40: renderiza chips de sugestão. items = [{label, text}]. */
export function setQuickReplies(items, onPick) {
    if (!els?.quick) return;
    els.quick.replaceChildren();
    if (!Array.isArray(items) || items.length === 0) { els.quick.hidden = true; return; }
    for (const it of items) {
        const b = document.createElement('button');
        b.className = 'ge-quick-chip';
        b.type = 'button';
        b.textContent = it.label;                 // textContent — XSS-proof
        b.addEventListener('click', () => onPick?.(it.text ?? it.label));
        els.quick.appendChild(b);
    }
    els.quick.hidden = false;
}

/** Pré-preenche e foca o input (usado pelo botão Corrigir — D35). */
export function focusInput(prefill) {
    if (!els?.input) return;
    if (typeof prefill === 'string') {
        els.input.value = prefill;
        els.input.dispatchEvent(new Event('input')); // reativa autoresize + habilita enviar
    }
    els.input.focus();
    const n = els.input.value.length;
    try { els.input.setSelectionRange(n, n); } catch { /* ignore */ }
}

/** Cria um <i> de ícone Font Awesome com nome em whitelist (sem HTML cru). */
export function faIcon(name, extraClass = '') {
    const i = document.createElement('i');
    if (/^fa-[a-z0-9-]+$/.test(name)) i.className = `fas ${name}${extraClass ? ' ' + extraClass : ''}`;
    i.setAttribute('aria-hidden', 'true');
    return i;
}

// Constrói nós com suporte a *negrito* e ícones {{fa-nome}} — SEM innerHTML.
// Os ícones são criados via createElement com classe em whitelist (fa-xxx),
// então não há vetor de XSS mesmo com texto vindo da IA (que nunca chega aqui).
function renderFormatted(container, text) {
    const str = String(text ?? '');
    const re = /\*([^*\n]+)\*|\{\{(fa-[a-z0-9-]+)\}\}/g;
    let last = 0, m;
    while ((m = re.exec(str)) !== null) {
        if (m.index > last) container.appendChild(document.createTextNode(str.slice(last, m.index)));
        if (m[1] !== undefined) {
            const strong = document.createElement('strong');
            strong.textContent = m[1];
            container.appendChild(strong);
        } else {
            container.appendChild(faIcon(m[2], 'ge-ic'));
        }
        last = re.lastIndex;
    }
    if (last < str.length) container.appendChild(document.createTextNode(str.slice(last)));
}

function scrollDown() {
    if (els?.messages) els.messages.scrollTop = els.messages.scrollHeight;
}

export function addUserMessage(text) {
    const row = document.createElement('div');
    row.className = 'ge-row user';
    const bubble = document.createElement('div');
    bubble.className = 'ge-bubble';
    bubble.textContent = String(text ?? ''); // texto do usuário: sempre textContent
    row.appendChild(bubble);
    els.messages.appendChild(row);
    scrollDown();
}

export function addAssistantMessage(text) {
    const row = document.createElement('div');
    row.className = 'ge-row assistant';
    const bubble = document.createElement('div');
    bubble.className = 'ge-bubble';
    renderFormatted(bubble, text);
    row.appendChild(bubble);
    els.messages.appendChild(row);
    scrollDown();
}

/** Chip de confirmação com botão Desfazer (+ Corrigir p/ saída/entrada). onUndo é async. */
export function addConfirm({ text, chip }, onUndo) {
    haptic(); // D39: feedback tátil sutil ao confirmar
    const row = document.createElement('div');
    row.className = 'ge-row assistant';
    const wrap = document.createElement('div');
    wrap.className = 'ge-confirm';

    const t = document.createElement('div');
    t.className = 'ge-confirm-text';
    renderFormatted(t, text);
    wrap.appendChild(t);

    // D35: "Corrigir" — só pra saída/entrada (onde a correção inline funciona).
    if (chip?.categoria === 'saida' || chip?.categoria === 'entrada') {
        const fix = document.createElement('button');
        fix.className = 'ge-correct-btn';
        fix.type = 'button';
        fix.textContent = 'Corrigir';
        fix.addEventListener('click', () => focusInput('corrige pra '));
        wrap.appendChild(fix);
    }

    const btn = document.createElement('button');
    btn.className = 'ge-undo-btn';
    btn.textContent = chip?.undoLabel || 'Desfazer';
    btn.addEventListener('click', async () => {
        btn.disabled = true;
        const res = await onUndo();
        btn.replaceChildren(faIcon('fa-check'));
        if (res?.text) addAssistantMessage(res.text);
    }, { once: true });
    wrap.appendChild(btn);

    row.appendChild(wrap);
    els.messages.appendChild(row);
    scrollDown();
}

/** D36: cabeçalho sutil quando um único envio gera vários lançamentos. */
export function addMultiHeader(n) {
    if (!els?.messages || !(n > 1)) return;
    const head = document.createElement('div');
    head.className = 'ge-multi-head';
    head.textContent = `${n} lançamentos de uma vez:`;
    els.messages.appendChild(head);
}

let typingRow = null;
export function showTyping() {
    if (typingRow) return;
    typingRow = document.createElement('div');
    typingRow.className = 'ge-row assistant';
    const t = document.createElement('div');
    t.className = 'ge-typing';
    t.appendChild(document.createElement('span'));
    t.appendChild(document.createElement('span'));
    t.appendChild(document.createElement('span'));
    typingRow.appendChild(t);
    els.messages.appendChild(typingRow);
    scrollDown();
}
export function hideTyping() {
    if (typingRow) { typingRow.remove(); typingRow = null; }
}

/** Auto-expande a textarea e habilita/desabilita o botão enviar. */
export function wireInput(onSend) {
    const { input, send } = els;
    const autoresize = () => {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 120) + 'px';
        send.disabled = input.value.trim() === '';
    };
    input.addEventListener('input', autoresize);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
    });
    send.addEventListener('click', submit);
    function submit() {
        const text = input.value.trim();
        if (!text) return;
        input.value = ''; autoresize();
        onSend(text);
    }
    autoresize();
    input.focus();
}
