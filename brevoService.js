// ! Arquivo: brevoService.js (AGORA INCLUI ROTAS PARA CONFIRMAÇÃO DE EMAIL E RESET DE SENHA)
const SibApiV3Sdk = require('sib-api-v3-sdk');

// ! 1. Configuração da API Brevo (Sendinblue)
// Configura o client padrão
const defaultClient = SibApiV3Sdk.ApiClient.instance;
const apiKey = defaultClient.authentications['api-key'];

// ! Obtém a chave API da Brevo a partir das variáveis de ambiente
// IMPORTANTE: Certifique-se de que process.env.BREVO_API_KEY esteja configurada no Render.
apiKey.apiKey = process.env.BREVO_API_KEY; 

const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();

// ! 2. Variáveis de Ambiente para o Remetente
// Puxa o email de remetente configurado no Render.
const SENDER_EMAIL = process.env.EMAIL_REMETENTE_EMAIL || 'no-reply@marketplace.com';
const SENDER_NAME = "Suporte Aldeify"; 

/**
 * Envia um email transacional de boas-vindas.
 * * @param {string} toEmail - O endereço de email do destinatário.
 * @param {string} toName - O nome do destinatário.
 * @returns {boolean} - Retorna true se o envio foi bem-sucedido, false caso contrário.
 */
const sendWelcomeEmail = async (toEmail, toName) => {
    // Cria o objeto de envio de email
    const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
    
    // Configurações do email
    sendSmtpEmail.subject = "🥳 Bem-vindo(a) ao seu Marketplace!";
    sendSmtpEmail.htmlContent = `
        <html>
            <body>
                <h2>Olá ${toName},</h2>
                <p>Obrigado por se juntar à nossa comunidade! Seu cadastro foi concluído com sucesso.</p>
                <p>Seja bem-vindo(a) e boas compras/vendas!</p>
                <br>
                <p>Atenciosamente,</p>
                <p>${SENDER_NAME}</p>
            </body>
        </html>
    `;

    // Remetente (usando a variável de ambiente)
    sendSmtpEmail.sender = {
        "name": SENDER_NAME, 
        "email": SENDER_EMAIL
    };
    
    // Destinatário
    sendSmtpEmail.to = [
        {"email": toEmail, "name": toName}
    ];

    try {
        console.log(`Tentando enviar email de boas-vindas para: ${toEmail}`);
        // ! Chamada para a API da Brevo
        const data = await apiInstance.sendTransacEmail(sendSmtpEmail);
        console.log('Email de boas-vindas enviado com sucesso. Resposta da Brevo:', data);
        return true;
    } catch (error) {
        // Trata e loga erros da API
        console.error('❌ ERRO ao enviar email Brevo:', error.response ? error.response.text : error.message);
        return false;
    }
};

/**
 * Envia o código de confirmação de email (registro). (NOVO!)
 * * @param {string} toEmail - O endereço de email do destinatário.
 * @param {string} toName - O nome do destinatário.
 * @param {string} code - O código de 6 dígitos.
 * @returns {boolean}
 */
const sendConfirmationCode = async (toEmail, toName, code) => {
    const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
    
    sendSmtpEmail.subject = "🔒 Seu Código de Confirmação de E-mail";
    sendSmtpEmail.htmlContent = `
        <html>
            <body>
                <h2>Olá ${toName},</h2>
                <p>Para ativar sua conta na Aldeify, utilize o código de 6 dígitos abaixo.</p>
                <div style="background-color: #2b2b2b; padding: 15px; border-radius: 8px; text-align: center; color: #00e5ff;">
                    <h1 style="margin: 0;">${code}</h1>
                </div>
                <p>Este código expira em breve e é válido apenas para o seu endereço de e-mail.</p>
                <br>
                <p>Atenciosamente,</p>
                <p>${SENDER_NAME}</p>
            </body>
        </html>
    `;

    sendSmtpEmail.sender = { "name": SENDER_NAME, "email": SENDER_EMAIL };
    sendSmtpEmail.to = [ {"email": toEmail, "name": toName} ];

    try {
        console.log(`Tentando enviar código de confirmação para: ${toEmail}`);
        const data = await apiInstance.sendTransacEmail(sendSmtpEmail);
        console.log('Código de confirmação enviado com sucesso. Resposta da Brevo:', data);
        return true;
    } catch (error) {
        console.error('❌ ERRO ao enviar código de confirmação Brevo:', error.response ? error.response.text : error.message);
        return false;
    }
};


/**
 * Envia o código de redefinição de senha. (NOVO!)
 * * @param {string} toEmail - O endereço de email do destinatário.
 * @param {string} toName - O nome do destinatário.
 * @param {string} code - O código de 6 dígitos.
 * @returns {boolean}
 */
const sendPasswordResetCode = async (toEmail, toName, code) => {
    const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
    
    sendSmtpEmail.subject = "🔄 Solicitação de Redefinição de Senha";
    sendSmtpEmail.htmlContent = `
        <html>
            <body>
                <h2>Olá ${toName},</h2>
                <p>Recebemos uma solicitação para redefinir sua senha na Aldeify. Utilize o código de 6 dígitos abaixo para continuar:</p>
                <div style="background-color: #4d0000; padding: 15px; border-radius: 8px; text-align: center; color: #FF7700;">
                    <h1 style="margin: 0;">${code}</h1>
                </div>
                <p>Se você não solicitou esta redefinição, ignore este e-mail. Sua senha atual permanecerá inalterada.</p>
                <br>
                <p>Atenciosamente,</p>
                <p>${SENDER_NAME}</p>
            </body>
        </html>
    `;

    sendSmtpEmail.sender = { "name": SENDER_NAME, "email": SENDER_EMAIL };
    sendSmtpEmail.to = [ {"email": toEmail, "name": toName} ];

    try {
        console.log(`Tentando enviar código de reset de senha para: ${toEmail}`);
        const data = await apiInstance.sendTransacEmail(sendSmtpEmail);
        console.log('Código de reset enviado com sucesso. Resposta da Brevo:', data);
        return true;
    } catch (error) {
        console.error('❌ ERRO ao enviar código de reset Brevo:', error.response ? error.response.text : error.message);
        return false;
    }
};


module.exports = {
    sendWelcomeEmail,
    sendConfirmationCode, // Exportado para uso em login.js
    sendPasswordResetCode // Exportado para uso em login.js
};
