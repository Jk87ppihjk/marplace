// ! Arquivo: prp-main/smartVitrineRoutes.js (COM ÁREA DE PATROCINADOS)
const express = require('express');
const router = express.Router();
const pool = require('./config/db');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;

// --- CONFIGURAÇÃO DA INTELIGÊNCIA ---
const WEIGHTS = {
    PROMOTION: 5.0,   // !!! NOVO: Fator de multiplicação gigante para patrocinados
    CONVERSION: 0.5,  // 50% Vendas Orgânicas
    RECENCY: 0.2,     // 20% Novidade
    PERSONAL: 0.2,    // 20% Gosto do Usuário
    RANDOM: 0.1       // 10% Sorte
};

function calculateProductScore(product, userPreferences) {
    const views = product.views_count || 1; 
    const sales = product.total_sold || 0;
    const conversionRate = sales / views;

    const createdDate = new Date(product.created_at).getTime();
    const now = Date.now();
    const daysOld = (now - createdDate) / (1000 * 60 * 60 * 24);
    const recencyScore = Math.max(0, 1 - (daysOld / 30)); 

    let personalScore = 0;
    if (userPreferences) {
        if (userPreferences.favorite_categories.includes(product.subcategory_id)) {
            personalScore = 1.0; 
        } else if (userPreferences.favorite_categories.includes(product.category_id)) {
            personalScore = 0.5; 
        }
    }

    const explorationFactor = Math.random();

    // === CÁLCULO BASE ===
    let finalScore = 
        (conversionRate * WEIGHTS.CONVERSION) +
        (recencyScore * WEIGHTS.RECENCY) +
        (personalScore * WEIGHTS.PERSONAL) +
        (explorationFactor * WEIGHTS.RANDOM);

    // !!! A MÁGICA DO PATROCÍNIO AQUI !!!
    // Se for patrocinado, somamos um valor alto para garantir o topo
    if (product.is_promoted) {
        finalScore += WEIGHTS.PROMOTION; 
    }

    return finalScore;
}

// ROTA DA VITRINE
router.get('/smart-feed', async (req, res) => {
    let userId = null;
    let userPreferences = { favorite_categories: [] };
    const userCityId = req.query.city_id; 

    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer') && JWT_SECRET) {
        try {
            const token = req.headers.authorization.split(' ')[1];
            const decoded = jwt.verify(token, JWT_SECRET);
            userId = decoded.id;

            const [history] = await pool.query(
                `SELECT DISTINCT p.category_id, p.subcategory_id 
                 FROM order_items oi
                 JOIN products p ON oi.product_id = p.id
                 JOIN orders o ON oi.order_id = o.id
                 WHERE o.buyer_id = ? LIMIT 10`, 
                [userId]
            );
            
            history.forEach(h => {
                userPreferences.favorite_categories.push(h.category_id);
                userPreferences.favorite_categories.push(h.subcategory_id);
            });
        } catch (error) { console.warn('Sem user'); }
    }

    try {
        // Buscamos o novo campo 'is_promoted'
        const query = `
            SELECT p.*, 
                   s.name AS store_name, 
                   u.city,
                   (SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi WHERE oi.product_id = p.id) AS total_sold
            FROM products p
            JOIN stores s ON p.seller_id = s.seller_id
            JOIN users u ON p.seller_id = u.id
            WHERE p.is_active = TRUE
        `;
        
        const [products] = await pool.query(query);

        const rankedProducts = products.map(product => {
            try { if(product.detail_image_urls) product.detail_image_urls = JSON.parse(product.detail_image_urls); } catch(e){}
            try { if(product.shipping_options) product.shipping_options = JSON.parse(product.shipping_options); } catch(e){}

            let localBoost = 1.0;
            if (userCityId && product.shipping_options) {
                const entregaLocal = product.shipping_options.some(opt => opt.city_id == userCityId);
                if (!entregaLocal) localBoost = 0.5; 
            }

            const intelligenceScore = calculateProductScore(product, userPreferences);
            
            return {
                ...product,
                algo_score: intelligenceScore * localBoost 
            };
        });

        // Ordena: Patrocinados vão ter score > 5.0, orgânicos terão score < 2.0
        rankedProducts.sort((a, b) => b.algo_score - a.algo_score);

        // Feedback Loop
        const topProductIds = rankedProducts.slice(0, 20).map(p => p.id);
        if (topProductIds.length > 0) {
            pool.query(`UPDATE products SET views_count = views_count + 1 WHERE id IN (${topProductIds.join(',')})`).catch(console.error);
        }

        res.status(200).json({ success: true, products: rankedProducts });

    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Erro no algoritmo.' });
    }
});

// 2. NOVA ROTA: ANALYTICS (Para o Dashboard)
router.get('/analytics-data', async (req, res) => {
    try {
        // Busca produtos com métricas
        const query = `
            SELECT p.id, p.name, p.image_url, p.views_count, p.price,
                   (SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi WHERE oi.product_id = p.id) AS total_sold
            FROM products p
            WHERE p.is_active = TRUE
        `;
        const [products] = await pool.query(query);

        // Processa os rankings em memória (JS) para flexibilidade
        // A. Mais Vendidos
        const topSold = [...products].sort((a, b) => b.total_sold - a.total_sold).slice(0, 5);
        
        // B. Mais Vistos
        const topViewed = [...products].sort((a, b) => b.views_count - a.views_count).slice(0, 5);
        
        // C. Melhor Conversão (Eficiência: Vendas / Visualizações)
        // Ignora produtos com poucas views (< 5) para não distorcer (ex: 1 view e 1 venda = 100%)
        const topConversion = [...products]
            .filter(p => p.views_count > 5) 
            .map(p => ({...p, conversion: (p.total_sold / p.views_count * 100).toFixed(1)}))
            .sort((a, b) => b.conversion - a.conversion)
            .slice(0, 5);

        res.json({
            success: true,
            topSold,
            topViewed,
            topConversion
        });

    } catch (error) {
        console.error('[ANALYTICS] Erro:', error);
        res.status(500).json({ success: false, message: 'Erro ao gerar métricas.' });
    }
});

module.exports = router;
