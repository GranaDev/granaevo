// aplicar-operacoes.ts — o servidor aplica O QUE MUDOU, em vez de substituir tudo
// ---------------------------------------------------------------------------
// Passo 37.2. Espelho servidor do `diff-registros.js` do cliente: recebe a lista
// plana de operações que o cliente derivou e a aplica sobre o blob decifrado.
//
// É aqui que o Lost Update morre. Hoje o cliente diz "estas são todas as minhas
// transações" e o servidor grava isso por cima — apagando o que outra aba
// lançou nos últimos segundos. Com operações, o cliente diz "adicionei a
// transação X", e o que ele não mencionou não é tocado.
//
// ── AS DUAS PONTAS TÊM DE CONCORDAR EM CADA DETALHE ─────────────────────────
// A ordem de aplicação, a âncora do `add`, o que conta como conteúdo: qualquer
// divergência entre este arquivo e `diff-registros.js` vira dado errado gravado.
// Por isso o cliente aplica o próprio diff antes de enviar (fase de sombra) e
// confere que reconstrói o estado — e por isso os testes daqui repetem os
// cenários de lá.
//
// ── NADA VINDO DO CLIENTE É CONFIÁVEL ───────────────────────────────────────
// Estas operações chegam pela rede. `validarOperacoes` recusa a REMESSA INTEIRA
// ao primeiro problema, em vez de pular a operação ruim: aplicar metade de um
// save deixa o dado num estado que nem o cliente nem o servidor sabem descrever.
// Recusar custa cair no caminho de estado inteiro, que é o de hoje.
// ---------------------------------------------------------------------------

/** Coleções que aceitam operação de registro. Espelha COLECOES do cliente. */
export const COLECOES_VALIDAS = ['transacoes', 'metas', 'cartoesCredito', 'contasFixas', 'assinaturas']

/** Teto de operações por save. Acima disso, o cliente que mande o estado inteiro. */
export const MAX_OPS = 5000

/**
 * Chaves que NUNCA podem ser escritas por `set`/`unset`.
 *
 * `__proto__`, `constructor` e `prototype` são poluição de protótipo: um
 * `{op:'set', k:'__proto__', v:{…}}` escreveria no protótipo de Object e mudaria
 * o comportamento de TODO objeto do processo — inclusive o de outro usuário
 * atendido pela mesma instância da função.
 *
 * `id` é a identidade do perfil: deixá-lo passar permitiria um cliente renomear
 * a chave de um perfil pelo caminho de dados.
 *
 * As coleções também: um `set` em `transacoes` substituiria a coleção inteira,
 * que é exatamente o "manda tudo" que este passo veio eliminar.
 */
const CHAVES_PROIBIDAS = new Set(['__proto__', 'constructor', 'prototype', 'id', ...COLECOES_VALIDAS])

export type Operacao =
  | { p: string; c: string; op: 'add'; apos: string | null; r: Record<string, unknown> }
  | { p: string; c: string; op: 'edit'; id: string; r: Record<string, unknown> }
  | { p: string; c: string; op: 'rm'; id: string }
  | { p: string; op: 'set'; k: string; v: unknown }
  | { p: string; op: 'unset'; k: string }

type Resultado<T> = { ok: true; valor: T } | { ok: false; erro: string }

const ehObjeto = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

const idValido = (v: unknown): boolean =>
  (typeof v === 'string' && v.trim() !== '') || (typeof v === 'number' && Number.isFinite(v))

/**
 * 37.2c — valida a remessa inteira ANTES de tocar em qualquer dado.
 * Ao primeiro problema, recusa tudo: nada é aplicado pela metade.
 */
export function validarOperacoes(ops: unknown): Resultado<Operacao[]> {
  if (!Array.isArray(ops)) return { ok: false, erro: 'ops_nao_e_lista' }
  if (ops.length > MAX_OPS) return { ok: false, erro: 'ops_demais' }

  for (const o of ops as unknown[]) {
    if (!ehObjeto(o)) return { ok: false, erro: 'op_nao_e_objeto' }
    if (typeof o.p !== 'string' || o.p.trim() === '') return { ok: false, erro: 'op_sem_perfil' }

    switch (o.op) {
      case 'add':
      case 'edit':
      case 'rm': {
        if (typeof o.c !== 'string' || !COLECOES_VALIDAS.includes(o.c)) {
          return { ok: false, erro: 'colecao_desconhecida' }
        }
        if (o.op === 'rm') {
          if (!idValido(o.id)) return { ok: false, erro: 'rm_sem_id' }
          break
        }
        if (!ehObjeto(o.r)) return { ok: false, erro: `${o.op}_sem_registro` }
        if (!idValido((o.r as Record<string, unknown>).id)) return { ok: false, erro: `${o.op}_registro_sem_id` }
        if (o.op === 'edit') {
          // O id do envelope e o do registro têm de ser o mesmo. Divergentes,
          // não dá para saber qual registro o cliente quis editar.
          if (!idValido(o.id)) return { ok: false, erro: 'edit_sem_id' }
          if (String(o.id) !== String((o.r as Record<string, unknown>).id)) {
            return { ok: false, erro: 'edit_id_divergente' }
          }
        } else if (!(o.apos === null || o.apos === undefined || idValido(o.apos))) {
          return { ok: false, erro: 'add_apos_invalido' }
        }
        break
      }
      case 'set':
      case 'unset': {
        if (typeof o.k !== 'string' || o.k.trim() === '') return { ok: false, erro: 'campo_sem_chave' }
        if (CHAVES_PROIBIDAS.has(o.k)) return { ok: false, erro: 'campo_proibido' }
        if (o.op === 'set' && !('v' in o)) return { ok: false, erro: 'set_sem_valor' }
        break
      }
      default:
        return { ok: false, erro: 'op_desconhecida' }
    }
  }
  return { ok: true, valor: ops as Operacao[] }
}

/**
 * Aplica as operações aos perfis guardados. Não muta a entrada.
 *
 * ── 37.2b · IDEMPOTÊNCIA, SEM LIVRO-CAIXA ──────────────────────────────────
 * O plano original era a Edge guardar os últimos N ids de operação aplicados e
 * ignorar repetição. Não é preciso: TODA operação daqui já é idempotente por
 * construção, e isso é mais forte que qualquer registro — não expira, não ocupa
 * espaço e não pode dessincronizar.
 *
 *   add   → id que já existe é IGNORADO (não duplica, e não sobrescreve: se o
 *           registro mudou nesse meio-tempo, quem manda é quem está lá)
 *   edit  → escrever o mesmo conteúdo duas vezes dá o mesmo resultado
 *   rm    → remover o que já não está lá não faz nada
 *   set   → idem
 *   unset → idem
 *
 * O caso real que isso conserta: o save chega ao servidor, é gravado, e a
 * RESPOSTA se perde (timeout, rede caindo). O cliente não atualiza o retrato,
 * então o save seguinte deriva as MESMAS operações. Sem idempotência, a
 * transação apareceria duas vezes no extrato do usuário.
 *
 * @param guardados  perfis como estão no banco (decifrados)
 * @param ops        operações já validadas
 * @param agoraISO   carimbo de `lastUpdate` (o cliente não manda mais — ver 37.1)
 */
export function aplicarOperacoes(
  guardados: unknown[],
  ops: Operacao[],
  agoraISO: string = new Date().toISOString(),
): Resultado<{ profiles: unknown[]; aplicadas: number; ignoradas: number }> {
  if (!Array.isArray(guardados)) return { ok: false, erro: 'perfis_invalidos' }

  // Cópia profunda: aplicar sobre a referência do chamador faria a guarda
  // anti-wipe comparar o resultado consigo mesma e nunca disparar.
  let profiles: Record<string, unknown>[]
  try {
    profiles = JSON.parse(JSON.stringify(guardados))
  } catch {
    return { ok: false, erro: 'perfis_nao_serializam' }
  }

  const porId = new Map<string, Record<string, unknown>>()
  for (const p of profiles) if (ehObjeto(p)) porId.set(String(p.id), p)

  // Operação para perfil que não existe = cliente e servidor discordam sobre a
  // realidade. Recusar manda o save pelo caminho de estado inteiro, que sabe
  // criar e apagar perfil; aplicar às cegas criaria perfil fantasma.
  for (const o of ops) if (!porId.has(String(o.p))) return { ok: false, erro: 'perfil_desconhecido' }

  const tocados = new Set<string>()
  let aplicadas = 0
  let ignoradas = 0

  for (const o of ops) {
    const perfil = porId.get(String(o.p))!
    tocados.add(String(o.p))

    if (o.op === 'set' || o.op === 'unset') {
      if (o.op === 'set') perfil[o.k] = o.v
      else delete perfil[o.k]
      aplicadas++
      continue
    }

    const lista = Array.isArray(perfil[o.c]) ? (perfil[o.c] as Record<string, unknown>[]) : []
    perfil[o.c] = lista

    if (o.op === 'rm') {
      const antes = lista.length
      perfil[o.c] = lista.filter((r) => String(r?.id) !== String(o.id))
      if ((perfil[o.c] as unknown[]).length === antes) ignoradas++
      else aplicadas++
      continue
    }

    if (o.op === 'edit') {
      const i = lista.findIndex((r) => String(r?.id) === String(o.id))
      if (i === -1) { ignoradas++; continue }   // sumiu: outro cliente removeu
      lista[i] = o.r
      aplicadas++
      continue
    }

    // add — idempotência: id que já existe não entra de novo.
    if (lista.some((r) => String(r?.id) === String(o.r.id))) { ignoradas++; continue }
    if (o.apos == null) {
      lista.unshift(o.r)
    } else {
      const i = lista.findIndex((r) => String(r?.id) === String(o.apos))
      // Âncora sumiu: anexa no fim. Perde a posição exata, nunca o registro.
      if (i === -1) lista.push(o.r)
      else lista.splice(i + 1, 0, o.r)
    }
    aplicadas++
  }

  // Contrato do 37.1: o cliente parou de mandar `lastUpdate` (era um carimbo que
  // mudava a cada save e faria toda gravação simultânea colidir). Quem carimba
  // agora é o servidor — senão o campo congelaria.
  for (const id of tocados) {
    const p = porId.get(id)
    if (p) p.lastUpdate = agoraISO
  }

  return { ok: true, valor: { profiles, aplicadas, ignoradas } }
}
