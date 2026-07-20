// db-calendario.js — Calendário financeiro (aba lazy, Passo 11)
// ----------------------------------------------------------------------------
// Desenha o mês e pinta os dias com o que acontece neles. Toda a lógica de
// "o que cai em cada dia" vive em modules/calendario.js (puro e testado);
// aqui é só DOM.
//
// Lazy de propósito: o dashboard.js está no teto do orçamento (39,3/40 KB), e
// esta tela só existe quando o usuário clica na aba.
//
// Render 100% via DOM API (createElement/textContent) — nada de innerHTML com
// dado do usuário. Descrição de transação é texto livre; concatenar em HTML
// aqui seria XSS com a própria conta.
// ----------------------------------------------------------------------------

import { eventosDoMes, resumoDoDia, totaisDoMes, diasNoMes, primeiroDiaSemana } from '../modules/calendario.js?v=1';
import { listarLembretes, criarLembrete, excluirLembrete } from '../modules/assistant/reminders.js';
// Estado REAL do push (existe subscription?), não a permissão do browser —
// permissão concedida sem subscription não entrega nada. Ver push-notifications.js.
import { getPushState } from '../modules/push-notifications.js';

let _ctx = null;
let _ano = null;
let _mes = null;      // 1–12
let _diaAberto = null;
let _lembretes = [];  // [{ id, base, texto, dataISO }] — vêm do Radar, não do blob

const MESES = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho',
               'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
const SEMANA = ['D','S','T','Q','Q','S','S'];

// Cor e rótulo por tipo — a mesma linguagem visual do resto do app. A cor vem
// de token (var --cal-c-*), não de hex fixo: assim escurece no tema claro e o
// texto colorido (rótulo/valor/KPI) passa contraste AA — hex vivo reprovava lá.
const ESTILO = Object.freeze({
    fatura:     { cor: 'var(--cal-c-fatura)',     rotulo: 'Fatura'     },
    conta:      { cor: 'var(--cal-c-conta)',      rotulo: 'Conta fixa' },
    assinatura: { cor: 'var(--cal-c-assinatura)', rotulo: 'Assinatura' },
    lembrete:   { cor: 'var(--cal-c-lembrete)',   rotulo: 'Lembrete'   },
    entrada:    { cor: 'var(--cal-c-entrada)',    rotulo: 'Entrada'    },
    saida:      { cor: 'var(--cal-c-saida)',      rotulo: 'Saída'      },
});

export function init(ctx) {
    _ctx = ctx;
    const hoje = new Date();
    if (_ano === null) { _ano = hoje.getFullYear(); _mes = hoje.getMonth() + 1; }
    // Mesmo padrão dos outros módulos lazy: reabrir a aba re-renderiza sem re-init.
    window._dbCalendario = { render };
    render();
    _sincronizarLembretes();   // busca do Radar e re-renderiza quando chegam
    // Mantém a grade fresca quando o usuário lança algo em outra aba.
    document.addEventListener('ge:save-done', () => { if (_ctx) render(); });
}

// Busca os lembretes do servidor (Radar) e re-renderiza. Silencioso: sem rede,
// o calendário segue mostrando o que vem do blob.
async function _sincronizarLembretes() {
    try { _lembretes = await listarLembretes(); }
    catch { _lembretes = _lembretes || []; }
    if (_ctx) render();
}

export function render() {
    const raiz = document.getElementById('calendarioConteudo');
    if (!raiz || !_ctx) return;
    raiz.replaceChildren();

    const mapa = eventosDoMes({
        contasFixas: _ctx.contasFixas,
        transacoes:  _ctx.transacoes,
        assinaturas: _ctx.assinaturas,
    }, _ano, _mes, _lembretes);

    raiz.appendChild(_cabecalho(mapa));
    raiz.appendChild(_grade(mapa));
    raiz.appendChild(_legenda());

    // Reabre o dia selecionado após um re-render. Reabre MESMO vazio (ex.: excluiu
    // o último lembrete do dia): senão o painel de detalhe ficava com o conteúdo
    // velho até o usuário clicar noutro dia. `scroll:false` para não puxar a tela
    // a cada re-render de fundo (ge:save-done).
    if (_diaAberto) _abrirDia(_diaAberto, mapa.get(_diaAberto) || [], false);
}

// ── Cabeçalho: navegação + totais do mês ────────────────────────────────────
function _cabecalho(mapa) {
    const wrap = document.createElement('div');
    wrap.className = 'cal-header';

    const nav = document.createElement('div');
    nav.className = 'cal-nav';

    const btnAnt = _btnNav('fa-chevron-left', 'Mês anterior', () => _mudarMes(-1));
    const titulo = document.createElement('div');
    titulo.className = 'cal-titulo';
    titulo.textContent = `${MESES[_mes - 1]} de ${_ano}`;
    const btnProx = _btnNav('fa-chevron-right', 'Próximo mês', () => _mudarMes(1));

    nav.append(btnAnt, titulo, btnProx);
    wrap.appendChild(nav);

    const t = totaisDoMes(mapa);
    const totais = document.createElement('div');
    totais.className = 'cal-totais';
    totais.append(
        _kpi('Entradas', t.entrou,  ESTILO.entrada.cor),
        _kpi('Saídas',   t.saiu,    ESTILO.saida.cor),
        _kpi('A vencer', t.aVencer, ESTILO.fatura.cor),
    );
    wrap.appendChild(totais);
    return wrap;
}

function _btnNav(icone, rotulo, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cal-nav-btn';
    b.setAttribute('aria-label', rotulo);
    const i = document.createElement('i');
    i.className = `fas ${icone}`;
    i.setAttribute('aria-hidden', 'true');
    b.appendChild(i);
    b.addEventListener('click', onClick);
    return b;
}

function _kpi(rotulo, valor, cor) {
    const d = document.createElement('div');
    d.className = 'cal-kpi';
    const l = document.createElement('span');
    l.className = 'cal-kpi-label';
    l.textContent = rotulo;
    const v = document.createElement('strong');
    v.className = 'cal-kpi-valor';
    v.style.color = cor;
    v.textContent = _ctx.formatBRL(valor);
    d.append(l, v);
    return d;
}

function _mudarMes(delta) {
    _mes += delta;
    if (_mes > 12) { _mes = 1;  _ano++; }
    if (_mes < 1)  { _mes = 12; _ano--; }
    _diaAberto = null;
    render();
}

// ── Grade do mês ────────────────────────────────────────────────────────────
function _grade(mapa) {
    const grade = document.createElement('div');
    grade.className = 'cal-grade';
    grade.setAttribute('role', 'grid');
    grade.setAttribute('aria-label', `Calendário de ${MESES[_mes - 1]} de ${_ano}`);

    // Cabeçalho dos dias da semana. aria-hidden porque "D S T Q Q S S" lido em
    // voz alta é ruído — cada célula já anuncia a data por extenso.
    for (const s of SEMANA) {
        const h = document.createElement('div');
        h.className = 'cal-semana';
        h.textContent = s;
        h.setAttribute('aria-hidden', 'true');
        grade.appendChild(h);
    }

    // Espaços até o dia 1 cair no dia da semana certo.
    const offset = primeiroDiaSemana(_ano, _mes);
    for (let i = 0; i < offset; i++) {
        const vazio = document.createElement('div');
        vazio.className = 'cal-dia cal-dia--vazio';
        vazio.setAttribute('aria-hidden', 'true');
        grade.appendChild(vazio);
    }

    const hojeISO = _isoHoje();
    const total = diasNoMes(_ano, _mes);
    for (let d = 1; d <= total; d++) {
        const iso = `${_ano}-${String(_mes).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        grade.appendChild(_celulaDia(d, iso, mapa.get(iso) || [], iso === hojeISO));
    }
    return grade;
}

function _celulaDia(dia, iso, eventos, ehHoje) {
    const r = resumoDoDia(eventos);
    const temEvento = r.total > 0;

    // TODO dia é um <button>: além de acionável por teclado (Passo 17 / WCAG),
    // clicar num dia VAZIO agora abre o detalhe para ADICIONAR um lembrete ali.
    const cel = document.createElement('button');
    cel.type = 'button';
    cel.className = 'cal-dia' + (ehHoje ? ' cal-dia--hoje' : '') + (temEvento ? ' cal-dia--tem' : '');

    if (temEvento) {
        const resumoTxt = [
            r.aVencer > 0 ? `${_ctx.formatBRL(r.aVencer)} a vencer` : '',
            r.entrou  > 0 ? `entrou ${_ctx.formatBRL(r.entrou)}`    : '',
            r.saiu    > 0 ? `saiu ${_ctx.formatBRL(r.saiu)}`        : '',
        ].filter(Boolean).join(', ');
        cel.setAttribute('aria-label', `Dia ${dia} de ${MESES[_mes - 1]}: ${resumoTxt || `${r.total} evento(s)`}. Abrir para ver ou adicionar lembrete.`);
    } else {
        cel.setAttribute('aria-label', `Dia ${dia} de ${MESES[_mes - 1]}, sem eventos. Abrir para adicionar lembrete.`);
    }
    cel.addEventListener('click', () => _abrirDia(iso, eventos));

    const num = document.createElement('span');
    num.className = 'cal-dia-num';
    num.textContent = String(dia);
    cel.appendChild(num);

    if (temEvento) {
        const pts = document.createElement('span');
        pts.className = 'cal-pontos';
        pts.setAttribute('aria-hidden', 'true');   // já está no aria-label
        // No máximo 3 pontinhos: mais que isso vira sujeira e some a informação.
        for (const tipo of r.tipos.slice(0, 3)) {
            const p = document.createElement('span');
            p.className = 'cal-ponto';
            p.style.background = (ESTILO[tipo] || ESTILO.saida).cor;
            pts.appendChild(p);
        }
        cel.appendChild(pts);
    }
    return cel;
}

// ── Detalhe do dia ──────────────────────────────────────────────────────────
function _abrirDia(iso, eventos, scroll = true) {
    _diaAberto = iso;
    const alvo = document.getElementById('calendarioDetalhe');
    if (!alvo) return;
    alvo.replaceChildren();

    const [, , d] = iso.split('-');
    const titulo = document.createElement('h3');
    titulo.className = 'cal-det-titulo';
    titulo.textContent = `${parseInt(d, 10)} de ${MESES[_mes - 1]}`;
    alvo.appendChild(titulo);

    if (!eventos.length) {
        const p = document.createElement('p');
        p.className = 'cal-det-vazio';
        p.textContent = 'Nada neste dia.';
        alvo.appendChild(p);
    }

    for (const ev of eventos) {
        const est = ESTILO[ev.tipo] || ESTILO.saida;
        const linha = document.createElement('div');
        linha.className = 'cal-det-item';
        linha.style.borderLeftColor = est.cor;

        const info = document.createElement('div');
        info.className = 'cal-det-info';
        const tp = document.createElement('span');
        tp.className = 'cal-det-tipo';
        tp.style.color = est.cor;
        tp.textContent = est.rotulo + (ev.pago === true ? ' · pago' : '');
        const nome = document.createElement('span');
        nome.className = 'cal-det-nome';
        nome.textContent = ev.titulo;          // textContent — dado do usuário
        info.append(tp, nome);
        linha.appendChild(info);

        // Lembrete: sem valor financeiro, mas COM botão de excluir. Os demais
        // eventos (contas/transações) mostram o valor, como antes.
        if (ev.tipo === 'lembrete') {
            const del = document.createElement('button');
            del.type = 'button';
            del.className = 'cal-det-del';
            del.setAttribute('aria-label', `Excluir lembrete: ${ev.titulo}`);
            del.textContent = '✕';
            del.addEventListener('click', (e) => {
                e.stopPropagation();
                _excluirLembrete(ev.base, iso);
            });
            linha.appendChild(del);
        } else {
            const val = document.createElement('strong');
            val.className = 'cal-det-valor';
            val.style.color = est.cor;
            val.textContent = _ctx.formatBRL(ev.valor);
            linha.appendChild(val);
        }

        alvo.appendChild(linha);
    }

    alvo.appendChild(_botaoAddLembrete(iso));
    // Só rola quando foi o usuário que abriu o dia — não a cada re-render de fundo.
    if (scroll) alvo.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ── Lembretes: criar/excluir a partir do dia ────────────────────────────────
function _botaoAddLembrete(iso) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cal-add-lembrete';
    const i = document.createElement('i');
    i.className = 'fas fa-bell';
    i.setAttribute('aria-hidden', 'true');
    btn.append(i, document.createTextNode(' Adicionar lembrete'));
    btn.addEventListener('click', () => _criarLembreteNoDia(iso));
    return btn;
}

function _criarLembreteNoDia(iso) {
    // Guarda contra dia no passado: o Radar só agenda futuro (e o push do dia já
    // teria passado). Deixa criar a partir de hoje.
    if (iso < _isoHoje()) {
        _ctx.mostrarNotificacao('Escolha um dia de hoje em diante para o lembrete.', 'warning');
        return;
    }
    // Popup com input — mesmo padrão do modo viagem (criarPopupDOM + textContent).
    _ctx.criarPopupDOM((popup) => {
        const titulo = document.createElement('h3');
        titulo.textContent = 'Novo lembrete';
        popup.appendChild(titulo);

        const intro = document.createElement('p');
        intro.className = 'vg-intro';
        intro.textContent = `Do que te lembrar em ${_fmtDiaBR(iso)}? Aviso 1 semana antes, 3 dias antes e no dia.`;
        popup.appendChild(intro);

        const label = document.createElement('label');
        label.className = 'vg-label';
        label.htmlFor = 'lembreteTexto';
        label.textContent = 'Lembrete';
        popup.appendChild(label);

        const input = document.createElement('input');
        input.id = 'lembreteTexto';
        input.className = 'form-input';
        input.type = 'text';
        input.maxLength = 120;
        input.placeholder = 'Ex.: pagar o aluguel, renovar o seguro';
        popup.appendChild(input);

        const btnCriar = document.createElement('button');
        btnCriar.className = 'btn-primary';
        btnCriar.type = 'button';
        btnCriar.style.cssText = 'width:100%; margin-top:10px;';
        btnCriar.textContent = 'Criar lembrete';
        const submeter = () => {
            const texto = input.value.trim();
            if (!texto) { input.focus(); return; }
            _ctx.fecharPopup();
            _persistirLembrete(texto, iso);
        };
        btnCriar.addEventListener('click', submeter);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submeter(); });
        popup.appendChild(btnCriar);

        const btnFechar = document.createElement('button');
        btnFechar.className = 'btn-cancelar';
        btnFechar.type = 'button';
        btnFechar.style.cssText = 'width:100%; margin-top:10px;';
        btnFechar.textContent = 'Cancelar';
        btnFechar.addEventListener('click', _ctx.fecharPopup);
        popup.appendChild(btnFechar);

        setTimeout(() => input.focus(), 50);
    });
}

async function _persistirLembrete(texto, iso) {
    const r = await criarLembrete(texto, iso);
    if (!r.ok) {
        const msg = r.reason === 'dup' ? 'Você já tem esse lembrete nesse dia.'
                  : r.reason === 'cap' ? 'Você atingiu o limite de lembretes. Exclua algum antes.'
                  : r.reason === 'auth' ? 'Faça login de novo para criar o lembrete.'
                  : 'Não deu para criar o lembrete agora. Tente de novo.';
        _ctx.mostrarNotificacao(msg, 'error');
        return;
    }
    await _sincronizarLembretes();
    _diaAberto = iso;
    if (_ctx) render();

    // Undo imediato + aviso sobre push. Mesma UX do assistente ("Cancelar").
    const pushOn = (await getPushState().catch(() => 'off')) === 'on';
    const extra = pushOn ? '' : ' Ative as notificações para receber os avisos.';
    _ctx.mostrarNotificacaoDesfazer(`Lembrete criado (avisos: 7d, 3d e no dia).${extra}`, async () => {
        await excluirLembrete(r.dedupeKey);
        await _sincronizarLembretes();
    });
}

async function _excluirLembrete(base, iso) {
    if (!base) return;
    const ok = await excluirLembrete(base);
    if (!ok) { _ctx.mostrarNotificacao('Não deu para excluir agora. Tente de novo.', 'error'); return; }
    // Remoção OTIMISTA: tira da lista local e re-renderiza JÁ, sem esperar o
    // refetch — senão o lembrete só sumia depois de trocar de dia e voltar.
    _lembretes = (_lembretes || []).filter(l => l.base !== base);
    _diaAberto = iso;
    if (_ctx) render();
    _ctx.mostrarNotificacao('Lembrete removido.', 'success');
    // Reconcilia com o servidor em segundo plano (sem await).
    _sincronizarLembretes();
}

function _fmtDiaBR(iso) {
    const [y, m, d] = iso.split('-');
    return `${d}/${m}/${y}`;
}

function _legenda() {
    const l = document.createElement('div');
    l.className = 'cal-legenda';
    for (const [tipo, est] of Object.entries(ESTILO)) {
        const item = document.createElement('span');
        item.className = 'cal-legenda-item';
        const p = document.createElement('span');
        p.className = 'cal-ponto';
        p.style.background = est.cor;
        p.setAttribute('aria-hidden', 'true');
        item.append(p, document.createTextNode(est.rotulo));
        l.appendChild(item);
    }
    return l;
}

function _isoHoje() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
