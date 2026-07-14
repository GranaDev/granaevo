// =============================================================================
// GranaEvo — Have I Been Pwned (Pwned Passwords) via k-anonymity
//
// Bloqueia senhas que já apareceram em vazamentos de dados, SEM depender do
// recurso nativo do Supabase (que exige plano Pro). É grátis e privado:
//   • calcula o SHA-1 da senha;
//   • envia à API do HIBP APENAS os 5 primeiros caracteres do hash (prefixo);
//   • o HIBP devolve todos os sufixos daquele prefixo — a comparação é local.
//   A senha (e o hash completo) NUNCA saem do servidor.
//
// Header 'Add-Padding: true' → o HIBP acolchoa a resposta para que o tamanho
// não revele quantos sufixos batem com o prefixo (privacidade extra).
//
// FAIL-OPEN por design: se o HIBP estiver fora do ar / lento, NÃO bloqueia o
// cadastro/reset (disponibilidade > esta defesa). Timeout curto.
//
// Roda no servidor (Edge Function Deno). O CSP do browser não é afetado.
// =============================================================================

const HIBP_RANGE_URL = 'https://api.pwnedpasswords.com/range/'

/**
 * @returns true se a senha aparece em vazamentos conhecidos (deve ser rejeitada).
 *          false se limpa OU se a checagem falhou (fail-open).
 */
export async function isPasswordPwned(password: string, timeoutMs = 2500): Promise<boolean> {
  try {
    if (!password) return false

    // SHA-1 via Web Crypto (disponível no runtime Deno das Edge Functions)
    const bytes  = new TextEncoder().encode(password)
    const digest = await crypto.subtle.digest('SHA-1', bytes)
    const hex    = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()

    const prefix = hex.slice(0, 5)
    const suffix = hex.slice(5)

    const res = await fetch(HIBP_RANGE_URL + prefix, {
      headers: { 'Add-Padding': 'true' },
      signal:  AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return false // fail-open

    const text = await res.text()
    for (const line of text.split('\n')) {
      const idx = line.indexOf(':')
      if (idx === -1) continue
      // "SUFFIX:count" — padding vem como count 0; ignora esses.
      if (line.slice(0, idx).trim().toUpperCase() === suffix) {
        const count = parseInt(line.slice(idx + 1).trim(), 10)
        return Number.isFinite(count) && count > 0
      }
    }
    return false
  } catch {
    return false // fail-open (timeout/rede/crypto)
  }
}
