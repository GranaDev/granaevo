# God Eyes — Correções
Data: 2026-05-18 | Round 9

---

## FIX-AUTH-01 — ALTO: Auth-guard overlay inline styles (CSP)

**Problema:** `_renderFrozenOverlay()` usa `style.cssText` e `innerHTML` com `style=""` attributes, bloqueados por CSP em páginas sem `'unsafe-inline'`.

**Solução A (recomendada — sem 'unsafe-inline'):** Mover todos os estilos do overlay para a CSS do site e usar apenas classes.

**Solução B (pragmática — mais rápida):** Adicionar `'unsafe-inline'` ao style-src das rotas afetadas.

**Implementação Solução B em `vercel.json`:**

Para `/atualizarplano`:
```json
"style-src 'self' 'unsafe-inline' https://fonts.googleapis.com"
```

Para `/convidados`:
```json
"style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com"
```

Para `/planos`:
```json
"style-src 'self' 'unsafe-inline' https://fonts.googleapis.com"
```

**Como verificar o fix:**
1. Fazer login com conta expirada
2. Acessar `/atualizarplano`
3. O overlay deve aparecer formatado (não como HTML sem CSS)
4. Console não deve ter erros CSP de style-src

**Status:** PENDENTE DE APLICAÇÃO pelo desenvolvedor

---

## FIX-RATE-01 — MÉDIO: Redis para rate limiting distribuído

**Problema:** In-memory rate limiting não compartilhado entre instâncias Vercel serverless.

**Solução:** Configurar Upstash Redis.

1. Criar conta em upstash.com
2. Criar database Redis
3. Adicionar variáveis de ambiente no Vercel:
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`

O código já suporta Redis nativamente em `api/_rate-limit.js`. Nenhuma mudança de código necessária.

**Como verificar:**
Após configurar, `api/_rate-limit.js` exportará `isRedisEnabled = true`. Logar nos primeiros requests para confirmar.

**Status:** PENDENTE DE APLICAÇÃO pelo desenvolvedor

---

## FIX-SANITIZE-01 — MÉDIO: Substituir sanitizador customizado por DOMPurify

**Problema:** `graficos.js` usa sanitizador HTML próprio em vez de biblioteca battle-tested.

**Solução:**
```bash
npm install dompurify
```

Em `src/scripts/modules/graficos.js`, substituir `_setSafeHTML()`:
```javascript
import DOMPurify from 'dompurify'

function _setSafeHTML(element, html) {
    if (!element) return;
    const clean = DOMPurify.sanitize(html, {
        ALLOWED_TAGS: ['div','span','p','strong','em','b','i','br','ul','ol','li','table','thead','tbody','tr','th','td'],
        FORBID_TAGS: ['script','style','iframe','form'],
        FORBID_ATTR: ['style','onerror','onload','onclick'],
    });
    element.innerHTML = '';
    element.innerHTML = clean;
}
```

**Status:** PENDENTE DE APLICAÇÃO pelo desenvolvedor

---

## FIX-AUTH-02 — BAIXO: check-user-access.js — user_id nos logs de segurança

**Problema:** `trackSecurityEvent` loga `user_id` do body (manipulável), não do JWT.

**Solução:** Remover `user_id` do tracking no proxy. A EF já tem o user_id verificado e pode logar separadamente.

Em `api/check-user-access.js`, linha 86:
```javascript
// ANTES:
trackSecurityEvent('login_lockout', { ip, user_id: body.user_id?.slice?.(0, 8) }).catch(() => {})

// DEPOIS:
trackSecurityEvent('login_lockout', { ip }).catch(() => {})
```

**Status:** PENDENTE DE APLICAÇÃO pelo desenvolvedor

---

## Itens Verificados e OK (nenhuma ação necessária)

- ✓ RLS em todas as 14 tabelas de dados
- ✓ FORCE ROW LEVEL SECURITY nas tabelas críticas
- ✓ SECURITY DEFINER functions com REVOKE correto
- ✓ timingSafeEqual em todos os endpoints de proxy secret
- ✓ JWT validado server-side via auth.getUser() (nunca decode manual)
- ✓ Nonces anti-replay no fluxo de convites
- ✓ SHA-256 para códigos de convite no banco
- ✓ Rollback de usuário órfão
- ✓ Bloqueio de convidados em Edge Functions (server-side)
- ✓ Owner protection em remoção de account_members (.neq)
- ✓ Body size limits em todos os proxies
- ✓ CSP por rota com headers globais de segurança
- ✓ HSTS 2 anos + preload
- ✓ .env não rastreado pelo git
- ✓ service_role nunca exposto ao frontend
- ✓ Open redirects bloqueados (same-origin validation)
- ✓ pg_cron para LGPD cleanup (90 dias)

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
