/**
 * 37.1b — a fase de sombra: as operações viajam, o servidor ignora.
 *
 * O ganho não é funcional, é de confiança. O cliente aplica o próprio diff sobre
 * o retrato e confere que o resultado é idêntico ao estado atual. Se bater
 * sempre, em produção, com dados reais, então a derivação está certa — e só aí
 * o servidor passa a aplicar operações em vez de substituir tudo.
 *
 * Ligar o servidor direto seria apostar que o diff está certo num caminho que
 * grava todo o dinheiro do app.
 *
 * O data-manager depende de `window` e de rede, então aqui a verificação é sobre
 * o CÓDIGO (ordem e condições) mais uma simulação do autoteste com o mesmo par
 * de funções que ele usa. Roda no CI: node --test tests/unit/
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { diffColecao, aplicarOperacoes, comEndereco, diffCampos, aplicarCampos } from '../../src/scripts/modules/diff-registros.js'
import { serializarEstavel, carimbarNovos, COLECOES } from '../../src/scripts/modules/registro-id.js'

/** O "resto" do perfil — tudo que não é coleção. Espelha `#restoDoPerfil`. */
const resto = (p) => {
  const out = {}
  for (const k of Object.keys(p || {})) if (!COLECOES.includes(k)) out[k] = p[k]
  return out
}

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DM = readFileSync(join(RAIZ, 'src/scripts/modules/data-manager.js'), 'utf8')

const tx = (id, over = {}) => ({
  id, categoria: 'saida', tipo: 'Mercado', descricao: 'Feira',
  valor: 50, data: '07/08/2026', hora: '10:00:00', metaId: null, ...over,
})

/**
 * O PERFIL INTEIRO reconstruído a partir das operações — coleções e campos
 * juntos, na mesma ordem que o data-manager usa. É a verificação que importa:
 * cada metade pode estar certa sozinha e o conjunto ainda não fechar.
 */
const batePerfil = (antes, depois) => {
  const refeito = aplicarCampos(resto(antes), diffCampos(antes, depois, COLECOES))
  for (const col of COLECOES) {
    const d = diffColecao(antes[col], depois[col])
    if (d.ok !== true) return { ok: false, motivo: `${col}:${d.motivo}` }
    if (col in depois) refeito[col] = aplicarOperacoes(antes[col] || [], d)
  }
  return { ok: serializarEstavel(refeito) === serializarEstavel(depois) }
}

/** O autoteste, exatamente como o data-manager o faz. */
const bate = (antes, depois) => {
  const d = diffColecao(antes, depois)
  if (d.ok !== true) return { ok: false, motivo: d.motivo }
  const refeito = aplicarOperacoes(antes || [], d)
  return {
    ok: serializarEstavel(refeito) === serializarEstavel(depois || []),
    n: d.ops.length,
  }
}

describe('o autoteste bate nos caminhos reais do app', () => {
  const casos = {
    'lançar uma transação (push)':       [[tx('a')], [tx('a'), tx('b')]],
    'lançar duas seguidas':              [[tx('a')], [tx('a'), tx('b'), tx('c')]],
    'excluir uma do meio':               [[tx('a'), tx('b'), tx('c')], [tx('a'), tx('c')]],
    'editar valor':                      [[tx('a')], [tx('a', { valor: 999 })]],
    'desfazer exclusão (splice no meio)': [[tx('a'), tx('c')], [tx('a'), tx('b'), tx('c')]],
    'importar extrato (vários no fim)':  [[tx('a')], [tx('a'), tx('i1'), tx('i2'), tx('i3')]],
    'primeiro save da conta':            [[], [tx('a'), tx('b')]],
    'sessão sem mexer em nada':          [[tx('a')], [tx('a')]],
  }
  for (const [nome, [antes, depois]] of Object.entries(casos)) {
    test(nome, () => assert.equal(bate(antes, depois).ok, true, nome))
  }

  test('e o diff é MUITO menor que o estado — é o ponto do passo', () => {
    const antes = Array.from({ length: 800 }, (_, i) => tx(`t${i}`))
    const depois = [...antes, tx('novo')]
    const r = bate(antes, depois)
    assert.equal(r.ok, true)
    assert.equal(r.n, 1, '800 transações no estado, 1 operação no diff')
  })
})

describe('o autoteste RECLAMA quando não deveria confiar', () => {
  test('transação sem id derruba a derivação daquele perfil', () => {
    // Depois do 37.0 isso não deveria acontecer — se acontecer, é sinal de um
    // ponto de criação novo que escapou do carimbo, e a sombra vai contar.
    const r = bate([tx('a')], [tx('a'), { valor: 5, descricao: 'sem id' }])
    assert.equal(r.ok, false)
    assert.equal(r.motivo, 'sem_id')
  })

  test('reordenação é o caso conhecido em que a reconstrução diverge', () => {
    // Não é recusa do diff (ele diz "nada mudou"); é o autoteste percebendo que
    // aplicar esse "nada" não reproduz o estado. É exatamente o que a sombra
    // existe para medir em produção.
    const d = diffColecao([tx('a'), tx('b')], [tx('b'), tx('a')])
    assert.equal(d.ok, true)
    assert.equal(d.ops.length, 0)
    assert.equal(bate([tx('a'), tx('b')], [tx('b'), tx('a')]).ok, false)
  })

  test('a rede de ids do 37.0 é o que mantém a sombra confiável', () => {
    // Com o carimbo, o mesmo cenário que falhava passa a bater.
    const perfil = { id: 'p1', transacoes: [tx('a'), { valor: 5, descricao: 'nova' }] }
    carimbarNovos([perfil])
    assert.equal(bate([tx('a')], perfil.transacoes).ok, true)
  })
})

describe('37.1c — todas as coleções, não só transações', () => {
  test('o laço percorre COLECOES, e não uma lista escrita à mão', () => {
    // Escrever os nomes aqui deixaria uma coleção nova (uma futura `reservas`,
    // por exemplo) fora do diff em silêncio — que é o modo de falhar deste passo
    // inteiro: nada quebra, o dado de outra aba só some.
    const fn = DM.match(/#derivarOperacoes\([\s\S]*?\n {4}\}/)[0]
    assert.match(fn, /for \(const col of COLECOES\)/)
    assert.match(fn, /diffColecao\(base\[col\], p\?\.\[col\]\)/)
    assert.match(fn, /comEndereco\(d\.ops, id, col\)/)
    assert.match(DM, /import \{[^}]*COLECOES[^}]*\} from '\.\/registro-id\.js/)
  })

  test('o motivo diz QUAL coleção falhou', () => {
    // "sem_id" sozinho não ajuda em nada: o conserto é num ponto de criação
    // específico, e saber se foi em metas ou em cartões é metade do trabalho.
    const fn = DM.match(/#derivarOperacoes\([\s\S]*?\n {4}\}/)[0]
    assert.match(fn, /motivos\.add\(`\$\{col\}:\$\{d\.motivo\}`\)/)
    assert.match(fn, /motivos\.add\(`\$\{col\}:reconstrucao_divergente`\)/)
  })

  test('cada coleção derivada isoladamente reconstrói o estado', () => {
    const antes = {
      transacoes: [tx('t1')],
      metas: [{ id: 'm1', descricao: 'Viagem', saved: 100, monthly: { '2026-08': 100 } }],
      cartoesCredito: [{ id: 'c1', nomeBanco: 'Nu', limite: 1000, usado: 0 }],
      contasFixas: [{ id: 'f1', descricao: 'Luz', valor: 180, compras: [] }],
      assinaturas: [{ id: 'a1', nome: 'Netflix', valor: 40, ativa: true }],
    }
    const depois = {
      transacoes: [tx('t1'), tx('t2')],
      metas: [{ id: 'm1', descricao: 'Viagem', saved: 150, monthly: { '2026-08': 150 } }],
      cartoesCredito: [],
      contasFixas: [{ id: 'f1', descricao: 'Luz', valor: 180, compras: [{ id: 'cp1', valorParcela: 90 }] }],
      assinaturas: [{ id: 'a1', nome: 'Netflix', valor: 40, ativa: true }, { id: 'a2', nome: 'Spotify' }],
    }
    for (const col of Object.keys(antes)) {
      assert.equal(bate(antes[col], depois[col]).ok, true, col)
    }
  })
})

describe('carimbos: campo que muda a cada save não pode virar conflito', () => {
  // MEDIDO EM PRODUÇÃO (?opsdebug=1, 2026-08-07): todo save trazia exatamente um
  // `set` a mais, mesmo sem o usuário ter mexido em nada. Era o `lastUpdate`,
  // que o dashboard reescreve com `new Date().toISOString()` em toda montagem
  // do perfil — e que NINGUÉM lê.
  test('lastUpdate fica fora das operações', () => {
    assert.match(DM, /const CARIMBOS = \['lastUpdate'\]/)
    assert.match(DM, /const FORA_DAS_OPS = \[\.\.\.COLECOES, \.\.\.CARIMBOS\]/)
    assert.match(DM, /diffCampos\(base, p, FORA_DAS_OPS\)/)
    assert.match(DM, /if \(!FORA_DAS_OPS\.includes\(k\)\) out\[k\] = p\[k\]/)
  })

  test('sem isso, TODA gravação simultânea colidiria no 37.3', () => {
    // A demonstração do porquê: dois perfis idênticos, salvos em instantes
    // diferentes, divergem só no carimbo.
    const a = { id: 'p1', name: 'Lucas', lastUpdate: '2026-08-07T09:00:00.000Z' }
    const b = { id: 'p1', name: 'Lucas', lastUpdate: '2026-08-07T09:00:01.000Z' }
    assert.equal(diffCampos(a, b, COLECOES).ops.length, 1, 'com o carimbo: um set por save')
    assert.equal(diffCampos(a, b, [...COLECOES, 'lastUpdate']).ops.length, 0, 'sem ele: nenhuma')
  })

  test('e o carimbo não engole mudança de verdade', () => {
    const a = { id: 'p1', name: 'Lucas', lastUpdate: '2026-08-07T09:00:00.000Z' }
    const b = { id: 'p1', name: 'Outro', lastUpdate: '2026-08-07T09:00:01.000Z' }
    assert.deepEqual(diffCampos(a, b, [...COLECOES, 'lastUpdate']).ops,
      [{ op: 'set', k: 'name', v: 'Outro' }])
  })

  test('o contrato com o 37.2a está escrito onde vai ser lido', () => {
    // Quando o servidor aplicar só operações, ELE precisa carimbar o
    // lastUpdate — senão o campo congela. Inofensivo hoje (ninguém lê), mas
    // seria uma mentira gravada.
    assert.match(DM, /Contrato com o 37\.2a[\s\S]{0,200}carimba o `lastUpdate`/)
  })
})

describe('37.1c — o que as operações de coleção NÃO descrevem', () => {
  test('mudar só o nome do perfil não gera operação de COLEÇÃO nenhuma', () => {
    // Se o servidor aplicasse só as operações de coleção, o perfil renomeado
    // voltaria ao nome antigo. É o buraco que o 37.1d fecha com `set`.
    const antes = { id: 'p1', name: 'Lucas', transacoes: [tx('a')] }
    const depois = { id: 'p1', name: 'Lucas Oliveira', transacoes: [tx('a')] }
    assert.equal(bate(antes.transacoes, depois.transacoes).n, 0)
    assert.notEqual(serializarEstavel(resto(antes)), serializarEstavel(resto(depois)))
    // …e aí a operação de campo aparece.
    assert.deepEqual(diffCampos(antes, depois, COLECOES).ops,
      [{ op: 'set', k: 'name', v: 'Lucas Oliveira' }])
  })

  test('orçamentos e conquistas caem no resto — são mapas, não listas', () => {
    // A chave já é a identidade neles, então não entram em COLECOES.
    const antes = { id: 'p1', orcamentos: { Mercado: { limite: 600 } }, conquistas: { desbloqueadas: [] } }
    const depois = { id: 'p1', orcamentos: { Mercado: { limite: 800 } }, conquistas: { desbloqueadas: [] } }
    assert.notEqual(serializarEstavel(resto(antes)), serializarEstavel(resto(depois)))
    assert.ok(!COLECOES.includes('orcamentos'))
    assert.ok(!COLECOES.includes('conquistas'))
  })

  test('mexer só nas coleções deixa o resto idêntico', () => {
    const antes = { id: 'p1', name: 'Lucas', transacoes: [tx('a')] }
    const depois = { id: 'p1', name: 'Lucas', transacoes: [tx('a'), tx('b')] }
    assert.equal(serializarEstavel(resto(antes)), serializarEstavel(resto(depois)))
  })

  test('o PERFIL INTEIRO é reconstruído pelas operações — coleções e campos juntos', () => {
    // Cada metade pode estar certa sozinha e o conjunto ainda não fechar. Este
    // é o invariante que o 37.2a vai depender: aplicar as operações no servidor
    // tem de dar exatamente o perfil que o cliente tem na tela.
    const base = {
      id: 'p1', name: 'Lucas', config: { tema: 'escuro' },
      orcamentos: { Mercado: { limite: 600 } },
      transacoes: [tx('t1')],
      metas: [{ id: 'm1', descricao: 'Viagem', saved: 100 }],
      contasFixas: [{ id: 'f1', descricao: 'Luz', valor: 180 }],
    }
    const casos = {
      'só lançou':            { ...base, transacoes: [tx('t1'), tx('t2')] },
      'só renomeou':          { ...base, name: 'Lucas O.' },
      'lançou E renomeou':    { ...base, name: 'Lucas O.', transacoes: [tx('t1'), tx('t2')] },
      'guardou na reserva':   { ...base, transacoes: [tx('t1'), tx('t2')], metas: [{ id: 'm1', descricao: 'Viagem', saved: 150 }] },
      'mudou orçamento':      { ...base, orcamentos: { Mercado: { limite: 800 } } },
      'apagou o orçamento':   (() => { const c = { ...base }; delete c.orcamentos; return c })(),
      'pagou conta fixa':     { ...base, transacoes: [tx('t1'), tx('t2')], contasFixas: [{ id: 'f1', descricao: 'Luz', valor: 180, pago: true }] },
      'perfil novo do zero':  base,
      'não mexeu em nada':    base,
    }
    for (const [nome, depois] of Object.entries(casos)) {
      const antes = nome === 'perfil novo do zero' ? { id: 'p1' } : base
      assert.equal(batePerfil(antes, depois).ok, true, nome)
    }
  })

  test('o data-manager deriva os campos e confere a reconstrução', () => {
    // Em 37.1c isto era só uma COMPARAÇÃO que marcava incompleto. Com o 37.1d
    // virou derivação de verdade: `set`/`unset` por chave, com o mesmo autoteste
    // das coleções. O que não pode voltar é o perfil renomeado sair sem operação.
    const fn = DM.match(/#derivarOperacoes\([\s\S]*?\n {4}\}/)[0]
    assert.match(fn, /diffCampos\(base, p, FORA_DAS_OPS\)/)
    assert.match(fn, /aplicarCampos\(this\.#restoDoPerfil\(base\), dc\)/)
    assert.match(fn, /motivos\.add\('perfil:reconstrucao_divergente'\)/)
    assert.match(fn, /comEndereco\(dc\.ops, id, null\)/)
  })
})

describe('como o data-manager liga isso — ordem e condições', () => {
  test('a sombra é derivada DEPOIS de saber quem foi tocado', () => {
    const i = DM.indexOf('this.#perfisTocados(safeProfiles)')
    const j = DM.indexOf('this.#derivarOperacoes(safeProfiles, tocados)')
    assert.ok(i > 0 && j > i, 'derivar precisa do conjunto de tocados')
  })

  test('as três chaves viajam juntas — a sombra virou sincronização real', () => {
    // A fase de sombra ACABOU em 2026-08-07, depois de a Edge ser deployada como
    // no-op e o dono confirmar em produção que lançar, recarregar e excluir
    // seguiam normais (a prova do 37.2d: cliente antigo × Edge nova).
    assert.match(DM, /profile_ops:\s*sombra\.ops/)
    assert.match(DM, /ops_completo:\s*sombra\.completo/)
    assert.match(DM, /ops_aplicar:\s*true/)
  })

  test('o interruptor mora no CLIENTE, e é uma linha', () => {
    // Desligar tem de ser um deploy do front (rápido, reversível pela Vercel),
    // não um redeploy da Edge no meio de um incidente. Se algum dia o valor
    // virar condicional, que seja de propósito — e não por acidente de merge.
    // São DOIS payloads desde o 37.4 (o save normal e o reenvio da fila), e os
    // dois declaram a mesma coisa. O que não pode voltar é o valor virar
    // CONDICIONAL: aí o interruptor deixa de ser um interruptor.
    const linhas = DM.match(/^\s*ops_aplicar:.*$/gm)
    assert.ok(linhas.length >= 1 && linhas.length <= 2, `esperava 1 ou 2, veio ${linhas.length}`)
    for (const l of linhas) assert.match(l, /ops_aplicar:\s*true,\s*$/)
  })

  test('quem decide se PODE aplicar continua sendo o servidor', () => {
    // `ops_aplicar` diz "eu sei sincronizar por operação", não "pode aplicar".
    // A Edge exige `ops_completo` por conta própria — um cliente adulterado que
    // mandasse só `ops_aplicar` não ganha nada.
    const EDGE = readFileSync(join(RAIZ, 'supabase/functions/save-user-data/index.ts'), 'utf8')
    assert.match(EDGE, /ops_aplicar\s*===\s*true\s*&&\s*\n?\s*\(body as any\)\?\.ops_completo\s*===\s*true/)
  })

  test('o save do UNLOAD não pede operações — e isso é intencional', () => {
    // Ele não deriva a sombra (não há tempo, e o payload tem teto de 60 KB no
    // keepalive). Sem `ops_aplicar`, a Edge usa o merge por perfil, que é
    // correto — só mais grosso.
    const IMEDIATO = DM.slice(DM.indexOf('async saveImmediate('), DM.indexOf('async saveImmediate(') + 2500)
    assert.ok(!/ops_aplicar/.test(IMEDIATO))
    assert.match(IMEDIATO, /touched_profile_ids/)
  })

  test('a sombra NUNCA pode ser o motivo de um save falhar', () => {
    // Conta grande: o 1º save da sessão descreve todas as transações, e o
    // payload passa a carregar o estado E as operações. Se estourar o teto, a
    // sombra sai e o save segue como sempre foi.
    const i = DM.indexOf('serialized.length > MAX_PAYLOAD_BYTES && dataToSave.profile_ops.length > 0')
    const j = DM.indexOf('delete dataToSave.profile_ops')
    assert.ok(i > 0 && j > i, 'falta a válvula de escape do payload')
  })

  test('divergência é relatada UMA vez por sessão, sem id de perfil', () => {
    // Um defeito sistemático relataria a cada save e viraria enxurrada no
    // Sentry. E o que sobe é motivo + contagem: nada do dinheiro do usuário.
    const fn = DM.match(/#derivarOperacoes\([\s\S]*?\n {4}\}/)[0]
    assert.match(fn, /#opsAvisado = true/)
    assert.match(fn, /captureError\(/)
    const ctx = fn.match(/captureError\([\s\S]*?\}\);/)[0]
    assert.ok(!/perfil_id|profileId|\bid\b\s*:/.test(ctx), 'contexto não pode levar id de perfil')
    assert.ok(!/valor|descricao|transacoes\[/.test(ctx), 'contexto não pode levar dado financeiro')
  })

  test('o diagnóstico da sombra é ligável em PRODUÇÃO, por ?opsdebug=1', () => {
    // A pergunta que o 37.2a precisa responder — "as operações descrevem o save
    // inteiro, com dados REAIS e legados?" — não tem resposta em localhost: lá
    // os dados são novos e já nasceram com id.
    assert.match(DM, /opsdebug'\) === '1'/)
    assert.match(DM, /if \(IS_DEV \|\| OPS_DEBUG\)/)
  })

  test('em produção o canal é ATRIBUIÇÃO, não console.log', () => {
    // O build roda terser com `drop_console: true`: toda chamada a console.*
    // some do bundle. Um log aqui não seria "difícil de achar" — ele não existe
    // no arquivo que roda. Já custou duas instruções erradas ao dono.
    const VITE = readFileSync(join(RAIZ, 'vite.config.js'), 'utf8')
    assert.match(VITE, /drop_console:\s*true/, 'se isto mudar, o raciocínio abaixo muda')

    const bloco = DM.match(/if \(OPS_DEBUG\) \{[\s\S]*?\n {12}\}/)[0]
    assert.match(bloco, /window\.__sombra\.push\(/)
    assert.ok(!/console\./.test(bloco), 'console.* não sobrevive ao build de produção')
  })

  test('o console.log fica só no dev, onde ele existe', () => {
    const log = DM.match(/if \(IS_DEV\) \{\s*console\.log\([\s\S]*?\n {12}\}/)
    assert.ok(log, 'o log de dev continua útil em localhost')
  })

  test('o diagnóstico registra CONTAGEM, nunca o conteúdo', () => {
    // É o dinheiro do usuário num objeto que ele vai abrir no console e me
    // mandar por print. Contagem por tipo responde a pergunta; valor, não.
    const bloco = DM.match(/if \(IS_DEV \|\| OPS_DEBUG\) \{[\s\S]*?\n {8}\}/)[0]
    assert.match(bloco, /porTipo\[o\.op\] = \(porTipo\[o\.op\] \|\| 0\) \+ 1/)
    assert.ok(!/o\.r\b|o\.v\b|JSON\.stringify\(ops/.test(bloco),
      'não pode registrar registro nem valor de campo')
  })

  test('o acumulador tem teto — diagnóstico não vira vazamento de memória', () => {
    const bloco = DM.match(/if \(OPS_DEBUG\) \{[\s\S]*?\n {12}\}/)[0]
    assert.match(bloco, /__sombra\.length < 20/)
  })

  test('telemetria quebrada não derruba o save', () => {
    const fn = DM.match(/#derivarOperacoes\([\s\S]*?\n {4}\}/)[0]
    assert.match(fn, /captureError[\s\S]*?\} catch \{/)
  })
})

describe('⭐ save que não tem nada a dizer não é enviado', () => {
  // O dashboard salva a cada 30 SEGUNDOS, incondicionalmente
  // (dashboard.js, iniciarAutoSave). Uma aba parada mandava a visão dela do
  // mundo — de 30 segundos atrás — por cima do que a outra aba acabou de gravar.
  //
  // Era a máquina do Lost Update: não bastava lançar nas duas abas ao mesmo
  // tempo; bastava DEIXAR uma aberta. E reaparecia a cada meio minuto, sempre.
  test('o gatilho existe mesmo: auto-save periódico incondicional', () => {
    const DASH = readFileSync(join(RAIZ, 'src/scripts/pages/dashboard.js'), 'utf8')
    const i = DASH.indexOf('autoSaveInterval = setInterval(')
    assert.ok(i > 0, 'o auto-save periódico sumiu — este teste perdeu o sentido')
    const corpo = DASH.slice(i, i + 1200)
    assert.match(corpo, /30_000/)
    assert.match(corpo, /salvarDados\(\)/)
  })

  test('zero operações num save completo = não envia', () => {
    const fn = DM.slice(DM.indexOf('#derivarOperacoes(safeProfiles, tocados)'))
    assert.match(fn, /if \(sombra\.completo && sombra\.ops\.length === 0\)/)
  })

  // O trecho do "pular", delimitado por TEXTO e não por indentação: asserção
  // presa a espaços já reprovou aqui só porque um comentário mudou de linha.
  const PULAR = (() => {
    const i = DM.indexOf('if (sombra.completo && sombra.ops.length === 0)')
    return i > 0 ? DM.slice(i, DM.indexOf('const dataToSave', i)) : ''
  })()

  test('a guarda exige `completo` — sem ele, pular seria perder dado', () => {
    // Zero operações num save INCOMPLETO não quer dizer "não mexi em nada":
    // quer dizer "não consegui descrever o que mexi". Pular aí perderia a
    // edição do usuário em silêncio.
    assert.ok(PULAR, 'o bloco do "pular" sumiu')
    assert.match(PULAR, /sombra\.completo &&/)
    assert.match(PULAR, /return true;/)
  })

  test('pular avisa a UI que terminou — senão fica girando "salvando"', () => {
    assert.match(PULAR, /ge:save-done/)
    assert.match(PULAR, /#lastSaveTime = new Date\(\)/)
  })

  test('o servidor devolve o desfecho, e o diagnóstico registra', () => {
    const EDGE = readFileSync(join(RAIZ, 'supabase/functions/save-user-data/index.ts'), 'utf8')
    assert.match(EDGE, /ops: \{ via: viaOperacoes, motivo: opsMotivo \}/)
    assert.match(DM, /ultima\.servidor =/)
    // Diagnóstico, não contrato: nada do dinheiro do usuário volta no corpo.
    assert.ok(!/profiles: profilesFinais[\s\S]{0,80}success: true/.test(EDGE))
  })
})

describe('o save do unload também declara o que tocou', () => {
  // Só o corpo de saveImmediate — asserção sobre o arquivo inteiro passaria por
  // causa do saveUserData, que é outro caminho.
  const IMEDIATO = DM.slice(DM.indexOf('async saveImmediate('), DM.indexOf('async saveImmediate(') + 2500)

  test('manda touched_profile_ids — sem ele a Edge substitui TUDO', () => {
    // Para a Edge, corpo sem `touched_profile_ids` significa "substitua tudo"
    // (compatibilidade com clientes antigos). Este caminho mandava só
    // `{profiles}`: fechar a aba desligava o merge por perfil e sobrescrevia o
    // trabalho dos outros membros da conta.
    assert.match(IMEDIATO, /touched_profile_ids:\s*this\.#perfisTocados\(profilesData\)/)
  })

  test('e carimba os ids ANTES de serializar', () => {
    const i = IMEDIATO.indexOf('carimbarNovos(profilesData)')
    const j = IMEDIATO.indexOf('JSON.stringify({')
    assert.ok(i > 0, 'o save do unload precisa carimbar ids como o save normal')
    assert.ok(j > i, 'carimbar depois de serializar não carimba nada')
  })

  test('a Edge realmente trata ausência como "substitua tudo"', () => {
    // A asserção acima só vale por causa desta. Se a Edge mudar de regra, o
    // teste de cima deixa de ser sobre o que importa.
    const EDGE = readFileSync(join(RAIZ, 'supabase/functions/save-user-data/index.ts'), 'utf8')
    assert.match(EDGE, /COMPAT[ÍI]VEL PARA TR[ÁA]S/)
    assert.match(EDGE, /let profilesFinais = profiles/)
  })
})

describe('⭐ o diagnóstico diz QUAIS campos, e nunca o valor deles', () => {
  // Acrescentado em 2026-08-09: o dono rodou o `?opsdebug=1` e viu `set: 5` com
  // o dashboard PARADO. A contagem sozinha não separa rotina (carimbo,
  // saneamento) de dado velho voltando — que é como o Lost Update se parece por
  // dentro. O nome da chave separa na hora.
  const DM = readFileSync(join(RAIZ, 'src/scripts/modules/data-manager.js'), 'utf8')
  const BLOCO = DM.slice(DM.indexOf('if (OPS_DEBUG) {'), DM.indexOf('if (IS_DEV) {'))

  test('registra a lista de campos', () => {
    assert.match(BLOCO, /campos: campos\.join\(', '\)/)
    assert.match(BLOCO, /\.map\(\(o\) => o\.k\)/)
  })

  test('⭐ NUNCA registra o valor — em prod isso é o dinheiro do usuário', () => {
    // `o.v` carrega saldo, meta, orçamento. Este array é lido no console de uma
    // pessoa real, e o mesmo cuidado do radar e dos logs vale aqui.
    assert.ok(!/o\.v\b/.test(BLOCO), 'o valor da operação não pode entrar no diagnóstico')
    assert.ok(!/JSON\.stringify\(ops/.test(BLOCO), 'despejar `ops` inteiro levaria os valores junto')
  })

  test('só sai com ?opsdebug=1 — nunca por padrão', () => {
    assert.match(DM, /const OPS_DEBUG = \(\(\) => \{/)
    assert.match(DM, /get\('opsdebug'\) === '1'/)
  })
})
