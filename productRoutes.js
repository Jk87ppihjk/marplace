// ! Arquivo: prp-main/productRoutes.js (CORRIGIDO E COMPLETO COM ROTA DE PROMOÇÃO + FILTRO DE CATEGORIA CORRIGIDO)
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken'); 
const { protectSeller } = require('./sellerAuthMiddleware'); 
const { protect } = require('./authMiddleware'); 
const pool = require('./config/db'); 

// --- Constantes de Preço ---
const MARKETPLACE_FEE = 0.00; 
const DELIVERY_FEE = 0.00;     
const TOTAL_ADDITION = MARKETPLACE_FEE + DELIVERY_FEE; 
const JWT_SECRET = process.env.JWT_SECRET; 

// -------------------------------------------------------------------
// Funções Auxiliares
// -------------------------------------------------------------------

const processMediaUrls = (imageUrls, videoId) => {
    const primaryImageUrl = (imageUrls && imageUrls.length > 0) ? imageUrls[0] : null;
    const detailImageUrlsJson = (imageUrls && imageUrls.length > 1) ? JSON.stringify(imageUrls.slice(1)) : null;
    const fyVideoId = videoId || null; 
    return { primaryImageUrl, detailImageUrlsJson, fyVideoId };
};

const parseProductDetails = (product) => {
    // Imagens Detalhadas
    if (product.detail_image_urls) {
         try { product.detail_image_urls = JSON.parse(product.detail_image_urls); } 
         catch(e) { product.detail_image_urls = []; }
    } else { product.detail_image_urls = []; }
    
    // Frete
    if (product.shipping_options) {
         try {
             product.shipping_options = JSON.parse(product.shipping_options);
             product.shipping_options = product.shipping_options.map(opt => ({
                 ...opt,
                 district_id: opt.district_id === '' ? null : opt.district_id 
             }));
         } catch(e) { product.shipping_options = []; }
    } else { product.shipping_options = []; }
    
    // Variações
    if (product.attributes_data) {
         try { product.attributes_data = JSON.parse(product.attributes_data); } 
         catch(e) { }
    } else { product.attributes_data = { definitions: [], variations: [] }; }

    // Verifica validade da promoção
    if (product.is_promoted && product.promotion_end_date) {
        if (new Date(product.promotion_end_date) < new Date()) {
            product.is_promoted = 0; // Expirou
        }
    }
    
    return product;
}

// -------------------------------------------------------------------
// Rotas
// -------------------------------------------------------------------

// 1. CRIAR Produto
router.post('/products', protectSeller, async (req, res) => {
    const seller_id = req.user.id; 
    
    try {
        const [storeCheck] = await pool.execute('SELECT id, city_id FROM stores WHERE seller_id = ?', [seller_id]);
        
        if (storeCheck.length === 0) {
            return res.status(403).json({ success: false, message: 'Crie sua loja primeiro.' });
        }
        const storeCityId = storeCheck[0].city_id; 
        
        const { name, description, subcategory_id, image_urls, fy_video_id, attributes_data, shipping_options } = req.body;

        let basePrice = 0.00;
        let totalStock = 0;
        const attributesJson = attributes_data ? JSON.stringify(attributes_data) : null;
        
        if (attributes_data && attributes_data.variations && attributes_data.variations.length > 0) {
            const prices = attributes_data.variations.map(v => parseFloat(v.price)).filter(p => !isNaN(p) && p > 0);
            basePrice = prices.length > 0 ? Math.min(...prices) : 0.00;
            totalStock = attributes_data.variations.reduce((sum, v) => sum + (parseInt(v.stock) || 0), 0);
        } else {
             basePrice = parseFloat(req.body.price) || 0.00;
             totalStock = parseInt(req.body.stock_quantity) || 0;
        }

        if (!name || !subcategory_id || basePrice <= 0) {
             return res.status(400).json({ success: false, message: 'Nome, Subcategoria e Preço obrigatórios.' });
        }
        
        const shippingOptionsJson = shipping_options && shipping_options.length > 0 ? JSON.stringify(shipping_options) : null;
        if (shippingOptionsJson) {
            const parsedOptions = JSON.parse(shippingOptionsJson);
            const localOptionExists = parsedOptions.some(opt => opt.city_id == storeCityId);
            if (!localOptionExists) return res.status(400).json({ success: false, message: 'Defina frete para sua cidade.' });
        }
        
        const { primaryImageUrl, detailImageUrlsJson, fyVideoId } = processMediaUrls(image_urls, fy_video_id);
        const finalPrice = basePrice + TOTAL_ADDITION; 
        
        const [result] = await pool.execute(
            `INSERT INTO products 
            (seller_id, name, description, price, stock_quantity, subcategory_id, image_url, fy_video_id, attributes_data, detail_image_urls, shipping_options) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, 
            [seller_id, name, description || null, finalPrice, totalStock, subcategory_id || null, primaryImageUrl, fyVideoId, attributesJson, detailImageUrlsJson, shippingOptionsJson]
        );
        
        res.status(201).json({ success: true, message: 'Produto criado.', product_id: result.insertId });

    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Erro ao criar produto.' });
    }
});

// 2. LER Lista de Produtos (Pública) - CORRIGIDO (FILTRO POR PRODUTO, NÃO LOJA)
router.get('/products', async (req, res) => {
    const categoryId = req.query.category_id;
    const subcategoryId = req.query.subcategory_id;
    
    let whereClause = 'WHERE p.is_active = TRUE';
    const queryParams = [];
    let buyerCityId = null;

    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer') && JWT_SECRET) {
        try {
            const token = req.headers.authorization.split(' ')[1];
            const decoded = jwt.verify(token, JWT_SECRET);
            const [userRows] = await pool.execute(`SELECT city_id FROM users WHERE id = ? LIMIT 1`, [decoded.id]);
            if (userRows.length > 0 && userRows[0].city_id) buyerCityId = userRows[0].city_id;
        } catch (error) {}
    }

    // CORREÇÃO: Filtra pela categoria da subcategoria (sc) e não da loja (s)
    if (categoryId) { 
        whereClause += ' AND sc.category_id = ?'; 
        queryParams.push(categoryId); 
    }
    
    if (subcategoryId) { 
        whereClause += ' AND p.subcategory_id = ?'; 
        queryParams.push(subcategoryId); 
    }
    
    if (buyerCityId) {
        const searchJsonString = JSON.stringify({ city_id: buyerCityId.toString() });
        const searchJsonNumber = JSON.stringify({ city_id: parseInt(buyerCityId, 10) });
        whereClause += ` AND (JSON_CONTAINS(p.shipping_options, ?, '$') OR JSON_CONTAINS(p.shipping_options, ?, '$'))`;
        queryParams.push(searchJsonString); 
        queryParams.push(searchJsonNumber);
    }
    
    try {
        // CORREÇÃO: Adicionado LEFT JOIN com subcategories sc
        const query = `
            SELECT p.*, p.shipping_options, s.id AS store_id, s.name AS store_name, u.full_name AS seller_name, u.city,
            (SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi WHERE oi.product_id = p.id) AS total_sold
            FROM products p
            JOIN stores s ON p.seller_id = s.seller_id
            JOIN users u ON p.seller_id = u.id
            LEFT JOIN subcategories sc ON p.subcategory_id = sc.id 
            ${whereClause}
        `;
        
        const [products] = await pool.execute(query, queryParams);
        const processedProducts = products.map(parseProductDetails);

        res.status(200).json({ success: true, count: products.length, products: processedProducts });

    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Erro ao listar produtos.' });
    }
});

// 3. LER Produto Único (Público)
router.get('/products/:id', async (req, res) => {
    const productId = req.params.id;
    try {
        // Conta view
        await pool.query('UPDATE products SET views_count = views_count + 1 WHERE id = ?', [productId]);

        const [rows] = await pool.execute(
            `SELECT p.*, p.shipping_options, s.id AS store_id, s.name AS store_name, u.full_name AS seller_name, u.city,
             (SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi WHERE oi.product_id = p.id) AS total_sold
             FROM products p
             JOIN stores s ON p.seller_id = s.seller_id
             JOIN users u ON p.seller_id = u.id
             WHERE p.id = ? AND p.is_active = TRUE LIMIT 1`,
            [productId]
        );

        let product = rows[0];
        if (!product) return res.status(404).json({ success: false, message: 'Produto não encontrado.' });

        product = parseProductDetails(product);
        res.status(200).json({ success: true, product });

    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Erro ao buscar produto.' });
    }
});

// 4. LER Produtos de uma Loja (Lojista)
router.get('/products/store/:sellerId', protectSeller, async (req, res) => {
    const seller_id = req.params.sellerId;
    if (req.user.id.toString() !== seller_id) return res.status(403).json({ success: false, message: 'Acesso negado.' });
    
    try {
        const [products] = await pool.execute(
            `SELECT *, shipping_options,
             (SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi WHERE oi.product_id = products.id) AS total_sold
             FROM products WHERE seller_id = ? ORDER BY created_at DESC`,
            [seller_id]
        );
        const processed = products.map(parseProductDetails);
        res.status(200).json({ success: true, products: processed });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Erro interno.' });
    }
});

// 5. ATUALIZAR Produto
router.put('/products/:id', protectSeller, async (req, res) => {
    const productId = req.params.id;
    const seller_id = req.user.id; 
    
    const [storeCheck] = await pool.execute('SELECT id, city_id FROM stores WHERE seller_id = ?', [seller_id]);
    const storeCityId = storeCheck[0]?.city_id;
    
    const { name, description, subcategory_id, image_urls, is_active, fy_video_id, attributes_data, shipping_options } = req.body;
    
    let basePrice = 0.00;
    let totalStock = 0;
    const attributesJson = attributes_data ? JSON.stringify(attributes_data) : null;
    
    if (attributes_data && attributes_data.variations && attributes_data.variations.length > 0) {
        const prices = attributes_data.variations.map(v => parseFloat(v.price)).filter(p => !isNaN(p) && p > 0);
        basePrice = prices.length > 0 ? Math.min(...prices) : 0.00; 
        totalStock = attributes_data.variations.reduce((sum, v) => sum + (parseInt(v.stock) || 0), 0);
    } else {
         basePrice = parseFloat(req.body.price) || 0.00;
         totalStock = parseInt(req.body.stock_quantity) || 0;
    }

    const { primaryImageUrl, detailImageUrlsJson, fyVideoId } = processMediaUrls(image_urls, fy_video_id);
    const finalPrice = basePrice + TOTAL_ADDITION; 
    
    const shippingOptionsJson = shipping_options && shipping_options.length > 0 ? JSON.stringify(shipping_options) : null;
    if (shippingOptionsJson && storeCityId) {
        const parsedOptions = JSON.parse(shippingOptionsJson);
        const localOptionExists = parsedOptions.some(opt => opt.city_id == storeCityId);
        if (!localOptionExists) return res.status(400).json({ success: false, message: 'Defina frete para sua cidade.' });
    }

    try {
        const [result] = await pool.execute(
            `UPDATE products SET 
             name=?, description=?, price=?, stock_quantity=?, subcategory_id=?, image_url=?, is_active=?, fy_video_id=?, attributes_data=?, detail_image_urls=?, shipping_options=?
             WHERE id=? AND seller_id=?`, 
            [name, description || null, finalPrice, totalStock, subcategory_id || null, primaryImageUrl, is_active, fyVideoId, attributesJson, detailImageUrlsJson, shippingOptionsJson, productId, seller_id]
        );

        if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'Produto não encontrado.' });
        res.status(200).json({ success: true, message: 'Produto atualizado.' });

    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Erro ao atualizar.' });
    }
});

// 6. DELETAR (Inativar)
router.delete('/products/:id', protectSeller, async (req, res) => {
    const productId = req.params.id;
    const seller_id = req.user.id; 
    try {
        const [result] = await pool.execute('UPDATE products SET is_active = FALSE WHERE id = ? AND seller_id = ?', [productId, seller_id]);
        if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'Produto não encontrado.' });
        res.status(200).json({ success: true, message: 'Produto inativado.' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Erro interno.' });
    }
});


// -------------------------------------------------------------------
// !!! ROTA DE IMPULSIONAR PRODUTO (PROMOTE) !!!
// -------------------------------------------------------------------
router.post('/products/:id/promote', protectSeller, async (req, res) => {
    const productId = req.params.id;
    const sellerId = req.user.id;
    const { days } = req.body;

    if (!days || days < 1) {
        return res.status(400).json({ success: false, message: 'Dias inválidos.' });
    }

    const COST_PER_DAY = 5.00;
    const totalCost = days * COST_PER_DAY;

    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        // 1. Verifica produto e dono
        const [rows] = await connection.execute('SELECT id, is_promoted, promotion_end_date FROM products WHERE id = ? AND seller_id = ?', [productId, sellerId]);
        if (rows.length === 0) {
            await connection.rollback();
            return res.status(404).json({ success: false, message: 'Produto não encontrado.' });
        }
        const product = rows[0];

        // 2. Verifica Saldo
        const [userRows] = await connection.execute('SELECT pending_balance FROM users WHERE id = ? FOR UPDATE', [sellerId]);
        const currentBalance = parseFloat(userRows[0].pending_balance || 0);

        if (currentBalance < totalCost) {
            await connection.rollback();
            return res.status(400).json({ success: false, message: 'Saldo insuficiente.' });
        }

        // 3. Deduz Saldo
        await connection.execute('UPDATE users SET pending_balance = pending_balance - ? WHERE id = ?', [totalCost, sellerId]);

        // 4. Calcula data de expiração
        let newDate = new Date();
        const now = new Date();
        
        // Se já tem promoção ativa, soma a partir do fim dela
        if (product.is_promoted && product.promotion_end_date && new Date(product.promotion_end_date) > now) {
            newDate = new Date(product.promotion_end_date);
        }
        
        // Adiciona os dias comprados
        newDate.setDate(newDate.getDate() + parseInt(days));

        // 5. Atualiza Produto
        await connection.execute('UPDATE products SET is_promoted = TRUE, promotion_end_date = ? WHERE id = ?', [newDate, productId]);

        await connection.commit();
        res.json({ success: true, message: `Impulsionado por ${days} dias!`, new_balance: currentBalance - totalCost });

    } catch (err) {
        await connection.rollback();
        console.error('[PROMOTE] Erro:', err);
        res.status(500).json({ success: false, message: 'Erro no servidor.' });
    } finally {
        connection.release();
    }
});

// 7. ALTERAR STATUS (Toggle Ativar/Inativar)
router.patch('/products/:id/status', protectSeller, async (req, res) => {
    const productId = req.params.id;
    const seller_id = req.user.id;
    const { is_active } = req.body; // Recebe true ou false

    try {
        const [result] = await pool.execute(
            'UPDATE products SET is_active = ? WHERE id = ? AND seller_id = ?', 
            [is_active, productId, seller_id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, message: 'Produto não encontrado.' });
        }
        
        res.json({ success: true, message: `Produto ${is_active ? 'ativado' : 'pausado'} com sucesso.` });

    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Erro ao alterar status.' });
    }
});

module.exports = router;
