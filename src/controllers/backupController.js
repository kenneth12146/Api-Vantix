const db = require('../config/db');
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});

// Lista de tablas exportables/importables con descripción y columnas
const EXPORT_TABLES = {
  products:           { label: 'Inventario (Productos)', cols: ['id','name','description','price','stock','category_id','is_active','is_featured','purchase_cost','supplier_link','is_stocked','power_rms','impedance','sensitivity','investment_cost','created_at'] },
  categories:         { label: 'Categorías', cols: ['id','name','slug','image_url','is_active','order_index','created_at'] },
  clients:            { label: 'Clientes', cols: ['id','name','phone','address','cedula','created_at'] },
  sales:              { label: 'Ventas', cols: ['id','client_id','product_id','total_amount','sale_type','status','quantity','created_at'] },
  expenses:           { label: 'Gastos', cols: ['id','description','amount','category','created_at'] },
  cash_movements:     { label: 'Movimientos de Caja', cols: ['id','type','direction','amount','reference_table','reference_id','description','created_at'] },
  loans:              { label: 'Préstamos', cols: ['id','debtor_name','party_name','total_amount','description','status','direction','cedula','interest_rate','interest_type','term_months','interest_amount','interest_paid','created_at'] },
  payments:           { label: 'Pagos (abonos)', cols: ['id','sale_id','amount','payment_method','created_at'] },
  loan_payments:      { label: 'Pagos de Préstamos', cols: ['id','loan_id','amount','created_at'] },
  inventory_purchases:{ label: 'Compras de Inventario', cols: ['id','product_id','quantity','unit_cost','total_cost','description','created_at'] },
  bank_investments:   { label: 'Inversiones Bancarias', cols: ['id','type','amount','description','created_at'] },
};

// Escapa un valor para CSV (RFC 4180)
const csvEscape = (v) => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n\r\t]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
};

// Convertir valor CSV a tipo correcto según columna
const coerce = (col, raw, table) => {
  if (raw === '') return null;
  const conf = EXPORT_TABLES[table];
  const schema = require('../config/db'); // placeholder, ver coerceMap abajo
  // Mapeo sencillo por prefijo de columna
  if (col === 'id' || col.endsWith('_id') || col === 'quantity' || col === 'stock' ||
      col === 'order_index' || col === 'power_rms' || col === 'sale_id' || col === 'loan_id' ||
      col === 'product_id' || col === 'client_id' || col === 'reference_id') {
    return parseInt(raw, 10);
  }
  if (col === 'price' || col === 'total_amount' || col === 'amount' || col === 'unit_cost' ||
      col === 'total_cost' || col === 'purchase_cost' || col === 'investment_cost' ||
      col === 'sensitivity' || col === 'impedance' || col === 'discount_amount' || col === 'subtotal') {
    return parseFloat(raw);
  }
  if (col === 'is_active' || col === 'is_featured' || col === 'is_stocked') {
    const t = String(raw).toLowerCase();
    return t === 'true' || t === '1' || t === 't' || t === 'sí' || t === 'si' || t === 'yes';
  }
  // fechas: timestamps que vienen como string se pasan tal cual (PostgreSQL los parsea)
  return raw;
};

// Listar tablas disponibles
const listExportable = (req, res) => {
  const list = Object.entries(EXPORT_TABLES).map(([key, v]) => ({
    table: key,
    label: v.label,
    cols: v.cols
  }));
  res.json(list);
};

// Descargar una tabla en CSV
const exportTable = async (req, res) => {
  const { table } = req.params;
  const conf = EXPORT_TABLES[table];
  if (!conf) {
    return res.status(400).json({ error: 'Tabla no válida' });
  }
  try {
    const result = await db.query(`SELECT ${conf.cols.join(', ')} FROM ${table} ORDER BY 1`);
    const rows = result.rows;
    let csv = conf.cols.join(',') + '\n';
    for (const row of rows) {
      csv += conf.cols.map(c => csvEscape(row[c])).join(',') + '\n';
    }
    const bom = '\uFEFF';
    const filename = `${table}_vantix_${new Date().toISOString().slice(0,10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(bom + csv);
  } catch (error) {
    console.error('Error exportando tabla:', error);
    res.status(500).json({ error: 'Error al exportar' });
  }
};

// ---------- IMPORT (restaurar) ----------
// Recibe: { table, rows: [ {col: val, ...}, ... ] }
// Hace UPSERT por id (ON CONFLICT DO UPDATE) dentro de una transacción.
const importTable = async (req, res) => {
  const { table, rows } = req.body || {};
  const conf = EXPORT_TABLES[table];
  if (!conf) {
    return res.status(400).json({ error: `Tabla no válida. Válidas: ${Object.keys(EXPORT_TABLES).join(', ')}` });
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: 'Debe enviar un arreglo "rows" con los datos' });
  }
  if (rows.length > 5000) {
    return res.status(400).json({ error: 'Demasiadas filas (máx 5000)' });
  }

  const insertCols = conf.cols.filter(c => c !== 'id');      // columnas a insertar
  const colSet = insertCols.join(', ');
  const colPlaceholders = insertCols.map((c, i) => `$${i + 1}`).join(', ');
  // EXCLUDED para UPDATE
  const updateSet = insertCols.map(c => `${c} = EXCLUDED.${c}`).join(', ');
  const sql = `INSERT INTO ${table} (id, ${colSet}) VALUES ($1, ${colPlaceholders})
               ON CONFLICT (id) DO UPDATE SET ${updateSet}`;

  const clientConn = await pool.connect();
  try {
    await clientConn.query('BEGIN');
    let inserted = 0, updated = 0;
    for (const row of rows) {
      // solo usar id si es número válido
      let id = row.id;
      if (id === undefined || id === null || id === '') {
        id = null;
      } else {
        id = parseInt(id, 10);
        if (isNaN(id)) { id = null; }
      }
      const values = insertCols.map(c => {
        const raw = row[c];
        if (raw === undefined || raw === null) return null;
        return coerce(c, raw, table);
      });
      try {
        const r = await clientConn.query(sql, [id, ...values]);
        if (r.rowCount === 0 || (r.rowCount === 1 && id === null)) {
          inserted++;
        } else {
          // distinguir insert vs update: usamos xmax trick aproximado
          updated++;
        }
      } catch (e) {
        console.error('Fila con error insertando en ' + table + ':', e.message);
        // Continúa con las siguientes, pero no rompemos todo
      }
    }
    await clientConn.query('COMMIT');
    res.json({ ok: true, table, procesadas: rows.length, mensaje: `Datos de ${conf.label} restaurados (${rows.length} filas procesadas)` });
  } catch (error) {
    await clientConn.query('ROLLBACK');
    console.error('Error en import:', error);
    res.status(500).json({ error: 'Error al importar: ' + error.message });
  } finally {
    clientConn.release();
  }
};

// Importar desde un CSV (texto) — útil para subida directa de archivo
const importCsv = async (req, res) => {
  const { table, csv } = req.body || {};
  const conf = EXPORT_TABLES[table];
  if (!conf || typeof csv !== 'string' || csv.length === 0) {
    return res.status(400).json({ error: 'Debe enviar "table" y "csv" (texto)' });
  }
  // parsear CSV simple (sin comillas anidadas complejas)
  const lines = csv.split(/\r?\n/).filter(l => l.trim() !== '');
  if (lines.length < 2) return res.status(400).json({ error: 'CSV vacío o sin datos' });
  const header = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = [];
    let cur = '', inQ = false;
    for (const ch of lines[i]) {
      if (ch === '"') { inQ = !inQ; continue; }
      if (ch === ',' && !inQ) { vals.push(cur); cur = ''; continue; }
      cur += ch;
    }
    vals.push(cur);
    const obj = {};
    header.forEach((h, idx) => { obj[h] = (vals[idx] || '').trim(); });
    rows.push(obj);
  }
  // reenviar al importador
  req.body = { table, rows };
  return importTable(req, res);
};

module.exports = { exportTable, listExportable, importTable, importCsv, EXPORT_TABLES, csvEscape };
