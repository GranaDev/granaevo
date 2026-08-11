// ctx-contrato-modulos-lazy.test.js — Passo 10: o contrato entre o dashboard e
// os módulos que ele carrega sob demanda.
//
// POR QUE ESTE ARQUIVO EXISTE
// O `dashboard.js` entrega aos módulos lazy um objeto `_ctx` montado por
// `_makeCtx()`: arrays vivos (via getter/setter) e utilitários (via proxy).
// Cada módulo consome isso como `_ctx.algumaCoisa(...)`.
//
// Esse acoplamento é INVISÍVEL para todas as outras redes de proteção:
//   · o build passa — `_ctx.foo` é acesso a propriedade, não identificador solto,
//     então nem o Rollup nem o `check-refs` têm o que reclamar;
//   · a suíte passa — não há teste que clique em "Pagar Conta";
//   · só quebra na mão do usuário, com `_ctx.foo is not a function`, depois do
//     clique que baixa o chunk.
//
// Foi exatamente essa a classe de risco da extração de Contas Fixas
// (2026-08-10): 588 linhas saíram do dashboard e passaram a depender de 11
// coisas atravessando essa fronteira. Este teste faz a fronteira ser conferida.
//
// ⚠️ O teste lê o FONTE, então precisa peneirar COMENTÁRIO antes de casar:
// o cabeçalho de `db-contas-fixas.js` cita `_ctx.contasFixas` em prosa, e sem a
// peneira isso viraria uma exigência fantasma (ou pior, um falso verde noutro
// caso). Já aconteceu 4 vezes neste projeto.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PAGES = join(RAIZ, 'src', 'scripts', 'pages');

/**
 * Peneira SÓ comentário — bloco e linha inteira. Deliberadamente NÃO mexe em
 * string nem em template.
 *
 * A primeira versão deste teste também tentava neutralizar strings, e o
 * resultado foi pior que o problema: `sanitizeHTML` faz
 * `.replace(/'/g, '&#x27;')`, o casador de aspas se perdia ali e passava a
 * comer código de verdade — o arquivo inteiro virava uma linha só e as
 * asserções reprovavam por um motivo que não tinha nada a ver com o código.
 *
 * Comentário basta para o que este teste pergunta: as âncoras são
 * `^function nome(` na coluna 0, que não aparece dentro de string neste
 * projeto, e o que se quer evitar é casar com o nome citado em PROSA (o
 * cabeçalho de db-contas-fixas.js cita `_ctx.contasFixas` explicando a regra).
 */
function semRuido(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/^[ \t]*\/\/.*$/gm, '');
}

const dashboard = semRuido(readFileSync(join(PAGES, 'dashboard.js'), 'utf8'));

/** As chaves que `_makeCtx()` realmente define. */
function chavesDoCtx() {
    const i = dashboard.indexOf('function _makeCtx()');
    assert.ok(i > 0, 'dashboard.js perdeu _makeCtx() — o contrato inteiro depende dele.');
    // Vai até o próximo `}` na coluna 0 (fim da função de topo).
    const fim = dashboard.indexOf('\n}', i);
    assert.ok(fim > i, 'não achei o fim de _makeCtx().');
    const corpo = dashboard.slice(i, fim);

    const chaves = new Set();
    for (const m of corpo.matchAll(/^\s{4,}([A-Za-z_$][\w$]*)\s*:\s*\{/gm)) chaves.add(m[1]);
    return chaves;
}

/** Tudo que um módulo pede via `_ctx.x`. */
function usosDeCtx(src) {
    const usos = new Set();
    for (const m of semRuido(src).matchAll(/\b_ctx\.([A-Za-z_$][\w$]*)/g)) usos.add(m[1]);
    // Também `const { a, b } = _ctx`
    for (const m of semRuido(src).matchAll(/\{([^}]+)\}\s*=\s*_ctx\b/g)) {
        for (const n of m[1].split(',')) {
            const nome = n.trim().split(/[:=]/)[0].trim();
            if (nome) usos.add(nome);
        }
    }
    return usos;
}

const modulos = readdirSync(PAGES)
    .filter(f => f.endsWith('.js') && f !== 'dashboard.js')
    .filter(f => /\b_ctx\b/.test(readFileSync(join(PAGES, f), 'utf8')));

describe('contrato _ctx — todo módulo lazy só pede o que _makeCtx entrega', () => {
    test('_makeCtx() existe e expõe um conjunto não-trivial de chaves', () => {
        const chaves = chavesDoCtx();
        assert.ok(chaves.size > 40, `_makeCtx expõe só ${chaves.size} chaves — leitura provavelmente quebrou.`);
        // Âncoras: se estas sumirem, o dashboard mudou de forma e o teste precisa saber.
        for (const obrigatoria of ['transacoes', 'contasFixas', 'cartoesCredito', 'salvarDados']) {
            assert.ok(chaves.has(obrigatoria), `_makeCtx deixou de expor "${obrigatoria}".`);
        }
    });

    test('há módulos lazy de fato consumindo _ctx (o teste não está varrendo o vazio)', () => {
        assert.ok(modulos.length >= 5, `só ${modulos.length} módulos usam _ctx — a varredura não achou o que devia.`);
    });

    for (const arquivo of modulos) {
        test(`${arquivo} — nenhum _ctx.x fantasma`, () => {
            const chaves = chavesDoCtx();
            const pedidos = usosDeCtx(readFileSync(join(PAGES, arquivo), 'utf8'));
            const fantasmas = [...pedidos].filter(n => !chaves.has(n));
            assert.deepEqual(
                fantasmas, [],
                `${arquivo} usa _ctx.${fantasmas.join(', _ctx.')} — ` +
                `não existe em _makeCtx(). Quebra no clique do usuário, não no build.`
            );
        });
    }
});

describe('Contas Fixas — o que ficou de cada lado da fronteira (Passo 10)', () => {
    const dash = readFileSync(join(PAGES, 'dashboard.js'), 'utf8');
    const mod  = readFileSync(join(PAGES, 'db-contas-fixas.js'), 'utf8');

    test('as 4 portas de entrada são exportadas pelo módulo', () => {
        for (const fn of ['abrirContaFixaView', 'abrirContaFixaForm',
                          'abrirPopupPagarContaFixa', 'abrirPopupAnteciparContaFixa']) {
            assert.match(mod, new RegExp(`^export function ${fn}\\(`, 'm'),
                `db-contas-fixas.js não exporta ${fn} — o shim do dashboard chamaria undefined.`);
        }
    });

    test('o dinheiro mora do lado lazy, não no dashboard', () => {
        for (const fn of ['pagarContaFixa', 'anteciparContaFixa']) {
            assert.match(mod, new RegExp(`^function ${fn}\\(`, 'm'), `${fn} sumiu do módulo.`);
            assert.doesNotMatch(semRuido(dash), new RegExp(`^function ${fn}\\(`, 'm'),
                `${fn} voltou para o dashboard.js — a extração foi desfeita.`);
        }
    });

    test('atualizarListaContasFixas FICOU no dashboard (pinta a tela inicial, é quente)', () => {
        assert.match(semRuido(dash), /^function atualizarListaContasFixas\(/m,
            'atualizarListaContasFixas saiu do dashboard — a seção da home passaria a depender de um chunk.');
    });

    test('rollbackArray e _avancarMes FICARAM (código quente e outros módulos dependem)', () => {
        for (const fn of ['rollbackArray', '_avancarMes']) {
            assert.match(semRuido(dash), new RegExp(`^function ${fn}\\(`, 'm'),
                `${fn} saiu do dashboard.js — _repararFaturasAdiantadas quebra.`);
        }
    });

    test('os arrays vivos passam SEMPRE por _ctx dentro do módulo', () => {
        const limpo = semRuido(mod);
        for (const arr of ['contasFixas', 'transacoes', 'cartoesCredito']) {
            // Uso do nome sem o `_ctx.` na frente = referência a um array que não existe ali.
            const solto = new RegExp(`(^|[^.\\w$])${arr}\\b`, 'm');
            const achou = limpo.split('\n').filter(l => solto.test(l) && !new RegExp(`_ctx\\.${arr}`).test(l));
            assert.deepEqual(achou, [],
                `db-contas-fixas.js usa "${arr}" fora de _ctx: ${achou.join(' | ')}`);
        }
    });

    test('o shim do dashboard carrega o chunk e repassa os 4 nomes', () => {
        assert.match(dash, /import\(['"]\.\/db-contas-fixas\.js/,
            'o dashboard não faz mais import() do chunk de Contas Fixas.');
        for (const fn of ['abrirContaFixaView', 'abrirContaFixaForm',
                          'abrirPopupPagarContaFixa', 'abrirPopupAnteciparContaFixa']) {
            assert.match(dash, new RegExp(`m\\.${fn}\\(`),
                `o shim não repassa ${fn} para o módulo.`);
        }
    });
});
