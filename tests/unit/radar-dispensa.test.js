/**
 * GranaEvo — Regressão: a dispensa de um aviso tem que ser PERMANENTE
 *
 * O BUG (2026-08-07, relatado pelo dono: "excluo todas, mas quando logo
 * novamente lá estão elas de novo"):
 *
 *   Dispensar um aviso no sino grava `dismissed_at` mas NÃO muda o status — a
 *   linha continua 'pending'. O `_sincronizar()` do radar começa apagando todo
 *   'pending' dos tipos do Radar para reagendar com dados frescos. Sem filtrar
 *   por `dismissed_at`, esse delete levava a linha JUNTO COM A DISPENSA, e o
 *   upsert seguinte recriava o mesmo evento com `dismissed_at` nulo.
 *   O `ignoreDuplicates` não protegia: a linha que causaria o conflito tinha
 *   acabado de ser apagada pelo próprio delete.
 *
 *   Confirmado no banco de produção na época: dispensas sobreviviam em
 *   status 'sent' (5 linhas) e 'failed' (4), e havia ZERO linhas dispensadas
 *   em 'pending' — exatamente o rastro de um delete que as varria.
 *
 * O CONSERTO tem DUAS pontas, e uma sem a outra deixa o bug pela metade:
 *   1. radar.js — o delete não pode tocar em linha dispensada. Mantendo-a viva,
 *      é ela que faz o `ignoreDuplicates` pular o evento no reagendamento.
 *   2. send-radar-push — a fila de envio não pode mandar linha dispensada.
 *      Sem isso, o aviso some do app e mesmo assim chega no celular.
 *
 * São testes de INVARIANTE sobre o código-fonte (mesmo padrão de
 * seguranca-regressao.test.js): rodam no CI sem banco, sem rede e sem segredo,
 * e pegam justamente o erro que causou o bug — um filtro removido numa query.
 *
 *   node --test tests/unit/
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ler  = (...p) => readFileSync(join(RAIZ, ...p), 'utf8')

/**
 * Recorta uma cadeia de query supabase-js a partir de um gatilho até o `;` que
 * a encerra. Assim o teste olha SÓ a query em questão, e não o arquivo inteiro
 * (que menciona `dismissed_at` em comentários e em outras chamadas).
 *
 * O gatilho é RegExp (e não texto literal) de propósito: os arquivos são CRLF e
 * a indentação muda com refatoração — um âncora literal quebraria por motivo
 * nenhum e esconderia o que o teste realmente protege.
 */
function cadeiaAPartirDe(fonte, gatilho) {
  const m = gatilho.exec(fonte)
  assert.ok(m, `não achei ${gatilho} — o arquivo mudou de forma`)
  const fim = fonte.indexOf(';', m.index)
  assert.notEqual(fim, -1, 'cadeia de query sem ponto e vírgula final')
  return fonte.slice(m.index, fim)
}

describe('radar.js — o reagendamento não pode ressuscitar aviso dispensado', () => {
  const fonte = ler('src', 'scripts', 'modules', 'radar.js')
  const del   = cadeiaAPartirDe(fonte, /\.from\('radar_notifications'\)\s*\.delete\(\)/)

  test('o delete de pendentes filtra dismissed_at IS NULL', () => {
    assert.ok(
      /\.is\(\s*['"]dismissed_at['"]\s*,\s*null\s*\)/.test(del),
      'O delete do _sincronizar() voltou a apagar linhas dispensadas.\n' +
      'Efeito para o usuário: ele apaga os avisos, e no próximo login todos\n' +
      'voltam — porque a linha (e a dispensa junto) some e o upsert recria.\n' +
      'Cadeia encontrada:\n' + del
    )
  })

  test('continua restrito a status pending e aos tipos do próprio Radar', () => {
    // Guarda dos dois bugs ANTERIORES desta mesma query: varrer 'sent' (que é o
    // dedupe) e varrer os lembretes criados pelo usuário (tipo 'lembrete').
    assert.match(del, /\.eq\(\s*['"]status['"]\s*,\s*['"]pending['"]\s*\)/)
    assert.match(del, /\.in\(\s*['"]tipo['"]/)
    assert.ok(!/['"]lembrete['"]/.test(del),
      "'lembrete' é criado pelo usuário e o Radar não o reinsere — se entrar nesta " +
      'lista, abrir o app apaga os lembretes da pessoa.')
  })

  test('o upsert que reagenda ignora duplicata pelo dedupe (é o que trava a volta)', () => {
    // Sem ignoreDuplicates no par (user_id, dedupe_key) — que tem índice único
    // radar_notifications_user_dedupe — a linha dispensada sobrevivente não
    // impediria a recriação do evento.
    assert.match(fonte, /onConflict:\s*['"]user_id,dedupe_key['"]/)
    assert.match(fonte, /ignoreDuplicates:\s*true/)
  })
})

describe('purga — não pode apagar a dispensa antes do evento morrer', () => {
  // 3ª porta do mesmo bug: a dispensa só vale enquanto a LINHA existir. A purga
  // apagava 'pending' aos 30 dias, dispensada ou não — e como o Radar enxerga
  // 35 dias à frente, um aviso dispensado de conta que vence em 33+ dias voltava
  // sozinho ~30 dias depois. Retenção de 40 > janela de 35 fecha a porta.
  const sql = ler('supabase', 'migrations', '20260807000000_purge_preserva_dispensadas.sql')

  test('linha dispensada tem retenção maior que a janela de 35 dias do Radar', () => {
    const m = /dismissed_at IS NOT NULL[\s\S]{0,120}?interval\s*'(\d+) days'/.exec(sql)
    assert.ok(m, 'a purga não trata mais `dismissed_at IS NOT NULL` em separado — ' +
                 'ela voltou a apagar dispensas junto com as pendentes comuns.')
    const dias = Number(m[1])
    assert.ok(dias > 35,
      `retenção de ${dias} dias para linha dispensada é MENOR que a janela de 35 dias\n` +
      'do Radar (limite = hoje + 35 em _computarEventos). Nessa faixa, apagar a\n' +
      'linha faz o Radar recriar o evento e o aviso dispensado volta sozinho.')
  })

  test('a migration tem rollback e preserva o search_path endurecido', () => {
    ler('supabase', 'migrations', '20260807000000_purge_preserva_dispensadas.down.sql')
    assert.match(sql, /SET search_path TO 'public', 'extensions', 'pg_temp'/,
      'reescrever a função com o search_path original (só `public`) desfaria em ' +
      'silêncio um hardening de segurança aplicado depois da migration original.')
  })
})

describe('send-radar-push — aviso dispensado não vira push no celular', () => {
  const fonte = ler('supabase', 'functions', 'send-radar-push', 'index.ts')
  const fila  = cadeiaAPartirDe(fonte, /\.select\("id, user_id, tipo, title, body, url"\)/)

  test('a fila de envio filtra dismissed_at IS NULL', () => {
    assert.ok(
      /\.is\(\s*["']dismissed_at["']\s*,\s*null\s*\)/.test(fila),
      'A fila voltou a enviar avisos dispensados.\n' +
      'Efeito para o usuário: ele apaga o aviso no app e o push chega assim\n' +
      'mesmo — dispensar deixa de significar alguma coisa.\n' +
      'Cadeia encontrada:\n' + fila
    )
  })

  test('a fila continua limitada a pending e ao que já venceu', () => {
    assert.match(fila, /\.eq\(\s*["']status["']\s*,\s*["']pending["']\s*\)/)
    assert.match(fila, /\.lte\(\s*["']fire_at["']/)
  })
})
