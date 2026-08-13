// api/_jwt.js — verificação CRIPTOGRÁFICA do JWT do Supabase (ES256 via JWKS).
// ---------------------------------------------------------------------------
// Prefixo `_`: a Vercel NÃO conta este arquivo como Serverless Function. O plano
// Hobby aceita 12, e a 13ª congela todo o deploy em silêncio (2026-07-25).
//
// POR QUE ESTE ARQUIVO EXISTE (ACHADO-01, auditoria 2026-08-12)
// -----------------------------------------------------------------------------
// O proxy decodificava o payload do JWT e usava o `sub` para montar chaves de
// rate limit — `uid:<sub>`, `chatparse:uid:<sub>:day`, `upload:user:<sub>`. A
// justificativa registrada era "é só rate limit, a edge é que autentica".
//
// Não era só rate limit. Um `sub` que ninguém verificou é identidade forjável, e
// contador de rate limit é um recurso da VÍTIMA. Bastava mandar um JWT inventado
// com o `sub` de outra pessoa para queimar a cota dela:
//
//   • `chatparse:uid:<vítima>:day` = 120/dia, e o teto por IP é 15/min
//     → ~8 minutos de um único IP e o assistente da vítima morre por 24h;
//   • `uid:<vítima>` = 8/min contra 10/min por IP
//     → um IP só já impede a vítima de salvar, de forma sustentada.
//
// Descobrir o uuid da vítima é trivial para quem é (ou foi) convidado da conta:
// `get_user_access_data` devolve `owner_user_id`, e `account_members` é legível
// nos dois sentidos. Num app de finanças de casal/família esse é o atacante
// realista.
//
// A CORREÇÃO NÃO É REORDENAR O CONTADOR — É INVERTER A ORDEM DA CONFIANÇA:
// primeiro se autentica, depois se usa a identidade. Nenhuma decisão passa a
// depender de um `sub` que não sobreviveu a uma verificação de assinatura.
//
// TRÊS RESULTADOS, NÃO DOIS
// -----------------------------------------------------------------------------
// Um verificador binário (`válido`/`inválido`) obrigaria a escolher entre duas
// falhas ruins quando o JWKS está fora do ar: recusar todo mundo (outage total)
// ou aceitar todo mundo (o buraco de volta). Por isso o contrato tem três:
//
//   { ok: true,  sub }                 assinatura confere e não expirou
//   { ok: false, conclusivo: true }    SABIDAMENTE inválido  → o chamador dá 401
//   { ok: false, conclusivo: false }   NÃO DEU PARA DECIDIR   → segue sem identidade
//
// `conclusivo: false` acontece quando falta a chave (JWKS indisponível e cache
// vazio), quando o `kid` é desconhecido, ou quando o `alg` não é o que este
// projeto emite. Nesses casos o proxy não inventa identidade nem derruba
// ninguém: aplica só os limites por IP e deixa a Edge Function — que valida via
// `auth.getUser()` — ser a autoridade, como sempre foi.
//
// O caso do `alg` merece nota. Token com `alg: "none"` é ataque, não legado:
// isso é conclusivo. Já HS256/RS256 fica INCONCLUSIVO de propósito — o projeto
// migrou para ES256 (2026-07-23), mas se sobrar um token legado em circulação
// ele continua funcionando normalmente pela edge, só que sem cota por usuário.
// Falso 401 em usuário legítimo seria uma regressão pior que o achado.
// ---------------------------------------------------------------------------

import { createPublicKey, verify as verificarAssinatura } from 'node:crypto'

const SUPABASE_URL = process.env.SUPABASE_URL ?? ''

// 10 min: o Supabase rotaciona chave raramente, e um `kid` novo força refetch
// imediato (ver `buscarJwks`), então o TTL não é o que dita a propagação.
const JWKS_TTL_MS = 10 * 60 * 1_000
// Quando a busca falha, não martelar o endpoint a cada request.
const JWKS_BACKOFF_MS = 30 * 1_000
// Tolerância de relógio entre a Vercel e o GoTrue.
const SKEW_SEGS = 30

let _jwks = { chaves: null, validoAte: 0, proximaTentativa: 0 }

function b64urlParaBuffer(s) {
  return Buffer.from(s, 'base64url')
}

function jsonDeSegmento(seg) {
  return JSON.parse(b64urlParaBuffer(seg).toString('utf8'))
}

/**
 * Devolve as chaves do JWKS, ou null se não houver como obtê-las.
 *
 * Em falha de rede, SERVE O CACHE VELHO se existir. Chave pública expirada do
 * cache ainda verifica assinatura corretamente — o risco de usar uma chave
 * antiga é rejeitar token novo (que cai em `conclusivo: false`, inofensivo), não
 * aceitar token falso.
 */
async function buscarJwks(kidProcurado) {
  const agora = Date.now()
  const temCache = Array.isArray(_jwks.chaves) && _jwks.chaves.length > 0
  const cacheServe = temCache && agora < _jwks.validoAte &&
    (!kidProcurado || _jwks.chaves.some(k => k.kid === kidProcurado))

  if (cacheServe) return _jwks.chaves
  if (!SUPABASE_URL) return temCache ? _jwks.chaves : null
  // Backoff só vale se ainda houver cache para servir; sem cache nenhum,
  // tentar de novo é melhor que devolver null para sempre.
  if (agora < _jwks.proximaTentativa && temCache) return _jwks.chaves

  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`, {
      signal: AbortSignal.timeout(3_000),
    })
    if (!r.ok) throw new Error('jwks_http_' + r.status)
    const j = await r.json()
    const chaves = Array.isArray(j?.keys) ? j.keys : []
    if (chaves.length === 0) throw new Error('jwks_vazio')
    _jwks = { chaves, validoAte: agora + JWKS_TTL_MS, proximaTentativa: 0 }
    return chaves
  } catch {
    _jwks.proximaTentativa = agora + JWKS_BACKOFF_MS
    return temCache ? _jwks.chaves : null
  }
}

/**
 * Verifica um JWT do Supabase.
 *
 * @param {string} token
 * @returns {Promise<{ok:boolean, sub?:string, conclusivo:boolean, motivo:string}>}
 */
export async function verificarJWT(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 8_192)
    return { ok: false, conclusivo: true, motivo: 'formato' }

  const partes = token.split('.')
  if (partes.length !== 3) return { ok: false, conclusivo: true, motivo: 'formato' }

  let cabecalho, corpo
  try {
    cabecalho = jsonDeSegmento(partes[0])
    corpo     = jsonDeSegmento(partes[1])
  } catch {
    return { ok: false, conclusivo: true, motivo: 'formato' }
  }

  // `alg: none` é ataque clássico de confusão de algoritmo, nunca legado.
  const alg = cabecalho?.alg
  if (typeof alg !== 'string' || alg.toLowerCase() === 'none')
    return { ok: false, conclusivo: true, motivo: 'alg_none' }

  // Só ES256 é decidível aqui. Ver o cabeçalho do arquivo: outro alg vira
  // inconclusivo de propósito, para não dar 401 em token legado válido.
  if (alg !== 'ES256') return { ok: false, conclusivo: false, motivo: 'alg_nao_suportado' }

  const chaves = await buscarJwks(cabecalho?.kid)
  if (!chaves) return { ok: false, conclusivo: false, motivo: 'jwks_indisponivel' }

  const jwk = cabecalho?.kid
    ? chaves.find(k => k.kid === cabecalho.kid)
    : (chaves.length === 1 ? chaves[0] : null)
  if (!jwk) return { ok: false, conclusivo: false, motivo: 'kid_desconhecido' }

  let assinaturaConfere = false
  try {
    const chavePublica = createPublicKey({ key: jwk, format: 'jwk' })
    assinaturaConfere = verificarAssinatura(
      'sha256',
      Buffer.from(`${partes[0]}.${partes[1]}`, 'utf8'),
      // ECDSA em JWT é R||S cru (IEEE P1363), não DER. Sem isto a verificação
      // reprova TODO token válido — e o sintoma seria "ninguém consegue salvar".
      { key: chavePublica, dsaEncoding: 'ieee-p1363' },
      b64urlParaBuffer(partes[2]),
    )
  } catch {
    // Chave malformada no JWKS ou assinatura de tamanho inválido: não dá para
    // afirmar que o token é falso, então não se dá 401 por isso.
    return { ok: false, conclusivo: false, motivo: 'erro_verificacao' }
  }

  if (!assinaturaConfere) return { ok: false, conclusivo: true, motivo: 'assinatura' }

  const agoraSegs = Math.floor(Date.now() / 1_000)
  if (typeof corpo?.exp === 'number' && agoraSegs > corpo.exp + SKEW_SEGS)
    return { ok: false, conclusivo: true, motivo: 'expirado' }
  if (typeof corpo?.nbf === 'number' && agoraSegs + SKEW_SEGS < corpo.nbf)
    return { ok: false, conclusivo: true, motivo: 'nbf' }

  // Emissor: um token de OUTRO projeto Supabase jamais passaria na assinatura,
  // mas conferir o `iss` custa nada e documenta a expectativa.
  if (SUPABASE_URL && typeof corpo?.iss === 'string' &&
      corpo.iss !== `${SUPABASE_URL}/auth/v1`)
    return { ok: false, conclusivo: true, motivo: 'iss' }

  if (typeof corpo?.sub !== 'string' || !corpo.sub)
    return { ok: false, conclusivo: true, motivo: 'sem_sub' }

  return { ok: true, sub: corpo.sub, conclusivo: true, motivo: 'ok' }
}

/** Só para teste: zera o cache do JWKS entre casos. */
export function _resetarCacheJwks() {
  _jwks = { chaves: null, validoAte: 0, proximaTentativa: 0 }
}
