const express = require('express');
const {
  getPublicSettings,
  getAllSettings,
  updateSettings,
} = require('../controllers/settingsController');
const authMiddleware = require('../middleware/authMiddleware');
const router = express.Router();

router.get('/public', getPublicSettings);
router.get('/', authMiddleware, getAllSettings);
router.put('/', authMiddleware, updateSettings);

module.exports = router;