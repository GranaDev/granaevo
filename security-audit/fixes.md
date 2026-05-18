# God Eyes — Correções
Data: 2026-05-18 | Round 8

---

## Round 8 — Correção Aplicada

### GOD8-M01 — `timingSafeEqual` sem early-return em `webhook-cakto`

**Arquivo:** `supabase/functions/webhook-cakto/index.ts`

**O que estava errado:**
A função `timingSafeEqual` retornava `false` imediatamente quando os strings tinham comprimentos diferentes (`if (aBytes.length !== bBytes.length) return false`). Isso cria um timing oracle: um atacante pode determinar o comprimento exato do `CAKTO_WEBHOOK_SECRET` medindo o tempo de resposta com payloads de comprimentos variados. O Round 7 corrigiu o mesmo bug em 7 outras Edge Functions mas deixou esta passar.

**Por que a correção resolve:**
A implementação correta aplica XOR em todos os bytes do maior dos dois arrays, codificando a diferença de comprimento via `aB.length ^ bB.length`. O tempo de execução é sempre proporcional ao maior dos dois inputs — sem dependência do conteúdo comparado.

**Código corrigido (já aplicado):**
```ts
// [GOD8-M01] Sem early-return em length — elimina timing oracle
function timingSafeEqual(a: string, b: string): boolean {
  const enc  = new TextEncoder()
  const aB   = enc.encode(a)
  const bB   = enc.encode(b)
  const len  = Math.max(aB.length, bB.length)
  let diff   = aB.length ^ bB.length
  for (let i = 0; i < len; i++) diff |= (aB[i] ?? 0) ^ (bB[i] ?? 0)
  return diff === 0
}
```

**Como testar:**
```bash
# Enviar payloads com secret de comprimentos 1, 10, 100, 1000 chars
# O tempo de resposta deve ser constante independente do comprimento do secret enviado.
# Diferença esperada: < 1ms entre comprimentos diferentes.
```

**Deploy:** `supabase functions deploy webhook-cakto`

---

## Round 7 — Correções Anteriores (referência)

> Nenhum item CRÍTICO ou ALTO aberto. Os itens abaixo foram corrigidos no Round 7.

| Arquivo | Achado | Fix |
|---------|--------|-----|
| `src/scripts/pages/atualizarplano.js` | XSS (m.name/m.email) | Função `_esc()` + escape HTML |
| `src/scripts/pages/atualizarplano.js:727` | `_planLabel()` slug raw | Removido fallback `|| slug` |
| `src/scripts/modules/auth-guard.js` | planName sem whitelist | `_PLAN_WL` whitelist |
| `src/scripts/pages/atualizarplano.js:607` | pdfUrl sem HTTPS | Validação `^https://` |
| `src/scripts/modules/graficos.js` | `_setSafeHTML` incompleto | 12 tags bloqueadas + URI regex |
| `src/scripts/pages/dashboard.js:3531` | sanitizarHTMLPopup incompleto | 6 tags adicionadas |
| 7 Edge Functions | timingSafeEqual early-return | Padrão sem early-return |
| `api/upload-profile-photo.js` | Rate limit userId faltando | `_extractUserId()` + 2º _checkLimit |
| `login.html` | Texto "8 chars" vs validação 10 | Corrigido para "10 caracteres" |
| `webhook-stripe/index.ts` | account_members sem filtro owner | `.eq('owner_user_id', ownerUserId)` |
