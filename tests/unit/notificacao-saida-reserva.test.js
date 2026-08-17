/**
 * "FULANO SAIU DA RESERVA" — o aviso para quem FICOU.
 *
 * Sem ele, o outro membro vê o saldo da reserva cair sozinho e não sabe por quê.
 * Saldo mudando na tela sem explicação é exatamente o que faz a pessoa
 * desconfiar do app — ou pior, achar que ela mesma errou.
 *
 * ⚠️ O QUE ESTE ARQUIVO MAIS PROTEGE É O NOME NÃO VIR DO CLIENTE.
 * O texto vai para a caixa de entrada de OUTRA pessoa e, via push, para a tela
 * de bloqueio do celular dela. Se o cliente pudesse mandar a string, qualquer
 * membro da conta teria um canal para escrever o que quisesse na notificação
 * alheia. O cliente manda só o `perfil_id`; o servidor lê o nome em `profiles`.
 *
 * Roda no CI: node --test tests/unit/
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

// Asserção sobre fonte tem de olhar CÓDIGO: os comentários deste projeto citam
// o próprio código que explicam, e isso já produziu falso positivo aqui.
const soCodigo = (txt) => txt.split('\n')
  .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
  .join('\n')

const EDGE   = soCodigo(readFileSync(join(RAIZ, 'supabase/functions/notify-reserve-invite/index.ts'), 'utf8'))
const PROXY  = soCodigo(readFileSync(join(RAIZ, 'api/user-data.js'), 'utf8'))
const CLIENT = soCodigo(readFileSync(join(RAIZ, 'src/scripts/pages/db-metas.js'), 'utf8'))

// ═════════════════════════════════════════════════════════════════════════════
describe('🔒 o nome de quem saiu vem do BANCO, não do cliente', () => {
  test('⭐ a Edge lê `profiles.name` conferindo que o perfil é da conta', () => {
    // `.eq('user_id', ownerId)` é o que impede um perfil de OUTRA conta ser
    // usado para escrever numa notificação alheia.
    assert.match(EDGE, /\.from\('profiles'\)/)
    assert.match(EDGE, /\.select\('name'\)/)
    assert.match(EDGE, /\.eq\('id', perfilId\)/)
    assert.match(EDGE, /\.eq\('user_id', ownerId\)/,
      'sem casar pelo dono, um perfil de outra conta entraria no texto')
  })

  test('⭐ o cliente NÃO manda o nome de quem saiu', () => {
    // Se um dia alguém "facilitar" mandando o nome pronto, o canal de injeção
    // volta a existir. O cliente só pode falar o id do próprio perfil.
    assert.match(CLIENT, /perfil_id: _ctx\.perfilAtivo\?\.id/)
    assert.ok(!/nome_perfil|perfil_nome|nomeQuemSaiu/.test(CLIENT),
      'o cliente voltou a mandar o nome — o texto da notificação alheia ficou nas mãos dele')
  })

  test('o nome do banco é limitado e sem caractere de controle', () => {
    // `clamp` troca controle/quebra de linha por espaço e corta o tamanho —
    // nome comprido ou com \n quebraria o payload do push.
    assert.match(EDGE, /nomeQuemSaiu = clamp\(perfil\?\.name, 40\) \|\| 'Alguem'/)
  })

  test('perfil de outra conta (ou inexistente) vira o genérico, não erro', () => {
    // `maybeSingle` devolve null; o `||` cobre. Falhar aqui derrubaria a saída
    // da reserva por causa de um aviso, que é best-effort por definição.
    assert.match(EDGE, /\.maybeSingle\(\)/)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('o proxy valida antes de repassar', () => {
  test('⭐ `evento` é lista fechada — qualquer outro valor vira convite', () => {
    assert.match(PROXY, /parsed\?\.evento === 'saida' \? 'saida' : 'convite'/)
  })

  test('⭐ `perfil_id` só passa se for inteiro', () => {
    assert.match(PROXY, /\^\\d\{1,12\}\$/,
      'perfil_id sem validação de formato chegaria cru à consulta da Edge')
    assert.match(PROXY, /evento === 'saida' && perfilId === null/,
      'saída sem perfil_id precisa ser recusada — senão o aviso sai sem dono')
  })

  test('continua na MESMA rota (a 13ª função na Vercel congela a produção)', () => {
    assert.match(PROXY, /action === 'reserve-invite-notify'/)
    const fs = readFileSync(join(RAIZ, 'vercel.json'), 'utf8')
    assert.ok(fs.length > 0)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('o aviso é gravado de um jeito que o banco aceita', () => {
  // As CHECKs de radar_notifications (conferidas em produção): tipo numa lista
  // fechada, title <= 80, body <= 200, dedupe_key <= 120, url num formato.
  test('⭐ `tipo` usa um valor que a CHECK da tabela permite', () => {
    assert.match(EDGE, /tipo:\s*'saida_reserva'/,
      'tipo fora da CHECK faria o INSERT falhar e o aviso nunca existir')
  })

  test('title/body/dedupe respeitam os limites da tabela', () => {
    assert.match(EDGE, /title:\s*'Saida de reserva compartilhada'/)
    assert.ok('Saida de reserva compartilhada'.length <= 80)
    assert.match(EDGE, /\.slice\(0, 200\)/)
    assert.match(EDGE, /\.slice\(0, 120\)/)
  })

  test('a url é a mesma âncora do convite (dois avisos, um destino)', () => {
    // Já foi corrigido uma vez (migration 20260815260000): apontar para lugar
    // diferente do convite fazia o clique não levar a nada útil.
    const ocorrencias = EDGE.match(/'\/dashboard#reservas'/g) ?? []
    assert.ok(ocorrencias.length >= 2, 'a saída aponta para âncora diferente do convite')
  })

  test('⭐ o dedupe da SAÍDA inclui o dia — sair de novo avisa de novo', () => {
    // Sair, voltar e sair outra vez é um evento novo. Chave sem data faria o
    // segundo aviso ser engolido pelo ON CONFLICT para sempre.
    assert.match(EDGE, /`saida:\$\{reservaId\}:\$\{perfilId\}:\$\{dia\}:\$\{uid\}`/)
  })

  test('nunca vai R$ no payload (regra do Radar)', () => {
    const corpoSaida = /body:\s*`\$\{nomeQuemSaiu\} saiu da reserva[^`]*`/.exec(EDGE)?.[0] ?? ''
    assert.ok(corpoSaida.length > 0, 'o corpo do aviso de saída mudou de forma')
    assert.ok(!/R\$|valor:|\$\{valor/.test(corpoSaida),
      'entrou dinheiro no texto da notificação — a regra do Radar proíbe')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('quando o aviso dispara', () => {
  test('⭐ dispara ao sair, e só se ainda houver alguém para avisar', () => {
    assert.match(CLIENT, /if \(!r\.ultimo\) _notificarReserva\('saida', meta\.id, meta\.descricao\)/,
      'o último membro não tem a quem avisar — e avisar a si mesmo é ruído')
  })

  test('o convite continua funcionando pelo mesmo caminho', () => {
    assert.match(CLIENT, /_notificarConviteReserva = \(id, nome\) => _notificarReserva\('convite', id, nome\)/)
    assert.match(EDGE, /body\.evento === 'saida' \? 'saida' : 'convite'/,
      'cliente antigo (sem `evento`) precisa continuar caindo em convite')
  })

  test('é best-effort: falhar no aviso não pode derrubar a saída', () => {
    // ⚠️ Delimitado por BLOCO, não por janela de N caracteres: `{0,900}` reprova
    // sozinho no dia em que a função engordar, e é lento sob carga (o arquivo
    // tem milhares de linhas). Recorta-se a função e olha-se dentro dela.
    const inicio = CLIENT.indexOf('async function _notificarReserva')
    assert.ok(inicio !== -1, 'a função de aviso mudou de nome')
    const fim = CLIENT.indexOf('\n}', inicio)
    const corpo = CLIENT.slice(inicio, fim === -1 ? undefined : fim)
    assert.match(corpo, /catch \{/,
      'sem catch, um push que falha derruba a saída da reserva — que já mexeu no dinheiro')
  })
})
