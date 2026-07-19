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

let _ctx = null;
let _ano = null;
let _mes = null;      // 1–12
let _diaAberto = null;

const MESES = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho',
               'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
const SEMANA = ['D','S','T','Q','Q','S','S'];

// Cor e rótulo por tipo — a mesma linguagem visual do resto do app.
const ESTILO = Object.freeze({
    fatura:     { cor: '#ff4b4b', rotulo: 'Fatura'     },
    conta:      { cor: '#ff8c32', rotulo: 'Conta fixa' },
    assinatura: { cor: '#c084fc', rotulo: 'Assinatura' },
    entrada:    { cor: '#00ff99', rotulo: 'Entrada'    },
    saida:      { cor: '#4ca6ff', rotulo: 'Saída'      },
});

export function init(ctx) {
    _ctx = ctx;
    const hoje = new Date();
    if (_ano === null) { _ano = hoje.getFullYear(); _mes = hoje.getMonth() + 1; }
    // Mesmo padrão dos outros módulos lazy: reabrir a aba re-renderiza sem re-init.
    window._dbCalendario = { render };
    render();
    // Mantém a grade fresca quando o usuário lança algo em outra aba.
    document.addEventListener('ge:save-done', () => { if (_ctx) render(); });
}

export function render() {
    const raiz = document.getElementById('calendarioConteudo');
    if (!raiz || !_ctx) return;
    raiz.replaceChildren();

    const mapa = eventosDoMes({
        contasFixas: _ctx.contasFixas,
        transacoes:  _ctx.transacoes,
        assinaturas: _ctx.assinaturas,
    }, _ano, _mes);

    raiz.appendChild(_cabecalho(mapa));
    raiz.appendChild(_grade(mapa));
    raiz.appendChild(_legenda());

    // Reabre o dia selecionado após um re-render (ex.: veio um save).
    if (_diaAberto && mapa.has(_diaAberto)) _abrirDia(_diaAberto, mapa.get(_diaAberto));
    else _diaAberto = null;
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

    // <button> e não <div>: dia com evento é acionável, e precisa ser alcançável
    // por teclado e anunciado como controle (Passo 17 / WCAG).
    const cel = document.createElement(temEvento ? 'button' : 'div');
    cel.className = 'cal-dia' + (ehHoje ? ' cal-dia--hoje' : '') + (temEvento ? ' cal-dia--tem' : '');

    if (temEvento) {
        cel.type = 'button';
        const resumoTxt = [
            r.aVencer > 0 ? `${_ctx.formatBRL(r.aVencer)} a vencer` : '',
            r.entrou  > 0 ? `entrou ${_ctx.formatBRL(r.entrou)}`    : '',
            r.saiu    > 0 ? `saiu ${_ctx.formatBRL(r.saiu)}`        : '',
        ].filter(Boolean).join(', ');
        cel.setAttribute('aria-label', `Dia ${dia} de ${MESES[_mes - 1]}: ${resumoTxt || `${r.total} evento(s)`}`);
        cel.addEventListener('click', () => _abrirDia(iso, eventos));
    } else {
        cel.setAttribute('aria-label', `Dia ${dia} de ${MESES[_mes - 1]}, sem eventos`);
    }

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
function _abrirDia(iso, eventos) {
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
        return;
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

        const val = document.createElement('strong');
        val.className = 'cal-det-valor';
        val.style.color = est.cor;
        val.textContent = _ctx.formatBRL(ev.valor);

        linha.append(info, val);
        alvo.appendChild(linha);
    }
    alvo.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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
