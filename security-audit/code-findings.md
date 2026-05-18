# God Eyes — Achados de Código
Data: 2026-05-18 | Round 8 — ULTRA SPECTRUM PENETRATION SCAN v2.0

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
