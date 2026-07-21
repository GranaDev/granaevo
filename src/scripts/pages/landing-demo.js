// landing-demo.js — demo interativa da landing (Passo 20, aprovado em 2026-07-21)
// ---------------------------------------------------------------------------
// Nasceu como /landingtest e foi PROMOVIDA para a landing oficial depois do
// teste do usuário. A página de teste foi removida.
//
// Vitrine, não produto: o visitante lança valores (pelo formulário OU conversando
// com o assistente) e vê o app reagindo, SEM criar conta e SEM nada sair do
// navegador. Recarregar zera. Zero risco por construção — não há rede, não há
// storage, não há Supabase aqui.
//
// O estado vive numa variável de módulo e mais nada. A AUSÊNCIA de persistência é
// deliberada: no dia em que alguém quiser "só salvar pra melhorar a experiência",
// isto deixa de ser vitrine e vira produto (consentimento, retenção, titular).
//
// O "assistente" daqui é um parser local de frases, NÃO é IA. Isso é proposital e
// honesto: a demo não promete o que ela mesma não entrega. O assistente de
// verdade do app usa IA só como parser também — a promessa é a mesma.
// ---------------------------------------------------------------------------

import './script.js';   // mantém TODO o comportamento da landing original

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const MAX_ITENS = 40;
const CORES = ['#0d9488', '#2563eb', '#b91c1c', '#a16207', '#7e22ce', '#0891b2'];

const ROTULO = { saida: 'Saída', entrada: 'Entrada', credito: 'Crédito', reserva: 'Reserva' };

let itens = [];
const el = (id) => document.getElementById(id);

// ── Máscara de moeda: digita 1234 → mostra 12,34 ────────────────────────────
// Os centavos entram da direita para a esquerda, como em maquininha e app de
// banco. Assim o usuário nunca precisa procurar a vírgula.
function mascaraMoeda(txt) {
    const digitos = String(txt || '').replace(/\D/g, '').slice(0, 11);
    if (!digitos) return '';
    const n = Number(digitos) / 100;
    return n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function valorDaMascara(txt) {
    const digitos = String(txt || '').replace(/\D/g, '');
    if (!digitos) return null;
    const n = Number(digitos) / 100;
    return (Number.isFinite(n) && n > 0 && n <= 9_999_999) ? n : null;
}

function addItem(tipo, desc, valor) {
    if (itens.length >= MAX_ITENS) return false;
    itens.push({ id: Date.now() + Math.random(), tipo, desc: desc.slice(0, 40), valor });
    return true;
}

// ── Totais ──────────────────────────────────────────────────────────────────
function totais() {
    const entradas = itens.filter(i => i.tipo === 'entrada').reduce((s, i) => s + i.valor, 0);
    const saidas   = itens.filter(i => i.tipo === 'saida' || i.tipo === 'credito').reduce((s, i) => s + i.valor, 0);
    const credito  = itens.filter(i => i.tipo === 'credito').reduce((s, i) => s + i.valor, 0);
    const reservas = itens.filter(i => i.tipo === 'reserva').reduce((s, i) => s + i.valor, 0);
    return { entradas, saidas, credito, reservas, saldo: entradas - saidas - reservas };
}

function porCategoria() {
    const m = new Map();
    for (const i of itens) {
        if (i.tipo !== 'saida' && i.tipo !== 'credito') continue;
        const k = i.desc.toLowerCase();
        m.set(k, (m.get(k) || 0) + i.valor);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

// ── Render ──────────────────────────────────────────────────────────────────
function render() {
    const t = totais();
    const cats = porCategoria();

    el('demoEntradas').textContent = BRL.format(t.entradas);
    el('demoSaidas').textContent   = BRL.format(t.saidas);
    el('demoReservas').textContent = BRL.format(t.reservas);
    const elSaldo = el('demoSaldo');
    elSaldo.textContent = BRL.format(t.saldo);
    elSaldo.classList.toggle('trial-neg', t.saldo < 0);
    elSaldo.classList.toggle('trial-pos', t.saldo > 0);

    // Sublinhas dos KPIs — é aqui que a demo deixa de parecer calculadora.
    const n = (arr) => arr.length;
    el('demoSubEntradas').textContent = t.entradas ? `${n(itens.filter(i => i.tipo === 'entrada'))} lançamento(s)` : '—';
    el('demoSubSaidas').textContent   = t.credito ? `${BRL.format(t.credito)} no crédito` : (t.saidas ? `${n(itens.filter(i => i.tipo === 'saida'))} lançamento(s)` : '—');
    el('demoSubReservas').textContent = (t.entradas > 0 && t.reservas > 0)
        ? `${Math.round((t.reservas / t.entradas) * 100)}% do que entrou` : '—';
    el('demoSubSaldo').textContent    = t.entradas > 0
        ? `${Math.round((t.saldo / t.entradas) * 100)}% da renda sobrou` : '—';

    // Barra de saúde do mês: quanto da renda já foi comprometido.
    const wrap = el('demoSaudeWrap');
    if (t.entradas > 0) {
        const usado = Math.min(100, Math.round(((t.saidas + t.reservas) / t.entradas) * 100));
        wrap.hidden = false;
        el('demoSaudePct').textContent = usado + '% comprometido';
        const fill = el('demoSaudeFill');
        fill.style.width = usado + '%';
        fill.style.background = usado >= 100 ? '#ef4444' : usado >= 80 ? '#f59e0b' : '#10b981';
        el('demoSaudeLbl').textContent = usado >= 100 ? 'Você passou do que ganhou'
            : usado >= 80 ? 'Atenção: pouco fôlego no mês' : 'Saúde do mês';
    } else wrap.hidden = true;

    renderLista();
    renderGrafico(cats);
    renderInsights(t, cats);
}

function renderLista() {
    const lista = el('demoLista');
    lista.replaceChildren();
    if (itens.length === 0) {
        const vazio = document.createElement('li');
        vazio.className = 'trial-vazio';
        vazio.textContent = 'Lance algo ao lado — ou peça ao assistente.';
        lista.appendChild(vazio);
        return;
    }
    for (const item of [...itens].reverse()) {
        const li = document.createElement('li');
        li.className = 'trial-item';

        const info = document.createElement('span');
        info.className = 'trial-item-info';
        const desc = document.createElement('span');
        desc.className = 'trial-item-desc';
        desc.textContent = item.desc;              // textContent — entrada do usuário
        const tag = document.createElement('span');
        tag.className = 'trial-item-tag trial-tag-' + item.tipo;
        tag.textContent = ROTULO[item.tipo] || item.tipo;
        info.append(desc, tag);

        const neg = item.tipo === 'saida' || item.tipo === 'credito';
        const val = document.createElement('strong');
        val.className = 'trial-item-val ' + (neg ? 'trial-neg' : item.tipo === 'reserva' ? 'trial-res' : 'trial-pos');
        val.textContent = (neg ? '− ' : item.tipo === 'reserva' ? '⬡ ' : '+ ') + BRL.format(item.valor);

        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'trial-item-del';
        del.setAttribute('aria-label', `Remover ${item.desc}`);
        del.textContent = '✕';
        del.addEventListener('click', () => { itens = itens.filter(x => x.id !== item.id); render(); });

        li.append(info, val, del);
        lista.appendChild(li);
    }
}

function renderGrafico(cats) {
    const graf = el('demoGrafico');
    graf.replaceChildren();
    const top = cats.slice(0, 5);
    const total = cats.reduce((s, [, v]) => s + v, 0);

    desenharRosca(top, total);

    if (top.length === 0) {
        const p = document.createElement('p');
        p.className = 'trial-vazio';
        p.textContent = 'Suas saídas aparecem aqui, das maiores para as menores.';
        graf.appendChild(p);
        return;
    }
    const maior = top[0][1];
    top.forEach(([nome, val], i) => {
        const linha = document.createElement('div');
        linha.className = 'trial-bar-row';
        const rot = document.createElement('span');
        rot.className = 'trial-bar-lbl';
        rot.textContent = nome;
        const trilho = document.createElement('span');
        trilho.className = 'trial-bar-track';
        const barra = document.createElement('span');
        barra.className = 'trial-bar-fill';
        barra.style.width = Math.max(6, (val / maior) * 100) + '%';
        barra.style.background = CORES[i % CORES.length];
        trilho.appendChild(barra);
        const v = document.createElement('span');
        v.className = 'trial-bar-val';
        v.textContent = `${BRL.format(val)} · ${Math.round((val / total) * 100)}%`;
        linha.append(rot, trilho, v);
        graf.appendChild(linha);
    });
}

/** Rosca em SVG puro: a % vira o comprimento do traço (sem trigonometria, sem lib). */
function desenharRosca(top, total) {
    const svg = el('demoRosca');
    el('demoRoscaTotal').textContent = BRL.format(total || 0);
    svg.replaceChildren();
    if (!total) return;
    let offset = 25;
    top.forEach(([, val], i) => {
        const pct = (val / total) * 100;
        const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        c.setAttribute('cx', '21'); c.setAttribute('cy', '21'); c.setAttribute('r', '15.9');
        c.setAttribute('fill', 'transparent');
        c.setAttribute('stroke', CORES[i % CORES.length]);
        c.setAttribute('stroke-width', '5');
        c.setAttribute('stroke-dasharray', `${pct} ${100 - pct}`);
        c.setAttribute('stroke-dashoffset', String(offset));
        svg.appendChild(c);
        offset -= pct;
    });
}

// ── Insights: o que faz o visitante querer a ferramenta ─────────────────────
// Cada um só aparece quando os números do PRÓPRIO visitante o justificam.
function renderInsights(t, cats) {
    const box = el('demoInsights');
    box.replaceChildren();
    if (itens.length < 2) return;

    const out = [];
    const total = cats.reduce((s, [, v]) => s + v, 0);

    if (t.entradas > 0 && t.saidas > t.entradas) {
        out.push(['fa-triangle-exclamation', 'Você gastou mais do que ganhou',
            `Saíram ${BRL.format(t.saidas)} contra ${BRL.format(t.entradas)} de entrada. No app, o alerta chega ANTES de virar dívida.`]);
    }
    if (cats.length > 0 && total > 0) {
        const [nome, val] = cats[0];
        const pct = Math.round((val / total) * 100);
        if (pct >= 35) out.push(['fa-bullseye', `"${nome}" domina seus gastos`,
            `Sozinho, é ${pct}% de tudo que saiu. Esse é o tipo de padrão que passa despercebido no extrato do banco.`]);
    }
    if (t.entradas > 0) {
        const taxa = Math.round((t.reservas / t.entradas) * 100);
        if (t.reservas > 0) out.push(['fa-piggy-bank', `Você guardou ${taxa}% do que entrou`,
            taxa >= 20 ? 'Acima da regra dos 50/30/20 — é assim que uma reserva de emergência nasce.'
                       : 'A regra dos 50/30/20 sugere 20%. O app te mostra quanto falta, mês a mês.']);
        else out.push(['fa-lightbulb', 'Você ainda não reservou nada',
            'Quem separa antes de gastar chega ao fim do mês com sobra. O app calcula quanto dá para guardar sem apertar.']);
    }
    if (t.credito > 0) {
        out.push(['fa-credit-card', `${BRL.format(t.credito)} no crédito`,
            'No app, cada parcela cai no mês certo da fatura — você vê o compromisso futuro antes de assumir mais um.']);
    }
    if (itens.length >= 4 && out.length < 2) {
        out.push(['fa-chart-line', 'Seu padrão já está aparecendo',
            'Com poucos lançamentos o app já monta gráficos, previsão de fim de mês e alertas de vencimento.']);
    }

    for (const [ico, titulo, texto] of out.slice(0, 3)) {
        const d = document.createElement('div');
        d.className = 'trial-insight';
        // Ícone Font Awesome (não emoji): mesma linguagem visual do app.
        const i = document.createElement('i');
        i.className = 'fas ' + ico + ' trial-insight-ico';
        i.setAttribute('aria-hidden', 'true');
        const corpo = document.createElement('div');
        const h = document.createElement('strong');
        h.className = 'trial-insight-tit';
        h.textContent = titulo;
        const p = document.createElement('p');
        p.className = 'trial-insight-txt';
        p.textContent = texto;
        corpo.append(h, p);
        d.append(i, corpo);
        box.appendChild(d);
    }
}

// ── Assistente (parser local de frases — NÃO é IA) ──────────────────────────
const SUGESTOES = [
    { txt: 'Gastei 89,90 no mercado',      acao: () => ({ tipo: 'saida',   desc: 'mercado',  valor: 89.9 }) },
    { txt: 'Recebi 3200 de salário',       acao: () => ({ tipo: 'entrada', desc: 'salário',  valor: 3200 }) },
    { txt: 'Paguei 149 no crédito',        acao: () => ({ tipo: 'credito', desc: 'compra',   valor: 149 }) },
    { txt: 'Guardei 400 na reserva',       acao: () => ({ tipo: 'reserva', desc: 'reserva',  valor: 400 }) },
    { txt: 'Quanto eu gastei?',            pergunta: 'gastos' },
    { txt: 'Onde estou gastando mais?',    pergunta: 'top' },
    { txt: 'Posso gastar mais este mês?',  pergunta: 'folga' },
];

function chatMsg(quem, texto) {
    const chat = el('demoChat');
    const b = document.createElement('div');
    b.className = 'trial-msg trial-msg--' + quem;
    b.textContent = texto;                  // textContent sempre
    chat.appendChild(b);
    chat.scrollTop = chat.scrollHeight;
}

function responder(s) {
    const t = totais();
    const cats = porCategoria();
    if (s.pergunta === 'gastos') {
        return t.saidas > 0
            ? `Você já gastou ${BRL.format(t.saidas)}${t.credito ? `, sendo ${BRL.format(t.credito)} no crédito` : ''}.`
            : 'Você ainda não lançou nenhuma saída. Experimente uma das sugestões acima.';
    }
    if (s.pergunta === 'top') {
        if (cats.length === 0) return 'Sem saídas ainda — assim que houver, eu te digo onde o dinheiro está indo.';
        const [nome, val] = cats[0];
        const total = cats.reduce((a, [, v]) => a + v, 0);
        return `Seu maior gasto é "${nome}": ${BRL.format(val)}, ${Math.round((val / total) * 100)}% do total.`;
    }
    if (s.pergunta === 'folga') {
        if (t.entradas === 0) return 'Me diga quanto você recebeu que eu calculo sua folga do mês.';
        return t.saldo > 0
            ? `Sobram ${BRL.format(t.saldo)} livres. Dá para gastar, mas guardar uma parte agora evita aperto depois.`
            : `Não há folga: você já comprometeu ${BRL.format(t.saidas + t.reservas)} de ${BRL.format(t.entradas)}. Segurar os gastos aqui faz diferença.`;
    }
    return null;
}

function montarChips() {
    const box = el('demoChips');
    box.replaceChildren();
    for (const s of SUGESTOES) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'trial-chip' + (s.pergunta ? ' trial-chip--pergunta' : '');
        b.textContent = s.txt;
        b.addEventListener('click', () => {
            chatMsg('user', s.txt);
            setTimeout(() => {
                if (s.acao) {
                    const { tipo, desc, valor } = s.acao();
                    if (!addItem(tipo, desc, valor)) { chatMsg('bot', 'A demonstração já tem lançamentos demais.'); return; }
                    chatMsg('bot', `Lancei ${ROTULO[tipo].toLowerCase()} de ${BRL.format(valor)} em "${desc}". Veja os números mudarem no painel ao lado.`);
                    render();
                } else {
                    chatMsg('bot', responder(s) || 'Não entendi essa.');
                }
            }, 380);
        });
        box.appendChild(b);
    }
}

// ── Init ────────────────────────────────────────────────────────────────────
function init() {
    const form = el('demoForm');
    if (!form) return;   // página sem a demo

    // Máscara de moeda ao digitar.
    const inputValor = el('demoValor');
    inputValor.addEventListener('input', () => {
        const pos = inputValor.value.length;
        inputValor.value = mascaraMoeda(inputValor.value);
        if (pos) inputValor.setSelectionRange(inputValor.value.length, inputValor.value.length);
    });

    form.addEventListener('submit', (e) => {
        e.preventDefault();
        const erro = el('demoErro');
        erro.textContent = '';
        const desc  = el('demoDesc').value.trim().slice(0, 40);
        const valor = valorDaMascara(inputValor.value);
        if (!desc)          { erro.textContent = 'Escreva uma descrição.'; el('demoDesc').focus(); return; }
        if (valor === null) { erro.textContent = 'Informe um valor.'; inputValor.focus(); return; }
        if (!addItem(el('demoTipo').value, desc, valor)) { erro.textContent = 'Esta é uma demonstração — 40 lançamentos já dão o recado.'; return; }
        el('demoDesc').value = '';
        inputValor.value = '';
        el('demoDesc').focus();
        render();
    });

    el('demoLimpar').addEventListener('click', () => {
        itens = [];
        el('demoChat').replaceChildren();
        chatMsg('bot', 'Pronto, limpei tudo. Quer tentar de novo?');
        render();
    });

    montarChips();
    chatMsg('bot', 'Olá! Sou o assistente do GranaEvo. Toque numa das frases abaixo e eu registro para você.');
    render();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
