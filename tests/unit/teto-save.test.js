/**
 * OS TETOS DE SAVE — os três limites que existiam sem chamador.
 *
 * Achado de 2026-08-14, corrigido em 2026-08-15. O banco tinha os limites
 * certos e eles nunca executavam: `salvar_dados_usuario()`,
 * `salvar_perfil_usuario()` e `verificar_rate_limit_escrita()` (5 MB por blob,
 * 120 escritas/h, registro em `fraud_logs`) não eram chamadas por lugar nenhum.
 * A prova não estava no código, estava no banco:
 *
 *     SELECT count(*) FROM rate_limit_writes   →   0 linhas desde sempre
 *
 * Contador zerado em tabela de contador é a assinatura de caminho morto.
 *
 * E o teto do proxy não cobria o buraco: `api/user-data.js` mede o CORPO da
 * requisição, mas o caminho por operações manda um delta pequeno que é APLICADO
 * SOBRE o blob guardado. Cada requisição é legítima; o que cresce é o destino.
 * 8 POST/min × ~4 MB chegava ao limite do jsonb (1 GB) em ~30 minutos.
 *
 * O QUE ESTE ARQUIVO PROTEGE:
 *   1. a decisão do teto, exercitada de verdade — inclusive a VÁLVULA, que é a
 *      diferença entre um teto e um tijolo;
 *   2. que a medida seja do RESULTADO (o único ponto por onde passam TANTO o
 *      estado inteiro QUANTO as operações);
 *   3. que o rate limit tenha chamador, e conte pela PESSOA;
 *   4. que 429 vire reenvio no cliente, e não perda de trabalho.
 *
 * Os itens 2–4 são sobre o fonte (dependem de Deno/window/rede), com o cuidado
 * que já custou caro aqui: comentário sai ANTES de casar, senão a prosa que
 * explica a regra faz o teste passar sozinha.
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

/** Recorta um bloco pelo DELIMITADOR, nunca por contagem de caracteres. */
function bloco(src, inicio, fim) {
  const i = src.indexOf(inicio)
  assert.ok(i !== -1, `não achei o início do bloco: ${inicio}`)
  const j = src.indexOf(fim, i)
  assert.ok(j > i, `não achei o fim do bloco: ${fim}`)
  return src.slice(i, j)
}

const EDGE_BRUTO = readFileSync(join(RAIZ, 'supabase/functions/save-user-data/index.ts'), 'utf8')
const EDGE = semComentarios(EDGE_BRUTO)
const DM = semComentarios(readFileSync(join(RAIZ, 'src/scripts/modules/data-manager.js'), 'utf8'))
const PROXY = semComentarios(readFileSync(join(RAIZ, 'api/user-data.js'), 'utf8'))

let decidirTeto, MAX_BLOB_BYTES
before(async () => {
  const ts = readFileSync(join(RAIZ, 'supabase/functions/_shared/teto-blob.ts'), 'utf8')
  const js = transformSync(ts, { loader: 'ts', format: 'esm' }).code
  const mod = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))
  decidirTeto = mod.decidirTeto
  MAX_BLOB_BYTES = mod.MAX_BLOB_BYTES
})

// ─────────────────────────────────────────────────────────────────────────────
describe('a decisão do teto — exercitada, não lida', () => {
  test('blob dentro do limite passa', () => {
    assert.equal(decidirTeto(1_000, null), 'ok')
    assert.equal(decidirTeto(MAX_BLOB_BYTES, 10), 'ok', 'o limite exato ainda cabe')
  })

  test('blob acima do limite é bloqueado', () => {
    assert.equal(decidirTeto(MAX_BLOB_BYTES + 1, 10), 'bloqueado')
  })

  test('VÁLVULA: acima do limite, mas encolhendo, passa', () => {
    // O caso que separa um teto de uma armadilha: o blob já estourou (por abuso,
    // bug ou import) e a pessoa apaga coisas para caber. Esse save chega ao
    // servidor acima do teto — e precisa passar, senão não existe ação capaz de
    // resolver e o usuário fica trancado do lado de fora dos próprios dados.
    assert.equal(decidirTeto(6_000_000, 8_000_000), 'encolhendo')
  })

  test('acima do limite e CRESCENDO é bloqueado, mesmo com blob anterior grande', () => {
    assert.equal(decidirTeto(9_000_000, 8_000_000), 'bloqueado')
    assert.equal(decidirTeto(8_000_000, 8_000_000), 'bloqueado', 'empate não é encolher')
  })

  test('tamanho anterior desconhecido bloqueia — não se deixa passar o que não se mede', () => {
    assert.equal(decidirTeto(6_000_000, null), 'bloqueado')
  })

  test('o limite é 5 MB e bate com o corpo aceito pelo proxy', () => {
    assert.equal(MAX_BLOB_BYTES, 5_242_880)
    assert.match(
      PROXY,
      /MAX_BODY_BYTES\s*=\s*5_242_880/,
      'o teto do proxy e o do resultado divergiram — um dos dois vira letra morta',
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('o teto mede o RESULTADO, no caminho de todos os saves', () => {
  test('a medida é do payload final já mesclado, não do corpo que chegou', () => {
    // `dataToSave` é montado DEPOIS do merge e DEPOIS das operações. Medir
    // `body.profiles` deixaria o caminho por operações inteiro de fora — que é
    // exatamente o buraco que este passo fechou.
    const trecho = bloco(EDGE, 'const dataToSave = {', 'const now = new Date()')
    assert.match(
      trecho,
      /const serializado = JSON\.stringify\(dataToSave\)/,
      'a medida deixou de ser do resultado',
    )
    // Ancorado no `if (` de propósito: casar só a substring deixaria passar um
    // `if (false && serializado.length > MAX_BLOB_BYTES)` — o teto desligado com
    // todas as palavras no lugar. Provado por mutação em 2026-08-15.
    assert.match(
      trecho,
      /\n\s*if \(serializado\.length > MAX_BLOB_BYTES\) \{/,
      'a condição do teto foi enfraquecida ou desligada',
    )
    assert.match(trecho, /decidirTeto\(serializado\.length, anterior\)/)
  })

  test('o bloqueio impede a gravação — recusa antes do UPDATE, não depois', () => {
    const i = EDGE.indexOf("code: 'BLOB_MUITO_GRANDE'")
    const j = EDGE.indexOf(".from('user_data')\n        .update(")
    assert.ok(i !== -1, 'o bloqueio de tamanho sumiu')
    assert.ok(j > i, 'o teto passou a rodar DEPOIS da gravação — não protege nada ali')
  })

  test('cifra o que foi medido — não serializa de novo por fora do teto', () => {
    assert.match(
      EDGE,
      /encryptData\(serializado,/,
      'voltou a serializar dentro do encrypt: a medida e o gravado podem divergir',
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('o rate limit de escritas ganhou chamador', () => {
  test('a edge chama verificar_rate_limit_escrita', () => {
    assert.match(
      EDGE,
      /\.rpc\('verificar_rate_limit_escrita',\s*\{\s*p_user_id:/,
      'a RPC voltou a não ter chamador — rate_limit_writes volta a zero linhas',
    )
  })

  test('conta pela PESSOA autenticada, não pela conta', () => {
    // Contar por `effectiveUserId` faria quatro pessoas de uma família dividirem
    // 120/h — e uma pessoa sozinha já mediu 33/h em uso pesado.
    const trecho = bloco(EDGE, "rpc('verificar_rate_limit_escrita'", 'if (rlErr)')
    assert.match(trecho, /p_user_id:\s*userId\s*\}/)
    assert.doesNotMatch(trecho, /effectiveUserId/)
  })

  test('estourar devolve 429 com código próprio', () => {
    const trecho = bloco(EDGE, 'if (rlErr)', 'let effectiveUserId')
    assert.match(trecho, /dentroDoLimite === false/)
    assert.match(trecho, /code:\s*'MUITAS_ESCRITAS'/)
    assert.match(trecho, /\}, 429, corsHeaders\)/)
  })

  test('erro da RPC não derruba o save (falha aberto, e de propósito)', () => {
    const trecho = bloco(EDGE, 'const { data: dentroDoLimite', 'let effectiveUserId')
    assert.match(trecho, /if \(rlErr\) \{\s*console\.error/)
    assert.doesNotMatch(
      bloco(trecho, 'if (rlErr)', 'else if'),
      /return json/,
      'passou a recusar o save quando o CONTADOR falha — troca abuso por perda de dado',
    )
  })

  test('roda antes de ler e decifrar o blob — o teto não paga o trabalho que recusa', () => {
    const rl = EDGE.indexOf("rpc('verificar_rate_limit_escrita'")
    const leitura = EDGE.indexOf(".select('user_id, data_json, last_modified')")
    assert.ok(rl !== -1 && leitura > rl, 'o rate limit foi parar depois da leitura do blob')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('429 vira reenvio, não perda de trabalho', () => {
  test('o cliente enfileira em 429 além dos 5xx', () => {
    const trecho = bloco(DM, 'if (!saveResp.ok) {', "document.dispatchEvent(new CustomEvent('ge:save-error'))")
    assert.match(
      trecho,
      /saveResp\.status >= 500 \|\| saveResp\.status === 429/,
      'o 429 voltou a cair no caminho de 4xx: o teto passa a custar o trabalho do usuário',
    )
    assert.match(trecho, /#enfileirar\(sombra, tocados\)/)
  })

  test('o reenvio recua — enfileirar em 429 não vira martelada', () => {
    const fila = readFileSync(join(RAIZ, 'src/scripts/modules/fila-save.js'), 'utf8')
    assert.match(fila, /RECUO_MS\s*=\s*\[/, 'o backoff da fila sumiu')
    assert.match(fila, /export function recuoMs/)
  })
})
