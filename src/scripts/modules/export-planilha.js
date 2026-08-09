// export-planilha.js — a exportação LGPD em forma de PLANILHA  [A-3]
// ---------------------------------------------------------------------------
// POR QUE EXISTE, SE JÁ HÁ O JSON
//   São dois trabalhos diferentes, e o JSON só faz um deles:
//     • JSON  → levar os dados a outro serviço. É o que o art. 18, V da LGPD
//               pede ("formato estruturado e interoperável") e o que a
//               privacidade.html promete com essas palavras. Feito para
//               programa ler.
//     • .xlsx → a pessoa VER o que a gente guarda sobre ela. Ninguém lê a
//               própria vida financeira num JSON.
//   O JSON não sai; a planilha entra ao lado. A política continua verdadeira.
//
// POR QUE ESTE ARQUIVO É SEPARADO DO export-dados.js
//   Aqui não há `import` de rede nem de sessão: é uma função pura de
//   `pacote → abas`. Isso deixa o formato testável sem browser, sem banco e
//   sem segredo — e a montagem é justamente a parte que quebra em silêncio.
//
// UMA ABA POR TIPO DE DADO, com coluna "Perfil" — e não uma aba por perfil.
// Com 4 perfis e 6 listas seriam 24 abas; assim são 6, e o Excel filtra por
// perfil sozinho.
//
// ⚠️ AS COLUNAS SÃO DESCOBERTAS DOS PRÓPRIOS DADOS (união das chaves de todos
// os itens), nunca uma lista fixa. Foi uma lista fixa de nomes errados que
// quase fez os aparelhos sumirem do JSON sem ninguém notar: com descoberta,
// um campo novo no app aparece sozinho aqui em vez de ser descartado calado.
// ---------------------------------------------------------------------------

// ids de estilo definidos em modules/xlsx.js:
// 1 header · 2 seção · 3 R$ · 7 KPI-rótulo · 9 muted · 11 capa · 12 capa-sub
// 13 texto · 15 header-num
const S = { header: 1, secao: 2, dinheiro: 3, rotulo: 7, mudo: 9, capa: 11, sub: 12, texto: 13, headerNum: 15 };

const ROTULOS = {
    categoria: 'Movimento', tipo: 'Categoria', descricao: 'Descrição', valor: 'Valor',
    data: 'Data', hora: 'Hora', metaId: 'Meta (id)', nome: 'Nome', id: 'ID',
    ua_label: 'Aparelho', first_seen: 'Primeiro acesso', last_seen: 'Último acesso',
    terms_version: 'Versão dos termos', accepted_at: 'Aceito em', ip_address: 'IP',
    plan_name: 'Plano', status: 'Situação', current_period_end: 'Válido até',
    created_at: 'Criado em', operation: 'Operação', title: 'Título', body: 'Mensagem',
    photo_url: 'Foto', limite: 'Limite', vencimento: 'Vencimento', fechamento: 'Fechamento',
};

// ⚠️ Os nomes são invertidos em relação à intuição: `categoria` guarda o
// MOVIMENTO (entrada/saída/…) e `tipo` guarda a CATEGORIA (Mercado, Salário…).
// Traduzir os rótulos aqui é o que evita entregar uma planilha que mente.
const MOVIMENTO = {
    entrada: 'Entrada', saida: 'Saída', saida_credito: 'Crédito',
    reserva: 'Reserva', retirada_reserva: 'Retirada',
};

// ⚠️ Era ancorado em `saldo` exato, então `saldoAnterior` e `saldoPosterior` —
// as duas colunas do histórico de retirada — saíam como número cru ao lado de
// colunas formatadas. `saved` (o quanto a reserva tem) e `valorParcela` idem.
// Numa planilha de finanças, valor sem formato é o tipo de detalhe que faz a
// pessoa desconfiar do arquivo inteiro.
const EH_DINHEIRO = /^(valor|valorParcela|preco|preço|limite|saldo\w*|saved|usado|objetivo|guardado|mensalidade|total)$/i;

/**
 * Rótulo humano de uma coluna. Sem tradução conhecida, quebra o camelCase e o
 * snake_case em palavras — é exatamente no campo NÃO mapeado que o rótulo mais
 * importa, porque é o que o app acabou de ganhar e ninguém traduziu ainda.
 * `campoInventado` → "Campo inventado", `first_seen` → "First seen".
 */
function rotulo(k) {
    if (ROTULOS[k]) return ROTULOS[k];
    const s = String(k)
        .replace(/_/g, ' ')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .toLowerCase()
        .trim();
    return s.charAt(0).toUpperCase() + s.slice(1);
}

const brl = (n) => Number(n).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/**
 * Objeto/array vira texto que uma PESSOA lê.
 *
 * ⚠️ Era `JSON.stringify` direto, e o dono abriu a planilha em 2026-08-09 e
 * encontrou, dentro de uma célula da aba Metas:
 *     {"2026-08":949}
 *     [{"data":"07/08/2026","valor":50,"motivo":"Outro","saldoAnterior":1500, …}]
 * Isso é despejo de banco, não portabilidade. A LGPD pede dado compreensível ao
 * titular; e mesmo sem a lei, uma planilha que ninguém lê não serve pra nada.
 *
 * Três formas, que cobrem tudo que o app guarda aninhado:
 *   mapa mês→valor  →  "08/2026: R$ 949,00 · 09/2026: R$ 120,00"
 *   lista de fatos  →  "3 registro(s)" (os fatos viram ABA própria — ver o
 *                      histórico de retiradas em montarPlanilha)
 *   lista simples   →  "a, b, c"
 */
function legivel(valor) {
    if (Array.isArray(valor)) {
        if (valor.length === 0) return '';
        const simples = valor.every((v) => v == null || typeof v !== 'object');
        return simples ? valor.join(', ') : `${valor.length} registro(s)`;
    }
    const pares = Object.entries(valor);
    if (pares.length === 0) return '';
    return pares
        .map(([k, v]) => {
            // "2026-08" é ano-mês; vira "08/2026", que é como se lê no Brasil.
            const m = /^(\d{4})-(\d{2})$/.exec(k);
            const rot = m ? `${m[2]}/${m[1]}` : rotulo(k);
            return `${rot}: ${typeof v === 'number' ? brl(v) : String(v)}`;
        })
        .join(' · ');
}

/** Um valor vira célula legível. Objeto/array vira texto de gente, nunca JSON. */
export function celula(chave, valor) {
    if (valor == null || valor === '') return '';
    if (chave === 'categoria' && MOVIMENTO[valor]) return { v: MOVIMENTO[valor], s: S.texto };
    if (typeof valor === 'number')  return EH_DINHEIRO.test(chave) ? { v: valor, s: S.dinheiro } : valor;
    if (typeof valor === 'boolean') return { v: valor ? 'Sim' : 'Não', s: S.texto };
    if (typeof valor === 'object')  return { v: legivel(valor), s: S.mudo };
    return { v: String(valor), s: S.texto };
}

/** Tabela genérica: as colunas saem da união das chaves de todas as linhas. */
function tabela(itens) {
    const colunas = [];
    for (const it of itens) {
        if (!it || typeof it !== 'object') continue;
        for (const k of Object.keys(it)) if (!colunas.includes(k)) colunas.push(k);
    }
    if (colunas.length === 0) return null;
    return { colunas, linhas: itens.map(it => colunas.map(c => celula(c, it?.[c]))) };
}

/** Junta a mesma lista de todos os perfis, prefixando a coluna "Perfil". */
function porPerfil(perfis, chave) {
    const juntos = [];
    for (const p of perfis) {
        const lista = Array.isArray(p?.[chave]) ? p[chave] : [];
        for (const item of lista) juntos.push({ Perfil: p?.nome ?? '—', ...item });
    }
    return juntos;
}

function aba(nome, itens) {
    const t = tabela(Array.isArray(itens) ? itens : []);
    // Aba vazia é pior que aba ausente: parece dado perdido. O Resumo lista
    // quais ficaram de fora, então a ausência é explicada e não misteriosa.
    if (!t) return null;
    return {
        nome,
        linhas: [t.colunas.map(c => ({ v: rotulo(c), s: S.header })), ...t.linhas],
        larguras: t.colunas.map(c => (c === 'descricao' || c === 'body' ? 38
            : (c === 'Perfil' || c === 'nome') ? 20 : 16)),
    };
}

/**
 * `pacote` é o MESMO objeto que vai no JSON — a planilha é uma leitura dele,
 * nunca uma coleta separada. Se divergissem, um dos dois estaria mentindo
 * sobre o que a empresa guarda.
 * @returns {Array<{nome:string, linhas:Array<Array>, larguras?:number[]}>}
 */
export function montarPlanilha(pacote) {
    const perfis = Array.isArray(pacote?.dados_financeiros) ? pacote.dados_financeiros : [];
    const meta   = pacote?.metadados_da_conta ?? {};

    // O registro de atividade vem RESUMIDO ({total, ultima}) e não como 500
    // linhas de "UPDATE / data" — ver a nota em export-dados.js. Vira uma linha
    // no Resumo: é transparência legível, não diário do sistema.
    const at = meta.registro_de_atividade;
    const atividade = (at && typeof at === 'object' && !Array.isArray(at) && at.total != null)
        ? `${at.total} gravação(ões)` + (at.ultima ? ` · última em ${new Date(at.ultima).toLocaleDateString('pt-BR')}` : '')
        : null;

    // Orçamentos são objeto { categoria: valor }, não lista — viram linhas.
    const orcamentos = [];
    for (const p of perfis) {
        const o = p?.orcamentos;
        if (o && typeof o === 'object' && !Array.isArray(o)) {
            for (const [cat, val] of Object.entries(o)) {
                orcamentos.push({ Perfil: p?.nome ?? '—', categoria: cat, valor: Number(val) || 0 });
            }
        }
    }

    // Retiradas das reservas: são FATOS com data, valor, motivo e saldo antes e
    // depois — merecem linhas, como as transações. Dentro da célula da meta
    // viravam um array JSON ilegível, e é justamente o registro que responde
    // "por que minha reserva diminuiu?".
    const retiradas = [];
    for (const p of perfis) {
        for (const m of (Array.isArray(p?.metas) ? p.metas : [])) {
            for (const h of (Array.isArray(m?.historicoRetiradas) ? m.historicoRetiradas : [])) {
                retiradas.push({ Perfil: p?.nome ?? '—', reserva: m?.nome ?? m?.descricao ?? '—', ...h });
            }
        }
    }

    const candidatas = [
        ['Transações',       porPerfil(perfis, 'transacoes')],
        ['Metas',            porPerfil(perfis, 'metas')],
        ['Retiradas',        retiradas],
        ['Contas fixas',     porPerfil(perfis, 'contasFixas')],
        ['Cartões',          porPerfil(perfis, 'cartoesCredito')],
        ['Assinaturas',      porPerfil(perfis, 'assinaturas')],
        ['Orçamentos',       orcamentos],
        ['Aparelhos',        meta.aparelhos_reconhecidos ?? []],
        ['Aceite de termos', meta.aceite_de_termos ?? []],
        ['Avisos',           meta.avisos_recebidos ?? []],
    ];

    const abas = [];
    const feitas = [];
    const vazias = [];
    for (const [nome, itens] of candidatas) {
        const a = aba(nome, itens);
        if (a) { abas.push(a); feitas.push([nome, (itens ?? []).length]); }
        else vazias.push(nome);
    }

    // ── Aba 1: Resumo, para o arquivo se explicar sozinho ────────────────────
    const geradoEm = new Date().toLocaleString('pt-BR',
        { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

    const resumo = [
        [],
        [{ v: 'GranaEvo', s: S.capa }, '', { v: 'Meus dados', s: S.sub }],
        [{ v: `Gerado em ${geradoEm}`, s: S.mudo }],
        [],
        [{ v: 'CONTA', s: S.secao }],
        [{ v: 'E-mail', s: S.rotulo }, { v: String(pacote?.conta?.email ?? '—'), s: S.texto }],
        [{ v: 'Tipo',   s: S.rotulo }, { v: pacote?.conta?.tipo === 'convidado' ? 'Convidado' : 'Titular', s: S.texto }],
        [{ v: 'Perfis', s: S.rotulo }, { v: perfis.map(p => p?.nome || p?.name).filter(Boolean).join(' · ') || '—', s: S.texto }],
        ...(atividade ? [[{ v: 'Gravações', s: S.rotulo }, { v: atividade, s: S.texto }]] : []),
        [],
        [{ v: 'O QUE TEM NESTE ARQUIVO', s: S.secao }],
        [{ v: 'ABA', s: S.header }, { v: 'REGISTROS', s: S.headerNum }],
        ...feitas.map(([nome, n]) => [{ v: nome, s: S.texto }, n]),
    ];

    if (vazias.length) {
        resumo.push([], [{ v: 'Sem registros (aba não criada)', s: S.rotulo }],
            [{ v: vazias.join(' · '), s: S.mudo }]);
    }

    // O mesmo compromisso que está no JSON, repetido aqui: quem abrir só a
    // planilha tem de saber que ela não carrega credencial nenhuma.
    resumo.push([],
        [{ v: 'Nenhuma senha, código de recuperação, chave de criptografia ou token de '
            + 'sessão entra neste arquivo: ele carrega seus DADOS, não seu ACESSO.', s: S.mudo }],
        [{ v: 'Dúvidas sobre seus dados: privacidade@granaevo.com', s: S.mudo }]);

    abas.unshift({ nome: 'Resumo', linhas: resumo, larguras: [26, 40, 18, 18], congelar: false });
    return abas;
}
