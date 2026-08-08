# Roadmap de Melhorias — passo a passo dev
**Contexto:** remediação dos achados do Relatório 360º (2026-07-13). Segurança já está blindada
(0 críticos no `/god-mode`); estas são melhorias de **hardening, performance, higiene de código e
produto**. A intenção é consertar **aos poucos, uma etapa por vez**, juntos.

> Como trabalhamos: cada PASSO é independente na medida do possível e traz **objetivo → por quê →
> passos → risco → como verificar → esforço**. O status segue a **Regra de Ouro** logo abaixo —
> 🔴 → 🔵 → 🟡 → ✅, e todo 🟡 diz o que falta. Sempre rodar `/god-eyes` após qualquer migration
> (regra do `CLAUDE.md`).

**Ordem sugerida:** Fase 0 (higiene barata, ganha momentum) → Fase 1 (segurança/confiança) →
Fase 2 (performance) → Fase 3 (produto). Não é obrigatório seguir à risca — dá pra pular por vontade.

> # 🔒 REGRA DE OURO — o status de tudo se escreve assim
>
> **Todo PASSO, todo item e todo subitem tem exatamente UM destes quatro estados.**
> Vale para tarefa e subtarefa, sem exceção.
>
> | | Estado | O que significa |
> |:--:|---|---|
> | 🔴 | **NÃO INICIADO** | Ninguém encostou. |
> | 🔵 | **INICIADO** | Trabalho em andamento. Ainda não dá para usar. |
> | 🟡 | **PENDENTE** | Praticamente pronto — **e é OBRIGATÓRIO escrever `Falta:` dizendo exatamente o que falta.** |
> | ✅ | **FINALIZADO** | Feito, verificado e no ar. Anotar a data e o commit. |
>
> ### As três regras que fazem isso funcionar
>
> **1. 🟡 sem `Falta:` é erro.** Um "quase pronto" que não diz o que falta é exatamente a mentira
> que essa regra existe para matar. Se não souber descrever a pendência, o item não é 🟡 — é 🔵.
>
> **2. Atualizar NA HORA, não no fim.** O status muda no mesmo commit que muda o código. Roadmap
> atualizado "depois" é roadmap desatualizado.
>
> **3. Antes de EXECUTAR um 🔴, prove que ele ainda é 🔴.** Dois minutos: `grep` pelo módulo,
> `curl` na URL, rodar o teste. Se já estiver feito, **corrija a linha aqui primeiro** — é isso
> que impede o próximo (humano ou agente) de cair no mesmo buraco.
>
> *Exceção fora do fluxo:* **⛔ RECUSADO** — decisão explícita de **não fazer**. Não é atraso, é
> escolha, e some da fila. Exige registrar **quem decidiu, quando e por quê** (ver O-5 e P-1).
>
> ### Por que essa regra existe
>
> **Em 2026-07-31, OITO itens marcados 🔴 já estavam prontos:** B-3, B-5, B-7, O-1, O-4, O-8, M-1
> e D-3. O D-3 (detector de assinaturas fantasma) estava implementado, ligado em **três** telas e
> com 13 testes — e seguia listado como "a fazer", descrito como "o mais vendável". O M-1 dizia
> que o `sitemap.xml` retornava 404; retorna 200 há tempos.
>
> Isso não é desorganização inofensiva. Um roadmap que mente sobre o próprio estado faz
> **priorizar errado** (o D-3 era candidato a "próxima grande feature" e já existia) e faz
> **refazer trabalho pronto**. Duas vezes no mesmo dia o documento mandou desfazer decisão que já
> tinha sido tomada — ver O-5 e P-1.

---

## Legenda de status
Os quatro estados da **Regra de Ouro** (topo do documento):

`🔴 não iniciado` · `🔵 iniciado` · `🟡 pendente — com **Falta:**` · `✅ finalizado`

Fora do fluxo: `⛔ recusado` (decisão de não fazer, com autor/data/motivo).
Dentro de um item: `⬜ subtarefa não feita` · `☑️ / ✅ subtarefa feita`.


---

# 📍 ONDE ESTAMOS — fechamento de 2026-08-04

> Sessão longa, com o dono testando em produção e reportando. O que mudou:

**Passos fechados hoje:** 8 (vendors), 12 (⛔ recusado), 26 (captcha no signup),
33 (marketing), 36 (chat C-1..C-8), mais a varredura de código (Sentry ligado de
verdade, reCAPTCHA morto removido, 1 vaga da Vercel liberada).

**Bugs de PRODUÇÃO corrigidos, todos relatados pelo dono:**
- `"tirei 100 da reserva"` entrava como **ENTRADA**. Duas causas: vocabulário
  (12 de 23 formas não eram reconhecidas) e a IA podendo **inverter a direção**
  do dinheiro. Hoje a IA enriquece, nunca inverte.
- Orçamento gravava **gasto falso** de R$500.
- `"meti 100 na poupança"` virava saída; `"vendi o celular por 500"` virava
  saída/Eletrônico.
- Retirada aparecia com tipo **"Salário"** na tela de Transações.
- Balão de resposta **vazio** depois da frase com duas transações.
- `parcelado` e `atacado` não casavam (a 4ª e 5ª ocorrência da armadilha do ``).
- Descrição saía como **"Num paflon"**.
- Botão do assistente **não existia no desktop**.
- Landing: alinhamento do hero, folga e seta dos CTAs, frase que prometia algo
  que não acontecia.

**Capacidades novas:** categorias **Casa** e **Jogos**; conversa livre (cortesia
não vira "não entendi"); memória de conversa; uma frase virando **duas
transações** ("tirei da reserva e paguei o boleto").

**Testes:** 972 → **1008**.

**O que a sessão DEIXOU aberto, e é o mais importante:** o **Lost Update**
(Passo 37). O dono reproduziu: chat e dashboard abertos ao mesmo tempo, um
sobrescreve o outro. É a maior dívida de arquitetura que resta e a única que faz
o app perder dado sem avisar.

**Lições que viraram regra** (custaram tempo hoje):
- Verificar que uma declaração CSS existe ≠ verificar que ela **vence**. Listar
  tudo que casa o seletor e comparar especificidade. (3 rodadas perdidas no CTA.)
- Ausência no código prova "não foi feito", **nunca** "deve ser feito" — cruzar
  sempre com a decisão do dono antes de construir. (Share Target foi construído
  já tendo sido recusado 2×.)
- Vocabulário não se deduz, se **mede**: corpus + controle negativo.
- `git add -A` varre trabalho alheio. Conferir `git status` antes de commitar.

---

# 🧪 FILA DE TESTES MANUAIS — o que só o dono pode verificar

> **Por que esta seção existe.** Vários passos ficam PENDENTES esperando UMA verificação que nenhum teste
> automatizado alcança: precisa de navegador logado, de aparelho, de e-mail real. Espalhados pelos
> passos, esses pedidos somem. Aqui eles ficam juntos, e cada um diz **o que provar**, não só
> "testar". Ao confirmar, marcar ✅ aqui **e** fechar o passo correspondente.

| # | O que testar | Resultado | Passo |
|:--|---|---|:--|
| ✅ 1 | Cadastro com Turnstile | **APROVADO 2026-08-04** | 26 |
| ✅ 2 | Login + tela com dados | **APROVADO** — stubs do Supabase não afetaram auth nem queries | 8 |
| ✅ 3 | Foto de perfil | **APROVADO** — `supabase.storage` intacto | 8 |
| ✅ 4 | Assistente: memória, retirada, cortesia, identidade | **APROVADO** | 36 |
| ✅ 5 | 2FA: ativar · usar · recuperar | **APROVADO 2026-08-04** (C1/C2/C4). Falta só o C3 (desativar) | 6 |
| 🟡 6 | Exportação | **REPROVADO em parte.** **Falta:** aba Transações inexistente, "Perfis" em "-", aba Atividade ilegível → virou o **38.2** | — |
| ✅ 7 | Blocos 3 e 4 (paleta, sino, vitrine) | **APROVADO** — achou 2 problemas na landing, os dois corrigidos | — |
| 🔴 8 | ⭐ Duas abas ao mesmo tempo | **REPROVADO.** Um sobrescreve o outro — Lost Update confirmado. Virou a **FASE 8 / Passo 37** | 37 |
| ✅ 9 | Tipo da retirada ("Salário") | **APROVADO** — corrigido e verificado | — |
| ✅ 10 | ⭐ Uma frase, duas transações | **APROVADO** — retirada + boleto, sem duplicar | 36 |
| 🟡 11 | Entrada + destino ("recebi X e gastei") | **Categoria certa, DESCRIÇÃO errada.** **Falta:** "Outros recebimentos" e "Ele no Mercado" em vez do que o usuário escreveu → virou o **38.1** | 36 |
| 🟡 12 | Categorias Casa e Jogos | **Categoria certa, DESCRIÇÃO com o mesmo defeito do 11** → **38.1** | — |
| ✅ 13 | Orçamento não grava gasto falso | **APROVADO** | — |
| ✅ 14 | Parcelado vira crédito | **APROVADO** | — |
| ✅ 15 | Botão Assistente no desktop | **APROVADO** | — |
| ⬜ 16 | **Depois de tudo:** `node scripts/remove-conta-teste.mjs` | Apaga a conta descartável. **Só no fim** | — |
| ⬜ 17 | **Perfil some no chat:** com 4 perfis, o seletor DENTRO do chat mostra quantos? | Descartado que seja o merge. Falta o dado para diagnosticar → **38.3** | — |

**Ações de configuração:**

| # | O quê | Efeito |
|:--|---|---|
| ✅ A | DSN do Sentry | **FEITO 2026-08-04** — ativo, restrito a `granaevo.com` |
| ✅ B | `supabase functions delete verify-recaptcha` | **FEITO 2026-08-04** |
| ✅ C | Token da Cloudflare | Temporário, expira sozinho dia 06 — mantido para o /god-eyes até lá |

---

# FASE 0 — Higiene rápida e baixo risco

## PASSO 1 — Rotacionar a anon key para `sb_publishable_` ✅ FINALIZADO (2026-07-31)
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

**Estágio 5 — revogação:** ✅ FINALIZADO (2026-07-31) — as legadas estão desativadas desde 2026-07-23 e o fallback saiu das 29 edges (B-6, `fb893af`). O texto abaixo é o raciocínio de julho, mantido como histórico.
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

## PASSO 6 — MFA / 2FA por TOTP (GRÁTIS, via Supabase Auth) ✅ ⭐
> ✅ **NO AR.** Verificado em 2026-08-03 contra o código: `src/scripts/services/mfa-api.js`
> (chunk separado, só baixado por quem tem 2FA ativo), 45 referências a MFA em
> `api/auth-session.js`, e o gate `data?.mfaRequired` no `login.js`. A recuperação por código
> de backup foi **corrigida nesta data** (devolvia "Erro de conexão" quando dava certo).
> A tabela mestre dizia 🔴 — era mentira. O texto de planejamento abaixo fica como registro.
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

## PASSO 7 — Podar CSS morto + virtualizar listas longas 🟡 PENDENTE
**Falta:** decidir o destino das 34 classes `rf-*`/`saude-*` quando as telas planejadas forem construídas ou abandonadas. Virtualização ✅ (2026-07-18, estendida à fatura em 2026-07-31); poda ✅ (2026-07-31, 70 classes + método em `scripts/css-mortas.mjs`). Ver O-2 e O-6 do Passo 32.
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

## PASSO 8 — Aliviar os vendors pesados 🟡 PENDENTE
**Falta:** só a verificação em prod — **um login e uma tela com dados** depois do deploy. É o único jeito de provar que o cliente Supabase seguiu intacto; o resto do passo está feito.

> ### 2026-08-04 — o passo estava contando duas coisas erradas
> **(1) O stub de realtime JÁ ESTAVA NO AR.** O texto abaixo diz *"POR QUE NÃO DEIXEI NO AR"* e
> *"pendente de teste do usuário"*. Falso: o alias está no `vite.config.js` e
> `src/scripts/vendor/realtime-stub.js` existe desde **17/07** — mesmo dia da medição. O ganho de
> **−14,4 KB foi realizado e está em produção há semanas.** Quase refiz trabalho pronto.
>
> **(2) "0 arquivos com `.storage.`" era FALSO — e stubar teria quebrado produção.**
> `dashboard.js:2841` faz `supabase.storage.from('profile-photos').createSignedUrl()`: é o que gera
> a URL assinada da **foto de perfil**. Storage FICA. Há teste travando isso (`vendor-stubs.test.js`),
> porque a próxima pessoa a ler "storage não é usado" ia direto stubar.
>
> ### O que foi feito hoje
> **`functions-js` stubado** (`src/scripts/vendor/functions-stub.js`): **34,3 KB** (era 35,1, −0,8).
> Ganho pequeno, mas de risco praticamente nulo — e o motivo é estrutural: o `FunctionsClient` nasce
> num **getter preguiçoso** (`get functions()`, index.mjs:412), ao contrário do `RealtimeClient`, que
> o construtor instancia SEMPRE. Nada no app lê `supabase.functions` (Edge Functions são chamadas
> pelos proxies em `api/`, server-side) — então o stub nunca é construído. Se alguém passar a usar,
> ele **lança na hora com o motivo escrito**, em vez de devolver um objeto que finge funcionar.
>
> **O teto do orçamento desceu de 40 → 36 KB.** Com 40, a volta do realtime (~48,6) era barrada, mas
> a do functions-js sozinho (35,1) passaria despercebida. Agora as duas quebram o CI.
>
> **O Supabase acabou aqui.** O que resta no chunk é GoTrue (auth) e postgrest (queries) — os dois em
> uso real. Sem polyfill de `node-fetch` viajando (verificado: 0 ocorrências). 8 testes novos travam
> os aliases, a lista exata de símbolos que o SDK importa, o getter preguiçoso e a versão pinada.
>
> ── medição original de 2026-07-17 abaixo ──
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

## PASSO 10 — Quebrar o monólito `dashboard.js` (< 1.500 linhas no boot) 🟡 PENDENTE ⭐

> ⚠️ **PASSOU A SER BLOQUEANTE em 2026-08-07.** O teto de bundle deste arquivo
> foi elevado 40 → 42 KB porque o caminho de save do Passo 37 não tem como ser
> adiado. Já foi tudo que dava para carga sob demanda (lógica de tempo real,
> `diff-registros`, realtime-js). **Não há mais espaço no boot**: a próxima
> feature que precisar de bytes aqui divide o arquivo antes. É a SEGUNDA vez
> que o teto sobe, e a nota de 2026-07-18 previu exatamente isso.
**Falta:** a meta é < 1.500 linhas no boot e o arquivo tem **6.212** (medido em 2026-08-04).
> ⛔ **CONGELADO POR DECISÃO DO DONO (2026-08-04):** *"mexer no dashboard é pisar em ovos"*.
> A varredura de código daquele dia reapontou o arquivo (38,4 KB de 40 = **96% do orçamento**, sem
> folga pra feature nova), e a resposta foi anotar, não fatiar. **Não extrair nada daqui sem pedido
> explícito.** As fatias que restam mexem em dinheiro e em auth — ver a lista abaixo. Hoje está em 38,4 KB gzip de um teto de 40 (96%) — dentro do orçamento, mas sem folga. Fatias já feitas: exportação, código morto, partículas e paleta de comandos (O-1).
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

## PASSO 12 — Share Target no manifest (compartilhar → lançamento) ⛔ RECUSADO
> ⛔ **RECUSADO PELO DONO — NÃO IMPLEMENTAR. Não é pendência.**
>
> O dono recusou **duas vezes**, em sessão anterior, e o roadmap não registrou nenhuma delas:
>
> 1. *"**Passo 12** — Stand-by por hora pois apesar de parecer simples é complexo fazer um sistema
>    ler e entender um comprovante, principalmente pra um 'APP' PWA que nem app de verdade é."*
> 2. *"**Eu não quero o share Target por hora, podemos remove-lo da lista?**"*
>
> **Por que este bloco existe em vez de o passo simplesmente sumir:** em 2026-08-03 ele foi
> implementado e deployado por engano. A Regra de Ouro manda provar que um 🔴 ainda é 🔴 antes de
> executar — e essa prova foi feita **só contra o código** (`grep share_target` → ausente → "logo é
> pendência real"). O código não sabe o que o dono cancelou. Foi revertido no mesmo dia.
>
> **A lição, que vale para TODO o documento:** ausência no código prova "não foi feito", nunca
> "deve ser feito". Decisão do dono só sobrevive se estiver ESCRITA aqui — e um passo apagado da
> lista volta na próxima varredura. Por isso recusa vira ⛔ com a citação, nunca uma linha deletada.
>
> O texto de planejamento abaixo fica como registro histórico. **Não executar.**
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

## PASSO 14 — LGPD: aceite dos 4 usuários legados (gap M1) 🟡 PENDENTE
**Falta:** que os 4 usuários sem aceite façam login — o gate já está armado e coleta o aceite na entrada. Não há trabalho de código; é espera.
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
> **Histórico:** 🟡 PENDENTE — **Falta:** extrair a lógica de fatura/saldo para poder testá-la. money.js coberto (2026-07-14)
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

## PASSO 20 — Trial / demo sem cartão ⛔ RECUSADO
> ⛔ **RECUSADO PELO DONO — não é pendência.** Verbatim (sessão anterior): *"Fase 5
> crescimento: trial, prova social, ciclo de vida, indicação, SEO **Remova da lista pois também
> não quero**, isso apesar de passar credibilidade, hoje em dia pelo menos no Brasil é muito
> artificial."* O texto abaixo fica como registro histórico. **Não executar.**
> ⚠️ **Único ponto de dúvida da Fase 5:** a justificativa ("artificial") fala de prova social; o
> "não quero" cobre a lista inteira. Mantido ⛔ porque foi o que o dono escreveu — reabrir é trocar
> esta linha, e nada mais.
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

## PASSO 21 — Prova social real na landing ⛔ RECUSADO
> ⛔ **RECUSADO PELO DONO — não é pendência.** Verbatim (sessão anterior): *"Fase 5
> crescimento: trial, prova social, ciclo de vida, indicação, SEO **Remova da lista pois também
> não quero**, isso apesar de passar credibilidade, hoje em dia pelo menos no Brasil é muito
> artificial."* O texto abaixo fica como registro histórico. **Não executar.**
> Reafirmado em 2026-08-03: *"Prova social — pois não temos usuários ainda"* (= M-2).
**Objetivo:** trocar depoimentos genéricos por prova concreta (nº de usuários, R$ organizados, prints, avaliações).
**Por quê:** o visitante frio não confia tão rápido quanto o código merece. Prova social é o maior
multiplicador de conversão de uma landing depois da oferta.

- [ ] ⬜ Coletar métricas reais e permissões de depoimento de usuários atuais.
- [ ] ⬜ Substituir na landing; adicionar selos (LGPD, AES-256 — que já são verdade).

**Risco:** nenhum (conteúdo). **Esforço:** ~meio dia + coleta. **Verificar:** landing com prova verificável.

---

## PASSO 22 — Ciclo de vida por e-mail + push ⛔ RECUSADO
> ⛔ **RECUSADO PELO DONO — não é pendência.** Verbatim (sessão anterior): *"Fase 5
> crescimento: trial, prova social, ciclo de vida, indicação, SEO **Remova da lista pois também
> não quero**, isso apesar de passar credibilidade, hoje em dia pelo menos no Brasil é muito
> artificial."* O texto abaixo fica como registro histórico. **Não executar.**
> Reafirmado em 2026-08-03: *"M-4 não, pois vira spam e temos o tutorial dentro do próprio app"*.
**Objetivo:** o app hoje é 100% *pull*. Criar o *push*: boas-vindas educativo, "seu relatório do mês",
reativação de inativo, aviso de fatura.
**Por quê:** retenção. Reusa a infra que já existe (Resend + Radar/Web Push + previsão de fim de mês).

- [ ] ⬜ Boas-vindas educativo (1ª semana): como lançar, como ler o dashboard.
- [ ] ⬜ Relatório mensal automático (reusa motores de relatório/previsão; sem valores em claro no push).
- [ ] ⬜ Reativação de inativo (X dias sem abrir).

**Risco:** baixo. **Esforço:** 1–2 dias. **Verificar:** e-mails disparam; opt-out respeitado (LGPD).

---

## PASSO 23 — Programa de indicação ⛔ RECUSADO
> ⛔ **RECUSADO PELO DONO — não é pendência.** Verbatim (sessão anterior): *"Fase 5
> crescimento: trial, prova social, ciclo de vida, indicação, SEO **Remova da lista pois também
> não quero**, isso apesar de passar credibilidade, hoje em dia pelo menos no Brasil é muito
> artificial."* O texto abaixo fica como registro histórico. **Não executar.**
> Reafirmado em 2026-08-03: *"M5 também não quero programa de indicação"*.
**Objetivo:** referral — natural num produto casal/família.
**Por quê:** crescimento orgânico barato; quem usa em casal já convida o par.

- [ ] ⬜ Definir incentivo (dias grátis? desconto?) — decisão de negócio.
- [ ] ⬜ Link de indicação + atribuição no signup.

**Risco:** baixo-médio (anti-fraude no incentivo). **Esforço:** 1–2 dias. **Verificar:** indicação atribuída sem abuso.

---

## PASSO 24 — Conteúdo / SEO de topo ⛔ RECUSADO
> ⛔ **RECUSADO PELO DONO — não é pendência.** Verbatim (sessão anterior): *"Fase 5
> crescimento: trial, prova social, ciclo de vida, indicação, SEO **Remova da lista pois também
> não quero**, isso apesar de passar credibilidade, hoje em dia pelo menos no Brasil é muito
> artificial."* O texto abaixo fica como registro histórico. **Não executar.**
> **É o mesmo item que o M-3** (3 calculadoras públicas) — que eu apresentei ao dono em 2026-08-03
> como "o único item não-chat que sobrou", sem notar que ele já estava recusado aqui.
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

## PASSO 26 — Turnstile (Cloudflare) em signup + reset ✅ APLICADO (2026-08-04)
> **Feito.** O reset e o login já validavam; faltava o **signup**, que era a única porta do produto
> sem captcha — e a porta **paga**. Antes disto o `send-code` tinha só rate-limit (5/h por IP, 3/h
> por e-mail) e honeypot: segura script bobo, não botnet, onde cada IP pede uma vez e nenhum
> contador chega a disparar.
>
> **Sempre exigido, e não "após N falhas" como no login.** No login existe uma CONTA para ancorar o
> contador; no cadastro não existe nada além do IP — e ancorar no IP faria o gate nunca disparar
> justamente contra o ataque que ele existe para barrar.
>
> **O widget só carrega quando o modal de cadastro abre.** Quem chega em /planos está olhando preço;
> não paga por widget nem por terceiro no caminho.
>
> **Duas extrações, para não duplicar decisão sutil:**
> · `src/scripts/modules/turnstile-state.js` — o estado do widget, que já servia a 2 widgets dentro
>   do login e agora serve 3. Junto foi a invariante que custou produção em 2026-07-30: **callbacks
>   vão como FUNÇÃO, nunca como nome**. Uma cópia divergente reintroduz aquilo em silêncio.
> · `api/_turnstile.js` — a validação server-side. Prefixo `_` porque a Vercel não conta o arquivo
>   como função (o teto de 12 segue em 10). A política de **falhar aberto** agora protege dois
>   caminhos com custos diferentes: no login, trancar o dono fora da conta; no cadastro, fechar a
>   porta paga numa queda da Cloudflare. Em ambos o captcha é a camada de cima, nunca a única.
>
> **Ordem do gate:** depois dos rate limits (locais e baratos — quem estourou a cota não merece uma
> ida à rede) e antes do envio do e-mail (é o disparo que se quer impedir).
>
> **CSP:** `challenges.cloudflare.com` liberado em `script-src`, `connect-src` e **`frame-src`** (o
> widget roda em iframe; com `'none'` ele não aparece e o console não explica direito) — nas DUAS
> declarações, `<meta>` do `planos.html` e header do `/planos` no `vercel.json`. O navegador aplica
> a interseção: liberar só numa continua bloqueando.
>
> ⚠️ **Armadilha ao conferir num build local:** sem `VITE_TURNSTILE_SITE_KEY`, o Vite torna
> `CAPTCHA_SITE_KEY` uma constante vazia e **todo o render some por tree-shaking** — `grep` no
> `dist/` dá zero e parece que nada subiu. Em prod a env var existe (verificada no bundle do login).
> Para ver de verdade: `VITE_TURNSTILE_SITE_KEY=... npm run build`.
>
> 16 testes novos (872 no total). **Nenhuma env var nova**: o `TURNSTILE_SECRET_KEY` já estava na
> Vercel e a site key já vinha do build.
>
> ── plano original abaixo ──
**Objetivo:** captcha invisível anti-bot no cadastro e no reset (já usamos Cloudflare).
**Por quê:** honeypot + rate-limit cobrem bem, mas Turnstile fecha bot/credential-stuffing na porta. Grátis no Cloudflare.
- [ ] ⬜ Criar o widget Turnstile no painel Cloudflare; adicionar o site key ao frontend e o secret aos edge secrets.
- [ ] ⬜ Validar o token server-side (edge `verify-recaptcha` já existe — reusar/estender p/ Turnstile).
- [ ] ⬜ Ajustar CSP (`connect-src`/`frame-src`) p/ o Turnstile nas páginas de login/planos.

**Risco:** baixo-médio (CSP + fluxo de auth). **Esforço:** ~1 dia. **Verificar:** signup/reset sem token válido é barrado.

## PASSO 27 — Observabilidade + Lighthouse CI 🟡 APLICADO EM PROD (2026-07-18)
> `x-request-id` propagado nas 10 chamadas proxy→edge + ecoado na resposta; edge carimba nos logs. Lighthouse CI com LCP/CLS/TBT como **error** (limiares Core Web Vitals) e scores como **warn** — não foi possível medir a base local (chrome-launcher quebra no Windows), e travar CI com limiar nunca visto seria irresponsável. **INP não entra: é métrica de campo, o Lighthouse em lab não mede — o substituto honesto é TBT.** Falta: dashboards de negócio (depende de serviço externo).
**Objetivo:** tracing correlacionado proxy↔edge, dashboards de negócio (ativação/retenção/churn) e orçamento de LCP/INP no CI.
**Por quê:** falta correlação ponta a ponta e métrica de negócio; e o guard de perf é só de bytes.
> ⚠️ **A frase anterior aqui dizia "hoje há logs + Sentry". Era falsa** — descoberto na varredura de
> 2026-08-04. O `error-tracking.js` (170 linhas, importado por 4 páginas, com `@sentry/browser`
> instalado) compilava em produção para **`async function n(){}function t(n){}`**: duas funções
> vazias. Sem `VITE_SENTRY_DSN`, todo o corpo era ramo morto e o bundler descartava. **O app nunca
> teve visibilidade de erro em produção.**
>
> **Corrigido em 2026-08-04** (código pronto e testado, 21 testes):
> · **Contradição removida:** o comentário dizia "sem rastreamento de performance" e o código ligava
>   `browserTracing` com 10% de amostragem. Agora é só erro — `integrations: []`,
>   `autoSessionTracking: false`, `sendDefaultPii: false`. Tracing mandaria a URL de cada navegação
>   e cada request pra um operador nos EUA, em troca de quase nada.
> · **A peneira que faltava:** o `beforeSend` limpava só o envelope (cookies, headers). O TEXTO do
>   erro saía inteiro — e é ali que o dinheiro aparece ("falha ao salvar R$ 1.234,56 de
>   fulano@email.com"). Agora mensagem, valor de exceção e breadcrumb passam por `_limpar`
>   (R$ → `[valor]`, e-mail → `[email]`, número de 6+ dígitos → `[num]`), e URLs perdem query e hash.
>   Número curto sobrevive de propósito: "status 500" é o que ajuda a depurar.
> · **O e-mail parou de ser passado** no `dashboard.js` — a função sempre o descartou, mas ler
>   `email:` ali dava a impressão contrária.
> · **`clearUserContext` foi ligado ao `logout`** (nunca era chamado): em aparelho compartilhado,
>   os erros de quem entrasse depois sairiam agrupados sob quem saiu.
> · **Peso:** com a DSN ativa o SDK são 132 KB gzip (era 142; `__SENTRY_TRACING__`/`__SENTRY_DEBUG__`
>   em `false` no `vite.config.js` podaram 10). Carrega **no ocioso**, não no boot — mas com dois
>   listeners baratos instalados ANTES, que enfileiram (teto 10) e despejam no SDK quando ele chega.
>   Sem isso, adiar o carregamento perderia justamente os erros de boot, que são os piores.
>
> **Falta:** a **DSN** — só o dono pode criar. `sentry.io` → projeto **Browser JavaScript** → copiar
> a DSN → `vercel env add VITE_SENTRY_DSN production` → redeploy. Enquanto não existir, o módulo
> segue inerte **por projeto**, não por defeito. O Sentry **já está declarado** em `privacidade.html`
> §04/§05 e no RoPA como operador nos EUA — ativar torna a declaração verdadeira; hoje ela descreve
> um tratamento que não acontece. Falta também o painel de métricas de negócio (serviço externo).
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
| 1 | 6 — MFA/TOTP grátis (Supabase) ⭐ | 🔴 alto valor | 1–2 dias | ✅ no ar — `mfa-api.js` + `auth-session.js` (45 refs) + login.js; recovery corrigido em 2026-08-03 |
| 2 | 7 — Podar CSS morto + virtualizar listas | 🟡 médio | half-day | 🟡 **Falta:** destino das 34 classes de telas planejadas — poda e método feitos em 2026-07-31 |
| 2 | 8 — Aliviar vendors (Chart/Supabase) | 🟡 médio | half-day+ | 🟡 **Falta:** só um login em prod pós-deploy — realtime+functions stubados, 48,6 para 34,3 KB |
| 2 | 9 — Boot otimista (IndexedDB) | 🔴 alto valor | 1–2 dias | 🔴 |
| 2 | 10 — Split do `dashboard.js` ⭐ | 🔴 alto valor | 2–3 dias | 🔴 |
| 4 | 17 — Auditoria WCAG AA | 🟡 médio | ~1 dia | 🔴 |
| 4 | 18 — Testes de lógica financeira | 🟢 baixo | ~1 dia | 🟡 **Falta:** extrair fatura/saldo para testar; money.js coberto (57 testes, CI) |
| 4 | 19 — Índices/policies (higiene DB) | 🟡 médio | ~1–2h | ✅ 12 índices duplicados dropados (2026-07-14); policies OR mantidas |
| 3 | 11 — Calendário financeiro visual | 🟢 baixo | 1–2 dias | ✅ no ar — `modules/calendario.js` + `db-calendario.js` (lazy) + nav e seção no dashboard.html + testes |
| 3 | 12 — Share Target no manifest | 🟢 baixo | ~1 dia | ⛔ RECUSADO pelo dono (2×) — não é pendência |
| 5 ⚖️ | 20 — Trial/demo sem cartão ⭐ | ⚖️ decisão | 2–4 dias | 🔴 avaliar |
| 5 ⚖️ | 21 — Prova social real | ⚖️ decisão | meio dia | 🔴 avaliar |
| 5 ⚖️ | 22 — Ciclo de vida e-mail/push | ⚖️ decisão | 1–2 dias | 🔴 avaliar |
| 5 ⚖️ | 23 — Programa de indicação | ⚖️ decisão | 1–2 dias | 🔴 avaliar |
| 5 ⚖️ | 24 — Conteúdo/SEO de topo | ⚖️ decisão | contínuo | 🔴 avaliar |
| 6 | 25 — Step-up auth em ações sensíveis | 🔴 alto | 1–2 dias | 🔴 |
| 6 | 26 — Turnstile em signup + reset | 🟡 médio | ~1 dia | ✅ signup + reset + login (2026-08-04) |
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

### ✅ RF-11 CORRIGIDO (2026-07-20) + ⚠️ RF-12 aberto (reversão)

**Fix aplicado:** pagar a fatura NÃO gera mais uma saída por item. A saída é uma
só — a da própria fatura, com o valor pago. Cada parcela apenas muda de STATUS
(paga) e devolve limite ao cartão. Corrigido nos DOIS caminhos: pagamento normal
e antecipação. O pagamento de parcela AVULSA (db-cartoes) segue gerando uma
transação, e está certo — ali é um pagamento único de verdade.

Confirmação com os números do usuário: itens somavam R$ 573,21 e a fatura era
R$ 454,71 (desconto do cartão) — prova de que somar itens estaria errado; o
correto é debitar o valor pago.

**⚠️ RF-12 (aberto, consequência do fix):** excluir a transação do pagamento da
fatura NÃO reverte as parcelas para "não paga". Antes, as saídas por item tinham
essa reversão (D3, em db-transacoes, via faturaId+compraId); agora elas não
existem. Não há reversão por `contaFixaId`.
Efeito: apagar o lançamento da fatura devolve o dinheiro ao saldo, mas as
parcelas continuam marcadas como pagas — estado incoerente.
**Correção proposta:** estender a reversão D3 para transações com `contaFixaId`
apontando a uma `fatura_cartao`: desmarcar as parcelas quitadas naquele
pagamento e reabrir a fatura. NÃO implementado agora de propósito — é código de
dinheiro e precisa de teste do usuário antes de ir ao ar.

### RF-02 — REMOVIDO (2026-07-20)
Usuário avaliou as sugestões de melhoria da agenda e considerou o calendário
suficiente como está. Fora do escopo.

### RF-03 — escopo definido (2026-07-20): itens 1, 3 e 5
Do menu de sugestões, o usuário escolheu:
1. **Resumo semanal** (ex.: domingo à noite) — "semana que vem vencem N contas, R$ X".
3. **Conquista/marco** — avisar quando bate meta de reserva / marco relevante.
5. **Silêncio inteligente** — teto de 1 push/dia, agrupando eventos, e nada em dia
   sem novidade. É o item que evita o "massante": hoje o Radar dispara por evento.

⚠️ **PRÉ-REQUISITO:** os três geram/entregam via `radar_notifications` + push. Não
adianta construí-los antes de UM push chegar de verdade no aparelho — foi
exatamente construir sobre base não verificada que fez a gente andar em círculos.
Sequência correta: confirmar 1 push entregue → então implementar 1, 3 e 5.

### RF-05 — CAUSA RAIZ ENCONTRADA (2026-07-20)
O botão de ativar notificações estava **morto**: lia `_ctx.session?.access_token
?? _ctx.accessToken`, e o ctx nunca expôs nenhum dos dois → token vazio → `return`
silencioso no topo do handler. Nunca executou nada. Explica os 0 subscriptions
desde sempre e o "ao tocar, nada acontece". Corrigido lendo
`supabase.auth.getSession()`. **Falta o teste do usuário confirmar a entrega.**

### RF-13 — Exportações: PDF reformulado ✅ · Excel precisa virar .xlsx real 🔴

**Feedback do usuário (2026-07-20):** "todos estão bem amadores". Excel dava
"planilha corrompida" no mobile e "formato e extensão não correspondem" no desktop.

**PDF — FEITO:** estilo reformulado (tipografia com escala, números tabulares,
hierarquia por peso, tabelas sem zebra pesada com cabeçalho repetindo por página,
`@page` com margens, quebras controladas, botão some na impressão).

**🔴 EXCEL — BUG REAL, ainda aberto.** O arquivo é **SpreadsheetML 2003 (XML)**
salvo como `.xls` com MIME `application/vnd.ms-excel`. Daí:
- desktop: avisa "formato não corresponde" (é XML, não .xls binário) — abre no Sim;
- **mobile: NÃO abre** ("corrompida") — o Excel/Sheets do celular não lê SpreadsheetML.

**Correção correta:** gerar **.xlsx de verdade** (OOXML = ZIP com
`[Content_Types].xml`, `_rels/.rels`, `xl/workbook.xml`, `xl/worksheets/*.xml`,
`xl/styles.xml`). Exige um escritor de ZIP (método STORE, sem compressão, serve) +
CRC32. Abre em qualquer lugar, sem aviso, e permite estilo real (fontes, cores,
largura de coluna, formato de número, painel congelado).

**Por que NÃO foi feito junto:** é formato binário; um byte errado no ZIP produz
outro arquivo corrompido — trocaria um export quebrado por outro. Depois de duas
regressões em produção no mesmo dia, escrever ZIP/CRC32 no fim de uma sessão longa,
sem poder abrir o arquivo no Excel para conferir, seria imprudente. É a próxima
tarefa, feita com calma e com teste de estrutura + verificação do usuário.

**Interino:** o **CSV** já funciona em todo lugar (UTF-8 com BOM) — é a saída
confiável para planilha enquanto o .xlsx não sai.

### RF-06 — offline: PARADO por decisão (2026-07-21) + a ideia do usuário (boa)

**Decisão:** deixar como está. Sem internet o app não abre — e está tudo bem por
ora. Zero risco. Retomar com calma.

**Estado atual:** navegação em NetworkFirst SEM timeout (o timeout de 3s da 1ª
tentativa foi o que quebrou o app em conexão lenta). Se o usuário já abriu online
com o SW novo ativo, a casca fica em cache e o app abre offline; se não, o
navegador mostra o erro padrão. Não depender disso é justamente o ponto do item.

**💡 IDEIA DO USUÁRIO — é o desenho certo, guardar para quando voltarmos:**
> "Sempre que o usuário sai do site, ele salva os dados. Capturar esses dados,
> salvar localmente APENAS PARA LEITURA. Quando detectar falta de rede, ativar o
> MODO LEITURA com um aviso 'Você está sem internet, modo leitura ativado'.
> Impossibilita transações e reservas, mas continua permitindo relatórios e
> gráficos."

**Por que essa ideia é superior à minha proposta anterior:** ela mata o risco na
raiz. O perigo do offline não é ler — é ESCREVER: duas gravações concorrentes,
uma antiga chegando depois da nova, e o blob é "último a salvar vence". Foi essa
família que causou os dois incidentes de perda de dados. Um modo explicitamente
SOMENTE-LEITURA elimina a necessidade de outbox, de reconciliação e de resolução
de conflito — some com a parte perigosa inteira, e ainda entrega o que o usuário
realmente quer offline (consultar, não lançar).

**Como implementar quando voltar:**
1. Reusar o cache de boot cifrado (Passo 9) — já existe e já é AES-GCM; ampliar
   do KPI para o conjunto de leitura.
2. Detectar ausência de rede (`navigator.onLine` + falha real do load, que é o
   sinal confiável — `onLine` mente).
3. Trava de UI: desabilitar lançar/reservar/pagar e mostrar a faixa "modo leitura".
   A trava tem de ser no CAMINHO DE GRAVAÇÃO (o `salvarDados` já recusa quando
   `_gravacoesCongeladas`), não só nos botões — botão escondido não é trava.
4. Manter relatórios/gráficos, que só leem.

---
---


---

# 🔄 FASE 8 — CONCORRÊNCIA: o cliente para de mandar o estado inteiro

> **Aberta em 2026-08-04, depois de o dono reproduzir o defeito.** É a maior
> dívida de arquitetura que sobrou, e a única que faz o app **perder dado do
> usuário sem avisar**.

## PASSO 37 — Sincronização por OPERAÇÃO + tempo real 🟡 EM ANDAMENTO ⭐

**Falta:** 37.3 (versão/conflito), 37.4 (fila local) e as Camadas 2–3 do tempo
real (o chat ainda não escuta). O defeito que abriu o passo — perda de dado por
gravação simultânea — está RESOLVIDO e confirmado em produção.

**✅ O LOST UPDATE ACABOU — confirmado pelo dono em produção (2026-08-07).**
Lançamento no chat aparece no dashboard **em tempo real**, sem recarregar. E o
`__sombra` mostrou `completo: true, add: 1` no save que antes se perdia.

**A prova de que era real, em números.** O `financial_audit_log` registra tamanho
antes/depois de cada gravação. Durante o teste do dono:

| hora (BR) | antes | depois | delta |
|---|---|---|---|
| 19:45:24 | 8259 | 9395 | +1136 |
| 19:45:38 | 9395 | 9615 | +220 |
| **19:45:58** | **9615** | **8259** | **−1356** ⚠️ |

Às 19:45:58 uma aba gravou o estado exato de 34 segundos antes. Não "deixou de
adicionar" — **regravou o passado por cima do presente**. Esse padrão não aparece
mais.

**Falta:** 37.3 (versão/conflito) e 37.4 (fila local) — 6 pedaços, e agora são
**defesa em profundidade**, não o conserto. O buraco está fechado por operações +
"save sem nada a dizer não é enviado". Os blocos 37.0 (IDENTIDADE) e
37.1 (O CLIENTE MANDA O DIFF) estão COMPLETOS: as operações já viajam no payload
e o cliente já prova, a cada save, que aplicá-las reconstrói o perfil inteiro.
O servidor ainda as ignora — é a fase de sombra, de propósito.

### ✅ A sombra já respondeu (medição em produção, 2026-08-07)

Conta real, com dados legados, via `/dashboard?opsdebug=1` → `console.table(__sombra)`:

| save | n | set | add | completo |
|---|---|---|---|---|
| 1 | 6 | 6 | — | true |
| 2 | 1 | 1 | — | true |
| 3 | 2 | 1 | 1 | true |
| 4 | 1 | 1 | — | true |

- **`completo = true` nos quatro.** Luz verde para o 37.2a: com dado real e
  legado, as operações descrevem o save inteiro.
- **Zero `edit`.** Era o risco principal — se o allowlist do dashboard estivesse
  reescrevendo registro antigo, o 1º save viria com centenas de `edit`. Não veio
  nenhum. Descartado com dado, não com opinião.
- 🔎 **Achado: todo save trazia um `set` a mais**, mesmo sem o usuário mexer em
  nada. É o `lastUpdate` (dashboard.js:1569), reescrito com `new Date()` em toda
  montagem do perfil — e que **ninguém lê** (os únicos `.lastUpdate` lidos são de
  `meta`, na reserva compartilhada). No 37.3 o conflito é por campo: um campo que
  muda sempre faria TODA gravação simultânea colidir, por causa de um dado sem
  intenção nenhuma do usuário. Virou `CARIMBOS`, fora das operações.
  ⚠️ **Contrato com o 37.2a:** o servidor passa a carimbar o `lastUpdate`.

⚠️ **Como diagnosticar em produção** (custou duas instruções erradas): o build
roda terser com `drop_console: true` — **todo `console.*` é apagado do bundle**.
Log não aparece em produção, ponto. O canal é atribuição a um global
(`window.__sombra`), e a verificação é `grep` no `dist/`, não no fonte.

**O defeito, nas palavras de quem viu:** *"se eu mexo no chat assistente com a aba
do GranaEvo aberta, um sobrescreve o outro"*. Reproduzido: uma retirada lançada
pelo chat sumiu porque a aba de Transações salvou sua cópia antiga por cima.

O nome disso é **Lost Update**.

### Por que o merge por perfil (Passo já feito) não cobre
O merge preserva perfis que o cliente **não declarou** ter tocado. Resolve *duas
pessoas em perfis diferentes*. **Não resolve o mesmo perfil** — aí os dois
declaram, e o último vence. E o caso do mesmo perfil é muito mais comum do que
foi estimado: **uma pessoa só, com duas abas, já cai nele**.

A raiz é anterior: **o cliente manda o ESTADO INTEIRO, não a mudança.** Quem diz
"aqui estão todos os meus dados" está sempre sobrescrevendo alguém.

### A decisão de arquitetura, e por que não a "certa de livro"
O caminho ortodoxo seria transações em **tabela própria**, com RLS por linha e
concorrência real do Postgres. Foi **descartado**: quebraria a cifragem em
repouso (hoje a Edge cifra o blob inteiro) e o desenho de backup/restore, que é
por conta. Migração grande, risco alto, para um ganho que as operações entregam.

**Escolhido: operações sobre o blob.** A Edge Function **já decifra** o registro
atual — é o que a guarda anti-wipe e o merge por perfil fazem. Ela pode aplicar
uma operação e recifrar. Sem migração de dados.

### A descoberta que define o plano

**As transações NÃO TÊM `id`.** `buildTransaction` devolve
`{categoria, tipo, descricao, valor, data, hora, metaId}` — e o desfazer funciona
por **casamento de campos** (`sameTx`) precisamente porque não há identificador.
Sem id estável não existe diff confiável, então **identidade vem antes de tudo**.

**E as 62 chamadas de escrita da UI não precisam mudar.** Levantadas:
`dashboard.js` 29 · `db-metas.js` 11 · `db-cartoes.js` 9 · `db-transacoes.js` 8 ·
`db-configuracoes.js` 5. Converter uma a uma seria caro e deixaria alguma para
trás — e uma esquecida volta a sobrescrever dado alheio em silêncio.

O `data-manager` **já compara** o estado com um retrato para decidir quais perfis
mudaram (`#perfisTocados`, feito em 2026-08-04). Estender essa comparação ao
nível de REGISTRO deriva as operações sozinho: ninguém precisa declarar nada, e
ninguém pode esquecer de declarar. **É o ponto único por onde todo save passa.**

Coleções que precisam de diff, por frequência de uso no código:
`transacoes` · `contasFixas` · `metas` · `orcamentos` · `cartoesCredito` · `conquistas`.

### Pedaços — cada um completável e verificável sozinho

**37.0 · IDENTIDADE (fundação, bloqueia todo o resto)**
- **37.0a** ✅ `id` em todo registro novo — `src/scripts/modules/registro-id.js`.
  Carimbado nos 14 pontos de criação (assistente, dashboard, transações, metas,
  cartões) e uma REDE em `data-manager` para o que escapar. A rede não substitui
  o carimbo: o dashboard reconstrói cada objeto pelo allowlist antes de salvar,
  então a rede pegaria a CÓPIA e o array vivo da tela sortearia outro id no save
  seguinte — o mesmo registro pareceria apagado e recriado a cada gravação.
  Guarda em `check-allowlist.mjs` (roda no CI): registro criado sem `id`, ou
  `novoId()` chamado sem import, reprova o build.
- **37.0b** ✅ Backfill determinístico no load, ANTES do retrato. Registro antigo
  deriva o id de um hash do conteúdo (cyrb53, 53 bits) — dois clientes que leem a
  mesma linha chegam ao MESMO id. Duplicatas exatas são desempatadas pela posição
  no array, que também é igual em todo cliente.
  ⚠️ **A inversão que sustenta o passo:** registro NOVO precisa de id ALEATÓRIO
  (dois cafés de R$ 5 no mesmo minuto são dois cafés — id derivado fundiria os
  dois) e registro ANTIGO precisa de id DERIVADO (id sorteado faria cada cliente
  ver "sumiu um e nasceu outro"). Por isso 37.0a e 37.0b saíram juntos: só um dos
  dois em produção seria pior que nenhum.
- **37.0c** ✅ `sameTx` e `undoPagamentoConta` casam por `id` quando os DOIS
  lados têm um; campos ficam de reserva para registro legado (exigir id nos dois
  deixaria o desfazer de antes do deploy sem efeito, em silêncio). Conserta um
  erro real: dois lançamentos idênticos ("café de R$ 5" duas vezes no mesmo
  minuto) eram indistinguíveis por campo, e o desfazer removia "o último que
  casa" — acertava por sorte. `undoCredito` já trabalhava por id.
- **37.0d** ✅ Vale para `metas`, `cartoesCredito`, `contasFixas` e `assinaturas`
  (esta última faltava na lista original). Verificado por teste: carregar duas
  vezes não muda id nenhum.

**37.1 · O CLIENTE MANDA O DIFF**
- **37.1a** ✅ `src/scripts/modules/diff-registros.js`: `diffColecao(antes, depois)`
  → `{add, edit, remove}` por id, mais `aplicarOperacoes` (o espelho exato do que
  a Edge vai fazer, e o que torna a fase de sombra uma PROVA).
  · **O `add` carrega posição.** A ordem do array é visível — a tela mostra
    `filtrarTransacoesParaUI().reverse()`, sem ordenar por data. Quase tudo usa
    `push`, mas o desfazer de uma exclusão reinsere no MEIO (`splice(pos,0,t)`);
    anexando sempre no fim, desfazer uma exclusão jogaria a transação para o topo
    da lista no reload seguinte. Cada `add` leva `apos` = id do vizinho de trás.
  · **Quando não dá para afirmar, RECUSA** (`{ok:false, motivo}`): registro sem
    id, id duplicado, entrada torta. Chutar aqui apaga dinheiro; recusar só cai
    no save de estado inteiro, que é o comportamento de hoje.
  · **O `id` fica FORA da comparação de conteúdo** — ele é a chave. Comparar
    identidade dentro do conteúdo dava falso positivo (meta antiga tem id inteiro,
    nova tem UUID: um `1` que virasse `'1'` marcaria edição em TODO save, e um
    edit por save vira um conflito por save quando o 37.3 chegar).
  · Limitação assumida e testada: REORDENAR registros existentes sai como "nada
    mudou". Nada no app reordena hoje; a sombra vai medir.
- **37.1b** ✅ Ligado em `transacoes`, viajando no payload como `profile_ops` +
  `ops_completo`. A Edge **ignora** (um teste trava isso: se ela passar a ler
  `profile_ops`, deixou de ser sombra e virou 37.2a).
  · **O autoteste é o que faz disto uma prova.** O cliente aplica o próprio diff
    sobre o retrato e confere que o resultado é IDÊNTICO ao estado atual. Só
    quando isso bater sempre, em produção, com dados reais, o servidor passa a
    aplicar operações. Divergência sobe ao Sentry **uma vez por sessão** (motivo
    + contagem; nunca id de perfil nem valor).
  · **A sombra nunca pode derrubar um save:** se o payload com operações passar
    do teto de 4,9 MB, as operações saem e o save segue como sempre foi.
  · ⚠️ **O FORMATO MUDOU por causa de um limite do proxy, não por estilo.**
    `api/user-data.js` recusa corpo com mais de 8 níveis de aninhamento, e o
    payload de hoje **já chega a 7**. O formato agrupado
    (`{perfil: {colecao: {add: [{apos, registro}]}}}`) dava **9**: todo save com
    fatura de cartão voltaria 400, em produção, para todo mundo. Virou uma LISTA
    PLANA (`[{p, c, op, id?, r?, apos?}]`), que chega a 6. Segundo motivo: o mesmo
    proxy recusa objeto com mais de 80 chaves, então um mapa de âncoras indexado
    por id quebraria numa importação de extrato com 100 linhas. Teste lê os dois
    tetos do próprio `api/user-data.js`.
  · 🔴→✅ **Achado de tabela:** `saveImmediate` (o save do *unload*) mandava só
    `{profiles}`. Para a Edge, corpo sem `touched_profile_ids` significa
    "substitua tudo" — ou seja, **fechar a aba desligava o merge por perfil** e
    sobrescrevia o trabalho dos outros membros. Corrigido junto (declara os
    tocados e carimba ids).
- **37.1c** ✅ Estendido a **todas** as coleções, percorrendo `COLECOES` (não uma
  lista escrita à mão — uma coleção nova ficaria de fora em silêncio, que é o
  modo de falhar deste passo: nada quebra, o dado da outra aba só some).
  O motivo da falha passa a dizer QUAL coleção (`metas:sem_id`) — o conserto é
  num ponto de criação específico, e saber onde é metade do trabalho.
  · **`orcamentos` e `conquistas` NÃO entram**: são mapas chaveados por nome, não
    listas; a própria chave já é a identidade. Vão como campo escalar no 37.1d.
  · **O "resto" do perfil agora é conferido.** Nome, foto, config, orçamentos,
    conquistas e saldo não são descritos por operação nenhuma. Um perfil que só
    foi renomeado gera ZERO operações — se o servidor aplicasse só elas, o nome
    antigo voltaria. Enquanto o 37.1d não existe, mudança no resto marca
    `ops_completo = false`, e a sombra mede quantas vezes isso acontece.
- **37.1d** ✅ `diffCampos`/`aplicarCampos`: `set` e `unset` por chave de primeiro
  nível. Com isso `ops_completo` passa a significar de verdade "as operações
  descrevem o perfil INTEIRO" — que é a premissa do 37.2a.
  · **Um `set` por chave, não um bloco só.** Mandar "o resto todo" de uma vez
    traria de volta exatamente o problema deste passo: duas pessoas mexendo em
    campos DIFERENTES do mesmo perfil voltariam a se atropelar.
  · **`unset` é operação própria, não `set` com `null`.** O app apaga campo de
    verdade (o allowlist descarta o que virou `undefined`); confundir "removido"
    com "vale null" gravaria null onde havia ausência.
  · Autoteste agora reconstrói o **perfil inteiro** (coleções + campos): cada
    metade pode estar certa sozinha e o conjunto não fechar.

**37.2 · O SERVIDOR APLICA**
- **37.2a** ✅ **NO AR** (Edge deployada + cliente ligado, 2026-08-07). A Edge
  aplica as operações sobre o blob decifrado; o que o cliente não mencionou não é
  tocado. **É aqui que o Lost Update morre.**
  · **O interruptor mora no CLIENTE** (`ops_aplicar: true`). Desligar é um deploy
    do front — rápido e reversível pela Vercel — em vez de um redeploy da Edge no
    meio de um incidente. E permitiu deployar a Edge como no-op verificável.
  · **Ordem seguida:** Edge (no-op) → smoke test (OPTIONS 204, provando que o
    módulo carregou) → dono confirmou em produção que lançar/recarregar/excluir
    seguiam normais → só então o cliente.
  · ⚠️ **Operações não sabem criar nem apagar perfil.** Se o conjunto de perfis
    mudou, elas são canceladas e o caminho de estado inteiro assume. Sem essa
    guarda, um perfil recém-apagado **sobreviveria calado** — nenhuma operação
    fala dele — e voltaria no reload.
  · **Operação inválida não rejeita o save:** cai no caminho de sempre e loga.
    Devolver 400 perderia o trabalho do usuário por um defeito que é nosso.
- **37.2b** ✅ **Idempotência — e SEM o livro-caixa que eu tinha planejado.**
  O plano era a Edge guardar os últimos N ids aplicados. Não precisa: **toda
  operação já é idempotente por construção**, e isso é mais forte — não expira,
  não ocupa espaço e não pode dessincronizar.
  `add` de id que já existe é IGNORADO (não duplica **e não sobrescreve**: se o
  registro mudou nesse meio-tempo, quem manda é quem está lá); `edit`/`set` são
  idempotentes por natureza; `rm` do que já sumiu não faz nada.
  · **O caso real que isso conserta:** o save chega ao servidor, é gravado, e a
    RESPOSTA se perde. O cliente não atualiza o retrato, então o save seguinte
    deriva as MESMAS operações — e a transação apareceria duas vezes no extrato.
- **37.2c** ✅ `validarOperacoes` recusa a **remessa inteira** ao primeiro
  problema (aplicar metade de um save deixa o dado num estado que ninguém sabe
  descrever). Cobre: operação desconhecida, coleção inventada, registro sem id,
  `edit` com id divergente do registro, remessa acima de 5000 operações.
  · 🔒 **Poluição de protótipo barrada:** `{op:'set', k:'__proto__'}` escreveria
    no protótipo de Object e mudaria o comportamento de TODO objeto do processo —
    inclusive o de outro usuário atendido pela mesma instância da função.
    Bloqueados: `__proto__`, `constructor`, `prototype`.
  · 🔒 **`set` no `id` do perfil barrado** — permitiria renomear a chave de um
    perfil pelo caminho de dados e cair em cima do perfil de outro membro.
  · 🔒 **`set` numa COLEÇÃO barrado** — substituiria a coleção inteira: o "manda
    tudo" que este passo veio eliminar, entrando pela porta dos fundos.
- **37.2d** ✅ **Provado em produção, não só em teste.** Com a Edge nova já no ar
  e o cliente ainda antigo, o dono lançou, recarregou (estava lá), excluiu e
  recarregou (sumiu). Um cliente com bundle velho em cache de Service Worker
  salva exatamente como antes. Qualquer chave faltando no gate cai no caminho de
  sempre.

**37.2e · O SAVE QUE NÃO TEM NADA A DIZER NÃO É ENVIADO ✅**
Achado nos logs da Edge quando o conserto "estava pronto" e o dado ainda sumia:
**o dashboard salva a cada 30 segundos, incondicionalmente**
([dashboard.js:5466](../src/scripts/pages/dashboard.js#L5466)) — POST a cada ~30s
com a aba só *aberta*.

Eu tinha desenhado o passo para "duas pessoas editando ao mesmo tempo". O gatilho
real é muito mais fácil de puxar: **basta DEIXAR uma aba aberta**, e ele rearma a
cada meio minuto, para sempre.

Agora, zero operações num save `completo` = não vai para a rede. Só é seguro
porque `completo` significa "as operações descrevem TUDO que mudou": zero
operações é a afirmação "não mexi em nada", não um palpite. Efeito colateral bom:
aba aberta sem uso parou de falar com o servidor.

**37.3 · VERSÃO E CONFLITO**
- **37.3a** 🔴 Contador de versão por perfil, incrementado a cada escrita aceita.
- **37.3b** 🔴 Edição e exclusão mandam a versão que leram; divergiu → **409**.
- **37.3c** 🔴 Cliente recarrega e reaplica a operação sozinho; só pede ajuda ao
  usuário se a reaplicação também falhar.
  💡 **Por que ainda vale, com o Lost Update já resolvido:** o caminho por
  operações tem CINCO motivos para cair no de estado inteiro (`sem_pedido`,
  `perfis_mudaram`, `invalidas:*`, blob ilegível, `ops_completo:false`) — e o
  caminho de estado inteiro sobrescreve. A versão barra a gravação baseada em
  leitura velha **venha ela por qual caminho for**. É a trava categórica; hoje
  cada porta é fechada uma a uma.

**37.4 · FILA LOCAL ÚNICA**
- **37.4a** 🔴 Promover o `Outbox` do assistente a módulo compartilhado.
- **37.4b** 🔴 Toda escrita entra na fila; a fila é a única que fala com a rede.
- **37.4c** 🔴 Reenvio com recuo exponencial; a idempotência do 37.2b é o que
  torna o reenvio seguro.

**37.5 · TEMPO REAL ✅ NO AR (Camada 1) — recusado antes por premissa FALSA**

Eu havia recusado isto dizendo que *"o reload no `visibilitychange` cobre"*.
**Não cobre.** O handler ([dashboard.js:6085](../src/scripts/pages/dashboard.js#L6085))
só SALVA quando a aba fica oculta; não existe recarregamento ao voltar. Uma aba
aberta nunca ficava sabendo de nada até um F5 manual. Recusei um recurso com base
em algo que eu não tinha verificado — e o dono cobrou, com razão.

**O desenho: CAMPAINHA, não entrega.** O servidor anuncia "a conta X mudou, nos
perfis Y"; quem ouve busca pelo caminho normal, que autentica e decifra no
servidor. Nenhum centavo trafega pelo websocket. O blob ser cifrado, que parecia
complicação, é o que simplifica: não há o que entregar, só o que avisar.

**Broadcast, e não replicação da tabela.** `postgres_changes` exigiria publicar
mudanças de `user_data` no WAL, e o CLAUDE.md avisa que Realtime mal configurado
ignora RLS. Com broadcast: o cliente **só escuta** (não existe política de INSERT
— ninguém forja "a conta mudou"), a publicação continua VAZIA, e o aviso é nosso
(leva os ids dos perfis, então quem ouve só busca quando lhe interessa).
A autorização (`conta_broadcast_ouvir`) **espelha** o `user_data_select` que já
existe — duas definições de "quem é da conta" divergem com o tempo, e a que
diverge vira o furo.

**Cinco armadilhas, todas medidas em produção:**
1. **Canal público não passa pela política.** A autorização só vale para canal
   PRIVADO. As duas pontas marcam `private: true`.
2. **O alias do Rollup casa por PREFIXO** — um caminho profundo cairia no stub do
   Passo 8, e o tempo real funcionaria em dev e ficaria MUDO em produção. Daí o
   apelido `granaevo:realtime`.
3. **`setAuth` é `async`.** Sem `await`, o canal entrava antes do token e era
   recusado — sem erro, sem aviso, a campainha nunca tocava.
4. **`carregarDadosPerfil` NÃO repinta.** Ele enche os arrays e termina; foi
   escrito para o boot, onde quem chama renderiza depois. O aviso chegava, o
   aplicador rodava, e a tela ficava parada até o F5.
5. **O `await import()` virava decoração** se o chunk caísse no `vendor-supabase`
   (boot). Chunk próprio: `vendor-realtime`, 15 KB, sob demanda.

**Camada 2 ✅ (2026-08-07)**
- ✅ **O chat escuta.** `assistant.refresh()` criado (eu tinha assumido um que
  não existia). Ele NÃO mexe na conversa da tela — o chat é um diálogo, e trocar
  o que está escrito embaixo de quem lê é pior que esperar. O que fica em dia é o
  ESTADO, senão o próximo comando lança em cima de dado velho.
- ✅ **A aba que volta não confia no canal.** Navegador suspende websocket em aba
  de fundo e nem sempre avisa que caiu. Ao ganhar visibilidade: religa se o canal
  não está de pé **e recarrega de qualquer forma** — o refetch é barato e é a
  única garantia de que a tela não está mostrando ontem. O listener é registrado
  UMA vez; sem a trava, cada religamento somaria um e o refetch viraria enxurrada.
- ✅ `activeProfileId` é GETTER, não método. Chamá-lo daria TypeError no primeiro
  aviso, e o catch do canal engoliria — chat mudo, sem explicação.

**Falta (Camada 3 — acabamento, não integridade):**
- 🔴 Avisar quem mudou quando faz sentido ("nova transação de Ke"), em vez de só
  aplicar calado. O nome pode ser resolvido LOCALMENTE pelo id do perfil, sem
  mandar nada novo no canal.
- 🔴 Indicador de sincronizado e presença ("Ke está online").

### Ordem sugerida
`37.0 → 37.1 → 37.2 → 37.3 → 37.4`. A identidade bloqueia tudo; o diff sem o
servidor aplicando (37.1b) permite provar a derivação **antes** de confiar nela.
O 37.3 e o 37.4 são incrementais e podem esperar.

**Também avaliado e dispensado:** tela de resolução assistida de conflito (com
operações, conflito real vira raro — só edição do mesmo registro); logs de
auditoria (**já existem**: `financial_audit_log`, com retenção e imutabilidade).

**Risco:** ALTO — mexe no caminho que grava todo o dinheiro do app.
**Verificar a cada fase:** duas abas lançando ao mesmo tempo no MESMO perfil, e
nada se perde. É o teste que hoje falha.

## PASSO 38 — Descrição e exportação: os achados dos testes de 2026-08-04 🔴

- **38.1** 🔴 **A descrição não usa o que o usuário escreveu.** Medido pelo dono:
  *"Recebi um pix de 70 reais da Ke"* → descrição **"Outros recebimentos"** (o
  rótulo da categoria, não o que ele disse); *"e gastei ele no mercado"* →
  **"Ele no Mercado"** (pronome solto virou descrição). O certo seria "Da Ke" e
  "Mercado".
  · **38.1a** 🔴 Corpus de medição, como foi feito com a direção do dinheiro:
    frases reais → descrição esperada. Sem isso o conserto é chute.
  · **38.1b** 🔴 Pronomes e conectivos soltos ("ele", "isso", "lá") saem da
    descrição — é o que produziu "Ele no Mercado".
  · **38.1c** 🔴 "de/da/do + nome próprio" vira descrição ("Da Ke"), em vez de
    cair no rótulo da categoria.
  · **38.1d** 🔴 Quando NADA sobra, preferir o rótulo do TIPO ("Mercado") ao da
    CATEGORIA ("Outros recebimentos") — é sempre mais específico.
- **38.2** 🔴 **A exportação está furada** — e é o entregável central do direito
  de portabilidade (art. 18, V).
  · **38.2a** 🔴 **Não existe aba "Transações"** — o dado principal do usuário.
  · **38.2b** 🔴 "Perfis" mostra **"-"** em vez da contagem e dos nomes.
  · **38.2c** 🔴 A aba "Atividade" traz ~500 linhas de `UPDATE`/`DATA` ilegíveis.
    **Esse log de auditoria NÃO deve ir para o titular:** a LGPD pede o DADO dele,
    não o diário interno do sistema. Remover ou reduzir a algo legível.
  · **38.2d** 🔴 Conferir o JSON com os mesmos olhos (o dono tem os dois arquivos).
  ⚠️ **Consertar com os ARQUIVOS na mão**, não pelo código: ele já enganou três
  vezes nesta sessão.
- **38.3** 🔴 **Perfil some no chat.** Conta com 4 perfis (dois de nome igual) e o
  assistente mostra 1. **Descartado** que seja o merge por perfil: testado com ids
  repetidos, ele preserva os três. **Falta o dado do dono:** o seletor DENTRO do
  chat mostra quantos?

**Risco:** baixo (nenhum grava dado errado). **Esforço:** ~1 dia somados.

# 🎯 FASE 7 — CAMINHO PARA 10/10 EM TODAS AS DIMENSÕES
> **Origem:** auditoria GOD MODE + GOD EYES de **2026-07-27** (relatório completo em
> `security-audit/god-mode-REPORT-2026-07-27.md`, mapa em `docs/caminho-10-10-2026-07-27.md`).
> **O usuário decidiu (2026-07-27): vamos fazer TODOS os itens.** Ordem de arranque: SEGURANÇA primeiro.
>
> Notas de partida: Segurança 9.4 · Blindagem 9.0 · Otimização 8.0 · Marketing 7.0 ·
> Diferencial 7.5 · Proposta 8.0 · Chat 8.5 · **Global 8.4**

## 📍 ONDE PAREI — 2026-07-27 (fim da sessão)

**Fechado hoje, tudo em produção e verificado:** Passo 30 inteiro (S-1…S-6) ·
B-1 (2FA opt-in: login + RLS + edges) · B-4 · B-5 · B-7 · M-3 · M-4 · M-6 ·
notificações de e-mail de MFA · bug do QR na ativação.
Commits: `64f003e` → `e18eae3`.

### ⏳ Esperando VOCÊ (3 coisas, nenhuma exige código)
1. **Conferir `RESEND_API_KEY` e `SECURITY_ALERT_EMAIL` nas env da Vercel.**
   Sem as duas, todo o B-4 conta e loga mas **não manda e-mail** (`_alert.js:93`).
2. **Cloudflare** — adiado por decisão sua. Precisa: site no Cloudflare +
   nameservers no Hostinger + `CLOUDFLARE_API_TOKEN`. Depois é
   `node scripts/cloudflare-setup.mjs`. Ver `docs/cloudflare-runbook.md`.
   Destrava B-2 (Turnstile) e B-3 (rate limit na borda).
3. **Testar o 2FA de ponta a ponta** — ativar, deslogar, entrar com o código,
   e guardar os códigos de recuperação. Ninguém ativou ainda (0 fatores).

### 🔴 LGPD — a Cloudflare virou operadora e NÃO está declarada (2026-07-27)

Desde hoje **todo** o tráfego dos usuários passa pela Cloudflare: IP, user-agent,
URLs visitadas, e o TLS é terminado lá. Isso a torna **operadora** no sentido da
LGPD, exatamente como o Resend e o Upstash — e ela **não consta** em
`privacidade.html` nem em `docs/RoPA.md`, porque até esta manhã realmente não
estava no caminho.

Some-se o **Precursor / detecção de bots**, que faz impressão digital da sessão,
e a **transferência internacional** (edges fora do Brasil; o roteamento é global
mesmo tendo caído no GRU).

**Junta com o M-7** (`user_devices`/`notify-login` também não declarados). Os dois
pedem o mesmo trabalho — atualizar Política + RoPA e bumpar
`CURRENT_TERMS_VERSION` para `1.2` — e agora há **duas** razões para gastar o
re-aceite, o que torna a decisão mais fácil.

**Esforço:** ~1h30. **Risco de não fazer:** declaração de tratamento incompleta,
que é exatamente o tipo de gap que uma fiscalização encontra primeiro.

### 🔴 Aberto, e NÃO depende de você
| Item | Peso | Esforço |
|---|---|---|
| **M-7** `user_devices` não declarado na Política/RoPA | LGPD | ~1h + bump p/ 1.2 |
| **B-6** 28 de 36 edges com fallback da service_role legada | higiene | ~4h, arriscado às cegas |
| **Passos 32-36** — Otimização, Marketing, Diferencial, Proposta, Chat | 38 itens | semanas |

### ▶️ Sugestão de retomada
**Feitos:** A-3 (`aa0ef75`) · M-1 + CSP (`1fc8c12`) · M-5 + retenção de convites
(`20260727070000`). **Zero achados ALTO em aberto e nenhuma tabela com PII sem prazo.**

Sobrou de LGPD só o **M-7** (`user_devices`/`notify-login` não declarados na
Política e no RoPA — ~1h + bump de `CURRENT_TERMS_VERSION` para 1.2).
Depois disso, os Passos 32-36. Deixar **B-6** para uma sessão em que dê para
acompanhar os logs das edges — remover o fallback às cegas derruba qualquer
edge que não esteja recebendo a chave nova.

---

## Índice da Fase 7
| Passo | Dimensão | Itens | Status |
|---|---|---|---|
| 30 | Segurança 9.4 → 10 | S-1 … S-6 | ✅ **COMPLETO** |
| 31 | Blindagem 9.0 → 10 | B-1 … B-7 | ✅ FINALIZADO — B-1 a B-7 fechados (B-6 em 2026-07-31) |
| 32 | Otimização 8.0 → 10 | O-1 … O-8 | ✅ O-1..O-4, O-6..O-8 feitos; O-5 ⛔ recusado pelo dono |
| 33 | Marketing 7.0 → 10 | M-1 … M-9 | ✅ M-1/M-6/M-7/M-8 feitos; M-2/M-3/M-4/M-5/M-9 ⛔ recusados pelo dono |
| 34 | Diferencial 7.5 → 10 | D-1 … D-7 | ✅ D-1..D-5 feitos; D-6/D-7 ⛔ recusados pelo dono |
| 35 | Proposta do site 8.0 → 10 | P-1 … P-6 | ✅ P-2/P-3/P-6 feitos; P-1/P-4/P-5 ⛔ recusados pelo dono |
| 36 | Chat Assistente 8.5 → 10 | C-1 … C-8 | 🟡 **Falta:** só herdar contexto em compra no crédito (C-1). C-1..C-8 ✅ |
| **37** | ⭐ **Concorrência: sincronizar por OPERAÇÃO + TEMPO REAL** | 37.0 ✅ · 37.1 ✅ · 37.2 ✅ · 37.5 ✅ (Camada 1) · **falta 37.3, 37.4 e as Camadas 2-3** | ✅ **RESOLVIDO em 2026-08-07**, confirmado pelo dono em produção: lançamento no chat aparece no dashboard em tempo real. O que falta é defesa em profundidade e acabamento |
| 38 | Descrição do lançamento + exportação | 38.1 … 38.3 | 🔴 Achados dos testes manuais de 2026-08-04 |

---

## PASSO 30 — SEGURANÇA 9.4 → 10 ✅ COMPLETO (2026-07-27)
> Nenhum item aqui é vazamento de dados. São furo de receita, brute force e higiene de banco.

### S-1 — Bypass do limite de perfis por INSERT em lote ✅ APLICADO (migration 20260727010000) `ALTO` ⭐
> Trigger virou CONSTRAINT TRIGGER AFTER INSERT. **A comparação teve de virar `>` em vez de `>=`**: em AFTER a contagem já inclui a linha inserida, e manter `>=` bloquearia o PRIMEIRO perfil de todo plano Individual. 5 cenários testados em prod com rollback.
**Gap (provado em prod):** o trigger `enforce_profile_limit_stripe` é `BEFORE ROW` e a policy
`profiles_insert_own` usa `can_create_profile()`. Em PostgreSQL, uma query dentro de um trigger
BEFORE ROW **não enxerga as linhas inseridas pelo mesmo comando** — as duas camadas caem juntas.
Evidência: `has_table_privilege('authenticated','public.profiles','INSERT') = true`; o cliente
insere direto via PostgREST (`dashboard.js:2300`); **não há UNIQUE de backstop**.
Um `POST /rest/v1/profiles` com array JSON cria N perfis → plano Individual (limite 1) vira Família.
- [ ] ⬜ Trocar por `CREATE CONSTRAINT TRIGGER ... AFTER INSERT ... DEFERRABLE INITIALLY IMMEDIATE`
- [ ] ⬜ Backstop independente: coluna `slot smallint` + `UNIQUE (user_id, slot)` + `CHECK (slot BETWEEN 1 AND 4)`
- [ ] ⬜ Backfill do `slot` por `row_number() OVER (PARTITION BY user_id ORDER BY created_at)`

**Verificar:** JWT de conta Individual, `POST` com `[{},{},{}]` → **0** perfis criados.
**Risco:** médio (mexe em INSERT de perfil). **Esforço:** ~2h.

### S-2 — Lockout de login por conta ✅ APLICADO (commit desta leva) `MÉDIO` ⭐
> Implementado em **Redis (Upstash)**, não em Postgres: o BFF só tem a ANON_KEY, e usar a tabela exigiria uma RPC DEFINER exposta ao `anon` — que deixaria qualquer um trancar a conta de qualquer pessoa. Escalonamento 5→15min · 10→1h · 20→24h, contador de 24h, zerado no login certo. Chave = SHA-256 do e-mail (sem PII no Redis). Conta falha MESMO para e-mail inexistente, senão o 429 viraria oráculo de enumeração. **Compromisso aceito:** todo lockout por conta permite que um terceiro trave a vítima de propósito — mitigado por ser progressivo, começar em 15min e a recuperação de senha seguir funcionando.
**Gap:** a tabela `login_lockouts` existe no banco e **nenhum código a referencia**
(0 linhas, nunca sofreu autovacuum). Única defesa server-side: 8 tentativas/10 min **por IP**
(`auth-session.js:39`). O reCAPTCHA do login é acionado por contador em `localStorage` → quem
chama `/api/auth-session` direto **nunca vê captcha**. Botnet de 100 IPs = 4.800 tentativas/hora
contra UMA conta. Política de senha fraca (8 chars).
- [ ] ⬜ Lockout progressivo **por e-mail** em `auth-session.js` gravando em `login_lockouts`
      (5 falhas → 15 min · 10 → 1 h · 20 → 24 h); reset no login bem-sucedido
- [ ] ⬜ Responder SEMPRE 401 genérico (não vazar "conta bloqueada" antes de acertar a senha)
- [ ] ⬜ Subir a política de senha de 8 → 10 caracteres
- [ ] ⬜ Estender o HIBP (Passo 15) ao **login** — avisar, não bloquear

**Verificar:** 30 tentativas de 30 IPs contra o mesmo e-mail → barrado na 6ª.

### S-3 — `user_data_snapshots.data_json` legível via PostgREST ✅ APLICADO `MÉDIO`
> REVOKE + GRANT por coluna. `user_email` saiu junto (PII em claro, nenhum caminho do cliente precisa).
Contraria a invariante escrita na própria tabela. Blob é AES-256-GCM (por isso não é ALTO).
- [ ] ⬜ `REVOKE SELECT ON public.user_data_snapshots FROM authenticated;`
- [ ] ⬜ `GRANT SELECT (id, user_id, snapshot_date, size_bytes, checksum, created_at) ... TO authenticated;`

**Verificar:** `has_column_privilege(...,'data_json','SELECT') = false` e o backup segue funcionando.

### S-4 — `terms_acceptance` com GRANT sem policy ✅ APLICADO `BAIXO`
`authenticated` tem `UPDATE`/`DELETE` sem policy correspondente. Inerte hoje; é o lado perigoso
do desalinhamento num registro de consentimento LGPD.
- [ ] ⬜ `REVOKE UPDATE, DELETE ON public.terms_acceptance FROM authenticated;`

### S-5 — Cruft de RLS ✅ APLICADO `BAIXO`
- [ ] ⬜ `DROP` das 3 policies sem grant (`profiles`, `user_profile_management`, `feature_flags`)
- [ ] ⬜ `FORCE ROW LEVEL SECURITY` em `chat_parse_usage`, `edge_rate_limits`, `login_lockouts`

### S-6 — Imutabilidade do audit log depende de GUC de sessão ✅ APLICADO `BAIXO`
> Agora exige GUC **E** `current_user = postgres`. Testado: retenção viva (o cron de 01/08 continua funcionando, `purge_audit_log_retention` é DEFINER de postgres), DELETE sem GUC bloqueado, e o vetor real — `service_role` setando o GUC — bloqueado.
- [ ] ⬜ `AND current_user = 'postgres'` na exceção de `bloquear_alteracao_audit_log`

> 📅 **MARCO 01/08/2026:** o cron 24 fará o **primeiro DELETE real** do audit log (~670 linhas de
> fevereiro). Primeiro teste da interação GUC × trigger de imutabilidade. Observar `cron.job_run_details`.

---

## PASSO 31 — BLINDAGEM 9.0 → 10 ✅ FINALIZADO (2026-07-31)
> Blindagem = camadas independentes. Hoje são 6. Faltam as que dependem de **algo além da senha**.

### B-1 — MFA / TOTP **OPT-IN** ✅ APLICADO EM PROD (2026-07-27, commit 64f003e) ⭐⭐
> **Estado em produção, verificado:** TOTP habilitado no projeto
> (`mfa_totp_enroll_enabled` e `mfa_totp_verify_enabled` = true, máx. 10 fatores) ·
> migration `20260727000000` aplicada e conferida **pelo data plane** (RLS on+forced,
> policy deny-all, zero grant p/ `authenticated`/`anon`) e registrada no ledger ·
> edge `mfa-recovery` ACTIVE com `verify_jwt=false` e 403 sem proxy-secret ·
> BFF no ar. Smoke em prod: login inválido 401 · `mfa-status`/`enroll`/`disable`
> sem token 401 · `mfa-login-verify`/`recovery` sem cookie 440 · `Origin` de fora 403.
> Base zerada: 0 fatores, 0 códigos, 6 usuários — ninguém foi afetado.
>
> **FALTA (o 2FA hoje protege o LOGIN, não o DADO):** enforcement `aal2` no RLS
> (variante opt-in, `as restrictive` + `auth.mfa_factors`) e checagem de `aal` nas
> edges `get-user-data`/`save-user-data`. Sem isso, quem tiver senha + access token
> ainda alcança o blob sem passar pelo 2º fator.
>
> **Sugestão de 5 min no painel:** `mailer_notifications_mfa_factor_enrolled_enabled`
> e `..._unenrolled_enabled` estão **false**. Ligá-los faz o Supabase avisar por
> e-mail quando um fator é cadastrado ou removido — é o sinal que denuncia um
> sequestro de conta, e cobre justamente o caminho "código de recuperação desligou
> o 2FA". Não mexi: altera e-mail de todos os usuários, decisão sua.
**✅ CORREÇÃO IMPORTANTE (verificado na doc oficial em 2026-07-27):** MFA TOTP é **GRÁTIS em todos
os planos** — *"TOTP MFA API is free to use and is enabled on all Supabase projects by default."*
A anotação antiga de que exigia Pro estava **ERRADA**. Só *Phone/SMS MFA* e *enforcement org-wide* são pagos.

**Decisão do usuário (2026-07-27):** esquema **OPCIONAL**. Nasce **DESLIGADO**; o usuário ativa
em Configurações → Segurança da conta se quiser. Ninguém é forçado.

**⚠️ ARMADILHA CENTRAL DESTE APP:** `mfa.verify()` devolve um par access+refresh **NOVO** (aal2).
Com a sessão híbrida httpOnly, o refresh **não pode chegar ao JS**. Por isso TODA operação de MFA
passa pelo BFF `api/auth-session.js` — e **não** pelo `supabase.auth.mfa.*` do cliente.

**⚠️ RESTRIÇÃO DA VERCEL:** o plano Hobby aceita 12 Serverless Functions e já estamos no teto.
As ações de MFA entram como `action` em `api/auth-session.js`, **nunca** como arquivo novo em `api/`.

- [ ] ⬜ BFF: `mfa-status`, `mfa-enroll`, `mfa-activate`, `mfa-disable`, `mfa-login-verify`, `mfa-login-recovery`
- [ ] ⬜ Gate no `login`: se houver fator `verified`, NÃO setar `ge_rt`; setar `ge_mfa` (5 min) e devolver `mfa_required`
- [ ] ⬜ Cliente: helpers em `supabase-client.js`
- [ ] ⬜ Tela de desafio em `login.js`
- [ ] ⬜ UI opt-in no `security-panel.js` (QR + segredo manual + desativar com senha)
- [ ] ⬜ Códigos de recuperação (perder o celular ≠ perder a conta)
- [ ] ⬜ Migration PENDENTE: enforcement aal2 **só para quem optou** (`as restrictive`)

**Invariante para quem NÃO usa 2FA:** nenhuma tela nova, nenhum cookie novo, nenhum passo novo —
o login continua sendo senha → dashboard.
**Único custo real medido:** +1 round-trip (`GET /auth/v1/user`, ~50 ms) por login, para descobrir
se a conta tem fator. O GoTrue não manda `factors` na resposta do `/token` (a query não faz preload),
então não há como saber sem perguntar. Tem retry duplo; se ainda assim falhar, responde 503 "tente
de novo" — falha FECHADA de propósito: deixar passar seria abrir justamente o buraco que o 2º fator
tapa, e bastaria ao atacante provocar a falha.

### B-2 — Anti-bot ✅ APLICADO E VALIDADO (2026-07-27, commits b909be0 + 8f21b5a)
> **O captcha passou a ser exigido pelo SERVIDOR.** Antes, quem o disparava era um contador
> em `localStorage` — e quem chama `/api/auth-session` direto (o atacante que importa) nunca
> teve navegador, nunca teve localStorage, e nunca viu desafio. Trocar só o fornecedor teria
> sido segurança cosmética.
>
> Usa o mesmo contador de falhas por conta do S-2 (Redis). Lê com `readCounter` (não
> incrementa: o gate roda antes de saber se a senha está certa). Roda **antes** do password
> grant. Limiar **3**, abaixo do lockout de 5 — o captcha é a rampa, o lockout é a parede.
> **Falha aberto**: sem a secret ou com a Cloudflare fora do ar, o login segue; indisponibilidade
> de terceiro não tranca ninguém fora da própria conta.
>
> Junto, o reCAPTCHA saiu: **5 domínios do Google deixaram a CSP do `/login`**. Um produto que
> se vende por privacidade carregava rastreador do Google na tela de login.
>
> **Provado em produção:** 3 falhas → `403 captcha_required` · token falso → `captcha_invalid`
> (prova que a secret chegou ao runtime) · widget renderiza e resolve, confirmado pelo usuário.
>
> ⚠️ **ARMADILHA CARA:** a troca foi mecânica demais e manteve duas sondas de `offsetWidth`
> escritas para o reCAPTCHA. O Turnstile em modo Managed roda a verificação INVISÍVEL primeiro
> e fica legitimamente 0x0 nesse intervalo — as sondas liam isso como defeito, destruíam o
> widget e re-renderizavam. Sintoma: piscou 3x (= `_CAPTCHA_MAX_RENDER_ATTEMPTS`) e sumiu.
> **Nunca sondar o DOM de um widget de captcha; use o `error-callback` dele.**

### B-3 — Rate limit na borda ✅ APLICADO (2026-07-27, dentro do cutover da Cloudflare)
Regra de rate limiting na borda cobrindo `/api/*`. Duas armadilhas do plano free, em
`docs/cloudflare-runbook.md`: `mitigation_timeout` **precisa ser igual ao `period`**, e o bypass
de cache **não sai** do ruleset de firewall (tem de ser Cache Rule na própria fase).

### B-4 — Alerta que acorda o dono ✅ APLICADO (2026-07-27, commit e18eae3)
> **A descrição original acima estava ERRADA** e fica registrada como lição: `_alert.js` já era
> completo (6 thresholds, e-mail via Resend, bloqueio de IP em evento crítico, dead-letter queue).
>
> O buraco real era outro e pior: **dois thresholds sem NENHUM emissor**. `webhook_tamper`
> (fraude de pagamento) e `proxy_bypass` (scan direto de EF) estavam definidos, rotulados,
> calibrados — e mudos. Alerta configurado que ninguém dispara é pior que nenhum: dá sensação
> de monitoramento sem monitorar. Um terceiro (`login_lockout`) era dívida do próprio S-2,
> que usava `logger.warn`.
>
> **Ponte edge→Vercel** (`_shared/sec-report.ts` + `?sec=1` em `api/user-data.js`): o `_alert.js`
> roda na Vercel (Upstash+Resend) e as edges em Deno. A inversão que torna a ponte possível:
> quem ataca manda o secret ERRADO para a edge; a edge, que conhece o CERTO, se autentica na volta.
> Blindagem: branch antes do JWT (um scan não tem usuário), proxy-secret timing-safe, allow-list
> de eventos (sem ela, quem obtivesse o secret forjaria até os que BLOQUEIAM IP), meta truncada,
> teto de 60/min e fire-and-forget dos dois lados.
>
> ✅ **CONFIGURADO E TESTADO EM PROD (2026-07-27):** `RESEND_API_KEY` (chave própria da Vercel,
> separada da do Supabase para revogação independente) + `SECURITY_ALERT_EMAIL` em
> Production/Preview. Prova de ponta a ponta: 45 eventos `rate_limit_burst` em 39s cruzaram o
> threshold de 40/300s e o e-mail chegou — **uma vez só**, confirmando o `count === cfg.count`.

### B-5 — Fechar S-1…S-6 (contam para blindagem também) ✅ APLICADO (2026-07-27)
Os seis aplicados em prod via Management API, cada um com `.down.sql`. Detalhe no Passo 30.

### B-6 — Revogar a anon key legada ✅ FINALIZADO (2026-07-31, `fb893af` + deploy das 28 edges)
> ⚠️ **CORREÇÃO (verificado em 2026-07-30):** o texto anterior dizia que a legada continuava
> ATIVA server-side. **Não continua.** `anon` **e** `service_role` estão **desativadas desde
> 2026-07-23T20:03:16Z** — efeito colateral da migração de JWT. Requisição com elas volta
> `401 {"message":"Legacy API keys are disabled"}`. Descoberto por acidente ao tentar criar a
> conta de teste do Bloco 2.
>
> **O que isso muda:** o objetivo do B-6 já foi atingido de fato. O fallback
> `SUPABASE_SERVICE_ROLE_KEY` nas 28 edges **já é código morto** — removê-lo virou limpeza, não
> mudança de comportamento. Em compensação, não existe mais o rollback "restaurar a env antiga
> e redeployar" para nada que dependesse delas.
>
> **✅ Fechado em 2026-07-31** (`fb893af`): fallback removido de **29 arquivos** (28 pelo
> codemod + 1 que ele não casou — `verify-and-reset-password` tinha a forma numa IIFE), as 28
> edges deployadas, e o caminho crítico provado de ponta a ponta na conta de teste (login →
> acesso → leitura → escrita → releitura, dado intacto). Agora falha **alto**: `throw` em vez
> de `return ''`, porque credencial vazia vira 401 confuso em vez de erro de config legível.

### B-7 — Testes de regressão dos vetores fechados ✅ APLICADO (2026-07-27, ampliado em 2026-07-30)
REGRA 9 do god-mode: 100% dos vetores viram teste. Invariantes de arquitetura em
`tests/unit/seguranca-regressao.test.js` — rodam sem banco, sem rede e sem segredo. **722 testes**
no total. A suíte já pegou drift real: o GRANT do sino, aplicado por API e nunca escrito como
migration.

Ampliada com os bugs achados no Bloco 2, todos verificados contra o código antigo:
`scope=local` no `/logout` de verificação · callback do Turnstile como função e não string ·
`data` no login por código de recuperação · a Política não pode prometer formato que o app não
entrega.

---

## PASSO 32 — OTIMIZAÇÃO 8.0 → 10 ✅
**Medido em 2026-07-27:** 1.3 MB JS · 569 KB CSS · 46 chunks · dashboard 133 KB raw / **39 KB gz**.
**Maior ofensor isolado: o CSS do dashboard — 217 KB raw / 40 KB gz** (maior que o JS da página).

- **O-1** ✅ FEITO (2026-07-30) — partículas e paleta de comandos saíram para chunks lazy, com as
  guardas no CHAMADOR (antes do import), não dentro do módulo. `dashboard.js` em 38,4 KB de 40.
- **O-2** ✅ FINALIZADO (2026-08-03, `4edc50d`)
  **Poda:** 70 classes mortas removidas + `scripts/css-mortas.mjs`, que separa USADA / DINÂMICA / MORTA.
  **CSS crítico:** o logo do loader é o LCP da landing e ficava preso atrás de 12 KB de folha. Agora é inline (1.840 bytes), **gerado** de `_loading.css` a cada build com as variáveis resolvidas em cadeia — não copiado, para não repetir a divergência que quebrou o tema claro.
  ⚠️ A landing tem `style-src 'self'` sem `unsafe-inline`: o inline seria descartado e a página nasceria sem estilo. Resolvido com **hash**, propagado pelo gerador para o `<meta>` e para o `vercel.json` — sem afrouxar a CSP da página mais exposta do site. 6 testes travam a sincronia.
  ⬜ **Fora do escopo, por decisão:** as 34 classes `rf-*`/`saude-*` ficam, porque são telas **planejadas**. Reavaliar quando forem construídas ou abandonadas.
  - ✅ `scripts/css-mortas.mjs` separa **USADA / DINÂMICA / MORTA**. A lista velha marcava tudo
    sem ocorrência literal, então enchia de falso-positivo (`cat-entrada`, `tipo-icon-saida`,
    `alerta-status` — montadas em runtime). No `_db-all.css`: das 104 "candidatas", **41 eram
    dinâmicas** e só **19 mortas**.
  - ✅ `scripts/css-podar.mjs` remove com cuidado: `.viva, .morta {}` perde só a metade morta,
    seletor composto morre inteiro, bloco `@` vazio sai, e há trava de 12%.
  - ⚠️ **A ferramenta nasceu errada:** exigia prefixo de 3+ caracteres, então `rf-` (2 letras)
    nunca era testado e um componente **vivo** da reserva de família apareceu como morto.
    Corrigido para 2 — os mortos do projeto caíram de 196 para 85.
  - ❌ **A estimativa de 150–200 KB estava errada.** O real no `_db-all` foi **2,1 KB**
    (`dashboard.css` 40,4 → 40,2 KB gz). Quase tudo que parecia morto era falso-positivo.
  - ✅ **As outras 51 podadas (2026-07-31).** O usuário confirmou que `rf-*` e `saude-*` são
    telas **planejadas** — CSS de tela por construir não é CSS morto, então as 34 ficam. As 51
    restantes eram de coisas que já saíram: reCAPTCHA, popup de "fulano comprou agora", mockup
    antigo do login, carrossel de depoimentos e órfãs do tema claro. ~10,7 KB fora.
  - ✅ **Depoimentos inventados removidos do bundle.** Dentro de `script.js` (que está VIVO)
    havia 6 depoimentos fixos com nomes e resultados inventados. A seção já tinha saído do
    HTML, mas o texto continuava viajando no bundle da landing. −141 linhas.
    ⚠️ No caminho eu concluí que `script.js` era órfão e apaguei — **não era**:
    `landing-demo.js` faz `import './script.js'`, import de efeito colateral, que é *inlinado*
    em quem importa e por isso não vira chunk no `dist`. O build pegou. Restaurado.
  - ⬜ **Restam 34 mortas — as preservadas de propósito** (`rf-*`, `saude-*`). Reavaliar quando
    as telas forem construídas ou abandonadas.
  - ⬜ **"CSS crítico inline + resto lazy" não foi feito.** O dashboard já carrega assíncrono
    (`media="print"` + `css-boot.js`); as públicas carregam bloqueando, mas são 9–12 KB gz —
    ganho pequeno para a complexidade de manter o crítico em sincronia.
- **O-3** ✅ FINALIZADO (2026-08-03, `44f15e5`) — **advisor de performance com ZERO warnings.**
  Além dos 2 índices GIN inutilizáveis (sobre coluna cifrada) e da fusão no `financial_audit_log`, os 3 `multiple_permissive_policies` restantes foram eliminados.
  ⚠️ `account_members` **não era fusão**: juntar as duas policies daria ao MEMBRO direito de escrita na própria membresia — ele poderia se reativar sozinho após ser removido. A saída foi **separar o `ALL` por comando**. Verificado com censo + plano de dados: INSERT como não-dono devolve 403.
  Foi o próprio advisor que revelou esse par, que a consulta manual anterior deixou passar — a prova de que relatório limpo tem valor: ruído esconde o próximo aviso de verdade.
  ⬜ **Fora do escopo, por decisão:** os 29 índices INFO de 16 kB em tabelas com < 60 linhas. "Nunca usado" ali só quer dizer "ainda é pequena".
  - ✅ **Dropados 2 índices GIN INUTILIZÁVEIS** (`20260731000000`). `idx_user_data_json` era GIN
    sobre `user_data.data_json`, que é **ciphertext** — verificado em prod: toda linha tem uma
    única chave de topo, `_enc`. Índice que nenhuma consulta pode ler, pago em **toda escrita**
    do caminho mais quente do app. Os índices de `user_data` caíram de ~3,37 MB para **48 kB**.
    Mais `idx_payment_events_data` (GIN, 272 kB, tabela legada Cakto).
  - ✅ **Fundidas as 2 policies permissivas de SELECT** do `financial_audit_log` (`20260731010000`),
    a maior tabela do banco (21.577 linhas). Cobriam colunas independentes (`user_id`/`actor_id`),
    então `A OR B` é idêntico ao que o Postgres já fazia. Censo antes/depois confirmou que a
    RESTRICTIVE `exige_aal2` sobreviveu, e o isolamento foi provado pelo plano de dados: 268
    linhas visíveis, **0** de outro usuário.
  - ⬜ **Os outros 29 índices "não usados" ficam.** São 16 kB em tabelas com < 60 linhas: o
    planejador ignora índice em tabela minúscula, então "nunca usado" ali só quer dizer "ainda
    é pequena". Dropar não economiza nada mensurável e tira a rede para quando crescer. Vários
    são UNIQUE/constraint, onde "uso" é integridade, não leitura.
  - ⬜ **Os outros 2 pares de policy ficam.** `profiles` (10 linhas) e `stripe_subscriptions`
    (7 linhas): ganho imensurável, e a de `profiles` é INSERT — a área exata do S-1. Trocar
    risco de RLS por ganho que não dá para medir é mau negócio.
- **O-4** ✅ FEITO (2026-07-31) — o gate roda em todo push/PR e agora **reprova de verdade**.
  A primeira medição real do CI mostrou: nenhum `error`, performance e acessibilidade acima de
  0,90 nas três páginas, e só o login com `seo 0,54` / `best-practices 0,85`.
  - **O 0,54 do login não é defeito** — é a decisão certa medida pela régua errada. O
    `robots.txt` proíbe `/login` de propósito, ele não está no sitemap e não tem meta
    description. Buscar 0,9 ali seria tornar a tela de login indexável: deixar a métrica mandar
    no produto. SEO agora é exigido só de `index` e `planos`, via `assertMatrix`.
  - **Performance vai a `error` em 0,85, não 0,90** — score de performance varia entre execuções
    (runner compartilhado); acessibilidade e SEO não variam, são auditorias de regra. Gate que
    falha sozinho de vez em quando é pior que gate nenhum: ensina o time a ignorar vermelho.
  - ⚠️ A "definição de 10" pede `Performance ≥ 95 no dashboard logado`, e **o gate não mede o
    dashboard** (exige login; sem sessão mediria a tela de redirect). Ou o CI ganha uma sessão de
    teste, ou a definição muda para o que é verificável. Alvo que ninguém confere não é alvo.
- **O-5** ⛔ **ENCERRADO — decisão do usuário, reafirmada em 2026-07-31. Não é pendência.**
  O item pedia "a versão completa do Passo 9". A versão segura **já está feita e no ar**; a
  completa foi recusada em 2026-07-19 e a recusa foi **reafirmada** quando o assunto voltou:
  *"vamos manter assim o O5 sem mexer e considerar finalizado"*.

  **O motivo, para quem ler isto no futuro:** a versão atual é uma **impossibilidade
  estrutural** de causar perda de dados — ela só pinta a tela, não toca nos arrays nem no
  caminho de gravação. A versão completa troca essa impossibilidade por uma **guarda em tempo
  de execução**, num app que já perdeu dados **duas vezes**, as duas por corrida entre memória
  e gravação. E a janela de risco **cresce quanto pior a conexão**: valor e risco sobem juntos,
  e é justamente na conexão ruim que o usuário tem tempo de digitar algo que o servidor
  sobrescreve em silêncio.

  **Se um dia for reaberto, o que precisa existir ANTES:** travar as ações de edição durante a
  janela otimista (senão a edição perdida é silenciosa) e um **outbox de escrita**. Nenhum dos
  dois existe hoje. Isso é um bloco de trabalho próprio, não um item de lista.
- **O-6** ✅ FINALIZADO (2026-07-31) — relatórios **já tinha** teto (`REL_TX_VISIVEIS` + "ver mais");
  faltava a fatura, que renderizava TODAS as compras ao abrir o modal. Agora tem teto de 60
  (menor que os 150 do relatório: uma compra é um card com botões, uma transação é uma linha).
  Teste trava os dois tetos e a relação entre eles.
- **O-7** ✅ FEITO (2026-07-31) — o dashboard já tinha; faltava nas **públicas**, que são
  justamente as que o Lighthouse mede. `width`/`height` onde faltava (CLS), `fetchpriority="high"`
  e `preload as=image` nas 5. ⚠️ O `crossorigin` do preload **precisa casar** com o da `<img>`:
  divergiu, o navegador baixa a imagem duas vezes. Há teste para isso.
- **O-8** ✅ JÁ ESTAVA FEITO — o Vite injeta `modulepreload` nos 6 primeiros chunks
  (`modulePreload: { polyfill: false }`) e o script de entrada já fica dentro do `<head>`.
  Verificado no `dist`. Não precisou de código.

**Definição de 10:** LCP < 2,0 s em 4G simulado · INP < 200 ms · Performance ≥ 95 no dashboard
logado · gate no CI impedindo regressão.

---

## PASSO 33 — MARKETING 7.0 → 10 ✅ ENCERRADO
> **Nada pendente.** M-1/M-6/M-7/M-8 ✅ feitos; M-2/M-4/M-5/M-9 ⛔ recusados pelo dono; e o **M-3
> também é ⛔** — ele É o Passo 24 (conteúdo/SEO), recusado junto com a Fase 5.
> ⚠️ Este cabeçalho ficou como PENDENTE apontando o M-3 por algumas horas em 2026-08-04, depois de o próprio
> M-3 já ter virado ⛔ na mesma sessão. Corrigido ao levantar pendências: **marcar um item exige
> varrer quem o cita** — senão o pai continua contando um filho que já morreu.
> A dimensão mais distante do 10 e a de maior retorno. Produto nota 9, aquisição nota 6.

- **M-1** ✅ **JÁ RESOLVIDO** — verificado em 2026-07-31:
  `https://www.granaevo.com/sitemap.xml` responde **HTTP 200** (841 bytes, 4 URLs). O
  `build-sitemap.mjs` roda no `prebuild`.
- **M-2** ⛔ **RECUSADO por ora — decisão do dono (2026-08-03).** Não é pendência.
  *"Não temos usuários ainda, quem sabe futuramente, mas por hora fora de mão."*

  Coerente com a recusa anterior de inventar depoimentos: prova social fabricada num produto
  sem usuários é mentira ao visitante, e foi por isso que o carrossel de avaliações saiu da
  landing (e o `TESTIMONIALS_DATA` saiu do bundle em 2026-07-31).

  **Reabrir quando:** houver cliente satisfeito disposto a depor com nome. Aí é o item de maior
  retorno do Marketing — em finanças, confiança É a conversão.
  3 depoimentos com foto e primeiro nome · 1 número honesto · selo de segurança (provável após B-1).
- **M-3** ⛔ **RECUSADO — é o Passo 24, que o dono mandou remover junto com a Fase 5.**
  Eu o listei como pendente em 2026-08-03 sem cruzar com a recusa. Não é pendência.
- **M-4** ⛔ **RECUSADO — decisão do dono (2026-08-03).** Não é pendência.
  *"Vira spam, e temos o tutorial dentro do próprio app. Quando o usuário compra, a primeira
  coisa que ele quer é usar o app, não ler e-mail. E não compensa ficar implorando pro usuário
  voltar."*

  Cobre as duas metades do item: a sequência de boas-vindas **e** a reativação em D+3.

  O argumento se sustenta no que já existe: o onboarding e o tutorial estão **dentro** do
  produto, onde a pessoa já está com a intenção de usar. E-mail de boas-vindas concorre com a
  vontade dela de abrir o app — chega quando ela menos precisa.

  **O que continua valendo:** e-mail TRANSACIONAL (confirmação, redefinição de senha, aviso de
  aparelho novo, mudança de assinatura). Esses respondem a uma ação da pessoa; a recusa aqui é
  de e-mail de MARKETING, que ela não pediu.
- **M-5** ⛔ **RECUSADO — decisão do dono (2026-08-03).** Não é pendência.
  *"Também não quero programa de indicação."*
- **M-6** ✅ FINALIZADO — verificado em 2026-07-31: `index.html` **e** `planos.html` têm `og:title`,
  `og:description` e `og:image`. O texto antigo ("só a landing tem") estava desatualizado.
  `/login` fica de fora **de propósito**: é `Disallow` no robots.txt, não existe para ser compartilhado.
- **M-7** ✅ FINALIZADO (2026-07-31) — **resolvido SEM rastreador**, por `scripts/funil.mjs`.

  ⛔ **As tags não serão carregadas, e isso é decisão — não pendência.** `privacidade.html` afirma
  que "o GranaEvo não utiliza cookies de rastreamento", e a landing vende "Privacidade de Verdade
  — diferente de outros apps". GA4 + Meta Pixel tornariam essa frase **falsa**, obrigariam a
  declarar Google e Meta como operadores + transferência internacional, e — pela LGPD — exigiriam
  **consentimento explícito**, porque cookie de marketing não se sustenta em legítimo interesse.
  Num produto que se vende por privacidade, o custo não é o banner: é a contradição.

  E era desnecessário: o funil pedido (cadastro → ativação → pagamento) está **inteiro no nosso
  banco** — `auth.users`, `profiles`, `stripe_subscriptions` e `financial_audit_log` respondem
  tudo, sem terceiro nenhum ver o usuário. O script exclui contas de teste, porque contá-las infla
  a conversão e a gente acaba acreditando na própria maquiagem.

  **Fora do alcance disto, e é honesto dizer:** origem do tráfego e comportamento ANTES do
  cadastro. Se um dia for preciso, o caminho digno é analytics sem cookie (Plausible/Umami
  self-hosted), não pixel de rede social.

  <details><summary>Descrição original</summary>

  Falta: carregar as tags. O código de evento **já existe** (`planos.js:823-830` dispara
  `gtag('event')` e `fbq('track')`, e a CSP de `planos.html` já libera googletagmanager e
  connect.facebook.net) — mas **nenhuma tag é carregada** em `index.html` nem `planos.html`, então
  as chamadas caem em `if (window.gtag)` e não medem nada. Falta o snippet e o ID da conta.
- **M-8** ✅ FINALIZADO (2026-07-31, `b9baac3`) — `planos.html` declara as três ofertas com preço
  individual. Conferido contra `PLAN_PRICES_CENTS` da edge que cobra de verdade, com teste que
  trava a divergência: preço errado no snippet é a primeira informação que o cliente vê, e ele só
  descobriria a diferença no checkout.
- **M-9** ⛔ **RECUSADO — decisão do dono (2026-08-03).** Não é pendência.
  *"Não devemos nos comparar, pois somos melhores."*

  **Observação registrada, não objeção:** o valor da página não estava em provar superioridade —
  estava em capturar quem já está comparando por conta própria e decidindo naquele momento. Essa
  busca continua acontecendo com ou sem a página.

  A objeção do dono ao formato, porém, é legítima e tem risco real do outro lado: comparativo
  que distorce o concorrente destrói mais confiança do que a página constrói — e confiança é
  exatamente o que este produto vende.

  **Se um dia for reaberto**, o ângulo honesto é o P-6 virado em página: explicar a escolha de
  não conectar ao banco, sem citar nome de concorrente.

---

## PASSO 34 — DIFERENCIAL 7.5 → 10 ✅
> Os diferenciais são reais mas **invisíveis**. Metade produto, metade comunicação.

- **D-1** ✅ FEITO (2026-07-31) — duas mudanças, nenhuma quebrando layout:
  **(1)** uma linha no hero, respondendo à objeção que o próprio parágrafo acima levanta
  (*"sem conectar seu banco"* soa como limitação). Uma linha só de propósito: bloco maior empurra
  o CTA para baixo da dobra no celular.
  **(2)** o 6º card de recurso dizia *"Automação Completa: configure contas fixas"* — promessa
  vaga que qualquer app faz. Virou **"Importe seu extrato"**, que é a automação concreta. Grade
  3×2 intacta: substituição, não adição.
  Cada afirmação foi conferida no código antes de entrar na vitrine — inclusive "ainda categoriza"
  (`_autoCategorizar` é chamado nos dois parsers) e "ignora o que já existe" (`_isDuplicata`, com
  3 critérios). Prometer o que o código não faz foi o erro do A-3; não repetir.
  Título sugerido: **"Importe do seu banco sem dar sua senha a ninguém."**
  Neutraliza o Open Finance sem os R$ 2.500+/mês do Pluggy.
- **D-2** ✅ FINALIZADO — verificado em 2026-07-31. A edge `send-radar-push` existe e é disparada
  por dois caminhos: o **cron diário** do Radar e a **entrega imediata** de
  `notify-reserve-invite`. O RF-05 (toggle que mentia "Ativas" e subscription que nunca era
  salva) foi corrigido em `c5b99a0`. O texto antigo dizia que só chegava com o app aberto —
  desatualizado.

  <details><summary>Descrição original</summary>

  Hoje só chega com o app aberto → lembrete
  é inútil. iOS só entrega Web Push em PWA instalado (16.4+). **Trava o C-2.**
- **D-3** ✅ **JÁ ESTAVA FEITO** — verificado em 2026-07-31. `modules/recorrencias.js` é exatamente
  este detector, e está ligado em **três** pontos: aviso automático no dashboard
  (`dashboard.js:2079`, que ainda recalcula a cada `ge:save-done`), botão em Cartões → Assinaturas
  (`db-cartoes.js:362`) e no chat do assistente (`assistant/insights.js`).
  Critérios conservadores e **13 testes**, incluindo os falsos-positivos difíceis: pedágio com
  valor fixo em dias aleatórios, conta fixa, pagamento de fatura, valor instável, 2 ocorrências
  (evidência fraca). O discriminador forte é o **dia do mês consistente (±3)**.
- **D-4** ✅ FINALIZADO — verificado em 2026-07-31: `modules/previsao-mes.js` existe, tem testes
  (`previsao-mes.test.js`) e **está ligado** — `db-relatorios.js:2504` faz o import lazy.
- **D-5** ✅ **JÁ ESTAVA FEITO** — verificado em 2026-08-03. As três fases do RF-09 estão no ar:
  - **Fase 1** (`_restore-core.js`): o restore troca APENAS o slot do perfil pedido. Antes
    sobrescrevia o `data_json` inteiro — um convidado restaurando revertia TODOS os perfis do
    plano à data do snapshot, que era a dor nº 1 do RF-09. O blob é cifrado em repouso, então o
    núcleo decifra current + snapshot, troca um slot e re-cifra, com CAS em `last_modified` para
    abortar em corrida.
  - **Fase 2**: config por perfil extraída para `modules/config-perfil.js` (pura, testável).
  - **Fase 3**: reserva compartilhada v2 intra-conta, com convite → aceite.

  95 testes verdes entre `restore-slot`, `config-perfil` e `reserva-familia`. O núcleo é
  runtime-agnóstico de propósito: o edge importa **o mesmo arquivo** que o `node --test` exercita,
  em vez de manter uma cópia que diverge.

  ⬜ **Falta só teste humano:** a bateria `docs/rf09-bateria-testes.md` numa conta família.
- **D-6** ⛔ **RECUSADO — decisão do dono (2026-08-03).** Não é pendência.
  *"Perda de tempo. O tempo que a pessoa leva pra tirar um print e enviar é até menor do que
  ela lançar a transação, não compensa."*

  O argumento é bom e vale registrar: um atalho só vale se for mais curto que o caminho que
  substitui. Compartilhar um print exige abrir a galeria, escolher a imagem e escolher o app —
  e no fim alguém ainda teria de conferir o valor lido. Lançar direto tem menos passos.
- **D-7** ⛔ **RECUSADO — decisão do dono (2026-08-03).** Não é pendência.
  *"Está bom assim. Nem todos os casais querem dividir despesas — muitos querem administrar os
  próprios gastos sozinhos. Por exemplo, dois amigos que dividem o plano."*

  O argumento corrige uma premissa que o item embutia: que "plano Casal" significa "finanças
  conjuntas". Não significa. O plano vende **perfis separados no mesmo assinatura** — e quem
  compra pode ser um casal com contas separadas, dois amigos ou pai e filho. Construir acerto de
  contas assumiria um único modelo de convivência e atrapalharia os demais.

---

## PASSO 35 — PROPOSTA DO SITE 8.0 → 10 ✅

- **P-1** ⛔ **RECUSADO pelo dono do produto (2026-07-31). Não é pendência.**
  *"P1 já existe dentro da landingpage, há a possibilidade de melhorias, porém, um trial mesmo
  dentro da dashboard sem cartão não compensa e está fora de questão."*

  A landing **já tem** uma amostra jogável (`landing-demo.js`, com a parede no 4º lançamento —
  ver o Bloco 4 dos testes manuais), então a parte "deixar experimentar antes de pagar" está
  atendida por outro caminho. Trial dentro do dashboard sem cartão está **fora de questão**.

  <details><summary>Argumento original (mantido para histórico, não para execução)</summary>

  Era descrito como "a maior alavanca de receita de todo o relatório": hoje pede cartão antes de
  o visitante saber se serve, e "garantia de 7 dias" é psicologicamente mais fraca que "7 dias
  grátis" custando o mesmo. O Stripe suporta `trial_period_days` sem `payment_method`.
  </details>

  **Aberto, se um dia quiser:** melhorar a amostra da landing. Isso o dono deixou em aberto.
- **P-2 / A-3** ✅ **APLICADO (2026-07-27, commit aa0ef75)** — export JSON existe.
  Configurações → Privacidade → "Baixar meus dados". Blob vem do SERVIDOR (a memória só tem o
  perfil ativo; portabilidade exige todos), metadados por PostgREST com RLS, **step-up por senha**
  (Passo 25 já previa isso para "exportar dados"), chunk lazy de 3,28 KB, e nenhuma credencial no
  arquivo. Verificado em prod: 401/400/403 corretos no step-up, `ua_label` certo e `device_hash`
  fora. **Era o último achado ALTO em aberto.**
- **P-3** ✅ FINALIZADO (2026-07-31) — o último bloqueante de LGPD.
  Declarados: **aparelhos reconhecidos** (`user_devices`, com o que NÃO guardamos escrito por
  extenso: modelo, IMEI, localização, ID de publicidade), **Cloudflare Turnstile** e **ImprovMX**
  (1º operador nosso fora dos EUA). Removido o **Google reCAPTCHA**, que saiu em 2026-07-27 e
  seguia listado como operador — declarar operador errado manda o titular reclamar no lugar
  errado. Corrigido também que **não** usamos o Cloudflare Insights: a CSP bloqueia o beacon, e
  declarávamos o que não acontece.

  RoPA em 1.2, com duas atividades novas (13 aparelhos, 14 recebimento de e-mails).
  `CURRENT_TERMS_VERSION` subiu para `1.2` e as três edges foram deployadas.

  **Caminho inteiro verificado em produção, não só o deploy:** o gate voltou a pedir aceite numa
  conta que já estava na 1.1, o aceite gravou 1.2, e a checagem seguinte parou de pedir — ou
  seja, sem o loop que o pré-requisito do unique poderia causar (conferido antes de subir que o
  unique é `(user_id, terms_version)`, e não o redundante em `user_id`).

  <details><summary>Descrição original</summary>

  Declarar `user_devices` / `notify-login` + os operadores faltantes (ImprovMX, push) →
  bump `CURRENT_TERMS_VERSION = '1.2'`.
- **P-4** ⛔ **RECUSADO — decisão do dono (2026-08-03).** Não é pendência.
  *"Não quero mais."*
- **P-5** ⛔ **RECUSADO por ora — decisão do dono (2026-08-03).** Não é pendência.
  *"Prefiro só mensal mesmo por hora."*

  ⚠️ Se um dia for reaberto: criar plano anual mexe no Stripe (novos preços), no
  `PLAN_PRICES_CENTS` e no JSON-LD de `/planos` — que tem teste travando a igualdade entre o
  preço anunciado e o cobrado. Não é só texto na página.
- **P-6** ✅ FINALIZADO (2026-08-03) — *"Por que o GranaEvo não conecta com o meu banco?"* entrou
  no FAQ da landing, respondida de frente.
  A resposta faz três coisas: diz que é **escolha, não limitação** ("quem conecta precisa manter
  um acesso permanente à sua conta vivo em algum servidor"), oferece o **caminho prático** (o
  import de OFX/CSV, senão a pergunta seguinte fica no ar: "então digito tudo à mão?") e **admite
  o custo** ("de vez em quando você baixa um arquivo"). Vender só o lado bom de uma escolha é o
  que faz o visitante desconfiar do resto.
  ⚠️ O FAQ vive em DOIS lugares — HTML visível e JSON-LD do `<head>`. Divergir viola as diretrizes
  do Google e derruba o rich snippet **em silêncio**: a página continua no ar, o snippet só nunca
  aparece. Há teste comparando os dois, item a item e na ordem.

---

## PASSO 36 — CHAT ASSISTENTE 8.5 → 10 🟡
> Arquitetura já é 10. **Nenhum item abaixo manda R$ para o modelo** — e nenhum precisou.
> **Falta:** o **C-9** — achados da análise profunda de 2026-08-04, medidos e não corrigidos.
> O mais grave: *"quero gastar no máximo 500 em mercado"* **grava um gasto falso de R$500**.
> Os itens C-1..C-8 estão ✅ (sete deles resolvidos sem tocar no schema da IA).

- **C-1** 🟡 PENDENTE (2026-08-03) — ⭐ **Memória de conversa**. *"Gastei 50 no mercado"* → *"e mais
  30"* agora lança sozinho, herdando categoria e tipo da frase anterior.
  **Falta:** só a continuação de compra no **crédito**, que não herda — `#lastLancamentoCmd` é
  gravado apenas para saída/entrada/reserva; crédito segue outro caminho (`#doCredito`).
  ⚠️ **Correção de um erro MEU no diagnóstico (2026-08-04).** Este item dizia: *"o parser local
  nunca leu 'ontem' — `dataOverride` não existe nele"*. **Era falso.** O parser lê data sim
  (`parseDataRelativa`, linha 596) — eu sondei o campo pelo nome errado (`dataOverride`, camelCase)
  quando ele se chama **`data_override`** (snake), e concluí que a funcionalidade não existia.
  A perda era real, mas a causa era outra e muito menor: só o ramo **`valor_ambiguo`** não
  preenchia o campo. **Resolvido:** a data agora entra também naquele ramo, e é guardada no
  `#pendingValorAmbiguo` — porque quem escreve *"30 ontem"* diz a data ANTES de saber que será
  perguntado a direção, e a resposta (*"foi um gasto"*) não repete o "ontem".
  **Desvio consciente do plano original:** o texto acima mandava passar os 2 últimos turnos no
  `contextLine`, ou seja, **mandar mais conversa do usuário para o modelo**. Não fiz: resolvi no
  aparelho, com zero token e sem enviar nada novo para a IA. Sai mais barato, mais rápido, é
  determinístico (dá pra testar) e não alarga a superfície de dados que sai daqui — coerente com a
  regra de ouro "IA como função".
  Três decisões que valem mais que o código:
  · **Só herda com marcador explícito** ("e", "mais", "também"). Um valor solto (*"30"*) continua
    virando pergunta. O "e" é o consentimento — herdar a direção errada em silêncio grava dinheiro
    que não existe, e o usuário só descobriria no fim do mês sem pista de onde veio.
  · **Nunca herda a descrição** — *"e mais 30"* depois de *"50 de pão"* é outro item, não mais pão.
  · **O contexto vence em 10 min.** Aba esquecida aberta desde ontem não é conversa.
  Vem depois do comerciante aprendido (B12) e antes da IA. 19 testes.
- **C-2** ✅ FINALIZADO (2026-08-03) — **push semanal** com insight do Radar.
  A semana sem conta vencendo virava silêncio: o resumo só era criado quando havia conta a vencer,
  então justamente quem mantém as contas em dia — quem usa bem o app — nunca recebia nada. O portão
  passou a ser "há o que dizer?" (`if (corpo)`) em vez de "há conta?". Reusa o mesmo motor de
  insight do chat (`insights.js`), não uma cópia — duas versões do mesmo cálculo já divergiram
  antes, no fechamento de fatura. Cada insight tem o próprio `catch`: erro no complemento não pode
  engolir o aviso de conta vencendo, que é o essencial. **Nenhum R$ no corpo** — a notificação é
  lida por quem passa pelo celular na mesa; vai só o nome da assinatura e percentual.
- **C-10** 🔴 **Retirar da reserva pela tela de Transações** — pedido do dono (2026-08-04).
  Hoje só dá para retirar entrando em Reservas (ou pelo chat). O tipo já existe no seletor de
  categoria da edição; falta o fluxo de CRIAÇÃO com as travas que o dono listou: perguntar de qual
  reserva, bloquear se o saldo não cobre, e rate limit.
  ⚠️ **Risco descoberto junto:** o formulário de edição já permite trocar a categoria para
  `retirada_reserva`, e isso grava a transação **sem mexer no saldo da reserva** — a transação diz
  que saiu dinheiro da reserva e a reserva não sabe. Vale conferir antes de expor o fluxo novo.
- **C-9** 🔴 **ACHADOS DA ANÁLISE PROFUNDA (2026-08-04) — medidos, não corrigidos.**
  A varredura por corpus achou estes; nenhum foi consertado ainda:
  (⚠️ Nota: a 1ª versão desta lista usava os marcadores de PENDENTE e de risco-médio como se
  fossem GRAVIDADE. O validador reprovou, e com razão — os marcadores são STATUS. Item não
  iniciado é NÃO INICIADO por mais leve que seja; gravidade se escreve por extenso.)
  · 🔴 **GRAVE — orçamento grava gasto falso.** *"quero gastar no máximo 500 em mercado"* e
    *"orcamento mercado 500"* criam uma **despesa de R$500 que não existe** (2 de 4 formas testadas).
    `RE_DEF_ORCAMENTO` exige "orçamento/limite/teto" colado a uma preposição; sem ela, escapa.
    **É o único item aberto que inventa dinheiro.**
  · 🔴 **MÉDIO — "parcelado" não vira crédito.** `parcelad` com `` no fim não casa "parcelado"/"parcelada"/
    "parcelados" — a compra parcelada vira saída à vista e **some da fatura do cartão**.
    ⚠️ **É a 4ª vez que essa fronteira de palavra morde este arquivo** (`gasto`/`gastos`,
    `deposit`/`depósito`, agora `parcelad`). Virou propriedade do arquivo, não azar: português
    flexiona e `` não perdoa. **O conserto certo é um teste de flexões** sobre cada radical das
    listas de verbos — senão a 5ª vem.
  · 🔴 BAIXO — continuação no **crédito** não herda contexto (`#lastLancamentoCmd` só grava saída/entrada/reserva).
  · 🔴 BAIXO — *"minhas conquistas"* cai em "não entendi" — a consulta existe no app, falta a frase.
  · 🔴 BAIXO — *"não me deixa esquecer do X"* não vira lembrete.
  · 🔴 BAIXO — dia da semana (*"gastei 30 na segunda"*) não vira data.
  **O que foi MEDIDO e está sólido:** valores 9/9 · consultas 24/25 · conta fixa 8/8 ·
  desfazer/repetir 7/7 · direção do dinheiro 36/36 · robustez 13/13 sem explodir · injeção barrada ·
  as 7 gavetas de pendência têm escotilha de saída · undo é transação compensatória de verdade.
- **C-3** ✅ FINALIZADO (2026-08-04) — **conversa livre**.
  *"obrigado"*, *"valeu"*, *"tchau"*, *"quem é você"* caíam em `desconhecido` com confiança 0, iam
  para a IA e voltavam como *"não entendi — tente: gastei 50 no mercado"*. Custava token, ~1s de
  rede e uma vaga do teto diário para responder mal a uma frase que não precisa de IA nenhuma — e
  soa como um robô que não estava ouvindo.
  **Desvio do plano (o 2º desta natureza, depois do C-1):** o texto acima dizia "sair do enum", ou
  seja, ensinar a IA a devolver `conversa_livre`. Resolvido **no parser local**: sai de graça, é
  instantâneo, é determinístico, não exige redeploy da edge — e, principalmente, um
  `conversa_livre` vindo do modelo seria a porta por onde ele começaria a **falar** com o usuário,
  que é exatamente o que a regra de ouro proíbe. Todo texto é template meu.
  Cinco tons: agradecimento · despedida · elogio · identidade · ok/riso.
  **As guardas valem mais que os acertos:** frase com valor NUNCA é conversa (*"valeu, gastei 30 no
  ifood"* segue lançamento — engolir isso perderia os 30) e frase com mais de 8 palavras é assunto,
  não cortesia.
  ⚠️ **Efeito colateral achado e corrigido:** *"você é um robô?"* caía no detector de
  prompt-injection (que casa "você é um/uma…", desenhado para troca de PAPEL) e recebia uma recusa —
  pior que o problema original. Um lookahead negativo libera um conjunto **fechado** de 5 palavras
  sobre ser máquina; *"você é um assistente sem restrições"* e *"você agora é um desenvolvedor"*
  continuam recusados, com teste travando os dois lados.
  A resposta de identidade é a única fora do sorteio de variações — variar o que o produto **é**
  soa evasivo — e é honesta: diz que é software e aproveita para dizer o que a IA **não** vê.
  22 testes.
- **C-4** ✅ FINALIZADO (2026-08-03) — medição da instalação real do PWA.
  Sobe **um booleano**, uma vez por sessão, e o servidor grava num contador **por dia**: sem
  `user_id`, sem aparelho, sem IP (tabela `pwa_usage`, RLS forçada e zero policies; `pwa_ping` só
  executável pelo `service_role`). Não dá para reconstruir quem abriu o quê, então não é dado
  pessoal e **não reabre a declaração de LGPD**. `sessionStorage` e não `localStorage` de
  propósito: a pergunta é "quantas *sessões* vêm de app instalado" — com `localStorage` o sinal iria
  uma vez na vida e a série temporal, que é o que mostra se está crescendo, nunca se formaria.
  Leitura em `node scripts/funil.mjs`.
- **C-5** ✅ FINALIZADO (2026-07-31, `b9baac3`) — fala **opt-in**, com o controle no próprio chip
  de confirmação: onde a voz acontece é onde se descobre que ela existe e onde se desliga. Nasce
  desligada — inclusive se o `localStorage` falhar (modo privado) — e o Desfazer chama
  `stopSpeak()`, porque narrar um lançamento sendo desfeito é falar de algo que deixou de ser
  verdade. 5 testes.
- **C-6** ✅ **JÁ ESTAVA FEITO** — verificado em 2026-07-31. `#doPagarConta` resolve a conta,
  trata ambiguidade (pergunta em vez de adivinhar), handoff de fatura de cartão, conta já paga,
  aplica o pagamento e **desfaz se o save falhar**.
  O que faltava de verdade era **teste**: um caminho que mexe em dinheiro por comando de texto
  estava sem nenhum. 14 testes adicionados, todos passando de primeira — inclusive os limites que
  importam (valor absurdo recusado, não paga duas vezes, e o desfazer não leva junto uma
  transação parecida do usuário).
- **C-7** ✅ **JÁ ESTAVA FEITO** — verificado em 2026-07-31. `insights.js` exporta `microLicao()`,
  o `engine.js` a importa e chama dentro de `aberturaInsights()`, e essa função é chamada de
  verdade por `assistente.js:154` quando o chat abre. Os números são derivados **no cliente**: a
  IA não vê nenhum deles. Entra depois dos avisos urgentes de propósito — uma lição de padrão não
  passa na frente de uma fatura vencendo.
- **C-8** ✅ FINALIZADO (2026-08-03) — **fallback honesto**: `confianca < 0,6` → pergunta.
  A confiança já era pedida no schema e **nunca era lida** — `ai.ok` bastava, então um palpite fraco
  do modelo virava lançamento com a mesma naturalidade de um parse certo. Vale só para intenção que
  **escreve** (`lancar`, `pagar_conta`, `definir_orcamento`, `lembrete`): errar numa consulta custa
  uma resposta boba que a pessoa relê; errar num lançamento cria dinheiro que não existe e contamina
  saldo, previsão e relatório. Limiar 0,6 e não 0,7 (o do parser local) porque a IA erra menos na
  faixa média — exigir 0,7 dela transformaria em pergunta um monte de parse que estava certo, e
  assistente que pergunta demais é tão inútil quanto o que adivinha demais. Reusa o `#pendingConfirm`
  do valor alto, sem mecanismo paralelo.
  ⚠️ Armadilha achada aqui: o contador `ia_incerta` precisou ser declarado nas **duas** linhas de
  init do `stats.js` — o `bump()` ignora contador não declarado **em silêncio**, e a telemetria
  ficaria sempre zerada sem ninguém notar.

---

## Sequenciamento — o que trava o quê
- **D-2 trava C-2** — sem push em background, o assistente proativo não tem canal.
- **B-6 depende da Fase 4 do JWT** — migrar as ~20 edges restantes para `sb_secret_`.
- **O-1 destrava O-2** — CSS crítico fica muito mais fácil com o JS já particionado.
- **P-1 deveria vir ANTES de M-3** — não faz sentido trazer tráfego para um funil que trava no cartão.

## Se só der para fazer 5
1. **P-1** trial sem cartão — receita
2. **B-1** MFA/TOTP — blindagem, e agora sabemos que é grátis
3. **S-1** bypass do limite de perfis — está vazando receita agora
4. **D-1** import OFX no topo — mata a objeção nº 1 com o que já existe
5. **D-2** push em background — destrava metade dos diferenciais
