// ! Arquivo: recarga.js (Rotas para Compra de Créditos - PIX Simulado)

const express = require('express');
const router = express.Router();
const pool = require('./config/db'); 
const { protectSeller } = require('./sellerAuthMiddleware'); 
// Não precisamos importar o serviço AbacatePay real, pois faremos a simulação local.

// ===================================================================
// FUNÇÃO AUXILIAR: ATUALIZA SALDO (LÓGICA CRÍTICA)
// Adiciona o valor ao pending_balance do usuário.
// ===================================================================
const updatePendingBalance = async (userId, amount) => {
    console.log(`[RECARGA/CREDIT] Tentando creditar R$${amount.toFixed(2)} ao usuário ID: ${userId}`);
    
    // Garante que o usuário existe e é um lojista/usuário válido antes de creditar
    const [userCheck] = await pool.execute('SELECT id FROM users WHERE id = ?', [userId]);
    if (userCheck.length === 0) {
        console.warn(`[RECARGA/CREDIT] Usuário ID ${userId} não encontrado para crédito.`);
        throw new Error('Usuário para crédito não encontrado.');
    }
    
    await pool.query('BEGIN');
    try {
        await pool.execute(
            'UPDATE users SET pending_balance = pending_balance + ? WHERE id = ?',
            [amount, userId]
        );
        await pool.query('COMMIT');
        console.log(`[RECARGA/CREDIT] SUCESSO: R$${amount.toFixed(2)} creditados ao pending_balance do usuário ID: ${userId}.`);
    } catch (error) {
        await pool.query('ROLLBACK');
        console.error('[RECARGA/CREDIT] ERRO CRÍTICO ao atualizar saldo:', error);
        throw new Error('Falha na transação de atualização de saldo.');
    }
}


// ===================================================================
// ROTA 1: CRIAR PIX PARA RECARGA (POST /api/recarga/create-pix)
// Retorna um ID de transação simulado para ser usado na confirmação.
// ===================================================================
router.post('/create-pix', protectSeller, async (req, res) => {
    const sellerId = req.user.id;
    const { amount } = req.body; 

    const amountFloat = parseFloat(amount);
    if (isNaN(amountFloat) || amountFloat < 5.00) {
        return res.status(400).json({ success: false, message: 'Valor mínimo de recarga é R$5,00.' });
    }

    try {
        // Cria um ID de transação SIMULADO (Ex: RECARGA_123_500)
        // O valor é salvo em centavos (5.00 -> 500) para evitar problemas de ponto flutuante.
        const simulatedTransactionId = `RECARGA_${sellerId}_${(amountFloat * 100).toFixed(0)}`; 
        const description = `Recarga de Créditos para Anúncio - UserID: ${sellerId}`;

        res.status(201).json({ 
            success: true, 
            message: 'PIX de recarga iniciado. Use o endpoint de simulação para confirmar o pagamento.', 
            transaction_id: simulatedTransactionId, 
            amount: amountFloat,
            description: description,
            // Rota que o frontend usará para testar a confirmação
            simulate_endpoint: `/api/recarga/simulate-pix-payment` 
        });

    } catch (error) {
        console.error('[RECARGA/CREATE-PIX] Erro ao criar PIX:', error.message);
        res.status(500).json({ success: false, message: 'Erro interno ao criar PIX de recarga.' });
    }
});

// ===================================================================
// ROTA 2: SIMULAÇÃO DE PAGAMENTO PIX (POST /api/recarga/simulate-pix-payment)
// Simula a confirmação do pagamento e credita o saldo.
// ===================================================================
router.post('/simulate-pix-payment', protectSeller, async (req, res) => {
    const { transaction_id } = req.body; 
    
    // 1. Extrai UserID e Valor do ID da transação SIMULADA
    const parts = transaction_id.split('_'); 
    if (parts.length !== 3 || parts[0] !== 'RECARGA') {
        return res.status(400).json({ success: false, message: 'ID de transação inválido.' });
    }
    
    const sellerId = parts[1]; 
    const amount = parseInt(parts[2]) / 100;
    
    // 2. Validação de segurança: Apenas o usuário logado pode simular a recarga para si mesmo.
    if (sellerId != req.user.id) { 
        return res.status(403).json({ success: false, message: 'Acesso negado. ID da transação não corresponde ao usuário logado.' });
    }

    try {
        // 3. Atualiza o saldo do usuário (creditando o valor)
        await updatePendingBalance(sellerId, amount); 
        
        res.status(200).json({ success: true, message: `Pagamento PIX simulado e saldo de R$${amount.toFixed(2)} atualizado com sucesso!` });
        
    } catch (error) {
        console.error(`[RECARGA/SIMULATE-PIX] Erro na simulação ou atualização de saldo:`, error.message);
        res.status(500).json({ success: false, message: 'Erro na simulação de pagamento: ' + error.message });
    }

});

module.exports = router;
