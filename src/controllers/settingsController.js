const db = require('../config/db');

// Obtener configuración pública
const getPublicSettings = async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT store_name, whatsapp_number, instagram_url, facebook_url, tiktok_url, logo_url, welcome_message
      FROM store_settings LIMIT 1
    `);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Configuración no encontrada' });
    }
    res.json(rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener configuración' });
  }
};

// Obtener configuración completa (admin)
const getAllSettings = async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM store_settings LIMIT 1');
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Configuración no encontrada' });
    }
    res.json(rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener configuración' });
  }
};

// Actualizar configuración (admin)
const updateSettings = async (req, res) => {
  const {
    store_name, whatsapp_number, instagram_url, facebook_url, tiktok_url,
    logo_url, primary_color, welcome_message
  } = req.body;
  try {
    const { rows } = await db.query(`
      UPDATE store_settings SET
        store_name = $1,
        whatsapp_number = $2,
        instagram_url = $3,
        facebook_url = $4,
        tiktok_url = $5,
        logo_url = $6,
        primary_color = $7,
        welcome_message = $8,
        updated_at = NOW()
      WHERE id = (SELECT id FROM store_settings LIMIT 1)
      RETURNING *
    `, [store_name, whatsapp_number, instagram_url, facebook_url, tiktok_url, logo_url, primary_color, welcome_message]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Configuración no encontrada' });
    }
    res.json(rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al actualizar configuración' });
  }
};

module.exports = {
  getPublicSettings,
  getAllSettings,
  updateSettings,
};