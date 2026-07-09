// desafios.js — Desafios financeiros (lazy)
// ----------------------------------------------------------------------------
// Desafios com prazo em cima dos dados que o usuário já registra. Diferente
// das conquistas (retroativas), o desafio é um COMPROMISSO futuro: o usuário
// aceita, o engine avalia a janela a cada save e declara sucesso ou falha.
//
// Persistência: perfilData.desafios = { ativos: [...], historico: [...] }
// (mesmo blob user_data com RLS; sanitizado no save pelo dashboard).
// Desafios concluídos alimentam as conquistas (state.desafiosConcluidos).
//
// Segurança: ids validados contra o catálogo local; datas validadas por regex;
// render 100% via DOM API/textContent; caps de tamanho em todas as listas.
// ----------------------------------------------------------------------------

let _ctx = null;
let _debounceTimer = null;

const MAX_ATIVOS    = 2;
const MAX_HISTORICO = 60;
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

// ── Catálogo ──────────────────────────────────────────────────────────────────
// tipo 'evitar':   qualquer transação-violação dentro da janela = falha imediata;
//                  janela completa sem violação = sucesso.
// tipo 'cumprir':  julgado no FIM da janela pela função checkFinal.
export const DESAFIOS = Object.freeze([
    {
        id: 'semana_sem_delivery', dias: 7, tipo: 'evitar', icon: 'fa-fire',
        titulo: '7 dias sem delivery',
        desc: 'Uma semana inteira sem gastos de delivery (Ifood e afins).',
        violacao: (t) => (t.categoria === 'saida' || t.categoria === 'saida_credito') &&
                         (t.tipo === 'Ifood' || /ifood|rappi|delivery/i.test(String(t.descricao || ''))),
    },
    {
        id: 'quinze_dias_debito', dias: 15, tipo: 'evitar', icon: 'fa-credit-card',
        titulo: '15 dias só no débito',
        desc: 'Duas semanas sem nenhuma compra no cartão de crédito.',
        violacao: (t) => t.categoria === 'saida_credito',
    },
    {
        id: 'semana_sem_impulso', dias: 7, tipo: 'evitar', icon: 'fa-scissors',
        titulo: '7 dias sem compras por impulso',
        desc: 'Uma semana sem Shopee, Mercado Livre, Amazon, roupas e eletrônicos.',
        violacao: (t) => (t.categoria === 'saida' || t.categoria === 'saida_credito') &&
                         ['Shopee', 'Mercado Livre', 'Amazon', 'Roupas', 'Eletrônico'].includes(t.tipo),
    },
    {
        id: 'mes_no_azul', dias: 30, tipo: 'cumprir', icon: 'fa-arrow-trend-up',
        titulo: '30 dias no azul',
        desc: 'Fechar a janela de 30 dias com entradas maiores que as saídas.',
        checkFinal: (txsJanela) => {
            let ent = 0, sai = 0;
            for (const t of txsJanela) {
                const v = Math.abs(Number(t.valor) || 0);
                if      (t.categoria === 'entrada') ent += v;
                else if (t.categoria === 'saida' || t.categoria === 'saida_credito') sai += v;
            }
            return ent > 0 && ent > sai;
        },
    },
    {
        id: 'poupador_do_mes', dias: 28, tipo: 'cumprir', icon: 'fa-piggy-bank',
        titulo: 'Poupador do mês',
        desc: 'Guardar dinheiro em reservas nas 4 semanas da janela (1× por semana).',
        checkFinal: (txsJanela, inicio) => {
            const semanas = [false, false, false, false];
            for (const t of txsJanela) {
                if (t.categoria !== 'reserva') continue;
                const dt = _txDate(t.data);
                if (!dt) continue;
                const idx = Math.floor((dt - inicio) / (7 * 86_400_000));
                if (idx >= 0 && idx < 4) semanas[idx] = true;
            }
            return semanas.every(Boolean);
        },
    },
    {
        id: 'registro_em_dia', dias: 7, tipo: 'cumprir', icon: 'fa-pen-to-square',
        titulo: 'Registro em dia',
        desc: 'Registrar pelo menos 1 transação por dia durante 7 dias.',
        checkFinal: (txsJanela, inicio) => {
            const dias = new Set();
            for (const t of txsJanela) {
                const dt = _txDate(t.data);
                if (!dt) continue;
                const idx = Math.floor((dt - inicio) / 86_400_000);
                if (idx >= 0 && idx < 7) dias.add(idx);
            }
            return dias.size >= 7;
        },
    },
]);

const _BY_ID = Object.freeze(Object.fromEntries(DESAFIOS.map(d => [d.id, d])));

function _txDate(data) {
    if (typeof data !== 'string') return null;
    let y, m, d;
    if (data.includes('/')) {
        const p = data.split('/');
        if (p.length !== 3) return null;
        d = +p[0]; m = +p[1]; y = +p[2];
    } else if (data.includes('-')) {
        const p = data.split('-');
        if (p.length < 3) return null;
        y = +p[0]; m = +p[1]; d = parseInt(p[2], 10);
    } else return null;
    if (!y || !m || !d) return null;
    return new Date(y, m - 1, d);
}

function _isoHoje() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function _estruturaLimpa(raw) {
    const clean = { ativos: [], historico: [] };
    if (!raw || typeof raw !== 'object') return clean;
    if (Array.isArray(raw.ativos)) {
        for (const a of raw.ativos.slice(0, MAX_ATIVOS)) {
            if (a && typeof a.id === 'string' && _BY_ID[a.id] &&
                typeof a.iniciadoEm === 'string' && ISO_RE.test(a.iniciadoEm)) {
                clean.ativos.push({ id: a.id, iniciadoEm: a.iniciadoEm });
            }
        }
    }
    if (Array.isArray(raw.historico)) {
        for (const h of raw.historico.slice(-MAX_HISTORICO)) {
            if (h && typeof h.id === 'string' && _BY_ID[h.id] &&
                typeof h.iniciadoEm === 'string' && ISO_RE.test(h.iniciadoEm) &&
                typeof h.finalizadoEm === 'string' && ISO_RE.test(h.finalizadoEm)) {
                clean.historico.push({
                    id: h.id, iniciadoEm: h.iniciadoEm,
                    finalizadoEm: h.finalizadoEm, sucesso: h.sucesso === true,
                });
            }
        }
    }
    return clean;
}

// ── Avaliação ─────────────────────────────────────────────────────────────────
/**
 * Avalia os desafios ativos contra as transações. MUTA ctx.desafiosPerfil.
 * Retorna [{ desafio, sucesso }] dos que finalizaram nesta avaliação.
 */
export function avaliarDesafios(ctx) {
    const dados = _estruturaLimpa(ctx.desafiosPerfil);
    const finalizados = [];
    const agora = new Date();
    const restantes = [];

    for (const ativo of dados.ativos) {
        const def = _BY_ID[ativo.id];
        const inicio = new Date(ativo.iniciadoEm + 'T00:00:00');
        if (isNaN(inicio.getTime())) continue;
        const fim = new Date(inicio.getTime() + def.dias * 86_400_000);

        const txsJanela = (ctx.transacoes || []).filter(t => {
            const dt = _txDate(t.data);
            return dt && dt >= inicio && dt < fim;
        });

        let resultado = null; // null = em andamento
        if (def.tipo === 'evitar') {
            if (txsJanela.some(def.violacao))      resultado = false;
            else if (agora >= fim)                 resultado = true;
        } else {
            if (agora >= fim) resultado = def.checkFinal(txsJanela, inicio);
        }

        if (resultado === null) {
            restantes.push(ativo);
        } else {
            dados.historico.push({
                id: ativo.id,
                iniciadoEm: ativo.iniciadoEm,
                finalizadoEm: _isoHoje(),
                sucesso: resultado,
            });
            if (dados.historico.length > MAX_HISTORICO) {
                dados.historico = dados.historico.slice(-MAX_HISTORICO);
            }
            finalizados.push({ desafio: def, sucesso: resultado });
        }
    }

    dados.ativos = restantes;
    ctx.desafiosPerfil = dados;
    return finalizados;
}

function _avaliarENotificar() {
    if (!_ctx) return;
    let finalizados = [];
    try { finalizados = avaliarDesafios(_ctx); } catch { return; }
    if (finalizados.length === 0) return;

    for (const f of finalizados) {
        _ctx.mostrarNotificacao(
            f.sucesso
                ? `🏆 Desafio concluído: ${f.desafio.titulo}!`
                : `Desafio "${f.desafio.titulo}" não deu dessa vez. Bora tentar de novo?`,
            f.sucesso ? 'success' : 'info'
        );
    }
    // Persiste histórico atualizado; o save reavalia conquistas (novos troféus
    // de desafio destravam pelo state.desafiosConcluidos).
    _ctx.salvarDados();
}

// ── UI (popup) ────────────────────────────────────────────────────────────────
export function abrirDesafios(ctx) {
    _ctx = ctx;
    // Reavalia antes de abrir — estado sempre fresco na tela
    try { avaliarDesafios(ctx); } catch {}

    ctx.criarPopupDOM((popup) => {
        popup.classList.add('dsf-popup');

        const titulo = document.createElement('h3');
        titulo.textContent = 'Desafios';
        popup.appendChild(titulo);

        const dados = _estruturaLimpa(ctx.desafiosPerfil);
        const concluidos = dados.historico.filter(h => h.sucesso).length;

        const resumo = document.createElement('p');
        resumo.className = 'dsf-resumo';
        resumo.textContent = concluidos > 0
            ? `Você já venceu ${concluidos} desafio${concluidos > 1 ? 's' : ''}. Desafios ativos são avaliados automaticamente conforme você registra transações.`
            : 'Aceite um desafio e o GranaEvo acompanha sozinho pelo que você registra. Vencer desafios destrava conquistas.';
        popup.appendChild(resumo);

        // ── Ativos ───────────────────────────────────────────────────────
        if (dados.ativos.length > 0) {
            const secAtivos = document.createElement('div');
            secAtivos.className = 'dsf-sec-label';
            secAtivos.textContent = 'Em andamento';
            popup.appendChild(secAtivos);

            for (const a of dados.ativos) {
                const def = _BY_ID[a.id];
                const inicio = new Date(a.iniciadoEm + 'T00:00:00');
                const diasPassados = Math.max(0, Math.floor((Date.now() - inicio) / 86_400_000));
                const pct = Math.min(100, Math.round((diasPassados / def.dias) * 100));

                const card = document.createElement('div');
                card.className = 'dsf-card dsf-card--ativo';
                card.appendChild(_iconeDesafio(def));

                const body = document.createElement('div');
                body.className = 'dsf-card-body';
                const t = document.createElement('div');
                t.className = 'dsf-card-titulo';
                t.textContent = def.titulo;
                const barra = document.createElement('div');
                barra.className = 'dsf-barra';
                const fill = document.createElement('div');
                fill.className = 'dsf-barra-fill';
                fill.style.width = pct + '%';
                barra.appendChild(fill);
                const meta = document.createElement('div');
                meta.className = 'dsf-card-meta';
                meta.textContent = `Dia ${Math.min(diasPassados + 1, def.dias)} de ${def.dias}`;
                body.appendChild(t);
                body.appendChild(barra);
                body.appendChild(meta);

                const btnDesistir = document.createElement('button');
                btnDesistir.type = 'button';
                btnDesistir.className = 'dsf-btn-desistir';
                btnDesistir.textContent = 'Desistir';
                btnDesistir.addEventListener('click', () => {
                    ctx.confirmarAcao(`Desistir do desafio "${def.titulo}"? Ele não vai para o histórico.`, () => {
                        const d = _estruturaLimpa(ctx.desafiosPerfil);
                        d.ativos = d.ativos.filter(x => x.id !== def.id);
                        ctx.desafiosPerfil = d;
                        ctx.salvarDados();
                        ctx.fecharPopup();
                        setTimeout(() => abrirDesafios(ctx), 350);
                    });
                });

                card.appendChild(body);
                card.appendChild(btnDesistir);
                popup.appendChild(card);
            }
        }

        // ── Disponíveis ──────────────────────────────────────────────────
        const secDisp = document.createElement('div');
        secDisp.className = 'dsf-sec-label';
        secDisp.textContent = 'Disponíveis';
        popup.appendChild(secDisp);

        const ativosIds = new Set(dados.ativos.map(a => a.id));
        for (const def of DESAFIOS) {
            if (ativosIds.has(def.id)) continue;

            const card = document.createElement('div');
            card.className = 'dsf-card';
            card.appendChild(_iconeDesafio(def));

            const body = document.createElement('div');
            body.className = 'dsf-card-body';
            const t = document.createElement('div');
            t.className = 'dsf-card-titulo';
            t.textContent = def.titulo;
            const d = document.createElement('div');
            d.className = 'dsf-card-desc';
            d.textContent = def.desc;
            const vitorias = dados.historico.filter(h => h.id === def.id && h.sucesso).length;
            if (vitorias > 0) {
                const v = document.createElement('div');
                v.className = 'dsf-card-meta';
                v.textContent = `✓ Vencido ${vitorias}×`;
                body.appendChild(t); body.appendChild(d); body.appendChild(v);
            } else {
                body.appendChild(t); body.appendChild(d);
            }

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'dsf-btn-aceitar';
            btn.textContent = 'Aceitar';
            btn.addEventListener('click', () => {
                const dd = _estruturaLimpa(ctx.desafiosPerfil);
                if (dd.ativos.length >= MAX_ATIVOS) {
                    ctx.mostrarNotificacao(`Máximo de ${MAX_ATIVOS} desafios ao mesmo tempo. Conclua um antes de aceitar outro.`, 'info');
                    return;
                }
                dd.ativos.push({ id: def.id, iniciadoEm: _isoHoje() });
                ctx.desafiosPerfil = dd;
                ctx.salvarDados();
                ctx.mostrarNotificacao(`Desafio aceito: ${def.titulo}. Começa hoje — boa sorte! 💪`, 'success');
                ctx.fecharPopup();
            });

            card.appendChild(body);
            card.appendChild(btn);
            popup.appendChild(card);
        }

        const btnFechar = document.createElement('button');
        btnFechar.type = 'button';
        btnFechar.className = 'btn-outline dsf-fechar';
        btnFechar.textContent = 'Fechar';
        btnFechar.addEventListener('click', () => ctx.fecharPopup());
        popup.appendChild(btnFechar);
    });
}

function _iconeDesafio(def) {
    const wrap = document.createElement('div');
    wrap.className = 'dsf-card-icon';
    const ic = document.createElement('i');
    // Whitelist de classe de ícone — nunca aceita string arbitrária
    ic.className = 'fas ' + (/^fa-[a-z0-9-]+$/.test(def.icon) ? def.icon : 'fa-dumbbell');
    ic.setAttribute('aria-hidden', 'true');
    wrap.appendChild(ic);
    return wrap;
}

/** Boot: avalia no load e a cada save (debounced). */
export function initDesafios(ctx) {
    _ctx = ctx;
    // Primeira avaliação um pouco depois do boot (deixa o dashboard respirar)
    setTimeout(_avaliarENotificar, 4_000);
    document.addEventListener('ge:save-done', () => {
        clearTimeout(_debounceTimer);
        _debounceTimer = setTimeout(_avaliarENotificar, 3_000);
    });
}
