const express = require('express');
const router = express.Router();
const Voucher = require('../models/Voucher');
const Ledger = require('../models/Ledger');
const User = require('../models/User');
const { auth, checkLicense } = require('../middleware/auth');
const { deductFromStock, addBackToStock } = require('./stock');
const CONSTANTS = require('../utils/constants');

const toNumber = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const pickNumber = (...values) => {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return 0;
};

const sanitizeBalanceSnapshot = (incomingSnapshot, fallbackSnapshot) => ({
  oldBalance: {
    creditAmount: pickNumber(incomingSnapshot?.oldBalance?.creditAmount, fallbackSnapshot.oldBalance.creditAmount),
    cashAmount: pickNumber(incomingSnapshot?.oldBalance?.cashAmount, fallbackSnapshot.oldBalance.cashAmount),
    totalAmount: pickNumber(incomingSnapshot?.oldBalance?.totalAmount, fallbackSnapshot.oldBalance.totalAmount),
    goldFineWeight: pickNumber(incomingSnapshot?.oldBalance?.goldFineWeight, fallbackSnapshot.oldBalance.goldFineWeight),
    silverFineWeight: pickNumber(incomingSnapshot?.oldBalance?.silverFineWeight, fallbackSnapshot.oldBalance.silverFineWeight)
  },
  currentBalance: {
    amount: pickNumber(incomingSnapshot?.currentBalance?.amount, fallbackSnapshot.currentBalance.amount),
    goldFineWeight: pickNumber(incomingSnapshot?.currentBalance?.goldFineWeight, fallbackSnapshot.currentBalance.goldFineWeight),
    silverFineWeight: pickNumber(incomingSnapshot?.currentBalance?.silverFineWeight, fallbackSnapshot.currentBalance.silverFineWeight)
  }
});

const badRequest = (message) => {
  const error = new Error(message);
  error.status = 400;
  return error;
};

const calculateUnifiedAmount = (balances) => (
  toNumber(balances.creditBalance) + toNumber(balances.cashBalance)
);

const calculateGSTBreakdown = (taxableAmount, gstRate, gstType) => {
  const rate = toNumber(gstRate);
  const taxable = toNumber(taxableAmount);

  if (!rate || !taxable || !gstType) {
    return { igst: 0, cgst: 0, sgst: 0, totalGST: 0 };
  }

  if (gstType === 'IGST') {
    const igst = (taxable * rate) / 100;
    return { igst, cgst: 0, sgst: 0, totalGST: igst };
  }

  if (gstType === 'CGST_SGST') {
    const halfRate = rate / 2;
    const cgst = (taxable * halfRate) / 100;
    const sgst = (taxable * halfRate) / 100;
    return { igst: 0, cgst, sgst, totalGST: cgst + sgst };
  }

  return { igst: 0, cgst: 0, sgst: 0, totalGST: 0 };
};

const getCashShortfall = (total, cashReceived) => (
  Math.max(0, toNumber(total) - toNumber(cashReceived))
);

const getFineByMetal = (items = []) => items.reduce(
  (acc, item) => {
    const fine = toNumber(item.fineWeight);
    if (item.metalType === 'gold') acc.gold += fine;
    if (item.metalType === 'silver') acc.silver += fine;
    return acc;
  },
  { gold: 0, silver: 0 }
);

const reverseVoucherEffects = async (voucher, ledger) => {
  if (!voucher || !ledger) return;

  // If voucher has previousLedgerState saved, use it to restore the exact previous state
  if (voucher.previousLedgerState) {
    ledger.balances.goldFineWeight = toNumber(voucher.previousLedgerState.goldFineWeight);
    ledger.balances.silverFineWeight = toNumber(voucher.previousLedgerState.silverFineWeight);
    ledger.balances.amount = toNumber(voucher.previousLedgerState.amount);
    ledger.balances.cashBalance = toNumber(voucher.previousLedgerState.cashBalance);
    ledger.balances.creditBalance = toNumber(voucher.previousLedgerState.creditBalance);
    return;
  }

  // Fallback for vouchers without previousLedgerState (old vouchers)
  // Reverse stock for all vouchers
  const fine = getFineByMetal(voucher.items);
  if (fine.gold > 0 || fine.silver > 0) {
    await addBackToStock(voucher.userId, fine.gold, fine.silver);
  }

  // Skip balance updates for GST invoices
  if (voucher.invoiceType === 'gst' || ledger.ledgerType === 'gst') {
    return;
  }

  // Handle settlement types (add_cash, add_gold, add_silver, money_to_gold, money_to_silver)
  if (['add_cash', 'add_gold', 'add_silver', 'money_to_gold', 'money_to_silver'].includes(voucher.paymentType)) {
    if (voucher.paymentType === 'add_cash') {
      const amountToReverse = toNumber(voucher.cashReceived);
      if (toNumber(ledger.balances.cashBalance) !== 0 || toNumber(ledger.balances.creditBalance) === 0) {
        ledger.balances.cashBalance -= amountToReverse;
      } else {
        ledger.balances.creditBalance -= amountToReverse;
      }
    } else if (voucher.paymentType === 'add_gold') {
      // Reverse: Add back the fine that was subtracted when settlement was created
      ledger.balances.goldFineWeight += toNumber(voucher.cashReceived);
    } else if (voucher.paymentType === 'add_silver') {
      // Reverse: Add back the fine that was subtracted when settlement was created
      ledger.balances.silverFineWeight += toNumber(voucher.cashReceived);
    } else if (voucher.paymentType === 'money_to_gold') {
      // Reverse: Add back the fine that was settled
      const amountToReverse = toNumber(voucher.cashReceived);
      ledger.balances.goldFineWeight += (amountToReverse / (toNumber(voucher.goldRate) || 1));
    } else if (voucher.paymentType === 'money_to_silver') {
      // Reverse: Add back the fine that was settled
      const amountToReverse = toNumber(voucher.cashReceived);
      ledger.balances.silverFineWeight += (amountToReverse / (toNumber(voucher.silverRate) || 1));
    }
    ledger.balances.amount = calculateUnifiedAmount(ledger.balances);
    return;
  }

  // Handle regular billing vouchers
  if (voucher.paymentType === 'credit') {
    voucher.items.forEach((item) => {
      if (item.metalType === 'gold') {
        ledger.balances.goldFineWeight -= toNumber(item.fineWeight);
      } else if (item.metalType === 'silver') {
        ledger.balances.silverFineWeight -= toNumber(item.fineWeight);
      }
    });
    // Credit bills use cashBalance, not creditBalance
    ledger.balances.cashBalance -= toNumber(voucher.total);
    ledger.balances.amount = calculateUnifiedAmount(ledger.balances);
  } else if (voucher.paymentType === 'cash') {
    const shortfall = getCashShortfall(voucher.total, voucher.cashReceived);
    ledger.balances.cashBalance -= shortfall;
    ledger.balances.amount = calculateUnifiedAmount(ledger.balances);
  }
};

router.use(auth);
router.use(checkLicense);

router.post('/', async (req, res) => {
  let voucher;
  let stockAdjusted = false;
  let deductedFine = { gold: 0, silver: 0 };
  let ledger;
  let previousLedgerState;
  let previousHasVouchers;

  try {
    const {
      ledgerId,
      date,
      paymentType,
      invoiceType = 'normal',
      invoiceNumber,
      referenceNo,
      eWayBillNo,
      goldRate,
      silverRate,
      items,
      stoneAmount,
      fineAmount,
      issue,
      receipt,
      narration,
      voucherNumber,
      cashReceived,
      bankName,
      accountNumber,
      ifscCode,
      upiId,
      transport,
      transportId,
      deliveryLocation,
      gstDetails,
      balanceSnapshot: incomingBalanceSnapshot
    } = req.body;

    // Allow settlement types
    const allowedTypes = ['cash', 'credit', 'add_cash', 'add_gold', 'add_silver', 'money_to_gold', 'money_to_silver'];
    const isSettlementType = ['add_cash', 'add_gold', 'add_silver', 'money_to_gold', 'money_to_silver'].includes(paymentType);

    // Validate ledgerId is always required
    if (!ledgerId) {
      return res.status(400).json({
        success: false,
        message: 'Ledger is required'
      });
    }

    // Validate paymentType
    if (!allowedTypes.includes(paymentType)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid paymentType'
      });
    }

    // For non-settlement types, items are required
    if (!isSettlementType) {
      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'At least one item is required for this payment type'
        });
      }
    }

    let cleanedItems = [];
    if (['cash', 'credit'].includes(paymentType)) {
      cleanedItems = items.map((item, index) => {
        const cleaned = {
          itemName: String(item.itemName || '').trim(),
          metalType: item.metalType,
          pieces: Math.max(1, Math.floor(toNumber(item.pieces, 1))),
          grossWeight: toNumber(item.grossWeight),
          lessWeight: Math.max(0, toNumber(item.lessWeight)),
          netWeight: toNumber(item.netWeight),
          melting: Math.max(0, toNumber(item.melting)),
          wastage: Math.max(0, toNumber(item.wastage)),
          fineWeight: toNumber(item.fineWeight),
          labourRate: toNumber(item.labourRate),
          amount: toNumber(item.amount),
          hsnCode: item.hsnCode || (item.metalType === 'silver' ? '7106' : '7108')
        };
        if (!cleaned.itemName || !['gold', 'silver'].includes(cleaned.metalType)) {
          throw badRequest(`Invalid item at row ${index + 1}`);
        }
        // Allow negative weights for adjustments - toNumber() already ensures values are finite
        return cleaned;
      });
    } else {
      // For settlement types, no items required
      cleanedItems = [];
    }

    ledger = await Ledger.findOne({
      _id: ledgerId,
      userId: req.userId
    });
    if (!ledger) {
      return res.status(404).json({
        success: false,
        message: 'Ledger not found'
      });
    }

    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const normalizedInvoiceNumber = invoiceNumber ? String(invoiceNumber).trim() : '';
    if (normalizedInvoiceNumber) {
      const existingInvoice = await Voucher.findOne({
        userId: req.userId,
        invoiceNumber: normalizedInvoiceNumber,
        status: 'active'
      });
      if (existingInvoice) {
        return res.status(400).json({
          success: false,
          message: CONSTANTS.ERROR_MESSAGES.DUPLICATE_INVOICE
        });
      }
    }

    let finalVoucherNumber = String(voucherNumber || '').trim();
    const shouldAutoIncrement = user.voucherSettings?.autoIncrement || !finalVoucherNumber;
    if (shouldAutoIncrement) {
      finalVoucherNumber = String(user.voucherSettings.currentVoucherNumber || 1);
    }

    const duplicateVoucher = await Voucher.findOne({
      userId: req.userId,
      voucherNumber: finalVoucherNumber,
      status: 'active'
    });
    if (duplicateVoucher) {
      return res.status(400).json({
        success: false,
        message: 'Voucher number already exists'
      });
    }

    let totals = {
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
    if (['cash', 'credit'].includes(paymentType)) {
      totals = cleanedItems.reduce((acc, item) => ({
        pieces: acc.pieces + toNumber(item.pieces),
        grossWeight: acc.grossWeight + toNumber(item.grossWeight),
        lessWeight: acc.lessWeight + toNumber(item.lessWeight),
        netWeight: acc.netWeight + toNumber(item.netWeight),
        melting: acc.melting + toNumber(item.melting),
        wastage: acc.wastage + toNumber(item.wastage),
        fineWeight: acc.fineWeight + toNumber(item.fineWeight),
        labourRate: acc.labourRate + toNumber(item.labourRate),
        amount: acc.amount + toNumber(item.amount)
      }), totals);
    }

    const oldBalance = {
      amount: paymentType === 'cash' ? toNumber(ledger.balances.cashBalance)
        : paymentType === 'credit' ? toNumber(ledger.balances.cashBalance) // Credit bills use cashBalance
          : paymentType === 'add_cash' ? (toNumber(ledger.balances.cashBalance) || toNumber(ledger.balances.creditBalance)) // Use cashBalance for regular ledgers, creditBalance as fallback
            : paymentType === 'money_to_gold' || paymentType === 'money_to_silver' ? (toNumber(ledger.balances.cashBalance) || toNumber(ledger.balances.creditBalance)) // Use appropriate balance
              : toNumber(ledger.balances.cashBalance), // Default to cashBalance
      fineWeight: toNumber(ledger.balances.goldFineWeight) + toNumber(ledger.balances.silverFineWeight)
    };

    const stone = toNumber(stoneAmount);
    const fineAdj = toNumber(fineAmount);
    const taxableValue = totals.amount + stone;

    let gstType = gstDetails?.gstType;
    const gstRate = toNumber(gstDetails?.gstRate);
    if (invoiceType === 'gst' && !['IGST', 'CGST_SGST'].includes(gstType)) {
      gstType = null;
    }
    if (invoiceType === 'gst' && !gstType) {
      throw badRequest('Invalid GST type for GST invoice');
    }
    const gstCalc = calculateGSTBreakdown(taxableValue, gstRate, gstType);

    let totalBeforeGST = totals.amount + stone + fineAdj;
    let total = totalBeforeGST + toNumber(gstCalc.totalGST);
    if (['add_cash', 'add_gold', 'add_silver', 'money_to_gold', 'money_to_silver'].includes(paymentType)) {
      total = toNumber(cashReceived);
    }

    let currentBalance = {
      amount: 0,
      netWeight: totals.netWeight
    };
    if (paymentType === 'credit') {
      currentBalance.amount = oldBalance.amount + total;
    } else if (paymentType === 'cash') {
      const shortfall = getCashShortfall(total, cashReceived);
      currentBalance.amount = oldBalance.amount + shortfall;
    } else if (paymentType === 'add_cash') {
      currentBalance.amount = oldBalance.amount - total; // Subtract from balance
    } else if (paymentType === 'add_gold') {
      currentBalance.amount = oldBalance.amount;
      // handled below
    } else if (paymentType === 'add_silver') {
      currentBalance.amount = oldBalance.amount;
      // handled below
    } else if (paymentType === 'money_to_gold' || paymentType === 'money_to_silver') {
      currentBalance.amount = oldBalance.amount - total; // Subtract cash, add fine below
    }

    if (['cash', 'credit'].includes(paymentType)) {
      deductedFine = getFineByMetal(cleanedItems);
      if (deductedFine.gold > 0 || deductedFine.silver > 0) {
        await deductFromStock(req.userId, deductedFine.gold, deductedFine.silver);
        stockAdjusted = true;
      }
    }

    const oldCreditAmount = toNumber(ledger.balances.creditBalance);
    const oldCashAmount = toNumber(ledger.balances.cashBalance);
    const oldGoldFineWeight = toNumber(ledger.balances.goldFineWeight);
    const oldSilverFineWeight = toNumber(ledger.balances.silverFineWeight);

    let currentGoldFineWeight = oldGoldFineWeight;
    let currentSilverFineWeight = oldSilverFineWeight;

    if (paymentType === 'credit') {
      currentGoldFineWeight += deductedFine.gold;
      currentSilverFineWeight += deductedFine.silver;
    } else if (paymentType === 'add_gold') {
      currentGoldFineWeight -= toNumber(cashReceived);
    } else if (paymentType === 'add_silver') {
      currentSilverFineWeight -= toNumber(cashReceived);
    } else if (paymentType === 'money_to_gold') {
      currentGoldFineWeight -= (toNumber(cashReceived) / (toNumber(goldRate) || 1));
    } else if (paymentType === 'money_to_silver') {
      currentSilverFineWeight -= (toNumber(cashReceived) / (toNumber(silverRate) || 1));
    }

    const fallbackCurrentAmount = paymentType === 'credit'
      ? (oldCreditAmount + oldCashAmount + total)
      : paymentType === 'cash'
        ? (oldCashAmount + getCashShortfall(total, cashReceived))
        : currentBalance.amount;

    const fallbackBalanceSnapshot = {
      oldBalance: {
        creditAmount: oldCreditAmount,
        cashAmount: oldCashAmount,
        totalAmount: oldCreditAmount + oldCashAmount,
        goldFineWeight: oldGoldFineWeight,
        silverFineWeight: oldSilverFineWeight
      },
      currentBalance: {
        amount: fallbackCurrentAmount,
        goldFineWeight: currentGoldFineWeight,
        silverFineWeight: currentSilverFineWeight
      }
    };

    const balanceSnapshot = sanitizeBalanceSnapshot(incomingBalanceSnapshot, fallbackBalanceSnapshot);

    voucher = new Voucher({
      voucherNumber: finalVoucherNumber,
      userId: req.userId,
      ledgerId,
      customerName: ledger.name,
      date: date || new Date(),
      invoiceType,
      invoiceNumber: normalizedInvoiceNumber || '',
      referenceNo: referenceNo || '',
      paymentType,
      goldRate: toNumber(goldRate),
      silverRate: toNumber(silverRate),
      items: cleanedItems,
      totals,
      stoneAmount: stone,
      fineAmount: fineAdj,
      issue: issue || { gross: 0 },
      receipt: receipt || { gross: 0 },
      oldBalance,
      currentBalance,
      balanceSnapshot,
      total,
      cashReceived: toNumber(cashReceived),
      narration: narration || '',
      eWayBillNo: eWayBillNo || '',
      bankName: bankName || '',
      accountNumber: accountNumber || '',
      ifscCode: ifscCode || '',
      upiId: upiId || '',
      transport: transport || '',
      transportId: transportId || '',
      deliveryLocation: deliveryLocation || '',
      gstDetails: invoiceType === 'gst' ? {
        sellerGSTNumber: gstDetails?.sellerGSTNumber,
        sellerState: gstDetails?.sellerState,
        customerGSTNumber: gstDetails?.customerGSTNumber,
        customerState: gstDetails?.customerState,
        gstType,
        gstRate,
        taxableValue,
        igst: gstCalc.igst,
        cgst: gstCalc.cgst,
        sgst: gstCalc.sgst,
        totalGST: gstCalc.totalGST
      } : undefined,
      creditDueDate: paymentType === 'credit'
        ? new Date(Date.now() + CONSTANTS.CREDIT_PAYMENT.DUE_DAYS * 24 * 60 * 60 * 1000)
        : null
    });

    await voucher.save();

    // Re-fetch ledger to get the latest state before updating balance
    // This prevents race conditions when multiple vouchers are created simultaneously
    const freshLedger = await Ledger.findById(ledger._id);
    if (!freshLedger) {
      throw new Error('Ledger not found after voucher creation');
    }

    previousLedgerState = {
      goldFineWeight: toNumber(freshLedger.balances.goldFineWeight),
      silverFineWeight: toNumber(freshLedger.balances.silverFineWeight),
      amount: toNumber(freshLedger.balances.amount),
      cashBalance: toNumber(freshLedger.balances.cashBalance),
      creditBalance: toNumber(freshLedger.balances.creditBalance)
    };

    // IMPORTANT: Save previousLedgerState to voucher for proper reversal on delete
    voucher.previousLedgerState = previousLedgerState;

    previousHasVouchers = freshLedger.hasVouchers;

    // Skip balance updates for GST invoices or GST-type ledgers
    if (invoiceType !== 'gst' && freshLedger.ledgerType !== 'gst') {
      if (paymentType === 'credit') {
        cleanedItems.forEach((item) => {
          if (item.metalType === 'gold') {
            freshLedger.balances.goldFineWeight += toNumber(item.fineWeight);
          } else if (item.metalType === 'silver') {
            freshLedger.balances.silverFineWeight += toNumber(item.fineWeight);
          }
        });
        // Credit bills should update cashBalance, not creditBalance
        freshLedger.balances.cashBalance = currentBalance.amount;
      } else if (paymentType === 'cash') {
        freshLedger.balances.cashBalance = currentBalance.amount;
      } else if (paymentType === 'add_cash') {
        // For add_cash, determine which balance to update based on which one is being used
        if (toNumber(freshLedger.balances.cashBalance) !== 0 || toNumber(freshLedger.balances.creditBalance) === 0) {
          freshLedger.balances.cashBalance = currentBalance.amount;
        } else {
          freshLedger.balances.creditBalance = currentBalance.amount;
        }
      } else if (paymentType === 'add_gold') {
        // Customer gives gold to settle debt - reduces gold owed
        freshLedger.balances.goldFineWeight -= toNumber(cashReceived);
      } else if (paymentType === 'add_silver') {
        // Customer gives silver to settle debt - reduces silver owed
        freshLedger.balances.silverFineWeight -= toNumber(cashReceived);
      } else if (paymentType === 'money_to_gold') {
        // Customer pays cash to settle gold fine debt - reduces gold owed
        freshLedger.balances.goldFineWeight -= (toNumber(cashReceived) / (toNumber(goldRate) || 1));
      } else if (paymentType === 'money_to_silver') {
        // Customer pays cash to settle silver fine debt - reduces silver owed
        freshLedger.balances.silverFineWeight -= (toNumber(cashReceived) / (toNumber(silverRate) || 1));
      }
      freshLedger.balances.amount = calculateUnifiedAmount(freshLedger.balances);
    }

    freshLedger.hasVouchers = true;
    await freshLedger.save();

    // Save the voucher with previousLedgerState for proper deletion reversal
    await voucher.save();

    if (shouldAutoIncrement) {
      user.voucherSettings.currentVoucherNumber = toNumber(user.voucherSettings.currentVoucherNumber, 1) + 1;
      await user.save();
    }

    return res.status(201).json({
      success: true,
      message: 'Voucher created successfully',
      voucher
    });
  } catch (error) {
    if (voucher?._id) {
      await Voucher.findByIdAndDelete(voucher._id).catch(() => { });
    }

    if (ledger && previousLedgerState) {
      ledger.balances = previousLedgerState;
      ledger.hasVouchers = previousHasVouchers;
      await ledger.save().catch(() => { });
    }

    if (stockAdjusted && (deductedFine.gold > 0 || deductedFine.silver > 0)) {
      await addBackToStock(req.userId, deductedFine.gold, deductedFine.silver).catch(() => { });
    }

    console.error('Create voucher error:', error);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Server error creating voucher'
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

    const vouchers = await Voucher.find(query)
      .populate('ledgerId', 'name phoneNumber')
      .sort({ date: -1 });

    return res.json({
      success: true,
      vouchers
    });
  } catch (error) {
    console.error('Get vouchers error:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error fetching vouchers'
    });
  }
});

router.get('/due-credits', async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const dueVouchers = await Voucher.find({
      userId: req.userId,
      paymentType: 'credit',
      status: 'active',
      creditDueDate: {
        $gte: today,
        $lt: tomorrow
      }
    }).populate('ledgerId', 'name phoneNumber');

    const ledgerMap = new Map();

    for (const voucher of dueVouchers) {
      if (!voucher.ledgerId?._id) continue;
      const ledgerId = voucher.ledgerId._id.toString();
      if (ledgerMap.has(ledgerId)) continue;

      const ledger = await Ledger.findById(ledgerId);
      if (!ledger) continue;

      ledgerMap.set(ledgerId, {
        name: voucher.ledgerId.name,
        phoneNumber: voucher.ledgerId.phoneNumber,
        balanceAmount: toNumber(ledger.balances.creditBalance),
        goldFineWeight: toNumber(ledger.balances.goldFineWeight),
        silverFineWeight: toNumber(ledger.balances.silverFineWeight)
      });
    }

    return res.json({
      success: true,
      dueCredits: Array.from(ledgerMap.values()).filter((row) => row.balanceAmount > 0)
    });
  } catch (error) {
    console.error('Get due credits error:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error fetching due credits'
    });
  }
});

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

    return res.json({
      success: true,
      voucher
    });
  } catch (error) {
    console.error('Get voucher error:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error fetching voucher'
    });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const { status, cancelledReason } = req.body;
    if (status !== 'cancelled') {
      return res.status(400).json({
        success: false,
        message: 'Only cancellation is supported via PATCH'
      });
    }

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

    if (voucher.status === 'cancelled') {
      return res.status(400).json({
        success: false,
        message: 'Voucher already cancelled'
      });
    }

    const ledger = await Ledger.findById(voucher.ledgerId);
    if (ledger) {
      await reverseVoucherEffects(voucher, ledger);
      await ledger.save();
    }

    voucher.status = 'cancelled';
    voucher.cancelledReason = cancelledReason || 'Cancelled by user';
    await voucher.save();

    return res.json({
      success: true,
      message: 'Voucher cancelled successfully',
      voucher
    });
  } catch (error) {
    console.error('Cancel voucher error:', error);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Server error cancelling voucher'
    });
  }
});

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
      if (voucher.status !== 'cancelled') {
        await reverseVoucherEffects(voucher, ledger);
      }

      const remainingVouchers = await Voucher.countDocuments({
        ledgerId: voucher.ledgerId,
        _id: { $ne: voucher._id },
        status: 'active'
      });

      if (remainingVouchers === 0) {
        ledger.hasVouchers = false;
      }
      await ledger.save();
    }

    await Voucher.findByIdAndDelete(req.params.id);

    return res.json({
      success: true,
      message: 'Voucher deleted successfully'
    });
  } catch (error) {
    console.error('Delete voucher error:', error);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Server error deleting voucher'
    });
  }
});

module.exports = router;
