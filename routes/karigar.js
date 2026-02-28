const express = require('express');
const router = express.Router();
const Karigar = require('../models/Karigar');
const { auth, checkLicense } = require('../middleware/auth');
const { deductFromStock, addBackToStock } = require('./stock');
const CONSTANTS = require('../utils/constants');

const toNumber = (value, fallback = 0) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
};

const getReversalWindowHours = () => {
  const configured = toNumber(CONSTANTS.REVERSAL_POLICY?.WINDOW_HOURS, 48);
  return configured > 0 ? configured : 48;
};

const canReverseForKarigar = (transaction) => {
  const referenceDate = transaction?.createdAt ? new Date(transaction.createdAt) : null;
  const referenceTime = referenceDate?.getTime();
  if (!Number.isFinite(referenceTime)) return false;

  const elapsedMs = Date.now() - referenceTime;
  const allowedMs = getReversalWindowHours() * 60 * 60 * 1000;
  return elapsedMs <= allowedMs;
};

router.use(auth);
router.use(checkLicense);

router.post('/', async (req, res) => {
  try {
    const {
      date,
      type,
      karigarName,
      itemName,
      metalType,
      narration
    } = req.body;

    const fineWeight = toNumber(req.body.fineWeight);
    const chargeAmount = Math.max(0, toNumber(req.body.chargeAmount));

    if (!type || !karigarName || !itemName || !metalType) {
      return res.status(400).json({
        success: false,
        message: 'type, karigarName, itemName and metalType are required'
      });
    }

    if (!['given', 'received'].includes(type)) {
      return res.status(400).json({
        success: false,
        message: 'Type must be either "given" or "received"'
      });
    }

    if (!['gold', 'silver'].includes(metalType)) {
      return res.status(400).json({
        success: false,
        message: 'metalType must be either "gold" or "silver"'
      });
    }

    if (fineWeight <= 0) {
      return res.status(400).json({
        success: false,
        message: 'fineWeight must be greater than 0'
      });
    }

    if (type === 'given') {
      await deductFromStock(req.userId, metalType === 'gold' ? fineWeight : 0, metalType === 'silver' ? fineWeight : 0);
    } else {
      await addBackToStock(req.userId, metalType === 'gold' ? fineWeight : 0, metalType === 'silver' ? fineWeight : 0);
    }

    const transaction = new Karigar({
      userId: req.userId,
      date: date || new Date(),
      type,
      karigarName: String(karigarName).trim(),
      itemName: String(itemName).trim(),
      metalType,
      fineWeight,
      chargeAmount,
      narration: narration || ''
    });

    await transaction.save();

    return res.status(201).json({
      success: true,
      message: 'Transaction created successfully',
      transaction
    });
  } catch (error) {
    console.error('Error creating karigar transaction:', error);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Failed to create transaction'
    });
  }
});

router.get('/', async (req, res) => {
  try {
    const transactions = await Karigar.find({
      userId: req.userId,
      isDeleted: false
    }).sort({ date: -1 });

    return res.json({
      success: true,
      transactions
    });
  } catch (error) {
    console.error('Error fetching karigar transactions:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch transactions'
    });
  }
});

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

    return res.json({
      success: true,
      transaction
    });
  } catch (error) {
    console.error('Error fetching karigar transaction:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch transaction'
    });
  }
});

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

    if (transaction.isDeleted) {
      return res.status(400).json({
        success: false,
        message: 'Transaction already deleted'
      });
    }

    if (!canReverseForKarigar(transaction)) {
      return res.status(400).json({
        success: false,
        message: `Transaction cannot be deleted after ${getReversalWindowHours()} hours`
      });
    }

    if (transaction.type === 'given') {
      await addBackToStock(
        req.userId,
        transaction.metalType === 'gold' ? transaction.fineWeight : 0,
        transaction.metalType === 'silver' ? transaction.fineWeight : 0
      );
    } else {
      await deductFromStock(
        req.userId,
        transaction.metalType === 'gold' ? transaction.fineWeight : 0,
        transaction.metalType === 'silver' ? transaction.fineWeight : 0
      );
    }

    transaction.isDeleted = true;
    await transaction.save();

    return res.json({
      success: true,
      message: 'Transaction deleted successfully and stock reversed'
    });
  } catch (error) {
    console.error('Error deleting karigar transaction:', error);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Failed to delete transaction'
    });
  }
});

module.exports = router;
