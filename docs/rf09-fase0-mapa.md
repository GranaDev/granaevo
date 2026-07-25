# RF-09 + Reserva compartilhada v2 — Mapa da Fase 0 (reconhecimento)

_Gerado 2026-07-24. Somente leitura — nada foi alterado. Base para as fases seguintes._

## 1. Modelo de dados (CONFIRMADO)

- **Uma linha por CONTA** em `public.user_data` (chave `user_id` = dono). `data_json` (jsonb)
  = **array de perfis**. Convidados (`account_members`) resolvem para o dono e compartilham
  a MESMA linha. Confirmado no edge e na RLS (`user_data_select` permite membro ativo ler a
  linha do dono; UPDATE só o próprio dono via RLS → escrita de convidado passa pelo edge
  service_role).
- Perfil montado em `dashboard.js:1595` (`dadosPerfil`) com id/nome/foto/transacoes/metas/
  contasFixas/cartoesCredito/assinaturas/orcamentos/tiposPersonalizados/conquistas/config/
  desafios/nextCartaoId/lastUpdate. **id de perfil é string-comparado** (`String(p.id)`).

## 2. Save path (o campo minado) — CONFIRMADO

- `salvarDados` (`dashboard.js:1439`): monta o perfil ativo, encaixa no array base
  (`_allProfilesData`, cópia profunda), dedup por id, e **grava o blob TODO** via
  `dataManager.saveUserData`. Guardas já existentes: `_trocandoPerfil`, `_gravacoesCongeladas`,
  `_saveEmVoo`, dedup `SAVE_DUP_001`. Debounce 2s (0 se urgente).
- **Allow-list**: `_ALLOWED_KEYS` (`dashboard.js:1091`) + `_sanitizarConfigPerfil` (`:989`).
  `meta` já inclui `compartilhada`, `membros`, `movimentos`. `config` já preserva `viagem` e
  `horasVida`. `check-allowlist.mjs` cobre transacao/meta/contaFixa/cartao/assinatura.

## 3. Backup / restore (a dor do RF-09) — CONFIRMADO + CORREÇÃO IMPORTANTE

⚠️ **`profile_backups` NÃO é o backup do usuário.** É a tabela de **downgrade de plano**
(`original_plan`, `target_plan`, `stripe_subscription_id`, `scheduled_removal_at`,
`backup_expires_at`) — guarda o perfil de um membro removido quando o plano cai, expira no
cron `granaevo-expire-profile-backups` (jobid 17). Nada a ver com RF-09.

O **backup/restore real** usa **`user_data_snapshots`**:
- **Criação**: cron `granaevo-daily-snapshot` (jobid 21, 03:15) → `take_daily_snapshot()`
  (SECURITY DEFINER). Copia o **blob inteiro** de `user_data.data_json` → snapshot 1×/dia por
  usuário, idempotente por (user_id, snapshot_date), dedup por checksum em 5 dias, **retenção
  rolling de 5 dias**. (A UI diz "7 dias" — divergência cosmética a alinhar depois.)
- **Listagem/restauração**: edge `user-data-backup` (proxy `/api/user-data?backup=1` e
  `POST {action:'restore', snapshot_date}`). Restaura sobrescrevendo `user_data.data_json`
  **inteiro** com o `data_json` do snapshot. Resolve convidado→dono.
- **UI**: `db-configuracoes.js` — `abrirHistoricoBackup` (:895), `_abrirConfirmacaoRestauracao`
  (:1076), `_salvarSafetyBackup` (:885, só chama `salvarDados`). Congela gravações antes do
  restore e recarrega a página depois.

🔴 **RF-09 confirmado**: restaurar reverte **TODOS os perfis** da conta à data do snapshot.
Um convidado que restaura reverte o trabalho de todos.

**Insight para a Fase 1 (baixo risco):** como o snapshot já contém o array inteiro, dá para
restaurar **só o slot do perfil ativo** — ler o blob atual + extrair o perfil `X` do snapshot
+ trocar somente esse slot + gravar, **tudo no servidor, em uma ida**. **Não exige migration**
(nem coluna nova, nem captura por-perfil): a captura continua sendo o superset (blob todo) e só
a RESTAURAÇÃO fica cirúrgica. Menor raio de explosão possível.

## 4. Reset por perfil — CONFIRMADO OK

`resetarPerfil` (`db-configuracoes.js:1211`) limpa só transacoes/metas/contasFixas/
cartoesCredito/orcamentos/tiposPersonalizados do **perfil ativo** e chama `salvarDados` — que
grava só o slot ativo. **Não toca B/C/D.** O "safety backup" que ele cria, porém, é o snapshot
da CONTA (via `salvarDados` + nome local em localStorage); herda o problema do §3 até a Fase 1.
_Falta: teste que prove reset(A) não altera B/C/D._

## 5. viagem / horasVida — CONFIRMADO por perfil

Ambos vivem em `config` por perfil, sanitizados em `_sanitizarConfigPerfil` (`:989`). Bug
histórico (corrida da troca de perfil) corrigido em e8b9dd1; guardas em `salvarDados`
(`_trocandoPerfil`). _Falta: teste de regressão de troca de perfil._

## 6. Reserva compartilhada HOJE — CONFIRMADO (intra-conta)

`reserva-familia.js` (reconstruída 2026-07-18, após o rollback das tabelas `shared_reserves`):
é uma **caixinha normal no blob** com `meta.compartilhada=true`, `meta.membros[]` (IDs de
perfil) e `meta.movimentos[]` (livro-razão append-only por membro). Gated por
`contaCompartilhada` (só casal/família). **Sem convite/aceite.** As tabelas `shared_reserves`
**não existem** (confirmado no censo de tabelas) — rollback bem-sucedido.

## 7. Notificações (para o convite/aceite) — estado atual

`radar_notifications` (por `user_id` de auth): RLS = SELECT own, INSERT own+pending, DELETE
own+pending. **Sem policy de UPDATE para authenticated** → marcar como aceito/recusado precisa
de edge (service_role) OU nova policy. `tipo`/`title`/`body`/`url`/`fire_at`/`status`. Push já
existe (`send-radar-push`, VAPID). Regra de privacidade do Radar: **sem R$ no payload**.

## 8. RLS relevante (base para /god-eyes) — tudo com RLS ON

- `user_data`: select (dono OU membro ativo), insert/update/delete (dono), service_role ALL. ✔
- `user_data_snapshots`: SELECT own; escrita só service_role (cron/edge). ✔
- `account_members`: dono gerencia; membro lê própria linha; service_role ALL. ✔
- `radar_notifications`: como §7. ✔

---

## Riscos herdados a respeitar
1. Save path já causou perda total 2× (corrida memória×disco). Preferir servidor atômico.
2. Allow-list descarta campo novo em silêncio → registrar em `_ALLOWED_KEYS`/`_sanitizar*`
   e em `check-allowlist.mjs`.
3. Não reintroduzir tabelas sem razão de escopo (lição do `shared_reserves` revertido).
4. Migrations via Management API (não `db push`); UP+DOWN; censo de policies antes/depois.
5. commit ≠ deploy de edge; `config.toml` `verify_jwt` explícito para função nova.
