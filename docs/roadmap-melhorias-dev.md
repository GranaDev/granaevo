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

## PASSO 7 — Podar CSS morto + virtualizar listas longas 🟡 VIRTUALIZAÇÃO FEITA (2026-07-18) · PODA SEGUE PARQUEADA
> **2026-07-18:** a poda continua parqueada pelos motivos abaixo (que revisei e seguem válidos). Fiz a OUTRA metade: Relatórios montava HTML para TODAS as transações do período sem limite → agora 150 + "Ver todas — mais N". Cuidado essencial: PDF/apresentação CLONAM o DOM, então expandem antes (senão o PDF omitiria transações em silêncio); CSV/Excel leem dados crus e nunca dependeram disso. Transações já paginava.
> **Análise 2026-07-14 (com Coverage real + script novo `scripts/css-coverage-report.mjs`):** medido no
> build — `dashboard.css` = 200 KB fonte / **39 KB gzip, e é ASSÍNCRONO** (media=print + css-boot.js →
> não bloqueia paint) e está em **58% do budget**. Coverage mostrou 25.7% usado, MAS a sessão foi
> incompleta (Relatórios/Configurações/Gráficos = 0%) E a lista estática `css-unused-candidates.txt` está
> **contaminada de classes DINÂMICAS**: `db-relatorios.js` monta `rel-bill-item--${status}`,
> `rel-tx-dot--${dotClass}` etc. em template literals (linhas 1664/1704/1710) — batem exatamente com os
> "candidatos". Pior: classes de valor dinâmico (`rel-bill-item--vencida`) só aparecem "usadas" se o estado
> existir nos dados no momento da captura → Coverage NUNCA limpa 100%. **Veredito: poda é baixo-ROI e
> arriscada (quebraria Relatórios), e o CSS já é async + dentro do budget → não é problema real. PARQUEADO.**
> A ferramenta `css-coverage-report.mjs` fica no repo caso um dia se queira o corte cirúrgico com sessão
> 100% completa. **Virtualização de listas longas:** não abordada; reavaliar se surgir queixa real de scroll.
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

## PASSO 8 — Aliviar os vendors pesados 🟡 INVESTIGADO + GANHO PROVADO (2026-07-17)
> **MEDIDO com `ANALYZE=1 npm run build` + experimento de build descartável.**
>
> **CHART: nada a fazer.** Confirmado que `chart.umd.min.js` (68,2 KB gzip) é asset self-hosted
> separado, carregado só quando a aba Gráficos abre (`db-graficos.js`). **NÃO está no bundle de boot** —
> o `dashboard.html` só faz `modulepreload` de `dashboard.js` (39,1) + `vendor-supabase` (48,6). A
> premissa "Chart pesa no carregamento" já estava resolvida pelo lazy-load. Trocar de lib seria risco
> visual por zero ganho de boot. **Parar aqui.**
>
> **SUPABASE: ganho grande e de baixo risco — PROVADO, mas pendente de teste do usuário.**
> O `vendor-supabase` (48,6 KB gzip, a MAIOR peça única do boot) carrega `realtime-js`, `storage-js` e
> `functions-js` — e o app **não usa nenhum dos três** (confirmado: 0 arquivos com `.storage.`, 0 com
> `.functions.invoke`, e a única "realtime" era `pushManager.subscribe` do Web Push, não Supabase).
> Mas o construtor do `SupabaseClient` faz `new RealtimeClient()` SEMPRE, então tree-shake não remove.
>
> **EXPERIMENTO (descartável, revertido):** alias `@supabase/realtime-js` → stub de 5 métodos no-op
> (`channel`, `getChannels`, `removeChannel`, `removeAllChannels`, `setAuth` — os únicos que o
> SupabaseClient chama). Build limpo. **`vendor-supabase`: 48,6 → 34,2 KB gzip = −14,4 KB no boot
> (−30% do maior chunk).** Sem tocar em auth, sem reescrever cliente.
>
> **POR QUE NÃO DEIXEI NO AR:** o stub fica no caminho do cliente Supabase (auth + DB). Se um update
> futuro do supabase-js chamar um método novo de realtime que o stub não cobre, quebra — e o usuário
> não podia testar auth/DB agora. **Retomar COM teste do usuário:** aplicar o alias + stub (+ pinar a
> versão do supabase-js), rodar login/cadastro/queries de ponta a ponta, e ajustar o budget do
> `check-bundle-size.mjs`. Storage/functions provavelmente saem junto pelo tree-shake ao dropar o
> realtime; medir de novo. **Ganho de ~14 KB no boot vale o teste — é o maior ganho de perf disponível.**
>
> ── objetivo original abaixo ──
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

## PASSO 9 — Boot otimista ✅ FEITO na versão SEGURA (2026-07-19, commit 40f1c22)

> **Decisão tomada com o usuário: o snapshot NÃO entra nos arrays de dados.**
>
> Ao abrir este passo, descobri que metade dele **já existia e tinha sido
> deliberadamente limitada**. O comentário em `dashboard.js` dizia:
> *"é só pintura: NUNCA toca nos arrays de dados nem no save path → impossível
> causar wipe"*. Ou seja: a versão display-only não era preguiça, era projeto.
>
> Levar o snapshot para dentro de `transacoes`/`metas`/`contasFixas` troca uma
> **impossibilidade estrutural** por uma **guarda em tempo de execução**, num app
> que já perdeu dados duas vezes — sempre por corrida entre memória e gravação.
> Agrava que a janela otimista **cresce quanto pior a conexão**: valor e risco
> sobem juntos, e é na conexão lenta que o usuário consegue fazer uma edição que
> o servidor vai sobrescrever em silêncio. **Recusado de propósito.**
>
> **O que foi feito (o ganho real era outro):** o cache de boot gravava saldo,
> entradas e saídas em **texto claro** no `localStorage` — e sobrevivia ao
> logout. O app já cifra o histórico do chat com AES-GCM exatamente porque valor
> financeiro em claro ali estava errado, mas o **saldo** ficava em claro.
> - [x] `modules/boot-cache.js` — AES-GCM, chave não-extraível por usuário
>       (reusa `assistant/crypto-store.js`); purga as chaves v1 na importação.
> - [x] Confere `user_id`/`perfil_id` **dentro do envelope**, não só na chave.
> - [x] `auth-guard`: `logout` e `forceLogout` apagam as duas gerações de chave.
> - [x] Trava `_resumoRealPintado` — decifrar é assíncrono, então a pintura podia
>       resolver DEPOIS do render real e repor número velho por cima do certo.
> - [x] 6 testes novos (fallback sem cripto, purga do texto claro, logout).
>
> **NÃO coberto por teste:** cifrar/decifrar de verdade exige WebCrypto +
> IndexedDB, que não existem no Node. Esse caminho é teste manual no navegador.
>
> **Se um dia alguém quiser o 9 completo**, o que precisa antes: bloquear as
> ações de edição durante a janela otimista (senão a edição perdida é silenciosa)
> e um outbox de escrita — "offline-first de brinde" era otimismo do roadmap,
> escrita offline não sai de graça.

<details><summary>Especificação original (mantida para histórico)</summary>

### PASSO 9 — Boot otimista com snapshot cifrado em IndexedDB 🔴
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

</details>

---

## PASSO 10 — Quebrar o monólito `dashboard.js` (< 1.500 linhas no boot) 🟡 EM ANDAMENTO (2026-07-16)
> **2 fatias seguras feitas (commits f63e9c2, 572b34c): 40,9 → 39,1 KB gzip (97% → 93%).**
> - Fatia 1: exportação JSON/CSV → `modules/exportar-dados.js` lazy (só baixa no clique).
> - Fatia 2: `desenharGraficoLinha`/`desenharTopGastos` eram **código morto** — deletadas.
>
> **PAREI de propósito, não por acabar.** O peso restante está em blocos que NÃO valem o risco
> agora, cada um documentado:
> - **`pagarContaFixa`/`anteciparContaFixa`** (~10 KB): mexem em DINHEIRO. Não extrair sem o
>   usuário poder testar — e no meio do bloco estão `_avancarMes` (usado no boot, linha ~1145) e
>   `rollbackArray` (exposto no ctx hoje p/ db-cartoes).
> - **`_criarPerfilHandler`/`alterarFoto`** (~14 KB): chamam `supabase` direto e mexem em
>   sessão/token/refresh — infra de auth, muito entrelaçada.
> - **painel de alertas** (`renderizarPainelAlertas` + `_criarCard` aninhado, ~13 KB): o caller usa
>   retorno síncrono (`const painelEl = renderizarPainelAlertas()`); extrair exige tornar assíncrono.
>
> **Fatia 3 (2026-07-17):** varredura `knip` — dos 34 "unused exports", só `getById` era morto de
> verdade (removido, commit dd27059). O resto é **falso positivo**: uso interno que o knip não vê
> (`extractPalavrasChave`, `getHorasVida`…) ou ponto cego real (`horaDe` usado internamente,
> `assistant-sw.js` registrado como SW por string). E como o bundler já tree-shake mortos, o ganho
> de apagá-los é limpeza de fonte, **não bytes**.
>
> **2026-07-18 — RETOMADO E AVANÇADO: 41,1 → 39,0 KB, orçamento travado em 40.**
> Extraí o **painel de alertas** para `modules/painel-alertas.js` (chunk lazy de 1,69 KB, só baixa
> no clique do sino) + removi `obterEstatisticas()` (45 linhas mortas, zero referências).
> **O receio registrado abaixo não procedia:** o render NÃO chama pagamento — ele só marca
> `data-acao`/`data-id`, e o despacho para pagar/editar é um listener DELEGADO que continua no
> dashboard. Era código-folha. Orçamento baixado 42 → 40 para o ganho não ser reocupado de novo.
> **Restante avaliado e recusado:** os grandes que sobraram são quentes (`atualizarListaContasFixas`,
> `salvarDados`, `bindEventos`) ou tocam auth/dinheiro. `alterarFoto` seria o próximo frio, mas seus
> helpers de imagem são compartilhados com `_criarPerfilHandler` e `_validarMagicBytes` está no ctx —
> fiaria criação de perfil por ~1,3 KB. **Próximo ganho real de boot é o stub do Realtime (−14,4 KB).**
>
> **Nota anterior (2026-07-16):** **PAREI o Passo 10 em 39,1 KB (de 40,9).** O maior bloco frio restante é o **painel de alertas**
> (`renderizarPainelAlertas` + `_criarCard`, ~12,6 KB, só abre no clique do sino) — MAS não é
> código-folha: os botões dele chamam de volta `abrirPopupPagarContaFixa` (→ pagamento) e
> `abrirContaFixaForm`. Extrair fia uma cadeia que termina em **dinheiro**, e não vale fazer sem o
> usuário poder testar. Os outros grandes (`salvarDados`, `_criarPerfilHandler`, contas-fixas) tocam
> core/auth/dinheiro. **Retomar só com teste do usuário disponível**, um bloco por vez.
>
> **Histórico do objetivo original:** ⭐
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

## PASSO 11 — Calendário financeiro visual ✅ APLICADO EM PROD (2026-07-19)
> Aba lazy (2,72 KB gzip) + `modules/calendario.js` puro com 17 testes. Datas como STRING de ponta a ponta (criar Date p/ comparar dia move o evento de dia por fuso — há teste travando). Reserva/retirada não contam como gasto; assinatura dia 31 cai no último dia de fevereiro; conta paga não entra em "a vencer". Dia com evento é `<button>` com aria-label descritivo.
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

## PASSO 14 — LGPD: aceite dos 4 usuários legados (gap M1) 🟡 GATE ARMADO, ESPERANDO LOGIN
> **Censo no banco de prod (2026-07-16):** 8 usuários em `auth.users`; 5 linhas em `terms_acceptance`
> (**4 na v1.0**, 1 na v1.1). **4 usuários sem NENHUMA linha de aceite — 3 deles ATIVOS** (com
> assinatura ativa/trialing ou membro ativo de conta casal/família).
>
> O gate do Passo 13 (bump p/ `CURRENT_TERMS_VERSION = '1.1'`) cobre os DOIS grupos: quem está na v1.0
> é re-perguntado, e quem não tem linha nenhuma também. Mas o gate só dispara **no login** — ou seja,
> o passo não fecha sozinho: fecha quando essas 3 pessoas entrarem no app. Se alguma nunca mais
> entrar, o consentimento demonstrável dela continua faltando.
>
> **Decisão pendente do usuário:** esperar o login natural (custo zero, prazo indefinido) ou disparar
> e-mail de re-aceite para as 3 contas ativas (fecha o gap com data).
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

## PASSO 17 — Auditoria WCAG AA (foco, contraste, teclado) ✅ FECHADO (2026-07-20)
> Base já estava boa: 0 img sem alt, 0 botão só-ícone sem rótulo, lang/main ok, prefers-reduced-motion tratado, páginas inativas com display:none, `:focus-visible` global. Script varreu todo o CSS atrás de `outline:none` em `:focus` sem substituto → ZERO casos. Feitos: skip link (2.4.1 A), `aria-current="page"` (4.1.2) e o **contraste do tema claro** (2026-07-20, 4920679: tokens de texto já eram AA; faltava a cor fixa usada como texto no calendário — migrada para tokens --cal-c-* com variante Tailwind-700 no claro).
**Objetivo:** acessibilidade AA no dashboard e nas telas de conversão.
**Por quê:** a landing/planos já têm aria-labels; falta a auditoria completa (foco visível, contraste no
tema claro, navegação por teclado no dashboard). É inclusão **e** um selo de qualidade.

- [ ] ⬜ Rodar axe DevTools / Lighthouse a11y logado, tela a tela.
- [ ] ⬜ Corrigir: foco visível em todos os interativos, contraste AA (especial atenção ao tema claro),
      ordem de tab lógica, `aria-live` para toasts/notificações.
- [ ] ⬜ Teste manual só com teclado nos fluxos principais (lançar transação, trocar perfil, exportar).

**Risco:** baixo. **Esforço:** ~1 dia. **Verificar:** Lighthouse a11y ≥ 95; fluxos completáveis só no teclado.

---

## PASSO 18 — Testes de lógica financeira ✅ FECHADO (2026-07-16)
> **FECHADO 2026-07-16 — sem depender do Passo 10.** O pendente era "extrair ciclo de fatura + saldo +
> projeção de meta p/ módulos puros e testar". Os três saíram, cada um junto da feature que os exigia:
> - **ciclo de fatura** → `modules/ciclo-fatura.js` (23 testes, commit `f0377e8`). A extração revelou que
>   a conta estava DUPLICADA e as cópias divergiam: o painel do cartão dizia "Fecha em 31 dias" **no dia
>   do fechamento**. `radar.js` passou a usar o módulo — uma conta, uma implementação.
> - **projeção de meta** → `modules/ritmo-metas.js` (32 testes, commit `03d696f`).
>   `fvComposto`/`mesesParaMeta`/`aporteNecessario` eram cópia local sem teste em `db-metas.js`.
> - **saldo/patrimônio** → `modules/patrimonio.js` + `modules/score-financeiro.js`, já testados.
>
> Suíte total: **189 → 419 testes** na sessão de 2026-07-16. Também entraram `sugestao-corte`,
> `viagem`, `reserva-familia`, `categorizacao`. Todos puros, `hoje` injetável, no CI.
>
> **Histórico:** 🟡 PARCIAL — money.js coberto (2026-07-14)
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
- [x] ☑️ Extrair ciclo de fatura + saldo + projeção de meta p/ módulos puros e testar. **(2026-07-16)**
      Não precisou esperar o Passo 10: cada extração saiu junto da feature que a exigia, e a de fatura
      **achou um bug real em produção** no caminho (ver `ciclo-fatura.js`).

**Risco:** nenhum (só adiciona testes). **Esforço:** ~1 dia. **Verificar:** suíte verde; um bug proposital de cálculo é pego pelo teste.

---

## PASSO 19 — Higiene de banco: índices não usados + policies permissivas ✅ APLICADO EM PROD (2026-07-14)
> **FEITO 2026-07-14 — abordagem criteriosa (não "dropar os 30"):** dropados **12 índices DUPLICADOS**
> (mesma tabela+colunas que uma UNIQUE já cobre) — migration `20260714150000_drop_duplicate_indexes.sql`
> (+`.down`), aplicada via Management API. Reduz amplificação de escrita, destaque p/ `user_data` (tabela
> mais quente) que mantinha **3** índices idênticos de user_id. Verificado read-only: 12 duplicados sumiram,
> 11 coberturas UNIQUE intactas, detector de duplicatas vazio, zero regressão.
> **NÃO dropados** os índices meramente `idx_scan=0` não-duplicados: num app pré-escala isso é "sem tráfego",
> não "inútil" — sustentam RLS/lookup/FK e seriam necessários em escala.
> **Policies permissivas múltiplas (4 tabelas): mantidas de propósito** — NÃO são redundância, são OR de
> caminhos DISTINTOS (audit_log: actor_id≠user_id; stripe: own/email/guest; profiles: own/guest-insert).
> Consolidar reduziria clareza + arriscaria RLS por ganho nulo. Documentado e parado (guidance do próprio passo).
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

## PASSO 25 — Step-up auth (re-autenticação) em ações sensíveis ✅ APLICADO EM PROD (2026-07-18)
> Ao mapear, só UMA das 3 ações existe: **excluir conta**. Trocar e-mail NÃO existe (a função com esse nome gerencia convidados) e exportar dados NÃO existe. Trocar senha já estava coberto por `secure_password_change`. Fix: senha exigida e validada **no servidor** (edge, contra o GoTrue). Armadilha: `api/user-data.js` reconstrói o body — sem incluir `password` a senha era descartada no caminho.
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

## PASSO 27 — Observabilidade + Lighthouse CI 🟡 APLICADO EM PROD (2026-07-18)
> `x-request-id` propagado nas 10 chamadas proxy→edge + ecoado na resposta; edge carimba nos logs. Lighthouse CI com LCP/CLS/TBT como **error** (limiares Core Web Vitals) e scores como **warn** — não foi possível medir a base local (chrome-launcher quebra no Windows), e travar CI com limiar nunca visto seria irresponsável. **INP não entra: é métrica de campo, o Lighthouse em lab não mede — o substituto honesto é TBT.** Falta: dashboards de negócio (depende de serviço externo).
**Objetivo:** tracing correlacionado proxy↔edge, dashboards de negócio (ativação/retenção/churn) e orçamento de LCP/INP no CI.
**Por quê:** hoje há logs + Sentry, mas falta correlação ponta a ponta e métrica de negócio; e o guard de perf é só de bytes.
- [ ] ⬜ Propagar um `x-request-id` do proxy Vercel → edge functions; logar em ambos p/ correlação.
- [ ] ⬜ Lighthouse CI no pipeline com orçamento de LCP/INP (análogo ao `check-bundle-size.mjs`).
- [ ] ⬜ (Futuro) painel de métricas de negócio (pode ser query agendada + Sentry/simple dashboard).

**Risco:** baixo. **Esforço:** 1–2 dias. **Verificar:** um request aparece com o mesmo id no proxy e na edge; CI falha se LCP estourar.

## PASSO 28 — LGPD B1: aviso de retenção do audit-log ao titular ✅ APLICADO EM PROD (2026-07-14) · ⚠️ BASE LEGAL CORRIGIDA (2026-07-16)
> **⚠️ CORREÇÃO 2026-07-16 — a base legal declarada em 14/07 estava ERRADA.**
> O texto dizia "por obrigação legal (Marco Civil art. 15)" e que os registros incluíam **IP**.
> Auditoria LGPD refutou, e o banco confirmou: **`ip_address` e `user_agent` são NULOS em 19.796 de
> 19.796 linhas**. O art. 15 trata de "registro de acesso", que o art. 5º, VIII define como data/hora
> **"a partir de um determinado endereço IP"** — sem IP, o art. 15 **não incide**, e a base "obrigação
> legal" **não existia**. A política prometia um log **mais invasivo do que o que existe**.
> Corrigido em 4 lugares (`privacidade.html` ×2, `RoPA.md`, `db-configuracoes.js`, `delete-account`):
> base agora é **legítimo interesse (LGPD art. 7º, IX)** e o texto diz explicitamente **sem IP**.
> Bônus: a lei estava citada como **12.965/2018** — é **/2014**.
>
> **FEITO 2026-07-14 (histórico):** nota de transparência no modal de exclusão + mensagem da edge
> `delete-account` refinada. A Política já declarava os 6 meses — bate com a migration `20260626140000`.
**Objetivo:** deixar explícito, no fluxo de exclusão de conta, que os logs de acesso (`financial_audit_log`) seguem retidos por 6 meses por obrigação legal (Marco Civil art. 15).
**Por quê:** único gap BAIXO restante da LGPD — transparência ao titular.
- [x] ☑️ Nota no modal de exclusão + mensagem da edge `delete-account`. **(2026-07-14)**
- [x] ☑️ Conferido: Política já declara 6 meses (privacidade.html) e bate com a migration 20260626140000.

**Risco:** nenhum (texto). **Esforço:** ~30 min. **Verificar:** fluxo de exclusão informa a retenção de 6 meses.

## PASSO 29 — Assistente proativo (memória + proatividade + insight) ✅ APLICADO EM PROD (2026-07-18)
> Auditoria antes de construir: memória cifrada, proatividade de abertura e perfil de hábitos JÁ EXISTIAM. Faltavam 2: **micro-lição comparativa** (novo `assistant/insights.js`, 12 testes) e **assinatura não cadastrada** no chat (o motor `recorrencias.js` existia mas só a tela usava). Regra de ouro intacta — nada disso passa pela IA.
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
| 2 | 7 — Podar CSS morto + virtualizar listas | 🟡 médio | half-day | 🟡 analisado — poda baixo-ROI/arriscada, CSS já async+budget → parqueado (2026-07-14) |
| 2 | 8 — Aliviar vendors (Chart/Supabase) | 🟡 médio | half-day+ | 🔴 |
| 2 | 9 — Boot otimista (IndexedDB) | 🔴 alto valor | 1–2 dias | 🔴 |
| 2 | 10 — Split do `dashboard.js` ⭐ | 🔴 alto valor | 2–3 dias | 🔴 |
| 4 | 17 — Auditoria WCAG AA | 🟡 médio | ~1 dia | 🔴 |
| 4 | 18 — Testes de lógica financeira | 🟢 baixo | ~1 dia | 🟡 money.js coberto (57 testes, CI); fatura/saldo pendem extração |
| 4 | 19 — Índices/policies (higiene DB) | 🟡 médio | ~1–2h | ✅ 12 índices duplicados dropados (2026-07-14); policies OR mantidas |
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
| 6 | 28 — LGPD B1: aviso retenção audit-log | 🟢 baixo | ~30 min | ✅ aplicado em prod (2026-07-14) |
| 6 | 29 — Assistente proativo (memória/insight) ⭐ | 🔴 alto valor | vários dias | 🔴 |

## Ordem recomendada de arranque (2026-07-14)
1. **Bloco rápido de fechamento (Passos 13→14→16→15):** meio dia, fecha os gaps da auditoria e ganha momentum. Começar pelo **13 (LGPD bump)** por ser o mais "com relógio".
2. **Passo 6 (MFA/TOTP):** maior valor de confiança visível.
3. **Fase 2 (perf):** 7 → 8 → 9 → **10 (split do dashboard, por último e em passos pequenos)**.
4. **Fase 4 (qualidade):** 17 → 18 → 19.
5. **Fase 3 (produto):** 11 → 12.
6. **Fase 5 ⚖️ (crescimento):** aqui **você decide passo a passo** se compensa antes de eu executar.

> Me diz por qual passo começamos e eu conduzo a etapa inteira com você — investigação, código, teste e verificação.

---

# 🏁 RETA FINAL — backlog consolidado (2026-07-20)

> O usuário declarou: com estes itens resolvidos, o site fica **pronto**. Lista
> viva; ordenada mais fácil → mais difícil no fim desta seção.
> **Legenda de quem faz:** 🤖 = eu, sozinho · 👤 = precisa de você (chave/decisão/teste).

## ✅ Já entregue nesta rodada (2026-07-19/20) — só falta você testar
- **Bugs do teste:** modo viagem some/vaza na troca (2 causas, 3f64d7a) · calendário
  marcava "pago" parcela em aberto (17df90d) · exclusão de lembrete instantânea +
  cabeçalho do calendário centralizado.
- **Lembretes no calendário + 3 avisos (7d/3d/dia) + integração com o chat** (5b8a822).
- **Contraste do calendário no tema claro** (tokens --cal-c-*, Tailwind-700).
- **Categorização em lote + gerenciar regras** ligadas na aba Transações (RF-CAT).

## 🔵 Itens do usuário (2026-07-20) — a fazer

### RF-01 — Texto "X (movimentaçãoões)" 🤖 FÁCIL
Bug de pluralização no rótulo de transações. Corrigir para "1 movimentação" /
"N movimentações". Buscar o template do contador.

### RF-02 — Melhorias da agenda (calendário) 🤖 MÉDIO
Backlog aberto de refinamentos do calendário (a definir com o usuário). Base já no ar.

### RF-03 — Melhoria das notificações + lançamento de transações 🤖 MÉDIO
(a) melhorar a experiência de notificações no app; (b) sugestões para o fluxo de
LANÇAMENTO de transações (mais rápido/inteligente). Escopo a detalhar.

### RF-04 — Foto de perfil: resolução maior + compressão + segurança 🤖 MÉDIO-DIFÍCIL
Hoje a maioria das fotos passa de 2 MB. Precisa: resolução final maior, compressão
mais forte no cliente (canvas/WebP), e validação server-side (magic bytes + tamanho
+ dimensões) — já há upload validado, estender. Cuidar de EXIF/orientação.

### RF-05 — Push que não desativa ao clicar + PWA só notifica com app aberto 👤+🤖 DIFÍCIL (o mais importante deste bloco)
Dois problemas: (a) o toggle "Ativas" não desativa ao clicar (bug de UI/estado);
(b) **o push só chega quando o app abre** — para lembrete, isso o torna inútil.
DIAGNÓSTICO: push REAL em background exige Web Push com Service Worker recebendo
`push` event mesmo com app fechado (VAPID já existe — Radar). Se hoje só notifica
com app aberto, ou o SW não trata `push`, ou a subscription não está registrada,
ou o iOS limita (iOS só entrega Web Push em PWA INSTALADO, 16.4+). Investigar o
`assistant-sw.js`/SW principal + a subscription. É a peça que faz o lembrete valer.

### RF-06 — Melhorias do modo offline 🤖 MÉDIO-DIFÍCIL
Offline-first de leitura (o Passo 9 cifrou o cache de boot). Escrita offline exige
outbox + reconciliação — pesado. Definir alcance.

### RF-07 — Atualização do guia/tutorial 🤖 FÁCIL-MÉDIO
Tutorial/hub desatualizado frente às features novas (calendário, lembretes, viagem,
reservas, categorização em lote). Revisar trilhas.

### RF-08 — Testar "Tempo de Vida" (Horas de Vida) 🤖+👤 FÁCIL
Passar o módulo horas-vida.js a limpo + teste do usuário. Motor puro já testado;
validar o fluxo real.

### 🔴 RF-09 — Restauração de backup reseta TODOS os perfis do plano (VERIFICADO — risco real) 🤖 DIFÍCIL
CONFIRMADO no código: backup/restore é por CONTA (blob inteiro via effectiveUserId),
NÃO por perfil. Um CONVIDADO que restaura resolve para owner_user_id e volta o blob
TODO — todos os perfis de todos do plano, à data do snapshot. O medo do usuário é
válido. Correção real = snapshot/restauração com granularidade por perfil (mexe no
modelo de snapshot). ALTO por segurança de dados; mitigação interina: avisar forte
na UI que restaurar afeta a conta inteira + exigir confirmação.

### RF-10 — Reservas: "Progresso geral" e "Evolução" só após selecionar 🤖 FÁCIL
Hoje os cards aparecem vazios antes de escolher a reserva. Esconder até haver seleção.

## 📌 Anotados para depois (decisão/dependência sua) — 👤
- **Categorização em lote:** ✅ FEITA (RF-CAT) — era "decisão", o usuário mandou ligar.
- **Lighthouse (Passo 27):** roda no CI; relatório na aba Actions do GitHub. Eu não
  consigo ler (gh sem auth aqui). Ver com calma depois.
- **Turnstile (Passo 26):** usuário se ABSTÉM por ora (dor de cabeça de cache com
  Cloudflare no passado). Retomar quando ele quiser; eu configuro com a chave.
- **Re-aceite da Clarice (Passo 14):** só falta claricealexandre (login 03/06, termos
  1.0). Usuário vai pedir o re-aceite. Zero código.
- **Reserva compartilhada por convite (#11/#12):** análise entregue; DECISÃO de
  arquitetura pendente (blob privado 1-escritor × tabela server-readable multi-escritor).
- **Controlador PF/PJ (LGPD):** decisão do titular; destrava política + log com IP.

## 🔽 Ordem sugerida (fácil → difícil) — o que eu faço sozinho (🤖)
1. RF-01 texto plural 🤖 (minutos)
2. RF-10 cards de reserva só após seleção 🤖 (curto)
3. RF-07 tutorial 🤖 (médio, sem risco)
4. RF-08 testar Horas de Vida 🤖+👤
5. RF-02 melhorias da agenda 🤖 (escopo a definir)
6. RF-03 notificações + lançamento 🤖 (escopo a definir)
7. RF-04 foto de perfil (compressão+segurança) 🤖
8. RF-06 modo offline 🤖 (leitura fácil, escrita pesada)
9. RF-05 push em background 👤+🤖 (o mais importante; iOS pode limitar)
10. RF-09 restauração por perfil 🤖 (mais pesado; mexe em snapshot)

---

## ⏸️ STANDBY decidido pelo usuário (2026-07-20) — próximas etapas

### RF-09 + "divisão por perfil" (bloco unificado) — STANDBY
O usuário juntou, com razão, três coisas que compartilham a MESMA raiz: **falta de
granularidade por perfil**.
- RF-09: restauração de backup reverte a conta inteira (deveria ser por perfil).
- Modo viagem e outras configs: hoje no blob por perfil, mas o compartilhamento entre
  perfis/convidados não é limpo.
- Reserva por casal/família: precisa de dado que vive entre perfis.
**Decisão:** tratar TUDO junto num redesenho de "divisão por perfil", depois. Faz
mais sentido do que remendar cada um. Mitigação interina do RF-09 (aviso forte na UI
de restauração) fica para o início desse bloco.

### Passo 6 — MFA — STANDBY (com correção de fato)
Preocupação do usuário: (a) acha que precisa de Supabase Pro; (b) usuários conhecem
mais SMS/e-mail que TOTP.
**Correção factual para quando voltarmos:**
- **TOTP (app autenticador) é GRÁTIS** no Supabase Auth base — NÃO precisa Pro.
- **SMS** é que custa: exige provider (Twilio/MessageBird) e cobra por mensagem.
- **E-mail como 2º fator** não é um método de MFA nativo do Supabase (e-mail lá é
  magic-link/OTP de LOGIN, não 2FA). Daria pra fazer OTP-por-e-mail caseiro, mas é
  código próprio + risco de virar bypass se malfeito.
Recomendação futura: TOTP opcional (grátis, blindado) + talvez OTP-e-mail caseiro
como alternativa amigável, com cuidado de segurança. Familiaridade resolve-se com UX
(QR + passo a passo), não trocando por SMS pago.

### Passo 1 — Revogar anon key legada — STANDBY
Migrar ~20 edge functions service_role→secret e revogar a legada. Sensível; fazer
isolado, função por função. Fica para depois.

---

## 🔴🔴 RF-11 — CRÍTICO (DINHEIRO): pagar a fatura do cartão desconta EM DOBRO

**Relatado com print em 2026-07-20. Prioridade máxima — mexe em saldo real.**

**Sintoma:** ao pagar a fatura do cartão, o app desconta do saldo:
1. o valor pago da fatura (ex.: `Conta Fixa — Fatura Nubank … −R$ 454,71`), **E**
2. **cada item/parcela do cartão separadamente** (`Pagamento Cartão` −28,06,
   −118,40, −9,90, −143,25, −140,00, −133,60 …).

Resultado: **o usuário paga o cartão DUAS vezes** no saldo.

**Comportamento correto (definido pelo usuário):** pagar a fatura deve
- descontar do saldo **somente o valor efetivamente pago** (no caso, 454,71 —
  que pode ser MENOR que a soma dos itens, porque o cartão deu desconto), e
- **marcar todos os itens daquela fatura como pagos**, sem gerar lançamento de
  saída para cada um.

**Nota importante:** o valor pago pode divergir da soma das parcelas (desconto,
juros, pagamento parcial). Então o correto NÃO é "somar os itens" — é usar o
valor pago como a saída única, e os itens viram apenas baixa de status.

**Onde investigar:** `pagarContaFixa` / `anteciparContaFixa` (dashboard.js) e o
fluxo de fatura (`valorAbertoFatura`, `ciclo-fatura`, db-cartoes). ATENÇÃO: é o
bloco que o Passo 10 marcou como "mexe em DINHEIRO — não extrair sem o usuário
poder testar". Exige teste do usuário antes e depois.

**Risco de regressão:** alto. Qualquer correção precisa cobrir: fatura normal,
fatura com desconto, parcelas de meses futuros (não podem ser baixadas junto) e
antecipação.
