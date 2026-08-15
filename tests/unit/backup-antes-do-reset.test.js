/**
 * O BACKUP QUE A TELA PROMETIA E NÃO EXISTIA.
 *
 * Achado pelo dono em 2026-08-15, durante o smoke test. O popup de "Resetar
 * Perfil" afirma, em verde e com ícone de escudo:
 *
 *   "Backup automático será criado — Antes de resetar, seus dados atuais serão
 *    salvos como backup nomeado 'Antes do reset — <perfil>'. Este backup ficará
 *    disponível por 5 dias."
 *
 * e o botão exibe "⏳ Salvando backup…". O que o código fazia:
 *
 *   _setBackupNome(hoje, nomeBackup);   // um RÓTULO no localStorage
 *   await _ctx.salvarDados();           // salva o blob, que já estava salvo
 *
 * `salvarDados` NÃO cria snapshot. Quem cria é `take_daily_snapshot()`, chamada
 * pelo cron UMA VEZ POR DIA (03:15 UTC) — e ela ainda tem guarda de idempotência
 * que a faria pular se chamada de novo no mesmo dia. O rótulo apontava para a
 * data de hoje, cujo snapshot era o da madrugada.
 *
 * CONSEQUÊNCIA MEDIDA: reset às ~13:30, restauração devolvendo o estado das
 * 03:15. Dez horas de trabalho perdidas depois de a interface garantir que
 * estavam salvas.
 *
 * O que este arquivo protege é a promessa: se a tela diz que faz backup, o
 * backup tem de existir ANTES de qualquer coisa ser apagada — e, se ele falhar,
 * NADA pode ser apagado.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

const soCodigo = (t) => t.split('\n')
  .filter((l) => {
    const s = l.trim()
    return !(s.startsWith('//') || s.startsWith('*') || s.startsWith('/*'))
  })
  .join('\n')

const bloco = (src, ini, fim) => {
  const i = src.indexOf(ini); assert.ok(i !== -1, `não achei o início: ${ini}`)
  const j = src.indexOf(fim, i); assert.ok(j > i, `não achei o fim: ${fim}`)
  return src.slice(i, j)
}

const CFG   = soCodigo(readFileSync(join(RAIZ, 'src/scripts/pages/db-configuracoes.js'), 'utf8'))
const DASH  = soCodigo(readFileSync(join(RAIZ, 'src/scripts/pages/dashboard.js'), 'utf8'))
const EDGE  = soCodigo(readFileSync(join(RAIZ, 'supabase/functions/user-data-backup/index.ts'), 'utf8'))
const PROXY = soCodigo(readFileSync(join(RAIZ, 'api/user-data.js'), 'utf8'))
const MIGR  = readFileSync(join(RAIZ, 'supabase/migrations/20260815160000_snapshot_sob_demanda.sql'), 'utf8')

// ─────────────────────────────────────────────────────────────────────────────
describe('⭐ o reset fotografa ANTES de apagar', () => {
  // Recorta do início do handler até o ponto em que os dados são zerados.
  const ateApagar = () => bloco(CFG, "btnConfirmar.textContent = '⏳ Salvando backup…'", '_ctx.transacoes          = []')

  test('a foto é pedida ao servidor, não simulada no cliente', () => {
    assert.match(
      ateApagar(),
      /action:\s*'snapshot'/,
      'voltou a "fazer backup" sem pedir snapshot nenhum — a tela promete e o servidor não sabe',
    )
  })

  test('⭐ a foto acontece ANTES do zeramento', () => {
    // A ordem é a correção inteira. Fotografar depois de apagar guardaria o
    // estado vazio — um backup que restaura exatamente o que se quis desfazer.
    const iSnap  = CFG.indexOf("action: 'snapshot'")
    const iZera  = CFG.indexOf('_ctx.transacoes          = []')
    assert.ok(iSnap !== -1, 'a chamada de snapshot sumiu')
    assert.ok(iZera !== -1, 'o zeramento sumiu')
    assert.ok(iSnap < iZera, 'a foto passou a ser tirada DEPOIS de apagar: o backup guardaria o vazio')
  })

  test('salva o blob antes de fotografar — senão a foto perde os últimos segundos', () => {
    const t = ateApagar()
    const iSalva = t.indexOf('await _ctx.salvarDados()')
    const iSnap  = t.indexOf("action: 'snapshot'")
    assert.ok(iSalva !== -1 && iSalva < iSnap,
      'a foto passou a vir antes do save: as últimas edições ficariam de fora do backup')
  })

  test('⭐ FALHA FECHADA: sem backup, nada é apagado', () => {
    const t = ateApagar()
    assert.match(
      t,
      /if \(!snapResp\.ok\) \{\s*throw new Error\('SNAPSHOT_FALHOU/,
      'o reset voltou a seguir em frente com o backup falhando — apagar dados ' +
      'depois de prometer backup é exatamente o defeito original',
    )
  })

  test('o rótulo só é gravado depois de a foto existir', () => {
    // Gravar o nome antes seria registrar no histórico um backup que pode não
    // ter sido criado — o usuário veria "Antes do reset" apontando para nada.
    const t = ateApagar()
    const iCheck = t.indexOf('if (!snapResp.ok)')
    const iNome  = t.indexOf('_setBackupNome(hoje, nomeBackup)')
    assert.ok(iNome > iCheck, 'o rótulo voltou a ser gravado antes da confirmação da foto')
  })

  test('a mensagem de erro diz que os dados continuam lá', () => {
    assert.match(CFG, /SNAPSHOT_FALHOU/)
    assert.match(CFG, /nada foi apagado/i,
      'a falha de backup voltou a cair na mensagem genérica: o usuário fica sem saber se perdeu tudo')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('a ação snapshot, do proxy ao banco', () => {
  test('o proxy roteia a ação e não repassa nada do corpo do cliente', () => {
    const t = bloco(PROXY, "if (parsed?.action === 'snapshot')", "if (parsed?.action === 'restore')")
    assert.match(t, /body: JSON\.stringify\(\{ action: 'snapshot' \}\)/,
      'o proxy passou a repassar campos do cliente numa ação que não tem parâmetro')
    assert.match(t, /checkRL\(`ip:\$\{ip\}:snapshot`/, 'sumiu o rate limit por IP')
    assert.match(t, /checkRL\(`uid:\$\{userId\}:snapshot`/, 'sumiu o rate limit por usuário')
  })

  test('a edge falha FECHADA quando a RPC não confirma', () => {
    const t = bloco(EDGE, "if (body.action === 'snapshot')", "if (body.action !== 'restore')")
    assert.match(t, /\.rpc\('snapshot_sob_demanda',\s*\{\s*p_user_id: userId\s*\}\)/)
    assert.match(t, /if \(snapErr \|\| ok !== true\)/,
      'passou a aceitar a RPC devolvendo false — "ok" otimista recria a promessa vazia')
    assert.match(t, /return json\(\{ error: [^}]*\}, 500, cors\)/)
  })

  test('a edge fotografa o DONO, não quem clicou', () => {
    // Convidado de casal/família opera no registro do dono; fotografar o id de
    // quem clicou salvaria um blob que não existe.
    const t = bloco(EDGE, "if (body.action === 'snapshot')", "if (body.action !== 'restore')")
    assert.match(t, /p_user_id: userId/)
    assert.doesNotMatch(t, /user\.id/, 'passou a usar o id de quem clicou em vez do dono da conta')
  })

  test('a RPC é inalcançável pelo cliente', () => {
    // Se `authenticated` pudesse chamá-la, daria para sobrescrever o próprio
    // snapshot do dia DEPOIS de um reset — destruindo a única cópia boa.
    assert.match(MIGR, /REVOKE ALL ON FUNCTION public\.snapshot_sob_demanda\(uuid\) FROM anon/)
    assert.match(MIGR, /REVOKE ALL ON FUNCTION public\.snapshot_sob_demanda\(uuid\) FROM authenticated/)
    assert.match(MIGR, /GRANT EXECUTE ON FUNCTION public\.snapshot_sob_demanda\(uuid\) TO service_role/)
  })

  test('a RPC atualiza o carimbo de hora ao substituir', () => {
    // Sem isto o histórico mostraria "03:15" para uma foto tirada às 13:30 — e a
    // hora é justamente o que o usuário usa para escolher o que restaurar.
    assert.match(MIGR, /ON CONFLICT \(user_id, snapshot_date\) DO UPDATE/)
    assert.match(MIGR, /created_at = now\(\)/)
  })

  test('a RPC recusa quando não há o que fotografar', () => {
    assert.match(MIGR, /IF NOT v_tem THEN\s*RETURN false;/,
      'sem esta recusa, o reset seguiria achando que tem backup de uma conta sem dados')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('⭐ a fila drenou: a tela precisa saber', () => {
  // Medido em 15/08: a fila drenou às 13:22:37 (audit log: +232 bytes) e a
  // transação não apareceu — a página seguia mostrando o estado do boot. Da
  // cadeira do usuário isso é indistinguível de dado perdido, e lançar de novo
  // (a reação natural) cria a duplicata de verdade.
  test('alguém escuta ge:fila-vazia', () => {
    assert.match(
      DASH,
      /document\.addEventListener\('ge:fila-vazia'/,
      'o evento voltou a ser disparado sem ouvinte: o lançamento offline sobe e some da vista',
    )
  })

  test('o ouvinte recarrega do servidor', () => {
    const t = bloco(DASH, "document.addEventListener('ge:fila-vazia'", '});')
    assert.match(t, /_recarregarDoServidor\(/,
      'avisa e não recarrega: a tela continua mostrando o estado de antes da drenagem')
  })

  test('e o data-manager continua emitindo o evento', () => {
    const DM = soCodigo(readFileSync(join(RAIZ, 'src/scripts/modules/data-manager.js'), 'utf8'))
    assert.match(DM, /dispatchEvent\(new CustomEvent\('ge:fila-vazia'\)\)/)
  })
})
