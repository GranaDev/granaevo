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
// ── ERROR vs WARN: a distinção é deliberada ────────────────────────────────
// `error` só para o que eu consegui justificar: LCP/CLS/TBT usam os limiares
// "good" dos Core Web Vitals definidos pelo Google — não são números que eu
// inventei.
// `warn` para os SCORES de categoria. Motivo honesto: não foi possível medir a
// linha de base localmente (o chrome-launcher quebra no Windows com EPERM ao
// limpar o temp — os audits rodam, mas o processo morre antes de gravar o
// resultado). Travar o CI com um limiar que eu nunca vi rodar seria irresponsável.
// Depois da primeira execução real no CI, com os números à vista, dá para
// promover os scores a `error` — em especial acessibilidade, quando o Passo 17
// (auditoria WCAG) estiver feito.
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
    assert: {
      assertions: {
        // ── Core Web Vitals: limiares "good" do Google ──────────────────────
        'largest-contentful-paint': ['error', { maxNumericValue: 2500 }],
        'cumulative-layout-shift':  ['error', { maxNumericValue: 0.1 }],
        'total-blocking-time':      ['error', { maxNumericValue: 200 }],
        'speed-index':              ['warn',  { maxNumericValue: 3400 }],

        // ── Scores: warn até a 1ª medição real no CI (ver cabeçalho) ────────
        'categories:performance':    ['warn', { minScore: 0.90 }],
        'categories:accessibility':  ['warn', { minScore: 0.90 }],
        'categories:seo':            ['warn', { minScore: 0.90 }],
        'categories:best-practices': ['warn', { minScore: 0.90 }],
      },
    },
    upload: {
      target: 'filesystem',
      outputDir: '.lighthouseci',
    },
  },
};
