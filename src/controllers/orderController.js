const db = require('../config/db');

// Crear un nuevo pedido (público)
const createOrder = async (req, res) => {
  const { customer_name, phone, address, payment_method, discount_code, note, items } = req.body;

  if (!items || items.length === 0) {
    return res.status(400).json({ error: 'El pedido debe tener al menos un producto' });
  }

  const subtotal = items.reduce((acc, item) => acc + (item.unit_price * item.quantity), 0);

  let discount_amount = 0;
  let discount_id = null;

  if (discount_code) {
    const { rows } = await db.query(
      'SELECT * FROM discounts WHERE code = $1 AND is_active = true AND (expires_at IS NULL OR expires_at > NOW())',
      [discount_code]
    );
    if (rows.length > 0) {
      const discount = rows[0];
      if (discount.min_order <= subtotal) {
        if (discount.type === 'percentage') {
          discount_amount = (subtotal * discount.value) / 100;
        } else {
          discount_amount = discount.value;
        }
        discount_id = discount.id;
      }
    }
  }

  const total = subtotal - discount_amount;

  try {
    await db.query('BEGIN');

    const { rows: orderRows } = await db.query(`
      INSERT INTO orders 
        (customer_name, phone, address, payment_method, discount_code, discount_amount, subtotal, total, note)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id
    `, [customer_name, phone, address, payment_method, discount_code, discount_amount, subtotal, total, note]);

    const orderId = orderRows[0].id;

    for (const item of items) {
      await db.query(`
        INSERT INTO order_items 
          (order_id, product_id, product_name, variant, quantity, unit_price)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [orderId, item.product_id, item.product_name, item.variant, item.quantity, item.unit_price]);
    }

    await db.query('COMMIT');

    res.status(201).json({
      message: 'Pedido creado exitosamente',
      orderId,
      total,
    });

  } catch (error) {
    await db.query('ROLLBACK');
    console.error(error);
    res.status(500).json({ error: 'Error al crear pedido' });
  }
};

// Obtener todos los pedidos (admin)
const getAllOrders = async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT o.*, 
             json_agg(oi.*) as items
      FROM orders o
      LEFT JOIN order_items oi ON o.id = oi.order_id
      GROUP BY o.id
      ORDER BY o.created_at DESC
    `);
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener pedidos' });
  }
};

// Actualizar estado de pedido (admin)
const updateOrderStatus = async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  try {
    const { rows } = await db.query(
      'UPDATE orders SET status = $1 WHERE id = $2 RETURNING *',
      [status, id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }
    res.json(rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al actualizar pedido' });
  }
};

module.exports = {
  createOrder,
  getAllOrders,
  updateOrderStatus,
};