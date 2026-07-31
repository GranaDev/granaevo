// export-dados.js — portabilidade de dados (LGPD art. 18, V)  [A-3]
// ---------------------------------------------------------------------------
// POR QUE ISTO EXISTE
//   `privacidade.html` §Portabilidade promete, com estas palavras: "o GranaEvo
//   oferece exportação dos seus dados em formato JSON dentro da própria
//   plataforma". Até 2026-07-27 isso não existia — o app só exportava PDF, CSV
//   e Excel. Promessa documentada e não cumprida é o achado A-3 da auditoria.
//
// DOIS FORMATOS, DOIS TRABALHOS (2026-07-30)
//   JSON  → levar os dados a outro serviço. É o "formato estruturado e
//           interoperável" que a lei pede e que a política promete. Continua
//           existindo exatamente por isso.
//   .xlsx → a pessoa VER o que a gente guarda. Um usuário abriu o JSON e a
//           pergunta foi direta: "o que é isso?". Estava certo — o JSON
//           responde a outra pergunta. A planilha é a resposta a essa.
//   Os dois saem do MESMO pacote (`_montar`): a planilha é uma leitura do que
//   o JSON contém, nunca uma coleta paralela. Se divergissem, um dos dois
//   estaria mentindo sobre o que a empresa guarda.
//
// DE ONDE VÊM OS DADOS
//   O blob vem do servidor, NÃO da memória. A memória do dashboard só tem o
//   perfil ATIVO; portabilidade exige todos os perfis do usuário. O
//   `GET /api/user-data` devolve o blob inteiro já decifrado (AES-256-GCM com
//   chave derivada por usuário, decifrado na Edge Function).
//   Os metadados da conta vêm por PostgREST, cada um limitado pelo RLS ao
//   próprio usuário — este módulo não tem, nem precisa de, privilégio nenhum.
//
// O QUE NUNCA ENTRA NO ARQUIVO
//   Nada que seja credencial ou permita reautenticar: hash de senha, código de
//   recuperação, chave de criptografia, token de sessão, endpoint de push. O
//   objetivo é levar os DADOS embora, não clonar o acesso.
//
// CONVIDADO (plano casal/família)
//   O blob de um convidado É o do dono do plano — o servidor resolve isso por
//   `account_members`. Ele já enxerga esses dados no app, então exportar não
//   concede nada novo; mas o arquivo diz isso em `conta.observacao`, para que
//   ninguém confunda a origem depois.
// ---------------------------------------------------------------------------

import { supabase } from '../services/supabase-client.js?v=2';

const VERSAO_FORMATO = 1;

const el = (tag, cls, txt) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
};

const CSS = `
#geExp { position: fixed; inset: 0; z-index: 10000; display: flex; align-items: center; justify-content: center; padding: 16px; }
#geExp .exp-ov { position: absolute; inset: 0; background: rgba(3,7,18,0.84); backdrop-filter: blur(5px); }
#geExp .exp-card { position: relative; background: #13141f; border: 1px solid rgba(16,185,129,0.22); border-radius: 20px; padding: 26px 24px; max-width: 420px; width: 100%; color: #d1d5db; box-shadow: 0 24px 48px rgba(0,0,0,0.55); }
#geExp h3 { color: #fff; font-size: 1.1rem; margin: 0 0 8px; }
#geExp p { color: #9ca3af; font-size: 0.85rem; line-height: 1.55; margin: 0 0 14px; }
#geExp ul { color: #9ca3af; font-size: 0.82rem; line-height: 1.7; margin: 0 0 16px; padding-left: 18px; }
#geExp input { width: 100%; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.12); border-radius: 12px; padding: 12px; color: #fff; font-size: 0.92rem; }
#geExp input:focus { outline: none; border-color: rgba(16,185,129,0.55); }
#geExp .exp-err { color: #fca5a5; font-size: 0.8rem; margin: 10px 0 0; min-height: 1em; }
#geExp .exp-fmt { display: flex; flex-direction: column; gap: 8px; margin: 0 0 16px; }
#geExp .exp-op { display: flex; gap: 10px; align-items: flex-start; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.10); border-radius: 12px; padding: 11px 12px; cursor: pointer; }
#geExp .exp-op:has(input:checked) { border-color: rgba(16,185,129,0.55); background: rgba(16,185,129,0.07); }
#geExp .exp-op input { width: auto; margin: 2px 0 0; accent-color: #10b981; flex: 0 0 auto; }
#geExp .exp-op b { color: #e5e7eb; font-size: 0.86rem; font-weight: 600; display: block; }
#geExp .exp-op span { color: #9ca3af; font-size: 0.78rem; line-height: 1.45; display: block; margin-top: 2px; }
#geExp .exp-go { width: 100%; margin-top: 16px; background: linear-gradient(135deg,#10b981,#059669); color: #fff; border: none; border-radius: 12px; padding: 13px; font-weight: 700; font-size: 0.92rem; cursor: pointer; }
#geExp .exp-go[disabled] { opacity: 0.55; cursor: default; }
#geExp .exp-alt { background: none; border: none; color: #6b7280; font-size: 0.8rem; text-decoration: underline; cursor: pointer; margin-top: 12px; padding: 4px; width: 100%; }
`;

let _cssPronto = false;
function _css() {
    if (_cssPronto) return;
    try {
        const s = new CSSStyleSheet(); s.replaceSync(CSS);
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, s];
    } catch {
        const s = document.createElement('style'); s.textContent = CSS; document.head.appendChild(s);
    }
    _cssPronto = true;
}

async function _accessToken() {
    const { data: { session } } = await supabase.auth.getSession();
    return session?.access_token ?? null;
}

/** Confirma a senha antes de empacotar tudo (step-up do Passo 25). */
async function _confirmarSenha(password) {
    const res = await fetch('/api/auth-session', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${await _accessToken()}`,
        },
        credentials: 'same-origin',
        body: JSON.stringify({ action: 'verify-password', password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data?.error ?? 'falhou'), { status: res.status });
    return true;
}

/** Blob completo (todos os perfis), já decifrado pela Edge Function. */
async function _buscarBlob() {
    const res = await fetch('/api/user-data', {
        headers: { 'Authorization': `Bearer ${await _accessToken()}` },
        credentials: 'same-origin',
    });
    if (!res.ok) throw new Error('blob');
    return res.json();
}

/**
 * Metadados da conta. Cada consulta é limitada pelo RLS ao próprio usuário —
 * se uma falhar (tabela sem grant, rede), o campo vira null em vez de derrubar
 * a exportação inteira: um dado a menos é melhor que nenhum arquivo.
 */
async function _buscarMetadados() {
    const q = async (fn) => { try { const { data, error } = await fn(); return error ? null : data; } catch { return null; } };
    const [perfis, termos, assinatura, aparelhos, avisos, atividade] = await Promise.all([
        q(() => supabase.from('profiles').select('id, name, photo_url, created_at')),
        q(() => supabase.from('terms_acceptance').select('terms_version, accepted_at, ip_address')),
        q(() => supabase.from('stripe_subscriptions').select('plan_name, status, current_period_end, created_at')),
        // ua_label/first_seen/last_seen — nomes conferidos contra o schema. Um
        // nome errado aqui não quebra nada: o q() engole o erro e o campo vira
        // null, ou seja, o dado sumiria do arquivo SEM ninguém perceber.
        // `device_hash` fica de fora de propósito: é identificador de segurança,
        // não informação que ajude o titular a levar a vida financeira embora.
        q(() => supabase.from('user_devices').select('ua_label, first_seen, last_seen')),
        q(() => supabase.from('radar_notifications').select('tipo, title, body, created_at, status').order('created_at', { ascending: false }).limit(200)),
        q(() => supabase.from('financial_audit_log').select('operation, created_at').order('created_at', { ascending: false }).limit(500)),
    ]);
    return { perfis, termos, assinatura, aparelhos, avisos, atividade };
}

function _baixarArquivo(conteudo, nome, mime) {
    const url = URL.createObjectURL(new Blob([conteudo], { type: mime }));
    const a = document.createElement('a');
    a.href = url;
    a.download = nome;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
}

const _hoje = () => new Date().toISOString().slice(0, 10);

function _baixar(obj) {
    _baixarArquivo(JSON.stringify(obj, null, 2),
        `granaevo-meus-dados-${_hoje()}.json`, 'application/json;charset=utf-8');
}

// A montagem da planilha mora em export-planilha.js — função pura, testável
// sem browser. Aqui fica só o carregamento sob demanda e o download: quem
// escolhe JSON não baixa os 27 KB do gerador OOXML à toa.
async function _baixarPlanilha(pacote) {
    const [{ gerarXlsx }, { montarPlanilha }] = await Promise.all([
        import('./xlsx.js'),
        import('./export-planilha.js'),
    ]);
    _baixarArquivo(gerarXlsx(montarPlanilha(pacote)),
        `granaevo-meus-dados-${_hoje()}.xlsx`,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}

/** Monta o pacote final. Auto-descritivo: quem receber não precisa de nós. */
function _montar({ blob, meta, email, userId, isGuest }) {
    return {
        _sobre: {
            formato: 'GranaEvo — exportação de dados pessoais (LGPD art. 18, V)',
            versao_formato: VERSAO_FORMATO,
            gerado_em: new Date().toISOString(),
            origem: 'https://www.granaevo.com',
            observacao:
                'Arquivo estruturado e interoperável, gerado a pedido do titular. '
                + 'Valores monetários em reais (BRL). Datas em ISO 8601 salvo onde indicado. '
                + 'Nenhuma credencial (senha, código de recuperação, chave de criptografia ou '
                + 'token de sessão) é incluída — este arquivo carrega seus DADOS, não seu ACESSO.',
        },
        conta: {
            email,
            user_id: userId,
            tipo: isGuest ? 'convidado' : 'titular',
            ...(isGuest ? {
                observacao:
                    'Esta conta é convidada de um plano casal/família. Os dados financeiros '
                    + 'abaixo pertencem à conta do titular do plano, que é a mesma base que '
                    + 'você já acessa no aplicativo.',
            } : {}),
        },
        // O coração da exportação: perfis com transações, metas, cartões,
        // contas fixas, assinaturas, orçamentos, conquistas e configurações.
        dados_financeiros: blob?.profiles ?? blob ?? null,
        metadados_da_conta: {
            perfis: meta.perfis,
            aceite_de_termos: meta.termos,
            assinatura: meta.assinatura,
            aparelhos_reconhecidos: meta.aparelhos,
            avisos_recebidos: meta.avisos,
            registro_de_atividade: meta.atividade,
        },
        _direitos: {
            texto:
                'Você pode solicitar correção, eliminação ou informações sobre o tratamento '
                + 'dos seus dados a qualquer momento.',
            contato: 'privacidade@granaevo.com',
            politica: 'https://www.granaevo.com/privacidade',
        },
    };
}

/** Abre o fluxo de exportação. Chamado pelo botão em Configurações. */
export async function abrirExportacao(ctx) {
    _css();
    document.getElementById('geExp')?.remove();

    const root = el('div'); root.id = 'geExp';
    const ov = el('div', 'exp-ov');
    const card = el('div', 'exp-card');
    root.append(ov, card);

    const fechar = () => root.remove();
    ov.addEventListener('click', fechar);

    card.appendChild(el('h3', null, 'Baixar meus dados'));
    card.appendChild(el('p', null,
        'Você vai receber um arquivo JSON com tudo que guardamos sobre você. '
        + 'Pode abrir em qualquer programa ou levar para outro serviço.'));

    const lista = el('ul');
    for (const item of [
        'Transações, cartões, contas fixas, assinaturas e reservas',
        'Todos os seus perfis, não só o que está aberto',
        'Orçamentos, conquistas e configurações',
        'Aceite de termos, plano, aparelhos e histórico de atividade',
    ]) lista.appendChild(el('li', null, item));
    card.appendChild(lista);

    // Escolha por PROPÓSITO, não por extensão. "JSON" não diz nada para quem não
    // é da área; "levar para outro aplicativo" diz. A planilha vem marcada por
    // padrão porque é o que quase todo mundo quer — o JSON continua a um clique,
    // e é ele que cumpre o art. 18, V da LGPD.
    const fmt = el('div', 'exp-fmt');
    const opcoes = [
        ['xlsx', 'Planilha (Excel)', 'Para você abrir e ler. Abre no Excel, no Google Planilhas e no celular. Uma aba por tipo de dado, com todos os perfis.'],
        ['json', 'Arquivo completo (JSON)', 'Para levar seus dados a outro aplicativo. É o formato exigido pela LGPD para portabilidade — feito para programas lerem.'],
    ];
    for (const [valor, titulo, desc] of opcoes) {
        const lab = document.createElement('label');
        lab.className = 'exp-op';
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'geExpFmt';
        radio.value = valor;
        radio.checked = valor === 'xlsx';
        const txt = el('div');
        txt.appendChild(el('b', null, titulo));
        txt.appendChild(el('span', null, desc));
        lab.append(radio, txt);
        fmt.appendChild(lab);
    }
    card.appendChild(fmt);

    card.appendChild(el('p', null, 'Confirme sua senha para continuar:'));

    const input = document.createElement('input');
    input.type = 'password';
    input.autocomplete = 'current-password';
    input.placeholder = 'Sua senha';
    input.setAttribute('aria-label', 'Senha atual');
    card.appendChild(input);

    const erro = el('p', 'exp-err', '');
    erro.setAttribute('role', 'alert');
    card.appendChild(erro);

    const btn = el('button', 'exp-go', 'Gerar e baixar');
    btn.type = 'button';
    card.appendChild(btn);

    const cancelar = el('button', 'exp-alt', 'Cancelar');
    cancelar.type = 'button';
    cancelar.addEventListener('click', fechar);
    card.appendChild(cancelar);

    document.body.appendChild(root);
    setTimeout(() => input.focus(), 60);

    let ocupado = false;
    const gerar = async () => {
        if (ocupado) return;
        if (!input.value) { erro.textContent = 'Digite sua senha.'; return; }

        ocupado = true;
        btn.disabled = true;
        erro.textContent = '';

        try {
            btn.textContent = 'Confirmando…';
            await _confirmarSenha(input.value);
            input.value = '';

            btn.textContent = 'Reunindo seus dados…';
            const [blob, meta] = await Promise.all([_buscarBlob(), _buscarMetadados()]);

            const { data: { user } } = await supabase.auth.getUser();
            const pacote = _montar({
                blob,
                meta,
                email:   user?.email ?? null,
                userId:  user?.id ?? null,
                isGuest: Boolean(ctx?.usuarioLogado?.isGuest),
            });

            // Os dois saem do MESMO pacote: a planilha é uma leitura do que o
            // JSON contém, nunca uma coleta separada. Se divergissem, um dos
            // dois estaria mentindo sobre o que a empresa guarda.
            const formato = card.querySelector('input[name="geExpFmt"]:checked')?.value ?? 'xlsx';
            if (formato === 'xlsx') {
                btn.textContent = 'Montando a planilha…';
                await _baixarPlanilha(pacote);
            } else {
                _baixar(pacote);
            }

            fechar();
            ctx?.mostrarNotificacao?.('Arquivo gerado! Confira seus downloads.', 'success');
        } catch (e) {
            const msg = String(e?.message ?? '');
            erro.textContent =
                msg === 'senha_incorreta' ? 'Senha incorreta.' :
                e?.status === 429         ? 'Muitas tentativas. Aguarde alguns minutos.' :
                msg === 'blob'            ? 'Não consegui carregar seus dados agora. Tente de novo.' :
                                            'Não foi possível gerar o arquivo agora.';
            input.focus();
        } finally {
            ocupado = false;
            btn.disabled = false;
            btn.textContent = 'Gerar e baixar';
        }
    };

    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') gerar(); });
    btn.addEventListener('click', gerar);
}
