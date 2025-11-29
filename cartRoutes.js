// ! Arquivo: prp-main/cartRoutes.js (FINAL COM CORREÇÃO DE DUPLICAÇÃO DE ITENS)

const express = require('express');
const router = express.Router();
const pool = require('./config/db');
const { protect } = require('./authMiddleware');

const DELIVERY_FEE = 5.00; // Valor de Frete Padrão (Usado como fallback)

// ===================================================================
// FUNÇÃO HELPER: PADRONIZAÇÃO DE OPÇÕES (CRÍTICO PARA CART)
// ===================================================================
/**
 * Garante que o objeto de opções tenha as chaves ordenadas,
 * resultando em um JSON string determinístico.
 * Isso resolve o problema de duplicação de itens no carrinho.
 * @param {object} options
 * @returns {object} Objeto com chaves ordenadas.
 */
const standardizeOptions = (options) => {
    if (!options || typeof options !== 'object') return {};
    const sortedKeys = Object.keys(options).sort();
    return sortedKeys.reduce((acc, key) => {
        acc[key] = options[key];
        return acc;
    }, {});
};


// ******************************************************************
// FUNÇÃO DE CÁLCULO (calculateCartBreakdown)
// ******************************************************************
const calculateCartBreakdown = async (items, buyerCityId, buyerDistrictId) => { 
    
    console.log('[CART/CALC] Iniciando cálculo. Buyer City ID:', buyerCityId, 'Buyer District ID:', buyerDistrictId);

    const productIds = items
        .map(item => parseInt(item.product_id, 10)) 
        .filter(id => !isNaN(id) && id > 0);
    
    if (productIds.length === 0) {
        return {
            success: true,
            valorTotal: 0,
            freteTotal: 0,
            subTotalGeral: 0,
            numeroDeLojas: 0,
            cartBreakdown: [],
        };
    }

    const idList = productIds.join(','); 
    
    // CORREÇÃO DE SINTAXE SQL: Alinhamento e remoção da indentação
    const [products] = await pool.query(
        `SELECT p.id, p.name, p.price, p.image_url, p.shipping_options, p.attributes_data, p.stock_quantity,
s.id AS store_id, s.name AS store_name, s.city_id AS store_city_id
FROM products p JOIN stores s ON p.seller_id = s.seller_id
WHERE p.id IN (${idList})` 
    );
    
    if (products.length === 0) {
        throw new Error("Nenhum produto encontrado no carrinho.");
    }

    const productMap = {};
    products.forEach(p => { productMap[p.id] = p; });

    const cartByStore = {};
    const lojasUnicas = new Set();
    let subTotalGeral = 0;
    
    for (const item of items) {
        const productId = item.product_id;
        // CRÍTICO: Garantir que quantity é um número, ou usar 1 como fallback
        const quantity = parseInt(item.qty || item.quantity || 1, 10); 
        const options = item.options || {}; 

        const productInfo = productMap[productId];
        if (!productInfo) {
            console.warn(`[CART/CALC] Produto ID ${productId} não encontrado ou inativo. Pulando.`);
            continue;
        }

        // --- VALIDAÇÃO DE ESTOQUE POR VARIAÇÃO (Simplificada) ---
        let availableStock = productInfo.stock_quantity; 
        let finalImageUrl = productInfo.image_url;
        // CORREÇÃO DE PREÇO NULO (Fallback)
        let itemPrice = parseFloat(productInfo.price || 0); 

        // CRÍTICO: Se o frontend enviou unit_price (que já foi corrigido), usá-lo como base
        if (item.unit_price) {
            itemPrice = parseFloat(item.unit_price || 0);
        }

        try {
            if (productInfo.attributes_data) {
                const attributesData = JSON.parse(productInfo.attributes_data);
                const variations = attributesData.variations || [];
                
                let foundVariation = null;
                
                if (Object.keys(options).length > 0 && variations.length > 0) {
                    foundVariation = variations.find(v => {
                        const vOptions = v.options || {};
                        return Object.keys(options).every(key => vOptions[key] === options[key]);
                    });
                }
                
                if (foundVariation) {
                    availableStock = foundVariation.stock || 0;
                    // CORREÇÃO DE PREÇO NULO (Fallback)
                    itemPrice = parseFloat(foundVariation.price || 0) || itemPrice;
                    
                    if (foundVariation.image_url) {
                        finalImageUrl = foundVariation.image_url;
                    }
                } else if (variations.length > 0 && Object.keys(options).length > 0) {
                     throw new Error(`Variação não encontrada para o Produto ID ${productId} com as opções: ${JSON.stringify(options)}.`);
                }
            }
        } catch (e) {
            console.error(`[CART/CALC] Erro ao validar estoque/parsing JSON para produto ${productId}: ${e.message}`);
            throw new Error(`Erro ao processar o carrinho: ${e.message}`);
        }
        
        if (quantity > availableStock) {
            throw new Error(`Estoque insuficiente para a variação selecionada do produto ID ${productId}. Disponível: ${availableStock}`);
        }
        // --- FIM DA VALIDAÇÃO DE ESTOQUE ---

        // CORREÇÃO DE PREÇO NULO (Fallback)
        const itemTotal = parseFloat((itemPrice || 0) * quantity);

        // LOG ESTRATÉGICO
        console.log(`[LOG-ITEM] Produto ID ${productId}: Preço Unitário: ${itemPrice}, Qtd: ${quantity}, Total Item: ${itemTotal}`);


        const storeId = productInfo.store_id;
        const storeName = productInfo.store_name;
        
        if (!cartByStore[storeId]) {
            let freteCost = DELIVERY_FEE; 
            const isLocal = productInfo.store_city_id == buyerCityId;
            
            if (productInfo.shipping_options && buyerCityId) {
                try {
                    const shippingOptions = JSON.parse(productInfo.shipping_options);
                    let foundOption = null;

                    if (isLocal && buyerDistrictId) {
                        foundOption = shippingOptions.find(opt => opt.city_id == buyerCityId && opt.district_id == buyerDistrictId && opt.district_id !== null && opt.district_id !== '');
                    } 
                    
                    if (!foundOption) {
                        foundOption = shippingOptions.find(opt => opt.city_id == buyerCityId && (opt.district_id === null || opt.district_id === ''));
                    }

                    if (foundOption) {
                        freteCost = parseFloat(foundOption.cost);
                    } else {
                        console.log(`[CART/CALC] Nenhuma regra de frete específica encontrada para City ${buyerCityId}. Usando fallback: R$${DELIVERY_FEE.toFixed(2)}`);
                    }

                } catch (e) {
                    console.error('[CART/CALC] Erro ao fazer parse/cálculo do JSON de frete:', e.message);
                    freteCost = DELIVERY_FEE; 
                }
            } else if (productInfo.shipping_options && !buyerCityId) {
                 console.warn('[CART/CALC] Produto com opções de frete, mas City ID do comprador não fornecido. Usando fallback.');
                 freteCost = DELIVERY_FEE;
            }

            cartByStore[storeId] = {
                store_id: storeId,
                store_name: storeName,
                items: [],
                subtotal_products: 0,
                frete_cost: freteCost, 
                total_with_shipping: 0,
            };
            lojasUnicas.add(storeId);
        }

        cartByStore[storeId].items.push({
            product_id: productId,
            product_name: productInfo.name,
            image_url: finalImageUrl, 
            quantity: quantity,
            unit_price: itemPrice, 
            total_item_price: itemTotal,
            selected_options: options, 
        });
        
        cartByStore[storeId].subtotal_products += itemTotal;
        subTotalGeral += itemTotal;
        
        // LOG ESTRATÉGICO
        console.log(`[LOG-ACUM] Subtotal da Loja ${storeId}: ${cartByStore[storeId].subtotal_products.toFixed(2)}, SubTotal Geral Acumulado: ${subTotalGeral.toFixed(2)}`);
    }
    
    const numeroDeLojas = lojasUnicas.size;
    
    let freteTotal = 0;
    Object.values(cartByStore).forEach(store => {
        freteTotal += store.frete_cost; 
        store.total_with_shipping = store.subtotal_products + store.frete_cost;
    });

    // LOG ESTRATÉGICO
    console.log(`[LOG-FINAL] Acumulado antes da finalização: SubTotalGeral: ${subTotalGeral}, FreteTotal (soma): ${freteTotal}`);


    // CRITICAL FIX: Garante que subTotalGeral seja um número válido antes de aplicar toFixed
    const safeSubTotalGeral = (typeof subTotalGeral === 'number' && !isNaN(subTotalGeral)) ? subTotalGeral : 0;
    const valorTotalFinal = safeSubTotalGeral + freteTotal;

    const finalResult = {
        success: true,
        valorTotal: parseFloat(valorTotalFinal.toFixed(2)),
        freteTotal: parseFloat(freteTotal.toFixed(2)),
        subTotalGeral: parseFloat(safeSubTotalGeral.toFixed(2)),
        numeroDeLojas,
        cartBreakdown: Object.values(cartByStore),
    };

    console.log('[CART/CALC] Cálculo concluído com sucesso.');
    return finalResult;
};
// ******************************************************************


// ===================================================================
// ROTAS DO CARRINHO
// ===================================================================

/**
 * ROTA 1: BUSCAR CARRINHO (GET /api/cart) 
 */
router.get('/', protect, async (req, res) => {
    const userId = req.user.id;
    console.log(`[CART/GET] Usuário ${userId} buscando itens no carrinho.`);
    try {
        // CORREÇÃO DE SINTAXE SQL: REMOÇÃO DE CARACTERES INVISÍVEIS/ESPAÇOS APÓS SELECT
        const [items] = await pool.query(
            `SELECT c.product_id, c.quantity, c.attributes_json,
p.name AS product_name, p.price, p.image_url,
s.name AS store_name, s.id AS store_id 
FROM cart c
JOIN products p ON c.product_id = p.id
JOIN stores s ON p.seller_id = s.seller_id
WHERE c.user_id = ?`,
            [userId]
        );
        console.log(`[CART/GET] Encontrados ${items.length} itens no carrinho.`);
        res.status(200).json({ success: true, items });
    } catch (error) {
        console.error('[CART/GET] Erro ao buscar carrinho:', error);
        res.status(500).json({ success: false, message: 'Erro interno ao carregar carrinho.' });
    }
});

/**
 * ROTA 2: ADICIONAR ITEM (POST /api/cart/add) - CORRIGIDA
 */
router.post('/add', protect, async (req, res) => {
    const userId = req.user.id;
    // Garante que quantity seja, no mínimo, 1
    const { product_id, quantity: requestedQuantity = 1, options = {} } = req.body; 
    const quantity = parseInt(requestedQuantity, 10);
    
    if (isNaN(quantity) || quantity < 1) {
        console.warn(`[CART/ADD] Usuário ${userId} tentou adicionar quantidade inválida: ${requestedQuantity}`);
        return res.status(400).json({ success: false, message: 'Quantidade inválida.' });
    }
    
    // FIX CRÍTICO: Padroniza as opções antes de serializar
    const standardizedOptions = standardizeOptions(options);
    const attributesJson = JSON.stringify(standardizedOptions);

    console.log(`[CART/ADD] Usuário ${userId}. Produto: ${product_id}. Qtd Pedida: ${quantity}. Opções JSON: ${attributesJson}`);

    try {
        // A. Tenta atualizar a quantidade do item existente (com options padronizadas)
        const [updateResult] = await pool.query(
            `UPDATE cart SET quantity = quantity + ?
WHERE user_id = ? AND product_id = ? AND attributes_json = ?`,
            [quantity, userId, product_id, attributesJson]
        );

        console.log(`[CART/ADD] Linhas afetadas pelo UPDATE (existente): ${updateResult.affectedRows}`);

        if (updateResult.affectedRows === 0) {
            // B. Se não existir, INSERE um novo item
            const [insertResult] = await pool.query(
                'INSERT INTO cart (user_id, product_id, quantity, attributes_json) VALUES (?, ?, ?, ?)',
                [userId, product_id, quantity, attributesJson]
            );
            console.log(`[CART/ADD] SUCESSO: Novo item inserido (ID do INSERT: ${insertResult.insertId}).`);
        } else {
             console.log(`[CART/ADD] SUCESSO: Item existente, quantidade incrementada em +${quantity}.`);
        }

        res.status(200).json({ success: true, message: 'Item adicionado ao carrinho.' });
    } catch (error) {
        console.error('[CART/ADD] Erro ao adicionar item:', error);
        res.status(500).json({ success: false, message: 'Erro interno ao adicionar item: ' + error.message });
    }
});


/**
 * ROTA 3: REMOVER ITEM (DELETE /api/cart/remove) - CORRIGIDA
 */
router.delete('/remove', protect, async (req, res) => {
    const userId = req.user.id;
    const { product_id, options = {} } = req.body;
    
    // FIX CRÍTICO: Padroniza as opções antes de serializar
    const standardizedOptions = standardizeOptions(options);
    const attributesJson = JSON.stringify(standardizedOptions);
    
    console.log(`[CART/REMOVE] Usuário ${userId}. Produto: ${product_id}. Opções JSON: ${attributesJson}`);

    try {
        // CORREÇÃO DE SINTAXE SQL (e uso do attributesJson padronizado)
        const [result] = await pool.query(
            `DELETE FROM cart 
WHERE user_id = ? AND product_id = ? AND attributes_json = ?`,
            [userId, product_id, attributesJson]
        );
        
        console.log(`[CART/REMOVE] Linhas deletadas: ${result.affectedRows}`);
        if (result.affectedRows === 0) {
            console.warn('[CART/REMOVE] Item não encontrado para deleção.');
            return res.status(404).json({ success: false, message: 'Item não encontrado no carrinho.' });
        }

        res.status(200).json({ success: true, message: 'Item removido.' });
    } catch (error) {
        console.error('[CART/REMOVE] Erro ao remover item:', error);
        res.status(500).json({ success: false, message: 'Erro ao remover item.' });
    }
});

/**
 * ROTA 4: ATUALIZAR QUANTIDADE (PUT /api/cart/update) - CORRIGIDA
 */
router.put('/update', protect, async (req, res) => {
    const userId = req.user.id;
    const { product_id, quantity, options = {} } = req.body;
    
    // FIX CRÍTICO: Padroniza as opções antes de serializar
    const standardizedOptions = standardizeOptions(options);
    const attributesJson = JSON.stringify(standardizedOptions);
    
    console.log(`[CART/UPDATE] Usuário ${userId}. Produto: ${product_id}. Nova Qtd: ${quantity}. Opções JSON: ${attributesJson}`);

    if (quantity < 1) {
        // O frontend deve chamar a rota DELETE
        return res.status(400).json({ success: false, message: 'A quantidade deve ser no mínimo 1. Use a rota DELETE para remover.' });
    }

    try {
        // CORREÇÃO DE SINTAXE SQL (e uso do attributesJson padronizado)
        const [result] = await pool.query(
            `UPDATE cart SET quantity = ? 
WHERE user_id = ? AND product_id = ? AND attributes_json = ?`,
            [quantity, userId, product_id, attributesJson]
        );
        
        console.log(`[CART/UPDATE] UPDATE concluído. Linhas afetadas: ${result.affectedRows}`);
        
        if (result.affectedRows === 0) {
             console.warn(`[CART/UPDATE] AVISO: Nenhuma linha afetada. Item não encontrado no DB.`);
             return res.status(404).json({ success: false, message: 'Item não encontrado no carrinho para atualizar.' });
        }
        
        res.status(200).json({ success: true, message: 'Quantidade atualizada.' });
    } catch (error) {
        console.error('[CART/UPDATE] Erro ao atualizar item:', error);
        res.status(500).json({ success: false, message: 'Erro ao atualizar item.' });
    }
});


/**
 * ROTA 5: CÁLCULO DE FRETE E TOTAIS (POST /api/cart/calculate)
 */
router.post('/calculate', protect, async (req, res) => {
    console.log(`[CART/POST] Rota /api/cart/calculate acionada por utilizador ID: ${req.user.id}`);
    
    const buyerCityId = req.user.city_id; 
    const buyerDistrictId = req.user.district_id;
    const { items } = req.body; 

    if (!items || !Array.isArray(items) || items.length === 0) {
        console.log('[CART/POST] Pedido com carrinho vazio. Retornando 0.');
        return res.status(200).json({ 
            success: true, 
            valorTotal: 0, 
            freteTotal: 0, 
            subTotalGeral: 0, 
            numeroDeLojas: 0, 
            cartBreakdown: [] 
        });
    }

    if (!buyerCityId) {
         return res.status(400).json({ 
             success: false, 
             message: 'Para calcular o frete, a Cidade deve ser configurada no seu perfil.',
             code: 'CITY_REQUIRED_FOR_FREIGHT'
         });
    }

    try {
        const result = await calculateCartBreakdown(items, buyerCityId, buyerDistrictId);
        res.status(200).json(result);
        
    } catch (error) {
        console.error('[CART/POST] ERRO CRÍTICO ao calcular carrinho:', error.message);
        console.error(error); 
        
        res.status(500).json({ 
            success: false, 
            message: 'Erro interno ao processar o carrinho. Detalhes: ' + error.message,
            error: error.message 
        });
    }
});


module.exports = router;
