const test = require('node:test');
const assert = require('node:assert');
const { applyVoucherToBalances, reverseVoucherOnBalances } = require('../utils/voucherBalance');

const zero = { goldFineWeight: 0, silverFineWeight: 0, cashBalance: 0, creditBalance: 0 };

// Save a voucher the way the route does: remember the balances just before it.
const save = (balances, v) => {
  const voucher = { ...v, previousLedgerState: balances };
  return { voucher, balances: applyVoucherToBalances(balances, voucher, 'regular') };
};

test('cancelling an earlier voucher keeps later vouchers (the old bug)', () => {
  const a = save(zero, { paymentType: 'credit', total: 1000, items: [{ metalType: 'gold', fineWeight: 2 }] });
  const b = save(a.balances, { paymentType: 'credit', total: 500, items: [{ metalType: 'gold', fineWeight: 1 }] });
  assert.strictEqual(b.balances.cashBalance, 1500);

  const afterCancelA = reverseVoucherOnBalances(b.balances, a.voucher, 'regular');
  assert.strictEqual(afterCancelA.cashBalance, 500);       // B's ₹500 survives
  assert.strictEqual(afterCancelA.goldFineWeight, 1);      // B's 1g survives
  assert.strictEqual(afterCancelA.amount, 500);
});

test('every voucher type reverses back to where it started', () => {
  const start = { goldFineWeight: 5, silverFineWeight: 100, cashBalance: 2000, creditBalance: 0 };
  const vouchers = [
    { paymentType: 'credit', voucherType: 'sale', total: 700, items: [{ metalType: 'silver', fineWeight: 30 }] },
    { paymentType: 'credit', voucherType: 'purchase', total: 900, items: [{ metalType: 'gold', fineWeight: 1.5 }] },
    { paymentType: 'cash', voucherType: 'sale', total: 1200, cashReceived: 1000 },
    { paymentType: 'cash', voucherType: 'purchase', total: 800, cashReceived: 500 },
    { paymentType: 'add_cash', cashReceived: 300, total: 300 },
    { paymentType: 'add_gold', cashReceived: 0.75, total: 0.75 },
    { paymentType: 'add_silver', cashReceived: 12, total: 12 },
    { paymentType: 'money_to_gold', cashReceived: 7200, total: 7200, goldRate: 7200 },
    { paymentType: 'money_to_silver', cashReceived: 900, total: 900, silverRate: 90 },
  ];
  for (const v of vouchers) {
    const { voucher, balances } = save(start, v);
    const back = reverseVoucherOnBalances(balances, voucher, 'regular');
    assert.deepStrictEqual(back, applyVoucherToBalances(start, { paymentType: 'none' }, 'regular'), v.paymentType);
  }
});

test('purchase on credit moves balances the opposite way to a sale', () => {
  const sale = applyVoucherToBalances(zero, { paymentType: 'credit', total: 100, items: [{ metalType: 'gold', fineWeight: 1 }] }, 'regular');
  const buy = applyVoucherToBalances(zero, { paymentType: 'credit', voucherType: 'purchase', total: 100, items: [{ metalType: 'gold', fineWeight: 1 }] }, 'regular');
  assert.strictEqual(sale.cashBalance, 100);
  assert.strictEqual(buy.cashBalance, -100);
  assert.strictEqual(buy.goldFineWeight, -1);
});

test('GST invoices and GST ledgers do not change balances', () => {
  const v = { paymentType: 'credit', total: 100, items: [{ metalType: 'gold', fineWeight: 1 }] };
  assert.strictEqual(applyVoucherToBalances(zero, { ...v, invoiceType: 'gst' }, 'regular').cashBalance, 0);
  assert.strictEqual(applyVoucherToBalances(zero, v, 'gst').cashBalance, 0);
});

const { snapshotFromBalances, applySettlementToBalances, settlementEffect } = require('../utils/voucherBalance');

test('printed snapshot comes from real before/after balances (Kunal #173: 15g silver received)', () => {
  const before = { goldFineWeight: 0, silverFineWeight: 38.58, cashBalance: 1150, creditBalance: 0 };
  const after = applyVoucherToBalances(before, { paymentType: 'add_silver', cashReceived: 15 }, 'regular');
  const snap = snapshotFromBalances(before, after);
  assert.strictEqual(snap.oldBalance.silverFineWeight, 38.58);
  assert.strictEqual(snap.currentBalance.silverFineWeight, 23.58);
  assert.strictEqual(snap.currentBalance.amount, 1150);
});

test('settlements reverse exactly, including money conversions saved without the flag', () => {
  const start = { goldFineWeight: 4, silverFineWeight: 0, cashBalance: 0, creditBalance: 9000 };
  const legacyConversion = { metalType: 'gold', direction: 'payment', fineGiven: 1, amount: 6000, balanceBefore: 4, balanceAfter: { fineWeight: 5, amount: 3000 } };
  assert.deepStrictEqual(settlementEffect(legacyConversion), { fineSign: 1, amountSign: -1 });

  for (const s of [legacyConversion, { metalType: 'gold', direction: 'payment', fineGiven: 1, amount: 6000 }, { metalType: 'silver', direction: 'receipt', fineGiven: 10, amount: 900 }]) {
    const after = applySettlementToBalances(start, s);
    assert.deepStrictEqual(applySettlementToBalances(after, s, -1), applySettlementToBalances(start, {}, 0));
  }
});
