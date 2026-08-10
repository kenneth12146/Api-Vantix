const express = require('express');
const {
  getActiveProducts,
  getAllProducts,
  getProductById,
  createProduct,
  updateProduct,
  deleteProduct,
  addProductImage,
  deleteProductImage,
} = require('../controllers/productController');
const authMiddleware = require('../middleware/authMiddleware');
const router = express.Router();

router.get('/active', getActiveProducts);
router.get('/:id', getProductById);
router.get('/', authMiddleware, getAllProducts);
router.post('/', authMiddleware, createProduct);
router.put('/:id', authMiddleware, updateProduct);
router.delete('/:id', authMiddleware, deleteProduct);
router.post('/:productId/images', authMiddleware, addProductImage);  // ← Cambiada
router.delete('/images/:id', authMiddleware, deleteProductImage);

module.exports = router;
