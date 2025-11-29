// ! Arquivo: prp-main/adminRoutes.js (CORRIGIDO: Logs adicionados e aliás de coluna 'type AS attribute_type' para compatibilidade com o frontend)

const express = require('express');
const router = express.Router();
const pool = require('./config/db');
const { protectAdmin } = require('./adminAuthMiddleware'); // Importa o middleware Admin

// ==================================================================
// 1. ROTAS DE UTILIDADE PÚBLICA (GET - NÃO PROTEGIDAS)
// Montadas em /api no server.js (ex: /api/cities)
// ==================================================================

// Lista todas as cidades
router.get('/cities', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM cities ORDER BY name ASC');
        res.status(200).json({ success: true, data: rows });
    } catch (error) {
        console.error('[SYSTEM] Erro ao buscar cidades:', error);
        res.status(500).json({ success: false, message: 'Erro ao carregar cidades.' });
    }
});

// Lista TODOS os bairros (com nome da cidade) - Usado no Admin Panel
router.get('/districts', async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT d.*, c.name AS city_name, c.state_province 
             FROM districts d 
             JOIN cities c ON d.city_id = c.id
             ORDER BY c.name ASC, d.name ASC`
        );
        res.status(200).json({ success: true, data: rows }); 
    } catch (error) {
        console.error('[SYSTEM] Erro ao buscar todos os distritos:', error);
        res.status(500).json({ success: false, message: 'Erro ao carregar todos os distritos.' });
    }
});

// Lista todos os bairros/distritos de uma cidade
router.get('/districts/:cityId', async (req, res) => {
    const { cityId } = req.params;
    try {
        if (isNaN(parseInt(cityId))) {
            return res.status(400).json({ success: false, message: 'ID da cidade inválido.' });
        }
        
        const [rows] = await pool.query(
            'SELECT * FROM districts WHERE city_id = ? ORDER BY name ASC', 
            [cityId]
        );
        res.status(200).json({ success: true, districts: rows });
    } catch (error) {
        console.error('[SYSTEM] Erro ao buscar distritos por cidade:', error);
        res.status(500).json({ success: false, message: 'Erro ao carregar distritos.' });
    }
});


// Lista todas as categorias principais
router.get('/categories', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM categories ORDER BY name ASC');
        res.status(200).json({ success: true, categories: rows });
    } catch (error) {
        console.error('[SYSTEM] Erro ao buscar categorias:', error);
        res.status(500).json({ success: false, message: 'Erro ao buscar categorias.' });
    }
});

// Lista TODAS as subcategorias (com nome da categoria)
router.get('/subcategories', async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT s.*, c.name AS category_name 
             FROM subcategories s 
             JOIN categories c ON s.category_id = c.id
             ORDER BY c.name ASC, s.name ASC`
        );
        res.status(200).json({ success: true, subcategories: rows }); 
    } catch (error) {
        console.error('[SYSTEM] Erro ao buscar todas as subcategorias:', error);
        res.status(500).json({ success: false, message: 'Erro ao carregar todas as subcategorias.' });
    }
});

// Rota específica para buscar subcategorias por Categoria ID
router.get('/subcategories/:categoryId', async (req, res) => {
    const { categoryId } = req.params;
    try {
        const [rows] = await pool.query(
            'SELECT * FROM subcategories WHERE category_id = ? ORDER BY name ASC',
            [categoryId]
        );
        // Retorna array vazio se não houver subcategorias, mas sucesso true
        res.status(200).json({ success: true, subcategories: rows });
    } catch (error) {
        console.error('[SYSTEM] Erro ao buscar subcategorias por categoria:', error);
        res.status(500).json({ success: false, message: 'Erro ao buscar subcategorias.' });
    }
});


// Lista TODOS os atributos (com nome da subcategoria e categoria)
router.get('/attributes', async (req, res) => {
    console.log('[ATTRIBUTES/GET/ALL] Recebido pedido para todos os atributos.');
    try {
        const [rows] = await pool.query(
            // CRÍTICO: Adicionando 'a.type AS attribute_type' para o frontend.
            `SELECT a.*, a.type AS attribute_type, s.name AS subcategory_name, c.name AS category_name
             FROM attributes a
             JOIN subcategories s ON a.subcategory_id = s.id
             JOIN categories c ON s.category_id = c.id
             ORDER BY c.name ASC, s.name ASC, a.name ASC`
        );
        console.log(`[ATTRIBUTES/GET/ALL] Total de ${rows.length} atributos encontrados.`);
        res.status(200).json({ success: true, attributes: rows });
    } catch (error) {
        console.error('[SYSTEM] Erro ao buscar todos os atributos:', error);
        res.status(500).json({ success: false, message: 'Erro ao carregar todos os atributos.' });
    }
});

// Lista atributos específicos da subcategoria (FICHA TÉCNICA)
router.get('/attributes/:subcategoryId', async (req, res) => {
    const { subcategoryId } = req.params;
    console.log(`[ATTRIBUTES/GET] Recebido pedido para subcategoria ID: ${subcategoryId}`); 
    try {
        // CRÍTICO: Selecionar o campo 'type' como 'attribute_type' para compatibilidade com o frontend
        const [rows] = await pool.query(
            'SELECT *, type AS attribute_type FROM attributes WHERE subcategory_id = ?', 
            [subcategoryId]
        );
        
        console.log(`[ATTRIBUTES/GET] ${rows.length} atributos encontrados para ID: ${subcategoryId}.`); 
        
        res.status(200).json({ success: true, attributes: rows });
    } catch (error) {
        console.error(`[ATTRIBUTES/GET] ERRO CRÍTICO ao buscar atributos para ID ${subcategoryId}:`, error); 
        res.status(500).json({ success: false, message: 'Erro ao buscar atributos.' });
    }
});


// ==================================================================
// 2. ROTAS ADMINISTRATIVAS (CRUD - PROTEGIDAS por protectAdmin)
// ==================================================================

// ---- Cidades (Cities) ----

router.post('/admin/cities', protectAdmin, async (req, res) => {
    const { name, state_province } = req.body;
    if (!name || !state_province) {
        return res.status(400).json({ success: false, message: 'Nome e UF da cidade são obrigatórios.' });
    }
    try {
        const [result] = await pool.query(
            'INSERT INTO cities (name, state_province) VALUES (?, ?)',
            [name, state_province]
        );
        res.status(201).json({ success: true, message: 'Cidade criada com sucesso.', id: result.insertId });
    } catch (error) {
        console.error('[ADMIN] Erro ao criar cidade:', error);
        res.status(500).json({ success: false, message: 'Erro interno ao criar cidade.' });
    }
});

router.put('/admin/cities/:id', protectAdmin, async (req, res) => {
    const { id } = req.params;
    const { name, state_province } = req.body;
    if (!name || !state_province) {
        return res.status(400).json({ success: false, message: 'Nome e UF da cidade são obrigatórios.' });
    }
    try {
        const [result] = await pool.query(
            'UPDATE cities SET name = ?, state_province = ? WHERE id = ?',
            [name, state_province, id]
        );
        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, message: 'Cidade não encontrada.' });
        }
        res.status(200).json({ success: true, message: 'Cidade atualizada com sucesso.' });
    } catch (error) {
        console.error('[ADMIN] Erro ao atualizar cidade:', error);
        res.status(500).json({ success: false, message: 'Erro interno ao atualizar cidade.' });
    }
});

router.delete('/admin/cities/:id', protectAdmin, async (req, res) => {
    const { id } = req.params;
    try {
        const [result] = await pool.query('DELETE FROM cities WHERE id = ?', [id]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, message: 'Cidade não encontrada.' });
        }
        res.status(200).json({ success: true, message: 'Cidade deletada com sucesso.' });
    } catch (error) {
        console.error('[ADMIN] Erro ao deletar cidade:', error);
        res.status(500).json({ success: false, message: 'Erro interno ao deletar cidade.' });
    }
});

// ---- Bairros (Districts) ----

router.post('/admin/districts', protectAdmin, async (req, res) => {
    const { city_id, name } = req.body;
    if (!city_id || !name) {
        return res.status(400).json({ success: false, message: 'ID da cidade e nome do bairro são obrigatórios.' });
    }
    try {
        const [result] = await pool.query(
            'INSERT INTO districts (city_id, name) VALUES (?, ?)',
            [city_id, name]
        );
        res.status(201).json({ success: true, message: 'Bairro criado com sucesso.', id: result.insertId });
    } catch (error) {
        console.error('[ADMIN] Erro ao criar bairro:', error);
        res.status(500).json({ success: false, message: 'Erro interno ao criar bairro.' });
    }
});

router.put('/admin/districts/:id', protectAdmin, async (req, res) => {
    const { id } = req.params;
    const { city_id, name } = req.body;
    if (!city_id || !name) {
        return res.status(400).json({ success: false, message: 'ID da cidade e nome do bairro são obrigatórios.' });
    }
    try {
        const [result] = await pool.query(
            'UPDATE districts SET city_id = ?, name = ? WHERE id = ?',
            [city_id, name, id]
        );
        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, message: 'Bairro não encontrado.' });
        }
        res.status(200).json({ success: true, message: 'Bairro atualizado com sucesso.' });
    } catch (error) {
        console.error('[ADMIN] Erro ao atualizar bairro:', error);
        res.status(500).json({ success: false, message: 'Erro interno ao atualizar bairro.' });
    }
});

router.delete('/admin/districts/:id', protectAdmin, async (req, res) => {
    const { id } = req.params;
    try {
        const [result] = await pool.query('DELETE FROM districts WHERE id = ?', [id]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, message: 'Bairro não encontrado.' });
        }
        res.status(200).json({ success: true, message: 'Bairro deletado com sucesso.' });
    } catch (error) {
        console.error('[ADMIN] Erro ao deletar bairro:', error);
        res.status(500).json({ success: false, message: 'Erro interno ao deletar bairro.' });
    }
});

// ---- Categorias (Categories) ----

router.post('/admin/categories', protectAdmin, async (req, res) => {
    const { name } = req.body;
    if (!name) {
        return res.status(400).json({ success: false, message: 'Nome da categoria é obrigatório.' });
    }
    try {
        const [result] = await pool.query('INSERT INTO categories (name) VALUES (?)', [name]);
        res.status(201).json({ success: true, message: 'Categoria criada com sucesso.', id: result.insertId });
    } catch (error) {
        console.error('[ADMIN] Erro ao criar categoria:', error);
        res.status(500).json({ success: false, message: 'Erro interno ao criar categoria.' });
    }
});

router.put('/admin/categories/:id', protectAdmin, async (req, res) => {
    const { id } = req.params;
    const { name } = req.body;
    if (!name) {
        return res.status(400).json({ success: false, message: 'Nome da categoria é obrigatório.' });
    }
    try {
        const [result] = await pool.query('UPDATE categories SET name = ? WHERE id = ?', [name, id]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, message: 'Categoria não encontrada.' });
        }
        res.status(200).json({ success: true, message: 'Categoria atualizada com sucesso.' });
    } catch (error) {
        console.error('[ADMIN] Erro ao atualizar categoria:', error);
        res.status(500).json({ success: false, message: 'Erro interno ao atualizar categoria.' });
    }
});

router.delete('/admin/categories/:id', protectAdmin, async (req, res) => {
    const { id } = req.params;
    try {
        const [result] = await pool.query('DELETE FROM categories WHERE id = ?', [id]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, message: 'Categoria não encontrada.' });
        }
        res.status(200).json({ success: true, message: 'Categoria deletada com sucesso.' });
    } catch (error) {
        console.error('[ADMIN] Erro ao deletar categoria:', error);
        res.status(500).json({ success: false, message: 'Erro interno ao deletar categoria.' });
    }
});

// ---- Subcategorias (Subcategories) ----

router.post('/admin/subcategories', protectAdmin, async (req, res) => {
    const { category_id, name } = req.body;
    if (!category_id || !name) {
        return res.status(400).json({ success: false, message: 'ID da categoria e nome da subcategoria são obrigatórios.' });
    }
    try {
        const [result] = await pool.query(
            'INSERT INTO subcategories (category_id, name) VALUES (?, ?)',
            [category_id, name]
        );
        res.status(201).json({ success: true, message: 'Subcategoria criada com sucesso.', id: result.insertId });
    } catch (error) {
        console.error('[ADMIN] Erro ao criar subcategoria:', error);
        res.status(500).json({ success: false, message: 'Erro interno ao criar subcategoria.' });
    }
});

router.put('/admin/subcategories/:id', protectAdmin, async (req, res) => {
    const { id } = req.params;
    const { category_id, name } = req.body;
    if (!category_id || !name) {
        return res.status(400).json({ success: false, message: 'ID da categoria e nome da subcategoria são obrigatórios.' });
    }
    try {
        const [result] = await pool.query(
            'UPDATE subcategories SET category_id = ?, name = ? WHERE id = ?',
            [category_id, name, id]
        );
        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, message: 'Subcategoria não encontrada.' });
        }
        res.status(200).json({ success: true, message: 'Subcategoria atualizada com sucesso.' });
    } catch (error) {
        console.error('[ADMIN] Erro ao atualizar subcategoria:', error);
        res.status(500).json({ success: false, message: 'Erro interno ao atualizar subcategoria.' });
    }
});

router.delete('/admin/subcategories/:id', protectAdmin, async (req, res) => {
    const { id } = req.params;
    try {
        const [result] = await pool.query('DELETE FROM subcategories WHERE id = ?', [id]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, message: 'Subcategoria não encontrada.' });
        }
        res.status(200).json({ success: true, message: 'Subcategoria deletada com sucesso.' });
    } catch (error) {
        console.error('[ADMIN] Erro ao deletar subcategoria:', error);
        res.status(500).json({ success: false, message: 'Erro interno ao deletar subcategoria.' });
    }
});

// ---- Atributos (Attributes) ----

router.post('/admin/attributes', protectAdmin, async (req, res) => {
    // ! Recebe 'slug', 'type' (agora como atributo_type no frontend), 'options' e 'required'
    const { subcategory_id, name, slug, type, options, required } = req.body;
    
    if (!subcategory_id || !name || !type) {
        return res.status(400).json({ success: false, message: 'ID da subcategoria, nome e tipo do atributo são obrigatórios.' });
    }
    
    // Geração Automática de Slug
    const finalSlug = slug || name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    const isRequired = required !== undefined ? required : true;

    try {
        const [result] = await pool.query(
            'INSERT INTO attributes (subcategory_id, name, slug, type, options, required) VALUES (?, ?, ?, ?, ?, ?)',
            [subcategory_id, name, finalSlug, type, options, isRequired]
        );
        res.status(201).json({ success: true, message: 'Atributo criado com sucesso.', id: result.insertId });
    } catch (error) {
        console.error('[ADMIN] Erro ao criar atributo:', error);
        res.status(500).json({ success: false, message: 'Erro interno ao criar atributo.' });
    }
});

router.put('/admin/attributes/:id', protectAdmin, async (req, res) => {
    const { id } = req.params;
    const { subcategory_id, name, slug, type, options, required } = req.body;
    
    if (!subcategory_id || !name || !type) {
        return res.status(400).json({ success: false, message: 'ID da subcategoria, nome e tipo do atributo são obrigatórios.' });
    }
    
    const finalSlug = slug || name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    const isRequired = required !== undefined ? required : true;

    try {
        const [result] = await pool.query(
            'UPDATE attributes SET subcategory_id = ?, name = ?, slug = ?, type = ?, options = ?, required = ? WHERE id = ?',
            [subcategory_id, name, finalSlug, type, options, isRequired, id]
        );
        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, message: 'Atributo não encontrado.' });
        }
        res.status(200).json({ success: true, message: 'Atributo atualizado com sucesso.' });
    } catch (error) {
        console.error('[ADMIN] Erro ao atualizar atributo:', error);
        res.status(500).json({ success: false, message: 'Erro interno ao atualizar atributo.' });
    }
});

router.delete('/admin/attributes/:id', protectAdmin, async (req, res) => {
    const { id } = req.params;
    try {
        const [result] = await pool.query('DELETE FROM attributes WHERE id = ?', [id]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, message: 'Atributo não encontrado.' });
        }
        res.status(200).json({ success: true, message: 'Atributo deletado com sucesso.' });
    } catch (error) {
        console.error('[ADMIN] Erro ao deletar atributo:', error);
        res.status(500).json({ success: false, message: 'Erro interno ao deletar atributo.' });
    }
});

module.exports = router;
