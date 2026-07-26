// ----------------------------------------------------------------------------
// notificacoes-inbox.js — caixa de entrada das notificações (LAZY)
//
// POR QUE EXISTE: tudo o que o servidor empurrava (Radar, lembretes, convite de
// reserva compartilhada) vivia SÓ como push do sistema. Quem não viu a bolha na
// hora perdia o aviso para sempre — o sino do app mostrava apenas contas a
// vencer, calculadas no cliente na hora. O usuário resumiu bem: "as notificações
// nunca ficam salvas no menu para eu ver ou excluir".
//
// Cada aviso já é uma linha em `radar_notifications` (RLS: só o dono lê). Este
// módulo lê essas linhas e as mostra no painel do sino, com um X para dispensar.
// Dispensar marca `dismissed_at` em vez de apagar: a linha `status='sent'` é o
// que impede o mesmo evento de notificar de novo — apagá-la traria o aviso de
// volta no próximo sync do Radar.
//
// PRIVACIDADE: title/body ficam em claro na tabela e por regra do Radar NUNCA
// contêm valores em R$. Este módulo só exibe o que veio de lá — não formata
// dinheiro, não lê o blob financeiro.
//
// LAZY de propósito: só é importado quando o sino abre (e uma vez no boot ocioso,
// só para a contagem do badge). Nada disto pesa no chunk crítico do dashboard.
// ----------------------------------------------------------------------------

import { supabase } from '../services/supabase-client.js?v=2';

const MAX_LINHAS = 30;
// Contagem em cache: o badge do sino é desenhado no boot, muito antes de qualquer
// rede. Sem um valor local ele piscaria de "0" para "3" ou (pior) mentiria "0".
const LS_COUNT = 'ge_inbox_count';

/** Ícone e cor por tipo de aviso — mesma linguagem visual do painel de alertas. */
const ESTILO = {
    conta_vence:       { icone: 'fa-file-invoice-dollar', cor: '#ff8c32' },
    fatura_fecha:      { icone: 'fa-credit-card',         cor: '#4ca6ff' },
    assinatura_renova: { icone: 'fa-rotate',              cor: '#a78bfa' },
    orcamento_estouro: { icone: 'fa-chart-pie',           cor: '#ff4b4b' },
    lembrete:          { icone: 'fa-bell',                cor: '#ffd166' },
    resumo_semanal:    { icone: 'fa-chart-line',          cor: '#4ca6ff' },
    meta_batida:       { icone: 'fa-trophy',              cor: '#22c55e' },
    convite_reserva:   { icone: 'fa-user-group',          cor: '#22c55e' },
};
const ESTILO_PADRAO = { icone: 'fa-bell', cor: '#4ca6ff' };

/** Contagem em cache (síncrona, para o badge no boot). Nunca falha. */
export function contagemEmCache() {
    try {
        const n = parseInt(localStorage.getItem(LS_COUNT) || '0', 10);
        return Number.isInteger(n) && n > 0 ? n : 0;
    } catch { return 0; }
}
function _guardarContagem(n) {
    try { localStorage.setItem(LS_COUNT, String(Math.max(0, n | 0))); } catch { /* ls bloqueado */ }
}

/**
 * Avisos do usuário logado ainda não dispensados, mais novos primeiro.
 * Traz TODOS os status: 'failed' (nenhum aparelho inscrito para push) é
 * justamente o caso em que o app é o único lugar onde a pessoa vai ver o aviso.
 * @returns {Promise<Array>} [] em qualquer falha — o sino nunca quebra por isso.
 */
export async function carregarInbox() {
    try {
        const { data: { session } } = await supabase.auth.getSession();
        const uid = session?.user?.id;
        if (!uid) return [];
        const { data, error } = await supabase
            .from('radar_notifications')
            .select('id, tipo, title, body, url, status, created_at, fire_at')
            .eq('user_id', uid)
            .is('dismissed_at', null)
            .order('created_at', { ascending: false })
            .limit(MAX_LINHAS);
        if (error) return [];
        const linhas = data ?? [];
        _guardarContagem(linhas.length);
        return linhas;
    } catch { return []; }
}

/** Só a contagem (para o badge no boot). Barata: count exato, sem trazer linhas. */
export async function atualizarContagem() {
    try {
        const { data: { session } } = await supabase.auth.getSession();
        const uid = session?.user?.id;
        if (!uid) return 0;
        const { count, error } = await supabase
            .from('radar_notifications')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', uid)
            .is('dismissed_at', null);
        if (error) return contagemEmCache();
        _guardarContagem(count ?? 0);
        return count ?? 0;
    } catch { return contagemEmCache(); }
}

/**
 * Dispensa um aviso (o X do card). Marca `dismissed_at` — não apaga a linha,
 * senão o dedupe do Radar reagendaria o mesmo evento no próximo sync.
 * @returns {Promise<boolean>}
 */
export async function dispensar(id) {
    if (!id) return false;
    try {
        const { error } = await supabase
            .from('radar_notifications')
            .update({ dismissed_at: new Date().toISOString() })
            .eq('id', id);
        if (error) return false;
        _guardarContagem(contagemEmCache() - 1);
        return true;
    } catch { return false; }
}

/**
 * Carrega + renderiza numa chamada só. É o que o sino usa: mantém o dashboard
 * (chunk crítico, orçamento apertado) sem nada além da chamada e dos callbacks.
 *
 * @param {{ onAbrir:(tela:string)=>void, onDispensar:Function }} handlers
 *        `onAbrir` recebe a ABA já extraída da url ('reservas'), não a url crua.
 * @returns {Promise<HTMLElement|null>}
 */
export async function montarInbox({ onAbrir, onDispensar } = {}) {
    const linhas = await carregarInbox();
    return renderInbox(linhas, {
        // url é sempre um caminho interno ('/dashboard#reservas'); a aba é o
        // fragmento. Sem fragmento, quem chamou só fecha o painel.
        onAbrir: (n) => onAbrir?.(String(n?.url ?? '').split('#')[1] ?? ''),
        onDispensar,
    });
}

/** "agora", "há 3 h", "há 2 d" — sem biblioteca de datas. */
function _quando(iso) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '';
    const min = Math.floor((Date.now() - t) / 60000);
    if (min < 1)    return 'agora';
    if (min < 60)   return `há ${min} min`;
    const h = Math.floor(min / 60);
    if (h < 24)     return `há ${h} h`;
    const d = Math.floor(h / 24);
    if (d < 30)     return `há ${d} d`;
    return new Date(t).toLocaleDateString('pt-BR');
}

/**
 * Monta a lista de avisos. Sem innerHTML: title/body vêm do banco e são
 * inseridos com textContent (não há como injetar markup por aqui).
 *
 * @param {Array} linhas               saída de carregarInbox()
 * @param {{ onAbrir:Function, onDispensar:Function }} handlers
 * @returns {HTMLElement|null} null quando não há nada
 */
export function renderInbox(linhas, { onAbrir, onDispensar } = {}) {
    if (!Array.isArray(linhas) || linhas.length === 0) return null;

    const sec = document.createElement('div');
    sec.style.cssText = 'margin-bottom:18px;';

    const header = document.createElement('div');
    header.style.cssText = 'display:flex; align-items:center; gap:8px; margin-bottom:10px; padding-bottom:8px; border-bottom:1px solid rgba(255,255,255,0.08);';
    const hIcon = document.createElement('i');
    hIcon.className = 'fas fa-inbox';
    hIcon.style.cssText = 'color:#22c55e; font-size:0.9rem;';
    hIcon.setAttribute('aria-hidden', 'true');
    const hTit = document.createElement('span');
    hTit.style.cssText = 'font-weight:700; font-size:0.85rem; color:#22c55e; text-transform:uppercase; letter-spacing:0.5px;';
    hTit.textContent = `Avisos (${linhas.length})`;
    header.appendChild(hIcon); header.appendChild(hTit);
    sec.appendChild(header);

    linhas.forEach((n) => {
        const est = ESTILO[n.tipo] || ESTILO_PADRAO;

        const card = document.createElement('div');
        card.className = 'alerta-card';
        card.style.cssText = `
            background: ${est.cor}1a;
            border-left: 3px solid ${est.cor};
            border-radius: 12px;
            padding: 12px 14px;
            margin-bottom: 10px;
            display: flex;
            align-items: flex-start;
            gap: 10px;
        `;

        const icone = document.createElement('i');
        icone.className = `fas ${est.icone}`;
        icone.style.cssText = `color:${est.cor}; font-size:0.95rem; margin-top:3px; flex-shrink:0;`;
        icone.setAttribute('aria-hidden', 'true');

        const texto = document.createElement('div');
        texto.style.cssText = 'flex:1; min-width:0;';
        if (n.url) {
            texto.style.cursor = 'pointer';
            texto.addEventListener('click', () => onAbrir?.(n));
        }

        const tit = document.createElement('div');
        tit.style.cssText = 'font-weight:700; color:var(--text-primary); font-size:0.92rem; margin-bottom:3px;';
        tit.textContent = String(n.title ?? '');

        const corpo = document.createElement('div');
        corpo.style.cssText = 'font-size:0.84rem; color:var(--text-secondary); line-height:1.4;';
        corpo.textContent = String(n.body ?? '');

        const quando = document.createElement('div');
        quando.style.cssText = 'font-size:0.75rem; color:var(--text-muted); margin-top:5px;';
        quando.textContent = _quando(n.created_at);

        texto.appendChild(tit); texto.appendChild(corpo); texto.appendChild(quando);

        const btnX = document.createElement('button');
        btnX.type = 'button';
        btnX.setAttribute('aria-label', 'Dispensar aviso');
        btnX.style.cssText = 'background:none; border:none; color:var(--text-muted); cursor:pointer; padding:4px 6px; font-size:0.9rem; flex-shrink:0;';
        const xIcon = document.createElement('i');
        xIcon.className = 'fas fa-times';
        xIcon.setAttribute('aria-hidden', 'true');
        btnX.appendChild(xIcon);
        btnX.addEventListener('click', async (e) => {
            e.stopPropagation();
            btnX.disabled = true;
            const ok = await dispensar(n.id);
            if (!ok) { btnX.disabled = false; return; }
            card.remove();
            const restantes = sec.querySelectorAll('.alerta-card').length;
            hTit.textContent = `Avisos (${restantes})`;
            if (restantes === 0) sec.remove();
            onDispensar?.(n);
        });

        card.appendChild(icone); card.appendChild(texto); card.appendChild(btnX);
        sec.appendChild(card);
    });

    return sec;
}
