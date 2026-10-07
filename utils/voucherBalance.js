/**
 * How a voucher changes a customer's ledger balances.
 *
 * One pure function is used both when a voucher is saved and when it is
 * cancelled/edited, so a reversal removes exactly what that voucher added and
 * never touches the effect of vouchers entered after it.
 */
const { toNumber } = require('./helpers');

const BALANCE_KEYS = ['goldFineWeight', 'silverFineWeight', 'cashBalance', 'creditBalance'];

const round = (n, dp) => Math.round(n * 10 ** dp) / 10 ** dp;

const normalize = (b) => {
  const out = {
    goldFineWeight: round(toNumber(b?.goldFineWeight), 3),
    silverFineWeight: round(toNumber(b?.silverFineWeight), 3),
    cashBalance: round(toNumber(b?.cashBalance), 2),
    creditBalance: round(toNumber(b?.creditBalance), 2)
  };
  out.amount = round(out.cashBalance + out.creditBalance, 2);
  return out;
};

/**
 * @param balances   ledger balances before the voucher
 * @param v          { paymentType, voucherType, invoiceType, items, total, cashReceived, goldRate, silverRate }
 * @param ledgerType 'regular' | 'gst'
 * @returns          new balances (input is not mutated)
 */
const applyVoucherToBalances = (balances, v, ledgerType) => {
  const b = normalize(balances);
  if (v.invoiceType === 'gst' || ledgerType === 'gst') return b;

  const total = toNumber(v.total);
  const received = toNumber(v.cashReceived);
  const sign = v.voucherType === 'purchase' ? -1 : 1;

  switch (v.paymentType) {
    case 'credit':
      for (const item of v.items || []) {
        if (item.metalType === 'gold') b.goldFineWeight += sign * toNumber(item.fineWeight);
        if (item.metalType === 'silver') b.silverFineWeight += sign * toNumber(item.fineWeight);
      }
      b.cashBalance += sign * total;
      break;
    case 'cash':
      b.cashBalance += sign * (total - received);
      break;
    case 'add_cash':
      if (b.cashBalance !== 0 || b.creditBalance === 0) b.cashBalance -= received;
      else b.creditBalance -= received;
      break;
    case 'add_gold':
      b.goldFineWeight -= received;
      break;
    case 'add_silver':
      b.silverFineWeight -= received;
      break;
    case 'money_to_gold':
      b.goldFineWeight -= received / (toNumber(v.goldRate) || 1);
      break;
    case 'money_to_silver':
      b.silverFineWeight -= received / (toNumber(v.silverRate) || 1);
      break;
    default:
      break;
  }
  return normalize(b);
};

/**
 * Remove a voucher's effect from the ledger's current balances, using the
 * balances saved just before it (voucher.previousLedgerState).
 */
const reverseVoucherOnBalances = (current, voucher, ledgerType) => {
  const before = normalize(voucher.previousLedgerState);
  const after = applyVoucherToBalances(before, voucher, ledgerType);
  const now = normalize(current);
  for (const key of BALANCE_KEYS) now[key] -= after[key] - before[key];
  return normalize(now);
};

module.exports = { applyVoucherToBalances, reverseVoucherOnBalances, BALANCE_KEYS };
