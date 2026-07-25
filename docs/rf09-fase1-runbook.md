# RF-09 — Fase 1: restore POR PERFIL (runbook + checklist)

_Data: 2026-07-24. Escopo: isolar a RESTAURAÇÃO por perfil. **Sem migration.**_

## O que mudou (diffs)

| Arquivo | Mudança |
|---|---|
| `supabase/functions/user-data-backup/_restore-core.js` | **NOVO.** Núcleo puro + cripto (réplica exata do v2 HKDF→AES-GCM). `buildRestoredBlob`/`mergeProfileSlot`/crypto. Runtime-agnóstico. |
| `supabase/functions/user-data-backup/index.ts` | Restore agora aceita `profile_id`: lê blob atual + snapshot, decifra ambos, troca **só o slot do perfil**, re-cifra, grava com **CAS** (`last_modified`). Sem `profile_id` → fallback conta inteira (rollback). |
| `api/user-data.js` | Valida e repassa `profile_id` (string, 1–64) ao edge. |
| `src/scripts/pages/db-configuracoes.js` | `_abrirConfirmacaoRestauracao` envia `profile_id: perfilAtivo.id`; copy honesta ("só este perfil; os outros não são afetados"); barra restore sem perfil ativo. |
| `tests/unit/restore-slot.test.js` | **NOVO.** 13 testes. Prova a invariante: restaurar A não altera B/C/D (em blob cifrado). |

## Como aplicar (na ordem)

> **Nada aqui é migration** — é deploy de edge + Vercel. `commit ≠ deploy`.

1. **Testes locais** (já verdes aqui):
   ```
   npm run test:unit        # 591 pass, inclui restore-slot
   npm run check:refs
   npm run check:allowlist
   ```
2. **Type-check do edge** (sua máquina, tem Deno):
   ```
   deno check supabase/functions/user-data-backup/index.ts
   ```
3. **Deploy do edge** (bundla o `_restore-core.js` automaticamente):
   ```
   supabase functions deploy user-data-backup
   ```
   - Confirme que `DATA_ENCRYPTION_KEY` está nas secrets do projeto (mesma que save/get usam). Sem ela, blob cifrado → o edge **falha alto** (`restore_falhou`), não corrompe.
   - `config.toml` de `user-data-backup` **não muda** (a função já existia; sem novo `verify_jwt`).
4. **Deploy do frontend + `api/`** (Vercel, push da branch).
5. **Smoke test** com a conta família (checklist abaixo).

## Ordem de deploy segura (compatibilidade)

- **Edge primeiro, cliente depois** é seguro: o novo edge aceita `profile_id` **e** o fallback antigo (sem `profile_id`).
- **Cliente primeiro, edge depois** NÃO: o cliente novo manda `profile_id`, e o edge antigo ignora → faria restore de conta inteira (o footgun). **Portanto: edge antes do cliente.**

## Runbook de ROLLBACK

- **Reverter o edge**: `supabase functions deploy user-data-backup` a partir do commit anterior (o fallback de conta inteira volta a ser o único caminho). O `_restore-core.js` não é uma função standalone (prefixo `_`), então some junto.
- **Reverter o cliente**: redeploy do frontend do commit anterior. O edge novo continua compatível (aceita requests sem `profile_id`).
- **Sem estado a desfazer**: não há migration, coluna nova nem dado migrado. Rollback é só redeploy.

## Limitação herdada (NÃO introduzida agora, apenas registrada)

O "safety backup" criado antes de restaurar/resetar só chama `salvarDados` (grava `user_data`);
o snapshot de HOJE é criado pelo cron `take_daily_snapshot` (03:15) e é **idempotente por dia**.
Se o snapshot de hoje já existe (com estado anterior), o safety-backup nomeado aponta para ele,
não para o estado recém-salvo. Fechar isso exigiria snapshot-on-demand no servidor — fora do
escopo do RF-09 por-slot. Registrar para uma fase futura.

---

## ✅ Checklist de teste — conta FAMÍLIA real (2 membros, 4 perfis)

Pré-condição: plano Família, membros M1 (dono) e M2 (convidado) logando **separados**; perfis
A, B, C, D com dados distintos e reconhecíveis (ex.: uma transação "MARCA-A 111", "MARCA-B 222"…).

1. **Snapshot base**: garanta que existe um backup de ontem/hoje (ou espere o cron / force via
   suporte). Anote os valores atuais de A/B/C/D.
2. **Muda A**: entre no perfil A, adicione "MARCA-A NOVA 999". Muda B/C/D também com marcas novas.
3. **Restaura A**: Configurações → Dados e Backup → Histórico → Restaurar (backup anterior às marcas).
   - A copy deve dizer **"o perfil A será restaurado… os outros perfis não são afetados"**.
4. **Verifica isolamento** (o coração do RF-09):
   - [ ] Perfil A voltou ao estado do backup (sem "MARCA-A NOVA 999").
   - [ ] Perfil B mantém "MARCA-B NOVA" (NÃO revertido).
   - [ ] Perfil C mantém suas mudanças.
   - [ ] Perfil D mantém suas mudanças.
5. **Convidado restaura**: M2 loga, entra num perfil que ele usa, restaura. Confirma que só
   aquele perfil volta; os de M1 não são tocados.
6. **Perfil ausente no backup**: crie um perfil E novo (após o snapshot), tente restaurar E de um
   backup que não o contém → deve dar erro claro **"Este perfil não existe nesse backup"**, sem
   quebrar nada.
7. **Reset por perfil** (Fase 2 já OK, mas re-teste): resetar A não altera B/C/D.
8. **Concorrência** (opcional): abra duas abas, edite numa, restaure na outra → deve aparecer
   **"Os dados mudaram durante a restauração. Recarregue e tente novamente."** (CAS), sem corromper.
