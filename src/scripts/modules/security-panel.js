// security-panel.js — painel "Segurança da conta" (lazy, aberto das Configurações)
// ---------------------------------------------------------------------------
// Transparência de segurança para o usuário:
//  1. Desconectar TODOS os aparelhos (revoga todos os refresh tokens — global)
//  2. Aparelhos com notificações ativas (push_subscriptions, RLS: só as próprias)
//  3. Atividade recente da conta (financial_audit_log, RLS: só as próprias linhas)
//
// Segurança do próprio painel: nenhuma string dinâmica vira HTML — tudo
// textContent/createElement. Estilos via constructed stylesheet (isenta de CSP).
// ---------------------------------------------------------------------------

import { supabase } from '../services/supabase-client.js?v=2';

let _mounted = false;

const CSS = `
#geSecPanel { position: fixed; inset: 0; z-index: 9999; display: flex; align-items: center; justify-content: center; padding: 16px; }
#geSecPanel .sec-overlay { position: absolute; inset: 0; background: rgba(0,0,0,0.7); backdrop-filter: blur(4px); }
#geSecPanel .sec-card { position: relative; background: #13141f; border: 1px solid rgba(16,185,129,0.2); border-radius: 20px; padding: 24px; max-width: 480px; width: 100%; max-height: 86vh; overflow-y: auto; box-shadow: 0 24px 48px rgba(0,0,0,0.5); color: #d1d5db; }
#geSecPanel h3 { color: #fff; font-size: 1.1rem; margin: 0 0 4px; display: flex; align-items: center; gap: 8px; }
#geSecPanel .sec-sub { color: #9ca3af; font-size: 0.82rem; margin: 0 0 16px; }
#geSecPanel .sec-close { position: absolute; top: 14px; right: 14px; background: none; border: none; color: #6b7280; font-size: 1rem; cursor: pointer; padding: 6px 10px; }
#geSecPanel .sec-section { margin-top: 18px; }
#geSecPanel .sec-label { font-size: 0.72rem; letter-spacing: 0.08em; text-transform: uppercase; color: #6b7280; margin-bottom: 8px; }
#geSecPanel .sec-row { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid rgba(255,255,255,0.06); border-radius: 12px; margin-bottom: 8px; font-size: 0.85rem; }
#geSecPanel .sec-row .grow { flex: 1; min-width: 0; }
#geSecPanel .sec-row .tit { color: #e5e7eb; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#geSecPanel .sec-row .sub { color: #6b7280; font-size: 0.75rem; }
#geSecPanel .sec-muted { color: #6b7280; font-size: 0.82rem; padding: 6px 2px; }
#geSecPanel .sec-btn-danger { width: 100%; background: rgba(239,68,68,0.12); color: #fca5a5; border: 1px solid rgba(239,68,68,0.35); border-radius: 12px; padding: 12px; font-weight: 700; font-size: 0.9rem; cursor: pointer; }
#geSecPanel .sec-btn-danger.arm { background: #ef4444; color: #fff; }
#geSecPanel .sec-mini { background: none; border: 1px solid rgba(239,68,68,0.35); color: #fca5a5; border-radius: 10px; padding: 6px 10px; font-size: 0.75rem; cursor: pointer; flex-shrink: 0; }
`;

function _injectCss() {
    if (_mounted) return;
    try {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(CSS);
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    } catch {
        const s = document.createElement('style');
        s.textContent = CSS;
        document.head.appendChild(s);
    }
    _mounted = true;
}

const el = (tag, cls, txt) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
};

// Rótulo amigável de um user-agent (heurística leve; o UA é do próprio usuário).
function _uaLabel(ua) {
    const s = String(ua || '');
    const nav =
        /OPR\/|Opera/.test(s) ? 'Opera' :
        /Edg\//.test(s) ? 'Edge' :
        /SamsungBrowser/.test(s) ? 'Samsung Internet' :
        /Firefox\//.test(s) ? 'Firefox' :
        /Chrome\//.test(s) ? 'Chrome' :
        /Safari\//.test(s) ? 'Safari' : 'Navegador';
    const so =
        /Android/.test(s) ? 'Android' :
        /iPhone|iPad|iOS/.test(s) ? 'iOS' :
        /Windows/.test(s) ? 'Windows' :
        /Mac OS X|Macintosh/.test(s) ? 'macOS' :
        /Linux/.test(s) ? 'Linux' : '';
    return so ? `${nav} · ${so}` : nav;
}

function _fmtData(iso) {
    try { return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }); }
    catch { return String(iso || ''); }
}

const OP_LABEL = {
    save: 'Dados salvos', update: 'Dados atualizados', restore: 'Backup restaurado',
    delete: 'Dados removidos', load: 'Dados carregados',
};

/** Abre o painel de segurança (cria o modal na hora; remove ao fechar). */
export async function openSecurityPanel() {
    _injectCss();
    document.getElementById('geSecPanel')?.remove();

    const root = el('div'); root.id = 'geSecPanel';
    const overlay = el('div', 'sec-overlay');
    const card = el('div', 'sec-card');
    root.appendChild(overlay); root.appendChild(card);

    const close = () => root.remove();
    overlay.addEventListener('click', close);

    const btnClose = el('button', 'sec-close', '✕');
    btnClose.type = 'button'; btnClose.setAttribute('aria-label', 'Fechar');
    btnClose.addEventListener('click', close);
    card.appendChild(btnClose);

    card.appendChild(el('h3', null, 'Segurança da conta'));
    card.appendChild(el('p', 'sec-sub', 'Veja onde sua conta está ativa e encerre tudo com um toque.'));

    // ── 1. Desconectar todos os aparelhos ────────────────────────────────────
    const secOut = el('div', 'sec-section');
    secOut.appendChild(el('div', 'sec-label', 'Sessões'));
    const btnAll = el('button', 'sec-btn-danger', 'Desconectar todos os aparelhos');
    btnAll.type = 'button';
    let armed = false;
    btnAll.addEventListener('click', async () => {
        if (!armed) {
            armed = true;
            btnAll.classList.add('arm');
            btnAll.textContent = 'Confirmar: sair de TODOS os aparelhos?';
            setTimeout(() => { armed = false; btnAll.classList.remove('arm'); btnAll.textContent = 'Desconectar todos os aparelhos'; }, 6000);
            return;
        }
        btnAll.disabled = true;
        btnAll.textContent = 'Encerrando sessões…';
        try { await supabase.auth.signOut({ scope: 'global' }); } catch { /* segue pro login mesmo assim */ }
        window.location.replace('/login');
    });
    secOut.appendChild(btnAll);
    secOut.appendChild(el('p', 'sec-muted', 'Revoga o acesso em todos os navegadores e celulares — inclusive este. Você entra de novo com sua senha.'));
    card.appendChild(secOut);

    // ── 2. Aparelhos com notificações ────────────────────────────────────────
    const secDev = el('div', 'sec-section');
    secDev.appendChild(el('div', 'sec-label', 'Aparelhos com notificações'));
    const devList = el('div');
    devList.appendChild(el('p', 'sec-muted', 'Carregando…'));
    secDev.appendChild(devList);
    card.appendChild(secDev);

    // ── 3. Atividade recente ─────────────────────────────────────────────────
    const secAct = el('div', 'sec-section');
    secAct.appendChild(el('div', 'sec-label', 'Atividade recente'));
    const actList = el('div');
    actList.appendChild(el('p', 'sec-muted', 'Carregando…'));
    secAct.appendChild(actList);
    card.appendChild(secAct);

    document.body.appendChild(root);

    // Carrega os dados em paralelo (RLS garante o escopo; nada de service key aqui).
    const [devs, acts] = await Promise.allSettled([
        supabase.from('push_subscriptions')
            .select('id, user_agent, created_at, last_used_at, is_active')
            .order('last_used_at', { ascending: false })
            .limit(10),
        supabase.from('financial_audit_log')
            .select('operation, created_at, user_agent')
            .order('created_at', { ascending: false })
            .limit(10),
    ]);

    devList.replaceChildren();
    const devRows = devs.status === 'fulfilled' && !devs.value.error ? (devs.value.data || []) : null;
    if (!devRows) devList.appendChild(el('p', 'sec-muted', 'Não consegui carregar agora.'));
    else if (!devRows.length) devList.appendChild(el('p', 'sec-muted', 'Nenhum aparelho recebendo notificações.'));
    else {
        for (const d of devRows) {
            const row = el('div', 'sec-row');
            const grow = el('div', 'grow');
            grow.appendChild(el('span', 'tit', _uaLabel(d.user_agent) + (d.is_active === false ? ' (inativo)' : '')));
            grow.appendChild(el('span', 'sub', `Último uso: ${_fmtData(d.last_used_at || d.created_at)}`));
            row.appendChild(grow);
            const rm = el('button', 'sec-mini', 'Remover');
            rm.type = 'button';
            rm.addEventListener('click', async () => {
                rm.disabled = true;
                const { error } = await supabase.from('push_subscriptions').delete().eq('id', d.id);
                if (!error) row.remove(); else rm.disabled = false;
            });
            row.appendChild(rm);
            devList.appendChild(row);
        }
    }

    actList.replaceChildren();
    const actRows = acts.status === 'fulfilled' && !acts.value.error ? (acts.value.data || []) : null;
    if (!actRows) actList.appendChild(el('p', 'sec-muted', 'Não consegui carregar agora.'));
    else if (!actRows.length) actList.appendChild(el('p', 'sec-muted', 'Sem registros recentes.'));
    else {
        for (const a of actRows) {
            const row = el('div', 'sec-row');
            const grow = el('div', 'grow');
            grow.appendChild(el('span', 'tit', OP_LABEL[String(a.operation || '').toLowerCase()] || String(a.operation || 'Operação')));
            grow.appendChild(el('span', 'sub', `${_fmtData(a.created_at)}${a.user_agent ? ' · ' + _uaLabel(a.user_agent) : ''}`));
            row.appendChild(grow);
            actList.appendChild(row);
        }
        actList.appendChild(el('p', 'sec-muted', 'Registro de segurança das operações nos seus dados (fica 6 meses).'));
    }
}
