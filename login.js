// ! Arquivo: login.js (FINAL COMPLETO: Confirmação de Email, Redefinição e Reenvio com Rate Limit)

const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken'); 
// ! ATENÇÃO: Assumindo que brevoService.js foi atualizado para incluir sendConfirmationCode e sendPasswordResetCode
const brevoService = require('./brevoService'); 
const { protect } = require('./authMiddleware'); // Middleware de proteção geral

// --- Configurações de Segurança e Ambiente ---
const SALT_ROUNDS = 10; 
const JWT_SECRET = process.env.JWT_SECRET; 
const TOKEN_EXPIRY = '24h'; 

// ! Importa o pool compartilhado
const pool = require('./config/db'); 

// ===================================================================
// FUNÇÃO AUXILIAR: GERA CÓDIGO DE 6 DÍGITOS MAIÚSCULOS
// ===================================================================
const generateCode = () => {
    // Gera 6 caracteres alfanuméricos e converte para maiúsculo
    return Math.random().toString(36).substring(2, 8).toUpperCase();
};

// ===================================================================
// FUNÇÃO AUXILIAR: CALCULA TEMPO DE ESPERA (1, 2, 5, 10 MINUTOS)
// ===================================================================
const RESEND_LIMITS = [1, 2, 5, 10]; // Limites em minutos (1ª, 2ª, 3ª, 4ª+ tentativa)

const getResendWaitTime = (attempts) => {
    // attempts é zero-based, então a 1ª tentativa (index 0) usa 1 min
    if (attempts >= RESEND_LIMITS.length) {
        return RESEND_LIMITS[RESEND_LIMITS.length - 1]; // 10 minutos (limite)
    }
    return RESEND_LIMITS[attempts]; 
};


// -------------------------------------------------------------------
// 1. ROTA DE CADASTRO (/api/register) - REMOVIDO ENTREGADOR
// -------------------------------------------------------------------

router.post('/register', async (req, res) => {
    // is_delivery_person FOI REMOVIDO DO DESTRUCTURING
    const { email, password, city, full_name, is_seller } = req.body; 
    
    if (!email || !password || !city) {
        return res.status(400).json({ success: false, message: 'Os campos email, senha e cidade são obrigatórios.' });
    }
    
    // Agora não há mais conflito de Lojista/Entregador.

    try {
        const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
        const confirmationCode = generateCode();
        const now = new Date();
        
        await pool.execute(
            // is_delivery_person FOI REMOVIDO DO INSERT
            `INSERT INTO users (email, password_hash, city, full_name, is_seller, is_admin, is_verified, confirmation_code, last_code_request, code_resend_attempts) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                email, 
                passwordHash, 
                city, 
                full_name || null, 
                is_seller || false,          
                false, // is_admin
                false, // is_verified = FALSE
                confirmationCode, 
                now, // last_code_request
                0 // code_resend_attempts
            ] 
        );

        // Assumimos que o serviço envia a confirmação
        brevoService.sendConfirmationCode(email, full_name || 'Usuário', confirmationCode)
            .catch(err => console.error('Erro ao chamar o serviço Brevo após registro:', err));
        
        let roleText = is_seller ? 'Lojista' : 'Comprador';

        res.status(201).json({ 
            success: true, 
            message: `Usuário registrado como ${roleText}. Um código de confirmação foi enviado para ${email}.`
        });

    } catch (error) {
        if (error.errno === 1062) {
            return res.status(409).json({ success: false, message: 'O email fornecido já está em uso.' });
        }
        // O erro Unknown column 'is_verified' virá para cá se o SQL não foi executado
        console.error('Erro no processo de registro:', error);
        res.status(500).json({ success: false, message: 'Erro interno do servidor.' });
    }
});


// -------------------------------------------------------------------
// 2. ROTA: CONFIRMAÇÃO DE CADASTRO (/api/register/verify)
// -------------------------------------------------------------------
router.post('/register/verify', async (req, res) => {
    const { email, code } = req.body;

    if (!email || !code || code.length !== 6) {
        return res.status(400).json({ success: false, message: 'Email e Código de 6 dígitos são obrigatórios.' });
    }
    
    const upperCaseCode = code.toUpperCase(); 

    try {
        const [result] = await pool.execute(
            `UPDATE users SET 
                is_verified = TRUE, 
                confirmation_code = NULL 
             WHERE email = ? AND confirmation_code = ? AND is_verified = FALSE`,
            [email, upperCaseCode]
        );

        if (result.affectedRows === 0) {
            return res.status(401).json({ success: false, message: 'Código ou Email inválido, ou a conta já foi verificada.' });
        }

        res.status(200).json({ success: true, message: 'Email verificado com sucesso! Faça login.' });

    } catch (error) {
        console.error('[VERIFY] Erro ao verificar email:', error);
        res.status(500).json({ success: false, message: 'Erro interno do servidor.' });
    }
});


// -------------------------------------------------------------------
// 3. NOVA ROTA: REENVIO DE CÓDIGO (/api/resend-code) - RATE LIMIT APLICADO
// -------------------------------------------------------------------
router.post('/resend-code', async (req, res) => {
    const { email } = req.body;
    const { type } = req.query; // 'register' ou 'forgot-password'

    if (!email || !type || !['register', 'forgot-password'].includes(type)) {
        return res.status(400).json({ success: false, message: 'Email e tipo de solicitação (register/forgot-password) são obrigatórios.' });
    }

    try {
        const [rows] = await pool.execute(
            'SELECT id, full_name, is_verified, last_code_request, confirmation_code, code_resend_attempts FROM users WHERE email = ? LIMIT 1', 
            [email]
        );
        const user = rows[0];

        if (!user || !user.confirmation_code) {
             return res.status(404).json({ success: false, message: 'Usuário não encontrado ou código não pendente.' });
        }
        
        // --- LÓGICA DE RATE LIMIT ---
        const lastRequest = user.last_code_request ? new Date(user.last_code_request).getTime() : 0;
        const now = Date.now();
        const attempts = user.code_resend_attempts;
        const requiredWaitTime = getResendWaitTime(attempts) * 60 * 1000; // Tempo em milissegundos
        
        if (now - lastRequest < requiredWaitTime) {
            const timeLeft = Math.ceil((requiredWaitTime - (now - lastRequest)) / 60000);
            return res.status(429).json({ 
                success: false, 
                message: `Tente novamente em ${timeLeft} minutos. Você solicitou um reenvio recentemente.`,
                retry_in_minutes: timeLeft
            });
        }
        // --- FIM DA LÓGICA DE RATE LIMIT ---
        
        const newCode = generateCode();
        // Aumenta a contagem DEPOIS de passar no check de limite
        const newAttempts = attempts + 1; 

        // 1. Atualiza o código, a hora e o contador de tentativas
        await pool.execute(
            `UPDATE users SET 
                confirmation_code = ?, 
                last_code_request = NOW(), 
                code_resend_attempts = ?
             WHERE id = ?`,
            [newCode, newAttempts, user.id]
        );

        // 2. Envia o novo código
        if (type === 'register') {
            brevoService.sendConfirmationCode(email, user.full_name || 'Usuário', newCode)
                .catch(err => console.error('Erro ao reenviar código de registro:', err));
        } else if (type === 'forgot-password') {
            brevoService.sendPasswordResetCode(email, user.full_name || 'Usuário', newCode)
                .catch(err => console.error('Erro ao reenviar código de redefinição:', err));
        }

        const waitTimeNext = getResendWaitTime(newAttempts); // Calcula o tempo de espera para a próxima solicitação
        res.status(200).json({ 
            success: true, 
            message: `Novo código enviado. Próxima solicitação: ${waitTimeNext} minutos.`,
            next_wait_time: waitTimeNext
        });

    } catch (error) {
        console.error('[RESEND] Erro ao reenviar código:', error);
        res.status(500).json({ success: false, message: 'Erro interno do servidor.' });
    }
});


// -------------------------------------------------------------------
// 4. ROTA: INICIAR REDEFINIÇÃO DE SENHA (/api/forgot-password)
// -------------------------------------------------------------------
router.post('/forgot-password', async (req, res) => {
    const { email } = req.body;

    if (!email) {
        return res.status(400).json({ success: false, message: 'O email é obrigatório.' });
    }

    try {
        const [rows] = await pool.execute('SELECT id, full_name, last_code_request, code_resend_attempts FROM users WHERE email = ? LIMIT 1', [email]);
        const user = rows[0];

        if (!user) {
            // Retorna sucesso para evitar vazamento (mas não envia email)
            return res.status(200).json({ success: true, message: 'Se o email estiver cadastrado, um código foi enviado.' });
        }
        
        // --- LÓGICA DE RATE LIMIT ---
        const lastRequest = user.last_code_request ? new Date(user.last_code_request).getTime() : 0;
        const now = Date.now();
        const attempts = user.code_resend_attempts;
        const requiredWaitTime = getResendWaitTime(attempts) * 60 * 1000; 
        
        if (now - lastRequest < requiredWaitTime) {
            const timeLeft = Math.ceil((requiredWaitTime - (now - lastRequest)) / 60000);
            return res.status(429).json({ 
                success: false, 
                message: `Tente novamente em ${timeLeft} minutos. Você solicitou um reenvio recentemente.`,
                retry_in_minutes: timeLeft
            });
        }
        // --- FIM DA LÓGICA DE RATE LIMIT ---
        
        const resetCode = generateCode();
        const newAttempts = attempts + 1; // Aumenta a contagem

        // 1. Salva o novo código, a hora atual e o contador de tentativas no DB
        await pool.execute(
            'UPDATE users SET confirmation_code = ?, last_code_request = NOW(), code_resend_attempts = ? WHERE id = ?',
            [resetCode, newAttempts, user.id]
        );

        // 2. Envia o código por email
        brevoService.sendPasswordResetCode(email, user.full_name || 'Usuário', resetCode)
            .catch(err => console.error('Erro ao enviar código de redefinição:', err));

        res.status(200).json({ success: true, message: 'Um código de redefinição de senha foi enviado para o seu email.' });

    } catch (error) {
        console.error('[FORGOT] Erro ao iniciar redefinição:', error);
        res.status(500).json({ success: false, message: 'Erro interno do servidor.' });
    }
});


// -------------------------------------------------------------------
// 5. ROTA: FINALIZAR REDEFINIÇÃO DE SENHA (/api/reset-password)
// -------------------------------------------------------------------
router.post('/reset-password', async (req, res) => {
    const { email, code, new_password } = req.body;

    if (!email || !code || !new_password || new_password.length < 6) {
        return res.status(400).json({ success: false, message: 'Email, Código de 6 dígitos e Nova Senha (mínimo 6 caracteres) são obrigatórios.' });
    }

    const upperCaseCode = code.toUpperCase();
    
    try {
        const [rows] = await pool.execute('SELECT id FROM users WHERE email = ? AND confirmation_code = ? LIMIT 1', [email, upperCaseCode]);
        const user = rows[0];

        if (!user) {
            return res.status(401).json({ success: false, message: 'Código de redefinição inválido ou expirado.' });
        }

        // 1. Gera o hash da nova senha
        const newPasswordHash = await bcrypt.hash(new_password, SALT_ROUNDS);

        // 2. Atualiza a senha, limpa o código de confirmação e ZERA o contador de reenvio
        await pool.execute(
            `UPDATE users SET 
                password_hash = ?, 
                confirmation_code = NULL,
                code_resend_attempts = 0,
                last_code_request = NULL 
             WHERE id = ?`,
            [newPasswordHash, user.id]
        );

        res.status(200).json({ success: true, message: 'Senha redefinida com sucesso! Faça login com a nova senha.' });

    } catch (error) {
        console.error('[RESET] Erro ao redefinir senha:', error);
        res.status(500).json({ success: false, message: 'Erro interno do servidor.' });
    }
});


// -------------------------------------------------------------------
// 6. ROTA DE LOGIN (/api/login) - REMOVIDO ENTREGADOR E ADICIONADO CHECK DE VERIFICAÇÃO
// -------------------------------------------------------------------

router.post('/login', async (req, res) => {
    const { email, password, fcm_token } = req.body; 

    if (!email || !password) {
        return res.status(400).json({ success: false, message: 'Os campos email e senha são obrigatórios.' });
    }

    try {
        // is_delivery_person FOI REMOVIDO DO SELECT
        const [rows] = await pool.execute(
            'SELECT id, password_hash, email, city, full_name, is_seller, is_admin, is_available, pending_balance, city_id, district_id, address_street, whatsapp_number, is_verified FROM users WHERE email = ? LIMIT 1', 
            [email]
        );

        const user = rows[0];
        const isPasswordValid = user ? await bcrypt.compare(password, user.password_hash) : false;

        if (!user || !isPasswordValid) {
            return res.status(401).json({ 
                success: false, 
                message: 'Email ou Senha incorretos.' 
            });
        }
        
        // ! NOVO: BLOQUEIA LOGIN SE O EMAIL NÃO ESTIVER VERIFICADO
        if (user.is_verified === 0) {
            return res.status(403).json({ 
                success: false, 
                message: 'Seu email ainda não foi verificado. Por favor, verifique sua caixa de entrada.' 
            });
        }
        
        // #################################################
        // SALVA O TOKEN FCM APÓS LOGIN BEM-SUCEDIDO
        // #################################################
        if (fcm_token && user.id) {
             console.log(`[LOGIN] Salvando novo FCM Token para o Usuário ID: ${user.id}`);
             // Assume que a coluna fcm_token existe na tabela users
             await pool.execute(
                 'UPDATE users SET fcm_token = ? WHERE id = ?',
                 [fcm_token, user.id]
             );
        }
        // #################################################
        
        // 3. Checagem de Setup Inicial e Definição de Role
        let needsSetup = false;
        let setupType = null;
        let userRole = 'buyer'; 
        
        if (user.is_admin) {
            userRole = 'admin';
        } else if (user.is_seller) {
            userRole = 'seller';
            const [storeRows] = await pool.execute('SELECT id FROM stores WHERE seller_id = ? LIMIT 1', [user.id]);
            if (storeRows.length === 0) {
                needsSetup = true;
                setupType = 'store_setup'; 
            }
        } else { 
            // Comprador (buyer)
            const hasAddress = user.city_id && user.district_id && user.address_street && user.whatsapp_number;
            if (!hasAddress) {
                needsSetup = true;
                setupType = 'address_setup'; 
            }
        }

        // 4. Geração do JWT
        const tokenPayload = {
            id: user.id,
            email: user.email,
            role: userRole 
        };
        
        const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
        
        // Retorna o 'role'
        res.status(200).json({ 
            success: true, 
            message: `Login bem-sucedido. Bem-vindo(a), ${user.full_name || user.email}!`,
            token: token, 
            role: userRole, 
            needs_setup: needsSetup, 
            setup_type: setupType,   
            user: { 
                id: user.id, 
                email: user.email, 
                city: user.city, 
                name: user.full_name,
                is_seller: user.is_seller,
                is_admin: user.is_admin,
                // is_delivery_person FOI REMOVIDO
            } 
        });

    } catch (error) {
        console.error('Erro no processo de login:', error);
        res.status(500).json({ success: false, message: 'Erro interno do servidor.' });
    }
});


module.exports = router;
