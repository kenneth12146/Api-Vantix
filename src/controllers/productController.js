const db = require('../config/db');

// Obtener productos activos (público) con filtros
const getActiveProducts = async (req, res) => {
  const { category_id, search, sortBy = 'created_at', order = 'desc' } = req.query;
  let query = `
    SELECT p.*, 
           json_agg(DISTINCT jsonb_build_object(
             'id', pi.id,
             'image_url', pi.image_url,
             'is_main', pi.is_main
           )) FILTER (WHERE pi.id IS NOT NULL) as product_images,
           to_json(c) as category
    FROM products p
    LEFT JOIN product_images pi ON p.id = pi.product_id
    LEFT JOIN categories c ON p.category_id = c.id
    WHERE p.is_active = true
  `;
  const params = [];
  let paramIndex = 1;

  if (category_id) {
    query += ` AND p.category_id = $${paramIndex}`;
    params.push(category_id);
    paramIndex++;
  }
  if (search) {
    query += ` AND p.name ILIKE $${paramIndex}`;
    params.push(`%${search}%`);
    paramIndex++;
  }

  query += ` GROUP BY p.id, c.id ORDER BY p.${sortBy} ${order}`;

  try {
    const { rows } = await db.query(query, params);
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener productos' });
  }
};

// Obtener todos los productos (admin)
const getAllProducts = async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT p.*, 
             json_agg(DISTINCT jsonb_build_object(
               'id', pi.id,
               'image_url', pi.image_url,
               'is_main', pi.is_main
             )) FILTER (WHERE pi.id IS NOT NULL) as product_images,
             to_json(c) as category
      FROM products p
      LEFT JOIN product_images pi ON p.id = pi.product_id
      LEFT JOIN categories c ON p.category_id = c.id
      GROUP BY p.id, c.id
      ORDER BY p.created_at DESC
    `);
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener productos' });
  }
};

// Obtener un producto por ID (público)
const getProductById = async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await db.query(`
      SELECT p.*, 
             json_agg(DISTINCT jsonb_build_object(
               'id', pi.id,
               'image_url', pi.image_url,
               'is_main', pi.is_main
             )) FILTER (WHERE pi.id IS NOT NULL) as product_images,
             to_json(c) as category,
             (SELECT json_agg(pv) FROM product_variants pv WHERE pv.product_id = p.id AND pv.is_active = true) as variants
      FROM products p
      LEFT JOIN product_images pi ON p.id = pi.product_id
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.id = $1
      GROUP BY p.id, c.id
    `, [id]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }
    res.json(rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener producto' });
  }
};

// Crear producto (admin)
// FIX: antes no se guardaba purchase_cost aunque el frontend ya lo enviaba.
const createProduct = async (req, res) => {
  const {
    name, description, price, stock, category_id,
    is_active, is_featured, power_rms, impedance, sensitivity,
    purchase_cost, supplier_link, is_stocked
  } = req.body;
  try {
    const { rows } = await db.query(`
      INSERT INTO products 
        (name, description, price, stock, category_id, is_active, is_featured, power_rms, impedance, sensitivity, purchase_cost, supplier_link, is_stocked)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING *
    `, [name, description, price, stock, category_id, is_active, is_featured, power_rms, impedance, sensitivity, purchase_cost || 0, supplier_link || null, !!is_stocked]);
    res.status(201).json(rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al crear producto' });
  }
};

// Actualizar producto (admin)
// FIX: mismo problema, purchase_cost no se actualizaba.
const updateProduct = async (req, res) => {
  const { id } = req.params;
  const {
    name, description, price, stock, category_id,
    is_active, is_featured, power_rms, impedance, sensitivity,
    purchase_cost, supplier_link, is_stocked
  } = req.body;
  try {
    const { rows } = await db.query(`
      UPDATE products SET
        name = $1, description = $2, price = $3, stock = $4,
        category_id = $5, is_active = $6, is_featured = $7,
        power_rms = $8, impedance = $9, sensitivity = $10,
        purchase_cost = $11, supplier_link = $12, is_stocked = $13
      WHERE id = $14
      RETURNING *
    `, [name, description, price, stock, category_id, is_active, is_featured, power_rms, impedance, sensitivity, purchase_cost || 0, supplier_link || null, !!is_stocked, id]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }
    res.json(rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al actualizar producto' });
  }
};

// Eliminar producto (admin). Si tiene ventas o compras de inventario
// asociadas, Postgres bloquea el borrado - se lo explicamos al
// usuario en vez de fallar en silencio.
// ?force=true : borra en cascada su historial (ventas, pagos, compras,
// movimientos de caja asociados) antes de borrar el producto.
// Úsalo solo para limpiar datos de PRUEBA, nunca con productos reales.
const deleteProduct = async (req, res) => {
  const { id } = req.params;
  const force = req.query.force === 'true';

  try {
    if (force) {
      await db.query('BEGIN');

      // Ventas de este producto: borrar sus pagos y movimientos de caja primero
      const { rows: salesRows } = await db.query('SELECT id FROM sales WHERE product_id = $1', [id]);
      for (const sale of salesRows) {
        await db.query(`DELETE FROM cash_movements WHERE reference_table = 'sales' AND reference_id = $1`, [sale.id]);
        await db.query('DELETE FROM payments WHERE sale_id = $1', [sale.id]);
      }
      await db.query('DELETE FROM sales WHERE product_id = $1', [id]);

      // Compras de inventario de este producto
      const { rows: purchaseRows } = await db.query('SELECT id FROM inventory_purchases WHERE product_id = $1', [id]);
      for (const purchase of purchaseRows) {
        await db.query(`DELETE FROM cash_movements WHERE reference_table = 'inventory_purchases' AND reference_id = $1`, [purchase.id]);
      }
      await db.query('DELETE FROM inventory_purchases WHERE product_id = $1', [id]);

      await db.query('DELETE FROM product_images WHERE product_id = $1', [id]);

      const { rowCount } = await db.query('DELETE FROM products WHERE id = $1', [id]);
      if (rowCount === 0) {
        await db.query('ROLLBACK');
        return res.status(404).json({ error: 'Producto no encontrado' });
      }

      await db.query('COMMIT');
      return res.json({ message: 'Producto y su historial eliminados' });
    }

    const { rowCount } = await db.query('DELETE FROM products WHERE id = $1', [id]);
    if (rowCount === 0) {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }
    res.json({ message: 'Producto eliminado' });
  } catch (error) {
    if (force) await db.query('ROLLBACK');
    if (error.code === '23503') {
      return res.status(409).json({ error: 'No se puede eliminar: este producto tiene ventas o compras registradas en su historial. Desactívalo (interruptor "Activo") para ocultarlo del catálogo sin perder el historial, o bórralo con force=true si es solo un producto de prueba.' });
    }
    console.error(error);
    res.status(500).json({ error: 'Error al eliminar producto' });
  }
};

// Agregar imagen a producto (admin)
const addProductImage = async (req, res) => {
  const { productId } = req.params;
  const { image_url, is_main, order_index } = req.body;
  try {
    if (is_main) {
      await db.query('UPDATE product_images SET is_main = false WHERE product_id = $1', [productId]);
    }
    const { rows } = await db.query(
      'INSERT INTO product_images (product_id, image_url, is_main, order_index) VALUES ($1, $2, $3, $4) RETURNING *',
      [productId, image_url, is_main, order_index]
    );
    res.status(201).json(rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al agregar imagen' });
  }
};

// Eliminar imagen de producto
const deleteProductImage = async (req, res) => {
  const { id } = req.params;
  try {
    await db.query('DELETE FROM product_images WHERE id = $1', [id]);
    res.json({ message: 'Imagen eliminada' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al eliminar imagen' });
  }
};

module.exports = {
  getActiveProducts,
  getAllProducts,
  getProductById,
  createProduct,
  updateProduct,
  deleteProduct,
  addProductImage,
  deleteProductImage,
};