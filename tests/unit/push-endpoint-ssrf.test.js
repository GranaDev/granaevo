/**
 * SEC-002 — PARA ONDE O SERVIDOR ACEITA DISPARAR UM PUSH.
 *
 * Achado de 2026-08-17. `push_subscriptions.endpoint` era validado só como
 * "string não-vazia":
 *
 *     if (!endpoint || typeof endpoint !== 'string' || !p256dh || !auth) …400
 *
 * e `send-radar-push` fazia POST para o que estivesse gravado. Endpoint escolhido
 * pelo usuário = destino de requisição de saída do backend (SSRF cego). Pior: o
 * cliente tinha INSERT/UPDATE DIRETO na tabela via PostgREST, então validar só na
 * Edge Function não fecharia nada — dava para gravar por fora dela.
 *
 * O QUE ESTE ARQUIVO PROTEGE:
 *   1. a decisão em si, exercitada de verdade — incluindo os disfarces que uma
 *      checagem ingênua deixa passar (`includes`, credenciais na URL, sufixo);
 *   2. que os DOIS caminhos do servidor chamem a MESMA função — gravar e
 *      disparar. Uma regra copiada em dois lugares diverge;
 *   3. que a lista seja de PERMISSÃO. Uma lista de bloqueio ("nada de localhost")
 *      é jogo que se perde para redirect e DNS rebinding.
 *
 * O item 2 é sobre o fonte. Comentário sai ANTES de casar — senão a prosa que
 * explica a regra faz o teste passar sozinha (lição cara de 2026-08).
 */
import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transformSync } from 'esbuild'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Tira comentários de linha e de bloco — o teste fala do CÓDIGO, não da prosa. */
function semComentarios(src) {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trim()
      return !(t.startsWith('//') || t.startsWith('/*') || t.startsWith('*'))
    })
    .join('\n')
}

const SAVE = semComentarios(
  readFileSync(join(RAIZ, 'supabase/functions/save-push-subscription/index.ts'), 'utf8'))
const SEND = semComentarios(
  readFileSync(join(RAIZ, 'supabase/functions/send-radar-push/index.ts'), 'utf8'))

let recusar, valido, MAX_ENDPOINT_CHARS
before(async () => {
  const ts = readFileSync(join(RAIZ, 'supabase/functions/_shared/push-endpoint.ts'), 'utf8')
  const js = transformSync(ts, { loader: 'ts', format: 'esm' }).code
  const mod = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))
  recusar = mod.recusarEndpointPush
  valido = mod.endpointPushValido
  MAX_ENDPOINT_CHARS = mod.MAX_ENDPOINT_CHARS
})

// ─────────────────────────────────────────────────────────────────────────────
describe('a decisão — exercitada, não lida', () => {
  test('os push services reais passam', () => {
    for (const ok of [
      'https://fcm.googleapis.com/fcm/send/abc123',
      'https://android.googleapis.com/gcm/send/xyz',
      'https://updates.push.services.mozilla.com/wpush/v2/gAAA',
      'https://web.push.apple.com/QO1234',
      'https://db5p.notify.windows.com/w/?token=BQ',
      'https://autopush.push.services.mozilla.com/wpush/v1/x',
    ]) {
      assert.equal(recusar(ok), null, `deveria aceitar: ${ok}`)
    }
  })

  test('o alvo do SSRF é recusado', () => {
    assert.equal(recusar('http://169.254.169.254/latest/meta-data/'), 'nao_https')
    assert.equal(recusar('https://169.254.169.254/latest/meta-data/'), 'host_nao_permitido')
    assert.equal(recusar('https://localhost:8000/x'), 'host_nao_permitido')
    assert.equal(recusar('https://attacker.example/coleta'), 'host_nao_permitido')
    assert.equal(recusar('http://fcm.googleapis.com/fcm/send/x'), 'nao_https')
  })

  test('DISFARCE: sufixo colado não passa por host permitido', () => {
    // O erro que uma checagem com `includes` ou `startsWith` comete.
    assert.equal(recusar('https://fcm.googleapis.com.evil.test/x'), 'host_nao_permitido')
    assert.equal(recusar('https://evil.test/fcm.googleapis.com/x'), 'host_nao_permitido')
    assert.equal(recusar('https://notfcm.googleapis.com/x'), 'host_nao_permitido')
  })

  test('DISFARCE: credenciais na URL', () => {
    // hostname aqui é evil.test, mas um humano lê "fcm.googleapis.com".
    assert.equal(recusar('https://fcm.googleapis.com@evil.test/x'), 'tem_credenciais')
  })

  test('DISFARCE: sufixo de domínio não vira curinga solto', () => {
    // `.notify.windows.com` é permitido como SUFIXO; `notify.windows.com.evil`
    // não termina nele.
    assert.equal(recusar('https://x.notify.windows.com.evil.test/'), 'host_nao_permitido')
    assert.equal(recusar('https://x.notify.windows.com/'), null)
  })

  test('entradas degeneradas', () => {
    assert.equal(recusar(''), 'vazio')
    assert.equal(recusar('   '), 'vazio')
    assert.equal(recusar(null), 'vazio')
    assert.equal(recusar(undefined), 'vazio')
    assert.equal(recusar(12345), 'vazio')
    assert.equal(recusar({}), 'vazio')
    assert.equal(recusar('nao-e-url'), 'nao_e_url')
    assert.equal(recusar('https://fcm.googleapis.com/' + 'a'.repeat(MAX_ENDPOINT_CHARS)), 'longo_demais')
  })

  test('endpointPushValido concorda com recusarEndpointPush', () => {
    assert.equal(valido('https://fcm.googleapis.com/fcm/send/a'), true)
    assert.equal(valido('https://attacker.example/'), false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('os dois caminhos do servidor usam a MESMA regra', () => {
  test('save-push-subscription importa e chama a função compartilhada', () => {
    assert.match(SAVE, /from\s+['"]\.\.\/_shared\/push-endpoint\.ts['"]/,
      'save-push-subscription precisa importar a regra compartilhada, não ter cópia própria')
    assert.match(SAVE, /recusarEndpointPush\s*\(|endpointPushValido\s*\(/,
      'importar não basta: precisa CHAMAR')
  })

  test('send-radar-push revalida na hora de disparar', () => {
    // Gravar validado não basta: a linha pode ter sido gravada antes desta regra
    // existir, ou por um caminho que ainda não conhecemos. Quem faz o fetch
    // confere de novo — é a última camada antes do pacote sair.
    assert.match(SEND, /from\s+['"]\.\.\/_shared\/push-endpoint\.ts['"]/,
      'send-radar-push precisa importar a mesma regra')
    assert.match(SEND, /recusarEndpointPush\s*\(|endpointPushValido\s*\(/,
      'importar não basta: precisa CHAMAR antes do envio')
  })

  test('a validação frouxa antiga não sobreviveu no save', () => {
    // A guarda original aceitava qualquer string não-vazia. Se ela continuar
    // sendo a ÚNICA checagem, o resto deste arquivo vira decoração.
    const soStringNaoVazia = /!endpoint\s*\|\|\s*typeof\s+endpoint\s*!==\s*['"]string['"]/.test(SAVE)
    assert.ok(
      !soStringNaoVazia || /recusarEndpointPush|endpointPushValido/.test(SAVE),
      'a checagem de "string não-vazia" só pode existir junto da validação de host')
  })
})
