const express = require('express');
const authRoutes = require('./authRoutes');
const categoryRoutes = require('./categoryRoutes');
const productRoutes = require('./productRoutes');
const orderRoutes = require('./orderRoutes');
const settingsRoutes = require('./settingsRoutes');
const financeRoutes = require('./financeRoutes'); // <-- NUEVO
const backupRoutes = require('./backupRoutes'); // <-- NUEVO: respaldos

const router = express.Router();

router.use('/auth', authRoutes);
router.use('/categories', categoryRoutes);
router.use('/products', productRoutes);
router.use('/orders', orderRoutes);
router.use('/settings', settingsRoutes);
router.use('/finance', financeRoutes); // <-- NUEVO
router.use('/backup', backupRoutes); // <-- NUEVO: respaldos

module.exports = router;