# Testes manuais pendentes — sessão de 2026-07-27

Tudo foi verificado no que dá para verificar de fora: status HTTP, estado do
banco, conteúdo dos chunks publicados, 692 testes automatizados. O que sobrou
aqui exige **uma sessão de usuário real** ou **olhar humano na tela** — nenhuma
das duas coisas eu consigo fazer daqui.

Ordenado por **risco**: os primeiros quebram o app se estiverem errados; os
últimos são estética e conversão.

---

## ✅ BLOCO 1 — APROVADO pelo usuário em 2026-07-27

> **Os dois passaram.** Era o único ponto da sessão que não dava para verificar
> de fora — o gate de 2FA nas edges nunca tinha visto uma sessão real, e o
> trigger de perfis só tinha sido provado por SQL com rollback. Agora ambos
> estão validados na interface. **O risco alto da sessão está fechado.**

### 1.1 Os dados carregam e salvam normalmente ✅
- [x] Abrir o dashboard: os lançamentos aparecem
- [x] Criar uma transação qualquer e recarregar: ela continua lá

> **Por que isto é o teste nº 1:** `get-user-data` e `save-user-data` ganharam um
> gate de 2FA que **falha fechado**. Se a RPC `mfa_bloqueia` não responder, elas
> recusam. Ninguém tem 2FA ativo, então deve ser transparente — mas é o único
> jeito de provar.

### 1.2 Criar perfil ainda funciona ✅
- [x] Criar um perfil novo (dentro do limite do seu plano)
- [x] Estourar o limite: o popup de limite aparece, como antes

> **Por que:** o trigger virou `AFTER INSERT` e a comparação mudou de `>=` para
> `>`. As duas coisas andam em par — se eu tivesse trocado só o timing, o
> **primeiro** perfil de todo plano Individual seria bloqueado.

---

## 🟠 BLOCO 2 — Recursos novos, nunca exercitados por um humano

### 2.0 Conta descartável — criada em 2026-07-30
`oliveiralucas00224+teste2fa@gmail.com` · plano `familia` (4 perfis) · senha **entregue no chat, não versionada**.

Criada por SQL via Management API (a Admin API do GoTrue está bloqueada por WAF).
Detalhes que importam se precisar criar outra:

- `auth.identities` é **obrigatória** — sem ela o login por e-mail não existe.
- `confirmation_token`, `recovery_token`, `email_change_token_new` e `email_change`
  **não têm default** e o GoTrue lê em `string` não-anulável do Go: se ficarem `NULL`,
  todo login devolve `500 Database error querying schema`. Preencher com `''`.
- Sem linha em `stripe_subscriptions` (status `active` + `current_period_end` futuro)
  o `check-user-access` nega e a conta cai em `/planos`. Os IDs Stripe são falsos e
  nomeados `*_FAKE_TESTE_DESCARTAVEL` de propósito.
- No primeiro login ela **pede aceite dos termos** — é comportamento real, não bug.
- Ela nasce com **zero perfis**. Para o teste 2.2 provar "todos os perfis",
  crie 2 ou 3 perfis antes de exportar.

**Apagar quando terminar o bloco:** `node scripts/remove-conta-teste.mjs`

### 2.1 Verificação em duas etapas (2FA)
> Use a conta descartável acima. A conta principal tem zero fatores ativos hoje.

**Ativar**
- [ ] Configurações → Segurança da conta → "Ativar verificação em duas etapas"
- [ ] **O QR aparece** (era o bug do `<?xml`, corrigido em `6da9681`)
- [ ] No celular: o link "Abrir direto no app autenticador" abre o app
- [ ] A chave manual copia ao tocar
- [ ] Código de 6 dígitos → ativa e mostra os **10 códigos de recuperação**
- [ ] Baixar o `.txt` — é a única vez que eles aparecem
- [ ] Chega e-mail avisando que um fator foi cadastrado

**Usar**
- [ ] Deslogar e entrar: pede o código depois da senha
- [ ] Código errado → erro com tentativas restantes
- [ ] Código certo → entra
- [ ] **Com 2FA ativo, recarregar o app: dados carregam e salvam**
      ← se travar aqui, me avise; é o ponto mais delicado de toda a sessão

**Desativar**
- [ ] Configurações → Segurança → "Desativar" → pede a senha
- [ ] Senha errada recusa · senha certa desativa · chega e-mail

**Recuperação** (o que salva quem perde o celular)
- [ ] Reativar, guardar os códigos, deslogar
- [ ] Na tela do código: "Perdi o acesso ao meu autenticador"
- [ ] Ler o aviso (ele diz que isso **desativa** o 2FA) e usar um código
- [ ] Entra, e o 2FA aparece como Desativado

### 2.2 Exportação de dados (LGPD)
- [ ] Configurações → **Privacidade** → "Baixar meus dados"
- [ ] Senha errada → "Senha incorreta"
- [ ] Senha certa → baixa `granaevo-meus-dados-AAAA-MM-DD.json`
- [ ] No arquivo:
  - [ ] `dados_financeiros` traz **todos os perfis**, não só o aberto
  - [ ] `metadados_da_conta.aparelhos_reconhecidos` **não está null**
        ← era o bug de nome de coluna que peguei antes de subir
  - [ ] **não existe** senha, token, `device_hash` nem chave de criptografia

---

## 🟡 BLOCO 3 — Interações que mudaram de lugar

### 3.1 Paleta de comandos e fundo animado (O-1)
> Os dois saíram do `dashboard.js` para chunks que só baixam quando usados.
- [ ] **Ctrl+K** (ou Cmd+K) abre a paleta
- [ ] Digitar filtra, setas navegam, Enter executa, Esc fecha
- [ ] Apertar Ctrl+K de novo **fecha** (não abre uma segunda)
- [ ] Na tela de seleção de perfil, Ctrl+K **não** abre
- [ ] No desktop, o fundo de partículas aparece
- [ ] No celular, **não** aparece (e nem baixa)

### 3.2 Caixa de entrada do sino
- [ ] Clicar no **X** de um aviso: ele some
- [ ] Recarregar: continua fora

> Estava morto em produção desde `2d8de79` — faltava o GRANT.

---

## 🔵 BLOCO 4 — A vitrine (olhar humano, não há como automatizar)

> Mudança de estratégia: a demo agora **cria desejo em vez de saciar**.
> Aqui o que importa não é "funciona?", é **"dá vontade de entrar?"**.

- [ ] Lançar 4 itens: no 4º o formulário **dá lugar** à parede
      ("Seu mês está tomando forma")
- [ ] A parede parece **continuação**, não erro nem paywall
- [ ] **Apagar** um lançamento: o formulário volta
- [ ] "Limpar tudo": o formulário volta
- [ ] Depois da parede, as **perguntas** do assistente ainda respondem
      ("Quanto eu gastei?", "Me dá um resumo")
- [ ] Um insight vem **inteiro**; os outros aparecem só com o **título**,
      numa caixa visivelmente mais fria
- [ ] A faixa "Você viu 3 de mais de 20 recursos" está legível e não parece aviso de erro
- [ ] No celular, a parede e a faixa não quebram o layout

**A pergunta de fundo, que só você responde:** depois de bater na parede, você
sentiria vontade de entrar — ou de fechar a aba? Se for a segunda, o texto da
parede é o que ajusta, não a existência dela.

---

## ✅ BLOCO 5 — APROVADO em 2026-07-27

- [x] `RESEND_API_KEY` (chave própria da Vercel, separada da do Supabase) e
      `SECURITY_ALERT_EMAIL` adicionadas em Production + Preview, com redeploy
- [x] **Testado de ponta a ponta:** 50 requisições contra `/api/auth-session`
      geraram 45 eventos `rate_limit_burst` em 39s (threshold: 40 em 300s).
      O e-mail chegou — assunto correto e **uma vez só**, confirmando que o
      alerta dispara em `count === threshold` e ignora os seguintes.

> O caminho inteiro está provado: evento emitido → contado no Redis → entregue
> pelo Resend. **B-4 fechado.**

---

## Rollback, se algo quebrar

| Sintoma | Como reverter |
|---|---|
| **Dados não carregam/salvam** | Redeploy das edges do commit anterior, **depois** `20260727030000_mfa_gate_edges.down.sql`. **Nessa ordem** — o gate falha fechado, então dropar a função com as edges no ar tranca todo mundo |
| Leitura bloqueada indevidamente | `20260727020000_mfa_aal2_enforcement.down.sql` |
| Não cria perfil | `20260727010000_fix_profile_limit_batch_bypass.down.sql` (⚠️ reabre o bypass em lote) |
| X do sino parou | `20260727060000_radar_dismiss_grant.down.sql` |
| Exportação / step-up | `git revert aa0ef75` |
| Ctrl+K ou partículas | `git revert af2e498` |
| Vitrine | `git revert 889e5f8` |

---

## O que já foi verificado — não precisa refazer

Segurança em produção (401/403/429/440 nos lugares certos) · lockout de conta
(429 com `Retry-After=900` na 6ª tentativa) · RLS `aal2` nos 4 cenários ·
imutabilidade do audit log nos 4 cenários · retenção nas 2 tabelas · `sitemap.xml`
200 · CSP sem Cloudflare · 692 testes automatizados · 18 crons ativos, 0 falhas.
