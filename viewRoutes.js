const express = require('express');
const router = express.Router();
// Importe a pool de conexão configurada (presumivelmente do seu arquivo db.js)
const pool = require('./config/db'); 

// Função auxiliar para formatar o tempo total de sessão
const formatTime = (totalSeconds) => {
    if (totalSeconds === null || isNaN(totalSeconds)) {
        return { seconds: 0, minutes: 0, hours: 0, days: 0 };
    }
    const totalMinutes = Math.floor(totalSeconds / 60);
    const totalHours = Math.floor(totalSeconds / 3600);
    const totalDays = Math.floor(totalSeconds / (3600 * 24));
    
    // Retorna um objeto estruturado com as conversões
    return {
        seconds: totalSeconds,
        minutes: totalMinutes,
        hours: totalHours,
        days: totalDays
    };
};

// ===================================================================
// Rota 1: GET /api/views/homepage
// Aumenta o contador de visualizações da página inicial em 1
// SINTAXE CORRIGIDA PARA MYSQL/MARIADB
// ===================================================================
router.get('/homepage', async (req, res) => {
    try {
        // SQL para INSERT ou UPDATE (se a chave já existir)
        const query = `
            INSERT INTO global_metrics (metric_key, metric_value) 
            VALUES (?, 1)
            ON DUPLICATE KEY UPDATE metric_value = metric_value + 1;
        `;
        // Usa o placeholder '?' para o MySQL
        await pool.query(query, ['homepage_views']); 
        
        return res.status(200).json({ success: true, message: "Visualização contada." });
    } catch (error) {
        // Erro 200 intencional para não quebrar o frontend em caso de falha de rastreamento
        console.error("[VIEW_ROUTE/HOMEPAGE] Erro ao registrar visualização:", error.message);
        return res.status(200).json({ success: false, message: "Falha ao registrar visualização." });
    }
});


// ===================================================================
// Rota 2: POST /api/views/session-duration
// Registra o tempo de sessão do usuário (em segundos)
// SINTAXE CORRIGIDA PARA MYSQL/MARIADB
// ===================================================================
router.post('/session-duration', async (req, res) => {
    // Tenta obter a duração. O sendBeacon envia como form-urlencoded, 
    // mas o Express (com body-parser) deve colocar em req.body.
    const duration = parseInt(req.body.duration || 0, 10);

    if (isNaN(duration) || duration <= 0) {
        return res.status(200).json({ success: false, message: "Duração inválida." });
    }
    
    try {
        // SQL para INSERT ou UPDATE, adicionando a duração ao total
        const query = `
            INSERT INTO global_metrics (metric_key, metric_value) 
            VALUES (?, ?)
            ON DUPLICATE KEY UPDATE metric_value = metric_value + ?;
        `;
        // Passamos a 'duration' duas vezes: uma para o INSERT inicial, outra para o UPDATE
        await pool.query(query, ['total_session_time_seconds', duration, duration]);
        
        return res.status(200).json({ success: true, message: `Sessão registrada: ${duration}s` });
    } catch (error) {
        console.error("[VIEW_ROUTE/DURATION] Erro ao registrar duração da sessão:", error.message);
        return res.status(200).json({ success: false, message: "Falha ao registrar duração." });
    }
});


// ===================================================================
// Rota 3: GET /api/views/analytics (ROTA DE BUSCA DE DADOS)
// Busca e retorna as métricas globais de forma amigável.
// ===================================================================
router.get('/analytics', async (req, res) => {
    try {
        // Busca todas as chaves de métricas globais
        // Nota: Assumimos que pool.query retorna [rows, fields] no formato mysql2/promise
        const [rows] = await pool.query(
            "SELECT metric_key, metric_value FROM global_metrics"
        );
        
        // Mapeia o array de resultados para um objeto { chave: valor }
        const metrics = rows.reduce((acc, row) => {
            // Garante que o valor seja um número inteiro
            acc[row.metric_key] = parseInt(row.metric_value, 10);
            return acc;
        }, {});
        
        const totalSessionTimeSeconds = metrics.total_session_time_seconds || 0;
        
        return res.status(200).json({ 
            success: true, 
            message: "Métricas globais recuperadas com sucesso.",
            analytics: {
                homepage_views: metrics.homepage_views || 0,
                total_session_time: formatTime(totalSessionTimeSeconds) // Usa a função de formatação para minutos/horas
            }
        });
    } catch (error) {
        console.error("[VIEW_ROUTE/ANALYTICS] Erro ao buscar métricas:", error.message);
        return res.status(500).json({ success: false, message: "Falha ao buscar métricas." });
    }
});

module.exports = router;
