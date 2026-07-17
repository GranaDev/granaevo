// parser-local.js — parser determinístico (regex + palavras-chave)
// ---------------------------------------------------------------------------
// PRIMEIRA camada do funil. Resolve a maioria das mensagens SEM gastar token de
// IA. Devolve um objeto com a MESMA forma do parse da IA (+ `source:'local'` e
// `confianca`). Se a confiança for baixa, o engine cai para a IA como fallback.
// Não grava nada; não vê nada além do texto.
// ---------------------------------------------------------------------------

import { parseValorBR, parseParcelas, parseExtenso, parseDataRelativa, parseAritmetica, parseMesNomeado, parseDataFutura } from './money.js';
import { extractDescricao, contarPalavrasConteudo } from './describe.js';

// Tipos permitidos no app (espelham db-transacoes.js: o conjunto reconhecido pelo
// auto-categorizador em _AUTO_CAT, mais rico que o dropdown de edição). Inclui
// Saúde/Educação/Viagem/Pet/Investimento — o app já cria essas categorias.
export const TIPOS_SAIDA = ['Mercado', 'Farmácia', 'Saúde', 'Eletrônico', 'Roupas', 'Assinaturas', 'Beleza',
    'Presente', 'Conta fixa', 'Cartão', 'Academia', 'Lazer', 'Transporte', 'Viagem', 'Pet', 'Educação',
    'Shopee', 'Mercado Livre', 'Ifood', 'Amazon', 'Outros'];
export const TIPOS_ENTRADA = ['Salário', 'Renda Extra', 'Investimento', 'Outros Recebimentos'];

// Tipos aceitos como CHAVE de orçamento — espelha _TIPOS_SAIDA_VALIDOS do
// dashboard.js (whitelist do _sanitizarOrcamentos). Chave fora desta lista
// seria descartada silenciosamente no próximo save do dashboard.
export const ORCAMENTO_TIPOS = ['Mercado', 'Farmácia', 'Eletrônico', 'Roupas', 'Assinaturas', 'Beleza',
    'Presente', 'Conta fixa', 'Cartão', 'Academia', 'Lazer', 'Transporte', 'Shopee', 'Mercado Livre',
    'Ifood', 'Amazon', 'Outros'];

// Normaliza: minúsculas, sem acento — para casar palavras-chave de forma robusta.
function norm(s) {
    return String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// ── Correção de typos frequentes (B13) ──────────────────────────────────────
// Aplicado sobre o texto já normalizado (minúsculo, sem acento). Só troca
// palavras inteiras (\b) e é curado para erros comuns de digitação rápida —
// nada de correção agressiva que mude o sentido.
const TYPOS = [
    [/\bmec+ado\b/g, 'mercado'], [/\bmercd?o\b/g, 'mercado'], [/\bmercao\b/g, 'mercado'],
    [/\bfaramacia\b/g, 'farmacia'], [/\bfarmacea\b/g, 'farmacia'], [/\bfaramcia\b/g, 'farmacia'],
    [/\btransorte\b/g, 'transporte'], [/\btranporte\b/g, 'transporte'],
    [/\bgasolna\b/g, 'gasolina'], [/\bgazolina\b/g, 'gasolina'], [/\bgazolna\b/g, 'gasolina'],
    [/\bsalrio\b/g, 'salario'], [/\bsalaraio\b/g, 'salario'], [/\bsalari\b/g, 'salario'],
    [/\baluge?el\b/g, 'aluguel'], [/\balugel\b/g, 'aluguel'],
    [/\bacademya\b/g, 'academia'], [/\bacademi\b/g, 'academia'],
    [/\brestaurente\b/g, 'restaurante'], [/\brestaurant\b/g, 'restaurante'],
    [/\bgastie\b/g, 'gastei'], [/\bpaguey\b/g, 'paguei'], [/\bcomprey\b/g, 'comprei'],
    [/\breceby\b/g, 'recebi'], [/\bganhey\b/g, 'ganhei'], [/\bguardey\b/g, 'guardei'],
];
function corrigirTypos(t) {
    let s = t;
    for (const [re, to] of TYPOS) s = s.replace(re, to);
    return s;
}

// ── Detecção de tentativa de manipulação / prompt-injection (E43) ───────────
// Roteia direto para uma recusa amigável SEM chamar a IA. Blindagem + economia
// de token. Casa pedidos de "ignore instruções", troca de papel, ou pesca por
// dados de sistema/senha. A IA já ignoraria isso; aqui fechamos antes.
const RE_INJECT = /\b(ignore? (as |todas as |suas )?(instru|regras|ordens)|esque[cç]a (as |suas )?(instru|regras)|aja como|finja (que|ser)|voce (agora )?e (um|uma|o|a)\b|assuma o papel|system prompt|prompt do sistema|jailbreak|dan mode|modo desenvolvedor|developer mode|revele? (suas |as )?(instru|regras|senha|chave|token|api)|(repita|mostra|mostre|imprima|print|exiba|cole|liste) (o |as |suas |seu )?(texto acima|instru|regras|system|prompt|mensagem de sistema)|quais (sao|são) (suas |as )?(instru|regras)|your (instructions|system prompt|rules)|qual (e |é )?(sua|a) (senha|chave|api|token)|service.?role|\bsudo\b|\bbypass\b)/;

// ── Vocabulário de reserva ──────────────────────────────────────────────────
// O brasileiro quase nunca diz "reserva": diz "caixinha" (é como o Nubank chama),
// "cofrinho" (PicPay), "porquinho", "poupança". Exigir a palavra literal "reserv"
// depois do verbo — como era antes — fazia "retirei 109,05 da caixinha" não casar
// verbo NENHUM: caía em `valor_ambiguo` e o assistente perguntava "foi gasto ou
// entrada?" de um saque de reserva. Bug real relatado em prod.
// "caixa" (eletrônico) NÃO entra: `\bcaixinha` não casa "caixa".
export const RESERVA_ALVO = /\b(reserv|caixinha|cofrinho|porquinho|poupanc|guardadinho|vaquinha|meta\b|objetivo)/;
const RE_VERBO_TIRAR = /\b(tirei|resgatei|retirei|saquei|resgate|retirada|puxei|peguei de volta)\b/;

// ── Verbos → categoria (ordem importa: específicos antes de genéricos) ───────
const VERBOS = [
    { cat: 'retirada_reserva', re: /\b(tirei|resgatei|retirei|saquei|resgate|retirada|puxei|peguei de volta)\b.*\b(reserv|caixinha|cofrinho|porquinho|poupanc|guardadinho|vaquinha)/ },
    { cat: 'retirada_reserva', re: /\b(d[ao]|na|no) (reserva|caixinha|cofrinho|porquinho|poupanca|vaquinha)\b.*\b(tirei|resgatei|retirei|saquei|puxei)/ },
    { cat: 'reserva',          re: /\b(guardei|reservei|poupei|juntei|separei|aportei|guardar|poupar|reservar|economizei|botei de lado|coloquei de lado)\b/ },
    { cat: 'assinatura',       re: /\b(assinatura|assinei|mensalidade|plano mensal|recorrente|todo mes pago)\b/ },
    { cat: 'saida_credito',    re: /\b(no credito|no cartao|parcelad|parcelei|em \d+x|\d+x de|no cartao de credito)\b/ },
    { cat: 'entrada',          re: /\b(recebi|ganhei|caiu|entrou|pingou|embolsei|faturei|recebimento|salario|me pagaram|pagaram|ganho|recebe?r|pix de|deposit|caiu na conta|entrou na conta)\b/ },
    // `gastos?` e não `gasto`: a fronteira \b no fim de "gasto" cai no MEIO de
    // "gastos" e não casa o plural — era por isso que a frase "75,69 gastos na
    // shopee" só virava saída por acidente (via a keyword "shopee"), e que
    // "75,69 gastos com fita de led" era perguntada como "gasto ou entrada?".
    { cat: 'saida',            re: /\b(gastei|paguei|comprei|gastos?|saiu|torrei|mandei|meti|queimei|desembolsei|estourei|fritei|gastar|comprar|pagar|debit|paguei por|deu de)\b/ },
];

// ── Palavras-chave → {categoria, tipo} ──────────────────────────────────────
// Curado para o dia-a-dia BR. Mapeia sempre para um tipo PERMITIDO.
// COBERTURA IMPORTA MAIS DO QUE PARECE: desde que a `completude` passou a mandar
// gasto-com-loja-desconhecida pra IA, cada termo que falta aqui vira uma chamada
// de rede (~1s + token + teto de 120/dia). Uma medição com 24 frases corriqueiras
// do dia-a-dia BR batia 50% de ida à IA — por buracos bobos: "café" faltava mas
// "cafeteria" estava. Cada palavra adicionada aqui é grátis, instantânea e pra
// sempre. A IA deve ser exceção, não metade do tráfego.
const KEYWORDS = [
    // Saída — comida/delivery ANTES de mercado (padaria/lanche = Ifood no app)
    [/\b(ifood|delivery|rappi|uber eats|zedelivery|ze delivery|aiqfome|james delivery)\b/, 'saida', 'Ifood'],
    [/\b(restaurante|lanchonete|lanche|padaria|padoca|pizza|pizzaria|hamburguer|hamburguier|burger|sushi|churrasco|churrascaria|almoco|janta|jantar|marmita|sorveteria|confeitaria|cafeteria|mc ?donalds|burger king|subway|habib|outback|giraffas|spoleto)\b/, 'saida', 'Ifood'],
    // Comida do dia-a-dia — o brasileiro fala assim, e faltava tudo isto
    [/\b(cafe|cafezinho|pao de queijo|salgado|salgados|coxinha|acai|sorvete|pastel|tapioca|espetinho|bar|boteco|cerveja|chopp|happy hour|doceria|bolo|pizzaria)\b/, 'saida', 'Ifood'],
    // Marketplaces
    [/\b(mercado livre|meli)\b/, 'saida', 'Mercado Livre'],
    [/\b(shopee)\b/, 'saida', 'Shopee'],
    [/\b(amazon)\b/, 'saida', 'Amazon'],
    // Supermercado (termos claros de super — sem "extra"/"dia" soltos)
    [/\b(supermercado|mercado|atacad|atacadao|carrefour|hortifruti|sacolao|feira|assai|makro|pao de acucar|prezunic)\b/, 'saida', 'Mercado'],
    [/\b(mercadinho|mercearia|acougue|quitanda|emporio|verdurao|peixaria|granja|minimercado|padoca)\b/, 'saida', 'Mercado'],
    [/\b(farmacia|remedio|drogaria|drogasil|pacheco|raia|panvel|ultrafarma)\b/, 'saida', 'Farmácia'],
    [/\b(medico|dentista|clinica|hospital|consulta|exame|plano de saude|unimed|amil|hapvida|fisioterapia|psicologo|psicologa|terapia|nutricionista)\b/, 'saida', 'Saúde'],
    [/\b(uber|99|onibus|metro|gasolina|combustivel|transporte|passagem|corrida|bilhete|posto|etanol|estacionamento|pedagio|blablacar|indriver|cabify)\b/, 'saida', 'Transporte'],
    // Carro: manutenção e afins — "oficina"/"mecânico" são gasto clássico
    [/\b(oficina|mecanico|borracharia|funilaria|lava.?jato|lavagem do carro|revisao|alinhamento|balanceamento|troca de oleo|\btaxi\b|ipiranga|shell|petrobras)\b/, 'saida', 'Transporte'],
    [/\b(academia|gym|crossfit|personal|smartfit|smart fit|pilates|natacao)\b/, 'saida', 'Academia'],
    [/\b(faculdade|universidade|curso|matricula|udemy|alura|coursera|duolingo|colegio|creche|apostila|escola)\b/, 'saida', 'Educação'],
    [/\b(livraria|papelaria|xerox|impressao|caderno|apostilas|material escolar)\b/, 'saida', 'Educação'],
    [/\b(airbnb|hotel|pousada|hostel|hospedagem|passagem aerea|booking|decolar|latam|\bgol\b|\bazul\b)\b/, 'saida', 'Viagem'],
    [/\b(veterinario|petshop|pet shop|racao|petz|cobasi|\bpet\b)\b/, 'saida', 'Pet'],
    [/\b(cinema|teatro|show|balada|lazer|passeio|role|rolezinho|festa|ingresso|netflix|spotify|disney|hbo max|prime video|youtube premium|steam|playstation|xbox|nintendo|jogo|game)\b/, 'saida', 'Lazer'],
    [/\b(roupa|roupas|calca|camisa|camiseta|tenis|sapato|vestido|zara|renner|riachuelo|\bcea\b|shein|blusa|shorts|hering|nike|adidas)\b/, 'saida', 'Roupas'],
    [/\b(celular|notebook|eletronico|fone|monitor|carregador|mouse|teclado|headset|computador|tablet|kabum|magalu|magazine)\b/, 'saida', 'Eletrônico'],
    [/\b(salao|cabelo|beleza|manicure|barbearia|barbeiro|maquiagem|barba|unha|sobrancelha|depilacao|estetica|boticario|natura)\b/, 'saida', 'Beleza'],
    [/\b(presente|gift|lembrancinha)\b/, 'saida', 'Presente'],
    [/\b(luz|agua|energia|internet|aluguel|condominio|conta de|iptu|ipva|\bgas\b|telefone|boleto)\b/, 'saida', 'Conta fixa'],
    // Contas fixas que faltavam: seguro e recarga são recorrentes clássicos
    [/\b(seguro|recarga|plano de celular|financiamento|prestacao|parcela do|mensalidade)\b/, 'saida', 'Conta fixa'],
    // Casa/manutenção: o app não tem categoria "Casa" — 'Outros' É a resposta certa
    // aqui, e marcá-la explicitamente evita uma ida à IA que não teria nada melhor.
    [/\b(material de construcao|ferragem|cimento|tinta|lavanderia|chaveiro|encanador|eletricista|pedreiro|marceneiro|faxina|diarista|movel|moveis)\b/, 'saida', 'Outros'],
    // Entrada
    [/\b(salario|salário|pagamento do mes|holerite|folha de pagamento)\b/, 'entrada', 'Salário'],
    [/\b(dividendo|dividendos|rendimento|rendimentos|proventos|resgate|tesouro|jscp)\b/, 'entrada', 'Investimento'],
    [/\b(freela|freelance|bico|renda extra|venda|vendi|comissao|comissoes|cashback|reembolso|premio)\b/, 'entrada', 'Renda Extra'],
];

// Tipo → ícone Font Awesome (A10: respostas visuais por subcategoria).
// Usado pelas frases; mapeia o `tipo` normalizado para um ícone específico.
export const TIPO_ICONE = {
    'Mercado': 'fa-cart-shopping', 'Mercado Livre': 'fa-cart-shopping', 'Farmácia': 'fa-pills',
    'Saúde': 'fa-heart-pulse', 'Transporte': 'fa-car', 'Ifood': 'fa-burger', 'Shopee': 'fa-bag-shopping',
    'Amazon': 'fa-bag-shopping', 'Academia': 'fa-dumbbell', 'Lazer': 'fa-film', 'Roupas': 'fa-shirt',
    'Eletrônico': 'fa-laptop', 'Beleza': 'fa-scissors', 'Presente': 'fa-gift', 'Conta fixa': 'fa-file-invoice-dollar',
    'Viagem': 'fa-plane', 'Pet': 'fa-paw', 'Educação': 'fa-graduation-cap',
    'Cartão': 'fa-credit-card', 'Assinaturas': 'fa-arrows-rotate', 'Salário': 'fa-money-check-dollar',
    'Investimento': 'fa-chart-line', 'Renda Extra': 'fa-hand-holding-dollar',
    'Outros Recebimentos': 'fa-money-bill-wave', 'Outros': 'fa-receipt',
};

// ── Saudações / ajuda / consulta / relatório ─────────────────────────────────
// (texto já vem normalizado: minúsculo e sem acento)
const RE_SAUDACAO  = /^(oi+|ola|opa|e ?ai|eae|eai|opa|salve|fala|coe|hey|help|bom dia|boa tarde|boa noite|blz|beleza|tudo (bem|bom|certo))\b/;
const RE_AJUDA     = /\b(ajuda|me ajuda|como funciona|como (usa|uso|te uso)|o que (voce|vc|da pra) (faz|fazer)|que comandos|comandos|nao sei usar|tutorial|dicas)\b/;
const RE_RELATORIO = /\b(relatorio|resumo(?! do dia)|balanco|extrato|fechamento (do mes|da semana|do trimestre|do ano|mensal|semanal)|como fechei|prestacao de contas|raio-?x|diagnostico( financeiro)?|panorama|visao geral|como (estou|esta|ta|andam|estao) (as |os |de )?(minhas |meus )?(financas|contas|grana|gastos)|minha situacao financeira)\b/;
const RE_CONSULTA  = /\b(quanto|quantos|qual|quais|total de|gastei com|tenho|quanto sobrou|quanto (ja )?(gastei|recebi)|meu saldo|minhas reservas|me mostra|mostra|como (esta|estao|esta|estao))\b/;
const RE_PROJECAO  = /\b(quanto tempo|em quanto tempo|se eu (investir|guardar|aportar|poupar)|vou levar|leva pra|daqui quanto|falta quanto pra)\b/;

// Ranking de gastos / "gráficos" → breakdown por categoria (texto)
// Sem \b no fim: "gastei" tem letra após "gast" (fronteira ficaria no meio da palavra).
const RE_GRAFICOS  = /\b(graficos?|onde (eu )?(mais )?gast|no que (eu )?(mais )?gast|em que (eu )?(mais )?gast|maior(es)? gasto|categoria que mais|onde (foi|vai|ta|esta) (o )?meu dinheiro|resumo por categoria|distribuicao (de|dos) gasto)/;
// Listar últimos lançamentos
const RE_LISTAR    = /\b(ultimas? (transac|lancament|movimenta|compra|entrada)|minhas? (transac|movimenta|ultimas)|meus? (lancament|ultimos)|o que (eu )?(lancei|gastei|registrei|paguei) hoje|extrato de hoje|lista(r)? (as )?(transac|lancament|gasto))/;
// Comparação / média / fatura / quanto falta
const RE_COMPARAR  = /\b(comparad|comparacao|gastei (muito )?mais que|gastei (muito )?menos que|mais (ou menos )?que (o )?mes passado|em rela(c|ç)ao ao mes|(vs|versus) (o )?mes|comparar com)/;
const RE_MEDIA     = /\b(media de gasto|gasto medio|em media (eu )?gast|quanto (eu )?gasto por mes|por mes em media|minha media)/;
const RE_FATURA    = /\b(minha fatura|ver (a )?fatura|fatura (do|da|em aberto|atual|deste mes|desse mes)|quanto (eu )?(vou|tenho que|preciso) pagar (de|da|do)? ?(fatura|cartao)|como (esta|ta) (a |minha )?fatura)/;
const RE_FALTA     = /\b(quanto (ainda )?falta|falta quanto|quanto (eu )?preciso (guardar|juntar)) (pra|para|pro)/;
// Desfazer por texto
const RE_DESFAZER  = /\b(desfaz|desfazer|desfa[cç]a|apaga(r)? (o |a )?ultim|cancela(r)? (isso|o ultimo|a ultima|essa|esse)|errei|foi errado|nao (era|foi) isso|remove(r)? (o )?ultim|apaga isso|cancela isso|volta atras)/;

// ── Mexer num lançamento ANTIGO (não o último) ──────────────────────────────
// O chat só sabe desfazer/corrigir o ÚLTIMO lançamento. Quando o usuário aponta
// para OUTRO ("apaga o gasto de ontem no mercado", "muda aquela compra de terça"),
// a resposta honesta é mandar pra tela de Transações — nunca fingir que entendeu.
// Sem este intent a frase caía no valor_ambiguo (ou na IA) e virava um lançamento
// FANTASMA de R$80 que o usuário nunca pediu.
const RE_VERBO_EDITAR = /\b(apaga|apagar|deleta|deletar|exclui|excluir|remove|remover|muda|mudar|troca|trocar|altera|alterar|corrige|corrigir|edita|editar|arruma|arrumar|conserta|consertar)\b/;
// Referência a um lançamento ESPECÍFICO que não é o último.
const RE_REF_ANTIGA = /\b(aquel[ae]s?|daquel[ae]s?|naquel[ae]s?|(a|essa) (compra|transacao|entrada)|([oe]sse|o) (gasto|lancamento|pagamento)|d[eo] (segunda|terca|quarta|quinta|sexta|sabado|domingo)|de ontem|de anteontem|do dia \d{1,2}|da semana passada|do mes passado|de \d{1,2}\/\d{1,2})/;

/** O texto aponta para um lançamento antigo/específico? (usado também pelo engine
 *  para não aplicar uma correção do "último" quando o usuário falou de outro). */
export function mencionaLancamentoAntigo(rawText) {
    const t = corrigirTypos(norm(rawText));
    return RE_REF_ANTIGA.test(t) && !RE_DESFAZER.test(t);
}
// Repetir o último lançamento (B15): "de novo", "mesma coisa", "igual ontem", "repete".
// Deliberadamente SEM "mais um(a)" (colide com "mais um café 5" = lançamento novo).
const RE_REPETIR   = /\b(de novo|denovo|(a )?mesma coisa|igual (a |ao )?(ontem|antes|de sempre|o de sempre)|repete( isso| o ultimo| a ultima)?|repetir( o ultimo| isso)?|(faz|lanca|bota|poe) (isso )?de novo|outra vez)\b/;

// Pagar conta fixa: "paguei a conta de luz", "quitei o aluguel", "conta de luz paga".
// Exige o artigo/palavra "conta|boleto|fatura de consumo" OU verbo quitar — para NÃO
// capturar "paguei 50 de uber" (que é saída comum, com valor).
const RE_PAGAR_CONTA = /\b(paguei|quitei|ja paguei|acabei de pagar)\b.*\b(a |o |as |os )?(conta|boleto|aluguel|condominio|luz|agua|energia|internet|iptu|ipva|gas|telefone)\b|\b(conta|boleto)\s+(de\s+)?[\p{L}\s]{1,20}\s+(paga|pago|quitad[ao])\b/u;

// Definir orçamento: "põe/define orçamento de 600 pra mercado", "limite de 300 no lazer".
const RE_DEF_ORCAMENTO = /\b(define|definir|poe|poe ai|coloca|colocar|cria|criar|ajusta|ajustar|muda|mudar|quero)\b.*\b(orcamento|limite|teto)\b|\b(orcamento|limite|teto)\s+(de|do|da|pra|para|no|na)\b/;

// Lembrete: "me lembra de pagar o aluguel dia 5", "me avisa amanhã de renovar o seguro".
const RE_LEMBRETE = /\b(me )?(lembra|lembre|avisa|avise|notifica|notifique)\b|\blembrete\b/;

// Novos intents de insight/consulta (B22/C27/C29/C31) e privacidade (E42)
const RE_ORCAMENTO   = /\b(quanto (eu )?(posso|da pra|consigo) gastar|posso gastar quanto|meu orcamento|quanto (ainda )?(sobra|resta|posso) (pra )?gast|quanto (eu )?tenho pra gastar)/;
const RE_ASSINATURAS = /\b(minhas assinaturas|que assinaturas|assinaturas que (eu )?(pago|tenho|assino)|o que (eu )?pago (todo mes|todos os meses|de assinatura)|gastos recorrentes|recorrencias?|o que (mais )?se repete|cobrancas? recorrentes)/;
const RE_NARRATIVA   = /\b(explica(r)? (o )?meu mes|explica(r)? (as )?minhas financas|como foi (o )?meu mes|me conta (como (foi|ta|esta) )?o mes|analisa(r)? meu mes|resumo em texto)/;
const RE_CURIOSIDADE = /\b(curiosidade|dia mais caro|qual (o )?meu dia mais caro|meu padrao de gasto|padrao dos meus gastos)/;
const RE_PRIVACIDADE = /\b(voce (ve|le|acessa|guarda|sabe|manda) .*(dinheiro|dados|saldo|valores|ia)|meus dados (estao|sao|ficam) segur|isso (e|é) seguro|(e|é) seguro (mesmo|isso|usar)|privacidade|a ia (ve|le|sabe|acessa)|onde ficam meus dados|voce compartilha)/;

// ── Período ──────────────────────────────────────────────────────────────────
export function detectPeriodo(t) {
    if (/\bhoje\b/.test(t)) return 'hoje';
    // "semana passada" ANTES de "essa semana": as duas caíam em 'semana' (últimos
    // 7 dias), então perguntar pela semana PASSADA devolvia a ATUAL — resposta
    // errada com cara de certa, que é o pior tipo.
    if (/\bsemana (passada|anterior|retrasada)\b/.test(t) || /\bna semana passada\b/.test(t)) return 'semana_passada';
    if (/\b(essa|esta|nessa|desta|dessa|da|na) semana\b/.test(t)) return 'semana';
    if (/\b(trimestre|ultimos? (3|tres) meses|ultimos? 90 dias|nos? ultimos 3 meses)\b/.test(t)) return 'trimestre';
    if (/\bmes (passado|anterior|retrasado)\b/.test(t) || /\bultimo mes\b/.test(t) || /\bno mes passado\b/.test(t)) return 'mes_passado';
    if (/\b(esse|este) ano\b|\bno ano\b|\beste ano\b/.test(t)) return 'ano';
    if (/\b(tudo|geral|no total|sempre|desde o inicio|desde sempre)\b/.test(t)) return 'tudo';
    if (/\b(esse|este) mes\b|\bno mes\b|\bdo mes\b|\bmes atual\b/.test(t)) return 'mes';
    // A3: mês nomeado ("de maio", "em dezembro") → "mes:YYYY-MM" (ocorrência recente).
    // Só depois dos relativos, para não capturar "mês passado" por engano.
    const ym = parseMesNomeado(t);
    if (ym) return `mes:${ym}`;
    return null; // engine assume 'mes' por padrão em consultas
}

// Alvo da consulta: saldo, entradas, reservas, maior_gasto ou gastos.
function detectConsultaAlvo(t) {
    if (/\bsaldo\b/.test(t) || /quanto (eu )?(tenho|sobrou)/.test(t)) return 'saldo';
    if (RE_GRAFICOS.test(t)) return 'maior_gasto';
    if (/\breserv/.test(t)) return 'reserva';
    if (/\b(ganhei|recebi|recebo|entrou|entrada|entradas|salario|renda|faturei|fatur)\b/.test(t)) return 'entrada';
    return 'gasto';
}

// Verbos de lançamento — usados para dividir mensagens compostas.
const RE_VERBO_LANC = /\b(gastei|paguei|comprei|gasto|torrei|recebi|ganhei|caiu|entrou|guardei|reservei|poupei|juntei|separei|aportei|tirei|resgatei|saquei|assinei)\b/;

// Conta valores monetários num texto (ignora "3x" de parcelas). Usado pelo split.
function _countValores(text) {
    const s = String(text).toLowerCase();
    const re = /(?:r\$\s*)?(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)\s*(k\b|mil\b)?/g;
    let m, n = 0;
    while ((m = re.exec(s)) !== null) {
        if (!m[2] && s[re.lastIndex] === 'x') continue; // "3x" = parcelas, não valor
        n++;
    }
    return n;
}

/**
 * Divide uma mensagem composta em cláusulas independentes de lançamento (B17).
 * Duas passadas: (1) separadores fortes (vírgula não-decimal, ";", "mas/também/
 * depois/daí"); (2) dentro de cada pedaço, quebra em " e " SÓ quando o pedaço
 * tem ≥2 valores — assim "10 no mercado e 10 na gasolina" vira 2 itens, mas
 * "pão e leite" (0 valores) NÃO quebra. Cada cláusula é reinterpretada sozinha
 * pelo funil (local→IA), então cada item recebe a categoria correta.
 * @returns {string[]} segmentos (ou [texto] se não for composto).
 */
export function splitCompound(rawText) {
    const text = String(rawText ?? '');
    // Passada 1 — separadores fortes (vírgula só quando NÃO for decimal).
    const strong = text.split(/(?<!\d),\s*|,\s*(?!\d)|\s*;\s*|\s+mas\s+|\s+por[ée]m\s+|\s+tamb[ée]m\s+|\s+depois\s+|\s+da[ií]\s+|\s+e mais\s+/i);
    // Passada 2 — quebra em " e " apenas quando o pedaço carrega ≥2 valores.
    // A quebra exige valor DOS DOIS LADOS: sem isso, "20 no uber com pão e leite"
    // (2 valores no pedaço inteiro) rachava em "…pão" + "leite", e "leite" — sem
    // valor — era filtrado fora silenciosamente no fim desta função. Perda de
    // dado invisível, e o risco cresce agora que descrições reais ("carne e
    // arroz", "fita de led e tinta branca") naturalmente contêm " e ".
    const segs = [];
    for (const part of strong) {
        const p = part.trim();
        if (!p) continue;
        if (_countValores(p) >= 2 && /\s+e\s+/i.test(p)) {
            const subs = p.split(/\s+e\s+/i).map((s) => s.trim()).filter(Boolean);
            if (subs.every((s) => parseValorBR(s) !== null)) segs.push(...subs);
            else segs.push(p); // algum pedaço não tem valor → não era lista de lançamentos
        } else {
            segs.push(p);
        }
    }
    // Só é composto se ≥2 segmentos independentes contêm valor.
    const comValor = segs.filter((s) => parseValorBR(s) !== null);
    return comValor.length >= 2 ? comValor : [text];
}

/**
 * Casa a primeira palavra-chave conhecida do texto → {categoria, tipo, descricao}.
 * Reutilizado pela correção de categoria inline (B14). Retorna null se nada casar.
 */
export function keywordMatch(rawText) {
    const t = corrigirTypos(norm(rawText));
    for (const [re, cat, tp] of KEYWORDS) {
        if (re.test(t)) return { categoria: cat, tipo: tp, descricao: tp };
    }
    return null;
}

// Detecta uma pergunta de follow-up ("e no mês passado?", "e transporte?").
// Só conta como follow-up se for um MODIFICADOR curto (período/termo) e NÃO
// contiver por si só um gatilho de intenção (aí é uma pergunta nova).
export function parseFollowup(rawText) {
    const t = norm(rawText);
    const temIntent = /\b(quanto|qual|quais|onde|gastei|paguei|comprei|recebi|ganhei|guardei|tirei|saquei|assinei|graficos|fatura|media|saldo|relatorio|resumo|reserva|meta)\b/.test(t);
    if (temIntent) return { isFollowup: false };
    const per = detectPeriodo(t);
    const kws = extractPalavrasChave(t);
    const startsE = /^(e|entao|agora)\b/.test(t);
    const nWords = t.split(/\s+/).length;
    const curto = t.length <= 28 && nWords <= 5;
    const isFollowup = curto && (!!per || kws.length > 0) && (startsE || nWords <= 3);
    return { isFollowup, periodo: per, palavrasChave: kws };
}

// Palavras-chave para consultas (casa contra descrição/tipo/categoria depois).
export function extractPalavrasChave(t) {
    const out = [];
    for (const [re, , tipo] of KEYWORDS) {
        if (re.test(t)) out.push(tipo.toLowerCase());
    }
    // Termos soltos úteis
    for (const w of ['mercado', 'transporte', 'uber', 'ifood', 'lazer', 'farmacia', 'salario', 'reserva']) {
        if (t.includes(w) && !out.includes(w)) out.push(w);
    }
    return [...new Set(out)].slice(0, 6);
}

// Extrai o nome da conta fixa: depois de "conta/boleto de", ou a própria
// palavra de utilidade ("luz", "aluguel"...). Usado por pagar_conta.
const _UTILIDADES = /\b(luz|agua|energia|internet|aluguel|condominio|iptu|ipva|gas|telefone|celular|escola|academia)\b/;
function _extractContaHint(t) {
    const m = t.match(/\b(?:conta|boleto|fatura)\s+(?:de |do |da )?([\p{L}][\p{L}\s]{1,24}?)(?:\s+(?:de hoje|de ontem|hoje|ontem|paga|pago|quitad[ao])\b|$|[.!?])/u);
    if (m) return m[1].trim();
    const u = t.match(_UTILIDADES);
    return u ? u[1] : null;
}

// Extrai o TIPO de orçamento citado no texto (whitelist ORCAMENTO_TIPOS ou keyword).
function _extractOrcamentoTipo(t) {
    for (const tp of ORCAMENTO_TIPOS) {
        const tn = tp.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
        if (new RegExp(`\\b${tn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(t)) return tp;
    }
    const km = keywordMatch(t);
    return km && ORCAMENTO_TIPOS.includes(km.tipo) ? km.tipo : null;
}

// Limpa o texto do lembrete: tira o verbo de lembrar e a expressão de data.
function _extractLembreteTexto(raw) {
    let s = String(raw)
        .replace(/^\s*(me\s+)?(lembra|lembre|avisa|avise|notifica|notifique)\s*(me\s+)?(de|que|do|da)?\s*/i, '')
        .replace(/\blembrete\s*(:|de|pra|para)?\s*/i, '')
        .replace(/\b(depois de amanha|amanha|amanhã|hoje|daqui a? \d{1,2} dias?|em \d{1,2} dias?|dia \d{1,2}|(na |no |proxim[ao] )?(domingo|segunda|terca|terça|quarta|quinta|sexta|sabado|sábado)(-?\s*feira)?( que vem)?|\d{1,2}[\/\-]\d{1,2}([\/\-]\d{2,4})?)\b/gi, '')
        .replace(/\s{2,}/g, ' ').trim();
    return s.replace(/^(de|que|do|da|pra|para)\s+/i, '').trim() || null;
}

// Extrai nome de meta depois de "pra/para/pro" (para "quanto falta pra X").
function _extractMetaHint(t) {
    const m = t.match(/(?:pra|para|pro)\s+(?:a |o |minha |meu )?([\p{L}][\p{L}\s]{1,29})/u);
    return m ? m[1].trim() : null;
}

// "caixinha", "reserva", "cofrinho" sozinhos são a PALAVRA GENÉRICA, não o nome
// da meta. Passá-los adiante como hint faz o resolveMeta procurar uma meta
// chamada "caixinha", falhar, e o engine abrir picker mesmo quando havia só uma
// reserva óbvia. Devolve o nome real ("caixinha de emergência" → "emergencia")
// ou null quando o usuário só disse a palavra genérica.
const RE_META_GENERICA = /^(?:a|o|as|os|minha|meu|nossa|nosso)?\s*(?:reserva|caixinha|cofrinho|porquinho|poupanca|vaquinha|meta|guardadinho)s?\s*(?:d[aeo]\s+)?/;
function _limparMetaHint(h) {
    const limpo = norm(h).replace(RE_META_GENERICA, '').trim();
    return limpo.length >= 2 ? limpo : null;
}
// Extrai nome do cartão depois de "cartao/fatura do/da".
function _extractCartaoHint(t) {
    const m = t.match(/(?:cartao|fatura)\s+(?:do |da |no |de )?([\p{L}][\p{L}\s]{1,29})/u);
    if (!m) return null;
    const h = m[1].trim();
    return /^(em aberto|atual|deste mes|desse mes)/.test(h) ? null : h;
}

/**
 * Parser local. Sempre retorna um objeto (nunca lança).
 * confianca alta (≥0.7) → engine confia; baixa → engine chama a IA.
 */
export function parseLocal(rawText) {
    const text = corrigirTypos(norm(rawText));
    const base = {
        intencao: 'desconhecido', categoria: null, valor: null, tipo: null, descricao: null,
        meta_hint: null, parcelas: null, cartao_hint: null, aporte_mensal: null,
        periodo: null, palavras_chave: [], consulta_alvo: null, data_override: null, confianca: 0,
        // 1 = "li tudo que havia na frase". Só o lançamento rebaixa isso (ver abaixo);
        // saudação/consulta/ajuda não têm conteúdo livre a perder.
        completude: 1, source: 'local',
    };
    if (!text) return base;

    // 0) Tentativa de manipulação/prompt-injection → recusa amigável, sem IA (E43)
    if (RE_INJECT.test(text)) return { ...base, intencao: 'recusa', confianca: 0.96 };

    // 1) Saudação / ajuda / desfazer / repetir (curtas, alta confiança)
    if (RE_SAUDACAO.test(text) && text.length <= 25) return { ...base, intencao: 'saudacao', confianca: 0.97 };
    if (RE_AJUDA.test(text)) return { ...base, intencao: 'ajuda', confianca: 0.9 };
    if (RE_DESFAZER.test(text)) return { ...base, intencao: 'desfazer', confianca: 0.9 };
    // Mexer em lançamento antigo → handoff honesto (o chat só alcança o último).
    // DEPOIS do desfazer, para "apaga o último" continuar sendo desfazer.
    if (RE_VERBO_EDITAR.test(text) && RE_REF_ANTIGA.test(text)) {
        return { ...base, intencao: 'editar_antigo', confianca: 0.85 };
    }
    // B15: repetir o último lançamento — só quando NÃO há valor novo no texto.
    if (RE_REPETIR.test(text) && parseValorBR(text) === null) return { ...base, intencao: 'repetir', confianca: 0.9 };

    // 1b) Lembrete ("me lembra de pagar o aluguel dia 5") — ANTES do lançamento,
    // porque a frase costuma conter verbos de pagamento. 100% local.
    // Guarda: "lembra quanto gastei…" é consulta, não lembrete.
    if (RE_LEMBRETE.test(text) && !/\b(quanto|qual|quais|onde|quando)\b/.test(text)) {
        return {
            ...base, intencao: 'lembrete',
            lembrete_texto: _extractLembreteTexto(rawText),
            lembrete_data: parseDataFutura(text),
            confianca: 0.9,
        };
    }

    // 1c) Pagar conta fixa ("paguei a conta de luz", "quitei o aluguel").
    // O engine tenta casar uma conta em aberto; se não houver, cai pra saída comum.
    if (RE_PAGAR_CONTA.test(text)) {
        return {
            ...base, intencao: 'pagar_conta',
            conta_hint: _extractContaHint(text),
            valor: parseValorBR(text),
            confianca: 0.88,
        };
    }

    // 1d) Definir orçamento ("põe orçamento de 600 pra mercado") — precisa de valor.
    if (RE_DEF_ORCAMENTO.test(text)) {
        const v = parseValorBR(text) ?? parseExtenso(text);
        if (v) {
            return {
                ...base, intencao: 'definir_orcamento',
                tipo: _extractOrcamentoTipo(text), valor: v, confianca: 0.88,
            };
        }
    }

    // 2) Projeção de meta ("se eu guardar X por mês…")
    if (RE_PROJECAO.test(text)) {
        return { ...base, intencao: 'projecao_meta', aporte_mensal: parseValorBR(text), palavras_chave: extractPalavrasChave(text), confianca: 0.6 };
    }

    // 2b) Comparação / média / fatura / quanto falta
    if (RE_COMPARAR.test(text)) return { ...base, intencao: 'consultar', consulta_alvo: 'comparar', confianca: 0.82 };
    if (RE_MEDIA.test(text))    return { ...base, intencao: 'consultar', consulta_alvo: 'media', confianca: 0.82 };
    if (RE_FALTA.test(text))    return { ...base, intencao: 'consultar', consulta_alvo: 'falta_meta', meta_hint: _extractMetaHint(text), confianca: 0.82 };
    if (RE_FATURA.test(text) && !/\b(gastei|paguei|comprei)\b.*\d/.test(text)) {
        return { ...base, intencao: 'consultar', consulta_alvo: 'fatura', cartao_hint: _extractCartaoHint(text), confianca: 0.82 };
    }

    // 2c) Insight/privacidade — checados ANTES do consulta genérico pra vencerem
    if (RE_PRIVACIDADE.test(text)) return { ...base, intencao: 'privacidade', confianca: 0.9 };
    if (RE_NARRATIVA.test(text))   return { ...base, intencao: 'consultar', consulta_alvo: 'narrativa', confianca: 0.86 };
    if (RE_ORCAMENTO.test(text))   return { ...base, intencao: 'consultar', consulta_alvo: 'orcamento', confianca: 0.86 };
    if (RE_ASSINATURAS.test(text)) return { ...base, intencao: 'consultar', consulta_alvo: 'assinaturas', confianca: 0.86 };
    if (RE_CURIOSIDADE.test(text)) return { ...base, intencao: 'consultar', consulta_alvo: 'curiosidade', confianca: 0.82 };

    // 3) Gráficos / "onde mais gastei" → ranking de gastos por categoria
    if (RE_GRAFICOS.test(text)) {
        return { ...base, intencao: 'consultar', consulta_alvo: 'maior_gasto',
                 periodo: detectPeriodo(text) || 'mes', palavras_chave: [], confianca: 0.85 };
    }

    // 3b) Listar últimos lançamentos
    if (RE_LISTAR.test(text)) {
        return { ...base, intencao: 'consultar', consulta_alvo: 'listar',
                 periodo: detectPeriodo(text) || 'mes', palavras_chave: [], confianca: 0.85 };
    }

    // 3c) Relatório
    if (RE_RELATORIO.test(text)) {
        return { ...base, intencao: 'relatorio', periodo: detectPeriodo(text) || 'mes', confianca: 0.85 };
    }

    const valor = parseAritmetica(text) ?? parseValorBR(text) ?? parseExtenso(text);

    // 4) Consulta ("quanto gastei com mercado?") — sem intenção clara de lançar
    if (RE_CONSULTA.test(text) && !/\b(gastei|paguei|comprei)\b\s*(r\$\s*)?\d/.test(text)) {
        return {
            ...base, intencao: 'consultar',
            periodo: detectPeriodo(text) || 'mes',
            palavras_chave: extractPalavrasChave(text),
            consulta_alvo: detectConsultaAlvo(text),
            confianca: 0.8,
        };
    }

    // 5) Lançamento — precisa de categoria (verbo) para ser confiável
    let categoria = null;
    for (const v of VERBOS) { if (v.re.test(text)) { categoria = v.cat; break; } }

    // Sem verbo mas com valor e palavra-chave forte → assume saída (comportamento do app)
    let tipo = null, descricao = null;
    for (const [re, cat, tp] of KEYWORDS) {
        if (re.test(text)) { tipo = tp; if (!categoria) categoria = cat; descricao = tp; break; }
    }

    if (categoria && valor) {
        // Categorias que mexem em meta/cartão → engine faz handoff seguro (fase 2).
        // Aqui só reportamos o parse; o engine decide o roteamento.
        let conf = 0.7;
        if (tipo) conf = 0.9;

        // A DESCRIÇÃO — o que o usuário de fato comprou. Até aqui este campo era
        // sobrescrito pelo rótulo da categoria (o laço de KEYWORDS acima fazia
        // `descricao = tp`) e o texto livre nunca era lido por ninguém: "75,69
        // gastos na shopee com fita de led e tinta branca" gravava "Shopee".
        // Agora o describe.js lê a frase; o rótulo só entra se não sobrar nada.
        const ex = extractDescricao(rawText);

        // COMPLETUDE ≠ CONFIANÇA. `conf` responde "sei o que ele quer?" (sim: é
        // uma saída). `completude` responde "li tudo que estava na frase?". Eram
        // o MESMO número, e por isso um parse certo na intenção e cego no
        // conteúdo era final — vetando a IA justo nas mensagens mais ricas.
        // Baixa quando há descrição de verdade mas nenhuma pista da categoria.
        //
        // SÓ vale para saida/entrada, onde `tipo` É a categoria. Em reserva e
        // retirada_reserva o tipo é null POR PROJETO (o tx-builder grava
        // 'Reserva'/'Retirada de Reserva' por conta própria) — sem esta guarda,
        // todo saque e todo aporte cairiam na IA por "falta de tipo", gastando
        // rede e token à toa numa categoria que o parser já resolveu sozinho.
        const tipoEhCategoria = categoria === 'saida' || categoria === 'entrada';
        const completude = (tipoEhCategoria && !tipo && ex.descricao) ? 0.4 : 1;

        // tipo padrão coerente por categoria
        if (!tipo) {
            if (categoria === 'entrada') { tipo = 'Outros Recebimentos'; descricao = descricao || 'Recebimento'; }
            else if (categoria === 'saida') { tipo = 'Outros'; descricao = descricao || 'Gasto'; }
        }
        // meta_hint — nome após reserva/caixinha/meta/na/no/pra/em.
        // "guardar 50 na viagem" → "viagem"; "poupei 200 na caixinha" → null
        // (genérico: o engine pergunta ou usa a única reserva que existe).
        // Vale também para RETIRADA: antes o hint só era calculado para 'reserva',
        // então "retirei 50 da caixinha de emergência" chegava ao engine sem hint
        // e abria o picker mesmo com o usuário tendo dito de qual reserva era.
        let metaHint = null;
        if (categoria === 'reserva' || categoria === 'retirada_reserva') {
            const mm = text.match(/\b(?:reserva|meta|caixinha|cofrinho|porquinho|poupanca|vaquinha|pra|para|pro|na|no|em)\s+(?:d[aeo]\s+|[ao]\s+)?([\p{L}][\p{L}\s]{1,28})/u);
            if (mm) metaHint = _limparMetaHint(mm[1]);
        }

        return {
            ...base, intencao: 'lancar', categoria, valor, tipo,
            descricao: ex.descricao || descricao || tipo || null,
            meta_hint: metaHint, periodo: null,
            parcelas: categoria === 'saida_credito' ? parseParcelas(rawText) : null,
            data_override: parseDataRelativa(rawText),
            palavras_chave: [], confianca: conf, completude,
        };
    }

    // 5b) Crédito SEM valor: reconhece pra pedir o valor (sem gastar IA).
    //     O engine abre o picker de cartão/parcelas depois do valor.
    if (categoria === 'saida_credito') {
        return {
            ...base, intencao: 'lancar', categoria: 'saida_credito', valor: valor || null,
            descricao: extractDescricao(rawText).descricao || descricao || 'Compra no crédito',
            tipo: tipo || 'Cartão',
            parcelas: parseParcelas(rawText), confianca: 0.75,
        };
    }

    // 5c) Verbo/keyword sem valor ("gastei no mercado" sem número) → guarda o
    //     que foi entendido pra IA tentar; se a IA falhar, naoEntendiEsperto
    //     usa a categoria pra pedir só o valor.
    if (categoria) {
        return { ...base, intencao: 'lancar', categoria, tipo: tipo || null, descricao: descricao || null, confianca: 0.35 };
    }

    // 6) Valor REALMENTE sozinho ("109,05", "80 pila") → AMBÍGUO. NÃO gasta IA: o
    //    engine pergunta o que foi, com 1 toque (B13), e guarda o valor (R3).
    //
    //    A guarda de conteúdo não é detalhe — sem ela isto virava CATCH-ALL: toda
    //    frase que o parser não entendia, mas que tinha um número, era tratada como
    //    "valor solto". "muda o valor daquela compra de terça pra 80" e "cria uma
    //    meta de 5000 pra viagem" viravam convite pra lançar, e um toque no chip
    //    gravava um lançamento FANTASMA que o usuário nunca pediu.
    //
    //    Regra: se sobrou conteúdo que ninguém leu, isto NÃO é um valor solto — é
    //    uma intenção desconhecida. Vai pra IA (ou pro "não entendi"), que é honesto.
    if (valor && contarPalavrasConteudo(rawText) <= 1) {
        return { ...base, intencao: 'valor_ambiguo', valor, confianca: 0.9 };
    }
    return base;
}
