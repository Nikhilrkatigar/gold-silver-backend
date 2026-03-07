const express = require('express');
const router = express.Router();
const Karigar = require('../models/Karigar');
const { auth, checkLicense } = require('../middleware/auth');
const { deductFromStock, addBackToStock } = require('./stock');
const CONSTANTS = require('../utils/constants');
const { toNumber, canReverse, canReverseWithWindow, getReversalWindowHours, parsePagination, paginationMeta } = require('../utils/helpers');


const canReverseForKarigar = (transaction, user) => {
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
  return canReverseWithWindow(transaction?.createdAt, windowHours);
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
    const { page, limit, skip } = parsePagination(req.query);

    const filter = {
      userId: req.userId,
      isDeleted: false
    };

    const [transactions, total] = await Promise.all([
      Karigar.find(filter)
        .sort({ date: -1 })
        .skip(skip)
        .limit(limit),
      Karigar.countDocuments(filter)
    ]);

    return res.json({
      success: true,
      transactions,
      pagination: paginationMeta(page, limit, total)
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

    const currentUser = await require('../models/User').findById(req.userId).select('reversalSettings');
    if (!canReverseForKarigar(transaction, currentUser)) {
      const window = currentUser?.reversalSettings
        ? (currentUser.reversalSettings.enabled === false
            ? 0
            : (currentUser.reversalSettings.windowHours ?? getReversalWindowHours()))
        : getReversalWindowHours();
      return res.status(400).json({
        success: false,
        message: `Transaction cannot be deleted after ${window} hours`
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
