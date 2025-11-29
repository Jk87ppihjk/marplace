// prp-main/notificacao.js

const admin = require('firebase-admin');

// ! ATENÇÃO: Carrega a chave de serviço do Firebase a partir de uma VARIÁVEL DE AMBIENTE Base64
const FIREBASE_SERVICE_ACCOUNT_B64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;

let serviceAccount = null;

if (FIREBASE_SERVICE_ACCOUNT_B64) {
    try {
        // Decodifica a string Base64 para JSON
        const serviceAccountJson = Buffer.from(FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8');
        serviceAccount = JSON.parse(serviceAccountJson);
        console.log('[FCM] Chave de serviço Firebase carregada de variável de ambiente.');
    } catch (e) {
        console.error('[FCM] ERRO: Falha ao decodificar ou fazer parse da chave de serviço Firebase.', e);
    }
} else {
    console.error('[FCM] ERRO CRÍTICO: Variável FIREBASE_SERVICE_ACCOUNT_B64 não encontrada. Notificações desativadas.');
}


// Inicializa o Firebase Admin SDK
try {
    if (serviceAccount) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log('[FCM] Firebase Admin SDK inicializado com sucesso.');
    }
} catch (error) {
    if (!admin.apps.length) {
        console.error('[FCM] Erro ao inicializar Firebase Admin SDK:', error);
    }
}


/**
 * Envia uma notificação Push para um token FCM específico.
 * [Restante da função sendNotification é o mesmo]
 */
const sendNotification = async (fcmToken, title, body, data = {}) => {
    // Adiciona uma checagem de segurança para garantir que o SDK foi inicializado
    if (!admin.apps.length || !serviceAccount) {
         console.warn('[FCM] Serviço de notificação não está ativo. Envio cancelado.');
         return false;
    }

    if (!fcmToken) {
        console.warn('[FCM] Token não fornecido. Notificação não enviada.');
        return false;
    }

    const message = {
        notification: {
            title: title,
            body: body
        },
        data: data,
        token: fcmToken,
        android: {
            priority: 'high',
            notification: {
                sound: 'default', 
                channel_id: 'default_channel' 
            }
        }
    };

    try {
        const response = await admin.messaging().send(message);
        console.log('[FCM] Notificação enviada com sucesso:', response);
        return true;
    } catch (error) {
        console.error('[FCM] Erro ao enviar notificação:', error);
        return false;
    }
};

module.exports = {
    sendNotification
};
