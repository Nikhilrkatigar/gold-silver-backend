const express = require('express');
const router = express.Router();
const { Stock, StockInput } = require('../models/Stock');
const { auth, isAdmin } = require('../middleware/auth');

// All stock routes require authentication and valid license
const { checkLicense } = require('../middleware/auth');
router.use(auth);
router.use(checkLicense);

// Get current stock for user
router.get('/', async (req, res) => {
  try {
    let stock = await Stock.findOne({ userId: req.userId });
    if (!stock) {
      stock = await Stock.create({ userId: req.userId, gold: 0, silver: 0 });
    }
    res.json({ success: true, stock });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error fetching stock', error });
  }
});

// Add stock for user
router.post('/add', async (req, res) => {
  try {
    const { gold = 0, silver = 0 } = req.body;
    let stock = await Stock.findOne({ userId: req.userId });
    if (!stock) {
      stock = await Stock.create({ userId: req.userId, gold: 0, silver: 0 });
    }
    stock.gold += Number(gold);
    stock.silver += Number(silver);
    stock.updatedAt = new Date();
    await stock.save();
    await StockInput.create({ gold, silver, userId: req.userId });
    res.json({ success: true, stock });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error adding stock', error });
  }
});

// Get stock input history for user
router.get('/history', async (req, res) => {
  try {
    const history = await StockInput.find({ userId: req.userId }).sort({ date: -1 });
    res.json({ success: true, history });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error fetching history', error });
  }
});

// Undo last stock input for user
router.post('/undo', async (req, res) => {
  try {
    // Find the last stock input for this user
    const lastInput = await StockInput.findOne({ userId: req.userId }).sort({ date: -1 });
    if (!lastInput) {
      return res.status(404).json({ success: false, message: 'No stock input to undo.' });
    }
    // Subtract the last input from the stock
    let stock = await Stock.findOne({ userId: req.userId });
    if (!stock) {
      return res.status(404).json({ success: false, message: 'No stock record found.' });
    }
    stock.gold -= Number(lastInput.gold);
    stock.silver -= Number(lastInput.silver);
    stock.updatedAt = new Date();
    await stock.save();
    // Remove the last input
    await lastInput.deleteOne();
    res.json({ success: true, stock });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error undoing last stock input', error });
  }
});

// Utility functions for automatic stock deduction (called from voucher/settlement routes)
const deductFromStock = async (userId, goldFineWeight = 0, silverFineWeight = 0) => {
  try {
    let stock = await Stock.findOne({ userId });
    if (!stock) {
      stock = await Stock.create({ userId, gold: 0, silver: 0 });
    }
    stock.gold -= Number(goldFineWeight);
    stock.silver -= Number(silverFineWeight);
    stock.updatedAt = new Date();
    await stock.save();
    return stock;
  } catch (error) {
    console.error('Error deducting from stock:', error);
    return null;
  }
};

const addBackToStock = async (userId, goldFineWeight = 0, silverFineWeight = 0) => {
  try {
    let stock = await Stock.findOne({ userId });
    if (!stock) {
      stock = await Stock.create({ userId, gold: 0, silver: 0 });
    }
    stock.gold += Number(goldFineWeight);
    stock.silver += Number(silverFineWeight);
    stock.updatedAt = new Date();
    await stock.save();
    return stock;
  } catch (error) {
    console.error('Error adding back to stock:', error);
    return null;
  }
};

module.exports = router;
module.exports.deductFromStock = deductFromStock;
module.exports.addBackToStock = addBackToStock;
