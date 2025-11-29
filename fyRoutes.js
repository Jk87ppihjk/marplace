// ! Arquivo: prp-main/fyRoutes.js (FINAL - COMPLETO E CORRIGIDO PARA EDIÇÃO/EXCLUSÃO, COM NOVAS REGRAS DE RANQUEAMENTO)
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken'); 
const { protectSeller } = require('./sellerAuthMiddleware'); 
const { protect } = require('./authMiddleware'); 
const pool = require('./config/db'); 

const JWT_SECRET = process.env.JWT_SECRET;
const DAILY_PROMO_COST = 5.00; 

// --- CONFIGURAÇÃO DO ALGORITMO ---
const TEST_AUDIENCE_SIZE = 100; // Mantido, é o mínimo de views para um vídeo entrar no "teste"
const MIN_CONVERSION_THRESHOLD = 0.01; 
const MIN_LIKES_THRESHOLD = 0.05; 
const WEIGHTS = {
    CONVERSION_RATE: 0.6, 
    LIKE_RATE: 0.3,       
    RECENCY_BONUS: 0.1    
};

// -------------------------------------------------------------------
// ALGORITMO CORE: Funções de Ranqueamento e Filtragem 
// -------------------------------------------------------------------

function rankVideos(videos) {
    const ranked = videos.map(video => {
        const views = video.views_count || 1; 
        
        // As taxas ainda dependem das views, mas a lógica de ranqueamento continua a mesma.
        const likeRate = (video.likes_count || 0) / views;
        const conversionRate = (video.product_clicks_count || 0) / views;
        
        const recencyScore = calculateRecencyScore(video.created_at);

        const finalScore = (
            (conversionRate * WEIGHTS.CONVERSION_RATE) +
            (likeRate * WEIGHTS.LIKE_RATE) +
            (recencyScore * WEIGHTS.RECENCY_BONUS)
        );

        return {
            ...video,
            likeRate: conversionRate, 
            conversionRate: conversionRate,
            finalScore 
        };
    });

    // Ranqueia por score final
    return ranked.sort((a, b) => b.finalScore - a.finalScore);
}

// CORREÇÃO: Função de filtro modificada para avaliar o desempenho
// O teste de performance é mantido para garantir que vídeos ruins não dominem o feed,
// mas a regra é aplicada apenas APÓS o vídeo atingir a audiência de teste.
function filterVideosByTestPerformance(videos) {
    return videos.filter(video => {
        const views = video.views_count || 0;

        // Se o vídeo tem menos views que o tamanho da audiência de teste, ele continua no feed
        if (views < TEST_AUDIENCE_SIZE) {
            return true; // Continua na fase de teste, ignorando métricas ruins temporárias
        }

        // Se o vídeo atingiu a audiência de teste (views >= 100), ele deve passar no filtro:
        const likeRate = (video.likes_count || 0) / views;
        const conversionRate = (video.product_clicks_count || 0) / views;

        const passed = (
            conversionRate >= MIN_CONVERSION_THRESHOLD &&
            likeRate >= MIN_LIKES_THRESHOLD
        );
        
        return passed; // Só continua se passou nos testes de engajamento
    });
}

function calculateRecencyScore(dateString) {
    const now = Date.now();
    const created = new Date(dateString).getTime();
    const oneWeek = 7 * 24 * 60 * 60 * 1000;
    const diff = now - created;
    if (diff > oneWeek) return 0;
    return 1 - (diff / oneWeek);
}

// -------------------------------------------------------------------
// 1. ROTA PARA BUSCAR VÍDEO INDIVIDUAL POR ID 
// -------------------------------------------------------------------
router.get('/fy/:id', async (req, res) => {
    const videoId = req.params.id;
    let userId = null;

    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer') && JWT_SECRET) {
        try {
            const token = req.headers.authorization.split(' ')[1];
            const decoded = jwt.verify(token, JWT_SECRET);
            userId = decoded.id;
        } catch (error) {}
    }

    try {
        const [video] = await pool.query(
            `SELECT 
                v.id, v.video_url, v.likes_count, v.created_at, v.views_count, v.product_clicks_count, v.is_active,
                v.is_promoted, v.promotion_end_date, v.ad_attributed_sales_count, s.name AS store_name, 
                p.id AS product_id, p.name AS product_name, c.name AS product_category,
                CASE WHEN ? IS NOT NULL AND EXISTS(SELECT 1 FROM fy_likes fl WHERE fl.video_id = v.id AND fl.user_id = ?) THEN TRUE ELSE FALSE END AS has_liked
             FROM fy_videos v
             JOIN stores s ON v.store_id = s.id
             LEFT JOIN products p ON v.product_id = p.id
             LEFT JOIN subcategories sc ON p.subcategory_id = sc.id 
             LEFT JOIN categories c ON sc.category_id = c.id
             WHERE v.id = ? AND p.is_active = TRUE AND v.is_active = TRUE`,
            [userId, userId, videoId]
        );

        if (video.length === 0) {
            return res.status(404).json({ success: false, message: 'Vídeo não encontrado ou inativo.' });
        }

        res.status(200).json({ success: true, video: video[0] });

    } catch (error) {
        console.error('[FY/GET/:ID] Erro ao buscar vídeo individual:', error);
        res.status(500).json({ success: false, message: 'Erro interno ao carregar vídeo.' });
    }
});


// -------------------------------------------------------------------
// 2. FEED DE VÍDEOS (Comprador/Público) - ROTA PRINCIPAL
// -------------------------------------------------------------------

router.get('/fy', async (req, res) => {
    let userId = null;
    let userHistory = { videos_seen: new Set(), favorite_categories: new Set() }; 
    const now = new Date(); 

    // Tenta obter o ID do usuário para PERSONALIZAÇÃO E LIKES
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer') && JWT_SECRET) {
        try {
            const token = req.headers.authorization.split(' ')[1];
            const decoded = jwt.verify(token, JWT_SECRET);
            userId = decoded.id;
            
            // Simulação: Buscar histórico do usuário
            const [historyRows] = await pool.query(
                `SELECT videos_seen, liked_categories, clicked_categories 
                 FROM user_metrics WHERE user_id = ?`,
                [userId]
            );
            
            if (historyRows.length > 0) {
                // Simulação de dados reais para personalização
                userHistory.videos_seen = new Set(['10', '15', '20']); 
                userHistory.favorite_categories = new Set(['eletronicos', 'moda']); 
            }

        } catch (error) {
            console.warn('[FY/GET] Token presente, mas inválido/expirado. Feed não personalizado.');
        }
    }
    
    // Consulta LIKE_STATUS se o usuário estiver logado
    const likeStatusSubquery = userId 
        ? `CASE WHEN EXISTS(SELECT 1 FROM fy_likes fl WHERE fl.video_id = v.id AND fl.user_id = ${pool.escape(userId)}) THEN TRUE ELSE FALSE END AS has_liked,`
        : 'FALSE AS has_liked,';

    try {
        const [allVideos] = await pool.query(
            `SELECT 
                v.id, v.video_url, v.likes_count, v.created_at, v.views_count, v.product_clicks_count, v.is_active,
                v.is_promoted, v.promotion_end_date, v.ad_attributed_sales_count, 
                s.name AS store_name, 
                p.id AS product_id, p.name AS product_name,
                c.name AS product_category,
                ${likeStatusSubquery} 
                (SELECT COUNT(*) FROM fy_comments fc WHERE fc.video_id = v.id) AS comments_count 
             FROM fy_videos v
             JOIN stores s ON v.store_id = s.id
             LEFT JOIN products p ON v.product_id = p.id
             LEFT JOIN subcategories sc ON p.subcategory_id = sc.id 
             LEFT JOIN categories c ON sc.category_id = c.id
             WHERE p.is_active = TRUE AND v.is_active = TRUE`
        );
        
        if (allVideos.length === 0) {
            return res.status(200).json({ success: true, videos: [] });
        }

        // --- APLICAÇÃO DO ALGORITMO (Ranqueamento e Mixagem) ---
        
        // 1. FILTRO DE PERFORMANCE: Remove vídeos ruins que já passaram da fase de teste
        const testedVideos = filterVideosByTestPerformance(allVideos);
        
        // 2. RANQUEAMENTO
        const rankedVideos = rankVideos(testedVideos); 

        // 3. SEPARAÇÃO E PRIORIZAÇÃO
        let promotedVideos = [];
        let likedVideos = []; // Vídeos que o usuário já curtiu
        let priorityFeed = []; // Novos/Exploração/Categoria Favorita (Alta Prioridade)
        let explorationFeed = []; // Exploração Geral (Prioridade Média)
        
        const videosSeen = userHistory.videos_seen;
        const favoriteCategories = userHistory.favorite_categories;

        for (const video of rankedVideos) {
            
            // Prioridade 1: Promovidos (para mixagem posterior)
            if (video.is_promoted && video.promotion_end_date && new Date(video.promotion_end_date) > now) {
                promotedVideos.push(video);
                continue; 
            }
            
            // Prioridade 5 (Baixa): Vídeos já curtidos (Só serão exibidos no final)
            if (video.has_liked) {
                likedVideos.push(video);
                continue;
            }

            // Ignora vídeos já vistos pelo usuário
            if (videosSeen.has(String(video.id))) { 
                continue; 
            }
            
            // Prioridade 2: Vídeos relevantes/novos da categoria favorita do usuário
            // A recência já dá bônus, então basta garantir que o vídeo esteja entre os melhores ranqueados.
            if (favoriteCategories.size > 0 && favoriteCategories.has(video.product_category)) {
                priorityFeed.push(video);
            } else {
                // Prioridade 3: Exploração (não visto, não curtido, não na categoria favorita)
                explorationFeed.push(video);
            }
        }
        
        // A fila orgânica principal prioriza o que o usuário ainda não viu e a categoria favorita
        const organicQueue = priorityFeed.concat(explorationFeed); 

        // 4. MIXAGEM DO FEED FINAL
        let finalFeed = []; 
        const TARGET_FEED_SIZE = 50; 
        const PROMOTED_RATIO_INTERVAL = 6; 

        let promotedIndex = 0;
        let organicIndex = 0;
        
        // Constrói o feed principal com Promovidos e Orgânicos (Novos/Exploração)
        while (finalFeed.length < TARGET_FEED_SIZE && (organicIndex < organicQueue.length || promotedIndex < promotedVideos.length)) {
            
            // Insere promovido a cada X vídeos
            if (finalFeed.length % PROMOTED_RATIO_INTERVAL === 0) {
                if (promotedVideos.length > 0) {
                    const videoToInsert = promotedVideos[promotedIndex % promotedVideos.length];
                    // Evita inserir o mesmo vídeo duas vezes (no caso de feed pequeno e poucos promovidos)
                    if (!finalFeed.find(v => v.id === videoToInsert.id)) {
                        finalFeed.push(videoToInsert);
                    }
                    promotedIndex++;
                    continue; 
                }
            }
            
            // Insere o próximo orgânico (Novo/Exploração)
            if (organicIndex < organicQueue.length) {
                finalFeed.push(organicQueue[organicIndex]);
                organicIndex++;
            } 
            // Se os orgânicos acabaram, continua preenchendo com promovidos até o limite
            else if (promotedIndex < promotedVideos.length) {
                const videoToInsert = promotedVideos[promotedIndex % promotedVideos.length];
                 if (!finalFeed.find(v => v.id === videoToInsert.id)) {
                    finalFeed.push(videoToInsert);
                }
                promotedIndex++;
            }
            // Se ambos acabaram, o loop para
             else {
                break; 
            }
        }
        
        // 5. ADICIONA VÍDEOS JÁ CURTIDOS AO FINAL (Conteúdo de Reserva/Reengajamento)
        // Isso atende ao requisito de mostrar vídeos curtidos por último.
        const remainingSpace = TARGET_FEED_SIZE - finalFeed.length;
        if (remainingSpace > 0 && likedVideos.length > 0) {
            // Adiciona vídeos curtidos que não foram acidentalmente incluídos como promovidos
            const toAppend = likedVideos.filter(lv => !finalFeed.find(fv => fv.id === lv.id));
            finalFeed = finalFeed.concat(toAppend.slice(0, remainingSpace));
        }


        res.status(200).json({ 
            success: true, 
            message: userId ? 'Feed Personalizado' : 'Feed Global',
            videos: finalFeed.slice(0, TARGET_FEED_SIZE)
        });

    } catch (error) {
        console.error('Erro no Feed Fy com Algoritmo:', error);
        res.status(500).json({ success: false, message: 'Erro interno ao carregar vídeos: ' + error.message });
    }
});


// 1.1. CRIAR/CADASTRAR Vídeo Fy
router.post('/fy', protectSeller, async (req, res) => {
    const seller_id = req.user.id;
    const { video_url, product_id } = req.body;
    
    if (!video_url) {
        return res.status(400).json({ success: false, message: 'URL do vídeo é obrigatória.' });
    }

    try {
        const [store] = await pool.query('SELECT id FROM stores WHERE seller_id = ?', [seller_id]);
        
        if (store.length === 0) {
            return res.status(403).json({ success: false, message: 'Você precisa ter uma loja ativa.' });
        }
        const store_id = store[0].id;

        const [result] = await pool.query(
            'INSERT INTO fy_videos (store_id, product_id, video_url, views_count, product_clicks_count, is_active, is_promoted, daily_budget, budget_spent, ad_attributed_sales_count) VALUES (?, ?, ?, 0, 0, TRUE, FALSE, ?, 0.00, 0)',
            [store_id, product_id || null, video_url, DAILY_PROMO_COST]
        );

        res.status(201).json({ success: true, message: 'Vídeo Fy cadastrado com sucesso.', video_id: result.insertId });

    } catch (error) {
        console.error('Erro ao cadastrar vídeo Fy:', error);
        res.status(500).json({ success: false, message: 'Erro ao salvar vídeo: ' + error.message });
    }
});

// 1.2. LER Vídeos de UMA Loja (Painel do Vendedor)
router.get('/fy/store/:storeId', protectSeller, async (req, res) => {
    const store_id = req.params.storeId;
    
    try {
        const [videos] = await pool.query(
            `SELECT 
                v.id, v.video_url, v.likes_count, v.created_at, v.views_count, v.product_clicks_count, v.is_active,
                v.is_promoted, v.promotion_end_date, v.daily_budget, v.budget_spent, v.ad_attributed_sales_count, 
                s.name AS store_name, 
                p.id AS product_id, p.name AS product_name
             FROM fy_videos v
             JOIN stores s ON v.store_id = s.id
             LEFT JOIN products p ON v.product_id = p.id
             WHERE v.store_id = ?
             ORDER BY v.created_at DESC`,
            [store_id]
        );
        res.status(200).json({ success: true, videos });
    } catch (error) {
        console.error('[FY/STORE] Erro:', error);
        res.status(500).json({ success: false, message: 'Erro ao carregar vídeos: ' + error.message });
    }
});


// 2.2. DELETAR um Vídeo Fy (Soft Delete)
router.delete('/fy/:id', protectSeller, async (req, res) => {
    const video_id = req.params.id;
    const seller_id = req.user.id;
    
    try {
        const [result] = await pool.query(
            `UPDATE fy_videos v
             JOIN stores s ON v.store_id = s.id
             SET v.is_active = FALSE
             WHERE v.id = ? AND s.seller_id = ?`,
            [video_id, seller_id]
        );
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, message: 'Vídeo não encontrado ou sem permissão.' });
        }
        
        res.status(200).json({ success: true, message: 'Vídeo inativado.' });
    } catch (error) {
        console.error('[FY/DELETE] Erro:', error);
        res.status(500).json({ success: false, message: 'Erro ao inativar: ' + error.message });
    }
});


// -------------------------------------------------------------------
// 3. INTERAÇÕES E PROMOÇÃO
// -------------------------------------------------------------------

// Rota de LIKE/UNLIKE (Toggle)
router.post('/fy/:id/like-toggle', protect, async (req, res) => {
    const videoId = req.params.id;
    const userId = req.user.id;
    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        // 1. Verifica se o like já existe
        const [likeRows] = await connection.execute(
            'SELECT 1 FROM fy_likes WHERE video_id = ? AND user_id = ?',
            [videoId, userId]
        );

        const alreadyLiked = likeRows.length > 0;
        let actionMessage = '';

        if (alreadyLiked) {
            // REMOVER LIKE
            await connection.execute(
                'DELETE FROM fy_likes WHERE video_id = ? AND user_id = ?',
                [videoId, userId]
            );
            await connection.execute(
                'UPDATE fy_videos SET likes_count = likes_count - 1 WHERE id = ? AND likes_count > 0',
                [videoId]
            );
            actionMessage = 'Unlike registrado.';
        } else {
            // ADICIONAR LIKE
            await connection.execute(
                'INSERT INTO fy_likes (video_id, user_id) VALUES (?, ?)',
                [videoId, userId]
            );
            await connection.execute(
                'UPDATE fy_videos SET likes_count = likes_count + 1 WHERE id = ?',
                [videoId]
            );
            actionMessage = 'Like registrado.';
        }

        // NOVO: Busca o novo total de likes para retorno ao frontend
        const [newLikesRow] = await connection.execute(
            'SELECT likes_count FROM fy_videos WHERE id = ?',
            [videoId]
        );
        const newLikesCount = newLikesRow.length > 0 ? newLikesRow[0].likes_count : 0;


        await connection.commit();
        res.status(200).json({ 
            success: true, 
            message: actionMessage, 
            liked: !alreadyLiked,
            new_likes_count: newLikesCount // Adicionado para atualizar o frontend
        });

    } catch (error) {
        await connection.rollback();
        console.error('[FY/LIKE_TOGGLE] Erro na transação de like:', error);
        res.status(500).json({ success: false, message: 'Erro interno ao registrar like.' });
    } finally {
        if (connection) connection.release();
    }
});

// Rota para registrar o clique no produto
router.post('/fy/:id/product-click', async (req, res) => {
    const video_id = req.params.id;
    
    try {
        const [result] = await pool.query('UPDATE fy_videos SET product_clicks_count = product_clicks_count + 1 WHERE id = ?', [video_id]);

        if (result.affectedRows === 0) {
             return res.status(404).json({ success: false, message: 'Vídeo não encontrado.' });
        }

        res.status(200).json({ success: true, message: 'Clique no produto +1' });
    } catch (error) {
        console.error('[FY/CLICK] Erro ao registrar clique no produto:', error);
        res.status(500).json({ success: false, message: 'Erro interno ao registrar clique.' }); 
    }
});

// Rota para registrar a visualização do vídeo
router.post('/fy/:id/view', async (req, res) => {
    const video_id = req.params.id;
    
    try {
        const [result] = await pool.query('UPDATE fy_videos SET views_count = views_count + 1 WHERE id = ?', [video_id]);
        
        if (result.affectedRows === 0) {
             return res.status(404).json({ success: false, message: 'Vídeo não encontrado.' });
        }

        // NOVO: Busca o novo total de views para retorno (opcional, mas bom para consistência)
        const [newViewsRow] = await pool.query(
            'SELECT views_count FROM fy_videos WHERE id = ?',
            [video_id]
        );
        const newViewsCount = newViewsRow.length > 0 ? newViewsRow[0].views_count : 0;
        
        res.status(200).json({ success: true, message: 'Visualização +1', new_views_count: newViewsCount });
    } catch (error) {
        console.error('[FY/VIEW] Erro ao registrar visualização:', error);
        res.status(500).json({ success: false, message: 'Erro interno ao registrar visualização.' }); 
    }
});


// -------------------------------------------------------------------
// 4. ROTAS DE COMENTÁRIOS (ADICIONANDO SUPORTE A RESPOSTAS)
// -------------------------------------------------------------------

// Rota GET para buscar comentários
router.get('/fy/:id/comments', async (req, res) => {
    const videoId = req.params.id;
    
    try {
        // CORREÇÃO: Adicionando fc.user_id na seleção (mantido da versão anterior)
        const [comments] = await pool.query(
            `SELECT 
                fc.id, fc.comment_text, fc.created_at, fc.parent_comment_id,
                fc.user_id,                         
                u.full_name AS user_name,
                parent_user.full_name AS parent_user_name
             FROM fy_comments fc
             JOIN users u ON fc.user_id = u.id
             LEFT JOIN fy_comments parent_fc ON fc.parent_comment_id = parent_fc.id
             LEFT JOIN users parent_user ON parent_fc.user_id = parent_user.id
             WHERE fc.video_id = ?
             ORDER BY fc.created_at ASC`, 
            [videoId]
        );
        
        res.status(200).json({ success: true, comments });

    } catch (error) {
        console.error('[FY/COMMENTS/GET] Erro ao buscar comentários:', error);
        res.status(500).json({ success: false, message: 'Erro ao carregar comentários.' });
    }
});

// Rota POST para adicionar novo comentário
router.post('/fy/:id/comments', protect, async (req, res) => {
    const videoId = req.params.id;
    const userId = req.user.id;
    const { comment_text, parent_comment_id } = req.body; 
    
    if (!comment_text || comment_text.trim() === '') {
        return res.status(400).json({ success: false, message: 'O comentário não pode ser vazio.' });
    }

    try {
        const [result] = await pool.query(
            'INSERT INTO fy_comments (video_id, user_id, comment_text, parent_comment_id) VALUES (?, ?, ?, ?)',
            [videoId, userId, comment_text.trim(), parent_comment_id || null]
        );
        
        res.status(201).json({ success: true, message: 'Comentário adicionado.', comment_id: result.insertId });

    } catch (error) {
        console.error('[FY/COMMENTS/POST] Erro ao adicionar comentário:', error);
        res.status(500).json({ success: false, message: 'Erro interno ao adicionar comentário.' });
    }
});

// Rota PUT: Edita o texto de um comentário/resposta existente.
router.put('/fy/comments/:id', protect, async (req, res) => {
    const commentId = req.params.id;
    const userId = req.user.id;
    const { comment_text } = req.body;

    if (!comment_text || comment_text.trim() === '') {
        return res.status(400).json({ success: false, message: 'O texto do comentário não pode ser vazio.' });
    }

    try {
        const [result] = await pool.execute(
            'UPDATE fy_comments SET comment_text = ? WHERE id = ? AND user_id = ?',
            [comment_text.trim(), commentId, userId]
        );

        if (result.affectedRows === 0) {
            // MENSAGEM DE ERRO CONTEXTUALIZADA
            return res.status(403).json({ success: false, message: 'Comentário não encontrado ou você não tem permissão para editá-lo.' });
        }

        res.status(200).json({ success: true, message: 'Comentário atualizado com sucesso.' });
    } catch (error) {
        console.error('[FY/COMMENTS/PUT] Erro ao editar comentário:', error);
        res.status(500).json({ success: false, message: 'Erro interno ao editar comentário.' });
    }
});


// Rota DELETE: Exclui um comentário/resposta.
router.delete('/fy/comments/:id', protect, async (req, res) => {
    const commentId = req.params.id;
    const userId = req.user.id;

    try {
        const [result] = await pool.execute(
            'DELETE FROM fy_comments WHERE id = ? AND user_id = ?',
            [commentId, userId]
        );

        if (result.affectedRows === 0) {
            // MENSAGEM DE ERRO CONTEXTUALIZADA
            return res.status(403).json({ success: false, message: 'Comentário não encontrado ou você não tem permissão para excluí-lo.' });
        }
        
        res.status(200).json({ success: true, message: 'Comentário excluído com sucesso.' });
    } catch (error) {
        console.error('[FY/COMMENTS/DELETE] Erro ao excluir comentário:', error);
        res.status(500).json({ success: false, message: 'Erro interno ao excluir comentário.' });
    }
});

// -------------------------------------------------------------------
// 5. ROTAS DE PROMOÇÃO (MANTIDAS)
// -------------------------------------------------------------------
router.post('/fy/:id/promote', protectSeller, async (req, res) => {
    const videoId = req.params.id;
    const sellerId = req.user.id;
    const { days } = req.body; 
    
    const daysInt = parseInt(days);
    if (isNaN(daysInt) || daysInt <= 0) {
        return res.status(400).json({ success: false, message: 'Número de dias inválido.' });
    }
    
    const totalCost = daysInt * DAILY_PROMO_COST; 
    const endDate = new Date(Date.now() + daysInt * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' '); 
    let connection;

    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        const [videoCheck] = await connection.query(
             `SELECT s.seller_id, u.pending_balance 
              FROM fy_videos v JOIN stores s ON v.store_id = s.id 
              JOIN users u ON s.seller_id = u.id
              WHERE v.id = ? AND s.seller_id = ?`, 
            [videoId, sellerId]
        );

        if (videoCheck.length === 0) {
            await connection.rollback();
            return res.status(404).json({ success: false, message: 'Vídeo não encontrado ou acesso negado.' });
        }
        
        const currentBalance = videoCheck[0].pending_balance || 0;
        if (currentBalance < totalCost) {
            await connection.rollback();
            return res.status(402).json({ success: false, message: `Saldo insuficiente (R$${currentBalance.toFixed(2)}) para pagar R$${totalCost.toFixed(2)}.` });
        }

        // 2. Debita o valor do saldo do lojista
        await connection.execute(
            'UPDATE users SET pending_balance = pending_balance - ? WHERE id = ?',
            [totalCost, sellerId]
        );
        
        // 3. Atualiza o vídeo para promovido
        await connection.execute(
            `UPDATE fy_videos 
             SET is_promoted = TRUE, promotion_end_date = ?, daily_budget = ?, budget_spent = 0.00
             WHERE id = ?`,
            [endDate, DAILY_PROMO_COST, videoId]
        );

        await connection.commit();

        res.status(200).json({ 
            success: true, 
            message: `Promoção ativada por ${daysInt} dias (R$${totalCost.toFixed(2)} debitados).`,
            promotion_ends: endDate
        });

    } catch (error) {
        if (connection) await connection.rollback();
        console.error('[FY/PROMOTE] Erro ao promover vídeo:', error);
        res.status(500).json({ success: false, message: 'Erro interno ao processar a promoção.' });
    } finally {
        if (connection) connection.release();
    }
});

router.post('/fy/:id/sales-attributed', async (req, res) => {
    const video_id = req.params.id;
    
    try {
        const [result] = await pool.query('UPDATE fy_videos SET ad_attributed_sales_count = ad_attributed_sales_count + 1 WHERE id = ?', [video_id]);

        if (result.affectedRows === 0) {
             console.warn(`[FY/SALES] Venda atribuída falhou: Video ID ${video_id} não encontrado.`);
             return res.status(404).json({ success: false, message: 'Vídeo não encontrado.' });
        }

        res.status(200).json({ success: true, message: 'Venda atribuída +1' });
    } catch (error) {
        console.error('[FY/SALES] Erro ao registrar venda atribuída:', error);
        res.status(500).json({ success: false, message: 'Erro interno ao registrar venda.' });
    }
});


module.exports = router;
