// restaurar-perfil.js — o botão de desfazer a exclusão, na tela de seleção
// ---------------------------------------------------------------------------
// Ver docs/exclusao-de-perfil-desenho.md. Carregado sob demanda: só a tela de
// seleção de perfis o usa, e ele fala com a rede de qualquer jeito.
//
// Recebe do dashboard o que precisa (init) em vez de importar: o mesmo contrato
// dos outros chunks lazy deste projeto.
// ---------------------------------------------------------------------------

let _ui = null;

export function init(ui) { _ui = ui; }

// ═══════════════════════════════════════════════════════════════════════════
//
// Fica na tela de seleção porque é para onde o usuário vai logo depois de
// excluir: ele vê na hora que dá para desfazer. Só aparece quando existe algo
// restaurável — botão morto ensina o usuário a ignorar a área.
// ═══════════════════════════════════════════════════════════════════════════

/** "6 dias" / "20 horas" / "45 minutos" — o que resta até a remoção definitiva. */
export function _prazoRestante(iso) {
    const ms = new Date(iso).getTime() - Date.now();
    if (!Number.isFinite(ms) || ms <= 0) return 'expirando';
    const min = Math.floor(ms / 60000);
    if (min < 60)   return `${min} ${min === 1 ? 'minuto' : 'minutos'}`;
    const horas = Math.floor(min / 60);
    if (horas < 24) return `${horas} ${horas === 1 ? 'hora' : 'horas'}`;
    const dias = Math.floor(horas / 24);
    return `${dias} ${dias === 1 ? 'dia' : 'dias'}`;
}

export async function _apiPerfil(action, profileId) {
    const { supabase } = await import('../services/supabase-client.js?v=2');
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;
    if (!token) throw new Error('SEM_SESSAO');
    const resp = await fetch('/api/user-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(profileId ? { action, profile_id: String(profileId) } : { action }),
    });
    const corpo = await resp.json().catch(() => ({}));
    if (!resp.ok) { const e = new Error(corpo?.code || corpo?.error || `HTTP_${resp.status}`); e.corpo = corpo; throw e; }
    return corpo;
}

export async function montarRestauracaoDePerfis() {
    const alvo = document.getElementById('listaPerfis');
    if (!alvo || _ui.usuarioLogado?.isGuest) return;   // convidado não gerencia perfis

    let dados;
    try { dados = await _apiPerfil('list-deleted-profiles'); }
    catch { return; }                              // silencioso: é um extra da tela

    const perfis = Array.isArray(dados?.perfis) ? dados.perfis : [];
    document.getElementById('blocoRestaurarPerfil')?.remove();
    if (!perfis.length) return;

    const bloco = document.createElement('div');
    bloco.id = 'blocoRestaurarPerfil';
    bloco.style.cssText = 'margin-top:18px; padding-top:16px; border-top:1px solid rgba(255,255,255,0.08);';

    const titulo = document.createElement('div');
    titulo.style.cssText = 'font-size:0.78rem; font-weight:700; color:rgba(255,255,255,0.55); margin-bottom:10px; letter-spacing:0.03em;';
    titulo.textContent = 'RESTAURAR UM PERFIL EXCLUÍDO';
    bloco.appendChild(titulo);

    for (const p of perfis) {
        const linha = document.createElement('div');
        linha.style.cssText = 'display:flex; align-items:center; gap:12px; background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08); border-radius:12px; padding:11px 14px; margin-bottom:8px;';

        const texto = document.createElement('div');
        texto.style.cssText = 'flex:1; min-width:0;';
        const nome = document.createElement('div');
        nome.style.cssText = 'font-size:0.92rem; color:rgba(255,255,255,0.9); font-weight:600;';
        nome.textContent = _ui.sanitizeText(p.nome || 'Perfil');   // textContent: nome é do usuário
        const prazo = document.createElement('div');
        prazo.style.cssText = 'font-size:0.75rem; color:rgba(255,255,255,0.45); margin-top:2px;';
        prazo.textContent = `Removido definitivamente em ${_prazoRestante(p.expira_em)}`;
        texto.append(nome, prazo);

        const btn = document.createElement('button');
        btn.className = 'btn-primary';
        btn.type = 'button';
        btn.style.cssText = 'flex:0 0 auto; padding:7px 14px; font-size:0.82rem;';
        btn.textContent = 'Restaurar';
        btn.addEventListener('click', () => _confirmarRestauracao(p, btn));

        linha.append(texto, btn);
        bloco.appendChild(linha);
    }

    alvo.parentElement?.appendChild(bloco);
}

export function _confirmarRestauracao(perfil, btn) {
    const nome = _ui.sanitizeText(perfil.nome || 'Perfil');
    _ui.criarPopupDOM((box) => {
        box.style.maxWidth = '420px';
        const h3 = document.createElement('h3');
        h3.textContent = 'Restaurar perfil';
        h3.style.marginBottom = '12px';

        const txt = document.createElement('p');
        txt.style.cssText = 'font-size:0.9rem; color:rgba(255,255,255,0.7); line-height:1.6; margin-bottom:16px;';
        txt.textContent = `Deseja restaurar o perfil "${nome}" com todos os dados que ele tinha?`;

        const row = document.createElement('div');
        row.style.cssText = 'display:flex; gap:10px;';

        const sim = document.createElement('button');
        sim.className = 'btn-primary';
        sim.type = 'button';
        sim.style.flex = '1';
        sim.textContent = 'Sim, restaurar';

        const nao = document.createElement('button');
        nao.className = 'btn-cancelar';
        nao.type = 'button';
        nao.textContent = 'Cancelar';
        nao.addEventListener('click', () => _ui.fecharPopup());

        sim.addEventListener('click', async () => {
            sim.disabled = true; nao.disabled = true; sim.textContent = 'Restaurando…';
            try {
                await _apiPerfil('restore-profile', perfil.profile_id);
                _ui.fecharPopup();
                _ui.mostrarNotificacao(`Perfil "${nome}" restaurado.`, 'success');
                setTimeout(() => window.location.reload(), 800);
            } catch (e) {
                _ui.fecharPopup();
                // O limite é conferido no SERVIDOR, no instante em que o perfil
                // volta a existir. Esta mensagem é a tradução daquela recusa.
                if (e?.message === 'PROFILE_LIMIT_REACHED') {
                    const { ativos, limite } = e.corpo ?? {};
                    _ui.mostrarNotificacao(
                        `Você já atingiu o limite de ${limite ?? ''} perfis${ativos ? ` (${ativos} ativos)` : ''}. ` +
                        'Exclua um perfil antes de restaurar este.', 'warning');
                } else {
                    _ui.mostrarNotificacao('Não foi possível restaurar o perfil. Tente novamente.', 'error');
                }
                if (btn) { btn.disabled = false; btn.textContent = 'Restaurar'; }
            }
        });

        row.append(sim, nao);
        box.append(h3, txt, row);
    });
}
