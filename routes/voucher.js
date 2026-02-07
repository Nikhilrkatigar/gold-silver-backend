const express = require('express');
const router = express.Router();
const Voucher = require('../models/Voucher');
const Ledger = require('../models/Ledger');
const User = require('../models/User');
const { auth, checkLicense } = require('../middleware/auth');
const { deductFromStock, addBackToStock } = require('./stock');

router.use(auth);
router.use(checkLicense);

// Create voucher
router.post('/', async (req, res) => {
  try {
    const {
      ledgerId,
      date,
      paymentType,
      goldRate,
      silverRate,
      items,
      stoneAmount,
      fineAmount,
      issue,
      receipt,
      narration,
      voucherNumber,
      cashReceived
    } = req.body;

    // Validate required fields
    if (!ledgerId || !items || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Ledger and items are required'
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

    // Get user for voucher settings
    const user = await User.findById(req.userId);
    
    // Generate voucher number
    let finalVoucherNumber = voucherNumber;
    if (user.voucherSettings.autoIncrement || !voucherNumber) {
      finalVoucherNumber = user.voucherSettings.currentVoucherNumber.toString();
      user.voucherSettings.currentVoucherNumber += 1;
      await user.save();
    }

    // Calculate totals
    const totals = {
      pieces: 0,
      grossWeight: 0,
      lessWeight: 0,
      netWeight: 0,
      melting: 0,
      wastage: 0,
      fineWeight: 0,
      labourRate: 0,
      amount: 0
    };

    items.forEach(item => {
      totals.pieces += item.pieces || 0;
      totals.grossWeight += item.grossWeight || 0;
      totals.lessWeight += item.lessWeight || 0;
      totals.netWeight += item.netWeight || 0;
      totals.melting += item.melting || 0;
      totals.wastage += item.wastage || 0;
      totals.fineWeight += item.fineWeight || 0;
      totals.labourRate += item.labourRate || 0;
      totals.amount += item.amount || 0;
    });

    // Calculate old balance
    const oldBalance = {
      amount: paymentType === 'cash' ? (ledger.balances.cashBalance || 0) : (ledger.balances.creditBalance || 0),
      fineWeight: (ledger.balances.goldFineWeight || 0) + (ledger.balances.silverFineWeight || 0)
    };

    // Calculate total
    const total = totals.amount + (stoneAmount || 0) + (fineAmount || 0);

    // Calculate current balance based on payment type
    let currentBalance = {
      amount: 0,
      netWeight: totals.netWeight
    };

    if (paymentType === 'credit') {
      currentBalance.amount = oldBalance.amount + total;
    } else if (paymentType === 'cash') {
      // For cash bills, calculate if there's a shortfall
      const finalCashReceived = cashReceived || 0;
      const shortfall = Math.max(0, total - finalCashReceived);
      currentBalance.amount = (oldBalance.amount || 0) + shortfall;
    }

    // Create voucher
    const voucher = new Voucher({
      voucherNumber: finalVoucherNumber,
      userId: req.userId,
      ledgerId,
      customerName: ledger.name,
      date: date || new Date(),
      paymentType,
      goldRate: goldRate || 0,
      silverRate: silverRate || 0,
      items,
      totals,
      stoneAmount: stoneAmount || 0,
      fineAmount: fineAmount || 0,
      issue: issue || { gross: 0 },
      receipt: receipt || { gross: 0 },
      oldBalance,
      currentBalance,
      total,
      cashReceived: cashReceived || 0,
      narration: narration || '',
      creditDueDate: paymentType === 'credit' ? new Date(Date.now() + 5 * 24 * 60 * 60 * 1000) : null
    });

    await voucher.save();

    // Update ledger balances
    // Only update fine weights for CREDIT bills, not cash bills
    console.log('🔍 DEBUG - Payment Type:', paymentType, 'Items:', items.map(i => ({ name: i.itemName, metalType: i.metalType, fineWeight: i.fineWeight })));
    if (paymentType === 'credit') {
      items.forEach(item => {
        if (item.metalType === 'gold') {
          ledger.balances.goldFineWeight += item.fineWeight;
        } else if (item.metalType === 'silver') {
          ledger.balances.silverFineWeight += item.fineWeight;
        }
      });
    }

    // Update amount balance based on payment type
    if (paymentType === 'credit') {
      ledger.balances.creditBalance = currentBalance.amount;
      ledger.balances.amount = currentBalance.amount; // Keep for backward compatibility
    } else if (paymentType === 'cash') {
      ledger.balances.cashBalance = currentBalance.amount;
      ledger.balances.amount = currentBalance.amount; // Keep for backward compatibility
    }
    
    ledger.hasVouchers = true;
    await ledger.save();

    // Deduct fine weights from stock only for CREDIT bills, not cash bills
    let goldFineToDeduct = 0;
    let silverFineToDeduct = 0;
    
    if (paymentType === 'credit') {
      items.forEach(item => {
        if (item.metalType === 'gold') {
          goldFineToDeduct += item.fineWeight || 0;
        } else if (item.metalType === 'silver') {
          silverFineToDeduct += item.fineWeight || 0;
        }
      });
      
      await deductFromStock(req.userId, goldFineToDeduct, silverFineToDeduct);
    }

    res.status(201).json({
      success: true,
      message: 'Voucher created successfully',
      voucher
    });
  } catch (error) {
    console.error('Create voucher error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error creating voucher'
    });
  }
});

// Get all vouchers
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

    const vouchers = await Voucher.find(query)
      .populate('ledgerId', 'name phoneNumber')
      .sort({ date: -1 });

    res.json({
      success: true,
      vouchers
    });
  } catch (error) {
    console.error('Get vouchers error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error fetching vouchers'
    });
  }
});

// Get due credits (credit bills due today)
router.get('/due-credits', async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const dueVouchers = await Voucher.find({
      userId: req.userId,
      paymentType: 'credit',
      creditDueDate: {
        $gte: today,
        $lt: tomorrow
      },
      'currentBalance.amount': { $gt: 0 }
    }).populate('ledgerId', 'name phoneNumber');

    // Get unique ledgers with their balances
    const ledgerMap = new Map();
    
    for (const voucher of dueVouchers) {
      const ledgerId = voucher.ledgerId._id.toString();
      
      if (!ledgerMap.has(ledgerId)) {
        const ledger = await Ledger.findById(ledgerId);
        ledgerMap.set(ledgerId, {
          name: voucher.ledgerId.name,
          phoneNumber: voucher.ledgerId.phoneNumber,
          balanceAmount: ledger.balances.amount,
          goldFineWeight: ledger.balances.goldFineWeight,
          silverFineWeight: ledger.balances.silverFineWeight
        });
      }
    }

    const dueCredits = Array.from(ledgerMap.values());

    res.json({
      success: true,
      dueCredits
    });
  } catch (error) {
    console.error('Get due credits error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error fetching due credits'
    });
  }
});

// Get single voucher
router.get('/:id', async (req, res) => {
  try {
    const voucher = await Voucher.findOne({
      _id: req.params.id,
      userId: req.userId
    }).populate('ledgerId', 'name phoneNumber');

    if (!voucher) {
      return res.status(404).json({
        success: false,
        message: 'Voucher not found'
      });
    }

    res.json({
      success: true,
      voucher
    });
  } catch (error) {
    console.error('Get voucher error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error fetching voucher'
    });
  }
});

// Delete voucher
router.delete('/:id', async (req, res) => {
  try {
    const voucher = await Voucher.findOne({
      _id: req.params.id,
      userId: req.userId
    });

    if (!voucher) {
      return res.status(404).json({
        success: false,
        message: 'Voucher not found'
      });
    }

    const ledger = await Ledger.findById(voucher.ledgerId);

    if (ledger) {
      // Only reverse fine weight updates for CREDIT vouchers
      if (voucher.paymentType === 'credit') {
        voucher.items.forEach(item => {
          if (item.metalType === 'gold') {
            ledger.balances.goldFineWeight -= item.fineWeight;
          } else if (item.metalType === 'silver') {
            ledger.balances.silverFineWeight -= item.fineWeight;
          }
        });
      }

      // Only reverse amount balance for credit
      if (voucher.paymentType === 'credit') {
        ledger.balances.amount -= voucher.currentBalance.amount;
      }

      // Check if ledger still has vouchers
      const remainingVouchers = await Voucher.countDocuments({
        ledgerId: voucher.ledgerId,
        _id: { $ne: voucher._id }
      });

      if (remainingVouchers === 0) {
        ledger.hasVouchers = false;
      }

      await ledger.save();
    }

    // Add fine weights back to stock only for CREDIT vouchers
    let goldFineToAdd = 0;
    let silverFineToAdd = 0;
    if (voucher.paymentType === 'credit') {
      voucher.items?.forEach(item => {
        if (item.metalType === 'gold') {
          goldFineToAdd += item.fineWeight || 0;
        } else if (item.metalType === 'silver') {
          silverFineToAdd += item.fineWeight || 0;
        }
      });
      
      await addBackToStock(req.userId, goldFineToAdd, silverFineToAdd);
    }

    await Voucher.findByIdAndDelete(req.params.id);

    res.json({
      success: true,
      message: 'Voucher deleted successfully'
    });
  } catch (error) {
    console.error('Delete voucher error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error deleting voucher'
    });
  }
});

module.exports = router;
