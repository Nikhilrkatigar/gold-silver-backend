const express = require('express');
const router = express.Router();
const Ledger = require('../models/Ledger');
const Voucher = require('../models/Voucher');
const Settlement = require('../models/Settlement');
const { auth, checkLicense } = require('../middleware/auth');

router.use(auth);
router.use(checkLicense);

// Create ledger
router.post('/', async (req, res) => {
  try {
    const { name, phoneNumber } = req.body;

    if (!name || !phoneNumber) {
      return res.status(400).json({
        success: false,
        message: 'Name and phone number are required'
      });
    }

    const ledger = new Ledger({
      name,
      phoneNumber,
      userId: req.userId
    });

    await ledger.save();

    res.status(201).json({
      success: true,
      message: 'Ledger created successfully',
      ledger
    });
  } catch (error) {
    console.error('Create ledger error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error creating ledger'
    });
  }
});

// Get all ledgers for user
router.get('/', async (req, res) => {
  try {
    const ledgers = await Ledger.find({ userId: req.userId })
      .sort({ name: 1 });

    res.json({
      success: true,
      ledgers
    });
  } catch (error) {
    console.error('Get ledgers error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error fetching ledgers'
    });
  }
});

// Get single ledger
router.get('/:id', async (req, res) => {
  try {
    const ledger = await Ledger.findOne({
      _id: req.params.id,
      userId: req.userId
    });

    if (!ledger) {
      return res.status(404).json({
        success: false,
        message: 'Ledger not found'
      });
    }

    res.json({
      success: true,
      ledger
    });
  } catch (error) {
    console.error('Get ledger error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error fetching ledger'
    });
  }
});

// Get ledger with transactions
router.get('/:id/transactions', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    const ledger = await Ledger.findOne({
      _id: req.params.id,
      userId: req.userId
    });

    if (!ledger) {
      return res.status(404).json({
        success: false,
        message: 'Ledger not found'
      });
    }

    const query = {
      userId: req.userId,
      ledgerId: req.params.id
    };

    if (startDate || endDate) {
      query.date = {};
      if (startDate) query.date.$gte = new Date(startDate);
      if (endDate) query.date.$lte = new Date(endDate);
    }

    const vouchers = await Voucher.find(query).sort({ date: -1 });
    const settlements = await Settlement.find(query).sort({ date: -1 });

    // Combine and sort by date
    const transactions = [
      ...vouchers.map(v => ({ ...v.toObject(), type: 'voucher' })),
      ...settlements.map(s => ({ ...s.toObject(), type: 'settlement' }))
    ].sort((a, b) => new Date(b.date) - new Date(a.date));

    res.json({
      success: true,
      ledger,
      transactions
    });
  } catch (error) {
    console.error('Get transactions error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error fetching transactions'
    });
  }
});

// Update ledger
router.patch('/:id', async (req, res) => {
  try {
    const { name, phoneNumber } = req.body;
    const updates = {};

    if (name) updates.name = name;
    if (phoneNumber) updates.phoneNumber = phoneNumber;

    const ledger = await Ledger.findOneAndUpdate(
      { _id: req.params.id, userId: req.userId },
      updates,
      { new: true, runValidators: true }
    );

    if (!ledger) {
      return res.status(404).json({
        success: false,
        message: 'Ledger not found'
      });
    }

    res.json({
      success: true,
      message: 'Ledger updated successfully',
      ledger
    });
  } catch (error) {
    console.error('Update ledger error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error updating ledger'
    });
  }
});

// Delete ledger
router.delete('/:id', async (req, res) => {
  try {
    const ledger = await Ledger.findOne({
      _id: req.params.id,
      userId: req.userId
    });

    if (!ledger) {
      return res.status(404).json({
        success: false,
        message: 'Ledger not found'
      });
    }

    if (ledger.hasVouchers) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete ledger with existing vouchers. Please delete vouchers first.'
      });
    }

    await Ledger.findByIdAndDelete(req.params.id);

    res.json({
      success: true,
      message: 'Ledger deleted successfully'
    });
  } catch (error) {
    console.error('Delete ledger error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error deleting ledger'
    });
  }
});

// Delete all vouchers for a ledger
router.delete('/:id/vouchers', async (req, res) => {
  try {
    const ledger = await Ledger.findOne({
      _id: req.params.id,
      userId: req.userId
    });

    if (!ledger) {
      return res.status(404).json({
        success: false,
        message: 'Ledger not found'
      });
    }

    await Voucher.deleteMany({
      userId: req.userId,
      ledgerId: req.params.id
    });

    await Settlement.deleteMany({
      userId: req.userId,
      ledgerId: req.params.id
    });

    // Reset balances
    ledger.balances = {
      goldFineWeight: 0,
      silverFineWeight: 0,
      amount: 0
    };
    ledger.hasVouchers = false;
    await ledger.save();

    res.json({
      success: true,
      message: 'All vouchers deleted successfully'
    });
  } catch (error) {
    console.error('Delete vouchers error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error deleting vouchers'
    });
  }
});

// Recalculate ledger balances from all transactions
router.post('/:id/recalculate-balance', async (req, res) => {
  try {
    const ledger = await Ledger.findOne({
      _id: req.params.id,
      userId: req.userId
    });

    if (!ledger) {
      return res.status(404).json({
        success: false,
        message: 'Ledger not found'
      });
    }

    // Reset balances
    ledger.balances = {
      goldFineWeight: 0,
      silverFineWeight: 0,
      amount: 0
    };

    // Fetch all vouchers for this ledger
    const vouchers = await Voucher.find({
      ledgerId: req.params.id,
      userId: req.userId
    });

    // Fetch all settlements for this ledger
    const settlements = await Settlement.find({
      ledgerId: req.params.id,
      userId: req.userId
    });

    // Recalculate from vouchers
    vouchers.forEach(voucher => {
      // Only add fine weights from CREDIT vouchers, not cash vouchers
      if (voucher.paymentType === 'credit') {
        voucher.items?.forEach(item => {
          if (item.metalType === 'gold') {
            ledger.balances.goldFineWeight += item.fineWeight || 0;
          } else if (item.metalType === 'silver') {
            ledger.balances.silverFineWeight += item.fineWeight || 0;
          }
        });
      }

      // Add amount only from credit vouchers
      if (voucher.paymentType === 'credit') {
        ledger.balances.amount += voucher.total || 0;
      }
    });

    // Recalculate from settlements
    settlements.forEach(settlement => {
      if (settlement.metalType === 'gold') {
        ledger.balances.goldFineWeight -= settlement.fineGiven || 0;
      } else if (settlement.metalType === 'silver') {
        ledger.balances.silverFineWeight -= settlement.fineGiven || 0;
      }
      ledger.balances.amount -= settlement.amount || 0;
    });

    // Set hasVouchers flag
    ledger.hasVouchers = vouchers.length > 0;

    await ledger.save();

    res.json({
      success: true,
      message: 'Ledger balances recalculated successfully',
      ledger
    });
  } catch (error) {
    console.error('Recalculate balance error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error recalculating balance'
    });
  }
});

module.exports = router;
