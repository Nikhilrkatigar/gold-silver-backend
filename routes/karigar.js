const express = require('express');
const router = express.Router();
const Karigar = require('../models/Karigar');
const { auth, checkLicense } = require('../middleware/auth');
const { deductFromStock, addBackToStock } = require('./stock');

router.use(auth);
router.use(checkLicense);

// Create karigar transaction
router.post('/', async (req, res) => {
  try {
    const {
      date,
      type,
      itemName,
      metalType,
      fineWeight,
      chargeAmount,
      narration
    } = req.body;

    if (!type || !itemName || !metalType || fineWeight === undefined) {
      return res.status(400).json({
        success: false,
        message: 'All required fields must be provided'
      });
    }

    if (!['given', 'received'].includes(type)) {
      return res.status(400).json({
        success: false,
        message: 'Type must be either "given" or "received"'
      });
    }

    const transaction = new Karigar({
      userId: req.userId,
      date: date || new Date(),
      type,
      itemName,
      metalType,
      fineWeight: parseFloat(fineWeight),
      chargeAmount: parseFloat(chargeAmount) || 0,
      narration: narration || ''
    });

    await transaction.save();

    // Update stock based on transaction type
    if (type === 'given') {
      // Given means minus from stock
      if (metalType === 'gold') {
        await deductFromStock(req.userId, fineWeight, 0);
      } else {
        await deductFromStock(req.userId, 0, fineWeight);
      }
    } else {
      // Received means add to stock
      if (metalType === 'gold') {
        await addBackToStock(req.userId, fineWeight, 0);
      } else {
        await addBackToStock(req.userId, 0, fineWeight);
      }
    }

    res.status(201).json({
      success: true,
      message: 'Transaction created successfully',
      transaction
    });
  } catch (error) {
    console.error('Error creating karigar transaction:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create transaction',
      error: error.message
    });
  }
});

// Get all karigar transactions (excluding deleted)
router.get('/', async (req, res) => {
  try {
    const transactions = await Karigar.find({
      userId: req.userId,
      isDeleted: false
    }).sort({ date: -1 });

    res.json({
      success: true,
      transactions
    });
  } catch (error) {
    console.error('Error fetching karigar transactions:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch transactions',
      error: error.message
    });
  }
});

// Get single karigar transaction
router.get('/:id', async (req, res) => {
  try {
    const transaction = await Karigar.findOne({
      _id: req.params.id,
      userId: req.userId
    });

    if (!transaction) {
      return res.status(404).json({
        success: false,
        message: 'Transaction not found'
      });
    }

    res.json({
      success: true,
      transaction
    });
  } catch (error) {
    console.error('Error fetching karigar transaction:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch transaction',
      error: error.message
    });
  }
});

// Delete karigar transaction (reverse stock changes)
router.delete('/:id', async (req, res) => {
  try {
    const transaction = await Karigar.findOne({
      _id: req.params.id,
      userId: req.userId
    });

    if (!transaction) {
      return res.status(404).json({
        success: false,
        message: 'Transaction not found'
      });
    }

    // Reverse the stock changes
    if (transaction.type === 'given') {
      // If transaction was "given" (stock was deducted), add it back
      if (transaction.metalType === 'gold') {
        await addBackToStock(req.userId, transaction.fineWeight, 0);
      } else {
        await addBackToStock(req.userId, 0, transaction.fineWeight);
      }
    } else {
      // If transaction was "received" (stock was added), deduct it
      if (transaction.metalType === 'gold') {
        await deductFromStock(req.userId, transaction.fineWeight, 0);
      } else {
        await deductFromStock(req.userId, 0, transaction.fineWeight);
      }
    }

    // Mark as deleted
    transaction.isDeleted = true;
    await transaction.save();

    res.json({
      success: true,
      message: 'Transaction deleted successfully and stock reversed'
    });
  } catch (error) {
    console.error('Error deleting karigar transaction:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete transaction',
      error: error.message
    });
  }
});

module.exports = router;