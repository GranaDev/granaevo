/**
 * check-dead-code.mjs — funções declaradas e nunca usadas (código morto).
 *
 * POR QUE ESTE SCRIPT EXISTE (2026-07-19):
 * O `check-refs` pega o inverso — chamada para função que não existe. Faltava o
 * outro lado: função que existe e ninguém chama. Não quebra nada, mas mente sobre
 * o tamanho do sistema, aparece em busca, atrapalha refatoração e às vezes revela
 * um recurso que nunca foi ligado.
 *
 * A PRIMEIRA VERSÃO ERA REGEX E ESTAVA ERRADA: acusou `_num`, `_brl` e outras que
 * são usadas dezenas de vezes. Uma varredura que grita errado é pior que nenhuma —
 * ensina a ignorar. Esta versão usa AST (acorn), a mesma base do check-refs.
 *
 * ESCOPO DELIBERADAMENTE ESTREITO: só analisa funções NÃO EXPORTADAS, e só dentro
 * do próprio arquivo. O motivo é honestidade sobre o que dá para provar:
 *   - função privada só pode ser usada no arquivo onde nasce → dá para afirmar
 *     com certeza que ninguém a usa;
 *   - função EXPORTADA pode ser chamada de outro módulo como `P.nome()`
 *     (import de namespace), que é acesso por propriedade e não referência ao
 *     identificador. Foi exatamente aí que a 2ª versão deste script errou: acusou
 *     74 funções de phrases.js que o engine chama via `P.*`.
 * Resolver "export nunca importado" exige resolução cross-module de verdade.
 * Até lá, este script não opina sobre exports — prefere calar a gritar errado.
 *
 * Uso: node scripts/check-dead-code.mjs        (só relata; sai 0)
 *      node scripts/check-dead-code.mjs --strict  (sai 1 se achar algo)
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'acorn';

const RAIZ = 'src/scripts';

// Nomes que são ponto de entrada por contrato — nunca "mortos" mesmo sem chamador
// visível: quem os chama é o carregador do módulo, o HTML ou o navegador.
const PONTOS_DE_ENTRADA = new Set(['init', 'render', 'main', 'handler', 'setup', 'boot']);

function listarArquivos(dir) {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...listarArquivos(p));
        else if (e.name.endsWith('.js')) out.push(p);
    }
    return out;
}

function percorrer(node, visitar, pai = null) {
    if (!node || typeof node.type !== 'string') return;
    visitar(node, pai);
    for (const chave of Object.keys(node)) {
        if (chave === 'type' || chave === 'start' || chave === 'end' || chave === 'loc') continue;
        const filho = node[chave];
        if (Array.isArray(filho)) filho.forEach((f) => percorrer(f, visitar, node));
        else if (filho && typeof filho.type === 'string') percorrer(filho, visitar, node);
    }
}

const arquivos = listarArquivos(RAIZ);
const mortas = [];
let totalPrivadas = 0;

for (const arq of arquivos) {
    const src = fs.readFileSync(arq, 'utf8');
    let ast;
    try {
        ast = parse(src, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
    } catch (e) {
        console.error(`✗ falha ao analisar ${arq}: ${e.message}`);
        process.exit(1);
    }

    // 1) Declarações NÃO exportadas deste arquivo (o pai revela o export).
    const privadas = [];              // { nome, linha, idNode }
    percorrer(ast, (n, pai) => {
        if (n.type !== 'FunctionDeclaration' || !n.id) return;
        const exportada = pai && (pai.type === 'ExportNamedDeclaration' || pai.type === 'ExportDefaultDeclaration');
        if (exportada) return;
        privadas.push({ nome: n.id.name, linha: n.loc.start.line, idNode: n.id });
    });
    if (privadas.length === 0) continue;
    totalPrivadas += privadas.length;

    const idsDeDeclaracao = new Set(privadas.map((p) => p.idNode));

    // 2) Referências DENTRO DESTE ARQUIVO (privada só vive aqui).
    const usosNoArquivo = new Map();
    percorrer(ast, (n, pai) => {
        if (n.type !== 'Identifier' || idsDeDeclaracao.has(n)) return;
        // `obj.nome` não referencia o identificador (salvo se computado: `obj[nome]`).
        if (pai && pai.type === 'MemberExpression' && pai.property === n && !pai.computed) return;
        // Chave de objeto literal idem — MAS `{ nome }` (shorthand) É uso.
        if (pai && pai.type === 'Property' && pai.key === n && !pai.computed && !pai.shorthand) return;
        usosNoArquivo.set(n.name, (usosNoArquivo.get(n.name) || 0) + 1);
    });

    for (const p of privadas) {
        if (PONTOS_DE_ENTRADA.has(p.nome)) continue;
        if ((usosNoArquivo.get(p.nome) || 0) === 0) {
            mortas.push({ nome: p.nome, arquivo: arq, linha: p.linha });
        }
    }
}

mortas.sort((a, b) => a.arquivo.localeCompare(b.arquivo) || a.linha - b.linha);
const declaracoes = { length: totalPrivadas };

if (mortas.length === 0) {
    console.log(`✓ check-dead-code: nenhuma função declarada sem uso (${declaracoes.length} analisadas)`);
    process.exit(0);
}

console.log(`⚠️  check-dead-code: ${mortas.length} função(ões) declarada(s) e nunca referenciada(s):\n`);
for (const m of mortas) {
    console.log(`   ${m.arquivo.split(path.sep).join('/')}:${m.linha}  ${m.nome}()`);
}
console.log(`\n   (${declaracoes.length} funções analisadas. Escopo não é considerado:`);
console.log('   homônimas em arquivos diferentes contam uma pela outra — o erro é para menos.)');

process.exit(process.argv.includes('--strict') ? 1 : 0);
