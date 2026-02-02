async function verificarLogin() {
    const authLoading = document.getElementById('authLoading');
    const protectedContent = document.querySelector('[data-protected-content]');

    try {
        console.log('🔐 [VERIFICAR LOGIN] ===== INICIANDO =====');
        
        if (authLoading) authLoading.style.display = 'flex';
        if (protectedContent) protectedContent.style.display = 'none';

        // 1️⃣ VERIFICAR SESSÃO
        console.log('1️⃣ [VERIFICAR LOGIN] Verificando sessão...');
        const { data: { session }, error: sessionError } = await supabase.auth.getSession();

        if (sessionError || !session) {
            console.log('❌ [VERIFICAR LOGIN] Sessão inválida. Redirecionando...');
            window.location.href = 'login.html';
            return;
        }

        console.log('✅ [VERIFICAR LOGIN] Sessão válida:', session.user.email);

        // 2️⃣ VERIFICAR ASSINATURA
        console.log('2️⃣ [VERIFICAR LOGIN] Verificando assinatura...');
        const { data: subscription, error: subError } = await supabase
            .from('subscriptions')
            .select('plans(name)')
            .eq('user_id', session.user.id)
            .eq('payment_status', 'approved')
            .single();

        if (subError || !subscription) {
            console.log('❌ [VERIFICAR LOGIN] Assinatura inválida. Redirecionando...');
            window.location.href = 'planos.html';
            return;
        }

        console.log('✅ [VERIFICAR LOGIN] Assinatura encontrada:', subscription.plans.name);

        // 3️⃣ INICIALIZAR USUÁRIO
        console.log('3️⃣ [VERIFICAR LOGIN] Inicializando usuário...');
        usuarioLogado = {
            userId: session.user.id,
            nome: session.user.user_metadata?.name || session.user.email.split('@')[0],
            email: session.user.email,
            plano: subscription.plans.name,
            perfis: []
        };

        console.log('✅ [VERIFICAR LOGIN] Usuário inicializado:', {
            userId: usuarioLogado.userId,
            email: usuarioLogado.email,
            plano: usuarioLogado.plano
        });

        // 4️⃣ ⚠️ CRÍTICO: INICIALIZAR DATAMANAGER E AGUARDAR
        console.log('4️⃣ [VERIFICAR LOGIN] Inicializando DataManager...');
        await dataManager.initialize(usuarioLogado.userId, usuarioLogado.email);
        
        // ✅ VERIFICAR SE INICIALIZOU CORRETAMENTE
        if (!dataManager.userId) {
            throw new Error('DataManager não inicializou o userId!');
        }
        
        console.log('✅ [VERIFICAR LOGIN] DataManager inicializado');
        console.log('🔑 [VERIFICAR LOGIN] DataManager.userId:', dataManager.userId);

        // 5️⃣ CARREGAR PERFIS
        console.log('5️⃣ [VERIFICAR LOGIN] Carregando perfis...');
        const resultadoPerfis = await carregarPerfis();

        if (!resultadoPerfis.sucesso) {
            throw new Error("Não foi possível carregar os perfis");
        }

        console.log('✅ [VERIFICAR LOGIN] ===== LOGIN COMPLETO =====');
        mostrarSelecaoPerfis();

    } catch (e) {
        console.error('❌ [VERIFICAR LOGIN] Erro crítico:', e);
        alert('Erro ao inicializar: ' + e.message);
        AuthGuard.performLogout();
    } finally {
        if (authLoading) authLoading.style.display = 'none';
        if (protectedContent) protectedContent.style.display = 'block';
    }
}