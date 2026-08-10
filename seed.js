const bcrypt = require('bcryptjs');
const db = require('./src/config/db');

const seedAdmin = async () => {
  try {
    const { rows } = await db.query('SELECT * FROM users WHERE email = $1', ['admin@marlonaudio.com']);
    if (rows.length === 0) {
      const hash = await bcrypt.hash('admin123', 10);
      await db.query(
        'INSERT INTO users (email, password_hash, name, role) VALUES ($1, $2, $3, $4)',
        ['admin@marlonaudio.com', hash, 'Administrador', 'admin']
      );
      console.log('✅ Usuario admin creado: admin@marlonaudio.com / admin123');
    } else {
      console.log('ℹ️ El usuario admin ya existe');
    }
    process.exit();
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
};

seedAdmin();