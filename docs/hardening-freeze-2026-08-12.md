# HARDENING SECURITY FREEZE — 2026-08-12

Marco de encerramento da fase de segurança e resiliência. **Não é um relatório
de intenções: cada linha abaixo foi verificada no momento do congelamento**, com
os comandos indicados. O que não pôde ser verificado está marcado como tal.

---

## Estado verificado

### Segurança da aplicação
| | |
|---|---|
| Achados corrigidos e em produção | **9** (SEC-001 a SEC-009) |
| Verificações pós-deploy com requisição real | 11 de 12 |
| Suíte de testes | **1555/1555** · 356 suites |
| Testes de segurança/resiliência dedicados | 46 + 22 |
| Invariantes do banco de produção | **12/12** (`verificar-restore.mjs`) |

Conferido com:
```bash
npm test
node scripts/verificar-restore.mjs --ref <prod>
```

### Recuperação de desastre
| | |
|---|---|
| Backup | diário 03:00, Agendador do Windows, `StartWhenAvailable` |
| Conteúdo | `public` + `auth` + `storage`, **com grants** + `privilegios.sql` |
| Cifra | AES-256 (gpg simétrico), chave fora da máquina |
| Destino externo | Cloudflare R2, retenção 14, pareada |
| Monitoramento | exit code propagado ao Agendador + log diário |
| **RPO** | **~24 h** (o `user_data` tem 5 pontos extras por snapshot) |
| **RTO do banco** | **~1,3 min** — medido em ensaio cronometrado, não estimado |
| Restore ponta a ponta | **VERIFIED** — inclusive login real no destino |
| Privilégios pós-restore | **VERIFIED** — validador reprova antes, aprova depois |

### Infraestrutura
| | |
|---|---|
| Bypass de origem (Cloudflare → Vercel) | bloqueado (`403 X-Vercel-Mitigated`) |
| Previews antigos | **0** (7 removidos) |
| Deployment Protection | ativa, escopo `preview` — **provada**: preview real → `302 → vercel.com/sso-api` |
| Credenciais privilegiadas em Preview | **nenhuma** (13 nomes conferidos) |
| `PROXY_SECRET` em Preview | ausente — barreira principal intacta |
| Source maps em produção | ausentes |

Conferido com `node scripts/verificar-vercel.mjs` → 8/8.

---

## Pendências conhecidas

| | Estado | Prazo |
|---|---|---|
| **RTO completo do SaaS** | 🟡 **não medido** — o 1,3 min é só o banco; repontar Vercel, 34 edges, 18 crons e o bucket não foi cronometrado | quando houver ensaio completo |
| Próximo ensaio de restore | 🟡 semestral | **2027-02** |
| Renovação do token do R2 | 🟡 TTL 90 dias | **2026-11-10** |
| Fotos do Storage no backup | 🟡 não cobertas (só metadados) — perda aceita | — |
| PITR | 🟡 indisponível no plano Free; `pg_dump` diário é o substituto | — |
| Access token pós-reset de senha | 🟡 residual conhecido, ≤1 h, mitigado pelo SEC-009 | — |
| Flake em `aplicar-operacoes.test.js` | ⚠️ falhou 1× na suíte cheia, 3/3 depois | observar |

---

## Regra de congelamento

> **Não realizar novas alterações de segurança sem um novo achado, mudança
> arquitetural ou requisito concreto.**
>
> Toda alteração futura deve preservar a suíte de regressão.

O que **continua** valendo sem precisar de decisão nova:
- rodar `npm test` no CI a cada mudança (1555/1555 é o piso);
- rodar `verificar-restore.mjs` e `verificar-vercel.mjs` depois de mexer em
  banco ou em configuração de deploy;
- seguir o `docs/runbook-desastre.md` em incidente — **os dois passos**, nunca só
  o `pg_restore`.

O que **exige** novo achado ou requisito:
- mexer em RLS, grants, policies ou funções `SECURITY DEFINER`;
- alterar o fluxo de autenticação, MFA ou sessão;
- afrouxar rate limit, CSP ou headers;
- mudar o escopo do backup ou a política de retenção.

---

## O que esta fase ensinou, e que vale mais que os achados

**1. `exit 0` não é prova.** O `pg_restore` terminava com sucesso e devolvia um
banco com 34 `SECURITY DEFINER` abertas ao `anon` (produção tem 2) e 28 tabelas
graváveis (produção tem 4). Backup de dados ≠ backup restaurável com o mesmo
estado de segurança.

**2. Auditar caminhos, não controles.** Duas rodadas perguntaram "esta operação
tem proteção?" e responderam sim. A terceira perguntou "tem proteção em **todos**
os caminhos?" e achou o SEC-009 — um grant que a aplicação nunca usava e que
pulava as cinco defesas do caminho oficial.

**3. Cadeias importam mais que itens.** SEC-008 (token sobrevive ao reset) e
SEC-009 (escrita direta) pareciam independentes. Juntos permitiam apagar o blob
financeiro **depois** de a vítima trocar a senha.

**4. O caminho de erro é o que ninguém observa.** Três defeitos vieram daí: o
`gpg` fora do PATH do Agendador (backup falharia toda noite), o log dizendo "OK"
com exit 1, e dumps em texto claro sobrando quando a execução morria no meio.

**5. Proteção acidental não é proteção.** Os previews estavam inexploráveis
porque o `_rate-limit.js` crashava. Um `RATE_LIMIT_STRICT=false` reabriria tudo.

---

## Referências

- `docs/runbook-desastre.md` — procedimento de recuperação
- `scripts/backup-db.mjs` · `_r2.mjs` · `_privilegios.mjs` — backup
- `scripts/verificar-restore.mjs` · `verificar-vercel.mjs` — validadores
- `tests/unit/auditoria-2026-08-11.test.js` · `backup-resiliencia.test.js`
- Migrations `20260811000000` · `20260811010000` · `20260811020000`
