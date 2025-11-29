// ! Arquivo: userRoutes.js (Rotas para o Comprador/Usuário - CORRIGIDO)

const express = require('express');
const router = express.Router();
const pool = require('./config/db');
const { protect } = require('./authMiddleware'); 

// -------------------------------------------------------------------
// 1. Rota de Perfil (Me)
// -------------------------------------------------------------------
router.get('/user/me', protect, async (req, res) => {
    // console.log(`[USER/ME] ID: ${req.user.id}`); // Debug opcional
    
    if (!req.user) {
        return res.status(404).json({ success: false, message: 'Usuário não encontrado.' });
    }
    
    res.status(200).json({ success: true, user: req.user });
});

// -------------------------------------------------------------------
// 2. Atualizar Endereço
// -------------------------------------------------------------------
router.put('/user/address', protect, async (req, res) => {
    const userId = req.user.id; 
    const { 
        city_id, district_id, address_street, address_number, address_nearby, whatsapp_number 
    } = req.body;

    if (!city_id || !district_id || !address_street || !address_number || !whatsapp_number) {
        return res.status(400).json({ success: false, message: 'Preencha todos os campos obrigatórios.' });
    }

    try {
        const [result] = await pool.execute(
            `UPDATE users SET 
                city_id = ?, district_id = ?, address_street = ?, address_number = ?, address_nearby = ?, whatsapp_number = ?
             WHERE id = ?`,
            [city_id, district_id, address_street, address_number, address_nearby || null, whatsapp_number, userId]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, message: 'Erro ao atualizar.' });
        }

        res.status(200).json({ success: true, message: 'Dados atualizados.' });

    } catch (error) {
        console.error('[USER/ADDRESS] Erro:', error);
        res.status(500).json({ success: false, message: 'Erro no servidor.' });
    }
});

// -------------------------------------------------------------------
// 3. (NOVO) Rota de Métricas/Saldo do Vendedor
// ESSA É A ROTA QUE FALTAVA PARA O SALDO APARECER
// -------------------------------------------------------------------
router.get('/users/seller/metrics', protect, async (req, res) => {
    const userId = req.user.id;

    try {
        // Busca o saldo pendente e disponível no banco
        const [rows] = await pool.execute(
            'SELECT pending_balance, available_balance FROM users WHERE id = ?', 
            [userId]
        );

        if (rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Usuário não encontrado.' });
        }

        const user = rows[0];

        // Retorna no formato que o anucio.html espera
        res.status(200).json({
            success: true,
            balance: {
                pending_balance: user.pending_balance || 0,
                available_balance: user.available_balance || 0
            }
        });

    } catch (error) {
        console.error('[SELLER/METRICS] Erro:', error);
        res.status(500).json({ success: false, message: 'Erro ao buscar saldo.' });
    }
});

module.exports = router;
