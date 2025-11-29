// ! Arquivo: deliveryRoutes.js (VERSÃO FINAL - LOGÍSTICA MP & SIMULAÇÃO)

const express = require('express');
const router = express.Router();
const pool = require('./config/db');
const { protectSeller } = require('./sellerAuthMiddleware'); 
const { protectDeliveryPerson } = require('./deliveryAuthMiddleware');
const { protect } = require('./authMiddleware'); 

// --- Constantes de Regras de Negócio ---
const MARKETPLACE_FEE_RATE = 0.05; // 5% (Taxa usada no cálculo do split na confirmação)
const DELIVERY_FEE = 5.00;         // R$ 5,00

// ===================================================================
// FUNÇÃO HELPER: ATRIBUIÇÃO DE VENDA FY (ADICIONADA PARA SIMULAÇÃO)
// ===================================================================
/**
 * Registra a venda no contador do vídeo FY (fy_videos.ad_attributed_sales_count).
 * @param {number} videoId - ID do vídeo FY.
 */
async function attributeSaleToVideo(videoId) {
    if (!videoId) return;
    try {
        const [result] = await pool.query( 
            'UPDATE fy_videos SET ad_attributed_sales_count = ad_attributed_sales_count + 1 WHERE id = ?',
            [videoId]
        );
        
        if (result.affectedRows > 0) {
            console.log(`[ATRIBUIÇÃO SUCESSO] Venda Simulada atribuída ao vídeo FY ID: ${videoId}`);
        } else {
             console.warn(`[ATRIBUIÇÃO AVISO] Falha na atribuição: Vídeo FY ID ${videoId} não encontrado no DB.`);
        }
    } catch (error) {
        console.error(`[ATRIBUIÇÃO ERRO] Falha ao atribuir venda ao vídeo ID: ${videoId}`, error);
    }
}


// ===================================================================
// ROTAS DE ADMINISTRAÇÃO E CONTRATO (Usado pelo Seller)
// ===================================================================

/**
 * Rota 1: Contratar ou Demitir Entregador (PUT /api/delivery/contract/:storeId)
 */
router.put('/delivery/contract/:storeId', protectSeller, async (req, res) => {
    const storeId = req.params.storeId;
    const sellerId = req.user.id;
    const { delivery_person_id } = req.body; 

    const [storeCheck] = await pool.execute(
        'SELECT id FROM stores WHERE id = ? AND seller_id = ?',
        [storeId, sellerId]
    );

    if (storeCheck.length === 0) {
        return res.status(403).json({ success: false, message: 'Acesso negado ou loja não encontrada.' });
    }

    try {
        if (delivery_person_id) {
            const [dpCheck] = await pool.execute(
                'SELECT id FROM users WHERE id = ? AND is_delivery_person = TRUE',
                [delivery_person_id]
            );
            if (dpCheck.length === 0) {
                return res.status(400).json({ success: false, message: 'ID fornecido não corresponde a um entregador cadastrado.' });
            }
        }
        
        await pool.execute(
            'UPDATE stores SET contracted_delivery_person_id = ? WHERE id = ?',
            [delivery_person_id || null, storeId]
        );

        const status = delivery_person_id ? 'CONTRATADO' : 'DEMITIDO';
        res.status(200).json({ success: true, message: `Entregador ${status} com sucesso!` });

    } catch (error) {
        console.error('[DELIVERY/CONTRACT] Erro ao gerenciar contrato:', error);
        res.status(500).json({ success: false, message: 'Erro interno ao salvar contrato.' });
    }
});


// ===================================================================
// ROTAS DE PEDIDOS - APENAS SIMULAÇÃO (Criação Real via MP fica no orderCreationRoutes)
// ===================================================================

/**
 * Rota 2.5: Cria um NOVO Pedido - FLUXO SIMULADO (POST /api/delivery/orders/simulate-purchase)
 * Cria o pedido diretamente com status 'Processing' (pago).
 * CORRIGIDO: Agora atribui a venda ao vídeo (source_video_id).
 */
router.post('/delivery/orders/simulate-purchase', protect, async (req, res) => {
    const buyerId = req.user.id;
    // CORREÇÃO: Adicionado source_video_id
    const { store_id, items, total_amount, source_video_id } = req.body; 

    if (!store_id || !items || items.length === 0 || !total_amount) {
        return res.status(400).json({ success: false, message: 'Dados do pedido incompletos.' });
    }

    const deliveryCode = Math.random().toString(36).substring(2, 8).toUpperCase(); 
    const transactionId = 'SIMULATED_PURCHASE'; 
    const simulatedStatus = 'Processing'; 

    try {
        await pool.query('BEGIN'); 

        // 1. Cria o Pedido principal com status 'Processing' e registra o source_video_id
        const [orderResult] = await pool.execute(
            `INSERT INTO orders (buyer_id, store_id, total_amount, status, delivery_code, payment_transaction_id, source_video_id) 
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [buyerId, store_id, total_amount, simulatedStatus, deliveryCode, transactionId, source_video_id || null]
        );
        const orderId = orderResult.insertId;

        // 2. Diminui o estoque (Lógica essencial de compra)
        for (const item of items) {
             // Garante quantidade numérica
             const qty = parseInt(item.qty || item.quantity || 1, 10);
             
             // Salva o item
             const price = parseFloat(item.unit_price || item.price || 0);
             const name = item.product_name || item.name || 'Produto Simulado';
             const attributes = item.options ? JSON.stringify(item.options) : null;

             await pool.execute(
                `INSERT INTO order_items (order_id, product_id, product_name, quantity, price, attributes_json) 
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [orderId, item.id || item.product_id, name, qty, price, attributes]
            );

             // Baixa estoque
             const [stockUpdate] = await pool.execute(
                'UPDATE products SET stock_quantity = stock_quantity - ? WHERE id = ? AND stock_quantity >= ?',
                [qty, item.id || item.product_id, qty]
            );
            if (stockUpdate.affectedRows === 0) {
                 await pool.query('ROLLBACK');
                 return res.status(400).json({ success: false, message: `Estoque insuficiente para o item ID ${item.id}.` });
            }
        }
        
        await pool.query('COMMIT'); 

        // CORREÇÃO: Atribuição de venda (Após o Commit para não bloquear)
        if (source_video_id) {
            attributeSaleToVideo(source_video_id);
        }

        res.status(201).json({ 
            success: true, 
            message: 'Pedido simulado criado e pago com sucesso.', 
            order_id: orderId,
            status: simulatedStatus
        });

    } catch (error) {
        await pool.query('ROLLBACK'); 
        console.error('[DELIVERY/SIMULATED] Erro no fluxo do pedido simulado:', error.message);
        res.status(500).json({ success: false, message: error.message || 'Erro interno ao processar pedido simulado.' });
    }
});


/**
 * Rota 3: Vendedor Define Método de Entrega (PUT /api/delivery/orders/:orderId/delivery-method)
 * Usada para definir MarketPlace/Contratado/Seller
 */
router.put('/delivery/orders/:orderId/delivery-method', protectSeller, async (req, res) => {
    const orderId = req.params.orderId;
    const sellerId = req.user.id;
    const { method } = req.body; // 'Seller', 'Contracted', 'Marketplace'

    if (!['Seller', 'Contracted', 'Marketplace'].includes(method)) {
        return res.status(400).json({ success: false, message: 'Método de entrega inválido.' });
    }

    try {
        const [orderCheck] = await pool.execute(
            `SELECT o.store_id, s.contracted_delivery_person_id, o.status 
             FROM orders o 
             JOIN stores s ON o.store_id = s.id 
             WHERE o.id = ? AND s.seller_id = ?`,
            [orderId, sellerId]
        );

        if (orderCheck.length === 0) {
            return res.status(403).json({ success: false, message: 'Acesso negado ou pedido não encontrado.' });
        }
        
        // Permite definir entrega se estiver processando
        if (orderCheck[0].status !== 'Processing') {
             return res.status(400).json({ success: false, message: 'O pedido não está no status correto ("Processing") para definir o método de entrega.' });
        }

        const store = orderCheck[0];
        let deliveryPersonId = null;

        if (method === 'Contracted') {
            deliveryPersonId = store.contracted_delivery_person_id;
            if (!deliveryPersonId) {
                return res.status(400).json({ success: false, message: 'Loja não possui entregador contratado.' });
            }
        }
        
        // 1. Atualiza status do pedido para Delivering
        await pool.execute(
            'UPDATE orders SET delivery_method = ?, status = "Delivering" WHERE id = ?',
            [method, orderId]
        );
        
        // 2. Se não for 'Seller' (entrega própria), cria registro na tabela deliveries
        if (method !== 'Seller') {
            
            // Verifica se já existe entrega para evitar duplicidade
            await pool.execute('DELETE FROM deliveries WHERE order_id = ?', [orderId]);

            const [deliveryResult] = await pool.execute(
                `INSERT INTO deliveries (order_id, delivery_person_id, status, delivery_method) VALUES (?, ?, ?, ?)`,
                [orderId, deliveryPersonId, deliveryPersonId ? 'Accepted' : 'Requested', method]
            );

            if (method === 'Contracted' && deliveryPersonId) {
                 await pool.execute('UPDATE users SET is_available = FALSE WHERE id = ?', [deliveryPersonId]);
            }
        }

        res.status(200).json({ success: true, message: `Entrega definida como "${method}".` });

    } catch (error) {
        console.error('[DELIVERY/METHOD] Erro ao definir método de entrega:', error);
        res.status(500).json({ success: false, message: 'Erro interno ao processar a entrega.' });
    }
});


/**
 * Rota 9: Vendedor Despacha o Pedido - ENTREGA PRÓPRIA (PUT /api/delivery/orders/:orderId/dispatch)
 */
router.put('/delivery/orders/:orderId/dispatch', protectSeller, async (req, res) => {
    const orderId = req.params.orderId;
    const sellerId = req.user.id;

    try {
        // 1. Verifica se o pedido é do vendedor e está em 'Processing'
        const [orderCheck] = await pool.execute(
            `SELECT o.id, s.seller_id FROM orders o 
             JOIN stores s ON o.store_id = s.id 
             WHERE o.id = ? AND s.seller_id = ? AND o.status = 'Processing'`,
            [orderId, sellerId]
        );

        if (orderCheck.length === 0) {
            return res.status(404).json({ success: false, message: 'Pedido não encontrado, não pertence a você ou não está no status "Processing".' });
        }
        
        // 2. Define o método de entrega como 'Seller' e atualiza o status
        await pool.execute(
            "UPDATE orders SET status = 'Delivering', delivery_method = 'Seller' WHERE id = ?",
            [orderId]
        );
        
        // 3. Cria o registro de entrega
        await pool.execute('DELETE FROM deliveries WHERE order_id = ?', [orderId]);
        await pool.execute(
            `INSERT INTO deliveries (order_id, delivery_person_id, status, delivery_method) 
             VALUES (?, NULL, 'Accepted', 'Seller')`, 
            [orderId]
        );

        res.status(200).json({ success: true, message: 'Pedido despachado! Pronto para a entrega.' });

    } catch (error) {
        console.error('[DELIVERY/DISPATCH] Erro ao despachar pedido:', error);
        res.status(500).json({ success: false, message: 'Erro interno ao despachar.' });
    }
});


// ===================================================================
// ROTAS DE LISTAGEM DE PEDIDOS
// ===================================================================

/**
 * Rota 10: Listar Pedidos da Loja (GET /api/delivery/orders/store/:storeId)
 */
router.get('/delivery/orders/store/:storeId', protectSeller, async (req, res) => {
    const storeId = req.params.storeId;
    const sellerId = req.user.id;

    const [storeCheck] = await pool.execute('SELECT seller_id FROM stores WHERE id = ? AND seller_id = ?', [storeId, sellerId]);
    
    if (storeCheck.length === 0) {
        return res.status(403).json({ success: false, message: 'Acesso negado. Esta loja não pertence a você.' });
    }

    try {
        const [orders] = await pool.execute(
            `SELECT 
                o.id, o.total_amount, o.status, o.delivery_method, o.created_at, o.delivery_code,
                u.full_name AS buyer_name,
                dp.full_name AS delivery_person_name
             FROM orders o
             JOIN users u ON o.buyer_id = u.id
             LEFT JOIN deliveries d ON o.id = d.order_id
             LEFT JOIN users dp ON d.delivery_person_id = dp.id
             WHERE o.store_id = ?
             ORDER BY o.created_at DESC`,
            [storeId]
        );
        
        res.status(200).json({ success: true, orders: orders });

    } catch (error) {
        console.error('[DELIVERY/STORE_ORDERS] Erro ao listar pedidos da loja:', error);
        res.status(500).json({ success: false, message: 'Erro interno ao carregar pedidos.' });
    }
});


/**
 * Rota 11: Comprador lista seus pedidos (GET /api/delivery/orders/mine)
 */
router.get('/delivery/orders/mine', protect, async (req, res) => {
    const buyerId = req.user.id;

    try {
        const [orders] = await pool.execute(
            `SELECT 
                o.id, o.total_amount, o.status, o.delivery_method, o.created_at, o.delivery_code,
                s.name AS store_name,
                dp.full_name AS delivery_person_name
             FROM orders o
             JOIN stores s ON o.store_id = s.id
             LEFT JOIN deliveries d ON o.id = d.order_id
             LEFT JOIN users dp ON d.delivery_person_id = dp.id
             WHERE o.buyer_id = ?
             ORDER BY o.created_at DESC`,
            [buyerId]
        );

        res.status(200).json({ success: true, orders: orders });

    } catch (error) {
        console.error('[DELIVERY/BUYER_ORDERS] Erro ao listar pedidos do comprador:', error);
        res.status(500).json({ success: false, message: 'Erro interno ao carregar pedidos.' });
    }
});


// ===================================================================
// ROTAS DO ENTREGADOR (deliveryPanel.html)
// ===================================================================

/**
 * Rota 4: Entregador: Lista Pedidos Disponíveis (GET /api/delivery/available)
 */
router.get('/delivery/available', protectDeliveryPerson, async (req, res) => {
    if (req.user.is_available === 0) {
         return res.status(200).json({ success: true, message: 'Você está ocupado no momento.', orders: [] });
    }
    
    try {
        const [availableOrders] = await pool.execute(
            `SELECT 
                o.id, o.total_amount, o.delivery_code, 
                s.name AS store_name, u.full_name AS buyer_name
             FROM orders o
             JOIN deliveries d ON o.id = d.order_id
             JOIN stores s ON o.store_id = s.id
             JOIN users u ON o.buyer_id = u.id
             WHERE o.status = 'Delivering' 
               AND d.delivery_person_id IS NULL 
               AND d.status = 'Requested'
             ORDER BY o.created_at ASC`
        );
        
        res.status(200).json({ success: true, orders: availableOrders });
    } catch (error) {
        console.error('[DELIVERY/AVAILABLE] Erro ao listar pedidos:', error);
        res.status(500).json({ success: false, message: 'Erro interno.' });
    }
});

/**
 * Rota 5: Entregador: Aceitar Pedido (PUT /api/delivery/accept/:orderId)
 */
router.put('/delivery/accept/:orderId', protectDeliveryPerson, async (req, res) => {
    const orderId = req.params.orderId;
    const entregadorId = req.user.id;

    if (req.user.is_available === 0) {
        return res.status(400).json({ success: false, message: 'Você já está com uma entrega pendente.' });
    }

    try {
        await pool.query('BEGIN');

        const [deliveryUpdate] = await pool.execute(
            `UPDATE deliveries SET delivery_person_id = ?, status = 'Accepted' 
             WHERE order_id = ? AND status = 'Requested' AND delivery_person_id IS NULL`,
            [entregadorId, orderId]
        );
        
        if (deliveryUpdate.affectedRows === 0) {
            await pool.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'Pedido não disponível ou já aceito.' });
        }

        await pool.execute('UPDATE users SET is_available = FALSE WHERE id = ?', [entregadorId]);

        await pool.query('COMMIT');
        res.status(200).json({ success: true, message: 'Pedido aceito! Boa entrega.' });

    } catch (error) {
        await pool.query('ROLLBACK');
        console.error('[DELIVERY/ACCEPT] Erro ao aceitar pedido:', error);
        res.status(500).json({ success: false, message: 'Erro interno ao aceitar pedido.' });
    }
});


// ===================================================================
// ROTA DE CONFIRMAÇÃO E FLUXO FINANCEIRO
// ===================================================================

/**
 * Rota 6: Confirmação de Entrega (POST /api/delivery/confirm)
 * Confirma a entrega via código e libera os saldos no banco de dados.
 */
router.post('/delivery/confirm', protect, async (req, res) => {
    const userId = req.user.id; 
    const { order_id, confirmation_code } = req.body;

    try {
        await pool.query('BEGIN');
        
        const [orderRows] = await pool.execute(
            `SELECT o.*, s.seller_id, s.contracted_delivery_person_id, d.delivery_person_id 
             FROM orders o
             JOIN stores s ON o.store_id = s.id
             LEFT JOIN deliveries d ON o.id = d.order_id
             WHERE o.id = ? AND o.delivery_code = ? AND o.status = 'Delivering'`,
            [order_id, confirmation_code]
        );

        const order = orderRows[0];
        if (!order) {
            await pool.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'Código ou pedido inválido.' });
        }

        const isDeliveryPerson = (order.delivery_person_id === userId);
        
        // Regra de segurança: Apenas comprador ou o entregador responsável podem confirmar
        if (order.buyer_id !== userId && !isDeliveryPerson) {
             await pool.query('ROLLBACK');
             return res.status(403).json({ success: false, message: 'Apenas o comprador ou entregador atribuído pode confirmar.' });
        }
        
        let paymentMessage = 'Pagamento em processamento.';
        
        // --- Regras Financeiras (Split no DB Local) ---
        // O dinheiro já entrou via MP na criação, aqui liberamos o 'pending_balance'
        
        if (order.delivery_method === 'Seller' || order.delivery_method === 'Contracted') {
            // Entrega Própria: Vendedor recebe tudo (menos taxa MP)
            const marketplaceFee = order.total_amount * MARKETPLACE_FEE_RATE;
            const sellerEarnings = order.total_amount - marketplaceFee; 
            
            await pool.execute(
                'UPDATE users SET pending_balance = pending_balance + ? WHERE id = ?',
                [sellerEarnings, order.seller_id]
            );
            paymentMessage = `Entrega confirmada. R$${sellerEarnings.toFixed(2)} liberados para o vendedor.`;
        }
        else if (order.delivery_method === 'Marketplace' && order.delivery_person_id) {
            // Entrega Marketplace: Entregador recebe a taxa de entrega
            const marketplaceFee = order.total_amount * MARKETPLACE_FEE_RATE;
            const deliveredPayment = DELIVERY_FEE; 
            const sellerEarnings = order.total_amount - marketplaceFee - deliveredPayment; 
            
            // 1. Credita Entregador
            await pool.execute(
                'UPDATE users SET pending_balance = pending_balance + ? WHERE id = ?',
                [deliveredPayment, order.delivery_person_id]
            );
            
            // 2. Credita Vendedor
             await pool.execute(
                'UPDATE users SET pending_balance = pending_balance + ? WHERE id = ?',
                [sellerEarnings, order.seller_id]
            );

            // 3. Libera Entregador
            await pool.execute('UPDATE users SET is_available = TRUE WHERE id = ?', [order.delivery_person_id]);
            
            paymentMessage = `Entrega Marketplace confirmada. Créditos distribuídos.`;
        }
        
        // 4. Finaliza Pedido
        await pool.execute('UPDATE orders SET status = "Completed" WHERE id = ?', [order_id]);
        await pool.execute('UPDATE deliveries SET status = "Delivered_Confirmed", buyer_confirmation_at = NOW() WHERE order_id = ?', [order_id]);

        await pool.query('COMMIT');
        res.status(200).json({ success: true, message: `Entrega confirmada. ${paymentMessage}` });

    } catch (error) {
        await pool.query('ROLLBACK');
        console.error('[DELIVERY/CONFIRM] Erro ao confirmar entrega:', error);
        res.status(500).json({ success: false, message: 'Erro interno ao confirmar entrega.' });
    }
});


/**
 * Rota 8: Checar Status do Pedido (Polling)
 */
router.get('/delivery/orders/:orderId/status', protect, async (req, res) => {
    const orderId = req.params.orderId;
    const buyerId = req.user.id;

    try {
        const [orderRows] = await pool.execute(
            "SELECT status, delivery_code FROM orders WHERE id = ? AND buyer_id = ?",
            [orderId, buyerId]
        );

        const order = orderRows[0];

        if (!order) {
            return res.status(404).json({ success: false, message: 'Pedido não encontrado ou não pertence a você.' });
        }

        res.status(200).json({ success: true, status: order.status, delivery_code: order.delivery_code });

    } catch (error) {
        console.error('[STATUS] Erro ao checar status do pedido:', error.message);
        res.status(500).json({ success: false, message: 'Erro interno.' });
    }
});


module.exports = router;
