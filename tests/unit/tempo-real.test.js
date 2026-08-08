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
// ⚠️ REGRA DESTE ARQUIVO: asserção sobre COMPORTAMENTO olha só o código.
//
// Os comentários deste projeto citam o próprio código que explicam, e isso
// produziu TRÊS falsos positivos numa só sessão — todos verificados por mutação:
//   · o nome do pacote aparecia no texto que explica por que ele NÃO é importado;
//   · `private: true` (uma verificação de SEGURANÇA) passava com a linha removida;
//   · `atualizarTudo()` aparece duas vezes na função — uma no código, uma no
//     comentário — e a mutação que apagava a chamada passava batido.
//
// Quando um teste destes passa, ele tem de ter olhado CÓDIGO.
const soCodigo = (txt) => txt.split('\n')
  .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
  .join('\n')

const CODIGO = soCodigo(SRC)
const VITE = readFileSync(join(RAIZ, 'vite.config.js'), 'utf8')
const EDGE = readFileSync(join(RAIZ, 'supabase/functions/save-user-data/index.ts'), 'utf8')
const EDGE_CODIGO = soCodigo(EDGE)
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
    assert.match(SRC, /if \(p\.origem && p\.origem === CLIENT_ID\) \{[^}]*return; \}/)
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

describe('⭐ o token precisa estar aplicado ANTES de entrar no canal', () => {
  test('setAuth é aguardado', () => {
    // `setAuth` é async no realtime-js 2.104.1 (`async setAuth(token = null)`).
    // Sem o await, o canal entrava antes do token ser aplicado — e canal PRIVADO
    // sem token é recusado pela autorização. O sintoma é o pior possível:
    // nenhum erro, nenhum aviso, a campainha simplesmente nunca toca.
    assert.match(CODIGO, /await _cliente\.setAuth\(jwt\)/)
    const iAuth  = CODIGO.indexOf('await _cliente.setAuth(jwt)')
    const iCanal = CODIGO.indexOf('_cliente.channel(')
    assert.ok(iAuth > 0 && iCanal > iAuth, 'o canal só pode ser criado depois do token')
  })

  test('e o pacote recebe um callback de token para as reconexões', () => {
    // Fixar um JWT só serve para a primeira conexão: ao reconectar com token
    // expirado, canal privado é recusado — e recusa não se resolve insistindo.
    assert.match(CODIGO, /accessToken: async \(\) => \(await token\(\)\) \?\? null/)
  })
})

describe('o diagnóstico existe, porque isto falha calado', () => {
  test('estado e motivo vão para um global — console não sobrevive ao build', () => {
    // Canal recusado, token não aplicado, aviso filtrado: nenhum aparece na
    // tela, e `drop_console: true` apaga todo console.* do bundle.
    assert.match(CODIGO, /window\.__tempoReal/)
    assert.match(CODIGO, /_diag\('estado', 'sem_token'\)/)
    assert.match(CODIGO, /_diag\('estado', semPermissao \? 'sem_permissao'/)
  })

  test('o return silencioso do dashboard deixa rastro', () => {
    // "Nada acontece, sem erro e sem log" começa pelo GATILHO — e um `return`
    // sem rastro é o suspeito nº 1. Já custou caro neste projeto.
    const DASH = readFileSync(join(RAIZ, 'src/scripts/pages/dashboard.js'), 'utf8')
    assert.match(DASH, /estado: 'sem_conta_no_load'/)
    assert.match(DASH, /estado: 'erro_ao_ligar'/)
    // O filtro por perfil mudou de casa junto com a lógica (teto de bundle).
    // Asserta a CONDIÇÃO, não a mensagem: trocar o `if` por `if (false)` deixaria
    // a string intacta num ramo morto, e o teste passaria com o filtro desligado.
    assert.match(CODIGO, /if \(aviso\.perfis\.length && meu && !aviso\.perfis\.includes\(meu\)\)/)
    assert.match(CODIGO, /ignorado: outro perfil/)
  })

  test('o diagnóstico não carrega dado do usuário', () => {
    // Conta aparece truncada; o resto é estado, contagem e motivo.
    assert.match(CODIGO, /String\(conta\)\.slice\(0, 8\)/)
    assert.ok(!/_diag\('[a-z]+', (p\.perfis|msg|jwt)\)/.test(CODIGO))
  })
})

describe('⭐ receber o aviso não é o fim — a tela precisa repintar', () => {
  const DASH = soCodigo(readFileSync(join(RAIZ, 'src/scripts/pages/dashboard.js'), 'utf8'))
  // O `recarregar` que a página entrega ao módulo. Só ele ficou aqui: o filtro
  // por perfil, o adiamento e o diagnóstico foram para tempo-real.js quando o
  // teto de bundle do dashboard estourou (40,0/40 reprovou o build da Vercel).
  const APLICAR = (() => {
    const i = DASH.indexOf('recarregar:  async (aviso) =>')
    return i > 0 ? DASH.slice(i, DASH.indexOf('\n        });', i)) : ''
  })()

  test('depois de recarregar, chama atualizarTudo()', () => {
    // `carregarDadosPerfil` NÃO repinta: enche os arrays e termina em
    // `atualizarReferenciasGlobais()`. Foi escrito para o boot e para a troca de
    // perfil, onde QUEM CHAMA renderiza depois. Chamado sozinho, atualizava a
    // memória e deixava a tela parada — o dado só aparecia no próximo F5.
    // Diagnosticado em produção: estado 'ligado', avisos 1, ultimo 'aplicando',
    // e nada na tela.
    assert.ok(APLICAR, 'o callback `recarregar` sumiu do dashboard')
    assert.match(APLICAR, /await carregarDadosPerfil\(perfilAtivo\.id\)/)
    assert.match(APLICAR, /atualizarTudo\(\)/)
    const i = APLICAR.indexOf('carregarDadosPerfil')
    const j = APLICAR.indexOf('atualizarTudo()')
    assert.ok(j > i, 'repintar antes de carregar não mostra nada de novo')
  })

  test('e `atualizarTudo` é mesmo quem repinta a lista de movimentações', () => {
    // Se um dia isto mudar, o tempo real para de aparecer na tela de Transações
    // sem nenhum erro — exatamente o sintoma que custou esta rodada.
    const fn = DASH.match(/function atualizarTudo\(\) \{[\s\S]*?\n\}/)[0]
    assert.match(fn, /_dbTransacoes\?\.atualizarMovimentacoesUI\?\.\(\)/)
  })

  test('save em voo pousa antes de recarregar', () => {
    // Recarregar no meio de um POST traz o estado de ANTES dele: a tela
    // mostraria o dado recém-gravado como se não existisse.
    assert.match(APLICAR, /if \(_saveEmVoo\)/)
    const i = APLICAR.indexOf('_saveEmVoo')
    const j = APLICAR.indexOf('carregarDadosPerfil')
    assert.ok(i < j)
  })

  test('formulário aberto adia, não descarta — a lógica mora no módulo', () => {
    // Trocar os arrays embaixo de quem está digitando apaga o que a pessoa
    // escreveu: a mesma perda que este passo veio consertar, vinda de dentro.
    assert.match(CODIGO, /if \(ocupado\?\.\(\)\) \{ _pendente = true;/)
    assert.match(CODIGO, /reaplicarPendente: \(\) => \{ if \(_pendente\) aplicar\(\); \}/)
    // A página só diz QUANDO está ocupada e reaplica ao fechar o formulário.
    assert.match(DASH, /ocupado:\s+\(\) => !!\(document\.getElementById\('modalOverlay'\)/)
    assert.match(DASH, /if \(_tempoRealReaplicar\) setTimeout\(_tempoRealReaplicar, 350\)/)
  })
})

describe('Camada 2 — o chat também escuta, e a aba que volta não confia no canal', () => {
  const CHAT = soCodigo(readFileSync(join(RAIZ, 'src/scripts/pages/assistente.js'), 'utf8'))
  const ENGINE = soCodigo(readFileSync(join(RAIZ, 'src/scripts/modules/assistant/engine.js'), 'utf8'))

  test('o chat liga a campainha', () => {
    // Antes só o dashboard escutava: quem lançava lá e olhava o chat continuava
    // vendo o estado velho — e o PRÓXIMO comando do chat partiria dele.
    // A CHAMADA, não o nome: `ligarTempoRealChat` aparece também na definição,
    // e assertar o nome deixava passar a mutação que removia a chamada do boot.
    assert.match(CHAT, /^\s+ligarTempoRealChat\(\);$/m)
    assert.match(CHAT, /await import\('\.\.\/modules\/tempo-real\.js\?v=1'\)/)
    assert.match(CHAT, /SUPABASE_URL, apikey: SUPABASE_ANON_KEY/)
    assert.match(CHAT, /import \{[^}]*SUPABASE_URL[^}]*\} from '\.\.\/services\/supabase-client\.js/)
  })

  test('o engine expõe refresh() — antes eu assumi um que não existia', () => {
    assert.match(ENGINE, /async refresh\(\) \{[\s\S]{0,80}this\.#reload\(\)/)
    assert.match(CHAT, /recarregar:\s+\(\) => assistant\.refresh\(\)/)
  })

  test('`activeProfileId` é lido como GETTER, não chamado', () => {
    // Chamá-lo (`activeProfileId()`) daria TypeError no primeiro aviso — e o
    // catch do canal engoliria, deixando o chat mudo sem explicação.
    assert.match(CHAT, /String\(assistant\.activeProfileId \?\? ''\)/)
    assert.ok(!/activeProfileId\?\.\(\)|activeProfileId\(\)/.test(CHAT))
    assert.match(ENGINE, /get activeProfileId\(\)/)
  })

  test('o chat não adia: não há formulário que se perca ali', () => {
    assert.match(CHAT, /ocupado:\s+\(\) => false/)
  })

  test('⭐ ao voltar para a aba: religa se caiu, e recarrega de qualquer forma', () => {
    // Navegador suspende websocket em aba de fundo e nem sempre avisa. Quem
    // volta a uma aba parada há uma hora não pode confiar que a campainha
    // continuou tocando.
    assert.match(CODIGO, /visibilityState !== 'visible' \|\| _parado\) return/)
    assert.match(CODIGO, /if \(!ligado\(\)\) \{/)
    assert.match(CODIGO, /_diag\('estado', 'religando'\)/)
    // O refetch acontece DEPOIS do religamento e fora dele: mesmo com o canal
    // de pé, a aba pode ter perdido avisos enquanto estava suspensa.
    // Delimitado até o `return` da função: `indexOf('});')` casava com o
    // `.catch(() => {})` do religamento e cortava o bloco antes do refetch.
    const i = CODIGO.indexOf("visibilityState !== 'visible'")
    const bloco = CODIGO.slice(i, CODIGO.indexOf('return { reaplicarPendente', i))
    const iReligar = bloco.indexOf("_diag('estado', 'religando')")
    const iAplicar = bloco.lastIndexOf('aplicar();')
    assert.ok(iReligar > 0 && iAplicar > iReligar,
      'recarregar precisa acontecer também quando o canal está de pé')
  })

  test('o listener de visibilidade é registrado UMA vez', () => {
    // `ligarNaTela` roda de novo a cada religamento; sem a trava, cada queda
    // somaria um listener e o refetch viraria enxurrada.
    assert.match(CODIGO, /if \(typeof document !== 'undefined' && !_ouvindoVisibilidade\)/)
    assert.match(CODIGO, /_ouvindoVisibilidade = true/)
  })
})

describe('Camada 3 — a tela mudou sozinha, e o usuário fica sabendo', () => {
  const DASH3 = soCodigo(readFileSync(join(RAIZ, 'src/scripts/pages/dashboard.js'), 'utf8'))

  test('mudança remota acende o indicador', () => {
    // Números mudando sem sinal nenhum faz o usuário desconfiar do app — ou
    // pior, achar que ele mesmo digitou errado.
    assert.match(DASH3, /_setSyncState\('sincronizado'\)/)
    assert.match(DASH3, /state === 'sincronizado' \? '↻ Atualizado'/)
    assert.match(DASH3, /state === 'saved' \|\| state === 'error' \|\| state === 'sincronizado'/)
  })

  test('só acende depois do boot — o save inicial não conta como novidade', () => {
    const fn = DASH3.match(/function _avisarSincronizado\(aviso\) \{[\s\S]*?\n\}/)[0]
    assert.match(fn, /if \(_syncReadyForDisplay\) _setSyncState/)
  })

  test('⭐ o nome de quem mudou sai do que já está em memória', () => {
    // Nada novo trafega pelo canal: o aviso já carrega os ids dos perfis
    // tocados, e o nome está em `_allProfilesData`. Mandar nome pelo websocket
    // seria dado do usuário viajando à toa.
    const fn = DASH3.match(/function _avisarSincronizado\(aviso\) \{[\s\S]*?\n\}/)[0]
    assert.match(fn, /_allProfilesData/)
    assert.match(fn, /p\?\.nome \|\| p\?\.name/)
    // E o canal continua carregando só id, nunca nome.
    const bloco = EDGE_CODIGO.match(/payload: \{[\s\S]*?\n {8}\}/)[0]
    assert.ok(!/nome|name|email/i.test(bloco))
  })

  test('não avisa quando foi você mesmo em outra aba', () => {
    // O aviso chega igual (não é o próprio eco — é outra aba). Mas dizer
    // "Fulano atualizou" quando o Fulano é você seria mentira.
    const fn = DASH3.match(/function _avisarSincronizado\(aviso\) \{[\s\S]*?\n\}/)[0]
    assert.match(fn, /filter\(\(id\) => id !== meu\)/)
    assert.match(fn, /if \(!outros\.length\) return;/)
  })

  test('o aviso chega até a tela — o caminho inteiro passa o objeto', () => {
    assert.match(CODIGO, /const aplicar = \(aviso\) =>/)
    assert.match(CODIGO, /Promise\.resolve\(recarregar\(aviso\)\)/)
    assert.match(CODIGO, /aplicar\(aviso\);/)
    assert.match(DASH3, /recarregar:\s+async \(aviso\) =>/)
    assert.match(DASH3, /_avisarSincronizado\(aviso\);/)
  })

})

describe('🔒 PRESENÇA — o cliente ganhou voz, mas só para dizer "estou aqui"', () => {
  const MIG_P = readFileSync(join(RAIZ, 'supabase/migrations/20260807140000_realtime_presenca.sql'), 'utf8')

  test('⭐ a escrita é liberada SÓ para presence — broadcast continua trancado', () => {
    // É a linha que separa "posso dizer que estou aqui" de "posso dizer que a
    // conta mudou". Sem ela, esta política daria ao cliente a boca da campainha,
    // e qualquer membro poderia forjar um aviso de mudança.
    const insert = MIG_P.match(/CREATE POLICY "conta_presenca_entrar"[\s\S]*?\);/)[0]
    assert.match(insert, /FOR INSERT/)
    assert.match(insert, /WITH CHECK \(\s*\n\s*extension = 'presence'/)
    assert.ok(!/broadcast/.test(insert), 'INSERT nunca pode alcançar broadcast')
  })

  test('a leitura passou a incluir presence, e só isso mudou nela', () => {
    const sel = MIG_P.match(/CREATE POLICY "conta_broadcast_ouvir"[\s\S]*?\);/)[0]
    assert.match(sel, /extension IN \('broadcast', 'presence'\)/)
    // A regra de QUEM continua a mesma: dono ou membro ativo.
    assert.match(sel, /am\.is_active\s*=\s*true/)
  })

  test('⭐ o canal carrega só o ID do perfil — nome nunca trafega', () => {
    // O conteúdo da presença é escrito pelo CLIENTE. Mandar nome seria confiar
    // em texto livre de terceiro; um membro adulterado só consegue afirmar ser
    // outro perfil da PRÓPRIA conta, que ele já enxerga.
    assert.match(CODIGO, /_canal\.track\(\{ p: meu\.slice\(0, 64\) \}\)/)
    assert.ok(!/track\(\{[^}]*(nome|name|email)/i.test(CODIGO))
  })

  test('o que chega é validado por tipo e tamanho', () => {
    assert.match(CODIGO, /typeof m\?\.p === 'string' && m\.p\) ids\.add\(m\.p\.slice\(0, 64\)\)/)
  })

  test('estado malformado vira lista vazia, não erro', () => {
    const bloco = CODIGO.match(/_canal\.on\('presence'[\s\S]*?\n {4}\}/)[0]
    assert.match(bloco, /catch \{/)
  })

  test('track acontece DEPOIS de entrar no canal', () => {
    // Antes do SUBSCRIBED não há canal para escrever.
    const i = CODIGO.indexOf("_diag('estado', 'ligado')")
    const j = CODIGO.indexOf('_canal.track(')
    assert.ok(i > 0 && j > i)
  })

  test('a tela não interpreta o que veio como HTML', () => {
    // Vale mesmo com o id vindo de um membro adulterado: `textContent` nunca
    // executa nada, e o nome sai do que já está em memória.
    const DASHP = soCodigo(readFileSync(join(RAIZ, 'src/scripts/pages/dashboard.js'), 'utf8'))
    const fn = DASHP.match(/function _renderPresenca\(ids\) \{[\s\S]*?\n\}/)[0]
    assert.match(fn, /el\.textContent =/)
    assert.ok(!/innerHTML|insertAdjacentHTML/.test(fn))
    assert.match(fn, /_allProfilesData/)
  })

  test('não conta você mesmo como "online"', () => {
    const DASHP = soCodigo(readFileSync(join(RAIZ, 'src/scripts/pages/dashboard.js'), 'utf8'))
    const fn = DASHP.match(/function _renderPresenca\(ids\) \{[\s\S]*?\n\}/)[0]
    assert.match(fn, /filter\(\(id\) => id !== meu\)/)
  })

  test('⚠️ o indicador de sync era interface MORTA — agora tem CSS', () => {
    // Ele existia no HTML desde sempre, o JS escrevia nele ("✓ Salvo") e não
    // havia UMA linha de CSS, nem no fonte nem no bundle. Ninguém nunca viu.
    // Descoberto ao procurar onde estilizar o "↻ Atualizado".
    const CSS = readFileSync(join(RAIZ, 'src/styles/dashboard/_db-features.css'), 'utf8')
    assert.match(CSS, /\.sync-indicator-desktop \{/)
    assert.match(CSS, /\.sync-indicator-desktop\[data-state\] \{ display: block; \}/)
    assert.match(CSS, /\.presenca-conta\[data-online\] \{ display: flex; \}/)
    // Confirmação, não alerta: nunca rouba clique.
    assert.match(CSS, /pointer-events: none/)
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
