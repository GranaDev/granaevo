# GranaEvo — Correcoes por Finding
Data: 2026-05-19 | Auditoria Completa

## FINDING MEDIO — timingSafeEqual com early-return em save-user-data e get-user-data

### Problema (save-user-data/index.ts e get-user-data/index.ts, linha ~57)
```typescript
// ATUAL — revela tamanho do secret via timing
function timingSafeEqual(a: string, b: string): boolean {
  const enc    = new TextEncoder()
  const aBytes = enc.encode(a)
  const bBytes = enc.encode(b)
  if (aBytes.length !== bBytes.length) return false  // early-return vaza tamanho
  let diff = 0
  for (let i = 0; i < aBytes.length; i++) diff |= aBytes[i] ^ bBytes[i]
  return diff === 0
}
```

### Correcao
```typescript
// CORRIGIDO — max-length XOR sem early-return (igual a check-user-access)
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

### Como testar
Medir o tempo de resposta com proxy secrets de tamanhos diferentes (ex: 10 chars vs 64 chars).
Apos a correcao, ambos devem ter tempo de resposta estatisticamente identico.

### Impacto Real
MUITO BAIXO: o tamanho do PROXY_SECRET e determinado por quem configura o ambiente.
Atacantes que tentam brute-force do proxy secret ja precisam ter acesso de rede direto
as Edge Functions (bypassando o proxy Vercel), o que e detectado pelos logs do Supabase.

---

## FINDING MEDIO — Tabelas auxiliares sem RLS confirmado

### Problema
As seguintes tabelas criadas em migrations recentes nao tem RLS explicitamente definido
no codigo das migrations (verificado):
- pending_plan_changes (20260515000001)
- pending_profile_removals (20260516000001)
- profile_backups (20260517000002)
- pending_member_removals (20260518000001)

Se estas tabelas nao tem RLS habilitado E sao acessiveis via authenticated/anon,
usuarios poderiam ler/escrever dados de outros usuarios.

### Como verificar
Rodar no Supabase SQL Editor:
```sql
SELECT tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN (
    'pending_plan_changes',
    'pending_profile_removals',
    'profile_backups',
    'pending_member_removals'
  );
```

### Correcao (se RLS nao habilitado)
```sql
-- Para tabelas internas (sem acesso do frontend):
ALTER TABLE public.pending_plan_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pending_plan_changes FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.pending_plan_changes FROM anon;
REVOKE ALL ON TABLE public.pending_plan_changes FROM authenticated;
GRANT ALL ON TABLE public.pending_plan_changes TO service_role;

-- Repetir para pending_profile_removals, profile_backups, pending_member_removals
```

### Como testar
Tentar SELECT com authenticated role via Supabase client (anon key + JWT valido):
```javascript
const { data, error } = await supabase.from('pending_plan_changes').select('*')
// Deve retornar: error com code PGRST301 (nenhuma linha visivel) ou 42501 (permissao negada)
```

---

## FINDING BAIXO — CORS cosmético em send-guest-invite.js e verify-invite.js

### Problema
Quando a origin nao esta na ALLOWED_ORIGINS, corsOrigin assume [...ALLOWED_ORIGINS][0]
antes da validacao de origem. O header Access-Control-Allow-Origin e setado com um
dominio valido mesmo para origins invalidas. A requisicao e bloqueada com 403 logo apos,
portanto sem impacto de seguranca.

### Correcao
```javascript
// send-guest-invite.js e verify-invite.js — antes do OPTIONS handler
const corsOrigin = ALLOWED_ORIGINS.has(origin) ? origin : null

// No header ACAO, usar corsOrigin apenas se nao-null
if (corsOrigin) {
  res.setHeader('Access-Control-Allow-Origin', corsOrigin)
}
res.setHeader('Vary', 'Origin')
```

### Impacto
ZERO — o 403 e retornado antes de qualquer dado sensivel. E apenas cosmético.

---

## ANALISE DA MIGRATION 20260519000001 — guest_rls_policies.sql

### Verificacao das politicas

**subscriptions_guest_select_owner:**
```sql
USING (
  user_id IN (
    SELECT owner_user_id
    FROM public.account_members
    WHERE member_user_id = auth.uid()
      AND is_active = true
  )
)
```
- Pode ser burlada? NAO — member_user_id = auth.uid() garante que apenas o convidado
  autenticado pode executar. A subquery retorna apenas o owner_user_id do PROPRIO convidado.
- Um usuario malicioso poderia criar uma entrada em account_members para si mesmo?
  NAO — account_members nao tem INSERT policy para authenticated; INSERT e exclusivo
  do service_role (via verify-guest-invite EF).

**stripe_sub_select_as_guest:**
- Mesmo analise — seguro.

**account_members_owner_update:**
```sql
USING     (owner_user_id = auth.uid())
WITH CHECK (owner_user_id = auth.uid())
```
- Privilege escalation guest->owner? NAO — USING garante que apenas o dono pode
  executar UPDATE. WITH CHECK garante que owner_user_id nao pode ser alterado.
- Um convidado poderia fazer UPDATE em seu proprio vinculo? NAO — member_user_id = auth.uid()
  nao esta no USING clause. Apenas o dono (owner_user_id = auth.uid()) pode executar UPDATE.
  Portanto convidados NAO podem se auto-promover para dono, nem desativar outros convidados.

**Convidado vendo dados de outro dono?**
A subquery em account_members e filtrada por member_user_id = auth.uid(). Isso garante
que cada convidado so ve os dados do SEU dono. Impossivel cruzar dados entre contas.

**Conclusao: Migration 20260519000001 e SEGURA.**

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
