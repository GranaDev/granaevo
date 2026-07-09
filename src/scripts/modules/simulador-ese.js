// simulador-ese.js — Simulador "E se?" (lazy)
// ----------------------------------------------------------------------------
// "E se você guardasse R$ X por mês rendendo 100% do CDI?" — projeta juros
// compostos usando a MESMA matemática das reservas (fvComposto) e o CDI real
// do Banco Central (mesma série/cache usados em db-metas).
//
// Entradas: aba Reservas (botão no header) e detalhe de orçamento ("Simular
// corte"). 100% client-side; inputs numéricos com caps; render via DOM API.
// ----------------------------------------------------------------------------

// Mesma chave de cache do db-metas — evita 2ª chamada ao BCB na mesma sessão.
const _CDI_CACHE_KEY = '_ge_cdi_v2';
const _CDI_FALLBACK  = 10.5;

async function _fetchCDI() {
    try {
        const cached = localStorage.getItem(_CDI_CACHE_KEY);
        if (cached) {
            const { val, ts } = JSON.parse(cached);
            if (Date.now() - ts < 21_600_000 && Number.isFinite(val) && val > 0) return val;
        }
    } catch {}
    const _parseBCB = async (serie) => {
        const url = `https://api.bcb.gov.br/dados/serie/bcdata.sgs.${serie}/dados/ultimos/1?formato=json`;
        try {
            const res  = await fetch(url, { signal: AbortSignal.timeout(8_000) });
            const json = await res.json();
            const v    = parseFloat(String(json[0]?.valor ?? '').replace(',', '.'));
            return Number.isFinite(v) && v > 0 ? v : null;
        } catch { return null; }
    };
    const [cdi, selic] = await Promise.all([_parseBCB(4389), _parseBCB(432)]);
    const val = [cdi, selic].reduce((max, v) => (v !== null && v > max ? v : max), 0);
    if (val > 0) {
        try { localStorage.setItem(_CDI_CACHE_KEY, JSON.stringify({ val, ts: Date.now() })); } catch {}
        return val;
    }
    return _CDI_FALLBACK;
}

// Valor futuro com aportes mensais (mesma fórmula do db-metas).
function _fvComposto(pv, pmt, r, n) {
    if (r <= 0) return pv + pmt * n;
    return pv * Math.pow(1 + r, n) + pmt * ((Math.pow(1 + r, n) - 1) / r);
}

function _num(input) {
    const raw = String(input ?? '').trim().replace(/\./g, '').replace(',', '.');
    if (!/^\d+(\.\d{1,2})?$/.test(raw)) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
}

/**
 * Abre o simulador. `prefill` opcional: { valorMensal, origem } — usado pelo
 * detalhe de orçamento ("Simular corte de R$ X em Ifood").
 */
export function abrirSimuladorESe(ctx, prefill) {
    let cdiAnual = _CDI_FALLBACK;

    ctx.criarPopupDOM((popup) => {
        const titulo = document.createElement('h3');
        titulo.textContent = 'Simulador "E se?"';
        popup.appendChild(titulo);

        const intro = document.createElement('p');
        intro.className = 'ese-intro';
        intro.textContent = prefill?.origem
            ? `E se você cortasse parte do gasto com ${prefill.origem} e guardasse rendendo?`
            : 'E se você guardasse um valor todo mês rendendo juros compostos?';
        popup.appendChild(intro);

        // ── Inputs ───────────────────────────────────────────────────────
        const labelValor = document.createElement('label');
        labelValor.className = 'hv-label';
        labelValor.setAttribute('for', 'eseValor');
        labelValor.textContent = 'Valor guardado por mês (R$)';
        const inputValor = document.createElement('input');
        inputValor.type = 'text';
        inputValor.id = 'eseValor';
        inputValor.className = 'hv-input';
        inputValor.inputMode = 'decimal';
        inputValor.autocomplete = 'off';
        inputValor.maxLength = 12;
        inputValor.placeholder = '200,00';

        const labelMeses = document.createElement('label');
        labelMeses.className = 'hv-label';
        labelMeses.textContent = 'Por quanto tempo?';
        const segMeses = document.createElement('div');
        segMeses.className = 'hv-seg';
        let mesesAtivo = 24;
        [[6, '6 meses'], [12, '1 ano'], [24, '2 anos'], [60, '5 anos'], [120, '10 anos']].forEach(([n, label]) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'hv-seg-btn' + (n === mesesAtivo ? ' active' : '');
            b.textContent = label;
            b.addEventListener('click', () => {
                mesesAtivo = n;
                segMeses.querySelectorAll('.hv-seg-btn').forEach(x => x.classList.remove('active'));
                b.classList.add('active');
                _recalc();
            });
            segMeses.appendChild(b);
        });

        const labelCdi = document.createElement('div');
        labelCdi.className = 'ese-cdi-label';
        labelCdi.textContent = 'Rendimento: 100% do CDI (carregando taxa atual…)';

        // ── Resultado ────────────────────────────────────────────────────
        const resultado = document.createElement('div');
        resultado.className = 'ese-resultado';
        resultado.setAttribute('aria-live', 'polite');

        const resValor = document.createElement('div');
        resValor.className = 'ese-res-valor';
        const resDetalhe = document.createElement('div');
        resDetalhe.className = 'ese-res-detalhe';
        const resHoras = document.createElement('div');
        resHoras.className = 'ese-res-horas';
        resultado.appendChild(resValor);
        resultado.appendChild(resDetalhe);
        resultado.appendChild(resHoras);

        function _recalc() {
            const pmt = _num(inputValor.value);
            if (pmt === null || pmt <= 0 || pmt > 1_000_000) {
                resValor.textContent = '—';
                resDetalhe.textContent = 'Informe um valor mensal para simular.';
                resHoras.textContent = '';
                return;
            }
            const rMensal   = Math.pow(1 + cdiAnual / 100, 1 / 12) - 1;
            const total     = _fvComposto(0, pmt, rMensal, mesesAtivo);
            const aportado  = pmt * mesesAtivo;
            const juros     = total - aportado;
            resValor.textContent = ctx.formatBRL(total);
            resDetalhe.textContent = `${ctx.formatBRL(aportado)} guardados + ${ctx.formatBRL(juros)} de rendimento (${cdiAnual.toFixed(2).replace('.', ',')}% a.a.)`;

            // Bônus: se Horas de Vida está ativo, mostra o equivalente em trabalho
            const hv = ctx.configPerfil?.horasVida;
            const vh = Number(hv?.valorHora);
            if (hv?.ativo === true && Number.isFinite(vh) && vh > 0) {
                const horas = Math.round(juros / vh);
                resHoras.textContent = horas > 0
                    ? `Só o rendimento equivale a ~${horas}h do seu trabalho — de graça.`
                    : '';
            } else {
                resHoras.textContent = '';
            }
        }

        inputValor.addEventListener('input', _recalc);

        popup.appendChild(labelValor);
        popup.appendChild(inputValor);
        popup.appendChild(labelMeses);
        popup.appendChild(segMeses);
        popup.appendChild(labelCdi);
        popup.appendChild(resultado);

        const acoes = document.createElement('div');
        acoes.className = 'hv-acoes';
        const btnMeta = document.createElement('button');
        btnMeta.type = 'button';
        btnMeta.className = 'btn-primary';
        btnMeta.textContent = 'Criar reserva com esse plano';
        btnMeta.addEventListener('click', () => {
            ctx.fecharPopup();
            // Leva o usuário direto para a criação de reserva na aba Reservas
            const navBtn = document.querySelector('.nav-btn[data-page="reservas"]')
                        || document.querySelector('.mobile-nav-item[data-page="reservas"]');
            navBtn?.click();
            setTimeout(() => document.getElementById('btnNovaMeta')?.click(), 600);
        });
        const btnFechar = document.createElement('button');
        btnFechar.type = 'button';
        btnFechar.className = 'btn-outline';
        btnFechar.textContent = 'Fechar';
        btnFechar.addEventListener('click', () => ctx.fecharPopup());
        acoes.appendChild(btnMeta);
        acoes.appendChild(btnFechar);
        popup.appendChild(acoes);

        // Prefill do detalhe de orçamento (30% do gasto como sugestão de corte)
        if (Number.isFinite(Number(prefill?.valorMensal)) && Number(prefill.valorMensal) > 0) {
            const sugestao = Math.max(10, Math.round(Number(prefill.valorMensal) * 0.3));
            inputValor.value = String(sugestao).replace('.', ',');
        }

        _recalc();
        _fetchCDI().then(v => {
            cdiAnual = v;
            labelCdi.textContent = `Rendimento: 100% do CDI (${v.toFixed(2).replace('.', ',')}% a.a. — fonte: Banco Central)`;
            _recalc();
        }).catch(() => {
            labelCdi.textContent = `Rendimento: 100% do CDI (~${_CDI_FALLBACK.toFixed(1).replace('.', ',')}% a.a. estimado)`;
        });
        setTimeout(() => inputValor.focus(), 60);
    });
}
