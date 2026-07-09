// recorrencias.js — Detector de assinaturas esquecidas (lazy)
// ----------------------------------------------------------------------------
// Varre as transações e encontra cobranças com padrão de recorrência mensal
// (~28–33 dias, valor estável) que NÃO estão registradas como assinatura —
// e mostra quanto elas custam por ano. 100% client-side, matemática pura.
//
// Critérios (conservadores, para não gerar falso-positivo):
//   - categoria 'saida' ou 'saida_credito', excluindo 'Conta fixa' e 'Cartão'
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
export function detectarAssinaturasEsquecidas(transacoes, assinaturas) {
    const grupos = new Map();
    const hoje = new Date();

    for (const t of (transacoes || [])) {
        if (t.categoria !== 'saida' && t.categoria !== 'saida_credito') continue;
        if (t.tipo === 'Conta fixa' || t.tipo === 'Cartão') continue;
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
