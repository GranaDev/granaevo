# Runbook de desastre — banco de dados

> Escrito em 2026-08-12 e **ensaiado do zero** no mesmo dia. Os tempos abaixo são
> medidos, não estimados. Se você está lendo isto numa emergência, pule para
> [Procedimento](#procedimento).

---

## A regra que custou caro descobrir

> **`pg_restore` com exit 0 NÃO significa banco restaurado.**

No primeiro ensaio, um restore "bem-sucedido" devolveu um banco assim:

| | produção | restaurado só com o dump |
|---|---|---|
| `SECURITY DEFINER` executáveis por `anon` | 2 | **34** |
| Tabelas graváveis por `authenticated` | 4 | **28** |

Nesse estado, o `anon` — **sem login** — executa `salvar_dados_usuario`,
`revogar_sessoes_usuario` e todas as `purge_*`. O `authenticated` apaga
`password_reset_codes` e `financial_audit_log`.

**Causa:** o `pg_dump` só emite `GRANT`, nunca `REVOKE` — para ele um objeto
recém-criado não tem privilégio, então basta conceder. E o Supabase tem
`ALTER DEFAULT PRIVILEGES` que concedem acesso no `CREATE TABLE`. O CREATE
libera tudo, o GRANT do dump acrescenta, e o REVOKE nunca chega.

Por isso o backup tem **dois arquivos** e o procedimento tem **dois passos**.

---

## RPO — quanto se perde

| Dado | Cobertura | Perda máxima |
|---|---|---|
| Banco completo (`public` + `auth` + `storage`) | `backup-db.mjs`, diário às 03:00 | **~24 h** |
| `user_data` (blob financeiro) | + snapshots diários em `user_data_snapshots`, 5 dias | **~24 h**, com 5 pontos de retorno |
| Objetos do Storage (fotos) | ⚠️ **não coberto** — o dump traz os metadados, não os arquivos | total |

Não existe PITR (plano Free). Um incidente às 02:50 perde quase um dia inteiro.

## RTO — quanto demora

**1,3 minuto** até banco restaurado e validado. Medido no ensaio de 2026-08-12:

```
 7,9s  provisionar projeto Supabase novo
 2,3s  banco começar a responder
 0,5s  baixar do R2 e decifrar
 6,7s  pg_restore (public + auth + storage)
27,3s  validação  -> REPROVA (esperado: privilégios ainda não aplicados)
 2,1s  aplicar privilegios.sql
25,4s  validação  -> APROVA
 3,9s  GoTrue respondendo
```

⚠️ **Esse é o RTO do BANCO.** O tempo total de volta ao ar inclui repontar a
aplicação (Vercel + Edge Functions) para o novo ref, o que **não foi
cronometrado** — some pelo menos os minutos de trocar `SUPABASE_URL`, as chaves
e redeployar as 34 edges.

---

## Procedimento

### 0. Antes de tocar em qualquer coisa
- [ ] Confirme que é perda de dados, não indisponibilidade. Restaurar por cima
      de um banco vivo com problema de rede **destrói o que ainda estava lá**.
- [ ] Anote a hora do incidente — define qual backup usar.
- [ ] Tenha em mãos: `SUPABASE_ACCESS_TOKEN`, `GRANAEVO_BACKUP_KEY`
      (gerenciador/pen drive), credenciais do R2.

### 1. Escolher o backup
```bash
node -e "import('./scripts/_r2.mjs').then(async ({r2Listar})=>console.log((await r2Listar('granaevo-backups')).join('\n')))"
```
Pegue o par `granaevo-<ts>.dump.gpg` **e** `granaevo-<ts>.privilegios.sql.gpg`
do **mesmo carimbo**. Misturar carimbos aplica privilégios de outro momento.

### 2. Decifrar
```bash
gpg --batch --decrypt --passphrase-fd 0 --pinentry-mode loopback \
    --output restore.dump granaevo-<ts>.dump.gpg
gpg --batch --decrypt --passphrase-fd 0 --pinentry-mode loopback \
    --output privilegios.sql granaevo-<ts>.privilegios.sql.gpg
```
> Sem a `GRANAEVO_BACKUP_KEY` nada disso funciona e **não existe recuperação**.

### 3. Destino
Projeto Supabase novo, **mesma região** (`sa-east-1`) e mesma major do Postgres
(17.x). Guarde o `ref` e a senha do banco.

### 4. `pg_restore` — os dois schemas, em ordens diferentes

`public` completo:
```bash
pg_restore --host <pooler-host> --port 5432 --username postgres.<ref> \
  --dbname postgres --no-owner --schema public restore.dump
```

`auth` e `storage` **só dados** (a estrutura já existe, criada pela plataforma)
e **em ordem de dependência** — `-L` respeita a ordem da lista, e o
`--list` sai alfabético, o que faz `identities` vir antes de `users` e quebrar
por FK:
```bash
pg_restore --list restore.dump | grep -E "TABLE DATA (auth|storage) " \
  | grep -v migrations > toc.txt
# reordene: 'auth users' primeiro, depois 'auth sessions', depois 'auth mfa_factors'
pg_restore --host <pooler-host> --port 5432 --username postgres.<ref> \
  --dbname postgres --no-owner --data-only -L toc.txt restore.dump
```

**Nunca use `--no-privileges`.** É o que descarta os grants.
**Sempre use `--no-owner`.** Os donos são papéis internos do Supabase.
**Porta 5432**, não 6543 (transaction mode quebra o restore).
**Usuário `postgres.<ref>`** — sem o sufixo o Supavisor responde `ENOIDENTIFIER`.

### 5. ⚠️ Aplicar os privilégios — NÃO PULE
```bash
psql "postgresql://postgres.<ref>:<senha>@<pooler-host>:5432/postgres" \
     -f privilegios.sql
```

### 6. Validar — o passo que decide
```bash
node scripts/verificar-restore.mjs --ref <ref>
```
São 12 invariantes absolutas (RLS, FORCE RLS, DEFINER expostas, grants de
`user_data`, policies, `search_path`, `auth.users`, pareamento de identities,
dados financeiros presentes).

> **Exit != 0 → o banco NÃO vai ao ar.** Quase sempre significa que o passo 5
> foi pulado. No ensaio o validador reprovou antes e aprovou depois — ele
> detecta exatamente essa falha.

### 7. Repontar a aplicação
- [ ] `SUPABASE_URL` e chaves publishable/secret → novo projeto (Vercel + Supabase secrets)
- [ ] `supabase functions deploy` das 34 edges
- [ ] Reconfigurar os 18 cron jobs (`pg_cron` não vem no dump)
- [ ] Recriar o bucket `profile-photos` e as policies de storage
- [ ] Fotos: **não estão no backup** — perda aceita

### 8. Validar de ponta a ponta
- [ ] Login com uma conta real
- [ ] Dashboard carrega transações
- [ ] Salvar uma transação e recarregar
- [ ] Bell/notificações, reservas, cartões

---

## O que este backup **não** cobre

| | |
|---|---|
| Arquivos do Storage | só metadados; os binários ficam no S3 do Supabase |
| Cron jobs (`pg_cron`) | fora dos schemas dumpados — recriar pelas migrations |
| Secrets das Edge Functions | vivem no Supabase, não no banco |
| Config do GoTrue | provedores, templates de e-mail, `jwt_expiry` |
| Config da Vercel/Cloudflare | fora de escopo |

---

## Manutenção

- **Ensaiar a cada 6 meses.** Backup nunca restaurado é promessa. Este runbook
  foi ensaiado em 2026-08-12; **próximo ensaio: 2027-02**.
- **Renovar o token do R2** (TTL 90 dias) — vence em **2026-11-10**.
- Conferir os logs em `granaevo-backups\logs\` de vez em quando: um cron que
  falha em silêncio é indistinguível de não existir.
