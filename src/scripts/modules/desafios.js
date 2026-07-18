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

// ── Análise de hábitos (personalização) ──────────────────────────────────────
// O pedido: "analisar automaticamente os gastos e gerar desafios personalizados
// de acordo com os hábitos". A REGRA: um desafio só é recomendado se os NÚMEROS
// DA PESSOA o justificarem. Sugerir "7 dias sem delivery" para quem nunca pediu
// não é personalização, é ruído — e ensina o usuário a ignorar a tela.
// Por isso todo `relevancia()` devolve null quando falta evidência, e quando
// devolve algo traz o MOTIVO com o número real que o justifica.

const _fmtBRL = (v) => `R$ ${Number(v || 0).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;

function _ehSaida(t) { return t && (t.categoria === 'saida' || t.categoria === 'saida_credito'); }

/**
 * Radiografia dos últimos `dias`: quanto e quantas vezes gastou em cada tipo.
 * Insumo de TODA recomendação — nenhum desafio é sugerido sem passar por aqui.
 * @returns {{ porTipo: Map<string,{total,vezes}>, credito, reservas, diasComRegistro, entradas, saidas }}
 */
export function analisarHabitos(transacoes, dias = 30, agora = new Date()) {
    const limite = new Date(agora.getTime() - dias * 86_400_000);
    const porTipo = new Map();
    let credito = 0, reservas = 0, entradas = 0, saidas = 0;
    const diasSet = new Set();

    for (const t of (Array.isArray(transacoes) ? transacoes : [])) {
        const dt = _txDate(t?.data);
        if (!dt || dt < limite || dt > agora) continue;
        const v = Math.abs(Number(t.valor) || 0);
        diasSet.add(dt.toDateString());

        if (t.categoria === 'entrada')  entradas += v;
        if (t.categoria === 'reserva')  reservas += v;
        if (t.categoria === 'saida_credito') credito += v;
        if (!_ehSaida(t)) continue;

        saidas += v;
        const tipo = String(t.tipo ?? 'Outros');
        const e = porTipo.get(tipo) || { total: 0, vezes: 0 };
        e.total += v; e.vezes += 1;
        porTipo.set(tipo, e);
    }
    for (const e of porTipo.values()) e.total = Math.round(e.total * 100) / 100;

    return {
        porTipo,
        credito:  Math.round(credito * 100) / 100,
        reservas: Math.round(reservas * 100) / 100,
        entradas: Math.round(entradas * 100) / 100,
        saidas:   Math.round(saidas * 100) / 100,
        diasComRegistro: diasSet.size,
    };
}

/** Soma dos tipos informados (usado por vários `relevancia`). */
function _somaTipos(h, tipos) {
    let total = 0, vezes = 0;
    for (const tp of tipos) {
        const e = h.porTipo.get(tp);
        if (e) { total += e.total; vezes += e.vezes; }
    }
    return { total: Math.round(total * 100) / 100, vezes };
}

const _IMPULSO = ['Shopee', 'Mercado Livre', 'Amazon', 'Roupas', 'Eletrônico'];

/**
 * Fábrica dos desafios de TETO personalizado: o alvo sai do gasto real da
 * pessoa (`fator` × o que ela gastou no último mês), não de um número inventado.
 *
 * `calcAlvo` devolve null quando não há evidência suficiente — e sem alvo o
 * desafio não é recomendado nem aceitável. Melhor não sugerir do que sugerir
 * uma meta sem lastro.
 */
function _tetoCategoria({ id, tipoAlvo, icon, titulo, desc, fator, minTotal, minVezes }) {
    const alvoDe = (h) => {
        const e = h.porTipo.get(tipoAlvo);
        if (!e || e.total < minTotal || e.vezes < minVezes) return null;
        return Math.round(e.total * fator * 100) / 100;
    };
    return {
        id, dias: 30, tipo: 'cumprir', icon, titulo, desc,
        dinamico: true, tipoAlvo,
        calcAlvo: alvoDe,
        // O alvo vem PERSISTIDO (congelado no aceite), nunca recalculado aqui.
        checkFinal: (txsJanela, _inicio, alvo) => {
            if (!(Number(alvo) > 0)) return false;
            let gasto = 0;
            for (const t of txsJanela) {
                if (_ehSaida(t) && String(t.tipo) === tipoAlvo) gasto += Math.abs(Number(t.valor) || 0);
            }
            return Math.round(gasto * 100) / 100 <= Number(alvo);
        },
        relevancia: (h) => {
            const alvo = alvoDe(h);
            if (alvo === null) return null;
            const e = h.porTipo.get(tipoAlvo);
            return { score: e.total, motivo: `${_fmtBRL(e.total)} em ${tipoAlvo} no último mês — a meta seria ${_fmtBRL(alvo)}.` };
        },
    };
}

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
        relevancia: (h) => {
            const e = h.porTipo.get('Ifood');
            if (!e || e.vezes < 3 || e.total < 60) return null;
            return { score: e.total * 1.2, motivo: `${_fmtBRL(e.total)} em ${e.vezes} pedidos de delivery no último mês.` };
        },
    },
    {
        id: 'quinze_dias_debito', dias: 15, tipo: 'evitar', icon: 'fa-credit-card',
        titulo: '15 dias só no débito',
        desc: 'Duas semanas sem nenhuma compra no cartão de crédito.',
        violacao: (t) => t.categoria === 'saida_credito',
        relevancia: (h) => {
            if (h.credito < 200) return null;
            return { score: h.credito * 0.5, motivo: `${_fmtBRL(h.credito)} no crédito no último mês.` };
        },
    },
    {
        id: 'semana_sem_impulso', dias: 7, tipo: 'evitar', icon: 'fa-scissors',
        titulo: '7 dias sem compras por impulso',
        desc: 'Uma semana sem Shopee, Mercado Livre, Amazon, roupas e eletrônicos.',
        violacao: (t) => (t.categoria === 'saida' || t.categoria === 'saida_credito') &&
                         _IMPULSO.includes(t.tipo),
        relevancia: (h) => {
            const s = _somaTipos(h, _IMPULSO);
            if (s.vezes < 3 || s.total < 100) return null;
            return { score: s.total, motivo: `${_fmtBRL(s.total)} em ${s.vezes} compras por impulso no último mês.` };
        },
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
        relevancia: (h) => {
            if (h.entradas <= 0 || h.saidas <= h.entradas) return null;
            const deficit = Math.round((h.saidas - h.entradas) * 100) / 100;
            return { score: deficit * 1.5, motivo: `No último mês você gastou ${_fmtBRL(deficit)} a mais do que ganhou.` };
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
        relevancia: (h) => {
            if (h.reservas > 0 || h.entradas <= 0) return null;
            return { score: 140, motivo: 'Você não guardou nada em reservas no último mês.' };
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
        relevancia: (h) => {
            if (h.diasComRegistro >= 20) return null;
            return { score: 110, motivo: `Você registrou algo em apenas ${h.diasComRegistro} dia(s) no último mês.` };
        },
    },

    // ── Tetos personalizados ────────────────────────────────────────────────
    // Aqui mora a personalização de verdade: o ALVO não é fixo, é calculado do
    // gasto real da pessoa (uma % a menos do que ela mesma gastou). "Gaste menos
    // que R$ 300" é chute; "gaste menos que os R$ 412 que você gastou" é meta.
    // O alvo é congelado no aceite e persistido — recalcular depois mudaria a
    // regra no meio do jogo (e o usuário perderia por um alvo que nunca aceitou).
    _tetoCategoria({
        id: 'teto_delivery', tipoAlvo: 'Ifood', icon: 'fa-utensils', fator: 0.7,
        titulo: 'Delivery sob controle',
        desc: 'Fechar 30 dias gastando bem menos com delivery do que no mês passado.',
        minTotal: 80, minVezes: 3,
    }),
    _tetoCategoria({
        id: 'teto_mercado', tipoAlvo: 'Mercado', icon: 'fa-cart-shopping', fator: 0.85,
        titulo: 'Mercado mais enxuto',
        desc: 'Fechar 30 dias de mercado abaixo do seu próprio último mês.',
        minTotal: 200, minVezes: 3,
    }),
    _tetoCategoria({
        id: 'teto_transporte', tipoAlvo: 'Transporte', icon: 'fa-bus', fator: 0.8,
        titulo: 'Transporte econômico',
        desc: 'Fechar 30 dias de transporte abaixo do seu próprio último mês.',
        minTotal: 120, minVezes: 4,
    }),
]);

const _BY_ID = Object.freeze(Object.fromEntries(DESAFIOS.map(d => [d.id, d])));

/**
 * O CORAÇÃO DA PERSONALIZAÇÃO: olha os hábitos e devolve, ranqueado, o que faz
 * sentido para ESTA pessoa — com o motivo e (para tetos) o alvo já calculado.
 *
 * Devolve [] quando nada se justifica. Lista vazia é resposta legítima: é
 * melhor não recomendar nada do que recomendar algo que não tem a ver com a
 * pessoa. Quem já registra bem e não estoura nada não precisa de desafio.
 *
 * @returns {Array<{ def, motivo, score, alvo }>} ordenado do mais relevante
 */
export function sugerirDesafios(transacoes, { excluirIds = [], agora = new Date(), max = 3 } = {}) {
    const habitos = analisarHabitos(transacoes, 30, agora);
    const fora = new Set(excluirIds.map(String));
    const out = [];

    for (const def of DESAFIOS) {
        if (fora.has(def.id) || typeof def.relevancia !== 'function') continue;
        let r = null;
        try { r = def.relevancia(habitos); } catch { r = null; }
        if (!r || !(Number(r.score) > 0)) continue;

        let alvo = null;
        if (def.dinamico) {
            try { alvo = def.calcAlvo(habitos); } catch { alvo = null; }
            if (alvo === null) continue;      // sem lastro → não sugere
        }
        out.push({ def, motivo: String(r.motivo || ''), score: Number(r.score), alvo });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, max);
}

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
                const entrada = { id: a.id, iniciadoEm: a.iniciadoEm };
                // Alvo personalizado dos desafios de teto: congelado no aceite e
                // preservado aqui. Sem isto o alvo sumiria no reload e o desafio
                // seria julgado com alvo 0 — falha automática injusta.
                const alvo = Number(a.alvo);
                if (_BY_ID[a.id].dinamico && Number.isFinite(alvo) && alvo > 0 && alvo <= 9_999_999) {
                    entrada.alvo = Math.round(alvo * 100) / 100;
                }
                clean.ativos.push(entrada);
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
            // `ativo.alvo` = meta personalizada congelada no aceite (desafios de
            // teto). Passar o alvo salvo — e não recalcular do gasto atual — é o
            // que impede a regra de mudar no meio do jogo.
            if (agora >= fim) resultado = def.checkFinal(txsJanela, inicio, ativo.alvo);
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

/**
 * Aceita um desafio. Para os de teto, CONGELA o alvo agora — a partir daqui a
 * meta é a que o usuário viu e aceitou, mesmo que os gastos dele mudem depois.
 * Sem lastro para calcular o alvo, recusa em vez de criar meta arbitrária.
 */
function _aceitarDesafio(ctx, def, alvoSugerido = null) {
    const dd = _estruturaLimpa(ctx.desafiosPerfil);
    if (dd.ativos.length >= MAX_ATIVOS) {
        ctx.mostrarNotificacao(`Máximo de ${MAX_ATIVOS} desafios ao mesmo tempo. Conclua um antes de aceitar outro.`, 'info');
        return;
    }
    const entrada = { id: def.id, iniciadoEm: _isoHoje() };

    if (def.dinamico) {
        let alvo = Number(alvoSugerido);
        if (!(alvo > 0)) {
            try { alvo = def.calcAlvo(analisarHabitos(ctx.transacoes || [], 30)); } catch { alvo = null; }
        }
        if (!(Number(alvo) > 0)) {
            ctx.mostrarNotificacao('Ainda não há gastos suficientes nessa categoria para definir uma meta justa.', 'info');
            return;
        }
        entrada.alvo = Math.round(Number(alvo) * 100) / 100;
    }

    dd.ativos.push(entrada);
    ctx.desafiosPerfil = dd;
    ctx.salvarDados();
    ctx.mostrarNotificacao(
        entrada.alvo
            ? `Desafio aceito: ${def.titulo} — meta de ${_fmtBRL(entrada.alvo)}. Boa sorte! 💪`
            : `Desafio aceito: ${def.titulo}. Começa hoje — boa sorte! 💪`,
        'success');
    ctx.fecharPopup();
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

        const ativosIds = new Set(dados.ativos.map(a => a.id));

        // ── Recomendados para você ───────────────────────────────────────
        // Gerados dos SEUS gastos: só aparece o que os seus números justificam,
        // e cada card mostra o motivo com o valor real. Lista vazia é resposta
        // legítima — quem não tem padrão de gasto a atacar não recebe sugestão
        // inventada só para preencher a tela.
        let recomendados = [];
        try {
            recomendados = sugerirDesafios(ctx.transacoes || [], { excluirIds: [...ativosIds], max: 3 });
        } catch { recomendados = []; }

        if (recomendados.length > 0) {
            const secRec = document.createElement('div');
            secRec.className = 'dsf-sec-label';
            secRec.textContent = 'Recomendados para você';
            popup.appendChild(secRec);

            for (const rec of recomendados) {
                const def = rec.def;
                const card = document.createElement('div');
                card.className = 'dsf-card dsf-card--rec';
                card.appendChild(_iconeDesafio(def));

                const body = document.createElement('div');
                body.className = 'dsf-card-body';
                const t = document.createElement('div');
                t.className = 'dsf-card-titulo';
                t.textContent = rec.alvo != null ? `${def.titulo}: até ${_fmtBRL(rec.alvo)}` : def.titulo;
                const motivo = document.createElement('div');
                motivo.className = 'dsf-card-motivo';
                motivo.textContent = rec.motivo;          // textContent — sem XSS
                body.appendChild(t);
                body.appendChild(motivo);

                const btnRec = document.createElement('button');
                btnRec.type = 'button';
                btnRec.className = 'dsf-btn-aceitar';
                btnRec.textContent = 'Aceitar';
                btnRec.addEventListener('click', () => _aceitarDesafio(ctx, def, rec.alvo));

                card.appendChild(body);
                card.appendChild(btnRec);
                popup.appendChild(card);
            }
        }

        // ── Disponíveis ──────────────────────────────────────────────────
        const secDisp = document.createElement('div');
        secDisp.className = 'dsf-sec-label';
        secDisp.textContent = recomendados.length > 0 ? 'Outros desafios' : 'Disponíveis';
        popup.appendChild(secDisp);

        const recIds = new Set(recomendados.map(r => r.def.id));
        for (const def of DESAFIOS) {
            if (ativosIds.has(def.id) || recIds.has(def.id)) continue;

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
            btn.addEventListener('click', () => _aceitarDesafio(ctx, def));

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
