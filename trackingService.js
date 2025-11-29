// ! Arquivo: trackingService.js (SIMPLIFICADO: Apenas Métricas e Rastreamento de Vendedor)

const pool = require('./config/db');

// ===================================================================
// FUNÇÕES AUXILIARES DE CÁLCULO (formatTime MANTIDA)
// ===================================================================
const formatTime = (totalSeconds) => {
    if (totalSeconds === null || isNaN(totalSeconds)) return 'N/A';
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = Math.floor(totalSeconds % 60);

    let parts = [];
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);

    return parts.join(' ');
};

// ===================================================================
// FUNÇÕES PRINCIPAIS DE CÁLCULO DE MÉTRICAS
// ===================================================================

/**
 * Calcula as métricas de velocidade de despacho e entrega própria para um Vendedor (Seller).
 * @param {number} sellerId - ID do Vendedor.
 * @returns {Promise<object>} Métricas de desempenho.
 */
const getSellerMetrics = async (sellerId) => {
    // 1. Métrica de Velocidade de Despacho (Packing)
    const [packingResults] = await pool.execute(`
        SELECT AVG(TIMESTAMPDIFF(SECOND, o.created_at, d.packing_start_time)) AS avg_packing_time
        FROM orders o
        JOIN stores s ON o.store_id = s.id
        JOIN deliveries d ON o.id = d.order_id
        WHERE s.seller_id = ? AND d.packing_start_time IS NOT NULL;
    `, [sellerId]);

    // 2. Métrica de Velocidade de Entrega Própria (Self-Delivery) - CRÍTICA
    const [selfDeliveryResults] = await pool.execute(`
        SELECT 
            AVG(TIMESTAMPDIFF(SECOND, d.packing_start_time, d.delivery_time)) AS avg_delivery_time,
            MIN(TIMESTAMPDIFF(SECOND, d.packing_start_time, d.delivery_time)) AS min_delivery_time,
            MAX(TIMESTAMPDIFF(SECOND, d.packing_start_time, d.delivery_time)) AS max_delivery_time
        FROM orders o
        JOIN stores s ON o.store_id = s.id
        JOIN deliveries d ON o.id = d.order_id
        WHERE s.seller_id = ? AND o.delivery_method = 'Seller' AND d.delivery_time IS NOT NULL;
    `, [sellerId]);

    const metrics = {
        avgPackingTime: formatTime(packingResults[0]?.avg_packing_time), 
        
        // Métricas de Entrega Própria (Despacho até a Confirmação)
        avgSelfDeliveryTime: formatTime(selfDeliveryResults[0]?.avg_delivery_time),
        minSelfDeliveryTime: formatTime(selfDeliveryResults[0]?.min_delivery_time),
        maxSelfDeliveryTime: formatTime(selfDeliveryResults[0]?.max_delivery_time),
    };

    return metrics;
};

// getDeliveryPersonMetrics REMOVIDO

// ===================================================================
// FUNÇÃO DE RASTREAMENTO PARA COMPRADOR (Status em Texto) - SIMPLIFICADA
// ===================================================================

/**
 * Gera a mensagem de status de rastreamento para o comprador.
 * @param {object} order - O registro do pedido (com status, delivery_method, etc.).
 * @param {object} delivery - Objeto auxiliar com status e delivery_method.
 * @returns {string} Mensagem detalhada para o comprador.
 */
const getBuyerTrackingMessage = (order, delivery) => {
    
    if (order.status === 'Pending Payment') {
        return 'Aguardando confirmação de pagamento.';
    }
    
    if (order.status === 'Completed') {
        return 'Pedido concluído! Recebimento confirmado.';
    }
    
    if (order.status === 'Processing') {
        // Se o status for 'Processing', o vendedor está embalando
        return 'Seu pedido foi confirmado e está sendo preparado pelo lojista (embalagem).';
    }

    if (order.status === 'Delivering') {
        // --- Fluxo Vendedor (Self-Delivery) ---
        if (delivery.delivery_method === 'Seller') {
            return 'O lojista já despachou seu pedido (Entrega Própria) e está a caminho. Aguarde a chegada.';
        }

        // --- Fluxo Marketplace (Simplificado) ---
        if (delivery.status === 'Requested') {
            return 'O lojista preparou o pedido e solicitou a coleta.';
        }
        if (delivery.status === 'Accepted' || delivery.status === 'PickedUp' || delivery.status === 'In Transit') {
            return 'Seu pedido está em rota de entrega! Consulte o lojista para detalhes do entregador.';
        }
        
        if (delivery.status === 'Delivered_Confirmed') {
            return 'Entrega confirmada pelo código. Aguardando finalização no sistema.';
        }
        
        return 'Seu pedido está em trânsito.';
    }
    
    // Status Inesperado
    return 'Status: ' + order.status;
};


module.exports = {
    getSellerMetrics,
    getBuyerTrackingMessage,
    formatTime,
};
