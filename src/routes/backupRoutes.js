const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const { exportTable, listExportable, importTable, importCsv } = require('../controllers/backupController');

// Todas las rutas requieren autenticación
router.post('/import', authMiddleware, importTable);
router.post('/import-csv', authMiddleware, importCsv);
router.get('/tables', authMiddleware, listExportable);
router.get('/export/:table', authMiddleware, exportTable);

module.exports = router;
