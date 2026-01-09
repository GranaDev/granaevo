/* ==============================================
   CHAT ASSISTANT GE - JAVASCRIPT COMPLETO V5
   Assistente virtual inteligente com correções de UI e usabilidade
   ============================================== */

// ========== BIBLIOTECA DE CORREÇÃO E SINÔNIMOS ==========
const CorrecaoInteligente = {
    // Correções ortográficas comuns
    correcoes: {
        'mecado': 'mercado',
        'supemercado': 'supermercado',
        'resturante': 'restaurante',
        'restaurate': 'restaurante',
        'gasolna': 'gasolina',
        'conbustivel': 'combustível',
        'farmacia': 'farmácia',
        'remedio': 'remédio',
        'educaçao': 'educação',
        'educasao': 'educação',
        'eletronico': 'eletrônico',
        'eletronicos': 'eletrônicos',
        'vestuario': 'vestuário',
        'cartao': 'cartão',
        'credito': 'crédito',
        'salario': 'salário',
        'conto': 'reais',
        'contos': 'reais',
        'pila': 'reais',
        'pilas': 'reais',
        'pau': 'reais',
        'paus': 'reais',
        'pratas': 'reais',
        'mangos': 'reais',
        'temers': 'reais',
        'dilmas': 'reais',
        'ifood': 'iFood',
        'uber': 'Uber',
        'netflix': 'Netflix',
        'spotify': 'Spotify',
        'amazon': 'Amazon Prime',
        'disney': 'Disney+',
        'nubank': 'Nubank',
        'picpay': 'PicPay',
        'mercadopago': 'Mercado Pago',
        'pix': 'PIX',
        'cafe': 'Café',
        'chocolate': 'Chocolate'
    },

    // Sinônimos de valores monetários
    sinonimosMoeda: {
        'conto': 'reais',
        'contos': 'reais',
        'pila': 'reais',
        'pilas': 'reais',
        'pau': 'reais',
        'paus': 'reais',
        'pratas': 'reais',
        'real': 'reais',
        'mangos': 'reais',
        'temers': 'reais',
        'dilmas': 'reais',
        'dinheiro': 'reais'
    },

    // Aplicar correções
    corrigirTexto(texto) {
        let textoCorrigido = texto.toLowerCase();
        
        // Aplicar correções ortográficas
        Object.keys(this.correcoes).forEach(erro => {
            const regex = new RegExp(`\\b${erro}\\b`, 'gi');
            textoCorrigido = textoCorrigido.replace(regex, this.correcoes[erro]);
        });

        return textoCorrigido;
    },

    // Normalizar valores monetários
    normalizarValor(texto) {
        let textoNormalizado = texto.toLowerCase();
        
        Object.keys(this.sinonimosMoeda).forEach(sinonimo => {
            const regex = new RegExp(`\\b${sinonimo}\\b`, 'gi');
            textoNormalizado = textoNormalizado.replace(regex, 'reais');
        });

        return textoNormalizado;
    }
};

// ========== BIBLIOTECA DE DETECÇÃO INTELIGENTE ==========
const DetectorInteligente = {
    // Tipos de entrada com variações
    tiposEntrada: {
        'Salário': [
            'salario', 'salário', 'ordenado', 'pagamento do trabalho', 
            'salario do mes', 'salário do mês', 'contra cheque', 'contracheque'
        ],
        'Freelance': [
            'freelance', 'freela', 'bico', 'trampo', 'trabalho extra',
            'job', 'gig', 'projeto', 'servico', 'serviço'
        ],
        'Renda Extra': [
            'renda extra', 'extra', 'ifood', 'uber', 'delivery',
            'entrega', 'app', 'aplicativo', 'rappi', '99', 'cabify',
            'fazendo ifood', 'fazendo uber', 'trabalhando de', 'dirigindo'
        ],
        'Investimentos': [
            'investimento', 'rendimento', 'dividendo', 'juros',
            'acao', 'ações', 'fundo', 'cdb', 'tesouro', 'bolsa'
        ],
        'Presente': [
            'presente', 'presenteado', 'ganhei de presente', 'premiacao',
            'premio', 'prêmio', 'sorteio', 'bonus', 'bônus'
        ],
        'Venda': [
            'venda', 'vendi', 'vendendo', 'vender'
        ]
    },

    // Tipos de saída com variações
    tiposSaida: {
        'Mercado': [
            'mercado', 'supermercado', 'feira', 'hortifruti', 'açougue',
            'acougue', 'padaria', 'compras', 'compra do mes', 'compra do mês',
            'mercadinho', 'minimercado', 'atacadao', 'atacadão'
        ],
        'Restaurante': [
            'restaurante', 'lanchonete', 'fast food', 'ifood', 'delivery',
            'comida', 'almoço', 'almoco', 'jantar', 'lanche', 'pizza',
            'hamburguer', 'burguer', 'sushi', 'mcdonald', 'bk', 'subway',
            'pedido', 'rappi', 'uber eats', 'comendo fora'
        ],
        'Transporte': [
            'transporte', 'uber', 'taxi', 'onibus', 'ônibus', 'metro',
            'metrô', 'trem', 'gasolina', 'combustivel', 'combustível',
            'alcool', 'álcool', 'etanol', 'diesel', 'estacionamento',
            'pedagio', 'pedágio', '99', 'cabify', 'corrida', 'viagem de'
        ],
        'Saúde': [
            'saude', 'saúde', 'medico', 'médico', 'consulta', 'exame',
            'farmacia', 'farmácia', 'remedio', 'remédio', 'medicamento',
            'hospital', 'clinica', 'clínica', 'dentista', 'laboratorio',
            'laboratório', 'plano de saude', 'plano de saúde', 'convenio',
            'convênio'
        ],
        'Educação': [
            'educacao', 'educação', 'curso', 'faculdade', 'escola',
            'colegio', 'colégio', 'universidade', 'livro', 'material escolar',
            'mensalidade', 'matricula', 'matrícula', 'apostila', 'aula'
        ],
        'Lazer': [
            'lazer', 'cinema', 'show', 'festa', 'viagem', 'passeio',
            'diversao', 'diversão', 'teatro', 'parque', 'balada',
            'bar', 'pub', 'entretenimento', 'ingresso', 'evento'
        ],
        'Vestuário': [
            'roupa', 'vestuario', 'vestuário', 'calca', 'calça', 'camisa',
            'sapato', 'tenis', 'tênis', 'bota', 'sandalia', 'sandália',
            'blusa', 'vestido', 'saia', 'short', 'bermuda', 'jaqueta',
            'casaco', 'moda', 'loja de roupa'
        ],
        'Eletrônicos': [
            'eletronico', 'eletrônico', 'eletronicos', 'eletrônicos',
            'celular', 'computador', 'notebook', 'monitor', 'tv',
            'televisao', 'televisão', 'fone', 'headphone', 'mouse',
            'teclado', 'tablet', 'smartwatch', 'camera', 'câmera',
            'console', 'videogame', 'playstation', 'xbox', 'nintendo'
        ],
        'Casa': [
            'casa', 'movel', 'móvel', 'decoracao', 'decoração',
            'eletrodomestico', 'eletrodoméstico', 'geladeira', 'fogao',
            'fogão', 'microondas', 'liquidificador', 'aspirador',
            'ferro', 'ventilador', 'ar condicionado', 'sofa', 'sofá',
            'cama', 'mesa', 'cadeira', 'armario', 'armário'
        ],
        'Contas': [
            'conta', 'contas', 'luz', 'energia', 'agua', 'água',
            'internet', 'telefone', 'celular', 'aluguel', 'condominio',
            'condomínio', 'iptu', 'gas', 'gás', 'fatura', 'boleto'
        ],
        'Assinaturas': [
            'assinatura', 'netflix', 'spotify', 'amazon', 'disney',
            'hbo', 'globoplay', 'youtube premium', 'apple music',
            'deezer', 'mensalidade', 'plano', 'streaming'
        ]
    },

    // Tipos de reserva com variações
    tiposReserva: {
        'Emergência': [
            'emergencia', 'emergência', 'reserva de emergencia',
            'fundo de emergencia', 'seguranca', 'segurança'
        ],
        'Viagem': [
            'viagem', 'ferias', 'férias', 'passeio', 'turismo', 'trip'
        ],
        'Investimento': [
            'investimento', 'investir', 'aplicacao', 'aplicação'
        ],
        'Objetivo': [
            'objetivo', 'meta', 'sonho', 'projeto', 'plano'
        ]
    },

    // Detectar tipo com base em palavras-chave
        detectarTipo(texto, categoria) {
            const textoLimpo = texto.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
            
            let tipos = {};
            if (categoria === 'entrada') tipos = this.tiposEntrada;
            else if (categoria === 'saida' || categoria === 'saida_credito') tipos = this.tiposSaida;
            else if (categoria === 'reserva') tipos = this.tiposReserva;

            // Buscar correspondências
            for (const [tipo, palavrasChave] of Object.entries(tipos)) {
                for (const palavra of palavrasChave) {
                    if (textoLimpo.includes(palavra)) {
                        return tipo;
                    }
                }
            }

            // Retorna null quando não detectar tipo específico
            return null;
        },

    // Extrair descrição inteligente e lapidada
    extrairDescricao(textoOriginal, textoLimpo, tipo) {
    const palavrasRemover = [
        'eu', 'a gente', 'nos', 'eu comprei', 'eu gastei', 'eu recebi', 'eu guardei',
        'recebi', 'receber', 'ganhei', 'ganhar', 'gastei', 'gastar',
        'comprei', 'comprar', 'paguei', 'pagar', 'guardei', 'guardar',
        'reservei', 'reservar', 'economizei', 'economizar',
        'hoje', 'ontem', 'amanha', 'amanhã', 'agora', 'fazendo',
        'trabalhando', 'de', 'do', 'da', 'dos', 'das', 'em', 'no', 'na', 'nos', 'nas', 'a', 'o', 'e',
        'com', 'para', 'pelo', 'pela', 'um', 'uma', 'uns', 'umas', 'num', 'numa',
        'reais', 'real', 'r$', 'dinheiro', 'conto', 'contos', 'com um', 'com uma',
        'pelo', 'pela', 'com o', 'com a', 'tomei', 'tomei um', 'tomei uma', 'fui no', 'fui na',
        'por', 'por um', 'por uma', 'por uns', 'por umas', 'comi', 'bebi', 'comprei um', 'comprei uma',
        'no valor de', 'valor de', 'no cartao', 'no cartão', 'cartao', 'cartão', 'credito', 'crédito'
    ];

    let descricao = textoOriginal;
    
    // Remove valores monetários ANTES de processar
    descricao = descricao.replace(/\d+(?:[.,]\d+)?\s*(?:reais?|r\$|R\$|conto|contos|pila|pilas)?/gi, '');
    
    // Remove parcelas
    descricao = descricao.replace(/\d+\s*x|em\s*\d+\s*x?|vezes/gi, '');
    
    // Remove "no valor de", "cartão", "crédito" e variações
    descricao = descricao.replace(/no\s+valor\s+de/gi, '');
    descricao = descricao.replace(/\b(cartao|cartão|credito|crédito|no\s+cartao|no\s+cartão)\b/gi, '');

    // Remove palavras-chave de ação
    palavrasRemover.forEach(palavra => {
        const regex = new RegExp(`\\b${palavra}\\b`, 'gi');
        descricao = descricao.replace(regex, '');
    });

    // Limpar espaços extras
    descricao = descricao.trim().replace(/\s+/g, ' ');

    // Capitalizar primeira letra de cada palavra importante
    descricao = this.capitalizarDescricao(descricao);

    // Se a descrição ficou vazia ou muito curta
    if (!descricao || descricao.length < 3) {
        if (tipo !== 'Transação via Chat') {
            descricao = tipo;
        } else {
            descricao = 'Transação via Chat';
        }
    }

    return descricao;
    },

    // Capitalizar descrição
    capitalizarDescricao(texto) {
        const palavrasMinusculas = ['de', 'do', 'da', 'dos', 'das', 'em', 'no', 'na', 'nos', 'nas', 'a', 'o', 'e', 'com', 'para'];
        
        return texto.split(' ')
            .map((palavra, index) => {
                if (index === 0 || !palavrasMinusculas.includes(palavra.toLowerCase())) {
                    return palavra.charAt(0).toUpperCase() + palavra.slice(1).toLowerCase();
                }
                return palavra.toLowerCase();
            })
            .join(' ');
    }
};

// ========== BIBLIOTECA DE ANÁLISE AVANÇADA ==========
const AnalisadorAvancado = {
    // Analisar padrões de gastos
    analisarPadroes(transacoes) {
        const analise = {
            categoriasMaisGastam: {},
            horariosPreferidos: {},
            diasSemana: {},
            tendencias: []
        };

        transacoes.forEach(t => {
            if (t.categoria === 'saida' || t.categoria === 'saida_credito') {
                // Categorias
                if (!analise.categoriasMaisGastam[t.tipo]) {
                    analise.categoriasMaisGastam[t.tipo] = { total: 0, quantidade: 0 };
                }
                analise.categoriasMaisGastam[t.tipo].total += t.valor;
                analise.categoriasMaisGastam[t.tipo].quantidade++;

                // Horários (se disponível)
                if (t.hora) {
                    const hora = parseInt(t.hora.split(':')[0]);
                    const periodo = hora < 12 ? 'Manhã' : hora < 18 ? 'Tarde' : 'Noite';
                    analise.horariosPreferidos[periodo] = (analise.horariosPreferidos[periodo] || 0) + 1;
                }

                // Dias da semana
                if (t.data) {
                    const data = new Date(t.data);
                    const diaSemana = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'][data.getDay()];
                    analise.diasSemana[diaSemana] = (analise.diasSemana[diaSemana] || 0) + 1;
                }
            }
        });

        return analise;
    },

    // Gerar insights personalizados
    gerarInsights(transacoes, entradas, saidas, reservas) {
        const insights = [];

        // Análise de economia
        const taxaEconomia = entradas > 0 ? ((entradas - saidas) / entradas) * 100 : 0;
        if (taxaEconomia > 30) {
            insights.push('🎉 Excelente! Você está economizando mais de 30% da sua renda. Continue assim!');
        } else if (taxaEconomia > 20) {
            insights.push('👍 Bom trabalho! Você está economizando mais de 20% da sua renda.');
        } else if (taxaEconomia > 10) {
            insights.push('💡 Você está economizando, mas pode melhorar. Tente reduzir gastos não essenciais.');
        } else if (taxaEconomia > 0) {
            insights.push('⚠️ Sua taxa de economia está baixa. Revise seus gastos e crie um plano de economia.');
        } else {
            insights.push('🚨 Atenção! Você está gastando mais do que ganha. É urgente revisar seu orçamento.');
        }

        // Análise de reservas
        const percentualReserva = entradas > 0 ? (reservas / entradas) * 100 : 0;
        if (percentualReserva >= 20) {
            insights.push('💰 Suas reservas estão excelentes! Você está guardando mais de 20% da sua renda.');
        } else if (percentualReserva >= 10) {
            insights.push('🎯 Você está guardando dinheiro, mas pode aumentar suas reservas para 20%.');
        } else if (percentualReserva > 0) {
            insights.push('📊 Comece a aumentar suas reservas. O ideal é guardar pelo menos 10-20% da renda.');
        } else {
            insights.push('💡 Você ainda não tem reservas. Comece guardando pelo menos 10% da sua renda mensal.');
        }

        // Análise de padrões
        const analise = this.analisarPadroes(transacoes);
        const categoriaTop = Object.entries(analise.categoriasMaisGastam)
            .sort((a, b) => b[1].total - a[1].total)[0];

        if (categoriaTop) {
            insights.push(`📊 Sua categoria com mais gastos é: ${categoriaTop[0]} (${formatBRL(categoriaTop[1].total)})`);
        }

        return insights;
    },

    // Sugerir ações baseadas em contexto
    sugerirAcoes(transacoes, saldo) {
        const sugestoes = [];

        const hoje = new Date();
        const mesAtual = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}`;
        
        const gastosHoje = transacoes.filter(t => 
            (t.categoria === 'saida' || t.categoria === 'saida_credito') && 
            t.data === hoje.toISOString().slice(0, 10)
        );

        const gastosMes = transacoes.filter(t => 
            (t.categoria === 'saida' || t.categoria === 'saida_credito') && 
            t.mes === mesAtual
        );

        // Sugestões baseadas em gastos diários
        if (gastosHoje.length > 5) {
            sugestoes.push('⚠️ Você já fez muitas transações hoje. Cuidado com gastos impulsivos!');
        }

        // Sugestões baseadas em saldo
        if (saldo < 0) {
            sugestoes.push('🚨 Seu saldo está negativo. Priorize pagar dívidas e evite novos gastos.');
        } else if (saldo < 100) {
            sugestoes.push('⚠️ Seu saldo está baixo. Evite gastos desnecessários até receber nova renda.');
        } else if (saldo > 1000) {
            sugestoes.push('💡 Você tem um bom saldo. Considere investir parte dele ou aumentar suas reservas.');
        }

        // Sugestões baseadas em categorias
        const restaurante = gastosMes.filter(t => t.tipo === 'Restaurante').reduce((sum, t) => sum + t.valor, 0);
        const mercado = gastosMes.filter(t => t.tipo === 'Mercado').reduce((sum, t) => sum + t.valor, 0);

        if (restaurante > mercado * 0.5) {
            sugestoes.push('🍽️ Você está gastando muito com restaurantes. Cozinhar em casa pode economizar bastante!');
        }

        return sugestoes;
    }
};

// ========== CLASSE PRINCIPAL DO CHAT ASSISTANT ==========
class ChatAssistant {
    constructor() {
        this.isOpen = false;
        this.messages = [];
        this.waitingForCardSelection = false;
        this.waitingForTypeSelection = false;
        this.pendingTransaction = null;
        this.conversationContext = [];
        this.perfilAtivo = null;
        this.init();
    }
    
    // ========== FUNÇÕES DE UTILIDADE DE UI ==========
    getAvatarHtml(isUser = false) {
        if (isUser) {
            const perfil = perfilAtivo;
            if (perfil && perfil.foto) {
                return `<img src="${perfil.foto}" alt="${perfil.nome.charAt(0).toUpperCase()}">`;
            }
            return perfil?.nome?.charAt(0).toUpperCase() || 'U';
        }
        return 'Ge';
    }

// ========== INICIALIZAÇÃO ==========
    init() {
        this.createChatUI();
        this.attachEventListeners();
        window.chatAssistant = this; // ✅ Torna o chat acessível globalmente
        
        // ✅ NÃO carregar mensagens aqui - aguardar seleção de perfil
        console.log('💬 Chat Assistant inicializado. Aguardando seleção de perfil...');
    }

    // ✅ MÉTODO CORRIGIDO: onProfileSelected
    onProfileSelected(perfil) {
        console.log('💬 Chat Assistant recebeu o sinal do perfil:', perfil);
        this.perfilAtivo = perfil; // Armazena a referência do perfil ativo

        // Agora que temos um perfil, carregamos as mensagens
        this.loadMessages();

        // Se não houver mensagens, envia a mensagem de boas-vindas personalizada
        if (this.messages.length === 0) {
            this.sendWelcomeMessage();
        }
    }


    // ========== CRIAR INTERFACE DO CHAT ==========
    createChatUI() {
        // Botão flutuante
        const chatBtn = document.createElement('button');
        chatBtn.className = 'chat-assistant-btn';
        chatBtn.id = 'chatAssistantBtn';
        chatBtn.innerHTML = '<i class="fas fa-comments"></i>';
        document.body.appendChild(chatBtn);

        // Container do chat
        const chatContainer = document.createElement('div');
        chatContainer.className = 'chat-assistant-container';
        chatContainer.id = 'chatAssistantContainer';
        chatContainer.innerHTML = `
            <div class="chat-assistant-header">
                <div class="chat-assistant-header-info">
                    <div class="chat-assistant-avatar">Ge</div>
                    <div class="chat-assistant-title">
                        <div class="chat-assistant-name">Ge - Assistente</div>
                        <div class="chat-assistant-status">
                            <span class="status-dot"></span>
                            Online
                        </div>
                    </div>
                </div>
                <button class="chat-assistant-close" id="chatAssistantClose">
                    <i class="fas fa-times"></i>
                </button>
            </div>
            <div class="chat-assistant-body" id="chatAssistantBody"></div>
            <div class="chat-assistant-footer">
                <input type="text" 
                       class="chat-assistant-input" 
                       id="chatAssistantInput" 
                       placeholder="Digite sua mensagem...">
                <button class="chat-assistant-send" id="chatAssistantSend">
                    <i class="fas fa-paper-plane"></i>
                </button>
            </div>
        `;
        document.body.appendChild(chatContainer);
        
        this.updateHeaderAvatar();
    }

    updateHeaderAvatar() {
        const avatarElement = document.querySelector('#chatAssistantContainer .chat-assistant-header .chat-assistant-avatar');
        if (avatarElement) {
            avatarElement.innerHTML = this.getAvatarHtml(false); // Ge
        }
    }

    // ========== EVENTOS ==========
    attachEventListeners() {
        const btn = document.getElementById('chatAssistantBtn');
        const closeBtn = document.getElementById('chatAssistantClose');
        const sendBtn = document.getElementById('chatAssistantSend');
        const input = document.getElementById('chatAssistantInput');

        btn.addEventListener('click', () => this.toggleChat());
        closeBtn.addEventListener('click', () => this.closeChat());
        sendBtn.addEventListener('click', () => this.sendMessage());
        input.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.sendMessage();
        });
    }

    // ========== CONTROLE DE ABERTURA/FECHAMENTO ==========
    toggleChat() {
        this.isOpen = !this.isOpen;
        const container = document.getElementById('chatAssistantContainer');
        if (this.isOpen) {
            container.classList.add('active');
            document.getElementById('chatAssistantInput').focus();
            this.scrollToBottom();
        } else {
            container.classList.remove('active');
        }
    }

    closeChat() {
        this.isOpen = false;
        document.getElementById('chatAssistantContainer').classList.remove('active');
    }

     // ========== MENSAGEM DE BOAS-VINDAS ==========
    sendWelcomeMessage() {
        const hora = new Date().getHours();
        let saudacao = 'Olá';
        if (hora >= 5 && hora < 12) saudacao = 'Bom dia';
        else if (hora >= 12 && hora < 18) saudacao = 'Boa tarde';
        else saudacao = 'Boa noite';

        const nome = this.perfilAtivo?.nome || 'amigo(a)'; // ✅ USA this.perfilAtivo
        
        const welcomeMsg = `${saudacao}, ${nome}! 👋\n\nEu sou a **Ge**, sua assistente financeira virtual inteligente!\n\n**Como posso te ajudar hoje?**\n\n💰 Fazer lançamentos rápidos\n📊 Analisar seus gastos\n💡 Dar dicas personalizadas\n📈 Consultar saldo e reservas\n\n**Exemplos do que você pode dizer:**\n• "Recebi 2500 de salário"\n• "Gastei 50 no mercado"\n• "Comprei um monitor de 600 em 3x"\n• "Como está meu saldo?"\n• "Me dê dicas de economia"\n\n✨ Pode escrever naturalmente, eu entendo!`;
        
        this.addMessage(welcomeMsg, 'assistant');
    }

    // ========== ENVIAR MENSAGEM ==========
    sendMessage() {
        const input = document.getElementById('chatAssistantInput');
        const message = input.value.trim();

        if (!message) return;

        this.addMessage(message, 'user');
        this.conversationContext.push({ role: 'user', content: message });
        input.value = '';

        this.showTypingIndicator();
        
        setTimeout(() => {
            this.hideTypingIndicator();
            this.processMessage(message);
        }, 800 + Math.random() * 400);
    }

    // ========== ADICIONAR MENSAGEM ==========
    addMessage(text, sender = 'assistant', options = null) {
        const body = document.getElementById('chatAssistantBody');
        const messageDiv = document.createElement('div');
        messageDiv.className = `chat-message ${sender}`;

        const avatarContent = this.getAvatarHtml(sender === 'user');

        messageDiv.innerHTML = `
            <div class="chat-message-avatar">${avatarContent}</div>
            <div>
                <div class="chat-message-content">${this.formatMessage(text)}</div>
                ${options ? this.createOptions(options) : ''}
            </div>
        `;

        body.appendChild(messageDiv);
        this.scrollToBottom();

        this.messages.push({ text, sender, timestamp: new Date() });
        this.saveMessages();

        if (sender === 'assistant') {
            this.conversationContext.push({ role: 'assistant', content: text });
        }
    }

    // ========== FORMATAR MENSAGEM ==========
    formatMessage(text) {
        // Corrigido para usar <br> e manter a formatação de markdown
        // O problema de quebra de linha vertical em palavras curtas é resolvido no CSS com word-break: normal;
        return text
            .replace(/\n/g, '<br>')
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.*?)\*/g, '<em>$1</em>');
    }

    // ========== CRIAR OPÇÕES DE CARTÃO ==========
    createOptions(options) {
    let html = '<div class="chat-card-options">';
    options.forEach((option, index) => {
        // Determinar qual função chamar baseado no estado de espera
        const onClick = this.waitingForCardSelection 
            ? `chatAssistant.selectCardOption(${index})` 
            : `chatAssistant.selectTypeOption(${index})`;
        
        // Determinar ícone baseado no tipo de seleção
        const icon = this.waitingForCardSelection 
            ? 'fa-credit-card' 
            : 'fa-tag';
        
        html += `
            <div class="chat-card-option" onclick="${onClick}">
                <i class="fas ${icon}"></i>
                ${option.text}
            </div>
        `;
    });
    html += '</div>';
    return html;
}

    // ========== SELECIONAR OPÇÃO DE CARTÃO ==========
    selectCardOption(index) {
        if (!this.waitingForCardSelection || !this.pendingTransaction) return;

        const cartao = cartoesCredito[index];
        this.addMessage(`Cartão selecionado: ${cartao.nome}`, 'user');
        
        this.showTypingIndicator();
        setTimeout(() => {
            this.hideTypingIndicator();
            this.executePendingTransaction(cartao.id);
        }, 600);
    }

    // ========== EXECUTAR TRANSAÇÃO PENDENTE ==========
    executePendingTransaction(cartaoId) {
        const trans = this.pendingTransaction;
        trans.cartaoId = cartaoId;

        this.executeTransaction(trans);

        this.waitingForCardSelection = false;
        this.pendingTransaction = null;
    }

    // ========== INDICADOR DE DIGITAÇÃO ==========
    showTypingIndicator() {
        const body = document.getElementById('chatAssistantBody');
        const typingDiv = document.createElement('div');
        typingDiv.className = 'chat-typing';
        typingDiv.id = 'chatTyping';
        typingDiv.innerHTML = `
            <div class="chat-typing-avatar">Ge</div>
            <div class="chat-typing-dots">
                <div class="chat-typing-dot"></div>
                <div class="chat-typing-dot"></div>
                <div class="chat-typing-dot"></div>
            </div>
        `;
        body.appendChild(typingDiv);
        this.scrollToBottom();
    }

    hideTypingIndicator() {
        const typing = document.getElementById('chatTyping');
        if (typing) typing.remove();
    }

    // ========== SCROLL AUTOMÁTICO ==========
    scrollToBottom() {
        const body = document.getElementById('chatAssistantBody');
        body.scrollTop = body.scrollHeight;
    }

    // ========== PROCESSAR MENSAGEM ==========
   processMessage(message) {
    // Aplicar correções ortográficas
    const msgCorrigida = CorrecaoInteligente.corrigirTexto(message);
    const msgNormalizada = CorrecaoInteligente.normalizarValor(msgCorrigida);
    const msgLower = msgNormalizada.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    // Verificar se está aguardando seleção de tipo
    if (this.waitingForTypeSelection) {
        if (msgLower.includes('cancelar')) {
            this.waitingForTypeSelection = false;
            this.pendingTransaction = null;
            this.addMessage('Operação cancelada. Como posso te ajudar?', 'assistant');
        } else {
            this.addMessage('Por favor, selecione um dos tipos acima ou digite "cancelar" para cancelar a operação.', 'assistant');
        }
        return;
    }

    // Verificar se está aguardando seleção de cartão
    if (this.waitingForCardSelection) {
        if (msgLower.includes('cancelar')) {
            this.waitingForCardSelection = false;
            this.pendingTransaction = null;
            this.addMessage('Operação cancelada. Como posso te ajudar?', 'assistant');
        } else {
            this.addMessage('Por favor, selecione um dos cartões acima ou digite "cancelar" para cancelar a operação.', 'assistant');
        }
        return;
    }

    // Detectar tipo de mensagem
        if (this.isTransactionMessage(msgLower)) {
            this.handleTransaction(message, msgLower, msgCorrigida);
        } else if (this.isQueryMessage(msgLower)) {
            this.handleQuery(msgLower);
        } else if (this.isAdviceRequest(msgLower)) {
            this.handleAdviceRequest(msgLower);
        } else if (this.isGreeting(msgLower)) {
            this.handleGreeting(msgLower);
        } else if (this.isThanking(msgLower)) {
            this.handleThanking();
        } else {
            this.handleGeneralMessage(msgLower);
        }
    }

    // ========== VERIFICADORES DE TIPO DE MENSAGEM ==========
    isTransactionMessage(msg) {
        const transactionKeywords = [
            'recebi', 'receber', 'ganhei', 'ganhar', 'salario', 'salário', 'renda',
            'gastei', 'gastar', 'comprei', 'comprar', 'paguei', 'pagar',
            'guardei', 'guardar', 'reservei', 'reservar', 'economizei', 'economizar'
        ];
        return transactionKeywords.some(keyword => msg.includes(keyword)) && /\d/.test(msg);
    }

    isQueryMessage(msg) {
        const queryKeywords = [
            'saldo', 'quanto tenho', 'quanto tem', 'quanto ta', 'quanto está',
            'gastos', 'gastei quanto', 'quanto gastei', 'onde gastei',
            'reservas', 'quanto guardei', 'quanto reservei',
            'hoje', 'semana', 'mes', 'mês', 'ano', 'relatorio', 'relatório'
        ];
        return queryKeywords.some(keyword => msg.includes(keyword));
    }

    isAdviceRequest(msg) {
        const adviceKeywords = [
            'dica', 'dicas', 'conselho', 'conselhos', 'ajuda', 'ajudar',
            'melhorar', 'economizar', 'poupar', 'sugestao', 'sugestão',
            'como fazer', 'o que fazer'
        ];
        return adviceKeywords.some(keyword => msg.includes(keyword));
    }

    isGreeting(msg) {
        const greetings = ['oi', 'olá', 'ola', 'hey', 'opa', 'bom dia', 'boa tarde', 'boa noite', 'e ai', 'e aí'];
        return greetings.some(greeting => msg.includes(greeting));
    }

    isThanking(msg) {
        const thanks = ['obrigado', 'obrigada', 'valeu', 'vlw', 'thanks', 'brigado', 'brigada'];
        return thanks.some(thank => msg.includes(thank));
    }

    // ========== PROCESSAR TRANSAÇÃO ==========
    handleTransaction(originalMsg, msgLower, msgCorrigida) {
    const transactionData = this.extractTransactionData(originalMsg, msgLower, msgCorrigida);

    if (!transactionData) {
        this.addMessage('Hmm, não consegui identificar todos os detalhes da transação. 🤔\n\nPoderia me dizer de forma mais clara?\n\n**Exemplos:**\n• "Recebi 2500 de salário"\n• "Gastei 300 no mercado"\n• "Comprei um celular de 1200 em 6x no cartão"', 'assistant');
        return;
    }

    // Verificar se precisa de seleção de tipo
    if (transactionData.needsTypeSelection) {
        this.handleTypeSelection(transactionData);
        return;
    }

    // Confirmar dados antes de lançar
    const confirmacao = this.gerarConfirmacao(transactionData);
    this.addMessage(confirmacao, 'assistant');

    // Verificar se é saída no crédito
    if (transactionData.categoria === 'saida_credito') {
        this.handleCreditTransaction(transactionData);
    } else {
        setTimeout(() => {
            this.executeTransaction(transactionData);
        }, 500);
    }
}

    // ========== SOLICITAR SELEÇÃO DE TIPO ==========
handleTypeSelection(transactionData) {
    this.waitingForTypeSelection = true;
    this.pendingTransaction = transactionData;

    let tiposDisponiveis = [];
    
    if (transactionData.categoria === 'entrada') {
        tiposDisponiveis = ['Salário', 'Renda Extra', 'Freelance', 'Investimentos', 'Presente', 'Venda', 'Outros Recebimentos'];
    } else if (transactionData.categoria === 'saida' || transactionData.categoria === 'saida_credito') {
        tiposDisponiveis = [
            'Mercado', 'Farmácia', 'Eletrônico', 'Roupas', 'Assinaturas', 
            'Beleza', 'Presente', 'Conta fixa', 'Cartão', 'Academia', 
            'Lazer', 'Transporte', 'Shopee', 'Mercado Livre', 'Ifood', 
            'Amazon', 'Restaurante', 'Saúde', 'Educação', 'Casa', 'Outros'
        ];
    } else if (transactionData.categoria === 'reserva') {
        tiposDisponiveis = ['Emergência', 'Viagem', 'Investimento', 'Objetivo', 'Outro'];
    }

    const options = tiposDisponiveis.map(tipo => ({
        text: tipo
    }));

    const categoriaLabel = {
        'entrada': '💰 Entrada',
        'saida': '💸 Saída',
        'reserva': '🎯 Reserva',
        'saida_credito': '💳 Saída no Crédito'
    };

    this.addMessage(
        `🤔 **Ops! Não consegui identificar o tipo exato desta transação.**\n\n` +
        `📋 **Categoria:** ${categoriaLabel[transactionData.categoria]}\n` +
        `💵 **Valor:** ${formatBRL(transactionData.valor)}\n\n` +
        `🏷️ **Em qual tipo devo categorizar?**\n` +
        `Escolha uma das sugestões abaixo:`,
        'assistant',
        options
    );
}

    // ========== SELECIONAR TIPO DE TRANSAÇÃO ==========
selectTypeOption(index) {
    if (!this.waitingForTypeSelection || !this.pendingTransaction) return;

    let tiposDisponiveis = [];
    const trans = this.pendingTransaction;
    
    if (trans.categoria === 'entrada') {
        tiposDisponiveis = ['Salário', 'Renda Extra', 'Freelance', 'Investimentos', 'Presente', 'Venda', 'Outros Recebimentos'];
    } else if (trans.categoria === 'saida' || trans.categoria === 'saida_credito') {
        tiposDisponiveis = [
            'Mercado', 'Farmácia', 'Eletrônico', 'Roupas', 'Assinaturas', 
            'Beleza', 'Presente', 'Conta fixa', 'Cartão', 'Academia', 
            'Lazer', 'Transporte', 'Shopee', 'Mercado Livre', 'Ifood', 
            'Amazon', 'Restaurante', 'Saúde', 'Educação', 'Casa', 'Outros'
        ];
    } else if (trans.categoria === 'reserva') {
        tiposDisponiveis = ['Emergência', 'Viagem', 'Investimento', 'Objetivo', 'Outro'];
    }

    const tipoSelecionado = tiposDisponiveis[index];
    trans.tipo = tipoSelecionado;
    
    // Extrair descrição com o tipo correto
    trans.descricao = DetectorInteligente.extrairDescricao(
        trans.descricao, 
        trans.descricao.toLowerCase(), 
        tipoSelecionado
    );

    this.addMessage(`✅ Tipo selecionado: **${tipoSelecionado}**`, 'user');
    
    this.waitingForTypeSelection = false;
    
    this.showTypingIndicator();
    setTimeout(() => {
        this.hideTypingIndicator();
        
        // Se for crédito, pedir cartão
        if (trans.categoria === 'saida_credito') {
            this.handleCreditTransaction(trans);
        } else {
            this.executeTransaction(trans);
        }
    }, 600);
}

    // ========== GERAR CONFIRMAÇÃO ==========
    gerarConfirmacao(transData) {
        const categoriaEmoji = {
            'entrada': '💰',
            'saida': '💸',
            'reserva': '🎯',
            'saida_credito': '💳'
        };

        const categoriaLabel = {
            'entrada': 'Entrada',
            'saida': 'Saída',
            'reserva': 'Reserva',
            'saida_credito': 'Saída no Crédito'
        };

        let msg = `${categoriaEmoji[transData.categoria]} **Entendi! Vou lançar:**\n\n`;
        msg += `📋 Categoria: ${categoriaLabel[transData.categoria]}\n`;
        msg += `🏷️ Tipo: ${transData.tipo}\n`;
        msg += `📝 Descrição: ${transData.descricao}\n`;
        msg += `💵 Valor: ${formatBRL(transData.valor)}`;

        if (transData.parcelas > 1) {
            msg += `\n📊 Parcelas: ${transData.parcelas}x de ${formatBRL(transData.valor / transData.parcelas)}`;
        }

        return msg;
    }

    // ========== EXTRAIR DADOS DA TRANSAÇÃO ==========
   extractTransactionData(originalMsg, msgLower, msgCorrigida) {
    let categoria = '';
    let tipo = null;
    let descricao = '';
    let valor = 0;
    let parcelas = 1;

    // Detectar categoria - ORDEM IMPORTANTE!
    if (msgLower.match(/recebi|receber|ganhei|ganhar|salario|salário|renda/)) {
        categoria = 'entrada';
    } else if (msgLower.match(/guardei|guardar|reservei|reservar|economizei|economizar/)) {
        categoria = 'reserva';
    } else if (msgLower.match(/(\d+)\s*x|em\s*(\d+)|(\d+)\s*vezes/) || msgLower.match(/cartao|cartão|credito|crédito|parcel/)) {
        // Se tem parcelas OU menciona cartão/crédito = saída no crédito
        categoria = 'saida_credito';
    } else if (msgLower.match(/gastei|gastar|comprei|comprar|paguei|pagar|tomei/)) {
        categoria = 'saida';
    }

    // Extrair valor
    const valorMatch = msgCorrigida.match(/(\d+(?:[.,]\d+)?)\s*(?:reais?|r\$|R\$)?/);
    if (valorMatch) {
        valor = parseFloat(valorMatch[1].replace(',', '.'));
    }

    if (valor === 0) return null;

    // Extrair parcelas
    const parcelasMatch = msgLower.match(/(\d+)\s*x|em\s*(\d+)|(\d+)\s*vezes/);
    if (parcelasMatch) {
        parcelas = parseInt(parcelasMatch[1] || parcelasMatch[2] || parcelasMatch[3]);
    }

    // Detectar tipo com biblioteca inteligente
    tipo = DetectorInteligente.detectarTipo(msgCorrigida, categoria);

    // Se não detectou tipo, retorna com tipo null para tratamento posterior
    if (!tipo) {
        return {
            categoria,
            tipo: null,
            descricao: originalMsg,
            valor,
            parcelas,
            needsTypeSelection: true
        };
    }

    // Extrair descrição inteligente
    descricao = DetectorInteligente.extrairDescricao(originalMsg, msgLower, tipo);

    return {
        categoria,
        tipo,
        descricao,
        valor,
        parcelas,
        needsTypeSelection: false
    };
}

    // ========== PROCESSAR TRANSAÇÃO NO CRÉDITO ==========
    handleCreditTransaction(transactionData) {
        if (!cartoesCredito || cartoesCredito.length === 0) {
            this.addMessage('❌ **Ops!** Você não tem nenhum cartão cadastrado.\n\nPor favor, cadastre um cartão no menu **Cartões** antes de fazer lançamentos no crédito. 💳', 'assistant');
            return;
        }

        if (cartoesCredito.length === 1) {
            transactionData.cartaoId = cartoesCredito[0].id;
            this.addMessage(`✅ Usando o cartão: **${cartoesCredito[0].nome}**`, 'assistant');
            
            setTimeout(() => {
                this.executeTransaction(transactionData);
            }, 500);
            return;
        }

        this.waitingForCardSelection = true;
        this.pendingTransaction = transactionData;

        const options = cartoesCredito.map(cartao => ({
            text: `${cartao.nome} - Limite: ${formatBRL(cartao.limite)}`,
            cartaoId: cartao.id
        }));

        this.addMessage('💳 **Qual cartão deseja usar?**\n\nSelecione uma das opções abaixo:', 'assistant', options);
    }

   // ========== EXECUTAR TRANSAÇÃO ==========
    executeTransaction(transData) {
        try {
            const { data, hora } = agoraDataHora();
            const dataISO = isoDate();

            if (transData.categoria === 'saida_credito') {
                const cartao = cartoesCredito.find(c => c.id === transData.cartaoId);
                if (!cartao) {
                    this.addMessage('❌ Erro: Cartão não encontrado.', 'assistant');
                    return;
                }

                const valorParcela = Number((transData.valor / transData.parcelas).toFixed(2));
                
                // Calcular data da primeira fatura (mesmo sistema do dashboard.js)
                let hoje = new Date();
                let anoAtual = hoje.getFullYear();
                let mesAtual = hoje.getMonth() + 1;
                let diaHoje = hoje.getDate();
                let diaFatura = cartao.vencimentoDia || 10;
                
                let proxMes, proxAno;
                if (diaHoje >= diaFatura) {
                    proxMes = mesAtual + 1;
                    proxAno = anoAtual;
                    if (proxMes > 12) { 
                        proxMes = 1; 
                        proxAno++; 
                    }
                } else {
                    proxMes = mesAtual;
                    proxAno = anoAtual;
                }
                
                let dataFaturaISO = `${proxAno}-${String(proxMes).padStart(2, '0')}-${String(diaFatura).padStart(2, '0')}`;
                
                // Criar conta fixa (igual ao dashboard.js faz)
                contasFixas.push({
                    id: nextContaFixaId++,
                    descricao: `Fatura do cartão ${cartao.nomeBanco || cartao.nome}`,
                    valor: valorParcela,
                    vencimento: dataFaturaISO,
                    pago: false,
                    cartaoId: cartao.id,
                    totalParcelas: transData.parcelas,
                    parcelaAtual: 1
                });
                
                // Registrar transação da compra no crédito para aparecer nos relatórios
                const transCredito = {
                    id: nextTransId++,
                    categoria: 'saida_credito',
                    tipo: transData.tipo,
                    descricao: transData.descricao,
                    valor: transData.valor,
                    data: data, // Data formatada BR
                    hora: hora,
                    mes: yearMonthKey(),
                    cartaoId: cartao.id,
                    parcelas: transData.parcelas
                };
                transacoes.push(transCredito);

                // Atualizar valor usado no cartão
                cartao.usado = (cartao.usado || 0) + transData.valor;
                
                this.addMessage(`✅ **Lançamento realizado com sucesso!** 🎉\n\n💳 **Cartão:** ${cartao.nomeBanco || cartao.nome}\n📝 **Descrição:** ${transData.descricao}\n💰 **Valor Total:** ${formatBRL(transData.valor)}\n📊 **Parcelas:** ${transData.parcelas}x de ${formatBRL(valorParcela)}\n🏷️ **Tipo:** ${transData.tipo}\n\n🔥 Primeira parcela já está na fatura atual, e as outras ${transData.parcelas - 1} eu organizei nos próximos meses. Tá tudo ajeitadinho! 💳`, 'assistant');

            } else {
                // TRANSAÇÕES NORMAIS (entrada, saída, reserva)
                const trans = {
                id: nextTransId++,
                categoria: transData.categoria,
                tipo: transData.tipo,
                descricao: transData.descricao,
                valor: transData.valor,
                data: data,
                hora: hora,
                mes: yearMonthKey()
};

                transacoes.push(trans);

                const categoriaEmoji = {
                    'entrada': '💰',
                    'saida': '💸',
                    'reserva': '🎯'
                };

                const categoriaLabel = {
                    'entrada': 'Entrada',
                    'saida': 'Saída',
                    'reserva': 'Reserva'
                };

                const transactionId = trans.id;
                const successMsg = `✅ **Lançamento realizado com sucesso!** 🎉\n\n${categoriaEmoji[transData.categoria]} **${categoriaLabel[transData.categoria]}**\n📝 **Descrição:** ${transData.descricao}\n💰 **Valor:** ${formatBRL(transData.valor)}\n🏷️ **Tipo:** ${transData.tipo}`;

                this.addMessage(successMsg + this.createEditButton(transactionId), 'assistant');
            }

            salvarDados();
            
            if (typeof atualizarTudo === 'function') {
                atualizarTudo();
            }

            setTimeout(() => {
                this.darFeedbackPosTransacao(transData);
            }, 1500);

        } catch (error) {
            console.error('Erro ao executar transação:', error);
            this.addMessage('❌ Ops! Ocorreu um erro ao processar sua transação.\n\nPor favor, tente novamente ou use o lançamento manual no menu **Transações**. 🔧', 'assistant');
        }
    }

        // ========== CRIAR BOTÃO DE EDIÇÃO ==========
createEditButton(transactionId) {
    return `
        <div class="chat-edit-transaction">
            <button class="chat-edit-btn" onclick="chatAssistant.openEditTransaction(${transactionId})">
                <i class="fas fa-edit"></i> Editar
            </button>
        </div>
    `;
}

// ========== ABRIR EDITOR DE TRANSAÇÃO ==========
openEditTransaction(transactionId) {
    const trans = transacoes.find(t => t.id === transactionId);
    if (!trans) {
        this.addMessage('❌ Transação não encontrada.', 'assistant');
        return;
    }

    this.pendingEditTransaction = trans;
    
    const categoriaOptions = `
        <option value="entrada" ${trans.categoria === 'entrada' ? 'selected' : ''}>💰 Entrada</option>
        <option value="saida" ${trans.categoria === 'saida' ? 'selected' : ''}>💸 Saída</option>
        <option value="reserva" ${trans.categoria === 'reserva' ? 'selected' : ''}>🎯 Reserva</option>
        <option value="saida_credito" ${trans.categoria === 'saida_credito' ? 'selected' : ''}>💳 Saída no Crédito</option>
    `;

    const editForm = `
        <div class="chat-edit-form">
            <h4>✏️ Editar Transação</h4>
            
            <label>Categoria:</label>
            <select id="chatEditCategoria" class="chat-edit-input">
                ${categoriaOptions}
            </select>
            
            <label>Descrição:</label>
            <input type="text" id="chatEditDescricao" class="chat-edit-input" value="${trans.descricao}">
            
            <label>Valor (R$):</label>
            <input type="number" id="chatEditValor" class="chat-edit-input" value="${trans.valor}" step="0.01" min="0">
            
            <div id="chatEditCreditFields" style="display: ${trans.categoria === 'saida_credito' ? 'block' : 'none'};">
                <label>Parcelas:</label>
                <select id="chatEditParcelas" class="chat-edit-input">
                    ${Array.from({length: 24}, (_, i) => i + 1).map(n => 
                        `<option value="${n}" ${trans.parcelas === n ? 'selected' : ''}>${n}x</option>`
                    ).join('')}
                </select>
            </div>
            
            <div class="chat-edit-buttons">
                <button class="chat-edit-save" onclick="chatAssistant.saveEditedTransaction()">
                    <i class="fas fa-check"></i> Salvar
                </button>
                <button class="chat-edit-cancel" onclick="chatAssistant.cancelEditTransaction()">
                    <i class="fas fa-times"></i> Cancelar
                </button>
            </div>
        </div>
    `;

    this.addMessage(editForm, 'assistant');
    
    // Adicionar listener para mostrar/ocultar campo de parcelas
    setTimeout(() => {
        const categoriaSelect = document.getElementById('chatEditCategoria');
        const creditFields = document.getElementById('chatEditCreditFields');
        
        if (categoriaSelect && creditFields) {
            categoriaSelect.addEventListener('change', function() {
                creditFields.style.display = this.value === 'saida_credito' ? 'block' : 'none';
            });
        }
    }, 100);
}

        // ========== SALVAR TRANSAÇÃO EDITADA ==========
        saveEditedTransaction() {
            if (!this.pendingEditTransaction) return;

            const categoria = document.getElementById('chatEditCategoria')?.value;
            const descricao = document.getElementById('chatEditDescricao')?.value.trim();
            const valorStr = document.getElementById('chatEditValor')?.value;
            const parcelas = parseInt(document.getElementById('chatEditParcelas')?.value || '1');

            if (!categoria || !descricao || !valorStr) {
                this.addMessage('❌ Por favor, preencha todos os campos.', 'assistant');
                return;
            }

            const valor = parseFloat(valorStr);
            const transOriginal = this.pendingEditTransaction;

            // Remover transação antiga
            transacoes = transacoes.filter(t => t.id !== transOriginal.id);

            // Se era crédito, limpar dados do cartão
            if (transOriginal.categoria === 'saida_credito' && transOriginal.cartaoId) {
                const cartao = cartoesCredito.find(c => c.id === transOriginal.cartaoId);
                if (cartao) {
                    cartao.usado = Math.max(0, (cartao.usado || 0) - transOriginal.valor);
                }
                
                // Remover conta fixa associada se houver
                contasFixas = contasFixas.filter(cf => cf.cartaoId !== transOriginal.cartaoId || cf.descricao !== transOriginal.descricao);
            }

            this.addMessage('✅ Alterações salvas! Processando...', 'assistant');

            // Se nova categoria for crédito, pedir cartão
            if (categoria === 'saida_credito') {
                const newTransData = {
                    categoria: 'saida_credito',
                    tipo: transOriginal.tipo,
                    descricao: descricao,
                    valor: valor,
                    parcelas: parcelas
                };

                this.handleCreditTransaction(newTransData);
            } else {
                // Criar nova transação
                const { data, hora } = agoraDataHora();
                const trans = {
                    id: nextTransId++,
                    categoria: categoria,
                    tipo: transOriginal.tipo,
                    descricao: descricao,
                    valor: valor,
                    data: isoDate(),
                    hora: hora,
                    mes: yearMonthKey()
                };

                transacoes.push(trans);
                salvarDados();
                
                if (typeof atualizarTudo === 'function') {
                    atualizarTudo();
                }

                this.addMessage(`✅ **Transação atualizada com sucesso!** 🎉\n\n📋 **Categoria:** ${categoria}\n📝 **Descrição:** ${descricao}\n💰 **Valor:** ${formatBRL(valor)}`, 'assistant');
            }

            this.pendingEditTransaction = null;
        }

        // ========== CANCELAR EDIÇÃO ==========
        cancelEditTransaction() {
            this.pendingEditTransaction = null;
            this.addMessage('Edição cancelada. Como posso te ajudar?', 'assistant');
        }

    // ========== DAR FEEDBACK PÓS-TRANSAÇÃO ==========
    darFeedbackPosTransacao(transData) {
        const entradas = transacoes.filter(t => t.categoria === 'entrada').reduce((sum, t) => sum + t.valor, 0);
        const saidas = transacoes.filter(t => t.categoria === 'saida' || t.categoria === 'saida_credito').reduce((sum, t) => sum + t.valor, 0);
        const saldo = entradas - saidas;

        if (transData.categoria === 'entrada') {
            const mensagens = [
                '💡 **Dica:** Que tal guardar 10% dessa entrada em uma reserva de emergência?',
                '🎯 Ótimo! Considere destinar parte dessa renda para seus objetivos futuros.',
                '📊 Sugestão: Revise seus gastos fixos e veja se pode economizar mais este mês.'
            ];
            this.addMessage(mensagens[Math.floor(Math.random() * mensagens.length)], 'assistant');
        } else if (transData.categoria === 'saida' || transData.categoria === 'saida_credito') {
            if (saldo < 0) {
                this.addMessage('⚠️ **Atenção:** Seu saldo ficou negativo após este gasto. Evite novos gastos não essenciais.', 'assistant');
            } else if (saidas > entradas * 0.8) {
                this.addMessage('📊 Você já gastou mais de 80% da sua renda este mês. Cuidado com novos gastos!', 'assistant');
            } else {
                this.addMessage('👍 Lançamento registrado! Continue acompanhando seus gastos para manter o controle financeiro.', 'assistant');
            }
        } else if (transData.categoria === 'reserva') {
            this.addMessage('🎉 **Parabéns!** Guardar dinheiro é um hábito excelente. Continue assim e você alcançará seus objetivos! 💪', 'assistant');
        }
    }

    // ========== PROCESSAR CONSULTAS ==========
    handleQuery(msgLower) {
        if (msgLower.match(/saldo|quanto tenho|quanto tem|quanto ta|quanto está/)) {
            this.querySaldo();
        } else if (msgLower.match(/gasto|gastei quanto|quanto gastei|onde gastei/)) {
            if (msgLower.match(/hoje/)) {
                this.queryGastos('hoje');
            } else if (msgLower.match(/semana/)) {
                this.queryGastos('semana');
            } else if (msgLower.match(/mes|mês/)) {
                this.queryGastos('mes');
            } else {
                this.queryGastos('mes');
            }
        } else if (msgLower.match(/reserva|quanto guardei|quanto reservei/)) {
            this.queryReservas();
        } else if (msgLower.match(/relatorio|relatório|analise|análise/)) {
            this.gerarRelatorioCompleto();
        } else {
            this.addMessage('Posso te ajudar com:\n\n📊 **Consultar seu saldo**\n💸 **Ver seus gastos** (hoje, semana, mês)\n🎯 **Verificar suas reservas**\n📈 **Gerar relatório completo**\n\nO que você gostaria de saber?', 'assistant');
        }
    }

    // ========== CONSULTAR SALDO ==========
    querySaldo() {
        const entradas = transacoes.filter(t => t.categoria === 'entrada').reduce((sum, t) => sum + t.valor, 0);
        const saidas = transacoes.filter(t => t.categoria === 'saida' || t.categoria === 'saida_credito').reduce((sum, t) => sum + t.valor, 0);
        const reservas = transacoes.filter(t => t.categoria === 'reserva').reduce((sum, t) => sum + t.valor, 0);
        const saldo = entradas - saidas;

        const saldoEmoji = saldo >= 0 ? '💰' : '⚠️';
        const saldoStatus = saldo >= 0 ? 'positivo' : 'negativo';

        this.addMessage(`${saldoEmoji} **Seu Saldo Atual**\n\n💵 **Entradas:** ${formatBRL(entradas)}\n💸 **Saídas:** ${formatBRL(saidas)}\n🎯 **Reservas:** ${formatBRL(reservas)}\n\n📊 **Saldo:** ${formatBRL(saldo)}\n\n**Status:** Saldo ${saldoStatus}`, 'assistant');

        setTimeout(() => {
            const sugestoes = AnalisadorAvancado.sugerirAcoes(transacoes, saldo);
            if (sugestoes.length > 0) {
                this.addMessage(sugestoes[0], 'assistant');
            }
        }, 1000);
    }

    // ========== CONSULTAR GASTOS ==========
    queryGastos(periodo) {
        const hoje = new Date();
        let transacoesFiltradas = [];
        let periodoLabel = '';

        if (periodo === 'hoje') {
            const hojeDateStr = isoDate();
            transacoesFiltradas = transacoes.filter(t => 
                (t.categoria === 'saida' || t.categoria === 'saida_credito') && 
                t.data === hojeDateStr
            );
            periodoLabel = 'hoje';
        } else if (periodo === 'semana') {
            const umaSemanaAtras = new Date(hoje);
            umaSemanaAtras.setDate(hoje.getDate() - 7);
            transacoesFiltradas = transacoes.filter(t => {
                if (t.categoria !== 'saida' && t.categoria !== 'saida_credito') return false;
                const transDate = new Date(t.data);
                return transDate >= umaSemanaAtras && transDate <= hoje;
            });
            periodoLabel = 'nos últimos 7 dias';
        } else {
            const mesAtual = yearMonthKey();
            transacoesFiltradas = transacoes.filter(t => 
                (t.categoria === 'saida' || t.categoria === 'saida_credito') && 
                t.mes === mesAtual
            );
            periodoLabel = 'neste mês';
        }

        const totalGastos = transacoesFiltradas.reduce((sum, t) => sum + t.valor, 0);

        if (transacoesFiltradas.length === 0) {
            this.addMessage(`📊 **Gastos ${periodoLabel}**\n\nVocê não teve gastos ${periodoLabel}. Parabéns pela economia! 🎉`, 'assistant');
            return;
        }

        const gastosPorTipo = {};
        transacoesFiltradas.forEach(t => {
            if (!gastosPorTipo[t.tipo]) {
                gastosPorTipo[t.tipo] = 0;
            }
            gastosPorTipo[t.tipo] += t.valor;
        });

        let detalhes = '';
        Object.entries(gastosPorTipo)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .forEach(([tipo, valor]) => {
                const percentual = ((valor / totalGastos) * 100).toFixed(1);
                detalhes += `\n• **${tipo}:** ${formatBRL(valor)} (${percentual}%)`;
            });

        this.addMessage(`📊 **Gastos ${periodoLabel}**\n\n💸 **Total:** ${formatBRL(totalGastos)}\n📝 **Transações:** ${transacoesFiltradas.length}\n\n**Principais categorias:**${detalhes}`, 'assistant');

        setTimeout(() => {
            this.analyzeSpending(totalGastos, periodo, transacoesFiltradas);
        }, 1200);
    }

    // ========== ANALISAR GASTOS ==========
    analyzeSpending(totalGastos, periodo, transacoesFiltradas) {
        const entradas = transacoes.filter(t => t.categoria === 'entrada').reduce((sum, t) => sum + t.valor, 0);
        const percentualGasto = entradas > 0 ? (totalGastos / entradas) * 100 : 0;

        let mensagem = '';

        if (periodo === 'mes') {
            if (percentualGasto > 90) {
                mensagem = '🚨 **Alerta crítico!** Você está gastando mais de 90% da sua renda. É urgente revisar seus gastos e cortar despesas não essenciais.';
            } else if (percentualGasto > 80) {
                mensagem = '⚠️ **Atenção!** Você está gastando mais de 80% da sua renda. Tente economizar mais para criar uma reserva de segurança.';
            } else if (percentualGasto > 60) {
                mensagem = '💡 Seus gastos estão um pouco altos (${percentualGasto.toFixed(1)}% da renda). Revise gastos não essenciais e tente economizar mais.';
            } else if (percentualGasto > 40) {
                mensagem = '👍 **Bom trabalho!** Seus gastos estão equilibrados. Continue assim e considere aumentar suas reservas.';
            } else {
                mensagem = '🎉 **Excelente!** Você está gastando pouco e economizando bem. Continue assim e invista seu dinheiro!';
            }
        } else {
            const categoriaTop = transacoesFiltradas.reduce((acc, t) => {
                acc[t.tipo] = (acc[t.tipo] || 0) + t.valor;
                return acc;
            }, {});

            const topCategoria = Object.entries(categoriaTop).sort((a, b) => b[1] - a[1])[0];
            if (topCategoria) {
                mensagem = `💡 Sua categoria com mais gastos ${periodo === 'hoje' ? 'hoje' : 'na semana'} foi: **${topCategoria[0]}** (${formatBRL(topCategoria[1])})`;
            }
        }

        if (mensagem) {
            this.addMessage(mensagem, 'assistant');
        }
    }

    // ========== CONSULTAR RESERVAS ==========
    queryReservas() {
        const totalReservas = transacoes.filter(t => t.categoria === 'reserva').reduce((sum, t) => sum + t.valor, 0);

        if (totalReservas === 0) {
            this.addMessage('🎯 **Suas Reservas**\n\nVocê ainda não tem reservas cadastradas.\n\n💡 **Dica:** Comece guardando pelo menos 10% da sua renda mensal para criar uma reserva de emergência! É essencial para sua segurança financeira.', 'assistant');
            return;
        }

        const reservasPorTipo = {};
        transacoes.filter(t => t.categoria === 'reserva').forEach(t => {
            if (!reservasPorTipo[t.tipo]) {
                reservasPorTipo[t.tipo] = 0;
            }
            reservasPorTipo[t.tipo] += t.valor;
        });

        let detalhes = '';
        Object.entries(reservasPorTipo).forEach(([tipo, valor]) => {
            const percentual = ((valor / totalReservas) * 100).toFixed(1);
            detalhes += `\n• **${tipo}:** ${formatBRL(valor)} (${percentual}%)`;
        });

        this.addMessage(`🎯 **Suas Reservas**\n\n💰 **Total:** ${formatBRL(totalReservas)}\n\n**Distribuição:**${detalhes}\n\n🎉 **Parabéns por guardar dinheiro!** Continue assim e você alcançará seus objetivos! 💪`, 'assistant');

        setTimeout(() => {
            const entradas = transacoes.filter(t => t.categoria === 'entrada').reduce((sum, t) => sum + t.valor, 0);
            if (entradas > 0) {
                const percentualReserva = (totalReservas / entradas) * 100;
                let feedback = '';

                if (percentualReserva >= 30) {
                    feedback = `🌟 **Incrível!** Suas reservas representam ${percentualReserva.toFixed(1)}% da sua renda. Você está no caminho certo para a independência financeira!`;
                } else if (percentualReserva >= 20) {
                    feedback = `🎯 **Excelente!** Suas reservas representam ${percentualReserva.toFixed(1)}% da sua renda. Continue assim!`;
                } else if (percentualReserva >= 10) {
                    feedback = `👍 Suas reservas representam ${percentualReserva.toFixed(1)}% da sua renda. Tente aumentar para 20%!`;
                } else {
                    feedback = `📊 Suas reservas representam ${percentualReserva.toFixed(1)}% da sua renda. O ideal é guardar pelo menos 10-20%!`;
                }

                this.addMessage(feedback, 'assistant');
            }
        }, 1200);
    }

    // ========== GERAR RELATÓRIO COMPLETO ==========
    gerarRelatorioCompleto() {
        this.addMessage('📊 **Gerando relatório completo...**', 'assistant');

        setTimeout(() => {
            const entradas = transacoes.filter(t => t.categoria === 'entrada').reduce((sum, t) => sum + t.valor, 0);
            const saidas = transacoes.filter(t => t.categoria === 'saida' || t.categoria === 'saida_credito').reduce((sum, t) => sum + t.valor, 0);
            const reservas = transacoes.filter(t => t.categoria === 'reserva').reduce((sum, t) => sum + t.valor, 0);
            const saldo = entradas - saidas;

            const insights = AnalisadorAvancado.gerarInsights(transacoes, entradas, saidas, reservas);
            
            let relatorio = '📈 **Relatório Financeiro Completo**\n\n';
            relatorio += '**💰 Resumo Geral:**\n';
            relatorio += `• Entradas: ${formatBRL(entradas)}\n`;
            relatorio += `• Saídas: ${formatBRL(saidas)}\n`;
            relatorio += `• Reservas: ${formatBRL(reservas)}\n`;
            relatorio += `• Saldo: ${formatBRL(saldo)}\n\n`;
            relatorio += '**📊 Análises e Insights:**\n';
            insights.forEach(insight => {
                relatorio += `\n${insight}`;
            });

            this.addMessage(relatorio, 'assistant');
        }, 1500);
    }

    // ========== PROCESSAR PEDIDOS DE DICA ==========
    handleAdviceRequest(msgLower) {
        const dicas = [
            {
                titulo: '💰 Regra 50-30-20',
                texto: 'Divida sua renda em: **50%** para necessidades essenciais, **30%** para desejos pessoais e **20%** para poupança e investimentos. Essa é uma das regras mais eficazes para organizar suas finanças!'
            },
            {
                titulo: '🎯 Reserva de Emergência',
                texto: 'Mantenha de **3 a 6 meses** de suas despesas em uma reserva de emergência. Isso te protege contra imprevistos como desemprego, problemas de saúde ou emergências familiares.'
            },
            {
                titulo: '📊 Acompanhe seus gastos',
                texto: 'Registre **todas** as suas transações diariamente. O que é medido pode ser melhorado! Use este chat para lançar rapidamente seus gastos e mantenha tudo organizado.'
            },
            {
                titulo: '🛒 Evite compras por impulso',
                texto: 'Espere **24 horas** antes de fazer compras não planejadas acima de R$ 100. Isso reduz drasticamente gastos desnecessários e te ajuda a pensar melhor sobre suas prioridades.'
            },
            {
                titulo: '💳 Cuidado com o crédito',
                texto: 'Use o cartão de crédito com responsabilidade. Pague **sempre** o valor total da fatura para evitar juros altíssimos. Lembre-se: crédito não é dinheiro extra!'
            },
            {
                titulo: '📈 Invista em você',
                texto: 'Invista em educação e desenvolvimento pessoal. É o melhor investimento que você pode fazer! Cursos, livros e habilidades novas aumentam seu potencial de ganhos.'
            },
            {
                titulo: '🔄 Automatize suas economias',
                texto: 'Configure transferências automáticas para sua poupança **logo após** receber o salário. Assim você "paga a si mesmo primeiro" e garante que vai economizar.'
            },
            {
                titulo: '🎁 Negocie sempre',
                texto: 'Pesquise preços e negocie descontos sempre que possível. Pequenas economias de 5-10% se acumulam ao longo do tempo e fazem grande diferença!'
            },
            {
                titulo: '🍽️ Cozinhe em casa',
                texto: 'Cozinhar em casa pode economizar até **70%** comparado a comer fora. Planeje suas refeições, faça compras no mercado e prepare marmitas para a semana.'
            },
            {
                titulo: '🚗 Reavalie transportes',
                texto: 'Considere alternativas mais econômicas: transporte público, carona solidária, bicicleta ou até trabalho remoto. Transporte é uma das maiores despesas mensais!'
            }
        ];

        const dicaAleatoria = dicas[Math.floor(Math.random() * dicas.length)];
        this.addMessage(`${dicaAleatoria.titulo}\n\n${dicaAleatoria.texto}`, 'assistant');

        setTimeout(() => {
            this.givePersonalizedAdvice();
        }, 2000);
    }

    // ========== DAR DICA PERSONALIZADA ==========
    givePersonalizedAdvice() {
        const entradas = transacoes.filter(t => t.categoria === 'entrada').reduce((sum, t) => sum + t.valor, 0);
        const saidas = transacoes.filter(t => t.categoria === 'saida' || t.categoria === 'saida_credito').reduce((sum, t) => sum + t.valor, 0);
        const reservas = transacoes.filter(t => t.categoria === 'reserva').reduce((sum, t) => sum + t.valor, 0);
        const saldo = entradas - saidas;

        const insights = AnalisadorAvancado.gerarInsights(transacoes, entradas, saidas, reservas);
        if (insights.length > 0) {
            const insightAleatorio = insights[Math.floor(Math.random() * insights.length)];
            this.addMessage(`💡 **Insight personalizado:**\n\n${insightAleatorio}`, 'assistant');
        }
    }

    // ========== PROCESSAR SAUDAÇÕES ==========
    handleGreeting(msgLower) {
        const hora = new Date().getHours();
        let saudacao = 'Olá';
        if (hora >= 5 && hora < 12) saudacao = 'Bom dia';
        else if (hora >= 12 && hora < 18) saudacao = 'Boa tarde';
        else saudacao = 'Boa noite';

        const nome = perfilAtivo?.nome || 'amigo(a)';
        
        const respostas = [
            `${saudacao}, ${nome}! 😊 Como posso te ajudar hoje?`,
            `${saudacao}! Tudo bem? Estou aqui para te ajudar com suas finanças! 💰`,
            `Oi, ${nome}! ${saudacao}! Pronto para organizar suas finanças? 📊`,
            `${saudacao}! Que bom te ver por aqui! Como posso ajudar? ✨`
        ];

        this.addMessage(respostas[Math.floor(Math.random() * respostas.length)], 'assistant');
    }

    // ========== PROCESSAR AGRADECIMENTOS ==========
    handleThanking() {
        const respostas = [
            'Por nada! Estou aqui sempre que precisar! 😊',
            'Disponha! É um prazer te ajudar! 💚',
            'Sempre às ordens! Conte comigo! ✨',
            'Fico feliz em ajudar! Até a próxima! 👋',
            'De nada! Continue cuidando bem das suas finanças! 💰'
        ];

        this.addMessage(respostas[Math.floor(Math.random() * respostas.length)], 'assistant');
    }

    // ========== PROCESSAR MENSAGEM GERAL ==========
    handleGeneralMessage(msgLower) {
        const respostasGenericas = [
            'Hmm, não entendi completamente. 🤔\n\nPosso te ajudar com:\n\n💰 **Lançamentos** de transações\n📊 **Consultas** de saldo e gastos\n💡 **Dicas** financeiras personalizadas\n\nO que você precisa?',
            'Desculpe, não compreendi. 😅\n\nTente perguntar sobre:\n\n• Seu saldo atual\n• Gastos do mês\n• Fazer um lançamento\n• Dicas de economia',
            'Não tenho certeza do que você quer dizer. 🤷‍♀️\n\nPosso te ajudar com:\n\n📝 Registrar transações\n📈 Ver relatórios\n💡 Dar dicas financeiras\n\nComo posso ajudar?'
        ];

        const resposta = respostasGenericas[Math.floor(Math.random() * respostasGenericas.length)];
        this.addMessage(resposta, 'assistant');
    }

    // ========== SALVAR MENSAGENS ==========
    saveMessages() {
        if (this.perfilAtivo) { // ✅ USA this.perfilAtivo
            const chave = `granaevo_chat_${this.perfilAtivo.id}`;
            localStorage.setItem(chave, JSON.stringify(this.messages));
        }
    }

    // ========== CARREGAR MENSAGENS ==========
    loadMessages() {
        if (perfilAtivo) {
            const chave = `granaevo_chat_${perfilAtivo.id}`;
            const saved = localStorage.getItem(chave);
            if (saved) {
                try {
                    this.messages = JSON.parse(saved);
                    this.renderMessages();
                } catch (e) {
                    console.error('Erro ao carregar mensagens', e);
                }
            }
        }
    }

    // ========== RENDERIZAR MENSAGENS ==========
    renderMessages() {
        const body = document.getElementById('chatAssistantBody');
        body.innerHTML = '';
        this.messages.forEach(msg => {
            const messageDiv = document.createElement('div');
            messageDiv.className = `chat-message ${msg.sender}`;
            const avatarContent = this.getAvatarHtml(msg.sender === 'user');
            messageDiv.innerHTML = `
                <div class="chat-message-avatar">${avatarContent}</div>
                <div>
                    <div class="chat-message-content">${this.formatMessage(msg.text)}</div>
                </div>
            `;
            body.appendChild(messageDiv);
        });
        this.scrollToBottom();
    }
}

// ========== INICIALIZAÇÃO GLOBAL ==========
let chatAssistant;

window.addEventListener('load', () => {
    setTimeout(() => {
        chatAssistant = new ChatAssistant();
        console.log('✅ Chat Assistant Ge inicializado com sucesso!');
    }, 1000);
});