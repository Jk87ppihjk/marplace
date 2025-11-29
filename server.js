// ! Arquivo: server.js (ATUALIZADO COM ROTAS DE VISUALIZAÇÃO)

const express = require('express');
const cors = require('cors');
require('dotenv').config(); // Carrega as variáveis de ambiente

const app = express();
const PORT = process.env.PORT || 3000;

// --- CONFIGURAÇÃO DE MIDDLEWARES ---

// 🚨 CORREÇÃO CRÍTICA DO CORS PARA * QUALQUER ORIGEM 🚨
// Configuração para permitir o acesso de QUALQUER domínio e lidar com cabeçalhos de autenticação.
const corsOptions = {
    // 1. Permite QUALQUER origem
    origin: '*', 
    // 2. Permite que o navegador envie cookies e cabeçalhos de autorização
    //    IMPORTANTE: Quando 'origin' é '*', 'credentials' DEVE ser 'false'.
    //    O navegador bloqueia credenciais (cookies/Authorization) quando a origem é universal (*).
    //    Se você PRECISA de credenciais, você deve listar as origens específicas, e NÃO usar '*'.
    credentials: false, 
    // 3. Garante que os métodos necessários (GET, POST, etc.) e os Headers (Authorization) sejam permitidos
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    allowedHeaders: ['Content-Type', 'Authorization'],
};

// Aplica a configuração do CORS
app.use(cors(corsOptions));
// ------------------------------------

// CRÍTICO: Aumenta o limite e configura Body Parser
app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ limit: '50mb', extended: true })); 
app.use('/uploads', express.static('uploads')); 

// --- Importação das Rotas Modulares ---
const loginRoutes = require('./login');
const adminRoutes = require('./adminRoutes');
const productRoutes = require('./productRoutes');
const storeRoutes = require('./storeRoutes');
const fyRoutes = require('./fyRoutes');
const uploadRoutes = require('./uploadRoutes');
const userRoutes = require('./userRoutes'); 
const cartRoutes = require('./cartRoutes'); 

// Rotas de Pedidos e Logística
const orderCreationRoutes = require('./orderCreationRoutes'); 
const logisticsAndConfirmationRoutes = require('./logisticsAndConfirmationRoutes'); 
const trackingAndDataRoutes = require('./trackingAndDataRoutes'); 

// Rotas de Pagamento
const mercadoPagoRoutes = require('./mercadoPagoRoutes');

// Rota da Vitrine Inteligente
const smartVitrineRoutes = require('./smartVitrineRoutes');

// !!! NOVO: Rota de Visualização da Home Page !!!
const viewRoutes = require('./viewRoutes');


// --- Uso e Montagem das Rotas (Tudo sob /api) ---

// Montagem Básica (Monta o router exportado do arquivo no caminho raiz /api)
app.use('/api', loginRoutes); // /api/login, /api/register
app.use('/api', adminRoutes);
app.use('/api', productRoutes);
app.use('/api', storeRoutes);
app.use('/api', fyRoutes);
app.use('/api', uploadRoutes);
app.use('/api', userRoutes);

// Ativação da Vitrine Inteligente
app.use('/api', smartVitrineRoutes);

// !!! NOVO: Ativação da Rota de Visualização !!!
app.use('/api/views', viewRoutes); // Rota para /api/views/homepage

// MONTAGEM CRÍTICA DE PEDIDOS:
// Montamos a Criação e a Gestão diretamente em /api.
app.use('/api', orderCreationRoutes); 
app.use('/api', logisticsAndConfirmationRoutes); 

// Montagem de Roteadores com prefixo embutido:
app.use('/api/cart', cartRoutes); 
app.use('/api/delivery', trackingAndDataRoutes); // Rota de tracking para entregadores
app.use('/api/mp', mercadoPagoRoutes); // Rotas Mercado Pago


// Rota "raiz"
app.get('/', (req, res) => {
    res.send('API do Marketplace está operacional.');
});

// --- TRATAMENTO DE ERRO 404 (CRÍTICO) ---
app.use((req, res, next) => {
    res.status(404).json({ 
        success: false, 
        message: 'Rota não encontrada. Verifique o endpoint: ' + req.originalUrl 
    });
});

// Iniciar o Servidor
app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
    console.log(`DB_HOST: ${process.env.DB_HOST ? 'Configurado' : 'NÃO CONFIGURADO!'}`);
});
