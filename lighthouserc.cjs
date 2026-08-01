// ----------------------------------------------------------------------------
// lighthouserc.cjs — orçamento de performance no CI (Passo 27)
//
// POR QUE EXISTE: o guard que já havia (`check-bundle-size.mjs`) mede BYTES.
// Byte pequeno não garante tela rápida — dá para caber no orçamento e ainda
// assim bloquear o paint. Isto mede a EXPERIÊNCIA (LCP/CLS/TBT) e falha o CI
// quando ela regride.
//
// ── QUAIS PÁGINAS (e por que só estas) ──────────────────────────────────────
// Só as PÚBLICAS. O dashboard exige login, e um Lighthouse sem sessão mediria a
// tela de redirect, não o app — número bonito e mentiroso. Landing, planos e
// login são justamente onde LCP importa para conversão.
//
// ── SOBRE INP ───────────────────────────────────────────────────────────────
// O roadmap pede "orçamento de LCP/INP". INP é métrica de CAMPO: depende de
// interação real do usuário e o Lighthouse em laboratório NÃO o mede. O
// substituto honesto em lab é TBT (Total Blocking Time), que é o que está
// travado aqui. Prometer "INP no CI" seria vender o que a ferramenta não faz.
//
// ── ERROR vs WARN ───────────────────────────────────────────────────────────
// `error` para LCP/CLS/TBT: são os limiares "good" dos Core Web Vitals do
// Google, não números que eu inventei.
//
// Os SCORES de categoria nasceram como `warn` porque não havia como medir a
// linha de base localmente (o chrome-launcher quebra no Windows com EPERM;
// depois disso, a máquina simplesmente não tem Chrome). Travar o CI com um
// limiar nunca visto rodar seria irresponsável.
//
// ✅ Promovidos a `error` em 2026-07-31, com a primeira execução real do CI na
// mão. Os limiares e o porquê de cada um estão no bloco `assert` lá embaixo —
// inclusive por que o login tem regra própria e por que performance não usa
// 0,90 como os outros.
// ----------------------------------------------------------------------------

module.exports = {
  ci: {
    collect: {
      staticDistDir: 'dist',
      url: [
        'http://localhost/index.html',
        'http://localhost/planos.html',
        'http://localhost/login.html',
      ],
      // 3 execuções e mediana: uma só varia demais entre runs de CI.
      numberOfRuns: 3,
      settings: {
        preset: 'desktop',
        onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
        // uses-http2 e canonical dependem do servidor/host real — num diretório
        // estático servido localmente reprovam sempre, sem dizer nada de útil.
        skipAudits: ['uses-http2', 'canonical'],
      },
    },
    // ── PROMOVIDO A GATE REAL EM 2026-07-31, com números na mão ─────────────
    // O cabeçalho dizia: "depois da primeira execução real no CI, com os
    // números à vista, dá para promover os scores a error". A execução saiu
    // (commit af4e1e6) e disse o seguinte:
    //
    //   • NENHUM `error` disparou — LCP, CLS e TBT passaram nas três páginas.
    //   • performance e accessibility passaram de 0,90 nas três.
    //   • login.html: seo 0,54 e best-practices 0,85. Só ele.
    //
    // O 0,54 do login NÃO É DEFEITO — é a decisão certa medida pela régua
    // errada. `robots.txt` proíbe `/login` ("rotas autenticadas — sem conteúdo
    // indexável"), ele não está no sitemap e não tem meta description, tudo de
    // propósito. Perseguir 0,9 ali significaria tornar a tela de login
    // indexável: deixar a métrica mandar no produto. Então SEO passa a ser
    // exigido só de quem existe para ser encontrado.
    //
    // O 0,85 de best-practices do login é artefato do ambiente: a página carrega
    // o Turnstile da Cloudflare, e num diretório estático servido em localhost
    // o widget não tem como se inicializar — sobra erro no console, que é
    // exatamente o que esse audit conta. Fica `warn` até ser medido contra o
    // domínio real.
    //
    // ── POR QUE OS LIMIARES DE `error` NÃO SÃO TODOS 0,90 ───────────────────
    // Score de PERFORMANCE varia entre execuções (a máquina do CI é
    // compartilhada); score de ACESSIBILIDADE e SEO não varia — são auditorias
    // de regra, dão o mesmo resultado sempre. Então:
    //   • performance → `error` em 0,85, uma faixa de variância ABAIXO do que
    //     foi medido. Gate que falha sozinho de vez em quando é pior que gate
    //     nenhum: ensina o time a ignorar vermelho. O `warn` em 0,95 é que
    //     puxa para cima.
    //   • accessibility/seo → `error` em 0,90 direto, porque são determinísticos.
    assert: {
      assertMatrix: [
        {
          // As duas páginas que existem para ser encontradas no Google.
          matchingUrlPattern: '.*/(index|planos)\\.html$',
          assertions: {
            'largest-contentful-paint': ['error', { maxNumericValue: 2500 }],
            'cumulative-layout-shift':  ['error', { maxNumericValue: 0.1 }],
            'total-blocking-time':      ['error', { maxNumericValue: 200 }],
            'speed-index':              ['warn',  { maxNumericValue: 3400 }],

            // Um nível por auditoria: o lhci não aceita `error` e `warn` na
            // mesma chave (e em JS a segunda simplesmente sobrescreve a
            // primeira, em silêncio). Entre travar a regressão e sinalizar
            // aspiração, o gate ganha.
            'categories:performance':    ['error', { minScore: 0.85 }],
            'categories:accessibility':  ['error', { minScore: 0.90 }],
            'categories:seo':            ['error', { minScore: 0.90 }],
            'categories:best-practices': ['error', { minScore: 0.90 }],
          },
        },
        {
          // Login: mesma exigência de velocidade, sem exigência de SEO.
          matchingUrlPattern: '.*/login\\.html$',
          assertions: {
            'largest-contentful-paint': ['error', { maxNumericValue: 2500 }],
            'cumulative-layout-shift':  ['error', { maxNumericValue: 0.1 }],
            'total-blocking-time':      ['error', { maxNumericValue: 200 }],
            'speed-index':              ['warn',  { maxNumericValue: 3400 }],

            'categories:performance':   ['error', { minScore: 0.85 }],
            'categories:accessibility': ['error', { minScore: 0.90 }],
            // SEO desligado de propósito — ver o bloco acima.
            'categories:seo':            'off',
            'categories:best-practices': ['warn', { minScore: 0.90 }],
          },
        },
      ],
    },
    upload: {
      target: 'filesystem',
      outputDir: '.lighthouseci',
    },
  },
};
