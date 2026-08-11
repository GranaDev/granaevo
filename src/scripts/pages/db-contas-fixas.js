// ----------------------------------------------------------------------------
// db-contas-fixas.js — as INTERAÇÕES de Contas Fixas (LAZY, Passo 10)
//
// POR QUE FOI EXTRAÍDO: eram ~565 linhas carregadas em TODO boot para telas que
// só existem depois de um clique. `dashboard.js` estava em 40,8/42 KB gzip —
// 97% do orçamento, sem espaço para nenhuma feature nova. Medido: sai a 37,8.
//
// O QUE FICOU DO OUTRO LADO DA FRONTEIRA (de propósito):
//   · `atualizarListaContasFixas()` — PINTA a seção da tela inicial, é quente;
//   · `rollbackArray` e `_avancarMes` — usados por código quente e por outros
//     módulos via _ctx. Movê-los quebraria `_repararFaturasAdiantadas`.
//
// ARRAYS VIVOS: `contasFixas`, `transacoes` e `cartoesCredito` são acessados
// SEMPRE por `_ctx.x`, nunca por alias local. Dois motivos, os dois já
// custaram bug neste projeto:
//   1. o setter de _makeCtx troca a REFERÊNCIA do array ao carregar o perfil —
//      um `const` capturado no init apontaria para o array vazio do boot;
//   2. `_ctx.contasFixas = ...filter(...)` precisa passar pelo setter, que é
//      quem invalida o cache de cópias congeladas (`_cache.cf`).
//
// ⚠️ `tx-builder.js` tem uma RÉPLICA FIEL do caminho "conta recorrente" de
// `pagarContaFixa` (o assistente paga conta por voz). Mudou a regra aqui,
// mude lá — não há teste que ligue os dois.
// ----------------------------------------------------------------------------

import { aplicarMascaraMoeda, lerMoeda, definirMoeda } from '../modules/mascara-moeda.js?v=1';
import { novoId } from '../modules/registro-id.js?v=1';
import { valorAbertoFatura } from '../modules/fatura-parcelas.js?v=1';

// Contexto do dashboard (arrays vivos + utilitários), entregue no init().
let _ctx = null;

// Atalhos para o que ficou no dashboard.js. Mesmo padrão de
// db-relatorios-export.js: proxies, nunca cópias.
const mostrarNotificacao        = (...a) => _ctx.mostrarNotificacao(...a);
const fecharPopup               = (...a) => _ctx.fecharPopup(...a);
const criarPopup                = (...a) => _ctx.criarPopup(...a);
const salvarDados               = (...a) => _ctx.salvarDados(...a);
const atualizarTudo             = (...a) => _ctx.atualizarTudo(...a);
const atualizarListaContasFixas = (...a) => _ctx.atualizarListaContasFixas(...a);
const formatBRL                 = (...a) => _ctx.formatBRL(...a);
const formatarDataBR            = (...a) => _ctx.formatarDataBR(...a);
const agoraDataHora             = (...a) => _ctx.agoraDataHora(...a);
const rollbackArray             = (...a) => _ctx.rollbackArray(...a);
const _avancarMes               = (...a) => _ctx._avancarMes(...a);

export function init(ctx) { _ctx = ctx; }

// ── Visualização (read-only) da conta fixa ──────────────────────────────────
// Abre primeiro um cartão limpo APENAS para ver a conta. Editar/Pagar/Antecipar
// são ações explícitas — o teclado e os campos só aparecem se o usuário tocar
// em "Editar". Evita a edição acidental ao simplesmente tocar no card.
export function abrirContaFixaView(id) {
    const conta = _ctx.contasFixas.find(c => c.id === id);
    if (!conta) return;

    const hojeISO  = new Date().toISOString().slice(0, 10);
    const mesAtual = hojeISO.slice(0, 7);
    const vencValido = typeof conta.vencimento === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(conta.vencimento);
    const vencMes    = vencValido ? conta.vencimento.slice(0, 7) : null;
    const estaPago =
        (conta.dataPagamento && conta.dataPagamento.slice(0, 7) === mesAtual) ||
        (conta.pago === true && !conta.dataPagamento && vencMes !== null && vencMes > mesAtual);

    let status = 'Pendente', statusClass = 'status-pendente';
    if (estaPago) {
        status = 'Pago'; statusClass = 'status-pago';
    } else if (vencValido && conta.vencimento < hojeISO) {
        status = 'Vencido'; statusClass = 'status-vencido';
    }

    const temParcela = conta.totalParcelas && conta.parcelaAtual;

    // Contagem regressiva inteligente (date-only, sem fuso) para o subtítulo
    let prazoTexto = '', prazoClass = 'cf-prazo-ok', prazoIcon = 'fa-clock';
    if (estaPago) {
        prazoTexto = 'Pago neste mês';
        prazoClass = 'cf-prazo-pago';
        prazoIcon  = 'fa-circle-check';
    } else if (vencValido) {
        const [vy, vm, vd] = conta.vencimento.split('-').map(Number);
        const alvo  = new Date(vy, vm - 1, vd);
        const agora = new Date();
        const hoje0 = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate());
        const dias  = Math.round((alvo - hoje0) / 86400000);

        if (dias > 1) {
            prazoTexto = `Vence em ${dias} dias`;
            prazoClass = dias <= 5 ? 'cf-prazo-soon' : 'cf-prazo-ok';
            prazoIcon  = 'fa-clock';
        } else if (dias === 1) {
            prazoTexto = 'Vence amanhã';  prazoClass = 'cf-prazo-soon'; prazoIcon = 'fa-clock';
        } else if (dias === 0) {
            prazoTexto = 'Vence hoje';     prazoClass = 'cf-prazo-soon'; prazoIcon = 'fa-triangle-exclamation';
        } else {
            const atraso = Math.abs(dias);
            prazoTexto = `Vencido há ${atraso} ${atraso === 1 ? 'dia' : 'dias'}`;
            prazoClass = 'cf-prazo-late'; prazoIcon = 'fa-triangle-exclamation';
        }
    }

    // ✅ HTML 100% estático — nenhum dado do usuário aqui (inserido via textContent abaixo)
    criarPopup(`
        <div class="cf-view">
            <div class="cf-view-hero">
                <div class="cf-view-icon"><i class="fas fa-receipt" aria-hidden="true"></i></div>
                <div class="cf-view-heart">
                    <h3 id="cfViewDesc"></h3>
                    <span class="cf-prazo ${prazoClass}">
                        <i class="fas ${prazoIcon}" aria-hidden="true"></i>
                        <span id="cfViewPrazo"></span>
                    </span>
                </div>
                <span class="conta-status" id="cfViewStatus"></span>
            </div>

            <div class="cf-view-amount">
                <span class="cf-view-amount-label">Valor</span>
                <span class="cf-view-amount-val" id="cfViewValor"></span>
            </div>

            <div class="cf-view-rows">
                <div class="cf-view-row">
                    <span class="cf-view-label"><i class="fas fa-calendar-day" aria-hidden="true"></i> Vencimento</span>
                    <span class="cf-view-val" id="cfViewVenc"></span>
                </div>
                <div class="cf-view-row" id="cfViewParcelaRow" style="display:none;">
                    <span class="cf-view-label"><i class="fas fa-layer-group" aria-hidden="true"></i> Parcela</span>
                    <span class="cf-view-val" id="cfViewParcela"></span>
                </div>
            </div>

            <div class="cf-view-actions">
                ${estaPago
                    ? '<button class="btn-warning cf-act-primary" id="cfViewAcao"><i class="fas fa-bolt" aria-hidden="true"></i> Antecipar</button>'
                    : '<button class="btn-primary cf-act-primary" id="cfViewAcao"><i class="fas fa-circle-dollar-to-slot" aria-hidden="true"></i> Pagar</button>'}
                <button class="btn-outline" id="cfViewEditar"><i class="fas fa-pen" aria-hidden="true"></i> Editar</button>
                <button class="btn-cancelar" id="cfViewFechar">Fechar</button>
            </div>
        </div>
    `);

    // ✅ Preenchimento seguro via textContent — nunca interpreta HTML
    document.getElementById('cfViewDesc').textContent  = conta.descricao;
    document.getElementById('cfViewPrazo').textContent = prazoTexto;
    const statusEl = document.getElementById('cfViewStatus');
    statusEl.textContent = status;
    statusEl.classList.add(statusClass);
    document.getElementById('cfViewValor').textContent = formatBRL(conta.valor);
    document.getElementById('cfViewVenc').textContent  = formatarDataBR(conta.vencimento);
    if (temParcela) {
        document.getElementById('cfViewParcelaRow').style.display = 'flex';
        document.getElementById('cfViewParcela').textContent = `${conta.parcelaAtual}/${conta.totalParcelas}`;
    }

    document.getElementById('cfViewFechar').onclick = () => fecharPopup();
    // criarPopup() substitui o conteúdo no mesmo container — transição suave, sem flicker
    document.getElementById('cfViewEditar').onclick = () => abrirContaFixaForm(id);
    document.getElementById('cfViewAcao').onclick = () => {
        if (estaPago) abrirPopupAnteciparContaFixa(id);
        else          abrirPopupPagarContaFixa(id);
    };
}

export function abrirContaFixaForm(editId = null) {
    if(editId === null) {
        criarPopup(`
            <h3>Nova Conta Fixa</h3>
            <input type="text" id="descContaFixa" class="form-input" placeholder="Descrição"><br>
            <input type="text" id="valorContaFixa" class="form-input" placeholder="Valor (R$)" inputmode="decimal"><br>
            <label style="display:block; text-align:left; margin-top:10px; margin-bottom:6px; color: var(--text-secondary); font-weight:600;">📅 Data de Vencimento:</label>
            <input type="date" id="vencContaFixa" class="form-input"><br>
            <button class="btn-primary" id="okContaFixa">Salvar</button>
            <button class="btn-cancelar" id="cancelarContaFixa">Cancelar</button>
        `);

        aplicarMascaraMoeda('valorContaFixa');

        document.getElementById('cancelarContaFixa').onclick = () => fecharPopup();

        document.getElementById('okContaFixa').onclick = () => {
            const desc     = document.getElementById('descContaFixa').value.trim();
            const valorStr = document.getElementById('valorContaFixa').value;
            const venc     = document.getElementById('vencContaFixa').value;

            if(!desc || !valorStr || !venc) return mostrarNotificacao('Preencha todos os campos.', 'error');
            if(desc.length > 100) return mostrarNotificacao('Descrição muito longa (máx. 100 caracteres).', 'error');

            const valor = parseFloat(lerMoeda('valorContaFixa').toFixed(2));
            if(isNaN(valor) || valor <= 0) return mostrarNotificacao('Informe um valor válido e positivo.', 'error');
            if(!/^\d{4}-\d{2}-\d{2}$/.test(venc)) return mostrarNotificacao('Data de vencimento inválida.', 'error');

            _ctx.contasFixas.push({ id: novoId(), descricao: desc, valor, vencimento: venc, pago: false });
            _ctx._invalidarCache('cf');
            salvarDados();
            atualizarListaContasFixas();
            fecharPopup();
        };

    } else {
        const conta = _ctx.contasFixas.find(c => c.id === editId);
        if(!conta) return;

        // Verifica se já está pago (vencimento em mês futuro)
        const _hojeStr = new Date().toISOString().slice(0, 7);
        const _vencMes = conta.vencimento ? conta.vencimento.slice(0, 7) : null;
        const _jaPago  = _vencMes && _vencMes > _hojeStr;

        criarPopup(`
            <h3>Editar Conta Fixa</h3>
            <input type="text" id="descContaFixa" class="form-input" maxlength="100"><br>
            <input type="text" id="valorContaFixa" class="form-input" inputmode="decimal"><br>
            <input type="date" id="vencContaFixa" class="form-input"><br>
            ${_jaPago ? '<button class="btn-warning" id="anteciparContaBtn">⚡ Antecipar pagamento</button>' : ''}
            <button class="btn-primary" id="salvarEditContaFixa">Salvar</button>
            <button class="btn-excluir" id="excluirContaFixa">Excluir</button>
            <button class="btn-cancelar" id="cancelarContaFixa">Cancelar</button>
        `);

        // ✅ Preenchimento seguro via .value — nunca via innerHTML/atributo
        document.getElementById('descContaFixa').value  = conta.descricao;
        aplicarMascaraMoeda('valorContaFixa');
        definirMoeda('valorContaFixa', conta.valor);
        document.getElementById('vencContaFixa').value  = conta.vencimento;

        document.getElementById('cancelarContaFixa').onclick = () => fecharPopup();

        if (_jaPago) {
            document.getElementById('anteciparContaBtn').onclick = () => {
                fecharPopup();
                abrirPopupAnteciparContaFixa(editId);
            };
        }

        document.getElementById('salvarEditContaFixa').onclick = () => {
            const desc     = document.getElementById('descContaFixa').value.trim();
            const valorStr = document.getElementById('valorContaFixa').value;
            const venc     = document.getElementById('vencContaFixa').value;

            if(!desc || !valorStr || !venc) return mostrarNotificacao('Preencha todos os campos.', 'error');
            if(desc.length > 100) return mostrarNotificacao('Descrição muito longa (máx. 100 caracteres).', 'error');

            const valor = parseFloat(lerMoeda('valorContaFixa').toFixed(2));
            if(isNaN(valor) || valor <= 0) return mostrarNotificacao('Informe um valor válido e positivo.', 'error');
            if(!/^\d{4}-\d{2}-\d{2}$/.test(venc)) return mostrarNotificacao('Data de vencimento inválida.', 'error');

            conta.descricao  = desc;
            conta.valor      = valor;
            conta.vencimento = venc;
            salvarDados();
            atualizarListaContasFixas();
            fecharPopup();
        };

        document.getElementById('excluirContaFixa').onclick = () => {
            if(confirm('Tem certeza que deseja excluir esta conta fixa?')) {
                _ctx.contasFixas = _ctx.contasFixas.filter(c => c.id !== editId);
                salvarDados();
                atualizarListaContasFixas();
                fecharPopup();
            }
        };
    }
}

export function abrirPopupPagarContaFixa(id) {
    const conta = _ctx.contasFixas.find(c => c.id === id);
    if(!conta) return;

    let valorDigitado = conta.valor;

    // ✅ O HTML do popup não contém NENHUM dado do usuário
    //    Os textos são injetados via textContent após o DOM ser criado
    criarPopup(`
        <h3>Pagar Conta Fixa</h3>
        <div id="popupDescricao" style="color: var(--text-secondary);"></div>
        <div id="popupValor" style="margin-bottom:12px;"></div>
        <div id="popupVencimento" style="margin-bottom:12px;"></div>
        <div style="color: var(--warning); margin-bottom:8px;">O valor está correto?</div>
        <button class="btn-primary" id="simValorCorreto">Sim</button>
        <button class="btn-warning" id="naoValorCorreto">Não</button>
        <button class="btn-cancelar" id="cancelarPagamento">Cancelar</button>
        <div id="ajusteValorDiv" style="display:none; margin-top:14px;">
            <input type="text" id="novoValorContaFixa" class="form-input" inputmode="decimal"><br>
            <button class="btn-primary" id="confirmNovoValor" style="margin-top:8px;">Confirmar novo valor</button>
        </div>
    `);

    // ✅ Preenchimento seguro — textContent nunca interpreta HTML
    document.getElementById('popupDescricao').textContent  = conta.descricao;
    document.getElementById('popupValor').textContent      = `Valor: ${formatBRL(conta.valor)}`;
    document.getElementById('popupVencimento').textContent = `Vencimento: ${formatarDataBR(conta.vencimento)}`;

    // ✅ Campo numérico preenchido via .value
    aplicarMascaraMoeda('novoValorContaFixa');
    definirMoeda('novoValorContaFixa', conta.valor);

    document.getElementById('cancelarPagamento').onclick = () => fecharPopup();

    document.getElementById('simValorCorreto').onclick = () => {
        pagarContaFixa(id, conta.valor);
        fecharPopup();
    };

    document.getElementById('naoValorCorreto').onclick = () => {
        document.getElementById('ajusteValorDiv').style.display = 'block';
        document.getElementById('simValorCorreto').disabled = true;
        document.getElementById('naoValorCorreto').disabled = true;

        document.getElementById('confirmNovoValor').onclick = () => {
            const valStr = document.getElementById('novoValorContaFixa').value;

            // ✅ Validação reforçada: número, positivo e com máximo razoável
            const novoValor = lerMoeda('novoValorContaFixa');
            if(!valStr || isNaN(novoValor) || novoValor <= 0 || novoValor > 9999999) {
                return mostrarNotificacao('Digite um valor válido!', 'error');
            }

            valorDigitado = parseFloat(novoValor.toFixed(2));

            if(confirm(`Confirma o pagamento de ${formatBRL(valorDigitado)}?`)) {
                pagarContaFixa(id, valorDigitado);
                fecharPopup();
            }
        };
    };
}

export function abrirPopupAnteciparContaFixa(id) {
    const conta = _ctx.contasFixas.find(c => c.id === id);
    if (!conta) return;

    // O próximo vencimento após a antecipação
    const proximoVenc = _avancarMes(conta.vencimento);

    criarPopup(`
        <h3>⚡ Antecipar Pagamento</h3>
        <div id="popupDescricaoAnt" style="color: var(--text-secondary);"></div>
        <div id="popupProxVencAnt" style="margin-bottom:12px;"></div>
        <div id="popupValorAnt" style="margin-bottom:12px;"></div>
        <div style="color: var(--warning); margin-bottom:8px;">O valor está correto?</div>
        <button class="btn-primary" id="simValorAnt">Sim</button>
        <button class="btn-warning" id="naoValorAnt">Não</button>
        <button class="btn-cancelar" id="cancelarAnt">Cancelar</button>
        <div id="ajusteValorAnt" style="display:none; margin-top:14px;">
            <input type="text" id="novoValorAnt" class="form-input" inputmode="decimal"><br>
            <button class="btn-primary" id="confirmNovoValorAnt" style="margin-top:8px;">Confirmar novo valor</button>
        </div>
    `);

    document.getElementById('popupDescricaoAnt').textContent = conta.descricao;
    document.getElementById('popupProxVencAnt').textContent  = `Antecipando para: ${formatarDataBR(proximoVenc)}`;
    document.getElementById('popupValorAnt').textContent     = `Valor: ${formatBRL(conta.valor)}`;
    aplicarMascaraMoeda('novoValorAnt');
    definirMoeda('novoValorAnt', conta.valor);

    document.getElementById('cancelarAnt').onclick = () => fecharPopup();

    document.getElementById('simValorAnt').onclick = () => {
        anteciparContaFixa(id, conta.valor);
        fecharPopup();
    };

    document.getElementById('naoValorAnt').onclick = () => {
        document.getElementById('ajusteValorAnt').style.display = 'block';
        document.getElementById('simValorAnt').disabled = true;
        document.getElementById('naoValorAnt').disabled = true;

        document.getElementById('confirmNovoValorAnt').onclick = () => {
            const valStr    = document.getElementById('novoValorAnt').value;
            const novoValor = lerMoeda('novoValorAnt');
            if (!valStr || isNaN(novoValor) || novoValor <= 0 || novoValor > 9999999) {
                return mostrarNotificacao('Digite um valor válido!', 'error');
            }
            const valorFinal = parseFloat(novoValor.toFixed(2));
            if (confirm(`Confirma a antecipação de ${formatBRL(valorFinal)}?`)) {
                anteciparContaFixa(id, valorFinal);
                fecharPopup();
            }
        };
    };
}

function anteciparContaFixa(id, valorPago) {
    const conta = _ctx.contasFixas.find(c => c.id === id);
    if (!conta) return;

    if (conta._processando) {
        mostrarNotificacao('Aguarde, pagamento em andamento...', 'info');
        return;
    }
    conta._processando = true;

    const valorSeguro = parseFloat(valorPago);
    if (!isFinite(valorSeguro) || valorSeguro <= 0 || valorSeguro > 9_999_999) {
        mostrarNotificacao('Valor de pagamento inválido.', 'error');
        conta._processando = false;
        return;
    }

    let snapshotTransacoes  = [];
    let snapshotContasFixas = [];
    let snapshotCartoes     = [];

    try {
        snapshotTransacoes  = structuredClone(_ctx.transacoes);
        snapshotContasFixas = structuredClone(_ctx.contasFixas);
        snapshotCartoes     = structuredClone(_ctx.cartoesCredito);

        const dh = agoraDataHora();
        const descricaoSegura = String(conta.descricao || '').slice(0, 100);

        _ctx.transacoes.push({
            id:          novoId(),
            categoria:   'saida',
            tipo:        'Conta Fixa',
            descricao:   `${descricaoSegura} (antecipação)`,
            valor:       parseFloat(valorSeguro.toFixed(2)),
            data:        dh.data,
            hora:        dh.hora,
            contaFixaId: id
        });
        _ctx._invalidarCache('tx', 'cf', 'cc');

        // ── FATURA DE CARTÃO ─────────────────────────────────────────────
        if (conta.tipoContaFixa === 'fatura_cartao' && conta.compras && conta.compras.length > 0) {
            const cartaoRef = _ctx.cartoesCredito.find(c => c.id === conta.cartaoId);
            const dataPagto = agoraDataHora().data;

            // MODELO NOVO (2026-07-17): pagar a fatura do mês = marcar as parcelas
            // DESTE mês como pagas. NÃO avança o vencimento nem "rola" a fatura —
            // as parcelas dos outros meses moram nas faturas dos outros meses.
            // 🔴 Mesma correção do pagamento normal (RF-11, 2026-07-20): a saída da
            // fatura já foi lançada acima com o valor pago; lançar cada parcela
            // também cobrava DUAS vezes. A parcela só muda de status e devolve
            // limite ao cartão.
            let algoPago = false;
            conta.compras.forEach(compra => {
                if (compra.pago === true) return;
                const parcela = parseFloat(compra.valorParcela);
                if (!isFinite(parcela) || parcela <= 0 || parcela > 9_999_999) return;

                compra.pago   = true;
                compra.pagoEm = dataPagto;
                algoPago = true;

                if (cartaoRef) {
                    cartaoRef.usado = Math.max(0, (cartaoRef.usado || 0) - parcela);
                }
            });

            conta.valor         = valorAbertoFatura(conta);
            conta.pago          = true;
            conta.dataPagamento = new Date().toISOString().slice(0, 10);

            salvarDados();
            atualizarTudo();
            conta._processando = false;
            mostrarNotificacao(
                algoPago ? 'Fatura do mês paga! As parcelas dos próximos meses continuam nos seus meses.'
                         : 'Esta fatura já estava paga.',
                'success');
            return;
        }

        // ── CONTA RECORRENTE / PARCELAS ──────────────────────────────────
        conta.vencimento    = _avancarMes(conta.vencimento);
        conta.pago          = true;
        conta.dataPagamento = new Date().toISOString().slice(0, 10);

        salvarDados();
        atualizarTudo();
        conta._processando = false;
        mostrarNotificacao(`Antecipação registrada! Próximo vencimento: ${formatarDataBR(conta.vencimento)}`, 'success');

    } catch (erro) {
        console.error('❌ Erro na antecipação, revertendo:', erro);
        rollbackArray(_ctx.transacoes,  snapshotTransacoes);
        rollbackArray(_ctx.contasFixas, snapshotContasFixas);
        rollbackArray(_ctx.cartoesCredito, snapshotCartoes);
        conta._processando = false;
        mostrarNotificacao('Erro ao processar antecipação. Nenhuma alteração foi salva.', 'error');
    }
}



function pagarContaFixa(id, valorPago) {
    const conta = _ctx.contasFixas.find(c => c.id === id);
    if (!conta) return;

    // ✅ Lock anti-replay
    if (conta._processando) {
        mostrarNotificacao('Aguarde, pagamento em andamento...', 'info');
        return;
    }
    conta._processando = true;

    // ✅ Validação de valor: deve ser número positivo, finito e dentro do limite razoável
    const valorSeguro = parseFloat(valorPago);
    if (!isFinite(valorSeguro) || valorSeguro <= 0 || valorSeguro > 9_999_999) {
        mostrarNotificacao('Valor de pagamento inválido. Informe um valor entre R$ 0,01 e R$ 9.999.999,00.', 'error');
        conta._processando = false;
        return;
    }

    const contaOriginal = conta;

    // ✅ Snapshots declarados fora do try — arrays vazios como fallback seguro
    let snapshotTransacoes  = [];
    let snapshotContasFixas = [];
    let snapshotCartoes     = [];

    try {
        snapshotTransacoes  = structuredClone(_ctx.transacoes);
        snapshotContasFixas = structuredClone(_ctx.contasFixas);
        snapshotCartoes     = structuredClone(_ctx.cartoesCredito);

        const dh = agoraDataHora();
        const descricaoSegura = String(conta.descricao || '').slice(0, 100);

        _ctx.transacoes.push({
            id:          novoId(),
            categoria:   'saida',
            tipo:        'Conta Fixa',
            descricao:   `${descricaoSegura} (pagamento mensal)`,
            valor:       parseFloat(valorSeguro.toFixed(2)),
            data:        dh.data,
            hora:        dh.hora,
            contaFixaId: id
        });
        _ctx._invalidarCache('tx', 'cf', 'cc');

        // ── FATURA DE CARTÃO ──────────────────────────────────────────────
        // MODELO NOVO (2026-07-17): marca as parcelas DESTE mês como pagas, sem
        // avançar o vencimento — as dos outros meses moram nas outras faturas.
        if (conta.tipoContaFixa === 'fatura_cartao' && conta.compras && conta.compras.length > 0) {
            let cartaoRef = _ctx.cartoesCredito.find(c => c.id === conta.cartaoId);
            const dataPagto = agoraDataHora().data;

            // 🔴 NÃO gerar uma saída por item (bug RF-11, corrigido em 2026-07-20).
            // A saída da fatura JÁ foi lançada acima, com o valor realmente pago.
            // Lançar TAMBÉM cada parcela debitava o cartão DUAS vezes do saldo.
            // Aqui a parcela só muda de STATUS (paga) e devolve limite ao cartão —
            // o dinheiro sai uma vez só, no lançamento da fatura.
            // E somar as parcelas seria errado de qualquer forma: a fatura pode vir
            // com desconto/juros, então o valor pago diverge da soma dos itens.
            conta.compras.forEach(compra => {
                if (compra.pago === true) return;
                const parcela = parseFloat(compra.valorParcela);
                if (!isFinite(parcela) || parcela <= 0 || parcela > 9_999_999) return;

                compra.pago   = true;
                compra.pagoEm = dataPagto;

                if (cartaoRef) cartaoRef.usado = Math.max(0, (cartaoRef.usado || 0) - parcela);
            });

            conta.valor         = valorAbertoFatura(conta);
            conta.pago          = true;
            conta.dataPagamento = new Date().toISOString().slice(0, 10);

            salvarDados();
            atualizarTudo();
            conta._processando = false;
            mostrarNotificacao('Fatura do mês paga! As parcelas dos próximos meses continuam nos seus meses.', 'success');
            return;
        }

        // ── CONTA COM PARCELAS DE CARTÃO ──────────────────────────────────
        if (conta.cartaoId && conta.totalParcelas && conta.parcelaAtual) {
            let cartaoRef = _ctx.cartoesCredito.find(c => c.id === conta.cartaoId);
            if (cartaoRef) {
                cartaoRef.usado = (cartaoRef.usado || 0) - valorSeguro;
                if (cartaoRef.usado < 0) cartaoRef.usado = 0;
            }

            if (conta.parcelaAtual < conta.totalParcelas) {
                conta.parcelaAtual++;
                conta.vencimento    = _avancarMes(conta.vencimento);
                conta.pago          = true;
                conta.dataPagamento = new Date().toISOString().slice(0, 10);
            } else {
                _ctx.contasFixas = _ctx.contasFixas.filter(c => c.id !== conta.id);
            }

            salvarDados();
            atualizarTudo();
            conta._processando = false;
            mostrarNotificacao('Parcela paga! O lembrete foi atualizado.', 'success');
            return;
        }

        // ── CONTA RECORRENTE (sem parcelas) ──────────────────────────────
        // Avança para o próximo vencimento e guarda data do pagamento
        conta.vencimento    = _avancarMes(conta.vencimento);
        conta.pago          = true;
        conta.dataPagamento = new Date().toISOString().slice(0, 10);

        salvarDados();
        atualizarTudo();
        conta._processando = false;
        mostrarNotificacao('Pagamento realizado! A conta volta para "Pendente" no próximo vencimento.', 'success');

    } catch (erro) {
        console.error('❌ Erro no pagamento, revertendo estado:', erro);

        rollbackArray(_ctx.transacoes,     snapshotTransacoes);
        rollbackArray(_ctx.contasFixas,    snapshotContasFixas);
        rollbackArray(_ctx.cartoesCredito, snapshotCartoes);

        contaOriginal._processando = false;
        mostrarNotificacao('Erro ao processar pagamento. Nenhuma alteração foi salva.', 'error');
    }
}
