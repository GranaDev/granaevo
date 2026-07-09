// horas-vida.js — "Preço em horas de vida trabalhada" (lazy)
// ----------------------------------------------------------------------------
// Converte gastos em horas de trabalho do usuário. O usuário informa quanto
// ganha por HORA, por DIA ou por MÊS; o módulo normaliza tudo para valor/hora
// e o restante do app só lê a config normalizada via getHorasVida().
//
// Persistência: perfilData.config.horasVida (mesmo blob user_data, RLS).
// O dashboard sanitiza a config no save (_sanitizarConfigPerfil) — este módulo
// valida ANTES de gravar e o save valida DE NOVO (defesa em profundidade).
// Nenhum dado dinâmico entra via innerHTML: todo render usa textContent.
// ----------------------------------------------------------------------------

// ── Limites de sanidade (espelhados no sanitizador do dashboard.js) ──────────
const LIMITES = Object.freeze({
    valorHoraMin: 0.01,  valorHoraMax: 100_000,
    valorBaseMin: 0.01,  valorBaseMax: 10_000_000,
    horasDiaMin:  1,     horasDiaMax:  24,
    horasSemanaMin: 1,   horasSemanaMax: 120,
});
const SEMANAS_POR_MES = 4.345; // 52.14 semanas / 12 meses

/** Config normalizada { ativo, valorHora } ou null se nunca configurada. */
export function getHorasVida(configPerfil) {
    const hv = configPerfil?.horasVida;
    if (!hv || typeof hv !== 'object') return null;
    const valorHora = Number(hv.valorHora);
    if (!Number.isFinite(valorHora) ||
        valorHora < LIMITES.valorHoraMin || valorHora > LIMITES.valorHoraMax) return null;
    return { ativo: hv.ativo === true, valorHora, modo: hv.modo || 'hora' };
}

/** "R$ 68,00" com valorHora 20 → "3h 24min". Retorna null p/ entradas inválidas. */
export function formatarHoras(valor, valorHora) {
    const v  = Number(valor);
    const vh = Number(valorHora);
    if (!Number.isFinite(v) || !Number.isFinite(vh) || v <= 0 || vh <= 0) return null;
    const horasTotal = v / vh;
    if (horasTotal < 1 / 60) return '< 1min';
    const h = Math.floor(horasTotal);
    const m = Math.round((horasTotal - h) * 60);
    if (h === 0)  return `${m}min`;
    if (m === 0)  return `${h}h`;
    if (h >= 200) return `${h}h`; // acima disso minutos são ruído
    return `${h}h ${String(m).padStart(2, '0')}min`;
}

/**
 * Chip DOM "⏱ 3h 24min" para anexar ao lado de valores de saída.
 * Retorna null quando o recurso está desativado — caller só faz appendChild.
 * 100% textContent: imune a XSS mesmo com descrição/valor manipulados.
 */
export function chipHorasVida(valor, configPerfil) {
    const hv = getHorasVida(configPerfil);
    if (!hv || !hv.ativo) return null;
    const texto = formatarHoras(valor, hv.valorHora);
    if (!texto) return null;
    const chip = document.createElement('span');
    chip.className = 'hv-chip';
    chip.title = 'Custo em horas do seu trabalho';
    const ic = document.createElement('i');
    ic.className = 'fas fa-briefcase';
    ic.setAttribute('aria-hidden', 'true');
    chip.appendChild(ic);
    chip.appendChild(document.createTextNode(' ' + texto));
    return chip;
}

// ── Cálculo do valor/hora a partir do modo escolhido ─────────────────────────
function _calcularValorHora(modo, valorBase, horasDia, horasSemana) {
    if (modo === 'hora') return valorBase;
    if (modo === 'dia')  return horasDia > 0 ? valorBase / horasDia : null;
    if (modo === 'mes')  return horasSemana > 0 ? valorBase / (horasSemana * SEMANAS_POR_MES) : null;
    return null;
}

function _num(input) {
    // Aceita "1.234,56" e "1234.56"; rejeita qualquer outra coisa.
    const raw = String(input ?? '').trim().replace(/\./g, '').replace(',', '.');
    if (!/^\d+(\.\d{1,2})?$/.test(raw)) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
}

/**
 * Popup de configuração (Configurações → Horas de Vida).
 * Todo o formulário é construído via DOM API (criarPopupDOM) — nada de
 * interpolação de strings. A gravação passa pelo salvarDados do dashboard,
 * que sanitiza e valida o objeto inteiro de novo no servidor de dados.
 */
export function abrirPopupHorasVida(ctx, aoSalvar) {
    const atual = getHorasVida(ctx.configPerfil);

    ctx.criarPopupDOM((popup) => {
        const titulo = document.createElement('h3');
        titulo.textContent = 'Horas de Vida';
        popup.appendChild(titulo);

        const intro = document.createElement('p');
        intro.className = 'hv-pop-intro';
        intro.textContent = 'Veja cada gasto convertido em horas do seu trabalho. Informe quanto você ganha e o GranaEvo calcula o resto. O valor fica salvo apenas na sua conta.';
        popup.appendChild(intro);

        // ── Seletor de modo (hora / dia / mês) ──────────────────────────
        const modos = [
            { id: 'hora', label: 'Por hora',  hint: 'Valor da sua hora'   },
            { id: 'dia',  label: 'Por dia',   hint: 'Valor do seu dia'    },
            { id: 'mes',  label: 'Por mês',   hint: 'Seu salário mensal'  },
        ];
        let modoAtivo = atual?.modo && ['hora', 'dia', 'mes'].includes(atual.modo) ? atual.modo : 'mes';

        const seg = document.createElement('div');
        seg.className = 'hv-seg';
        seg.setAttribute('role', 'tablist');

        const campoValorLabel = document.createElement('label');
        campoValorLabel.className = 'hv-label';
        campoValorLabel.setAttribute('for', 'hvValorBase');

        const inputValor = document.createElement('input');
        inputValor.type = 'text';
        inputValor.id = 'hvValorBase';
        inputValor.className = 'hv-input';
        inputValor.inputMode = 'decimal';
        inputValor.autocomplete = 'off';
        inputValor.maxLength = 12;
        inputValor.placeholder = '0,00';

        // Campo extra (horas/dia ou horas/semana) — visível conforme o modo
        const campoExtraLabel = document.createElement('label');
        campoExtraLabel.className = 'hv-label';
        campoExtraLabel.setAttribute('for', 'hvExtra');
        const inputExtra = document.createElement('input');
        inputExtra.type = 'text';
        inputExtra.id = 'hvExtra';
        inputExtra.className = 'hv-input';
        inputExtra.inputMode = 'numeric';
        inputExtra.autocomplete = 'off';
        inputExtra.maxLength = 5;

        const preview = document.createElement('div');
        preview.className = 'hv-preview';
        preview.setAttribute('aria-live', 'polite');

        const erroEl = document.createElement('div');
        erroEl.className = 'hv-erro';
        erroEl.setAttribute('role', 'alert');

        function _syncCampos() {
            campoValorLabel.textContent = modos.find(m => m.id === modoAtivo).hint + ' (R$)';
            if (modoAtivo === 'dia') {
                campoExtraLabel.textContent = 'Horas trabalhadas por dia';
                inputExtra.placeholder = '8';
                campoExtraLabel.style.display = '';
                inputExtra.style.display = '';
            } else if (modoAtivo === 'mes') {
                campoExtraLabel.textContent = 'Horas trabalhadas por semana';
                inputExtra.placeholder = '40';
                campoExtraLabel.style.display = '';
                inputExtra.style.display = '';
            } else {
                campoExtraLabel.style.display = 'none';
                inputExtra.style.display = 'none';
            }
            _syncPreview();
        }

        function _lerValorHora() {
            const base = _num(inputValor.value);
            if (base === null || base < LIMITES.valorBaseMin || base > LIMITES.valorBaseMax) return null;
            let extra = null;
            if (modoAtivo === 'dia') {
                extra = _num(inputExtra.value);
                if (extra === null || extra < LIMITES.horasDiaMin || extra > LIMITES.horasDiaMax) return null;
            } else if (modoAtivo === 'mes') {
                extra = _num(inputExtra.value);
                if (extra === null || extra < LIMITES.horasSemanaMin || extra > LIMITES.horasSemanaMax) return null;
            }
            const vh = _calcularValorHora(modoAtivo, base, extra, extra);
            if (vh === null || vh < LIMITES.valorHoraMin || vh > LIMITES.valorHoraMax) return null;
            return { valorHora: Math.round(vh * 100) / 100, valorBase: base, extra };
        }

        function _syncPreview() {
            erroEl.textContent = '';
            const r = _lerValorHora();
            if (!r) { preview.textContent = ''; return; }
            preview.textContent = `Sua hora vale ${ctx.formatBRL(r.valorHora)} — um gasto de R$ 100 custa ${formatarHoras(100, r.valorHora)} de trabalho.`;
        }

        modos.forEach(m => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'hv-seg-btn' + (m.id === modoAtivo ? ' active' : '');
            b.textContent = m.label;
            b.setAttribute('role', 'tab');
            b.addEventListener('click', () => {
                modoAtivo = m.id;
                seg.querySelectorAll('.hv-seg-btn').forEach(x => x.classList.remove('active'));
                b.classList.add('active');
                _syncCampos();
            });
            seg.appendChild(b);
        });

        inputValor.addEventListener('input', _syncPreview);
        inputExtra.addEventListener('input', _syncPreview);

        popup.appendChild(seg);
        popup.appendChild(campoValorLabel);
        popup.appendChild(inputValor);
        popup.appendChild(campoExtraLabel);
        popup.appendChild(inputExtra);
        popup.appendChild(preview);
        popup.appendChild(erroEl);

        // ── Botões ───────────────────────────────────────────────────────
        const acoes = document.createElement('div');
        acoes.className = 'hv-acoes';

        const btnSalvar = document.createElement('button');
        btnSalvar.type = 'button';
        btnSalvar.className = 'btn-primary';
        btnSalvar.textContent = atual?.ativo ? 'Atualizar' : 'Ativar';
        btnSalvar.addEventListener('click', () => {
            const r = _lerValorHora();
            if (!r) {
                erroEl.textContent = 'Confira os valores: use números válidos dentro dos limites.';
                return;
            }
            const cfg = (ctx.configPerfil && typeof ctx.configPerfil === 'object') ? ctx.configPerfil : {};
            cfg.horasVida = {
                ativo:     true,
                modo:      modoAtivo,
                valorHora: r.valorHora,
                valorBase: r.valorBase,
                ...(modoAtivo === 'dia' ? { horasDia:    r.extra } : {}),
                ...(modoAtivo === 'mes' ? { horasSemana: r.extra } : {}),
            };
            ctx.configPerfil = cfg;
            ctx.salvarDadosUrgente();
            ctx.fecharPopup();
            ctx.mostrarNotificacao('Horas de Vida ativado! Seus gastos agora mostram o custo em horas de trabalho.', 'success');
            if (typeof aoSalvar === 'function') aoSalvar();
        });
        acoes.appendChild(btnSalvar);

        if (atual?.ativo) {
            const btnDesativar = document.createElement('button');
            btnDesativar.type = 'button';
            btnDesativar.className = 'btn-outline';
            btnDesativar.textContent = 'Desativar';
            btnDesativar.addEventListener('click', () => {
                const cfg = (ctx.configPerfil && typeof ctx.configPerfil === 'object') ? ctx.configPerfil : {};
                if (cfg.horasVida) cfg.horasVida.ativo = false;
                ctx.configPerfil = cfg;
                ctx.salvarDadosUrgente();
                ctx.fecharPopup();
                ctx.mostrarNotificacao('Horas de Vida desativado.', 'info');
                if (typeof aoSalvar === 'function') aoSalvar();
            });
            acoes.appendChild(btnDesativar);
        }

        const btnCancelar = document.createElement('button');
        btnCancelar.type = 'button';
        btnCancelar.className = 'btn-outline';
        btnCancelar.textContent = 'Cancelar';
        btnCancelar.addEventListener('click', () => ctx.fecharPopup());
        acoes.appendChild(btnCancelar);

        popup.appendChild(acoes);

        // Pré-preenche com o estado atual
        if (atual) {
            const hv = ctx.configPerfil?.horasVida || {};
            if (Number.isFinite(Number(hv.valorBase)) && Number(hv.valorBase) > 0) {
                inputValor.value = String(hv.valorBase).replace('.', ',');
            }
            if (modoAtivo === 'dia' && Number.isFinite(Number(hv.horasDia)))       inputExtra.value = String(hv.horasDia);
            if (modoAtivo === 'mes' && Number.isFinite(Number(hv.horasSemana)))    inputExtra.value = String(hv.horasSemana);
        }
        _syncCampos();
        setTimeout(() => inputValor.focus(), 60);
    });
}
