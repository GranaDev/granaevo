# Testes manuais pendentes — sessão de 2026-07-27

Tudo aqui foi verificado no que dá para verificar de fora (status HTTP, estado do
banco, conteúdo dos chunks publicados, testes automatizados). O que sobrou exige
uma **sessão de usuário real**, que eu não consigo criar.

Marque conforme for testando. Se algo falhar, o rollback de cada item está no fim.

---

## 1. Verificação em duas etapas (2FA) — B-1

> Ninguém ativou ainda: `auth.mfa_factors` tem 0 fatores verificados.
> Use uma conta descartável na primeira vez, não a principal.

- [ ] **Ativar:** Configurações → Segurança da conta → "Ativar verificação em duas etapas"
- [ ] **O QR aparece** (era o bug do `<?xml`; corrigido no commit `6da9681`)
- [ ] Se estiver no celular: o link **"Abrir direto no app autenticador"** abre o app
- [ ] **A chave manual** copia ao tocar
- [ ] Digitar o código de 6 dígitos → **ativa** e mostra os **10 códigos de recuperação**
- [ ] **Baixar os códigos** (.txt) — é a única vez que eles aparecem
- [ ] Chega **e-mail** avisando que um fator foi cadastrado (liguei essa notificação)
- [ ] **Deslogar e entrar de novo:** pede o código depois da senha
- [ ] Código errado 1× → mensagem de erro com tentativas restantes
- [ ] Código certo → entra normalmente
- [ ] **Recarregar o app com 2FA ativo:** os dados carregam e salvam
      (é o gate `aal2` das edges — se travar aqui, me avise, é o item mais delicado)
- [ ] **Desativar:** Configurações → Segurança → "Desativar" → pede a senha
- [ ] Senha errada → recusa · Senha certa → desativa e chega e-mail

### Teste do caminho de recuperação (opcional, mas é o que salva quem perde o celular)
- [ ] Ativar o 2FA de novo, guardar os códigos
- [ ] Deslogar → na tela do código, clicar em **"Perdi o acesso ao meu autenticador"**
- [ ] Ler o aviso (ele diz que isso DESATIVA o 2FA) e usar um código de recuperação
- [ ] Entra, e o 2FA aparece como **Desativado** nas Configurações

---

## 2. Exportação de dados (LGPD) — A-3

- [ ] Configurações → **Privacidade** → "Baixar meus dados"
- [ ] Pede a senha; senha errada → "Senha incorreta"
- [ ] Senha certa → baixa `granaevo-meus-dados-AAAA-MM-DD.json`
- [ ] Abrir o arquivo e conferir:
  - [ ] `dados_financeiros` traz **todos os seus perfis**, não só o que estava aberto
  - [ ] transações, cartões, contas fixas, assinaturas e metas estão lá
  - [ ] `metadados_da_conta.aparelhos_reconhecidos` **não está null**
        (era o bug de nome de coluna que corrigi antes de subir)
  - [ ] **não existe** senha, token, `device_hash` ou chave de criptografia no arquivo

---

## 3. Caixa de entrada do sino — A-2

- [ ] Abrir o sino e clicar no **X** de um aviso
- [ ] O aviso **some** (estava morto em produção desde o commit `2d8de79`)
- [ ] Recarregar: ele continua fora

---

## 4. Limite de perfis — S-1

- [ ] Criar um perfil normalmente **ainda funciona**
      (esta é a parte que eu mais quis testar: a correção mudou o trigger para
      AFTER, e junto a comparação de `>=` para `>`. Se a comparação estivesse
      errada, o PRIMEIRO perfil de todo plano Individual seria bloqueado.)
- [ ] Estourar o limite do plano → aparece o popup de limite, como antes

---

## 5. Alertas de segurança — B-4  ⚠️ ESTE É CONFIGURAÇÃO, NÃO TESTE

- [ ] Conferir no dashboard da **Vercel** se existem as duas env vars:
      - `RESEND_API_KEY`
      - `SECURITY_ALERT_EMAIL`
- [ ] **Sem as duas, todo o B-4 conta e loga mas NÃO manda e-mail** (`api/_alert.js:93`
      retorna cedo). É o único passo que faltou para o alerta funcionar de verdade.

---

## Rollback, se algo quebrar

| Item | Como reverter |
|---|---|
| 2FA trava o carregamento de dados | Redeploy das edges do commit anterior, **depois** `supabase/migrations/20260727030000_mfa_gate_edges.down.sql`. Nessa ordem — o gate falha fechado, então dropar a função com as edges no ar tranca todo mundo. |
| Enforcement `aal2` bloqueando indevidamente | `20260727020000_mfa_aal2_enforcement.down.sql` |
| Criação de perfil quebrada | `20260727010000_fix_profile_limit_batch_bypass.down.sql` (⚠️ reabre o bypass em lote) |
| X do sino | `20260727060000_radar_dismiss_grant.down.sql` |
| Exportação / step-up | `git revert aa0ef75` |
