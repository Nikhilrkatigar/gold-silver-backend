const express = require('express');
const router = express.Router();
const { Stock, StockInput } = require('../models/Stock');
const { auth, isAdmin } = require('../middleware/auth');

// All stock routes require authentication and valid license
const { checkLicense } = require('../middleware/auth');
router.use(auth);
router.use(checkLicense);

// Get current stock
router.get('/', async (req, res) => {
  try {
    let stock = await Stock.findOne();
    if (!stock) {
      stock = await Stock.create({ gold: 0, silver: 0 });
    }
    res.json({ success: true, stock });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error fetching stock', error });
  }
});

// Add stock
router.post('/add', async (req, res) => {
  try {
    const { gold = 0, silver = 0 } = req.body;
    let stock = await Stock.findOne();
    if (!stock) {
      stock = await Stock.create({ gold: 0, silver: 0 });
    }
    stock.gold += Number(gold);
    stock.silver += Number(silver);
    stock.updatedAt = new Date();
    await stock.save();
    await StockInput.create({ gold, silver, user: req.userId });
    res.json({ success: true, stock });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error adding stock', error });
  }
});


// Get stock input history
router.get('/history', async (req, res) => {
  try {
    const history = await StockInput.find().populate('user', 'shopName').sort({ date: -1 });
    res.json({ success: true, history });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error fetching history', error });
  }
});

// Undo last stock input
router.post('/undo', async (req, res) => {
  try {
    // Find the last stock input for this user
    const lastInput = await StockInput.findOne({ user: req.userId }).sort({ date: -1 });
    if (!lastInput) {
      return res.status(404).json({ success: false, message: 'No stock input to undo.' });
    }
    // Subtract the last input from the stock
    let stock = await Stock.findOne();
    if (!stock) {
      return res.status(404).json({ success: false, message: 'No stock record found.' });
    }
    stock.gold -= Number(lastInput.gold);
    stock.silver -= Number(lastInput.silver);
    if (stock.gold < 0) stock.gold = 0;
    if (stock.silver < 0) stock.silver = 0;
    stock.updatedAt = new Date();
    await stock.save();
    // Remove the last input
    await lastInput.deleteOne();
    res.json({ success: true, stock });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error undoing last stock input', error });
  }
});

module.exports = router;
