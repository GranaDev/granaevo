import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.2'
import { mergeProfiles } from '../_shared/merge-profiles.ts'
import { validarOperacoes, aplicarOperacoes } from '../_shared/aplicar-operacoes.ts'
import { mfaBloqueia } from '../_shared/mfa-gate.ts'
import { reportarEventoSeguranca } from '../_shared/sec-report.ts'

// Secret key nova (sb_secret_, injetada pela plataforma em SUPABASE_SECRET_KEYS).
// SEM fallback na legada: as chaves antigas (anon e service_role) foram
// DESATIVADAS em 2026-07-23 e devolvem 401 "Legacy API keys are disabled".
// Um fallback para uma chave morta não é rede de segurança — é um 401 confuso
// no lugar de um erro de configuração legível. Se a env sumir, falhe alto.
function getSecretKey(): string {
  try {
    const k = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}')?.default
    if (typeof k === 'string' && k.startsWith('sb_secret_')) return k
  } catch { /* JSON inválido: cai no throw abaixo */ }
  throw new Error('SUPABASE_SECRET_KEYS ausente ou inválida')
}

// ---------------------------------------------------------------------------
// HKDF + AES-256-GCM — chave derivada por usuário
// Formato no banco: { _enc: "v2:base64(iv[12] + ciphertext + authTag[16])" }
// ---------------------------------------------------------------------------
async function deriveUserKey(userId: string): Promise<CryptoKey | null> {
  const keyBase64 = Deno.env.get('DATA_ENCRYPTION_KEY')
  if (!keyBase64) return null
  const masterBytes = Uint8Array.from(atob(keyBase64), c => c.charCodeAt(0))
  const masterKey   = await crypto.subtle.importKey('raw', masterBytes, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode(userId), info: new TextEncoder().encode('granaevo-data-v2') },
    masterKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

async function encryptData(plaintext: string, userId: string): Promise<string | null> {
  const key = await deriveUserKey(userId)
  if (!key) return null
  const iv      = crypto.getRandomValues(new Uint8Array(12))
  const encoded = new TextEncoder().encode(plaintext)
  const cipher  = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded)
  const combined = new Uint8Array(iv.byteLength + cipher.byteLength)
  combined.set(iv, 0)
  combined.set(new Uint8Array(cipher), iv.byteLength)
  return 'v2:' + btoa(String.fromCharCode(...combined))
}

// Decifra (mesmo esquema do get-user-data) — usado SÓ pela guarda anti-wipe,
// para inspecionar os dados atuais antes de sobrescrever.
async function decryptData(encrypted: string, userId: string): Promise<string | null> {
  const keyBase64 = Deno.env.get('DATA_ENCRYPTION_KEY')
  if (!keyBase64) return null
  let key: CryptoKey
  let payload: string
  try {
    if (encrypted.startsWith('v2:')) {
      const derived = await deriveUserKey(userId)
      if (!derived) return null
      key     = derived
      payload = encrypted.slice(3)
    } else if (encrypted.startsWith('v1:')) {
      const keyBytes = Uint8Array.from(atob(keyBase64), c => c.charCodeAt(0))
      key     = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt'])
      payload = encrypted.slice(3)
    } else {
      return null
    }
    const combined = Uint8Array.from(atob(payload), c => c.charCodeAt(0))
    const iv       = combined.slice(0, 12)
    const cipher   = combined.slice(12)
    const plain    = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher)
    return new TextDecoder().decode(plain)
  } catch {
    return null
  }
}

// Um perfil "tem dados" se qualquer coleção financeira não está vazia.
function profileHasData(p: any): boolean {
  if (!p || typeof p !== 'object') return false
  const ne = (k: string) => Array.isArray(p[k]) && p[k].length > 0
  return ne('transacoes') || ne('metas') || ne('contasFixas') ||
         ne('cartoesCredito') || ne('assinaturas')
}

// Extrai o array de profiles do blob armazenado (decifrando se necessário).
// Retorna null quando não dá para inspecionar com segurança (sem decifrar etc.).
async function extractStoredProfiles(stored: any, userId: string): Promise<any[] | null> {
  try {
    let obj = stored
    if (stored && typeof stored._enc === 'string') {
      const plain = await decryptData(stored._enc, userId)
      if (!plain) return null
      obj = JSON.parse(plain)
    }
    return Array.isArray(obj?.profiles) ? obj.profiles : null
  } catch {
    return null
  }
}


// ---------------------------------------------------------------------------
// A CAMPAINHA — Passo 37, tempo real
//
// Anuncia "a conta X mudou, nos perfis Y". NÃO manda o dado: quem ouve busca
// pelo caminho normal (get-user-data), que autentica e decifra server-side.
// Nenhum centavo trafega pelo websocket.
//
// `private: true` é a linha que importa. A autorização do Realtime (a política
// `conta_broadcast_ouvir`) só vale para canal PRIVADO. Mensagem sem esta marca
// chegaria também a quem assinasse o canal público de mesmo nome — e o nome é
// só um uuid, que não é segredo.
//
// Nunca derruba o save: a gravação já aconteceu quando isto roda. Falhar aqui
// custa o outro lado descobrir a mudança pelo caminho lento (recarregar), e não
// perder dado.
// ---------------------------------------------------------------------------
async function anunciarMudanca(
  supabaseUrl: string,
  contaId: string,
  perfis: string[],
  origem: string | null,
): Promise<void> {
  let secretKey: string
  try { secretKey = getSecretKey() } catch { return }

  const envio = fetch(`${supabaseUrl}/realtime/v1/api/broadcast`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': secretKey,
      'Authorization': `Bearer ${secretKey}`,
    },
    body: JSON.stringify({
      messages: [{
        topic: `conta:${contaId}`,
        event: 'mudou',
        private: true,
        payload: {
          // Ids de perfil tocados: quem ouve decide se aquilo lhe interessa
          // antes de gastar um refetch. Id de perfil não é dado financeiro.
          perfis: perfis.slice(0, 20).map(String),
          // Quem causou. A aba de origem usa isto para ignorar o próprio eco —
          // sem ele, todo save faria a própria tela recarregar sozinha.
          origem,
          em: new Date().toISOString(),
        },
      }],
    }),
    signal: AbortSignal.timeout(2_000),
  }).catch((e) => {
    console.warn('[save-user-data] campainha falhou (save já gravado):', e?.name ?? e)
  })

  // `waitUntil` deixa o anúncio terminar DEPOIS da resposta: o usuário não
  // espera pela campainha. Sem ele a promessa solta seria morta junto com a
  // requisição, então aí vale esperar — o custo é uma chamada curta, dentro da
  // mesma região, e é melhor que o aviso simplesmente não sair.
  const rt = (globalThis as any).EdgeRuntime
  if (rt && typeof rt.waitUntil === 'function') { rt.waitUntil(envio); return }
  await envio
}

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------
const ALLOWED_ORIGINS = [
  'https://granaevo.vercel.app',
  'https://granaevo.com',
  'https://www.granaevo.com',
]

function getCorsHeaders(origin: string): Record<string, string> {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]
  return {
    'Access-Control-Allow-Origin':  allowed,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-proxy-secret',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const aB  = enc.encode(a)
  const bB  = enc.encode(b)
  const len = Math.max(aB.length, bB.length)
  let diff  = aB.length ^ bB.length
  for (let i = 0; i < len; i++) diff |= (aB[i] ?? 0) ^ (bB[i] ?? 0)
  return diff === 0
}

function json(body: unknown, status = 200, corsHeaders: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req: Request) => {
  const origin      = req.headers.get('origin') ?? ''
  const corsHeaders = getCorsHeaders(origin)

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return json({ success: false, error: 'Método não permitido' }, 405, corsHeaders)
  }

  // ── 1. Verificar proxy secret ────────────────────────────────────────────
  // PROXY_SECRET é obrigatória — sem ela, qualquer requisição seria aceita.
  const proxySecret = Deno.env.get('PROXY_SECRET')
  if (!proxySecret) {
    console.error('[save-user-data] PROXY_SECRET não configurada — requisição bloqueada')
    return json({ success: false, error: 'Configuração interna inválida' }, 500, corsHeaders)
  }
  const received = req.headers.get('x-proxy-secret') ?? ''
  if (!timingSafeEqual(received, proxySecret)) {
    // B-4: chamada direta à edge com secret errado = alguém varrendo as Edge
    // Functions por fora do proxy. O threshold (5 em 2 min) BLOQUEIA o IP.
    reportarEventoSeguranca('proxy_bypass', 'save-user-data', req,
      received ? 'secret incorreto' : 'sem header x-proxy-secret')
    console.warn('[save-user-data] Proxy secret inválido — acesso bloqueado')
    return json({ success: false, error: 'Não autorizado' }, 401, corsHeaders)
  }

  // ── 2. Extrair token JWT ─────────────────────────────────────────────────
  const authHeader = req.headers.get('Authorization') ?? ''
  const token      = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null

  if (!token || token.length < 20) {
    return json({ success: false, error: 'Não autenticado' }, 401, corsHeaders)
  }

  // ── 3. Cliente admin + verificação JWT com assinatura real ────────────────
  // [SEC-FIX R4-001] Substituído decodeJwtPayload (sem verificação de assinatura)
  // por supabaseAdmin.auth.getUser(token) que valida ES256 via JWKS — mesma
  // abordagem usada em check-user-access e upload-profile-photo.
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceKey  = getSecretKey()

  const supabaseAdmin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })

  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token)
  if (authError || !user?.id) {
    console.warn('[save-user-data] JWT inválido ou expirado:', authError?.message ?? 'user null')
    return json({ success: false, error: 'Token inválido' }, 401, corsHeaders)
  }

  const userId    = user.id
  const userEmail = user.email ?? ''

  // ── 3.5 Gate do 2º fator (Passo 31 · B-1c) ───────────────────────────────
  // Mesma razão do get-user-data: service_role BYPASSA RLS, então o enforcement
  // de aal2 das policies não chega aqui. Vale para ESCRITA também — sem isto,
  // uma sessão aal1 de quem ativou o 2FA poderia sobrescrever o blob inteiro.
  if (await mfaBloqueia(supabaseAdmin, token, userId, 'save-user-data')) {
    console.warn('[save-user-data] 2FA exigido e sessão não elevada:', userId.slice(0, 8))
    return json({ success: false, error: 'Verificação em duas etapas necessária', mfa_required: true }, 403, corsHeaders)
  }

  // ── 4. Resolver ID efetivo — convidados salvam nos dados do dono ─────────
  // O save opera sempre no registro do dono. O convidado nunca cria
  // um registro separado — isso garantiria que o save do convidado
  // apareça para o dono e vice-versa.
  let effectiveUserId    = userId
  let effectiveUserEmail = userEmail
  const { data: memberEntry } = await supabaseAdmin
    .from('account_members')
    .select('owner_user_id, owner_email')
    .eq('member_user_id', userId)
    .eq('is_active', true)
    .maybeSingle()

  if (memberEntry?.owner_user_id) {
    effectiveUserId    = memberEntry.owner_user_id
    effectiveUserEmail = memberEntry.owner_email ?? userEmail
    console.log('[save-user-data] Convidado — salvando no registro do dono:', effectiveUserId.slice(0, 8))
  }

  try {
    // ── 5. Ler e validar corpo ───────────────────────────────────────────────
    let body: { profiles?: unknown }
    try {
      body = await req.json()
    } catch {
      return json({ success: false, error: 'Body JSON inválido' }, 400, corsHeaders)
    }

    if (!Array.isArray(body?.profiles)) {
      return json({ success: false, error: 'profiles deve ser um array' }, 400, corsHeaders)
    }

    // 20: o limite REAL por plano (1/2/4) é imposto pelo trigger
    // `enforce_profile_limit_stripe` na tabela `profiles`. Este teto só impede
    // que um save forjado infle o blob com perfis órfãos — abuso de
    // armazenamento, não de plano. Era 200; 20 é 5× o maior plano e 10× o
    // máximo observado em produção.
    // MANTER EM SINCRONIA com MAX_PROFILES em api/user-data.js.
    const MAX_PROFILES = 20
    const profiles = body.profiles as unknown[]
    if (profiles.length > MAX_PROFILES) {
      return json({ success: false, error: `Número de perfis excede o limite de ${MAX_PROFILES}` }, 400, corsHeaders)
    }

    // ── 6. Ler o que já está gravado ────────────────────────────────────────
    // Vem ANTES de cifrar de propósito: tanto o merge (6.4) quanto a guarda
    // anti-wipe (6.5) precisam comparar o payload com o estado atual.
    const { data: existing, error: selectErr } = await supabaseAdmin
      .from('user_data')
      .select('user_id, data_json, last_modified')
      .eq('user_id', effectiveUserId)
      .maybeSingle()

    if (selectErr) {
      console.error('[save-user-data] Erro ao verificar registro existente:', selectErr.message)
      throw selectErr
    }

    // ── 6.4 MERGE POR PERFIL — casal e família param de se sobrescrever ──────
    //
    // O PROBLEMA (relatado pelo dono em 2026-08-04, e reproduzível):
    // casal/família compartilham UMA linha (a do dono — ver o bloco do
    // `effectiveUserId`). Cada save reescrevia o ARRAY INTEIRO de perfis:
    //
    //   ela carrega [A,B] · ele carrega [A,B]
    //   ela edita B → grava [A(velho), B(novo)]
    //   ele edita A → grava [A(novo), B(VELHO)]   ← o trabalho dela morre
    //
    // Repare que eles NEM MEXERAM no mesmo perfil. O conflito era do formato,
    // não do conteúdo — e some sem erro, sem aviso, sem log.
    //
    // A SOLUÇÃO: o cliente declara quais perfis realmente tocou. Para esses, o
    // que chegou vale; para os demais, mantém-se o que está gravado. Ninguém
    // afirma nada sobre perfil que não editou.
    //
    // Não usa relógio de propósito: celular e desktop dessincronizam, e
    // "quem salvou por último" é a pergunta errada — a certa é "sobre o que
    // este cliente tem autoridade para falar".
    //
    // COMPATÍVEL PARA TRÁS: sem `touched_profile_ids` no corpo, o
    // comportamento é exatamente o de antes (substitui tudo). Isso permite
    // deployar o servidor sozinho, sem mudar nada, e só depois os clientes.
    //
    // LIMITE ASSUMIDO: se dois editarem O MESMO perfil ao mesmo tempo, o último
    // ainda vence. Aí é conflito de verdade, e resolver exigiria mesclar
    // transação a transação — custo alto para um caso raro.
    let profilesFinais = profiles
    const touched = Array.isArray((body as any)?.touched_profile_ids)
      ? (body as any).touched_profile_ids.map((x: unknown) => String(x)).filter(Boolean)
      : null

    // ── 6.42 SINCRONIZAÇÃO POR OPERAÇÃO (Passo 37.2a) ───────────────────────
    //
    // O merge abaixo resolve pessoas em perfis DIFERENTES. Não resolve o mesmo
    // perfil — aí os dois declaram, e o último vence. E o mesmo perfil é o caso
    // comum: uma pessoa só, com duas abas, já cai nele.
    //
    // A raiz é o formato: quem manda o estado inteiro está sempre afirmando algo
    // sobre registros que não tocou. Aqui o cliente manda O QUE MUDOU, e o que
    // ele não mencionou não é tocado.
    //
    // 37.2d · COMPATIBILIDADE — o gate tem três chaves, e cada uma existe por um
    // motivo:
    //   `ops_aplicar`  o CLIENTE pede explicitamente. Permite deployar esta
    //                  função sozinha sem mudar nada em produção (nenhum cliente
    //                  manda o campo ainda) e, depois, desligar o recurso por um
    //                  deploy do front — que é rápido e reversível — sem tocar
    //                  na Edge.
    //   `ops_completo` o cliente PROVOU que aplicar essas operações reconstrói o
    //                  estado dele. Falso quando algo escapou da derivação.
    //   blob legível   sem o estado atual não há sobre o que aplicar.
    //
    // Qualquer chave faltando cai no caminho de sempre. Um cliente com bundle
    // velho em cache de Service Worker continua salvando exatamente como antes.
    let viaOperacoes = false
    // Desfecho da decisão, devolvido ao cliente. Sem isto, "por que meu save não
    // usou operações?" só se responde por logs do servidor — que o dono não vê.
    let opsMotivo = 'sem_pedido'
    const querOps = (body as any)?.ops_aplicar === true &&
                    (body as any)?.ops_completo === true &&
                    Array.isArray((body as any)?.profile_ops)

    if (querOps && existing?.data_json) {
      const guardados = await extractStoredProfiles(existing.data_json, effectiveUserId)
      if (guardados === null) {
        opsMotivo = 'blob_ilegivel'
        console.warn('[save-user-data] ops puladas: blob atual ilegível. user:', effectiveUserId.slice(0, 8))
      } else {
        // Operações não sabem CRIAR nem APAGAR perfil. Se o conjunto de perfis
        // mudou, o caminho de estado inteiro (que sabe) tem de assumir — senão
        // um perfil recém-apagado sobreviveria calado, porque nenhuma operação
        // fala dele.
        const idsGuardados = new Set((guardados as any[]).map((p) => String(p?.id)))
        const idsChegando  = new Set((profiles as any[]).map((p: any) => String(p?.id)))
        const mesmoConjunto = idsGuardados.size === idsChegando.size &&
                              [...idsGuardados].every((id) => idsChegando.has(id))

        if (!mesmoConjunto) {
          opsMotivo = 'perfis_mudaram'
          console.log('[save-user-data] ops puladas: conjunto de perfis mudou. user:', effectiveUserId.slice(0, 8))
        } else {
          const v = validarOperacoes((body as any).profile_ops)
          if (!v.ok) {
            // Recusa a remessa, não o save: cai no caminho de sempre. Rejeitar o
            // save inteiro por operação malformada perderia o trabalho do
            // usuário por um defeito que é nosso.
            opsMotivo = 'invalidas:' + v.erro
            console.warn('[save-user-data] ops inválidas:', v.erro, '| user:', effectiveUserId.slice(0, 8))
          } else {
            const r = aplicarOperacoes(guardados as unknown[], v.valor)
            if (!r.ok) {
              opsMotivo = 'recusadas:' + r.erro
              console.warn('[save-user-data] ops não aplicadas:', r.erro, '| user:', effectiveUserId.slice(0, 8))
            } else {
              profilesFinais = r.valor.profiles
              viaOperacoes = true
              opsMotivo = `ok:${r.valor.aplicadas}/${r.valor.ignoradas}`
              if (v.valor.length > 0) {
                console.log('[save-user-data] ops:', r.valor.aplicadas, 'aplicadas,',
                            r.valor.ignoradas, 'ignoradas | user:', effectiveUserId.slice(0, 8))
              }
            }
          }
        }
      }
    }

    if (!viaOperacoes && touched && existing?.data_json) {
      const guardados = await extractStoredProfiles(existing.data_json, effectiveUserId)
      if (guardados === null) {
        // Não deu para decifrar o que está lá. Mesclar às cegas apagaria dados;
        // seguir sem merge é o comportamento antigo, que é ruim mas conhecido.
        console.warn('[save-user-data] merge pulado: blob atual ilegível. user:', effectiveUserId.slice(0, 8))
      } else {
        const r = mergeProfiles(guardados as any[], profiles as any[], touched)

        if (r.profiles.length > MAX_PROFILES) {
          return json({ success: false, error: `Número de perfis excede o limite de ${MAX_PROFILES}` }, 400, corsHeaders)
        }
        if (r.preservados > 0 || r.removidos.length > 0) {
          console.log('[save-user-data] merge: preservou', r.preservados,
                      '| removeu', r.removidos.length, '| user:', effectiveUserId.slice(0, 8))
        }
        profilesFinais = r.profiles
      }
    }

    // ── 6.5 TRAVA DE VERSÃO (Passo 37.3) — só no caminho de ESTADO INTEIRO ──
    //
    // Quem manda o estado inteiro está afirmando algo sobre registros que não
    // tocou. Se essa afirmação nasceu de uma leitura velha, gravá-la apaga o que
    // outra pessoa salvou no meio do caminho — foi o que o log de auditoria
    // mostrou em 2026-08-07 (blob voltando de 9615 para 8259 bytes, o estado
    // exato de 34 segundos antes).
    //
    // ⚠️ NÃO se aplica ao caminho por operações, DE PROPÓSITO. Operações são
    // aditivas e não dependem de versão: "adicionei a transação X" continua
    // verdadeiro mesmo que a linha tenha mudado. Travar ali geraria 409 em toda
    // gravação simultânea LEGÍTIMA — o oposto do que este passo existe para
    // resolver.
    //
    // COMPATÍVEL PARA TRÁS: sem `base_versao` no corpo, não há checagem. Cliente
    // com bundle velho continua salvando como antes.
    const baseVersao = typeof (body as any)?.base_versao === 'string' ? (body as any).base_versao : null
    if (!viaOperacoes && baseVersao && existing?.last_modified &&
        String(existing.last_modified) !== baseVersao) {
      console.warn('[save-user-data] 409: save de estado inteiro sobre leitura velha. user:',
                   effectiveUserId.slice(0, 8))
      return json({
        success: false,
        error: 'VERSAO_DESATUALIZADA',
        code: 'VERSAO_DESATUALIZADA',
        versao: existing.last_modified,
      }, 409, corsHeaders)
    }

    // ── 6.45 Payload final (já mesclado) ────────────────────────────────────
    // Usa effectiveUserId/Email — para convidados, isso é o ID/email do dono
    const dataToSave = {
      version:  '1.0',
      user:     { userId: effectiveUserId, email: effectiveUserEmail },
      profiles: profilesFinais,
      metadata: {
        lastSync:      new Date().toISOString(),
        totalProfiles: profilesFinais.length,
      },
    }

    const encrypted   = await encryptData(JSON.stringify(dataToSave), effectiveUserId)
    const dataToStore = encrypted ? { _enc: encrypted } : dataToSave

    const now = new Date().toISOString()

    // ── 6.5 GUARDA ANTI-WIPE (autoritativa, server-side) ────────────────────
    // Bug recorrente: após um load falho, o cliente reenvia perfis VAZIOS e
    // sobrescrevia dados reais. Esta checagem é IMUNE a bundle/Service Worker
    // desatualizado no cliente. Rejeita o save quando o registro atual TEM dados
    // e o payload zeraria todos OU esvaziaria um perfil que tinha dados.
    // (Remoção legítima de um perfil — perfil ausente no payload — NÃO bloqueia.)
    if (existing?.data_json) {
      // Valida o RESULTADO FINAL (já mesclado), não o payload cru: é ele que
      // vai para o disco. Com merge, um payload que traz um perfil só é
      // normal — e conferir o payload faria a guarda ver um falso wipe.
      const incomingHasAnyData = (profilesFinais as any[]).some(profileHasData)
      const existingProfiles   = await extractStoredProfiles(existing.data_json, effectiveUserId)
      let wouldWipe = false

      if (existingProfiles === null) {
        // Não deu para inspecionar (cifrado e não decifrou, ou shape inesperado).
        // Conservador: se há blob cifrado atual e o payload não traz NENHUM dado,
        // é provável wipe (e sobrescrever destruiria o ciphertext) → bloqueia.
        const existingHasEnc = typeof (existing.data_json as any)?._enc === 'string'
        if (existingHasEnc && !incomingHasAnyData) wouldWipe = true
      } else if (existingProfiles.length > 0) {
        const hadDataIds = new Set(
          existingProfiles.filter(profileHasData).map((p: any) => String(p?.id)),
        )
        if (hadDataIds.size > 0) {
          const incomingById = new Map((profilesFinais as any[]).map(p => [String(p?.id), p]))
          wouldWipe = profilesFinais.length === 0 // zerou todos os perfis
          if (!wouldWipe) {
            for (const id of hadDataIds) {
              const incoming = incomingById.get(id)
              // Só bloqueia o caso do BUG: perfil ainda presente, porém esvaziado.
              // (Remoção legítima de um perfil — ausente no payload — não bloqueia.)
              if (incoming && !profileHasData(incoming)) { wouldWipe = true; break }
            }
          }
        }
      }

      if (wouldWipe) {
        console.error(
          '[save-user-data] BLOQUEIO ANTI-WIPE: payload esvaziaria dados existentes — save rejeitado. user:',
          effectiveUserId.slice(0, 8),
        )
        return json({ success: false, error: 'WIPE_BLOCKED', code: 'WIPE_BLOCKED' }, 409, corsHeaders)
      }
    }

    if (existing) {
      const { error: updateErr } = await supabaseAdmin
        .from('user_data')
        .update({ email: effectiveUserEmail, data_json: dataToStore, last_modified: now })
        .eq('user_id', effectiveUserId)
      if (updateErr) {
        console.error('[save-user-data] Erro no UPDATE:', updateErr.message)
        throw updateErr
      }
    } else {
      const { error: insertErr } = await supabaseAdmin
        .from('user_data')
        .insert({ user_id: effectiveUserId, email: effectiveUserEmail, data_json: dataToStore, last_modified: now })
      if (insertErr) {
        console.error('[save-user-data] Erro no INSERT:', insertErr.message)
        throw insertErr
      }
    }

    // ── 7. A CAMPAINHA (Passo 37 · tempo real) ──────────────────────────────
    // Grava primeiro, avisa depois. Nesta ordem porque avisar antes faria quem
    // ouve buscar dado que ainda não existe — e um refetch que chega cedo demais
    // volta com o estado ANTIGO, que é pior que aviso nenhum.
    await anunciarMudanca(
      supabaseUrl,
      effectiveUserId,
      touched ?? (profilesFinais as any[]).map((p) => String(p?.id)),
      typeof (body as any)?.client_id === 'string' ? (body as any).client_id.slice(0, 64) : null,
    )

    // `ops` no corpo é DIAGNÓSTICO, não contrato: diz por que este save usou (ou
    // não usou) operações. Sem valor nenhum do usuário — só o motivo e contagens.
    return json({ success: true, versao: now, ops: { via: viaOperacoes, motivo: opsMotivo } }, 200, corsHeaders)

  } catch (error: any) {
    console.error('[save-user-data] Erro:', error?.message)
    return json({ success: false, error: 'Erro interno ao salvar dados' }, 500, corsHeaders)
  }
})
