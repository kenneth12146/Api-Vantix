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

    // Traer los abonos detallados de cada venta (para poder mostrarlos/eliminarlos)
    const saleIds = salesRows.map(s => s.id);
    let paymentsMap = {};
    if (saleIds.length > 0) {
      const { rows: payRows } = await db.query(
        'SELECT * FROM payments WHERE sale_id = ANY($1) ORDER BY created_at ASC',
        [saleIds]
      );
      paymentsMap = payRows.reduce((acc, p) => {
        (acc[p.sale_id] = acc[p.sale_id] || []).push(p);
        return acc;
      }, {});
    }
    // Adjuntar los abonos a cada venta
    const salesWithPayments = salesRows.map(s => ({
      ...s,
      payments: paymentsMap[s.id] || []
    }));

    const total_purchases = salesRows.reduce((acc, s) => acc + parseFloat(s.total_amount), 0);
    const total_paid = salesRows.reduce((acc, s) => acc + parseFloat(s.total_amount - s.pending_amount), 0);
    const pending_balance = total_purchases - total_paid;

    res.json({
      ...clientRows[0],
      sales: salesWithPayments,
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
// Eliminar un abono (cuando te pasaste de plata o te equivocaste)
// - Elimina el abono de payments
// - Elimina el movimiento de caja asociado (sale_credit_payment)
// - Recalcula el status de la venta (si ya no está cubierta -> pending)
const deletePayment = async (req, res) => {
  const { id } = req.params;
  try {
    await db.query('BEGIN');

    // Buscar el abono
    const { rows } = await db.query('SELECT * FROM payments WHERE id = $1', [id]);
    if (rows.length === 0) {
      await db.query('ROLLBACK');
      return res.status(404).json({ error: 'Abono no encontrado' });
    }
    const payment = rows[0];

    // Eliminar el movimiento de caja asociado (sale_credit_payment)
    // Coincide por reference_id (sale_id), type, amount y el más reciente
    await db.query(`
      DELETE FROM cash_movements
      WHERE reference_table = 'sales'
        AND reference_id = $1
        AND type = 'sale_credit_payment'
        AND amount = $2
        AND id = (
          SELECT id FROM cash_movements
          WHERE reference_table = 'sales'
            AND reference_id = $1
            AND type = 'sale_credit_payment'
            AND amount = $2
          ORDER BY id DESC
          LIMIT 1
        )
    `, [payment.sale_id, payment.amount]);

    // Eliminar el abono
    await db.query('DELETE FROM payments WHERE id = $1', [id]);

    // Recalcular el status de la venta
    const { rows: saleRows } = await db.query('SELECT * FROM sales WHERE id = $1', [payment.sale_id]);
    let newStatus = saleRows.length > 0 ? saleRows[0].status : 'pending';
    if (saleRows.length > 0) {
      const sale = saleRows[0];
      const { rows: paidRows } = await db.query(
        'SELECT COALESCE(SUM(amount), 0) as total_paid FROM payments WHERE sale_id = $1',
        [payment.sale_id]
      );
      newStatus = parseFloat(paidRows[0].total_paid) >= parseFloat(sale.total_amount) ? 'paid' : 'pending';
      await db.query('UPDATE sales SET status = $1 WHERE id = $2', [newStatus, payment.sale_id]);
    }

    await db.query('COMMIT');
    res.json({
      message: 'Abono eliminado correctamente',
      sale_id: payment.sale_id,
      deleted_amount: payment.amount,
      new_status: newStatus
    });
  } catch (error) {
    await db.query('ROLLBACK');
    console.error(error);
    res.status(500).json({ error: 'Error al eliminar el abono' });
  }
};


// ==========================================
// 4. PRÉSTAMOS (ahora en ambas direcciones)
// direction = 'nos_deben' -> Vantix prestó plata (sale de caja, alguien nos debe)
// direction = 'debemos'   -> Vantix pidió prestado (entra a caja, nosotros debemos)
// ==========================================

// Calcula y valida el interés de un préstamo. Devuelve valores listos para
// guardar. IMPORTANTE: solo produce datos informativos; nunca escribe en
// cash_movements, para no alterar los balances existentes.
//
//   simple  -> interés = capital * (tasa/100)          (una sola vez)
//   mensual -> interés = capital * (tasa/100) * plazo  (tasa por mes)
const normalizeInterest = (body) => {
  const rate = body.interest_rate === undefined || body.interest_rate === '' || body.interest_rate === null
    ? 0
    : Number(body.interest_rate);
  const type = body.interest_type === 'mensual' ? 'mensual' : 'simple';
  const months = body.term_months === undefined || body.term_months === '' || body.term_months === null
    ? 0
    : parseInt(body.term_months, 10);

  if (!Number.isFinite(rate) || rate < 0) {
    return { error: 'El porcentaje de interés debe ser un número mayor o igual a 0' };
  }
  if (!Number.isFinite(months) || months < 0) {
    return { error: 'El plazo en meses debe ser un número entero mayor o igual a 0' };
  }

  // Si viene interest_amount explícito se respeta (el frontend y el backend
  // usan la misma fórmula); si no, se calcula aquí a partir del capital.
  const capital = Number(body.total_amount) || 0;
  let amount;
  if (body.interest_amount !== undefined && body.interest_amount !== '' && body.interest_amount !== null) {
    amount = Number(body.interest_amount);
  } else {
    amount = type === 'mensual' ? capital * (rate / 100) * months : capital * (rate / 100);
  }
  if (!Number.isFinite(amount) || amount < 0) {
    return { error: 'El interés calculado no es válido' };
  }

  return {
    rate: Math.round(rate * 100) / 100,
    type,
    months,
    amount: Math.round(amount * 100) / 100,
  };
};
const getLoans = async (req, res) => {
  const { direction } = req.query;
  try {
    let query = `
      SELECT l.*,
             COALESCE(SUM(lp.amount), 0) as total_paid,
             GREATEST(ROUND((l.interest_amount - COALESCE(l.interest_paid, 0))::numeric, 2), 0) as interest_pending,
             ROUND((l.total_amount - COALESCE(SUM(lp.amount), 0))::numeric, 2) as capital_pending
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

  // Interés pactado (opcional). Es informativo: NO genera movimientos de
  // caja ni altera el capital de `total_amount`.
  const interest = normalizeInterest(req.body);
  if (interest.error) {
    return res.status(400).json({ error: interest.error });
  }

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
        `INSERT INTO loans (party_name, direction, total_amount, description, cedula, created_at,
                            interest_rate, interest_type, term_months, interest_amount)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [party_name.trim(), dir, amountNum, description, cedula || null, loan_date,
         interest.rate, interest.type, interest.months, interest.amount]
      ));
    } else {
      ({ rows } = await db.query(
        `INSERT INTO loans (party_name, direction, total_amount, description, cedula,
                            interest_rate, interest_type, term_months, interest_amount)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [party_name.trim(), dir, amountNum, description, cedula || null,
         interest.rate, interest.type, interest.months, interest.amount]
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
  // Si el body trae campos de interés se actualizan; si no, se conservan.
  const touchesInterest = ['interest_rate', 'interest_type', 'term_months', 'interest_amount']
    .some(k => req.body[k] !== undefined);
  const interest = touchesInterest ? normalizeInterest(req.body) : null;
  if (interest && interest.error) {
    return res.status(400).json({ error: interest.error });
  }
  try {
    const { rows } = await db.query(
      `UPDATE loans SET party_name = $1, total_amount = $2, description = $3, cedula = $4,
              interest_rate   = COALESCE($6, interest_rate),
              interest_type   = COALESCE($7, interest_type),
              term_months     = COALESCE($8, term_months),
              interest_amount = COALESCE($9, interest_amount)
       WHERE id = $5 RETURNING *`,
      [party_name, total_amount, description, cedula || null, id,
       interest ? interest.rate : null,
       interest ? interest.type : null,
       interest ? interest.months : null,
       interest ? interest.amount : null]
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

// EDITAR VENTA (corregido)
// - "product_name" NO es columna de la tabla sales (viene del JOIN con products),
//   así que el UPDATE anterior siempre fallaba. Se corrige para que el frontend
//   solo cambie el monto total.
// - Se recalcula el status según los abonos ya registrados.
// - Si era venta de contado, se sincroniza el movimiento de caja (sale_cash).
const updateSale = async (req, res) => {
  const { id } = req.params;
  const { total_amount } = req.body;

  const newAmount = parseFloat(total_amount);
  if (isNaN(newAmount) || newAmount < 0) {
    return res.status(400).json({ error: "El monto de la venta debe ser un número válido" });
  }

  try {
    await db.query("BEGIN");

    const { rows } = await db.query("SELECT * FROM sales WHERE id = $1", [id]);
    if (rows.length === 0) {
      await db.query("ROLLBACK");
      return res.status(404).json({ error: "Venta no encontrada" });
    }
    const sale = rows[0];
    const oldAmount = parseFloat(sale.total_amount);

    // 1. Actualizar el monto total
    await db.query(
      "UPDATE sales SET total_amount = $1 WHERE id = $2",
      [newAmount, id]
    );

    // 2. Recalcular el status: si los abonos ya cubren el nuevo total -> pagado
    const { rows: paidRows } = await db.query(
      "SELECT COALESCE(SUM(amount), 0) as total_paid FROM payments WHERE sale_id = $1",
      [id]
    );
    const totalPaid = parseFloat(paidRows[0].total_paid);
    const newStatus = totalPaid >= newAmount ? "paid" : "pending";
    await db.query("UPDATE sales SET status = $1 WHERE id = $2", [newStatus, id]);

    // 3. Si era una venta de contado, la plata que entró a caja
    //    era por el monto viejo -> hay que ajustar el movimiento.
    if (sale.sale_type === "contado" && oldAmount !== newAmount) {
      await db.query(
        `UPDATE cash_movements
         SET amount = $1, description = $2
         WHERE reference_table = "sales" AND reference_id = $3 AND type = "sale_cash"`,
        [newAmount, `Venta de contado #${id} (monto corregido a ${newAmount})`, id]
      );
    }

    await db.query("COMMIT");

    // Devolver la venta con el nombre del producto para el frontend
    const { rows: finalRows } = await db.query(`
      SELECT s.*, c.name as client_name, p.name as product_name,
      (s.total_amount - COALESCE(pay.total_paid, 0)) as pending_amount
      FROM sales s
      LEFT JOIN clients c ON s.client_id = c.id
      LEFT JOIN products p ON s.product_id = p.id
      LEFT JOIN (SELECT sale_id, SUM(amount) as total_paid FROM payments GROUP BY sale_id) pay ON s.id = pay.sale_id
      WHERE s.id = $1
    `, [id]);

    res.json(finalRows[0]);
  } catch (error) {
    await db.query("ROLLBACK");
    console.error(error);
    res.status(500).json({ error: "Error al actualizar venta" });
  }
};

// ==========================================
// EXPORTACIONES
// ==========================================
// ==========================================
// Cobro de INTERESES de un préstamo
//
// El interés vive separado del capital en todo momento:
//   - loans.total_amount  → capital (NO se modifica aquí)
//   - loans.interest_amount → interés pactado (fijo)
//   - loans.interest_paid → interés ya cobrado (se acumula aquí)
//
// Cada cobro genera su PROPIO movimiento de caja, con tipo
// 'loan_interest_received', para poder distinguir en la contabilidad
// cuánto entró por capital y cuánto por intereses.
//
// Dirección del movimiento:
//   nos_deben (yo presté, cobro intereses) → 'in'  (entra plata)
//   debemos   (me prestaron, pago intereses) → 'out' (sale plata)
//
// Se puede cobrar en varias cuotas; nunca se puede superar el pactado.
// ==========================================
const registerInterestPayment = async (req, res) => {
  const { id } = req.params;
  const { amount, payment_date } = req.body;
  const amountNum = Number(amount);

  if (!Number.isFinite(amountNum) || amountNum <= 0) {
    return res.status(400).json({ error: 'El monto debe ser mayor a 0' });
  }

  try {
    await db.query('BEGIN');

    // Bloqueo de fila para que dos cobros simultáneos no se pisen.
    const { rows: loanRows } = await db.query('SELECT * FROM loans WHERE id = $1 FOR UPDATE', [id]);
    if (loanRows.length === 0) {
      await db.query('ROLLBACK');
      return res.status(404).json({ error: 'Préstamo no encontrado' });
    }

    const loan = loanRows[0];
    const interestAmount = Number(loan.interest_amount) || 0;
    const interestPaid = Number(loan.interest_paid) || 0;
    const pending = Math.round((interestAmount - interestPaid) * 100) / 100;

    if (interestAmount <= 0) {
      await db.query('ROLLBACK');
      return res.status(400).json({ error: 'Este préstamo no tiene intereses pactados' });
    }
    if (pending <= 0) {
      await db.query('ROLLBACK');
      return res.status(400).json({ error: 'Este préstamo ya tiene los intereses cobrados en su totalidad' });
    }
    if (amountNum > pending) {
      await db.query('ROLLBACK');
      return res.status(400).json({
        error: `El monto supera el interés pendiente (${pending.toFixed(2)})`
      });
    }

    // Acumular el cobro. Se redondea a 2 decimales para evitar arrastres
    // de coma flotante que romperían el CHECK (interest_paid <= interest_amount).
    const { rows: updated } = await db.query(
      `UPDATE loans
       SET interest_paid = ROUND((COALESCE(interest_paid, 0) + $2)::numeric, 2)
       WHERE id = $1
       RETURNING *`,
      [id, amountNum]
    );

    const isLender = loan.direction !== 'debemos';

    await logCashMovement({
      type: 'loan_interest_received',
      direction: isLender ? 'in' : 'out',
      amount: amountNum,
      reference_table: 'loans',
      reference_id: id,
      description: isLender
        ? `Intereses cobrados a ${loan.party_name}`
        : `Intereses pagados a ${loan.party_name}`,
      created_at: payment_date || null,
    });

    await db.query('COMMIT');

    res.json({
      message: 'Interés registrado en caja',
      loan: updated[0],
      interest_pending: Math.round((interestAmount - Number(updated[0].interest_paid)) * 100) / 100,
    });
  } catch (error) {
    await db.query('ROLLBACK');
    console.error(error);
    res.status(500).json({ error: 'Error al registrar el cobro de intereses' });
  }
};

// ==========================================
// Quitar el interés pactado de un préstamo
//
// Solo se permite si NO se ha cobrado nada (interest_paid = 0). Si ya hay
// cobros registrados, habría movimientos reales en cash_movements que
// quedarían sin respaldo y la caja se descuadraría.
//
// El capital (total_amount) NUNCA se toca: quitar el interés devuelve el
// préstamo exactamente a como estaba antes de pactarlo.
// ==========================================
const removeLoanInterest = async (req, res) => {
  const { id } = req.params;
  try {
    await db.query('BEGIN');

    const { rows } = await db.query('SELECT * FROM loans WHERE id = $1 FOR UPDATE', [id]);
    if (rows.length === 0) {
      await db.query('ROLLBACK');
      return res.status(404).json({ error: 'Préstamo no encontrado' });
    }

    const loan = rows[0];
    const paid = Number(loan.interest_paid) || 0;

    if (paid > 0) {
      await db.query('ROLLBACK');
      return res.status(400).json({
        error: `No se puede quitar: ya se cobraron ${paid.toFixed(2)} en intereses. Este dinero ya está registrado en caja.`,
      });
    }

    const { rows: updated } = await db.query(
      `UPDATE loans
       SET interest_rate = 0,
           interest_type = 'simple',
           term_months = 0,
           interest_amount = 0
       WHERE id = $1
       RETURNING *`,
      [id]
    );

    await db.query('COMMIT');
    res.json({ message: 'Interés eliminado del préstamo', loan: updated[0] });
  } catch (error) {
    await db.query('ROLLBACK');
    console.error(error);
    res.status(500).json({ error: 'Error al quitar el interés' });
  }
};

module.exports = {
  getClients, getClientById, createClient, updateClient, deleteClient,
  getSales, createSale, updateSale, deleteSale, getDebtors,
  registerPayment,
  deletePayment,
  getLoans, createLoan, updateLoan, deleteLoan, registerLoanPayment, registerInterestPayment, removeLoanInterest,
  getExpenses, createExpense, updateExpense, deleteExpense,
  createInventoryPurchase, getInventoryPurchases,
  createBankMovement, getBankInvestments,
  getCashMovements,
  getDashboard
};