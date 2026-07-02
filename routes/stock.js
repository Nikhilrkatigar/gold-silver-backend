const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const { Stock, StockInput } = require('../models/Stock');
const Voucher = require('../models/Voucher');
const Karigar = require('../models/Karigar');
const Ledger = require('../models/Ledger');
const Expense = require('../models/Expense');
const { auth, checkLicense } = require('../middleware/auth');
const CONSTANTS = require('../utils/constants');
const { createError, supportsTransactions, startOptionalSession } = require('../utils/helpers');

// Stock-specific toNumber that throws on invalid values (stricter than the shared version)
const toNumber = (value, fieldName) => {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number)) {
    throw createError(CONSTANTS.HTTP_STATUS.BAD_REQUEST, `Invalid ${fieldName} value`, 'INVALID_NUMBER');
  }
  return number;

};

const toFiniteNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const ensureUserStock = async (userId, options = {}) => {
  const { session } = options;
  let stockQuery = Stock.findOne({ userId });
  if (session) {
    stockQuery = stockQuery.session(session);
  }
  let stock = await stockQuery;
  if (!stock) {
    try {
      const created = await Stock.create([{ userId, gold: 0, silver: 0, cashInHand: 0 }], session ? { session } : {});
      stock = created[0];
    } catch (error) {
      if (error?.code !== 11000) {
        throw error;
      }
      let retryQuery = Stock.findOne({ userId });
      if (session) {
        retryQuery = retryQuery.session(session);
      }
      stock = await retryQuery;
    }
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

    // Separate cash flows by voucherType:
    // SALE vouchers: cashReceived from customer → CASH IN
    // PURCHASE vouchers: cashReceived = cash paid TO customer → CASH OUT
    const voucherAgg = await Voucher.aggregate([
      { $match: { userId: stock.userId, status: 'active' } },
      {
        $project: {
          voucherType: 1,
          paymentType: 1,
          cashReceivedNumeric: {
            $convert: {
              input: '$cashReceived',
              to: 'double',
              onError: 0,
              onNull: 0
            }
          }
        }
      },
      {
        $group: {
          _id: null,
          totalSaleCash: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $ne: ['$voucherType', 'purchase'] },
                    { $in: ['$paymentType', ['cash', 'add_cash', 'money_to_gold', 'money_to_silver']] }
                  ]
                },
                '$cashReceivedNumeric',
                0
              ]
            }
          },
          totalPurchasePaid: {
            $sum: {
              $cond: [
                { $eq: ['$voucherType', 'purchase'] },
                '$cashReceivedNumeric',
                0
              ]
            }
          }
        }
      }
    ]);

    const totalSaleCash = voucherAgg[0]?.totalSaleCash || 0;
    const totalPurchasePaid = voucherAgg[0]?.totalPurchasePaid || 0;

    const ledgers = await Ledger.find({
      userId: stock.userId,
      ledgerType: { $ne: 'gst' }
    }).select('balances').lean();

    // Liability to customers from ledgers (informational only; not drawer cash).
    // amountBalance < 0 means shop owes customer.
    const customerLiabilities = ledgers.reduce((sum, ledger) => {
      const rawCash = Number(ledger?.balances?.cashBalance);
      const rawCredit = Number(ledger?.balances?.creditBalance);
      const hasSplitBalances = Number.isFinite(rawCash) || Number.isFinite(rawCredit);
      const amountBalance = hasSplitBalances
        ? (toFiniteNumber(rawCash) + toFiniteNumber(rawCredit))
        : toFiniteNumber(ledger?.balances?.amount);
      return sum + Math.max(0, -amountBalance);
    }, 0);

    // Aggregate StockInput to get stock purchases cash and manual cash added
    const stockInputAgg = await StockInput.aggregate([
      { $match: { userId: stock.userId } },
      {
        $group: {
          _id: null,
          totalStockPurchaseCash: {
            $sum: {
              $cond: [
                { $ne: ['$type', 'cash_addition'] },
                '$cashAmount',
                0
              ]
            }
          },
          totalCashAdded: {
            $sum: {
              $cond: [
                { $eq: ['$type', 'cash_addition'] },
                '$cashAmount',
                0
              ]
            }
          }
        }
      }
    ]);

    const totalStockPurchaseCash = stockInputAgg[0]?.totalStockPurchaseCash || 0;
    const totalCashAdded = stockInputAgg[0]?.totalCashAdded || 0;

    // Aggregate Expense to get cash expenses
    const expenseAgg = await Expense.aggregate([
      { $match: { userId: stock.userId, paymentMethod: 'cash' } },
      {
        $group: {
          _id: null,
          totalExpenseCash: { $sum: '$amount' }
        }
      }
    ]);
    const totalExpenseCash = expenseAgg[0]?.totalExpenseCash || 0;

    // Karigar amount balance: given is ignored, received subtracts from cash-in-hand.
    const karigarAgg = await Karigar.aggregate([
      { $match: { userId: stock.userId, isDeleted: { $ne: true } } },
      {
        $group: {
          _id: null,
          totalCharges: {
            $sum: {
              $cond: [
                { $eq: ['$type', 'received'] },
                { $ifNull: ['$chargeAmount', 0] },
                0
              ]
            }
          }
        }
      }
    ]);
    const totalKarigarCharges = karigarAgg[0]?.totalCharges || 0;

    // Net Cash in Hand (can be negative if shop has overpaid or has unpaid obligations)
    const calculatedCashInHand = totalSaleCash + totalCashAdded - totalPurchasePaid - totalStockPurchaseCash - totalExpenseCash - totalKarigarCharges;

    const stockObj = stock.toObject();
    stockObj.calculatedCashInHand = calculatedCashInHand;
    // Expose breakdown so frontend can show details
    stockObj.cashBreakdown = {
      cashFromSales: totalSaleCash,
      cashAdded: totalCashAdded,
      customerLiabilities,
      paidForPurchases: totalPurchasePaid,
      stockPurchases: totalStockPurchaseCash,
      cashExpenses: totalExpenseCash,
      karigarCharges: totalKarigarCharges,
      // Keep stockAndExpenses for backward compatibility
      stockAndExpenses: totalStockPurchaseCash + totalExpenseCash - totalCashAdded,
      net: calculatedCashInHand
    };

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
  const session = await startOptionalSession();
  try {
    const gold = toNumber(req.body.gold, 'gold');
    const silver = toNumber(req.body.silver, 'silver');
    const cashAmount = toNumber(req.body.cashAmount ?? req.body.amount, 'cash amount');
    const inputDate = req.body.dateTime ? new Date(req.body.dateTime) : new Date();

    if (gold < 0 || silver < 0 || cashAmount < 0) {
      throw createError(CONSTANTS.HTTP_STATUS.BAD_REQUEST, 'Stock/Cash amounts cannot be negative', 'INVALID_STOCK');
    }

    if (Number.isNaN(inputDate.getTime())) {
      throw createError(CONSTANTS.HTTP_STATUS.BAD_REQUEST, 'Invalid date/time', 'INVALID_DATE');
    }

    // Atomically update stock with $inc to prevent race conditions
    let stockUpdateQuery = Stock.findOneAndUpdate(
      { userId: req.userId },
      {
        $inc: { gold, silver, cashInHand: -cashAmount },
        $set: { updatedAt: new Date() }
      },
      { new: true }
    );
    if (session) stockUpdateQuery = stockUpdateQuery.session(session);
    const stock = await stockUpdateQuery;

    await StockInput.create([{
      userId: req.userId,
      gold,
      silver,
      cashAmount,
      date: inputDate
    }], session ? { session } : {});

    if (session?.inTransaction()) {
      await session.commitTransaction();
    }

    res.json({ success: true, stock });
  } catch (error) {
    if (session?.inTransaction()) {
      await session.abortTransaction();
    }
    res.status(error.status || CONSTANTS.HTTP_STATUS.INTERNAL_ERROR).json({
      success: false,
      message: error.message || 'Error adding stock'
    });
  } finally {
    if (session) {
      await session.endSession();
    }
  }
});

// Add cash/money to cash balance for user
router.post('/add-cash', async (req, res) => {
  const session = await startOptionalSession();
  try {
    const amount = toNumber(req.body.amount, 'amount');
    const inputDate = req.body.dateTime ? new Date(req.body.dateTime) : new Date();

    if (amount <= 0) {
      throw createError(CONSTANTS.HTTP_STATUS.BAD_REQUEST, 'Amount must be greater than zero', 'INVALID_AMOUNT');
    }

    if (Number.isNaN(inputDate.getTime())) {
      throw createError(CONSTANTS.HTTP_STATUS.BAD_REQUEST, 'Invalid date/time', 'INVALID_DATE');
    }

    // Atomically increment Stock.cashInHand to prevent race conditions
    let stockUpdateQuery = Stock.findOneAndUpdate(
      { userId: req.userId },
      {
        $inc: { cashInHand: amount },
        $set: { updatedAt: new Date() }
      },
      { new: true }
    );
    if (session) stockUpdateQuery = stockUpdateQuery.session(session);
    const stock = await stockUpdateQuery;

    await StockInput.create([{
      userId: req.userId,
      gold: 0,
      silver: 0,
      cashAmount: amount,
      date: inputDate,
      type: 'cash_addition'
    }], session ? { session } : {});

    if (session?.inTransaction()) {
      await session.commitTransaction();
    }

    res.json({ success: true, stock });
  } catch (error) {
    if (session?.inTransaction()) {
      await session.abortTransaction();
    }
    res.status(error.status || CONSTANTS.HTTP_STATUS.INTERNAL_ERROR).json({
      success: false,
      message: error.message || 'Error adding cash'
    });
  } finally {
    if (session) {
      await session.endSession();
    }
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
  const session = await startOptionalSession();
  try {
    const lastInput = await StockInput.findOne({ userId: req.userId }).sort({ date: -1 }).session(session);
    if (!lastInput) {
      throw createError(CONSTANTS.HTTP_STATUS.NOT_FOUND, 'No stock input to undo.', 'NO_STOCK_INPUT');
    }

    const stock = await ensureUserStock(req.userId, { session });
    const updatedGold = stock.gold - Number(lastInput.gold || 0);
    const updatedSilver = stock.silver - Number(lastInput.silver || 0);
    const cashAmount = Number(lastInput.cashAmount || 0);

    if (updatedGold < CONSTANTS.STOCK.MIN_ALLOWED || updatedSilver < CONSTANTS.STOCK.MIN_ALLOWED) {
      throw createError(CONSTANTS.HTTP_STATUS.BAD_REQUEST, CONSTANTS.ERROR_MESSAGES.INSUFFICIENT_STOCK, 'INSUFFICIENT_STOCK');
    }

    stock.gold = updatedGold;
    stock.silver = updatedSilver;

    // If it was a cash addition, we decrement cashInHand (take the cash out).
    // Otherwise, we add it back (reclaim the cash paid for stock).
    if (lastInput.type === 'cash_addition') {
      stock.cashInHand = (stock.cashInHand || 0) - cashAmount;
    } else {
      stock.cashInHand = (stock.cashInHand || 0) + cashAmount;
    }

    stock.updatedAt = new Date();
    await stock.save({ session });
    await lastInput.deleteOne({ session });

    if (session?.inTransaction()) {
      await session.commitTransaction();
    }

    res.json({ success: true, stock });
  } catch (error) {
    if (session?.inTransaction()) {
      await session.abortTransaction();
    }
    res.status(error.status || CONSTANTS.HTTP_STATUS.INTERNAL_ERROR).json({
      success: false,
      message: error.message || 'Error undoing last stock input'
    });
  } finally {
    if (session) {
      await session.endSession();
    }
  }
});

// Utility functions for automatic stock deduction/addition (used by other routes)
const deductFromStock = async (userId, goldFineWeight = 0, silverFineWeight = 0, options = {}) => {
  const { session } = options;
  const gold = toNumber(goldFineWeight, 'gold fine weight');
  const silver = toNumber(silverFineWeight, 'silver fine weight');

  if (gold < 0 || silver < 0) {
    throw createError(CONSTANTS.HTTP_STATUS.BAD_REQUEST, 'Stock deduction values cannot be negative', 'INVALID_STOCK');
  }

  await ensureUserStock(userId, { session });

  let updateQuery = Stock.findOneAndUpdate(
    {
      userId,
      gold: { $gte: gold },
      silver: { $gte: silver }
    },
    {
      $inc: { gold: -gold, silver: -silver },
      $set: { updatedAt: new Date() }
    },
    { new: true }
  );
  if (session) {
    updateQuery = updateQuery.session(session);
  }
  const stock = await updateQuery;

  if (!stock) {
    throw createError(CONSTANTS.HTTP_STATUS.BAD_REQUEST, CONSTANTS.ERROR_MESSAGES.INSUFFICIENT_STOCK, 'INSUFFICIENT_STOCK');
  }

  return stock;
};

const addBackToStock = async (userId, goldFineWeight = 0, silverFineWeight = 0, options = {}) => {
  const { session } = options;
  const gold = toNumber(goldFineWeight, 'gold fine weight');
  const silver = toNumber(silverFineWeight, 'silver fine weight');

  if (gold < 0 || silver < 0) {
    throw createError(CONSTANTS.HTTP_STATUS.BAD_REQUEST, 'Stock add-back values cannot be negative', 'INVALID_STOCK');
  }

  await ensureUserStock(userId, { session });

  let updateQuery = Stock.findOneAndUpdate(
    { userId },
    {
      $inc: { gold, silver },
      $set: { updatedAt: new Date() }
    },
    { new: true }
  );
  if (session) {
    updateQuery = updateQuery.session(session);
  }
  const stock = await updateQuery;

  return stock;
};

// PUT /api/stock/daily-rates — Set today's gold/silver rates
router.put('/daily-rates', auth, checkLicense, async (req, res, next) => {
  try {
    const { goldRate, silverRate } = req.body;

    const gold = toNumber(goldRate ?? 0, 'gold rate');
    const silver = toNumber(silverRate ?? 0, 'silver rate');

    if (gold < 0 || silver < 0) {
      return next(createError(CONSTANTS.HTTP_STATUS.BAD_REQUEST, 'Rates cannot be negative', 'INVALID_RATE'));
    }

    await ensureUserStock(req.userId);

    const stock = await Stock.findOneAndUpdate(
      { userId: req.userId },
      { $set: { goldRate: gold, silverRate: silver, ratesUpdatedAt: new Date(), updatedAt: new Date() } },
      { new: true }
    );

    res.json({
      success: true,
      message: 'Daily rates updated successfully',
      rates: {
        goldRate: stock.goldRate,
        silverRate: stock.silverRate,
        updatedAt: stock.ratesUpdatedAt
      }
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
module.exports.deductFromStock = deductFromStock;
module.exports.addBackToStock = addBackToStock;
