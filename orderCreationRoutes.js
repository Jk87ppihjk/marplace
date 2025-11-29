// ! Arquivo: prp-main/orderCreationRoutes.js (FINAL COMPLETO E CORRIGIDO)

const express = require('express');
const router = express.Router();
const pool = require('./config/db');
const { protectSeller } = require('./sellerAuthMiddleware'); 
const { protectDeliveryPerson } = require('./deliveryAuthMiddleware');
const { protect, protectWithAddress } = require('./authMiddleware'); 

const { MercadoPagoConfig, Preference } = require('mercadopago');

// --- Constantes Comuns ---
const MARKETPLACE_FEE_RATE = 0.00; // MODIFICADO PARA MONO-LOJA (SEM COMISSÃO)
const DELIVERY_FEE_FALLBACK = 5.00; 


// ===================================================================
// FUNÇÃO 1: ATRIBUIÇÃO DE VENDA FY
// ===================================================================

async function attributeSaleToVideo(videoId) {
    try {
        const [result] = await pool.query(
            // Atualiza o contador de vendas no vídeo Fy
            'UPDATE fy_videos SET ad_attributed_sales_count = ad_attributed_sales_count + 1 WHERE id = ?',
            [videoId]
        );
        
        if (result.affectedRows > 0) {
            console.log(`[ATRIBUIÇÃO SUCESSO] Venda atribuída ao vídeo FY ID: ${videoId}`);
        } else {
             console.warn(`[ATRIBUIÇÃO AVISO] Falha na atribuição: Vídeo FY ID ${videoId} não encontrado no DB.`);
        }
    } catch (error) {
        console.error(`[ATRIBUIÇÃO ERRO CRÍTICO] Falha ao atribuir venda ao vídeo ID: ${videoId}`, error);
    }
}


// ===================================================================
// FUNÇÃO 2: CRIAÇÃO DE PEDIDO E CÓDIGOS (Lógica central de salvamento no DB)
// ===================================================================
const createOrderAndCodes = async (buyerId, storeId, totalAmount, totalFrete, initialStatus, transactionId, items, addressSnapshot, sourceVideoId) => { 
    const deliveryCode = Math.random().toString(36).substring(2, 8).toUpperCase(); 
    const pickupCode = Math.random().toString(36).substring(2, 7).toUpperCase(); 

    // 1. Insere o pedido principal (orders), incluindo o source_video_id
    const [orderResult] = await pool.execute(
        `INSERT INTO orders (
            buyer_id, store_id, total_amount, delivery_cost, status, delivery_code, payment_transaction_id, delivery_pickup_code,
            delivery_city_id, delivery_district_id, delivery_address_street, 
            delivery_address_number, delivery_address_nearby, buyer_whatsapp_number, source_video_id
         ) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, 
        [
            buyerId, storeId, totalAmount, totalFrete, initialStatus, deliveryCode, transactionId, pickupCode,
            addressSnapshot.city_id, 
            addressSnapshot.district_id,
            addressSnapshot.address_street, 
            addressSnapshot.address_number, 
            addressSnapshot.address_nearby, 
            addressSnapshot.whatsapp_number,
            sourceVideoId || null 
        ]
    );
    const orderId = orderResult.insertId;

    // 2. Salvar os Itens (order_items) e Baixar Estoque
    for (const item of items) {
        const productId = parseInt(item.product_id, 10) || parseInt(item.id, 10);
        const quantity = parseInt(item.quantity || item.qty, 10);
        
        const price = parseFloat(item.unit_price || item.product_price || item.price || 0); 
        const name = item.product_name || item.name || 'Produto';
        
        const attributesToSave = item.options || item.selected_options || item.attributes_data || {};
        const attributes = JSON.stringify(attributesToSave);

        console.log(`[ORDER CREATION LOG - ITEM ${orderId}] Nome: ${name} | Preço Unitário: ${price.toFixed(2)} | Qtd: ${quantity} | Atributos JSON (para DB): ${attributes}`);

        if (!productId || isNaN(quantity) || quantity < 1) {
             throw new Error('Item inválido no carrinho durante a criação do pedido.');
        }

        // A. INSERE NA TABELA DE ITENS
        await pool.execute(
            `INSERT INTO order_items (order_id, product_id, product_name, quantity, price, attributes_json) 
             VALUES (?, ?, ?, ?, ?, ?)`,
            [orderId, productId, name, quantity, price, attributes]
        );

        // B. ATUALIZA O ESTOQUE
        const [stockUpdate] = await pool.execute(
            'UPDATE products SET stock_quantity = stock_quantity - ? WHERE id = ? AND stock_quantity >= ?',
            [quantity, productId, quantity]
        );
        if (stockUpdate.affectedRows === 0) {
            throw new Error(`Estoque insuficiente para o item ID ${productId}. O pedido será cancelado.`);
        }
    }
    
    return { orderId, deliveryCode, pickupCode };
};


// ===================================================================
// FUNÇÃO 3: CÁLCULO DE TOTAL DINÂMICO
// ===================================================================
const calculateDynamicTotal = async (items, buyerCityId, buyerDistrictId) => { 
    
    const productIds = items
        .map(item => parseInt(item.product_id, 10))
        .filter(id => !isNaN(id) && id > 0);

    if (productIds.length === 0) {
         throw new Error('Carrinho vazio ou contendo apenas itens inválidos.');
    }
    
    const idList = productIds.join(','); 
    
    const [products] = await pool.query(
        `SELECT p.id, p.price, p.shipping_options, s.id AS store_id, s.city_id AS store_city_id 
         FROM products p JOIN stores s ON p.seller_id = s.seller_id 
         WHERE p.id IN (${idList})` 
    );
    
    if (products.length === 0) {
        throw new Error('Nenhum produto válido encontrado no banco de dados.');
    }

    const productMap = products.reduce((map, p) => {
        map[p.id] = p;
        return map;
    }, {});
    
    let subTotalProdutos = 0;
    const lojasUnicas = new Set();
    const storeFreteCosts = {}; 
    
    for (const item of items) {
        const productIdNum = parseInt(item.product_id, 10);
        const productInfo = productMap[productIdNum];

        if (!productInfo) continue; 

        const storeId = productInfo.store_id;
        
        const itemQuantity = parseInt(item.quantity || item.qty || 0, 10);
        if (itemQuantity === 0) continue; 

        const itemPrice = parseFloat(item.unit_price || item.product_price || productInfo.price || 0);
        subTotalProdutos += itemPrice * itemQuantity; 
        
        lojasUnicas.add(storeId);
        
        if (!storeFreteCosts[storeId]) {
            let freteCost = DELIVERY_FEE_FALLBACK;
            
            if (productInfo.shipping_options && buyerCityId) {
                try {
                    const shippingOptions = JSON.parse(productInfo.shipping_options);
                    const isLocal = productInfo.store_city_id == buyerCityId;
                    let foundOption = null;
                    
                    if (isLocal && buyerDistrictId) {
                        foundOption = shippingOptions.find(opt => opt.city_id == buyerCityId && opt.district_id == buyerDistrictId);
                    } 
                    
                    if (!foundOption) {
                        foundOption = shippingOptions.find(opt => opt.city_id == buyerCityId && (opt.district_id === null || opt.district_id === ''));
                    }

                    if (foundOption) {
                        freteCost = parseFloat(foundOption.cost);
                    } else {
                        console.warn(`[CALC] Frete não definido para City ${buyerCityId} e District ${buyerDistrictId}. Usando fallback.`);
                    }

                } catch (e) {
                    console.error('[CALC] Erro ao fazer parse do JSON de frete. Usando fallback.', e.message);
                }
            }
            storeFreteCosts[storeId] = freteCost; 
        }
    }
    
    let freteTotal = 0;
    Object.values(storeFreteCosts).forEach(cost => {
        freteTotal += cost;
    });

    const valorTotal = subTotalProdutos + freteTotal;
    
    return { valorTotal: parseFloat(valorTotal.toFixed(2)), freteTotal: parseFloat(freteTotal.toFixed(2)), subTotalProdutos: parseFloat(subTotalProdutos.toFixed(2)), numeroDeLojas: lojasUnicas.size };
};


// ===================================================================
// FUNÇÃO 4: CRIAÇÃO DE PREFERÊNCIA MERCADO PAGO
// ===================================================================
async function createMercadoPagoPreference(productId, payerEmail, totalAmount, orderId, sellerToken, sellerId) {
    if (!sellerToken) {
      throw new Error('Vendedor ou Token de Produção não encontrado no DB.');
    }

    const marketplaceFeeAmount = parseFloat((totalAmount * MARKETPLACE_FEE_RATE).toFixed(2));
    console.log(`[MP/PREF] Pedido #${orderId} | Total: ${totalAmount} | Fee (Marketplace Fee): ${marketplaceFeeAmount} | Vendedor: ${sellerId}`);
    
    const sellerClient = new MercadoPagoConfig({ accessToken: sellerToken });
    const preference = new Preference(sellerClient);

    const body = {
      items: [{
          id: productId.toString(),
          title: `Pedido #${orderId} - Marketplace`,
          description: `Pagamento referente ao pedido ${orderId}`,
          unit_price: parseFloat(totalAmount), 
          quantity: 1,
        }],
      payer: { email: payerEmail },
      // marketplace_fee: marketplaceFeeAmount, // REMOVIDO: Nenhuma taxa será retida pelo MP para o marketplace, vai direto para o vendedor.
      external_reference: orderId.toString(), 
      payment_methods: { installments: 1 },
      back_urls: {
        success: `${process.env.FRONTEND_URL}/meus-pedidos?status=success&order_id=${orderId}`,
        failure: `${process.env.FRONTEND_URL}/meus-pedidos?status=failure&order_id=${orderId}`,
      },
      notification_url: `${process.env.BACKEND_URL}/api/mp/webhook-mp`, 
    };

    const response = await preference.create({ body });
    
    return { 
        init_point: response.init_point,
        preference_id: response.id 
    };
}


// ===================================================================
// ROTA 1: CRIAÇÃO DE PEDIDOS REAL (`/orders`)
// ===================================================================
router.post('/orders', [protect, protectWithAddress], async (req, res) => {
    const buyerId = req.user.id;
    const { items, source_video_id } = req.body; 
    
    const addressSnapshot = { ...req.user };
    const payerEmail = req.user.email; 
    
    const buyerCityId = req.user.city_id; 
    const buyerDistrictId = req.user.district_id;

    if (!items || items.length === 0) {
        return res.status(400).json({ success: false, message: 'Carrinho vazio.' });
    }
    
    let orderId; 

    try {
        const { valorTotal, freteTotal, numeroDeLojas } = await calculateDynamicTotal(items, buyerCityId, buyerDistrictId); 
        
        // if (numeroDeLojas !== 1) { // <--- REMOVIDO: APLICAÇÃO MONO-LOJA
        //      return res.status(400).json({ success: false, message: 'Por favor, crie um pedido separado para cada loja.' });
        // }
        
        const productIds = items.map(item => parseInt(item.product_id, 10)).filter(id => !isNaN(id) && id > 0);
        const [products] = await pool.execute('SELECT s.id AS store_id, s.seller_id FROM products p JOIN stores s ON p.seller_id = s.seller_id WHERE p.id = ? LIMIT 1', [productIds[0]]);
        
        if (!products[0]) throw new Error('Produto ou loja não encontrados.');

        const store_id = products[0].store_id;
        const seller_id = products[0].seller_id;
        const firstProductId = productIds[0].toString();
        
        // Busca token do vendedor (CRÍTICO)
        const [sellerRows] = await pool.execute('SELECT mp_access_token FROM users WHERE id = ? LIMIT 1', [seller_id]);

        if (!sellerRows[0] || !sellerRows[0].mp_access_token) {
            throw new Error(`O vendedor (ID: ${seller_id}) não conectou sua conta do Mercado Pago.`);
        }
        const sellerToken = sellerRows[0].mp_access_token;
        
        // --- TRANSAÇÃO SQL INICIA AQUI ---
        await pool.query('BEGIN'); 
        
        // 1. CRIAÇÃO DO PEDIDO (Status: Pending Payment)
        const orderData = await createOrderAndCodes(
            buyerId, store_id, valorTotal, freteTotal, 'Pending Payment', 
            'TEMP_MP_ID', // Placeholder inicial
            items, addressSnapshot,
            source_video_id // Envia o ID do vídeo Fy para ser salvo na tabela orders
        );
        orderId = orderData.orderId; 

        // 2. GERA PREFERÊNCIA MP
        const { init_point, preference_id } = await createMercadoPagoPreference(
            firstProductId, payerEmail, valorTotal, orderId, sellerToken, seller_id
        );

        // 3. ATUALIZA O PEDIDO com o ID da Preferência MP
        await pool.execute('UPDATE orders SET payment_transaction_id = ? WHERE id = ?', [preference_id, orderId]);
        
        // 4. CONFIRMA A TRANSAÇÃO
        await pool.query('COMMIT'); 
        // --- TRANSAÇÃO SQL FINALIZA AQUI ---
        
        // RASTREIO DE VENDA FY (Executado após o COMMIT)
        if (source_video_id) {
            attributeSaleToVideo(source_video_id);
        }

        res.status(201).json({ 
            success: true, 
            message: 'Pedido criado. Redirecionando para pagamento.', 
            order_id: orderId,
            total_amount: valorTotal, 
            init_point: init_point 
        });

    } catch (error) {
        await pool.query('ROLLBACK'); 
        // 🚨 LOG CRÍTICO DETALHADO: Irá mostrar a causa exata do ROLLBACK
        console.error(`[ORDERS] ERRO FATAL NO CHECKOUT. O pedido ID ${orderId} foi cancelado no DB. Causa:`, error.message, error.stack);
        
        // Mensagem de erro mais clara para o Frontend
        res.status(500).json({ success: false, message: `Erro interno ao processar pedido: ${error.message}.`, error: error.message });
    }
});


// ===================================================================
// ROTA 2: CRIAÇÃO DE PEDIDOS SIMULADA (`/orders/simulate-purchase`)
// ===================================================================
router.post('/orders/simulate-purchase', [protect, protectWithAddress], async (req, res) => {
    const buyerId = req.user.id;
    const { items, source_video_id } = req.body;
    
    const addressSnapshot = { ...req.user }; 
    const buyerCityId = req.user.city_id; 
    const buyerDistrictId = req.user.district_id;

    if (!items || items.length === 0) return res.status(400).json({ success: false, message: 'Carrinho vazio.' });

    let orderId;

    try {
        const { valorTotal, freteTotal, numeroDeLojas } = await calculateDynamicTotal(items, buyerCityId, buyerDistrictId);

        // if (numeroDeLojas !== 1) return res.status(400).json({ success: false, message: 'Apenas mono-loja.' }); // <--- REMOVIDO: APLICAÇÃO MONO-LOJA

        const productIds = items.map(item => parseInt(item.product_id, 10));
        const [products] = await pool.execute('SELECT s.id AS store_id FROM products p JOIN stores s ON p.seller_id = s.seller_id WHERE p.id = ? LIMIT 1', [productIds[0]]);
        const store_id = products[0].store_id;

        // --- TRANSAÇÃO SQL INICIA AQUI ---
        await pool.query('BEGIN');

        // 1. CRIAÇÃO DO PEDIDO (Status: Processing)
        const orderData = await createOrderAndCodes(
            buyerId, store_id, valorTotal, freteTotal, 'Processing', // Status 'Processing' é a diferença
            'SIMULATED_PURCHASE', 
            items, addressSnapshot,
            source_video_id // Envia o ID do vídeo Fy para ser salvo na tabela orders
        );
        orderId = orderData.orderId;

        // 2. CONFIRMA A TRANSAÇÃO
        await pool.query('COMMIT');
        // --- TRANSAÇÃO SQL FINALIZA AQUI ---
        
        // RASTREIO DE VENDA FY (Executado após o COMMIT)
        if (source_video_id) {
            attributeSaleToVideo(source_video_id);
        }

        res.status(201).json({ 
            success: true, 
            message: 'Pedido simulado criado (status: Processing). Itens salvos.', 
            order_id: orderId, 
            total_amount: valorTotal, 
            status: 'Processing' 
        });

    } catch (error) {
        await pool.query('ROLLBACK');
        console.error('[SIMULATE] ERRO FATAL NO CHECKOUT SIMULADO. Causa:', error.message, error.stack);
        res.status(500).json({ success: false, message: error.message });
    }
});


module.exports = router;
