/**
 * RESERVA COMPARTILHADA — DE PONTA A PONTA, DOIS PERFIS, UM BLOB.
 *
 * ⚠️ POR QUE ESTE ARQUIVO EXISTE, E POR QUE ELE É GRANDE.
 *
 * O defeito que ele trava não aparece em teste de unidade nenhum: cada peça
 * estava certa sozinha. `reserva-familia.js` unia trilhas corretamente,
 * `diff-registros.js` derivava operações corretas, `aplicar-operacoes.ts`
 * aplicava-as corretamente. O dinheiro sumia na COSTURA entre elas — e três
 * sessões de depuração passaram por cima disso olhando peça por peça.
 *
 * O QUE ACONTECIA (medido por esta simulação, com os módulos de verdade):
 *
 *   1. A guarda R$100  → slot A {100, trilha:[A:100]}
 *   2. B guarda R$100  → db-metas PROPAGAVA a visão de B para o slot de A
 *                      → o delta save manda {op:'edit', r: <registro inteiro>}
 *                      → o servidor SUBSTITUI o registro de A
 *                      → slot A {100, trilha:[B:100]}   ← os 100 de A morreram
 *
 * Não era corrida de escrita simultânea: bastava um dos dois não ter
 * recarregado. E o mesmo mecanismo derrubava o "Quem colocou", que lê a trilha.
 *
 * A CORREÇÃO (2026-08-17): ninguém escreve no slot de outro perfil. Cada um
 * escreve o seu; as trilhas se unem por `mid` e o saldo é derivado delas.
 *
 * O teste roda o caminho REAL: sanitização do allowlist do dashboard, retrato do
 * data-manager, derivação de operações, aplicação no servidor, merge por perfil
 * e o filtro do tempo real. Se alguém reintroduzir a escrita cruzada, ou tirar
 * os convidados da relevância do tempo real, ele cai aqui.
 */
import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transformSync } from 'esbuild'

import * as R from '../../src/scripts/modules/reserva-familia.js'
import { diffColecao, diffCampos, comEndereco, aplicarOperacoes as aplicarNoCliente }
  from '../../src/scripts/modules/diff-registros.js'
import { serializarEstavel } from '../../src/scripts/modules/registro-id.js'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

let validarOperacoes, aplicarOperacoes, mergeProfiles
before(async () => {
  const carregar = async (rel) => {
    const ts = readFileSync(join(RAIZ, rel), 'utf8')
    const js = transformSync(ts, { loader: 'ts', format: 'esm' }).code
    return import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))
  }
  ;({ validarOperacoes, aplicarOperacoes } = await carregar('supabase/functions/_shared/aplicar-operacoes.ts'))
  ;({ mergeProfiles } = await carregar('supabase/functions/_shared/merge-profiles.ts'))
})

// ═══════════════════════════════════════════════════════════════════════════
// O ARREDOR — espelha o caminho real de gravação, sem DOM e sem rede.
// ═══════════════════════════════════════════════════════════════════════════
const COLECOES = ['transacoes', 'metas', 'cartoesCredito', 'contasFixas', 'assinaturas']
const FORA_DAS_OPS = [...COLECOES, 'lastUpdate']

// dashboard.js · _ALLOWED_KEYS.meta — o que de fato chega ao banco. Está aqui de
// propósito: já houve campo de reserva gravado pela tela e DESCARTADO no save.
const META_KEYS = ['id', 'descricao', 'objetivo', 'saved', 'monthly', 'historicoRetiradas',
  'prazo', 'tipoRendimento', 'taxaJuros', 'cdiPct', 'rendimentoPeriodo', 'aporteRecorrente',
  'valorAporte', 'lastRendimento', 'compartilhada', 'membros', 'movimentos', 'convites',
  'saiu', 'lastUpdate', 'tipoReserva', 'origemExistente']

const clone = (x) => JSON.parse(JSON.stringify(x))
const sanitizeMeta = (m) => {
  const o = {}
  for (const k of META_KEYS) if (Object.prototype.hasOwnProperty.call(m, k) && m[k] !== undefined) o[k] = m[k]
  return o
}

function novoServidor() {
  return {
    profiles: [],
    ouvintes: [],
    opsRecebidas: [],
    // A campainha do app é um websocket: o aviso chega DEPOIS que o POST pousou,
    // e `_recarregarDoServidor` ainda espera `_saveEmVoo` antes de refazer o
    // load. Entregar dentro do `salvar()` criaria uma reentrância que o app não
    // tem — e o cliente terminaria o save carimbando um retrato velho.
    pendentes: [],
    entregando: false,
    entregar() {
      if (this.entregando) return
      this.entregando = true
      try {
        while (this.pendentes.length) {
          const aviso = this.pendentes.shift()
          for (const o of this.ouvintes) o(aviso)
        }
      } finally { this.entregando = false }
    },
    salvar({ profiles, touched, ops, opsCompleto, opsSomente, clientId }) {
      // Guarda QUEM mandou cada operação: o aviso de tempo real dispara uma
      // cascata (o outro cliente recarrega e salva), e sem a autoria a
      // verificação da invariante confundiria "B salvou" com "A escreveu em B".
      for (const o of (ops ?? [])) this.opsRecebidas.push({ de: clientId, op: o })
      let finais = profiles
      let via = false
      if (Array.isArray(ops) && opsCompleto && this.profiles.length) {
        const idsG = new Set(this.profiles.map(p => String(p?.id)))
        const idsC = new Set(profiles.map(p => String(p?.id)))
        const mesmoConjunto = opsSomente ||
          (idsG.size === idsC.size && [...idsG].every(id => idsC.has(id)))
        if (mesmoConjunto) {
          const v = validarOperacoes(ops)
          if (v.ok) {
            const r = aplicarOperacoes(this.profiles, v.valor)
            if (r.ok) { finais = r.valor.profiles; via = true }
          }
        }
      }
      if (opsSomente && !via) return { ok: false, code: 'OPS_NAO_APLICADAS' }
      if (!via && touched && this.profiles.length) {
        finais = mergeProfiles(this.profiles, profiles, touched).profiles
      }
      this.profiles = clone(finais)
      const perfis = touched ?? finais.map(p => String(p?.id))
      this.pendentes.push({ perfis, origem: clientId })
      return { ok: true }
    },
    reserva(perfilId, rid) {
      const p = this.profiles.find(x => String(x.id) === String(perfilId))
      return (p?.metas ?? []).find(m => String(m.id) === String(rid)) ?? null
    },
  }
}

/** Uma aba aberta num perfil: dashboard.js + data-manager.js + db-metas.js. */
class Aba {
  constructor(servidor, perfilId, nome) {
    this.s = servidor
    this.perfilId = String(perfilId)
    this.nome = nome
    this.clientId = 'aba_' + nome
    this.allProfiles = []
    this.metas = []
    this.retrato = new Map()
    this.recargas = 0
    this.ultimoAviso = null
    servidor.ouvintes.push((aviso) => this.aoMudar(aviso))
  }

  // tempo-real.js · aoMudar + dashboard.js · _perfisComReservaComigo
  aoMudar(aviso) {
    if (aviso.origem === this.clientId) return
    const relevantes = new Set([this.perfilId])
    for (const m of this.metas) {
      if (m?.compartilhada !== true || m.saiu === true) continue
      for (const lista of [m.membros, m.convites]) {
        if (Array.isArray(lista)) for (const id of lista) relevantes.add(String(id))
      }
    }
    if (aviso.perfis.length && !aviso.perfis.some(id => relevantes.has(String(id)))) {
      this.ultimoAviso = 'ignorado'
      return
    }
    this.ultimoAviso = 'aplicado'
    this.recargas++
    this.carregar()
    this.render()
  }

  // dashboard.js · carregarDadosPerfil (+ _sincronizarReservasCompartilhadas)
  carregar() {
    const profiles = clone(this.s.profiles)
    if (profiles.length > 0) this.allProfiles = profiles
    const meu = this.allProfiles.find(p => String(p.id) === this.perfilId)
    this.metas = Array.isArray(meu?.metas) ? meu.metas : []      // alias, como no app
    this.retrato = new Map(this.allProfiles.map(p => [String(p.id), JSON.stringify(p)]))
    this._reconciliar()
  }

  _reconciliar() {
    let mudou = false
    for (const m of this.metas) {
      if (m?.compartilhada === true &&
          R.reconciliarCopiaAtiva(m, this.allProfiles, this.perfilId)) mudou = true
    }
    if (mudou) this.salvar()
    return mudou
  }

  // db-metas.js · renderMetasList
  render() {
    this._reconciliar()
    let virouRecibo = false
    for (const m of this.metas) {
      if (m?.compartilhada !== true || m.saiu === true || !Array.isArray(m.membros)) continue
      const pareceId = (v) => /^[0-9a-f-]{16,}$/i.test(String(v)) || /^\d+$/.test(String(v))
      if (!m.membros.some(pareceId)) continue
      if (m.membros.map(String).includes(this.perfilId)) continue
      m.saiu = true; virouRecibo = true
    }
    if (virouRecibo) this.salvar()
  }

  criar(reserva) {
    this.metas.push(reserva)
    R.marcarReservaAtualizada(reserva)
    this.salvar()
  }

  aceitar(rid) {
    let convite = null
    for (const p of this.allProfiles) {
      for (const m of (p.metas ?? [])) {
        if (m?.compartilhada === true && String(m.id) === String(rid) &&
            (m.convites ?? []).map(String).includes(this.perfilId)) convite = m
      }
    }
    if (!convite) throw new Error(`${this.nome}: convite não encontrado`)
    const minha = clone(convite)
    minha.convites = (minha.convites ?? []).map(String).filter(x => x !== this.perfilId)
    minha.membros = (minha.membros ?? []).map(String)
    if (!minha.membros.includes(this.perfilId)) minha.membros.push(this.perfilId)
    R.marcarReservaAtualizada(minha)
    this.metas.push(minha)
    this.salvar()
    this.render()
  }

  // db-metas.js · abrirGuardarForm → btnOk
  guardar(rid, valor, data = '17/08/2026') {
    const meta = this.metas.find(m => String(m.id) === String(rid))
    if (!meta) throw new Error(`${this.nome}: reserva não encontrada`)
    meta.saved = Number((Number(meta.saved || 0) + valor).toFixed(2))
    if (R.ehCompartilhada(meta)) {
      R.registrarMovimento(meta, {
        id: this.perfilId, nome: this.nome, tipo: 'aporte', valor, data, hora: '10:00',
      })
      R.marcarReservaAtualizada(meta)
    }
    this.salvar()
    this.render()
  }

  // dashboard.js · salvarDados + data-manager.js · saveUserData
  salvar() {
    const dadosPerfil = {
      id: this.perfilId, nome: this.nome,
      transacoes: [], metas: this.metas.map(sanitizeMeta),
      contasFixas: [], cartoesCredito: [], assinaturas: [],
      orcamentos: {}, tiposPersonalizados: [], conquistas: {}, config: {},
      desafios: { ativos: [], historico: [] }, nextCartaoId: 1,
      lastUpdate: new Date().toISOString(),
    }
    const base = this.allProfiles.length > 0 ? clone(this.allProfiles) : []
    const i = base.findIndex(p => String(p.id) === this.perfilId)
    if (i !== -1) base[i] = dadosPerfil; else base.push(dadosPerfil)
    this.allProfiles = base

    const safe = clone(base)
    const tocados = this._tocados(safe)
    const sombra = this._derivar(safe, tocados)
    const ids = new Set(safe.map(p => String(p?.id)))
    const mesmoConjunto = this.retrato.size === ids.size &&
      [...this.retrato.keys()].every(id => ids.has(id))
    if (sombra.completo && sombra.ops.length === 0 && mesmoConjunto) return { ok: true }

    const soOps = sombra.completo && sombra.ops.length > 0 && this.retrato.size > 0 && mesmoConjunto
    const r = this.s.salvar({
      profiles: soOps ? [] : safe,
      touched: tocados, ops: sombra.ops, opsCompleto: sombra.completo,
      opsSomente: soOps, clientId: this.clientId,
    })
    if (r.ok) this.retrato = new Map(safe.map(p => [String(p.id), JSON.stringify(p)]))
    this.ultimoTocados = tocados
    this.s.entregar()          // só agora a campainha toca (o save já pousou)
    return r
  }

  _tocados(profiles) {
    const tocados = new Set(); const agora = new Set()
    for (const p of profiles) {
      const id = String(p?.id); agora.add(id)
      if (this.retrato.get(id) !== JSON.stringify(p)) tocados.add(id)
    }
    for (const id of this.retrato.keys()) if (!agora.has(id)) tocados.add(id)
    return [...tocados]
  }

  _resto(p) {
    const out = {}
    for (const k of Object.keys(p ?? {})) if (!FORA_DAS_OPS.includes(k)) out[k] = p[k]
    return out
  }

  _derivar(profiles, tocados) {
    const alvo = new Set(tocados.map(String))
    const ops = []; let completo = true
    for (const p of profiles) {
      const id = String(p?.id)
      if (!alvo.has(id)) continue
      let antes = null
      const bruto = this.retrato.get(id)
      if (bruto !== undefined) { try { antes = JSON.parse(bruto) } catch { /* ilegível */ } }
      const base = (antes && typeof antes === 'object') ? antes : {}
      for (const col of COLECOES) {
        const d = diffColecao(base[col], p?.[col])
        if (d.ok !== true) { completo = false; continue }
        if (serializarEstavel(aplicarNoCliente(base[col] || [], d)) !==
            serializarEstavel(p?.[col] || [])) { completo = false; continue }
        ops.push(...comEndereco(d.ops, id, col))
      }
      const dc = diffCampos(base, p, FORA_DAS_OPS)
      if (dc.ok !== true) { completo = false; continue }
      ops.push(...comEndereco(dc.ops, id, null))
    }
    return { ops, completo }
  }

  minha(rid) { return this.metas.find(m => String(m.id) === String(rid)) ?? null }
  quemColocou(rid) {
    return R.porMembro(this.minha(rid)?.movimentos ?? [])
      .filter(p => !p.sistema)
      .map(p => [p.nome, p.liquido])
      .sort()
  }
}

const RID = 'res-1'
function contaComDoisPerfis() {
  const s = novoServidor()
  const vazio = (id, nome) => ({
    id, nome, transacoes: [], metas: [], contasFixas: [], cartoesCredito: [],
    assinaturas: [], orcamentos: {}, tiposPersonalizados: [], conquistas: {},
    config: {}, desafios: { ativos: [], historico: [] }, nextCartaoId: 1, lastUpdate: 't0',
  })
  s.profiles = [vazio('64', 'Perfil A'), vazio('65', 'Perfil B')]
  const A = new Aba(s, '64', 'Perfil A')
  const B = new Aba(s, '65', 'Perfil B')
  A.carregar(); B.carregar()
  return { s, A, B }
}
const novaReserva = () => ({
  id: RID, descricao: 'Viagem', objetivo: 5000, saved: 0, monthly: {},
  compartilhada: true, membros: ['64'], convites: ['65'], movimentos: [],
  lastUpdate: new Date().toISOString(),
})

// ═══════════════════════════════════════════════════════════════════════════
describe('⭐ o fluxo que o dono descreveu', () => {
  test('⭐ dois perfis guardam R$100 cada e OS DOIS veem R$200', () => {
    const { A, B } = contaComDoisPerfis()

    A.criar(novaReserva())
    B.carregar(); B.render(); B.aceitar(RID)

    A.carregar()                       // A abre o app e vê que B aceitou
    A.guardar(RID, 100)
    B.guardar(RID, 100)

    assert.equal(B.minha(RID).saved, 200, 'o perfil que guardou por último perdeu a conta')
    assert.equal(A.minha(RID).saved, 200,
      'o aporte do outro perfil não chegou — é o bug original')
  })

  test('⭐ "Quem colocou" mostra os DOIS, com o valor de cada um', () => {
    const { A, B } = contaComDoisPerfis()
    A.criar(novaReserva())
    B.carregar(); B.render(); B.aceitar(RID)
    A.carregar(); A.guardar(RID, 100); B.guardar(RID, 250)

    const esperado = [['Perfil A', 100], ['Perfil B', 250]].sort()
    assert.deepEqual(A.quemColocou(RID), esperado, 'a trilha do perfil A não tem os dois')
    assert.deepEqual(B.quemColocou(RID), esperado, 'a trilha do perfil B não tem os dois')
  })

  test('⭐ o outro perfil recebe o aviso em TEMPO REAL (não fica esperando F5)', () => {
    const { A, B } = contaComDoisPerfis()
    A.criar(novaReserva())
    B.carregar(); B.render(); B.aceitar(RID)
    A.carregar()

    const antes = B.recargas
    A.guardar(RID, 100)
    assert.equal(B.ultimoAviso, 'aplicado',
      'o filtro do tempo real descartou o aviso de quem divide a reserva comigo')
    assert.ok(B.recargas > antes, 'a tela do outro perfil não recarregou')
    assert.equal(B.minha(RID).saved, 100, 'recarregou e mesmo assim não viu o depósito')
  })

  test('⭐ quem CONVIDOU também é avisado do 1º aporte do recém-chegado', () => {
    // A ainda lista B só em `convites` (o aceite acontece no slot de B). Se a
    // relevância olhasse só `membros`, este aviso seria jogado fora e A ficaria
    // sem ver o dinheiro que B pôs.
    const { A, B } = contaComDoisPerfis()
    A.criar(novaReserva())
    B.carregar(); B.render(); B.aceitar(RID)

    B.guardar(RID, 70)
    assert.equal(A.ultimoAviso, 'aplicado', 'o convidante ignorou o aporte do convidado')
    assert.equal(A.minha(RID).saved, 70)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('🔴 a regressão que apagava dinheiro no banco', () => {
  test('⭐ aporte de um NÃO substitui o registro do outro no slot dele', () => {
    // O cenário exato do defeito: B guarda SEM ter recarregado depois de A.
    const { s, A, B } = contaComDoisPerfis()
    A.criar(novaReserva())
    B.carregar(); B.render(); B.aceitar(RID)
    A.carregar()

    A.guardar(RID, 100)                 // A no seu slot
    B.guardar(RID, 100)                 // B, com visão possivelmente velha de A

    const slotA = s.reserva('64', RID)
    const slotB = s.reserva('65', RID)
    assert.equal(R.saldoDeMovimentos(slotA.movimentos), 200,
      'a trilha gravada no slot A perdeu um dos aportes')
    assert.equal(R.saldoDeMovimentos(slotB.movimentos), 200,
      'a trilha gravada no slot B perdeu um dos aportes')
  })

  test('⭐ nenhum save escreve numa coleção de OUTRO perfil', () => {
    // A INVARIANTE, verificada onde ela importa: nas operações que sobem.
    // Escrita cruzada é exatamente `{p: <outro perfil>, c:'metas', op:'edit'}`.
    const { s, A, B } = contaComDoisPerfis()
    A.criar(novaReserva())
    B.carregar(); B.render(); B.aceitar(RID)
    A.carregar()

    s.opsRecebidas.length = 0
    A.guardar(RID, 100)
    B.guardar(RID, 100)

    const dono = { [A.clientId]: '64', [B.clientId]: '65' }
    assert.ok(s.opsRecebidas.length > 0, 'o teste não observou operação nenhuma')
    for (const { de, op } of s.opsRecebidas) {
      assert.equal(String(op.p), dono[de],
        `${de} escreveu no slot ${op.p} — a propagação cruzada voltou`)
    }
  })

  test('⭐ aceitar o convite não é desfeito pelo roster velho de quem convidou', () => {
    // A não recarregou depois do aceite, então a cópia DELE ainda diz
    // "B é convite pendente" — e o carimbo do aporte a torna a mais nova. Antes,
    // a reconciliação de B adotava esse roster e expulsava B da própria reserva.
    const { A, B } = contaComDoisPerfis()
    A.criar(novaReserva())
    B.carregar(); B.render(); B.aceitar(RID)

    A.guardar(RID, 100)                 // A com o roster velho
    B.carregar(); B.render()

    assert.ok(B.minha(RID), 'a reserva sumiu do perfil que tinha acabado de aceitar')
    assert.equal(B.minha(RID).saiu, undefined, 'o membro aceito virou recibo sozinho')
    assert.ok(B.minha(RID).membros.map(String).includes('65'),
      'o perfil B foi tirado do roster pela cópia velha do outro')
  })

  test('a conta fecha depois de vários aportes alternados', () => {
    const { A, B } = contaComDoisPerfis()
    A.criar(novaReserva())
    B.carregar(); B.render(); B.aceitar(RID)
    A.carregar()

    let esperado = 0
    for (let i = 1; i <= 5; i++) {
      A.guardar(RID, i * 10); esperado += i * 10
      B.guardar(RID, i * 7);  esperado += i * 7
    }
    A.carregar(); B.carregar()
    assert.equal(A.minha(RID).saved, esperado, 'o perfil A não fecha a conta')
    assert.equal(B.minha(RID).saved, esperado, 'o perfil B não fecha a conta')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('sair da reserva não pode apagar a conta de quem fica', () => {
  test('⭐ a cópia de quem sai vira RECIBO — a trilha continua fechando', () => {
    const { A, B } = contaComDoisPerfis()
    A.criar(novaReserva())
    B.carregar(); B.render(); B.aceitar(RID)
    A.carregar()
    A.guardar(RID, 100)
    B.guardar(RID, 100)
    A.carregar()

    // B sai levando o que pôs.
    const meta = B.minha(RID)
    const r = R.sairDaReserva(meta, '65', R.depositoLiquidoDe(meta, '65'), 'Perfil B')
    assert.equal(r.ok, true)
    B.salvar()

    A.carregar(); A.render()
    assert.equal(A.minha(RID).saved, 100,
      'o saldo de quem ficou não refletiu a saída (ou apagou o aporte junto)')
    assert.equal(B.minha(RID).saiu, true, 'a cópia de quem saiu não virou recibo')
  })

  test('o recibo não aparece como reserva de quem saiu', () => {
    const meta = { id: RID, compartilhada: true, membros: [], saiu: true, movimentos: [] }
    assert.equal(R.perfilParticipa(meta, '65'), false,
      'a reserva de que eu saí continua aparecendo como minha')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('a invariante não pode vazar por aliasing', () => {
  test('⭐ a trilha unida não guarda OBJETOS do slot do outro perfil', () => {
    // Se guardasse, mutar um lançamento meu escreveria na cópia alheia pela
    // porta dos fundos — a mesma classe de defeito, por outro caminho.
    const minha = { id: 'r9', compartilhada: true, membros: ['A', 'B'], saved: 0, movimentos: [] }
    const dela  = { id: 'r9', compartilhada: true, membros: ['A', 'B'], saved: 0, movimentos: [] }
    R.registrarMovimento(dela, { id: 'B', nome: 'Bea', tipo: 'aporte', valor: 40 })
    const objetoDela = dela.movimentos[0]

    R.reconciliarCopiaAtiva(minha, [{ id: 'A', metas: [minha] }, { id: 'B', metas: [dela] }], 'A')

    const meu = minha.movimentos.find(m => m.mid === objetoDela.mid)
    assert.ok(meu, 'o lançamento do outro membro não entrou na minha trilha')
    assert.notEqual(meu, objetoDela, 'a minha trilha aponta para o objeto do slot alheio')

    meu.valor = 999
    assert.equal(objetoDela.valor, 40, 'mutar a minha trilha alterou a cópia do outro perfil')
  })
})
