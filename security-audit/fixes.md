# GranaEvo — Correções por Finding
Data: 2026-06-04 | God Mode + God Eyes Ultra

Não há itens CRÍTICO ou ALTO nesta auditoria.

---

## FIX-MED-02 — Pin versão supabase-js em save-push-subscription

**Arquivo:** supabase/functions/save-push-subscription/index.ts, linha 1

**Estado:** PENDENTE DE APLICAÇÃO

**Problema:** `@supabase/supabase-js@2` (mutable) em vez de `@2.49.2` (pinado)

**Correção:**
```typescript
// ANTES:
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// DEPOIS:
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.2'
```

**Como testar:** Deploy e verificar que save-push-subscription ainda funciona.

---

## FIX-MED-03 — Corrigir timingSafeEqual em save-push-subscription

**Arquivo:** supabase/functions/save-push-subscription/index.ts, linhas 88-103

**Estado:** PENDENTE DE APLICAÇÃO

**Problema:** Implementação vaza comprimento do PROXY_SECRET via timing.

**Correção:** Substituir a função inteira pelo padrão usado em todas as outras EFs:

```typescript
// REMOVER (linhas 88-103):
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    const dummy = b.padEnd(a.length, '\0')
    let diff = 0
    for (let i = 0; i < a.length; i++) {
      diff |= a.charCodeAt(i) ^ dummy.charCodeAt(i)
    }
    return false
  }
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

// ADICIONAR (padrão consistente):
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const aB  = enc.encode(a)
  const bB  = enc.encode(b)
  const len = Math.max(aB.length, bB.length)
  let diff  = aB.length ^ bB.length
  for (let i = 0; i < len; i++) diff |= (aB[i] ?? 0) ^ (bB[i] ?? 0)
  return diff === 0
}
```

**Como testar:** Enviar push-subscribe com PROXY_SECRET errado → deve retornar 403. Correto → deve funcionar.

---

## FIX-MED-01 — Remover connect.facebook.net do CSP de /planos

**Arquivo:** vercel.json, linha 86

**Estado:** PENDENTE DE APLICAÇÃO — avaliar necessidade do pixel

**Problema:** `connect.facebook.net` é um script loader dinâmico de terceiros.

**Opção A (remover pixel):**
```json
// ANTES:
"script-src 'self' https://www.googletagmanager.com https://connect.facebook.net https://static.cloudflareinsights.com"

// DEPOIS:
"script-src 'self' https://www.googletagmanager.com https://static.cloudflareinsights.com"
```

**Opção B (migrar para Conversions API):**
Se o pixel do Facebook for necessário para analytics de conversão,
implementar via Facebook Conversions API (server-side) ao invés de pixel client-side.
Isso elimina o script no browser completamente.

**Como testar:** Verificar que conversions ainda são rastreadas (se aplicável).

---

## FIX-LOW-01 — Corrigir CORS OPTIONS em check-user-access

**Arquivo:** api/check-user-access.js, linhas 30-36

**Estado:** PENDENTE DE APLICAÇÃO (baixa prioridade)

**Correção:**
```javascript
// ANTES:
if (req.method === 'OPTIONS') {
  res.setHeader('Access-Control-Allow-Origin',  allowedOrigin ?? ALLOWED_ORIGINS[0])
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  res.setHeader('Vary', 'Origin')
  return res.status(204).end()
}

// DEPOIS:
if (req.method === 'OPTIONS') {
  if (!allowedOrigin) return res.status(403).end()
  res.setHeader('Access-Control-Allow-Origin',  allowedOrigin)
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  res.setHeader('Vary', 'Origin')
  return res.status(204).end()
}
```

---

## FIX-LOW-03 — Adicionar cron job para cleanup_push_subscriptions

**Arquivo:** nova migration (ex: 20260604000001_cleanup_push_cron.sql)

**Estado:** PENDENTE DE APLICAÇÃO

**Correção:**
```sql
-- Migration: 20260604000001_cleanup_push_cron.sql
-- Adiciona cron job para limpar push_subscriptions expiradas

SELECT cron.schedule(
  'granaevo-limpar-push-subscriptions',
  '0 4 * * 0',  -- domingos às 4h UTC
  $$
    DELETE FROM push_subscriptions
    WHERE is_active = false
      AND last_used_at < now() - INTERVAL '90 days';

    DELETE FROM push_subscriptions
    WHERE last_used_at < now() - INTERVAL '180 days';
  $$
);
```

**Como testar:** Verificar `cron.job` no Supabase Dashboard após aplicar.

---

## Rodada 12 — Correções Aplicadas (2026-06-04)

### FIX-HARD-01 — FORCE RLS em stripe_subscriptions

**Estado:** ✅ APLICADO — migration 20260604000001_stripe_subscriptions_hardening.sql

```sql
ALTER TABLE public.stripe_subscriptions FORCE ROW LEVEL SECURITY;
```

---

### FIX-HARD-02 — stripe_sub_select_by_email com verificação de email confirmado

**Estado:** ✅ APLICADO — migration 20260604000001_stripe_subscriptions_hardening.sql

```sql
DROP POLICY IF EXISTS "stripe_sub_select_by_email" ON public.stripe_subscriptions;
CREATE POLICY "stripe_sub_select_by_email"
  ON public.stripe_subscriptions FOR SELECT TO authenticated
  USING (
    lower(user_email) = lower(auth.email())
    AND EXISTS (
      SELECT 1 FROM auth.users u
      WHERE u.id = auth.uid()
        AND u.email_confirmed_at IS NOT NULL
    )
  );
```

---

### FIX-MED-R12-01 — Pin supabase-js em delete-push-subscription

**Arquivo:** supabase/functions/delete-push-subscription/index.ts:1
**Estado:** ✅ APLICADO NESTA SESSÃO

```typescript
// ANTES:
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// DEPOIS:
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.2'
```

---

### FIX-MED-R12-02 — timingSafeEqual correto em delete-push-subscription

**Arquivo:** supabase/functions/delete-push-subscription/index.ts:45-55
**Estado:** ✅ APLICADO NESTA SESSÃO

```typescript
// ANTES (timing oracle de comprimento):
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    const dummy = b.padEnd(a.length, '\0')
    let diff = 0
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ dummy.charCodeAt(i)
    return false  // early-return — oracle de comprimento
  }
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// DEPOIS (idêntico ao padrão GOD-TSE das outras 17 EFs):
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const aB  = enc.encode(a)
  const bB  = enc.encode(b)
  const len = Math.max(aB.length, bB.length)
  let diff  = aB.length ^ bB.length
  for (let i = 0; i < len; i++) diff |= (aB[i] ?? 0) ^ (bB[i] ?? 0)
  return diff === 0
}
```
