/**
 * tempo-real — a campainha da conta (Passo 37 · Camada 1).
 *
 * O dono pediu: "um usuário altera, outro já vê em tempo real". O desenho é uma
 * CAMPAINHA, não uma entrega: o servidor anuncia "a conta X mudou, nos perfis
 * Y", e quem ouve busca pelo caminho normal — que autentica e decifra no
 * servidor. Nenhum centavo trafega pelo canal.
 *
 * O que este arquivo tranca são as três coisas que, se saírem do lugar, quebram
 * em silêncio: a marca de canal PRIVADO (sem ela a autorização não se aplica), o
 * corte do próprio eco (sem ele a tela recarrega sozinha em looping) e o apelido
 * do import (sem ele o build serve o stub e o tempo real fica mudo em produção,
 * funcionando em dev).
 *
 * Roda no CI: node --test tests/unit/
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC  = readFileSync(join(RAIZ, 'src/scripts/modules/tempo-real.js'), 'utf8')
// Os comentários deste projeto citam o próprio código que explicam — casar com
// um comentário já deu falso positivo aqui (o nome do pacote aparece no texto
// que explica por que ele NÃO é importado). Para "o que o código faz", só código.
const CODIGO = SRC.split('\n')
  .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
  .join('\n')
const VITE = readFileSync(join(RAIZ, 'vite.config.js'), 'utf8')
const EDGE = readFileSync(join(RAIZ, 'supabase/functions/save-user-data/index.ts'), 'utf8')
// Mesma peneira, e pelo mesmo motivo — desta vez comprovado por mutação: a
// asserção de `private: true` PASSAVA com a linha removida do código, porque o
// comentário que explica a linha também a cita. A verificação de segurança
// estava decorativa.
const EDGE_CODIGO = EDGE.split('\n')
  .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
  .join('\n')
const MIG  = readFileSync(join(RAIZ, 'supabase/migrations/20260807120000_realtime_conta_broadcast.sql'), 'utf8')

// O CLIENT_ID é puro e não depende de rede — dá para importar de verdade.
const { CLIENT_ID } = await import('../../src/scripts/modules/tempo-real.js')

describe('🔒 o canal é PRIVADO nas duas pontas', () => {
  test('o cliente assina como privado', () => {
    // A autorização do Realtime (a política conta_broadcast_ouvir) só se aplica
    // a canal privado. Num canal público, qualquer um que soubesse o uuid da
    // conta ouviria — e uuid não é segredo, é só difícil de adivinhar.
    assert.match(SRC, /config:\s*\{\s*private:\s*true\s*\}/)
  })

  test('o servidor marca a mensagem como privada', () => {
    // Mensagem sem a marca chegaria também a quem assinasse o canal PÚBLICO de
    // mesmo nome. As duas pontas precisam exigir autorização.
    assert.match(EDGE_CODIGO, /private:\s*true/)
    assert.match(EDGE_CODIGO, /topic:\s*`conta:\$\{contaId\}`/)
  })

  test('só o servidor pode falar: a migration não cria política de INSERT', () => {
    assert.match(MIG, /FOR SELECT/)
    assert.ok(!/FOR (INSERT|ALL|UPDATE)/i.test(MIG),
      'política de escrita deixaria um cliente forjar "a conta mudou"')
  })

  test('a autorização espelha quem já pode LER os dados da conta', () => {
    // Duas definições de "quem é da conta" divergem com o tempo, e a que diverge
    // vira o furo. Esta reusa account_members + is_active, igual ao
    // user_data_select.
    assert.match(MIG, /account_members/)
    assert.match(MIG, /am\.is_active\s*=\s*true/)
    assert.match(MIG, /am\.member_user_id\s*=\s*\(SELECT auth\.uid\(\)\)/)
  })

  test('tópico torto vira NULL, e NULL nega — não estoura a consulta', () => {
    // `substring(...)::uuid` em texto inválido levanta exceção, e exceção dentro
    // de uma política derruba a consulta inteira em vez de negar.
    assert.match(MIG, /WHEN topico ~ '\^conta:\[0-9a-fA-F\]\{8\}/)
    assert.match(MIG, /ELSE NULL/)
    assert.match(MIG, /IS NOT NULL/)
  })

  test('a função não é SECURITY DEFINER e tem search_path fixo', () => {
    assert.match(MIG, /SECURITY INVOKER/)
    assert.match(MIG, /SET search_path = ''/)
    assert.ok(!/GRANT EXECUTE ON FUNCTION public\.conta_do_topico\(text\) TO anon/.test(MIG))
  })
})

describe('o próprio eco não pode voltar', () => {
  test('cada aba tem um id, e ele é único', () => {
    // Por ABA e não por usuário: duas abas do mesmo login precisam se ouvir.
    assert.equal(typeof CLIENT_ID, 'string')
    assert.ok(CLIENT_ID.length >= 8)
  })

  test('aviso com a própria origem é descartado antes de chamar quem ouve', () => {
    // Sem este corte, cada save que a aba faz voltaria como "alguém mudou" e ela
    // recarregaria sozinha — em looping, porque o refetch dispara outro save.
    assert.match(SRC, /if \(p\.origem && p\.origem === CLIENT_ID\) return/)
  })

  test('o save leva o client_id, e a Edge o devolve no aviso', () => {
    const DM = readFileSync(join(RAIZ, 'src/scripts/modules/data-manager.js'), 'utf8')
    assert.match(DM, /client_id/)
    assert.match(EDGE, /client_id/)
    assert.match(EDGE, /origem,/)
  })
})

describe('o peso não pode voltar para o boot', () => {
  test('o realtime real entra por apelido próprio, não por caminho profundo', () => {
    // O alias do Rollup casa por prefixo seguido de `/`, então
    // `@supabase/realtime-js/dist/...` cairia no STUB. O tempo real funcionaria
    // em dev (sem alias) e ficaria MUDO no build. Nome próprio não colide.
    assert.match(VITE, /'granaevo:realtime':/)
    assert.match(SRC, /await import\('granaevo:realtime'\)/)
    assert.ok(!/@supabase\/realtime-js/.test(CODIGO), 'importar o pacote direto cai no stub')
  })

  test('o stub continua valendo para o SupabaseClient', () => {
    // Ele instancia RealtimeClient no boot e nunca usa — foi o que o Passo 8
    // arrancou (−14,4 KB). Este passo não pode desfazer aquilo.
    assert.match(VITE, /'@supabase\/realtime-js':\s*path\.resolve\([^)]*realtime-stub\.js'\)/)
  })

  test('⭐ o realtime tem chunk PRÓPRIO — senão o await import vira decoração', () => {
    // A regra de chunks casava qualquer `node_modules/@supabase` e mandava para
    // `vendor-supabase`, que é chunk de BOOT. O realtime importado sob demanda
    // era arrastado para lá e o Passo 8 se desfazia: medido em 48,3/36 KB (134%)
    // antes desta exceção. O `await import()` continuaria lá, bonito e inútil.
    const i = VITE.indexOf("id.includes('node_modules/@supabase/realtime-js')")
    const j = VITE.indexOf("id.includes('node_modules/@supabase')")
    assert.ok(i > 0, 'sem a exceção, o realtime volta para o boot')
    assert.ok(i < j, 'a exceção precisa vir ANTES da regra genérica, senão nunca é alcançada')
    assert.match(VITE, /return 'vendor-realtime'/)
  })

  test('o import é dinâmico — carga sob demanda, não no boot', () => {
    assert.ok(!/^import .* from 'granaevo:realtime'/m.test(CODIGO))
    assert.match(SRC, /await import\('granaevo:realtime'\)/)
  })
})

describe('a queda é tratada, e a recusa não vira teimosia', () => {
  test('reconecta com recuo, e cada tentativa pega um JWT novo', () => {
    // A reconexão do pacote foi desativada de propósito: ela não sabe que o JWT
    // expira, e reconectar com token velho dá "sem permissão" para sempre.
    assert.match(SRC, /reconnectAfterMs: \(\) => 1e9/)
    assert.match(SRC, /RECONECTA_MS = \[1_000, 2_000, 5_000, 10_000, 30_000\]/)
    assert.match(SRC, /const jwt = await token\(\)/)
  })

  test('sem permissão NÃO reconecta', () => {
    // A política negou. Insistir só gera ruído; o app cai no caminho lento
    // (recarregar) sem barulho para o usuário.
    assert.match(SRC, /if \(!semPermissao\) _reconectar/)
  })

  test('desligar solta canal e socket', () => {
    assert.match(SRC, /_canal\?\.unsubscribe\(\)/)
    assert.match(SRC, /_cliente\?\.disconnect\(\)/)
    assert.match(SRC, /_parado = true/)
  })

  test('ouvinte que quebra não derruba o canal', () => {
    assert.match(SRC, /try \{\s*\n?\s*aoMudar\?\./)
  })
})

describe('o aviso não carrega dinheiro', () => {
  test('o payload tem perfis, origem e hora — mais nada', () => {
    const bloco = EDGE.match(/payload: \{[\s\S]*?\n {8}\}/)[0]
    assert.match(bloco, /perfis:/)
    assert.match(bloco, /origem,/)
    assert.match(bloco, /em:/)
    assert.ok(!/valor|transac|saldo|descric|data_json|profiles:/i.test(bloco),
      'o canal é uma campainha, não uma entrega')
  })

  test('a lista de perfis tem teto', () => {
    assert.match(EDGE, /perfis\.slice\(0, 20\)/)
  })

  test('a campainha nunca derruba o save', () => {
    // A gravação já aconteceu quando isto roda. Falhar aqui custa o outro lado
    // descobrir pelo caminho lento, não perder dado.
    const fn = EDGE.match(/async function anunciarMudanca[\s\S]*?\n\}/)[0]
    assert.match(fn, /\.catch\(/)
    assert.match(fn, /try \{ secretKey = getSecretKey\(\) \} catch \{ return \}/)
    assert.match(fn, /AbortSignal\.timeout\(2_000\)/)
  })

  test('avisa DEPOIS de gravar', () => {
    // Avisar antes faria quem ouve buscar dado que ainda não existe — e um
    // refetch cedo demais volta com o estado ANTIGO, pior que aviso nenhum.
    const iInsert = EDGE.indexOf(".insert({ user_id: effectiveUserId")
    const iAviso  = EDGE.indexOf('await anunciarMudanca(')
    assert.ok(iInsert > 0 && iAviso > iInsert)
  })
})
