const express = require('express');
const router = express.Router();
const Ledger = require('../models/Ledger');
const Voucher = require('../models/Voucher');
const Settlement = require('../models/Settlement');
const { auth, checkLicense } = require('../middleware/auth');

const sanitizePhone = (phone) => String(phone || '').replace(/\D/g, '');
const toNumber = (value) => Number(value || 0);

const calculateUnifiedAmount = (balances) => (
  toNumber(balances.creditBalance) + toNumber(balances.cashBalance)
);

const resetBalances = () => ({
  goldFineWeight: 0,
  silverFineWeight: 0,
  amount: 0,
  cashBalance: 0,
  creditBalance: 0
});

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
      ledgers
    });
  } catch (error) {
    console.error('Get ledgers error:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error fetching ledgers'
    });
  }
});

// Migration: Fix ledgers without ledgerType (development endpoint)
router.post('/migrate/fix-ledger-types', async (req, res) => {
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

    // If opening balance was updated and there are no transactions yet,
    // keep current balances aligned with the new opening values.
    if (updates.openingBalance !== undefined) {
      const [voucherCount, settlementCount] = await Promise.all([
        Voucher.countDocuments({ userId: req.userId, ledgerId: req.params.id }),
        Settlement.countDocuments({ userId: req.userId, ledgerId: req.params.id })
      ]);

      if (voucherCount === 0 && settlementCount === 0) {
        if (ledger.ledgerType === 'gst') {
          ledger.balances = resetBalances();
        } else {
          ledger.balances = {
            ...ledger.balances,
            goldFineWeight: toNumber(updates.openingBalance.goldFineWeight),
            silverFineWeight: toNumber(updates.openingBalance.silverFineWeight),
            cashBalance: toNumber(updates.openingBalance.amount),
            creditBalance: 0,
            amount: toNumber(updates.openingBalance.amount)
          };
        }
        await ledger.save();
      }
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

    await Promise.all([
      Voucher.deleteMany({ userId: req.userId, ledgerId: req.params.id }),
      Settlement.deleteMany({ userId: req.userId, ledgerId: req.params.id })
    ]);

    ledger.balances = resetBalances();
    ledger.hasVouchers = false;
    await ledger.save();

    return res.json({
      success: true,
      message: 'All vouchers and settlements deleted successfully'
    });
  } catch (error) {
    console.error('Delete vouchers error:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error deleting vouchers'
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

    // Start from opening balance instead of zero
    const ob = ledger.openingBalance || {};
    ledger.balances = {
      ...resetBalances(),
      goldFineWeight: toNumber(ob.goldFineWeight),
      silverFineWeight: toNumber(ob.silverFineWeight),
      cashBalance: toNumber(ob.amount)
    };

    vouchers.forEach((voucher) => {
      // Skip GST invoices as they don't affect regular balance
      if (voucher.invoiceType === 'gst') return;

      if (voucher.paymentType === 'credit') {
        voucher.items?.forEach((item) => {
          if (item.metalType === 'gold') {
            ledger.balances.goldFineWeight += toNumber(item.fineWeight);
          } else if (item.metalType === 'silver') {
            ledger.balances.silverFineWeight += toNumber(item.fineWeight);
          }
        });
        // Credit bills use cashBalance, not creditBalance
        ledger.balances.cashBalance += toNumber(voucher.total);
      } else if (voucher.paymentType === 'cash') {
        // Signed delta: negative means customer overpaid (credit with us).
        const balanceDelta = toNumber(voucher.total) - toNumber(voucher.cashReceived);
        ledger.balances.cashBalance += balanceDelta;
      } else if (voucher.paymentType === 'add_cash') {
        // Settlement: Add cash to balance
        const amountToAdd = toNumber(voucher.cashReceived);
        ledger.balances.cashBalance -= amountToAdd;
      } else if (voucher.paymentType === 'add_gold') {
        // Settlement: Customer gives gold to settle debt - reduces gold owed
        ledger.balances.goldFineWeight -= toNumber(voucher.cashReceived);
      } else if (voucher.paymentType === 'add_silver') {
        // Settlement: Customer gives silver to settle debt - reduces silver owed
        ledger.balances.silverFineWeight -= toNumber(voucher.cashReceived);
      } else if (voucher.paymentType === 'money_to_gold') {
        // Settlement: Customer pays cash to settle gold fine debt
        const amountPaid = toNumber(voucher.cashReceived);
        const goldRate = toNumber(voucher.goldRate) || 1;
        ledger.balances.goldFineWeight -= (amountPaid / goldRate);
      } else if (voucher.paymentType === 'money_to_silver') {
        // Settlement: Customer pays cash to settle silver fine debt
        const amountPaid = toNumber(voucher.cashReceived);
        const silverRate = toNumber(voucher.silverRate) || 1;
        ledger.balances.silverFineWeight -= (amountPaid / silverRate);
      }
    });

    settlements.forEach((settlement) => {
      const fine = toNumber(settlement.fineGiven);
      const amount = toNumber(settlement.amount);
      const direction = settlement.direction || 'payment';
      const multiplier = direction === 'receipt' ? 1 : -1;

      if (settlement.metalType === 'gold') {
        ledger.balances.goldFineWeight += multiplier * fine;
      } else if (settlement.metalType === 'silver') {
        ledger.balances.silverFineWeight += multiplier * fine;
      }

      ledger.balances.creditBalance += multiplier * amount;
    });

    ledger.balances.amount = calculateUnifiedAmount(ledger.balances);
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
