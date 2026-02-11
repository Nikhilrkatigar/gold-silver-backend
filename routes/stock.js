const express = require('express');
const router = express.Router();
const { Stock, StockInput } = require('../models/Stock');
const Voucher = require('../models/Voucher'); // Import Voucher model
const { auth, checkLicense } = require('../middleware/auth');
const CONSTANTS = require('../utils/constants');

const createError = (status, message, code) => {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
};

const toNumber = (value, fieldName) => {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number)) {
    throw createError(CONSTANTS.HTTP_STATUS.BAD_REQUEST, `Invalid ${fieldName} value`, 'INVALID_NUMBER');
  }
  return number;
};

const ensureUserStock = async (userId) => {
  let stock = await Stock.findOne({ userId });
  if (!stock) {
    stock = await Stock.create({ userId, gold: 0, silver: 0, cashInHand: 0 }); // Initialize cashInHand
  }
  return stock;
};

// All stock routes require authentication and valid license
router.use(auth);
router.use(checkLicense);

// Get current stock for user
router.get('/', async (req, res) => {
  try {
    const stock = await ensureUserStock(req.userId);

    // Calculate total cash received from vouchers
    const voucherAgg = await Voucher.aggregate([
      { $match: { userId: stock.userId } },
      { $group: { _id: null, totalCash: { $sum: "$cashReceived" } } }
    ]);
    const totalVoucherCash = voucherAgg[0]?.totalCash || 0;

    // Calculate total stock expenses (tracked in Stock.cashInHand, which should be negative if it tracks expenses?)
    // Actually, let's just make stock.cashInHand track the NET cash impact of stock ops.
    // If we buy stock, cashInHand decreases.

    // Total Cash in Hand = (Cash from Vouchers) + (Stock Cash Balance)
    // Stock Cash Balance (stock.cashInHand) will be negative if we only buy stock.
    const calculatedCashInHand = totalVoucherCash + (stock.cashInHand || 0);

    // Attach calculated cash to the response object (not saving to DB to avoid staleness)
    const stockObj = stock.toObject();
    stockObj.calculatedCashInHand = calculatedCashInHand;
    stockObj.totalVoucherCash = totalVoucherCash;

    res.json({ success: true, stock: stockObj });
  } catch (error) {
    res.status(error.status || CONSTANTS.HTTP_STATUS.INTERNAL_ERROR).json({
      success: false,
      message: error.message || 'Error fetching stock'
    });
  }
});

// Add stock for user
router.post('/add', async (req, res) => {
  try {
    const gold = toNumber(req.body.gold, 'gold');
    const silver = toNumber(req.body.silver, 'silver');
    const cashAmount = toNumber(req.body.cashAmount, 'cash amount'); // Get cash amount

    if (gold < 0 || silver < 0 || cashAmount < 0) {
      throw createError(CONSTANTS.HTTP_STATUS.BAD_REQUEST, 'Stock/Cash amounts cannot be negative', 'INVALID_STOCK');
    }

    const stock = await ensureUserStock(req.userId);
    stock.gold += gold;
    stock.silver += silver;

    // Decrease cashInHand by the amount spent on stock
    stock.cashInHand = (stock.cashInHand || 0) - cashAmount;

    stock.updatedAt = new Date();
    await stock.save();

    await StockInput.create({
      userId: req.userId,
      gold,
      silver,
      cashAmount // Save cash amount in history
    });

    res.json({ success: true, stock });
  } catch (error) {
    res.status(error.status || CONSTANTS.HTTP_STATUS.INTERNAL_ERROR).json({
      success: false,
      message: error.message || 'Error adding stock'
    });
  }
});

// Get stock input history for user
router.get('/history', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || CONSTANTS.PAGINATION.DEFAULT_PAGE);
    const limit = Math.min(
      parseInt(req.query.limit, 10) || CONSTANTS.PAGINATION.DEFAULT_LIMIT,
      CONSTANTS.PAGINATION.MAX_LIMIT
    );
    const skip = (page - 1) * limit;

    const history = await StockInput.find({ userId: req.userId })
      .sort({ date: -1 })
      .skip(skip)
      .limit(limit);

    const total = await StockInput.countDocuments({ userId: req.userId });

    res.json({
      success: true,
      history,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    res.status(error.status || CONSTANTS.HTTP_STATUS.INTERNAL_ERROR).json({
      success: false,
      message: error.message || 'Error fetching history'
    });
  }
});

// Undo last stock input for user
router.post('/undo', async (req, res) => {
  try {
    const lastInput = await StockInput.findOne({ userId: req.userId }).sort({ date: -1 });
    if (!lastInput) {
      throw createError(CONSTANTS.HTTP_STATUS.NOT_FOUND, 'No stock input to undo.', 'NO_STOCK_INPUT');
    }

    const stock = await ensureUserStock(req.userId);
    const updatedGold = stock.gold - Number(lastInput.gold || 0);
    const updatedSilver = stock.silver - Number(lastInput.silver || 0);
    const cashAmount = Number(lastInput.cashAmount || 0);

    if (updatedGold < CONSTANTS.STOCK.MIN_ALLOWED || updatedSilver < CONSTANTS.STOCK.MIN_ALLOWED) {
      throw createError(CONSTANTS.HTTP_STATUS.BAD_REQUEST, CONSTANTS.ERROR_MESSAGES.INSUFFICIENT_STOCK, 'INSUFFICIENT_STOCK');
    }

    stock.gold = updatedGold;
    stock.silver = updatedSilver;

    // Add back the cash amount to cashInHand
    stock.cashInHand = (stock.cashInHand || 0) + cashAmount;

    stock.updatedAt = new Date();
    await stock.save();
    await lastInput.deleteOne();

    res.json({ success: true, stock });
  } catch (error) {
    res.status(error.status || CONSTANTS.HTTP_STATUS.INTERNAL_ERROR).json({
      success: false,
      message: error.message || 'Error undoing last stock input'
    });
  }
});

// Utility functions for automatic stock deduction/addition (used by other routes)
const deductFromStock = async (userId, goldFineWeight = 0, silverFineWeight = 0) => {
  const gold = toNumber(goldFineWeight, 'gold fine weight');
  const silver = toNumber(silverFineWeight, 'silver fine weight');

  if (gold < 0 || silver < 0) {
    throw createError(CONSTANTS.HTTP_STATUS.BAD_REQUEST, 'Stock deduction values cannot be negative', 'INVALID_STOCK');
  }

  const stock = await ensureUserStock(userId);

  if (
    stock.gold - gold < CONSTANTS.STOCK.MIN_ALLOWED ||
    stock.silver - silver < CONSTANTS.STOCK.MIN_ALLOWED
  ) {
    throw createError(CONSTANTS.HTTP_STATUS.BAD_REQUEST, CONSTANTS.ERROR_MESSAGES.INSUFFICIENT_STOCK, 'INSUFFICIENT_STOCK');
  }

  stock.gold -= gold;
  stock.silver -= silver;
  stock.updatedAt = new Date();
  await stock.save();

  return stock;
};

const addBackToStock = async (userId, goldFineWeight = 0, silverFineWeight = 0) => {
  const gold = toNumber(goldFineWeight, 'gold fine weight');
  const silver = toNumber(silverFineWeight, 'silver fine weight');

  if (gold < 0 || silver < 0) {
    throw createError(CONSTANTS.HTTP_STATUS.BAD_REQUEST, 'Stock add-back values cannot be negative', 'INVALID_STOCK');
  }

  const stock = await ensureUserStock(userId);
  stock.gold += gold;
  stock.silver += silver;
  stock.updatedAt = new Date();
  await stock.save();

  return stock;
};

module.exports = router;
module.exports.deductFromStock = deductFromStock;
module.exports.addBackToStock = addBackToStock;
