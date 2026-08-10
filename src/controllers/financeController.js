const db = require('../config/db');

// ==========================================
// HELPER: registrar un movimiento en el libro mayor (Caja)
// TODO lo que entra o sale de caja pasa por aquí. Esta es la
// única fuente de verdad para calcular el saldo de Caja.
// Acepta una fecha custom (para movimientos con fecha atrasada,
// como abonos o préstamos viejos); si no se pasa, usa NOW().
// ==========================================
const logCashMovement = async ({ type, direction, amount, reference_table, reference_id, description, created_at }) => {
  if (created_at) {
    await db.query(
      `INSERT INTO cash_movements (type, direction, amount, reference_table, reference_id, description, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [type, direction, amount, reference_table || null, reference_id || null, description || null, created_at]
    );
  } else {
    await db.query(
      `INSERT INTO cash_movements (type, direction, amount, reference_table, reference_id, description)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [type, direction, amount, reference_table || null, reference_id || null, description || null]
    );
  }
};

// ==========================================
// 1. CLIENTES
// ==========================================
const getClients = async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT c.*, 
      COALESCE(SUM(s.total_amount - COALESCE(p.total_paid, 0)), 0) as pending_balance
      FROM clients c
      LEFT JOIN sales s ON c.id = s.client_id AND s.status != 'paid'
      LEFT JOIN (
        SELECT sale_id, SUM(amount) as total_paid
        FROM payments
        GROUP BY sale_id
      ) p ON s.id = p.sale_id
      GROUP BY c.id
      ORDER BY c.name
    `);
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener clientes' });
  }
};

const getClientById = async (req, res) => {
  const { id } = req.params;
  try {
    const { rows: clientRows } = await db.query('SELECT * FROM clients WHERE id = $1', [id]);
    if (clientRows.length === 0) {
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }

    const { rows: salesRows } = await db.query(`
      SELECT s.*, p.name as product_name,
      (s.total_amount - COALESCE(pay.total_paid, 0)) as pending_amount
      FROM sales s
      LEFT JOIN products p ON s.product_id = p.id
      LEFT JOIN (
        SELECT sale_id, SUM(amount) as total_paid
        FROM payments
        GROUP BY sale_id
      ) pay ON s.id = pay.sale_id
      WHERE s.client_id = $1
      ORDER BY s.created_at DESC
    `, [id]);

    const total_purchases = salesRows.reduce((acc, s) => acc + parseFloat(s.total_amount), 0);
    const total_paid = salesRows.reduce((acc, s) => acc + parseFloat(s.total_amount - s.pending_amount), 0);
    const pending_balance = total_purchases - total_paid;

    res.json({
      ...clientRows[0],
      sales: salesRows,
      total_purchases,
      total_paid,
      pending_balance
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener cliente' });
  }
};

const createClient = async (req, res) => {
  const { name, phone, address, cedula } = req.body;
  try {
    const { rows } = await db.query(
      'INSERT INTO clients (name, phone, address, cedula) VALUES ($1, $2, $3, $4) RETURNING *',
      [name, phone, address, cedula || null]
    );
    res.status(201).json(rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al crear cliente' });
  }
};

// Editar cliente
const updateClient = async (req, res) => {
  const { id } = req.params;
  const { name, phone, address, cedula } = req.body;
  try {
    const { rows } = await db.query(
      'UPDATE clients SET name = $1, phone = $2, address = $3, cedula = $4 WHERE id = $5 RETURNING *',
      [name, phone, address, cedula || null, id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }
    res.json(rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al actualizar cliente' });
  }
};

// Eliminar cliente. Si tiene ventas asociadas, Postgres bloquea el
// borrado para no perder el historial financiero - se lo explicamos
// al usuario en vez de dejarlo con un error confuso.
const deleteClient = async (req, res) => {
  const { id } = req.params;
  try {
    const { rowCount } = await db.query('DELETE FROM clients WHERE id = $1', [id]);
    if (rowCount === 0) {
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }
    res.json({ message: 'Cliente eliminado' });
  } catch (error) {
    if (error.code === '23503') {
      return res.status(409).json({ error: 'No se puede eliminar: este cliente tiene ventas registradas. Su historial se perdería.' });
    }
    console.error(error);
    res.status(500).json({ error: 'Error al eliminar cliente' });
  }
};

// ==========================================
// 2. VENTAS (ahora conectadas al stock del catálogo y a la Caja)
// ==========================================
const getSales = async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT s.*, 
      c.name as client_name, 
      p.name as product_name,
      (s.total_amount - COALESCE(pay.total_paid, 0)) as pending_amount
      FROM sales s
      LEFT JOIN clients c ON s.client_id = c.id
      LEFT JOIN products p ON s.product_id = p.id
      LEFT JOIN (
        SELECT sale_id, SUM(amount) as total_paid
        FROM payments
        GROUP BY sale_id
      ) pay ON s.id = pay.sale_id
      ORDER BY s.created_at DESC
    `);
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener ventas' });
  }
};

// Registrar una venta (Crédito o Contado)
// - Descuenta el stock del producto vendido automáticamente.
// - Si es de CONTADO, entra dinero a caja de inmediato.
// - Si es a CRÉDITO, no entra dinero a caja hasta que se registre un abono.
const createSale = async (req, res) => {
  const { client_id, product_id, total_amount, sale_type, quantity } = req.body;
  const qty = parseInt(quantity) || 1;

  try {
    await db.query('BEGIN');

    const { rows: productRows } = await db.query('SELECT * FROM products WHERE id = $1', [product_id]);
    if (productRows.length === 0) {
      await db.query('ROLLBACK');
      return res.status(404).json({ error: 'Producto no encontrado' });
    }
    const product = productRows[0];

    // Solo se valida/descuenta stock si el producto está marcado como
    // inventario real (is_stocked = true). Si es "para pedir" (venta
    // sobre pedido, lo compras después de vender), no se toca el stock.
    if (product.is_stocked) {
      if (product.stock < qty) {
        await db.query('ROLLBACK');
        return res.status(400).json({ error: `Stock insuficiente. Disponible: ${product.stock}, solicitado: ${qty}` });
      }
    }

    const { rows } = await db.query(
      'INSERT INTO sales (client_id, product_id, total_amount, sale_type, status, quantity) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [client_id, product_id, total_amount, sale_type, sale_type === 'contado' ? 'paid' : 'pending', qty]
    );
    const sale = rows[0];

    if (product.is_stocked) {
      await db.query('UPDATE products SET stock = stock - $1 WHERE id = $2', [qty, product_id]);
    }

    // Solo la venta de contado mete plata a caja de inmediato
    if (sale_type === 'contado') {
      await logCashMovement({
        type: 'sale_cash',
        direction: 'in',
        amount: total_amount,
        reference_table: 'sales',
        reference_id: sale.id,
        description: `Venta de contado - ${product.name} x${qty}`
      });
    }

    await db.query('COMMIT');
    res.status(201).json(sale);
  } catch (error) {
    await db.query('ROLLBACK');
    console.error(error);
    res.status(500).json({ error: 'Error al registrar venta' });
  }
};

const getDebtors = async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT c.id, c.name, c.phone, 
      SUM(s.total_amount) as total_debt,
      COALESCE(SUM(p.amount), 0) as total_paid
      FROM clients c
      JOIN sales s ON c.id = s.client_id
      LEFT JOIN payments p ON s.id = p.sale_id
      WHERE s.status != 'paid'
      GROUP BY c.id, c.name, c.phone
      HAVING SUM(s.total_amount) > COALESCE(SUM(p.amount), 0)
    `);
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener cartera' });
  }
};

// ==========================================
// 3. PAGOS (Abonos a ventas a crédito) -> entra plata a caja
// ==========================================
const registerPayment = async (req, res) => {
  const { sale_id, amount, payment_method, payment_date } = req.body;
  try {
    await db.query('BEGIN');

    let paymentRows;
    if (payment_date) {
      ({ rows: paymentRows } = await db.query(
        'INSERT INTO payments (sale_id, amount, payment_method, created_at) VALUES ($1, $2, $3, $4) RETURNING *',
        [sale_id, amount, payment_method, payment_date]
      ));
    } else {
      ({ rows: paymentRows } = await db.query(
        'INSERT INTO payments (sale_id, amount, payment_method) VALUES ($1, $2, $3) RETURNING *',
        [sale_id, amount, payment_method]
      ));
    }

    await db.query(`
      UPDATE sales 
      SET status = 'paid' 
      WHERE id = $1 AND (SELECT SUM(amount) FROM payments WHERE sale_id = $1) >= total_amount
    `, [sale_id]);

    await logCashMovement({
      type: 'sale_credit_payment',
      direction: 'in',
      amount,
      reference_table: 'sales',
      reference_id: sale_id,
      description: `Abono a venta a crédito #${sale_id} (${payment_method || 'N/A'})`,
      created_at: payment_date || null
    });

    await db.query('COMMIT');
    res.status(201).json(paymentRows[0]);
  } catch (error) {
    await db.query('ROLLBACK');
    console.error(error);
    res.status(500).json({ error: 'Error al registrar pago' });
  }
};

// ==========================================
// 4. PRÉSTAMOS (ahora en ambas direcciones)
// direction = 'nos_deben' -> Vantix prestó plata (sale de caja, alguien nos debe)
// direction = 'debemos'   -> Vantix pidió prestado (entra a caja, nosotros debemos)
// ==========================================
const getLoans = async (req, res) => {
  const { direction } = req.query;
  try {
    let query = `
      SELECT l.*, COALESCE(SUM(lp.amount), 0) as total_paid
      FROM loans l
      LEFT JOIN loan_payments lp ON l.id = lp.loan_id
    `;
    const params = [];
    if (direction) {
      query += ` WHERE l.direction = $1`;
      params.push(direction);
    }
    query += ` GROUP BY l.id ORDER BY l.created_at DESC`;
    const { rows } = await db.query(query, params);
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener préstamos' });
  }
};

const createLoan = async (req, res) => {
  const { party_name, direction, total_amount, description, cedula, loan_date } = req.body;
  const dir = direction === 'debemos' ? 'debemos' : 'nos_deben';

  // Validación explícita: si esto falla, el frontend ahora muestra
  // el motivo real en vez de un error genérico.
  if (!party_name || !party_name.trim()) {
    return res.status(400).json({ error: 'Falta el nombre de la persona/entidad del préstamo' });
  }
  const amountNum = parseFloat(total_amount);
  if (isNaN(amountNum) || amountNum <= 0) {
    return res.status(400).json({ error: 'El monto del préstamo debe ser un número mayor a 0' });
  }

  try {
    await db.query('BEGIN');

    let rows;
    if (loan_date) {
      ({ rows } = await db.query(
        'INSERT INTO loans (party_name, direction, total_amount, description, cedula, created_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
        [party_name.trim(), dir, amountNum, description, cedula || null, loan_date]
      ));
    } else {
      ({ rows } = await db.query(
        'INSERT INTO loans (party_name, direction, total_amount, description, cedula) VALUES ($1, $2, $3, $4, $5) RETURNING *',
        [party_name.trim(), dir, amountNum, description, cedula || null]
      ));
    }
    const loan = rows[0];

    // Si nos prestan (debemos) -> entra plata. Si prestamos (nos_deben) -> sale plata.
    await logCashMovement({
      type: dir === 'debemos' ? 'loan_in' : 'loan_out',
      direction: dir === 'debemos' ? 'in' : 'out',
      amount: amountNum,
      reference_table: 'loans',
      reference_id: loan.id,
      description: dir === 'debemos'
        ? `Préstamo recibido de ${party_name}`
        : `Préstamo otorgado a ${party_name}`,
      created_at: loan_date || null
    });

    await db.query('COMMIT');
    res.status(201).json(loan);
  } catch (error) {
    await db.query('ROLLBACK');
    console.error(error);
    res.status(500).json({ error: 'Error al crear préstamo' });
  }
};

const updateLoan = async (req, res) => {
  const { id } = req.params;
  const { party_name, total_amount, description, cedula } = req.body;
  try {
    const { rows } = await db.query(
      'UPDATE loans SET party_name = $1, total_amount = $2, description = $3, cedula = $4 WHERE id = $5 RETURNING *',
      [party_name, total_amount, description, cedula || null, id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Préstamo no encontrado' });
    }
    res.json(rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al actualizar préstamo' });
  }
};

const deleteLoan = async (req, res) => {
  const { id } = req.params;
  try {
    await db.query('BEGIN');
    await db.query(`DELETE FROM cash_movements WHERE reference_table = 'loans' AND reference_id = $1`, [id]);
    await db.query('DELETE FROM loan_payments WHERE loan_id = $1', [id]);
    const { rowCount } = await db.query('DELETE FROM loans WHERE id = $1', [id]);
    if (rowCount === 0) {
      await db.query('ROLLBACK');
      return res.status(404).json({ error: 'Préstamo no encontrado' });
    }
    await db.query('COMMIT');
    res.json({ message: 'Préstamo eliminado' });
  } catch (error) {
    await db.query('ROLLBACK');
    console.error(error);
    res.status(500).json({ error: 'Error al eliminar préstamo' });
  }
};

const registerLoanPayment = async (req, res) => {
  const { id } = req.params;
  const { amount, payment_date } = req.body;
  try {
    await db.query('BEGIN');

    const { rows: loanRows } = await db.query('SELECT * FROM loans WHERE id = $1', [id]);
    if (loanRows.length === 0) {
      await db.query('ROLLBACK');
      return res.status(404).json({ error: 'Préstamo no encontrado' });
    }
    const loan = loanRows[0];

    if (payment_date) {
      await db.query('INSERT INTO loan_payments (loan_id, amount, created_at) VALUES ($1, $2, $3)', [id, amount, payment_date]);
    } else {
      await db.query('INSERT INTO loan_payments (loan_id, amount) VALUES ($1, $2)', [id, amount]);
    }

    await db.query(`
      UPDATE loans 
      SET status = 'paid' 
      WHERE id = $1 AND (SELECT SUM(amount) FROM loan_payments WHERE loan_id = $1) >= total_amount
    `, [id]);

    // Si nos debían (nos_deben) y pagan -> entra caja.
    // Si nosotros debíamos (debemos) y pagamos -> sale caja.
    await logCashMovement({
      type: loan.direction === 'nos_deben' ? 'loan_payment_received' : 'loan_payment_made',
      direction: loan.direction === 'nos_deben' ? 'in' : 'out',
      amount,
      reference_table: 'loans',
      reference_id: id,
      description: `Abono de préstamo con ${loan.party_name}`,
      created_at: payment_date || null
    });

    await db.query('COMMIT');
    res.json({ message: 'Pago registrado' });
  } catch (error) {
    await db.query('ROLLBACK');
    console.error(error);
    res.status(500).json({ error: 'Error al registrar pago de préstamo' });
  }
};

// ==========================================
// 5. GASTOS OPERATIVOS (afectan caja, pero se reportan aparte
//    de compras de inventario / préstamos / inversión bancaria)
// ==========================================
const getExpenses = async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM expenses ORDER BY created_at DESC');
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener gastos' });
  }
};

const createExpense = async (req, res) => {
  const { description, amount, category } = req.body;
  try {
    await db.query('BEGIN');
    const { rows } = await db.query(
      'INSERT INTO expenses (description, amount, category) VALUES ($1, $2, $3) RETURNING *',
      [description, amount, category]
    );
    const expense = rows[0];

    await logCashMovement({
      type: 'expense',
      direction: 'out',
      amount,
      reference_table: 'expenses',
      reference_id: expense.id,
      description: `Gasto: ${description}`
    });

    await db.query('COMMIT');
    res.status(201).json(expense);
  } catch (error) {
    await db.query('ROLLBACK');
    console.error(error);
    res.status(500).json({ error: 'Error al crear gasto' });
  }
};

const updateExpense = async (req, res) => {
  const { id } = req.params;
  const { description, amount, category } = req.body;
  try {
    await db.query('BEGIN');
    const { rows } = await db.query(
      'UPDATE expenses SET description = $1, amount = $2, category = $3 WHERE id = $4 RETURNING *',
      [description, amount, category, id]
    );
    if (rows.length === 0) {
      await db.query('ROLLBACK');
      return res.status(404).json({ error: 'Gasto no encontrado' });
    }
    // Mantener sincronizado el movimiento de caja asociado
    await db.query(
      `UPDATE cash_movements SET amount = $1, description = $2 WHERE reference_table = 'expenses' AND reference_id = $3`,
      [amount, `Gasto: ${description}`, id]
    );
    await db.query('COMMIT');
    res.json(rows[0]);
  } catch (error) {
    await db.query('ROLLBACK');
    console.error(error);
    res.status(500).json({ error: 'Error al actualizar gasto' });
  }
};

const deleteExpense = async (req, res) => {
  const { id } = req.params;
  try {
    await db.query('BEGIN');
    await db.query(`DELETE FROM cash_movements WHERE reference_table = 'expenses' AND reference_id = $1`, [id]);
    await db.query('DELETE FROM expenses WHERE id = $1', [id]);
    await db.query('COMMIT');
    res.json({ message: 'Gasto eliminado' });
  } catch (error) {
    await db.query('ROLLBACK');
    console.error(error);
    res.status(500).json({ error: 'Error al eliminar gasto' });
  }
};

// ==========================================
// 6. COMPRAS DE INVENTARIO (paso 2 y 7 de tu flujo)
// Suma stock al producto + saca plata de caja + actualiza el
// costo promedio del producto (purchase_cost).
// ==========================================
const createInventoryPurchase = async (req, res) => {
  const { product_id, quantity, unit_cost, description, update_product_cost } = req.body;
  const qty = parseInt(quantity);
  const cost = parseFloat(unit_cost);

  if (!product_id || !qty || qty <= 0 || isNaN(cost)) {
    return res.status(400).json({ error: 'Datos de compra inválidos' });
  }
  const total_cost = qty * cost;

  try {
    await db.query('BEGIN');

    const { rows: productRows } = await db.query('SELECT * FROM products WHERE id = $1', [product_id]);
    if (productRows.length === 0) {
      await db.query('ROLLBACK');
      return res.status(404).json({ error: 'Producto no encontrado' });
    }
    const product = productRows[0];

    const { rows } = await db.query(
      'INSERT INTO inventory_purchases (product_id, quantity, unit_cost, total_cost, description) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [product_id, qty, cost, total_cost, description || null]
    );
    const purchase = rows[0];

    // Al comprar inventario, el producto pasa a ser "stock real" automáticamente
    await db.query('UPDATE products SET stock = stock + $1, is_stocked = true WHERE id = $2', [qty, product_id]);

    if (update_product_cost !== false) {
      await db.query('UPDATE products SET purchase_cost = $1 WHERE id = $2', [cost, product_id]);
    }

    await logCashMovement({
      type: 'inventory_purchase',
      direction: 'out',
      amount: total_cost,
      reference_table: 'inventory_purchases',
      reference_id: purchase.id,
      description: description || `Compra de inventario - ${product.name} x${qty}`
    });

    await db.query('COMMIT');
    res.status(201).json(purchase);
  } catch (error) {
    await db.query('ROLLBACK');
    console.error(error);
    res.status(500).json({ error: 'Error al registrar compra de inventario' });
  }
};

const getInventoryPurchases = async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT ip.*, p.name as product_name
      FROM inventory_purchases ip
      LEFT JOIN products p ON ip.product_id = p.id
      ORDER BY ip.created_at DESC
    `);
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener compras de inventario' });
  }
};

// ==========================================
// 7. INVERSIÓN BANCARIA (paso 5 de tu flujo)
// Es un activo aparte de la caja operativa: sale caja al
// depositar, entra caja al retirar.
// ==========================================
const createBankMovement = async (req, res) => {
  const { type, amount, description } = req.body;
  const t = type === 'withdrawal' ? 'withdrawal' : 'deposit';

  try {
    await db.query('BEGIN');
    const { rows } = await db.query(
      'INSERT INTO bank_investments (type, amount, description) VALUES ($1,$2,$3) RETURNING *',
      [t, amount, description || null]
    );
    const movement = rows[0];

    await logCashMovement({
      type: 'bank_investment',
      direction: t === 'deposit' ? 'out' : 'in',
      amount,
      reference_table: 'bank_investments',
      reference_id: movement.id,
      description: description || (t === 'deposit' ? 'Inversión en banco' : 'Retiro de inversión bancaria')
    });

    await db.query('COMMIT');
    res.status(201).json(movement);
  } catch (error) {
    await db.query('ROLLBACK');
    console.error(error);
    res.status(500).json({ error: 'Error al registrar movimiento bancario' });
  }
};

const getBankInvestments = async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM bank_investments ORDER BY created_at DESC');
    const balance = rows.reduce(
      (acc, m) => acc + (m.type === 'deposit' ? parseFloat(m.amount) : -parseFloat(m.amount)),
      0
    );
    res.json({ movements: rows, balance });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener inversiones bancarias' });
  }
};

// ==========================================
// 8. LIBRO MAYOR (Caja) - historial completo de movimientos
// ==========================================
const getCashMovements = async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM cash_movements ORDER BY created_at DESC LIMIT 300');
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener movimientos de caja' });
  }
};

// ==========================================
// 9. DASHBOARD FINANCIERO (recalculado desde el ledger real)
// ==========================================
const getDashboard = async (req, res) => {
  try {
    // Caja real = todo lo que entró - todo lo que salió (fuente única de verdad)
    const { rows: cajaRows } = await db.query(`
      SELECT
        COALESCE(SUM(CASE WHEN direction = 'in' THEN amount ELSE 0 END), 0) as total_in,
        COALESCE(SUM(CASE WHEN direction = 'out' THEN amount ELSE 0 END), 0) as total_out
      FROM cash_movements
    `);
    const total_in = parseFloat(cajaRows[0].total_in);
    const total_out = parseFloat(cajaRows[0].total_out);
    const total_caja = total_in - total_out;

    // Cartera: ventas a crédito pendientes de cobro
    const { rows: cartera } = await db.query(`
      SELECT SUM(s.total_amount - COALESCE(p.total_paid, 0)) as total_cartera
      FROM sales s
      LEFT JOIN (SELECT sale_id, SUM(amount) as total_paid FROM payments GROUP BY sale_id) p ON s.id = p.sale_id
      WHERE s.status != 'paid'
    `);

    // Préstamos: lo que nos deben vs. lo que nosotros debemos
    const { rows: loansSummary } = await db.query(`
      SELECT l.direction, SUM(l.total_amount - COALESCE(lp.total_paid, 0)) as pending
      FROM loans l
      LEFT JOIN (SELECT loan_id, SUM(amount) as total_paid FROM loan_payments GROUP BY loan_id) lp ON l.id = lp.loan_id
      GROUP BY l.direction
    `);
    const loans_nos_deben = parseFloat(loansSummary.find(l => l.direction === 'nos_deben')?.pending || 0);
    const loans_debemos = parseFloat(loansSummary.find(l => l.direction === 'debemos')?.pending || 0);

    // Inversión bancaria (activo aparte de caja)
    const { rows: bankRows } = await db.query('SELECT type, SUM(amount) as total FROM bank_investments GROUP BY type');
    const bankDeposits = parseFloat(bankRows.find(b => b.type === 'deposit')?.total || 0);
    const bankWithdrawals = parseFloat(bankRows.find(b => b.type === 'withdrawal')?.total || 0);
    const total_banco = bankDeposits - bankWithdrawals;

    // Gastos operativos (solo la tabla expenses, no compras de inventario ni préstamos)
    const { rows: gastosOp } = await db.query(`SELECT COALESCE(SUM(amount),0) as total FROM expenses`);

    // Rentabilidad real: ventas totales vs. costo de mercancía vendida.
    // El costo de mercancía solo se calcula sobre productos con
    // inventario real (is_stocked = true) - para los que vendes sobre
    // pedido, el costo aparece más adelante como "inventory_purchase"
    // en la Caja cuando efectivamente los compras.
    const { rows: rentabilidad } = await db.query(`
      SELECT
        COALESCE(SUM(s.total_amount), 0) as total_ventas,
        COALESCE(SUM(CASE WHEN p.is_stocked THEN p.purchase_cost * s.quantity ELSE 0 END), 0) as total_costo_mercancia
      FROM sales s
      JOIN products p ON s.product_id = p.id
    `);

    res.json({
      total_caja,
      total_cartera: parseFloat(cartera[0]?.total_cartera || 0),
      loans_nos_deben,
      loans_debemos,
      total_banco,
      total_gastos_operativos: parseFloat(gastosOp[0]?.total || 0),
      // Compatibilidad con el dashboard anterior (Dashboard.jsx viejo)
      total_ingresos: total_in,
      total_gastos: total_out,
      rentabilidad: {
        total_ventas: parseFloat(rentabilidad[0]?.total_ventas || 0),
        total_inversion: parseFloat(rentabilidad[0]?.total_costo_mercancia || 0),
        ganancia: parseFloat(rentabilidad[0]?.total_ventas || 0) - parseFloat(rentabilidad[0]?.total_costo_mercancia || 0)
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener dashboard' });
  }
};

// ==========================================
// 10. ELIMINAR Y ACTUALIZAR VENTAS
// Al eliminar una venta se revierte el stock y se borran sus
// movimientos de caja asociados, para no dejar la Caja inflada.
// ==========================================
const deleteSale = async (req, res) => {
  const { id } = req.params;
  try {
    await db.query('BEGIN');
    const { rows } = await db.query('SELECT * FROM sales WHERE id = $1', [id]);
    if (rows.length === 0) {
      await db.query('ROLLBACK');
      return res.status(404).json({ error: 'Venta no encontrada' });
    }
    const sale = rows[0];

    await db.query('UPDATE products SET stock = stock + $1 WHERE id = $2', [sale.quantity || 1, sale.product_id]);
    await db.query(`DELETE FROM cash_movements WHERE reference_table = 'sales' AND reference_id = $1`, [id]);
    await db.query('DELETE FROM payments WHERE sale_id = $1', [id]);
    await db.query('DELETE FROM sales WHERE id = $1', [id]);

    await db.query('COMMIT');
    res.json({ message: 'Venta eliminada y stock restaurado' });
  } catch (error) {
    await db.query('ROLLBACK');
    console.error(error);
    res.status(500).json({ error: 'Error al eliminar venta' });
  }
};

// Nota: edición de venta se deja simple (no recalcula stock/caja).
// Si el monto o producto cambia sustancialmente, es más seguro
// eliminar la venta y volver a registrarla.
const updateSale = async (req, res) => {
  const { id } = req.params;
  const { product_name, total_amount } = req.body;
  try {
    const { rows } = await db.query(
      'UPDATE sales SET product_name = $1, total_amount = $2 WHERE id = $3 RETURNING *',
      [product_name, total_amount, id]
    );
    res.json(rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al actualizar venta' });
  }
};

// ==========================================
// EXPORTACIONES
// ==========================================
module.exports = {
  getClients, getClientById, createClient, updateClient, deleteClient,
  getSales, createSale, updateSale, deleteSale, getDebtors,
  registerPayment,
  getLoans, createLoan, updateLoan, deleteLoan, registerLoanPayment,
  getExpenses, createExpense, updateExpense, deleteExpense,
  createInventoryPurchase, getInventoryPurchases,
  createBankMovement, getBankInvestments,
  getCashMovements,
  getDashboard
};