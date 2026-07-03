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
    };
    return els;
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

/** Chip de confirmação com botão Desfazer. onUndo é async. */
export function addConfirm({ text, chip }, onUndo) {
    const row = document.createElement('div');
    row.className = 'ge-row assistant';
    const wrap = document.createElement('div');
    wrap.className = 'ge-confirm';

    const t = document.createElement('div');
    t.className = 'ge-confirm-text';
    renderFormatted(t, text);
    wrap.appendChild(t);

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
