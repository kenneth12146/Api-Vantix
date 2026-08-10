const db = require('../config/db');

// Obtener todas las categorías activas (para el frontend público)
const getActiveCategories = async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM categories WHERE is_active = true ORDER BY order_index'
    );
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener categorías' });
  }
};

// Obtener todas las categorías (para admin)
const getAllCategories = async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM categories ORDER BY order_index');
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener categorías' });
  }
};

// Crear categoría (admin)
const createCategory = async (req, res) => {
  const { name, slug, image_url, is_active, order_index } = req.body;
  try {
    const { rows } = await db.query(
      'INSERT INTO categories (name, slug, image_url, is_active, order_index) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [name, slug, image_url, is_active, order_index]
    );
    res.status(201).json(rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al crear categoría' });
  }
};

// Actualizar categoría (admin)
const updateCategory = async (req, res) => {
  const { id } = req.params;
  const { name, slug, image_url, is_active, order_index } = req.body;
  try {
    const { rows } = await db.query(
      'UPDATE categories SET name = $1, slug = $2, image_url = $3, is_active = $4, order_index = $5 WHERE id = $6 RETURNING *',
      [name, slug, image_url, is_active, order_index, id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Categoría no encontrada' });
    }
    res.json(rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al actualizar categoría' });
  }
};

// Eliminar categoría (admin)
const deleteCategory = async (req, res) => {
  const { id } = req.params;
  try {
    const { rowCount } = await db.query('DELETE FROM categories WHERE id = $1', [id]);
    if (rowCount === 0) {
      return res.status(404).json({ error: 'Categoría no encontrada' });
    }
    res.json({ message: 'Categoría eliminada' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al eliminar categoría' });
  }
};

module.exports = {
  getActiveCategories,
  getAllCategories,
  createCategory,
  updateCategory,
  deleteCategory,
};