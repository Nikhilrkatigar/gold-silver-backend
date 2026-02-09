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

  if (voucher.paymentType === 'credit') {
    voucher.items.forEach((item) => {
      if (item.metalType === 'gold') {
        ledger.balances.goldFineWeight -= toNumber(item.fineWeight);
      } else if (item.metalType === 'silver') {
        ledger.balances.silverFineWeight -= toNumber(item.fineWeight);
      }
    });

    ledger.balances.creditBalance -= toNumber(voucher.total);
    ledger.balances.amount = calculateUnifiedAmount(ledger.balances);

    const fine = getFineByMetal(voucher.items);
    if (fine.gold > 0 || fine.silver > 0) {
      await addBackToStock(voucher.userId, fine.gold, fine.silver);
    }
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
      gstDetails
    } = req.body;

    if (!ledgerId || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Ledger and at least one item are required'
      });
    }

    if (!['cash', 'credit'].includes(paymentType)) {
      return res.status(400).json({
        success: false,
        message: 'paymentType must be either cash or credit'
      });
    }

    const cleanedItems = items.map((item, index) => {
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
        labourRate: Math.max(0, toNumber(item.labourRate)),
        amount: Math.max(0, toNumber(item.amount)),
        hsnCode: item.hsnCode || (item.metalType === 'silver' ? '7106' : '7108')
      };

      if (!cleaned.itemName || !['gold', 'silver'].includes(cleaned.metalType)) {
        throw badRequest(`Invalid item at row ${index + 1}`);
      }
      if (cleaned.grossWeight <= 0 || cleaned.netWeight <= 0 || cleaned.fineWeight < 0) {
        throw badRequest(`Invalid weights at row ${index + 1}`);
      }
      return cleaned;
    });

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

    const totals = cleanedItems.reduce((acc, item) => ({
      pieces: acc.pieces + toNumber(item.pieces),
      grossWeight: acc.grossWeight + toNumber(item.grossWeight),
      lessWeight: acc.lessWeight + toNumber(item.lessWeight),
      netWeight: acc.netWeight + toNumber(item.netWeight),
      melting: acc.melting + toNumber(item.melting),
      wastage: acc.wastage + toNumber(item.wastage),
      fineWeight: acc.fineWeight + toNumber(item.fineWeight),
      labourRate: acc.labourRate + toNumber(item.labourRate),
      amount: acc.amount + toNumber(item.amount)
    }), {
      pieces: 0,
      grossWeight: 0,
      lessWeight: 0,
      netWeight: 0,
      melting: 0,
      wastage: 0,
      fineWeight: 0,
      labourRate: 0,
      amount: 0
    });

    const oldBalance = {
      amount: paymentType === 'cash' ? toNumber(ledger.balances.cashBalance) : toNumber(ledger.balances.creditBalance),
      fineWeight: toNumber(ledger.balances.goldFineWeight) + toNumber(ledger.balances.silverFineWeight)
    };

    const stone = Math.max(0, toNumber(stoneAmount));
    const fineAdj = Math.max(0, toNumber(fineAmount));
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

    const totalBeforeGST = totals.amount + stone + fineAdj;
    const total = totalBeforeGST + toNumber(gstCalc.totalGST);

    const currentBalance = {
      amount: 0,
      netWeight: totals.netWeight
    };

    if (paymentType === 'credit') {
      currentBalance.amount = oldBalance.amount + total;
    } else {
      const shortfall = getCashShortfall(total, cashReceived);
      currentBalance.amount = oldBalance.amount + shortfall;
    }

    deductedFine = getFineByMetal(cleanedItems);
    if (paymentType === 'credit' && (deductedFine.gold > 0 || deductedFine.silver > 0)) {
      await deductFromStock(req.userId, deductedFine.gold, deductedFine.silver);
      stockAdjusted = true;
    }

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

    previousLedgerState = {
      goldFineWeight: toNumber(ledger.balances.goldFineWeight),
      silverFineWeight: toNumber(ledger.balances.silverFineWeight),
      amount: toNumber(ledger.balances.amount),
      cashBalance: toNumber(ledger.balances.cashBalance),
      creditBalance: toNumber(ledger.balances.creditBalance)
    };
    previousHasVouchers = ledger.hasVouchers;

    if (paymentType === 'credit') {
      cleanedItems.forEach((item) => {
        if (item.metalType === 'gold') {
          ledger.balances.goldFineWeight += toNumber(item.fineWeight);
        } else if (item.metalType === 'silver') {
          ledger.balances.silverFineWeight += toNumber(item.fineWeight);
        }
      });

      ledger.balances.creditBalance = currentBalance.amount;
    } else {
      ledger.balances.cashBalance = currentBalance.amount;
    }

    ledger.balances.amount = calculateUnifiedAmount(ledger.balances);
    ledger.hasVouchers = true;
    await ledger.save();

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
      await Voucher.findByIdAndDelete(voucher._id).catch(() => {});
    }

    if (ledger && previousLedgerState) {
      ledger.balances = previousLedgerState;
      ledger.hasVouchers = previousHasVouchers;
      await ledger.save().catch(() => {});
    }

    if (stockAdjusted && (deductedFine.gold > 0 || deductedFine.silver > 0)) {
      await addBackToStock(req.userId, deductedFine.gold, deductedFine.silver).catch(() => {});
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
