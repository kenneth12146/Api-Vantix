const express = require('express');
const {
  createOrder,
  getAllOrders,
  updateOrderStatus,
} = require('../controllers/orderController');
const authMiddleware = require('../middleware/authMiddleware');
const router = express.Router();

router.post('/', createOrder);
router.get('/', authMiddleware, getAllOrders);
router.patch('/:id/status', authMiddleware, updateOrderStatus);

module.exports = router;