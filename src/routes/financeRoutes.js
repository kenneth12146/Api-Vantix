const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const {
  getClients, getClientById, createClient, updateClient, deleteClient,
  getSales, createSale, updateSale, deleteSale, getDebtors,
  registerPayment,
  getLoans, createLoan, updateLoan, deleteLoan, registerLoanPayment,
  getExpenses, createExpense, updateExpense, deleteExpense,
  createInventoryPurchase, getInventoryPurchases,
  createBankMovement, getBankInvestments,
  getCashMovements,
  getDashboard
} = require('../controllers/financeController');

// Todas las rutas requieren autenticación
router.use(authMiddleware);

// Clientes
router.get('/clients', getClients);
router.get('/clients/:id', getClientById);
router.post('/clients', createClient);
router.put('/clients/:id', updateClient);               // NUEVA
router.delete('/clients/:id', deleteClient);           // NUEVA

// Ventas
router.get('/sales', getSales);
router.post('/sales', createSale);
router.put('/sales/:id', updateSale);
router.delete('/sales/:id', deleteSale);
router.get('/debtors', getDebtors);

// Pagos (abonos a ventas a crédito)
router.post('/payments', registerPayment);

// Préstamos
router.get('/loans', getLoans);
router.post('/loans', createLoan);
router.put('/loans/:id', updateLoan);           // NUEVA
router.delete('/loans/:id', deleteLoan);         // NUEVA
router.post('/loans/:id/payments', registerLoanPayment);

// Gastos operativos
router.get('/expenses', getExpenses);
router.post('/expenses', createExpense);
router.put('/expenses/:id', updateExpense);      // NUEVA (ya la usaba Expenses.jsx, faltaba en el router)
router.delete('/expenses/:id', deleteExpense);   // NUEVA (ya la usaba Expenses.jsx, faltaba en el router)

// Compras de inventario                          // NUEVA sección
router.get('/inventory-purchases', getInventoryPurchases);
router.post('/inventory-purchases', createInventoryPurchase);

// Inversión bancaria                              // NUEVA sección
router.get('/bank-investments', getBankInvestments);
router.post('/bank-movements', createBankMovement);

// Libro mayor / Caja                               // NUEVA sección
router.get('/cash-movements', getCashMovements);

// Dashboard
router.get('/dashboard', getDashboard);

module.exports = router;