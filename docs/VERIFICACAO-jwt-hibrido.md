# Verificação — JWT Híbrido (httpOnly) + CI + slot

Branch: `seguranca/jwt-hibrido-csp-ci`

Este guia descreve **como testar tudo** antes de mergear para `main`. O modelo de
sessão foi reescrito: o **refresh token agora vive só em cookie HttpOnly** (fora do
alcance de XSS) e o **access token vive só em memória**. Login/refresh/logout passam
pelo endpoint `/api/auth-session`.

> ⚠️ Não há mudança de Edge Function nem migration de banco neste conjunto.
> `/api/auth-session` chama o GoTrue (Supabase Auth REST) diretamente.

---

## 0. Pré-requisitos

- Use um **projeto Supabase de STAGING** (os testes criam contas / disparam emails).
- Tenha as env vars do projeto disponíveis para o `vercel dev`:
  `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_EDGE_URL`, `SUPABASE_GET_DATA_EDGE_URL`,
  `SUPABASE_BACKUP_EDGE_URL`, `SUPABASE_PROJECT_REF`, `PROXY_SECRET`, `ALLOWED_ORIGIN`,
  `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` (e demais já usadas).

## 1. Subir o ambiente local (executa as funções de verdade)

```bash
vercel dev            # serve /api/* como Serverless Functions na porta 3000
# abra http://localhost:3000/login
```

`npm run dev` (Vite) **não** serve `/api/*` — use `vercel dev`.

---

## 2. JWT híbrido — o coração da mudança

Abra o DevTools → abas **Network** e **Application**.

| # | Passo | Resultado esperado |
|---|-------|--------------------|
| 2.1 | **Login** com credenciais válidas | `POST /api/auth-session` → `200`; resposta tem `access_token` (sem `refresh_token`). Header `Set-Cookie: ge_rt=...; HttpOnly; Secure; SameSite=Strict; Path=/api/auth-session` |
| 2.2 | **Cookie é HttpOnly** | No console: `document.cookie` **não** contém `ge_rt`. ✅ ponto central |
| 2.3 | **Sem token no disco** | Application → Local Storage / Session Storage: `ge_auth` **não** contém access/refresh token |
| 2.4 | **Redireciona ao dashboard** | Após login bem-sucedido vai para `dashboard.html` e o app carrega normalmente |
| 2.5 | **Reload do dashboard** | Recarregar a página mantém logado (reidrata via `POST /api/auth-session {refresh}` no boot) |
| 2.6 | **Reabrir /login logado** | Abrir `/login` com sessão ativa → redireciona direto ao dashboard |
| 2.7 | **Credencial errada** | `POST /api/auth-session` → `401`, mensagem genérica (não revela se o email existe) |
| 2.8 | **"Lembrar de mim" ON** | Cookie `ge_rt` tem `Max-Age` (≈30 dias) → sobrevive a fechar o browser |
| 2.9 | **"Lembrar de mim" OFF** | Cookie `ge_rt` é de sessão (sem `Max-Age`) → some ao fechar o browser |
| 2.10 | **Logout** (botão sair) | `POST /api/auth-session {logout}` → cookie `ge_rt` apagado (`Max-Age=0`); redireciona a login; **não** volta sozinho ao dashboard |
| 2.11 | **Refresh manual** (console) | `(await fetch('/api/auth-session',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:'{"action":"refresh"}'})).status` → `200` |
| 2.12 | **Expiração / aba dormente** | Deixe a aba em segundo plano > 1h e volte: ao focar, dispara refresh automático e a sessão continua (visibilitychange) |
| 2.13 | **Multi-aba** | Logout em uma aba desloga a outra (BroadcastChannel) |

### Atenção especial (casos que mais podem revelar bug)
- **`supabase.from('stripe_subscriptions')`** em `atualizarplano.html` deve continuar
  retornando dados (usa o access token da memória automaticamente).
- **Overlay de conta cancelada** (FrozenOverlay): se testável, o botão "Sair" deve
  limpar o cookie e ir ao login (agora usa `logout()` real).

---

## 3. Fluxos que usam o token (regressão)

| Fluxo | Onde | Esperado |
|-------|------|----------|
| Salvar dados | dashboard (auto-save) | `POST /api/user-data` `200`; em 403 há 1 retry com token renovado via cookie |
| Upload de foto de perfil | criar perfil no dashboard | `POST /api/upload-profile-photo` `200` (token renovado antes do upload) |
| Aceitar termos | `aceitar-termos.html` | `POST /api/accept-terms` `200` → dashboard |
| Criar conta + checkout | `planos.html` → escolher plano | cria conta, faz login (cookie setado) e redireciona ao Stripe |
| Portal / trocar plano | `atualizarplano.html` | `POST /api/stripe` `200` com `Authorization` válido |
| Trocar senha | configurações | `updateUser` ok. **Observar:** se após trocar a senha um refresh seguinte deslogar, é o Supabase revogando o refresh antigo — comportamento aceitável (basta logar de novo) |

---

## 4. CI (`.github/workflows/security-tests.yml`)

Roda os testes de segurança contra `vercel dev`. Para habilitar, adicione em
**Settings → Secrets and variables → Actions**:

- `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`

O `vercel pull` traz as demais env vars do ambiente **development** do projeto Vercel
vinculado — **configure-o apontando para STAGING** (os testes têm efeitos colaterais).
Gatilho: pull_request para `main` + manual (`workflow_dispatch`).

Rodar a suíte localmente:
```bash
BASE_URL=http://localhost:3000 node --test tests/security/security.test.js
```

---

## 5. Decisões registradas

- **style-src do dashboard:** mantido `'unsafe-inline'`. Medição real: **314** estilos
  inline em `innerHTML` (não ~90). Ganho de removê-lo é marginal — `script-src` já está
  travado e `img-src`/`connect-src 'self'` neutralizam exfiltração via CSS. Migrar 314
  pontos traria alto risco de regressão visual sem ganho proporcional. Reavaliar como
  refactor incremental dedicado, se desejado.
- **Slot Hobby:** `api/queue-email.js` (órfão — sem chamador no app) foi removido junto
  com seus testes para abrir espaço ao `api/auth-session.js`. Total: **12/12 funções**.

---

## 6. Deploy

1. Push da branch → **preview deploy** na Vercel (12 funções, dentro do Hobby).
2. Teste o preview com a seção 2 e 3 acima.
3. **Sem deploy de Edge Function e sem migration** — nada a aplicar no Supabase.
4. Merge para `main` só após o checklist passar.

## 7. Rollback

Reverter o merge/branch restaura 100% do modelo anterior (token em localStorage).
Como nada foi alterado no Supabase, o rollback é puramente de código.
