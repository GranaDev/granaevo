/**
 * _efemeros.mjs — arquivos em TEXTO CLARO que precisam sumir em QUALQUER desfecho.
 *
 * POR QUE ISTO É UM MÓDULO, E NÃO DUAS FUNÇÕES DENTRO DO backup-db.mjs
 * ---------------------------------------------------------------------------
 * Porque assim dá para MATAR um processo de verdade num teste e ver o arquivo
 * sumir. Enquanto a limpeza vivia dentro do script — que exige senha do banco,
 * pg_dump e gpg para chegar a qualquer lugar — a única asserção possível era
 * "o handler está registrado no fonte", que é exatamente o tipo de teste que
 * esta re-auditoria acabou de reprovar em outro lugar.
 *
 * HISTÓRICO (por que existe)
 * ---------------------------------------------------------------------------
 * 2026-08-12: três dumps sem cifra foram encontrados no disco, sobras de
 * execuções que morreram entre o `pg_dump` e o `gpg`. O `rmSync` só rodava
 * DEPOIS da cifragem, então toda falha nesse intervalo deixava e-mails, log de
 * auditoria e dados de assinatura em claro, indefinidamente. Corrigido com
 * `process.on('exit')`.
 *
 * 2026-08-13, re-auditoria: `process.on('exit')` NÃO roda em terminação por
 * sinal. A correção cobria saída normal e exceção não tratada, e deixava de fora
 * justamente o Ctrl+C — o desfecho mais provável num script que se roda à mão.
 *
 * LIMITE REAL, DECLARADO (não é bug, é o que o SO permite)
 * ---------------------------------------------------------------------------
 *   • POSIX  — SIGINT, SIGTERM, SIGHUP: cobertos.
 *   • Windows — SIGINT (Ctrl+C) e SIGBREAK (Ctrl+Break): cobertos.
 *               SIGTERM NÃO é coberto: no Windows ele vira `TerminateProcess`,
 *               que nenhum handler intercepta. É o que o "Finalizar tarefa" do
 *               Agendador usa.
 *   • SIGKILL e queda de energia: irrecuperáveis em qualquer sistema.
 *
 * Ou seja: no Windows, matar a tarefa pelo Agendador AINDA pode deixar o dump em
 * claro. A mitigação para esse caso não é código — é o diretório de destino
 * ficar fora do repositório e fora de qualquer pasta sincronizada.
 */
import { existsSync, rmSync } from 'node:fs';

const _efemeros = new Set();

/** Registra um caminho para remoção garantida. Chame ANTES de criar o arquivo. */
export function registrarEfemero(caminho) {
    _efemeros.add(caminho);
}

/** Remove tudo que foi registrado. Idempotente — pode rodar várias vezes. */
export function limparEfemeros() {
    for (const f of _efemeros) {
        try { if (existsSync(f)) rmSync(f); } catch { /* melhor esforço */ }
    }
    _efemeros.clear();
}

/**
 * Liga a limpeza a todos os desfechos que o processo consegue observar.
 *
 * `process.exit()` dentro do handler de sinal dispara o handler de 'exit' — daí
 * `limparEfemeros` precisar ser idempotente, o que é (o Set é esvaziado).
 */
export function instalarLimpezaAutomatica() {
    process.on('exit', limparEfemeros);
    for (const sinal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
        try {
            process.on(sinal, () => {
                limparEfemeros();
                console.error(`\n[efemeros] interrompido por ${sinal} — temporários em claro removidos`);
                process.exit(130);
            });
        } catch { /* sinal inexistente nesta plataforma: os outros seguem valendo */ }
    }
}
