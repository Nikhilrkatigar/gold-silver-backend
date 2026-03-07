const express = require('express');
const router = express.Router();
const Settlement = require('../models/Settlement');
const Ledger = require('../models/Ledger');
const { auth, checkLicense } = require('../middleware/auth');
const { deductFromStock, addBackToStock } = require('./stock');
const CONSTANTS = require('../utils/constants');
const { toNumber, canReverse, canReverseWithWindow, getReversalWindowHours, calculateUnifiedAmount } = require('../utils/helpers');

// user-aware reversal helper
const canReverseForSettlement = (settlement, user) => {
  let windowHours;
  if (user?.reversalSettings) {
    if (user.reversalSettings.enabled === false) {
      windowHours = 0;
    } else {
      windowHours = user.reversalSettings.windowHours ?? getReversalWindowHours();
    }
  } else {
    windowHours = getReversalWindowHours();
  }
  return canReverseWithWindow(settlement?.createdAt, windowHours);
};


router.use(auth);
router.use(checkLicense);

router.post('/', async (req, res) => {
  let stockAdjusted = false;
  let stockAction = null;
  let fineGiven = 0;

  try {
    const {
      ledgerId,
      metalType,
      metalRate,
      narration,
      date,
      direction = 'payment',
      isMoneyConversion = false // Flag for money_to_gold/money_to_silver
    } = req.body;

    fineGiven = toNumber(req.body.fineGiven);
    const rate = toNumber(metalRate);
    const requestAmount = toNumber(req.body.amount);

    if (!ledgerId || !['gold', 'silver'].includes(metalType) || !['payment', 'receipt'].includes(direction)) {
      return res.status(400).json({
        success: false,
        message: 'ledgerId, metalType and direction are required'
      });
    }

    // Allow negative fineGiven and metalRate for settlement adjustments

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

    const balanceBeforeFine = metalType === 'gold'
      ? toNumber(ledger.balances.goldFineWeight)
      : toNumber(ledger.balances.silverFineWeight);

    const amount = isMoneyConversion ? requestAmount : fineGiven * rate;

    // For money conversions, we need credit balance for the cash amount
    if (isMoneyConversion && toNumber(ledger.balances.creditBalance) < amount) {
      return res.status(400).json({
        success: false,
        message: 'Insufficient cash balance for money conversion'
      });
    }

    // For regular settlements (non-money-conversion), check existing rules
    if (!isMoneyConversion) {
      if (direction === 'payment' && balanceBeforeFine < fineGiven) {
        return res.status(400).json({
          success: false,
          message: 'Insufficient balance for settlement'
        });
      }

      if (direction === 'payment' && toNumber(ledger.balances.creditBalance) < amount) {
        return res.status(400).json({
          success: false,
          message: 'Settlement amount exceeds pending credit balance'
        });
      }
    }

    if (direction === 'payment' && !isMoneyConversion) {
      if (metalType === 'gold') {
        await deductFromStock(req.userId, fineGiven, 0);
      } else {
        await deductFromStock(req.userId, 0, fineGiven);
      }
      stockAdjusted = true;
      stockAction = 'deduct';
    } else if (direction === 'receipt' && !isMoneyConversion) {
      if (metalType === 'gold') {
        await addBackToStock(req.userId, fineGiven, 0);
      } else {
        await addBackToStock(req.userId, 0, fineGiven);
      }
      stockAdjusted = true;
      stockAction = 'add';
    } else if (isMoneyConversion) {
      // For money conversion, always add to stock (customer is giving cash to receive fine)
      if (metalType === 'gold') {
        await addBackToStock(req.userId, fineGiven, 0);
      } else {
        await addBackToStock(req.userId, 0, fineGiven);
      }
      stockAdjusted = true;
      stockAction = 'add';
    }

    const fineMultiplier = direction === 'receipt' ? 1 : -1;
    const amountMultiplier = direction === 'receipt' ? 1 : -1;

    // For money conversions, use asymmetric multipliers
    const finalFineMultiplier = isMoneyConversion ? 1 : fineMultiplier; // Always add fine
    const finalAmountMultiplier = isMoneyConversion ? -1 : amountMultiplier; // Always deduct amount

    const updatedFine = balanceBeforeFine + (finalFineMultiplier * fineGiven);
    const updatedCredit = toNumber(ledger.balances.creditBalance) + (finalAmountMultiplier * amount);

    if (updatedFine < 0 || updatedCredit < 0) {
      if (stockAdjusted) {
        if (stockAction === 'deduct') {
          await addBackToStock(req.userId, metalType === 'gold' ? fineGiven : 0, metalType === 'silver' ? fineGiven : 0);
        } else {
          await deductFromStock(req.userId, metalType === 'gold' ? fineGiven : 0, metalType === 'silver' ? fineGiven : 0);
        }
      }

      return res.status(400).json({
        success: false,
        message: 'Invalid settlement resulting in negative balance'
      });
    }

    const settlement = new Settlement({
      userId: req.userId,
      ledgerId,
      customerName: ledger.name,
      date: date || new Date(),
      metalType,
      balanceBefore: balanceBeforeFine,
      metalRate: rate,
      fineGiven,
      amount,
      direction,
      balanceAfter: {
        amount: updatedCredit,
        fineWeight: updatedFine
      },
      narration: narration || ''
    });

    await settlement.save();

    if (metalType === 'gold') {
      ledger.balances.goldFineWeight = updatedFine;
    } else {
      ledger.balances.silverFineWeight = updatedFine;
    }
    ledger.balances.creditBalance = updatedCredit;
    ledger.balances.amount = calculateUnifiedAmount(ledger.balances);
    await ledger.save();

    return res.status(201).json({
      success: true,
      message: 'Settlement created successfully',
      settlement
    });
  } catch (error) {
    if (stockAdjusted) {
      try {
        if (stockAction === 'deduct') {
          await addBackToStock(req.userId, req.body.metalType === 'gold' ? fineGiven : 0, req.body.metalType === 'silver' ? fineGiven : 0);
        } else if (stockAction === 'add') {
          await deductFromStock(req.userId, req.body.metalType === 'gold' ? fineGiven : 0, req.body.metalType === 'silver' ? fineGiven : 0);
        }
      } catch (rollbackError) {
        console.error('Settlement rollback stock error:', rollbackError);
      }
    }

    console.error('Create settlement error:', error);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Server error creating settlement'
    });
  }
});

router.get('/', async (req, res) => {
  try {
    const { startDate, endDate, ledgerId } = req.query;
    const query = { userId: req.userId };

    if (ledgerId) query.ledgerId = ledgerId;
    if (startDate || endDate) {
      query.date = {};
      if (startDate) query.date.$gte = new Date(startDate);
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        query.date.$lte = end;
      }
    }

    const settlements = await Settlement.find(query)
      .populate('ledgerId', 'name phoneNumber')
      .sort({ date: -1 });

    return res.json({
      success: true,
      settlements
    });
  } catch (error) {
    console.error('Get settlements error:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error fetching settlements'
    });
  }
});

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

    return res.json({
      success: true,
      settlement
    });
  } catch (error) {
    console.error('Get settlement error:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error fetching settlement'
    });
  }
});

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

    // retrieve user-specific policy
    const currentUser = await require('../models/User').findById(req.userId).select('reversalSettings');
    if (!canReverseForSettlement(settlement, currentUser)) {
      const window = currentUser?.reversalSettings
        ? (currentUser.reversalSettings.enabled === false
            ? 0
            : (currentUser.reversalSettings.windowHours ?? getReversalWindowHours()))
        : getReversalWindowHours();
      return res.status(400).json({
        success: false,
        message: `Settlement cannot be deleted after ${window} hours`
      });
    }

    const ledger = await Ledger.findById(settlement.ledgerId);
    if (ledger) {
      const fineMultiplier = settlement.direction === 'receipt' ? -1 : 1;
      const amountMultiplier = settlement.direction === 'receipt' ? -1 : 1;

      if (settlement.metalType === 'gold') {
        ledger.balances.goldFineWeight += fineMultiplier * toNumber(settlement.fineGiven);
      } else {
        ledger.balances.silverFineWeight += fineMultiplier * toNumber(settlement.fineGiven);
      }
      ledger.balances.creditBalance += amountMultiplier * toNumber(settlement.amount);
      ledger.balances.amount = calculateUnifiedAmount(ledger.balances);
      await ledger.save();
    }

    if (settlement.direction === 'payment') {
      await addBackToStock(
        req.userId,
        settlement.metalType === 'gold' ? settlement.fineGiven : 0,
        settlement.metalType === 'silver' ? settlement.fineGiven : 0
      );
    } else {
      await deductFromStock(
        req.userId,
        settlement.metalType === 'gold' ? settlement.fineGiven : 0,
        settlement.metalType === 'silver' ? settlement.fineGiven : 0
      );
    }

    await Settlement.findByIdAndDelete(req.params.id);

    return res.json({
      success: true,
      message: 'Settlement deleted successfully'
    });
  } catch (error) {
    console.error('Delete settlement error:', error);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Server error deleting settlement'
    });
  }
});

module.exports = router;
