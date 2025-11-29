// ! Arquivo: trackingAndDataRoutes.js (CORRIGIDO: delivery_code removido da lista de pedidos do vendedor)

const express = require('express');
const router = express.Router();
const pool = require('./config/db');
const { protectSeller } = require('./sellerAuthMiddleware'); 
const { protect } = require('./authMiddleware'); 
const { getBuyerTrackingMessage, getSellerMetrics } = require('./trackingService'); 

const MARKETPLACE_FEE_RATE = 0.00; // MODIFICADO PARA MONO-LOJA (SEM COMISSÃO)

// ===================================================================
// ROTAS DE LISTAGEM DE PEDIDOS
// ===================================================================

/**
 * Rota 10: Listar Pedidos da Loja (Vendedor)
 * CRÍTICO: Removido 'o.delivery_code' da seleção para evitar fraude pelo vendedor.
 */
router.get('/orders/store/:storeId', protectSeller, async (req, res) => {
    const storeId = req.params.storeId;
    const sellerId = req.user.id;

    const [storeCheck] = await pool.execute('SELECT seller_id FROM stores WHERE id = ? AND seller_id = ?', [storeId, sellerId]);
    if (storeCheck.length === 0) return res.status(403).json({ success: false, message: 'Acesso negado.' });

    try {
        // 1. Busca Pedidos (SEM o.delivery_code)
        const [orders] = await pool.execute(
            `SELECT 
                o.id, o.total_amount, o.status, o.delivery_method, o.created_at, 
                d.status AS delivery_status,
                u.full_name AS buyer_name,
                u.email AS buyer_email,
                o.delivery_address_street,
                o.delivery_address_number,
                o.delivery_address_nearby,
                o.buyer_whatsapp_number,
                c.name AS city_name, 
                dt.name AS district_name 
             FROM orders o
             JOIN users u ON o.buyer_id = u.id
             LEFT JOIN deliveries d ON o.id = d.order_id
             LEFT JOIN cities c ON o.delivery_city_id = c.id
             LEFT JOIN districts dt ON o.delivery_district_id = dt.id 
             WHERE o.store_id = ?
             ORDER BY o.created_at DESC`,
            [storeId]
        );
        
        // 2. ! POPULATE: Busca os Itens de cada pedido
        for (const order of orders) {
            const [items] = await pool.execute(
                `SELECT product_name, quantity, attributes_json, price 
                 FROM order_items WHERE order_id = ?`, 
                [order.id]
            );
            
            order.items = items.map(item => ({
                ...item,
                attributes_json: item.attributes_json ? JSON.parse(item.attributes_json) : null
            }));
        }

        res.status(200).json({ success: true, orders: orders });

    } catch (error) {
        console.error('[DELIVERY/STORE_ORDERS] Erro:', error);
        res.status(500).json({ success: false, message: 'Erro interno.' });
    }
});


/**
 * Rota X: Listar Pedidos (Comprador)
 * CRÍTICO: Mantido o.delivery_code, pois o comprador precisa dele.
 */
router.get('/orders/mine', protect, async (req, res) => {
    const buyerId = req.user.id; 
    try {
        const [orders] = await pool.execute(
            `SELECT 
                o.id, o.total_amount, o.status, o.delivery_method, o.created_at, o.delivery_code, 
                s.name AS store_name,
                d.status AS delivery_status, d.packing_start_time, 
                o.delivery_method AS d_method 
             FROM orders o
             JOIN stores s ON o.store_id = s.id
             LEFT JOIN deliveries d ON o.id = d.order_id
             WHERE o.buyer_id = ?
             ORDER BY o.created_at DESC`,
            [buyerId]
        );
        
        for (const order of orders) {
            const [items] = await pool.execute('SELECT product_name, quantity, attributes_json FROM order_items WHERE order_id = ?', [order.id]);
            order.items = items;
            order.tracking_message = getBuyerTrackingMessage(order, { 
                status: order.delivery_status, 
                delivery_method: order.d_method 
            });
        }

        res.status(200).json({ success: true, orders: orders });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Erro interno.' });
    }
});


// Rota 8: Polling de Status
router.get('/orders/:orderId/status', protect, async (req, res) => {
    const [orderRows] = await pool.execute(
        `SELECT o.status, o.delivery_code, d.status as delivery_status 
         FROM orders o LEFT JOIN deliveries d ON o.id = d.order_id 
         WHERE o.id = ? AND o.buyer_id = ?`, 
        [req.params.orderId, req.user.id]
    );
    if(!orderRows[0]) return res.status(404).json({success:false});
    res.json({success:true, status: orderRows[0].status, delivery_code: orderRows[0].delivery_code});
});

// Rota 13: Métricas do Vendedor
router.get('/users/seller/metrics', protectSeller, async (req, res) => {
    const sellerId = req.user.id; 
    try {
        const [userRows] = await pool.execute("SELECT pending_balance FROM users WHERE id = ?", [sellerId]);
        const metrics = await getSellerMetrics(sellerId);
        res.status(200).json({
            success: true,
            balance: { pending_balance: userRows[0].pending_balance || 0 },
            // MUDANÇA CRÍTICA: Taxa agora é 0%
            financial_info: { marketplace_fee_rate: MARKETPLACE_FEE_RATE * 100, pricing_note: "Taxa 0% (Split de Pagamento Desativado)" },
            metrics: metrics
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Erro métricas.' });
    }
});

module.exports = router;
