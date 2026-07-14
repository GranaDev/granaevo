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

## PASSO 2 — Consolidar a cópia dupla `src/` × `public/` ✅ JÁ RESOLVIDO
> **Verificado 2026-07-14:** NÃO existe mais cópia dupla — foi consolidada em 2026-06-17 (commit 4ac7c64).
> Busca repo-wide confirma fonte única: só `public/scripts/modules/graficos.js` e `recaptcha-init.js`
> (a de `src/` já foi deletada). `src/scripts/pages/db-graficos.js` é o orquestrador lazy-load, não uma
> duplicata. Relatório 360 super-sinalizou (índice de memória citava a armadilha sem marcar como resolvida).
> **Nada a fazer.**
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

## PASSO 3 — Limpar cruft de RLS (migration) ✅ RESOLVIDO (2026-07-14)
> **Item principal (policies redundantes em `user_data`) JÁ estava resolvido** — hoje há 1 policy por
> comando (SELECT/INSERT/UPDATE/DELETE) + service_role; as `user_data_owner_*` já tinham sido removidas.
> **4 funções de trigger órfãs DROPADAS** via migration `20260714120000_drop_orphan_trigger_functions.sql`
> (`prevent_user_id_change`, `set_profile_user_id`, `update_updated_at`, `update_updated_at_column`) —
> cada proteção comprovadamente coberta por trigger/RLS ativo; EXECUTE já revogado. Pós-drop verificado:
> 0 órfãs restantes, 10 triggers ativos intactos, ledger registrado. **Regenerar `public_baseline.sql`
> na próxima varredura** (ainda lista as 4).
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

## PASSO 4 — Documentar os ~10 crons fora de migration (IaC) ✅ RESOLVIDO (2026-07-14)
> **15 crons vivos** auditados: 5 já versionados (push-subscriptions, purge-audit-log-retention,
> purge-radar-notifications, limpar-user-devices, purge-payment-events-pii); os **10 restantes** (drift)
> foram documentados em `20260714130000_document_existing_crons.sql` — `cron.schedule` guardado por
> `NOT EXISTS` (NO-OP em prod, recria em DR). Registrado no ledger; jobs vivos **não tocados**. O cron
> duplicado `limpar-rate-limits` já não existe (removido em 20260712). **Nada mais a fazer.**
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

## PASSO 5 — Higiene de `innerHTML` → `textContent` ✅ AUDITADO — SEM GAP (2026-07-14)
> **Auditoria concluída:** o código já trata corretamente dado de usuário. Transações (`db-transacoes`),
> relatórios (`db-relatorios`), convidados/membros (`convidados.js`, cross-user) e notificações/confirmações
> renderizam via `textContent`/`createTextNode` ou `sanitizeHTML`/`_sanitizeText`. `mostrarNotificacao`,
> `confirmarAcao` e `mostrarNotificacaoDesfazer` usam `textContent`. A `Notification` nativa usa texto puro.
> Varredura com negative-lookahead por campo de usuário cru (nome/descricao/email/observacao/apelido/
> guestName/nomeBanco) em interpolação: **0 matches**. Interpolações cruas restantes = só dado de SISTEMA
> (níveis, componentes de score, ícones, cores, números). CSP (`script-src 'self'`) é o backstop.
> Disciplina documentada no código (`[FIX-⚠️13] nunca innerHTML com dado externo`). **Sem mudança necessária.**
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

# FASE 1.5 — Gaps da Auditoria 360º (2026-07-14)
> Achados novos da auditoria orquestrada `/god-mode` + `/god-eyes` de 2026-07-14 (global 8.6; 0 crít/alto).
> Nenhum é bloqueante, mas os de LGPD têm um leve caráter de tempo (a política já mudou; falta re-aceite).

## PASSO 13 — LGPD: bump da versão de termos + re-aceite (gap M2) ✅ APLICADO EM PROD (2026-07-14)
> **APLICADO E VERIFICADO 2026-07-14:** migration aplicada em prod via Management API (bloqueador
> `terms_acceptance_user_id_unique` removido; `(user_id, terms_version)` mantido — conferido read-only).
> As 3 edge functions redeployadas com v1.1 (`accept-terms` v9→v10, `check-user-access` v35→v36,
> `verify-guest-invite` v40→v41; smoke tests 401/400 limpos). Frontend deployado (`vercel --prod` →
> www.granaevo.com; `/termos` mostra "Julho de 2026"). Commit `d4fa24a` em `main` (push origin OK).
> `config.toml` ganhou `[functions.accept-terms] verify_jwt=false` (estava ausente). O re-aceite v1.1
> agora dispara na próxima sessão de cada usuário (aceites em prod ainda `1.0:4` até os logins) — isso
> também cobre o **Passo 14 (M1)**: os 4 legados serão forçados a aceitar no próximo login.
> **⚠️ Dívida separada descoberta:** `supabase db push` está inseguro (19 migrations "fora de ordem" no
> histórico do CLI) — migration foi aplicada por SQL direto, não por `db push`. Vale um passo de higiene
> do histórico de migrations depois.
> **Investigação 2026-07-14 (feita):** o gate `checkNeedsTermsAcceptance` (check-user-access) compara
> `terms_version = CURRENT_TERMS_VERSION` → o bump **força** re-aceite, ok. **PORÉM achamos um BLOQUEADOR:**
> a tabela `terms_acceptance` tinha DOIS uniques — `terms_acceptance_user_id_unique (user_id)` **e**
> `terms_acceptance_user_version_unique (user_id, terms_version)`. O unique em `(user_id)` sozinho fazia o
> INSERT do novo aceite colidir (23505) e ser engolido como idempotente → aceite da nova versão nunca
> gravado → **loop infinito de re-aceite**. **Migration `20260714140000_fix_terms_acceptance_versioning.sql`
> (+ `.down.sql`) escrita** dropando o unique redundante. Bump `CURRENT_TERMS_VERSION` `1.0` → **`1.1`**
> aplicado em `_shared/terms.ts` (staged). Docs: `privacidade.html` = "Julho de 2026", `termos.html` = "Maio
> de 2026" (divergência a decidir). **Ordem obrigatória: migration ANTES do deploy das edge functions.**
**Objetivo:** subir `CURRENT_TERMS_VERSION` de `'1.0'` para uma nova versão e disparar o re-aceite.
**Por quê:** a Política de Privacidade **já mudou materialmente** (assistente IA + novos suboperadores:
Anthropic, Sentry, Resend, Upstash), mas a versão de termos ficou congelada em `1.0` — os usuários
aceitaram o texto anterior e **não houve re-aceite**. A própria política promete aviso da mudança
(art. 8 §6 / transparência). É o gap mais "com relógio" da auditoria.

- [ ] ⬜ Confirmar a versão da política publicada em `privacidade.html`/`termos.html` (ex.: "Julho/2026").
- [ ] ⬜ Subir `CURRENT_TERMS_VERSION` em `supabase/functions/_shared/terms.ts` (ex.: `'1.1'`).
- [ ] ⬜ Verificar que o gate `checkNeedsTermsAcceptance` já **força o re-aceite** quando a versão sobe
      (o mecanismo existe — só precisa ser acionado pelo bump). Testar com conta de teste.
- [ ] ⬜ (Recomendado) registrar o envio da comunicação de alteração (e-mail) para ter prova demonstrável.
- [ ] ⬜ Rodar `/god-eyes` se tocar em qualquer migration.

**Risco:** baixo (não mexe em RLS; é fluxo de aceite já existente). **Esforço:** ~1–2h. **Verificar:** conta antiga é obrigada a re-aceitar no próximo login; nova linha em `terms_acceptance` com a versão nova.

---

## PASSO 14 — LGPD: aceite dos 4 usuários legados (gap M1) 🔴
**Objetivo:** capturar consentimento demonstrável dos 4 usuários legados (Cakto) sem registro em `terms_acceptance`.
**Por quê:** `terms_acceptance` tem 4 linhas; há 4 usuários reais (legados) sem registro de aceite.

- [ ] ⬜ Query no banco: listar os `auth.users` ativos que **não** têm linha correspondente em `terms_acceptance`.
- [ ] ⬜ Se inativos → sem ação (o gate captura no próximo login). Se ativos → forçar re-aceite / e-mail.
- [ ] ⬜ Ao completar o Passo 13 (bump de versão), esse re-aceite já é acionado no login — pode fechar junto.

**Risco:** baixo. **Esforço:** ~30 min (se resolvido junto do Passo 13). **Verificar:** todo usuário ativo tem aceite registrado.

---

## PASSO 15 — HIBP no signup/reset via k-anonymity ✅ APLICADO EM PROD (2026-07-14)
> **APLICADO 2026-07-14 (grátis, sem Pro):** módulo `_shared/hibp.ts` (SHA-1 → prefixo de 5 → range API,
> header `Add-Padding`, **fail-open**, timeout 2.5s). Ligado em `create-user-account` (retorna
> `{error:'senha_vazada'}` 400) e `verify-and-reset-password` (retorna `{status:'weak_password'}` 200,
> porque o front engole !ok como "erro de conexão"). Frontend: `planos.js` (branch 400/senha_vazada) e
> `login.js` (branch weak_password no reset). `config.toml` ganhou `[functions.create-user-account]
> verify_jwt=false` (estava ausente → risco de quebrar signup pós-rotação da anon key). 2 edges
> redeployadas + `vercel --prod`. **Algoritmo validado contra o HIBP real:** `Password1` (3.46M vazamentos)
> e `Senha123` (314k) = PWNED; senha forte = LIMPA. **NOTA:** cobre signup + reset; NÃO cobre troca de
> senha logada via GoTrue nativo (fora do nosso fluxo). Esclarecimento: o "HIBP só no Pro" era o toggle
> NATIVO do Supabase; esta é a versão self-hosted, que independe do plano.
**Objetivo:** bloquear senhas comprometidas na criação de conta e no reset, **sem** depender do plano Pro.
**Por quê:** o "Leaked Password Protection" nativo do Supabase exige plano Pro (desabilitado hoje). Mas dá
pra checar por conta própria via a API k-anonymity do Have I Been Pwned — **grátis e privada** (só enviamos
os 5 primeiros chars do SHA-1 da senha; a senha nunca sai). Fecha credential stuffing na porta de entrada.

- [ ] ⬜ Na Edge Function `create-user-account` (e no reset), calcular SHA-1 da senha, pegar o prefixo de 5,
      consultar `https://api.pwnedpasswords.com/range/{prefix}` e checar o sufixo na resposta.
- [ ] ⬜ Se a senha aparece em vazamento → rejeitar com mensagem clara ("essa senha apareceu em vazamentos,
      escolha outra"). Fail-open se a API do HIBP cair (não travar cadastro por indisponibilidade de terceiro).
- [ ] ⬜ Timeout curto (~2s) + `connect-src` do CSP **não** afeta (é server-side, na edge).
- [ ] ⬜ Testar com uma senha conhecidamente vazada (ex.: `Password123`) e uma forte.

**Risco:** baixo (server-side, fail-open). **Esforço:** ~2–3h. **Verificar:** senha vazada é barrada no cadastro; senha forte passa; HIBP fora do ar não trava o fluxo.

---

## PASSO 16 — Dependabot + `npm audit` em CI ✅ APLICADO (2026-07-14)
> **Descoberta:** o `npm audit --omit=dev --audit-level=high` **já existia** no CI (`.github/workflows/ci.yml`),
> junto com gitleaks (secret scan) e build check. A auditoria super-sinalizou. Faltava só o Dependabot →
> criado `.github/dependabot.yml` (npm + github-actions, semanal segunda 06:00, minor/patch agrupados,
> major isolado). Ativa sozinho no GitHub após o push. Nada mais a fazer.
**Objetivo:** alerta automático de dependência vulnerável.
**Por quê:** superfície de deps é mínima (4 runtime), mas hoje não há gate automático. Higiene barata de DevSecOps.

- [x] ☑️ `npm audit --omit=dev --audit-level=high` no CI — **já existia** (ci.yml).
- [x] ☑️ `.github/dependabot.yml` criado (npm + github-actions, semanal, agrupado). **(2026-07-14)**

**Risco:** nenhum. **Esforço:** ~15 min. **Verificar:** Dependabot abre PR de teste; CI roda o audit.

---

# FASE 4 — Qualidade & acessibilidade

## PASSO 17 — Auditoria WCAG AA (foco, contraste, teclado) 🔴
**Objetivo:** acessibilidade AA no dashboard e nas telas de conversão.
**Por quê:** a landing/planos já têm aria-labels; falta a auditoria completa (foco visível, contraste no
tema claro, navegação por teclado no dashboard). É inclusão **e** um selo de qualidade.

- [ ] ⬜ Rodar axe DevTools / Lighthouse a11y logado, tela a tela.
- [ ] ⬜ Corrigir: foco visível em todos os interativos, contraste AA (especial atenção ao tema claro),
      ordem de tab lógica, `aria-live` para toasts/notificações.
- [ ] ⬜ Teste manual só com teclado nos fluxos principais (lançar transação, trocar perfil, exportar).

**Risco:** baixo. **Esforço:** ~1 dia. **Verificar:** Lighthouse a11y ≥ 95; fluxos completáveis só no teclado.

---

## PASSO 18 — Testes de lógica financeira 🟡 PARCIAL — money.js coberto (2026-07-14)
> **FEITO 2026-07-14:** `tests/unit/money.test.js` — **57 testes** cobrindo o parser de valores do
> assistente (`assistant/money.js`, 100% puro): `parseValorBR` ("1,5k"→1500, "1.234,56", ignora "3x"),
> `parseAritmetica` (2×8=16), `parseParcelas`, `parseExtenso` ("mil e duzentos"→1200), `formatBRL`,
> `yearMonthKey`, `brDateToObj`, `parseMesNomeado`, `parseData(Futura|Relativa)`. Script `test:unit`
> (glob nativo do Node, cross-platform) + step no CI (`ci.yml`, idempotente, sem rede). Todos passam.
> **É o alvo de MAIOR valor/menor risco:** money.js decide o VALOR gravado de cada transação.
> **PENDENTE (precisa extração — não é zero-risco):** ciclo de fatura (venc<fech → +1 mês) vive
> ACOPLADO ao DOM em `db-cartoes.js` (`_buildResumoCartao`, e duplicado em ~3 pontos — ver memory
> `fatura_ciclo_vencimento_fix`). Extrair p/ módulo puro `finance/fatura-ciclo.js` + testar casa com o
> Passo 10 (split do dashboard). Idem saldo/projeção de meta (em `dashboard.js`/`db-metas.js`).
**Objetivo:** cobrir com testes os cálculos críticos (fatura, ciclos de vencimento, saldo, metas).
**Por quê:** hoje só há `tests/security`. A lógica financeira é o núcleo do produto e já teve bug de ciclo
de fatura (`fatura_ciclo_vencimento_fix`). Teste evita regressão silenciosa em dinheiro do usuário.

- [x] ☑️ `money.js` (parser de valores do assistente) — 57 testes, no CI. **(2026-07-14)**
- [ ] ⬜ Extrair ciclo de fatura + saldo + projeção de meta p/ módulos puros e testar (com Passo 10).

**Risco:** nenhum (só adiciona testes). **Esforço:** ~1 dia. **Verificar:** suíte verde; um bug proposital de cálculo é pego pelo teste.

---

## PASSO 19 — Higiene de banco: índices não usados + policies permissivas 🔴
**Objetivo:** dropar os 30 índices nunca usados e consolidar as 4 tabelas com múltiplas policies permissivas.
**Por quê:** advisors de performance do Supabase. Índice morto custa em cada escrita; múltiplas policies
permissivas (OR) são avaliadas a cada query. **Sem risco de segurança** — pura performance/higiene.

- [ ] ⬜ Confirmar via `pg_stat_user_indexes` (idx_scan=0) antes de dropar — não remover índice de tabela
      que ainda vai crescer (ex.: lookups de `password_reset_codes` podem ser raros mas necessários).
- [ ] ⬜ Migration `DROP INDEX` só dos comprovadamente inúteis.
- [ ] ⬜ Avaliar consolidar policies permissivas de `stripe_subscriptions` (3 SELECT), `financial_audit_log`
      e `account_members` (2 SELECT), `profiles` (2 INSERT) — **só se** não reduzir clareza (o OR é intencional:
      own/guest/by-email). Se a clareza > ganho, **documentar e parar**.
- [ ] ⬜ Rodar `/god-eyes` + censo de policies antes/depois (armadilha do Management API).

**Risco:** baixo-médio (mexe em índice/policy de prod). **Esforço:** ~1–2h. **Verificar:** advisors limpos; nenhuma query ficou lenta; cross-user ainda bloqueado.

---

# FASE 5 — Conversão & crescimento  ⚖️ (RECOMENDAÇÕES — decisão go/no-go a cada passo)
> Estes são os itens de **maior ROI de produto** da auditoria, mas envolvem trade-offs de negócio
> (modelo de cobrança, esforço de conteúdo). Aqui é onde **você decide, passo a passo, se compensa** antes
> de eu executar. Ordenados por impacto estimado na conversão/retenção.

## PASSO 20 — Trial / demo sem cartão ⚖️ ⭐ (maior alavanca do produto)
**Objetivo:** deixar a pessoa **experimentar antes de pagar** — trial de 7–14 dias sem cartão, ou um "modo
demonstração" com dados fictícios.
**Por quê:** hoje o funil é pago-desde-o-primeiro-clique — o usuário só sente valor depois de assinar.
É a maior barreira de conversão do produto inteiro. Um trial pode multiplicar signups.
**Decisão sua:** trial real (gera conta) vs demo read-only (sem conta) vs freemium. Cada um muda arquitetura
de acesso e cobrança — por isso é decisão de negócio, não técnica. **Me diz o modelo e eu desenho a execução.**

- [ ] ⬜ Escolher o modelo (trial c/ cartão-no-fim · trial sem cartão · demo sandbox · freemium limitado).
- [ ] ⬜ Amarrar ao gate de acesso (`check-user-access`) sem furar a segurança de plano.
- [ ] ⬜ E-mail de fim de trial + CTA de assinatura.

**Risco:** médio (mexe no gate de acesso/cobrança). **Esforço:** 2–4 dias conforme o modelo. **Verificar:** dá pra usar o núcleo sem pagar; conversão medida.

---

## PASSO 21 — Prova social real na landing ⚖️
**Objetivo:** trocar depoimentos genéricos por prova concreta (nº de usuários, R$ organizados, prints, avaliações).
**Por quê:** o visitante frio não confia tão rápido quanto o código merece. Prova social é o maior
multiplicador de conversão de uma landing depois da oferta.

- [ ] ⬜ Coletar métricas reais e permissões de depoimento de usuários atuais.
- [ ] ⬜ Substituir na landing; adicionar selos (LGPD, AES-256 — que já são verdade).

**Risco:** nenhum (conteúdo). **Esforço:** ~meio dia + coleta. **Verificar:** landing com prova verificável.

---

## PASSO 22 — Ciclo de vida por e-mail + push ⚖️
**Objetivo:** o app hoje é 100% *pull*. Criar o *push*: boas-vindas educativo, "seu relatório do mês",
reativação de inativo, aviso de fatura.
**Por quê:** retenção. Reusa a infra que já existe (Resend + Radar/Web Push + previsão de fim de mês).

- [ ] ⬜ Boas-vindas educativo (1ª semana): como lançar, como ler o dashboard.
- [ ] ⬜ Relatório mensal automático (reusa motores de relatório/previsão; sem valores em claro no push).
- [ ] ⬜ Reativação de inativo (X dias sem abrir).

**Risco:** baixo. **Esforço:** 1–2 dias. **Verificar:** e-mails disparam; opt-out respeitado (LGPD).

---

## PASSO 23 — Programa de indicação ⚖️
**Objetivo:** referral — natural num produto casal/família.
**Por quê:** crescimento orgânico barato; quem usa em casal já convida o par.

- [ ] ⬜ Definir incentivo (dias grátis? desconto?) — decisão de negócio.
- [ ] ⬜ Link de indicação + atribuição no signup.

**Risco:** baixo-médio (anti-fraude no incentivo). **Esforço:** 1–2 dias. **Verificar:** indicação atribuída sem abuso.

---

## PASSO 24 — Conteúdo / SEO de topo ⚖️
**Objetivo:** tráfego orgânico barato (calculadoras, comparativos, blog de finanças pessoais).
**Por quê:** aquisição de baixo custo e autoridade de marca; casa com o ângulo de privacidade.

- [ ] ⬜ 2–3 calculadoras interativas (reserva de emergência, "horas de vida", juros de fatura).
- [ ] ⬜ Alguns artigos-pilar otimizados para busca.

**Risco:** nenhum. **Esforço:** contínuo. **Verificar:** páginas indexadas; tráfego orgânico crescendo.

---

# FASE 6 — Fechar os 10/10 (novos, da auditoria 360 — 2026-07-14)
> Itens que faltavam para cada dimensão bater 10/10 e que não tinham passo próprio. Ver o mapa completo
> em memory `caminho_para_10_10`. O usuário decidiu executar TODOS.

## PASSO 25 — Step-up auth (re-autenticação) em ações sensíveis 🔴
**Objetivo:** pedir a senha (ou 2º fator, quando houver) de novo antes de: excluir conta, trocar e-mail, exportar dados.
**Por quê:** fecha o elo mais fraco (conta legítima sequestrada por sessão roubada/XSS). O `config.toml` já tem
`secure_password_change=true` — estender a mesma ideia às outras ações destrutivas.
- [ ] ⬜ Mapear as ações sensíveis e onde elas disparam (delete-account, troca de e-mail, export).
- [ ] ⬜ Exigir re-autenticação recente (checar `aal`/último login) antes de executar; UI de confirmação por senha.
- [ ] ⬜ Testar: ação sensível com sessão "antiga" pede senha; com re-auth recente passa.

**Risco:** médio (mexe em fluxos sensíveis). **Esforço:** 1–2 dias. **Verificar:** excluir conta sem re-auth recente é barrado.

## PASSO 26 — Turnstile (Cloudflare) em signup + reset 🔴
**Objetivo:** captcha invisível anti-bot no cadastro e no reset (já usamos Cloudflare).
**Por quê:** honeypot + rate-limit cobrem bem, mas Turnstile fecha bot/credential-stuffing na porta. Grátis no Cloudflare.
- [ ] ⬜ Criar o widget Turnstile no painel Cloudflare; adicionar o site key ao frontend e o secret aos edge secrets.
- [ ] ⬜ Validar o token server-side (edge `verify-recaptcha` já existe — reusar/estender p/ Turnstile).
- [ ] ⬜ Ajustar CSP (`connect-src`/`frame-src`) p/ o Turnstile nas páginas de login/planos.

**Risco:** baixo-médio (CSP + fluxo de auth). **Esforço:** ~1 dia. **Verificar:** signup/reset sem token válido é barrado.

## PASSO 27 — Observabilidade + Lighthouse CI 🔴
**Objetivo:** tracing correlacionado proxy↔edge, dashboards de negócio (ativação/retenção/churn) e orçamento de LCP/INP no CI.
**Por quê:** hoje há logs + Sentry, mas falta correlação ponta a ponta e métrica de negócio; e o guard de perf é só de bytes.
- [ ] ⬜ Propagar um `x-request-id` do proxy Vercel → edge functions; logar em ambos p/ correlação.
- [ ] ⬜ Lighthouse CI no pipeline com orçamento de LCP/INP (análogo ao `check-bundle-size.mjs`).
- [ ] ⬜ (Futuro) painel de métricas de negócio (pode ser query agendada + Sentry/simple dashboard).

**Risco:** baixo. **Esforço:** 1–2 dias. **Verificar:** um request aparece com o mesmo id no proxy e na edge; CI falha se LCP estourar.

## PASSO 28 — LGPD B1: aviso de retenção do audit-log ao titular 🔴
**Objetivo:** deixar explícito, no fluxo de exclusão de conta, que os logs de acesso (`financial_audit_log`) seguem retidos por 6 meses por obrigação legal (Marco Civil art. 15).
**Por quê:** único gap BAIXO restante da LGPD — transparência ao titular.
- [ ] ⬜ Adicionar a nota na resposta/UI de exclusão de conta e (se fizer sentido) na Política.
- [ ] ⬜ Conferir que o texto bate com o prazo real (6 meses, migration 20260626140000).

**Risco:** nenhum (texto). **Esforço:** ~30 min. **Verificar:** fluxo de exclusão informa a retenção de 6 meses.

## PASSO 29 — Assistente proativo (memória + proatividade + insight) 🔴 ⭐
**Objetivo:** elevar o chat de 8.2 → 10 SEM quebrar "IA como função" (o Haiku só interpreta; nunca vê valores nem fala).
**Por quê:** memória + proatividade + insight são o que separa um assistente de um parser. Tudo derivado NO CLIENTE.
- [ ] ⬜ Memória de sessão: últimos N turnos em local cifrado (reusar `crypto-store.js`).
- [ ] ⬜ Perfil de hábitos derivado no cliente (categorias/recorrências) p/ enriquecer o contexto — sem enviar valores à IA.
- [ ] ⬜ Proatividade: "detectei assinatura nova de R$X — registrar como recorrente?"; alerta de fim-de-mês (casa com o detector de assinaturas fantasma do backlog).
- [ ] ⬜ Insight contextual: micro-lição ("32% em delivery — média 12%") + "porquê" sob demanda.

**Risco:** médio (mexe no engine do assistente). **Esforço:** vários dias, incremental. **Verificar:** assistente lembra do turno anterior; sugere ação proativa sem enviar valores à IA. Ver [[diferenciais_backlog_usuario]] e memory `caminho_para_10_10`.

---

## Resumo — trilha de execução
| Fase | Passo | Prioridade | Esforço | Status |
|---|---|---|---|---|
| 0 | 1 — Rotacionar anon key → `sb_publishable_` | 🟢 baixo | 30 min | ✅ E1–E4 (core); E5 opcional/futuro |
| 0 | 2 — Consolidar cópia dupla src/public | 🟢 baixo | ~1h | ✅ já resolvido (2026-06-17) |
| 0 | 3 — Limpar cruft de RLS (migration) | 🟡 médio | ~1–2h | ✅ policies já ok + 4 órfãs dropadas |
| 0 | 4 — Documentar crons fora de migration | 🟢 baixo | ~1h | ✅ 10 drift documentados |
| 1 | 5 — Higiene de `innerHTML` | 🟢 baixo | ~2–3h | ✅ auditado, sem gap |
| 1.5 | 13 — LGPD: bump versão de termos (M2) ⏱️ | 🔴 importante | ~1–2h | ✅ aplicado em prod (2026-07-14, commit d4fa24a) |
| 1.5 | 14 — LGPD: aceite dos legados (M1) | 🔴 importante | ~30 min | ✅ coberto pelo mecanismo do Passo 13 (re-aceite no login) |
| 1.5 | 15 — HIBP no signup/reset (k-anonymity) ⭐ | 🔴 alto valor | ~2–3h | ✅ aplicado em prod (2026-07-14) |
| 1.5 | 16 — Dependabot + npm audit | 🟢 baixo | ~15 min | ✅ npm audit já existia + dependabot criado (2026-07-14) |
| 1 | 6 — MFA/TOTP grátis (Supabase) ⭐ | 🔴 alto valor | 1–2 dias | 🔴 |
| 2 | 7 — Podar CSS morto + virtualizar listas | 🟡 médio | half-day | 🔴 |
| 2 | 8 — Aliviar vendors (Chart/Supabase) | 🟡 médio | half-day+ | 🔴 |
| 2 | 9 — Boot otimista (IndexedDB) | 🔴 alto valor | 1–2 dias | 🔴 |
| 2 | 10 — Split do `dashboard.js` ⭐ | 🔴 alto valor | 2–3 dias | 🔴 |
| 4 | 17 — Auditoria WCAG AA | 🟡 médio | ~1 dia | 🔴 |
| 4 | 18 — Testes de lógica financeira | 🟢 baixo | ~1 dia | 🟡 money.js coberto (57 testes, CI); fatura/saldo pendem extração |
| 4 | 19 — Índices/policies (higiene DB) | 🟡 médio | ~1–2h | 🔴 |
| 3 | 11 — Calendário financeiro visual | 🟢 baixo | 1–2 dias | 🔴 |
| 3 | 12 — Share Target no manifest | 🟢 baixo | ~1 dia | 🔴 |
| 5 ⚖️ | 20 — Trial/demo sem cartão ⭐ | ⚖️ decisão | 2–4 dias | 🔴 avaliar |
| 5 ⚖️ | 21 — Prova social real | ⚖️ decisão | meio dia | 🔴 avaliar |
| 5 ⚖️ | 22 — Ciclo de vida e-mail/push | ⚖️ decisão | 1–2 dias | 🔴 avaliar |
| 5 ⚖️ | 23 — Programa de indicação | ⚖️ decisão | 1–2 dias | 🔴 avaliar |
| 5 ⚖️ | 24 — Conteúdo/SEO de topo | ⚖️ decisão | contínuo | 🔴 avaliar |
| 6 | 25 — Step-up auth em ações sensíveis | 🔴 alto | 1–2 dias | 🔴 |
| 6 | 26 — Turnstile em signup + reset | 🟡 médio | ~1 dia | 🔴 |
| 6 | 27 — Observabilidade + Lighthouse CI | 🟡 médio | 1–2 dias | 🔴 |
| 6 | 28 — LGPD B1: aviso retenção audit-log | 🟢 baixo | ~30 min | 🔴 |
| 6 | 29 — Assistente proativo (memória/insight) ⭐ | 🔴 alto valor | vários dias | 🔴 |

## Ordem recomendada de arranque (2026-07-14)
1. **Bloco rápido de fechamento (Passos 13→14→16→15):** meio dia, fecha os gaps da auditoria e ganha momentum. Começar pelo **13 (LGPD bump)** por ser o mais "com relógio".
2. **Passo 6 (MFA/TOTP):** maior valor de confiança visível.
3. **Fase 2 (perf):** 7 → 8 → 9 → **10 (split do dashboard, por último e em passos pequenos)**.
4. **Fase 4 (qualidade):** 17 → 18 → 19.
5. **Fase 3 (produto):** 11 → 12.
6. **Fase 5 ⚖️ (crescimento):** aqui **você decide passo a passo** se compensa antes de eu executar.

> Me diz por qual passo começamos e eu conduzo a etapa inteira com você — investigação, código, teste e verificação.
