// landingtest.js — landing de teste com DEMO interativa (Passo 20)
// ---------------------------------------------------------------------------
// Vitrine, não produto: o visitante lança valores e vê o app reagindo, SEM criar
// conta e SEM nada sair do navegador. Recarregar zera. Zero risco por
// construção — não há rede, não há storage, não há Supabase aqui.
//
// Por isso o estado vive numa variável de módulo e mais nada: se um dia alguém
// quiser "só persistir pra melhorar a experiência", isso deixa de ser vitrine e
// vira produto (LGPD, consentimento, retenção). A ausência de persistência é
// deliberada.
// ---------------------------------------------------------------------------

import './script.js';   // mantém TODO o comportamento da landing original

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const MAX_ITENS = 30;

// Paleta das fatias — mesma linguagem do app.
const CORES = ['#0d9488', '#2563eb', '#b91c1c', '#a16207', '#7e22ce', '#0891b2'];

/** "1.234,56" e "1234.56" → número. Recusa o resto (não confia no input). */
function parseValor(txt) {
    const raw = String(txt ?? '').trim().replace(/\./g, '').replace(',', '.');
    if (!/^\d+(\.\d{1,2})?$/.test(raw)) return null;
    const n = Number(raw);
    return (Number.isFinite(n) && n > 0 && n <= 9_999_999) ? n : null;
}

let itens = [];

function el(id) { return document.getElementById(id); }

function render() {
    const entradas = itens.filter(i => i.tipo === 'entrada').reduce((s, i) => s + i.valor, 0);
    // Crédito conta como saída do mês (é gasto), igual ao app.
    const saidas   = itens.filter(i => i.tipo === 'saida' || i.tipo === 'credito').reduce((s, i) => s + i.valor, 0);
    const reservas = itens.filter(i => i.tipo === 'reserva').reduce((s, i) => s + i.valor, 0);
    // Reservar não é gasto: sai do saldo livre, mas continua sendo seu.
    const saldo    = entradas - saidas - reservas;

    el('demoEntradas').textContent = BRL.format(entradas);
    el('demoSaidas').textContent   = BRL.format(saidas);
    el('demoReservas').textContent = BRL.format(reservas);
    const elSaldo = el('demoSaldo');
    elSaldo.textContent = BRL.format(saldo);
    elSaldo.classList.toggle('trial-neg', saldo < 0);

    // ── Lista ───────────────────────────────────────────────────────────────
    const lista = el('demoLista');
    lista.replaceChildren();
    if (itens.length === 0) {
        const vazio = document.createElement('li');
        vazio.className = 'trial-vazio';
        vazio.textContent = 'Lance algo acima para ver a mágica acontecer.';
        lista.appendChild(vazio);
    } else {
        // Mais recente primeiro.
        for (const item of [...itens].reverse()) {
            const li = document.createElement('li');
            li.className = 'trial-item';

            const desc = document.createElement('span');
            desc.className = 'trial-item-desc';
            desc.textContent = item.desc;          // textContent: entrada do usuário

            const tag = document.createElement('span');
            tag.className = 'trial-item-tag trial-tag-' + item.tipo;
            tag.textContent = ({ saida: 'Saída', entrada: 'Entrada', credito: 'Crédito', reserva: 'Reserva' })[item.tipo] || item.tipo;
            desc.appendChild(tag);

            const negativo = item.tipo === 'saida' || item.tipo === 'credito';
            const val = document.createElement('strong');
            val.className = 'trial-item-val' + (negativo ? ' trial-neg' : item.tipo === 'reserva' ? ' trial-res' : ' trial-pos');
            val.textContent = (negativo ? '− ' : item.tipo === 'reserva' ? '⬡ ' : '+ ') + BRL.format(item.valor);

            const del = document.createElement('button');
            del.type = 'button';
            del.className = 'trial-item-del';
            del.setAttribute('aria-label', `Remover ${item.desc}`);
            del.textContent = '✕';
            del.addEventListener('click', () => {
                itens = itens.filter(x => x.id !== item.id);
                render();
            });

            li.append(desc, val, del);
            lista.appendChild(li);
        }
    }

    // ── "Para onde foi o dinheiro": barras proporcionais das saídas ─────────
    const graf = el('demoGrafico');
    graf.replaceChildren();
    const porDesc = new Map();
    for (const i of itens) {
        if (i.tipo !== 'saida' && i.tipo !== 'credito') continue;
        const k = i.desc.toLowerCase();
        porDesc.set(k, (porDesc.get(k) || 0) + i.valor);
    }
    const ordenado = [...porDesc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

    if (ordenado.length === 0) {
        const p = document.createElement('p');
        p.className = 'trial-vazio';
        p.textContent = 'Suas saídas aparecem aqui, das maiores para as menores.';
        graf.appendChild(p);
        // Sem `return` aqui: a rosca e o insight ainda precisam ser atualizados
        // (quem só lançou entrada/reserva também merece ver o resumo).
        desenharRosca([], 0);
        mostrarInsight({ entradas, saidas, reservas, ordenado });
        return;
    }

    const maior = ordenado[0][1];
    ordenado.forEach(([nome, val], idx) => {
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
        barra.style.background = CORES[idx % CORES.length];
        trilho.appendChild(barra);

        const v = document.createElement('span');
        v.className = 'trial-bar-val';
        v.textContent = BRL.format(val);

        linha.append(rot, trilho, v);
        graf.appendChild(linha);
    });

    desenharRosca(ordenado, [...porDesc.values()].reduce((a, b) => a + b, 0));
    mostrarInsight({ entradas, saidas, reservas, ordenado });
}

/**
 * Rosca em SVG puro (sem lib): cada fatia é um arco desenhado com
 * stroke-dasharray sobre um círculo de perímetro 100 — assim o valor em % vira
 * literalmente o comprimento do traço, sem trigonometria.
 */
function desenharRosca(ordenado, total) {
    const svg = el('demoRosca');
    const centro = el('demoRoscaTotal');
    if (!svg) return;
    svg.replaceChildren();
    centro.textContent = BRL.format(total || 0);
    if (!total) return;

    let offset = 25;   // começa no topo
    ordenado.forEach(([, val], i) => {
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

/**
 * Insight simples e HONESTO: só afirma o que os números do próprio visitante
 * mostram. Nada de IA aqui — é a mesma lógica de leitura que o app faz.
 */
function mostrarInsight({ entradas, saidas, reservas, ordenado }) {
    const box = el('demoInsight');
    const txt = el('demoInsightTxt');
    if (!box) return;

    if (itens.length < 2) { box.hidden = true; return; }

    let msg = '';
    if (entradas > 0 && saidas > entradas) {
        msg = `Suas saídas (${BRL.format(saidas)}) já passaram as entradas (${BRL.format(entradas)}). No app, você é avisado ANTES de chegar aqui.`;
    } else if (entradas > 0 && ordenado.length > 0) {
        const [nome, val] = ordenado[0];
        const pct = Math.round((val / saidas) * 100);
        msg = `“${nome}” sozinho é ${pct}% do que você gastou. É esse tipo de padrão que o GranaEvo mostra sem você procurar.`;
    } else if (entradas > 0 && reservas > 0) {
        const taxa = Math.round((reservas / entradas) * 100);
        msg = `Você guardou ${taxa}% do que entrou. A regra dos 50/30/20 sugere 20% — ${taxa >= 20 ? 'você está no caminho 👏' : 'dá para chegar lá'}.`;
    } else if (saidas > 0) {
        msg = `Lance também uma entrada para ver o saldo, a taxa de economia e o alerta de gasto alto.`;
    }

    if (!msg) { box.hidden = true; return; }
    txt.textContent = msg;
    box.hidden = false;
}

function init() {
    const form = el('demoForm');
    if (!form) return;   // não é a landingtest

    form.addEventListener('submit', (e) => {
        e.preventDefault();
        const erro = el('demoErro');
        erro.textContent = '';

        const desc  = el('demoDesc').value.trim().slice(0, 40);
        const valor = parseValor(el('demoValor').value);

        if (!desc)  { erro.textContent = 'Escreva uma descrição.'; el('demoDesc').focus(); return; }
        if (valor === null) { erro.textContent = 'Valor inválido. Use algo como 49,90.'; el('demoValor').focus(); return; }
        if (itens.length >= MAX_ITENS) { erro.textContent = 'Esta é uma demonstração — 30 lançamentos já dão o recado 🙂'; return; }

        itens.push({ id: Date.now() + Math.random(), tipo: el('demoTipo').value, desc, valor });
        el('demoDesc').value = '';
        el('demoValor').value = '';
        el('demoDesc').focus();
        render();
    });

    el('demoLimpar').addEventListener('click', () => { itens = []; render(); });

    render();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
