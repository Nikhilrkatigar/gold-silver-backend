const express = require('express');
const router = express.Router();
const Ledger = require('../models/Ledger');
const Voucher = require('../models/Voucher');
const Settlement = require('../models/Settlement');
const { addBackToStock, deductFromStock } = require('./stock');
const { auth, checkLicense, isAdmin } = require('../middleware/auth');
const { toNumber, sanitizePhone, calculateUnifiedAmount, parsePagination, paginationMeta } = require('../utils/helpers');
const { applyVoucherToBalances, applySettlementToBalances, settlementEffect } = require('../utils/voucherBalance');


const resetBalances = () => ({
  goldFineWeight: 0,
  silverFineWeight: 0,
  amount: 0,
  cashBalance: 0,
  creditBalance: 0
});

const getOpeningMetalBalances = (openingBalance = {}) => ({
  goldFineWeight: toNumber(openingBalance.goldFineWeight),
  silverFineWeight: toNumber(openingBalance.silverFineWeight)
});

const syncOpeningBalanceStock = async (userId, previousOpeningBalance = {}, nextOpeningBalance = {}) => {
  const previousMetal = getOpeningMetalBalances(previousOpeningBalance);
  const nextMetal = getOpeningMetalBalances(nextOpeningBalance);

  const goldDelta = nextMetal.goldFineWeight - previousMetal.goldFineWeight;
  const silverDelta = nextMetal.silverFineWeight - previousMetal.silverFineWeight;

  if (goldDelta === 0 && silverDelta === 0) {
    return;
  }

  if (goldDelta > 0 || silverDelta > 0) {
    await addBackToStock(userId, Math.max(0, goldDelta), Math.max(0, silverDelta));
  }

  if (goldDelta < 0 || silverDelta < 0) {
    await deductFromStock(userId, Math.max(0, -goldDelta), Math.max(0, -silverDelta));
  }
};

router.use(auth);
router.use(checkLicense);

router.post('/', async (req, res) => {
  try {
    const { name, gstDetails, ledgerType, openingBalance } = req.body;
    const phoneNumber = sanitizePhone(req.body.phoneNumber);

    if (!name) {
      return res.status(400).json({
        success: false,
        message: 'Name is required'
      });
    }

    // Only validate phone number format if provided
    if (phoneNumber && !/^[0-9]{10}$/.test(phoneNumber)) {
      return res.status(400).json({
        success: false,
        message: 'Phone number must be 10 digits'
      });
    }

    // Accept both the nested openingBalance payload and legacy oldBal* fields.
    const incomingOpeningBalance = openingBalance ?? (
      req.body.oldBalAmount !== undefined ||
        req.body.oldBalGold !== undefined ||
        req.body.oldBalSilver !== undefined
        ? {
          amount: req.body.oldBalAmount,
          goldFineWeight: req.body.oldBalGold,
          silverFineWeight: req.body.oldBalSilver
        }
        : undefined
    );

    // Parse opening balance values
    const obAmount = toNumber(incomingOpeningBalance?.amount);
    const obGold = toNumber(incomingOpeningBalance?.goldFineWeight);
    const obSilver = toNumber(incomingOpeningBalance?.silverFineWeight);

    const ledger = new Ledger({
      name: name.trim(),
      phoneNumber: phoneNumber || '',
      userId: req.userId,
      ledgerType: ledgerType || 'regular',
      ...(gstDetails && {
        gstDetails: {
          hasGST: !!gstDetails.hasGST,
          gstNumber: gstDetails.gstNumber || undefined,
          stateCode: gstDetails.stateCode || undefined
        }
      }),
      openingBalance: {
        amount: obAmount,
        goldFineWeight: obGold,
        silverFineWeight: obSilver
      },
      // Initialize balances to match opening balance
      balances: {
        goldFineWeight: obGold,
        silverFineWeight: obSilver,
        amount: obAmount,
        cashBalance: obAmount,
        creditBalance: 0
      }
    });

    await ledger.save();

    if (ledger.ledgerType !== 'gst') {
      await syncOpeningBalanceStock(req.userId, {}, {
        goldFineWeight: obGold,
        silverFineWeight: obSilver
      });
    }

    return res.status(201).json({
      success: true,
      message: 'Ledger created successfully',
      ledger
    });
  } catch (error) {
    console.error('Create ledger error:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error creating ledger'
    });
  }
});

router.get('/', async (req, res) => {
  try {
    const { type } = req.query;
    const filter = { userId: req.userId };

    // Filter by ledger type if specified
    if (type && ['regular', 'gst'].includes(type)) {
      if (type === 'regular') {
        // For regular ledgers: include both 'regular' and undefined (for backward compatibility)
        filter.$or = [
          { ledgerType: 'regular' },
          { ledgerType: { $exists: false } }
        ];
      } else {
        // For GST ledgers: only 'gst' type
        filter.ledgerType = 'gst';
      }
    }

    const ledgers = await Ledger.find(filter).sort({ name: 1 });

    return res.json({
      success: true,
      ledgers,
      total: ledgers.length
    });
  } catch (error) {
    console.error('Get ledgers error:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error fetching ledgers'
    });
  }
});

// Migration: Fix ledgers without ledgerType (admin-only endpoint)
router.post('/migrate/fix-ledger-types', isAdmin, async (req, res) => {
  try {
    console.log('🔧 Starting ledger migration...');

    // Update all ledgers without ledgerType to 'regular'
    const result = await Ledger.updateMany(
      {
        userId: req.userId,
        $or: [
          { ledgerType: { $exists: false } },
          { ledgerType: null }
        ]
      },
      { ledgerType: 'regular' }
    );

    console.log('✅ Migration complete:', result);

    return res.json({
      success: true,
      message: 'Migration completed',
      details: {
        matchedCount: result.matchedCount,
        modifiedCount: result.modifiedCount
      }
    });
  } catch (error) {
    console.error('Migration error:', error);
    return res.status(500).json({
      success: false,
      message: 'Migration failed',
      error: error.message
    });
  }
});

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

    return res.json({
      success: true,
      ledger
    });
  } catch (error) {
    console.error('Get ledger error:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error fetching ledger'
    });
  }
});

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

    const voucherQuery = {
      userId: req.userId,
      ledgerId: req.params.id
    };

    // Filter vouchers by invoice type based on ledger type
    // For GST ledgers: only show 'gst' invoices
    // For regular ledgers (or undefined/old ledgers): show 'normal' invoices OR undefined
    if (ledger.ledgerType === 'gst') {
      voucherQuery.invoiceType = 'gst';
    } else {
      // Regular ledger or old ledger without type - show non-GST invoices
      voucherQuery.invoiceType = { $ne: 'gst' };
    }

    const settlementQuery = {
      userId: req.userId,
      ledgerId: req.params.id
    };

    if (startDate || endDate) {
      const dateQuery = {};
      if (startDate) dateQuery.$gte = new Date(startDate);
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        dateQuery.$lte = end;
      }
      voucherQuery.date = dateQuery;
      settlementQuery.date = dateQuery;
    }

    const vouchers = await Voucher.find(voucherQuery).sort({ date: -1 });
    const settlements = await Settlement.find(settlementQuery).sort({ date: -1 });

    const transactions = [
      ...vouchers.map((v) => ({ ...v.toObject(), type: 'voucher' })),
      ...settlements.map((s) => ({ ...s.toObject(), type: 'settlement' }))
    ].sort((a, b) => new Date(b.date) - new Date(a.date));

    return res.json({
      success: true,
      ledger,
      transactions
    });
  } catch (error) {
    console.error('Get transactions error:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error fetching transactions'
    });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const updates = {};
    const { name, gstDetails, ledgerType } = req.body;
    const phoneNumber = req.body.phoneNumber ? sanitizePhone(req.body.phoneNumber) : undefined;
    const existingLedger = await Ledger.findOne({
      _id: req.params.id,
      userId: req.userId
    });

    if (!existingLedger) {
      return res.status(404).json({
        success: false,
        message: 'Ledger not found'
      });
    }

    if (name !== undefined) updates.name = name.trim();

    if (phoneNumber !== undefined) {
      // Allow empty phone number or validate 10 digits
      if (phoneNumber && !/^[0-9]{10}$/.test(phoneNumber)) {
        return res.status(400).json({
          success: false,
          message: 'Phone number must be 10 digits'
        });
      }
      updates.phoneNumber = phoneNumber || '';
    }

    if (ledgerType !== undefined && ['regular', 'gst'].includes(ledgerType)) {
      updates.ledgerType = ledgerType;
    }

    if (gstDetails) {
      updates.gstDetails = {
        hasGST: !!gstDetails.hasGST,
        gstNumber: gstDetails.gstNumber || undefined,
        stateCode: gstDetails.stateCode || undefined
      };
    }

    // Allow updating opening balance
    const incomingOpeningBalance = req.body.openingBalance ?? (
      req.body.oldBalAmount !== undefined ||
        req.body.oldBalGold !== undefined ||
        req.body.oldBalSilver !== undefined
        ? {
          amount: req.body.oldBalAmount,
          goldFineWeight: req.body.oldBalGold,
          silverFineWeight: req.body.oldBalSilver
        }
        : undefined
    );

    if (incomingOpeningBalance !== undefined) {
      updates.openingBalance = {
        amount: toNumber(incomingOpeningBalance.amount),
        goldFineWeight: toNumber(incomingOpeningBalance.goldFineWeight),
        silverFineWeight: toNumber(incomingOpeningBalance.silverFineWeight)
      };
    }

    const [voucherCount, settlementCount] = await Promise.all([
      Voucher.countDocuments({ userId: req.userId, ledgerId: req.params.id }),
      Settlement.countDocuments({ userId: req.userId, ledgerId: req.params.id })
    ]);
    const hasEntries = voucherCount > 0 || settlementCount > 0;

    // Regular and GST ledgers keep balances differently; switching after entries would scramble the balance
    if (hasEntries && updates.ledgerType && updates.ledgerType !== (existingLedger.ledgerType || 'regular')) {
      return res.status(400).json({
        success: false,
        message: 'This customer already has entries, so the ledger type cannot be changed. Create a new customer with the other type instead.'
      });
    }

    const ledger = await Ledger.findOneAndUpdate(
      { _id: req.params.id, userId: req.userId },
      updates,
      { new: true, runValidators: true }
    );

    if (!hasEntries) {
      const nextLedgerType = updates.ledgerType || existingLedger.ledgerType;
      const previousOpeningBalance = existingLedger.openingBalance || {};
      const nextOpeningBalance = updates.openingBalance || previousOpeningBalance;

      if (existingLedger.ledgerType !== 'gst' && nextLedgerType === 'gst') {
        await syncOpeningBalanceStock(req.userId, previousOpeningBalance, {});
        ledger.balances = resetBalances();
      } else if (existingLedger.ledgerType === 'gst' && nextLedgerType !== 'gst') {
        await syncOpeningBalanceStock(req.userId, {}, nextOpeningBalance);
        ledger.balances = {
          ...ledger.balances,
          goldFineWeight: toNumber(nextOpeningBalance.goldFineWeight),
          silverFineWeight: toNumber(nextOpeningBalance.silverFineWeight),
          cashBalance: toNumber(nextOpeningBalance.amount),
          creditBalance: 0,
          amount: toNumber(nextOpeningBalance.amount)
        };
      } else if (nextLedgerType !== 'gst' && updates.openingBalance !== undefined) {
        await syncOpeningBalanceStock(req.userId, previousOpeningBalance, nextOpeningBalance);
        ledger.balances = {
          ...ledger.balances,
          goldFineWeight: toNumber(nextOpeningBalance.goldFineWeight),
          silverFineWeight: toNumber(nextOpeningBalance.silverFineWeight),
          cashBalance: toNumber(nextOpeningBalance.amount),
          creditBalance: 0,
          amount: toNumber(nextOpeningBalance.amount)
        };
      }

      await ledger.save();
    } else if (ledger.ledgerType !== 'gst' && updates.openingBalance !== undefined) {
      // Entries exist: shift the current balance by exactly the change in opening balance,
      // so the balance always equals opening balance + entries.
      const prev = existingLedger.openingBalance || {};
      const next = updates.openingBalance;
      await syncOpeningBalanceStock(req.userId, prev, next);
      const b = ledger.balances;
      b.goldFineWeight = toNumber(b.goldFineWeight) + toNumber(next.goldFineWeight) - toNumber(prev.goldFineWeight);
      b.silverFineWeight = toNumber(b.silverFineWeight) + toNumber(next.silverFineWeight) - toNumber(prev.silverFineWeight);
      b.cashBalance = toNumber(b.cashBalance) + toNumber(next.amount) - toNumber(prev.amount);
      b.amount = calculateUnifiedAmount(b);
      await ledger.save();
    }
    return res.json({
      success: true,
      message: 'Ledger updated successfully',
      ledger
    });
  } catch (error) {
    console.error('Update ledger error:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error updating ledger'
    });
  }
});

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

    const [voucherCount, settlementCount] = await Promise.all([
      Voucher.countDocuments({ userId: req.userId, ledgerId: req.params.id }),
      Settlement.countDocuments({ userId: req.userId, ledgerId: req.params.id })
    ]);

    if (voucherCount > 0 || settlementCount > 0) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete ledger with transactions. Delete vouchers/settlements first.'
      });
    }

    if (ledger.ledgerType !== 'gst') {
      await syncOpeningBalanceStock(req.userId, ledger.openingBalance || {}, {});
    }

    await Ledger.findByIdAndDelete(req.params.id);

    return res.json({
      success: true,
      message: 'Ledger deleted successfully'
    });
  } catch (error) {
    console.error('Delete ledger error:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error deleting ledger'
    });
  }
});

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

    // Undo the stock these entries moved, so stock stays equal to what is physically in the shop
    const [vouchers, settlements] = await Promise.all([
      Voucher.find({ userId: req.userId, ledgerId: req.params.id, status: 'active', stockRestored: { $ne: true } })
        .select('paymentType voucherType stockAdjustment').lean(),
      Settlement.find({ userId: req.userId, ledgerId: req.params.id }).lean()
    ]);
    let gold = 0;
    let silver = 0;
    for (const v of vouchers) {
      // Purchases added stock when saved; sales and metal received are reversed the other way
      const sign = v.voucherType === 'purchase' && ['cash', 'credit'].includes(v.paymentType) ? -1 : 1;
      gold += sign * toNumber(v.stockAdjustment?.gold);
      silver += sign * toNumber(v.stockAdjustment?.silver);
    }
    for (const st of settlements) {
      const back = -settlementEffect(st).fineSign * toNumber(st.fineGiven);
      if (st.metalType === 'gold') gold += back; else silver += back;
    }
    // Deduct first: if stock is short this fails before anything is deleted
    await deductFromStock(req.userId, Math.max(0, -gold), Math.max(0, -silver));
    await addBackToStock(req.userId, Math.max(0, gold), Math.max(0, silver));

    await Promise.all([
      Voucher.deleteMany({ userId: req.userId, ledgerId: req.params.id }),
      Settlement.deleteMany({ userId: req.userId, ledgerId: req.params.id })
    ]);

    // With no entries left, the balance is exactly the opening balance
    const ob = ledger.openingBalance || {};
    ledger.balances = ledger.ledgerType === 'gst' ? resetBalances() : {
      ...resetBalances(),
      goldFineWeight: toNumber(ob.goldFineWeight),
      silverFineWeight: toNumber(ob.silverFineWeight),
      cashBalance: toNumber(ob.amount),
      amount: toNumber(ob.amount)
    };
    ledger.hasVouchers = false;
    await ledger.save();

    return res.json({
      success: true,
      message: 'All vouchers and settlements deleted successfully'
    });
  } catch (error) {
    console.error('Delete vouchers error:', error);
    return res.status(error.status || 500).json({
      success: false,
      message: error.status ? error.message : 'Server error deleting vouchers'
    });
  }
});

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

    const [vouchers, settlements] = await Promise.all([
      Voucher.find({
        ledgerId: req.params.id,
        userId: req.userId,
        status: 'active'
      }),
      Settlement.find({
        ledgerId: req.params.id,
        userId: req.userId
      })
    ]);

    // Fix vouchers with missing or zero total field
    let vouchersFixed = 0;
    for (const voucher of vouchers) {
      if (!voucher.total || voucher.total === 0) {
        // Calculate total from items
        const itemsTotal = (voucher.items || []).reduce((sum, item) => sum + toNumber(item.amount), 0);
        const stoneAmount = toNumber(voucher.stoneAmount);
        const fineAmount = toNumber(voucher.fineAmount);
        const gstTotal = toNumber(voucher.gstDetails?.totalGST);

        voucher.total = itemsTotal + stoneAmount + fineAmount + gstTotal;
        await voucher.save();
        vouchersFixed++;
      }
    }

    // If it's a GST ledger, keep balances at zero
    if (ledger.ledgerType === 'gst') {
      ledger.balances = resetBalances();
      ledger.hasVouchers = vouchers.length > 0;
      await ledger.save();
      return res.json({
        success: true,
        message: `Ledger is GST type, balances remains zero${vouchersFixed > 0 ? `. Fixed ${vouchersFixed} voucher(s) with missing totals.` : ''}`,
        ledger
      });
    }

    // Replay opening balance + every entry in the order it was saved, using the same rules as saving
    const ob = ledger.openingBalance || {};
    let balances = {
      ...resetBalances(),
      goldFineWeight: toNumber(ob.goldFineWeight),
      silverFineWeight: toNumber(ob.silverFineWeight),
      cashBalance: toNumber(ob.amount)
    };
    const entries = [
      ...vouchers.map((v) => ({ at: v.createdAt, apply: (bal) => applyVoucherToBalances(bal, v, ledger.ledgerType) })),
      ...settlements.map((st) => ({ at: st.createdAt, apply: (bal) => applySettlementToBalances(bal, st) }))
    ].sort((x, y) => new Date(x.at) - new Date(y.at));
    for (const entry of entries) balances = entry.apply(balances);

    ledger.balances = balances;
    ledger.hasVouchers = vouchers.length > 0;

    await ledger.save();

    return res.json({
      success: true,
      message: `Balance recalculated successfully${vouchersFixed > 0 ? `. Fixed ${vouchersFixed} voucher(s) with missing totals.` : ''}`,
      ledger
    });
  } catch (error) {
    console.error('Recalculate balance error:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error recalculating balance'
    });
  }
});

module.exports = router;
