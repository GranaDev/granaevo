// security-panel.js — painel "Segurança da conta" (lazy, aberto das Configurações)
// ---------------------------------------------------------------------------
// Transparência de segurança para o usuário:
//  0. Verificação em duas etapas (2FA/TOTP) — OPCIONAL, nasce DESLIGADA
//  1. Desconectar TODOS os aparelhos (revoga todos os refresh tokens — global)
//  2. Aparelhos com notificações ativas (push_subscriptions, RLS: só as próprias)
//  3. Atividade recente da conta (financial_audit_log, RLS: só as próprias linhas)
//
// Segurança do próprio painel: nenhuma string dinâmica vira HTML — tudo
// textContent/createElement. Estilos via constructed stylesheet (isenta de CSP).
//
// SOBRE O 2FA SER OPT-IN (Passo 31 · B-1, decisão do usuário em 2026-07-27):
//   ninguém é forçado. A conta nasce sem 2FA e continua assim até o usuário
//   clicar em "Ativar" aqui. Quem nunca ativar não vê diferença alguma no login.
//   Toda a conversa com o GoTrue passa pelo BFF /api/auth-session — o refresh
//   token elevado nunca entra no JavaScript. Ver o cabeçalho daquele arquivo.
// ---------------------------------------------------------------------------

import { supabase } from '../services/supabase-client.js?v=2';
import { getMfaStatus, enrollMfa, activateMfa, disableMfa } from '../services/mfa-api.js';

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

/* ── 2FA ─────────────────────────────────────────────────────────────────── */
#geSecPanel .mfa-box { border: 1px solid rgba(255,255,255,0.08); border-radius: 14px; padding: 14px; }
#geSecPanel .mfa-head { display: flex; align-items: center; gap: 10px; }
#geSecPanel .mfa-head .grow { flex: 1; min-width: 0; }
#geSecPanel .mfa-state { display: inline-flex; align-items: center; gap: 6px; font-size: 0.72rem; font-weight: 700; border-radius: 999px; padding: 3px 10px; }
#geSecPanel .mfa-state.off { background: rgba(107,114,128,0.16); color: #9ca3af; }
#geSecPanel .mfa-state.on  { background: rgba(16,185,129,0.14); color: #34d399; }
#geSecPanel .mfa-desc { color: #9ca3af; font-size: 0.79rem; line-height: 1.5; margin: 8px 0 0; }
#geSecPanel .mfa-cta { width: 100%; margin-top: 12px; border-radius: 12px; padding: 11px; font-weight: 700; font-size: 0.85rem; cursor: pointer; border: 1px solid rgba(16,185,129,0.4); background: rgba(16,185,129,0.12); color: #34d399; }
#geSecPanel .mfa-cta.danger { border-color: rgba(239,68,68,0.35); background: rgba(239,68,68,0.1); color: #fca5a5; }
#geSecPanel .mfa-cta[disabled] { opacity: 0.55; cursor: default; }
#geSecPanel .mfa-qr { display: block; width: 190px; height: 190px; margin: 14px auto 10px; background: #fff; border-radius: 12px; padding: 8px; }
#geSecPanel .mfa-secret { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.82rem; letter-spacing: 0.09em; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 10px; padding: 10px; text-align: center; color: #e5e7eb; word-break: break-all; cursor: pointer; }
#geSecPanel .mfa-input { width: 100%; margin-top: 12px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.12); border-radius: 12px; padding: 12px; color: #fff; font-size: 1.15rem; text-align: center; letter-spacing: 0.3em; font-weight: 700; }
#geSecPanel .mfa-input.pw { font-size: 0.9rem; letter-spacing: normal; text-align: left; }
#geSecPanel .mfa-input:focus { outline: none; border-color: rgba(16,185,129,0.55); }
#geSecPanel .mfa-err { color: #fca5a5; font-size: 0.78rem; margin: 8px 0 0; min-height: 1em; }
#geSecPanel .mfa-step { color: #6b7280; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 6px; }
#geSecPanel .mfa-codes { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin: 12px 0; }
#geSecPanel .mfa-codes span { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.84rem; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.09); border-radius: 8px; padding: 8px; text-align: center; color: #e5e7eb; }
#geSecPanel .mfa-warn { background: rgba(245,158,11,0.1); border: 1px solid rgba(245,158,11,0.3); color: #fcd34d; border-radius: 10px; padding: 10px 12px; font-size: 0.78rem; line-height: 1.45; margin-top: 10px; }
#geSecPanel .mfa-link { background: none; border: none; color: #6b7280; font-size: 0.78rem; text-decoration: underline; cursor: pointer; margin-top: 10px; padding: 4px; width: 100%; }
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

    // ── 0. Verificação em duas etapas (opcional, desligada por padrão) ───────
    const secMfa = el('div', 'sec-section');
    secMfa.appendChild(el('div', 'sec-label', 'Verificação em duas etapas'));
    const mfaHost = el('div', 'mfa-box');
    secMfa.appendChild(mfaHost);
    card.appendChild(secMfa);
    montarMfa(mfaHost);   // assíncrono; desenha "carregando" e se resolve sozinho

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

// ═══════════════════════════════════════════════════════════════════════════
//  VERIFICAÇÃO EM DUAS ETAPAS (2FA / TOTP) — opt-in
// ═══════════════════════════════════════════════════════════════════════════
// Máquina de estados de 4 telas dentro da mesma caixa:
//   estado   → desligada (padrão) ou ligada
//   ativar   → QR + segredo + campo do 1º código
//   códigos  → os 10 códigos de recuperação, mostrados UMA única vez
//   desligar → confirmação por senha (step-up)
//
// A caixa se redesenha inteira a cada transição (replaceChildren) em vez de
// mutar nós existentes: com 4 telas e vários caminhos de erro, esconder/mostrar
// pedaços é como nascem estados impossíveis na tela.

const APPS_SUGERIDOS = 'Google Authenticator, Authy, 1Password, Bitwarden ou o gerenciador do seu celular.';

/** Converte o SVG que o GoTrue devolve num src utilizável por <img>. */
function _qrSrc(qr) {
    const s = String(qr || '');
    if (!s) return null;
    if (s.startsWith('data:')) return s;                       // já é data URL
    if (s.trimStart().startsWith('<svg')) {                     // SVG cru
        return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(s);
    }
    return null;
}

async function montarMfa(host) {
    host.replaceChildren(el('p', 'sec-muted', 'Carregando…'));
    let status;
    try {
        status = await getMfaStatus();
    } catch {
        host.replaceChildren(el('p', 'sec-muted', 'Não consegui verificar o estado agora.'));
        return;
    }
    telaEstado(host, status?.enabled === true);
}

// ── Tela 1: estado atual ───────────────────────────────────────────────────
function telaEstado(host, ligada) {
    host.replaceChildren();

    const head = el('div', 'mfa-head');
    const grow = el('div', 'grow');
    grow.appendChild(el('span', 'tit', 'Código no login'));
    head.appendChild(grow);
    head.appendChild(el('span', `mfa-state ${ligada ? 'on' : 'off'}`, ligada ? 'Ativada' : 'Desativada'));
    host.appendChild(head);

    host.appendChild(el('p', 'mfa-desc', ligada
        ? 'Ao entrar, além da senha pedimos um código de 6 dígitos do seu app autenticador. Mesmo quem descobrir sua senha não entra sem o seu celular.'
        : 'Some uma segunda camada ao seu login: além da senha, um código de 6 dígitos que só existe no seu celular. É opcional — sua conta funciona normalmente sem ela.'));

    const cta = el('button', `mfa-cta${ligada ? ' danger' : ''}`, ligada ? 'Desativar' : 'Ativar verificação em duas etapas');
    cta.type = 'button';
    cta.addEventListener('click', () => (ligada ? telaDesligar(host) : telaAtivar(host)));
    host.appendChild(cta);
}

// ── Tela 2: QR + primeiro código ───────────────────────────────────────────
async function telaAtivar(host) {
    host.replaceChildren(el('p', 'sec-muted', 'Preparando…'));

    let dados;
    try {
        dados = await enrollMfa();
    } catch (e) {
        const msg = String(e?.message ?? '');
        host.replaceChildren(el('p', 'sec-muted',
            msg === 'mfa_ja_ativo'
                ? 'A verificação já está ativa nesta conta.'
                : 'Não foi possível iniciar a ativação agora.'));
        const voltar = el('button', 'mfa-link', 'Voltar');
        voltar.type = 'button';
        voltar.addEventListener('click', () => montarMfa(host));
        host.appendChild(voltar);
        return;
    }

    host.replaceChildren();
    host.appendChild(el('div', 'mfa-step', 'Passo 1 de 2'));
    host.appendChild(el('p', 'mfa-desc', `Abra seu app autenticador e escaneie o código abaixo. Serve qualquer um: ${APPS_SUGERIDOS}`));

    const src = _qrSrc(dados.qrCode);
    if (src) {
        const img = document.createElement('img');
        img.className = 'mfa-qr';
        img.src = src;                       // SVG dentro de <img> é inerte: não roda script
        img.alt = 'QR code para o app autenticador';
        host.appendChild(img);
    }

    // Digitação manual: câmera quebrada, autenticador no mesmo aparelho, ou
    // simplesmente preferência. Sem isso, uma parte dos usuários trava aqui.
    if (dados.secret) {
        host.appendChild(el('p', 'mfa-desc', 'Sem câmera? Digite esta chave no app (toque para copiar):'));
        const seg = el('div', 'mfa-secret', dados.secret);
        seg.setAttribute('role', 'button');
        seg.setAttribute('tabindex', '0');
        const copiar = async () => {
            try {
                await navigator.clipboard.writeText(dados.secret);
                const antes = seg.textContent;
                seg.textContent = 'Copiado!';
                setTimeout(() => { seg.textContent = antes; }, 1400);
            } catch { /* clipboard bloqueado: a chave continua visível para digitar */ }
        };
        seg.addEventListener('click', copiar);
        seg.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); copiar(); } });
        host.appendChild(seg);
    }

    host.appendChild(el('div', 'mfa-step', 'Passo 2 de 2'));
    host.appendChild(el('p', 'mfa-desc', 'Digite o código de 6 dígitos que apareceu no app:'));

    const input = document.createElement('input');
    input.className = 'mfa-input';
    input.type = 'text';
    input.inputMode = 'numeric';
    input.autocomplete = 'one-time-code';
    input.maxLength = 6;
    input.setAttribute('aria-label', 'Código do app autenticador');
    host.appendChild(input);

    const erro = el('p', 'mfa-err', '');
    erro.setAttribute('role', 'alert');
    host.appendChild(erro);

    const confirmar = el('button', 'mfa-cta', 'Confirmar e ativar');
    confirmar.type = 'button';
    host.appendChild(confirmar);

    const cancelar = el('button', 'mfa-link', 'Cancelar');
    cancelar.type = 'button';
    cancelar.addEventListener('click', () => montarMfa(host));
    host.appendChild(cancelar);

    let enviando = false;
    const enviar = async () => {
        if (enviando) return;
        const code = input.value.replace(/\D/g, '');
        if (code.length !== 6) { erro.textContent = 'O código tem 6 dígitos.'; return; }

        enviando = true;
        confirmar.disabled = true;
        confirmar.textContent = 'Confirmando…';
        erro.textContent = '';
        try {
            const { recoveryCodes } = await activateMfa(dados.factorId, code);
            telaCodigos(host, recoveryCodes);
        } catch {
            // Causa nº 1 aqui é relógio do celular fora de hora — o TOTP depende
            // do horário, e o usuário não tem como adivinhar isso sozinho.
            erro.textContent = 'Código incorreto. Confira se a hora do celular está automática e tente o código atual.';
            input.value = '';
            input.focus();
        } finally {
            enviando = false;
            confirmar.disabled = false;
            confirmar.textContent = 'Confirmar e ativar';
        }
    };

    input.addEventListener('input', () => {
        input.value = input.value.replace(/\D/g, '').slice(0, 6);
        if (input.value.length === 6) enviar();
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') enviar(); });
    confirmar.addEventListener('click', enviar);
    setTimeout(() => input.focus(), 60);
}

// ── Tela 3: códigos de recuperação (mostrados UMA vez) ─────────────────────
function telaCodigos(host, codigos) {
    host.replaceChildren();
    host.appendChild(el('div', 'mfa-step', 'Ativada com sucesso'));

    if (!Array.isArray(codigos) || codigos.length === 0) {
        // O 2FA está ativo, mas os códigos falharam. Silenciar isso deixaria o
        // usuário achando que tem uma rede de segurança que ele não tem.
        host.appendChild(el('div', 'mfa-warn',
            'A verificação em duas etapas está ATIVA, mas não consegui gerar seus códigos de '
            + 'recuperação. Guarde bem o acesso ao seu app autenticador e tente desativar e '
            + 'reativar a verificação mais tarde para gerar os códigos.'));
        const ok = el('button', 'mfa-cta', 'Entendi');
        ok.type = 'button';
        ok.addEventListener('click', () => montarMfa(host));
        host.appendChild(ok);
        return;
    }

    host.appendChild(el('p', 'mfa-desc',
        'Guarde estes códigos num lugar seguro. Cada um funciona UMA vez e serve para entrar '
        + 'se você perder o celular. Esta é a única vez que eles aparecem.'));

    const grade = el('div', 'mfa-codes');
    for (const c of codigos) grade.appendChild(el('span', null, String(c)));
    host.appendChild(grade);

    const baixar = el('button', 'mfa-cta', 'Baixar códigos (.txt)');
    baixar.type = 'button';
    baixar.addEventListener('click', () => {
        const texto = [
            'GranaEvo — códigos de recuperação da verificação em duas etapas',
            `Gerados em ${new Date().toLocaleString('pt-BR')}`,
            '',
            'Cada código funciona UMA vez. Usar um deles DESATIVA a verificação',
            'em duas etapas — reative depois em Configurações > Segurança da conta.',
            '',
            ...codigos.map(c => `  ${c}`),
            '',
        ].join('\n');
        const url = URL.createObjectURL(new Blob([texto], { type: 'text/plain;charset=utf-8' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = 'granaevo-codigos-recuperacao.txt';
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
    });
    host.appendChild(baixar);

    host.appendChild(el('div', 'mfa-warn',
        'Sem estes códigos e sem o celular, não há como recuperar o acesso à sua conta.'));

    // Só libera o "guardei" depois de baixar ou copiar? Não: prender o usuário
    // numa tela é pior. O aviso acima é explícito e ele decide.
    const pronto = el('button', 'mfa-link', 'Já guardei os códigos');
    pronto.type = 'button';
    pronto.addEventListener('click', () => montarMfa(host));
    host.appendChild(pronto);
}

// ── Tela 4: desligar (step-up por senha) ───────────────────────────────────
function telaDesligar(host) {
    host.replaceChildren();
    host.appendChild(el('div', 'mfa-step', 'Desativar verificação'));
    host.appendChild(el('p', 'mfa-desc',
        'Sua conta voltará a ser protegida apenas pela senha. Confirme sua senha para continuar.'));

    const input = document.createElement('input');
    input.className = 'mfa-input pw';
    input.type = 'password';
    input.autocomplete = 'current-password';
    input.placeholder = 'Sua senha';
    input.setAttribute('aria-label', 'Senha atual');
    host.appendChild(input);

    const erro = el('p', 'mfa-err', '');
    erro.setAttribute('role', 'alert');
    host.appendChild(erro);

    const confirmar = el('button', 'mfa-cta danger', 'Desativar');
    confirmar.type = 'button';
    host.appendChild(confirmar);

    const cancelar = el('button', 'mfa-link', 'Cancelar');
    cancelar.type = 'button';
    cancelar.addEventListener('click', () => montarMfa(host));
    host.appendChild(cancelar);

    let enviando = false;
    const enviar = async () => {
        if (enviando) return;
        if (!input.value) { erro.textContent = 'Digite sua senha.'; return; }

        enviando = true;
        confirmar.disabled = true;
        confirmar.textContent = 'Desativando…';
        erro.textContent = '';
        try {
            await disableMfa(input.value);
            input.value = '';
            montarMfa(host);
        } catch (e) {
            const msg = String(e?.message ?? '');
            erro.textContent = msg === 'senha_incorreta'
                ? 'Senha incorreta.'
                : 'Não foi possível desativar agora. Tente de novo.';
            input.value = '';
            input.focus();
        } finally {
            enviando = false;
            confirmar.disabled = false;
            confirmar.textContent = 'Desativar';
        }
    };

    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') enviar(); });
    confirmar.addEventListener('click', enviar);
    setTimeout(() => input.focus(), 60);
}
