/**
 * run-unit-tests.mjs — roda a suíte unitária de forma PORTÁTIL entre versões do Node.
 *
 * POR QUE ESTE SCRIPT EXISTE (CI vermelha em 2026-07-21):
 * O script era `node --test "tests/unit/**\/*.test.js"`. O Node 20 (o que roda na
 * CI) NÃO expande glob em `--test` — ele tratou o padrão como caminho literal e
 * quebrou com "Could not find '.../tests/unit/**\/*.test.js'". Localmente passava
 * porque aqui o Node é 24, que expande. Um bug que só existia no servidor.
 *
 * Trocar por `node --test tests/unit/` também não serve: no Node 24 o diretório
 * é tratado como MÓDULO a executar ("Cannot find module .../tests/unit"), não
 * como pasta a varrer. Ou seja, cada versão quebra de um jeito.
 *
 * A forma que funciona em TODAS: descobrir os arquivos aqui e passá-los
 * explicitamente. Também é mais seguro — deixa de fora `tests/security/`, que
 * manda e-mail de verdade e martela rate limit, e por isso nunca deve rodar na CI.
 */
import { readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const RAIZ = 'tests/unit';

function encontrar(dir) {
    const achados = [];
    for (const entrada of readdirSync(dir, { withFileTypes: true })) {
        const caminho = join(dir, entrada.name);
        if (entrada.isDirectory()) achados.push(...encontrar(caminho));
        else if (entrada.name.endsWith('.test.js')) achados.push(caminho);
    }
    return achados;
}

let arquivos;
try {
    arquivos = encontrar(RAIZ).sort();
} catch (e) {
    console.error(`✗ não consegui ler ${RAIZ}: ${e.message}`);
    process.exit(1);
}

if (arquivos.length === 0) {
    // Falhar aqui é proposital: suíte vazia passando é pior que suíte quebrada —
    // dá a sensação de estar coberto sem estar.
    console.error(`✗ nenhum *.test.js encontrado em ${RAIZ}`);
    process.exit(1);
}

// Normaliza para "/" — o Node aceita nos dois sistemas e evita surpresa no Windows.
const alvos = arquivos.map((a) => a.split(sep).join('/'));
console.log(`▶ ${alvos.length} arquivo(s) de teste`);

const r = spawnSync(process.execPath, ['--test', ...alvos], { stdio: 'inherit' });
process.exit(r.status ?? 1);
