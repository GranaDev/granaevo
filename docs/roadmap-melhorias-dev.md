# Roadmap de Melhorias — passo a passo dev
**Contexto:** remediação dos achados do Relatório 360º (2026-07-13). Segurança já está blindada
(0 críticos no `/god-mode`); estas são melhorias de **hardening, performance, higiene de código e
produto**. A intenção é consertar **aos poucos, uma etapa por vez**, juntos.

> Como trabalhamos: cada PASSO é independente na medida do possível e traz **objetivo → por quê →
> passos → risco → como verificar → esforço**. Ao concluir, trocamos o status 🔴/🟡 por ✅ e anotamos
> a data. Sempre rodar `/god-eyes` após qualquer migration (regra do `CLAUDE.md`).

**Ordem sugerida:** Fase 0 (higiene barata, ganha momentum) → Fase 1 (segurança/confiança) →
Fase 2 (performance) → Fase 3 (produto). Não é obrigatório seguir à risca — dá pra pular por vontade.

---

## Legenda de status
`✅ feito` · `🟡 em andamento` · `🔴 a fazer` · `⬜ subtarefa pendente` · `☑️ subtarefa feita`

---

# FASE 0 — Higiene rápida e baixo risco

## PASSO 1 — Rotacionar a anon key para `sb_publishable_` 🟡
**Objetivo:** trocar a chave pública legada (JWT antigo, exp. 2082) pelo formato novo do Supabase.
**Por quê:** não é um segredo (a anon key sempre foi pública), mas o formato novo `sb_publishable_`
é o padrão atual e **rotacionável isoladamente** (dá pra revogar uma key vazada sem invalidar todas
as sessões, como acontece com o JWT legado).

**⚠️ Investigação 2026-07-14 — a anon key aparece em 4 superfícies (não 1):**
1. **CLIENTE (bundle público):** hardcoded em `src/scripts/services/supabase-client.js:27` — **alvo principal**.
2. **SERVIDOR (~12 rotas `api/`):** `process.env.SUPABASE_ANON_KEY` (Vercel + `.env.local`). Não exposto.
   Algumas rotas mandam `Authorization: Bearer ${ANON_KEY}` — a `sb_publishable_` **não é JWT**, então
   esse header precisa ser testado rota a rota.
3. **EDGE (`verify-and-reset-password`):** `Deno.env SUPABASE_ANON_KEY` (secret do Supabase).
4. **TESTES:** literal em `tests/security/security.test.js` e `purple-validator.mjs`.

> A key legada **coexiste** com a nova → rollback instantâneo em todos os estágios. O ganho principal
> (tirar a legada do bundle público) vem já no Estágio 1.

**Estágio 0 — gerar as chaves (VOCÊ, painel):** Supabase → **Project Settings → API Keys** → seção
das novas keys → criar/ativar. Copiar a `sb_publishable_...`. **Não revogar nada.** Legada segue ativa.
- [x] ☑️ `sb_publishable_...` gerada e copiada. **(2026-07-14)**

**Estágio 1 — cliente (EU + deploy):** maior ganho, menor risco.
- [x] ☑️ Trocar o literal em `supabase-client.js` pela `sb_publishable_` (hardcoded). **(2026-07-14)**
      Equivalência com a legada **provada via REST** (REST root / user_data-anon / auth-settings idênticos).
- [x] ☑️ Bundle verificado no **build local**: nova key presente, JWT legado **eliminado** do cliente. **(2026-07-14)**
- [x] ☑️ Deploy em produção (commit `5074ab0`, Vercel Ready) + **smoke OK** (login, dados, transação,
      troca de perfil confirmados pelo usuário). **(2026-07-14)** ✅ **ESTÁGIO 1 COMPLETO**

**Estágio 2 — servidor (EU + você na Vercel):** testar as ~12 rotas.
- [x] ☑️ **Pré-voo provado (2026-07-14):** TODAS as edge functions do app têm `verify_jwt=false` (o gateway
      não valida o Bearer — quem autentica é o `x-proxy-secret`), e o login (`auth-session`) usa a key só
      como `apikey`. Testes REST diretos: verify-recaptcha / verify-guest-invite / check-email-status /
      create-user-account respondem **idêntico** com legada e nova. → drop-in seguro.
- [x] ☑️ Trocado `SUPABASE_ANON_KEY` na Vercel **prod + preview + dev** (preview via `npx vercel@latest`,
      bug do 50.35) e no `.env.local`. **(2026-07-14)**
- [x] ☑️ Redeploy de produção (`vercel --prod`, READY). **(2026-07-14)**
- [x] ☑️ Smoke server-side via curl em `www.granaevo.com`: login inválido → **401 invalid_credentials**
      (não 503); refresh sem cookie → **200 session:null**; verify-recaptcha token falso → **400 success:false**.
      Rotas vivas, env nova ativa. **(2026-07-14)**
- [x] ☑️ **Login real confirmado** pelo usuário (logout + login OK em produção). **(2026-07-14)**
      ✅ **ESTÁGIO 2 COMPLETO.** (reset de senha / cadastro novo = cobertura opcional, não bloqueia)

**Estágio 3 — edge (`verify-and-reset-password`):** única edge function que lê `SUPABASE_ANON_KEY`
(as demais usam `SUPABASE_SERVICE_ROLE_KEY`). Doc oficial confirmada: com as novas keys, o Supabase
injeta `SUPABASE_PUBLISHABLE_KEYS`/`SUPABASE_SECRET_KEYS` (dicionários JSON) nas functions.
- [x] ☑️ **Código pronto (2026-07-14):** `anonKey` agora prefere `SUPABASE_PUBLISHABLE_KEYS['default']`
      com fallback à `SUPABASE_ANON_KEY` (backward-compatible). Commitado.
- [ ] ⬜ **Deploy + teste (pendente):** `supabase functions deploy verify-and-reset-password --no-verify-jwt`
      + testar um reset de senha real (manda e-mail + troca senha → conta descartável). Edge deploya
      SEPARADO do git push (armadilha conhecida).

**Estágio 4 — testes:** remover o JWT legado hardcoded.
- [x] ☑️ **FEITO (2026-07-14):** `security.test.js` (4 refs) + `purple-validator.mjs` (1 ref) agora usam a
      publishable. `git grep` do JWT legado = **vazio** (0 ocorrências no repo). Syntax check OK.

**Estágio 5 — revogação (REBAIXADO p/ baixa prioridade):** 🟢
> **Achado 2026-07-14:** as chaves legadas são `ANON_KEY` **e** `SERVICE_ROLE_KEY`. Como ~20 edge
> functions usam `SUPABASE_SERVICE_ROLE_KEY`, revogar as legadas exigiria migrar TODAS elas para
> `SUPABASE_SECRET_KEYS` — um esforço à parte ("migração service_role → secret"). **O ganho de segurança
> central do Passo 1 (tirar a anon legada do bundle público) JÁ FOI capturado no Estágio 1.** A legada
> restante só vive server-side (não exposta). Então:
- [ ] ⬜ (Opcional, futuro) Fazer a migração service_role → `SUPABASE_SECRET_KEYS` nas edge functions
      como milestone separado, e só então **desativar as legadas** no painel.
- [ ] ⬜ Confirmar no painel se dá pra desativar a legada **anon** independentemente da **service_role**
      (se sim, revogar só a anon fica barato — só depende do Estágio 3 estar deployado).

**Risco:** baixo (E1) → médio (E2/E3). **Esforço:** E0+E1 ~30 min; E2–E5 ~half-day com testes. **Verificar:** app 100% autenticado na nova key; bundle sem o JWT legado; legada revogada só no fim.

---

## PASSO 2 — Consolidar a cópia dupla `src/` × `public/` 🔴
**Objetivo:** eliminar a divergência de `graficos.js` e `recaptcha-init.js` (armadilha conhecida —
duas cópias que saem de sincronia). Fonte única.
**Por quê:** hoje existe `public/scripts/modules/graficos.js` e `public/scripts/modules/recaptcha-init.js`
servidos como estáticos, com risco de divergir da versão em `src/`. Bug silencioso clássico.

- [ ] ⬜ Confirmar quais cópias são **realmente carregadas em produção** (grep nas `*.html` e no build
      do `dist/`): `graficos.js` é UMD lazy carregado por `db-graficos.js`; `recaptcha-init.js` idem.
- [ ] ⬜ Eleger a fonte canônica (provavelmente a de `public/`, por ser servida direta) e **apagar a órfã**.
- [ ] ⬜ Se precisar do processamento do Vite, mover para `src/` e importar; senão, manter só em `public/`
      com um comentário no topo dizendo "fonte única — não duplicar".
- [ ] ⬜ Build + smoke test: gráficos do dashboard renderizam; reCAPTCHA no login/cadastro funciona.

**Risco:** baixo-médio (mexe em arquivos carregados no runtime). **Esforço:** ~1h. **Verificar:** gráficos e reCAPTCHA OK após build. Ver memória `graficos_dual_copy`.

---

## PASSO 3 — Limpar cruft de RLS (migration) 🔴
**Objetivo:** remover políticas permissivas redundantes em `user_data` e dropar 3 funções de trigger órfãs.
**Por quê:** não é falha (políticas permissivas = OR; funções órfãs não são chamadas), mas é **dead code
no banco** que atrapalha auditoria. Higiene.

- [ ] ⬜ Listar as policies redundantes de `user_data` (ex.: `user_data_insert` + `user_data_owner_insert`
      checam a mesma coisa) e as 3 funções de trigger sem trigger conectado.
- [ ] ⬜ Escrever migration `supabase/migrations/AAAAMMDDHHMMSS_cleanup_rls_cruft.sql`:
      `DROP POLICY` das redundantes (mantendo **uma** por operação) + `DROP FUNCTION` das órfãs.
- [ ] ⬜ ⚠️ **Armadilha (memória `db_cleanup_2026_06_26`):** policies load-bearing "somem" no Management
      API — rodar **censo de policies antes e depois** e o data-plane test (impersonação SET LOCAL)
      para provar que cross-user continua bloqueado.
- [ ] ⬜ Aplicar em prod e rodar `/god-eyes`.

**Risco:** médio (mexe em RLS de produção — testar impersonação). **Esforço:** ~1–2h. **Verificar:** censo pós-migration = 1 policy por operação; INSERT/SELECT cross-user ainda negado.

---

## PASSO 4 — Documentar os ~10 crons fora de migration (IaC) 🔴
**Objetivo:** trazer os cron jobs vivos que nasceram fora de migration para o versionamento.
**Por quê:** drift de rastreabilidade — os jobs existem e rodam, mas não estão no repo, então um
disaster-recovery não os recria. **Sem risco de segurança**, é pura governança.

- [ ] ⬜ `SELECT jobid, schedule, command FROM cron.job ORDER BY jobid;` no banco de prod.
- [ ] ⬜ Criar migration **declarativa** `AAAAMMDDHHMMSS_document_existing_crons.sql` com um bloco
      idempotente (`cron.schedule(...)`) para cada job vivo, comentando o que cada um faz.
- [ ] ⬜ Registrar no `schema_migrations` sem re-executar destrutivamente (os jobs já existem;
      `cron.schedule` do mesmo nome faz upsert).
- [ ] ⬜ Remover o cron duplicado se ainda houver (`limpar-rate-limits` vs `granaevo-limpar-rate-limits`).

**Risco:** baixo. **Esforço:** ~1h. **Verificar:** `cron.job` bate 1:1 com a migration; nenhum job duplicado.

---

# FASE 1 — Segurança & confiança

## PASSO 5 — Higiene de `innerHTML` → `textContent` 🔴
**Objetivo:** garantir que **todo texto vindo do usuário** seja inserido via `textContent`, não `innerHTML`.
**Por quê:** hoje há 191 usos de `innerHTML`, **mitigados** pela CSP rígida (sem script inline) + `escapeHtml`.
É defesa em profundidade: mesmo com a CSP, o ideal é o texto do usuário nunca virar HTML.

- [ ] ⬜ Grep `innerHTML` em `src/scripts/` e classificar: (a) **template estático** do dev (seguro,
      pode manter) vs (b) **interpolando dado do usuário** (nome, descrição de transação, meta, etc.).
- [ ] ⬜ Nos casos (b), trocar para `textContent` ou garantir `escapeHtml()` no valor do usuário.
- [ ] ⬜ Focar nos campos de texto livre: nome do perfil, descrição/observação de transação, nomes de
      metas/cartões/contas, nome de convidado.
- [ ] ⬜ (Opcional) adicionar um teste que injeta `<img onerror>` num campo e verifica que sai como texto.

**Risco:** baixo. **Esforço:** ~2–3h (é auditoria, não reescrita grande). **Verificar:** payload `"><b>x</b>` num campo aparece literal, não renderiza.

---

## PASSO 6 — MFA / 2FA por TOTP (GRÁTIS, via Supabase Auth) 🔴 ⭐
**Objetivo:** verificação em duas etapas com app autenticador (Google Authenticator/Authy/etc.).
**Por quê:** blindagem real de conta financeira **+ selo de confiança de marketing**. Custo **R$0** —
TOTP no Supabase é nativo e gratuito em todos os planos (só SMS custa; TOTP não usa SMS).

**Como funciona (resumo técnico):**
- Enroll: `supabase.auth.mfa.enroll({ factorType: 'totp' })` → devolve um **QR code (SVG) + secret**.
- Usuário escaneia no app autenticador → `challenge()` → `verify({ code })` confirma o fator.
- No login: após a senha, checar `getAuthenticatorAssuranceLevel()`; se `nextLevel==='aal2'` e
  `currentLevel==='aal1'`, pedir o código de 6 dígitos → `challenge` + `verify`.

- [ ] ⬜ **Investigar primeiro** como o MFA encaixa na **sessão híbrida httpOnly** do app
      (`login.js` + `api/auth-session.js` + proxy) — este é o ponto sensível, porque a sessão é
      customizada. Mapear antes de codar.
- [ ] ⬜ No painel Supabase → **Authentication**, confirmar que o fator **TOTP** está habilitado.
- [ ] ⬜ UI de **ativação** em Configurações → Segurança (reusar o painel de segurança já existente):
      mostrar QR, campo de código, estados "ativar/desativar 2FA", e **códigos de recuperação**.
- [ ] ⬜ UI de **desafio no login**: tela pedindo o código de 6 dígitos quando a conta tem TOTP.
- [ ] ⬜ (Opcional, forte) exigir `aal2` para operações sensíveis (excluir conta, trocar e-mail, exportar dados).
- [ ] ⬜ Ícone de app autenticador entra no subset FA no `prebuild` se usar algum novo.
- [ ] ⬜ Testar com uma conta descartável: ativar, deslogar, logar pedindo o código, e recuperar via código de backup.

**Risco:** médio (mexe no fluxo de login). **Esforço:** 1–2 dias (a UI + a amarração com a sessão híbrida é a parte grande). **Verificar:** login sem o código é barrado; com o código passa; recuperação funciona.

---

# FASE 2 — Performance

## PASSO 7 — Podar CSS morto + virtualizar listas longas 🔴
**Objetivo:** reduzir o peso do `_db-all.css` (~259 KB fonte) e acelerar telas com muitas linhas.
**Por quê:** `css-unused-candidates.txt` já lista **104 candidatas de 903 classes** (com aviso de
falso-positivo para classes dinâmicas). Listas de transações/relatórios renderizam tudo de uma vez.

- [ ] ⬜ Rodar **DevTools → Coverage** com o dashboard **logado**, navegando por **todas as abas**
      (método autoritativo — o `.txt` estático marca classes dinâmicas `'cat-'+x` como falso-positivo).
- [ ] ⬜ Cruzar Coverage × `css-unused-candidates.txt`; remover só o que der 100% de certeza.
- [ ] ⬜ Rebuild e conferir o guard: `dashboard.css` deve **cair** dentro do orçamento de 66 KB gzip.
- [ ] ⬜ Virtualizar as listas longas (transações, relatórios): renderizar só o que está na viewport
      (windowing simples com `IntersectionObserver` ou slice por página já ajuda muito).

**Risco:** médio (remover CSS errado quebra layout — por isso Coverage logado). **Esforço:** ~half-day. **Verificar:** todas as abas visualmente idênticas; `check-bundle-size` verde; scroll de lista longa fluido no celular.

---

## PASSO 8 — Aliviar os vendors pesados 🔴
**Objetivo:** reduzir Chart (206 KB) e `@supabase/supabase-js` (197 KB).
**Por quê:** dominam o peso de terceiros. **Nuance importante (confirmada no `vite.config.js`):** o
Chart **já é UMD self-hosted carregado sob demanda** por `db-graficos.js` — ele **não** bloqueia o boot.
Então o ganho aqui é menor do que parece; ainda vale, mas com expectativa calibrada.

- [ ] ⬜ **Chart:** avaliar (a) um build só com os tipos de gráfico usados (line/bar/doughnut?) ou
      (b) trocar por lib mais leve (ex.: uPlot/Chartist) **onde o visual permitir**. Manter o lazy-load.
- [ ] ⬜ **Supabase:** já está em chunk próprio (`vendor-supabase`). O SDK v2 tree-shake pouco;
      medir se dá pra usar imports mais granulares (`@supabase/postgrest-js`/`gotrue-js`) só onde faz
      sentido, **sem** reescrever o cliente inteiro (risco > ganho). Se o ganho for pequeno, **documentar
      e parar** — não vale refatorar auth por 20 KB.
- [ ] ⬜ Rodar `ANALYZE=1 npm run build` e abrir `dist/stats.html` para medir antes/depois.

**Risco:** baixo-médio. **Esforço:** ~half-day de investigação; troca de lib de gráfico é maior. **Verificar:** `stats.html` mostra redução; gráficos e queries idênticos.

---

## PASSO 9 — Boot otimista com snapshot cifrado em IndexedDB 🔴
**Objetivo:** renderizar o dashboard **na hora** com o último estado local, sem esperar a rede.
**Por quê:** hoje o boot espera o servidor → tela de loading no celular lento. O padrão já foi provado
pelo **outbox do assistente** e pelo `crypto-store.js` (AES-GCM, chave non-extractable em IndexedDB).
Ganho: tempo percebido despenca + offline-first de brinde.

- [ ] ⬜ Ao carregar dados, salvar um **snapshot cifrado** (reusar o esquema de chave por-usuário) em IndexedDB.
- [ ] ⬜ No boot: se houver snapshot, **pintar a UI otimista** dele imediatamente; buscar do servidor
      em paralelo e **reconciliar** quando chegar (marcar visualmente "atualizando…").
- [ ] ⬜ Invalidar o snapshot em logout / troca de perfil (não vazar dados entre contas no mesmo device).
- [ ] ⬜ Cuidar do caso "servidor tem versão mais nova" → server sempre vence na reconciliação
      (evitar o incidente de wipe — ver memória `data_wipe_incident_2026_06_23`).

**Risco:** médio-alto (mexe no caminho de dados; risco de mostrar dado velho ou vazar entre contas). **Esforço:** 1–2 dias. **Verificar:** 2º load é instantâneo; trocar de perfil não mostra dado do outro; offline abre com o último estado.

---

## PASSO 10 — Quebrar o monólito `dashboard.js` (< 1.500 linhas no boot) 🔴 ⭐
**Objetivo:** tirar do caminho crítico o que hoje são **6.673 linhas** carregadas eager.
**Por quê:** maior gargalo de performance **e** maior smell de manutenção de uma vez só. As abas já são
lazy; falta lazy-ar o **núcleo**. Split já foi avaliado e adiado (orçamento passa), mas é o item nº 1.

- [ ] ⬜ Mapear o que é **realmente eager-necessário** no boot vs o que só roda depois (predicados de
      conquistas, sanitizadores raros, helpers de telas específicas).
- [ ] ⬜ Extrair blocos frios para módulos `import()`-lazy, disparados no idle pós-boot (padrão
      `_bootFeatureModules()` já usado pelos recursos do Radar).
- [ ] ⬜ Manter os **getters vivos do ctx** para que troca de perfil não precise re-init (padrão da
      memória `features_2026_07_08`).
- [ ] ⬜ Rebuild: `dashboard.js` deve **cair bem abaixo** do orçamento de 42 KB gzip; ajustar o budget
      com justificativa no `check-bundle-size.mjs`.

**Risco:** alto (refactor grande no arquivo mais central). Fazer **por último** na fase de perf, em passos pequenos e commits atômicos. **Esforço:** 2–3 dias. **Verificar:** todas as telas funcionam; boot mais leve no `stats.html`; suite de testes verde.

---

# FASE 3 — Produto / diferenciação

## PASSO 11 — Calendário financeiro visual 🔴
**Objetivo:** uma visão de mês/calendário com os eventos financeiros (vencimentos, faturas, recebimentos,
assinaturas) pintados nos dias.
**Por quê:** diferencial visual que ninguém no BR entrega bem, e reusa **dados que já existem** (contas
fixas, faturas, assinaturas do detector, previsão de fim de mês).

- [ ] ⬜ Nova aba lazy (`db-calendario.js`, chunk sob demanda) — nada eager no boot.
- [ ] ⬜ Fonte de dados: reusar os motores de **previsão de fim de mês** + **detector de recorrências**
      + vencimentos de fatura (`fatura_ciclo_vencimento_fix`).
- [ ] ⬜ Grid de mês com marcadores por dia; clique no dia mostra os eventos; navegação mês a mês.
- [ ] ⬜ Sem valores em claro em qualquer push/compartilhamento (regra do Radar).

**Risco:** baixo (feature nova isolada). **Esforço:** 1–2 dias. **Verificar:** eventos batem com as outras telas; performance da aba OK.

---

## PASSO 12 — Share Target no manifest (compartilhar → lançamento) 🔴
**Objetivo:** o app aparece na **folha de compartilhamento** do Android; compartilhar um texto
(ex.: notificação do banco "Compra aprovada R$…") **abre o app já com um lançamento pré-preenchido**.
**Por quê:** reduz o atrito de entrada manual a quase zero e reusa o **parser do assistente** (`chat-parse`).

- [ ] ⬜ No `vite.config.js`, adicionar `share_target` ao `manifest` do VitePWA (method `GET`/`POST`,
      params `title`/`text`/`url`).
- [ ] ⬜ Rota/handler que recebe o texto compartilhado e joga no **parser local** do assistente
      (`parser-local.js`) para virar um lançamento pré-preenchido (usuário confirma).
- [ ] ⬜ ⚠️ Verificar o header `web-share=()` no `vercel.json` — o **inbound** (Share Target) não é
      afetado, mas se for usar `navigator.share` de saída, liberar `web-share=(self)` (memória
      `analise_360_2026_07_11`).
- [ ] ⬜ Testar no Android com o PWA instalado: compartilhar um texto de outro app → GranaEvo aparece
      → abre com o lançamento sugerido.

**Risco:** baixo. **Esforço:** ~1 dia. **Verificar:** GranaEvo aparece na folha de compartilhamento; texto compartilhado vira lançamento.

---

## Resumo — trilha de execução
| Fase | Passo | Prioridade | Esforço | Status |
|---|---|---|---|---|
| 0 | 1 — Rotacionar anon key → `sb_publishable_` | 🟢 baixo | 30 min | ✅ E1–E4 (core); E5 opcional/futuro |
| 0 | 2 — Consolidar cópia dupla src/public | 🟢 baixo | ~1h | 🔴 |
| 0 | 3 — Limpar cruft de RLS (migration) | 🟡 médio | ~1–2h | 🔴 |
| 0 | 4 — Documentar crons fora de migration | 🟢 baixo | ~1h | 🔴 |
| 1 | 5 — Higiene de `innerHTML` | 🟢 baixo | ~2–3h | 🔴 |
| 1 | 6 — MFA/TOTP grátis (Supabase) ⭐ | 🔴 alto valor | 1–2 dias | 🔴 |
| 2 | 7 — Podar CSS morto + virtualizar listas | 🟡 médio | half-day | 🔴 |
| 2 | 8 — Aliviar vendors (Chart/Supabase) | 🟡 médio | half-day+ | 🔴 |
| 2 | 9 — Boot otimista (IndexedDB) | 🔴 alto valor | 1–2 dias | 🔴 |
| 2 | 10 — Split do `dashboard.js` ⭐ | 🔴 alto valor | 2–3 dias | 🔴 |
| 3 | 11 — Calendário financeiro visual | 🟢 baixo | 1–2 dias | 🔴 |
| 3 | 12 — Share Target no manifest | 🟢 baixo | ~1 dia | 🔴 |

> Sugestão de arranque: **Passo 1** (rápido, sem risco, ganha momentum) ou **Passo 6** (o de maior
> valor visível). Me diz por qual começamos e eu conduzo a etapa inteira com você.
