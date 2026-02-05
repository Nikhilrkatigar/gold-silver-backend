const express = require('express');
const router = express.Router();
const Settlement = require('../models/Settlement');
const Ledger = require('../models/Ledger');
const { auth, checkLicense } = require('../middleware/auth');
const { deductFromStock, addBackToStock } = require('./stock');

router.use(auth);
router.use(checkLicense);

// Create settlement
router.post('/', async (req, res) => {
  try {
    const {
      ledgerId,
      metalType,
      metalRate,
      fineGiven,
      narration,
      date
    } = req.body;

    if (!ledgerId || !metalType || !metalRate || !fineGiven) {
      return res.status(400).json({
        success: false,
        message: 'All fields are required'
      });
    }

    // Get ledger
    const ledger = await Ledger.findOne({
      _id: ledgerId,
      userId: req.userId
    });

    if (!ledger) {
      return res.status(404).json({
        success: false,
        message: 'Ledger not found'
      });
    }

    // Get balance based on metal type
    const balanceBefore = metalType === 'gold' 
      ? ledger.balances.goldFineWeight 
      : ledger.balances.silverFineWeight;

    // Check balance only for positive settlements
    if (fineGiven > 0 && balanceBefore < fineGiven) {
      return res.status(400).json({
        success: false,
        message: 'Insufficient balance for settlement'
      });
    }

    // For negative settlements, allow any value (represents reversal/adjustment)
    // No additional validation needed

    // Calculate amount
    const amount = fineGiven * metalRate;

    // Create settlement
    const settlement = new Settlement({
      userId: req.userId,
      ledgerId,
      customerName: ledger.name,
      date: date || new Date(),
      metalType,
      balanceBefore,
      metalRate,
      fineGiven,
      amount,
      balanceAfter: {
        amount: ledger.balances.amount - amount,
        fineWeight: balanceBefore - fineGiven
      },
      narration: narration || ''
    });

    await settlement.save();

    // Update ledger balances
    ledger.balances.amount -= amount;
    
    if (metalType === 'gold') {
      ledger.balances.goldFineWeight -= fineGiven;
    } else {
      ledger.balances.silverFineWeight -= fineGiven;
    }

    await ledger.save();

    // Deduct fine given from stock
    if (metalType === 'gold') {
      await deductFromStock(req.userId, fineGiven, 0);
    } else {
      await deductFromStock(req.userId, 0, fineGiven);
    }

    res.status(201).json({
      success: true,
      message: 'Settlement created successfully',
      settlement
    });
  } catch (error) {
    console.error('Create settlement error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error creating settlement'
    });
  }
});

// Get all settlements
router.get('/', async (req, res) => {
  try {
    const { startDate, endDate, ledgerId } = req.query;
    const query = { userId: req.userId };

    if (ledgerId) {
      query.ledgerId = ledgerId;
    }

    if (startDate || endDate) {
      query.date = {};
      if (startDate) query.date.$gte = new Date(startDate);
      if (endDate) query.date.$lte = new Date(endDate);
    }

    const settlements = await Settlement.find(query)
      .populate('ledgerId', 'name phoneNumber')
      .sort({ date: -1 });

    res.json({
      success: true,
      settlements
    });
  } catch (error) {
    console.error('Get settlements error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error fetching settlements'
    });
  }
});

// Get single settlement
router.get('/:id', async (req, res) => {
  try {
    const settlement = await Settlement.findOne({
      _id: req.params.id,
      userId: req.userId
    }).populate('ledgerId', 'name phoneNumber');

    if (!settlement) {
      return res.status(404).json({
        success: false,
        message: 'Settlement not found'
      });
    }

    res.json({
      success: true,
      settlement
    });
  } catch (error) {
    console.error('Get settlement error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error fetching settlement'
    });
  }
});

// Delete settlement
router.delete('/:id', async (req, res) => {
  try {
    const settlement = await Settlement.findOne({
      _id: req.params.id,
      userId: req.userId
    });

    if (!settlement) {
      return res.status(404).json({
        success: false,
        message: 'Settlement not found'
      });
    }

    const ledger = await Ledger.findById(settlement.ledgerId);

    if (ledger) {
      // Reverse balance updates
      ledger.balances.amount += settlement.amount;
      
      if (settlement.metalType === 'gold') {
        ledger.balances.goldFineWeight += settlement.fineGiven;
      } else {
        ledger.balances.silverFineWeight += settlement.fineGiven;
      }

      await ledger.save();
    }

    // Add fine given back to stock
    if (settlement.metalType === 'gold') {
      await addBackToStock(req.userId, settlement.fineGiven, 0);
    } else {
      await addBackToStock(req.userId, 0, settlement.fineGiven);
    }

    await Settlement.findByIdAndDelete(req.params.id);

    res.json({
      success: true,
      message: 'Settlement deleted successfully'
    });
  } catch (error) {
    console.error('Delete settlement error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error deleting settlement'
    });
  }
});

module.exports = router;
