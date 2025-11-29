// prp-main/logisticsAndConfirmationRoutes.js

const express = require('express');
const router = express.Router();
const pool = require('./config/db');
const { protectSeller } = require('./sellerAuthMiddleware'); 
const { protect } = require('./authMiddleware'); 
// ! CRÍTICO: Importa o serviço de notificação
const { sendNotification } = require('./notificacao'); 

const MARKETPLACE_FEE_RATE = 0.00; // MODIFICADO PARA MONO-LOJA (SEM COMISSÃO)


// ===================================================================
// ROTAS DO LOJISTA (PAINEL) - MODIFICADAS PARA SELF-DELIVERY
// ===================================================================

/**
 * Rota 3: GET Detalhes Completos de um Pedido Específico (PARA order_details.html)
 */
router.get('/orders/:orderId/details', protectSeller, async (req, res) => {
    const orderId = req.params.orderId;
    const sellerId = req.user.id;

    try {
        // 1. Busca Detalhes Principais e faz a verificação de propriedade
        const [orderRows] = await pool.execute(
            `SELECT 
                o.id, o.status, o.total_amount AS total_value, o.created_at,
                o.delivery_pickup_code, 
                u.full_name AS client_name, u.email AS client_email, 
                o.delivery_method, o.delivery_cost, 
                o.buyer_whatsapp_number, o.delivery_address_street, o.delivery_address_number,
                o.delivery_address_nearby,
                s.seller_id, s.id AS store_id,
                c.name AS city_name,
                d.name AS district_name 
             FROM orders o
             JOIN stores s ON o.store_id = s.id
             JOIN users u ON o.buyer_id = u.id 
             LEFT JOIN cities c ON o.delivery_city_id = c.id
             LEFT JOIN districts d ON o.delivery_district_id = d.id 
             WHERE o.id = ? AND s.seller_id = ?`,
            [orderId, sellerId]
        );

        const order = orderRows[0];

        if (!order) {
            return res.status(404).json({ success: false, message: 'Pedido não encontrado ou acesso negado.' });
        }

        // 2. Busca os Itens do Pedido (incluindo attributes_json)
        const [itemRows] = await pool.execute(
            `SELECT 
                product_name, quantity, price, attributes_json
             FROM order_items 
             WHERE order_id = ?`,
            [orderId]
        );

        // 3. Consolida e Retorna
        const orderDetails = {
            ...order,
            delivery_code: null, 
            total_value: parseFloat(order.total_value),
            delivery_cost: parseFloat(order.delivery_cost || 0),
            items: itemRows.map(item => ({
                ...item,
                attributes_json: item.attributes_json ? JSON.parse(item.attributes_json) : null 
            })),
        };

        res.status(200).json({ success: true, order: orderDetails });

    } catch (error) {
        console.error('Erro ao buscar detalhes do pedido:', error);
        res.status(500).json({ success: false, message: 'Erro interno ao carregar detalhes do pedido.' });
    }
});


/**
 * Rota X: PUT Despachar o Pedido
 */
router.put('/orders/:orderId/dispatch', protectSeller, async (req, res) => {
    const orderId = req.params.orderId;
    const sellerId = req.user.id;
    
    try {
        await pool.query('BEGIN'); 

        // CRÍTICO: Seleciona o buyer_id para o disparo da notificação
        const [orderCheck] = await pool.execute(
            `SELECT o.id, o.buyer_id FROM orders o 
             JOIN stores s ON o.store_id = s.id 
             WHERE o.id = ? AND s.seller_id = ? AND o.status = 'Processing'`,
            [orderId, sellerId]
        );

        const order = orderCheck[0];

        if (orderCheck.length === 0) {
            await pool.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'Pedido não encontrado ou status inválido ("Processing" esperado).' });
        }
        
        await pool.execute("UPDATE orders SET status = 'Delivering', delivery_method = 'Seller' WHERE id = ?", [orderId]);
        
        await pool.execute(
             `INSERT INTO deliveries (order_id, delivery_method, status, packing_start_time)
              VALUES (?, 'Seller', 'Accepted', NOW())
              ON DUPLICATE KEY UPDATE status = 'Accepted', packing_start_time = NOW(), delivery_method = 'Seller'`,
            [orderId]
        );
        
        await pool.query('COMMIT'); 
        
        // #################################################
        // ! NOVO: BUSCA TOKEN E ENVIA NOTIFICAÇÃO
        // #################################################
        if (order && order.buyer_id) {
             // Esta query SELECT fcm_token é o que falhou no log anterior!
             const [buyer] = await pool.execute('SELECT fcm_token FROM users WHERE id = ?', [order.buyer_id]);
             const fcmToken = buyer[0]?.fcm_token;
             
             if (fcmToken) {
                 sendNotification(
                     fcmToken,
                     '🚀 Seu pedido saiu para entrega!',
                     'O lojista despachou seu pedido. Aguarde para receber.',
                     { 
                         orderId: orderId.toString(),
                         eventType: 'order_dispatched' 
                     }
                 );
             } else {
                 // Esta mensagem foi vista no seu log
                 console.warn(`[NOTIFICAÇÃO] Usuário ${order.buyer_id} não possui FCM Token salvo.`);
             }
        }
        // #################################################

        res.status(200).json({ success: true, message: 'Pedido despachado! Pronto para a entrega própria.' });

    } catch (error) {
        await pool.query('ROLLBACK');
        console.error('[DELIVERY/DISPATCH] Erro:', error);
        res.status(500).json({ success: false, message: 'Erro interno.' });
    }
});

/**
 * Rota 6: Confirmação de Entrega (POST /api/confirm) - Lógica de validação mantida no backend
 */
router.post('/confirm', protect, async (req, res) => {
    const userId = req.user.id; 
    const { order_id, confirmation_code } = req.body;

    try {
        await pool.query('BEGIN');
        
        // 1. Busca o pedido e verifica o status E o código DE ENTREGA
        const [orderRows] = await pool.execute(
            `SELECT o.*, s.seller_id, d.delivery_person_id 
             FROM orders o
             JOIN stores s ON o.store_id = s.id
             LEFT JOIN deliveries d ON o.id = d.order_id
             WHERE o.id = ? AND o.delivery_code = ? AND o.status = 'Delivering'`, 
            [order_id, confirmation_code]
        );

        const order = orderRows[0];
        if (!order) {
            await pool.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'Código, pedido ou status inválido.' }); 
        }

        // 2. Permissão 
        const isSellerSelfDelivery = (order.delivery_method === 'Seller' && order.seller_id === userId);
        
        if (!isSellerSelfDelivery && order.buyer_id !== userId) {
             await pool.query('ROLLBACK');
             return res.status(403).json({ success: false, message: 'Apenas o vendedor (entrega própria) ou o comprador podem confirmar esta entrega.' });
        }
        
        let paymentMessage = 'Pagamento em processamento.';
        
        // 3. Processamento Financeiro
        // A taxa é 0.00, então o valor total é creditado ao vendedor
        const sellerEarnings = order.total_amount; // MODIFICADO: order.total_amount - (order.total_amount * MARKETPLACE_FEE_RATE)
        
        await pool.execute(
            'UPDATE users SET pending_balance = pending_balance + ? WHERE id = ?',
            [sellerEarnings, order.seller_id]
        );
        paymentMessage = `R$${sellerEarnings.toFixed(2)} creditados ao vendedor (Total do Pedido).`; // Mensagem ajustada
        
        // 4. Atualiza status
        await pool.execute('UPDATE orders SET status = "Completed" WHERE id = ?', [order_id]); 
        await pool.execute(
            'UPDATE deliveries SET status = "Delivered_Confirmed", delivery_time = NOW(), buyer_confirmation_at = NOW() WHERE order_id = ?', 
            [order_id]
        );

        await pool.query('COMMIT');
        res.status(200).json({ success: true, message: `Entrega confirmada. ${paymentMessage}` });

    } catch (error) {
        await pool.query('ROLLBACK');
        console.error('[DELIVERY/CONFIRM] Erro ao confirmar entrega:', error);
        res.status(500).json({ success: false, message: 'Erro interno ao confirmar entrega.' });
    }
});


module.exports = router;
