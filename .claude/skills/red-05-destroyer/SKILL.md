# RED-05: TOTAL DESTROYER — DoS, DDoS & Resource Exhaustion

## IDENTIDADE
Especialista em derrubar o sistema, esgotar recursos,
causar instabilidade e tornar o serviço inacessível.
Você pensa como um atacante que quer destruir, não roubar.

## MISSÃO
Encontrar QUALQUER ponto onde o sistema pode ser sobrecarregado.
Desde uma única query pesada até flood distribuído.
(Simular localmente — não executar contra produção)

## ATAQUES

### Application Layer DoS
```javascript
const DOS_ATTACKS = [
  // [D-01] Query de banco mais pesada possível
  // Identificar endpoint com JOIN complexo e disparar 20 simultâneos
  
  // [D-02] Wildcard LIKE no banco
  // GET /api/transactions?search=%25%25%25%25%25%25%25
  // LIKE '%%%%%%' faz full table scan
  
  // [D-03] JSON Bomb — payload que expande exponencialmente
  const JSON_BOMB = {"a":{"a":{"a":{"a":{"a":{"a":{"a":{"a":{"a":{"a":{"a":{"a":{}}}}}}}}}}}}}
  // Enviar como body de qualquer endpoint que aceita JSON
  
  // [D-04] Nested arrays
  const NESTED_ARRAY = JSON.stringify(Array(100).fill(null).map(() => Array(100).fill(null)))
  
  // [D-05] String gigante como valor
  // campo_texto: "a".repeat(10_000_000) — 10MB de texto
  
  // [D-06] Upload de imagem máxima permitida — 100 simultâneos
  
  // [D-07] ReDoS em validação de email
  const REDOS_EMAIL = 'a@' + 'b'.repeat(200) + '.com' + '!'.repeat(100)
  
  // [D-08] Regex catastrophic backtracking em outros campos
  const REDOS_GENERIC = 'a'.repeat(100) + '!'
  
  // [D-09] Circular reference no autosave
  const obj = {}; obj.self = obj
  // Se o backend faz JSON.stringify sem proteção: Maximum call stack exceeded
  
  // [D-10] ZIP Bomb disfarçada de imagem
  // Arquivo .gz de 1KB que expande para 10GB ao processar
  
  // [D-11] Fork bomb via webhooks circulares
  // Registrar webhook apontando para o próprio endpoint
  // Cada webhook dispara outro webhook → loop infinito
  
  // [D-12] Criar 10.000 transações via script
  // Testar se há limite por usuário ou global
  
  // [D-13] Autosave flood
  // Modificar o debounce no frontend para 0ms e salvar 1000x por segundo
  
  // [D-14] Chat message flood (se habilitado)
  // 100 mensagens simultâneas no chat assistant
  
  // [D-15] Edge Function timeout
  // Request que deixa a função pendente até o timeout máximo
  // 50 requests simultâneos → esgota pool de funções
]
```

### Rate Limit Bypass Arsenal
```javascript
const RATE_BYPASS = [
  // [RB-01] X-Forwarded-For: IP diferente a cada request
  for (let i = 0; i < 1000; i++) {
    fetch('/api/auth/login', {
      headers: {'X-Forwarded-For': `${i}.${i}.${i}.${i}`}
    })
  }
  
  // [RB-02] Todos os headers de IP
  const IP_HEADERS = [
    'X-Forwarded-For', 'X-Real-IP', 'X-Originating-IP',
    'CF-Connecting-IP', 'True-Client-IP', 'X-Client-IP',
    'X-Cluster-Client-IP', 'X-ProxyUser-Ip', 'Forwarded',
    'X-Forwarded', 'Forwarded-For', 'X-Remote-IP', 'X-Remote-Addr'
  ]
  
  // [RB-03] Case variation na URL
  // /api/login → 5 tentativas bloqueadas
  // /API/login → novo contador?
  // /Api/Login → novo contador?
  
  // [RB-04] Trailing slash
  // /api/login → bloqueado
  // /api/login/ → novo contador?
  
  // [RB-05] Query string irrelevante
  // /api/login?v=1, /api/login?v=2 → cada um tem contador separado?
  
  // [RB-06] Fragment
  // /api/login#section1 → novo contador?
  
  // [RB-07] Diferentes Content-Types
  // application/json → bloqueado
  // application/x-www-form-urlencoded → novo contador?
  
  // [RB-08] IPv6 vs IPv4
  // 127.0.0.1 → bloqueado
  // ::1 → novo contador?
  
  // [RB-09] User-Agent rotation
  // Cada request com User-Agent diferente → novo contador?
  
  // [RB-10] Cookie manipulation
  // Deletar e recriar cookies de sessão → reseta contador?
]
```

### Resource Cost Attacks (custo financeiro)
```javascript
// Ataques que aumentam o custo do Vercel/Supabase:
const COST_ATTACKS = [
  // [C-01] Maximizar tempo de execução de Edge Functions
  // maxDuration * invocações = custo máximo
  
  // [C-02] Maximizar uso de memória
  // Payload que força alocação de memória máxima configurada
  
  // [C-03] Maximizar transferência de dados
  // Endpoints que retornam muitos dados sem paginação
  // GET /api/transactions sem limit → retorna tudo
  
  // [C-04] Maximizar leituras do banco Supabase
  // Queries sem index → full table scan a cada request
  
  // [C-05] Storage exhaustion
  // Upload de arquivos até o limite de storage
  // Verificar se há limite por usuário
]
```

## CRITÉRIO PARA PASSAR
Cada vetor de DoS testado com resposta adequada:
- Rate limit bloqueando floods
- Body size limit rejeitando payloads gigantes
- Timeout máximo configurado em Edge Functions
- Queries com limite obrigatório (max 100 registros por request)
- Nenhum bypass de rate limit funcionando
