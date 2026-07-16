// ----------------------------------------------------------------------------
// reserva-familia.js — reserva compartilhada da conta (item 13)
//
// O pedido não era "reserva compartilhada": era "todos colocam e tiram, SEMPRE
// mostrando quem colocou e quem retirou". A trilha não é um detalhe do recurso
// — é o recurso. Sem ela, é um número que some sozinho e vira briga.
//
// ── POR QUE ISTO NÃO MORA NO BLOB ───────────────────────────────────────────
// Todo o resto do app vive em `user_data.data_json`, um blob por conta. O
// convidado LÊ o blob do dono, mas não escreve: quem grava é /api/user-data,
// com service_role, resolvendo o dono no servidor. No blob, portanto, uma
// reserva compartilhada seria read-only para quem não é titular — o oposto da
// regra. Daí duas tabelas próprias com RLS por `account_members`
// (migration 20260716120000).
//
// ── SALDO É DERIVADO ────────────────────────────────────────────────────────
// saldo = Σ(aporte) − Σ(retirada), calculado aqui e conferido no banco (trigger).
// Nunca guardado: um campo `saldo` seria segunda fonte de verdade e divergiria
// no primeiro erro de rede — silenciosamente, porque ninguém soma 200
// movimentos na mão para conferir.
//
// ── O QUE É AUTORIDADE E O QUE É CORTESIA ───────────────────────────────────
// Nada aqui autoriza nada. Quem autoriza é o RLS. As checagens deste arquivo
// (saldo, janela de desfazer, pertencimento) existem só para a tela não
// oferecer um botão que o banco vai recusar. O servidor é a fonte da verdade:
// `podeDesfazer` espelha a política `srm_delete_recente_proprio`, e se as duas
// discordarem, quem manda é o banco.
// ----------------------------------------------------------------------------

import { supabase } from '../services/supabase-client.js?v=2';

/** Janela para desfazer o próprio lançamento — espelha o RLS (10 min). */
export const JANELA_DESFAZER_MS = 10 * 60 * 1000;

/** saldo = Σ(aporte) − Σ(retirada). Ignora linha corrompida em vez de virar NaN. */
export function saldoDe(movimentos) {
    if (!Array.isArray(movimentos)) return 0;
    let s = 0;
    for (const m of movimentos) {
        const v = Number(m?.valor);
        if (!isFinite(v) || v <= 0) continue;
        if (m.tipo === 'aporte') s += v;
        else if (m.tipo === 'retirada') s -= v;
    }
    return Math.round(s * 100) / 100;
}

/**
 * Quem colocou e quem tirou — o coração da feature.
 *
 * Devolve o LÍQUIDO por pessoa (aportes − retiradas), ordenado do que mais
 * contribuiu para o que menos. Mostrar só os aportes esconderia quem coloca
 * R$500 e tira R$400 todo mês; o líquido conta a história real, sem acusar
 * ninguém — só exibe o número.
 */
export function porMembro(movimentos) {
    if (!Array.isArray(movimentos)) return [];
    const mapa = new Map();
    for (const m of movimentos) {
        const v = Number(m?.valor);
        if (!isFinite(v) || v <= 0) continue;
        if (m.tipo !== 'aporte' && m.tipo !== 'retirada') continue;
        // Agrupa por pessoa, com o nome mais RECENTE que ela usou (o snapshot é
        // por movimento; quem trocou de nome não deve virar duas pessoas).
        const chave = String(m.member_user_id ?? `anon:${m.member_name}`);
        let e = mapa.get(chave);
        if (!e) { e = { id: m.member_user_id ?? null, nome: m.member_name || 'Membro', aportes: 0, retiradas: 0, liquido: 0 }; mapa.set(chave, e); }
        if (m.tipo === 'aporte') { e.aportes += v; e.liquido += v; }
        else                     { e.retiradas += v; e.liquido -= v; }
    }
    for (const e of mapa.values()) {
        e.aportes   = Math.round(e.aportes * 100) / 100;
        e.retiradas = Math.round(e.retiradas * 100) / 100;
        e.liquido   = Math.round(e.liquido * 100) / 100;
    }
    return [...mapa.values()].sort((a, b) => b.liquido - a.liquido);
}

/**
 * Dá para desfazer este lançamento? Espelha `srm_delete_recente_proprio`.
 * Só o PRÓPRIO, e só dentro da janela — é o que mantém a trilha confiável:
 * quem pudesse apagar o próprio saque depois quebraria a promessa da feature.
 */
export function podeDesfazer(mov, uid, agora = new Date()) {
    if (!mov || !uid) return false;
    if (String(mov.member_user_id ?? '') !== String(uid)) return false;
    const t = Date.parse(mov.created_at);
    if (!isFinite(t)) return false;
    return (agora.getTime() - t) < JANELA_DESFAZER_MS;
}

/** Progresso rumo ao objetivo (0–100), ou null quando não há objetivo. */
export function progressoDe(saldo, objetivo) {
    const o = Number(objetivo);
    if (!isFinite(o) || o <= 0) return null;
    return Math.max(0, Math.min(100, (saldo / o) * 100));
}

/**
 * A feature só faz sentido em conta com mais de uma pessoa. Para quem usa
 * sozinho, uma "reserva da família" é ruído — as metas normais já servem.
 */
export function contaCompartilhada(usuarioLogado) {
    if (!usuarioLogado) return false;
    if (usuarioLogado.isGuest === true) return true;
    const p = String(usuarioLogado.plano ?? '').toLowerCase();
    return p === 'casal' || p === 'família' || p === 'familia';
}

// ─────────────────────────── Banco (RLS manda) ───────────────────────────────

/** Reservas ativas da conta + movimentos. `ownerUserId` = effectiveUserId. */
export async function carregarReservas(ownerUserId) {
    const { data: reservas, error: e1 } = await supabase
        .from('shared_reserves')
        .select('id, nome, objetivo, created_at')
        .eq('owner_user_id', ownerUserId)
        .is('archived_at', null)
        .order('created_at', { ascending: true });
    if (e1) throw e1;
    if (!reservas || reservas.length === 0) return [];

    const { data: movs, error: e2 } = await supabase
        .from('shared_reserve_movements')
        .select('id, reserve_id, member_user_id, member_name, tipo, valor, nota, created_at')
        .in('reserve_id', reservas.map(r => r.id))
        .order('created_at', { ascending: false })
        .limit(500);
    if (e2) throw e2;

    const porReserva = new Map(reservas.map(r => [r.id, []]));
    for (const m of (movs || [])) porReserva.get(m.reserve_id)?.push(m);

    return reservas.map(r => {
        const ms = porReserva.get(r.id) || [];
        return { ...r, movimentos: ms, saldo: saldoDe(ms) };
    });
}

/** Cria a reserva. `owner_user_id`/`created_by` são reconferidos pelo RLS. */
export async function criarReserva(ownerUserId, uid, nome, objetivo) {
    const { data, error } = await supabase
        .from('shared_reserves')
        .insert({
            owner_user_id: ownerUserId,
            created_by:    uid,
            nome:          String(nome ?? '').trim().slice(0, 60) || 'Reserva da família',
            objetivo:      (isFinite(Number(objetivo)) && Number(objetivo) > 0) ? Number(objetivo) : null,
        })
        .select('id, nome, objetivo, created_at')
        .single();
    if (error) throw error;
    return data;
}

/**
 * Lança aporte/retirada. Note o que NÃO é enviado: `owner_user_id` e
 * `created_at` são sobrescritos pelo trigger, e `member_user_id` é conferido
 * contra o auth.uid() pelo RLS — o cliente não escolhe em nome de quem lança.
 */
export async function lancarMovimento(reserveId, ownerUserId, uid, nome, tipo, valor, nota) {
    const v = Number(valor);
    if (!isFinite(v) || v <= 0) throw new Error('valor inválido');
    if (tipo !== 'aporte' && tipo !== 'retirada') throw new Error('tipo inválido');

    const { data, error } = await supabase
        .from('shared_reserve_movements')
        .insert({
            reserve_id:     reserveId,
            owner_user_id:  ownerUserId,     // trigger sobrescreve com o dono real
            member_user_id: uid,
            member_name:    String(nome ?? '').trim().slice(0, 80) || 'Membro',
            tipo,
            valor:          Math.round(v * 100) / 100,
            nota:           nota ? String(nota).trim().slice(0, 140) : null,
        })
        .select('id, member_user_id, member_name, tipo, valor, nota, created_at')
        .single();
    if (error) throw error;
    return data;
}

/** Desfaz o próprio lançamento recente. Fora da janela, o RLS recusa. */
export async function desfazerMovimento(movId) {
    const { error } = await supabase.from('shared_reserve_movements').delete().eq('id', movId);
    if (error) throw error;
}

// ─────────────────────────── UI ──────────────────────────────────────────────

const _quem = (ctx) => ({
    owner: ctx.usuarioLogado?.effectiveUserId || ctx.usuarioLogado?.userId,
    uid:   ctx.usuarioLogado?.userId,
    nome:  ctx.perfilAtivo?.nome || ctx.usuarioLogado?.nome || 'Membro',
});

const _hora = (iso) => {
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
};

/**
 * Card no topo de Reservas. Silencioso em conta individual e silencioso quando
 * a rede falha: uma reserva que "some" assustaria mais do que ajudaria — o
 * usuário abriria o app achando que perdeu dinheiro.
 */
export async function renderCardFamiliaEm(container, ctx) {
    if (!container || !ctx) return;
    if (!contaCompartilhada(ctx.usuarioLogado)) return;

    const { owner } = _quem(ctx);
    if (!owner) return;

    let reservas;
    try {
        reservas = await carregarReservas(owner);
    } catch {
        return;                       // offline/erro: não mostra caixa vazia
    }

    const card = document.createElement('div');
    card.className = 'rf-card';
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');

    const icon = document.createElement('div');
    icon.className = 'rf-icon';
    const ic = document.createElement('i');
    ic.className = 'fas fa-users';
    ic.setAttribute('aria-hidden', 'true');
    icon.appendChild(ic);

    const body = document.createElement('div');
    body.className = 'rf-body';
    const label = document.createElement('div');
    label.className = 'rf-label';
    label.textContent = 'Reserva da família';

    if (reservas.length === 0) {
        card.setAttribute('aria-label', 'Criar reserva da família');
        const sub = document.createElement('div');
        sub.className = 'rf-sub';
        sub.textContent = 'Criem juntos uma reserva — todo mundo vê quem colocou e quem tirou';
        body.appendChild(label);
        body.appendChild(sub);
    } else {
        const total = reservas.reduce((s, r) => s + r.saldo, 0);
        const membros = porMembro(reservas.flatMap(r => r.movimentos));
        const valor = document.createElement('div');
        valor.className = 'rf-valor';
        valor.textContent = ctx.formatBRL(total);
        const sub = document.createElement('div');
        sub.className = 'rf-sub';
        sub.textContent = membros.length > 0
            ? membros.slice(0, 3).map(m => `${m.nome}: ${ctx.formatBRL(m.liquido)}`).join(' · ')
            : 'Ninguém colocou nada ainda';
        card.setAttribute('aria-label', 'Abrir reserva da família');
        body.appendChild(label);
        body.appendChild(valor);
        body.appendChild(sub);
    }

    const seta = document.createElement('i');
    seta.className = 'fas fa-chevron-right rf-seta';
    seta.setAttribute('aria-hidden', 'true');

    card.appendChild(icon);
    card.appendChild(body);
    card.appendChild(seta);

    const abrir = () => abrirPopupReservaFamilia(ctx);
    card.addEventListener('click', abrir);
    card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); abrir(); }
    });

    container.appendChild(card);
}

function _formMovimento(ctx, popup, reserva, recarregar) {
    const { owner, uid, nome } = _quem(ctx);

    const row = document.createElement('div');
    row.className = 'rf-form';

    const input = document.createElement('input');
    input.className = 'form-input';
    input.type = 'number';
    input.min = '0.01';
    input.step = '0.01';
    input.placeholder = 'Valor';

    const nota = document.createElement('input');
    nota.className = 'form-input';
    nota.type = 'text';
    nota.maxLength = 140;
    nota.placeholder = 'Do que se trata? (opcional)';

    const btns = document.createElement('div');
    btns.className = 'rf-form-btns';

    const lancar = async (tipo) => {
        const v = parseFloat(input.value);
        if (!isFinite(v) || v <= 0) { ctx.mostrarNotificacao('Informe um valor.', 'error'); return; }
        // Conferência de cortesia: o banco recusa saque sem saldo de qualquer
        // forma (trigger), mas o aviso local é mais claro que um erro genérico.
        if (tipo === 'retirada' && v > reserva.saldo) {
            ctx.mostrarNotificacao('A reserva não tem esse saldo.', 'error');
            return;
        }
        try {
            await lancarMovimento(reserva.id, owner, uid, nome, tipo, v, nota.value);
            ctx.mostrarNotificacao(tipo === 'aporte' ? 'Guardado!' : 'Retirado.', 'success');
            await recarregar();
        } catch (e) {
            ctx.mostrarNotificacao(_msgErro(e), 'error');
        }
    };

    const bAporte = document.createElement('button');
    bAporte.className = 'btn-primary';
    bAporte.type = 'button';
    bAporte.textContent = 'Colocar';
    bAporte.addEventListener('click', () => lancar('aporte'));

    const bRetira = document.createElement('button');
    bRetira.className = 'btn-cancelar';
    bRetira.type = 'button';
    bRetira.textContent = 'Retirar';
    bRetira.addEventListener('click', () => lancar('retirada'));

    btns.appendChild(bAporte);
    btns.appendChild(bRetira);
    row.appendChild(input);
    row.appendChild(nota);
    row.appendChild(btns);
    popup.appendChild(row);
}

// O banco fala em SQL; o usuário, não. Traduz o que é acionável e esconde o
// resto (mensagem de erro de banco não é informação, é vazamento).
function _msgErro(e) {
    const m = String(e?.message || '');
    if (m.includes('saldo insuficiente')) return 'A reserva não tem esse saldo.';
    if (m.includes('limite de 5'))        return 'Limite de 5 reservas por conta.';
    if (m.includes('reserva inexistente')) return 'Essa reserva não existe mais.';
    return 'Não foi possível agora. Tente de novo.';
}

/** Popup: saldo, quem colocou/tirou, extrato e os botões. */
export async function abrirPopupReservaFamilia(ctx) {
    const { owner, uid } = _quem(ctx);

    ctx.criarPopupDOM(async (popup) => {
        const recarregar = async () => {
            popup.textContent = '';
            let reservas = [];
            try { reservas = await carregarReservas(owner); }
            catch { ctx.mostrarNotificacao('Não foi possível carregar agora.', 'error'); ctx.fecharPopup(); return; }

            const titulo = document.createElement('h3');
            titulo.textContent = 'Reserva da família';
            popup.appendChild(titulo);

            if (reservas.length === 0) {
                const p = document.createElement('p');
                p.className = 'rf-intro';
                p.textContent = 'Uma reserva que todo mundo da conta enxerga. Qualquer um coloca ou tira — e fica registrado quem fez o quê.';
                popup.appendChild(p);

                const inNome = document.createElement('input');
                inNome.className = 'form-input';
                inNome.type = 'text';
                inNome.maxLength = 60;
                inNome.placeholder = 'Nome (ex.: Viagem de fim de ano)';
                const inObj = document.createElement('input');
                inObj.className = 'form-input';
                inObj.type = 'number';
                inObj.min = '0.01';
                inObj.step = '0.01';
                inObj.placeholder = 'Objetivo em R$ (opcional)';
                inObj.style.marginTop = '8px';
                popup.appendChild(inNome);
                popup.appendChild(inObj);

                const bCriar = document.createElement('button');
                bCriar.className = 'btn-primary';
                bCriar.type = 'button';
                bCriar.style.cssText = 'width:100%; margin-top:10px;';
                bCriar.textContent = 'Criar reserva';
                bCriar.addEventListener('click', async () => {
                    try {
                        await criarReserva(owner, uid, inNome.value, inObj.value);
                        await recarregar();
                    } catch (e) { ctx.mostrarNotificacao(_msgErro(e), 'error'); }
                });
                popup.appendChild(bCriar);
            } else {
                for (const r of reservas) {
                    const bloco = document.createElement('div');
                    bloco.className = 'rf-reserva';

                    const h = document.createElement('div');
                    h.className = 'rf-reserva-nome';
                    h.textContent = r.nome;             // textContent — nunca innerHTML
                    bloco.appendChild(h);

                    const v = document.createElement('div');
                    v.className = 'rf-reserva-saldo';
                    v.textContent = ctx.formatBRL(r.saldo);
                    bloco.appendChild(v);

                    const prog = progressoDe(r.saldo, r.objetivo);
                    if (prog !== null) {
                        const barra = document.createElement('div');
                        barra.className = 'rf-barra';
                        const fill = document.createElement('div');
                        fill.className = 'rf-barra-fill';
                        fill.style.width = `${prog}%`;
                        barra.appendChild(fill);
                        bloco.appendChild(barra);
                        const meta = document.createElement('div');
                        meta.className = 'rf-reserva-meta';
                        meta.textContent = `${prog.toFixed(0)}% de ${ctx.formatBRL(r.objetivo)}`;
                        bloco.appendChild(meta);
                    }

                    // ── Quem colocou e quem tirou: a razão de a feature existir
                    const membros = porMembro(r.movimentos);
                    if (membros.length > 0) {
                        const lbl = document.createElement('div');
                        lbl.className = 'rf-secao';
                        lbl.textContent = 'Quem colocou';
                        bloco.appendChild(lbl);
                        for (const m of membros) {
                            const linha = document.createElement('div');
                            linha.className = 'rf-membro';
                            const n = document.createElement('span');
                            n.textContent = m.nome;
                            const q = document.createElement('span');
                            q.className = 'rf-membro-valor' + (m.liquido < 0 ? ' rf-neg' : '');
                            q.textContent = ctx.formatBRL(m.liquido);
                            if (m.retiradas > 0) {
                                q.title = `Colocou ${ctx.formatBRL(m.aportes)} · retirou ${ctx.formatBRL(m.retiradas)}`;
                            }
                            linha.appendChild(n);
                            linha.appendChild(q);
                            bloco.appendChild(linha);
                        }
                    }

                    _formMovimento(ctx, bloco, r, recarregar);

                    // ── Extrato
                    if (r.movimentos.length > 0) {
                        const lbl = document.createElement('div');
                        lbl.className = 'rf-secao';
                        lbl.textContent = 'Movimentações';
                        bloco.appendChild(lbl);

                        for (const m of r.movimentos.slice(0, 20)) {
                            const linha = document.createElement('div');
                            linha.className = 'rf-mov';
                            const txt = document.createElement('span');
                            txt.className = 'rf-mov-txt';
                            txt.textContent = `${m.member_name || 'Membro'} ${m.tipo === 'aporte' ? 'colocou' : 'retirou'}`
                                + (m.nota ? ` — ${m.nota}` : '');
                            const dir = document.createElement('span');
                            dir.className = 'rf-mov-dir';
                            const val = document.createElement('span');
                            val.className = 'rf-mov-valor' + (m.tipo === 'aporte' ? '' : ' rf-neg');
                            val.textContent = (m.tipo === 'aporte' ? '+' : '−') + ctx.formatBRL(m.valor);
                            const qd = document.createElement('span');
                            qd.className = 'rf-mov-hora';
                            qd.textContent = _hora(m.created_at);
                            dir.appendChild(val);
                            dir.appendChild(qd);
                            linha.appendChild(txt);
                            linha.appendChild(dir);

                            if (podeDesfazer(m, uid, new Date())) {
                                const und = document.createElement('button');
                                und.className = 'rf-undo';
                                und.type = 'button';
                                und.textContent = 'desfazer';
                                und.title = 'Só nos 10 primeiros minutos, e só o que você mesmo lançou';
                                und.addEventListener('click', async () => {
                                    try { await desfazerMovimento(m.id); await recarregar(); }
                                    catch { ctx.mostrarNotificacao('Passou do prazo para desfazer.', 'error'); }
                                });
                                linha.appendChild(und);
                            }
                            bloco.appendChild(linha);
                        }
                    }
                    popup.appendChild(bloco);
                }

                const nota = document.createElement('div');
                nota.className = 'rf-nota';
                nota.textContent = 'Cada lançamento fica registrado com o nome de quem fez. Dá para desfazer o seu nos 10 primeiros minutos.';
                popup.appendChild(nota);
            }

            const bFechar = document.createElement('button');
            bFechar.className = 'btn-cancelar';
            bFechar.type = 'button';
            bFechar.style.cssText = 'width:100%; margin-top:12px;';
            bFechar.textContent = 'Fechar';
            bFechar.addEventListener('click', ctx.fecharPopup);
            popup.appendChild(bFechar);
        };

        await recarregar();
    });
}
