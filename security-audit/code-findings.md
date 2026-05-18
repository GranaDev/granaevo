# God Eyes — Achados de Código
Data: 2026-05-18 | Round 9 — Análise completa pós-features (convites + emails + downgrade)

---

## AUTH-01 — ALTO: Auth-guard overlay usa inline styles (CSP violations em múltiplas páginas)
**Arquivo:** `src/scripts/modules/auth-guard.js:1016` e `:1024`
**Severidade:** ALTO

```javascript
overlay.style.cssText = [...].join(';');   // line 1016 — blocked by style-src
overlay.innerHTML = `
  <div style="max-width:460px;...">         // line 1025 — blocked by style-src
    <div style="...">                        // blocked
```

O overlay de assinatura expirada aplica inline styles via `style.cssText` E via `style=""` attributes em innerHTML. O Chrome bloqueia ambos quando a CSP não tem `'unsafe-inline'` em `style-src`.

**Páginas afetadas:** `/atualizarplano`, `/convidados`, `/planos` — todas sem `'unsafe-inline'`.
**Impacto:** Overlay aparece sem formatação quando assinatura expira nessas páginas. Não é uma vulnerabilidade de segurança, mas quebra a UX de controle de acesso.

**Fix:** Mover todos os estilos do overlay para uma classe CSS e adicionar `'unsafe-inline'` ao style-src das rotas afetadas, OU usar a abordagem já aplicada no dashboard.

---

## AUTH-02 — BAIXO: check-user-access.js loga user_id do body (não do JWT)
**Arquivo:** `api/check-user-access.js:86`
**Severidade:** BAIXO

```javascript
trackSecurityEvent('login_lockout', { ip, user_id: body.user_id?.slice?.(0, 8) })
```

O `user_id` logado no evento de segurança vem do body da requisição, não do JWT verificado. Um atacante pode manipular os logs de segurança enviando um user_id falso no body. O controle de acesso real usa o JWT (correto), mas os logs podem ser enganosos.

**Fix:** Usar o user_id do JWT verificado pela Edge Function. Como o proxy não tem o JWT decodificado, o melhor é remover o user_id do evento de tracking no proxy e deixar a EF logar.

---

## RATE-01 — MÉDIO: Rate limiting in-memory sem Redis
**Arquivo:** `api/_rate-limit.js`
**Severidade:** MÉDIO

O rate limiting usa in-memory Map como fallback quando UPSTASH_REDIS_REST_URL não está configurado. Em ambientes serverless (Vercel), cada instância tem seu próprio contador — um atacante com múltiplos IPs pode contornar limites distribuindo requests entre instâncias.

**Impacto:** Redução da eficácia do rate limiting em ataques distribuídos. Não anula proteção (cada instância ainda bloqueia após o limite), mas torna mais difícil bloquear ataques de volume.

**Fix:** Configurar Upstash Redis para rate limiting centralizado e distribuído. Documentado no código como requisito para produção em escala.

---

## SANITIZE-01 — MÉDIO: Sanitizador HTML customizado em graficos.js
**Arquivo:** `src/scripts/modules/graficos.js:98-139`
**Severidade:** MÉDIO

`_setSafeHTML()` usa um sanitizador custom (DOMParser + remoção de tags + bloqueio de atributos on*). É funcional e razoável, mas:
1. Não é uma biblioteca testada contra mutação XSS (mXSS)
2. SVG é bloqueado explicitamente, mas `<math>` também deve ser monitorado
3. O template element pode ter comportamento diferente em navegadores antigos

**Mitigação já existente:** Tags estruturalmente perigosas bloqueadas, atributos on* removidos, URIs perigosos bloqueados.

**Recomendação:** Avaliar substituição por DOMPurify (3.7KB gzipped, battle-tested).

---

## CSP-01 — BAIXO: atualizarplano e convidados sem 'unsafe-inline' no style-src
**Arquivo:** `vercel.json:140,130`
**Severidade:** BAIXO

As rotas `/atualizarplano` e `/convidados` têm CSP estrita (sem `'unsafe-inline'`). O modal de atualizarplano usa CSS classes (✓), mas a library de gráficos ou auth-guard overlay podem gerar violações.

---

## XSS-01 — VERIFICADO OK: innerHTML em atualizarplano.js
**Arquivo:** `src/scripts/pages/atualizarplano.js:801`
**Severidade:** OK

`modal.innerHTML = \`<div class="gm-step-wrap">${html}</div>\`` — o `html` é gerado pelas funções de render internas que usam `_esc()` em TODOS os dados externos (m.id, m.name, m.email, g.id, g.email). Estrutura estática das templates. Nenhum dado de usuário é interpolado sem escaping.

---

## XSS-02 — VERIFICADO OK: innerHTML em auth-guard.js frozen overlay
**Arquivo:** `src/scripts/modules/auth-guard.js:1024`
**Severidade:** OK para XSS (ALTO para CSP — ver AUTH-01)

`${planName}` no innerHTML está whitelisted:
```javascript
const _PLAN_WL = { individual: 'Individual', casal: 'Casal', familia: 'Família' };
const planName = _PLAN_WL[_rawPlanName?.toLowerCase?.()] ?? 'GranaEvo';
```
Nunca interpola string arbitrária. Seguro para XSS.

---

## XSS-03 — VERIFICADO OK: innerHTML em tutorial.js
**Arquivo:** `src/scripts/modules/tutorial.js:242`
**Severidade:** OK

`p.titulo` e `p.texto` vêm de um array `PASSOS` hardcoded no arquivo, nunca de input do usuário.

---

## REDIRECT-01 — VERIFICADO OK: Open redirect
**Arquivos:** auth-guard.js, convidados.js, login.js
**Severidade:** OK

Todos os redirects usam validação de same-origin ou whitelist explícita de paths:
- `auth-guard.js`: valida `new URL(url, origin).origin === origin`
- `convidados.js`: SafeRedirect com validação de scheme + same-origin
- `login.js`: `getNextRedirect()` valida paths relativos conhecidos

---

## SECRETS-01 — VERIFICADO OK: Secrets e variáveis
**Severidade:** OK

- `.env.local` NÃO rastreado pelo git ✓
- `SUPABASE_ANON_KEY` hardcoded em `convidados.js` — intencional (chave pública) ✓
- `service_role` nunca aparece em arquivos de frontend ✓
- `STRIPE_SECRET_KEY` nunca em código — apenas via `supabase secrets` ✓
- `PROXY_SECRET` nunca exposto em frontend ✓

---

## HEADERS-01 — VERIFICADO OK: Headers de segurança globais
**Arquivo:** `vercel.json:17-53`
**Severidade:** OK

Global (todas as rotas):
- X-Frame-Options: DENY ✓
- X-Content-Type-Options: nosniff ✓
- Referrer-Policy: strict-origin-when-cross-origin ✓
- HSTS: max-age=63072000 (2 anos) + includeSubDomains + preload ✓
- Permissions-Policy: câmera, mic, geo, pagamento bloqueados ✓
- Reporting-Endpoints configurado ✓

---

## INVITE-01 — VERIFICADO OK: Fluxo de convites
**Severidade:** OK

- SHA-256 do código de convite no banco (nunca plaintext) ✓
- Nonce anti-replay com TTL de 2 minutos ✓
- Rate limit duplo (por IP + por email) ✓
- Tempo mínimo de resposta 400ms (dificulta timing attack) ✓
- Rollback de usuário órfão em caso de erro ✓
- `userId` nunca retornado ao frontend ✓
- Mensagem de erro genérica (sem enumeração de emails) ✓

---

## STRIPE-01 — VERIFICADO OK: Webhook Stripe
**Severidade:** OK

- HMAC-SHA256 Stripe signature verificado com timing-safe compare ✓
- Rate limit in-memory para assinaturas inválidas (evita DB flood) ✓
- Idempotência via `stripe_events` table (previne replay) ✓
- `pending_member_removals` com proteção `.neq('member_user_id', ownerUserId)` ✓

---

## GUEST-01 — VERIFICADO OK: Bloqueio server-side de convidados
**Severidade:** OK

`update-stripe-plan` e `preview-stripe-plan` verificam `account_members.member_user_id = user.id` ANTES de qualquer operação. Convidados recebem 403 GUEST_BLOCKED. Defense-in-depth além do frontend auth-guard.

---

## Resumo Código
- Problemas CRÍTICOS: 0
- Problemas ALTOS: 1 (AUTH-01 — overlay CSP)
- Problemas MÉDIOS: 2 (RATE-01, SANITIZE-01)
- Problemas BAIXOS: 1 (AUTH-02)
- Verificados OK: 10+

Escopo: todos os 47 arquivos de código (api/, src/, supabase/functions/, vercel.json, package.json, migrations/)

---

## Achados Round 8

### GOD8-M01 — MÉDIO (CORRIGIDO) — `timingSafeEqual` com early-return em `webhook-cakto`

| Campo | Valor |
|-------|-------|
| Arquivo | `supabase/functions/webhook-cakto/index.ts` |
| Linha | 16 |
| CWE | CWE-208 (Observable Timing Discrepancy) |
| Status | ✅ CORRIGIDO nesta sessão |

**Código vulnerável:**
```ts
if (aBytes.length !== bBytes.length) return false  // timing oracle
```

**Fix aplicado:**
```ts
const len  = Math.max(aB.length, bB.length)
let diff   = aB.length ^ bB.length
for (let i = 0; i < len; i++) diff |= (aB[i] ?? 0) ^ (bB[i] ?? 0)
return diff === 0
```

---

### GOD8-L01 — BAIXO — CSP dashboard permite `data:` em img-src

| Campo | Valor |
|-------|-------|
| Arquivo | `vercel.json` |
| Linha | 100 |
| Status | ⏳ Verificar uso antes de corrigir |

**Trecho:**
```json
"img-src 'self' https://fvrhqqeofqedmhadzzqw.supabase.co data:"
```

**Ação:** Verificar se algum componente do dashboard renderiza `data:image/...`. Se não, remover `data:`.

---

### GOD8-L02 — BAIXO — Rate limiter de upload não usa Redis

| Campo | Valor |
|-------|-------|
| Arquivo | `api/upload-profile-photo.js` |
| Linhas | 44–65 |
| Status | ⏳ Baixa prioridade |

Rate limiter próprio (Map local) em vez de `_rate-limit.js` com Redis. Em deploy multi-instância, efetividade é `limite / N_instâncias`.

---

### GOD8-L03 — BAIXO — `package.json` usa semver range `^`

| Campo | Valor |
|-------|-------|
| Arquivo | `package.json` |
| Status | ⏳ Mitigado por package-lock.json |

`npm ci` usa lock file, então o risco principal está mitigado. Rodar `npm audit` periodicamente.

---

## Achados Anteriores — Todos Corrigidos

### Round 7 — Corrigidos (resumo)

| ID | Severidade | Achado | Status |
|----|-----------|--------|--------|
| GOD7-C01 | CRÍTICO | XSS em atualizarplano.js (m.name/m.email) | ✅ |
| GOD7-A01 | ALTO | `_planLabel()` slug raw da API | ✅ |
| GOD7-A02 | ALTO | planName sem whitelist em auth-guard.js | ✅ |
| GOD7-M01 | MÉDIO | timingSafeEqual early-return em 7 EFs | ✅ |
| GOD7-M02 | MÉDIO | pdfUrl sem validação HTTPS | ✅ |
| GOD7-M03 | MÉDIO | _setSafeHTML incompleto | ✅ |
| GOD7-M04 | MÉDIO | sanitizarHTMLPopup faltando tags | ✅ |
| GOD7-L01 | BAIXO | Rate limit userId em upload | ✅ |
| GOD7-L02 | BAIXO | Texto login "8 chars" vs validação "10" | ✅ |
| GOD7-L03 | BAIXO | webhook-stripe account_members sem filtro | ✅ |

---

## Verificações que passaram (Round 8)

- `eval()` / `new Function()` / `setTimeout(string)` — **zero ocorrências**
- `document.write()` — **zero ocorrências**
- `innerHTML` com dados externos — **todos sanitizados** via `textContent`, `_esc()` ou whitelist
- Secrets hardcoded — **nenhum** (service_role key, Stripe secret: via env vars)
- SQL injection — **zero** (todo acesso via supabase-js parametrizado)
- `auth.uid()` em todas as policies RLS — **confirmado**
- `WITH CHECK` em todos os UPDATE policies — **confirmado**
- `supabase.auth.admin` no frontend — **zero ocorrências**
- `x-proxy-secret` em todas as EFs — **confirmado** (fail-closed quando ausente)
- HMAC-SHA256 no webhook-stripe via raw bytes — **confirmado**
- Timing-safe comparison em todos os paths de auth — **confirmado após fix GOD8-M01**
