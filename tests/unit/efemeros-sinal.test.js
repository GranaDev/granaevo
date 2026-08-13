/**
 * ACHADO-03 (re-auditoria 2026-08-13) — o dump em claro tem de sumir no SINAL.
 *
 * POR QUE ESTE TESTE NÃO OLHA O FONTE
 * ---------------------------------------------------------------------------
 * A correção de 2026-08-12 tirou do disco três dumps sem cifra, sobras de
 * execuções mortas entre o `pg_dump` e o `gpg`. Ela registrou a limpeza em
 * `process.on('exit')` — que NÃO roda em terminação por sinal. Ou seja: o Ctrl+C,
 * o desfecho mais provável de um script rodado à mão, continuava deixando
 * e-mails, log de auditoria e dados de assinatura em claro no disco.
 *
 * Um teste do tipo `assert(fonte.includes("SIGTERM"))` teria passado nos DOIS
 * estados — antes e depois — porque a string aparece no arquivo de qualquer
 * jeito. Este projeto já foi mordido por isso mais de uma vez.
 *
 * Então aqui um processo NASCE, cria um arquivo, LEVA UM SINAL DE VERDADE, e o
 * teste confere no disco que o arquivo sumiu.
 *
 * O QUE NÃO DÁ PARA TESTAR NO WINDOWS (e por que não é desculpa)
 * ---------------------------------------------------------------------------
 * No Windows, `child.kill()` vira `TerminateProcess`: nenhum handler roda, por
 * decisão do sistema operacional, não do Node. Não há como entregar um sinal
 * observável a um filho. O teste então SALTA no Windows e roda de verdade na CI
 * (ubuntu-latest), que é onde o gate de merge acontece.
 *
 * A consequência prática está declarada em scripts/_efemeros.mjs e vale repetir:
 * na máquina Windows onde o backup roda de fato, Ctrl+C e Ctrl+Break ficam
 * cobertos, mas "Finalizar tarefa" no Agendador NÃO — ele usa TerminateProcess.
 * Para esse caso a mitigação é o destino ficar fora do repositório e de qualquer
 * pasta sincronizada, não código.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const NO_WINDOWS = process.platform === 'win32';
const MOTIVO_SKIP =
    'Windows: child.kill() vira TerminateProcess e nenhum handler roda — ' +
    'sem sinal observável para testar. Roda de verdade na CI (ubuntu).';

const MODULO = pathToFileURL(resolve('scripts/_efemeros.mjs')).href;

/**
 * Cria um processo filho que usa o MÓDULO REAL, registra um arquivo efêmero e
 * fica vivo esperando o sinal. Resolve quando o filho avisa que está pronto.
 */
function nascerFilho(dir) {
    const alvo = join(dir, 'dump-em-claro.dump');
    const script = join(dir, 'filho.mjs');

    writeFileSync(script, `
import { writeFileSync } from 'node:fs';
import { registrarEfemero, instalarLimpezaAutomatica } from ${JSON.stringify(MODULO)};

const alvo = ${JSON.stringify(alvo)};
registrarEfemero(alvo);          // registrado ANTES de existir, como no backup real
instalarLimpezaAutomatica();
writeFileSync(alvo, 'e-mails, log de auditoria, dados de assinatura');

process.stdout.write('PRONTO\\n');
setInterval(() => {}, 1000);     // segura o processo vivo até o sinal chegar
`);

    const filho = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'] });
    const pronto = new Promise((resolveP, rejeitar) => {
        const t = setTimeout(() => rejeitar(new Error('filho não ficou pronto em 10s')), 10_000);
        filho.stdout.on('data', (d) => {
            if (String(d).includes('PRONTO')) { clearTimeout(t); resolveP(); }
        });
        filho.on('error', rejeitar);
    });
    return { filho, alvo, pronto };
}

const saidaDe = (filho) => new Promise((res) => filho.on('exit', (code, sinal) => res({ code, sinal })));

describe('ACHADO-03 — limpeza de temporários em claro sobrevive ao sinal', () => {
    it('SIGTERM: o processo morre e o arquivo em claro desaparece', { skip: NO_WINDOWS && MOTIVO_SKIP }, async () => {
        const dir = mkdtempSync(join(tmpdir(), 'granaevo-efemeros-'));
        try {
            const { filho, alvo, pronto } = nascerFilho(dir);
            await pronto;

            assert.equal(existsSync(alvo), true, 'pré-condição: o arquivo em claro existe');

            filho.kill('SIGTERM');
            await saidaDe(filho);

            assert.equal(existsSync(alvo), false,
                'o dump em claro sobreviveu ao SIGTERM — é exatamente o ACHADO-03');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('SIGINT (o Ctrl+C do backup manual): mesma garantia', { skip: NO_WINDOWS && MOTIVO_SKIP }, async () => {
        const dir = mkdtempSync(join(tmpdir(), 'granaevo-efemeros-'));
        try {
            const { filho, alvo, pronto } = nascerFilho(dir);
            await pronto;
            assert.equal(existsSync(alvo), true);

            filho.kill('SIGINT');
            await saidaDe(filho);

            assert.equal(existsSync(alvo), false, 'Ctrl+C deixou texto claro no disco');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('sai com 130 no sinal — o código convencional de "interrompido"', { skip: NO_WINDOWS && MOTIVO_SKIP }, async () => {
        const dir = mkdtempSync(join(tmpdir(), 'granaevo-efemeros-'));
        try {
            const { filho, pronto } = nascerFilho(dir);
            await pronto;
            filho.kill('SIGTERM');
            const { code } = await saidaDe(filho);
            assert.equal(code, 130);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('o backup real usa este módulo (e não uma cópia divergente)', async () => {
        const { readFileSync } = await import('node:fs');
        const fonte = readFileSync('scripts/backup-db.mjs', 'utf8');
        // Sem isto, os testes acima provariam um módulo que ninguém chama —
        // que é a forma mais fácil de um controle passar a existir só no papel.
        assert.match(fonte, /from '\.\/_efemeros\.mjs'/, 'backup-db.mjs precisa importar o módulo real');
        assert.match(fonte, /instalarLimpezaAutomatica\(\)/, 'e precisa efetivamente instalá-la');
        assert.equal(/\bregistrarEfemero\(/.test(fonte), true, 'e registrar os arquivos em claro');
    });
});
