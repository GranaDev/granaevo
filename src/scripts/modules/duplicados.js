// duplicados.js — Detector de lançamento duplicado (lazy)
// ----------------------------------------------------------------------------
// Por que isto importa NESTE app: o GranaEvo é 100% lançamento MANUAL (o
// diferencial é não conectar o banco). Duplicar um lançamento é erro comum — e
// um duplicado corrompe saldo, previsão, relatórios e metas de uma vez só.
//
// Critérios (mesmos já estabelecidos na dedup de importação, db-transacoes.js):
//   - mesma data (ISO) + mesmo valor (±R$0,01) + mesma categoria
//   - descrições com ≥60% de palavras em comum (_similarity)
//   - SÓ lançamentos do usuário: os gerados pelo app (conta fixa / fatura /
//     compra) são excluídos por marcador de origem — eles repetem de propósito.
//
// NUNCA apaga nada: apenas PERGUNTA. A exclusão correta (que reverte o saldo da
// meta vinculada e oferece Desfazer) vive em db-transacoes.js — o card leva o
// usuário até lá em vez de duplicar aquela lógica delicada.
// 100% client-side, matemática pura.
// ----------------------------------------------------------------------------

const _DISMISS_DIAS = 60;
let _ctxDup = null;
let _dupTimer = null;

// Data "DD/MM/YYYY" ou "YYYY-MM-DD" → "YYYY-MM-DD" (ou null).
function _iso(data) {
    if (typeof data !== 'string') return null;
    if (/^\d{4}-\d{2}-\d{2}/.test(data)) return data.slice(0, 10);
    const p = data.split('/');
    if (p.length !== 3) return null;
    const d = p[0].padStart(2, '0'), m = p[1].padStart(2, '0'), y = p[2];
    if (y.length !== 4) return null;
    return `${y}-${m}-${d}`;
}

// Mesma tokenização/similaridade da dedup de importação — consistência.
function _tokens(str) {
    return String(str || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^\w\s]/g, ' ').split(/\s+/).filter(w => w.length >= 3);
}
function _similarity(a, b) {
    const setA = new Set(_tokens(a));
    const setB = new Set(_tokens(b));
    if (setA.size === 0 || setB.size === 0) return 0;
    const inter = [...setA].filter(w => setB.has(w)).length;
    return inter / Math.min(setA.size, setB.size);
}

/** Assinatura estável de um grupo — usada p/ lembrar o "foi proposital". */
export function assinaturaGrupo(g) {
    const ids = (g?.itens || []).map(i => String(i.id ?? '')).sort().join(',');
    return `${g?.dataISO}|${Number(g?.valor).toFixed(2)}|${ids}`;
}

/**
 * Grupos suspeitos de duplicata.
 * @returns [{ dataISO, valor, categoria, descricao, itens:[{id,descricao,hora}], impacto }]
 *          ordenados por impacto (dinheiro contado a mais), máx. 10.
 */
export function detectarDuplicados(transacoes, limiteSimilaridade = 0.6) {
    const grupos = new Map();

    for (const t of (transacoes || [])) {
        if (!t) continue;
        // Gerados pelo app repetem de propósito (mensalidade, fatura) — não são erro.
        if (t.contaFixaId != null || t.faturaId != null || t.compraId != null) continue;
        const v = Number(t.valor);
        if (!Number.isFinite(v) || v <= 0) continue;
        const iso = _iso(t.data);
        if (!iso) continue;
        const key = `${iso}|${v.toFixed(2)}|${t.categoria}`;
        if (!grupos.has(key)) grupos.set(key, []);
        grupos.get(key).push(t);
    }

    const suspeitos = [];
    for (const itens of grupos.values()) {
        if (itens.length < 2) continue;
        const usados = new Set();
        for (let i = 0; i < itens.length; i++) {
            if (usados.has(i)) continue;
            const cluster = [itens[i]];
            for (let j = i + 1; j < itens.length; j++) {
                if (usados.has(j)) continue;
                // Mesma data+valor+categoria só não basta: "2 cafés de R$8" é legítimo.
                // Exige descrições parecidas para acusar.
                if (_similarity(itens[i].descricao, itens[j].descricao) >= limiteSimilaridade) {
                    cluster.push(itens[j]);
                    usados.add(j);
                }
            }
            if (cluster.length < 2) continue;
            usados.add(i);
            const v = Number(cluster[0].valor);
            suspeitos.push({
                dataISO:   _iso(cluster[0].data),
                valor:     v,
                categoria: cluster[0].categoria,
                descricao: String(cluster[0].descricao || '').slice(0, 60),
                itens: cluster.map(c => ({
                    id:        c.id,
                    descricao: String(c.descricao || '').slice(0, 60),
                    hora:      typeof c.hora === 'string' ? c.hora : '',
                })),
                impacto: Number(((cluster.length - 1) * v).toFixed(2)), // dinheiro contado a mais
            });
        }
    }

    suspeitos.sort((a, b) => b.impacto - a.impacto);
    return suspeitos.slice(0, 10);
}

/** Regra pura de exibição do card — exportada p/ teste. */
export function deveMostrarAvisoDup(grupos, dispensados, agora = Date.now(), dias = _DISMISS_DIAS) {
    if (!Array.isArray(grupos) || grupos.length === 0) return false;
    const map = (dispensados && typeof dispensados === 'object') ? dispensados : {};
    // Mostra se existe ao menos UM grupo ainda não dispensado (ou com dispensa vencida).
    return grupos.some(g => {
        const ts = Number(map[assinaturaGrupo(g)]);
        if (!Number.isFinite(ts) || ts <= 0) return true;
        return (agora - ts) >= dias * 86_400_000;
    });
}

// ── Dispensa por usuário+perfil (localStorage; não toca o save-path do banco) ──
function _chave(ctx) {
    const u = String(ctx?._effectiveUserId ?? 'anon').slice(0, 40);
    const p = ctx?.perfilAtivo;
    const pid = String((p && typeof p === 'object' ? (p.id ?? p.nome) : p) ?? 'x').slice(0, 40);
    return `ge:dupAviso:${u}:${pid}`;
}
function _lerDispensados(ctx) {
    try { return JSON.parse(localStorage.getItem(_chave(ctx)) || '{}') || {}; }
    catch { return {}; }
}
function _dispensarGrupos(ctx, grupos) {
    try {
        const map = _lerDispensados(ctx);
        const agora = Date.now();
        for (const g of grupos) map[assinaturaGrupo(g)] = agora;
        localStorage.setItem(_chave(ctx), JSON.stringify(map));
    } catch { /* modo privado — só não lembra */ }
}

function _gruposVisiveis(ctx) {
    const todos = detectarDuplicados(ctx.transacoes);
    const map = _lerDispensados(ctx);
    const agora = Date.now();
    return todos.filter(g => {
        const ts = Number(map[assinaturaGrupo(g)]);
        if (!Number.isFinite(ts) || ts <= 0) return true;
        return (agora - ts) >= _DISMISS_DIAS * 86_400_000;
    });
}

function _render() {
    const slot = document.getElementById('duplicadosSlot');
    if (!slot || !_ctxDup) return;
    slot.textContent = '';

    const grupos = _gruposVisiveis(_ctxDup);
    if (grupos.length === 0) return;

    const impacto = grupos.reduce((s, g) => s + g.impacto, 0);

    const card = document.createElement('div');
    card.className = 'aviso-card';

    const iconWrap = document.createElement('div');
    iconWrap.className = 'aviso-card__icon';
    const ic = document.createElement('i');
    ic.className = 'fas fa-clone';
    ic.setAttribute('aria-hidden', 'true');
    iconWrap.appendChild(ic);

    const body = document.createElement('button');
    body.type = 'button';
    body.className = 'aviso-card__body';

    const label = document.createElement('div');
    label.className = 'aviso-card__label';
    label.textContent = 'Lançou duas vezes?';

    const valor = document.createElement('div');
    valor.className = 'aviso-card__valor';
    valor.textContent = _ctxDup.formatBRL(impacto);

    const sub = document.createElement('div');
    sub.className = 'aviso-card__sub';
    sub.textContent = grupos.length === 1
        ? '1 lançamento parece repetido · toque para conferir'
        : `${grupos.length} lançamentos parecem repetidos · toque para conferir`;

    body.appendChild(label);
    body.appendChild(valor);
    body.appendChild(sub);
    body.addEventListener('click', () => abrirRevisaoDuplicados(_ctxDup));

    const fechar = document.createElement('button');
    fechar.type = 'button';
    fechar.className = 'aviso-card__fechar';
    fechar.setAttribute('aria-label', 'Dispensar este aviso');
    const fi = document.createElement('i');
    fi.className = 'fas fa-xmark';
    fi.setAttribute('aria-hidden', 'true');
    fechar.appendChild(fi);
    fechar.addEventListener('click', () => { _dispensarGrupos(_ctxDup, grupos); slot.textContent = ''; });

    card.appendChild(iconWrap);
    card.appendChild(body);
    card.appendChild(fechar);
    slot.appendChild(card);
}

/** Popup de revisão — PERGUNTA, nunca apaga sozinho. */
export function abrirRevisaoDuplicados(ctx) {
    const grupos = _gruposVisiveis(ctx);

    ctx.criarPopupDOM((popup) => {
        const titulo = document.createElement('h3');
        titulo.textContent = 'Lançamentos repetidos';
        popup.appendChild(titulo);

        if (grupos.length === 0) {
            const p = document.createElement('p');
            p.className = 'dup-vazio';
            p.textContent = 'Nenhum lançamento repetido por aqui. Suas contas estão limpas!';
            popup.appendChild(p);
        } else {
            const intro = document.createElement('p');
            intro.className = 'dup-intro';
            intro.textContent = 'Estes lançamentos têm a mesma data, valor e descrição parecida. Foi de propósito ou lançou sem querer duas vezes?';
            popup.appendChild(intro);

            const lista = document.createElement('div');
            lista.className = 'dup-lista';
            for (const g of grupos) {
                const row = document.createElement('div');
                row.className = 'dup-row';

                const nome = document.createElement('div');
                nome.className = 'dup-row-nome';
                nome.textContent = g.descricao; // textContent — descrição do usuário nunca vira HTML

                const meta = document.createElement('div');
                meta.className = 'dup-row-meta';
                const horas = g.itens.map(i => i.hora).filter(Boolean).join(' e ');
                const [y, m, d] = g.dataISO.split('-');
                meta.textContent = `${g.itens.length}× ${ctx.formatBRL(g.valor)} em ${d}/${m}/${y}` +
                    (horas ? ` · às ${horas}` : '');

                const impacto = document.createElement('div');
                impacto.className = 'dup-row-impacto';
                impacto.textContent = `${ctx.formatBRL(g.impacto)} a mais`;

                row.appendChild(nome);
                row.appendChild(meta);
                row.appendChild(impacto);
                lista.appendChild(row);
            }
            popup.appendChild(lista);

            const dica = document.createElement('p');
            dica.className = 'dup-dica';
            dica.textContent = 'Para remover um repetido, abra Transações e exclua o lançamento (dá para desfazer).';
            popup.appendChild(dica);
        }

        const acoes = document.createElement('div');
        acoes.className = 'dup-acoes';

        if (grupos.length > 0) {
            const btnVer = document.createElement('button');
            btnVer.type = 'button';
            btnVer.className = 'btn-primary';
            btnVer.textContent = 'Ver nas transações';
            btnVer.addEventListener('click', () => {
                ctx.fecharPopup();
                try { ctx.mostrarTela?.('transacoes'); } catch { /* navegação indisponível */ }
            });
            acoes.appendChild(btnVer);

            const btnOk = document.createElement('button');
            btnOk.type = 'button';
            btnOk.className = 'btn-cancelar';
            btnOk.textContent = 'Foi proposital';
            btnOk.addEventListener('click', () => {
                _dispensarGrupos(ctx, grupos);
                const slot = document.getElementById('duplicadosSlot');
                if (slot) slot.textContent = '';
                ctx.fecharPopup();
                ctx.mostrarNotificacao?.('Ok! Não aviso mais sobre estes.', 'info');
            });
            acoes.appendChild(btnOk);
        } else {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'btn-primary';
            btn.textContent = 'Fechar';
            btn.addEventListener('click', () => ctx.fecharPopup());
            acoes.appendChild(btn);
        }
        popup.appendChild(acoes);
    });
}

/** Boot: chamado pelo dashboard via import() após o carregamento inicial. */
export function initAvisoDuplicados(ctx) {
    _ctxDup = ctx;
    _render();
    document.addEventListener('ge:save-done', () => {
        clearTimeout(_dupTimer);
        _dupTimer = setTimeout(_render, 1_500);
    });
}
