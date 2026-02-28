const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
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

const notFound = (message) => {
  const error = new Error(message);
  error.status = 404;
  return error;
};

const supportsTransactions = () => {
  const topologyType = mongoose.connection?.client?.topology?.description?.type;
  return Boolean(topologyType && topologyType !== 'Single');
};

const startOptionalSession = async () => {
  if (!supportsTransactions()) return null;
  const session = await mongoose.startSession();
  session.startTransaction();
  return session;
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

// Signed delta for cash bills:
//   > 0 => customer still has to pay us
//   < 0 => customer has overpaid (credit with us)
const getCashBalanceDelta = (total, cashReceived) => (
  toNumber(total) - toNumber(cashReceived)
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

const hasNonZeroStockAdjustment = (adjustment = {}) => (
  toNumber(adjustment.gold) !== 0 || toNumber(adjustment.silver) !== 0
);

const applyStockAdjustmentForVoucher = async (userId, adjustment = {}, voucherType = 'sale', options = {}) => {
  const { session, reverse = false } = options;
  const gold = toNumber(adjustment.gold);
  const silver = toNumber(adjustment.silver);

  const positiveGold = Math.max(0, gold);
  const positiveSilver = Math.max(0, silver);
  const negativeGold = Math.max(0, -gold);
  const negativeSilver = Math.max(0, -silver);

  const isPurchaseVoucher = voucherType === 'purchase';
  const shouldDeductPositive = reverse ? isPurchaseVoucher : !isPurchaseVoucher;
  const shouldDeductNegative = reverse ? !isPurchaseVoucher : isPurchaseVoucher;

  if (positiveGold > 0 || positiveSilver > 0) {
    if (shouldDeductPositive) {
      await deductFromStock(userId, positiveGold, positiveSilver, { session });
    } else {
      await addBackToStock(userId, positiveGold, positiveSilver, { session });
    }
  }

  if (negativeGold > 0 || negativeSilver > 0) {
    if (shouldDeductNegative) {
      await deductFromStock(userId, negativeGold, negativeSilver, { session });
    } else {
      await addBackToStock(userId, negativeGold, negativeSilver, { session });
    }
  }
};

const BILLING_TYPES = ['cash', 'credit'];
const SETTLEMENT_TYPES = ['add_cash', 'add_gold', 'add_silver', 'money_to_gold', 'money_to_silver'];
const ALLOWED_TYPES = [...BILLING_TYPES, ...SETTLEMENT_TYPES];

const usesStockAdjustment = (paymentType) => BILLING_TYPES.includes(paymentType);

const getReversalWindowHours = () => {
  const configured = toNumber(CONSTANTS.REVERSAL_POLICY?.WINDOW_HOURS, 48);
  return configured > 0 ? configured : 48;
};

const canReverseForVoucher = (voucher) => {
  const referenceDate = voucher?.createdAt ? new Date(voucher.createdAt) : null;
  const referenceTime = referenceDate?.getTime();
  if (!Number.isFinite(referenceTime)) return false;

  const elapsedMs = Date.now() - referenceTime;
  const allowedMs = getReversalWindowHours() * 60 * 60 * 1000;
  return elapsedMs <= allowedMs;
};

const getVoucherStockAdjustment = (voucher) => {
  const explicitGold = toNumber(voucher?.stockAdjustment?.gold, null);
  const explicitSilver = toNumber(voucher?.stockAdjustment?.silver, null);

  if (explicitGold !== null || explicitSilver !== null) {
    return {
      gold: explicitGold ?? 0,
      silver: explicitSilver ?? 0
    };
  }

  if (!usesStockAdjustment(voucher?.paymentType)) {
    return { gold: 0, silver: 0 };
  }

  return getFineByMetal(voucher?.items || []);
};

const reverseVoucherEffects = async (voucher, ledger, options = {}) => {
  const { session, restoreStock = true, markRestored = false } = options;
  if (!voucher || !ledger) return;

  const stockAdjustment = getVoucherStockAdjustment(voucher);
  const shouldRestoreStock = restoreStock
    && !voucher.stockRestored
    && hasNonZeroStockAdjustment(stockAdjustment);

  if (shouldRestoreStock) {
    await applyStockAdjustmentForVoucher(
      voucher.userId,
      stockAdjustment,
      voucher.voucherType || 'sale',
      { session, reverse: true }
    );
    if (markRestored) {
      voucher.stockRestored = true;
    }
  }

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
    const balanceDelta = getCashBalanceDelta(voucher.total, voucher.cashReceived);
    ledger.balances.cashBalance -= balanceDelta;
    ledger.balances.amount = calculateUnifiedAmount(ledger.balances);
  }
};

router.use(auth);
router.use(checkLicense);

router.post('/', async (req, res) => {
  const session = await startOptionalSession();
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
      balanceSnapshot: incomingBalanceSnapshot,
      voucherType = 'sale'   // 'sale' (default) or 'purchase' (old gold buy/exchange)
    } = req.body;

    // Validate voucherType
    if (!['sale', 'purchase'].includes(voucherType)) {
      throw badRequest('Invalid voucherType. Must be sale or purchase');
    }

    const isSettlementType = SETTLEMENT_TYPES.includes(paymentType);

    // Validate ledgerId is always required
    if (!ledgerId) {
      throw badRequest('Ledger is required');
    }

    // Validate paymentType
    if (!ALLOWED_TYPES.includes(paymentType)) {
      throw badRequest('Invalid paymentType');
    }

    // For non-settlement types, items are required
    if (!isSettlementType) {
      if (!Array.isArray(items) || items.length === 0) {
        throw badRequest('At least one item is required for this payment type');
      }
    }

    let cleanedItems = [];
    if (BILLING_TYPES.includes(paymentType)) {
      cleanedItems = items.map((item, index) => {
        const cleaned = {
          sourceItemId: mongoose.Types.ObjectId.isValid(item.sourceItemId) ? item.sourceItemId : undefined,
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

    const ledger = await Ledger.findOne({
      _id: ledgerId,
      userId: req.userId
    }).session(session);
    if (!ledger) {
      throw notFound('Ledger not found');
    }

    const user = await User.findById(req.userId).session(session);
    if (!user) {
      throw notFound('User not found');
    }

    const normalizedInvoiceNumber = invoiceNumber ? String(invoiceNumber).trim() : '';
    if (normalizedInvoiceNumber) {
      const existingInvoice = await Voucher.findOne({
        userId: req.userId,
        invoiceNumber: normalizedInvoiceNumber,
        status: 'active'
      }).session(session);
      if (existingInvoice) {
        throw badRequest(CONSTANTS.ERROR_MESSAGES.DUPLICATE_INVOICE);
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
    }).session(session);
    if (duplicateVoucher) {
      throw badRequest('Voucher number already exists');
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
    if (BILLING_TYPES.includes(paymentType)) {
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
    if (SETTLEMENT_TYPES.includes(paymentType)) {
      total = toNumber(cashReceived);
    }

    let currentBalance = {
      amount: 0,
      netWeight: totals.netWeight
    };
    if (paymentType === 'credit') {
      if (voucherType === 'purchase') {
        // Purchase on credit: shop receives goods from customer, owes them money
        // Negative balance = shop owes customer
        currentBalance.amount = oldBalance.amount - total;
      } else {
        // Sale on credit: customer takes goods, owes us money
        // Positive balance = customer owes shop
        currentBalance.amount = oldBalance.amount + total;
      }
    } else if (paymentType === 'cash') {
      if (voucherType === 'purchase') {
        // Purchase: shop receives goods worth `total`, paid `cashReceived` to customer already
        // Remaining balance (total - cashReceived) is what shop still owes customer → negative delta
        const balanceDelta = -(toNumber(total) - toNumber(cashReceived));
        currentBalance.amount = oldBalance.amount + balanceDelta;
      } else {
        // Sale: customer owes shop for goods minus what they've paid
        const balanceDelta = getCashBalanceDelta(total, cashReceived);
        currentBalance.amount = oldBalance.amount + balanceDelta;
      }
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

    let stockAdjustment = { gold: 0, silver: 0 };
    // Only adjust bulk stock if user is NOT in item mode
    if (user.stockMode !== 'item' && usesStockAdjustment(paymentType)) {
      stockAdjustment = getFineByMetal(cleanedItems);
      if (hasNonZeroStockAdjustment(stockAdjustment)) {
        await applyStockAdjustmentForVoucher(req.userId, stockAdjustment, voucherType, { session });
      }
    }

    const stockAdjusted = hasNonZeroStockAdjustment(stockAdjustment);
    const oldCreditAmount = toNumber(ledger.balances.creditBalance);
    const oldCashAmount = toNumber(ledger.balances.cashBalance);
    const oldGoldFineWeight = toNumber(ledger.balances.goldFineWeight);
    const oldSilverFineWeight = toNumber(ledger.balances.silverFineWeight);

    let currentGoldFineWeight = oldGoldFineWeight;
    let currentSilverFineWeight = oldSilverFineWeight;

    if (paymentType === 'credit') {
      if (voucherType === 'purchase') {
        // Purchase on credit: customer gives us fine metal → reduces what they're owed
        // (from shop's perspective: shop received metal, not the other way)
        cleanedItems.forEach((item) => {
          if (item.metalType === 'gold') currentGoldFineWeight -= toNumber(item.fineWeight);
          else if (item.metalType === 'silver') currentSilverFineWeight -= toNumber(item.fineWeight);
        });
      } else {
        // Sale on credit: customer owes us fine metal
        currentGoldFineWeight += stockAdjustment.gold;
        currentSilverFineWeight += stockAdjustment.silver;
      }
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
      ? (voucherType === 'purchase'
        ? (oldCreditAmount + oldCashAmount - total)
        : (oldCreditAmount + oldCashAmount + total))
      : paymentType === 'cash'
        ? (voucherType === 'purchase'
          ? (oldCashAmount - (toNumber(total) - toNumber(cashReceived)))
          : (oldCashAmount + getCashBalanceDelta(total, cashReceived)))
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

    const previousLedgerState = {
      goldFineWeight: toNumber(ledger.balances.goldFineWeight),
      silverFineWeight: toNumber(ledger.balances.silverFineWeight),
      amount: toNumber(ledger.balances.amount),
      cashBalance: toNumber(ledger.balances.cashBalance),
      creditBalance: toNumber(ledger.balances.creditBalance)
    };

    const voucher = new Voucher({
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
        : null,
      previousLedgerState,
      stockAdjusted,
      stockAdjustment,
      voucherType,
      stockRestored: false
    });

    // Skip balance updates for GST invoices or GST-type ledgers
    if (invoiceType !== 'gst' && ledger.ledgerType !== 'gst') {
      if (paymentType === 'credit') {
        cleanedItems.forEach((item) => {
          if (item.metalType === 'gold') {
            if (voucherType === 'purchase') {
              // Purchase: shop received gold from customer → store's gold increased, customer's owed fine DECREASES
              ledger.balances.goldFineWeight -= toNumber(item.fineWeight);
            } else {
              // Sale: customer owes us gold fine
              ledger.balances.goldFineWeight += toNumber(item.fineWeight);
            }
          } else if (item.metalType === 'silver') {
            if (voucherType === 'purchase') {
              ledger.balances.silverFineWeight -= toNumber(item.fineWeight);
            } else {
              ledger.balances.silverFineWeight += toNumber(item.fineWeight);
            }
          }
        });
        // Credit bills update cashBalance
        ledger.balances.cashBalance = currentBalance.amount;
      } else if (paymentType === 'cash') {
        ledger.balances.cashBalance = currentBalance.amount;
      } else if (paymentType === 'add_cash') {
        // For add_cash, determine which balance to update based on which one is being used
        if (toNumber(ledger.balances.cashBalance) !== 0 || toNumber(ledger.balances.creditBalance) === 0) {
          ledger.balances.cashBalance = currentBalance.amount;
        } else {
          ledger.balances.creditBalance = currentBalance.amount;
        }
      } else if (paymentType === 'add_gold') {
        // Customer gives gold to settle debt - reduces gold owed
        ledger.balances.goldFineWeight -= toNumber(cashReceived);
      } else if (paymentType === 'add_silver') {
        // Customer gives silver to settle debt - reduces silver owed
        ledger.balances.silverFineWeight -= toNumber(cashReceived);
      } else if (paymentType === 'money_to_gold') {
        // Customer pays cash to settle gold fine debt - reduces gold owed
        ledger.balances.goldFineWeight -= (toNumber(cashReceived) / (toNumber(goldRate) || 1));
      } else if (paymentType === 'money_to_silver') {
        // Customer pays cash to settle silver fine debt - reduces silver owed
        ledger.balances.silverFineWeight -= (toNumber(cashReceived) / (toNumber(silverRate) || 1));
      }
      ledger.balances.amount = calculateUnifiedAmount(ledger.balances);
    }

    ledger.hasVouchers = true;
    await ledger.save({ session });
    await voucher.save({ session });

    if (shouldAutoIncrement) {
      user.voucherSettings.currentVoucherNumber = toNumber(user.voucherSettings.currentVoucherNumber, 1) + 1;
      await user.save({ session });
    }

    if (session?.inTransaction()) {
      await session.commitTransaction();
    }

    return res.status(201).json({
      success: true,
      message: 'Voucher created successfully',
      voucher
    });
  } catch (error) {
    if (session?.inTransaction()) {
      await session.abortTransaction();
    }
    console.error('Create voucher error:', error);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Server error creating voucher'
    });
  } finally {
    if (session) {
      await session.endSession();
    }
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
    const dueDays = toNumber(CONSTANTS.CREDIT_PAYMENT?.DUE_DAYS, 5);
    const msPerDay = 24 * 60 * 60 * 1000;
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const endOfToday = new Date(startOfToday);
    endOfToday.setHours(23, 59, 59, 999);

    // Build earliest due date per ledger from active credit vouchers.
    const creditVouchers = await Voucher.find({
      userId: req.userId,
      paymentType: 'credit',
      status: 'active',
      invoiceType: { $ne: 'gst' }
    }).select('ledgerId date creditDueDate').lean();

    const dueDateByLedger = new Map();
    for (const voucher of creditVouchers) {
      if (!voucher?.ledgerId) continue;

      let dueDate = voucher.creditDueDate ? new Date(voucher.creditDueDate) : null;
      if (!dueDate || Number.isNaN(dueDate.getTime())) {
        const baseDate = voucher.date ? new Date(voucher.date) : null;
        if (!baseDate || Number.isNaN(baseDate.getTime())) continue;
        dueDate = new Date(baseDate);
        dueDate.setDate(dueDate.getDate() + dueDays);
      }

      const ledgerId = String(voucher.ledgerId);
      const existing = dueDateByLedger.get(ledgerId);
      if (!existing || dueDate.getTime() < existing.getTime()) {
        dueDateByLedger.set(ledgerId, dueDate);
      }
    }

    // Evaluate all regular ledgers (including older ledgers with missing ledgerType).
    const ledgers = await Ledger.find({
      userId: req.userId,
      ledgerType: { $ne: 'gst' }
    }).select('name phoneNumber balances openingBalance createdAt').lean();

    const dueCredits = [];
    for (const ledger of ledgers) {
      const ledgerId = String(ledger._id);

      // Prefer credit voucher due date. If none, fall back to opening balance age.
      let dueDate = dueDateByLedger.get(ledgerId);
      if (!dueDate) {
        const openingAmount = toNumber(ledger?.openingBalance?.amount);
        const openingGold = toNumber(ledger?.openingBalance?.goldFineWeight);
        const openingSilver = toNumber(ledger?.openingBalance?.silverFineWeight);
        const hasOpeningBalance = openingAmount > 0 || openingGold > 0 || openingSilver > 0;
        if (!hasOpeningBalance) continue;

        const baseDate = ledger.createdAt ? new Date(ledger.createdAt) : null;
        if (!baseDate || Number.isNaN(baseDate.getTime())) continue;
        dueDate = new Date(baseDate);
        dueDate.setDate(dueDate.getDate() + dueDays);
      }

      if (dueDate.getTime() > endOfToday.getTime()) continue;

      const cashBalance = toNumber(ledger?.balances?.cashBalance);
      const creditBalance = toNumber(ledger?.balances?.creditBalance);
      const balanceAmount = cashBalance + creditBalance;
      const goldFineWeight = toNumber(ledger?.balances?.goldFineWeight);
      const silverFineWeight = toNumber(ledger?.balances?.silverFineWeight);

      // Auto-remove from due list once all dues are cleared.
      if (balanceAmount <= 0 && goldFineWeight <= 0 && silverFineWeight <= 0) continue;

      const dueDateStart = new Date(dueDate);
      dueDateStart.setHours(0, 0, 0, 0);
      const daysOverdue = Math.max(0, Math.floor((startOfToday.getTime() - dueDateStart.getTime()) / msPerDay));

      dueCredits.push({
        ledgerId,
        name: ledger.name,
        phoneNumber: ledger.phoneNumber || '',
        balanceAmount,
        goldFineWeight,
        silverFineWeight,
        dueDate,
        daysOverdue
      });
    }

    return res.json({
      success: true,
      dueCredits: dueCredits.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate))
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

router.put('/:id', async (req, res) => {
  const session = await startOptionalSession();
  try {
    const existingVoucher = await Voucher.findOne({
      _id: req.params.id,
      userId: req.userId
    }).session(session);

    if (!existingVoucher) {
      return res.status(404).json({
        success: false,
        message: 'Voucher not found'
      });
    }

    if (existingVoucher.status === 'cancelled') {
      throw badRequest('Cancelled vouchers cannot be edited');
    }

    if (!canReverseForVoucher(existingVoucher)) {
      throw badRequest(`Voucher cannot be edited after ${getReversalWindowHours()} hours`);
    }

    const previousLedger = await Ledger.findOne({
      _id: existingVoucher.ledgerId,
      userId: req.userId
    }).session(session);

    if (!previousLedger) {
      throw notFound('Existing voucher ledger not found');
    }

    // Undo old voucher effects first so update is applied on a clean base state.
    await reverseVoucherEffects(existingVoucher, previousLedger, {
      session,
      restoreStock: true,
      markRestored: false
    });
    await previousLedger.save({ session });

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
      balanceSnapshot: incomingBalanceSnapshot,
      voucherType = existingVoucher.voucherType || 'sale'
    } = req.body;

    const isSettlementType = SETTLEMENT_TYPES.includes(paymentType);
    if (!ledgerId) {
      throw badRequest('Ledger is required');
    }
    if (!ALLOWED_TYPES.includes(paymentType)) {
      throw badRequest('Invalid paymentType');
    }
    if (!['sale', 'purchase'].includes(voucherType)) {
      throw badRequest('Invalid voucherType. Must be sale or purchase');
    }
    if (!isSettlementType && (!Array.isArray(items) || items.length === 0)) {
      throw badRequest('At least one item is required for this payment type');
    }

    let cleanedItems = [];
    if (BILLING_TYPES.includes(paymentType)) {
      cleanedItems = items.map((item, index) => {
        const cleaned = {
          sourceItemId: mongoose.Types.ObjectId.isValid(item.sourceItemId) ? item.sourceItemId : undefined,
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
        return cleaned;
      });
    }

    const targetLedger = String(previousLedger._id) === String(ledgerId)
      ? previousLedger
      : await Ledger.findOne({
        _id: ledgerId,
        userId: req.userId
      }).session(session);
    if (!targetLedger) {
      throw notFound('Ledger not found');
    }

    const normalizedInvoiceNumber = invoiceNumber ? String(invoiceNumber).trim() : '';
    if (normalizedInvoiceNumber) {
      const existingInvoice = await Voucher.findOne({
        userId: req.userId,
        invoiceNumber: normalizedInvoiceNumber,
        status: 'active',
        _id: { $ne: existingVoucher._id }
      }).session(session);
      if (existingInvoice) {
        throw badRequest(CONSTANTS.ERROR_MESSAGES.DUPLICATE_INVOICE);
      }
    }

    const finalVoucherNumber = String(voucherNumber || existingVoucher.voucherNumber || '').trim();
    if (!finalVoucherNumber) {
      throw badRequest('Voucher number is required');
    }

    const duplicateVoucher = await Voucher.findOne({
      userId: req.userId,
      voucherNumber: finalVoucherNumber,
      status: 'active',
      _id: { $ne: existingVoucher._id }
    }).session(session);
    if (duplicateVoucher) {
      throw badRequest('Voucher number already exists');
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
    if (BILLING_TYPES.includes(paymentType)) {
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
      amount: paymentType === 'cash' ? toNumber(targetLedger.balances.cashBalance)
        : paymentType === 'credit' ? toNumber(targetLedger.balances.cashBalance)
          : paymentType === 'add_cash' ? (toNumber(targetLedger.balances.cashBalance) || toNumber(targetLedger.balances.creditBalance))
            : paymentType === 'money_to_gold' || paymentType === 'money_to_silver' ? (toNumber(targetLedger.balances.cashBalance) || toNumber(targetLedger.balances.creditBalance))
              : toNumber(targetLedger.balances.cashBalance),
      fineWeight: toNumber(targetLedger.balances.goldFineWeight) + toNumber(targetLedger.balances.silverFineWeight)
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
    if (SETTLEMENT_TYPES.includes(paymentType)) {
      total = toNumber(cashReceived);
    }

    let currentBalance = {
      amount: 0,
      netWeight: totals.netWeight
    };
    if (paymentType === 'credit') {
      if (voucherType === 'purchase') {
        currentBalance.amount = oldBalance.amount - total;
      } else {
        currentBalance.amount = oldBalance.amount + total;
      }
    } else if (paymentType === 'cash') {
      const balanceDelta = voucherType === 'purchase'
        ? -(toNumber(total) - toNumber(cashReceived))
        : getCashBalanceDelta(total, cashReceived);
      currentBalance.amount = oldBalance.amount + balanceDelta;
    } else if (paymentType === 'add_cash') {
      currentBalance.amount = oldBalance.amount - total;
    } else if (paymentType === 'add_gold') {
      currentBalance.amount = oldBalance.amount;
    } else if (paymentType === 'add_silver') {
      currentBalance.amount = oldBalance.amount;
    } else if (paymentType === 'money_to_gold' || paymentType === 'money_to_silver') {
      currentBalance.amount = oldBalance.amount - total;
    }

    // Fetch user to check stockMode
    const voucherUser = await User.findById(req.userId).session(session);
    if (!voucherUser) {
      throw notFound('User not found');
    }

    let stockAdjustment = { gold: 0, silver: 0 };
    // Item mode tracks items individually, not bulk stock
    if (voucherUser.stockMode !== 'item' && usesStockAdjustment(paymentType)) {
      stockAdjustment = getFineByMetal(cleanedItems);
      if (hasNonZeroStockAdjustment(stockAdjustment)) {
        await applyStockAdjustmentForVoucher(req.userId, stockAdjustment, voucherType, { session });
      }
    }

    const stockAdjusted = hasNonZeroStockAdjustment(stockAdjustment);
    const oldCreditAmount = toNumber(targetLedger.balances.creditBalance);
    const oldCashAmount = toNumber(targetLedger.balances.cashBalance);
    const oldGoldFineWeight = toNumber(targetLedger.balances.goldFineWeight);
    const oldSilverFineWeight = toNumber(targetLedger.balances.silverFineWeight);

    let currentGoldFineWeight = oldGoldFineWeight;
    let currentSilverFineWeight = oldSilverFineWeight;

    if (paymentType === 'credit') {
      if (voucherType === 'purchase') {
        cleanedItems.forEach((item) => {
          if (item.metalType === 'gold') currentGoldFineWeight -= toNumber(item.fineWeight);
          else if (item.metalType === 'silver') currentSilverFineWeight -= toNumber(item.fineWeight);
        });
      } else {
        currentGoldFineWeight += stockAdjustment.gold;
        currentSilverFineWeight += stockAdjustment.silver;
      }
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
      ? (voucherType === 'purchase'
        ? (oldCreditAmount + oldCashAmount - total)
        : (oldCreditAmount + oldCashAmount + total))
      : paymentType === 'cash'
        ? (voucherType === 'purchase'
          ? (oldCashAmount - (toNumber(total) - toNumber(cashReceived)))
          : (oldCashAmount + getCashBalanceDelta(total, cashReceived)))
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

    const previousLedgerState = {
      goldFineWeight: toNumber(targetLedger.balances.goldFineWeight),
      silverFineWeight: toNumber(targetLedger.balances.silverFineWeight),
      amount: toNumber(targetLedger.balances.amount),
      cashBalance: toNumber(targetLedger.balances.cashBalance),
      creditBalance: toNumber(targetLedger.balances.creditBalance)
    };

    if (invoiceType !== 'gst' && targetLedger.ledgerType !== 'gst') {
      if (paymentType === 'credit') {
        cleanedItems.forEach((item) => {
          if (item.metalType === 'gold') {
            if (voucherType === 'purchase') {
              targetLedger.balances.goldFineWeight -= toNumber(item.fineWeight);
            } else {
              targetLedger.balances.goldFineWeight += toNumber(item.fineWeight);
            }
          } else if (item.metalType === 'silver') {
            if (voucherType === 'purchase') {
              targetLedger.balances.silverFineWeight -= toNumber(item.fineWeight);
            } else {
              targetLedger.balances.silverFineWeight += toNumber(item.fineWeight);
            }
          }
        });
        targetLedger.balances.cashBalance = currentBalance.amount;
      } else if (paymentType === 'cash') {
        targetLedger.balances.cashBalance = currentBalance.amount;
      } else if (paymentType === 'add_cash') {
        if (toNumber(targetLedger.balances.cashBalance) !== 0 || toNumber(targetLedger.balances.creditBalance) === 0) {
          targetLedger.balances.cashBalance = currentBalance.amount;
        } else {
          targetLedger.balances.creditBalance = currentBalance.amount;
        }
      } else if (paymentType === 'add_gold') {
        targetLedger.balances.goldFineWeight -= toNumber(cashReceived);
      } else if (paymentType === 'add_silver') {
        targetLedger.balances.silverFineWeight -= toNumber(cashReceived);
      } else if (paymentType === 'money_to_gold') {
        targetLedger.balances.goldFineWeight -= (toNumber(cashReceived) / (toNumber(goldRate) || 1));
      } else if (paymentType === 'money_to_silver') {
        targetLedger.balances.silverFineWeight -= (toNumber(cashReceived) / (toNumber(silverRate) || 1));
      }
      targetLedger.balances.amount = calculateUnifiedAmount(targetLedger.balances);
    }

    targetLedger.hasVouchers = true;

    if (String(previousLedger._id) !== String(targetLedger._id)) {
      const remainingOnPrevious = await Voucher.countDocuments({
        ledgerId: previousLedger._id,
        _id: { $ne: existingVoucher._id },
        status: 'active'
      }).session(session);
      previousLedger.hasVouchers = remainingOnPrevious > 0;
      await previousLedger.save({ session });
    }

    existingVoucher.set({
      voucherNumber: finalVoucherNumber,
      userId: req.userId,
      ledgerId,
      customerName: targetLedger.name,
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
        : null,
      previousLedgerState,
      stockAdjusted,
      stockAdjustment,
      voucherType,
      stockRestored: false,
      status: 'active',
      cancelledReason: undefined
    });

    await targetLedger.save({ session });
    await existingVoucher.save({ session });
    if (session?.inTransaction()) {
      await session.commitTransaction();
    }

    return res.json({
      success: true,
      message: 'Voucher updated successfully',
      voucher: existingVoucher
    });
  } catch (error) {
    if (session?.inTransaction()) {
      await session.abortTransaction();
    }
    console.error('Update voucher error:', error);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Server error updating voucher'
    });
  } finally {
    if (session) {
      await session.endSession();
    }
  }
});

router.patch('/:id', async (req, res) => {
  const session = await startOptionalSession();
  try {
    const { status, cancelledReason } = req.body;
    if (status !== 'cancelled') {
      throw badRequest('Only cancellation is supported via PATCH');
    }

    const voucher = await Voucher.findOne({
      _id: req.params.id,
      userId: req.userId
    }).session(session);
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

    const canReverse = canReverseForVoucher(voucher);

    const ledger = await Ledger.findById(voucher.ledgerId).session(session);
    if (ledger && canReverse) {
      await reverseVoucherEffects(voucher, ledger, { session, restoreStock: true, markRestored: true });

      const remainingVouchers = await Voucher.countDocuments({
        ledgerId: voucher.ledgerId,
        _id: { $ne: voucher._id },
        status: 'active'
      }).session(session);

      if (remainingVouchers === 0) {
        ledger.hasVouchers = false;
      }
      await ledger.save({ session });
    }

    voucher.status = 'cancelled';
    voucher.cancelledReason = cancelledReason || 'Cancelled by user';
    await voucher.save({ session });

    if (session?.inTransaction()) {
      await session.commitTransaction();
    }

    return res.json({
      success: true,
      message: canReverse
        ? 'Voucher cancelled successfully'
        : `Voucher cancelled without reversal (older than ${getReversalWindowHours()} hours)`,
      voucher
    });
  } catch (error) {
    if (session?.inTransaction()) {
      await session.abortTransaction();
    }
    console.error('Cancel voucher error:', error);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Server error cancelling voucher'
    });
  } finally {
    if (session) {
      await session.endSession();
    }
  }
});

router.delete('/:id', async (req, res) => {
  const session = await startOptionalSession();
  try {
    const voucher = await Voucher.findOne({
      _id: req.params.id,
      userId: req.userId
    }).session(session);

    if (!voucher) {
      return res.status(404).json({
        success: false,
        message: 'Voucher not found'
      });
    }

    const canReverse = canReverseForVoucher(voucher);

    const ledger = await Ledger.findById(voucher.ledgerId).session(session);
    if (ledger) {
      if (canReverse && voucher.status !== 'cancelled') {
        await reverseVoucherEffects(voucher, ledger, { session, restoreStock: true, markRestored: false });
      } else if (canReverse && !voucher.stockRestored) {
        const adjustment = getVoucherStockAdjustment(voucher);
        if (hasNonZeroStockAdjustment(adjustment)) {
          await applyStockAdjustmentForVoucher(
            voucher.userId,
            adjustment,
            voucher.voucherType || 'sale',
            { session, reverse: true }
          );
        }
      }

      const remainingVouchers = await Voucher.countDocuments({
        ledgerId: voucher.ledgerId,
        _id: { $ne: voucher._id },
        status: 'active'
      }).session(session);

      if (remainingVouchers === 0) {
        ledger.hasVouchers = false;
      }
      await ledger.save({ session });
    }

    await Voucher.findByIdAndDelete(req.params.id).session(session);

    if (session?.inTransaction()) {
      await session.commitTransaction();
    }

    return res.json({
      success: true,
      message: canReverse
        ? 'Voucher deleted successfully'
        : `Voucher deleted without reversal (older than ${getReversalWindowHours()} hours)`
    });
  } catch (error) {
    if (session?.inTransaction()) {
      await session.abortTransaction();
    }
    console.error('Delete voucher error:', error);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Server error deleting voucher'
    });
  } finally {
    if (session) {
      await session.endSession();
    }
  }
});

module.exports = router;
