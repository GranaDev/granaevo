# Setup do acesso Supabase para /god-mode e /god-eyes

Este projeto usa o **servidor MCP oficial do Supabase** (`@supabase/mcp-server-supabase`)
em **modo read-only** para que `/god-mode` e `/god-eyes` consigam auditar RLS, crons,
triggers e conformidade LGPD diretamente no banco de produção.

> **REGRA DE OURO:** o token NUNCA entra no repositório. Ele mora apenas como
> variável de ambiente do Windows. O `.mcp.json` commitado só carrega
> `${SUPABASE_ACCESS_TOKEN}` e `${SUPABASE_PROJECT_REF}` — nenhum segredo nem
> identificador de projeto fica versionado.

---

## 1. Gerar o token (uma vez)

1. Acesse https://supabase.com/dashboard/account/tokens
2. **Revogue** qualquer token antigo que já tenha sido exposto.
3. Clique em **Generate new token**, dê um nome (ex: `god-mode-readonly`).
4. Copie o valor `sbp_...` — ele só aparece UMA vez.

> Nunca cole esse token em chat, commit, issue ou print. Se vazar, revogue e gere outro.

## 2. Guardar o token nas variáveis de ambiente do Windows (uma vez)

Abra um **PowerShell** e rode (troque pelos valores reais):

```powershell
setx SUPABASE_ACCESS_TOKEN "sbp_SEU_TOKEN_NOVO_AQUI"
setx SUPABASE_PROJECT_REF  "fvrhqqeofqedmhadzzqw"
```

- `setx` grava no perfil do usuário do Windows — persiste entre reinícios.
- O `project-ref` acima é o do `granaevo-prod`; confirme em `supabase/.temp/project-ref`.

## 3. Reiniciar o ambiente

`setx` só vale para processos **novos**. Feche e reabra o terminal **e** o
Claude Code / VS Code para que as variáveis sejam carregadas.

## 4. Aprovar o servidor MCP

Na primeira vez que o Claude Code carregar o `.mcp.json`, ele vai pedir aprovação
para iniciar o servidor `supabase`. Aprove. Verifique com:

```
/mcp
```

Deve listar `supabase` como conectado.

## 5. Verificar (opcional)

Peça ao Claude: *"liste as tabelas do schema public via MCP do Supabase"*.
Se voltar a lista, o acesso read-only está funcionando.

---

## Por que read-only?

O flag `--read-only` faz o servidor MCP rejeitar qualquer `INSERT/UPDATE/DELETE/DDL`.
A auditoria **lê** o estado do banco, gera as migrations corretoras como texto, e
deixa a aplicação para você revisar e rodar manualmente — alinhado ao CLAUDE.md
("Nunca aplicar correção em produção sem sinalizar ao desenvolvedor").

## Troubleshooting

| Sintoma | Causa provável | Correção |
|---|---|---|
| `/mcp` não mostra `supabase` | env vars não carregadas | Reabra o terminal+editor após o `setx` |
| MCP conecta mas toda query falha com 401 | token inválido/revogado | Gere novo token, refaça `setx`, reinicie |
| `project not found` | `SUPABASE_PROJECT_REF` errado | Confira `supabase/.temp/project-ref` |
| Erro ao tentar escrever | esperado — modo read-only | A auditoria não muta prod; aplique migrations você mesmo |