// recorrencias.js — Detector de assinaturas esquecidas (lazy)
// ----------------------------------------------------------------------------
// Varre as transações e encontra cobranças com padrão de recorrência mensal
// (~28–33 dias, valor estável) que NÃO estão registradas como assinatura —
// e mostra quanto elas custam por ano. 100% client-side, matemática pura.
//
// Critérios (conservadores, para não gerar falso-positivo):
//   - categoria 'saida' ou 'saida_credito', EXCLUINDO contas fixas e pagamentos de
//     fatura (por marcador de origem — ver BUGFIX abaixo)
//   - ≥ 2 ocorrências com intervalo entre 25 e 36 dias
//   - variação de valor ≤ 15% (ou ≤ R$ 2 p/ valores pequenos)
//   - última cobrança nos últimos 45 dias (ainda ativa)
//   - descrição não bate com nenhuma assinatura já cadastrada
// ----------------------------------------------------------------------------

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
    if (!y || !m || !d || m < 1 || m > 12 || d < 1 || d > 31) return null;
    return new Date(y, m - 1, d);
}

function _norm(s) {
    return String(s || '')
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/\d+/g, '')
        .replace(/[^a-z ]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 40);
}

/**
 * Retorna candidatos: [{ nome, valorMensal, valorAnual, ocorrencias, ultima }]
 * ordenados do mais caro para o mais barato (máx. 10).
 */
export function detectarAssinaturasEsquecidas(transacoes, assinaturas, hoje = new Date()) {
    const grupos = new Map();

    for (const t of (transacoes || [])) {
        if (t.categoria !== 'saida' && t.categoria !== 'saida_credito') continue;
        // BUGFIX (2026-07-14): a exclusão usava t.tipo === 'Conta fixa'/'Cartão', mas os
        // tipos REAIS gravados são 'Conta Fixa' (F maiúsculo) e 'Pagamento Cartão' —
        // nunca casavam. Como conta fixa é justamente o padrão que o detector procura
        // (mensal + valor estável), aluguel/luz apareciam como "assinatura esquecida"
        // (falso-positivo grave). Agora exclui por MARCADOR de origem (id — robusto a
        // rótulo) + pelos tipos corretos.
        if (t.contaFixaId != null || t.faturaId != null || t.compraId != null) continue;
        if (t.tipo === 'Conta Fixa' || t.tipo === 'Conta fixa' ||
            t.tipo === 'Pagamento Cartão' || t.tipo === 'Cartão') continue;
        const dt = _txDate(t.data);
        const v  = Number(t.valor);
        if (!dt || !Number.isFinite(v) || v <= 0) continue;
        const key = _norm(t.descricao);
        if (key.length < 3) continue;
        if (!grupos.has(key)) grupos.set(key, []);
        grupos.get(key).push({ dt, v, descOriginal: String(t.descricao || '').slice(0, 60) });
    }

    // Assinaturas já registradas — não devem aparecer como "esquecidas"
    const jaRegistradas = new Set(
        (assinaturas || [])
            .filter(a => a && a.ativa !== false)
            .map(a => _norm(a.nome))
            .filter(n => n.length >= 3)
    );

    const candidatos = [];
    const MS_DIA = 86_400_000;

    for (const [key, occ] of grupos) {
        if (occ.length < 2) continue;

        // já cadastrada? (match por inclusão nos dois sentidos)
        let registrada = false;
        for (const nome of jaRegistradas) {
            if (key.includes(nome) || nome.includes(key)) { registrada = true; break; }
        }
        if (registrada) continue;

        occ.sort((a, b) => a.dt - b.dt);

        // intervalos consecutivos precisam parecer mensais
        let gapsMensais = 0, gapsTotal = 0;
        for (let i = 1; i < occ.length; i++) {
            const gap = Math.round((occ[i].dt - occ[i - 1].dt) / MS_DIA);
            if (gap < 20) continue; // mesma fatura/duplicata — ignora o par
            gapsTotal++;
            if (gap >= 25 && gap <= 36) gapsMensais++;
        }
        if (gapsTotal === 0 || gapsMensais < Math.max(1, gapsTotal - 1)) continue;

        // valor estável
        const vals = occ.map(o => o.v);
        const vMin = Math.min(...vals), vMax = Math.max(...vals);
        const media = vals.reduce((s, x) => s + x, 0) / vals.length;
        if ((vMax - vMin) > Math.max(media * 0.15, 2)) continue;

        // ainda ativa (cobrou nos últimos 45 dias)
        const ultima = occ[occ.length - 1].dt;
        if ((hoje - ultima) / MS_DIA > 45) continue;

        const valorMensal = Math.round(media * 100) / 100;
        candidatos.push({
            nome:        occ[occ.length - 1].descOriginal,
            valorMensal,
            valorAnual:  Math.round(valorMensal * 12 * 100) / 100,
            ocorrencias: occ.length,
            ultima,
        });
    }

    candidatos.sort((a, b) => b.valorMensal - a.valorMensal);
    return candidatos.slice(0, 10);
}

// ── Aviso PROATIVO no dashboard ───────────────────────────────────────────────
// Antes o detector só existia como botão (pull) em Cartões → Assinaturas: o usuário
// precisava lembrar de procurar. Aqui o app PERGUNTA — card com o custo ANUAL das
// cobranças recorrentes não registradas. A dispensa mora em localStorage (por
// usuário+perfil): não vira nag e NÃO toca o save-path/whitelist do banco.

const _DISMISS_DIAS = 30;
let _ctxAviso  = null;
let _avisoTimer = null;

/** Regra pura de exibição — exportada p/ teste. */
export function deveMostrarAviso(achados, dispensadoEm, agora = Date.now(), dias = _DISMISS_DIAS) {
    if (!Array.isArray(achados) || achados.length === 0) return false;
    const ts = Number(dispensadoEm);
    if (Number.isFinite(ts) && ts > 0 && (agora - ts) < dias * 86_400_000) return false;
    return true;
}

// Chave por usuário+perfil — a dispensa de um perfil não vaza para outro.
function _chaveDispensa(ctx) {
    const u = String(ctx?._effectiveUserId ?? 'anon').slice(0, 40);
    const p = ctx?.perfilAtivo;
    const pid = String((p && typeof p === 'object' ? (p.id ?? p.nome) : p) ?? 'x').slice(0, 40);
    return `ge:assinAviso:${u}:${pid}`;
}

function _lerDispensa(ctx) {
    try { return Number(localStorage.getItem(_chaveDispensa(ctx))); } catch { return 0; }
}
function _gravarDispensa(ctx) {
    try { localStorage.setItem(_chaveDispensa(ctx), String(Date.now())); } catch { /* modo privado */ }
}

function _renderAviso() {
    const slot = document.getElementById('assinaturasSlot');
    if (!slot || !_ctxAviso) return;
    slot.textContent = '';

    const achados = detectarAssinaturasEsquecidas(_ctxAviso.transacoes, _ctxAviso.assinaturas);
    if (!deveMostrarAviso(achados, _lerDispensa(_ctxAviso))) return;

    const totalAnual = achados.reduce((s, a) => s + a.valorAnual, 0);

    const card = document.createElement('div');
    card.className = 'assin-aviso';

    const iconWrap = document.createElement('div');
    iconWrap.className = 'assin-aviso__icon';
    const ic = document.createElement('i');
    ic.className = 'fas fa-repeat';
    ic.setAttribute('aria-hidden', 'true');
    iconWrap.appendChild(ic);

    const body = document.createElement('button');
    body.type = 'button';
    body.className = 'assin-aviso__body';

    const label = document.createElement('div');
    label.className = 'assin-aviso__label';
    label.textContent = 'Você ainda usa?';

    const valor = document.createElement('div');
    valor.className = 'assin-aviso__valor';
    valor.textContent = `${_ctxAviso.formatBRL(totalAnual)} / ano`;

    const sub = document.createElement('div');
    sub.className = 'assin-aviso__sub';
    sub.textContent = achados.length === 1
        ? '1 cobrança recorrente que você não registrou · toque para ver'
        : `${achados.length} cobranças recorrentes que você não registrou · toque para ver`;

    body.appendChild(label);
    body.appendChild(valor);
    body.appendChild(sub);
    body.addEventListener('click', () => abrirDetectorAssinaturas(_ctxAviso));

    const fechar = document.createElement('button');
    fechar.type = 'button';
    fechar.className = 'assin-aviso__fechar';
    fechar.setAttribute('aria-label', 'Dispensar este aviso por 30 dias');
    const fi = document.createElement('i');
    fi.className = 'fas fa-xmark';
    fi.setAttribute('aria-hidden', 'true');
    fechar.appendChild(fi);
    fechar.addEventListener('click', () => { _gravarDispensa(_ctxAviso); slot.textContent = ''; });

    card.appendChild(iconWrap);
    card.appendChild(body);
    card.appendChild(fechar);
    slot.appendChild(card);
}

/** Boot: chamado pelo dashboard via import() após o carregamento inicial. */
export function initAvisoAssinaturas(ctx) {
    _ctxAviso = ctx;
    _renderAviso();
    // Recalcula após cada save (dados mudaram) — debounced p/ saves em rajada.
    document.addEventListener('ge:save-done', () => {
        clearTimeout(_avisoTimer);
        _avisoTimer = setTimeout(_renderAviso, 1_500);
    });
}

/** Popup com o resultado da varredura — entrada: aba Cartões → Assinaturas. */
export function abrirDetectorAssinaturas(ctx) {
    const achados = detectarAssinaturasEsquecidas(ctx.transacoes, ctx.assinaturas);

    ctx.criarPopupDOM((popup) => {
        const titulo = document.createElement('h3');
        titulo.textContent = 'Assinaturas esquecidas';
        popup.appendChild(titulo);

        if (achados.length === 0) {
            const vazio = document.createElement('div');
            vazio.className = 'rec-vazio';
            const ic = document.createElement('i');
            ic.className = 'fas fa-circle-check';
            ic.setAttribute('aria-hidden', 'true');
            const p = document.createElement('p');
            p.textContent = 'Nenhuma cobrança recorrente não registrada foi encontrada nas suas transações. Tudo sob controle!';
            vazio.appendChild(ic);
            vazio.appendChild(p);
            popup.appendChild(vazio);
        } else {
            const totalAnual = achados.reduce((s, a) => s + a.valorAnual, 0);

            const resumo = document.createElement('div');
            resumo.className = 'rec-resumo';
            const resumoTitulo = document.createElement('div');
            resumoTitulo.className = 'rec-resumo-valor';
            resumoTitulo.textContent = ctx.formatBRL(totalAnual) + ' / ano';
            const resumoSub = document.createElement('div');
            resumoSub.className = 'rec-resumo-sub';
            resumoSub.textContent = `${achados.length} cobrança${achados.length > 1 ? 's' : ''} com padrão de assinatura que você não registrou`;
            resumo.appendChild(resumoTitulo);
            resumo.appendChild(resumoSub);
            popup.appendChild(resumo);

            const lista = document.createElement('div');
            lista.className = 'rec-lista';
            for (const a of achados) {
                const row = document.createElement('div');
                row.className = 'rec-row';

                const info = document.createElement('div');
                info.className = 'rec-row-info';
                const nome = document.createElement('div');
                nome.className = 'rec-row-nome';
                nome.textContent = a.nome; // textContent — descrição do usuário nunca vira HTML
                const meta = document.createElement('div');
                meta.className = 'rec-row-meta';
                meta.textContent = `${a.ocorrencias}× · última em ${a.ultima.toLocaleDateString('pt-BR')}`;
                info.appendChild(nome);
                info.appendChild(meta);

                const valores = document.createElement('div');
                valores.className = 'rec-row-valores';
                const mensal = document.createElement('div');
                mensal.className = 'rec-row-mensal';
                mensal.textContent = ctx.formatBRL(a.valorMensal) + '/mês';
                const anual = document.createElement('div');
                anual.className = 'rec-row-anual';
                anual.textContent = ctx.formatBRL(a.valorAnual) + '/ano';
                valores.appendChild(mensal);
                valores.appendChild(anual);

                row.appendChild(info);
                row.appendChild(valores);
                lista.appendChild(row);
            }
            popup.appendChild(lista);

            const dica = document.createElement('p');
            dica.className = 'rec-dica';
            dica.textContent = 'Reconheceu alguma? Cadastre em Cartões → Assinaturas para acompanhar a cobrança todo mês — ou aproveite para cancelar o que não usa mais.';
            popup.appendChild(dica);
        }

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn-primary';
        btn.textContent = 'Fechar';
        btn.addEventListener('click', () => ctx.fecharPopup());
        popup.appendChild(btn);
    });
}
