/**
 * Fase de resiliência (2026-08-12) — trava os invariantes do backup.
 *
 * Todos estes testes existem porque a coisa correspondente DEU ERRADO durante a
 * construção, e o defeito era invisível: o backup rodava, dizia OK, e entregava
 * algo que não servia. Nenhum deles é hipotético.
 *
 * Puro, sem rede. Roda no CI: npm test
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ler  = (...p) => readFileSync(join(RAIZ, ...p), 'utf8')

const semComentarios = (src) => src
    .split('\n')
    .filter((l) => {
        const t = l.trim()
        return !(t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || t.startsWith('REM'))
    })
    .join('\n')

const BACKUP = ler('scripts', 'backup-db.mjs')
const LIMPO  = semComentarios(BACKUP)
const WRAP   = semComentarios(ler('scripts', 'backup-db.cmd'))
const PRIV   = ler('scripts', '_privilegios.mjs')
const VERIF  = ler('scripts', 'verificar-restore.mjs')

describe('backup — o dump precisa carregar a segurança junto', () => {
    test('NUNCA passa --no-privileges como ARGUMENTO', () => {
        // Foi o primeiro defeito: `--no-owner --no-privileges` é o padrão de quem
        // faz dump para MIGRAR. Aqui descartaria todo GRANT/REVOKE — o backup
        // viria com as 62 policies e sem os grants, e restaurar recriaria o
        // SEC-009 (authenticated escrevendo em user_data).
        //
        // A asserção procura o ARGUMENTO entre aspas, não a string solta: a
        // mensagem de erro do próprio script cita "--no-privileges?" para
        // explicar o que teria dado errado, e casar com ela reprovaria o código
        // correto. Teste que pega o comentário sobre o defeito, em vez do
        // defeito, é ruído.
        assert.doesNotMatch(LIMPO, /'--no-privileges'/,
            'o dump voltaria SEM os grants; restaurar reabriria o SEC-009')
    })

    test('mantém --no-owner', () => {
        // Os donos são papéis internos do Supabase; sem a flag o restore
        // enche de erro de permissão.
        assert.match(LIMPO, /'--no-owner'/)
    })

    test('reprova o dump se sair sem entradas ACL', () => {
        assert.match(LIMPO, /acl === 0.*falhar|if \(acl === 0\)/s)
    })

    test('gera o arquivo de privilégios e o envia junto', () => {
        // O dump sozinho restaura um banco mais ABERTO que a produção
        // (medido: 2 -> 34 SECURITY DEFINER expostas).
        assert.match(LIMPO, /CONSULTA_PRIVILEGIOS/)
        assert.match(LIMPO, /privilegios\.sql/)
        assert.match(LIMPO, /for \(const alvo of \[cifrado, privCifrado\]\)/,
            'os DOIS arquivos precisam subir — dump sem privilégios é meio backup')
    })

    test('a retenção derruba o par, não só o dump', () => {
        // Deixar o .privilegios.sql.gpg órfão dá a impressão de haver backup
        // onde só há metade dele.
        assert.match(LIMPO, /\.privilegios\.sql\.gpg/)
        const remota = LIMPO.slice(LIMPO.indexOf('r2Listar'))
        assert.match(remota, /r2Apagar\([^)]*replace\(\/\\\.dump\\\.gpg\$\//,
            'a retenção remota precisa apagar o par de privilégios')
    })
})

describe('backup — verificação antes de confiar', () => {
    test('confere a integridade ANTES de cifrar', () => {
        // Arquivo cifrado íntegro e arquivo cifrado corrompido são idênticos por
        // fora. A checagem só é possível enquanto dá para olhar dentro.
        const iVerif = LIMPO.indexOf('pg_restore')
        const iCifra = LIMPO.indexOf('cifrar(bruto')
        assert.ok(iVerif !== -1 && iCifra !== -1)
        assert.ok(iVerif < iCifra, 'a verificação ficou DEPOIS da cifragem')
    })

    test('prova a decifragem no mesmo run', () => {
        // Sem isto, "backup cifrado" é uma afirmação sobre o futuro.
        assert.match(LIMPO, /--decrypt/)
        assert.match(LIMPO, /decifra/)
    })

    test('confere o tamanho remoto, não só o 200 do PUT', () => {
        // Upload truncado por conexão instável responde sucesso e grava menos.
        assert.match(LIMPO, /r2Tamanho/)
        assert.match(LIMPO, /bytesRemotos !== bytesLocais/)
    })
})

describe('backup — o monitoramento não pode mentir', () => {
    test('falta de credencial do R2 é ERRO, não aviso', () => {
        // Backup que não saiu da máquina não cumpriu o objetivo.
        const bloco = LIMPO.slice(LIMPO.indexOf('r2Configurado()'))
        assert.match(bloco.slice(0, 600), /process\.exitCode = 1/)
    })

    test('a última linha do log CONCORDA com o exit code', () => {
        // A versão anterior imprimia "OK em 4.2s" saindo com 1. Quem lê o log vê
        // sucesso, quem lê o exit code vê falha — é assim que monitoramento
        // aprende a mentir.
        assert.match(LIMPO, /if \(process\.exitCode\)/)
        assert.match(LIMPO, /INCOMPLETO/)
    })

    test('o wrapper propaga o exit code para o Agendador', () => {
        // Sem o `exit /b`, o Agendador registra sucesso sempre.
        assert.match(WRAP, /exit \/b %CODIGO%/)
    })

    test('o texto claro é apagado MESMO quando o backup falha', () => {
        // Achado em 2026-08-12, tirando o retrato final: três dumps SEM CIFRA
        // tinham ficado no disco — sobras de execuções que morreram entre o
        // pg_dump e o gpg. O rmSync só rodava depois da cifragem bem-sucedida,
        // então toda falha nesse intervalo deixava e-mails, log de auditoria e
        // dados de assinatura em claro, indefinidamente.
        //
        // O caminho de erro é justamente o que ninguém observa.
        //
        // ATUALIZADO na re-auditoria de 2026-08-13. Estas asserções checavam a
        // FORMA do código (`const efemeros = new Set()`, `process.on('exit',…)`),
        // e a forma mudou: o mecanismo virou scripts/_efemeros.mjs justamente
        // para poder ser testado matando um processo de verdade.
        //
        // A intenção do teste não mudou, e a prova ficou MAIS FORTE, não menos:
        // quem garante o comportamento agora é tests/unit/efemeros-sinal.test.js,
        // que nasce um processo, manda SIGTERM/SIGINT e confere no disco que o
        // arquivo sumiu. O que sobra aqui é o que aquele teste não cobre — que
        // ESTE script está de fato ligado ao mecanismo.
        //
        // (A correção original também estava incompleta: `process.on('exit')` não
        // roda em terminação por sinal, então Ctrl+C ainda deixava o dump em
        // claro. Era o ACHADO-03.)
        assert.match(LIMPO, /from '\.\/_efemeros\.mjs'/)
        assert.match(LIMPO, /instalarLimpezaAutomatica\(\)/)
        assert.match(LIMPO, /registrarEfemero\(bruto\)/)
        assert.match(LIMPO, /registrarEfemero\(privBruto\)/)
        // e o caminho de falha limpa antes de sair
        const f = LIMPO.slice(LIMPO.indexOf('const falhar ='), LIMPO.indexOf('const exigir ='))
        assert.match(f, /limparEfemeros\(\)/, 'falhar() precisa limpar antes do exit')
    })

    test('o gpg é resolvido por caminho absoluto, não pelo PATH', () => {
        // Pelo Git Bash o `gpg` resolve; pelo Agendador de Tarefas, NÃO — e o
        // script morria com ENOENT depois de já ter gerado o dump. Todo backup
        // noturno teria falhado.
        assert.match(LIMPO, /const GPG = /)
        assert.match(LIMPO, /Git\\\\usr\\\\bin\\\\gpg\.exe/)
        assert.doesNotMatch(LIMPO, /execFileSync\('gpg'/,
            'sobrou chamada ao gpg pelo PATH')
    })
})

describe('privilégios — o antídoto do restore inseguro', () => {
    test('revoga antes de reconceder (idempotente)', () => {
        assert.match(PRIV, /REVOKE ALL ON TABLE/)
        assert.match(PRIV, /REVOKE ALL ON FUNCTION/)
        assert.match(PRIV, /FROM PUBLIC, anon, authenticated/)
    })

    test('cobre grants por COLUNA', () => {
        // O projeto usa em account_members.is_active e
        // radar_notifications.dismissed_at. Sem isto, o X do sino e a remoção
        // de convidado quebram depois do restore.
        assert.match(PRIV, /col_grants/)
        assert.match(PRIV, /has_column_privilege/)
    })

    test('o cabeçalho explica por que o arquivo existe', () => {
        // Quem achar este .sql numa emergência precisa entender em 10 segundos
        // que ele não é opcional.
        assert.match(PRIV, /APLICAR SEMPRE DEPOIS DE UM pg_restore/)
    })
})

describe('validador de restore', () => {
    test('sai com código != 0 quando reprova', () => {
        // Restore não validado é restore que não aconteceu.
        assert.match(VERIF, /process\.exit\(1\)/)
        assert.match(VERIF, /NÃO coloque este banco no ar/)
    })

    test('checa as invariantes que o restore quebrava', () => {
        for (const alvo of [
            /relrowsecurity/,                        // RLS
            /relforcerowsecurity/,                   // FORCE RLS
            /has_function_privilege\('anon'/,        // DEFINER expostas
            /public\.user_data','INSERT'/,           // SEC-009
            /proconfig IS NULL/,                     // search_path
            /FROM auth\.users/,                      // login possível
        ]) assert.match(VERIF, alvo, `faltou checagem: ${alvo}`)
    })

    test('não compara com a produção — usa invariantes absolutas', () => {
        // Num desastre de verdade a produção não está lá para comparar.
        assert.doesNotMatch(VERIF, /SUPABASE_PROJECT_REF/,
            'o validador não pode depender do projeto de produção existir')
    })
})

describe('runbook', () => {
    test('existe e manda aplicar os privilégios', () => {
        assert.ok(existsSync(join(RAIZ, 'docs', 'runbook-desastre.md')))
        const rb = ler('docs', 'runbook-desastre.md')
        assert.match(rb, /privilegios\.sql/)
        assert.match(rb, /NÃO PULE|NAO PULE/)
        assert.match(rb, /verificar-restore\.mjs/)
    })

    test('registra RPO e RTO medidos, não estimados', () => {
        const rb = ler('docs', 'runbook-desastre.md')
        assert.match(rb, /RPO/)
        assert.match(rb, /RTO/)
        assert.match(rb, /1,3 minuto|1\.3 min/)
    })

    test('lista o que o backup NÃO cobre', () => {
        // Saber o que não está no backup vale tanto quanto o que está.
        const rb = ler('docs', 'runbook-desastre.md')
        assert.match(rb, /não.*cobre/i)
        assert.match(rb, /Storage/)
        assert.match(rb, /pg_cron|cron/)
    })
})
